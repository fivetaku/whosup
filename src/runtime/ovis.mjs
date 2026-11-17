// 자기 herdr-core 코어를 띄우고 그 코어를 자기 로컬 서버로 보여 주는 데스크톱 앱(오비스 데스크톱 앱이 그런 앱이다)의 세션을
// 그 서버의 HTTP API 로 다룬다: 새 세션·닫기·터미널에 입력·그 세션의 웹 주소. 세션 목록은 여기서 읽지 않는다 — 그것은
// herdr-core 런타임(core.mjs)이 코어 소켓으로 읽는다. 이 파일은 "그 코어를 보여 주는 서버가 지금 어디 있고, 토큰 없이 조작할 수
// 있는가"와 호출 몇 개만 안다. 코어 이름·앱 이름·포트는 하나도 박혀 있지 않다(모두 넘겨받거나 그때 읽는다).
//
// 근거(2026-11-14 실기기, 오비스 데스크톱 앱 0.5.3 — evidence/air2/p4-ovis-api-facts.md 와 오비스 소스 server/*.ts):
//   서버 찾기   브리지 등록부 <설정 폴더>/bridges/*.json 가운데 살아 있는 pid 의 port(자동 감지 src/autoconf.mjs 와 같은 방식),
//               그리고 그 앱의 사용자 데이터 폴더에 있는 desktop.json 의 port. 앱을 다시 켜면 포트가 바뀐다 — 그래서 여기에는
//               기억해 두는 포트가 없다: 호출할 때마다 파일을 다시 읽고 GET /api/health 로 다시 확인한다.
//   조작 가능   GET /api/health 의 auth: 이 PC 의 루프백 요청은 { required:false, authenticated:true, via:"local", role:"drive" }.
//               들여보내지 않은 요청에는 { required:true, authenticated:false, reason } 만 주고 코어 이름도 알려 주지 않는다.
//   새 세션     POST /api/workspace/create {cwd,label} → 200 {workspace_id, pane_id, agent_started:false}
//               POST /api/tab/create {workspace_id,cwd,label} → 같은 모양. 없는 워크스페이스는 404 workspace_not_found
//   입력        POST /api/pane/input {pane_id,text} → 200 {ok:true}   (줄 끝에 \r 을 넣으면 실행된다)
//   닫기        POST /api/pane/close {pane_id} → 200 {ok:true}. 없는 대상은 404 {error:{code:"pane_not_found"}}
//   이동        앱 창 안에서 그 세션을 고르게 하는 호출은 없다(POST /api/pane/focus → 404 unsupported). 대신 브라우저로
//               http://127.0.0.1:<port>/?pane=<pane_id>&view=terminal 을 열면 그 세션의 터미널이 뜬다(paneUrl).
//               ovis:// 링크를 아는 판(아직 내지 않은 오비스 변경 — 아래 "앱 링크")은 ovis://open?pane=<pane_id>&view=terminal 을
//               열면 앱 창이 앞으로 오고 그 세션을 고른다(앱이 꺼져 있으면 켠다 — 맥북에어 실측). 0.5.3 은 이 링크를 모른다.
//   pane_id 는 코어의 터미널 주소(t1, t2 …) 그대로다.
// 지키는 것:
//   · 주소는 늘 127.0.0.1 이다. Origin·쿠키·프록시 머리말을 붙이지 않는다(붙이면 서버가 "이 PC 자신"으로 보지 않는다).
//     머리말을 정확히 쥐려고 fetch 대신 node:http 를 쓴다. 리디렉트는 따라가지 않는다. 호출마다 시간 제한이 있다.
//   · 등록 파일의 token 은 쓰지 않는다: 파일에서 port·pid 두 숫자만 정규식으로 집고 그 밖의 값은 꺼내지 않는다. 토큰이 있어야
//     들여보내는 서버면 그 기능은 이유와 함께 거절한다(findServer 의 'locked').
import { request } from 'node:http'
import { execFileSync, spawn } from 'node:child_process'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, win32 } from 'node:path'
import { platform } from '../platform.mjs'

