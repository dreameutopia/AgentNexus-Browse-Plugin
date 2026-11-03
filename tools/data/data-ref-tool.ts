/**
 * 数据引用管理工具（data_ref_tool）
 *
 * 「脚本抓取 → 暂存 → 直接导出」通道的中间层：管理 browser_page_exec 写入
 * 数据暂存区的批次（saveResult=true，或全量 JSON 超 2000 字符自动暂存），让模型在不接触全量数据的前提下完成：
 *   - list  ：盘点当前所有批次（ID/标签/形态/行数/大小），规划合并与导出；
 *   - info  ：查看单个批次的字段结构与首行预览，设计 xlsx 的 fields/headers 映射；
 *   - merge ：把分页/分批抓取的多个批次按顺序拼接为一个（xlsx 一次导出）；
 *   - delete：清理批次（导出完成后或容量不足时）。
 *
 * 设计约束：任何 action 都不返回全量数据（json 永不出库）——数据只允许
 * 在暂存区与 xlsx_tool(create_from_data) 之间流转，彻底避免模型转抄造成的
 * 丢失/捏造/输错。
 */

import { BaseTool } from '../base-tool';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import {
  dataRefStore,
  type DataRefMeta,
} from '@/utils/data-ref-store';

/** 单次 merge 的批次上限（防止一次拼接过长拖垮存储） */
const MAX_MERGE_BATCHES = 50;

const ACTION_ENUM = ['list', 'info', 'merge', 'delete'] as const;

/** 元数据 → 一行可读摘要（list 输出用） */
function describeMeta(meta: DataRefMeta): string {
  const label = meta.label ? `「${meta.label}」` : '(无标签)';
  const shape =
    meta.kind === 'records'
      ? `对象数组 ${meta.rowCount ?? '?'} 行 × ${(meta.fields ?? []).length} 字段`
      : meta.kind === 'matrix'
        ? `二维数组 ${meta.rowCount ?? '?'} 行 × ${meta.cols ?? '?'} 列`
        : '单值(非表格数据)';
  const size = meta.bytes >= 1024 * 1024
    ? `${(meta.bytes / 1024 / 1024).toFixed(2)}MB`
    : `${(meta.bytes / 1024).toFixed(1)}KB`;
  const time = new Date(meta.createdAt).toLocaleString('zh-CN', { hour12: false });
  return `${meta.id} | ${label} | ${shape} | ${size} | ${time}`;
}

export class DataRefTool extends BaseTool {
  name = 'data_ref_tool';

