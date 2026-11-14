/**
 * 插件操作日志（领域模型）
 *
 * 目标：导入、更新、启用、禁用、卸载、回滚、备份恢复与启动对账的每一次结果
 * 都可被追溯；失败必须带稳定错误码、阶段和原始 detail，而不是只存在于一次性
 * 提示条里。模型与存储、UI 解耦：本文件不依赖 IndexedDB 或 Vue。
 */
import { ZodError } from 'zod';
import { PluginError } from './contracts';

/** 保留最近多少条记录（超出后按时间删除最旧记录） */
export const OPERATION_LOG_LIMIT = 1000;

export type PluginOperationAction =
  | 'preview'
  | 'install'
  | 'update'
  | 'enable'
  | 'disable'
  | 'uninstall'
  | 'rollback'
  | 'backup-restore'
  | 'backup-rollback'
  | 'update-check'
  | 'startup';

export type PluginOperationStatus = 'success' | 'failure';

/** 失败发生在哪个阶段：定位问题时不需要再从错误码反推 */
export type PluginOperationStage =
  | 'request'
  | 'download'
  | 'unpack'
  | 'layout'
  | 'signature'
  | 'manifest'
  | 'compat'
  | 'schema'
  | 'reference'
  | 'dependency'
  | 'commit'
  | 'apply'
  | 'runtime';

export type PluginOperationSource =
  | 'file'
  | 'github'
  | 'rollback'
  | 'backup'
  | 'startup'
  | 'auto';

export interface PluginOperationRecord {
  id: string;
  /** 毫秒时间戳 */
  at: number;
  action: PluginOperationAction;
  status: PluginOperationStatus;
  stage?: PluginOperationStage;
  pluginKey?: string;
  pluginName?: string;
  fromVersion?: string;
  toVersion?: string;
  source?: PluginOperationSource;
  digest?: string;
  generationBefore?: number;
  generationAfter?: number;
  durationMs: number;
  errorCode?: string;
  errorDetail?: string;
  /** 成功操作的附加说明（例如更新检查发现的版本） */
  note?: string;
}

export interface PluginOperationQuery {
  pluginKey?: string;
  action?: PluginOperationAction;
  status?: PluginOperationStatus;
  /** 1–200，默认 100 */
  limit?: number;
}

