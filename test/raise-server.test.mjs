// 보드 서버 쪽: 권한 경고의 종류와 대상 앱 이름이 /api/board 와 창을 올리는 조작의 응답에 실린다(F5·F6),
// 새 세션을 열 때 에이전트 명령을 셸이 준비된 뒤 한 번만 보낸다(가-12 B3-1).
// 가짜 herdr(이 파일이 임시 폴더에 쓰는 node 스크립트)와 가짜 소켓, 맥 창 올리기 대역만 쓴다 — 실제 herdr·osascript·터미널 창은 건드리지 않는다.
import { test, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'wr-'))
// 가짜 herdr 세션 소켓. 윈도우에서는 처음부터 named pipe 이름으로 적는다 — 플랫폼을 darwin 으로 바꿔 넣은 시험에서도 그대로 붙는다.
const SOCK = process.platform === 'win32' ? `\\\\.\\pipe\\${join(dir, 'd.sock')}` : join(dir, 'd.sock')
const LOG = join(dir, 'calls.log')
const FAKE = join(dir, 'herdr.mjs')
const SESSION = 'desk1'
const PROMPT = 'me@host proj %'
// 가짜 herdr: 켜져 있는 herdr 세션 하나(desk1)와 세션 하나(p1). 새 탭은 p9 — 그 화면은 처음 몇 번(파일 blank 의 수)은 비어 있다가
// 프롬프트가 나온다(파일 blank 가 'fail' 이면 화면 읽기가 실패한다). 받은 명령은 calls.log 에 한 줄씩 적는다.
writeFileSync(FAKE, `#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const dir = ${JSON.stringify(dir)}
let args = process.argv.slice(2)
if (args[0] === '--session') args = args.slice(2)
const a = args.join(' ')
const log = (o) => appendFileSync(join(dir, 'calls.log'), JSON.stringify(o) + '\\n')
const out = (o) => console.log(JSON.stringify(o))
if (a === '--version') console.log('herdr 0.0.0-fake')
else if (a === 'session list --json') out({ sessions: [{ name: ${JSON.stringify(SESSION)}, running: true, session_dir: dir, socket_path: ${JSON.stringify(SOCK)} }] })
else if (a === 'pane list') out({ result: { panes: [{ pane_id: 'p1', cwd: ${JSON.stringify(homedir())}, label: 'one' }] } })
else if (a === 'agent list') out({ result: { agents: [] } })
else if (args[0] === 'tab' && args[1] === 'create') { log(['tab create']); out({ result: { root_pane: { pane_id: 'p9' } } }) }
else if (args[0] === 'pane' && args[1] === 'read' && args[2] === 'p9') {
  const mode = existsSync(join(dir, 'blank')) ? readFileSync(join(dir, 'blank'), 'utf8').trim() : '0'
  if (mode === 'fail') { log(['pane read', 'p9', 'FAIL']); process.stderr.write('fake herdr: cannot read\\n'); process.exitCode = 1 }
  else {
    const f = join(dir, 'reads'); const n = existsSync(f) ? Number(readFileSync(f, 'utf8')) : 0
    writeFileSync(f, String(n + 1))
    const text = n < Number(mode) ? '' : ${JSON.stringify(PROMPT)}
    log(['pane read', 'p9', text]); console.log(text + '\\n\\n')
  }
}
else if (args[0] === 'pane' && args[1] === 'read') console.log('FAKE PANE SCREEN')
else if (args[0] === 'pane' && args[1] === 'run') log(['pane run', args[2], args[3]])
else { process.stderr.write('fake herdr: ' + a + '\\n'); process.exitCode = 1 }
`)
process.env.HERDR_BIN_PATH = FAKE
process.env.HERDR_BIN = FAKE
process.env.WHOSUP_STATE_DIR = join(dir, 'state')
process.env.WHOSUP_RUNTIMES = 'herdr'   // herdr-core 런타임은 읽지 않는다(이 기계의 코어를 찾아보지 않게)
process.env.WHOSUP_NO_EVENTS = '1'
process.env.CLAUDE_PROJECTS_DIR = join(dir, 'claude', 'projects')
process.env.AGENT_CMD = 'claude'
delete process.env.WHOSUP_READONLY
delete process.env.FRONT_APP
mkdirSync(process.env.CLAUDE_PROJECTS_DIR, { recursive: true })

