/**
 * Tiptap 编辑器扩展配置（统一笔记正文 = Tiptap HTML）
 *
 * - StarterKit v3 已内置：段落/标题/列表/引用/行内代码/代码块/链接/撤销重做等；
 * - Image 开启 allowBase64（正文图片以内嵌 dataURL 持久化，随笔记存储不丢失），
 *   并启用原生缩放手柄；
 * - Placeholder 提供空文档占位提示。
 *
 * 编辑器即所见（实时渲染），无需独立预览模式。
 */

import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import type { AnyExtension } from '@tiptap/core';
import { t } from '@/utils/i18n';

export function createEditorExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3] },
      link: {
        // 链接点击由组件统一拦截并在新标签页打开（扩展页内直接跳转会丢失工作区）
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        protocols: ['http', 'https', 'mailto'],
        HTMLAttributes: { rel: 'noopener noreferrer' },
      },
    }),
    Image.configure({
      allowBase64: true,
      inline: false,
      resize: { enabled: true },
    }),
    Placeholder.configure({
      placeholder: () => t('notes.editorPlaceholder'),
    }),
  ];
}
