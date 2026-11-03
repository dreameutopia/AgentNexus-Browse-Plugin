/**
 * useVoiceRecording - 语音录制管理 composable
 * 
 * 负责语音录制状态、开始/停止/取消录音、音频转文字等
 */
import { ref } from 'vue';
import { t } from '@/utils/i18n';
import { convertAudioToText } from '../utils/ai/voice-to-text';
import { AsrConfigManager } from '../utils/api/user-asr-config';

export interface VoiceRecordingDependencies {
  userInput: { value: string };
  sendMessage: () => Promise<void>;
}

export function useVoiceRecording(deps: VoiceRecordingDependencies) {
  // 录制状态
  const showVoiceRecording = ref(false);
  const showAiProcessing = ref(false);
  const isRecording = ref(false);
  const recordingTime = ref(0);
  const maxRecordingTime = ref(30);
  const audioData = ref<Blob[]>([]);
  const mediaRecorder = ref<MediaRecorder | null>(null);
  const recordingTimer = ref<ReturnType<typeof setInterval> | null>(null);
  // ASR 未配置提示弹窗（App.vue 渲染 AsrConfigPrompt）
  const showAsrPrompt = ref(false);

  /**
   * 处理音频转文字并发送消息
   */
  const processAudioToText = async (audioBlob: Blob) => {
    try {
      const transcribedText = await convertAudioToText(audioBlob);
      
      showAiProcessing.value = false;
      
      // 自动填充到输入框
      deps.userInput.value = transcribedText;
      
      // 自动发送消息
      await deps.sendMessage();
    } catch (error) {
      console.error('语音转文字失败:', error);
      showAiProcessing.value = false;
      alert(error instanceof Error ? error.message : t('sidepanel.asr.errorRetry'));
    } finally {
      showVoiceRecording.value = false;
    }
  };

  /**
   * 开始语音录制
   */
  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      isRecording.value = true;
      showVoiceRecording.value = true;
      recordingTime.value = 0;
      
      mediaRecorder.value = new MediaRecorder(stream);
      audioData.value = [];
      
      mediaRecorder.value.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioData.value.push(event.data);
        }
      };
      
      mediaRecorder.value.onstop = async () => {
        try {
          const audioBlob = new Blob(audioData.value, { type: 'audio/wav' });
          await processAudioToText(audioBlob);
        } catch (error) {
          console.error('音频处理失败:', error);
          showAiProcessing.value = false;
        } finally {
          stream.getTracks().forEach(track => track.stop());
          
          // 重置录音相关状态
          recordingTime.value = 0;
          audioData.value = [];
        }
      };
      
      mediaRecorder.value.start();
      
      recordingTimer.value = setInterval(() => {
        recordingTime.value += 1;
        if (recordingTime.value >= 30) {
          stopVoiceRecording();
        }
      }, 1000);
    } catch (error) {
      console.error('录音启动失败:', error);
      const name = (error as any)?.name || '';
      const msg = ((error as any)?.message || '').toLowerCase();
      if (
        name === 'NotAllowedError' ||
        name === 'SecurityError' ||
        name === 'PermissionDeniedError' ||
        msg.includes('permission dismissed') ||
        msg.includes('notallowederror')
      ) {
        const permissionUrl = chrome.runtime.getURL('permission.html?reason=mic-permission');
        chrome.tabs.create({ url: permissionUrl });
        return;
      }
      alert('无法访问麦克风，请检查权限设置');
    }
  };

  /**
   * 停止语音录制
   */
  const stopVoiceRecording = () => {
    if (mediaRecorder.value && isRecording.value) {
      isRecording.value = false;
      showVoiceRecording.value = false;
      showAiProcessing.value = true;
      
      mediaRecorder.value.stop();
      if (recordingTimer.value) {
        clearInterval(recordingTimer.value);
        recordingTimer.value = null;
      }
    }
  };

  /**
   * 取消语音录制
   */
  const cancelVoiceRecording = () => {
    if (mediaRecorder.value && isRecording.value) {
      mediaRecorder.value.stop();
      if (recordingTimer.value) {
        clearInterval(recordingTimer.value);
        recordingTimer.value = null;
      }
      
      isRecording.value = false;
      showVoiceRecording.value = false;
      recordingTime.value = 0;
    }
  };

  /**
   * 处理语音录制按钮点击（ASR 配置检查 → 权限检查 → 录音）
   * 未配置 ASR 时直接弹出引导提示，不先请求麦克风权限
   */
  const handleVoiceRecord = async () => {
    // 1) ASR 配置拦截：未配置时弹出引导弹窗（由 App.vue 渲染）
    if (!AsrConfigManager.isLoaded()) {
      await AsrConfigManager.load();
    }
    if (!AsrConfigManager.isConfigured()) {
      showAsrPrompt.value = true;
      return;
    }

    // 2) 麦克风权限检查
    try {
      const permissionResult = await new Promise<{hasPermission: boolean}>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'CHECK_MIC_PERMISSION' },
          (response) => {
            resolve(response || { hasPermission: false });
          }
        );
      });

      if (!permissionResult.hasPermission) {
        const permissionUrl = chrome.runtime.getURL('permission.html?reason=mic-permission');
        chrome.tabs.create({ url: permissionUrl });
        return;
      }

      if (!isRecording.value) {
        startVoiceRecording();
      } else {
        stopVoiceRecording();
      }
    } catch (error) {
      console.error('检查麦克风权限失败:', error);
      const permissionUrl = chrome.runtime.getURL('permission.html?reason=mic-permission');
      chrome.tabs.create({ url: permissionUrl });
    }
  };

  return {
    // 状态
    showVoiceRecording,
    showAiProcessing,
    isRecording,
    recordingTime,
    maxRecordingTime,
    audioData,
    mediaRecorder,
    recordingTimer,
    showAsrPrompt,
    
    // 方法
    startVoiceRecording,
    stopVoiceRecording,
    cancelVoiceRecording,
    handleVoiceRecord,
    processAudioToText,
  };
}
