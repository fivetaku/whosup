// 자동 감지 — 자기 herdr-core 코어를 띄우는 데스크톱 앱(ovis 데스크톱 앱 같은 것): 브리지 등록부로 서버 찾기, 그 서버가 무엇을
// 보여 주는지 가르기, 코어 프로필(결과의 cores), 같은 이름의 다른 herdr(F29), 설치 질문 조건, 그리고 프로필이 런타임에 닿는 것까지.
// 가짜 ovis 서버(test-support/fake-ovis.mjs)·가짜 코어(test-support/fake-core.mjs)만 쓴다. 실제 ovis·앱·herdr·코어·터미널 창은 건드리지
// 않는다: 서버는 임시 홈의 등록부로만 찾고(기본 포트 범위는 훑지 않는다 — ports: []), 창 올리기는 주입한 가짜가 받는다.
// 코어 이름·앱 이름은 시험이 지어낸 것이다(deskcore·Deskview) — 코드는 어떤 이름도 알고 있지 않다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { startNamedCore, agentTerm, appTerm } from '../test-support/fake-core.mjs'
import { startFakeOvis, writeBridgeFile } from '../test-support/fake-ovis.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE_OVIS = join(ROOT, 'test-support', 'fake-ovis.mjs')
const dir = mkdtempSync(join(tmpdir(), 'wac-'))
const STATE = join(dir, 'st')
// 읽을 코어는 이 시험이 정한 것만: 기계의 HC_*·WHOSUP_CORES·XDG_* 값이 섞이지 않게 한다. 상태 폴더는 모듈을 부르기 전에 정한다.
for (const k of ['HC_SOCKET', 'HC_SESSION', 'WHOSUP_CORES', 'XDG_RUNTIME_DIR', 'HERDR_BIN_PATH', 'HERDR_APP_NAME', 'HERDR_APP_BIN', 'WHOSUP_READONLY', 'WHOSUP_RUNTIMES', 'WHOSUP_CORE_TARGET', 'WHOSUP_CLICK_TARGET', 'HC_BIN', 'FRONT_APP']) delete process.env[k]
process.env.XDG_STATE_HOME = STATE
process.env.WHOSUP_STATE_DIR = join(dir, 'state')
process.env.HERDR_BIN = join(dir, 'no-herdr')              // herdr가 설치되지 않은 기계
process.env.HERDR_APP_BIN = join(dir, 'no-herdr-app')      // Herdr 앱 명령도 없다
process.env.CLAUDE_PROJECTS_DIR = join(dir, 'claude', 'projects')
process.env.WHOSUP_NO_EVENTS = '1'
mkdirSync(process.env.CLAUDE_PROJECTS_DIR, { recursive: true })

const {
  OVIS_PORTS, appOfChain, appOfPath, autoPath, autoTmpPath, coreProfiles, coreScopeOf, detectLine, evaluate, findOvis, hasPendingCore, laneOvis, listenerPids, ovisCoreName, ovisOpensInBrowser, ovisRegistryDirs,
  pendingCoreRetry,
  ovisRegistryKey, ovisServing, ovisUrl, probeOvis, readAuto, readOvisRegistry, refreshAuto, watchOvisRegistry, writeAuto,
} = await import('../src/autoconf.mjs')
const { chosenOf, closingLines, coreLines, questionsOf, runSetup, setupRows, summaryLines, TEXT } = await import('../src/setup.mjs')
// 이 시험의 앱 이름은 가짜다: 이 기계에 깔린 앱이 ovis:// 링크를 아는지에 답이 흔들리지 않게 '모른다'로 고정한다(아는 경우는 따로 본다).
const NOLINK = { link: () => false }
const { autoCores, clientDefaults, setAutoValues } = await import('../src/settings.mjs')
const core = await import('../src/runtime/core.mjs')
// 새 터미널의 셸이 뜨기를 기다리는 일(core.mjs shellReady)은 이 파일의 시험에서는 끈다: 가짜 코어의 화면은 비어 있어 한도까지 기다리게 된다(그 동작의 시험은 test/ovis-app.test.mjs)
core._setShellWait({ maxMs: 0 })
// 자기 서버로 코어를 보여 주는 앱의 서버 찾기가 이 기계의 실제 등록부를 읽지 않게 한다(실제 HOME 에서 돌려도 실제 앱의 서버에 묻지 않는다)
const ovisRt = await import('../src/runtime/ovis.mjs')
ovisRt._setLookup({ registryDirs: () => [], userDataDirs: () => [] })
const { collectAll } = await import('../src/runtime/index.mjs')
const { computeBoardAsync } = await import('../src/board/board.mjs')
const { autoconfView } = await import('../src/board/server.mjs')
const { openDb } = await import('../src/db.mjs')
const { diagnose } = await import('../scripts/doctor.mjs')

const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const board = new Function(`${html.match(/\/\*origin\*\/([\s\S]*?)\/\*\/origin\*\//)[1]}; return { choiceRows, envCoreLines, envSummaryParts }`)()

const CORE = 'deskcore'                                     // 앱이 따로 띄운 코어의 이름(기본 코어가 아니다)
const APP = 'Deskview'                                      // 그 코어를 보여 주는 앱
const TOKEN = 'tok-3f9a1c77-do-not-leak'                    // 등록부 파일에만 있는 값: 어디에도 옮겨지면 안 된다
// 자동 감지가 코어 프로필에 싣는 주소 틀(그 세션의 터미널 보기까지 — herdr 데스크의 웹 터미널 주소 ovisUrl 과 다르다)과 되는 기능(F18):
// 서버가 인증 없이 열린다고 답했으면(주소가 실린다) 새 세션·닫기·이어서 열기는 그 서버로, 이동은 그 주소를 여는 것. 아니면 앱 창·코어 직결뿐.
const coreUrl = (port) => `http://127.0.0.1:${port}/?pane={pane}&view=terminal`
const FEAT_ON = { new: { means: 'server_api' }, focus: { means: 'open_url' }, close: { means: 'server_api' }, resume: { means: 'server_api' } }
const FEAT_OFF = (app) => ({ new: { means: 'none', reason: 'app_required' }, focus: { means: app ? 'app_window' : 'terminal_window', reason: 'app_required' }, close: { means: 'core_socket' }, resume: { means: 'none', reason: 'app_required' } })
const closers = []
after(async () => { core.stopWatching(); setAutoValues(null); for (const c of closers.reverse()) { try { await c() } catch {} } })
const fake = async (o) => { const s = await startFakeOvis(o); closers.push(s.close); return s }
const regOf = (home) => join(home, '.config', 'ovis', 'bridges')
const val = (items, key) => items.find((i) => i.key === key)?.value
const has = (items, key) => items.some((i) => i.key === key)
const byPort = (found, port) => found.find((o) => o.port === port)
// 이 시험 프로세스가 듣는 가짜 서버: 프로세스에서 읽는 값(앱 이름·HERDR_SOCKET)은 시험을 돌린 환경에 따라 달라지므로 떼어 낸다.
const bare = ({ app, socket, socketReal, sessionEnv, why, ...o }) => o
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

// 감지 입력(src/autoconf.mjs detect()의 모양): 맥, herdr 없음, Herdr 앱 없음, 터미널 앱 셋, 에이전트 둘.
const facts = (over = {}) => ({
  platform: 'darwin', release: '1', env: {}, coreScope: coreScopeOf({}), node: { version: 'v22.13.0', sqlite: true },
  herdr: { found: false, bin: 'herdr', sessions: [] }, herdrCore: { running: false, socket: null }, herdrApp: { found: false, bin: 'herdr-app' }, tools: {},
  terminal: { showing: null, installed: ['Ghostty', 'Terminal', 'iTerm'] }, ovis: [], agents: { claude: '/bin/claude', codex: '/bin/codex', projectsDir: null },
  port: { start: 4790, free: 4790 }, ...over,
})
const APP_CORE = { port: 48111, answered: true, signed: true, serving: 'herdr-core', core: CORE, webOpen: true, app: APP }
const DESK = { name: 'work', status: 'running', socket: '/iso/sessions/work/herdr.sock' }
const viewOf = (f, env = {}) => { const r = evaluate(f); return { summary: r.summary, chosen: chosenOf(r, env) } }
const keysAsked = (f) => questionsOf(setupRows(viewOf(f), TEXT.en)).map((q) => q.key)

