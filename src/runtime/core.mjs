// herdr-core runtime: every live terminal of the herdr-core servers ("cores") on this machine — the terminals the Herdr app
// shows, and those of any other app that runs a core of its own. Reads and writes go to a core's own socket (JSON-RPC, one
// line per message); a core that is not running is never started from here. Window control (jump to an app pane, new tab,
// close a space) goes through the `herdr-app` command, and only for the core that command is about.
// Nothing here assumes a core name, a space name, a folder, or an agent wrapper.
//
// 코어가 여럿일 때의 구조: 코어 하나마다 인스턴스 하나(makeCore). 소켓 경로·구독·화면 읽기 기억·만들기 줄이 그 인스턴스의
// 클로저에 묶여 있어서, 코어를 가리키는 인자를 받는 함수가 없다 — 인자가 빠져서 다른 코어의 같은 주소(t1)로 요청이 가는
// 일이 구조적으로 없다. 밖에서는 세션 ref("<코어 이름>/<주소>")나 데스크 열쇠로만 부르고, 그 이름의 인스턴스가 없으면 거절한다.
// 런타임 이름은 코어가 몇이든 'herdr-core' 하나다(DB 행·브라우저 저장 값이 그대로 통한다).
import { execFile } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { STATE_DIR } from '../db.mjs'
import { commandFor, connectTarget, isWindows } from '../platform.mjs'
import { autoCores, autoValues, lastAutoCore, validCoreName } from '../settings.mjs'
import * as herdr from './herdr.mjs'
import * as ovis from './ovis.mjs'
// A cycle on purpose (context.mjs reads screens through this module): only used inside functions, never while loading.
import { isTrustScreen } from '../board/context.mjs'

export const name = 'herdr-core'
export const FIELDS = ['lastStatus', 'requiresAttention', 'attentionReason', 'lastUserMessageAt', 'title']
export const TRACKS_GONE = true
export const IDLE_AFTER_WORK_IS_DONE = false   // the core reports `done` itself
export const AGENT_CHANGE_IS_NEW = true        // the core names the program in a terminal: another agent there is a new session
// Desk key on the board. A space of an app is one desk; terminals outside any space share the desk `core:`.
// herdr session names cannot contain ':', so these keys never collide with a herdr session.
// 기본 코어의 데스크는 `core:<공간 id>`(예전 그대로), 그 밖의 코어의 데스크는 `core:<코어 이름>@<공간 id>`다. 공간 밖 터미널을 모은
// 데스크(`core:` / `core:<코어 이름>@`)가 코어끼리 겹치지 않고, 데스크 열쇠만 받는 조작(새 세션·끄고 켜기)이 어느 코어 것인지
// 열쇠에서 바로 읽힌다(따로 기억해 둔 표에 기대지 않는다).
export const DESK_PREFIX = 'core:'
export const LOOSE_LABEL = 'herdr-core'
export const isDesk = (s) => typeof s === 'string' && /^core:(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]*$/.test(s)
// 데스크 열쇠 → { core: 코어 이름(기본 코어의 데스크면 null), space: 공간 id(공간 밖 데스크면 '') }
const parseDesk = (desk) => {
  const body = desk.slice(DESK_PREFIX.length)
  const i = body.indexOf('@')
  return i < 0 ? { core: null, space: body } : { core: body.slice(0, i), space: body.slice(i + 1) }
}
export const spaceOfDesk = (desk) => (isDesk(desk) ? parseDesk(desk).space : '')

// ── where the cores listen ──────────────────────────────────────────
// HC_SOCKET wins. Otherwise a core writes its socket path into <state>/herdr-core/<session>/core.lock.
// Windows (assumption, not checked on a Windows machine: herdr-core's Windows build is unknown): the state folder may be
// %LOCALAPPDATA% instead of ~/.local/state, so both are looked at, and the socket is reached as a named pipe by the same
// rule herdr uses (\\.\pipe\<socket path>, see platform.mjs connectTarget). The socket file itself is what tells
// "running" (available), as with herdr where that file holds pid:nonce.
//
// 읽을 코어 = 기본 코어 + 지정된 코어.
//   · HC_SOCKET·HC_SESSION 을 주면 그 코어 하나만 읽는다: WHOSUP_CORES·자동 감지 목록으로 읽을 코어를 늘리지 않는다.
//   · WHOSUP_CORES: 쉼표로 나눈 코어 이름들 | all(core.lock 이 있고 소켓 파일이 있는 코어 전부) | none(기본 코어만).
//   · 그것도 없으면 자동 감지가 알려 준 코어 프로필 목록(settings.mjs autoCores — auto.json 의 cores)
//     + 그 목록에는 없지만 열린 세션이 판에 남아 있는 코어(keepReading — 아래 "목록에서 빠진 코어").
//   · HC_SESSION 은 코어 이름 규칙에 맞을 때만 쓴다(안 맞으면 주지 않은 것으로 본다). 이름만 준 코어의 소켓은 core.lock 에서만 찾는다.
//   · 같은 소켓을 가리키는 이름이 둘이면 첫 이름만 읽는다(planNow — 세션이 이름만 달리 두 번 올라오지 않게).
// 코어 프로필 = { name, socket?, app?, url?, focus?, spaces? }. 이름이 같은 프로필은 어느 경우든 그 코어의 정보로 쓴다 —
// HC_SESSION·HC_SOCKET 으로 고정한 코어도 마찬가지다(그 코어가 "앱 안의 세션으로 보낼 수단이 없는 앱"의 것이라고 프로필이
// 알려 주면 herdr-app 에 그 코어의 주소를 넘기지 않는다: 더 안전한 쪽). 다만 HC_SOCKET 이 프로필의 socket 과 다른 소켓을
// 가리키면 이름만 같은 다른 코어이므로 그 프로필은 쓰지 않는다.
// 코어 이름 규칙은 settings.mjs validCoreName(글자·숫자·. _ - 로 80자까지, '.' 과 '..' 은 받지 않는다 — 상태 폴더 아래의 폴더 이름이 된다).
// HC_SESSION 도 같은 규칙으로 본다(세션 ref "<코어 이름>/<주소>" 의 앞 마디가 되고, 상태 폴더 아래의 폴더 이름이 된다). 규칙에 안 맞는
// 값('/' 가 든 이름 등)은 주지 않은 것으로 본다: 기본 이름을 쓰고, 그 값 때문에 읽을 코어를 하나로 좁히지도 않는다.
const sessionEnv = () => (validCoreName(process.env.HC_SESSION) ? process.env.HC_SESSION : null)
const baseName = () => sessionEnv() || 'default'
const pinned = () => Boolean(process.env.HC_SOCKET || sessionEnv())
export const stateDirs = () => (process.env.XDG_STATE_HOME ? [process.env.XDG_STATE_HOME]
  : [...(isWindows() && process.env.LOCALAPPDATA ? [process.env.LOCALAPPDATA] : []), join(homedir(), '.local', 'state')])
function lockSocket(session) {
  for (const state of stateDirs()) {
    try { const p = readFileSync(join(state, 'herdr-core', session, 'core.lock'), 'utf8').trim(); if (p) return p } catch {}
  }
  return null
}
// core.lock 을 남긴 코어 가운데 소켓 파일이 있는 것(WHOSUP_CORES=all). 파일만 남은 죽은 소켓은 읽을 때 걸러진다(readAll).
function lockedCores() {
  const out = []
  for (const state of stateDirs()) {
    let names = []
    try { names = readdirSync(join(state, 'herdr-core')) } catch { continue }
    for (const n of names) {
      if (!validCoreName(n) || out.includes(n)) continue
      const p = lockSocket(n)
      if (p && existsSync(p)) out.push(n)
    }
  }
  return out
}
// ── 목록에서 빠진 코어(F2-5) ──
// 자기 코어를 띄우는 앱이 꺼지면 그 앱의 서버가 등록부에서 빠지고, 다음 자동 감지의 코어 목록에서 그 코어가 사라진다. 그렇다고 그 코어를
// 읽기를 그만두면 수집기가 그 세션들을 "몇 번 안 보였다"고 닫힘으로 옮긴다 — 코어는 앱이 꺼진 뒤에도 살아 있을 수 있는데도(코어는 앱과
// 따로 도는 프로세스다). 그래서 열린 세션이 판에 남아 있는 코어는 자동 감지 목록에서 빠져도 계속 읽는다:
//   · 어느 코어에 열린 세션이 있는지는 수집할 때마다 알려 준다(keepReading — runtime/index.mjs collectAll 이 DB 의 열린 행에서 뽑는다).
//     보드를 다시 켠 뒤에도 그래서 이어진다(기억이 아니라 DB 의 행에서 다시 얻는다).
//   · 그 코어의 프로필은 마지막으로 안 것(settings.mjs lastAutoCore — 앱 이름·공간 이름)을 쓰되 "앱 안의 세션으로 보낼 수단이 없는
//     앱의 코어"로 못 박는다(focus:false). 웹 주소는 싣지 않는다(꺼진 앱의 서버에서 본 값이다) — 그래서 그 코어는
//     "앱이 꺼져 있는 코어"로 다뤄진다: 닫기는 코어에서 직접, 새 세션·이어서 열기는 앱을 켜야 한다고 거절(makeCore 의 viaServer).
//     마지막 프로필이 없으면(보드를 다시 켰다) 이름만 아는 같은 코어다.
//     이렇게 붙잡아 둔 코어가 꼭 "자기 서버로 보여 주는 앱"의 코어라는 보장은 없다(보드를 다시 켠 뒤에는 출처를 모른다 — 예전에
//     WHOSUP_CORES 로 읽던 코어의 세션이 남아 있는 경우도 여기로 온다). 그래도 같은 규칙을 쓰기로 했다: 닫기는 어느 herdr-core 코어든
//     통하는 수단(그 세션의 터미널임을 created_ms 로 확인한 뒤 코어 소켓의 terminal.kill — Herdr 앱 창이 없을 때의 닫기와 같다)이고,
//     새 세션·이어서 열기는 만들지 않고 거절하므로(app_required, 앱 이름은 모르면 싣지 않는다) 그 코어에 새로 생기는 것이 없다.
//   · 그 코어가 답하면 세션이 그대로 보이고(누르면 앱이 꺼져 있다고 알린다 — showWindowOnly), 소켓이 죽었으면 읽는 목록 안의 꺼진 코어와
//     같은 규칙을 탄다(확인 불가로 두었다가 unreachable_ttl_h 뒤에 닫힘 — collector.mjs parts).
//   · 열린 세션이 다 닫히면 다음 수집부터 그 코어는 목록에서 빠진다.
//   · 사람이 읽을 코어를 정했으면(HC_SOCKET·HC_SESSION·WHOSUP_CORES — none·all·이름 목록 모두) 그 설정이 먼저다: 여기서 코어를 보태지 않는다.
//     기본 코어는 늘 읽으므로 해당이 없다(프로필이 사라진 기본 코어는 예전처럼 프로필 없는 기본 코어로 읽는다).
let kept = []   // 열린 세션이 있는 코어 이름들(정렬). 바뀔 때만 새 배열로 갈아 끼운다 — plan() 이 배열이 같은지로 다시 계산할지 가린다
export function keepReading(names = []) {
  const next = [...new Set([...names].filter(validCoreName))].sort()
  if (next.length !== kept.length || next.some((n, i) => n !== kept[i])) kept = next
}
const heldProfile = (n) => ({ ...(lastAutoCore(n) || { name: n, socket: null, app: null, spaces: {} }), url: null, focus: false })

