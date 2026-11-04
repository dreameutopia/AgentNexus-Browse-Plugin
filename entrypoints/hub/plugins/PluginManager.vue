<template>
  <section class="plugin-manager" :aria-busy="busy">
    <h2>{{ tr('插件中心', 'Plugins') }}</h2>
    <p>
      {{
        tr(
          '插件可提供工具、Skill 和智能体。安装前请核对发布者身份及所需权限。',
          'Plugins contribute tools, skills and agents. Review publisher identity and permissions before installing.',
        )
      }}
    </p>
    <div class="toolbar">
      <label class="hub-btn"
        >{{ tr('导入 .anplugin', 'Import .anplugin')
        }}<input
          type="file"
          accept=".anplugin"
          :disabled="busy"
          @change="importFile"
      /></label>
      <button class="hub-btn" :disabled="busy" @click="run(load)">
        {{ tr('刷新', 'Refresh') }}
      </button>
      <input
        v-model="repository"
        placeholder="https://github.com/owner/repository"
        :disabled="busy"
      />
      <button
        class="hub-btn"
        :disabled="busy || !repository"
        @click="previewGithub(repository)"
      >
        {{ tr('从 GitHub 安装', 'Install from GitHub') }}
      </button>
    </div>
    <p v-if="error" role="alert" class="error">{{ error }}</p>
    <p v-if="notice" role="status">{{ notice }}</p>
    <section v-if="pending" class="review">
      <h3>
        {{ pending.plugin.manifest.displayName }} ·
        {{ pending.plugin.manifest.version }}
      </h3>
      <p>{{ pending.plugin.manifest.publisher.displayName }}</p>
      <code>{{ pending.plugin.key }}</code>
      <p>
        {{
          tr(
            '签名有效仅证明发布者身份连续性，不代表插件已经通过官方审核。',
            'A valid signature proves publisher continuity; it does not imply official review.',
          )
        }}
      </p>
      <ul>
        <li v-for="change in pending.changes" :key="change">{{ change }}</li>
      </ul>
      <p>
        {{ tr('贡献', 'Contributions') }}:
        {{ pending.plugin.tools.length }} tools ·
        {{ pending.plugin.skills.length }} skills ·
        {{ pending.plugin.agents.length }} agents
      </p>
      <details>
        <summary>
          {{
            tr(
              '检查工具定义与智能体指令',
              'Inspect tool contracts and agent instructions',
            )
          }}
        </summary>
        <pre>{{
          JSON.stringify(
            {
              tools: pending.plugin.tools,
              agents: pending.plugin.agents,
              skills: pending.plugin.skills.map((s) => ({
                ref: s.ref,
                body: s.body,
                allowedTools: s.allowedTools,
              })),
            },
            null,
            2,
          )
        }}</pre>
      </details>
      <label
        ><input v-model="consent" type="checkbox" />{{
          tr(
            '我已核对身份、内容和权限，同意安装或更新',
            'I reviewed identity, content and permissions and approve installation or update',
          )
        }}</label
      >
      <div class="toolbar">
        <button
          class="hub-btn hub-btn-primary"
          :disabled="busy || !consent"
          @click="install"
        >
          {{ tr('确认安装 / 更新', 'Install / update') }}</button
        ><button class="hub-btn" :disabled="busy" @click="clearPreview">
          {{ tr('取消', 'Cancel') }}
        </button>
      </div>
    </section>
    <details>
      <summary>{{ tr('搜索插件', 'Discover plugins') }}</summary>
      <div class="toolbar">
        <input
          v-model="query"
          :placeholder="tr('GitHub 社区搜索', 'Search GitHub community')"
        /><button class="hub-btn" :disabled="busy" @click="search">
          {{ tr('搜索', 'Search') }}
        </button>
      </div>
      <p>
        {{
          tr(
            '社区结果未经审核；GitHub API 限流或离线不会影响已安装插件。',
            'Community results are unreviewed. GitHub rate limits and offline access do not affect installed plugins.',
          )
        }}
      </p>
      <details>
        <summary>{{ tr('已验证的目录来源', 'Signed catalog source') }}</summary>
        <input
          v-model="catalogUrl"
          placeholder="https://…/catalog.json"
        /><input
          v-model="catalogKey"
          :placeholder="
            tr(
              '独立可信渠道取得的目录公钥（Base64）',
              'Catalog public key from an independently trusted source (Base64)',
            )
          "
        />
        <button
          class="hub-btn"
          :disabled="busy || !catalogUrl || !catalogKey"
          @click="catalog"
        >
          {{ tr('加载签名目录', 'Load signed catalog') }}
        </button>
      </details>
      <article
        v-for="item in results"
        :key="item.repository"
        class="plugin-card"
      >
        <strong>{{ item.name }}</strong
        ><span>{{
          item.verifiedCatalog
            ? tr('签名目录', 'Signed catalog')
            : tr('社区', 'Community')
        }}</span>
        <p>{{ item.description }}</p>
        <a :href="item.repository" target="_blank" rel="noopener noreferrer">{{
          item.repository
        }}</a
        ><button
          class="hub-btn"
          :disabled="busy"
          @click="previewGithub(item.repository, undefined, item)"
        >
          {{ tr('检查并安装', 'Review and install') }}
        </button>
      </article>
    </details>
    <input
      v-model="filter"
      type="search"
      :placeholder="tr('筛选已安装插件', 'Filter installed plugins')"
    />
    <p v-if="!snapshot.packages.length">
      {{
        tr(
          '尚未安装插件。可导入文件或使用 GitHub Release。',
          'No installed plugins. Import a file or install a GitHub Release.',
        )
      }}
    </p>
    <article v-for="plugin in installed" :key="plugin.key" class="plugin-card">
      <strong
        >{{ plugin.manifest.displayName }} ·
        {{ plugin.manifest.version }}</strong
      >
      <span>{{
        plugin.blocked ||
        (plugin.enabled ? tr('已启用', 'Enabled') : tr('已禁用', 'Disabled'))
      }}</span>
      <p>
        {{ plugin.manifest.publisher.displayName }} ·
        {{
          plugin.source
            ? `GitHub: ${plugin.source.owner}/${plugin.source.repo}`
            : tr('本地导入', 'File import')
        }}
      </p>
      <code>{{ plugin.key }}</code>
      <p>
        {{ plugin.tools.length }} tools · {{ plugin.skills.length }} skills ·
        {{ plugin.agents.length }} agents
      </p>
      <div class="toolbar">
        <button class="hub-btn" :disabled="busy" @click="toggle(plugin)">
          {{ plugin.enabled ? tr('禁用', 'Disable') : tr('启用', 'Enable') }}
        </button>
        <button
          v-if="plugin.source"
          class="hub-btn"
          :disabled="busy"
          @click="
            previewGithub(
              `https://github.com/${plugin.source.owner}/${plugin.source.repo}`,
              plugin.key,
            )
          "
        >
          {{ tr('检查更新', 'Check update') }}
        </button>
        <button class="hub-btn" :disabled="busy" @click="exportPlugin(plugin)">
          {{ tr('导出安装包', 'Export package') }}
        </button>
        <button class="hub-btn" :disabled="busy" @click="listVersions(plugin)">
          {{ tr('历史版本', 'Version history') }}
        </button>
        <button class="hub-btn" :disabled="busy" @click="remove(plugin)">
          {{ tr('卸载', 'Uninstall') }}
        </button>
      </div>
      <div v-if="versions[plugin.key]" class="toolbar">
        <button
          v-for="version in versions[plugin.key]"
          :key="version.version"
          class="hub-btn"
          :disabled="busy || version.version === plugin.manifest.version"
          @click="rollback(plugin.key, version.version)"
        >
          {{ tr('恢复', 'Restore') }} {{ version.version }}
        </button>
      </div>
      <details v-if="plugin.manifest.capabilities.secretSlots.length">
        <summary>
          {{
            tr(
              '服务凭据（不包含在备份中）',
              'Service credentials (excluded from backups)',
            )
          }}
        </summary>
        <label
          v-for="slot in plugin.manifest.capabilities.secretSlots"
          :key="slot"
          >{{ slot
          }}<input
            v-model="secrets[`${plugin.key}/${slot}`]"
            type="password"
            autocomplete="off"
          /><button
            class="hub-btn"
            :disabled="busy"
            @click="saveSecret(plugin.key, slot)"
          >
            {{ tr('保存 / 清除', 'Save / clear') }}
          </button></label
        >
      </details>
    </article>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { useLocale } from '@/utils/i18n';
