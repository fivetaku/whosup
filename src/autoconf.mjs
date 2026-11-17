// 자동 감지 규칙표(레인 L1~L10): 실행 환경에서 무엇을 확인해 어떤 값을 정하는지 한 곳에 모은다(PRD2/01_PRD.md).
// 레인 값(values) 옆에 "읽을 herdr-core 코어 프로필"(cores)도 여기서 정한다: 자기 코어를 띄우는 데스크톱 앱의 서버가 확인된 코어만
// (coreProfiles — 이름·앱 이름·웹 주소는 그 서버와 프로세스가 알려 준 값이고, 코드에 박아 둔 이름은 없다).
//
// 레인은 순수 함수다 — 입력(facts: 플랫폼·환경변수·파일 존재·프로브 결과)만 보고 [{ lane, key, value, reason }]을 돌려준다.
// value가 undefined면 "자동 값 없음"(그 항목은 기본값으로 떨어진다). 감지하지 못한 것은 추측하지 않는다.
// 실제 환경에서 facts를 모으는 일은 detect() 하나가 한다(scripts/doctor.mjs diagnose·herdr detectTerminal·core를 그대로 쓴다).
//
// 자동 값은 설정의 맨 아래 층이다: 설정(DB) > 환경변수(.env 포함) > 자동 > 기본값(src/settings.mjs).
// 여기서는 .env·DB를 쓰지 않는다. 결과는 상태 폴더의 auto.json에 남는다(scripts/autoconf.mjs).
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:net'
import { homedir, release } from 'node:os'
import { join } from 'node:path'
import { desktopSession, diagnose, which, winSessionNo } from '../scripts/doctor.mjs'
import * as herdr from './runtime/herdr.mjs'
import { paneUrlTemplate, profileFeatures } from './runtime/ovis.mjs'
import { platform } from './platform.mjs'

export const AUTO_FILE = 'auto.json'
export const OVIS_PORTS = Array.from({ length: 14 }, (_, i) => 7317 + i)   // 7317~7330
// 맥에서 새 창을 열 줄 아는 앱이 먼저(herdr.mjs openerFor), 그다음 창 올리기만 되는 앱.
export const MAC_TERMINALS = ['Ghostty', 'Terminal', 'iTerm', 'WezTerm', 'kitty']
// 지금 명령을 치고 있는 터미널 앱(환경이 말해 주는 것): 터미널 앱은 자기 안에서 띄운 셸의 환경에 자기 이름을 남긴다 —
// TERM_PROGRAM, 그것이 없으면 TERM의 xterm-<이름>. 그 값을 위 표(MAC_TERMINALS)의 앱 이름으로 잇는다: 대소문자와 끝의 ".app"은
// 보지 않고 이름이 같은 앱을 찾는다. 환경 값이 앱 이름과 다른 것만 아래 표(TERM_NAMES — 열쇠는 소문자)에 적는다.
// 표에 없는 값(다른 프로그램 안의 셸 등)과 값이 없는 환경(로그인할 때 뜬 보드, 에이전트가 돌린 설치)은 null — 추측하지 않는다.
export const TERM_NAMES = { apple_terminal: 'Terminal' }
export function terminalOfEnv(env = {}) {
  const keys = [String(env?.TERM_PROGRAM ?? '').trim().toLowerCase().replace(/\.app$/, ''), /^xterm-(.+)$/.exec(String(env?.TERM ?? '').trim().toLowerCase())?.[1] || '']
  for (const k of keys) {
    const hit = k && (Object.hasOwn(TERM_NAMES, k) ? TERM_NAMES[k] : MAC_TERMINALS.find((a) => a.toLowerCase() === k))
    if (hit) return hit
  }
  return null
}
const NODE_MIN = [22, 13]

