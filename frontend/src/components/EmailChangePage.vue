<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ZButton } from '@codex-proxy/ui/button'
import { ZCard } from '@codex-proxy/ui/card'
import { ZInput } from '@codex-proxy/ui/input'
import { ZTextarea } from '@codex-proxy/ui/textarea'
import { ZSelect } from '@codex-proxy/ui/select'
import { ZDialog } from '@codex-proxy/ui/dialog'
import Notice from './Notice.vue'
import { api } from '../api'
import type { EmailChangeRecord, Job, ImportProxy } from '../types'
import { requestId } from '../utilities/requestId'
import { parseImportCredentials } from '../utilities/importCredentials'
import { displayTime, isActive } from '../format'
import { emailWithSuffix, normalizeEmailSuffix } from '../utilities/emailSuffix'

const props = defineProps<{ enabled: boolean; jobs: Job[] }>()
const email = ref(''), password = ref(''), secret = ref(''), newEmail = ref(''), proxy = ref(''), code = ref('')
const proxies = ref<ImportProxy[]>([]), proxyMode = ref(''), optionsLoaded = ref(false)
const proxyOptions = computed(() => [{ value: '', label: '直连' }, { value: 'manual', label: '手动输入代理' }, ...proxies.value.filter(p => p.enabled).map(p => ({ value: p.id, label: `${p.name} · ${p.endpoint}` }))])
watch(proxyMode, () => { proxy.value = '' })
const suffix = ref(''), settingsLoaded = ref(false), savedSuffix = ref(''), suffixMessage = ref('')
const suffixPreview = computed(() => emailWithSuffix(email.value || 'abc@icloud.com', suffix.value))
watch([email, suffix], ([currentEmail, currentSuffix], [oldEmail, oldSuffix]) => {
  const generated = emailWithSuffix(currentEmail, currentSuffix)
  if (generated) newEmail.value = generated
  else if (newEmail.value === emailWithSuffix(oldEmail, oldSuffix)) newEmail.value = ''
}, { flush: 'sync' })
const records = ref<EmailChangeRecord[]>([]), busy = ref(false), loading = ref(false), ready = ref(false), error = ref('')
const revealed = ref(''), revealId = ref(''), deleteId = ref('')
const showDelete = computed({ get: () => !!deleteId.value, set: value => { if (!value) deleteId.value = '' } })
const attempts = ref<Record<string, string>>({})
const accounts = computed(() => {
  const groups = new Map<string, EmailChangeRecord[]>()
  for (const record of [...records.value].sort((a, b) => b.createdAt - a.createdAt)) {
    const key = record.email.toLowerCase()
    groups.set(key, [...(groups.get(key) || []), record])
  }
  return [...groups].map(([key, history]) => ({ key, history, record: history.find(r => r.requestId === attempts.value[key]) || history[0], saved: history.find(r => r.hasCredentials) }))
})
const savedAccounts = computed(() => accounts.value.filter(a => a.saved))
const active = computed(() => records.value.find(r => ['running', 'verifying'].includes(r.status)))
const waiting = computed(() => active.value?.step === 'email_code' && active.value.status === 'running')
const queueActive = computed(() => props.jobs.some(isActive))
const statusLabels: Record<string, string> = { running: '进行中', verifying: '正在确认', success: '换绑成功', failed: '未完成', review: '需要核对', interrupted: '已中断', cancelled: '已取消' }
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
let retryId = ''

