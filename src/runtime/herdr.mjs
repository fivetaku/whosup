// herdr runtime: every herdr pane of every running herdr session, with agent status where herdr detects one.
// Nothing here assumes a terminal app, a herdr session name, or an agent wrapper.
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { commandFor, connectTarget, isWindows, platform, psQuote } from '../platform.mjs'
import { STATE_DIR } from '../db.mjs'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'herdr'
export const FIELDS = ['lastStatus', 'requiresAttention', 'attentionReason', 'lastUserMessageAt', 'title']
export const TRACKS_GONE = true
// 윈도우 herdr는 끝난 herdr pane을 '답변 도착(done)' 없이 바로 '유휴(idle)'로 알린다 → 수집기가 답변 도착으로 해석한다(collector inferDone).
export const IDLE_AFTER_WORK_IS_DONE = process.platform === 'win32'
export const TEST_SESSION_PREFIX = 'whosuptest-'

// 윈도우에는 정해진 설치 위치가 없어 PATH의 herdr(또는 HERDR_BIN·HERDR_BIN_PATH)를 쓴다.
const BIN_CANDIDATES = () => (isWindows() ? [] : ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr', join(homedir(), '.local', 'bin', 'herdr')])
// herdr 실행 파일 찾기는 여기 한 곳(I-4). 세션 화면 읽기(context.mjs)·데스크 스크립트(desks.mjs)도 이것을 쓴다.
// 환경변수가 없을 때의 후보 탐색(--version)은 프로세스당 한 번만 한다.
let probed
const probe = () => BIN_CANDIDATES().find((p) => { try { execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' }); return true } catch { return false } }) || 'herdr'
export const bin = () => process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || (probed ??= probe())

// herdr 실행: 실행 파일이 node 스크립트(시험의 가짜 herdr)면 지금 도는 node로 돌린다 — 윈도우는 shebang을 읽지 않는다.
export const herdrCommand = (args, session) => commandFor(bin(), session ? ['--session', session, ...args] : args)
function herdr(args, session) {
  const [file, argv] = herdrCommand(args, session)
  return execFileSync(file, argv, { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' })
}
const herdrJson = (args, session) => JSON.parse(herdr(args, session)).result

// 비동기 호출: 수집·상태 확인이 서버의 이벤트 루프를 붙잡지 않게 한다(동기 실행은 herdr 한 번에 6~9ms, herdr 세션 3개면 수집마다 50ms+ 멈췄다).
const herdrAsync = (args, session) => new Promise((resolve, reject) => {
  const [file, argv] = herdrCommand(args, session)
  execFile(file, argv, { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024 },
    (err, stdout) => (err ? reject(err) : resolve(stdout)))
})
const herdrJsonAsync = async (args, session) => JSON.parse(await herdrAsync(args, session)).result

// herdr 세션 목록은 `herdr session list --json`을 먼저 읽는다(0.9.3 실측: { sessions: [{ name, running, session_dir, socket_path }] }).
// 그 옵션이 없는 herdr면 표(name status directory socket)를 읽는다. 표의 폴더·소켓 열에는 공백이 들 수 있어서
// (C:\Users\Hong Gildong\…) 공백으로 다 자르지 않는다 — 소켓은 세션 폴더 안에 있으므로, 오른쪽이 왼쪽으로 시작하는
// 자리에서 둘을 가른다. 그런 자리가 없으면 마지막 공백에서 가른다(끝 열부터 자르기).
const notTest = (r) => !r.name.startsWith(TEST_SESSION_PREFIX)
export function parseSessionJson(text) {
  const o = JSON.parse(text)
  const list = Array.isArray(o?.sessions) ? o.sessions : Array.isArray(o?.result?.sessions) ? o.result.sessions : null
  if (!list) throw new Error('herdr session list --json: no sessions array')
  return list.filter((s) => s && typeof s.name === 'string' && s.name)
    .map((s) => ({ name: s.name, status: s.running ? 'running' : 'stopped', dir: String(s.session_dir ?? ''), socket: String(s.socket_path ?? '') }))
    .filter(notTest)
}
function splitSessionRow(line) {
  const m = line.trim().match(/^(\S+)\s+(\S+)\s+(.+)$/)
  if (!m) return null
  const [, name, status, rest] = m
  const gaps = [...rest.matchAll(/\s+/g)]
  if (!gaps.length) return null
  const at = (g) => ({ name, status, dir: rest.slice(0, g.index), socket: rest.slice(g.index + g[0].length) })
  return gaps.map(at).find((r) => r.socket.startsWith(r.dir)) || at(gaps.at(-1))
}
export const parseSessionTable = (text) => String(text).split(/\r?\n/).slice(1).map(splitSessionRow).filter(Boolean).filter(notTest)
// --json을 받는 herdr인지는 처음 한 번 읽어 보고 프로세스 메모리에만 기억한다. 실행 파일이 없으면(ENOENT) 그대로 알린다.
let jsonList
const readSessions = async (call) => {
  if (jsonList !== false) {
    try { const rows = parseSessionJson(await call(['session', 'list', '--json'])); jsonList = true; return rows } catch (err) {
      if (jsonList === true || err?.code === 'ENOENT') throw err
      jsonList = false
    }
  }
  return parseSessionTable(await call(['session', 'list']))
}
const readSessionsSync = (call) => {
  if (jsonList !== false) {
    try { const rows = parseSessionJson(call(['session', 'list', '--json'])); jsonList = true; return rows } catch (err) {
      if (jsonList === true || err?.code === 'ENOENT') throw err
      jsonList = false
    }
  }
  return parseSessionTable(call(['session', 'list']))
}
export const _resetSessionFormat = () => { jsonList = undefined }   // 시험
// 마지막으로 읽은 herdr 세션 표. 수집(3초)마다 갱신된다 — 클릭 경로가 herdr를 두 번 더 실행하지 않고 이것을 쓴다.
let tableCache = { at: 0, rows: [] }
const remember = (rows) => { tableCache = { at: Date.now(), rows }; return rows }
export function sessionTable() { return remember(readSessionsSync((a) => herdr(a))) }
export async function sessionTableAsync() { return remember(await readSessions((a) => herdrAsync(a))) }
// maxAgeMs 안에 읽은 표가 있으면 그것을, 없으면 새로 읽는다.
export async function sessionTableRecent(maxAgeMs = 4000) { return Date.now() - tableCache.at < maxAgeMs ? tableCache.rows : sessionTableAsync() }
export const forgetSessionTable = () => { tableCache = { at: 0, rows: [] } }
export const runningSessions = () => sessionTable().filter((s) => s.status === 'running').map((s) => s.name)
export const runningSessionsAsync = async () => (await sessionTableAsync()).filter((s) => s.status === 'running').map((s) => s.name)

export const normalizeStatus = (s) => (['working', 'done', 'blocked', 'idle'].includes(s) ? s : 'unknown')

// One record per herdr pane. Agent info (kind, session id, status) is layered on when herdr reports it;
// a plain shell pane is still listed so the board shows the whole desk.
export function toSession(session, pane, agent) {
  const cwd = agent?.foreground_cwd || pane.cwd || agent?.cwd || ''
  const status = agent ? normalizeStatus(agent.agent_status) : 'shell'
  const label = pane.label || null
  const title = agent?.terminal_title_stripped && agent.terminal_title_stripped !== 'Claude Code'
    ? agent.terminal_title_stripped
    : label || basename(cwd) || pane.pane_id
  return {
    runtime: 'herdr',
    runtime_ref: `${session}/${pane.pane_id}`,
    provider_session: agent?.agent_session?.value ?? null,
    cwd,
    project: basename(cwd.replace(/\/+$/, '')) || '-',
    title,
    pane_label: label,
    provider: agent?.agent ?? null,
    status,
    attentionTimestamp: null,
    archived: false,
    fields: {
      lastStatus: { working: 'running', blocked: 'error', done: 'idle', idle: 'idle', shell: 'shell' }[status] || 'unknown',
      requiresAttention: status === 'done' || status === 'blocked',
      attentionReason: status === 'done' ? 'finished' : status === 'blocked' ? 'blocked' : null,
      lastUserMessageAt: null,
      title,
    },
  }
}

// 한 번의 조회 결과. unreachable = 목록에는 있지만 이번에 herdr pane을 읽지 못한 herdr 세션 이름(멈춘 세션 포함).
// 그 데스크의 세션은 "사라짐"이 아니라 "확인 불가"로 다뤄야 한다(약속 1·5).
export function listSnapshot() {
  const out = []
  const unreachable = []
  const stopped = []
  for (const row of sessionTable()) {
    // 서버를 끈 데스크: 세션은 남기되 "꺼짐"으로 — 조회 실패(확인 불가)와 구분한다.
    if (row.status !== 'running') { stopped.push(row.name); continue }
    let panes = []
    let agents = []
    try { panes = herdrJson(['pane', 'list'], row.name).panes || [] } catch { unreachable.push(row.name); continue }
    try { agents = herdrJson(['agent', 'list'], row.name).agents || [] } catch { agents = null }
    // agent list만 실패하면 herdr pane은 보이지만 에이전트 상태를 모른다 — 빈 세션(shell)으로 강등하지 않고 확인 불가로 둔다.
    if (agents === null) { unreachable.push(row.name); continue }
    const byPane = new Map(agents.map((a) => [a.pane_id, a]))
    for (const pane of panes) out.push(toSession(row.name, pane, byPane.get(pane.pane_id)))
  }
  return { sessions: out, unreachable, stopped }
}

export function listSessions() {
  return listSnapshot().sessions
}

// listSnapshot의 비동기판: herdr 세션마다 pane list·agent list를 동시에 부른다. 판정 규칙은 listSnapshot과 같다.
export async function listSnapshotAsync() {
  const table = await sessionTableAsync()
  const per = await Promise.all(table.map(async (row) => {
    if (row.status !== 'running') return { stopped: row.name }
    try {
      const [p, a] = await Promise.all([herdrJsonAsync(['pane', 'list'], row.name), herdrJsonAsync(['agent', 'list'], row.name)])
      const byPane = new Map((a.agents || []).map((x) => [x.pane_id, x]))
      return { sessions: (p.panes || []).map((pane) => toSession(row.name, pane, byPane.get(pane.pane_id))) }
    } catch { return { unreachable: row.name } }
  }))
  return {
    table,
    sessions: per.flatMap((x) => x.sessions || []),
    unreachable: per.filter((x) => x.unreachable).map((x) => x.unreachable),
    stopped: per.filter((x) => x.stopped).map((x) => x.stopped),
  }
}
// 수집기에 넘길 런타임: 미리 읽어 둔 조회 결과(또는 그 실패)를 그대로 돌려준다. collectOnce는 동기 그대로 둔다.
export async function snapshotRuntime() {
  let snap, err
  try { snap = await listSnapshotAsync() } catch (e) { err = e }
  return { name, FIELDS, TRACKS_GONE, IDLE_AFTER_WORK_IS_DONE, snap, err, absent: err?.code === 'ENOENT', listSnapshot: () => { if (err) throw err; return snap } }
}

// ── herdr 이벤트 구독 ── herdr 세션 소켓에 events.subscribe를 걸어 두고, herdr pane이 생기거나 닫히거나 에이전트 상태가 바뀌면 onChange를 부른다.
// 수집 주기(3초)를 기다리지 않고 바로 수집하게 하는 지름길일 뿐이다 — 구독이 안 되는 herdr여도 주기 수집이 그대로 돈다.
// 상태 변화 구독은 herdr pane마다 걸어야 해서(pane_id 필수), herdr pane 구성이 바뀌면 그 herdr 세션의 연결을 새로 맺는다.
const WATCH_GLOBAL = ['pane.created', 'pane.closed', 'pane.exited', 'pane.agent_detected']
const watchers = new Map() // herdr 세션 이름 → { sock, key, dead }
export function watchEvents(sessions, table, onChange) {
  if (process.env.WHOSUP_NO_EVENTS === '1') return
  const panesBy = new Map()
  for (const s of sessions) { const { session, pane } = splitRef(s.runtime_ref); if (!panesBy.has(session)) panesBy.set(session, []); panesBy.get(session).push(pane) }
  for (const row of table) {
    if (row.status !== 'running') continue
    const panes = (panesBy.get(row.name) || []).sort()
    const key = panes.join(',')
    const cur = watchers.get(row.name)
    if (cur && cur.key === key && (cur.dead || !cur.sock.destroyed)) continue
    cur?.sock.destroy()
    const sock = createConnection(connectTarget(row.socket))
    const w = { sock, key, dead: false }
    watchers.set(row.name, w)
    let buf = ''
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: 'whosup:watch', method: 'events.subscribe', params: { subscriptions: [...WATCH_GLOBAL.map((type) => ({ type })), ...panes.map((pane_id) => ({ type: 'pane.agent_status_changed', pane_id }))] } })}\n`))
    sock.on('data', (chunk) => {
      buf += chunk
      let i; let hit = false
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.includes('"event"')) hit = true
        else if (line.includes('"error"')) { w.dead = true; sock.destroy() }   // 구독을 모르는 herdr: 이 herdr pane 구성에서는 다시 시도하지 않는다
      }
      if (hit) onChange(row.name)
    })
    const drop = () => { if (watchers.get(row.name) === w && !w.dead) watchers.delete(row.name) }
    sock.on('error', drop); sock.on('close', drop)
  }
  for (const [n, w] of watchers) if (!table.some((r) => r.name === n && r.status === 'running')) { w.sock.destroy(); watchers.delete(n) }
}
export function stopWatching() { for (const w of watchers.values()) w.sock.destroy(); watchers.clear() }

// Raw socket call for requests the CLI lacks (pane.focus).
export async function apiCall(session, method, params, { timeoutMs = 5000 } = {}) {
  // 최근(수집·미리 데우기) 읽은 herdr 세션 표를 쓴다 — 클릭마다 herdr를 한 번 더 실행하지 않는다. 표에 없으면 새로 읽어 본다.
  const row = (await sessionTableRecent()).find((s) => s.name === session) || (await sessionTableAsync()).find((s) => s.name === session)
  if (!row) throw new Error(`herdr session not found: ${session}`)
  return new Promise((resolve, reject) => {
    // Windows herdr listens on a named pipe \\.\pipe\<socket path>; the .sock file only holds pid:nonce (Windows 실기기 실측).
    const sock = createConnection(connectTarget(row.socket))
    let buf = ''
    const timer = setTimeout(() => { sock.destroy(); reject(new Error(`herdr ${method}: no reply`)) }, timeoutMs)
    sock.on('connect', () => sock.write(`${JSON.stringify({ id: `whosup:${method}`, method, params })}\n`))
    sock.on('data', (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0) return
      clearTimeout(timer)
      sock.end()
      const res = JSON.parse(buf.slice(0, nl))
      if (res.error) reject(new Error(`herdr ${method}: ${res.error.code} ${res.error.message}`))
      else resolve(res.result)
    })
    sock.on('error', (err) => { clearTimeout(timer); reject(err) })
  })
}

export function splitRef(ref) {
  const i = ref.indexOf('/')
  if (i <= 0) throw new Error(`bad herdr ref: ${ref}`)
  return { session: ref.slice(0, i), pane: ref.slice(i + 1) }
}

// 없는 폴더(지워진 worktree 등)로 열면 사용자가 고칠 수 있는 오류로 돌려준다(F7·F11).
export function cwdMissing(dir) {
  const err = new Error(`folder no longer exists: ${dir}`)
  err.code = 'cwd_missing'
  return err
}

const isRunning = async (session, fresh) => (fresh ? await sessionTableAsync() : await sessionTableRecent()).some((s) => s.name === session && s.status === 'running')
async function ensureServer(session, dir) {
  // 최근 표에 켜져 있다고 나오면 그대로 믿고(틀렸으면 focusNow가 새로 읽고 다시 한다), 꺼져 있다고 나오면 새로 읽어 확인한 뒤에 띄운다.
  if (await isRunning(session, false) || await isRunning(session, true)) return 'running'
  if (dir && !existsSync(dir)) throw cwdMissing(dir)
  // spawn 실패는 'error' 이벤트로 온다. 리스너가 없으면 상주 서버가 통째로 죽는다(#2).
  let spawnErr = null
  const [file, argv] = herdrCommand(['server'], session)
  const child = spawn(file, argv, { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true })
  child.once('error', (err) => { spawnErr = err })
  child.unref()
  for (let i = 0; i < 20 && !spawnErr && !(await isRunning(session, true)); i++) await sleep(250)
  if (spawnErr) throw new Error(`could not start herdr session ${session}: ${spawnErr.message}`)
  if (!(await isRunning(session, true))) throw new Error(`could not start herdr session ${session}`)
  return 'started'
}

// Which terminal app to bring forward on macOS. Order: the app chosen in settings > FRONT_APP > the app
// that is showing a herdr client right now (auto) > the system terminal. Nothing has to be configured for a click
// to end in a terminal window.
// The terminal may run as several app instances (Ghostty `open -na`), so "activate the app" can raise the wrong
// window. Raise the instance whose process tree holds a herdr client attached to this herdr session instead.
const clientArgv = (session) => (session === 'default' ? [] : ['--session', session])
export const DEFAULT_TERMINAL = 'Terminal'
// 설정에서 고른 앱(서버가 저장·시작 때 넣어 준다). 넣은 적이 없으면 환경변수 FRONT_APP을 본다. ''이면 자동.
// auto: 자동 감지(auto.json L4)가 정한 앱. 사람이 고른 앱이 없을 때만 쓴다. 맥에서는 '고른 앱'이 아니라 '떠 있는 창이 없을 때
// 새 창을 열 앱'으로만 쓴다 — 고른 앱처럼 쓰면 시작 때 본 앱에 굳어, 그 herdr 세션을 지금 다른 앱이 보여 줘도 그 창을 못 찾는다.
// 'off'(원격 실행 등)는 맥·윈도우 모두 창 올리기를 끈다.
let appChoice
let appAuto = ''
export const setFrontApp = (v, auto = '') => { appChoice = String(v ?? '').trim(); appAuto = String(auto ?? '').trim() }
export const configuredApp = () => (appChoice !== undefined ? appChoice : (process.env.FRONT_APP || '').trim())
const effectiveApp = () => configuredApp() || appAuto
export const isOffApp = (v) => /^(off|none|no|0|false|disabled?|끔)$/i.test(String(v ?? '').trim())

// 명령줄에서 그 프로세스가 속한 앱 이름을 꺼낸다. 앱 안에 든 도우미 앱(…/Code.app/Contents/Frameworks/Code Helper.app/…)은
// 창을 가진 프로세스가 아니므로 건너뛴다 — 부모를 더 올라가면 본체가 나온다.
const APP_OF = /^(?:(?!\.app\/).)*\/([^/]+)\.app\/Contents\/MacOS\//
// ps rows -> [{ pid, app }]: `session`의 herdr 클라이언트를 품은 앱 프로세스, 최근 클라이언트 먼저.
// session이 null이면 어느 herdr 세션의 클라이언트든, app이 비면 어느 앱이든 받는다.
export function terminalHostsFor(psText, session = null, app = '') {
  const rows = psText.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd }))
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const want = session === null ? null : clientArgv(session).join(' ')
  const isClient = (cmd) => {
    const m = cmd.match(/^(?:-)?(?:\S*\/)?herdr(?:\s+(.*))?$/)
    if (!m) return false
    const rest = (m[1] || '').trim()
    return want === null ? /^(--session\s+\S+)?$/.test(rest) : rest === want
  }
  const wantApp = String(app || '').replace(/[^A-Za-z0-9 ._-]/g, '').toLowerCase()
  const out = []
  for (const r of rows.filter((x) => isClient(x.cmd)).sort((a, b) => b.pid - a.pid)) {
    for (let cur = byPid.get(r.ppid), hops = 0; cur && hops < 8; cur = byPid.get(cur.ppid), hops++) {
      const name = APP_OF.exec(cur.cmd)?.[1]
      if (!name || (wantApp && name.toLowerCase() !== wantApp)) continue
      if (!out.some((h) => h.pid === cur.pid)) out.push({ pid: cur.pid, app: name })
      break
    }
  }
  return out
}
export const terminalPidsFor = (psText, session, app) => terminalHostsFor(psText, session, app).map((h) => h.pid)

// 새 창을 열어 그 herdr 세션에 붙이는 방법을 아는 앱. 여기 없는 앱은 이미 떠 있는 창만 올린다.
// Terminal.app은 실행 파일(.command)을 열게 한다 — AppleScript로 시키면 자동화 권한 창이 뜬다.
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
export function openerFor(app, session, herdrBin = bin()) {
  return openerForArgv(app, [herdrBin, ...clientArgv(session)], session)
}
// 같은 방법으로 아무 명령이나 새 창에서 돌린다(herdr-core 터미널을 `hc attach`로 여는 데 쓴다). key는 스크립트 파일 이름.
export function openerForArgv(app, argv, key) {
  // Ghostty는 인자가 붙은 명령을 /bin/sh -c로 돌린다(Ghostty 문서의 command 항목). 공백·따옴표·셸 기호가 든 인자만
  // 따옴표로 감싸 인자 경계를 지킨다 — 평범한 인자는 예전과 글자 하나 다르지 않다.
  if (/^ghostty$/i.test(app)) return { file: '/usr/bin/open', args: ['-na', 'Ghostty', '--args', `--command=${argv.map((a) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(String(a)) ? a : shq(a))).join(' ')}`] }
  if (/^terminal$/i.test(app)) {
    const script = join(STATE_DIR, `open-${key}.command`)   // 상태 폴더 안: 다른 whosup 인스턴스와 겹치지 않는다
    return { file: '/usr/bin/open', args: ['-a', 'Terminal', script], script, body: `#!/bin/sh\nexec ${argv.map(shq).join(' ')}\n` }
  }
  return null
}
// 붙은 창이 없을 때 새 창을 열 앱: 고른 앱 > 지금 다른 herdr 세션을 보여 주는 앱 > 기본 터미널. 여는 방법을 모르는 감지 앱이면 기본 터미널.
// fallback: 자동 감지가 고른 앱(설치된 앱). 지금 떠 있는 앱보다 뒤, 기본 터미널보다 앞이다.
export function appToOpen(configured, psText, fallback = '') {
  if (configured) return configured
  const seen = terminalHostsFor(psText, null, '').map((h) => h.app).find((a) => openerFor(a, 'x', 'herdr'))
  return seen || (fallback && openerFor(fallback, 'x', 'herdr') ? fallback : DEFAULT_TERMINAL)
}
// 설정 화면에 보여 줄 값: 지금 herdr를 보여 주고 있는 앱(없으면 null)과 기본 터미널.
export async function detectTerminal() {
  if (isWindows()) return { supported: true, platform: 'win32', front_app: null, default_app: WIN_DEFAULT_LABEL, choices: WIN_CHOICES }
  if (platform() !== 'darwin') return { supported: false, platform: platform(), front_app: null, default_app: null }
  let text = ''
  try { text = await psText() || await psText(true) } catch {}
  return { supported: true, platform: 'darwin', front_app: terminalHostsFor(text, null, '')[0]?.app ?? null, default_app: DEFAULT_TERMINAL }
}

// ── 윈도우의 창 올리기 설정 ── 설정·FRONT_APP 값은 윈도우에서 명령줄에 들어가지 않고 두 가지만 정한다: 켬/끔, 새 창을 무엇으로 열지.
// 기본값은 켬(값이 비어 있으면 PowerShell 창). 이유: macOS는 아무것도 설정하지 않아도 세션을 누르면 터미널이 올라온다. 윈도우만
// 숨은 환경변수로 켜야 하던 것(REPORT 3번)을 같은 기본으로 맞추고, 끄고 싶으면 설정의 '끔'(값 off)으로 끈다.
// 바탕화면 세션이 아닌 곳(SSH·서비스, 세션 0)에서는 창이 보이지 않으니 doctor가 경고한다.
// 선택지 [이름, 저장할 값]. ''은 '자동'(자동 감지가 고른 터미널, 없으면 PowerShell) — 화면은 이 이름을 '자동'으로 바꿔 보여 준다.
// PowerShell은 빈 값이 아니라 'PowerShell'로 저장한다: 빈 값이면 '자동'과 같아져, 자동 값이 Windows Terminal일 때
// PowerShell을 골라도 다시 Windows Terminal로 돌아갔다(2회차 LOOP 회차 1 후보). winTerminal('PowerShell')은 'powershell'이다.
export const WIN_DEFAULT_LABEL = 'PowerShell'
export const WIN_CHOICES = [['auto', ''], ['PowerShell', 'PowerShell'], ['Windows Terminal', 'Windows Terminal'], ['off', 'off']]
export function winTerminal(conf) {
  const v = String(conf ?? '').trim()
  if (/^(off|none|no|0|false|disabled?|끔)$/i.test(v)) return null
  if (/windows\s*terminal|(^|[\\/\s])wt(\.exe)?$/i.test(v)) return 'wt'
  if (/pwsh/i.test(v)) return 'pwsh'
  return 'powershell'
}
// 새 창에서 herdr 클라이언트를 붙이는 PowerShell 명령. 실행 파일 경로는 작은따옴표 문자열로 감싼다 — 경로에 ' 가 있으면 '' 로
// 겹쳐 깨지지 않게 한다(REPORT 18번: "& '$bin'"은 ' 가 든 경로에서 깨졌다).
// herdr 세션 이름도 작은따옴표로 감싼다(codex 리뷰 M5-T4: 이름에 ; 등이 들면 PowerShell 명령이 덧붙을 수 있었다).
export const winAttachCommand = (herdrBin, session) => ['&', psQuote(herdrBin), ...clientArgv(session).map(psQuote)].join(' ')
// 아무 명령이나(argv, 덧붙일 환경변수) 새 창에서 돌리는 PowerShell 명령. 환경변수는 $env:로 그 창 안에서 넣는다 —
// Windows Terminal의 새 탭은 부르는 쪽의 환경을 물려받는다는 보장이 없어서다.
export const winRunCommand = (argv, env = {}) => [...Object.entries(env).map(([k, v]) => `$env:${k}=${psQuote(v)}`), ['&', ...argv.map(psQuote)].join(' ')].join('; ')
// 새 콘솔 창을 여는 실행 방법. wt.exe는 명령줄의 ; 를 탭 구분으로 읽으므로 \; 로 바꿔 넘긴다.
export function winOpener(term, command) {
  if (term === 'wt') return { file: 'wt.exe', args: ['powershell.exe', '-NoProfile', '-Command', command.replace(/;/g, '\\;')] }
  return { file: term === 'pwsh' ? 'pwsh.exe' : 'powershell.exe', args: ['-NoProfile', '-Command', command] }
}

// One AppleScript (System Events, needs Accessibility) does pick + un-minimize + raise + frontmost in a single
// osascript run (~0.1s warm). Before 2026-11-08 this was ps + 3 synchronous osascript calls (~0.7–1s) that blocked
// the server's event loop, so a second click waited for the first. Pick = first instance with a non-minimized window,
// else the newest client's. activate alone does not un-minimize a window (2026-11-08 실측).
// 주의(2026-11-08 실측): process 참조를 변수에 담으면 System Events가 이름("ghostty")으로 되풀어 첫 Ghostty 프로세스를
// 올린다. herdr-up은 main·side를 Ghostty 프로세스 둘로 띄우므로 side를 눌러도 main(또는 창 없는 인스턴스)이 올라왔다.
// 그래서 pid 숫자만 들고 다니고, 쓸 때마다 "first process whose unix id is <pid>"로 다시 찾는다.
const ACTIVATE_PID_JS = `ObjC.import('AppKit')
function run(argv) {
  const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(Number(argv[0]))
  if (!app || app.isNil()) return 'none'
  app.activateWithOptions($.NSApplicationActivateAllWindows)
  return 'ok'
}`
const RAISE_AS = `on run argv
  tell application "System Events"
    set targetPid to 0
    repeat with p in argv
      set n to (p as integer)
      try
        if targetPid is 0 then set targetPid to n
        if (count of (windows of (first process whose unix id is n) whose value of attribute "AXMinimized" is false)) > 0 then
          set targetPid to n
          exit repeat
        end if
      end try
    end repeat
    if targetPid is 0 then return "none"
    tell (first process whose unix id is targetPid)
      repeat with w in windows
        try
          if value of attribute "AXMinimized" of w then set value of attribute "AXMinimized" of w to false
        end try
      end repeat
      try
        perform action "AXRaise" of window 1
      end try
      set frontmost to true
      return (unix id) as text
    end tell
  end tell
end run`
// 화면 나눠 쓰기: argv = 보드 앱 pid, 터미널 pid, 보드 폭 %, 화면들("fx,fy,fw,fh,vx,vy,vw,vh" 공백 구분).
// 보드 앱 창 중 제목에 whosup이 든 창을 그 화면 왼쪽에, 터미널의 가장 큰 창을 나머지에 놓는다. 전체 화면 창은 두고 본다.
const LAYOUT_AS = `on splitNums(t)
  set AppleScript's text item delimiters to ","
  set r to {}
  repeat with x in text items of t
    set end of r to (x as integer)
  end repeat
  set AppleScript's text item delimiters to ""
  return r
end splitNums
on run argv
  set bp to (item 1 of argv) as integer
  set tp to (item 2 of argv) as integer
  set pct to (item 3 of argv) as integer
  tell application "System Events"
    set bwin to missing value
    repeat with w in windows of (first process whose unix id is bp)
      if (name of w as text) contains "whosup" then
        set bwin to w
        exit repeat
      end if
    end repeat
    if bwin is missing value then return "noboard"
    set {px, py} to position of bwin
    set {pw, ph} to size of bwin
    set cx to px + pw / 2
    set cy to py + 10
    set area to missing value
    repeat with i from 4 to count of argv
      set n to my splitNums(item i of argv)
      if area is missing value then set area to items 5 thru 8 of n
      if cx >= (item 1 of n) and cx < (item 1 of n) + (item 3 of n) and cy >= (item 2 of n) and cy < (item 2 of n) + (item 4 of n) then
        set area to items 5 thru 8 of n
        exit repeat
      end if
    end repeat
    set twin to missing value
    set best to -1
    repeat with w in windows of (first process whose unix id is tp)
      set {ww, hh} to size of w
      if ww * hh > best then
        set best to ww * hh
        set twin to w
      end if
    end repeat
    if twin is missing value then return "noterm"
    try
      if value of attribute "AXFullScreen" of twin then return "fullscreen"
    end try
    try
      if value of attribute "AXMinimized" of twin then set value of attribute "AXMinimized" of twin to false
    end try
    set {ax, ay, aw, ah} to area
    set bw to (aw * pct / 100) as integer
    set position of bwin to {ax, ay}
    set size of bwin to {bw, ah}
    set {bw, bh2} to size of bwin   -- 브라우저 최소 폭(Safari ~575px)보다 좁게는 안 줄어든다: 실제 폭 옆에 붙인다
    set position of twin to {ax + bw, ay}
    set size of twin to {aw - bw, ah}
    return "split"
  end tell
end run`
// 시험이 맥 창 올리기의 바깥 손(상주 도우미, osascript·open·ps 실행, 기다림)을 대역으로 바꾼다 — 실제 osascript·System Events를
// 돌리지 않고 무엇을 불렀는지만 본다. ops = { helper: { send(line) }, run(file, args, opts), sleep(ms) }. 부를 때마다 경고·캐시를 비운다.
let macOps = {}
export const _setMacOps = (ops) => {
  macOps = ops || {}
  raiseWarn = null; owner.told = ''; owner.ps = undefined; psCache = { at: 0, text: '' }; raiseSeq++; raiseDone = Promise.resolve()
  askPending = 0; askGen++
}
const run = (file, args, opts) => (macOps.run ? macOps.run(file, args, opts) : spawnRun(file, args, opts))
const spawnRun = (file, args, { timeout = 8000, track = false, env } = {}) => new Promise((resolve, reject) => {
  const child = spawn(file, args, { stdio: ['ignore', 'pipe', 'pipe'], ...(env ? { env } : {}), windowsHide: true })
  let out = ''; let err = ''; let timedOut = false
  const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { err += d })
  child.on('error', (e) => { clearTimeout(timer); reject(e) })
  child.on('close', (code) => { clearTimeout(timer); code === 0 ? resolve(out.trim()) : reject(new Error(timedOut ? `timed out after ${timeout}ms (macOS automation permission prompt pending?)` : (err.trim() || `exit ${code}`))) })
  if (track) raising.child = child
})
// Only the latest click's raise matters: a new click kills the previous raise still in flight.
const raising = { child: null }
const openedAt = new Map()
const winOpenedAt = new Map()   // 윈도우 도우미가 새 창을 연 시각(터미널·herdr 세션별)
const OPEN_WAIT_MS = 20000

// Windows: 상주 도우미(WIN_HELPER_PS)가 그 세션의 herdr 클라이언트를 품은 콘솔 창을 찾아 올리고, 없으면 새 창을 연다.
// whosup이 사용자의 바탕화면 세션에서 돌아야 창이 보인다(Windows 실기기 실측: SSH로 띄운 프로세스는 세션 0이라 창이 안 보임 —
// scripts/doctor.mjs가 이것을 알려 준다). 예전 단발 스크립트 WIN_RAISE_PS는 쓰는 곳이 없어 없앴다(REPORT 16번).
const psEncoded = (script) => Buffer.from(script, 'utf16le').toString('base64')


// ── 상주 도우미: 창 올리기 전용 프로세스를 whosup와 함께 띄워 두고 클릭마다 한 줄만 보낸다 ──────────
// osascript·PowerShell을 클릭마다 새로 띄우던 시간(맥 60~100ms, 윈도우 1~1.5s)을 없앤다. whosup가 끝나면
// 표준입력이 닫히고 도우미도 스스로 끝난다(stopHelpers()로도 끈다).
const MAC_HELPER_JS = `ObjC.import('AppKit'); ObjC.import('Foundation'); ObjC.import('CoreGraphics')
// 한 세션을 보여 주는 터미널 인스턴스가 여럿이면 창이 가장 큰 것(최대화·전체 화면으로 쓰던 창)을 고른다.
// 창 목록·크기는 화면 기록·손쉬운 사용 권한 없이 읽힌다(창 제목만 빠짐). 2026-11-09 pro: 최대화한 창 대신 다른 창이 올라옴.
function pick(pids) {
  if (pids.length < 2) return pids[0]
  let best = pids[0], area = -1
  try {
    const wins = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || []
    for (const w of wins) {
      if (w.kCGWindowLayer !== 0 || !pids.includes(w.kCGWindowOwnerPID)) continue
      const a = (w.kCGWindowBounds?.Width || 0) * (w.kCGWindowBounds?.Height || 0)
      if (a > area) { area = a; best = w.kCGWindowOwnerPID }
    }
  } catch (e) {}
  return best
}
// ── 권한과 창 상태를 "묻지 않고" 읽는다(F4) ── 여기서는 macOS 권한 창이 뜨지 않는다(2026-11-14 맥북에어 실측).
// ax: 손쉬운 사용 — AXIsProcessTrusted(). ae: 자동화 — AEDeterminePermissionToAutomateTarget(System Events, 와일드카드,
// 와일드카드, 묻지 않기): 0 허용 / -1744 아직 안 물음 / -1743 거부 / 그 밖(-600 = System Events가 떠 있지 않음 등).
// 읽지 못한 값은 빈 문자열로 둔다 — 서버가 "모름"으로 보고 예전 동작(매번 정밀 올리기)으로 물러난다.
// 둘 다 있는 것을 한 번 봤으면 30초 동안은 다시 묻지 않는다(권한을 다 준 사람의 클릭을 늦추지 않게. 그사이 권한을
// 거둬도 정밀 올리기가 실패하면서 경고가 뜬다).
try { ObjC.import('ApplicationServices') } catch (e) {}
let aeBound = false, grantedAt = 0
function perms() {
  if (grantedAt && Date.now() - grantedAt < 30000) return ['1', '0']
  let ax = '', ae = ''
  try { ax = $.AXIsProcessTrusted() ? '1' : '0' } catch (e) {}
  try {
    if (!aeBound) { ObjC.bindFunction('AEDeterminePermissionToAutomateTarget', ['int', ['void *', 'unsigned int', 'unsigned int', 'bool']]); aeBound = true }
    const d = $.NSAppleEventDescriptor.descriptorWithBundleIdentifier('com.apple.systemevents')
    ae = String($.AEDeterminePermissionToAutomateTarget(d.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false))
  } catch (e) {}
  if (ax === '1' && ae === '0') grantedAt = Date.now()
  return [ax, ae]
}
// 그 프로세스에 "화면에 보이는 보통 크기 창"이 있는가: '1' | '0' | ''(못 읽음). 권한 없이 읽히는 창 목록에는 최소화 표시가
// 없고, 터미널 앱은 창이 보일 때도 숨은 창을 여럿 갖고 있다(맥북에어 실측: Terminal.app 260x251·500x500·1280x29 넷,
// 모두 화면 밖). 그래서 층 0·화면에 있음(kCGWindowIsOnscreen)·투명하지 않음으로 먼저 거르고, 크기로는 화면에 걸친 띠
// (제목 막대 높이 29)와 점 같은 창만 걸러 낸다: 폭 80·높이 40 이상. 제목 막대(28)에 글자 한 줄(13 이상)뿐인 가장 작은
// 터미널 창도 높이 41 이상, 글자 열 칸이면 폭 80 안팎이라 놓치지 않는다.
function visible(pid) {
  try {
    const wins = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0))) || []
    for (const w of wins) {
      if (w.kCGWindowOwnerPID !== pid || w.kCGWindowLayer !== 0 || !w.kCGWindowIsOnscreen || w.kCGWindowAlpha === 0) continue
      const b = w.kCGWindowBounds || {}
      if (b.Width >= 80 && b.Height >= 40) return '1'
    }
    return '0'
  } catch (e) { return '' }
}
// 그 앱이 몇 벌 떠 있는지(같은 묶음 id의 실행 중 앱 수)와 앱 묶음 경로. "다시 열기"는 한 벌일 때만 그 창에 간다.
function appInfo(app) {
  let inst = '', path = ''
  try { const bid = ObjC.unwrap(app.bundleIdentifier); if (bid) inst = String($.NSRunningApplication.runningApplicationsWithBundleIdentifier(bid).count) } catch (e) {}
  try { const p = ObjC.unwrap(app.bundleURL.path); if (p) path = encodeURIComponent(p) } catch (e) {}
  return [inst, path]
}
// macOS 권한 창이 말하는 주체: 이 프로세스(와 whosup 서버)의 "책임 프로세스"인 앱의 이름. 서버가 nohup 으로 떠서 부모가
// launchd 로 바뀌어도 macOS 는 처음 띄운 앱(터미널 앱)에 권한을 묻는다. 앱이 아니면(로그인 자동 실행 등) 빈 값.
let ownName
function ownerName() {
  if (ownName !== undefined) return ownName
  ownName = ''
  try {
    ObjC.bindFunction('responsibility_get_pid_responsible_for_pid', ['int', ['int']])
    const rp = $.responsibility_get_pid_responsible_for_pid($.NSProcessInfo.processInfo.processIdentifier)
    const a = rp > 0 ? $.NSRunningApplication.runningApplicationWithProcessIdentifier(rp) : null
    if (a && !a.isNil()) ownName = encodeURIComponent(ObjC.unwrap(a.localizedName) || '')
  } catch (e) {}
  return ownName
}
// 응답 끝에 붙는 상태: |ax=1;ae=0[;vis=1;inst=1;app=<경로>][;own=<앱 이름>]. 권한이 다 있으면 창 목록은 읽지 않는다(쓰지 않는다).
function stateOf(pid, app) {
  const p = perms()
  let s = '|ax=' + p[0] + ';ae=' + p[1]
  if (!(p[0] === '1' && p[1] === '0')) { const i = appInfo(app); s += ';vis=' + visible(pid) + ';inst=' + i[0] + ';app=' + i[1] }
  const o = ownerName()
  if (o) s += ';own=' + o
  return s
}
// ── 화면 나눠 쓰기 ── 누르기 직전 맨 앞 앱 pid와 화면 목록(AX 좌표: 전체 틀 + 메뉴 막대·Dock을 뺀 영역)을 돌려준다.
// 창 옮기기는 AppleScript(LAYOUT_AS)가 한다 — JXA의 System Events 창 크기 읽기가 Ghostty에서 실패했다(macOS 실측).
function screensAX() {
  const scr = ObjC.unwrap($.NSScreen.screens), mainH = $.NSScreen.screens.objectAtIndex(0).frame.size.height
  return scr.map((sc) => { const f = sc.frame, v = sc.visibleFrame
    return [f.origin.x, mainH - (f.origin.y + f.size.height), f.size.width, f.size.height, v.origin.x, mainH - (v.origin.y + v.size.height), v.size.width, v.size.height].map(Math.round).join(',') }).join(' ')
}
function run() {
  const inH = $.NSFileHandle.fileHandleWithStandardInput, outH = $.NSFileHandle.fileHandleWithStandardOutput
  const say = (t) => outH.writeData($(t + '\\n').dataUsingEncoding($.NSUTF8StringEncoding))
  say('ready')
  let buf = ''
  while (true) {
    const d = inH.availableData
    if (d.length === 0) break
    buf += $.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js
    let i
    while ((i = buf.indexOf('\\n')) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
      let out = 'none', extra = ''
      try {
        if (line.charAt(0) === '?') {
          // "?<pid>": 올리지 않고 상태만 다시 읽는다(다시 열기 뒤 창이 화면에 나왔는지 볼 때).
          const pid = Number(line.slice(1))
          const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
          if (app && !app.isNil()) out = 'st:' + pid + stateOf(pid, app)
        } else {
          const [list, pct] = line.split(';')
          if (Number(pct) > 0) { try { extra = ':' + $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier + ':' + screensAX() } catch (e) {} }
          const pid = pick(list.split(',').map(Number).filter((n) => n > 0))
          const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
          if (app && !app.isNil()) {
            app.activateWithOptions($.NSApplicationActivateAllWindows); out = 'ok:' + pid + extra
            try { out += stateOf(pid, app) } catch (e) {}
          }
        }
      } catch (e) { out = 'err' }
      say(out)
    }
  }
}`
const WIN_HELPER_PS = `$ErrorActionPreference = 'Stop'
$bin = $env:WHOSUP_HERDR_BIN
Add-Type @"
using System; using System.Text; using System.Threading; using System.Runtime.InteropServices;
public static class WhosupWin {
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mi; }
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] i, int size);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr p);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool alt);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, IntPtr l, uint f, uint t, out IntPtr r);
  [DllImport("kernel32.dll")] public static extern bool FreeConsole();
  [DllImport("kernel32.dll")] public static extern bool AttachConsole(uint pid);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  static bool Fg(IntPtr h) { Thread.Sleep(15); return GetForegroundWindow() == h; }
  // 그 프로세스가 붙은 콘솔의 창에서 실제 터미널 창을 찾는다. conhost면 그 창이고, Windows Terminal(ConPTY)이면 의사 창의 소유자가
  // WT 창이다(WT ConptyReparentPseudoConsole). 부모 프로세스로는 WT에 닿지 않는다 — WT는 COM(-Embedding)으로 따로 뜬다(Windows 실기기 실측).
  public static IntPtr TerminalOf(uint pid) {
    FreeConsole();
    if (!AttachConsole(pid)) return IntPtr.Zero;
    IntPtr h = GetConsoleWindow(); FreeConsole();
    if (h == IntPtr.Zero) return h;
    IntPtr o = GetAncestor(h, 3); if (o == IntPtr.Zero) o = h;   // GA_ROOTOWNER
    var c = new StringBuilder(64); GetClassName(o, c, 64);
    return c.ToString() == "PseudoConsoleWindow" ? IntPtr.Zero : o;
  }
  // 백그라운드 프로세스의 전경 올리기: 숨김·최소화를 먼저 풀고(WT 트레이 최소화는 SW_HIDE), 빈 마우스 입력으로 '마지막 입력'
  // 조건을 만든 뒤 SetForegroundWindow를 부른다(komorebi·GlazeWM 방식). 안 되면 AHK식으로 AttachThreadInput 재시도. ALT 누름은 Edge 메뉴를 건드려서 뺐다.
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MONINFO { public int cb; public RECT mon, work; public uint flags; }
  [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool GetMonitorInfo(IntPtr m, ref MONINFO i);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int hh, bool r);
  [DllImport("user32.dll")] public static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  // 화면 나눠 쓰기: 누르기 직전 맨 앞 창이 보드(제목에 whosup)면 그 화면의 작업 영역 왼쪽 pct%에 보드, 나머지에 터미널.
  public static IntPtr BoardWindow() {
    IntPtr fg = GetForegroundWindow(); var t = new StringBuilder(512); GetWindowText(fg, t, 512);
    return t.ToString().IndexOf("whosup", StringComparison.OrdinalIgnoreCase) >= 0 ? fg : IntPtr.Zero;
  }
  public static void Layout(IntPtr board, IntPtr term, int pct) {
    var mi = new MONINFO(); mi.cb = Marshal.SizeOf(typeof(MONINFO));
    if (!GetMonitorInfo(MonitorFromWindow(board, 2), ref mi)) return;
    int x = mi.work.L, y = mi.work.T, w = mi.work.R - mi.work.L, h = mi.work.B - mi.work.T, bw = w * pct / 100;
    if (IsZoomed(board) || IsIconic(board)) ShowWindow(board, 9);
    if (IsZoomed(term) || IsIconic(term)) ShowWindow(term, 9);
    MoveWindow(board, x, y, bw, h, true); RECT br; GetWindowRect(board, out br); int bx = Math.Max(x + bw, br.R) - 7;   // 브라우저 최소 폭 때문에 덜 줄면 실제 오른쪽 끝 옆에(투명 테두리 7px 보정)
    MoveWindow(term, bx, y, x + w - bx, h, true);
  }
  // 같은 세션을 보여 주는 창이 여럿이면 최대화한 창(최소화해 둔 최대화 창 포함), 아니면 평소 크기가 가장 큰 창을 고른다(맥 pick과 같은 규칙).
  [StructLayout(LayoutKind.Sequential)] public struct WPL { public int len, flags, show; public int mx, my, Mx, My; public RECT normal; }
  [DllImport("user32.dll")] public static extern bool GetWindowPlacement(IntPtr h, ref WPL p);
  public static long Score(IntPtr h) {
    var p = new WPL(); p.len = Marshal.SizeOf(typeof(WPL));
    if (!GetWindowPlacement(h, ref p)) return 0;
    if (IsZoomed(h) || (IsIconic(h) && (p.flags & 2) != 0)) return long.MaxValue / 2;
    return (long)(p.normal.R - p.normal.L) * (p.normal.B - p.normal.T);
  }
  public static bool Raise(IntPtr h) {
    if (!IsWindowVisible(h)) ShowWindow(h, 5);
    if (IsIconic(h)) ShowWindow(h, 9);
    if (GetForegroundWindow() == h) return true;
    var inp = new INPUT[1]; SendInput(1, inp, Marshal.SizeOf(typeof(INPUT)));
    SetForegroundWindow(h); if (Fg(h)) return true;
    IntPtr fw = GetForegroundWindow(); IntPtr r;
    uint fg = GetWindowThreadProcessId(fw, IntPtr.Zero), me = GetCurrentThreadId(), tg = GetWindowThreadProcessId(h, IntPtr.Zero);
    bool alive = fw == IntPtr.Zero || SendMessageTimeout(fw, 0, IntPtr.Zero, IntPtr.Zero, 2, 500, out r) != IntPtr.Zero;
    bool a1 = alive && fg != 0 && fg != me && AttachThreadInput(me, fg, true);
    bool a2 = alive && fg != 0 && fg != tg && AttachThreadInput(fg, tg, true);
    for (int i = 0; i < 5 && GetForegroundWindow() != h; i++) {
      if (i == 1) keybd_event(0x12, 0, 2, UIntPtr.Zero);   // ALT 떼기만(AHK)
      BringWindowToTop(h); SetForegroundWindow(h); Thread.Sleep(15);
    }
    if (a2) AttachThreadInput(fg, tg, false);
    if (a1) AttachThreadInput(me, fg, false);
    if (GetForegroundWindow() != h) SwitchToThisWindow(h, true);
    return Fg(h);
  }
}
"@
$win = @{}   # 세션 → 창 핸들. 창이 살아 있으면 프로세스 트리를 다시 뒤지지 않는다(CIM 조회 ~300ms 절약).
[Console]::Out.WriteLine('ready'); [Console]::Out.Flush()
function Lay($h) { if ($split -gt 0 -and $board -ne [IntPtr]::Zero -and $board -ne $h) { [WhosupWin]::Layout($board, $h, $split); [void][WhosupWin]::Raise($h) } }
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $res = 'fail:none'
  # 한 줄 = 세션|나눠쓰기%|새창금지(1=방금 열었음)|터미널(powershell·pwsh·wt)|새 창 명령  또는  !app|앱이름|나눠쓰기%
  if ($line.StartsWith('!app|')) {
    $null, $name, $split = $line.Split('|', 3); $split = [int]$split; $board = if ($split -gt 0) { [WhosupWin]::BoardWindow() } else { [IntPtr]::Zero }
    $res = 'fail:none'
    try {
      # 가정(실기기 미확인): 데스크톱 앱의 프로세스 이름이 앱 이름(HERDR_APP_NAME, 기본 Herdr)과 같다. 콘솔 창(herdr CLI)은 건너뛴다.
      foreach ($gp in (Get-Process -Name $name -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero })) {
        $c = New-Object System.Text.StringBuilder 64; [void][WhosupWin]::GetClassName($gp.MainWindowHandle, $c, 64)
        if ($c.ToString() -in @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS')) { continue }
        $okfg = [WhosupWin]::Raise($gp.MainWindowHandle); Lay $gp.MainWindowHandle
        $res = if ($okfg) { "raised:app:$($gp.Id)" } else { "fail:foreground-locked:app:$($gp.Id)" }; break
      }
    } catch { $res = 'fail:' + $_.Exception.Message }
    [Console]::Out.WriteLine($res); [Console]::Out.Flush(); continue
  }
  $ses, $split, $noopen, $term, $cmd = $line.Split('|', 5); $split = [int]$split
  $board = if ($split -gt 0) { [WhosupWin]::BoardWindow() } else { [IntPtr]::Zero }
  try {
    # 캐시는 창이 하나뿐일 때만, 그리고 그 창의 herdr 클라이언트가 살아 있을 때만 쓴다 — 클라이언트가 끝나 빈 PowerShell 창만 남은 경우를
    # 올리던 결함(Windows 실기기 QA). 여러 창이면 매번 고른다(최대화·가장 큰 창이 바뀔 수 있다).
    if ($win.ContainsKey($ses) -and [WhosupWin]::IsWindow($win[$ses].h) -and (Get-Process -Id $win[$ses].pid -ErrorAction SilentlyContinue)) {
      $okfg = [WhosupWin]::Raise($win[$ses].h); Lay $win[$ses].h
      [Console]::Out.WriteLine($(if ($okfg) { 'raised:cached' } else { 'fail:foreground-locked:cached' })); [Console]::Out.Flush(); continue
    }
    $want = if ($ses -eq 'default') { '' } else { "--session $ses" }
    $clients = Get-CimInstance Win32_Process -Filter "Name='herdr.exe'" -Property ProcessId,ParentProcessId,CommandLine | Where-Object { $_.CommandLine -and (($_.CommandLine -replace '^\\s*"?[^"]*herdr(\\.exe)?"?\\s*','').Trim() -eq $want) } | Sort-Object ProcessId -Descending
    $done = $false; $best = $null; $bestScore = -1; $seen = @{}
    foreach ($c in $clients) {
      $h = [WhosupWin]::TerminalOf([uint32]$c.ProcessId)
      if ($h -ne [IntPtr]::Zero -and -not $seen.ContainsKey($h.ToInt64())) { $seen[$h.ToInt64()] = $true; $sc = [WhosupWin]::Score($h); if ($sc -gt $bestScore) { $bestScore = $sc; $best = @{ h = $h; pid = [int]$c.ProcessId } } }
    }
    $win.Remove($ses)
    if ($best) {
      if ($seen.Count -eq 1) { $win[$ses] = $best }
      $okfg = [WhosupWin]::Raise($best.h); Lay $best.h
      $res = if ($okfg) { "raised:console:$($best.pid)" } else { "fail:foreground-locked:console:$($best.pid)" }; $done = $true
    }
    foreach ($c in $clients) {
      if ($done) { break }
      $ppid = [int]$c.ParentProcessId; $hops = 0
      while ($ppid -gt 0 -and $hops -lt 10 -and -not $done) {
        $gp = Get-Process -Id $ppid -ErrorAction SilentlyContinue
        if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
          $h = $gp.MainWindowHandle
          $win[$ses] = @{ h = $h; pid = [int]$c.ProcessId }
          $okfg = [WhosupWin]::Raise($h); Lay $h
          $res = if ($okfg) { "raised:$($gp.Id)" } else { "fail:foreground-locked:$($gp.Id)" }; $done = $true
        } else {
          $pp = Get-CimInstance Win32_Process -Filter "ProcessId=$ppid" -Property ParentProcessId -ErrorAction SilentlyContinue
          $ppid = if ($pp) { [int]$pp.ParentProcessId } else { 0 }; $hops++
        }
      }
      if ($done) { break }
    }
    if (-not $done -and $noopen -eq '1') { $res = 'opened:waiting' }   # 방금(20초 안에) 연 창이 아직 뜨는 중: 또 열지 않는다(REPORT 7번)
    elseif (-not $done) {
      if (-not $cmd) { $cmd = "& '" + ($bin -replace "'", "''") + "' $want" }
      # -NoExit 없이: herdr 클라이언트가 끝나면(데스크 끄기) 창도 닫힌다
      if ($term -eq 'wt') { Start-Process -FilePath 'wt.exe' -ArgumentList @('powershell.exe', '-NoProfile', '-Command', ($cmd -replace ';', '\\;')) | Out-Null }
      else { Start-Process -FilePath $(if ($term -eq 'pwsh') { 'pwsh.exe' } else { 'powershell.exe' }) -ArgumentList @('-NoProfile', '-Command', $cmd) | Out-Null }
      $res = 'opened'
    }
  } catch { $res = 'fail:' + $_.Exception.Message }
  [Console]::Out.WriteLine($res); [Console]::Out.Flush()
}`
class Helper {
  // ordered(맥 도우미만 켠다): 도우미는 받은 줄마다 차례대로 한 줄씩 답한다. 시간 초과된 요청의 자리를 줄에서 빼 버리면 늦게 온 그
  // 응답이 다음 요청에게 간다 — 다른 터미널의 창 상태·권한 값으로 판정하게 된다(Codex 리뷰 2). 그래서 자리를 빼지 않고 "버리는
  // 자리"로 남겨, 늦은 응답은 제자리에서 버린다. 이번 요청을 기다리는 동안 그런 늦은 응답이 실제로 왔고 그 뒤에 선 탓에 제 응답을
  // 못 받았으면 'timeout' 대신 'late' 로 답한다(부르는 쪽이 한 번 더 물어본 뒤 판단한다). 꺼져 있으면(윈도우 도우미) 예전 그대로다.
  constructor(name, file, args, env, { ordered = false } = {}) { Object.assign(this, { name, file, args, env, ordered, child: null, ready: null, waiters: [], buf: '', late: 0 }) }
  start() {
    if (this.child) return this.ready
    const child = spawn(this.file, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env ? { ...process.env, ...this.env } : process.env })
    this.child = child
    this.ready = new Promise((resolve) => { this.waiters.push(resolve) })
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (d) => {
      this.buf += d
      let i
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim(); this.buf = this.buf.slice(i + 1)
        const w = this.waiters.shift(); if (w) w(line)
      }
    })
    child.stderr.on('data', (d) => { if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: ${this.name} helper: ${String(d).slice(0, 200)}`) })
    const reset = () => { if (this.child === child) { this.child = null; this.ready = null; for (const w of this.waiters.splice(0)) w('dead') } }
    child.on('exit', reset); child.on('error', reset)
    return this.ready
  }
  async send(line, timeout = 3000) {
    await this.start()
    if (!this.child) return 'dead'
    return new Promise((resolve) => {
      const lateAtSend = this.late
      const t = setTimeout(() => {
        const k = this.waiters.indexOf(done)
        if (k >= 0 && this.ordered) this.waiters[k] = (v) => { if (v !== 'dead') this.late++ }   // 버리는 자리: 늦게 오는 이 요청의 응답을 받아 버린다
        else if (k >= 0) this.waiters.splice(k, 1)
        resolve(this.ordered && this.late !== lateAtSend ? 'late' : 'timeout')
      }, timeout)
      const done = (v) => { clearTimeout(t); resolve(v) }
      this.waiters.push(done)
      this.child.stdin.write(`${line}\n`)
    })
  }
  stop() { try { this.child?.stdin.end(); this.child?.kill() } catch {} this.child = null }
}
const macHelper = new Helper('mac', '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_HELPER_JS], undefined, { ordered: true })
export const _macHelperSource = () => MAC_HELPER_JS   // 시험: 도우미 글을 대역 환경에서 돌려 본다(osascript 없이)
// 시험: 상주 도우미의 줄 맞추기(Helper)를 가짜 도우미 프로세스로 돌려 본다. opts.ordered = 맥 도우미 방식, 없으면 윈도우 도우미 방식.
export const _helperFor = (file, args, opts) => new Helper('test', file, args, undefined, opts)
let winHelper = null
// 시험이 가짜 도우미를 넣는다(실제 PowerShell을 띄우지 않고 보내는 줄만 본다).
export const _setWinHelper = (h) => { winHelper = h }
const winHelperFor = () => (winHelper ||= new Helper('win', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(WIN_HELPER_PS)], { WHOSUP_HERDR_BIN: bin() }))
// whosup 시작 때 도우미를 미리 띄운다. 맥은 항상(터미널 앱을 자동으로 찾는다), 윈도우는 창 올리기가 켜져 있을 때(기본 켬). 끝날 때 stopHelpers().
export function startHelpers() {
  if (platform() === 'darwin') macHelper.start()
  else if (isWindows() && winTerminal(effectiveApp())) winHelperFor().start()
}
export function stopHelpers() { macHelper.stop(); winHelper?.stop() }

// 창 올리기에 필요한 OS 권한이 빠졌으면 그 종류, 아니면 null. 켜는 곳이 달라서 둘을 한데 묶지 않는다(F5):
//   'mac_accessibility' = 손쉬운 사용 권한이 없다(-25211) / 'mac_automation' = 자동화(System Events) 권한을 거부했다(-1743).
// 다음 정밀 올리기가 성공하거나, 상주 도우미가 그 권한이 생겼다고 알려 주면 지운다. 바뀌면 듣는 쪽(보드 서버)에 알린다 —
// 정밀 올리기는 클릭 응답 뒤에 끝나므로, 보드가 다음 주기를 기다리지 않고 경고를 그리게.
let raiseWarn = null
export const raiseWarning = () => raiseWarn
const warnListeners = new Set()
export function onRaiseWarning(fn) { warnListeners.add(fn); return () => warnListeners.delete(fn) }
function setWarn(kind) {
  if (raiseWarn === kind) return
  raiseWarn = kind
  for (const fn of warnListeners) { try { fn(kind) } catch {} }
}
export function raiseErrorKind(message) {
  const s = String(message ?? '')
  if (/-1743|not authorized to send Apple events|Apple 이벤트를 보낼 권한/i.test(s)) return 'mac_automation'
  if (/-25211|-1719|보조 접근|assistive access/i.test(s)) return 'mac_accessibility'
  return null
}
// 권한 대상 앱 이름(F6): macOS 권한 창이 말하는 주체, 곧 이 서버를 띄운 앱. 경고가 없으면 null. 이름은 코드에 박지 않고 찾는다:
//   ① 상주 도우미가 macOS 에 물어 알려 준 책임 앱의 이름(서버가 nohup 으로 떠 부모가 launchd 로 바뀐 뒤에도 맞다)
//   ② 서버 프로세스의 조상 가운데 앱 묶음에서 실행된 첫 프로세스의 앱 이름(프로세스 목록)
//   ③ 조상에 앱이 없으면(로그인 자동 실행 등) 서버 실행 파일의 이름.
const owner = { told: '', ps: undefined }
const psRows = (text) => String(text).split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd }))
export function ownerAppOf(psText, pid) {
  const byPid = new Map(psRows(psText).map((r) => [r.pid, r]))
  for (let cur = byPid.get(pid), hops = 0; cur && hops < 16; cur = byPid.get(cur.ppid), hops++) {
    const name = APP_OF.exec(cur.cmd)?.[1]
    if (name) return name
  }
  return ''
}
export function raiseWarningApp() {
  if (!raiseWarn) return null
  if (owner.ps === undefined && psCache.text) owner.ps = ownerAppOf(psCache.text, process.pid)
  return owner.told || owner.ps || basename(process.execPath).replace(/\.exe$/i, '')
}

// ── 권한은 필요할 때만(F4) ── 상주 도우미의 응답은 예전 모양 "ok:<pid>[:<맨 앞 앱 pid>:<화면들>]" 뒤에 "|키=값;…"이 붙는다.
// 뒤쪽이 없거나(옛 응답) 권한 값을 못 읽었으면 state 는 null — 부르는 쪽이 예전 동작으로 물러난다.
export const AE_NOT_ASKED = -1744
export const AE_DENIED = -1743
const decoded = (s) => { try { return decodeURIComponent(s || '') } catch { return '' } }
export function parseHelperReply(got) {
  const s = String(got ?? '')
  const bar = s.indexOf('|')
  const m = /^ok:(\d+)(?::(\d+):(.*))?$/.exec(bar < 0 ? s : s.slice(0, bar)) || []
  const kv = {}
  if (bar >= 0) for (const part of s.slice(bar + 1).split(';')) { const i = part.indexOf('='); if (i > 0) kv[part.slice(0, i)] = part.slice(i + 1) }
  const flag = (v) => (v === '1' ? true : v === '0' ? false : null)
  const ax = flag(kv.ax)
  const ae = /^-?\d+$/.test(kv.ae ?? '') ? Number(kv.ae) : null
  const state = ax === null || ae === null ? null
    : { ax, ae, vis: flag(kv.vis), inst: /^\d+$/.test(kv.inst ?? '') ? Number(kv.inst) : null, app: decoded(kv.app) }
  return { m, state, own: decoded(kv.own) }
}
// 이번 클릭에서 System Events 정밀 올리기를 어떻게 할지: 'precise'(지금 부른다 — 예전 동작) | 'skip'(부르지 않는다) |
// 'reopen'(권한이 필요 없는 다시 열기를 먼저 해 보고, 그래도 창이 없을 때만 부른다).
//  - 화면 나눠 쓰기를 켰거나(그 기능이 권한을 쓴다), 도우미가 권한 값을 못 돌려줬으면: 예전 동작.
//  - 권한을 다 가진 사람(손쉬운 사용 있음 + 자동화 허용): 예전 동작 그대로. 손쉬운 사용이 있고 자동화가 "아직 안 물음·거부"가
//    아닌 다른 값(System Events 가 떠 있지 않아 알 수 없음, -600)일 때도 여기다 — System Events 는 쓰지 않으면 스스로 꺼지므로,
//    권한을 다 준 사람도 이 값을 자주 본다. 이들의 동작을 바꾸지 않는다(거부한 사람이면 권한 창 없이 경고만 뜬다).
//  - 그 밖(권한이 없는 사람): 화면에 보이는 보통 크기 창이 있으면 부르지 않고, 없으면 다시 열기부터. 창이 보이는지 못 읽었으면 예전 동작.
// 알려진 한계(검토 R2·R3, 맥북에어 실측 대기): "보이는 창"은 그 앱 프로세스 단위다 — 권한 없이 읽는 창 목록으로는 어느 창이 그
// 세션의 창인지도, 최소화됐는지도 알 수 없다(실측 p3 #1). 같은 프로세스의 다른 창이 보이면 최소화한 세션 창은 펼쳐지지 않는다.
// 다시 열기가 최소화한 창을 펼친다는 것도 한 앱(macOS 기본 터미널)에서만 실측했다.
export function raisePlan(state, split = 0) {
  if (split > 0 || !state) return 'precise'
  if (state.ax && state.ae !== AE_NOT_ASKED && state.ae !== AE_DENIED) return 'precise'
  if (state.vis === null) return 'precise'
  return state.vis ? 'skip' : 'reopen'
}
// 다시 열기 뒤 창이 화면에 나오기를 기다리며 창 목록을 다시 읽는 간격(ms, 모두 더해 1.25초). 최소화 펼치기·데스크톱 전환
// 애니메이션이 끝나기 전에 "창이 없다"고 단정해 권한 창을 띄우지 않게 한다. 클릭 응답은 이것을 기다리지 않는다.
export const REOPEN_WAITS = [250, 400, 600]
let raiseSeq = 0
let raiseDone = Promise.resolve()
export const _raiseSettled = () => raiseDone   // 시험: 응답 뒤에 이어지는 일(다시 열기·정밀 올리기)이 끝나기를 기다린다

// ── 권한 창을 오래 읽은 사람의 답(F5) ── 정밀 올리기는 4초에 끊는다(더 새 클릭이 와도 끊는다). 사람이 macOS 자동화 권한 창을
// 그보다 오래 읽고 "허용 안 함"을 누르면 그 답(-1743)은 이미 끝난 osascript 로 오지 않아, 거부했는데도 보드가 조용했다.
// 그래서 자동화를 아직 고르지 않은 사람에게 정밀 올리기를 부르면(= 이 서버가 권한 창을 띄웠을 수 있다) 답을 기다리는 중으로 적어
// 두고(askPending), 정밀 올리기가 답 없이 끝났으면 상주 도우미로 묻지 않고 읽는다: 잠깐씩 다시 읽고(모두 더해 30초), 그사이에도
// 답이 없었으면 다음 클릭의 도우미 응답에서 본다. 허용(0)이면 그만 보고, 거부(-1743)면 4초 안에 거부했을 때와 똑같이
// 'mac_automation' 경고를 올린다. 그 밖의 값(아직 안 고름 -1744, System Events 가 떠 있지 않음 -600 등)은 아직 모르는 것으로 두고
// 계속 본다. 이 서버가 띄운 창이 아닌 옛 거부는 여기서 올리지 않는다(창이 안 보여 권한이 필요해진 순간에 올린다 — reopenThenRaise).
// 권한 값을 못 읽는 도우미(옛 응답)와 이미 허용한 사람은 적지도 읽지도 않는다.
// askPending 은 클릭 순번에 묶는다(Codex 리뷰 1·2): 0 = 기다리지 않음, 아니면 권한 창을 띄웠을 수 있는 정밀 올리기를 부른 클릭의
// 순번(raiseSeq). 기다림을 끝내는 것은 둘뿐이다 — 도우미가 방금 읽어 준 값(noteAsk), 그리고 가장 새 클릭의 정밀 올리기가 들은 답.
// 더 새 클릭에 밀린 앞 클릭의 늦은 완료는 이 표시를 지우지 않는다(지우면 더 새 클릭이 띄운 권한 창의 거부를 놓친다). 그 기다림이
// 제 것이거나 더 앞 클릭의 것이면 도우미로 지금 값을 읽게 넘기고, 더 새 클릭의 것이면 그 클릭에 맡긴다(raisePids 의 behind).
export const ASK_WAITS = [1000, 2000, 4000, 8000, 15000]
let askPending = 0
let askGen = 0
const mayAsk = (state) => Boolean(state) && state.ae !== 0 && state.ae !== AE_DENIED
function noteAsk(state) {
  if (!askPending || !state) return
  if (state.ae === 0) askPending = 0
  else if (state.ae === AE_DENIED) { askPending = 0; setWarn('mac_automation') }
}
async function watchAsk(helper, pid) {
  const gen = ++askGen   // 더 새로 끝난 정밀 올리기가 있으면 그쪽이 본다
  const seq = askPending   // 이 기다림만 본다: 더 새 클릭이 권한 창을 다시 띄웠으면(순번이 바뀜) 그 클릭이 끝나면서 이어 본다
  const watching = () => askPending === seq && gen === askGen
  const pause = macOps.sleep || ((ms) => new Promise((r) => { setTimeout(r, ms).unref?.() }))   // 보드가 끝나는 것을 붙들지 않는다
  for (const ms of ASK_WAITS) {
    await pause(ms)
    if (!watching()) return
    const state = parseHelperReply(await ask(helper, `?${pid}`, 2000, watching)).state
    if (!watching()) return
    noteAsk(state)
    if (!askPending) return
  }
}

// 상주 도우미에 한 줄을 보내고 "그 줄의 답"만 돌려준다(Codex 리뷰 2). 답 머리의 pid 가 이번에 물은 것이 아니면(ok:<pid> 는 보낸
// 후보 가운데 하나여야 하고, st:<pid> 는 물은 바로 그 pid 여야 한다) 앞서 시간 초과된 다른 요청의 늦은 답이다 — 그 값으로 판정하면
// 다른 터미널의 창 상태로 권한 창을 띄우거나 경고를 놓친다. 그런 답과, 늦은 답 뒤에 서느라 제 답을 못 받은 경우('late' — Helper)는
// 버리고 한 번 더 묻는다: 곧바로 "모름"으로 두면 권한이 없는 사람에게 예전 동작(정밀 올리기 = 권한 창)이 나가기 때문이다. 같은 줄을
// 다시 보내도 해가 없다(올리기는 같은 앱을 한 번 더 올릴 뿐이고 "?"는 읽기만 한다) — 다만 그사이 더 새 클릭이 왔으면(live 가 거짓)
// 다시 보내지 않는다: 늦게 처리된 올리기 줄이 더 새 클릭의 창 위로 올라온다. 다시 물어도 제 답이 아니면 'stale' — 부르는 쪽은
// 도우미가 답하지 못한 때와 똑같이 "모름"으로 본다. 답이 그냥 없던 것('timeout'·'dead')과 pid 가 없는 답('none'·'err')은 그대로 돌려준다.
async function ask(helper, line, timeout, live = () => true) {
  const query = line.charAt(0) === '?'
  const asked = (query ? line.slice(1) : line.split(';')[0]).split(',').map(Number)
  for (let again = false; ; again = true) {
    const got = await helper.send(line, timeout)
    const head = /^(ok|st):(\d+)/.exec(String(got))
    if (head ? head[1] === (query ? 'st' : 'ok') && asked.includes(Number(head[2])) : got !== 'late') return got
    if (again || !live()) return 'stale'
  }
}

// ps 결과를 잠깐(5초) 재사용한다 — 클릭마다 ps(약 90ms)를 기다리지 않게. 비었거나 실패하면 새로 읽는다.
let psCache = { at: 0, text: '' }
async function psText(fresh = false) {
  if (!fresh && Date.now() - psCache.at < 5000) { run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).then((t) => { psCache = { at: Date.now(), text: t } }).catch(() => {}); return psCache.text }
  const t = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  psCache = { at: Date.now(), text: t }
  return t
}

// 누르기 직전 준비(보드 화면이 마우스 움직임·창 복귀 때 부른다): herdr 세션 표와 프로세스 목록을 미리 읽어 둔다.
// 그래야 클릭이 ps(약 90ms)·herdr 실행을 기다리지 않고 바로 herdr pane 이동·창 올리기로 간다.
export function warmClick() {
  sessionTableAsync().catch(() => {})
  if (platform() === 'darwin' && Date.now() - psCache.at > 2000) psText(true).catch(() => {})
}

// 고른 프로세스(같은 앱의 인스턴스들) 중 창이 가장 큰 것을 앞으로 올린다. 최소화돼 있으면 펼치고, split > 0이면 보드와 나란히 놓는다.
async function raisePids(pids, app, split, label) {
  try { raising.child?.kill() } catch {}
  // 먼저 그 인스턴스를 pid로 바로 앞으로(권한 불필요, 즉시). System Events 정밀 올리기(최소화 해제)는 그 뒤에 —
  // 권한이 없으면 4초 시간 초과를 기다리던 탓에 창이 4초 늦게 올라왔다(2026-11-08 pro QA).
  // 도우미가 여러 인스턴스 중 창이 가장 큰 것을 골라 앞으로 올리고 그 pid를 돌려준다. 정밀 올리기도 그 pid부터.
  const mine = ++raiseSeq
  const helper = macOps.helper || macHelper
  const latest = () => mine === raiseSeq
  const got = await ask(helper, `${pids.join(',')};${split || 0}`, 3000, latest)
  const { m, state, own } = parseHelperReply(got)
  if (own) owner.told = own
  const chosen = Number(m[1]) || pids[0]
  // 마지막 클릭만 이긴다(Codex 리뷰 1): 이 클릭이 도우미의 답을 기다리는 사이에 더 새 클릭이 왔으면 여기서 물러난다. 이어서 하면
  // 더 새 클릭이 올린 창 위로 이 클릭의 창을 다시 올리고(정밀 올리기·앱 단위 올리기·화면 나눠 쓰기), 그 클릭이 올린 경고를 지우거나 덮는다.
  if (!latest()) { if (got === 'none') psText(true).catch(() => {}); return }
  noteAsk(state)   // 앞선 클릭에서 뜬 권한 창의 답을 그 뒤에 골랐으면 여기서 안다(창이 보여 아무것도 부르지 않는 클릭이어도)
  // 더 새 클릭에 밀린 뒤에 끝난 정밀 올리기(그 클릭이 끊었거나, 끝나 보니 더 새 클릭이 있다): 경고·앱 올리기는 더 새 클릭의 몫이라
  // 아무것도 바꾸지 않는다. 이 서버가 띄운 권한 창의 답을 아직 기다리는 중이면 그 답만 도우미로 읽게 넘긴다 — 끝난 호출이 들은 옛 값이
  // 아니라 지금 값으로 판단한다(권한 창은 떠 있을 수 있다).
  const behind = () => (askPending && askPending <= mine ? watchAsk(helper, chosen).catch(() => {}) : undefined)
  // 화면 나눠 쓰기: 누르기 직전 맨 앞 앱(보드 브라우저)과 이 터미널을 나란히 놓는다.
  if (split > 0 && m[2] && Number(m[2]) !== chosen) {
    run('/usr/bin/osascript', ['-e', LAYOUT_AS, m[2], String(chosen), String(split), ...m[3].split(' ')], { timeout: 4000 })
      .then((r) => { if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: split ${r}`) })
      .catch((err) => console.error(`whosup: split layout failed: ${String(err.message || err).slice(0, 200)}`))
  }
  if (got === 'none') psText(true).catch(() => {})   // 그 창이 닫혔으면 다음 클릭을 위해 목록을 새로 읽는다
  else if (!String(got).startsWith('ok')) run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACTIVATE_PID_JS, String(chosen)], { timeout: 3000 }).catch(() => {})
  // System Events 정밀 올리기(최소화 해제·그 창 올리기). 권한이 없는 사람에게는 이 호출이 macOS 권한 창을 띄운다.
  // 고른 인스턴스만 넘긴다 — 여러 개를 넘기면 RAISE_AS가 '최소화 안 된 첫 창'을 골라 최소화한 큰 창을 건너뛴다.
  const precise = () => {
    if (mayAsk(state)) askPending = mine   // 자동화를 아직 고르지 않은 사람: 이 호출이 권한 창을 띄운다 — 답을 기다린다(위 watchAsk)
    return run('/usr/bin/osascript', ['-e', RAISE_AS, String(chosen)], { track: true, timeout: 4000 })
      .then((got) => {
        if (!latest()) return behind()
        askPending = 0; setWarn(null); if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: raise ${label} want=${pids.join(',')} got=${got}`)
      })
      .catch((err) => {
        // 더 새 클릭이 이 호출을 끊었거나, 끝나 보니 더 새 클릭이 있다: 권한 창은 떠 있을 수 있으니 답만 계속 기다린다.
        if (/SIGTERM|exit null/.test(String(err.message)) || !latest()) return behind()
        // 손쉬운 사용 권한이 없으면 최소화된 창을 펼칠 수 없다(macOS 실측 -25211). 자동화 권한을 거부했으면 System Events 에
        // 아무것도 시킬 수 없다(-1743). 켜는 곳이 다르므로 종류를 갈라 보드에 올린다.
        const kind = raiseErrorKind(err.message)
        if (kind) { askPending = 0; setWarn(kind) }   // 답을 들었다(거부, 또는 자동화는 허용했고 손쉬운 사용이 없다)
        console.error(`whosup: terminal raise failed (${kind === 'mac_automation' ? 'Automation denied' : 'Accessibility?'}): ${String(err.message || err).slice(0, 200)}`)
        // 손쉬운 사용 권한이 없어도 앱 단위 activate는 된다(2026-11-08 pro 실측) — 최소한 그 터미널 앱은 앞으로.
        run('/usr/bin/osascript', ['-e', `tell application "${app.replace(/"/g, '')}" to activate`], { timeout: 3000 }).catch(() => {})
        // 답 없이 끝났다(시간 초과 등): 권한 창이 아직 떠 있을 수 있다 — 사람이 그 뒤에 고른 답을 도우미로 읽는다.
        if (askPending) return watchAsk(helper, chosen).catch(() => {})
      })
  }
  // F4: 권한을 다 가진 사람·화면 나눠 쓰기·권한 값을 모를 때는 예전처럼 매번 부른다. 권한이 없는 사람은 필요해진 순간에만.
  const plan = raisePlan(state, split)
  if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: raise ${label} helper=${String(got).slice(0, 300)} plan=${plan}`)
  if (plan === 'precise') { raiseDone = precise(); return }
  // 도우미가 그 권한이 생겼다고 알려 주면 경고를 지운다(정밀 올리기를 부르지 않는 길이라 성공으로 지워질 일이 없다).
  if ((raiseWarn === 'mac_automation' && state.ae === 0) || (raiseWarn === 'mac_accessibility' && state.ax)) setWarn(null)
  if (plan === 'skip') { raiseDone = Promise.resolve(); return }   // 창이 화면에 보인다: pid 로 앞으로 올린 것으로 끝났다
  raiseDone = reopenThenRaise(mine, helper, chosen, state, precise, pids.filter((p) => p !== chosen)).catch(() => {})
}
// 화면에 보이는 창이 없다(최소화·숨김). 권한이 필요 없는 "다시 열기"(앱을 한 번 더 여는 것 — 맥북에어 실측: 최소화한 창이 펼쳐진다)를
// 먼저 해 보고 창 목록을 다시 읽는다. 그 앱이 한 벌만 떠 있을 때만 한다 — 여러 벌이면 어느 벌에 갈지 모른다.
// 그래도 보이는 창이 없을 때가 권한이 "필요해진 순간"이다: 정밀 올리기를 부른다(권한 창이 뜨는 것이 맞다). 자동화를 이미
// 거부했으면(-1743) 불러도 실패할 뿐 다시 묻지도 않으므로, 부르지 않고 경고만 올린다.
// 그 세션을 보여 주는 벌이 여럿이면(others) 그보다 먼저 다른 벌을 본다(Codex 리뷰 3): 도우미는 창이 가장 큰 벌을 고르는데, 그 벌의
// 창은 숨어 있고 다른 벌의 창은 화면에 보일 수 있다. 그때는 보이는 벌을 pid 로 앞으로 올리는 것으로 끝낸다 — 그 세션이 이미 화면에
// 있으니 권한이 필요해진 순간이 아니다(다시 열기도, System Events 도, 경고도 없다). 여기는 권한이 없는 사람만 오는 길이다:
// 권한을 다 가진 사람은 예전 그대로 가장 큰 창의 벌을 정밀 올리기로 펼친다(raisePlan 이 'precise').
async function reopenThenRaise(mine, helper, pid, first, precise, others = []) {
  const pause = macOps.sleep || sleep
  const live = () => mine === raiseSeq
  for (const other of others) {
    const seen = parseHelperReply(await ask(helper, `?${other}`, 2000, live)).state
    if (!live()) return
    if (!seen?.vis) continue
    const up = await ask(helper, `${other};0`, 3000, live)
    if (!live() || String(up).startsWith('ok')) return
  }
  let st = first
  if (first.inst === 1 && /^\/.+\.app$/.test(first.app)) {
    try { await run('/usr/bin/open', ['-a', first.app], { timeout: 3000 }) } catch {}
    for (const ms of REOPEN_WAITS) {
      await pause(ms)
      if (mine !== raiseSeq) return   // 더 새 클릭이 있다
      const again = parseHelperReply(await ask(helper, `?${pid}`, 2000, live)).state
      if (!again) continue
      st = again
      if (again.vis) return
    }
  }
  if (mine !== raiseSeq) return
  if (st.ae === AE_DENIED) { setWarn('mac_automation'); return }
  await precise()
}
// 새 창 띄우기. 창이 막 열리는 중이면 또 열지 않는다 — 클릭마다 인스턴스가 쌓였다(2026-11-08 pro QA). 터미널 앱이 처음 뜰 때는
// 창이 나오기까지 10초를 넘기기도 해서(2026-11-10 실측: Ghostty 첫 실행 16초 이상) 20초 동안 기다린다.
// 앱별로 따로 센다 — 방금 다른 앱으로 창을 열었더라도, 설정에서 앱을 바꾼 뒤의 클릭은 새 앱으로 연다.
function launch(app, what, how) {
  if (!how) return false
  const key = `${app}\n${what}`
  if (Date.now() - (openedAt.get(key) || 0) < OPEN_WAIT_MS) return true
  openedAt.set(key, Date.now())
  if (how.script) { mkdirSync(dirname(how.script), { recursive: true }); writeFileSync(how.script, how.body); chmodSync(how.script, 0o755) }
  const opener = spawn(how.file, how.args, { detached: true, stdio: 'ignore' })
  opener.once('error', (err) => console.error(`whosup: could not open a terminal window: ${String(err.message || err).slice(0, 200)}`))
  opener.unref()
  return true
}
// 다른 런타임(herdr-core)이 쓰는 두 가지: 이름으로 앱을 앞으로 올리기, 터미널 창을 새로 열어 명령 돌리기. macOS 밖에서는 'off'.
const APP_PIDS = (psText, appName) => psText.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  .filter(([, , , cmd]) => (APP_OF.exec(cmd)?.[1] || '').toLowerCase() === String(appName).toLowerCase()).map(([, pid]) => Number(pid))
// launch:false = 그 앱이 떠 있지 않으면 켜지 않고 'none'을 돌려준다(기본은 예전처럼 앱을 켠다 — macOS).
// 그때 앱을 찾거나 올리다가 오류가 났으면 'none'이 아니라 'failed'다: 떠 있는지 모르는 것을 "꺼져 있다"고 답하지 않는다.
export async function raiseApp(appName, split = 0, { launch = true } = {}) {
  const safe = String(appName).replace(/[^A-Za-z0-9 ._-]/g, '')
  if (isWindows()) {
    if (!winTerminal(effectiveApp()) || !safe) return 'off'
    winHelperFor().send(`!app|${safe}|${split || 0}`, 8000).then((got) => { if (!/^raised/.test(got)) console.error(`whosup: windows app raise: ${String(got).slice(0, 200)}`) })
    return 'raised'
  }
  if (platform() !== 'darwin' || isOffApp(effectiveApp())) return 'off'
  let failed = false
  try {
    let pids = APP_PIDS(await psText(), safe)
    if (!pids.length) pids = APP_PIDS(await psText(true), safe)
    if (pids.length) { await raisePids(pids, safe, split, safe); return 'raised' }
  } catch (err) { failed = true; console.error(`whosup: app raise failed: ${String(err.message || err).slice(0, 200)}`) }
  if (!launch) return failed ? 'failed' : 'none'
  run('/usr/bin/osascript', ['-e', `tell application "${safe}" to activate`]).catch(() => {})
  return 'app'
}
// 그 이름의 앱이 지금 떠 있는가: true | false. 프로세스 목록에서 앱을 가려낼 길이 없는 곳(macOS 밖)에서는 null(모름).
// 꺼져 있는 앱을 "올리기"가 켜 버리지 않게, 올리기 전에 먼저 묻는다(herdr-core 런타임의 앱 창 올리기).
export async function appRunning(appName) {
  const safe = String(appName).replace(/[^A-Za-z0-9 ._-]/g, '')
  if (platform() !== 'darwin' || !safe) return null
  try { return APP_PIDS(await psText(true), safe).length > 0 } catch { return null }
}
// env: 새 창에 넣을 환경변수. macOS는 argv 앞에 /usr/bin/env K=V로, 윈도우는 PowerShell $env:로 넣는다.
export async function openWindowRunning(argv, key, env = {}) {
  if (isWindows()) {
    const term = winTerminal(effectiveApp())
    if (!term) return 'off'
    return launch(term, key, winOpener(term, winRunCommand(argv, env))) ? 'opened' : 'off'
  }
  if (platform() !== 'darwin' || isOffApp(effectiveApp())) return 'off'
  if (Object.keys(env).length) argv = ['/usr/bin/env', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...argv]
  let text = ''
  try { text = await psText() } catch {}
  const app = appToOpen(configuredApp(), text, appAuto)
  return launch(app, key, openerForArgv(app, argv, key)) ? 'opened' : 'off'
}
// Returns 'raised' (raise started in the background) | 'opened' | 'app' | 'off'. Never blocks the event loop;
// the window comes up ~0.1–0.3s after the response.
export async function activateTerminal(session, split = 0) {
  const conf = configuredApp()
  if (isWindows()) {
    const term = winTerminal(effectiveApp())
    if (!term) return 'off'
    // 도우미 한 줄은 | 로 가르고 세션 이름이 PowerShell 명령에 들어간다 — herdr 세션 이름 규칙에 맞지 않으면 창을 건드리지 않는다.
    if (!validSessionName(session)) return 'off'
    // 새 창 중복 방지(macOS launch()와 같은 20초): 방금 새 창을 열었으면 도우미에 '열지는 말고 찾으면 올려라'로 보낸다.
    // 찾아서 올렸다는 답이 오면 표시를 지운다(창이 이미 있었으니 다음에 없어지면 바로 열어도 된다).
    const key = `${term}\n${session}`
    const noOpen = Date.now() - (winOpenedAt.get(key) || 0) < OPEN_WAIT_MS
    if (!noOpen) winOpenedAt.set(key, Date.now())
    // 상주 도우미에 한 줄. 응답은 기다리지 않는다(도우미가 결과를 돌려주면 로그만).
    winHelperFor().send([session, split || 0, noOpen ? 1 : 0, term, winAttachCommand(bin(), session)].join('|'), 8000).then((got) => {
      if (!noOpen && /^raised/.test(got) && winOpenedAt.get(key)) winOpenedAt.delete(key)
      if (!/^(raised|opened)/.test(got)) console.error(`whosup: windows terminal raise: ${String(got).slice(0, 200)}`)
    })
    return 'raised'
  }
  if (platform() !== 'darwin' || isOffApp(effectiveApp())) return 'off'
  let app = conf
  try {
    let text = await psText()
    let hosts = terminalHostsFor(text, session, conf)
    if (!hosts.length) { text = await psText(true); hosts = terminalHostsFor(text, session, conf) }   // 창을 방금 연 경우 등: 새로 읽고 판단
    const pids = hosts.map((h) => h.pid)
    if (pids.length) {
      app = conf || hosts[0].app
      await raisePids(pids, app, split, session)
      return 'raised'
    }
    // No window shows this herdr session: open one attached to it (the herdr session keeps running either way).
    app = appToOpen(conf, text, appAuto)
    if (launch(app, session, openerFor(app, session))) return 'opened'
  } catch (err) { console.error(`whosup: terminal raise failed: ${String(err.message || err).slice(0, 200)}`) }
  if (!app) return 'off'
  run('/usr/bin/osascript', ['-e', `tell application "${app.replace(/"/g, '')}" to activate`]).catch(() => {})
  return 'app'
}

