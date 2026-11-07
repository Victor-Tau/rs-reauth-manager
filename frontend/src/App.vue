<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Notice from './components/Notice.vue'
import StatTile from './components/StatTile.vue'
import AutomationPage from './components/AutomationPage.vue'
import ImportPage from './components/ImportPage.vue'
import JobLogs from './components/JobLogs.vue'
import { Search, RefreshCw, KeyRound, Square, X, LogOut, CircleCheck, ListChecks, Settings2, UserPlus, Inbox, Hourglass, CircleX, ShieldAlert } from '@lucide/vue'
import { ZConfigProvider } from '@codex-proxy/ui/config-provider'
import { zhHans } from '@codex-proxy/ui/locale'
import { ZButton } from '@codex-proxy/ui/button'
import { ZCard } from '@codex-proxy/ui/card'
import { ZEmpty } from '@codex-proxy/ui/empty'
import { ZCheckbox } from '@codex-proxy/ui/checkbox'
import { ZDialog } from '@codex-proxy/ui/dialog'
import { ZIconButton } from '@codex-proxy/ui/icon-button'
import { ZInput } from '@codex-proxy/ui/input'
import { ZPagination } from '@codex-proxy/ui/pagination'
import { ZSelect } from '@codex-proxy/ui/select'
import { ZSwitch } from '@codex-proxy/ui/switch'
import { ZTable, type TableColumn } from '@codex-proxy/ui/table'
import { ZTag } from '@codex-proxy/ui/tag'
import { displayTime, expiryInfo, isActive, jobTone, planLabel, planType, progress, resultMessage, statusText, statusTone } from './format'
import { useReauthManager } from './useReauthManager'
import type { Account } from './types'

const section = ref<'accounts' | 'config' | 'import'>('accounts')
const { accounts, jobs, selected, loading, busy, enabled, error, search, plan, group, groupOptions, filter, page, pageSize, showConfirm, targets, jobOf, resultOf, ready, logoutReady, showLogout, logoutTargets, confirmLogout, submitLogout, chosenLogout, active, success, failed, eligibleCount, planOptions, filtered, visible, pageSelected, pageIndeterminate, loaded, chosen, selectOne, selectPage, showResults, load, setEnabled, confirm, submit, cancel, pageCandidates, showForce, forceTarget, forceSource, forceWorkspace, forceConfirmed, canForce, openForce, submitForce, showFreeFallback, freeTarget, freeSource, freeConfirmed, canFreeFallback, openFreeFallback, submitFreeFallback } = useReauthManager()
const logRequestId = ref('')
const logJob = computed(() => jobs.value.find(job => job.requestId === logRequestId.value))
const showLogs = computed({ get: () => !!logRequestId.value, set: value => { if (!value) logRequestId.value = '' } })
const statusOptions = [{ value: 'all', label: '全部状态' }, { value: 'error', label: '账号异常' }, { value: 'ready', label: '可重新授权' }, { value: 'active', label: '处理中' }, { value: 'failed', label: '本次未完成' }, { value: 'success', label: '本次成功' }, { value: 'invalid', label: '备注待检查' }, { value: 'disabled', label: '已停用' }]
const baseColumns: TableColumn<Account>[] = [{ key: 'select', label: '', width: 48 }, { key: 'identity', label: '账号', kind: 'identity', minWidth: 300 }, { key: 'status', label: '账号状态', width: 120 }, { key: 'credentials', label: '授权条件', minWidth: 210 }, { key: 'result', label: '最近操作', minWidth: 230 }, { key: 'actions', label: '操作', kind: 'actions', width: 250 }]
const compactColumns = baseColumns.filter(column => ['select', 'identity', 'actions'].includes(column.key))
const failedStates = ['failed', 'review', 'interrupted']
const tiles = computed(() => [
  { key: 'error' as const, label: '可处理', value: eligibleCount.value, caption: '账号状态异常，需要更新授权', tone: 'warning' as const, icon: ShieldAlert, hint: '显示所有需要更新 RT 的异常账号，按 RS 异常状态统计，包含资料未齐的账号' },
  { key: 'active' as const, label: '队列', value: active.value, caption: '等待及运行中的后台任务', tone: 'info' as const, icon: Hourglass, hint: '显示正在排队或运行的账号' },
  { key: 'success' as const, label: '本次成功', value: success.value, caption: '本页提交后已写回，刷新页面归零', tone: 'success' as const, icon: CircleCheck, hint: '显示本次任务成功的账号，重新进入页面归零' },
  { key: 'failed' as const, label: '本次未完成', value: failed.value, caption: '失败、需核对或中断', tone: failed.value ? 'danger' as const : 'default' as const, icon: CircleX, hint: '显示本次任务未完成的账号，重新进入页面归零' },
])
const compact = ref(false)
let media: MediaQueryList | undefined
function updateCompact() { compact.value = !!media?.matches }
onMounted(() => { media = window.matchMedia('(max-width: 700px)'); updateCompact(); media.addEventListener('change', updateCompact) })
onUnmounted(() => media?.removeEventListener('change', updateCompact))
const columns = computed(() => compact.value ? compactColumns.map(column => column.key === 'actions' ? { ...column, width: 112 } : column.key === 'identity' ? { ...column, minWidth: 160 } : column) : baseColumns)
const proxyText = (a: Account) => a.proxy || '直连（不使用代理）'
const resultTone = (a: Account) => jobTone(resultOf(a))
</script>

