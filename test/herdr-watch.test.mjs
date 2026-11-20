import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { connectTarget } from '../src/platform.mjs'

const dir = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'hw-'))
process.env.WHOSUP_STATE_DIR = dir
process.env.WHOSUP_NO_EVENTS = '0'
const { watchEvents, stopWatching } = await import('../src/runtime/herdr.mjs')
after(() => rm(dir, { recursive: true, force: true }))

const line = (frame) => JSON.stringify(frame) + '\n'
const ack = (id) => ({ id, result: { type: 'subscription_started' } })
const lost = (id) => ({ id, error: { code: 'events_lost', message: 'stream lagged' } })
const event = { event: { type: 'pane.created', pane_id: 'p' } }
async function waitFor(check, message) {
  const end = performance.now() + 2000
  while (!check() && performance.now() < end) await sleep(5)
  assert.ok(check(), message)
}

async function rig(t, names = ['desk']) {
  const servers = [], peers = new Set(), rows = [], changes = [], requests = new Map()
  t.after(async () => {
    stopWatching()
    for (const sock of peers) sock.destroy()
    await Promise.all(servers.map((s) => new Promise((done) => s.close(done))))
  })
  for (const name of names) {
    const socket = join(dir, name + '.sock'), list = []
    requests.set(name, list)
    const server = createServer((sock) => {
      peers.add(sock)
      sock.on('close', () => peers.delete(sock))
      sock.setEncoding('utf8')
      let buf = ''
      sock.on('data', (data) => {
        buf += data
        let i
        while ((i = buf.indexOf('\n')) >= 0) {
          const req = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1)
          list.push({ ...req, sock, send: (...frames) => sock.write(frames.map(line).join('')) })
        }
      })
    })
    server.listen(connectTarget(socket)); await once(server, 'listening')
    servers.push(server); rows.push({ name, socket, status: 'running' })
  }
  let clock = 0
  const sessions = names.map((name) => ({ runtime_ref: `${name}/p` }))
  const collect = () => watchEvents(sessions, rows, (name) => changes.push(name), () => clock)
  const request = async (n, name = names[0]) => {
    const list = requests.get(name)
    await waitFor(() => list.length >= n, `${name}: 구독 요청 ${n}번이 도착해야 한다`)
    return list[n - 1]
  }
  return { changes, requests, sessions, collect, request, at: (ms) => { clock = ms } }
}

// 같은 소켓에 이미 도착한 유실 뒤의 줄도 낡은 세대에 속한다.
async function lose(req, ...trailing) {
  const closed = once(req.sock, 'close')
  req.send(lost(req.id), ...trailing)
  await closed
}

test('데스크별 전역·pane 구독, 첫 ACK 무알림, 정상 이벤트와 EOF 재연결', { timeout: 8000 }, async (t) => {
  const r = await rig(t, ['desk', 'other'])
  r.sessions.push({ runtime_ref: 'desk/q' })
  r.collect()
  const [a, b] = await Promise.all([r.request(1), r.request(1, 'other')])
  for (const [req, panes] of [[a, ['p', 'q']], [b, ['p']]]) {
    assert.equal(req.method, 'events.subscribe')
    assert.deepEqual(req.params.subscriptions.filter((s) => !s.pane_id).map((s) => s.type).sort(),
      ['pane.agent_detected', 'pane.closed', 'pane.created', 'pane.exited'])
    assert.deepEqual(req.params.subscriptions.filter((s) => s.pane_id).map((s) => [s.type, s.pane_id]).sort(),
      panes.map((pane) => ['pane.agent_status_changed', pane]))
    req.send(ack(req.id))
  }
  await sleep(30); assert.deepEqual(r.changes, [])
  a.send(event); await waitFor(() => r.changes.length > 0, '정상 이벤트 알림')
  const closed = once(a.sock, 'close'); a.sock.end(); await closed
  r.collect(); const next = await r.request(2); next.send(ack(next.id))
  await sleep(30); assert.deepEqual(r.changes, ['desk'], 'EOF 뒤의 ACK는 유실 복구 알림이 아니다')
  b.send(event); await waitFor(() => r.changes.length === 2, '다른 데스크 이벤트')
  assert.deepEqual(r.changes, ['desk', 'other']); assert.equal(r.requests.get('other').length, 1)
})

test('미지원 오류는 메시지에 events_lost가 있어도 같은 pane 구성에서 재시도하지 않는다', { timeout: 8000 }, async (t) => {
  const r = await rig(t); r.collect(); const a = await r.request(1)
  const closed = once(a.sock, 'close')
  a.send({ id: a.id, error: { code: 'unknown_method', message: 'events_lost' } }); await closed
  r.at(60000); r.collect(); await sleep(30)
  assert.equal(r.requests.get('desk').length, 1); assert.deepEqual(r.changes, [])
  r.sessions.push({ runtime_ref: 'desk/q' }); r.collect(); await r.request(2)
})

test('첫 유실은 즉시 복구하고 현재 요청 ACK만 한 번 알린다. 유실 뒤 프레임과 다른 데스크는 독립적이다', { timeout: 8000 }, async (t) => {
  const r = await rig(t, ['desk', 'other']); r.collect()
  const [a, b] = await Promise.all([r.request(1), r.request(1, 'other')])
  await lose(a, event, ack(a.id)); r.collect(); const next = await r.request(2)
  assert.notEqual(next.id, a.id)
  next.send(ack(a.id), { id: next.id, result: { type: 'other' } })
  await sleep(30); assert.deepEqual(r.changes, [])
  next.send(ack(next.id)); await waitFor(() => r.changes.length > 0, '유실 복구 알림')
  next.send(ack(next.id)); await sleep(30)
  assert.deepEqual(r.changes, ['desk'])
  b.send(event); await waitFor(() => r.changes.length === 2, '다른 데스크는 연결 유지')
  next.send(event); await waitFor(() => r.changes.length === 3, '복구 뒤 정상 이벤트')
  assert.deepEqual(r.changes, ['desk', 'other', 'desk']); assert.equal(r.requests.get('other').length, 1)
})

test('유실 시점부터 6초·12초·12초 대기하고, 일치하는 첫 ACK부터 6초 안정되면 즉시 재시도한다', { timeout: 15000 }, async (t) => {
  const r = await rig(t); r.collect(); const first = await r.request(1)
  r.at(100); await lose(first); r.collect(); let req = await r.request(2)
  async function retryAfter(n, lossTime, delay) {
    r.at(lossTime); await lose(req)
    r.at(lossTime + delay - 1); r.collect(); await sleep(30)
    assert.equal(r.requests.get('desk').length, n, `${delay}ms 전에는 재구독 금지`)
    r.at(lossTime + delay); r.collect(); req = await r.request(n + 1)
  }
  // 연결된 지 오래여도 다른 요청의 ACK는 안정 시간의 기점이 아니다.
  req.send(ack(first.id)); await sleep(30)
  await retryAfter(2, 8000, 6000)
  r.at(20000); req.send(ack(req.id)); await waitFor(() => r.changes.length === 1, '복구 ACK 수신')
  await retryAfter(3, 25999, 12000)
  await retryAfter(4, 39000, 12000)
  r.at(52000); req.send(ack(req.id)); await waitFor(() => r.changes.length === 2, '상한 이후 복구 ACK 수신')
  r.at(57000); req.send(ack(req.id)); await sleep(30)
  r.at(58000); await lose(req); r.collect(); await r.request(6)
  assert.deepEqual(r.changes, ['desk', 'desk'], '중복 ACK가 안정 시계나 알림을 되풀이하지 않는다')
})