const item = (lane, key, value, reason) => ({ lane, key, value, reason })
// 원격이면 그 이유, 데스크톱이면 null. 윈도우 판정(세션 0·SESSIONNAME)은 doctor의 desktopSession을 그대로 쓴다.
// macOS·리눅스는 주입한 platform만 보도록 여기서 본다(desktopSession의 리눅스 판정은 지금 도는 OS를 봐서 주입 시험에 맞지 않는다).
// 설치 때의 업데이트 안내(src/setup.mjs)도 이 판정을 쓴다 — 감지 전체를 돌리지 않고 원격인지만 본다({ platform, env }만 준다).
export const remoteWhy = (f) => {
  const env = f.env || {}
  if (f.platform === 'win32') { const d = desktopSession(env, true, f.winSession ?? null); return d.ok ? null : d.why }   // winSession: detect()가 읽은 세션 번호
  if (env.SSH_CONNECTION || env.SSH_TTY) return 'ssh'
  if (f.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return 'no DISPLAY/WAYLAND_DISPLAY'
  return null
}

// L1 OS: 실행기(sh / node launch.mjs)는 herdr-plugin.toml이 고른다. 여기서는 그 사실과 OS 알림 항목 노출만 정한다.
export function laneOS(f) {
  const p = f.platform
  if (!['darwin', 'linux', 'win32'].includes(p)) return [item('L1', 'os', undefined, `unsupported platform ${p}`)]
  return [
    item('L1', 'os', p, `process.platform=${p}${f.release ? ` release=${f.release}` : ''}`),
    item('L1', 'launcher', p === 'win32' ? 'node' : 'sh', p === 'win32' ? 'herdr-plugin.toml windows entries run node scripts/launch.mjs' : 'herdr-plugin.toml linux·macos entries run sh scripts/plugin.sh'),
    item('L1', 'os_notify_available', p !== 'win32', p === 'win32' ? 'OS alerts are not offered on Windows' : 'OS alerts can be turned on in settings'),
  ]
}

// L2 Node·sqlite: 22.13 미만이거나 node:sqlite가 없으면 설치가 멈춘다(preflight). 규칙표에는 판정만 싣는다.
export function laneNode(f) {
  const v = f.node?.version
  if (!v) return [item('L2', 'node_ok', undefined, 'node version not known')]
  const [maj, min] = String(v).replace(/^v/, '').split('.').map(Number)
  const newEnough = maj > NODE_MIN[0] || (maj === NODE_MIN[0] && min >= NODE_MIN[1])
  if (f.node.sqlite === false) return [item('L2', 'node_ok', false, `node ${v}: node:sqlite missing, need Node 22.13+`)]
  if (!newEnough) return [item('L2', 'node_ok', false, `node ${v} is older than 22.13`)]
  return [item('L2', 'node_ok', true, `node ${v} with node:sqlite`)]
}

// L3 데스크톱 세션: 원격(SSH·윈도우 세션 0·리눅스 화면 없음)이면 브라우저를 열지 않는다. 창 올리기도 끈다(L4 front_app 'off').
export function laneDesktop(f) {
  const why = remoteWhy(f)
  if (why) {
    return [
      item('L3', 'desktop', false, `remote: ${why}`),
      item('L3', 'open_browser', 0, `remote (${why}): no browser to open on this screen`),
    ]
  }
  return [item('L3', 'desktop', true, 'local desktop session'), item('L3', 'open_browser', undefined, 'local: default (open once)')]
}

// L4 터미널 앱(front_app). 맥: 지금 herdr를 보여 주는 앱 > 지금 명령을 치고 있는 터미널 앱(terminal.current — 환경에서 안 것,
// terminalOfEnv) > 설치된 앱(Ghostty·Terminal·iTerm·WezTerm·kitty 순). 떠 있는 herdr 창이 없을 때 깔린 앱 목록부터 보면, 설치를 돌리는
// 터미널이 아닌 앱을 "감지했다"고 말하고 보드는 나중에 herdr를 띄운 그 터미널을 말한다(둘이 어긋난다) — 그래서 치고 있는 터미널이 먼저다.
// 윈도우: wt.exe가 있으면 Windows Terminal, 없으면 기본(PowerShell). 맥·윈도우 모두 원격이면 'off'. 리눅스: 창 올리기 없음.
export function laneTerminal(f) {
  const p = f.platform
  if (p === 'win32') {
    const why = remoteWhy(f)
    if (why) return [item('L4', 'front_app', 'off', `remote (${why}): windows would not show, raising is off`)]
    if (f.tools?.wt) return [item('L4', 'front_app', 'Windows Terminal', `wt.exe found at ${f.tools.wt}`)]
    return [item('L4', 'front_app', undefined, 'wt.exe not on PATH: default PowerShell window')]
  }
  if (p === 'darwin') {
    const why = remoteWhy(f)
    if (why) return [item('L4', 'front_app', 'off', `remote (${why}): windows on this Mac's screen are not seen, raising is off`)]
    if (f.terminal?.showing) return [item('L4', 'front_app', f.terminal.showing, `${f.terminal.showing} is showing a herdr client now`)]
    if (f.terminal?.current) return [item('L4', 'front_app', f.terminal.current, `no herdr window now: ${f.terminal.current} is the terminal this was started from (TERM_PROGRAM / TERM)`)]
    const inst = MAC_TERMINALS.find((a) => (f.terminal?.installed || []).includes(a) && a !== 'Terminal')
    if (inst) return [item('L4', 'front_app', inst, `${inst}.app is installed`)]
    return [item('L4', 'front_app', undefined, 'no herdr window and no extra terminal app: default (Terminal)')]
  }
  return [item('L4', 'front_app', undefined, `${p}: whosup does not raise windows here`)]
}

// L5 herdr: 실행 파일·버전·herdr 세션(데스크) 목록. 읽을 수 있으면 읽기 대상에 herdr를 넣는다(WHOSUP_RUNTIMES 'auto'가 그대로 쓴다).
export function laneHerdr(f) {
  const h = f.herdr
  if (!h) return [item('L5', 'runtime_herdr', undefined, 'herdr not checked')]
  if (!h.found) return [item('L5', 'runtime_herdr', false, `herdr not found (${h.bin || 'herdr'})`)]
  const running = (h.sessions || []).filter((s) => s.status === 'running').map((s) => s.name)
  return [item('L5', 'runtime_herdr', true, `${h.version || 'herdr'}; running desks: ${running.length ? running.join(', ') : 'none'}`)]
}

// L6 Herdr 데스크톱 앱: herdr-core 소켓(core.lock)이 살아 있으면 읽기 대상에 넣는다. herdr-app이 있으면 앱 창을 올릴 수 있다.
export function laneCore(f) {
  const c = f.herdrCore
  const out = []
  if (!c) out.push(item('L6', 'runtime_herdr_core', undefined, 'herdr-core not checked'))
  else if (c.running) out.push(item('L6', 'runtime_herdr_core', true, `herdr-core socket ${c.socket}`))
  else out.push(item('L6', 'runtime_herdr_core', false, c.socket ? `herdr-core socket missing (${c.socket})` : 'no herdr-core core.lock'))
  if (f.herdrApp) out.push(item('L6', 'herdr_app', f.herdrApp.found ? f.herdrApp.bin : undefined, f.herdrApp.found ? `${f.herdrApp.bin} found: Herdr app windows can be raised` : `${f.herdrApp.bin} not found`))
  return out
}

// L7 ovis: 서명이 확인된 서버만(GET /api/health?scope=bridge 의 bridge_protocol 숫자 + web_ui.boot_id 문자열).
// 서버는 기본 포트 범위(7317~7330)와 브리지 등록부(임의 포트 — 데스크톱 앱)에서 찾는다(findOvis). 찾은 서버는 무엇을 보여 주는지로 갈린다:
//  · herdr 데스크를 보여 주는 서버(serving 이 herdr-core 가 아님): 붙은 herdr 세션(데스크)은 리슨 프로세스의 HERDR_SOCKET(없으면
//    HERDR_SESSION)으로 안다. herdr가 그 데스크를 실제로 보여 줄 때만 데스크별 웹 터미널 주소를 자동 값으로 둔다. 모르면 값 없이
//    '확인 필요' 후보로만 남긴다. 클릭 기본 동작은 바꾸지 않는다(오너 결정).
//    이름만 같은 데스크와는 맞추지 않는다: 서버의 HERDR_SOCKET 을 아는데 herdr 가 같은 이름의 데스크를 다른 소켓으로 보여 주면
//    다른 herdr(설정 폴더가 다른 herdr)의 데스크다 — 확정하지 않고 후보로 남긴다(교차 검토 F29).
//  · herdr-core 코어를 보여 주는 서버(자기 코어를 띄우는 데스크톱 앱): 그 서버가 알려 준 코어 이름으로 코어 프로필을 만든다
//    (coreProfiles — 결과의 cores). 여기에는 이유 줄만 남긴다. herdr 데스크의 웹 터미널 주소로는 쓰지 않는다.
export const ovisUrl = (port) => `http://127.0.0.1:${port}/?pane={pane}`
export function sessionOfSocket(socket, sessions = []) {
  if (!socket) return null
  const hit = sessions.find((s) => s.socket && s.socket === socket)
  if (hit) return hit.name
  return /[\\/]sessions[\\/]([^\\/]+)[\\/]herdr\.sock$/.exec(socket)?.[1] ?? null
}
// 코어 이름·앱 이름으로 받을 글자(src/settings.mjs autoCores 와 같은 규칙 — 읽는 쪽이 버릴 값을 싣지 않는다).
// 코어 이름은 상태 폴더 아래 폴더 이름이 되고, 앱 이름은 명령줄과 AppleScript 에 들어간다.
const CORE_NAME = /^[A-Za-z0-9._-]{1,80}$/
const APP_NAME = /^[A-Za-z0-9 ._-]{1,60}$/
export const validCoreName = (v) => typeof v === 'string' && CORE_NAME.test(v) && v !== '.' && v !== '..'
const validAppName = (v) => typeof v === 'string' && APP_NAME.test(v) && v.trim() === v
const showsCore = (o) => o.serving === 'herdr-core'
// 소켓 경로 비교: 심볼릭 링크가 낀 경로(/tmp 와 /private/tmp)가 같은 소켓으로 읽히게 detect()가 푼 경로(socketReal)를 먼저 본다.
const realSocket = (x) => x.socketReal || x.socket
export function laneOvis(f) {
  const servers = (f.ovis || []).filter((o) => o.signed)
  if (!servers.length) return [item('L7', 'ovis', undefined, (f.ovis || []).length ? 'ports answered but none is an ovis server' : 'no ovis server on 127.0.0.1:7317-7330 or in the ovis bridge registry')]
  const sessions = f.herdr?.sessions || []
  const known = new Set(sessions.map((s) => s.name))
  const taken = new Set()
  const cores = new Set()
  const out = [item('L7', 'ovis', servers.map((o) => o.port), `ovis on port ${servers.map((o) => o.port).join(', ')}`)]
  for (const o of servers) {
    if (showsCore(o)) {
      const who = f.platform === 'darwin' && validAppName(o.app) ? o.app : 'an app'
      if (!validCoreName(o.core)) out.push(item('L7', `core_candidate:${o.port}`, undefined, `ovis on ${o.port} shows herdr-core but did not say which core — check`))
      else if (cores.has(o.core)) out.push(item('L7', `core_candidate:${o.port}`, undefined, `ovis on ${o.port} also shows herdr-core "${o.core}"; the first server found is used — check`))
      else { cores.add(o.core); out.push(item('L7', `core:${o.core}`, o.port, `${who} shows herdr-core "${o.core}" (server on ${o.port})`)) }
      continue
    }
    const exact = o.socket ? sessions.find((s) => s.socket && realSocket(s) === realSocket(o)) : null
    const session = exact?.name || sessionOfSocket(o.socket, sessions) || o.sessionEnv || null
    const how = o.socket ? 'HERDR_SOCKET of the listening process' : o.sessionEnv ? 'HERDR_SESSION of the listening process' : null
    if (!session) { out.push(item('L7', `ovis_candidate:${o.port}`, undefined, `ovis on ${o.port}: herdr session not found (${o.why || 'process environment not readable'}) — check`)); continue }
    if (!known.has(session)) { out.push(item('L7', `ovis_candidate:${o.port}`, undefined, `ovis on ${o.port} is attached to herdr session "${session}" (${how}), which herdr does not list — check`)); continue }
    // F29: 양쪽 소켓을 다 아는데 서로 다르면 이름만 같은 다른 herdr 의 데스크다. 소켓을 모를 때(HERDR_SESSION 만)의 이름 일치는 그대로 둔다.
    const listed = sessions.find((s) => s.name === session)
    if (o.socket && !exact && listed?.socket) { out.push(item('L7', `ovis_candidate:${o.port}`, undefined, `ovis on ${o.port} is attached to a herdr session named "${session}" on another socket than the one herdr lists (same name, another herdr) — check`)); continue }
    if (taken.has(session)) { out.push(item('L7', `ovis_candidate:${o.port}`, undefined, `ovis on ${o.port} also serves "${session}"; the lower port is used — check`)); continue }
    taken.add(session)
    out.push(item('L7', `open_url:${session}`, ovisUrl(o.port), `ovis on ${o.port} serves herdr session "${session}" (${how})`))
  }
  return out
}
// 코어 프로필(결과의 cores): herdr-core 코어를 보여 주는 서버마다 하나 — 읽는 쪽은 src/settings.mjs autoCores · src/runtime/core.mjs plan.
//   name  그 서버가 알려 준 코어 이름(코드에 박은 이름이 없다)
//   focus 늘 false 로 분명히 적는다: 자기 코어를 띄우는 앱에는 앱 안의 그 세션으로 보낼 수단이 없다(보기와 앱 창 올리기만).
//         코어 이름이 기본 코어 이름과 같아도 그렇다 — 적지 않으면 읽는 쪽이 기본 코어를 herdr-app 대상으로 본다.
//   app   그 서버 프로세스가 속한 앱 이름(맥에서만, 찾았을 때만)
//   url   그 서버의 웹 주소 틀 — 브라우저에서 추가 인증 없이 열린다고 서버가 답했을 때만(webOpen). 그 세션의 터미널 보기까지 적은
//         모양이다(runtime/ovis.mjs paneUrlTemplate: …/?pane={pane}&view=terminal — 런타임이 이동 결과에 싣는 주소와 같은 모양).
//         herdr 데스크의 웹 터미널 주소(위 laneOvis 의 open_url:<데스크> — ovisUrl)는 예전 그대로다.
//   features 되는 기능(F18): 새 세션·이동·닫기·이어서 열기마다 { means, reason? } — 값의 뜻은 runtime/ovis.mjs coreFeatures.
//         위 값(url·app)에서 런타임과 같은 함수(profileFeatures)로 계산해 적는다: 감지한 때의 값이다(포트·주소·토큰은 들어가지 않는다).
//         auto.json 만 읽는 쪽을 위한 것이고, 런타임(core.mjs)은 이 값을 읽지 않고 같은 함수로 그때그때 다시 계산한다.
//   socket 은 싣지 않는다: 서버가 알려 주는 것은 코어 이름뿐이고(등록부의 socket_path 는 코어 소켓이 아니다), 읽는 쪽이 core.lock 에서 찾는다.
// Herdr 앱 코어(기본 코어)는 프로필 없이도 예전처럼 동작하므로 싣지 않는다. "웹 서버가 확인된 코어"만 싣는다.
export function coreProfiles(f) {
  const out = []
  for (const o of (f.ovis || []).filter((x) => x.signed && showsCore(x) && validCoreName(x.core))) {
    if (out.some((p) => p.name === o.core)) continue
    const app = f.platform === 'darwin' && validAppName(o.app) ? o.app : null
    const p = { name: o.core, focus: false, ...(app ? { app } : {}), ...(o.webOpen === true ? { url: paneUrlTemplate(o.port) } : {}) }
    out.push({ ...p, features: profileFeatures(p) })
  }
  return out
}

// L8 에이전트: PATH의 claude > codex. 이어서 열기는 ~/.claude/projects(CLAUDE_PROJECTS_DIR)가 있어야 대화를 찾는다.
export function laneAgent(f) {
  const a = f.agents || {}
  const out = []
  if (a.claude) out.push(item('L8', 'agent_cmd', 'claude', `claude found at ${a.claude}`))
  else if (a.codex) out.push(item('L8', 'agent_cmd', 'codex', `claude not on PATH, codex found at ${a.codex}`))
  else out.push(item('L8', 'agent_cmd', undefined, 'neither claude nor codex on PATH: default (claude)'))
  out.push(item('L8', 'resume_available', a.projectsDir === undefined ? undefined : Boolean(a.projectsDir), a.projectsDir ? `conversation folder ${a.projectsDir}` : 'no Claude conversation folder: resume starts fresh'))
  return out
}

// L9 맥 손쉬운 사용 권한: 창 올리기에서 권한이 빠졌다고 확인됐을 때만 '화면 나눠 쓰기 불가'. 확인 전에는 값 없음.
export function laneAccessibility(f) {
  if (f.platform !== 'darwin') return [item('L9', 'split_available', undefined, `${f.platform}: no macOS accessibility check`)]
  if (f.raiseWarning === 'mac_accessibility') return [item('L9', 'split_available', false, 'Accessibility permission missing: split screen and restoring minimized windows do not work')]
  return [item('L9', 'split_available', undefined, f.raiseWarning === null ? 'no permission problem seen so far (checked when a session is clicked)' : 'not checked yet (checked when a session is clicked)')]
}

// L10 포트: PORT(또는 4790)부터 빈 포트. whosup은 막혀 있으면 스스로 다음 포트로 간다 — 규칙표에는 그 판정만.
export function lanePort(f) {
  const p = f.port
  if (!p || !p.free) return [item('L10', 'port', undefined, p ? `no free port in ${p.start}-${p.start + 9}` : 'port not checked')]
  return [item('L10', 'port', p.free, p.free === p.start ? `${p.start} is free` : `${p.start}-${p.free - 1} busy, ${p.free} is free`)]
}

export const LANES = [laneOS, laneNode, laneDesktop, laneTerminal, laneHerdr, laneCore, laneOvis, laneAgent, laneAccessibility, lanePort]

// 레인 전체 → auto.json 본문. values는 자동 값이 있는 키만. cores = 읽을 herdr-core 코어 프로필 목록(coreProfiles).
export function evaluate(facts) {
  const lanes = LANES.flatMap((fn) => fn(facts))
  const values = {}
  for (const l of lanes) if (l.value !== undefined && !(l.key in values)) values[l.key] = l.value
  const reasons = Object.fromEntries(lanes.filter((l) => l.value !== undefined).map((l) => [l.key, `${l.lane}: ${l.reason}`]))
  const cores = coreProfiles(facts)
  return { version: AUTO_VERSION, at: new Date().toISOString(), platform: facts.platform, values, reasons, lanes, cores, summary: summarize(facts, lanes, cores) }
}
export const AUTO_VERSION = 1

// 화면이 쓸 "감지한 환경" 요약(경로는 넣지 않는다).
//   cores      보드에 세션이 보이는 앱 코어(코어 프로필 가운데 런타임이 실제로 읽는 것): [{ name, app(없으면 null), web(웹 주소가 있는가) }]
//   herdr_core running = 기본 코어가 떠 있는가. view_only = 그 기본 코어가 보기 전용 앱의 코어인가(이름이 같은 코어 프로필이 있다) —
//              그러면 "Herdr 앱 세션을 여는 곳"은 묻지 않는다(herdr-app 으로 보낼 수 있는 코어가 아니다).
export function summarize(f, lanes, cores = coreProfiles(f)) {
  const get = (k) => lanes.find((l) => l.key === k)
  const scope = f.coreScope || { base: 'default', only: null }
  const read = cores.filter((c) => !scope.only || scope.only.includes(c.name))
  return {
    os: f.platform,
    desktop: get('desktop')?.value ?? null,
    terminal: get('front_app')?.value ?? null,
    herdr: f.herdr ? { found: Boolean(f.herdr.found), version: f.herdr.version || null, sessions: (f.herdr.sessions || []).filter((s) => s.status === 'running').map((s) => s.name) } : null,
    herdr_core: f.herdrCore ? { running: Boolean(f.herdrCore.running), view_only: read.some((c) => c.name === scope.base) } : null,
    cores: read.map((c) => ({ name: c.name, app: c.app || null, web: Boolean(c.url) })),
    herdr_app: f.herdrApp ? { found: Boolean(f.herdrApp.found) } : null,
    ovis: lanes.filter((l) => l.lane === 'L7' && (l.key.startsWith('open_url:') || l.key.startsWith('ovis_candidate:'))).map((l) => {
      const port = Number(/:(\d+)\//.exec(l.value || '')?.[1] || l.key.split(':')[1])
      return l.value ? { port, session: l.key.slice('open_url:'.length), url: l.value, confirmed: true, reason: l.reason } : { port, session: null, url: null, confirmed: false, reason: l.reason }
    }),
    agent: get('agent_cmd')?.value ?? null,
    options: optionsOf(f, get('desktop')?.value !== false),
  }
}
// 감지한 선택지: 첫 실행 안내와 설정이 그대로 보여 주는 목록이다(고른 값은 설정에 저장되고, 이 목록은 auto.json에 남는다).
// 터미널 앱: 맥은 지금 herdr를 띄운 앱 + 설치된 앱(+ 지금 명령을 치고 있는 터미널 앱이 그 목록에 없으면 맨 뒤에 — 자동 감지가 고른
// 값이 선택지에 없는 일이 없게), 윈도우는 Windows Terminal(있을 때)·PowerShell. 원격이면 창을 올리지 않으니 비운다.
// opens_new = 떠 있는 창이 없을 때 새 창까지 열 줄 아는 앱(herdr.mjs openerFor). 웹 터미널은 summary.ovis, Herdr 앱은 summary.herdr_app·herdr_core.
export function optionsOf(f, desktop = true) {
  let terminal_apps = []
  if (desktop && f.platform === 'darwin') {
    const showing = f.terminal?.showing || null
    const names = [...new Set([showing, ...(f.terminal?.installed || []), f.terminal?.current].filter(Boolean))]
    terminal_apps = names.map((name) => ({ name, showing: name === showing, opens_new: Boolean(herdr.openerFor(name, 'x', 'herdr')) }))
  } else if (desktop && f.platform === 'win32') {
    terminal_apps = [...(f.tools?.wt ? [{ name: 'Windows Terminal', showing: false, opens_new: true }] : []), { name: 'PowerShell', showing: false, opens_new: true }]
  }
  const a = f.agents || {}
  return { terminal_apps, agents: ['claude', 'codex'].filter((k) => a[k]) }
}

// ── 실제 환경에서 입력 모으기 ──
const runText = (file, args, timeout = 3000) => new Promise((resolve) => {
  execFile(file, args, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, out) => resolve(err ? '' : String(out)))
})
// 서명 확인: ovis의 열린 /api/health?scope=bridge(인증 없이 답하는 경로, herdr가 죽어 있어도 답한다).
export function ovisSignature(body) {
  return Boolean(body) && typeof body === 'object' && typeof body.bridge_protocol === 'number' && typeof body.web_ui?.boot_id === 'string'
}
// 그 서버가 무엇을 보여 주는가: 'herdr-core' | 'herdr' | null(말하지 않음 — 토큰이 걸린 서버는 이 사실을 알려 주지 않는다).
export function ovisServing(body) {
  const s = body?.herdr_runtime?.serving ?? body?.runtime
  return s === 'herdr-core' || s === 'herdr' ? s : null
}
// 그 서버가 보여 주는 herdr-core 코어 이름: herdr_runtime.serving 이 "herdr-core" 일 때만 herdr_core.session 을 믿는다.
// herdr_core 는 "이 PC 의 herdr-core 사실"이라 herdr 데스크를 보여 주는 서버(플러그인판)도 같은 줄을 낸다(2026-11-13 실측,
// 오비스 server/herdr-core/discovery.ts herdrCoreFacts) — 그 서버의 코어 이름으로 읽으면 엉뚱한 코어에 붙는다.
export function ovisCoreName(body) {
  if (!body || typeof body !== 'object' || body.herdr_runtime?.serving !== 'herdr-core') return null
  const s = body.herdr_core?.session
  return validCoreName(s) ? s : null
}
// 이 컴퓨터의 브라우저에서 그 서버의 주소가 추가 인증 없이 열리는가: 인증 없는 루프백 요청(이 확인 자체)을 서버가
// "로컬이라서 들여보냈다"(auth.via "local")고 답했을 때만 그렇다고 본다 — 같은 컴퓨터의 브라우저가 127.0.0.1 로 여는 요청도 같은
// 판정을 받는다(오비스 server/access.ts decideAccess: 토큰을 걸지 않은 서버의 loopback && !forwarded → via "local").
// 토큰이 걸린 서버(auth.required)나 그 밖의 답, 판단할 수 없는 답은 아니다(웹 주소를 싣지 않는다).
export function ovisOpensInBrowser(body) {
  const a = body?.auth
  return Boolean(a) && typeof a === 'object' && a.via === 'local' && a.required !== true && a.authenticated !== false
}
// 돌려주는 것: null(답 없음) | { port, answered, signed } + 서명된 서버면 { serving, core, webOpen }.
export async function probeOvis(port, timeoutMs = 800) {
  // 리디렉트는 따라가지 않는다(다른 주소로 요청이 나가지 않게), 2xx가 아닌 답은 서명으로 보지 않는다(codex 리뷰 M5-T4).
  const get = async (path) => {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' })
    if (!r.ok) return null
    try { return await r.json() } catch { return null }
  }
  let bridge
  try { bridge = await get('/api/health?scope=bridge') } catch { return null }
  if (!ovisSignature(bridge)) return { port, answered: true, signed: false }
  const serving = ovisServing(bridge)
  let core = null
  // 코어 이름은 scope 없는 /api/health 에만 있다. herdr-core 를 보여 준다고 한 서버에만 한 번 더 묻는다.
  if (serving === 'herdr-core') { try { core = ovisCoreName(await get('/api/health')) } catch {} }
  return { port, answered: true, signed: true, serving, core, webOpen: ovisOpensInBrowser(bridge) }
}
// ── ovis 브리지 등록부: 서버마다 <설정 폴더>/bridges/<해시>.json 을 남긴다(오비스 server/bridge.ts registerBridge) ──
// 데스크톱 앱의 서버는 임의 포트에서 들어서 기본 포트 범위로는 찾지 못한다. 여기서는 포트 후보만 얻는다 — 그 포트의 서버가
// ovis 인지는 서명 확인(probeOvis)이 가린다. 폴더: <홈>/.config/ovis/bridges 와 옛 이름 herdr-web-ui(오비스가 실제로 쓰는 경로,
// 옮긴 설치에서는 ovis 를 가리키는 링크), XDG_CONFIG_HOME 이 다르면 그 아래도 본다. 같은 폴더는 한 번만 읽는다.
export function ovisRegistryDirs(env = process.env, home = homedir()) {
  const bases = [...new Set([join(home, '.config'), env.XDG_CONFIG_HOME].filter(Boolean))]
  return bases.flatMap((b) => ['ovis/bridges', 'herdr-web-ui/bridges'].map((d) => join(b, d)))   // 제품이 정한 설정 폴더 이름(세션·코어 이름이 아니다)
}
// 내 프로세스로 살아 있는 pid 인가. 신호를 보낼 권한이 없는 pid(EPERM)는 다른 사용자의 프로세스다 — 이 사용자의 등록부에 적힌
// 서버가 아니다(오비스 descriptorLive 와 같은 판정). 윈도우는 그 구분이 없어 살아 있는 것으로 본다.
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' && platform() === 'win32' } }
// 등록부 파일들에서 [{ port, pid }]: pid 가 살아 있는 항목만. 파일에서는 port·pid 두 숫자만 꺼내 쓴다. 등록 파일에는 token 도 함께
// 적혀 있다 — 파일을 읽는 동안 그 글자가 메모리를 지나가지만(읽어야 두 숫자를 찾는다), token 은 따로 꺼내지 않고 어디에도 담아 두지도
// 남기지도(돌려주기·기록·auto.json) 않는다. 파일 전체를 값으로 풀지 않고(JSON.parse 를 쓰지 않는다) 두 숫자만 정규식으로 집는다:
// 등록 파일은 한 겹짜리 객체다(오비스 server/bridge.ts registerBridge). 따옴표 안의 글자는 열쇠로 읽히지 않는다(JSON 글자열 안의
// 따옴표는 \" 로 적힌다).
// 없는 폴더·깨진 파일(객체 모양이 아님)·모양이 틀린 값·죽은 pid(재부팅 뒤 남은 파일)는 조용히 넘어간다.
const regNumber = (key) => new RegExp(`[{,]\\s*"${key}"\\s*:\\s*(\\d{1,10})\\s*[,}]`)
const REG_PORT = regNumber('port')
const REG_PID = regNumber('pid')
const REG_OBJECT = /^\s*\{[\s\S]*\}\s*$/
export function readOvisRegistry(dirs, { alive = pidAlive } = {}) {
  const out = []
  const seen = new Set()
  for (const dir of dirs) {
    let real, names
    try { real = realpathSync(dir); names = readdirSync(real) } catch { continue }
    if (seen.has(real)) continue
    seen.add(real)
    for (const n of names.filter((x) => x.endsWith('.json')).slice(0, 200)) {
      try {
        const file = join(real, n)
        if (!statSync(file).isFile() || statSync(file).size > 64 * 1024) continue
        const text = readFileSync(file, 'utf8')
        if (!REG_OBJECT.test(text)) continue
        const port = Number(REG_PORT.exec(text)?.[1])
        const pid = Number(REG_PID.exec(text)?.[1])
        if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid <= 1 || !alive(pid)) continue
        if (!out.some((x) => x.port === port)) out.push({ port, pid })
      } catch {}
    }
  }
  return out
}
// 등록부에 적힌 살아 있는 ovis 서버들을 한 줄로(포트:pid, 정렬). 보드가 도는 동안 이 값이 바뀌면 다시 감지한다(bin/whosup.mjs) —
// 보드보다 늦게 켠 앱(로그인 때 보드가 먼저 뜨는 단독 설치), 다시 켜서 포트가 바뀐 앱, 꺼진 앱을 "다시 감지" 단추 없이 따라간다.
// 파일만 읽는다(서버에 묻지 않는다). 이 값에는 포트와 pid 뿐이다(token 은 readOvisRegistry 가 꺼내 쓰지 않는다).
export const ovisRegistryKey = (env = process.env, home = homedir(), opts = {}) =>
  readOvisRegistry(ovisRegistryDirs(env, home), opts).map((r) => `${r.port}:${r.pid}`).sort().join(',')