test('등록부: 살아 있는 pid의 port·pid만 꺼낸다 — 죽은 pid·깨진 파일·틀린 값·없는 폴더는 조용히 넘어가고 token은 꺼내지 않는다', () => {
  const reg = join(dir, 'reg-a')
  writeBridgeFile(reg, { port: 48121, pid: process.pid, token: TOKEN, socketPath: '/a' })
  writeBridgeFile(reg, { port: 48122, pid: deadPid(), token: TOKEN, socketPath: '/b' })           // 재부팅 뒤 남은 파일
  writeFileSync(join(reg, 'broken.json'), '{"port": 48123, "pid": ')                               // 깨진 파일
  writeFileSync(join(reg, 'odd.json'), JSON.stringify({ port: '48124', pid: process.pid }))        // 숫자가 아닌 포트
  writeFileSync(join(reg, 'range.json'), JSON.stringify({ port: 70000, pid: process.pid }))        // 범위 밖 포트
  writeFileSync(join(reg, 'nopid.json'), JSON.stringify({ port: 48125, token: TOKEN }))
  writeFileSync(join(reg, 'null.json'), 'null')
  writeFileSync(join(reg, 'bridge.log'), `port 48126 pid ${process.pid}`)                         // .json 이 아닌 파일
  mkdirSync(join(reg, 'folder.json'))
  const got = readOvisRegistry([reg, join(dir, 'no-such-folder'), reg])
  assert.deepEqual(got, [{ port: 48121, pid: process.pid }], '같은 폴더는 한 번만, 살아 있는 항목만')
  assert.doesNotMatch(JSON.stringify(got), /tok-/)
  assert.deepEqual(readOvisRegistry([reg], { alive: () => false }), [], 'pid가 모두 죽었으면 후보가 없다')
  assert.deepEqual(readOvisRegistry([join(dir, 'no-such-folder')]), [])
  // 폴더: <홈>/.config 아래 ovis 와 옛 이름, XDG_CONFIG_HOME 이 다르면 그 아래도. 같으면 한 번만.
  assert.deepEqual(ovisRegistryDirs({}, '/h'), ['/h/.config/ovis/bridges', '/h/.config/herdr-web-ui/bridges'].map((p) => join(p)))
  assert.deepEqual(ovisRegistryDirs({ XDG_CONFIG_HOME: join('/h', '.config') }, '/h').length, 2)
  assert.ok(ovisRegistryDirs({ XDG_CONFIG_HOME: '/x/cfg' }, '/h').includes(join('/x/cfg', 'ovis', 'bridges')))
  // 옛 이름 폴더가 새 폴더를 가리키는 링크여도(옮긴 설치) 같은 파일을 두 번 세지 않는다
  if (process.platform !== 'win32') {
    const home = join(dir, 'home-link')
    writeBridgeFile(regOf(home), { port: 48127, pid: process.pid, token: TOKEN, socketPath: '/c' })
    symlinkSync(join(home, '.config', 'ovis'), join(home, '.config', 'herdr-web-ui'))
    assert.deepEqual(readOvisRegistry(ovisRegistryDirs({}, home)), [{ port: 48127, pid: process.pid }])
  }
  // 파일 전체를 값으로 풀지 않는다(F2-3): port·pid 두 숫자만 집는다 — token 은 값으로 꺼내지 않는다.
  // 글자열 안에 열쇠처럼 보이는 글자가 있어도(따옴표는 \" 로 적힌다) 진짜 열쇠의 숫자만 읽는다. 객체 모양이 아닌 파일·숫자가 아닌 값은 넘어간다.
  const one = (name, text) => { const d = join(dir, `reg-${name}`); mkdirSync(d, { recursive: true }); writeFileSync(join(d, 'x.json'), text); return readOvisRegistry([d]) }
  assert.deepEqual(one('tricky', JSON.stringify({ token: `${TOKEN}","port":1,"pid":${process.pid},"x":"`, socket_path: '{"port":2,"pid":2}', port: 48128, pid: process.pid })), [{ port: 48128, pid: process.pid }])
  assert.deepEqual(one('pretty', JSON.stringify({ managed_remote: false, port: 48129, token: TOKEN, pid: process.pid }, null, 2)), [{ port: 48129, pid: process.pid }], '줄을 나눠 적은 파일')
  assert.deepEqual(one('last', `{"token":"${TOKEN}","pid":${process.pid},"port":48130}`), [{ port: 48130, pid: process.pid }], '맨 뒤에 적힌 값')
  assert.deepEqual(one('array', JSON.stringify([{ port: 48131, pid: process.pid }])), [], '객체가 아닌 파일')
  assert.deepEqual(one('cut', `{"port":48132,"pid":${process.pid},"token":"${TOKEN}`), [], '쓰다 만 파일(닫는 괄호 없음)')
  for (const [i, bad] of ['48133.5', '-48133', '4.8e4', 'true', 'null', '"48133"', '99999999999'].entries()) assert.deepEqual(one(`bad${i}`, `{"port":${bad},"pid":${process.pid}}`), [], `port ${bad}`)
  assert.deepEqual(one('badpid', '{"port":48134,"pid":1.5}'), [])
  const src = readFileSync(join(ROOT, 'src', 'autoconf.mjs'), 'utf8')
  const body = src.slice(src.indexOf('export function readOvisRegistry('), src.indexOf('// 등록부에 적힌 살아 있는 ovis 서버들을 한 줄로'))
  assert.ok(body.length > 200 && body.includes('REG_PORT.exec(text)'))
  assert.doesNotMatch(body, /JSON\.parse|token/, '등록 파일을 통째로 풀지 않고, token 을 가리키는 코드가 없다')
})

test('등록부의 pid 와 그 포트를 듣는 프로세스(F2-2): pid 가 살아 있어도 그 포트를 듣는 프로세스가 아니면 그 항목을 버리고 묻지도 않는다. 듣는 프로세스를 알 수 없으면 서명 확인에 맡긴다', async () => {
  const home = join(dir, 'home-f22')
  const reg = regOf(home)
  // 살아 있지만 아무 포트도 듣지 않는 프로세스(남은 등록 파일의 pid 를 물려받은 다른 프로세스 노릇)
  const idle = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { stdio: 'ignore' })
  closers.push(() => { try { idle.kill('SIGKILL') } catch {} })
  const mine = await fake({ serving: 'herdr-core', core: CORE, registry: reg, token: TOKEN, socketPath: '/f22/mine.sock' })   // 등록부의 pid = 듣는 프로세스
  const other = await fake({ serving: 'herdr-core', core: 'othercore', token: TOKEN })                                         // 이 프로세스가 듣는데
  writeBridgeFile(reg, { port: other.port, pid: idle.pid, token: TOKEN, socketPath: '/f22/other.sock' })                        // 등록부에는 다른 살아 있는 pid
  assert.deepEqual(readOvisRegistry([reg]).map((r) => r.pid).sort(), [idle.pid, process.pid].sort(), '둘 다 pid 는 살아 있다')
  const ports = (found) => found.map((o) => o.port).sort()

  // 듣는 프로세스를 알려 주면(주입): 적힌 pid 가 그 가운데 없으면 버린다. 듣는 프로세스가 여럿이어도 그 가운데 있으면 쓴다.
  const asked = []
  const listeners = async (port) => { asked.push(port); return port === mine.port ? [idle.pid + 100000, process.pid] : port === other.port ? [process.pid] : [] }
  let found = await findOvis(process.platform, {}, { home, ports: [], listeners })
  assert.deepEqual(ports(found), [mine.port])
  assert.equal(found[0].core, CORE)
  assert.equal(other.requests.length, 0, '버린 항목의 포트에는 요청이 가지 않는다')
  assert.deepEqual(asked.sort(), [mine.port, other.port].sort(), '포트마다 한 번만 묻는다')
  assert.deepEqual(evaluate(facts({ ovis: found.map(bare) })).cores.map((c) => c.name), [CORE], '엉뚱한 pid 로 적힌 서버의 코어는 프로필이 되지 않는다')
  // 기본 포트 범위에 든 포트라면 등록부 항목은 버려도 범위 훑기로는 본다(예전 그대로)
  assert.deepEqual(ports(await findOvis(process.platform, {}, { home, ports: [other.port], listeners })), [mine.port, other.port].sort())
  // 듣는 프로세스를 알 수 없다(윈도우·lsof 없음 = 빈 목록, 조회 실패): 예전처럼 서명 확인에 맡긴다
  other.requests.length = 0
  assert.deepEqual(ports(await findOvis(process.platform, {}, { home, ports: [], listeners: async () => [] })), [mine.port, other.port].sort())
  assert.deepEqual(ports(await findOvis(process.platform, {}, { home, ports: [], listeners: async () => { throw new Error('no lsof') } })), [mine.port, other.port].sort())
  assert.deepEqual(await listenerPids(mine.port, 'win32'), [], '윈도우에서는 듣는 프로세스를 알아내지 않는다')

  // 실제 조회(lsof 가 있는 맥·리눅스): 이 프로세스가 듣는 포트를 다른 pid 로 적은 항목이 버려진다
  if (process.platform !== 'win32' && (await listenerPids(mine.port)).includes(process.pid)) {
    assert.deepEqual(await listenerPids(other.port), [process.pid])
    other.requests.length = 0
    assert.deepEqual(ports(await findOvis(process.platform, {}, { home, ports: [] })), [mine.port])
    assert.equal(other.requests.length, 0)
  }
  assert.doesNotMatch(JSON.stringify(found), /tok-/)
})