import {
  pluginRequest,
  encodeBytes,
  startPluginClient,
} from '@/utils/plugins/client';
import {
  getPluginSnapshot,
  onPluginsChange,
  applyPluginSnapshot,
} from '@/utils/plugins/catalog';
import {
  invariant,
  LIMITS,
  type InstalledPlugin,
  type PluginPreview,
} from '@/utils/plugins/contracts';
import type { GithubCandidate } from '@/utils/plugins/github';
const { locale } = useLocale();
const tr = (zh: string, en: string) => (locale.value === 'en' ? en : zh);
const snapshot = ref(getPluginSnapshot()),
  busy = ref(false),
  error = ref(''),
  notice = ref(''),
  repository = ref(''),
  query = ref(''),
  filter = ref('');
const pending = ref<PluginPreview>(),
  consent = ref(false),
  pendingData = ref(''),
  pendingRepository = ref(''),
  results = ref<GithubCandidate[]>([]),
  catalogUrl = ref(''),
  catalogKey = ref(''),
  secrets = ref<Record<string, string>>({});
const pendingRollback = ref(false),
  versions = ref<Record<string, { version: string; digest: string }[]>>({});
onUnmounted(
  onPluginsChange(() => {
    snapshot.value = getPluginSnapshot();
  }),
);
const installed = computed(() =>
  snapshot.value.packages.filter((p) =>
    `${p.key} ${p.manifest.displayName} ${p.manifest.publisher.displayName}`
      .toLowerCase()
      .includes(filter.value.toLowerCase()),
  ),
);
async function run(action: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  notice.value = '';
  try {
    await action();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function load() {
  await startPluginClient();
  snapshot.value = await pluginRequest('snapshot');
  applyPluginSnapshot(snapshot.value);
}
onMounted(() => {
  void run(load);
});
function clearPreview() {
  pending.value = undefined;
  pendingData.value = '';
  pendingRepository.value = '';
  consent.value = false;
  pendingRollback.value = false;
}
async function importFile(event: Event) {
  const input = event.target as HTMLInputElement,
    file = input.files?.[0];
  input.value = '';
  if (!file) return;
  await run(async () => {
    clearPreview();
    invariant(file.size <= LIMITS.archive, 'ARCHIVE_LIMIT');
    pendingData.value = encodeBytes(new Uint8Array(await file.arrayBuffer()));
    pending.value = await pluginRequest('preview', { data: pendingData.value });
  });
}
async function previewGithub(
  url: string,
  key?: string,
  expected?: GithubCandidate,
) {
  await run(async () => {
    clearPreview();
    const result = await pluginRequest('github-preview', {
      repository: url,
      ...(key ? { key } : {}),
    });
    if (expected?.verifiedCatalog)
      invariant(
        result.preview.plugin.key === expected.key &&
          result.preview.plugin.digest === expected.digest &&
          result.preview.plugin.manifest.version === expected.version,
        'CATALOG_RELEASE_MISMATCH',
      );
    pending.value = result.preview;
    pendingRepository.value = url;
  });
}
async function install() {
  await run(async () => {
    invariant(pending.value && consent.value, 'CONSENT_REQUIRED');
    const p = pending.value;
    if (pendingRollback.value)
      await pluginRequest('rollback-install', {
        key: p.plugin.key,
        version: p.plugin.manifest.version,
        generation: p.generation,
        digest: p.plugin.digest,
      });
    else
      await pluginRequest(
        pendingRepository.value ? 'github-install' : 'install',
        pendingRepository.value
          ? {
              repository: pendingRepository.value,
              key: p.plugin.key,
              generation: p.generation,
              digest: p.plugin.digest,
            }
          : {
              data: pendingData.value,
              generation: p.generation,
              digest: p.plugin.digest,
            },
      );
    clearPreview();
    await load();
    notice.value = tr('插件已生效。', 'Plugin is ready.');
  });
}
async function listVersions(p: InstalledPlugin) {
  await run(async () => {
    versions.value[p.key] = await pluginRequest('versions', { key: p.key });
  });
}
async function rollback(key: string, version: string) {
  await run(async () => {
    clearPreview();
    pending.value = await pluginRequest('rollback-preview', { key, version });
    pendingRollback.value = true;
  });
}
async function toggle(p: InstalledPlugin) {
  await run(async () => {
    await pluginRequest('enable', {
      key: p.key,
      enabled: !p.enabled,
      generation: snapshot.value.generation,
    });
    await load();
  });
}
async function remove(p: InstalledPlugin) {
  if (
    !window.confirm(
      tr(
        `卸载 ${p.manifest.displayName}？将撤销工具并删除该插件凭据；依赖它的插件可能不可用。`,
        `Uninstall ${p.manifest.displayName}? Tools and credentials will be removed; dependent plugins may become unavailable.`,
      ),
    )
  )
    return;
  await run(async () => {
    await pluginRequest('uninstall', {
      key: p.key,
      generation: snapshot.value.generation,
    });
    await load();
  });
}
async function search() {
  await run(async () => {
    results.value = await pluginRequest('search', { query: query.value });
  });
}
async function catalog() {
  await run(async () => {
    results.value = await pluginRequest('catalog', {
      url: catalogUrl.value,
      publicKey: catalogKey.value,
    });
  });
}
async function saveSecret(key: string, slot: string) {
  await run(async () => {
    const id = `${key}/${slot}`;
    await pluginRequest('secret', {
      key,
      slot,
      value: secrets.value[id] ?? '',
    });
    delete secrets.value[id];
    notice.value = tr('凭据已更新。', 'Credentials updated.');
  });
}
async function exportPlugin(p: InstalledPlugin) {
  await run(async () => {
    const data = await pluginRequest<string>('export', { key: p.key });
    const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0)),
      url = URL.createObjectURL(new Blob([bytes]));
    const a = document.createElement('a');
    a.href = url;
    a.download = `${p.manifest.id}-${p.manifest.version}.anplugin`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
</script>
<style scoped>
.plugin-manager {
  display: grid;
  gap: 16px;
}
.toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
input:not([type='checkbox']):not([type='file']) {
  padding: 8px;
  border: 1px solid #8886;
  border-radius: 6px;
  min-width: 180px;
  flex: 1;
}
input[type='file'] {
  max-width: 230px;
  display: block;
  margin-top: 4px;
}
.plugin-card,
.review {
  border: 1px solid #8886;
  padding: 16px;
  border-radius: 10px;
  display: grid;
  gap: 8px;
}
.review {
  border-color: #628ede;
}
code,
pre {
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font-size: 11px;
}
pre {
  max-height: 320px;
  overflow: auto;
}
p {
  margin: 0;
  line-height: 1.6;
}
.error {
  color: #df6565;
}
span {
  font-size: 12px;
  opacity: 0.75;
}
label {
  display: block;
}
details > * {
  margin-top: 8px;
}
</style>