// ── 되는 기능 ───────────────────────────────────────────────────────
// 기능 넷(new 새 세션 · focus 이동 · close 닫기 · resume 이어서 열기)마다 { means, reason? }.
//   means   app_command      herdr-app 명령(Herdr 앱의 코어 — core.mjs 가 적는다)
//           server_api       그 앱의 로컬 서버 HTTP API
//           open_url         그 세션의 웹 주소를 브라우저로 연다(앱 창 안에서 고르게 하는 수단은 없다)
//           app_link         그 앱의 링크(ovis://open?pane=…)로 앱 창에서 그 세션을 고르게 한다(그 링크를 아는 판이 깔려 있을 때)
//           app_window       그 앱의 창만 앞으로 올린다(세션은 앱 안에서 고른다)
//           terminal_window  그 세션에 붙는 터미널 창을 연다(앱 이름을 모를 때의 이동)
//           core_socket      코어 소켓에 직접(앱이 꺼져 있을 때의 닫기)
//           none             할 수단이 없다 — reason 이 까닭이다
//   reason  app_required     그 앱이 꺼져 있다(서버를 찾지 못했다): 앱을 켜면 된다
//           token_required   서버가 토큰·로그인 없이는 조작을 받지 않는다(pairing_required·watch_only 등도 이 값으로 모은다)
//           not_supported    그 코어를 다룰 수단을 모른다(보기 전용)
// means 가 none 이 아닌데 reason 이 있으면 "더 나은 수단을 못 쓰는 까닭"이다(예: 이동이 app_window 인 까닭 = app_required).
export const FEATURES = ['new', 'focus', 'close', 'resume']
export const MEANS = ['app_command', 'server_api', 'open_url', 'app_link', 'app_window', 'terminal_window', 'core_socket', 'none']
export const REASONS = ['app_required', 'token_required', 'not_supported']
const how = (means, reason = null) => (reason ? { means, reason } : { means })
export const allFeatures = (means, reason = null) => Object.fromEntries(FEATURES.map((k) => [k, how(means, reason)]))
// 자기 서버로 코어를 보여 주는 앱의 코어에서 되는 기능. 순수 함수다 — 런타임(core.mjs makeCore 의 features)이 코어 프로필에서 계산한다.
//   server  'ok'     그 코어를 보여 주는 서버가 살아 있고 토큰 없이 조작할 수 있다
//           'locked' 서버는 있는데 조작을 받지 않는다(reason — 기본 token_required)
//           'none'   서버를 찾지 못했다(앱이 꺼져 있다)
//   app     그 앱의 이름(창을 올릴 수 있는가 — 모르면 이동은 터미널 창)
//   link    깔려 있는 그 앱이 ovis:// 링크를 안다(linkSupported). 서버가 'ok' 일 때만 이동이 app_link 가 된다 — 앱이 꺼져 있거나
//           조작을 받지 않으면 예전 그대로다(이 값을 넘기지 않는 쪽 — 자동 감지가 auto.json 에 적는 값 — 도 예전 그대로다).
export function coreFeatures({ server = 'none', app = null, reason = null, link = false } = {}) {
  const win = app ? 'app_window' : 'terminal_window'
  if (server === 'ok') return { new: how('server_api'), focus: how(link === true ? 'app_link' : 'open_url'), close: how('server_api'), resume: how('server_api') }
  if (server === 'locked') {
    const why = REASONS.includes(reason) && reason !== 'app_required' ? reason : 'token_required'
    return { new: how('none', why), focus: how(win, why), close: how('none', why), resume: how('none', why) }
  }
  return { new: how('none', 'app_required'), focus: how(win, 'app_required'), close: how('core_socket'), resume: how('none', 'app_required') }
}
// 코어 프로필({ app?, url? } — 자기 서버로 보여 주는 앱의 코어, focus:false)에서 되는 기능을 계산한다. 웹 주소가 실려 있으면 그 서버가
// 이 PC 의 요청을 인증 없이 받는다(자동 감지는 그때만 주소를 싣는다) — 'ok', 없으면 'none'(앱이 꺼져 있다).
// 이 규칙은 여기 한 곳에만 있다: 자동 감지가 auto.json 의 코어 프로필에 적는 "되는 기능"(src/autoconf.mjs coreProfiles — features)과
// 런타임이 판·서버 경로에 쓰는 값(core.mjs makeCore 의 features)이 같은 함수에서 나온다. 포트·주소·토큰은 결과에 들어가지 않는다.
// link = 깔려 있는 그 앱이 ovis:// 링크를 아는가(런타임이 linkSupported 로 그때그때 본다 — 자동 감지는 넘기지 않는다).
export const profileFeatures = (profile, { link = false } = {}) => coreFeatures({ server: profile?.url ? 'ok' : 'none', app: profile?.app || null, link })