test('감지 줄 세우기(F2-4): 겹쳐 부른 감지가 한 번에 하나씩 부른 순서대로 돈다 — 먼저 시작해 늦게 끝난 옛 감지가 새 값을 덮지 않는다. auto.json 의 임시 파일 이름은 쓸 때마다 다르다', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  // 옛 감지 = 앱이 켜져 있을 때 환경을 보고 늦게 끝난다. 새 감지 = 앱이 꺼진 뒤에 보고 바로 끝난다.
  const scene = async (stateDir, run) => {
    const order = []
    let world = 'app-on'
    let release
    const gate = new Promise((r) => { release = r })
    const detectFn = (slow) => async () => { const seen = world; order.push(`look:${seen}`); if (slow) await gate; return facts({ ovis: seen === 'app-on' ? [APP_CORE] : [] }) }
    const job = (slow) => async () => { const r = await refreshAuto(stateDir, { detectFn: detectFn(slow) }); setAutoValues(r); order.push(`apply:${r.cores.map((c) => c.name).join('+') || 'none'}`); return r }
    const first = run(job(true))
    await sleep(10)                                           // 옛 감지가 환경을 본 뒤에 앱이 꺼진다
    world = 'app-off'
    const second = run(job(false))
    return { order, release, done: Promise.all([first, second]) }
  }
  try {
    // 줄을 세우지 않으면(예전): 새 감지가 먼저 끝나고, 늦게 끝난 옛 감지가 그 값을 덮는다
    const loose = await scene(join(dir, 'line-loose'), (job) => job())
    await sleep(30); loose.release(); await loose.done
    assert.deepEqual(loose.order, ['look:app-on', 'look:app-off', 'apply:none', `apply:${CORE}`])
    assert.deepEqual(autoCores().map((c) => c.name), [CORE], '꺼진 앱의 코어가 자동 값에 되살아났다(막으려는 일)')
    // 줄을 세우면: 앞 감지가 끝난 뒤에야 뒤 감지가 환경을 본다 — 마지막에 남는 것은 늘 가장 새 값이다
    const line = detectLine()
    const lined = await scene(join(dir, 'line-on'), line)
    await sleep(30)
    assert.deepEqual(lined.order, ['look:app-on'], '앞 감지가 도는 동안 뒤 감지는 시작하지 않는다')
    lined.release(); await lined.done
    assert.deepEqual(lined.order, ['look:app-on', `apply:${CORE}`, 'look:app-off', 'apply:none'])
    assert.deepEqual(autoCores(), [])
    assert.deepEqual(readAuto(join(dir, 'line-on')).cores, [], 'auto.json 도 새 값이다')
    // 앞 일이 실패해도 줄은 이어지고, 실패는 그 일을 부른 쪽에만 간다
    await assert.rejects(line(async () => { throw new Error('detect broke') }), /detect broke/)
    assert.equal(await line(async () => 7), 7)
    const seen = []
    await Promise.all([1, 2, 3].map((n) => line(async () => { seen.push(`in:${n}`); await sleep(n === 1 ? 15 : 0); seen.push(`out:${n}`) })))
    assert.deepEqual(seen, ['in:1', 'out:1', 'in:2', 'out:2', 'in:3', 'out:3'])
  } finally { setAutoValues(null) }

  // 임시 파일 이름: pid 만이 아니라 무작위 조각이 붙어 쓸 때마다 다르다. 쓰고 나면 남지 않고, 실패해도 치운다.
  const file = autoPath(join(dir, 'tmp-names'))
  const names = new Set(Array.from({ length: 50 }, () => autoTmpPath(file)))
  assert.equal(names.size, 50)
  for (const n of names) assert.match(n.slice(file.length), new RegExp(`^\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`))
  for (let i = 0; i < 5; i++) writeAuto(join(dir, 'tmp-names'), { version: 1, at: new Date().toISOString(), platform: process.platform, values: { n: i }, reasons: {} })
  assert.deepEqual(readdirSync(join(dir, 'tmp-names')), ['auto.json'])
  assert.equal(readAuto(join(dir, 'tmp-names')).values.n, 4)
  const blocked = join(dir, 'tmp-blocked')
  mkdirSync(join(blocked, 'auto.json', 'in-the-way'), { recursive: true })   // auto.json 자리에 비어 있지 않은 폴더: 이름 바꾸기가 실패한다
  assert.throws(() => writeAuto(blocked, { values: {} }))
  assert.deepEqual(readdirSync(blocked), ['auto.json'], '실패한 쓰기의 임시 파일을 남기지 않는다')

  // bin/whosup.mjs: 감지(refreshAuto)는 모두 그 줄 안에서만 부른다 — 첫 감지와 다시 감지(등록부 지켜보기·코어 이름 다시 묻기·보드의 "다시 감지"가 쓰는 redetect)
  const bin = readFileSync(join(ROOT, 'bin', 'whosup.mjs'), 'utf8')
  assert.match(bin, /const inLine = detectLine\(\)/)
  assert.match(bin, /const redetect = \(\) => inLine\(async \(\) => \{\s*const r = await refreshAuto\(/)
  assert.equal(bin.match(/refreshAuto\(/g).length, 2)
  assert.equal(bin.match(/inLine\(async \(\) => \{\s*const r = await refreshAuto\(STATE_DIR/g).length, 2, '줄 밖에서 부르는 감지가 없다')
  assert.match(bin, /startBoard\(db, \{[^}]*\bredetect\b/, '보드 서버의 "다시 감지"도 같은 redetect 를 쓴다')
})

test('health 읽기: serving이 herdr-core일 때만 herdr_core.session을 그 서버의 코어 이름으로 믿고, 웹 주소는 인증 없이 열릴 때만', () => {
  assert.equal(ovisCoreName({ herdr_runtime: { serving: 'herdr-core' }, herdr_core: { session: CORE } }), CORE)
  assert.equal(ovisCoreName({ herdr_runtime: { serving: 'herdr' }, herdr_core: { session: CORE } }), null, 'herdr 데스크를 보여 주는 서버도 herdr_core를 낸다 — 믿지 않는다')
  assert.equal(ovisCoreName({ herdr_core: { session: CORE } }), null, 'serving을 말하지 않으면 믿지 않는다')
  assert.equal(ovisCoreName({ runtime: 'herdr-core', herdr_core: { session: CORE } }), null)
  for (const bad of ['..', '.', 'a/b', '', 'x'.repeat(81), 7, null]) assert.equal(ovisCoreName({ herdr_runtime: { serving: 'herdr-core' }, herdr_core: { session: bad } }), null, String(bad))
  assert.equal(ovisCoreName(null), null)
  assert.equal(ovisServing({ herdr_runtime: { serving: 'herdr-core' }, runtime: 'herdr' }), 'herdr-core')
  assert.equal(ovisServing({ runtime: 'herdr' }), 'herdr')
  assert.equal(ovisServing({ runtime: 'something-else' }), null)
  assert.equal(ovisServing({}), null)
  assert.equal(ovisOpensInBrowser({ auth: { required: false, authenticated: true, via: 'local', role: 'drive' } }), true)
  assert.equal(ovisOpensInBrowser({ auth: { via: 'local', role: 'drive' } }), true)
  assert.equal(ovisOpensInBrowser({ auth: { required: true, authenticated: false, reason: 'token_required' } }), false, '토큰이 걸린 서버')
  assert.equal(ovisOpensInBrowser({ auth: { required: false, authenticated: true, via: 'open', role: 'drive' } }), false, '로컬이라서 들여보낸 것이 아니면 판단하지 않는다')
  assert.equal(ovisOpensInBrowser({ auth: { required: false, authenticated: true, via: 'token', role: 'drive' } }), false)
  assert.equal(ovisOpensInBrowser({}), false)
  assert.equal(ovisOpensInBrowser(null), false)
})

test('서버 찾기: 등록부로 7317~7330 밖 포트의 서버를 찾고, 서명 없는 서버는 버리고, 보여 주는 것(herdr·herdr-core)에 따라 갈린다', async () => {
  const home = join(dir, 'home-b')
  const reg = regOf(home)
  const app = await fake({ serving: 'herdr-core', core: CORE, registry: reg, token: TOKEN, socketPath: '/app/server/herdr-core.sock' })
  const plugin = await fake({ serving: 'herdr', pcCore: 'pccore', registry: reg, token: TOKEN, socketPath: DESK.socket })
  const plain = await fake({ signed: false, registry: reg, token: TOKEN, socketPath: '/plain' })                       // ovis 가 아닌 HTTP 서버
  const locked = await fake({ serving: 'herdr-core', core: 'hidden', locked: true, registry: reg, token: TOKEN, socketPath: '/locked' })
  const gone = await fake({ serving: 'herdr-core', core: 'ghost', token: TOKEN })                                      // 등록부에 죽은 pid 로 적힌 서버
  writeBridgeFile(reg, { port: gone.port, pid: deadPid(), token: TOKEN, socketPath: '/gone' })
  writeFileSync(join(reg, 'broken.json'), '{ not json')
  for (const s of [app, plugin, plain, locked, gone]) assert.equal(OVIS_PORTS.includes(s.port), false, '기본 포트 범위 밖')

  const found = await findOvis(process.platform, { XDG_CONFIG_HOME: join(home, '.config') }, { home, ports: [] })
  assert.deepEqual(found.map((o) => o.port).sort(), [app.port, plugin.port, plain.port, locked.port].sort(), '살아 있는 pid 의 포트만 물었다')
  assert.equal(gone.requests.length, 0, '죽은 pid 의 포트에는 요청이 가지 않는다')
  assert.deepEqual(bare(byPort(found, app.port)), { port: app.port, answered: true, signed: true, serving: 'herdr-core', core: CORE, webOpen: true })
  assert.deepEqual(bare(byPort(found, plugin.port)), { port: plugin.port, answered: true, signed: true, serving: 'herdr', core: null, webOpen: true })
  assert.deepEqual(byPort(found, plain.port), { port: plain.port, answered: true, signed: false })
  assert.deepEqual(bare(byPort(found, locked.port)), { port: locked.port, answered: true, signed: true, serving: 'herdr-core', core: null, webOpen: false })
  // 요청은 읽기(GET /api/health)뿐이고, 코어 이름은 herdr-core 를 보여 준다고 한 서버에만 한 번 더 묻는다. token 은 어디에도 실리지 않는다.
  assert.deepEqual(app.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/health?scope=bridge', 'GET /api/health'])
  assert.deepEqual(plugin.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/health?scope=bridge'])
  assert.deepEqual(plain.requests.map((r) => `${r.method} ${r.path}`), ['GET /api/health?scope=bridge'])
  assert.doesNotMatch(JSON.stringify([found, app.requests, plugin.requests, plain.requests, locked.requests]), /tok-/)
  // 등록부가 없으면(폴더 없음) 찾은 것이 없다 — 오류도 없다
  assert.deepEqual(await findOvis(process.platform, {}, { home: join(dir, 'home-empty'), ports: [] }), [])

  // 레인·코어 프로필: 프로세스에서 읽는 값은 떼고, 플러그인판 서버에는 격리 데스크의 소켓을 붙여 본다
  const ovis = found.map(bare).map((o) => (o.port === plugin.port ? { ...o, socket: DESK.socket } : o))
  const r = evaluate(facts({ herdr: { found: true, sessions: [DESK] }, ovis }))
  assert.deepEqual(r.cores, [{ name: CORE, focus: false, url: coreUrl(app.port), features: FEAT_ON }], 'herdr-core 를 보여 주는 서버만 프로필이 된다(앱 안의 세션으로 보낼 수단이 없음을 분명히 적고, 되는 기능을 함께 적는다)')
  assert.equal(r.cores.some((c) => ['pccore', 'hidden', 'ghost'].includes(c.name)), false, 'serving 이 herdr 인 서버·코어 이름을 숨긴 서버는 프로필을 만들지 않는다')
  assert.equal(val(r.lanes, `core:${CORE}`), app.port)
  assert.match(r.lanes.find((l) => l.key === `core:${CORE}`).reason, new RegExp(`^an app shows herdr-core "${CORE}" \\(server on ${app.port}\\)$`))
  assert.ok(has(r.lanes, `core_candidate:${locked.port}`) && val(r.lanes, `core_candidate:${locked.port}`) === undefined, '코어 이름을 모르면 확인 필요 후보')
  assert.equal(val(r.lanes, 'open_url:work'), ovisUrl(plugin.port), 'herdr 데스크를 보여 주는 서버는 기존 흐름(데스크의 웹 터미널 주소) — 포트가 범위 밖이어도')
  assert.equal(r.lanes.some((l) => String(l.key).includes(String(plain.port)) || String(l.reason).includes(String(plain.port))), false, '서명 없는 서버는 어디에도 없다')
  assert.equal(has(r.lanes, `open_url:${CORE}`), false, '앱 코어의 서버를 herdr 데스크의 웹 터미널 주소로 쓰지 않는다')
  assert.deepEqual(r.summary.cores, [{ name: CORE, app: null, web: true }])
  assert.deepEqual(r.summary.ovis.map((o) => [o.port, o.session, o.confirmed]), [[plugin.port, 'work', true]], '웹 터미널 목록에는 herdr 데스크의 것만')
  assert.doesNotMatch(JSON.stringify(r.summary), /\/iso\/|\/app\/|\.sock/, '화면용 요약에는 경로가 없다')
})

test('코어 프로필: 앱 이름은 맥에서 찾았을 때만, 웹 주소는 인증 없이 열릴 때만, 이름이 틀리면 싣지 않고, 기본 코어와 이름이 같아도 focus:false', () => {
  assert.deepEqual(coreProfiles(facts({ ovis: [APP_CORE] })), [{ name: CORE, focus: false, app: APP, url: coreUrl(48111), features: FEAT_ON }])
  assert.match(laneOvis(facts({ ovis: [APP_CORE] })).find((l) => l.key === `core:${CORE}`).reason, new RegExp(`^${APP} shows herdr-core "${CORE}" \\(server on 48111\\)$`))
  assert.deepEqual(coreProfiles(facts({ platform: 'linux', ovis: [APP_CORE] })), [{ name: CORE, focus: false, url: coreUrl(48111), features: FEAT_ON }], '맥 밖에서는 앱 이름을 뺀다')
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, app: 'Bad"; do evil' }] })), [{ name: CORE, focus: false, url: coreUrl(48111), features: FEAT_ON }], '받을 수 없는 글자의 앱 이름은 뺀다')
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, webOpen: false }] })), [{ name: CORE, focus: false, app: APP, features: FEAT_OFF(APP) }], '인증이 필요한 서버의 주소는 싣지 않는다 — 되는 기능도 서버 없이 되는 것뿐이다(닫기는 코어에서 직접)')
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, webOpen: undefined }] })), [{ name: CORE, focus: false, app: APP, features: FEAT_OFF(APP) }], '판단할 수 없으면 싣지 않는다')
  assert.deepEqual(coreProfiles(facts({ platform: 'linux', ovis: [{ ...APP_CORE, webOpen: false }] })), [{ name: CORE, focus: false, features: FEAT_OFF(null) }], '앱 이름도 모르면 이동은 터미널 창이다')
  for (const core of ['..', 'a/b', '', null]) assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, core }] })), [], `코어 이름 ${core}`)
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, signed: false }] })), [], '서명 없는 서버')
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, serving: 'herdr' }] })), [], 'herdr 데스크를 보여 주는 서버')
  assert.deepEqual(coreProfiles(facts({ ovis: [{ ...APP_CORE, serving: null }] })), [], '무엇을 보여 주는지 모르는 서버')
  // 같은 코어를 보여 주는 서버가 둘이면 먼저 찾은 것 하나만
  const two = evaluate(facts({ ovis: [APP_CORE, { ...APP_CORE, port: 48112, app: 'Other' }] }))
  assert.deepEqual(two.cores, [{ name: CORE, focus: false, app: APP, url: coreUrl(48111), features: FEAT_ON }])
  assert.match(two.lanes.find((l) => l.key === 'core_candidate:48112').reason, /check$/)
  // 기본 코어와 이름이 같은 코어를 자기 것으로 띄우는 앱: 프로필을 싣고 보기 전용임을 분명히 적는다(적지 않으면 herdr-app 대상으로 읽힌다)
  const same = evaluate(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [{ ...APP_CORE, core: 'default' }] }))
  assert.deepEqual(same.cores, [{ name: 'default', focus: false, app: APP, url: coreUrl(48111), features: FEAT_ON }])
  assert.deepEqual(same.summary.herdr_core, { running: true, view_only: true })
  assert.deepEqual(evaluate(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [APP_CORE] })).summary.herdr_core, { running: true, view_only: false })
  // 화면 요약은 런타임이 실제로 읽는 코어만: HC_SESSION·HC_SOCKET 으로 코어 하나를 짚었거나 WHOSUP_CORES 로 묶어 두었으면 그 밖의 코어는 보이지 않는다
  assert.deepEqual(evaluate(facts({ coreScope: coreScopeOf({ HC_SESSION: 'mine' }), ovis: [APP_CORE] })).summary.cores, [])
  assert.deepEqual(evaluate(facts({ coreScope: coreScopeOf({ WHOSUP_CORES: 'none' }), ovis: [APP_CORE] })).summary.cores, [])
  assert.deepEqual(evaluate(facts({ coreScope: coreScopeOf({ WHOSUP_CORES: `other, ${CORE}` }), ovis: [APP_CORE] })).summary.cores, [{ name: CORE, app: APP, web: true }])
  // 이름 규칙에 안 맞는 HC_SESSION 은 런타임(core.mjs sessionEnv)처럼 주지 않은 것으로 본다: 범위를 좁히지 않는다.
  assert.deepEqual(coreScopeOf({ HC_SESSION: 'a/b' }), { base: 'default', only: null })
  assert.deepEqual(coreScopeOf({ HC_SESSION: '..' , WHOSUP_CORES: `${CORE}, ../x` }), { base: 'default', only: ['default', CORE] })
  assert.deepEqual(coreScopeOf({ HC_SESSION: 'mine' }), { base: 'mine', only: ['mine'] })
  assert.deepEqual(evaluate(facts({ coreScope: coreScopeOf({ WHOSUP_CORES: 'all' }), ovis: [APP_CORE] })).summary.cores.length, 1)
  assert.deepEqual(coreScopeOf({}), { base: 'default', only: null })
  assert.deepEqual(coreScopeOf({ HC_SOCKET: '/x.sock' }), { base: 'default', only: ['default'] })
  // ovis 가 없으면 cores 는 빈 목록이다(Herdr 앱 코어는 프로필 없이 예전처럼 동작한다)
  assert.deepEqual(evaluate(facts({ herdrCore: { running: true, socket: '/c' }, herdrApp: { found: true, bin: 'herdr-app' } })).cores, [])
})

