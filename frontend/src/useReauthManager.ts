import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { api } from './api'
import { isActive, isUnfinished, needsReauth, planKey, planLabel } from './format'
import { requestId } from './utilities/requestId'
import type { Account, Job } from './types'

export function useReauthManager() {
  const accounts = ref<Account[]>([]), jobs = ref<Job[]>([]), selected = ref<string[]>([])
  const loading = ref(false), busy = ref(false), error = ref(''), search = ref(''), plan = ref('all'), filter = ref('all'), page = ref(1), pageSize = ref(20)
  const enabled = ref(false)
  const group = ref('all')
  const showLogout = ref(false), logoutTargets = ref<Account[]>([])
  const showConfirm = ref(false), targets = ref<Account[]>([])
  const batchId = ref<string | null>(null), batchJobs = ref<Job[]>([])
  let timer: ReturnType<typeof setTimeout> | undefined, destroyed = false, polling = false
  const byAccount = computed(() => new Map(jobs.value.map(j => [j.accountId, j])))
  const batchByAccount = computed(() => new Map(batchJobs.value.map(j => [j.accountId, j])))
  const jobOf = (a: Account) => byAccount.value.get(a.id)
  const resultOf = (a: Account) => ['success', 'failed'].includes(filter.value) ? batchByAccount.value.get(a.id) : jobOf(a)
  const ready = (a: Account) => a.notesValid && !!a.proxy && !isActive(jobOf(a))
  const logoutReady = (a: Account) => !!a.proxy && !isActive(jobOf(a))
  const showForce = ref(false), forceTarget = ref<Account>(), forceSource = ref<Job>(), forceWorkspace = ref(''), forceConfirmed = ref(false)
  const showFreeFallback = ref(false), freeTarget = ref<Account>(), freeSource = ref<Job>(), freeConfirmed = ref(false)
  const canForce = (a: Account) => { const j = jobOf(a); return ready(a) && j?.status === 'failed' && !!j.workspaceChoices?.length && (j.step === 'workspace' || j.message === '无法匹配原账号工作区，已停止写回') }
  function openForce(a: Account) { forceTarget.value = a; forceSource.value = jobOf(a); forceWorkspace.value = ''; forceConfirmed.value = false; showForce.value = true }
  const canFreeFallback = (a: Account) => { const j = jobOf(a); return ready(a) && j?.status === 'failed' && j.step === 'workspace' && !j.workspaceChoices?.length }
  function openFreeFallback(a: Account) { freeTarget.value = a; freeSource.value = jobOf(a); freeConfirmed.value = false; showFreeFallback.value = true }
  async function submitFreeFallback() {
    const source = freeSource.value
    if (!source || !freeConfirmed.value || busy.value) return
    if (!enabled.value) { error.value = '插件已关闭，请先打开插件开关'; return }
    busy.value = true; error.value = ''
    try {
      const request = requestId()
      const result = await api.freeFallback(source.requestId, request)
      batchId.value = request; batchJobs.value = []; receiveJobs(result.jobs); showFreeFallback.value = false
      if (['success', 'failed'].includes(filter.value)) filter.value = 'all'
      await api.tick()
    } catch (e) { error.value = (e as Error).message; try { await refreshJobs() } catch { /* Preserve request error */ } }
    finally { busy.value = false }
  }
  async function submitForce() {
    const source = forceSource.value
    if (!source || !forceWorkspace.value || !forceConfirmed.value || busy.value) return
    if (!enabled.value) { error.value = '插件已关闭，请先打开插件开关'; return }
    busy.value = true; error.value = ''
    try {
      const request = requestId()
      const result = await api.forceSubmit(source.requestId, forceWorkspace.value, request)
      batchId.value = request; batchJobs.value = []; receiveJobs(result.jobs); showForce.value = false
      if (['success', 'failed'].includes(filter.value)) filter.value = 'all'
      await api.tick()
    } catch (e) { error.value = (e as Error).message; try { await refreshJobs() } catch { /* Preserve request error */ } }
    finally { busy.value = false }
  }
  const active = computed(() => jobs.value.filter(isActive).length)
  const success = computed(() => batchJobs.value.filter(j => j.status === 'success').length)
  const failed = computed(() => batchJobs.value.filter(isUnfinished).length)
  const eligibleCount = computed(() => accounts.value.filter(needsReauth).length)
  const planOptions = computed(() => [{ value: 'all', label: '全部会员' }, ...Array.from(new Set(accounts.value.map(a => planKey(a.planType)))).sort().map(value => ({ value, label: planLabel(value) }))])
  const groupOptions = computed(() => {
    const groups = new Map<string, { name: string; count: number }>()
    for (const a of accounts.value) for (const g of new Map(a.groups.map(g => [g.id, g])).values()) {
      const old = groups.get(g.id); groups.set(g.id, { name: g.name, count: (old?.count || 0) + 1 })
    }
    return [{ value: 'all', label: `全部分组（${accounts.value.length}）` }, { value: 'ungrouped', label: `未分组（${accounts.value.filter(a => !a.groups.length).length}）` }, ...[...groups].sort((a, b) => a[1].name.localeCompare(b[1].name, 'zh-CN') || a[0].localeCompare(b[0])).map(([id, g]) => ({ value: `group:${id}`, label: `${g.name}（${g.count}）` }))]
  })
  const filtered = computed(() => accounts.value.filter(a => {
    if (group.value === 'ungrouped' && a.groups.length || group.value.startsWith('group:') && !a.groups.some(g => `group:${g.id}` === group.value)) return false
    if (plan.value !== 'all' && planKey(a.planType) !== plan.value) return false
    if (search.value && !`${a.id} ${a.name} ${a.email || ''} ${a.proxy || ''} ${a.groups.map(group => group.name).join(' ')}`.toLowerCase().includes(search.value.trim().toLowerCase())) return false
    const job = jobOf(a)
    const batchJob = batchByAccount.value.get(a.id)
    return filter.value === 'all' || filter.value === 'error' && needsReauth(a) || filter.value === 'ready' && ready(a) || filter.value === 'active' && isActive(job) || filter.value === 'failed' && isUnfinished(batchJob) || filter.value === 'success' && batchJob?.status === 'success' || filter.value === 'invalid' && (!a.notesValid || !a.proxy) || filter.value === 'disabled' && !a.enabled
  }))
  const visible = computed(() => filtered.value.slice((page.value - 1) * pageSize.value, page.value * pageSize.value))
  const pageCandidates = computed(() => visible.value.filter(a => ready(a) || logoutReady(a)))
  const pageSelected = computed(() => !!pageCandidates.value.length && pageCandidates.value.every(a => selected.value.includes(a.id)))
  const chosen = computed(() => accounts.value.filter(a => selected.value.includes(a.id) && ready(a)))
  const chosenLogout = computed(() => accounts.value.filter(a => selected.value.includes(a.id) && logoutReady(a)))
  watch([search, group, plan, filter, pageSize], () => page.value = 1)
  watch(group, () => selected.value = [])
  watch(() => filtered.value.length, n => { page.value = Math.min(page.value, Math.max(1, Math.ceil(n / pageSize.value))) })
  function selectOne(id: string, checked: boolean) { selected.value = checked ? [...new Set([...selected.value, id])] : selected.value.filter(v => v !== id) }
  function selectPage(checked: boolean) { for (const a of pageCandidates.value) selectOne(a.id, checked) }
  function receiveJobs(next: Job[]) {
    const changed = next.some(j => !isActive(j) && jobs.value.some(old => old.requestId === j.requestId && isActive(old)))
    jobs.value = next
    if (batchId.value) {
      // Keep this page's outcomes even if another submission trims server history.
      const records = new Map(batchJobs.value.map(j => [j.requestId, j]))
      for (const job of next) if (job.requestId.startsWith(`${batchId.value}:`)) records.set(job.requestId, job)
      batchJobs.value = [...records.values()]
    }
    return changed
  }
  async function refreshJobs() {
    const latest = await api.jobs()
    if (latest.enabled !== undefined) enabled.value = latest.enabled
    return receiveJobs(latest.jobs)
  }
  function showResults(value: 'error' | 'success' | 'failed') { search.value = ''; group.value = 'all'; plan.value = 'all'; filter.value = value; page.value = 1 }
  async function load() { loading.value = true; error.value = ''; try { await refreshJobs(); accounts.value = (await api.accounts()).accounts } catch (e) { error.value = (e as Error).message } finally { loading.value = false } }
  async function setEnabled(value: boolean) {
    if (busy.value || value === enabled.value) return
    busy.value = true; error.value = ''
    try { enabled.value = (await api.setConfig(value)).enabled; await refreshJobs(); if (!enabled.value) { showConfirm.value = false; showForce.value = false; showFreeFallback.value = false; showLogout.value = false } }
    catch (e) { error.value = (e as Error).message; try { await refreshJobs() } catch { /* Preserve request error */ } }
    finally { busy.value = false }
  }
  function confirm(rows: Account[]) { targets.value = rows; showConfirm.value = true }
  function confirmLogout(rows: Account[]) { logoutTargets.value = rows.filter(logoutReady); showLogout.value = !!logoutTargets.value.length }
  async function submitLogout() {
    if (!logoutTargets.value.length || busy.value) return
    if (!enabled.value) { error.value = '插件已关闭，请先打开插件开关'; return }
    busy.value = true; error.value = ''
    let sent = false
    try {
      const request = requestId(), ids = logoutTargets.value.map(a => a.id)
      batchId.value = request; batchJobs.value = []
      if (['success', 'failed'].includes(filter.value)) filter.value = 'all'
      sent = true
      receiveJobs((await api.logout(ids, request)).jobs)
      showLogout.value = false
      selected.value = selected.value.filter(id => !ids.includes(id))
      await api.tick()
      if (await refreshJobs()) accounts.value = (await api.accounts()).accounts
    } catch (e) {
      error.value = `${(e as Error).message}${sent ? '，请先检查退出任务和账号状态，勿直接重复提交' : ''}`
      if (sent) showLogout.value = false
      try { await refreshJobs() } catch { /* Preserve the request error without replaying logout */ }
    } finally { busy.value = false }
  }
  async function submit() {
    if (!targets.value.length || busy.value) return
    if (!enabled.value) { error.value = '插件已关闭，请先打开插件开关'; return }
    const accountIds = targets.value.map(a => a.id)
    busy.value = true; error.value = ''
    try {
      const request = requestId()
      batchId.value = request; batchJobs.value = []
      if (['success', 'failed'].includes(filter.value)) filter.value = 'all'
      receiveJobs((await api.submit(accountIds, request)).jobs)
      selected.value = selected.value.filter(id => !accountIds.includes(id)); showConfirm.value = false
      await api.tick()
      if (await refreshJobs()) accounts.value = (await api.accounts()).accounts
    } catch (e) {
      error.value = (e as Error).message
      // A failed response does not prove the submission was rejected; read, never replay it.
      try { await refreshJobs() } catch { /* Preserve the original submission error. */ }
    } finally { busy.value = false }
  }
  async function cancel(job?: Job) { busy.value = true; error.value = ''; try { receiveJobs((await api.cancel(job?.requestId || null)).jobs) } catch (e) { error.value = (e as Error).message } finally { busy.value = false } }
  async function poll() {
    if (destroyed || polling) return
    polling = true
    try {
      if (!busy.value) { if (enabled.value) await api.tick(); if (await refreshJobs()) accounts.value = (await api.accounts()).accounts }
    } catch (e) { error.value = (e as Error).message }
    finally { polling = false; if (!destroyed) timer = setTimeout(poll, 3000) }
  }
  onMounted(async () => { await load(); await poll() })
  onUnmounted(() => { destroyed = true; clearTimeout(timer) })
  return { accounts, jobs, selected, loading, busy, error, enabled, search, plan, group, groupOptions, filter, page, pageSize, showConfirm, targets, jobOf, resultOf, ready, logoutReady, showLogout, logoutTargets, confirmLogout, submitLogout, chosenLogout, active, success, failed, eligibleCount, planOptions, filtered, visible, pageCandidates, pageSelected, chosen, selectOne, selectPage, showResults, load, setEnabled, confirm, submit, cancel, showForce, forceTarget, forceSource, forceWorkspace, forceConfirmed, canForce, openForce, submitForce, showFreeFallback, freeTarget, freeSource, freeConfirmed, canFreeFallback, openFreeFallback, submitFreeFallback }
}