// 지금 읽을 코어들: [{ name, base, profile, socket }] — 맨 앞이 기본 코어. 환경변수·자동 값을 부를 때마다 다시 본다.
// 다만 끊기지 않고 이어지는 한 번의 계산(판 계산이 세션마다 capsOf 를 부르는 동안 등) 안에서는 한 번만 계산한다: 그 사이에는
// 파일(core.lock·소켓)이 바뀔 수 없고, 환경변수와 자동 값이 그대로인지는 부를 때마다 확인한다. 계산이 끝나면(다음 마이크로태스크)
// 잊으므로 다음 수집·다음 요청은 늘 새로 본다 — 동작은 매번 계산하던 때와 같다. 돌려준 배열은 고치지 않는다.
const PLAN_ENV = ['HC_SESSION', 'HC_SOCKET', 'WHOSUP_CORES', 'XDG_STATE_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE']
let planMemo = null   // { auto, env, kept, out }
function plan() {
  const env = PLAN_ENV.map((k) => process.env[k] ?? '').join('\n')
  if (planMemo && planMemo.auto === autoValues() && planMemo.env === env && planMemo.kept === kept) return planMemo.out
  const out = planNow()
  const memo = { auto: autoValues(), env, kept, out }
  planMemo = memo
  queueMicrotask(() => { if (planMemo === memo) planMemo = null })
  return out
}
function planNow() {
  const base = baseName()
  const profiles = new Map(autoCores().map((p) => [p.name, p]))
  const names = [base]
  let held = []   // 자동 감지 목록에서 빠졌지만 열린 세션이 남아 있어 계속 읽는 코어(위 "목록에서 빠진 코어")
  if (!pinned()) {
    const want = (process.env.WHOSUP_CORES || '').trim()
    if (want.toLowerCase() === 'all') names.push(...lockedCores())
    else if (want) names.push(...want.split(',').map((x) => x.trim()).filter((n) => validCoreName(n) && n.toLowerCase() !== 'none'))
    else { held = kept.filter((n) => n !== base && !profiles.has(n)); names.push(...profiles.keys(), ...held) }
  }
  const out = []
  const taken = new Map()   // 풀어 쓴 소켓 경로 → 그 소켓을 먼저 차지한 코어 이름
  for (const n of new Set(names)) {
    const isBase = n === base
    const fixed = isBase ? process.env.HC_SOCKET || null : null
    let profile = profiles.get(n) || (held.includes(n) ? heldProfile(n) : null)
    // HC_SOCKET 으로 다른 소켓을 가리켰다면 이름만 같은 자동 감지 프로필은 그 코어 것이 아니다.
    if (fixed && profile?.socket && profile.socket !== fixed) profile = null
    // core.lock 이 먼저다(코어가 지금 적어 둔 값). 프로필의 socket 은 자동 감지가 예전에 본 값이라 낡았을 수 있다:
    // core.lock 이 없거나 그 소켓 파일이 없을 때만 쓴다.
    // HC_SESSION 으로 이름만 짚은 코어(HC_SOCKET 없음)는 그 이름의 core.lock 에서만 소켓을 찾는다: 이름만 같은 프로필의 socket 은
    // 다른 코어의 것일 수 있어 쓰지 않는다(사람이 짚은 코어를 자동 감지가 다른 소켓으로 돌리지 않는다). 프로필의 나머지 정보는 그대로 쓴다.
    const named = isBase && Boolean(sessionEnv())
    const cands = fixed ? [fixed] : [lockSocket(n), named ? null : profile?.socket].filter(Boolean)
    const socket = cands.find((p) => existsSync(p)) || cands[0] || null
    // 같은 소켓을 가리키는 이름이 둘이면(환경변수와 자동 감지가 겹친 경우 등) 첫 이름만 읽는다: 둘 다 읽으면 같은 터미널이
    // 이름만 다른 두 세션으로 판에 올라온다. 경로는 풀어서(realpath) 견준다 — 심볼릭 링크로 달리 적힌 같은 소켓도 하나다.
    const real = socket ? realSocket(socket) : null
    if (real && taken.has(real)) { noteAlias(n, taken.get(real)); continue }
    if (real) taken.set(real, n)
    out.push({ name: n, base: isBase, profile, socket })
  }
  return out
}
const realSocket = (p) => { try { return realpathSync(p) } catch { return p } }   // 없는 경로(꺼진 코어)는 적힌 그대로 견준다
// 겹친 이름은 한 줄만 적는다(수집마다 다시 적지 않는다).
const aliasNoted = new Set()
function noteAlias(alias, first) {
  const key = `${alias}\n${first}`
  if (aliasNoted.has(key)) return
  aliasNoted.add(key)
  console.error(`whosup: herdr-core "${alias}" points at the same socket as "${first}": its sessions are read once, as "${first}"`)
}
const made = new Map()   // "<코어 이름>\n<소켓 경로>" → 그 코어에 묶인 인스턴스
function cores() {
  return plan().map((p) => {
    const key = `${p.name}\n${p.socket || ''}`
    let c = made.get(key)
    if (!c) { c = makeCore(p.name, p.socket); made.set(key, c) }
    c.base = p.base
    c.profile = p.profile
    return c
  })
}
const baseCore = () => cores()[0]
// 더는 읽지 않는 코어의 인스턴스(구독 포함)를 내려놓는다.
function prune(list) { for (const [k, c] of made) if (!list.includes(c)) { c.unwatch(); made.delete(k) } }

// 기본 코어의 소켓 경로(점검 도구용). Running = the socket is there. No core, or a stopped one, is simply "not here".
export function socketPath() { return plan()[0].socket }
// 읽을 코어 가운데 하나라도 떠 있는가.
export const available = () => cores().some((c) => c.there())

const MAX_FRAME = 64 * 1024 * 1024   // one line from the core; anything longer is not a terminal list
// 꺼진 코어의 소켓에 붙으려 하면 이런 답이 온다(소켓 파일이 없다 · 파일만 남고 듣는 프로세스가 없다 · 소켓이 아닌 파일이다).
const DEAD = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK'])
function notRunning(code = 'ENOENT') { return Object.assign(new Error('herdr-core is not running'), { code }) }
// 소켓에 붙지 못한 오류의 문구에는 소켓 경로가 들어 있다(connect ENOENT /…/core.sock). 이 문구는 보드 화면까지 가므로
// 경로를 뺀 말로 바꾼다 — 오류 코드는 그대로 둔다(꺼진 코어인지는 코드로 가린다).
const socketError = (method, err) => (DEAD.has(err?.code) ? notRunning(err.code)
  : Object.assign(new Error(`herdr-core ${method}: could not reach the core (${err?.code || 'socket error'})`), { code: err?.code }))
// 한 소켓에 요청 하나. 소켓 경로를 받지 못하면 어디로도 보내지 않는다(기본값이 없다).
function rpcTo(path, method, params = {}, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!path) return reject(notRunning())
    const sock = createConnection(connectTarget(path))
    let buf = ''
    let settled = false
    // Every way out goes through here once: a reply, an error reply, a timeout, a socket error, the core hanging up.
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(value) }
    const timer = setTimeout(() => finish(Object.assign(new Error(`herdr-core ${method}: no reply`), { code: 'ETIMEDOUT' })), timeoutMs)
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })}\n`))
    sock.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        let res
        try { res = JSON.parse(line) } catch { continue }
        if (!res || typeof res !== 'object' || Array.isArray(res)) return finish(Object.assign(new Error(`herdr-core ${method}: not a JSON-RPC reply`), { code: 'EPROTO' }))
        if (res.id !== 1) continue
        if (!res.error) return finish(null, res.result)
        const kind = res.error?.data?.kind
        // code 'terminal_not_found' = 이 코어가 그 터미널이 없다고 답했다. 보드 서버는 이 코드일 때만 세션을 최근 닫힘으로 옮긴다
        // (문구가 아니라 코드로 가린다 — 코어에 닿지 못한 것과 섞이지 않게).
        return finish(Object.assign(new Error(kind === 'not_found' ? `terminal not found: ${params.terminal ?? ''}` : `herdr-core ${method}: ${res.error?.message}`), { kind, ...(kind === 'not_found' ? { code: 'terminal_not_found' } : {}) }))
      }
      if (buf.length > MAX_FRAME) finish(Object.assign(new Error(`herdr-core ${method}: reply too large`), { code: 'EMSGSIZE' }))
    })
    sock.on('error', (err) => finish(socketError(method, err)))
    // The core hung up before answering: say so now instead of waiting for the timeout (everything else collected in the
    // same round waits for this call).
    sock.on('close', () => finish(Object.assign(new Error(`herdr-core ${method}: connection closed before the reply`), { code: 'ECONNRESET' })))
  })
}
// 기본 코어에 요청 하나(시험·점검용). 런타임 안의 조작은 이것을 쓰지 않고 각 인스턴스의 rpc 를 쓴다.
export const rpc = (method, params, opts) => baseCore().rpc(method, params, opts)

// ── terminal → board session ───────────────────────────────────────
const SHELLS = new Set(['zsh', 'bash', 'sh', 'fish', 'nu', 'dash', 'ksh', 'tcsh', 'csh', 'pwsh', 'powershell', 'cmd', 'elvish', 'xonsh'])
const progName = (t) => basename(String(t.foreground?.name || t.foreground?.argv?.[0] || t.argv?.[0] || '')).replace(/^-/, '').replace(/\.exe$/i, '').toLowerCase()
export const isShell = (t) => !t.status?.state && SHELLS.has(progName(t))
// The board's resume logic knows Claude Code as 'claude'.
const PROVIDER = { 'claude-code': 'claude' }
const DONE_FADES_TO_IDLE = new Set(['codex'])   // agents whose `done` turns into `idle` by itself (see toSession)
// `where` is "<space name> / <tab name>" (written by the app). The space name is everything before the last " / ".
const spaceName = (where) => { const i = String(where || '').lastIndexOf(' / '); return i > 0 ? where.slice(0, i) : null }
const folderName = (t) => basename(String(t.cwd || t.foreground?.cwd || '').replace(/\/+$/, ''))
// 공간마다 이름으로 쓸 폴더: 그 공간에서 가장 먼저 만든 터미널이 시작한 폴더(터미널마다 폴더가 달라도 데스크 이름은 하나).
function spaceFolders(terminals) {
  const first = new Map()
  for (const t of terminals) {
    const s = t.labels?.['herdr.space']
    if (!s) continue
    const cur = first.get(s)
    if (!cur || Number(t.created_ms) < Number(cur.created_ms)) first.set(s, t)
  }
  return new Map(/** @type {Array<[string, string]>} */ ([...first].map(([s, t]) => [s, folderName(t)]).filter(([, n]) => n)))
}

export function refOf(address) { return `${baseName()}/${address}` }
export function splitRef(ref) {
  const i = ref.indexOf('/')
  if (i <= 0) throw new Error(`bad herdr-core ref: ${ref}`)
  return { core: ref.slice(0, i), terminal: ref.slice(i + 1) }
}
// Desk key of a stored row (the collector and the board ask this instead of cutting the ref).
export function deskOf(row) {
  try { return JSON.parse(row.fields_json || '{}').desk || DESK_PREFIX } catch { return DESK_PREFIX }
}
export function deskLabelOf(row) {
  try { return JSON.parse(row.fields_json || '{}').deskLabel || LOOSE_LABEL } catch { return LOOSE_LABEL }
}

// ── which conversation runs in a terminal ───────────────────────────
// Claude Code keeps one small file per running process: <config>/sessions/<pid>.json with its current conversation id.
// A terminal's agent is the terminal's program or one of its children (wrappers start it as a child), so the id is found
// by pid. Nothing is guessed from the folder: with several agents in one folder that picked the wrong conversation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const claudeSessionsDir = () => join(dirname(process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')), 'sessions')
function sidOfPid(pid) {
  try { const o = JSON.parse(readFileSync(join(claudeSessionsDir(), `${pid}.json`), 'utf8')); return UUID.test(o.sessionId || '') ? o.sessionId : null } catch { return null }
}
// Only real options count: `--resume <id>`, `-r <id>`, `--session-id <id>` (or `=<id>`) as arguments of their own.
// A shell line (zsh -ic "claude --resume <id>") is read too, but only the part before any quote — a quoted prompt that
// happens to mention "--resume <id>" is text, not an option.
const SID_FLAGS = ['--resume', '-r', '--session-id']
function sidFromWords(words) {
  for (let i = 0; i < words.length; i++) {
    if (SID_FLAGS.includes(words[i]) && UUID.test(words[i + 1] || '')) return words[i + 1]
    const m = /^(?:--resume|--session-id)=(.+)$/.exec(words[i])
    if (m && UUID.test(m[1])) return m[1]
  }
  return null
}
export function sidFromArgv(argv = []) {
  const direct = sidFromWords(argv)
  if (direct) return direct
  const c = argv.findIndex((a, i) => i > 0 && /^-[a-z]*c$/.test(a))
  if (c < 0 || typeof argv[c + 1] !== 'string' || !SHELLS.has(basename(String(argv[0])).replace(/^-/, ''))) return null
  return sidFromWords(argv[c + 1].split(/['"\\`$]/)[0].trim().split(/\s+/))
}
let psCache = { at: 0, kids: null }   // kids: a promise, so terminals looked up at the same moment share one ps run
function childMap() {
  // Windows: no ps. Not looked up there (REPORT 15): the id is read from the argv below instead.
  if (isWindows()) return Promise.resolve(new Map())
  if (psCache.kids && Date.now() - psCache.at < 5000) return psCache.kids
  const kids = new Promise((resolve) => execFile('/bin/ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' }, (err, out) => {
    const map = new Map()
    for (const line of (err ? '' : out).split('\n')) { const m = line.trim().match(/^(\d+)\s+(\d+)$/); if (!m) continue; const p = Number(m[2]); if (!map.has(p)) map.set(p, []); map.get(p).push(Number(m[1])) }
    resolve(map)
  }))
  psCache = { at: Date.now(), kids }
  return kids
}
// Looked up from the terminal's current processes every time: a pid remembered from before would keep answering with
// the old conversation after another program took the terminal. Only for Claude Code — the registry is Claude's.
async function sidOf(t) {
  if (!t.status?.state || PROVIDER[t.status.app] !== 'claude') return null
  const roots = [t.foreground?.pid, t.pid].filter((p) => Number.isInteger(p))
  for (const pid of roots) { const sid = sidOfPid(pid); if (sid) return sid }
  const kids = await childMap()
  const seen = new Set(roots)
  for (let layer = roots, depth = 0; layer.length && depth < 6; depth++) {
    const next = []
    for (const p of layer) for (const c of kids.get(p) || []) { if (seen.has(c)) continue; seen.add(c); next.push(c); const sid = sidOfPid(c); if (sid) return sid }
    layer = next
  }
  return sidFromArgv(t.foreground?.argv) || sidFromArgv(t.argv)
}

