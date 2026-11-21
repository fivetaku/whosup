// 설치기(install.sh) 시험의 격리 환경: 임시 HOME, 좁은 PATH, 가짜 herdr·herdr 설치 명령·launchctl·systemctl, 빈 포트.
// test/install.test.mjs(길 선택)와 test/install-standalone.test.mjs(단독 설치)가 같이 쓴다 — 두 파일로 나눠 병렬로 돈다.
// 실제 herdr·launchctl·systemctl·네트워크·브라우저에 닿지 않는다:
//   - PATH는 <임시>/bin:/usr/bin:/bin 뿐이고 WHOSUP_EXTRA_PATH=''(덧붙이는 폴더 없음) — 이 기계의 herdr·hc를 찾지 않는다.
//   - herdr = test-support/fake-herdr-install.mjs를 감싼 실행 파일, herdr 설치 명령 = 그 실행 파일을 ~/.local/bin에 놓는 스크립트,
//     launchctl·systemctl = 받은 인자를 파일에 적는 스크립트, herdr-core = test-support/fake-core.mjs의 소켓.
//   - 소스는 내려받지 않고 이 저장소 폴더(WHOSUP_INSTALL_SOURCE), 보드 포트는 48100~48799에서 빈 것을 골라 쓴다(시험마다 다르다).
//   - 설치기는 제어 터미널 없이 돈다(detached) — 에이전트가 설치하는 경우와 같다. 터미널에서의 질문은 test/standalone.test.mjs가 본다.
import { execFileSync, spawn } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer as netServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { startFakeCore } from './fake-core.mjs'
import { shown, shq } from '../src/standalone.mjs'

export const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '')
export const INSTALL = join(ROOT, 'install.sh')
const FAKE_HERDR = join(ROOT, 'test-support', 'fake-herdr-install.mjs')
const BOARD_PID_IMPORT = pathToFileURL(join(ROOT, 'test-support', 'install-board-pid.mjs')).href
export const ID = 'fivetaku.whosup'
export const posix = { skip: process.platform === 'win32' ? '윈도우에는 sh가 없다' : false }
// 설치기를 돌릴 셸: 기본은 /bin/sh. WHOSUP_TEST_SH=/bin/dash 처럼 주면 그 셸로 돌리고, 설치기가 안에서 부르는 sh도 그 셸이 되게
// <임시>/bin/sh 링크를 둔다(POSIX sh 확인용 — 설치기 시험 전체를 dash로 한 번 돌릴 때 쓴다).
export const SH = process.env.WHOSUP_TEST_SH || '/bin/sh'
export const mac = process.platform === 'darwin'
// 스크립트 글자에 경로를 넣을 때: sh의 한 낱말로 싼다(작은따옴표 — src/standalone.mjs shq). 임시 폴더 이름에 공백·작은따옴표·$ 가 있어도 깨지지 않는다.
export { shq }