export const agentCommand = () => process.env.AGENT_CMD || 'claude'

// Jump to a herdr pane (any tab, any herdr session). If `run` is given, run it in that pane (e.g. resume).
// 연타 때는 마지막 클릭만 이긴다: 앞선 요청이 늦게 끝나도 뒤 요청의 세션을 덮어쓰지 않는다
// (Windows 실기기 QA: 2→6→3 연타가 응답 끝난 순서대로 적용돼 6에 머묾).
let focusSeq = 0
let latestClick = 0
let focusChain = Promise.resolve()
export function focus(ref, opts = {}) {
  // 화면이 클릭 순번(seq)을 보내면 그것으로 최신을 가린다 — SSH 터널 등에서 요청 도착 순서가 바뀌어도
  // 마지막 클릭이 이긴다(2026-11-08 pro QA: 도착 순서 기준이라 9회 중 3회 역전).
  if (Number.isFinite(opts.seq) && opts.seq > latestClick) latestClick = opts.seq
  const mine = ++focusSeq
  // 한 번에 하나씩 차례로 처리하고, 차례가 왔을 때 더 새 클릭이 있으면 건너뛴다.
  const job = focusChain.then(() => focusNow(ref, opts, mine))
  focusChain = job.catch(() => {})
  return job
}
async function focusNow(ref, opts = {}, mine) {
  const { cwd = homedir(), run = null, seq } = opts
  const { session, pane } = splitRef(ref)
  // superseded(): 보드 서버가 본 판 전체의 순번(다른 런타임의 세션을 더 나중에 눌렀을 때). herdr 런타임의 세션만 있으면 위 판정과 같다.
  const stale = (Number.isFinite(seq) ? seq < latestClick : mine !== focusSeq) || opts.superseded?.() === true
  if (stale && !run) return { session, pane, client: 'running', window: 'superseded' }
  let client = await ensureServer(session, cwd)
  // 창 올리기는 herdr pane 이동과 상관없으니 같이 시작한다(ps·osascript 기동 시간을 herdr pane 이동 뒤로 미루지 않게).
  // raise:false = 이 클릭을 한 브라우저는 서버 화면 앞에 있지 않다(원격 노트북 등) — herdr pane만 옮기고 서버 화면의 창은 건드리지 않는다.
  const windowP = opts.raise === false ? Promise.resolve('skipped') : activateTerminal(session, opts.split)
  for (let i = 0; ; i++) {
    try { await apiCall(session, 'pane.focus', { pane_id: pane }); break } catch (err) {
      // 최근 표로는 켜져 있었는데 소켓이 없다: 그사이 꺼진 herdr 세션이다. 표를 새로 읽고(필요하면 띄우고) 한 번 다시 한다.
      if (client === 'running' && i === 0 && /ENOENT|ECONNREFUSED|session not found/.test(`${err.code || ''} ${err.message}`)) { forgetSessionTable(); client = await ensureServer(session, cwd); continue }
      if (client !== 'started' || i >= 12) throw err
      await sleep(250)
    }
  }
  if (run) herdr(['pane', 'run', pane, run], session)
  const window = await windowP
  return { session, pane, client, window }
}

