/**
 * 文档模型 → Markdown（.md 导出）
 *
 * 覆盖 Tiptap StarterKit 全部节点：1-6 级标题、段落、有序 / 无序列表（含嵌套）、
 * 引用、代码块（围栏）、分割线、图片、链接，以及加粗 / 斜体 / 删除线 /
 * 行内代码 / 硬换行等行内标记。
 *
 * 转义策略：仅转义会改变 Markdown 结构的字符（\ ` * _ [ ] 与行首
 * ATX / 引用 / 列表前缀），普通标点保持原样，保证导出结果可读。
 */

import type { BlockNode, InlineNode, ExportMarks } from './doc-model';

/** 结构敏感字符转义（逐行处理，避免误伤行中普通文本） */
function escapeText(text: string): string {
  return text
    .replace(/([\\`*_[\]])/g, '\\$1')
    .split('\n')
    .map((line) =>
      line
        // 行首 # / > / - / + 后跟空白：会被解析成标题 / 引用 / 列表
        .replace(/^([#>+-])(\s)/, '\\$1$2')
        // 行首「数字. 」会被解析成有序列表（仅转义点号，数字保持字面量）
        .replace(/^(\d+)\.(?=\s)/, '$1\\.'),
    )
    .join('\n');
}

/** 行内代码围栏：内容含反引号时按最长连续段自动加长围栏 */
function wrapInlineCode(text: string): string {
  const longest = Math.max(0, ...Array.from(text.matchAll(/`+/g), (m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const padded = text.startsWith('`') || text.endsWith('`') ? ` ${text} ` : text;
  return `${fence}${padded}${fence}`;
}

function applyMarks(text: string, marks: ExportMarks): string {
  let out = text;
  if (marks.italic) out = `*${out}*`;
  if (marks.bold) out = `**${out}**`;
  if (marks.strike) out = `~~${out}~~`;
  return out;
}

function escapeLinkTarget(href: string): string {
  return href.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/ /g, '%20');
}

function inlineToMarkdown(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += applyMarks(escapeText(node.text), node.marks);
        break;
      case 'code':
        out += wrapInlineCode(node.text);
        break;
      case 'link': {
        const text = inlineToMarkdown(node.children);
        out += `[${text}](${escapeLinkTarget(node.href)})`;
        break;
      }
      case 'image':
        out += `![${escapeText(node.alt)}](${escapeLinkTarget(node.src)})`;
        break;
      case 'break':
        out += '  \n';
        break;
    }
  }
  return out;
}

function listToMarkdown(block: Extract<BlockNode, { type: 'list' }>, depth: number): string {
  const pad = '  '.repeat(depth);

  const itemToMarkdown = (item: BlockNode[], index: number): string => {
    const marker = block.ordered ? `${index + 1}. ` : '- ';
    const lines: string[] = [];
    let first = true;

    for (const child of item) {
      if (child.type === 'list') {
        // 嵌套列表：整体按 depth+1 缩进接续在当前项下
        lines.push(listToMarkdown(child, depth + 1));
        first = false;
        continue;
      }
      const text = blockToMarkdown(child, depth + 1).replace(/\n+$/, '');
      if (first) {
        lines.push(pad + marker + text);
        first = false;
      } else {
        // 后续块（段落 / 代码块等）：对齐到 marker 之后
        const continuation = pad + ' '.repeat(marker.length);
        lines.push(
          text
            .split('\n')
            .map((line) => (line ? continuation + line : ''))
            .join('\n'),
        );
      }
    }

    return lines.join('\n') || `${pad}${marker.trimEnd()}`;
  };

  return block.items.map((item, index) => itemToMarkdown(item, index)).join('\n');
}

function blockToMarkdown(block: BlockNode, depth: number): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(block.level, 1), 6))} ${inlineToMarkdown(block.children)}`;
    case 'paragraph':
      return inlineToMarkdown(block.children);
    case 'list':
      return listToMarkdown(block, depth);
    case 'blockquote':
      return block.children
        .map((child) => blockToMarkdown(child, depth))
        .filter((text) => text.trim())
        .join('\n\n')
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    case 'codeBlock':
      return `\`\`\`\n${block.code}\n\`\`\``;
    case 'image':
      return `![${escapeText(block.alt)}](${escapeLinkTarget(block.src)})`;
    case 'hr':
      return '---';
  }
}

/** 文档模型 → Markdown 内容（不含末尾换行） */
export function docToMarkdown(blocks: BlockNode[]): string {
  return blocks
    .map((block) => blockToMarkdown(block, 0))
    .filter((text) => text.trim())
    .join('\n\n');
}