test('앱 이름 찾기: 실행 파일 경로의 바깥 앱 이름, 서버와 가장 가까운 조상의 것 — 터미널에서 띄운 서버면 찾지 않는다', () => {
  assert.equal(appOfPath(`/Applications/${APP}.app/Contents/Resources/srv/bin/run`), APP)
  assert.equal(appOfPath(`/Applications/${APP}.app/Contents/MacOS/${APP}`), APP)
  assert.equal(appOfPath('/Applications/My Editor.app/Contents/Frameworks/My Editor Helper.app/Contents/MacOS/My Editor Helper'), 'My Editor', '도우미 앱이면 바깥 앱')
  assert.equal(appOfPath('/opt/homebrew/bin/node'), null)
  assert.equal(appOfPath('/x/Bad"Name.app/Contents/MacOS/x'), null, '받을 수 없는 글자')
  assert.equal(appOfPath(`/x/${'L'.repeat(61)}.app/Contents/MacOS/x`), null, '60자 넘는 이름')
  assert.equal(appOfPath(''), null)
  assert.equal(appOfChain([{ tty: '??', path: '/opt/homebrew/bin/node' }, { tty: '??', path: `/Applications/${APP}.app/Contents/MacOS/${APP}` }, { tty: '??', path: '/sbin/launchd' }]), APP)
  assert.equal(appOfChain([{ tty: '??', path: `/Applications/${APP}.app/Contents/Resources/srv/bin/run` }, { tty: '??', path: '/Applications/Outer.app/Contents/MacOS/Outer' }]), APP, '서버 자신이 앱 묶음 안에 있으면 그 앱')
  assert.equal(appOfChain([{ tty: 'ttys003', path: '/opt/homebrew/bin/node' }, { tty: 'ttys003', path: '/bin/zsh' }, { tty: '??', path: '/Applications/Someterm.app/Contents/MacOS/someterm' }]), null, '터미널에서 띄운 서버: 조상의 앱은 터미널 앱이다')
  assert.equal(appOfChain([{ tty: '??', path: '/opt/homebrew/bin/node' }, { tty: '??', path: '/sbin/launchd' }]), null)
  assert.equal(appOfChain([]), null)
})

