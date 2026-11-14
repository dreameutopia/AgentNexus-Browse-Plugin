import type { ToolResult } from '@/common/tool-handler';
import { createWorkspaceFile, editWorkspaceFile, deleteWorkspaceFile } from './workspace-files';
import { workspaceArtifact } from './artifact-contract';
import { isWorkspaceOutput } from './paths';
/** Shared schema additions and execution for both scripting tools. */
export const WORKSPACE_EDIT_PROPERTIES = {
    edits: { type: 'array', minItems: 1, maxItems: 100, description: '仅 edit：按序原子应用的替换操作；任一失败则整次不保存。与 content/find/replace 互斥。', items: { type: 'object', additionalProperties: false, required: ['find', 'replace'], properties: {
                find: { type: 'string', minLength: 1 }, replace: { type: 'string' }, replaceAll: { type: 'boolean' }, matchMode: { type: 'string', enum: ['exact', 'indentation'] },
            } } },
    matchMode: { type: 'string', enum: ['exact', 'indentation'], description: '仅 find/replace：默认 exact；indentation 显式按完整行块的相对缩进匹配，并保持目标缩进和换行。不进行模糊替换。' },
    expectedHash: { type: 'string', description: '仅 edit：read 返回的 sha256；文件已变化则拒绝保存，防止覆盖并发编辑。' },
} as const;
export async function executeWorkspaceFileAction(action: 'create' | 'edit' | 'delete', args: Record<string, unknown>, chatId: string, signal?: AbortSignal): Promise<ToolResult> {
    if (action === 'delete') {
        const stat = await deleteWorkspaceFile(chatId, args.path, signal);
        return { success: true, primary: 'content', content: [{ type: 'text', text: '已删除工作区文件 ' + stat.path }], data: { path: stat.path } };
    }
    const stat = action === 'create'
        ? await createWorkspaceFile(chatId, args.path, args.content, signal)
        : await editWorkspaceFile(chatId, args.path, args, signal);
    const file = isWorkspaceOutput(stat.path) ? { ...workspaceArtifact(stat.path), sizeBytes: stat.bytes } : undefined;
    const text = (action === 'create' ? '已创建工作区文件 ' : '已编辑工作区文件 ') + stat.path + '（' + stat.bytes + ' 字节）' +
        ('replaced' in stat && stat.replaced !== undefined ? (stat.replaced === 1 && args.replaceAll !== true && args.edits === undefined ? '，唯一命中替换 1 处' : '，替换 ' + stat.replaced + ' 处') : '') +
        (file ? '\n' + file.marker : '');
    return { success: true, primary: 'content', content: [{ type: 'text', text }], data: { ...stat, ...(file ? { file, files: [file] } : {}) } };
}
