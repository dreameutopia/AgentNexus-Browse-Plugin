import { valid, rcompare, gt } from 'semver';
import { z } from 'zod';
import { canonicalize } from 'json-canonicalize';
import {
  invariant,
  LIMITS,
  PluginError,
  validatePluginKey,
  versionSchema,
  type GithubSource,
} from './contracts';
import { limitedDownload } from './network';
import { strictJson } from './json';
import { decode64, sha256 } from './codec';

export interface GithubCandidate {
  name: string;
  repository: string;
  description: string;
  version?: string;
  source?: GithubSource;
  assetUrl?: string;
  digest?: string;
  key?: string;
  verifiedCatalog?: boolean;
}
const jsonCache = new Map<string, { time: number; value: any }>();
async function github(path: string): Promise<any> {
  const cached = jsonCache.get(path);
  if (cached && Date.now() - cached.time < 300_000)
    return structuredClone(cached.value);
  const bytes = await limitedDownload(
    `https://api.github.com${path}`,
    2 * 1024 ** 2,
  );
  const value = strictJson(new TextDecoder().decode(bytes));
  if (jsonCache.size > 100) jsonCache.clear();
  jsonCache.set(path, { time: Date.now(), value });
  return value;
}
export function parseGithubRepository(value: string): {
  owner: string;
  repo: string;
} {
  const url = new URL(value);
  invariant(
    url.protocol === 'https:' &&
      url.hostname === 'github.com' &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash,
    'INVALID_GITHUB_URL',
    value,
  );
  const parts = url.pathname.split('/').filter(Boolean);
  invariant(
    parts.length >= 2 &&
      /^[\w.-]+$/.test(parts[0]) &&
      /^[\w.-]+$/.test(parts[1]),
    'INVALID_GITHUB_URL',
  );
  return { owner: parts[0], repo: parts[1].replace(/\.git$/, '') };
}
export async function searchGithub(query: string): Promise<GithubCandidate[]> {
  invariant(query.length <= 100, 'SEARCH_LIMIT');
  const result = await github(
    `/search/repositories?q=${encodeURIComponent(`topic:agentnexus-plugin ${query}`)}&per_page=20`,
  );
  invariant(Array.isArray(result.items), 'INVALID_GITHUB_RESPONSE');
  return result.items.map((r: any) => ({
    name: String(r.full_name),
    repository: String(r.html_url),
    description: String(r.description ?? ''),
  }));
}
export async function githubRelease(
  repository: string,
  installedVersion?: string,
  expectedRepoId?: number,
): Promise<GithubCandidate> {
  const { owner, repo } = parseGithubRepository(repository),
    prefix = `/repos/${owner}/${repo}`;
  const info = await github(prefix);
  invariant(
    Number.isSafeInteger(info.id) &&
      (!expectedRepoId || expectedRepoId === info.id),
    'GITHUB_REPOSITORY_CHANGED',
  );
  const releases: any[] = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await github(`${prefix}/releases?per_page=100&page=${page}`);
    invariant(Array.isArray(batch), 'INVALID_GITHUB_RESPONSE');
    releases.push(...batch);
    if (batch.length < 100) break;
  }
  const candidates = releases
    .filter(
      (r) =>
        !r.draft &&
        !r.prerelease &&
        valid(String(r.tag_name).replace(/^v/, '')) &&
        !String(r.tag_name).includes('+'),
    )
    .sort((a, b) =>
      rcompare(
        String(a.tag_name).replace(/^v/, ''),
        String(b.tag_name).replace(/^v/, ''),
      ),
    );
  for (const release of candidates) {
    const version = String(release.tag_name).replace(/^v/, '');
    if (installedVersion && !gt(version, installedVersion)) continue;
    const assets =
      release.assets?.filter((a: any) =>
        String(a.name).endsWith('.anplugin'),
      ) ?? [];
    invariant(assets.length <= 1, 'AMBIGUOUS_RELEASE_ASSET');
    if (!assets.length) continue;
    const asset = assets[0];
    invariant(
      asset.size <= LIMITS.archive &&
        /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? ''),
      'GITHUB_DIGEST_REQUIRED',
    );
    const url = new URL(asset.browser_download_url);
    invariant(
      url.hostname === 'github.com' && url.protocol === 'https:',
      'INVALID_GITHUB_ASSET',
    );
    return {
      name: info.full_name,
      description: info.description ?? '',
      repository: `https://github.com/${owner}/${repo}`,
      version,
      source: { owner, repo, repositoryId: info.id },
      assetUrl: url.href,
      digest: asset.digest.slice(7),
    };
  }
  throw new Error(
    installedVersion ? 'NO_UPDATE_AVAILABLE' : 'NO_PLUGIN_RELEASE',
  );
}
export async function downloadCandidate(
  candidate: GithubCandidate,
): Promise<Uint8Array> {
  invariant(candidate.assetUrl && candidate.digest, 'INVALID_CANDIDATE');
  const bytes = await limitedDownload(
    candidate.assetUrl,
    LIMITS.archive,
    undefined,
    true,
  );
  invariant(
    (await sha256(bytes)) === candidate.digest,
    'DOWNLOAD_DIGEST_MISMATCH',
  );
  return bytes;
}
export const catalogSchema = z
  .object({
    version: z.literal(1),
    sequence: z.number().int().nonnegative(),
    expiresAt: z.string().datetime(),
    plugins: z
      .array(
        z
          .object({
            key: z
              .string()
              .max(256)
              .refine((key) => {
                try {
                  validatePluginKey(key);
                  return true;
                } catch {
                  return false;
                }
              }),
            name: z.string().max(128),
            description: z.string().max(1024),
            repository: z.string().url(),
            version: versionSchema,
            digest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .max(5000),
    signature: z.string().max(128),
  })
  .strict();
export async function fetchCatalog(
  url: string,
  publicKey64: string,
  minimumSequence: number,
): Promise<{ sequence: number; plugins: GithubCandidate[] }> {
  const rawBytes = await limitedDownload(url, 4 * 1024 ** 2);
  let textValue: string;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(rawBytes);
  } catch {
    throw new PluginError('INVALID_UTF8', 'catalog');
  }
  const raw = strictJson(textValue),
    result = catalogSchema.safeParse(raw);
  if (!result.success)
    throw new PluginError(
      'INVALID_CATALOG',
      result.error.issues
        .slice(0, 8)
        .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
        .join('; '),
    );
  const { signature, ...payload } = result.data;
  invariant(
    new Set(payload.plugins.map((p) => p.key)).size === payload.plugins.length,
    'DUPLICATE_CATALOG_PLUGIN',
  );
  invariant(
    Date.parse(payload.expiresAt) > Date.now() &&
      payload.sequence >= minimumSequence,
    'CATALOG_EXPIRED_OR_REPLAYED',
  );
  const bytes = decode64(publicKey64);
  invariant(bytes.length === 32, 'INVALID_CATALOG_KEY');
  const key = await crypto.subtle.importKey(
    'raw',
    bytes as BufferSource,
    'Ed25519',
    false,
    ['verify'],
  );
  invariant(
    await crypto.subtle.verify(
      'Ed25519',
      key,
      decode64(signature) as BufferSource,
      new TextEncoder().encode(
        'AgentNexusCatalog/v1\n' + canonicalize(payload),
      ),
    ),
    'INVALID_CATALOG_SIGNATURE',
  );
  return {
    sequence: payload.sequence,
    plugins: payload.plugins.map((p) => ({ ...p, verifiedCatalog: true })),
  };
}
