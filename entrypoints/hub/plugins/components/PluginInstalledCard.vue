<template>
  <article
    class="pc-card"
    :class="{ 'is-disabled': !plugin.enabled || !!plugin.blocked }"
  >
    <header class="pc-card__head">
      <div class="pc-card__title">
        <strong class="pc-card__name">{{ plugin.manifest.displayName }}</strong>
        <span class="pc-card__version">v{{ plugin.manifest.version }}</span>
      </div>
      <span
        v-if="update"
        class="pc-badge is-update"
        :title="t('hub.plugins.updateAvailable', { version: update.version })"
      >
        {{ t('hub.plugins.updateAvailable', { version: update.version }) }}
      </span>
      <span class="pc-badge" :class="statusClass">{{ statusText }}</span>
    </header>

    <p class="pc-card__meta">
      <span class="pc-card__publisher">{{
        plugin.manifest.publisher.displayName
      }}</span>
      <span class="pc-card__source">{{ sourceText }}</span>
    </p>

    <code class="pc-card__key">{{ plugin.key }}</code>

    <p class="pc-card__counts">
      {{
        t('hub.plugins.contribCounts', {
          tools: plugin.tools.length,
          skills: plugin.skills.length,
          agents: plugin.agents.length,
        })
      }}
    </p>

    <div class="pc-card__actions">
      <button
        type="button"
        class="hub-btn"
        :disabled="busy"
        @click="toggle(plugin)"
      >
        <Power :size="13" aria-hidden="true" />
        {{ plugin.enabled ? t('hub.plugins.actionDisable') : t('hub.plugins.actionEnable') }}
      </button>
      <button
        v-if="plugin.source"
        type="button"
        class="hub-btn"
        :disabled="busy"
        @click="
          previewGithub(
            `https://github.com/${plugin.source.owner}/${plugin.source.repo}`,
            plugin.key,
          )
        "
      >
        <RefreshCw :size="13" aria-hidden="true" />
        {{
          update
            ? t('hub.plugins.updateTo', { version: update.version })
            : t('hub.plugins.actionUpdate')
        }}
      </button>
      <button
        type="button"
        class="hub-btn"
        :disabled="busy"
        @click="exportPlugin(plugin)"
      >
        <Download :size="13" aria-hidden="true" />
        {{ t('hub.plugins.actionExport') }}
      </button>
      <button
        type="button"
        class="hub-btn"
        :disabled="busy"
        @click="listVersions(plugin)"
      >
        <History :size="13" aria-hidden="true" />
        {{ t('hub.plugins.actionVersions') }}
      </button>
      <button
        type="button"
        class="hub-btn pc-card__danger"
        :disabled="busy"
        @click="remove(plugin)"
      >
        <Trash2 :size="13" aria-hidden="true" />
        {{ t('hub.plugins.actionUninstall') }}
      </button>
    </div>

    <!-- 历史版本（点开后按需加载，恢复目标版本走审查确认） -->
    <div v-if="versions[plugin.key]" class="pc-card__versions">
      <p class="pc-hint">{{ t('hub.plugins.versionsHint') }}</p>
      <div class="pc-card__version-list">
        <button
          v-for="version in versions[plugin.key]"
          :key="version.version"
          type="button"
          class="hub-btn pc-version-chip"
          :disabled="busy || version.version === plugin.manifest.version"
          @click="rollback(plugin.key, version.version)"
        >
          {{ t('hub.plugins.actionRestore', { version: version.version }) }}
        </button>
      </div>
    </div>

    <!-- 服务凭据（按 manifest 声明的 slots 渲染；不进入备份） -->
    <details
      v-if="plugin.manifest.capabilities.secretSlots.length"
      class="pc-card__secrets"
    >
      <summary>{{ t('hub.plugins.secretsTitle') }}</summary>
      <div
        v-for="slot in plugin.manifest.capabilities.secretSlots"
        :key="slot"
        class="pc-card__secret"
      >
        <label class="pc-card__secret-label">
          <span class="pc-card__secret-slot">{{ slot }}</span>
          <input
            v-model="secrets[`${plugin.key}/${slot}`]"
            type="password"
            autocomplete="off"
            :placeholder="t('hub.plugins.secretPlaceholder')"
            :disabled="busy"
          />
        </label>
        <button
          type="button"
          class="hub-btn"
          :disabled="busy"
          @click="saveSecret(plugin.key, slot)"
        >
          {{ t('hub.plugins.secretSave') }}
        </button>
      </div>
    </details>
  </article>
</template>

<script setup lang="ts">
/**
 * 已安装插件卡片：状态徽章 / 发布者与来源 / 贡献计数 / 五项操作 /
 * 历史版本恢复 / 服务凭据编辑。状态与命令取自 usePluginCenter 模块单例。
 */
import { computed } from 'vue';
import { Download, History, Power, RefreshCw, Trash2 } from 'lucide-vue-next';
import { t } from '@/utils/i18n';
import type { InstalledPlugin } from '@/utils/plugins/contracts';
import { usePluginCenter } from '../composables/use-plugin-center';

const props = defineProps<{ plugin: InstalledPlugin }>();

const {
  busy,
  secrets,
  versions,
  updates,
  toggle,
  previewGithub,
  exportPlugin,
  listVersions,
  rollback,
  remove,
  saveSecret,
} = usePluginCenter();

/** 自动更新检查发现的新版本（无则 undefined） */
const update = computed(() => updates.value[props.plugin.key]);

/** 状态徽章文案：blocked 原文优先（领域层给的原因串），其次启用 / 禁用 */
const statusText = computed(() =>
  props.plugin.blocked ||
  (props.plugin.enabled
    ? t('hub.plugins.statusEnabled')
    : t('hub.plugins.statusDisabled')),
);

const statusClass = computed(() =>
  props.plugin.blocked
    ? 'is-blocked'
    : props.plugin.enabled
      ? 'is-on'
      : 'is-off',
);

const sourceText = computed(() =>
  props.plugin.source
    ? t('hub.plugins.sourceGithub', {
        owner: props.plugin.source.owner,
        repo: props.plugin.source.repo,
      })
    : t('hub.plugins.sourceLocal'),
);
</script>
