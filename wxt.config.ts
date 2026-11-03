import { defineConfig } from 'wxt';
import { config } from 'dotenv';
import { resolve } from 'path';
import fg from 'fast-glob';
import { readFileSync } from 'fs';

config({ path: resolve(process.cwd(), '.env') });
config({ path: resolve(process.cwd(), '.env.local') });

const CHROME_EXTENSION_KEY = process.env.CHROME_EXTENSION_KEY;

// 过滤无效的占位值
const isValidExtensionKey = CHROME_EXTENSION_KEY && !CHROME_EXTENSION_KEY.startsWith('YOUR_');
const BROWSER_UUID = process.env.BROWSER_UUID || '';

// 从 package.json 读取版本号
const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf-8'));
const APP_VERSION = pkg.version || '0.0.0';
const STATIC_ASSET_DIRS = ['inject-scripts', '_locales'] as const;

// See https://wxt.dev/api/config.html
export default defineConfig({
  modules: ['@wxt-dev/module-vue'],
  webExt: {
    // 方案1: 禁用自动启动（推荐）
    disabled: true,

    // 方案2: 如果要启用自动启动并使用现有配置，取消注释下面的配置
    // chromiumArgs: [
    //   '--user-data-dir=' + homedir() + (process.platform === 'darwin'
    //     ? '/Library/Application Support/Google/Chrome'
    //     : process.platform === 'win32'
    //     ? '/AppData/Local/Google/Chrome/User Data'
    //     : '/.config/google-chrome'),
    //   '--remote-debugging-port=9222',
    // ],
  },
  manifest: {
    // Use environment variable for the key, fallback to undefined if not set
    key: isValidExtensionKey ? CHROME_EXTENSION_KEY : undefined,
    default_locale: 'zh_CN',
    name: '__MSG_extensionName__',
    description: '__MSG_extensionDescription__',
    permissions: [
      'nativeMessaging',
      'tabs',
      'activeTab',
      'scripting',
      'downloads',
      'webRequest',
      'debugger',
      'history',
      'bookmarks',
      'offscreen',
      'tabCapture',
      'storage',
      // MV3 官方推荐的请求拦截方案：支撑 browser_clean_page 的网络层去广告/去追踪
      // （webRequest 同步阻断在 MV3 已移除；会话规则随浏览器重启自动失效）
      'declarativeNetRequest',
      // 解除 chrome.storage.local 的 10MB 配额（受磁盘配额约束），
      // 支撑无限制的智能体/技能/配置与会话数据管理
      'unlimitedStorage',
      'sidePanel',
      'contextMenus',
      'notifications',
    ],
    host_permissions: ['<all_urls>'],
    side_panel: {
      default_path: 'sidepanel.html'
    },
    // 富内容图表沙箱页（ECharts 渲染）：manifest sandbox 使该页以独立源加载，
    // 无法访问任何 chrome.* API / 扩展存储 —— 即使 ECharts 出现新的 tooltip
    // HTML 注入类 CVE，影响半径也被限制在沙箱内（消费方见
    // sidepanel/utils/chat/chart-renderer.ts；CSP 用下方
    // content_security_policy.sandbox 的既有配置）
    sandbox: {
      pages: ['chart-sandbox.html'],
    },
    action: {
      default_title: 'AgentNexus'
    },
    web_accessible_resources: [
      {
        resources: [
          '/inject-scripts/**', // 允许访问 inject-scripts 文件（含子目录）
          '/entrypoints/workflow/*', // 允许访问 workflow 页面资源
          '/entrypoints/notes/*', // 允许访问 notes 页面资源
          '/entrypoints/hub/*', // 允许访问 hub 管理中心页面资源
          'workflow.html', // 允许访问 workflow 页面
          'notes.html', // 允许访问内置笔记页面
          'hub.html', // 允许访问管理中心页面
        ],
        matches: ['<all_urls>'],
      },
    ],
    cross_origin_embedder_policy: {
      value: 'require-corp',
    },
    cross_origin_opener_policy: {
      value: 'same-origin',
    },
    content_security_policy: {
    // wasm-unsafe-eval：允许扩展页编译 WebAssembly（MV3 明确允许的关键字，不放开 eval），
    // 支撑按需下载的 Pyodide（Python/WASM）运行时；所有可执行 JS 仍须来自扩展包自身
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval' http://localhost:8086 http://localhost:3000 http://localhost:3001; style-src 'self' 'unsafe-inline' http://localhost:3000 http://localhost:3001; connect-src *; object-src 'self';",
    "sandbox": "script-src 'self' 'unsafe-inline' 'unsafe-eval' http://localhost:8086 http://localhost:3000 http://localhost:3001; style-src 'self' 'unsafe-inline' http://localhost:3000 http://localhost:3001; connect-src *; sandbox allow-scripts allow-forms allow-popups allow-modals; child-src 'self';"
    },
  },
  hooks: {
    'build:publicAssets': async (_, files) => {
      for (const dir of STATIC_ASSET_DIRS) {
        const assetFiles = await fg('**/*', {
          cwd: resolve(process.cwd(), dir),
          onlyFiles: true,
          dot: true,
          suppressErrors: true,
        });

        for (const file of assetFiles) {
          files.push({
            absoluteSrc: resolve(process.cwd(), dir, file),
            relativeDest: `${dir}/${file}`.replace(/\\/g, '/'),
          });
        }
      }
    },
  },
  vite: (env) => ({
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BROWSER_UUID__: JSON.stringify(BROWSER_UUID),
    },
    build: {
      // 我们的构建产物需要兼容到es6
      target: 'es2015',
      // 非生产环境下生成sourcemap
      sourcemap: env.mode !== 'production',
      // 禁用gzip 压缩大小报告，因为压缩大型文件可能会很慢
      reportCompressedSize: false,
      // chunk大小超过1500kb是触发警告
      chunkSizeWarningLimit: 1500,
      minify: false,
    },
  }),
});
