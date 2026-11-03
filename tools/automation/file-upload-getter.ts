import { BaseTool } from '../base-tool';
import { ToolResult } from '@/common/tool-handler';
import { ToolMetadata } from '../registry';
import { OpenAITool } from '@/common/openai-types';

// 文件上传框元素接口
interface FileUploadElement {
  type: 'file-input' | 'dropzone' | 'upload-button';
  description: string;
  selector: string;
  targetSelector: string; // 真正用于上传的 input 选择器
  isInteractive: boolean;
  accept: string; // 接受的文件类型
  multiple: boolean; // 是否支持多文件
  frameId: number;
  score?: number;
}

// 缓存接口
interface CachedUploadElements {
  url: string;
  timestamp: number;
  elements: FileUploadElement[];
}

/**
 * 荷载函数：检测页面中的文件上传控件
 */
function getFileUploadElementsPayload(): Array<Omit<FileUploadElement, 'frameId'> & {
  isVisible: boolean;
  isInViewport: boolean;
  rect: { top: number; left: number; width: number; height: number };
  hasLabel: boolean;
}> {
  class FileUploadAnalyzer {
    getUniqueSelector(el: Element): string {
      if (!el || !(el instanceof Element)) return '';
      const doc = el.ownerDocument;
      
      if (el.id) {
        const simpleIdRegex = /^[A-Za-z_-][A-Za-z0-9_-]*$/;
        if (simpleIdRegex.test(el.id)) {
          const selector = `#${el.id}`;
          try {
            if (doc.querySelectorAll(selector).length === 1) return selector;
          } catch (e) {
            // 选择器在当前文档非法时忽略，继续走路径回退策略
            void e;
          }
        }
      }
      
      const path: string[] = [];
      let currentEl: Element | null = el;
      while (currentEl && currentEl.nodeType === Node.ELEMENT_NODE && currentEl.tagName.toLowerCase() !== 'html') {
        let selector = currentEl.tagName.toLowerCase();
        const parent = currentEl.parentElement;
        if (parent) {
          const siblings = Array.from(parent.children);
          const sameTagSiblings = siblings.filter(sibling => sibling.tagName === currentEl!.tagName);
          if (sameTagSiblings.length > 1) {
            const index = sameTagSiblings.indexOf(currentEl) + 1;
            selector += `:nth-of-type(${index})`;
          }
        }
        path.unshift(selector);
        try {
          if (doc.querySelectorAll(path.join(' > ')).length === 1) return path.join(' > ');
        } catch (e) {
          // 部分构建中的选择器可能非法，忽略后继续向上扩展路径
          void e;
        }
        currentEl = currentEl.parentElement;
      }
      return path.join(' > ');
    }

    isInViewport(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      return (rect.top < window.innerHeight && rect.bottom > 0 && rect.left < window.innerWidth && rect.right > 0);
    }

    isVisible(el: Element): boolean {
      if (!el || !(el instanceof Element) || !document.body || !document.body.contains(el)) return false;
      const style = getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || parseFloat(style.opacity) < 0.1) return false;
      const rect = el.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return false;
      return true;
    }

    getDescription(el: Element, type: string): string {
      const parts: string[] = [];
      const seen = new Set<string>();
      const normalize = (text: string) => text.replace(/\s+/g, ' ').trim();
      const pushUnique = (text?: string, prefix?: string) => {
        if (!text) return;
        const cleaned = normalize(text);
        if (!cleaned || cleaned.length < 2) return;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
        if (prefix) parts.push(`[${prefix}: ${cleaned}]`);
        else parts.push(cleaned);
      };

      const getTextById = (id: string) => document.getElementById(id)?.textContent?.trim() || '';

      // 1. aria-label（优先级最高）
      pushUnique(el.getAttribute('aria-label') || '');

      // 2. aria-labelledby（可能是多个 ID）
      const ariaLabelledby = el.getAttribute('aria-labelledby') || '';
      if (ariaLabelledby) {
        const ids = ariaLabelledby.split(/\s+/).filter(Boolean);
        for (const id of ids) pushUnique(getTextById(id));
      }

      // 3. 关联的 label 标签（for / 包裹）
      if (el.id) {
        const label = document.querySelector(`label[for="${el.id}"]`);
        if (label) pushUnique(label.textContent || '');
      }
      const wrappedLabel = el.closest('label');
      if (wrappedLabel) pushUnique(wrappedLabel.textContent || '');

      // 4. input/button 常见文本来源
      if (el instanceof HTMLInputElement) {
        pushUnique(el.value || '');
        pushUnique(el.getAttribute('name') || '', '名称');
      }
      if (el instanceof HTMLButtonElement) {
        pushUnique(el.value || '');
      }

      // 5. aria-describedby（描述性文本）
      const ariaDescribedby = el.getAttribute('aria-describedby') || '';
      if (ariaDescribedby) {
        const ids = ariaDescribedby.split(/\s+/).filter(Boolean);
        for (const id of ids) pushUnique(getTextById(id), '描述');
      }

      // 6. 图标/图片替代文本（icon-only 按钮场景）
      const imgAlt = el.querySelector('img[alt]')?.getAttribute('alt') || '';
      pushUnique(imgAlt);
      const svgTitle = el.querySelector('svg title')?.textContent || '';
      const svgDesc = el.querySelector('svg desc')?.textContent || '';
      pushUnique(svgTitle);
      pushUnique(svgDesc);

      // 7. 向左查找（Look Left）- 前一个兄弟节点中的 label 或文本
      let prevSibling = el.previousElementSibling;
      let lookLeftDepth = 0;
      while (prevSibling && lookLeftDepth < 3) {
        if (prevSibling.tagName === 'LABEL' || prevSibling.classList.contains('label')) {
          const text = prevSibling.textContent?.trim() || '';
          if (text && text.length < 100) {
            pushUnique(text, '左侧标签');
            break;
          }
        }
        prevSibling = prevSibling.previousElementSibling;
        lookLeftDepth++;
      }

      // 8. 向右查找（Look Right）- 后一个兄弟节点中的 label 或文本
      let nextSibling = el.nextElementSibling;
      let lookRightDepth = 0;
      while (nextSibling && lookRightDepth < 2) {
        if (nextSibling.tagName === 'LABEL' || nextSibling.classList.contains('label')) {
          const text = nextSibling.textContent?.trim() || '';
          if (text && text.length < 100) {
            pushUnique(text, '右侧标签');
            break;
          }
        }
        nextSibling = nextSibling.nextElementSibling;
        lookRightDepth++;
      }

      // 9. 向上查找最近的 Heading (Look Up)
      let current: Element | null = el;
      let lookUpDepth = 0;
      while (current && lookUpDepth < 10) {
        if (/^H[1-6]$/i.test(current.tagName)) {
          const headingText = current.textContent?.trim() || '';
          if (headingText && headingText.length < 100) {
            pushUnique(headingText, '标题');
            break;
          }
        }
        // 同时检查父级容器的 heading
        const heading = current.querySelector('h1, h2, h3, h4, h5, h6');
        if (heading) {
          const headingText = heading.textContent?.trim() || '';
          if (headingText && headingText.length < 100) {
            pushUnique(headingText, '标题');
            break;
          }
        }
        current = current.parentElement;
        lookUpDepth++;
      }

      // 10. 元素自身文本（如果简短且有意义）
      const selfText = el.textContent?.trim() || '';
      if (selfText && selfText.length > 0 && selfText.length < 60) {
        pushUnique(selfText);
      }

      // 11. fieldset/legend 上下文
      const fieldset = el.closest('fieldset');
      const legend = fieldset?.querySelector('legend');
      if (legend) pushUnique(legend.textContent || '', '分组');

      // 12. 父元素上下文（Text Analysis）
      if (parts.length === 0 || (parts.length === 1 && parts[0].length < 10)) {
        let parent = el.parentElement;
        let depth = 0;
        while (parent && depth < 3) {
          const parentText = Array.from(parent.childNodes)
            .filter(node => node.nodeType === Node.TEXT_NODE)
            .map(node => node.textContent?.trim())
            .filter(text => text && text.length > 0)
            .join(' ')
            .trim();
          
          if (parentText && parentText.length < 120) {
            pushUnique(parentText, '父级');
            break;
          }
          parent = parent.parentElement;
          depth++;
        }
      }

      // 13. placeholder
      pushUnique(el.getAttribute('placeholder') || '', '提示');

      // 14. title 属性
      const title = el.getAttribute('title') || '';
      if (title && title.length < 100) pushUnique(title, '标题');

      // 15. data-* 常见语义字段
      if ((el as HTMLElement).dataset) {
        const data = (el as HTMLElement).dataset as DOMStringMap;
        const dataKeys = ['label', 'title', 'name', 'placeholder', 'tooltip', 'tip', 'hint', 'desc', 'description', 'content', 'text', 'message', 'info'];
        for (const key of dataKeys) {
          if (data[key]) pushUnique(String(data[key]), `data-${key}`);
        }
      }

      // 16. 覆盖提示 (Tooltip) - 多种来源
      // 16.1 查找关联的 tooltip 元素（通过 aria-describedby 已处理，这里查找其他方式）
      const tooltipSelectors = [
        '[role="tooltip"]',
        '.tooltip',
        '.tip',
        '.hint',
        '.popover',
        '[class*="tooltip"]',
        '[class*="tip-content"]',
        '[class*="hint-text"]'
      ];
      
      // 16.2 检查元素的 data-*-target 或 data-*-for 指向的 tooltip
      const tooltipTargetAttrs = ['data-tooltip-target', 'data-tip-target', 'data-for', 'data-target', 'aria-controls'];
      for (const attr of tooltipTargetAttrs) {
        const targetId = el.getAttribute(attr);
        if (targetId) {
          const tooltipEl = document.getElementById(targetId);
          if (tooltipEl) {
            const tooltipText = tooltipEl.textContent?.trim() || '';
            if (tooltipText && tooltipText.length < 150) {
              pushUnique(tooltipText, '提示');
            }
          }
        }
      }

      // 16.3 查找紧邻的 tooltip 元素（通常是下一个兄弟或父级下的 tooltip）
      const findNearbyTooltip = (element: Element): string | null => {
        // 检查下一个兄弟
        let sibling = element.nextElementSibling;
        for (let i = 0; i < 3 && sibling; i++) {
          for (const sel of tooltipSelectors) {
            if (sibling.matches(sel)) {
              return sibling.textContent?.trim() || null;
            }
            const nested = sibling.querySelector(sel);
            if (nested) {
              return nested.textContent?.trim() || null;
            }
          }
          sibling = sibling.nextElementSibling;
        }
        
        // 检查父级容器内的 tooltip
        let parent = element.parentElement;
        for (let depth = 0; depth < 3 && parent; depth++) {
          for (const sel of tooltipSelectors) {
            const tooltip = parent.querySelector(sel);
            if (tooltip && tooltip !== element && !element.contains(tooltip)) {
              return tooltip.textContent?.trim() || null;
            }
          }
          parent = parent.parentElement;
        }
        
        return null;
      };
      
      const nearbyTooltip = findNearbyTooltip(el);
      if (nearbyTooltip && nearbyTooltip.length < 150) {
        pushUnique(nearbyTooltip, '提示');
      }

      // 16.4 检查常见的 tooltip 属性（各种 UI 库的约定）
      const tooltipAttrs = [
        'data-tooltip',
        'data-tip',
        'data-hint',
        'data-original-title',  // Bootstrap
        'data-bs-title',        // Bootstrap 5
        'data-bs-content',      // Bootstrap 5 popover
        'data-tippy-content',   // Tippy.js
        'data-balloon',         // Balloon.css
        'data-microtip-content', // Microtip
        'title',                // 原生 title（已在上面处理，这里补充检查）
        'data-content',         // 通用
        'data-popup',
        'data-popper-content'
      ];
      
      for (const attr of tooltipAttrs) {
        const value = el.getAttribute(attr);
        if (value && value.length > 0 && value.length < 150) {
          pushUnique(value, '提示');
        }
      }

      // 16.5 检查伪元素 ::before/::after 的 content（通过 CSS 设置的提示）
      try {
        const beforeContent = getComputedStyle(el, '::before').content;
        const afterContent = getComputedStyle(el, '::after').content;
        
        const extractCSSContent = (content: string): string | null => {
          if (!content || content === 'none' || content === 'normal') return null;
          // 移除引号
          const cleaned = content.replace(/^["']|["']$/g, '').trim();
          if (cleaned && cleaned.length > 2 && cleaned.length < 100) {
            // 过滤掉纯图标字符（如 fontawesome）
            if (!/^[\ue000-\uf8ff\uf000-\uf0ff]+$/.test(cleaned)) {
              return cleaned;
            }
          }
          return null;
        };
        
        const beforeText = extractCSSContent(beforeContent);
        const afterText = extractCSSContent(afterContent);
        if (beforeText) pushUnique(beforeText, 'CSS提示');
        if (afterText) pushUnique(afterText, 'CSS提示');
      } catch (e) {
        // CSS 伪元素内容解析失败不影响其余提示信息收集
        void e;
      }

      // 17. accept 属性（文件类型提示）
      if (el instanceof HTMLInputElement && el.type === 'file') {
        const accept = el.getAttribute('accept') || '';
        if (accept) pushUnique(accept, '接受');
      }

      // 17. 基于属性关键词的语义兜底（避免“无描述”）
      if (parts.length === 0) {
        const attrText = [
          el.getAttribute('name') || '',
          el.getAttribute('id') || '',
          (el as HTMLElement).className || '',
          el.getAttribute('title') || '',
          el.getAttribute('aria-label') || ''
        ].join(' ').toLowerCase();

        const hintMap: Array<{ re: RegExp; label: string }> = [
          { re: /avatar|profile|head|portrait|头像|用户/, label: '头像上传' },
          { re: /image|img|photo|picture|图片/, label: '图片上传' },
          { re: /video|影片|视频/, label: '视频上传' },
          { re: /audio|music|sound|音频/, label: '音频上传' },
          { re: /pdf|doc|docx|ppt|xls|excel|word|文档/, label: '文档上传' },
          { re: /attach|attachment|附件/, label: '附件上传' },
          { re: /drag|drop|拖拽|拖放/, label: '拖拽上传' },
          { re: /upload|uploader|file|选择文件|上传|文件/, label: '文件上传' }
        ];
        for (const { re, label } of hintMap) {
          if (re.test(attrText)) {
            pushUnique(label);
            break;
          }
        }
      }

      // 18. 默认描述（最后兜底）
      if (parts.length === 0) {
        if (type === 'file-input') return 'File input (无描述)';
        else if (type === 'dropzone') return 'Drag and drop area (无描述)';
        else return 'Upload button (无描述)';
      }

      // 合并描述，限制总长度
      let description = parts.join(' | ');
      description = description.replace(/\s+/g, ' ').trim();
      if (description.length > 150) description = description.substring(0, 147) + '...';

      return description;
    }

    private queryDeep(root: Document | ShadowRoot, selector: string): Element[] {
      let results: Element[] = Array.from(root.querySelectorAll(selector));

      const walker = document.createTreeWalker(
        root as unknown as Node,
        NodeFilter.SHOW_ELEMENT,
        {
          acceptNode: (node: any) => (node && node.shadowRoot ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP)
        }
      );

      let node = walker.nextNode();
      while (node) {
        const shadowRoot = (node as Element).shadowRoot;
        if (shadowRoot) {
          results = results.concat(this.queryDeep(shadowRoot, selector));
        }
        node = walker.nextNode();
      }

      return results;
    }

    /**
     * 关键新增：查找与当前元素关联的隐藏 file input（扩大搜索半径）
     */
    private findRelatedFileInput(el: Element): HTMLInputElement | null {
      if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'file') {
        return el as HTMLInputElement;
      }

      // 1. label 关联
      const label = el.tagName === 'LABEL' ? el : el.closest('label');
      if (label) {
        const forId = label.getAttribute('for');
        if (forId) {
          const target = document.getElementById(forId);
          if (target && target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'file') {
            return target as HTMLInputElement;
          }
        }

        const nestedInput = label.querySelector('input[type="file"]');
        if (nestedInput) return nestedInput as HTMLInputElement;
      }

      // 2. 子元素
      const childInput = el.querySelector('input[type="file"]');
      if (childInput) return childInput as HTMLInputElement;

      // 3. 兄弟节点（前后）
      let sibling = el.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === 'INPUT' && (sibling as HTMLInputElement).type === 'file') {
          return sibling as HTMLInputElement;
        }
        sibling = sibling.previousElementSibling;
      }
      sibling = el.nextElementSibling;
      while (sibling) {
        if (sibling.tagName === 'INPUT' && (sibling as HTMLInputElement).type === 'file') {
          return sibling as HTMLInputElement;
        }
        sibling = sibling.nextElementSibling;
      }

      // 4. 父级容器
      const parent = el.parentElement;
      if (parent) {
        const parentInput = parent.querySelector('input[type="file"]');
        if (parentInput) return parentInput as HTMLInputElement;
      }

      // 5. **扩大搜索半径**：检查 body 尾部的隐藏 input（很多动态上传组件会这样做）
      // 通过事件绑定关联（检查 onclick、data-* 等）
      const checkBodyInputs = () => {
        // 获取元素的所有事件监听器信息（通过常见的 data 属性）
        const dataAttrs = Array.from(el.attributes)
          .filter(attr => attr.name.startsWith('data-'))
          .map(attr => attr.value);
        
        // 检查是否有 ID 引用
        for (const dataValue of dataAttrs) {
          if (dataValue && dataValue.startsWith('#')) {
            const target = document.querySelector(dataValue);
            if (target && target.tagName === 'INPUT' && (target as HTMLInputElement).type === 'file') {
              return target as HTMLInputElement;
            }
          }
        }
        
        // 在 body 直属子元素中查找隐藏的 input（最近添加的）
        const bodyInputs = Array.from(document.body.querySelectorAll('input[type="file"]')) as HTMLInputElement[];
        
        // 优先查找距离当前元素最近的、最近创建的隐藏 input
        const hiddenInputs = bodyInputs.filter(input => {
          const style = getComputedStyle(input);
          return style.display === 'none' || 
                 style.visibility === 'hidden' || 
                 parseFloat(style.opacity) < 0.1 ||
                 input.offsetParent === null;
        });
        
        // 返回最后添加的（通常是动态创建的）
        if (hiddenInputs.length > 0) {
          return hiddenInputs[hiddenInputs.length - 1];
        }
        
        return null;
      };
      
      // 检查元素是否有点击事件（通过 onclick 或常见的事件属性）
      const hasClickEvent = el.hasAttribute('onclick') || 
                           el.getAttribute('role') === 'button' ||
                           getComputedStyle(el as Element).cursor === 'pointer';
      
      if (hasClickEvent) {
        const bodyInput = checkBodyInputs();
        if (bodyInput) return bodyInput;
      }

      return null;
    }

    private hasUploadHint(el: Element): boolean {
      const aria = el.getAttribute('aria-label') || '';
      const title = el.getAttribute('title') || '';
      const text = (el.textContent || '').trim();
      const className = (el as HTMLElement).className || '';

      const datasetPairs: string[] = [];
      if ((el as HTMLElement).dataset) {
        const data = (el as HTMLElement).dataset as DOMStringMap;
        for (const key of Object.keys(data)) {
          datasetPairs.push(key);
          if (data[key]) datasetPairs.push(String(data[key]));
        }
      }

      const haystack = [aria, title, text, className, ...datasetPairs].join(' ').toLowerCase();
      return /upload|uploader|drop|drag|file|attach|attachment|browse|choose|select|选择文件|上传|拖拽|附件|浏览|添加文件|添加|导入|导出|拖放/.test(haystack);
    }
    
    /**
     * 严格验证非 input 元素（噪音过滤）
     */
    private isValidUploadElement(el: Element, type: 'dropzone' | 'upload-button'): boolean {
      // 如果是 input，直接通过
      if (el.tagName === 'INPUT') return true;
      
      // 非 input 元素必须满足以下条件之一：
      // 1. 有拖拽事件
      const hasDragEvents = el.hasAttribute('ondrop') || 
                           el.hasAttribute('ondragover') ||
                           el.hasAttribute('ondragenter');
      
      // 2. 内部包含 input[type=file]
      const hasInternalInput = !!el.querySelector('input[type="file"]');
      
      // 3. 是 label 且关联了 input
      const isLinkedLabel = el.tagName === 'LABEL' && (
        el.hasAttribute('for') || 
        !!el.querySelector('input[type="file"]')
      );
      
      // 4. 有明确的上传提示词
      const hasStrongHint = this.hasUploadHint(el);
      
      // 严格模式：必须至少满足一个硬性条件
      if (type === 'dropzone') {
        return hasDragEvents || hasInternalInput || (hasStrongHint && this.isVisible(el));
      }
      
      if (type === 'upload-button') {
        return isLinkedLabel || hasInternalInput || (hasStrongHint && this.isClickable(el));
      }
      
      return false;
    }

    private isClickable(el: Element): boolean {
      const tag = el.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'label') return true;
      if (tag === 'input') {
        const type = (el as HTMLInputElement).type;
        return ['button', 'submit', 'reset'].includes(type);
      }
      if (el.getAttribute('role') === 'button') return true;
      if (el.hasAttribute('onclick')) return true;
      const tabindex = el.getAttribute('tabindex');
      if (tabindex !== null && tabindex !== '-1') return true;
      const style = getComputedStyle(el as Element);
      return style.cursor === 'pointer';
    }

    private isFullScreenOverlay(el: Element): boolean {
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth || 0;
      const vh = window.innerHeight || 0;
      const style = getComputedStyle(el as Element);
      const coversViewport = rect.width >= vw * 0.9 && rect.height >= vh * 0.9;
      const positioned = ['fixed', 'absolute'].includes(style.position);
      return coversViewport && positioned;
    }

    private findProxyForInput(input: HTMLInputElement): { element: Element; type: 'dropzone' | 'upload-button' } | null {
      if (!input) return null;

      // label 关联
      const label = input.closest('label') || (input.id ? document.querySelector(`label[for="${input.id}"]`) : null);
      if (label) {
        return { element: label, type: 'upload-button' };
      }

      // 向上寻找可能的代理容器
      let current: Element | null = input.parentElement;
      let depth = 0;
      while (current && depth < 5) {
        if (this.hasUploadHint(current)) {
          const type = (current.className || '').toLowerCase().includes('drop') || current.hasAttribute('ondrop') || current.hasAttribute('ondragover')
            ? 'dropzone'
            : 'upload-button';
          return { element: current, type };
        }
        current = current.parentElement;
        depth += 1;
      }

      return null;
    }

    analyzeFileUploads() {
      const results = new Map<Element, any>();
      if (!document.body) return [];

      const processElement = (el: Element, type: 'file-input' | 'dropzone' | 'upload-button') => {
        if (results.has(el)) return;

        const relatedInput = this.findRelatedFileInput(el);
        const targetSelector = relatedInput ? this.getUniqueSelector(relatedInput) : this.getUniqueSelector(el);
        const sourceEl = relatedInput || el;

        const rect = el.getBoundingClientRect();
        const accept = sourceEl.getAttribute('accept') || '*/*';
        const multiple = sourceEl.hasAttribute('multiple');
        const visible = this.isVisible(el);
        const inViewport = this.isInViewport(el);
        const isInteractive = type === 'file-input' ? true : this.isClickable(el) || this.hasUploadHint(el);
        const hasLabel = !!(relatedInput && (document.querySelector(`label[for="${relatedInput.id}"]`) || relatedInput.closest('label')));

        results.set(el, {
          type,
          description: this.getDescription(el, type),
          selector: this.getUniqueSelector(el),
          targetSelector,
          isInteractive,
          accept,
          multiple,
          isVisible: visible,
          isInViewport: inViewport,
          rect: {
            top: rect.top,
            left: rect.left,
            width: rect.width,
            height: rect.height
          },
          hasLabel: !!hasLabel
        });
      };

      // 1. 查找所有 <input type="file"> 元素（含 Shadow DOM）
      const fileInputs = this.queryDeep(document, 'input[type="file"]');
      for (const input of Array.from(fileInputs)) {
        processElement(input, 'file-input');

        // 如果 input 不可见或很小，尝试推断其代理 UI 元素
        const rect = (input as HTMLElement).getBoundingClientRect();
        const isTiny = rect.width < 2 || rect.height < 2;
        if (!this.isVisible(input) || isTiny) {
          const proxy = this.findProxyForInput(input as HTMLInputElement);
          if (proxy) processElement(proxy.element, proxy.type);
        }
      }

      // 2. 查找可能的拖放区域
      // 通过常见的类名和属性识别
      const dropzoneSelectors = [
        '[class*="dropzone"]',
        '[class*="drop-zone"]',
        '[class*="file-drop"]',
        '[class*="upload-area"]',
        '[class*="drag-drop"]',
        '[class*="drag"]',
        '[class*="drop"]',
        '[class*="uploader"]',
        '[data-dropzone]',
        '[data-drop]',
        '[data-upload]',
        '[data-file]',
        '[data-testid*="upload"]',
        '[data-testid*="file"]',
        '[aria-label*="upload" i]',
        '[aria-label*="file" i]',
        '[title*="upload" i]',
        '[title*="file" i]',
        '[role="region"]',
        '[role="dialog"]',
        '[ondrop]',
        '[ondragover]',
        '[ondragenter]',
        '[ondragleave]'
      ];
      
      const potentialDropzones = this.queryDeep(document, dropzoneSelectors.join(', '));
      for (const zone of Array.from(potentialDropzones)) {
        if (results.has(zone)) continue;
        
        // 严格验证：必须通过 isValidUploadElement 检查
        if (!this.isValidUploadElement(zone, 'dropzone')) continue;
        
        // 可见优先，但允许隐藏的全屏拖拽层参与候选（降权排序）
        processElement(zone, 'dropzone');
      }

      // 3. 查找上传按钮（点击后触发文件选择）
      const uploadButtonSelectors = [
        '[class*="upload"]',
        '[class*="file-select"]',
        '[class*="choose-file"]',
        '[class*="file"]',
        '[class*="attach"]',
        '[data-upload]',
        '[data-file]',
        '[data-testid*="upload"]',
        '[data-testid*="file"]',
        '[aria-label*="upload" i]',
        '[aria-label*="file" i]',
        '[title*="upload" i]',
        '[title*="file" i]',
        'button:has(input[type="file"])',
        'label:has(input[type="file"])'
      ];
      
      const potentialButtons = this.queryDeep(document, uploadButtonSelectors.join(', '));
      for (const button of Array.from(potentialButtons)) {
        if (results.has(button)) continue;
        
        // 严格验证：必须通过 isValidUploadElement 检查
        if (button.tagName !== 'INPUT' && !this.isValidUploadElement(button, 'upload-button')) continue;
        
        processElement(button, 'upload-button');
      }

      // 4. 兜底：点击触发型上传按钮（即使无明确 class/selector）
      const clickableCandidates = this.queryDeep(
        document,
        'button, a, [role="button"], [tabindex], [onclick], input[type="button"], input[type="submit"], label'
      );
      for (const el of Array.from(clickableCandidates)) {
        if (results.has(el)) continue;
        if (!this.hasUploadHint(el)) continue;
        
        // 严格验证：必须通过 isValidUploadElement 检查
        if (el.tagName !== 'INPUT' && !this.isValidUploadElement(el, 'upload-button')) continue;
        
        processElement(el, 'upload-button');
      }

      return Array.from(results.values());
    }
  }

  try {
    const analyzer = new FileUploadAnalyzer();
    return analyzer.analyzeFileUploads();
  } catch (error) {
    console.error("Error during file upload analysis:", error);
    return [];
  }
}