// 등록부 지켜보기: 부른 때의 값을 기준으로 everyMs 마다 다시 읽고, 바뀌었을 때만 onChange 를 한 번 부른다. 돌려주는 것 = 멈추는 함수.
// 기준을 부른 때 읽으므로, 시작할 때의 감지보다 먼저 부르면 그 사이에 켜진 앱도 첫 확인에서 바뀐 것으로 잡힌다.
export function watchOvisRegistry(onChange, { everyMs = 10_000, key = () => ovisRegistryKey() } = {}) {
  let last = key()
  const timer = setInterval(() => {
    let k
    try { k = key() } catch { return }
    if (k === last) return
    last = k
    onChange()
  }, everyMs)
  timer.unref?.()
  return () => clearInterval(timer)
}
// 코어 이름을 아직 듣지 못한 앱 서버가 있는가: herdr-core 를 보여 준다고 했지만 /api/health 에 herdr_core 가 아직 없는 서버.
// 실물 확인(2026-11-13, 오비스 데스크톱 앱 0.5.3): 앱이 켜진 직후 몇 초 동안은 서버가 herdr_runtime 만 답하고 herdr_core(코어 이름)는
// 자기 코어를 찾은 뒤에야 답에 싣는다. 그 사이에 감지하면 코어 프로필이 만들어지지 않는다 — 등록부는 그 뒤로 바뀌지 않으므로
// 다시 묻지 않으면 그 앱의 세션이 "다시 감지"를 누를 때까지 보드에 나오지 않는다.
export const hasPendingCore = (result) => (Array.isArray(result?.lanes) ? result.lanes : [])
  .some((l) => typeof l?.key === 'string' && l.key.startsWith('core_candidate:') && /did not say which core/.test(String(l.reason || '')))
