// rich 화면의 Node 쪽(src/setup.mjs): 터미널 첫 실행 안내(진행 줄 · "✓ 감지한 것" · 화살표 메뉴로 묻기)와 단독 설치의 설치 요약(standaloneBlocks).
// plain 화면은 지금까지의 줄 그대로다 — 같은 실행을 WHOSUP_UI=plain으로 돌려 바이트까지 같은지 본다(나머지 plain 단언은 setup.test.mjs·standalone.test.mjs).
// 실제 /dev/tty·herdr·네트워크에 닿지 않는다: 메뉴(runMenu)·감지·herdr 실행·터미널을 주입하고, 폴더는 임시 폴더만 쓴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { TEXT, UI_ENV_KEYS, closingLines, looseBlocks, readSetup, runSetup as runSetupRaw, standaloneBlocks, standaloneLines, tildeText, uiFor, uiForStdout, withoutUi } from '../src/setup.mjs'
import { pathAddCmd } from '../src/standalone.mjs'
import { renderBlocks, strWidth, stripAnsi } from '../src/tui.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const ID = 'fivetaku.whosup'
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(tmpdir())) process.env.TMPDIR = '/tmp'
const tmp = (name) => mkdtempSync(join(tmpdir(), `whosup-rich-${name}-`))
const runSetup = (o = {}) => { assert.ok(o.env.HOME.startsWith(tmpdir())); return runSetupRaw({ ...o, home: o.env.HOME }) }

const SOCK = '/s/sessions/main/herdr.sock'
const facts = (over = {}) => ({
  platform: 'darwin', release: '1', env: {}, node: { version: 'v22.13.0', sqlite: true },
  herdr: { found: true, version: 'herdr 0.9.5', sessions: [{ name: 'main', status: 'running', socket: SOCK }] },
  herdrCore: { running: false }, herdrApp: { found: false, bin: 'herdr-app' }, tools: {},
  terminal: { showing: null, installed: ['Terminal'] }, ovis: [], agents: { claude: '/bin/claude', codex: null, projectsDir: null },
  port: { start: 4790, free: 4790 }, ...over,
})
const OVIS = [{ port: 7317, answered: true, signed: true, socket: SOCK }]
const FULL = { terminal: { showing: 'Ghostty', installed: ['Ghostty', 'Terminal', 'iTerm'] }, ovis: OVIS, herdrApp: { found: true, bin: 'herdr-app' }, herdrCore: { running: true, socket: '/c' }, agents: { claude: '/bin/claude', codex: '/bin/codex', projectsDir: null } }
const HERDR_APP = { herdrApp: { found: true, bin: 'herdr-app' } }   // 물을 것 하나(Herdr 앱 세션을 여는 곳)
const RUNNING = [{ name: 'default', running: true, socket_path: '/x/herdr.sock', session_dir: '/x' }]

// 가짜 터미널: isTTY(진짜 터미널을 연 것처럼) · ttyCols(그 열 수)
const fakeTerm = (typed = '', more = {}) => { const input = new PassThrough(); const out = []; if (typed) input.write(typed); return { input, out, write: (s) => out.push(s), columns: 80, colors: false, close() {}, text: () => out.join(''), ...more } }
const fakeRun = ({ sessions = [] } = {}) => async (bin, args) => {
  const a = args.filter((x, i) => x !== '--session' && args[i - 1] !== '--session').join(' ')
  if (a === 'session list --json') return { ok: true, out: JSON.stringify({ sessions }) }
  if (a === 'plugin list') return { ok: true, out: 'No plugins installed.\n' }
  return { ok: false, out: '' }
}
// 가짜 메뉴: 질문마다 answers의 답을 돌려주고, 받은 인자를 적는다. 답이 함수면 그 인자로 부른다(신호를 기다리는 메뉴 등).
const fakeMenu = (answers) => {
  const calls = []
  const menu = async (o) => { calls.push(o); const a = answers[calls.length - 1] ?? { n: o.preset, how: 'key' }; return typeof a === 'function' ? a(o) : a }
  return { menu, calls }
}
const isoEnv = (home, over = {}) => ({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), ...over })
const RICH = (cols, over = {}) => ({ WHOSUP_UI: 'rich', WHOSUP_UI_COLS: String(cols), NO_COLOR: '1', LANG: 'en_US.UTF-8', ...over })
const setupWith = async ({ f = facts(), env = {}, answers = [], term = fakeTerm(), install = true, sessions = [], ...over } = {}) => {
  const home = tmp('home')
  const { menu, calls } = fakeMenu(answers)
  const r = await runSetup({
    install, env: isoEnv(home, env), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => f, run: fakeRun({ sessions }), herdrBin: 'herdr',
    spawnFn: () => 4242, installerPid: 777, alive: () => true, settleMs: 20, log: () => {}, menu, ...over,
  })
  return { r, home, term, calls, file: join(home, '.config', 'herdr', 'plugins', 'config', ID, 'setup.json') }
}
// 터미널이 그린 최종 화면: \r\x1b[K(그 줄 지우기)를 따라 줄을 고친다
const screen = (raw) => {
  const rows = ['']
  for (let i = 0; i < raw.length; i++) {
    if (raw.startsWith('\r\x1b[K', i)) { rows[rows.length - 1] = ''; i += 3; continue }
    const m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(raw.slice(i, i + 12))
    if (m) { i += m[0].length - 1; continue }
    if (raw[i] === '\n') rows.push(''); else if (raw[i] !== '\r') rows[rows.length - 1] += raw[i]
  }
  return rows
}
const fits = (rows, cols, isCmd = () => false) => { for (const l of rows) if (!isCmd(l)) assert.ok(strWidth(l, { amb: 2 }) <= cols - 1, `${cols}칸을 넘는다(${strWidth(l, { amb: 2 })}): ${JSON.stringify(l)}`) }

