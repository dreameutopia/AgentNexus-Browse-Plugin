<template>
  <!-- 根类 .review 是 plugins UI 测试的检索契约：首个 button 必须是「确认安装」 -->
  <section v-if="pending" class="review" :aria-label="t('hub.plugins.tabReview')">
    <header class="review__head">
      <div class="review__title-row">
        <h3 class="review__title">
          {{ pending.plugin.manifest.displayName }}
          <span class="review__version">v{{ pending.plugin.manifest.version }}</span>
        </h3>
        <span v-if="pendingRollback" class="review__rollback-tag">
          {{ t('hub.plugins.reviewRollbackNotice') }}
        </span>
      </div>
      <p class="review__publisher">
        <span class="review__publisher-name">
          {{ pending.plugin.manifest.publisher.displayName }}
        </span>
        <code class="review__key">{{ pending.plugin.key }}</code>
      </p>
    </header>

    <p class="review__note">
      {{ t('hub.plugins.reviewSignatureNote') }}
    </p>

    <div v-if="pending.changes.length" class="review__changes">
      <h4 class="review__changes-title">{{ t('hub.plugins.reviewChanges') }}</h4>
      <ul class="review__changes-list">
        <li v-for="change in pending.changes" :key="change">{{ change }}</li>
      </ul>
    </div>

    <p class="review__contribs">
      <span class="review__contribs-label">
        {{ t('hub.plugins.contribLabel') }}
      </span>
      {{
        t('hub.plugins.contribCounts', {
          tools: pending.plugin.tools.length,
          skills: pending.plugin.skills.length,
          agents: pending.plugin.agents.length,
        })
      }}
    </p>

    <details class="review__inspect">
      <summary>{{ t('hub.plugins.inspectTitle') }}</summary>
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

    <label class="review__consent">
      <input
        type="checkbox"
        :checked="consent"
        :disabled="busy"
        @change="
          emit('update:consent', ($event.target as HTMLInputElement).checked)
        "
      />
      <span>{{ t('hub.plugins.consent') }}</span>
    </label>

    <footer class="review__actions">
      <button
        type="button"
        class="hub-btn hub-btn-primary"
        :disabled="busy || !consent"
        @click="emit('install')"
      >
        {{ t('hub.plugins.installAction') }}
      </button>
      <button
        type="button"
        class="hub-btn"
        :disabled="busy"
        @click="emit('cancel')"
      >
        {{ t('hub.plugins.cancelAction') }}
      </button>
    </footer>
  </section>
</template>

<script setup lang="ts">
/**
 * 安装审查面板：导入 / GitHub 预览 / 版本回滚三条路径共用的确认视图。
 * DOM 契约（tests/plugins/ui.test.ts）：根类 .review、首个 button 为安装、
 * consent 复选框在面板内——改动结构前先对照该测试。
 */
import { t } from '@/utils/i18n';
import type { PluginPreview } from '@/utils/plugins/contracts';

withDefaults(
  defineProps<{
    pending?: PluginPreview;
    consent: boolean;
    busy: boolean;
    pendingRollback?: boolean;
  }>(),
  { pending: undefined, pendingRollback: false },
);

const emit = defineEmits<{
  'update:consent': [value: boolean];
  install: [];
  cancel: [];
}>();
</script>
