// herdr-core 런타임 — 코어 여러 개 읽기와, "앱 안의 특정 세션으로 보낼 수단이 없는 앱"의 세션(보기·앱 창 올리기만).
// 가짜 코어 둘(소켓)과 가짜 herdr-app만 쓴다. 실제 코어·앱·herdr·터미널 창·osascript는 건드리지 않는다(창 올리기·앱 실행 확인은 주입).
// 코어 이름·앱 이름은 시험이 지어낸 것이다(deskapp·Deskapp) — 코드는 어떤 이름도 알고 있지 않다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startFakeCore, startNamedCore, term, agentTerm, appTerm } from '../test-support/fake-core.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wm-'))
const STATE = join(dir, 'st')
const LOG = join(dir, 'app.log')
const SOCK_A = join(dir, 'a.sock')
const SOCK_B = join(dir, 'b.sock')
// 읽을 코어는 이 시험이 정한 것만: 기계의 HC_*·WHOSUP_CORES·XDG_* 값이 섞이지 않게 한다.
for (const k of ['HC_SOCKET', 'HC_SESSION', 'WHOSUP_CORES', 'XDG_RUNTIME_DIR', 'HERDR_BIN_PATH', 'HERDR_APP_NAME', 'WHOSUP_READONLY', 'WHOSUP_RUNTIMES', 'WHOSUP_CORE_TARGET', 'WHOSUP_CLICK_TARGET', 'HC_BIN']) delete process.env[k]
process.env.XDG_STATE_HOME = STATE
process.env.HERDR_APP_BIN = fileURLToPath(new URL('../test-support/fake-herdr-app.mjs', import.meta.url))
chmodSync(process.env.HERDR_APP_BIN, 0o755)
process.env.FAKE_APP_LOG = LOG
process.env.FAKE_APP_SOCKET = SOCK_A                       // 가짜 herdr-app이 보여 주는 코어 = 기본 코어
process.env.HERDR_BIN = join(dir, 'no-herdr')              // herdr가 설치되지 않은 기계
process.env.WHOSUP_STATE_DIR = join(dir, 'state')
process.env.CLAUDE_PROJECTS_DIR = join(dir, 'claude', 'projects')
process.env.WHOSUP_NO_EVENTS = '1'
process.env.AGENT_CMD = 'claude'
mkdirSync(process.env.CLAUDE_PROJECTS_DIR, { recursive: true })
const WORK = join(dir, 'work'); mkdirSync(WORK)

const core = await import('../src/runtime/core.mjs')
// 새 터미널의 셸이 뜨기를 기다리는 일(core.mjs shellReady)은 이 파일의 시험에서는 끈다: 가짜 코어의 화면은 비어 있어 한도까지 기다리게 된다(그 동작의 시험은 test/ovis-app.test.mjs)
core._setShellWait({ maxMs: 0 })
const ovis = await import('../src/runtime/ovis.mjs')
// 자기 서버로 코어를 보여 주는 앱의 코어(프로필 focus:false)를 다룰 때 런타임은 그 앱의 서버를 등록부에서 찾는다. 이 시험에는 그런 서버가
// 없다: 빈 임시 폴더만 보게 해서 이 기계의 실제 등록부·실제 앱 서버에 닿지 않게 한다(서버가 있는 경우는 test/ovis-app.test.mjs).
const noServers = () => ovis._setLookup({ registryDirs: () => [join(dir, 'no-bridges')], userDataDirs: () => [] })
noServers()
const { collectAll, capsOf, openCoreNames } = await import('../src/runtime/index.mjs')
const { createBoardServer, openSession, resumeSession, markGoneNow, _clearResumeHolds } = await import('../src/board/server.mjs')
const { computeBoard, computeBoardAsync } = await import('../src/board/board.mjs')
const { clearContextCache } = await import('../src/board/context.mjs')
const { autoCores, clientDefaults, setAutoValues } = await import('../src/settings.mjs')
const { openDb, getMeta } = await import('../src/db.mjs')

const OTHER = 'deskapp'                                     // 기본 코어가 아닌 코어(자기 코어를 따로 띄우는 앱)
let A = await startNamedCore(STATE, 'default', SOCK_A)
let B = await startNamedCore(STATE, OTHER, SOCK_B)
after(async () => { core.stopWatching(); await A.close(); await B.close() })

const noWindows = { raiseApp: async () => 'off', openWindowRunning: async () => 'off', appRunning: async () => false }
const LIST_WAIT = { full: 5000, short: 1000, shortFor: 30000 }   // 코드의 기본값(시험이 줄였다가 reset 이 여기로 되돌린다)
const reset = () => {
  for (const f of [A, B]) { f.override = null; f.terminals.clear(); f.screens.clear(); f.calls.length = 0 }
  writeFileSync(LOG, '')
  for (const k of ['FAKE_APP_MODE', 'WHOSUP_CORES', 'HC_SOCKET', 'HC_SESSION', 'HERDR_APP_NAME']) delete process.env[k]
  process.env.XDG_STATE_HOME = STATE
  process.env.WHOSUP_NO_EVENTS = '1'
  setAutoValues(null)
  clearContextCache(); _clearResumeHolds(); core._resetScreenCache(); core.stopWatching()
  core.setOpenIn('app'); core._setWindowOps(noWindows); core._setListWait(LIST_WAIT); noServers()
  core.keepReading([])   // "열린 세션이 남아 있는 코어"는 수집이 알려 준다: 앞 시험의 판(DB)이 다음 시험의 읽을 코어에 섞이지 않게 비운다
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let clicks = 1000
const seq = () => ++clicks                                   // 마지막 클릭만 이긴다: 시험마다 더 큰 순번
const SPACE = { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }
const APP_SPACE = appTerm('t0').labels['herdr.space']        // 'ovis-<uuid>' 꼴의 공간 id
const APP_LABELS = appTerm('t0').labels
const DESK_B = `core:${OTHER}@${APP_SPACE}`
const idOf = (db, ref) => db.prepare('SELECT id FROM session WHERE runtime_ref = ? ORDER BY id DESC').get(ref).id
const rowOf = (db, ref) => db.prepare('SELECT * FROM session WHERE runtime_ref = ? ORDER BY id DESC').get(ref)
const refs = (snap) => snap.sessions.map((s) => s.runtime_ref).sort()
const liveAddrs = (f) => [...f.terminals.values()].filter((t) => t.state === 'live').map((t) => t.address)
const appCalls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const doCalls = () => appCalls().filter((a) => a[0] === 'do').map((a) => [a[1], JSON.parse(a[2])])
const cardsOf = (b) => Object.values(b.columns).flat()

// 서버를 거쳐(포트는 48000번대에서 빈 것을 찾는다). 띄울 때마다 다른 포트를 쓴다: 같은 포트를 다시 쓰면 fetch가 앞 서버에
// 붙어 있던 연결을 다시 쓰려다 끊긴다(ECONNRESET).
let nextPort = 48300 + (process.pid % 400)
async function withServer(db, fn) {
  const server = createBoardServer(db)
  let port = nextPort
  for (let i = 0; ; i++) {
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve() }) }); break } catch (err) {
      if (err.code !== 'EADDRINUSE' || i > 40) throw err
      port += 1
    }
  }
  nextPort = port + 1
  const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raise: false, ...body }) }); return { status: r.status, data: await r.json() } }
  const get = async (path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json()
  try { await fn({ post, get }) } finally { await new Promise((r) => server.close(r)) }
}

test('코어 둘을 함께 읽는다: 같은 주소 t1이 코어 이름으로 구분된 두 세션이 되고, 런타임 이름은 herdr-core 하나다', async () => {
  reset()
  process.env.WHOSUP_CORES = OTHER
  A.add(agentTerm('t1', 'working', { labels: SPACE, cwd: '/work/a' }))
  B.add(appTerm('t1', { cwd: '/work/notes' }))
  const db = openDb(':memory:')
  const { runs, failure, notes } = await collectAll(db)
  assert.equal(failure, null)
  assert.deepEqual(notes, [])
  assert.deepEqual(runs.map((r) => [r.name, r.sessions]), [['herdr-core', 2]])
  assert.deepEqual(db.prepare('SELECT runtime, runtime_ref, status FROM session ORDER BY runtime_ref').all().map((r) => Object.values(r)),
    [['herdr-core', 'default/t1', 'working'], ['herdr-core', `${OTHER}/t1`, 'shell']])
  const cards = cardsOf(await computeBoardAsync(db))
  const by = (ref) => cards.find((c) => c.ref === ref)
  // 기본 코어의 데스크 열쇠·이름은 예전 그대로, 다른 코어의 데스크는 열쇠에 코어 이름이 들어가고 이름 앞에 코어 이름이 붙는다
  assert.deepEqual([by('default/t1').desk, by('default/t1').desk_label], ['core:spA', 'my project'])
  assert.deepEqual([by(`${OTHER}/t1`).desk, by(`${OTHER}/t1`).desk_label], [DESK_B, `${OTHER} · notes`])
  assert.ok(core.isDesk(DESK_B))
  // 앱 안의 세션으로 보낼 수단을 모르는 코어(프로필 없음·focus 없음)의 세션은 이동과 웹 주소만 된다
  assert.deepEqual(by('default/t1').caps, ['focus', 'close', 'resume', 'new', 'toggle', 'web'])
  assert.deepEqual(by(`${OTHER}/t1`).caps, ['focus', 'web'])
  // 한 번 더 수집해도 행이 늘지 않는다(코어끼리 서로의 세션을 닫지 않는다)
  await collectAll(db); await collectAll(db); await collectAll(db)
  assert.deepEqual(db.prepare('SELECT runtime_ref, archived FROM session ORDER BY runtime_ref').all().map((r) => Object.values(r)), [['default/t1', 0], [`${OTHER}/t1`, 0]])
})

test('한쪽 코어가 꺼져도 다른 쪽 세션은 닫히지 않는다: 꺼진 쪽만 확인 불가로 남고, 오래 닿지 않으면 그쪽만 닫힘으로 간다', async () => {
  reset()
  process.env.WHOSUP_CORES = OTHER
  A.add(agentTerm('t1', 'blocked', { kind: 'question', msg: 'answer: go?', labels: SPACE }))
  B.add(agentTerm('t1', 'blocked', { kind: 'question', msg: 'answer: stay?', labels: APP_LABELS }))
  const db = openDb(':memory:')
  await collectAll(db)
  const state = (ref) => { const r = rowOf(db, ref); return [r.status, r.archived, r.unreachable] }
  await B.close()                                           // 소켓이 사라진다 = 그 코어 꺼짐
  try {
    let r
    for (let i = 0; i < 4; i++) r = await collectAll(db)
    assert.equal(r.failure, null)
    assert.deepEqual(state('default/t1'), ['blocked', 0, 0])           // 멀쩡한 코어의 세션은 그대로
    assert.deepEqual(state(`${OTHER}/t1`), ['blocked', 0, 1])          // 꺼진 코어의 세션: 닫지 않고 확인 불가
    assert.deepEqual(r.notes, [`herdr-core (${OTHER}): not running`])
    assert.deepEqual(computeBoard(db, { withContext: false }).health.unreachable, [OTHER])
    // 살아 있는 쪽은 계속 따라온다
    A.set('t1', { status: { app: 'claude-code', state: 'working' } })
    await collectAll(db)
    assert.deepEqual(state('default/t1'), ['working', 0, 0])
    // 그 채로 unreachable_ttl_h(기본 24시간)가 지나면 꺼진 코어의 세션만 닫힘으로 간다
    await collectAll(db, { now: new Date(Date.now() + 25 * 3600000) })
    assert.deepEqual(state(`${OTHER}/t1`), ['gone', 1, 0])
    assert.deepEqual(state('default/t1').slice(1), [0, 0])
  } finally { B = await startNamedCore(STATE, OTHER, SOCK_B) }

  // 반대쪽: 기본 코어가 꺼지고 다른 코어는 살아 있다
  reset()
  process.env.WHOSUP_CORES = OTHER
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'idle', { labels: APP_LABELS }))
  const db2 = openDb(':memory:')
  await collectAll(db2)
  const st2 = (ref) => { const r = rowOf(db2, ref); return [r.status, r.archived, r.unreachable] }
  await A.close()
  try {
    for (let i = 0; i < 4; i++) await collectAll(db2)
    assert.deepEqual(st2('default/t1'), ['idle', 0, 1])
    assert.deepEqual(st2(`${OTHER}/t1`), ['idle', 0, 0])
  } finally { A = await startNamedCore(STATE, 'default', SOCK_A) }
  // 다시 켜지면 확인 불가가 풀린다(같은 터미널이면 같은 세션으로 이어진다)
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  await collectAll(db2)
  assert.deepEqual(st2('default/t1'), ['idle', 0, 0])
  assert.equal(db2.prepare("SELECT COUNT(*) AS n FROM session WHERE runtime_ref LIKE 'default/%'").get().n, 1)

  // 떠 있지만 답하지 않는 코어: 그 코어의 세션만 확인 불가, 이유가 적힌다
  B.override = () => 'close'
  let r
  for (let i = 0; i < 4; i++) r = await collectAll(db2)
  assert.deepEqual(st2(`${OTHER}/t1`), ['idle', 0, 1])
  assert.deepEqual(st2('default/t1'), ['idle', 0, 0])
  assert.equal(r.notes.length, 1)
  assert.match(r.notes[0], new RegExp(`^herdr-core \\(${OTHER}\\): .*connection closed`))
  B.override = null
  await collectAll(db2)
  assert.deepEqual(st2(`${OTHER}/t1`), ['idle', 0, 0])
})

