<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { ZButton } from '@codex-proxy/ui/button'
import { ZCheckbox } from '@codex-proxy/ui/checkbox'
import { ZInput } from '@codex-proxy/ui/input'
import { ZSelect } from '@codex-proxy/ui/select'
import { ZSwitch } from '@codex-proxy/ui/switch'
import { ZTextarea } from '@codex-proxy/ui/textarea'
import { api } from '../api'
import { requestId } from '../utilities/requestId'
import { displayTime, isActive, progress } from '../format'
import type { ImportRequest, Job, Options } from '../types'
import JobLogs from './JobLogs.vue'
const props = defineProps<{ enabled: boolean; jobs: Job[] }>()
const emit = defineEmits<{ submitted: [] }>()
const options = ref<Options>({ groups: [], proxies: [] }), ready = ref(false), loading = ref(false), busy = ref(false), error = ref(''), message = ref('')
const email = ref(''), password = ref(''), secret = ref(''), name = ref(''), workspace = ref(''), proxyId = ref(''), loginProxy = ref('')
const transport = ref<'http' | 'prefer_websocket'>('prefer_websocket'), enabled = ref(true), saveLogin = ref(true), notes = ref(''), groupIds = ref<string[]>([])
const concurrency = ref(''), weight = ref('5'), mode = ref<'all' | 'allowlist' | 'denylist'>('all'), models = ref('')
const submittedId = ref('')
const pending = computed(() => props.jobs.some(isActive))
const imports = computed(() => [...props.jobs].filter(j => j.kind === 'import').reverse().slice(0, 10))
const proxyOptions = computed(() => [{ value: '', label: '直连（不使用代理）' }, ...options.value.proxies.map(p => ({ value: p.id, label: `${p.name} · ${p.endpoint}${p.enabled ? '' : '（已禁用）'}`, disabled: !p.enabled }))])
const selectedProxy = computed(() => options.value.proxies.find(p => p.id === proxyId.value))
const submittedJob = computed(() => props.jobs.find(j => j.requestId === submittedId.value))
function selectGroup(id: string, checked: boolean) { groupIds.value = checked ? [...new Set([...groupIds.value, id])] : groupIds.value.filter(v => v !== id) }
function pasteCredentials(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!text.includes('----')) return
  event.preventDefault()
  const parts = text.trim().split('----')
  if (parts.length !== 3 || !/^[^\s@]+@[^\s@]+$/.test(parts[0].trim()) || !parts[1] || /[\r\n\u0000]/.test(text) || !/^[A-Z2-7]+=*$/i.test(parts[2].trim().replace(/ /g, ''))) {
    error.value = '粘贴格式无效，请使用 邮箱----密码----Base32 2FA 密钥，每次一个账号'
    return
  }
  email.value = parts[0].trim()
  password.value = parts[1]
  secret.value = parts[2].trim().toUpperCase().replace(/ /g, '')
  error.value = ''; message.value = '登录资料已填入，请核对后导入'
}
async function load() {
  loading.value = true; error.value = ''; ready.value = false
  try { options.value = await api.options(); ready.value = true }
  catch (e) { error.value = (e as Error).message }
  finally { loading.value = false }
}
async function submit() {
  if (busy.value || !ready.value || !props.enabled || pending.value) return
  error.value = ''; message.value = ''
  const limit = concurrency.value.trim() === '' ? null : Number(concurrency.value), w = Number(weight.value)
  const modelIds = mode.value === 'all' ? [] : [...new Set(models.value.split(/[\s,，]+/).filter(Boolean))].sort()
  if (!email.value.trim() || !password.value || !secret.value.trim()) { error.value = '请填写邮箱、密码和 2FA 验证器密钥'; return }
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1 || limit > 4294967295) || !Number.isSafeInteger(w) || w < 1 || w > 100) { error.value = '并发限制留空或填写 1–4294967295 的整数，权重为 1–100'; return }
  if (mode.value !== 'all' && (!modelIds.length || modelIds.length > 256)) { error.value = '模型列表需包含 1–256 个精确模型 ID'; return }
  if (modelIds.some(s => s.startsWith('__') || s.includes('*') || new TextEncoder().encode(s).length > 256 || /[\u0000-\u001f\u007f]/.test(s))) { error.value = '模型 ID 不支持通配符、控制字符及保留前缀，最多 256 字节'; return }
  busy.value = true
  try {
    const id = requestId()
    const body: ImportRequest = { requestId: id, email: email.value.trim(), password: password.value, totpSecret: secret.value, name: name.value.trim() || email.value.trim(), workspaceId: workspace.value.trim(), transport: transport.value, outboundProxyId: proxyId.value, loginProxyUrl: proxyId.value ? loginProxy.value.trim() : '', saveLoginNotes: saveLogin.value, settings: { notes: notes.value, enabled: enabled.value, concurrencyLimit: limit, weight: w, modelAccess: { mode: mode.value, models: modelIds }, groupIds: [...groupIds.value] } }
    submittedId.value = `${id}:import`
    await api.importAccount(body)
    password.value = ''; secret.value = ''; loginProxy.value = ''
    message.value = '导入任务已提交，可在下方查看进度'
    emit('submitted')
    await api.tick()
    emit('submitted')
  } catch (e) { error.value = `${(e as Error).message}，若请求已发送，请先检查下方任务及 CPR 账号，勿直接重复提交`; emit('submitted') }
  finally { busy.value = false }
}
onMounted(load)
onUnmounted(() => { password.value = ''; secret.value = ''; loginProxy.value = '' })
</script>
<template>
  <section class="settings-page" aria-label="账号导入">
    <h2>账号导入</h2><p class="muted">使用邮箱、密码和 2FA 验证器密钥登录，并通过 CPR 原生 OAuth 流程创建账号</p>
    <p v-if="!props.enabled" class="message">请先开启页面顶部的插件总开关</p>
    <p v-if="pending" class="message">当前有授权任务正在执行，请等待队列结束后导入</p>
    <p v-if="error" role="alert" class="message danger">{{ error }}</p><p v-if="message" role="status" class="message success">{{ message }}</p>
    <ZButton :loading="loading" :disabled="busy" @click="load">刷新分组与代理</ZButton>
    <form autocomplete="off" @submit.prevent="submit">
      <fieldset class="settings-fields" :disabled="busy || !ready || !props.enabled">
        <h3>登录资料</h3>
        <label class="field-label">粘贴登录资料<ZInput :model-value="''" type="password" autocomplete="new-password" placeholder="邮箱----密码----2FA 密钥" aria-label="粘贴登录资料" @paste.prevent="pasteCredentials" /><small class="muted">整行粘贴到此处或邮箱栏，自动填写下方登录资料，每次一个账号</small></label>
        <div class="form-grid">
          <label class="field-label">邮箱<ZInput v-model="email" type="email" autocomplete="off" aria-label="导入账号邮箱" @paste="pasteCredentials" /></label>
          <label class="field-label">账号名称<ZInput v-model="name" placeholder="留空使用邮箱" aria-label="导入账号名称" /></label>
          <label class="field-label">密码<ZInput v-model="password" type="password" autocomplete="new-password" aria-label="导入账号密码" /></label>
          <label class="field-label">2FA 密钥<ZInput v-model="secret" type="password" autocomplete="new-password" placeholder="Base32 验证器密钥，非六位动态码" aria-label="导入账号 2FA 密钥" /></label>
        </div>
        <label class="field-label">工作区 ID（可选）<ZInput v-model="workspace" placeholder="个人账号可留空，多个工作区时需明确指定" aria-label="导入工作区 ID" /></label>
        <h3>账号参数</h3><div class="form-grid">
          <label class="field-label">上游传输方式<ZSelect v-model="transport" :options="[{ value: 'prefer_websocket', label: 'WS' }, { value: 'http', label: 'SSE' }]" aria-label="上游传输方式" /></label>
          <label class="field-label">出站代理<ZSelect v-model="proxyId" :options="proxyOptions" aria-label="导入账号出站代理" /></label>
          <label class="field-label">并发限制<ZInput v-model="concurrency" type="number" min="1" max="4294967295" placeholder="留空使用默认值" aria-label="导入账号并发限制" /></label>
          <label class="field-label">权重<ZInput v-model="weight" type="number" min="1" max="100" aria-label="导入账号权重" /></label>
        </div>
        <label class="field-label" v-if="selectedProxy?.hasAuthentication">登录代理认证地址（可选）<ZInput v-model="loginProxy" type="password" autocomplete="new-password" placeholder="无关联账号可读取认证时，填写完整代理 URL" aria-label="登录代理认证地址" /><small class="muted">优先复用所选代理关联账号的认证信息，手填地址必须与所选代理的协议、主机及端口一致，仅用于本次登录</small></label>
        <ZSwitch v-model="enabled" label="导入完成后启用调度" aria-label="导入完成后启用调度" />
        <div class="field-block"><h3>所属分组</h3><div class="choice-grid"><ZCheckbox v-for="g in options.groups" :key="g.id" :model-value="groupIds.includes(g.id)" :label="g.name" @change="selectGroup(g.id, $event)" /><span v-if="!options.groups.length" class="muted">暂无分组，导入为未分组账号</span></div></div>
        <label class="field-label">模型权限<ZSelect v-model="mode" :options="[{ value: 'all', label: '全部模型' }, { value: 'allowlist', label: '仅允许指定模型' }, { value: 'denylist', label: '拒绝指定模型' }]" aria-label="导入账号模型权限" /></label>
        <label class="field-label" v-if="mode !== 'all'">模型 ID<ZTextarea v-model="models" :rows="3" placeholder="每行一个精确模型 ID，不支持通配符" aria-label="导入账号模型列表" /></label>
        <ZCheckbox v-model="saveLogin" label="将登录资料保存到 CPR 账号备注，供后续自动重新授权使用" />
        <p v-if="saveLogin" class="muted">账号备注将保存为 邮箱----密码----2FA，仅在 CPR 中保存，备注最长 500 字</p>
        <label class="field-label" v-else>备注<ZTextarea v-model="notes" :rows="3" :maxlength="500" placeholder="最多 500 字" aria-label="导入账号备注" /></label>
        <p class="muted">账号先以停用状态创建，传输方式和参数核对通过后按设置启用，需人工验证或存在多个未指定工作区时停止，结果不确定时请先在 CPR 中核对账号</p>
        <div class="form-actions"><ZButton type="primary" :loading="busy" :disabled="pending || !ready || !props.enabled" @click="submit">登录并导入 CPR</ZButton><span v-if="submittedJob" role="status">{{ progress(submittedJob) }} · {{ submittedJob.message }}</span></div>
      </fieldset>
    </form>
    <div v-if="imports.length" class="import-history"><h3>最近导入任务</h3><article v-for="j in imports" :key="j.requestId" class="import-result"><strong :class="{ danger: ['review', 'failed', 'interrupted'].includes(j.status), success: j.status === 'success' }">{{ progress(j) }}</strong><span>{{ j.message || '正在处理' }}</span><ZButton v-for="choice in j.workspaceChoices || []" :key="choice.id" size="small" :disabled="busy" @click="workspace = choice.id">使用工作区 {{ choice.id }}</ZButton><code v-if="j.accountId">{{ j.accountId }}</code><time>{{ displayTime(j.finishedAt || j.startedAt) }}</time><JobLogs :job="j" /></article></div>
  </section>
</template>
