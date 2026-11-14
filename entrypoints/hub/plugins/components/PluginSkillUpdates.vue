<template>
  <section class="plugin-skill-updates">
    <button type="button" class="psu-entry" :aria-expanded="open" @click="open = !open">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 3h13v7M4 3v18h11M7 7h6M7 11h5m6 2v8m-4-4h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
      <strong>{{ t('hub.plugins.skillUpdatesTitle') }}</strong><span class="psu-count">{{ updates.length }}</span>
    </button>
    <div v-if="open" class="psu-content">
      <p>{{ t('hub.plugins.skillUpdatesIntro') }}</p><p v-if="error" role="alert" class="psu-error">{{ error }}</p>
      <p v-if="!updates.length">{{ t('hub.plugins.skillUpdatesEmpty') }}</p>
      <article v-for="item in updates" :key="item.ref" class="psu-item">
        <header><div><strong>{{ item.name }}</strong><small>{{ item.pluginName }} · #{{ item.id }} · {{ item.version || '—' }} → {{ item.pending?.version }}</small></div><button type="button" @click="review(item)">{{ t(selected === item.ref ? 'hub.plugins.skillUpdatesClose' : 'hub.plugins.skillUpdatesReview') }}</button></header>
        <div v-if="selected === item.ref && detail" class="psu-review">
          <div class="psu-downloads"><button type="button" :disabled="detail.localUpdatedAt === null" @click="downloadVersion(detail, false)">{{ t('hub.plugins.skillUpdatesDownloadCurrent') }}</button><button type="button" @click="downloadVersion(detail, true)">{{ t('hub.plugins.skillUpdatesDownloadIncoming') }}</button></div>
          <div class="psu-diff"><section><h4>{{ t('hub.plugins.skillUpdatesCurrent') }}</h4><pre>{{ detail.localContent || t('hub.plugins.skillUpdatesMissing') }}</pre></section><section><h4>{{ t('hub.plugins.skillUpdatesIncoming') }}</h4><pre>{{ detail.incomingContent }}</pre></section></div>
          <details v-for="file in detail.resourceChanges" :key="file.path"><summary>{{ file.path }} · {{ file.kind }}</summary><div class="psu-diff"><pre>{{ file.oldText }}</pre><pre>{{ file.newText }}</pre></div></details>
          <button type="button" class="psu-approve" :disabled="busy || reviewedDigest !== detail.pending?.digest" @click="approve(detail)">{{ t('hub.plugins.skillUpdatesApprove') }}</button>
        </div>
      </article>
    </div>
  </section>
</template>
<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { downloadSkillZip } from '@/utils/skills/skill-import-export';
import { getSkillById } from '@/utils/skills/skill-store';
import { t } from '@/utils/i18n';
import { pendingPluginSkillUpdates, pendingPluginSkillUpdateSummaries, approvePluginSkillUpdate, MANAGED_SKILLS_KEY, type PluginSkillUpdateSummary } from '@/utils/plugins/managed-skills';
type Update = Awaited<ReturnType<typeof pendingPluginSkillUpdates>>[number];
const updates = shallowRef<PluginSkillUpdateSummary[]>([]), detail = shallowRef<Update | null>(null), open = ref(false), selected = ref(''), reviewedDigest = ref(''), busy = ref(false), error = ref('');
const reviewedLocalUpdatedAt = ref<number | null>(null);
const downloadVersion = (item: Update, incoming: boolean) => { const skill = incoming ? item.pending?.input : getSkillById(item.id); if (skill)
    downloadSkillZip(skill); };
