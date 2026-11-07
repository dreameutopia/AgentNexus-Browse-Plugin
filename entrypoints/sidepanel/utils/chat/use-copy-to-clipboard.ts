/**
 * 复制按钮共用逻辑（组合式函数）
 *
 * 模型消息操作栏（复制 / 赞 / 踩）与用户消息气泡右下角的复制按钮共用同一
 * 套口径，避免两处各写一份而漂移：
 *   - 成功：进入 copied 态 2 秒后自动复原（按钮图标切回「复制」）；
 *   - 失败（权限拒绝 / 非安全上下文 / 内容超限）：复位 copied 态——否则
 *     按钮会停在「已复制」上误导用户——并 toast 提示 + 控制台保留可分析细节。
 *
 * 组件卸载时清理定时器：复制成功后的 2 秒窗口内组件被销毁（切换会话 /
 * 删除消息）时，回调不得再写已卸载组件的状态。
 */

import { onBeforeUnmount, ref } from 'vue';
import { t } from '@/utils/i18n';
import { message as toast } from './message';

/** 复制成功态的持续时长（毫秒） */
const COPIED_FEEDBACK_MS = 2000;

/**
 * @param getText 取待复制文本（惰性求值：复制按钮禁用态由调用方自行判定）
 * @param describeContext 失败日志的上下文描述（如消息 id），便于定位
 */
export function useCopyToClipboard(getText: () => string, describeContext: () => string = () => '消息') {
  /** 是否处于「已复制」成功态 */
  const copied = ref(false);
  let timer: ReturnType<typeof setTimeout> | null = null;

  const copy = async (): Promise<void> => {
    const text = getText();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      copied.value = true;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        copied.value = false;
      }, COPIED_FEEDBACK_MS);
    } catch (error) {
      // 剪贴板不可用（权限 / 非安全上下文 / 内容超限）：
      // 复位成功态避免「已复制」误导，toast 给出可读提示，控制台保留可分析细节
      copied.value = false;
      const reason = error instanceof Error ? error.message : String(error);
      console.warn(`[useCopyToClipboard] ${describeContext()}复制失败: ${reason}`, error);
      toast.error(t('sidepanel.chat.copyFailed'));
    }
  };

  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
  });

  return { copied, copy };
}
