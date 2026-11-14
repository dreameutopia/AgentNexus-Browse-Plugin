import { WorkspaceOperationError } from '@/utils/shared/error-details';
import { WORKSPACE_EDIT_MAX_FILE_BYTES, WORKSPACE_FILE_CONTENT_MAX_CHARS } from './paths';

/** Deterministic text edits: exact by default; indentation matching is explicit, never fuzzy. */
export interface TextEdit {
    find: string;
    replace: string;
    replaceAll?: boolean;
    matchMode?: 'exact' | 'indentation';
}
function fail(message: string): never { throw new WorkspaceOperationError('INVALID_EDIT', message); }
export function parseTextEdits(raw: unknown): TextEdit[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 100) fail('edits 必须包含 1..100 项');
    return raw.map((value, index) => {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            Object.keys(value).some(key => !['find', 'replace', 'replaceAll', 'matchMode'].includes(key))) fail(`edits[${index}] 形态无效或含未知字段`);
        const edit = value as TextEdit;
        for (const field of ['find', 'replace'] as const) {
            const text = edit[field];
            if (typeof text !== 'string' || text.length > WORKSPACE_FILE_CONTENT_MAX_CHARS || text.includes('\0') || /[\uD800-\uDFFF]/u.test(text)) fail(`edits[${index}].${field} 必须是有界、无 NUL 的有效 Unicode 字符串`);
        }
        if (!edit.find || (edit.matchMode === 'indentation' && !edit.find.trim())) fail('find 必须包含可定位的原文');
        if (edit.replaceAll !== undefined && typeof edit.replaceAll !== 'boolean') fail('replaceAll 必须是布尔值');
        if (edit.matchMode !== undefined && edit.matchMode !== 'exact' && edit.matchMode !== 'indentation') fail('matchMode 必须是 exact 或 indentation');
        return { find: edit.find, replace: edit.replace, replaceAll: edit.replaceAll, matchMode: edit.matchMode };
    });
}
const commonIndent = (lines: string[]): string => {
    const nonempty = lines.filter(line => line.trim());
    if (!nonempty.length)
        return '';
    let prefix = /^[ \t]*/.exec(nonempty[0])![0];
    for (const line of nonempty)
        while (prefix && !line.startsWith(prefix))
            prefix = prefix.slice(0, -1);
    return prefix;
};
export function applyTextEdit(previous: string, edit: TextEdit): {
    text: string;
    replaced: number;
} {
    const { find, replace, replaceAll = false, matchMode = 'exact' } = edit;
    if (!find || (matchMode === 'indentation' && !find.trim()))
        fail('find 必须包含可定位的原文');
    const matches: {
        start: number;
        end: number;
        replacement: string;
    }[] = [];
    if (matchMode === 'exact') {
        const first = previous.indexOf(find);
        if (first >= 0) {
            const second = previous.indexOf(find, first + 1);
            if (!replaceAll && second >= 0)
                fail('find 命中多次，须补充上下文使其唯一；或使用 replaceAll=true');
            let count = 1;
            if (replaceAll) for (let at = previous.indexOf(find, first + find.length); at >= 0; at = previous.indexOf(find, at + find.length)) {
                count++;
                if (previous.length + count * (replace.length - find.length) > WORKSPACE_EDIT_MAX_FILE_BYTES) fail('编辑结果超过就地编辑上限');
            }
            if (previous.length + count * (replace.length - find.length) > WORKSPACE_EDIT_MAX_FILE_BYTES) fail('编辑结果超过就地编辑上限');
            return { text: replaceAll ? previous.replaceAll(find, () => replace) : previous.slice(0, first) + replace + previous.slice(first + find.length), replaced: replaceAll ? count : 1 };
        }
    }
    else {
        const lines = previous.split(/\r?\n/), pattern = find.split(/\r?\n/);
        const trailingNewline = /\r?\n$/.test(find);
        if (trailingNewline)
            pattern.pop();
        const needleIndent = commonIndent(pattern);
        const needle = pattern.map(line => line.trim() ? line.slice(needleIndent.length) : '');
        const anchor = needle.findIndex(line => line.length > 0);
        const eol = previous.includes('\r\n') ? '\r\n' : '\n';
        const replacementLines = replace.split(/\r?\n/), replacementIndent = commonIndent(replacementLines);
        const normalizedReplacement = replacementLines.map(value => value.trim() ? value.slice(replacementIndent.length) : '');
        let projectedLength = previous.length, comparisons = 0;
        const starts = [0];
        for (const match of previous.matchAll(/\r?\n/g))
            starts.push(match.index! + match[0].length);
        for (let line = 0; line <= lines.length - pattern.length; line++) {
            const anchorLine = lines[line + anchor];
            if (!anchorLine.endsWith(needle[anchor])) continue;
            const indent = anchorLine.slice(0, anchorLine.length - needle[anchor].length);
            if (!/^[ \t]*$/.test(indent)) continue;
            let matched = true;
            for (let index = 0; index < pattern.length; index++) {
                if (++comparisons > 8_000_000) fail('缩进匹配计算量过大，请缩小 find 或改用 exact');
                const value = lines[line + index];
                if (needle[index] ? value !== indent + needle[index] : !!value.trim()) { matched = false; break; }
            }
            if (!matched) continue;
            const start = starts[line], last = line + pattern.length - 1;
            if (trailingNewline && starts[last + 1] === undefined) continue;
            if (!replaceAll && matches.length) fail('find 命中多次，须补充上下文使其唯一；或使用 replaceAll=true');
            const replacement = replace === '' ? '' : normalizedReplacement.map(value => value ? indent + value : '').join(eol);
            const end = trailingNewline ? starts[last + 1] : starts[last] + lines[last].length;
            projectedLength += replacement.length - (end - start);
            if (projectedLength > WORKSPACE_EDIT_MAX_FILE_BYTES) fail('编辑结果超过就地编辑上限');
            if (matches.length >= 100000)
                fail('缩进匹配次数过多，请使用脚本处理');
            matches.push({ start, end, replacement });
            if (replaceAll) line = last;
        }
    }
    if (!matches.length) {
        if (matchMode === 'exact' && find.includes('\n') && !find.includes('\r\n') && previous.includes('\r\n'))
            fail('find 未命中：文件使用 CRLF，而 find 使用 LF。使用精确原文或显式 matchMode="indentation" 匹配完整行块');
        fail('find 未命中：find 必须与文件内容逐字符精确匹配；请先 read 核对原文、缩进、空白与换行；不自动进行模糊替换');
    }
    if (!replaceAll && matches.length !== 1)
        fail('find 命中多次，须补充上下文使其唯一；或使用 replaceAll=true');
    const projectedLength = matches.reduce((size, match) => size + match.replacement.length - (match.end - match.start), previous.length);
    if (projectedLength > WORKSPACE_EDIT_MAX_FILE_BYTES)
        fail('编辑结果超过就地编辑上限');
    const selected = replaceAll ? matches : matches.slice(0, 1);
    let cursor = 0, text = '';
    for (const match of selected) {
        text += previous.slice(cursor, match.start) + match.replacement;
        cursor = match.end;
    }
    return { text: text + previous.slice(cursor), replaced: selected.length };
}
