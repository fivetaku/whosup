import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isWindows } from '../platform.mjs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBoardAsync, markSeen, markUnseen, resumeFor, setPinned, setStashed, markReopened } from './board.mjs'
import { autoValues, clientDefaults, frontAppChoice, getSettings, setSettings, settingOrigins, settingSources, SETTING_RANGES, TEXT_SETTINGS, validTextSetting } from '../settings.mjs'
import { readSetup } from '../setup.mjs'
import { STATE_DIR, getMeta, setMeta } from '../db.mjs'
import { BOARD_APP, instanceOf } from '../paths.mjs'
import * as herdr from '../runtime/herdr.mjs'
import * as core from '../runtime/core.mjs'
import { allowed, collectAll, deskAllowed, deskLabelOf, deskOf, noteChange, runtimeForDesk, runtimeOf } from '../runtime/index.mjs'
// 화면에 내려 주는 브라우저 기본값: 설정에서 나온 값(settings.mjs clientDefaults)에 런타임이 지금 아는 것을 보탠다(저장하지 않는다).
//  · whosup-open-url-core:<코어 이름> — 자기 서버로 보여 주는 앱의 코어는 그 세션의 터미널 보기까지 적은 주소 틀로 내려 준다
//    (core.openUrlTemplates: …/?pane={pane}&view=terminal — 런타임이 이동 결과에 싣는 주소와 같은 모양). 자동 감지가 실은 주소가 있을 때만 바꾼다.
//  · whosup-open-url-app — 'on' 이면 "앱 창 안에서 고를 수 없어 브라우저 탭으로만 보여 줄 수 있는 세션"(카드의 features.focus.means 가
//    open_url)은 '세션을 여는 곳'이 터미널 창이어도 누르면 그 탭을 연다(탭을 여는 클릭은 앱 창을 올리지 않는다 — 올린 창은 다른 세션을
//    보인 채 탭을 덮는다: index.html clickPlanOf 가 raise:false 로 보낸다). 아무도 '세션을 여는 곳'을
//    정하지 않았을 때만 'on' 이다: 설정·첫 실행 안내에서 고른 값이나 환경변수가 있으면 'off' — 그 값 그대로 따른다
//    (사람이 바꾼 값 > 환경변수 > 자동 감지 > 기본값). 이 브라우저에서 따로 고른 값도 먼저다(index.html setClickMode 가 'off' 를 적고,
//    이 열쇠가 생기기 전에 골라 둔 브라우저는 화면이 이 값을 쓰지 않고 'off' 로 읽는다 — storedOf).
export function clientDefaultsOf(db) {
  const out = clientDefaults(db)
  try { for (const [name, url] of Object.entries(core.openUrlTemplates())) if (out[`whosup-open-url-core:${name}`]) out[`whosup-open-url-core:${name}`] = url } catch {}
  const origin = settingOrigins(db).click_target?.source
  out['whosup-open-url-app'] = origin === 'default' || origin === 'auto' ? 'on' : 'off'
  return out
}
// 자동 감지(auto.json) 요약 + 첫 실행 안내. 화면은 이것으로 "감지한 환경" 단락과 첫 실행 안내를 그린다.
// first_run.show: 아직 첫 실행 안내를 닫은 적 없음(DB meta firstrun.done 없음, 읽기 전용 보기는 늘 false).
// first_run.ask_click: 데스크와 맞춘 ovis가 있을 때만 "세션을 여는 곳"을 묻는다(없으면 요약과 "이대로 시작"만).
export function autoconfView(db) {
  const r = autoValues().result
  const summary = r?.summary ? { ...r.summary } : null
  const raise = herdr.raiseWarning()
  // 화면 나눠 쓰기는 System Events 로 창을 옮긴다: 손쉬운 사용이 없어도, 자동화를 거부했어도 되지 않는다.
  if (summary) summary.split_available = raise ? false : r.values?.split_available ?? null
  const askClick = Boolean(summary?.ovis?.some((o) => o.confirmed))
  return {
    at: r?.at ?? null,
    platform: r?.platform ?? null,
    summary,
    lanes: r?.lanes ?? [],
    raise_warning: raise,
    raise_warning_app: herdr.raiseWarningApp(),
    client_defaults: clientDefaultsOf(db),
    first_run: { show: !readonly() && !getMeta(db, 'firstrun.done'), ask_click: askClick, choices: TEXT_SETTINGS.click_target.choices, done_at: getMeta(db, 'firstrun.done') || null },
    // 첫 실행 안내와 설정이 미리 골라 둘 지금 값과 그 출처(사람이 정한 값인지 자동 감지인지).
    chosen: Object.fromEntries(FIRST_RUN_KEYS.map((k) => [k, { value: getSettings(db)[k], origin: settingOrigins(db)[k] }])),
  }
}
// 첫 실행 안내에서 고르는 항목: 세션을 여는 곳, 터미널 앱, Herdr 앱 세션을 여는 곳, 세션을 열 때 실행할 명령.
// 창 올리기 권한 경고(F5·F6). raise_warning = 종류('mac_accessibility' | 'mac_automation', 없으면 null — 켜는 곳이 달라 한데 묶지
// 않는다), raise_warning_app = 권한 대상 앱 이름(macOS 권한 창이 말하는 주체 = 이 서버를 띄운 앱, 경고가 없으면 null).
// 문구는 화면이 이 두 값으로 만든다. 창을 올리는 조작(카드 누르기·새 세션·이어서 열기·데스크 켜기)의 성공 응답에도 경고가 떠 있는
// 동안 같은 두 값을 싣는다 — 창을 다 올리지 못했는데 "성공"만 말해 보드가 조용한 일이 없게.
export const raiseInfo = () => ({ raise_warning: herdr.raiseWarning(), raise_warning_app: herdr.raiseWarningApp() })
export const withRaiseWarning = (r) => (r?.ok && herdr.raiseWarning() ? { ...r, ...raiseInfo() } : r)
export const FIRST_RUN_KEYS = ['click_target', 'front_app', 'core_target', 'agent_cmd']
// 설정이 바뀌면 창 올리기 쪽(herdr·herdr-core)에 곧바로 알린다(재시작 없음).
export function applyLiveSettings(db) {
  herdr.setFrontApp(...frontAppChoice(db))
  core.setOpenIn(getSettings(db).core_target)
}
// 첫 실행 안내에서 고른 것을 사람이 정한 값으로 저장한다(click_target → 설정 값). 고르지 않고 "이대로 시작"이면 표시만 남긴다.
// choices = { click_target, front_app, core_target, agent_cmd } 중 고른 것만(null·'' = 자동으로 되돌림). choice는 옛 모양(click_target 하나).
export function firstRunDone(db, choice, choices) {
  const patch = {}
  if (choice !== undefined && choice !== null) patch.click_target = choice
  if (choices && typeof choices === 'object') {
    for (const [k, v] of Object.entries(choices)) {
      if (!FIRST_RUN_KEYS.includes(k)) return { ok: false, errors: [`unknown choice ${k}`] }
      patch[k] = v
    }
  }
  if (Object.keys(patch).length) {
    const r = setSettings(db, patch)
    if (!r.ok) return r
    applyLiveSettings(db)
  }
  setMeta(db, 'firstrun.done', new Date().toISOString())
  return { ok: true, settings: getSettings(db), client_defaults: clientDefaultsOf(db) }
}

