// 단독 설치(herdr 없이 — install.sh의 standalone 길)의 부품: 폴더 배치, 설치 기록, 실행 명령(~/.local/bin/whosup),
// 로그인할 때 자동으로 켜기(macOS LaunchAgent · Linux systemd --user), 제거, 설치 요약에 실을 지금 상태.
// 명령 줄은 scripts/standalone.mjs, 사람이 치는 입구는 scripts/standalone.sh(실행 명령과 로그인 항목이 같이 부른다).
//
// 지키는 것:
//  - herdr를 부르지 않는다. 보드는 herdr-core의 세션을 스스로 읽는다(src/runtime/core.mjs).
//  - 폴더 규칙은 src/paths.mjs 한곳(dataDirOf·standaloneDirs). 여기서는 그 두 폴더를 HERDR_PLUGIN_CONFIG_DIR·HERDR_PLUGIN_STATE_DIR에
//    채워 기존 스크립트(scripts/launch.mjs·setup.mjs·autoconf.mjs, bin/whosup.mjs)를 그대로 쓴다.
//  - launchctl·systemctl은 인자 배열로만 부르고, 시험이 갈아 끼운다(WHOSUP_LAUNCHCTL·WHOSUP_SYSTEMCTL 또는 run 주입).
//  - 등록 실패는 설치 실패가 아니다: 결과(state)만 돌려주고 던지지 않는다.
//  - 윈도우(win32)는 지원하지 않는다: 아무것도 쓰지 않고 'unsupported'를 돌려준다(sh가 없어 install.sh가 깔 수 없다).
//  - 지우는 폴더는 이름에 whosup이 든 절대 경로(guarded)이면서, 앱 폴더는 설치기의 표식(APP_MARK_FILE)이 든 것, 설정·상태 폴더는
//    설치 기록(install.json)에 적힌 것뿐이다. 그 자리에 있는 남의 폴더는 지우지 않는다.
//  - "단독 설치가 있다"는 설치 기록과 표식이 한 쌍으로 맞을 때뿐이다(readRecord — install.sh의 RECORD_JS와 같은 조건).
//  - 설치기와 같은 잠금(takeLock — <데이터 폴더>/install.lock, 주인의 PID)을 제거·로그인 항목 켜고 끄기도 잡는다.
//  - 로그인 항목 해제와 서비스 멈추기는 서비스 관리자에 다시 물어 확인한다(launchctl print · systemctl --user is-enabled / is-active).
//  - 새로 쓰는 파일(실행 명령·plist·unit·설치 기록)은 무작위 이름의 임시 파일을 배타적으로 만들어(wx, 0600) 쓴 뒤 이름을 바꾼다.
//  - 굳히기(설치기 3차 검토의 보류분):
//    · 보드가 떠 있는가는 건강 응답의 이름과 이 설치의 표식으로 본다(boardNow — scripts/launch.mjs boardAt).
//    · 서비스 관리자에 "물을 수 없었다"와 "없다"를 가른다(asked — unsure로 돌려주고 부른 쪽이 알린다).
//    · 설치기의 PID라고 받은 값(WHOSUP_INSTALLER_PID)은 우리를 띄운 조상일 때만 받는다(startedBy).
//    · 설치 기록의 설정·상태 경로는 후즈업 자신의 폴더일 때만 쓴다(ownPlaces — pinEnv · removeInstall). 앱 자리가 남의 폴더면 --purge도 지우지 않는다.
//    · 남의 install.json은 덮지 않는다(foreignRecord). 치우지 못한 빈 설정·상태 폴더는 남은 것으로 알린다(removeInstall의 left).
//    · 앱 폴더의 표식에 그 설치가 쓰는 상태 폴더를 적는다(noteState): 끝내지 못한 설치를 치우는 설치기가 그 폴더의 보드를 찾아 끈다.
import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readAuto, remoteWhy } from './autoconf.mjs'
import { PIN_KEYS, dataDirOf, ownDir, standaloneDirs, xdgDir } from './paths.mjs'
import { ENV_APPS, coreLines, manifestId } from './setup.mjs'
import { which } from '../scripts/doctor.mjs'
import { boardAt, loadEnv } from '../scripts/launch.mjs'

// 로그인 항목의 이름: 제품 이름에서 만든다(사용자 환경의 이름을 쓰지 않는다).
export const LABEL = 'dev.whosup.board'
export const SERVICE = 'whosup.service'
// 실행 명령의 둘째 줄: 이 줄이 없는 같은 이름의 파일은 남의 것이다(건드리지 않는다).
export const LAUNCHER_MARK = '# whosup launcher, written by install.sh'
// 한 줄 설치 명령이 받는 주소(install.sh의 INSTALL_URL과 같아야 한다 — test/install.test.mjs가 대조한다).
export const INSTALL_URL = 'https://raw.githubusercontent.com/fivetaku/whosup/main/install.sh'
// 설치 기록: <데이터 폴더>/install.json. 설치기(install.sh)는 이 기록이 그 앱 폴더를 가리킬 때만 "단독 설치가 있다"로 본다.
export const PRODUCT = 'whosup'
export const RECORD_FILE = 'install.json'
// 설치기가 만든 폴더(app · app.new · app.old)에 두는 표식 파일과 그 첫 줄(install.sh의 MARK_FILE·MARK_TEXT와 같아야 한다 — 시험이 대조한다).
export const APP_MARK_FILE = '.whosup-install'
export const APP_MARK = 'whosup: put here by install.sh'
// 전용 Node 폴더(<데이터 폴더>/node — 쓸 만한 node가 없을 때 install.sh가 nodejs.org에서 받아 놓는다)의 표식 파일과 그 첫 줄
// (install.sh의 NODE_MARK_FILE·NODE_MARK_TEXT와 같아야 한다 — 시험이 대조한다). 표식이 든 폴더만 제거가 지운다.
export const NODE_MARK_FILE = '.whosup-node'
export const NODE_MARK = 'whosup: node put here by install.sh'
export function nodeOwned(dir) {
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, NODE_MARK_FILE)).isFile()) return false
    return readFileSync(join(dir, NODE_MARK_FILE), 'utf8').split('\n')[0] === NODE_MARK
  } catch { return false }
}

export const supported = (platform = process.platform) => platform !== 'win32'

// ── 폴더 배치 ──
// systemd unit은 XDG_CONFIG_HOME이 아니라 표준 위치(~/.config/systemd/user)에 둔다: 다음 로그인의 사용자 관리자는 그 환경변수 없이
// 떠서 기본 위치만 본다.
export function layout(env = process.env, home = homedir()) {
  if (!isAbsolute(home)) throw new Error(`whosup: the home folder is not an absolute path: ${home}`)
  const data = dataDirOf(env, home)
  const { conf, state, fresh } = standaloneDirs(env, home)
  const bin = join(home, '.local', 'bin')
  return {
    home, data, app: join(data, 'app'), record: join(data, RECORD_FILE), bin, launcher: join(bin, 'whosup'), conf, state, freshState: fresh,
    plist: join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    unit: join(home, '.config', 'systemd', 'user', SERVICE),
  }
}
// 실행 명령이 기존 스크립트에 넘기는 환경: 단독 설치의 설정·상태 폴더는 하나뿐이라 물려받은 값이 있어도 덮는다
// (herdr 안의 터미널에서 쳐도 herdr 플러그인의 폴더로 새지 않는다).
export function standaloneEnv(env = process.env, home = homedir()) {
  const { conf, state } = standaloneDirs(env, home)
  return { ...env, HERDR_PLUGIN_CONFIG_DIR: conf, HERDR_PLUGIN_STATE_DIR: state }
}

