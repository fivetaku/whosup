// herdr runtime: every pane of every running session, with agent status where herdr detects one.
// Nothing here assumes a terminal app, a session name, or an agent wrapper.
import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import { existsSync } from 'node:fs'
import { basename } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'herdr'
export const FIELDS = ['lastStatus', 'requiresAttention', 'attentionReason', 'lastUserMessageAt', 'title']
export const TRACKS_GONE = true
// 윈도우 herdr는 끝난 칸을 '답변 도착(done)' 없이 바로 '유휴(idle)'로 알린다 → 수집기가 답변 도착으로 해석한다(collector inferDone).
export const IDLE_AFTER_WORK_IS_DONE = process.platform === 'win32'
export const TEST_SESSION_PREFIX = 'whosuptest-'

const BIN_CANDIDATES = ['/opt/homebrew/bin/herdr', '/usr/local/bin/herdr', `${process.env.HOME}/.local/bin/herdr`]
// herdr 실행 파일 찾기는 여기 한 곳(I-4). 칸 화면 읽기(context.mjs)·데스크 스크립트(desks.mjs)도 이것을 쓴다.
// 환경변수가 없을 때의 후보 탐색(--version)은 프로세스당 한 번만 한다.
let probed
const probe = () => BIN_CANDIDATES.find((p) => { try { execFileSync(p, ['--version'], { stdio: 'ignore', timeout: 3000, killSignal: 'SIGKILL' }); return true } catch { return false } }) || 'herdr'
export const bin = () => process.env.HERDR_BIN_PATH || process.env.HERDR_BIN || (probed ??= probe())

function herdr(args, session) {
  const full = session ? ['--session', session, ...args] : args
  return execFileSync(bin(), full, { encoding: 'utf8', timeout: 15000, killSignal: 'SIGKILL' })
}
const herdrJson = (args, session) => JSON.parse(herdr(args, session)).result

// herdr session list: name status directory socket
export function sessionTable() {
  return herdr(['session', 'list']).split('\n').slice(1)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 4 && !cols[0].startsWith(TEST_SESSION_PREFIX))
    .map(([name, status, dir, socket]) => ({ name, status, dir, socket }))
}
export const runningSessions = () => sessionTable().filter((s) => s.status === 'running').map((s) => s.name)

export const normalizeStatus = (s) => (['working', 'done', 'blocked', 'idle'].includes(s) ? s : 'unknown')

// One record per pane. Agent info (kind, session id, status) is layered on when herdr reports it;
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

// 한 번의 조회 결과. unreachable = 목록에는 있지만 이번에 칸을 읽지 못한 herdr 세션 이름(멈춘 세션 포함).
// 그 세션의 칸은 "사라짐"이 아니라 "확인 불가"로 다뤄야 한다(약속 1·5).
export function listSnapshot() {
  const out = []
  const unreachable = []
  const stopped = []
  for (const row of sessionTable()) {
    // 서버를 끈 세션: 칸은 남기되 "꺼짐"으로 — 조회 실패(확인 불가)와 구분한다.
    if (row.status !== 'running') { stopped.push(row.name); continue }
    let panes = []
    let agents = []
    try { panes = herdrJson(['pane', 'list'], row.name).panes || [] } catch { unreachable.push(row.name); continue }
    try { agents = herdrJson(['agent', 'list'], row.name).agents || [] } catch { agents = null }
    // agent list만 실패하면 칸은 보이지만 에이전트 상태를 모른다 — 빈 칸(shell)으로 강등하지 않고 확인 불가로 둔다.
    if (agents === null) { unreachable.push(row.name); continue }
    const byPane = new Map(agents.map((a) => [a.pane_id, a]))
    for (const pane of panes) out.push(toSession(row.name, pane, byPane.get(pane.pane_id)))
  }
  return { sessions: out, unreachable, stopped }
}

export function listSessions() {
  return listSnapshot().sessions
}