function paste(event: ClipboardEvent) {
  const text = event.clipboardData?.getData('text/plain') || ''
  if (!text.includes('----')) return
  event.preventDefault()
  try {
    const rows = parseImportCredentials(text)
    if (rows.length !== 1) throw new Error('每次只能换绑一个账号')
    email.value = rows[0].email; password.value = rows[0].password; secret.value = rows[0].totpSecret
    error.value = ''; retryId = ''
  } catch (e) { error.value = (e as Error).message }
}
async function refresh() {
  if (loading.value) return
  loading.value = true
  try {
    if (!settingsLoaded.value) {
      const settings = await api.emailSettings()
      if (disposed) return
      suffix.value = savedSuffix.value = settings.emailSuffix
      settingsLoaded.value = true
    }
    if (!optionsLoaded.value) {
      proxies.value = (await api.options()).proxies
      optionsLoaded.value = true
    }
    await api.tick()
    const data = await api.emailChanges()
    if (!disposed) { records.value = data.records; ready.value = true }
  } catch (e) { if (!disposed) error.value = (e as Error).message }
  finally { loading.value = false }
}
async function saveSuffix() {
  if (busy.value || !settingsLoaded.value) return
  busy.value = true; error.value = ''; suffixMessage.value = ''
  try {
    const settings = await api.saveEmailSettings(normalizeEmailSuffix(suffix.value))
    suffix.value = savedSuffix.value = settings.emailSuffix
    suffixMessage.value = settings.emailSuffix ? `邮箱后缀已保存为 ${settings.emailSuffix}` : '邮箱后缀已清除，新邮箱可手动填写'
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
async function poll() {
  await refresh()
  if (!disposed) timer = setTimeout(poll, 2500)
}
async function submit() {
  if (busy.value || !props.enabled || !ready.value || active.value || queueActive.value) return
  error.value = ''
  if (!/^[^\s@]+@[^\s@]+$/.test(email.value.trim()) || !/^[^\s@]+@[^\s@]+$/.test(newEmail.value.trim()) || email.value.trim().toLowerCase() === newEmail.value.trim().toLowerCase() || !password.value || !/^[A-Z2-7]+=*$/i.test(secret.value.trim().replace(/ /g, ''))) {
    error.value = '请填写新旧邮箱、密码和 Base32 2FA 密钥，新旧邮箱不能相同'; return
  }
  if (proxyMode.value === 'manual' && !proxy.value.trim()) { error.value = '请填写手动代理地址'; return }
  busy.value = true
  try {
    // Keep the ID after a lost response so a second click cannot replay the request
    retryId ||= requestId()
    records.value = (await api.emailBegin({ requestId: retryId, email: email.value.trim(), password: password.value, totpSecret: secret.value, newEmail: newEmail.value.trim(), proxyUrl: proxyMode.value ? proxy.value.trim() : '', outboundProxyId: proxyMode.value === 'manual' ? '' : proxyMode.value })).records
    password.value = ''; secret.value = ''; proxy.value = ''; code.value = ''; retryId = ''
  } catch (e) { error.value = `${(e as Error).message}，请先刷新检查换绑记录，勿直接重新发起` }
  finally { busy.value = false }
}
async function confirmCode() {
  if (!active.value || !waiting.value || busy.value || !props.enabled) return
  if (!/^[0-9]{6}$/.test(code.value.trim())) { error.value = '请输入六位邮箱验证码'; return }
  busy.value = true; error.value = ''
  try { records.value = (await api.emailCode(active.value.requestId, code.value.trim())).records }
  catch (e) { error.value = `${(e as Error).message}，请刷新核对当前状态` }
  finally { code.value = ''; busy.value = false }
}
async function cancel() {
  if (!active.value || busy.value) return
  busy.value = true; error.value = ''
  try { records.value = (await api.emailCancel(active.value.requestId)).records }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false; code.value = '' }
}
async function reveal(record: EmailChangeRecord) {
  if (busy.value) return
  if (revealId.value === record.requestId) { revealed.value = ''; revealId.value = ''; return }
  busy.value = true; error.value = ''; revealed.value = ''; revealId.value = ''
  try { revealed.value = await api.emailReveal(record.requestId); revealId.value = record.requestId }
  catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
async function remove() {
  if (!deleteId.value || busy.value) return
  busy.value = true; error.value = ''
  try {
    records.value = (await api.emailDelete(deleteId.value)).records
    if (revealId.value === deleteId.value) { revealed.value = ''; revealId.value = '' }
    deleteId.value = ''
  } catch (e) { error.value = (e as Error).message }
  finally { busy.value = false }
}
onMounted(poll)
onUnmounted(() => { disposed = true; clearTimeout(timer); password.value = ''; secret.value = ''; proxy.value = ''; code.value = ''; revealed.value = '' })
</script>

<template>
  <section class="settings-page" aria-label="账户邮箱换绑">
    <div><h2 class="page-title">账户邮箱换绑</h2><p class="muted">使用原邮箱、密码与 2FA 登录，将账户换绑到新邮箱，新邮箱换绑验证码由你手动输入</p></div>
    <Notice v-if="!props.enabled" tone="warning">请先开启页面顶部的插件总开关</Notice>
    <Notice v-if="error" tone="danger" role="alert">{{ error }}</Notice>
    <Notice v-if="queueActive" tone="info">授权队列正在处理，请等待队列结束后发起换绑</Notice>
    <div class="email-layout">
    <div class="email-form-column">
    <ZCard as="div" class="settings-card" title="新邮箱后缀">
      <div class="settings-fields">
        <label class="field-label">换绑后缀<ZInput v-model="suffix" :maxlength="254" :disabled="busy || !settingsLoaded" placeholder="例如 bb.com，留空可取消自动填写" aria-label="换绑邮箱后缀" /><small>保留原邮箱 @ 前的部分，自动生成新邮箱，生成后仍可手动修改</small></label>
        <p v-if="suffixPreview" class="muted">预览：{{ email || 'abc@icloud.com' }} → {{ suffixPreview }}</p>
        <div class="form-actions"><ZButton :loading="busy" :disabled="busy || !settingsLoaded" @click="saveSuffix">保存邮箱后缀</ZButton><span class="muted">{{ suffix !== savedSuffix ? '后缀尚未保存' : savedSuffix ? `已保存：${savedSuffix}` : '未设置自动换绑后缀' }}</span></div>
        <Notice v-if="suffixMessage" tone="success" role="status">{{ suffixMessage }}</Notice>
      </div>
    </ZCard>
    <ZCard v-if="active" as="div" class="settings-card" title="当前换绑会话">
      <div class="settings-fields">
        <p>{{ active.email }} → {{ active.newEmail }}</p>
        <Notice :tone="active.status === 'verifying' ? 'warning' : 'info'" role="status">{{ active.message }}</Notice>
        <form v-if="waiting" autocomplete="off" @submit.prevent="confirmCode">
          <label class="field-label">新邮箱换绑验证码<ZInput v-model="code" :maxlength="6" autocomplete="one-time-code" inputmode="numeric" :disabled="busy || !props.enabled" aria-label="邮箱验证码" /></label>
          <ZButton type="primary" :disabled="busy || !props.enabled" :loading="busy" @click="confirmCode">确认换绑并保存资料</ZButton>
        </form>
        <div class="form-actions"><ZButton :disabled="busy" @click="cancel">取消会话</ZButton><span class="muted">会话最长 15 分钟，刷新页面后可继续输入，插件重启后会话结束</span></div>
      </div>
    </ZCard>
    <form v-else autocomplete="off" @submit.prevent="submit">
      <fieldset class="settings-fields" :disabled="busy || !ready || !props.enabled">
        <ZCard as="div" class="settings-card" title="登录资料">
          <div class="settings-fields">
            <label class="field-label">粘贴登录资料<ZInput :model-value="''" type="password" autocomplete="new-password" placeholder="原邮箱----密码----2FA 密钥" aria-label="粘贴换绑登录资料" @paste.prevent="paste" /></label>
            <div class="form-grid">
              <label class="field-label">原邮箱<ZInput v-model="email" type="email" :maxlength="254" aria-label="换绑原邮箱" @paste="paste" /></label>
              <label class="field-label">新邮箱<ZInput v-model="newEmail" type="email" :maxlength="254" aria-label="换绑新邮箱" /></label>
              <label class="field-label">密码<ZInput v-model="password" type="password" autocomplete="new-password" aria-label="换绑账号密码" /></label>
              <label class="field-label">2FA 密钥<ZInput v-model="secret" type="password" autocomplete="new-password" placeholder="Base32 验证器密钥，非六位动态码" aria-label="换绑账号 2FA 密钥" /></label>
            </div>
            <label class="field-label">IP 代理<ZSelect v-model="proxyMode" :options="proxyOptions" :disabled="!optionsLoaded" aria-label="换绑代理选择" /><small>可选择平台中已启用的代理，整个登录与换绑会话使用同一代理</small></label>
            <label v-if="proxyMode" class="field-label">IP 代理（可选）<ZInput v-model="proxy" type="password" autocomplete="new-password" placeholder="http://用户:密码@IP:端口 或 socks5://IP:端口" aria-label="换绑 IP 代理" /><small>手动代理须填写完整地址，平台代理留空时自动读取，认证无法读取时可补填同一地址的认证信息</small></label>
            <Notice tone="info">换绑成功后，插件私有记录保存 新邮箱----原密码----原2FA密钥，可在右侧保存资料卡片查看并复制，确认结果不确定时保留待核对资料，密码和 2FA 密钥沿用原值</Notice>
            <p class="muted">此页面可处理尚未导入 CPR 的账户，已有 CPR 账户的备注与 OAuth 授权需在换绑后另行更新</p>
            <div class="form-actions"><ZButton type="primary" :loading="busy" :disabled="busy || !ready || !props.enabled || queueActive" @click="submit">登录并发送换绑验证码</ZButton></div>
          </div>
        </ZCard>
      </fieldset>
    </form>
    </div>
    <aside class="email-side-column" aria-label="换绑结果">
      <ZCard as="div" class="email-panel" title="换绑记录">
        <div class="email-panel-body">
          <div class="form-actions"><span class="muted">每个原账号一条 · 共 {{ accounts.length }} 个账号</span><ZButton :loading="loading" :disabled="busy" @click="refresh">刷新记录</ZButton></div>
          <div class="email-panel-scroll" aria-label="换绑记录列表" tabindex="0">
            <p v-if="!accounts.length" class="muted">暂无换绑记录</p>
            <article v-for="account in accounts" :key="account.key" class="email-account-record">
              <strong>{{ account.record.email }}</strong>
              <label v-if="account.history.length > 1" class="field-label">尝试记录<ZSelect :model-value="account.record.requestId" :options="account.history.map(r => ({ value: r.requestId, label: `${displayTime(r.createdAt)} · ${statusLabels[r.status]}` }))" :aria-label="`${account.record.email} 的尝试记录`" @update:model-value="value => attempts[account.key] = String(value)" /></label>
              <small class="mono">请求 ID {{ account.record.requestId }}</small>
              <p class="muted">{{ account.record.newEmail }}<br>{{ statusLabels[account.record.status] }} · {{ displayTime(account.record.createdAt) }}</p>
              <Notice :tone="account.record.status === 'success' ? 'success' : ['review', 'interrupted', 'failed'].includes(account.record.status) ? 'warning' : 'info'">{{ account.record.message }}</Notice>
              <div class="email-logs" role="log" :aria-label="`${account.record.email} 换绑详细日志`">
                <p v-for="(log, index) in account.record.logs || []" :key="index">[{{ displayTime(log.at) }}] {{ log.message }}</p>
                <p v-if="!account.record.logs?.length" class="muted">此历史记录未保存详细日志</p>
              </div>
              <ZButton v-if="!['running', 'verifying'].includes(account.record.status)" :disabled="busy" @click="deleteId = account.record.requestId">删除记录</ZButton>
            </article>
          </div>
        </div>
      </ZCard>
      <ZCard as="div" class="email-panel" title="保存资料">
        <div class="email-panel-body">
          <p class="muted">按原账号展示最新保存资料，待核对资料请先确认实际换绑结果</p>
          <div class="email-panel-scroll" aria-label="保存资料列表" tabindex="0">
            <p v-if="!savedAccounts.length" class="muted">暂无已保存资料</p>
            <article v-for="account in savedAccounts" :key="account.key" class="email-account-record">
              <strong>{{ account.saved!.email }} → {{ account.saved!.newEmail }}</strong>
              <p>{{ statusLabels[account.saved!.status] }} · {{ displayTime(account.saved!.createdAt) }}</p>
              <ZButton :disabled="busy" @click="reveal(account.saved!)">{{ revealId === account.saved!.requestId ? '隐藏资料' : '查看已保存资料' }}</ZButton>
              <label v-if="revealId === account.saved!.requestId" class="field-label">{{ account.saved!.status === 'success' ? '换绑后登录资料（可选中复制）' : '待核对资料（先确认实际换绑结果）' }}<ZTextarea :model-value="revealed" readonly :rows="4" aria-label="已保存换绑资料" /></label>
            </article>
          </div>
        </div>
      </ZCard>
    </aside>
    </div>
    <ZDialog v-model="showDelete" title="删除换绑记录" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p>删除后无法恢复已保存的登录资料，请先复制需要保留的资料</p>
      <template #footer><ZButton :disabled="busy" @click="deleteId = ''">取消</ZButton><ZButton type="danger" :loading="busy" @click="remove">确认删除</ZButton></template>
    </ZDialog>
  </section>
</template>

<style scoped>
.email-layout { display: grid; grid-template-columns: minmax(0, 620px) minmax(300px, 430px); gap: 20px; align-items: start; }
.email-form-column, .email-side-column { display: grid; gap: 20px; min-width: 0; }
.email-panel { min-width: 0; overflow: hidden; }
.email-panel-body { height: 390px; display: flex; flex-direction: column; gap: 12px; min-width: 0; }
.email-panel-scroll { min-height: 0; overflow: auto; flex: 1; overflow-wrap: anywhere; scrollbar-gutter: stable; }
.email-account-record { display: grid; gap: 12px; padding: 12px 4px; border-bottom: 1px solid var(--z-color-border); }
.email-account-record p { margin: 0; }
.email-logs { font-family: var(--z-font-family-code); font-size: 12px; line-height: 1.7; white-space: pre-wrap; overflow-wrap: anywhere; }
@media (max-width: 900px) { .email-layout { grid-template-columns: minmax(0, 1fr); } }
</style>
