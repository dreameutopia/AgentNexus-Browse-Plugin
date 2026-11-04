import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import pluginVue from 'eslint-plugin-vue';
import { defineConfig } from 'eslint/config';
import prettierConfig from 'eslint-config-prettier';

export default defineConfig([
  // Global ignores - these apply to all configurations
  {
    ignores: [
      'dist/**',
      '.output/**',
      '.wxt/**',
      'node_modules/**',
      'logs/**',
      '*.log',
      '.cache/**',
      '.temp/**',
      '.vscode/**',
      '!.vscode/extensions.json',
      '.idea/**',
      '.DS_Store',
      'Thumbs.db',
      '*.zip',
      '*.tar.gz',
      'stats.html',
      'stats-*.json',
      'libs/**',
      'workers/**',
      'public/libs/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.{js,mjs,cjs,ts,vue}'],
    languageOptions: {
      globals: {
        ...globals.browser,
        // 浏览器扩展 API 全局变量（MV3 sidepanel/background/content 均可直接访问）
        chrome: 'readonly',
        browser: 'readonly',
      },
    },
  },
  {
    // 测试运行器（tests/**/*.mjs）在 Node 环境执行，需要 Node 全局变量
    files: ['tests/**/*.mjs', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      // 允许「单继承空接口」：vue-i18n 等库的模块增强（declaration merging）标准写法
      '@typescript-eslint/no-empty-object-type': ['error', { allowInterfaces: 'with-single-extends' }],
    },
  },
  pluginVue.configs['flat/essential'],
  { files: ['**/*.vue'], languageOptions: { parserOptions: { parser: tseslint.parser } } },
  // Prettier configuration - must be placed last to override previous rules
  prettierConfig,
]);
