/**
 * useVoiceAssistant - 语音助手模式管理 composable
 * 
 * 负责语音助手的状态管理、自动唤醒监听、录音处理等
 */
import { ref, type Ref } from 'vue';
import { convertAudioToText } from '../utils/ai/voice-to-text';

/** 语音助手状态（与 VoiceAssistantCard 的 status prop 保持一致） */
export type VoiceAssistantStatus = 'waiting' | 'listening' | 'understanding' | 'executing';

export interface VoiceAssistantDependencies {
  userInput: { value: string };
  sendMessage: () => Promise<void>;
  isAiResponding: Ref<boolean>;
  mediaRecorder: { value: MediaRecorder | null };
  audioData: { value: Blob[] };
}

export function useVoiceAssistant(deps: VoiceAssistantDependencies) {
  // 语音助手状态
  const showVoiceAssistantSettings = ref(false);
  const showVoiceAssistantCard = ref(false);
  const voiceAssistantAutoWake = ref(false);
  const voiceAssistantStatus = ref<VoiceAssistantStatus>('waiting');
  const voiceAssistantConnectedTime = ref(0);
  const voiceAssistantTimer = ref<ReturnType<typeof setInterval> | null>(null);
  const voiceAssistantAudioLevel = ref(0);
  const voiceAssistantListening = ref(false);

  /**
   * 打开语音助手设置
   */
  const toggleVoiceAssistantMode = () => {
    showVoiceAssistantSettings.value = true;
  };

  /**
   * 确认启用语音助手模式
   */
  const confirmVoiceAssistantMode = () => {
    showVoiceAssistantSettings.value = false;
    showVoiceAssistantCard.value = true;
    voiceAssistantStatus.value = 'waiting';
    voiceAssistantConnectedTime.value = 0;
    
    voiceAssistantTimer.value = setInterval(() => {
      voiceAssistantConnectedTime.value++;
    }, 1000);
    
    if (voiceAssistantAutoWake.value) {
      startVoiceAssistantListening();
    }
  };

  /**
   * 取消语音助手设置
   */
  const cancelVoiceAssistantMode = () => {
    showVoiceAssistantSettings.value = false;
  };

  /**
   * 退出语音助手模式
   */
  const exitVoiceAssistantMode = () => {
    showVoiceAssistantCard.value = false;
    voiceAssistantStatus.value = 'waiting';
    voiceAssistantListening.value = false;
    
    if (voiceAssistantTimer.value) {
      clearInterval(voiceAssistantTimer.value);
      voiceAssistantTimer.value = null;
    }
    
    stopVoiceAssistantListening();
  };

  /**
   * 开始语音助手音频监听（检测音量以自动唤醒）
   */
  const startVoiceAssistantListening = async () => {
    if (voiceAssistantListening.value) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceAssistantListening.value = true;
      
      const audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      const microphone = audioContext.createMediaStreamSource(stream);
      microphone.connect(analyser);
      
      analyser.fftSize = 256;
      const bufferLength = analyser.frequencyBinCount;
      const dataArray = new Uint8Array(bufferLength);
      
      const checkAudioLevel = () => {
        if (!voiceAssistantListening.value) {
          stream.getTracks().forEach(track => track.stop());
          audioContext.close();
          return;
        }
        
        analyser.getByteFrequencyData(dataArray);
        const average = dataArray.reduce((a: number, b: number) => a + b) / bufferLength;
        voiceAssistantAudioLevel.value = average;
        
        if (voiceAssistantAutoWake.value && 
            average > 8 && 
            voiceAssistantStatus.value === 'waiting' && 
            !deps.isAiResponding.value &&
            voiceAssistantStatus.value !== ('understanding' as string) &&
            voiceAssistantStatus.value !== ('executing' as string)) {
          startVoiceAssistantRecording();
        }
        
        requestAnimationFrame(checkAudioLevel);
      };
      
      checkAudioLevel();
    } catch (error) {
      console.error('启动语音助手监听失败:', error);
    }
  };

  /**
   * 停止语音助手监听
   */
  const stopVoiceAssistantListening = () => {
    voiceAssistantListening.value = false;
  };

  /**
   * 开始语音助手录音（被自动唤醒或手动触发）
   */
  const startVoiceAssistantRecording = async () => {
    if (deps.isAiResponding.value) return;
    
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      
      voiceAssistantStatus.value = 'listening';
      
      deps.mediaRecorder.value = new MediaRecorder(stream);
      deps.audioData.value = [];
      
      deps.mediaRecorder.value.ondataavailable = (event) => {
        if (event.data.size > 0) {
          deps.audioData.value.push(event.data);
        }
      };
      
      deps.mediaRecorder.value.onstop = async () => {
        try {
          voiceAssistantStatus.value = 'understanding';
          const audioBlob = new Blob(deps.audioData.value, { type: 'audio/wav' });
          await processVoiceAssistantAudio(audioBlob);
        } catch (error) {
          console.error('语音助手音频处理失败:', error);
          voiceAssistantStatus.value = 'waiting';
        } finally {
          stream.getTracks().forEach(track => track.stop());
          deps.audioData.value = [];
        }
      };
      
      deps.mediaRecorder.value.start();
    } catch (error) {
      console.error('语音助手录音启动失败:', error);
      voiceAssistantStatus.value = 'waiting';
    }
  };

  /**
   * 停止语音助手录音
   */
  const stopVoiceAssistantRecording = async () => {
    if (deps.mediaRecorder.value && voiceAssistantStatus.value === 'listening') {
      deps.mediaRecorder.value.stop();
    }
  };

  /**
   * 处理语音助手音频（转文字并发送）
   */
  const processVoiceAssistantAudio = async (audioBlob: Blob) => {
    try {
      voiceAssistantStatus.value = 'understanding';
      
      const transcribedText = await convertAudioToText(audioBlob);
      
      voiceAssistantStatus.value = 'executing';
      
      deps.userInput.value = transcribedText;
      await deps.sendMessage();
      
      if (!deps.isAiResponding.value) {
        voiceAssistantStatus.value = 'waiting';
        if (voiceAssistantAutoWake.value && !voiceAssistantListening.value) {
          startVoiceAssistantListening();
        }
      }
    } catch (error) {
      console.error('语音助手语音转文字失败:', error);
      voiceAssistantStatus.value = 'waiting';
      if (voiceAssistantAutoWake.value && !voiceAssistantListening.value) {
        startVoiceAssistantListening();
      }
    }
  };

  /**
   * 格式化连接时间显示
   */
  const formatConnectedTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = seconds % 60;
    
    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  };

  /**
   * 获取语音助手状态文本
   */
  const getVoiceAssistantStatusText = () => {
    switch (voiceAssistantStatus.value) {
      case 'waiting': return '等待中';
      case 'listening': return '正在聆听中';
      case 'understanding': return '理解中';
      case 'executing': return '执行中';
      default: return '等待中';
    }
  };

  /**
   * 切换自动唤醒
   */
  const toggleAutoWake = () => {
    voiceAssistantAutoWake.value = !voiceAssistantAutoWake.value;
  };

  return {
    // 状态
    showVoiceAssistantSettings,
    showVoiceAssistantCard,
    voiceAssistantAutoWake,
    voiceAssistantStatus,
    voiceAssistantConnectedTime,
    voiceAssistantTimer,
    voiceAssistantAudioLevel,
    voiceAssistantListening,
    
    // 方法
    toggleVoiceAssistantMode,
    confirmVoiceAssistantMode,
    cancelVoiceAssistantMode,
    exitVoiceAssistantMode,
    startVoiceAssistantListening,
    stopVoiceAssistantListening,
    startVoiceAssistantRecording,
    stopVoiceAssistantRecording,
    processVoiceAssistantAudio,
    formatConnectedTime,
    getVoiceAssistantStatusText,
    toggleAutoWake,
  };
}