test('조작은 세션 ref의 코어로만 간다: 이동·입력·닫기 요청이 다른 코어의 같은 주소 t1에는 한 번도 가지 않는다', async () => {
  reset()
  // 두 코어 모두 닫기·입력이 되는 코어(프로필 focus: true)다. herdr-app은 기본 코어의 창만 안다(FAKE_APP_SOCKET).
  setAutoValues({ cores: [{ name: OTHER, focus: true }] })
  A.add(term('t1', { labels: SPACE, cwd: WORK }))
  B.add(term('t1', { labels: { 'herdr.space': 'spZ', 'herdr.tab': 'tbZ', where: 'zeta / 1' }, cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const [idA, idB] = [idOf(db, 'default/t1'), idOf(db, `${OTHER}/t1`)]
  assert.deepEqual(rowOf(db, `${OTHER}/t1`) && capsOf(rowOf(db, `${OTHER}/t1`)), ['focus', 'close', 'resume', 'new', 'toggle', 'web'])
  A.calls.length = 0; B.calls.length = 0; writeFileSync(LOG, '')

  // 이동: 다른 코어의 t1 — herdr-app을 쓰는 코어가 둘이면 주소만으로는 어느 코어의 pane인지 가릴 수 없다: 같은 주소의 기본 코어 pane으로 보내지 않는다
  const moved = await openSession(db, idB, seq(), { raise: false })
  assert.deepEqual([moved.ok, moved.code], [true, 'focused'])
  assert.deepEqual(doCalls(), [])                            // pane.focus { terminal: 't1' } 가 나가지 않았다
  assert.deepEqual(A.touched(), [])
  assert.ok(B.touched().every(([m, t]) => m === 'terminal.get' && t === 't1'))

  // 입력: 이어서 열기가 셸에 명령을 친다 — 그 코어의 t1에만
  const typed = await resumeSession(db, idB, undefined, { raise: false })
  assert.deepEqual([typed.ok, typed.code], [true, 'started'])
  assert.deepEqual(B.sent(), [['t1', 'claude']])
  assert.deepEqual(A.sent(), [])
  assert.deepEqual(A.touched(), [])
  assert.deepEqual(doCalls(), [])

  // 닫기: 다른 코어의 t1을 닫는다 — herdr-app이 아는 pane(pe-t1)은 기본 코어 것이라 닫지 않고, 그 코어의 터미널만 끝낸다
  await withServer(db, async ({ post }) => {
    const closed = await post('/api/close', { id: idB })
    assert.deepEqual([closed.status, closed.data.code], [200, 'pane_closed'])
  })
  assert.deepEqual(liveAddrs(B), [])
  assert.deepEqual(liveAddrs(A), ['t1'])                     // 같은 주소의 기본 코어 터미널은 살아 있다
  assert.deepEqual(doCalls().filter((c) => c[0] !== 'pane.focus'), [])
  assert.deepEqual(doCalls().filter((c) => c[0] === 'pane.close'), [])
  assert.deepEqual(A.touched().filter(([m]) => m !== 'terminal.get'), [])   // 닫기 뒤의 수집이 기본 코어를 읽을 뿐, 끝내거나 치지 않았다
  assert.deepEqual(A.touched(), [])

  // 거꾸로: 기본 코어의 t1을 다루는 동안 다른 코어에는 아무 요청도 가지 않는다
  B.add(term('t1', { labels: { 'herdr.space': 'spZ', 'herdr.tab': 'tbZ', where: 'zeta / 1' }, cwd: WORK, created_ms: 1794000009999 }))
  await collectAll(db)
  B.calls.length = 0; writeFileSync(LOG, '')
  const here = await openSession(db, idA, seq(), { raise: false })
  assert.deepEqual([here.ok, here.code], [true, 'focused'])
  // herdr-app이 보여 주는 코어(기본 코어)의 세션이어도 마찬가지다: 이 서버는 herdr-app이 어느 코어의 앱인지 모른다(P2-M1)
  assert.deepEqual(doCalls(), [])
  const typedA = await resumeSession(db, idA, undefined, { raise: false })
  assert.equal(typedA.ok, true)
  assert.deepEqual(A.sent(), [['t1', 'claude']])
  await core.closePane('default/t1')
  assert.deepEqual(liveAddrs(A), [])
  // herdr-app을 쓰는 코어가 둘이면 앱의 pane이 어느 코어 것인지 확실하지 않다: 닫기는 herdr-app을 거치지 않고 그 코어의 터미널을 직접 끝낸다
  assert.deepEqual(doCalls().filter((c) => c[0] !== 'pane.focus'), [])
  assert.deepEqual(B.touched(), [])
  assert.deepEqual(liveAddrs(B), ['t1'])
  // 읽지 않는 코어의 세션은 조작하지 않는다. 오류의 종류는 "터미널 없음"이 아니라 "그 코어를 읽지 않는다"이고, 문구에도
  // "not found" 가 없다(서버가 닫힘으로 옮길 때 보는 것과 섞이지 않는다 — P2-M2)
  const unread = (e) => e.code === 'core_unavailable' && !/not found/i.test(e.message)
  await assert.rejects(core.closePane('elsewhere/t1'), unread)
  await assert.rejects(core.focus('elsewhere/t1', { raise: false }), unread)
  await assert.rejects(core.readScreen('elsewhere/t1'), unread)
  assert.deepEqual(B.touched(), [])
})

test('herdr-app을 쓰는 코어가 둘이면 이동(pane.focus)도 herdr-app에 시키지 않는다: 공간 id와 주소가 둘 다 같아도 다른 코어의 pane으로 가지 않고, 그 코어에 붙는 터미널 창으로 연다 (P2-M1)', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, focus: true }] })
  // 두 코어에 공간 id(spA)도 주소(t1)도 똑같은 터미널이 있다. herdr-app이 보여 주는 것은 기본 코어다(FAKE_APP_SOCKET):
  // 앱에 물으면 "공간 spA 에 t1 이 있다"고 답하므로, 그 대조만으로는 다른 코어의 t1 을 기본 코어의 pane 으로 보내게 된다.
  A.add(agentTerm('t1', 'done', { turn: 2, labels: { ...SPACE }, cwd: WORK }))
  B.add(agentTerm('t1', 'done', { turn: 5, labels: { ...SPACE }, cwd: WORK }))
  const opened = []
  core._setWindowOps({ raiseApp: async (...a) => { opened.push(['raise', ...a]); return 'raised' }, appRunning: async () => true, openWindowRunning: async (...a) => { opened.push(['open', ...a]); return 'opened' } })
  const db = openDb(':memory:'); await collectAll(db)
  const [idA, idB] = [idOf(db, 'default/t1'), idOf(db, `${OTHER}/t1`)]
  A.calls.length = 0; B.calls.length = 0; writeFileSync(LOG, '')
  const socketOf = (call) => (process.platform === 'win32' ? call[3].HC_SOCKET : call[1].find((kv) => kv.startsWith('HC_SOCKET=')).slice('HC_SOCKET='.length))

  // 창을 올리지 않는 클릭: 앱의 pane 을 옮기지 않는다
  const quiet = await openSession(db, idB, seq(), { raise: false })
  assert.deepEqual([quiet.ok, quiet.code, quiet.window], [true, 'focused', 'skipped'])
  assert.deepEqual([appCalls(), opened], [[], []])
  // 창을 올리는 클릭: 앱을 올리지도 pane.focus 를 보내지도 않고, 그 코어의 소켓에 붙는 터미널 창을 연다
  const b = await openSession(db, idB, seq())
  assert.deepEqual([b.ok, b.code, b.window], [true, 'focused_opened', 'opened'])
  assert.deepEqual(opened.map((o) => o[0]), ['open'])
  assert.equal(socketOf(opened[0]), SOCK_B)
  opened.length = 0
  const a = await openSession(db, idA, seq())
  assert.deepEqual([a.ok, a.code, a.window], [true, 'focused_opened', 'opened'])
  assert.equal(socketOf(opened[0]), SOCK_A)
  assert.deepEqual(appCalls(), [])                           // herdr-app 은 한 번도 불리지 않았다(ls 도 pane.focus 도)
  // 본 것으로 적기는 각자의 코어에만(턴 번호가 서로 다르다)
  assert.deepEqual([A.terminals.get('t1').labels['whosup.seen'], B.terminals.get('t1').labels['whosup.seen']], ['2', '5'])
  // 새 세션 뒤의 이동도 같은 길이다: 앱에 시키지 않는다
  await core.newSession({ session: `core:${OTHER}@spA`, cwd: WORK, command: 'claude', raise: false })
  assert.deepEqual(doCalls(), [])

  // herdr-app을 쓰는 코어가 하나뿐이면 예전 그대로 앱의 pane 으로 간다
  setAutoValues(null); opened.length = 0
  const one = await openSession(db, idA, seq())
  assert.deepEqual([one.code, one.window], ['focused', 'raised'])
  assert.deepEqual(doCalls(), [['pane.focus', { terminal: 't1' }]])
  assert.deepEqual(opened.map((o) => o[0]), ['raise'])
})

test('코어가 읽는 목록에서 빠졌거나 닿지 않으면 그 세션을 닫힘으로 보내지 않는다. 그 코어가 "그 터미널은 없다"고 답했을 때만 최근 닫힘으로 옮긴다 (P2-M2)', async () => {
  reset()
  process.env.WHOSUP_CORES = OTHER
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS })); B.add(agentTerm('t2', 'idle', { labels: APP_LABELS })); B.add(agentTerm('t3', 'idle', { labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  const id = (t) => idOf(db, `${OTHER}/${t}`)
  const state = (t) => { const r = rowOf(db, `${OTHER}/${t}`); return [r.archived, r.status] }
  const asked = []
  core._setWindowOps({ appRunning: async () => { asked.push('running?'); return true }, raiseApp: async () => { asked.push('raise'); return 'raised' }, openWindowRunning: async () => { asked.push('open'); return 'opened' } })

  // 1) 읽는 목록에서 빠진 코어(자동 감지가 바뀌었거나 WHOSUP_CORES 를 고쳤다): 물어볼 코어가 없을 뿐, 터미널이 없다는 답이 아니다
  process.env.WHOSUP_CORES = 'none'
  B.calls.length = 0
  const r1 = await openSession(db, id('t1'), seq())
  assert.deepEqual([r1.ok, r1.code], [false, 'core_unavailable'])
  assert.deepEqual(state('t1'), [0, 'done'])
  assert.deepEqual([asked, B.calls.length], [[], 0])
  await withServer(db, async ({ post }) => {
    const p = await post('/api/open', { id: id('t1'), seq: seq() })
    assert.deepEqual([p.status, p.data.ok, p.data.code], [409, false, 'core_unavailable'])
    assert.ok(!JSON.stringify(p.data).includes(dir), '소켓 경로를 화면에 내보내지 않는다')
    // 닫기는 그 코어의 세션에서 할 수 없는 일로 거절한다(닫힘으로 옮기지 않는다)
    const c = await post('/api/close', { id: id('t2') })
    assert.deepEqual([c.status, c.data.code], [409, 'not_supported'])
  })
  assert.deepEqual([state('t1'), state('t2')], [[0, 'done'], [0, 'idle']])
  // 화면 문구: 새 결과 코드가 한국어·영어 둘 다에 있다
  const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
  assert.equal(html.split(', core_unavailable: ').length, 3)

  // 2) 닿지 않는 코어(소켓이 죽었다): 세션은 그대로, 답은 예전과 같은 "꺼져 있다"
  process.env.WHOSUP_CORES = OTHER
  await B.close()
  try {
    const r2 = await openSession(db, id('t1'), seq())
    assert.deepEqual([r2.ok, r2.code], [true, 'app_closed'])
    assert.deepEqual(state('t1'), [0, 'done'])
  } finally {
    B = await startNamedCore(STATE, OTHER, SOCK_B)
    B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS })); B.add(agentTerm('t2', 'idle', { labels: APP_LABELS })); B.add(agentTerm('t3', 'idle', { labels: APP_LABELS }))
  }
  // 3) 코어가 답하지 않는다(시간 초과)·"not found" 가 든 다른 오류로 답한다: 닫힘으로 보내지 않고 오류로 돌려준다
  B.override = (m) => (m === 'terminal.get' ? `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } })}\n` : undefined)
  await assert.rejects(openSession(db, id('t1'), seq()), (e) => e.code !== 'terminal_not_found' && /not found/.test(e.message))
  B.override = null
  assert.deepEqual(state('t1'), [0, 'done'])

  // 4) 그 코어가 그 터미널이 없다고 답했다(없는 주소·끝난 터미널·주소를 물려받은 다른 터미널): 그때만 최근 닫힘으로 옮긴다
  await assert.rejects(core.readScreen(`${OTHER}/t99`), (e) => e.code === 'terminal_not_found' && e.kind === 'not_found')
  B.terminals.delete('t1')
  const r4 = await openSession(db, id('t1'), seq())
  assert.deepEqual([r4.ok, r4.code, state('t1')], [true, 'pane_gone', [1, 'gone']])
  B.terminals.get('t2').state = 'finished'
  assert.deepEqual([(await openSession(db, id('t2'), seq())).code, state('t2')], ['pane_gone', [1, 'gone']])
  B.terminals.get('t3').created_ms += 1
  assert.deepEqual([(await openSession(db, id('t3'), seq())).code, state('t3')], ['pane_gone', [1, 'gone']])
  assert.deepEqual(asked, [])
  assert.deepEqual(A.touched(), [])
})

