// /api/health는 herdr에 닿지 못해도 200(프로세스가 답하는가만 말한다), /api/new는 데스크 이름을 검사한다,
// 다른 출처의 POST는 막는다. plugin.sh start는 herdr가 없어도 성공으로 끝나고 pid 파일이 맞게 남는다.
// POST 본문은 한도(바이트)를 넘으면 더 쌓지 않고 413 으로 답한 뒤 연결을 끊는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { request } from 'node:http'
import { PassThrough } from 'node:stream'
import { mkdtempSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(ROOT, 'bin/whosup.mjs')
const NO_HERDR = '/nonexistent/whosup-test/herdr'
const port = () => 4900 + Math.floor(Math.random() * 21)

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.once('error', reject)
    child.stdout.on('data', (d) => { out += d; const m = out.match(/listening at (http:\S+)/); if (m) resolve({ child, url: m[1], log: () => out }) })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
}

// 설정 폴더(HERDR_PLUGIN_CONFIG_DIR)도 임시 폴더로 준다: 보드가 이 기계의 ~/.config/whosup/setup.json·.env를 읽지 않게.
test('herdr에 닿지 못해도 /api/health는 200, /api/new는 이상한 데스크 이름을 400으로 막고, 다른 출처 POST는 403', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whosup-api-'))
  const { child, url, log } = await start({ WHOSUP_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: join(dir, 'conf'), HERDR_BIN: NO_HERDR, HERDR_BIN_PATH: NO_HERDR, PORT: String(port()), WHOSUP_INTERVAL: '60' })
  try {
    const h = await fetch(`${url}/api/health`)
    assert.equal(h.status, 200)
    const hb = await h.json()
    assert.equal(hb.ok, true)
    assert.equal(hb.herdr, null)
    assert.match(hb.herdr_error, /ENOENT/)

    const post = (path, body, headers = {}) => fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) })
    for (const session of ['--help', '-x', 'a b', 'a;b', '', 42]) {
      const r = await post('/api/new', { session, cwd: homedir() })
      assert.equal(r.status, 400, `session ${JSON.stringify(session)}`)
      assert.equal((await r.json()).code, 'bad_request')
    }
    const d = await post('/api/desk', { session: '--help' })
    assert.equal(d.status, 400)

    const evil = await post('/api/seen', { id: 1 }, { origin: 'http://evil.example' })
    assert.equal(evil.status, 403)
    const evilLocalOtherPort = await post('/api/seen', { id: 1 }, { origin: 'http://127.0.0.1:1' })
    assert.equal(evilLocalOtherPort.status, 403)

    // 다시 감지(F2-4): 실제 실행 파일에서 — 시작할 때의 첫 감지(auto.json 이 없어 뒤에서 돈다)와 "다시 감지"가 한 줄로 선다.
    // 겹쳐 눌러도 모두 답하고, 다시 감지는 첫 감지가 끝난 뒤에 돌며, auto.json 옆에 임시 파일이 남지 않는다.
    const again = await Promise.all([1, 2, 3].map(() => post('/api/autoconf/refresh', {})))
    assert.deepEqual(again.map((r) => r.status), [200, 200, 200], log())
    assert.match(log(), /autoconf: \d+ detected values[\s\S]*autoconf: re-detected \d+ values/, '첫 감지 다음에 다시 감지')
    assert.doesNotMatch(log(), /autoconf failed|could not write auto\.json/)
    assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp')), [])
    assert.equal(JSON.parse(readFileSync(join(dir, 'auto.json'), 'utf8')).version, 1)
  } finally { child.kill('SIGTERM') }
})

