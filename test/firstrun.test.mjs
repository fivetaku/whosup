// M3 화면: 설정 값의 출처 표시, "감지한 환경" 요약, 첫 실행 안내.
// 화면(index.html)의 /*origin*/ 덩어리(순수 함수)와 I18N을 그대로 읽어 시험하고, 화면 배선은 문지기 패턴(readonly.test.mjs)으로 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { openDb } from '../src/db.mjs'
import { setAutoValues, getSettings } from '../src/settings.mjs'
import { createBoardServer } from '../src/board/server.mjs'

const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const block = html.match(/\/\*origin\*\/([\s\S]*?)\/\*\/origin\*\//)
assert.ok(block, 'index.html에 /*origin*/ … /*/origin*/ 덩어리가 있어야 한다')
const { originText, envSummaryParts, firstRunPlan, firstRunHintKey, firstRunTitleKey, choiceRows, choicePatch } = new Function(`${block[1]}; return { originText, envSummaryParts, firstRunPlan, firstRunHintKey, firstRunTitleKey, choiceRows, choicePatch }`)()

test('출처 한 줄: 설정 / 환경변수(파일 경로·stop 뒤 start) / 자동 감지(근거) / 기본값 — ko·en', () => {
  for (const lang of ['ko', 'en']) {
    const T = I18N[lang]
    const panel = originText({ source: 'panel' }, T)
    const envFile = originText({ source: 'env', name: 'AGENT_CMD', file: '/tmp/cfg/.env' }, T)
    const envShell = originText({ source: 'env', name: 'FRONT_APP', file: null }, T)
    const auto = originText({ source: 'auto', reason: 'L4: Ghostty.app is installed' }, T)
    const def = originText({ source: 'default' }, T)
    assert.ok(panel && def && panel !== def, lang)
    assert.match(envFile, /AGENT_CMD/); assert.match(envFile, /\/tmp\/cfg\/\.env/); assert.match(envFile, /stop/); assert.match(envFile, /start/)
    assert.match(envShell, /FRONT_APP/); assert.match(envShell, /stop/); assert.doesNotMatch(envShell, /null/)
    assert.match(auto, /L4: Ghostty\.app is installed/)
    assert.equal(originText(undefined, T), '', '옛 서버(origins 없음)면 아무것도 쓰지 않는다')
    assert.ok(originText({ source: 'browser' }, T), lang)
    assert.ok(originText({ source: 'card' }, T) && originText({ source: 'card' }, T) !== panel, '세션 열기 방식의 사람 값은 입력란 비우기 안내가 없는 문구')
  }
  assert.match(originText({ source: 'panel' }, I18N.ko), /설정에서 정함/)
  assert.match(originText({ source: 'auto', reason: 'x' }, I18N.ko), /자동 감지/)
  assert.match(originText({ source: 'default' }, I18N.ko), /기본값/)
})

test('어디인지 모르는 "지금 값은 환경변수" 문구를 없앴다', () => {
  assert.doesNotMatch(html, /fromEnv/)
  assert.doesNotMatch(html, /지금 값은 환경변수/)
  assert.doesNotMatch(html, /current value from environment/)
})

test('감지한 환경 요약: OS·터미널 앱·herdr 데스크·Herdr 앱·ovis 포트↔데스크·원격 여부, 감지 못 한 항목은 "확인 못 함"', () => {
  const T = I18N.ko
  const none = envSummaryParts(null, T)
  assert.equal(none.length, 6)
  assert.ok(none.every(([, v]) => v === '확인 못 함'), 'auto.json이 없으면 전부 확인 못 함')
  const full = Object.fromEntries(envSummaryParts({
    os: 'darwin', desktop: true, terminal: 'Ghostty',
    herdr: { found: true, version: '0.9.3', sessions: ['main', 'side'] }, herdr_core: { running: true }, herdr_app: { found: true },
    ovis: [{ port: 7318, session: 'side', url: 'http://127.0.0.1:7318/?pane={pane}', confirmed: true }, { port: 7317, session: null, confirmed: false }],
  }, T))
  assert.equal(full.OS, 'macOS')
  assert.equal(full['터미널 앱'], 'Ghostty')
  assert.match(full['herdr 데스크'], /2개 \(main, side\)/)
  assert.match(full['Herdr 앱'], /있음 · 코어 실행 중/)
  assert.equal(full.ovis, '7318 ↔ side, 7317 ↔ 데스크 확인 필요')
  assert.equal(full['실행 위치'], '이 컴퓨터의 데스크톱')
  const part = Object.fromEntries(envSummaryParts({ os: 'win32', desktop: null, terminal: 'off', herdr: null, herdr_core: null, herdr_app: null, ovis: [] }, T))
  assert.equal(part.OS, 'Windows')
  assert.equal(part['터미널 앱'], '끔')
  assert.equal(part['herdr 데스크'], '확인 못 함')
  assert.equal(part['Herdr 앱'], '확인 못 함')
  assert.equal(part.ovis, '없음')
  assert.equal(part['실행 위치'], '확인 못 함')
  const remote = Object.fromEntries(envSummaryParts({ os: 'linux', desktop: false, terminal: null, herdr: { found: false }, ovis: [] }, I18N.en))
  assert.match(remote['running on'], /remote/)
  assert.equal(remote['herdr desks'], 'none')
  assert.equal(remote['terminal app'], 'no window raising')
})

test('감지한 환경 요약(첫 실행 안내): 세션을 띄울 곳을 하나라도 찾았으면 "없음" 항목은 싣지 않는다 — 못 찾았으면 지금처럼, "확인 못 함"은 그대로, 설정은 다 싣는다', () => {
  for (const lang of ['ko', 'en']) {
    const T = I18N[lang]
    // 실기기(오비스 앱만): herdr 없음 · Herdr 앱 없음 · 웹 터미널 없음, 자기 코어를 띄우는 앱 하나가 돌고 있다
    const ovisOnly = { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false, view_only: false }, herdr_app: { found: false }, ovis: [], cores: [{ name: 'c1', app: 'Ovis', web: true }] }
    const fr = envSummaryParts(ovisOnly, T, { firstRun: true })
    assert.deepEqual(fr.map(([k]) => k), [T.envOs, T.envTerm, T.envAppOf('Ovis'), T.envRemote], lang)
    assert.equal(Object.fromEntries(fr)[T.envAppOf('Ovis')], T.envAppFound(true))
    assert.ok(fr.every(([, v]) => v !== T.envNone), lang)
    // 설정 화면(firstRun 없음)은 지금처럼 다 싣는다
    const all = Object.fromEntries(envSummaryParts(ovisOnly, T))
    assert.equal(all[T.envHerdr], T.envNone); assert.equal(all[T.envApp], T.envNone); assert.equal(all[T.envOvis], T.envNone)
    // 다른 자리 하나만 찾아도 같다: herdr(데스크 0개라도) · Herdr 앱 코어 · ovis 웹 터미널
    const bare = { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false }, herdr_app: { found: false }, ovis: [] }
    assert.deepEqual(envSummaryParts({ ...bare, herdr: { found: true, sessions: [] } }, T, { firstRun: true }).map(([k]) => k), [T.envOs, T.envTerm, T.envHerdr, T.envRemote])
    assert.deepEqual(envSummaryParts({ ...bare, herdr_app: { found: true } }, T, { firstRun: true }).map(([k]) => k), [T.envOs, T.envTerm, T.envApp, T.envRemote])
    assert.deepEqual(envSummaryParts({ ...bare, ovis: [{ port: 7317, session: null, confirmed: false }] }, T, { firstRun: true }).map(([k]) => k), [T.envOs, T.envTerm, T.envOvis, T.envRemote])
    // 아무 데도 찾지 못했다: '없음'이 할 말이다 — 지금처럼 다 싣는다
    assert.deepEqual(envSummaryParts(bare, T, { firstRun: true }), envSummaryParts(bare, T))
    // 확인 못 한 항목은 첫 실행 안내에서도 그대로 남는다
    const unknown = Object.fromEntries(envSummaryParts({ ...ovisOnly, herdr: null, herdr_app: null, herdr_core: null }, T, { firstRun: true }))
    assert.equal(unknown[T.envHerdr], T.envUnknown); assert.equal(unknown[T.envApp], T.envUnknown); assert.equal(unknown[T.envOvis], undefined)
    assert.equal(envSummaryParts(null, T, { firstRun: true }).length, 6)
  }
  // 배선: 첫 실행 안내만 firstRun 으로 그린다(설정·읽기 전용 설정은 다 싣는다)
  assert.match(html, /\$\{envSummaryHtml\(v, false, true\)\}/)
  assert.match(html, /envSummaryHtml\(v, true\)/); assert.match(html, /\$\{envSummaryHtml\(data\.autoconf, true\)\}/)
  // 고를 줄도 첫 실행 안내(그리기와 저장)만 firstRun 으로 만든다
  assert.match(html, /const frRows = plan\.rows \? choiceRows\(v, T, \{ firstRun: true \}\) : \[\]/)
  assert.match(html, /choiceRowsHtml\(frRows, frPick\)/)
  assert.match(html, /choicePatch\(choiceRows\(acView, T, \{ firstRun: true \}\), frPick, acView\?\.chosen\)/)
})