// 그런 서버가 있는 동안 everyMs 마다 다시 감지한다(최대 max 번 — 토큰이 걸려 끝내 이름을 알려 주지 않는 서버를 계속 묻지 않게).
// check(result): 감지 결과를 볼 때마다 부른다. reset(): 등록부가 바뀌었을 때(다른 앱·다시 켠 앱) 횟수를 처음으로 돌린다.
export function pendingCoreRetry(redetect, { everyMs = 5000, max = 12, setTimer = setTimeout } = {}) {
  let tries = 0
  let timer = null
  const check = (result) => {
    if (!hasPendingCore(result)) { tries = 0; return false }
    if (timer || tries >= max) return false
    timer = setTimer(() => { timer = null; tries++; redetect() }, everyMs)
    timer?.unref?.()
    return true
  }
  return { check, reset: () => { tries = 0 } }
}
// 리슨 프로세스의 환경에서 열쇠 두 개(HERDR_SOCKET·HERDR_SESSION)의 값만 꺼내 쓴다. 맥: ps eww, 리눅스: /proc/<pid>/environ. 윈도우: 방법 없음.
// 그 프로세스의 환경 전체가 읽는 동안 메모리를 지나가지만, 두 값 말고는 꺼내지 않고 어디에도 담아 두지도 남기지도 않는다.
export function envFromPs(text) {
  const pick = (k) => new RegExp(`(?:^|\\s)${k}=(\\S+)`).exec(text)?.[1] ?? null
  return { socket: pick('HERDR_SOCKET'), sessionEnv: pick('HERDR_SESSION') }
}
// /proc/<pid>/environ(NUL 로 나뉜 "열쇠=값"들): 두 열쇠만 훑는다 — 환경 전체를 열쇠·값 표로 만들지 않는다.
// 열쇠는 맨 앞이나 NUL 바로 뒤에서 시작할 때만 그 열쇠다(다른 열쇠의 뒷부분·다른 값 안의 같은 글자는 아니다).
export function envFromProc(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(String(buf))
  const pick = (k) => {
    const key = Buffer.from(`${k}=`)
    for (let i = b.indexOf(key); i >= 0; i = b.indexOf(key, i + 1)) {
      if (i > 0 && b[i - 1] !== 0) continue
      const end = b.indexOf(0, i)
      return b.toString('utf8', i + key.length, end < 0 ? b.length : end) || null
    }
    return null
  }
  return { socket: pick('HERDR_SOCKET'), sessionEnv: pick('HERDR_SESSION') }
}
// 그 포트에서 듣는 프로세스들의 pid(lsof). 알 수 없으면 빈 목록이다: 윈도우(방법 없음), lsof 가 없는 기계, 다른 사용자의 프로세스(보이지 않는다).
export async function listenerPids(port, p = platform()) {
  if (p === 'win32') return []
  return (await runText('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'])).split('\n').map((x) => Number(x.trim())).filter((n) => Number.isInteger(n) && n > 1)
}
async function listenerEnv(pid, p = platform()) {
  if (p === 'win32') return { why: 'Windows: the listening process environment is not readable' }
  if (!pid) return { why: 'listening process not found (lsof)' }
  if (p === 'linux') { try { return envFromProc(readFileSync(`/proc/${pid}/environ`)) } catch { return { why: 'process environment not readable' } } }
  const e = envFromPs(await runText('/bin/ps', ['eww', '-o', 'command=', '-p', String(pid)]))
  return e.socket || e.sessionEnv ? e : { why: 'HERDR_SOCKET not in the listening process environment' }
}
// 실행 파일 경로에서 그 프로세스가 속한 앱 이름: …/<이름>.app/Contents/… 의 <이름>. 앱 안에 든 도우미 앱
// (…/X.app/Contents/Frameworks/X Helper.app/…)이면 바깥 앱(창을 가진 본체)의 이름이다. 받을 수 없는 글자의 이름은 없는 것으로 본다.
export function appOfPath(path) {
  const name = /^(?:(?!\.app\/).)*\/([^/]+)\.app\/Contents\//.exec(String(path || ''))?.[1]
  return validAppName(name) ? name : null
}
// 프로세스 줄들([{ tty, path }] — 서버 프로세스부터 조상 순)에서 그 서버를 띄운 앱 이름: 앱 묶음 안에 든 가장 가까운 프로세스의 앱.
// 서버 프로세스가 터미널에 붙어 있으면(제어 터미널이 있다) 사람이 터미널에서 띄운 서버다 — 조상에서 만나는 앱은 그 터미널 앱이지
// 이 코어를 보여 주는 앱이 아니므로 찾지 않는다(앱이 띄운 서버에는 제어 터미널이 없다).
export function appOfChain(rows) {
  if (!rows.length || !/^(\?+|-)?$/.test(String(rows[0].tty || '').trim())) return null
  for (const r of rows) { const app = appOfPath(r.path); if (app) return app }
  return null
}
// 맥에서만: 서버 프로세스와 그 조상(최대 8단계)을 ps 로 읽는다(pid 를 짚어 읽는다 — 실행 파일 경로·부모·제어 터미널만).
async function listenerApp(pid, p) {
  if (p !== 'darwin' || !pid) return null
  const rows = []
  for (let cur = pid, hops = 0; cur > 1 && hops < 8; hops++) {
    const m = /^\s*(\d+)\s+(\S+)\s+(.*)$/.exec((await runText('/bin/ps', ['-o', 'ppid=', '-o', 'tty=', '-o', 'comm=', '-p', String(cur)])).split('\n')[0] || '')
    if (!m) break
    rows.push({ tty: m[2], path: m[3].trim() })
    cur = Number(m[1])
  }
  return appOfChain(rows)
}
const realOf = (path) => { try { return realpathSync(path) } catch { return path } }
// ovis 서버 찾기: 기본 포트 범위 + 브리지 등록부의 포트. 어느 쪽이든 루프백(127.0.0.1)의 그 포트에 서명 확인을 통과해야 ovis 서버다.
// 등록부 항목은 두 가지를 본 뒤에만 후보로 쓴다(F2-2):
//   · 적힌 pid 가 살아 있다(readOvisRegistry).
//   · 그 포트를 듣는 프로세스가 그 pid 다: pid 가 살아 있다는 것만으로는 그 프로세스가 그 포트의 서버라는 뜻이 아니다(남은 등록 파일의
//     pid 를 다른 프로세스가 물려받았거나, 그 포트를 다른 프로세스가 듣고 있을 수 있다). 듣는 프로세스를 알아냈는데(listenerPids — lsof)
//     그 가운데 적힌 pid 가 없으면 그 항목을 버린다 — 그 포트에는 묻지도 않는다(기본 포트 범위의 포트는 범위 훑기로만 본다).
//     듣는 프로세스를 알 수 없으면(윈도우·lsof 없음) 예전처럼 서명 확인에 맡긴다.
// 그다음은 서버가 무엇을 보여 주는지에 따른다(laneOvis · coreProfiles):
//   herdr-core 를 보여 주는 서버 → 그 서버 프로세스가 속한 앱 이름(맥), 그 밖의 서버 → 붙은 herdr 세션(프로세스 환경의 HERDR_SOCKET).
// 등록부로 찾은 포트가 기본 범위 밖이어도 같은 흐름이다. listeners(port, 플랫폼) → pid 목록: 시험이 바꿔 끼운다.
export async function findOvis(p = platform(), env = process.env, { home = homedir(), ports = OVIS_PORTS, listeners = listenerPids } = {}) {
  const asked = new Map()   // 포트 → 그 포트에서 듣는 pid 들(포트마다 한 번만 묻는다)
  const pidsOf = (port) => { if (!asked.has(port)) asked.set(port, Promise.resolve().then(() => listeners(port, p)).catch(() => [])); return asked.get(port) }
  const reg = (await Promise.all(readOvisRegistry(ovisRegistryDirs(env, home)).map(async (r) => {
    const pids = await pidsOf(r.port)
    return !pids.length || pids.includes(r.pid) ? r : null
  }))).filter(Boolean)
  const all = [...new Set([...ports, ...reg.map((r) => r.port)])]
  const hits = (await Promise.all(all.map((port) => probeOvis(port)))).filter(Boolean)
  return Promise.all(hits.map(async (h) => {
    if (!h.signed) return h
    // 그 서버의 프로세스: 등록부가 적어 둔 pid(위에서 그 포트를 듣는 프로세스로 확인했거나, 확인할 길이 없었다), 없으면 lsof 가 찾은 것.
    const pid = reg.find((r) => r.port === h.port)?.pid || (await pidsOf(h.port))[0] || 0
    if (h.serving === 'herdr-core') { const app = await listenerApp(pid, p); return app ? { ...h, app } : h }
    const e = await listenerEnv(pid, p)
    return { ...h, ...e, ...(e.socket ? { socketReal: realOf(e.socket) } : {}) }
  }))
}
const portFree = (port) => new Promise((resolve) => {
  const s = createServer()
  s.once('error', () => resolve(false))
  s.listen(port, '127.0.0.1', () => s.close(() => resolve(true)))
})
async function freePort(start) {
  for (let p = start; p < start + 10; p++) if (await portFree(p)) return p
  return null
}
const macApps = () => MAC_TERMINALS.filter((a) => [join('/Applications', `${a}.app`), join('/System/Applications/Utilities', `${a}.app`), join(homedir(), 'Applications', `${a}.app`)].some(existsSync))

