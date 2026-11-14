import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import 'fake-indexeddb/auto';
import { loadPyodide } from 'pyodide';
import { strToU8, zipSync } from 'fflate';

const outfile = path.resolve('node_modules/.cache/skill-workspace-test.mjs');
await build({
  stdin: {
    contents: `
      export { chatDatabase } from './entrypoints/sidepanel/core/context/chat-database';
      export { withPythonWorkspace } from './utils/python-workspace/python-filesystem';
      export { readWorkspaceOutput } from './utils/python-workspace/store';
      export { copySkillToWorkspace } from './utils/skills/skill-workspace';
      export { encodeSkillBytes } from './utils/skills/skill-resources';
      export { parsePythonScriptRequest } from './utils/pyodide/python-script-request';
      export { runWorkspaceScript } from './utils/pyodide/python-script';
      export { pythonWorkerGlobals } from './utils/pyodide/python-worker-globals';
    `,
    resolveDir: process.cwd(),
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  outfile,
  plugins: [{
    name: 'python-source',
    setup(builder) {
      builder.onResolve({ filter: /\.py\?raw$/ }, args => ({
        path: path.resolve(args.resolveDir, args.path.slice(0, -4)), namespace: 'python-source',
      }));
      builder.onLoad({ filter: /\.py$/, namespace: 'python-source' }, async args => ({
        contents: await readFile(args.path, 'utf8'), loader: 'text',
      }));
    },
  }],
});
const { chatDatabase, withPythonWorkspace, readWorkspaceOutput, copySkillToWorkspace, encodeSkillBytes,
  parsePythonScriptRequest, runWorkspaceScript, pythonWorkerGlobals } = await import(pathToFileURL(outfile).href);
const py = await loadPyodide({ jsglobals: pythonWorkerGlobals() });

try {
  for (const chatId of ['chat_a', 'chat_b']) {
    await chatDatabase.createSession({
      chatId, title: chatId, createdAt: 1, updatedAt: 1, messageCount: 0,
      lastMessagePreview: '', agentName: '', skillNames: [],
    });
  }
  const run = (chatId, code) => withPythonWorkspace(py.FS, chatId, async () => {
    await py.runPythonAsync('from pathlib import Path\n' + code);
    return { ok: true };
  });

  const skill = {
    id: '1001', name: 'fixture',
    files: {
      'SKILL.md': '# Fixture',
      'scripts/helper.py': 'value = "local import"',
      'src/report_package/__init__.py': '',
      'src/report_package/helper.py': 'value = "module import"',
      'src/report_package/__main__.py': 'from .helper import value\nassert value == "module import"',
      'scripts/report.py': [
        '# /// script', '# dependencies = []', '# ///',
        'import sys, os', 'from pathlib import Path', 'from helper import value',
        'assert Path("assets/fixture.bin").read_bytes() == bytes([0, 255, 10])',
        'assert Path("empty").is_dir()',
        'assert sys.argv[1:] == ["hello world", "$literal"]',
        'assert os.getenv("REPORT_FORMAT") == "text"',
        'root = Path(os.environ["AGENTNEXUS_WORKSPACE"])',
        '(root / "outputs" / "skill.txt").write_text(input() + " / " + value)',
        'raise SystemExit(0)',
      ].join('\n'),
      'scripts/fail.py': [
        'from pathlib import Path', 'import os',
        'Path(os.environ["AGENTNEXUS_WORKSPACE"], "outputs", "should-not-exist").touch()',
        'raise SystemExit(17)',
      ].join('\n'),
    },
    resourceBytes: { 'assets/fixture.bin': encodeSkillBytes(Uint8Array.of(0, 255, 10)) },
    folders: ['empty'],
  };
  const subset = await copySkillToWorkspace('chat_a', skill, ['scripts/report.py', 'scripts']);
  assert.equal(subset.files.length, 3, 'Overlapping selectors deduplicate');
  const copied = await copySkillToWorkspace('chat_a', skill, ['.']);
  assert.equal(subset.workspacePath, '.');
  assert.equal(copied.workspacePath, skill.id);
  assert.ok(copied.files.includes(copied.workspacePath + '/assets/fixture.bin'));
  const beforeRetry = (await chatDatabase.readWorkspace('chat_a')).revision;
  const repeated = await copySkillToWorkspace('chat_a', skill, ['.']);
  assert.equal(repeated.workspacePath, skill.id + '/copy-2');
  assert.notEqual((await chatDatabase.readWorkspace('chat_a')).revision, beforeRetry);
  await assert.rejects(copySkillToWorkspace('chat_a', skill, ['scripts', '../outputs']), /skill-relative/);
  await assert.rejects(copySkillToWorkspace('chat_a', skill, ['assets/missing']), /does not exist/);
  const beforeDeniedCommit = (await chatDatabase.readWorkspace('chat_a')).revision;
  await assert.rejects(copySkillToWorkspace('chat_a', skill, ['.'], undefined, async () => {
    throw new Error('Authorization revoked at commit');
  }), /Authorization revoked at commit/);
  assert.equal((await chatDatabase.readWorkspace('chat_a')).revision, beforeDeniedCommit);
  await assert.rejects(withPythonWorkspace(py.FS, 'chat_a', async () => {
    py.runPython('from pathlib import Path\nPath("outputs/revoked.txt").touch()');
    return { ok: true };
  }, undefined, async () => { throw new Error('Environment changed at commit'); }), /Environment changed at commit/);
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/revoked.txt'), null);
  await assert.rejects(copySkillToWorkspace('deleted_chat', skill, ['.']), /no longer exists/);
  assert.equal(await chatDatabase.readWorkspace('chat_b'), undefined);
  const request = parsePythonScriptRequest({
    path: copied.workspacePath + '/scripts/report.py', cwd: copied.workspacePath, argv: ['hello world', '$literal'],
    env: { REPORT_FORMAT: 'text' }, stdin: 'from stdin\n',
  });
  assert.throws(() => parsePythonScriptRequest({ path: '../outside.py' }), /workspace-relative/);
  assert.throws(() => parsePythonScriptRequest({ path: 'file.py', env: { API_KEY: 'secret' } }), /non-secret/);
  assert.throws(() => parsePythonScriptRequest({ path: 'file.py', argv: ['bad\0value'] }), /without NUL/);
  let stdout = '';
  py.setStdout({ batched: line => { stdout += line; } });
  await withPythonWorkspace(py.FS, 'chat_a', async () => {
    await runWorkspaceScript(py, { ...request, preflight: true }, () => assert.fail('Preflight must not load imports'));
    return { ok: false };
  });
  const plan = JSON.parse(stdout);
  assert.deepEqual(plan.envReferences, ['AGENTNEXUS_WORKSPACE', 'REPORT_FORMAT']);
  assert.deepEqual(plan.unsetEnvReferences, []);
  assert.deepEqual(plan.imports, []);
  assert.equal(plan.scannedFiles, 2);
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/skill.txt'), null);
  await withPythonWorkspace(py.FS, 'chat_a', async () => {
    await runWorkspaceScript(py, request, () => assert.fail('Local modules must not request packages'));
    assert.equal(py.runPython('__import__("os").getenv("REPORT_FORMAT") is None'), true);
    return { ok: true };
  });
  assert.equal(await (await readWorkspaceOutput('chat_a', 'outputs/skill.txt')).text(), 'from stdin / local import');
  // Reusing the interpreter must observe edited local helpers, even with identical byte length.
  await run('chat_a', `Path('cache-helper.py').write_text('from pathlib import Path\\nimport cached_helper\\nPath("outputs/cache.txt").write_text(cached_helper.value)\\n')
Path('cached_helper.py').write_text('value = "first"\\n')`);
  const cacheRequest = parsePythonScriptRequest({ path: 'cache-helper.py' });
  const runCache = () => withPythonWorkspace(py.FS, 'chat_a', async () => {
    await runWorkspaceScript(py, cacheRequest, async () => {});
    return { ok: true };
  });
  await runCache();
  await run('chat_a', `Path('cached_helper.py').write_text('value = "other"\\n')`);
  await runCache();
  assert.equal(await (await readWorkspaceOutput('chat_a', 'outputs/cache.txt')).text(), 'other');
  assert.ok(!(await chatDatabase.readWorkspace('chat_a')).entries.some(entry => entry.path.includes('__pycache__')));
  await withPythonWorkspace(py.FS, 'chat_a', async () => {
    const script = parsePythonScriptRequest({
      path: copied.workspacePath + '/src/report_package/__main__.py', cwd: copied.workspacePath, module: 'report_package',
    });
    await runWorkspaceScript(py, script, () => assert.fail('Package imports must stay local'));
    await assert.rejects(runWorkspaceScript(py, { ...script, module: 'other_package' }, async () => {}), /do not refer/);
    return { ok: true };
  });
  await assert.rejects(withPythonWorkspace(py.FS, 'chat_a', async () => {
    await runWorkspaceScript(py, { ...request, path: copied.workspacePath + '/scripts/fail.py' }, async () => {});
    return { ok: true };
  }), /Script exited with status 17/);
  assert.equal(await readWorkspaceOutput('chat_a', 'outputs/should-not-exist'), null);
  await run('chat_a', `Path(${JSON.stringify(copied.workspacePath + '/assets/fixture.bin')}).write_bytes(b'edited')`);
  await copySkillToWorkspace('chat_a', skill, ['assets']);
  await run('chat_a', `assert Path(${JSON.stringify(copied.workspacePath + '/assets/fixture.bin')}).read_bytes() == b'edited'`);
  const afterEdit = (await chatDatabase.readWorkspace('chat_a')).revision;
  await assert.rejects(copySkillToWorkspace('chat_a', skill, ['.'], AbortSignal.abort()), { name: 'AbortError' });
  assert.equal((await chatDatabase.readWorkspace('chat_a')).revision, afterEdit);
  await run('chat_a', `from pathlib import Path
root = Path(${JSON.stringify(copied.workspacePath)})
(root / 'assets' / 'fixture.bin').unlink()
(root / 'assets').rmdir()
(root / 'assets').write_text('occupied')
`);
  const conflict = (await chatDatabase.readWorkspace('chat_a')).revision;
  const fallback = await copySkillToWorkspace('chat_a', skill, ['assets']);
  assert.notEqual(fallback.workspacePath, copied.workspacePath);
  assert.notEqual((await chatDatabase.readWorkspace('chat_a')).revision, conflict);

  // This optional probe downloads wheels. Keep the regular suite deterministic and offline.
  if (process.env.AGENTNEXUS_TEST_SKILL_NETWORK === '1') {
    const localWheel = zipSync({
      'agentnexus_fixture/__init__.py': strToU8('answer = 42\n'),
      'agentnexus_fixture-1.0.dist-info/METADATA': strToU8('Metadata-Version: 2.1\nName: agentnexus-fixture\nVersion: 1.0\n'),
      'agentnexus_fixture-1.0.dist-info/WHEEL': strToU8('Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n'),
      'agentnexus_fixture-1.0.dist-info/RECORD': strToU8(
        'agentnexus_fixture/__init__.py,,\nagentnexus_fixture-1.0.dist-info/METADATA,,\n' +
        'agentnexus_fixture-1.0.dist-info/WHEEL,,\nagentnexus_fixture-1.0.dist-info/RECORD,,\n'),
    });
    const dependencySkill = await copySkillToWorkspace('chat_b', {
      id: '1002',
      files: {
        'SKILL.md': '# Dependencies',
        'test.py': 'from agentnexus_fixture import answer\nassert answer == 42',
        'remote.py': 'import snowballstemmer\nassert snowballstemmer.stemmer("english").stemWord("walking") == "walk"',
      },
      resourceBytes: { 'wheels/本地 wheel/agentnexus_fixture-1.0-py3-none-any.whl': encodeSkillBytes(localWheel) },
    }, ['.']);
    const runWithDependencies = options => withPythonWorkspace(py.FS, 'chat_b', async () => {
      const request = parsePythonScriptRequest(options);
      await runWorkspaceScript(py, request, source => py.loadPackagesFromImports(source));
      return { ok: true };
    });
    const { workspacePath } = dependencySkill;
    await runWithDependencies({
      path: workspacePath === '.' ? 'test.py' : workspacePath + '/test.py',
      wheels: [(workspacePath === '.' ? '' : workspacePath + '/') + 'wheels/本地 wheel/agentnexus_fixture-1.0-py3-none-any.whl'],
      requirements: ['agentnexus-fixture==1.0'],
    });
    await assert.rejects(runWithDependencies({
      path: workspacePath + '/test.py', requirements: ['agentnexus-fixture==3.0'],
    }), /Unsatisfied dependencies/);
    await runWithDependencies({
      path: workspacePath === '.' ? 'remote.py' : workspacePath + '/remote.py', dependencyMode: 'pypi', requirements: ['snowballstemmer==2.2.0'],
    });
    console.log('Compatible workspace wheel and public PyPI dependency installed successfully');
  }

  console.log('Skill workspace and Pyodide script integration passed');
} finally {
  await Promise.all(['chat_a', 'chat_b'].map(chatId => chatDatabase.deleteSession(chatId)));
}
