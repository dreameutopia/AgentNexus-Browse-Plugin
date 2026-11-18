<template>
  <!--
    欢迎语下的 Python 运行时安装引导标签。
    显隐跟 chrome.storage.local 的环境状态走（跨上下文单一事实源）：
    未安装时展示，安装完成（ready）经 onChanged 推送后立即消失。
  -->
  <button
    v-if="visible"
    type="button"
    class="greeting-python-tag"
    @click="emit('open')"
  >
    <span class="greeting-python-tag__emoji" aria-hidden="true">🐍</span>
    <span>{{ t('sidepanel.app.greetingPythonTag') }}</span>
  </button>
</template>

<script setup lang="ts">
/**
 * 侧边栏欢迎语 · Python 安装引导标签（按环境状态实时显隐）。
 *
 * 状态源：utils/pyodide/pyodide-env 的 chrome.storage.local 状态机
 * （idle / downloading / ready / error），与管理中心、运行时装配同一份数据；
 * watchPyodideEnv 经 chrome.storage.onChanged 跨上下文推送——hub 里装完
 * （→ ready）标签立即消失，删除环境（→ idle）后重新出现，两侧都无需刷新。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { t } from '@/utils/i18n';
import {
  getPyodideEnvState,
  watchPyodideEnv,
  type PyodideEnvStatus,
} from '@/utils/pyodide/pyodide-env';

/** 环境状态；null = 尚未水合（水合前不展示，避免已安装用户开屏闪现标签） */
const status = ref<PyodideEnvStatus | null>(null);
const visible = computed(() => status.value !== null && status.value !== 'ready');

// setup 期即订阅（先于挂载）：安装完成的推送最迟在挂载后一帧到达
const unwatch = watchPyodideEnv(state => {
  status.value = state.status;
});

onMounted(async () => {
  const state = await getPyodideEnvState();
  // 读与事件并发时以事件为准：迟到的旧读取不得覆盖订阅已推送的新状态
  if (status.value === null) status.value = state.status;
});

onUnmounted(() => unwatch());

const emit = defineEmits<{ (event: 'open'): void }>();
</script>

<style scoped>
/* Python 运行时安装引导标签：欢迎语下的中性玻璃胶囊，hover 轻抬升 */
.greeting-python-tag {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 16px;
  padding: 7px 16px;
  border: 1px solid var(--line-soft, #e4e2de);
  border-radius: 999px;
  background: #ffffff;
  color: #292824;
  font-family: inherit;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: 0.01em;
  line-height: 1.5;
  cursor: pointer;
  box-shadow: 0 1px 2px rgba(41, 40, 36, 0.05);
  transition: transform 0.18s ease, border-color 0.18s ease, box-shadow 0.18s ease,
    background 0.18s ease;
}

.greeting-python-tag:hover {
  transform: translateY(-1px);
  border-color: #cfccc5;
  background: #fbfaf8;
  box-shadow: 0 4px 12px rgba(41, 40, 36, 0.08);
}

.greeting-python-tag:active {
  transform: translateY(0);
  box-shadow: 0 1px 2px rgba(41, 40, 36, 0.05);
}

.greeting-python-tag:focus-visible {
  outline: none;
  box-shadow: 0 0 0 3px rgba(41, 40, 36, 0.18);
}

.greeting-python-tag__emoji {
  font-size: 14px;
  line-height: 1;
}
</style>
