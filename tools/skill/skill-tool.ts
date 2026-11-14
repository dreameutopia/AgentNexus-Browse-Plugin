import type { OpenAITool } from '@/common/openai-types';
import { getSkillById, setCustomSkill, removeCustomSkill, restoreCustomSkillsFromStorage } from '@/utils/skills/skill-store';
import { buildSkillInstruction, skillLoadSuccessMessage } from '@/utils/skills/skill-instruction';
import { normalizeSkillPageParam, paginateSkillText, SKILL_PAGE_TOKEN_BUDGET } from '@/utils/skills/skill-pagination';
import { isSkillResourcePath, skillResourcePaths } from '@/utils/skills/skill-resources';
import { SKILL_TOOL_ID, skillToolCall } from '@/utils/skills/skill-tool-contract';
import { isSkillId, isBuiltinSkillId } from '@/utils/skills/skill-identity';
import { composeSkillDocument, importWorkspaceSkillFiles } from '@/utils/skills/skill-authoring';
import { linkedSkillIds } from '@/utils/agents/agent-skill-links';
import { copySkillToWorkspace } from '@/utils/skills/skill-workspace';
import { requireWorkspaceChatId } from '@/utils/python-workspace/artifact-contract';
import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { applyTextEdit, parseTextEdits } from '@/utils/python-workspace/text-edit';
import { errorDetails } from '@/utils/shared/error-details';
import { interactTool } from '../interact/interact-tool';
import { t } from '@/utils/i18n';
import { BaseTool } from '../base-tool';
import type { ToolExecutionContext, ToolMetadata } from '../registry';
const fields = ['name', 'description', 'compatibility', 'license', 'category', 'tags', 'allowed_tools'];
const allowed: Record<string, string[]> = {
    load: ['skill_id', 'page'], read: ['skill_id', 'path', 'page'], copy: ['skill_id', 'paths'],
    create: [...fields, 'content', 'files'],
    edit: ['skill_id', ...fields, 'content', 'find', 'replace', 'replaceAll', 'matchMode', 'edits', 'files', 'remove_files', 'expected_updated_at'],
    delete: ['skill_id', 'expected_updated_at'],
};
class SkillTool extends BaseTool {
    name = SKILL_TOOL_ID;
    metadata: ToolMetadata = { name: this.name, description: 'Skill 的发现、加载、资源复制和用户授权后的创建/修订/删除；仅以数字 ID 定位', category: 'skill', version: '3.0.0', author: 'AgentNexus', tags: ['skill', 'resource', 'authoring'], noVisionRecapture: true };
    openaiSchema: OpenAITool = { type: 'function', function: { name: SKILL_TOOL_ID,
            description: '全局技能工具。load/read/copy/edit/delete 仅接受 skill_id（纯十进制字符串），create 的 name 是元数据而非定位键。创建前须用户主动要求并先加载 Skill 4；修订前须明确授权并先加载 Skill 5。资源先 copy 到工作区再使用，copy 不依赖 Python。内置 ID 1..1000 不可编辑/删除。删除存在的技能会再次弹窗确认，拒绝不会删除。编辑空元属性保持原值；资源增加、删除与正文修改原子保存。',
            parameters: { type: 'object', additionalProperties: false, required: ['action'], properties: {
                    action: { type: 'string', enum: Object.keys(allowed) }, skill_id: { type: 'string', pattern: '^[1-9][0-9]*$', description: '技能唯一数字 ID；禁止名称或 name-id' },
                    name: { type: 'string', description: '网站名与精准操作的 kebab-case 名称，最多 64 字符；仅 create/edit 元数据' },
                    description: { type: 'string', description: '适用场景、精准 URL 和必要边界，不写实现步骤；最多 1024 字符' },
                    content: { type: 'string', description: 'SKILL.md 正文，不含 frontmatter；edit 与 find/replace、edits 互斥' },
                    compatibility: { type: 'string' }, license: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, allowed_tools: { type: 'array', items: { type: 'string' } },
                    find: { type: 'string' }, replace: { type: 'string' }, replaceAll: { type: 'boolean' }, matchMode: { type: 'string', enum: ['exact', 'indentation'] },
                    edits: { type: 'array', maxItems: 100, items: { type: 'object', required: ['find', 'replace'], additionalProperties: false, properties: { find: { type: 'string' }, replace: { type: 'string' }, replaceAll: { type: 'boolean' }, matchMode: { type: 'string', enum: ['exact', 'indentation'] } } } },
                    files: { type: 'array', maxItems: 256, description: '新增资源：工作区文件路径字符串，或 {path,destination,replace}；目标默认 resources/文件名。已有资源须先移除或显式 replace=true。', items: { anyOf: [{ type: 'string' }, { type: 'object', additionalProperties: false, required: ['path'], properties: { path: { type: 'string' }, destination: { type: 'string' }, replace: { type: 'boolean' } } }] } },
                    remove_files: { type: 'array', items: { type: 'string' }, description: '仅 edit：删除的技能相对路径列表，禁止 SKILL.md；与新增文件在同一次保存中提交' },
                    paths: { type: 'array', items: { type: 'string' }, description: '仅 copy：技能相对文件/目录列表，["."] 复制全部；返回实际工作区路径，不覆盖已有文件' },
                    path: { type: 'string', description: '仅 read：技能相对文本资源路径，默认 SKILL.md' }, page: { type: 'integer', minimum: 1 },
                    expected_updated_at: { type: 'integer', description: 'edit/delete 的并发版本保护，取最近 load/read 返回值' },
                }, anyOf: Object.keys(allowed).map(action => ({ properties: { action: { type: 'string', enum: [action] } }, required: action === 'create' ? ['action', 'name', 'description', 'content'] : action === 'copy' ? ['action', 'skill_id', 'paths'] : ['action', 'skill_id'] })) }
        } };
    async execute(raw: unknown, context?: ToolExecutionContext) {
        try {
            if (!raw || typeof raw !== 'object' || Array.isArray(raw))
                throw new Error('参数必须是 JSON 对象');
            const args = raw as Record<string, unknown>, action = args.action;
            if (typeof action !== 'string' || !Object.hasOwn(allowed, action))
                throw new Error('未知 action');
            if (Object.keys(args).some(key => key !== 'action' && !allowed[action].includes(key)))
                throw new Error('包含当前 action 不接受的参数，定位只能用 skill_id');
            if (args.expected_updated_at !== undefined && (!Number.isSafeInteger(args.expected_updated_at) || (args.expected_updated_at as number) < 0))
                throw new Error('expected_updated_at 必须是非负安全整数');
            const chatId = requireWorkspaceChatId(context?.chatId);
            context?.signal?.throwIfAborted();
            if (!await chatDatabase.getSession(chatId)) throw new Error('[SKILL_CONTEXT] 当前会话已不存在，未执行技能操作');
            context?.signal?.throwIfAborted();
            await restoreCustomSkillsFromStorage(true);
            context?.signal?.throwIfAborted();
            const skill = action === 'create' ? undefined : isSkillId(args.skill_id) ? getSkillById(args.skill_id) : undefined;
            if (action !== 'create' && !skill) {
                if (action === 'delete' && isSkillId(args.skill_id))
                    return this.createSuccessResponse({ deleted: false, reason: 'not-found', skill_id: args.skill_id }, '技能不存在，未执行删除');
                throw new Error('[SKILL_NOT_FOUND] 请提供存在的纯数字 skill_id');
            }
            if (action === 'create' && !context?.agentId)
                throw new Error('[SKILL_AGENT_REQUIRED] 缺少本轮调用智能体 ID，未创建技能；请恢复会话运行上下文后重试');
            if (action === 'create' || action === 'edit') {
                for (const field of fields) {
                    const value = args[field];
                    if (value === undefined || value === null || value === '')
                        continue;
                    if (['tags', 'allowed_tools'].includes(field) ? !Array.isArray(value) || !value.every(item => typeof item === 'string') : typeof value !== 'string')
                        throw new Error(field + ' 参数类型错误');
                }
                if (args.content !== undefined && typeof args.content !== 'string')
                    throw new Error('content 必须是正文字符串');
                const required = action === 'create' ? '4' : '5';
                if (!context?.loadedSkillIds?.includes(required))
                    throw new Error('[SKILL_GUIDANCE_REQUIRED] 请先 load Skill ' + required);
                if (skill && isBuiltinSkillId(skill.id))
                    throw new Error('[SKILL_PROTECTED] 内置技能不允许编辑');
                const initialContent = action === 'create' ? args.content : args.content !== undefined ? args.content : skill!.body;
                if (typeof initialContent !== 'string')
                    throw new Error('content 必须是正文字符串');
                let content: string = initialContent;
                const pair = args.find !== undefined || args.replace !== undefined, batch = args.edits !== undefined;
                if ((pair || batch) && args.content !== undefined)
                    throw new Error('content 与精准替换互斥');
                if (!pair && (args.replaceAll !== undefined || args.matchMode !== undefined))
                    throw new Error('replaceAll/matchMode 需要 find/replace');
                if (pair && batch)
                    throw new Error('find/replace 与 edits 互斥');
                const edits = pair || batch ? parseTextEdits(batch ? args.edits : [{ find: args.find, replace: args.replace, replaceAll: args.replaceAll, matchMode: args.matchMode }]) : [];
                for (const edit of edits) {
                    content = applyTextEdit(content, edit).text;
                }
                const metadata: Record<string, unknown> = skill ? { name: skill.name, description: skill.description, compatibility: skill.compatibility, license: skill.license, category: skill.category, tags: skill.tags, allowed_tools: skill.allowedTools } : {};
                for (const field of fields)
                    if (args[field] !== undefined && args[field] !== null && args[field] !== '' && !(Array.isArray(args[field]) && !(args[field] as unknown[]).length))
                        metadata[field] = args[field];
                const imported = await importWorkspaceSkillFiles(chatId, args.files, skill ?? { files: {} }, args.remove_files, context?.signal);
                imported.files['SKILL.md'] = composeSkillDocument(metadata, content, skill?.files['SKILL.md']);
                context?.signal?.throwIfAborted();
                const result = await setCustomSkill({ id: skill?.id, name: metadata.name as string, ...imported, folders: skill?.folders, enabled: skill?.enabled ?? true, signal: context?.signal, associateAgentId: action === 'create' ? context?.agentId : undefined, expectedUpdatedAt: args.expected_updated_at as number | undefined ?? skill?.updatedAt });
                if (!result.ok)
                    throw new Error('[SKILL_WRITE_FAILED] ' + result.reason + (result.error ? ': ' + result.error : ''));
                return this.createSuccessResponse({ skill_id: result.skill.id, name: result.skill.name, updated_at: result.skill.updatedAt, files: skillResourcePaths(result.skill), associated_agent_id: context?.agentId ?? null }, action === 'create' ? '技能已创建并关联本轮智能体' : '技能已原子更新');
            }
            const target = skill!;
            if (action === 'delete') {
                if (isBuiltinSkillId(target.id))
                    throw new Error('[SKILL_PROTECTED] 内置技能不允许删除');
                const confirm = t('sidepanel.chat.skillDeleteConfirmAction');
                const response = await interactTool.execute({ question: t('sidepanel.chat.skillDeleteQuestion', { name: target.name, id: target.id }), context: t('sidepanel.chat.skillDeleteWarning'), options: [{ label: confirm }, { label: t('sidepanel.chat.skillCancel') }], sensitive: true }, context);
                if (!response.success || !response.data?.answered || response.data.answer !== confirm)
                    return this.createSuccessResponse({ deleted: false, skill_id: target.id, reason: 'confirmation-declined' }, '未确认删除，技能已保留');
                context?.signal?.throwIfAborted();
                const deleted = await removeCustomSkill(target.id, args.expected_updated_at as number | undefined ?? target.updatedAt, context?.signal);
                return this.createSuccessResponse({ deleted, skill_id: target.id }, deleted ? '技能已删除' : '技能已变化或不存在，未删除');
            }
            if (!target.enabled)
                throw new Error('[SKILL_NOT_AVAILABLE] 技能已停用');
            if (context?.availableSkillIds && !context.availableSkillIds.includes(target.id) && !(context.agentId && linkedSkillIds(context.agentId).includes(target.id)) && !['4', '5'].includes(target.id))
                throw new Error('[SKILL_NOT_AVAILABLE] 技能不在本轮清单中');
            if (action === 'load') {
                const loaded = buildSkillInstruction(target, normalizeSkillPageParam(args.page));
                return this.createSuccessResponse({ ...loaded, updated_at: target.updatedAt }, skillLoadSuccessMessage(loaded));
            }
            if (action === 'copy') {
                const result = await copySkillToWorkspace(chatId, target, args.paths, context?.signal, async (commit) => { await restoreCustomSkillsFromStorage(true); const current = getSkillById(target.id); if (!current?.enabled || current.updatedAt !== target.updatedAt)
                    throw new Error('技能已变化，请重新 load 后复制'); await commit(); });
                return this.createSuccessResponse({ skill_id: target.id, ...result }, '技能资源已复制；后续使用返回的实际工作区路径');
            }
            const path = args.path ?? 'SKILL.md';
            if (typeof path !== 'string' || !isSkillResourcePath(path))
                throw new Error('path 必须是技能相对路径');
            const content = target.files[path];
            if (typeof content !== 'string')
                throw new Error('资源不存在或为二进制；二进制请先 copy 到工作区');
            const paged = paginateSkillText(content, normalizeSkillPageParam(args.page));
            if (!paged.ok)
                throw new Error('页码越界，共 ' + paged.pageCount + ' 页');
            return this.createSuccessResponse({ skill_id: target.id, path, updated_at: target.updatedAt, ...paged.page, hint: paged.page.page < paged.page.pageCount ? skillToolCall('read', target.id, paged.page.page + 1, path) : undefined }, '已读取技能资源');
        }
        catch (error) {
            return this.createErrorResponse(context?.signal?.aborted ? '[SKILL_CANCELLED] 技能操作已取消' : '[SKILL_OPERATION_FAILED] ' + errorDetails(error, 2000));
        }
    }
}
export const skillTool = new SkillTool();
