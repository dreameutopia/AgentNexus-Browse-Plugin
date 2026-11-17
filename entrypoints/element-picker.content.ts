/**
 * 元素捕获器内容脚本入口（独立于主内容脚本）
 *
 * 为什么单独一个入口：
 *   - 捕获器需要在所有 frame 安装，且必须能被侧边栏在「页面早于扩展加载 / 更新」
 *     时通过 chrome.scripting.executeScript 补注入（见 use-element-capture）。
 *     独立文件使其可单独注入，不必重跑主内容脚本的全部启动逻辑。
 *   - 与主内容脚本解耦：主内容脚本的既有职责（网站验证、选区引用等）不因
 *     捕获器故障而受影响，反之亦然。
 *
 * 幂等：installElementPicker 内部有全局安装标记，重复注入不会重复注册监听。
 */

import { installElementPicker } from '@/utils/element-capture/element-picker';

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  matchOriginAsFallback: true,
  runAt: 'document_idle',
  main() {
    installElementPicker();
  },
});
