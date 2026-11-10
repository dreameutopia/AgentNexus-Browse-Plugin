/**
 * 技能导入 / 导出（zip 格式，兼容 Agent Skills 开放规范的目录结构）
 *
 * 兼容的主流格式（无需调用方区分，解析器自动识别）：
 *   A. 根级 SKILL.md：Anthropic 官方「Download skill」zip 常见形态
 *      （SKILL.md + scripts/ + references/ 直接位于压缩包根）；
 *   B. 单技能目录：<任意层级>/<skill-name>/SKILL.md（GitHub 仓库下载的单技能包）；
 *   C. 多技能目录：一个 zip 内含多个技能目录（如 anthropics/skills 整仓打包，
 *      每个技能一个顶层目录）。
 *
 * 导出：单技能 → `<name>.zip`，内部为 `<name>/SKILL.md` + 资源文件（规范形态，
 * 可直接被上述解析器及其它遵循规范的平台再次导入）。
 *
 * 安全与防御：
 *   - zip-slip 防御：拒绝绝对路径与含 `..` 段的条目；
 *   - 解压前限制包大小、展开体积与条目数，二进制资源按原始字节保留。
 */

import { zipSync, strToU8 } from 'fflate';
import { readBoundedZip } from '@/utils/shared/bounded-zip';
import {
  SKILL_IMPORT_MAX_FILES,
  SKILL_IMPORT_MAX_FILE_CHARS,
  SKILL_IMPORT_MAX_TOTAL_CHARS,
  SKILL_IMPORT_MAX_SKILLS,
  SKILL_IMPORT_MAX_PACKAGE_BYTES,
  SKILL_RESOURCE_MAX_FILE_BYTES,
  SKILL_RESOURCE_MAX_TOTAL_BYTES,
  SKILL_NAME_MAX_CHARS,
  type SkillRecord,
} from './skill-types';
import { parseFrontmatter, normalizeSkillName } from './frontmatter-parser';
import { setCustomSkill } from './skill-store';
import { decodeSkillBytes, decodeSkillText, encodeSkillBytes, isSkillResourcePath } from './skill-resources';

// ──── 解析 ────

/** 单个待导入技能（已通过结构校验，未做名称查重） */
export interface SkillImportCandidate {
  /** 规范化后的技能名（frontmatter 优先，回落目录名） */
  name: string;
  /** 相对路径 → 文本（键含 'SKILL.md'） */
  files: Record<string, string>;
  resourceBytes?: Record<string, string>;
  folders?: string[];
  /** 全部文件的 UTF-8 字节总量（解析器产出；手工构造的候选缺省视为 0，不做预警） */
  bytes?: number;
}

/** 跳过项（source 供错误文案回显） */
export interface SkillImportSkip {
  source: string;
  reason:
    | 'no-skill-md'      // 包内没有 SKILL.md
    | 'invalid-name'     // 名称规范化后为空/非法
    | 'missing-description'
    | 'empty-body'       // SKILL.md 只有 frontmatter，没有可执行指令正文
    | 'too-many-files'
    | 'file-too-large'
    | 'total-too-large'
    | 'skill-limit'
    | 'oversize'         // 超过导入预警阈值且用户在确认弹窗中选择不导入
    | 'store-reject';    // 存储层拒绝（结构不完整等）
}

/** 计算一组文件的 UTF-8 字节总量（导入预警与反馈文案的口径；非字符串项跳过） */
export function sumSkillFilesBytes(files: Record<string, string>): number {
  let total = 0;
  for (const content of Object.values(files ?? {})) {
    if (typeof content !== 'string') continue;
    total += sharedTextEncoder().encode(content).length;
  }
  return total;
}

/** 共享 TextEncoder 实例（多技能大包导入时避免逐文件重建编码器；环境无此 API 时按字符数近似） */
const sharedTextEncoder = (() => {
  let instance: TextEncoder | null = null;
  return (): { encode(text: string): { length: number } } => {
    if (instance) return instance;
    if (typeof TextEncoder !== 'undefined') {
      instance = new TextEncoder();
      return instance;
    }
    // 无 TextEncoder 环境（测试垫片 / 极老运行时）：1 字符 ≈ 1 字节的保守近似，
    // 仅影响预警文案的展示精度，不影响任何硬性判定
    return { encode: (text: string) => ({ length: text.length }) };
  };
})();