test('첫 실행 안내: 고를 줄과 이대로 시작, 읽기 전용=닫기만(저장 없음), 설정에서 다시 보기', () => {
  const view = (show) => ({ first_run: { show } })
  assert.deepEqual(firstRunPlan(view(true)), { show: true, rows: true, actions: ['ok'] })
  assert.equal(firstRunPlan(view(false)).show, false, '한 번 확인한 뒤에는 다시 뜨지 않는다')
  assert.equal(firstRunPlan(view(true), { readonly: true }).show, false, '읽기 전용은 저절로 띄우지 않는다')
  assert.deepEqual(firstRunPlan(view(false), { readonly: true, force: true }), { show: true, rows: false, actions: ['close'] })
  assert.deepEqual(firstRunPlan(view(false), { force: true }), { show: true, rows: true, actions: ['ok'] }, '설정에서 다시 볼 수 있다')
  assert.equal(firstRunPlan(null).show, false)
  assert.equal(firstRunHintKey(firstRunPlan(view(true))), 'frHint')
  assert.equal(firstRunHintKey(firstRunPlan(view(false), { readonly: true, force: true })), 'frRo')
  for (const lang of ['ko', 'en']) assert.match(I18N[lang].frHint, lang === 'ko' ? /설정에 저장/ : /saved in settings/)
  assert.match(html, /<div class="hint">\$\{T\[firstRunHintKey\(plan, frRows\)\]\}<\/div>/, '안내가 이 함수로 문장을 고른다(실은 줄을 넘겨)')
})

