// 맥북에어 첫 설치 걷기(커밋 400dcd7)에서 나온 화면 쪽 고칠 것 넷(U1~U4).
//   U1 실패 알림 띠가 화면 왼쪽 절반을 덮는 큰 빨간 상자로 뜬다(.err 와 .toast.err 가 같은 클래스 이름을 쓴다)
//   U2 탭으로만 보여 줄 수 있는 세션(features.focus.means === 'open_url')을 누르거나 새로 열면 앱 창이 다른 세션을 보인 채 앞으로 와 탭을 덮는다
//   U3 첫 실행 안내의 "감지한 환경" 줄에 감지한 앱 코어가 없다(바로 아래 줄은 그 앱의 세션이 보인다고 말한다)
//   U4 새 세션 창에 열 데스크가 하나도 없을 때 아무 설명이 없다
// 이 저장소가 화면을 시험하는 방식 그대로다: 화면(src/board/index.html)의 표시한 덩어리(/*이름*/ … /*/이름*/)와 I18N 을 그대로 읽어 돌리고,
// 화면 배선은 그 함수의 글을 그대로 읽어 화면에 닿는 것(탭·알림·요청)만 가짜로 바꿔 돌린다. 브라우저·서버·앱은 띄우지 않는다.
// 코어 이름·앱 이름은 시험이 지어낸 것이다(deskcore·Deskview) — 화면 코드는 어떤 이름도 알고 있지 않다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
// 덩어리는 표식 한 쌍 사이의 글이다. 표식이 하나씩이고 순서가 맞아야 화면이 쓰는 그 코드를 시험하는 것이다.
const block = (name) => {
  const [a, b] = [`/*${name}*/`, `/*/${name}*/`]
  assert.equal(html.split(a).length, 2, `${a} 하나`); assert.equal(html.split(b).length, 2, `${b} 하나`)
  assert.ok(html.indexOf(a) < html.indexOf(b))
  return html.slice(html.indexOf(a), html.indexOf(b))
}
const between = (from, to) => { const i = html.indexOf(from), j = html.indexOf(to, i); assert.ok(i > 0 && j > i, `${from} … ${to}`); return html.slice(i, j) }
const web = new Function(`${block('weburl')}; return { tabOnly, openUrlOf, openUrlTemplateFor, clickPlanOf, shownReply }`)()
const later = new Function(`${block('weburl')}\n${block('latertab')}; return { deskProbe, laterTabPlan, laterTabUrl, laterTabEnd, tabReply, coreShowOf, withCoreShow }`)()
const appcore = new Function(`${block('appcore')}; return { newOffLines, newNoDeskLines }`)()
const origin = new Function(`${block('origin')}; return { envCoreLines, envSummaryParts, envAppParts }`)()
const store = (o) => (k) => (Object.hasOwn(o, k) ? o[k] : null)

const CORE = 'deskcore', APP = 'Deskview'
const DESK = `core:${CORE}@sp1`
const paneUrl = (port, pane) => `http://127.0.0.1:${port}/?pane=${pane}&view=terminal`
const TEMPLATE = (port) => `http://127.0.0.1:${port}/?pane={pane}&view=terminal`
// 되는 기능: 그 앱이 켜져 있다(이동의 수단이 그 세션의 웹 주소) / 꺼져 있다(앱 창뿐) / Herdr 앱이 다루는 코어(앱 안의 그 세션으로 보낸다)
const how = (means, reason) => (reason ? { means, reason } : { means })
const ON = { new: how('server_api'), focus: how('open_url'), close: how('server_api'), resume: how('server_api') }
const OFF = { new: how('none', 'app_required'), focus: how('app_window', 'app_required'), close: how('core_socket'), resume: how('none', 'app_required') }
const APP_CMD = { new: how('app_command'), focus: how('app_command'), close: how('app_command'), resume: how('app_command') }
const appCard = (features = ON, over = {}) => ({ id: 7, runtime: 'herdr-core', ref: `${CORE}/t4`, desk: DESK, desk_label: `${APP} · work`, pane: 't4', caps: ['focus', 'close', 'resume', 'new', 'web'], features, ...over })
const herdrCard = { id: 1, runtime: 'herdr', ref: 'main/w1:p1', desk: 'main', desk_label: 'main', pane: 'w1:p1', caps: ['focus', 'close', 'resume', 'new', 'toggle', 'web'] }
// 이 브라우저의 값: 서버 기본값 그대로(아무도 '세션을 여는 곳'을 고르지 않았다 — 탭으로만 보여 줄 수 있는 세션은 탭으로 연다)
const DEFAULTS = { [`whosup-open-url-core:${CORE}`]: TEMPLATE(48021), 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'on' }
// 이 브라우저에서 '터미널 창'만 골랐다: 탭을 열지 않는다
const TERMINAL_ONLY = { ...DEFAULTS, 'whosup-open-url-app': 'off' }

// ── U1 ──────────────────────────────────────────────────────────────────────────────────────────
test('U1 실패 알림 띠: .toast.err 는 끊김 표시 줄(.err)의 top·left 를 되돌린다 — 보통 알림처럼 오른쪽 아래에 머문다', () => {
  const ruleOf = (sel) => { const m = css.match(new RegExp(`(?:^|[}\\n])${sel.replace(/\./g, '\\.')}\\{([^}]*)\\}`)); assert.ok(m, `${sel} 규칙`); return Object.fromEntries(m[1].split(';').filter(Boolean).map((d) => { const i = d.indexOf(':'); return [d.slice(0, i).trim(), d.slice(i + 1).trim()] })) }
  const err = ruleOf('.err'), toast = ruleOf('.toast'), bad = ruleOf('.toast.err')
  // 원인: 끊김 표시 줄이 같은 클래스 이름(err)으로 위·왼쪽을 잡는다. 알림 띠는 오른쪽·아래만 잡으므로 그 둘이 섞여 들어온다
  assert.equal(err.position, 'absolute'); assert.ok(err.top && err.left, '.err 가 top·left 를 잡는다(이 시험이 지키는 겹침)')
  assert.deepEqual([toast.position, toast.right, toast.bottom, toast.top, toast.left], ['fixed', '24px', '24px', undefined, undefined])
  // 고침: 실패 알림은 그 둘을 되돌린다
  assert.deepEqual([bad.top, bad.left], ['auto', 'auto'])
  assert.ok(bad.background && bad.color, '실패 색은 그대로')
  assert.equal(bad.position, undefined, '자리 잡는 방식은 .toast 것 그대로(fixed)')
  // 알림 띠는 실패일 때 그 두 클래스를 함께 단다(toast 함수) — 규칙이 닿는 자리다
  assert.match(html, /el\.className = `toast on\$\{bad \? ' err' : ''\}`/)
  assert.match(html, /<div class="err" id="err" hidden><\/div>/)
})

