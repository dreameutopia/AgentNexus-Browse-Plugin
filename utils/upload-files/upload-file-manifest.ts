/**
 * 上传文件清单（<upload_file> 信封）——模型视角的唯一上传文件视图
 *
 * 契约要点（与 file-util 工具严格同源）：
 *   - 信封**只列元信息**：工作区相对路径 + 文件大小。绝不内联任何文件内容，
 *     也不内联内容预览——文件正文一律由模型按需调用 file_util 读取；
 *   - 表格形式：一行一个文件，列恒为「路径 / 大小」，便于模型逐行引用；
 *   - 信封进入**模型上下文**（随用户消息），不进入用户可见气泡——
 *     用户看到的是自己的原始输入 + 附件元素，不含任何协议标记。
 *
 * 旧版信封（file_id + 第 1 页正文预览）已整体下线：会话文件库与工作区
 * inputs/ 曾构成两份上传文件副本，模型读到的正文与用户实际持有的文件
 * 可能不一致（一份是解析产物、一份是原始字节）。现在上传文件只有一份
 * 事实源——工作区 inputs/ 下的原始文件。
 */

/** 上传文件条目（会话记录内持久化的最小事实集） */
export interface UploadedFileEntry {
  /** 工作区相对路径（如 inputs/简历.pdf）——file_util 读取时的唯一寻址方式 */
  path: string;
  /** 原始文件名（含后缀） */
  name: string;
  /** 文件字节数 */
  sizeBytes: number;
  /** 小写后缀（无后缀为空串） */
  ext: string;
  /** 图片附件在多模态图片数组中的下标（仅图片；引擎据此回填 imageRef） */
  imageIndex?: number;
  /** 图片在图片库中的引用（引擎回填；UI 放大查看用） */
  imageRef?: string;
}

/** <upload_file> 标签名（提示词与信封共用的常量） */
export const UPLOAD_FILE_TAG = 'upload_file';

/**
 * 清单单元格转义（信封安全）。
 *
 * 工作区文件名允许包含 `|` `<` `>`（只禁控制符 / 斜杠 / 点段），因此：
 *   - `|` 会截断 Markdown 表格的单元格 → 转义为 `\|`；
 *   - `<` `>` 会破坏 <upload_file> 标签边界——一个名叫 `</upload_file>.txt`
 *     的文件能把剩余清单「顶出」信封、被模型当成正文外的游离文本
 *     （信封注入面），统一转义为 HTML 实体。
 */
function escapeManifestCell(value: string): string {
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\|/g, '\\|');
}

/**
 * 构建 <upload_file> 清单文本。
 *
 * 无上传文件时返回空串（调用方据此完全不注入信封）。
 */
export function buildUploadFileManifest(files: readonly UploadedFileEntry[]): string {
  const entries = files.filter(file => typeof file.path === 'string' && file.path.length > 0);
  if (entries.length === 0) return '';
  const rows = entries.map(
    file => `| ${escapeManifestCell(file.path)} | ${Math.max(0, Math.floor(file.sizeBytes || 0))} |`,
  );
  return [
    `<${UPLOAD_FILE_TAG}>`,
    '| 路径 | 大小（字节） |',
    '| --- | --- |',
    ...rows,
    `</${UPLOAD_FILE_TAG}>`,
  ].join('\n');
}
