/**
 * SKILL.md frontmatter 解析器
 *
 * 只解析规范中实际用到的「单行标量」字段（name / description / allowed-tools /
 * compatibility / license / category / tags），不引入 YAML 依赖。
 * 嵌套结构（如 metadata: 下的缩进行）不支持，安全忽略。
 *
 * category / tags 是本项目在开放规范之上的扩展字段：与智能体共用同一套
 * 分类注册表与标签归一化（utils/agents/agent-types），见 parseSkillTags。
 */

import { SKILL_NAME_MAX_CHARS, normalizeAllowedToolList } from './skill-types';
import { normalizeTags } from '../agents/agent-types';

export interface ParsedFrontmatter {
  /** 解析出的顶层标量字段（键均为小写原样） */
  data: Record<string, string>;
  /** frontmatter 之后的 Markdown 正文（未 trim，保留原样） */
  body: string;
}

/**
 * 解析 SKILL.md 文本。
 * 无 frontmatter（不以 --- 开头）或 frontmatter 未闭合时，整体视为正文。
 */
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  const normalized = raw.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');

  if (lines[0]?.trim() !== '---') {
    return { data: {}, body: raw };
  }

  const data: Record<string, string> = {};
  let endIndex = -1;

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '---' || line.trim() === '...') {
      endIndex = i;
      break;
    }
    // 缩进行属于嵌套结构（如 metadata:），忽略
    if (/^\s/.test(line) || !line.trim()) continue;
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    let value = line.slice(colon + 1).trim();
    // 去掉成对的单/双引号与行内注释（# 前需有空格才视为注释，避免误伤 URL 锚点）。
    // 双引号值支持最小反转义（\" → "，\\ → \），与保存端 composeSkillMd 的包裹规则往返一致
    if (/^".*$/.test(value)) {
      value = value.slice(1, -1).replace(/\\(["\\])/g, '$1');
    } else if (/^'.*$/.test(value)) {
      value = value.slice(1, -1);
    } else {
      const commentMatch = value.match(/\s#/);
      if (commentMatch && commentMatch.index !== undefined) {
        value = value.slice(0, commentMatch.index).trim();
      }
    }
    if (key) data[key] = value;
  }

  if (endIndex === -1) {
    // frontmatter 未闭合：整体当正文，避免误吞内容
    return { data: {}, body: raw };
  }

  return { data, body: lines.slice(endIndex + 1).join('\n') };
}

/**
 * 规范化技能名：转小写、空白/下划线转连字符、去非法字符、折叠连续连字符、去首尾连字符。
 * 用于把用户的任意输入收敛为合法的 skill name，而不是直接拒绝。
 */
export function normalizeSkillName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * 解析 frontmatter `allowed-tools` 字段（空白分隔的工具 ID 列表）。
 * 缺省或空时返回空数组；切分后经 normalizeAllowedToolList 统一收敛
 * （去空白 + 去重保序，与写入覆盖 / 反序列化共用同一条不变量管道）；
 * 不过滤未知 ID（未注册的 ID 由 runtime 装配的 finalizeToolIds 统一
 * 告警剔除，不在此处硬性限制）。
 */
export function parseAllowedTools(value: string | undefined): string[] {
  if (!value) return [];
  return normalizeAllowedToolList(value.split(/\s+/));
}

/**
 * 解析 frontmatter `tags` 字段（空格 / 逗号分隔的标签列表）。
 * 缺省或空时返回空数组；切分后经 normalizeTags 统一收敛——与智能体标签
 * 同一条不变量管道（单项长度钳制 + 去重保序 + 数量上限）。
 * 编辑表单提交的标签恒无空白，因此单标签内不会出现空格，分隔不会误切。
 */
export function parseSkillTags(value: string | undefined): string[] {
  if (!value) return [];
  return normalizeTags(value.split(/[,，\s]+/));
}

// ──── SKILL.md 结构化校验（高级模式提交前检查） ────

/** 单条校验问题（可读文案由调用方经 i18n 组装，此处给稳定的机器码 + 定位信息） */
export interface SkillMdIssue {
  /** 问题码（稳定，供 i18n 映射） */
  code:
    | 'missing-frontmatter'
    | 'unclosed-frontmatter'
    | 'missing-name'
    | 'invalid-name'
    | 'name-too-long'
    | 'missing-description'
    | 'missing-category'
    | 'empty-body';
  /** 与问题关联的原始值片段（如非法名称本身），供错误文案回显 */
  detail?: string;
}

export interface SkillMdValidation {
  /** 是否可入库（无任何问题） */
  ok: boolean;
  issues: SkillMdIssue[];
  /** 解析出的字段（解析失败的字段为空） */
  data: Record<string, string>;
  body: string;
}

/**
 * 校验一段完整 SKILL.md 文本是否满足入库不变量：
 *   1. 存在闭合的 frontmatter 块（以 --- 开始并以 ---/... 结束）；
 *   2. name 缺失 → 由调用方回落目录名/表单名，此处仅在显式存在但非法时报错；
 *      名称规范化后仍不合法 → invalid-name；
 *   3. description 必须非空；
 *   4. category 必须非空（分类必选，与智能体同一分类规范；导入等无编辑器
 *      的入口不受此约束，缺省由存储层归入通用分类）；
 *   5. 正文（frontmatter 之后）非空。
 * 只做「结构判定」，不做名称唯一性等需要存储态的检查（那是 store 层职责）。
 */
export function validateSkillMd(raw: string, opts: { fallbackName?: string } = {}): SkillMdValidation {
  const issues: SkillMdIssue[] = [];
  const normalized = raw.replace(/\r\n/g, '\n');

  const startsWithFm = normalized.split('\n')[0]?.trim() === '---';
  if (!startsWithFm) {
    return {
      ok: false,
      issues: [{ code: 'missing-frontmatter' }],
      data: {},
      body: raw,
    };
  }

  const { data, body } = parseFrontmatter(raw);
  // parseFrontmatter 对未闭合 frontmatter 返回原始全文当正文（data 为空），
  // 用这一特征区分「未闭合」与「字段缺失」
  if (Object.keys(data).length === 0 && !('name' in data)) {
    const lines = normalized.split('\n');
    const closed = lines.slice(1).some(line => line.trim() === '---' || line.trim() === '...');
    if (!closed) {
      return {
        ok: false,
        issues: [{ code: 'unclosed-frontmatter' }],
        data: {},
        body: raw,
      };
    }
  }

  // name：显式存在才校验；缺失时允许调用方回落（与 buildSkillRecord 行为一致）
  const rawName = data['name'];
  if (rawName !== undefined) {
    const normalizedCandidate = normalizeSkillName(rawName);
    if (!normalizedCandidate || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(normalizedCandidate)) {
      issues.push({ code: 'invalid-name', detail: rawName });
    } else if (normalizedCandidate.length > SKILL_NAME_MAX_CHARS) {
      issues.push({ code: 'name-too-long', detail: `${normalizedCandidate.length}` });
    }
  } else if (!opts.fallbackName) {
    issues.push({ code: 'missing-name' });
  }

  if (!(data['description'] || '').trim()) {
    issues.push({ code: 'missing-description' });
  }

  if (!(data['category'] || '').trim()) {
    issues.push({ code: 'missing-category' });
  }

  if (!body.trim()) {
    issues.push({ code: 'empty-body' });
  }

  return { ok: issues.length === 0, issues, data, body };
}

