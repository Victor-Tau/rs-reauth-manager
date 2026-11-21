import type { Account, Job, EmailCodePolicy, AutomationConfig, Options, EmailChangeRecord } from '../../types'
import { isRecord } from '../request'

function parseEmailCodePolicy(value: unknown): EmailCodePolicy {
  if (value === undefined) return 'wait'
  if (value !== 'wait' && value !== 'stop') throw new Error('邮箱验证码处理配置无效')
  return value
}

export function parseConfig(value: unknown): { enabled: boolean; automation?: AutomationConfig; emailCodePolicy: EmailCodePolicy } {
  if (!isRecord(value) || typeof value.enabled !== 'boolean') throw new Error('插件开关状态无效')
  return { emailCodePolicy: parseEmailCodePolicy(value.emailCodePolicy), enabled: value.enabled, ...(value.automation === undefined ? {} : { automation: parseAutomation(value.automation) }) }
}

const nullableString = (value: unknown) => value === null || typeof value === 'string'
const nullableTime = (value: unknown) => value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0
function account(value: unknown): value is Account {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string'
    && nullableString(value.email) && nullableString(value.planType) && nullableString(value.proxy)
    && nullableString(value.accessTokenExpiresAt) && typeof value.enabled === 'boolean'
    && typeof value.notesValid === 'boolean' && typeof value.status === 'string'
    && Array.isArray(value.groups) && value.groups.every(group => isRecord(group) && typeof group.id === 'string' && typeof group.name === 'string')
}
function job(value: unknown): value is Job {
  return isRecord(value) && typeof value.requestId === 'string' && typeof value.accountId === 'string'
    && typeof value.message === 'string' && typeof value.step === 'string'
    && (value.label === undefined || typeof value.label === 'string' && value.label.length <= 254)
    && typeof value.status === 'string' && ['queued', 'running', 'success', 'failed', 'review', 'interrupted', 'cancelled'].includes(value.status)
    && nullableTime(value.startedAt) && nullableTime(value.finishedAt)
    && (value.kind === undefined || typeof value.kind === 'string' && ['', 'reauth', 'import', 'logout'].includes(value.kind))
    && (value.workspaceChoices === undefined || Array.isArray(value.workspaceChoices) && value.workspaceChoices.length <= 30 && value.workspaceChoices.every(w => isRecord(w) && typeof w.id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(w.id) && (w.name === undefined || typeof w.name === 'string' && w.name.length <= 80)))
    && (value.forceWorkspaceId === undefined || nullableString(value.forceWorkspaceId))
    && (value.logs === undefined || Array.isArray(value.logs) && value.logs.length <= 100 && value.logs.every(log => isRecord(log) && typeof log.at === 'number' && Number.isSafeInteger(log.at) && log.at >= 0 && typeof log.message === 'string' && log.message.length <= 1000))
}
export function parseAccounts(value: unknown): { accounts: Account[] } {
  if (!isRecord(value) || !Array.isArray(value.accounts) || !value.accounts.every(account))
    throw new Error('插件账号列表格式无效')
  return { accounts: value.accounts }
}
export function parseJobs(value: unknown): { jobs: Job[]; enabled?: boolean; automation?: AutomationConfig; emailCodePolicy: EmailCodePolicy } {
  if (!isRecord(value) || !Array.isArray(value.jobs) || !value.jobs.every(job))
    throw new Error('插件任务列表格式无效')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('插件开关状态无效')
  return { emailCodePolicy: parseEmailCodePolicy(value.emailCodePolicy), jobs: value.jobs, ...(value.enabled === undefined ? {} : { enabled: value.enabled }), ...(value.automation === undefined ? {} : { automation: parseAutomation(value.automation) }) }
}
export function parseTick(value: unknown): { ok: true } {
  if (!isRecord(value) || value.ok !== true) throw new Error('插件任务推进结果无效')
  return { ok: true }
}

export function parseAutomation(value: unknown): AutomationConfig {
  if (!isRecord(value) || !['enabled', 'allGroups', 'includeUngrouped', 'allPlans', 'enabledOnly'].every(k => typeof value[k] === 'boolean')
    || !['intervalMinutes', 'cooldownHours'].every(k => typeof value[k] === 'number' && Number.isSafeInteger(value[k]) && Number(value[k]) > 0)
    || !['groupIds', 'statuses', 'plans'].every(k => Array.isArray(value[k]) && value[k].every((v: unknown) => typeof v === 'string')))
    throw new Error('自动授权配置格式无效')
  return value as unknown as AutomationConfig
}
export function parseOptions(value: unknown): Options {
  if (!isRecord(value) || !Array.isArray(value.groups) || !value.groups.every(g => isRecord(g) && typeof g.id === 'string' && typeof g.name === 'string')
    || !Array.isArray(value.proxies) || !value.proxies.every(p => isRecord(p) && ['id', 'name', 'endpoint'].every(k => typeof p[k] === 'string') && typeof p.enabled === 'boolean' && typeof p.hasAuthentication === 'boolean'))
    throw new Error('导入选项格式无效')
  return value as unknown as Options
}

export function parseEmailChanges(value: unknown): { records: EmailChangeRecord[] } {
  if (!isRecord(value) || !Array.isArray(value.records) || value.records.length > 100 || !value.records.every(r => isRecord(r)
    && ['requestId', 'email', 'newEmail', 'step', 'message'].every(k => typeof r[k] === 'string')
    && typeof r.status === 'string' && ['running', 'verifying', 'success', 'failed', 'review', 'interrupted', 'cancelled'].includes(r.status)
    && typeof r.createdAt === 'number' && Number.isSafeInteger(r.createdAt) && r.createdAt >= 0 && typeof r.hasCredentials === 'boolean'
    && (r.logs === undefined || Array.isArray(r.logs) && r.logs.length <= 100 && r.logs.every(log => isRecord(log) && typeof log.at === 'number' && Number.isSafeInteger(log.at) && log.at >= 0 && typeof log.message === 'string' && log.message.length <= 1000))))
    throw new Error('邮箱换绑记录格式无效')
  return value as unknown as { records: EmailChangeRecord[] }
}
export function parseEmailCredentials(value: unknown): string {
  if (!isRecord(value) || typeof value.credentials !== 'string' || value.credentials.length > 2000) throw new Error('换绑资料格式无效')
  return value.credentials
}
export function parseEmailSettings(value: unknown): { emailSuffix: string } {
  if (!isRecord(value) || typeof value.emailSuffix !== 'string' || value.emailSuffix.length > 253) throw new Error('邮箱后缀设置格式无效')
  return { emailSuffix: value.emailSuffix }
}