// 설치 셋업(scripts/setup.mjs)이 터미널에서 받은 답(<설정 폴더>/setup.json)을 가져온다: 첫 실행 안내에서 고른 것과 같은 경로
// (firstRunDone — 사람이 정한 값으로 저장 + firstrun.done 표시)라서 보드가 같은 것을 다시 묻지 않는다. 고른 값이 없는 파일은 표시하지 않는다
// — 다만 "done" 표시가 있는 파일(셋업이 질문을 끝까지 받았다 — Enter만 쳤어도)은 고른 값이 없어도 마친 것으로 적는다(설정은 바꾸지 않는다).
// 파일의 at이 DB meta 'setup.imported_at'과 같으면 이미 가져온 것이라 건너뛴다. 모르는 항목·틀린 값은 그 항목만 버린다.
// 읽기 전용 보기에서는 적용하지 않는다. 파일은 그대로 둔다(셋업만 쓴다).
export function importSetup(db, file) {
  if (readonly()) return { ok: false, code: 'read_only' }
  const s = file ? readSetup(file) : null
  if (!s) return { ok: false, code: 'no_setup' }
  if (getMeta(db, 'setup.imported_at') === s.at) return { ok: true, imported: false }
  const clean = {}, dropped = []
  for (const [k, v] of Object.entries(s.choices)) {
    if (FIRST_RUN_KEYS.includes(k) && (v === null || v === '' || validTextSetting(k, v))) clean[k] = v
    else dropped.push(k)
  }
  // 고른 값이 하나도 없고 done 표시도 없으면 첫 실행 안내를 마친 것으로 적지 않는다(손으로 둔 빈 파일·옛 셋업 대비).
  // 보드를 처음 열 때 첫 실행 안내가 그때 감지한 것으로 묻는다. 같은 파일을 다시 읽지 않도록 가져온 표시만 남긴다.
  // done 표시만 있는 파일: firstRunDone이 고칠 값 없이 firstrun.done만 적는다(값은 자동 감지를 따른다).
  if (Object.keys(clean).length || s.done) {
    const r = firstRunDone(db, undefined, clean)
    if (!r.ok) return { ok: false, code: 'rejected', errors: r.errors }
  }
  setMeta(db, 'setup.imported_at', s.at)
  return { ok: true, imported: true, at: s.at, applied: Object.keys(clean), dropped }
}
export const SETUP_CHECK_MS = 2000

// 보드에서 상태를 바꾼 직후 한 번 바로 수집한다 — 다음 수집 주기(3초)를 기다리지 않고 판이 따라오게.
const collectNow = async (db) => { try { await collectAll(db, { source: 'board' }) } catch {} }

export const FIRST_RUN_REDETECT_MS = 5000
const HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url))
// 화면 판본: 보드 HTML이 바뀐 채로 서버가 다시 뜨면 열려 있던 탭이 스스로 새로고침한다.
const BUILD = String(statSync(HTML_PATH).mtimeMs | 0)
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const readonly = () => process.env.WHOSUP_READONLY === '1'

// 세션이 닫혔음을 아는 즉시 최근 닫힘으로(수집이 연속 미검출을 세기 전에) — 보드가 바로 따라오게.
export function markGoneNow(db, id, at = new Date().toISOString()) {
  noteChange()   // 이보다 먼저 읽기 시작한 수집이 이 세션을 되살리지 않게
  db.prepare("UPDATE session SET archived = 1, status = 'gone', unreachable = 0, miss_count = 0, updated_at = ? WHERE id = ? AND archived = 0").run(at, id)
  db.prepare('INSERT INTO event (session_id, at, field, before, after, source) VALUES (?, ?, ?, ?, ?, ?)').run(id, at, 'gone', 'false', 'true', 'board')
}

