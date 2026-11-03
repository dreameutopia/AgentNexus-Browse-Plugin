/**
 * 笔记统一工具（note_tool）
 *
 * 把原五件套（create_note / append_note / update_note / get_note_content /
 * delete_note）整合为单一工具，以 action 参数区分操作。整合动机：
 *   - 五份 schema 常驻上下文，token 成本高且模型需要在多个工具间做选择，
 *     实测出现过「用臆造 ID 调 append_note」的错误路径（五件套里没有
 *     查询入口，模型拿不到真实 ID 只能编造）；
 *   - 单工具 + action 让工作流在 description 内即可交代清楚：
 *     create 拿 ID → append 追加 → get/list 回顾，ID 只信返回值；
 *   - list 是补齐的关键能力：按关键词查笔记（标题 + 正文派生文本），
 *     模型从此有正当途径拿到真实 noteId。
 *
 * 行为变更（配合消息底部笔记卡片导航）：
 *   - create 不再自动打开/切换内置笔记页——任务中途切走标签页会打断
 *     用户当前浏览；改为在对应消息底部渲染可点击的笔记卡片，由用户
 *     自主跳转（notes.html#note=<id> 深链，见 sidepanel/utils/chat/note-nav.ts）。
 *
 * 结果契约（UI 卡片数据源）：所有成功结果的 data 至少含 action；涉及
 * 具体笔记的操作（create/append/update/delete）额外含 noteId 与 title，
 * 供消息底部提取渲染「本条消息关联的笔记」卡片。
 */

import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import {
  notesDB,
  requireNoteId,
  requireNonEmptyString,
  optionalString,
  normalizeTags,
  normalizeCategory,
  plainTextToHtml,
  CATEGORY_AI,
  type UpdateNoteInput,
} from '@/utils/notes-database';
import {
  BaseNoteTool,
  noteToolSuccess,
  noteToolFailure,
  noteToolFailureFromError,
  noteNotFound,
} from './base-note-tool';

const TOOL_NAME = 'note_tool';

/** list 结果单条上限（防止超长笔记正文撑爆上下文；详情用 get 获取） */
const LIST_PREVIEW_MAX_CHARS = 120;
/** list 默认返回条数（新修改在前） */
const LIST_DEFAULT_LIMIT = 10;
/** list 返回条数上限 */
const LIST_MAX_LIMIT = 30;

type NoteAction = 'create' | 'append' | 'update' | 'get' | 'list' | 'delete';

const ACTION_LIST: NoteAction[] = ['create', 'append', 'update', 'get', 'list', 'delete'];

function isNoteAction(value: unknown): value is NoteAction {
  return typeof value === 'string' && (ACTION_LIST as string[]).includes(value);
}

export class NoteTool extends BaseNoteTool {
  name = TOOL_NAME;