// ── desks the person switched off ───────────────────────────────────
// Turning a desk off closes its space and ends its terminals. The desk is remembered here (name and folder) so the board
// can offer to turn it back on, the same way a stopped herdr session stays on the list.
const OFF_PATH = () => join(STATE_DIR, 'core-off.json')
export function offDesks() { try { return JSON.parse(readFileSync(OFF_PATH(), 'utf8')) || {} } catch { return {} } }
function saveOff(o) { mkdirSync(dirname(OFF_PATH()), { recursive: true }); writeFileSync(OFF_PATH(), JSON.stringify(o)) }
const switching = new Set()   // desks being turned off or on right now (데스크 열쇠는 코어끼리 겹치지 않는다)

// ── the Herdr app window ────────────────────────────────────────────
export const appBin = () => process.env.HERDR_APP_BIN || 'herdr-app'
// herdr-app 이 다루는 코어의 앱 창을 올릴 때 쓰는 이름: 환경변수 HERDR_APP_NAME > 자동 감지(코어 프로필의 app) > 기본 이름.
// 사람이 환경변수로 정한 이름을 자동 감지가 덮지 않는다.
const DEFAULT_APP = 'Herdr'
export const appName = (profileApp = null) => process.env.HERDR_APP_NAME || profileApp || DEFAULT_APP
// Resolves { ok, out }. ok=false with code 'no_app' (command not installed) | 'no_window' (the app is not open) | 'failed'.
// 이 명령은 주소(t1)만 받는다 — 어느 코어 것인지 모른다. 그래서 인스턴스 밖에서는 부르지 않고, 인스턴스는 herdr-app 이
// 자기 코어를 다룰 때(canFocus)만 부른다.
function herdrApp(args, { timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const [file, argv] = commandFor(appBin(), args)
    execFile(file, argv, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (!err) return resolve({ ok: true, out: stdout })
      const text = `${stderr || ''}${err.message || ''}`
      resolve({ ok: false, code: err.code === 'ENOENT' ? 'no_app' : /no Herdr window/i.test(text) ? 'no_window' : 'failed', message: text.trim().split('\n')[0].slice(0, 300) })
    })
  })
}
// Spaces of the open window: [{ id, name, folder, terminals: [{ terminal, pane, tab }] }], or null when there is no window.
async function herdrAppSpaces() {
  const r = await herdrApp(['ls'])
  if (!r.ok) return null
  try {
    return (JSON.parse(r.out).spaces || []).map((s) => ({ id: s.id, name: s.name, folder: s.folder || null,
      terminals: (s.tabs || []).flatMap((t) => (t.terminals || []).map((x) => ({ terminal: x.terminal, pane: x.pane, tab: t.id }))) }))
  } catch { return null }
}

// ── windows ─────────────────────────────────────────────────────────
// Bringing an app forward and opening a terminal window are borrowed from the herdr runtime (same rules, same settings).
// Kept in one place so tests can swap them out instead of touching real windows.
// appRunning(이름) = 그 앱이 지금 떠 있는가(true·false, 알 길이 없는 운영체제면 null) — 꺼진 앱을 올리기가 켜 버리지 않게 먼저 본다.
const windows = { raiseApp: herdr.raiseApp, openWindowRunning: herdr.openWindowRunning, appRunning: herdr.appRunning }
export const _setWindowOps = (ops) => Object.assign(windows, ops)
let latestClick = 0
// 설정 core_target: 'terminal'이면 앱을 거치지 않고 늘 터미널 창에서 연다(서버가 시작할 때와 설정을 저장할 때 넣어 준다).
let openIn = 'app'
export const setOpenIn = (v) => { openIn = v === 'terminal' ? 'terminal' : 'app' }
// 앱 창만 올렸거나 아무 창도 올리지 못한 결과: 그 세션 자체를 보여 준 것이 아니다.
// app_failed = 앱은 떠 있는데 창 올리기가 오류로 실패했다(꺼져 있는 것과 다르다 — 켜라고 안내하면 틀린 안내가 된다).
const NOT_SHOWN = new Set(['app_only', 'app_closed', 'app_failed', 'unsupported'])
// 수집이 코어에 목록을 물을 때 기다리는 시간(ms). full = 평소, short = 방금 답하지 않은 코어에 물을 때, shortFor = 답하지 않은 때부터
// 짧게만 기다리는 동안. 답하지 않는 코어 하나(다른 앱의 코어일 수 있다) 때문에 수집마다 full 만큼 늦어지지 않게 한다 — makeCore 의 listForCollect.
const LIST_WAIT = { full: 5000, short: 1000, shortFor: 30000 }
export const _setListWait = (o) => Object.assign(LIST_WAIT, o)   // tests
// 방금 만든 터미널의 셸이 입력을 받을 준비가 될 때까지 기다리는 한도(ms) — herdr 런타임의 SHELL_WAIT 과 같은 규칙(가-12 B3-1).
// stepMs = 화면을 다시 읽는 간격, maxMs = 이 시간을 넘기면 그냥 보낸다, readMs = 화면 읽기 한 번을 기다리는 시간. makeCore 의 shellReady.
export const SHELL_WAIT = { stepMs: 80, maxMs: 2000, readMs: 1500 }
export const _setShellWait = (o) => Object.assign(SHELL_WAIT, o)   // tests
const notSupported = (what) => Object.assign(new Error(`${what} is not supported for sessions of this core`), { code: 'not_supported' })
// 그 앱의 서버가 있어야 하는 일을 지금은 할 수 없다. 조용히 실패하지 않고 까닭을 코드로 돌려준다(보드가 그 코드로 문구를 고른다):
//   app_required   = 그 코어를 보여 주는 앱이 꺼져 있다(서버를 찾지 못했다) — 앱을 켜면 된다
//   token_required = 그 앱의 서버가 토큰·로그인 없이는 조작을 받지 않는다(detail = 서버가 말한 까닭)
// app = 그 앱의 이름(프로필이 아는 값, 모르면 null — 문구에 끼워 넣는다. 코드에 박아 둔 이름은 없다).
const cannot = (code, what, app = null, detail = null) => Object.assign(new Error(code === 'app_required'
  ? `${app || 'the app of that session'} is not running: ${what} needs it — start the app and try again`
  : `${app || 'the app of that session'} does not take ${what} from here without signing in`), { code, app: app || null, ...(detail ? { detail } : {}) })
// 그 앱의 서버에 요청을 보냈는데 시간 안에 답이 오지 않았다: 닿았는지, 그 일이 됐는지 알 수 없다(app_no_answer). "안 됐다"와 다르다 —
// 새 세션이면 서버 쪽에서는 만들어졌을 수 있으므로, 다시 누르기 전에 그 앱을 먼저 보라고 알린다(다시 누르면 하나 더 생길 수 있다).
const noAnswer = (what, app = null) => Object.assign(new Error(`${app || 'the app of that session'} did not answer in time: ${what} may or may not have been done — look at the app before trying again`), { code: 'app_no_answer', app: app || null })
// 거절 문구에 넣는 "무슨 일"(기능 이름 → 영어 구절).
const WHAT = { new: 'a new session', focus: 'moving to a session', close: 'closing a session', resume: 'resuming a session' }
// 되는 기능(새 세션·이동·닫기·이어서 열기)과 수단 — 모양은 ovis.mjs 의 coreFeatures 와 같다.
const APP_COMMAND = ovis.allFeatures('app_command')   // herdr-app 이 다루는 코어: 넷 다 앱 명령으로
const EXTRA_CAPS = ['close', 'resume', 'new']         // "보기"(이동·웹 주소)를 넘는 일