// ── 파일 쓰기 ──
// 같은 폴더에 무작위 이름의 임시 파일을 배타적으로 만든다(wx: 그 이름이 이미 있으면 — 링크여도 — 실패한다. 0600). 다 쓴 뒤 권한을 맞추고
// 이름을 바꾼다(반쯤 쓰인 파일이 남지 않는다). 예측할 수 있는 이름(<파일>.<pid>.tmp)은 쓰지 않는다: 남이 미리 놓은 링크를 따라 쓰게 된다.
export function writeExclusive(file, text, mode = 0o600) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = join(dirname(file), `.${basename(file)}.${randomBytes(8).toString('hex')}.tmp`)
  writeFileSync(tmp, text, { flag: 'wx', mode: 0o600 })   // 여기서 실패하면(EEXIST 등) 그 이름은 우리 것이 아니다: 지우지 않는다
  try { if (mode !== 0o600) chmodSync(tmp, mode); renameSync(tmp, file) } catch (err) { try { unlinkSync(tmp) } catch {} throw err }
}
// plist·unit·실행 명령에 실을 수 없는 글자: 줄 바꿈(다른 항목이 된다), XML 1.0에 없는 제어 문자(plist가 깨진다), 짝 없는 서러게이트.
const unsafeText = (s) => /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff\r\n]/.test(String(s)) || !String(s).isWellFormed()