  metadata: ToolMetadata = {
    name: TOOL_NAME,
    description: '笔记工作区统一工具：create/append/update/get/list/delete 六种操作',
    category: 'note',
    version: '4.0.0',
    author: 'AgentNexus',
    tags: ['note', 'create', 'append', 'update', 'read', 'list', 'delete'],
    // 仅 delete（不可逆删除）过人审门；其余操作直接执行（见 registry 的 action 级审批契约）
    requiresApprovalActions: ['delete'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: TOOL_NAME,
      description:
        '内置笔记工作区的统一操作工具（跨会话的外部记忆，沉淀知识而非跟踪任务）。通过 action 指定操作：\n' +
        '- create：新建笔记（title/content/category/tags 可选）→ 返回 noteId，后续操作都必须用它\n' +
        '- append：向笔记末尾追加内容（noteId + content）——记录调研发现/中间结论/失败尝试的首选\n' +
        '- update：更新标题/内容/分类/标签（noteId + 至少一个字段；content 整体替换原正文）\n' +
        '- get：读取笔记完整纯文本（noteId）\n' +
        '- list：按关键词列出笔记（keyword 可选）→ 返回 noteId + 标题 + 修改时间，用于找回 ID\n' +
        '- delete：删除笔记（noteId，仅在用户明确要求时使用）\n' +
        '记什么（重点是可复用的知识与证据，跨会话长期保留）：大范围调研中每个关键发现（一句话核心摘要 + 具体来源 URL）；任务产出的最终完整重要结果（结论、数据、有效来源清单）；实验/多轮尝试的过程与结论（含失败路径）。\n' +
        '不记什么：任务步骤与执行进度（那是 plan_tool 的会话计划，不要用笔记做任务清单）；大段原文搬运（提炼成事实与判断后再落笔）。\n' +
        '工作流约定：noteId 只能来自 create/list/get 的返回值，禁止凭记忆或语义臆造；追加内容忘了 ID 时先 list 查询。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ACTION_LIST,
            description: '要执行的笔记操作',
          },
          noteId: {
            type: 'string',
            description: '目标笔记 ID（append/update/get/delete 必填；create/list 不需要）',
          },
          title: {
            type: 'string',
            description: '笔记标题（create 新建时；update 改名时）',
          },
          content: {
            type: 'string',
            description:
              '笔记内容（纯文本；``` 围栏转为代码块，其余按段落组织为富文本）。' +
              'create=初始内容，append=追加内容，update=整体替换正文',
          },
          category: {
            type: 'string',
            description: '笔记分类（create/update 可选；缺省 "ai"，可传已有分类名或新分类名）',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '标签列表（create/update 可选）',
          },
          keyword: {
            type: 'string',
            description: 'list 操作的过滤关键词（匹配标题与正文；缺省列出最近笔记）',
          },
          limit: {
            type: 'number',
            description: `list 操作返回条数（默认 ${LIST_DEFAULT_LIMIT}，上限 ${LIST_MAX_LIMIT}）`,
          },
        },
        required: ['action'],
      },
    },
  };

  async execute(rawArgs: unknown): Promise<ToolResult> {
    let action = '';
    try {
      const args = this.asArgs(rawArgs);
      if (!isNoteAction(args.action)) {
        return noteToolFailure(
          TOOL_NAME,
          '参数校验',
          '参数错误',
          `action 必须为 ${ACTION_LIST.join(' / ')} 之一，实际收到: ${JSON.stringify(args.action ?? null)}`,
          '在 arguments 中显式传入 action 字段；六种操作共用本工具',
        );
      }
      action = args.action;
      switch (action) {
        case 'create':
          return await this.handleCreate(args);
        case 'append':
          return await this.handleAppend(args);
        case 'update':
          return await this.handleUpdate(args);
        case 'get':
          return await this.handleGet(args);
        case 'list':
          return await this.handleList(args);
        case 'delete':
          return await this.handleDelete(args);
      }
      // isNoteAction 收窄后的理论不可达分支：防御性兜底返回，保证全路径有返回值
      return noteToolFailure(
        TOOL_NAME,
        '参数校验',
        '参数错误',
        `未处理的 action: ${JSON.stringify(action)}`,
        '请传入受支持的 action',
      );
    } catch (error) {
      // action 已进入局部变量：错误信息带上当前操作便于定位
      const operation = `笔记操作(${action || '未知 action'})`;
      this.logStep(
        `${operation}失败: ${error instanceof Error ? error.message : String(error)}`,
        'error',
      );
      return noteToolFailureFromError(TOOL_NAME, operation, error);
    }
  }

  // ── create：新建笔记（不自动打开笔记页，导航由消息底部卡片承担） ──

  private async handleCreate(args: Record<string, unknown>): Promise<ToolResult> {
    const plainContent = optionalString(args.content, 'content');
    const note = await notesDB.createNote({
      kind: 'note',
      title: optionalString(args.title, 'title'),
      content: plainContent ? plainTextToHtml(plainContent) : '',
      category: normalizeCategory(args.category, CATEGORY_AI),
      tags: normalizeTags(args.tags, 'tags'),
    });
    this.logStep(`笔记创建成功，ID: ${note.id}`);
    this.notifyChange('create', note.id);

    return noteToolSuccess(
      `笔记创建成功。\n` +
        `- Note ID: ${note.id}（后续 append/update/get/delete 都用它）\n` +
        `- 标题: ${note.title}\n` +
        `- 分类: ${note.category}\n` +
        `- 标签: ${note.tags.join(', ') || '无'}\n` +
        `用户可在对话消息底部的笔记卡片中打开该笔记。`,
      { action: 'create', noteId: note.id, title: note.title, category: note.category },
    );
  }

  // ── append：末尾追加（原子读-改-写，与用户编辑并发安全） ──

  private async handleAppend(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = requireNoteId(args.noteId, 'noteId');
    const content = requireNonEmptyString(args.content, 'content');

    const updated = await notesDB.appendToNote(noteId, content);
    if (!updated) {
      return noteNotFound(TOOL_NAME, '追加内容', noteId);
    }
    this.notifyChange('append', noteId);
    this.logStep(`内容追加成功，当前正文 ${updated.content.length} 字`);

    return noteToolSuccess(
      `内容已追加到笔记「${updated.title}」末尾（当前正文 ${updated.content.length} 字）。`,
      { action: 'append', noteId, title: updated.title },
    );
  }

  // ── update：覆盖式更新（未传字段保持原值） ──

  private async handleUpdate(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = requireNoteId(args.noteId, 'noteId');

    const updateParams: UpdateNoteInput = {};
    if (args.title !== undefined) updateParams.title = args.title as string;
    const content = optionalString(args.content, 'content');
    if (content !== undefined) updateParams.content = plainTextToHtml(content);
    if (args.category !== undefined) updateParams.category = args.category as string;
    if (args.tags !== undefined) updateParams.tags = args.tags as string[];

    if (
      updateParams.title === undefined &&
      updateParams.content === undefined &&
      updateParams.category === undefined &&
      updateParams.tags === undefined
    ) {
      return noteToolFailure(
        TOOL_NAME,
        '更新笔记',
        '参数错误',
        '未提供任何要更新的字段',
        'title / content / category / tags 至少传一个；只想改名传 title，只想改正文传 content',
      );
    }

    const updatedNote = await notesDB.updateNote(noteId, updateParams);
    if (!updatedNote) {
      return noteNotFound(TOOL_NAME, '更新笔记', noteId);
    }
    this.notifyChange('update', noteId);
    this.logStep(`笔记更新成功: ${Object.keys(updateParams).join(', ')}`);

    return noteToolSuccess(
      `笔记「${updatedNote.title}」已更新（字段: ${Object.keys(updateParams).join(', ')}）。`,
      { action: 'update', noteId, title: updatedNote.title },
    );
  }

  // ── get：读取完整纯文本（图片占位，base64 绝不进上下文） ──

  private async handleGet(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = requireNoteId(args.noteId, 'noteId');
    const text = await notesDB.getNoteText(noteId);
    if (text === null) {
      return noteNotFound(TOOL_NAME, '获取笔记内容', noteId);
    }
    return noteToolSuccess(text, { action: 'get', noteId });
  }

  // ── list：按关键词列出笔记（找回 noteId 的正当途径） ──

  private async handleList(args: Record<string, unknown>): Promise<ToolResult> {
    const keyword = optionalString(args.keyword, 'keyword')?.trim() ?? '';
    const rawLimit = typeof args.limit === 'number' && Number.isFinite(args.limit) ? args.limit : LIST_DEFAULT_LIMIT;
    const limit = Math.min(Math.max(Math.floor(rawLimit), 1), LIST_MAX_LIMIT);

    // 列表全量取回后在内存过滤（存储层无文本索引；笔记量级为数百，可接受）
    const all = await notesDB.listNotes(500, 0);
    const lowerKeyword = keyword.toLowerCase();
    const matched = (
      keyword
        ? all.filter(
            note =>
              note.title.toLowerCase().includes(lowerKeyword) ||
              (note.text ?? '').toLowerCase().includes(lowerKeyword),
          )
        : all
    ).slice(0, limit);

    if (matched.length === 0) {
      return noteToolSuccess(
        keyword ? `没有匹配「${keyword}」的笔记。可用 action=create 新建。` : '当前没有任何笔记。可用 action=create 新建。',
        { action: 'list', keyword, count: 0, notes: [] },
      );
    }

    const lines = matched.map(
      (note, index) =>
        `${index + 1}. ${note.title || '（无标题）'}\n   Note ID: ${note.id}（更新于 ${new Date(note.updatedAt).toLocaleString()}）\n   预览: ${(note.text ?? '').replace(/\s+/g, ' ').slice(0, LIST_PREVIEW_MAX_CHARS)}`,
    );
    return noteToolSuccess(
      `${keyword ? `匹配「${keyword}」的笔记 ${matched.length} 条：` : `最近 ${matched.length} 条笔记：`}\n\n${lines.join('\n')}\n\n完整内容用 action=get + noteId 读取。`,
      {
        action: 'list',
        keyword,
        count: matched.length,
        notes: matched.map(note => ({ noteId: note.id, title: note.title })),
      },
    );
  }

  // ── delete：删除（先校验存在，给精确错误而非静默成功） ──

  private async handleDelete(args: Record<string, unknown>): Promise<ToolResult> {
    const noteId = requireNoteId(args.noteId, 'noteId');
    const existing = await notesDB.getNote(noteId);
    if (!existing) {
      return noteNotFound(TOOL_NAME, '删除笔记', noteId);
    }
    await notesDB.deleteNote(noteId);
    this.notifyChange('delete', noteId);
    this.logStep(`笔记已删除: ${noteId}`);

    return noteToolSuccess(
      `笔记「${existing.title}」已删除。`,
      { action: 'delete', noteId, title: existing.title },
    );
  }
}

// 导出工具实例
export const noteTool = new NoteTool();
