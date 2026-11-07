/**
 * 预览入口：消息折叠引导线（小折叠簇成员 / 大折叠前奏）
 *
 * 走生产代码路径（MessageItem 分组渲染 + MessageParts 小折叠 + 真实 CSS），
 * 验证两处展开态左侧的树状竖线：
 *   1. 大折叠（前奏收起条）展开 → 前奏内容整体一根首尾渐隐的连续竖线；
 *   2. 小折叠（连续过程簇收起条）展开 → 簇成员左侧连续竖线（首成员淡入、
 *      末成员淡出），嵌套在前奏内部时逐级右移构成层级树；
 *   3. 收起时线随内容一起消失；直播态条外最新活动恒可见且不带线。
 */
import { createApp, h } from 'vue';
import MessageItem from '../entrypoints/sidepanel/components/chat/MessageItem.vue';
import type { ExtendedChatMessage } from '../entrypoints/sidepanel/types/chat';
import { setLocale } from '../utils/i18n/core';

setLocale('zh-CN');

/** 结束态消息：推理/工具/中间文本/推理/工具 → 前奏，末段文本 → 正文 */
const finished: ExtendedChatMessage = {
  id: 'msg-finished',
  role: 'assistant',
  content: '已完成对页面结构的分析：主容器采用三栏布局，中部为内容流。',
  durationMs: 15200,
  parts: [
    { type: 'reasoning', content: '先分析页面结构：侧边栏是固定宽度，主区域随窗口伸缩，需要先定位主内容流的容器节点。', collapsed: true },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-1',
        name: 'web_search',
        status: 'success',
        arguments: '{"query":"页面结构分析"}',
        result: { summary: '命中 8 条结果' },
        executionTime: 1200,
      },
    },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-2',
        name: 'dom_explore',
        status: 'success',
        arguments: '{"selector":"main"}',
        result: { summary: '定位到主内容节点' },
        executionTime: 860,
      },
    },
    { type: 'image', imageRef: 'sha-preview-1' },
    { type: 'text', content: '继续检查内容流内部的卡片列表。' },
    { type: 'reasoning', content: '卡片列表是惰性渲染，滚动到视口外会卸载，截图前需要先滚动到底部；随后再核对页头的层级与主内容是否一致。', collapsed: false },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-3',
        name: 'read_file',
        status: 'error',
        arguments: '{"path":"a.txt"}',
        error: '文件不存在',
        executionTime: 120,
      },
    },
    { type: 'text', content: '已完成对页面结构的分析：主容器采用三栏布局，中部为内容流，卡片列表惰性渲染、滚动卸载。' },
  ],
  toolCalls: [],
};

/** 直播态消息：三个连续工具 → 小折叠条收拢前两项、最新一项条外可见 */
const live: ExtendedChatMessage = {
  id: 'msg-live',
  role: 'assistant',
  parts: [
    {
      type: 'tool',
      toolCall: {
        id: 'tc-4',
        name: 'web_search',
        status: 'success',
        arguments: '{"query":"任务队列"}',
        result: { summary: '命中 3 条结果' },
        executionTime: 940,
      },
    },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-5',
        name: 'dom_explore',
        status: 'success',
        arguments: '{"selector":"header"}',
        result: { summary: '定位到页头节点' },
        executionTime: 620,
      },
    },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-6',
        name: 'element_screenshot',
        status: 'pending',
        arguments: '{"selector":"header"}',
      },
    },
  ],
  toolCalls: [],
};

