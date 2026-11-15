/**
 * 上传文件类型判定（跨层共享的唯一事实源）
 *
 * 本模块回答两个问题：
 *   1. 某个路径是不是「文本文件」——file_util 的写操作（创建/追加/编辑/删除）
 *      只允许作用于文本文件，判定口径在此唯一实现；
 *   2. 某个路径是不是「图片」——上传侧据此决定是否走多模态压缩链路。
 *
 * 纯数据 + 纯函数，零 DOM 依赖：sidepanel 与 background service worker
 * 皆可引用（file_util 在 background 执行，附件编排在 sidepanel 执行）。
 *
 * 「文本文件」的口径刻意包含两类：
 *   - 已知文本后缀（.ts/.json/.md/…）；
 *   - 无后缀但语义为文本的固定名（Dockerfile/Makefile/LICENSE/.gitignore…）。
 *     这类文件在大量工程仓库里是主力（容器与构建入口），漏判会让
 *     file_util 无法读取或编辑它们——而它们恰恰最需要被 AI 查看与修改。
 */

/** 已知文本文件后缀（小写，不含点） */
export const TEXT_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  // 纯文本 / 笔记 / 日志
  'txt', 'text', 'log', 'nfo', 'rst', 'adoc', 'asciidoc', 'tex', 'bib', 'org', 'me', 'list', 'in',
  // 标记 / 数据 / 配置
  'md', 'markdown', 'mdx', 'csv', 'tsv', 'json', 'jsonl', 'ndjson', 'jsonc', 'json5', 'xml', 'yml', 'yaml',
  'toml', 'ini', 'cfg', 'conf', 'config', 'properties', 'env', 'lock', 'sum', 'mod', 'work', 'gitignore',
  'gitattributes', 'gitmodules', 'editorconfig', 'dockerignore', 'npmrc', 'yarnrc', 'nvmrc', 'babelrc',
  'eslintrc', 'prettierrc', 'npmignore', 'htaccess', 'htpasswd', 'patch', 'diff',
  // Web / 样式
  'html', 'htm', 'xhtml', 'svg', 'css', 'scss', 'sass', 'less', 'styl', 'pcss', 'postcss',
  // 编程语言
  'js', 'mjs', 'cjs', 'jsx', 'ts', 'mts', 'cts', 'tsx', 'py', 'pyw', 'pyi', 'ipynb', 'java', 'kt', 'kts',
  'c', 'h', 'cc', 'cpp', 'cxx', 'hpp', 'hh', 'hxx', 'cs', 'go', 'rs', 'rb', 'erb', 'php', 'phtml', 'swift',
  'm', 'mm', 'scala', 'sc', 'dart', 'vue', 'svelte', 'astro', 'ex', 'exs', 'erl', 'hrl', 'hs', 'lhs', 'ml',
  'mli', 'fs', 'fsx', 'fsscript', 'clj', 'cljs', 'cljc', 'edn', 'groovy', 'gradle', 'tf', 'tfvars', 'hcl',
  'nim', 'zig', 'cr', 'd', 'v', 'vhd', 'vhdl', 'pas', 'pp', 'lisp', 'scm', 'rkt', 'asm', 's', 'f90',
  'f95', 'cob', 'sql', 'ddl', 'psql', 'r', 'rmd', 'lua', 'pl', 'pm', 't', 'vim', 'el', 'vimrc', 'htaccess',
  'graphql', 'gql', 'proto', 'prisma', 'thrift', 'avsc', 'cue', 'sol',
  // 字幕 / 其他
  'srt', 'vtt', 'ass', 'ssa', 'sub', 'sbv', 'lrc', 'ics', 'vcf', 'po', 'pot', 'properties',
]);

/**
 * 无后缀但语义为文本的固定名（小写，含点号开头形式）。
 *
 * 这些名字没有可用的「后缀」可判定（Dockerfile 没有点），必须按名认定；
 * 它们在真实工程里极常见（容器构建、依赖清单、许可证、忽略规则），
 * 漏判等于让 AI 看不见也改不动这些文件。
 */