test('같은 이름의 다른 herdr(F29): 서버의 HERDR_SOCKET을 아는데 herdr가 같은 이름의 데스크를 다른 소켓으로 보여 주면 확정하지 않는다', () => {
  const other = { port: 7317, answered: true, signed: true, socket: '/other-home/sessions/work/herdr.sock', sessionEnv: 'work' }
  const r = laneOvis(facts({ herdr: { found: true, sessions: [DESK] }, ovis: [other] }))
  assert.equal(has(r, 'open_url:work'), false, '이름만 같은 데스크와 맞추지 않는다')
  assert.equal(val(r, 'ovis_candidate:7317'), undefined)
  assert.match(r.find((l) => l.key === 'ovis_candidate:7317').reason, /named "work" on another socket .* — check$/)
  // HERDR_SESSION 이름으로 다시 맞지도 않는다(소켓을 아는 한 소켓이 먼저다)
  assert.equal(has(laneOvis(facts({ herdr: { found: true, sessions: [DESK] }, ovis: [{ ...other, socket: '/odd/path.sock' }] })), 'open_url:work'), false)
  // 그 결과 설치 질문에 "세션을 여는 곳"이 나오지 않고, 요약에는 확인 필요로 남는다
  const f = facts({ herdr: { found: true, sessions: [DESK] }, ovis: [other] })
  assert.equal(keysAsked(f).includes('click_target'), false)
  assert.deepEqual(evaluate(f).summary.ovis.map((o) => [o.port, o.session, o.confirmed]), [[7317, null, false]])
  // 같은 소켓이면 예전처럼 확정한다 — 글자가 달라도 푼 경로(socketReal)가 같으면 같은 소켓이다(/tmp 와 /private/tmp)
  assert.equal(val(laneOvis(facts({ herdr: { found: true, sessions: [DESK] }, ovis: [{ ...other, socket: DESK.socket }] })), 'open_url:work'), ovisUrl(7317))
  const linked = { ...DESK, socket: '/tmp/h/sessions/work/herdr.sock', socketReal: '/private/tmp/h/sessions/work/herdr.sock' }
  assert.equal(val(laneOvis(facts({ herdr: { found: true, sessions: [linked] }, ovis: [{ ...other, socket: '/private/tmp/h/sessions/work/herdr.sock', socketReal: '/private/tmp/h/sessions/work/herdr.sock' }] })), 'open_url:work'), ovisUrl(7317))
  // 서버의 소켓을 모를 때(HERDR_SESSION 만)와 herdr 가 그 데스크의 소켓을 알려 주지 않을 때의 이름 일치는 그대로다
  assert.equal(val(laneOvis(facts({ herdr: { found: true, sessions: [DESK] }, ovis: [{ port: 7317, signed: true, sessionEnv: 'work' }] })), 'open_url:work'), ovisUrl(7317))
  assert.equal(val(laneOvis(facts({ herdr: { found: true, sessions: [{ name: 'work', status: 'running', socket: null }] }, ovis: [other] })), 'open_url:work'), ovisUrl(7317))
})

test('설치 질문: 터미널 앱은 켜져 있는 herdr 데스크가 있을 때만, Herdr 앱 세션을 여는 곳은 herdr-app으로 보낼 수 있는 코어가 있을 때만 묻는다', () => {
  // herdr 가 없는 환경(오비스 앱만 / Herdr 앱만 / 아무것도 없음)과 herdr 를 방금 깔았거나 꺼 둔 환경: 터미널 앱을 묻지 않는다
  const ovisOnly = facts({ ovis: [APP_CORE] })
  const herdrAppOnly = facts({ herdrCore: { running: true, socket: '/c' }, herdrApp: { found: true, bin: 'herdr-app' } })
  const justInstalled = facts({ herdr: { found: true, version: 'herdr 0.9.5', sessions: [] } })
  const herdrOff = facts({ herdr: { found: true, version: 'herdr 0.9.5', sessions: [{ ...DESK, status: 'stopped' }] } })
  assert.deepEqual(keysAsked(ovisOnly), ['agent_cmd'], '오비스 앱만: 에이전트 명령만')
  assert.deepEqual(keysAsked(herdrAppOnly), ['core_target', 'agent_cmd'], 'Herdr 앱만: Herdr 앱 세션을 여는 곳과 에이전트 명령')
  assert.deepEqual(keysAsked(facts()), ['agent_cmd'], '아무것도 없음')
  assert.deepEqual(keysAsked(justInstalled), ['agent_cmd'], 'herdr 를 방금 깐 경우(데스크 없음)')
  assert.deepEqual(keysAsked(herdrOff), ['agent_cmd'], 'herdr 가 꺼져 있음')
  // 켜져 있는 데스크가 하나라도 있으면 묻는다
  const herdrOn = facts({ herdr: { found: true, version: 'herdr 0.9.5', sessions: [DESK] } })
  assert.deepEqual(keysAsked(herdrOn), ['front_app', 'agent_cmd'])
  assert.deepEqual(keysAsked(facts({ herdr: herdrOn.herdr, ovis: [APP_CORE] })), ['front_app', 'agent_cmd'], 'herdr + 오비스 앱: Herdr 앱 세션을 여는 곳은 묻지 않는다')
  assert.deepEqual(keysAsked(facts({ herdr: herdrOn.herdr, herdrCore: { running: true, socket: '/c' }, herdrApp: { found: true, bin: 'herdr-app' } })), ['front_app', 'core_target', 'agent_cmd'])
  // 보기 전용 앱의 코어뿐이면 Herdr 앱 세션을 여는 곳을 묻지 않는다 — 그 코어가 기본 코어 이름을 쓰고 떠 있어도
  assert.equal(keysAsked(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [{ ...APP_CORE, core: 'default' }] })).includes('core_target'), false)
  assert.equal(keysAsked(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [APP_CORE] })).includes('core_target'), true, 'Herdr 앱 코어도 같이 떠 있으면 묻는다')
  // 보드의 첫 실행 안내(index.html choiceRows)도 같은 조건으로 같은 줄을 낸다
  for (const f of [ovisOnly, herdrAppOnly, facts(), justInstalled, herdrOff, herdrOn, facts({ herdr: herdrOn.herdr, ovis: [APP_CORE] }), facts({ herdrCore: { running: true, socket: '/c' }, ovis: [{ ...APP_CORE, core: 'default' }] })]) {
    for (const lang of ['en', 'ko']) {
      assert.deepEqual(setupRows(viewOf(f), TEXT[lang]), board.choiceRows(viewOf(f), I18N[lang]))
      assert.deepEqual(setupRows(viewOf(f), TEXT[lang], { firstRun: true }), board.choiceRows(viewOf(f), I18N[lang], { firstRun: true }))
    }
  }
  // 오비스 앱만(웹 터미널 없음): 보드의 첫 실행 안내도 세션을 여는 곳(터미널 창 하나)을 싣지 않는다 — 설정에는 그대로 있다
  assert.equal(board.choiceRows(viewOf(ovisOnly), I18N.ko, { firstRun: true }).some((r) => r.key === 'click_target'), false)
  assert.equal(board.choiceRows(viewOf(ovisOnly), I18N.ko).some((r) => r.key === 'click_target'), true)
})

