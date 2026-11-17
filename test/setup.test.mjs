// 설치에 이어지는 셋업(src/setup.mjs · scripts/setup.mjs): 질문 줄, 입력 처리, 건너뛰기, setup.json, 기존 설치 판정, 서버 가져오기, 도우미.
// 실제 herdr·실제 /dev/tty·네트워크에 닿지 않는다: 감지 결과·herdr 실행·터미널·도우미 띄우기를 모두 주입하고, 폴더는 임시 폴더만 쓴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Script } from 'node:vm'
import { evaluate } from '../src/autoconf.mjs'
import { openDb, getMeta } from '../src/db.mjs'
import { getSettings, settingOrigins } from '../src/settings.mjs'
import { createBoardServer, FIRST_RUN_KEYS, importSetup, SETUP_CHECK_MS } from '../src/board/server.mjs'
import { configDirOf, ownDir, stateDirOf } from '../src/paths.mjs'
import {
  askAll, autostart, boardAnswers, boardStatus, chosenOf, closingLines, cols, envOn, helperParams, helperScript, herdrPluginDirs, inForeground, isExistingInstall, lineReader, listDesks, manifestId,
  openTerminal, pickDesk, pickLang, questionsOf, readSetup, renderQuestion, runHerdr, runningDesk, runSetup as runSetupRaw, secondsOf, setupFilePath, setupRows, SETUP_KEYS, skipMode, summaryLines,
  sqliteFile, TEXT, timeoutMsOf, updatedLines, watchdogMsOf, writeSetup, herdrWord,
} from '../src/setup.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FAKE = join(ROOT, 'test-support', 'fake-herdr-setup.mjs')
const ID = 'fivetaku.whosup'
const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const { choiceRows } = new Function(`${html.match(/\/\*origin\*\/([\s\S]*?)\/\*\/origin\*\//)[1]}; return { choiceRows }`)()
// 격리 폴더는 셸이 따옴표로 싸지 않는 경로에 만든다. 임시 폴더의 경로에 공백·한글 같은 글자가 있으면 설치기와 안내 문구가 화면의 경로를 '…'로
// 싸서 내놓는데(제품의 바른 동작이다), 이 파일의 단언은 싸지 않은 경로를 글자 그대로 견준다 — TMPDIR에 따라 결과가 갈리지 않게 그때는 /tmp를 쓴다.
// 싸는 동작은 그것을 보는 시험이 그런 폴더를 따로 만들어 본다.
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(tmpdir())) process.env.TMPDIR = '/tmp'
const tmp = (name) => mkdtempSync(join(tmpdir(), `whosup-setup-${name}-`))
// 이 파일의 모든 runSetup은 여기를 지난다: 홈 폴더를 env.HOME(임시 폴더)으로 주입한다. 손 실행은 <홈>/.config/whosup에 쓰므로,
// 주입 없이 부르면 이 기계의 실제 ~/.config/whosup에 쓴다 — 임시 폴더가 아닌 홈으로는 아예 돌리지 않는다.
const runSetup = (o = {}) => {
  const home = o.home ?? o.env?.HOME
  assert.ok(typeof home === 'string' && home.startsWith(tmpdir()), `시험의 runSetup은 임시 홈으로만 돌린다: ${home}`)
  return runSetupRaw({ ...o, home })
}

// 감지 입력(src/autoconf.mjs detect()의 모양). 기본 = 맥, 터미널 앱 하나, 에이전트 하나, ovis·Herdr 앱 없음 → 물을 것 없음.
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
const viewOf = (f, env = {}) => { const r = evaluate(f); return { summary: r.summary, chosen: chosenOf(r, env) } }
const keysAsked = (f, env) => questionsOf(setupRows(viewOf(f, env), TEXT.en)).map((q) => q.key)

// 가짜 터미널·가짜 herdr 실행. setupWith의 설치 명령(PID 777)은 살아 있는 것으로 둔다(alive) — 시험 기계의 실제 PID에 기대지 않는다.
const fakeTerm = (typed = '') => { const input = new PassThrough(); const out = []; if (typed) input.write(typed); return { input, out, write: (s) => out.push(s), columns: 80, colors: false, close() {}, text: () => out.join('') } }
// fail = 실패시킬 명령(예: ['plugin list'] — 시간 초과·오류 흉내)
const fakeRun = ({ confDir, sessions = [], plugins = '', fail = [] } = {}) => {
  const calls = []
  const run = async (bin, args) => {
    calls.push(args)
    const a = args.filter((x, i) => x !== '--session' && args[i - 1] !== '--session').join(' ')
    if (fail.includes(a)) return { ok: false, out: '' }
    if (a === `plugin config-dir ${ID}`) return confDir ? { ok: true, out: `${confDir}\n` } : { ok: false, out: '' }
    if (a === 'session list --json') return { ok: true, out: JSON.stringify({ sessions }) }
    if (a === 'plugin list') return { ok: true, out: plugins ? `1 plugin installed:\n- ${plugins} (whosup) enabled [github:x/y@0]\n` : 'No plugins installed.\n' }
    return { ok: false, out: '' }
  }
  return { run, calls }
}
const isoEnv = (home, over = {}) => ({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), ...over })
const RUNNING = [{ name: 'default', running: true, socket_path: '/x/herdr.sock', session_dir: '/x' }]
const setupWith = async ({ typed = '', f = facts(FULL), env = {}, sessions = [], plugins = '', fail = [], install = true, terminal, confDir, ...over } = {}) => {
  const home = tmp('home')
  const term = terminal === null ? null : fakeTerm(typed)
  const { run, calls } = fakeRun({ confDir, sessions, plugins, fail })
  const spawned = []
  const logs = []
  const r = await runSetup({
    install, env: isoEnv(home, env), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => f, run, herdrBin: 'herdr',
    spawnFn: (script) => { spawned.push(script); return 4242 }, installerPid: 777, alive: () => true, settleMs: 40, log: (l) => logs.push(l), ...over,
  })
  const conf = confDir || join(home, '.config', 'herdr', 'plugins', 'config', ID)
  return { r, home, conf, term, calls, spawned, logs, file: join(conf, 'setup.json') }
}