// ── 설치 기록 ──
// { product, id, version, at, data, app, launcher, conf, state, node, login }: 모두 절대 경로. node = 설치 때 고른 node, login = 로그인 항목 파일.
// 기록 파일 읽기(모양만 본다): 모양이 틀리면 null(남의 파일이거나 깨진 파일 — 기록이 없는 것으로 본다).
// 제거(removeInstall·uninstall)가 쓴다: 앱 폴더가 이미 지워진 뒤에도 기록에 적힌 설정·상태 폴더와 기록 파일을 찾아 치워야 한다.
export function readRecordFile(dataDir) {
  try {
    const file = join(dataDir, RECORD_FILE)
    const st = lstatSync(file)
    if (!st.isFile() || st.size > 64 * 1024) return null   // 링크·폴더는 기록이 아니다
    const o = JSON.parse(readFileSync(file, 'utf8'))
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.product !== PRODUCT) return null
    for (const k of ['data', 'app', 'conf', 'state']) if (typeof o[k] !== 'string' || !xdgDir(o[k])) return null
    return o
  } catch { return null }
}
// "단독 설치가 있다"의 판정(install.sh의 RECORD_JS와 같은 조건 — 둘을 같게 둔다). 설치 기록과 설치기의 표식은 한 쌍이다: 한쪽만 있으면 설치가 아니다.
//   기록이 읽히고(readRecordFile) · 기록의 data·app이 지금 기대하는 자리(<데이터 폴더> · <데이터 폴더>/app)와 같고 · 앱 폴더가 링크가 아닌 폴더이고
//   · 그 안에 표식 파일(APP_MARK_FILE)이 보통 파일로 있고 · herdr-plugin.toml의 id가 이 플러그인이고 · scripts/standalone.sh가 있다.
// 자리는 링크를 푼 경로로 견준다(홈·임시 폴더가 링크를 거치는 기계에서도 같은 자리로 본다). 맞으면 그 기록, 아니면 null.
const realOf = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
export function readRecord(dataDir, id = manifestId(fileURLToPath(new URL('..', import.meta.url)))) {
  const rec = readRecordFile(dataDir)
  if (!rec) return null
  try {
    const app = join(dataDir, 'app')
    if (realOf(rec.data) !== realOf(dataDir) || realOf(rec.app) !== realOf(app) || !appOwned(app)) return null
    if (!readFileSync(join(app, 'herdr-plugin.toml'), 'utf8').split(/\r?\n/).includes(`id = "${id}"`)) return null
    // 돌릴 스크립트는 그 앱 폴더 안의 보통 파일이어야 한다(링크를 따라가지 않는다 — 링크면 폴더 밖의 스크립트를 돌리게 된다)
    return lstatSync(join(app, 'scripts')).isDirectory() && lstatSync(join(app, 'scripts', 'standalone.sh')).isFile() ? rec : null
  } catch { return null }
}
// 그 자리의 install.json이 후즈업의 설치 기록이 아닌가: 무엇인가 있는데 보통 파일이 아니거나(링크·폴더), 너무 크거나, JSON 객체가 아니거나,
// product가 이 제품이 아니다. 그런 파일은 덮지 않는다(writeRecord가 던지고, 설치의 마지막 단계가 알린 뒤 끝낸다).
// 이 제품의 기록인데 경로 모양이 틀린 것(깨진 자기 기록)은 남의 것이 아니다: 새로 쓴다.
export function foreignRecord(dataDir) {
  const file = join(dataDir, RECORD_FILE)
  let st
  try { st = lstatSync(file) } catch { return false }
  if (!st.isFile() || st.size > 64 * 1024) return true
  try { const o = JSON.parse(readFileSync(file, 'utf8')); return !(o && typeof o === 'object' && !Array.isArray(o) && o.product === PRODUCT) } catch { return true }
}
// 설치 기록에 적힌 설정·상태 폴더 가운데 후즈업 자신의 폴더인 것만 돌려준다({ conf, state } — 아니면 ''). 기록은 사람이나 다른 프로그램이
// 고칠 수 있는 파일이라, 읽을 때마다 다시 본다(한 번 본 것을 믿지 않는다).
//   설정 폴더: 이 사용자의 ~/.config/whosup 그 자리일 때만(단독 설치의 설정 폴더는 그곳뿐이다 — src/paths.mjs standaloneDirs).
//   상태 폴더: 그 설정 폴더와 같은 자리이거나(예전부터 쓰던 사람), 마지막 마디가 제품 이름이고 아직 없거나 후즈업의 상태 파일이 든 폴더
//             (whosup.db · whosup.lock이 있거나, 든 것이 모두 보드·실행기가 두는 파일이다). 데이터 폴더(프로그램이 놓이는 곳)나 그 안은 아니다.
// 아닌 경로는 쓰지 않는다: 실행 명령은 지금 환경으로 계산한 폴더를 쓰고(pinEnv), --purge는 그 폴더를 지우지 않는다(removeInstall).
const STATE_FILES = new Set(['whosup.db', 'whosup.db-wal', 'whosup.db-shm', 'whosup.lock', 'whosup.lock-journal', 'server.pid', 'server.log', 'install.log', 'port', 'auto.json', 'autostart.log', 'board-heartbeat', 'board-connected', '.env', 'setup.json'])
const sameDir = (a, b) => realOf(a) === realOf(b)
export function ownPlaces(rec, home = homedir()) {
  const own = ownDir(home)
  const conf = xdgDir(rec?.conf) && sameDir(rec.conf, own) ? rec.conf : ''
  const stateOk = (p) => {
    if (!xdgDir(p)) return false
    if (sameDir(p, own)) return true
    const at = resolve(p), data = xdgDir(rec?.data) ? resolve(rec.data) : ''
    if (basename(at) !== PRODUCT || (data && (at === data || at.startsWith(data + sep)))) return false
    try {
      if (!lstatSync(at).isDirectory()) return false
      const names = readdirSync(at)
      return names.includes('whosup.db') || names.includes('whosup.lock') || names.every((n) => STATE_FILES.has(n))
    } catch (err) { return err?.code === 'ENOENT' }
  }
  return { conf, state: stateOk(rec?.state) ? rec.state : '' }
}
// env_installed: 설치기가 이 설치와 함께 깐 환경('herdr-app' · 'ovis-app', 없으면 빈 값 — install.sh의 환경 고르기). env_app = 그 앱의 경로(있을 때만).
// 제거(`whosup uninstall`)가 이 값을 읽어 "그 앱은 지우지 않았다"를 한 줄로 알린다. 그 앱을 지우거나 실행하는 데는 쓰지 않는다.
export function writeRecord(L, /** @type {{ id?: string, version?: string, node?: string, login?: string | null, now?: Date, envInstalled?: string, envApp?: string }} */ { id, version = '', node = '', login = null, now = new Date(), envInstalled = '', envApp = '' } = {}) {
  const env = envOf({ env_installed: envInstalled, env_app: envApp })
  const body = { product: PRODUCT, id, version, at: now.toISOString(), data: L.data, app: L.app, launcher: L.launcher, conf: L.conf, state: L.state, node, login, env_installed: env.installed, ...(env.app ? { env_app: env.app } : {}) }
  // 그 자리에 후즈업 것이 아닌 install.json이 있으면 덮지 않는다(foreignRecord)
  if (foreignRecord(L.data)) throw Object.assign(new Error(`${L.record} is not a whosup install record`), { code: 'FOREIGN_RECORD' })
  writeExclusive(L.record, `${JSON.stringify(body, null, 2)}\n`)
  return body
}
// 설치 기록(또는 같은 모양의 값)에서 함께 깐 환경을 읽는다: 아는 값(ENV_APPS)만 받는다. 앱 경로는 화면에 찍기만 하는 값이라
// 절대 경로이고 제어 문자가 없고 길지 않을 때만 받는다. 아니면 빈 값.
export function envOf(rec) {
  const installed = ENV_APPS.includes(rec?.env_installed) ? rec.env_installed : ''
  const app = installed && xdgDir(rec?.env_app) && rec.env_app.length <= 1024 ? rec.env_app : ''
  return { installed, app }
}
// 함께 깐 앱이 두는 폴더·파일 가운데 지금 있는 것(설치기 install.sh가 그 앱의 설치 방법으로 놓는 자리 — Herdr 앱의 코어·명령은 ~/.local/bin,
// Ovis 앱의 리눅스 판은 <데이터>/ovis-desktop과 앱 목록 항목). 제거가 "그대로 남겨 두었다"로 한 줄 알리는 데만 쓴다 — 지우지도 돌리지도 않는다.
export function envLeftovers(installed, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  const data = xdgDir(env.XDG_DATA_HOME) || join(home, '.local', 'share')
  const places = installed === 'herdr-app' ? [join(home, '.local', 'bin', 'herdr-core'), ...(platform === 'darwin' ? [] : [join(home, '.local', 'bin', 'herdr-app')])]
    : installed === 'ovis-app' && platform !== 'darwin' ? [join(data, 'ovis-desktop'), join(data, 'applications', 'ovis.desktop')] : []
  return places.filter((p) => existsSync(p))
}
// 설치기가 정한 앱을 연다(그 앱은 한 번 열어야 코어가 떠서 세션이 보드에 보인다). 깐 앱의 전체 경로로 연다 — PATH에서 이름으로 찾지 않는다.
// macOS: /usr/bin/open <….app> · 그 밖: 그 실행 파일을 떼어 띄운다. 열라고 했으면 true(앱이 실제로 떴는지는 보지 않는다), 경로가 없거나 못 띄웠으면 false.
// 열지 말지는 부른 쪽이 정한다(브라우저를 여는 것과 같은 판정 — browserOpens).
// 앱에 주는 환경은 설치기의 것을 걷어 낸 것이다(appEnv): WHOSUP_*(설치기의 PID·설치 종류·환경 고르기·PATH 기록 등)는 빼고, PATH는 설치기가
// 덧붙이기 전 사람의 것(WHOSUP_USER_PATH)으로 되돌린다 — 앱이 여는 셸마다 그 값이 따라다니지 않게(리눅스: 앱을 직접 띄운다. macOS의 open은
// LaunchServices를 거쳐 환경을 넘기지 않는다).
export function appEnv(env = process.env) {
  const out = {}
  for (const [k, v] of Object.entries(env)) if (!k.startsWith('WHOSUP_')) out[k] = v
  if (typeof env.WHOSUP_USER_PATH === 'string') out.PATH = env.WHOSUP_USER_PATH
  return out
}
export function openApp(path, { platform = process.platform, spawnFn = spawn, exists = existsSync, env = process.env } = {}) {
  if (!supported(platform) || !xdgDir(path) || !exists(path)) return false
  const [file, args] = platform === 'darwin' ? ['/usr/bin/open', [path]] : [path, []]
  try {
    const child = spawnFn(file, args, { detached: true, stdio: 'ignore', env: appEnv(env) })
    child?.once?.('error', () => {})
    child?.unref?.()
    return true
  } catch { return false }
}
// 설치 요약에 실을 "환경 고르기의 결과"(src/setup.mjs standaloneLines의 env): 설치기가 이 단계에 넘긴 값(WHOSUP_ENV_PICK = 붙일 앱,
// WHOSUP_ENV_APP = 그 앱의 경로)에서 만든다. 새 설치가 아니거나 정한 앱이 없으면 null.
//   installed = 이번에 함께 깐 환경(설치 기록에 적은 값) · mayOpen = 그 앱을 대신 열어도 되는가(브라우저를 여는 것과 같은 판정 — 부른 쪽이 정한다)
export function pickedEnv(/** @type {{ env?: Record<string, any>, kind?: string, installed?: string, mayOpen?: boolean, platform?: NodeJS.Platform, open?: typeof openApp }} */ { env = {}, kind = 'install', installed = '', mayOpen = false, platform = process.platform, open = openApp } = {}) {
  if (kind !== 'install' || !ENV_APPS.includes(env.WHOSUP_ENV_PICK)) return null
  const app = xdgDir(env.WHOSUP_ENV_APP)
  return { pick: env.WHOSUP_ENV_PICK, installed: installed === env.WHOSUP_ENV_PICK, app, opened: Boolean(mayOpen && app && open(app, { platform, env })) }
}
// 기록의 폴더를 환경에 채운다(src/paths.mjs가 XDG 값보다 먼저 본다). rec이 없으면 물려받은 값을 걷어 낸다 — 기록만이 그 값의 출처다.
// 설정·상태 폴더는 후즈업 자신의 폴더일 때만 채운다(ownPlaces): 아닌 경로가 적힌 기록이면 그 값은 걷어 내고 지금 환경으로 계산한 폴더를 쓴다.
export function pinEnv(env, rec, home = homedir()) {
  const out = { ...env }
  const own = rec ? { data: rec.data, ...ownPlaces(rec, home) } : {}
  for (const [k, name] of Object.entries(PIN_KEYS)) { if (own[k]) out[name] = own[k]; else delete out[name] }
  return out
}
// 표식 파일의 둘째 줄: 그 앱 폴더로 설치를 시작한 판이 쓰는 상태 폴더(state=<절대 경로>). 설치의 마지막 단계(scripts/standalone.mjs install)가
// 무엇을 켜기 전에 적는다. 끝내지 못한 설치를 치우는 설치기(install.sh clear_leftover — mark_state)가 이 줄로 그 설치의 보드를 찾아 끈다:
// 그 설치가 지금과 다른 XDG_STATE_HOME으로 돌았어도 찾는다. 첫 줄(표식)은 그대로다(appOwned · install.sh ours는 첫 줄만 본다).
export function noteState(app, state) {
  if (!appOwned(app) || !xdgDir(state)) return false
  try { writeExclusive(join(app, APP_MARK_FILE), `${APP_MARK}\nstate=${state}\n`, 0o644); return true } catch { return false }
}
export function notedState(app) {
  if (!appOwned(app)) return ''
  try {
    const line = readFileSync(join(app, APP_MARK_FILE), 'utf8').split('\n').slice(1).find((l) => l.startsWith('state='))
    return line ? xdgDir(line.slice('state='.length)) : ''
  } catch { return '' }
}
// 설치기가 만든 폴더인가: 링크가 아닌 폴더이고, 표식 파일의 첫 줄이 맞다.
export function appOwned(dir) {
  try {
    if (!lstatSync(dir).isDirectory() || !lstatSync(join(dir, APP_MARK_FILE)).isFile()) return false
    return readFileSync(join(dir, APP_MARK_FILE), 'utf8').split('\n')[0] === APP_MARK
  } catch { return false }
}
// 로그인 항목과 실행 명령에 적을 node: scripts/standalone.sh가 고른 것(WHOSUP_NODE — 설치기가 고른 것을 그대로 넘긴다), 없으면 지금 이 node.
export const nodeOf = (env = process.env) => (xdgDir(env.WHOSUP_NODE) ? env.WHOSUP_NODE : process.execPath)

