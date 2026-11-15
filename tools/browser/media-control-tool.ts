/**
 * 通用媒体控制（browser_media_control）
 *
 * 只操作当前页面里的 <video>/<audio> 元素，不执行任意脚本：
 * - status / seek / play / pause / setRate / setVolume / mute；
 * - seek 自动夹取到 [0, duration]；
 * - 插件调用时仍受 manifest network origin 约束。
 */
import { BaseBrowserTool } from '../base/browser-tool';
import { ToolMetadata, type ToolExecutionContext } from '../registry';
import { OpenAITool } from '@/common/openai-types';
import { ToolResult } from '@/common/tool-handler';
import { executeScriptBounded } from '../common/frame-read';
import { resolveTabOrigin } from '../common/plugin-origin';

export const MEDIA_ACTIONS = [
  'status',
  'seek',
  'play',
  'pause',
  'setRate',
  'setVolume',
  'mute',
  'unmute',
] as const;
type MediaAction = (typeof MEDIA_ACTIONS)[number];

interface MediaArgs {
  action: MediaAction;
  time?: number | string;
  rate?: number;
  volume?: number;
  selector?: string;
  urlPattern?: string;
  tabId?: number;
}

interface MediaResult {
  ok: boolean;
  error?: string;
  selector?: string;
  currentTime?: number;
  duration?: number;
  paused?: boolean;
  playbackRate?: number;
  volume?: number;
  muted?: boolean;
  src?: string;
  /** 直播流（duration 为 Infinity）时 currentTime/duration 不具可比性 */
  live?: boolean;
}

