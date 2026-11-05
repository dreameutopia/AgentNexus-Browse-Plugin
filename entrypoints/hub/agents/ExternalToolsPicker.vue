<template>
  <!--
    外部插件工具选择器（智能体编辑器右列）。
    逻辑与旧版一致：快照数据 + 关键词过滤 + 逐工具勾选（上限/禁用门控）+ 缺失工具悬挂展示；
    视觉对齐 hub 设计语言：玻璃卡容器、自定义复选框（.hub-check）、带图标的玻璃搜索框。
  -->
  <fieldset class="hub-field external-tools">
    <legend class="hub-field-label">{{ tr('外部插件工具', 'External plugin tools') }}</legend>
    <div class="hub-search external-tools__search">
      <svg class="hub-search__icon" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M11.1 10.2a4.6 4.6 0 1 0-.9.9l3 3 .9-.9-3-3zm-4.1.3a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z" fill="currentColor" />
      </svg>
      <input
        v-model="query"
        type="search"
        class="external-tools__input"
        :placeholder="tr('搜索插件、工具或发布者', 'Search plugins, tools or publishers')"
      />
    </div>
    <p v-if="!groups.length" class="hub-hint external-tools__empty">
      {{ tr('尚未安装插件工具', 'No plugin tools installed') }}
    </p>
    <section v-for="group in groups" :key="group.key" class="external-tools__group">
      <strong class="external-tools__group-name">{{ group.manifest.displayName }} · {{ group.manifest.version }}</strong>
      <p class="external-tools__group-meta">
        {{ group.manifest.publisher.displayName }} ·
        {{
          group.source
            ? `GitHub: ${group.source.owner}/${group.source.repo}`
            : tr('本地导入', 'File import')
        }}
      </p>
      <div class="external-tools__tools">
        <label
          v-for="tool in group.tools"
          :key="tool.ref"
          class="external-tools__tool"
          :class="{ 'is-checked': modelValue.includes(tool.ref) }"
          :title="tool.ref"
        >
          <input
            class="hub-check"
            type="checkbox"
            :checked="modelValue.includes(tool.ref)"
            :disabled="
              !modelValue.includes(tool.ref) &&
              (!group.enabled || !!group.blocked || count >= max)
            "
            @change="toggle(tool.ref)"
          />
          <span class="external-tools__tool-text">
            {{ tool.id }} — {{ tool.description }}
            <small v-if="!group.enabled || group.blocked">({{ group.blocked || tr('已禁用', 'Disabled') }})</small>
          </span>
        </label>
      </div>
    </section>
    <label v-for="ref in missing" :key="ref" class="external-tools__tool missing">
      <input class="hub-check" type="checkbox" checked @change="toggle(ref)" />
      <span class="external-tools__tool-text">{{ tr('缺失工具', 'Missing tool') }}: {{ ref }}</span>
    </label>
  </fieldset>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue';
import { getPluginSnapshot, onPluginsChange } from '@/utils/plugins/catalog';
import { useLocale } from '@/utils/i18n';
const props = defineProps<{
  modelValue: string[];
  count: number;
  max: number;
}>();
const emit = defineEmits<{ 'update:modelValue': [value: string[]] }>();
const { locale } = useLocale();
const tr = (zh: string, en: string) => (locale.value === 'en' ? en : zh);
const snapshot = ref(getPluginSnapshot()),
  query = ref('');
onUnmounted(
  onPluginsChange(() => {
    snapshot.value = getPluginSnapshot();
  }),
);
const groups = computed(() =>
  snapshot.value.packages
    .map((p) => ({
      ...p,
      tools: p.tools.filter((t) =>
        `${p.manifest.displayName} ${p.manifest.publisher.displayName} ${t.id} ${t.description}`
          .toLowerCase()
          .includes(query.value.toLowerCase()),
      ),
    }))
    .filter((p) => p.tools.length),
);
const missing = computed(() =>
  props.modelValue.filter(
    (r) =>
      r.startsWith('ed25519:') &&
      !snapshot.value.packages.some((p) => p.tools.some((t) => t.ref === r)),
  ),
);
function toggle(ref: string) {
  emit(
    'update:modelValue',
    props.modelValue.includes(ref)
      ? props.modelValue.filter((v) => v !== ref)
      : [...props.modelValue, ref],
  );
}
</script>
<style scoped>
/* 玻璃卡容器：与 .hub-group 同族的材质（半透明白 + 内高光 + 柔影） */
.external-tools {
  border: 1px solid var(--glass-border, rgba(255, 255, 255, 0.78));
  border-radius: 14px;
  padding: 14px;
  min-width: 0;
  background: rgba(255, 255, 255, 0.5);
  box-shadow: var(--glass-inset, inset 0 1px 0 rgba(255, 255, 255, 0.92));
}

.external-tools__search {
  width: 100%;
  margin-top: 2px;
}

.external-tools__input {
  width: 100%;
  border: 1px solid rgba(41 40 36 / 10%);
  border-radius: 10px;
  padding: 7px 12px 7px 32px;
  font-size: 13px;
  font-family: inherit;
  color: var(--ink-primary, #292824);
  background: rgba(255, 255, 255, 0.55);
  box-shadow: inset 0 1px 2px rgba(41 40 36 / 4%);
  outline: none;
  transition: border-color 0.18s ease, box-shadow 0.18s ease, background 0.18s ease;
}

.external-tools__input:focus {
  border-color: rgba(102, 126, 234, 0.55);
  background: rgba(255, 255, 255, 0.85);
  box-shadow: 0 0 0 3.5px rgba(102, 126, 234, 0.16);
}

.external-tools__empty {
  margin: 8px 0 0;
}

.external-tools__group {
  margin-top: 12px;
}

.external-tools__group-name {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--ink-primary, #292824);
}

.external-tools__group-meta {
  margin: 2px 0 8px;
  font-size: 12px;
  color: var(--ink-secondary, #787671);
}

.external-tools__tools {
  display: grid;
  gap: 4px;
}

/* 工具行：迷你玻璃卡，选中态染品牌色（对齐 .hub-group.checked） */
.external-tools__tool {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid rgba(41 40 36 / 8%);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.18s ease, background 0.18s ease;
}

.external-tools__tool:hover {
  border-color: rgba(102, 126, 234, 0.45);
}

.external-tools__tool.is-checked {
  border-color: rgba(102, 126, 234, 0.55);
  background: rgba(102, 126, 234, 0.09);
}

.external-tools__tool.missing {
  margin-top: 8px;
  color: #b45309;
}

.external-tools__tool-text {
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--ink-primary, #292824);
  overflow-wrap: anywhere;
}

.external-tools__tool-text small {
  color: var(--ink-muted, #9b9790);
}
</style>
