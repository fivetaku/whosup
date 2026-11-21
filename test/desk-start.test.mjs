// herdr 데스크 켜기: 서버·창만 띄우지 않고, 꺼질 때 대화가 돌던 세션마다 그 대화를 이어서 연다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = mkdtempSync(join(tmpdir(), 'whosup-deskstart-'))
process.env.CLAUDE_PROJECTS_DIR = root
process.env.HERDR_BIN = fileURLToPath(new URL('../test-support/fake-herdr.mjs', import.meta.url))
const { openDb } = await import('../src/db.mjs')
const herdrRt = await import('../src/runtime/herdr.mjs')
const { shellPanes } = herdrRt
const { startHerdrDesk, _clearResumeHolds } = await import('../src/board/server.mjs')
const { clearContextCache } = await import('../src/board/context.mjs')

const CWD = '/work/whosup-deskstart-proj'
const dir = join(root, CWD.replace(/[^A-Za-z0-9]/g, '-'))
mkdirSync(dir, { recursive: true })
const id = (n) => `0000000${n}-0000-4000-8000-000000000000`
const conv = (n) => writeFileSync(join(dir, `${id(n)}.jsonl`), JSON.stringify({ type: 'user', timestamp: '2026-11-08T10:00:00Z', message: { content: `대화 ${n}` } }) + '\n')
for (const n of [1, 2, 3, 5]) conv(n)

const add = (db, ref, status, sid, over = {}) => db.prepare(`INSERT INTO session (runtime, runtime_ref, provider_session, cwd, provider, status, unreachable, archived, first_seen, updated_at)
  VALUES (?, ?, ?, ?, 'claude', ?, ?, ?, '2026-11-12T00:00:00Z', '2026-11-12T00:00:00Z')`).run(over.runtime || 'herdr', ref, sid, CWD, status, over.unreachable ?? 2, over.archived ?? 0).lastInsertRowid
const fakeRt = (client = 'started', free = null) => {
  const calls = []
  return { calls, startSession: async (session) => ({ session, client, window: 'opened' }),
    runInShells: async (session, commands) => { calls.push({ session, commands }); const ok = commands.filter((c) => !free || free.includes(c.pane)); return { ran: ok.map((c) => c.id), failed: commands.filter((c) => !ok.includes(c)).map((c) => c.id) } } }
}
// 이 기계의 환경 변수가 시험의 기본값을 바꾸지 않게 비운다(설정 desk_resume은 WHOSUP_DESK_RESUME을 읽는다).
const fresh = () => { _clearResumeHolds(); clearContextCache(); delete process.env.AGENT_CMD; delete process.env.WHOSUP_DESK_RESUME; return openDb(':memory:') }

test('셸인 herdr pane만 고른다: 에이전트가 붙은 pane과 agent list에 나온 pane은 뺀다', () => {
  const panes = [{ pane_id: 'w1:p1', agent: 'claude', agent_status: 'idle' }, { pane_id: 'w1:p2', agent: null, agent_status: 'unknown' }, { pane_id: 'w1:p3', agent: null }, { pane_id: 'w1:p4', agent: null, agent_status: 'unknown' }]
  assert.deepEqual([...shellPanes(panes, [{ pane_id: 'w1:p4' }])], ['w1:p2', 'w1:p3'])
  assert.deepEqual([...shellPanes()], [])
})

test('데스크 켜기: 꺼질 때 대화가 돌던 세션마다 그 대화를 이어 연다. 빈 세션·다른 데스크·닫힌 세션은 건드리지 않는다', async () => {
  const db = fresh()
  const a = add(db, 'side/w1:p1', 'idle', id(1))
  const b = add(db, 'side/w1:p2', 'done', id(2))
  add(db, 'side/w1:p3', 'shell', id(3))                       // 꺼질 때 에이전트가 없던 세션
  add(db, 'main/w1:p1', 'idle', id(5), { unreachable: 0 })    // 다른 데스크
  add(db, 'side/w1:p9', 'gone', id(5), { archived: 1 })       // 닫힌 세션
  const rt = fakeRt()
  const r = await startHerdrDesk(db, 'side', { rt })
  assert.equal(rt.calls.length, 1); assert.equal(rt.calls[0].session, 'side')
  assert.deepEqual(rt.calls[0].commands.map((c) => [c.id, c.pane, c.command]), [[a, 'w1:p1', `claude --resume ${id(1)}`], [b, 'w1:p2', `claude --resume ${id(2)}`]])
  assert.deepEqual([r.client, r.resumed, r.failed], ['started', 2, []])
})