test('자동 감지 목록에서 빠진 코어(그 코어를 보여 주던 앱이 꺼졌다): 열린 세션이 남아 있는 동안에는 계속 읽는다 — 코어가 살아 있으면 세션이 그대로 보이고, 죽었으면 확인 불가로 두었다가 시간 뒤에 닫힘으로 간다. 사람이 정한 설정이 먼저다 (F2-5)', async () => {
  reset()
  const URL_B = 'http://127.0.0.1:48555/?pane={pane}'
  const none = { values: {}, reasons: {}, cores: [] }
  setAutoValues({ values: {}, reasons: {}, cores: [{ name: OTHER, app: 'Deskapp', focus: false, url: URL_B }] })
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'blocked', { kind: 'question', msg: 'answer: go?', labels: APP_LABELS, cwd: '/work/notes' })); B.add(appTerm('t2', { cwd: '/work/notes' }))
  const db = openDb(':memory:'); await collectAll(db)
  const state = (ref) => { const r = rowOf(db, ref); return [r.status, r.archived, r.unreachable] }
  const card = async (ref) => cardsOf(await computeBoardAsync(db)).find((c) => c.ref === ref)
  assert.deepEqual([(await card(`${OTHER}/t1`)).desk_label, clientDefaults(db)[`whosup-open-url-core:${OTHER}`]], ['Deskapp · notes', URL_B])

  // 1) 앱이 꺼졌다: 다음 감지의 cores 에서 그 코어가 빠진다. 코어는 살아 있다 — 세션은 닫힘으로 가지 않고 그대로 보인다
  setAutoValues(none)
  let r
  for (let i = 0; i < 5; i++) r = await collectAll(db)        // 안 보인 횟수(gone_misses 3)를 넘겨도
  assert.deepEqual([state(`${OTHER}/t1`), state(`${OTHER}/t2`), state('default/t1')], [['blocked', 0, 0], ['shell', 0, 0], ['idle', 0, 0]])
  assert.deepEqual([r.failure, r.notes], [null, []])
  B.set('t1', { status: { app: 'claude-code', state: 'working' } })
  await collectAll(db)
  assert.deepEqual(state(`${OTHER}/t1`), ['working', 0, 0], '그 코어의 변화를 계속 따라온다')
  // 마지막으로 안 프로필(앱 이름)로 보기 전용: 이름·단추는 그대로, 꺼진 앱의 웹 주소는 내려가지 않는다
  const c1 = await card(`${OTHER}/t1`)
  assert.deepEqual([c1.desk, c1.desk_label, c1.caps], [DESK_B, 'Deskapp · notes', OFF_CAPS])
  assert.equal(clientDefaults(db)[`whosup-open-url-core:${OTHER}`], undefined)
  assert.deepEqual(autoCores(), [])
  // 누르면: 그 앱이 꺼져 있다고 알린다(켜지 않고, 터미널 창도 열지 않는다)
  const asked = []
  core._setWindowOps({ appRunning: async (n) => { asked.push(['running?', n]); return false }, raiseApp: async (n) => { asked.push(['raise', n]); return 'raised' }, openWindowRunning: async () => { asked.push(['terminal']); return 'opened' } })
  const o1 = await openSession(db, idOf(db, `${OTHER}/t1`), seq())
  assert.deepEqual([o1.ok, o1.code, o1.app, asked], [true, 'app_closed', 'Deskapp', [['running?', 'Deskapp']]])
  // 새 세션·이어서 열기는 그 앱을 켜야 한다고 거절한다(까닭 코드 app_required 와 앱 이름). 데스크 끄기는 여전히 그 코어에서 할 수 없는 일이다.
  // 그 코어에는 아무것도 보내지 않았다. (닫기는 앱이 꺼져 있어도 코어에서 직접 한다 — test/ovis-app.test.mjs)
  const needsApp = (e) => e.code === 'app_required' && e.app === 'Deskapp'
  const sentBefore = B.calls.length
  await assert.rejects(core.newSession({ session: DESK_B, cwd: WORK, command: 'claude', raise: false }), needsApp)
  await assert.rejects(core.focus(`${OTHER}/t2`, { run: 'claude', raise: false }), needsApp)
  await assert.rejects(core.stopSession(DESK_B), (e) => e.code === 'not_supported')
  assert.deepEqual([B.calls.slice(sentBefore).map((x) => x.method), liveAddrs(B).sort()], [['terminal.get'], ['t1', 't2']])
  // 그 코어의 터미널 하나가 닫히면 그 세션만 예전 규칙대로(연속 3번 안 보임) 닫힘으로 간다
  B.terminals.delete('t2')
  for (let i = 0; i < 3; i++) await collectAll(db)
  assert.deepEqual([state(`${OTHER}/t2`), state(`${OTHER}/t1`)], [['gone', 1, 0], ['working', 0, 0]])

  // 2) 그 코어도 죽었다(소켓이 사라졌다): 읽는 목록 안의 꺼진 코어와 같은 규칙 — 확인 불가로 두었다가 unreachable_ttl_h 뒤에 닫힘
  await B.close()
  try {
    for (let i = 0; i < 4; i++) r = await collectAll(db)
    assert.deepEqual([state(`${OTHER}/t1`), state('default/t1')], [['working', 0, 1], ['idle', 0, 0]])
    assert.deepEqual(r.notes, [`herdr-core (${OTHER}): not running`])
    assert.deepEqual(computeBoard(db, { withContext: false }).health.unreachable, ['Deskapp'])
    asked.length = 0
    const o2 = await openSession(db, idOf(db, `${OTHER}/t1`), seq())
    assert.deepEqual([o2.ok, o2.code, o2.app, asked], [true, 'app_closed', 'Deskapp', []])
    assert.ok(!JSON.stringify(o2).includes(dir), '소켓 경로를 내보내지 않는다')
    await collectAll(db, { now: new Date(Date.now() + 25 * 3600000) })
    assert.deepEqual([state(`${OTHER}/t1`), state('default/t1').slice(1)], [['gone', 1, 0], [0, 0]])
  } finally { B = await startNamedCore(STATE, OTHER, SOCK_B) }
  // 3) 열린 세션이 다 닫혔으면 그 코어는 읽는 목록에서 빠진다: 다시 떠도(자동 감지가 찾기 전에는) 읽지 않는다
  B.add(appTerm('t5', { cwd: '/work/notes' }))
  await collectAll(db); await collectAll(db)
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM session WHERE runtime_ref = ?').get(`${OTHER}/t5`).n, 0)
  assert.deepEqual(refs(await core.listSnapshotAsync()), ['default/t1'])

  // 4) 보드를 다시 켠 뒤(마지막 프로필의 기억이 없다): DB 의 열린 행에서 코어 이름을 다시 얻어 보기 전용으로 읽는다.
  //    'backcore' 는 이 프로세스가 프로필로 읽은 적이 없는 코어다 — 지난 실행이 남긴 열린 행만 있다(여기서는 WHOSUP_CORES 로 한 번 읽어 만든다).
  reset()
  const R = await startNamedCore(STATE, 'backcore', join(dir, 'back.sock'))
  try {
    A.add(agentTerm('t1', 'idle', { labels: SPACE }))
    R.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS, cwd: '/work/zeta' }))
    const db2 = openDb(':memory:')
    process.env.WHOSUP_CORES = 'backcore'
    await collectAll(db2)
    delete process.env.WHOSUP_CORES
    core.keepReading([])                                      // 새로 뜬 프로세스: 아는 것이 없다
    const st2 = (ref) => { const x = rowOf(db2, ref); return [x.status, x.archived, x.unreachable] }
    for (let i = 0; i < 5; i++) r = await collectAll(db2)     // 자동 감지는 그 코어를 찾지 못했다(앱이 꺼져 있다)
    assert.deepEqual([st2('backcore/t1'), r.notes], [['done', 0, 0], []])
    const c2 = cardsOf(await computeBoardAsync(db2)).find((c) => c.ref === 'backcore/t1')
    assert.deepEqual([c2.desk_label, c2.caps], ['backcore · zeta', OFF_CAPS], '앱 이름은 모른다: 코어 이름으로 보이고, 앱이 꺼진 코어로 다뤄진다(닫기만)')
    assert.equal(core.canManage('backcore/t1'), false)
    // 자동 감지가 그 코어를 다시 찾으면(앱을 다시 켰다) 그 프로필로 돌아온다
    setAutoValues({ values: {}, reasons: {}, cores: [{ name: 'backcore', app: 'Zeta', focus: false }] })
    await collectAll(db2)
    assert.equal(cardsOf(await computeBoardAsync(db2)).find((c) => c.ref === 'backcore/t1').desk_label, 'Zeta · zeta')

    // 5) 사람이 읽을 코어를 정했으면 그 설정이 먼저다: 뺀 코어를 열린 세션이 있다고 다시 넣지 않는다(그 세션은 예전 규칙대로 닫힘으로 간다)
    setAutoValues(none)
    process.env.HC_SESSION = 'default'
    assert.deepEqual(refs(await core.listSnapshotAsync()), ['default/t1'], 'HC_SESSION 으로 코어 하나를 짚었다')
    delete process.env.HC_SESSION
    process.env.WHOSUP_CORES = OTHER
    B.add(appTerm('t7', { cwd: '/work/notes' }))
    assert.deepEqual(refs(await core.listSnapshotAsync()), ['default/t1', `${OTHER}/t7`], '이름 목록에 없는 코어는 읽지 않는다')
    process.env.WHOSUP_CORES = 'none'
    assert.deepEqual(refs(await core.listSnapshotAsync()), ['default/t1'])
    for (let i = 0; i < 3; i++) await collectAll(db2)
    assert.deepEqual(st2('backcore/t1'), ['gone', 1, 0])
    assert.equal((await openSession(db2, idOf(db2, 'default/t1'), seq())).ok, true)
  } finally { await R.close() }
  // 기본 코어는 늘 읽는다: 여기서 보태는 코어가 아니다
  assert.deepEqual(openCoreNames(db), ['default'])
})

test('herdr-app을 쓰는 코어가 둘이고 공간 id와 주소가 둘 다 같아도: 닫기·데스크 끄기·새 세션·데스크 켜기가 다른 코어의 세션·공간을 건드리지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, focus: true }] })
  // 두 코어에 공간 id(spA)도 주소(t1·t2)도 똑같은 터미널이 있다. herdr-app이 보여 주는 것은 기본 코어다(FAKE_APP_SOCKET).
  for (const f of [A, B]) { f.add(term('t1', { labels: { ...SPACE }, cwd: WORK })); f.add(term('t2', { labels: { ...SPACE }, cwd: WORK })) }
  await core.listSnapshotAsync()
  A.calls.length = 0; B.calls.length = 0; writeFileSync(LOG, '')
  const deskB = `core:${OTHER}@spA`

  // 닫기: herdr-app이 아는 pane(pe-t1)은 기본 코어 것이다 — 그것을 닫지 않고 그 코어의 t1만 끝낸다
  await core.closePane(`${OTHER}/t1`)
  assert.deepEqual([liveAddrs(A), liveAddrs(B)], [['t1', 't2'], ['t2']])
  // 새 세션: 기본 코어의 공간 spA에 탭을 만들지 않고 그 코어에 터미널을 만든다
  const made = await core.newSession({ session: deskB, cwd: WORK, command: 'claude', raise: false })
  assert.deepEqual(B.sent(), [[made.pane, 'claude']])
  assert.equal(A.terminals.size, 2)
  // 데스크 끄기: 기본 코어의 공간 spA(같은 id)를 닫지 않고 그 코어의 그 공간 터미널만 끝낸다
  await core.stopSession(deskB)
  assert.deepEqual(liveAddrs(A), ['t1', 't2'])
  assert.deepEqual(liveAddrs(B), [made.pane])                // 공간 밖에 만든 새 터미널은 그 데스크 것이 아니다
  // 데스크 켜기: herdr-app이 붙은 앱(기본 코어)에 공간을 만들지 않고 그 코어에 터미널을 만든다
  const on = await core.startSession(deskB, undefined, { raise: false })
  assert.equal(on.client, 'started')
  assert.equal(A.terminals.size, 2)
  assert.equal(liveAddrs(B).length, 2)
  // 그동안 herdr-app에는 끝내거나 만드는 명령이 하나도 가지 않았고, 기본 코어에는 목록 읽기 말고 아무 요청도 가지 않았다
  assert.deepEqual(doCalls(), [])
  assert.deepEqual(A.touched(), [])
  assert.deepEqual(A.sent(), [])

  // herdr-app을 쓰는 코어가 하나뿐이면 예전처럼 앱의 pane을 닫는다
  setAutoValues(null)
  writeFileSync(LOG, '')
  await core.closePane('default/t1')
  assert.deepEqual(doCalls(), [['pane.close', { pane: 'pe-t1' }]])
  assert.deepEqual(liveAddrs(A), ['t2'])
})

test('herdr-app은 그 앱의 코어 세션에만 불린다: 앱 안의 세션으로 보낼 수단이 없는 코어의 세션에는 한 번도 불리지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  core._setWindowOps({ raiseApp: async () => 'raised', appRunning: async () => true, openWindowRunning: async () => 'opened' })
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'blocked', { kind: 'question', msg: 'answer: go?', labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  writeFileSync(LOG, '')
  await openSession(db, idOf(db, `${OTHER}/t1`), seq())                    // 창 올리기 켬
  await openSession(db, idOf(db, `${OTHER}/t1`), seq(), { raise: false })  // 창 올리기 끔
  await computeBoardAsync(db)                                              // 질문 원문 읽기(화면)
  await collectAll(db)
  assert.deepEqual(appCalls(), [])
  await openSession(db, idOf(db, 'default/t1'), seq(), { raise: false })
  assert.deepEqual(appCalls(), [['do', 'pane.focus', JSON.stringify({ terminal: 't1' })]])
  // 화면 읽기(질문 원문)는 그 세션의 코어에서만
  assert.ok(B.calls.some((c) => c.method === 'terminal.read' && c.params.terminal === 't1'))
  assert.equal(A.calls.filter((c) => c.method === 'terminal.read').length, 0)
})