// 런타임이 던진 오류가 "그 세션은 이미 닫혔다"는 뜻인가(그때만 세션을 최근 닫힘으로 옮긴다).
// herdr-core 세션은 오류의 종류(code)로만 가린다: 'terminal_not_found' = 그 코어가 그 터미널이 없다고 답했다. 코어에 닿지 못했거나
// 지금 읽지 않는 코어('core_unavailable')는 닫힌 것이 아니다 — 문구에 "not found" 가 들어 있다고 닫힘으로 보내지 않는다.
// herdr 세션은 예전 그대로 herdr 가 답한 문구(pane_not_found)로 가린다.
const closedErr = (s, err) => (s.runtime === core.name ? err?.code === 'terminal_not_found' : /pane_not_found|not found/i.test(String(err?.message)))
// 그 세션을 만들 때의 터미널(런타임이 알려 준 incarnation). 조작할 때 함께 넘겨, 같은 주소를 물려받은 다른 터미널을
// 옛 세션으로 열거나 닫지 않게 한다(herdr 런타임의 세션에는 값이 없고, herdr 런타임은 이 값을 쓰지 않는다).
const incarnationOf = (s) => { try { return JSON.parse(s.fields_json || '{}').incarnation ?? null } catch { return null } }
// 그 세션·데스크에서는 할 수 없는 일(앱 안의 세션으로 보낼 수단이 없는 herdr-core 코어의 세션: 닫기·새 세션·이어서 열기·끄고 켜기).
// 화면이 단추를 숨기는 것과 따로, 서버 경로가 여기서 거절하고 이유 코드를 돌려준다.
const NOT_SUPPORTED = { ok: false, code: 'not_supported', message: 'the board cannot do that for sessions of this app — do it in the app itself' }
// 까닭이 있는 거절(자기 서버로 코어를 보여 주는 앱의 세션): app_required = 그 앱이 꺼져 있다(켜면 된다) · token_required = 그 앱의 서버가
// 토큰·로그인 없이는 조작을 받지 않는다 · app_no_answer = 그 앱의 서버가 시간 안에 답하지 않았다(됐는지 모른다). app = 그 앱 이름(모르면 null).
// 첫 문(whyNot·whyNotDesk — 코어 프로필의 "되는 기능"으로 묻지 않고 답한다)과 런타임이 일을 하다 던진 오류(reasoned)가 같은 코드·같은
// 앱 이름으로 답한다. 조용히 성공으로 답하지 않는다. 화면 문구는 index.html 의 codes.
const REASONED = new Set(['app_required', 'token_required', 'app_no_answer'])
const reasoned = (err) => (err && REASONED.has(err.code) ? { ok: false, code: err.code, app: err.app ?? null, message: String(err.message).slice(0, 300) } : NOT_SUPPORTED)
const whyNot = (s, cap) => (s.runtime === core.name ? reasoned(core.refusalOf(s.runtime_ref, cap)) : NOT_SUPPORTED)
const whyNotDesk = (desk) => (core.isDesk(desk) ? reasoned(core.refusalOfDesk(desk, 'new')) : NOT_SUPPORTED)
// 그 일을 무엇으로 했는가(means)와, 그 세션을 브라우저에서 여는 주소(url — 자기 서버로 보여 주는 앱의 세션이고 그 서버가 지금 살아 있을 때만).
// 런타임이 알려 준 것만 답에 싣는다. url 은 이번에 찾은 포트로 만든 것이다: 화면이 방금 연 탭의 포트가 낡았으면 이 주소로 다시 보낸다.
// opened = 그 세션을 어느 길로 보였는가(런타임이 알려 줄 때만): 'app_link' 그 앱의 링크로 앱 창에서 · 'browser' 링크가 실패해 이 서버가
// 그 세션의 주소를 브라우저 탭으로 열었다(그때는 화면이 앱 이름과 함께 그렇다고 덧붙인다 — app).
const viaOf = (r, fallback = null) => {
  const means = r?.means || (r?.url ? 'open_url' : fallback)
  const opened = r?.opened === 'app_link' || r?.opened === 'browser' ? r.opened : null
  return { ...(r?.url ? { url: r.url } : {}), ...(means ? { means } : {}), ...(opened ? { opened } : {}), ...(opened === 'browser' ? { app: r.app || null } : {}) }
}
const shownBy = (r) => (r?.opened === 'app_link' ? ' (shown in the app window by its link)' : r?.opened === 'browser' ? ' (the app link did not work: opened in a browser tab)' : '')
// 마지막 클릭만 이긴다 — 런타임이 달라도. 런타임마다 자기 클릭만 세므로, 판 전체의 순번은 여기서 본다.
// 화면이 보내는 순번(seq)은 그 브라우저의 시계로 만든다 — 브라우저끼리는 시계가 달라 견줄 수 없다(한쪽이 1분 빠르면 다른 쪽
// 클릭이 1분 동안 다 무시됐다). 그래서 순번은 보낸 브라우저(client) 안에서만 견주고, 런타임에는 서버가 도착 순서로 매긴
// 순번(브라우저 사이에서는 도착 순서)을 넘긴다. client 를 보내지 않는 예전 화면은 하나의 브라우저로 본다.
const latestByClient = new Map()
let latestSeq = 0
// web: 이 클릭을 한 브라우저가 그 세션의 웹 터미널 탭을 열었는가(true·false, 알려 주지 않았으면 undefined). 서버 화면의 창을
// 올리지 않는 클릭에서 "그 세션을 봤다"고 적을지를 런타임이 이것으로 가린다(herdr-core 런타임의 focus).
export async function openSession(db, id, seq, /** @type {{ raise?: boolean, web?: boolean, client?: string }} */ { raise = true, web, client = '' } = {}) {
  const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
  if (!s) return { ok: false, code: 'no_session', message: `no session ${id}` }
  if (s.archived) return { ok: false, code: 'closed', message: 'that session is closed — use resume' }
  const rt = runtimeOf(s.runtime)
  if (!rt) return { ok: false, code: 'no_session', message: `no session ${id}` }
  // 같은 브라우저의 더 나중 클릭이 먼저 도착했으면 이 클릭은 진다. 이긴 클릭에는 서버의 도착 순번(order)을 매긴다.
  const key = String(client || '')
  if (Number.isFinite(seq) && seq < (latestByClient.get(key) ?? -Infinity)) return { ok: true, code: 'superseded', window: 'superseded', message: `skipped ${s.runtime_ref} (a newer click won)` }
  let order
  // 런타임에는 화면의 순번을 그대로 넘기되, 시계가 늦은 다른 브라우저의 클릭은 바로 앞 클릭보다 크게 올린다(도착 순서를 지킨다).
  // 브라우저가 하나면 예전과 같은 값이 간다.
  if (Number.isFinite(seq)) { latestByClient.set(key, seq); order = latestSeq = Math.max(seq, latestSeq + 1) }
  const older = () => order !== undefined && order < latestSeq
  let r
  try { r = await rt.focus(s.runtime_ref, { cwd: s.cwd || undefined, seq: order, split: getSettings(db).split_pct, raise, web, incarnation: incarnationOf(s), superseded: older }) } catch (err) {
    // 터미널에서 이미 닫은 세션(수집이 아직 못 따라온 3~9초): 오류 대신 바로 최근 닫힘으로 옮긴다.
    if (closedErr(s, err)) { markGoneNow(db, s.id); return { ok: true, code: 'pane_gone', message: `${s.runtime_ref} was already closed` } }
    // 지금 읽지 않는 herdr-core 코어의 세션(읽을 코어 목록에서 빠졌다): 그 코어에 물어보지 못했으니 닫힌 것으로 치지 않는다. 세션은 그대로
    // 두고(수집이 판정한다) 확인할 수 없다고 답한다 — 아무 창도 올리지 않았다. (코어가 꺼져 소켓이 죽은 경우는 런타임이 app_closed 로 답한다.)
    if (err?.code === 'core_unavailable') return { ok: false, code: 'core_unavailable', message: `the herdr-core core of that session cannot be checked right now: nothing was opened and the session is left as it is (${s.runtime_ref})` }
    throw err
  }
  if (r.window === 'superseded') return { ok: true, code: 'superseded', window: r.window, message: `skipped ${r.session} ${r.pane} (a newer click won)` }
  // 앱 안의 그 세션으로 보낼 수단이 없는 앱의 세션: 앱 창만 올렸다 / 앱이 꺼져 있어 올리지 않았다(켜지 않는다 — 그 앱의 코어가
  // 꺼져 있을 때도 이 답이다) / 창 올리기가 꺼져 있거나 이 운영체제에서는 할 수 없다 / 앱은 떠 있는데 올리기가 오류로 실패했다.
  // 앱 이름을 모르는 코어(프로필에 app 이 없다)도 같은 코드로 답한다: app 은 null 이다. 그런 코어가 꺼져 있을 때는(app_closed) 켤 "앱"을
  // 알지 못하므로 앱이 아니라 코어가 꺼져 있다고 답한다(화면 문구도 같다 — index.html codes.app_closed).
  // 그 앱의 서버가 지금 살아 있으면 어느 답에든 그 세션의 주소(url)를 싣는다: 창을 올리지 못한 답이어도 화면이 연 탭은 그 세션을 보여 준다.
  const app = r.app || 'the app'
  if (r.window === 'app_only') return { ok: true, code: 'focused_app_only', window: r.window, app: r.app, ...viaOf(r, 'app_window'), message: `brought the ${app} window forward (${r.session} ${r.pane} — pick the session inside the app)` }
  if (r.window === 'app_closed') return { ok: true, code: 'app_closed', window: r.window, app: r.app, ...viaOf(r), message: `${r.app || 'the herdr-core core of that session'} is not running: no window was brought forward (${r.session} ${r.pane})` }
  if (r.window === 'unsupported') return { ok: true, code: 'app_raise_unsupported', window: r.window, app: r.app, ...viaOf(r), message: `could not bring ${app} forward: window raising is off or not supported on this system (${r.session} ${r.pane})` }
  if (r.window === 'app_failed') return { ok: true, code: 'app_raise_failed', window: r.window, app: r.app, ...viaOf(r), message: `${app} is running, but its window could not be brought forward — switch to the app yourself (${r.session} ${r.pane})` }
  const code = r.client === 'started' ? 'focused_started' : r.window === 'opened' ? 'focused_opened' : 'focused'
  return { ok: true, code, window: r.window, ...viaOf(r), message: `focused ${r.session} ${r.pane}${r.client === 'started' ? ' (desk started)' : ''}${r.window === 'opened' ? ' (opened a terminal window)' : ''}${shownBy(r)}` }
}

