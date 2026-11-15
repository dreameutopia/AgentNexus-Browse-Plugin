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
 * 4. **外部数据不可信**：alt 说明来自模型输出，用 textContent / title 赋值即转义，
 *    不拼进 HTML 字符串。
 * 5. **点击开看图层**：点击图片派发文档级事件（AGENT_IMAGE_OPEN_EVENT），
 *    由 Vue 宿主（ChatMessageList）挂载共享看图层 ImageViewer——侧边栏内
 *    遮罩层放大查看，缩放 / 在网页中打开 / 下载都由共享组件提供。
 *    事件委托到 document 级，符合扩展 CSP（无内联脚本）。
 *
 * ==================== 卡片形态 ====================
 *
 * 卡片只展示图片本身：底部不再重复短 id（"截图 6zxtjw14"）——那是存储层的
 * 技术凭据，不是给人看的信息。短 id 仍然保留在 data-agent-image-id 上，
 * 并作为下载文件名的一部分（screenshot-<短id>.png）继续发挥作用。
 * 图片的 alt（模型给出的画面说明）移到 title 悬浮提示上，信息不丢。
 */

import { t } from '@/utils/i18n';
import { imageStore } from '../../core/images/image-store';

/** 点击截图 → 请求宿主挂载看图层（文档级事件；detail 见 AgentImageOpenDetail） */
export const AGENT_IMAGE_OPEN_EVENT = 'agentnexus:agent-image-open';

/** 看图层请求载荷（DOM 渲染层 → Vue 宿主） */
export interface AgentImageOpenDetail {
  /** 内容哈希引用（下载取 MIME / 回读图片库用） */
  ref: string;
  /** object URL（展示与「在网页中打开」用） */
  url: string;
  /** 下载文件名主干 */
  name: string;
  /** 图片说明（模型给出的 alt） */
  alt: string;
}

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
  let ref: string | null = null;
  try {
    // 短 id → 内容哈希 → object URL：哈希一并留下（下载取 MIME / 回读用）
    ref = await imageStore.resolveShortId(id);
    url = ref ? await imageStore.getObjectUrl(ref) : null;
  } catch {
    url = null;
  }
  if (!url || !ref) {
    card.dataset.agentImageState = 'missing';
    const missing = document.createElement('span');
    missing.className = 'agent-image-missing';
    missing.textContent = t('sidepanel.chat.agentImageMissing');
    body.textContent = '';
    body.appendChild(missing);
    return;
  }
  const alt = card.dataset.agentImageAlt ?? '';
  const img = document.createElement('img');
  img.src = url;
  img.alt = alt;
  // 说明文字移到悬浮提示：卡片底部只留图片，不再显示短 id
  img.title = alt;
  img.loading = 'lazy';
  body.textContent = '';
  body.appendChild(img);
  card.dataset.agentImageRef = ref;
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
    // 直播跳过（带稳定区豁免，同 chart / diagram 渲染器）：活动尾部的卡片
    // 会被 token 重写重建；冻结段（[data-md-stable]）内的引用可立即解析
    if (card.closest('[data-streaming]') && !card.closest('[data-md-stable]')) continue;
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
    const card = img.closest<HTMLElement>('.agent-image-card');
    if (!card) return;
    const ref = card.dataset.agentImageRef;
    if (!ref) return;
    event.preventDefault();
    const detail: AgentImageOpenDetail = {
      ref,
      url: img.src,
      name: `screenshot-${card.dataset.agentImageId ?? ''}`,
      alt: img.alt ?? '',
    };
    document.dispatchEvent(new CustomEvent<AgentImageOpenDetail>(AGENT_IMAGE_OPEN_EVENT, { detail }));
  });
}
