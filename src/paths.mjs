// 설정 폴더·상태 폴더를 고르는 규칙 한곳: herdr가 플러그인으로 부를 때는 herdr가 알려 준 폴더, 아니면 ~/.config/whosup.
// 쓰는 쪽(src/setup.mjs의 손 실행), 읽는 쪽(setupFilePath → bin/whosup.mjs), 실행기(scripts/launch.mjs paths())가 같은 함수를 쓴다.
// home은 시험이 갈아 끼운다(기본은 os.homedir() — POSIX는 $HOME, 윈도우는 USERPROFILE).
import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, posix, resolve, win32 } from 'node:path'

export const ownDir = (home = homedir()) => join(home, '.config', 'whosup')
export const configDirOf = (env = process.env, home = homedir()) => env.HERDR_PLUGIN_CONFIG_DIR || ownDir(home)
export const stateDirOf = (env = process.env, home = homedir()) => env.HERDR_PLUGIN_STATE_DIR || ownDir(home)

// ── 단독 설치(herdr 없이 — install.sh의 standalone 길) ──
// 앱: <XDG_DATA_HOME 또는 ~/.local/share>/whosup/app · 설정: ~/.config/whosup · 상태: <XDG_STATE_HOME 또는 ~/.local/state>/whosup.
// 단, ~/.config/whosup에 whosup.db가 이미 있으면(폴더에서 손으로 띄워 쓰던 사람) 상태 폴더를 옮기지 않고 그 폴더를 그대로 쓴다 —
// 새 상태 폴더에 이미 whosup.db가 생긴 뒤에는 새 폴더가 이긴다. 실행 명령(scripts/standalone.mjs)이 이 두 폴더를
// HERDR_PLUGIN_CONFIG_DIR·HERDR_PLUGIN_STATE_DIR에 채워 위의 규칙(configDirOf·stateDirOf)을 그대로 쓴다.
//
// XDG 폴더 값은 절대 경로일 때만 쓴다(XDG 명세: 상대 경로는 무시한다 — XDG_DATA_HOME=. 이면 지금 폴더에 깔린다). 제어 문자가 든 값도
// 무시한다. 그때는 없는 것으로 보고 기본값을 쓴다(install.sh의 abs_dir과 같은 판정).
// abs = 절대 경로 판정: 기본은 이 기계의 것. 다른 플랫폼의 경로를 계산하는 쪽(src/setup.mjs herdrPluginDirs)이 그 플랫폼의 것을 넘긴다.
export const xdgDir = (v, abs = isAbsolute) => (typeof v === 'string' && abs(v) && !/[\u0000-\u001f\u007f]/.test(v) ? v : '')

