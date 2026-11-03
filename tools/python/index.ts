/**
 * Python 工具注册（tools/python）
 *
 * 目前仅 python_run；运行时与环境的完整管理见 utils/pyodide。
 */

import { toolRegistry } from '../registry';
import { PythonRunTool } from './python-run-tool';

export function registerPythonTools() {
  toolRegistry.register(new PythonRunTool());
}

export { PythonRunTool };
