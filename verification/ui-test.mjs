import { fileURLToPath } from 'node:url'
const { chromium } = await import(process.env.RS_REAUTH_PLAYWRIGHT_MODULE || 'playwright')
import assert from 'node:assert/strict'
import { resolveTheme, DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR } from '../frontend/node_modules/@codex-proxy/ui/dist/theme/index.js'
import { mkdir, readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
const root = fileURLToPath(new URL('..', import.meta.url))
// Production assets under an HTTP sandbox iframe, with an in-memory mock host only
await mkdir(resolve(root, '.cache/reauth-ui'), { recursive: true })
const browser = await chromium.launch({ headless: true, ...(process.env.RS_REAUTH_CHROMIUM ? { executablePath: process.env.RS_REAUTH_CHROMIUM } : {}), args: ['--no-sandbox'] })
try {
  for (const width of [1440, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    const errors = []
    page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(tokens => {
      document.addEventListener('DOMContentLoaded', () => { for (const [key, value] of Object.entries(tokens)) document.documentElement.style.setProperty(key, value) })
      let enabled = true, jobs = []
      let automation = { enabled: false, intervalMinutes: 15, cooldownHours: 24, allGroups: true, groupIds: [], includeUngrouped: true, statuses: ['error'], allPlans: true, plans: [], enabledOnly: true }
      const account = { id: 'fixture', name: 'fixture', email: 'fixture@example.com', enabled: true, planType: 'free', status: 'error', accessTokenExpiresAt: null, proxy: 'http://127.0.0.1:21001', notesValid: true, groups: [{ id: 'g1', name: '测试组' }, { id: 'g2', name: '共享组' }] }
      const accounts = [account, { ...account, id: 'second', email: 'second@example.com', groups: [{ id: 'g2', name: '共享组' }] }, { ...account, id: 'ungrouped', email: 'ungrouped@example.com', groups: [] }]
      window.__calls = []
      window.codexProxyPlugin = { version: 2, theme: 'light', async request(input) {
        window.__calls.push(input)
        const data = input.body ? JSON.parse(input.body) : {}
        let result
        if (input.path === 'api/accounts') result = { accounts }
        else if (input.path === 'api/jobs') result = { jobs, enabled, automation }
        else if (input.path === 'api/config') {
          if (window.__failConfig) throw new Error('保存开关失败')
          enabled = data.enabled
          if (data.automation) automation = data.automation
          if (!enabled) for (const j of jobs) { j.status = 'cancelled'; j.finishedAt = 2 }
          result = { enabled, automation }
        }
        else if (input.path === 'api/logout') {
          jobs.push(...data.accountIds.map(id => ({ requestId: `${data.requestId}:${id}`, accountId: id, kind: 'logout', status: 'queued', step: 'queued', message: '', startedAt: null, finishedAt: null }))); result = { jobs }
        }
        else if (input.path === 'api/submit') {
          jobs = [{ requestId: `${data.requestId}:fixture`, accountId: 'fixture', status: 'queued', step: 'queued', message: '', startedAt: null, finishedAt: null }]
          result = { jobs }
        }
        else if (input.path === 'api/options') result = { groups: [{ id: 'g1', name: '测试组' }], proxies: [{ id: 'p1', name: '测试代理', endpoint: 'http://127.0.0.1:21001', enabled: true, hasAuthentication: false }] }
        else if (input.path === 'api/import') {
          jobs.push({ requestId: `${data.requestId}:import`, accountId: 'imported-account', kind: 'import', status: 'success', step: 'success', message: '账号已导入 CPR，参数校验通过', startedAt: 1, finishedAt: 2, logs: [{ at: 1, message: '授权确认 · 收到响应 · HTTP 200' }] }); result = { jobs }
        }
        else if (input.path === 'api/tick') {
          for (const j of jobs.filter(j => j.kind === 'logout' && j.status === 'queued')) { j.status = 'success'; j.step = 'logged_out'; j.message = '上游已确认退出所有登录，已停止调度'; j.startedAt = 1; j.finishedAt = 2; j.logs = [{ at: 1, message: '退出所有登录 · 发起请求 · POST' }, { at: 2, message: '退出所有登录 · 收到响应 · HTTP 200' }]; accounts.find(a => a.id === j.accountId).enabled = false }
          result = { ok: true }
        }
        else throw Error('Unexpected route')
        return { status: 200, contentType: 'application/json', body: new TextEncoder().encode(JSON.stringify(result)).buffer }
      } }
    }, resolveTheme('light', DEFAULT_THEME_COLOR, DEFAULT_CUSTOM_THEME_COLOR).tokens)
    await page.route('http://plugin.test/**', async route => {
      const url = new URL(route.request().url())
      if (url.pathname === '/host.html') return route.fulfill({ contentType: 'text/html', body: '<iframe src="/" sandbox="allow-scripts" style="width:100%;height:970px;border:0"></iframe>' })
      const file = resolve(root, 'frontend/dist', url.pathname === '/' ? 'index.html' : '.' + url.pathname)
      await route.fulfill({ body: await readFile(file), contentType: { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[extname(file)] })
    })
    await page.goto('http://plugin.test/host.html')
    const scope = page.frameLocator('iframe')
    const child = page.frames().find(f => f !== page.mainFrame())
    await scope.getByText('插件已开启', { exact: true }).waitFor()
    const chooseGroup = async label => {
      await scope.getByRole('combobox', { name: '账号分组筛选', exact: true }).click()
      await scope.getByRole('option', { name: label, exact: true }).click()
    }
    await chooseGroup('测试组（1）')
    assert.equal(await scope.getByText('fixture@example.com', { exact: true }).count(), 1)
    assert.equal(await scope.getByText('second@example.com', { exact: true }).count(), 0)
    await chooseGroup('共享组（2）')
    assert.equal(await scope.getByText('fixture@example.com', { exact: true }).count(), 1)
    assert.equal(await scope.getByText('second@example.com', { exact: true }).count(), 1)
    await chooseGroup('未分组（1）')
    assert.equal(await scope.getByText('ungrouped@example.com', { exact: true }).count(), 1)
    assert.equal(await scope.getByText('fixture@example.com', { exact: true }).count(), 0)
    await chooseGroup('全部分组（3）')
    const logoutButton = scope.getByRole('button', { name: '退出所有登录 fixture@example.com', exact: true })
    await logoutButton.click()
    const dialog = scope.getByRole('dialog', { name: '确认退出所有登录', exact: true })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal(await child.evaluate(() => window.__calls.filter(c => c.path === 'api/logout').length), 0)
    await logoutButton.click()
    await dialog.getByRole('button', { name: '确认退出并停止调度', exact: true }).click()
    await scope.getByText('已退出', { exact: true }).first().waitFor()
    await dialog.waitFor({ state: 'hidden' })
    const logoutBody = await child.evaluate(() => JSON.parse(window.__calls.find(c => c.path === 'api/logout').body))
    assert.deepEqual(logoutBody.accountIds, ['fixture']); assert.equal(logoutBody.confirmation, 'logout_all_and_disable')
    assert.deepEqual(Object.keys(logoutBody).sort(), ['accountIds', 'confirmation', 'requestId'])
    const logoutBounds = await logoutButton.boundingBox()
    const reauthBounds = await scope.getByRole('button', { name: '重新授权 fixture@example.com', exact: true }).boundingBox()
    assert.ok(Math.abs(logoutBounds.y + logoutBounds.height / 2 - reauthBounds.y - reauthBounds.height / 2) < 2, 'Account actions must share a row')
    await scope.getByRole('button', { name: '查看日志', exact: true }).first().click()
    const logDialog = scope.getByRole('dialog', { name: '任务详细日志', exact: true })
    const logText = logDialog.getByLabel('任务详细日志', { exact: true })
    await logText.waitFor()
    assert.match(await logText.innerText(), /收到响应.*HTTP 200/)
    await logText.click(); await page.keyboard.press('Escape'); await logDialog.waitFor({ state: 'hidden' })
    await page.screenshot({ path: resolve(root, `.cache/reauth-ui/accounts-${width}.png`), fullPage: true, animations: 'disabled' })
    await scope.getByRole('button', { name: '参数配置', exact: true }).click()
    await scope.getByRole('button', { name: '保存配置', exact: true }).waitFor()
    const toggleSize = await scope.getByRole('switch', { name: '开启自动重新授权', exact: true }).locator('..').boundingBox()
    assert.ok(toggleSize.width < 250, `Switch stretched: ${toggleSize.width}`)
    await scope.getByRole('switch', { name: '开启自动重新授权', exact: true }).locator('..').click()
    await scope.getByRole('checkbox', { name: '全部分组（包含未分组）', exact: true }).locator('..').click()
    await scope.getByRole('checkbox', { name: '测试组', exact: true }).locator('..').click()
    await scope.getByRole('checkbox', { name: '未分组', exact: true }).locator('..').click()
    await scope.getByRole('checkbox', { name: '全部订阅', exact: true }).locator('..').click()
    await scope.getByRole('checkbox', { name: 'Free', exact: true }).locator('..').click()
    await scope.getByRole('spinbutton', { name: '扫描间隔（分钟）', exact: true }).fill('30')
    await scope.getByRole('button', { name: '保存配置', exact: true }).click()
    await scope.getByText('配置已保存', { exact: true }).waitFor()
    const savedConfig = await child.evaluate(() => JSON.parse(window.__calls.filter(c => c.path === 'api/config').at(-1).body).automation)
    assert.deepEqual(savedConfig, { enabled: true, intervalMinutes: 30, cooldownHours: 24, allGroups: false, groupIds: ['g1'], includeUngrouped: false, statuses: ['error'], allPlans: false, plans: ['free'], enabledOnly: true })
    await page.screenshot({ path: resolve(root, `.cache/reauth-ui/config-${width}.png`), fullPage: true })
    await scope.getByRole('button', { name: '账号导入', exact: true }).click()
    const pastedEmail = 'fixture+import@icloud.com', pastedPassword = 'fixture&password@@ value ', pastedSecret = 'GEZDGNBVGY3TQOJQ'
    assert.equal(await scope.getByRole('spinbutton', { name: '导入账号权重', exact: true }).inputValue(), '5')
    assert.equal(await scope.getByRole('switch', { name: '导入完成后启用调度', exact: true }).isChecked(), true)
    assert.equal(await scope.getByRole('checkbox', { name: '将登录资料保存到 CPR 账号备注，供后续自动重新授权使用', exact: true }).isChecked(), true)
    const paste = async (label, value) => scope.getByLabel(label, { exact: true }).evaluate((element, text) => {
      const clipboardData = new DataTransfer(); clipboardData.setData('text/plain', text)
      element.dispatchEvent(new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true }))
    }, value)
    for (const label of ['粘贴登录资料', '导入账号邮箱']) {
      await paste(label, `${pastedEmail}----${pastedPassword}----${pastedSecret}`)
      assert.equal(await scope.getByLabel('导入账号邮箱', { exact: true }).inputValue(), pastedEmail)
      assert.equal(await scope.getByLabel('导入账号密码', { exact: true }).inputValue(), pastedPassword)
      assert.equal(await scope.getByLabel('导入账号 2FA 密钥', { exact: true }).inputValue(), pastedSecret)
    }
    await paste('粘贴登录资料', `${pastedEmail}----bad----not-base32!`)
    await scope.getByRole('alert').filter({ hasText: '粘贴格式无效' }).waitFor()
    assert.equal(await scope.getByLabel('导入账号密码', { exact: true }).inputValue(), pastedPassword)
    await paste('粘贴登录资料', `${pastedEmail}----${pastedPassword}----${pastedSecret}`)
    await scope.getByRole('checkbox', { name: '测试组', exact: true }).locator('..').click()
    await scope.getByRole('button', { name: '登录并导入 CPR', exact: true }).click()
    await scope.getByText('导入任务已提交，可在下方查看进度', { exact: true }).waitFor()
    assert.equal(await scope.getByLabel('导入账号密码', { exact: true }).inputValue(), '')
    assert.equal(await scope.getByLabel('导入账号 2FA 密钥', { exact: true }).inputValue(), '')
    const imported = await child.evaluate(() => JSON.parse(window.__calls.find(c => c.path === 'api/import').body))
    assert.equal(imported.email, pastedEmail); assert.equal(imported.password, pastedPassword); assert.equal(imported.totpSecret, pastedSecret)
    assert.equal(imported.settings.weight, 5); assert.equal(imported.settings.enabled, true); assert.equal(imported.workspaceId, '')
    assert.deepEqual(imported.settings.groupIds, ['g1']); assert.equal(imported.saveLoginNotes, true); assert.equal(imported.transport, 'prefer_websocket')
    await scope.getByText('详细日志（1）', { exact: true }).click()
    const importLog = scope.getByLabel('任务详细日志', { exact: true })
    await importLog.waitFor(); assert.match(await importLog.innerText(), /授权确认.*HTTP 200/)
    assert.ok(!(await importLog.innerText()).includes(pastedPassword))
    const size = await child.evaluate(() => ({ width: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth }))
    assert.ok(size.scroll <= size.width + 1, JSON.stringify(size)); assert.deepEqual(errors, [])
    await page.screenshot({ path: resolve(root, `.cache/reauth-ui/import-${width}.png`), fullPage: true })
    console.log(`PASS group filters, logout confirmation, config save and import payload/secret clearing at ${width}px`)


    await page.close()
  }
} catch (error) { for (const p of browser.contexts().flatMap(c => c.pages())) { await p.screenshot({ path: resolve(root, '.cache/reauth-ui/failure.png'), fullPage: true }).catch(() => {}); console.log(await p.frames().at(-1).locator('body').innerText().catch(() => 'no page')) } throw error } finally { await browser.close() }