// ── one core ────────────────────────────────────────────────────────
// 코어 하나에 묶인 인스턴스. 아래 함수들은 주소(t1)만 받고, 요청은 이 인스턴스의 소켓으로만 간다.
// base·profile 은 cores() 가 부를 때마다 다시 채운다(자동 감지가 바뀌어도 인스턴스의 기억은 이어진다).
function makeCore(coreName, socket) {
  const c = { name: coreName, socket, base: true, profile: null, spaces: new Set() }
  // herdr-app 명령(앱 안의 그 세션으로 가기·탭 만들기·pane 닫기·공간 닫기)이 이 코어의 세션을 다루는가.
  // 프로필이 분명히 적었으면 그대로다(focus: true = 다룬다, false = 앱 안의 세션으로 보낼 수단이 없다). 적지 않았거나 프로필이
  // 없으면(모른다) 기본 코어만 예전처럼 herdr-app 의 코어로 보고, 그 밖의 코어는 보기 전용으로 본다. 코어 이름으로 정하지 않는다.
  // 기본 코어는 focus:false 가 분명히 적혔을 때만 보기 전용이 된다 — 프로필에 한 줄이 빠졌다고 닫기·새 세션이 사라지지 않는다.
  const canFocus = () => { const f = c.profile?.focus; return f === true || (f !== false && c.base) }
  const there = () => Boolean(socket) && existsSync(socket)
  const rpc = (method, params = {}, opts) => rpcTo(socket, method, params, opts)
  const appDo = (command, args = {}) => (canFocus() ? herdrApp(['do', command, JSON.stringify(args)]) : Promise.resolve({ ok: false, code: 'not_this_core' }))
  const appSpaces = () => (canFocus() ? herdrAppSpaces() : Promise.resolve(null))
  // herdr-app 을 쓰는 코어가 둘 이상인가(드문 구성). herdr-app 은 주소와 공간 id 만 받는데 그 둘은 코어끼리 겹칠 수 있어서
  // (두 코어 모두 공간 sp1 의 t1), 그때는 herdr-app 이 어느 코어의 앱인지 확실히 가릴 길이 없다.
  const sharedApp = () => cores().filter((x) => x.canFocus()).length > 1
  // 끝내거나 만들거나 옮기는 명령(pane.close·space.close·tab.new·space.new·terminal.keep)은 대상이 이 코어의 것임이 확실할 때만
  // herdr-app 에 시킨다. 확실하지 않으면 시키지 않고(ok:false) 부른 쪽이 이 코어의 소켓으로 직접 한다 — 주소·공간 id 만 같은
  // 다른 코어의 세션·공간을 닫거나 그쪽에 새 세션을 만들지 않는다. (앱의 탭 정리는 그 앱이 스스로 한다.)
  const appChange = (command, args = {}) => (sharedApp() ? Promise.resolve({ ok: false, code: 'ambiguous' }) : appDo(command, args))
  const full = (what) => { if (!canFocus()) throw notSupported(what) }

  // ── 자기 서버로 이 코어를 보여 주는 앱의 코어 ──
  // 프로필이 focus:false 라고 분명히 적은 코어다: 자동 감지는 "그 코어를 보여 주는 서버가 확인된 코어"에만 그렇게 적는다
  // (src/autoconf.mjs coreProfiles), 그 앱이 꺼져 목록에서 빠진 코어도 같은 값으로 읽는다(heldProfile). 코어 이름으로 가리지 않는다.
  // 그런 코어에는 herdr-app 을 쓰지 않는다(canFocus 가 거짓이다). 대신 기능마다 수단이 따로 있다(ovis.mjs):
  //   새 세션·이어서 열기 = 그 앱의 서버 API(앱이 켜져 있어야 한다)      닫기 = 서버 API, 서버가 없으면 이 코어의 소켓으로 직접
  //   이동 = 서버가 살아 있으면 그 세션의 웹 주소를 돌려준다(앱 창 안에서 그 세션을 고르게 하는 수단은 그 앱에 없다),
  //          창을 올려 달라는 클릭이면 예전처럼 앱 창을 올린다
  // 데스크 끄고 켜기는 열지 않았다(full). 프로필이 없거나 focus 를 적지 않은 기본 코어 밖의 코어는 예전처럼 보기 전용이다.
  // 서버가 어디 있는지는 기억하지 않는다: 일을 시킬 때마다 다시 찾는다(앱을 다시 켜면 포트가 바뀐다).
  const viaServer = () => !canFocus() && c.profile?.focus === false
  // 깔려 있는 그 앱이 ovis:// 링크를 아는가(ovis.linkSupported — 앱 묶음·등록을 읽고 그 파일이 바뀔 때까지 기억한다).
  const linkOk = () => { try { return viaServer() && ovis.linkSupported(c.profile?.app || null) } catch { return false } }
  const findServer = () => ovis.findServer(coreName, { app: c.profile?.app || null })
  // 화면이 단추를 정할 때 쓰는 값(묻지 않고 답한다). 프로필의 값 셋(focus·url·app)에서 부를 때마다 계산한다 — auto.json 의 코어
  // 프로필에 적힌 "되는 기능"(features — 자동 감지가 감지한 때의 값을 같은 함수 ovis.profileFeatures 로 적어 둔 것)은 읽어 쓰지 않는다:
  // 그 앱이 꺼져 붙잡아 둔 코어(heldProfile)처럼 감지 뒤에 달라지는 경우가 있다. 자기 서버로 보여 주는 앱의 코어는 프로필의 웹 주소로 가린다: 자동
  // 감지는 그 서버가 이 PC 의 요청을 인증 없이 받는다고 답했을 때만 웹 주소를 싣는다(조작을 받는 조건과 같다). 조작을 받지 않는
  // 서버는 코어 이름도 알려 주지 않아 자동 감지의 목록에 오르지 않는다(그 코어는 "앱이 꺼진 코어"로 보이고, 일을 시킬 때
  // token_required 로 가려진다). 실제로 되는지는 일을 시킬 때 다시 본다.
  const features = () => {
    if (canFocus()) return APP_COMMAND
    const app = c.profile?.app || null
    if (viaServer()) return ovis.profileFeatures(c.profile, { link: Boolean(c.profile?.url) && linkOk() })
    return { ...ovis.allFeatures('none', 'not_supported'), focus: { means: app ? 'app_window' : 'terminal_window' } }
  }
  // 그 기능(new·focus·close·resume)을 지금 프로필로 보아 할 수 없는 까닭을 오류 모양으로(code·app·문구). 할 수 있으면 null.
  // 보드 서버의 첫 문이 쓴다: 일을 시켰을 때 런타임이 내는 거절(cannot·notSupported)과 같은 코드·같은 앱 이름이 나간다.
  const why = (cap) => {
    const f = features()[cap]
    if (!f) return canFocus() ? null : notSupported(String(cap).slice(0, 40))
    if (f.means !== 'none') return null
    return f.reason === 'app_required' || f.reason === 'token_required' ? cannot(f.reason, WHAT[cap], c.profile?.app) : notSupported(WHAT[cap])
  }
  // 그 일을 무엇으로 하는가: 'app'(herdr-app 의 코어) | 'server'(자기 서버로 보여 주는 앱의 코어). 둘 다 아니면 거절한다.
  const gate = (what) => { if (canFocus()) return 'app'; if (viaServer()) return 'server'; throw notSupported(what) }
  // 서버 API 로 일 하나. 서버가 없거나 조작을 받지 않으면 까닭과 함께 거절한다. 돌려주는 것: [찾은 서버, fn 의 결과].
  async function viaApi(what, fn) {
    const s = await findServer()
    if (s.state !== 'ok') throw cannot(s.state === 'locked' ? 'token_required' : 'app_required', what, c.profile?.app, s.reason)
    try { return [s, await fn(s.port)] } catch (err) {
      // 방금 답한 서버가 연결을 받지 않는다 = 그 사이 앱이 꺼졌다. 시간 초과는 요청이 닿았는지 모른다: "꺼져 있다"가 아니라
      // "답이 없었다 — 됐는지 모른다"로 알린다(noAnswer).
      if (err?.code === 'server_unreachable') throw err.timedOut ? noAnswer(what, c.profile?.app) : cannot('app_required', what, c.profile?.app)
      if (err?.code === 'token_required') throw cannot('token_required', what, c.profile?.app)
      throw err
    }
  }

  // ── 데스크 열쇠와 이름 ──
  const deskKey = (space) => `${DESK_PREFIX}${c.base ? '' : `${coreName}@`}${space || ''}`
  const ownsDesk = (desk) => { const d = parseDesk(desk); return c.base ? d.core === null : d.core === coreName }
  // 기본 코어가 아닌 코어의 데스크 이름 앞에 붙는 말: 그 코어를 보여 주는 앱 이름, 없으면 코어 이름.
  const tag = () => c.profile?.app || coreName
  // 데스크 이름: 프로필이 아는 공간 이름 > 앱이 적어 둔 이름(where) > 그 공간의 폴더 이름. 공간 id 는 보여 주지 않는다.
  function deskLabel(t, names = null) {
    const space = t.labels?.['herdr.space'] || ''
    const label = space ? (c.profile?.spaces?.[space] || spaceName(t.labels?.where) || names?.get(space) || folderName(t) || null) : null
    if (c.base) return label || LOOSE_LABEL
    return label ? `${tag()} · ${label}` : tag()
  }

  // screenAsk: what the screen of a terminal without a reported status is waiting for ('trust' = the agent's folder-trust
  // prompt, shown before the agent is up and so before it can report anything). See trustWaiting.
  // names: 공간 id → 폴더 이름(목록을 읽을 때 한 번 만든다 — spaceFolders).
  function toSession(t, { sid = null, screenAsk = null, names = null } = {}) {
    const st = t.status?.state
    let status = st ? (st === 'error' ? 'blocked' : ['working', 'blocked', 'done', 'idle'].includes(st) ? st : 'unknown') : isShell(t) ? 'shell' : 'unknown'
    if (status === 'unknown' && !st && screenAsk === 'trust') status = 'blocked'
    // The app records the last turn the person has looked at (label herdr.seen); whosup records its own when a session is
    // opened from the board (label whosup.seen — see focus). A finished turn already seen is not waiting any more, the
    // same way a herdr pane goes from finished to idle once it has been looked at.
    const turn = Number.isSafeInteger(t.turn) && t.turn > 0 ? t.turn : 0
    // A seen turn ahead of the current one was written for a program that is no longer there (its count started over):
    // such a label is left out by itself, so it cannot cancel the other label when that one is good.
    const seenTurn = Math.max(...['herdr.seen', 'whosup.seen'].map((k) => Number(t.labels?.[k])).filter((n) => Number.isSafeInteger(n) && n <= turn), -1)
    if (status === 'done' && turn > 0 && seenTurn >= turn) status = 'idle'
    // Some agents report `done` only for a moment and are `idle` again right after (Codex, measured: 2 s). The turn they
    // finished is still one nobody has looked at, so the session keeps saying so until it is seen — the same rule as above,
    // read from the other side. Only for agents seen to do that: an agent that keeps `done` until it is looked at
    // (Claude Code) is `idle` with a new turn when the person stopped it halfway, and that is not an answer.
    else if (status === 'idle' && turn > 0 && seenTurn < turn && DONE_FADES_TO_IDLE.has(t.status?.app)) status = 'done'
    const cwd = t.foreground?.cwd || t.cwd || ''
    const space = t.labels?.['herdr.space'] || ''
    const title = t.title && !['Claude Code', ''].includes(t.title) && st ? t.title : t.name || basename(cwd.replace(/\/+$/, '')) || t.address
    const waiting = status === 'done' || status === 'blocked'
    return {
      runtime: name,
      runtime_ref: `${coreName}/${t.address}`,
      provider_session: sid,
      cwd,
      project: basename(cwd.replace(/\/+$/, '')) || '-',
      title,
      pane_label: t.name || null,
      provider: st ? (PROVIDER[t.status.app] || t.status.app || null) : null,
      status,
      attentionTimestamp: waiting && t.status_ms ? new Date(t.status_ms).toISOString() : null,
      archived: false,
      fields: {
        lastStatus: { working: 'running', blocked: 'error', done: 'idle', idle: 'idle', shell: 'shell' }[status] || 'unknown',
        requiresAttention: waiting,
        attentionReason: status === 'done' ? 'finished' : status === 'blocked' ? 'blocked' : null,
        lastUserMessageAt: null,
        title,
        desk: deskKey(space),
        deskLabel: deskLabel(t, names),
        tab: t.labels?.['herdr.tab'] || null,
        statusKind: t.status?.kind || (!st && status === 'blocked' ? 'trust' : null),   // 'trust' = read from the screen, not reported
        statusMsg: t.status?.msg || null,
        failed: st === 'error',
        turn,
        // The same finished turn is one event however the core words it (done, then idle): the collector keeps its
        // waiting-since time while this stays the same.
        // Without a turn count there is nothing to tell two finished turns apart by: no key, the time decides as before.
        attentionKey: status === 'done' && turn > 0 ? `done:${turn}` : null,
        // The same address can be handed to a new terminal later; this tells the two apart.
        incarnation: t.created_ms != null ? String(t.created_ms) : null,
      },
    }
  }

  // ── a wait the core cannot report ──
  // An agent asks "do you trust this folder?" before it is up, so the core has no status for that terminal and the session
  // would sit there as "unknown" while the agent waits. Only for such terminals (a program that is not a shell and reports
  // nothing) the screen is read, and only that one prompt counts — judged by the same rule the herdr runtime's sessions use.
  // Nothing else is guessed from the screen. Read at most every few seconds per terminal; a failed read means "no".
  // 앱 안의 세션으로 보낼 수단이 없는 코어(canFocus 아님)의 터미널은 이렇게 읽지 않는다 — 코어가 알린 상태만 쓴다(listSnapshot).
  const trustSeen = new Map()   // "<address>:<created_ms>" → { at, waiting, pending }
  async function trustWaiting(t) {
    if (t.status?.state || isShell(t)) return false
    const key = `${t.address}:${t.created_ms}`
    const hit = trustSeen.get(key)
    if (hit?.pending) return hit.pending   // a read is on its way: collections that overlap share it
    if (hit && Date.now() - hit.at < TRUST_TTL_MS) return hit.waiting
    const entry = { at: 0, waiting: false, pending: null }
    entry.pending = (async () => {
      let waiting = false
      try { waiting = isTrustScreen((await rpc('terminal.read', { terminal: t.address, lines: 0 }, { timeoutMs: 1500 })).text || '') } catch {}
      // Only if this is still the entry in use (the terminal may have gone, or the cache been cleared, meanwhile).
      if (trustSeen.get(key) === entry) Object.assign(entry, { at: Date.now(), waiting, pending: null })
      return waiting
    })()
    trustSeen.set(key, entry)
    return entry.pending
  }

  // ── listing ──
  const listTerminals = async () => (await rpc('terminal.list', {})).terminals || []
  // 수집이 묻는 목록. 코어가 제때(full) 답하지 않았으면(ETIMEDOUT) 그때부터 LIST_WAIT.shortFor 동안은 수집이 짧게만(short) 기다린다:
  // 답하지 않는 코어 하나가 수집을 매번 5초씩 붙잡지 않게. 횟수가 아니라 시간으로 센다 — 수집은 주기 말고 변화 알림으로도 돌아서,
  // 횟수로 세면 짧게 묻는 동안의 길이가 그때그때 달라진다. 그 시간이 지나면 원래 시간으로 한 번 다시 기다리고(느리지만 살아 있는
  // 코어를 영영 놓치지 않게), 그때도 답이 없으면 거기서부터 다시 짧게 묻는다. 짧게 기다리다 놓친 것은 그 시간을 늘리지 않는다.
  // 짧게 묻는 동안에도 요청 하나는 원래 시간만큼 살려 둔다(late): 수집은 short 만 기다리고 넘어가지만, 그 요청에 늦게라도 답이 오면
  // 그 코어는 느릴 뿐 살아 있는 것이므로 짧게 묻기를 그 자리에서 끝낸다 — 다음 수집이 원래 시간으로 기다려 그 코어를 읽는다. 한 번
  // 늦었다고 그 세션이 shortFor 내내 확인 불가로 남지 않는다(짧게 묻기가 없던 때보다 나빠지지 않는다). 늦게 온 목록 자체는 쓰지 않는다:
  // 그 수집은 이미 지나갔고, 그 뒤에 판이 바뀌었을 수 있다. 답을 받지 못한 수집은 전과 같이 그 코어의 세션을 확인 불가로 둔다
  // (직전 목록을 지금 것처럼 다시 쓰지 않는다 — 모르면 모른다고 한다).
  let shortUntil = 0   // 이 시각 전까지는 짧게만 기다린다(0 = 평소)
  let late = null      // 짧게 기다리다 두고 온 요청(끝까지 기다리는 중). 하나만 둔다
  async function listForCollect() {
    const short = Date.now() < shortUntil
    const linger = short && !late
    const ask = rpc('terminal.list', {}, { timeoutMs: short && !linger ? LIST_WAIT.short : LIST_WAIT.full })
    let timer = null
    let waited = ask
    if (linger) {
      late = ask.then(() => { shortUntil = 0 }, () => {}).finally(() => { late = null })
      waited = Promise.race([ask, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('herdr-core terminal.list: no reply'), { code: 'ETIMEDOUT' })), LIST_WAIT.short) })])
    }
    try {
      const list = (await waited).terminals || []
      shortUntil = 0
      return list
    } catch (err) {
      if (err?.code === 'ETIMEDOUT' && !short) shortUntil = Date.now() + LIST_WAIT.shortFor
      throw err
    } finally { clearTimeout(timer) }
  }
  async function listSnapshot() {
    const terminals = (await listForCollect()).filter((t) => t.state === 'live' && !String(t.address).includes('/'))   // this machine only
    const busy = new Set(switching)   // desks being switched when this list was read (not when it is worked through, below)
    const keys = new Set(terminals.map((t) => `${t.address}:${t.created_ms}`))
    for (const k of trustSeen.keys()) if (!keys.has(k)) trustSeen.delete(k)
    const names = spaceFolders(terminals)
    const reads = canFocus()
    const sessions = await Promise.all(terminals.map(async (t) => toSession(t, { sid: await sidOf(t), screenAsk: reads && (await trustWaiting(t)) ? 'trust' : null, names })))
    c.spaces = new Set(terminals.map((t) => t.labels?.['herdr.space']).filter(Boolean))
    // A desk that was switched off is on again only when a terminal created after the switch-off shows up in it.
    // A list read just before the switch-off still holds the old terminals and must not undo it (seen with the real app:
    // the regular collection raced the switch-off and the desk was forgotten).
    // 꺼 둔 데스크 기록은 파일 하나를 코어들이 함께 쓴다: 자기 데스크만 보고, 읽고-고치고-쓰기 사이에 기다림을 두지 않는다.
    const off = offDesks()
    let changed = false
    for (const d of Object.keys(off)) {
      if (!ownsDesk(d)) continue
      if (busy.has(d) || switching.has(d)) continue   // was (or is) being switched: a terminal that turned up meanwhile is ended with the rest
      const since = Date.parse(off[d].at) || 0
      if (terminals.some((t) => deskKey(t.labels?.['herdr.space'] || '') === d && Number(t.created_ms) > since)) { delete off[d]; changed = true }
    }
    if (changed) saveOff(off)
    return { sessions, unreachable: [], stopped: Object.keys(off) }
  }

  // ── change events ──
  // One subscription on the core socket; any event means "collect now". Without it the regular collection still runs.
  let watch = null
  function unwatch() { watch?.sock.destroy(); watch = null }
  function watchEvents(onChange) {
    if (!there()) { unwatch(); return }
    if (watch && !watch.sock.destroyed) return
    unwatch()
    const sock = createConnection(connectTarget(socket))
    const w = { sock }
    watch = w
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events.subscribe', params: {} })}\n`))
    sock.on('data', (chunk) => {
      buf += chunk
      let i; let hit = false
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        let msg
        try { msg = JSON.parse(line) } catch { continue }
        if (msg?.method === 'event') hit = true
        // The core refused the subscription: let go, the next collection asks again.
        else if (msg?.id === 1 && msg.error) { sock.destroy(); return }
      }
      if (buf.length > MAX_FRAME) { sock.destroy(); return }
      if (hit) onChange(name)
    })
    const drop = () => { if (watch === w) watch = null }
    sock.on('error', drop); sock.on('close', drop)
  }

  // ── screen text ──
  const readScreen = async (terminal, lines = 60) => (await rpc('terminal.read', { terminal, lines }, { timeoutMs: 4000 })).text || ''

  // ── jump ──
  // expect = the terminal the session was made for (its created_ms). The core hands an address to a new terminal once the old
  // one is gone: a session that has not caught up must not open, type into or end whatever lives at that address now.
  // (code 'terminal_not_found' is what the board server looks for to move the session to Recently closed: this core said so.)
  const gone = (terminal, why) => Object.assign(new Error(`terminal not found: ${terminal} (${why})`), { code: 'terminal_not_found' })
  const live = async (terminal, expect = null) => {
    const t = await rpc('terminal.get', { terminal })
    if (!t || t.state !== 'live') throw gone(terminal, 'finished')
    if (expect != null && String(t.created_ms) !== String(expect)) throw gone(terminal, 'that address belongs to another terminal now')
    return t
  }
  // Type a command into a terminal that is at a shell prompt (resume, start an agent).
  async function typeInto(t, text) {
    if (!isShell(t)) throw new Error(`${t.address} is not at a shell prompt`)
    await rpc('terminal.send', { terminal: t.address, text })
  }
  // 터미널 창을 새로 열어 그 터미널에 붙인다(`hc attach`).
  function attach(terminal) {
    const hc = process.env.HC_BIN || 'hc'
    // The new window starts with the person's own environment, not this server's. Whatever tells `hc` where this core is
    // goes along, so it attaches to the core the session came from (and does not start another one somewhere else).
    // The herdr-core session name and the socket this click talked to are always spelled out (the window's own shell may point `hc`
    // at another core); the state folders only when this server was given them. XDG_STATE_HOME is where this file looks for
    // core.lock on every system (stateDirs), so it goes along everywhere. XDG_RUNTIME_DIR is a POSIX login-session folder:
    // on Windows it is not this server's to hand on (a stray value inherited from some tool would point `hc` at a path
    // that means nothing there), and the socket is already spelled out.
    const xdg = isWindows() ? ['XDG_STATE_HOME'] : ['XDG_STATE_HOME', 'XDG_RUNTIME_DIR']
    const env = { HC_SESSION: coreName, ...(socket ? { HC_SOCKET: socket } : {}),
      ...Object.fromEntries(xdg.filter((k) => process.env[k]).map((k) => [k, process.env[k]])) }
    // 창 이름(스크립트 파일 이름)은 기본 코어면 예전 그대로, 그 밖의 코어는 코어 이름을 넣어 같은 주소끼리 겹치지 않게 한다.
    const key = c.base ? `core-${terminal}` : `core-${coreName}-${terminal}`
    // Windows has no /usr/bin/env: the variables go to the window as PowerShell $env: lines (herdr.openWindowRunning).
    if (isWindows()) return windows.openWindowRunning([hc, 'attach', terminal], key, env)
    const argv = ['/usr/bin/env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), hc, 'attach', terminal]
    return windows.openWindowRunning(argv, key)
  }
  // Show the terminal in the app (any space, any tab) and bring the app forward. If no app pane shows it yet the app is asked
  // to give it one. Without an open app window the terminal is opened in a terminal window instead (`hc attach`).
  // raise:false = the click came from a browser that is not in front of this screen: move the app's pane, leave windows alone.
  // herdr-app 을 쓰는 코어가 둘 이상이면(드문 구성 — sharedApp) "앱 안에서 그 세션으로 가기"(pane.focus)도 앱에 시키지 않는다:
  // herdr-app 은 주소만 받는데 주소도 공간 id 도 코어끼리 겹칠 수 있어서, 앱이 답한 공간·주소가 맞아 보여도 다른 코어의 pane 일 수
  // 있다(끝내기·만들기의 appChange 와 같은 판단). 그때는 이 코어에 붙는 터미널 창으로 연다(hc attach — 코어가 분명하다).
  async function show(terminal, { raise = true, split = 0 } = {}) {
    if (!canFocus()) return showWindowOnly(terminal, { raise, split })
    let r = openIn === 'terminal' || sharedApp() ? { ok: false, code: 'skipped' } : await appDo('pane.focus', { terminal })
    if (!r.ok && r.code === 'failed') { const kept = await appChange('terminal.keep', { terminal }); if (kept.ok) r = await appDo('pane.focus', { terminal }) }
    if (r.ok) {
      if (raise === false) return 'skipped'
      return windows.raiseApp(appName(c.profile?.app), split)
    }
    if (raise === false) return 'skipped'
    return attach(terminal)
  }
  // 앱 안의 그 세션으로 보낼 수단이 없는 코어: 그 코어를 보여 주는 앱이 떠 있으면 앱 창만 앞으로 올린다('app_only').
  // 앱이 꺼져 있으면 켜지 않고 그렇다고 알린다('app_closed'). 앱을 모르거나 "늘 터미널 창"을 골랐으면 터미널 창에서 연다.
  // 앱이 떠 있는지 알 길이 없는 운영체제(macOS 밖)이거나 창 올리기를 꺼 두었으면 'unsupported'(아무 창도 건드리지 않았다).
  // 앱은 떠 있는데 올리기가 오류로 실패했으면 'app_failed' — 꺼져 있다고 답하지 않는다.
  // 여기서 쓰는 앱 이름은 그 코어의 프로필이 알려 준 것뿐이다: HERDR_APP_NAME 은 Herdr 앱의 이름이라 다른 앱의 코어에는 쓰지 않는다.
  async function showWindowOnly(terminal, { raise = true, split = 0 } = {}) {
    if (raise === false) return 'skipped'
    const app = c.profile?.app
    if (!app || openIn === 'terminal') return attach(terminal)
    try {
      const running = await windows.appRunning(app)
      if (running == null) return 'unsupported'
      if (!running) return 'app_closed'
      const r = await windows.raiseApp(app, split, { launch: false })
      return r === 'raised' || r === 'app' ? 'app_only' : r === 'none' ? 'app_closed' : r === 'failed' ? 'app_failed' : 'unsupported'
    } catch { return 'app_failed' }
  }
  // 그 세션을 앱 링크로 앱 창에 보인다(그 앱이 링크를 알고 서버가 살아 있다 — 이동의 수단이 app_link). 창을 올리지 말라는 클릭이면
  // 링크도 열지 않는다(raise:false — 그 브라우저가 탭을 열었다). 링크를 쓰지 않는 코어면 null(부른 쪽이 예전 길로 간다).
  // 'app_link' = 링크를 열었다 · 'link_failed' = 링크를 만들 수 없었거나 여는 명령이 실패했다(부른 쪽이 브라우저 탭으로 연다).
  async function showByLink(terminal, { raise = true } = {}) {
    if (raise === false || !viaServer() || features().focus.means !== 'app_link') return null
    const link = ovis.appLink(terminal)
    if (!link) return 'link_failed'
    try { await ovis.openExternal(link); return 'app_link' } catch { return 'link_failed' }
  }
  // 링크가 실패했다: 그 세션의 웹 주소(이번에 찾은 포트)를 이 컴퓨터의 브라우저 탭으로 연다('browser'). 포트를 모르거나 그것도
  // 열지 못하면 예전처럼 앱 창만 올린다(showWindowOnly).
  async function browserFallback(terminal, port, opts = {}) {
    if (port) { try { await ovis.openExternal(ovis.paneUrl(port, terminal)); return 'browser' } catch {} }
    return showWindowOnly(terminal, opts)
  }
  // 창 결과로 "어느 길로 보였는가"(결과의 opened): 앱 링크 · 브라우저 탭(링크가 실패해 이 서버가 연 탭). 그 밖에는 적지 않는다.
  const openedBy = (window) => (window === 'app_link' ? { opened: 'app_link' } : window === 'browser' ? { opened: 'browser' } : {})
  async function focus(terminal, opts = {}) {
    const { run = null, seq } = opts
    const how = run ? gate('typing into a session') : null
    // superseded(): the board server's own word on it — it sees the clicks of every runtime, this file only its own.
    const lost = () => !run && Number.isFinite(seq) && (seq < latestClick || opts.superseded?.() === true)
    const skipped = { session: LOOSE_LABEL, pane: terminal, client: 'running', window: 'superseded' }
    if (lost()) return skipped
    if (Number.isFinite(seq)) latestClick = Math.max(latestClick, seq)
    let t
    try { t = await live(terminal, opts.incarnation) } catch (err) {
      // 자기 코어를 띄우는 앱의 세션인데 그 코어의 소켓이 죽어 있다 = 그 앱이 꺼져 있다. 오류(소켓 경로가 든 문구)로 내보내지 않고
      // "앱이 꺼져 있다"로 답한다 — 아무 창도 건드리지 않았고, 세션은 그대로 둔다(수집이 확인 불가로 남긴다).
      // 명령을 넣으려던 요청(이어서 열기)이면 넣지 못했다고 분명히 답한다: "앱이 꺼져 있다"는 창 결과로 돌려주면 부른 쪽이 넣은 줄 안다.
      if (!canFocus() && DEAD.has(err?.code) && run) throw cannot('app_required', 'resuming a session', c.profile?.app)
      if (!canFocus() && DEAD.has(err?.code)) return { session: tag(), pane: terminal, client: 'running', window: 'app_closed', seen: null, app: c.profile?.app || null }
      throw err
    }
    // A newer click arrived while this one was looking the terminal up: it wins, this one moves nothing.
    if (lost()) return skipped
    // 자기 서버로 보여 주는 앱의 코어: 명령은 그 서버로 넣고(typeViaServer), 그냥 이동이면 서버가 살아 있는지만 본다 — 살아 있으면
    // 그 세션의 웹 주소를 결과에 싣는다(url). 주소는 이번에 찾은 포트로 만든다: 앱을 다시 켜 포트가 바뀌었어도 맞는 주소다.
    // 그냥 이동에서는 서버 찾기(health 를 기다린다)를 창 올리기 앞에 두지 않는다 — 함께 시작하고 창을 올린 뒤에 답을 받는다.
    // 위의 lost() 확인과 show() 사이에 기다림이 끼면 그 사이 들어온 더 새 클릭보다 이 클릭이 나중에 창을 올린다("마지막 클릭만
    // 이긴다"가 깨진다). 창이 뜨는 때도 예전 그대로다(서버가 늦게 답해도 창은 클릭하자마자 올라온다).
    let srv = null
    if (run) { if (how === 'server') srv = await typeViaServer(t, run); else await typeInto(t, run) }
    const looking = !run && viaServer() ? findServer().catch(() => null) : null
    // 그 앱이 링크를 알면 앱 창에서 그 세션을 고르게 한다(showByLink). 링크가 실패하면 서버를 찾은 뒤 그 세션의 브라우저 탭을 연다.
    let window = await showByLink(terminal, opts)
    if (window === null) window = await show(terminal, opts)
    if (looking) srv = await looking
    if (window === 'link_failed') window = await browserFallback(terminal, srv?.state === 'ok' ? srv.port : null, opts)
    const url = srv?.state === 'ok' ? ovis.paneUrl(srv.port, terminal) : null
    // Opening a finished session from the board counts as having looked at it (whosup's own label; the app's is left alone).
    // "Finished" is whatever the session showed as finished: toSession decides (an agent can be idle again and still have
    // a turn nobody looked at). seen: true = written, false = could not be written (the session stays "finished"), null = nothing to write.
    // 그 세션을 실제로 보여 준 경우에만 적는다:
    //  · 이 서버가 보여 줬다 — 앱 안의 그 세션으로 보냈거나(herdr-app 이 다루는 코어) 그 세션에 붙는 터미널 창을 열었다.
    //    앱 창만 올렸거나 아무것도 올리지 못했으면 본 것이 아니다(그 앱이 스스로 적는 herdr.seen 을 따른다).
    //  · 브라우저가 보여 줬다 — 이 클릭이 그 세션의 웹 터미널 탭을 열었다(opts.web === true: 보드 화면이 알려 준다).
    // 앱 안의 세션으로 보낼 수단이 없는 코어에서 창을 올리지 않는 클릭(raise:false)은 서버가 아무것도 보여 주지 않는다: 웹 탭을
    // 열었을 때만 본 것이다. 화면이 web 을 알려 주지 않으면(예전 화면) 그 코어의 웹 주소를 이 서버가 알 때만 탭을 연 것으로 본다 —
    // 보드 화면은 열 주소가 있을 때만 raise:false 로 보낸다(index.html clickPlanOf).
    const here = !NOT_SHOWN.has(window) && (canFocus() || window !== 'skipped')
    const onWeb = opts.web === true || (opts.web == null && window === 'skipped' && !canFocus() && Boolean(c.profile?.url))
    let seen = null
    if (!run && (here || onWeb) && toSession(t).status === 'done') { try { seen = await markSeen(terminal, t.created_ms) } catch { seen = false } }
    // means = 명령을 그 앱의 서버로 넣었으면 'server_api'(이어서 열기). 그냥 이동은 적지 않는다 — 주소(url)가 있으면 그것이 수단이다.
    // 앱 링크로 보인 그냥 이동은 'app_link' 다. opened = 어느 길로 보였는가(앱 링크 · 링크가 실패해 연 브라우저 탭).
    const means = run && how === 'server' ? 'server_api' : window === 'app_link' ? 'app_link' : null
    return { session: deskLabel(t), pane: terminal, client: 'running', window, seen, app: c.profile?.app || null, ...(url ? { url } : {}), ...(means ? { means } : {}), ...openedBy(window) }
  }
  // 이어서 열기(그 세션의 터미널에 명령 넣기)를 그 앱의 서버로. 앞에 한가한 셸이 있을 때만 넣는다 — 다른 프로그램이 앞에 있으면 그
  // 프로그램이 글자를 받으므로 서버를 찾기도 전에 거절한다(서버는 무엇이 앞에 있는지 가리지 않고 넣는다). 줄 끝의 \r 이 실행이다.
  // 서버를 찾는 데는 시간이 걸린다(health 를 기다린다). 그 사이 사람이 그 터미널에서 다른 프로그램을 띄웠을 수 있으므로, 서버를 찾은
  // 뒤 넣기 바로 전에 이 코어에서 그 터미널을 다시 읽는다: 같은 터미널이고(created_ms) 여전히 한가한 셸일 때만 넣는다.
  async function typeViaServer(t, text) {
    const notAtShell = () => new Error(`${t.address} is not at a shell prompt`)
    if (!isShell(t)) throw notAtShell()
    const [s] = await viaApi('resuming a session', async (port) => {
      if (!isShell(await live(t.address, t.created_ms))) throw notAtShell()
      await ovis.sendInput(port, t.address, `${text}\r`)
    })
    return s
  }
  // Writes for one terminal go one after another, and each reads the terminal again just before writing: the turn may have
  // moved on while the window was being shown, and a click that finishes late must not put an older turn back.
  const seenWrites = new Map()   // "<address>:<created_ms>" → the write in progress
  function markSeen(terminal, created) {
    const key = `${terminal}:${created}`
    const write = async () => {
      const t = await rpc('terminal.get', { terminal })
      if (!t || t.state !== 'live' || t.created_ms !== created || toSession(t).status !== 'done') return false
      await rpc('terminal.label', { terminal, labels: { 'whosup.seen': String(t.turn) } })
      return true
    }
    const mine = (seenWrites.get(key) || Promise.resolve()).then(write, write)
    const tail = mine.catch(() => {})
    seenWrites.set(key, tail)
    tail.then(() => { if (seenWrites.get(key) === tail) seenWrites.delete(key) })
    return mine
  }

  // ── close one terminal ──
  // With the app open, close its pane (the app ends the terminal and tidies the tab). Otherwise end the terminal directly.
  async function closePane(terminal, { incarnation = null } = {}) {
    const how = gate('closing a session')
    const t = await live(terminal, incarnation)   // the session's own terminal, still there — not a newer one at the same address
    if (how === 'server') return closeViaServer(terminal, t.created_ms ?? incarnation)
    // 앱의 pane 은 herdr-app 을 쓰는 코어가 이 코어 하나뿐일 때만 찾아 닫는다(예전 그대로 주소로 찾는다). 둘 이상이면 주소도
    // 공간 id 도 코어끼리 겹칠 수 있어 앱의 pane 이 이 코어 것인지 확실하지 않다: 앱을 거치지 않고 이 코어의 터미널을 직접 끝낸다
    // (주소만 같은 다른 코어의 pane 을 닫지 않는다).
    const pane = sharedApp() ? null : (await appSpaces())?.flatMap((s) => s.terminals).find((x) => x.terminal === terminal)?.pane
    if (pane && (await appChange('pane.close', { pane })).ok) return { pane: terminal }
    // 앱이 닫지 못했으면 이 코어에서 직접 끝낸다 — 그 전에 그 터미널이 아직 처음 확인한 그 터미널인지 다시 본다(closeViaServer 와 같은 까닭:
    // 앱에 묻고 답을 기다리는 사이에 같은 주소가 다른 터미널에 넘어갔을 수 있고, terminal.kill 은 주소만 본다).
    await live(terminal, t.created_ms ?? incarnation)
    await rpc('terminal.kill', { terminal })
    return { pane: terminal }
  }
  // 자기 서버로 보여 주는 앱의 코어에서 닫기. 부르기 전에 그 터미널이 그 세션의 것임을 이 코어에서 확인했다(closePane 의 live).
  //   서버가 살아 있다  → 서버에 닫아 달라고 한다(그 앱의 목록에서도 바로 사라진다). pane_id 는 코어의 터미널 주소 그대로다.
  //   서버가 없다        → 앱이 꺼져 있다: 이 코어의 터미널을 직접 끝낸다(Herdr 앱 창이 없을 때와 같은 길).
  //   조작을 받지 않는다 → 돌아가지 않고 거절한다(토큰을 건 서버를 코어 소켓으로 비켜 가지 않는다).
  // 서버가 닫지 못했으면(그 사이 꺼졌다·오류로 답했다) 코어에서 직접 끝낸다: 닫기는 두 번 해도 결과가 같다.
  // 코어에서 직접 끝내기 바로 전에 그 터미널을 이 코어에서 다시 읽는다(created = closePane 이 처음 확인한 그 터미널의 created_ms):
  // 서버를 찾고(health 를 기다린다) 서버의 답을 기다리는 사이에 그 세션이 끝나고 같은 주소가 다른 터미널에 넘어갔을 수 있다 —
  // 코어의 terminal.kill 은 주소만 보므로, 다시 확인하지 않으면 그 주소를 물려받은 다른 세션을 끝낸다. 같은 터미널이 아니거나 이미
  // 끝났으면 끝내지 않고 처음 확인과 같은 오류(terminal_not_found)로 답한다: 보드 서버는 그 코드를 "그 세션은 이미 닫혔다"로 읽는다.
  async function closeViaServer(terminal, created) {
    const s = await findServer()
    if (s.state === 'locked') throw cannot('token_required', 'closing a session', c.profile?.app, s.reason)
    if (s.state === 'ok') {
      try { await ovis.closePane(s.port, terminal); return { pane: terminal, means: 'server_api' } } catch (err) {
        if (err?.code === 'token_required') throw cannot('token_required', 'closing a session', c.profile?.app)
      }
    }
    await live(terminal, created)
    await rpc('terminal.kill', { terminal })
    return { pane: terminal, means: 'core_socket' }
  }

  // ── new terminal with a command typed in ──
  // Wait for a live terminal that was not there before (the app's replies are not relied on).
  // "Was not there" is told by address and creation time together (an address can be handed out again).
  /** @param {any} before @param {(x: any) => boolean} [match] @param {number} [tries] */
  async function newTerminal(before, match = () => true, tries = 24) {
    for (let i = 0; i < tries; i++) {
      const t = (await listTerminals()).find((x) => x.state === 'live' && !before.keys.has(keyOf(x)) && match(x))
      if (t) return t
      await sleep(125)
    }
    return null
  }
  const existing = async () => {
    const all = await listTerminals()
    return { keys: new Set(all.map(keyOf)), spaces: new Set(all.map((t) => t.labels?.['herdr.space']).filter(Boolean)) }
  }
  // Creating goes one at a time: the new terminal is recognised as "the one that was not there before", which only holds
  // while nothing else of ours is being created (two desks switched on together took each other's terminal). A terminal the
  // person opens in the app in that same moment can still be taken for it — the match narrows that to the same space.
  let creating = Promise.resolve()
  const oneAtATime = (fn) => { const run = creating.then(() => fn()); creating = run.catch(() => {}); return run }
  // 방금 만든 터미널에 명령을 넣기 전에, 그 셸이 입력을 받을 준비가 될 때까지 기다린다(가-12 B3-1: 에이전트 명령이 두 번 찍힘).
  // 터미널을 만들자마자 글자를 보내면 셸이 뜨기 전이라 터미널이 그 글자를 먼저 한 번 그대로 찍고, 셸이 뜬 뒤 프롬프트 옆에 한 번 더
  // 그린다 — 실행은 한 번인데 두 번 친 것처럼 보인다. herdr 런타임의 새 세션(herdr.mjs shellReady)과 같은 판정이다: 그 터미널의
  // 화면을 읽어 무엇인가 그려졌고(프롬프트 — 빈 줄뿐인 화면은 아직 아무것도 그려지지 않은 것이다) 두 번 이어 같은 내용이면 준비된 것으로
  // 본다. 고정 시간 기다리기가 아니다 — 빠른 셸은 곧바로 지나간다. 화면을 읽지 못하거나 한도(SHELL_WAIT.maxMs)를 넘기면 예전처럼 그냥 보낸다. 화면은 이 코어의 소켓으로 읽는다:
  // Herdr 앱의 탭이든, 코어에 직접 만든 터미널이든, 자기 서버로 보여 주는 앱이 만든 터미널이든 주소는 이 코어의 것이다.
  async function shellReady(terminal) {
    const until = Date.now() + SHELL_WAIT.maxMs
    for (let prev = ''; Date.now() < until; await sleep(SHELL_WAIT.stepMs)) {
      let text
      try { text = String((await rpc('terminal.read', { terminal, lines: 20 }, { timeoutMs: SHELL_WAIT.readMs })).text || '').trim() } catch { return false }
      if (text && text === prev) return true
      prev = text
    }
    return false
  }
  // desk: a desk key of this core. With the app open the terminal is a new tab of that space; without it (or for the desk
  // of terminals outside any space) it is started straight on the core.
  const newSession = (o) => (viaServer() ? openViaServer(o) : oneAtATime(() => openTerminal(o)))
  // 자기 서버로 보여 주는 앱의 코어에서 새 세션: 그 앱의 서버에 셸 세션을 만들어 달라고 한 뒤, 그 터미널에 명령을 입력한다.
  //   데스크가 그 앱의 워크스페이스면(공간 id 가 있다) 그 안의 새 탭으로, 공간 밖 데스크거나 그 워크스페이스가 이제 없으면 새 워크스페이스로.
  //   에이전트는 서버에 시키지 않는다: 서버는 자기 프로세스의 PATH 로 에이전트를 찾아 깔려 있는 것도 없다고 답한 적이 있다(실기기).
  //   후즈업의 명령 문자열을 그 터미널의 셸에 그대로 넣는다(줄 끝의 \r 이 실행) — 다른 런타임과 같은 방식이다.
  // 서버가 만든 터미널의 주소를 답으로 받으므로 "전에 없던 터미널"을 목록에서 찾지 않는다(만들기를 한 줄로 세우지 않아도 된다).
  // 앱이 꺼져 있으면 만들지 않고 거절한다(app_required): 코어에 직접 만든 터미널은 그 앱의 워크스페이스에 들어가지 않는다.
  async function openViaServer({ session: desk, cwd, command, raise = true }) {
    if (!cwd || !existsSync(cwd)) throw herdr.cwdMissing(cwd)
    const space = parseDesk(desk).space
    const [s, made] = await viaApi('a new session', async (port) => {
      const m = await ovis.createSession(port, { cwd, workspaceId: space || null })
      if (command) {
        await shellReady(m.pane)   // 그 셸이 뜬 뒤에 넣는다(명령이 두 번 찍혀 보이지 않게 — 위 shellReady)
        try { await ovis.sendInput(port, m.pane, `${command}\r`) } catch (err) {
          // 터미널은 생겼다: 명령만 들어가지 않았다. 그렇다고 알린다(다음 수집이 그 터미널을 빈 셸 세션으로 잡는다).
          throw Object.assign(new Error(`opened a terminal (${m.pane}) but could not type the command into it: ${String(err?.message || err).slice(0, 160)}`), { code: 'app_server_error', pane: m.pane })
        }
      }
      return m
    })
    // 그 앱이 링크를 알면 방금 만든 세션을 앱 창에서 고르게 한다. 링크가 실패하면 그 세션의 브라우저 탭을 연다. 아니면 예전처럼 앱 창만 올린다.
    let window = await showByLink(made.pane, { raise })
    if (window === null) window = await showWindowOnly(made.pane, { raise })
    else if (window === 'link_failed') window = await browserFallback(made.pane, s.port, { raise })
    return { session: deskKey(made.workspace || (made.fresh ? '' : space)), pane: made.pane, client: 'running', window, app: c.profile?.app || null, url: ovis.paneUrl(s.port, made.pane), means: 'server_api', ...openedBy(window) }
  }
  async function openTerminal({ session: desk, cwd, command, raise = true }) {
    full('a new session')
    if (!cwd || !existsSync(cwd)) throw herdr.cwdMissing(cwd)
    const space = parseDesk(desk).space
    const before = await existing()
    let t = null
    if (space && (await appChange('tab.new', { space, folder: cwd })).ok) t = await newTerminal(before, (x) => x.labels?.['herdr.space'] === space)
    if (!t) t = await rpc('terminal.run', { cwd })
    // 코어가 결과 없이 답하면(result가 null·빠짐 — rpcTo는 그대로 넘긴다) t.address의 TypeError 대신 무엇이 잘못됐는지 알린다.
    if (!t) throw Object.assign(new Error('herdr-core terminal.run: the reply has no terminal'), { code: 'EPROTO' })
    if (command) { await shellReady(t.address); await rpc('terminal.send', { terminal: t.address, text: command }) }
    const window = await show(t.address, { raise })
    return { session: desk, pane: t.address, client: 'running', window }
  }

  // ── turn a desk off and on ──
  async function stopSession(desk) {
    full('switching a desk off')
    const space = parseDesk(desk).space
    // The desk of terminals outside any space is not a space: there is nothing to close as a whole.
    if (!space) throw Object.assign(new Error('that desk cannot be switched off'), { code: 'bad_session' })
    if (switching.has(desk)) throw Object.assign(new Error('that desk is already being switched'), { code: 'busy' })
    switching.add(desk)
    let at = null
    const alive = async () => (await listTerminals()).filter((x) => x.state === 'live' && (x.labels?.['herdr.space'] || '') === space)
    try {
      const mine = await alive()
      // herdr-app 을 쓰는 코어가 둘 이상이면 앱의 공간이 이 코어 것인지 확실하지 않다(공간 id 가 겹칠 수 있다): 앱에 묻지도
      // 시키지도 않고, 이 코어의 터미널만 직접 끝낸다.
      const info = sharedApp() ? null : (await appSpaces())?.find((s) => s.id === space)
      const label = info?.name || spaceName(mine[0]?.labels?.where) || LOOSE_LABEL
      const folder = info?.folder || mine[0]?.cwd || null
      if (!mine.length && !info) return { session: desk, already: true }
      // The desk is written down as off before anything ends: terminals ending make the board collect right away, and a
      // collection that does not know the desk is off counts them as closed instead of keeping them for turning back on.
      at = new Date().toISOString()
      saveOff({ ...offDesks(), [desk]: { label, folder, at } })
      // The app closes the space and ends its terminals in one step; anything still alive (or no app) is ended on the core.
      if (info) await appChange('space.close', { id: space, confirmed: true })
      for (const t of await alive()) { try { await rpc('terminal.kill', { terminal: t.address }) } catch {} }
      let left = await alive()
      for (let i = 0; left.length && i < 10; i++) { await new Promise((r) => setTimeout(r, 200)); left = await alive() }
      if (left.length) throw Object.assign(new Error(`${left.length} terminal(s) did not stop`), { code: 'stop_failed' })
      return { session: desk }
    } catch (e) {
      const off = offDesks()
      // The desk is not off after all. Terminals that did end before the failure are counted as closed by the next
      // collection: each one can still be resumed from Recently closed.
      if (at && off[desk]?.at === at) { delete off[desk]; saveOff(off) }
      throw e
    } finally { switching.delete(desk) }
  }
  // commands: what to type into the new terminals, one each ([{ id, cwd, command }]) — the conversations that were open
  // when the desk was turned off. The first goes into the space's first terminal when that is its folder, the rest into
  // new tabs. Returns which of them were opened (done) and which could not be (failed), by the caller's id.
  async function startSession(desk, _cwd, { raise = true, commands = [] } = {}) {
    full('switching a desk on')
    if (switching.has(desk)) throw Object.assign(new Error('that desk is already being switched'), { code: 'busy' })   // a double click must not make two spaces
    const was = offDesks()[desk]
    if (!was) throw Object.assign(new Error('that desk is not switched off'), { code: 'bad_session' })
    switching.add(desk)
    try { return await oneAtATime(() => bringBack(desk, was, { raise, commands })) } finally { switching.delete(desk) }
  }
  async function bringBack(desk, was, { raise, commands }) {
    const folder = [was.folder, commands[0]?.cwd, homedir()].find((d) => d && existsSync(d))
    const before = await existing()
    let first = null
    const space = await appChange('space.new', { ...(was.label && was.label !== LOOSE_LABEL ? { name: was.label } : {}), folder })
    // The space's first terminal: one that was not there, in a space that was not there.
    if (space.ok) first = await newTerminal(before, (x) => Boolean(x.labels?.['herdr.space']) && !before.spaces.has(x.labels['herdr.space']))
    if (!first) first = await rpc('terminal.run', { cwd: folder })
    // 코어가 결과 없이 답하면(newSession과 같은 경우) first.labels의 TypeError 대신 무엇이 잘못됐는지 알린다.
    if (!first) throw Object.assign(new Error('herdr-core terminal.run: the reply has no terminal'), { code: 'EPROTO' })
    // From here on the desk is on again (its space exists): whatever goes wrong with one conversation is reported for that
    // conversation, and the switched-off record goes — a second try must not make a second space.
    const newDesk = deskKey(first.labels?.['herdr.space'] || '')
    const opened = [], done = [], failed = []
    for (const [i, cm] of commands.entries()) {
      try {
        // A conversation is resumed in the folder it ran in. The first terminal is used only when that is its folder.
        const cwd = cm.cwd && existsSync(cm.cwd) ? cm.cwd : null
        if (i === 0 && (!cwd || cwd === first.cwd)) { if (cm.command) { await shellReady(first.address); await rpc('terminal.send', { terminal: first.address, text: cm.command }) } opened.push(first.address) }
        else opened.push((await openTerminal({ session: newDesk, cwd: cwd || folder, command: cm.command, raise: false })).pane)
        if (cm.id != null) done.push(cm.id)
      } catch { if (cm.id != null) failed.push(cm.id) }
    }
    // Read the list again: other desks may have been switched while this one was starting.
    const off = offDesks()
    if (off[desk]) { delete off[desk]; saveOff(off) }
    const window = await show(first.address, { raise })
    return { session: newDesk, client: 'started', window, opened, done, failed }
  }

  return Object.assign(c, { canFocus, viaServer, features, why, there, rpc, deskKey, tag, toSession, listTerminals, listSnapshot, watchEvents, unwatch, readScreen, show, focus,
    closePane, newSession, stopSession, startSession, resetScreenCache: () => trustSeen.clear() })
}
const TRUST_TTL_MS = 4000
const keyOf = (t) => `${t.address}:${t.created_ms}`

