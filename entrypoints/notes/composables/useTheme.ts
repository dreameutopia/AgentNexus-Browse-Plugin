/**
 * 主题管理 composable
 *
 * 防御：localStorage 在隐私模式/存储策略受限环境下可能抛异常
 * （SecurityError / QuotaExceeded），所有读写均 try/catch 降级，
 * 保证主题功能失效不影响页面可用性。
 */
import { ref } from 'vue';

const THEME_STORAGE_KEY = 'notes-theme';

const isDark = ref(false);

/** 安全读取持久化主题（失败返回 null，视同未设置） */
function readStoredTheme(): string | null {
  try {
    return localStorage.getItem(THEME_STORAGE_KEY);
  } catch (error) {
    console.warn('[Notes] 读取主题设置失败（localStorage 不可用）:', error);
    return null;
  }
}

/** 安全写入持久化主题（失败仅告警：本次会话主题仍然生效） */
function writeStoredTheme(value: 'dark' | 'light'): void {
  try {
    localStorage.setItem(THEME_STORAGE_KEY, value);
  } catch (error) {
    console.warn('[Notes] 保存主题设置失败（localStorage 不可用）:', error);
  }
}

/** 系统深色偏好（matchMedia 缺失时按浅色处理） */
function prefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

export function useTheme() {
  function applyTheme() {
    if (isDark.value) {
      document.documentElement.setAttribute('data-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
    }
  }

  function toggleTheme() {
    isDark.value = !isDark.value;
    writeStoredTheme(isDark.value ? 'dark' : 'light');
    applyTheme();
  }

  function initTheme() {
    const savedTheme = readStoredTheme();
    // 未手动设置时跟随系统偏好
    isDark.value = savedTheme ? savedTheme === 'dark' : prefersDark();
    applyTheme();
  }

  // 同步初始化
  initTheme();

  return {
    isDark,
    toggleTheme,
  };
}