test('앱 안의 세션으로 보낼 수단이 없는 코어의 세션: 닫기·새 세션·이어서 열기·데스크 끄고 켜기를 서버가 거절한다(단추 숨김만이 아니다)', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  A.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: WORK }))
  // 자리 채우기: 서버는 방금 이어 열기를 받은 세션 번호를 3초 동안 다시 받지 않는다(연타 방지). 시험마다 새 DB라 번호가 1부터
  // 다시 시작하므로, 앞 시험이 이어 연 번호(1·2)와 겹치지 않게 아래 세션들의 번호를 뒤로 민다.
  A.add(agentTerm('t8', 'idle', { labels: SPACE, cwd: WORK })); A.add(agentTerm('t9', 'idle', { labels: SPACE, cwd: WORK }))
  B.add(appTerm('t1', { cwd: WORK }))                       // 셸: 예전이면 "이어서 열기" 단추가 붙는 세션
  B.add(appTerm('t2', { cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const id = idOf(db, `${OTHER}/t1`)
  assert.deepEqual(capsOf(rowOf(db, `${OTHER}/t1`)), ['focus', 'web'])
  B.calls.length = 0; writeFileSync(LOG, '')
  await withServer(db, async ({ post, get }) => {
    for (const [path, body] of [
      ['/api/close', { id }], ['/api/resume', { id }], ['/api/new', { session: DESK_B, cwd: WORK }],
      ['/api/desk', { session: DESK_B, on: false }], ['/api/desk', { session: DESK_B, on: true }],
      ['/api/new', { session: `core:${OTHER}@`, cwd: WORK }], ['/api/desk', { session: 'core:nosuchcore@spX', on: false }],
    ]) {
      const r = await post(path, body)
      assert.deepEqual([path, r.status, r.data.ok, r.data.code], [path, 409, false, 'not_supported'])
    }
    // 새 세션을 열 수 있는 데스크 목록에도 나오지 않는다
    assert.deepEqual((await get('/api/health')).targets, [{ key: 'core:spA', label: 'my project' }])
    // 닫힌 뒤의 "이어서 열기"도 거절한다(새 터미널을 만들지 않는다). 그 앱에서 터미널을 닫은 경우다.
    B.terminals.get('t2').state = 'finished'
    markGoneNow(db, idOf(db, `${OTHER}/t2`))
    const again = await post('/api/resume', { id: idOf(db, `${OTHER}/t2`) })
    assert.deepEqual([again.status, again.data.code], [409, 'not_supported'])
    assert.deepEqual(computeBoard(db, { withContext: false }).closed.map((c) => [c.ref, c.caps]), [[`${OTHER}/t2`, ['focus', 'web']]])
    // 이동은 된다(창 올리기를 끈 클릭)
    const open = await post('/api/open', { id, seq: seq() })
    assert.deepEqual([open.status, open.data.ok], [200, true])
  })
  // 그 코어에는 끝내기·입력·새 터미널 요청이 하나도 가지 않았고, herdr-app도 그 세션 때문에 불리지 않았다
  assert.deepEqual(B.touched().filter(([m]) => m !== 'terminal.get'), [])
  assert.deepEqual(liveAddrs(B), ['t1'])
  assert.equal(B.terminals.size, 2)                          // 새 터미널이 생기지 않았다
  assert.deepEqual(doCalls(), [])
  // 런타임을 직접 불러도 같은 이유로 거절한다(서버 검사를 지나친 경우의 두 번째 문)
  const refused = (e) => e.code === 'not_supported'
  await assert.rejects(core.closePane(`${OTHER}/t1`), refused)
  await assert.rejects(core.newSession({ session: DESK_B, cwd: WORK, command: 'claude', raise: false }), refused)
  await assert.rejects(core.stopSession(DESK_B), refused)
  await assert.rejects(core.startSession(DESK_B, undefined, { raise: false }), refused)
  await assert.rejects(core.focus(`${OTHER}/t1`, { run: 'claude', raise: false }), refused)
  assert.deepEqual(liveAddrs(B), ['t1'])
  assert.equal(B.terminals.size, 2)
  assert.deepEqual(B.sent(), [])
  // 기본 코어의 세션은 예전처럼 다 된다
  await withServer(db, async ({ post }) => {
    const closed = await post('/api/close', { id: idOf(db, 'default/t1') })
    assert.deepEqual([closed.status, closed.data.code], [200, 'pane_closed'])
  })
  assert.deepEqual(liveAddrs(A).sort(), ['t8', 't9'])
})

test('이동: 그 코어를 보여 주는 앱이 떠 있으면 그 앱 창만 올리고 그렇다고 알린다. 꺼져 있으면 켜지 않고 알린다. 앱을 모르면 터미널 창(hc attach)', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  const seen = []
  let running = true
  core._setWindowOps({
    appRunning: async (app) => { seen.push(['running?', app]); return running },
    raiseApp: async (app, split, opts) => { seen.push(['raise', app, split, opts]); return 'raised' },
    openWindowRunning: async (...a) => { seen.push(['open', ...a]); return 'opened' },
  })
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  const id = idOf(db, `${OTHER}/t1`)
  A.calls.length = 0; B.calls.length = 0; writeFileSync(LOG, '')

  // 앱이 떠 있다: 실행 여부를 먼저 묻고, 그 앱 이름으로 올리기를 부른다(앱이 없으면 켜지 말라는 표시와 함께)
  const a = await openSession(db, id, seq())
  assert.deepEqual([a.ok, a.code, a.window, a.app], [true, 'focused_app_only', 'app_only', 'Deskapp'])
  assert.deepEqual(seen, [['running?', 'Deskapp'], ['raise', 'Deskapp', 0, { launch: false }]])
  // 앱 창만 올린 것은 그 세션을 본 것이 아니다: 본 것으로 적지 않는다
  assert.equal(B.calls.filter((c) => c.method === 'terminal.label').length, 0)

  // 앱이 꺼져 있다: 올리기를 부르지 않는다(앱을 켜지 않는다)
  running = false; seen.length = 0
  const b = await openSession(db, id, seq())
  assert.deepEqual([b.ok, b.code, b.window, b.app], [true, 'app_closed', 'app_closed', 'Deskapp'])
  assert.deepEqual(seen, [['running?', 'Deskapp']])

  // 앱이 떠 있는지 알 길이 없는 운영체제: 아무 창도 건드리지 않고 그렇다고 알린다
  running = null; seen.length = 0
  const c = await openSession(db, id, seq())
  assert.deepEqual([c.ok, c.code, c.window], [true, 'app_raise_unsupported', 'unsupported'])
  assert.deepEqual(seen, [['running?', 'Deskapp']])

  // 앱은 떠 있는데 창 올리기가 오류로 실패했다(도우미가 실패를 알렸거나 던졌다): "앱이 꺼져 있다"가 아닌 코드로 답한다
  for (const broken of [async () => 'failed', async () => { throw new Error('helper died') }]) {
    running = true; seen.length = 0
    core._setWindowOps({ raiseApp: async (...a) => { seen.push(['raise', ...a]); return broken() } })
    const x = await openSession(db, id, seq())
    assert.deepEqual([x.ok, x.code, x.window, x.app], [true, 'app_raise_failed', 'app_failed', 'Deskapp'])
    assert.equal(seen.length, 2)                             // 실행 여부를 묻고, 올리기를 한 번 불렀다
  }
  core._setWindowOps({ raiseApp: async (app, split, opts) => { seen.push(['raise', app, split, opts]); return 'raised' } })
  assert.equal(B.calls.filter((c) => c.method === 'terminal.label').length, 0)

  // 창을 올리지 않는 클릭(raise:false): 아무것도 묻지도 올리지도 않는다. 서버가 그 세션을 보여 준 것이 없으므로 본 것으로 적지 않는다
  const labelWrites = () => B.calls.filter((c) => c.method === 'terminal.label').length
  const seenLabel = () => B.terminals.get('t1').labels['whosup.seen']
  const unsee = () => { delete B.terminals.get('t1').labels['whosup.seen']; B.calls.length = 0 }
  running = true; seen.length = 0
  const d = await openSession(db, id, seq(), { raise: false })
  assert.deepEqual([d.ok, d.code, d.window], [true, 'focused', 'skipped'])
  assert.deepEqual(seen, [])
  assert.deepEqual([labelWrites(), seenLabel()], [0, undefined])
  // 웹 터미널 탭을 열지 않았다고 화면이 알린 클릭도 마찬가지다
  await openSession(db, id, seq(), { raise: false, web: false })
  assert.deepEqual([labelWrites(), seenLabel()], [0, undefined])

  // 그 클릭이 그 세션의 웹 터미널 탭을 열었으면(web: true) 본 것으로 적는다 — 창을 올리지 않았어도, 앱 창만 올렸어도
  const w1 = await openSession(db, id, seq(), { raise: false, web: true })
  assert.deepEqual([w1.code, w1.window, labelWrites(), seenLabel()], ['focused', 'skipped', 1, '2'])
  unsee()
  const w2 = await openSession(db, id, seq(), { web: true })
  assert.deepEqual([w2.code, labelWrites(), seenLabel()], ['focused_app_only', 1, '2'])
  unsee()
  // 화면이 web 을 알려 주지 않는 경우(예전 화면): 그 코어의 웹 주소를 서버가 알 때만 창을 올리지 않는 클릭을 "웹 탭을 열었다"로 본다
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', url: 'http://127.0.0.1:48002/?pane={pane}' }] })
  await openSession(db, id, seq(), { raise: false })
  assert.deepEqual([labelWrites(), seenLabel()], [1, '2'])
  unsee()
  await openSession(db, id, seq(), { raise: false, web: false })              // 화면이 "열지 않았다"고 알렸으면 주소를 알아도 적지 않는다
  await openSession(db, id, seq())                                           // 앱 창만 올린 클릭(web 을 모른다)도 적지 않는다
  assert.deepEqual([labelWrites(), seenLabel()], [0, undefined])
  // 서버 경로도 web 을 그대로 넘긴다
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  await withServer(db, async ({ post }) => {
    const p0 = await post('/api/open', { id, seq: seq() })                   // raise:false, web 없음, 서버가 아는 웹 주소 없음
    assert.deepEqual([p0.status, p0.data.code, labelWrites()], [200, 'focused', 0])
    const p1 = await post('/api/open', { id, seq: seq(), web: true })
    assert.deepEqual([p1.status, p1.data.code, labelWrites(), seenLabel()], [200, 'focused', 1, '2'])
  })
  unsee()

  // 새 창 명령: macOS·리눅스는 /usr/bin/env K=V … hc attach t1, 윈도우는 [hc, attach, t1]과 환경변수 묶음
  const attached = (call) => (process.platform === 'win32' ? { cmd: call[1], key: call[2], env: call[3] }
    : { cmd: call[1].slice(-3), key: call[2], env: Object.fromEntries(call[1].slice(1, -3).map((kv) => [kv.slice(0, kv.indexOf('=')), kv.slice(kv.indexOf('=') + 1)])) })
  const wantAttach = { cmd: ['hc', 'attach', 't1'], key: `core-${OTHER}-t1`, env: { HC_SESSION: OTHER, HC_SOCKET: SOCK_B, XDG_STATE_HOME: STATE } }

  // "늘 터미널 창에서"(core_target=terminal): 앱을 거치지 않고 그 코어에 붙는 터미널 창을 연다 — 이때는 그 세션을 본 것으로 적는다
  // (바로 앞에서 라벨을 지웠다: 이 단계가 적은 것만 센다)
  assert.deepEqual([labelWrites(), seenLabel()], [0, undefined])
  core.setOpenIn('terminal'); seen.length = 0
  const e = await openSession(db, id, seq())
  assert.deepEqual([e.ok, e.code, e.window], [true, 'focused_opened', 'opened'])
  assert.equal(seen.length, 1)
  assert.deepEqual(attached(seen[0]), wantAttach)
  assert.deepEqual([labelWrites(), seenLabel()], [1, '2'])
  core.setOpenIn('app')

  // 프로필에 앱 이름이 없다: 예전의 터미널 창에서 열기로 간다
  setAutoValues({ cores: [{ name: OTHER }] }); seen.length = 0
  const f = await openSession(db, id, seq())
  assert.deepEqual([f.ok, f.code, f.window], [true, 'focused_opened', 'opened'])
  assert.deepEqual(attached(seen[0]), wantAttach)

  // 어느 경우에도 herdr-app과 기본 코어(같은 주소 t1)에는 아무것도 가지 않았다
  assert.deepEqual(appCalls(), [])
  assert.deepEqual(A.touched(), [])
})

test('이동: 터미널 창을 열지 못했으면(off — 창 올리기를 꺼 뒀거나 지원하지 않음) 그 세션을 본 것으로 적지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER }] })              // 앱을 모른다 → 그 코어에 붙는 터미널 창으로 연다(hc attach)
  const opened = []
  core._setWindowOps({ openWindowRunning: async (...a) => { opened.push(a); return 'off' } })
  try {
    B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS }))
    const db = openDb(':memory:'); await collectAll(db)
    B.calls.length = 0
    const r = await openSession(db, idOf(db, `${OTHER}/t1`), seq())
    assert.equal(opened.length, 1, '터미널 창 열기를 시도했다')
    assert.equal(r.window, 'off')
    assert.deepEqual([B.calls.filter((c) => c.method === 'terminal.label').length, B.terminals.get('t1').labels['whosup.seen']], [0, undefined],
      '아무 창도 열지 못했는데 본 것으로 적었다')
  } finally {
    core._setWindowOps({ openWindowRunning: async () => 'opened' })
  }
})