const herdr = await import('../src/runtime/herdr.mjs')
const { _setPlatform } = await import('../src/platform.mjs')
const { collectAll } = await import('../src/runtime/index.mjs')
const { autoconfView, createBoardServer, withRaiseWarning } = await import('../src/board/server.mjs')
const { setAutoValues } = await import('../src/settings.mjs')
const { openDb } = await import('../src/db.mjs')

// 가짜 herdr 세션 소켓: pane.focus 에 답한다.
const focused = []
const sockServer = createServer((c) => {
  let buf = ''
  c.on('data', (d) => { buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return; const req = JSON.parse(buf.slice(0, nl)); focused.push([req.method, req.params]); c.write(`${JSON.stringify({ id: req.id, result: {} })}\n`) })
  c.on('error', () => {})
})
await new Promise((r) => sockServer.listen(SOCK, r))
after(() => sockServer.close())

const calls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const reset = (blank) => { writeFileSync(LOG, ''); writeFileSync(join(dir, 'reads'), '0'); writeFileSync(join(dir, 'blank'), String(blank)); focused.length = 0 }

// ── 가-12 B3-1 ──
// 읽는 횟수를 단언하는 시험은 기다리는 한도를 넉넉히 늘려 둔다: 기계가 바빠 가짜 herdr 실행이 느려도 결과가 같게.
async function patient(fn) {
  const keep = herdr.SHELL_WAIT.maxMs
  herdr.SHELL_WAIT.maxMs = 60000
  try { return await fn() } finally { herdr.SHELL_WAIT.maxMs = keep }
}
test('새 세션: 셸이 프롬프트를 그릴 때까지 기다린 뒤 에이전트 명령을 한 번만 보낸다(먼저 보내면 터미널에 두 번 찍힌다)', async () => {
  reset(3)   // 새 탭의 화면이 세 번은 비어 있다(셸이 아직 뜨는 중)
  const r = await patient(() => herdr.newSession({ session: SESSION, cwd: dir, command: 'claude', raise: false }))
  assert.deepEqual([r.session, r.pane, r.window], [SESSION, 'p9', 'skipped'])
  const log = calls()
  const runs = log.filter((c) => c[0] === 'pane run')
  assert.deepEqual(runs, [['pane run', 'p9', 'claude']], '명령은 한 번만 보낸다')
  const at = log.findIndex((c) => c[0] === 'pane run')
  const before = log.slice(0, at)
  assert.deepEqual(before[0], ['tab create'])
  const reads = before.filter((c) => c[0] === 'pane read').map((c) => c[2])
  assert.deepEqual(reads, ['', '', '', PROMPT, PROMPT], '빈 화면에서는 보내지 않고, 프롬프트가 두 번 이어 같게 보인 뒤에 보낸다')
  assert.deepEqual(focused, [['pane.focus', { pane_id: 'p9' }]], '그 뒤 새 세션으로 옮긴다')
})

test('새 세션: 이미 준비된 셸은 곧바로 지나가고(고정 시간 기다리기가 아니다), 화면을 읽지 못하면 예전처럼 그냥 보낸다', async () => {
  reset(0)
  await patient(() => herdr.newSession({ session: SESSION, cwd: dir, command: 'claude --resume abc', raise: false }))
  assert.deepEqual(calls().filter((c) => c[0] === 'pane read').map((c) => c[2]), [PROMPT, PROMPT], '같은 화면을 두 번 본 것으로 끝 — 한도까지 기다리지 않는다')
  assert.deepEqual(calls().filter((c) => c[0] === 'pane run'), [['pane run', 'p9', 'claude --resume abc']])

  reset('fail')
  await herdr.newSession({ session: SESSION, cwd: dir, command: 'claude', raise: false })
  assert.deepEqual(calls().map((c) => c[0]), ['tab create', 'pane read', 'pane run'], '한 번 읽어 보고 실패하면 기다리지 않고 보낸다')
})

