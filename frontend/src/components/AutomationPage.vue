<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ZButton } from '@codex-proxy/ui/button'
import { ZCheckbox } from '@codex-proxy/ui/checkbox'
import { ZInput } from '@codex-proxy/ui/input'
import { ZSwitch } from '@codex-proxy/ui/switch'
import { api } from '../api'
import { defaultAutomation } from '../types'
import type { Account, AccountGroup } from '../types'
import { planKey, planLabel, statusText } from '../format'
const props = defineProps<{ enabled: boolean; accounts: Account[] }>()
const emit = defineEmits<{ saved: [] }>()
const config = ref(defaultAutomation()), groups = ref<AccountGroup[]>([])
const ready = ref(false), loading = ref(true), saving = ref(false), error = ref(''), saved = ref(false)
const interval = ref('15'), cooldown = ref('24')
const statuses = ['error', 'normal', 'quota_exhausted', 'rate_limited'].map(value => ({ value, label: statusText({ status: value, enabled: true } as Account) }))
const plans = computed(() => [...new Set(['free', 'plus', 'pro', 'team', 'business', 'unknown', ...props.accounts.map(a => planKey(a.planType)), ...config.value.plans])])
function toggle(key: 'groupIds' | 'statuses' | 'plans', value: string, checked: boolean) { config.value[key] = checked ? [...new Set([...config.value[key], value])] : config.value[key].filter(v => v !== value); saved.value = false }
const matches = computed(() => props.accounts.filter(a => {
  const c = config.value
  return (!c.enabledOnly || a.enabled) && c.statuses.includes(a.status) && (c.allPlans || c.plans.includes(planKey(a.planType))) && (c.allGroups || !a.groups.length && c.includeUngrouped || a.groups.some(g => c.groupIds.includes(g.id)))
}))
async function load() {
  loading.value = true; error.value = ''; ready.value = false
  try {
    const [state, options] = await Promise.all([api.jobs(), api.options()])
    config.value = state.automation || defaultAutomation(); groups.value = options.groups
    interval.value = String(config.value.intervalMinutes); cooldown.value = String(config.value.cooldownHours); ready.value = true
  } catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
async function save() {
  if (saving.value || loading.value || !ready.value) return
  error.value = ''; saved.value = false
  const minutes = Number(interval.value), hours = Number(cooldown.value), c = config.value
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440 || !Number.isInteger(hours) || hours < 1 || hours > 168) { error.value = '扫描间隔为 1–1440 分钟，冷却时间为 1–168 小时'; return }
  if (!c.statuses.length || !c.allGroups && !c.groupIds.length && !c.includeUngrouped || !c.allPlans && !c.plans.length) { error.value = '请至少选择一种状态、一个分组范围和一种订阅'; return }
  saving.value = true
  try { const result = await api.setConfig(props.enabled, { ...c, intervalMinutes: minutes, cooldownHours: hours }); if (result.automation) config.value = result.automation; saved.value = true; emit('saved') }
  catch (e) { error.value = (e as Error).message }
  finally { saving.value = false }
}
onMounted(load)
</script>
<template>
  <section class="settings-page" aria-label="自动重新授权参数配置">
    <h2>自动重新授权</h2>
    <p class="muted">分组、账号状态与订阅条件同时满足时，后台串行重新授权，组内多选项满足任一项即可</p>
    <p v-if="!enabled" class="message">插件总开关已关闭，保存配置后，仍须开启总开关才能执行</p>
    <p v-if="error" class="message danger" role="alert">{{ error }}</p>
    <ZButton v-if="loading || error" :loading="loading" @click="load">读取配置与分组</ZButton>
    <form v-if="!loading" @submit.prevent="save">
      <fieldset :disabled="saving || !ready" class="settings-fields">
        <ZSwitch v-model="config.enabled" label="开启自动重新授权" aria-label="开启自动重新授权" />
        <div class="form-grid"><label class="field-label">扫描间隔（分钟）<ZInput v-model="interval" type="number" min="1" max="1440" aria-label="扫描间隔（分钟）" /></label><label class="field-label">同一账号冷却时间（小时）<ZInput v-model="cooldown" type="number" min="1" max="168" aria-label="同一账号冷却时间（小时）" /></label></div>
        <ZCheckbox v-model="config.enabledOnly" label="仅处理已启用调度的账号" />
        <div class="field-block"><h3>分组范围</h3><ZCheckbox v-model="config.allGroups" label="全部分组（包含未分组）" /><div v-if="!config.allGroups" class="choice-grid"><ZCheckbox :model-value="config.includeUngrouped" label="未分组" @change="config.includeUngrouped = $event" /><ZCheckbox v-for="g in groups" :key="g.id" :model-value="config.groupIds.includes(g.id)" :label="g.name" @change="toggle('groupIds', g.id, $event)" /><span v-for="id in config.groupIds.filter(id => !groups.some(g => g.id === id))" :key="id" class="danger">已删除分组：{{ id }} <ZButton size="small" @click="toggle('groupIds', id, false)">移除</ZButton></span></div></div>
        <div class="field-block"><h3>账号状态</h3><div class="choice-grid"><ZCheckbox v-for="s in statuses" :key="s.value" :model-value="config.statuses.includes(s.value)" :label="s.label" @change="toggle('statuses', s.value, $event)" /></div><p class="muted">默认仅异常，选择正常、限流或额度耗尽状态也会触发重新登录</p></div>
        <div class="field-block"><h3>订阅范围</h3><ZCheckbox v-model="config.allPlans" label="全部订阅" /><div v-if="!config.allPlans" class="choice-grid"><ZCheckbox v-for="p in plans" :key="p" :model-value="config.plans.includes(p)" :label="planLabel(p)" @change="toggle('plans', p, $event)" /></div></div>
        <div class="message">当前条件匹配 {{ matches.length }} 个账号，其中 {{ matches.filter(a => a.notesValid && a.proxy).length }} 个具备备注和代理，实际执行还会检查账号空闲、冷却及在途任务，</div>
        <p class="muted">后台扫描由 CPR 维护回调推进，页面关闭后继续生效，写回结果不确定或进程中断的账号不会自动重试，请先手动核对并重新授权，更新配置会取消尚未执行的自动任务</p>
        <div class="form-actions"><ZButton type="primary" :loading="saving" @click="save">保存配置</ZButton><span v-if="saved" class="success" role="status">配置已保存</span></div>
      </fieldset>
    </form>
  </section>
</template>