test('클릭 순번: 시계가 다른 두 브라우저 — 한쪽이 앞서 있어도 다른 브라우저의 더 나중 클릭이 무시되지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER }] })
  core._setWindowOps({ openWindowRunning: async () => 'opened' })
  B.add(agentTerm('t1', 'idle', { labels: APP_LABELS }))
  B.add(agentTerm('t2', 'idle', { labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  // 브라우저 A(시계가 1분 빠름)가 먼저 누르고, 그다음 브라우저 B(정확한 시계)가 다른 세션을 누른다. 순번은 각 화면이 자기 시계로 만든다.
  const ahead = (Date.now() + 60_000) * 1000, now = Date.now() * 1000
  const a = await openSession(db, idOf(db, `${OTHER}/t1`), ahead, { client: 'browser-a' })
  assert.notEqual(a.window, 'superseded')
  const b = await openSession(db, idOf(db, `${OTHER}/t2`), now, { client: 'browser-b' })
  assert.notEqual(b.window, 'superseded', '다른 브라우저의 나중 클릭이 앞선 시계 때문에 무시됐다')
  // 같은 브라우저 안에서는 예전처럼 더 오래된 클릭(늦게 도착한 앞 클릭)이 진다
  const late = await openSession(db, idOf(db, `${OTHER}/t1`), now - 1000, { client: 'browser-b' })
  assert.equal(late.window, 'superseded')
})

test('데스크 이름: 프로필의 공간 이름 > 폴더 이름. 기본 코어가 아니면 앱 이름(없으면 코어 이름)을 앞에 붙인다. 공간 id는 보여 주지 않는다', async () => {
  reset()
  const add = () => {
    A.add(term('t1', { labels: { 'herdr.space': 'spQ', 'herdr.tab': 'tbQ' }, cwd: '/work/plain' }))   // 기본 코어, 이름 라벨(where) 없는 공간
    A.add(term('t2', { labels: SPACE }))
    A.add(term('t3', { cwd: '/work/loose' }))                                                          // 공간 밖
    B.add(appTerm('t1', { cwd: '/work/notes' }))
    B.add(appTerm('t2', { cwd: '/work/notes/deeper' }))                                                // 같은 공간의 다른 폴더: 데스크 이름은 하나
    B.add(appTerm('t3', { space: 'ffffffff-0000-4000-8000-000000000002', cwd: '/work/second' }))
    B.add(term('t4', { cwd: '/work/loose' }))                                                          // 공간 밖
  }
  const labels = async () => Object.fromEntries((await core.listSnapshotAsync()).sessions.map((s) => [s.runtime_ref, [s.fields.desk, s.fields.deskLabel]]))
  const SECOND = 'ovis-ffffffff-0000-4000-8000-000000000002'
  add()
  // 1) 프로필 없음(WHOSUP_CORES로 지정): 코어 이름을 붙인다
  process.env.WHOSUP_CORES = OTHER
  let l = await labels()
  assert.deepEqual(l['default/t1'], ['core:spQ', 'plain'])
  assert.deepEqual(l['default/t2'], ['core:spA', 'my project'])
  assert.deepEqual(l['default/t3'], ['core:', 'herdr-core'])
  assert.deepEqual(l[`${OTHER}/t1`], [DESK_B, `${OTHER} · notes`])
  assert.deepEqual(l[`${OTHER}/t2`], [DESK_B, `${OTHER} · notes`])
  assert.deepEqual(l[`${OTHER}/t3`], [`core:${OTHER}@${SECOND}`, `${OTHER} · second`])
  assert.deepEqual(l[`${OTHER}/t4`], [`core:${OTHER}@`, OTHER])                 // 공간 밖 데스크도 기본 코어의 것(core:)과 겹치지 않는다
  // 2) 프로필에 앱 이름: 앱 이름을 붙인다
  delete process.env.WHOSUP_CORES
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  l = await labels()
  assert.deepEqual([l[`${OTHER}/t1`][1], l[`${OTHER}/t3`][1], l[`${OTHER}/t4`][1]], ['Deskapp · notes', 'Deskapp · second', 'Deskapp'])
  // 3) 프로필이 공간 이름을 안다: 그 이름을 쓴다(모르는 공간은 폴더 이름)
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', spaces: { [APP_SPACE]: 'Team room' } }] })
  l = await labels()
  assert.deepEqual([l[`${OTHER}/t1`][1], l[`${OTHER}/t2`][1], l[`${OTHER}/t3`][1]], ['Deskapp · Team room', 'Deskapp · Team room', 'Deskapp · second'])
  // 어느 이름에도 공간 id가 그대로 나오지 않는다
  for (const [, label] of Object.values(l)) assert.ok(!/spQ|ovis-[0-9a-f]{8}/.test(label), label)
  // 데스크 열쇠는 프로필이 바뀌어도 그대로다(브라우저에 저장한 데스크별 값이 이어진다)
  assert.deepEqual([l[`${OTHER}/t1`][0], l['default/t1'][0]], [DESK_B, 'core:spQ'])
})

test('HC_SOCKET·HC_SESSION을 주면 그 코어 하나만 읽는다(WHOSUP_CORES·자동 감지 목록으로 읽을 코어를 늘리지 않는다). 이름이 같은 자동 감지 프로필은 그 코어의 정보로 쓴다', async () => {
  reset()
  A.add(term('t1', { labels: SPACE }))
  B.add(term('t1', { labels: SPACE }))
  try {
    process.env.FAKE_APP_SOCKET = SOCK_B                      // herdr-app이 보여 주는 코어도 그 코어다(코어 하나만 쓰는 기계)
    process.env.WHOSUP_CORES = 'all'
    setAutoValues({ cores: [{ name: 'default' }, { name: OTHER, app: 'Deskapp' }] })
    // 소켓과 이름을 함께: ref의 코어 이름은 HC_SESSION, 요청은 HC_SOCKET으로만
    process.env.HC_SOCKET = SOCK_B; process.env.HC_SESSION = 'solo'
    let snap = await core.listSnapshotAsync()
    assert.deepEqual(refs(snap), ['solo/t1'])
    assert.deepEqual(snap.sessions[0].fields.desk, 'core:spA')
    assert.equal(core.socketPath(), SOCK_B)
    assert.equal(core.refOf('t9'), 'solo/t9')
    assert.equal(A.calls.length, 0)
    const db = openDb(':memory:'); await collectAll(db)
    assert.deepEqual(capsOf(rowOf(db, 'solo/t1')), ['focus', 'close', 'resume', 'new', 'toggle', 'web'])   // 예전 그대로 다 된다
    await core.closePane('solo/t1')
    assert.deepEqual([liveAddrs(B), liveAddrs(A)], [[], ['t1']])
    assert.equal(A.calls.length, 0)
    // 이름만: 그 이름의 core.lock에서 소켓을 찾고, 그 코어 하나만 읽는다
    delete process.env.HC_SOCKET; process.env.HC_SESSION = OTHER
    B.add(term('t2', { labels: SPACE }))
    snap = await core.listSnapshotAsync()
    assert.deepEqual(refs(snap), [`${OTHER}/t2`])
    assert.equal(core.socketPath(), SOCK_B)
    assert.equal(A.calls.length, 0)

    // 고정한 코어와 이름이 같은 자동 감지 프로필은 그 코어의 정보로 쓴다(읽을 코어는 여전히 하나다).
    const FULL = ['focus', 'close', 'resume', 'new', 'toggle', 'web']
    const caps = () => capsOf({ runtime: 'herdr-core', runtime_ref: `${OTHER}/t2`, fields_json: JSON.stringify({ desk: 'core:spA' }) })
    // 위 프로필({ name: OTHER, app: 'Deskapp' })은 focus 를 적지 않았다: 고정한 코어는 기본 코어이므로 예전처럼 다 된다
    assert.deepEqual(caps(), FULL)
    assert.equal(snap.sessions[0].fields.deskLabel, 'my project')            // 기본 코어의 데스크 이름에는 앱 이름을 붙이지 않는다
    // 프로필이 "앱 안의 세션으로 보낼 수단이 없다"고 분명히 적었으면 고정한 코어도 보기 전용이다(herdr-app 에 그 코어의 주소를 넘기지 않는다)
    setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', focus: false }, { name: 'default', focus: true }] })
    assert.deepEqual(caps(), OFF_CAPS)
    assert.deepEqual(refs(await core.listSnapshotAsync()), [`${OTHER}/t2`])   // 프로필에 다른 코어가 있어도 읽지 않는다
    writeFileSync(LOG, '')
    // 데스크 끄기는 거절하고, 새 세션은 그 앱을 켜야 한다고 거절한다(그 앱의 서버가 없다). herdr-app 은 불리지 않는다
    await assert.rejects(core.stopSession('core:spA'), (e) => e.code === 'not_supported')
    await assert.rejects(core.newSession({ session: 'core:spA', cwd: WORK, command: 'claude', raise: false }), (e) => e.code === 'app_required' && e.app === 'Deskapp')
    assert.deepEqual([appCalls(), liveAddrs(B)], [[], ['t2']])
    // 닫기는 그 앱의 서버가 없으면 이 코어의 소켓으로 직접 간다(그 세션의 터미널임을 확인한 뒤) — herdr-app 의 pane 닫기로 가지 않는다
    B.add(term('t3', { labels: SPACE }))
    B.calls.length = 0
    assert.deepEqual(await core.closePane(`${OTHER}/t3`, { incarnation: String(B.terminals.get('t3').created_ms) }), { pane: 't3', means: 'core_socket' })
    assert.deepEqual([B.calls.map((x) => [x.method, x.params.terminal]), appCalls(), liveAddrs(B)], [[['terminal.get', 't3'], ['terminal.get', 't3'], ['terminal.kill', 't3']], [], ['t2']])   // 확인 두 번: 처음, 끝내기 바로 전
    // HC_SOCKET 을 줬고 프로필에 socket 이 없으면: 이름이 같은 프로필이 그대로 붙는다
    process.env.HC_SOCKET = SOCK_B
    assert.deepEqual(caps(), OFF_CAPS)
    // HC_SOCKET 이 프로필의 socket 과 다른 소켓을 가리키면: 이름만 같은 다른 코어다 — 그 프로필은 쓰지 않는다(예전처럼 다 된다)
    setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', focus: false, socket: SOCK_A }] })
    assert.deepEqual(caps(), FULL)
    assert.equal(core.socketPath(), SOCK_B)
    setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', focus: false, socket: SOCK_B }] })
    assert.deepEqual(caps(), OFF_CAPS)
    assert.equal(A.calls.length, 0)
  } finally { delete process.env.HC_SOCKET; delete process.env.HC_SESSION; process.env.FAKE_APP_SOCKET = SOCK_A }
})

test('죽은 소켓(파일만 남은 코어)은 읽지 않고 오류도 쌓지 않는다', { skip: process.platform === 'win32' && '윈도우의 named pipe에는 남는 소켓 파일이 없다' }, async () => {
  reset()
  // 1) 진짜로 남은 소켓: 듣던 프로세스가 강제로 죽어 소켓 파일만 남았다
  const stale = join(dir, 'stale.sock')
  const child = spawn(process.execPath, ['-e', "require('node:net').createServer().listen(process.argv[1], () => console.log('up'))", stale], { stdio: ['ignore', 'pipe', 'ignore'] })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('listener exited early'))) })
  child.removeAllListeners('exit')
  const gone = new Promise((r) => child.once('exit', r))
  child.kill('SIGKILL'); await gone
  assert.ok(existsSync(stale), '소켓 파일이 남아 있다')
  for (const [name, path] of [['ghost', stale], ['paper', join(dir, 'paper.sock')]]) {
    mkdirSync(join(STATE, 'herdr-core', name), { recursive: true })
    writeFileSync(join(STATE, 'herdr-core', name, 'core.lock'), `${path}\n`)
  }
  writeFileSync(join(dir, 'paper.sock'), 'not a socket')    // 2) 소켓 자리에 남은 보통 파일
  process.env.WHOSUP_CORES = 'all'
  A.add(agentTerm('t1', 'working', { labels: SPACE }))
  B.add(appTerm('t1'))
  const db = openDb(':memory:')
  let r
  for (let i = 0; i < 4; i++) r = await collectAll(db)
  assert.equal(r.failure, null)
  assert.deepEqual(r.notes, [])
  assert.deepEqual(r.runs.map((x) => [x.name, x.sessions, x.held]), [['herdr-core', 2, 0]])
  assert.equal(getMeta(db, 'collect_err'), null)
  assert.deepEqual(computeBoard(db, { withContext: false }).health.unreachable, [])
  assert.deepEqual(db.prepare('SELECT runtime_ref FROM session ORDER BY runtime_ref').all().map((x) => x.runtime_ref), ['default/t1', `${OTHER}/t1`])
  // 죽은 소켓뿐인 기계: 코어가 없는 것으로 본다(세션도 오류도 생기지 않는다)
  const lone = join(dir, 'lone-state')
  mkdirSync(join(lone, 'herdr-core', 'ghost'), { recursive: true })
  writeFileSync(join(lone, 'herdr-core', 'ghost', 'core.lock'), `${stale}\n`)
  process.env.XDG_STATE_HOME = lone
  try {
    assert.equal((await core.snapshotRuntime()).absent, true)
    const empty = openDb(':memory:')
    const r2 = await collectAll(empty)
    assert.deepEqual(r2.runs, [])
    assert.deepEqual(r2.notes, [])
    assert.equal(empty.prepare('SELECT COUNT(*) AS n FROM session').get().n, 0)
    assert.equal(getMeta(empty, 'collect_err_kind'), 'no_herdr')           // 남는 것은 예전부터 있던 herdr 없음뿐
  } finally { process.env.XDG_STATE_HOME = STATE }
})