test('rich 첫 실행 안내 · 물을 것 없음: 진행 줄이 같은 자리에서 "✓ 감지한 것" 한 줄로 바뀌고, 제목·"고를 것이 없어" 줄은 싣지 않는다(설치기가 부른 설치)', async () => {
  for (const [lang, LANG, detected] of [['en', 'en_US.UTF-8', 'Detected: terminal app Terminal (default) · agents claude'], ['ko', 'ko_KR.UTF-8', '감지한 것: 터미널 앱 Terminal(기본) · 에이전트 claude']]) {
    const s = await setupWith({ env: RICH(80, { LANG, WHOSUP_FROM_INSTALLER: '1' }) })
    assert.equal(s.r.state, 'done')
    const run = lang === 'ko' ? '이 컴퓨터를 확인하는 중' : 'checking this machine'
    assert.equal(s.term.text(), `  … ${run}\r\x1b[K  ✓ ${detected}\n`, lang)
    assert.doesNotMatch(s.term.text(), /고를 것이 없어|Nothing to choose|첫 실행 안내|first-run setup|whosup:/)
    assert.equal(s.calls.length, 0, '묻지 않았다')
  }
  // 단독 설치(설치기 안)도 같다: 머리말은 설치기가 이미 찍었다
  const sa = await setupWith({ env: RICH(80), standalone: true, closing: false })
  assert.equal(sa.term.text(), '  … checking this machine\r\x1b[K  ✓ Detected: terminal app Terminal (default) · agents claude\n')
  // 감지한 것이 없으면 확인했다는 줄. 감지하지 못했으면 ! 줄(같은 자리)
  const none = await setupWith({ f: facts({ platform: 'linux', terminal: null, agents: {} }), env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }) })
  assert.equal(screen(none.term.text())[0], '  ✓ checked this machine')
  const failed = await setupWith({ env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }), detectFn: async () => { throw new Error('boom') } })
  assert.ok(screen(failed.term.text())[0].startsWith('  ! Could not check this machine'), failed.term.text())
  // NO_COLOR가 없어도 진행 줄은 흐리게 하지 않는다(흐리게는 키 안내 줄과 마지막 각주에만), ✓는 초록(그 밖의 색 없음)
  const color = await setupWith({ env: RICH(80, { NO_COLOR: '', WHOSUP_FROM_INSTALLER: '1' }) })
  assert.match(color.term.text(), /^ {2}… checking this machine\r\x1b\[K {2}\x1b\[32m✓\x1b\[0m Detected/)
  assert.doesNotMatch(color.term.text(), /\x1b\[2m/, '흐리게 없음')
  assert.doesNotMatch(color.term.text(), /\x1b\[3[3-7]m|\x1b\[9\dm/, '노랑·파랑·흰색·회색은 쓰지 않는다')
})

test('rich 첫 실행 안내 · 60칸·80칸: 긴 "감지한 것"은 내어쓰기로 나뉘고, 질문은 화살표 메뉴(제목·선택지·기본값·접는 이름) — Enter만 친 질문은 저장하지 않는다', async () => {
  for (const cols of [60, 80]) {
    const s = await setupWith({ f: facts(FULL), env: RICH(cols, { WHOSUP_FROM_INSTALLER: '1' }), sessions: RUNNING, answers: [{ n: 2, how: 'digit' }, { n: 1, how: 'key' }, { n: 2, how: 'key' }, { n: 1, how: 'key' }] })
    const rows = screen(s.term.text())
    fits(rows, cols)
    assert.match(rows[0], /^ {2}✓ Detected: terminal app Ghostty · Herdr app/)
    assert.ok(rows.length >= 2 && strWidth(rows[0], { amb: 2 }) > cols - 20, `폭을 채워 나눈다\n${rows.join('\n')}`)
    assert.ok(rows.slice(1).filter((l) => l.trim()).every((l) => /^ {4}\S/.test(l)), `이어지는 줄은 4칸 내어쓰기\n${rows.join('\n')}`)
    assert.equal(rows.join(' ').replace(/\s+/g, ' ').trim(), `✓ Detected: terminal app Ghostty · Herdr app · web terminal ovis 7317 (desk main) · agents claude, codex`)
    // 메뉴로 물은 것: 제목은 질문 문장, 접는 이름은 짧은 제목, 선택지 이름 아래 덧붙임 한 줄
    assert.deepEqual(s.calls.map((c) => c.title), [TEXT.en.uiAskClick, TEXT.en.uiAskApp, TEXT.en.uiAskCore, TEXT.en.uiAskCmd])
    assert.deepEqual(s.calls.map((c) => c.prefix), [TEXT.en.clickLabel, TEXT.en.appLabel, TEXT.en.chCore, TEXT.en.cmdLabel])
    assert.deepEqual(s.calls[0].options.map((o) => o.label), ['terminal window', 'web terminal', 'both'])
    assert.deepEqual(s.calls[1].options.at(-1), { label: 'auto', desc: [TEXT.en.autoNote] }, '"자동"은 뜻을 풀어 쓴 줄을 단다')
    assert.deepEqual(s.calls.map((c) => [c.preset, c.secs, c.lang, c.lead]), [[1, 120, 'en', true], [1, 120, 'en', true], [1, 120, 'en', true], [1, 120, 'en', true]])
    assert.deepEqual(s.calls.map((c) => c.afterDigit), [false, true, false, false], '번호로 고른 바로 다음 질문만 먼저 오는 Enter를 버린다')
    // 번호(2) · 옮겨서 Enter(2)는 정한 값, 처음 가리킨 값에서 Enter는 감지 값 그대로(저장하지 않음)
    assert.deepEqual(readSetup(s.file).choices, { click_target: 'web', core_target: 'terminal' })
    assert.doesNotMatch(s.term.text(), /Type a number|Saved:|Enter keeps/, '번호 입력 줄 · 저장했다는 줄 · Enter 안내는 메뉴가 대신한다')
  }
})

test('rich 메뉴의 끝: 시간 초과(남은 질문은 묻지 않음) · Ctrl-C(손 실행은 ✗ 그만둡니다) · 설치 명령이 죽으면 메뉴를 거둔다 · 메뉴를 못 띄우면 번호로 묻는다', async () => {
  const t = await setupWith({ f: facts(FULL), env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }), sessions: RUNNING, answers: [{ n: 2, how: 'digit' }, { n: 1, how: 'timeout' }] })
  assert.equal(t.calls.length, 2); assert.equal(t.r.ended, 'timeout'); assert.deepEqual(readSetup(t.file).choices, { click_target: 'web' })
  assert.match(t.term.text(), /\n\n {2}No input for 120 seconds: the remaining items keep their auto-detected\n {2}values\.\n$/, '80칸에서 두 줄, 같은 들여쓰기')
  // 맨 마지막 질문에서 시간이 다 됐으면 남은 질문이 없다: 그 줄을 싣지 않는다
  const last = await setupWith({ f: facts(HERDR_APP), env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }), answers: [{ n: 1, how: 'timeout' }] })
  assert.doesNotMatch(last.term.text(), /No input/); assert.match(last.term.text(), /\n\n {2}The board asks on first open\.\n$/, '하나도 답하지 않았다: 보드가 처음 열 때 묻는다')
  // 손 실행의 Ctrl-C: 저장 없이 ✗ 한 줄로 끝낸다
  const home = tmp('hand')
  const c = await setupWith({ f: facts(FULL), install: false, env: RICH(80, { HERDR_PLUGIN_CONFIG_DIR: join(home, 'conf') }), sessions: RUNNING, answers: [{ n: 2, how: 'digit' }, { n: 1, how: 'interrupt', signal: 'SIGINT' }] })
  assert.equal(c.r.state, 'interrupted'); assert.match(c.term.text(), /\n {2}✗ Stopped: nothing saved\.\n$/)
  assert.throws(() => readFileSync(join(home, 'conf', 'setup.json')), '저장하지 않았다')
  // 설치 명령이 죽었다(kill · 터미널 닫힘): 메뉴는 신호를 받아 끝나고, 아무것도 더 찍지 않는다
  let alive = true
  const gone = await setupWith({
    f: facts(FULL), env: RICH(80), sessions: RUNNING, watchMs: 10, alive: () => alive,
    answers: [(o) => new Promise((resolve) => { o.signal.addEventListener('abort', () => resolve({ n: o.preset, how: 'closed' })); setTimeout(() => { alive = false }, 30) })],
  })
  assert.equal(gone.r.state, 'cancelled'); assert.equal(gone.calls.length, 1)
  assert.match(gone.term.text(), /✓ Detected: [^\n]*\n {4}main\) · agents claude, codex\n$/, '그 뒤로는 찍지 않는다')
  assert.doesNotMatch(gone.term.text(), /The board|Stopped|No input/)
  // stty가 터미널을 바꾸지 못했다(noraw): 그 질문부터 번호로 묻는다(plain과 같은 질문 줄 · 같은 뜻)
  const nr = await setupWith({ f: facts(FULL), env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }), sessions: RUNNING, term: fakeTerm('3\n\n\n'), answers: [{ n: 2, how: 'digit' }, { n: 1, how: 'noraw' }] })
  assert.equal(nr.calls.length, 2)
  assert.match(nr.term.text(), /Enter keeps the value marked \*\. A number sets your own choice\.\n {2}With no answer for 120 seconds/)
  assert.match(nr.term.text(), /Type a number, or press Enter for 1: /)
  assert.deepEqual(readSetup(nr.file).choices, { click_target: 'web', front_app: 'iTerm' }, '메뉴로 고른 것과 번호로 고른 것을 함께 저장한다')
})

