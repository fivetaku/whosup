// 맥북에어 첫 설치 걷기(커밋 400dcd7)에서 나온 서버 쪽 고칠 것(U0·U2c).
//   U0  새 세션의 폴더를 ~/my-first-project 로 치면 no_folder — 서버가 앞의 "~"·"~/" 를 홈 폴더로 풀지 않았다(폴더 고르기·카드는 ~ 로 보여 준다).
//   U2c 탭으로만 보여 줄 수 있는 데스크에 새 세션·이어서 열기를 할 때 화면이 raise:false 를 보내면 /api/new·/api/resume 이 그 값을
//       런타임에 그대로 넘긴다(앱 창을 올리지 않는다). 값이 없으면 예전 그대로(올린다).
// 가짜 코어(소켓)와 가짜 herdr-app, 가짜 창 올리기(_setWindowOps)만 쓴다 — 실제 코어·앱·창은 건드리지 않는다. test/core-ops.test.mjs 와 같은 장치.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { startFakeCore, term, agentTerm } from '../test-support/fake-core.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wa-'))
const SOCK = join(dir, 'core.sock')
const LOG = join(dir, 'app.log')
process.env.HC_SOCKET = SOCK
process.env.HC_SESSION = 'whosuptest-air'
delete process.env.XDG_STATE_HOME
delete process.env.XDG_RUNTIME_DIR
process.env.HERDR_APP_BIN = fileURLToPath(new URL('../test-support/fake-herdr-app.mjs', import.meta.url))
chmodSync(process.env.HERDR_APP_BIN, 0o755)
process.env.FAKE_APP_LOG = LOG
process.env.HERDR_BIN = join(dir, 'no-herdr')
delete process.env.HERDR_BIN_PATH
process.env.WHOSUP_STATE_DIR = join(dir, 'state')
process.env.CLAUDE_PROJECTS_DIR = join(dir, 'claude', 'projects')
process.env.WHOSUP_NO_EVENTS = '1'
process.env.AGENT_CMD = 'claude'
delete process.env.WHOSUP_READONLY
mkdirSync(process.env.CLAUDE_PROJECTS_DIR, { recursive: true })

const core = await import('../src/runtime/core.mjs')
core._setShellWait({ maxMs: 0 })
;(await import('../src/runtime/ovis.mjs'))._setLookup({ registryDirs: () => [], userDataDirs: () => [] })
const { collectAll } = await import('../src/runtime/index.mjs')
const { createBoardServer, expandHome, _clearResumeHolds } = await import('../src/board/server.mjs')
const { openDb } = await import('../src/db.mjs')

