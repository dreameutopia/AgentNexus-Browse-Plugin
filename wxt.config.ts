import { defineConfig } from 'wxt';
import { config } from 'dotenv';
import { isAbsolute, relative, resolve, sep } from 'path';
import fg from 'fast-glob';
import { readFileSync, realpathSync } from 'fs';
import { browserBuildTarget } from './scripts/browser-build-target.mjs';

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
      'webNavigation',
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
    plugins: [{
      name: 'agentnexus-skill-bytes',
      enforce: 'pre',
      load(id) {
        const query = '?agentnexus-skill-bytes';
        if (!id.endsWith(query)) return;
        const file = realpathSync(id.slice(0, -query.length));
        const path = relative(realpathSync(resolve(process.cwd(), 'skills')), file);
        if (!path || path === '..' || path.startsWith('..' + sep) || isAbsolute(path)) {
          return this.error('Bundled skill resource must be inside skills/');
        }
        this.addWatchFile(file);
        return 'export default ' + JSON.stringify(readFileSync(file).toString('base64'));
      },
    }],
    worker: { format: 'es' },
    define: {
      __APP_VERSION__: JSON.stringify(APP_VERSION),
      __BROWSER_UUID__: JSON.stringify(BROWSER_UUID),
    },
    build: {
      // 注入函数被单独序列化，不能依赖降级生成的模块级 helper。
      target: browserBuildTarget,
      // 非生产环境下生成sourcemap
      sourcemap: env.mode !== 'production',
      // 禁用gzip 压缩大小报告，因为压缩大型文件可能会很慢
      reportCompressedSize: false,
      // chunk大小超过1500kb是触发警告。
      // sidepanel 主 chunk（含 Vue 应用 + 全量工具实现 + AI 传输层）压缩后约 2.1MB，
      // 属于单页入口的固有体量，阈值随之上调到 3000KB 继续跟踪其膨胀趋势
      chunkSizeWarningLimit: 3000,
      // 产物只供浏览器执行、无需人工阅读调试 → 启用 esbuild 压缩（显著缩小包体积）
      minify: true,
      rollupOptions: {
        // 仅静音两类已确认无害的构建警告，其余（含我们自己的）照常透传：
        //   1. pyodide 的 npm 包为兼容 Node 引用了 node:* 内置模块，
        //      Vite 在浏览器构建中已将其替换为空 stub（仅生产构建打印此提示）；
        //   2. pyodide.asm.mjs 为 Emscripten 生成物，内部 eval 受扩展 CSP 约束。
        onwarn(warning, warn) {
          const message = typeof warning === 'string' ? warning : String(warning?.message ?? '');
          if (message.includes('has been externalized for browser compatibility')) return;
          if (message.includes('Use of eval') && message.includes('pyodide')) return;
          warn(warning);
        },
      },
    },
  }),
});