export interface SkillImportReport {
  /** 成功写入的技能（同名照常入库：同名合法，id 由存储层随机生成，绝不覆盖既有技能） */
  imported: Array<{ name: string; id: string }>;
  skipped: SkillImportSkip[];
  /** 被丢弃的超限文件（不阻断技能导入，仅提示） */
  droppedFiles: Array<{ path: string; reason: 'file-too-large' }>;
}

/** Normalize legacy separators and leading './' without changing literal filenames. */
function sanitizeEntryPath(path: string): string | null {
  let cleaned = path.replace(/\\/g, '/').replace(/^\.\/+/, '');
  if (!cleaned || cleaned.startsWith('/')) return null;
  const segments: string[] = [];
  for (const segment of cleaned.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') return null;
    segments.push(segment);
  }
  cleaned = segments.join('/');
  return isSkillResourcePath(cleaned) ? cleaned : null;
}

/** 忽略版本控制和 macOS 元数据，保留实际技能资源（包括点文件和嵌套归档）。 */
function isNoiseEntry(path: string): boolean {
  if (path.endsWith('/')) return true;
  const segments = path.split('/');
  if (segments.some(segment => segment === '__MACOSX' || segment.startsWith('.DS_Store'))) return true;
  if (segments.includes('.git')) return true;
  return false;
}

/** 条目基名是否为 SKILL.md（大小写宽容，规范为全大写） */
function isSkillMdPath(path: string): boolean {
  const base = path.split('/').pop() ?? '';
  return base.toLowerCase() === 'skill.md';
}

/**
 * 从 ZIP 条目中提取技能候选列表。
 *
 * 分组规则：
 *   - 每个 SKILL.md 的所在目录是一个「技能根候选」；
 *   - 防御嵌套：若某 SKILL.md 的目录是另一个更浅技能根的子目录
 *     （如 references/SKILL.md），它降级为父技能的普通文件而非新技能；
 *   - 其余条目按最长前缀归属技能根；根级 SKILL.md（'' 根）兜底接收
 *     不属于任何目录根的根级文件；不匹配任何技能根的文件忽略
 *     （如多技能包根部的 README / LICENSE）。
 *
 */
type ZipResource = { path: string; bytes: Uint8Array; content?: string };

function zipParent(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash < 0 ? '' : path.slice(0, slash);
}

function findRoot(path: string, roots: ReadonlySet<string>): string | undefined {
  for (let parent = zipParent(path); ; parent = zipParent(parent)) {
    if (roots.has(parent)) return parent;
    if (!parent) return undefined;
  }
}