let revision = 0;
const load = async () => { const current = ++revision; try {
    const next = await pendingPluginSkillUpdateSummaries();
    if (current !== revision)
        return;
    updates.value = next;
    if (selected.value && (next.find(item => item.ref === selected.value)?.pending?.digest !== reviewedDigest.value || next.find(item => item.ref === selected.value)?.localUpdatedAt !== reviewedLocalUpdatedAt.value))
        { selected.value = ''; detail.value = null; }
}
catch (failure) {
    if (current === revision) error.value = String(failure);
} };
let reviewRevision = 0;
const review = async (item: PluginSkillUpdateSummary) => {
    const current = ++reviewRevision;
    detail.value = null;
    if (selected.value === item.ref) { selected.value = ''; return; }
    selected.value = item.ref;
    error.value = '';
    try {
        const [next] = await pendingPluginSkillUpdates(item.ref);
        if (current !== reviewRevision || selected.value !== item.ref) return;
        if (!next || next.pending?.digest !== item.pending.digest || next.localUpdatedAt !== item.localUpdatedAt) { selected.value = ''; await load(); return; }
        detail.value = next;
        reviewedDigest.value = next.pending!.digest;
        reviewedLocalUpdatedAt.value = next.localUpdatedAt;
    } catch (failure) { if (current === reviewRevision) error.value = String(failure); }
};
watch(open, value => { if (!value) { reviewRevision++; selected.value = ''; detail.value = null; } });
const approve = async (item: Update) => { if (busy.value || !item.pending || (reviewedDigest.value !== item.pending.digest || reviewedLocalUpdatedAt.value !== item.localUpdatedAt))
    return; busy.value = true; error.value = ''; try {
    await approvePluginSkillUpdate(item.ref, reviewedDigest.value, reviewedLocalUpdatedAt.value);
    selected.value = '';
    await load();
}
catch (failure) {
    error.value = String(failure);
}
finally {
    busy.value = false;
} };
const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && (changes[MANAGED_SKILLS_KEY] || changes.agentNexusCustomSkills))
    void load(); };
onMounted(() => { void load(); chrome.storage.onChanged.addListener(changed); });
onBeforeUnmount(() => { revision++; reviewRevision++; chrome.storage.onChanged.removeListener(changed); });
</script>
<style scoped>
.plugin-skill-updates{margin:16px 0;border:1px solid var(--line-soft,#dce1eb);border-radius:14px;overflow:hidden;background:var(--surface-card,#ffffff06)}.psu-entry{display:flex;align-items:center;gap:10px;width:100%;padding:14px 17px;border:0;background:transparent;color:inherit;cursor:pointer;text-align:left;font:inherit}.psu-entry svg{color:var(--primary-color,#3b3934)}.psu-entry strong{font-size:13px}.psu-count{margin-left:auto;border-radius:20px;background:#3b39341c;padding:2px 9px;font-size:12px;color:var(--primary-color,#3b3934)}.psu-content{padding:0 17px 17px}.psu-content>p{font-size:12px;line-height:1.65;opacity:.75}.psu-item{padding:14px 0;border-top:1px solid var(--line-soft,#dce1eb)}.psu-item header{display:flex;align-items:center;justify-content:space-between;gap:12px}.psu-item header strong{font-size:13px}.psu-item small{display:block;margin-top:5px;opacity:.6;font-size:11px}.psu-item button{padding:7px 11px;border:1px solid var(--line-soft,#dce1eb);border-radius:8px;background:transparent;color:inherit;font-size:12px;cursor:pointer}.psu-diff{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:12px 0}.psu-diff section{min-width:0}.psu-diff h4{font-size:12px;font-weight:500}.psu-diff pre{box-sizing:border-box;white-space:pre-wrap;overflow-wrap:anywhere;max-height:340px;overflow:auto;margin:0;padding:13px;border:1px solid var(--line-soft,#dce1eb);border-radius:9px;font:11px/1.65 ui-monospace,monospace;background:#3b393407}.psu-approve{background:#3b3934!important;color:white!important;border-color:transparent!important;margin-top:12px}.psu-error{color:#d14d53;opacity:1!important}details{font-size:12px;margin:10px 0}summary{cursor:pointer}button:disabled{opacity:.5;cursor:default}@media(max-width:660px){.psu-diff{grid-template-columns:1fr}}
</style>