// ── 서버 찾기 ───────────────────────────────────────────────────────
// 브리지 등록부 폴더: <홈>/.config/ovis/bridges 와 옛 이름 herdr-web-ui(오비스가 실제로 쓰는 경로), XDG_CONFIG_HOME 이 다르면 그 아래도.
// src/autoconf.mjs ovisRegistryDirs 와 같은 규칙이다(그 파일은 scripts/doctor.mjs 를 거쳐 core.mjs 를 부르므로 여기서 부르지 않는다).
export function registryDirs(env = process.env, home = homedir()) {
  const bases = [...new Set([join(home, '.config'), env.XDG_CONFIG_HOME].filter(Boolean))]
  return bases.flatMap((b) => ['ovis/bridges', 'herdr-web-ui/bridges'].map((d) => join(b, d)))   // 제품이 정한 설정 폴더 이름(세션·코어 이름이 아니다)
}
// 그 앱의 사용자 데이터 폴더(Electron 의 userData = <앱 데이터 폴더>/<앱 이름>): desktop.json 이 거기 있다. 앱 이름은 넘겨받는다.
export function userDataDirs(app, env = process.env, home = homedir(), p = platform()) {
  if (!app || typeof app !== 'string' || /[\\/\0]/.test(app) || app === '.' || app === '..') return []
  if (p === 'darwin') return [join(home, 'Library', 'Application Support', app)]
  if (p === 'win32') return env.APPDATA ? [join(env.APPDATA, app)] : []
  return [...new Set([env.XDG_CONFIG_HOME, join(home, '.config')].filter(Boolean))].map((b) => join(b, app))
}
// 내 프로세스로 살아 있는 pid 인가(신호를 보낼 권한이 없는 pid 는 다른 사용자의 프로세스다 — 윈도우는 그 구분이 없다).
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' && platform() === 'win32' } }
const validPort = (n) => Number.isInteger(n) && n >= 1 && n <= 65535
// 등록 파일은 한 겹짜리 객체다. 값으로 통째로 풀지 않고(JSON.parse 를 쓰지 않는다) port·pid 두 숫자만 집는다 — 같은 파일에 적힌
// token 은 꺼내지도, 담아 두지도, 돌려주지도 않는다.
const regNumber = (key) => new RegExp(`[{,]\\s*"${key}"\\s*:\\s*(\\d{1,10})\\s*[,}]`)
const REG_PORT = regNumber('port')
const REG_PID = regNumber('pid')
const REG_OBJECT = /^\s*\{[\s\S]*\}\s*$/
const MAX_FILE = 64 * 1024
// 등록부에서 [포트]: pid 가 살아 있는 항목만. 없는 폴더·깨진 파일·죽은 pid(앱을 끈 뒤 남은 파일)는 조용히 넘어간다.
export function registryPorts(dirs, alive = pidAlive) {
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
        const st = statSync(file)
        if (!st.isFile() || st.size > MAX_FILE) continue
        const text = readFileSync(file, 'utf8')
        if (!REG_OBJECT.test(text)) continue
        const port = Number(REG_PORT.exec(text)?.[1])
        const pid = Number(REG_PID.exec(text)?.[1])
        if (!validPort(port) || !Number.isInteger(pid) || pid <= 1 || !alive(pid)) continue
        if (!out.includes(port)) out.push(port)
      } catch {}
    }
  }
  return out
}
// desktop.json = { port, server: { pid, … } | null } (token 은 없다). 서버가 내려가면 server 가 null 이 되고 port 는 남는다 —
// 그런 포트는 쓰지 않는다. server.pid 가 적혀 있으면 살아 있을 때만 쓴다.
export function desktopPort(dirs, alive = pidAlive) {
  for (const dir of dirs) {
    try {
      const file = join(dir, 'desktop.json')
      const st = statSync(file)
      if (!st.isFile() || st.size > MAX_FILE) continue
      const o = JSON.parse(readFileSync(file, 'utf8'))
      if (!o || typeof o !== 'object' || !validPort(o.port) || !o.server || typeof o.server !== 'object') continue
      if (o.server.pid != null && !(Number.isInteger(o.server.pid) && o.server.pid > 1 && alive(o.server.pid))) continue
      return o.port
    } catch {}
  }
  return null
}

// 어디를 읽을지와 기다리는 시간(ms). 시험이 임시 폴더로 바꿔 끼운다(_setLookup) — 실제 등록부·실제 앱 서버에 닿지 않게.
const LOOKUP = {
  registryDirs: () => registryDirs(),
  userDataDirs: (app) => userDataDirs(app),
  alive: pidAlive,
  healthMs: 1500,    // GET /api/health
  callMs: 5000,      // 입력·닫기
  createMs: 15000,   // 새 세션(셸만 만든다 — 에이전트를 서버에 시키지 않으므로 오래 걸리지 않는다)
}
export const _setLookup = (o) => Object.assign(LOOKUP, o)
export const _lookup = () => ({ ...LOOKUP })