/**
 * 文件上传框获取工具
 */
export class FileUploadGetterTool extends BaseTool {
  name = 'file_upload_getter';
  
  // 缓存
  private cache: CachedUploadElements | null = null;
  
  metadata: ToolMetadata = {
    name: 'file_upload_getter',
    description: '获取页面中所有的文件上传控件，包括文件输入框、拖放区域和上传按钮',
    category: 'automation',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['automation', 'upload', 'file', 'input', 'dropzone']
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'file_upload_getter',
      description: '获取页面中的文件上传控件，包括：1)标准文件输入框 2)拖放上传区域 3)点击上传按钮。支持分页查询和智能排序。',
      parameters: {
        type: 'object',
        properties: {
          page: {
            type: 'number',
            description: '页码，从1开始，每页返回20个元素',
            default: 1
          }
        },
        required: []
      }
    }
  };

  /**
   * 计算元素的优先级评分
   */
  private calculateScore(element: any): number {
    let score = 0;
    
    // 1. 可见性评分 (50分)
    if (element.isInViewport) score += 40;
    else if (element.isVisible) score += 20;
    else score -= 30;
    
    // 2. 类型评分 (35分)
    if (element.type === 'file-input') score += 35; // 标准输入框最优先
    else if (element.type === 'dropzone') score += 30;
    else if (element.type === 'upload-button') score += 25;
    
    // 3. 描述质量评分 (15分)
    if (element.description && element.description !== 'File input') {
      if (element.description.length >= 5) score += 12;
      else score += 6;
      if (element.selector && element.description !== element.selector) score += 3;
    }
    
    // 4. 标签关联评分 (5分)
    if (element.hasLabel) score += 5;

    // 4.1 可交互加权
    if (element.isInteractive) score += 10;

    // 5. 视面积与可操作性评分 (20分)
    const rect = element.rect || { width: 0, height: 0 };
    const area = Math.max(0, rect.width || 0) * Math.max(0, rect.height || 0);
    if (area >= 120000) score += 15; // 大区域更可能是拖拽区
    else if (area >= 20000) score += 10;
    else if (area >= 2000) score += 5;

    // 6. 无法解析真实 input 的降权
    if (element.type !== 'file-input' && element.targetSelector === element.selector) score -= 18;
    if (!element.isVisible) score -= 10;
    
    return score;
  }

  /**
   * 检查缓存是否有效
   */
  private async isCacheValid(tabId: number): Promise<boolean> {
    if (!this.cache) return false;
    
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab || tab.id !== tabId || tab.url !== this.cache.url) return false;
      
      // 缓存5分钟内有效
      const cacheAge = Date.now() - this.cache.timestamp;
      if (cacheAge > 5 * 60 * 1000) return false;
      
      return true;
    } catch {
      return false;
    }
  }

  async execute(args: { page?: number } = {}): Promise<ToolResult> {
    const startTime = Date.now();
    try {
      const page = args.page || 1;
      const pageSize = 20;

      this.log(`开始获取文件上传控件 (v1.0)...`);
      
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tabs[0] || !tabs[0].id) {
        return this.createErrorResponse('No active tab with ID found');
      }
      const tabId = tabs[0].id;
      const url = tabs[0].url || '';
      
      let allElements: FileUploadElement[] = [];
      
      // 尝试使用缓存
      const cacheValid = await this.isCacheValid(tabId);
      if (cacheValid && this.cache) {
        this.log('使用缓存数据...');
        allElements = this.cache.elements;
      } else {
        // 从页面获取数据
        this.log('从页面分析文件上传控件...');
        
        const injectionResults = await chrome.scripting.executeScript({
          target: { tabId, allFrames: true },
          func: getFileUploadElementsPayload,
        });

        const rawElements: any[] = [];
        for (const frameResult of injectionResults) {
          if (frameResult.result && frameResult.result.length > 0) {
            const elementsWithFrameId = frameResult.result.map((el: any) => ({
              ...el,
              frameId: frameResult.frameId,
            }));
            rawElements.push(...elementsWithFrameId);
          }
        }

        // 智能排序
        this.log('应用智能排序算法...');
        
        const scoredElements = rawElements.map(el => {
          const score = this.calculateScore(el);
          return {
            type: el.type,
            description: el.description,
            selector: el.selector,
            targetSelector: el.targetSelector || el.selector,
            isInteractive: !!el.isInteractive,
            accept: el.accept,
            multiple: el.multiple,
            frameId: el.frameId,
            score
          };
        });
        
        // 按评分降序排序
        scoredElements.sort((a, b) => (b.score || 0) - (a.score || 0));
        
        // 🎯 过滤噪音：移除评分为负的低质量结果
        const filteredElements = scoredElements.filter(el => (el.score || 0) >= 0);
        allElements = filteredElements;
        
        this.log(`排序完成，过滤后剩余 ${filteredElements.length}/${scoredElements.length} 个高质量元素`);
        
        // 保存到缓存
        this.cache = {
          url,
          timestamp: Date.now(),
          elements: allElements
        };
        this.log('结果已缓存');
      }

      // 分页处理
      const totalElements = allElements.length;
      const totalPages = Math.ceil(totalElements / pageSize);
      const startIndex = (page - 1) * pageSize;
      const pagedElements = allElements.slice(startIndex, startIndex + pageSize);

      const duration = Date.now() - startTime;
      this.log(`获取完成，共找到 ${totalElements} 个上传控件，返回第 ${page}/${totalPages} 页的 ${pagedElements.length} 个，耗时: ${duration}ms`);

      const responsePayload = {
        elements: pagedElements,
        totalElements,
        page,
        pageSize,
        totalPages,
        cached: cacheValid
      };
      
      return this.createSuccessResponse(
        responsePayload,
        `Successfully retrieved ${pagedElements.length} file upload elements for page ${page}/${totalPages} (total ${totalElements}).`
      );

    } catch (error) {
      const duration = Date.now() - startTime;
      this.log(`操作失败，耗时: ${duration}ms`, 'error');
      return this.createErrorResponse('获取文件上传控件失败', error);
    }
  }
}

// 导出工具实例
export const fileUploadGetterTool = new FileUploadGetterTool();