// 런타임이 읽는 herdr-core 코어의 범위(src/runtime/core.mjs plan 과 같은 규칙 — 화면 요약이 "보드에 보인다"고 틀리게 말하지 않게):
//   base = 기본 코어 이름(HC_SESSION, 없으면 herdr-core 의 기본 이름). only = 읽는 코어를 사람이 묶어 두었으면 그 이름들, 아니면 null.
export function coreScopeOf(env = process.env) {
  // 이름 규칙에 안 맞는 HC_SESSION 은 런타임이 무시한다(core.mjs sessionEnv) — 여기서도 주지 않은 것으로 본다.
  const named = validCoreName(env.HC_SESSION) ? env.HC_SESSION : null
  const base = named || 'default'
  if (env.HC_SOCKET || named) return { base, only: [base] }
  const want = String(env.WHOSUP_CORES || '').trim()
  if (!want || want.toLowerCase() === 'all') return { base, only: null }
  return { base, only: [base, ...want.split(',').map((x) => x.trim()).filter((n) => validCoreName(n) && n.toLowerCase() !== 'none')] }
}
export async function detect({ env = process.env } = {}) {
  const p = platform()
  const [d, term, ovis, free] = await Promise.all([
    diagnose(),
    p === 'darwin' ? herdr.detectTerminal().catch(() => null) : null,
    findOvis(p, env),
    freePort(Number(env.PORT) || 4790),
  ])
  const projectsDir = env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')
  // 데스크 소켓의 푼 경로(socketReal): ovis 서버의 HERDR_SOCKET 과 같은 소켓인지 볼 때 쓴다(laneOvis — 링크가 낀 경로도 같게 읽는다).
  if (d.herdr?.sessions) d.herdr.sessions = d.herdr.sessions.map((s) => (s.socket ? { ...s, socketReal: realOf(s.socket) } : s))
  return {
    platform: p, release: release(), env, coreScope: coreScopeOf(env),
    node: d.node, herdr: d.herdr, herdrCore: d.herdrCore, herdrApp: d.herdrApp, tools: d.tools,
    terminal: p === 'darwin' ? { showing: term?.front_app ?? null, installed: macApps(), current: terminalOfEnv(env) } : null,
    ovis,
    agents: { claude: which('claude', env), codex: which('codex', env), projectsDir: existsSync(projectsDir) ? projectsDir : null },
    raiseWarning: undefined,   // L9는 세션을 눌러 창을 올려 봐야 안다 — 서버가 실시간 값(raise_warning)을 함께 내려 준다
    port: { start: Number(env.PORT) || 4790, free },
    winSession: p === 'win32' && !env.SESSIONNAME && !env.SSH_CONNECTION && !env.SSH_CLIENT ? winSessionNo() : null,
  }
}