test('첫 실행 안내: 고를 줄이 하나도 없으면 "직접 고른 줄만 저장…" 대신 "지금은 고를 것이 없습니다…"를 보인다 — 읽기 전용은 그대로', () => {
  const view = (show) => ({ first_run: { show } })
  const plan = firstRunPlan(view(true))
  assert.equal(firstRunHintKey(plan, []), 'frNone', '고를 줄 없음')
  assert.equal(firstRunHintKey(plan, [{ key: 'agent_cmd' }]), 'frHint', '고를 줄이 있으면 저장 안내')
  assert.equal(firstRunHintKey(firstRunPlan(view(false), { force: true }), []), 'frNone', '설정에서 다시 연 안내도 같다')
  assert.equal(firstRunHintKey(firstRunPlan(view(false), { readonly: true, force: true }), []), 'frRo', '읽기 전용은 줄을 싣지 않으므로 읽기 전용 문장')
  // 오비스 앱만 있는 기계(웹 터미널 없음 · 에이전트 하나): 실을 줄이 없다 → frNone
  const T = I18N.ko
  const ovisApp = { summary: { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false }, herdr_app: { found: false }, ovis: [], cores: [{ name: 'c1', app: 'Ovis', web: true }], options: { terminal_apps: [{ name: 'Terminal', showing: false, opens_new: true }], agents: ['claude'] } }, chosen: chosen({ front_app: { value: '', origin: { source: 'default' } } }) }
  assert.equal(firstRunHintKey(plan, choiceRows(ovisApp, T, { firstRun: true })), 'frNone')
  assert.equal(firstRunHintKey(plan, choiceRows(fullView(), T, { firstRun: true })), 'frHint')
  for (const lang of ['ko', 'en']) {
    assert.ok(I18N[lang].frNone, `${lang}.frNone`); assert.notEqual(I18N[lang].frNone, I18N[lang].frHint)
    assert.match(I18N[lang].frNone, lang === 'ko' ? /고를 것이 없습니다.*감지한 값으로 시작.*설정에서 언제든 바꿀 수/ : /Nothing to choose right now.*starts with what it detected.*change it in settings any time/)
  }
})

test('첫 실행 안내 제목: 고를 줄이 없으면 "감지한 것 중에서 골라 주세요" 대신 "감지한 환경" — 고를 줄이 있으면 그대로, 읽기 전용도 고를 줄이 없다', () => {
  const view = (show) => ({ first_run: { show } })
  const plan = firstRunPlan(view(true))
  assert.equal(firstRunTitleKey(plan, []), 'frTitleNone', '고를 줄 없음')
  assert.equal(firstRunTitleKey(plan, [{ key: 'agent_cmd' }]), 'frTitle', '고를 줄이 있으면 고르라는 제목')
  assert.equal(firstRunTitleKey(firstRunPlan(view(false), { force: true }), []), 'frTitleNone', '설정에서 다시 연 안내도 같다')
  assert.equal(firstRunTitleKey(firstRunPlan(view(false), { readonly: true, force: true }), []), 'frTitleNone', '읽기 전용은 줄을 싣지 않는다')
  // r4(맥북 에어 · 오비스 앱만 있는 기계): 고를 줄이 없어 안내 문장(frNone)과 제목이 서로 맞는다
  const T = I18N.ko
  const ovisApp = { summary: { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false }, herdr_app: { found: false }, ovis: [], cores: [{ name: 'c1', app: 'Ovis', web: true }], options: { terminal_apps: [{ name: 'Terminal', showing: false, opens_new: true }], agents: ['claude'] } }, chosen: chosen({ front_app: { value: '', origin: { source: 'default' } } }) }
  const rows = choiceRows(ovisApp, T, { firstRun: true })
  assert.equal(firstRunTitleKey(plan, rows), 'frTitleNone'); assert.equal(firstRunHintKey(plan, rows), 'frNone')
  assert.equal(firstRunTitleKey(plan, choiceRows(fullView(), T, { firstRun: true })), 'frTitle')
  for (const lang of ['ko', 'en']) {
    assert.ok(I18N[lang].frTitleNone, `${lang}.frTitleNone`); assert.notEqual(I18N[lang].frTitleNone, I18N[lang].frTitle)
    assert.doesNotMatch(I18N[lang].frTitleNone, lang === 'ko' ? /골라/ : /pick/i)
  }
  assert.equal(I18N.ko.frTitleNone, '첫 실행 안내 · 감지한 환경'); assert.equal(I18N.en.frTitleNone, 'First-run setup · what was detected')
  assert.match(html, /<span class="caps">\$\{T\[firstRunTitleKey\(plan, frRows\)\]\}<\/span>/, '안내 머리가 이 함수로 제목을 고른다')
})