// ── HTTP 한 번 ──────────────────────────────────────────────────────
const MAX_BODY = 1024 * 1024
// 서버에 닿지 못했다(연결 거절·끊김·시간 초과). timedOut = 요청이 닿았는지 알 수 없다.
const unreachable = (why, timedOut = false) => Object.assign(new Error(`the app server did not answer (${why})`), { code: 'server_unreachable', timedOut })
// 돌려주는 것: { status, json }(json 은 본문이 JSON 이 아니면 null). 닿지 못하면 code 'server_unreachable' 로 던진다.
// 보내는 머리말은 여기 적은 것과 node:http 가 붙이는 Host·Connection 뿐이다: Origin·Cookie·Authorization·X-Forwarded-* 가 없다.
function call(port, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (!validPort(port)) return reject(unreachable('no port'))
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8')
    let settled = false
    let timer = null
    const finish = (err, value) => { if (settled) return; settled = true; clearTimeout(timer); err ? reject(err) : resolve(value) }
    const req = request({
      host: '127.0.0.1', port, method, path, agent: false,
      headers: { accept: 'application/json', ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}) },
    }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => {
        size += c.length
        if (size > MAX_BODY) { req.destroy(); return finish(unreachable('reply too large')) }
        chunks.push(c)
      })
      res.on('end', () => {
        let json = null
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {}
        finish(null, { status: res.statusCode, json: json && typeof json === 'object' ? json : null })
      })
      res.on('error', (e) => finish(unreachable(e?.code || 'reply error')))
    })
    timer = setTimeout(() => { req.destroy(); finish(unreachable('no reply in time', true)) }, timeoutMs)
    req.on('error', (e) => finish(unreachable(e?.code || 'socket error')))
    req.end(payload || undefined)
  })
}

// ── 그 서버가 누구의 것이고, 조작을 받는가 ──────────────────────────
// GET /api/health. 답이 없거나 200 이 아니거나 JSON 객체가 아니면 null.
export async function health(port) {
  try { const r = await call(port, 'GET', '/api/health', undefined, LOOKUP.healthMs); return r.status === 200 ? r.json : null } catch { return null }
}
const CORE_NAME = /^[A-Za-z0-9._-]{1,80}$/
// 그 서버가 보여 주는 herdr-core 코어 이름: herdr_runtime.serving 이 "herdr-core" 일 때만 herdr_core.session 을 믿는다
// (herdr 데스크를 보여 주는 서버도 herdr_core 줄을 낸다 — src/autoconf.mjs ovisCoreName 과 같은 판정).
export function servedCore(body) {
  if (!body || typeof body !== 'object' || body.herdr_runtime?.serving !== 'herdr-core') return null
  const s = body.herdr_core?.session
  return typeof s === 'string' && CORE_NAME.test(s) && s !== '.' && s !== '..' ? s : null
}
// 토큰 없이 조작할 수 있는 서버인가: (auth.required 가 false 이거나 authenticated 가 true) 이고 role 이 "drive".
// 아니면 까닭(서버가 말한 reason, 지켜보기만 되는 역할이면 watch_only, 모양을 모르면 unknown).
export function drivable(body) {
  const a = body?.auth
  if (!a || typeof a !== 'object') return { ok: false, reason: 'unknown' }
  const let_in = a.required === false || a.authenticated === true
  if (let_in && a.role === 'drive') return { ok: true }
  return { ok: false, reason: let_in ? 'watch_only' : typeof a.reason === 'string' && /^[a-z_]{1,40}$/.test(a.reason) ? a.reason : 'token_required' }
}
// 지금 그 코어를 보여 주는 서버. 부를 때마다 파일을 다시 읽고 서버에 다시 묻는다(기억해 두는 포트가 없다).
//   { state: 'ok', port }               그 코어를 보여 준다고 답했고 토큰 없이 조작할 수 있다
//   { state: 'locked', port, reason }   그 코어의 서버인데 조작을 받지 않는다. 들여보내지 않은 요청에는 서버가 코어 이름을 알려 주지
//                                       않으므로, 그 앱의 desktop.json 이 가리키는 서버일 때만 "그 코어의 서버"로 본다
//                                       (등록부의 다른 잠긴 서버는 누구 것인지 모른다 — 이 코어 것으로 치지 않는다)
//   { state: 'none' }                   없다(앱이 꺼져 있다)
// app = 그 코어를 보여 주는 앱 이름(코어 프로필 — desktop.json 을 찾는 데만 쓴다. 모르면 등록부만 본다).
export async function findServer(coreName, { app = null } = {}) {
  let ports = [], own = null
  try { ports = registryPorts(LOOKUP.registryDirs(), LOOKUP.alive) } catch {}
  try { own = app ? desktopPort(LOOKUP.userDataDirs(app), LOOKUP.alive) : null } catch {}
  const cands = [...new Set([...ports, ...(own ? [own] : [])])]
  const bodies = await Promise.all(cands.map((port) => health(port)))
  let locked = null
  for (const [i, port] of cands.entries()) {
    const body = bodies[i]
    if (!body) continue
    const d = drivable(body)
    if (servedCore(body) === coreName) return d.ok ? { state: 'ok', port } : { state: 'locked', port, reason: d.reason }
    if (port === own && !d.ok && !locked) locked = { state: 'locked', port, reason: d.reason }
  }
  return locked || { state: 'none' }
}