// ── 밖에서 부르는 길: 세션 ref 나 데스크 열쇠가 가리키는 코어의 인스턴스로만 보낸다 ─────────
// The terminal a session points at — only for sessions of a core this whosup is reading.
// 지금 읽지 않는 코어의 세션이면 code 'core_unavailable' 로 거절한다. "터미널이 없다"(terminal_not_found)와 다르다: 그 코어가
// 터미널이 없다고 답한 것이 아니라 물어볼 코어가 없는 것이므로, 보드 서버는 이 오류로 세션을 닫힘으로 옮기지 않는다.
function coreOfRef(ref) {
  const r = splitRef(ref)
  const c = cores().find((x) => x.name === r.core)
  if (!c) throw Object.assign(new Error(`herdr-core "${r.core}" is not one of the cores being read (session ${ref})`), { code: 'core_unavailable' })
  return [c, r.terminal]
}
function coreOfDesk(desk) {
  if (!isDesk(desk)) throw Object.assign(new Error(`invalid herdr-core desk: ${String(desk).slice(0, 60)}`), { code: 'bad_session' })
  const d = parseDesk(desk)
  const c = d.core === null ? baseCore() : cores().find((x) => !x.base && x.name === d.core)
  if (!c) throw Object.assign(new Error(`invalid herdr-core desk: no such core (${String(d.core).slice(0, 60)})`), { code: 'bad_session' })
  return c
}
// 그 세션·데스크에서 닫기·새 세션·이어서 열기·끄고 켜기를 할 수 있는가(그 코어를 읽고 있고, 앱 안의 세션으로 보낼 수단이 있다).
// 화면의 단추(caps)와 서버 경로의 거절이 같은 이 판정을 쓴다.
export function canManage(ref) { try { return coreOfRef(ref)[0].canFocus() } catch { return false } }
export function canManageDesk(desk) { try { return coreOfDesk(desk).canFocus() } catch { return false } }
// 기능별 판정 — 위 둘("전부 된다": herdr-app 의 코어, 데스크 끄고 켜기까지)과 따로, 자기 서버로 코어를 보여 주는 앱의 코어처럼
// 일부만 되는 코어를 위한 것이다. 그 세션·데스크에서 되는 기능과 수단: { new, focus, close, resume } 마다 { means, reason? }
// (값의 뜻은 ovis.mjs 의 coreFeatures). 지금 읽지 않는 코어·모르는 데스크는 넷 다 none 이다.
// 묻지 않고 답한다(프로필에서 읽는다): 화면의 단추와 서버 경로의 첫 문이 쓴다. 실제로 되는지는 일을 시킬 때 런타임이 다시 확인하고,
// 안 되면 까닭 코드(app_required · token_required · not_supported)로 거절한다.
const NO_FEATURES = () => ovis.allFeatures('none', 'not_supported')
export function featuresOf(ref) { try { return coreOfRef(ref)[0].features() } catch { return NO_FEATURES() } }
export function featuresOfDesk(desk) { try { return coreOfDesk(desk).features() } catch { return NO_FEATURES() } }
// 그 세션·데스크에서 그 기능(new·focus·close·resume)을 할 수 없는 까닭: 오류 모양({ code, app, message }) 또는 null(할 수 있다).
// code = app_required · token_required · not_supported — 일을 시켰을 때 런타임이 던지는 거절과 같은 값이다(서버의 첫 문이 그대로 답한다).
export function refusalOf(ref, cap) { try { return coreOfRef(ref)[0].why(cap) } catch { return notSupported(WHAT[cap] || 'that') } }
export function refusalOfDesk(desk, cap = 'new') {
  try { return coreOfDesk(desk).why(cap) } catch {
    const gone = cap === 'new' ? goneAppCore(desk) : null
    return gone ? cannot('app_required', WHAT.new, gone.app) : notSupported(WHAT[cap] || 'that')
  }
}
// 지금은 읽지 않는 코어의 데스크인데, 이 보드가 도는 동안 "자기 서버로 보여 주는 앱의 코어"(프로필 focus:false)로 읽은 적이 있는 코어인가.
// 그 앱을 끄면 다음 자동 감지에서 그 코어가 빠지고, 열린 세션도 없으면 읽기를 그만둔다(위 "목록에서 빠진 코어"). 그 사이 열려 있던
// 새 세션 창의 "그 앱 · 새 데스크"를 누르면 여기로 온다: 수단을 모르는 것이 아니라 앱을 켜면 되는 일이므로 그렇게 답한다(app_required
// 와 그 앱 이름 — 세션이 남아 붙잡아 둔 코어가 하는 답과 같다). 본 적 없는 코어·기본 코어의 데스크·지금 읽고 있는 이름은
// null(예전 그대로 not_supported).
function goneAppCore(desk) {
  if (!isDesk(desk)) return null
  const name = parseDesk(desk).core
  if (name === null || cores().some((x) => x.name === name)) return null
  const last = lastAutoCore(name)
  return last && last.focus === false ? last : null
}
// "보기"(이동·웹 주소)를 넘는 일 가운데 그 세션에서 되는 것: ['close', 'resume', 'new'] 의 부분(그 순서로). 세션마다 불린다.
export const capsVia = (ref) => { const f = featuresOf(ref); return EXTRA_CAPS.filter((k) => f[k].means !== 'none') }
// 그 데스크에 새 세션을 열 수 있는가(데스크 끄고 켜기와 따로 본다 — 그것은 canManageDesk).
export const canNewIn = (desk) => featuresOfDesk(desk).new.means !== 'none'
// 지금 읽는 코어마다 "되는 기능": [{ name, app(모르면 null), features: { new, focus, close, resume } 마다 { means, reason? } }].
// 보드 서버가 판 응답(/api/board 의 cores)에 싣는다. 부를 때마다 코어 프로필(focus·url·app)에서 다시 계산한다 — 여기에도, 판 응답에도
// 포트·주소·토큰은 들어가지 않고, 어디에도 저장하지 않는다(그 앱의 서버가 살아 있는지·포트가 무엇인지는 바뀐다).
export const profilesView = () => cores().map((c) => ({ name: c.name, app: c.profile?.app || null, features: c.features() }))
// 자기 서버로 보여 주는 앱의 코어마다, 화면이 그 세션을 브라우저 탭으로 열 때 쓰는 주소 틀: { <코어 이름>: 'http://…/?pane={pane}&view=terminal' }.
// 코어 프로필의 url 에 터미널 보기(view=terminal)가 없으면 붙인다(ovis.mjs withTerminalView) — 런타임이 이동 결과에 싣는 주소(paneUrl)와
// 같은 모양이 된다. herdr 데스크를 보여 주는 웹 터미널의 주소(데스크별 open_url)는 여기서 다루지 않는다: 그쪽은 예전 그대로다.
export function openUrlTemplates() {
  const out = {}
  for (const c of cores()) if (c.viaServer() && c.profile?.url) out[c.name] = ovis.withTerminalView(c.profile.url)
  return out
}

