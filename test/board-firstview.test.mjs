// 보드 첫 화면(F6 화면 쪽, F10~F15): 권한 안내, 언어 단추, 다음에 할 일, 단추 이름, 폴더 고르기, 닫으면 마침, 알림 띠·세션 상자 단추·맞춤법 밑줄.
// 화면(index.html)의 /*firstview*/ 덩어리(순수 함수)와 I18N을 그대로 읽어 시험하고, 화면 배선은 스크립트 전체를 가짜 문서 위에서 돌려 본다
// (브라우저는 띄우지 않는다 — 실제 모양은 실기기에서 따로 확인한다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const block = html.match(/\/\*firstview\*\/([\s\S]*?)\/\*\/firstview\*\//)
assert.ok(block, 'index.html에 /*firstview*/ … /*/firstview*/ 덩어리가 있어야 한다')
const { raiseNotice, raiseNoticeHtml, nextStepOf, resumeLabelKey, chosenAfterBrowse, firstRunClosePlan, langSegHtml, toastPlan, newBtnShown } =
  new Function(`${block[1]}; return { raiseNotice, raiseNoticeHtml, nextStepOf, resumeLabelKey, chosenAfterBrowse, firstRunClosePlan, langSegHtml, toastPlan, newBtnShown }`)()
const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// ── 가짜 문서 위에서 화면 스크립트를 그대로 돌린다 ────────────────────────────────────────────────
// 요소는 hidden·innerHTML·className 같은 값만 기억한다(그리기는 하지 않는다). 클릭·키는 스크립트가 붙인 진짜 처리기에 가짜 사건을 넣어 돌린다.
function fakeEl(id, over = {}) {
  const cls = new Set()
  return {
    id, hidden: false, open: false, innerHTML: '', textContent: '', title: '', value: '', disabled: false, dataset: {}, scrollHeight: 0, clientHeight: 0,
    style: { setProperty() {}, removeProperty() {} },
    classList: { add: (...c) => c.forEach((x) => cls.add(x)), remove: (...c) => c.forEach((x) => cls.delete(x)), toggle: (c, on) => ((on ?? !cls.has(c)) ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    set className(v) { cls.clear(); for (const x of String(v).split(/\s+/).filter(Boolean)) cls.add(x) }, get className() { return [...cls].join(' ') },
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, setAttribute() {}, focus() {}, closest: () => null, contains: () => false, ...over,
  }
}
class FakeStorage {   // 저장한 값이 자기 속성이라 Object.keys(localStorage)가 브라우저처럼 저장된 열쇠만 준다
  getItem(k) { return Object.hasOwn(this, k) ? this[k] : null }
  setItem(k, v) { this[k] = String(v) }
  removeItem(k) { delete this[k] }
}
const card = (id, status, over = {}) => ({ id, ref: `main/w1:p${id}`, desk: 'main', desk_label: 'main', runtime: 'herdr', caps: ['resume', 'close', 'toggle'], status, project: `proj${id}`, title: `proj${id}`, cwd: `/home/u/proj${id}`, ...over })
const boardOf = (cards, over = {}) => ({ now: '2026-11-14T03:00:00Z', readonly: false, columns: { red: [], yellow: [], snoozed: [], green: [], carry: cards, grey: [] }, order: [], next: null, stats: {}, health: { stale: false, age_sec: 1 }, closed: [], settings: { agent_cmd: 'claude', click_target: 'terminal' }, build: 'b1', raise_warning: null, ...over })
const autoconfOf = (show, over = {}) => ({
  at: '2026-11-14T02:59:00Z', platform: 'darwin', client_defaults: {}, first_run: { show },
  summary: { os: 'darwin', desktop: true, terminal: 'Example Term', herdr: { found: true, sessions: ['main'] }, ovis: [], options: { terminal_apps: [{ name: 'Example Term', showing: true, opens_new: true }, { name: 'Other Term', showing: false, opens_new: true }], agents: ['claude', 'codex'] } },
  chosen: { click_target: { value: 'terminal', origin: { source: 'default' } }, front_app: { value: 'Example Term', origin: { source: 'auto', reason: 'L4' } }, core_target: { value: 'app', origin: { source: 'default' } }, agent_cmd: { value: 'claude', origin: { source: 'auto', reason: 'L8' } } },
  ...over,
})
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)) }

async function boot({ board, autoconf, stored = {}, dirs = {}, postReply = () => null }) {
  const state = { board, autoconf, posts: [], focused: true, visibility: 'visible', media: () => false, timers: [], intervals: [], held: null, listeners: {}, winListeners: {} }
  const els = { firstrun: fakeEl('firstrun', { hidden: true }), notice: fakeEl('notice', { hidden: true }), stamp: fakeEl('stamp', { hidden: true }) }
  const newBtn = fakeEl('[data-new]')
  const document = {
    documentElement: fakeEl('html'), body: fakeEl('body'), title: '', get visibilityState() { return state.visibility }, activeElement: null, hasFocus: () => state.focused, contains: () => false,
    getElementById: (id) => (els[id] ||= fakeEl(id)), querySelector: (sel) => (sel === '[data-new]' ? newBtn : null), querySelectorAll: () => [],
    addEventListener: (type, fn) => (state.listeners[type] ||= []).push(fn),
  }
  const localStorage = new FakeStorage()
  for (const [k, v] of Object.entries(stored)) localStorage.setItem(k, v)
  const reply = (body, ok = true) => ({ ok, status: ok ? 200 : 400, json: async () => body })
  const fetch = async (url, opt = {}) => {
    const path = String(url)
    if (opt.method === 'POST') { state.posts.push({ path, body: JSON.parse(opt.body) }); if (path === '/api/first-run') state.autoconf = { ...state.autoconf, first_run: { show: false } }; return reply(postReply(path) || { ok: true, client_defaults: {} }) }
    if (path.startsWith('/api/board')) return reply(state.board)
    if (path.startsWith('/api/autoconf')) {
      const body = state.autoconf   // 요청이 서버에 닿은 때의 값
      if (state.held) return new Promise((done) => state.held.push(() => done(reply(body))))   // 응답이 늦게 온다(시험이 풀어 준다)
      return reply(body)
    }
    if (path.startsWith('/api/health')) return reply({ targets: [{ key: 'main', label: 'main' }] })
    if (path.startsWith('/api/folders')) return reply({ recent: [], home: '/home/u' })
    if (path.startsWith('/api/dirs')) { const p = new URL(path, 'http://x').searchParams.get('path'); return reply(dirs[p] || { ok: false, message: 'ENOENT' }) }
    return reply({})
  }
  const names = ['window', 'document', 'localStorage', 'location', 'fetch', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'addEventListener', 'matchMedia', 'innerWidth', 'confirm']
  const args = [{}, document, localStorage, { search: '', reload() {} }, fetch, (fn) => state.intervals.push(fn), () => {}, (fn) => state.timers.push(fn), () => {}, (type, fn) => (state.winListeners[type] ||= []).push(fn), (q) => ({ matches: Boolean(state.media(q)) }), 1400, () => true]
  const api = new Function(...names, `${script}\n;return { toast, refresh, lang: () => lang }`)(...args)
  await settle()
  const fire = async (type, e) => { for (const fn of state.listeners[type] || []) await fn(e); await settle() }
  // 가짜 클릭: sel 에 맞는 요소(dataset 을 가진)를 누른 것으로 친다
  const click = (sel, dataset = {}) => fire('click', { target: { closest: (s) => (s === sel ? { dataset } : null) }, stopPropagation() {} })
  const key = (k, sel = null) => { const e = { key: k, prevented: false, target: { closest: (q) => (sel && q.split(',').includes(sel) ? {} : null) }, preventDefault() { e.prevented = true } }; return fire('keydown', e).then(() => e) }
  return { state, els, localStorage, api, click, key, fire, el: (id) => document.getElementById(id), newBtn }
}