/** 页面内执行函数（必须完全自包含） */
async function mediaControlInPage(
  action: string,
  selector: string,
  time: number | null,
  rate: number | null,
  volume: number | null,
): Promise<MediaResult> {
  let elements: Element[];
  try {
    elements = Array.from(document.querySelectorAll(selector));
  } catch {
    return { ok: false, error: 'INVALID_SELECTOR', selector };
  }
  const candidates = elements.filter(
    (element): element is HTMLMediaElement => element instanceof HTMLMediaElement,
  );
  // 优先正在播放/已就绪的元素；直播流的 duration 为 Infinity，不能按 >0 过滤掉
  const media =
    candidates.find((element) => !element.paused) ??
    candidates.find((element) => element.readyState > 0) ??
    candidates[0];
  if (!media) return { ok: false, error: 'NO_MEDIA_ELEMENT', selector };

  const status = (): MediaResult => {
    const live = !Number.isFinite(media.duration);
    return {
      ok: true,
      selector,
      currentTime: Number.isFinite(media.currentTime)
        ? Number(media.currentTime.toFixed(2))
        : 0,
      duration: live ? 0 : Number(media.duration.toFixed(2)),
      paused: media.paused,
      playbackRate: media.playbackRate,
      volume: media.volume,
      muted: media.muted,
      src: media.currentSrc || media.src || undefined,
      live: live || undefined,
    };
  };

  try {
    switch (action) {
      case 'status':
        return status();
      case 'seek': {
        if (time === null || !Number.isFinite(time)) {
          return { ok: false, error: 'INVALID_TIME', selector };
        }
        const duration = Number.isFinite(media.duration) ? media.duration : time;
        media.currentTime = Math.max(0, Math.min(duration, time));
        return status();
      }
      case 'play':
        await media.play();
        return status();
      case 'pause':
        media.pause();
        return status();
      case 'setRate': {
        if (rate === null || !Number.isFinite(rate)) {
          return { ok: false, error: 'INVALID_RATE', selector };
        }
        media.playbackRate = Math.max(0.25, Math.min(4, rate));
        return status();
      }
      case 'setVolume': {
        if (volume === null || !Number.isFinite(volume)) {
          return { ok: false, error: 'INVALID_VOLUME', selector };
        }
        media.volume = Math.max(0, Math.min(1, volume));
        return status();
      }
      case 'mute':
        media.muted = true;
        return status();
      case 'unmute':
        media.muted = false;
        return status();
      default:
        return { ok: false, error: 'INVALID_ACTION', selector };
    }
  } catch (error) {
    return {
      ...status(),
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function parseTime(value: MediaArgs['time']): number | null {
  if (typeof value === 'number')
    return Number.isFinite(value) && value >= 0 ? value : null;
  if (typeof value !== 'string') return null;
  const text = value.trim();
  // 只接受 90 / 1:30 / 1:02:03 这类规范写法，拒绝 1.5:30、1e2、+5
  if (!/^\d+(?::\d+){0,2}$/.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isSafeInteger(part) || part < 0)) return null;
  if (parts.length === 2 && parts[1] >= 60) return null;
  if (parts.length === 3 && (parts[1] >= 60 || parts[2] >= 60)) return null;
  const total =
    parts.length === 1
      ? parts[0]
      : parts.length === 2
        ? parts[0] * 60 + parts[1]
        : parts[0] * 3600 + parts[1] * 60 + parts[2];
  return Number.isSafeInteger(total) ? total : null;
}

export class BrowserMediaControlTool extends BaseBrowserTool {
  name = 'browser_media_control';

  metadata: ToolMetadata = {
    name: 'browser_media_control',
    description:
      '通用媒体控制：读取状态、跳转时间、播放/暂停、倍速、音量与静音（只操作 video/audio）',
    category: 'browser',
    version: '1.0.0',
    author: 'AgentNexus',
    tags: ['browser', 'media', 'video', 'audio', 'player'],
  };

  openaiSchema: OpenAITool = {
    type: 'function',
    function: {
      name: 'browser_media_control',
      description:
        '控制当前页面媒体元素。action=status/seek/play/pause/setRate/setVolume/mute/unmute；' +
        'time 支持秒数或 mm:ss / hh:mm:ss；seek 会自动夹取到 [0, duration]。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: { type: 'string', enum: [...MEDIA_ACTIONS] },
          time: {
            description: 'seek 目标时间：秒数或 mm:ss / hh:mm:ss',
          },
          rate: { type: 'number', minimum: 0.25, maximum: 4 },
          volume: { type: 'number', minimum: 0, maximum: 1 },
          selector: {
            type: 'string',
            description: '媒体元素选择器，默认 video；插件工具应固定该值',
          },
          urlPattern: {
            type: 'string',
            description: '可选：当前页 URL 必须命中的正则',
          },
          tabId: { type: 'integer' },
        },
        required: ['action'],
      },
    },
  };

  async execute(args: MediaArgs, context?: ToolExecutionContext): Promise<ToolResult> {
    this.ensureBackgroundContext();
    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return this.createErrorResponse('INVALID_ARGUMENT：参数必须是 JSON 对象');
    }
    if (
      typeof args.action !== 'string' ||
      !MEDIA_ACTIONS.includes(args.action)
    ) {
      return this.createErrorResponse(
        `INVALID_ARGUMENT：action 必须是 ${MEDIA_ACTIONS.join(' / ')}`,
      );
    }
    if (
      args.selector !== undefined &&
      (typeof args.selector !== 'string' || args.selector.length > 200)
    ) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：selector 必须是长度不超过 200 的字符串',
      );
    }
    const selector = (args.selector ?? '').trim() || 'video';
    if (
      args.tabId !== undefined &&
      (typeof args.tabId !== 'number' ||
        !Number.isSafeInteger(args.tabId) ||
        args.tabId < 0)
    ) {
      return this.createErrorResponse('INVALID_ARGUMENT：tabId 必须是非负整数');
    }
    let urlFilter: RegExp | undefined;
    if (args.urlPattern !== undefined) {
      if (
        typeof args.urlPattern !== 'string' ||
        !args.urlPattern ||
        args.urlPattern.length > 500
      ) {
        return this.createErrorResponse(
          'INVALID_ARGUMENT：urlPattern 必须是长度不超过 500 的非空正则',
        );
      }
      try {
        urlFilter = new RegExp(args.urlPattern);
      } catch {
        return this.createErrorResponse('INVALID_ARGUMENT：urlPattern 不是合法正则');
      }
    }
    if (
      args.rate !== undefined &&
      (typeof args.rate !== 'number' || !Number.isFinite(args.rate))
    ) {
      return this.createErrorResponse('INVALID_ARGUMENT：rate 必须是有限数字');
    }
    if (
      args.volume !== undefined &&
      (typeof args.volume !== 'number' || !Number.isFinite(args.volume))
    ) {
      return this.createErrorResponse('INVALID_ARGUMENT：volume 必须是有限数字');
    }
    const time = parseTime(args.time);
    if (args.time !== undefined && time === null) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：time 只接受秒数或 mm:ss / hh:mm:ss（分秒必须小于 60）',
      );
    }
    if (args.action === 'seek' && time === null) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：seek 需要合法的 time（秒数或 mm:ss）',
      );
    }
    const rate = typeof args.rate === 'number' ? args.rate : null;
    const volume = typeof args.volume === 'number' ? args.volume : null;
    // 动作所需参数在宿主侧先拒绝，错误信息比页面内更接近调用意图
    if (args.action === 'setRate' && rate === null) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：setRate 需要 rate（0.25–4 的有限数字）',
      );
    }
    if (args.action === 'setVolume' && volume === null) {
      return this.createErrorResponse(
        'INVALID_ARGUMENT：setVolume 需要 volume（0–1 的有限数字）',
      );
    }

    let target: Awaited<ReturnType<typeof resolveTabOrigin>>;
    try {
      target = await resolveTabOrigin(args.tabId, context);
    } catch (error) {
      return this.createErrorResponse(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (urlFilter && !urlFilter.test(target.url)) {
      return this.createErrorResponse(
        `MEDIA_URL_MISMATCH：当前页 ${target.url} 不匹配 urlPattern`,
      );
    }

    try {
      const injected = await executeScriptBounded<Promise<MediaResult>>(
        {
          target: { tabId: target.tabId },
          func: mediaControlInPage,
          args: [args.action, selector, time, rate, volume],
        },
        8_000,
        context?.signal,
      );
      const result = injected[0]?.result;
      if (
        !result ||
        typeof result !== 'object' ||
        typeof result.ok !== 'boolean'
      ) {
        return this.createErrorResponse(
          'INVALID_RESULT：页面没有返回有效的媒体状态，请确认当前标签页可注入',
        );
      }
      if (!result.ok) {
        return this.createErrorResponse(
          `MEDIA_ACTION_FAILED：${result.error ?? 'unknown error'}（selector=${selector}，url=${target.url}）`,
        );
      }
      return this.createSuccessResponse({
        tabId: target.tabId,
        url: target.url,
        ...result,
      });
    } catch (error) {
      return this.createErrorResponse(
        'MEDIA_ACTION_FAILED',
        error instanceof Error ? error : String(error),
      );
    }
  }
}

export const browserMediaControlTool = new BrowserMediaControlTool();
