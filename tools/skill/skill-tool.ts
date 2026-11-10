import type { OpenAITool } from '@/common/openai-types';
import { isSkillScriptSupportEnabled, withSkillScriptSupport } from '@/utils/pyodide/pyodide-env';
import { pluginBindings } from '@/utils/plugins/catalog';
import { getEnabledSkills, resolveSkill } from '@/utils/skills/skill-store';
import { buildSkillInstruction, skillLoadSuccessMessage } from '@/utils/skills/skill-instruction';
import { normalizeSkillPageParam, paginateSkillText, SKILL_PAGE_TOKEN_BUDGET } from '@/utils/skills/skill-pagination';
import { isSkillResourcePath, skillResourcePaths } from '@/utils/skills/skill-resources';
import { SKILL_TOOL_ID, skillToolCall, type SkillToolMode } from '@/utils/skills/skill-tool-contract';
import { modelSkillIdOf, type SkillRecord } from '@/utils/skills/skill-types';
import { copySkillToWorkspace } from '@/utils/skills/skill-workspace';
import { BaseTool } from '../base-tool';
import type { ToolExecutionContext, ToolMetadata, ToolSchemaOptions } from '../registry';

const baseDescription = '按 action 使用会话可用的技能。load 读取 SKILL.md 的指令和资源清单；' +
  'read 按相对路径读取文本资源，省略 path 时读取 SKILL.md 原文。' +
  `两项操作均支持 page 分页，每页约 ${SKILL_PAGE_TOKEN_BUDGET} token。相关技能须先加载再按其指令工作。`;
const copyDescription = 'copy 将指定文件、目录或整个技能复制到当前会话工作区，保留目录和原始字节。' +
  'paths 使用技能根目录下的精确相对路径，["."] 复制整个技能。返回的 workspacePath 可交给 python_run 定位脚本与资源。';

function schema(mode: SkillToolMode): OpenAITool {
  const workspace = mode === 'workspace';
  const actions = workspace ? ['load', 'read', 'copy'] : ['load', 'read'];
  return {
    type: 'function',
    function: {
      name: SKILL_TOOL_ID,
      description: workspace ? baseDescription + copyDescription : baseDescription,
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action', 'skill_name'],
        properties: {
          action: { type: 'string', enum: actions },
          skill_name: { type: 'string', description: '技能清单中的唯一标识，原样传入' },
          page: { type: 'integer', minimum: 1, description: '仅 load / read，默认第 1 页' },
          path: { type: 'string', description: '仅 read，文本文件相对于技能根目录的路径' },
          ...(workspace ? {
            paths: { type: 'array', items: { type: 'string' }, description: '仅 copy，必填。技能内的文件或目录相对路径列表。' },
          } : {}),
        },
        anyOf: actions.map(action => ({
          type: 'object',
          properties: { action: { type: 'string', enum: [action] } },
          required: action === 'copy' ? ['action', 'paths'] : ['action'],
        })),
      },
    },
  };
}

class SkillTool extends BaseTool {
  name = SKILL_TOOL_ID;
  metadata: ToolMetadata = {
    name: this.name, description: baseDescription, category: 'skill', version: '2.0.0',
    author: 'AgentNexus', tags: ['skill', 'resource'], noVisionRecapture: true,
  };
  openaiSchema = schema('text');
  private readonly workspaceSchema = schema('workspace');

  getSchema(options: ToolSchemaOptions): OpenAITool {
    return options.skillMode === 'workspace' ? this.workspaceSchema : this.openaiSchema;
  }

