export interface AccountGroup { id: string; name: string }
export interface Account { id: string; name: string; email: string | null; enabled: boolean; planType: string | null; status: string; accessTokenExpiresAt: string | null; proxy: string | null; notesValid: boolean; groups: AccountGroup[] }
export interface Job { kind?: string; automatic?: boolean; requestId: string; accountId: string; status: string; step: string; message: string; startedAt: number | null; finishedAt: number | null; workspaceChoices?: { id: string }[]; forceWorkspaceId?: string | null; logs?: { at: number; message: string }[] }
export interface Bridge { readonly version: 2; readonly theme: 'light' | 'dark'; request(input: { method: 'GET' | 'POST'; path: string; contentType?: string; body?: string }): Promise<{ status: number; contentType: string; body: ArrayBuffer }> }
declare global { interface Window { codexProxyPlugin?: Bridge } }

export interface AutomationConfig {
  enabled: boolean; intervalMinutes: number; cooldownHours: number
  allGroups: boolean; groupIds: string[]; includeUngrouped: boolean
  statuses: string[]; allPlans: boolean; plans: string[]; enabledOnly: boolean
}
export const defaultAutomation = (): AutomationConfig => ({ enabled: false, intervalMinutes: 15, cooldownHours: 24, allGroups: true, groupIds: [], includeUngrouped: true, statuses: ['error'], allPlans: true, plans: [], enabledOnly: true })
export interface ImportSettings {
  notes: string; enabled: boolean; concurrencyLimit: number | null; weight: number
  modelAccess: { mode: 'all' | 'allowlist' | 'denylist'; models: string[] }; groupIds: string[]
}
export interface ImportRequest {
  requestId: string; email: string; password: string; totpSecret: string; name: string
  workspaceId: string; transport: 'http' | 'prefer_websocket'; outboundProxyId: string
  loginProxyUrl: string; saveLoginNotes: boolean; settings: ImportSettings
}
export interface ImportProxy { id: string; name: string; endpoint: string; enabled: boolean; hasAuthentication: boolean }
export interface Options { groups: AccountGroup[]; proxies: ImportProxy[] }