// Empty session (shell) after a restart: resume the newest conversation for that folder, or start fresh.
// A closed (gone) session: open a new tab in the same desk and resume its conversation there.
// 같은 세션에 대한 요청이 진행 중이면 두 번째는 무시한다(연타 방지 — 재개 명령이 에이전트 입력으로 두 번 들어가지 않게).
const inflight = new Set()
// 같은 대화를 서로 다른 두 세션에서 동시에 이어 열지 않는다: 이어 열기 시작한 대화는 잠시 잡아 둔다(수집이 그 대화가
// 어느 세션에서 살아났는지 알게 될 때까지 — 그 뒤로는 재개 후보 규칙이 다른 세션에서 그 대화를 빼 준다).
// 같은 세션에서 다시 누르는 것은 막지 않는다(그 세션의 연타는 위 inflight가 본다). 풀어 주는 시간은 명령을 넣는 일이 끝난
// 때부터 센다 — 만들기가 줄을 서서 오래 걸려도 그 사이에 풀리지 않게.
const resuming = new Map()   // 대화 id → { id: 잡은 세션, timer }
const RESUME_HOLD_MS = 10000
const heldByOther = (sid, id) => Boolean(sid) && resuming.has(sid) && resuming.get(sid).id !== id
const holdSid = (sid, id) => { clearTimeout(resuming.get(sid)?.timer); resuming.set(sid, { id, timer: null }) }
const releaseLater = (sid) => { const h = resuming.get(sid); if (!h) return; clearTimeout(h.timer); h.timer = setTimeout(() => { if (resuming.get(sid) === h) resuming.delete(sid) }, RESUME_HOLD_MS); h.timer.unref?.() }
const dropSid = (sid) => { clearTimeout(resuming.get(sid)?.timer); resuming.delete(sid) }
export const _clearResumeHolds = () => { for (const sid of [...resuming.keys()]) dropSid(sid) }   // 시험
export const _clearInflight = () => inflight.clear()   // 시험: 연타 방지(3초)가 새 DB 의 같은 번호 세션에 걸리지 않게
// shownSid: 판이 보여 준 재개 대상(undefined면 옛 탭 — 비교하지 않는다). 다시 계산한 값과 다르면 실행하지 않는다(I-3).
// 런타임에 시킨 일(명령 넣기·새 탭)이 끝나면 — 실패해도 — 판을 직접 바꿨다고 알린다(noteChange): 그보다 먼저 읽기 시작한 수집이
// 바꾸기 전의 목록을 적용하지 않고 다시 읽는다. 새 세션·데스크 켜고 끄기도 같다(아래 POST 경로).
export async function resumeSession(db, id, shownSid, { raise = true } = {}) {
  if (inflight.has(id)) return { ok: false, code: 'busy', message: 'already resuming that session' }
  inflight.add(id)
  try {
    const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
    if (!s) return { ok: false, code: 'no_session', message: `no session ${id}` }
    const cmd = getSettings(db).agent_cmd
    const rows = db.prepare('SELECT id, status, archived, provider_session FROM session WHERE archived = 0').all()
    const sid = resumeFor(rows, s, cmd)?.sid ?? null
    if (shownSid !== undefined && (shownSid || null) !== sid) return { ok: false, code: 'resume_changed', message: 'the conversation to resume changed — check the board and try again' }
    const run = sid ? `${cmd} --resume ${sid}` : cmd
    const rt = runtimeOf(s.runtime)
    if (!rt) return { ok: false, code: 'no_session', message: `no session ${id}` }
    if (!allowed(s, 'resume')) return whyNot(s, 'resume')
    if (s.archived && s.status === 'gone') {
      if (heldByOther(sid, id)) return { ok: false, code: 'busy', message: 'that conversation is already being resumed in another session' }
      if (sid) holdSid(sid, id)
      let r
      try { r = await rt.newSession({ session: deskOf(s), cwd: s.cwd || homedir(), command: run, raise }) } catch (err) { if (sid) dropSid(sid); throw err } finally { noteChange() }
      if (sid) releaseLater(sid)
      markReopened(db, s.id)
      return { ok: true, code: sid ? 'resumed' : 'started', ...viaOf(r), message: sid ? `resuming ${sid.slice(0, 8)} in a new tab (${r.pane})` : `started ${cmd} in a new tab (${r.pane})`, resumed: Boolean(sid) }
    }
    if (s.status !== 'shell' && s.status !== 'idle' && s.status !== 'unknown') return { ok: false, code: 'has_agent', message: 'that session already has an agent' }
    if (heldByOther(sid, id)) return { ok: false, code: 'busy', message: 'that conversation is already being resumed in another session' }
    if (sid) holdSid(sid, id)
    let r
    try { r = await rt.focus(s.runtime_ref, { cwd: s.cwd || undefined, run, raise, incarnation: incarnationOf(s) }) } catch (err) { if (sid) dropSid(sid); throw err } finally { noteChange() }
    if (sid) releaseLater(sid)
    return { ok: true, code: sid ? 'resumed' : 'started', ...viaOf(r), message: sid ? `resuming ${sid.slice(0, 8)} in ${r.pane}` : `started ${cmd} in ${r.pane}`, resumed: Boolean(sid) }
  } finally {
    setTimeout(() => inflight.delete(id), 3000)
  }
}

