/**
 * 预览入口：把真实渲染器产出的 API 错误卡片塞进预览页
 *
 * 走的是生产代码路径（toApiErrorBlock → markdownRenderer.render），
 * 预览页只负责提供容器与真实样式表，避免「预览稿」与线上产物漂移。
 */
import { markdownRenderer } from '../entrypoints/sidepanel/utils/chat/markdown-renderer';
import { ApiRequestError, toApiErrorBlock } from '../entrypoints/sidepanel/utils/stream/errors';
import { setLocale } from '../utils/i18n/core';

setLocale('zh-CN');

const cases: Array<{ label: string; error: ApiRequestError }> = [
  {
    label: '请求被拒绝（openai-responses + 长端点 URL）',
    error: new ApiRequestError({
      provider: 'openai-responses',
      model: 'gpt-4o-mini',
      url: 'https://api.openai.com/v1/responses?beta=true',
      status: 400,
      statusText: 'Bad Request',
      rawBody: '{\n  "error": {\n    "message": "Unsupported parameter: \'temperature\' is not supported with this model.",\n    "type": "invalid_request_error",\n    "param": "temperature"\n  }\n}',
    }),
  },
  {
    label: '鉴权失败（ollama 本地端点）',
    error: new ApiRequestError({
      provider: 'ollama',
      model: 'qwen2.5:7b',
      url: 'http://localhost:11434/api/chat',
      status: 401,
      statusText: 'Unauthorized',
      rawBody: '{"error":"invalid api key"}',
    }),
  },
  {
    label: '超时（claude 协议，琥珀分类配色）',
    error: new ApiRequestError({
      provider: 'claude',
      model: 'claude-sonnet-5-5',
      url: 'https://api.anthropic.com/v1/messages',
      timeoutMs: 45000,
    }),
  },
  {
    label: '网络错误（gemini，石板分类配色）',
    error: new ApiRequestError({
      provider: 'gemini',
      model: 'gemini-2.0-flash',
      url: 'https://generativelanguage.googleapis.com',
    }),
  },
];

const hosts: HTMLElement[] = [];
cases.forEach((item, index) => {
  const host = document.getElementById(`case-${index}`);
  if (!host) return;
  host.innerHTML = markdownRenderer.renderMessage(toApiErrorBlock(item.error));
  hosts.push(host);
});

// 预览用：?open=<序号|all> 展开浮层（截图 / 视觉核对）
const openTarget = new URLSearchParams(location.search).get('open');
if (openTarget) {
  const targets = openTarget === 'all' ? hosts : [hosts[Number(openTarget)]];
  targets.forEach(host =>
    host?.querySelectorAll<HTMLElement>('.api-error-model-btn').forEach(button => button.click()),
  );
}

// 预览用：?check 输出每张卡的计算样式（无头核对分类配色 / 按钮存在性，
// 不依赖截图肉眼比对）
if (location.search.includes('check')) {
  const report = Array.from(document.querySelectorAll<HTMLElement>('.api-error-card')).map(card => {
    const cardStyle = getComputedStyle(card);
    const title = card.querySelector<HTMLElement>('.api-error-title');
    const retry = card.querySelector<HTMLElement>('.api-error-retry-btn');
    const head = card.querySelector<HTMLElement>('.api-error-head');
    return [
      `class=${card.className}`,
      `border=${cardStyle.borderTopColor}`,
      `bg=${cardStyle.backgroundColor}`,
      `title-color=${title ? getComputedStyle(title).color : 'none'}`,
      `retry=${retry ? 'yes' : 'no'}`,
      `retry-bg=${retry ? getComputedStyle(retry).backgroundColor : 'none'}`,
      `head-bg=${head ? getComputedStyle(head).backgroundColor : 'none'}`,
    ].join(' | ');
  });
  // 横向溢出检测：任何消息容器 scrollWidth 超过 clientWidth 即记入报告
  const overflowed = hosts
    .map((host, index) =>
      host.scrollWidth > host.clientWidth ? `case-${index}:+${host.scrollWidth - host.clientWidth}px` : '',
    )
    .filter(Boolean)
    .join(', ');
  report.push(`overflow=${overflowed || 'none'}`);
  const pre = document.createElement('pre');
  pre.id = 'css-check';
  pre.textContent = report.join('\n');
  document.body.appendChild(pre);
}
