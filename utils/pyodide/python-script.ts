import type { PyodideInterface } from 'pyodide';
import type { PythonScriptRequest } from './python-script-request';

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
    const lookup = (name: string) => name.toLowerCase().replace(/[-_.]+/g, '-');
    const catalogNames = new Map(catalog.map(pkg => [lookup(pkg.name), pkg.name]));
    const declared = [...new Set(plan.requirements.flatMap(text => {
      const name = /^([a-z0-9][a-z0-9_.-]*)/i.exec(text)?.[1];
      const match = name && catalogNames.get(lookup(name));
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
        const match = catalogNames.get(lookup(name));
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