  async execute(params: unknown, context?: ToolExecutionContext) {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
      return this.createErrorResponse('[SKILL_INVALID_ARGUMENTS] 参数必须是 JSON 对象');
    }
    const { action, skill_name: ref, path, paths, page } = params as Record<string, unknown>;
    const mode = context?.skillMode === 'workspace' && await isSkillScriptSupportEnabled()
      ? 'workspace' : 'text';
    if (action !== 'load' && action !== 'read' && action !== 'copy') {
      return this.createErrorResponse('[SKILL_INVALID_ACTION] 可用 action：' + (mode === 'workspace' ? 'load、read、copy' : 'load、read'));
    }
    if (action === 'copy' && (mode !== 'workspace' || !context?.chatId || !context.skillResourceIds?.length)) {
      return this.createErrorResponse('[SKILL_WORKSPACE_UNAVAILABLE] 当前会话未启用或未授权技能工作区操作');
    }
    const permitted = new Set(['action', 'skill_name', ...(action === 'load' ? ['page'] : action === 'read' ? ['page', 'path'] : ['paths'])]);
    if (Object.keys(params).some(key => !permitted.has(key))) {
      return this.createErrorResponse('[SKILL_INVALID_ARGUMENTS] 包含当前 action 不接受的参数');
    }
    if (typeof ref !== 'string' || !ref.trim() || ref.length > 512) {
      return this.createErrorResponse('[SKILL_INVALID_REFERENCE] 请提供有效的 skill_name');
    }
    const skill = resolveSkill(ref);
    if (!skill?.enabled || (context?.availableSkillIds && !context.availableSkillIds.includes(skill.id))) {
      const available = getEnabledSkills()
        .filter(candidate => !context?.availableSkillIds || context.availableSkillIds.includes(candidate.id))
        .slice(0, 20).map(modelSkillIdOf).join(', ');
      return this.createErrorResponse('[SKILL_NOT_AVAILABLE] 技能不存在、已停用或不在会话范围。可用标识：' + (available || '无'));
    }
    if (skill.plugin && context?.chatId) {
      const current = pluginBindings()[skill.plugin.key];
      const granted = context.pluginBindings?.[skill.plugin.key];
      if (!current || current.digest !== granted?.digest || current.epoch !== granted.epoch) {
        return this.createErrorResponse('[SKILL_PLUGIN_CHANGED] 技能插件已更新或权限已变化，请重新发起会话请求');
      }
    }
    const canCopy = mode === 'workspace' && !!context?.skillResourceIds?.includes(skill.id);
    try {
      context?.signal?.throwIfAborted();
      if (action === 'load') {
        const loaded = buildSkillInstruction(skill, normalizeSkillPageParam(page), canCopy ? 'workspace' : 'text');
        return this.createSuccessResponse(loaded, skillLoadSuccessMessage(loaded));
      }
      if (action === 'read') return this.read(skill, path, normalizeSkillPageParam(page), canCopy);
      if (!canCopy || !context?.chatId) return this.createErrorResponse('[SKILL_NOT_AVAILABLE] 当前技能未获工作区授权');
      const chatId = context.chatId;
      const result = await withSkillScriptSupport(context.signal, signal => copySkillToWorkspace(chatId, skill, paths, signal));
      const files: string[] = [];
      let size = 0;
      for (const path of result.files) {
        size += JSON.stringify(path).length + 1;
        if (size > 4000) break;
        files.push(path);
      }
      return this.createSuccessResponse({
        workspacePath: result.workspacePath, files,
        fileCount: result.files.length, directoryCount: result.directories.length,
        ...(files.length < result.files.length || result.directories.length
          ? { hint: '目标路径为 workspacePath 加上原始技能相对路径，可在工作区列出完整目录。' }
          : {}),
      }, '技能资源已复制到当前会话工作区');
    } catch (error) {
      if (context?.signal?.aborted) return this.createErrorResponse('[SKILL_CANCELLED] 技能操作已取消');
      return this.createErrorResponse('[SKILL_OPERATION_FAILED] ' + (error instanceof Error ? error.message : String(error)).slice(0, 2000));
    }
  }

  private read(skill: SkillRecord, rawPath: unknown, page: number, canCopy: boolean) {
    const path = rawPath ?? 'SKILL.md';
    if (typeof path !== 'string' || !isSkillResourcePath(path)) {
      return this.createErrorResponse('[SKILL_INVALID_PATH] 请提供技能内的文件相对路径');
    }
    if (skill.resourceBytes && Object.hasOwn(skill.resourceBytes, path)) {
      return this.createErrorResponse(canCopy ? '此资源为二进制文件，可用 copy 将它复制到工作区。' : '此资源为二进制文件，当前会话仅能读取文本。');
    }
    const content = Object.hasOwn(skill.files, path) ? skill.files[path] : undefined;
    if (typeof content !== 'string') {
      const available = skillResourcePaths(skill)
        .filter(path => canCopy || Object.hasOwn(skill.files, path)).slice(0, 30).map(path => JSON.stringify(path));
      return this.createErrorResponse(`文件 ${JSON.stringify(path)} 不存在或不可读取。可用文件：${available.join(', ')}`);
    }
    const paged = paginateSkillText(content, page);
    if (!paged.ok) return this.createErrorResponse(`文件共 ${paged.pageCount} 页，不存在第 ${page} 页`);
    const { content: text, ...pagination } = paged.page;
    const truncated = pagination.page < pagination.pageCount;
    return this.createSuccessResponse({
      skill: modelSkillIdOf(skill), name: skill.name, path, content: text, pagination, truncated,
      ...(truncated ? { hint: '继续读取：' + skillToolCall('read', modelSkillIdOf(skill), page + 1, path) } : {}),
    }, `已读取 ${skill.name}/${path}${truncated ? `（第 ${page}/${pagination.pageCount} 页）` : ''}`);
  }
}

export const skillTool = new SkillTool();