const chosen = (over = {}) => ({
  click_target: { value: 'terminal', origin: { source: 'default' } }, front_app: { value: 'Ghostty', origin: { source: 'auto', reason: 'L4' } },
  core_target: { value: 'app', origin: { source: 'default' } }, agent_cmd: { value: 'claude', origin: { source: 'auto', reason: 'L8' } }, ...over,
})
const fullView = (over = {}) => ({
  summary: {
    os: 'darwin', desktop: true, terminal: 'Ghostty', herdr: { found: true, sessions: ['main'] }, herdr_core: { running: true }, herdr_app: { found: true },
    ovis: [{ port: 7317, session: 'main', url: 'http://127.0.0.1:7317/?pane={pane}', confirmed: true }, { port: 7318, session: null, confirmed: false }],
    options: { terminal_apps: [{ name: 'Ghostty', showing: true, opens_new: true }, { name: 'Terminal', showing: false, opens_new: true }, { name: 'iTerm', showing: false, opens_new: false }], agents: ['claude', 'codex'] },
  },
  chosen: chosen(), ...over,
})

test('고를 줄: 감지한 선택지만 싣고 지금 값을 미리 고른다 — 터미널 앱들·웹 터미널·Herdr 앱·에이전트', () => {
  const T = I18N.ko
  const rows = Object.fromEntries(choiceRows(fullView(), T).map((r) => [r.key, r]))
  assert.deepEqual(Object.keys(rows), ['click_target', 'front_app', 'core_target', 'agent_cmd'])
  assert.deepEqual(rows.click_target.options.map((o) => o.value), ['terminal', 'web', 'both'], '데스크와 맞춘 웹 터미널이 있으면 세 선택')
  assert.match(rows.click_target.hint, /ovis 7317 ↔ main/); assert.doesNotMatch(rows.click_target.hint, /7318/, '데스크를 못 맞춘 후보는 싣지 않는다')
  assert.equal(rows.click_target.value, 'terminal')
  assert.deepEqual(rows.front_app.options.map((o) => o.value), ['Ghostty', 'Terminal', 'iTerm', ''])
  assert.equal(rows.front_app.value, 'Ghostty', '자동 감지한 앱을 미리 고른다')
  assert.equal(rows.front_app.options[0].note, T.chShowing); assert.equal(rows.front_app.options[2].note, T.chRaiseOnly)
  assert.deepEqual(rows.core_target.options.map((o) => o.value), ['app', 'terminal']); assert.equal(rows.core_target.value, 'app')
  assert.deepEqual(rows.agent_cmd.options.map((o) => o.value), ['claude', 'codex']); assert.equal(rows.agent_cmd.value, 'claude')
  // 감지한 것이 없으면 그 줄이 없다: 웹 터미널 없음 = 터미널 창 하나, 터미널 앱·Herdr 앱 줄 없음
  const bare = Object.fromEntries(choiceRows({ summary: { os: 'linux', ovis: [], herdr_app: { found: false }, herdr_core: { running: false }, options: { terminal_apps: [], agents: [] } }, chosen: chosen({ front_app: { value: '', origin: { source: 'default' } }, agent_cmd: { value: 'claude', origin: { source: 'default' } } }) }, T).map((r) => [r.key, r]))
  assert.deepEqual(Object.keys(bare), ['click_target', 'agent_cmd'])
  assert.deepEqual(bare.click_target.options.map((o) => o.value), ['terminal']); assert.equal(bare.click_target.hint, T.chClickOnly)
  assert.equal(bare.agent_cmd.options[0].note, T.chNotFound, '감지되지 않은 기본 명령은 그렇게 적는다')
  // 사람이 정한 값이 목록에 없으면 그 값도 선택지로 보인다(cct 같은 자기 명령, 목록 밖 터미널 앱)
  const own = Object.fromEntries(choiceRows(fullView({ chosen: chosen({ agent_cmd: { value: 'cct', origin: { source: 'env', name: 'AGENT_CMD' } }, front_app: { value: 'Warp', origin: { source: 'panel' } }, click_target: { value: 'both', origin: { source: 'panel' } } }) }), T).map((r) => [r.key, r]))
  assert.deepEqual(own.agent_cmd.options.map((o) => o.value), ['cct', 'claude', 'codex']); assert.equal(own.agent_cmd.value, 'cct')
  assert.ok(own.front_app.options.some((o) => o.value === 'Warp')); assert.equal(own.front_app.value, 'Warp')
  assert.equal(own.click_target.value, 'both')
  assert.deepEqual(choiceRows(null, T).map((r) => r.key), ['click_target'], '옛 서버·감지 실패여도 깨지지 않는다')
  // 첫 실행 안내(firstRun): 선택지가 하나뿐인 줄은 싣지 않는다 — 웹 터미널이 없으면 세션을 여는 곳(터미널 창 하나)이 빠진다. 설정은 다 싣는다
  const bareView = { summary: { os: 'linux', ovis: [], herdr_app: { found: false }, herdr_core: { running: false }, options: { terminal_apps: [], agents: [] } }, chosen: chosen({ front_app: { value: '', origin: { source: 'default' } }, agent_cmd: { value: 'claude', origin: { source: 'default' } } }) }
  assert.deepEqual(choiceRows(bareView, T, { firstRun: true }).map((r) => r.key), [], '터미널 창 하나 · 명령 하나 = 고를 것이 없다')
  assert.deepEqual(choiceRows(fullView(), T, { firstRun: true }), choiceRows(fullView(), T), '고를 것이 둘 이상인 줄은 그대로')
  const ovisApp = { summary: { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false }, herdr_app: { found: false }, ovis: [], cores: [{ name: 'c1', app: 'Ovis', web: true }], options: { terminal_apps: [{ name: 'Terminal', showing: false, opens_new: true }], agents: ['claude', 'codex'] } }, chosen: chosen() }
  assert.deepEqual(choiceRows(ovisApp, T, { firstRun: true }).map((r) => r.key), ['agent_cmd'], '오비스 앱만: 세션을 여는 곳(터미널 창 하나)은 묻지 않는다')
  assert.deepEqual(choiceRows(ovisApp, T).map((r) => r.key), ['click_target', 'agent_cmd'], '설정은 그대로')
  assert.deepEqual(choicePatch(choiceRows(ovisApp, T, { firstRun: true }), { click_target: 'web' }, ovisApp.chosen), {}, '싣지 않은 줄은 저장하지 않는다')
  assert.deepEqual(choiceRows(null, T, { firstRun: true }), [])
  // 터미널 앱 하나 + 자동: '자동'(값 '')은 고를 것으로 세지 않는다(터미널의 questionsOf와 같다) — 첫 실행 안내는 싣지 않고, 설정은 그대로
  const oneApp = fullView({ summary: { ...fullView().summary, ovis: [], options: { terminal_apps: [{ name: 'Ghostty', showing: true, opens_new: true }], agents: ['claude', 'codex'] } } })
  assert.deepEqual(choiceRows(oneApp, T).find((r) => r.key === 'front_app').options.map((o) => o.value), ['Ghostty', ''], '설정: 앱 하나와 자동')
  assert.deepEqual(choiceRows(oneApp, T, { firstRun: true }).map((r) => r.key), ['core_target', 'agent_cmd'], '첫 실행 안내: 터미널 앱(앱 하나 + 자동) 줄이 없다')
  // 사람이 정한 값이 목록 밖이면 그것도 고를 것이다(앱 둘 + 자동) — 그때는 싣는다
  const oneAppOwn = { ...oneApp, chosen: chosen({ front_app: { value: 'Warp', origin: { source: 'panel' } } }) }
  assert.ok(choiceRows(oneAppOwn, T, { firstRun: true }).some((r) => r.key === 'front_app'))
  for (const lang of ['ko', 'en']) for (const r of choiceRows(fullView(), I18N[lang])) { assert.ok(r.label, `${lang}.${r.key} label`); for (const o of r.options) assert.ok(o.label, `${lang}.${r.key} option`) }
})