test('읽을 코어 고르기: WHOSUP_CORES=all은 소켓이 있는 코어 전부, 이름 목록은 그 코어들, none은 기본 코어만. 없으면 자동 감지 목록. 환경변수가 자동 감지를 이긴다', async () => {
  reset()
  const G = await startNamedCore(STATE, 'gamma', join(dir, 'g.sock'))
  try {
    A.add(term('t1')); B.add(term('t1')); G.add(term('t1'))
    const read = async () => refs(await core.listSnapshotAsync()).filter((r) => !/^(ghost|paper)\//.test(r))
    // 아무것도 정하지 않으면 기본 코어만(예전 동작)
    assert.deepEqual(await read(), ['default/t1'])
    process.env.WHOSUP_CORES = 'all'
    assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`, 'gamma/t1'])
    process.env.WHOSUP_CORES = `${OTHER}, nosuchcore, bad/name`
    assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
    const db = openDb(':memory:')
    assert.deepEqual((await collectAll(db)).notes, [])                     // 없는 코어 이름은 조용히 지나간다
    process.env.WHOSUP_CORES = 'gamma'
    assert.deepEqual(await read(), ['default/t1', 'gamma/t1'])
    // 자동 감지가 알려 준 코어 목록(환경변수가 없을 때)
    delete process.env.WHOSUP_CORES
    setAutoValues({ values: {}, reasons: {}, cores: [{ name: 'gamma', app: 'Gamma', focus: false }] })
    assert.deepEqual(await read(), ['default/t1', 'gamma/t1'])
    // 프로필이 소켓 경로를 알려 주면 core.lock 없이도 읽는다
    const extra = await startFakeCore(join(dir, 'x.sock'))
    try {
      extra.add(term('t7'))
      setAutoValues({ cores: [{ name: 'nolock', socket: extra.path }] })
      assert.deepEqual(await read(), ['default/t1', 'nolock/t7'])
    } finally { await extra.close() }
    // 환경변수 > 자동 감지: none이면 기본 코어만, 이름을 적으면 그 코어들만(프로필은 이름이 같은 코어의 정보로 쓴다)
    setAutoValues({ cores: [{ name: 'gamma', app: 'Gamma' }, { name: OTHER, app: 'Deskapp' }] })
    process.env.WHOSUP_CORES = 'none'
    assert.deepEqual(await read(), ['default/t1'])
    process.env.WHOSUP_CORES = OTHER
    const snap = await core.listSnapshotAsync()
    assert.deepEqual(refs(snap), ['default/t1', `${OTHER}/t1`])
    assert.equal(snap.sessions.find((s) => s.runtime_ref === `${OTHER}/t1`).fields.deskLabel, 'Deskapp')
  } finally { await G.close() }
})

test('자동 값의 코어 프로필: 모양이 틀린 항목·값은 그것만 버린다. 코어의 웹 주소는 브라우저 기본값(whosup-open-url-core:<코어>)으로 내려간다', () => {
  reset()
  setAutoValues({ values: { 'open_url:main': 'http://127.0.0.1:48001/?pane={pane}' }, reasons: {}, cores: [
    { name: OTHER, socket: SOCK_B, app: 'Deskapp', url: 'http://127.0.0.1:48002/?pane={pane}', focus: false, spaces: { [APP_SPACE]: 'Team room', bad: 7 } },
    { name: 'full', focus: true },
    { name: 'bad/name', app: 'X' }, { name: OTHER, app: 'Twice' }, null, 'text', { app: 'NoName' },
    { name: 'odd', app: 'Bad"App', url: 5, focus: 'yes', spaces: ['x'] },
    { name: 'plain', app: 'Plain' },
    // 코어 이름은 상태 폴더 아래의 폴더 이름이 된다: '.' 과 '..' 은 받지 않는다. 80자를 넘는 이름도 받지 않는다
    { name: '.', app: 'Dot' }, { name: '..', app: 'DotDot' }, { name: 'x'.repeat(81) }, { name: 7 },
    { name: '...' }, { name: '.hidden' },
  ] })
  // focus 는 셋을 구분한다: true(있다) · false(없다) · null(적지 않았다 — true·false 가 아닌 값도 적지 않은 것으로 읽는다)
  assert.deepEqual(autoCores(), [
    { name: OTHER, socket: SOCK_B, app: 'Deskapp', url: 'http://127.0.0.1:48002/?pane={pane}', focus: false, spaces: { [APP_SPACE]: 'Team room' } },
    { name: 'full', socket: null, app: null, url: null, focus: true, spaces: {} },
    { name: 'odd', socket: null, app: null, url: null, focus: null, spaces: {} },
    { name: 'plain', socket: null, app: 'Plain', url: null, focus: null, spaces: {} },
    { name: '...', socket: null, app: null, url: null, focus: null, spaces: {} },
    { name: '.hidden', socket: null, app: null, url: null, focus: null, spaces: {} },
  ])
  const d = clientDefaults(openDb(':memory:'))
  assert.equal(d[`whosup-open-url-core:${OTHER}`], 'http://127.0.0.1:48002/?pane={pane}')
  assert.equal(d['whosup-open-url:main'], 'http://127.0.0.1:48001/?pane={pane}')
  assert.equal(d['whosup-open-url-on'], 'off')               // 주소가 있어도 기본은 터미널 창(사람이 고를 때만 웹)
  setAutoValues({ values: {}, cores: 'nope' }); assert.deepEqual(autoCores(), [])
  setAutoValues(null); assert.deepEqual(autoCores(), [])
})

test('웹 주소: herdr-core 세션은 데스크에 적어 둔 주소가 먼저, 없으면 그 코어의 주소. 다른 코어의 주소나 herdr 기본 주소로 넘어가지 않는다', () => {
  const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
  const chunk = html.slice(html.indexOf('/*weburl*/'), html.indexOf('/*/weburl*/'))
  const { openUrlOf, clickModeOf, clickPlanOf } = new Function(`${chunk}; return { openUrlOf, clickModeOf, clickPlanOf }`)()
  const store = (o) => (k) => (k in o ? o[k] : null)
  const card = (name, t, desk) => ({ runtime: 'herdr-core', ref: `${name}/${t}`, desk, desk_label: 'x', pane: t, caps: ['focus', 'web'] })
  const mine = card(OTHER, 't1', DESK_B)
  const CORE_URL = 'http://127.0.0.1:48002/?pane={pane}'
  assert.equal(openUrlOf(mine, store({ [`whosup-open-url-core:${OTHER}`]: CORE_URL })), 'http://127.0.0.1:48002/?pane=t1')
  assert.equal(openUrlOf(mine, store({ [`whosup-open-url-core:${OTHER}`]: CORE_URL, [`whosup-open-url:${DESK_B}`]: 'http://10.0.0.5:48003/t/{pane}' })), 'http://10.0.0.5:48003/t/t1')
  // 데스크에 적은 주소의 꼴이 틀렸으면 그 데스크는 웹으로 열지 않는다(코어 주소로 넘어가지 않는다 — 기존 규칙)
  assert.equal(openUrlOf(mine, store({ [`whosup-open-url-core:${OTHER}`]: CORE_URL, [`whosup-open-url:${DESK_B}`]: 'nope' })), '')
  assert.equal(openUrlOf(card('default', 't1', 'core:spA'), store({ [`whosup-open-url-core:${OTHER}`]: CORE_URL, 'whosup-open-url': 'http://127.0.0.1:48001/?pane={pane}' })), '')
  assert.equal(openUrlOf(mine, store({ [`whosup-open-url-core:${OTHER}`]: CORE_URL, 'whosup-open-url-on': 'off' })), '')
  // 코어 주소만 있어도 "웹 터미널" 방식이 된다. 웹 터미널만 고른 브라우저는 창을 올리지 않는다
  const only = { [`whosup-open-url-core:${OTHER}`]: CORE_URL }
  assert.equal(clickModeOf(store(only), Object.keys(only)), 'both')
  const webOnly = { ...only, 'whosup-raise': 'off' }
  assert.deepEqual(clickPlanOf(mine, store(webOnly), Object.keys(webOnly)), { url: 'http://127.0.0.1:48002/?pane=t1', raise: false })
  // 화면 문구: 새 결과 코드가 한국어·영어 둘 다에 있다
  for (const code of ['focused_app_only', 'app_closed', 'app_raise_unsupported', 'app_raise_failed', 'core_unavailable', 'not_supported']) assert.equal(html.split(`, ${code}: `).length, 3, code)
})

test('상태: 코어가 알린 status를 그대로 쓴다. 알리지 않는 터미널은 "알 수 없음"으로 보이되 손 든 세션에 올리지 않고, 화면 읽기(폴더 신뢰 판정)는 하지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  const prog = (name) => ({ argv: [name], foreground: { argv: [name], cwd: '/work', name, pid: 71000 } })
  const TRUST = `${'─'.repeat(20)}\n Quick safety check: Is this a project you created or one you trust?\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel\n`
  A.add(term('t1', { labels: SPACE, ...prog('less') }))                    // 기본 코어: 셸도 에이전트도 아닌 프로그램 → 화면을 읽는다
  B.add(appTerm('t1', prog('herdr')))                                      // 다른 코어: 같은 꼴 → 읽지 않는다
  B.add(agentTerm('t2', 'blocked', { kind: 'question', msg: 'answer: go?', labels: APP_LABELS }))
  B.add(agentTerm('t3', 'done', { turn: 3, labels: APP_LABELS }))
  B.add(agentTerm('t4', 'done', { turn: 3, labels: { ...APP_LABELS, 'herdr.seen': '3' } }))   // 그 앱에서 이미 본 턴
  B.screens.set('t1', TRUST)                                               // 화면이 그 질문처럼 보여도 추측하지 않는다
  const db = openDb(':memory:')
  await collectAll(db); await collectAll(db)
  const status = (ref) => rowOf(db, ref).status
  assert.deepEqual([1, 2, 3, 4].map((n) => status(`${OTHER}/t${n}`)), ['unknown', 'blocked', 'done', 'idle'])
  assert.equal(B.calls.filter((c) => c.method === 'terminal.read' && c.params.lines === 0).length, 0)
  assert.ok(A.calls.some((c) => c.method === 'terminal.read' && c.params.terminal === 't1' && c.params.lines === 0))
  const b = await computeBoardAsync(db)
  const raised = [...b.columns.red, ...b.columns.yellow].map((c) => c.ref).sort()
  assert.deepEqual(raised, [`${OTHER}/t2`, `${OTHER}/t3`])                 // 알 수 없음(t1)은 손 든 세션·다음에 볼 세션에 없다
  assert.deepEqual(b.order.length, 2)
  assert.equal(cardsOf(b).find((c) => c.ref === `${OTHER}/t1`).status, 'unknown')
})

test('변화 알림: 읽는 코어마다 구독한다 — 어느 코어의 변화든 바로 수집하게 한다', async () => {
  reset()
  process.env.WHOSUP_CORES = OTHER
  process.env.WHOSUP_NO_EVENTS = ''
  A.add(agentTerm('t1', 'working', { labels: SPACE }))
  B.add(agentTerm('t1', 'working', { labels: APP_LABELS }))
  let kicks = 0
  try {
    core.watchEvents(() => { kicks += 1 })
    await sleep(80)
    assert.deepEqual([A, B].map((f) => f.calls.filter((c) => c.method === 'events.subscribe').length), [1, 1])
    B.set('t1', { status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'answer: go?' }, turn: 1 })
    await sleep(80)
    assert.ok(kicks >= 1, '다른 코어의 변화')
    kicks = 0
    A.set('t1', { status: { app: 'claude-code', state: 'done' }, turn: 1 })
    await sleep(80)
    assert.ok(kicks >= 1, '기본 코어의 변화')
    core.watchEvents(() => {}); await sleep(30)             // 다시 불러도 구독이 늘지 않는다
    assert.deepEqual([A, B].map((f) => f.calls.filter((c) => c.method === 'events.subscribe').length), [1, 1])
  } finally { core.stopWatching(); process.env.WHOSUP_NO_EVENTS = '1' }
})

const FULL_CAPS = ['focus', 'close', 'resume', 'new', 'toggle', 'web']
const VIEW_CAPS = ['focus', 'web']
// 자기 서버로 보여 주는 앱의 코어인데 그 앱이 꺼져 있다(프로필에 웹 주소가 없다): 보기에 더해 닫기만 된다(코어 소켓으로 직접)
const OFF_CAPS = ['focus', 'close', 'web']

test('앱 안의 세션으로 보낼 수단이 없는 코어가 꺼진 뒤 그 세션을 누르면: 오류가 아니라 "앱이 꺼져 있다"로 답하고, 소켓 경로를 화면에 내보내지 않는다', async () => {
  reset()
  setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp' }] })
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  const [idA, idB] = [idOf(db, 'default/t1'), idOf(db, `${OTHER}/t1`)]
  const asked = []
  core._setWindowOps({ appRunning: async (app) => { asked.push(app); return true }, raiseApp: async (app) => { asked.push(app); return 'raised' }, openWindowRunning: async () => { asked.push('open'); return 'opened' } })
  const noPath = (data) => assert.ok(!JSON.stringify(data).includes(dir) && !/\.sock/.test(JSON.stringify(data)), JSON.stringify(data))
  await B.close()                                           // 그 앱을 껐다: 코어의 소켓이 사라진다
  try {
    await withServer(db, async ({ post }) => {
      const shut = async (body) => {
        const r = await post('/api/open', { id: idB, seq: seq(), ...body })
        assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.window], [200, true, 'app_closed', 'app_closed'])
        noPath(r.data)
        return r.data
      }
      // 소켓 파일이 없다(ENOENT): 창을 올리는 클릭도, 올리지 않는 클릭도 같은 답이다
      assert.equal((await shut({ raise: true })).app, 'Deskapp')
      await shut({ raise: false }); await shut({ raise: false, web: true })
      // 소켓 자리에 소켓이 아닌 파일만 남았다(ENOTSOCK) — 윈도우의 named pipe에는 그런 파일이 없다
      if (process.platform !== 'win32') { writeFileSync(SOCK_B, 'not a socket'); await shut({ raise: true }) }
      // "늘 터미널 창에서"를 골랐어도, 앱 이름을 모르는 코어여도(프로필 없이 WHOSUP_CORES 로 읽는 코어) 같은 코드다
      core.setOpenIn('terminal'); await shut({ raise: true }); core.setOpenIn('app')
      setAutoValues(null); process.env.WHOSUP_CORES = OTHER
      const anon = await shut({ raise: true })
      assert.equal(anon.app, null)
      // 앱 이름을 모르는 코어: 켤 "앱"을 알지 못하므로 앱이 아니라 코어가 꺼져 있다고 답한다(R-4)
      assert.match(anon.message, /^the herdr-core core of that session is not running/)
      assert.doesNotMatch(anon.message, /\bapp\b/)
    })
    // 아무 창도 건드리지 않았고(앱을 켜지도, 터미널 창을 열지도 않았다), 세션은 닫힘으로 가지 않았다
    assert.deepEqual(asked, [])
    assert.deepEqual([rowOf(db, `${OTHER}/t1`).archived, rowOf(db, `${OTHER}/t1`).status], [0, 'done'])
    assert.deepEqual(A.touched(), [])
  } finally { B = await startNamedCore(STATE, OTHER, SOCK_B) }

  // herdr-app 이 다루는 코어(기본 코어)가 꺼졌을 때는 예전처럼 오류로 답하지만, 그 문구에도 소켓 경로는 없다
  await A.close()
  try {
    await withServer(db, async ({ post }) => {
      const r = await post('/api/open', { id: idA, seq: seq() })
      assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.message], [500, false, 'herdr_error', 'herdr-core is not running'])
      noPath(r.data)
    })
    await assert.rejects(core.readScreen('default/t1'), (e) => e.code === 'ENOENT' && e.message === 'herdr-core is not running')
  } finally { A = await startNamedCore(STATE, 'default', SOCK_A) }
})

test('기본 코어는 프로필에 focus:false 가 분명히 적혔을 때만 보기 전용이다. 적지 않으면 예전처럼 다 된다. 그 밖의 코어는 focus:true 일 때만 다 된다', async () => {
  reset()
  // 자동 감지가 기본 코어의 프로필을 실었는데 focus 한 줄이 빠졌다: Herdr 앱 코어의 닫기·새 세션이 사라지면 안 된다
  setAutoValues({ cores: [{ name: 'default', app: 'Herdr' }, { name: OTHER, app: 'Deskapp' }] })
  A.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: WORK }))
  B.add(agentTerm('t1', 'idle', { labels: APP_LABELS, cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const caps = () => [capsOf(rowOf(db, 'default/t1')), capsOf(rowOf(db, `${OTHER}/t1`))]
  assert.deepEqual(caps(), [FULL_CAPS, VIEW_CAPS])
  assert.deepEqual(cardsOf(await computeBoardAsync(db)).map((c) => [c.ref, c.caps]).sort(), [['default/t1', FULL_CAPS], [`${OTHER}/t1`, VIEW_CAPS]])
  // 기본 코어의 조작은 예전처럼 herdr-app 으로 간다(이동·닫기)
  writeFileSync(LOG, '')
  await openSession(db, idOf(db, 'default/t1'), seq(), { raise: false })
  assert.deepEqual(doCalls(), [['pane.focus', { terminal: 't1' }]])
  assert.deepEqual((await core.targets([])).map((t) => t.key), ['core:spA'])
  // focus 에 적힌 값별로: [기본 코어의 focus, 다른 코어의 focus] → [기본 코어의 caps, 다른 코어의 caps]
  for (const [fa, fb, wantA, wantB] of [
    [true, true, FULL_CAPS, FULL_CAPS], [false, false, OFF_CAPS, OFF_CAPS], [false, true, OFF_CAPS, FULL_CAPS],
    [undefined, undefined, FULL_CAPS, VIEW_CAPS], [null, null, FULL_CAPS, VIEW_CAPS], ['no', 0, FULL_CAPS, VIEW_CAPS],
  ]) {
    setAutoValues({ cores: [{ name: 'default', app: 'Herdr', focus: fa }, { name: OTHER, app: 'Deskapp', focus: fb }] })
    assert.deepEqual(caps(), [wantA, wantB], `focus ${String(fa)} / ${String(fb)}`)
  }
  // 분명히 focus:false 라고 적힌 기본 코어: herdr-app 에 그 코어의 주소를 넘기지 않고, 데스크 끄기를 거절한다.
  // 새 세션은 그 코어를 보여 주는 앱의 서버가 있어야 한다: 없으면 앱을 켜야 한다고 거절한다(herdr-app 의 새 탭으로 돌아가지 않는다)
  setAutoValues({ cores: [{ name: 'default', app: 'Herdr', focus: false }] })
  writeFileSync(LOG, '')
  await openSession(db, idOf(db, 'default/t1'), seq(), { raise: false })
  await assert.rejects(core.stopSession('core:spA'), (e) => e.code === 'not_supported')
  await assert.rejects(core.newSession({ session: 'core:spA', cwd: WORK, command: 'claude', raise: false }), (e) => e.code === 'app_required' && e.app === 'Herdr')
  assert.deepEqual([appCalls(), liveAddrs(A)], [[], ['t1']])
  // 닫기: 그 앱의 서버가 없으면(앱이 꺼져 있다) 기본 코어라도 이 코어의 소켓으로 직접 끝낸다 — herdr-app 의 pane 닫기로 가지 않는다.
  // 주소가 다른 터미널에 넘어갔으면 끝내지 않는다. (서버가 있을 때 서버로 가는 길은 test/ovis-app.test.mjs)
  await assert.rejects(core.closePane('default/t1', { incarnation: '1' }), (e) => e.code === 'terminal_not_found')
  A.calls.length = 0
  assert.deepEqual(await core.closePane('default/t1', { incarnation: String(A.terminals.get('t1').created_ms) }), { pane: 't1', means: 'core_socket' })
  assert.deepEqual([A.calls.map((x) => [x.method, x.params.terminal]), appCalls(), liveAddrs(A)], [[['terminal.get', 't1'], ['terminal.get', 't1'], ['terminal.kill', 't1']], [], []])   // 확인 두 번: 처음, 끝내기 바로 전
})

test('앱 창을 올릴 때 쓰는 이름: 환경변수 HERDR_APP_NAME > 프로필의 app > 기본 이름. 다른 앱의 코어에는 그 환경변수를 쓰지 않는다', async () => {
  reset()
  const raised = []
  core._setWindowOps({ raiseApp: async (app) => { raised.push(app); return 'raised' }, appRunning: async () => true, openWindowRunning: async () => 'opened' })
  process.env.WHOSUP_CORES = OTHER
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'idle', { labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  const [idA, idB] = [idOf(db, 'default/t1'), idOf(db, `${OTHER}/t1`)]
  const open = async (id) => { raised.length = 0; const r = await openSession(db, id, seq()); return [r.code, ...raised] }
  try {
    // 프로필도 환경변수도 없다: 기본 이름
    assert.deepEqual(await open(idA), ['focused', 'Herdr'])
    // 자동 감지가 알려 준 앱 이름
    delete process.env.WHOSUP_CORES
    setAutoValues({ cores: [{ name: 'default', app: 'Brandy' }, { name: OTHER, app: 'Deskapp' }] })
    assert.deepEqual(await open(idA), ['focused', 'Brandy'])
    // 사람이 환경변수로 정한 이름은 자동 감지가 덮지 못한다
    process.env.HERDR_APP_NAME = 'Chosen'
    assert.deepEqual(await open(idA), ['focused', 'Chosen'])
    // 자기 코어를 띄우는 다른 앱의 창은 그 코어의 프로필이 알려 준 이름으로만 올린다(HERDR_APP_NAME 은 Herdr 앱의 이름이다)
    assert.deepEqual(await open(idB), ['focused_app_only', 'Deskapp'])
  } finally { delete process.env.HERDR_APP_NAME }
})

test('소켓 고르기: core.lock 이 적어 둔 소켓이 먼저다. 프로필의 socket 은 core.lock 이 없거나 그 소켓이 없을 때만 쓴다', async () => {
  reset()
  const G = await startNamedCore(STATE, 'gamma', join(dir, 'g.sock'))
  const X = await startFakeCore(join(dir, 'x2.sock'))         // 자동 감지가 예전에 보고 적어 둔 소켓(지금은 다른 코어가 쓴다)
  let gUp = true
  try {
    A.add(term('t1')); G.add(term('t1')); X.add(term('t9'))
    const read = async () => refs(await core.listSnapshotAsync())
    setAutoValues({ cores: [{ name: 'gamma', socket: X.path }] })
    // 둘 다 살아 있고 서로 다르다: 코어가 지금 적어 둔 core.lock 을 따른다
    assert.deepEqual(await read(), ['default/t1', 'gamma/t1'])
    assert.equal(X.calls.length, 0)
    // core.lock 의 소켓이 없어졌다(그 코어는 꺼졌다): 그때는 프로필의 socket 을 쓴다
    await G.close(); gUp = false
    assert.deepEqual(await read(), ['default/t1', 'gamma/t9'])
    // core.lock 이 아예 없는 코어: 프로필의 socket
    setAutoValues({ cores: [{ name: 'lockless', socket: X.path }] })
    assert.deepEqual(await read(), ['default/t1', 'lockless/t9'])
    // 둘 다 없으면 꺼진 코어다(오류가 아니다)
    setAutoValues({ cores: [{ name: 'gamma', socket: join(dir, 'nowhere.sock') }] })
    assert.deepEqual(await read(), ['default/t1'])
  } finally { if (gUp) await G.close(); await X.close() }
})

test('답하지 않는 코어: 처음 한 번만 끝까지 기다리고, 그때부터 한동안(횟수가 아니라 시간)은 짧게만 기다린다. 답하면 원래대로 돌아간다. 코어끼리는 서로 기다리지 않는다 (R-3)', async () => {
  reset()
  const G = await startNamedCore(STATE, 'gamma', join(dir, 'g.sock'))
  try {
    // 실제 값(5초·1초·30초)을 줄여서 본다. 끝까지 기다린 수집은 FULL 이상이고, 코어 둘을 차례로 기다렸다면 2×FULL 이상이다 — 위 한계는 그 사이에
    // 느린 기계의 덧시간을 넣을 만큼 둔다(FULL 600·한계 1100일 때 윈도우 CI가 1121ms로 넘었다).
    const FULL = 1000
    const fullWait = (ms) => ms >= FULL - 50 && ms < FULL * 1.7
    core._setListWait({ full: FULL, short: 100, shortFor: 1500 })
    process.env.WHOSUP_CORES = `${OTHER},gamma`
    A.add(term('t1', { labels: SPACE })); B.add(term('t1', { labels: APP_LABELS })); G.add(term('t1'))
    const db = openDb(':memory:'); await collectAll(db)
    const hang = (method) => (method === 'terminal.list' ? false : undefined)   // 목록 요청에 답하지 않는다
    const timed = async () => { const t0 = performance.now(); const r = await collectAll(db); return [performance.now() - t0, r] }
    const held = (ref) => rowOf(db, ref).unreachable
    const NO_REPLY = [`herdr-core (${OTHER}): herdr-core terminal.list: no reply`, 'herdr-core (gamma): herdr-core terminal.list: no reply']

    // 두 코어가 함께 멈췄다: 한 번의 수집은 한 코어 몫(full)만 기다린다 — 코어마다 차례로 기다리지 않는다
    B.override = hang; G.override = hang
    A.add(term('t2', { labels: SPACE }))
    let [ms, r] = await timed()
    const since = performance.now()                           // 답하지 않은 때: 여기서부터 shortFor 동안 짧게 묻는다
    assert.ok(fullWait(ms), `처음: ${ms}ms`)
    assert.deepEqual([...r.notes].sort(), [...NO_REPLY].sort())
    assert.equal(r.failure, null)
    // 답한 코어의 세션은 그 수집에서 그대로 따라온다. 답하지 않은 코어의 세션만 확인 불가다
    assert.ok(rowOf(db, 'default/t2'))
    assert.deepEqual([held('default/t1'), held(`${OTHER}/t1`), held('gamma/t1')], [0, 1, 1])
    // 그 시간 안에서는 몇 번을 물어도 짧게만 기다린다(횟수로 세지 않는다 — 예전 규칙이면 두세 번 만에 다시 끝까지 기다렸다)
    let shorts = 0
    while (performance.now() - since < 900) { [ms, r] = await timed(); shorts += 1; assert.ok(ms >= 80 && ms < 450, `짧게 ${shorts}: ${ms}ms`); assert.equal(r.notes.length, 2) }
    assert.ok(shorts >= 4, `짧게 물은 횟수 ${shorts}`)
    // 그 시간이 지났다: 원래 시간으로 한 번 다시 묻는다(느리지만 살아 있는 코어를 놓치지 않게) — 또 답이 없으면 다시 짧게
    await sleep(Math.max(0, 1560 - (performance.now() - since)))
    ;[ms] = await timed()
    assert.ok(fullWait(ms), `다시 끝까지: ${ms}ms`)
    ;[ms] = await timed()
    assert.ok(ms >= 80 && ms < 450, `다시 짧게: ${ms}ms`)
    // 한 코어가 답했다: 그 코어의 세션은 곧바로 돌아오고, 그 코어는 원래 시간으로 돌아간다
    B.override = null
    ;[ms, r] = await timed()
    assert.ok(ms < 450, `한쪽이 답함: ${ms}ms`)
    assert.deepEqual(r.notes, [NO_REPLY[1]])
    assert.deepEqual([held(`${OTHER}/t1`), held('gamma/t1')], [0, 1])
    G.override = null
    ;[ms, r] = await timed()
    assert.ok(ms < 450, `둘 다 답함: ${ms}ms`)
    assert.deepEqual([r.notes, held('gamma/t1')], [[], 0])
    // 원래대로 돌아갔다: 다시 멈추면 처음처럼 끝까지 한 번 기다린다
    B.override = hang
    ;[ms] = await timed()
    assert.ok(fullWait(ms), `돌아온 뒤 다시 멈춤: ${ms}ms`)
    B.override = null
    await collectAll(db)                                      // 답했다: 다음 시험은 원래 시간으로 시작한다
    assert.equal(held(`${OTHER}/t1`), 0)
  } finally { core._setListWait(LIST_WAIT); B.override = null; await G.close() }
})

test('한 번 늦은 뒤로 느리게만 답하는 코어(기본 코어): 짧게 묻는 시간이 다 가기를 기다리지 않고 곧 다시 읽힌다. 늦게 온 목록 자체는 쓰지 않는다 (R-3)', async () => {
  reset()
  try {
    core._setListWait({ full: 600, short: 100, shortFor: 60000 })   // 짧게 묻는 시간은 이 시험보다 훨씬 길다
    A.add(agentTerm('t1', 'working', { labels: SPACE }))
    const db = openDb(':memory:'); await collectAll(db)
    const row = () => { const x = rowOf(db, 'default/t1'); return [x.status, x.unreachable, x.archived] }
    const timed = async () => { const t0 = performance.now(); const r = await collectAll(db); return [performance.now() - t0, r] }
    // 코어가 한 번 답하지 않았다(끝까지 기다렸다): 그 세션은 확인 불가가 된다 — 직전 목록을 지금 것처럼 다시 쓰지 않는다
    A.override = (m) => (m === 'terminal.list' ? false : undefined)
    let [ms] = await timed()
    assert.ok(ms >= 550, `처음: ${ms}ms`)
    assert.deepEqual(row(), ['working', 1, 0])
    // 그 뒤로 코어는 살아 있지만 느리다: 목록에 250ms 만에 답한다(short 보다 늦고 full 보다 빠르다)
    let asked = 0
    A.override = (m, p, sock) => {
      if (m !== 'terminal.list') return undefined
      asked += 1
      const reply = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { hidden_finished: 0, terminals: [...A.terminals.values()].filter((x) => x.state === 'live').map((x) => ({ ...x })) } })
      setTimeout(() => { if (!sock.destroyed) sock.write(`${reply}\n`) }, 250)
      return false
    }
    // 다음 수집은 짧게만 기다리고 넘어간다(수집이 붙잡히지 않는다). 그 수집의 요청에는 늦게 답이 온다
    ;[ms] = await timed()
    assert.ok(ms >= 80 && ms < 240, `짧게: ${ms}ms`)
    assert.deepEqual(row(), ['working', 1, 0])
    A.set('t1', { status: { app: 'claude-code', state: 'blocked', kind: 'question', msg: 'answer: go?' } })   // 늦은 답이 떠난 뒤의 변화
    await sleep(300)                                          // 늦은 답이 도착했다: 그 코어는 느릴 뿐 살아 있다
    assert.deepEqual(row(), ['working', 1, 0])                // 늦게 온 목록은 판에 적용하지 않는다(그 수집은 이미 지나갔다)
    // 그다음 수집은 원래 시간으로 기다려 그 코어를 읽는다: 확인 불가가 풀리고 지금 상태가 보인다
    ;[ms] = await timed()
    assert.ok(ms >= 200 && ms < 550, `원래 시간으로 기다려 읽음: ${ms}ms`)
    assert.deepEqual(row(), ['blocked', 0, 0])
    assert.equal(asked, 2)
    // 계속 느려도 계속 읽힌다(짧게 묻기로 돌아가지 않는다)
    ;[ms] = await timed()
    assert.ok(ms >= 200 && ms < 550, `또 읽음: ${ms}ms`)
    assert.deepEqual(row(), ['blocked', 0, 0])
  } finally { core._setListWait(LIST_WAIT); A.override = null }
})

test("코어 이름으로 '.' 과 '..' 은 받지 않는다: 상태 폴더 한 단계 위의 core.lock 을 읽지 않는다", async () => {
  reset()
  A.add(term('t1')); B.add(term('t1'))
  // 이름이 '..' 이면 <상태 폴더>/herdr-core/../core.lock, '.' 이면 <상태 폴더>/herdr-core/./core.lock 을 읽게 된다: 그 자리에 살아 있는 소켓을 적어 둔다
  writeFileSync(join(STATE, 'core.lock'), `${SOCK_B}\n`)
  writeFileSync(join(STATE, 'herdr-core', 'core.lock'), `${SOCK_B}\n`)
  const read = async () => refs(await core.listSnapshotAsync())
  for (const want of ['..', '.', '.. , .']) {
    process.env.WHOSUP_CORES = want
    assert.deepEqual(await read(), ['default/t1'], want)
  }
  delete process.env.WHOSUP_CORES
  setAutoValues({ cores: [{ name: '..', socket: SOCK_B }, { name: '.', socket: SOCK_B }] })
  assert.deepEqual(await read(), ['default/t1'])
  assert.equal(B.calls.length, 0)                             // 그 소켓에는 한 번도 묻지 않았다
  // 점이 들어간 보통 이름은 그대로 받는다
  setAutoValues(null)
  process.env.WHOSUP_CORES = `.. , ${OTHER}`
  assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
  assert.equal(core.isDesk(`core:${OTHER}@sp1`), true)
  await assert.rejects(core.stopSession('core:..@sp1'), (e) => e.code === 'bad_session')
})

test('읽을 코어 계산은 끊기지 않는 한 번의 계산(판 계산이 세션마다 묻는다) 안에서 한 번만 한다. 환경변수·자동 값이 바뀌면 그 자리에서 다시 계산한다', async () => {
  reset()
  let reads = 0
  // 자동 값의 cores 를 읽을 때마다 센다(읽을 코어를 계산할 때마다 한 번 읽는다)
  const auto = (list) => ({ values: {}, reasons: {}, get cores() { reads += 1; return list } })
  const row = (ref) => ({ runtime: 'herdr-core', runtime_ref: ref, fields_json: JSON.stringify({ desk: 'core:spA' }) })
  setAutoValues(auto([{ name: OTHER, app: 'Deskapp' }]))
  for (let i = 0; i < 60; i++) {
    assert.deepEqual(capsOf(row('default/t1')), FULL_CAPS)
    assert.deepEqual(capsOf(row(`${OTHER}/t${i}`)), VIEW_CAPS)
  }
  assert.equal(reads, 1)                                      // 세션 120개를 물어도 계산은 한 번
  // 그 계산이 끝나면 잊는다: 다음 계산(다음 수집·다음 요청)은 새로 본다
  await sleep(0)
  capsOf(row('default/t1')); capsOf(row('default/t2'))
  assert.equal(reads, 2)
  // 같은 계산 안에서도 자동 값이나 환경변수가 바뀌면 낡은 답을 주지 않는다
  setAutoValues(auto([{ name: OTHER, app: 'Deskapp', focus: true }]))
  assert.deepEqual(capsOf(row(`${OTHER}/t1`)), FULL_CAPS)
  process.env.WHOSUP_CORES = 'none'
  assert.deepEqual(capsOf(row(`${OTHER}/t1`)), VIEW_CAPS)     // 읽지 않는 코어의 세션
  delete process.env.WHOSUP_CORES
  assert.deepEqual(capsOf(row(`${OTHER}/t1`)), FULL_CAPS)
  process.env.HC_SESSION = OTHER
  try { assert.deepEqual(capsOf(row('default/t1')), VIEW_CAPS) } finally { delete process.env.HC_SESSION }
  assert.deepEqual(capsOf(row('default/t1')), FULL_CAPS)
})

test('HC_SESSION 도 코어 이름 규칙으로 본다: 규칙에 안 맞으면 무시하고 기본 이름을 쓴다. 이름만 준 코어의 소켓은 core.lock 에서만 찾는다(이름만 같은 프로필의 socket 을 쓰지 않는다) (P2-M3)', async () => {
  reset()
  A.add(term('t1', { labels: SPACE })); B.add(term('t1', { labels: APP_LABELS }))
  const read = async () => refs(await core.listSnapshotAsync())
  try {
    // 규칙에 안 맞는 이름('/' 가 들면 ref "a/b/t1" 이 코어 a 의 터미널 b/t1 로 읽힌다): 주지 않은 것으로 본다
    for (const bad of ['a/b', '../deskapp', '..', '.', 'sp ace', 'x'.repeat(81)]) {
      process.env.HC_SESSION = bad
      assert.deepEqual(await read(), ['default/t1'], bad)
      assert.equal(core.refOf('t9'), 'default/t9', bad)
      assert.equal(core.socketPath(), SOCK_A, bad)
    }
    // 무시한 값은 읽을 코어를 하나로 좁히지도 않는다(WHOSUP_CORES·자동 감지 목록이 그대로 통한다)
    process.env.HC_SESSION = 'a/b'; process.env.WHOSUP_CORES = OTHER
    assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
    delete process.env.WHOSUP_CORES
    // HC_SOCKET 과 함께 준 틀린 이름: 소켓은 사람이 준 그대로, 이름만 기본 이름
    process.env.HC_SOCKET = SOCK_B; A.calls.length = 0
    assert.deepEqual(await read(), ['default/t1'])
    assert.deepEqual([core.socketPath(), A.calls.length], [SOCK_B, 0])
    delete process.env.HC_SOCKET

    // 이름만 준 코어(HC_SOCKET 없음): 이름이 같은 자동 감지 프로필이 다른 소켓(살아 있는 다른 코어)을 적어 두었어도 core.lock 의 소켓만 쓴다
    process.env.HC_SESSION = OTHER
    setAutoValues({ cores: [{ name: OTHER, app: 'Deskapp', focus: false, socket: SOCK_A }] })
    A.calls.length = 0
    assert.deepEqual(await read(), [`${OTHER}/t1`])
    assert.deepEqual([core.socketPath(), A.calls.length], [SOCK_B, 0])
    // 프로필의 나머지 정보(앱 안의 세션으로 보낼 수단이 없다)는 그대로 쓴다
    assert.deepEqual(capsOf({ runtime: 'herdr-core', runtime_ref: `${OTHER}/t1`, fields_json: '{}' }), OFF_CAPS)
    // 그 코어가 꺼졌다(core.lock 의 소켓이 없다): 프로필의 socket 으로 넘어가지 않는다 — 다른 코어를 그 이름으로 읽지 않는다
    await B.close()
    try {
      assert.equal(core.socketPath(), SOCK_B)
      assert.equal((await core.snapshotRuntime()).absent, true)
      assert.equal(A.calls.length, 0)
    } finally { B = await startNamedCore(STATE, OTHER, SOCK_B) }
    // core.lock 이 아예 없는 이름: 프로필의 socket 을 쓰지 않는다(꺼진 코어로 본다)
    process.env.HC_SESSION = 'nolockcore'
    setAutoValues({ cores: [{ name: 'nolockcore', socket: SOCK_A }] })
    assert.equal(core.socketPath(), null)
    assert.equal((await core.snapshotRuntime()).absent, true)
    assert.equal(A.calls.length, 0)
  } finally { delete process.env.HC_SOCKET; delete process.env.HC_SESSION }
})

test('같은 소켓을 가리키는 코어 이름이 둘이면 첫 이름만 읽는다(세션이 두 번 올라오지 않는다). 소켓 경로는 풀어서 견주고, 한 줄 기록을 남긴다 (P2-M7)', async () => {
  reset()
  A.add(term('t1', { labels: SPACE })); B.add(term('t1', { labels: APP_LABELS }))
  const read = async () => refs(await core.listSnapshotAsync())
  const logs = []
  const realError = console.error
  console.error = (...a) => { logs.push(a.join(' ')) }
  try {
    // 1) 자동 감지 프로필이 기본 코어의 소켓을 다른 이름으로 알려 줬다: 기본 코어(첫 이름)로만 읽는다
    setAutoValues({ cores: [{ name: 'twin', socket: SOCK_A, app: 'Twin' }, { name: OTHER, app: 'Deskapp' }] })
    const db = openDb(':memory:')
    for (let i = 0; i < 4; i++) await collectAll(db)
    assert.deepEqual(db.prepare('SELECT runtime_ref FROM session ORDER BY runtime_ref').all().map((r) => r.runtime_ref), ['default/t1', `${OTHER}/t1`])
    assert.deepEqual(A.calls.filter((c) => c.method === 'terminal.list').length, 4)   // 한 번의 수집에 그 소켓은 한 번만 읽는다
    // 빠진 이름으로는 조작하지 않는다(그 이름의 세션은 읽지 않는 코어의 세션이다)
    await assert.rejects(core.focus('twin/t1', { raise: false }), (e) => e.code === 'core_unavailable')
    // 2) 심볼릭 링크로 달리 적힌 같은 소켓도 하나다(윈도우는 링크를 만들 권한이 없을 수 있어 건너뛴다)
    if (process.platform !== 'win32') {
      const link = join(dir, 'b-link.sock')
      symlinkSync(SOCK_B, link)
      setAutoValues({ cores: [{ name: OTHER }, { name: 'linked', socket: link }] })
      assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
    }
    // 3) WHOSUP_CORES 로 적은 두 이름의 core.lock 이 같은 소켓을 가리킨다: 먼저 적은 이름만 읽는다
    setAutoValues(null)
    mkdirSync(join(STATE, 'herdr-core', 'alias'), { recursive: true })
    writeFileSync(join(STATE, 'herdr-core', 'alias', 'core.lock'), `${SOCK_B}\n`)
    process.env.WHOSUP_CORES = `${OTHER}, alias`
    assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
    process.env.WHOSUP_CORES = `alias, ${OTHER}`
    assert.deepEqual(await read(), ['alias/t1', 'default/t1'])
    // 소켓이 서로 다른 코어는 예전 그대로 다 읽는다. 꺼진 코어끼리도 경로가 다르면 따로다
    process.env.WHOSUP_CORES = `${OTHER}, nosuchcore, alsonone`
    assert.deepEqual(await read(), ['default/t1', `${OTHER}/t1`])
    // 한 줄 기록: 겹친 이름마다 한 번만(수집마다 다시 적지 않는다)
    const noted = logs.filter((l) => /points at the same socket/.test(l))
    const want = [['twin', 'default'], ...(process.platform !== 'win32' ? [['linked', OTHER]] : []), ['alias', OTHER], [OTHER, 'alias']]
    assert.deepEqual(noted, want.map(([alias, first]) => `whosup: herdr-core "${alias}" points at the same socket as "${first}": its sessions are read once, as "${first}"`))
    assert.ok(noted.every((l) => !l.includes(dir)), '기록에 소켓 경로를 싣지 않는다')
  } finally { console.error = realError; try { writeFileSync(join(STATE, 'herdr-core', 'alias', 'core.lock'), '') } catch {} }   // 빈 core.lock = 소켓을 모르는 코어(뒤 시험에 섞이지 않게)
})

test('세션 누르기 요청에 "웹 터미널 탭을 실제로 열었는가"(web)가 실린다: 브라우저에만 저장한 데스크별 주소로 탭을 연 클릭도 본 것으로 적힌다 (R-2)', async () => {
  reset()
  process.env.WHOSUP_CORES = OTHER                            // 프로필 없는 코어: 서버는 이 코어의 웹 주소를 모른다
  A.add(agentTerm('t1', 'idle', { labels: SPACE }))
  B.add(agentTerm('t1', 'done', { turn: 2, labels: APP_LABELS }))
  const db = openDb(':memory:'); await collectAll(db)
  const card = cardsOf(await computeBoardAsync(db)).find((c) => c.ref === `${OTHER}/t1`)
  assert.equal(card.desk, DESK_B)
  // 화면(index.html)의 세션 누르기(openCard)와 클릭 판정(/*weburl*/)을 그대로 읽어, 요청만 이 시험의 서버로 보낸다
  const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
  const { clickPlanOf } = new Function(`${html.slice(html.indexOf('/*weburl*/'), html.indexOf('/*/weburl*/'))}; return { clickPlanOf }`)()
  const src = html.slice(html.indexOf('async function openCard(id) {'), html.indexOf('async function doAct('))
  assert.ok(src.startsWith('async function openCard(id) {') && src.length < 3000)
  const press = async (post, saved, { blocked = false } = {}) => {
    const sent = []
    const env = {
      CLIENT_ID: 'tab-1', can: () => true, denied: () => {}, cardById: () => card, toast: () => {}, refresh: () => {}, msgOf: () => '', T: { going: '', popupBlocked: '' }, board: { readonly: false }, openedTabs: new Map(),
      clickPlan: (c) => clickPlanOf(c, (k) => (k in saved ? saved[k] : null), Object.keys(saved)),
      openTab: () => (blocked ? { ok: false } : { ok: true, win: {}, fresh: true }),
      post: async (path, body) => { sent.push([path, body]); const r = await post(path, { ...body, seq: seq() }); return { ok: r.status === 200, data: r.data } },
    }
    await new Function(...Object.keys(env), `let clickN = 0; ${src}; return openCard`)(...Object.values(env))(card.id)
    assert.equal(sent.length, 1)
    assert.equal(sent[0][0], '/api/open')
    return sent[0][1]
  }
  const labelWrites = () => B.calls.filter((c) => c.method === 'terminal.label').length
  const seenLabel = () => B.terminals.get('t1').labels['whosup.seen']
  const unsee = () => { delete B.terminals.get('t1').labels['whosup.seen']; B.calls.length = 0 }
  const DESK_URL = { [`whosup-open-url:${DESK_B}`]: 'http://127.0.0.1:48003/t/{pane}', 'whosup-raise': 'off' }   // 웹 터미널만(창 올리기 끔)
  await withServer(db, async ({ post }) => {
    B.calls.length = 0
    // 탭을 막았다(팝업 차단): 열지 못했다고 싣는다 — 본 것으로 적지 않는다
    const b0 = await press(post, DESK_URL, { blocked: true })
    assert.deepEqual([b0.web, b0.raise, labelWrites()], [false, false, 0])
    // 주소가 없다(터미널 창으로만): web 은 false, 창은 올린다. 앱 이름을 모르는 코어라 터미널 창 길로 가지만 창 올리기가 꺼진 시험 환경이다
    const b1 = await press(post, {})
    assert.deepEqual([b1.web, b1.raise], [false, true])
    unsee()
    // 이 브라우저에만 저장한 데스크별 주소로 탭을 열었다: web: true 가 실리고, 서버가 그 주소를 몰라도 본 것으로 적힌다
    const b2 = await press(post, DESK_URL)
    assert.deepEqual([b2.web, b2.raise, labelWrites(), seenLabel()], [true, false, 1, '2'])
  })
})

test('화면 문구: 앱 창을 올리지 못한 결과(app_raise_failed)가 한국어·영어에 있다. 앱 이름을 모르는 코어가 꺼져 있으면 앱이 아니라 코어가 꺼져 있다고 안내한다 (R-1·R-4·R-5)', () => {
  const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
  const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
  const { ko, en } = I18N
  // R-1: 새 결과 코드의 문구(앱은 떠 있지만 창을 앞으로 올리지 못했다 — 앱으로 직접 넘어가 달라)
  assert.equal(ko.codes.app_raise_failed({ app: 'Deskapp' }), 'Deskapp 창을 앞으로 올리지 못했습니다. 앱은 떠 있으니 그 앱으로 직접 넘어가 주세요')
  assert.equal(en.codes.app_raise_failed({ app: 'Deskapp' }), 'Deskapp is running, but its window could not be brought forward. Switch to the app yourself')
  // 조사를 골라 적는 표기('이(가)' 등)를 쓰지 않는다
  assert.equal(ko.codes.app_closed({ app: 'Deskapp' }), 'Deskapp 앱이 꺼져 있어 창을 올리지 않았습니다. 앱을 켠 뒤 다시 눌러 주세요')
  assert.equal(en.codes.app_closed({ app: 'Deskapp' }), 'Deskapp is not running, so no window was brought forward. Start the app and click again')
  for (const f of [ko.codes.app_closed, ko.codes.app_raise_failed, ko.codes.app_raise_unsupported, ko.codes.focused_app_only]) for (const d of [{ app: 'Deskapp' }, {}]) assert.doesNotMatch(f(d), /[이을은]\([가를는]\)|\(으\)로/)
  // R-4: 앱 이름이 없는 코어(프로필 없이 WHOSUP_CORES 로 읽는 herdr-core)가 꺼졌을 때 — "앱을 켠 뒤"라고 하지 않는다
  for (const d of [{}, { app: null }]) {
    assert.equal(ko.codes.app_closed(d), '이 세션의 herdr-core 코어가 꺼져 있어 창을 올리지 않았습니다. 코어를 켠 뒤 다시 눌러 주세요')
    assert.equal(en.codes.app_closed(d), 'the herdr-core core of this session is not running, so no window was brought forward. Start the core and click again')
    assert.doesNotMatch(ko.codes.app_closed(d), /앱/); assert.doesNotMatch(en.codes.app_closed(d), /\bapp\b/)
  }
  assert.ok(ko.codes.core_unavailable && en.codes.core_unavailable)
  // R-5: 설정의 "Herdr 앱 세션을 여는 곳" 설명이 자기 코어를 띄우는 다른 앱의 세션에 어떻게 적용되는지 말한다(두 언어, 설정 화면에 실린다)
  assert.match(ko.chCoreOther, /다른 앱의 세션에도 적용/); assert.match(en.chCoreOther, /other apps that run a core of their own/)
  assert.ok(html.includes('${T.chCoreHint} ${T.chCoreOther}'))
})