// 보드에서 끄기: 세션 하나를 닫거나(그 세션의 에이전트도 끝남) herdr 세션 서버를 통째로 끈다(붙은 터미널 창도 함께 닫힘).
export function closePane(ref) {
  const { session, pane } = splitRef(ref)
  herdr(['pane', 'close', pane], session)
  return { session, pane }
}
export const STOP_WAIT_STEPS = 80   // × 100ms
export async function stopSession(session) {
  if (!runningSessions().includes(session)) return { session, already: true }   // 이미 꺼진 데스크: 오류 대신 그대로 성공
  herdr(['server', 'stop'], session)
  // server stop은 서버가 다 내려가기 전에 돌아온다 — 꺼진 것이 확인될 때까지 기다려야 바로 수집에 반영된다.
  // 에이전트가 많은 데스크는 3초를 넘긴다(실측 3.17초) — 최대 8초, 먼저 꺼지면 바로 돌아온다.
  for (let i = 0; i < STOP_WAIT_STEPS && runningSessions().includes(session); i++) await sleep(100)
  return { session }
}
// herdr 세션 이름: 영숫자와 . _ - 만. '--help' 같은 옵션 문자열이 herdr 인자·터미널 명령줄로 들어가지 않게 맨 앞의 - 는 막는다.
export const validSessionName = (s) => typeof s === 'string' && /^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(s)
const checkSessionName = (s) => { if (!validSessionName(s)) throw Object.assign(new Error(`invalid herdr session name: ${String(s).slice(0, 60)}`), { code: 'bad_session' }) }
// 꺼진 herdr 세션 다시 켜기: 서버를 띄우고 그 herdr 세션을 보여 주는 창을 연다.
export async function startSession(session, cwd = homedir(), { raise = true } = {}) {
  checkSessionName(session)
  const client = await ensureServer(session, cwd)
  const window = raise === false ? 'skipped' : await activateTerminal(session)
  return { session, client, window }
}