test('plain은 그대로: WHOSUP_UI=plain이면 터미널이고 TERM이 있어도 지금까지의 줄과 바이트까지 같다. 값이 없으면 터미널·TERM으로 정하고, 윈도우는 plain', async () => {
  const typed = '2\n\n\n\n'
  const base = await setupWith({ f: facts(FULL), sessions: RUNNING, term: fakeTerm(typed) })
  const tty = (env) => setupWith({ f: facts(FULL), sessions: RUNNING, term: fakeTerm(typed, { isTTY: true, ttyCols: 80 }), env })
  const plain = await tty({ TERM: 'xterm-256color', WHOSUP_UI: 'plain' })
  assert.equal(plain.term.text(), base.term.text()); assert.equal(plain.calls.length, 0)
  for (const env of [{ TERM: 'dumb' }, {}, { TERM: 'xterm', CI: '1' }]) {
    const p = await tty(env)
    if (env.CI) { assert.equal(p.r.state, 'skipped'); continue }
    assert.equal(p.term.text(), base.term.text(), JSON.stringify(env)); assert.equal(p.calls.length, 0)
  }
  const auto = await tty({ TERM: 'xterm-256color', LANG: 'en_US.UTF-8' })
  assert.equal(auto.calls.length, 4, '값이 없고 터미널 · TERM이 있으면 rich(메뉴로 묻는다)'); assert.match(stripAnsi(auto.term.text()), /✓ Detected/)
  assert.equal(uiFor({ env: { TERM: 'xterm' }, platform: 'win32', tty: true }).mode, 'plain', '윈도우는 화살표 메뉴를 쓰지 않는다')
  assert.equal(uiFor({ env: { TERM: 'xterm' }, platform: 'darwin', tty: false }).mode, 'plain')
  assert.deepEqual(uiFor({ env: { WHOSUP_UI: 'rich', WHOSUP_UI_COLS: '61' }, platform: 'linux' }), { mode: 'rich', color: true, utf8: false, width: 60 })
  assert.equal(uiFor({ env: { WHOSUP_UI: 'rich' }, tty: true, ttyCols: 70 }).width, 69, '터미널의 열 수가 먼저')
  assert.equal(uiForStdout({ env: { TERM: 'xterm' }, stdout: { isTTY: false } }).mode, 'plain', '표준 출력이 파이프면 plain')
  assert.equal(uiForStdout({ env: { WHOSUP_UI: 'rich' }, stdout: { isTTY: false } }).mode, 'rich', '설치기가 정해 넘긴 값')
})

