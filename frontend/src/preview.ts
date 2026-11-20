import { applyTheme, createTheme } from '@codex-proxy/ui/theme'
import { defaultAutomation } from './types'
import type { Account, Job, EmailChangeRecord } from './types'
import { normalizeEmailSuffix } from './utilities/emailSuffix'
export function installPreview() {
  if (window.codexProxyPlugin) return
  const theme = new URLSearchParams(location.search).get('theme') === 'dark' ? 'dark' : 'light'
  applyTheme(document.documentElement, createTheme({ scheme: theme }))
  const accounts: Account[] = Array.from({ length: 61 }, (_, i) => ({ id: `acct_preview_${i}`, name: `team+account-${i + 1}@example.com+workspace3`, email: `account-${i + 1}@example.com`, enabled: i !== 4, planType: i % 6 ? 'team' : 'plus', status: i % 3 ? 'normal' : 'error', accessTokenExpiresAt: new Date(Date.now() + 86400000 * 6).toISOString(), proxy: i === 3 ? null : `http://127.0.0.1:${21001 + i}`, notesValid: i !== 7, groups: i % 5 === 0 ? [] : [{ id: 'preview-primary', name: '示例部署组' }, ...(i % 7 === 0 ? [{ id: 'preview-shared', name: '跨区域共享账号组' }] : [])] }))
  let jobs: Job[] = [{ requestId: 'preview-workspace:acct_preview_0', accountId: 'acct_preview_0', status: 'failed', step: 'workspace', message: '无法匹配原账号工作区，已停止写回', startedAt: Date.now() - 10000, finishedAt: Date.now(), workspaceChoices: [{ id: 'preview-other-team' }, { id: 'preview-personal-free' }] }]
  let enabled = true
  const emailChanges: EmailChangeRecord[] = []
  const emailCredentials = new Map<string, string>()
  let emailSuffix = ''
  let automation = defaultAutomation()
  const diagnostics = ['创建 2FA 验证挑战：上游未成功创建 2FA 验证挑战，并非已确认验证码错误（最后响应 HTTP 403）', '提交 2FA 动态码：上游限制登录频率，不自动重试（最后响应 HTTP 429）', '密码验证：请求超时，保留原代理，不自动重试', '2FA 验证未通过，请检查原账号备注']
  jobs.push(...diagnostics.map((message, i): Job => ({ requestId: `preview-diagnostic:${i}`, accountId: `acct_preview_${i + 1}`, status: 'failed', step: 'failed', message, startedAt: Date.now() - 10000, finishedAt: Date.now() })))
  const encode = (body: unknown) => ({ status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(body)).buffer as ArrayBuffer })
  window.codexProxyPlugin = { version: 2, theme, async request(input) {
    const body = input.body ? JSON.parse(input.body) : {}
    if (input.path === 'api/accounts') return encode({ accounts })
    if (input.path === 'api/jobs') return encode({ jobs, enabled, automation })
    if (input.path === 'api/options') return encode({ groups: [{ id: 'preview-primary', name: '示例部署组' }, { id: 'preview-shared', name: '跨区域共享账号组' }], proxies: [{ id: 'preview-proxy', name: '示例代理', endpoint: 'http://127.0.0.1:21001', enabled: true, hasAuthentication: false }] })
    if (input.path === 'api/email-changes') return encode({ records: [...emailChanges].reverse() })
    if (input.path === 'api/email-settings') {
      if (input.method === 'POST') emailSuffix = normalizeEmailSuffix(body.emailSuffix)
      return encode({ emailSuffix })
    }
    if (input.path === 'api/email-begin') {
      if (!enabled) throw new Error('插件已关闭')
      if (!emailChanges.some(r => r.requestId === body.requestId)) {
        if (emailChanges.some(r => ['running', 'verifying'].includes(r.status))) throw new Error('换绑会话正在进行')
        emailChanges.push({ requestId: body.requestId, email: body.email, newEmail: body.newEmail, status: 'running', step: 'email_code', message: '模拟验证码已发送，输入任意六位数字完成模拟换绑，未访问真实账号', createdAt: Date.now(), hasCredentials: false })
        emailCredentials.set(body.requestId, `${body.newEmail}----${body.password}----${body.totpSecret}`)
      }
      return encode({ records: [...emailChanges].reverse() })
    }
    if (['api/email-code', 'api/email-cancel', 'api/email-reveal', 'api/email-delete'].includes(input.path)) {
      const record = emailChanges.find(r => r.requestId === body.requestId)
      if (!record) throw new Error('换绑记录不存在')
      if (input.path === 'api/email-code') {
        if (!enabled || record.status !== 'running' || !/^[0-9]{6}$/.test(body.code)) throw new Error('验证码或会话状态无效')
        record.status = 'success'; record.step = 'email_verify'; record.hasCredentials = true; record.message = '模拟换绑成功，资料仅在预览内存中保存，未访问真实账号'
      }
      if (input.path === 'api/email-cancel') { record.status = 'cancelled'; record.message = '模拟会话已取消'; emailCredentials.delete(record.requestId) }
      if (input.path === 'api/email-reveal') {
        if (!record.hasCredentials) throw new Error('尚无已保存的资料')
        return encode({ credentials: emailCredentials.get(record.requestId) })
      }
      if (input.path === 'api/email-delete') {
        if (['running', 'verifying'].includes(record.status)) throw new Error('请先取消换绑会话')
        emailChanges.splice(emailChanges.indexOf(record), 1); emailCredentials.delete(record.requestId)
      }
      return encode({ records: [...emailChanges].reverse() })
    }
    if (input.path === 'api/import' || input.path === 'api/import-batch') {
      if (!enabled) throw new Error('插件已关闭，请先打开插件开关')
      for (const [index, entry] of (input.path === 'api/import-batch' ? body.accounts : [body]).entries()) {
        const id = `acct_preview_import_${accounts.length}`
        accounts.push({ id, name: entry.name, email: entry.email, enabled: entry.settings.enabled, planType: 'free', status: 'normal', accessTokenExpiresAt: null, proxy: entry.outboundProxyId ? 'http://127.0.0.1:21001' : null, notesValid: entry.saveLoginNotes, groups: entry.settings.groupIds.map((id: string) => ({ id, name: id === 'preview-primary' ? '示例部署组' : '跨区域共享账号组' })) })
        jobs.push({ requestId: input.path === 'api/import-batch' ? `${body.requestId}:import:${index}` : `${body.requestId}:import`, label: entry.email, accountId: id, kind: 'import', status: 'success', step: 'success', message: '模拟导入成功，未访问真实账号', startedAt: Date.now(), finishedAt: Date.now() })
      }
      return encode({ jobs })
    }
    if (input.path === 'api/config') {
      enabled = body.enabled
      if (!enabled) for (const r of emailChanges) if (r.status === 'running') { r.status = 'cancelled'; r.message = '插件已关闭'; emailCredentials.delete(r.requestId) }
      if (body.automation) automation = body.automation
      if (!enabled) for (const j of jobs) if (['queued', 'running'].includes(j.status)) { j.status = j.step = 'cancelled'; j.message = '插件已关闭，已停止队列'; j.finishedAt = Date.now() }
      return encode({ enabled, automation })
    }
    if (!enabled && ['api/submit', 'api/logout', 'api/force-submit', 'api/free-fallback'].includes(input.path)) throw new Error('插件已关闭，请先打开插件开关')
    if (input.path === 'api/logout') {
      if (body.confirmation !== 'logout_all_and_disable') throw new Error('请确认退出所有登录并停止调度')
      jobs.push(...body.accountIds.map((id: string) => ({ requestId: `${body.requestId}:${id}`, accountId: id, kind: 'logout', status: 'queued', step: 'queued', message: '', startedAt: null, finishedAt: null })))
      return encode({ jobs })
    }
    if (input.path === 'api/force-submit') {
      const source = jobs.find(j => j.requestId === body.sourceRequestId)
      if (!source || body.confirmation !== 'replace_workspace_and_disable' || !source.workspaceChoices?.some(w => w.id === body.workspaceId)) throw new Error('工作区选择或确认无效')
      jobs.push({ requestId: `${body.requestId}:${source.accountId}`, accountId: source.accountId, status: 'queued', step: 'queued', message: '管理员已确认', startedAt: null, finishedAt: null, forceWorkspaceId: body.workspaceId })
      return encode({ jobs })
    }
    if (input.path === 'api/submit') { jobs = [...jobs.filter(j => ['queued', 'running'].includes(j.status)), ...body.accountIds.map((id: string) => ({ requestId: `${body.requestId}:${id}`, accountId: id, status: 'queued', step: 'queued', message: '', startedAt: null, finishedAt: null }))]; return encode({ jobs }) }
    if (input.path === 'api/cancel') { for (const j of jobs) if (['queued', 'running'].includes(j.status) && (!body.requestId || body.requestId === j.requestId)) { j.status = j.step = 'cancelled'; j.message = '已取消'; j.finishedAt = Date.now() } return encode({ jobs }) }
    if (input.path === 'api/tick') { const j = jobs.find(j => ['queued', 'running'].includes(j.status)); if (j) { if (j.status === 'queued') { j.status = 'running'; j.step = j.kind === 'logout' ? 'logout' : 'login'; j.startedAt = Date.now() } else { j.status = j.step = 'success'; j.message = j.forceWorkspaceId ? '管理员已确认，其他工作区授权已写回原账号，已停止调度' : '新授权已写回原账号，配置校验通过'; if (j.kind === 'logout') { accounts.find(a => a.id === j.accountId)!.enabled = false; j.step = 'logged_out'; j.message = '模拟退出所有登录，已停止调度，未访问真实账号' } if (j.forceWorkspaceId) { const a = accounts.find(a => a.id === j.accountId)!; a.enabled = false; a.status = 'normal' } j.finishedAt = Date.now() } } return encode({ ok: true }) }
    throw new Error('未知预览请求')
  } }
}