const fake = await startFakeCore(SOCK)
after(async () => { await fake.close() })
const HOME = homedir()
// 홈 아래의 폴더(underHome 검사를 지나야 한다). 시험이 끝나도 빈 폴더 하나가 남는다 — 이름에 pid 를 붙여 서로 겹치지 않게.
const TILDE_NAME = `.whosup-test-tilde-${process.pid}`
const TILDE_DIR = join(HOME, TILDE_NAME)
mkdirSync(TILDE_DIR, { recursive: true })
after(() => { try { rmSync(TILDE_DIR, { recursive: true, force: true }) } catch {} })
const WORK = join(dir, 'work'); mkdirSync(WORK)
const WORK2 = join(dir, 'work2'); mkdirSync(WORK2)
const SPACE = { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }
const SID = '11111111-1111-4111-8111-111111111111'
const SID2 = '22222222-2222-4222-8222-222222222222'
const idOf = (db, t) => db.prepare('SELECT id FROM session WHERE runtime_ref = ? ORDER BY id DESC').get(`whosuptest-air/${t}`).id
const transcript = (sid, cwd) => { const d = join(process.env.CLAUDE_PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'hello' } })}\n`) }
const runs = () => fake.calls.filter((c) => c.method === 'terminal.run').map((c) => c.params.cwd)
// 창 올리기는 가짜: 불린 기록만 남긴다. raise:false 면 아예 불리지 않아야 한다.
const raised = []
const reset = () => { fake.override = null; fake.terminals.clear(); fake.calls.length = 0; writeFileSync(LOG, ''); delete process.env.FAKE_APP_MODE; raised.length = 0; _clearResumeHolds(); core.setOpenIn('app'); core._setWindowOps({ raiseApp: async (name) => { raised.push(name); return 'raised' }, openWindowRunning: async () => 'opened', appRunning: async () => true }) }

// post 는 raise 를 스스로 넣지 않는다: "값이 없을 때"를 그대로 시험한다
async function withServer(db, fn) {
  const server = createBoardServer(db)
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port
  const post = async (path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return { status: r.status, data: await r.json() } }
  try { await fn({ post }) } finally { await new Promise((r) => server.close(r)) }
}

test('U0 expandHome: 앞의 "~"·"~/" 만 홈 폴더로 푼다. ~user·가운데의 ~·문자열 아닌 값은 그대로', () => {
  assert.equal(expandHome('~'), HOME)
  assert.equal(expandHome('~/'), join(HOME, ''))
  assert.equal(expandHome('~/my-first-project'), join(HOME, 'my-first-project'))
  assert.equal(expandHome('~/a/b'), join(HOME, 'a', 'b'))
  for (const same of ['~someone/x', '/tmp/~/x', 'x~/y', '', '/abs/path']) assert.equal(expandHome(same), same, same)
  for (const notStr of [undefined, null, 7, {}]) assert.equal(expandHome(notStr), notStr)
})

test('U0 /api/new: "~/폴더" 로 친 경로는 홈 아래 그 폴더로 열린다(no_folder 가 아니다). 없는 폴더는 풀어도 no_folder, "~" 는 홈 자체', async () => {
  reset()
  fake.add(agentTerm('t1', 'idle', { labels: SPACE }))
  const db = openDb(':memory:'); await collectAll(db)
  await withServer(db, async ({ post }) => {
    const r = await post('/api/new', { session: 'core:spA', cwd: `~/${TILDE_NAME}`, raise: false })
    assert.deepEqual([r.status, r.data.ok, r.data.code], [200, true, 'opened_new'], JSON.stringify(r.data))
    assert.ok(runs().includes(TILDE_DIR), `런타임에는 풀린 절대 경로가 간다: ${JSON.stringify(runs())}`)
    assert.ok(!runs().some((c) => String(c).startsWith('~')), '~ 가 그대로 가지 않는다')
    assert.match(r.data.message, new RegExp(`opened ${TILDE_NAME.replace(/\./g, '\\.')}`))
    const none = await post('/api/new', { session: 'core:spA', cwd: `~/${TILDE_NAME}/does-not-exist`, raise: false })
    assert.deepEqual([none.status, none.data.code], [400, 'no_folder'])
    assert.match(none.data.message, /does-not-exist/)
    assert.doesNotMatch(none.data.message, /~/, '안내 문구도 풀린 경로로')
    const home = await post('/api/new', { session: 'core:spA', cwd: '~', raise: false })
    assert.deepEqual([home.status, home.data.code], [200, 'opened_new'])
    assert.ok(runs().includes(HOME))
    // 홈 밖으로 나가는 것은 풀어도 막힌다
    const out = await post('/api/new', { session: 'core:spA', cwd: '~/../..', raise: false })
    assert.deepEqual([out.status, out.data.code], [400, 'bad_folder'])
    // 상대 경로는 서버의 작업 폴더에 따라 달라지므로 받지 않는다
    const rel = await post('/api/new', { session: 'core:spA', cwd: TILDE_NAME, raise: false })
    assert.deepEqual([rel.status, rel.data.code], [400, 'bad_folder'])
  })
})

test('U2c /api/new: raise:false 를 보내면 런타임에 그대로 넘겨 앱 창을 올리지 않는다(window skipped). 값이 없으면 예전 그대로 올린다', async () => {
  reset()
  fake.add(agentTerm('t1', 'idle', { labels: SPACE }))
  const db = openDb(':memory:'); await collectAll(db)
  await withServer(db, async ({ post }) => {
    // /api/new 는 홈 아래 폴더만 받는다(underHome) — 홈 아래에 만든 시험 폴더로
    const quiet = await post('/api/new', { session: 'core:spA', cwd: TILDE_DIR, raise: false })
    // 답에는 window 가 실리지 않는다(opened_new 는 viaOf 만 싣는다) — 창 올리기를 불렀는지(raised)로 가린다
    assert.deepEqual([quiet.status, quiet.data.code], [200, 'opened_new'], JSON.stringify(quiet.data))
    assert.deepEqual(raised, [], '창 올리기를 부르지 않았다')
    const loud = await post('/api/new', { session: 'core:spA', cwd: TILDE_DIR })
    assert.deepEqual([loud.status, loud.data.code], [200, 'opened_new'])
    assert.deepEqual(raised, ['Herdr'], '값이 없으면 올린다')
    raised.length = 0
    const explicit = await post('/api/new', { session: 'core:spA', cwd: TILDE_DIR, raise: true })
    assert.deepEqual([explicit.data.code, raised], ['opened_new', ['Herdr']])
  })
})

test('U2c /api/resume(닫힌 세션 다시 열기): raise:false 면 새 탭을 열되 앱 창을 올리지 않는다. 값이 없으면 올린다', async () => {
  reset()
  transcript(SID, WORK); transcript(SID2, WORK2)
  fake.add(agentTerm('t2', 'idle', { labels: SPACE }))   // 공간이 남아 있게
  fake.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: WORK, argv: ['zsh', '-ic', `claude --resume ${SID}`] }))
  fake.add(agentTerm('t5', 'idle', { labels: SPACE, cwd: WORK2, argv: ['zsh', '-ic', `claude --resume ${SID2}`] }))
  const db = openDb(':memory:'); await collectAll(db)
  const id1 = idOf(db, 't1'), id5 = idOf(db, 't5')
  fake.terminals.get('t1').state = 'finished'; fake.terminals.get('t5').state = 'finished'
  for (let i = 0; i < 3; i++) await collectAll(db)
  assert.equal(db.prepare('SELECT status FROM session WHERE id = ?').get(id1).status, 'gone')
  await withServer(db, async ({ post }) => {
    const quiet = await post('/api/resume', { id: id1, raise: false })
    assert.deepEqual([quiet.status, quiet.data.ok, quiet.data.code], [200, true, 'resumed'], JSON.stringify(quiet.data))
    assert.deepEqual(raised, [], '창 올리기를 부르지 않았다')
    assert.ok(fake.sent().some(([, text]) => text === `claude --resume ${SID}`), '대화는 이어 열었다')
    const loud = await post('/api/resume', { id: id5 })
    assert.deepEqual([loud.status, loud.data.code], [200, 'resumed'], JSON.stringify(loud.data))
    assert.deepEqual(raised, ['Herdr'], '값이 없으면 예전 그대로 올린다')
  })
})