export const TEXT_FILE_BASENAMES: ReadonlySet<string> = new Set([
  // 构建 / 容器 / 依赖
  'dockerfile', 'containerfile', 'makefile', 'gnumakefile', 'justfile', 'rakefile', 'gemfile', 'brewfile',
  'procfile', 'vagrantfile', 'jenkinsfile', 'cmakelists.txt', 'meson.build', 'build', 'sconstruct', 'waf',
  'pipfile', 'poetry.lock', 'cargo.toml',
  // 许可 / 说明 / 变更
  'license', 'licence', 'copying', 'notice', 'readme', 'changelog', 'changes', 'authors', 'contributors',
  'codeowners', 'owners', 'todo', 'install', 'news', 'history', 'credits',
  // 版本控制 / 编辑器
  'gitignore', 'gitattributes', 'gitmodules', 'gitkeep', 'gitconfig', 'editorconfig', 'dockerignore',
  'npmrc', 'yarnrc', 'nvmrc', 'babelrc', 'eslintrc', 'prettierrc', 'npmignore', 'eslintignore',
  'prettierignore', 'flowconfig', 'browserslistrc', 'nunjucksrc', 'env', 'envrc',
  // 服务 / 杂项
  'hosts', 'resolv.conf', 'known_hosts', 'authorized_keys', 'motd', 'issue', 'todo',
]);

/** 图片后缀（小写，不含点）——上传侧据此走多模态压缩链路 */
export const IMAGE_FILE_EXTENSIONS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico',
]);

/** 路径的文件名主干（不含目录、不含后缀） */
export function fileBasename(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name;
}

/** 路径的后缀（小写、不含点；无后缀返回空串） */
export function fileExtension(path: string): string {
  const name = fileBasename(path).toLowerCase();
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return name.slice(dot + 1);
}

/**
 * 路径是否是文本文件（file_util 写操作的准入判定）。
 *
 * 判定顺序：
 *   1. 整个文件名命中固定名表（Dockerfile / meson.build / CMakeLists.txt …）——
 *      必须最先查：像 meson.build 这样带点号的固定名会走到后缀判定，
 *      只查「无后缀」会漏判；
 *   2. 有后缀 → 命中已知文本后缀即算文本文件；
 *   3. 点号开头的隐藏文件（.gitignore）→ 按「点后整段」与固定名表比对；
 *   4. 完全无后缀但不在固定名表 → 不算文本文件。
 *
 * 未知后缀（如 .bin/.dat）一律不算文本文件：file_util 的写操作会覆盖原字节，
 * 放行未知二进制会造成不可逆的数据损坏——宁可拒绝并给出可执行的替代路径。
 */
export function isTextFilePath(path: string): boolean {
  const name = fileBasename(path).toLowerCase();
  if (!name) return false;
  if (TEXT_FILE_BASENAMES.has(name)) return true;
  const dot = name.lastIndexOf('.');
  if (dot > 0) return TEXT_FILE_EXTENSIONS.has(name.slice(dot + 1));
  if (dot === 0) return TEXT_FILE_BASENAMES.has(name) || TEXT_FILE_EXTENSIONS.has(name.slice(1));
  return false;
}

/** 路径是否是图片（按后缀判定；MIME 兜底由调用方处理） */
export function isImageFilePath(path: string): boolean {
  const ext = fileExtension(path);
  return ext !== '' && IMAGE_FILE_EXTENSIONS.has(ext);
}

/**
 * 人类可读的文件类型标签（用于 UI 展示与错误文案）。
 *
 * 返回值是稳定的英文类型名（错误信息里作为可检索的关键词），
 * 中文描述由 i18n 层负责，不在此处拼装。
 */
export function fileKindLabel(path: string): 'text' | 'image' | 'office' | 'binary' {
  const ext = fileExtension(path);
  if (ext === '') return isTextFilePath(path) ? 'text' : 'binary';
  if (IMAGE_FILE_EXTENSIONS.has(ext)) return 'image';
  if (ext === 'xlsx' || ext === 'docx' || ext === 'pptx') return 'office';
  if (TEXT_FILE_EXTENSIONS.has(ext)) return 'text';
  return 'binary';
}
