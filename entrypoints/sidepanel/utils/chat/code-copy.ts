/**
 * 复制按钮（document 级事件委托）
 *
 * 为什么不用内联 onclick：
 *   扩展页 CSP 为 `script-src 'self'`（不含 'unsafe-inline'），浏览器会直接
 *   拦截 HTML 属性里的内联事件处理器——写上去的 onclick 永远不会被触发。
 *   与 file-card 的下载委托同构，统一走事件委托，既符合 CSP 又避免重复绑定。
 *
 * 覆盖两类按钮（均由 markdown-renderer 输出）：
 *   1. 代码块复制：   <button class="code-copy-btn" data-copy-idle-label data-copy-done-label>
 *      内容取同一容器（.code-block-wrapper）内 <pre><code> 文本。
 *   2. API 错误卡片复制：<button class="api-error-copy-btn" …>
 *      内容按「分类 / 状态 / 摘要 / 原始响应」拼装为结构化报告——用户把它
 *      粘贴到 git issue 或反馈渠道时，无需二次整理即携带定位所需的全部信息。
 */

import { t } from '@/utils/i18n';

/** 复制成功后的提示恢复时长（毫秒） */
const FEEDBACK_DURATION_MS = 2000;

/** 从代码块容器中取出待复制的纯文本（兼容图表块 / 图表块的源码 pre） */
function extractCodeText(button: HTMLElement): string {
  const wrapper = button.closest('.code-block-wrapper');
  const code = wrapper?.querySelector('pre code');
  if (code) return code.textContent ?? '';
  // 图表块（Mermaid / PlantUML）：复制隐藏源码 pre 中的原始图表代码
  const diagram = button.closest('.diagram-block');
  if (diagram) return diagram.querySelector('.diagram-source code')?.textContent ?? '';
  // 数据图表块（ECharts）：复制隐藏源码 pre 中的原始 option JSON
  const chart = button.closest('.chart-block');
  return chart?.querySelector('.chart-source code')?.textContent ?? '';
}

/**
 * 从 API 错误卡片中拼装「可直接提交 issue」的错误报告。
 * 卡片 DOM 结构见 markdown-renderer 的 buildApiErrorCard：
 * 头部（title / badge / provider / model）+ 摘要 + 原始响应（pre.api-error-raw）。
 * 环境元信息（扩展版本 / 发生时间）一并携带：定位问题时「哪个版本、何时发生」
 * 与错误本体同等重要；密钥只存在于请求头，原始响应不含凭据，报告可安全外发。
 */
function extractApiErrorReport(button: HTMLElement): string {
  const card = button.closest('.api-error-card');
  if (!card) return '';
  const title = card.querySelector('.api-error-title')?.textContent?.trim() ?? '';
  const badge = card.querySelector('.api-error-badge')?.textContent?.trim() ?? '';
  const provider = card.querySelector('.api-error-provider')?.textContent?.trim() ?? '';
  const model = card.getAttribute('data-model')?.trim() ?? '';
  // 端点（多渠道定位「哪个地址出错」；构造期已脱敏，报告可安全外发）
  const url = card.querySelector('.api-error-url')?.textContent?.trim() ?? '';
  const occurredAt = card.getAttribute('data-occurred-at')?.trim() ?? '';
  const summary = card.querySelector('.api-error-summary')?.textContent?.trim() ?? '';
  const raw = card.querySelector('.api-error-raw')?.textContent?.trim() ?? '';

  const version =
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest
      ? chrome.runtime.getManifest().version
      : '';

  const lines: string[] = ['[AgentNexus API 错误报告]'];
  if (version) lines.push(`扩展版本: ${version}`);
  if (occurredAt) lines.push(`发生时间: ${occurredAt}`);
  if (title) lines.push(`状态: ${title}`);
  if (badge) lines.push(`分类: ${badge}`);
  if (provider) lines.push(`Provider: ${provider}`);
  if (model) lines.push(`Model: ${model}`);
  if (url) lines.push(`端点: ${url}`);
  if (summary) lines.push(`摘要: ${summary}`);
  if (raw) {
    lines.push('');
    lines.push('原始响应:');
    lines.push(raw);
  }
  return lines.join('\n');
}

/** 更新按钮文案与状态样式 */
function setButtonState(button: HTMLElement, label: string, copied: boolean): void {
  button.textContent = label;
  button.classList.toggle('copied', copied);
}

/** 执行复制并给出反馈（初始/完成文案优先取渲染器写入的 data-* 定格值） */
async function copyWithFeedback(button: HTMLElement, extractText: () => string): Promise<void> {
  const text = extractText();
  if (!text) return;

  // 初始文案在首次交互时定格（渲染器已写入 data-* 时以其为准），
  // 避免反馈文案回写时把「已复制」当成初始文案
  if (!button.dataset.copyIdleLabel) {
    button.dataset.copyIdleLabel = button.textContent?.trim() ?? '';
  }
  const idleLabel = button.dataset.copyIdleLabel || t('sidepanel.chat.copyLabel');
  const doneLabel = button.dataset.copyDoneLabel || t('sidepanel.chat.copiedLabel');

  try {
    await navigator.clipboard.writeText(text);
    setButtonState(button, doneLabel, true);
    window.setTimeout(() => {
      setButtonState(button, idleLabel, false);
    }, FEEDBACK_DURATION_MS);
  } catch (error) {
    console.warn('[CopyButton] 复制到剪贴板失败:', error);
  }
}

let handlerInstalled = false;

/** 安装 document 级复制委托（幂等；仅 DOM 上下文生效） */
export function installCodeCopyHandler(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;

  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const codeButton = target?.closest?.('.code-copy-btn') as HTMLElement | null;
    if (codeButton) {
      event.preventDefault();
      void copyWithFeedback(codeButton, () => extractCodeText(codeButton));
      return;
    }
    const errorButton = target?.closest?.('.api-error-copy-btn') as HTMLElement | null;
    if (errorButton) {
      event.preventDefault();
      void copyWithFeedback(errorButton, () => extractApiErrorReport(errorButton));
    }
  });
}
