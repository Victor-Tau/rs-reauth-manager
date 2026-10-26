import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { createScheduler } from './rpc-scheduler.mjs'

const binary = process.argv[2] || fileURLToPath(new URL(`../backend/target/debug/reauth-manager${process.platform === 'win32' ? '.exe' : ''}`, import.meta.url))
const python = process.env.RS_REAUTH_TEST_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3')
const worker = fileURLToPath(new URL('./fake-worker.py', import.meta.url))
const innerAuthorization = 'https://auth.openai.com/oauth/authorize?' + new URLSearchParams({ response_type: 'code', client_id: 'fixture', redirect_uri: 'http://127.0.0.1:1455/auth/callback', state: 'fixture', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })
const nativeAuthorization = 'https://chatgpt.com/codex/desktop-auth?' + new URLSearchParams({ authorize_url: innerAuthorization, codex_streamlined_login: 'true', no_universal_links: '1' })
const make = (id, prefix = id) => ({ id, provider: 'openai', name: `team+${prefix}@example.com+workspace3`, email: `${prefix}@example.com`, authenticationKind: 'oauth', enabled: id !== 'disabled', planType: 'team', status: 'error', notes: `${prefix}@example.com----fixture-password----GEZDGNBVGY3TQOJQ`, outboundProxyEndpoint: 'http://127.0.0.1:21001', accountId: 'original-workspace', groups: [{ id: 'g1', name: 'Team' }], weight: 3, concurrencyLimit: null, modelAccess: { mode: 'all' }, hasRefreshToken: true, accessTokenExpiresAt: '2026-10-23T00:00:00Z', capacity: { usedSlots: 0, totalSlots: null } })
const accounts = [make('good'), make('disabled'), make('slow'), make('failed'), make('missing_proxy'), make('bad_notes'), make('changed'), make('active'), make('uncertain')]
accounts.find(a => a.id === 'missing_proxy').outboundProxyEndpoint = null
accounts.find(a => a.id === 'bad_notes').notes = 'different@example.com----fixture-password----GEZDGNBVGY3TQOJQ'
accounts.find(a => a.id === 'active').capacity.usedSlots = 1
const free = make('free'); free.planType = ' Free '; accounts.push(free)
accounts.push(make('credential_changed'))
const apiKey = make('api_key'); apiKey.authenticationKind = 'api_key'; accounts.push(apiKey)
const otherProvider = make('other_provider'); otherProvider.provider = 'other'; accounts.push(otherProvider)
accounts[0].groups.push({ id: 'g2', name: 'Shared Group', privateField: 'fixture-password' })
free.groups = []
const revisions = new Map(accounts.map(a => [a.id, 1]))
const records = new Map(), handles = new Map(), starts = [], completes = []
const disables = [], saves = [], credentials = new Map()
const proxies = [{ name: 'Fixture Proxy', hasAuthentication: true, id: 'proxy_default', endpoint: 'http://127.0.0.1:21001', enabled: true, revision: 1 }]
const accountProxies = new Map()
const importFlows = new Map(), importTransports = new Map(), importUpdates = []
let importCompleteFailure = false, importUpdateFailure = false
const groups = [{ id: 'g1', name: 'Team' }, { id: 'g2', name: 'Shared Group' }]
let proxyPageSize = 200, memberPageSize = 200, invalidProxyPage = false
function pageOf(items, requested, size) {
  return { items: items.slice((requested - 1) * size, requested * size), page: { page: requested, totalPages: Math.ceil(items.length / size) } }
}
function credential(a) {
  return { account_id: a.id, provider_id: 'openai', credential_revision: revisions.get(a.id), facts: { name: a.name, authentication_kind: 'oauth', material: { schema_version: 1, installation_id: '3d07c9c6-3b57-4a12-a51d-1e21df254477', transport: 'http', principal: { oauth_subject: 'original-subject', poid: null }, access_token: 'old-access', refresh_token: 'old-secret-rt', id_token: 'old-id', oauth_client_id: 'fixture', oauth_scope: 'openid', cookies: [{ name: 'fixture', value: 'fixture-cookie' }] }, email: a.email, upstream_user_id: a.userId, upstream_account_id: a.accountId, plan_type: a.planType, has_refresh_token: true, access_token_expires_at_ms: null, next_refresh_at_ms: null } }
}
let child, buffer, pending, ready, scheduler, sequence = 99, errors = '', failComplete = false
function send(input, payload = Buffer.alloc(0)) {
  if (!Buffer.isBuffer(payload)) payload = Buffer.from(JSON.stringify(payload))
  const meta = structuredClone(input)
  let data, request = Buffer.alloc(0)
  if (meta.type === 'hello') { data = meta.handshake.configuration; delete meta.handshake.configuration }
  else if (meta.type === 'call' || meta.type === 'callback') { data = meta.params; delete meta.params }
  else if (meta.type === 'result') { data = meta.result; delete meta.result }
  if (meta.type === 'call' && meta.context.request) {
    request = Buffer.from(JSON.stringify(meta.context.request))
    delete meta.context.request
    meta.request_context_bytes = request.length
  }
  const encoded = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data))
  if (encoded.length) meta.data_bytes = encoded.length
  const json = Buffer.from(JSON.stringify(meta)), head = Buffer.alloc(12)
  head.writeUInt32BE(json.length); head.writeBigUInt64BE(BigInt(request.length + encoded.length + payload.length), 4)
  child.stdin.write(Buffer.concat([head, json, request, encoded, payload]))
}
const result = (id, value = {}, payload) => send({ type: 'result', id, result: value }, payload)
async function callback(meta, payload) {
  const data = payload.length ? JSON.parse(payload.toString()) : meta.params
  if (meta.method === 'host.auth.get_runtime') { assert.ok(payload.length); assert.deepEqual(meta.params, {}); return result(meta.id, {}, { account_id: data.account_id, provider_id: 'openai', credential_revision: revisions.get(data.account_id) }) }
  if (meta.method === 'host.auth.get') {
    assert.ok(payload.length); assert.deepEqual(meta.params, {}); assert.deepEqual(Object.keys(data), ['account_id'])
    const a = accounts.find(a => a.id === data.account_id)
    if (!credentials.has(a.id)) credentials.set(a.id, credential(a))
    return result(meta.id, {}, credentials.get(a.id))
  }
  if (meta.method === 'host.auth.save') {
    assert.ok(payload.length); assert.deepEqual(meta.params, {}); assert.equal(data.action, 'replace')
    const a = accounts.find(a => a.id === data.account_id), old = credentials.get(a.id)
    assert.equal(a.enabled, false); assert.equal(a.capacity.usedSlots, 0); assert.equal(data.credential_revision, revisions.get(a.id))
    for (const key of ['installation_id', 'transport', 'cookies', 'oauth_client_id', 'oauth_scope']) assert.deepEqual(data.facts.material[key], old.facts.material[key])
    assert.equal(data.facts.email, old.facts.email); assert.equal(data.facts.upstream_user_id, old.facts.upstream_user_id); assert.equal(data.facts.name, old.facts.name)
    assert.equal(data.facts.plan_type, a.id.startsWith('force_') ? 'plus' : 'free'); assert.equal(data.facts.upstream_account_id, a.id.startsWith('force_') ? 'alternate-workspace' : 'personal-workspace'); assert.equal(data.facts.material.refresh_token, 'fallback-private-rt')
    saves.push(a.id)
    if (a.id === 'fb_save_failure') return result(meta.id, {}, {})
    a.accountId = data.facts.upstream_account_id; a.planType = data.facts.plan_type; a.status = 'normal'
    const revision = revisions.get(a.id) + 1; revisions.set(a.id, revision)
    credentials.set(a.id, { ...old, credential_revision: revision, facts: structuredClone(data.facts) })
    if (a.id === 'fb_uncertain') return result(meta.id, {}, {})
    if (a.id === 'fb_postcheck') a.enabled = true
    return result(meta.id, {}, { account_id: a.id, credential_revision: revision })
  }
  if (meta.method === 'host.state.get') return result(meta.id, { record: records.get(data.key) || null })
  if (meta.method === 'host.state.put') {
    const old = records.get(data.key)
    assert.equal(data.expected_version, old?.version ?? null)
    const version = (old?.version || 0) + 1
    const serialized = JSON.stringify(data.value)
    assert.ok(Buffer.byteLength(serialized) <= 262144, 'Private state exceeds the manifest value limit')
    for (const secret of ['fixture-password', 'fixture:pass', 'secret-code', 'refreshToken', 'authorizationUrl', 'callbackUrl', 'fallback-private-rt', 'access_token', 'id_token', 'refresh_token', 'fixture-cookie']) assert.ok(!serialized.includes(secret), `Persistent state leaked ${secret}`)
    records.set(data.key, { value: structuredClone(data.value), version, schema_version: 1 })
    return result(meta.id, { version })
  }
  if (meta.method === 'host.http.dispatch') {
    const url = new URL(meta.params.uri, 'http://mock.invalid')
    let dataReply, status = 200, code = 200
    if (url.pathname === '/api/admin/proxies') {
      assert.equal(meta.params.method, 'GET'); assert.equal(url.searchParams.get('pageSize'), '200')
      dataReply = pageOf(proxies, Number(url.searchParams.get('page')), proxyPageSize)
      if (invalidProxyPage) dataReply.page.totalPages = 101
    }
    else if (url.pathname === '/api/admin/proxies/accounts') {
      assert.equal(meta.params.method, 'GET'); assert.equal(url.searchParams.get('pageSize'), '200')
      const members = accounts.filter(a => (accountProxies.get(a.id) ?? 'proxy_default') === url.searchParams.get('proxyId') && (a.email.includes(url.searchParams.get('search') || '') || a.name.includes(url.searchParams.get('search') || '')))
      dataReply = pageOf(members, Number(url.searchParams.get('page')), memberPageSize)
    }
    else if (url.pathname === '/api/admin/account-groups/options') dataReply = pageOf(groups, Number(url.searchParams.get('page')), 200)
    else if (url.pathname === '/api/admin/accounts') { assert.equal(meta.params.method, 'GET'); dataReply = { items: accounts } }
    else if (url.pathname === '/api/admin/accounts/detail') { assert.equal(meta.params.method, 'GET'); dataReply = { account: accounts.find(a => a.id === url.searchParams.get('accountId')), credentialConfiguration: { transport: importTransports.get(url.searchParams.get('accountId')) || 'http' } } }
    else if (url.pathname === '/api/admin/accounts/export') {
      assert.equal(meta.params.method, 'GET'); assert.equal(url.searchParams.get('confirm'), 'export_sensitive_accounts')
      const id = url.searchParams.get('accountIds'); assert.ok(!id.includes(','))
      dataReply = { documents: [{ provider: 'openai', document: { accounts: [{ id, outboundProxyUrl: 'http://fixture:pass@127.0.0.1:21001', refreshToken: 'old-secret-rt' }] } }] }
    }
    else if (url.pathname === '/api/admin/accounts/oauth/start') {
      assert.equal(meta.params.method, 'POST'); starts.push(structuredClone(data)); status = 201
      if ('accountId' in data) { assert.deepEqual(Object.keys(data).sort(), ['accountId', 'name', 'provider']); dataReply = { flowId: `flow_${data.accountId}`, authorizationUrl: nativeAuthorization } }
      else { assert.deepEqual(Object.keys(data).sort(), ['name', 'outboundProxyId', 'provider']); const flowId = `import_flow_${importFlows.size}`; importFlows.set(flowId, data); dataReply = { flowId, authorizationUrl: nativeAuthorization } }
    }
    else if (url.pathname === '/api/admin/accounts/batch-update') {
      assert.equal(meta.params.method, 'POST'); assert.deepEqual(Object.keys(data).sort(), ['accountIds', 'enabled']); assert.equal(data.accountIds.length, 1); assert.equal(data.enabled, false)
      const a = accounts.find(a => a.id === data.accountIds[0]); assert.equal(a.capacity.usedSlots, 0)
      disables.push(a.id); dataReply = {}
      if (a.id === 'fb_disable_failure') { status = 502; code = 50201 }
      else { a.enabled = false; if (a.id === 'fb_disable_race') revisions.set(a.id, revisions.get(a.id) + 1); if (a.id === 'fb_inflight_race') a.capacity.usedSlots = 1 }
    }
    else if (url.pathname === '/api/admin/accounts/update') {
      importUpdates.push(structuredClone(data)); const a = accounts.find(a => a.id === data.accountId); assert.ok(a)
      if (importUpdateFailure) { status = 502; code = 50201; dataReply = null }
      else { for (const k of ['notes', 'enabled', 'concurrencyLimit', 'weight', 'modelAccess']) a[k] = structuredClone(data[k]); a.groups = groups.filter(g => data.groupIds.includes(g.id)); importTransports.set(a.id, data.connection.transport); dataReply = {} }
    }
    else if (url.pathname === '/api/admin/accounts/oauth/complete' && importFlows.has(data.flowId)) {
      assert.equal(data.provider, 'openai'); assert.equal(data.settings.enabled, false); completes.push(structuredClone(data))
      if (importCompleteFailure) { status = 502; code = 50201; dataReply = null }
      else {
        const flow = importFlows.get(data.flowId), id = `acct_import_${importFlows.size}`, a = make(id)
        a.email = flow.name; a.name = flow.name; a.enabled = false; a.status = 'normal'; a.planType = 'free'
        a.notes = data.settings.notes; a.weight = data.settings.weight; a.concurrencyLimit = data.settings.concurrencyLimit; a.modelAccess = structuredClone(data.settings.modelAccess); a.groups = groups.filter(g => data.settings.groupIds.includes(g.id))
        a.outboundProxyEndpoint = flow.outboundProxyId ? 'http://127.0.0.1:21001' : null
        accounts.push(a); revisions.set(id, 1); accountProxies.set(id, flow.outboundProxyId); dataReply = { accountId: id }; status = 201
      }
    }
    else if (url.pathname === '/api/admin/accounts/oauth/complete') {
      assert.equal(meta.params.method, 'POST'); assert.deepEqual(Object.keys(data).sort(), ['callbackUrl', 'flowId', 'provider']); completes.push(structuredClone(data)); const a = accounts.find(a => `flow_${a.id}` === data.flowId)
      assert.ok(a); a.status = 'normal'; a.accessTokenExpiresAt = '2026-10-24T00:00:00Z'; dataReply = { accountId: a.id }; status = 201
      if (failComplete) { status = 502; code = 50201; dataReply = null }
    } else throw new Error(`Unexpected route ${url.pathname}`)
    const handle = randomUUID(); handles.set(handle, Buffer.from(JSON.stringify({ code, message: code === 200 ? 'ok' : 'secret-code fixture-password', data: dataReply })))
    return result(meta.id, { status, version: 'HTTP/1.1', headers: [], body: { kind: 'handle', handle }, response: null, session: false })
  }
  if (meta.method === 'host.http.body_read') { const value = handles.get(meta.params.handle); if (value) { handles.delete(meta.params.handle); return result(meta.id, { eof: false, trailers: null }, value) } return result(meta.id, { eof: true, trailers: null }) }
  if (meta.method === 'host.http.body_close') return result(meta.id)
  throw new Error(`Unexpected callback ${meta.method}`)
}
function parse() {
  while (buffer.length >= 12) {
    const m = buffer.readUInt32BE(), p = Number(buffer.readBigUInt64BE(4)), total = 12 + m + p
    if (buffer.length < total) break
    const meta = JSON.parse(buffer.subarray(12, 12 + m).toString())
    const contextBytes = meta.request_context_bytes ?? 0, dataBytes = meta.data_bytes ?? 0
    assert.ok(contextBytes + dataBytes <= p)
    assert.ok(!('params' in meta) && !('result' in meta), 'RPC v7 business JSON must be outside control metadata')
    const dataStart = 12 + m + contextBytes
    if (meta.type === 'callback' || meta.type === 'result') {
      assert.ok(dataBytes > 0, 'RPC v7 callbacks/results require a business JSON segment')
      meta[meta.type === 'result' ? 'result' : 'params'] = JSON.parse(buffer.subarray(dataStart, dataStart + dataBytes).toString())
    }
    const payload = buffer.subarray(dataStart + dataBytes, total); buffer = buffer.subarray(total)
    if (scheduler.handle(meta)) continue
    if (meta.type === 'ready') { assert.equal(meta.protocol_version, 7); assert.deepEqual(meta.call_budgets, {}); ready.resolve() }
    else if (meta.type === 'callback') callback(meta, payload).catch(e => { ready.reject(e); for (const w of pending.values()) w.reject(e) })
    else { const w = pending.get(meta.id); if (w) { pending.delete(meta.id); if (meta.type === 'result') w.resolve({ result: meta.result, payload }); else w.reject(new Error(JSON.stringify(meta.error))) } }
  }
}
async function start() {
  scheduler = createScheduler(send)
  ready = Promise.withResolvers(); pending = new Map(); buffer = Buffer.alloc(0); errors = ''
  child = spawn(binary, [], { env: { ...process.env, RS_REAUTH_TEST_PYTHON: python, RS_REAUTH_TEST_WORKER: worker }, stdio: ['pipe', 'pipe', 'pipe'] })
  child.stdout.on('data', data => { buffer = Buffer.concat([buffer, data]); parse() }); child.stderr.on('data', data => errors += data)
  child.on('error', e => ready.reject(e))
  child.on('exit', code => { if (code) { const e = new Error(`Plugin exit ${code}: ${errors}`); ready.reject(e); for (const w of pending.values()) w.reject(e) } })
  send({ type: 'hello', handshake: { protocol_version: 7, artifact_sha256: 'a'.repeat(64), plugin_id: 'personal.reauth-manager', instance_id: 'test_instance', generation: 1, incarnation: 'fixture', configuration: {}, contributes: { management: { id: 'personal.reauth-manager.management', version: 2, stages: ['management'] }, maintenance: { id: 'personal.reauth-manager.maintenance', version: 1, stages: ['maintenance'] } } } })
  await ready.promise
}
async function stop() { const exited = new Promise(resolve => child.once('exit', resolve)); send({ type: 'shutdown' }); child.stdin.end(); await exited; scheduler.verify(false) }
async function call(method, params = {}, payload = Buffer.alloc(0), stage = 'management', entry) {
  const id = sequence += 2, w = Promise.withResolvers(); pending.set(id, w)
  const request = entry ?? (stage === 'management' ? { method: params.method, uri: `/plugin/${params.path}`, http_version: 'HTTP/1.1', headers: [{ name: 'authorization', value: Buffer.from('fixture-private-context').toString('base64') }], peer_addr: '127.0.0.1:12345', client_ip: '127.0.0.1' } : undefined)
  send({ type: 'call', id, method, params, context: { call_id: id, instance_id: 'test_instance', generation: 1, incarnation: 'fixture', stage, timeout_ms: stage === 'registration' ? 5000 : 120000, resource_stream: false, resource_scope_id: `scope_${id}`, ...(request ? { request } : {}) } }, payload)
  return Promise.race([w.promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`Timeout ${method}`)), 10000).unref())])
}
async function request(path, data) { const r = await call('management.handle', { method: data === undefined ? 'GET' : 'POST', path: `api/${path}`, query: '', content_type: data === undefined ? null : 'application/json', headers: [] }, data === undefined ? Buffer.alloc(0) : data); return { status: r.result.status, value: JSON.parse(r.payload.toString()) } }
const submit = (ids, requestId = randomUUID()) => request('submit', { accountIds: ids, requestId })
const tick = () => request('tick', {})
const job = id => records.get('queue').value.jobs.filter(j => j.accountId === id).at(-1)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
async function finish(id) { for (let i = 0; i < 60; i++) { await tick(); if (!['queued', 'running'].includes(job(id).status)) return job(id); await sleep(60) } throw new Error('Job did not finish: ' + JSON.stringify(job(id))) }
let passed = 0
const check = name => { passed++; console.log(`PASS ${name}`) }
try {
  await start()
  check('RPC v7 handshake uses SDK default stage budgets')
  const reg = JSON.parse((await call('management.register', {}, Buffer.alloc(0), 'registration')).payload.toString()); assert.equal(reg.resources.length, 3); assert.equal(reg.routes.length, 12); assert.ok(reg.routes.some(r => r.method === 'POST' && r.path === 'api/logout')); assert.ok(!reg.resources.some(r => r.path.includes('runtime'))); check('Only UI resources are exposed, protocol runtime stays private')
  const largeContext = { method: 'GET', uri: '/plugin/api/jobs', http_version: 'HTTP/1.1', headers: [{ name: 'x-fixture', value: Buffer.alloc(70000, 'x').toString('base64') }], peer_addr: null, client_ip: null }
  const contextual = await call('management.handle', { method: 'GET', path: 'api/jobs', query: '', content_type: null, headers: [] }, Buffer.alloc(0), 'management', largeContext)
  assert.equal(contextual.result.status, 200); assert.ok(!contextual.payload.includes('fixture-private-context')); check('RPC v7 carries large request context separately from metadata and business JSON')
  scheduler.verify(); check('RPC v7 waits for execution grants and releases consumed callback results')
  await call('plugin.reconcile', {}, Buffer.alloc(0), 'maintenance'); check('Maintenance v1 runs without an entry request context with the RPC v7 120-second budget')
  const beforeProbe = records.get('queue')?.value.jobs.length ?? 0; assert.deepEqual((await request('runtime-check', {})).value, { ready: true }); assert.equal(starts.length, 0); assert.equal(completes.length, 0); assert.equal(records.get('queue')?.value.jobs.length ?? 0, beforeProbe); check('Runtime preflight never queues an account or starts native authorization')
  const listing = await request('accounts'); assert.equal(listing.status, 200); assert.equal(listing.value.accounts.length, 11); assert.ok(listing.value.accounts.some(a => a.id === 'free')); assert.ok(!listing.value.accounts.some(a => ['api_key', 'other_provider'].includes(a.id))); for (const a of listing.value.accounts) { assert.ok(!('notes' in a)); assert.ok(!('refreshToken' in a)); assert.ok(!JSON.stringify(a).includes('fixture-password')) } check('All OpenAI OAuth plans including Free are listed without leaking credentials')
  assert.equal(listing.value.accounts.find(a => a.id === 'bad_notes').notesValid, false); check('Notes must match original account email')
  assert.deepEqual(listing.value.accounts.find(a => a.id === 'good').groups, [{ id: 'g1', name: 'Team' }, { id: 'g2', name: 'Shared Group' }]); assert.deepEqual(listing.value.accounts.find(a => a.id === 'free').groups, []); check('RS group names and multiple memberships are returned without leaking unrelated fields')
  assert.equal((await submit(['good', 'good'])).status, 400); assert.equal((await submit(['../escape'])).status, 400); assert.equal((await submit([])).status, 400); check('Reject duplicate, malformed and empty selections')
  const requestId = randomUUID(); await submit(['good'], requestId); await submit(['good'], requestId); assert.equal(records.get('queue').value.jobs.length, 1); assert.equal(starts.length, 0); check('Submission is idempotent and GET/submission never starts a login')
  assert.equal((await submit(['good'])).status, 400); check('Concurrent submissions cannot duplicate an account')
  const before = structuredClone(accounts.find(a => a.id === 'good')); await tick(); assert.equal(starts.length, 1); assert.equal(completes.length, 0); const done = await finish('good'); assert.equal(done.status, 'success'); const after = accounts.find(a => a.id === 'good'); for (const k of ['enabled', 'groups', 'notes', 'weight', 'concurrencyLimit', 'outboundProxyEndpoint', 'name', 'accountId']) assert.deepEqual(after[k], before[k]); check('Real SDK process completes native OAuth start/complete and verifies unchanged configuration')
  await submit(['disabled']); assert.equal((await finish('disabled')).status, 'success'); assert.equal(accounts.find(a => a.id === 'disabled').enabled, false); check('Disabled account remains disabled after reauthorization')
  const freeBefore = structuredClone(free); const freeStarts = starts.length, freeCompletes = completes.length; await submit(['free']); assert.equal((await finish('free')).status, 'success'); assert.equal(starts.length, freeStarts + 1); assert.equal(completes.length, freeCompletes + 1); for (const k of ['id', 'enabled', 'groups', 'notes', 'outboundProxyEndpoint', 'name', 'accountId', 'planType']) assert.deepEqual(free[k], freeBefore[k]); check('Free account completes original-account authorization while preserving proxy and configuration')
  for (const id of ['missing_proxy', 'bad_notes', 'active', 'api_key', 'other_provider']) { const old = starts.length; await submit([id]); assert.equal((await finish(id)).status, 'failed'); assert.equal(starts.length, old) } check('Missing proxy, invalid notes, active requests and unsupported credentials stop before login')
  const proxyAccount = id => { const a = make(id); accounts.push(a); revisions.set(id, 1); return a }
  const offProxy = { ...proxies[0], id: 'proxy_disabled', enabled: false }; proxies.unshift(offProxy)
  const exact = proxyAccount('proxy_exact_binding'); await submit([exact.id]); assert.equal((await finish(exact.id)).status, 'success'); check('Same endpoint with different proxy credentials is resolved by exact account membership')
  const off = proxyAccount('proxy_disabled_account'); accountProxies.set(off.id, offProxy.id)
  const beforeDisabled = starts.length; await submit([off.id]); assert.equal((await finish(off.id)).status, 'failed'); assert.match(job(off.id).message, /代理已禁用/); assert.equal(starts.length, beforeDisabled); check('Disabled managed proxy blocks login even while the account still exposes its endpoint')
  const unknown = proxyAccount('proxy_unknown_binding'); accountProxies.set(unknown.id, 'unknown_proxy')
  const beforeUnknown = starts.length; await submit([unknown.id]); assert.equal((await finish(unknown.id)).status, 'failed'); assert.equal(starts.length, beforeUnknown); check('Unknown proxy binding stops before native authorization')
  const changedProxy = proxyAccount('proxy_revision_change'); await submit([changedProxy.id]); await tick(); proxies.find(p => p.id === 'proxy_default').revision++
  const beforeProxyChange = completes.length; assert.equal((await finish(changedProxy.id)).status, 'review'); assert.equal(completes.length, beforeProxyChange); check('Proxy revision changes during login block stale credential writeback')
  const disabledDuringLogin = proxyAccount('proxy_disabled_during_login'); await submit([disabledDuringLogin.id]); await tick(); proxies.find(p => p.id === 'proxy_default').enabled = false
  const beforeProxyDisable = completes.length; assert.equal((await finish(disabledDuringLogin.id)).status, 'review'); assert.equal(completes.length, beforeProxyDisable); proxies.find(p => p.id === 'proxy_default').enabled = true; check('Proxy disabled during login blocks native completion without a direct fallback')
  const paged = proxyAccount('proxy_paged', 'shared-proxy'); paged.email = accounts[0].email; paged.notes = accounts[0].notes
  proxyPageSize = 1; memberPageSize = 1; await submit([paged.id]); assert.equal((await finish(paged.id)).status, 'success'); proxyPageSize = 200; memberPageSize = 200; check('Proxy catalog and exact account membership both traverse pagination')
  const invalidPage = proxyAccount('proxy_invalid_page'); invalidProxyPage = true; const beforeInvalidPage = starts.length; await submit([invalidPage.id]); assert.equal((await finish(invalidPage.id)).status, 'failed'); assert.equal(starts.length, beforeInvalidPage); invalidProxyPage = false; check('Unbounded or malformed proxy pagination fails before login')
  await submit(['failed']); assert.equal((await finish('failed')).status, 'failed'); assert.match(job('failed').message, /密码/); check('Password rejection returns a safe actionable error')
  await submit(['changed']); await tick(); accounts.find(a => a.id === 'changed').enabled = false; const count = completes.length; assert.equal((await finish('changed')).status, 'review'); assert.equal(completes.length, count); check('Configuration changes during login block credential writeback')
  await submit(['credential_changed']); await tick(); revisions.set('credential_changed', 2); const previous = completes.length; assert.equal((await finish('credential_changed')).status, 'review'); assert.equal(completes.length, previous); check('Concurrent credential rotation blocks stale OAuth writeback')
  await submit(['slow', 'good']); await tick(); const startsBefore = starts.length; const c = completes.length; await request('cancel', { requestId: null }); await tick(); assert.equal(job('slow').status, 'cancelled'); assert.equal(job('good').status, 'cancelled'); assert.equal(starts.length, startsBefore); assert.equal(completes.length, c); check('Cancel kills current helper and stops all later accounts without writeback')
  failComplete = true; await submit(['uncertain']); assert.equal((await finish('uncertain')).status, 'review'); const committed = completes.length; await tick(); await tick(); assert.equal(completes.length, committed); failComplete = false; check('Uncertain native commit is never automatically replayed')
  await submit(['slow', 'good']); await tick(); await stop(); await start(); await request('jobs'); assert.equal(job('slow').status, 'interrupted'); assert.equal(job('good').status, 'interrupted'); const prior = starts.length; await tick(); assert.equal(starts.length, prior); check('Restart interrupts all queued/running tasks without automatic credential submission')
  function fallbackAccount(id) { const a = make(id); a.userId = 'original-user'; accounts.push(a); revisions.set(id, 1); return a }
  for (const id of ['fb_good', 'fb_disabled', 'fb_already_free']) {
    const a = fallbackAccount(id)
    if (id === 'fb_disabled') a.enabled = false
    if (id === 'fb_already_free') a.planType = 'free'
    const before = structuredClone(a), oldCompletes = completes.length, d = disables.length
    await submit([id]); const done = await finish(id)
    assert.equal(done.status, 'success'); assert.equal(done.step, 'free'); assert.match(done.message, /原工作区已失效.*已切回 Free.*已停止调度/)
    assert.equal(a.enabled, false); assert.equal(a.planType, 'free'); assert.equal(a.accountId, 'personal-workspace'); assert.equal(a.status, 'normal')
    for (const k of ['id', 'email', 'userId', 'name', 'groups', 'notes', 'outboundProxyEndpoint', 'weight', 'concurrencyLimit', 'modelAccess']) assert.deepEqual(a[k], before[k])
    assert.equal(completes.length, oldCompletes); assert.equal(disables.length, d + (before.enabled ? 1 : 0)); assert.equal(saves.at(-1), id)
    check(`${id}: verified Free recovery replaces original ID via SDK CAS, preserves settings, and stops scheduling`)
  }
  for (const id of ['fb_user', 'fb_workspace', 'fb_plan', 'fb_email', 'fb_expired', 'fb_proof', 'fb_rt', 'fb_old_workspace', 'fb_missing_user']) {
    const a = fallbackAccount(id); if (id === 'fb_missing_user') a.userId = null
    const old = structuredClone(a), d = disables.length, s = saves.length
    await submit([id]); assert.equal((await finish(id)).status, 'review'); assert.equal(disables.length, d); assert.equal(saves.length, s); assert.deepEqual(a, old)
  }
  check('Wrong user/email/workspace/plan, stale token, missing proof/RT/original identity never disable or write')
  for (const id of ['fb_changed', 'fb_revision', 'fb_active']) {
    const a = fallbackAccount(id), d = disables.length, s = saves.length
    await submit([id]); await tick()
    if (id === 'fb_changed') a.weight = 4
    if (id === 'fb_revision') revisions.set(id, 2)
    if (id === 'fb_active') a.capacity.usedSlots = 1
    assert.equal((await finish(id)).status, 'review'); assert.equal(disables.length, d); assert.equal(saves.length, s)
  }
  check('Concurrent settings/credential changes and in-flight work stop before Free recovery mutations')
  for (const id of ['fb_disable_failure', 'fb_disable_race', 'fb_inflight_race', 'fb_save_failure', 'fb_uncertain', 'fb_postcheck']) {
    const a = fallbackAccount(id), s = saves.length
    await submit([id]); assert.equal((await finish(id)).status, 'review')
    if (!['fb_disable_failure', 'fb_postcheck'].includes(id)) assert.equal(a.enabled, false)
    if (['fb_disable_failure', 'fb_disable_race', 'fb_inflight_race'].includes(id)) assert.equal(saves.length, s)
    const count = saves.length, d = disables.length; await tick(); await tick(); assert.equal(saves.length, count); assert.equal(disables.length, d)
    check(`${id}: partial or uncertain mutation requires review and is never replayed`)
  }
  for (const id of ['force_good', 'force_wrong_user', 'force_wrong_workspace', 'force_changed', 'force_disabled', 'force_no_confirmation']) {
    const a = fallbackAccount(id); if (id === 'force_disabled') a.enabled = false
    const original = structuredClone(a), saved = saves.length, disabled = disables.length
    await submit([id]); assert.equal((await finish(id)).step, 'workspace')
    assert.equal(saves.length, saved); assert.equal(disables.length, disabled)
    const source = structuredClone(job(id))
    assert.deepEqual(source.workspaceChoices, [{ id: 'alternate-workspace' }, { id: 'second-workspace' }])
    const payload = { sourceRequestId: source.requestId, workspaceId: 'alternate-workspace', requestId: randomUUID(), confirmation: 'replace_workspace_and_disable' }
    assert.equal((await request('force-submit', { ...payload, confirmation: '' })).status, 400)
    assert.equal((await request('force-submit', { ...payload, workspaceId: 'unknown-workspace' })).status, 400)
    assert.equal((await request('force-submit', payload)).status, 200)
    assert.equal((await request('force-submit', payload)).status, 200)
    assert.equal((await request('force-submit', { ...payload, requestId: randomUUID() })).status, 400)
    await tick()
    if (id === 'force_changed') a.weight = 5
    const done = await finish(id)
    if (['force_good', 'force_disabled'].includes(id)) {
      assert.equal(done.status, 'success'); assert.match(done.message, /管理员已确认.*已停止调度/)
      assert.equal(a.accountId, 'alternate-workspace'); assert.equal(a.planType, 'plus'); assert.equal(a.enabled, false)
      for (const key of ['id', 'email', 'userId', 'name', 'groups', 'notes', 'outboundProxyEndpoint', 'weight', 'concurrencyLimit', 'modelAccess']) assert.deepEqual(a[key], original[key])
      const count = saves.length; await tick(); assert.equal(saves.length, count)
    } else { assert.equal(done.status, 'review'); assert.equal(saves.length, saved); assert.equal(disables.length, disabled) }
    check(`${id}: explicit workspace selection and confirmation, identity/CAS guards and scheduling policy`)
  }
  {
    const id = 'free_fallback_no_candidates'; const a = fallbackAccount(id); const saved = saves.length; const disabled = disables.length
    await submit([id]); assert.equal((await finish(id)).status, 'failed'); assert.equal(job(id).step, 'workspace'); assert.deepEqual(job(id).workspaceChoices, [])
    const sourceRequestId = job(id).requestId
    assert.equal((await request('free-fallback', { sourceRequestId, requestId: randomUUID(), confirmation: '' })).status, 400)
    const fallbackRequestId = randomUUID(); const freeResult = await request('free-fallback', { sourceRequestId, requestId: fallbackRequestId, confirmation: 'fallback_free_and_disable' }); if (freeResult.status !== 200) console.log(JSON.stringify(freeResult)); assert.equal(freeResult.status, 200)
    assert.equal((await request('free-fallback', { sourceRequestId, requestId: fallbackRequestId, confirmation: 'fallback_free_and_disable' })).status, 200)
    await tick(); const done = await finish(id); assert.equal(done.status, 'success'); assert.equal(done.step, 'free'); assert.match(done.message, /退回同一用户的 Free/)
    assert.equal(a.planType, 'free'); assert.equal(a.enabled, false); assert.equal(saves.at(-1), id); assert.equal(disables.length, disabled + 1); assert.ok(saves.length > saved)
    check('No-candidate failure requires explicit Free fallback confirmation and writes the verified Free token')
  }
  for (const [id, expected] of [['diagnostic_issue', /创建 2FA 验证挑战.*HTTP 403/], ['diagnostic_limit', /限制登录频率.*HTTP 429/], ['diagnostic_transport', /密码验证.*请求超时/], ['diagnostic_unsafe', /未取得可公开的具体错误/]]) {
    const a = make(id); accounts.push(a); revisions.set(id, 1)
    const before = structuredClone(a), saved = saves.length, completed = completes.length
    await submit([id]); const done = await finish(id)
    assert.equal(done.status, 'failed'); assert.match(done.message, expected)
    assert.ok(done.logs.length > 1 && done.logs.length <= 100)
    assert.ok(done.logs.some(entry => entry.message.includes('HTTP 200') && entry.message.includes('授权确认')))
    assert.ok(done.logs.every(entry => Number.isSafeInteger(entry.at) && typeof entry.message === 'string'))
    for (const secret of ['fixture-password', 'fallback-private-rt', 'private-host']) assert.ok(!done.message.includes(secret))
    for (const secret of ['fixture-password', 'fallback-private-rt', 'private-host']) assert.ok(!JSON.stringify(done.logs).includes(secret))
    assert.equal(saves.length, saved); assert.equal(completes.length, completed); assert.deepEqual(a, before)
    check(`${id}: specific diagnostics survive SDK transport without credential leakage or account changes`)
  }
  await submit(['slow', 'good']); await tick()
  assert.equal(job('slow').status, 'running'); assert.equal(job('good').status, 'queued')
  const startedBeforeClose = starts.length, completedBeforeClose = completes.length
  assert.equal((await request('config', { enabled: 'false' })).status, 400)
  assert.equal((await request('config', { enabled: false, extra: true })).status, 400)
  assert.equal((await request('config', { enabled: false })).value.enabled, false)
  assert.equal(job('slow').status, 'cancelled'); assert.equal(job('good').status, 'cancelled')
  assert.equal((await request('jobs')).value.enabled, false)
  for (const [route, body] of [['submit', { accountIds: ['good'], requestId: randomUUID() }], ['force-submit', {}], ['free-fallback', {}]]) {
    const response = await request(route, body); assert.equal(response.status, 400); assert.match(response.value.error.message, /插件已关闭/)
  }
  await tick(); await call('plugin.reconcile', {}, Buffer.alloc(0), 'maintenance')
  assert.equal(starts.length, startedBeforeClose); assert.equal(completes.length, completedBeforeClose)
  check('Closing cancels running and queued jobs, blocks all submission modes and maintenance writeback')
  await stop(); await start(); assert.equal((await request('jobs')).value.enabled, false)
  await tick(); assert.equal(starts.length, startedBeforeClose)
  assert.equal((await request('config', { enabled: true })).value.enabled, true)
  await tick(); assert.equal(starts.length, startedBeforeClose)
  await submit(['good']); assert.equal((await finish('good')).status, 'success')
  check('Switch survives plugin restart and reopening only allows explicitly submitted new jobs')

  const importPayload = (label, overrides = {}) => ({ requestId: randomUUID(), email: `${label}@example.com`, name: `${label}@example.com`, password: 'fixture-password', totpSecret: 'GEZDGNBVGY3TQOJQ', workspaceId: '', transport: 'prefer_websocket', outboundProxyId: 'proxy_default', loginProxyUrl: '', saveLoginNotes: false, settings: { notes: 'Imported account', enabled: true, concurrencyLimit: 12, weight: 42, modelAccess: { mode: 'allowlist', models: ['gpt-5', 'gpt-5-mini'] }, groupIds: ['g1', 'g2'] }, ...overrides })
  async function finishImport(requestId) {
    for (let i = 0; i < 100; i++) { await tick(); const j = records.get('queue').value.jobs.find(j => j.requestId === `${requestId}:import`); if (!['queued', 'running'].includes(j.status)) return j; await new Promise(r => setTimeout(r, 20)) }
    throw new Error('Import did not finish')
  }
  const optionReply = await request('options'); assert.equal(optionReply.status, 200); assert.deepEqual(optionReply.value.groups, groups); assert.ok(!JSON.stringify(optionReply.value).includes('fixture:pass'))
  const payload = importPayload('import-success'), startsBeforeImport = starts.length
  assert.equal((await request('import', payload)).status, 200)
  assert.equal((await request('import', payload)).status, 200); assert.equal(starts.length, startsBeforeImport + 1)
  assert.equal((await request('import', importPayload('import-concurrent'))).status, 400)
  const imported = await finishImport(payload.requestId); assert.equal(imported.status, 'success')
  const created = accounts.find(a => a.id === imported.accountId)
  assert.equal(created.email, payload.email); assert.equal(created.enabled, true); assert.equal(importTransports.get(created.id), 'prefer_websocket')
  for (const k of ['notes', 'weight', 'concurrencyLimit', 'modelAccess']) assert.deepEqual(created[k], payload.settings[k])
  assert.deepEqual(created.groups, groups); assert.equal(importUpdates.at(-2).enabled, false); assert.equal(importUpdates.at(-1).enabled, true)
  assert.equal((await request('import', importPayload('import-success'))).status, 400)
  check('Import uses native OAuth, reuses authenticated proxy, verifies all official settings and deduplicates request/email')
  const direct = importPayload('import-direct', { outboundProxyId: '', settings: { ...payload.settings, enabled: false, notes: '', modelAccess: { mode: 'all', models: [] } } })
  assert.equal((await request('import', direct)).status, 200); const directDone = await finishImport(direct.requestId); assert.equal(directDone.status, 'success'); assert.equal(accounts.find(a => a.id === directDone.accountId).enabled, false)
  check('Direct import and disabled scheduling preserve empty notes and unrestricted models')
  for (const invalid of [{ settings: { ...payload.settings, weight: 101 } }, { settings: { ...payload.settings, concurrencyLimit: 0 } }, { settings: { ...payload.settings, modelAccess: { mode: 'allowlist', models: [] } } }, { outboundProxyId: 'unknown' }, { loginProxyUrl: 'http://wrong.example:21001' }]) {
    const old = starts.length; assert.equal((await request('import', importPayload('import-invalid', invalid))).status, 400); assert.equal(starts.length, old)
  }
  check('Invalid scheduling, models, missing proxy and mismatched login proxy stop before OAuth')
  importUpdateFailure = true
  const partial = importPayload('import-partial'); assert.equal((await request('import', partial)).status, 200)
  const partialDone = await finishImport(partial.requestId); assert.equal(partialDone.status, 'review'); assert.ok(partialDone.accountId); assert.equal(accounts.find(a => a.id === partialDone.accountId).enabled, false)
  const previousImportCompletes = completes.length; await tick(); await tick(); assert.equal(completes.length, previousImportCompletes); importUpdateFailure = false
  check('Partial import retains created account ID, leaves scheduling disabled and never replays completion')
  importCompleteFailure = true
  const uncertainImport = importPayload('import-uncertain'); assert.equal((await request('import', uncertainImport)).status, 200)
  assert.equal((await finishImport(uncertainImport.requestId)).status, 'review'); const cImport = completes.length; await tick(); assert.equal(completes.length, cImport); importCompleteFailure = false
  check('Uncertain OAuth creation remains review without automatic retries')
  const changedImport = importPayload('import-proxy-change'); assert.equal((await request('import', changedImport)).status, 200)
  const proxyForImport = proxies.find(p => p.id === 'proxy_default'); proxyForImport.revision++
  const beforeChangedImport = completes.length; assert.equal((await finishImport(changedImport.requestId)).status, 'review'); assert.equal(completes.length, beforeChangedImport)
  check('Changing selected proxy during import stops before account creation')
  const autoConfig = { enabled: true, intervalMinutes: 1, cooldownHours: 24, allGroups: false, groupIds: ['g2'], includeUngrouped: false, statuses: ['error'], allPlans: false, plans: ['free'], enabledOnly: true }
  const autoAccount = make('automatic-selected'); autoAccount.groups = [groups[1]]; autoAccount.planType = ' Free '; accounts.push(autoAccount); revisions.set(autoAccount.id, 1)
  const skipped = make('automatic-wrong-plan'); skipped.groups = [groups[1]]; accounts.push(skipped); revisions.set(skipped.id, 1)
  assert.equal((await request('config', { enabled: true, automation: { ...autoConfig, statuses: [] } })).status, 400)
  assert.equal((await request('config', { enabled: true, automation: autoConfig })).status, 200)
  const startAuto = starts.length; await call('plugin.reconcile', {}, Buffer.alloc(0), 'maintenance')
  assert.equal(starts.length, startAuto + 1); assert.equal(starts.at(-1).accountId, autoAccount.id)
  assert.equal(job(autoAccount.id).automatic, true); assert.equal((await finish(autoAccount.id)).status, 'success')
  // Reset only the scan clock and status to exercise cooldown without wall-clock sleeps.
  autoAccount.status = 'error'; records.get('queue').value.last_scan_at = 0
  await tick(); assert.equal(starts.length, startAuto + 1)
  await stop(); await start(); assert.equal((await request('jobs')).value.automation.enabled, true)
  records.get('queue').value.last_scan_at = 0; await tick(); assert.equal(starts.length, startAuto + 1)
  delete records.get('queue').value.auto_attempts[autoAccount.id]; records.get('queue').value.last_scan_at = 0
  failComplete = true; await tick(); assert.equal((await finish(autoAccount.id)).status, 'review'); failComplete = false
  const blockedStarts = starts.length; records.get('queue').value.last_scan_at = 0; await tick(); assert.equal(starts.length, blockedStarts)
  check('Uncertain automatic completion blocks future scans even when the scan clock advances')
  await submit([autoAccount.id]); assert.equal((await finish(autoAccount.id)).status, 'success')
  autoAccount.status = 'error'; delete records.get('queue').value.auto_attempts[autoAccount.id]; records.get('queue').value.last_scan_at = 0
  const afterManual = starts.length; await tick(); assert.equal(starts.length, afterManual + 1); assert.equal((await finish(autoAccount.id)).status, 'success')
  check('Successful manual verification clears the automatic block despite an older review record')
  assert.equal((await request('config', { enabled: true, automation: { ...autoConfig, enabled: false } })).status, 200)
  check('Maintenance scans intersect group/status/plan, persist configuration/cooldown and avoid duplicate authorization after restart')

  const logoutStartCount = starts.length, logoutCompleteCount = completes.length, logoutSaveCount = saves.length
  for (const id of ['logout_good', 'logout_rejected', 'logout_uncertain', 'logout_changed', 'logout_slow', 'logout_next', 'logout_no_token', 'logout_busy']) {
    const a = make(id); a.notes = ''; accounts.push(a); revisions.set(id, 1)
  }
  const logoutRequest = (ids, requestId = randomUUID(), confirmation = 'logout_all_and_disable') => request('logout', { accountIds: ids, requestId, confirmation })
  assert.equal((await logoutRequest(['logout_good'], randomUUID(), '')).status, 400)
  assert.equal((await logoutRequest(['logout_good', 'logout_good'])).status, 400)
  await request('config', { enabled: false }); assert.equal((await logoutRequest(['logout_good'])).status, 400); await request('config', { enabled: true })
  check('Logout requires explicit confirmation, valid selections and an enabled plugin')
  const logoutBefore = structuredClone(accounts.find(a => a.id === 'logout_good'))
  const logoutKey = randomUUID()
  assert.equal((await logoutRequest(['logout_good'], logoutKey)).status, 200)
  assert.equal((await logoutRequest(['logout_good'], logoutKey)).status, 200)
  assert.equal(records.get('queue').value.jobs.filter(j => j.requestId === `${logoutKey}:logout_good`).length, 1)
  assert.equal((await submit(['logout_good'], logoutKey)).status, 400)
  assert.equal((await submit(['logout_good'])).status, 400)
  assert.equal((await finish('logout_good')).step, 'logged_out')
  const loggedOut = accounts.find(a => a.id === 'logout_good'); assert.equal(loggedOut.enabled, false)
  for (const key of ['notes', 'groups', 'weight', 'concurrencyLimit', 'name', 'accountId', 'outboundProxyEndpoint']) assert.deepEqual(loggedOut[key], logoutBefore[key])
  assert.equal(starts.length, logoutStartCount); assert.equal(completes.length, logoutCompleteCount); assert.equal(saves.length, logoutSaveCount)
  assert.equal(records.get('queue').value.auto_attempts.logout_good, 9007199254740991)
  check('Logout uses stored credentials without notes or OAuth login, disables scheduling, preserves settings and deduplicates requests across action types')
  for (const [id, expected] of [['logout_rejected', 'failed'], ['logout_uncertain', 'review']]) {
    await logoutRequest([id]); const done = await finish(id); assert.equal(done.status, expected); assert.equal(accounts.find(a => a.id === id).enabled, false)
    assert.ok(!JSON.stringify(done).includes('old-access')); assert.ok(!JSON.stringify(done).includes('fixture-cookie'))
  }
  check('Rejected and uncertain logout responses keep scheduling disabled and never persist upstream secrets')
  await logoutRequest(['logout_changed']); await tick(); accounts.find(a => a.id === 'logout_changed').enabled = true
  assert.equal((await finish('logout_changed')).status, 'review')
  check('Concurrent account changes after logout are reported for review without overwriting the new settings')
  const noToken = accounts.find(a => a.id === 'logout_no_token'), busyLogout = accounts.find(a => a.id === 'logout_busy')
  const withoutToken = credential(noToken); delete withoutToken.facts.material.access_token; credentials.set(noToken.id, withoutToken)
  busyLogout.capacity.usedSlots = 1
  const disabledBeforeGuard = disables.length
  for (const a of [noToken, busyLogout]) { await logoutRequest([a.id]); assert.equal((await finish(a.id)).status, 'review'); assert.equal(a.enabled, true) }
  assert.equal(disables.length, disabledBeforeGuard)
  check('Missing access token and active account stop before scheduling changes and logout')
  await logoutRequest(['logout_slow', 'logout_next']); await tick()
  assert.equal(job('logout_slow').status, 'running')
  const nextBefore = accounts.find(a => a.id === 'logout_next').enabled
  await request('cancel', { requestId: null }); await tick()
  assert.equal(job('logout_slow').status, 'cancelled'); assert.equal(job('logout_next').status, 'cancelled'); assert.equal(accounts.find(a => a.id === 'logout_next').enabled, nextBefore)
  check('Stopping logout kills the running worker and prevents subsequent queued accounts from being changed')
  loggedOut.groups = [{ id: 'logout-only', name: 'Logout only' }]
  const logoutAutoConfig = { ...autoConfig, allGroups: false, groupIds: ['logout-only'], includeUngrouped: false, allPlans: true, plans: [], enabledOnly: false }
  await request('config', { enabled: true, automation: logoutAutoConfig })
  const beforeLogoutAuto = starts.length; records.get('queue').value.last_scan_at = 0; await tick()
  assert.equal(job('logout_good').kind, 'logout'); assert.equal(starts.length, beforeLogoutAuto)
  await request('config', { enabled: true, automation: { ...logoutAutoConfig, enabled: false } })
  await stop(); await start(); assert.equal(records.get('queue').value.auto_attempts.logout_good, 9007199254740991)
  check('Logout intent blocks automatic relogin, including disabled-account scans and plugin restart')

  await stop(); assert.equal(errors, ''); console.log(`Verified ${passed} protocol scenarios`)
} catch (error) { child?.kill(); console.error(error); process.exitCode = 1 }
