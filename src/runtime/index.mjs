// 런타임 모음: herdr pane(herdr.mjs)과 herdr-core 터미널(core.mjs). 있는 쪽만 수집하고,
// 세션이 어느 쪽 것인지에 따라 조작(이동·닫기·새 세션·데스크 켜고 끄기)을 그쪽 구현으로 보낸다.
import * as herdr from './herdr.mjs'
import * as core from './core.mjs'
import { collectOnce } from '../collector.mjs'
import { getMeta, setMeta } from '../db.mjs'

const ALL = { [herdr.name]: herdr, [core.name]: core }
// WHOSUP_RUNTIMES: 'auto'(기본 — 있는 것 전부) 또는 쉼표로 고른 이름(herdr, herdr-core).
export function wanted() {
  const v = (process.env.WHOSUP_RUNTIMES || 'auto').trim()
  if (!v || v === 'auto') return Object.keys(ALL)
  return v.split(',').map((x) => x.trim()).filter((n) => ALL[n])
}
export const runtimeOf = (name) => ALL[name] || null
// 데스크 열쇠(herdr 세션 이름 또는 core:<공간>)가 어느 런타임 것인지.
export const runtimeForDesk = (desk) => (core.isDesk(desk) ? core : herdr)
export const deskOf = (row) => (row.runtime === core.name ? core.deskOf(row) : row.runtime_ref.split('/')[0])
export const deskLabelOf = (row) => (row.runtime === core.name ? core.deskLabelOf(row) : row.runtime_ref.split('/')[0])
// 세션에서 할 수 있는 일. 화면은 런타임 이름이 아니라 이것으로 버튼을 정한다. 모르는 런타임의 행은 null(판에 올리지 않는다).
// toggle = 데스크 켜고 끄기. 공간 밖 터미널을 모은 데스크(core:)에는 닫을 공간이 없어서 뺀다.
// herdr-core 세션 가운데 herdr-app 이 다루지 않는 코어의 세션은 그 코어의 "되는 기능"(core.mjs featuresOf — 코어 프로필에서 계산)만큼만
// 된다: 이동과 웹 주소는 늘, 닫기·이어서 열기·새 세션은 수단이 있을 때만(core.capsVia).
//   · 자기 서버로 보여 주는 앱의 코어, 그 앱이 켜져 있다 → 닫기·이어서 열기·새 세션(그 앱의 서버 API)
//   · 같은 코어인데 그 앱이 꺼져 있다                   → 닫기만(코어 소켓으로 직접)
//   · 수단을 모르는 코어·지금 읽지 않는 코어            → 보기 전용(이동·웹 주소뿐 — 예전 그대로)
// 데스크 끄고 켜기(toggle)는 그런 코어에 열지 않았다. 없는 일은 단추도 없고 서버 경로에서도 까닭과 함께 거절한다
// (allowed·deskAllowed — board/server.mjs). 판 계산은 세션마다 이것을 부른다: "지금 읽는 코어" 계산은 그 한 번의 계산 안에서 한 번만 한다(core.mjs plan).
const FULL = ['focus', 'close', 'resume', 'new', 'toggle', 'web']
export function capsOf(row) {
  if (row.runtime === herdr.name) return FULL
  if (row.runtime === core.name) {
    if (!core.canManage(row.runtime_ref)) return ['focus', ...core.capsVia(row.runtime_ref), 'web']
    return core.spaceOfDesk(core.deskOf(row)) === '' ? FULL.filter((c) => c !== 'toggle') : FULL
  }
  return null
}
// 그 세션에서 되는 기능과 수단({ new, focus, close, resume } 마다 { means, reason? }) — herdr-core 세션에만 있다(그 밖에는 null).
// 판의 카드에 실린다(board.mjs): 화면이 "이 세션은 브라우저 탭으로 연다" 같은 것을 이 값으로 가린다. 포트·주소는 들어 있지 않다.
export const featuresOf = (row) => (row.runtime === core.name ? core.featuresOf(row.runtime_ref) : null)
// 서버 경로가 조작을 받기 전에 묻는다: 그 세션(행)에서 그 일을 할 수 있는가 / 그 데스크에서 새 세션(cap 'new')·끄고 켜기(cap 'toggle')를
// 할 수 있는가. 새 세션은 기능별로 본다(core.canNewIn): 자기 서버로 보여 주는 앱의 코어는 끄고 켜기는 안 되어도 새 세션은 된다.
export const allowed = (row, cap) => Boolean(capsOf(row)?.includes(cap))
export const deskAllowed = (desk, cap = 'toggle') => !core.isDesk(desk) || core.canManageDesk(desk) || (cap === 'new' && core.canNewIn(desk))