test('데스크 켜기: 이미 켜져 있던 데스크면 아무것도 넣지 않는다', async () => {
  const db = fresh()
  add(db, 'side/w1:p1', 'idle', id(1), { unreachable: 0 })
  const rt = fakeRt('running')
  const r = await startHerdrDesk(db, 'side', { rt })
  assert.equal(rt.calls.length, 0); assert.equal(r.resumed, undefined)
})

test('데스크 켜기: 기록이 없는 대화, 다른 세션에서 살아 있는 대화, 같은 대화의 두 번째 세션은 잇지 않는다', async () => {
  const db = fresh()
  add(db, 'side/w1:p1', 'idle', id(9))                        // 대화 기록 파일이 없다
  add(db, 'side/w1:p2', 'idle', id(5))                        // main에서 살아 있는 대화
  add(db, 'main/w1:p1', 'working', id(5), { unreachable: 0 })
  const c = add(db, 'side/w1:p3', 'idle', id(2))
  add(db, 'side/w1:p4', 'idle', id(2))                        // 같은 대화를 가리키는 두 번째 세션
  const rt = fakeRt()
  await startHerdrDesk(db, 'side', { rt })
  assert.deepEqual(rt.calls[0].commands.map((x) => [x.id, x.command]), [[c, `claude --resume ${id(2)}`]])
})

test('데스크 켜기: herdr가 스스로 에이전트를 되살린 세션에는 넣지 못하고, 그 수를 not_resumed로 알린다', async () => {
  const db = fresh()
  const a = add(db, 'side/w1:p1', 'idle', id(1))
  const b = add(db, 'side/w1:p2', 'idle', id(2))
  const r = await startHerdrDesk(db, 'side', { rt: fakeRt('started', ['w1:p1']) })
  assert.deepEqual([r.resumed, r.failed], [1, [b]]); assert.ok(a)
})

test('데스크 켜기: 실행 명령이 Claude가 아니면 이어 열지 않는다(데스크만 켠다)', async () => {
  const db = fresh()
  add(db, 'side/w1:p1', 'idle', id(1))
  process.env.AGENT_CMD = 'codex'
  try {
    const rt = fakeRt()
    const r = await startHerdrDesk(db, 'side', { rt })
    assert.deepEqual(rt.calls[0]?.commands ?? [], []); assert.equal(r.resumed ?? 0, 0)
  } finally { delete process.env.AGENT_CMD }
})

// 설정 "데스크를 켤 때 대화 이어 열기"(desk_resume): on(기본, 늘 잇는다) · ask(켤 때마다 화면이 묻는다) · off(잇지 않는다).
// 새로 시작하고 싶은 데스크에서 지난 대화가 저절로 켜지지 않게, 켜기 요청은 resume 으로 이번 한 번만 정할 수도 있다.
const { setSettings, getSettings } = await import('../src/settings.mjs')
test('설정: desk_resume의 기본은 on이고, on·ask·off만 받는다', () => {
  const db = fresh()
  assert.equal(getSettings(db).desk_resume, 'on')
  setSettings(db, { desk_resume: 'ask' }); assert.equal(getSettings(db).desk_resume, 'ask')
  setSettings(db, { desk_resume: 'off' }); assert.equal(getSettings(db).desk_resume, 'off')
  assert.equal(setSettings(db, { desk_resume: 'maybe' }).ok, false); assert.equal(getSettings(db).desk_resume, 'off', '틀린 값은 저장하지 않는다')
})

test('데스크 켜기: resume:false면 데스크만 켜고 대화는 잇지 않는다', async () => {
  const db = fresh()
  add(db, 'side/w1:p1', 'idle', id(1))
  const rt = fakeRt()
  const r = await startHerdrDesk(db, 'side', { rt, resume: false })
  assert.equal(r.client, 'started')
  assert.deepEqual(rt.calls.map((c) => c.commands.length), [], '대화를 이어 열려고 했다')
  assert.equal(r.resumed ?? 0, 0)
})