/** 直播态压缩消息：上下文压缩进行中（pending 旋转行）+ 已完成压缩行（收益可展开）*/
const liveCompaction: ExtendedChatMessage = {
  id: 'msg-live-compaction',
  role: 'assistant',
  content: '长任务进行中，继续执行。',
  parts: [
    { type: 'text', content: '收到，正在梳理页面结构。' },
    {
      type: 'compaction',
      compaction: {
        status: 'success',
        trigger: 'runtime',
        originalTokens: 147968,
        summaryTokens: 2560,
        durationMs: 8500,
        summary:
          '<summary>\n  <task>分析目标站点的页面结构与交互模式，沉淀为可复用技能。</task>\n  <constraints>只读操作；不得提交任何表单。</constraints>\n  <key-facts>主站 https://example.com；列表页为三栏布局。</key-facts>\n  <progress>已完成首页与列表页的结构探查。</progress>\n  <errors>无。</errors>\n  <pending>详情页结构探查。</pending>\n</summary>',
      },
    },
    { type: 'text', content: '压缩完成，继续执行。' },
    {
      type: 'compaction',
      compaction: { status: 'pending', trigger: 'runtime', originalTokens: 148480 },
    },
  ],
  toolCalls: [],
};

/** 结束态压缩消息：压缩 + 工具并入前奏折叠（摘要计数含压缩）*/
const finishedCompaction: ExtendedChatMessage = {
  id: 'msg-finished-compaction',
  role: 'assistant',
  content: '任务完成：结构分析报告已生成。',
  durationMs: 210000,
  parts: [
    {
      type: 'compaction',
      compaction: { status: 'success', trigger: 'pre-run', originalTokens: 51200, summaryTokens: 1024, durationMs: 4200, summary: '<summary>先前会话摘要…</summary>' },
    },
    {
      type: 'tool',
      toolCall: { id: 'tc-7', name: 'browser_get_page_text', status: 'success', arguments: '{}', result: { summary: '正文已提取' }, executionTime: 2100 },
    },
    {
      type: 'compaction',
      compaction: { status: 'error', trigger: 'runtime', error: '压缩请求失败: 连接超时（60s 空闲）', durationMs: 61000 },
    },
    { type: 'text', content: '任务完成：结构分析报告已生成。' },
  ],
  toolCalls: [],
};

