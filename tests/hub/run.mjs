/**
 * 管理中心（hub）测试运行器
 *
 * 用法：node tests/hub/run.mjs
 *       npm run test:hub
 *
 * 覆盖：技能编辑器（高级模式）的标题栏模式切换、VS Code 式文件树结构、
 * 新建文件、拖拽移入目录 / 移回根目录 / 同级重排，以及「行内无左侧色条、
 * 配色不含蓝紫」的样式契约。
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

const skillEditor = spawnSync(process.execPath, [path.join(here, 'skill-editor.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
if (skillEditor.status !== 0) process.exit(skillEditor.status ?? 1);

const agentEditor = spawnSync(process.execPath, [path.join(here, 'agent-editor.test.mjs')], {
  stdio: 'inherit',
  cwd: root,
});
process.exit(agentEditor.status ?? 1);