test('plugin.sh start: herdr가 없어도 성공으로 끝나고 pid 파일이 실제 프로세스를 가리키며, stop이 그 프로세스를 끈다', { skip: process.platform === 'win32' }, () => {
  const state = mkdtempSync(join(tmpdir(), 'whosup-plug-'))
  const conf = mkdtempSync(join(tmpdir(), 'whosup-conf-'))
  const env = { ...process.env, PATH: `${join(process.execPath, '..')}:${process.env.PATH}`, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: conf, PORT: String(port()), OPEN_BROWSER: '0', HERDR_BIN: NO_HERDR, HERDR_BIN_PATH: NO_HERDR, WHOSUP_INTERVAL: '60' }
  const sh = (cmd) => spawnSync('sh', [join(ROOT, 'scripts/plugin.sh'), cmd], { env, encoding: 'utf8', timeout: 20000 })
  let pid
  try {
    const s = sh('start')
    assert.equal(s.status, 0, s.stdout + s.stderr)
    assert.match(s.stdout, /listening/)
    pid = Number(readFileSync(join(state, 'server.pid'), 'utf8'))
    assert.doesNotThrow(() => process.kill(pid, 0))
    const st = sh('status')
    assert.equal(st.status, 0, st.stdout + st.stderr)
    const again = sh('start')
    assert.match(again.stdout, /already listening/)
    assert.equal(Number(readFileSync(join(state, 'server.pid'), 'utf8')), pid)
    const stop = sh('stop')
    assert.equal(stop.status, 0, stop.stdout + stop.stderr)
    assert.equal(existsSync(join(state, 'server.pid')), false)
    assert.throws(() => process.kill(pid, 0))
    pid = null
  } finally {
    // 실패해도 띄운 서버를 남기지 않는다.
    if (pid) try { process.kill(pid, 'SIGTERM') } catch {}
    if (existsSync(join(state, 'server.pid'))) sh('stop')
  }
})

