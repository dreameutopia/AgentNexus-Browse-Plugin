/**
 * 回答内截图引用渲染器（agent-image）
 *
 * markdown-renderer.ts 只产出「截图引用卡片」骨架（短 id + 说明 + 空 body）；
 * 图片本体在 v-html 注入后由本模块异步还原——短 id → 图片库记录 →
 * object URL（图片库读取是异步的，渲染期无法同步完成）。
 *
 * ==================== 设计要点 ====================
 *
 * 1. **短 id 是唯一凭据**：回答里写的是 `<agent-image id="a1b2c3d4" />`，
 *    图片本体存在图片库里（与 vision loop 的自动截图同一处存储）。
 *    id 不存在（图片已被回收 / 模型编造）→ 显示「截图不可用」占位，
 *    绝不抛错、绝不显示破图。
 * 2. **状态机**：pending → loading → done | missing。扫描只捡 pending 的卡片，
 *    因此同一张卡片不会被重复解析；流式重写会重建 DOM（回到 pending），
 *    重新解析同样安全。
 * 3. **流式安全**：处于直播流中的消息（[data-streaming] 标记）跳过解析，
 *    流结束后由 ChatMessageList 的兜底扫描补上（同 diagram/chart 渲染器）。
 * 4. **外部数据不可信**：alt 说明来自模型输出，用 textContent 赋值即转义，
 *    不拼进 HTML 字符串。
 * 5. **事件委托**：点击图片在新标签页打开原图（侧边栏窄，放大更方便），
 *    走 document 级委托，符合扩展 CSP（无内联脚本）。
 */

import { t } from '@/utils/i18n';
import { imageStore } from '../../core/images/image-store';

/** 渲染单个截图引用卡片 */
async function renderAgentImage(card: HTMLElement): Promise<void> {
  const id = card.dataset.agentImageId;
  const body = card.querySelector<HTMLElement>('.agent-image-body');
  if (!id || !body) {
    card.dataset.agentImageState = 'error';
    return;
  }
  card.dataset.agentImageState = 'loading';
  let url: string | null = null;
  try {
    url = await imageStore.getObjectUrlByShortId(id);
  } catch {
    url = null;
  }
  if (!url) {
    card.dataset.agentImageState = 'missing';
    const missing = document.createElement('span');
    missing.className = 'agent-image-missing';
    missing.textContent = t('sidepanel.chat.agentImageMissing');
    body.textContent = '';
    body.appendChild(missing);
    return;
  }
  const img = document.createElement('img');
  img.src = url;
  img.alt = card.dataset.agentImageAlt ?? '';
  img.loading = 'lazy';
  const caption = document.createElement('div');
  caption.className = 'agent-image-caption';
  caption.textContent = t('sidepanel.chat.agentImageCaption', { id });
  body.textContent = '';
  body.appendChild(img);
  body.appendChild(caption);
  card.dataset.agentImageState = 'done';
}

/**
 * 扫描并还原容器内所有待处理的截图引用卡片（幂等；可安全地被高频调用）。
 * 直播流中的消息（[data-streaming]）会被跳过，等待流结束后的兜底扫描。
 */
export function processAgentImages(root: ParentNode): void {
  if (typeof document === 'undefined') return;
  const pending = root.querySelectorAll<HTMLElement>(
    '.agent-image-card[data-agent-image-state="pending"]',
  );
  for (const card of pending) {
    if (card.closest('[data-streaming]')) continue;
    // 同步前缀立即把状态推进到 loading，去抖期间再次扫描不会重复解析
    void renderAgentImage(card);
  }
}

let handlerInstalled = false;

/** 安装 document 级点击委托（幂等；仅 DOM 上下文生效） */
export function installAgentImageRenderer(): void {
  if (handlerInstalled || typeof document === 'undefined') return;
  handlerInstalled = true;
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null;
    const img = target?.closest?.('.agent-image-body img') as HTMLImageElement | null;
    if (!img?.src) return;
    // 用户手势触发的新标签页打开（侧边栏宽度有限，原图另开更便于查看）
    window.open(img.src, '_blank', 'noopener');
  });
}