test('저장할 값: 사람이 손댄 줄만 저장한다 — 손대지 않은 자동 감지·기본값 줄은 보내지 않고(F14), 이미 사람이 정한 값도 건드리지 않는다', () => {
  const T = I18N.ko
  const v = fullView()
  // 미리 골라져 보이는 값(front_app Ghostty·agent_cmd claude 는 자동 감지, 나머지는 기본값)은 손대지 않으면 사람이 고른 값으로 굳히지 않는다.
  assert.equal(choiceRows(v, T).find((r) => r.key === 'front_app').value, 'Ghostty')
  assert.deepEqual(choicePatch(choiceRows(v, T), {}, v.chosen), {}, '손대지 않고 "이대로 시작"이면 아무것도 저장하지 않는다')
  assert.deepEqual(choicePatch(choiceRows(v, T), { core_target: 'terminal' }, v.chosen), { core_target: 'terminal' }, '손댄 줄만 보낸다 — 옆의 자동 감지 줄은 그대로 자동')
  assert.deepEqual(choicePatch(choiceRows(v, T), { front_app: 'Ghostty' }, v.chosen), { front_app: 'Ghostty' }, '미리 골라져 있던 값이라도 사람이 누르면 사람이 고른 값이다')
  assert.deepEqual(choicePatch(choiceRows(v, T), { click_target: 'both', front_app: 'Terminal', core_target: 'terminal', agent_cmd: 'codex' }, v.chosen), { click_target: 'both', front_app: 'Terminal', core_target: 'terminal', agent_cmd: 'codex' })
  assert.deepEqual(choicePatch(choiceRows(v, T), { front_app: '' }, v.chosen).front_app, undefined, '자동을 골랐고 저장한 값이 없으면 아무것도 보내지 않는다')
  const own = fullView({ chosen: chosen({ agent_cmd: { value: 'cct', origin: { source: 'env' } }, front_app: { value: 'Terminal', origin: { source: 'panel' } } }) })
  const keep = choicePatch(choiceRows(own, T), {}, own.chosen)
  assert.equal('agent_cmd' in keep, false, '환경변수로 정한 값은 손대지 않으면 그대로'); assert.equal('front_app' in keep, false, '설정에서 정한 값도 그대로')
  assert.equal(choicePatch(choiceRows(own, T), { front_app: '' }, own.chosen).front_app, null, '저장한 값이 있을 때 자동을 고르면 그 값을 지운다')
  assert.equal(choicePatch(choiceRows(own, T), { agent_cmd: 'codex' }, own.chosen).agent_cmd, 'codex', '손댄 줄은 환경변수 값 위에 저장한다')
})