// 새 탭의 셸이 입력을 받을 준비가 될 때까지 기다린다(가-12 B3-1: 에이전트 명령이 두 번 찍힘). 탭을 만들자마자 명령을 보내면
// 셸이 뜨기 전이라 터미널이 그 글자를 먼저 한 번 그대로 찍고(미리 친 글자), 셸이 뜬 뒤 프롬프트 옆에 한 번 더 그린다 — 실행은
// 한 번인데 두 번 친 것처럼 보인다. 그 세션 화면을 읽어 무엇인가 그려졌고(프롬프트) 두 번 이어 같은 내용이면 준비된 것으로 본다.
// 고정 시간 기다리기가 아니다: 빠른 셸은 곧바로 지나가고 느린 셸은 그만큼 기다린다. 화면을 읽지 못하거나 한도(2초)를 넘기면
// 예전처럼 그냥 보낸다(그때는 예전과 같이 두 번 찍힐 수 있다).
export const SHELL_WAIT = { stepMs: 80, maxMs: 2000 }
async function shellReady(session, pane) {
  const until = Date.now() + SHELL_WAIT.maxMs
  for (let prev = ''; Date.now() < until; await sleep(SHELL_WAIT.stepMs)) {
    let text
    // 화면 읽기 한 번은 1.5초까지만 기다린다(herdr 가 답하지 않아도 새 세션 열기가 오래 붙들리지 않게).
    try { text = await spawnRun(...herdrCommand(['pane', 'read', pane, '--source', 'detection', '--lines', '20'], session), { timeout: 1500 }) } catch { return false }
    if (text && text === prev) return true
    prev = text
  }
  return false
}

// New tab in a herdr session with the agent started, then jump there.
export async function newSession({ session, cwd, command = agentCommand(), raise = true }) {
  checkSessionName(session)
  if (!cwd || !existsSync(cwd)) throw cwdMissing(cwd)
  const client = await ensureServer(session, cwd)
  const created = herdrJson(['tab', 'create', '--cwd', cwd, '--label', basename(cwd) || cwd, '--focus'], session)
  const pane = created?.root_pane?.pane_id
  if (!pane) throw new Error('herdr did not return the new pane id')
  await shellReady(session, pane)
  herdr(['pane', 'run', pane, command], session)
  await apiCall(session, 'pane.focus', { pane_id: pane })
  const window = raise === false ? 'skipped' : await activateTerminal(session)
  return { session, pane, client, window }
}