test('화면 문구: 감지한 앱 코어를 한 줄로 — 설치 요약·마무리 문구·보드의 "감지한 환경"(영어·한국어), 앱 이름을 못 찾았으면 코어 이름으로', async () => {
  const s = evaluate(facts({ ovis: [APP_CORE] })).summary
  const noApp = evaluate(facts({ ovis: [{ ...APP_CORE, app: undefined }] })).summary
  for (const lang of ['en', 'ko']) {
    const T = TEXT[lang]
    assert.equal(T.envCoreSeen(CORE, APP), I18N[lang].envCoreSeen(CORE, APP), '터미널과 보드가 같은 글자')
    assert.equal(T.envCoreSeen(CORE, ''), I18N[lang].envCoreSeen(CORE, ''))
    // 자기 서버(웹 주소)로 코어를 보여 주는 앱의 세션은 보드에서 누르면 브라우저 탭으로 열린다: 터미널도 그렇게 말한다(앱 창이 앞으로 온다고 하지 않는다).
    assert.equal(s.cores[0].web, true)
    assert.deepEqual(coreLines(s, T, NOLINK), [T.envCoreSeen(CORE, APP, 'tab')])
    assert.equal(T.envCoreSeen(CORE, APP, 'tab'), I18N[lang].envCoreSeen(CORE, APP, 'tab'), '탭 문구도 터미널과 보드가 같은 글자')
    assert.notEqual(T.envCoreSeen(CORE, APP, 'tab'), T.envCoreSeen(CORE, APP))
    assert.deepEqual(board.envCoreLines({ ...s, cores: s.cores.map((c) => ({ ...c, show: 'tab' })) }, I18N[lang]), coreLines(s, T, NOLINK))
    // 깔린 그 앱이 ovis:// 링크를 알면 그 앱 창에서 열린다('app' — 보드의 coreShowOf 가 실시간 features(app_link)로 내는 값과 같다).
    // 링크 여부를 알아보다 실패하면 예전 그대로 탭이라고 말한다. 웹 주소가 없는 코어는 링크를 묻지도 않는다.
    const asked = []
    assert.deepEqual(coreLines(s, T, { link: (app) => { asked.push(app); return true } }), [T.envCoreSeen(CORE, APP, 'app')])
    assert.deepEqual(asked, [APP], '그 코어의 앱 이름으로 묻는다')
    assert.deepEqual(board.envCoreLines({ ...s, cores: s.cores.map((c) => ({ ...c, show: 'app' })) }, I18N[lang]), coreLines(s, T, { link: () => true }))
    assert.deepEqual(coreLines(s, T, { link: () => { throw new Error('boom') } }), [T.envCoreSeen(CORE, APP, 'tab')])
    assert.deepEqual(coreLines({ ...s, cores: s.cores.map((c) => ({ ...c, web: false })) }, T, { link: () => { throw new Error('asked') } }), [T.envCoreSeen(CORE, APP)])
    // 웹 주소가 없는 앱 코어(Herdr 앱 등)는 예전 그대로 앱 창이 앞으로 온다고 말한다
    const noWeb = { ...s, cores: s.cores.map((c) => ({ ...c, web: false })) }
    assert.deepEqual(coreLines(noWeb, T), [T.envCoreSeen(CORE, APP)])
    assert.deepEqual(board.envCoreLines(noWeb, I18N[lang]), coreLines(noWeb, T))
    assert.match(coreLines(s, T, NOLINK)[0], new RegExp(APP)); assert.doesNotMatch(coreLines(s, T, NOLINK)[0], new RegExp(CORE), '앱 이름을 알면 앱 이름으로 말한다')
    assert.match(coreLines(noApp, T)[0], new RegExp(`"${CORE}"`), '앱 이름을 못 찾았으면 코어 이름으로 말한다')
    assert.ok(summaryLines(s, T).join(' ').includes(T.sumCore(APP)))
    assert.ok(summaryLines(noApp, T).join(' ').includes(CORE))
    assert.deepEqual(coreLines(evaluate(facts()).summary, T), [])
    assert.deepEqual(coreLines(null, T), [])
    // 마무리 문구: "바꾸려면 보드의 설정에서" 줄 바로 앞에 싣는다. 덧붙일 줄이 없으면 예전 그대로다.
    const plain = closingLines({ state: 'no_herdr', id: 'x.y', env: {}, platform: 'darwin' }, T)
    const withNote = closingLines({ state: 'no_herdr', id: 'x.y', env: {}, platform: 'darwin', notes: coreLines(s, T, NOLINK) }, T)
    assert.deepEqual(withNote.filter((l) => l !== T.envCoreSeen(CORE, APP, 'tab')), plain)
    assert.equal(withNote.indexOf(T.envCoreSeen(CORE, APP, 'tab')), withNote.indexOf(T.change) - 1)
  }
  assert.match(TEXT.ko.envCoreSeen(CORE, APP), /세션/); assert.doesNotMatch(TEXT.ko.envCoreSeen(CORE, APP) + TEXT.ko.sumCore(APP), /칸|카드|pane/)
  assert.match(html, /envCoreLines\(s, T\)/, '보드의 "감지한 환경" 단락이 그 줄을 그린다(첫 실행 안내와 설정이 같이 쓴다)')
  // 보드의 "감지한 환경" 요약: 보기 전용 앱의 코어뿐이면 Herdr 앱은 '없음'이다
  const parts = Object.fromEntries(board.envSummaryParts(evaluate(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [{ ...APP_CORE, core: 'default' }] })).summary, I18N.en))
  assert.equal(parts[I18N.en.envApp], I18N.en.envNone)
  // 첫 실행 안내의 요약은 그 '없음'을 싣지 않는다: 세션을 띄울 곳(보기 전용 앱의 코어)을 찾았다
  const frParts = Object.fromEntries(board.envSummaryParts(evaluate(facts({ herdrCore: { running: true, socket: '/c' }, ovis: [{ ...APP_CORE, core: 'default' }] })).summary, I18N.en, { firstRun: true }))
  assert.equal(frParts[I18N.en.envApp], undefined); assert.ok(Object.values(frParts).every((v) => v !== I18N.en.envNone))

  // 설치(터미널)에서 실제로 찍히는 글자: 감지 요약에 앱의 세션, 마무리에 한 줄. 터미널 앱은 묻지 않는다(herdr 없음).
  const term = () => { const input = new PassThrough(); const out = []; input.write('\n\n\n\n'); return { input, write: (x) => out.push(x), columns: 100, colors: false, close() {}, text: () => out.join('') } }
  const run = async (over) => {
    const home = mkdtempSync(join(tmpdir(), 'wac-home-'))
    const t = term()
    const r = await runSetup({
      install: true, env: { HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), WHOSUP_LANG: 'en', WHOSUP_SETUP_TIMEOUT_S: '5' }, home, platform: 'darwin', root: ROOT,
      terminal: t, detectFn: async () => facts({ ovis: [APP_CORE] }), herdrBin: null, installerPid: 0, spawnFn: () => { throw new Error('no helper in this test') }, ...over,
    })
    return { r, text: t.text() }
  }
  for (const over of [{}, { standalone: true }]) {
    const { r, text } = await run(over)
    assert.equal(r.state, 'done', text)
    assert.deepEqual(r.questions.map((q) => q.key), ['agent_cmd'], '오비스 앱만 있는 터미널 설치: 터미널 앱도 Herdr 앱 세션을 여는 곳도 묻지 않는다')
    assert.match(text, new RegExp(`Detected: .*${TEXT.en.sumCore(APP)}`))
    assert.ok(text.includes(TEXT.en.envCoreSeen(CORE, APP, 'tab')), text)
    assert.doesNotMatch(text, new RegExp(TEXT.en.askApp))
  }
})