// ── 호출 ────────────────────────────────────────────────────────────
// 서버가 거절한 답 → 오류. code:
//   terminal_not_found  404 pane_not_found — 그 서버가 그 터미널이 없다고 답했다(보드 서버는 이 코드일 때만 세션을 닫힘으로 옮긴다)
//   cwd_missing         400 invalid_cwd — 그 폴더가 없다(사람이 고칠 수 있는 오류: herdr 런타임과 같은 코드)
//   token_required      401·403 — 조작을 받지 않는다
//   app_server_error    그 밖(apiCode = 서버가 준 코드, status)
// 오류 문구에는 서버가 준 코드만 싣는다(경로·서버의 긴 문구는 싣지 않는다 — 문구는 보드 화면까지 간다).
const API_CODE = /^[a-z_]{1,60}$/
function refused(what, res, pane = null) {
  const apiCode = typeof res.json?.error?.code === 'string' && API_CODE.test(res.json.error.code) ? res.json.error.code : null
  const base = { status: res.status, apiCode }
  if (res.status === 404 && apiCode === 'pane_not_found') return Object.assign(new Error(`terminal not found: ${pane ?? ''}`), base, { code: 'terminal_not_found' })
  if (res.status === 400 && apiCode === 'invalid_cwd') return Object.assign(new Error('folder no longer exists (the app did not accept it)'), base, { code: 'cwd_missing' })
  if (res.status === 401 || res.status === 403) return Object.assign(new Error(`the app server did not accept ${what} without signing in`), base, { code: 'token_required' })
  return Object.assign(new Error(`the app server refused ${what} (${apiCode || `HTTP ${res.status}`})`), base, { code: 'app_server_error' })
}
const PANE = /^[A-Za-z0-9._:-]{1,64}$/
const MAX_LABEL = 80   // 서버가 받는 이름 길이(오비스 shared/labels.ts MAX_LABEL_CHARS)
// 이름으로 쓸 글자: 그 폴더의 이름. 줄바꿈 같은 제어 글자는 빼고, 길면 자른다. 빈 이름이면 보내지 않는다(서버가 폴더 이름·번호로 짓는다).
export const labelFor = (cwd) => basename(String(cwd || '').replace(/[\\/]+$/, '')).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_LABEL).trim()

// 셸 세션 하나를 만든다. workspaceId 가 있으면 그 워크스페이스의 새 탭으로, 없거나 그 워크스페이스가 이제 없으면(404
// workspace_not_found) 새 워크스페이스로. 에이전트는 서버에 시키지 않는다(agent 를 보내지 않는다) — 명령은 만든 뒤 sendInput 으로 넣는다.
// 돌려주는 것: { pane, workspace(없으면 null), fresh(새 워크스페이스로 만들었는가) }
export async function createSession(port, { cwd, label = labelFor(cwd), workspaceId = null } = {}) {
  const body = { cwd, ...(label ? { label } : {}) }
  let res = null
  if (workspaceId) {
    res = await call(port, 'POST', '/api/tab/create', { workspace_id: workspaceId, ...body }, LOOKUP.createMs)
    if (res.status === 404 && res.json?.error?.code === 'workspace_not_found') res = null
  }
  const fresh = !res
  if (!res) res = await call(port, 'POST', '/api/workspace/create', body, LOOKUP.createMs)
  if (res.status !== 200) throw refused('a new session', res)
  const pane = res.json?.pane_id
  if (typeof pane !== 'string' || !PANE.test(pane)) throw Object.assign(new Error('the app server did not say which terminal it made'), { code: 'app_server_error', status: res.status, apiCode: null })
  const ws = res.json.workspace_id
  return { pane, workspace: typeof ws === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(ws) ? ws : null, fresh }
}
// 그 터미널에 글자를 그대로 넣는다(실행하려면 text 끝에 \r). 무엇이 앞에 있는지는 서버가 가리지 않는다 — 부르는 쪽이 먼저 본다.
export async function sendInput(port, pane, text) {
  const res = await call(port, 'POST', '/api/pane/input', { pane_id: pane, text }, LOOKUP.callMs)
  if (res.status !== 200 || res.json?.ok !== true) throw refused('typing into a session', res, pane)
}
// 그 터미널을 닫는다(서버가 프로그램을 끝내고 앱의 목록에서 지운다).
export async function closePane(port, pane) {
  const res = await call(port, 'POST', '/api/pane/close', { pane_id: pane }, LOOKUP.callMs)
  if (res.status !== 200 || res.json?.ok !== true) throw refused('closing a session', res, pane)
}
// 그 세션을 브라우저에서 여는 주소(같은 컴퓨터의 브라우저 — 루프백이라 로그인을 묻지 않는다).
export const paneUrl = (port, pane) => `http://127.0.0.1:${port}/?pane=${encodeURIComponent(pane)}&view=terminal`
// 코어 프로필에 싣는 주소 틀({pane} = 터미널 주소): 보드 화면이 클릭한 자리에서 바로 여는 주소(src/settings.mjs clientDefaults).
// paneUrl 과 같은 모양이어야 한다(view=terminal 까지) — 자동 감지(src/autoconf.mjs coreProfiles)가 이 함수로 프로필의 url 을 만든다.
export const paneUrlTemplate = (port) => `http://127.0.0.1:${port}/?pane={pane}&view=terminal`
// 코어 프로필에 실려 온 주소 틀(…/?pane={pane})에 터미널 보기(view=terminal)가 빠져 있으면 붙인다. 실기기에서 그 세션의 터미널이 뜨는
// 것을 확인한 주소는 view=terminal 까지 적은 것이다(paneUrl). 자동 감지는 이제 그 마디까지 적은 틀을 싣지만(paneUrlTemplate), 예전
// 판이 적어 둔 auto.json 과 손으로 적은 프로필에는 그 마디가 없을 수 있어서 화면에 내려 주기 전에 런타임이 여기서 붙인다
// (core.mjs openUrlTemplates). 이미 view 가 있거나, pane={pane} 꼴의 질의가 아니거나(사람이 적은 다른 모양의 주소), '#' 가 든
// 틀(붙이면 그 마디가 '#' 뒤로 들어가 서버에 닿지 않는다)은 건드리지 않는다.
export function withTerminalView(template) {
  if (typeof template !== 'string' || template.includes('#')) return template
  if (!/[?&]pane=\{pane\}(&|$)/.test(template) || /[?&]view=/.test(template)) return template
  return `${template}&view=terminal`
}