test('화면 배선: 안내 저장은 문지기(can) 뒤 POST /api/first-run, 설정 항목마다 출처, 위에 감지 요약, 다시 보기·다시 감지 단추', () => {
  assert.match(html, /async function firstRunChoose\(\) \{\n\s+if \(!can\(\)\) return denied\(\)/)
  assert.match(html, /post\('\/api\/first-run', \{ choices \}\)/)
  assert.match(html, /async function redetect\(\) \{\n\s+if \(!can\(\)\) return denied\(\)/)
  assert.match(html, /post\('\/api\/autoconf\/refresh', \{\}\)/)
  const fn = html.match(/async function showSettings\(\) \{[\s\S]*?\n\}\n/)[0]
  for (const k of ["orig('front_app')", "orig('agent_cmd')", 'orig(k)', 'data-origin="click_target"', 'envSummaryHtml(data.autoconf, true)']) assert.ok(fn.includes(k), k)
  assert.ok(fn.indexOf('envSummaryHtml(data.autoconf, true)') < fn.indexOf('${langRow}\n  <div class="setrow cmdrow">'), '요약은 설정 항목보다 위')
  assert.match(html, /data-firstrun-open/)
  assert.match(html, /<div class="firstrun" id="firstrun" hidden><\/div>/)
  // 서버 기본값(client_defaults)은 브라우저에 옮겨 적지 않는다 — 자동 값을 사람 값으로 굳히지 않는다.
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*srvDefaults/)
  // 세션을 여는 곳은 서버 설정에 저장한다. 이 브라우저에만 적는 것은 "이 브라우저에서만 다르게"를 켰을 때뿐이고, 손대지 않았으면 아무것도 적지 않는다.
  assert.match(html, /if \(localEl\?\.checked\) \{ if \(pendingMode !== loadedMode \|\| !hasLocalClick\(\)\) setClickMode\(pendingMode\) \}/)
  assert.match(html, /else if \(pendingMode !== loadedMode\) patch\.click_target = pendingMode/)
  assert.ok(fn.includes('data-origin="core_target"') && fn.includes('data-core-target'), 'Herdr 앱 세션을 여는 곳 항목')
  assert.ok(fn.includes('id="set-click-local"'), '이 브라우저에서만 다르게')
  assert.match(html, /data-redetect/)
  for (const lang of ['ko', 'en']) for (const k of ['oPanel', 'oEnv', 'oEnvShell', 'oAuto', 'oDefault', 'oCard', 'oBrowser', 'envTitle', 'envUnknown', 'frTitle', 'frTitleNone', 'frHint', 'frOk', 'frClose', 'frRo', 'frSaved', 'frReopen', 'clickLabel', 'clickTerminal', 'clickWeb', 'clickBoth', 'clickLocal', 'clickLocalHint', 'chClickOnly', 'chClickWeb', 'chShowing', 'chRaiseOnly', 'chAutoNote', 'chNotFound', 'chCore', 'chCoreApp', 'chCoreHint', 'redetect', 'redetecting', 'redetected', 'redetectFail']) assert.ok(I18N[lang][k], `${lang}.${k}`)
})

test('서버: 읽기 전용이면 안내를 띄우지 않고 POST /api/first-run은 read_only, 아니면 선택이 설정 값으로 저장되고 다시 뜨지 않는다', async () => {
  setAutoValues({ values: { 'open_url:side': 'http://127.0.0.1:7318/?pane={pane}' }, reasons: {}, summary: { os: 'darwin', ovis: [{ port: 7318, session: 'side', confirmed: true }] } })
  const db = openDb(':memory:')
  const srv = createBoardServer(db)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const postFR = (body) => fetch(`${base}/api/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    process.env.WHOSUP_READONLY = '1'
    assert.equal((await (await fetch(`${base}/api/autoconf`)).json()).first_run.show, false)
    const ro = await postFR({ choice: 'web' })
    assert.equal(ro.status, 403); assert.equal((await ro.json()).code, 'read_only')
    assert.equal(getSettings(db).click_target, 'terminal', '읽기 전용에서는 저장하지 않는다')
    delete process.env.WHOSUP_READONLY
    const v = await (await fetch(`${base}/api/autoconf`)).json()
    assert.equal(v.first_run.show, true); assert.equal(v.first_run.ask_click, true)
    assert.equal(v.client_defaults['whosup-open-url-on'], 'off', 'ovis가 있어도 기본은 터미널')
    assert.equal(v.client_defaults['whosup-open-url:side'], 'http://127.0.0.1:7318/?pane={pane}')
    const r = await (await postFR({ choice: 'web' })).json()
    assert.equal(r.ok, true)
    assert.equal(r.client_defaults['whosup-open-url-on'], 'on'); assert.equal(r.client_defaults['whosup-raise'], 'off')
    const s = await (await fetch(`${base}/api/settings`)).json()
    assert.equal(s.settings.click_target, 'web'); assert.deepEqual(s.origins.click_target, { source: 'panel' })
    assert.equal((await (await fetch(`${base}/api/autoconf`)).json()).first_run.show, false, '다시 뜨지 않는다')
  } finally { srv.close(); delete process.env.WHOSUP_READONLY; setAutoValues(null) }
})

test('서버: 안내에서 고른 값들이 설정으로 저장되고, 모르는 항목은 거절, 지금 값·출처(chosen)를 내려 준다', async () => {
  setAutoValues({ values: { front_app: 'Ghostty', agent_cmd: 'claude' }, reasons: { front_app: 'L4: Ghostty.app is installed', agent_cmd: 'L8: claude found' }, summary: { os: 'darwin', ovis: [], options: { terminal_apps: [{ name: 'Ghostty', showing: false, opens_new: true }], agents: ['claude'] } } })
  const db = openDb(':memory:')
  const srv = createBoardServer(db)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const postFR = (body) => fetch(`${base}/api/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const v = await (await fetch(`${base}/api/autoconf`)).json()
    assert.deepEqual(Object.keys(v.chosen), ['click_target', 'front_app', 'core_target', 'agent_cmd'])
    assert.equal(v.chosen.front_app.value, 'Ghostty'); assert.equal(v.chosen.front_app.origin.source, 'auto')
    assert.equal(v.chosen.core_target.value, 'app'); assert.equal(v.chosen.core_target.origin.source, 'default')
    const bad = await postFR({ choices: { seen_snooze_min: 5 } })
    assert.equal(bad.status, 400, '안내에서 고르는 항목이 아니면 거절')
    assert.equal((await (await fetch(`${base}/api/autoconf`)).json()).first_run.show, true, '거절하면 확인한 것으로 치지 않는다')
    const wrong = await postFR({ choices: { core_target: 'browser' } })
    assert.equal(wrong.status, 400)
    const r = await (await postFR({ choices: { click_target: 'terminal', front_app: 'Ghostty', core_target: 'terminal', agent_cmd: 'claude' } })).json()
    assert.equal(r.ok, true)
    const s = await (await fetch(`${base}/api/settings`)).json()
    for (const k of ['click_target', 'front_app', 'core_target', 'agent_cmd']) assert.deepEqual(s.origins[k], { source: 'panel' }, `${k}는 사람이 정한 값으로 저장`)
    assert.equal(s.settings.core_target, 'terminal'); assert.equal(s.settings.front_app, 'Ghostty')
    assert.equal(s.autoconf.first_run.show, false, '다시 뜨지 않는다')
    // 저장한 값은 자동 감지가 달라져도 그대로다
    setAutoValues({ values: { front_app: 'Terminal', agent_cmd: 'codex' }, reasons: {}, summary: { os: 'darwin' } })
    assert.equal(getSettings(db).front_app, 'Ghostty'); assert.equal(getSettings(db).agent_cmd, 'claude')
    // 설정에서 바꾸면 그 값이 쓰인다
    const set = await fetch(`${base}/api/settings`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ settings: { click_target: 'both', core_target: 'app' } }) })
    assert.equal(set.status, 200)
    assert.equal(getSettings(db).click_target, 'both'); assert.equal(getSettings(db).core_target, 'app')
  } finally { srv.close(); setAutoValues(null) }
})

