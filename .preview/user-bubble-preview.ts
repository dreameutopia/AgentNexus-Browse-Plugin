/**
 * 预览入口：用户消息气泡（超长自动收起 + 右下角复制按钮）
 *
 * 走生产代码路径（UserMessageBubble 组件 + 真实 CSS + 真实 Markdown 渲染），
 * 验证三件事：
 *   1. 超长正文自动收起到底部渐隐，折叠高度 = 行数上限 × 实测行高；
 *   2. 展开入口可点开全文（再点收回），底缘渐隐随之消失；
 *   3. 复制按钮常驻气泡右下角，短消息同样有。
 */
import { createApp, h } from 'vue';
import UserMessageBubble from '../entrypoints/sidepanel/components/chat/UserMessageBubble.vue';
import { setLocale } from '../utils/i18n/core';

setLocale('zh-CN');

const LONG_TEXT = [
  '请帮我分析一下这个页面的性能瓶颈，重点关注首屏加载时间、图片资源体积，',
  '以及主线程的阻塞时长；如果有能立刻落地的优化项，请按投入产出排序给出。',
  '另外说明一下，这次不用改代码，只要结论和依据就行。',
].join('');

const CASES = [
  { id: 'short', content: '帮我看看这个页面' },
  { id: 'long', content: LONG_TEXT },
  {
    id: 'markdown',
    content: `**分析要点**\n\n${LONG_TEXT}\n\n- 首屏：统计关键资源体积\n- 主线程：定位长任务\n\n\`\`\`js\nconst metrics = performance.getEntriesByType('navigation');\n\`\`\``,
  },
];

const mountPoint = document.getElementById('user-bubble-host');
if (mountPoint) {
  const app = createApp({
    render: () =>
      h(
        'div',
        { class: 'messages-container' },
        CASES.map(item =>
          h('div', { class: 'message user', key: item.id }, [
            h('div', { class: 'message-wrapper' }, [
              h(UserMessageBubble, { content: item.content, messageId: item.id }),
            ]),
          ]),
        ),
      ),
  });
  app.mount(mountPoint);
  console.log('[user-bubble-preview] mounted');

  const params = new URLSearchParams(location.search);
  // ?expand=1：无头截图用——程序化点开全部气泡的展开入口，拍展开态。
  // 验证模式不做预展开：收起态断言必须在初始状态上读数
  if (params.get('expand') === '1') {
    setTimeout(() => {
      mountPoint.querySelectorAll<HTMLElement>('.user-bubble-expand').forEach(el => el.click());
    }, 30);
    console.log('[user-bubble-preview] expanded');
  }

  // ?verify=1：无头 DOM 验证——对折叠高度、渐隐、展开交互、复制按钮位置
  // 做计算样式 / 几何断言并落成文本报告
  if (params.get('verify') === '1') {
    setTimeout(() => {
      const lines: string[] = [];
      const report = (name: string, pass: boolean, detail: string): void => {
        lines.push(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
      };

      const bubbles = [...mountPoint.querySelectorAll<HTMLElement>('.user-bubble')];
      report('渲染出用户消息气泡', bubbles.length === CASES.length, `count=${bubbles.length}`);

      const shortBubble = bubbles[0];
      // 短消息：不收起、无展开入口、复制按钮常驻
      if (shortBubble) {
        report('短消息不收起', !shortBubble.classList.contains('is-clamped'), `classes=${shortBubble.className}`);
        report('短消息无展开入口', shortBubble.querySelectorAll('.user-bubble-expand').length === 0, 'expand count=0');
        report('短消息有复制按钮', !!shortBubble.querySelector('.user-bubble-copy'), 'copy present');
      }

      // 超长消息：收起 + 折叠高度 = 行数上限 × 实测行高
      const longBubble = bubbles.find(b => b.classList.contains('is-clamped'));
      report('存在被收起的超长消息', !!longBubble, `clamped count=${bubbles.filter(b => b.classList.contains('is-clamped')).length}`);
      if (longBubble) {
        const clip = longBubble.querySelector<HTMLElement>('.user-bubble-clip');
        const text = longBubble.querySelector<HTMLElement>('.user-bubble-text .message-content');
        const clamp = clip ? Number.parseFloat(clip.style.maxHeight) : Number.NaN;
        const lineHeight = text ? Number.parseFloat(getComputedStyle(text).lineHeight) : Number.NaN;
        report('折叠高度写入', Number.isFinite(clamp) && clamp > 0, `max-height=${clip?.style.maxHeight}`);
        report(
          '折叠高度 = 6 行 × 实测行高',
          Number.isFinite(clamp) && Number.isFinite(lineHeight) && Math.abs(clamp - Math.ceil(lineHeight * 6)) <= 1,
          `clamp=${clamp} line-height=${lineHeight} 期望=${Math.ceil(lineHeight * 6)}`,
        );
        report('收起态有底缘渐隐', !!longBubble.querySelector('.user-bubble-fade'), 'fade present');
        const expand = longBubble.querySelector<HTMLElement>('.user-bubble-expand');
        report('提供展开入口', !!expand, `label=${expand?.textContent?.trim()}`);
        // 展开入口贴在操作行左侧，复制按钮贴右下角
        const actions = longBubble.querySelector<HTMLElement>('.user-bubble-actions');
        const copy = longBubble.querySelector<HTMLElement>('.user-bubble-copy');
        if (actions && copy && expand) {
          const actionRect = actions.getBoundingClientRect();
          const copyRect = copy.getBoundingClientRect();
          const expandRect = expand.getBoundingClientRect();
          const rightInset = actionRect.right - copyRect.right;
          report('复制按钮贴操作行右缘', Math.abs(rightInset) <= 1, `right-inset=${rightInset.toFixed(1)}px`);
          report('展开入口在复制按钮左侧', expandRect.right <= copyRect.left + 1, `expand.right=${expandRect.right.toFixed(1)} copy.left=${copyRect.left.toFixed(1)}`);
        }
      }

      const finalize = (): void => {
        const pre = document.createElement('pre');
        pre.id = 'verify-output';
        pre.textContent = lines.join('\n');
        document.body.appendChild(pre);
        console.log('[user-bubble-preview] verify done');
      };

      // 展开态：点击后解除折叠、渐隐消失
      const target = bubbles.find(b => b.classList.contains('is-clamped'));
      const expandBtn = target?.querySelector<HTMLElement>('.user-bubble-expand');
      if (target && expandBtn) {
        expandBtn.click();
        setTimeout(() => {
          const clip = target.querySelector<HTMLElement>('.user-bubble-clip');
          report('点击后展开', target.classList.contains('is-expanded'), `classes=${target.className}`);
          report('展开态解除折叠高度', !clip?.style.maxHeight, `max-height=${clip?.style.maxHeight}`);
          report('展开态无渐隐', target.querySelectorAll('.user-bubble-fade').length === 0, 'fade count=0');
          report('展开态 aria-expanded', expandBtn.getAttribute('aria-expanded') === 'true', `aria=${expandBtn.getAttribute('aria-expanded')}`);
          finalize();
        }, 60);
      } else {
        finalize();
      }
    }, 80);
  }
} else {
  console.log('[user-bubble-preview] mount point missing');
}