// ── 앱 링크 ─────────────────────────────────────────────────────────
// 깔려 있는 그 앱이 ovis:// 링크를 알면(아직 내지 않은 오비스 변경: ovis://open?pane=<pane_id>&view=terminal|chat[&ws=…][&machine=…]),
// 그 링크를 열어 앱 창에서 그 세션을 고르게 한다 — 브라우저 탭 대신. 모르는 판(0.5.3)이면 예전 그대로 브라우저 탭이다.
// 링크를 아는지는 운영체제가 그 링크를 누구에게 넘기는지 적어 둔 곳을 읽어 가린다(판 번호를 박아 두지 않는다):
//   macOS    그 앱 묶음(<앱 이름>.app — /Applications 와 홈의 Applications)의 Contents/Info.plist 에 CFBundleURLTypes 의
//            CFBundleURLSchemes 로 ovis 가 적혀 있다. XML plist 는 그대로 읽고, 이진 plist 만 plutil 로 XML 로 바꿔 읽는다.
//            두 곳에 다 있으면 둘 다 링크를 알아야 안다고 본다: 링크는 운영체제가 고른 사본으로 가므로, 이전 버전이 켜져 있고 새 버전이
//            다른 곳에 있으면 링크가 켜져 있지 않은 사본을 하나 더 띄울 수 있다(그때는 예전처럼 브라우저 탭). 이 두 곳 밖에 깐 앱은
//            모른다고 본다(예전처럼 브라우저 탭 — 코어 프로필에는 앱 이름만 있고 묶음 경로는 없다).
//   Linux    응용 프로그램 폴더(XDG_DATA_HOME·XDG_DATA_DIRS 의 applications)의 .desktop 파일 MimeType 에 x-scheme-handler/ovis 가 있다.
//            없으면 xdg-mime query default x-scheme-handler/ovis 가 .desktop 파일 이름을 답하는지 본다.
//   Windows  HKCU\Software\Classes\ovis 에 "URL Protocol" 값이 있다(그 앱이 켜질 때 스스로 적는다 — reg query).
// 답은 기억해 둔다: macOS 는 그 Info.plist 의 경로·바뀐 때·크기마다, Linux 는 그 폴더들(과 mimeapps.list)의 바뀐 때마다,
// Windows 는 잠시(LINK.ttlMs). 앱을 새 버전으로 바꾸면 파일이 바뀌어 다시 읽는다.
// 링크는 명령 줄 문자열이 아니라 인자 배열로 연다(open · xdg-open · cmd 의 start). 셸을 거치지 않는다 — Windows 의 cmd 만은 start 가
// cmd 안의 명령이라 따옴표로 감싼 한 줄을 그대로 넘기고, 그 줄을 바꿀 수 있는 글자(" % ^ ! 줄바꿈)가 든 주소는 열지 않는다.
// Windows 의 reg·cmd 는 시스템 폴더의 것을 경로째로 부른다(맨 이름이면 현재 폴더의 같은 이름 파일이 먼저 잡힐 수 있다).
export const LINK_SCHEME = 'ovis'   // 제품이 정한 링크 이름(세션·코어 이름이 아니다)
const LINK_MIME = `x-scheme-handler/${LINK_SCHEME}`
const LINK_APP = /^[A-Za-z0-9 ._-]{1,60}$/
// Windows 시스템 폴더의 명령(<SystemRoot>\System32\<이름>). SystemRoot 가 없으면 windir, 그것도 없으면 Windows 의 기본 위치.
export const winSystemExe = (name, env = process.env) => win32.join(env.SystemRoot || env.SYSTEMROOT || env.windir || 'C:\\Windows', 'System32', name)
const LINK = {
  // 그 앱 묶음이 있을 수 있는 곳(앱 이름은 넘겨받는다). 설치기는 ~/Applications 에 놓는다.
  appBundles: (app, home = homedir()) => [join('/Applications', `${app}.app`), join(home, 'Applications', `${app}.app`)],
  // Linux 의 응용 프로그램 폴더와 mimeapps.list
  linuxDirs: (env = process.env, home = homedir()) => {
    const data = [env.XDG_DATA_HOME || join(home, '.local', 'share'), ...String(env.XDG_DATA_DIRS || '/usr/local/share:/usr/share').split(':').filter(Boolean)]
    return { apps: [...new Set(data.map((d) => join(d, 'applications')))], lists: [...new Set([env.XDG_CONFIG_HOME || join(home, '.config')].map((d) => join(d, 'mimeapps.list')))] }
  },
  // 짧게 끝나는 조회 명령(plutil · xdg-mime · reg). 끝 코드가 0 이 아니면 던진다.
  exec: (file, args) => execFileSync(file, args, { encoding: 'utf8', timeout: 3000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true, maxBuffer: 1024 * 1024 }),
  // 링크·주소를 여는 명령. 끝 코드 0 이면 열었다, 0 이 아니거나 띄우지 못하면 던진다. settleMs 안에 끝나지 않으면(xdg-open 이 그 앱이
  // 끝날 때까지 기다리는 데스크톱이 있다) 연 것으로 보고 놓아 둔다.
  launch: (file, args, opts = {}) => new Promise((resolve, reject) => {
    let done = false, timer = null, child
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v) }
    try {
      const c = spawn(file, args, { stdio: 'ignore', windowsHide: true, ...opts })
      c.on('error', (e) => end(reject, e))
      child = c
    } catch (e) { return reject(e) }
    timer = setTimeout(() => { child.unref(); end(resolve, 'running') }, LINK.settleMs)
    child.on('exit', (code) => (code === 0 ? end(resolve, 'ok') : end(reject, Object.assign(new Error(`${basename(file)} exited with ${code}`), { code: 'opener_failed' }))))
  }),
  settleMs: 3000,
  ttlMs: 60000,
  platform: () => platform(),   // 시험이 운영체제 갈래만 바꿔 끼운다(런타임 전체의 platform 은 건드리지 않는다)
  now: () => Date.now(),
}
export const _setLinkOps = (o) => Object.assign(LINK, o)
export const _linkOps = () => ({ ...LINK })
const linkCache = new Map()
export const _clearLinkCache = () => linkCache.clear()
const remember = (key, fn) => {
  if (linkCache.has(key)) return linkCache.get(key)
  let v = false
  try { v = fn() === true } catch { v = false }
  if (linkCache.size > 50) linkCache.clear()
  linkCache.set(key, v)
  return v
}
const statKey = (path) => { try { const st = statSync(path); return `${st.mtimeMs}:${st.size}` } catch { return '-' } }