export function toSession(t, opts) { return baseCore().toSession(t, opts) }
export const _resetScreenCache = () => { for (const c of made.values()) c.resetScreenCache() }   // tests
export const listTerminals = () => baseCore().listTerminals()

// ── listing ─────────────────────────────────────────────────────────
// 읽을 코어를 한꺼번에 읽는다: [{ core, snap } | { core, absent: true } | { core, err }].
// 코어끼리는 서로 기다리지 않는다(동시에 묻는다) — 한 번의 수집은 가장 늦게 답한 코어만큼만 걸린다. 답하지 않는 코어는
// 그때부터 한동안 짧게만 기다린다(makeCore 의 listForCollect).
// 파일만 남은 소켓(코어는 죽었다 — DEAD)은 꺼진 코어로 본다(오류로 쌓지 않는다).
async function readAll() {
  const list = cores()
  prune(list)
  return Promise.all(list.map(async (c) => {
    if (!c.there()) return { core: c, absent: true }
    try { return { core: c, snap: await c.listSnapshot() } } catch (err) { return DEAD.has(err?.code) ? { core: c, absent: true } : { core: c, err } }
  }))
}
const partOf = (c) => ({ key: c.name, label: c.base ? LOOSE_LABEL : c.tag(), owns: (ref) => String(ref).startsWith(`${c.name}/`) })
function merged(results) {
  const read = results.filter((r) => r.snap)
  return {
    sessions: read.flatMap((r) => r.snap.sessions), unreachable: [], stopped: Object.keys(offDesks()),
    // 닿지 못한 코어: 그 코어의 세션만 확인 불가로 둔다(수집기가 이 목록으로 행을 가른다 — collector.mjs parts).
    parts: results.filter((r) => !r.snap).map((r) => partOf(r.core)),
  }
}
export async function listSnapshotAsync() {
  const results = await readAll()
  if (!results.some((r) => r.snap)) throw results.find((r) => r.err)?.err || notRunning()
  return merged(results)
}
// What the collector gets. null = no core here (skip quietly). A core that is there but did not answer keeps every
// session as it was ("can't check"), the same promise the herdr runtime makes for a herdr session it could not read.
// 코어가 여럿이면 한 번에 읽어 한 목록으로 합친다. 일부 코어에만 닿지 못했으면 그 코어의 세션만 확인 불가로 남는다(parts) —
// 한 코어가 꺼졌다고 다른 코어의 세션이 닫힘으로 가지 않는다. downs = 닿지 못한 코어 [{ name, label, err|null(꺼짐) }].
export async function snapshotRuntime() {
  const base = { name, FIELDS, TRACKS_GONE, IDLE_AFTER_WORK_IS_DONE, AGENT_CHANGE_IS_NEW, deskOf }
  // Which desks the person switched off is written on this machine, not asked from the core: it holds while the core is away.
  const heldAll = () => ({ sessions: [], unreachable: [LOOSE_LABEL], stopped: Object.keys(offDesks()), holdAll: true })
  const results = await readAll()
  if (!results.some((r) => r.snap)) {
    const err = results.find((r) => r.err)?.err
    return err ? { ...base, snap: undefined, err, listSnapshot: heldAll } : { ...base, absent: true, listSnapshot: heldAll }
  }
  const snap = merged(results)
  const downs = results.filter((r) => !r.snap).map((r) => ({ name: r.core.name, label: partOf(r.core).label, err: r.err || null }))
  return { ...base, snap, downs, listSnapshot: () => snap }
}

