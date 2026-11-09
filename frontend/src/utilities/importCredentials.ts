export interface ImportCredentials { email: string; password: string; totpSecret: string; line: number }

export function parseImportCredentials(text: string): ImportCredentials[] {
  const rows: ImportCredentials[] = [], emails = new Set<string>()
  for (const [index, raw] of text.split(/\r\n|\n|\r/).entries()) {
    const value = raw.trim()
    if (!value) continue
    const parts = value.split('----'), line = index + 1
    if (parts.length !== 3 || !/^[^\s@]+@[^\s@]+$/.test(parts[0].trim()) || !parts[1] || /[\u0000-\u001f\u007f]/.test(value) || !/^[A-Z2-7]+=*$/i.test(parts[2].trim().replace(/ /g, '')))
      throw new Error(`第 ${line} 行格式无效，请使用 邮箱----密码----Base32 2FA 密钥`)
    const email = parts[0].trim(), key = email.toLowerCase()
    if (emails.has(key)) throw new Error(`第 ${line} 行邮箱重复，请移除重复行`)
    emails.add(key)
    rows.push({ email, password: parts[1], totpSecret: parts[2].trim().toUpperCase().replace(/ /g, ''), line })
    if (rows.length > 100) throw new Error('每次最多导入 100 个账号，请分批提交')
  }
  if (!rows.length) throw new Error('请填写登录资料，每行一个账号')
  return rows
}