// plist(XML) 글에서 CFBundleURLTypes 의 CFBundleURLSchemes 에 적힌 이름들. 모양을 모르면 [].
export function plistUrlSchemes(xml) {
  const text = String(xml || '')
  const at = text.search(/<key>\s*CFBundleURLTypes\s*<\/key>\s*<array>/)
  if (at < 0) return []
  // CFBundleURLTypes 의 배열 하나(안에 배열이 겹쳐 있다): <array> 와 </array> 를 세어 그 끝까지만 본다.
  const re = /<array\s*>|<\/array\s*>/g
  re.lastIndex = text.indexOf('<array', at)
  let depth = 0, end = -1
  for (let m; (m = re.exec(text));) { depth += m[0][1] === '/' ? -1 : 1; if (depth === 0) { end = m.index; break } }
  if (end < 0) return []
  const block = text.slice(at, end)
  const out = []
  for (const m of block.matchAll(/<key>\s*CFBundleURLSchemes\s*<\/key>\s*<array>([\s\S]*?)<\/array>/g)) {
    for (const s of m[1].matchAll(/<string>([^<]*)<\/string>/g)) out.push(s[1].trim().toLowerCase())
  }
  return out
}
// 그 앱 묶음의 Info.plist 가 ovis 링크를 적었는가.
function macBundleKnows(plist) {
  const st = statSync(plist)
  if (!st.isFile() || st.size > 4 * 1024 * 1024) return false
  const raw = readFileSync(plist)
  const xml = raw.subarray(0, 8).toString('latin1').startsWith('bplist') ? LINK.exec('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', plist]) : raw.toString('utf8')
  return plistUrlSchemes(xml).includes(LINK_SCHEME)
}
// .desktop 글의 MimeType 에 x-scheme-handler/ovis 가 있는가.
export const desktopKnows = (text) => String(text || '').split(/\r?\n/).some((l) => /^MimeType\s*=/.test(l) && l.replace(/^MimeType\s*=/, '').split(';').map((x) => x.trim()).includes(LINK_MIME))
function linuxKnows(dirs) {
  for (const dir of dirs.apps) {
    let names = []
    try { names = readdirSync(dir).filter((n) => n.endsWith('.desktop')).slice(0, 5000) } catch { continue }
    for (const n of names) {
      try { const f = join(dir, n); const st = statSync(f); if (st.isFile() && st.size <= 256 * 1024 && desktopKnows(readFileSync(f, 'utf8'))) return true } catch {}
    }
  }
  try { return /\.desktop$/.test(String(LINK.exec('xdg-mime', ['query', 'default', LINK_MIME])).trim()) } catch { return false }
}
// 깔려 있는 그 앱이 ovis:// 링크를 아는가. app = 그 코어를 보여 주는 앱 이름(macOS 에서 앱 묶음을 찾는 데만 쓴다 — 모르면 false).
// 다른 운영체제는 그 링크를 받을 앱이 등록돼 있는지를 본다(코어 프로필의 앱 이름은 macOS 에서만 실린다).
export function linkSupported(app = null, p = LINK.platform(), env = process.env, home = homedir()) {
  if (p === 'darwin') {
    if (typeof app !== 'string' || !LINK_APP.test(app) || app.trim() !== app || app === '.' || app === '..') return false
    const found = LINK.appBundles(app, home).map((b) => join(b, 'Contents', 'Info.plist')).map((plist) => [plist, statKey(plist)]).filter(([, k]) => k !== '-')
    return found.length > 0 && found.every(([plist, k]) => remember(`mac\n${plist}\n${k}`, () => macBundleKnows(plist)))
  }
  if (p === 'win32') {
    const slot = Math.floor(LINK.now() / LINK.ttlMs)
    return remember(`win\n${slot}`, () => { LINK.exec(winSystemExe('reg.exe'), ['query', `HKCU\\Software\\Classes\\${LINK_SCHEME}`, '/v', 'URL Protocol']); return true })
  }
  const dirs = LINK.linuxDirs(env, home)
  const key = ['linux', ...dirs.apps.map((d) => `${d}:${statKey(d)}`), ...dirs.lists.map((f) => `${f}:${statKey(f)}`)].join('\n')
  return remember(key, () => linuxKnows(dirs))
}
// 그 세션을 앱 창에서 고르게 하는 링크. 코어에서 읽은 터미널 주소만 받는다(모양이 다르면 null — 링크를 만들지 않는다). 값은 URL 인코딩한다.
export function appLink(pane, view = 'terminal') {
  if (typeof pane !== 'string' || !PANE.test(pane) || !['terminal', 'chat'].includes(view)) return null
  return `${LINK_SCHEME}://open?pane=${encodeURIComponent(pane)}&view=${encodeURIComponent(view)}`
}
// 그 운영체제에서 주소 하나를 여는 명령: [실행 파일, 인자 배열, spawn 옵션]. 열 수 없는 주소면 null.
//   macOS /usr/bin/open <주소> · Linux xdg-open <주소> · Windows <시스템 폴더>\cmd.exe /d /s /c "start "" "<주소>""(따옴표째로 — windowsVerbatimArguments)
// Windows: cmd 는 % 를 변수 꺼내기로 읽는다. 터미널 주소에 들 수 있는 ':'(w1:p1 꼴)의 인코딩 %3A 만은 ':' 로 되돌려 넘긴다 — 질의 값에서
// 둘은 같은 뜻이다(받는 쪽이 URL 로 풀면 같은 값). 그 밖의 % 가 든 주소는 예전처럼 열지 않는다.
export function openerFor(url, p = LINK.platform(), env = process.env) {
  if (typeof url !== 'string' || !/^(ovis|https?):\/\/[^\s]+$/.test(url) || /[\u0000-\u001f\u007f]/.test(url)) return null
  if (p === 'darwin') return ['/usr/bin/open', [url], {}]
  if (p === 'win32') {
    const u = url.replace(/%3A/gi, ':')
    return /["%^!]/.test(u) ? null : [winSystemExe('cmd.exe', env), ['/d', '/s', '/c', `"start "" "${u}""`], { windowsVerbatimArguments: true }]
  }
  return ['xdg-open', [url], {}]
}
// 주소 하나를 이 컴퓨터에서 연다(링크면 그 앱, http 주소면 기본 브라우저의 탭). 열지 못하면 던진다(code 'opener_failed' 등).
export async function openExternal(url, p = LINK.platform()) {
  const o = openerFor(url, p)
  if (!o) throw Object.assign(new Error('that address cannot be opened here'), { code: 'opener_refused' })
  return LINK.launch(...o)
}