// ── change events ───────────────────────────────────────────────────
export function watchEvents(onChange) {
  if (process.env.WHOSUP_NO_EVENTS === '1') return
  const list = cores()
  prune(list)
  for (const c of list) c.watchEvents(onChange)
}
export function stopWatching() { for (const c of made.values()) c.unwatch() }

// ── screen text ─────────────────────────────────────────────────────
export async function readScreen(ref, lines = 60) { const [c, terminal] = coreOfRef(ref); return c.readScreen(terminal, lines) }

// ── jump · close ────────────────────────────────────────────────────
export const __showForTest = (terminal, opts) => baseCore().show(terminal, opts)   // tests: the window step alone
export async function focus(ref, opts = {}) { const [c, terminal] = coreOfRef(ref); return c.focus(terminal, opts) }
export const warmClick = () => {}
export async function closePane(ref, opts = {}) { const [c, terminal] = coreOfRef(ref); return c.closePane(terminal, opts) }

// ── new session · desks ─────────────────────────────────────────────
export async function newSession(o) { return coreOfDesk(o?.session).newSession(o) }
export const validSessionName = isDesk
export async function stopSession(desk) { return coreOfDesk(desk).stopSession(desk) }
export async function startSession(desk, cwd, opts) { return coreOfDesk(desk).startSession(desk, cwd, opts) }