test('새 세션: 화면이 끝내 비어 있어도 한도를 넘기면 한 번 보낸다(멈추지 않는다)', async () => {
  reset(100000)
  const keep = herdr.SHELL_WAIT.maxMs
  herdr.SHELL_WAIT.maxMs = 400
  try {
    await herdr.newSession({ session: SESSION, cwd: dir, command: 'claude', raise: false })
  } finally { herdr.SHELL_WAIT.maxMs = keep }
  const log = calls()
  assert.deepEqual(log.filter((c) => c[0] === 'pane run'), [['pane run', 'p9', 'claude']])
  // 읽은 횟수는 기계가 바쁜 정도에 달렸다(가짜 herdr 한 번 실행이 한도보다 오래 걸릴 수도 있다) — 횟수가 아니라 순서와 내용을 본다
  const reads = log.filter((c) => c[0] === 'pane read')
  assert.ok(reads.length >= 1)
  assert.ok(reads.every((c) => c[2] === ''), '화면은 끝까지 비어 있었다')
  assert.equal(log.at(-1)[0], 'pane run', '읽기를 그만둔 뒤에 보냈다')
})

// ── F5·F6: 서버 응답 ── 맥 창 올리기는 대역(상주 도우미·실행기)이고 플랫폼은 darwin 으로 바꿔 넣는다(어느 운영체제에서 돌려도 맥 길을 탄다).
const APP = '/Applications/Fake Term.app'
const PS = `
  100     1 ${APP}/Contents/MacOS/faketerm
  101   100 -zsh
  102   101 /opt/homebrew/bin/herdr --session ${SESSION}
`
const DENIED_1743 = 'execution error: System Events에 Apple 이벤트를 보낼 권한이 없습니다. (-1743)'
const DENIED_25211 = 'execution error: System Events에 오류 발생: osascript에 보조 접근이 허용되지 않습니다. (-25211)'
// precise(): System Events 정밀 올리기의 결과(던지면 실패). 도우미는 옛 응답 모양에 책임 앱 이름만 붙여 답한다.
function macRig(precise, own = '가짜 터미널') {
  herdr._setMacOps({
    helper: { send: async () => `ok:100|own=${encodeURIComponent(own)}` },
    run: async (file, args) => {
      if (file === '/bin/ps') return PS
      if (file === '/usr/bin/osascript' && /System Events/.test(args.join('\n'))) return precise()
      return ''
    },
    sleep: async () => {},
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
}
afterEach(() => { herdr._setMacOps(null); _setPlatform(null); herdr.setFrontApp('') })
async function board() {
  const db = openDb(':memory:')
  const srv = createBoardServer(db)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const url = `http://127.0.0.1:${srv.address().port}`
  const post = async (path, body) => { const r = await fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, body: await r.json() } }
  const get = async (path) => (await fetch(`${url}${path}`)).json()
  return { db, srv, url, post, get }
}
const settle = async () => { await herdr._raiseSettled(); await new Promise((r) => setImmediate(r)) }

test('⑧ /api/board: 경고가 없으면 둘 다 null, 생기면 raise_warning(종류)과 raise_warning_app(권한 대상 앱 이름)이 함께 실린다', async () => {
  reset(0)
  const { srv, get } = await board()
  try {
    macRig(() => '100')
    const none = await get('/api/board')
    assert.ok('raise_warning' in none && 'raise_warning_app' in none, '두 값은 늘 있다')
    assert.deepEqual([none.raise_warning, none.raise_warning_app], [null, null])

    macRig(() => { throw new Error(DENIED_1743) })
    await herdr.activateTerminal(SESSION); await settle()
    const b = await get('/api/board')
    assert.deepEqual([b.raise_warning, b.raise_warning_app], ['mac_automation', '가짜 터미널'])
    const a = await get('/api/autoconf')
    assert.deepEqual([a.raise_warning, a.raise_warning_app], ['mac_automation', '가짜 터미널'], '설정·첫 실행 안내가 읽는 값도 같다')

    macRig(() => { throw new Error(DENIED_25211) }, '')
    await herdr.activateTerminal(SESSION); await settle()
    const c = await get('/api/board')
    assert.equal(c.raise_warning, 'mac_accessibility', '종류가 다르다(한 값으로 묶지 않는다)')
    assert.equal(typeof c.raise_warning_app, 'string')
    assert.ok(c.raise_warning_app.length > 0, '도우미가 이름을 모르면 서버가 찾은 이름(조상의 앱, 없으면 실행 파일 이름)')
  } finally { srv.close() }
})

test('F5 카드 누르기·새 세션의 성공 응답: 경고가 떠 있는 동안에는 종류와 대상 앱 이름이 실리고, 없으면 예전 응답 그대로', async () => {
  reset(0)
  const { db, srv, post } = await board()
  try {
    await collectAll(db)
    const id = db.prepare('SELECT id FROM session WHERE runtime_ref = ?').get(`${SESSION}/p1`).id

    macRig(() => '100')
    const ok = await post('/api/open', { id, seq: 1 })
    assert.deepEqual([ok.status, ok.body.ok, ok.body.code, ok.body.window], [200, true, 'focused', 'raised'])
    assert.equal('raise_warning' in ok.body, false, '경고가 없으면 예전 응답 그대로')
    await settle()

    macRig(() => { throw new Error(DENIED_1743) })
    await post('/api/open', { id, seq: 2 }); await settle()   // 이 클릭에서 거부가 드러난다
    const again = await post('/api/open', { id, seq: 3 })
    assert.deepEqual([again.body.ok, again.body.code], [true, 'focused'])
    assert.deepEqual([again.body.raise_warning, again.body.raise_warning_app], ['mac_automation', '가짜 터미널'], '"성공"만 말하지 않는다')
    await settle()

    const made = await post('/api/new', { session: SESSION, cwd: homedir() })
    assert.deepEqual([made.status, made.body.ok, made.body.code], [200, true, 'opened_new'])
    assert.deepEqual([made.body.raise_warning, made.body.raise_warning_app], ['mac_automation', '가짜 터미널'])
    assert.deepEqual(calls().filter((c) => c[0] === 'pane run'), [['pane run', 'p9', 'claude']], '새 세션 명령은 한 번')
    await settle()

    // 권한을 켠 뒤(정밀 올리기 성공) 다음 응답부터는 경고가 없다
    macRig(() => '100')
    await post('/api/open', { id, seq: 4 }); await settle()
    const clean = await post('/api/open', { id, seq: 5 })
    assert.equal('raise_warning' in clean.body, false)
  } finally { srv.close() }
})

test('F5 이어서 열기·데스크 켜기의 성공 응답에도 경고가 실린다(없으면 예전 응답 그대로)', async () => {
  reset(0)
  const { db, srv, post } = await board()
  try {
    await collectAll(db)
    const id = db.prepare('SELECT id FROM session WHERE runtime_ref = ?').get(`${SESSION}/p1`).id

    macRig(() => '100')
    const desk0 = await post('/api/desk', { session: SESSION })
    assert.deepEqual([desk0.status, desk0.body.ok, desk0.body.code, desk0.body.window], [200, true, 'desk_started', 'raised'])
    assert.equal('raise_warning' in desk0.body, false, '경고가 없으면 예전 응답 그대로')
    await settle()

    macRig(() => { throw new Error(DENIED_1743) })
    await herdr.activateTerminal(SESSION); await settle()   // 여기서 거부가 드러난다

    const desk = await post('/api/desk', { session: SESSION })
    assert.deepEqual([desk.status, desk.body.ok, desk.body.code], [200, true, 'desk_started'])
    assert.deepEqual([desk.body.raise_warning, desk.body.raise_warning_app], ['mac_automation', '가짜 터미널'], '데스크 켜기')
    await settle()

    const resumed = await post('/api/resume', { id })
    assert.deepEqual([resumed.status, resumed.body.ok, resumed.body.code], [200, true, 'started'])
    assert.deepEqual([resumed.body.raise_warning, resumed.body.raise_warning_app], ['mac_automation', '가짜 터미널'], '이어서 열기')
    assert.deepEqual(calls().filter((c) => c[0] === 'pane run'), [['pane run', 'p1', 'claude']])
    await settle()

    // 창을 올리지 않는 응답(데스크 끄기 등)은 그대로다
    assert.deepEqual(withRaiseWarning({ ok: false, code: 'busy' }), { ok: false, code: 'busy' })
  } finally { srv.close() }
})

test('F5 화면 나눠 쓰기는 두 종류의 경고 모두에서 쓸 수 없다고 알린다(자동화를 거부해도 System Events 로 창을 옮기지 못한다)', async () => {
  reset(0)
  const db = openDb(':memory:')
  // 자동 감지가 "나눠 쓰기 가능"이라고 적어 둔 상태(auto.json 의 모양 그대로)
  setAutoValues({ at: '2026-11-14T00:00:00.000Z', platform: 'darwin', values: { split_available: true }, reasons: {}, lanes: [], summary: { split_available: true } })
  try {
    macRig(() => '100')
    assert.equal(autoconfView(db).summary.split_available, true, '경고가 없으면 감지한 값 그대로')
    for (const [denied, kind] of [[DENIED_1743, 'mac_automation'], [DENIED_25211, 'mac_accessibility']]) {
      macRig(() => { throw new Error(denied) })
      await herdr.activateTerminal(SESSION); await settle()
      const v = autoconfView(db)
      assert.equal(v.raise_warning, kind)
      assert.equal(v.summary.split_available, false, kind)
    }
    macRig(() => '100')
    await herdr.activateTerminal(SESSION); await settle()
    assert.equal(autoconfView(db).summary.split_available, true, '권한을 켜면(정밀 올리기 성공) 다시 감지한 값')
  } finally { setAutoValues(null) }
})

test('F5 경고가 생기면 열려 있는 보드 탭에 바로 알린다(다음 주기를 기다리지 않는다), 실패한 응답에는 싣지 않는다', async () => {
  reset(0)
  const { srv, url } = await board()
  const ac = new AbortController()
  try {
    const res = await fetch(`${url}/api/events`, { signal: ac.signal })
    const reader = res.body.getReader()
    const dec = new TextDecoder()
    let text = dec.decode((await reader.read()).value)
    assert.match(text, /: ok/)
    macRig(() => { throw new Error(DENIED_25211) })
    await herdr.activateTerminal(SESSION); await settle()
    for (let i = 0; i < 5 && !/data: \d+/.test(text); i++) text += dec.decode((await reader.read()).value)
    assert.match(text, /data: \d+/, '경고가 생긴 것을 탭에 밀어 줬다')
    assert.deepEqual(withRaiseWarning({ ok: false, code: 'closed' }), { ok: false, code: 'closed' })
    assert.deepEqual(withRaiseWarning({ ok: true, code: 'focused' }), { ok: true, code: 'focused', raise_warning: 'mac_accessibility', raise_warning_app: '가짜 터미널' })
  } finally { ac.abort(); srv.close() }
})