function groupCandidates(entries: ZipResource[], directories: Set<string>, fallbackTopName: string): {
  candidates: SkillImportCandidate[];
  skipped: SkillImportSkip[];
} {
  const skipped: SkillImportSkip[] = [];

  // 第一遍：收集全部 SKILL.md 条目（路径 → 目录）
  const skillMdEntries = entries.filter(entry => isSkillMdPath(entry.path));
  const skillMdDirs = new Set(skillMdEntries.map(entry => zipParent(entry.path)));

  // 技能根集合：未被更浅技能根吸收的 SKILL.md 目录（含根级 ''）。
  // 吸收判定：根级（''）视为吸收一切子目录——根级 SKILL.md 存在时整个包即
  // 一个技能（Anthropic 根级形态），references/SKILL.md 等嵌套入口降级为普通
  // 文件；非根目录间按路径前缀判定（a/b 被 a 吸收）。
  const rootDirs = new Set([...skillMdDirs].filter(dir => !dir || findRoot(dir, skillMdDirs) === undefined));

  if (!rootDirs.size) {
    skipped.push({ source: fallbackTopName, reason: 'no-skill-md' });
    return { candidates: [], skipped };
  }

  const roots = new Map([...rootDirs].map(dir => [dir, { files: new Map<string, ZipResource>(), directories: [] as string[] }]));
  for (const path of directories) {
    if (rootDirs.has(path)) continue;
    const owner = findRoot(path, rootDirs);
    if (owner !== undefined) roots.get(owner)!.directories.push(owner ? path.slice(owner.length + 1) : path);
  }
  for (const entry of entries) {
    if (rootDirs.has(entry.path)) throw new Error('File shadows a skill directory: ' + entry.path);
    const owner = findRoot(entry.path, rootDirs);
    if (owner === undefined) continue;
    const { files } = roots.get(owner)!;
    const relative = owner === '' ? entry.path : entry.path.slice(owner.length + 1);
    if (!relative) continue;
    // 本根入口 SKILL.md（任意大小写变体、无目录层级）→ 统一规范键名，首个生效；
    // 被吸收的嵌套 skill.md（含目录层级）按普通文件保留原始相对路径
    if (isSkillMdPath(entry.path) && !relative.includes('/')) {
      if (files.has('SKILL.md')) throw new Error('Duplicate SKILL.md in one skill directory');
      files.set('SKILL.md', entry);
      continue;
    }
    files.set(relative, entry);
  }

  // 每个技能根 → 候选（frontmatter 名称优先，回落目录名 / 传入名）
  const candidates: SkillImportCandidate[] = [];
  for (const [dir, { files, directories }] of roots) {
    const derived = new Set<string>();
    for (const path of files.keys()) {
      for (let slash = path.lastIndexOf('/'); slash >= 0; slash = path.lastIndexOf('/', slash - 1)) {
        const parent = path.slice(0, slash);
        if (files.has(parent)) throw new Error('Conflicting file and directory in skill ZIP: ' + path);
        derived.add(parent);
      }
    }
    const folders = directories.filter(path => !derived.has(path));
    for (const folder of folders) {
      if (files.has(folder) || folder.split('/').some((_, index, parts) => files.has(parts.slice(0, index).join('/')))) {
        throw new Error('Conflicting file and directory in skill ZIP: ' + folder);
      }
    }
    const skillMd = files.get('SKILL.md')?.content;
    if (skillMd === undefined) {
      skipped.push({ source: dir || fallbackTopName, reason: 'no-skill-md' });
      continue;
    }
    if (candidates.length >= SKILL_IMPORT_MAX_SKILLS) {
      skipped.push({ source: dir || fallbackTopName, reason: 'skill-limit' });
      continue;
    }
    if (files.size + folders.length > SKILL_IMPORT_MAX_FILES) {
      skipped.push({ source: dir || fallbackTopName, reason: 'too-many-files' });
      continue;
    }
    const { data, body } = parseFrontmatter(skillMd.replace(/^\uFEFF/, ''));
    const folderName = dir.split('/').pop() ?? '';
    const rawName = (data['name'] || folderName || fallbackTopName).trim();
    const name = normalizeSkillName(rawName);
    if (!name || name.length > SKILL_NAME_MAX_CHARS) {
      skipped.push({ source: dir || fallbackTopName, reason: 'invalid-name' });
      continue;
    }
    if (!(data['description'] || '').trim()) {
      skipped.push({ source: name, reason: 'missing-description' });
      continue;
    }
    // 正文不可为空：只有 frontmatter 的 SKILL.md 没有任何可执行指令，
    // 入库只会产出激活时注入空段的「僵尸技能」（与 UI 两侧编辑器的校验一致）
    if (!body.trim()) {
      skipped.push({ source: name, reason: 'empty-body' });
      continue;
    }
    // 总量校验（超限时整技能跳过，不做截断——半套资源比没有更糟）
    let total = 0;
    let textBytes = 0;
    for (const resource of files.values()) {
      total += resource.bytes.length;
      if (resource.content !== undefined) textBytes += resource.bytes.length;
    }
    if (textBytes > SKILL_IMPORT_MAX_TOTAL_CHARS || total > SKILL_RESOURCE_MAX_TOTAL_BYTES) {
      skipped.push({ source: name, reason: 'total-too-large' });
      continue;
    }
    const textEntries: Array<[string, string]> = [];
    const binaryEntries: Array<[string, string]> = [];
    for (const [path, resource] of files) {
      if (resource.content === undefined) binaryEntries.push([path, encodeSkillBytes(resource.bytes)]);
      else textEntries.push([path, resource.content]);
    }
    candidates.push({
      name, files: Object.fromEntries(textEntries), bytes: total,
      ...(binaryEntries.length ? { resourceBytes: Object.fromEntries(binaryEntries) } : {}),
      ...(folders.length ? { folders } : {}),
    });
  }

  return { candidates, skipped };
}

