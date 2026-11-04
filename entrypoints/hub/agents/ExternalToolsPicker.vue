<template>
  <fieldset class="external-tools">
    <legend>{{ tr('外部插件工具', 'External plugin tools') }}</legend>
    <input
      v-model="query"
      type="search"
      :placeholder="
        tr('搜索插件、工具或发布者', 'Search plugins, tools or publishers')
      "
    />
    <p v-if="!groups.length">
      {{ tr('尚未安装插件工具', 'No plugin tools installed') }}
    </p>
    <section v-for="group in groups" :key="group.key">
      <strong
        >{{ group.manifest.displayName }} · {{ group.manifest.version }}</strong
      >
      <p>
        {{ group.manifest.publisher.displayName }} ·
        {{
          group.source
            ? `GitHub: ${group.source.owner}/${group.source.repo}`
            : tr('本地导入', 'File import')
        }}
      </p>
      <label v-for="tool in group.tools" :key="tool.ref" :title="tool.ref">
        <input
          type="checkbox"
          :checked="modelValue.includes(tool.ref)"
          :disabled="
            !modelValue.includes(tool.ref) &&
            (!group.enabled || !!group.blocked || count >= max)
          "
          @change="toggle(tool.ref)"
        />
        <span
          >{{ tool.id }} — {{ tool.description }}
          <small v-if="!group.enabled || group.blocked"
            >({{ group.blocked || tr('已禁用', 'Disabled') }})</small
          ></span
        >
      </label>
    </section>
    <label v-for="ref in missing" :key="ref" class="missing"
      ><input type="checkbox" checked @change="toggle(ref)" /><span
        >{{ tr('缺失工具', 'Missing tool') }}: {{ ref }}</span
      ></label
    >
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
.external-tools {
  border: 1px solid var(--border-color, #5555);
  border-radius: 10px;
  padding: 14px;
  min-width: 0;
}
input[type='search'] {
  width: 100%;
  padding: 8px;
}
section {
  margin-top: 14px;
}
p {
  font-size: 12px;
  opacity: 0.75;
}
label {
  display: flex;
  gap: 8px;
  padding: 6px 0;
  overflow-wrap: anywhere;
}
.missing {
  color: #d99045;
}
small {
  opacity: 0.7;
}
</style>