// ── 잠금 ──
// 설치기(install.sh take_lock)와 같은 잠금: <데이터 폴더>/install.lock 폴더(mkdir은 이미 있으면 실패한다)와 그 안의 pid 파일(주인의 PID 한 줄).
// 설치·새 버전으로 바꾸기·제거·로그인 항목 켜고 끄기가 같은 폴더와 파일을 동시에 건드리지 않게 한다.
// 잠겨 있을 때 걷는 조건은 "주인 PID가 살아 있지 않다"뿐이다. 시간이 지났다는 것만으로는 걷지 않는다 — 질문을 기다리는 설치는 오래 걸린다.
// pid 파일이 없거나 읽을 수 없는 잠금만 시간으로 본다: LOCK_GRACE_S(첫 실행 안내가 기다릴 수 있는 가장 긴 시간 — src/setup.mjs watchdogMsOf —
// 보다 길다)를 넘겼을 때 걷는다. 걷을 때는 pid 파일의 이름을 바꿔 차지한 뒤 그 내용이 방금 본 PID인지 다시 본다(그 사이에 다른 프로세스가
// 새로 잡은 잠금을 걷지 않는다). install.sh의 LOCK_STALE_JS와 같은 순서다 — 둘을 같게 둔다.
export const LOCK_NAME = 'install.lock'
export const LOCK_GRACE_S = 21600
const pidIn = (file) => { try { const n = Number(readFileSync(file, 'utf8').trim()); return Number.isInteger(n) && n > 1 ? n : 0 } catch { return 0 } }
// 그 PID의 프로세스가 있는가: 없다(ESRCH)는 답만 죽은 것으로 본다(권한이 없어 못 물어 본 것은 살아 있는 것이다).
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (err) { return err?.code !== 'ESRCH' } }
// 주인이 죽은 잠금을 걷는다. 걷었으면 true.
export function clearStaleLock(lock, { alive = pidAlive, now = Date.now() } = {}) {
  const file = join(lock, 'pid')
  const pid = pidIn(file)
  try {
    if (pid) {
      if (alive(pid)) return false
      const mine = `${file}.stale.${randomBytes(4).toString('hex')}`
      renameSync(file, mine)
      if (pidIn(mine) !== pid) { renameSync(mine, file); return false }   // 그 사이에 다른 주인의 것이 됐다: 돌려 놓는다
    } else if (now - statSync(lock).mtimeMs <= LOCK_GRACE_S * 1000) return false
    rmSync(lock, { recursive: true })   // 잠금 폴더 안의 것까지(차지한 pid 파일·읽을 수 없는 pid 파일·걷다 만 흔적)
    return true
  } catch { return false }
}
// 잠금을 잡는다. { ok: true, lock, release } — release는 자기가 잡은 잠금(pid 파일이 자기 PID)일 때만 푼다. 잡혀 있으면 { ok: false, lock }.
// parent = 우리를 부른 설치기의 PID(WHOSUP_INSTALLER_PID): 그 설치기가 잡고 있는 잠금이면 그 아래에서 돈다(다시 잡지도 풀지도 않는다 —
// 설치기가 끝내지 못한 설치를 치우려고 uninstall·autostart off를 부를 때).
export function takeLock(dataDir, { pid = process.pid, parent = 0, alive = pidAlive } = {}) {
  const lock = join(dataDir, LOCK_NAME), file = join(lock, 'pid')
  if (parent > 1 && pidIn(file) === parent) return { ok: true, lock, release: () => {} }
  const make = () => {
    try { mkdirSync(lock) } catch { return false }
    try { writeFileSync(file, `${pid}\n`, { flag: 'wx', mode: 0o600 }); return true } catch { try { rmdirSync(lock) } catch {} return false }
  }
  try { mkdirSync(dataDir, { recursive: true }) } catch {}
  if (!make() && !(clearStaleLock(lock, { alive }) && make())) return { ok: false, lock }
  let held = true
  const release = () => {
    if (!held) return
    held = false
    if (pidIn(file) === pid) { try { unlinkSync(file) } catch {} try { rmdirSync(lock) } catch {} }
    try { rmdirSync(dataDir) } catch {}   // 아무것도 남지 않은 데이터 폴더는 치운다(비어 있지 않으면 그대로다 — install.sh unlock과 같다)
  }
  return { ok: true, lock, release }
}
// 설치기의 PID라고 받은 값(WHOSUP_INSTALLER_PID)이 정말 우리를 띄운 프로세스인가: 자기 자신이거나 조상(부모·조부모… — 설치기는
// `sh scripts/standalone.sh`를 거쳐 우리를 띄운다)일 때만 true. 환경변수로 아무 PID나 대면(지금 잠금을 쥔 다른 설치기의 PID) 그 잠금 아래에서
// 도는 것으로 보지 않는다. up = 한 프로세스의 부모 PID(모르면 0): Linux는 /proc/<pid>/stat, 그 밖에는 ps -o ppid=.
const ppidOf = (pid) => {
  if (process.platform === 'linux') {
    try { const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); const n = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]); if (Number.isInteger(n)) return n } catch {}
  }
  try {
    const r = spawnSync('ps', ['-o', 'ppid=', '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] })
    const n = Number(String(r.stdout || '').trim())
    return r.status === 0 && Number.isInteger(n) ? n : 0
  } catch { return 0 }
}
export function startedBy(claimed, { pid = process.pid, parent = process.ppid, up = ppidOf } = {}) {
  if (!Number.isInteger(claimed) || claimed <= 1) return false
  if (claimed === pid || claimed === parent) return true
  for (let p = parent, i = 0; p > 1 && i < 8; i++) { p = up(p); if (p === claimed) return true }
  return false
}

// ── 실행 명령(~/.local/bin/whosup) ──
// sh의 한 낱말로: 작은따옴표로 싼다(안의 작은따옴표는 '\'' 로).
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
// 화면에 적을 때: 공백·특수 글자가 없으면 그대로, 있으면 작은따옴표로 싼다.
export const shown = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(String(s)) ? String(s) : shq(s))
// node = 설치 때 고른 node의 절대 경로: scripts/standalone.sh가 그것을 먼저 쓰고, 그 파일이 없어졌으면 다시 찾는다.
export function launcherText(app, node = '') {
  return `#!/bin/sh
${LAUNCHER_MARK}
# Runs the standalone whosup install: whosup start | stop | status | open | setup | update | uninstall | autostart | help
app=${shq(app)}
if [ ! -f "$app/scripts/standalone.sh" ]; then
  echo "whosup: no standalone install at $app. Install it again: curl -fsSL ${INSTALL_URL} | sh" >&2
  exit 1
fi
${node ? `# the node picked at install time; if it is gone, scripts/standalone.sh looks for another\nWHOSUP_NODE=${shq(node)}\nexport WHOSUP_NODE\n` : ''}exec sh "$app/scripts/standalone.sh" "$@"
`
}
// 'none'(없음) | 'ours'(설치기가 쓴 것) | 'foreign'(남의 파일·링크·폴더)
export function launcherState(file) {
  let st
  try { st = lstatSync(file) } catch { return 'none' }
  if (st.isSymbolicLink() || !st.isFile()) return 'foreign'
  try { return readFileSync(file, 'utf8').split('\n')[1] === LAUNCHER_MARK ? 'ours' : 'foreign' } catch { return 'foreign' }
}
// 남의 파일이면 건드리지 않는다. 옆에 임시 파일로 쓴 뒤 이름을 바꾼다(writeExclusive — 쓴 뒤 0755).
export function writeLauncher({ app, file, node = '' }) {
  if (launcherState(file) === 'foreign') return { state: 'foreign', file }
  try {
    writeExclusive(file, launcherText(app, node), 0o755)
    return { state: 'written', file }
  } catch (err) {
    return { state: 'failed', file, why: String(err?.code || err?.message || err).slice(0, 120) }
  }
}
// 사람이 칠 명령: 실행 명령이 우리 것이고 사람의 PATH에서 whosup이 그것을 가리키면 'whosup', PATH에 없거나 다른 프로그램이 먼저면 전체 경로,
// 실행 명령을 쓰지 못했으면(남의 파일) scripts/standalone.sh를 직접 부르는 긴 명령. why = 'foreign' | 'path' | 'shadowed' | undefined.
// 사람의 PATH = WHOSUP_USER_PATH(scripts/standalone.sh·install.sh가 PATH를 손대기 전에 적어 둔 값), 없으면 PATH.
/** @returns {{ cmd: string, why?: string, other?: string }} */
export function commandName(L, env = process.env) {
  if (launcherState(L.launcher) !== 'ours') return { cmd: `sh ${shown(join(L.app, 'scripts', 'standalone.sh'))}`, why: 'foreign' }
  const found = which('whosup', { PATH: env.WHOSUP_USER_PATH ?? env.PATH ?? '' }, false)
  const same = (a, b) => { try { return realpathSync(a) === realpathSync(b) } catch { return a === b } }
  if (found && same(found, L.launcher)) return { cmd: 'whosup' }
  return { cmd: shown(L.launcher), why: found ? 'shadowed' : 'path', ...(found ? { other: found } : {}) }
}

// ── 로그인할 때 자동으로 켜기 ──
// 로그인 항목은 `sh <앱>/scripts/standalone.sh start`를 한 번 돌린다(보드는 뒤에 남고 명령은 끝난다 — herdr의 startup 훅과 같은 방식).
// WHOSUP_LOGIN_START=1: 그 start는 브라우저를 열지 않는다(로그인할 때마다 탭이 뜨지 않게).
// launchd·systemd에는 셸의 환경이 없다. 싣는 것은 필요한 최소다:
//   WHOSUP_NODE  설치 때 고른 node의 절대 경로(scripts/standalone.sh가 먼저 쓰고, 없어졌으면 다시 찾는다)
//   PATH         그 node의 폴더 + 시스템 기본 폴더. 등록할 때의 PATH 전체는 싣지 않는다(그때만 있던 폴더·쓸 수 있는 폴더·"."이 로그인 때마다
//                node를 찾는 길이 되지 않게). Homebrew·~/.local/bin·nvm은 scripts/node-path.sh가 실행할 때 덧붙인다.
//   XDG_*        절대 경로인 것만(보드가 herdr-core의 상태 폴더를 찾는 데 쓴다). 설정·상태·앱 폴더는 여기에 기대지 않는다 — 설치 기록이 정한다.
const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
// systemd unit의 큰따옴표 낱말: \ 와 " 를 막고 %(지정자)를 겹친다. Exec 줄에서는 $도 겹친다(systemd가 $NAME을 펼친다).
const unitWord = (s, exec = false) => { const t = String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%'); return exec ? t.replace(/\$/g, '$$$$') : t }
export function serviceVars(env = process.env) {
  const node = nodeOf(env)
  const vars = { PATH: [...new Set([dirname(node), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':') }
  for (const k of ['XDG_DATA_HOME', 'XDG_STATE_HOME', 'XDG_CONFIG_HOME']) if (xdgDir(env[k])) vars[k] = String(env[k])
  vars.WHOSUP_NODE = node
  vars.WHOSUP_LOGIN_START = '1'
  return vars
}
export function plistText({ app, state, vars }) {
  const log = join(state, 'autostart.log')
  // AbandonProcessGroup: start가 뒤에 남긴 보드를 launchd가 start가 끝날 때 같이 끝내지 않게 한다.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>${xml(join(app, 'scripts', 'standalone.sh'))}</string><string>start</string></array>
  <key>EnvironmentVariables</key><dict>
${Object.entries(vars).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>AbandonProcessGroup</key><true/>
  <key>StandardOutPath</key><string>${xml(log)}</string>
  <key>StandardErrorPath</key><string>${xml(log)}</string>
</dict>
</plist>
`
}
// ExecStop의 stop에는 --service가 붙는다: 서비스 관리자가 부른 stop은 보드만 끈다(scripts/standalone.mjs — `whosup stop`이 이 서비스를
// 멈추고, 그 멈춤이 다시 `whosup stop`을 부르는 되풀이를 막는다).
export const SERVICE_STOP_FLAG = '--service'
export function unitText({ app, vars }) {
  const script = unitWord(join(app, 'scripts', 'standalone.sh'), true)
  // oneshot + RemainAfterExit: start가 남긴 보드가 이 unit에 남는다(RemainAfterExit가 없으면 start가 끝나는 순간 unit이 내려가며 보드를
  // 같이 끝낸다). 그래서 보드를 꺼도 unit은 active (exited)로 남는다 — `whosup stop`이 이 서비스도 멈춘다(stopService).
  return `[Unit]
Description=whosup board

[Service]
Type=oneshot
RemainAfterExit=yes
${Object.entries(vars).map(([k, v]) => `Environment="${unitWord(`${k}=${v}`)}"`).join('\n')}
ExecStart="/bin/sh" "${script}" start
ExecStop="/bin/sh" "${script}" stop ${SERVICE_STOP_FLAG}
TimeoutStartSec=120

[Install]
WantedBy=default.target
`
}
// code = 종료 코드 · ran = 그 명령이 돌아서 스스로 끝났는가(실행하지 못했거나 시간 초과로 끊긴 것은 "답"이 아니다)
const ctl = (bin, args) => {
  const r = spawnSync(bin, args, { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] })
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`, code: r.status, ran: !r.error && r.status !== null }
}
// 서비스 관리자에 물은 것의 답: 'yes' | 'no' | 'unknown'. "없다"와 "물을 수 없었다"를 가른다 — 물을 수 없었을 때는 꺼졌다고 단정하지 않고
// 그 사실을 돌려준다(unsure: { name, check } — 부른 쪽이 알린다. 로그인 항목 파일은 그래도 지운다: 다음 로그인에는 켜지지 않는다).
//   launchctl print          0 = 불려 있다 · 113 또는 "Could not find service" = 없다 · 그 밖의 종료 코드, 실행하지 못함 = 물을 수 없었다
//   systemctl --user is-…    0 = 그렇다 · 실행하지 못함, "Failed to connect to bus" 류의 말 = 물을 수 없었다 · 그 밖 = 아니다
// 종료 코드를 주지 않는 run(시험의 대역)의 실패는 "없다"로 본다.
const CANT_ASK = /failed to connect|no medium found|connection refused|connection timed out|not been booted with systemd|transport endpoint/i
const launchdSays = (r) => (r.ok ? 'yes' : r.ran === false ? 'unknown' : r.code === 113 || /could not find service/i.test(r.out || '') ? 'no' : typeof r.code === 'number' ? 'unknown' : 'no')
const systemdSays = (r) => (r.ok ? 'yes' : r.ran === false || CANT_ASK.test(r.out || '') ? 'unknown' : 'no')
const uidOf = () => (typeof process.getuid === 'function' ? process.getuid() : 0)
const hasSystemd = (bin, run) => run(bin, ['--user', 'show-environment']).ok
// systemctl enable이 만드는 링크(WantedBy=default.target): disable이 안 됐을 때 직접 지우고, 남았는지 확인한다.
const wantsLink = (L) => join(dirname(L.unit), 'default.target.wants', SERVICE)

// 등록한다. activate = 지금 바로 불러 둘 것인가(launchctl bootstrap · systemctl enable --now — RunAtLoad·ExecStart가 start를 한 번 돌린다).
// false면 파일만 둔다: 다음 로그인부터 켜지고, 지금 보드를 띄우지 않는다(WHOSUP_NO_AUTOSTART·꺼 둔 채 업데이트).
// 돌려주는 state: 'on'(등록됨 — loaded = 지금 불러 두었는가) | 'failed' | 'none'(서비스 관리자 없음) | 'unsupported'(윈도우)
// loaded가 false인 까닭은 둘이다: 불러 두지 않기로 했다(activate = false) · 불러 두려 했는데 안 됐다(loadFailed: true — macOS의 launchctl bootstrap 실패).
// 둘 다 파일은 놓였고 다음 로그인부터 켜진다. loadFailed는 "지금 바로 불러 두지는 못했다"를 사실대로 말하려고 구분한다.
export function registerAutostart({ env = process.env, home = homedir(), platform = process.platform, activate = true, run = ctl, uid = uidOf() } = {}) {
  if (!supported(platform)) return { state: 'unsupported' }
  const L = layout(env, home)
  const vars = serviceVars(env)
  // 한 줄에 하나: 값에 줄 바꿈이 있으면 unit·plist의 다른 항목이 된다. XML에 실을 수 없는 제어 문자도 같이 거절한다.
  if (unsafeText(`${L.app}${L.state}${Object.entries(vars).flat().join('')}`)) return { state: 'failed', why: 'a control character in a folder name' }
  try {
    if (platform === 'darwin') {
      const bin = env.WHOSUP_LAUNCHCTL || 'launchctl'
      mkdirSync(L.state, { recursive: true })   // 기록 파일(autostart.log)이 놓일 곳
      writeExclusive(L.plist, plistText({ app: L.app, state: L.state, vars }))
      if (!activate) return { state: 'on', file: L.plist, loaded: false }
      run(bin, ['bootout', `gui/${uid}/${LABEL}`])   // 앞서 불러 둔 것이 있으면 내린다(없으면 실패 — 무시)
      const r = run(bin, ['bootstrap', `gui/${uid}`, L.plist])
      // bootstrap이 안 돼도(화면 세션이 없는 SSH 등) 파일은 다음 로그인 때 읽힌다. 다만 지금 불러 두지는 못했다(loadFailed).
      return r.ok ? { state: 'on', file: L.plist, loaded: true } : { state: 'on', file: L.plist, loaded: false, loadFailed: true }
    }
    if (platform === 'linux') {
      const bin = env.WHOSUP_SYSTEMCTL || 'systemctl'
      if (!hasSystemd(bin, run)) return { state: 'none' }
      writeExclusive(L.unit, unitText({ app: L.app, vars }))
      const ok = run(bin, ['--user', 'daemon-reload']).ok && run(bin, ['--user', 'enable', ...(activate ? ['--now'] : []), SERVICE]).ok
      return ok ? { state: 'on', file: L.unit, loaded: activate } : { state: 'failed', file: L.unit, why: 'systemctl --user enable failed' }
    }
    return { state: 'none' }
  } catch (err) { return { state: 'failed', why: String(err?.code || err?.message || err).slice(0, 120) } }
}
// 해제한다: 로그인 항목만 내리고 파일을 지운다. 켜져 있는 보드는 끄지 않는다.
// 서비스 관리자의 답(bootout·disable의 종료 코드)만 믿지 않는다. 'off'는 둘 다일 때뿐이다:
//   - 서비스 관리자가 그 항목을 놓았다: macOS는 bootout 뒤 launchctl print로, Linux는 disable 뒤 systemctl --user is-enabled로 다시 묻는다.
//     아직 살아 있으면 { state: 'failed', live: 이름, fix: 손으로 칠 명령 } — 파일은 지우지 않는다(다시 돌리면 다시 내린다).
//     서비스 관리자가 없거나 닿지 못하면 그 물음도 실패한다(살아 있지 않은 것으로 본다) — 그때는 파일 기준이다.
//   - 로그인 때 읽힐 파일이 하나도 남지 않았다. 남았으면 { state: 'failed', left: [남은 파일] }.
// 부른 쪽이 그 사실을 알리고 0이 아닌 값으로 끝낸다. waitMs = 서비스 관리자가 항목을 놓기를 기다리는 시간(bootout은 조금 뒤에 끝나기도 한다).
const pause = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms) }
// 서비스 관리자가 그 항목을 놓기를 기다린다: 'yes'인 동안 waitMs까지 다시 묻고, 마지막 답('yes' | 'no' | 'unknown')을 돌려준다.
const settle = (ask, waitMs) => { for (const end = Date.now() + waitMs; ;) { const said = ask(); if (said !== 'yes' || Date.now() >= end) return said; pause(200) } }
/** @returns {{ state: string, removed?: boolean, file?: string, left?: string[], live?: string, fix?: string, unsure?: { name: string, check: string } }} */
export function unregisterAutostart({ env = process.env, home = homedir(), platform = process.platform, run = ctl, uid = uidOf(), waitMs = 2000 } = {}) {
  if (!supported(platform)) return { state: 'unsupported' }
  const L = layout(env, home)
  const gone = (file) => { try { lstatSync(file); return false } catch { return true } }
  const drop = (file) => { try { unlinkSync(file) } catch {} return gone(file) }
  // unsure = 서비스 관리자에 물을 수 없었을 때의 { name, check }: 꺼졌다고 답하되 그 사실을 함께 돌려준다
  const result = (files, unsure = null) => { const left = files.filter((f) => !gone(f)); return left.length ? { state: 'failed', removed: false, file: files[0], left } : { state: 'off', removed: true, file: files[0], ...(unsure ? { unsure } : {}) } }
  if (platform === 'darwin') {
    if (gone(L.plist)) return { state: 'off', removed: false }
    const bin = env.WHOSUP_LAUNCHCTL || 'launchctl', target = `gui/${uid}/${LABEL}`
    run(bin, ['bootout', target])   // 불러 둔 것이 없으면 실패한다
    const said = settle(() => launchdSays(run(bin, ['print', target])), waitMs)
    if (said === 'yes') return { state: 'failed', removed: false, file: L.plist, left: [L.plist], live: LABEL, fix: `launchctl bootout ${target}` }
    drop(L.plist)
    return result([L.plist], said === 'unknown' ? { name: LABEL, check: `launchctl print ${target}` } : null)
  }
  if (platform === 'linux') {
    const link = wantsLink(L)
    if (gone(L.unit) && gone(link)) return { state: 'off', removed: false }
    const bin = env.WHOSUP_SYSTEMCTL || 'systemctl'
    // --now를 붙이지 않는다: 여기서는 로그인할 때 켜지는 것만 끈다(보드는 `whosup stop`이 끈다).
    const disabled = run(bin, ['--user', 'disable', SERVICE]).ok
    if (!disabled) drop(link)   // 사용자 관리자에 닿지 못했다(버스 없음 등): enable이 만든 링크를 직접 지운다
    const said = settle(() => systemdSays(run(bin, ['--user', 'is-enabled', '--quiet', SERVICE])), waitMs)
    if (said === 'yes') return { state: 'failed', removed: false, file: L.unit, left: [L.unit, link].filter((f) => !gone(f)), live: SERVICE, fix: `systemctl --user disable ${SERVICE}` }
    drop(L.unit)
    run(bin, ['--user', 'daemon-reload'])
    return result([L.unit, link], said === 'unknown' ? { name: SERVICE, check: `systemctl --user is-enabled ${SERVICE}` } : null)
  }
  return { state: 'off', removed: false }
}
// 지금 등록돼 있는가: 'on' | 'off' | 'none'(서비스 관리자 없음) | 'unsupported'
// macOS의 'on'에는 loaded가 붙는다: launchd가 지금 그 항목을 불러 두었는가(launchctl print). false면 파일만 있고 다음 로그인부터 켜진다.
export function autostartStatus({ env = process.env, home = homedir(), platform = process.platform, run = ctl, uid = uidOf() } = {}) {
  if (!supported(platform)) return { state: 'unsupported' }
  const L = layout(env, home)
  if (platform === 'darwin') {
    if (!existsSync(L.plist)) return { state: 'off' }
    return { state: 'on', file: L.plist, loaded: run(env.WHOSUP_LAUNCHCTL || 'launchctl', ['print', `gui/${uid}/${LABEL}`]).ok }
  }
  if (platform === 'linux') {
    const bin = env.WHOSUP_SYSTEMCTL || 'systemctl'
    if (!hasSystemd(bin, run)) return { state: 'none' }
    return existsSync(L.unit) && run(bin, ['--user', 'is-enabled', SERVICE]).ok ? { state: 'on', file: L.unit } : { state: 'off' }
  }
  return { state: 'none' }
}
// Linux: 사용자 서비스가 active면 멈춘다(oneshot + RemainAfterExit라 보드를 꺼도 active (exited)로 남는다 — 남아 있으면 다시 켜지지 않는다).
// 보드는 부른 쪽이 먼저 끈다 — 그래서 ExecStop이 부르는 stop은 할 일이 없다.
// 돌려주는 것: { asked: 멈추라고 했는가, ok: 지금 active가 아닌가 }. stop의 답만 믿지 않고 is-active로 다시 묻는다: 여전히 active면
// ok: false와 손으로 칠 명령(fix) — 부른 쪽(whosup stop·uninstall)이 알린다. 서비스 관리자가 없으면 is-active가 실패한다(active가 아니다).
// 물을 수 없었으면(사용자 관리자에 닿지 못했다) active가 아닌 것으로 보고 지나가되, 우리 unit 파일이 놓여 있을 때는 그 사실을 함께
// 돌려준다(unsure — 부른 쪽이 알린다). unit 파일이 없으면 등록한 적이 없는 것이라 알릴 것이 없다(사용자 관리자가 아예 없는 기계).
/** @returns {{ asked: boolean, ok: boolean, fix?: string, unsure?: { name: string, check: string } }} */
export function stopService({ env = process.env, home = homedir(), platform = process.platform, run = ctl } = {}) {
  if (platform !== 'linux') return { asked: false, ok: true }
  const bin = env.WHOSUP_SYSTEMCTL || 'systemctl'
  const active = () => systemdSays(run(bin, ['--user', 'is-active', '--quiet', SERVICE]))
  const unsure = () => { try { return existsSync(layout(env, home).unit) ? { unsure: { name: SERVICE, check: `systemctl --user is-active ${SERVICE}` } } : {} } catch { return {} } }
  const before = active()
  if (before !== 'yes') return { asked: false, ok: true, ...(before === 'unknown' ? unsure() : {}) }
  run(bin, ['--user', 'stop', SERVICE])
  const after = active()
  return after === 'yes' ? { asked: true, ok: false, fix: `systemctl --user stop ${SERVICE}` } : { asked: true, ok: true, ...(after === 'unknown' ? unsure() : {}) }
}

// ── 제거 ──
// 실행 명령(우리 것일 때만)·앱 폴더(설치기의 표식이 든 것만)·전용 Node(표식이 든 것만)·설치 기록을 지운다. 설정·상태 폴더는 purge이고 설치 기록에 적힌 것이며
// 프로그램 쪽이 모두 지워졌을 때만. 보드 끄기와 로그인 항목 해제는 부른 쪽이 먼저 한다.
// 돌려주는 것: removed(지운 경로) · kept(남긴 설정·상태 폴더) · foreign(표식이 없어 건드리지 않은 폴더)
//             · left(지우려 했는데 남은 경로 — 실행 명령 · app · app.new · app.old · 전용 Node(node) · 설정·상태 폴더(비어 있는데 치우지 못한 것도) · 설치 기록 · 빈 데이터 폴더)
//             · launcher('ours' → 지움 | 'foreign' → 그대로 | 'none')
const guarded = (p) => isAbsolute(p) && p.split(sep).includes('whosup')
export function removeInstall({ env = process.env, home = homedir(), platform = process.platform, purge = false } = {}) {
  if (!supported(platform)) return { state: 'unsupported', removed: [], kept: [], left: [], foreign: [] }
  const L = layout(env, home)
  const rec = readRecordFile(L.data)   // 모양만 본다: 앱 폴더가 이미 지워진 뒤(다 지우지 못해 다시 돌린 제거)에도 기록으로 찾는다
  const removed = [], kept = [], left = [], foreign = [], emptyLeft = []
  const wipe = (dir) => { try { rmSync(dir, { recursive: true, force: true }) } catch {} (existsSync(dir) ? left : removed).push(dir) }
  const launcher = launcherState(L.launcher)
  if (launcher === 'ours') { try { unlinkSync(L.launcher) } catch {} (existsSync(L.launcher) ? left : removed).push(L.launcher) }
  for (const dir of [L.app, `${L.app}.new`, `${L.app}.old`]) {
    if (!existsSync(dir)) continue
    if (guarded(dir) && appOwned(dir)) wipe(dir); else foreign.push(dir)
  }
  // 전용 Node(<데이터 폴더>/node): 프로그램 쪽이다 — --purge와 상관없이 지운다. 표식이 든 폴더만(남의 폴더는 건드리지 않고 알린다).
  // 이 제거를 돌리는 node가 그것이어도 지울 수 있다(돌고 있는 프로세스는 지워진 파일로 끝까지 돈다).
  const nodeDir = join(L.data, 'node')
  if (existsSync(nodeDir)) { if (guarded(nodeDir) && nodeOwned(nodeDir)) wipe(nodeDir); else foreign.push(nodeDir) }
  // 설정·상태 폴더: purge여도 프로그램 쪽(실행 명령·앱 폴더들)이 모두 지워졌을 때만 지운다 — 프로그램은 남았는데 설정과 기록만 사라지지 않게.
  // 앱 자리에 남의 폴더가 있으면(표식이 없다 — 건드리지 않고 남긴다) 그것도 "프로그램 쪽이 지워졌다"가 아니다: 이 기록이 그 폴더의 것인지
  // 알 수 없으므로 --purge여도 기록된 폴더를 지우지 않는다.
  const programGone = !left.length && !foreign.includes(L.app)
  // 기록에 적힌 경로는 후즈업 자신의 폴더일 때만 지운다(ownPlaces — 기록을 고쳐 다른 폴더를 가리키게 해도 그 폴더는 지우지 않는다).
  const recorded = new Set(rec ? Object.values(ownPlaces(rec, home)).filter(Boolean).map((p) => resolve(p)) : [])
  for (const dir of [...new Set([L.conf, L.state, L.freshState])]) {
    if (!existsSync(dir)) continue
    if (purge && programGone && guarded(dir) && recorded.has(resolve(dir))) wipe(dir)
    else if (readdirSync(dir).length) kept.push(dir)
    else { try { rmdirSync(dir) } catch {} if (existsSync(dir)) emptyLeft.push(dir) }   // 빈 폴더는 남길 것이 없다. 치우지 못했으면 남은 것이다(알린다)
  }
  // 설치 기록: 다 지웠을 때만 지운다(남은 것이 있으면 다시 돌릴 때 그 기록으로 찾는다). 지우지 못한 기록도 남은 것이다(left).
  if (rec && !left.length) { try { unlinkSync(L.record) } catch {} if (existsSync(L.record)) left.push(L.record) }
  // 치우지 못한 빈 설정·상태 폴더: 남은 것으로 알린다. 설치 기록을 붙잡아 두지는 않는다(프로그램은 다 지워졌고 그 폴더에는 든 것이 없다).
  left.push(...emptyLeft)
  // 빈 데이터 폴더도 치운다. 비었는데 치우지 못했으면 남은 것이다. (제거 명령은 이 폴더 안에 잠금을 쥐고 있다 — 잠금을 푼 뒤 한 번 더 본다:
  // scripts/standalone.mjs uninstall)
  try { if (guarded(L.data) && !readdirSync(L.data).length) rmdirSync(L.data) } catch { if (existsSync(L.data) && !left.includes(L.data)) left.push(L.data) }
  return { state: 'removed', removed, kept, left, foreign, launcher }
}

// ── 지금 상태(설치 요약·`whosup setup`의 마무리 문구에 싣는 값 — src/setup.mjs standaloneLines의 입력) ──
// 보드: 상태 폴더의 port(없으면 설정한 포트)에 물어 본다(scripts/launch.mjs healthy()와 같은 순서).
// "그 포트가 답한다"가 아니라 답한 것이 이 상태 폴더의 보드일 때만 떠 있는 것이다(scripts/launch.mjs boardAt — 건강 응답의 이름과 표식).
// probe = 시험이 갈아 끼우는 물음(포트 → 떠 있는가). T = 덧붙일 줄에 쓸 문구(TEXT[언어]).
export async function boardNow(L, fileEnv = {}, { probe = null } = {}) {
  const ask = probe || (async (port) => Boolean(await boardAt(`http://127.0.0.1:${port}`, L.state, { timeoutMs: 1500 })))
  const conf = /^\d{1,5}$/.test(String(fileEnv.PORT || '')) ? String(fileEnv.PORT) : '4790'
  let saved = ''
  try { saved = readFileSync(join(L.state, 'port'), 'utf8').trim() } catch {}
  for (const port of [...new Set([/^\d{1,5}$/.test(saved) ? saved : null, conf].filter(Boolean))]) {
    if (await ask(port)) return { up: true, port, url: `http://127.0.0.1:${port}` }
  }
  return { up: false, port: null, url: null }
}
// 이번 start가 브라우저를 여는가: scripts/launch.mjs openBrowser()와 같은 판정(환경변수·.env > 자동 감지 > 1, 원격이면 열지 않는다).
export function browserOpens(L, fileEnv = {}, platform = process.platform) {
  if (String(fileEnv.OPEN_BROWSER ?? readAuto(L.state)?.values?.open_browser ?? '1') !== '1') return false
  if (platform === 'darwin') return !fileEnv.SSH_CONNECTION
  return Boolean(fileEnv.DISPLAY || fileEnv.WAYLAND_DISPLAY)
}
// 보드의 자동 감지(<상태 폴더>/auto.json)가 찾은 앱 코어의 안내 줄("<앱>의 세션도 보드에 보입니다" — src/setup.mjs coreLines).
// 터미널 없이 깐 설치에는 감지를 돌린 첫 실행 안내가 없어서, 설치 요약이 보드를 켠 뒤의 감지 결과에서 이 줄을 가져온다.
// 감지가 아직 안 끝났으면(요약 없음) waitMs까지 기다려 보고, 그래도 없으면 빈 목록(그 줄 없이 간다).
// link = 깔린 앱이 ovis:// 링크를 아는가(기본은 이 기계의 앱을 보는 linkSupported — 시험이 갈아 끼운다).
export async function coreNotes(stateDir, T, { waitMs = 5000, stepMs = 250, read = readAuto, link = undefined } = {}) {
  for (const end = Date.now() + waitMs; ;) {
    const summary = read(stateDir)?.summary
    if (summary) return coreLines(summary, T, { link })
    if (Date.now() >= end) return []
    await new Promise((r) => setTimeout(r, stepMs))
  }
}
// 굳히기에서 더한 화면 문구(영어·한국어 짝 — src/setup.mjs의 TEXT와 같은 모양. 언어는 부른 쪽이 pickLang으로 고른다).
//   unsure         서비스 관리자에 물을 수 없었다(다음 줄에 손으로 확인할 명령)
//   foreignRecord  데이터 폴더에 후즈업 것이 아닌 install.json이 있다
//   stopAtUsage    (설치기 전용 명령 stop-at의 잘못된 인자)
export const HARDEN_TEXT = {
  en: {
    unsure: (name) => `Could not ask the service manager whether ${name} is still loaded (it did not answer), so that was not checked. To check yourself:`,
    foreignRecord: (f) => `${f} is there and is not a whosup install record, so it was left as it is and whosup was not installed. Move it away, then run the installer again.`,
    stopAtUsage: 'usage: whosup stop-at <state folder>',
  },
  ko: {
    unsure: (name) => `서비스 관리자에 물을 수 없어 ${name} 항목이 아직 올라와 있는지 확인하지 못했습니다. 직접 확인하려면:`,
    foreignRecord: (f) => `${f} 파일이 이미 있는데 whosup의 설치 기록이 아니어서 그대로 두었고, whosup은 설치하지 않았습니다. 그 파일을 다른 곳으로 옮긴 뒤 설치 명령을 다시 실행하세요.`,
    stopAtUsage: '사용법: whosup stop-at <상태 폴더>',
  },
}
// 실행 명령의 폴더(dir)를 PATH에 더하는 한 줄(설치 요약의 rich 화면 — install.sh의 플러그인 길 요약과 같은 모양): 사람의 셸이 새 터미널을
// 열 때 읽는 파일(SHELL — install.sh shell_rc와 같은 판정)에 export 줄을 덧붙인다. 집 폴더 안이면 $HOME/… 으로 적는다. 폴더 이름에 셸이 달리 읽을
// 글자가 있으면 null(명령 없이 안내 줄만 싣는다).
export function pathAddCmd(dir, { env = process.env, home = homedir(), platform = process.platform } = {}) {
  const safe = /^[A-Za-z0-9_@%+=:,./-]+$/
  const h = String(home || '').replace(/\/+$/, ''), d = String(dir)
  const where = h && d.startsWith(`${h}/`) && safe.test(d.slice(h.length)) ? `$HOME${d.slice(h.length)}` : safe.test(d) ? d : null
  if (!where) return null
  const sh = String(env.SHELL || '')
  let rc = '~/.profile'
  if (/(^|\/)zsh$/.test(sh)) rc = env.ZDOTDIR && env.ZDOTDIR !== home ? shown(join(env.ZDOTDIR, '.zshrc')) : '~/.zshrc'
  else if (/(^|\/)bash$/.test(sh)) rc = platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'
  return `echo 'export PATH="${where}:$PATH"' >> ${rc}`
}
// 설치 요약의 사실(standaloneFacts)에 PATH를 더하는 명령을 붙인다(rich 화면만 쓴다 — src/setup.mjs standaloneBlocks pathAdd):
// 사실의 알아 둘 것에 "실행 명령의 폴더가 PATH에 없다"는 줄이 있을 때만.
export function withPathAdd(facts, { env = process.env, home = homedir(), platform = process.platform, T = null } = {}) {
  const L = layout(env, home)
  if (!T || !(facts?.notes || []).includes(T.saPathHint(L.bin))) return facts
  return { ...facts, pathAdd: { dir: L.bin, cmd: pathAddCmd(L.bin, { env, home, platform }) } }
}
export async function standaloneFacts({ env = process.env, home = homedir(), platform = process.platform, run = ctl, probe = null, T = null } = {}) {
  const L = layout(env, home)
  const fileEnv = loadEnv(standaloneEnv(env, home))   // .env는 읽기만
  const name = commandName(L, env)
  const notes = !T ? [] : name.why === 'foreign' ? [T.saLauncherForeign(L.launcher)] : name.why === 'path' ? [T.saPathHint(L.bin)] : name.why === 'shadowed' ? [T.saShadowed(name.other)] : []
  return {
    app: L.app, board: await boardNow(L, fileEnv, { probe }), desktop: remoteWhy({ platform, env: fileEnv }) ? false : null,
    login: autostartStatus({ env, home, platform, run }).state, cmd: name.cmd, notes,
  }
}