// ── auto.json ──
export const autoPath = (stateDir) => join(stateDir, AUTO_FILE)
// 임시 파일 이름은 쓸 때마다 다르다(pid + 무작위 조각): 같은 프로세스 안에서 두 번의 쓰기가 겹치거나 다른 프로세스(시작 스크립트)가
// 같은 때 써도 서로의 임시 파일을 덮거나 옮기지 않는다(F2-4). 쓰기·이름 바꾸기가 실패하면 그 임시 파일은 치운다(이름이 매번 달라 쌓인다).
export const autoTmpPath = (file) => `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`
export function writeAuto(stateDir, result) {
  mkdirSync(stateDir, { recursive: true })
  const file = autoPath(stateDir)
  const tmp = autoTmpPath(file)
  try {
    writeFileSync(tmp, `${JSON.stringify(result, null, 2)}\n`)
    renameRetry(tmp, file)   // 같은 폴더 안 이름 바꾸기: 읽는 쪽은 옛 파일이나 새 파일 하나를 통째로 본다
  } catch (err) {
    try { unlinkSync(tmp) } catch {}
    throw err
  }
  return file
}
// 윈도우는 다른 프로세스가 대상 파일을 열고 있는 짧은 순간(판 서버·시작 스크립트·백신이 읽는 중)에 덮어쓰는 이름 바꾸기를
// EPERM·EACCES·EBUSY로 거절한다(GitHub Actions windows-latest 실측). 잠깐 기다렸다 몇 번 다시 한다. 그 밖의 오류는 그대로 던진다.
const RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])
export function renameRetry(from, to, { rename = renameSync, tries = 20, waitMs = 25 } = {}) {
  for (let i = 1; ; i++) {
    try { return rename(from, to) } catch (err) {
      if (!RETRY_CODES.has(err?.code) || i >= tries) throw err
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs)
    }
  }
}
export function readAuto(stateDir) {
  try { const r = JSON.parse(readFileSync(autoPath(stateDir), 'utf8')); return r && typeof r === 'object' && r.values ? r : null } catch { return null }
}