test('언어: 기본 영어, 로캘(LC_ALL > LC_MESSAGES > LANG)이 ko로 시작하면 한국어, WHOSUP_LANG이 이긴다', () => {
  assert.equal(pickLang({}), 'en')
  assert.equal(pickLang({ LANG: 'ko_KR.UTF-8' }), 'ko')
  assert.equal(pickLang({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(pickLang({ LANG: 'ko_KR.UTF-8', LC_MESSAGES: 'en_US.UTF-8' }), 'en', 'LC_MESSAGES가 LANG보다 먼저')
  assert.equal(pickLang({ LANG: 'en_US.UTF-8', LC_MESSAGES: 'en_US.UTF-8', LC_ALL: 'ko_KR.UTF-8' }), 'ko', 'LC_ALL이 맨 먼저')
  assert.equal(pickLang({ LC_ALL: '', LANG: 'ko_KR.UTF-8' }), 'ko', '빈 값은 없는 것으로')
  assert.equal(pickLang({ LANG: 'ko_KR.UTF-8', WHOSUP_LANG: 'en' }), 'en')
  assert.equal(pickLang({ LANG: 'C', WHOSUP_LANG: 'ko' }), 'ko')
  assert.equal(pickLang({ LANG: 'ko_KR.UTF-8', WHOSUP_LANG: 'fr' }), 'ko', '모르는 WHOSUP_LANG은 무시')
})

test('문구: 보드와 같은 이름의 열쇠는 index.html I18N 글자 그대로(ko·en), 두 언어의 열쇠가 같다', () => {
  assert.deepEqual(Object.keys(TEXT.ko).sort(), Object.keys(TEXT.en).sort())
  for (const lang of ['ko', 'en']) {
    for (const [k, v] of Object.entries(TEXT[lang])) {
      if (!(k in I18N[lang])) continue
      if (typeof v === 'function') for (const arg of ['win32', 'darwin', 'linux', true, false, 'ovis 7317 ↔ main']) assert.equal(v(arg), I18N[lang][k](arg), `${lang}.${k}(${arg})`)
      else assert.equal(v, I18N[lang][k], `${lang}.${k}`)
    }
    for (const k of ['clickLabel', 'clickTerminal', 'clickWeb', 'clickBoth', 'appLabel', 'appAuto', 'chCore', 'chCoreApp', 'cmdLabel', 'chShowing', 'chRaiseOnly', 'chAutoNote', 'chNotFound', 'chClickWeb', 'envTerm', 'envApp']) assert.ok(k in TEXT[lang] && k in I18N[lang], `${lang}.${k}는 보드와 같이 쓴다`)
  }
  assert.deepEqual(SETUP_KEYS, FIRST_RUN_KEYS, '묻는 항목 = 보드 첫 실행 안내의 항목')
  // 용어: 한국어 화면 문구는 '첫 실행 안내'라고 쓴다('셋업'을 쓰지 않는다). 세션을 칸·카드·pane이라 부르지 않는다.
  const koText = Object.values(TEXT.ko).map((v) => (typeof v === 'function' ? v('x', 'y') : v)).join('\n')
  assert.doesNotMatch(koText, /셋업|상황판|카드|\bpane\b/)
  assert.doesNotMatch(koText.replace(/한 번도|[0-9]+번|n번|x번/g, ''), /칸/)
  // 그대로 칠 명령은 백틱으로 싸지 않는다(터미널에는 마크다운이 없다): 명령은 설명 줄 아래에 따로 들여 쓴 한 줄로 나간다.
  // 어디에 치는지 말하는 줄은 ':'로 끝나고, 그 안에 명령을 섞어 쓰지 않는다.
  for (const lang of ['ko', 'en']) {
    for (const [k, v] of Object.entries(TEXT[lang])) for (const arg of [true, false]) assert.doesNotMatch(String(typeof v === 'function' ? v(arg, 'y') : v), /`/, `${lang}.${k}`)
    for (const k of ['typeHere', 'ifOff', 'ifOn', 'npmHow', 'regIfNo', 'updatedAgain', 'updatedAgainWin']) { assert.match(TEXT[lang][k], /:$/, `${lang}.${k}`); assert.doesNotMatch(TEXT[lang][k], /plugin action|npm start|node scripts/, `${lang}.${k}`) }
    for (const k of ['byHand', 'updatedRestart', 'regIfYes']) for (const inside of [true, false]) assert.match(TEXT[lang][k](inside), /:$/, `${lang}.${k}`)
    assert.notEqual(TEXT[lang].byHand(true), TEXT[lang].byHand(false), '데스크를 모르면 herdr 안의 터미널이라고 적는다')
    // 질문마다 무엇을 정하는지 한 줄(터미널 전용 열쇠 — 보드 I18N과 겹치지 않는다)
    for (const k of ['askClick', 'askApp', 'askCore', 'askCmd', 'autoNote', 'raiseNote']) { assert.ok(TEXT[lang][k], `${lang}.${k}`); assert.equal(k in I18N[lang], false, `${k}는 터미널 전용`) }
    // 안내문은 '* 표시한 값'이라고 쓴다 — 선택지 'auto(자동)'와 같은 낱말로 다른 것을 가리키지 않는다
    assert.doesNotMatch(`${TEXT[lang].intro} ${TEXT[lang].giveUp}`, /auto|자동/); assert.match(TEXT[lang].intro, /\*/)
  }
})

test('고를 줄: 보드의 choiceRows와 같은 입력에 같은 줄(항목·선택지·미리 고른 값)을 낸다', () => {
  const views = [
    viewOf(facts()), viewOf(facts(FULL)), viewOf(facts({ ovis: OVIS })), viewOf(facts({ platform: 'linux', terminal: null, agents: {} })),
    viewOf(facts({ platform: 'win32', terminal: null, tools: { wt: 'C:\\wt.exe' }, env: { SESSIONNAME: 'Console' } })),
    viewOf(facts(FULL), { AGENT_CMD: 'cct', FRONT_APP: 'Warp', WHOSUP_CLICK_TARGET: 'both', WHOSUP_CORE_TARGET: 'terminal' }),
    viewOf(facts({ ...FULL, env: { SSH_CONNECTION: '1 2 3 4' } })), null, {},
  ]
  for (const lang of ['ko', 'en']) for (const v of views) {
    assert.deepEqual(setupRows(v, I18N[lang]), choiceRows(v, I18N[lang]), '같은 문구표를 넣으면 한 글자도 다르지 않다')
    assert.deepEqual(setupRows(v, I18N[lang], { firstRun: true }), choiceRows(v, I18N[lang], { firstRun: true }), '첫 실행 안내의 줄(선택지 하나뿐인 줄을 뺀 것)도 같다')
    assert.ok(setupRows(v, I18N[lang], { firstRun: true }).every((r) => r.options.filter((o) => o.value !== '').length >= 2), '첫 실행 안내에는 고를 것이 하나뿐인 줄이 없다(자동은 세지 않는다)')
    assert.deepEqual(questionsOf(setupRows(v, I18N[lang], { firstRun: true })).map((q) => q.key), setupRows(v, I18N[lang], { firstRun: true }).map((r) => r.key), '터미널이 묻는 줄 = 보드 첫 실행 안내의 줄')
    const mine = setupRows(v, TEXT[lang]), board = choiceRows(v, I18N[lang])
    assert.deepEqual(mine.map((r) => [r.key, r.label, r.value, r.options.map((o) => [o.value, o.label, o.note || ''])]), board.map((r) => [r.key, r.label, r.value, r.options.map((o) => [o.value, o.label, o.note || ''])]), '셋업의 문구표로도 같은 줄')
  }
})

test('물을 줄: 고를 것이 둘 이상인 줄만 — 물을 것 없음 / ovis 있음 / 터미널 앱 여럿 / Herdr 앱 있음 / 에이전트 여럿', () => {
  assert.deepEqual(keysAsked(facts()), [], '터미널 앱 하나·에이전트 하나·ovis 없음·Herdr 앱 없음: 아무것도 묻지 않는다')
  assert.deepEqual(keysAsked(facts({ platform: 'linux', terminal: null, agents: {} })), [], '감지한 것이 없어도 묻지 않는다')
  assert.deepEqual(keysAsked(facts({ ovis: OVIS })), ['click_target'], '데스크와 맞춘 ovis가 있을 때만 세션을 여는 곳')
  assert.deepEqual(keysAsked(facts({ ovis: [{ port: 7317, answered: true, signed: true }] })), [], '데스크를 못 맞춘 ovis는 선택지가 아니다')
  assert.deepEqual(keysAsked(facts({ terminal: { showing: null, installed: ['Ghostty', 'Terminal'] } })), ['front_app'])
  assert.deepEqual(keysAsked(facts({ herdrApp: { found: true, bin: 'herdr-app' } })), ['core_target'])
  assert.deepEqual(keysAsked(facts({ herdrCore: { running: true, socket: '/c' } })), ['core_target'])
  assert.deepEqual(keysAsked(facts({ agents: { claude: '/c', codex: '/x' } })), ['agent_cmd'])
  assert.deepEqual(keysAsked(facts({ agents: { claude: null, codex: '/x' } })), [], 'codex만 있으면 codex가 자동 값 — 고를 것 없음')
  assert.deepEqual(keysAsked(facts(FULL)), ['click_target', 'front_app', 'core_target', 'agent_cmd'])
  assert.deepEqual(keysAsked(facts({ ...FULL, env: { SSH_CONNECTION: '1 2 3 4' } })), ['click_target', 'core_target', 'agent_cmd'], '원격이면 터미널 앱은 묻지 않는다')
  assert.deepEqual(keysAsked(facts(), { AGENT_CMD: 'cct' }), ['agent_cmd'], '환경변수로 정한 명령과 감지한 에이전트 — 둘 중 고를 수 있다')
  // 미리 골라 두는 값 = 보드와 같은 값(자동 감지·기본값), 번호는 1부터
  const qs = Object.fromEntries(questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en), TEXT.en).map((q) => [q.key, q]))
  assert.equal(qs.click_target.value, 'terminal'); assert.equal(qs.click_target.preset, 1)
  assert.equal(qs.front_app.value, 'Ghostty'); assert.equal(qs.front_app.preset, 1)
  assert.deepEqual(qs.front_app.options.map((o) => o.value), ['Ghostty', 'Terminal', 'iTerm', ''])
  assert.equal(qs.core_target.value, 'app'); assert.equal(qs.agent_cmd.value, 'claude')
  // 질문마다 "무엇을 정하는지" 한 줄(ask)이 붙는다. 제목(label)은 보드와 같은 짧은 이름 그대로다('Saved: …' 줄이 쓴다)
  assert.deepEqual(Object.values(qs).map((q) => [q.label, q.ask]), [
    ['Sessions open in', TEXT.en.askClick], ['Terminal app', TEXT.en.askApp], ['Herdr app sessions open in', TEXT.en.askCore], ['Command to run in a new session', TEXT.en.askCmd],
  ])
  // 선택지 덧붙임 두 가지는 터미널에서 뜻을 풀어 쓴다: 'auto'가 무엇인지, '창만 올림'이 무엇인지. 나머지는 보드와 같다
  assert.deepEqual(qs.front_app.options.map((o) => o.note), ['showing herdr now', '', TEXT.en.raiseNote, TEXT.en.autoNote])
  assert.deepEqual(questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en)).map((q) => q.ask), ['', '', '', ''], '문구표를 주지 않으면 보드와 같은 줄 그대로')
  assert.deepEqual(questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en))[1].options.map((o) => o.note), ['showing herdr now', '', 'raises open windows only', 'whichever app shows herdr'])
  const auto = questionsOf(setupRows(viewOf(facts({ terminal: { showing: null, installed: ['Terminal', 'kitty'] } })), TEXT.en))[0]
  assert.equal(auto.options[auto.preset - 1].value, auto.value, '미리 고른 번호가 그 값을 가리킨다')
})

test('지금 값과 출처: 환경변수 > 자동 감지 > 기본값, 틀린 환경변수 값은 건너뛴다', () => {
  const r = evaluate(facts(FULL))
  const c = chosenOf(r, {})
  assert.deepEqual(Object.keys(c), SETUP_KEYS)
  assert.deepEqual(c.front_app, { value: 'Ghostty', origin: { source: 'auto', reason: r.reasons.front_app } })
  assert.deepEqual(c.click_target, { value: 'terminal', origin: { source: 'default' } })
  assert.equal(c.agent_cmd.origin.source, 'auto')
  const e = chosenOf(r, { AGENT_CMD: 'cct', WHOSUP_CLICK_TARGET: 'everywhere' })
  assert.deepEqual(e.agent_cmd, { value: 'cct', origin: { source: 'env', name: 'AGENT_CMD' } })
  assert.equal(e.click_target.value, 'terminal', '받을 수 없는 값은 쓰지 않는다')
  assert.equal(chosenOf(null, {}).agent_cmd.value, 'claude')
})

test('요약: 감지한 것만 사람 말로 — 없는 것·내부 표현(코어 실행 중·데스크 확인 필요)은 싣지 않고, 너비에 맞춰 줄을 나눈다', () => {
  assert.deepEqual(summaryLines(evaluate(facts(FULL)).summary, TEXT.en, 200), ['terminal app Ghostty · Herdr app · web terminal ovis 7317 (desk main) · agents claude, codex'])
  assert.deepEqual(summaryLines(evaluate(facts(FULL)).summary, TEXT.en), ['terminal app Ghostty · Herdr app', 'web terminal ovis 7317 (desk main) · agents claude, codex'], '기본 너비(68칸)에서는 두 줄 — 토막 가운데서 자르지 않는다')
  assert.deepEqual(summaryLines(evaluate(facts(FULL)).summary, TEXT.en, 87), ['terminal app Ghostty · Herdr app · web terminal ovis 7317 (desk main)', 'agents claude, codex'])
  for (const w of [40, 68, 87]) for (const lang of ['ko', 'en']) for (const l of summaryLines(evaluate(facts(FULL)).summary, TEXT[lang], w)) assert.ok(cols(l) <= w, `${w}칸 안: ${l}`)
  assert.deepEqual(summaryLines(evaluate(facts(FULL)).summary, TEXT.ko, 200), ['터미널 앱 Ghostty · Herdr 앱 · 웹 터미널 ovis 7317(데스크 main) · 에이전트 claude, codex'])
  // 없는 것은 줄에 없다: Herdr 앱 없음·웹 터미널 없음을 늘어놓지 않는다
  assert.deepEqual(summaryLines(evaluate(facts()).summary, TEXT.ko), ['터미널 앱 Terminal(기본) · 에이전트 claude'])
  // 데스크를 맞추지 못한 ovis는 선택지가 아니므로 요약에도 싣지 않는다(보드의 "감지한 환경"이 보여 준다)
  assert.deepEqual(summaryLines(evaluate(facts({ ovis: [{ port: 7318, answered: true, signed: true }] })).summary, TEXT.en), ['terminal app Terminal (default) · agents claude'])
  // 원격(창을 올리지 않음)·리눅스(창 올리기 없음)는 터미널 앱 토막이 없다. 감지한 것이 하나도 없으면 빈 목록
  assert.deepEqual(summaryLines(evaluate(facts({ ...FULL, ovis: [], env: { SSH_CONNECTION: '1 2 3 4' } })).summary, TEXT.en), ['Herdr app · agents claude, codex'])
  assert.deepEqual(summaryLines(evaluate(facts({ platform: 'linux', terminal: null, agents: {} })).summary, TEXT.en), [])
  for (const lang of ['ko', 'en']) for (const f of [facts(), facts(FULL), facts({ ovis: [{ port: 7318, answered: true, signed: true }] }), facts({ ...FULL, env: { SSH_CONNECTION: '1 2 3 4' } })]) {
    assert.doesNotMatch(summaryLines(evaluate(f).summary, TEXT[lang]).join('\n'), /none|off|stopped|running|needs checking|↔|없음|꺼짐|실행 중|확인 필요/, '내부 표현·없는 것을 싣지 않는다')
  }
  assert.deepEqual(summaryLines(null, TEXT.en), [])
})

test('질문 그리기: 제목 — 무엇을 정하는지 · 번호 · 미리 고른 값(*) — 한 줄에 안 들어가면 선택지를 한 줄씩', () => {
  const [click, app, core, cmd] = questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en), TEXT.en)
  assert.deepEqual(renderQuestion(click, 80), ['  Sessions open in — where a click on a session in the board opens it', '    1) terminal window *   2) web terminal   3) both'])
  assert.deepEqual(renderQuestion(app, 60), [
    '  Terminal app — the app brought to the front when you click a session', '    1) Ghostty (showing herdr now) *', '    2) Terminal',
    '    3) iTerm (brings an open window forward, cannot open a new one)', '    4) auto (not fixed: whichever app is showing herdr at that moment)',
  ])
  assert.equal(renderQuestion(core, 80)[0], '  Herdr app sessions open in — where a click on a Herdr app session opens it')
  assert.equal(renderQuestion(cmd, 80)[0], '  Command to run in a new session — the agent a new session starts')
  const ko = questionsOf(setupRows(viewOf(facts(FULL)), TEXT.ko), TEXT.ko)
  assert.deepEqual(ko.map((q) => renderQuestion(q, 80)[0]), [
    '  세션을 여는 곳 — 보드에서 세션을 누르면 그 세션을 어디에서 열지', '  터미널 앱 — 세션을 눌렀을 때 앞으로 올릴 앱',
    '  Herdr 앱 세션을 여는 곳 — Herdr 앱에 있는 세션을 누르면 어디에서 열지', '  세션을 열 때 실행할 명령 — 새 세션에서 띄울 에이전트',
  ])
  assert.equal(renderQuestion(ko[1], 60).at(-1), '    4) 자동 (정해 두지 않음: 그때그때 herdr가 떠 있는 앱)')
  for (const q of [click, app, core, cmd, ...ko]) assert.ok(cols(renderQuestion(q, 80)[0]) <= 80, `제목 줄이 80칸 안: ${renderQuestion(q, 80)[0]}`)
  assert.deepEqual(renderQuestion(questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en))[0], 80)[0], '  Sessions open in', '풀어 쓴 말이 없으면 제목만')
  assert.equal(cols('터미널 앱 A'), 11, '한글은 두 칸')
})

test('입력: Enter = 감지 값(저장 안 함), 번호 = 사람이 정한 값, 잘못된 입력 3번이면 감지 값으로 넘어간다', async () => {
  const qs = questionsOf(setupRows(viewOf(facts(FULL)), TEXT.en))
  const ask = async (typed, opts = {}) => {
    const t = fakeTerm(typed)
    const reader = lineReader(t.input)
    try { return { ...(await askAll(qs, { reader, write: t.write, T: TEXT.en, timeoutMs: 2000, ...opts })), text: t.text() } } finally { reader.stop() }
  }
  const enter = await ask('\n\n\n\n')
  assert.deepEqual(enter.choices, {}); assert.equal(enter.ended, null); assert.equal(enter.answered, 4)
  const picked = await ask('3\n\n2\r\n 2 \n')
  assert.deepEqual(picked.choices, { click_target: 'both', core_target: 'terminal', agent_cmd: 'codex' }, '번호로 고른 항목만(Enter로 넘긴 터미널 앱은 없다)')
  const same = await ask('1\n1\n1\n1\n')
  assert.deepEqual(same.choices, { click_target: 'terminal', front_app: 'Ghostty', core_target: 'app', agent_cmd: 'claude' }, '미리 고른 값과 같은 번호를 쳐도 사람이 정한 값')
  assert.deepEqual((await ask('\n4\n\n\n')).choices, { front_app: '' }, "'자동'을 번호로 고르면 '' (저장한 값을 지운다)")
  const bad = await ask('9\nboth\n0\n2\n\n\n')
  assert.deepEqual(bad.choices, { front_app: 'Terminal' }, '3번 틀린 항목은 감지 값으로, 다음 줄은 다음 질문의 답')
  assert.equal(bad.text.match(/Please type a number from 1 to 3\./g).length, 2); assert.match(bad.text, /Keeping the value marked \*\./)
  const inj = await ask('$(touch /tmp/x)\n; rm -rf ~\n`id`\n\n\n\n')
  assert.deepEqual(inj.choices, {}, '번호가 아닌 입력은 어디에도 쓰이지 않는다')
  assert.deepEqual((await ask('2\n', { maxTries: 1 })).choices.click_target, 'web')
})

test('입력: 시간 초과·스트림 닫힘·읽기 오류면 남은 질문을 모두 감지 값으로 넘기고 끝난다', async () => {
  const qs = questionsOf(setupRows(viewOf(facts(FULL)), TEXT.ko))
  const t = fakeTerm('2\n')
  const reader = lineReader(t.input)
  const t0 = Date.now()
  const r = await askAll(qs, { reader, write: t.write, T: TEXT.ko, timeoutMs: 80 })
  reader.stop()
  assert.deepEqual(r.choices, { click_target: 'web' }); assert.equal(r.ended, 'timeout'); assert.equal(r.answered, 1)
  assert.ok(Date.now() - t0 < 2000, '두 번째 질문에서 한 번만 기다린다')
  assert.match(t.text(), /입력이 없어 남은 항목은 자동 감지 값을 그대로 씁니다/)
  assert.doesNotMatch(t.text(), /Herdr 앱 세션을 여는 곳/, '남은 질문은 묻지 않는다')
  for (const how of ['end', 'destroy', 'error']) {
    const c = fakeTerm('3\n')
    const rd = lineReader(c.input)
    setTimeout(() => { if (how === 'end') c.input.end(); else if (how === 'destroy') c.input.destroy(); else c.input.emit('error', Object.assign(new Error('EIO'), { code: 'EIO' })) }, 20)
    const x = await askAll(qs, { reader: rd, write: c.write, T: TEXT.ko, timeoutMs: 5000 })
    rd.stop()
    assert.deepEqual(x.choices, { click_target: 'both' }, how); assert.equal(x.ended, 'closed', how)
  }
  // stop()은 기다리던 읽기를 풀어 준다(프로세스가 남지 않게)
  const s = fakeTerm()
  const rd = lineReader(s.input)
  const p = rd.next(60000)
  rd.stop()
  assert.deepEqual(await p, { closed: true })
  assert.equal(s.input.listenerCount('data'), 0)
  assert.deepEqual(await rd.next(60000), { closed: true }, '멈춘 뒤에는 기다리지 않는다')
})

test('건너뛰기: CI = 질문·자동 시작 없음, WHOSUP_NO_SETUP=1 = 질문만 없음, WHOSUP_NO_AUTOSTART=1 = 자동 시작만 없음', async () => {
  assert.deepEqual(skipMode({}), { ask: true, autostart: true, why: null })
  assert.deepEqual(skipMode({ CI: 'true' }), { ask: false, autostart: false, why: 'CI' })
  assert.equal(skipMode({ CI: '1', WHOSUP_SETUP: '1' }).why, 'CI')
  assert.equal(skipMode({ CI: 'false' }).ask, true); assert.equal(skipMode({ CI: '0' }).ask, true); assert.equal(skipMode({ CI: '' }).ask, true)
  assert.deepEqual(skipMode({ WHOSUP_NO_SETUP: '1' }), { ask: false, autostart: true, why: 'WHOSUP_NO_SETUP' })
  assert.deepEqual(skipMode({ WHOSUP_NO_AUTOSTART: '1' }), { ask: true, autostart: false, why: null })
  assert.equal(timeoutMsOf({}), 120000); assert.equal(timeoutMsOf({ WHOSUP_SETUP_TIMEOUT_S: '5' }), 5000); assert.equal(timeoutMsOf({ WHOSUP_SETUP_TIMEOUT_S: 'x' }), 120000); assert.equal(timeoutMsOf({ WHOSUP_SETUP_TIMEOUT_S: '-1' }), 120000)
  assert.equal(timeoutMsOf({ WHOSUP_SETUP_TIMEOUT_S: '999999' }), 3600000, '너무 큰 값은 자른다(setTimeout이 1 ms로 바꾸지 않게)'); assert.equal(timeoutMsOf({ WHOSUP_SETUP_TIMEOUT_S: 'Infinity' }), 120000)
  // 전체 감시 타이머(scripts/setup.mjs가 이 함수를 쓴다): 질문 수 × 시간 제한 + 2분, setTimeout이 받는 값 안
  assert.equal(watchdogMsOf({}), SETUP_KEYS.length * 120000 + 120000); assert.equal(watchdogMsOf({ WHOSUP_SETUP_TIMEOUT_S: '5' }), SETUP_KEYS.length * 5000 + 120000)
  assert.ok(watchdogMsOf({ WHOSUP_SETUP_TIMEOUT_S: '1e12' }) < 2 ** 31, '가장 큰 값으로도 32비트 안'); assert.ok(watchdogMsOf({ WHOSUP_SETUP_TIMEOUT_S: '1e12' }) > 3600000)
  assert.match(readFileSync(join(ROOT, 'scripts', 'setup.mjs'), 'utf8'), /setTimeout\(\(\) => process\.exit\(0\), watchdogMsOf\(\)\)\.unref\(\)/, '진입점은 그 함수를 그대로 쓴다')
  // 화면에 적는 초: 1초 미만의 시간 제한도 0초라고 적지 않는다
  assert.equal(secondsOf(50), 1); assert.equal(secondsOf(400), 1); assert.equal(secondsOf(1499), 1); assert.equal(secondsOf(120000), 120)
  // 스위치 판정은 한 가지: 없음·빈 값·0·false·no·off는 꺼짐, 그 밖은 켜짐(대소문자·공백 무시) — CI·WHOSUP_NO_SETUP·WHOSUP_SETUP·WHOSUP_NO_AUTOSTART 모두
  for (const v of [undefined, null, '', ' ', '0', 'false', 'FALSE', 'no', 'No', 'off', ' 0 ']) assert.equal(envOn(v), false, JSON.stringify(v))
  for (const v of ['1', 'true', 'TRUE', 'yes', 'on', 'y', '2', 'anything']) assert.equal(envOn(v), true, v)
  for (const v of ['true', 'yes', 'on', '2']) {
    assert.deepEqual(skipMode({ WHOSUP_NO_SETUP: v }), { ask: false, autostart: true, why: 'WHOSUP_NO_SETUP' }, v)
    assert.deepEqual(skipMode({ WHOSUP_NO_AUTOSTART: v }), { ask: true, autostart: false, why: null }, v)
    assert.equal(skipMode({ CI: v }).why, 'CI', v)
  }
  for (const v of ['', '0', 'false', 'no', 'off']) assert.deepEqual(skipMode({ CI: v, WHOSUP_NO_SETUP: v, WHOSUP_NO_AUTOSTART: v }), { ask: true, autostart: true, why: null }, JSON.stringify(v))

  const ci = await setupWith({ typed: '2\n', env: { CI: 'true' }, sessions: RUNNING })
  assert.equal(ci.r.state, 'skipped'); assert.equal(ci.term.text(), ''); assert.deepEqual(ci.calls, [], 'herdr도 부르지 않는다'); assert.deepEqual(ci.spawned, [])
  assert.equal(existsSync(ci.file), false)

  const quiet = await setupWith({ typed: '2\n', env: { WHOSUP_NO_SETUP: '1' }, sessions: RUNNING })
  assert.equal(quiet.r.state, 'silent'); assert.equal(quiet.term.text(), '', '묻지도 찍지도 않는다'); assert.equal(existsSync(quiet.file), false)
  assert.equal(quiet.spawned.length, 1, '자동 시작은 그대로')

  const noStart = await setupWith({ typed: '2\n\n\n\n', env: { WHOSUP_NO_AUTOSTART: '1' }, sessions: RUNNING })
  assert.equal(noStart.r.state, 'done'); assert.deepEqual(noStart.spawned, []); assert.equal(noStart.r.autostart.state, 'off')
  assert.deepEqual(readSetup(noStart.file).choices, { click_target: 'web' }, '질문은 그대로')
  assert.doesNotMatch(noStart.term.text(), /starting now/)
  // WHOSUP_SETUP도 같은 판정: true·yes면 다시 묻고, 0·false·빈 값이면 기존 설치로 본다(묻지 않는다)
  const home = tmp('sw'); const conf = join(home, '.config', 'herdr', 'plugins', 'config', ID)
  mkdirSync(conf, { recursive: true }); writeSetup(conf, {})
  const again = async (v) => (await runSetup({ install: true, env: isoEnv(home, { WHOSUP_SETUP: v }), platform: 'darwin', root: ROOT, terminal: fakeTerm('\n\n\n\n'), detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: 'herdr', spawnFn: () => 1 })).state
  for (const v of ['1', 'true', 'yes']) assert.equal(await again(v), 'done', v)
  for (const v of ['', '0', 'false', 'no']) assert.equal(await again(v), 'existing', JSON.stringify(v))
})

test('터미널 없음: 묻지도 찍지도 쓰지도 않고 자동 시작만 시도한다(감지도 돌리지 않는다)', async () => {
  let detected = 0
  const on = await setupWith({ terminal: null, sessions: RUNNING, detectFn: async () => { detected++; return facts() } })
  assert.equal(on.r.state, 'silent'); assert.equal(detected, 0); assert.equal(existsSync(on.file), false)
  assert.equal(on.spawned.length, 1); assert.match(on.logs.join('\n'), /no terminal — nothing asked; autostart: starting \(default\)/)
  const off = await setupWith({ terminal: null })
  assert.deepEqual(off.spawned, []); assert.match(off.logs.join('\n'), /autostart: herdr_off/)
  const none = await setupWith({ terminal: null, herdrBin: null, sessions: RUNNING })
  assert.deepEqual(none.spawned, []); assert.deepEqual(none.calls, [], 'herdr가 없으면 부르지 않는다'); assert.match(none.logs.join('\n'), /autostart: no_herdr/)
})

test('setup.json: 번호로 직접 고른 항목만, { version, at, choices } — 원자적으로 쓰고, herdr가 알려 준 설정 폴더에 쓴다', async () => {
  const now = new Date('2026-11-13T01:02:03.000Z')
  const a = await setupWith({ typed: '3\n\n2\n\n', now: () => now })
  assert.deepEqual(JSON.parse(readFileSync(a.file, 'utf8')), { version: 1, at: '2026-11-13T01:02:03.000Z', choices: { click_target: 'both', core_target: 'terminal' }, done: true }, '네 질문에 다 답했다: 마친 표시')
  assert.deepEqual(readdirSync(a.conf), ['setup.json'], '임시 파일·.env·auto.json을 남기지 않는다')
  assert.match(a.term.text(), /Saved: Sessions open in = both, Herdr app sessions open in = terminal window/)
  // Enter만 쳐서 다 답한 설치: 값은 고정하지 않고(choices 비움) 마친 표시만 쓴다 — 보드가 같은 질문을 다시 묻지 않는다
  const enter = await setupWith({ typed: '\n\n\n\n', now: () => now })
  assert.deepEqual(JSON.parse(readFileSync(enter.file, 'utf8')), { version: 1, at: '2026-11-13T01:02:03.000Z', choices: {}, done: true }); assert.deepEqual(enter.r.saved, [enter.file])
  assert.match(enter.term.text(), /\n {2}Nothing set by hand: auto-detect keeps applying\. Change it in the board settings\.\n/)
  assert.doesNotMatch(enter.term.text(), /the board asks once on first open/, '마친 것으로 적었으니 "보드가 묻습니다"라고 하지 않는다')
  assert.match((await setupWith({ typed: '\n\n\n\n', env: { LANG: 'ko_KR.UTF-8' } })).term.text(), /\n {2}직접 정한 값이 없어 자동 감지 값을 계속 따릅니다\. 보드 설정에서 언제든 바꿀 수 있습니다\.\n/)
  const nothing = await setupWith({ f: facts(), sessions: RUNNING })
  assert.deepEqual(nothing.r.questions, []); assert.equal(existsSync(nothing.file), false, '물을 것이 없던 설치도 마친 것으로 적지 않는다(herdr가 켜져 있어도)')
  assert.match(nothing.term.text(), /Nothing to choose here/); assert.doesNotMatch(nothing.term.text(), /Type a number|With no answer for/)
  // herdr가 꺼져 있으면 웹 터미널(ovis)을 감지할 수 없다: 물은 것이 없을 때는 마친 표시를 남기지 않아 보드의 첫 실행 안내가 다시 감지해 묻는다
  // 자동 시작을 껐어도(WHOSUP_NO_AUTOSTART=1) herdr가 꺼져 있는지는 따로 보고 같은 판정을 쓴다
  for (const over of [{ sessions: [] }, { sessions: RUNNING, herdrBin: null }, { sessions: [], env: { WHOSUP_NO_AUTOSTART: '1' } }, { sessions: RUNNING, herdrBin: null, env: { WHOSUP_NO_AUTOSTART: '1' } }]) {
    const blind = await setupWith({ f: facts(), ...over })
    assert.deepEqual(blind.r.questions, []); assert.equal(existsSync(blind.file), false); assert.deepEqual(blind.r.saved, [])
    // 한 줄로 말한다: "고를 것이 없습니다" 바로 아래에 "첫 실행 안내가 묻습니다"가 오면 서로 어긋난다(가-6 · F8) — 보드는 그 값을 한 번 보여 준다
    assert.match(blind.term.text(), /\n {2}Nothing to choose here: the auto-detected values are used\. The board shows them once on first open\.\n\n/, '저장하지 않았으니 보드가 한 번 보여 준다고 알린다')
    assert.doesNotMatch(blind.term.text(), /The board asks on first open/, '"고를 것이 없다" 뒤에 "묻는다"가 오지 않는다')
  }
  const koNothing = (await setupWith({ f: facts(), sessions: [], env: { LANG: 'ko_KR.UTF-8' } })).term.text()
  assert.match(koNothing, /\n {2}지금은 고를 것이 없어 자동 감지 값을 그대로 씁니다\. 보드를 처음 열 때 첫 실행 안내가 그 값을 한 번 보여 줍니다\.\n\n/)
  assert.doesNotMatch(koNothing, /고를 것이 없습니다|첫 실행 안내가 묻습니다/, '"고를 것이 없습니다" 다음 줄에 "묻습니다"가 오지 않는다')
  assert.match(nothing.term.text(), /\n {2}Nothing to choose here: the auto-detected values are used\. The board shows them once on first open\.\n\n/, 'herdr가 켜져 있어도 같다')
  const noStartOn = await setupWith({ f: facts(), sessions: RUNNING, env: { WHOSUP_NO_AUTOSTART: '1' } })
  assert.equal(existsSync(noStartOn.file), false, '자동 시작만 껐고 herdr는 켜져 있어도 물을 것이 없었으면 쓰지 않는다'); assert.deepEqual(noStartOn.spawned, []); assert.match(noStartOn.term.text(), /The board shows them once on first open/)
  const againBlind = await setupWith({ f: facts(), sessions: [], env: { WHOSUP_SETUP: '1' } })
  assert.equal(existsSync(againBlind.file), false); assert.doesNotMatch(againBlind.term.text(), /The board asks on first open|on first open/, '다시 묻기에서는 그 말을 붙이지 않는다(전에 마쳤을 수 있다)')
  // 설정 폴더: herdr plugin config-dir <id>의 출력이 먼저, 실패하면 규칙으로 계산한 경로
  const dir = join(tmp('conf'), 'from-herdr')
  const viaHerdr = await setupWith({ typed: '2\n\n\n\n', confDir: dir })
  assert.deepEqual(viaHerdr.calls[0], ['plugin', 'config-dir', ID])
  assert.deepEqual(readSetup(join(dir, 'setup.json')).choices, { click_target: 'web' })
  assert.equal(existsSync(join(viaHerdr.home, '.config')), false, '규칙 경로에는 쓰지 않는다')
  // 저장 실패는 알리고 넘어간다(설치는 계속)
  const blocker = join(tmp('blk'), 'file'); writeFileSync(blocker, 'x')
  const fail = await setupWith({ typed: '2\n\n\n\n', confDir: join(blocker, 'sub') })
  assert.equal(fail.r.state, 'done'); assert.deepEqual(fail.r.saved, []); assert.match(fail.term.text(), /Could not save your choices/)
  // 읽기: 모양이 틀리면 null
  const bad = tmp('bad')
  for (const [i, body] of ['{', '[]', '{"version":2,"at":"x","choices":{}}', '{"version":1,"choices":{}}', 'null'].entries()) { const f = join(bad, `${i}.json`); writeFileSync(f, body); assert.equal(readSetup(f), null, body) }
  assert.equal(readSetup(join(bad, 'none.json')), null)
  const w = writeSetup(bad, { agent_cmd: 'codex' }, { now })
  assert.deepEqual(readSetup(w.file), { version: 1, at: now.toISOString(), choices: { agent_cmd: 'codex' } })
  assert.equal(setupFilePath({ HERDR_PLUGIN_CONFIG_DIR: '/c' }), join('/c', 'setup.json'))
})

test('자리에 없음: 한 번도 답하지 못한 채 시간 초과·닫힘이면 setup.json을 쓰지 않는다(보드가 처음 열릴 때 묻는다). 감지 실패도 같다', async () => {
  const away = await setupWith({ env: { WHOSUP_SETUP_TIMEOUT_S: '0.05' } })
  assert.equal(away.r.ended, 'timeout'); assert.equal(existsSync(away.file), false); assert.equal(away.r.state, 'done')
  assert.match(away.term.text(), /No input for 1 second: the remaining items keep their auto-detected values\.\n {2}The board asks on first open\.\n/, '저장하지 않았으니 보드가 묻는다고 알린다')
  assert.match(away.term.text(), /With no answer for 1 second, setup moves on by itself\./, "1초 미만이어도 '0 seconds'라고 적지 않는다"); assert.doesNotMatch(away.term.text(), /\b0 seconds?\b/)
  assert.match((await setupWith({ env: { WHOSUP_SETUP_TIMEOUT_S: '0.05', LANG: 'ko_KR.UTF-8' } })).term.text(), /1초 동안 답이 없으면 자동으로 넘어갑니다\.[\s\S]*1초 동안 입력이 없어/)
  const part = await setupWith({ typed: '2\n', env: { WHOSUP_SETUP_TIMEOUT_S: '0.05' } })
  assert.deepEqual(readSetup(part.file).choices, { click_target: 'web' }, '답한 것이 있으면 저장한다'); assert.doesNotMatch(part.term.text(), /The board asks on first open/)
  const broken = await setupWith({ typed: '2\n', detectFn: async () => { throw new Error('boom') }, sessions: RUNNING })
  assert.equal(broken.r.state, 'done'); assert.deepEqual(broken.r.questions, []); assert.equal(existsSync(broken.file), false)
  assert.match(broken.term.text(), /Could not check this machine, so whosup starts with its defaults/)
  assert.equal(broken.spawned.length, 1, '감지가 실패해도 자동 시작은 한다'); assert.match(broken.logs.join('\n'), /detect failed: boom/)
  const slow = await setupWith({ detectFn: () => new Promise(() => {}), detectTimeoutMs: 30 })
  assert.match(slow.term.text(), /Could not check this machine/, '감지가 멈춰도 셋업은 끝난다')
})

test('기존 설치(업데이트·재설치): setup.json이나 whosup.db가 있으면 다시 묻지 않고, WHOSUP_SETUP=1·--force면 다시 묻는다', async () => {
  assert.equal(isExistingInstall({ confDir: '/c', stateDir: '/s' }, () => false), false)
  // 파일이 있고 읽을 수 있을 때만이다(usable = 내용 확인: setup.json은 readSetup이 읽히는가, whosup.db는 SQLite 파일인가)
  const usable = { setup: () => true, db: () => true }, broken = { setup: () => false, db: () => false }
  assert.equal(isExistingInstall({ confDir: '/c', stateDir: '/s' }, (p) => p === join('/c', 'setup.json'), usable), true)
  assert.equal(isExistingInstall({ confDir: '/c', stateDir: '/s' }, (p) => p === join('/s', 'whosup.db'), usable), true)
  assert.equal(isExistingInstall({ confDir: '/c', stateDir: '/s' }, () => true, broken), false, '있어도 읽을 수 없으면 기존 설치가 아니다')
  // 실제 파일로: 빈 파일·깨진 파일·모양이 틀린 파일은 기존 설치가 아니다
  const junk = tmp('junk'); const jc = join(junk, 'c'), js = join(junk, 's')
  mkdirSync(jc); mkdirSync(js)
  for (const text of ['', '{}', 'not json', '{"version":99,"at":"x","choices":{}}']) { writeFileSync(join(jc, 'setup.json'), text); assert.equal(isExistingInstall({ confDir: jc, stateDir: js }), false, `setup.json ${JSON.stringify(text)}`) }
  // 첫 설치에서 Enter만으로 다 답한 파일(고른 값 없음 + done 표시)도 읽히므로 기존 설치다 — 재설치는 다시 묻지 않는다(다시 묻기는 whosup setup)
  writeSetup(jc, {}, { done: true }); assert.equal(isExistingInstall({ confDir: jc, stateDir: js }), true, '마친 표시만 있는 setup.json')
  writeFileSync(join(jc, 'setup.json'), '')
  for (const text of ['', 'SQLite', 'not a database at all, just text']) { writeFileSync(join(js, 'whosup.db'), text); assert.equal(isExistingInstall({ confDir: jc, stateDir: js }), false, `whosup.db ${JSON.stringify(text)}`) }
  assert.equal(sqliteFile(join(js, 'missing.db')), false)
  const real = join(junk, 'real'); mkdirSync(real)
  { const { DatabaseSync } = await import('node:sqlite'); const db = new DatabaseSync(join(real, 'whosup.db')); db.exec('CREATE TABLE t (v TEXT)'); db.close() }
  assert.equal(sqliteFile(join(real, 'whosup.db')), true); assert.equal(isExistingInstall({ confDir: jc, stateDir: real }), true, '보드가 만든 DB')
  writeSetup(jc, {}); assert.equal(isExistingInstall({ confDir: jc, stateDir: js }), true, '셋업이 쓴 setup.json')
  const home = tmp('exist')
  const state = join(home, '.local', 'state', 'herdr', 'plugins', ID)
  mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'whosup.db'), 'SQLite format 3\u0000')
  // 보드가 답하는지는 주입한다(healthy) — 시험은 이 기계의 포트에 묻지 않는다. probed = 물어본 포트
  let healthy = true; const probed = []
  const boardFn = (dir, o) => boardStatus(dir, { ...o, probe: async (port) => { probed.push(port); return healthy } })
  const run1 = async (over = {}, typed = '2\n\n\n\n') => {
    const term = fakeTerm(typed); const { run, calls } = fakeRun({ sessions: over.sessions || RUNNING }); const spawned = []
    const r = await runSetup({ install: true, env: isoEnv(home, over.env), platform: 'darwin', root: ROOT, terminal: over.terminal === null ? null : term, detectFn: async () => facts(FULL), run, herdrBin: 'herdr', spawnFn: (s) => { spawned.push(s); return 1 }, force: over.force, boardFn })
    return { r, term, calls, spawned }
  }
  // 보드가 떠 있다(상태 폴더의 server.pid가 살아 있고 /api/health에 답한다): 건드리지 않고 재시작 방법과 실제 주소를 알린다
  writeFileSync(join(state, 'server.pid'), String(process.pid)); writeFileSync(join(state, 'port'), '4791\n')
  const upd = await run1()
  assert.equal(upd.r.state, 'existing'); assert.equal(upd.r.autostart.state, 'running'); assert.deepEqual(probed, ['4791'], '보드가 실제로 뜬 포트에 묻는다')
  assert.equal(upd.term.text(), [
    '', 'whosup updated. Your settings are kept.', '  A running board keeps the old version until it restarts.', '  To restart it, type these two lines in a terminal:',
    `      herdr plugin action invoke ${ID}.stop`, `      herdr plugin action invoke ${ID}.start`, '  The board:  http://127.0.0.1:4791',
    '  To be asked again, type this in a terminal (or use "open first-run setup again" in the board\'s settings):', '      WHOSUP_SETUP=1 herdr plugin install fivetaku/whosup --yes', '', '',
  ].join('\n'), '그대로 칠 명령은 따로 들여 쓴 한 줄, 주소는 실제 포트')
  assert.doesNotMatch(upd.term.text(), /Type a number|`/); assert.deepEqual(upd.spawned, [], '실행 중인 보드를 건드리지 않는다')
  assert.equal(existsSync(join(home, '.config', 'herdr', 'plugins', 'config', ID, 'setup.json')), false)
  assert.equal((await run1({ terminal: null })).r.state, 'existing', '터미널이 없어도 기존 설치는 그대로 둔다')
  const ko = await run1({ env: { LANG: 'ko_KR.UTF-8' } })
  assert.match(ko.term.text(), /whosup을 업데이트했습니다\. 설정은 그대로입니다\.\n {2}실행 중인 보드는 다시 시작해야 새 버전이 됩니다\.\n {2}다시 시작하려면 터미널에 아래 두 줄을 치세요:\n {6}herdr plugin action invoke/)
  assert.match(ko.term.text(), /\n {2}보드 주소: {2}http:\/\/127\.0\.0\.1:4791\n {2}다시 물어보게 하려면 터미널에 아래를 치세요\(보드의 설정에서 \"첫 실행 안내 다시 보기\"를 눌러도 됩니다\):\n {6}WHOSUP_SETUP=1 herdr plugin install fivetaku\/whosup --yes\n/)
  // 원격(SSH)에서 업데이트: 실행 중인 보드 주소 아래에 포트 넘기는 법
  assert.match((await run1({ env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } })).term.text(), /The board: {2}http:\/\/127\.0\.0\.1:4791\n {2}From another device, forward the port first: ssh -L 4791:127\.0\.0\.1:4791 <host>\n/)
  // pid는 살아 있는데 보드가 답하지 않는다(남은 pid 파일의 번호를 다른 프로세스가 다시 받았다): 꺼진 것으로 보고 띄운다
  healthy = false; probed.length = 0
  const reused = await run1()
  assert.equal(reused.r.autostart.state, 'starting'); assert.equal(reused.spawned.length, 1); assert.deepEqual(probed, ['4791']); assert.doesNotMatch(reused.term.text(), /keeps the old version/)
  healthy = true
  // 보드가 꺼져 있고 herdr가 켜져 있으면 띄운다(제거 뒤 재설치·실패한 설치의 재시도). 자동 시작을 껐으면 다음에 herdr를 켤 때.
  writeFileSync(join(state, 'server.pid'), '999999999'); probed.length = 0
  const down = await run1()
  assert.equal(down.r.state, 'existing'); assert.equal(down.spawned.length, 1); assert.doesNotMatch(down.term.text(), /Type a number|keeps the old version/); assert.deepEqual(probed, [], '죽은 pid면 묻지도 않는다')
  // 감지를 돌리지 않아 빈 포트를 모른다: 설정한 포트에 '(다음 포트)'를 붙이고, 브라우저가 열리는지도 말한다
  assert.match(down.term.text(), /whosup updated\. Your settings are kept\.\n {2}The board was not running, so it starts now: {2}http:\/\/127\.0\.0\.1:4790 \(next port if taken\)\n {2}Your browser opens it\.\n {2}To be asked again/)
  assert.match((await run1({ env: { SSH_CONNECTION: '1.2.3.4 1 5.6.7.8 22' } })).term.text(), /starts now: {2}http:\/\/127\.0\.0\.1:4790 \(next port if taken\)\n {2}No browser opens by itself here\. Open that address on this computer\.\n {2}From another device, forward the port first: ssh -L 4790:127\.0\.0\.1:4790 <host>\n/)
  assert.match((await run1({ env: { OPEN_BROWSER: '0' } })).term.text(), /\(next port if taken\)\n {2}No browser opens by itself here\. Open that address on this computer\.\n {2}To be asked again/)
  assert.equal((await run1({ terminal: null })).spawned.length, 1, '터미널이 없어도 꺼진 보드는 띄운다')
  const noStart = await run1({ env: { WHOSUP_NO_AUTOSTART: '1' } })
  assert.deepEqual(noStart.spawned, []); assert.match(noStart.term.text(), new RegExp(`\\n {2}The board starts the next time herdr starts: {2}http://127\\.0\\.0\\.1:4790\\n {2}To start it by hand, type this in a terminal inside herdr:\\n {6}herdr plugin action invoke ${ID}\\.start\\n`), 'herdr는 켜져 있으니 손 명령을 싣는다')
  // herdr가 꺼져 있다: 무엇을 어디에 치면 되는지 알려 준다 — 그 상태에서 실패하는 손 명령(plugin action invoke)은 싣지 않는다
  const off = await run1({ sessions: [] })
  assert.equal(off.r.autostart.state, 'herdr_off'); assert.deepEqual(off.spawned, [])
  assert.equal(off.term.text(), [
    '', 'whosup updated. Your settings are kept.', '  herdr is not running right now.', '    Type this in this terminal and press Enter:', '        herdr',
    '    The board starts with herdr every time. Your browser opens http://127.0.0.1:4790',
    '  To be asked again, type this in a terminal (or use "open first-run setup again" in the board\'s settings):', '      WHOSUP_SETUP=1 herdr plugin install fivetaku/whosup --yes', '', '',
  ].join('\n'))
  assert.deepEqual(updatedLines({ id: ID, state: 'herdr_off', env: { PORT: '4811' } }, TEXT.ko), [
    'whosup을 업데이트했습니다. 설정은 그대로입니다.', '  herdr가 꺼져 있습니다.', '    이 터미널에 아래를 치고 Enter를 누르세요:', '        herdr',
    '    herdr를 켤 때마다 보드가 같이 뜨고 브라우저에서 열립니다: http://127.0.0.1:4811', `  ${TEXT.ko.updatedAgain}`, '      WHOSUP_SETUP=1 herdr plugin install fivetaku/whosup --yes',
  ])
  assert.doesNotMatch(updatedLines({ id: ID, state: 'off', herdrUp: false }, TEXT.en).join('\n'), /plugin action invoke/, '자동 시작을 껐고 herdr도 꺼져 있으면 herdr를 치라고 한다')
  assert.deepEqual(updatedLines({ id: ID, state: 'no_herdr' }, TEXT.en).slice(1, -2), ['  The board starts the next time herdr starts:  http://127.0.0.1:4790'])
  const again = await run1({ env: { WHOSUP_SETUP: '1' } })
  assert.equal(again.r.state, 'done'); assert.deepEqual(again.r.choices, { click_target: 'web' })
  // 이제 setup.json이 있다 → whosup.db가 없어도 기존 설치
  const home2 = tmp('exist2'); const conf2 = join(home2, '.config', 'herdr', 'plugins', 'config', ID)
  mkdirSync(conf2, { recursive: true }); writeSetup(conf2, {})
  const term = fakeTerm('2\n'); const { run } = fakeRun()
  assert.equal((await runSetup({ install: true, env: isoEnv(home2), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => facts(FULL), run, herdrBin: 'herdr', spawnFn: () => 1 })).state, 'existing')
  const forced = fakeTerm('\n3\n\n\n')
  const f = await runSetup({ install: true, force: true, env: isoEnv(home2), platform: 'darwin', root: ROOT, terminal: forced, detectFn: async () => facts(FULL), run, herdrBin: 'herdr', spawnFn: () => 1 })
  assert.deepEqual(f.choices, { front_app: 'iTerm' })
  // 손으로 칠 명령: 데스크를 모르면 'herdr 안의 터미널'에 치라고 하고, 이름 붙은 데스크면 --session <이름>, 기본 데스크면 그대로
  assert.deepEqual(updatedLines({ id: ID, platform: 'win32' }, TEXT.en).filter((l) => /invoke/.test(l)).map((l) => l.trim()), [`herdr plugin action invoke ${ID}.win-stop`, `herdr plugin action invoke ${ID}.win-start`])
  assert.equal(updatedLines({ id: ID }, TEXT.en)[2], '  To restart it, type these two lines in a terminal inside herdr (start herdr first if it is not running):')
  assert.equal(updatedLines({ id: ID, desk: 'default' }, TEXT.en)[2], '  To restart it, type these two lines in a terminal:')
  assert.deepEqual(updatedLines({ id: ID, desk: 'main' }, TEXT.ko).slice(1, 5), ['  실행 중인 보드는 다시 시작해야 새 버전이 됩니다.', '  다시 시작하려면 터미널에 아래 두 줄을 치세요:', `      herdr --session main plugin action invoke ${ID}.stop`, `      herdr --session main plugin action invoke ${ID}.start`])
  assert.equal(updatedLines({ id: ID, desk: 'default', boardPort: '4793', env: { PORT: '4790' } }, TEXT.en)[5], '  The board:  http://127.0.0.1:4793', '실행 중이면 실제 포트')
  for (const state of ['running', 'starting', 'herdr_off', 'no_herdr', 'off', 'unknown', 'spawn_failed']) for (const lang of ['ko', 'en']) {
    const ls = updatedLines({ id: ID, state, desktop: false }, TEXT[lang])
    assert.ok(ls.length <= 12, `${state}: ${ls.length}줄`); assert.equal(ls.join('\n').match(/http:\/\/127\.0\.0\.1:4790/g).length, 1, `${state}: 주소는 한 번`)
  }
})

test('herdr가 플러그인에 주는 폴더(규칙): XDG > 윈도우 APPDATA·LOCALAPPDATA·USERPROFILE > 홈', () => {
  assert.deepEqual(herdrPluginDirs(ID, { HOME: '/h' }, 'darwin'), { config: `/h/.config/herdr/plugins/config/${ID}`, state: `/h/.local/state/herdr/plugins/${ID}` })
  assert.deepEqual(herdrPluginDirs(ID, { HOME: '/h', XDG_CONFIG_HOME: '/xc', XDG_STATE_HOME: '/xs' }, 'linux'), { config: `/xc/herdr/plugins/config/${ID}`, state: `/xs/herdr/plugins/${ID}` })
  assert.deepEqual(herdrPluginDirs(ID, { APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'), { config: `C:\\Users\\me\\AppData\\Roaming\\herdr\\plugins\\config\\${ID}`, state: `C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\${ID}` })
  assert.deepEqual(herdrPluginDirs(ID, { USERPROFILE: 'C:\\Users\\me' }, 'win32'), { config: `C:\\Users\\me\\AppData\\Roaming\\herdr\\plugins\\config\\${ID}`, state: `C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\${ID}` })
  assert.equal(herdrPluginDirs(ID, { XDG_CONFIG_HOME: 'D:\\xdg', USERPROFILE: 'C:\\Users\\me' }, 'win32').config, `D:\\xdg\\herdr\\plugins\\config\\${ID}`)
  assert.equal(herdrPluginDirs('Example:a', { HOME: '/h' }, 'linux').config, '/h/.config/herdr/plugins/config/%45xample%3Aa', 'herdr와 같은 폴더 이름 규칙')
  // XDG 값은 절대 경로일 때만 쓴다(src/paths.mjs xdgDir — 단독 설치·install.sh와 같은 판정): 상대 경로·제어 문자가 든 값은 없는 것으로 보고 다음 규칙으로 간다
  const base = { config: `/h/.config/herdr/plugins/config/${ID}`, state: `/h/.local/state/herdr/plugins/${ID}` }
  for (const bad of ['.', 'rel/dir', '', '/x\ny', '/x\u0001', '/x\u007f']) {
    assert.deepEqual(herdrPluginDirs(ID, { HOME: '/h', XDG_CONFIG_HOME: bad, XDG_STATE_HOME: bad }, 'linux'), base, JSON.stringify(bad))
    assert.deepEqual(herdrPluginDirs(ID, { HOME: '/h', XDG_CONFIG_HOME: bad, XDG_STATE_HOME: bad }, 'darwin'), base, JSON.stringify(bad))
  }
  // 한쪽만 틀리면 그쪽만 기본값이다. 윈도우에서는 윈도우의 절대 경로로 판정한다(상대 값이면 APPDATA·LOCALAPPDATA로 간다)
  assert.deepEqual(herdrPluginDirs(ID, { HOME: '/h', XDG_CONFIG_HOME: 'rel', XDG_STATE_HOME: '/xs' }, 'linux'), { config: base.config, state: `/xs/herdr/plugins/${ID}` })
  assert.deepEqual(herdrPluginDirs(ID, { XDG_CONFIG_HOME: 'xdg', XDG_STATE_HOME: '.', APPDATA: 'C:\\Users\\me\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'win32'),
    { config: `C:\\Users\\me\\AppData\\Roaming\\herdr\\plugins\\config\\${ID}`, state: `C:\\Users\\me\\AppData\\Local\\herdr\\plugins\\${ID}` })
  assert.equal(manifestId(ROOT), ID); assert.equal(manifestId(join(ROOT, 'no-such-folder')), ID)
})

test('데스크 고르기: (손 실행에서) 이 터미널이 속한 데스크 > 기본 데스크 > 실행 중인 첫 데스크, 실행 중인 것이 없으면 없음', () => {
  const s = (name, status = 'running', socket = `/s/${name}`) => ({ name, status, socket })
  assert.equal(pickDesk([], {}), null); assert.equal(pickDesk([s('default', 'stopped')], {}), null); assert.equal(pickDesk(null, {}), null)
  assert.deepEqual(pickDesk([s('work'), s('default')], {}), { name: 'default', args: ['--session', 'default'] })
  assert.deepEqual(pickDesk([s('default', 'stopped'), s('work'), s('side')], {}), { name: 'work', args: ['--session', 'work'] })
  assert.equal(pickDesk([s('default'), s('work'), s('side')], { HERDR_SESSION: 'side' }).name, 'side')
  assert.equal(pickDesk([s('default'), s('work'), s('side')], { HERDR_SOCKET_PATH: '/s/work', HERDR_SESSION: 'side' }).name, 'work')
  assert.equal(pickDesk([s('default'), s('work', 'stopped')], { HERDR_SESSION: 'work' }).name, 'default', '꺼진 데스크는 고르지 않는다')
})

test('자동 시작: 실행 중인 데스크가 있으면 도우미를 띄우고(설치 명령의 PID·데스크 이름 전달), 없으면 띄우지 않는다', async () => {
  const go = async ({ sessions, plugins, install = true, herdrBin = '/opt/bin/herdr', enabled = true, platform = 'darwin' }) => {
    const { run, calls } = fakeRun({ sessions, plugins }); const spawned = []
    const r = await autostart({ enabled, install, id: ID, env: {}, platform, herdrBin, run, spawnFn: (s) => { spawned.push(s); return 99 }, installerPid: '4321' })
    return { r, calls, spawned }
  }
  const on = await go({ sessions: [{ name: 'work', running: true, socket_path: '/w' }] })
  assert.equal(on.r.state, 'starting'); assert.equal(on.r.desk, 'work'); assert.equal(on.spawned.length, 1)
  assert.deepEqual(on.r.params, { pid: 4321, file: '/opt/bin/herdr', base: [], session: ['--session', 'work'], id: ID, action: `${ID}.start`, waitMs: 120000, listMs: 10000 })
  assert.deepEqual(on.calls, [['session', 'list', '--json']], '설치 중에는 등록 전이라 plugin list를 미리 보지 않는다(도우미가 본다)')
  assert.equal((await go({ sessions: [{ name: 'work', running: true }], platform: 'win32' })).r.params.action, `${ID}.win-start`)
  assert.equal((await go({ sessions: [] })).r.state, 'herdr_off'); assert.equal((await go({ sessions: [{ name: 'work', running: false }] })).spawned.length, 0)
  assert.equal((await go({ sessions: RUNNING, herdrBin: null })).r.state, 'no_herdr')
  assert.deepEqual((await go({ sessions: RUNNING, enabled: false })).r, { state: 'off', herdrUp: true }); assert.deepEqual((await go({ sessions: RUNNING, enabled: false })).spawned, [])
  assert.deepEqual((await go({ sessions: [], enabled: false })).r, { state: 'off', herdrUp: false }); assert.deepEqual((await go({ sessions: RUNNING, enabled: false, herdrBin: null })).r, { state: 'off', herdrUp: false, herdr: 'none' })
  assert.deepEqual(await autostart({ enabled: false, install: true, id: ID, env: {}, platform: 'darwin', herdrBin: 'herdr', run: fakeRun({ sessions: RUNNING, fail: ['session list --json', 'session list'] }).run, spawnFn: () => 1 }), { state: 'off', herdrUp: false, herdr: 'unknown' })
  // 손 실행: herdr에 등록돼 있을 때만, 기다릴 설치 명령은 없다
  const manual = await go({ sessions: RUNNING, install: false, plugins: ID })
  assert.equal(manual.r.state, 'starting'); assert.equal(manual.r.params.pid, 0)
  const unreg = await go({ sessions: RUNNING, install: false })
  assert.equal(unreg.r.state, 'not_registered'); assert.deepEqual(unreg.spawned, [])
  // 등록 여부를 미리 알면(runSetup이 넘긴다) herdr가 꺼져 있든 없든 '등록 안 됨'이 먼저다
  const pre = async (over) => autostart({ install: false, id: ID, env: {}, platform: 'darwin', herdrBin: 'herdr', run: fakeRun({ sessions: [] }).run, spawnFn: () => 1, ...over })
  assert.equal((await pre({ registered: false })).state, 'not_registered'); assert.equal((await pre({ registered: false, herdrBin: null })).state, 'not_registered'); assert.equal((await pre({ registered: false, enabled: false })).state, 'not_registered')
  assert.equal((await pre({ registered: true })).state, 'herdr_off')
  // 등록 여부를 모른다(`plugin list`가 실패했다): '등록 안 됨'으로 단정하지 않는다. 데스크를 찾으면 한 번 더 묻고, 그래도 모르면 모르는 채로 둔다
  const flaky = (o) => fakeRun({ sessions: RUNNING, plugins: ID, ...o })
  assert.deepEqual(await pre({ run: flaky({ fail: ['plugin list'] }).run }), { state: 'reg_unknown', desk: 'default' }, '다시 물어도 실패')
  assert.deepEqual(await pre({ run: flaky({ sessions: [] }).run }), { state: 'reg_unknown' }, 'herdr가 꺼져 있어 물어볼 데스크가 없다')
  assert.equal((await pre({ run: flaky().run })).state, 'starting', '다시 물어 등록돼 있으면 띄운다')
  assert.equal((await pre({ run: flaky({ plugins: '' }).run })).state, 'not_registered', '목록을 읽었는데 없을 때만 등록 안 됨')
  // 데스크 목록을 두 방식 모두 못 읽었다: 꺼져 있다고 단정하지 않는다(unknown). 데스크를 찾았는데 도우미를 못 띄웠다: herdr는 켜져 있다(spawn_failed)
  const blindRun = fakeRun({ sessions: RUNNING, fail: ['session list --json', 'session list'] })
  assert.deepEqual(await autostart({ install: true, id: ID, env: {}, platform: 'darwin', herdrBin: 'herdr', run: blindRun.run, spawnFn: () => 1 }), { state: 'unknown' })
  assert.deepEqual(blindRun.calls, [['session', 'list', '--json'], ['session', 'list']])
  assert.deepEqual(await autostart({ install: true, id: ID, env: {}, platform: 'darwin', herdrBin: 'herdr', run: fakeRun({ sessions: [{ name: 'main', running: true }] }).run, spawnFn: () => { throw new Error('EAGAIN') } }), { state: 'spawn_failed', desk: 'main' })
  // 보드가 이미 떠 있으면 도우미를 띄우지 않는다(데스크 이름만 알아 온다)
  const up = fakeRun({ sessions: [{ name: 'main', running: true }] }); const upSpawn = []
  assert.deepEqual(await autostart({ install: true, boardUp: true, id: ID, env: {}, platform: 'darwin', herdrBin: 'herdr', run: up.run, spawnFn: (x) => upSpawn.push(x) }), { state: 'running', desk: 'main' })
  assert.deepEqual(upSpawn, [])
})

test('떠 있는 보드: server.pid가 살아 있는 프로세스이고 그 보드가 /api/health에 답할 때만 — 포트는 <상태 폴더>/port, 없으면 설정 포트', async () => {
  const st = tmp('state')
  const asked = []
  const probe = (answer) => async (port) => { asked.push(port); return answer }
  assert.deepEqual(await boardStatus(st, { probe: probe(true) }), { up: false, port: null }); assert.deepEqual(await boardStatus(join(st, 'none'), { probe: probe(true) }), { up: false, port: null })
  assert.deepEqual(asked, [], 'pid 파일이 없으면 묻지 않는다')
  writeFileSync(join(st, 'server.pid'), `${process.pid}\n`); writeFileSync(join(st, 'port'), '4791\n')
  assert.deepEqual(await boardStatus(st, { probe: probe(true) }), { up: true, port: '4791' }); assert.deepEqual(asked, ['4791'])
  // 살아 있는 pid지만 보드가 답하지 않는다(재부팅·강제 종료 뒤 남은 pid 파일 + 그 번호를 다시 받은 다른 프로세스): 꺼짐
  assert.deepEqual(await boardStatus(st, { probe: probe(false) }), { up: false, port: null })
  // 포트 파일이 없으면 설정한 포트에 묻는다(그때 port는 null — 문구가 설정 포트를 쓴다)
  writeFileSync(join(st, 'port'), 'garbage'); asked.length = 0
  assert.deepEqual(await boardStatus(st, { confPort: '4811', probe: probe(true) }), { up: true, port: null }); assert.deepEqual(asked, ['4811'])
  writeFileSync(join(st, 'server.pid'), '999999999'); asked.length = 0
  assert.deepEqual(await boardStatus(st, { probe: probe(true) }), { up: false, port: null }, '죽은 pid의 포트 파일은 믿지 않는다'); assert.deepEqual(asked, [])
  writeFileSync(join(st, 'server.pid'), 'not-a-pid'); assert.equal((await boardStatus(st, { probe: probe(true) })).up, false)
  // 실제로 묻기(이 시험이 띄운 임시 서버에만): /api/health가 200이면 답한 것, 그 밖·닫힌 포트·시간 초과는 아니다
  let status = 200
  const srv = createServer((req, res) => { res.writeHead(req.url === '/api/health' ? status : 404); res.end('{}') })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const port = srv.address().port
  try {
    assert.equal(await boardAnswers(port), true)
    status = 500; assert.equal(await boardAnswers(port), false, '200이 아니면 답한 것이 아니다'); status = 200
    writeFileSync(join(st, 'server.pid'), String(process.pid)); writeFileSync(join(st, 'port'), String(port))
    assert.deepEqual(await boardStatus(st), { up: true, port: String(port) })
  } finally { await new Promise((r) => srv.close(r)) }
  assert.equal(await boardAnswers(port, { timeoutMs: 300 }), false, '닫힌 포트')
  assert.deepEqual(await boardStatus(st), { up: false, port: null })
  // runSetup은 설정한 포트(.env의 PORT)를 넘긴다
  let got = null
  await setupWith({ typed: '\n\n\n\n', install: false, env: { HERDR_PLUGIN_CONFIG_DIR: tmp('cp') }, plugins: ID, readEnvFile: () => ({ PORT: '4811' }), boardFn: (dir, o) => { got = o; return { up: false, port: null } } })
  assert.deepEqual(got, { confPort: '4811' })
})

test('도우미 스크립트: 값은 JSON으로만 싣고 herdr는 인자 배열로 부른다(셸 없음), 어디에도 글자를 쓰지 않는다', () => {
  const nasty = 'a"b; rm -rf ~ $(id) `x` \\ \n\'q\''
  const p = helperParams({ installerPid: '4321', herdr: '/opt/my bin/herdr', sessionArgs: ['--session', nasty], id: ID, platform: 'linux' })
  const src = helperScript(p)
  assert.doesNotThrow(() => new Script(src), '문법이 맞는 한 덩어리 스크립트')
  assert.deepEqual(JSON.parse(/^const P = (.*)$/m.exec(src)[1]), p, '첫 줄의 JSON이 인자 그대로다(세션 이름이 코드로 읽히지 않는다)')
  assert.match(src, /execFile\(P\.file, P\.base\.concat\(args\)/); assert.doesNotMatch(src, /shell|exec\(|execSync|console\.|process\.std|writeFile|import\.meta|__dirname|__filename/)
  assert.match(src, /P\.session\.concat\(\['plugin', 'action', 'invoke', P\.action\]\)/)
  assert.match(src, /process\.kill\(pid, 0\)/); assert.match(src, /\['plugin', 'list'\]/)
  assert.equal(helperParams({ installerPid: undefined, herdr: 'herdr', id: ID }).pid, 0, 'PID를 모르면 기다리지 않는다')
  assert.equal(helperParams({ installerPid: '1', herdr: 'herdr', id: ID }).pid, 0, 'init(1)은 기다리지 않는다')
  // herdr가 node 스크립트(시험의 가짜 herdr)면 지금 도는 node로 돌린다
  const viaNode = helperParams({ installerPid: 5, herdr: FAKE, id: ID })
  assert.equal(viaNode.file, process.execPath); assert.deepEqual(viaNode.base, [FAKE])
})

test('도우미 실행: 설치 명령이 끝나기를 기다리고 → plugin list에 id가 보이면 → 그 데스크에 start 액션을 한 번 부른다', async () => {
  const dir = tmp('helper')
  // 비동기로 띄운다: 동기 실행은 이 프로세스가 끝난 자식(설치 명령 역할)을 거두지 못하게 막아, 도우미가 그것을 살아 있다고 본다.
  const runHelper = (params, env) => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', helperScript(params)], { cwd: dir, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    c.stdout.on('data', (d) => { out += d }); c.stderr.on('data', (d) => { out += d })
    const t = setTimeout(() => c.kill('SIGKILL'), 30000)
    c.on('close', (status) => { clearTimeout(t); resolve({ status, out }) })
  })
  const callsOf = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  // 설치 명령 역할: 0.7초 살아 있는 프로세스
  const installer = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 700)'], { stdio: 'ignore' })
  const log1 = join(dir, 'h1.log')
  const t0 = Date.now()
  const ok = await runHelper(helperParams({ installerPid: installer.pid, herdr: FAKE, sessionArgs: ['--session', 'work'], id: ID, platform: 'darwin' }), { FAKE_HERDR_LOG: log1, FAKE_HERDR_PLUGINS: ID })
  assert.equal(ok.status, 0); assert.equal(ok.out, '', '아무 글자도 쓰지 않는다')
  assert.ok(Date.now() - t0 >= 500, '설치 명령이 끝날 때까지 기다렸다')
  assert.deepEqual(callsOf(log1), [['plugin', 'list'], ['--session', 'work', 'plugin', 'action', 'invoke', `${ID}.start`]])
  // 등록되지 않으면(설치 실패) 액션을 부르지 않고 조용히 끝난다
  const log2 = join(dir, 'h2.log')
  const no = await runHelper({ ...helperParams({ installerPid: 0, herdr: FAKE, sessionArgs: ['--session', 'work'], id: ID }), listMs: 300 }, { FAKE_HERDR_LOG: log2, FAKE_HERDR_PLUGINS: `x${ID},${ID}-extra` })
  assert.equal(no.status, 0); assert.equal(no.out, '')
  assert.ok(callsOf(log2).length >= 1 && callsOf(log2).every((c) => c.join(' ') === 'plugin list'), '이름이 비슷한 다른 플러그인은 등록으로 보지 않는다')
  // 설치 명령이 끝나지 않으면 포기한다
  const log3 = join(dir, 'h3.log')
  const stuck = await runHelper({ ...helperParams({ installerPid: process.pid, herdr: FAKE, sessionArgs: [], id: ID }), waitMs: 300 }, { FAKE_HERDR_LOG: log3, FAKE_HERDR_PLUGINS: ID })
  assert.equal(stuck.status, 0); assert.deepEqual(callsOf(log3), [])
})

test('마무리 문구: herdr 켜짐(주소·다음 포트·브라우저) / herdr 꺼짐(이 터미널에 herdr를 치라는 안내) — 그대로 칠 명령은 따로 한 줄, ko·en, 한 화면 안', async () => {
  const on = closingLines({ state: 'starting', id: ID, env: {}, platform: 'darwin', desktop: true, desk: 'default' }, TEXT.en)
  assert.deepEqual(on, [
    'The board is starting now:  http://127.0.0.1:4790 (next port if taken)', '  Your browser opens it.',
    'From now on the board starts whenever herdr starts.', 'To change any of this, use settings in the board.',
    'To start it by hand, type this in a terminal:', `    herdr plugin action invoke ${ID}.start`,
  ])
  assert.match(closingLines({ state: 'starting', id: ID, env: { PORT: '4801' }, desktop: true }, TEXT.en)[0], /http:\/\/127\.0\.0\.1:4801 /)
  assert.match(closingLines({ state: 'starting', id: ID, env: { PORT: '$(x)' }, desktop: true }, TEXT.en)[0], /:4790 /, '이상한 PORT는 쓰지 않는다')
  // 설정한 포트가 다른 프로그램에 잡혀 있으면 감지가 찾은 빈 포트(보드가 실제로 뜰 곳)를 찍는다
  assert.match(closingLines({ state: 'starting', id: ID, env: {}, desktop: true, freePort: 4791 }, TEXT.en)[0], /^The board is starting now: {2}http:\/\/127\.0\.0\.1:4791 \(next port if taken\)$/)
  assert.match(closingLines({ state: 'starting', id: ID, env: {}, desktop: true, freePort: 'x' }, TEXT.en)[0], /:4790 /)
  assert.match(closingLines({ state: 'starting', id: ID, env: { PORT: '4811' }, desktop: true, freePort: 4790 }, TEXT.en)[0], /:4811 /, '설정한 포트에서 시작해 찾은 빈 포트만 쓴다')
  // 브라우저가 저절로 열리지 않는 곳: OPEN_BROWSER=0이면 한 줄, 원격이면 포트 넘기는 법까지
  const local0 = closingLines({ state: 'starting', id: ID, desktop: true, env: { OPEN_BROWSER: '0' } }, TEXT.en)
  assert.equal(local0[1], '  No browser opens by itself here. Open that address on this computer.'); assert.equal(local0[2], TEXT.en.always, '원격이 아니면 ssh 안내는 없다')
  const remote = closingLines({ state: 'starting', id: ID, desktop: false, env: {}, freePort: 4791 }, TEXT.en)
  assert.deepEqual(remote.slice(1, 3), ['  No browser opens by itself here. Open that address on this computer.', '  From another device, forward the port first: ssh -L 4791:127.0.0.1:4791 <host>'])

  // herdr가 꺼져 있다: 어디에 무엇을 치는지(이 터미널 + 따로 들여 쓴 herdr 한 줄) + 그러면 무슨 일이 일어나는지(주소 포함) —
  // 그 상태에서 실패하는 손 명령(plugin action invoke)은 싣지 않고, "herdr를 켤 때마다 같이 뜬다"는 말은 한 번만 한다
  assert.deepEqual(closingLines({ state: 'herdr_off', id: ID, env: {}, platform: 'darwin', desktop: true }, TEXT.en), [
    'herdr is not running right now.', '  Type this in this terminal and press Enter:', '      herdr',
    '  The board starts with herdr every time. Your browser opens http://127.0.0.1:4790', 'To change any of this, use settings in the board.',
  ])
  assert.deepEqual(closingLines({ state: 'herdr_off', id: ID, env: { PORT: '4811' }, platform: 'darwin', desktop: true }, TEXT.ko), [
    'herdr가 꺼져 있습니다.', '  이 터미널에 아래를 치고 Enter를 누르세요:', '      herdr',
    '  herdr를 켤 때마다 보드가 같이 뜨고 브라우저에서 열립니다: http://127.0.0.1:4811', '바꾸려면 보드의 설정에서 바꿉니다.',
  ])
  // 브라우저가 저절로 열리지 않는 곳이면 그 주소를 열라고 하고, 원격이면 포트 넘기는 법까지
  assert.deepEqual(closingLines({ state: 'herdr_off', id: ID, desktop: false, env: {} }, TEXT.ko).slice(3, 5), ['  herdr를 켤 때마다 보드가 같이 뜹니다. 여기서는 브라우저가 저절로 열리지 않으니 이 주소를 여세요: http://127.0.0.1:4790', '  다른 기기에서 보려면 먼저 포트를 넘깁니다: ssh -L 4790:127.0.0.1:4790 <host>'])
  assert.deepEqual(closingLines({ state: 'herdr_off', id: ID, desktop: true, env: { OPEN_BROWSER: '0' } }, TEXT.en).slice(3), ['  The board starts with herdr every time. No browser opens by itself here, so open http://127.0.0.1:4790', 'To change any of this, use settings in the board.'])
  // herdr를 못 찾았다: 다음에 herdr를 켤 때 뜬다 + 주소. 손 명령은 없다. 자동 시작만 껐고 herdr는 켜져 있으면 손 명령을 싣는다
  assert.deepEqual(closingLines({ state: 'no_herdr', id: ID, env: {} }, TEXT.en), ['The board starts the next time herdr starts:  http://127.0.0.1:4790', 'To change any of this, use settings in the board.'])
  assert.deepEqual(closingLines({ state: 'no_herdr', id: ID, env: {}, desktop: false }, TEXT.en).slice(1, 3), ['  No browser opens by itself here. Open that address on this computer.', '  From another device, forward the port first: ssh -L 4790:127.0.0.1:4790 <host>'])
  assert.deepEqual(closingLines({ state: 'off', herdrUp: true, id: ID, env: {}, desk: 'default' }, TEXT.en), ['The board starts the next time herdr starts:  http://127.0.0.1:4790', 'To start it by hand, type this in a terminal:', `    herdr plugin action invoke ${ID}.start`, 'To change any of this, use settings in the board.'])
  assert.deepEqual(closingLines({ state: 'off', herdrUp: false, id: ID, env: {} }, TEXT.en), closingLines({ state: 'herdr_off', id: ID, env: {} }, TEXT.en), '자동 시작을 껐고 herdr도 꺼져 있으면 herdr 꺼짐과 같은 안내')
  // 자동 시작을 껐을 때도 herdr를 못 찾았거나 목록을 못 읽었으면 "꺼져 있습니다"라고 하지 않는다
  assert.deepEqual(closingLines({ state: 'off', herdrUp: false, herdr: 'none', id: ID, env: {} }, TEXT.en), closingLines({ state: 'no_herdr', id: ID, env: {} }, TEXT.en))
  assert.deepEqual(closingLines({ state: 'off', herdrUp: false, herdr: 'unknown', id: ID, env: {} }, TEXT.en), closingLines({ state: 'unknown', id: ID, env: {} }, TEXT.en))
  assert.doesNotMatch((await setupWith({ typed: '\n\n\n\n', sessions: RUNNING, env: { WHOSUP_NO_AUTOSTART: '1' }, fail: ['session list --json', 'session list'] })).term.text(), /herdr is not running right now/)
  // 데스크 목록을 못 읽었다: 꺼져 있다고 단정하지 않고 두 경우를 나눠 안내한다
  assert.deepEqual(closingLines({ state: 'unknown', id: ID, env: {}, desktop: true }, TEXT.en), [
    'Could not check whether herdr is running.', '  If it is not running, type this in this terminal and press Enter:', '      herdr',
    '  If it is running, type this in a terminal inside herdr:', `      herdr plugin action invoke ${ID}.start`,
    '  The board starts with herdr every time. Your browser opens http://127.0.0.1:4790', 'To change any of this, use settings in the board.',
  ])
  assert.deepEqual(closingLines({ state: 'unknown', id: ID, env: {}, desktop: true }, TEXT.ko).slice(0, 5), ['herdr가 켜져 있는지 확인하지 못했습니다.', '  꺼져 있으면 이 터미널에 아래를 치고 Enter를 누르세요:', '      herdr', '  켜져 있으면 herdr 안의 터미널에 아래를 치세요:', `      herdr plugin action invoke ${ID}.start`])
  // 데스크는 찾았는데 도우미를 못 띄웠다: herdr는 켜져 있다 — "꺼져 있습니다"가 아니라 손으로 띄우는 명령을 안내한다
  assert.deepEqual(closingLines({ state: 'spawn_failed', id: ID, env: {}, desk: 'main' }, TEXT.en), [
    'Could not start the board from here.', 'To start it by hand, type this in a terminal:', `    herdr --session main plugin action invoke ${ID}.start`,
    'The board:  http://127.0.0.1:4790 (next port if taken)', 'From now on the board starts whenever herdr starts.', 'To change any of this, use settings in the board.',
  ])
  assert.deepEqual(closingLines({ state: 'spawn_failed', id: ID, env: {}, desk: 'main' }, TEXT.ko).slice(0, 2), ['여기서 보드를 띄우지 못했습니다.', '손으로 띄우려면 터미널에 아래를 치세요:'])
  for (const state of ['herdr_off', 'unknown', 'spawn_failed', 'no_herdr', 'off', 'starting', 'running']) for (const lang of ['ko', 'en']) for (const desktop of [true, false, null]) {
    const text = closingLines({ state, id: ID, env: { PORT: '4801' }, desktop }, TEXT[lang]).join('\n')
    assert.equal(text.match(/http:\/\/127\.0\.0\.1:4801/g).length, 1, `${state}/${lang}: 주소는 어느 갈래에서든 한 번(설정한 포트)`)
    assert.doesNotMatch(text, /`|4790/, `${state}/${lang}: 백틱 없음, 4790을 글자로 박지 않는다`)
    if (state === 'herdr_off' || state === 'no_herdr' || state === 'off') assert.doesNotMatch(text, /plugin action invoke/, `${state}: 그 상태에서 실패하는 명령은 싣지 않는다`)
    if (state === 'spawn_failed' || state === 'unknown') assert.doesNotMatch(text, /is not running right now|꺼져 있습니다/, `${state}: 꺼져 있다고 단정하지 않는다`)
    assert.ok((text.match(/whenever herdr starts|every time|the next time herdr starts|켤 때/g) || []).length <= 1, `${state}/${lang}: 같은 말은 한 번만`)
  }

  // 손으로 칠 명령: 이름 붙은 데스크면 --session <이름>(herdr 밖 터미널에서도 통한다), 데스크를 모르면 'herdr 안의 터미널'
  assert.deepEqual(closingLines({ state: 'starting', id: ID, env: {}, desktop: true, desk: 'main' }, TEXT.en).slice(-2), ['To start it by hand, type this in a terminal:', `    herdr --session main plugin action invoke ${ID}.start`])
  assert.deepEqual(closingLines({ state: 'starting', id: ID, env: {}, desktop: true, desk: 'a b;c' }, TEXT.en).slice(-2), ['To start it by hand, type this in a terminal inside herdr:', `    herdr plugin action invoke ${ID}.start`], '이상한 이름은 명령에 넣지 않는다')
  assert.deepEqual(closingLines({ state: 'starting', id: ID, env: {}, desktop: true }, TEXT.ko).slice(-2), ['손으로 띄우려면 herdr 안의 터미널에 아래를 치세요:', `    herdr plugin action invoke ${ID}.start`])
  assert.match(closingLines({ state: 'starting', id: ID, env: {}, platform: 'win32', desktop: true }, TEXT.ko).at(-1), new RegExp(`${ID}\\.win-start$`))
  assert.deepEqual(closingLines({ state: 'not_registered', id: ID, env: {} }, TEXT.en), ['whosup is not registered with herdr as a plugin, so herdr does not start the board.', '  To start it yourself, type this in the whosup folder:', '      npm start', 'To change any of this, use settings in the board.'])
  assert.deepEqual(closingLines({ state: 'reg_unknown', id: ID, env: {}, desk: 'default' }, TEXT.en), [
    'Could not check whether whosup is registered with herdr as a plugin.', '  If it is, the board starts whenever herdr starts. To start it now, type this in a terminal:', `      herdr plugin action invoke ${ID}.start`,
    '  If you run whosup from its own folder, type this in that folder:', '      npm start', 'To change any of this, use settings in the board.',
  ])
  // 보드가 이미 떠 있다(다시 묻기·손 실행): '지금 뜹니다'가 아니라 실행 중이라고 한다. 업데이트(설치 경로)면 재시작 방법을 붙이고,
  // 고른 값은 "다시 시작하면 들어간다"고 한다(돌고 있는 것이 옛 버전일 수 있다). "재시작 없이 반영"은 손 실행에서만 말한다
  assert.deepEqual(closingLines({ state: 'running', id: ID, env: {}, desk: 'default', boardPort: '4791', picked: 1, install: true }, TEXT.en), [
    'The board is already running:  http://127.0.0.1:4791', '  Your choices take effect when the board restarts.', '  A running board keeps the old version until it restarts.',
    '  To restart it, type these two lines in a terminal:', `      herdr plugin action invoke ${ID}.stop`, `      herdr plugin action invoke ${ID}.start`, 'To change any of this, use settings in the board.',
  ])
  assert.doesNotMatch(closingLines({ state: 'running', id: ID, env: {}, picked: 1, install: true }, TEXT.ko).join('\n'), /재시작 없이/)
  assert.equal(closingLines({ state: 'running', id: ID, env: {}, picked: 1, install: true }, TEXT.ko)[1], '  고른 값은 보드를 다시 시작하면 들어갑니다.')
  assert.deepEqual(closingLines({ state: 'running', id: ID, env: {}, desk: 'default', boardPort: '4791', picked: 1, install: false }, TEXT.en), ['The board is already running:  http://127.0.0.1:4791', '  It picks up your choices without a restart.', 'To change any of this, use settings in the board.'])
  assert.deepEqual(closingLines({ state: 'running', id: ID, env: { PORT: '4800' }, desk: 'default', picked: 0, install: false }, TEXT.ko), ['보드는 이미 실행 중입니다:  http://127.0.0.1:4800', '바꾸려면 보드의 설정에서 바꿉니다.'])
  assert.deepEqual(closingLines({ state: 'running', id: ID, env: {}, desktop: false, boardPort: '4791' }, TEXT.en).slice(0, 2), ['The board is already running:  http://127.0.0.1:4791', '  From another device, forward the port first: ssh -L 4791:127.0.0.1:4791 <host>'], '원격이면 실행 중인 보드에도 포트 넘기는 법')

  // 화면 전체: 질문 하나짜리(흔한 경우)는 25줄 안, 네 항목을 다 물어도 30줄 안(전과 같은 기준 — 풀어 쓴 말을 더해도 늘지 않는다)
  const one = await setupWith({ typed: '2\n', f: facts({ ovis: OVIS }), sessions: RUNNING })
  assert.ok(one.term.text().split('\n').length <= 25, `질문 하나: ${one.term.text().split('\n').length}줄`)
  assert.match(one.term.text(), /The board is starting now: {2}http:\/\/127\.0\.0\.1:4790 \(next port if taken\)\n {2}Your browser opens it\.\n/)
  assert.match(one.term.text(), /\n {2}Detected: terminal app Terminal \(default\)\n {12}web terminal ovis 7317 \(desk main\) · agents claude\n {2}Enter keeps the value marked \*\. A number sets your own choice\.\n {2}With no answer for 120 seconds, setup moves on by itself\.\n\n {2}Sessions open in — where a click on a session in the board opens it\n/, '감지한 것 → Enter·번호의 뜻 → 언제 스스로 넘어가는지 → 질문')
  assert.doesNotMatch(one.term.text(), /\x1b\[/, '색을 지원하지 않는 터미널에는 제어 문자를 쓰지 않는다')
  const busy = await setupWith({ typed: '2\n', f: facts({ ovis: OVIS, port: { start: 4790, free: 4792 } }), sessions: [{ name: 'main', running: true }] })
  assert.match(busy.term.text(), /starting now: {2}http:\/\/127\.0\.0\.1:4792 /); assert.match(busy.term.text(), new RegExp(`To start it by hand, type this in a terminal:\\n {4}herdr --session main plugin action invoke ${ID}\\.start\\n`))
  const all = await setupWith({ typed: '\n\n\n\n', sessions: [], env: { LANG: 'ko_KR.UTF-8' } })
  assert.match(all.term.text(), /whosup 첫 실행 안내\n {2}이 컴퓨터를 확인하는 중…\n {2}감지한 것: 터미널 앱 Ghostty · Herdr 앱 · 웹 터미널 ovis 7317\(데스크 main\)\n {13}에이전트 claude, codex\n {2}Enter만 치면 \* 표시한 값을 그대로 씁니다\./)
  assert.match(all.term.text(), /herdr가 꺼져 있습니다\.\n {2}이 터미널에 아래를 치고 Enter를 누르세요:\n {6}herdr\n {2}herdr를 켤 때마다 보드가 같이 뜨고 브라우저에서 열립니다: http:\/\/127\.0\.0\.1:4790\n바꾸려면 보드의 설정에서 바꿉니다\.\n\n$/)
  assert.match(all.term.text(), /번호를 입력하세요 \(Enter만 치면 1번\): {3}터미널 앱 — 세션을 눌렀을 때 앞으로 올릴 앱\n/, '질문 사이에는 빈 줄을 두지 않는다(가짜 터미널은 Enter를 되찍지 않는다)')
  assert.ok(all.term.text().split('\n').length <= 30, `네 항목: ${all.term.text().split('\n').length}줄`)
  const allOn = await setupWith({ typed: '\n\n\n\n', sessions: RUNNING })
  assert.ok(allOn.term.text().split('\n').length <= 30, `네 항목 · herdr 켜짐: ${allOn.term.text().split('\n').length}줄`)
  // 한 줄 길이(가짜 터미널은 Enter를 되찍지 않아 프롬프트 뒤에 다음 질문이 붙는다 — 그 줄은 뺀다)
  for (const l of `${all.term.text()}\n${allOn.term.text()}\n${one.term.text()}`.split('\n').filter((x) => !/: {3}\S/.test(x))) assert.ok(cols(l) <= 90, `한 줄이 너무 길지 않다(${cols(l)}칸): ${l}`)
  // 색: 터미널이 지원하고 NO_COLOR가 없을 때 제목만 굵게
  const color = async (env) => { const term = { ...fakeTerm(), colors: true }; const { run } = fakeRun(); await runSetup({ install: true, env: isoEnv(tmp('c'), env), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => facts(), run, herdrBin: 'herdr', spawnFn: () => 1 }); return term.out.join('') }
  assert.match(await color({}), /\x1b\[1mwhosup first-run setup\x1b\[0m/)
  assert.doesNotMatch(await color({ NO_COLOR: '1' }), /\x1b\[/); assert.doesNotMatch(await color({ TERM: 'dumb' }), /\x1b\[/)
})

test('손 실행(node scripts/setup.mjs): 늘 묻고, 자기 설정 폴더(HERDR_PLUGIN_CONFIG_DIR, 없으면 ~/.config/whosup)에 쓴다 — herdr에 등록돼 있으면 herdr의 설정 폴더가 기준', async () => {
  const conf = tmp('manual')
  const m = await setupWith({ typed: '\n\n\n2\n', install: false, env: { HERDR_PLUGIN_CONFIG_DIR: conf }, sessions: RUNNING, plugins: ID, readEnvFile: (dir) => (dir === conf ? { AGENT_CMD: 'cct', PORT: '4811' } : {}) })
  assert.equal(m.r.state, 'done')
  assert.deepEqual(readSetup(join(conf, 'setup.json')).choices, { agent_cmd: 'claude' }, '.env의 cct가 미리 골라지고(1번), 2번 claude를 골랐다')
  assert.match(m.term.text(), /1\) cct \*   2\) claude   3\) codex/)
  assert.match(m.term.text(), /http:\/\/127\.0\.0\.1:4811/, '.env의 PORT')
  assert.deepEqual(readdirSync(conf), ['setup.json'], '.env를 만들거나 고치지 않는다')
  assert.equal(m.spawned.length, 1); assert.equal(JSON.parse(/^const P = (.*)$/m.exec(m.spawned[0])[1]).pid, 0, '기다릴 설치 명령이 없다')
  // 이미 셋업한 폴더여도 손 실행은 다시 묻는다
  const again = await setupWith({ typed: '3\n\n\n\n', install: false, env: { HERDR_PLUGIN_CONFIG_DIR: conf }, plugins: ID })
  assert.deepEqual(readSetup(join(conf, 'setup.json')).choices, { agent_cmd: 'claude', click_target: 'both' }, '보드가 아직 안 떴으면(whosup.db 없음) 앞서 고른 값은 이어 쓴다')
  assert.deepEqual(again.spawned, [])
  // herdr에 등록되지 않은 손 실행(폴더에서 npm start로 쓰는 사람): herdr가 꺼져 있든 없든 '직접 띄우세요'만 — herdr가 띄워 준다고 하지 않는다
  for (const over of [{ sessions: [] }, { sessions: RUNNING }, { herdrBin: null }]) {
    const u = await setupWith({ typed: '3\n\n\n\n', install: false, ...over })
    assert.equal(u.r.autostart.state, 'not_registered'); assert.deepEqual(u.spawned, [])
    assert.match(u.term.text(), /whosup is not registered with herdr as a plugin, so herdr does not start the board\.\n {2}To start it yourself, type this in the whosup folder:\n {6}npm start\nTo change any of this, use settings in the board\.\n\n$/)
    assert.doesNotMatch(u.term.text(), /starts whenever herdr starts|Type this in this terminal|To start it by hand|`/)
    assert.deepEqual(u.r.saved, [join(u.home, '.config', 'whosup', 'setup.json')], '등록되지 않았으면 ~/.config/whosup에 쓴다')
  }
  // herdr에 등록된 설치를 손 실행: herdr의 설정 폴더에만 쓴다 — ~/.config/whosup이 없으면 만들지 않는다(보드가 읽지 않는 파일)
  const reg = await setupWith({ typed: '2\n\n\n\n', install: false, sessions: RUNNING, plugins: ID })
  assert.deepEqual(reg.r.saved, [reg.file]); assert.equal(existsSync(join(reg.home, '.config', 'whosup')), false)
  // ~/.config/whosup이 이미 있는 등록 사용자(손으로도 띄우는 사람·옛 버전이 만든 폴더): 두 곳 모두에 쓰되 herdr의 설정 폴더가 기준이다 —
  // .env는 herdr의 설정 폴더에서 읽는다(등록된 보드가 읽는 곳). ~/.config/whosup의 .env는 보지 않는다
  const both = tmp('home'); mkdirSync(join(both, '.config', 'whosup'), { recursive: true })
  const herdrConf = join(both, '.config', 'herdr', 'plugins', 'config', ID)
  const { run } = fakeRun({ sessions: RUNNING, plugins: ID })
  const readFrom = []
  const bTerm = fakeTerm('3\n\n\n\n')
  const b = await runSetup({ install: false, env: isoEnv(both), platform: 'darwin', root: ROOT, terminal: bTerm, detectFn: async () => facts(FULL), run, herdrBin: 'herdr', spawnFn: () => 1, readEnvFile: (dir) => { readFrom.push(dir); return dir === herdrConf ? { AGENT_CMD: 'cct', PORT: '4811' } : { AGENT_CMD: 'wrong', PORT: '4999' } } })
  assert.deepEqual(b.saved, [join(herdrConf, 'setup.json'), join(both, '.config', 'whosup', 'setup.json')], 'herdr의 설정 폴더가 첫째')
  assert.deepEqual(readFrom, [herdrConf]); assert.match(bTerm.text(), /1\) cct \*   2\) claude   3\) codex/); assert.match(bTerm.text(), /http:\/\/127\.0\.0\.1:4811/); assert.doesNotMatch(bTerm.text(), /wrong|4999/)
  // `herdr plugin list`가 실패했다(시간 초과·오류): 등록 여부는 '모름' — "등록 안 됨"이라고 단정하지 않는다
  const flaky = await setupWith({ typed: '3\n\n\n\n', install: false, sessions: RUNNING, plugins: ID, fail: ['plugin list'] })
  assert.equal(flaky.r.autostart.state, 'reg_unknown'); assert.deepEqual(flaky.spawned, [])
  assert.doesNotMatch(flaky.term.text(), /is not registered/)
  assert.match(flaky.term.text(), new RegExp(`Could not check whether whosup is registered with herdr as a plugin\\.\\n {2}If it is, the board starts whenever herdr starts\\. To start it now, type this in a terminal:\\n {6}herdr plugin action invoke ${ID}\\.start\\n {2}If you run whosup from its own folder, type this in that folder:\\n {6}npm start\\n`))
  assert.deepEqual(flaky.r.saved, [join(flaky.home, '.config', 'whosup', 'setup.json')], 'herdr의 설정 폴더가 없으면 새로 만들지 않고 자기 폴더에 쓴다')
  // 모르는데 herdr의 설정 폴더가 이미 있으면(등록해 쓰던 사람) 거기에 쓴다
  const known = tmp('home'); const knownConf = join(known, '.config', 'herdr', 'plugins', 'config', ID); mkdirSync(knownConf, { recursive: true })
  const k = await runSetup({ install: false, env: isoEnv(known), platform: 'darwin', root: ROOT, terminal: fakeTerm('2\n\n\n\n'), detectFn: async () => facts(FULL), run: fakeRun({ sessions: RUNNING, plugins: ID, fail: ['plugin list'] }).run, herdrBin: 'herdr', spawnFn: () => 1 })
  assert.deepEqual(k.saved, [join(knownConf, 'setup.json')]); assert.equal(existsSync(join(known, '.config', 'whosup')), false)
  // 한 번 실패했어도 데스크에 다시 물어 등록이 확인되면 띄운다
  let n = 0
  const once = fakeRun({ sessions: RUNNING, plugins: ID })
  const retry = await setupWith({ typed: '\n\n\n\n', install: false, run: async (bin, args) => (args.join(' ') === 'plugin list' && n++ === 0 ? { ok: false, out: '' } : once.run(bin, args)) })
  assert.equal(retry.r.autostart.state, 'starting'); assert.equal(retry.spawned.length, 1)
})

test('설정 폴더 규칙은 한곳(src/paths.mjs): 손 실행이 쓰는 곳 = 보드가 읽는 곳(setupFilePath) = scripts/launch.mjs', async () => {
  assert.equal(ownDir('/h'), join('/h', '.config', 'whosup'))
  assert.equal(configDirOf({ HERDR_PLUGIN_CONFIG_DIR: '/c' }, '/h'), '/c'); assert.equal(configDirOf({}, '/h'), join('/h', '.config', 'whosup'))
  assert.equal(stateDirOf({ HERDR_PLUGIN_STATE_DIR: '/s' }, '/h'), '/s'); assert.equal(stateDirOf({}, '/h'), join('/h', '.config', 'whosup'))
  // 환경의 HOME이 아니라 주입한 홈(기본 os.homedir())을 쓴다: 읽는 쪽과 어긋나지 않는다
  assert.equal(configDirOf({ HOME: '/other' }, '/h'), join('/h', '.config', 'whosup'))
  assert.equal(setupFilePath({ HOME: '/other' }, '/h'), join('/h', '.config', 'whosup', 'setup.json')); assert.equal(setupFilePath({ HERDR_PLUGIN_CONFIG_DIR: '/c' }, '/h'), join('/c', 'setup.json'))
  const home = tmp('home')
  const r = await runSetup({ install: false, home, env: { ...isoEnv(home), HOME: join(home, 'elsewhere') }, platform: 'darwin', root: ROOT, terminal: fakeTerm('3\n\n\n\n'), detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: null, spawnFn: () => 1 })
  assert.deepEqual(r.saved, [setupFilePath({}, home)], '손 실행이 쓴 파일 = 보드가 읽을 파일'); assert.equal(existsSync(join(home, 'elsewhere')), false)
  const launch = readFileSync(join(ROOT, 'scripts', 'launch.mjs'), 'utf8')
  assert.match(launch, /import \{ configDirOf, stateDirOf \} from '\.\.\/src\/paths\.mjs'/); assert.match(launch, /const STATE = stateDirOf\(env\)/); assert.match(launch, /const CONF = configDirOf\(env\)/)
  const src = readFileSync(join(ROOT, 'src', 'setup.mjs'), 'utf8')
  assert.doesNotMatch(`${launch}\n${src}`, /'\.config', 'whosup'/, '규칙을 따로 다시 적지 않는다'); assert.doesNotMatch(src, /env\.HOME \|\| homedir\(\)/)
})

test('다시 묻기(WHOSUP_SETUP=1·--force·손 실행): Enter는 자동 감지로 되돌리기가 아니라 "지금 설정 그대로"라고 말한다', async () => {
  // 셋업은 DB를 읽지 않고, 서버는 번호로 고른 항목만 바꾼다 → 전에 직접 정한 값은 Enter로 바뀌지 않는다. 화면도 그렇게 말해야 한다.
  for (const over of [{ env: { WHOSUP_SETUP: '1' } }, { force: true }, { install: false, plugins: ID }]) {
    const r = await setupWith({ typed: '\n\n\n\n', sessions: RUNNING, ...over })
    const t = r.term.text()
    assert.match(t, /Enter leaves an item as it is set now \(a value you set earlier stays\)\.\n {2}\* marks the value used when you set none\. A number sets your own choice\.\n/)
    assert.equal(t.match(/Type a number, or press Enter to leave it as it is: /g).length, 4)
    assert.match(t, /Nothing changed: your settings stay as they are\./)
    assert.doesNotMatch(t, /Enter keeps the value marked|press Enter for \d|Nothing set by hand|everything follows auto-detect/)
    assert.equal(existsSync(r.file), false, '고른 것이 없으면 파일을 쓰지 않는다')
  }
  const ko = await setupWith({ typed: 'x\ny\nz\n\n\n\n', env: { WHOSUP_SETUP: '1', LANG: 'ko_KR.UTF-8' } })
  assert.match(ko.term.text(), /Enter만 치면 그 항목은 지금 설정 그대로 둡니다\(전에 직접 정한 값은 남습니다\)\.\n {2}\*는 직접 정한 값이 없을 때 쓰는 값입니다\. 번호를 치면 그 값으로 정합니다\.\n/)
  assert.match(ko.term.text(), /번호를 입력하세요 \(Enter만 치면 지금 설정 그대로\): /); assert.match(ko.term.text(), / {4}지금 설정 그대로 둡니다\.\n/, '3번 틀린 항목')
  assert.match(ko.term.text(), /바꾼 것이 없습니다\. 설정은 지금 그대로입니다\./)
  const slow = await setupWith({ env: { WHOSUP_SETUP: '1', WHOSUP_SETUP_TIMEOUT_S: '0.05' } })
  assert.match(slow.term.text(), /the remaining items stay as they are\.\n/); assert.doesNotMatch(slow.term.text(), /The board asks on first open/)
  assert.match((await setupWith({ f: facts(), env: { WHOSUP_SETUP: '1' }, sessions: RUNNING })).term.text(), /Nothing to choose here: your settings stay as they are\./)
  // 첫 설치의 문구는 그대로다
  const first = await setupWith({ typed: '\n\n\n\n', sessions: RUNNING })
  assert.match(first.term.text(), /Enter keeps the value marked \*\. A number sets your own choice\./); assert.match(first.term.text(), /press Enter for 1: /); assert.match(first.term.text(), /Nothing set by hand: auto-detect keeps applying\./)
  // 보드가 이미 떠 있으면 도우미를 띄우지 않고 '지금 뜹니다'라고 하지 않는다. 업데이트(설치 경로)면 재시작 방법을 붙이고,
  // 고른 값은 다시 시작해야 들어간다고 말한다(돌고 있는 보드가 setup.json을 읽지 않는 옛 버전일 수 있다)
  const live = await setupWith({ typed: '2\n\n\n\n', env: { WHOSUP_SETUP: '1' }, sessions: RUNNING, boardFn: () => ({ up: true, port: '4791' }) })
  assert.deepEqual(live.spawned, []); assert.equal(live.r.autostart.state, 'running'); assert.doesNotMatch(live.term.text(), /starting now|browser opens|without a restart/)
  assert.match(live.term.text(), /The board is already running: {2}http:\/\/127\.0\.0\.1:4791\n {2}Your choices take effect when the board restarts\.\n {2}A running board keeps the old version until it restarts\.\n {2}To restart it, type these two lines in a terminal:\n {6}herdr plugin action invoke/)
  // 손 실행: 돌고 있는 보드는 이 버전이다 — 재시작 없이 반영된다
  const liveHand = await setupWith({ typed: '2\n\n\n\n', install: false, plugins: ID, sessions: RUNNING, boardFn: () => ({ up: true, port: '4791' }) })
  assert.match(liveHand.term.text(), /The board is already running: {2}http:\/\/127\.0\.0\.1:4791\n {2}It picks up your choices without a restart\.\nTo change any of this/)
  const liveEnter = await setupWith({ typed: '\n\n\n\n', install: false, plugins: ID, sessions: RUNNING, boardFn: () => ({ up: true, port: null }) })
  assert.match(liveEnter.term.text(), /Nothing changed: your settings stay as they are\.\n\nThe board is already running: {2}http:\/\/127\.0\.0\.1:4790\nTo change any of this/)
})

// Ctrl-C를 누른 셋업 한 번: 첫 질문에 2번으로 답하고 둘째 질문에서 기다리는 중에 신호가 온다. dies = 같은 신호로 설치 명령이 죽는가.
const ctrlC = async ({ dies = false, ...over } = {}) => {
  let fire = null, off = 0, dead = false
  const p = setupWith({ typed: '2\n', sessions: RUNNING, onInterrupt: (fn) => { fire = fn; return () => { off++ } }, alive: () => !dead, ...over })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(typeof fire, 'function')
  if (dies) setTimeout(() => { dead = true }, 10)   // 신호가 설치 명령에 닿아 끝나기까지의 짧은 시간
  fire()
  const r = await p
  assert.equal(off, 1, 'SIGINT 걸이를 푼다'); assert.equal(r.r.ended, 'interrupted'); assert.deepEqual(r.r.choices, {})
  assert.equal(existsSync(r.file), false, '그때까지 번호로 고른 것도 저장하지 않는다')
  return r
}

test('Ctrl-C(설치): 설치 명령도 같은 신호로 죽는다 → 아무것도 찍지 않고 조용히 끝낸다(저장·도우미·마무리 문구 없음)', async () => {
  // 터미널의 Ctrl-C는 앞 프로세스 그룹 전체에 간다: herdr plugin install이 죽어 플러그인이 등록되지 않는다 — "보드가 지금 뜹니다"는 거짓이 된다.
  // 설치 명령이 죽으면 셸 프롬프트가 바로 돌아온다: 그 뒤에 찍는 줄은 프롬프트 뒤에 붙고 커서를 프롬프트 없는 줄에 남긴다 → 한 글자도 찍지 않는다
  // (kill·터미널 닫힘 경로와 같다).
  for (const [over, prompt] of [[{}, 'press Enter for 1: '], [{ env: { WHOSUP_SETUP: '1' } }, 'press Enter to leave it as it is: '], [{ env: { LANG: 'ko_KR.UTF-8' } }, '(Enter만 치면 1번): ']]) {
    const r = await ctrlC({ dies: true, settleMs: 2000, ...over })
    assert.equal(r.r.state, 'cancelled'); assert.deepEqual(r.spawned, [], '도우미를 띄우지 않는다'); assert.deepEqual(r.r.saved, [])
    assert.ok(r.term.text().endsWith(prompt), `프롬프트 뒤로 아무것도 찍지 않는다: ${JSON.stringify(r.term.text().slice(-120))}`)
    assert.doesNotMatch(r.term.text(), /cancelled|starting now|whenever herdr starts|by hand|skipped|first open|취소|보드가 지금|이후로는|손으로|건너뜁니다|처음 열 때/)
    assert.deepEqual(r.calls.filter((c) => c.includes('session')), [], 'herdr에 데스크를 묻지도 않는다')
    assert.match(r.logs.join('\n'), /install command is gone \(cancelled\) — nothing saved, nothing started/, '진단 줄(herdr가 버리는 표준 출력)에만 남긴다')
  }
  assert.equal('cancelled' in TEXT.en || 'cancelled' in TEXT.ko, false, '취소 문구는 없다')
  // 신호가 닿는 데 걸리는 시간만큼만 기다린다(설치 명령이 죽자마자 끝난다)
  const t0 = Date.now(); await ctrlC({ dies: true, settleMs: 5000 }); assert.ok(Date.now() - t0 < 2000)
})

test('Ctrl-C(설치): 설치 명령이 살아 있으면(신호를 무시하는 실행기) 질문만 건너뛰고 설치는 이어진다', async () => {
  // 첫 설치: 보드가 처음 열릴 때 묻는다고 알린다. 기존 설치(다시 묻기): 바뀐 것이 없고 설정은 그대로라고 알린다(보드는 다시 묻지 않는다)
  for (const [over, re] of [
    [{}, /\n {2}Setup skipped: nothing saved\. The board asks on first open\.\n/],
    [{ env: { WHOSUP_SETUP: '1' } }, /\n {2}Questions skipped: nothing changed, your settings stay as they are\.\n/],
    [{ force: true, env: { LANG: 'ko_KR.UTF-8' } }, /\n {2}질문을 건너뜁니다\(바꾼 것 없음\)\. 설정은 지금 그대로입니다\.\n/],
    [{ env: { LANG: 'ko_KR.UTF-8' } }, /\n {2}첫 실행 안내를 건너뜁니다\(저장한 것 없음\)\. 보드를 처음 열 때 첫 실행 안내가 묻습니다\.\n/],
  ]) {
    const r = await ctrlC(over)
    assert.match(r.term.text(), re)
    assert.equal(r.r.state, 'done'); assert.equal(r.spawned.length, 1, '설치가 끝나면 보드를 띄울 도우미')
    assert.match(r.term.text(), /To change any of this|바꾸려면 보드의 설정/, '마무리 문구는 그대로 찍는다')
    if (over.force || over.env?.WHOSUP_SETUP) assert.doesNotMatch(r.term.text(), /first open|처음 열 때|Setup skipped|첫 실행 안내를 건너뜁니다/, '기존 설치에 첫 설치용 문구를 쓰지 않는다')
  }
  // 설치 명령의 PID를 모르면(WHOSUP_INSTALLER_PID 없음) 살아 있다고 본다
  const unknown = await ctrlC({ installerPid: undefined, alive: () => false })
  assert.equal(unknown.r.state, 'done'); assert.match(unknown.term.text(), /Setup skipped: nothing saved\./)
})

test('Ctrl-C(손 실행): "그만둡니다(저장한 것 없음)" 한 줄로 끝낸다 — 보드를 띄우지도 마무리 문구를 찍지도 않는다', async () => {
  for (const [over, line] of [[{}, 'Stopped: nothing saved.'], [{ env: { LANG: 'ko_KR.UTF-8' } }, '그만둡니다(저장한 것 없음).']]) {
    const r = await ctrlC({ install: false, plugins: ID, alive: () => false, ...over })
    assert.equal(r.r.state, 'interrupted'); assert.deepEqual(r.spawned, []); assert.deepEqual(r.r.saved, [])
    assert.ok(r.term.text().endsWith(`: \n  ${line}\n`), JSON.stringify(r.term.text().slice(-120)))
    assert.doesNotMatch(r.term.text(), /already running|starting now|settings in the board|skipped|보드의 설정|건너뜁니다/)
  }
})

test('설치 명령이 이미 죽었으면(kill·터미널 닫힘) 도우미를 띄우지 않고 조용히 끝낸다 — 질문 도중이든 아니든', async () => {
  // 질문을 기다리는 중에 죽는다: 더 묻지 않고, 아무 글자도 더 찍지 않고, 저장하지 않는다
  let dead = false
  setTimeout(() => { dead = true }, 60)
  const t0 = Date.now()
  const mid = await setupWith({ typed: '2\n', sessions: RUNNING, alive: () => !dead, watchMs: 20 })
  assert.ok(Date.now() - t0 < 5000, '질문 시간 제한(120초)을 기다리지 않는다')
  assert.equal(mid.r.state, 'cancelled'); assert.deepEqual(mid.spawned, []); assert.equal(existsSync(mid.file), false)
  assert.ok(mid.term.text().endsWith('press Enter for 1: '), '프롬프트 뒤로 아무것도 찍지 않는다'); assert.doesNotMatch(mid.term.text(), /starting now|Setup skipped/)
  // 질문에 다 답했는데 그 사이에 죽어 있었다: 저장하지 않고 도우미도 없다
  let n = 0
  const after = await setupWith({ typed: '2\n\n\n\n', sessions: RUNNING, alive: () => ++n < 1, watchMs: 60000 })
  assert.equal(after.r.state, 'cancelled'); assert.deepEqual(after.spawned, []); assert.equal(existsSync(after.file), false); assert.doesNotMatch(after.term.text(), /Saved|starting now/)
  // 물을 것이 없는 설치·감지 실패·터미널 없음·WHOSUP_NO_SETUP·기존 설치도 같다
  for (const over of [{ f: facts() }, { detectFn: async () => { throw new Error('boom') } }, { terminal: null }, { env: { WHOSUP_NO_SETUP: '1' } }]) {
    const r = await setupWith({ sessions: RUNNING, alive: () => false, ...over })
    assert.equal(r.r.state, 'cancelled', JSON.stringify(Object.keys(over))); assert.deepEqual(r.spawned, []); assert.equal(existsSync(r.file), false)
    if (r.term) assert.doesNotMatch(r.term.text(), /starting now|whenever herdr starts|Nothing to choose/)
  }
  const home = tmp('gone'); const conf = join(home, '.config', 'herdr', 'plugins', 'config', ID)
  mkdirSync(conf, { recursive: true }); writeSetup(conf, {})
  const term = fakeTerm(); const spawned = []
  const ex = await runSetup({ install: true, env: isoEnv(home), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => facts(FULL), run: fakeRun({ sessions: RUNNING }).run, herdrBin: 'herdr', spawnFn: (s) => { spawned.push(s); return 1 }, installerPid: 777, alive: () => false })
  assert.equal(ex.state, 'cancelled'); assert.deepEqual(spawned, []); assert.equal(term.text(), '', '업데이트 안내도 찍지 않는다')
  // 손 실행은 설치 명령을 보지 않는다(WHOSUP_INSTALLER_PID가 환경에 남아 있어도)
  const hand = await setupWith({ typed: '\n\n\n\n', install: false, plugins: ID, sessions: RUNNING, alive: () => false })
  assert.equal(hand.r.state, 'done'); assert.equal(hand.spawned.length, 1)
})

test('다시 묻기 + 보드가 아직 한 번도 안 떴다(whosup.db 없음): 이번에 고르지 않은 항목은 앞서 setup.json에 고른 값을 이어 쓴다', async () => {
  // herdr가 꺼진 채 설치하며 번호로 고르고 → 보드가 뜨기 전에 다시 물었을 때 Enter → 앞 선택이 그 파일에만 있으므로 지우면 어디에도 안 남는다
  const chain = async ({ db = false, second, typed2 = '\n\n\n\n' }) => {
    const home = tmp('carry'); const conf = join(home, '.config', 'herdr', 'plugins', 'config', ID); const state = join(home, '.local', 'state', 'herdr', 'plugins', ID)
    const once = (over, typed) => runSetup({ install: true, env: isoEnv(home, over.env), platform: 'darwin', root: ROOT, terminal: fakeTerm(typed), detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: 'herdr', spawnFn: () => 1, ...over })
    await once({}, '\n\n\n2\n')
    assert.deepEqual(readSetup(join(conf, 'setup.json')).choices, { agent_cmd: 'codex' })
    if (db) { mkdirSync(state, { recursive: true }); writeFileSync(join(state, 'whosup.db'), '') }
    const term = fakeTerm(typed2)
    const r = await runSetup({ install: true, env: isoEnv(home, second.env), platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: 'herdr', spawnFn: () => 1, force: second.force })
    return { r, term, choices: readSetup(join(conf, 'setup.json')).choices }
  }
  for (const second of [{ env: { WHOSUP_SETUP: '1' } }, { force: true }]) {
    const kept = await chain({ second })
    assert.deepEqual(kept.choices, { agent_cmd: 'codex' }, 'Enter로 넘긴 항목은 앞 선택 그대로'); assert.deepEqual(kept.r.choices, {})
    assert.match(kept.term.text(), /Nothing changed: your settings stay as they are\./)
  }
  const mixed = await chain({ second: { env: { WHOSUP_SETUP: '1' } }, typed2: '3\n\n\n\n' })
  assert.deepEqual(mixed.choices, { agent_cmd: 'codex', click_target: 'both' }, '이번에 고른 것은 더하고, 넘긴 것은 앞 선택')
  assert.match(mixed.term.text(), /Saved: Sessions open in = both\n/, '화면에는 이번에 고른 것만')
  assert.deepEqual((await chain({ second: { env: { WHOSUP_SETUP: '1' } }, typed2: '\n\n\n1\n' })).choices, { agent_cmd: 'claude' }, '이번에 다시 고르면 그 값')
  assert.deepEqual((await chain({ second: { env: { WHOSUP_SETUP: '1', WHOSUP_SETUP_TIMEOUT_S: '0.05' } }, typed2: '\n' })).choices, { agent_cmd: 'codex' }, '시간 초과로 넘어간 항목도 같다')
  // 보드가 한 번이라도 떴으면(whosup.db 있음) 앞 선택은 이미 설정에 들어갔다 → 이번에 고른 것만 쓴다(보드에서 바꾼 값을 옛 선택으로 덮지 않는다)
  assert.deepEqual((await chain({ db: true, second: { env: { WHOSUP_SETUP: '1' } } })).choices, { agent_cmd: 'codex' }, '이번에 고른 것이 없으면 파일을 건드리지 않는다(보드가 이미 가져간 파일이라 다시 읽지 않는다)')
  assert.deepEqual((await chain({ db: true, second: { env: { WHOSUP_SETUP: '1' } }, typed2: '3\n\n\n\n' })).choices, { click_target: 'both' })
  // 손 실행(herdr 밖에서 쓰는 사람): 상태 폴더는 ~/.config/whosup
  const home = tmp('carry-hand'); const own = join(home, '.config', 'whosup')
  const hand = (typed) => runSetup({ install: false, env: isoEnv(home), platform: 'darwin', root: ROOT, terminal: fakeTerm(typed), detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: 'herdr', spawnFn: () => 1 })
  await hand('2\n\n\n\n'); await hand('\n\n\n\n')
  assert.deepEqual(readSetup(join(own, 'setup.json')).choices, { click_target: 'web' })
  writeFileSync(join(own, 'whosup.db'), ''); await hand('\n\n\n\n')
  assert.deepEqual(readSetup(join(own, 'setup.json')).choices, { click_target: 'web' }, '보드가 이미 가져간 뒤 고른 것 없이 지나가면 파일을 건드리지 않는다')
  // 모르는 항목·문자열이 아닌 값은 이어 쓰지 않는다
  const odd = tmp('carry-odd'); const oddConf = join(odd, '.config', 'herdr', 'plugins', 'config', ID)
  mkdirSync(oddConf, { recursive: true }); writeSetup(oddConf, { agent_cmd: 'codex', nope: 'x', front_app: 7 })
  await runSetup({ install: true, force: true, env: isoEnv(odd), platform: 'darwin', root: ROOT, terminal: fakeTerm('\n\n\n\n'), detectFn: async () => facts(FULL), run: fakeRun().run, herdrBin: 'herdr', spawnFn: () => 1 })
  assert.deepEqual(readSetup(join(oddConf, 'setup.json')).choices, { agent_cmd: 'codex' })
})

test('데스크 목록: `session list --json`을 받지 않는 herdr면 표(`session list`)를 읽는다 — "herdr가 꺼져 있다"로 잘못 안내하지 않는다', async () => {
  const TABLE = 'name                 status   directory                                        socket\nwork                 running  /h/.config/herdr/sessions/work                   /h/.config/herdr/sessions/work/herdr.sock\nold                  stopped  /h/.config/herdr/sessions/old                    /h/.config/herdr/sessions/old/herdr.sock\n'
  const oldHerdr = (table = TABLE) => { const calls = []; return { calls, run: async (bin, args) => { calls.push(args); const a = args.join(' '); return a === 'session list --json' ? { ok: false, out: '' } : a === 'session list' ? { ok: true, out: table } : { ok: false, out: '' } } } }
  const old = oldHerdr()
  assert.deepEqual(await listDesks({ herdrBin: 'herdr', run: old.run, env: {} }), [{ name: 'work', status: 'running', dir: '/h/.config/herdr/sessions/work', socket: '/h/.config/herdr/sessions/work/herdr.sock' }, { name: 'old', status: 'stopped', dir: '/h/.config/herdr/sessions/old', socket: '/h/.config/herdr/sessions/old/herdr.sock' }])
  assert.deepEqual(old.calls, [['session', 'list', '--json'], ['session', 'list']])
  assert.deepEqual(await runningDesk({ herdrBin: 'herdr', run: oldHerdr().run, env: {} }), { name: 'work', args: ['--session', 'work'] })
  // --json이 답은 했는데 읽을 수 없는 글자여도 표로 넘어간다
  const garbled = async (bin, args) => (args.includes('--json') ? { ok: true, out: 'usage: herdr session list' } : { ok: true, out: TABLE })
  assert.equal((await runningDesk({ herdrBin: 'herdr', run: garbled, env: {} })).name, 'work')
  // 둘 다 안 되면 목록은 null(모름 — 읽었는데 데스크가 없는 빈 목록과 다르다), 실행 중인 데스크 없음. --json이 통하면 표는 읽지 않는다
  assert.equal(await listDesks({ herdrBin: 'herdr', run: async () => ({ ok: false, out: '' }), env: {} }), null)
  assert.deepEqual(await listDesks({ herdrBin: 'herdr', run: fakeRun({ sessions: [] }).run, env: {} }), [])
  assert.equal(await runningDesk({ herdrBin: 'herdr', run: async () => ({ ok: false, out: '' }), env: {} }), null)
  const modern = fakeRun({ sessions: RUNNING }); await runningDesk({ herdrBin: 'herdr', run: modern.run, env: {} })
  assert.deepEqual(modern.calls, [['session', 'list', '--json']])
  // 설치 한 번: 옛 herdr에서도 실행 중인 데스크를 찾아 보드를 띄운다
  const run = async (bin, args) => { const a = args.join(' '); return a === 'session list' ? { ok: true, out: TABLE } : { ok: false, out: '' } }
  const inst = await setupWith({ typed: '\n\n\n\n', run })
  assert.equal(inst.r.autostart.state, 'starting'); assert.equal(inst.r.autostart.desk, 'work'); assert.equal(inst.spawned.length, 1)
  assert.match(inst.term.text(), /The board is starting now:/); assert.doesNotMatch(inst.term.text(), /herdr is not running/)
  // 설치 한 번: 데스크 목록을 두 방식 모두 못 읽었다 → "herdr가 꺼져 있습니다"라고 단정하지 않는다. 도우미는 띄우지 않는다
  const blind = await setupWith({ typed: '\n\n\n\n', sessions: RUNNING, fail: ['session list --json', 'session list'] })
  assert.equal(blind.r.autostart.state, 'unknown'); assert.deepEqual(blind.spawned, [])
  assert.match(blind.term.text(), /\nCould not check whether herdr is running\.\n {2}If it is not running, type this in this terminal and press Enter:\n {6}herdr\n {2}If it is running, type this in a terminal inside herdr:\n/); assert.doesNotMatch(blind.term.text(), /herdr is not running right now|starting now/)
  assert.deepEqual(readSetup(blind.file)?.choices, {}, 'Enter만 쳤으면 값은 쓰지 않는다(다 답했으니 마친 표시만)')
  // 물은 것이 없을 때의 저장 판정은 전과 같다: 켜져 있다고 볼 근거가 없으면 저장하지 않는다(보드가 처음 열릴 때 묻는다)
  const blindNone = await setupWith({ f: facts(), sessions: RUNNING, fail: ['session list --json', 'session list'] })
  assert.equal(existsSync(blindNone.file), false); assert.match(blindNone.term.text(), /The board shows them once on first open\./)
  // 설치 한 번: 데스크는 찾았는데 도우미를 못 띄웠다 → herdr는 켜져 있다. 손으로 띄우는 명령을 안내한다
  const noHelper = await setupWith({ typed: '\n\n\n\n', sessions: [{ name: 'main', running: true }], spawnFn: () => { throw new Error('EAGAIN') } })
  assert.equal(noHelper.r.autostart.state, 'spawn_failed'); assert.doesNotMatch(noHelper.term.text(), /herdr is not running|starting now/)
  assert.match(noHelper.term.text(), new RegExp(`\\nCould not start the board from here\\.\\nTo start it by hand, type this in a terminal:\\n {4}herdr --session main plugin action invoke ${ID}\\.start\\nThe board: {2}http://127\\.0\\.0\\.1:4790 \\(next port if taken\\)\\n`))
  assert.equal(existsSync((await setupWith({ f: facts(), sessions: RUNNING, spawnFn: () => { throw new Error('EAGAIN') } })).file), false, '물을 것이 없던 설치는 herdr가 켜져 있어도 마친 것으로 적지 않는다')
  // 도우미 프로세스를 만들지 못했다(pid 없음): 지금 뜬다고 하지 않는다
  const nullPid = await setupWith({ typed: '\n\n\n\n', sessions: [{ name: 'main', running: true }], spawnFn: () => null })
  assert.equal(nullPid.r.autostart.state, 'spawn_failed'); assert.doesNotMatch(nullPid.term.text(), /starting now/)
  // 감지에 실패했어도 원격(SSH)이면 브라우저가 열린다고 하지 않는다
  const sshFail = await setupWith({ sessions: RUNNING, detectFn: async () => { throw new Error('boom') }, env: { SSH_CONNECTION: '1 2 3 4' } })
  assert.match(sshFail.term.text(), /No browser opens by itself here/); assert.doesNotMatch(sshFail.term.text(), /Your browser opens it/)
  // 실제 실행 파일로(가짜 herdr, FAKE_HERDR_NO_JSON=1): 인자 배열로 부르고 표를 읽는다
  const log = join(tmp('oldherdr'), 'calls.log')
  const env = { ...process.env, FAKE_HERDR_NO_JSON: '1', FAKE_HERDR_TABLE: TABLE, FAKE_HERDR_LOG: log }
  assert.deepEqual(await runningDesk({ herdrBin: FAKE, run: runHerdr, env }), { name: 'work', args: ['--session', 'work'] })
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)), [['session', 'list', '--json'], ['session', 'list']])
})

test('터미널 열기: 터미널의 뒤(background) 프로세스 그룹이면 묻지 않는다 — /dev/tty를 읽다 SIGTTIN으로 멈추면 설치가 무기한 선다', () => {
  // 앞·뒤 판정: 리눅스는 /proc/self/stat의 pgrp·tpgid, 그 밖은 ps -o pgid= -o tpgid=. 알 수 없으면 null(그때는 지금처럼 묻는다)
  const stat = (pgrp, tpgid) => `4242 (node (x) y) S 4000 ${pgrp} 4000 34816 ${tpgid} 4194304 1 0`
  const noPs = () => { throw new Error('no ps') }
  assert.equal(inForeground({ platform: 'linux', readFile: () => stat(4242, 4242), exec: noPs }), true)
  assert.equal(inForeground({ platform: 'linux', readFile: () => stat(4242, 4000), exec: noPs }), false)
  assert.equal(inForeground({ platform: 'linux', readFile: () => stat(4242, -1), exec: noPs }), false, '제어 터미널 없음')
  assert.equal(inForeground({ platform: 'linux', readFile: () => { throw new Error('no /proc') }, exec: () => ' 4242  4242\n' }), true, '/proc을 못 읽으면 ps로')
  const calls = []
  assert.equal(inForeground({ platform: 'darwin', pid: 77, exec: (file, args) => { calls.push([file, ...args]); return '  501   777\n' } }), false)
  assert.deepEqual(calls, [['ps', '-o', 'pgid=', '-o', 'tpgid=', '-p', '77']])
  assert.equal(inForeground({ platform: 'darwin', exec: () => '501 501\n' }), true)
  assert.equal(inForeground({ platform: 'darwin', exec: () => 'ps: garbage' }), null); assert.equal(inForeground({ platform: 'darwin', exec: noPs }), null)
  assert.equal(inForeground({ platform: 'win32', exec: () => '1 1' }), null)
  // 뒤 그룹이면 터미널을 열지 않는다(= 터미널 없음 경로: 묻지 않고 자동 시작만). 판정 함수는 주입 — 실제 /dev/tty에 기대지 않는다
  const pipe = { isTTY: false }
  assert.equal(openTerminal({ install: true, platform: 'darwin', stdin: pipe, stdout: pipe, foreground: () => false }), null)
  assert.equal(openTerminal({ install: false, platform: 'linux', stdin: pipe, stdout: pipe, foreground: () => false }), null, '손 실행이 제어 터미널을 직접 열 때도 같다')
  // 윈도우 설치: herdr가 build를 보이지 않는 콘솔에서 돌린다 → 콘솔을 열지 않는다(보드의 첫 실행 안내가 묻는다)
  let asked = 0
  assert.equal(openTerminal({ install: true, platform: 'win32', stdin: pipe, stdout: pipe, env: {}, foreground: () => { asked++; return true } }), null); assert.equal(asked, 0)
  // 손 실행은 표준 입출력이 터미널이면 그것을 그대로 쓴다(윈도우 포함)
  const tty = { isTTY: true, columns: 100, write() {}, pause() {}, hasColors: () => false }
  assert.equal(openTerminal({ install: false, platform: 'win32', stdin: tty, stdout: tty, env: {} }).columns, 100)
})

// ── 서버 쪽 가져오기 ──
test('서버 가져오기: setup.json의 선택을 사람이 정한 값으로 저장하고 첫 실행 안내를 마친 것으로 표시한다 — 같은 파일은 한 번만', () => {
  const dir = tmp('imp')
  const db = openDb(':memory:')
  assert.deepEqual(importSetup(db, join(dir, 'setup.json')), { ok: false, code: 'no_setup' }); assert.equal(getMeta(db, 'firstrun.done'), null)
  const { file, body } = writeSetup(dir, { click_target: 'both', agent_cmd: 'codex' }, { now: new Date('2026-11-13T00:00:00Z') })
  const r = importSetup(db, file)
  assert.deepEqual(r, { ok: true, imported: true, at: body.at, applied: ['click_target', 'agent_cmd'], dropped: [] })
  assert.equal(getSettings(db).click_target, 'both'); assert.equal(getSettings(db).agent_cmd, 'codex')
  assert.deepEqual(settingOrigins(db).click_target, { source: 'panel' }); assert.deepEqual(settingOrigins(db).agent_cmd, { source: 'panel' })
  assert.notEqual(settingOrigins(db).front_app.source, 'panel', '고르지 않은 항목은 자동 감지·기본값으로 남는다')
  assert.ok(getMeta(db, 'firstrun.done')); assert.equal(getMeta(db, 'setup.imported_at'), body.at)
  assert.equal(readFileSync(file, 'utf8'), `${JSON.stringify(body, null, 2)}\n`, '파일은 그대로 둔다')
  // 보드 설정에서 바꾼 뒤 서버가 다시 떠도 같은 파일을 또 적용하지 않는다
  db.prepare("UPDATE meta SET value = 'terminal' WHERE key = 'setting.click_target'").run()
  assert.deepEqual(importSetup(db, file), { ok: true, imported: false }); assert.equal(getSettings(db).click_target, 'terminal')
  // 새로 셋업하면(at이 다르면) 다시 적용한다. ''는 저장한 값을 지운다(자동으로 되돌림)
  db.prepare("INSERT INTO meta (key, value) VALUES ('setting.front_app', 'Ghostty')").run()
  const second = writeSetup(dir, { click_target: 'web', front_app: '' }, { now: new Date('2026-11-13T00:05:00Z') })
  assert.equal(importSetup(db, second.file).imported, true)
  assert.equal(getSettings(db).click_target, 'web'); assert.equal(getMeta(db, 'setting.front_app'), null); assert.equal(getSettings(db).agent_cmd, 'codex', '이번에 고르지 않은 항목은 그대로')
  // 고른 것이 없는 파일(손으로 둔 빈 파일): 마친 것으로 적지 않는다 — 보드가 첫 실행 안내를 띄운다. 같은 파일을 다시 읽지 않도록 가져온 표시만 남긴다
  const db2 = openDb(':memory:')
  const empty = writeSetup(tmp('imp2'), {})
  assert.deepEqual(importSetup(db2, empty.file).applied, []); assert.equal(getMeta(db2, 'firstrun.done'), null); assert.ok(getMeta(db2, 'setup.imported_at'))
  assert.deepEqual(importSetup(db2, empty.file), { ok: true, imported: false })
})

test('서버 가져오기: 모르는 항목·틀린 값은 그 항목만 버리고 나머지는 적용한다. 깨진 파일에도 죽지 않는다', () => {
  const dir = tmp('impbad')
  const db = openDb(':memory:')
  const file = join(dir, 'setup.json')
  writeFileSync(file, JSON.stringify({ version: 1, at: 't1', choices: { click_target: 'everywhere', core_target: 'terminal', seen_snooze_min: 5, agent_cmd: 'a\nb', front_app: 7, __proto__x: 1 } }))
  const r = importSetup(db, file)
  assert.equal(r.imported, true); assert.deepEqual(r.applied, ['core_target']); assert.deepEqual(r.dropped.sort(), ['__proto__x', 'agent_cmd', 'click_target', 'front_app', 'seen_snooze_min'])
  assert.equal(getSettings(db).core_target, 'terminal'); assert.equal(getSettings(db).click_target, 'terminal'); assert.equal(getSettings(db).agent_cmd, 'claude'); assert.equal(getSettings(db).seen_snooze_min, 30)
  for (const body of ['{ not json', '"x"', JSON.stringify({ version: 1, at: 't2', choices: 'no' }), JSON.stringify({ version: 9, at: 't3', choices: {} })]) {
    writeFileSync(file, body)
    assert.doesNotThrow(() => importSetup(db, file), body)
  }
  assert.equal(importSetup(db, file).code, 'no_setup')
  writeFileSync(file, JSON.stringify({ version: 1, at: 't4', choices: ['click_target'] }))
  assert.deepEqual(importSetup(db, file).applied, [], 'choices가 이상하면 고른 것 없음으로')
})

test('서버 가져오기: 읽기 전용 보기에서는 적용하지 않는다', () => {
  const db = openDb(':memory:')
  const { file } = writeSetup(tmp('impro'), { click_target: 'both' })
  process.env.WHOSUP_READONLY = '1'
  try {
    assert.deepEqual(importSetup(db, file), { ok: false, code: 'read_only' })
    const srv = createBoardServer(db, { setupFile: file }); srv.close()
    assert.equal(getSettings(db).click_target, 'terminal'); assert.equal(getMeta(db, 'firstrun.done'), null); assert.equal(getMeta(db, 'setup.imported_at'), null)
  } finally { delete process.env.WHOSUP_READONLY }
  assert.equal(importSetup(db, file).imported, true, '읽기 전용이 풀리면 적용된다')
})

test('보드 서버: 시작할 때 setup.json을 가져와 첫 실행 안내를 다시 띄우지 않고, 실행 중에 바뀐 파일도 재시작 없이 가져온다', async () => {
  const dir = tmp('srv')
  const { file } = writeSetup(dir, { click_target: 'both' }, { now: new Date('2026-11-13T00:00:00Z') })
  const db = openDb(':memory:')
  const seen = []
  const srv = createBoardServer(db, { setupFile: file, onSetup: (r) => seen.push(r.applied) })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const realNow = Date.now
  try {
    const v = await (await fetch(`${base}/api/autoconf`)).json()
    assert.equal(v.first_run.show, false, '터미널에서 이미 물었다'); assert.equal(v.chosen.click_target.value, 'both'); assert.deepEqual(v.chosen.click_target.origin, { source: 'panel' })
    assert.deepEqual(seen, [['click_target']])
    // 보드가 떠 있는 동안 손으로 다시 셋업
    writeSetup(dir, { click_target: 'web', core_target: 'terminal' }, { now: new Date('2026-11-13T00:10:00Z') })
    utimesSync(file, new Date(), new Date(realNow() + 10000))
    await fetch(`${base}/api/board`)
    assert.equal(getSettings(db).click_target, 'both', `방금 본 파일은 ${SETUP_CHECK_MS}ms 안에 다시 보지 않는다`)
    Date.now = () => realNow() + SETUP_CHECK_MS + 1000
    const board = await (await fetch(`${base}/api/board`)).json()
    assert.equal(getSettings(db).click_target, 'web'); assert.equal(getSettings(db).core_target, 'terminal')
    // 열려 있는 보드 탭은 이 값이 직전과 달라진 것을 보고 /api/autoconf(client_defaults)를 다시 읽는다
    assert.equal(board.settings.click_target, 'web', '/api/board 응답이 바뀐 값을 싣는다')
    assert.deepEqual((({ 'whosup-open-url-on': a, 'whosup-raise': b }) => [a, b])((await (await fetch(`${base}/api/autoconf`)).json()).client_defaults), ['on', 'off'], '클릭이 쓰는 기본값도 web')
    assert.deepEqual(seen, [['click_target'], ['click_target', 'core_target']])
    // 파일이 사라지거나 깨져도 서버는 그대로 답한다
    writeFileSync(file, '{ broken'); utimesSync(file, new Date(), new Date(realNow() + 20000))
    Date.now = () => realNow() + 3 * SETUP_CHECK_MS
    assert.equal((await fetch(`${base}/api/settings`)).status, 200); assert.equal(getSettings(db).click_target, 'web')
  } finally { Date.now = realNow; srv.close() }
  // setupFile을 주지 않으면(시험·옛 호출) 아무것도 가져오지 않는다
  const db2 = openDb(':memory:')
  createBoardServer(db2).close()
  assert.equal(getMeta(db2, 'firstrun.done'), null)
})

test('보드 탭: 서버의 세션을 여는 곳이 바뀌면 클릭 기본값을 다시 받고, 첫 실행 안내를 닫는 타이머는 닫기 전에 그 값을 받는다', () => {
  // 터미널에서 다시 고른 값(setup.json 가져오기)·다른 탭의 설정 저장이 열려 있는 탭에도 들어가게 하는 두 곳(화면은 그대로다)
  assert.match(html, /const ct = data\.settings\?\.click_target\n\s+if \(acLoaded && lastClickTarget && ct && ct !== lastClickTarget\) reloadClientDefaults\(\)\n\s+lastClickTarget = ct \|\| lastClickTarget/)
  assert.match(html, /async function reloadClientDefaults\(\) \{\n\s+try \{ const v = await \(await fetch\('\/api\/autoconf', \{ cache: 'no-store' \}\)\)\.json\(\); acView = v; srvDefaults = v\.client_defaults \|\| srvDefaults \} catch \{\}/)
  assert.match(html, /if \(!n\.first_run\?\.show\) \{ acView = n; srvDefaults = n\.client_defaults \|\| srvDefaults; return hideFirstRun\(\) \}/)
})

test('배선: bin/whosup.mjs가 <설정 폴더>/setup.json을 서버에 넘기고, 진입점이 셋업을 부른다', () => {
  const bin = readFileSync(join(ROOT, 'bin', 'whosup.mjs'), 'utf8')
  assert.match(bin, /startBoard\(db, \{[^}]*setupFile: setupFilePath\(\)[^}]*\}\)/)
  const pre = readFileSync(join(ROOT, 'scripts', 'preflight.sh'), 'utf8')
  assert.match(pre, /WHOSUP_INSTALLER_PID="\$PPID" node "\$\(dirname "\$0"\)\/setup\.mjs" --install \|\| /, '셋업이 실패해도 build는 계속')
  assert.match(pre, /--install \|\| echo [^\n]*\n\s+exit 0\n/, 'install은 늘 0으로 끝난다')
  assert.ok(pre.indexOf('exit 0') < pre.indexOf('autoconf.mjs" ||'), 'install에서는 autoconf(auto.json 쓰기)를 돌리지 않는다')
  const launch = readFileSync(join(ROOT, 'scripts', 'launch.mjs'), 'utf8')
  assert.match(launch, /case 'install': \{[\s\S]*?WHOSUP_INSTALLER_PID: String\(process\.ppid\)[\s\S]*?return 0\n/)
  const cli = readFileSync(join(ROOT, 'scripts', 'setup.mjs'), 'utf8')
  assert.match(cli, /process\.exit\(/, '읽기 스트림·타이머가 남아도 끝난다'); assert.match(cli, /\.unref\(\)/, '전체 시간 제한')
  // 종료 코드: 설치(--install)는 그만둔 설치여도 0(build를 막지 않고, 이미 돌아온 프롬프트 뒤에 줄을 더 찍게 하지 않는다). 손 실행의 Ctrl-C만 130
  assert.match(cli, /return !install && state === 'interrupted' \? 130 : 0\n/)
  const src = readFileSync(join(ROOT, 'src', 'setup.mjs'), 'utf8')
  assert.doesNotMatch(src, /writeAuto|refreshAuto|\.env'\)|openDb|setMeta|shell: true/, '셋업은 auto.json·.env·DB를 쓰지 않는다')
})

test('환경 고르기로 herdr를 방금 깐 설치(install.sh가 WHOSUP_ENV_INSTALLED=herdr를 준다): 마무리 문구를 찍지 않는다 — "herdr를 치세요"는 설치 요약이 한 번만 말한다', async () => {
  // 보통의 설치: herdr가 꺼져 있으면 마무리 문구가 "이 터미널에 herdr를 치세요"를 말한다
  const plain = await setupWith({ typed: '\n\n\n\n' })
  assert.equal(plain.r.autostart.state, 'herdr_off')
  assert.match(plain.term.text(), /herdr is not running right now\.\n {2}Type this in this terminal and press Enter:\n {6}herdr\n/)
  // 설치기가 herdr를 방금 깔고 부른 설치: 질문은 그대로 묻고, 마무리 문구(herdr를 치라는 줄 · 보드 주소 · 바꾸는 곳)는 찍지 않는다
  const fresh = await setupWith({ typed: '\n\n\n\n', env: { WHOSUP_ENV_INSTALLED: 'herdr' } })
  assert.equal(fresh.r.state, 'done'); assert.equal(fresh.r.autostart.state, 'herdr_off')
  const text = fresh.term.text()
  assert.equal(text.split('\n').filter((l) => /Type a number/.test(l)).length, plain.term.text().split('\n').filter((l) => /Type a number/.test(l)).length, '질문은 그대로')
  assert.doesNotMatch(text, /^\s+herdr\s*$/m, 'herdr를 치라는 줄이 없다'); assert.doesNotMatch(text, /herdr is not running|Type this in this terminal|To change any of this|http:\/\/127\.0\.0\.1/)
  assert.ok(plain.term.text().startsWith(text.trimEnd()), '마무리 문구 앞까지는 같다')
  // 한국어도 같다
  const ko = await setupWith({ typed: '\n\n\n\n', env: { WHOSUP_ENV_INSTALLED: 'herdr', WHOSUP_LANG: 'ko' } })
  assert.doesNotMatch(ko.term.text(), /herdr가 꺼져 있습니다|이 터미널에 아래를 치고|바꾸려면 보드의 설정에서/); assert.match(ko.term.text(), /번호를 입력하세요/)
  // 그 밖의 값·손 실행은 그대로다. herdr가 켜져 있어 보드를 지금 띄우는 설치도 그대로 알린다(설치 요약이 대신 말하는 것은 "herdr를 켜세요"뿐이다)
  for (const env of [{ WHOSUP_ENV_INSTALLED: 'herdr-app' }, { WHOSUP_ENV_INSTALLED: '' }, { WHOSUP_ENV_INSTALLED: '1' }]) assert.equal((await setupWith({ typed: '\n\n\n\n', env })).term.text(), plain.term.text(), JSON.stringify(env))
  const on = await setupWith({ typed: '\n\n\n\n', env: { WHOSUP_ENV_INSTALLED: 'herdr' }, sessions: RUNNING })
  assert.equal(on.r.autostart.state, 'starting'); assert.match(on.term.text(), /The board is starting now:/)
  const hand = await setupWith({ typed: '\n\n\n\n', install: false, plugins: ID, env: { WHOSUP_ENV_INSTALLED: 'herdr' } })
  assert.match(hand.term.text(), /^\s+herdr\s*$/m, '손 실행의 마무리 문구는 그대로')
  // 설정이 남아 있던 기계(이미 셋업한 설치로 본다 — 업데이트 문구)에서도 같다: "herdr를 치세요"만 빠지고 나머지는 그대로다
  for (const lang of ['en', 'ko']) {
    const full = updatedLines({ id: ID, state: 'herdr_off', env: {} }, TEXT[lang]), brief = updatedLines({ id: ID, state: 'herdr_off', env: {}, brief: true }, TEXT[lang])
    assert.match(full.join('\n'), /^\s+herdr\s*$/m); assert.doesNotMatch(brief.join('\n'), /^\s+herdr\s*$/m)
    assert.deepEqual(brief, [full[0], ...full.slice(-2)], '업데이트했다는 줄과 다시 묻게 하는 법은 남는다')
    for (const state of ['running', 'starting']) assert.deepEqual(updatedLines({ id: ID, state, env: {}, brief: true }, TEXT[lang]), updatedLines({ id: ID, state, env: {} }, TEXT[lang]), state)
  }
})

// ── 가-6 · F8: 같은 안내는 한 번만 — 한 줄 설치기(install.sh)가 부른 설치는 마무리 문구를 설치 요약에 맡긴다 ──
test('한 줄 설치기가 부른 설치(WHOSUP_FROM_INSTALLER=1): 질문까지만 하고 마무리 문구는 찍지 않는다 — 보드 주소·"herdr를 치세요"·"herdr를 켤 때마다"·바꾸는 곳은 설치 요약이 한 번만 말한다', async () => {
  const FROM = { WHOSUP_FROM_INSTALLER: '1' }
  const closing = /herdr is not running|Type this in this terminal|The board starts with herdr every time|The board is starting now|From now on the board starts|To start it by hand|To change any of this|Could not check whether herdr|http:\/\/127\.0\.0\.1/
  const prompts = (t) => t.split('\n').filter((l) => /Type a number/.test(l)).length
  // herdr가 꺼져 있다: 보통의 설치는 "herdr를 치세요"를 말하고, 설치기가 부른 설치는 말하지 않는다(질문과 "직접 정한 값이 없습니다 …"는 그대로)
  const plain = await setupWith({ typed: '\n\n\n\n' })
  assert.match(plain.term.text(), closing)
  const off = await setupWith({ typed: '\n\n\n\n', env: FROM })
  assert.equal(off.r.state, 'done'); assert.equal(off.r.autostart.state, 'herdr_off')
  assert.doesNotMatch(off.term.text(), closing); assert.doesNotMatch(off.term.text(), /^\s+herdr\s*$/m)
  assert.equal(prompts(off.term.text()), prompts(plain.term.text()), '질문은 그대로'); assert.match(off.term.text(), /Nothing set by hand: auto-detect keeps applying\./)
  assert.ok(plain.term.text().startsWith(off.term.text().trimEnd()), '마무리 문구 앞까지는 같다')
  // herdr가 켜져 있어 보드를 지금 띄우는 설치: 도우미는 그대로 띄우고, "보드가 지금 뜹니다 …" 묶음은 찍지 않는다(설치 요약이 켜진 보드의 주소를 말한다)
  const plainOn = await setupWith({ typed: '\n\n\n\n', sessions: RUNNING })
  assert.match(plainOn.term.text(), /The board is starting now:/)
  const on = await setupWith({ typed: '\n\n\n\n', env: FROM, sessions: RUNNING })
  assert.equal(on.r.autostart.state, 'starting'); assert.equal(on.spawned.length, 1, '보드를 띄우는 도우미는 그대로')
  assert.doesNotMatch(on.term.text(), closing); assert.equal(prompts(on.term.text()), prompts(plainOn.term.text()))
  // 번호로 고른 값은 그대로 저장하고 "저장했습니다" 줄도 그대로다
  const picked = await setupWith({ typed: '3\n\n\n\n', env: FROM, sessions: RUNNING })
  assert.match(picked.term.text(), /Saved: Sessions open in = both/); assert.equal(existsSync(picked.file), true); assert.doesNotMatch(picked.term.text(), closing)
  // 데스크 목록을 못 읽은 설치 · 도우미를 못 띄운 설치 · 물을 것이 없던 설치 · 한국어도 같다
  for (const over of [{ sessions: RUNNING, fail: ['session list --json', 'session list'] }, { sessions: [{ name: 'main', running: true }], spawnFn: () => { throw new Error('EAGAIN') } }, { f: facts() }]) {
    assert.doesNotMatch((await setupWith({ typed: '\n\n\n\n', env: FROM, ...over })).term.text(), closing, JSON.stringify(Object.keys(over)))
  }
  const ko = (await setupWith({ typed: '\n\n\n\n', env: { ...FROM, WHOSUP_LANG: 'ko' } })).term.text()
  assert.doesNotMatch(ko, /herdr가 꺼져 있습니다|이 터미널에 아래를 치고|herdr를 켤 때마다|바꾸려면 보드의 설정에서/); assert.match(ko, /번호를 입력하세요/)
  // 보드가 이미 돌고 있던 설치만은 그대로 찍는다: "다시 시작해야 새 버전이 된다"는 설치 요약에 없는 말이다
  const run = await setupWith({ typed: '\n\n\n\n', env: FROM, sessions: RUNNING, boardFn: async () => ({ up: true, port: '4791' }) })
  assert.equal(run.r.autostart.state, 'running'); assert.match(run.term.text(), /The board is already running: {2}http:\/\/127\.0\.0\.1:4791\n/); assert.match(run.term.text(), /A running board keeps the old version until it restarts\./)
  // 꺼진 값·손 실행·단독 설치에는 통하지 않는다(그 설치들은 요약이 따로 없거나 자기 요약을 쓴다)
  for (const v of ['', '0', 'false', 'off']) assert.equal((await setupWith({ typed: '\n\n\n\n', env: { WHOSUP_FROM_INSTALLER: v } })).term.text(), plain.term.text(), JSON.stringify(v))
  const hand = await setupWith({ typed: '\n\n\n\n', install: false, plugins: ID, env: FROM })
  assert.match(hand.term.text(), /^\s+herdr\s*$/m, '손 실행의 마무리 문구는 그대로')
  // 설정이 남아 있던 기계(업데이트 문구): 업데이트했다는 줄과 다시 묻게 하는 법만 남는다. 돌고 있는 보드의 재시작 방법은 그대로다
  for (const lang of ['en', 'ko']) {
    const T = TEXT[lang]
    for (const state of ['herdr_off', 'unknown', 'starting', 'no_herdr', 'off']) {
      const full = updatedLines({ id: ID, state, env: {} }, T), brief = updatedLines({ id: ID, state, env: {}, summarized: true }, T)
      assert.deepEqual(brief, [full[0], ...full.slice(-2)], `${lang} ${state}`); assert.doesNotMatch(brief.join('\n'), /127\.0\.0\.1|^\s+herdr\s*$/m, `${lang} ${state}`)
    }
    assert.deepEqual(updatedLines({ id: ID, state: 'running', env: {}, summarized: true }, T), updatedLines({ id: ID, state: 'running', env: {} }, T), lang)
  }
  const conf = tmp('fromconf'); writeSetup(conf, {})
  const again = await setupWith({ typed: '\n\n\n\n', env: FROM, sessions: RUNNING, confDir: conf })
  assert.equal(again.r.state, 'existing'); assert.equal(again.r.autostart.state, 'starting')
  assert.equal(again.term.text(), ['', 'whosup updated. Your settings are kept.', '  To be asked again, type this in a terminal (or use "open first-run setup again" in the board\'s settings):', '      WHOSUP_SETUP=1 herdr plugin install fivetaku/whosup --yes', '', ''].join('\n'))
})

// ── 가-5 · F7: herdr가 사람의 PATH에 없으면 안내하는 herdr 명령을 전체 경로로 적는다(그대로 붙여 넣으면 실행된다) ──
test('herdr 명령의 첫 낱말(herdrWord): 사람의 PATH(WHOSUP_USER_PATH > PATH)로 herdr가 잡히면 herdr, 아니면 찾아 둔 실행 파일의 전체 경로 — 마무리 문구의 명령이 그대로 실행된다', async () => {
  const dir = tmp('herdrword'), odd = join(tmp('herdrword'), "it's here")
  mkdirSync(odd)
  const mark = join(dir, 'ran.txt')
  for (const d of [dir, odd]) { writeFileSync(join(d, 'herdr'), `#!/bin/sh\nprintf '%s\\n' "ran $*" >> '${mark}'\n`, { mode: 0o755 }) }
  const bin = join(dir, 'herdr')
  // PATH에 있다 → 짧은 이름. 없다 → 전체 경로. WHOSUP_USER_PATH가 있으면 그것으로 본다(설치기가 덧붙인 PATH는 보지 않는다)
  assert.equal(herdrWord({ env: { PATH: `/usr/bin:${dir}` }, herdrBin: bin, platform: 'darwin' }), 'herdr')
  assert.equal(herdrWord({ env: { PATH: '/usr/bin:/bin' }, herdrBin: bin, platform: 'darwin' }), bin)
  assert.equal(herdrWord({ env: { WHOSUP_USER_PATH: '/usr/bin:/bin', PATH: `${dir}:/usr/bin` }, herdrBin: bin, platform: 'linux' }), bin, '사람의 PATH에 없다')
  assert.equal(herdrWord({ env: { WHOSUP_USER_PATH: `/usr/bin:${dir}`, PATH: '/usr/bin' }, herdrBin: bin, platform: 'linux' }), 'herdr')
  assert.equal(herdrWord({ env: {}, herdrBin: bin, platform: 'darwin' }), bin, 'PATH가 없는 환경')
  // 전체 경로를 모르면(이름만 안다) · 윈도우 · herdr를 못 찾았으면 그대로 herdr
  for (const o of [{ herdrBin: 'herdr' }, { herdrBin: null }, { herdrBin: bin, platform: 'win32' }]) assert.equal(herdrWord({ env: { PATH: '/usr/bin' }, platform: 'darwin', ...o }), 'herdr', JSON.stringify(o))
  // 공백·따옴표가 든 경로는 셸의 한 낱말로 싼다
  assert.equal(herdrWord({ env: { PATH: '/usr/bin' }, herdrBin: join(odd, 'herdr'), platform: 'darwin' }), `'${join(odd, 'herdr').replace(/'/g, `'\\''`)}'`)
  // 문구: 그 낱말이 "herdr를 치세요"와 손으로 칠 명령·다시 묻게 하는 명령에 그대로 들어간다. 주지 않으면 전과 같다(herdr)
  const T = TEXT.en
  assert.ok(closingLines({ state: 'herdr_off', id: ID, env: {}, herdrCmd: bin }, T).includes(`      ${bin}`)); assert.ok(closingLines({ state: 'herdr_off', id: ID, env: {} }, T).includes('      herdr'))
  assert.deepEqual(closingLines({ state: 'unknown', id: ID, env: {}, herdrCmd: bin }, T).filter((l) => l.includes(bin)), [`      ${bin}`, `      ${bin} plugin action invoke ${ID}.start`])
  assert.equal(closingLines({ state: 'starting', id: ID, env: {}, desk: 'main', herdrCmd: bin }, T).at(-1), `    ${bin} --session main plugin action invoke ${ID}.start`)
  assert.equal(updatedLines({ id: ID, state: 'herdr_off', env: {}, herdrCmd: bin }, T).at(-1), `      WHOSUP_SETUP=1 ${bin} plugin install fivetaku/whosup --yes`)
  // 설치 한 번: herdr가 사람의 PATH에 없는 설치의 화면에서 "herdr를 치세요" 아래 줄을 그대로 셸에 넣으면 그 herdr가 돈다
  for (const [at, env] of [[bin, { PATH: '/usr/bin:/bin' }], [join(odd, 'herdr'), { WHOSUP_USER_PATH: '/usr/bin:/bin', PATH: `${odd}:/usr/bin:/bin` }]]) {
    const r = await setupWith({ typed: '\n\n\n\n', env, herdrBin: at })
    const rows = r.term.text().split('\n')
    const cmd = rows[rows.findIndex((l) => /Type this in this terminal and press Enter:/.test(l)) + 1].trim()
    assert.notEqual(cmd, 'herdr', at)
    const before = existsSync(mark) ? readFileSync(mark, 'utf8').split('\n').length : 1
    const { spawnSync } = await import('node:child_process')
    const ran = spawnSync('/bin/sh', ['-c', cmd], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' })
    assert.equal(ran.status, 0, `${cmd}: ${ran.stderr}`); assert.equal(readFileSync(mark, 'utf8').split('\n').length, before + 1, '그 herdr가 돌았다')
    assert.notEqual(spawnSync('/bin/sh', ['-c', 'herdr'], { env: { PATH: '/usr/bin:/bin' }, encoding: 'utf8' }).status, 0, '짧은 이름으로는 실행되지 않는 PATH다')
  }
  // PATH에 있는 설치는 전과 같이 짧은 이름이다
  const onPath = await setupWith({ typed: '\n\n\n\n', env: { PATH: `${dir}:/usr/bin:/bin` }, herdrBin: bin })
  assert.match(onPath.term.text(), /Type this in this terminal and press Enter:\n {6}herdr\n/)
})


// ── r4(맥북 에어) "두 번 묻는다": 터미널 첫 실행 안내에 Enter로 다 답한 설치는 마친 것으로 적어, 보드가 같은 질문을 다시 묻지 않는다 ──
test('마친 표시: 첫 설치에서 모든 질문에 답하면(Enter만이어도) done을 쓰고, 시간 초과·Ctrl-C·다 답하지 못한 설치·다시 묻기에는 쓰지 않는다', async () => {
  const enter = await setupWith({ typed: '\n\n\n\n' })
  assert.deepEqual(readSetup(enter.file), { version: 1, at: readSetup(enter.file).at, choices: {}, done: true }, 'Enter만: 값 없이 마친 표시')
  const mixed = await setupWith({ typed: '\n2\n\n\n' })
  assert.equal(readSetup(mixed.file).done, true); assert.equal(Object.keys(readSetup(mixed.file).choices).length, 1, '번호로 고른 것만 값으로')
  // 시간 초과: Enter로 하나 답하고 나머지에서 시간이 다 됐다 → 쓰지 않는다(보드가 한 번 묻는다)
  const late = await setupWith({ typed: '\n', env: { WHOSUP_SETUP_TIMEOUT_S: '0.05' } })
  assert.equal(late.r.ended, 'timeout'); assert.equal(existsSync(late.file), false); assert.match(late.term.text(), /the board asks once on first open/)
  // 시간 초과지만 번호로 고른 것이 있다: 값은 쓰되 마친 표시는 없다(보드는 고른 값이 있으니 지금처럼 마친 것으로 본다)
  const part = await setupWith({ typed: '2\n', env: { WHOSUP_SETUP_TIMEOUT_S: '0.05' } })
  assert.equal(readSetup(part.file).done, undefined)
  // 자리에 없음(한 번도 답하지 못함)
  assert.equal(existsSync((await setupWith({ env: { WHOSUP_SETUP_TIMEOUT_S: '0.05' } })).file), false)
  // Ctrl-C: Enter로 첫 질문에 답한 뒤 끊겼다 → 쓰지 않는다
  const c = await ctrlC({ typed: '\n' })
  assert.equal(existsSync(c.file), false)
  // 틀린 입력 세 번으로 넘어간 질문이 있다: 다 답한 것이 아니다
  const bad = await setupWith({ typed: 'x\nx\nx\n\n\n\n' })
  assert.equal(existsSync(bad.file), false); assert.match(bad.term.text(), /Nothing set by hand: the board asks once on first open\./)
  // 다시 묻는 실행(WHOSUP_SETUP=1)·손 실행: 지금까지와 같다(Enter만이면 쓰지 않는다)
  assert.equal(existsSync((await setupWith({ typed: '\n\n\n\n', env: { WHOSUP_SETUP: '1' } })).file), false)
  const hand = await setupWith({ typed: '\n\n\n\n', install: false })
  assert.deepEqual(hand.r.saved, [])
  // 물을 것이 없던 설치: 지금까지와 같다(쓰지 않는다 — 보드가 그때 감지한 것을 한 번 보여 준다)
  assert.equal(existsSync((await setupWith({ f: facts(), sessions: RUNNING })).file), false)
})

test('서버 가져오기: done 표시만 있는 setup.json(고른 값 없음)은 첫 실행 안내를 마친 것으로 적고 설정은 하나도 바꾸지 않는다 — 표시 없는 옛 파일은 그대로', async () => {
  const dir = tmp('impdone')
  const db = openDb(':memory:')
  const before = { settings: getSettings(db), origins: settingOrigins(db) }
  const { file, body } = writeSetup(dir, {}, { now: new Date('2026-11-14T00:00:00Z'), done: true })
  assert.deepEqual(body, { version: 1, at: '2026-11-14T00:00:00.000Z', choices: {}, done: true })
  const r = importSetup(db, file)
  assert.deepEqual(r, { ok: true, imported: true, at: body.at, applied: [], dropped: [] })
  assert.ok(getMeta(db, 'firstrun.done'), '마친 것으로 적는다'); assert.equal(getMeta(db, 'setup.imported_at'), body.at)
  assert.deepEqual(getSettings(db), before.settings, '설정 값은 그대로'); assert.deepEqual(settingOrigins(db), before.origins, '값의 출처도 그대로(자동 감지·기본값)')
  for (const k of FIRST_RUN_KEYS) assert.equal(getMeta(db, `setting.${k}`), null, `${k}: 고정하지 않는다`)
  // done이 true가 아닌 값(옛 파일·손으로 둔 파일)은 표시로 보지 않는다
  const db2 = openDb(':memory:')
  const f2 = join(tmp('impdone2'), 'setup.json')
  writeFileSync(f2, JSON.stringify({ version: 1, at: 't1', choices: {}, done: 'yes' }))
  assert.equal(readSetup(f2).done, undefined); importSetup(db2, f2); assert.equal(getMeta(db2, 'firstrun.done'), null)
  // 보드: 그 파일을 읽고 뜬 보드는 첫 실행 안내를 띄우지 않는다
  const db3 = openDb(':memory:')
  const srv = createBoardServer(db3, { setupFile: file })
  await new Promise((res) => srv.listen(0, '127.0.0.1', res))
  try {
    const v = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/autoconf`)).json()
    assert.equal(v.first_run.show, false, '터미널에서 다 답했다: 같은 질문을 다시 묻지 않는다')
    for (const k of FIRST_RUN_KEYS) assert.notDeepEqual(v.chosen[k].origin, { source: 'panel' }, `${k}: 사람이 정한 값으로 적지 않는다`)
  } finally { srv.close() }
  // 표시 없는 옛 빈 파일을 읽은 보드는 지금처럼 안내를 띄운다
  const db4 = openDb(':memory:')
  const old = writeSetup(tmp('impold'), {})
  const srv2 = createBoardServer(db4, { setupFile: old.file })
  await new Promise((res) => srv2.listen(0, '127.0.0.1', res))
  try { assert.equal((await (await fetch(`http://127.0.0.1:${srv2.address().port}/api/autoconf`)).json()).first_run.show, true) } finally { srv2.close() }
})