// Raw socket call for requests the CLI lacks (pane.focus).
export function apiCall(session, method, params, { timeoutMs = 5000 } = {}) {
  const row = sessionTable().find((s) => s.name === session)
  if (!row) return Promise.reject(new Error(`herdr session not found: ${session}`))
  return new Promise((resolve, reject) => {
    // Windows herdr listens on a named pipe \\.\pipe\<socket path>; the .sock file only holds pid:nonce (Windows 실기기 실측).
    const sock = createConnection(process.platform === 'win32' ? `\\\\.\\pipe\\${row.socket}` : row.socket)
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

async function ensureServer(session, dir) {
  if (runningSessions().includes(session)) return 'running'
  if (dir && !existsSync(dir)) throw cwdMissing(dir)
  // spawn 실패는 'error' 이벤트로 온다. 리스너가 없으면 상주 서버가 통째로 죽는다(#2).
  let spawnErr = null
  const child = spawn(bin(), ['--session', session, 'server'], { cwd: dir, detached: true, stdio: 'ignore' })
  child.once('error', (err) => { spawnErr = err })
  child.unref()
  for (let i = 0; i < 20 && !spawnErr && !runningSessions().includes(session); i++) await sleep(250)
  if (spawnErr) throw new Error(`could not start herdr session ${session}: ${spawnErr.message}`)
  if (!runningSessions().includes(session)) throw new Error(`could not start herdr session ${session}`)
  return 'started'
}

// Optional: FRONT_APP (e.g. Ghostty, iTerm2, Terminal) brings the terminal forward on macOS. Off by default.
// The terminal may run as several app instances (Ghostty `open -na`), so "activate the app" can raise the wrong
// window. Raise the instance whose process tree holds a herdr client attached to this session instead.
const clientArgv = (session) => (session === 'default' ? [] : ['--session', session])

// ps rows -> pids of terminal-app processes that host a client of `session`, newest client first.
export function terminalPidsFor(psText, session, app) {
  const rows = psText.split('\n').map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
    .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd }))
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const want = clientArgv(session).join(' ')
  const isClient = (cmd) => {
    const m = cmd.match(/^(?:-)?(?:\S*\/)?herdr(?:\s+(.*))?$/)
    return m && (m[1] || '').trim() === want
  }
  const appRe = new RegExp(`/${app.replace(/[^A-Za-z0-9 ._-]/g, '')}\\.app/Contents/MacOS/`, 'i')
  const out = []
  for (const r of rows.filter((x) => isClient(x.cmd)).sort((a, b) => b.pid - a.pid)) {
    for (let cur = byPid.get(r.ppid), hops = 0; cur && hops < 8; cur = byPid.get(cur.ppid), hops++) {
      if (appRe.test(cur.cmd)) { if (!out.includes(cur.pid)) out.push(cur.pid); break }
    }
  }
  return out
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
const run = (file, args, { timeout = 8000, track = false, env } = {}) => new Promise((resolve, reject) => {
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

// Windows: find the console window that hosts a herdr client of this session and bring it forward; if none, open
// a new PowerShell window attached to the session. whosup must run in the user's desktop session (not an SSH /
// session-0 service) for windows to appear (Windows 실기기 실측: SSH로 띄운 프로세스는 세션 0이라 창이 안 보임).
// Prints "raised:<pid>" | "opened" | "fail:<why>".
const WIN_RAISE_PS = `$ErrorActionPreference = 'Stop'
$ses = $env:WHOSUP_HERDR_SESSION; $bin = $env:WHOSUP_HERDR_BIN
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class WhosupWin {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$procs = Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine
$byId = @{}; foreach ($p in $procs) { $byId[[int]$p.ProcessId] = $p }
$want = if ($ses -eq 'default') { '' } else { "--session $ses" }
$clients = $procs | Where-Object { $_.Name -ieq 'herdr.exe' -and $_.CommandLine -and (($_.CommandLine -replace '^\\s*"?[^"]*herdr(\\.exe)?"?\\s*','').Trim() -eq $want) } | Sort-Object ProcessId -Descending
foreach ($c in $clients) {
  $cur = $byId[[int]$c.ParentProcessId]; $hops = 0
  while ($cur -and $hops -lt 10) {
    $gp = Get-Process -Id ([int]$cur.ProcessId) -ErrorAction SilentlyContinue
    if ($gp -and $gp.MainWindowHandle -ne [IntPtr]::Zero) {
      $h = $gp.MainWindowHandle
      if ([WhosupWin]::IsIconic($h)) { [void][WhosupWin]::ShowWindow($h, 9) }
      [WhosupWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [WhosupWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      [void][WhosupWin]::SetForegroundWindow($h)
      "raised:$($gp.Id)"; exit 0
    }
    $cur = $byId[[int]$cur.ParentProcessId]; $hops++
  }
}
$args2 = @('-NoProfile', '-Command', "& '$bin' $want")
Start-Process -FilePath 'powershell.exe' -ArgumentList $args2 | Out-Null
'opened'`
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
        const [list, pct] = line.split(';')
        if (Number(pct) > 0) { try { extra = ':' + $.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier + ':' + screensAX() } catch (e) {} }
        const pid = pick(list.split(',').map(Number).filter((n) => n > 0))
        const app = $.NSRunningApplication.runningApplicationWithProcessIdentifier(pid)
        if (app && !app.isNil()) { app.activateWithOptions($.NSApplicationActivateAllWindows); out = 'ok:' + pid + extra }
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
  $ses, $split = $line.Split('|'); $split = [int]$split
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
    if (-not $done) {
      Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile', '-Command', "& '$bin' $want") | Out-Null   # -NoExit 없이: herdr 클라이언트가 끝나면(데스크 끄기) 창도 닫힌다
      $res = 'opened'
    }
  } catch { $res = 'fail:' + $_.Exception.Message }
  [Console]::Out.WriteLine($res); [Console]::Out.Flush()
}`
class Helper {
  constructor(name, file, args, env) { Object.assign(this, { name, file, args, env, child: null, ready: null, waiters: [], buf: '' }) }
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
      const t = setTimeout(() => { const k = this.waiters.indexOf(done); if (k >= 0) this.waiters.splice(k, 1); resolve('timeout') }, timeout)
      const done = (v) => { clearTimeout(t); resolve(v) }
      this.waiters.push(done)
      this.child.stdin.write(`${line}\n`)
    })
  }
  stop() { try { this.child?.stdin.end(); this.child?.kill() } catch {} this.child = null }
}
const macHelper = new Helper('mac', '/usr/bin/osascript', ['-l', 'JavaScript', '-e', MAC_HELPER_JS])
let winHelper = null
const winHelperFor = () => (winHelper ||= new Helper('win', 'powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', psEncoded(WIN_HELPER_PS)], { WHOSUP_HERDR_BIN: bin() }))
// whosup 시작 때 도우미를 미리 띄운다(FRONT_APP이 있을 때만). 끝날 때 stopHelpers().
export function startHelpers() {
  if (!process.env.FRONT_APP) return
  if (process.platform === 'darwin') macHelper.start()
  else if (process.platform === 'win32') winHelperFor().start()
}
export function stopHelpers() { macHelper.stop(); winHelper?.stop() }

// ps 결과를 잠깐(5초) 재사용한다 — 클릭마다 ps(약 90ms)를 기다리지 않게. 비었거나 실패하면 새로 읽는다.
let raiseWarn = null
// 창 올리기에 필요한 OS 권한이 빠졌으면 그 이유 코드('mac_accessibility'), 아니면 null.
export const raiseWarning = () => raiseWarn
let psCache = { at: 0, text: '' }
async function psText(fresh = false) {
  if (!fresh && Date.now() - psCache.at < 5000) { run('/bin/ps', ['-axo', 'pid=,ppid=,command=']).then((t) => { psCache = { at: Date.now(), text: t } }).catch(() => {}); return psCache.text }
  const t = await run('/bin/ps', ['-axo', 'pid=,ppid=,command='])
  psCache = { at: Date.now(), text: t }
  return t
}

// Returns 'raised' (raise started in the background) | 'opened' | 'app' | 'off'. Never blocks the event loop;
// the window comes up ~0.1–0.3s after the response.
export async function activateTerminal(session, split = 0) {
  const app = process.env.FRONT_APP
  if (!app) return 'off'
  if (process.platform === 'win32') {
    // 상주 도우미에 세션 이름 한 줄. 응답은 기다리지 않는다(도우미가 결과를 돌려주면 로그만).
    winHelperFor().send(`${session}|${split || 0}`, 8000).then((got) => { if (!/^(raised|opened)/.test(got)) console.error(`whosup: windows terminal raise: ${String(got).slice(0, 200)}`) })
    return 'raised'
  }
  if (process.platform !== 'darwin') return 'off'
  try {
    let pids = terminalPidsFor(await psText(), session, app)
    if (!pids.length) pids = terminalPidsFor(await psText(true), session, app)   // 창을 방금 연 경우 등: 새로 읽고 판단
    if (pids.length) {
      try { raising.child?.kill() } catch {}
      // 먼저 그 인스턴스를 pid로 바로 앞으로(권한 불필요, 즉시). System Events 정밀 올리기(최소화 해제)는 그 뒤에 —
      // 권한이 없으면 4초 시간 초과를 기다리던 탓에 창이 4초 늦게 올라왔다(2026-11-08 pro QA).
      // 도우미가 여러 인스턴스 중 창이 가장 큰 것을 골라 앞으로 올리고 그 pid를 돌려준다. 정밀 올리기도 그 pid부터.
      const got = await macHelper.send(`${pids.join(',')};${split || 0}`, 3000)
      const m = /^ok:(\d+)(?::(\d+):(.*))?$/.exec(got) || []
      const chosen = Number(m[1]) || pids[0]
      // 화면 나눠 쓰기: 누르기 직전 맨 앞 앱(보드 브라우저)과 이 터미널을 나란히 놓는다.
      if (split > 0 && m[2] && Number(m[2]) !== chosen) {
        run('/usr/bin/osascript', ['-e', LAYOUT_AS, m[2], String(chosen), String(split), ...m[3].split(' ')], { timeout: 4000 })
          .then((r) => { if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: split ${r}`) })
          .catch((err) => console.error(`whosup: split layout failed: ${String(err.message || err).slice(0, 200)}`))
      }
      if (got === 'none') psText(true).catch(() => {})   // 그 창이 닫혔으면 다음 클릭을 위해 목록을 새로 읽는다
      else if (!String(got).startsWith('ok')) run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', ACTIVATE_PID_JS, String(chosen)], { timeout: 3000 }).catch(() => {})
      // 고른 인스턴스만 넘긴다 — 여러 개를 넘기면 RAISE_AS가 '최소화 안 된 첫 창'을 골라 최소화한 큰 창을 건너뛴다.
      run('/usr/bin/osascript', ['-e', RAISE_AS, String(chosen)], { track: true, timeout: 4000 })
        .then((got) => { raiseWarn = null; if (process.env.WHOSUP_DEBUG_RAISE) console.error(`whosup: raise ${session} want=${pids.join(',')} got=${got}`) })
        .catch((err) => {
          if (/SIGTERM|exit null/.test(String(err.message))) return
          // 손쉬운 사용 권한이 없으면 최소화된 창을 펼칠 수 없다 — 보드에 안내를 띄운다(macOS 실측 -25211).
          if (/-25211|-1719|보조 접근|assistive access/i.test(String(err.message))) raiseWarn = 'mac_accessibility'
          console.error(`whosup: terminal raise failed (Accessibility?): ${String(err.message || err).slice(0, 200)}`)
          // 손쉬운 사용 권한이 없어도 앱 단위 activate는 된다(2026-11-08 pro 실측) — 최소한 그 터미널 앱은 앞으로.
          run('/usr/bin/osascript', ['-e', `tell application "${app.replace(/"/g, '')}" to activate`], { timeout: 3000 }).catch(() => {})
        })
      return 'raised'
    }
    if (/^ghostty$/i.test(app)) {
      // No window shows this session: open one attached to it (the session keeps running either way).
      // 창이 막 열리는 중(10초 안)이면 또 열지 않는다 — 클릭마다 인스턴스가 쌓였다(2026-11-08 pro QA).
      if (Date.now() - (openedAt.get(session) || 0) < 10000) return 'opened'
      openedAt.set(session, Date.now())
      const opener = spawn('/usr/bin/open', ['-na', 'Ghostty', '--args', `--command=${[bin(), ...clientArgv(session)].join(' ')}`], { detached: true, stdio: 'ignore' })
      opener.once('error', (err) => console.error(`whosup: could not open a terminal window: ${String(err.message || err).slice(0, 200)}`))
      opener.unref()
      return 'opened'
    }
  } catch (err) { console.error(`whosup: terminal raise failed: ${String(err.message || err).slice(0, 200)}`) }
  run('/usr/bin/osascript', ['-e', `tell application "${app.replace(/"/g, '')}" to activate`]).catch(() => {})
  return 'app'
}

