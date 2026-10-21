import type { AutomationConfig, ImportRequest } from '../../types'
import { request } from '../request'
import { parseAccounts, parseConfig, parseJobs, parseTick, parseOptions } from '../schemas/reauth'

export const api = {
  setConfig: (enabled: boolean, automation?: AutomationConfig) => request('POST', 'api/config', { enabled, ...(automation ? { automation } : {}) }).then(parseConfig),
  options: () => request('GET', 'api/options').then(parseOptions),
  importAccount: (input: ImportRequest) => request('POST', 'api/import', input).then(parseJobs),
  accounts: () => request('GET', 'api/accounts').then(parseAccounts),
  jobs: () => request('GET', 'api/jobs').then(parseJobs),
  submit: (accountIds: string[], requestId: string) => request('POST', 'api/submit', { accountIds, requestId }).then(parseJobs),
  logout: (accountIds: string[], requestId: string) => request('POST', 'api/logout', { accountIds, requestId, confirmation: 'logout_all_and_disable' }).then(parseJobs),
  cancel: (requestId: string | null = null) => request('POST', 'api/cancel', { requestId }).then(parseJobs),
  tick: () => request('POST', 'api/tick', {}).then(parseTick),
  forceSubmit: (sourceRequestId: string, workspaceId: string, requestId: string) => request('POST', 'api/force-submit', { sourceRequestId, workspaceId, requestId, confirmation: 'replace_workspace_and_disable' }).then(parseJobs),
  freeFallback: (sourceRequestId: string, requestId: string) => request('POST', 'api/free-fallback', { sourceRequestId, requestId, confirmation: 'fallback_free_and_disable' }).then(parseJobs),
}