/**
 * 解析技能 zip 字节流 → 候选列表 + 逐条跳过原因。
 * 解码失败（非法 zip / 内存耗尽）抛错，由调用方转为用户可读错误。
 */
export function parseSkillZipBytes(bytes: Uint8Array, fallbackTopName = 'imported-skill'): {
  candidates: SkillImportCandidate[];
  skipped: SkillImportSkip[];
  droppedFiles: SkillImportReport['droppedFiles'];
} {
  const entries: ZipResource[] = [];
  const droppedFiles: SkillImportReport['droppedFiles'] = [];
  const paths = new Set<string>();
  const directories = new Set<string>();
  const normalized = new Map<string, string>();
  const unzipped = readBoundedZip(bytes, {
    archive: SKILL_IMPORT_MAX_PACKAGE_BYTES,
    expanded: SKILL_IMPORT_MAX_PACKAGE_BYTES,
    files: SKILL_IMPORT_MAX_SKILLS * SKILL_IMPORT_MAX_FILES * 2,
    allowEmpty: true,
    accept(rawPath, size) {
      const directory = /[\\/]$/.test(rawPath);
      const path = sanitizeEntryPath(rawPath);
      if (!path || isNoiseEntry(path)) return false;
      if (paths.has(path)) throw new Error('Duplicate ZIP resource: ' + path);
      paths.add(path);
      if (directory) {
        if (size !== 0) throw new Error('Invalid ZIP directory: ' + path);
        directories.add(path);
        return false;
      }
      if (size > SKILL_RESOURCE_MAX_FILE_BYTES) {
        droppedFiles.push({ path, reason: 'file-too-large' });
        return false;
      }
      normalized.set(rawPath, path);
      return true;
    },
  });
  for (const [rawPath, data] of unzipped) {
    const path = normalized.get(rawPath)!;
    const content = decodeSkillText(data);
    if (content !== undefined && content.length > SKILL_IMPORT_MAX_FILE_CHARS) {
      droppedFiles.push({ path, reason: 'file-too-large' });
      continue;
    }
    entries.push({ path, bytes: data, content });
  }

  const grouped = groupCandidates(entries, directories, fallbackTopName);
  return {
    candidates: grouped.candidates,
    skipped: grouped.skipped,
    droppedFiles,
  };
}

/** 解析单个 SKILL.md 文本（.md 直导）：无 frontmatter 时按 fallbackName 组装 */
export function parseSkillMdText(text: string, fallbackName: string): {
  candidate: SkillImportCandidate | null;
  skip?: SkillImportSkip;
} {
  // 输入防御：非字符串（调用方编程错误 / 测试桩）按「没有可导入的文件」降级；
  // 超限与 zip 路径同一口径：整文件直导没有「丢弃部分文件」可言，整体跳过
  if (typeof text !== 'string') {
    return { candidate: null, skip: { source: fallbackName, reason: 'no-skill-md' } };
  }
  if (text.length > SKILL_IMPORT_MAX_FILE_CHARS) {
    return { candidate: null, skip: { source: fallbackName, reason: 'file-too-large' } };
  }
  const { data, body } = parseFrontmatter(text);
  const name = normalizeSkillName((data['name'] || fallbackName).trim());
  if (!name || name.length > SKILL_NAME_MAX_CHARS) {
    return { candidate: null, skip: { source: fallbackName, reason: 'invalid-name' } };
  }
  if (!(data['description'] || '').trim()) {
    return { candidate: null, skip: { source: name, reason: 'missing-description' } };
  }
  if (!body.trim()) {
    return { candidate: null, skip: { source: name, reason: 'empty-body' } };
  }
  const files = { 'SKILL.md': text };
  return { candidate: { name, files, bytes: sumSkillFilesBytes(files) } };
}