export const agentCommand = () => process.env.AGENT_CMD || 'claude'

// Jump to a pane (any tab, any session). If `run` is given, run it in that pane (e.g. resume).
// 연타 때는 마지막 클릭만 이긴다: 앞선 요청이 늦게 끝나도 뒤 요청의 칸을 덮어쓰지 않는다
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
  const { cwd = process.env.HOME, run = null, seq } = opts
  const { session, pane } = splitRef(ref)
  const stale = Number.isFinite(seq) ? seq < latestClick : mine !== focusSeq
  if (stale && !run) return { session, pane, client: 'running', window: 'superseded' }
  const client = await ensureServer(session, cwd)
  // 창 올리기는 칸 이동과 상관없으니 같이 시작한다(ps·osascript 기동 시간을 칸 이동 뒤로 미루지 않게).
  const windowP = activateTerminal(session, opts.split)
  for (let i = 0; ; i++) {
    try { await apiCall(session, 'pane.focus', { pane_id: pane }); break } catch (err) {
      if (client !== 'started' || i >= 12) throw err
      await sleep(250)
    }
  }
  if (run) herdr(['pane', 'run', pane, run], session)
  const window = await windowP
  return { session, pane, client, window }
}

// 보드에서 끄기: 칸 하나를 닫거나(그 칸의 에이전트도 끝남) 세션 서버를 통째로 끈다(붙은 터미널 창도 함께 닫힘).
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
// 꺼진 세션 다시 켜기: 서버를 띄우고 그 세션을 보여 주는 창을 연다.
export async function startSession(session, cwd = process.env.HOME) {
  checkSessionName(session)
  const client = await ensureServer(session, cwd)
  const window = await activateTerminal(session)
  return { session, client, window }
}

// New tab in a session with the agent started, then jump there.
export async function newSession({ session, cwd, command = agentCommand() }) {
  checkSessionName(session)
  if (!cwd || !existsSync(cwd)) throw cwdMissing(cwd)
  const client = await ensureServer(session, cwd)
  const created = herdrJson(['tab', 'create', '--cwd', cwd, '--label', basename(cwd) || cwd, '--focus'], session)
  const pane = created?.root_pane?.pane_id
  if (!pane) throw new Error('herdr did not return the new pane id')
  herdr(['pane', 'run', pane, command], session)
  await apiCall(session, 'pane.focus', { pane_id: pane })
  const window = await activateTerminal(session)
  return { session, pane, client, window }
}