// ── U2 (a)(b) 세션 누르기 ───────────────────────────────────────────────────────────────────────
test('U2 클릭 계획: 탭으로만 보여 줄 수 있는 세션을 탭으로 여는 클릭은 앱 창을 올리지 않는다. 열 탭이 없으면 예전 그대로 앱 창을 올린다. 다른 세션은 그대로다', () => {
  const plan = (card, saved) => web.clickPlanOf(card, store(saved), Object.keys(saved))
  const url = paneUrl(48021, 't4')
  // (a) 탭으로만 + 열 주소가 있다: 어느 방식을 골랐든 창을 올리지 않는다(앱 창은 다른 세션을 보인 채 방금 연 탭을 덮는다)
  assert.deepEqual(plan(appCard(ON), DEFAULTS), { url, raise: false }, '아무도 고르지 않았다')
  assert.deepEqual(plan(appCard(ON), { ...DEFAULTS, 'whosup-open-url-on': 'on', 'whosup-raise': 'on', 'whosup-open-url-app': 'off' }), { url, raise: false }, '둘 다')
  assert.deepEqual(plan(appCard(ON), { ...DEFAULTS, 'whosup-open-url-on': 'on', 'whosup-raise': 'off', 'whosup-open-url-app': 'off' }), { url, raise: false }, '웹 터미널만')
  // (b) 탭으로만인데 열 주소가 없다(이 브라우저에서 터미널 창만 골랐다 / 내려 준 주소가 없다): 예전 그대로 앱 창을 올린다
  assert.deepEqual(plan(appCard(ON), TERMINAL_ONLY), { url: '', raise: true })
  assert.deepEqual(plan(appCard(ON), { 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' }), { url: '', raise: true })
  // 탭으로만이 아닌 세션은 그대로다: 그 앱이 꺼져 있다(수단이 앱 창) · Herdr 앱이 다루는 코어 · herdr 세션
  assert.deepEqual(plan(appCard(OFF), DEFAULTS), { url: '', raise: true })
  const appCmd = appCard(APP_CMD, { ref: 'default/t4', desk: 'core:spA' })
  const deskUrl = { 'whosup-open-url:core:spA': 'http://127.0.0.1:48030/?pane={pane}' }
  assert.deepEqual(plan(appCmd, { ...deskUrl, 'whosup-open-url-on': 'on', 'whosup-raise': 'on' }), { url: 'http://127.0.0.1:48030/?pane=t4', raise: true }, 'Herdr 앱 세션 · 둘 다')
  assert.deepEqual(plan(appCmd, { ...deskUrl, 'whosup-open-url-on': 'on', 'whosup-raise': 'off' }), { url: 'http://127.0.0.1:48030/?pane=t4', raise: false }, 'Herdr 앱 세션 · 웹 터미널만')
  assert.deepEqual(plan(appCmd, { ...deskUrl, 'whosup-open-url-on': 'off' }), { url: '', raise: true }, 'Herdr 앱 세션 · 터미널 창')
  const herdrUrl = { 'whosup-open-url': 'http://127.0.0.1:48031/?pane={pane}' }
  assert.deepEqual(plan(herdrCard, { ...herdrUrl, 'whosup-open-url-on': 'on', 'whosup-raise': 'on' }), { url: 'http://127.0.0.1:48031/?pane=w1%3Ap1', raise: true }, 'herdr 세션 · 둘 다')
  assert.deepEqual(plan(herdrCard, { ...herdrUrl, 'whosup-open-url-on': 'on', 'whosup-raise': 'off' }), { url: 'http://127.0.0.1:48031/?pane=w1%3Ap1', raise: false }, 'herdr 세션 · 웹 터미널만')
  assert.deepEqual(plan(herdrCard, { ...herdrUrl, 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' }), { url: '', raise: true }, 'herdr 세션 · 터미널 창')
  // 가리는 것은 되는 기능(features)뿐이다: 런타임 이름·앱 이름이 달라도 같은 답
  assert.deepEqual(plan(appCard(ON, { desk_label: 'Something else · x' }), DEFAULTS), { url, raise: false })
  assert.doesNotMatch(block('weburl') + block('latertab'), new RegExp(`${APP}|Ovis|ovis`), '화면 코드는 앱 이름을 알고 있지 않다')
})

test('U2 누른 결과의 문구: 창을 올리지 않고 탭으로 연 세션은 "브라우저 탭으로 열었다"와 그 까닭을 말한다 — 앱 창을 올렸다고 말하지 않는다', () => {
  const u = paneUrl(48021, 't4')
  // 서버는 창을 올리지 말라는 클릭(raise:false)에 code 'focused' · window 'skipped' 로 답하고, 그 앱의 서버가 살아 있으면 그 세션의 주소를 싣는다
  // (src/board/server.mjs openSession · src/runtime/core.mjs focus — test/ovis-app.test.mjs·test/cores.test.mjs 가 그 답을 지킨다)
  const quiet = { ok: true, code: 'focused', window: 'skipped', url: u }
  assert.equal(web.shownReply(quiet, true).code, 'focused_tab_only')
  assert.equal(web.shownReply(quiet, true).url, u, '답의 나머지는 그대로')
  assert.equal(web.shownReply(quiet, false).code, 'focused', '탭이 열리지 않았으면 탭으로 열었다고 말하지 않는다')
  assert.equal(web.shownReply({ ok: true, code: 'focused', window: 'skipped' }, true).code, 'focused', '그 앱의 서버가 없다(주소 없음)')
  assert.equal(web.shownReply({ ok: true, code: 'focused', window: 'raised', url: u }, true).code, 'focused', '창을 올린 답은 그대로')
  assert.equal(web.shownReply({ ok: true, code: 'focused', url: u }, true).code, 'focused')
  assert.equal(web.shownReply({ ok: false, code: 'focused', window: 'skipped', url: u }, true).code, 'focused')
  // 예전 답의 바꿈은 그대로다
  assert.equal(web.shownReply({ ok: true, code: 'focused_app_only', url: u }, true).code, 'focused_app_tab')
  assert.equal(web.shownReply({ ok: true, code: 'app_closed', url: u }, true).code, 'focused_tab')
  for (const [lang, T] of Object.entries(I18N)) {
    const text = T.codes.focused_tab_only
    assert.equal(typeof text, 'string', lang)
    assert.match(text, lang === 'ko' ? /브라우저 탭으로 열었습니다/ : /in a browser tab/, lang)
    assert.match(text, lang === 'ko' ? /밖에서 세션을 골라 줄 수 없어/ : /cannot be told from outside which session to show/, `${lang}: 까닭`)
    assert.doesNotMatch(text, /창을 앞으로|올렸|올리고|brought|forward|window/, `${lang}: 앱 창을 올렸다고 말하지 않는다`)
  }
  assert.match(I18N.ko.codes.focused_tab_only, /[가-힣]/); assert.doesNotMatch(I18N.en.codes.focused_tab_only, /[가-힣]/)
})

test('U2 화면의 세션 누르기(openCard): 탭으로만 보여 줄 수 있는 세션은 탭을 열고 raise:false 로 보낸 뒤 탭으로 열었다고 알린다. 터미널 창만 고른 사람은 예전 그대로다', async () => {
  const src = between('async function openCard(id) {', 'async function doAct(')
  const press = async (card, saved, reply, { blocked = false } = {}) => {
    const sent = [], opened = [], toasts = []
    const env = {
      CLIENT_ID: 'tab-1', can: () => true, denied: () => {}, cardById: () => card, refresh: () => {}, msgOf: (d) => d.code, T: { going: 'going', popupBlocked: 'blocked' }, board: { readonly: false }, openedTabs: new Map(),
      toast: (t, bad) => toasts.push([t, Boolean(bad)]), portFixedUrl: () => '', shownReply: web.shownReply,
      clickPlan: (c) => web.clickPlanOf(c, store(saved), Object.keys(saved)),
      openTab: (desk, url) => { opened.push([desk, url]); return blocked ? { ok: false } : { ok: true, fresh: true, win: { location: { replace() {} } } } },
      post: async (path, body) => { sent.push([path, body]); return reply },
    }
    await new Function(...Object.keys(env), `let clickN = 0; ${src}; return openCard`)(...Object.values(env))(7)
    return { path: sent[0][0], body: sent[0][1], opened, last: toasts.at(-1) }
  }
  const u = paneUrl(48021, 't4')
  // (a) 탭을 열고, 서버에는 창을 올리지 말라고 한다. 서버의 답(focused · skipped)을 탭으로 열었다는 문구로 알린다
  let r = await press(appCard(ON), DEFAULTS, { ok: true, data: { ok: true, code: 'focused', window: 'skipped', url: u } })
  assert.deepEqual([r.path, r.body.raise, r.body.web, r.opened, r.last], ['/api/open', false, true, [[DESK, u]], ['focused_tab_only', false]])
  // 탭이 막혔으면 예전처럼 막혔다고 알린다(창은 올리지 않는다 — 계획은 탭을 열기 전에 정한다)
  r = await press(appCard(ON), DEFAULTS, { ok: true, data: { ok: true, code: 'focused', window: 'skipped', url: u } }, { blocked: true })
  assert.deepEqual([r.body.raise, r.body.web, r.last], [false, false, ['blocked', true]])
  // (b) 터미널 창만 고른 사람: 탭을 열지 않고 앱 창을 올려 달라고 한다. 앱 창만 올렸다는 답 그대로다
  r = await press(appCard(ON), TERMINAL_ONLY, { ok: true, data: { ok: true, code: 'focused_app_only', app: APP, url: u } })
  assert.deepEqual([r.body.raise, r.body.web, r.opened, r.last], [true, false, [], ['focused_app_only', false]])
})

// ── U2 (c) 새 세션·이어서 열기·에이전트 시작 ───────────────────────────────────────────────────
test('U2 주소를 나중에 아는 탭 — 그 데스크에 열릴 세션을 대신할 카드(deskProbe)와 누르는 순간의 계획(laterTabPlan)', () => {
  const cores = [{ name: 'default', app: null, features: APP_CMD }, { name: CORE, app: APP, features: ON }, { name: 'offcore', app: 'Other', features: OFF }]
  // 같은 데스크의 카드가 판에 있으면 그 카드다(되는 기능·주소 틀이 같다)
  const card = appCard(ON)
  assert.equal(later.deskProbe(DESK, cores, [herdrCard, card]), card)
  // 없으면 데스크 열쇠에 적힌 코어를 cores 에서 찾아 만든다 — "그 앱에 새 데스크" 자리(core:<코어>@)도 같다
  const made = later.deskProbe(`core:${CORE}@`, cores, [herdrCard])
  assert.deepEqual([made.desk, made.features, web.tabOnly(made)], [`core:${CORE}@`, ON, true])
  assert.equal(web.openUrlTemplateFor(made, store(DEFAULTS)), TEMPLATE(48021), '그 코어의 주소 틀을 찾는다')
  assert.equal(later.deskProbe(`core:${CORE}@sp9`, cores, []).features, ON)
  // 못 찾으면 null: herdr 데스크 · 기본 코어의 데스크(열쇠에 코어 이름이 없다) · 모르는 코어 · 값 없음
  for (const d of ['main', 'core:spA', 'core:', 'core:nobody@sp1', '', null, undefined]) assert.equal(later.deskProbe(d, cores, [herdrCard]), null, String(d))
  assert.equal(later.deskProbe(`core:${CORE}@`, undefined, undefined), null)

  // 계획: 탭으로만 보여 줄 수 있는 세션이고 이 브라우저가 그 세션을 탭으로 열 때만 탭을 잡고, 그때만 raise:false 다
  assert.deepEqual(later.laterTabPlan(made, store(DEFAULTS)), { tab: true, raise: false })
  assert.deepEqual(later.laterTabPlan(card, store(DEFAULTS)), { tab: true, raise: false })
  assert.deepEqual(later.laterTabPlan(made, store(TERMINAL_ONLY)), { tab: false, raise: undefined }, '터미널 창만 고른 사람: 예전 그대로(앱 창)')
  assert.deepEqual(later.laterTabPlan(made, store({ 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' })), { tab: false, raise: undefined }, '주소 틀이 없다')
  assert.deepEqual(later.laterTabPlan(later.deskProbe('core:offcore@', cores, []), store(DEFAULTS)), { tab: false, raise: undefined }, '그 앱이 꺼져 있다')
  assert.deepEqual(later.laterTabPlan(herdrCard, store({ 'whosup-open-url': 'http://127.0.0.1:48031/?pane={pane}', 'whosup-open-url-on': 'on' })), { tab: false, raise: undefined }, 'herdr 세션은 닿지 않는다')
  assert.deepEqual(later.laterTabPlan(null, store(DEFAULTS)), { tab: false, raise: undefined })
  // 세션을 누를 때와 같은 조건이다: 탭을 잡는 것과 클릭 계획이 raise:false 로 탭을 여는 것이 늘 같이 간다
  for (const saved of [DEFAULTS, TERMINAL_ONLY, { ...DEFAULTS, 'whosup-open-url-on': 'on', 'whosup-open-url-app': 'off' }]) {
    const click = web.clickPlanOf(card, store(saved), Object.keys(saved))
    assert.equal(later.laterTabPlan(card, store(saved)).tab, Boolean(click.url) && click.raise === false, JSON.stringify(saved))
  }
})

test('U2 주소를 나중에 아는 탭 — 보낼 주소(laterTabUrl), 답이 온 뒤 할 일(laterTabEnd), 탭으로 열었다는 답(tabReply)', () => {
  const told = paneUrl(48055, 't9')
  // 틀과 호스트가 같으면 서버가 알려 준 주소 그대로다(자동 감지가 아는 포트가 낡았어도 맞는 포트로 간다)
  assert.equal(later.laterTabUrl(told, TEMPLATE(48021)), told)
  assert.equal(later.laterTabUrl(told, TEMPLATE(48055)), told)
  // 사람이 적어 둔 다른 호스트의 주소(터널 등): 그 틀에 그 세션의 id 를 채운다 — 이 브라우저는 127.0.0.1 주소에 닿지 못할 수 있다
  assert.equal(later.laterTabUrl(told, 'https://desk.example.test/?pane={pane}&view=terminal'), 'https://desk.example.test/?pane=t9&view=terminal')
  assert.equal(later.laterTabUrl(paneUrl(48055, 'a%2Fb'), 'https://desk.example.test/?x=1&pane={pane}'), 'https://desk.example.test/?x=1&pane=a%2Fb')
  // 틀에서 세션 id 를 읽을 자리를 모르면(경로에 넣는 틀, 데스크 이름까지 넣는 틀) 보내지 않는다 — 그 세션은 판에 생기고 누르면 그 틀로 열린다
  assert.equal(later.laterTabUrl(told, 'https://desk.example.test/t/{pane}'), '')
  assert.equal(later.laterTabUrl(told, 'https://desk.example.test/{session}?pane={pane}'), '')
  assert.equal(later.laterTabUrl(told, 'https://desk.example.test/?id={pane}'), '', '서버의 주소에 그 이름의 값이 없다')
  // 주소가 없거나 주소가 아니면 보내지 않는다
  for (const bad of [undefined, null, '', 'not a url', 'javascript:alert(1)', 'file:///etc/passwd']) assert.equal(later.laterTabUrl(bad, TEMPLATE(48021)), '', String(bad))
  for (const bad of [undefined, '', 'http://127.0.0.1:48021/', 'ftp://x/{pane}']) assert.equal(later.laterTabUrl(told, bad), '', String(bad))

  // 답이 온 뒤: 됐고 주소가 있으면 그 주소로, 실패했거나 주소가 없으면 새로 연 빈 탭은 닫고 전부터 있던 탭은 그대로 둔다
  assert.deepEqual(later.laterTabEnd({ want: true, held: true, fresh: true, ok: true, url: told }), { act: 'go', url: told, shown: true, blocked: false })
  assert.deepEqual(later.laterTabEnd({ want: true, held: true, fresh: false, ok: true, url: told }), { act: 'go', url: told, shown: true, blocked: false })
  assert.deepEqual(later.laterTabEnd({ want: true, held: true, fresh: true, ok: false, url: told }), { act: 'close', url: '', shown: false, blocked: false }, '요청 실패')
  assert.deepEqual(later.laterTabEnd({ want: true, held: true, fresh: true, ok: true, url: '' }), { act: 'close', url: '', shown: false, blocked: false }, '주소 없음')
  assert.deepEqual(later.laterTabEnd({ want: true, held: true, fresh: false, ok: false, url: '' }), { act: 'leave', url: '', shown: false, blocked: false }, '전부터 있던 탭은 닫지 않는다')
  // 브라우저가 탭을 막았다: 할 일이 없고, 막혔다고 알린다
  assert.deepEqual(later.laterTabEnd({ want: true, held: false, fresh: false, ok: true, url: told }), { act: 'none', url: '', shown: false, blocked: true })
  // 탭을 잡으려 하지 않았다(다른 세션): 아무것도 하지 않는다
  assert.deepEqual(later.laterTabEnd({ want: false, held: false, ok: true, url: told }), { act: 'none', url: '', shown: false, blocked: false })
  assert.deepEqual(later.laterTabEnd(), { act: 'none', url: '', shown: false, blocked: false })

  // 탭으로 보여 준 결과의 답: 성공 문구 셋만 바꾼다
  assert.deepEqual(['opened_new', 'resumed', 'started'].map((code) => later.tabReply({ ok: true, code, url: told }).code), ['opened_new_tab', 'resumed_tab', 'started_tab'])
  assert.equal(later.tabReply({ ok: true, code: 'resumed', url: told, resumed: true }).resumed, true, '답의 나머지는 그대로')
  for (const d of [{ ok: false, code: 'opened_new' }, { ok: true, code: 'busy' }, { ok: true, code: 'toString' }, { ok: true }, null, undefined]) assert.equal(later.tabReply(d), d)
  const base = { opened_new_tab: 'opened_new', resumed_tab: 'resumed', started_tab: 'started' }
  for (const [lang, T] of Object.entries(I18N)) for (const [code, from] of Object.entries(base)) {
    const text = T.codes[code]
    assert.equal(typeof text, 'string', `${lang} ${code}`)
    assert.ok(text.startsWith(T.codes[from]), `${lang} ${code}: 예전 성공 문구로 시작한다(${T.codes[from]})`)
    assert.match(text, lang === 'ko' ? /브라우저 탭으로 열었습니다/ : /opened in a browser tab/, `${lang} ${code}`)
    assert.match(text, lang === 'ko' ? /밖에서 세션을 골라 줄 수 없어/ : /cannot be told from outside which session to show/, `${lang} ${code}: 까닭`)
    assert.doesNotMatch(text, /창|window|칸|pane|카드/i, `${lang} ${code}`)
    assert.equal(/[가-힣]/.test(text), lang === 'ko', `${lang} ${code}`)
  }
})

// 가짜 탭·가짜 창: 주소와 닫힘만 기억한다
const fakeTab = (href = 'about:blank') => {
  const t = { closed: false, focused: 0, went: [], document: { title: '', body: { textContent: '' } }, focus() { t.focused += 1 }, close() { t.closed = true } }
  t.location = { href, replace(u) { t.went.push(u); t.location.href = u } }
  return t
}
const fakeWindow = ({ blocked = false, named = {} } = {}) => {
  const w = { calls: [], made: [], open(url, name) { w.calls.push([url, name]); if (blocked) return null; if (named[name]) return named[name]; const t = fakeTab(); w.made.push(t); return t } }
  return w
}

test('U2 탭 잡아 두기(holdTab): 주소 없이 빈 탭을 열고, 그 데스크의 탭이 이미 있으면 건드리지 않고 그 탭을 쓴다. 막히면 ok:false', () => {
  const tabs = (window) => new Function('window', `${block('webtab')}; return { holdTab, openTab, openedTabs }`)(window)
  // 새로 연다: 주소는 빈 글자(이름이 같은 탭이 남아 있어도 그 탭을 다른 데로 보내지 않는다), 이름은 세션 누르기와 같은 whosup-<데스크>
  let w = fakeWindow(), p = tabs(w)
  let h = p.holdTab(DESK, 'opening…')
  assert.deepEqual([w.calls, h.ok, h.fresh, h.win === w.made[0], p.openedTabs.get(DESK) === h.win], [[['', `whosup-${DESK}`]], true, true, true, true])
  assert.deepEqual([h.win.document.title, h.win.document.body.textContent, h.win.went], ['opening…', 'opening…', []], '빈 탭에는 여는 중이라고만 적는다')
  // 이 화면이 이미 연 그 데스크의 탭: 다시 열지 않고 그대로 돌려준다(주소도 글도 건드리지 않는다)
  const again = p.holdTab(DESK, 'opening…')
  assert.deepEqual([w.calls.length, again.ok, again.fresh, again.win === h.win], [1, true, false, true])
  // 그 탭이 닫혔으면 새로 연다
  h.win.closed = true
  assert.deepEqual([p.holdTab(DESK).fresh, w.calls.length], [true, 2])
  // 화면을 새로 고친 뒤(기억이 없다) 같은 이름의 탭이 남아 있다: 브라우저가 그 탭을 돌려준다 — 다른 출처로 가 있어 주소를 읽을 수 없다. 새로 연 탭이 아니다
  const old = fakeTab(); Object.defineProperty(old, 'location', { get() { throw new Error('cross-origin') } })
  w = fakeWindow({ named: { [`whosup-${DESK}`]: old } }); p = tabs(w)
  h = p.holdTab(DESK, 'opening…')
  assert.deepEqual([h.ok, h.fresh, h.win === old, old.document.title], [true, false, true, ''])
  // 같은 출처의 다른 주소에 가 있는 탭도 새로 연 탭이 아니다
  const same = fakeTab('http://127.0.0.1:48021/?pane=t1')
  assert.equal(tabs(fakeWindow({ named: { [`whosup-${DESK}`]: same } })).holdTab(DESK).fresh, false)
  // 브라우저가 막았다 / window.open 이 던졌다
  w = fakeWindow({ blocked: true }); p = tabs(w)
  assert.deepEqual([p.holdTab(DESK), p.openedTabs.size], [{ ok: false }, 0])
  assert.deepEqual(tabs({ open() { throw new Error('no') } }).holdTab(DESK), { ok: false })
})

// 화면의 새 세션·이어서 열기 함수를 그대로 읽어, 화면에 닿는 것(탭·알림·요청·판)만 가짜로 바꿔 돌린다
const pageOf = ({ saved = DEFAULTS, board, reply, window = fakeWindow(), newState = { cwd: '/home/me/work', session: `core:${CORE}@` }, card = null }) => {
  const sent = [], toasts = [], log = { closedPeek: 0, refreshed: 0, denied: 0 }
  const env = {
    window, board, newState, lsGet: store(saved), T: { opening: 'opening…', resuming: 'resuming…', agentStarting: 'starting…', popupBlocked: 'blocked' },
    msgOf: (d) => d?.code || 'no-reply', toast: (t, bad) => toasts.push([t, Boolean(bad)]), can: () => true, denied: () => { log.denied += 1 },
    refresh: () => { log.refreshed += 1 }, closePeek: () => { log.closedPeek += 1 }, cardById: (id) => (card && card.id === id ? card : null), allCards: (b) => b.cards || [],
    post: async (path, body) => { sent.push([path, body]); return typeof reply === 'function' ? reply(path, body) : reply },
  }
  const src = [block('weburl'), block('latertab'), block('webtab'), between('async function postWithTab(', 'async function openCard(id) {'),
    between('async function resumeCard(', '/* 새 세션 패널 */'), between('async function createSession() {', "\ndocument.addEventListener('click', async (e) => {")].join('\n')
  const page = new Function(...Object.keys(env), `${src}\nreturn { createSession, resumeCard, openedTabs }`)(...Object.values(env))
  return { ...page, sent, toasts, log, window }
}
const CORES = [{ name: CORE, app: APP, features: ON }]

test('U2 화면의 새 세션(createSession): 탭으로만 보여 줄 수 있는 데스크면 누르는 순간 탭을 잡고 raise:false 로 보낸 뒤, 답의 주소로 그 탭을 보낸다', async () => {
  const told = paneUrl(48055, 't9')
  // 됨: 요청은 raise:false, 빈 탭은 클릭 처리 안에서(첫 await 앞에서) 열리고, 답이 오면 그 주소로 간다. 알림은 탭으로 열었다는 문구
  let p = pageOf({ board: { cores: CORES, cards: [] }, reply: { ok: true, data: { ok: true, code: 'opened_new', url: told, means: 'server_api' } } })
  const going = p.createSession()
  assert.deepEqual(p.window.calls, [['', `whosup-core:${CORE}@`]], '탭은 응답을 기다리기 전에 연다(await 뒤에 열면 브라우저가 팝업으로 막는다)')
  assert.deepEqual(p.window.made[0].went, [], '주소는 아직 모른다')
  await going
  assert.deepEqual(p.sent, [['/api/new', { cwd: '/home/me/work', session: `core:${CORE}@`, raise: false }]])
  const tab = p.window.made[0]
  assert.deepEqual([tab.went, tab.closed, tab.focused > 0], [[told], false, true])
  assert.deepEqual([p.toasts.at(-1), p.log.closedPeek, p.log.refreshed], [['opened_new_tab', false], 1, 1])
  // 요청 실패(없는 폴더 등): 방금 연 빈 탭을 닫고 실패를 알린다. 새 세션 창은 닫지 않는다
  p = pageOf({ board: { cores: CORES, cards: [] }, reply: { ok: false, data: { ok: false, code: 'no_folder' } } })
  await p.createSession()
  assert.deepEqual([p.window.made[0].closed, p.window.made[0].went, p.openedTabs.size, p.toasts.at(-1), p.log.closedPeek], [true, [], 0, ['no_folder', true], 0])
  // 됐는데 답에 주소가 없다: 빈 탭을 닫고 보통 성공 문구로 알린다(탭으로 열었다고 말하지 않는다)
  p = pageOf({ board: { cores: CORES, cards: [] }, reply: { ok: true, data: { ok: true, code: 'opened_new' } } })
  await p.createSession()
  assert.deepEqual([p.window.made[0].closed, p.toasts.at(-1), p.log.closedPeek], [true, ['opened_new', false], 1])
  // 브라우저가 탭을 막았다: 앱 창은 그래도 올리지 않고, 한 일 뒤에 막혔다고 알린다(실패 색)
  p = pageOf({ board: { cores: CORES, cards: [] }, window: fakeWindow({ blocked: true }), reply: { ok: true, data: { ok: true, code: 'opened_new', url: told } } })
  await p.createSession()
  assert.deepEqual([p.sent[0][1].raise, p.toasts.at(-1), p.log.closedPeek], [false, ['opened_new · blocked', true], 1])
  // 그 데스크의 탭이 이미 열려 있다(같은 데스크의 카드가 판에 있다): 그 탭을 새 세션의 주소로 보낸다. 실패하면 그 탭은 닫지 않는다
  const have = fakeTab('http://127.0.0.1:48021/?pane=t4&view=terminal')
  for (const [reply, went, last] of [[{ ok: true, data: { ok: true, code: 'opened_new', url: told } }, [told], ['opened_new_tab', false]], [{ ok: false, data: { ok: false, code: 'app_required' } }, [], ['app_required', true]]]) {
    have.went.length = 0
    p = pageOf({ board: { cores: CORES, cards: [appCard(ON)] }, newState: { cwd: '/home/me/work', session: DESK }, reply })
    p.openedTabs.set(DESK, have)
    await p.createSession()
    assert.deepEqual([p.window.calls, have.went, have.closed, p.toasts.at(-1)], [[], went, false, last])
  }
})

test('U2 화면의 새 세션: 탭으로만이 아닌 데스크·터미널 창만 고른 브라우저는 예전 그대로다 — 탭을 열지 않고 raise 를 따로 보내지 않는다', async () => {
  const ok = { ok: true, data: { ok: true, code: 'opened_new', url: paneUrl(48055, 't9') } }
  const cases = [
    ['herdr 데스크', { board: { cores: CORES, cards: [herdrCard] }, newState: { cwd: '/w', session: 'main' } }],
    ['Herdr 앱 데스크', { board: { cores: [{ name: 'default', app: null, features: APP_CMD }], cards: [appCard(APP_CMD, { ref: 'default/t1', desk: 'core:spA' })] }, newState: { cwd: '/w', session: 'core:spA' } }],
    ['그 앱이 꺼져 있다', { board: { cores: [{ name: CORE, app: APP, features: OFF }], cards: [] } }],
    ['터미널 창만 고른 브라우저', { board: { cores: CORES, cards: [] }, saved: TERMINAL_ONLY }],
    ['판을 아직 못 받았다', { board: null }],
  ]
  for (const [name, o] of cases) {
    const p = pageOf({ ...o, reply: ok })
    await p.createSession()
    assert.deepEqual(p.window.calls, [], `${name}: 탭을 열지 않는다`)
    assert.equal(Object.hasOwn(p.sent[0][1], 'raise'), false, `${name}: raise 는 이 브라우저의 설정대로(post 가 붙인다)`)
    assert.deepEqual(p.toasts.at(-1), ['opened_new', false], name)
  }
  // 폴더를 고르지 않았으면 아무것도 하지 않는다(탭도 열지 않는다)
  const p = pageOf({ board: { cores: CORES, cards: [] }, newState: { cwd: '  ', session: `core:${CORE}@` }, reply: ok })
  await p.createSession()
  assert.deepEqual([p.window.calls, p.sent], [[], []])
  // post 는 예전처럼 이 브라우저의 값을 먼저 싣고 넘겨받은 값으로 덮는다: raise:false 가 그대로 서버에 간다
  assert.match(html, /body: JSON\.stringify\(\{ raise: raiseOn\(\), \.\.\.body \}\)/)
})

test('U2 화면의 이어서 열기·에이전트 시작(resumeCard): 닫힌 세션·빈 세션이 탭으로만 보여 줄 수 있는 세션이면 새 세션과 같게 한다', async () => {
  const told = paneUrl(48055, 't12')
  // 닫힌 세션(최근 닫힘의 카드): 새 터미널이 생긴다 — 탭을 잡고 raise:false 로 보낸 뒤 답의 주소로 보낸다
  const closed = appCard(ON, { id: 31, closed_at: '2026-11-14T05:00:00Z', reason: 'gone' })
  let p = pageOf({ board: { cores: CORES, cards: [], closed: [closed] }, reply: { ok: true, data: { ok: true, code: 'started', url: told, means: 'server_api' } } })
  const going = p.resumeCard(31, null)
  assert.deepEqual(p.window.calls, [['', `whosup-${DESK}`]], '클릭 처리 안에서 연다')
  await going
  assert.deepEqual([p.sent, p.window.made[0].went, p.toasts.at(-1)], [[['/api/resume', { id: 31, sid: null, raise: false }]], [told], ['started_tab', false]])
  // 빈 세션(판의 카드)에서 대화를 이어서 열기
  const shell = appCard(ON, { id: 7, status: 'shell' })
  p = pageOf({ board: { cores: CORES, cards: [shell] }, card: shell, reply: { ok: true, data: { ok: true, code: 'resumed', url: paneUrl(48021, 't4'), resumed: true } } })
  await p.resumeCard(7, 'abc')
  assert.deepEqual([p.sent[0][1], p.window.made[0].went, p.toasts.at(-1)], [{ id: 7, sid: 'abc', raise: false }, [paneUrl(48021, 't4')], ['resumed_tab', false]])
  // 실패(그 대화가 바뀌었다 등): 빈 탭을 닫는다
  p = pageOf({ board: { cores: CORES, cards: [], closed: [closed] }, reply: { ok: false, data: { ok: false, code: 'resume_changed' } } })
  await p.resumeCard(31, 'abc')
  assert.deepEqual([p.window.made[0].closed, p.toasts.at(-1)], [true, ['resume_changed', true]])
  // 다른 세션(herdr 세션·그 앱이 꺼져 있다·터미널 창만 고른 브라우저)과 모르는 번호는 예전 그대로다
  for (const [name, o] of [
    ['herdr 세션', { card: { ...herdrCard, id: 7 } }], ['그 앱이 꺼져 있다', { card: appCard(OFF) }], ['터미널 창만', { card: appCard(ON), saved: TERMINAL_ONLY }], ['모르는 번호', { card: null }],
  ]) {
    p = pageOf({ board: { cores: CORES, cards: [], closed: [] }, ...o, reply: { ok: true, data: { ok: true, code: 'resumed', url: told } } })
    await p.resumeCard(7, 'abc')
    assert.deepEqual([p.window.calls, p.sent[0], p.toasts.at(-1)], [[], ['/api/resume', { id: 7, sid: 'abc' }], ['resumed', false]], name)
  }
})

// ── U2 (d) · U3 감지한 환경 ─────────────────────────────────────────────────────────────────────
test('U2 감지한 환경의 앱 코어 한 줄: 탭으로만 보여 줄 수 있는 코어는 "브라우저 탭으로 열린다"고 말한다 — 되는 기능으로 가리고, 모르면 누르면 어떻게 되는지는 말하지 않는다', () => {
  const live = [{ name: CORE, app: APP, features: ON }, { name: 'offcore', app: 'Other', features: OFF }, { name: 'default', app: null, features: APP_CMD }]
  // 그 코어의 세션을 누르면 무엇이 보이는가
  assert.equal(later.coreShowOf(live[0], store(DEFAULTS)), 'tab')
  assert.equal(later.coreShowOf(live[0], store(TERMINAL_ONLY)), 'app', '터미널 창만 고른 브라우저: 앱 창이 앞으로 온다(예전 그대로)')
  assert.equal(later.coreShowOf(live[0], store({ 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' })), 'app', '주소 틀이 없다')
  assert.equal(later.coreShowOf(live[1], store(DEFAULTS)), 'app', '그 앱이 꺼져 있다(수단이 앱 창)')
  for (const c of [undefined, null, {}, { name: CORE }, { name: CORE, features: {} }, { features: ON }]) assert.equal(later.coreShowOf(c, store(DEFAULTS)), 'unknown')
  // 이름이 달라도 되는 기능이 같으면 같은 답이다(앱 이름·코어 이름으로 가리지 않는다)
  const tpl = (n) => ({ ...DEFAULTS, [`whosup-open-url-core:${n}`]: TEMPLATE(48021) })
  assert.equal(later.coreShowOf({ name: 'anything', app: 'Whatever', features: ON }, store(tpl('anything'))), 'tab')

  const summary = { os: 'darwin', cores: [{ name: CORE, app: APP, web: true }, { name: 'offcore', app: 'Other', web: false }, { name: 'gone', app: 'Gone', web: true }, { name: 'noapp', app: null, web: true }] }
  const s = later.withCoreShow(summary, live, store(DEFAULTS))
  assert.deepEqual(s.cores.map((c) => c.show), ['tab', 'app', 'unknown', 'unknown'])
  assert.equal(summary.cores[0].show, undefined, '받은 요약은 고치지 않는다'); assert.equal(s.os, 'darwin')
  assert.deepEqual([later.withCoreShow(null, live, store(DEFAULTS)), later.withCoreShow({ os: 'linux' }, live, store(DEFAULTS))], [null, { os: 'linux' }])
  assert.deepEqual(later.withCoreShow(summary, undefined, store(DEFAULTS)).cores.map((c) => c.show), ['unknown', 'unknown', 'unknown', 'unknown'], '판의 cores 를 못 받았다')

  for (const [lang, T] of Object.entries(I18N)) {
    const [tab, app, gone, noapp] = origin.envCoreLines(s, T)
    assert.equal(tab, T.envCoreSeen(CORE, APP, 'tab'))
    assert.match(tab, lang === 'ko' ? /브라우저 탭으로 열립니다/ : /opens the session in a browser tab/, lang)
    assert.doesNotMatch(tab, /창이 앞으로|to the front|window/, `${lang}: 앱 창이 앞으로 온다고 약속하지 않는다`)
    assert.match(app, lang === 'ko' ? /Other 창이 앞으로 옵니다/ : /brings the Other window to the front/, `${lang}: 앱 창이 수단인 코어는 예전 문구`)
    assert.equal(gone, T.envCoreSeen('gone', 'Gone', 'unknown'))
    assert.doesNotMatch(gone, /누르면|click|탭|tab|창|window/i, `${lang}: 모르면 세션이 보인다는 말만 한다`)
    assert.match(gone, /Gone/); assert.match(noapp, /"noapp"/, '앱 이름을 못 찾았으면 코어 이름으로')
    for (const line of [tab, app, gone]) assert.match(line, lang === 'ko' ? /세션도 보드에 보입니다/ : /show on the board too/, lang)
    // 요약에 show 가 없으면(설치 터미널과 글자를 맞추는 예전 호출) 예전 문구 그대로다
    assert.deepEqual(origin.envCoreLines(summary, T), [T.envCoreSeen(CORE, APP), T.envCoreSeen('offcore', 'Other'), T.envCoreSeen('gone', 'Gone'), T.envCoreSeen('noapp', '')])
    assert.equal(T.envCoreSeen(CORE, APP), T.envCoreSeen(CORE, APP, 'app'))
    assert.equal(/[가-힣]/.test(tab + gone), lang === 'ko')
    assert.doesNotMatch(tab + app + gone, /칸|카드|pane/)
  }
  // 화면: 감지한 환경 요약이 판의 "되는 기능"과 이 브라우저의 값으로 show 를 적은 요약을 쓴다(첫 실행 안내와 설정이 같이 쓴다)
  const fn = between('function envSummaryHtml(v, withReopen, firstRun = false) {', '\nlet frPick = {}')
  assert.match(fn, /const s = withCoreShow\(v\?\.summary \|\| null, board\?\.cores, lsGet\)/)
  assert.match(fn, /envCoreLines\(s, T\)/); assert.match(fn, /envSummaryParts\(s, T, \{ firstRun \}\)/)
})

test('U3 감지한 환경 요약 항목: 감지한 앱 코어를 앱 이름으로 싣는다 — "ovis 없음"(웹 터미널) 옆에 그 앱이 있다고 나와, 아래 줄과 어긋나지 않는다', () => {
  const base = { os: 'darwin', desktop: true, terminal: 'Terminal', herdr: { found: false }, herdr_core: { running: false, view_only: false }, herdr_app: { found: false }, ovis: [] }
  for (const [lang, T] of Object.entries(I18N)) {
    // 실기기의 모습: herdr 없음, 웹 터미널 없음, 자기 코어를 띄우는 앱 하나(그 앱의 서버가 답했다)
    const parts = origin.envSummaryParts({ ...base, cores: [{ name: CORE, app: APP, web: true }] }, T)
    const map = Object.fromEntries(parts)
    const label = T.envAppOf(APP)
    assert.equal(label, lang === 'ko' ? `${APP} 앱` : `${APP} app`)
    assert.equal(map[label], lang === 'ko' ? '있음 · 실행 중' : 'found · running', lang)
    assert.equal(map[T.envOvis], T.envNone, `${lang}: ovis(웹 터미널) 항목의 뜻은 그대로다`)
    assert.equal(map[T.envApp], T.envNone, `${lang}: Herdr 앱 항목도 그대로`)
    const names = parts.map(([k]) => k)
    assert.deepEqual(names, [T.envOs, T.envTerm, T.envHerdr, T.envApp, label, T.envOvis, T.envRemote], `${lang}: 앱 항목은 ovis 항목 앞에`)
    // 아래 줄이 말하는 앱이 위 항목에도 있다
    assert.ok(origin.envCoreLines({ cores: [{ name: CORE, app: APP, web: true }] }, T)[0].includes(APP) && label.includes(APP))
    // 그 앱의 서버가 답하지 않았다(웹 주소 없음): 있다고만 적는다
    assert.equal(Object.fromEntries(origin.envSummaryParts({ ...base, cores: [{ name: CORE, app: APP, web: false }] }, T))[label], lang === 'ko' ? '있음' : 'found')
    // 같은 앱의 코어가 둘이면 한 번(하나라도 답했으면 실행 중), 앱 이름을 못 찾은 코어는 항목으로 싣지 않는다(아래 줄이 코어 이름으로 말한다)
    const many = origin.envSummaryParts({ ...base, cores: [{ name: 'a', app: APP, web: false }, { name: 'b', app: APP, web: true }, { name: 'c', app: null, web: true }, { name: 'd', app: 'Other', web: false }, null, { name: 'e', app: '  ' }] }, T)
    assert.deepEqual(many.slice(4, -2), [[T.envAppOf(APP), T.envAppFound(true)], [T.envAppOf('Other'), T.envAppFound(false)]])
    // 이미 있는 항목과 이름이 같아지면 두 번 적지 않는다
    const taken = T.envApp.replace(lang === 'ko' ? / 앱$/ : / app$/, '')
    assert.equal(origin.envSummaryParts({ ...base, cores: [{ name: 'x', app: taken, web: true }] }, T).length, 6, `${lang}: ${T.envAppOf(taken)}`)
    // 첫 실행 안내(firstRun): 세션을 띄울 곳(여기서는 그 앱)을 찾았으니 '없음' 항목(herdr 데스크 · Herdr 앱 · ovis)은 싣지 않는다 — 설정은 그대로 다 싣는다
    const fr = origin.envSummaryParts({ ...base, cores: [{ name: CORE, app: APP, web: true }] }, T, { firstRun: true })
    assert.deepEqual(fr.map(([k]) => k), [T.envOs, T.envTerm, label, T.envRemote], `${lang}: 첫 실행 안내는 없음 항목을 뺀다`)
    assert.ok(fr.every(([, v]) => v !== T.envNone))
    // 앱 코어가 없으면 예전 그대로 여섯 항목이다
    assert.equal(origin.envSummaryParts(base, T).length, 6); assert.equal(origin.envSummaryParts({ ...base, cores: [] }, T).length, 6)
    assert.equal(origin.envSummaryParts(null, T).length, 6)
    assert.equal(/[가-힣]/.test(T.envAppOf('X') + T.envAppFound(true) + T.envAppFound(false)), lang === 'ko')
  }
  // 앱 이름은 감지한 값에서만 온다: 요약을 만드는 덩어리에 앱 이름이 박혀 있지 않다
  assert.doesNotMatch(between('function envAppParts(', '// 요약 항목 [이름, 값]'), /Ovis|Herdr|Deskview/)
})

// ── U4 ──────────────────────────────────────────────────────────────────────────────────────────
test('U4 새 세션 창: 열 데스크가 하나도 없으면 "어느 데스크에" 줄에 까닭과 할 일을 한 줄로 말한다', () => {
  const offCores = [{ name: CORE, app: APP, features: OFF }]
  const target = [{ key: 'main', label: 'main' }]
  for (const [lang, T] of Object.entries(I18N)) {
    // 데스크가 없고 꺼져 있는 앱도 모른다(쓰는 앱의 첫 화면을 아직 마치지 않았다 등): 까닭과 할 일을 한 줄에
    for (const none of [[], undefined, null]) assert.deepEqual(appcore.newNoDeskLines(none, [], T), [`${T.newNoDesk} ${T.newNoDeskHow}`], lang)
    assert.deepEqual(appcore.newNoDeskLines([], [{ name: CORE, app: APP, features: ON }], T), [`${T.newNoDesk} ${T.newNoDeskHow}`])
    // 꺼져 있는 앱을 안다: 그 앱의 줄(예전 그대로)이 할 일을 말하므로 까닭만 적는다
    assert.deepEqual(appcore.newNoDeskLines([], offCores, T), [T.newNoDesk], lang)
    assert.deepEqual(appcore.newOffLines(offCores, T), [T.newAppOff(APP)], '꺼져 있는 앱의 줄은 그대로')
    // 데스크가 하나라도 있으면 적지 않는다
    assert.deepEqual([appcore.newNoDeskLines(target, [], T), appcore.newNoDeskLines(target, offCores, T)], [[], []])
    // 문구: 까닭(지금 열 데스크가 없다)과 할 일(앱을 열어 첫 화면을 마치거나 herdr 를 시작), 그 뒤 어디에 나오는지
    assert.match(T.newNoDesk, lang === 'ko' ? /새 세션을 열 수 있는 데스크가 없습니다/ : /no desk that can take a new session/, lang)
    assert.match(T.newNoDeskHow, lang === 'ko' ? /앱을 열어 첫 화면을 마치거나 herdr를 시작/ : /finish its first screen, or start herdr/, lang)
    assert.match(T.newNoDeskHow, lang === 'ko' ? /여기에 나옵니다/ : /shows up here/, lang)
    assert.equal(/[가-힣]/.test(T.newNoDesk + T.newNoDeskHow), lang === 'ko')
    assert.doesNotMatch(T.newNoDesk + T.newNoDeskHow, /칸|카드|pane|Ovis|Deskview/, `${lang}: 화면 말은 세션·데스크, 앱 이름은 적지 않는다`)
  }
  // 화면: "어느 데스크에" 제목 바로 아래, 단추 줄 앞에 그린다. 열기 단추가 꺼지는 조건은 그대로다
  const fn = between('function renderNew() {', '// 웹 터미널 프리셋')
  assert.match(fn, /<div class="sec caps">\$\{T\.which\}<\/div>\$\{newNoDeskLines\(newState\.targets, board\?\.cores, T\)\.map\(\(l\) => `<div class="hint nodesk">\$\{esc\(l\)\}<\/div>`\)\.join\(''\)\}\n\s+<div class="seg">/)
  assert.match(fn, /data-create \$\{newState\.cwd\.trim\(\) && newState\.session \? '' : 'disabled'\}/)
})

test('새 문구는 한국어·영어가 짝으로 있다', () => {
  const keys = ['newNoDesk', 'newNoDeskHow', 'envAppOf', 'envAppFound', 'envCoreSeen']
  const codes = ['focused_tab_only', 'opened_new_tab', 'resumed_tab', 'started_tab']
  for (const k of keys) assert.equal(typeof I18N.ko[k], typeof I18N.en[k], k)
  for (const k of keys) assert.ok(I18N.ko[k] && I18N.en[k], k)
  for (const c of codes) assert.ok(typeof I18N.ko.codes[c] === 'string' && typeof I18N.en.codes[c] === 'string', c)
  assert.deepEqual(Object.keys(I18N.ko.codes).filter((c) => !Object.hasOwn(I18N.en.codes, c)), [], '한국어에만 있는 code 가 없다')
  assert.deepEqual(Object.keys(I18N.en.codes).filter((c) => !Object.hasOwn(I18N.ko.codes, c)), [], '영어에만 있는 code 가 없다')
  assert.deepEqual(Object.keys(I18N.ko).filter((k) => !Object.hasOwn(I18N.en, k)), [], '한국어에만 있는 문구가 없다')
  assert.deepEqual(Object.keys(I18N.en).filter((k) => !Object.hasOwn(I18N.ko, k)), [], '영어에만 있는 문구가 없다')
})