const mountPoint = document.getElementById('collapse-host');
if (mountPoint) {
  const app = createApp({
    render: () => [
      h(MessageItem, { message: finished, isLive: false }),
      h(MessageItem, { message: live, isLive: true }),
      h(MessageItem, { message: liveCompaction, isLive: true }),
      h(MessageItem, { message: finishedCompaction, isLive: false }),
    ],
  });
  app.mount(mountPoint);
  console.log('[collapse-preview] mounted');

  // ?expand=1：无头截图用——挂载后程序化点开前奏、小折叠与截屏行，直接拍展开态。
  // 截屏行在簇成员内部，须等 Vue 刷新（微任务）后再点开
  const params = new URLSearchParams(location.search);
  if (params.get('expand') === '1' || params.get('verify') === '1') {
    for (const selector of ['.prelude-header', '.cluster-bar']) {
      mountPoint.querySelectorAll<HTMLElement>(selector).forEach(el => el.click());
    }
    setTimeout(() => {
      mountPoint.querySelectorAll<HTMLElement>('.screen-header').forEach(el => el.click());
    }, 30);
    console.log('[collapse-preview] expanded');
  }

  // ?verify=1：无头 DOM 验证——展开后对引导线做计算样式断言并落成文本报告。
  // 断言须等 Vue 响应式刷新（微任务）之后执行，读到的是展开后的真实 DOM
  if (params.get('verify') === '1') {
    setTimeout(() => {
    const lines: string[] = [];
    const report = (name: string, pass: boolean, detail: string): void => {
      lines.push(`${pass ? 'PASS' : 'FAIL'} | ${name} | ${detail}`);
    };
    const liveMsg = mountPoint.querySelectorAll('.message')[1] as HTMLElement | undefined;

    const preludeInner = mountPoint.querySelector<HTMLElement>('.prelude-inner');
    if (!preludeInner) {
      lines.push('FAIL | prelude-inner 存在 | 未找到（前奏未展开？）');
    } else {
      const cs = getComputedStyle(preludeInner, '::before');
      const grad = cs.backgroundImage;
      report('前奏引导线存在', cs.content !== 'none' && grad.includes('linear-gradient'), `content=${cs.content}; width=${cs.width}; bg=${grad.slice(0, 60)}…`);
      report('前奏引导线渐隐', grad.includes('rgba(148, 163, 184, 0)'), `首尾透明停靠: ${grad.includes('rgba(148, 163, 184, 0)')}`);

      const headerIcon = mountPoint.querySelector<HTMLElement>('.prelude-icon');
      const innerRect = preludeInner.getBoundingClientRect();
      if (headerIcon) {
        const iconCenter = headerIcon.getBoundingClientRect().left + headerIcon.getBoundingClientRect().width / 2;
        const lineCenter = innerRect.left + 1;
        report('前奏线对准收起条图标中心', Math.abs(iconCenter - lineCenter) <= 3, `icon=${iconCenter.toFixed(1)} line=${lineCenter.toFixed(1)}`);
      }
      report('前奏内容右移（padding 生效）', parseFloat(getComputedStyle(preludeInner).paddingLeft) >= 12, `padding-left=${getComputedStyle(preludeInner).paddingLeft}`);
    }

    const members = [...mountPoint.querySelectorAll<HTMLElement>('.cluster-member')];
    report('簇成员存在（小折叠展开）', members.length > 0, `count=${members.length}`);
    if (members.length > 0) {
      // 线存在：首个成员为渐变线（backgroundColor 恒透明），中间成员为实线
      const solid = members.length > 1 ? members[1] : members[0];
      const solidCs = getComputedStyle(solid, '::before');
      const first = getComputedStyle(members[0], '::before');
      const lineVisible =
        (solidCs.backgroundColor !== 'rgba(0, 0, 0, 0)' || solidCs.backgroundImage.includes('linear-gradient')) ||
        (first.backgroundColor !== 'rgba(0, 0, 0, 0)' || first.backgroundImage.includes('linear-gradient'));
      report('簇成员线存在', lineVisible, `solid bg=${solidCs.backgroundColor}; first bg=${first.backgroundColor}`);
      report('首成员线淡入', first.backgroundImage.includes('linear-gradient'), `bg=${first.backgroundImage.slice(0, 60)}…`);
      report('成员 flow-root（子边距收纳）', getComputedStyle(members[0]).display === 'flow-root', `display=${getComputedStyle(members[0]).display}`);

      const last = members[members.length - 1];
      const lastCs = getComputedStyle(last, '::before');
      report('末成员线淡出', lastCs.backgroundImage.includes('linear-gradient'), `bg=${lastCs.backgroundImage.slice(0, 60)}…`);

      // 连续性：DOM 上直接相邻的成员纵向贴叠（缝隙 = 0，线才不断）；
      // 不同簇之间隔着正文断片/收起条，不相邻不比对
      let flush = true;
      let gapDetail = '';
      let compared = 0;
      for (let i = 1; i < members.length; i++) {
        if (members[i - 1].nextElementSibling !== members[i]) continue;
        compared += 1;
        const prev = members[i - 1].getBoundingClientRect();
        const cur = members[i].getBoundingClientRect();
        const gap = cur.top - prev.bottom;
        if (Math.abs(gap) > 0.5) {
          flush = false;
          gapDetail = `member[${i - 1}]->[${i}] gap=${gap.toFixed(1)}px`;
        }
      }
      report('簇成员贴叠（线连续）', flush && compared > 0, gapDetail || `直接相邻成员 ${compared} 对全部缝隙 < 0.5px`);

      // 对齐：小折叠条图标中心 vs 线中心（取不在前奏内的直播消息成员，无嵌套偏移）
      const liveBarIcon = liveMsg?.querySelector<HTMLElement>('.cluster-icon');
      const liveMembers = liveMsg ? [...liveMsg.querySelectorAll<HTMLElement>('.cluster-member')] : [];
      if (liveBarIcon && liveMembers.length > 0) {
        const iconCenter = liveBarIcon.getBoundingClientRect().left + liveBarIcon.getBoundingClientRect().width / 2;
        const lineCenter = liveMembers[0].getBoundingClientRect().left + 1;
        report('簇线对准小折叠条图标中心', Math.abs(iconCenter - lineCenter) <= 3, `icon=${iconCenter.toFixed(1)} line=${lineCenter.toFixed(1)}`);
      }

      // 嵌套层级：前奏内部的簇线应比前奏线更靠右（层级树）
      const nested = members[0].getBoundingClientRect().left;
      const preludeLine = preludeInner ? preludeInner.getBoundingClientRect().left : -1;
      report('前奏内簇线逐级右移', nested > preludeLine + 5, `prelude=${preludeLine.toFixed(1)} nested=${nested.toFixed(1)}`);
    }

    // 推理行对齐工具行设计语言：紧凑行形态（无边框透明底、26px 行高、
    // 15px 图标槽、12px 标题、右组推右、chevron 展开旋转）
    const reasoningHeader = mountPoint.querySelector<HTMLElement>('.reasoning-header');
    if (reasoningHeader) {
      const hs = getComputedStyle(reasoningHeader);
      report('推理行是按钮（可聚焦）', reasoningHeader.tagName === 'BUTTON', `tag=${reasoningHeader.tagName}`);
      report('推理行无边框透明底', hs.borderTopWidth === '0px' && hs.backgroundColor === 'rgba(0, 0, 0, 0)', `border=${hs.borderTopWidth} bg=${hs.backgroundColor}`);
      report('推理行 26px 紧凑行高', hs.minHeight === '26px', `min-height=${hs.minHeight}`);
      report('推理行 6px 圆角（对齐工具行 hover 底）', hs.borderRadius === '6px', `radius=${hs.borderRadius}`);
      const rIcon = reasoningHeader.querySelector<HTMLElement>('.reasoning-icon');
      if (rIcon) {
        const is = getComputedStyle(rIcon);
        report('推理图标 15px 槽（对齐工具图标）', is.width === '15px', `width=${is.width}`);
      }
      const rTitle = reasoningHeader.querySelector<HTMLElement>('.reasoning-title');
      if (rTitle) {
        report('推理标题 12px（对齐工具名）', getComputedStyle(rTitle).fontSize === '12px', `font-size=${getComputedStyle(rTitle).fontSize}`);
      }
      const rRight = reasoningHeader.querySelector<HTMLElement>('.reasoning-right');
      if (rRight) {
        // margin-left:auto 的解析值随行内左侧内容宽度变化，跨行比较无意义；
        // 几何判定：右组贴住行右缘（差的 = 行右内边距 6px）
        const rowRect = reasoningHeader.getBoundingClientRect();
        const rightRect = rRight.getBoundingClientRect();
        const inset = rowRect.right - rightRect.right;
        report('推理右侧组贴行右缘（对齐 tool-right）', Math.abs(inset - 6) <= 1, `right-inset=${inset.toFixed(1)}px（期望 6px 行内边距）`);
      }
      const rChevron = reasoningHeader.querySelector<HTMLElement>('.reasoning-chevron');
      report('推理 chevron 用展开旋转向', !!rChevron, `found=${!!rChevron}`);
      const rContent = mountPoint.querySelector<HTMLElement>('.reasoning-content');
      if (rContent) {
        const cs2 = getComputedStyle(rContent);
        report('推理正文缩进对齐工具详情(26px)', cs2.paddingLeft === '26px', `padding-left=${cs2.paddingLeft}`);
      }
      // 推理行与工具行关键度量一致（同高、同图标槽、同缩进）
      const toolRow = mountPoint.querySelector<HTMLElement>('.tool-row-main');
      if (toolRow) {
        const ts = getComputedStyle(toolRow);
        report('推理行高=工具行高', hs.minHeight === ts.minHeight, `reasoning=${hs.minHeight} tool=${ts.minHeight}`);
        report('推理行内边距=工具行', hs.padding === ts.padding, `reasoning=${hs.padding} tool=${ts.padding}`);
      }
    }

    // 截屏行（查看屏幕）对齐工具行设计语言：与推理行同构的紧凑行 + 26px 缩进展开体
    const screenHeader = mountPoint.querySelector<HTMLElement>('.screen-header');
    if (screenHeader) {
      const ss = getComputedStyle(screenHeader);
      report('截屏行无边框透明底', ss.borderTopWidth === '0px' && ss.backgroundColor === 'rgba(0, 0, 0, 0)', `border=${ss.borderTopWidth} bg=${ss.backgroundColor}`);
      report('截屏行 26px 紧凑行高', ss.minHeight === '26px', `min-height=${ss.minHeight}`);
      report('截屏行内边距=工具行', ss.padding === '3px 6px 3px 4px', `padding=${ss.padding}`);
      report('截屏行 6px 圆角', ss.borderRadius === '6px', `radius=${ss.borderRadius}`);
      const sIcon = screenHeader.querySelector<HTMLElement>('.screen-icon');
      if (sIcon) {
        report('截屏图标 15px 槽（对齐工具图标）', getComputedStyle(sIcon).width === '15px', `width=${getComputedStyle(sIcon).width}`);
      }
      const sTitle = screenHeader.querySelector<HTMLElement>('.screen-title');
      if (sTitle) {
        report('截屏标题 12px（对齐工具名）', getComputedStyle(sTitle).fontSize === '12px', `font-size=${getComputedStyle(sTitle).fontSize}`);
      }
      const sRight = screenHeader.querySelector<HTMLElement>('.screen-right');
      if (sRight) {
        const inset = screenHeader.getBoundingClientRect().right - sRight.getBoundingClientRect().right;
        report('截屏右侧组贴行右缘', Math.abs(inset - 6) <= 1, `right-inset=${inset.toFixed(1)}px`);
      }
      report('截屏 chevron 用展开旋转向', !!screenHeader.querySelector('.screen-chevron'), `found=${!!screenHeader.querySelector('.screen-chevron')}`);
      const sBody = mountPoint.querySelector<HTMLElement>('.screen-body');
      if (sBody) {
        report('截屏展开体缩进 26px（对齐工具详情）', getComputedStyle(sBody).paddingLeft === '26px', `padding-left=${getComputedStyle(sBody).paddingLeft}`);
      }
    }

    // 直播消息条外最新活动：恒可见且不带线
    const liveParts = liveMsg ? [...liveMsg.querySelectorAll<HTMLElement>('.message-part')] : [];
    const trailing = liveParts[liveParts.length - 1];
    if (trailing) {
      report('直播最新活动不带线', !trailing.classList.contains('cluster-member'), `classes=${trailing.className}`);
    }

    // 收起态抽查：收起后成员应整体不渲染（打开过的条再点回收起）；
    // 点击后同样要等刷新，下一轮宏任务再读数
    const finalize = (): void => {
      const pre = document.createElement('pre');
      pre.id = 'verify-output';
      pre.textContent = lines.join('\n');
      document.body.appendChild(pre);
      console.log('[collapse-preview] verify done');
    };
    const anyBar = mountPoint.querySelector<HTMLElement>('.cluster-bar');
    if (anyBar) {
      const before = mountPoint.querySelectorAll('.cluster-member').length;
      anyBar.click();
      setTimeout(() => {
        const after = mountPoint.querySelectorAll('.cluster-member').length;
        report('收起后成员不渲染（线消失）', after < before, `before=${before} after=${after}`);
        finalize();
      }, 60);
    } else {
      finalize();
    }
    }, 60);
  }
} else {
  console.log('[collapse-preview] mount point missing');
}