// Desks a new session can go to: every space of the open app window plus desks already on the board.
// 새 세션을 열 수 없는 코어(수단을 모르거나, 자기 서버로 보여 주는 앱이 꺼져 있다)의 데스크는 내놓지 않는다. herdr-app 이 답한 공간은
// 그 공간을 가진 코어(터미널 라벨 herdr.space 로 대조)의 데스크로 적는다 — herdr-app 을 쓰는 코어가 하나뿐이면 그 코어 것이다.
// 자기 서버로 새 세션을 만들 수 있는 코어는 판에 있는 그 코어의 데스크(그 워크스페이스의 새 탭이 된다)에 더해 "그 앱에 새 데스크"
// 자리를 하나 내놓는다(공간 밖 데스크의 열쇠, 이름은 앱 이름 — kind 'new_desk'): 세션이 하나도 없는 앱에도 첫 세션을 열 수 있다.
// 다만 그런 코어의 데스크는 부른 쪽이 perFeature:true 로 청했을 때만 내놓는다. 여기 내놓은 데스크는 화면의 새 세션 창에 그대로 뜨는데,
// 서버 경로의 문(/api/new)이 "전부 되는 코어"(canManageDesk)만 들이는 동안에는 눌러도 거절뿐이다. 기능별 문(canNewIn — 새 세션만
// 따로 본다)을 연 서버만 perFeature 로 부른다: 목록과 문이 서로 어긋난 채로 나갈 수 없다(주지 않으면 예전 목록 그대로다).
export async function targets(known = [], { perFeature = false } = {}) {
  const out = new Map(known.filter((k) => canManageDesk(k.key) || (perFeature && canNewIn(k.key))).map((k) => [k.key, k]))
  for (const c of perFeature ? cores() : []) {
    if (c.canFocus() || c.features().new.means === 'none') continue
    const key = c.deskKey('')
    if (!out.has(key)) out.set(key, { key, label: c.tag(), kind: 'new_desk' })
  }
  const able = cores().filter((c) => c.canFocus())
  if (!able.length) return [...out.values()]
  for (const s of (await herdrAppSpaces()) || []) {
    const owner = able.find((c) => c.spaces.has(s.id)) || (able.length === 1 ? able[0] : null)
    if (owner) out.set(owner.deskKey(s.id), { key: owner.deskKey(s.id), label: s.name || s.id })
  }
  return [...out.values()]
}
