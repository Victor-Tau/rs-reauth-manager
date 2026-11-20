export function normalizeEmailSuffix(value: string): string {
  const suffix = value.trim().replace(/^@/, '').toLowerCase()
  if (!suffix) return ''
  if (suffix.length > 253 || !suffix.includes('.') || suffix.split('.').some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))
    throw new Error('邮箱后缀无效，请填写域名，例如 bb.com，不含邮箱用户名或网址')
  return suffix
}

export function emailWithSuffix(email: string, suffix: string): string {
  try {
    const domain = normalizeEmailSuffix(suffix)
    const original = email.trim()
    return domain && /^[^\s@]+@[^\s@]+$/.test(original) ? `${original.split('@')[0]}@${domain}` : ''
  } catch { return '' }
}
