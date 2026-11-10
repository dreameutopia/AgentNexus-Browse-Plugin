/**
 * 预览入口：模型消息操作栏的调试按钮收起 / 展开
 *
 * 走生产代码路径（真实 MessageItem + 真实 chat-message-list.css），验证：
 *   1. 默认收起：调试按钮不出现在操作栏里，最右侧只有一个展开开关；
 *   2. 展开：点开关后调试按钮带过渡动画放出（宽度 + 透明度 + 图标缩放）；
 *   3. 收起：再点开关，调试按钮反向收拢，操作栏不留空档；
 *   4. 开关箭头随状态旋转（收起 ▶ / 展开 ◀）。
 */
import { createApp, h } from 'vue';
import MessageItem from '../entrypoints/sidepanel/components/chat/MessageItem.vue';
import type { ExtendedChatMessage } from '../entrypoints/sidepanel/types/chat';
import { setLocale } from '../utils/i18n/core';

setLocale('zh-CN');

/** 结束态消息：有思考 / 工具 / 正文 —— 轨迹非空，展开开关必定出现 */
const message: ExtendedChatMessage = {
  id: 'msg-action-fold',
  role: 'assistant',
  content: '已完成页面结构分析：主容器三栏布局，中部为内容流。',
  durationMs: 8600,
  parts: [
    {
      type: 'reasoning',
      content: '先分析页面结构：侧边栏固定宽度，主区域随窗口伸缩。',
      collapsed: true,
    },
    {
      type: 'tool',
      toolCall: {
        id: 'tc-1',
        name: 'dom_explore',
        status: 'success',
        arguments: '{"selector":"main"}',
        result: { summary: '定位到主内容节点' },
        executionTime: 860,
      },
    },
    { type: 'text', content: '已完成对页面结构的分析：主容器采用三栏布局，中部为内容流。' },
  ],
  toolCalls: [
    {
      id: 'tc-1',
      name: 'dom_explore',
      status: 'success',
      arguments: '{"selector":"main"}',
      result: { summary: '定位到主内容节点' },
      executionTime: 860,
    },
  ],
};

const App = {
  setup: () => () =>
    h('div', { class: 'stage message' }, [
      h(MessageItem, { message, isLive: false }),
    ]),
};

createApp(App).mount('#action-fold-host');
