import type { PyodideInterface } from 'pyodide';
import type { PythonScriptRequest } from './python-script-request';
import {
  normalizePackageName,
  normalizeRequirementName,
} from './dependency-contract';

// Inspection never imports a module from the workspace or evaluates project configuration.
import SCRIPT_RUNNER from './workspace-script-runner.py?raw';

interface ScriptPlan {
  imports: string[];
  requirements: string[];
  requiresPython: string;
  [key: string]: unknown;
}

export async function runWorkspaceScript(
  pyodide: PyodideInterface,
  request: PythonScriptRequest,
  loadImports: (source: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const globals = pyodide.toPy(new Map([['request_json', JSON.stringify(request)]]));
  try {
    const plan = JSON.parse(pyodide.runPython(SCRIPT_RUNNER, { globals })) as ScriptPlan;
    const lock = (await import('pyodide/pyodide-lock.json')).default.packages;
    const catalog = Object.values(lock);
    const catalogImports = new Set(catalog.flatMap(pkg => pkg.imports ?? []));
    // 包名归一化与官方目录匹配一律走共享契约（utils/pyodide/dependency-contract）：
    // 工具层的依赖前置判定与 worker 的实际装包必须用**同一套**归一化口径，
    // 否则同一个包会被一边判为「目录内」、另一边判为「目录外」。
    const catalogNames = new Map(catalog.map(pkg => [normalizePackageName(pkg.name), pkg.name]));
    const declared = [...new Set(plan.requirements.flatMap(text => {
      const name = normalizeRequirementName(text);
      const match = name && catalogNames.get(name);
      return match ? [match] : [];
    }))];
    const available = plan.imports.filter(name => catalogImports.has(name));
    signal?.throwIfAborted();
    if (request.preflight) {
      const report = {
        ...plan, catalogImports: available, catalogDependencies: declared,
        otherImports: plan.imports.filter(name => !catalogImports.has(name)),
        requirements: plan.requirements.map(text => /(?:@|:\/\/|^[-./\\])/.test(text)
          ? 'Unsupported URL, path or installer option (omitted)'
          : text),
      };
      globals.set('report_json', JSON.stringify(report));
      pyodide.runPython('print(report_json)', { globals });
      return;
    }
    if (available.length) await loadImports(available.map(name => 'import ' + name).join('\n'));
    if (plan.requirements.length || plan.requiresPython || request.wheels.length) {
      await pyodide.loadPackage(['packaging', ...(request.wheels.length || request.dependencyMode === 'pypi' ? ['micropip'] : [])]);
      // Validate and evaluate PEP 508 markers before loading any declared packages.
      const candidates = JSON.parse(pyodide.runPython(
        'requirements = runner.requirements(plan)\njson.dumps([req.name for req in requirements])', { globals },
      )) as string[];
      const matching = [...new Set(candidates.flatMap(name => {
        const match = catalogNames.get(normalizePackageName(name));
        return match ? [match] : [];
      }))];
      if (matching.length && request.dependencyMode === 'catalog') await pyodide.loadPackage(matching);
      signal?.throwIfAborted();
      // 运行期网络已放开：pypi 解析直接执行（声明式依赖的审批门在工具/宿主层）
      await pyodide.runPythonAsync('await runner.prepare_dependencies(requirements)', { globals });
    }
    signal?.throwIfAborted();
    await pyodide.runPythonAsync('runner.run()', { globals });
  } finally {
    globals.destroy();
  }
}