  metadata: ToolMetadata = {
    name: 'data_ref_tool',
    description: '管理脚本抓取的批量数据暂存批次：盘点/查看字段结构/按序合并/清理，数据全程不进对话',
    category: 'data',
    version: '1.0.0',
    author: 'AgentNexus',
    displayName: '数据引用通道',
    tags: ['data', 'scrape', 'rpa', 'batch', 'xlsx'],
    permissions: ['storage'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'data_ref_tool',
      description:
        '管理批量抓取数据的暂存批次（dataRef，8 位 ID；由 browser_page_exec 产生——saveResult=true 或结果超 2000 字符自动暂存）。' +
        'action=list 列出全部批次的统计；action=info 查看单个批次的字段结构与首行预览（用于设计导出列映射）；' +
        'action=merge 把多个批次按给定顺序拼接成一个新批次（分页抓取后导出前必做）；' +
        'action=delete 清理批次。任何 action 都不会返回全量数据；' +
        '按字符分页读取数据片段用 browser_page_exec(readRef=该ID, offset, limit)（每页 ≤2000 字符）；导出请用 xlsx_tool(action="create_from_data")。',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: [...ACTION_ENUM], description: '操作类型：list=列出全部批次 / info=查看批次结构 / merge=按序合并批次 / delete=清理批次' },
          ref: { type: 'string', description: '目标批次 ID（info 必填；delete 可与 refs 二选一）' },
          refs: { type: 'array', description: '批次 ID 列表（merge 必填，按数据先后顺序排列；delete 可批量删除）', items: { type: 'string' } },
          label: { type: 'string', description: 'merge 生成新批次的语义标签（可选，如「全部商品-已合并」）' },
        },
        required: ['action'],
      },
    },
  };

  async execute(args: Record<string, unknown>): Promise<ToolResult> {
    const action = args?.action;
    if (typeof action !== 'string' || !ACTION_ENUM.includes(action as (typeof ACTION_ENUM)[number])) {
      return this.createErrorResponse(`action 必须是 ${ACTION_ENUM.join(' / ')}，实际收到 ${JSON.stringify(action ?? null)}`);
    }

    try {
      switch (action) {
        case 'list':
          return this.handleList();
        case 'info':
          return this.handleInfo(args.ref);
        case 'merge':
          return this.handleMerge(args.refs, args.label);
        case 'delete':
          return this.handleDelete(args.ref, args.refs);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`执行失败：${message}`, 'error');
      return this.createErrorResponse(message);
    }
    // 类型完备性兜底（switch 已穷尽 action 枚举）
    return this.createErrorResponse(`未知 action: ${String(action)}`);
  }

  /** list：全部批次的元数据盘点 */
  private async handleList(): Promise<ToolResult> {
    const metas = await dataRefStore.list();
    if (metas.length === 0) {
      return this.createSuccessResponse(
        { count: 0 },
        '暂存区为空。用 browser_page_exec 抓取数据（saveResult=true 或结果超 2000 字符自动暂存）后会自动生成批次。',
      );
    }
    const totalBytes = metas.reduce((sum, m) => sum + m.bytes, 0);
    const lines = metas.map(describeMeta).join('\n');
    return this.createSuccessResponse(
      { count: metas.length, totalBytes, refs: metas },
      `暂存区共 ${metas.length} 个批次（合计 ${(totalBytes / 1024 / 1024).toFixed(2)}MB）：\n${lines}\n` +
        '导出用 xlsx_tool(action="create_from_data")；分页批次导出前先 merge。',
    );
  }

  /** info：单批次字段结构 + 首行预览（不含全量数据） */
  private async handleInfo(ref: unknown): Promise<ToolResult> {
    if (typeof ref !== 'string' || !ref.trim()) {
      return this.createErrorResponse('info 需要提供 ref（批次 ID）');
    }
    const entry = await dataRefStore.get(ref.trim());
    if (!entry) {
      const existing = await dataRefStore.list();
      const hint = existing.length > 0
        ? `当前可用批次：\n${existing.map(describeMeta).join('\n')}`
        : '暂存区为空（数据可能已随浏览器会话过期，请重新抓取）。';
      return this.createErrorResponse(`引用 "${ref}" 不存在或已过期。${hint}`);
    }

    const { json: _json, ...meta } = entry;
    return this.createSuccessResponse(
      {
        ref: meta,
        fields: meta.fields ?? [],
        preview: meta.preview ?? null,
        guide:
          meta.kind === 'records'
            ? '这是对象数组数据：xlsx_tool(create_from_data) 可用 fields 指定导出列与顺序、headers 指定表头文案。'
            : meta.kind === 'matrix'
              ? '这是二维数组数据：xlsx_tool(create_from_data) 可用 headers 指定表头，或 firstRowAsHeader=true 把首行当表头。'
              : '该批次不是表格形态（单值），通常无法直接导出为工作表——请在抓取脚本中返回对象数组或二维数组。',
      },
      `批次 ${meta.id}${meta.label ? `「${meta.label}」` : ''}：${describeMeta(meta)}`,
    );
  }

  /** merge：按顺序拼接多个批次 */
  private async handleMerge(refs: unknown, label: unknown): Promise<ToolResult> {
    if (!Array.isArray(refs) || refs.length === 0) {
      return this.createErrorResponse('merge 需要提供 refs（批次 ID 数组，按数据先后顺序排列）');
    }
    if (refs.length > MAX_MERGE_BATCHES) {
      return this.createErrorResponse(`单次最多合并 ${MAX_MERGE_BATCHES} 个批次，实际收到 ${refs.length} 个——请分组合并`);
    }
    if (label !== undefined && label !== null && typeof label !== 'string') {
      return this.createErrorResponse(`label 必须是字符串，实际收到 ${Array.isArray(label) ? '数组' : typeof label}`);
    }

    const result = await dataRefStore.merge(refs as string[], typeof label === 'string' ? label : undefined);
    if (!result.ok) {
      return this.createErrorResponse(result.reason);
    }
    const meta = result.meta;
    const shape = meta.kind === 'records'
      ? `${meta.rowCount} 行 × ${(meta.fields ?? []).length} 字段`
      : `${meta.rowCount} 行 × ${meta.cols} 列`;
    return this.createSuccessResponse(
      { ref: meta },
      `✅ 合并完成：${refs.length} 个批次 → 新批次 ${meta.id}${meta.label ? `「${meta.label}」` : ''}（${shape}）。\n` +
        `可直接 xlsx_tool(action="create_from_data", sheets:[{name:..., dataRef:"${meta.id}"}]) 导出。`,
    );
  }

  /** delete：清理批次（单个/批量/全部） */
  private async handleDelete(ref: unknown, refs: unknown): Promise<ToolResult> {
    let ids: string[] | 'all';
    if (ref === 'all') {
      ids = 'all';
    } else if (Array.isArray(refs) && refs.length > 0) {
      if (refs.every(r => r === 'all')) ids = 'all';
      else if (refs.every(r => typeof r === 'string')) ids = refs as string[];
      else return this.createErrorResponse('refs 必须全部是字符串批次 ID');
    } else if (typeof ref === 'string' && ref.trim()) {
      ids = [ref.trim()];
    } else {
      return this.createErrorResponse('delete 需要提供 ref（单个批次 ID）、refs（批量）或 ref="all"（清空全部）');
    }

    const count = await dataRefStore.remove(ids);
    return this.createSuccessResponse(
      { deleted: count },
      count > 0 ? `已删除 ${count} 个批次。` : '没有匹配的批次被删除（ID 可能已过期）。',
    );
  }
}

export const dataRefTool = new DataRefTool();
