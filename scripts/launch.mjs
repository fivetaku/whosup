#!/usr/bin/env node
// install | preflight | start | stop | status | open — plugin.sh를 Node로 옮긴 것. 윈도우의 herdr가 셸 없이
// ["node", "scripts/launch.mjs", "<명령>"]로 부른다(herdr-plugin.toml의 windows 항목). macOS·리눅스는 지금처럼 plugin.sh를 쓴다
// (herdr가 최소 PATH로 부를 때 node를 찾아 주는 node-path.sh가 sh 쪽에 있어서다). 손으로 돌려도 된다: node scripts/launch.mjs status
// install은 윈도우의 build 훅이다: node 확인 뒤 설치에 이어지는 셋업(scripts/setup.mjs --install)을 돌린다(preflight.sh install과 같은 일).
// 윈도우 설치에서는 그 셋업이 감지하지도 묻지도 않고, herdr가 켜져 있으면 설치 뒤 보드를 띄울 도우미만 남긴다.
//
// 상태(pid·db·port·로그)는 herdr가 부를 때 HERDR_PLUGIN_STATE_DIR, 아니면 ~/.config/whosup.
// 보드가 떠 있는가는 "그 포트가 답한다"가 아니라 건강 응답의 이름과 이 설치의 표식으로 본다(src/paths.mjs boardReply): 보드가 죽은 뒤
// 다른 서버가 그 포트를 받아 200을 줘도, 다른 상태 폴더의 후즈업이 그 포트에 있어도 "이미 떠 있다"로 보지 않는다.
// stop은 끄기 전에 그 프로세스가 이 상태 폴더의 보드인지 본다: 보드가 답하면 그 답의 PID, 답하지 않으면 pid 파일의 PID — 다만 그 PID가
// 후즈업 보드가 아닌 것이 확인되면(재부팅·강제 종료 뒤 남은 번호를 다른 프로그램이 받았다) 끄지 않고 낡은 pid 파일만 치운다.
// 사용자 설정은 <설정 폴더>/.env의 KEY=VALUE 줄을 읽는다 — 셸로 실행하지 않는다(따옴표 한 겹만 벗기고 $ 펼치기·명령 실행 없음).
import { spawn, spawnSync } from 'node:child_process'
import { closeSync, openSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { configDirOf, stateDirOf } from '../src/paths.mjs'
import { boardReply, instanceOf } from '../src/paths.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

// .env 한 줄 = KEY=VALUE. 빈 줄·# 주석·앞의 export 는 넘긴다. 값 양끝의 같은 따옴표 한 겹만 벗긴다. 이름이 이상한 줄은 버린다.
export function parseEnvFile(text) {
  const out = {}
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (!m) continue
    let v = m[2]
    const q = v[0]
    if ((q === '"' || q === "'") && v.length >= 2 && v.endsWith(q)) v = v.slice(1, -1)
    else v = v.replace(/\s+#.*$/, '').trim()   // 따옴표 없는 값 뒤의 " # 주석"
    out[m[1]] = v
  }
  return out
}

export function paths(env = process.env) {
  const STATE = stateDirOf(env)   // 규칙은 src/paths.mjs 한곳(설치 때의 첫 실행 안내가 쓰는 곳·보드가 읽는 곳과 같다)
  const CONF = configDirOf(env)
  return { STATE, CONF, PID: join(STATE, 'server.pid'), LOG: join(STATE, 'server.log'), PORTF: join(STATE, 'port') }
}
// .env가 환경을 덮는다(plugin.sh의 set -a; . .env 와 같은 순서).
export function loadEnv(env = process.env) {
  const { CONF } = paths(env)
  let file = {}
  try { file = parseEnvFile(readFileSync(join(CONF, '.env'), 'utf8')) } catch {}
  return { ...env, ...file }
}

const readText = (f) => { try { return readFileSync(f, 'utf8').trim() } catch { return '' } }
export function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}
const sqliteOk = async () => { try { await (await import('../src/sqlite.mjs')).loadSqlite(); return true } catch { return false } }
const NEED_NODE = () => `whosup needs Node 22.13 or newer (found ${process.version}): node:sqlite is not available without flags.`
const recent = (file, ms = 15000) => { try { return Date.now() - statSync(file).mtimeMs < ms } catch { return false } }
// 실행 환경 확인(scripts/autoconf.mjs): 자동 값을 상태 폴더 auto.json에 쓴다. 따로 띄운 node로 돌려 .env를 합친 환경을 그대로 넘긴다.
// 실패해도 시작은 막지 않는다(기본값으로 뜬다). .env·설정은 건드리지 않는다. 설치(install) 때는 돌리지 않는다 — preflight·start에서만.
export function runAutoconf(env, STATE, log = console.log) {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'autoconf.mjs')], { cwd: ROOT, env: { ...env, WHOSUP_STATE_DIR: STATE }, encoding: 'utf8', timeout: 60000, windowsHide: true })
  if (r.status !== 0) { log(`whosup autoconf failed: starting with defaults${r.error ? ` (${r.error.message})` : ''}`); return false }
  log(String(r.stdout || '').trimEnd()); return true
}
// auto.json의 자동 값 하나(없으면 undefined).
const autoValue = (STATE, key) => { try { return JSON.parse(readFileSync(join(STATE, 'auto.json'), 'utf8')).values?.[key] } catch { return undefined } }
// 그 주소의 건강 응답(JSON 객체). 답이 없거나 200이 아니거나 JSON 객체가 아니면 null.
async function healthOf(url, timeoutMs = 2000) {
  try {
    const r = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    const body = await r.json()
    return body && typeof body === 'object' ? body : null
  } catch { return null }
}
// 그 PID의 프로세스가 후즈업 보드인가: 명령 줄에 보드의 진입점(bin/whosup.mjs — 실행기가 띄우는 모양)이 있는지 본다.
// 'yes' | 'no'(다른 프로그램인 것이 확인됐다) | 'unknown'(알 수 없다 — 윈도우, 명령 줄을 읽지 못함: 그때는 예전처럼 pid 파일을 믿는다).
// Linux는 /proc/<pid>/cmdline(ps가 없는 기계에도 있다), 그 밖에는 ps -o command=(macOS·Linux 공통 선택지).
export function boardProcess(pid, { platform = process.platform, read = readFileSync, run = spawnSync } = {}) {
  if (platform === 'win32' || !Number.isInteger(pid) || pid <= 1) return 'unknown'
  let cmd = ''
  if (platform === 'linux') { try { cmd = String(read(`/proc/${pid}/cmdline`, 'utf8')).replace(/\0/g, ' ').trim() } catch {} }
  if (!cmd) {
    try {
      const r = run('ps', ['-ww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
      if (r.status === 0) cmd = String(r.stdout || '').trim()
    } catch {}
  }
  if (!cmd) return 'unknown'
  return /(^|[\\/\s])whosup\.mjs(\s|$)/.test(cmd) ? 'yes' : 'no'
}
// pid 파일(<상태 폴더>/server.pid)이 가리키는 이 상태 폴더의 보드: 살아 있고, 다른 프로그램인 것이 확인되지 않은 PID. 없으면 0.
export function filedBoardPid(stateDir) {
  const pid = Number(readText(join(stateDir, 'server.pid')))
  return pidAlive(pid) && boardProcess(pid) !== 'no' ? pid : 0
}
// 그 주소에서 답하는 것이 이 상태 폴더의 보드인가: { url, pid }(pid = 답에 실린 보드의 PID. 이름·표식을 싣기 전 판의 보드면 0) 또는 null.
// 이전 버전의 보드(건강 응답에 이름이 없다)는 pid 파일의 프로세스가 살아 있는 보드일 때만 받는다.
export async function boardAt(url, stateDir, { timeoutMs = 2000 } = {}) {
  const body = await healthOf(url, timeoutMs)
  const kind = boardReply(body, stateDir)
  if (kind === 'board') return { url, pid: Number.isInteger(body.pid) && body.pid > 1 ? body.pid : 0 }
  return kind === 'legacy' && filedBoardPid(stateDir) ? { url, pid: 0 } : null
}

// noBrowser: 이번 start에서는 브라우저를 열지 않는다(.env의 OPEN_BROWSER보다 먼저 본다) — 단독 설치의 로그인 자동 실행과
// 업데이트 뒤 재시작이 쓴다(scripts/standalone.mjs). 직접 고른 open은 그대로 연다.
export async function main(cmd = 'status', env0 = process.env, log = console.log, { noBrowser = false } = {}) {
  const env = loadEnv(env0)
  const { STATE, PID, LOG, PORTF } = paths(env)
  // 설치(build 훅) 때는 herdr가 상태 폴더를 알려 주지 않는다 — 그때 ~/.config/whosup을 만들어 두지 않는다.
  if (cmd !== 'install') mkdirSync(STATE, { recursive: true })
  const PORT = env.PORT || '4790'
  let URL_ = `http://127.0.0.1:${PORT}`
  // pid 파일의 프로세스가 살아 있는 보드인가(다른 프로그램이 그 번호를 받은 것이 확인되면 아니다)
  const alive = () => Boolean(filedBoardPid(STATE))
  // 4790이 차 있으면 whosup은 다음 포트로 뜨고 $STATE/port에 적는다 — 그 포트를 먼저 본다.
  // 답한 것이 이 상태 폴더의 보드일 때만 떠 있는 것이다(boardAt). board = 그 보드({ url, pid }), 없으면 null.
  let board = null
  const healthy = async () => {
    const p = readText(PORTF)
    board = (/^\d{1,5}$/.test(p) ? await boardAt(`http://127.0.0.1:${p}`, STATE) : null) || await boardAt(`http://127.0.0.1:${PORT}`, STATE)
    if (board) URL_ = board.url
    return Boolean(board)
  }
  const openBrowser = (force = false) => {
    if (noBrowser && !force) return
    // 환경변수·.env > 자동 감지(원격이면 0) > 1
    if (String(env.OPEN_BROWSER ?? autoValue(STATE, 'open_browser') ?? '1') !== '1') return
    if (recent(join(STATE, 'board-heartbeat'))) return            // 이 보드를 보는 탭이 15초 안에 신호를 보냈다
    if (!force && recent(join(STATE, 'board-connected'))) return  // herdr 시작 때: 가려진 탭이라도 붙어 있으면 새로 열지 않는다
    let how = null
    if (process.platform === 'win32') how = ['explorer.exe', [URL_]]
    else if (process.platform === 'darwin') { if (!env.SSH_CONNECTION) how = ['/usr/bin/open', [URL_]] }
    else if (env.DISPLAY || env.WAYLAND_DISPLAY) how = ['xdg-open', [URL_]]
    if (!how) return
    const child = spawn(how[0], how[1], { detached: true, stdio: 'ignore', windowsHide: true })
    child.once('error', (err) => console.error(`whosup: could not open the browser: ${err.message}`))
    child.unref()
  }

  switch (cmd) {
    case 'install': {
      // 윈도우 build 훅. auto.json은 쓰지 않는다(시작 때 상태 폴더에 쓴다). 셋업은 따로 띄운 node가 돌린다. 윈도우에서는 herdr가 build를
      // 보이지 않는 콘솔에서 돌려 질문이 사용자에게 닿지 않으므로 묻지 않고 자동 시작만 한다(보드의 첫 실행 안내가 묻는다 — src/setup.mjs openTerminal).
      // 여기서 process.ppid는 설치 명령(herdr)이다 — 그것이 끝난 뒤 보드를 띄운다.
      // 셋업이 어떤 이유로 실패해도 설치는 막지 않는다(셋업은 질문마다 시간 제한이 있어 스스로 끝난다).
      if (!(await sqliteOk())) { log(NEED_NODE()); return 1 }
      log(`node ${process.version} ok`)
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'setup.mjs'), '--install'], { cwd: ROOT, env: { ...env0, WHOSUP_INSTALLER_PID: String(process.ppid) }, stdio: 'inherit', windowsHide: true })
      if (r.status !== 0) log(`whosup setup did not finish: the board asks on first open${r.error ? ` (${r.error.message})` : ''}`)
      return 0
    }
    case 'preflight': {
      if (!(await sqliteOk())) { log(NEED_NODE()); return 1 }
      log(`node ${process.version} ok`)
      runAutoconf(env, STATE, log)   // 손으로 돌려 확인할 때: 감지 결과를 보여 주고 상태 폴더 auto.json에 쓴다
      return 0
    }
    case 'start': {
      if (await healthy()) { log(`whosup already listening at ${URL_}`); openBrowser(); return 0 }
      // 기록된 whosup이 살아 있는데 답하지 않으면 새로 띄우지 않는다 — pid 파일을 덮어쓰면 그 프로세스가 고아가 된다.
      if (alive()) { log(`whosup pid ${readText(PID)} is running but not answering — run stop first, see ${LOG}`); return 1 }
      if (!(await sqliteOk())) { log(NEED_NODE()); return 1 }
      runAutoconf(env, STATE, () => {})   // 서버를 띄우기 전에 auto.json을 새로 쓴다(서버가 시작할 때 읽는다)
      const fd = openSync(LOG, 'a')
      // startup 훅은 한 번 실행되고 끝나는 명령이다: whosup은 떼어 내서(detached + unref) 훅이 끝나도 살아 있게 한다.
      // 윈도우에서 herdr가 훅이 끝날 때 자식까지 끝내는지는 실기기에서 확인할 것(doctor의 손 확인 항목).
      const child = spawn(process.execPath, [join(ROOT, 'bin', 'whosup.mjs')], { cwd: ROOT, env: { ...env, WHOSUP_STATE_DIR: STATE, PORT }, detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
      let spawnErr = null
      child.once('error', (err) => { spawnErr = err })
      child.unref()
      closeSync(fd)
      for (let i = 0; i < 40 && !spawnErr; i++) { if (await healthy()) break; if (!pidAlive(child.pid)) break; await sleep(250) }
      if (!spawnErr && await healthy()) {
        // 같은 상태 폴더의 다른 whosup이 이미 답하고 있으면 방금 띄운 것은 스스로 끝난다 — 그때는 pid 파일을 건드리지 않는다.
        if (pidAlive(child.pid)) writeFileSync(PID, String(child.pid))
        log(`whosup listening at ${URL_}`); openBrowser(); return 0
      }
      // 실패로 끝낼 때는 방금 띄운 프로세스를 남기지 않는다.
      try { if (child.pid) process.kill(child.pid) } catch {}
      log(`whosup failed to start — see ${LOG}${spawnErr ? ` (${spawnErr.message})` : ''}`)
      log(readText(LOG).split('\n').slice(-5).join('\n'))
      return 1
    }
    case 'stop': {
      // 끌 프로세스: 이 상태 폴더의 보드가 답하면 그 답에 실린 PID(pid 파일이 없거나 낡았어도 그 보드를 끈다), 답하지 않으면 pid 파일의 PID.
      // pid 파일의 번호가 살아 있어도 후즈업 보드가 아닌 것이 확인되면 끄지 않는다(남의 프로세스다) — 낡은 pid 파일만 치운다.
      // 답에 실린 PID도 그대로 믿지 않는다: 그 프로세스가 보드가 아닌 것이 확인되면(답을 흉내 낸 서버가 남의 PID를 댔다) 쓰지 않는다.
      const answered = (await healthy()) && board.pid && boardProcess(board.pid) !== 'no' ? board.pid : 0
      const pid = answered || filedBoardPid(STATE)
      if (!pid) {
        if (readText(PID)) { try { unlinkSync(PID) } catch {} }
        log('whosup not running'); return 0
      }
      // 윈도우에서 process.kill은 곧바로 끝낸다(TerminateProcess) — whosup의 exit 처리는 돌지 않지만, 창 도우미(PowerShell)는
      // 표준 입력이 닫히면 스스로 끝나고 SQLite 잠금은 OS가 푼다(REPORT 20번).
      try { process.kill(pid, 'SIGTERM') } catch {}
      for (let i = 0; i < 20 && pidAlive(pid); i++) await sleep(250)
      if (pidAlive(pid)) { log(`still running pid=${pid}`); return 1 }
      try { unlinkSync(PID) } catch {}
      log('whosup stopped'); return 0
    }
    case 'status': {
      if (await healthy()) { log(`whosup listening at ${URL_} (pid ${board.pid || readText(PID) || '?'})`); return 0 }
      log('whosup not running'); return 1
    }
    case 'open': {
      if (!(await healthy())) { log('whosup not running — start it first'); return 1 }
      env.OPEN_BROWSER = '1'
      openBrowser(true); log(`opened ${URL_}`); return 0
    }
    // scripts/plugin.sh가 묻는다: 이 상태 폴더의 보드가 건강 응답에 싣는 표식(src/paths.mjs instanceOf — 계산은 한곳에서만 한다)
    case 'instance': log(instanceOf(STATE)); return 0
    default: log('usage: launch.mjs install|preflight|start|stop|status|open'); return 2
  }
}

// 직접 실행했는가: import.meta.url은 실제 경로라서, 심볼릭 링크가 낀 경로로 불러도 맞게 푼 뒤 비교한다.
const realOf = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) process.exitCode = await main(process.argv[2] || 'status')
