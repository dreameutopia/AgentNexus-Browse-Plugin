import { isWorkspaceRelativePath } from '@/utils/python-workspace/paths';

export interface PythonScriptRequest {
  path: string;
  module?: string;
  cwd?: string;
  argv: string[];
  env: Record<string, string>;
  stdin: string;
  preflight: boolean;
  dependencyMode: 'catalog' | 'pypi';
  wheels: string[];
  requirements: string[];
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
  return value as Record<string, unknown>;
}

/** 工作区相对路径（与文件操作同一校验：逐段拒绝 .. / 反斜杠 / 控制符 + 盘符前缀）。 */
function filePath(value: unknown): value is string {
  return typeof value === 'string' && isWorkspaceRelativePath(value);
}

function scriptText(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length <= maxLength && !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value);
}

function strings(value: unknown, maxItems: number, maxLength: number, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems ||
      !value.every(item => scriptText(item, maxLength))) {
    throw new Error(label + ' must be a bounded array of valid Unicode strings without NUL characters');
  }
  return [...value];
}

/** Used at both the model-facing and offscreen message boundaries. */
export function parsePythonScriptRequest(input: unknown): PythonScriptRequest {
  const source = record(input);
  if (Object.keys(source).some(key => !['path', 'module', 'cwd', 'argv', 'env', 'stdin', 'preflight', 'dependencyMode', 'wheels', 'requirements'].includes(key))) throw new Error('Script request contains unknown fields');
  const { path, module, cwd, argv, env, stdin, preflight, dependencyMode, wheels, requirements } = source;
  if (!filePath(path) || !path.endsWith('.py')) {
    throw new Error('path must be a workspace-relative .py file. Use a compatible Python implementation for other script languages.');
  }
  if (cwd !== undefined && cwd !== '.' && !filePath(cwd)) throw new Error('cwd must be "." or a workspace-relative directory');
  if (module !== undefined && (typeof module !== 'string' || module.length > 256 ||
      !/^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*$/.test(module))) {
    throw new Error('module must be a dotted Python module name matching path');
  }
  if (preflight !== undefined && typeof preflight !== 'boolean') throw new Error('preflight must be a boolean');
  if (dependencyMode !== undefined && dependencyMode !== 'catalog' && dependencyMode !== 'pypi') {
    throw new Error('dependencyMode must be "catalog" or "pypi"');
  }
  if (stdin !== undefined && !scriptText(stdin, 65_536)) {
    throw new Error('stdin must be valid Unicode without NUL characters, at most 65536 characters');
  }
  const variables = env === undefined ? [] : Object.entries(record(env));
  const validated: Array<[string, string]> = [];
  if (variables.length > 32) throw new Error('At most 32 environment variables may be passed');
  for (const [key, value] of variables) {
    if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(key) ||
        /^(?:PATH$|HOME$|PWD$|TMPDIR$|PYTHON|PIP_|LD_|DYLD_|NODE_|SSL_|AGENTNEXUS_WORKSPACE$)/i.test(key) ||
        /(?:^|_)(?:TOKENS?|SECRETS?|PASSWORD|PASSWD|CREDENTIALS?|API_?KEY|ACCESS_?KEY|AUTH|AUTHORIZATION|PRIVATE_?KEY)(?:_|$)/i.test(key) ||
        !scriptText(value, 2048)) {
      throw new Error('Invalid env entry. Pass only non-secret application settings and leave runtime variables unset.');
    }
    validated.push([key, value]);
  }
  const localWheels = strings(wheels, 16, 1024, 'wheels');
  if (!localWheels.every(path => filePath(path) && path.endsWith('.whl'))) {
    throw new Error('wheels must contain workspace-relative .whl paths');
  }
  return {
    path, module, cwd, argv: strings(argv, 64, 2048, 'argv'), env: Object.fromEntries(validated),
    stdin: stdin ?? '', preflight: preflight ?? false, dependencyMode: dependencyMode ?? 'catalog',
    wheels: [...new Set(localWheels)],
    requirements: strings(requirements, 32, 512, 'requirements'),
  };
}