// 꺼 둔 Herdr 앱 데스크를 다시 켠다: 같은 이름·폴더로 공간을 만들고, 끌 때 열려 있던 대화를 이어서 연다.
// 옛 세션(끝난 터미널)은 'reopened'로 접는다 — 새 터미널은 수집이 새 세션으로 잡는다.
export async function startCoreDesk(db, desk, { raise = true } = {}) {
  const cmd = getSettings(db).agent_cmd
  const all = db.prepare('SELECT * FROM session WHERE archived = 0').all()
  const off = all.filter((r) => r.runtime === core.name && r.unreachable === 2 && deskOf(r) === desk)
  const others = all.filter((r) => !off.includes(r))
  const commands = []
  for (const r of off) {
    if (!r.provider_session) continue
    const t = resumeFor(others, r, cmd)
    if (t?.from === 'pane') commands.push({ id: r.id, cwd: r.cwd, command: `${cmd} --resume ${t.sid}` })   // 그 세션의 대화만 — 폴더의 다른 대화로 대신하지 않는다
  }
  const r = await core.startSession(desk, undefined, { raise, commands })
  // 이어 열지 못한 대화의 옛 세션은 접지 않는다: 다음 수집이 닫힌 세션으로 옮기고, 거기서 하나씩 이어 열 수 있다.
  const failed = new Set(r.failed || [])
  const at = new Date().toISOString()
  const fold = db.prepare("UPDATE session SET archived = 1, status = 'reopened', unreachable = 0, updated_at = ? WHERE id = ?")
  for (const row of off) if (!failed.has(row.id)) fold.run(at, row.id)
  return r
}
// 한 데스크를 끄거나 켜는 요청은 그 뒤의 수집까지 끝나야 다음 것을 받는다: 끄자마자 켜면 판(DB)이 아직 꺼진 줄을 모르고,
// 이어 열 대화를 하나도 찾지 못한 채 빈 공간만 만든다.
const deskBusy = new Set()