test('rich 마무리 문구(설치기를 거치지 않은 herdr 설치 · 손 실행): 같은 내용을 폭에 맞춰 나누고, 칠 명령은 쪼개지 않는다', async () => {
  for (const cols of [60, 80]) {
    const s = await setupWith({ f: facts(), env: RICH(cols, { LANG: 'ko_KR.UTF-8' }), sessions: [] })
    const rows = screen(s.term.text())
    assert.ok(rows.some((l) => /^ {2}whosup 첫 실행 안내$/.test(l)), '설치기를 거치지 않았다: 제목을 둔다')
    const plainLines = closingLines({ state: 'herdr_off', id: ID, env: {}, platform: 'darwin' }, TEXT.ko)
    const cmds = plainLines.filter((l) => /^ {6}\S/.test(l)).map((l) => l.trim())
    for (const c of cmds) assert.ok(rows.some((l) => l.trim() === c), `칠 명령 "${c}"은 한 줄 통째로\n${rows.join('\n')}`)
    fits(rows, cols, (l) => cmds.includes(l.trim()))
    assert.doesNotMatch(s.term.text(), /고를 것이 없어/)
  }
  // 줄 → 블록: ':'로 끝나는 줄 아래의 더 들여 쓴 줄들만 명령이다
  assert.deepEqual(looseBlocks(['herdr is not running.', '  Type this:', '      herdr', '  It starts: http://x', '', 'To restart, type these two lines:', '    a stop', '    a start', '  The board:  http://y']), [
    ['para', 'herdr is not running.'], ['item', 'Type this:'], ['cmd', 'herdr'], ['item', 'It starts: http://x'], ['blank'],
    ['para', 'To restart, type these two lines:'], ['cmd', 'a stop'], ['cmd', 'a start'], ['item', 'The board:  http://y'],
  ])
})