<template>
  <ZConfigProvider :locale="zhHans">
  <main>
    <header class="page-bar">
      <nav class="page-nav" aria-label="插件页面">
        <ZButton :type="section === 'accounts' ? 'primary' : 'default'" :variant="section === 'accounts' ? 'solid' : 'plain'" @click="section = 'accounts'"><template #icon><ListChecks :size="16" /></template>账号重新授权</ZButton>
        <ZButton :type="section === 'config' ? 'primary' : 'default'" :variant="section === 'config' ? 'solid' : 'plain'" @click="section = 'config'"><template #icon><Settings2 :size="16" /></template>参数配置</ZButton>
        <ZButton :type="section === 'import' ? 'primary' : 'default'" :variant="section === 'import' ? 'solid' : 'plain'" @click="section = 'import'"><template #icon><UserPlus :size="16" /></template>账号导入</ZButton>
      </nav>
      <ZSwitch class="master-switch" :model-value="enabled" :disabled="busy" :label="enabled ? '插件已开启' : '插件已关闭'" title="关闭后停止当前队列，并阻止新的重新授权任务" aria-label="插件总开关" @update:model-value="setEnabled" />
    </header>
    <Notice v-if="loaded && !enabled" tone="warning">插件已关闭，当前队列已停止，开启后才能提交重新授权、退出登录及导入任务</Notice>
    <Notice v-if="section !== 'accounts' && error" tone="danger" role="alert">{{ error }}</Notice>
    <AutomationPage v-if="section === 'config'" :enabled="enabled" :accounts="accounts" @saved="load" />
    <ImportPage v-if="section === 'import'" :enabled="enabled" :jobs="jobs" @submitted="load" />
    <section v-show="section === 'accounts'" class="accounts-page" aria-label="账号重新授权列表">
      <div class="stats" role="group" aria-label="授权任务统计">
        <StatTile v-for="tile in tiles" :key="tile.key" :label="tile.label" :value="tile.value" :caption="tile.caption" :tone="tile.tone" :icon="tile.icon" :hint="tile.hint" :pressed="filter === tile.key" @select="showResults(tile.key)" />
      </div>
      <ZCard as="div" padding="compact" class="panel">
        <div class="toolbar">
          <ZInput v-model="search" class="search" placeholder="搜索邮箱、分组或代理" clearable aria-label="搜索账号"><template #prefix><Search :size="16" /></template></ZInput>
          <ZSelect v-model="group" class="filter group-filter" :options="groupOptions" aria-label="账号分组筛选" />
          <ZSelect v-model="plan" class="filter" :options="planOptions" aria-label="会员标识筛选" />
          <ZSelect v-model="filter" class="filter" :options="statusOptions" aria-label="状态筛选" />
          <ZIconButton class="refresh" title="读取最新账号" aria-label="读取最新账号" :disabled="loading || busy" @click="load"><RefreshCw :size="17" :class="{ spin: loading }" /></ZIconButton>
        </div>
        <div class="selection" :class="{ 'has-selection': chosenLogout.length }">
          <ZCheckbox :model-value="pageSelected" :indeterminate="pageIndeterminate" :disabled="!enabled || !pageCandidates.length || busy" label="选择当前页" @change="selectPage" />
          <span class="selection-count">已选 {{ chosenLogout.length }} / {{ filtered.length }} 个账号</span>
          <ZIconButton v-if="selected.length" size="small" title="清空选择" aria-label="清空选择" @click="selected = []"><X :size="14" /></ZIconButton>
          <div class="commands">
            <ZButton v-if="active" :disabled="busy" @click="cancel()"><template #icon><Square :size="14" /></template>停止队列</ZButton>
            <ZButton type="primary" :disabled="!enabled || busy || !chosen.length" @click="confirm(chosen)"><template #icon><KeyRound :size="16" /></template>重新授权所选<span v-if="chosen.length">（{{ chosen.length }}）</span></ZButton>
            <ZButton type="danger" variant="plain" :disabled="!enabled || busy || !chosenLogout.length" @click="confirmLogout(chosenLogout)"><template #icon><LogOut :size="16" /></template>退出所有登录<span v-if="chosenLogout.length">（{{ chosenLogout.length }}）</span></ZButton>
          </div>
        </div>
        <Notice v-if="error" tone="danger" dismissible role="alert" @dismiss="error = ''">{{ error }}</Notice>
        <ZTable :columns="columns" :data="visible" :row-key="a => a.id" :loading="loading && !accounts.length" :empty-text="loading ? '正在读取账号' : '没有匹配的 OAuth 账号'">
          <template #select="{ row }"><ZCheckbox :model-value="selected.includes(row.id)" :disabled="!enabled || (!ready(row) && !logoutReady(row)) || busy" :aria-label="`选择 ${row.email || row.name}`" @change="selectOne(row.id, $event)" /></template>
          <template #identity="{ row }">
            <div class="identity" :title="`${row.name}\n${row.id}`">
              <span class="avatar" :class="{ green: row.planType === 'team' }">{{ (row.email || row.name).slice(0, 1).toUpperCase() }}</span>
              <div class="identity-text">
                <span class="email">{{ row.email || row.name }}</span>
                <div v-if="!compact" class="identity-meta"><ZTag :type="planType(row.planType)" size="small">{{ planLabel(row.planType || 'unknown') }}</ZTag><template v-if="row.groups.length"><ZTag v-for="g in row.groups" :key="g.id" size="small" :title="g.name">{{ g.name }}</ZTag></template><span v-else class="muted">未分组</span></div>
                <div v-if="compact" class="mobile-details">
                  <span class="mobile-line"><ZTag :type="statusTone(row)" size="small">{{ statusText(row) }}</ZTag><ZTag :type="row.notesValid ? 'success' : 'danger'" size="small">{{ row.notesValid ? '资料齐全' : '备注待检查' }}</ZTag></span>
                  <span class="mono">{{ proxyText(row) }}</span>
                  <span :class="{ success: resultOf(row)?.status === 'success', danger: failedStates.includes(resultOf(row)?.status || '') }"><span>{{ progress(resultOf(row)) }}</span><span v-if="resultOf(row)?.message"> · {{ resultMessage(resultOf(row)) }}</span></span>
                  <ZButton v-if="resultOf(row)" size="small" @click="logRequestId = resultOf(row)!.requestId">查看日志</ZButton>
                </div>
              </div>
            </div>
          </template>
          <template #status="{ row }"><ZTag :type="statusTone(row)" size="small">{{ statusText(row) }}</ZTag></template>
          <template #credentials="{ row }">
            <div class="cred">
              <span class="cred-line"><ZTag :type="row.notesValid ? 'success' : 'danger'" size="small">{{ row.notesValid ? '资料齐全' : '备注待检查' }}</ZTag><span class="expiry" :class="`expiry-${expiryInfo(row.accessTokenExpiresAt).tone}`" :title="expiryInfo(row.accessTokenExpiresAt).title">令牌 {{ expiryInfo(row.accessTokenExpiresAt).text }}</span></span>
              <span class="proxy" :title="proxyText(row)">{{ proxyText(row) }}</span>
            </div>
          </template>
          <template #result="{ row }">
            <div v-if="resultOf(row)" class="result" :class="`result-${resultTone(row)}`">
              <span class="result-head"><RefreshCw v-if="isActive(resultOf(row))" class="spin" :size="13" /><CircleCheck v-else-if="resultOf(row)?.status === 'success'" :size="14" /><span class="result-label">{{ progress(resultOf(row)) }}</span><ZTag v-if="resultOf(row)?.automatic" size="small">自动</ZTag></span>
              <small v-if="resultOf(row)?.message" :title="resultMessage(resultOf(row))">{{ resultMessage(resultOf(row)) }}</small>
              <span class="result-foot"><time v-if="resultOf(row)?.finishedAt">{{ displayTime(resultOf(row)?.finishedAt) }}</time><ZButton size="small" variant="link" @click="logRequestId = resultOf(row)!.requestId">查看日志</ZButton></span>
            </div>
            <span v-else class="muted">未执行</span>
          </template>
          <template #actions="{ row }">
            <div class="account-actions">
              <ZButton v-if="canForce(row)" size="small" type="danger" :disabled="!enabled || busy" @click="openForce(row)">强制写回</ZButton>
              <ZButton v-else-if="canFreeFallback(row)" size="small" type="warning" :disabled="!enabled || busy" @click="openFreeFallback(row)">退回 Free</ZButton>
              <ZButton v-else-if="isActive(jobOf(row))" size="small" :disabled="busy" title="取消该账号" :aria-label="`取消 ${row.email || row.name}`" @click="cancel(jobOf(row))"><template #icon><Square :size="14" /></template><span class="action-label">取消</span></ZButton>
              <ZButton v-else size="small" type="primary" variant="plain" title="重新授权并写回原账号" :aria-label="`重新授权 ${row.email || row.name}`" :disabled="!enabled || !ready(row) || busy" @click="confirm([row])"><template #icon><KeyRound :size="15" /></template><span class="action-label">重新授权</span></ZButton>
              <ZButton class="logout-action" size="small" type="danger" variant="plain" title="退出所有登录" :disabled="!enabled || !logoutReady(row) || busy" :aria-label="`退出所有登录 ${row.email || row.name}`" @click="confirmLogout([row])"><template #icon><LogOut :size="15" /></template><span class="logout-label">退出登录</span></ZButton>
            </div>
          </template>
          <template #empty><ZEmpty :icon="Inbox" :title="loading ? '正在读取账号' : '没有匹配的账号'" :description="loading ? '' : '调整搜索词或筛选条件后重试'" surface="none" /></template>
        </ZTable>
        <ZPagination v-model:current-page="page" v-model:page-size="pageSize" class="pager" :total="filtered.length" :page-sizes="[10, 20, 50, 100]" />
      </ZCard>
    </section>
    <ZDialog v-model="showLogs" title="任务详细日志" width="48rem"><JobLogs v-if="logJob" :job="logJob" expanded /><p v-else class="muted">该任务已不在最近记录中</p></ZDialog>
    <ZDialog v-model="showLogout" type="danger" title="确认退出所有登录" width="34rem" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p>将退出以下 {{ logoutTargets.length }} 个账号在所有设备上的登录</p><ul class="targets"><li v-for="a in logoutTargets" :key="a.id">{{ a.email || a.name }}</li></ul>
      <Notice tone="danger">执行前停止所选账号的 CPR 调度，现有授权可能失效，所有设备可能需要重新登录</Notice><p class="muted">使用各账号现有授权及原出站设置（直连或绑定代理），不会自动重试或重新登录，需要恢复时请手动重新授权</p>
      <p v-if="error" class="danger" role="alert">{{ error }}</p>
      <template #footer><ZButton :disabled="busy" @click="showLogout = false">取消</ZButton><ZButton type="danger" :loading="busy" :disabled="!enabled || busy" @click="submitLogout">确认退出并停止调度</ZButton></template>
    </ZDialog>
    <ZDialog v-model="showConfirm" title="确认重新授权" width="32rem" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p>重新登录以下 {{ targets.length }} 个账号，新授权将写回原账号</p><ul class="targets"><li v-for="a in targets" :key="a.id">{{ a.email || a.name }}<span v-if="!a.enabled">已停用</span></li></ul><ul class="hints muted"><li>保留分组和账号代理，通常保留启用状态</li><li>确认原工作区失效时，切回同一用户的 Free 并停止调度</li><li>密码、2FA 密钥和 RT 不在页面展示</li></ul><p v-if="error" class="danger">{{ error }}</p>
      <template #footer><ZButton :disabled="busy" @click="showConfirm = false">取消</ZButton><ZButton type="primary" :loading="busy" :disabled="!enabled" @click="submit"><template #icon><KeyRound :size="16" /></template>确认重新授权</ZButton></template>
    </ZDialog>
    <ZDialog v-model="showForce" type="danger" title="强制写回其他工作区" width="34rem" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p class="dialog-target">{{ forceTarget?.email || forceTarget?.name }}</p>
      <template v-if="forceSource?.workspaceChoices?.length">
        <p>请选择要写入原账号的其他工作区</p>
        <ZSelect v-model="forceWorkspace" :options="forceSource.workspaceChoices.map(w => ({ value: w.id, label: w.id }))" aria-label="目标工作区" />
        <Notice tone="danger">将重新登录并替换原账号的工作区及授权，套餐以新授权为准，写回前会停止该账号调度</Notice>
        <p class="muted">仍需验证同一邮箱和用户，保留分组、代理、备注及其他配置，不显示 RT</p>
        <ZCheckbox v-model="forceConfirmed" class="force-confirm" :disabled="busy" label="我确认使用所选工作区的 RT 替换原授权，并停止该账号调度" />
      </template>
      <p v-else class="muted">旧任务未记录可用工作区，请先重新检测，取得工作区列表后再选择并确认强制写回</p>
      <p v-if="error" class="danger" role="alert">{{ error }}</p>
      <template #footer><ZButton :disabled="busy" @click="showForce = false">取消</ZButton><ZButton v-if="!forceSource?.workspaceChoices?.length" :disabled="busy || !forceTarget" @click="showForce = false; forceTarget && confirm([forceTarget])">重新检测工作区</ZButton><ZButton v-else type="danger" :loading="busy" :disabled="!enabled || busy || !forceConfirmed || !forceWorkspace" @click="submitForce">确认替换并停止调度</ZButton></template>
    </ZDialog>
    <ZDialog v-model="showFreeFallback" type="warning" title="退回同一用户 Free" width="34rem" :show-close="!busy" :close-on-click-modal="!busy" :close-on-press-escape="!busy">
      <p class="dialog-target">{{ freeTarget?.email || freeTarget?.name }}</p>
      <Notice tone="warning">上游没有返回任何候选工作区，确认后会重新获取同一用户的 Free 授权，写回原账号并停止该账号调度</Notice>
      <p class="muted">仍需验证邮箱、用户身份、Free 套餐、凭据版本和账号空闲状态，保留分组、代理、备注及其他配置，不显示 RT</p>
      <ZCheckbox v-model="freeConfirmed" class="force-confirm" :disabled="busy" label="我确认退回同一用户的 Free，替换原授权并停止该账号调度" />
      <p v-if="error" class="danger" role="alert">{{ error }}</p>
      <template #footer><ZButton :disabled="busy" @click="showFreeFallback = false">取消</ZButton><ZButton type="warning" :loading="busy" :disabled="!enabled || busy || !freeConfirmed" @click="submitFreeFallback">确认退回 Free</ZButton></template>
    </ZDialog>
  </main>
  </ZConfigProvider>
</template>
