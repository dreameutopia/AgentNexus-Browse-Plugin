import { chatDatabase } from '@/entrypoints/sidepanel/core/context/chat-database';
import { parseFrontmatter, updateSkillFrontmatter } from './frontmatter-parser';
import { isWorkspaceRelativePath } from '@/utils/python-workspace/paths';
import { decodeSkillText, encodeSkillBytes, isSkillResourcePath } from './skill-resources';
import { SKILL_IMPORT_MAX_FILES, SKILL_RESOURCE_MAX_FILE_BYTES, SKILL_RESOURCE_MAX_TOTAL_BYTES, SKILL_DESCRIPTION_MAX_CHARS, SKILL_BODY_MAX_CHARS, SKILL_NAME_PATTERN } from './skill-types';
export function composeSkillDocument(metadata: Record<string, unknown>, content: string, existingDocument?: string): string {
    const validText = (value: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value);
    const name = metadata.name, description = metadata.description;
    if (typeof name !== 'string' || !SKILL_NAME_PATTERN.test(name) || name.length > 64)
        throw new Error('name 必须是 1..64 位小写字母/数字/连字符的网站与精准操作名');
    if (typeof description !== 'string' || !description.trim() || description.length > SKILL_DESCRIPTION_MAX_CHARS || /[\r\n]/.test(description) || !validText(description))
        throw new Error('description 必须是非空单行场景描述，最多 1024 字符');
    if (!content.trim() || content.length > SKILL_BODY_MAX_CHARS || !validText(content))
        throw new Error('content 必须是非空正文，最多 ' + SKILL_BODY_MAX_CHARS + ' 字符');
    const quote = (value: string) => '"' + value.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    const lines = ['---', 'name: ' + name, 'description: ' + quote(description)];
    for (const key of ['compatibility', 'license', 'category'])
        if (metadata[key]) {
            if (typeof metadata[key] !== 'string' || (metadata[key] as string).length > 1024 || /[\r\n]/.test(metadata[key] as string) || !validText(metadata[key] as string))
                throw new Error(key + ' 必须是单行字符串');
            lines.push(key + ': ' + quote(metadata[key] as string));
        }
    for (const [key, field] of [['tags', 'tags'], ['allowed_tools', 'allowed-tools']])
        if (metadata[key] !== undefined) {
            if (!Array.isArray(metadata[key]) || (metadata[key] as unknown[]).length > 256 || !(metadata[key] as unknown[]).every(value => typeof value === 'string' && value.length <= 256 && !/[\r\n]/.test(value) && validText(value)))
                throw new Error(key + ' 必须是字符串数组');
            lines.push(field + ': ' + quote((metadata[key] as string[]).join(key === 'tags' ? ', ' : ' ')));
        }
    const document = [...lines, '---', '', content.replace(/^(?:\r?\n)+/, '')].join('\n');
    if (existingDocument === undefined) return document;
    const parsed = parseFrontmatter(document);
    return updateSkillFrontmatter(existingDocument, parsed.data, parsed.body);
}
export async function importWorkspaceSkillFiles(chatId: string, raw: unknown, current: {
    files: Record<string, string>;
    resourceBytes?: Record<string, string>;
}, remove: unknown, signal?: AbortSignal) {
    const files = { ...current.files }, resourceBytes = { ...current.resourceBytes };
    if (remove !== undefined && (!Array.isArray(remove) || remove.length > SKILL_IMPORT_MAX_FILES || !remove.every(path => typeof path === 'string' && path !== 'SKILL.md' && isSkillResourcePath(path))))
        throw new Error('remove_files 必须是技能内相对路径，不能移除 SKILL.md');
    for (const path of (remove ?? []) as string[]) {
        if (!Object.hasOwn(files, path) && !Object.hasOwn(resourceBytes, path))
            throw new Error('待删除资源不存在：' + path);
        delete files[path];
        delete resourceBytes[path];
    }
    if (raw === undefined)
        return { files, resourceBytes };
    if (!Array.isArray(raw) || raw.length > SKILL_IMPORT_MAX_FILES)
        throw new Error('files 必须是工作区文件列表，最多 256 项');
    if (!raw.length) return { files, resourceBytes };
    const snapshot = await chatDatabase.readWorkspace(chatId, signal), destinations = new Set<string>();
    const entries = new Map(snapshot?.entries.map(entry => [entry.path, entry]));
    const pending: { destination: string; blob: Blob }[] = [];
    let bytes = Object.values(files).reduce((total, content) => total + new Blob([content]).size, 0) + Object.values(resourceBytes).reduce((total, encoded) => total + encoded.length / 4 * 3 - (encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0), 0);
    for (const item of raw) {
        signal?.throwIfAborted();
        const spec = typeof item === 'string' ? { path: item } : item;
        if (!spec || typeof spec !== 'object' || Array.isArray(spec) || Object.keys(spec).some(key => !['path', 'destination', 'replace'].includes(key)) || typeof spec.path !== 'string' || !isWorkspaceRelativePath(spec.path))
            throw new Error('files[].path 必须是当前工作区的普通文件相对路径');
        const destination = spec.destination ?? 'resources/' + spec.path.slice(spec.path.lastIndexOf('/') + 1);
        if (typeof destination !== 'string' || !destination.startsWith('resources/') || !isSkillResourcePath(destination) || destinations.has(destination))
            throw new Error('资源目标须是互不重复的 resources/ 相对路径');
        if (spec.replace !== undefined && typeof spec.replace !== 'boolean')
            throw new Error('files[].replace 必须是布尔值');
        if ((Object.hasOwn(files, destination) || Object.hasOwn(resourceBytes, destination)) && spec.replace !== true)
            throw new Error('目标已存在；先 remove_files 或显式 replace=true：' + destination);
        const entry = entries.get(spec.path);
        if (!entry?.blob || entry.link)
            throw new Error('工作区文件不存在或为链接：' + spec.path);
        const oldSize = Object.hasOwn(files, destination) ? new Blob([files[destination]]).size : Object.hasOwn(resourceBytes, destination) ? resourceBytes[destination].length / 4 * 3 - (resourceBytes[destination].endsWith('==') ? 2 : resourceBytes[destination].endsWith('=') ? 1 : 0) : 0;
        bytes += entry.blob.size - oldSize;
        if (entry.blob.size > SKILL_RESOURCE_MAX_FILE_BYTES || bytes > SKILL_RESOURCE_MAX_TOTAL_BYTES)
            throw new Error('资源文件超过大小限制');
        pending.push({ destination, blob: entry.blob });
        destinations.add(destination);
    }
    const paths = new Set([...Object.keys(files), ...Object.keys(resourceBytes), ...destinations]);
    if (paths.size > SKILL_IMPORT_MAX_FILES) throw new Error('技能资源总数超限');
    for (const path of paths) for (let slash = path.lastIndexOf('/'); slash >= 0; slash = path.lastIndexOf('/', slash - 1)) {
        if (paths.has(path.slice(0, slash))) throw new Error('资源文件与目录冲突：' + path);
    }
    for (const { destination, blob } of pending) {
        signal?.throwIfAborted();
        const buffer = await blob.arrayBuffer();
        signal?.throwIfAborted();
        const text = decodeSkillText(new Uint8Array(buffer));
        delete files[destination];
        delete resourceBytes[destination];
        if (text === undefined)
            resourceBytes[destination] = encodeSkillBytes(buffer);
        else
            files[destination] = text;
    }
    if (Object.keys(files).length + Object.keys(resourceBytes).length > SKILL_IMPORT_MAX_FILES)
        throw new Error('技能资源总数超限');
    return { files, resourceBytes };
}