// 서버(bin/whosup.mjs)가 시작할 때 auto.json을 그대로 써도 되는지: 시작 스크립트(plugin.sh·launch.mjs)가 방금 쓴 것만 믿는다.
// 형식 판본·플랫폼이 다르거나, 쓴 지 AUTO_FRESH_MS가 지났거나, 시각을 읽을 수 없으면 낡은 것으로 보고 다시 감지한다
// (직접 실행하면 몇 날 전 다른 환경에서 쓴 값이 그대로 쓰였다 — LOOP 2회차 회차 1 후보).
export const AUTO_FRESH_MS = 2 * 60 * 1000
export function autoIsFresh(r, { now = Date.now(), platform: p = platform(), maxAgeMs = AUTO_FRESH_MS } = {}) {
  if (!r || typeof r !== 'object' || r.version !== AUTO_VERSION || r.platform !== p || !r.values || r.error) return false
  const age = now - Date.parse(r.at)
  return Number.isFinite(age) && age >= -5000 && age <= maxAgeMs
}
// 감지를 한 줄로 세운다(F2-4). 감지를 부르는 곳이 여럿이다 — 시작할 때의 첫 감지, 등록부 지켜보기, 코어 이름 다시 묻기(pendingCoreRetry),
// 보드의 "다시 감지" 단추와 첫 실행 안내. 이들이 겹쳐 돌면 먼저 시작해 늦게 끝난 옛 감지가 새 감지의 값(자동 값·auto.json)을 덮는다.
// 돌려주는 함수 line(job): job("감지 → auto.json 쓰기 → 자동 값 갈아 끼우기"를 통째로)을 줄 끝에 세우고 그 결과를 돌려준다.
// 한 번에 하나만 돌고 부른 순서대로 돈다 — 뒤에 선 감지는 앞 감지가 끝난 뒤에 환경을 보므로 늘 더 새 값이다. 앞 일이 실패해도 줄은 이어진다.
export function detectLine() {
  let tail = Promise.resolve()
  return (job) => {
    const run = tail.then(() => job())
    tail = run.catch(() => {})
    return run
  }
}
// 지금 다시 감지해 auto.json에 쓰고 결과를 돌려준다. 감지가 실패하면 이전 값을 남기지 않는다 — 값 없는 결과(error 포함)를 쓴다.
export async function refreshAuto(stateDir, /** @type {{ detectFn?: typeof detect, onWriteError?: (err: Error) => void }} */ { detectFn = detect, onWriteError } = {}) {
  let r
  try { r = evaluate(await detectFn()) } catch (err) {
    r = { version: AUTO_VERSION, at: new Date().toISOString(), platform: platform(), values: {}, reasons: {}, lanes: [], summary: null, error: String(err?.message || err).slice(0, 200) }
  }
  try { writeAuto(stateDir, r) } catch (err) { onWriteError?.(err) }
  return r
}