// ── 단독 설치의 설치 요약(standaloneBlocks) ──
const HOME = '/Users/someone'
const UP = { up: true, url: 'http://127.0.0.1:4790', port: '4790' }
const OVIS_ENV = { pick: 'ovis-app', installed: true, app: `${HOME}/Applications/Ovis.app`, opened: true }
const draw = (f, T, cols, more = {}) => renderBlocks(standaloneBlocks({ home: HOME, ...f }, T), { width: cols - 1, color: false, utf8: true, ...more })

test('rich 설치 요약 · 60칸·80칸: ✓ 끝났다 → 다음에 할 일 → 설치한 것 → 명령 → 설정 각주. 경로는 ~로 · 쪼개지 않음, 같은 경로는 한 번', () => {
  for (const cols of [60, 80]) {
    for (const [T, done, next, inst, cmds, foot] of [[TEXT.ko, '✓ whosup 설치를 마쳤습니다', '다음에 할 일', '설치한 것', '명령', '설정은 보드의 설정 화면에서 바꿉니다.'], [TEXT.en, '✓ whosup is installed', 'Next', 'Installed', 'Commands', "Change settings in the board's settings."]]) {
      const rows = draw({ kind: 'install', app: `${HOME}/.local/share/whosup/app`, board: UP, opens: true, login: 'on', env: OVIS_ENV }, T, cols)
      const at = (s) => rows.findIndex((l) => l.trim() === s)
      assert.ok(at(done) === 1 && at(next) > at(done) && at(inst) > at(next) && at(cmds) > at(inst) && at(foot) === rows.length - 1, rows.join('\n'))
      assert.equal(rows[0], '', '빈 줄로 시작한다')
      fits(rows, cols)
      const text = rows.join('\n')
      assert.ok(!text.includes(HOME), `집 폴더는 ~로\n${text}`)
      assert.equal(text.split('~/.local/share/whosup/app').length, 2, '앱 경로는 한 번'); assert.equal(text.split('~/Applications/Ovis.app').length, 2)
      // 다음에 할 일: 1. 앱이 열렸다 2. 브라우저의 보드에서 새 세션 + 주소(번호 글자에 맞춰 7칸)
      assert.match(rows[at(next) + 1], /^ {4}1\. /); assert.ok(rows.some((l) => l === '       http://127.0.0.1:4790'), text)
      assert.match(text, /whosup autostart off/); assert.match(text, /whosup help/)
      assert.doesNotMatch(text, /whosup install summary|whosup 설치 요약|start · stop · status · update · uninstall/, 'plain 요약의 긴 문장은 없다')
    }
  }
  // 60칸: 표의 값이 넘치면 값 열에 맞춰 내어쓴다
  const r60 = draw({ kind: 'install', app: `${HOME}/.local/share/whosup/app`, board: UP, opens: true, login: 'on', env: OVIS_ENV }, TEXT.ko, 60)
  const b = r60.findIndex((l) => /^ {4}보드 +http/.test(l))
  assert.match(r60[b + 1], /^ {14}켜집니다$/, r60.join('\n'))
})