// ── CSS 를 규칙으로 읽어, 어떤 상황의 .acts(세션 상자 단추 묶음)에 실제로 걸리는 값을 계산한다 ──────────────────
// 글자열 대조만으로는 "규칙은 있는데 뒤에 온 규칙에 져서 안 먹는" 경우를 못 잡는다(기준선의 좁은 띠 규칙이 그랬다) — 자리 값과 순서를 따진다.
const splitTop = (s) => { const out = []; let depth = 0, cur = ''; for (const ch of s) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && !depth) { out.push(cur.trim()); cur = '' } else cur += ch } return [...out, cur.trim()].filter(Boolean) }
function cssRules(src) {
  const out = []
  const walk = (s, at) => {
    let i = 0
    while (i < s.length) {
      const open = s.indexOf('{', i); if (open < 0) break
      let depth = 1, j = open + 1
      while (j < s.length && depth) { if (s[j] === '{') depth++; else if (s[j] === '}') depth--; j++ }
      const head = s.slice(i, open).trim(), body = s.slice(open + 1, j - 1)
      if (head.startsWith('@')) { if (!/^@(keyframes|font-face)/.test(head)) walk(body, [...at, head]) }
      else for (const sel of splitTop(head)) out.push({ sel, at, decls: body.split(';').map((d) => d.split(/:(.*)/s).slice(0, 2).map((x) => (x || '').trim())).filter(([k, v]) => k && v) })
      i = j
    }
  }
  walk(src.replace(/\/\*[\s\S]*?\*\//g, ''), [])
  return out
}
// sit: { strip: 세션 띠의 폭, html: [html 의 class], cell: [세션 상자의 class], has: [상자 안에 있는 것], hover: 마우스·포커스가 상자에 있는지 }
function actsStyle(sit) {
  const s = { strip: 1000, html: [], cell: [], has: [], hover: false, ...sit }
  const atOk = (a) => {
    const m = a.match(/^@container strip \((max|min)-width:(\d+)px\)$/)
    assert.ok(m, `.acts 규칙이 시험이 모르는 조건 안에 있다: ${a}`)
    return m[1] === 'max' ? s.strip <= Number(m[2]) : s.strip >= Number(m[2])
  }
  const win = {}
  for (const r of cssRules(css)) {
    const parts = r.sel.split(/\s+/)
    if (parts.at(-1) !== '.acts') continue
    let spec = 1, ok = r.at.every(atOk)
    for (const p of parts.slice(0, -1)) {
      const has = [...p.matchAll(/:has\(\.([\w-]+)\)/g)].map((m) => m[1]), bare = p.replace(/:has\([^)]*\)/g, '')
      const tag = bare.match(/^[a-z]+/)?.[0] || '', classes = [...bare.matchAll(/\.([\w-]+)/g)].map((m) => m[1]), pseudo = [...bare.matchAll(/:([\w-]+)/g)].map((m) => m[1])
      spec += (classes.length + has.length + pseudo.length) + (tag ? 0.001 : 0)
      assert.ok(tag === 'html' || (!tag && classes.includes('cell')), `시험이 모르는 조상: ${r.sel}`)
      for (const x of pseudo) assert.ok(['hover', 'focus-within'].includes(x), `시험이 모르는 상태: ${r.sel}`)
      if (tag === 'html') ok &&= classes.every((c) => s.html.includes(c))
      else ok &&= classes.every((c) => c === 'cell' || s.cell.includes(c)) && has.every((h) => s.has.includes(h)) && (!pseudo.length || s.hover)
    }
    if (!ok) continue
    for (const [k, v] of r.decls) if (!win[k] || spec >= win[k].spec) win[k] = { v, spec }   // 자리 값이 같으면 뒤에 온 규칙이 이긴다
  }
  return Object.fromEntries(Object.entries(win).map(([k, x]) => [k, x.v]))
}

// ── 문구 ────────────────────────────────────────────────────────────────────────────────────────
test('문구: 한국어·영어의 열쇠가 (안쪽 묶음까지) 같고, 새 문구가 양쪽에 있다', () => {
  const keys = (o, p = '') => Object.entries(o).flatMap(([k, v]) => (v && typeof v === 'object' && !Array.isArray(v) ? keys(v, `${p}${k}.`) : [`${p}${k}`]))
  assert.deepEqual(keys(I18N.ko).sort(), keys(I18N.en).sort())
  for (const lang of ['ko', 'en']) for (const k of ['rwTag', 'rwSum', 'rwHow', 'rwWhat', 'rwWhere', 'rwRestart', 'todoLabel', 'todoNew', 'todoNewHint', 'agentStart', 'agentStarting', 'frKept']) assert.ok(I18N[lang][k], `${lang}.${k}`)
  // 용어: 세션(칸·카드·pane 이 아니다), 첫 실행 안내
  const koNew = [I18N.ko.rwWhat, I18N.ko.rwRestart, I18N.ko.todoNew, I18N.ko.todoNewHint('x'), I18N.ko.frHint, I18N.ko.frKept, ...Object.values(I18N.ko.rwSum), ...Object.values(I18N.ko.rwWhere).map((f) => f('x'))].join('\n')
  assert.doesNotMatch(koNew, /칸|카드|셋업|\bpane\b/)
  assert.match(I18N.ko.frKept, /첫 실행 안내/); assert.match(I18N.ko.frKept, /자동 감지/)
})

// ── F6 권한 안내 ─────────────────────────────────────────────────────────────────────────────────
test('F6: 권한 안내는 종류마다 켜는 곳이 다르고(손쉬운 사용 / 자동화), 서버가 준 앱 이름을 끼워 넣는다', () => {
  for (const lang of ['ko', 'en']) {
    const T = I18N[lang]
    const ax = raiseNotice('mac_accessibility', 'Example Term', T), au = raiseNotice('mac_automation', 'Example Term', T)
    assert.equal(ax.lines.length, 3); assert.equal(au.lines.length, 3)
    const [axWhat, axWhere, axRestart] = ax.lines, [, auWhere, auRestart] = au.lines
    assert.match(axWhere, lang === 'ko' ? /시스템 설정 > 개인정보 보호 및 보안 > 손쉬운 사용/ : /System Settings > Privacy & Security > Accessibility/)
    assert.doesNotMatch(axWhere, /자동화|Automation/, `${lang}: 손쉬운 사용 안내가 자동화를 가리키지 않는다`)
    assert.match(auWhere, lang === 'ko' ? /시스템 설정 > 개인정보 보호 및 보안 > 자동화/ : /System Settings > Privacy & Security > Automation/)
    assert.match(auWhere, /System Events/); assert.doesNotMatch(auWhere, /손쉬운 사용|Accessibility/, `${lang}: 자동화 안내가 손쉬운 사용을 가리키지 않는다`)
    for (const w of [axWhere, auWhere]) assert.ok(w.includes('“Example Term”'), `${lang}: 대상 앱 이름이 들어간다 — ${w}`)
    assert.notEqual(ax.summary, au.summary, `${lang}: 요약 줄도 종류마다 다르다`)
    assert.match(axWhat, lang === 'ko' ? /최소화해 둔 창/ : /Minimized windows/, `${lang}: 무엇이 안 되는지`)
    assert.match(axWhat, lang === 'ko' ? /화면 나눠 쓰기/ : /split screen/)
    assert.match(axWhat, lang === 'ko' ? /고장이 아닙니다/ : /Nothing is broken/)
    for (const r of [axRestart, auRestart]) assert.match(r, lang === 'ko' ? /whosup을 다시 켜야 반영/ : /restart whosup/, `${lang}: 켠 뒤 다시 켜야 반영된다`)
  }
})

test('F6: 앱 이름이 비어도 깨지지 않고 이름 없이 말한다, 모르는 종류·값 없음은 아무것도 그리지 않는다', () => {
  for (const lang of ['ko', 'en']) for (const kind of ['mac_accessibility', 'mac_automation']) for (const app of ['', '   ', undefined, null, 42]) {
    const n = raiseNotice(kind, app, I18N[lang])
    assert.equal(n.app, '')
    const text = n.lines.join('\n')
    assert.doesNotMatch(text, /undefined|null|“”|""|\b42\b/, `${lang}.${kind}(${String(app)}) — ${text}`)
    assert.match(n.lines[1], lang === 'ko' ? /whosup을 띄운 앱/ : /the app that started whosup/)
  }
  for (const kind of [null, undefined, '', 'win_focus', 'mac_other']) { assert.equal(raiseNotice(kind, 'Example Term', I18N.en), null); assert.equal(raiseNoticeHtml(raiseNotice(kind, 'x', I18N.en), I18N.en, esc), '') }
  assert.equal(raiseNotice('mac_accessibility', 'x'.repeat(200), I18N.en).app.length, 60, '터무니없이 긴 이름은 잘라 넣는다')
})

test('F6: 박아 둔 이름(node·osascript)과 툴팁에만 있던 문구를 없앴고, 안내는 누르면 펼쳐지는 줄이다(빨강·잘림 없음)', () => {
  assert.doesNotMatch(html, /node\(또는 osascript\)|node \(or osascript\)/)
  assert.doesNotMatch(html, /raiseWarnTip|T\.raiseWarn\b/)
  for (const lang of ['ko', 'en']) { assert.equal(I18N[lang].raiseWarn, undefined); assert.equal(I18N[lang].raiseWarnTip, undefined) }
  // 요약 줄 + 펼치면 세 줄. 앱 이름은 이스케이프해서 넣고, title(툴팁)에 숨기지 않는다.
  const n = raiseNotice('mac_automation', '<b>T&amp;</b>', I18N.en)
  const h = raiseNoticeHtml(n, I18N.en, esc)
  assert.match(h, /^<summary>/); assert.equal(h.match(/<p>/g).length, 3)
  assert.ok(h.includes('&lt;b&gt;T&amp;amp;&lt;/b&gt;')); assert.doesNotMatch(h, /<b>/); assert.doesNotMatch(h, /title=/)
  assert.ok(h.includes(esc(n.summary)) && h.includes(esc(I18N.en.rwHow)))
  // 자리: <details>(마우스·터치·키보드로 펼친다)이고 끊김 표시(#stamp)와 다른 요소다
  assert.match(html, /<details class="notice" id="notice" hidden><\/details>\n\s+<section class="hero" id="hero">/)
  assert.match(html, /<div class="caps stamp off" id="stamp" hidden><\/div>/)
  // 모양: 빨강(--fail)도 강조 주황(--accent)도 쓰지 않고, 좁은 폭에서 줄을 바꾼다(자르지 않는다)
  const rules = css.match(/\.notice[^{}]*\{[^{}]*\}/g).join('\n')
  assert.doesNotMatch(rules, /--fail|--accent|#d4382e|#c0392b/)
  assert.doesNotMatch(rules, /text-overflow|white-space:nowrap|max-width:\d+vw|overflow:hidden/)
  assert.match(rules, /\.notice summary\{[^}]*flex-wrap:wrap/)
  assert.match(css, /main\{[^}]*grid-template-rows:auto auto 1fr/); assert.match(css, /main>\.hero\{grid-row:2\}main>\.strip\{grid-row:3\}/)
})

test('F6 화면: raise_warning 이 오면 안내 줄이 보이고(끊김 표시는 그대로 숨김), 없어지면 접히고 숨는다. 값이 아직 없는 서버여도 깨지지 않는다', async () => {
  const cards = [card(1, 'working')]
  const p = await boot({ board: boardOf(cards, { raise_warning: 'mac_automation', raise_warning_app: 'Example Term' }), autoconf: autoconfOf(false) })
  assert.equal(p.el('notice').hidden, false)
  assert.ok(p.el('notice').innerHTML.includes(esc(I18N.en.rwWhere.mac_automation('Example Term'))), p.el('notice').innerHTML)
  assert.ok(p.el('notice').innerHTML.includes(esc(I18N.en.rwRestart)))
  assert.equal(p.el('stamp').hidden, true, '끊김 표시(빨간 글)에는 권한 안내를 쓰지 않는다')
  assert.equal(p.el('stamp').textContent, '')
  // 사람이 펼쳐 둔 안내는 다음 판(3초 뒤)에서 그대로다 — 글자가 같으면 다시 그리지 않는다
  p.el('notice').open = true
  const before = p.el('notice').innerHTML
  await p.api.refresh(); await settle()
  assert.equal(p.el('notice').open, true); assert.equal(p.el('notice').innerHTML, before)
  // 종류가 바뀌면 문구가 바뀐다. 앱 이름이 없으면 이름 없이.
  p.state.board = boardOf(cards, { raise_warning: 'mac_accessibility' })
  await p.api.refresh(); await settle()
  assert.ok(p.el('notice').innerHTML.includes(esc(I18N.en.rwWhere.mac_accessibility(''))))
  assert.doesNotMatch(p.el('notice').innerHTML, /undefined|Example Term/)
  // 풀리면 숨는다
  p.state.board = boardOf(cards, { raise_warning: null })
  await p.api.refresh(); await settle()
  assert.equal(p.el('notice').hidden, true); assert.equal(p.el('notice').open, false); assert.equal(p.el('notice').innerHTML, '')
  // raise_warning 열쇠가 아예 없는 판(옛 서버)
  const old = boardOf(cards); delete old.raise_warning
  const q = await boot({ board: old, autoconf: autoconfOf(false) })
  assert.equal(q.el('notice').hidden, true)
  assert.ok(q.el('hero').innerHTML.includes('class="stats"'), '판은 그대로 그려진다')
})

test('F6 화면: 창을 올리는 조작의 성공 응답에 권한 경고가 실려 오면 알림 띠가 성공만 말하지 않는다', async () => {
  const warn = { raise_warning: 'mac_accessibility', raise_warning_app: 'Example Term' }
  const p = await boot({ board: boardOf([card(1, 'working')]), autoconf: autoconfOf(false), postReply: (path) => (path === '/api/open' ? { ok: true, code: 'focused', ...warn } : null) })
  await p.click('[data-open]', { open: '1' })
  assert.equal(p.el('toast').textContent, `${I18N.en.codes.focused} · ${I18N.en.rwSum.mac_accessibility}`)
  // 경고가 없는 성공, 실패 응답은 예전 그대로
  const q = await boot({ board: boardOf([card(1, 'working')]), autoconf: autoconfOf(false), postReply: (path) => (path === '/api/open' ? { ok: true, code: 'focused', raise_warning: null, raise_warning_app: null } : null) })
  await q.click('[data-open]', { open: '1' })
  assert.equal(q.el('toast').textContent, I18N.en.codes.focused)
  const r = await boot({ board: boardOf([card(1, 'working')]), autoconf: autoconfOf(false), postReply: (path) => (path === '/api/open' ? { ok: false, code: 'no_session', ...warn } : null) })
  await r.click('[data-open]', { open: '1' })
  assert.equal(r.el('toast').textContent, I18N.en.codes.no_session)
})

// ── F10 언어 ────────────────────────────────────────────────────────────────────────────────────
test('F10: 저장된 값이 없으면 영어다(브라우저 언어로 추측하지 않는다). 첫 실행 안내에 EN / 한 단추가 있고 누르면 그 자리에서 바뀌어 저장된다', async () => {
  assert.match(html, /let lang = okLang\(localStorage\.getItem\('whosup-lang'\)\) \|\| 'en'/)
  assert.doesNotMatch(script, /navigator\.languages?\b/)
  assert.equal(langSegHtml('en'), '<button data-lang="en" class="on">EN</button><button data-lang="ko" class="">한</button>')
  assert.equal(langSegHtml('ko'), '<button data-lang="en" class="">EN</button><button data-lang="ko" class="on">한</button>')
  const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
  assert.equal(p.api.lang(), 'en')
  const fr = p.el('firstrun')
  assert.equal(fr.hidden, false, '첫 실행 안내가 저절로 뜬다')
  assert.ok(fr.innerHTML.includes(I18N.en.frTitle)); assert.ok(fr.innerHTML.includes(langSegHtml('en')), '안내 머리에 언어 단추')
  assert.ok(fr.innerHTML.indexOf('data-lang="ko"') < fr.innerHTML.indexOf('data-fr-key'), '고를 줄보다 위(첫 화면에서 보인다)')
  await p.click('[data-lang]', { lang: 'ko' })
  assert.equal(p.api.lang(), 'ko'); assert.equal(p.localStorage.getItem('whosup-lang'), 'ko', '설정의 언어 바꾸기와 같은 저장 값')
  assert.ok(fr.innerHTML.includes(I18N.ko.frTitle), '안내가 그 자리에서 한국어로 바뀐다'); assert.ok(fr.innerHTML.includes(langSegHtml('ko')))
  assert.ok(fr.innerHTML.includes(I18N.ko.frOk)); assert.equal(fr.hidden, false)
  assert.equal(p.state.posts.length, 0, '언어 바꾸기는 안내를 마친 것으로 치지 않는다')
  // 엉뚱한 값은 무시한다
  await p.click('[data-lang]', { lang: 'xx' })
  assert.equal(p.api.lang(), 'ko')
  // 저장된 값이 있으면 그 값으로 뜬다
  const q = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true), stored: { 'whosup-lang': 'ko' } })
  assert.equal(q.api.lang(), 'ko'); assert.ok(q.el('firstrun').innerHTML.includes(I18N.ko.frTitle))
  // 설정의 언어 줄도 같은 단추를 쓴다
  assert.match(html, /<div class="seg mini">\$\{langSegHtml\(lang\)\}<\/div><\/div>`/)
})

// ── F11 다음에 할 일 · 단추 이름 ─────────────────────────────────────────────────────────────────
test('F11: 다음에 할 일 — 에이전트 세션이 없고 첫 실행 안내가 끝났을 때만 "새 세션을 여세요"', () => {
  const base = { agents: 0, readonly: false, stale: false, offDesks: 0, guide: 'closed' }
  assert.equal(nextStepOf(base), 'new')
  assert.equal(nextStepOf({ ...base, agents: 1 }), null, '에이전트 세션이 하나라도 있으면 말하지 않는다')
  assert.equal(nextStepOf({ ...base, guide: 'open' }), null, '첫 실행 안내가 떠 있는 동안은 그쪽이 먼저')
  assert.equal(nextStepOf({ ...base, guide: 'unknown' }), null, '안내를 마쳤는지 아직 모르면 말하지 않는다(깜빡임 방지)')
  assert.equal(nextStepOf({ ...base, readonly: true }), null, '읽기 전용 화면에서는 세션을 열 수 없다')
  assert.equal(nextStepOf({ ...base, stale: true }), null, '끊긴 동안은 세션이 없는지 알 수 없다')
  assert.equal(nextStepOf({ ...base, offDesks: 1 }), null, '꺼진 데스크가 있으면 켜기가 먼저')
  assert.equal(nextStepOf(), null)
  // 어느 단추인지: 머리줄 단추의 글자(T.new)를 그대로 끼워 넣는다
  for (const lang of ['ko', 'en']) assert.ok(I18N[lang].todoNewHint(I18N[lang].new).includes(`“${I18N[lang].new}”`), lang)
})

test('F11: 단추 이름 — 이어 갈 대화가 있을 때만 "이어서 열기", 없으면 "에이전트 시작"', () => {
  assert.equal(resumeLabelKey({ resume: { sid: 's1' } }, false), 'resume')
  assert.equal(resumeLabelKey({ resume: null }, false), 'agentStart')
  assert.equal(resumeLabelKey({}, false), 'agentStart')
  assert.equal(resumeLabelKey({ resume: { sid: 's1' } }, true), 'reopen')
  assert.equal(resumeLabelKey({ resume: null }, true), 'agentStart')
  assert.equal(I18N.ko.agentStart, '에이전트 시작'); assert.match(I18N.en.agentStart, /start/)
  for (const lang of ['ko', 'en']) { assert.notEqual(I18N[lang].agentStart, I18N[lang].resume); assert.notEqual(I18N[lang].agentStart, I18N[lang].reopen) }
  assert.doesNotMatch(script, />\$\{T\.resume\}<\/button>|>\$\{T\.reopen\}<\/button>/, '단추 글자를 조건 없이 "이어서 열기"로 박지 않는다')
  assert.match(script, /toast\(sid \? T\.resuming : T\.agentStarting\)/, '이어 갈 대화가 없으면 "이어서 여는 중"이라고 하지 않는다')
})

test('F11 화면: 빈 세션뿐인 판 — 안내를 마치기 전에는 말하지 않고, 마치면 다음에 할 일이 보이며, 빈 세션의 단추는 "에이전트 시작"이다', async () => {
  const shell = card(1, 'shell')
  const p = await boot({ board: boardOf([shell]), autoconf: autoconfOf(true) })
  assert.equal(p.el('firstrun').hidden, false)
  assert.doesNotMatch(p.el('hero').innerHTML, /nextline todo/, '첫 실행 안내가 떠 있는 동안에는 다음에 할 일을 말하지 않는다')
  assert.ok(p.el('hero').innerHTML.includes(I18N.en.noWait))
  await p.click('[data-firstrun-ok]')
  assert.equal(p.el('firstrun').hidden, true)
  const hero = p.el('hero').innerHTML
  assert.match(hero, /<div class="nextline todo" data-new>/, '누르면 새 세션 패널이 열리는 줄')
  assert.ok(hero.includes(I18N.en.todoLabel) && hero.includes(I18N.en.todoNew) && hero.includes(esc(I18N.en.todoNewHint(I18N.en.new))))
  assert.doesNotMatch(hero, /nextline quiet/); assert.ok(!hero.includes(I18N.en.noWait))
  // 빈 세션(이어 갈 대화 없음)의 단추
  const strip = p.el('strip').innerHTML
  assert.match(strip, /<button class="resume" data-resume="1" data-sid=""[^>]*>start agent<\/button>/)
  assert.ok(strip.includes(esc(I18N.en.resumeFresh)), '풍선말은 새로 시작한다고 말한다')
  // 이어 갈 대화가 있으면 "이어서 열기", 최근 닫힘도 같은 규칙
  p.state.board = boardOf([card(1, 'shell', { resume: { sid: 'abc', prompt: 'hi', at: '2026-11-14T02:00:00Z' } })], { closed: [{ id: 7, project: 'old', desk: 'main', reason: 'gone', closed_at: '2026-11-14T01:00:00Z', caps: ['resume'], resume: null }, { id: 8, project: 'old2', desk: 'main', reason: 'gone', closed_at: '2026-11-14T01:00:00Z', caps: ['resume'], resume: { sid: 'zz', prompt: 'p', at: '2026-11-14T00:00:00Z' } }] })
  await p.api.refresh(); await settle()
  const s2 = p.el('strip').innerHTML
  assert.match(s2, /<button class="resume" data-resume="1" data-sid="abc"[^>]*>resume<\/button>/)
  assert.match(s2, /<button data-resume="7" data-sid=""[^>]*>start agent<\/button>/); assert.match(s2, /<button data-resume="8" data-sid="zz"[^>]*>resume<\/button>/)
  assert.match(p.el('hero').innerHTML, /nextline todo/, '빈 세션은 에이전트 세션이 아니다 — 다음에 할 일은 그대로')
  // 에이전트가 도는 세션이 생기면 다음에 할 일이 사라진다
  p.state.board = boardOf([shell, card(2, 'working')])
  await p.api.refresh(); await settle()
  assert.doesNotMatch(p.el('hero').innerHTML, /nextline todo/); assert.ok(p.el('hero').innerHTML.includes(I18N.en.noWait))
  // 읽기 전용 화면: 말하지 않는다
  const ro = await boot({ board: boardOf([shell], { readonly: true }), autoconf: autoconfOf(false) })
  assert.doesNotMatch(ro.el('hero').innerHTML, /nextline todo/)
  // 강조는 한 곳: 주황 점은 다음 줄(.nextline i)의 것이고 조용한 줄에서는 회색이다. 다음에 할 일 줄은 조용한 줄이 아니다.
  assert.match(css, /\.nextline i\{[^}]*background:var\(--accent-soft\)/); assert.match(css, /\.nextline\.quiet i\{background:var\(--faint\)\}/)
  assert.doesNotMatch(css.match(/\.nextline\.todo[^{}]*\{[^{}]*\}/g).join(''), /--fail|background/)
})

test('F11 화면: 아주 좁은 화면(머리줄 단추가 "+"만 보일 때)에서는 다음에 할 일이 그 단추를 보이는 글자대로 가리킨다', async () => {
  for (const lang of ['ko', 'en']) { assert.equal(newBtnShown(false, I18N[lang]), I18N[lang].new); assert.equal(newBtnShown(true, I18N[lang]), '+') }
  // 근거가 되는 CSS: 480px 이하에서 머리줄 단추의 글자를 감추고 '+'만 보인다 — 이 규칙이 바뀌면 안내 문구도 함께 봐야 한다
  assert.match(css, /@media \(max-width:480px\)\{[^\n]*\.nb\{font-size:0;[^}]*\}\.nb::before\{content:'\+';/)
  const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(false) })
  assert.ok(p.el('hero').innerHTML.includes(esc(I18N.en.todoNewHint(I18N.en.new))), '보통 폭: 단추 글자 그대로')
  const asked = []
  p.state.media = (q) => { asked.push(q); return q === '(max-width:480px)' }
  await p.api.refresh(); await settle()
  assert.ok(asked.includes('(max-width:480px)'), 'CSS 와 같은 폭 조건을 본다')
  const hero = p.el('hero').innerHTML
  assert.ok(hero.includes(esc(I18N.en.todoNewHint('+'))), hero)
  assert.ok(!hero.includes(esc(I18N.en.new)), '보이지 않는 글자("+ new session")를 누르라고 하지 않는다')
  assert.match(hero, /<div class="nextline todo" data-new>/, '줄 자체를 눌러도 열린다')
})

// ── F12 폴더 고르기 ──────────────────────────────────────────────────────────────────────────────
test('F12: 폴더에 들어가면 그 폴더가 골라진다(들어가지 못했으면 그대로)', () => {
  assert.equal(chosenAfterBrowse('', { ok: true, path: '/home/u/Desktop' }), '/home/u/Desktop')
  assert.equal(chosenAfterBrowse('/home/u/a', { ok: true, path: '/home/u/b' }), '/home/u/b')
  assert.equal(chosenAfterBrowse('/home/u/a', { ok: false, message: 'only folders under home' }), '/home/u/a')
  assert.equal(chosenAfterBrowse('/home/u/a', null), '/home/u/a')
  assert.equal(chosenAfterBrowse('', { ok: true }), '')
})

test('F12 화면: 새 세션 패널 — 처음에는 고른 폴더가 없고, 폴더를 누르면 경로 칸이 채워져 열기 단추가 켜진다', async () => {
  const dirs = { '/home/u': { ok: true, path: '/home/u', parent: null, home: '/home/u', sep: '/', dirs: ['Desktop', 'work'] }, '/home/u/Desktop': { ok: true, path: '/home/u/Desktop', parent: '/home/u', home: '/home/u', sep: '/', dirs: [] } }
  const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(false), dirs })
  await p.click('[data-new]')
  let peek = p.el('peek').innerHTML
  assert.match(peek, /id="cwd"[^>]*value=""/, '패널을 열기만 해서는 홈 폴더가 골라지지 않는다(Enter 한 번에 홈에서 열리지 않게)')
  assert.match(peek, /<button class="btn" data-create disabled>/)
  assert.match(peek, /<button class="chip pick" data-folder="\/home\/u">/, '지금 보는 폴더를 고르는 단추는 아직 고르지 않았을 때만')
  await p.click('[data-browse]', { browse: '/home/u/Desktop' })
  peek = p.el('peek').innerHTML
  assert.match(peek, /id="cwd"[^>]*value="\/home\/u\/Desktop"/, '들어간 폴더가 고른 폴더 칸에 들어간다')
  assert.match(peek, /<button class="btn" data-create >/, '열기 단추가 켜진다')
  assert.doesNotMatch(peek, /chip pick/, '이미 골라졌으니 "이 폴더로"를 한 번 더 누르게 하지 않는다')
  // 상위 폴더로 올라가도 보는 폴더가 고른 폴더다. 못 들어간 폴더는 고르지 않는다.
  await p.click('[data-browse]', { browse: '/home/u' })
  assert.match(p.el('peek').innerHTML, /id="cwd"[^>]*value="\/home\/u"/)
  await p.click('[data-browse]', { browse: '/home/u/gone' })
  assert.match(p.el('peek').innerHTML, /id="cwd"[^>]*value="\/home\/u"/)
  // 열기: 고른 폴더로 새 세션을 연다
  await p.click('[data-browse]', { browse: '/home/u/Desktop' })
  await p.click('[data-create]')
  assert.deepEqual(p.state.posts.filter((x) => x.path === '/api/new').map((x) => [x.body.cwd, x.body.session]), [['/home/u/Desktop', 'main']])
  // 키보드: 폴더 단추에서 Enter 는 그 폴더로 들어가는 것이다(가로채서 세션을 열지 않는다). 그 밖의 자리에서 Enter 는 예전처럼 연다.
  await p.click('[data-new]'); await p.click('[data-browse]', { browse: '/home/u/Desktop' })   // 패널이 다시 열려 있고 고른 폴더가 있다
  const onFolder = await p.key('Enter', '[data-browse]')
  assert.equal(onFolder.prevented, false); assert.equal(p.state.posts.filter((x) => x.path === '/api/new').length, 1, '폴더 단추의 Enter 로 세션이 열리지 않는다')
  const onInput = await p.key('Enter')
  assert.equal(onInput.prevented, true); assert.equal(p.state.posts.filter((x) => x.path === '/api/new').length, 2)
  // 경로를 직접 붙여 넣는 길은 그대로다
  assert.match(script, /input\.addEventListener\('input', \(\) => \{ newState\.cwd = input\.value;/)
})

// ── F13 닫으면 마침 ──────────────────────────────────────────────────────────────────────────────
test('F13: 닫을 때의 판단 — 저절로 뜬 안내만 "마침"으로 적는다', () => {
  assert.deepEqual(firstRunClosePlan({ force: false, readonly: false }), { markDone: true })
  assert.deepEqual(firstRunClosePlan({ force: true, readonly: false }), { markDone: false }, '설정에서 다시 연 안내는 닫기만')
  assert.deepEqual(firstRunClosePlan({ force: true, readonly: true }), { markDone: false }, '읽기 전용은 저장하지 않는다')
  assert.deepEqual(firstRunClosePlan({ force: false, readonly: true }), { markDone: false })
})

test('F13 화면: 저절로 뜬 안내를 X 나 Esc 로 닫으면 고른 것 없이 "마침"을 서버에 적고, 설정에서 다시 연 안내를 닫는 것은 적지 않는다', async () => {
  for (const close of ['x', 'esc']) {
    const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
    assert.equal(p.el('firstrun').hidden, false)
    await p.click('[data-fr-key]', { frKey: 'agent_cmd', frVal: 'codex' })   // 줄을 만졌더라도 닫으면 저장하지 않는다
    if (close === 'x') await p.click('[data-firstrun-close]'); else await p.key('Escape')
    assert.equal(p.el('firstrun').hidden, true, close)
    assert.deepEqual(p.state.posts, [{ path: '/api/first-run', body: { raise: true, choices: {} } }], `${close}: 마침만 적는다(값은 자동 감지 그대로)`)
    assert.match(p.el('hero').innerHTML, /nextline todo/, '닫은 뒤에는 다음에 할 일이 보인다')
    // 설정에서 다시 열어 닫는다: 더 적지 않는다
    await p.click('[data-firstrun-open]')
    assert.equal(p.el('firstrun').hidden, false)
    if (close === 'x') await p.click('[data-firstrun-close]'); else await p.key('Escape')
    assert.equal(p.el('firstrun').hidden, true)
    assert.equal(p.state.posts.length, 1, `${close}: 사람이 다시 연 안내를 닫는 것은 지금대로`)
  }
  // 읽기 전용: 저절로 뜨지 않고, 닫아도 적지 않는다
  const ro = await boot({ board: boardOf([card(1, 'shell')], { readonly: true }), autoconf: autoconfOf(false) })
  assert.equal(ro.el('firstrun').hidden, true)
  await ro.click('[data-firstrun-open]'); await ro.click('[data-firstrun-close]')
  assert.equal(ro.state.posts.length, 0)
  // Esc: 안내가 없을 때는 예전처럼 패널을 닫는다
  assert.match(script, /if \(e\.key === 'Escape'\) return document\.getElementById\('firstrun'\)\.hidden \? closePeek\(\) : closeFirstRun\(\)/)
})

test('F13 화면: 닫는 순간 이미 나가 있던 주기 확인의 응답이 늦게 와도 닫은 안내가 다시 뜨지 않는다', async () => {
  const changed = () => { const v = autoconfOf(true); v.summary.terminal = 'Late Term'; v.chosen.front_app.value = 'Late Term'; return v }
  for (const close of ['x', 'ok']) {
    const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
    const tick = p.state.intervals.at(-1)
    assert.match(String(tick), /\/api\/autoconf/, '안내가 저절로 떠 있는 동안 도는 주기 확인')
    p.state.autoconf = changed()        // 늦게 뜬 것이 새로 감지됐다(안내를 다시 그릴 내용)
    p.state.held = []
    const pending = tick()              // 주기 확인이 나갔다 — 응답은 아직
    await settle()
    const waiting = p.state.held; p.state.held = null   // 붙잡는 것은 그 한 요청뿐(뒤의 요청은 바로 답한다)
    assert.equal(waiting.length, 1)
    await p.click(close === 'x' ? '[data-firstrun-close]' : '[data-firstrun-ok]')   // 그 사이에 사람이 닫았다
    assert.equal(p.el('firstrun').hidden, true)
    assert.deepEqual(p.state.posts.map((x) => x.path), ['/api/first-run'])
    for (const go of waiting) go()      // 늦은 응답(first_run.show 가 아직 참)이 이제 도착한다
    await pending; await settle()
    assert.equal(p.el('firstrun').hidden, true, `${close}: 닫은 안내가 다시 뜨지 않는다`)
    assert.match(p.el('hero').innerHTML, /nextline todo/, '다음에 할 일도 그대로 보인다')
  }
  // 닫지 않았다면 늦은 응답은 예전처럼 안내를 새 감지 결과로 다시 그린다
  const q = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
  const before = q.el('firstrun').innerHTML
  assert.doesNotMatch(before, /Late Term/)
  q.state.autoconf = changed()
  await q.state.intervals.at(-1)(); await settle()
  assert.equal(q.el('firstrun').hidden, false); assert.match(q.el('firstrun').innerHTML, /Late Term/)
  // 다른 탭·터미널에서 이미 마쳤으면 예전처럼 저절로 닫힌다
  q.state.autoconf = { ...changed(), first_run: { show: false } }
  await q.state.intervals.at(-1)(); await settle()
  assert.equal(q.el('firstrun').hidden, true); assert.equal(q.state.posts.length, 0)
})

// ── F14 화면 쪽 ──────────────────────────────────────────────────────────────────────────────────
test('F14 화면: 손대지 않고 "이대로 시작"이면 아무 값도 보내지 않고, 손댄 줄만 보낸다', async () => {
  const p = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
  assert.match(p.el('firstrun').innerHTML, /data-fr-key="front_app" data-fr-val="Example Term" class="on"/, '자동 감지한 값이 미리 골라져 보인다')
  await p.click('[data-firstrun-ok]')
  assert.deepEqual(p.state.posts, [{ path: '/api/first-run', body: { raise: true, choices: {} } }])
  assert.equal(p.el('toast').textContent, I18N.en.frKept, '저장한 것이 없는데 "저장했습니다"라고 하지 않는다')
  const q = await boot({ board: boardOf([card(1, 'shell')]), autoconf: autoconfOf(true) })
  await q.click('[data-fr-key]', { frKey: 'front_app', frVal: 'Other Term' })
  await q.click('[data-firstrun-ok]')
  assert.deepEqual(q.state.posts[0].body.choices, { front_app: 'Other Term' })
  assert.equal(q.el('toast').textContent, I18N.en.frSaved)
  for (const lang of ['ko', 'en']) assert.match(I18N[lang].frHint, lang === 'ko' ? /손대지 않은 줄은 저장하지 않/ : /leave alone are not saved/, `${lang}: 안내 문장이 바뀐 동작을 말한다`)
})

// ── F15 다듬기 ───────────────────────────────────────────────────────────────────────────────────
test('F15: 세션 상자의 단추가 요약 글을 가리지 않는다 — 아래 띠를 모든 상자가 비워 두고, 단추는 그 띠 안에만 뜬다(높이 맞춤에서는 요약을 한 줄로 줄인다)', () => {
  assert.match(css, /\n\.cell,\.cell\.next,\.cell:has\(\.resume\),\.cell:has\(\.stale\)\{padding-bottom:50px\}/, '요약 글 아래 50px 띠는 모든 세션 상자에')
  assert.match(css, /@container strip \(min-width:2200px\)\{[^\n]*\.cell\{min-height:clamp\(150px,15vh,200px\);padding:20px 22px 50px\}/, '넓은 띠도 같다')
  // 보통 띠: 왼쪽 아래 50px 띠 안에 겹쳐 띄운다(흐름 밖). 마우스·포커스가 없으면 감춘다.
  const wide = actsStyle({ strip: 1000, hover: true })
  assert.deepEqual([wide.position, wide.display, wide.left, wide.bottom, wide.top, wide.right], ['absolute', 'flex', '14px', '14px', undefined, undefined])
  assert.equal(actsStyle({ strip: 1000 }).display, 'none')
  assert.equal(actsStyle({ strip: 1000, hover: true, has: ['resume'] })['max-width'], 'calc(100% - 126px)')
  assert.match(css, /html\.fit2 \.cell:has\(\.acts\):hover \.sum,html\.fit2 \.cell:has\(\.acts\):focus-within \.sum\{-webkit-line-clamp:1\}/, '높이 맞춤에서는 요약을 한 줄로 줄이고 그 아래에')
  assert.match(css, /\.cell:has\(\.resume\) \.acts\{max-width:calc\(100% - 126px\);flex-wrap:wrap-reverse\}/, '오른쪽 아래 단추 자리를 남긴다')
})

test('F15: 좁은 띠(화면 나눠 쓰기의 한 줄 목록)에서 단추가 떠도 세션 상자 높이가 변하지 않는다 — 흐름 밖(윗줄 오른쪽 끝)에 띄운다', () => {
  for (const sit of [{ strip: 420, hover: true }, { strip: 639, hover: true }, { strip: 420, hover: true, has: ['resume'] }, { strip: 420, hover: true, cell: ['fail', 'next'] }]) {
    const a = actsStyle(sit), at = JSON.stringify(sit)
    assert.equal(a.display, 'flex', at)
    assert.equal(a.position, 'absolute', `${at}: 흐름 안의 줄로 펼치면 마우스가 지나가는 상자마다 높이가 늘어 아래 목록이 출렁인다`)
    for (const k of ['grid-column', 'grid-row', 'order', 'margin-top']) assert.equal(a[k], undefined, `${at}: ${k} — 상자의 줄을 차지하지 않는다`)
    // 네 변 가운데 위·오른쪽만 붙인다. 왼쪽·아래까지 걸리면(뒤에 온 기본 규칙에 지면) 단추 묶음이 상자 가득 늘어나 글자를 덮는다.
    assert.deepEqual([a.top, a.right, a.bottom, a.left], ['6px', '6px', 'auto', 'auto'], at)
    assert.equal(a['max-width'], 'calc(100% - 12px)', `${at}: 상자 밖으로 나가지 않는다`)
  }
  assert.equal(actsStyle({ strip: 420 }).display, 'none', '마우스·포커스가 없으면 감춘다')
  assert.equal(actsStyle({ strip: 640, hover: true }).left, '14px', '640px 부터는 보통 띠의 자리')
  // 색을 채운 실패 상자: 좁은 띠에서는 단추가 윗줄 글자 위에 뜨므로 바탕을 채운다(보통 띠의 비워 둔 아래 띠에서는 투명 그대로)
  assert.match(css, /\n\.cell\.fail \.acts button\{background:transparent;border-color:#fff\}\n/)
  assert.match(css, /@container strip \(max-width:639px\)\{\.cell \.acts,[^\n]*\}\.cell\.fail \.acts button\{background:var\(--fail-fill\)\}\}\n/)
  assert.ok(css.indexOf('.cell.fail .acts button{background:var(--fail-fill)}') > css.indexOf('.cell.fail .acts button{background:transparent'), '뒤에 있어야 이긴다')
})

test('F15: 알림 띠는 오른쪽 아래에 뜨고, 보드가 화면에 보이지 않는 동안에만 붙잡아 둔다(보이면 포커스가 없어도 내린다)', async () => {
  const rule = css.match(/\n\.toast\{[^}]*\}/)[0]
  assert.match(rule, /position:fixed;right:24px;bottom:24px;/); assert.doesNotMatch(rule, /left:50%|translateX/)
  assert.match(rule, /max-width:min\(480px,calc\(100vw - 48px\)\)/, '좁은 창에서도 창 밖으로 나가지 않는다')
  assert.equal(toastPlan({ hidden: true }), 'hold'); assert.equal(toastPlan({ hidden: false }), 'hide'); assert.equal(toastPlan(), 'hide')
  // ① 화면 나눠 쓰기: 세션을 누르면 포커스는 터미널로 가지만 보드는 옆에 계속 보인다 — 띠는 시간이 되면 내려간다(보드를 다시 누를 때까지 남지 않는다)
  const p = await boot({ board: boardOf([card(1, 'working')]), autoconf: autoconfOf(false) })
  const el = p.el('toast')
  p.state.timers.length = 0
  p.api.toast('moved to that session')
  assert.equal(el.className, 'toast on'); assert.equal(p.state.timers.length, 1)
  p.state.focused = false                 // 포커스 없음, 그러나 보인다
  p.state.timers.pop()()                  // 머무는 시간이 다 됐다
  assert.equal(el.className, 'toast', '보이는 보드에서는 포커스가 없어도 내려간다')
  // ② 보드가 보이지 않는다(앞으로 온 창이 다 가렸다·다른 탭·최소화): 내리지 않고 붙잡아 둔다
  p.state.focused = true
  p.api.toast('moved to that session')
  p.state.visibility = 'hidden'
  p.state.timers.pop()()
  assert.equal(el.className, 'toast on', '보드가 보이지 않는 동안에는 띠를 내리지 않는다')
  const waiting = p.state.timers.length
  p.state.focused = false; p.state.visibility = 'visible'
  await p.fire('visibilitychange', {})    // 다시 보인다 — 포커스는 아직 다른 창에 있다(창 포커스 사건은 오지 않는다)
  assert.equal(el.className, 'toast on'); assert.ok(p.state.timers.length > waiting, '다시 보이면 포커스가 없어도 그때부터 다시 센다')
  p.state.timers.at(-1)()
  assert.equal(el.className, 'toast', '다시 보인 뒤 시간이 지나면 내려간다')
  // 붙잡아 둔 띠가 없으면 다시 보여도 아무것도 세지 않는다
  const idle = p.state.timers.length
  p.state.visibility = 'hidden'; await p.fire('visibilitychange', {}); p.state.visibility = 'visible'; await p.fire('visibilitychange', {})
  assert.equal(p.state.timers.length, idle)
  p.api.toast('bad', true)
  assert.equal(el.className, 'toast on err')
  assert.match(script, /const TOAST_MS = 6000\n/)
})

test('F15: 경로 입력란은 맞춤법 검사를 끈다', () => {
  assert.match(script, /<input class="in" id="cwd"[^>]* spellcheck="false"[^>]*>/)
})