// herdr가 스스로 에이전트를 되살리는 설정(config.toml [session] resume_agents_on_restore, herdr 기본 true)이면 whosup은 넣지 않는다:
// herdr가 에이전트를 늦게 띄우면, 셀이라고 본 pane에 넣은 재개 명령이 그 에이전트의 입력으로 들어간다.
test('herdr 자체 복원 여부: config.toml의 [session] resume_agents_on_restore가 false일 때만 꺼진 것으로 본다 — 파일이 없으면 herdr 기본(켜짐)', () => {
  const base = mkdtempSync(join(tmpdir(), 'whosup-hcfg-'))
  const env = { XDG_CONFIG_HOME: base, HOME: base }
  // 파일을 실제로 읽으므로 이 기계의 플랫폼 규칙을 쓴다(윈도우의 C:\… 임시 폴더는 POSIX 규칙에서 절대 경로가 아니다)
  assert.equal(herdrRt.restoresAgents(env), true, '설정 파일이 없으면 herdr 기본값(켜짐)')
  mkdirSync(join(base, 'herdr'))
  const cfg = (text) => { writeFileSync(join(base, 'herdr', 'config.toml'), text); return herdrRt.restoresAgents(env) }
  assert.equal(cfg('[session]\n# 래퍼로 띄운다\nresume_agents_on_restore = false\n'), false)
  assert.equal(cfg('[session]\nresume_agents_on_restore = false # whosup이 잇는다\n'), false)
  assert.equal(cfg('[session]\nresume_agents_on_restore = true\n'), true)
  assert.equal(cfg('[ui]\nresume_agents_on_restore = false\n[session]\n'), true, '다른 표의 같은 이름은 아니다')
  assert.equal(cfg('[session]\n'), true, '값이 없으면 herdr 기본값(켜짐)')
})

test('데스크 켜기: herdr가 스스로 에이전트를 되살리는 설정이면 whosup은 대화를 넣지 않는다', async () => {
  const db = fresh()
  add(db, 'side/w1:p1', 'idle', id(1))
  const rt = { ...fakeRt(), restoresAgents: () => true }
  const r = await startHerdrDesk(db, 'side', { rt })
  assert.equal(r.client, 'started')
  assert.deepEqual(rt.calls, [], 'herdr가 되살리는 세션에 명령을 넣으려 했다')
  assert.equal(r.resumed ?? 0, 0)
})

test('빈 셸 판정: herdr에 에이전트 목록을 물을 수 없으면 어느 pane에도 넣지 않는다', async () => {
  const d = mkdtempSync(join(tmpdir(), 'whosup-ris-'))
  const log = join(d, 'runs.log'), bin = join(d, 'herdr.mjs')
  writeFileSync(bin, `import { appendFileSync } from 'node:fs'
const a = process.argv.slice(2).filter((x, i, all) => x !== '--session' && all[i - 1] !== '--session')
if (a[0] === 'pane' && a[1] === 'list') console.log(JSON.stringify({ result: { panes: [{ pane_id: 'w1:p1', agent: null, agent_status: 'unknown' }] } }))
else if (a[0] === 'agent') process.exit(3)
else if (a[0] === 'pane' && a[1] === 'run') appendFileSync(${JSON.stringify(log)}, a.join(' ') + '\\n')
`)
  process.env.HERDR_BIN_PATH = bin
  try {
    const r = await herdrRt.runInShells('side', [{ id: 7, pane: 'w1:p1', command: 'claude --resume x' }], { settleMs: 0 })
    assert.deepEqual(r, { ran: [], failed: [7] })
    assert.equal(existsSync(log), false, '에이전트 목록을 모르는데 명령을 넣었다')
  } finally { delete process.env.HERDR_BIN_PATH }
})

test('/api/desk: resume은 true·false만 받는다 — 다른 값이면 데스크를 건드리지 않고 400', async () => {
  const { startBoard } = await import('../src/board/server.mjs')
  const db = fresh()
  const server = await startBoard(db, { port: 0, heartbeatPath: join(root, 'hb') })
  try {
    const post = async (body) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/desk`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return [r.status, (await r.json()).code] }
    for (const resume of ['false', 0, null, 'off']) assert.deepEqual(await post({ session: 'side', on: true, raise: false, resume }), [400, 'bad_request'], JSON.stringify(resume))
  } finally { await new Promise((res) => server.close(res)); server.closeAllConnections?.() }
})

test('/api/desk: 요청의 resume이 먼저고, 없으면 설정(off면 잇지 않음, on·ask면 잇는다)을 따른다', async () => {
  const { deskResumeFor } = await import('../src/board/server.mjs')
  const db = fresh()
  assert.deepEqual([deskResumeFor(db, undefined), deskResumeFor(db, false), deskResumeFor(db, true)], [true, false, true])
  setSettings(db, { desk_resume: 'off' })
  assert.deepEqual([deskResumeFor(db, undefined), deskResumeFor(db, true)], [false, true])
  setSettings(db, { desk_resume: 'ask' })
  assert.equal(deskResumeFor(db, undefined), true, '묻는 화면이 없는 예전 화면·명령에서는 예전처럼 잇는다')
})
