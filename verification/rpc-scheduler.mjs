import assert from 'node:assert/strict'

// 模拟 RPC v7 宿主的执行授权与回调回收，首次恢复延迟以验证等待期间不会继续执行。
export function createScheduler(send) {
  const calls = new Map(), callbacks = new Map()
  let delayed = false, suspensions = 0, resumptions = 0, consumed = 0
  return {
    handle(frame) {
      if (frame.type === 'callback') {
        assert.ok(!calls.has(frame.parent_id) || calls.get(frame.parent_id).phase === 'running')
        callbacks.set(frame.id, frame.parent_id)
      } else if (frame.type === 'suspend') {
        const previous = calls.get(frame.id)
        assert.equal(previous?.phase ?? 'running', 'running')
        assert.equal(frame.epoch, (previous?.epoch ?? 0) + 1)
        calls.set(frame.id, { epoch: frame.epoch, phase: 'suspended' })
        suspensions++
        return true
      } else if (frame.type === 'resume') {
        const call = calls.get(frame.id)
        assert.equal(call?.phase, 'suspended')
        assert.equal(call.epoch, frame.epoch)
        call.phase = 'resuming'
        const grant = () => {
          call.phase = 'running'
          resumptions++
          send({ type: 'resumed', id: frame.id, epoch: frame.epoch })
        }
        if (!delayed) { delayed = true; setTimeout(grant, 30) }
        else grant()
        return true
      } else if (frame.type === 'callback_consumed') {
        assert.equal(callbacks.get(frame.id), frame.parent_id)
        callbacks.delete(frame.id)
        consumed++
        return true
      } else if (frame.type === 'result' || frame.type === 'error') {
        assert.ok(!calls.has(frame.id) || calls.get(frame.id).phase === 'running', 'Parent continued before execution grant')
        calls.delete(frame.id)
      }
      return false
    },
    verify(requireProgress = true) {
      if (requireProgress) assert.ok(suspensions > 0 && resumptions > 0 && consumed > 0)
      assert.equal(suspensions, resumptions)
      assert.equal(calls.size, 0)
      assert.equal(callbacks.size, 0)
      return { suspensions, resumptions, consumed }
    },
  }
}