// ── 본문 한도(F2-7) ──
// 서버를 프로세스 안에서 띄운다(DB 는 메모리, 런타임은 건드리지 않는 경로만 쓴다: 없는 세션 id 로 /api/open → 409 no_session).
test('POST 본문 한도: 4096바이트(글자 수가 아니라 바이트)를 넘으면 더 쌓지 않고 413 으로 답한 뒤 연결을 끊는다 — Content-Length 로 알린 것은 읽기 전에, 흘려보내는 것은 넘는 순간', async () => {
  const { BODY_MAX, createBoardServer, readBody } = await import('../src/board/server.mjs')
  const { openDb } = await import('../src/db.mjs')
  assert.equal(BODY_MAX, 4096)

  // 1) 읽는 함수만: 한도 안이면 바이트를 이어 붙여 한 번에 글자로 바꾼다(조각 경계에 걸린 한글이 깨지지 않는다)
  const fakeReq = (headers = {}) => Object.assign(new PassThrough(), { headers })
  const ok = fakeReq()
  const okBody = readBody(ok)
  const han = Buffer.from(JSON.stringify({ note: '세션'.repeat(100) }))
  ok.write(han.subarray(0, 11)); ok.end(han.subarray(11))     // 11바이트째는 한글 한 글자의 가운데다
  assert.equal(await okBody, han.toString('utf8'))
  // 한도를 넘는 순간: 거절하고, 쌓아 둔 것을 버리고, 더 읽지 않는다(멈춘다)
  const big = fakeReq()
  const bigBody = readBody(big)
  big.write(Buffer.alloc(BODY_MAX, 0x61))
  big.write(Buffer.alloc(1, 0x61))
  await assert.rejects(bigBody, (e) => e.code === 'body_too_large')
  assert.equal(big.isPaused(), true, '넘은 뒤에는 요청을 더 읽지 않는다')
  for (let i = 0; i < 50; i++) big.write(Buffer.alloc(64 * 1024, 0x62))   // 보내는 쪽이 계속 흘려보내도
  assert.ok(big.readableLength >= 16 * 1024 && big.listenerCount('data') === 1, '받는 쪽이 읽지 않아 보내는 쪽에 밀려 있다(이 프로세스가 쌓지 않는다)')
  big.destroy()
  // Content-Length 가 한도를 넘으면 한 바이트도 읽지 않고 거절한다
  const declared = fakeReq({ 'content-length': String(BODY_MAX + 1) })
  await assert.rejects(readBody(declared), (e) => e.code === 'body_too_large')
  assert.equal(declared.listenerCount('data'), 0)
  declared.destroy()
  // 글자 수가 아니라 바이트로 센다: 한글 2000자(6000바이트)는 한도를 넘는다
  const korean = fakeReq()
  const koreanBody = readBody(korean)
  korean.end(Buffer.from('가'.repeat(2000)))
  await assert.rejects(koreanBody, (e) => e.code === 'body_too_large')

  // 2) 서버를 거쳐
  const db = openDb(':memory:')
  const server = createBoardServer(db)
  let port = 48950 + (process.pid % 40)
  for (let i = 0; ; i++) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) }); break } catch (err) {
      if (err.code !== 'EADDRINUSE' || i > 40) throw err
      port += 1
    }
  }
  // 보내는 쪽을 손으로 몬다: headers, 보낼 조각들(함수면 닫힐 때까지 계속 부른다), 끝낼지.
  const send = ({ headers = {}, write = null, end = true } = {}) => new Promise((resolve) => {
    const out = { status: null, body: '', error: null, sent: 0, at: Date.now() }
    const req = request({ host: '127.0.0.1', port, path: '/api/open', method: 'POST', agent: false, headers: { 'content-type': 'application/json', ...headers } })
    let done = false
    const finish = () => { if (done) return; done = true; out.ms = Date.now() - out.at; resolve(out) }
    req.on('response', (res) => { out.status = res.statusCode; res.setEncoding('utf8'); res.on('data', (d) => { out.body += d }); res.on('end', finish); res.on('error', finish) })
    req.on('error', (e) => { out.error = e.code || String(e); finish() })
    req.on('close', () => setTimeout(finish, 50))
    if (typeof write === 'function') {
      const pump = () => { if (done || req.destroyed) return; const c = write(out.sent); if (!c) { if (end) req.end(); return } out.sent += c.length; req.write(c, () => setTimeout(pump, 2)) }
      req.flushHeaders(); pump()
    } else if (write) { out.sent = write.length; end ? req.end(write) : req.write(write) } else { req.flushHeaders() }
  })
  const padded = (bytes) => { const base = JSON.stringify({ id: 987654321, pad: '' }); return Buffer.from(JSON.stringify({ id: 987654321, pad: 'x'.repeat(bytes - Buffer.byteLength(base)) })) }
  try {
    // 한도까지는 받는다(딱 4096바이트): 본문을 읽고 처리했다 — 없는 세션이라는 답
    const fits = await send({ write: padded(BODY_MAX) })
    assert.equal(padded(BODY_MAX).length, BODY_MAX)
    assert.deepEqual([fits.status, JSON.parse(fits.body).code], [409, 'no_session'])
    // Content-Length 가 한도를 넘는다고 알렸다: 본문을 한 바이트도 보내기 전에 413 으로 답하고 끊는다
    const told = await send({ headers: { 'content-length': String(10 * 1024 * 1024) }, write: null })
    assert.deepEqual([told.status, JSON.parse(told.body).code, told.sent], [413, 'body_too_large', 0])
    assert.ok(told.ms < 3000, `곧바로 답한다(${told.ms}ms)`)
    // 길이를 알리지 않고 흘려보낸다(chunked): 한도를 넘는 순간 끊긴다 — 보내려던 것(약 2MB)을 다 받아 주지 않는다
    const total = 2 * 1024 * 1024
    const poured = await send({ write: (sent) => (sent < total ? Buffer.alloc(1024, 0x61) : null) })
    // 답(413)이 닿기 전에 끊김(ECONNRESET·EPIPE)이 먼저 보일 수 있다: 서버가 읽지 않은 바이트가 남은 채 연결을 닫기 때문이다
    assert.ok(poured.status === 413 || (poured.status === null && ['ECONNRESET', 'EPIPE'].includes(poured.error)), JSON.stringify(poured).slice(0, 200))
    assert.ok(poured.sent < total, `다 보내기 전에 끊겼다(${poured.sent}바이트)`)
    // 한도를 1바이트 넘은 보통 요청·한글 본문(글자 수는 한도 안, 바이트는 밖)도 받지 않는다
    for (const body of [padded(BODY_MAX + 1), Buffer.from(JSON.stringify({ id: 1, pad: '가'.repeat(2000) }))]) {
      const r = await send({ write: body })
      assert.ok(r.status === 413 || (r.status === null && ['ECONNRESET', 'EPIPE'].includes(r.error)), JSON.stringify(r).slice(0, 200))
    }
    // 그 뒤에도 서버는 멀쩡하다
    const after = await send({ write: Buffer.from(JSON.stringify({ id: 987654321 })) })
    assert.deepEqual([after.status, JSON.parse(after.body).code], [409, 'no_session'])
  } finally { server.closeAllConnections?.(); await new Promise((r) => server.close(r)) }
})