// POST는 이 보드 페이지(같은 주소·같은 포트)만 받는다 — 공개판의 신뢰 모델 그대로. remote-click의 '포트가 달라도 루프백이면 허용'은
// 신뢰 범위를 넓히는 결정이라 여기서는 들이지 않았다(오너 결정 대기). Origin이 없으면(curl 등 브라우저 밖) 통과.
export function sameOrigin(req) {
  const origin = req.headers.origin
  const port = req.socket.localPort
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}
// 요청 본문 읽기. 한도(BODY_MAX 바이트 — 글자 수가 아니다)를 넘으면 더 쌓지 않고 거기서 그만 읽는다(code 'body_too_large'):
// Content-Length 가 한도를 넘으면 한 바이트도 읽지 않고 거절하고, 길이를 알리지 않고 흘려보내는 요청(chunked)은 받은 바이트를 세다가
// 넘는 순간 쌓아 둔 것을 버리고 읽기를 멈춘다. 부른 쪽이 413 으로 답하고 연결을 끊는다 — 거절한 뒤에도 계속 받아 메모리에 쌓지 않는다.
export const BODY_MAX = 4096
const tooLarge = () => Object.assign(new Error('body too large'), { code: 'body_too_large' })
export function readBody(req) {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length']) > BODY_MAX) return reject(tooLarge())
    const chunks = []
    let size = 0
    let over = false
    req.on('data', (c) => {
      if (over) return
      size += c.length
      if (size <= BODY_MAX) { chunks.push(c); return }
      over = true
      chunks.length = 0
      req.pause()
      reject(tooLarge())
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

// 새 세션 창의 폴더 고르기: 홈 아래만, 숨김 폴더는 빼고, 이름순. 경로를 손으로 칠 필요가 없게 한다.
const HOME = homedir()
// Windows 경로(C:\\Users\\…)도 받도록 구분자 대신 relative로 판정 (Windows 실기기 QA: 폴더 탐색이 400)
// 윈도우 경로는 대소문자를 가리지 않는다: c:\users\me 도 홈 자체로 본다(REPORT 14번).
const sameDir = (a, b) => (isWindows() ? a.toLowerCase() === b.toLowerCase() : a === b)
const underHome = (p) => { const r = relative(HOME, p); return sameDir(p, HOME) || (!!r && !r.startsWith('..') && !isAbsolute(r)) }
// 앞의 "~"·"~/" 는 홈 폴더다: 폴더 고르기·카드는 경로를 ~ 로 보여 주므로 사람이 그대로 쳐 넣는다(실기기 — ~/my-first-project 가 no_folder).
// 그 밖의 "~"(~user, ~x)는 건드리지 않는다. 문자열이 아니면 그대로 돌려준다(뒤의 검사가 거절한다).
// 윈도우에서는 "~\…" 도 같다(그쪽 경로 구분자).
export const expandHome = (p) => (typeof p !== 'string' ? p : p === '~' ? HOME : p.startsWith('~/') || (isWindows() && p.startsWith('~\\')) ? join(HOME, p.slice(2)) : p)
export function listDirs(path) {
  const p = resolve(path)
  if (!underHome(p)) return { ok: false, message: 'only folders under home' }
  let names = []
  try { names = readdirSync(p, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && (d.isDirectory() || (d.isSymbolicLink() && !isWindows() && isDir(join(p, d.name))))).map((d) => d.name) }
  catch (err) { return { ok: false, message: String(err.code || err.message) } }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return { ok: true, path: p, parent: sameDir(p, HOME) ? null : dirname(p), home: HOME, sep, dirs: names.slice(0, 500), more: Math.max(0, names.length - 500) }
}
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
// 최근에 세션이 열렸던 폴더(지금도 있는 것만), 최근 활동 순.
export function recentFolders(db, limit = 12) {
  const rows = db.prepare(`SELECT cwd, MAX(COALESCE(last_user_msg_at, '')) AS t, MAX(updated_at) AS u FROM session WHERE cwd != '' GROUP BY cwd ORDER BY t DESC, u DESC LIMIT 60`).all()
  return rows.map((r) => r.cwd).filter((c) => underHome(c) && !sameDir(c, HOME) && existsSync(c)).slice(0, limit)
}

/**
 * @typedef {{ heartbeatPath?: string, redetect?: () => Promise<any>, setupFile?: string, onSetup?: (...args: any[]) => any }} BoardServerOpts
 * @typedef {import('node:http').Server & { notifyChange?: (...args: any[]) => any }} BoardServer
 */
/** @returns {BoardServer} */
export function createBoardServer(db, /** @type {BoardServerOpts} */ { heartbeatPath, redetect, setupFile, onSetup } = {}) {
  // 다시 감지: redetect()는 실행 환경을 다시 확인해 자동 값을 갈아 끼운다(bin/whosup.mjs가 넘긴다). 한 번에 하나만 돈다.
  // 서버 밖에서 도는 감지(시작할 때의 첫 감지·등록부 지켜보기·코어 이름 다시 묻기)와는 넘겨받은 redetect 가 줄을 세운다
  // (bin/whosup.mjs 의 감지 줄 — autoconf.mjs detectLine): 여기서 부른 감지도 그 줄 끝에 서서, 앞선 감지가 끝난 뒤에 돈다.
  let detecting = null
  let detectedAt = Date.now()
  const detectNow = () => {
    if (!redetect) return Promise.resolve(false)
    detecting ||= Promise.resolve().then(redetect).then(() => { applyLiveSettings(db); return true }, () => false).finally(() => { detecting = null; detectedAt = Date.now() })
    return detecting
  }
  // 첫 실행 안내를 아직 확인하지 않았으면, 보드보다 늦게 뜬 것(웹 터미널 등)을 놓치지 않게 화면이 물을 때마다 다시 감지한다(5초에 한 번까지).
  const detectIfPending = async () => { if (redetect && !readonly() && !getMeta(db, 'firstrun.done') && Date.now() - detectedAt > FIRST_RUN_REDETECT_MS) await detectNow() }
  // 열려 있는 보드 탭(SSE). 판이 바뀌면 notifyChange()가 한 줄 밀어 주고, 탭은 그때 바로 새로 읽는다.
  const clients = new Set()
  const notify = () => { for (const c of clients) c.write(`data: ${Date.now()}\n\n`) }
  // 창 올리기 권한 경고가 생기거나 지워지면 열려 있는 탭에 바로 알린다(정밀 올리기는 클릭 응답 뒤에 끝난다).
  const offRaiseWarning = herdr.onRaiseWarning(notify)
  // 가려진 탭이라도 붙어 있으면 그 사실을 적어 둔다 — herdr가 켜질 때 탭을 또 열지 않게(plugin.sh).
  const connectedPath = heartbeatPath ? join(dirname(heartbeatPath), 'board-connected') : null
  const touchConnected = () => { if (connectedPath && clients.size) { try { writeFileSync(connectedPath, new Date().toISOString()) } catch {} } }
  // 설치 셋업의 답(setupFile = <설정 폴더>/setup.json, bin/whosup.mjs가 넘긴다): 시작할 때 한 번, 그 뒤로는 화면이 물을 때
  // 가볍게(SETUP_CHECK_MS에 한 번 stat) 본다 — 보드가 떠 있는 동안 손으로 다시 셋업해도 재시작 없이 들어온다.
  let setupMtime = null
  let setupCheckedAt = 0
  const checkSetup = (force = false) => {
    if (!setupFile || readonly()) return
    const now = Date.now()
    if (!force && now >= setupCheckedAt && now - setupCheckedAt < SETUP_CHECK_MS) return
    setupCheckedAt = now
    try {
      const m = statSync(setupFile).mtimeMs
      if (m === setupMtime) return
      const r = importSetup(db, setupFile)
      if (r.code !== 'read_only') setupMtime = m
      if (r.imported) { onSetup?.(r); notify() }
    } catch {}
  }
  checkSetup(true)
  applyLiveSettings(db)   // 터미널 앱: 설정에서 정한 값 > FRONT_APP > ''(자동, 자동 감지한 앱은 따로). Herdr 앱 세션을 여는 곳도 함께.
  const beat = setInterval(() => { touchConnected(); for (const c of clients) c.write(': ping\n\n') }, 5000)
  beat.unref()
  // 건강 응답에 싣는 이 설치의 표식: 이 보드가 쓰는 상태 폴더에서 만든다(heartbeatPath가 그 폴더 안에 있다 — bin/whosup.mjs).
  const instance = instanceOf(heartbeatPath ? dirname(heartbeatPath) : STATE_DIR)
  /** @type {BoardServer} */
  const server = createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    try {
      if (!LOCAL_HOST.test(req.headers.host || '')) return send(403, JSON.stringify({ error: 'local only' }))
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/') return send(200, readFileSync(HTML_PATH), 'text/html; charset=utf-8')
      // health는 '후즈업 프로세스가 답하는가'만 말한다. herdr에 닿지 못해도 200이고, 그 사정은 herdr_error에 싣는다.
      // 맨 앞의 app · instance · pid = 이 답이 후즈업 보드의 것이고 어느 상태 폴더의 보드인지(src/paths.mjs instanceOf), 그 보드의 PID.
      // 실행기·설치기·whosup stop이 "그 포트가 답한다"가 아니라 이 값으로 판단한다(다른 서버가 그 포트에서 200을 줘도 보드로 보지 않는다).
      // 세 값은 이 순서로 맨 앞에 붙여 둔다: scripts/plugin.sh가 글자로 견준다.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        let sessions = null, herdrError
        try { sessions = await herdr.runningSessionsAsync() } catch (err) { herdrError = String(err.message || err).slice(0, 300) }
        // targets = 새 세션을 열 수 있는 데스크(herdr 세션 + Herdr 앱 공간). 화면은 이 목록을 쓰고, herdr는 옛 화면·점검용으로 남긴다.
        let targets = (sessions || []).map((n) => ({ key: n, label: n }))
        if (core.available()) {
          const known = db.prepare('SELECT * FROM session WHERE runtime = ? AND archived = 0 AND unreachable = 0').all(core.name).map((r) => ({ key: deskOf(r), label: deskLabelOf(r) }))
          try { targets = targets.concat(await core.targets(known, { perFeature: true })) } catch {}   // perFeature: /api/new 의 문이 기능별(deskAllowed(session, 'new'))이라 그 문이 받는 데스크를 모두 내놓는다
        }
        return send(200, JSON.stringify({ ok: true, app: BOARD_APP, instance, pid: process.pid, readonly: readonly(), herdr: sessions, targets, ...(herdrError ? { herdr_error: herdrError } : {}) }))
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        // 브라우저는 한 주소에 연결을 6개까지만 연다. 탭을 여러 개 띄워도 일반 요청이 막히지 않게 4개까지만 받고,
        // 그 뒤 탭은 204로 돌려보낸다(EventSource가 다시 붙지 않고, 그 탭은 3초 주기로만 읽는다).
        if (clients.size >= 4) { res.writeHead(204, { 'cache-control': 'no-store' }); return res.end() }
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        res.write(': ok\n\n')
        clients.add(res); touchConnected()
        req.on('close', () => clients.delete(res))
        return
      }
      if (req.method === 'GET' && url.pathname === '/api/warm') { if (!readonly()) herdr.warmClick(); return send(200, '{"ok":true}') }
      if (req.method === 'GET' && ['/api/board', '/api/autoconf', '/api/settings'].includes(url.pathname)) checkSetup()
      if (req.method === 'GET' && url.pathname === '/api/settings') return send(200, JSON.stringify({ settings: getSettings(db), ranges: SETTING_RANGES, sources: settingSources(db), origins: settingOrigins(db), detected: await herdr.detectTerminal(), autoconf: autoconfView(db) }))
      if (req.method === 'GET' && url.pathname === '/api/autoconf') { await detectIfPending(); return send(200, JSON.stringify(autoconfView(db))) }
      // 읽기 전용이면 새 세션 열기가 막혀 있으므로 홈 아래 폴더 목록도 내주지 않는다.
      if (req.method === 'GET' && (url.pathname === '/api/folders' || url.pathname === '/api/dirs') && readonly()) return send(403, JSON.stringify({ error: 'read-only', code: 'read_only' }))
      if (req.method === 'GET' && url.pathname === '/api/folders') return send(200, JSON.stringify({ home: homedir(), recent: recentFolders(db) }))
      if (req.method === 'GET' && url.pathname === '/api/dirs') { const r = listDirs(url.searchParams.get('path') || homedir()); return send(r.ok ? 200 : 400, JSON.stringify(r)) }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        if (heartbeatPath && url.searchParams.get('view') === '1') writeFileSync(heartbeatPath, new Date().toISOString())
        // cores = 지금 읽는 herdr-core 코어마다 되는 기능과 수단(core.profilesView — 부를 때마다 코어 프로필에서 다시 계산한다. 포트·주소는 없다).
        let cores = []
        try { cores = core.profilesView() } catch {}
        return send(200, JSON.stringify({ ...(await computeBoardAsync(db, { onLate: notify })), cores, readonly: readonly(), ...raiseInfo(), build: BUILD }))
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(403, JSON.stringify({ error: 'local page only' }))
        // JSON만 받는다: 다른 출처의 페이지는 application/json POST를 보내려면 사전 확인(preflight)을 거쳐야 하고,
        // whosup은 CORS를 허락하지 않으므로 거기서 막힌다. text/plain·form 같은 단순 요청으로 JSON을 흉내 내는
        // CSRF(같은 컴퓨터 다른 포트의 페이지가 agent_cmd를 바꾸는 등)를 이것으로 끊는다(2026-11-09 격리 E2E 재현).
        if (readonly()) return send(403, JSON.stringify({ error: 'read-only', code: 'read_only' }))
        if (!/^application\/json\s*(;|$)/i.test(req.headers['content-type'] || '')) return send(415, JSON.stringify({ error: 'json only' }))
        res.on('finish', notify)   // 한 탭에서 바꾼 것(확인함·고정·보관·닫기)을 다른 탭도 바로 본다
        let raw
        try { raw = await readBody(req) } catch (err) {
          if (err?.code !== 'body_too_large') throw err
          // 한도를 넘은 본문: 413 으로 답하고 그 연결을 끊는다(답이 나간 뒤에 — 보내던 쪽이 계속 흘려보내도 더 받지 않는다).
          res.writeHead(413, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', connection: 'close' })
          return res.end(JSON.stringify({ error: 'body too large', code: 'body_too_large' }), () => req.destroy())
        }
        const body = JSON.parse(raw || '{}')
        const id = body.id
        if (['/api/open', '/api/seen', '/api/unseen', '/api/pin', '/api/stash', '/api/resume', '/api/close'].includes(url.pathname) && !Number.isInteger(id)) return send(400, JSON.stringify({ error: 'id required', code: 'bad_request' }))
        try {
          const raise = body.raise !== false   // 이 클릭을 한 브라우저가 서버 화면의 창을 올려도 되는지(기기별 설정)
          if (url.pathname === '/api/open') { const r = await openSession(db, id, Number(body.seq), { raise, web: typeof body.web === 'boolean' ? body.web : undefined, client: typeof body.client === 'string' ? body.client.slice(0, 64) : '' }); return send(r.ok ? 200 : 409, JSON.stringify(withRaiseWarning(r))) }
          if (url.pathname === '/api/close') {
            const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
            if (!s || s.archived) return send(409, JSON.stringify({ ok: false, code: 'no_session' }))
            if (!allowed(s, 'close')) return send(409, JSON.stringify(whyNot(s, 'close')))
            let done = null
            try { done = await runtimeOf(s.runtime)?.closePane(s.runtime_ref, { incarnation: incarnationOf(s) }) } catch (err) { if (!closedErr(s, err)) throw err }
            markGoneNow(db, s.id); await collectNow(db)
            return send(200, JSON.stringify({ ok: true, code: 'pane_closed', ...(done?.means ? { means: done.means } : {}) }))
          }
          if (url.pathname === '/api/resume') { const r = await resumeSession(db, id, body.sid, { raise }); await collectNow(db); return send(r.ok ? 200 : 409, JSON.stringify(withRaiseWarning(r))) }
          if (url.pathname === '/api/seen') return send(200, JSON.stringify({ ok: true, seen_at: markSeen(db, id) }))
          if (url.pathname === '/api/unseen') { markUnseen(db, id); return send(200, JSON.stringify({ ok: true })) }
          if (url.pathname === '/api/pin') return send(200, JSON.stringify({ ok: true, pinned_at: setPinned(db, id, body.on !== false) }))
          if (url.pathname === '/api/stash') return send(200, JSON.stringify({ ok: true, stashed_at: setStashed(db, id, body.on !== false) }))
          if (url.pathname === '/api/desk') {
            const session = String(body.session || '')
            const rt = runtimeForDesk(session)
            if (!rt.validSessionName(session)) return send(400, JSON.stringify({ ok: false, code: 'bad_request' }))
            if (!deskAllowed(session)) return send(409, JSON.stringify(NOT_SUPPORTED))
            if (deskBusy.has(session)) return send(409, JSON.stringify({ ok: false, code: 'busy', message: 'that desk is already being switched' }))
            deskBusy.add(session)
            try {
              if (body.on === false) { try { await rt.stopSession(session) } finally { noteChange() } await collectNow(db); return send(200, JSON.stringify({ ok: true, code: 'desk_stopped' })) }
              let r
              try { r = rt === core ? await startCoreDesk(db, session, { raise }) : await rt.startSession(session, undefined, { raise }) } finally { noteChange() }
              await collectNow(db); return send(200, JSON.stringify(withRaiseWarning({ ok: true, code: 'desk_started', window: r.window, ...(r.failed?.length ? { not_resumed: r.failed.length } : {}) })))
            } finally { deskBusy.delete(session) }
          }
          // 터미널 앱은 저장하는 즉시 다음 클릭부터 쓴다(재시작 없음).
          if (url.pathname === '/api/settings') { const r = setSettings(db, body.settings); if (r.ok) applyLiveSettings(db); return send(r.ok ? 200 : 400, JSON.stringify(r)) }
          if (url.pathname === '/api/first-run') { const r = firstRunDone(db, body.choice, body.choices); return send(r.ok ? 200 : 400, JSON.stringify(r)) }
          // 다시 감지: 실행 환경을 지금 다시 확인한다(늦게 켠 웹 터미널·새로 설치한 터미널 앱). 사람이 정한 값은 바뀌지 않는다.
          if (url.pathname === '/api/autoconf/refresh') { const ok = await detectNow(); return send(ok ? 200 : 503, JSON.stringify({ ok, ...autoconfView(db) })) }
          if (url.pathname === '/api/new') {
            const { session } = body
            const cwd = expandHome(body.cwd)   // ~ · ~/… 는 홈 폴더(bad_folder·no_folder 검사 앞에서)
            const rt = runtimeForDesk(session)
            if (!rt.validSessionName(session)) return send(400, JSON.stringify({ ok: false, code: 'bad_request' }))
            if (!deskAllowed(session, 'new')) return send(409, JSON.stringify(whyNotDesk(session)))
            if ( typeof cwd !== 'string' || !underHome(resolve(cwd))) return send(400, JSON.stringify({ ok: false, code: 'bad_folder', message: 'a desk (session) and a folder under home are required' }))
            if (!isDir(cwd)) return send(400, JSON.stringify({ ok: false, code: 'no_folder', message: `no such folder: ${cwd}` }))
            let r
            try { r = await rt.newSession({ session, cwd, command: getSettings(db).agent_cmd, raise }) } finally { noteChange() }
            await collectNow(db)
            return send(200, JSON.stringify(withRaiseWarning({ ok: true, code: 'opened_new', ...viaOf(r), message: `opened ${basename(cwd)} in ${session} (${r.pane})${shownBy(r)}` })))
          }
        } catch (err) {
          if (err.code === 'cwd_missing') return send(409, JSON.stringify({ ok: false, code: 'cwd_missing', message: err.message.slice(0, 300) }))
          if (REASONED.has(err.code)) return send(409, JSON.stringify(reasoned(err)))   // 그 앱이 꺼져 있다·토큰이 필요하다·답이 없었다: 까닭 코드와 앱 이름으로
          if (err.code === 'not_supported') return send(409, JSON.stringify(NOT_SUPPORTED))   // 런타임이 스스로 거절했다(위 검사를 지나친 경우의 두 번째 문)
          return send(500, JSON.stringify({ ok: false, code: 'herdr_error', message: err.message.slice(0, 300) }))
        }
      }
      return send(404, JSON.stringify({ error: 'not found' }))
    } catch (err) { return send(500, JSON.stringify({ error: String(err.message).slice(0, 300) })) }
  })
  server.notifyChange = notify
  server.on('close', () => { clearInterval(beat); offRaiseWarning(); for (const c of clients) c.end() })
  return server
}

export function startBoard(db, /** @type {BoardServerOpts & { port?: number }} */ { port = Number(process.env.PORT || 4790), heartbeatPath, redetect, setupFile, onSetup } = {}) {
  const server = createBoardServer(db, { heartbeatPath, redetect, setupFile, onSetup })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
