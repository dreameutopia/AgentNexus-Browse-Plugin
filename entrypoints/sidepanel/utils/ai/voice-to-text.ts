/**
 * 音频转文字工具函数（整个插件唯一的语音识别入口）
 *
 * 配置来源：AsrConfigManager（设置弹窗「语音识别」页签维护，配置引擎三层冗余持久化）。
 * 协议：OpenAI 兼容 /audio/transcriptions（SiliconFlow / OpenAI / Groq / 自定义）。
 * 调用方（useVoiceRecording / useVoiceAssistant）无需感知供应商差异。
 */
import { t } from '@/utils/i18n/core';
import { AsrConfigManager, resolveTranscriptionEndpoint } from '../api/user-asr-config';
import { normalizeTranscriptionUsage } from '../stream/adapters/usage-normalize';
import { aiUsageMetrics, summarizeErrorForMetrics } from '../metrics/usage-metrics-engine';

/** 依据 Blob MIME 类型推断文件扩展名（OpenAI 依扩展名识别音频格式） */
function recordingExtension(blob: Blob): string {
  const type = (blob.type || '').toLowerCase();
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('aac')) return 'mp4';
  if (type.includes('mpeg')) return 'mp3';
  if (type.includes('flac')) return 'flac';
  return 'wav';
}

/** 从 OpenAI 兼容转写响应中提取文本（标准字段 text） */
function extractTranscript(result: unknown): string {
  if (typeof result !== 'object' || result === null) return '';
  const text = (result as Record<string, unknown>).text;
  return typeof text === 'string' ? text.trim() : '';
}

export const convertAudioToText = async (audioBlob: Blob): Promise<string> => {
  // 未加载过（如刚刷新页面直接录音）时先从存储水合一次
  if (!AsrConfigManager.isLoaded()) {
    await AsrConfigManager.load();
  }

  const config = AsrConfigManager.getConfig();
  if (!AsrConfigManager.isConfigured()) {
    throw new Error(t('sidepanel.asr.errorNotConfigured'));
  }

  const endpoint = resolveTranscriptionEndpoint(config.baseUrl);

  // ---- 用量指标：语音识别也是真实 AI 请求，计入统计（kind='asr'；成败均记，usage 尽力提取） ----
  let result: unknown;
  try {
    result = await requestTranscription(audioBlob, config.model, config.apiKey, endpoint);
  } catch (error) {
    aiUsageMetrics.record({
      provider: 'asr',
      model: config.model,
      kind: 'asr',
      outcome: 'failed',
      errorSummary: summarizeErrorForMetrics(error),
    });
    throw error;
  }

  aiUsageMetrics.record({
    provider: 'asr',
    model: config.model,
    kind: 'asr',
    outcome: 'success',
    usage: normalizeTranscriptionUsage(result),
  });

  const transcribedText = extractTranscript(result);
  if (!transcribedText) {
    throw new Error(t('sidepanel.asr.errorNoSpeech'));
  }

  return transcribedText;
};

/**
 * 发送转写请求（OpenAI 兼容 /audio/transcriptions）并把可读错误翻译成本地化文案。
 * 只负责网络与协议层，不碰指标（成败由调用方统一计数）。
 */
async function requestTranscription(
  audioBlob: Blob,
  model: string,
  apiKey: string,
  endpoint: string,
): Promise<unknown> {
  const formData = new FormData();
  formData.append('file', audioBlob, `recording.${recordingExtension(audioBlob)}`);
  formData.append('model', model);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
      },
      body: formData,
    });
  } catch (error) {
    console.error('语音转文字网络请求失败:', error);
    throw new Error(t('sidepanel.asr.errorNetwork'));
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(t('sidepanel.asr.errorApiKey'));
  }

  if (!response.ok) {
    // 尽力透出服务端错误信息（如模型名错误），便于用户排查
    let detail = '';
    try {
      const body = await response.json();
      detail = extractTranscript(body) || (body as any)?.error?.message || '';
    } catch {
      // 忽略解析失败
    }
    const suffix = detail ? `：${String(detail).slice(0, 200)}` : '';
    throw new Error(t('sidepanel.asr.errorRequest', { status: response.status }) + suffix);
  }

  try {
    return await response.json();
  } catch (error) {
    console.error('语音转文字响应解析失败:', error);
    throw new Error(t('sidepanel.asr.errorResponse'));
  }
}