/**
 * 把候选列表批量写入存储。
 *
 * 不做名称去重 / 重命名：同名技能是常态，落库名与原名恒等，冲突只可能发生在
 * id 层——由存储层在非保留区间内随机取号 + 写前占用确认解决，既有技能
 * （含预置同名）永远不会被覆盖或改名。
 *
 * 注意：本函数只写内存表并排队持久化；写入方（导入 UI）在调用后必须
 * await flushSkillStoreWrites() 确认落盘，失败时用 snapshotCustomSkills /
 * rollbackCustomSkills 回滚，保证「列表所见 = 持久层所存」。
 */
export function commitImportCandidates(candidates: readonly SkillImportCandidate[]): SkillImportReport {
  const report: SkillImportReport = { imported: [], skipped: [], droppedFiles: [] };
  for (const candidate of candidates) {
    const result = setCustomSkill({
      name: candidate.name, files: candidate.files, resourceBytes: candidate.resourceBytes, folders: candidate.folders,
    });
    if (!result.ok) {
      report.skipped.push({ source: candidate.name, reason: 'store-reject' });
      continue;
    }
    report.imported.push({
      name: result.skill.name,
      id: result.skill.id,
    });
  }
  return report;
}

// ──── 导入入口 ────

/** 导入单个 SKILL.md 文本 */
export function importSkillFromMdText(text: string, fallbackName: string): SkillImportReport {
  const { candidate, skip } = parseSkillMdText(text, fallbackName);
  if (!candidate) {
    return { imported: [], skipped: skip ? [skip] : [], droppedFiles: [] };
  }
  return commitImportCandidates([candidate]);
}

// ──── 导出 ────

/** 导出结果（调用方负责触发下载） */
export interface SkillExportPayload {
  /** 下载文件名：`<技能名>.zip` */
  filename: string;
  /** zip 字节流 */
  bytes: Uint8Array;
}

/**
 * 把单个技能序列化为规范形态 zip：
 * `<name>/SKILL.md` + `<name>/<资源文件>`（可被本解析器与遵循规范的平台再次导入）。
 *
 * 显式目录使用 ZIP 目录条目保存。
 */
export function exportSkillToZip(skill: SkillRecord): SkillExportPayload {
  const zipEntries: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(skill.files)) {
    // 防御：写出路径做同样的清洗（存储层理论不会塞入非法键）
    const safePath = sanitizeEntryPath(`${skill.name}/${path}`);
    if (!safePath) continue;
    zipEntries[safePath] = strToU8(content);
  }
  for (const [path, content] of Object.entries(skill.resourceBytes ?? {})) {
    if (!isSkillResourcePath(path) || Object.hasOwn(skill.files, path)) throw new Error('Invalid binary resource: ' + path);
    zipEntries[skill.name + '/' + path] = decodeSkillBytes(content);
  }
  for (const path of skill.folders ?? []) {
    if (isSkillResourcePath(path)) zipEntries[skill.name + '/' + path + '/'] = new Uint8Array();
  }
  // 存储数据异常（无 SKILL.md）时兜底写入口文件，保证导出物永远可再导入
  if (!zipEntries[`${skill.name}/SKILL.md`]) {
    const tagLine = skill.tags.length > 0 ? `tags: ${skill.tags.join(' ')}\n` : '';
    zipEntries[`${skill.name}/SKILL.md`] = strToU8(
      `---\nname: ${skill.name}\ndescription: ${skill.description}\ncategory: ${skill.category}\n${tagLine}---\n\n${skill.body}`,
    );
  }
  return { filename: `${skill.name}.zip`, bytes: zipSync(zipEntries) };
}

/** 触发浏览器下载（hub / sidepanel 页面环境） */
export function downloadSkillZip(skill: SkillRecord): boolean {
  try {
    const { filename, bytes } = exportSkillToZip(skill);
    const blob = new Blob([bytes as BlobPart], { type: 'application/zip' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    // 释放 object URL：延迟到下一轮事件循环，避免个别浏览器下载尚未开始即回收
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
    return true;
  } catch (error) {
    console.warn(`[SkillImportExport] 导出技能 "${skill.name}" 失败:`, error);
    return false;
  }
}