test('서버: 손대지 않고 "이대로 시작"하거나 안내를 닫으면(고른 것 없음) 마침으로만 적히고, 자동 감지 값은 자동인 채로 남아 감지가 바뀌면 따라간다 (F13·F14)', async () => {
  const auto = (front, cmd) => setAutoValues({ values: { front_app: front, agent_cmd: cmd }, reasons: { front_app: `L4: ${front}`, agent_cmd: `L8: ${cmd}` }, summary: { os: 'darwin', desktop: true, herdr: { found: true, sessions: ['main'] }, ovis: [], options: { terminal_apps: [{ name: front, showing: true, opens_new: true }], agents: [cmd] } } })
  auto('Ghostty', 'claude')
  const db = openDb(':memory:')
  const srv = createBoardServer(db)
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  try {
    const v = await (await fetch(`${base}/api/autoconf`)).json()
    assert.equal(v.first_run.show, true)
    // 화면이 보내는 그대로: 손대지 않은 줄은 싣지 않는다
    const choices = choicePatch(choiceRows(v, I18N.en), {}, v.chosen)
    assert.deepEqual(choices, {})
    const r = await fetch(`${base}/api/first-run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ choices }) })
    assert.equal(r.status, 200)
    const s = await (await fetch(`${base}/api/settings`)).json()
    assert.equal(s.autoconf.first_run.show, false, '마침으로 적혀 다시 뜨지 않는다')
    assert.equal(s.origins.front_app.source, 'auto', '사람이 고른 값으로 굳지 않았다'); assert.equal(s.origins.agent_cmd.source, 'auto')
    assert.equal(s.origins.click_target.source, 'default'); assert.equal(s.origins.core_target.source, 'default')
    auto('Terminal', 'codex')
    assert.equal(getSettings(db).front_app, 'Terminal', '자동 감지가 나중에 바뀌면 따라간다'); assert.equal(getSettings(db).agent_cmd, 'codex')
    assert.equal((await (await fetch(`${base}/api/autoconf`)).json()).first_run.show, false)
  } finally { srv.close(); setAutoValues(null) }
})

test('서버: 다시 감지 — POST /api/autoconf/refresh가 자동 값을 갈아 끼우고, 안내를 확인하기 전에는 화면이 물을 때 저절로 다시 감지한다', async () => {
  const { FIRST_RUN_REDETECT_MS } = await import('../src/board/server.mjs')
  setAutoValues({ values: {}, reasons: {}, summary: { os: 'darwin', ovis: [] } })
  const db = openDb(':memory:')
  let runs = 0
  const redetect = async () => { runs++; setAutoValues({ values: { 'open_url:main': 'http://127.0.0.1:7317/?pane={pane}' }, reasons: {}, summary: { os: 'darwin', ovis: [{ port: 7317, session: 'main', confirmed: true }] } }) }
  const srv = createBoardServer(db, { redetect })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  const base = `http://127.0.0.1:${srv.address().port}`
  const post = (path, body = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const realNow = Date.now
  try {
    assert.equal((await (await fetch(`${base}/api/autoconf`)).json()).summary.ovis.length, 0, '방금 뜬 서버는 다시 감지하지 않는다')
    assert.equal(runs, 0)
    Date.now = () => realNow() + FIRST_RUN_REDETECT_MS + 1000
    const late = await (await fetch(`${base}/api/autoconf`)).json()
    assert.equal(runs, 1, '안내를 확인하기 전: 시간이 지나 물으면 다시 감지한다')
    assert.equal(late.summary.ovis[0].port, 7317); assert.equal(late.first_run.ask_click, true)
    Date.now = realNow
    await post('/api/first-run', { choices: { click_target: 'both' } })
    Date.now = () => realNow() + 10 * FIRST_RUN_REDETECT_MS
    await fetch(`${base}/api/autoconf`)
    assert.equal(runs, 1, '확인한 뒤에는 저절로 다시 감지하지 않는다')
    const r = await post('/api/autoconf/refresh')
    assert.equal(r.status, 200); assert.equal(runs, 2, '단추로는 언제든 다시 감지한다')
    const body = await r.json()
    assert.equal(body.ok, true); assert.equal(body.chosen.click_target.value, 'both', '사람이 정한 값은 그대로')
    process.env.WHOSUP_READONLY = '1'
    assert.equal((await post('/api/autoconf/refresh')).status, 403)
  } finally { Date.now = realNow; delete process.env.WHOSUP_READONLY; srv.close(); setAutoValues(null) }
  const none = createBoardServer(openDb(':memory:'))
  await new Promise((r) => none.listen(0, '127.0.0.1', r))
  try { assert.equal((await fetch(`http://127.0.0.1:${none.address().port}/api/autoconf/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 503, '다시 감지할 방법이 없으면 503') } finally { none.close() }
})
