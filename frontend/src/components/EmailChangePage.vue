<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { ZButton } from '@codex-proxy/ui/button'
import { ZCard } from '@codex-proxy/ui/card'
import { ZInput } from '@codex-proxy/ui/input'
import { ZTextarea } from '@codex-proxy/ui/textarea'
import { ZDialog } from '@codex-proxy/ui/dialog'
import Notice from './Notice.vue'
import { api } from '../api'
import type { EmailChangeRecord, Job } from '../types'
import { requestId } from '../utilities/requestId'
import { parseImportCredentials } from '../utilities/importCredentials'
import { displayTime, isActive } from '../format'
import { emailWithSuffix, normalizeEmailSuffix } from '../utilities/emailSuffix'

const props = defineProps<{ enabled: boolean; jobs: Job[] }>()
const email = ref(''), password = ref(''), secret = ref(''), newEmail = ref(''), proxy = ref(''), code = ref('')
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
const active = computed(() => records.value.find(r => ['running', 'verifying'].includes(r.status)))
const waiting = computed(() => active.value && ['email_login_code', 'email_code'].includes(active.value.step) && active.value.status === 'running')
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
  busy.value = true
  try {
    // Keep the ID after a lost response so a second click cannot replay the request
    retryId ||= requestId()
    records.value = (await api.emailBegin({ requestId: retryId, email: email.value.trim(), password: password.value, totpSecret: secret.value, newEmail: newEmail.value.trim(), proxyUrl: proxy.value.trim() })).records
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
    <div><h2 class="page-title">账户邮箱换绑</h2><p class="muted">使用原邮箱、密码与 2FA 登录，将账户换绑到新邮箱，邮箱验证码由你手动输入</p></div>
    <Notice v-if="!props.enabled" tone="warning">请先开启页面顶部的插件总开关</Notice>
    <Notice v-if="error" tone="danger" role="alert">{{ error }}</Notice>
    <Notice v-if="queueActive" tone="info">授权队列正在处理，请等待队列结束后发起换绑</Notice>
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
          <label class="field-label">{{ active.step === 'email_login_code' ? '原邮箱登录验证码' : '新邮箱换绑验证码' }}<ZInput v-model="code" :maxlength="6" autocomplete="one-time-code" inputmode="numeric" :disabled="busy || !props.enabled" aria-label="邮箱验证码" /></label>
          <ZButton type="primary" :disabled="busy || !props.enabled" :loading="busy" @click="confirmCode">{{ active.step === 'email_login_code' ? '提交登录验证码' : '确认换绑并保存资料' }}</ZButton>
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
            <label class="field-label">IP 代理（可选）<ZInput v-model="proxy" type="password" autocomplete="new-password" placeholder="http://用户:密码@IP:端口 或 socks5://IP:端口" aria-label="换绑 IP 代理" /><small>留空直连，指定后整个登录与换绑流程均使用该代理</small></label>
            <Notice tone="info">换绑成功后，插件私有记录保存 新邮箱----原密码----原2FA密钥，可在下方查看并复制，确认结果不确定时保留待核对资料，密码和 2FA 密钥沿用原值</Notice>
            <p class="muted">此页面可处理尚未导入 CPR 的账户，已有 CPR 账户的备注与 OAuth 授权需在换绑后另行更新</p>
            <div class="form-actions"><ZButton type="primary" :loading="busy" :disabled="busy || !ready || !props.enabled || queueActive" @click="submit">登录并发送换绑验证码</ZButton></div>
          </div>
        </ZCard>
      </fieldset>
    </form>
    <div class="form-actions"><h3>换绑记录与已保存资料</h3><ZButton :loading="loading" :disabled="busy" @click="refresh">刷新记录</ZButton></div>
    <p v-if="!records.length" class="muted">暂无换绑记录</p>
    <ZCard v-for="record in records" :key="record.requestId" as="div" class="settings-card" :title="`${record.email} → ${record.newEmail}`">
      <div class="settings-fields">
        <p><strong>{{ statusLabels[record.status] }}</strong> · {{ displayTime(record.createdAt) }}</p>
        <Notice :tone="record.status === 'success' ? 'success' : ['review', 'interrupted', 'failed'].includes(record.status) ? 'warning' : 'info'">{{ record.message }}</Notice>
        <div class="form-actions">
          <ZButton v-if="record.hasCredentials" :disabled="busy" @click="reveal(record)">{{ revealId === record.requestId ? '隐藏资料' : '查看已保存资料' }}</ZButton>
          <ZButton v-if="!['running', 'verifying'].includes(record.status)" :disabled="busy" @click="deleteId = record.requestId">删除记录</ZButton>
        </div>
        <label v-if="revealId === record.requestId" class="field-label">{{ record.status === 'success' ? '换绑后登录资料（可选中复制）' : '待核对资料（先确认实际换绑结果）' }}<ZTextarea :model-value="revealed" readonly :rows="3" aria-label="已保存换绑资料" /></label>
      </div>
    </ZCard>
    <ZDialog v-model="showDelete" title="删除换绑记录" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p>删除后无法恢复已保存的登录资料，请先复制需要保留的资料</p>
      <template #footer><ZButton :disabled="busy" @click="deleteId = ''">取消</ZButton><ZButton type="danger" :loading="busy" @click="remove">确认删除</ZButton></template>
    </ZDialog>
  </section>
</template>