// 48100~48799에서 지금 비어 있는 포트(보드는 차 있으면 다음 포트로 넘어가므로 바로 다음 것도 본다).
// 짝수 p와 p+1을 한 쌍으로, 동시에 도는 다른 시험 파일(다른 프로세스)과 겹치지 않게 <임시>/whosup-test-ports/<p>를 배타적으로 만들어
// 예약하고 이 프로세스가 끝날 때 푼다. 예약 없이 비었는지만 보면, 두 파일이 같은 포트를 골라 보드가 다음 포트에 뜨고 시험이
// 흔들렸다(2026-11-20: 48510을 기대했는데 48511).
const canBind = (port) => new Promise((resolve) => { const s = netServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))) })
// 예약 폴더는 사용자마다 따로 둔다(공유 /tmp에서 다른 사용자의 폴더에 쓸 수 없어 시험이 멈추지 않게).
// 남의 예약은 주인이 죽었어도 지우지 않고 건너뛴다 — 두 프로세스가 같은 묵은 예약을 동시에 걷으면 한쪽이 다른 쪽의 새 예약을
// 지울 수 있다. 묵은 예약은 SIGKILL로 끝난 시험만 남기고(신호·정상 종료는 푼다) 쌍은 345개다.
const PORTS = join(tmpdir(), `whosup-test-ports-${process.getuid?.() ?? 'user'}`)
const held = new Set()
const reserve = (p) => {
  const f = join(PORTS, String(p))
  mkdirSync(PORTS, { recursive: true, mode: 0o700 })
  try { writeFileSync(f, String(process.pid), { flag: 'wx' }); held.add(f); return f } catch (e) {
    if (/** @type {any} */ (e).code === 'EEXIST') return null
    throw e
  }
}
const unreserve = (f) => { held.delete(f); rmSync(f, { force: true }) }
export async function freePort() {
  for (let i = 0; i < 400; i++) {
    const p = 48100 + 2 * Math.floor(Math.random() * 345)
    const f = reserve(p)
    if (!f) continue
    if (await canBind(p) && await canBind(p + 1)) return p
    unreserve(f)
  }
  throw new Error(`no free port in 48100-48799 (reservations: ${PORTS} — remove it when no tests are running)`)
}
export const exe = (file, text) => { writeFileSync(file, text); chmodSync(file, 0o755); return file }
export const lines = (file) => { try { return readFileSync(file, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
// 폴더 아래의 모든 경로(폴더 포함, 그 폴더 기준 상대 경로)
export const walk = (dir, base = dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => { const p = join(dir, e.name); return [p.slice(base.length + 1), ...(e.isDirectory() ? walk(p, base) : [])] }).sort()

// 임시 폴더(wsi-*)는 이 시험 프로세스가 끝날 때 지운다 — 통과·실패·신호(SIGINT·SIGTERM·SIGHUP)로 멈춘 경우 모두.
// 하나가 약 2MB(설치된 앱 사본)라 남기면 쌓인다(2026-11-14: 사흘 반 동안 8,600개 17.6GB가 남아 디스크가 찼다).
// WHOSUP_KEEP_TMP=1 이면 지우지 않는다(실패한 시험의 폴더를 들여다볼 때). SIGKILL로 죽으면 지우지 못한다.
const KEEP_TMP = process.env.WHOSUP_KEEP_TMP === '1'
const made = new Set()
const wipe = (dir) => rmSync(dir, { recursive: true, force: true })
// 시험이 읽기 전용으로 바꿔 둔 폴더(chmod 0500)에서 멈췄으면 지워지지 않는다 — 폴더 권한을 되돌리고 한 번 더 지운다.
const unlock = (dir) => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlock(join(dir, e.name)) } catch {} }
const sweep = () => { for (const dir of made) { try { wipe(dir) } catch { try { unlock(dir); wipe(dir) } catch {} } } made.clear() }
// 설치한 보드를 끝낸다. 보드는 새 세션(detached)에 뜨므로, 시험이 stop 전에 실패하거나 신호로 멈추면 폴더만 지워지고
// 보드는 남았다(2026-11-17~20: 야간 회귀가 120초에서 시험을 SIGTERM으로 끊을 때마다 보드 하나씩).
// 끝낼 대상은 이 프로세스가 만든 폴더 안의 server.pid 또는 시험 전용 .board-pids 장부가 가리키고, 작업 폴더(cwd)도
// 그 폴더 안인 프로세스뿐이다 — 명령 줄을 훑지 않으므로 그 파일을 연 편집기·tail을 건드리지 않고, 죽은 보드의 PID를 다른 프로그램이
// 다시 쓰고 있어도(작업 폴더가 다르다) 끝내지 않는다. 윈도우는 설치기 시험을 돌리지 않는다(posix).
const pidFiles = (dir, depth = 0) => {
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return [] }
  return ents.flatMap((e) => {
    const p = join(dir, e.name)
    if (e.isFile() && e.name === 'server.pid') return [p]
    return e.isDirectory() && depth < 6 && !['app', 'node_modules', '.git'].includes(e.name) ? pidFiles(p, depth + 1) : []
  })
}
const cwdOf = (pid) => {
  try { return readlinkSync(`/proc/${pid}/cwd`) } catch {}
  try { return execFileSync('lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], { encoding: 'utf8' }).split('\n').find((l) => l.startsWith('n'))?.slice(1) ?? '' } catch { return '' }
}
// 작업 폴더는 이 프로세스가 만든 폴더 어느 것 안이면 된다(다른 폴더의 보드 흉내를 한 rig의 server.pid에 적는 시험이 있다).
const reap = () => {
  if (process.platform === 'win32' || made.size === 0) return
  const roots = [...made].flatMap((d) => { try { return [d, realpathSync(d)] } catch { return [d] } })
  for (const dir of made) {
    const pids = [...pidFiles(dir).map((f) => lines(f)[0]), ...lines(join(dir, '.board-pids'))]
    for (const pid of new Set(pids.map(Number))) {
      if (!(pid > 1) || pid === process.pid) continue
      const cwd = cwdOf(pid)
      if (cwd && roots.some((r) => cwd === r || cwd.startsWith(`${r}/`))) { try { process.kill(pid, 'SIGKILL') } catch {} }
    }
  }
}
const finish = () => { reap(); for (const f of held) unreserve(f); if (!KEEP_TMP) sweep() }
process.once('exit', finish)
// 신호를 받으면 정리한 뒤 같은 신호를 다시 보낸다 — 이 프로세스가 끝나는 방식(신호로 죽음)은 그대로다.
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { finish(); process.kill(process.pid, sig) })
// 시험이 rig() 밖에서 만든 임시 폴더도 같은 정리에 넣는다.
export const track = (dir) => { made.add(dir); return dir }

// 시험 하나의 격리 환경: <임시>/h = HOME, <임시>/bin = PATH에 올릴 가짜 실행 파일.
export async function rig({ node = true, herdr = false } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'wsi-'))
  made.add(base)
  const home = join(base, 'h'), bin = join(base, 'bin')
  for (const d of [home, bin, join(base, 'run'), join(base, 't')]) mkdirSync(d)
  if (node) symlinkSync(process.execPath, join(bin, 'node'))
  if (SH !== '/bin/sh') symlinkSync(SH, join(bin, 'sh'))
  const herdrText = `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_HERDR)} "$@"\n`
  if (herdr) exe(join(bin, 'herdr'), herdrText)
  // herdr 설치 명령 대신 돌릴 스크립트: 공식 설치 스크립트처럼 ~/.local/bin/herdr 한 파일을 놓는다.
  writeFileSync(join(base, 'herdr-wrapper'), herdrText)
  exe(join(base, 'get-herdr.sh'), `#!/bin/sh\nmkdir -p "$HOME/.local/bin" && cp ${shq(join(base, 'herdr-wrapper'))} "$HOME/.local/bin/herdr" && chmod 755 "$HOME/.local/bin/herdr" || exit 1\necho "installed herdr to $HOME/.local/bin/herdr"\n`)
  // launchctl·systemctl 대신: 받은 인자를 적는다. 서비스 관리자의 상태를 파일로 흉내 낸다 —
  //   enable·disable·is-enabled(<기록>.enabled) · enable --now·start·stop·is-active(<기록>.active) · bootstrap·bootout·print(<기록>.loaded).
  // FAKE_CTL_FAIL=<낱말>: 그 낱말이 든 호출은 적은 뒤 1로 끝낸다(bootstrap 실패 등).
  const ctl = exe(join(bin, 'fake-ctl'), [
    '#!/bin/sh',
    'printf \'%s\\n\' "$*" >> "$FAKE_CTL_LOG"',
    'if [ -n "${FAKE_CTL_FAIL:-}" ]; then case " $* " in *" $FAKE_CTL_FAIL "*) exit 1 ;; esac; fi',
    'case " $* " in',
    '  *" enable "*) : > "$FAKE_CTL_LOG.enabled"; case " $* " in *" --now "*) : > "$FAKE_CTL_LOG.active" ;; esac ;;',
    '  *" disable "*) rm -f "$FAKE_CTL_LOG.enabled" ;;',
    '  *" is-enabled "*) [ -f "$FAKE_CTL_LOG.enabled" ] || exit 1 ;;',
    '  *" is-active "*) [ -f "$FAKE_CTL_LOG.active" ] || exit 3 ;;',
    '  *" start "*) : > "$FAKE_CTL_LOG.active" ;;',
    '  *" stop "*) rm -f "$FAKE_CTL_LOG.active" ;;',
    '  *" bootstrap "*) : > "$FAKE_CTL_LOG.loaded" ;;',
    '  *" bootout "*) [ -f "$FAKE_CTL_LOG.loaded" ] || exit 3; rm -f "$FAKE_CTL_LOG.loaded" ;;',
    '  *" print "*) [ -f "$FAKE_CTL_LOG.loaded" ] || exit 113 ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'))
  const port = await freePort()
  const r = {
    base, home, bin, port, herdrLog: join(base, 'herdr.log'), ctlLog: join(base, 'ctl.log'),
    data: join(home, '.local', 'share', 'whosup'), record: join(home, '.local', 'share', 'whosup', 'install.json'),
    app: join(home, '.local', 'share', 'whosup', 'app'), launcher: join(home, '.local', 'bin', 'whosup'),
    conf: join(home, '.config', 'whosup'), state: join(home, '.state', 'whosup'),
    plist: join(home, 'Library', 'LaunchAgents', 'dev.whosup.board.plist'), unit: join(home, '.config', 'systemd', 'user', 'whosup.service'),
    getHerdr: `sh ${shq(join(base, 'get-herdr.sh'))}`,
  }
  r.loginFile = mac ? r.plist : r.unit
  r.env = (over = {}) => ({
    HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.state'), XDG_RUNTIME_DIR: join(base, 'run'), TMPDIR: join(base, 't'),
    // SHELL을 정해 둔다: 비워 두면 sh(bash)가 이 기계 사용자의 로그인 셸로 채워, PATH 안내의 설정 파일 이름이 기계마다 달라진다
    PATH: `${bin}:/usr/bin:/bin`, SHELL: '/bin/sh', WHOSUP_EXTRA_PATH: '', WHOSUP_LANG: 'en', OPEN_BROWSER: '0', PORT: String(port),
    WHOSUP_INSTALL_SOURCE: ROOT, WHOSUP_HERDR_INSTALL_CMD: 'false', WHOSUP_LAUNCHCTL: ctl, WHOSUP_SYSTEMCTL: ctl, FAKE_CTL_LOG: r.ctlLog,
    FAKE_HERDR_LOG: r.herdrLog, FAKE_HERDR_REGISTRY: join(base, 'plugins.txt'),
    // 보드가 herdr를 찾지 않게(없는 경로) · 수집 주기를 늘려 조용하게
    HERDR_BIN_PATH: join(base, 'none', 'herdr'), HERDR_BIN: join(base, 'none', 'herdr'), WHOSUP_INTERVAL: '60', WHOSUP_NO_EVENTS: '1',
    NODE_OPTIONS: `--import=${BOARD_PID_IMPORT}`, WHOSUP_TEST_BOARD_PIDS: join(base, '.board-pids'),
    ...over,
  })
  // 명령을 제어 터미널 없이 돌린다(detached = 새 세션). input을 주면 표준 입력으로 흘린다(curl | sh 흉내).
  // 값이 undefined인 환경변수는 넘기지 않는다(PATH가 없는 환경 등). onSpawn = 띄운 프로세스를 받는다(도는 중에 신호를 보내는 시험).
  r.run = (file, args = [], over = {}, { input = null, onSpawn = null } = {}) => new Promise((resolve, reject) => {
    const env = Object.fromEntries(Object.entries(r.env(over)).filter(([, v]) => v !== undefined))
    const child = spawn(file, args, { env, cwd: base, detached: true, stdio: [input === null ? 'ignore' : 'pipe', 'pipe', 'pipe'] })
    onSpawn?.(child)
    let out = '', err = ''
    child.stdout.on('data', (c) => { out += c }); child.stderr.on('data', (c) => { err += c })
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} reject(new Error(`timed out: ${file} ${args.join(' ')}\n${out}\n${err}`)) }, 90000)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out, err, all: `${out}${err}` }) })
    if (input !== null) { child.stdin.on('error', () => {}); child.stdin.end(input) }
  })
  r.install = (over = {}, opts) => r.run(SH, [INSTALL], over, opts)
  r.whosup = (args, over = {}) => r.run(r.launcher, args, over)
  r.herdrCalls = () => lines(r.herdrLog).map((l) => JSON.parse(l)).filter(Array.isArray).map((a) => a.join(' '))
  r.ctlCalls = () => lines(r.ctlLog)
  r.pid = (dir = r.state) => Number(lines(join(dir, 'server.pid'))[0] || 0)
  r.health = async (p = lines(join(r.state, 'port'))[0] || port) => { try { return (await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(2000) })).ok } catch { return false } }
  // 남긴 보드를 끈다(시험이 실패해도).
  r.cleanup = () => { for (const dir of [r.state, r.conf]) { const pid = r.pid(dir); if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch {} } } }
  return r
}
export const summaryOf = (out) => out.slice(out.indexOf('whosup install summary'))
// 경로를 정규식에 넣을 때: 글자 그대로 맞춘다. shownRx = 요약에 적힌 모양(공백·한글 등이 든 경로는 작은따옴표로 싸인다 — src/standalone.mjs shown).
// 임시 폴더 이름에 ASCII가 아닌 글자·공백이 있어도 시험이 같은 것을 본다.
export const rx = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
export const shownRx = (s) => rx(shown(s))
// 살아 있는 가짜 herdr-core: 상태 폴더의 <세션>/core.lock이 소켓을 가리킨다(세션 이름은 default가 아니어도 된다).
export async function liveCore(r, session = 'appcore') {
  const core = await startFakeCore(join(r.base, 'c.sock'))
  const dir = join(r.home, '.state', 'herdr-core', session)
  mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'core.lock'), `${core.path}\n`)
  return core
}
