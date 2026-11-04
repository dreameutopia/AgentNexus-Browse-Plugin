#!/usr/bin/env node
import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { generateKeyPairSync, createPrivateKey, sign } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cache = path.join(root, 'node_modules/.cache/agentnexus-plugin-sdk.mjs');
await fs.mkdir(path.dirname(cache), { recursive: true });
await build({
  entryPoints: [path.join(root, 'scripts/plugin-sdk.ts')],
  outfile: cache,
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  logLevel: 'silent',
});
const sdk = await import(pathToFileURL(cache).href);
const [command, target, ...rest] = process.argv.slice(2);
const option = (name, fallback) => {
  const i = rest.indexOf(name);
  return i < 0 ? fallback : rest[i + 1];
};
const app = JSON.parse(
  await fs.readFile(path.join(root, 'package.json'), 'utf8'),
).version;
async function writeNew(file, text, mode = 0o644) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, { flag: 'wx', mode });
}
try {
  if (command === 'init') {
    if (!target) throw new Error('Usage: plugin-cli init <new-directory>');
    const dir = path.resolve(target),
      id = path.basename(dir);
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(id) || id.length > 48)
      throw new Error('Directory name must be a plugin slug');
    try {
      await fs.access(dir);
      throw new Error('Target directory already exists');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    const pair = generateKeyPairSync('ed25519'),
      publicKey = pair.publicKey.export({ format: 'jwk' }),
      raw = Buffer.from(publicKey.x, 'base64url');
    const keyFile = path.resolve(`${dir}.publisher-key.json`);
    await writeNew(
      keyFile,
      JSON.stringify(pair.privateKey.export({ format: 'jwk' }), null, 2),
      0o600,
    );
    const manifest = {
      manifestVersion: 1,
      publisher: {
        id: `ed25519:${sdk.base32(raw)}`,
        displayName: 'Your studio',
      },
      id,
      displayName: id,
      version: '1.0.0',
      engines: { agentnexus: '>=0.0.1 <1.0.0', pluginApi: '^1.0.0' },
      license: 'MIT',
      capabilities: {
        network: [],
        hostTools: ['builtin/browser_get_page_text'],
        secretSlots: [],
      },
      contributes: {
        tools: [{ id: 'read-page', path: 'tools/read-page.json' }],
        skills: [{ id: 'research', path: 'skills/research/SKILL.md' }],
        agents: [{ id: 'researcher', path: 'agents/researcher.json' }],
      },
      dependencies: {},
      optionalDependencies: {},
    };
    await writeNew(
      path.join(dir, 'plugin.json'),
      JSON.stringify(manifest, null, 2),
    );
    await writeNew(
      path.join(dir, 'tools/read-page.json'),
      JSON.stringify(
        {
          description: 'Read the current page for research.',
          inputSchema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          executor: {
            type: 'host-alias',
            target: 'builtin/browser_get_page_text',
          },
        },
        null,
        2,
      ),
    );
    await writeNew(
      path.join(dir, 'skills/research/SKILL.md'),
      '---\nname: research\ndescription: Research a page and cite evidence.\nallowed-tools: ./read-page\n---\nUse {{tool:read-page}} to read the page, then cite evidence in the answer.\n',
    );
    await writeNew(
      path.join(dir, 'agents/researcher.json'),
      JSON.stringify(
        {
          name: 'Researcher',
          description: 'Evidence-based webpage research',
          system:
            'Use {{tool:read-page}} to inspect the page before answering.',
          tools: ['./read-page'],
          skills: ['./research'],
        },
        null,
        2,
      ),
    );
    await writeNew(
      path.join(dir, 'README.md'),
      `# ${id}\n\nReview plugin.json before publishing. Never commit the publisher private key.\n`,
    );
    await writeNew(
      path.join(dir, '.gitignore'),
      '*.anplugin\n*publisher-key*\n',
    );
    console.log(
      `Created ${dir}\nPrivate publisher key: ${keyFile}\nKeep this key private and backed up. Reuse it for every update.`,
    );
  } else if (command === 'pack') {
    if (!target || !option('--key'))
      throw new Error(
        'Usage: plugin-cli pack <directory> --key <private-jwk-file> [--out <file>]',
      );
    const dir = path.resolve(target),
      keyPath = path.resolve(option('--key'));
    if (keyPath.startsWith(dir + path.sep))
      throw new Error('Private key must be outside the plugin directory');
    const files = Object.create(null);
    let count = 0,
      size = 0;
    async function walk(folder, prefix = '') {
      for (const entry of (
        await fs.readdir(folder, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
        if (entry.name.startsWith('.') || entry.name.endsWith('.anplugin'))
          continue;
        if (entry.isSymbolicLink()) throw new Error('Symlinks are prohibited');
        const rel = prefix + entry.name,
          full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full, rel + '/');
        else {
          if (['signature.json', 'integrity.json'].includes(rel)) continue;
          const stat = await fs.stat(full);
          if (
            ++count > 500 ||
            stat.size > 5 * 1024 ** 2 ||
            (size += stat.size) > 30 * 1024 ** 2
          )
            throw new Error('Package limit exceeded');
          files[rel] = new Uint8Array(await fs.readFile(full));
        }
      }
    }
    await walk(dir);
    const integrity = {
      version: 1,
      files: await Promise.all(
        Object.keys(files)
          .sort()
          .map(async (path) => ({
            path,
            size: files[path].length,
            sha256: await sdk.sha256(files[path]),
          })),
      ),
    };
    const privateKey = createPrivateKey({
      key: JSON.parse(await fs.readFile(keyPath, 'utf8')),
      format: 'jwk',
    });
    const jwk = privateKey.export({ format: 'jwk' });
    if (jwk.crv !== 'Ed25519')
      throw new Error('Ed25519 publisher key required');
    const signature = sign(
      null,
      Buffer.from('AgentNexusPlugin/v1\n' + sdk.canonicalize(integrity)),
      privateKey,
    );
    files['integrity.json'] = sdk.strToU8(sdk.canonicalize(integrity));
    files['signature.json'] = sdk.strToU8(
      sdk.canonicalize({
        algorithm: 'Ed25519',
        publicKey: Buffer.from(jwk.x, 'base64url').toString('base64'),
        signature: signature.toString('base64'),
      }),
    );
    const entries = Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [
          name,
          [files[name], { mtime: new Date('2000-01-01T00:00:00Z'), os: 0 }],
        ]),
    );
    const bytes = sdk.zipSync(entries, { level: 6 }),
      verified = await sdk.verifyPackage(bytes, option('--host-version', app));
    const out = path.resolve(
      option('--out', `${dir}-${verified.manifest.version}.anplugin`),
    );
    await writeNew(out, bytes);
    console.log(`${out}\nSHA-256: ${verified.digest}`);
  } else if (command === 'validate') {
    if (!target) throw new Error('Usage: plugin-cli validate <file.anplugin>');
    const plugin = await sdk.verifyPackage(
      new Uint8Array(await fs.readFile(target)),
      option('--host-version', app),
    );
    console.log(
      `Valid: ${plugin.key}@${plugin.manifest.version}\nSHA-256: ${plugin.digest}`,
    );
  } else if (command === 'catalog-sign') {
    if (!target || !option('--key') || !option('--out'))
      throw new Error(
        'Usage: plugin-cli catalog-sign <unsigned-catalog.json> --key <private-jwk-file> --out <catalog.json>',
      );
    const payload = sdk.catalogSchema
      .omit({ signature: true })
      .parse(sdk.strictJson(await fs.readFile(target, 'utf8')));
    const privateKey = createPrivateKey({
      key: JSON.parse(await fs.readFile(option('--key'), 'utf8')),
      format: 'jwk',
    });
    const signature = sign(
      null,
      Buffer.from('AgentNexusCatalog/v1\n' + sdk.canonicalize(payload)),
      privateKey,
    ).toString('base64');
    await writeNew(
      path.resolve(option('--out')),
      sdk.canonicalize({ ...payload, signature }) + '\n',
    );
    console.log(
      'Signed catalog written. Publish its public key through an independent trusted channel.',
    );
  } else if (command === 'schemas') {
    const dir = path.resolve(target ?? path.join(root, 'docs/plugin-schemas'));
    await fs.mkdir(dir, { recursive: true });
    for (const [name, schema] of [
      ['plugin', sdk.manifestSchema],
      ['tool', sdk.toolSchema],
      ['agent', sdk.agentSchema],
    ])
      await fs.writeFile(
        path.join(dir, `${name}-v1.json`),
        JSON.stringify(sdk.zodToJsonSchema(schema, name), null, 2) + '\n',
      );
    console.log(`Schemas written to ${dir}`);
  } else
    throw new Error('Commands: init, pack, validate, schemas, catalog-sign');
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