// ── herdr 자신의 폴더(규칙으로 계산): herdr 소스 src/config/io.rs·src/plugin_paths.rs(0.9.5) ──
// <config> = XDG_CONFIG_HOME/herdr | 윈도우 %APPDATA%\herdr (없으면 %USERPROFILE%\AppData\Roaming\herdr) | ~/.config/herdr
// <state>  = XDG_STATE_HOME/herdr  | 윈도우 %LOCALAPPDATA%\herdr (없으면 %USERPROFILE%\AppData\Local\herdr) | ~/.local/state/herdr
// config.toml은 <config> 바로 아래, 플러그인 폴더는 그 아래 plugins/ (src/setup.mjs herdrPluginDirs).
export function herdrDirs(env = process.env, platform = process.platform, home = homedir()) {
  const win = platform === 'win32'
  const P = win ? win32 : posix
  const h = env.HOME || home
  const xdgConfig = xdgDir(env.XDG_CONFIG_HOME, P.isAbsolute), xdgState = xdgDir(env.XDG_STATE_HOME, P.isAbsolute)
  const config = xdgConfig ? P.join(xdgConfig, 'herdr')
    : win && env.APPDATA ? P.join(env.APPDATA, 'herdr')
    : win && env.USERPROFILE ? P.join(env.USERPROFILE, 'AppData', 'Roaming', 'herdr')
    : P.join(h, '.config', 'herdr')
  const state = xdgState ? P.join(xdgState, 'herdr')
    : win && env.LOCALAPPDATA ? P.join(env.LOCALAPPDATA, 'herdr')
    : win && env.USERPROFILE ? P.join(env.USERPROFILE, 'AppData', 'Local', 'herdr')
    : P.join(h, '.local', 'state', 'herdr')
  return { config, state }
}
// 설치 기록(<데이터 폴더>/install.json)에 적힌 폴더: scripts/standalone.mjs가 앱 폴더 옆의 기록을 읽어 이 세 이름으로 환경에 채운다
// (사람이 정하는 값이 아니다). 채워져 있으면 XDG 값보다 먼저다 — 설치한 뒤 다른 환경에서 불러도(로그인 항목·다른 셸) 같은 폴더를 쓴다.
export const PIN_KEYS = { data: 'WHOSUP_PIN_DATA', conf: 'WHOSUP_PIN_CONF', state: 'WHOSUP_PIN_STATE' }
export const dataDirOf = (env = process.env, home = homedir()) => xdgDir(env[PIN_KEYS.data]) || join(xdgDir(env.XDG_DATA_HOME) || join(home, '.local', 'share'), 'whosup')
export function standaloneDirs(env = process.env, home = homedir(), exists = existsSync) {
  const conf = xdgDir(env[PIN_KEYS.conf]) || ownDir(home)
  const fresh = join(xdgDir(env.XDG_STATE_HOME) || join(home, '.local', 'state'), 'whosup')
  const state = xdgDir(env[PIN_KEYS.state]) || (exists(join(conf, 'whosup.db')) && !exists(join(fresh, 'whosup.db')) ? conf : fresh)
  return { conf, state, fresh }
}

// ── 보드 살아 있음 확인 ──
// "그 포트가 답한다"만으로는 후즈업 보드인지 알 수 없다(보드가 죽은 뒤 다른 서버가 그 포트를 받았을 수 있다). 보드의 건강 응답(/api/health)이
// 이름(app)과 이 설치의 표식(instance), 자기 PID를 싣고, 실행기(scripts/launch.mjs · scripts/plugin.sh) · 단독 설치(src/standalone.mjs boardNow)
// · 설치기(install.sh의 PLUGIN_BOARD_JS)가 그 값으로 판단한다.
// 표식 = 상태 폴더의 경로(링크를 푼 것)에서 만든 글자: 보드는 상태 폴더마다 하나이고(src/db.mjs acquireLock), 묻는 쪽도 어느 상태 폴더의
// 보드를 찾는지 안다. 경로를 그대로 싣지 않는다(sh에서도 견줄 수 있는 짧은 글자). install.sh의 PLUGIN_BOARD_JS가 같은 계산을 한다 — 둘을 같게 둔다.
export const BOARD_APP = 'whosup'
export function instanceOf(stateDir) {
  let dir = resolve(String(stateDir))
  try { dir = realpathSync(dir) } catch {}
  return createHash('sha256').update(dir).digest('hex').slice(0, 16)
}
// 건강 응답이 그 상태 폴더의 보드가 보낸 것인가. 맞으면 'board', 이름·표식을 싣기 전 판의 보드가 보낸 모양이면 'legacy'(부른 쪽이 pid 파일로
// 한 번 더 확인한다 — 새 버전으로 바꾼 직후에는 이전 버전의 보드가 아직 돌고 있다), 아니면 null(다른 서버이거나 다른 상태 폴더의 보드).
export function boardReply(body, stateDir) {
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.ok !== true) return null
  if ('app' in body || 'instance' in body) return body.app === BOARD_APP && body.instance === instanceOf(stateDir) ? 'board' : null
  return typeof body.readonly === 'boolean' && Array.isArray(body.targets) ? 'legacy' : null
}
