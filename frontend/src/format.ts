import type { Account, Job } from './types'

export function resultMessage(job?: Job): string {
  const message = job?.message || ''
  if (message === '2FA 验证未通过，请检查原账号备注') return '历史记录：2FA 流程未完成，未记录具体原因，不能据此判断密钥错误'
  if (message === '协议登录未完成，请检查账号或代理后重试') return '历史记录：协议登录未完成，未记录具体失败阶段'
  return message
}

export const isActive = (job?: Job) => !!job && ['queued', 'running'].includes(job.status)
export const needsReauth = (account: Account) => account.status === 'error'
export const isUnfinished = (job?: Job) => !!job && ['failed', 'review', 'interrupted'].includes(job.status)
export function planKey(value: string | null) { return value?.trim().toLowerCase() || 'unknown' }
export function planLabel(value: string) { return ({ team: 'Team', business: 'Business', plus: 'Plus', pro: 'Pro', free: 'Free', unknown: '未知' } as Record<string, string>)[planKey(value)] || value }
export function planType(value: string | null): 'success' | 'info' | 'primary' | 'default' {
  const plan = value?.trim().toLowerCase()
  return plan === 'team' || plan === 'business' ? 'success' : plan === 'plus' ? 'info' : plan?.startsWith('pro') ? 'primary' : 'default'
}
export function displayTime(value?: number | string | null) {
  if (value == null) return '-'
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toLocaleString('zh-CN', { hour12: false }) : '-'
}
export function statusText(a: Account) { return !a.enabled ? '已停用' : ({ normal: '正常', error: '异常', quota_paused: '额度暂停', quota_exhausted: '额度耗尽', rate_limited: '限流' } as Record<string, string>)[a.status] || a.status }
export function progress(job?: Job) {
  if (job?.kind === 'logout') return ({ queued: '等待退出', preparing: '核对账号', logout: '退出中', logged_out: '已退出', success: '已退出', failed: '退出失败', review: '需要核对', interrupted: '已中断', cancelled: '已取消' } as Record<string, string>)[job.step] || '退出中'
  return !job ? '未执行' : ({ queued: '等待处理', preparing: '核对资料', session: '建立会话', login: '协议登录', mfa: '验证 2FA', saving: '写回授权', success: '已写回', free: '登录成功', failed: '登录失败', workspace: '工作区不匹配', review: '需要核对', interrupted: '已中断', cancelled: '已取消' } as Record<string, string>)[job.step] || '登录中'
}

export type Tone = 'default' | 'primary' | 'success' | 'info' | 'warning' | 'danger'
export function statusTone(a: Account): Tone {
  if (!a.enabled) return 'default'
  return ({ normal: 'success', error: 'danger', quota_paused: 'warning', quota_exhausted: 'warning', rate_limited: 'warning' } as Record<string, Tone>)[a.status] || 'default'
}
export function jobTone(job?: Job): Tone {
  if (!job) return 'default'
  if (job.status === 'success') return 'success'
  if (isUnfinished(job)) return 'danger'
  return isActive(job) ? 'info' : 'default'
}
export function expiryInfo(value: string | null, now = Date.now()): { text: string; tone: Tone; title: string } {
  const at = value ? new Date(value).getTime() : NaN
  if (!Number.isFinite(at)) return { text: '未知', tone: 'default', title: '' }
  const left = at - now, title = displayTime(value)
  if (left <= 0) return { text: '已过期', tone: 'danger', title }
  const hours = left / 3600000
  if (hours < 1) return { text: `${Math.max(1, Math.round(left / 60000))} 分钟后到期`, tone: 'warning', title }
  if (hours < 24) return { text: `${Math.floor(hours)} 小时后到期`, tone: 'warning', title }
  return { text: `${Math.floor(hours / 24)} 天后到期`, tone: 'default', title }
}
