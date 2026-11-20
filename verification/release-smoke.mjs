import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile, readdir, stat } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createScheduler } from './rpc-scheduler.mjs'

const root = resolve(process.argv[2])
const manifest = JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8'))
const pending = new Map()
const ready = Promise.withResolvers()
const callbacks = []
const stateRecords = new Map()
const scheduler = createScheduler(send)
const child = spawn(join(root, manifest.main), [], { stdio: ['pipe', 'pipe', 'pipe'] })
const exited = once(child, 'exit')
let buffered = Buffer.alloc(0), stderr = '', sequence = 99, stopping = false
const runtimeDirectories = async () => (await readdir(root)).filter(name => name.startsWith('.reauth-runtime-'))
function fail(error) {
  ready.reject(error)
  for (const waiter of pending.values()) waiter.reject(error)
}
function send(metadata, data, payload = Buffer.alloc(0), request) {
  const context = request ? Buffer.from(JSON.stringify(request)) : Buffer.alloc(0)
  const business = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data))
  if (context.length) metadata.request_context_bytes = context.length
  if (business.length) metadata.data_bytes = business.length
  const control = Buffer.from(JSON.stringify(metadata)), header = Buffer.alloc(12)
  header.writeUInt32BE(control.length)
  header.writeBigUInt64BE(BigInt(context.length + business.length + payload.length), 4)
  child.stdin.write(Buffer.concat([header, control, context, business, payload]))
}
child.stdout.on('data', chunk => {
  try {
    buffered = Buffer.concat([buffered, chunk])
    while (buffered.length >= 12) {
      const controlLength = buffered.readUInt32BE(), bodyLength = Number(buffered.readBigUInt64BE(4))
      assert.ok(controlLength < 65536 && bodyLength < 2 ** 20)
      const length = 12 + controlLength + bodyLength
      if (buffered.length < length) break
      const metadata = JSON.parse(buffered.subarray(12, 12 + controlLength))
      const start = 12 + controlLength + (metadata.request_context_bytes ?? 0)
      const end = start + (metadata.data_bytes ?? 0)
      assert.ok(end <= length)
      const data = end > start ? JSON.parse(buffered.subarray(start, end)) : undefined
      const payload = buffered.subarray(end, length)
      buffered = buffered.subarray(length)
      if (scheduler.handle(metadata)) continue
      if (metadata.type === 'ready') {
        assert.equal(metadata.protocol_version, 7)
        assert.deepEqual(metadata.call_budgets, {})
        ready.resolve()
      } else if (metadata.type === 'callback') {
        callbacks.push(metadata.method)
        assert.equal(data.namespace, 'reauth-manager')
        assert.ok(['queue', 'email-changes', 'email-settings'].includes(data.key))
        if (metadata.method === 'host.state.get') {
          assert.deepEqual(Object.keys(data).sort(), ['key', 'namespace'])
          send({ type: 'result', id: metadata.id }, { record: stateRecords.get(data.key) || null })
        } else {
          assert.equal(metadata.method, 'host.state.put')
          assert.equal(manifest.state[0].schema.type, 'object')
          assert.ok(data.value && typeof data.value === 'object' && !Array.isArray(data.value), 'Saved state must match the manifest object schema')
          const old = stateRecords.get(data.key)
          assert.equal(data.expected_version, old?.version ?? null)
          const version = (old?.version || 0) + 1
          stateRecords.set(data.key, { value: data.value, version, schema_version: 1 })
          send({ type: 'result', id: metadata.id }, { version })
        }
      } else {
        const waiter = pending.get(metadata.id)
        assert.ok(waiter, `Unexpected frame: ${metadata.type}`)
        pending.delete(metadata.id)
        if (metadata.type === 'error') waiter.reject(new Error(JSON.stringify(metadata.error)))
        else waiter.resolve({ result: data, payload })
      }
    }
  } catch (error) { fail(error) }
})
child.stderr.on('data', chunk => { stderr += chunk })
child.on('error', fail)
child.on('exit', code => { if (!stopping || code !== 0) fail(new Error(`Plugin exited: ${code}; ${stderr}`)) })
const timeout = setTimeout(() => { fail(new Error('Release smoke test timed out')); child.kill() }, 60000)
function call(method, params, payload = Buffer.alloc(0), stage = 'registration') {
  const id = sequence += 2, waiter = Promise.withResolvers()
  pending.set(id, waiter)
  const request = stage === 'management' ? { method: params.method, uri: `/plugin/${params.path}`, http_version: 'HTTP/1.1', headers: [], peer_addr: null, client_ip: null } : undefined
  send({ type: 'call', id, method, context: { call_id: id, instance_id: 'release_smoke', generation: 1, incarnation: 'release_smoke', stage, timeout_ms: stage === 'registration' ? 5000 : 120000, resource_stream: false, resource_scope_id: `scope_${id}` } }, params, payload, request)
  return waiter.promise
}
try {
  assert.deepEqual(await runtimeDirectories(), [])
  send({ type: 'hello', handshake: { protocol_version: 7, artifact_sha256: process.argv[3], plugin_id: `${manifest.publisher}.${manifest.name}`, instance_id: 'release_smoke', generation: 1, incarnation: 'release_smoke', contributes: manifest.contributes } }, {})
  await ready.promise
  const registration = JSON.parse((await call('management.register', {})).payload)
  assert.equal(registration.resources.length, 3)
  assert.ok(registration.routes.some(route => route.method === 'POST' && route.path === 'api/email-begin'))
  assert.ok(registration.routes.some(route => route.method === 'POST' && route.path === 'api/email-code'))
  assert.ok(!registration.resources.some(resource => resource.path.includes('runtime')))
  const probe = () => call('management.handle', { method: 'POST', path: 'api/runtime-check', query: '', content_type: 'application/json', headers: [] }, Buffer.from('{}'), 'management')
  const first = await probe()
  assert.equal(first.result.status, 200, first.payload.toString())
  assert.deepEqual(JSON.parse(first.payload), { ready: true })
  const directories = await runtimeDirectories()
  assert.equal(directories.length, 1)
  assert.equal((await stat(join(root, directories[0]))).mode & 0o777, 0o700)
  const second = await probe()
  assert.equal(second.result.status, 200)
  assert.deepEqual(JSON.parse(second.payload), { ready: true })
  assert.deepEqual(await runtimeDirectories(), directories)
  const history = await call('management.handle', { method: 'GET', path: 'api/email-changes', query: '', content_type: null, headers: [] }, Buffer.alloc(0), 'management')
  assert.equal(history.result.status, 200, history.payload.toString())
  assert.deepEqual(JSON.parse(history.payload), { records: [] })
  stateRecords.set('email-changes', { value: { records: [{ requestId: 'release-smoke-record', email: 'old@example.com', newEmail: 'new@example.com', status: 'failed', step: 'login', message: 'Offline fixture', createdAt: 1, credentials: null }] }, version: 1, schema_version: 1 })
  const deletedHistory = await call('management.handle', { method: 'POST', path: 'api/email-delete', query: '', content_type: 'application/json', headers: [] }, Buffer.from(JSON.stringify({ requestId: 'release-smoke-record' })), 'management')
  assert.equal(deletedHistory.result.status, 200, deletedHistory.payload.toString())
  assert.deepEqual(stateRecords.get('email-changes').value, { records: [] })
  const settingsRequest = (method, body = Buffer.alloc(0)) => call('management.handle', { method, path: 'api/email-settings', query: '', content_type: method === 'POST' ? 'application/json' : null, headers: [] }, body, 'management')
  const savedSettings = await settingsRequest('POST', Buffer.from(JSON.stringify({ emailSuffix: ' @BB.COM ' })))
  assert.equal(savedSettings.result.status, 200, savedSettings.payload.toString())
  assert.deepEqual(JSON.parse(savedSettings.payload), { emailSuffix: 'bb.com' })
  const readSettings = await settingsRequest('GET')
  assert.equal(readSettings.result.status, 200)
  assert.deepEqual(JSON.parse(readSettings.payload), { emailSuffix: 'bb.com' })
  stopping = true
  send({ type: 'shutdown' })
  child.stdin.end()
  const [code] = await exited
  assert.equal(code, 0, stderr)
  assert.deepEqual(await runtimeDirectories(), [])
  console.log(JSON.stringify({ version: manifest.version, protocolVersion: 7, runtimeReady: true, privateRuntimeMode: '0700', runtimeReused: true, shutdownCleanedRuntime: true, hostCallbacks: callbacks, scheduling: scheduler.verify() }, null, 2))
} finally {
  clearTimeout(timeout)
  if (child.exitCode === null) child.kill()
}