// ── 끝에서 끝까지: 등록부 → 서버 확인 → 앱 이름 → auto.json → 런타임이 그 코어를 읽는다 → 보드에 세션 → 누르면 그 앱 창을 올린다 ──
// 맥에서는 가짜 앱(<임시>/<이름>.app/Contents/MacOS/<이름>)이 서버를 자식 프로세스로 띄운다 — 앱 이름을 프로세스 조상에서 실제로 읽는다.
// 맥 밖에서는 앱 이름을 찾지 않으므로 이 프로세스 안의 가짜 서버로 같은 길을 걷는다(앱 창 올리기 대신 보기까지만 본다).
async function startAppServer(home) {
  if (process.platform !== 'darwin') {
    const s = await fake({ serving: 'herdr-core', core: CORE, registry: regOf(home), token: TOKEN, socketPath: '/app/server/herdr-core.sock' })
    return { port: s.port, app: null }
  }
  const exe = join(dir, 'apps', `${APP}.app`, 'Contents', 'MacOS', APP)
  mkdirSync(dirname(exe), { recursive: true })
  symlinkSync(process.execPath, exe)
  // detached: 앱이 띄운 프로세스처럼 제어 터미널 없이 뜬다(시험을 터미널에서 돌려도)
  const child = spawn(exe, [FAKE_OVIS, '--parent', '--serving', 'herdr-core', '--core', CORE, '--registry', regOf(home), '--token', TOKEN], { stdio: ['ignore', 'pipe', 'inherit'], detached: true })
  closers.push(() => { try { process.kill(-child.pid, 'SIGTERM') } catch {} })
  const line = await new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => reject(new Error('the fake app server did not start')), 15000)
    child.stdout.on('data', (d) => { buf += d; const i = buf.indexOf('\n'); if (i >= 0) { clearTimeout(timer); resolve(buf.slice(0, i)) } })
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the fake app exited (${code})`)) })
  })
  return { port: JSON.parse(line).port, app: APP }
}

test('끝에서 끝까지: 등록부로 찾은 앱 코어가 auto.json에 실리고 런타임에 닿아 그 코어의 세션이 보드에 보인다(token은 어디에도 없다)', async () => {
  const home = join(dir, 'home-e2e')
  const { port, app } = await startAppServer(home)
  const C = await startNamedCore(STATE, CORE, join(dir, 'c.sock'))
  closers.push(() => C.close())
  C.add(appTerm('t1', { cwd: '/work/notes' }))
  C.add(agentTerm('t2', 'blocked', { labels: appTerm('t0').labels, cwd: '/work/notes' }))

  // 기준선: 자동 감지 전에는 기본 코어만 읽는다 — 그 코어는 없으므로 보이는 세션이 없다
  setAutoValues(null)
  assert.equal((await core.snapshotRuntime()).absent, true)

  const found = await findOvis(process.platform, { XDG_CONFIG_HOME: join(home, '.config') }, { home, ports: [] })
  assert.deepEqual(found.map(({ socket, socketReal, sessionEnv, why, ...o }) => o), [{ port, answered: true, signed: true, serving: 'herdr-core', core: CORE, webOpen: true, ...(app ? { app } : {}) }])
  const logs = []
  const stateDir = join(dir, 'auto-e2e')
  const r = await refreshAuto(stateDir, { detectFn: async () => ({ ...facts({ platform: process.platform, ovis: found }) }), onWriteError: (e) => logs.push(String(e)) })
  logs.push(JSON.stringify(r.lanes), JSON.stringify(r.reasons))
  const saved = readAuto(stateDir)
  const profile = { name: CORE, focus: false, ...(app ? { app } : {}), url: coreUrl(port), features: FEAT_ON }
  assert.deepEqual(saved.cores, [profile], 'auto.json 최상위 cores')
  assert.deepEqual(saved.summary.cores, [{ name: CORE, app, web: true }])
  assert.match(saved.lanes.find((l) => l.key === `core:${CORE}`).reason, new RegExp(`^${app || 'an app'} shows herdr-core "${CORE}" \\(server on ${port}\\)$`))
  const text = readFileSync(autoPath(stateDir), 'utf8')
  assert.doesNotMatch(text, /tok-/, 'token 은 auto.json 에 없다')
  assert.doesNotMatch(logs.join('\n'), /tok-/, 'token 은 기록할 글자에도 없다')
  assert.ok(text.includes(CORE))

  // 런타임에 닿는다: 그 코어의 세션이 스냅숏·DB·보드에 나온다(보기 전용 — 닫기·새 세션 없음)
  setAutoValues(saved)
  const rt = await core.snapshotRuntime()
  assert.deepEqual(rt.snap.sessions.map((s) => s.runtime_ref).sort(), [`${CORE}/t1`, `${CORE}/t2`])
  assert.equal(core.canManage(`${CORE}/t1`), false, '앱 안의 세션으로 보낼 수단이 없는 코어')
  // auto.json 에 적힌 되는 기능과 런타임이 판·서버 경로에 쓰는 값은 같은 함수에서 나온다: 어긋나지 않는다(검토 R2)
  assert.deepEqual(core.featuresOf(`${CORE}/t1`), saved.cores[0].features)
  assert.deepEqual(core.profilesView().find((c) => c.name === CORE), { name: CORE, app: app || null, features: saved.cores[0].features })
  assert.deepEqual(ovisRt.profileFeatures(saved.cores[0]), saved.cores[0].features)
  assert.equal(autoCores().some((c) => 'features' in c), false, '런타임이 읽는 프로필에는 그 값을 싣지 않는다 — 런타임은 url·app 에서 다시 계산한다')
  // 보드 서버 안에서 다시 감지할 때(자동 감지가 더한 코어가 이미 읽히는 중): 점검(doctor)은 기본 코어만 본다 —
  // 앱 코어가 떠 있다고 없는 Herdr 앱 코어를 '실행 중'으로 적지 않는다(그러면 "Herdr 앱 세션을 여는 곳"을 묻게 된다).
  assert.equal(core.available(), true, '읽는 코어 가운데 하나(앱 코어)는 떠 있다')
  const d = await diagnose()
  assert.equal(d.herdrCore.running, false, '기본 코어는 떠 있지 않다')
  assert.equal(d.herdr.found, false, '이 시험은 herdr 를 부르지 않는다(없는 경로)')
  assert.equal(keysAsked(facts({ herdrCore: d.herdrCore, herdrApp: d.herdrApp, ovis: found })).includes('core_target'), false)
  const db = openDb(':memory:')
  const { failure } = await collectAll(db)
  assert.equal(failure, null)
  const cards = Object.values((await computeBoardAsync(db)).columns).flat()
  assert.deepEqual(cards.map((c) => c.ref).sort(), [`${CORE}/t1`, `${CORE}/t2`])
  assert.equal(cards.every((c) => c.runtime === 'herdr-core'), true)
  const view = autoconfView(db)
  assert.deepEqual(view.summary.cores, [{ name: CORE, app, web: true }], '보드의 "감지한 환경"이 받는 요약')
  assert.equal(view.client_defaults[`whosup-open-url-core:${CORE}`], coreUrl(port), '그 코어의 웹 주소는 브라우저 기본값으로 내려간다 — 그 세션의 터미널 보기까지 적은 주소로(F18)')
  assert.equal(clientDefaults(db)[`whosup-open-url-core:${CORE}`], coreUrl(port), '자동 감지가 싣는 주소 틀이 이미 그 모양이다(보드 서버의 보정은 예전 auto.json 을 위한 것이다)')
  assert.notEqual(coreUrl(port), ovisUrl(port), 'herdr 데스크의 웹 터미널 주소 틀(ovisUrl)은 예전 그대로 view 가 없다')
  assert.equal(view.client_defaults['whosup-open-url-app'], 'on', '아무도 세션을 여는 곳을 정하지 않았다: 탭으로만 보여 줄 수 있는 세션은 누르면 탭도 연다')
  assert.equal(clientDefaults(db)['whosup-open-url-on'], 'off', '클릭 기본 동작은 그대로 터미널 창이다')
  assert.doesNotMatch(JSON.stringify(view), /tok-/)

  // 누르면: 앱 안의 그 세션으로 보낼 수단이 없으니 그 앱 창만 앞으로 올린다(앱 이름은 감지한 것 — 맥에서만)
  if (app) {
    const calls = []
    core._setWindowOps({ appRunning: async (n) => { calls.push(['running?', n]); return true }, raiseApp: async (n) => { calls.push(['raise', n]); return 'raised' }, openWindowRunning: async () => { calls.push(['terminal']); return 'off' } })
    const got = await core.focus(`${CORE}/t1`, { seq: Date.now() })
    assert.deepEqual(calls.filter((c) => c[0] === 'raise'), [['raise', APP]], '그 앱 창을 올리는 호출이 나간다')
    assert.equal(calls.some((c) => c[0] === 'terminal'), false)
    assert.equal(got.window, 'app_only')
    assert.deepEqual(C.touched().filter(([m]) => !['terminal.get', 'terminal.read'].includes(m)), [], '그 코어의 세션에는 아무것도 보내지 않았다')
  }
})

// ── 앱을 끈 뒤(F2-5): 그 앱의 서버가 등록부에서 빠져 다시 감지한 결과에 그 코어가 없어도, 코어는 따로 살아 있을 수 있다 ──
test('앱을 끈 뒤: 다시 감지한 결과에서 그 코어가 빠져도 열린 세션이 남아 있는 동안에는 계속 읽는다 — 살아 있는 코어의 세션이 닫힘으로 넘어가지 않는다', async () => {
  const QUIT = 'quitcore'
  const home = join(dir, 'home-quit')
  const s = await startFakeOvis({ serving: 'herdr-core', core: QUIT, registry: regOf(home), token: TOKEN, socketPath: '/quit/app.sock' })
  const C = await startNamedCore(STATE, QUIT, join(dir, 'q.sock'))
  closers.push(() => C.close())
  C.add(agentTerm('t1', 'blocked', { labels: appTerm('t0').labels, cwd: '/work/notes' }))
  const stateDir = join(dir, 'auto-quit')
  const detectFn = async () => facts({ platform: process.platform, ovis: await findOvis(process.platform, {}, { home, ports: [] }) })
  const db = openDb(':memory:')
  const row = () => db.prepare('SELECT status, archived, unreachable FROM session WHERE runtime_ref = ?').get(`${QUIT}/t1`)
  core.keepReading([])
  try {
    setAutoValues(await refreshAuto(stateDir, { detectFn }))
    assert.deepEqual(autoCores().map((c) => c.name), [QUIT])
    await collectAll(db)
    assert.deepEqual({ ...row() }, { status: 'blocked', archived: 0, unreachable: 0 })
    // 앱을 끈다: 서버가 닫히고 등록 파일의 pid 는 죽은 것이 된다. 다시 감지하면 그 코어의 프로필이 없다
    await s.close()
    writeBridgeFile(regOf(home), { port: s.port, pid: deadPid(), token: TOKEN, socketPath: '/quit/app.sock' })
    const again = await refreshAuto(stateDir, { detectFn })
    assert.deepEqual([again.cores, readAuto(stateDir).cores], [[], []])
    setAutoValues(again)
    let r
    for (let i = 0; i < 5; i++) r = await collectAll(db)      // 안 보인 횟수(3)를 넘길 만큼 수집해도
    assert.deepEqual({ ...row() }, { status: 'blocked', archived: 0, unreachable: 0 }, '코어가 살아 있으니 세션은 그대로다')
    assert.deepEqual([r.failure, r.notes], [null, []])
    const cards = Object.values((await computeBoardAsync(db)).columns).flat()
    assert.deepEqual(cards.map((c) => [c.ref, c.caps]), [[`${QUIT}/t1`, ['focus', 'close', 'web']]], '판에 남는다(앱이 꺼진 코어: 보기와 닫기 — 닫기는 코어 소켓으로 직접)')
    assert.equal(clientDefaults(db)[`whosup-open-url-core:${QUIT}`], undefined, '꺼진 앱의 웹 주소는 내려가지 않는다')
    // 코어도 꺼지면: 닫지 않고 확인 불가로 둔다(읽는 목록 안의 꺼진 코어와 같은 규칙)
    await C.close()
    for (let i = 0; i < 4; i++) r = await collectAll(db)
    assert.deepEqual({ ...row() }, { status: 'blocked', archived: 0, unreachable: 1 })
  } finally { setAutoValues(null); core.keepReading([]) }
})

// ── 보드보다 늦게 켠 앱: 단독 설치는 로그인 때 보드가 먼저 뜬다. 등록부에 서버가 들고 나면 "다시 감지" 단추 없이 다시 감지한다 ──
test('등록부 지켜보기: 앱 서버가 등록부에 들어오거나(늦게 켬) 나가거나(꺼짐) 포트가 바뀌면 한 번씩 알리고, 그대로면 부르지 않는다', async (t) => {
  const home = join(dir, 'home-late')
  const key = () => ovisRegistryKey({}, home)
  assert.equal(key(), '', '등록부 폴더가 아직 없다')
  t.mock.timers.enable({ apis: ['setInterval'] })
  let calls = 0
  const stop = watchOvisRegistry(() => { calls++ }, { everyMs: 1000, key })
  try {
    t.mock.timers.tick(1000); t.mock.timers.tick(1000)
    assert.equal(calls, 0, '바뀐 것이 없으면 부르지 않는다')
    // 보드가 뜬 뒤에 앱이 켜진다: 그 서버가 등록부에 들어온다
    const s = await fake({ serving: 'herdr-core', core: CORE, registry: regOf(home), token: TOKEN, socketPath: '/late/app.sock' })
    assert.equal(key(), `${s.port}:${process.pid}`)
    t.mock.timers.tick(1000)
    assert.equal(calls, 1, '들어오면 한 번')
    t.mock.timers.tick(1000)
    assert.equal(calls, 1, '같은 값이면 다시 부르지 않는다')
    // 그때 다시 감지하면 그 코어가 실린다(시작할 때의 감지에는 없었다)
    const found = await findOvis(process.platform, {}, { home, ports: [] })
    assert.deepEqual(evaluate(facts({ ovis: found.map(bare) })).cores.map((c) => c.name), [CORE])
    // 앱을 다시 켜서 포트가 바뀌었다(같은 등록 파일을 새 포트로 다시 쓴다)
    writeBridgeFile(regOf(home), { port: s.port + 1, pid: process.pid, token: TOKEN, socketPath: '/late/app.sock' })
    t.mock.timers.tick(1000)
    assert.equal(calls, 2, '포트가 바뀌면 한 번')
    // 앱이 꺼졌다: 파일은 남고 pid 는 죽었다
    writeBridgeFile(regOf(home), { port: s.port + 1, pid: deadPid(), token: TOKEN, socketPath: '/late/app.sock' })
    assert.equal(key(), '')
    t.mock.timers.tick(1000)
    assert.equal(calls, 3, '꺼지면 한 번')
    // 읽다가 실패해도 지켜보기는 멈추지 않고, 알리지도 않는다
    let boom = true
    const stop2 = watchOvisRegistry(() => { calls++ }, { everyMs: 1000, key: () => { if (boom) { boom = false; return 'a' } throw new Error('unreadable') } })
    t.mock.timers.tick(1000)
    stop2()
    assert.equal(calls, 3)
  } finally { stop() }
  t.mock.timers.tick(5000)
  assert.equal(calls, 3, '멈춘 뒤에는 부르지 않는다')
  assert.doesNotMatch(key(), /tok-/)
  // bin/whosup.mjs 가 이 지켜보기를 시작할 때의 감지보다 먼저 걸고, 바뀌면 다시 감지(redetect)한 뒤 살아 있는 설정에 반영하고, 끝낼 때 멈춘다
  const bin = readFileSync(join(ROOT, 'bin', 'whosup.mjs'), 'utf8')
  assert.ok(bin.indexOf('watchOvisRegistry(') > 0 && bin.indexOf('watchOvisRegistry(') < bin.indexOf('const savedAuto = readAuto('))
  assert.match(bin, /watchOvisRegistry\(\(\) => \{\s*coreRetry\.reset\(\)\s*redetect\(\)\.then\(\(\) => applyLiveSettings\(db\)\)/)
  assert.match(bin, /pendingCoreRetry\(\(\) => \{\s*redetect\(\)\.then\(\(\) => applyLiveSettings\(db\)\)/, '코어 이름을 아직 못 들은 서버가 있으면 잠시 뒤 다시 감지한다')
  assert.match(bin, /coreRetry\.check\(r\)[\s\S]*coreRetry\.check\(savedAuto\)[\s\S]*coreRetry\.check\(r\)/, '다시 감지·저장된 값·첫 감지 뒤에 모두 확인한다')
  assert.match(bin, /const stop = \(\) => \{[^\n]*stopRegistryWatch\(\)/)
})

test('서버 확인(probeOvis): 답 없는 포트는 null, herdr 데스크를 보여 주는 서버에는 한 번만 묻는다', async () => {
  const s = await fake({ serving: 'herdr', pcCore: 'pccore' })
  assert.deepEqual(await probeOvis(s.port, 2000), { port: s.port, answered: true, signed: true, serving: 'herdr', core: null, webOpen: true })
  assert.equal(s.requests.length, 1)
  const closed = await startFakeOvis({ serving: 'herdr-core', core: CORE })
  await closed.close()
  assert.equal(await probeOvis(closed.port, 1000), null)
})

test('방금 켠 앱: 서버가 코어 이름을 아직 알려 주지 않으면 잠시 뒤 다시 감지한다(끝내 알려 주지 않으면 그만둔다)', () => {
  // 실물(오비스 데스크톱 앱 0.5.3)은 켜진 직후 herdr_runtime 만 답하고 herdr_core 는 몇 초 뒤에 싣는다.
  const early = { port: 48390, answered: true, signed: true, serving: 'herdr-core', core: null, webOpen: true }
  const pending = evaluate(facts({ ovis: [early] }))
  const ready = evaluate(facts({ ovis: [APP_CORE] }))
  assert.equal(hasPendingCore(pending), true, 'herdr-core 를 보여 준다고 했지만 이름이 없는 서버 = 아직 기다리는 중')
  assert.deepEqual(pending.cores, [], '이름을 모르는 동안은 코어 프로필을 만들지 않는다')
  assert.equal(hasPendingCore(ready), false)
  assert.equal(hasPendingCore(evaluate(facts({ ovis: [APP_CORE, { ...APP_CORE, port: 48391 }] }))), false, '같은 코어를 보여 주는 둘째 서버는 기다릴 일이 아니다')
  assert.equal(hasPendingCore(null), false)
  assert.equal(hasPendingCore({ lanes: 'x' }), false)

  const timers = []
  let calls = 0
  const retry = pendingCoreRetry(() => { calls++ }, { everyMs: 5, max: 3, setTimer: (fn, ms) => { timers.push({ fn, ms }); return {} } })
  assert.equal(retry.check(ready), false, '기다릴 서버가 없으면 예약하지 않는다')
  assert.equal(retry.check(pending), true)
  assert.equal(retry.check(pending), false, '이미 예약돼 있으면 겹쳐 예약하지 않는다')
  assert.deepEqual(timers.map((t) => t.ms), [5])
  timers.shift().fn()
  assert.equal(calls, 1, '예약한 때가 되면 다시 감지한다')
  assert.equal(retry.check(pending), true); timers.shift().fn()
  assert.equal(retry.check(pending), true); timers.shift().fn()
  assert.equal(calls, 3)
  assert.equal(retry.check(pending), false, '정해진 횟수를 넘으면 그만 묻는다(토큰이 걸린 서버 등)')
  assert.equal(retry.check(ready), false)
  assert.equal(retry.check(pending), true, '이름을 들은 뒤에는 횟수가 처음으로 돌아간다')
  timers.shift().fn(); timers.length = 0
  for (let i = 0; i < 2; i++) { retry.check(pending); timers.shift().fn() }
  assert.equal(retry.check(pending), false)
  retry.reset()
  assert.equal(retry.check(pending), true, '등록부가 바뀌면(reset) 다시 묻기 시작한다')
})
