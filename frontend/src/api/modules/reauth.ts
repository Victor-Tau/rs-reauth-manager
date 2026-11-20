import type { AutomationConfig, ImportRequest, EmailChangeRequest } from '../../types'
import { request } from '../request'
import { parseAccounts, parseConfig, parseJobs, parseTick, parseOptions, parseEmailChanges, parseEmailCredentials, parseEmailSettings } from '../schemas/reauth'

export const api = {
  emailSettings: () => request('GET', 'api/email-settings').then(parseEmailSettings),
  saveEmailSettings: (emailSuffix: string) => request('POST', 'api/email-settings', { emailSuffix }).then(parseEmailSettings),
  emailChanges: () => request('GET', 'api/email-changes').then(parseEmailChanges),
  emailBegin: (input: EmailChangeRequest) => request('POST', 'api/email-begin', input).then(parseEmailChanges),
  emailCode: (requestId: string, code: string) => request('POST', 'api/email-code', { requestId, code }).then(parseEmailChanges),
  emailCancel: (requestId: string) => request('POST', 'api/email-cancel', { requestId }).then(parseEmailChanges),
  emailReveal: (requestId: string) => request('POST', 'api/email-reveal', { requestId }).then(parseEmailCredentials),
  emailDelete: (requestId: string) => request('POST', 'api/email-delete', { requestId }).then(parseEmailChanges),
  setConfig: (enabled: boolean, automation?: AutomationConfig) => request('POST', 'api/config', { enabled, ...(automation ? { automation } : {}) }).then(parseConfig),
  options: () => request('GET', 'api/options').then(parseOptions),
  importAccount: (input: ImportRequest) => request('POST', 'api/import', input).then(parseJobs),
  importBatch: (requestId: string, accounts: ImportRequest[]) => request('POST', 'api/import-batch', { requestId, accounts }).then(parseJobs),
  accounts: () => request('GET', 'api/accounts').then(parseAccounts),
  jobs: () => request('GET', 'api/jobs').then(parseJobs),
  submit: (accountIds: string[], requestId: string) => request('POST', 'api/submit', { accountIds, requestId }).then(parseJobs),
  reauthEmailCode: (requestId: string, code: string) => request('POST', 'api/reauth-email-code', { requestId, code }).then(parseTick),
  logout: (accountIds: string[], requestId: string) => request('POST', 'api/logout', { accountIds, requestId, confirmation: 'logout_all_and_disable' }).then(parseJobs),
  cancel: (requestId: string | null = null) => request('POST', 'api/cancel', { requestId }).then(parseJobs),
  tick: () => request('POST', 'api/tick', {}).then(parseTick),
  forceSubmit: (sourceRequestId: string, workspaceId: string, requestId: string) => request('POST', 'api/force-submit', { sourceRequestId, workspaceId, requestId, confirmation: 'replace_workspace_and_disable' }).then(parseJobs),
  freeFallback: (sourceRequestId: string, requestId: string) => request('POST', 'api/free-fallback', { sourceRequestId, requestId, confirmation: 'fallback_free_and_disable' }).then(parseJobs),
}