const STAGE_BY_CODE: Readonly<Record<string, PluginOperationStage>> = {
  // 请求 / 权限
  INVALID_PAYLOAD: 'request',
  UNKNOWN_PLUGIN_OPERATION: 'request',
  MANAGEMENT_ONLY: 'request',
  PLUGIN_SENDER_REJECTED: 'request',
  ARCHIVE_LIMIT: 'download',
  // 下载 / 输入
  DOWNLOAD_FAILED: 'download',
  DOWNLOAD_LIMIT: 'download',
  DOWNLOAD_DIGEST_MISMATCH: 'download',
  INVALID_BASE64: 'download',
  NONCANONICAL_BASE64: 'download',
  NETWORK_TARGET_REJECTED: 'download',
  INVALID_GITHUB_URL: 'download',
  INVALID_GITHUB_RESPONSE: 'download',
  INVALID_GITHUB_ASSET: 'download',
  GITHUB_REPOSITORY_CHANGED: 'download',
  GITHUB_DIGEST_REQUIRED: 'download',
  AMBIGUOUS_RELEASE_ASSET: 'download',
  NO_UPDATE_AVAILABLE: 'download',
  NO_PLUGIN_RELEASE: 'download',
  INVALID_CANDIDATE: 'download',
  SEARCH_LIMIT: 'download',
  INVALID_CATALOG: 'download',
  DUPLICATE_CATALOG_PLUGIN: 'download',
  CATALOG_EXPIRED_OR_REPLAYED: 'download',
  INVALID_CATALOG_KEY: 'download',
  INVALID_CATALOG_SIGNATURE: 'download',
  // 解包与布局
  ZIP_LIMIT: 'unpack',
  ZIP_LIMIT_OR_DUPLICATE: 'unpack',
  ZIP_EXPANSION_LIMIT: 'unpack',
  ZIP_SIZE_MISMATCH: 'unpack',
  ZIP_CRC_MISMATCH: 'unpack',
  ZIP_INCOMPLETE: 'unpack',
  ZIP_PATH_MISMATCH: 'unpack',
  ZIP_UNLISTED_ENTRY: 'unpack',
  ZIP_OVERLAPPING_ENTRIES: 'unpack',
  INVALID_ZIP: 'unpack',
  UNSUPPORTED_ZIP: 'unpack',
  UNSAFE_PATH: 'unpack',
  MISSING_FILE: 'unpack',
  UNLISTED_FILE: 'unpack',
  UNEXPECTED_PACKAGE_FILE: 'layout',
  INVALID_LAYOUT: 'layout',
  // 签名与完整性
  INVALID_INTEGRITY: 'signature',
  INTEGRITY_MISMATCH: 'signature',
  INVALID_SIGNATURE: 'signature',
  IDENTITY_MISMATCH: 'signature',
  PUBLISHER_MISMATCH: 'signature',
  // manifest 与贡献
  MANIFEST_INVALID: 'manifest',
  INVALID_JSON: 'manifest',
  INVALID_JSON_NUMBER: 'manifest',
  INVALID_UTF8: 'manifest',
  JSON_DEPTH: 'manifest',
  INVALID_UNICODE: 'manifest',
  DUPLICATE_OR_UNSAFE_KEY: 'manifest',
  DUPLICATE_CONTRIBUTION: 'manifest',
  EMPTY_PLUGIN: 'manifest',
  INVALID_SKILL: 'manifest',
  INVALID_FRONTMATTER: 'manifest',
  INVALID_SKILL_TOOLS: 'manifest',
  INVALID_SKILL_RESOURCE: 'manifest',
  SKILL_RESOURCE_LIMIT: 'manifest',
  CATALOG_SIZE_LIMIT: 'manifest',
  // 宿主兼容
  INCOMPATIBLE_HOST: 'compat',
  // Schema
  INVALID_SCHEMA: 'schema',
  SCHEMA_LIMIT: 'schema',
  UNSUPPORTED_SCHEMA_KEYWORD: 'schema',
  INVALID_SCHEMA_TYPE: 'schema',
  INVALID_SCHEMA_REQUIRED: 'schema',
  INVALID_SCHEMA_ADDITIONAL_PROPERTIES: 'schema',
  INVALID_SCHEMA_BOUND: 'schema',
  INVALID_SCHEMA_ENUM: 'schema',
  INVALID_SCHEMA_PROPERTIES: 'schema',
  INVALID_ARGUMENTS: 'schema',
  ARGUMENT_LIMIT: 'schema',
  VALIDATION_BUDGET: 'schema',
  // 引用与权限
  INVALID_REF: 'reference',
  CROSS_PLUGIN_REFERENCE: 'reference',
  UNDECLARED_HOST_TOOL: 'reference',
  UNDECLARED_NETWORK: 'reference',
  UNDECLARED_SECRET: 'reference',
  MISSING_TOOL_REFERENCE: 'reference',
  MISSING_SKILL_REFERENCE: 'reference',
  HOST_TOOL_NOT_PUBLIC: 'reference',
  HOST_TOOL_NOT_FOUND: 'reference',
  // 依赖
  DEPENDENCY_BLOCKED: 'dependency',
  DEPENDENCY_CYCLE: 'dependency',
  DEPENDENCY_DEPTH: 'dependency',
  BREAKS_DEPENDENT: 'dependency',
  // 提交 / 版本
  STALE_PREVIEW: 'commit',
  STALE_GENERATION: 'commit',
  VERSION_CONTENT_CONFLICT: 'commit',
  DOWNGRADE_REJECTED: 'commit',
  SOURCE_CHANGE_REJECTED: 'commit',
  DUPLICATE_PLUGIN: 'commit',
  RELEASE_NOT_FOUND: 'commit',
  PLUGIN_NOT_FOUND: 'commit',
  CATALOG_CONFLICT: 'commit',
  INVALID_RELEASE_RECORD: 'commit',
  BACKUP_LIMIT: 'commit',
  ROLLBACK_EXPIRED: 'commit',
  // 应用 / 启动
  PLUGIN_HOST_TIMEOUT: 'apply',
  PLUGIN_HOST_UNAVAILABLE: 'apply',
  CATALOG_APPLY_FAILED: 'apply',
  PLUGIN_DATABASE_BLOCKED: 'apply',
  PLUGIN_TRANSACTION_ABORTED: 'apply',
  RELEASE_MISSING: 'apply',
  RELEASE_RESTORED: 'apply',
  PLUGIN_QUARANTINED: 'apply',
  // 运行时
  MCP_SCHEMA_CHANGED: 'runtime',
  MCP_ORIGIN_MISMATCH: 'runtime',
  MCP_RESPONSE_LIMIT: 'runtime',
  MCP_PAGINATION_LOOP: 'runtime',
  MCP_FAILED: 'runtime',
  CAPABILITY_REVOKED: 'runtime',
  PLUGIN_VERSION_CHANGED: 'runtime',
  PLUGIN_APPROVAL_REQUIRED: 'runtime',
  PLUGIN_BUSY_OR_CANCELLED: 'runtime',
  INVALID_TOOL_RESULT: 'runtime',
  SECRET_REQUIRED: 'runtime',
  TOOL_NOT_FOUND: 'runtime',
  INVALID_EXECUTOR: 'runtime',
  PLUGIN_EXECUTION_FAILED: 'runtime',
  NATIVE_REPLAY_DEPTH: 'runtime',
  TOOL_REQUEST_LIMIT: 'runtime',
};

/** 错误码 → 阶段；未知错误码统一归入 request，避免日志里出现空阶段 */
export function stageOf(code?: string): PluginOperationStage | undefined {
  if (!code) return undefined;
  return STAGE_BY_CODE[code] ?? 'request';
}

/** 把任意异常收敛成稳定错误码 + 可读 detail；日志与 UI 共用同一口径 */
export function describeOperationError(error: unknown): {
  code: string;
  detail: string;
} {
  if (error instanceof PluginError) {
    return { code: error.code, detail: error.detail || error.message };
  }
  if (error instanceof ZodError) {
    return {
      code: 'INVALID_PAYLOAD',
      detail: error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    };
  }
  if (error instanceof Error) {
    return { code: 'PLUGIN_OPERATION_FAILED', detail: error.message };
  }
  return { code: 'PLUGIN_OPERATION_FAILED', detail: String(error) };
}

/** 从复合原因串（如 `INCOMPATIBLE_HOST: ...`）提取稳定错误码 */
export function codeOfReason(reason: string): string {
  const index = reason.indexOf(':');
  return (index < 0 ? reason : reason.slice(0, index)).trim();
}