test('rich 설치 요약의 갈래: 보드 꺼짐·실패, 원격, 로그인 꺼짐·없음·실패, 다음 로그인부터, 새 버전, 다시 하는 첫 실행 안내, 긴 명령 경로, 색·ASCII', () => {
  const T = TEXT.en
  const txt = (f, cols = 80, more) => draw(f, T, cols, more).join('\n')
  const down = txt({ kind: 'install', board: { up: false }, login: 'off' })
  assert.match(down, /Next\n {4}The board is not running\. Start it by typing this in a terminal:\n {6}whosup start\n/)
  assert.match(down, /board +not running · does not start by itself when you log in/); assert.match(down, /whosup autostart on +start at login/)
  assert.match(txt({ board: { up: false, log: `${HOME}/.local/state/whosup/server.log` }, login: 'on' }), /The board did not start \(log: ~\/\.local\/state\/whosup\/server\.log\)/)
  const remote = txt({ board: UP, desktop: false, login: 'on' })
  assert.match(remote, /1\. Open this address in a browser on this computer, then start a new\n {7}session in the board\.\n {7}http:\/\/127\.0\.0\.1:4790\n {4}2\. From another device, forward the port first:\n {7}ssh -L 4790:127\.0\.0\.1:4790 <host>/)
  const none = txt({ board: UP, login: 'none' })
  assert.match(none, /Good to know\n {4}This computer has no user service manager/); assert.doesNotMatch(none, /autostart/, '쓸 수 없는 autostart는 싣지 않는다')
  const failed = txt({ board: UP, login: 'failed' })
  assert.match(failed, /Could not set it to start when you log in\. To try that again, type this in\n {4}a terminal:\n {6}whosup autostart on/); assert.equal(failed.split('autostart on').length, 2, '다시 등록하는 명령은 한 번')
  assert.match(txt({ board: UP, login: 'on', loginLoad: 'failed' }), /starts at login, from your next login/)
  const upd = txt({ kind: 'update', app: '/a', board: UP, login: 'on', env: OVIS_ENV })
  assert.match(upd, /✓ whosup is updated \(settings and history kept\)/); assert.doesNotMatch(upd, /Ovis/, '새 버전으로 바꾼 설치에는 환경 줄이 없다')
  const again = draw({ kind: 'setup', board: UP, login: 'on', picked: 1, notes: ['NOTE'] }, T, 80)
  assert.ok(!again.join('\n').includes('✓') && !again.includes('  Installed'), again.join('\n')); assert.match(again.join('\n'), /Good to know\n {4}It picks up your choices without a restart\.\n\n {4}NOTE/)
  // PATH에 없는 실행 명령: 집 폴더 안이면 칠 명령도 ~/… (셸이 펼친다 — 길어서 줄 끝에서 쪼개지지 않게), 알림 글 안의 경로도 ~.
  // PATH에 더하는 명령(pathAdd)이 있으면 그 줄을 알아 둘 것에 싣는다
  const long = `${HOME}/.local/bin/whosup`
  const pathAdd = { dir: `${HOME}/.local/bin`, cmd: `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc` }
  const lp = draw({ board: UP, login: 'on', cmd: long, notes: [T.saPathHint(`${HOME}/.local/bin`)], pathAdd }, T, 60)
  assert.ok(lp.some((l) => l.startsWith('    ~/.local/bin/whosup autostart off')), lp.join('\n'))
  assert.ok(!lp.join('\n').includes(HOME), lp.join('\n'))
  assert.ok(lp.some((l) => l.includes('~/.local/bin is not on your PATH')), lp.join('\n'))
  assert.ok(lp.includes(`  ${pathAdd.cmd}`) || lp.includes(`      ${pathAdd.cmd}`), lp.join('\n'))
  assert.match(lp.join('\n'), /type this once:/)
  fits(lp, 60, (l) => l.includes(pathAdd.cmd))
  // 집 폴더 밖의 경로, 셸이 달리 읽을 글자가 있는 집 폴더 뒤 경로는 그대로 적는다(작은따옴표로 싼 것은 그대로)
  assert.ok(draw({ board: UP, login: 'on', cmd: '/opt/w/whosup' }, T, 80).some((l) => l.startsWith('    /opt/w/whosup help')))
  assert.ok(draw({ board: UP, login: 'on', cmd: `'${HOME}/a b/whosup'` }, T, 80).some((l) => l.includes(`'${HOME}/a b/whosup' help`)))
  // 색: 칠 명령·제목은 굵게, ✓는 초록, 각주만 흐리게. 노랑·흰색·회색 없음. NO_COLOR면 제어 문자 없음
  const c = draw({ kind: 'install', board: UP, opens: true, login: 'on' }, T, 80, { color: true }).join('\n')
  assert.match(c, /\x1b\[32m✓\x1b\[0m \x1b\[1mwhosup is installed\x1b\[0m/); assert.match(c, /\x1b\[1mhttp:\/\/127\.0\.0\.1:4790\x1b\[0m/); assert.match(c, /\x1b\[1mwhosup help\x1b\[0m/)
  assert.match(c, /\x1b\[2mChange settings in the board's settings\.\x1b\[0m/)
  assert.doesNotMatch(c, /\x1b\[3[3-7]m|\x1b\[9\dm/)
  assert.doesNotMatch(txt({ board: UP, login: 'on' }), /\x1b/)
  // UTF-8이 아닌 로캘: 구분점도 ASCII
  const ascii = renderBlocks(standaloneBlocks({ board: UP, login: 'on' }, T, { utf8: false }), { width: 79, color: false, utf8: false }).join('\n')
  assert.match(ascii, /http:\/\/127\.0\.0\.1:4790 - starts when you log in/); assert.match(ascii, /ok whosup is installed/)
})

test('rich 설치 요약은 plain 요약과 같은 사실을 말한다(빠진 사실 없음) · plain 요약(standaloneLines)은 그대로', () => {
  const T = TEXT.ko
  const f = { kind: 'install', app: `${HOME}/.local/share/whosup/app`, board: UP, opens: true, login: 'on', env: OVIS_ENV, notes: ['감지한 앱 줄'] }
  const plain = standaloneLines(f, T)
  assert.equal(plain[0], 'whosup 설치 요약', 'plain은 지금 그대로')
  const rich = stripAnsi(draw(f, T, 80).join('\n'))
  for (const fact of ['http://127.0.0.1:4790', 'whosup autostart off', 'whosup help', '감지한 앱 줄', '~/Applications/Ovis.app', '~/.local/share/whosup/app']) assert.ok(rich.includes(fact), fact)
  assert.equal(tildeText(`${HOME}/a ${HOME}x/b (${HOME}/c) '${HOME}/d'`, HOME), `~/a ${HOME}x/b (~/c) '~/d'`, '집 폴더 안의 경로만, 이름이 이어지는 다른 폴더는 그대로')
})

test('rich: 처음 가리킨 값에서 Enter로 끝낸 질문 뒤에 "직접 정한 값이 없습니다"를 달지 않는다(접힌 줄과 어긋난다) — 다 묻지 못한 설치에는 그대로', async () => {
  for (const [lang, LANG] of [['en', 'en_US.UTF-8'], ['ko', 'ko_KR.UTF-8']]) {
    const s = await setupWith({ f: facts(HERDR_APP), env: RICH(80, { LANG, WHOSUP_FROM_INSTALLER: '1' }), answers: [{ n: 1, how: 'key' }] })
    assert.equal(s.r.state, 'done'); assert.equal(s.calls.length, 1)
    assert.ok(!s.term.text().includes(TEXT[lang].savedNone), s.term.text())
    assert.ok(!s.term.text().includes(TEXT[lang].savedNoneDone), 'rich는 그 자리에 아무 줄도 달지 않는다(접힌 줄이 말한다)')
    // 다 답했다(Enter만): 값은 저장하지 않고 마친 표시만 쓴다 — 보드가 같은 질문을 다시 묻지 않는다
    const sj = readSetup(s.file)
    assert.deepEqual(sj.choices, {}, 'Enter만 친 질문은 값을 저장하지 않는다'); assert.equal(sj.done, true, '모든 질문에 답했으니 마친 표시')
  }
  // 두 질문 중 하나만 답하고 시간이 다 됐다: 그 줄(또는 시간 초과 알림)은 그대로 싣는다
  const t = await setupWith({ f: facts(FULL), env: RICH(80, { WHOSUP_FROM_INSTALLER: '1' }), sessions: RUNNING, answers: [{ n: 1, how: 'key' }, { n: 1, how: 'timeout' }] })
  assert.match(t.term.text(), /Nothing set by hand: the board asks once on first open\./)
  assert.equal(readSetup(t.file), null, '다 답하지 못한 설치는 마친 것으로 적지 않는다(보드가 한 번 묻는다)')
  // plain: Enter만 친 질문 뒤에 그 줄 — 다 답해 마친 것으로 적었으므로 "보드가 묻습니다"가 아니라 "자동 감지를 따릅니다"
  const p = await setupWith({ f: facts(HERDR_APP), env: { WHOSUP_UI: 'plain', WHOSUP_FROM_INSTALLER: '1' }, term: fakeTerm('\n') })
  assert.ok(p.term.text().includes(TEXT.en.savedNoneDone), p.term.text()); assert.ok(!p.term.text().includes(TEXT.en.savedNone), p.term.text())
})

test('rich: 설치기가 끝나지 않은 진행 줄을 남겨 두고 부른 설치(WHOSUP_UI_OPEN)는 처음 찍기 전에 줄을 끝내고 표식 파일을 남긴다 — 찍을 것이 없으면 남기지 않는다', async () => {
  const dir = tmp('open')
  const mark = join(dir, 'tty-used')
  const s = await setupWith({ env: RICH(80, { WHOSUP_FROM_INSTALLER: '1', WHOSUP_UI_OPEN: mark }) })
  assert.ok(s.term.text().startsWith('\n  … checking this machine\r\x1b[K  ✓ Detected'), JSON.stringify(s.term.text()))
  assert.equal(readFileSync(mark, 'utf8'), '')
  const mark2 = join(dir, 'quiet')
  const q = await setupWith({ env: RICH(80, { WHOSUP_FROM_INSTALLER: '1', WHOSUP_UI_OPEN: mark2, WHOSUP_NO_SETUP: '1' }) })
  assert.equal(q.term.text(), ''); assert.throws(() => readFileSync(mark2), '아무것도 찍지 않았다: 표식 없음')
})

test('화면 값(WHOSUP_UI · WHOSUP_UI_COLS · WHOSUP_UI_OPEN)은 오래 사는 프로세스(도우미 · 보드)에 넘기지 않는다', () => {
  assert.deepEqual(UI_ENV_KEYS, ['WHOSUP_UI', 'WHOSUP_UI_COLS', 'WHOSUP_UI_OPEN'])
  assert.deepEqual(withoutUi({ A: '1', WHOSUP_UI: 'rich', WHOSUP_UI_COLS: '60', WHOSUP_UI_OPEN: '/x' }), { A: '1' })
  const src = readFileSync(join(ROOT, 'src', 'setup.mjs'), 'utf8'), sa = readFileSync(join(ROOT, 'scripts', 'standalone.mjs'), 'utf8')
  assert.match(src, /spawnFn\(helperScript\(params\), \{ env: withoutUi\(env\) \}\)/)
  assert.match(sa, /\['WHOSUP_ENV_PICK', 'WHOSUP_ENV_INSTALLED', 'WHOSUP_ENV_APP', \.\.\.UI_ENV_KEYS\]\) delete senv\[k\]/)
})

test('PATH에 더하는 명령(pathAddCmd): 사람의 셸이 읽는 파일에, 집 폴더 안이면 $HOME/… 으로. 셸이 달리 읽을 글자가 있으면 명령 없음', () => {
  const H = '/Users/someone', bin = `${H}/.local/bin`
  assert.equal(pathAddCmd(bin, { env: { SHELL: '/bin/zsh' }, home: H, platform: 'darwin' }), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc`)
  assert.equal(pathAddCmd(bin, { env: { SHELL: '/bin/zsh', ZDOTDIR: '/z/dot' }, home: H, platform: 'darwin' }), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> /z/dot/.zshrc`)
  assert.equal(pathAddCmd(bin, { env: { SHELL: '/bin/bash' }, home: H, platform: 'darwin' }), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bash_profile`)
  assert.equal(pathAddCmd(bin, { env: { SHELL: '/usr/bin/bash' }, home: H, platform: 'linux' }), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc`)
  assert.equal(pathAddCmd(bin, { env: { SHELL: '/bin/sh' }, home: H, platform: 'linux' }), `echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.profile`)
  assert.equal(pathAddCmd('/opt/w/bin', { env: {}, home: H }), `echo 'export PATH="/opt/w/bin:$PATH"' >> ~/.profile`)
  assert.equal(pathAddCmd(`${H}/my bin`, { env: {}, home: H }), null); assert.equal(pathAddCmd("/o'pt", { env: {}, home: H }), null)
})