// 한 번의 수집. 런타임마다 미리 읽은 결과를 수집기에 넘긴다. 없는 런타임(실행 파일·코어 없음)은 그 런타임의 세션이
// DB에 없을 때만 조용히 건너뛴다 — 세션이 있었다면 "확인 불가"로 남겨야 한다(모르면 모른다고 한다).
// 보드에서 세션을 닫는 등 판을 직접 바꾼 일이 있으면 알린다. 그보다 먼저 읽기 시작한 목록은 버리고 다시 읽는다 —
// 닫기 전에 읽은 목록이 닫은 뒤에 적용되면 닫은 세션이 되살아난다(한쪽 런타임 조회가 느릴 때).
// 닫기만이 아니다: 이어서 열기·새 세션·데스크 켜고 끄기도 런타임에 시킨 일이 끝나면(실패해도) 알린다(board/server.mjs) —
// 바꾸기 전의 목록이 뒤늦게 적용되면 방금 이어 연 세션이 다시 셸로, 방금 연 세션이 "안 보임"으로, 꺼 둔 데스크가 켜진 것으로 보인다.
let changes = 0
export const noteChange = () => { changes++ }
// 열린 세션(닫힘으로 가지 않은 행)이 남아 있는 herdr-core 코어 이름들: 세션 ref "<코어 이름>/<주소>" 의 앞 마디.
export const openCoreNames = (db) => [...new Set(db.prepare('SELECT runtime_ref FROM session WHERE runtime = ? AND archived = 0').all(core.name)
  .map((r) => { const i = String(r.runtime_ref).indexOf('/'); return i > 0 ? r.runtime_ref.slice(0, i) : null }).filter(Boolean))]
export async function collectAll(db, opts = {}) {
  const names = wanted()
  // 열린 세션이 남아 있는 코어를 herdr-core 런타임에 알려 준다: 자동 감지 목록에서 빠진 코어(그 코어를 보여 주던 앱이 꺼졌다)도 세션이
  // 남아 있는 동안에는 계속 읽게 — 읽지 않으면 살아 있는 코어의 세션이 닫힘으로 넘어간다(core.mjs keepReading). 수집마다 DB 에서 다시 본다.
  if (names.includes(core.name)) core.keepReading(openCoreNames(db))
  let rts, clean = false
  for (let i = 0; i < 3 && !clean; i++) {
    const seen = changes
    rts = Object.fromEntries(await Promise.all(names.map(async (n) => [n, await ALL[n].snapshotRuntime()])))
    clean = seen === changes
  }
  // 세 번을 읽는 동안에도 판이 계속 바뀌었다: 낡은 목록을 적용하지 않고 이번 수집을 건너뛴다(다음 수집이 곧 온다).
  if (!clean) return { runs: [], runtimes: rts, failure: null, notes: [], skipped: true }
  const rows = (n) => db.prepare('SELECT COUNT(*) AS n FROM session WHERE runtime = ? AND archived = 0').get(n).n
  const h = rts[herdr.name]
  const c = rts[core.name]
  const coreHere = Boolean(c) && !c.absent
  const useCore = Boolean(c) && (coreHere || rows(core.name) > 0 || !h)
  // herdr가 설치되지 않았는데 herdr-core는 있고 herdr 런타임의 세션도 없으면: herdr-core만 쓰는 기계다.
  const useHerdr = Boolean(h) && !(h.absent && useCore && rows(herdr.name) === 0)
  const runs = []
  let failure = null
  if (useHerdr) { try { runs.push({ name: herdr.name, ...collectOnce(db, h, opts) }) } catch (err) { failure = err } }
  if (useCore) { try { runs.push({ name: core.name, ...collectOnce(db, c, { ...opts, health: !useHerdr }) }) } catch (err) { failure ||= err } }
  // herdr가 판의 건강 상태를 적는 기계에서 herdr-core에 닿지 못하면: 그 사실을 건강 상태의 "확인 불가" 목록에 보태고
  // 호출자에게 알린다(세션에는 이미 확인 불가가 붙는다 — 왜 그런지가 어디에도 남지 않던 것을 메운다).
  const notes = []
  const alsoUnreachable = (labels) => setMeta(db, 'collect_unreachable', [...new Set([...(getMeta(db, 'collect_unreachable') || '').split(',').filter(Boolean), ...labels])].join(','))
  if (useCore && (c.absent || c.err)) {
    notes.push(`${core.name}: ${c.err ? String(c.err.message || c.err).slice(0, 200) : 'not running'}`)
    if (useHerdr && !failure) alsoUnreachable([core.LOOSE_LABEL])
  }
  // 코어 여럿 가운데 일부에만 닿지 못했다: 그 코어의 세션이 확인 불가로 남았거나(꺼진 코어) 코어가 답하지 않았을 때만 적는다.
  // 세션이 없던 꺼진 코어(예: 쓰지 않는 기본 코어)는 조용히 지나간다.
  if (useCore && c.downs?.length) {
    const run = runs.find((r) => r.name === core.name)
    for (const d of c.downs) {
      if (!d.err && !run?.heldParts?.includes(d.name)) continue
      notes.push(`${core.name} (${d.name}): ${d.err ? String(d.err.message || d.err).slice(0, 200) : 'not running'}`)
    }
    const labels = c.downs.filter((d) => run?.heldParts?.includes(d.name)).map((d) => d.label)
    if (useHerdr && !failure && labels.length) alsoUnreachable(labels)
  }
  return { runs, runtimes: rts, failure, notes }
}

// 변화 알림 구독(있으면 주기를 기다리지 않고 바로 수집). 수집 결과를 받아 런타임별로 건다.
export function watchAll(runtimes, kick) {
  const h = runtimes[herdr.name]
  if (h?.snap) herdr.watchEvents(h.snap.sessions, h.snap.table, kick)
  if (runtimes[core.name]) core.watchEvents(kick)
}
export function stopWatching() { herdr.stopWatching(); core.stopWatching() }
