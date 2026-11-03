/**
 * 文档模型 → 纯文本（.txt 导出）
 *
 * 保留结构可读性（标题 # 前缀、列表 - / 序号、引用 > 前缀），
 * 但丢弃富文本标记（加粗 / 斜体等在纯文本里无意义）；
 * 链接展开为「文字 (地址)」，图片降级为占位说明。
 */

import type { BlockNode, InlineNode } from './doc-model';

function inlineToText(nodes: InlineNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
        out += node.text;
        break;
      case 'code':
        out += node.text;
        break;
      case 'link': {
        const text = inlineToText(node.children);
        out += node.href && node.href !== text ? `${text} (${node.href})` : text;
        break;
      }
      case 'image':
        out += node.alt ? `[图片: ${node.alt}]` : '[图片]';
        break;
      case 'break':
        out += '\n';
        break;
    }
  }
  return out;
}

function listToText(block: Extract<BlockNode, { type: 'list' }>, depth: number): string {
  const pad = '  '.repeat(depth);

  const itemToText = (item: BlockNode[], index: number): string => {
    const marker = block.ordered ? `${index + 1}. ` : '- ';
    const lines: string[] = [];
    let first = true;

    for (const child of item) {
      if (child.type === 'list') {
        // 嵌套列表：自身按 depth+1 缩进渲染，不再套外层 marker
        lines.push(listToText(child, depth + 1));
        first = false;
        continue;
      }
      const text = blockToText(child, depth + 1);
      if (first) {
        lines.push(pad + marker + text);
        first = false;
      } else {
        lines.push(pad + ' '.repeat(marker.length) + text);
      }
    }

    return lines.join('\n') || pad + marker.trimEnd();
  };

  return block.items.map((item, index) => itemToText(item, index)).join('\n');
}

function blockToText(block: BlockNode, depth: number): string {
  switch (block.type) {
    case 'heading':
      return `${'#'.repeat(Math.min(Math.max(block.level, 1), 6))} ${inlineToText(block.children)}`;
    case 'paragraph':
      return inlineToText(block.children);
    case 'list':
      return listToText(block, depth);
    case 'blockquote': {
      const inner = block.children
        .map((child) => blockToText(child, depth))
        .filter((text) => text.trim())
        .join('\n\n');
      return inner
        .split('\n')
        .map((line) => (line ? `> ${line}` : '>'))
        .join('\n');
    }
    case 'codeBlock':
      return block.code;
    case 'image':
      return block.alt ? `[图片: ${block.alt}]` : '[图片]';
    case 'hr':
      return '---';
  }
}

/** 文档模型 → 纯文本内容（不含末尾换行） */
export function docToPlainText(blocks: BlockNode[]): string {
  return blocks
    .map((block) => blockToText(block, 0))
    .filter((text) => text.trim())
    .join('\n\n');
}
