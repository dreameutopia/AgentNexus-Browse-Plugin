#!/usr/bin/env node
/**
 * 官方插件目录构建脚本（在 AgentNexus-Browse-Plugin-Registry 仓库的 CI 中运行）。
 * 校验 plugins/ 下全部登记项并生成未签名目录 unsigned-catalog.json；
 * 签名与部署由 workflow 调用宿主仓库固定 SDK（plugin-cli catalog-sign）完成。
 *
 * 校验内容：
 * - 登记项字段格式（key / version / digest / repository / name / description）
 * - GitHub Release 资产存在、asset digest 与登记项一致
 * - 下载资产用固定 SDK 验签，比对插件身份与版本
 * - 目录序号 = 已部署 catalog.json 序号 + 1（首次部署为 0）
 *
 * 必需环境变量：GH_TOKEN、REGISTRY_DIR、SDK_DIR；可选：CATALOG_URL（已部署目录地址）。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

const registryDir = process.env.REGISTRY_DIR ?? process.cwd(),
  sdkCli = path.join(process.env.SDK_DIR ?? 'sdk', 'scripts/plugin-cli.mjs'),
  catalogUrl = process.env.CATALOG_URL,
  token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN is required');

const keyPattern = /^ed25519:[a-z2-7]{52}\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,
  semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[\w.-]+)?$/,
  digestPattern = /^[a-f0-9]{64}$/,
  repoPattern = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/;

async function api(pathname) {
  const response = await fetch(`https://api.github.com${pathname}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!response.ok)
    throw new Error(`GitHub API ${pathname}: HTTP ${response.status}`);
  return response.json();
}

const dir = path.join(registryDir, 'plugins');
const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
const plugins = [];
for (const file of files) {
  const entry = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
  if (!keyPattern.test(entry.key ?? ''))
    throw new Error(`${file}: invalid plugin key`);
  if (!semver.test(entry.version ?? ''))
    throw new Error(`${file}: invalid SemVer version (no build metadata)`);
  if (!digestPattern.test(entry.digest ?? ''))
    throw new Error(`${file}: invalid SHA-256 digest`);
  if (typeof entry.name !== 'string' || !entry.name || entry.name.length > 128)
    throw new Error(`${file}: invalid name`);
  if (
    typeof entry.description !== 'string' ||
    entry.description.length > 1024
  )
    throw new Error(`${file}: invalid description`);
  if (!repoPattern.test(entry.repository ?? ''))
    throw new Error(`${file}: repository must be https://github.com/owner/repo`);
  const [owner, repo] = entry.repository.split('/').slice(-2);
  await api(`/repos/${owner}/${repo}`); // 仓库存在且可访问
  const release = await api(
    `/repos/${owner}/${repo}/releases/tags/v${entry.version}`,
  );
  const assets = release.assets.filter((a) => a.name.endsWith('.anplugin'));
  if (assets.length !== 1)
    throw new Error(`${file}: expected exactly one .anplugin release asset`);
  if (`sha256:${entry.digest}` !== assets[0].digest)
    throw new Error(`${file}: release asset digest does not match entry`);
  // 下载资产并用固定 SDK 验签；输出行 "Valid: <key>@<version>" 必须与登记一致
  const asset = await fetch(assets[0].url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/octet-stream',
    },
  });
  if (!asset.ok) throw new Error(`${file}: asset download HTTP ${asset.status}`);
  const temp = path.join(
    process.env.RUNNER_TEMP ?? registryDir,
    `${owner}-${repo}-${entry.version}.anplugin`,
  );
  await fs.writeFile(temp, Buffer.from(await asset.arrayBuffer()));
  const output = execFileSync('node', [sdkCli, 'validate', temp], {
    encoding: 'utf8',
  });
  if (!output.includes(`Valid: ${entry.key}@${entry.version}`))
    throw new Error(`${file}: package identity mismatch\n${output}`);
  plugins.push({
    key: entry.key,
    name: entry.name,
    description: entry.description,
    repository: entry.repository,
    version: entry.version,
    digest: entry.digest,
  });
}

// 目录序号：已部署目录 + 1；读不到（首次部署 / Pages 未启用）为 0
let sequence = 0;
if (catalogUrl) {
  const deployed = await fetch(catalogUrl).catch(() => undefined);
  if (deployed?.ok) {
    const previous = JSON.parse(await deployed.text());
    sequence = (previous.sequence ?? 0) + 1;
  }
}
await fs.writeFile(
  path.join(registryDir, 'unsigned-catalog.json'),
  JSON.stringify(
    {
      version: 1,
      sequence,
      expiresAt: new Date(Date.now() + 30 * 86400_000).toISOString(),
      plugins,
    },
    null,
    2,
  ) + '\n',
);
console.log(
  `unsigned-catalog.json: ${plugins.length} plugin(s), sequence ${sequence}`,
);
