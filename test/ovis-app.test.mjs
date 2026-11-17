// herdr-core 런타임 — 자기 서버로 코어를 보여 주는 데스크톱 앱(오비스 데스크톱 앱 같은 것)의 세션: 새 세션·닫기·이어서 열기·이동(F18).
// 가짜 앱 서버(이 파일의 node:http 서버 — 2026-11-14 실기기에서 본 답 모양 그대로)와 가짜 코어(소켓)·가짜 herdr-app 만 쓴다.
// 실제 오비스 앱·실제 코어·이 기계의 등록부에는 닿지 않는다: 서버 찾기는 임시 폴더의 등록부·desktop.json 만 본다(ovis._setLookup).
// 포트는 운영체제가 고른다(0). 코어 이름·앱 이름은 시험이 지어낸 것이다(deskapp·Deskapp) — 코드는 어떤 이름도 알고 있지 않다.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startNamedCore, agentTerm, appTerm, term } from '../test-support/fake-core.mjs'
import { writeBridgeFile } from '../test-support/fake-ovis.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wv-'))
const STATE = join(dir, 'st')
const LOG = join(dir, 'app.log')
const SOCK_A = join(dir, 'a.sock')
const SOCK_B = join(dir, 'b.sock')
const REG = join(dir, 'cfg', 'ovis', 'bridges')              // 임시 등록부
const UD = join(dir, 'ud')                                   // 임시 "사용자 데이터 폴더"들의 부모(<UD>/<앱 이름>/desktop.json)
for (const k of ['HC_SOCKET', 'HC_SESSION', 'WHOSUP_CORES', 'XDG_RUNTIME_DIR', 'HERDR_BIN_PATH', 'HERDR_APP_NAME', 'WHOSUP_READONLY', 'WHOSUP_RUNTIMES', 'WHOSUP_CORE_TARGET', 'WHOSUP_CLICK_TARGET', 'HC_BIN']) delete process.env[k]
process.env.XDG_STATE_HOME = STATE
process.env.HERDR_APP_BIN = fileURLToPath(new URL('../test-support/fake-herdr-app.mjs', import.meta.url))
chmodSync(process.env.HERDR_APP_BIN, 0o755)
process.env.FAKE_APP_LOG = LOG
process.env.FAKE_APP_SOCKET = SOCK_A                         // 가짜 herdr-app 이 보여 주는 코어 = 기본 코어(Herdr 앱)
process.env.HERDR_BIN = join(dir, 'no-herdr')
process.env.WHOSUP_STATE_DIR = join(dir, 'state')
process.env.CLAUDE_PROJECTS_DIR = join(dir, 'claude', 'projects')
process.env.WHOSUP_NO_EVENTS = '1'
process.env.AGENT_CMD = 'claude'
mkdirSync(process.env.CLAUDE_PROJECTS_DIR, { recursive: true })
mkdirSync(REG, { recursive: true })
const WORK = join(dir, 'work'); mkdirSync(WORK)
const NOTES = join(dir, 'notes'); mkdirSync(NOTES)

const ovis = await import('../src/runtime/ovis.mjs')
const DEFAULT_LOOKUP = { registryDirs: () => [REG], userDataDirs: (app) => [join(UD, app)], healthMs: 1500, callMs: 5000, createMs: 15000 }
ovis._setLookup(DEFAULT_LOOKUP)                              // 모듈을 부르기 전에: 실제 등록부를 한 번도 읽지 않는다
// 앱 링크(ovis://): 앱 묶음은 임시 폴더에서만 찾고, 여는 명령은 띄우지 않고 적어 둔다(LAUNCHES) — 이 기계의 앱·브라우저에 닿지 않는다.
// 운영체제 갈래는 이 기계 그대로다(링크를 쓰는 시험만 'darwin' 으로 바꾼다 — 앱 묶음으로 가리는 갈래, linkApp).
const LAUNCHES = []
const APPS = join(dir, 'apps')
const LINK_BASE = { appBundles: (app) => [join(APPS, `${app}.app`)], launch: async (...a) => { LAUNCHES.push(a); return 'ok' }, platform: () => process.platform, exec: () => { throw new Error('no lookups in tests') } }
ovis._setLinkOps(LINK_BASE)
const core = await import('../src/runtime/core.mjs')
// 새 터미널의 셸이 뜨기를 기다리는 일(core.mjs shellReady)은 이 파일의 시험에서는 끈다: 가짜 코어의 화면은 비어 있어 한도까지 기다리게 된다(그 동작을 보는 시험만 켠다)
core._setShellWait({ maxMs: 0 })
const { collectAll, capsOf, deskAllowed } = await import('../src/runtime/index.mjs')
const { clearContextCache } = await import('../src/board/context.mjs')
const { setAutoValues } = await import('../src/settings.mjs')
const { openDb } = await import('../src/db.mjs')

const OTHER = 'deskapp'                                      // 앱이 따로 띄운 코어
const APP = 'Deskapp'                                        // 그 코어를 보여 주는 앱
const TOKEN = 'tok-9c41e7aa-do-not-leak'                     // 등록 파일에만 있는 값: 어디로도 나가면 안 된다
const SID = '11111111-1111-4111-8111-111111111111'
const A = await startNamedCore(STATE, 'default', SOCK_A)
let B = await startNamedCore(STATE, OTHER, SOCK_B)
const servers = new Set()
after(async () => { core.stopWatching(); setAutoValues(null); for (const s of [...servers]) await s.close(); await A.close(); await B.close() })

const noWindows = { raiseApp: async () => 'off', openWindowRunning: async () => 'off', appRunning: async () => false }
const clearDir = (d) => { try { for (const n of readdirSync(d)) unlinkSync(join(d, n)) } catch {} }
const reset = async () => {
  for (const s of [...servers]) await s.close()
  for (const f of [A, B]) { f.override = null; f.terminals.clear(); f.screens.clear(); f.calls.length = 0 }
  writeFileSync(LOG, '')
  clearDir(REG); clearDir(join(UD, APP))
  for (const k of ['FAKE_APP_MODE', 'WHOSUP_CORES', 'HC_SOCKET', 'HC_SESSION', 'HERDR_APP_NAME']) delete process.env[k]
  process.env.XDG_STATE_HOME = STATE
  setAutoValues(null)
  clearContextCache(); core._resetScreenCache(); core.stopWatching()
  core.setOpenIn('app'); core._setWindowOps(noWindows); core.keepReading([])
  ovis._setLookup(DEFAULT_LOOKUP)
  LAUNCHES.length = 0; rmSync(APPS, { recursive: true, force: true }); ovis._setLinkOps(LINK_BASE); ovis._clearLinkCache()
}
// 그 앱 묶음을 임시 폴더에 놓는다: schemes 에 ovis 가 있으면 링크를 아는 판, 없으면 0.5.3 처럼 모르는 판.
const linkApp = (schemes = ['ovis']) => {
  mkdirSync(join(APPS, `${APP}.app`, 'Contents'), { recursive: true })
  const types = schemes.length ? `<key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array>${schemes.map((x) => `<string>${x}</string>`).join('')}</array></dict></array>` : ''
  writeFileSync(join(APPS, `${APP}.app`, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleName</key><string>${APP}</string>${types}</dict></plist>\n`)
  ovis._setLinkOps({ platform: () => 'darwin' }); ovis._clearLinkCache()
}
const linkOf = (pane) => ['/usr/bin/open', [`ovis://open?pane=${pane}&view=terminal`], {}]
const tabOf = (port, pane) => ['/usr/bin/open', [paneUrl(port, pane)], {}]
let clicks = Date.now()
const seq = () => ++clicks                                    // 마지막 클릭만 이긴다: 부를 때마다 더 큰 순번
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid   // 방금 끝난 프로세스의 pid
const appCalls = () => (existsSync(LOG) ? readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const liveAddrs = (f) => [...f.terminals.values()].filter((t) => t.state === 'live').map((t) => t.address).sort()
const methods = (f) => f.calls.map((c) => c.method)
const inc = (f, addr) => String(f.terminals.get(addr).created_ms)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
// 그 앱의 코어 프로필(자동 감지가 싣는 모양): 서버가 있으면 웹 주소가 실린다.
const profile = (port = null) => ({ name: OTHER, app: APP, focus: false, ...(port ? { url: ovis.paneUrlTemplate(port) } : {}) })
const paneUrl = (port, pane) => `http://127.0.0.1:${port}/?pane=${pane}&view=terminal`

// ── 가짜 앱 서버 ──
// 답 모양은 실기기(오비스 데스크톱 앱 0.5.3)와 오비스 소스(server/dispatch.ts·workspace-routes.ts·pane-routes.ts·http.ts)를 따른다:
//   GET  /api/health            → 들여보낸 요청 { ok, herdr, auth:{required:false,authenticated:true,via:"local",role:"drive"}, security, herdr_core:{session}, herdr_runtime:{serving}, web_ui }
//                                  들여보내지 않은 요청 { ok, herdr, auth:{required:true,authenticated:false,reason}, web_ui } — 코어 이름을 알려 주지 않는다
//   POST /api/workspace/create  → 200 { workspace_id, pane_id, agent_started:false } · 없는 폴더 400 invalid_cwd
//   POST /api/tab/create        → 같은 모양 · 없는 워크스페이스 404 workspace_not_found
//   POST /api/pane/input        → 200 { ok:true } · 없는 pane 404 pane_not_found
//   POST /api/pane/close        → 200 { ok:true } · 없는 pane 404 pane_not_found
//   POST /api/pane/focus        → 404 { error:{ code:"unsupported", message:"pane.focus is not available on herdr-core" } }
// 실제 서버처럼 코어의 터미널을 만들고 끝낸다(가짜 코어의 터미널 표를 직접 고친다 — 코어가 받은 요청 기록에는 남지 않는다).
// fail(method, path) → [status, body] 를 주면 그 요청에 그 답을 한다. register:false 면 등록 파일을 쓰지 않는다.
// delay(method, path) → ms 만큼 늦게 답한다 · hang(method, path) → 참이면 답하지 않는다(시간 초과) · drop(method, path) → 참이면
// 답 없이 연결을 끊는다(그 사이 앱이 꺼졌다).
async function appServer({ fakeCore = B, coreName = OTHER, locked = false, register = true, desktop = false, regPid = process.pid } = {}) {
  const requests = []
  const boot = randomUUID()
  const auth = locked ? { required: true, authenticated: false, reason: 'token_required' } : { required: false, authenticated: true, via: 'local', role: 'drive' }
  const err = (code, message) => ({ error: { code, message } })
  const live = (id) => { const t = fakeCore.terminals.get(id); return t && t.state === 'live' ? t : null }
  const nextAddr = () => { let n = 1; while (fakeCore.terminals.has(`t${n}`)) n++; return `t${n}` }
  const api = { requests, fail: null, delay: null, hang: null, drop: null, port: 0 }
  const server = createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const url = new URL(req.url, 'http://127.0.0.1')
      const raw = Buffer.concat(chunks).toString('utf8')
      let body = null
      try { body = raw ? JSON.parse(raw) : null } catch {}
      requests.push({ method: req.method, path: url.pathname + url.search, headers: { ...req.headers }, body, raw })
      if (api.drop?.(req.method, url.pathname)) return req.socket.destroy()
      if (api.hang?.(req.method, url.pathname)) return
      const wait = api.delay?.(req.method, url.pathname) || 0
      if (wait) setTimeout(answer, wait); else answer()
     function answer() {
      if (res.destroyed || res.socket?.destroyed) return
      const json = (code, o) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)) }
      const forced = api.fail?.(req.method, url.pathname)
      if (forced) return json(forced[0], forced[1])
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const herdr = { version: '0.1.17', protocol: 22, runtime: 'herdr-core' }
        if (locked) return json(200, { ok: true, herdr, auth, web_ui: { boot_id: boot, revision: null } })
        return json(200, { ok: true, herdr, auth, security: { token_configured: false, pairing_gate: 'open', bind_scope: 'loopback', observed_ingress: 'loopback', public_exposure: 'unknown' },
          herdr_core: { version: '0.1.17', session: coreName, running: true }, herdr_runtime: { serving: 'herdr-core', source: 'env', switch_to: null, locked: 'env' }, web_ui: { boot_id: boot, revision: null } })
      }
      if (req.method !== 'POST') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>fake app server</title>') }
      if (locked) return json(401, err('unauthorized', 'sign in first'))
      if (url.pathname === '/api/workspace/create' || url.pathname === '/api/tab/create') {
        const tab = url.pathname === '/api/tab/create'
        if (tab && (typeof body?.workspace_id !== 'string' || !body.workspace_id.trim())) return json(400, err('missing_workspace_id', 'workspace_id is required'))
        if (typeof body?.cwd !== 'string' || !existsSync(body.cwd)) return json(400, err('invalid_cwd', 'cwd must be an existing directory'))
        if (typeof body.label === 'string' && body.label.length > 80) return json(400, err('label_too_long', 'label must be at most 80 characters'))
        if (tab && ![...fakeCore.terminals.values()].some((t) => t.state === 'live' && t.labels['herdr.space'] === body.workspace_id)) return json(404, err('workspace_not_found', `workspace ${body.workspace_id} not found`))
        const space = tab ? body.workspace_id : `ovis-${randomUUID()}`
        const address = nextAddr()
        fakeCore.add(term(address, { cwd: body.cwd, created_ms: Date.now() + Number(address.slice(1)), keep: true,
          foreground: { argv: ['/bin/zsh', '-l'], cwd: body.cwd, name: 'zsh', pid: 90000 + Number(address.slice(1)) },
          labels: { 'herdr.space': space, 'herdr.tab': `ovis-${randomUUID()}`, 'herdr.seen': '0', ...(body.label ? { [tab ? 'ovis.tab' : 'ovis.workspace']: body.label } : {}) } }))
        return json(200, { workspace_id: space, pane_id: address, agent_started: false })
      }
      if (url.pathname === '/api/pane/input') {
        if (typeof body?.pane_id !== 'string' || !body.pane_id.trim()) return json(400, err('missing_pane_id', 'pane_id is required'))
        if (typeof body.text !== 'string') return json(400, err('missing_text', 'text is required'))
        if (!live(body.pane_id)) return json(404, err('pane_not_found', `pane ${body.pane_id} not found`))
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/pane/close') {
        if (typeof body?.pane_id !== 'string' || !body.pane_id.trim()) return json(400, err('missing_pane_id', 'pane_id is required'))
        const t = live(body.pane_id)
        if (!t) return json(404, err('pane_not_found', `pane ${body.pane_id} not found`))
        Object.assign(t, { state: 'finished', reason: 'killed', exit_code: 1, finished_ms: Date.now() })
        return json(200, { ok: true })
      }
      if (url.pathname === '/api/pane/focus') return json(404, err('unsupported', 'pane.focus is not available on herdr-core'))
      return json(404, err('not_found', 'no such route'))
     }
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  api.port = server.address().port
  // 등록 파일의 socket_path 는 코어의 소켓이 아니라 앱이 따로 여는 <사용자 데이터 폴더>/server/herdr-core.sock 이다(실물 그대로).
  api.registryFile = register ? writeBridgeFile(REG, { port: api.port, pid: regPid, token: TOKEN, socketPath: join(UD, APP, 'server', 'herdr-core.sock') }) : null
  if (desktop) { mkdirSync(join(UD, APP), { recursive: true }); writeFileSync(join(UD, APP, 'desktop.json'), JSON.stringify({ port: api.port, server: { pid: process.pid, bun: '/fake/bun', started: new Date().toISOString() } })) }
  api.posts = () => requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body])
  api.gets = () => requests.filter((r) => r.method === 'GET').map((r) => r.path)
  // 앱을 끈다: 서버가 내려가고 등록 파일이 사라진다(실기기 — Cmd+Q). desktop.json 은 server:null 로 남는다.
  api.close = async () => {
    if (!servers.has(api)) return
    servers.delete(api)
    server.closeAllConnections?.()
    await new Promise((r) => server.close(r))
    if (api.registryFile) { try { unlinkSync(api.registryFile) } catch {} }
    if (desktop) { try { writeFileSync(join(UD, APP, 'desktop.json'), JSON.stringify({ port: api.port, server: null })) } catch {} }
  }
  servers.add(api)
  return api
}
// 그 서버가 받은 요청 전부: 주소는 127.0.0.1, Origin·쿠키·Authorization·프록시 머리말이 없고, 등록 파일의 token 이 어디에도 없다.
function assertPlainLoopback(S) {
  for (const r of S.requests) {
    assert.equal(r.headers.host, `127.0.0.1:${S.port}`, `${r.method} ${r.path}`)
    for (const h of ['origin', 'cookie', 'authorization', 'referer', 'sec-fetch-site', 'x-forwarded-for', 'x-forwarded-proto', 'x-forwarded-host', 'forwarded']) assert.equal(r.headers[h], undefined, `${r.method} ${r.path} sent ${h}`)
    assert.ok(!JSON.stringify(r).includes(TOKEN), `${r.method} ${r.path} carried the registry token`)
    if (r.method === 'POST') assert.match(r.headers['content-type'], /^application\/json/)
  }
}

test('① 새 세션: 그 앱의 서버에 셸 세션을 만들어 달라고 한 뒤(cwd·label) 그 터미널에 명령을 입력한다. 데스크가 그 앱의 워크스페이스면 새 탭으로, 없어졌으면 새 워크스페이스로', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' } }))

  // 공간 밖 데스크(그 앱에 새 데스크): 조작할 수 있는 서버인지 먼저 묻고 → 만들고 → 입력한다
  const r = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false })
  assert.equal(S.requests[0].method + ' ' + S.requests[0].path, 'GET /api/health', '조작하기 전에 서버에 먼저 묻는다')
  assert.deepEqual(S.posts(), [['/api/workspace/create', { cwd: WORK, label: basename(WORK) }], ['/api/pane/input', { pane_id: r.pane, text: 'claude\r' }]])
  const made = B.terminals.get(r.pane)
  assert.deepEqual([made.state, made.cwd], ['live', WORK])
  assert.deepEqual([r.session, r.client, r.window, r.means, r.url], [`core:${OTHER}@${made.labels['herdr.space']}`, 'running', 'skipped', 'server_api', paneUrl(S.port, r.pane)])
  assert.ok(core.isDesk(r.session))
  // 에이전트는 서버에 시키지 않는다(agent 를 보내지 않는다) — 명령은 후즈업의 문자열 그대로 터미널에 넣는다
  assert.equal(S.requests.some((q) => q.raw.includes('"agent"')), false)
  // 그 코어의 소켓에는 만들기·입력이 가지 않았다(서버가 했다). 기본 코어(Herdr 앱)와 herdr-app 은 건드리지 않았다
  assert.deepEqual(methods(B).filter((m) => ['terminal.run', 'terminal.send', 'terminal.kill'].includes(m)), [])
  assert.deepEqual([A.touched(), appCalls()], [[], []])

  // 그 워크스페이스의 데스크에 더하기: 새 탭(workspace_id 와 함께), 같은 데스크 열쇠가 돌아온다
  S.requests.length = 0
  const r2 = await core.newSession({ session: r.session, cwd: NOTES, command: 'codex', raise: false })
  assert.deepEqual(S.posts(), [['/api/tab/create', { workspace_id: made.labels['herdr.space'], cwd: NOTES, label: basename(NOTES) }], ['/api/pane/input', { pane_id: r2.pane, text: 'codex\r' }]])
  assert.deepEqual([r2.session, r2.pane !== r.pane, liveAddrs(B)], [r.session, true, [r.pane, r2.pane].sort()])

  // 그 워크스페이스가 이제 없으면(404 workspace_not_found) 새 워크스페이스로 만든다
  S.requests.length = 0
  const r3 = await core.newSession({ session: `core:${OTHER}@ovis-00000000-gone`, cwd: WORK, command: 'claude', raise: false })
  assert.deepEqual(S.posts().map((p) => p[0]), ['/api/tab/create', '/api/workspace/create', '/api/pane/input'])
  assert.equal(r3.session, `core:${OTHER}@${B.terminals.get(r3.pane).labels['herdr.space']}`)
  assert.notEqual(r3.session, `core:${OTHER}@ovis-00000000-gone`)

  // 명령이 없으면 만들기만 한다. 없는 폴더는 서버에 묻기도 전에 거절한다(사람이 고칠 수 있는 오류)
  S.requests.length = 0
  await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, raise: false })
  assert.deepEqual(S.posts().map((p) => p[0]), ['/api/workspace/create'])
  S.requests.length = 0
  await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: join(dir, 'nope'), command: 'claude', raise: false }), (e) => e.code === 'cwd_missing')
  assert.deepEqual(S.requests, [])
  // 터미널은 만들었는데 명령이 들어가지 않았으면 그렇다고 알린다(조용히 성공으로 넘기지 않는다)
  S.fail = (m, p) => (p === '/api/pane/input' ? [500, { error: { code: 'internal_error', message: 'internal error (abc)' } }] : null)
  await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false }), (e) => e.code === 'app_server_error' && /opened a terminal \(t\d+\) but could not type/.test(e.message))
  S.fail = null
  await S.close()                                             // 받은 요청을 다 본 뒤에 끈다
  assertPlainLoopback(S)
})

test('② 닫기: 그 세션의 터미널임을 코어에서 확인한 뒤(created_ms) 그 앱의 서버에 닫아 달라고 한다(pane_id = 터미널 주소). 서버가 닫지 못하면 코어에서 직접 끝낸다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'working', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' } }))
  B.add(agentTerm('t1', 'working', { labels: appTerm('t0').labels, cwd: WORK })); B.add(appTerm('t2', { cwd: WORK })); B.add(appTerm('t3', { cwd: WORK }))

  const r = await core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') })
  assert.deepEqual(r, { pane: 't1', means: 'server_api' })
  assert.deepEqual(S.posts(), [['/api/pane/close', { pane_id: 't1' }]])
  assert.deepEqual([methods(B), liveAddrs(B)], [['terminal.get'], ['t2', 't3']], '코어에는 확인(terminal.get)만 갔다 — 끝내기는 서버가 했다')
  assert.deepEqual([A.touched(), appCalls(), liveAddrs(A)], [[], [], ['t1']], '같은 주소 t1 의 기본 코어 세션은 그대로다')

  // 그 주소가 다른 터미널에 넘어갔으면(created_ms 가 다르다) 닫지 않는다: 서버에 묻지도 않는다. 이미 끝난 터미널도 같다
  S.requests.length = 0; B.calls.length = 0
  await assert.rejects(core.closePane(`${OTHER}/t2`, { incarnation: '1' }), (e) => e.code === 'terminal_not_found')
  await assert.rejects(core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') }), (e) => e.code === 'terminal_not_found')
  assert.deepEqual([S.requests, liveAddrs(B)], [[], ['t2', 't3']])

  // 서버가 닫지 못했다(그런 pane 이 없다고 답했다 · 오류로 답했다): 코어에서 직접 끝낸다 — 끝내기 바로 전에 그 세션의 터미널임을
  // 이 코어에서 한 번 더 확인한다(terminal.get 이 두 번: 처음 확인, 서버가 닫지 못한 뒤의 확인)
  for (const [addr, answer] of [['t2', [404, { error: { code: 'pane_not_found', message: 'pane t2 not found' } }]], ['t3', [500, { error: { code: 'internal_error', message: 'internal error (abc)' } }]]]) {
    S.requests.length = 0; B.calls.length = 0
    S.fail = (m, p) => (p === '/api/pane/close' ? answer : null)
    assert.deepEqual(await core.closePane(`${OTHER}/${addr}`, { incarnation: inc(B, addr) }), { pane: addr, means: 'core_socket' })
    assert.deepEqual([S.posts().map((p) => p[0]), methods(B)], [['/api/pane/close'], ['terminal.get', 'terminal.get', 'terminal.kill']])
  }
  assert.deepEqual(liveAddrs(B), [])

  // 서버가 닫지 못한 그 사이에 그 세션이 끝나고 같은 주소가 다른 터미널(다른 세션)에 넘어갔다: 코어에서 끝내지 않는다 —
  // 코어의 terminal.kill 은 주소만 보므로, 다시 확인하지 않으면 그 주소를 물려받은 세션을 끝낸다. 처음 확인한 터미널(created_ms)과
  // 견준다: 세션의 incarnation 을 넘기지 않은 요청도 같다(처음 읽은 그 터미널이 기준이다).
  for (const [addr, opts] of [['t4', (c) => ({ incarnation: String(c) })], ['t5', () => ({})]]) {
    B.add(appTerm(addr, { cwd: WORK }))
    const first = B.terminals.get(addr).created_ms
    S.requests.length = 0; B.calls.length = 0
    S.fail = (m, p) => {
      if (p !== '/api/pane/close') return null
      B.terminals.delete(addr); B.add(appTerm(addr, { cwd: NOTES, created_ms: first + 5000 }))   // 서버가 답하기 직전: 그 주소의 주인이 바뀌었다
      return [500, { error: { code: 'internal_error', message: 'internal error (abc)' } }]
    }
    await assert.rejects(core.closePane(`${OTHER}/${addr}`, opts(first)), (e) => e.code === 'terminal_not_found' && /another terminal/.test(e.message))
    assert.deepEqual([S.posts().map((p) => p[0]), methods(B)], [['/api/pane/close'], ['terminal.get', 'terminal.get']], '끝내기(terminal.kill)는 가지 않았다')
    const now = B.terminals.get(addr)
    assert.deepEqual([now.state, now.created_ms, now.cwd], ['live', first + 5000, NOTES], '그 주소를 물려받은 세션은 그대로 살아 있다')
  }
  // 서버가 오류로 답했지만 그 사이 그 터미널은 끝나 있다(서버가 실제로는 닫았다 · 사람이 닫았다): 다시 끝내지 않고 "이미 없다"로 답한다
  B.add(appTerm('t6', { cwd: WORK }))
  S.requests.length = 0; B.calls.length = 0
  S.fail = (m, p) => {
    if (p !== '/api/pane/close') return null
    Object.assign(B.terminals.get('t6'), { state: 'finished', reason: 'killed', exit_code: 1, finished_ms: Date.now() })
    return [500, { error: { code: 'internal_error', message: 'internal error (abc)' } }]
  }
  await assert.rejects(core.closePane(`${OTHER}/t6`, { incarnation: inc(B, 't6') }), (e) => e.code === 'terminal_not_found')
  assert.deepEqual(methods(B), ['terminal.get', 'terminal.get'])
  assert.deepEqual(liveAddrs(B), ['t4', 't5'])
  S.fail = null
  await S.close()
  assertPlainLoopback(S)
})

test('③ 이어서 열기: 그 세션의 터미널 앞에 한가한 셸이 있으면 그 터미널에 "<명령> --resume <대화 id>" 를 입력한다. 다른 프로그램이 앞에 있으면 넣지 않는다. 터미널이 없으면 새 세션을 만들어 같은 명령을 넣는다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK })); B.add(agentTerm('t2', 'working', { labels: appTerm('t0').labels, cwd: WORK }))
  const run = `claude --resume ${SID}`

  // (가) 살아 있는 셸 터미널: 서버로 입력한다(줄 끝의 \r 이 실행). 코어의 terminal.send 는 쓰지 않는다
  const r = await core.focus(`${OTHER}/t1`, { run, raise: false, incarnation: inc(B, 't1') })
  assert.deepEqual(S.posts(), [['/api/pane/input', { pane_id: 't1', text: `${run}\r` }]])
  assert.deepEqual([r.pane, r.window, r.url, B.sent()], ['t1', 'skipped', paneUrl(S.port, 't1'), []])
  // 다른 프로그램(에이전트)이 앞에 있다: 입력하지 않는다 — 서버를 찾기도 전에 거절한다
  S.requests.length = 0
  await assert.rejects(core.focus(`${OTHER}/t2`, { run, raise: false, incarnation: inc(B, 't2') }), /t2 is not at a shell prompt/)
  // 주소가 다른 터미널에 넘어갔으면 넣지 않는다
  await assert.rejects(core.focus(`${OTHER}/t1`, { run, raise: false, incarnation: '1' }), (e) => e.code === 'terminal_not_found')
  assert.deepEqual([S.requests, B.sent()], [[], []])
  // 입력하려는 순간 서버가 그 pane 이 없다고 답했다: 그 터미널이 없다는 오류(보드 서버가 세션을 닫힘으로 옮기는 코드)
  S.fail = (m, p) => (p === '/api/pane/input' ? [404, { error: { code: 'pane_not_found', message: 'pane t1 not found' } }] : null)
  await assert.rejects(core.focus(`${OTHER}/t1`, { run, raise: false }), (e) => e.code === 'terminal_not_found')
  S.fail = null

  // (나) 터미널이 없다(닫힌 세션): 보드 서버는 그 데스크에 새 세션을 열어 같은 명령을 넣는다(resumeSession 의 닫힌 세션 길)
  const desk = `core:${OTHER}@${appTerm('t0').labels['herdr.space']}`
  S.requests.length = 0
  const n = await core.newSession({ session: desk, cwd: WORK, command: run, raise: false })
  assert.deepEqual(S.posts(), [['/api/tab/create', { workspace_id: appTerm('t0').labels['herdr.space'], cwd: WORK, label: basename(WORK) }], ['/api/pane/input', { pane_id: n.pane, text: `${run}\r` }]])
  assert.deepEqual([n.session, B.sent()], [desk, []])
  await S.close()
  assertPlainLoopback(S)
})

test('④ 이동: 서버가 살아 있으면 그 세션의 웹 주소(이번에 찾은 포트)를 돌려준다 — 앱 창 안에서 고르게 하는 호출(pane/focus)은 보내지 않는다. 서버를 못 찾으면 예전처럼 앱 창 올리기뿐이다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(agentTerm('t1', 'working', { labels: appTerm('t0').labels, cwd: WORK }))
  const seen = []
  core._setWindowOps({ appRunning: async (n) => { seen.push(['running?', n]); return true }, raiseApp: async (n, split, o) => { seen.push(['raise', n, o]); return 'raised' }, openWindowRunning: async () => { seen.push(['terminal']); return 'opened' } })

  // 창을 올리지 않는 클릭(브라우저가 탭을 연다): 주소만 돌려준다
  const a = await core.focus(`${OTHER}/t1`, { raise: false, seq: seq(), incarnation: inc(B, 't1') })
  assert.deepEqual([a.window, a.url, a.app, seen], ['skipped', paneUrl(S.port, 't1'), APP, []])
  // 창을 올려 달라는 클릭: 예전처럼 그 앱 창을 올리고(앱 안의 세션은 고르지 못한다), 주소도 함께 돌려준다
  const b = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([b.window, b.url, seen], ['app_only', paneUrl(S.port, 't1'), [['running?', APP], ['raise', APP, { launch: false }]]])
  // 서버에는 살아 있는지 묻기만 했다: 조작 요청이 하나도 없다(pane/focus 는 그 앱이 받지 않는다 — 404 unsupported)
  assert.deepEqual([S.posts(), [...new Set(S.gets())]], [[], ['/api/health']])
  assert.deepEqual(methods(B).filter((m) => m !== 'terminal.get'), [])
  assert.equal(core.featuresOf(`${OTHER}/t1`).focus.means, 'open_url')

  // 프로필의 주소가 낡았어도(앱을 다시 켜 포트가 바뀌었다) 돌려주는 주소는 이번에 찾은 서버의 것이다
  setAutoValues({ cores: [profile(S.port === 48001 ? 48002 : 48001)] })
  assert.equal((await core.focus(`${OTHER}/t1`, { raise: false, seq: seq() })).url, paneUrl(S.port, 't1'))

  // 앱을 껐다(서버가 없다): 주소가 없다. 창을 올려 달라는 클릭은 예전의 앱 창 올리기 길 그대로다(앱이 꺼져 있으면 그렇다고 알린다)
  await S.close()
  assertPlainLoopback(S)
  setAutoValues({ cores: [profile()] })
  seen.length = 0
  const c = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([c.window, c.url, seen.map((x) => x[0])], ['app_only', undefined, ['running?', 'raise']])
  core._setWindowOps({ appRunning: async () => false })
  assert.deepEqual([(await core.focus(`${OTHER}/t1`, { seq: seq() })).window, (await core.focus(`${OTHER}/t1`, { seq: seq(), raise: false })).url], ['app_closed', undefined])
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`).focus, { means: 'app_window', reason: 'app_required' })
})

test('⑤ 서버가 없다(앱이 꺼져 있다): 닫기는 코어 소켓으로 직접 한다. 새 세션·이어서 열기는 그 앱을 켜야 한다는 까닭 코드와 함께 거절한다(코어에 직접 만들지 않는다)', async () => {
  await reset()
  setAutoValues({ cores: [profile()] })
  B.add(appTerm('t1', { cwd: WORK })); B.add(appTerm('t2', { cwd: WORK })); B.add(appTerm('t3', { cwd: WORK }))
  const desk = `core:${OTHER}@${appTerm('t0').labels['herdr.space']}`
  const needsApp = (e) => e.code === 'app_required' && e.app === APP && e.message.includes(APP)

  // 새 세션·이어서 열기: 거절(조용히 실패하지 않는다). 코어에는 확인(terminal.get) 말고 아무것도 가지 않는다
  await assert.rejects(core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false }), needsApp)
  await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false }), needsApp)
  await assert.rejects(core.focus(`${OTHER}/t1`, { run: `claude --resume ${SID}`, raise: false, incarnation: inc(B, 't1') }), needsApp)
  assert.deepEqual([methods(B), liveAddrs(B)], [['terminal.get'], ['t1', 't2', 't3']])
  // 서버의 첫 문이 미리 답하는 까닭(refusalOf)은 일을 시켰을 때 런타임이 던지는 거절과 같다: 같은 코드·앱 이름·문구
  for (const [why, doIt] of [[core.refusalOfDesk(desk), () => core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false })], [core.refusalOf(`${OTHER}/t1`, 'resume'), () => core.focus(`${OTHER}/t1`, { run: 'claude', raise: false })]]) {
    const thrown = await doIt().catch((e) => e)
    assert.deepEqual([thrown.code, thrown.app, thrown.message], [why.code, why.app, why.message])
  }
  assert.equal(core.refusalOf(`${OTHER}/t1`, 'close'), null)
  // 닫기: 코어 소켓 직결(terminal.kill) — 그 세션의 터미널임을 확인한 뒤에
  B.calls.length = 0
  assert.deepEqual(await core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') }), { pane: 't1', means: 'core_socket' })
  assert.deepEqual([B.calls.map((c) => [c.method, c.params.terminal]), liveAddrs(B)], [[['terminal.get', 't1'], ['terminal.get', 't1'], ['terminal.kill', 't1']], ['t2', 't3']])   // 확인 두 번: 처음, 끝내기 바로 전
  await assert.rejects(core.closePane(`${OTHER}/t2`, { incarnation: '1' }), (e) => e.code === 'terminal_not_found')
  assert.deepEqual(liveAddrs(B), ['t2', 't3'])
  // 데스크 끄고 켜기는 이 코어에서 열지 않았다
  await assert.rejects(core.stopSession(desk), (e) => e.code === 'not_supported')
  await assert.rejects(core.startSession(desk, undefined, { raise: false }), (e) => e.code === 'not_supported')

  // 등록 파일은 남았는데 그 pid 가 죽었다(앱을 끈 뒤의 찌꺼기): 그 포트에 무엇이 듣고 있어도 묻지 않는다
  const stale = await appServer({ regPid: deadPid() })
  assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'none' })
  assert.deepEqual(await core.closePane(`${OTHER}/t2`, { incarnation: inc(B, 't2') }), { pane: 't2', means: 'core_socket' })
  assert.deepEqual(stale.requests, [])
  await stale.close()
  // 다른 코어를 보여 주는 서버만 있다: 이 코어의 서버가 아니다(그 서버에 조작을 보내지 않는다)
  const foreign = await appServer({ coreName: 'someoneelse' })
  await assert.rejects(core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false }), needsApp)
  assert.deepEqual([foreign.posts(), liveAddrs(B)], [[], ['t3']])
  await foreign.close()

  // 그 코어마저 꺼져 있을 때의 이어서 열기: "앱이 꺼져 있다"는 창 결과가 아니라 거절로 답한다(넣은 줄 알지 않게)
  await B.close()
  try {
    await assert.rejects(core.focus(`${OTHER}/t3`, { run: 'claude', raise: false }), needsApp)
    assert.equal((await core.focus(`${OTHER}/t3`, { raise: false })).window, 'app_closed')   // 그냥 이동은 예전 답 그대로
  } finally { B = await startNamedCore(STATE, OTHER, SOCK_B) }
})

test('⑥ 토큰이 있어야 조작을 받는 서버: 새 세션·닫기·이어서 열기를 까닭 코드와 함께 거절한다. 등록 파일의 token 은 읽어 쓰지 않고, 코어 소켓으로 비켜 가지도 않는다', async () => {
  await reset()
  // 들여보내지 않은 요청에는 서버가 코어 이름을 알려 주지 않는다: 그 앱의 desktop.json 이 가리키는 서버라서 그 코어의 서버로 안다
  const S = await appServer({ locked: true, desktop: true })
  setAutoValues({ cores: [profile()] })                      // 자동 감지도 그런 서버의 웹 주소는 싣지 않는다
  B.add(appTerm('t1', { cwd: WORK }))
  const desk = `core:${OTHER}@${appTerm('t0').labels['herdr.space']}`
  assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'locked', port: S.port, reason: 'token_required' })
  const locked = (e) => e.code === 'token_required' && e.app === APP
  await assert.rejects(core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false }), locked)
  await assert.rejects(core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') }), locked)
  await assert.rejects(core.focus(`${OTHER}/t1`, { run: 'claude', raise: false }), locked)
  // 이동: 그 서버의 주소는 로그인을 물으므로 돌려주지 않는다(앱 창 올리기 길로 간다)
  assert.equal((await core.focus(`${OTHER}/t1`, { raise: false, seq: seq() })).url, undefined)
  // 서버에는 묻기(GET /api/health)만 갔다. token 을 실은 요청이 없고, 터미널은 그대로다(코어 소켓으로 끝내지 않았다)
  assert.deepEqual([S.posts(), [...new Set(S.gets())], liveAddrs(B), methods(B).filter((m) => m !== 'terminal.get')], [[], ['/api/health'], ['t1'], []])
  assertPlainLoopback(S)
  assert.ok(readFileSync(S.registryFile, 'utf8').includes(TOKEN), '등록 파일에는 token 이 있다(읽어 쓰지 않았을 뿐이다)')
  assert.deepEqual(ovis.registryPorts([REG]), [S.port], '등록부에서 꺼내는 것은 포트뿐이다')

  // 살아 있다고 답한 서버가 조작 요청에는 401 로 답한다(그 사이 잠겼다): 같은 까닭으로 거절하고, 닫기도 비켜 가지 않는다
  await S.close()
  const T = await appServer()
  T.fail = (m) => (m === 'POST' ? [401, { error: { code: 'unauthorized', message: 'sign in first' } }] : null)
  await assert.rejects(core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false }), locked)
  await assert.rejects(core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') }), locked)
  assert.deepEqual([liveAddrs(B), methods(B).includes('terminal.kill')], [['t1'], false])
  await T.close()

  // 누구 것인지 알 수 없는 잠긴 서버(등록부에만 있고 그 앱의 desktop.json 이 가리키지 않는다): 이 코어의 서버로 치지 않는다
  const U = await appServer({ locked: true })
  assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'none' })
  assert.deepEqual(U.posts(), [])
  await U.close()
})

test('⑦ 포트를 기억해 두지 않는다: 앱을 다시 켜 포트가 바뀌면 다음 요청은 새 서버로 간다. 등록부가 없어도 그 앱의 desktop.json 으로 찾는다', async () => {
  await reset()
  const S1 = await appServer()
  setAutoValues({ cores: [profile(S1.port)] })
  const r1 = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false })
  assert.equal(S1.posts().length, 2)
  const before = S1.requests.length
  await S1.close()                                            // 앱을 끈다

  const S2 = await appServer()                                // 다시 켰다: 다른 포트, 등록 파일도 새로
  assert.notEqual(S2.port, S1.port)
  const r2 = await core.newSession({ session: r1.session, cwd: WORK, command: 'claude', raise: false })   // 프로필(자동 감지)은 아직 옛 포트다
  assert.deepEqual([S1.requests.length, S2.posts().map((p) => p[0]), r2.url], [before, ['/api/tab/create', '/api/pane/input'], paneUrl(S2.port, r2.pane)])
  await core.closePane(`${OTHER}/${r2.pane}`, { incarnation: inc(B, r2.pane) })
  assert.deepEqual(S2.posts().at(-1), ['/api/pane/close', { pane_id: r2.pane }])
  await S2.close()

  // 등록 파일이 없고 desktop.json 만 있다: 그 포트의 서버가 이 코어를 보여 준다고 답하면 쓴다. server 가 null 이면(꺼진 앱) 쓰지 않는다
  const S3 = await appServer({ register: false, desktop: true })
  assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'ok', port: S3.port })
  assert.deepEqual(await ovis.findServer(OTHER), { state: 'none' }, '앱 이름을 모르면 desktop.json 을 찾을 수 없다(등록부만 본다)')
  const r3 = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, raise: false })
  assert.deepEqual(S3.posts().map((p) => p[0]), ['/api/workspace/create'])
  assert.ok(r3.pane)
  await S3.close()
  assert.deepEqual(JSON.parse(readFileSync(join(UD, APP, 'desktop.json'), 'utf8')).server, null)
  assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'none' })
})

test('⑧ Herdr 앱 코어와 수단을 모르는 코어는 예전 그대로다: 그 앱 서버가 떠 있어도 기본 코어의 조작은 herdr-app 으로만 가고, 프로필이 없는 코어는 보기 전용이다', async () => {
  await reset()
  const S = await appServer()
  const SPACE = { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: WORK })); A.add(term('t2', { labels: SPACE, cwd: WORK }))
  B.add(appTerm('t1', { cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const doCalls = () => appCalls().filter((a) => a[0] === 'do').map((a) => a[1])

  // 기본 코어(Herdr 앱): 닫기·이동·새 세션이 herdr-app 으로 간다. 앱 서버에는 한 번도 묻지 않는다
  writeFileSync(LOG, ''); S.requests.length = 0
  await core.focus('default/t1', { raise: false })
  await core.closePane('default/t1', { incarnation: inc(A, 't1') })
  await core.newSession({ session: 'core:spA', cwd: WORK, command: 'claude', raise: false })
  assert.deepEqual(doCalls().slice(0, 2), ['pane.focus', 'pane.close'])
  assert.ok(doCalls().includes('tab.new'))
  assert.deepEqual(S.requests, [])
  assert.equal(core.canManage('default/t2'), true)
  assert.deepEqual(core.featuresOf('default/t2'), { new: { means: 'app_command' }, focus: { means: 'app_command' }, close: { means: 'app_command' }, resume: { means: 'app_command' } })
  assert.deepEqual(core.capsVia('default/t2'), ['close', 'resume', 'new'])

  // 자기 서버로 보여 주는 앱의 코어: "전부 된다"(데스크 끄고 켜기까지)는 아니다 — 기능별 값이 따로 있다
  assert.equal(core.canManage(`${OTHER}/t1`), false)
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`), { new: { means: 'server_api' }, focus: { means: 'open_url' }, close: { means: 'server_api' }, resume: { means: 'server_api' } })
  assert.deepEqual([core.capsVia(`${OTHER}/t1`), core.canNewIn(`core:${OTHER}@`), core.canManageDesk(`core:${OTHER}@`)], [['close', 'resume', 'new'], true, false])
  // 새 세션을 열 수 있는 데스크: 판에 있는 그 코어의 데스크와 "그 앱에 새 데스크" 자리. herdr-app 의 공간도 예전처럼 나온다.
  // 그 앱의 데스크는 기능별 문을 연 서버가 청했을 때만(perFeature) 나온다 — 아래 "새 세션 대상 목록과 서버의 문" 시험
  const DESK_B = `core:${OTHER}@${appTerm('t0').labels['herdr.space']}`
  assert.deepEqual((await core.targets([{ key: DESK_B, label: `${APP} · work` }], { perFeature: true })).map((t) => [t.key, t.label, t.kind]),
    [[DESK_B, `${APP} · work`, undefined], [`core:${OTHER}@`, APP, 'new_desk'], ['core:spA', 'my project', undefined]])
  // 할 수 없는 까닭(서버의 첫 문이 그대로 답하는 값): 되는 기능은 null
  assert.deepEqual([core.refusalOf('default/t2', 'close'), core.refusalOf(`${OTHER}/t1`, 'close'), core.refusalOf(`${OTHER}/t1`, 'resume'), core.refusalOfDesk(`core:${OTHER}@`), core.refusalOfDesk('core:spA')], [null, null, null, null, null])

  // 앱이 꺼져 있을 때 프로필이 말하는 것(웹 주소가 없다): 닫기는 코어 소켓, 새 세션·이어서 열기는 까닭과 함께 없음
  setAutoValues({ cores: [profile()] })
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`), { new: { means: 'none', reason: 'app_required' }, focus: { means: 'app_window', reason: 'app_required' }, close: { means: 'core_socket' }, resume: { means: 'none', reason: 'app_required' } })
  assert.deepEqual([core.capsVia(`${OTHER}/t1`), core.canNewIn(DESK_B)], [['close'], false])
  assert.deepEqual((await core.targets([{ key: DESK_B, label: 'x' }], { perFeature: true })).map((t) => t.key), ['core:spA'])
  // 까닭: 일을 시켰을 때 런타임이 던지는 거절과 같은 코드·같은 앱 이름이다. 닫기는 된다(코어 소켓)
  const whyNew = core.refusalOfDesk(DESK_B), whyResume = core.refusalOf(`${OTHER}/t1`, 'resume')
  assert.deepEqual([whyNew.code, whyNew.app, whyNew.message.includes(APP), whyResume.code, whyResume.app, core.refusalOf(`${OTHER}/t1`, 'close')], ['app_required', APP, true, 'app_required', APP, null])

  // 프로필이 없는 코어(사람이 WHOSUP_CORES 로 짚었다)와 focus 를 적지 않은 코어: 그 이름의 서버가 떠 있어도 보기 전용이다
  for (const cores of [null, [{ name: OTHER, app: APP }]]) {
    setAutoValues(cores ? { cores } : null)
    if (cores) delete process.env.WHOSUP_CORES; else process.env.WHOSUP_CORES = OTHER
    S.requests.length = 0; B.calls.length = 0
    const no = (e) => e.code === 'not_supported'
    await assert.rejects(core.closePane(`${OTHER}/t1`), no)
    await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false }), no)
    await assert.rejects(core.focus(`${OTHER}/t1`, { run: 'claude', raise: false }), no)
    assert.equal((await core.focus(`${OTHER}/t1`, { raise: false, seq: seq() })).url, undefined)
    assert.deepEqual([S.requests, methods(B).filter((m) => m !== 'terminal.get'), liveAddrs(B)], [[], [], ['t1']])
    assert.deepEqual([core.capsVia(`${OTHER}/t1`), core.featuresOf(`${OTHER}/t1`).close], [[], { means: 'none', reason: 'not_supported' }])
    assert.deepEqual(['close', 'resume', 'new'].map((cap) => core.refusalOf(`${OTHER}/t1`, cap).code).concat(core.refusalOfDesk(`core:${OTHER}@`).code), ['not_supported', 'not_supported', 'not_supported', 'not_supported'])
    assert.deepEqual(capsOf({ runtime: 'herdr-core', runtime_ref: `${OTHER}/t1`, fields_json: '{}' }), ['focus', 'web'])
  }
  delete process.env.WHOSUP_CORES
  // 읽지 않는 코어의 세션: 넷 다 없다
  assert.deepEqual(core.featuresOf('nosuchcore/t1'), ovis.allFeatures('none', 'not_supported'))
  assert.deepEqual([core.refusalOf('nosuchcore/t1', 'close').code, core.refusalOfDesk('core:nosuchcore@').code], ['not_supported', 'not_supported'])
  await S.close()
})

test('새 세션 대상 목록과 서버의 문은 함께 열린다: 기능별 문을 열었다고 청하지 않으면(perFeature) 그 앱의 데스크와 "새 데스크" 자리를 내놓지 않는다 — 눌러도 거절뿐인 대상이 새 세션 창에 뜨지 않는다 (R1)', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }, cwd: WORK }))
  B.add(appTerm('t1', { cwd: WORK }))
  const DESK_B = `core:${OTHER}@${appTerm('t0').labels['herdr.space']}`
  const known = [{ key: DESK_B, label: `${APP} · work` }, { key: 'core:spA', label: 'my project' }]
  // 그 코어에서는 새 세션이 된다(런타임은 할 수 있다) — 그래도 청하지 않은 목록에는 없다: 예전 목록 그대로다
  assert.deepEqual([core.canNewIn(DESK_B), core.canNewIn(`core:${OTHER}@`)], [true, true])
  const plain = await core.targets(known)
  assert.deepEqual(plain.map((t) => [t.key, t.kind]), [['core:spA', undefined]])
  // 청하지 않고 받은 대상은 모두 "전부 되는 코어"의 데스크다: 기능별 문을 모르는 서버(deskAllowed(desk))도 거절하지 않는다
  for (const t of plain) assert.equal(core.canManageDesk(t.key), true, t.key)
  for (const t of plain) assert.equal(deskAllowed(t.key), true, t.key)
  // 청하면: 그 앱의 데스크와 새 데스크 자리가 더해진다. 그 대상은 모두 새 세션이 되는 데스크다(canNewIn — 기능별 문이 보는 값)
  const wide = await core.targets(known, { perFeature: true })
  assert.deepEqual(wide.map((t) => [t.key, t.kind]), [[DESK_B, undefined], ['core:spA', undefined], [`core:${OTHER}@`, 'new_desk']])
  for (const t of wide) assert.equal(core.canManageDesk(t.key) || core.canNewIn(t.key), true, t.key)
  // 기능별 문은 새 세션에만 열린다: 데스크 끄고 켜기(cap 을 주지 않거나 'toggle')는 그 앱의 데스크에 닫혀 있다 — 서버의 /api/desk 첫 문이 이 값이다
  for (const k of [DESK_B, `core:${OTHER}@`]) assert.deepEqual([deskAllowed(k), deskAllowed(k, 'toggle'), deskAllowed(k, 'new')], [false, false, true], k)
  assert.deepEqual([deskAllowed('core:spA'), deskAllowed('core:spA', 'new'), deskAllowed('main'), deskAllowed('main', 'new')], [true, true, true, true], 'Herdr 앱 코어의 데스크와 herdr 데스크는 예전 그대로')
  assert.deepEqual(S.posts(), [], '목록을 만드는 데 그 앱의 서버를 조작하지 않는다')
  await S.close()
})

test('그 앱의 코어 이름이 기본 코어 이름과 같아도(프로필 focus:false) 닫기는 그 앱의 서버로 가고, 서버가 없으면 이 코어의 소켓으로 간다 — herdr-app 의 pane 닫기로 가지 않는다', async () => {
  await reset()
  const S = await appServer({ fakeCore: A, coreName: 'default' })
  setAutoValues({ cores: [{ name: 'default', app: APP, focus: false, url: ovis.paneUrlTemplate(S.port) }] })
  A.add(appTerm('t1', { cwd: WORK })); A.add(appTerm('t2', { cwd: WORK }))
  assert.deepEqual(await core.closePane('default/t1', { incarnation: inc(A, 't1') }), { pane: 't1', means: 'server_api' })
  assert.deepEqual([S.posts(), methods(A), appCalls(), liveAddrs(A)], [[['/api/pane/close', { pane_id: 't1' }]], ['terminal.get'], [], ['t2']])
  await S.close()
  assertPlainLoopback(S)
  // 그 앱이 꺼졌다: 코어 소켓으로 직접(그 세션의 터미널임을 확인한 뒤). herdr-app 은 여전히 불리지 않는다
  setAutoValues({ cores: [{ name: 'default', app: APP, focus: false }] })
  A.calls.length = 0
  assert.deepEqual(await core.closePane('default/t2', { incarnation: inc(A, 't2') }), { pane: 't2', means: 'core_socket' })
  assert.deepEqual([A.calls.map((c) => [c.method, c.params.terminal]), appCalls(), liveAddrs(A)], [[['terminal.get', 't2'], ['terminal.get', 't2'], ['terminal.kill', 't2']], [], []])
})

test('Herdr 앱의 코어: 앱의 pane 닫기가 실패한 뒤 코어에서 직접 끝내기 전에 그 터미널을 다시 확인한다 — 그 사이 같은 주소가 다른 터미널에 넘어갔으면 끝내지 않는다', async () => {
  await reset()
  const SPACE = { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }
  A.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: WORK })); A.add(agentTerm('t2', 'idle', { labels: SPACE, cwd: WORK }))
  const first = A.terminals.get('t1').created_ms
  // 앱이 pane 을 닫다 실패한다(코어가 그 끝내기를 거절했다) — 바로 그 순간 그 주소의 주인이 바뀐다. 거절은 한 번뿐: 그 뒤의 끝내기는 그대로 통한다
  let swapped = false
  A.override = (m, p) => {
    if (m !== 'terminal.kill' || p.terminal !== 't1' || swapped) return undefined
    swapped = true
    A.terminals.delete('t1'); A.add(agentTerm('t1', 'idle', { labels: SPACE, cwd: NOTES, created_ms: first + 5000 }))
    return `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } })}\n`
  }
  try {
    await assert.rejects(core.closePane('default/t1', { incarnation: String(first) }), (e) => e.code === 'terminal_not_found' && /another terminal/.test(e.message))
  } finally { A.override = null }
  assert.deepEqual(appCalls().filter((a) => a[0] === 'do').map((a) => a[1]), ['pane.close'], '앱에 pane 닫기를 시켰다(실패했다)')
  assert.deepEqual(A.calls.filter((c) => c.method === 'terminal.kill'), [], '코어의 끝내기(terminal.kill)는 가지 않았다')
  assert.deepEqual(A.calls.filter((c) => c.method === 'terminal.get').map((c) => c.params.terminal), ['t1', 't1'], '확인 두 번: 처음, 끝내기 바로 전')
  const now = A.terminals.get('t1')
  assert.deepEqual([now.state, now.created_ms, now.cwd, liveAddrs(A)], ['live', first + 5000, NOTES, ['t1', 't2']], '그 주소를 물려받은 세션은 그대로 살아 있다')
  // 주인이 바뀌지 않았으면 예전처럼 코어에서 끝낸다(앱이 실패해도)
  swapped = false
  A.override = (m, p) => (m === 'terminal.kill' && p.terminal === 't2' && !swapped ? (swapped = true, `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'busy' } })}\n`) : undefined)
  try {
    A.calls.length = 0
    assert.deepEqual(await core.closePane('default/t2', { incarnation: inc(A, 't2') }), { pane: 't2' })
  } finally { A.override = null }
  assert.deepEqual(A.calls.map((c) => [c.method, c.params.terminal]).filter(([m]) => m !== 'terminal.list'), [['terminal.get', 't2'], ['terminal.get', 't2'], ['terminal.kill', 't2']])
  assert.deepEqual(liveAddrs(A), ['t1'])
})

test('이동 클릭의 순번: 그 앱의 서버가 늦게 답해도 먼저 누른 클릭이 나중 클릭보다 뒤에 창을 올리지 않는다 — 서버 찾기를 창 올리기 앞에서 기다리지 않는다 (R2)', async () => {
  await reset()
  const S = await appServer()
  S.delay = (m, p) => (p === '/api/health' ? 700 : 0)          // 바쁜 서버: health 에 늦게 답한다
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }, cwd: WORK }))
  B.add(agentTerm('t1', 'working', { labels: appTerm('t0').labels, cwd: WORK }))
  const moved = []                                             // 창이 움직인 순서
  core._setWindowOps({ appRunning: async () => true, raiseApp: async (n) => { moved.push(`raise ${n}`); return 'raised' }, openWindowRunning: async () => { moved.push('terminal window'); return 'opened' } })
  const t0 = Date.now()
  let healthAt = null
  const older = core.focus(`${OTHER}/t1`, { seq: seq() })      // 먼저 누른 클릭: 그 앱의 세션
  older.then(() => { healthAt = Date.now() - t0 })
  const raisedSoon = async () => { for (let i = 0; i < 40 && !moved.length; i++) await sleep(10) }   // 서버의 답(700ms)보다 한참 앞에서 그만 기다린다
  await raisedSoon()
  assert.deepEqual(moved, [`raise ${APP}`], '먼저 누른 클릭의 창은 서버의 답을 기다리지 않고 바로 올라왔다')
  const newer = await core.focus('default/t1', { seq: seq() }) // 나중에 누른 클릭: 다른 코어(Herdr 앱)의 세션
  const first = await older
  assert.deepEqual(moved, [`raise ${APP}`, `raise ${core.appName()}`], '나중에 누른 클릭의 창이 마지막에 올라온다(앞에 남는다)')
  assert.deepEqual([first.window, first.url, newer.window], ['app_only', paneUrl(S.port, 't1'), 'raised'], '주소는 창을 올린 뒤에 받아 결과에 싣는다')
  assert.ok(healthAt >= 600, `먼저 누른 클릭의 답은 서버의 답을 기다렸다(${healthAt}ms)`)
  // 서버의 답을 기다리는 사이 들어온 더 새 클릭이 있어도, 창을 이미 올린 클릭이 뒤늦게 창을 다시 올리지 않는다
  moved.length = 0
  const again = core.focus(`${OTHER}/t1`, { seq: seq() })
  await raisedSoon()
  await core.focus('default/t1', { seq: seq() })
  await again
  assert.deepEqual(moved, [`raise ${APP}`, `raise ${core.appName()}`])
  S.delay = null
  await S.close()
  assertPlainLoopback(S)
})

test('이어서 열기: 서버를 찾는 사이 그 터미널 앞에 다른 프로그램이 왔거나 주소가 다른 터미널에 넘어갔으면 넣지 않는다 — 넣기 바로 전에 이 코어에서 다시 본다 (R4)', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK })); B.add(appTerm('t2', { cwd: WORK }))
  const run = `claude --resume ${SID}`
  // 서버가 health 에 답하는 순간(= 런타임이 서버를 기다리는 동안) 사람이 그 터미널에서 다른 프로그램을 띄웠다
  S.fail = (m, p) => { if (p === '/api/health') B.terminals.get('t1').foreground = { argv: ['vim', 'notes.txt'], cwd: WORK, name: 'vim', pid: 71001 }; return null }
  await assert.rejects(core.focus(`${OTHER}/t1`, { run, raise: false, incarnation: inc(B, 't1') }), /t1 is not at a shell prompt/)
  assert.deepEqual([S.posts(), B.sent(), methods(B)], [[], [], ['terminal.get', 'terminal.get']], '서버에 입력을 보내지 않았다. 코어에는 확인만 두 번 갔다')
  // 그 사이 터미널이 끝나고 같은 주소가 새 터미널에 넘어갔다(created_ms 가 다르다): 그 터미널에 넣지 않는다
  const was = inc(B, 't2')
  S.fail = (m, p) => { if (p === '/api/health') B.terminals.get('t2').created_ms = Number(was) + 5000; return null }
  await assert.rejects(core.focus(`${OTHER}/t2`, { run, raise: false, incarnation: was }), (e) => e.code === 'terminal_not_found')
  assert.deepEqual([S.posts(), B.sent()], [[], []])
  // 그대로 한가한 셸이면 넣는다(다시 보는 것이 넣기를 막지 않는다)
  S.fail = null
  await core.focus(`${OTHER}/t2`, { run, raise: false, incarnation: inc(B, 't2') })
  assert.deepEqual(S.posts(), [['/api/pane/input', { pane_id: 't2', text: `${run}\r` }]])
  await S.close()
  assertPlainLoopback(S)
})

test('그 앱의 서버가 시간 안에 답하지 않았다: "앱이 꺼져 있다"가 아니라 "됐는지 모른다"(app_no_answer)로 알린다. 답 없이 끊긴 연결은 앱이 꺼진 것이다. 닫기는 코어에서 마저 한다 (R5)', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK })); B.add(appTerm('t2', { cwd: WORK }))
  ovis._setLookup({ createMs: 200, callMs: 200 })
  const unsure = (e) => e.code === 'app_no_answer' && e.app === APP && e.message.includes(APP) && /may or may not have been done/.test(e.message)
  const needsApp = (e) => e.code === 'app_required' && e.app === APP
  try {
    // 새 세션: 만들기 요청에 답이 없다 — 서버 쪽에서는 만들어졌을 수 있다. 명령 입력은 보내지 않았다
    S.hang = (m, p) => p === '/api/workspace/create'
    await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false }), unsure)
    assert.deepEqual(S.posts().map((p) => p[0]), ['/api/workspace/create'])
    // 이어서 열기: 입력 요청에 답이 없다 — 들어갔는지 모른다
    S.requests.length = 0
    S.hang = (m, p) => p === '/api/pane/input'
    await assert.rejects(core.focus(`${OTHER}/t1`, { run: 'claude', raise: false, incarnation: inc(B, 't1') }), unsure)
    assert.deepEqual([S.posts().map((p) => p[0]), B.sent()], [['/api/pane/input'], []])
    // 닫기: 답이 없으면 이 코어에서 직접 끝낸다(닫기는 두 번 해도 결과가 같다)
    S.hang = (m, p) => p === '/api/pane/close'
    assert.deepEqual(await core.closePane(`${OTHER}/t1`, { incarnation: inc(B, 't1') }), { pane: 't1', means: 'core_socket' })
    assert.deepEqual(liveAddrs(B), ['t2'])
    // 답 없이 연결이 끊겼다(방금 답한 서버가 그 사이 내려갔다): 그 앱을 켜야 한다고 알린다 — "됐는지 모른다"가 아니다
    S.hang = null
    S.drop = (m, p) => m === 'POST'
    await assert.rejects(core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false }), needsApp)
    await assert.rejects(core.focus(`${OTHER}/t2`, { run: 'claude', raise: false, incarnation: inc(B, 't2') }), needsApp)
    S.drop = null
  } finally { ovis._setLookup(DEFAULT_LOOKUP) }
  await S.close()
  assertPlainLoopback(S)
})

test('자동 감지 목록에서 빠져 붙잡아 둔 코어(열린 세션이 남아 있다)는 마지막 프로필이 없어도 "앱이 꺼진 코어"로 다룬다: 닫기는 그 세션의 터미널임을 확인한 뒤 코어 소켓으로, 새 세션·이어서 열기는 만들지 않고 거절한다 (R7)', async () => {
  await reset()
  const HELD = 'heldcore'                                      // 이 프로세스의 자동 감지에 한 번도 나온 적 없는 코어(보드를 다시 켠 뒤와 같다)
  const C = await startNamedCore(STATE, HELD, join(dir, 'c.sock'))
  try {
    C.add(appTerm('t1', { cwd: WORK })); C.add(appTerm('t2', { cwd: WORK }))
    core.keepReading([HELD])                                   // 수집이 알려 준다: 그 코어에 열린 세션이 남아 있다
    const desk = `core:${HELD}@${appTerm('t0').labels['herdr.space']}`
    assert.deepEqual(core.featuresOf(`${HELD}/t1`), ovis.coreFeatures({ server: 'none', app: null }))
    assert.deepEqual([core.capsVia(`${HELD}/t1`), core.canManage(`${HELD}/t1`), core.canNewIn(desk)], [['close'], false, false])
    // 닫기: 주소가 다른 터미널에 넘어갔으면 끝내지 않는다. 그 세션의 터미널이면 코어 소켓으로 끝낸다
    await assert.rejects(core.closePane(`${HELD}/t1`, { incarnation: '1' }), (e) => e.code === 'terminal_not_found')
    assert.deepEqual(liveAddrs(C), ['t1', 't2'])
    assert.deepEqual(await core.closePane(`${HELD}/t1`, { incarnation: inc(C, 't1') }), { pane: 't1', means: 'core_socket' })
    assert.deepEqual(liveAddrs(C), ['t2'])
    // 새 세션·이어서 열기·데스크 끄기: 그 코어에 아무것도 만들거나 넣지 않는다. 앱 이름은 모르므로 싣지 않는다
    C.calls.length = 0
    const needsApp = (e) => e.code === 'app_required' && e.app === null
    await assert.rejects(core.newSession({ session: desk, cwd: WORK, command: 'claude', raise: false }), needsApp)
    await assert.rejects(core.focus(`${HELD}/t2`, { run: 'claude', raise: false }), needsApp)
    await assert.rejects(core.stopSession(desk), (e) => e.code === 'not_supported')
    assert.deepEqual([methods(C), liveAddrs(C)], [['terminal.get'], ['t2']])
    // 사람이 읽을 코어를 정했으면(WHOSUP_CORES) 붙잡아 두지 않는다: 그 코어는 예전처럼 보기 전용이다(닫기도 거절)
    process.env.WHOSUP_CORES = HELD
    await assert.rejects(core.closePane(`${HELD}/t2`, { incarnation: inc(C, 't2') }), (e) => e.code === 'not_supported')
    assert.deepEqual(liveAddrs(C), ['t2'])
  } finally { delete process.env.WHOSUP_CORES; core.keepReading([]); await C.close() }
})

test('되는 기능 계산(coreFeatures)과 서버 판정: 순수 함수의 값, 토큰 없이 조작할 수 있는 서버의 조건', () => {
  const F = (o) => ovis.coreFeatures(o)
  assert.deepEqual(F({ server: 'ok', app: APP }), { new: { means: 'server_api' }, focus: { means: 'open_url' }, close: { means: 'server_api' }, resume: { means: 'server_api' } })
  assert.deepEqual(F({ server: 'none', app: APP }), { new: { means: 'none', reason: 'app_required' }, focus: { means: 'app_window', reason: 'app_required' }, close: { means: 'core_socket' }, resume: { means: 'none', reason: 'app_required' } })
  assert.deepEqual(F({ server: 'none' }).focus, { means: 'terminal_window', reason: 'app_required' }, '앱 이름을 모르면 이동은 터미널 창이다')
  assert.deepEqual(F({ server: 'locked', app: APP, reason: 'pairing_required' }), { new: { means: 'none', reason: 'token_required' }, focus: { means: 'app_window', reason: 'token_required' }, close: { means: 'none', reason: 'token_required' }, resume: { means: 'none', reason: 'token_required' } })
  assert.deepEqual(F(), F({ server: 'none' }))
  for (const v of Object.values(F({ server: 'ok' })).concat(Object.values(F({ server: 'none' })), Object.values(F({ server: 'locked' })))) {
    assert.ok(ovis.MEANS.includes(v.means)); assert.ok(v.reason === undefined || ovis.REASONS.includes(v.reason))
    assert.ok(v.means !== 'none' || v.reason, '수단이 없으면 까닭이 있다')
  }
  // 되는 기능은 프로필의 값 셋(focus·url·app)에서만 계산한다: 프로필에 features 를 따로 실어도 읽지 않는다(실어 나르는 길이 없다)
  assert.equal(ovis.cleanFeatures, undefined)

  // 토큰 없이 조작할 수 있는 서버: (required 가 false 이거나 authenticated 가 true) 이고 role 이 drive
  assert.deepEqual(ovis.drivable({ auth: { required: false, authenticated: true, via: 'local', role: 'drive' } }), { ok: true })
  assert.deepEqual(ovis.drivable({ auth: { required: false, via: 'local', role: 'drive' } }), { ok: true })
  assert.deepEqual(ovis.drivable({ auth: { authenticated: true, via: 'device', role: 'drive' } }), { ok: true })
  assert.deepEqual(ovis.drivable({ auth: { required: false, authenticated: true, via: 'portal', role: 'watch' } }), { ok: false, reason: 'watch_only' })
  assert.deepEqual(ovis.drivable({ auth: { required: true, authenticated: false, reason: 'pairing_required' } }), { ok: false, reason: 'pairing_required' })
  assert.deepEqual(ovis.drivable({ auth: { required: true, authenticated: false } }), { ok: false, reason: 'token_required' })
  assert.deepEqual(ovis.drivable({ auth: { via: 'local', role: 'drive' } }), { ok: false, reason: 'token_required' }, '들여보냈다는 말이 없으면 조작할 수 있다고 보지 않는다')
  for (const odd of [null, {}, { auth: 'yes' }]) assert.deepEqual(ovis.drivable(odd), { ok: false, reason: 'unknown' })
  // 그 서버가 보여 주는 코어 이름: herdr-core 를 보여 준다고 한 서버의 것만 믿는다(herdr 데스크를 보여 주는 서버도 herdr_core 줄을 낸다)
  assert.equal(ovis.servedCore({ herdr_runtime: { serving: 'herdr-core' }, herdr_core: { session: 'abc' } }), 'abc')
  assert.equal(ovis.servedCore({ herdr_runtime: { serving: 'herdr' }, herdr_core: { session: 'default' } }), null)
  for (const odd of [null, {}, { herdr_runtime: { serving: 'herdr-core' } }, { herdr_runtime: { serving: 'herdr-core' }, herdr_core: { session: '../x' } }, { herdr_runtime: { serving: 'herdr-core' }, herdr_core: { session: '..' } }]) assert.equal(ovis.servedCore(odd), null)
  // 주소와 이름
  assert.equal(ovis.paneUrl(48123, 't7'), 'http://127.0.0.1:48123/?pane=t7&view=terminal')
  assert.equal(ovis.paneUrlTemplate(48123).replace('{pane}', 't7'), ovis.paneUrl(48123, 't7'))
  assert.deepEqual([ovis.labelFor('/a/b/my proj/'), ovis.labelFor('/'), ovis.labelFor(`/a/${'x'.repeat(200)}`).length], ['my proj', '', 80])
})

test('서버 찾기: 등록부의 죽은 pid·깨진 파일은 넘어가고, 답하지 않는 포트는 시간 안에 포기한다. 꺼진 앱의 desktop.json(server:null·죽은 pid)은 쓰지 않는다', async () => {
  await reset()
  const reg = join(dir, 'reg-unit'); mkdirSync(reg, { recursive: true })
  writeBridgeFile(reg, { port: 48011, pid: process.pid, token: TOKEN, socketPath: '/x/one.sock' })
  writeBridgeFile(reg, { port: 48012, pid: deadPid(), token: TOKEN, socketPath: '/x/two.sock' })
  writeFileSync(join(reg, 'broken.json'), '{ "port": 48013, "pid": ')
  writeFileSync(join(reg, 'array.json'), JSON.stringify([{ port: 48014, pid: process.pid }]))
  writeFileSync(join(reg, 'quoted.json'), JSON.stringify({ note: '"port": 48015, "pid": 1', token: TOKEN }))
  writeFileSync(join(reg, 'notes.txt'), '{"port":48016,"pid":1}')
  assert.deepEqual(ovis.registryPorts([reg, join(dir, 'no-such-dir'), reg]), [48011])
  assert.deepEqual(ovis.registryDirs({ XDG_CONFIG_HOME: '/x/cfg' }, '/home/u'), ['/home/u/.config/ovis/bridges', '/home/u/.config/herdr-web-ui/bridges', '/x/cfg/ovis/bridges', '/x/cfg/herdr-web-ui/bridges'])
  // 사용자 데이터 폴더: 운영체제마다, 앱 이름은 넘겨받은 것. 경로가 될 수 없는 이름은 받지 않는다
  assert.deepEqual(ovis.userDataDirs('Deskapp', {}, '/home/u', 'darwin'), ['/home/u/Library/Application Support/Deskapp'])
  assert.deepEqual(ovis.userDataDirs('Deskapp', { XDG_CONFIG_HOME: '/x/cfg' }, '/home/u', 'linux'), ['/x/cfg/Deskapp', '/home/u/.config/Deskapp'])
  assert.deepEqual(ovis.userDataDirs('Deskapp', { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }, 'C:\\Users\\u', 'win32').length, 1)
  for (const bad of [null, '', '..', 'a/b', 'a\\b']) assert.deepEqual(ovis.userDataDirs(bad, {}, '/home/u', 'darwin'), [])
  const ud = join(dir, 'ud-unit'); mkdirSync(ud, { recursive: true })
  const desk = (o) => { writeFileSync(join(ud, 'desktop.json'), typeof o === 'string' ? o : JSON.stringify(o)); return ovis.desktopPort([join(dir, 'no-such-dir'), ud]) }
  assert.equal(desk({ port: 48021, server: { pid: process.pid } }), 48021)
  assert.equal(desk({ port: 48021, server: {} }), 48021)
  assert.equal(desk({ port: 48021, server: null }), null)
  assert.equal(desk({ port: 48021, server: { pid: deadPid() } }), null)
  assert.equal(desk({ port: 70000, server: { pid: process.pid } }), null)
  assert.equal(desk('{ nope'), null)

  // 접속은 받지만 답하지 않는 포트: 정해 둔 시간 안에 포기하고 "없다"로 답한다(보드가 멈추지 않는다)
  const held = new Set()
  const silent = createNetServer((sock) => { held.add(sock); sock.on('error', () => {}); sock.on('close', () => held.delete(sock)) })
  await new Promise((r) => silent.listen(0, '127.0.0.1', r))
  try {
    clearDir(REG)
    writeBridgeFile(REG, { port: silent.address().port, pid: process.pid, token: TOKEN, socketPath: '/x/silent.sock' })
    ovis._setLookup({ healthMs: 150 })
    const t0 = Date.now()
    assert.deepEqual(await ovis.findServer(OTHER, { app: APP }), { state: 'none' })
    assert.ok(Date.now() - t0 < 1500)
    assert.equal(await ovis.health(silent.address().port), null)
  } finally { for (const sock of held) sock.destroy(); await new Promise((r) => silent.close(r)); ovis._setLookup(DEFAULT_LOOKUP) }
  // 아무도 듣지 않는 포트·틀린 포트: 조용히 없다
  assert.deepEqual([await ovis.health(1), await ovis.health(0), await ovis.health('x')], [null, null, null])
  await assert.rejects(ovis.sendInput(0, 't1', 'x'), (e) => e.code === 'server_unreachable')
})

// ── 보드 서버·화면까지 (F18 이음: runtime/index.mjs · board/board.mjs · board/server.mjs · board/index.html) ──
// 보드 서버의 API 를 끝에서 끝까지 본다: 요청(브라우저가 보내는 모양) → 보드 서버 → 런타임 → 가짜 앱 서버가 받은 호출·가짜 코어가 받은 요청.
const { homedir } = await import('node:os')
const { createBoardServer, clientDefaultsOf, _clearInflight, _clearResumeHolds } = await import('../src/board/server.mjs')
const { computeBoardAsync } = await import('../src/board/board.mjs')
const { clientDefaults, setSettings } = await import('../src/settings.mjs')
const HTML = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const SPACE_B = appTerm('t0').labels['herdr.space']
const DESK_B = `core:${OTHER}@${SPACE_B}`
// 예전 판의 자동 감지가 실은 모양의 프로필: 주소 틀에 터미널 보기(view=terminal)가 없다. 지금의 자동 감지는 그 마디까지 적지만
// (src/autoconf.mjs coreProfiles — ovis.paneUrlTemplate), 예전 auto.json 이 남아 있을 때도 같은 동작인지 이 모양으로 본다.
const plainProfile = (port) => ({ name: OTHER, app: APP, focus: false, url: `http://127.0.0.1:${port}/?pane={pane}` })
// 대화 기록 하나(이어서 열 대상): <CLAUDE_PROJECTS_DIR>/<폴더>/<대화 id>.jsonl
const transcript = (sid, cwd) => { const d = join(process.env.CLAUDE_PROJECTS_DIR, cwd.replace(/[^A-Za-z0-9]/g, '-')); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${sid}.jsonl`), `${JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { content: 'hello' } })}\n`) }
async function boardFor(db) {
  _clearInflight(); _clearResumeHolds()   // 앞 시험의 연타 방지·대화 잡아 두기가 새 DB 의 같은 번호 세션에 걸리지 않게
  const server = createBoardServer(db)
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const at = `http://127.0.0.1:${server.address().port}`
  const said = []   // 보드 서버가 내놓은 답 전부(글자 그대로): 토큰·포트가 새지 않는지 볼 때 쓴다
  const get = async (path) => { const r = await fetch(`${at}${path}`); const text = await r.text(); said.push(text); return JSON.parse(text) }
  const post = async (path, body) => { const r = await fetch(`${at}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ raise: false, ...body }) }); const text = await r.text(); said.push(text); return { status: r.status, data: JSON.parse(text) } }
  const idOf = (ref) => db.prepare('SELECT id FROM session WHERE runtime_ref = ? ORDER BY id DESC').get(ref).id
  const rowOf = (ref) => db.prepare('SELECT status, archived FROM session WHERE runtime_ref = ? ORDER BY id DESC').get(ref)
  const cards = async () => { const b = await get('/api/board'); return [...Object.values(b.columns).flat()] }
  const card = async (ref) => (await cards()).find((c) => c.ref === ref)
  return { at, said, get, post, idOf, rowOf, cards, card, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r) }) }
}

test('보드 서버 끝에서 끝까지 — 그 앱이 켜져 있다: 새 세션·닫기·이어서 열기는 그 앱의 서버가 호출을 받고, 이동은 그 세션의 주소를 돌려준다. 판은 코어마다 되는 기능을 싣는다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [plainProfile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }, cwd: WORK }))
  B.add(appTerm('t1', { cwd: WORK }))
  B.add(agentTerm('t2', 'working', { labels: appTerm('t0').labels, cwd: NOTES, argv: ['zsh', '-ic', `claude --resume ${SID}`] }))
  transcript(SID, NOTES)
  const db = openDb(':memory:'); await collectAll(db)
  const W = await boardFor(db)
  try {
    // ── 판: 카드의 단추(caps)와 되는 기능(features), 코어마다 되는 기능(cores) ──
    const c1 = await W.card(`${OTHER}/t1`)
    assert.deepEqual(c1.caps, ['focus', 'close', 'resume', 'new', 'web'], '닫기·이어서 열기·새 세션이 열린다. 데스크 끄고 켜기(toggle)는 없다')
    assert.deepEqual(c1.features, { new: { means: 'server_api' }, focus: { means: 'open_url' }, close: { means: 'server_api' }, resume: { means: 'server_api' } })
    const cA = await W.card('default/t1')
    assert.deepEqual([cA.caps, cA.features.focus], [['focus', 'close', 'resume', 'new', 'toggle', 'web'], { means: 'app_command' }], 'Herdr 앱 코어는 예전 그대로 전부 된다')
    const b0 = await W.get('/api/board')
    assert.deepEqual(b0.cores, [
      { name: 'default', app: null, features: ovis.allFeatures('app_command') },
      { name: OTHER, app: APP, features: ovis.coreFeatures({ server: 'ok', app: APP }) },
    ])
    assert.equal(JSON.stringify(b0.cores).includes(String(S.port)), false, '되는 기능에는 포트·주소가 없다')
    // 화면에 내려가는 주소 틀: 그 세션의 터미널 보기까지 적는다(자동 감지의 틀에는 없다 — 보드 서버가 붙인다)
    const ac = await W.get('/api/autoconf')
    assert.equal(clientDefaults(db)[`whosup-open-url-core:${OTHER}`], `http://127.0.0.1:${S.port}/?pane={pane}`)
    assert.equal(ac.client_defaults[`whosup-open-url-core:${OTHER}`], ovis.paneUrlTemplate(S.port))
    assert.equal(ac.client_defaults['whosup-open-url-app'], 'on')

    // ── 새 세션: 새 세션 창에 뜨는 대상(/api/health targets)은 모두 /api/new 가 받는다 ──
    const targets = (await W.get('/api/health')).targets.filter((t) => t.key.startsWith(`core:${OTHER}@`))
    assert.deepEqual(targets.map((t) => [t.key, t.kind, t.label]), [[DESK_B, undefined, `${APP} · ${basename(WORK)}`], [`core:${OTHER}@`, 'new_desk', APP]])
    for (const t of targets) {
      S.requests.length = 0
      const before = liveAddrs(B)
      const r = await W.post('/api/new', { session: t.key, cwd: homedir() })
      const pane = liveAddrs(B).find((a) => !before.includes(a))
      assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.means, r.data.url], [200, true, 'opened_new', 'server_api', paneUrl(S.port, pane)], t.key)
      assert.deepEqual(S.posts(), [[t.kind ? '/api/workspace/create' : '/api/tab/create', { ...(t.kind ? {} : { workspace_id: SPACE_B }), cwd: homedir(), label: basename(homedir()) }], ['/api/pane/input', { pane_id: pane, text: 'claude\r' }]])
      assert.equal((await W.card(`${OTHER}/${pane}`)).desk.startsWith(`core:${OTHER}@`), true, '새 세션이 곧바로 판에 보인다')
    }
    assert.deepEqual([B.sent(), methods(B).includes('terminal.run')], [[], false], '코어 소켓으로 만들거나 넣지 않았다(그 앱의 서버가 했다)')
    assert.deepEqual([A.touched().filter(([m]) => m !== 'terminal.read'), appCalls().filter((c) => c[0] !== 'ls')], [[], []], 'Herdr 앱의 코어와 herdr-app 은 건드리지 않았다(새 세션 대상 목록이 herdr-app 에 공간을 묻는 ls 뿐이다)')

    // ── 이동: 답에 그 세션의 주소와 수단이 실린다. 앱 창 안에서 고르게 하는 호출은 보내지 않는다 ──
    S.requests.length = 0
    const o = await W.post('/api/open', { id: W.idOf(`${OTHER}/t2`), seq: seq(), web: true })
    assert.deepEqual([o.status, o.data.ok, o.data.code, o.data.url, o.data.means], [200, true, 'focused', paneUrl(S.port, 't2'), 'open_url'])
    // 창을 올려 달라는 클릭: 앱 창을 올리고(예전 그대로 focused_app_only) 주소도 함께 준다
    const raised = []
    core._setWindowOps({ appRunning: async () => true, raiseApp: async (n, split, opt) => { raised.push([n, opt]); return 'raised' } })
    const o2 = await W.post('/api/open', { id: W.idOf(`${OTHER}/t2`), seq: seq(), raise: true, web: false })
    assert.deepEqual([o2.status, o2.data.code, o2.data.window, o2.data.app, o2.data.url, o2.data.means, raised], [200, 'focused_app_only', 'app_only', APP, paneUrl(S.port, 't2'), 'open_url', [[APP, { launch: false }]]])
    // 창을 올릴 수 없는 운영체제(그 앱이 떠 있는지 알 길이 없다)·올리기가 실패한 경우에도 주소는 실린다: 화면이 연 탭이 그 세션을 보여 준다
    core._setWindowOps({ appRunning: async () => null })
    const o3 = await W.post('/api/open', { id: W.idOf(`${OTHER}/t2`), seq: seq(), raise: true, web: true })
    assert.deepEqual([o3.data.ok, o3.data.code, o3.data.url, o3.data.means], [true, 'app_raise_unsupported', paneUrl(S.port, 't2'), 'open_url'])
    core._setWindowOps({ appRunning: async () => true, raiseApp: async () => 'failed' })
    const o4 = await W.post('/api/open', { id: W.idOf(`${OTHER}/t2`), seq: seq(), raise: true, web: true })
    assert.deepEqual([o4.data.ok, o4.data.code, o4.data.url], [true, 'app_raise_failed', paneUrl(S.port, 't2')])
    assert.deepEqual([S.posts(), [...new Set(S.gets())]], [[], ['/api/health']])
    core._setWindowOps(noWindows)

    // ── 이어서 열기(살아 있는 셸 세션): 그 터미널에 명령을 입력한다 ──
    S.requests.length = 0
    const rs = await W.post('/api/resume', { id: W.idOf(`${OTHER}/t1`) })
    assert.deepEqual([rs.status, rs.data.ok, rs.data.code, rs.data.means], [200, true, 'started', 'server_api'])
    assert.deepEqual(S.posts(), [['/api/pane/input', { pane_id: 't1', text: 'claude\r' }]])

    // ── 닫기: 그 앱의 서버가 닫는다 ──
    S.requests.length = 0
    const cl = await W.post('/api/close', { id: W.idOf(`${OTHER}/t2`) })
    assert.deepEqual([cl.status, cl.data, S.posts()], [200, { ok: true, code: 'pane_closed', means: 'server_api' }, [['/api/pane/close', { pane_id: 't2' }]]])
    assert.deepEqual([{ ...W.rowOf(`${OTHER}/t2`) }, B.terminals.get('t2').state, methods(B).includes('terminal.kill')], [{ status: 'gone', archived: 1 }, 'finished', false])

    // ── 이어서 열기(닫힌 세션): 그 데스크에 새 세션을 만들어 "<명령> --resume <대화 id>" 를 넣는다 ──
    S.requests.length = 0
    const before = liveAddrs(B)
    const rc = await W.post('/api/resume', { id: W.idOf(`${OTHER}/t2`) })
    const pane = liveAddrs(B).find((a) => !before.includes(a))
    assert.deepEqual([rc.status, rc.data.ok, rc.data.code, rc.data.resumed, rc.data.means, rc.data.url], [200, true, 'resumed', true, 'server_api', paneUrl(S.port, pane)])
    assert.deepEqual(S.posts(), [['/api/tab/create', { workspace_id: SPACE_B, cwd: NOTES, label: basename(NOTES) }], ['/api/pane/input', { pane_id: pane, text: `claude --resume ${SID}\r` }]])

    // 데스크 끄고 켜기는 그 코어에 열지 않았다: 까닭과 함께 거절하고 아무것도 끝내지 않는다
    S.requests.length = 0
    const dk = await W.post('/api/desk', { session: DESK_B, on: false })
    assert.deepEqual([dk.status, dk.data.ok, dk.data.code, S.posts(), methods(B).includes('terminal.kill')], [409, false, 'not_supported', [], false])
    await S.close()
    assertPlainLoopback(S)
    for (const text of W.said) assert.equal(text.includes(TOKEN), false, '보드 서버의 답에 등록 파일의 token 이 없다')
  } finally { await W.close() }
})

test('보드 서버 끝에서 끝까지 — 그 앱이 꺼져 있다: 새 세션·이어서 열기는 "앱을 켜야 한다"(app_required)와 앱 이름으로 거절하고 아무것도 만들지 않는다. 닫기는 코어 소켓으로 직접 한다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [plainProfile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK })); B.add(appTerm('t2', { cwd: WORK })); B.add(appTerm('t3', { cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const W = await boardFor(db)
  try {
    assert.deepEqual((await W.card(`${OTHER}/t1`)).caps, ['focus', 'close', 'resume', 'new', 'web'])
    // 그 앱을 껐다. 자동 감지가 따라왔다(프로필에 웹 주소가 없다): 닫기 단추만 남는다
    await S.close()
    setAutoValues({ cores: [profile()] })
    const c1 = await W.card(`${OTHER}/t1`)
    assert.deepEqual(c1.caps, ['focus', 'close', 'web'])
    assert.deepEqual(c1.features, { new: { means: 'none', reason: 'app_required' }, focus: { means: 'app_window', reason: 'app_required' }, close: { means: 'core_socket' }, resume: { means: 'none', reason: 'app_required' } })
    assert.deepEqual((await W.get('/api/board')).cores.find((c) => c.name === OTHER), { name: OTHER, app: APP, features: c1.features })
    assert.deepEqual((await W.get('/api/health')).targets.filter((t) => t.key.startsWith(`core:${OTHER}@`)), [], '새 세션 창에 그 앱의 데스크가 뜨지 않는다')
    assert.equal((await W.get('/api/autoconf')).client_defaults[`whosup-open-url-core:${OTHER}`], undefined, '꺼진 앱의 주소는 내려가지 않는다')
    // 그래도 요청이 오면(단추가 사라지기 전의 화면): 조용히 성공하지 않고 까닭 코드와 앱 이름으로 거절한다
    B.calls.length = 0
    for (const [path, body] of [['/api/new', { session: DESK_B, cwd: homedir() }], ['/api/new', { session: `core:${OTHER}@`, cwd: homedir() }], ['/api/resume', { id: W.idOf(`${OTHER}/t1`) }]]) {
      const r = await W.post(path, body)
      assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.app], [409, false, 'app_required', APP], `${path} ${JSON.stringify(body)}`)
      assert.match(r.data.message, new RegExp(`${APP} is not running`))
    }
    assert.deepEqual([methods(B).filter((m) => ['terminal.run', 'terminal.send'].includes(m)), liveAddrs(B)], [[], ['t1', 't2', 't3']], '코어에 직접 만들거나 넣지 않았다')
    // 자동 감지가 아직 따라오지 못했다(프로필에는 주소가 남아 있다): 첫 문은 지나가고 런타임이 같은 까닭·같은 앱 이름으로 거절한다
    setAutoValues({ cores: [plainProfile(S.port)] })
    assert.deepEqual((await W.card(`${OTHER}/t1`)).caps, ['focus', 'close', 'resume', 'new', 'web'])
    for (const [path, body] of [['/api/new', { session: DESK_B, cwd: homedir() }], ['/api/resume', { id: W.idOf(`${OTHER}/t2`) }]]) {   // 같은 세션을 3초 안에 다시 누르면 연타로 본다: 다른 세션으로
      const r = await W.post(path, body)
      assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.app], [409, false, 'app_required', APP], `낡은 프로필 ${path}`)
    }
    assert.deepEqual(B.sent(), [])
    // 닫기는 앱이 꺼져 있어도 된다: 그 세션의 터미널임을 확인한 뒤 코어 소켓으로 직접 끝낸다(낡은 프로필이어도, 따라온 프로필이어도)
    B.calls.length = 0
    const c2 = await W.post('/api/close', { id: W.idOf(`${OTHER}/t1`) })
    assert.deepEqual([c2.status, c2.data], [200, { ok: true, code: 'pane_closed', means: 'core_socket' }])
    assert.deepEqual(B.calls.filter((c) => c.params.terminal === 't1' && c.method !== 'terminal.read').map((c) => c.method), ['terminal.get', 'terminal.get', 'terminal.kill'])
    setAutoValues({ cores: [profile()] })
    const c3 = await W.post('/api/close', { id: W.idOf(`${OTHER}/t2`) })
    assert.deepEqual([c3.status, c3.data.means, liveAddrs(B), { ...W.rowOf(`${OTHER}/t2`) }], [200, 'core_socket', ['t3'], { status: 'gone', archived: 1 }])
    // 이동: 주소가 없다. 창을 올려 달라는 클릭은 그 앱이 꺼져 있다고 알린다(켜지 않는다)
    const o = await W.post('/api/open', { id: W.idOf(`${OTHER}/t3`), seq: seq(), raise: true, web: false })
    assert.deepEqual([o.status, o.data.ok, o.data.code, o.data.app, o.data.url, o.data.means], [200, true, 'app_closed', APP, undefined, undefined])
    // 앱을 다시 켰다(포트가 바뀌었다): 프로필이 아직 옛 포트여도 새 세션은 새 서버로 간다
    const S2 = await appServer()
    assert.notEqual(S2.port, S.port)
    setAutoValues({ cores: [plainProfile(S.port)] })
    const n = await W.post('/api/new', { session: DESK_B, cwd: homedir() })
    assert.deepEqual([n.status, n.data.code, S2.posts().map((p) => p[0])], [200, 'opened_new', ['/api/tab/create', '/api/pane/input']])
    assert.match(n.data.url, new RegExp(`^http://127\\.0\\.0\\.1:${S2.port}/\\?pane=t\\d+&view=terminal$`))
  } finally { await W.close() }
})

test('보드 서버 끝에서 끝까지 — 그 앱을 껐고 그 코어에 열린 세션도 없다(읽기를 그만둔 코어): 열려 있던 새 세션 창의 "그 앱 · 새 데스크"를 누르면 수단을 모른다(not_supported)가 아니라 앱을 켜야 한다(app_required)와 그 앱 이름으로 답한다 (검토 N2)', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  const db = openDb(':memory:'); await collectAll(db)   // 그 코어에 세션이 하나도 없다
  const W = await boardFor(db)
  const NEW_DESK = `core:${OTHER}@`
  try {
    assert.deepEqual((await W.get('/api/health')).targets.filter((t) => t.key === NEW_DESK).map((t) => [t.kind, t.label]), [['new_desk', APP]])
    // 그 앱을 껐다: 다음 자동 감지의 코어 목록에서 그 코어가 빠지고, 열린 세션이 없으니 붙잡아 두지도 않는다
    await S.close()
    setAutoValues({ cores: [] })
    await collectAll(db)
    assert.deepEqual([(await W.get('/api/health')).targets.filter((t) => t.key === NEW_DESK), (await W.get('/api/board')).cores.filter((c) => c.name === OTHER)], [[], []], '새로 여는 새 세션 창에는 그 자리가 없다')
    // 창을 열어 둔 채 누른 요청: 앱을 켜면 되는 일이라고 답한다. 코어에 직접 만들지 않는다
    B.calls.length = 0
    const r = await W.post('/api/new', { session: NEW_DESK, cwd: homedir() })
    assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.app], [409, false, 'app_required', APP])
    assert.match(r.data.message, new RegExp(`${APP} is not running`))
    assert.deepEqual(methods(B).filter((m) => ['terminal.run', 'terminal.send'].includes(m)), [])
    // 그 답은 새 세션에만이다: 데스크 끄고 켜기는 그 코어에 열지 않은 일 그대로, 본 적 없는 코어의 데스크도 예전 그대로다
    const dk = await W.post('/api/desk', { session: NEW_DESK, on: false })
    assert.deepEqual([dk.status, dk.data.code, dk.data.app], [409, 'not_supported', undefined])
    const un = await W.post('/api/new', { session: 'core:neverseen@', cwd: homedir() })
    assert.deepEqual([un.status, un.data.code, un.data.app], [409, 'not_supported', undefined])
    assert.doesNotMatch(un.data.message, /viewed and jumped/, '"보기와 이동만 된다"는 낡은 설명을 내보내지 않는다(검토 N3)')
    // 앱을 다시 켜 자동 감지가 따라오면 그 자리가 돌아오고 새 세션이 된다
    const S2 = await appServer()
    setAutoValues({ cores: [profile(S2.port)] })
    const n = await W.post('/api/new', { session: NEW_DESK, cwd: homedir() })
    assert.deepEqual([n.status, n.data.code, S2.posts().map((p) => p[0])], [200, 'opened_new', ['/api/workspace/create', '/api/pane/input']])
    await S2.close()
  } finally { await W.close() }
})

test('보드 서버 끝에서 끝까지 — 조작을 받지 않는 서버·답이 없는 서버: token_required · app_no_answer 로 거절한다(코어 소켓으로 비켜 가지 않는다)', async () => {
  await reset()
  // 토큰이 있어야 조작을 받는 서버(그 앱의 desktop.json 이 가리킨다). 프로필에는 예전에 본 주소가 남아 있다
  const L = await appServer({ locked: true, register: false, desktop: true })
  setAutoValues({ cores: [plainProfile(L.port)] })
  B.add(appTerm('t1', { cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const W = await boardFor(db)
  try {
    for (const [path, body] of [['/api/new', { session: DESK_B, cwd: homedir() }], ['/api/resume', { id: W.idOf(`${OTHER}/t1`) }], ['/api/close', { id: W.idOf(`${OTHER}/t1`) }]]) {
      const r = await W.post(path, body)
      assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.app], [409, false, 'token_required', APP], path)
    }
    assert.deepEqual([L.posts(), B.sent(), methods(B).includes('terminal.kill'), liveAddrs(B), { ...W.rowOf(`${OTHER}/t1`) }.archived], [[], [], false, ['t1'], 0], '닫지 않았고 세션도 그대로다')
    await L.close()
    // 답이 없는 서버: 새 세션은 "됐는지 모른다"(app_no_answer) — "꺼져 있다"가 아니다
    const S = await appServer()
    setAutoValues({ cores: [plainProfile(S.port)] })
    ovis._setLookup({ createMs: 200 })
    S.hang = (m, p) => p === '/api/workspace/create'
    const r = await W.post('/api/new', { session: `core:${OTHER}@`, cwd: homedir() })
    assert.deepEqual([r.status, r.data.ok, r.data.code, r.data.app], [409, false, 'app_no_answer', APP])
    S.hang = null
    for (const text of W.said) assert.equal(text.includes(TOKEN), false)
  } finally { ovis._setLookup(DEFAULT_LOOKUP); await W.close() }
})

test('보드 서버 끝에서 끝까지 — 수단을 모르는 코어는 보기 전용으로 남는다: 닫기·새 세션·이어서 열기를 not_supported 로 거절하고 그 앱의 서버·코어에 아무것도 시키지 않는다', async () => {
  await reset()
  const S = await appServer()                                 // 같은 코어를 보여 주는 서버가 떠 있어도
  setAutoValues({ cores: [{ name: OTHER, app: APP }] })       // 프로필이 수단을 적지 않았다(focus 없음): 예전처럼 보기 전용
  B.add(appTerm('t1', { cwd: WORK }))
  const db = openDb(':memory:'); await collectAll(db)
  const W = await boardFor(db)
  try {
    const c = await W.card(`${OTHER}/t1`)
    assert.deepEqual([c.caps, c.features.close, c.features.focus], [['focus', 'web'], { means: 'none', reason: 'not_supported' }, { means: 'app_window' }])
    assert.deepEqual((await W.get('/api/health')).targets.filter((t) => t.key.startsWith(`core:${OTHER}@`)), [])
    B.calls.length = 0; S.requests.length = 0
    for (const [path, body] of [['/api/close', { id: W.idOf(`${OTHER}/t1`) }], ['/api/resume', { id: W.idOf(`${OTHER}/t1`) }], ['/api/new', { session: DESK_B, cwd: homedir() }], ['/api/new', { session: `core:${OTHER}@`, cwd: homedir() }], ['/api/desk', { session: DESK_B, on: false }]]) {
      const r = await W.post(path, body)
      assert.deepEqual([r.status, r.data.ok, r.data.code], [409, false, 'not_supported'], path)
    }
    assert.deepEqual([S.requests, B.touched().filter(([m]) => m !== 'terminal.read'), liveAddrs(B), { ...W.rowOf(`${OTHER}/t1`) }.archived], [[], [], ['t1'], 0])
    // 이동은 예전 그대로: 그 앱 창만 올린다(주소·수단 open_url 은 싣지 않는다)
    core._setWindowOps({ appRunning: async () => true, raiseApp: async () => 'raised' })
    const o = await W.post('/api/open', { id: W.idOf(`${OTHER}/t1`), seq: seq(), raise: true, web: false })
    assert.deepEqual([o.data.code, o.data.url, o.data.means, S.requests], ['focused_app_only', undefined, 'app_window', []])
  } finally { await W.close() }
})

test('세션을 여는 곳을 아무도 정하지 않았을 때만 "탭으로만 보여 줄 수 있는 세션은 누르면 탭도 연다"(whosup-open-url-app) 가 켜진다: 설정·환경변수로 정했으면 그 값 그대로다', async () => {
  await reset()
  const db = openDb(':memory:')
  assert.deepEqual([clientDefaultsOf(db)['whosup-open-url-app'], clientDefaultsOf(db)['whosup-open-url-on']], ['on', 'off'])
  process.env.WHOSUP_CLICK_TARGET = 'terminal'
  try { assert.equal(clientDefaultsOf(db)['whosup-open-url-app'], 'off', '환경변수로 정했다') } finally { delete process.env.WHOSUP_CLICK_TARGET }
  assert.equal(clientDefaultsOf(db)['whosup-open-url-app'], 'on')
  // 자동 감지가 고른 값은 사람이 정한 것이 아니다: 그 규칙은 켜진 채다
  setAutoValues({ values: { click_target: 'both' }, reasons: {}, cores: [] })
  assert.deepEqual([clientDefaultsOf(db)['whosup-open-url-app'], clientDefaultsOf(db)['whosup-open-url-on']], ['on', 'on'], '자동 감지가 고른 값')
  setAutoValues(null)
  assert.equal(setSettings(db, { click_target: 'terminal' }).ok, true)
  assert.deepEqual([clientDefaultsOf(db)['whosup-open-url-app'], clientDefaultsOf(db)['whosup-open-url-on']], ['off', 'off'], '설정·첫 실행 안내에서 터미널 창을 골랐다')
  assert.equal(setSettings(db, { click_target: 'both' }).ok, true)
  assert.deepEqual([clientDefaultsOf(db)['whosup-open-url-app'], clientDefaultsOf(db)['whosup-open-url-on']], ['off', 'on'])
  // 주소 틀: 자기 서버로 보여 주는 앱의 코어의 것만 터미널 보기를 붙인다. 이미 붙어 있거나 다른 모양이면 그대로 둔다
  setAutoValues({ values: { 'open_url:side': 'http://127.0.0.1:48010/?pane={pane}' }, reasons: {}, cores: [plainProfile(48011)] })
  const d = clientDefaultsOf(db)
  assert.deepEqual([d['whosup-open-url:side'], d[`whosup-open-url-core:${OTHER}`]], ['http://127.0.0.1:48010/?pane={pane}', 'http://127.0.0.1:48011/?pane={pane}&view=terminal'], 'herdr 데스크의 웹 터미널 주소는 예전 그대로다')
  for (const [given, want] of [
    ['http://127.0.0.1:48011/?pane={pane}', 'http://127.0.0.1:48011/?pane={pane}&view=terminal'],
    ['http://127.0.0.1:48011/?pane={pane}&view=terminal', 'http://127.0.0.1:48011/?pane={pane}&view=terminal'],
    ['http://127.0.0.1:48011/?pane={pane}&view=chat', 'http://127.0.0.1:48011/?pane={pane}&view=chat'],
    ['http://127.0.0.1:48011/t/{pane}', 'http://127.0.0.1:48011/t/{pane}'],
    ['http://127.0.0.1:48011/?pane={pane}#x', 'http://127.0.0.1:48011/?pane={pane}#x'],
    ['http://127.0.0.1:48011/#/s?pane={pane}', 'http://127.0.0.1:48011/#/s?pane={pane}'],   // 질의가 '#' 뒤에 있는 틀: 붙이면 그 마디가 서버에 닿지 않는다
  ]) assert.equal(ovis.withTerminalView(given), want, given)
  assert.deepEqual([ovis.withTerminalView(null), ovis.withTerminalView('')], [null, ''])
})

// ── 화면(src/board/index.html): 이 저장소가 화면을 시험하는 방식 그대로 — 표시한 덩어리를 그대로 읽어 돌린다 ──
const I18N = new Function(`${HTML.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
const blockOf = (name) => HTML.slice(HTML.indexOf(`/*${name}*/`), HTML.indexOf(`/*/${name}*/`))
const web = new Function(`${blockOf('weburl')}; return { tabOnly, openUrlOf, clickPlanOf, portFixedUrl, shownReply }`)()
const appcore = new Function(`${blockOf('appcore')}; return { targetLabel, targetTip, newOffLines }`)()
const store = (o) => (k) => (Object.hasOwn(o, k) ? o[k] : null)
const ON = ovis.coreFeatures({ server: 'ok', app: APP }), OFF = ovis.coreFeatures({ server: 'none', app: APP })
const appCard = (features, over = {}) => ({ id: 7, runtime: 'herdr-core', ref: `${OTHER}/t4`, desk: DESK_B, desk_label: `${APP} · work`, caps: ['focus', ...['close', 'resume', 'new'].filter((k) => features[k].means !== 'none'), 'web'], features, ...over })

test('화면 문구: 까닭 코드(app_required·token_required·app_no_answer)와 탭으로 연 결과의 문구가 한국어·영어에 있고, 받은 앱 이름만 끼워 넣는다', () => {
  for (const code of ['app_required', 'token_required', 'app_no_answer', 'focused_app_tab', 'focused_tab']) {
    for (const T of [I18N.ko, I18N.en]) for (const d of [{ app: APP }, {}, { app: null }]) {
      const text = T.codes[code](d)
      assert.ok(typeof text === 'string' && text.length > 10 && !/undefined|null/.test(text), `${code} ${JSON.stringify(d)}`)
      assert.equal(text.includes(APP), Boolean(d.app), `${code}: 앱 이름은 받은 값만 끼워 넣는다`)
    }
    for (const d of [{ app: APP }, {}]) assert.doesNotMatch(I18N.ko.codes[code](d), /[이을은]\([가를는]\)|\(으\)로/)
    assert.doesNotMatch(I18N.en.codes[code]({ app: APP }), /[가-힣]/); assert.match(I18N.ko.codes[code]({ app: APP }), /[가-힣]/)
  }
  // 앱이 꺼져 있다는 말과 무엇을 하면 되는지가 함께 있다
  assert.match(I18N.ko.codes.app_required({ app: APP }), /꺼져 있어.*앱을 켠 뒤 다시/); assert.match(I18N.en.codes.app_required({ app: APP }), /is not running.*Start the app/)
  // 그 밖의 새 문구도 두 언어에 짝으로 있다. 화면 말은 "세션"이다(칸·pane 이 아니다)
  for (const k of ['newDeskIn', 'newDeskTip', 'newAppOff', 'tabOnlyTip']) {
    const [ko, en] = [I18N.ko[k], I18N.en[k]].map((f) => (typeof f === 'function' ? f(APP) : f))
    assert.ok(ko && en && /[가-힣]/.test(ko) && !/[가-힣]/.test(en), k)
    assert.doesNotMatch(ko + en, /칸|pane/i, k)
  }
  assert.match(I18N.ko.tabOnlyTip, /브라우저 탭/); assert.match(I18N.en.tabOnlyTip, /browser tab/)
  // 예전의 "보기와 이동만 됩니다"는 이제 사실이 아니다(닫기·새 세션·이어서 열기가 되는 앱이 있다)
  for (const T of [I18N.ko, I18N.en]) assert.doesNotMatch(T.codes.not_supported, /보기와 이동만|only be viewed/)
})

test('화면의 클릭 계획: 앱 창 안에서 고를 수 없는 세션(features.focus = open_url)은 여는 곳을 아무도 정하지 않았으면 탭을 열고 앱 창은 올리지 않는다(U2). 정했으면 그 값 그대로다', () => {
  const tpl = { [`whosup-open-url-core:${OTHER}`]: ovis.paneUrlTemplate(48021) }
  const url = paneUrl(48021, 't4')
  const plan = (card, saved) => web.clickPlanOf(card, store(saved), Object.keys(saved))
  assert.deepEqual([web.tabOnly(appCard(ON)), web.tabOnly(appCard(OFF)), web.tabOnly({ features: ovis.allFeatures('app_command') }), web.tabOnly({}), web.tabOnly(null)], [true, false, false, false, false])
  // 서버 기본값 그대로(터미널 창, 아무도 고르지 않았다): 탭을 열고 앱 창은 올리지 않는다 — 올리면 다른 세션을 보인 채 탭을 덮는다(U2, test/air-findings-ui.test.mjs)
  assert.deepEqual(plan(appCard(ON), { ...tpl, 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'on' }), { url, raise: false })
  // 설정·환경변수로 터미널 창을 정했거나(서버가 off 로 알린다) 이 브라우저에서 따로 골랐다: 탭을 열지 않는다(앱 창 올리기만)
  assert.deepEqual(plan(appCard(ON), { ...tpl, 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'off' }), { url: '', raise: true })
  assert.deepEqual(plan(appCard(ON), { ...tpl, 'whosup-open-url-on': 'off' }), { url: '', raise: true }, '그 값을 모르는 예전 서버: 예전 그대로')
  // 그 앱이 꺼져 있다(이동의 수단이 앱 창뿐이다)·Herdr 앱 세션·herdr 세션: 그 규칙은 닿지 않는다
  const savedOn = { ...tpl, 'whosup-open-url': 'http://127.0.0.1:48022/?pane={pane}', 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' }
  assert.deepEqual(plan(appCard(OFF), savedOn), { url: '', raise: true })
  assert.deepEqual(plan(appCard(ovis.allFeatures('app_command'), { ref: 'default/t4', desk: 'core:spA', caps: ['focus', 'close', 'resume', 'new', 'toggle', 'web'] }), savedOn), { url: '', raise: true })
  assert.deepEqual(plan({ id: 1, runtime: 'herdr', ref: 'main/w1:p1', desk: 'main', caps: ['focus', 'web'] }, savedOn), { url: '', raise: true })
  // 웹 터미널·둘 다를 고른 사람: 탭으로만 보여 줄 수 있는 세션은 탭이 열리는 한 앱 창을 올리지 않는다(U2 — '둘 다'여도 올린 창은 다른 세션을 보인다)
  assert.deepEqual(plan(appCard(ON), { ...tpl, 'whosup-open-url-on': 'on', 'whosup-raise': 'off', 'whosup-open-url-app': 'off' }), { url, raise: false })
  assert.deepEqual(plan(appCard(ON), { ...tpl, 'whosup-open-url-on': 'on', 'whosup-raise': 'on' }), { url, raise: false })
  // 내려 준 주소가 없으면(자동 감지가 주소를 싣지 않았다) 열 것이 없다
  assert.deepEqual(plan(appCard(ON), { 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' }), { url: '', raise: true })
  // 이 브라우저에서 여는 곳을 고르면 그 규칙을 끈다. 서버에 저장하며 이 브라우저의 값을 지울 때는 함께 지운다
  assert.match(HTML, /function setClickMode\(m\) \{\n\s+localStorage\.setItem\('whosup-open-url-app', 'off'\)/)
  assert.equal(HTML.split("localStorage.removeItem('whosup-raise'); localStorage.removeItem('whosup-open-url-app')").length, 3)
  // 카드의 툴팁 한 줄: 누르면 탭을 여는 세션에만(읽기 전용 화면은 누를 수 없으니 적지 않는다)
  assert.match(HTML, /\$\{!ro && tabOnly\(c\) && clickPlan\(c\)\.url \? ' · ' \+ esc\(T\.tabOnlyTip\) : ''\}/)
})

// 화면이 값을 읽는 줄(let srvDefaults … setClickMode)을 그대로 읽어, 브라우저 저장소만 가짜로 바꿔 돌린다: 이 브라우저에 저장한 값과
// 서버가 알려 준 기본값이 섞이는 자리다. 가짜 저장소는 진짜처럼 저장한 열쇠만 Object.keys 에 나온다.
const fakeStorage = (saved) => Object.defineProperties({ ...saved }, {
  getItem: { value(k) { return Object.hasOwn(this, k) ? this[k] : null } },
  setItem: { value(k, v) { this[k] = String(v) } },
  removeItem: { value(k) { delete this[k] } },
})
const GLUE = HTML.slice(HTML.indexOf('let srvDefaults = {}'), HTML.indexOf('const clickPlan = (c) =>'))
const pageOf = (saved, defaults) => {
  const localStorage = fakeStorage(saved)
  const page = new Function('localStorage', `${blockOf('weburl')}\n${GLUE}\nsrvDefaults = ${JSON.stringify(defaults)}\n`
    + 'return { clickPlan: (c) => clickPlanOf(c, lsGet, lsKeys()), clickMode, setClickMode, lsGet, hasLocalClick: () => localClickOf(lsLocal) }')(localStorage)
  return { ...page, localStorage }
}

test('이 브라우저에서 터미널 창을 따로 골라 둔 사람은, 그 선택이 whosup-open-url-app 열쇠가 생기기 전의 것이어도 그 값 그대로다: 서버 기본값(on)이 끼어들어 고르지 않은 탭을 열지 않는다 (검토 R1)', () => {
  assert.ok(GLUE.includes('const lsGet = ') && GLUE.includes('function setClickMode('), '화면의 값 읽는 줄을 찾았다')
  // 서버: 아무도 '세션을 여는 곳'을 정하지 않았다(기본 터미널 창) — 탭으로만 보여 줄 수 있는 세션은 누르면 탭도 연다('on')
  const defaults = { [`whosup-open-url-core:${OTHER}`]: ovis.paneUrlTemplate(48021), 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'on' }
  const url = paneUrl(48021, 't4')
  const press = (saved) => pageOf(saved, defaults).clickPlan(appCard(ON))
  // 아무것도 저장하지 않은 브라우저: 서버 기본값대로 탭을 열고 앱 창은 올리지 않는다(U2)
  assert.deepEqual(press({}), { url, raise: false })
  // 예전 판에서 '이 브라우저에서만 다르게 · 터미널 창'을 골라 둔 브라우저(그 열쇠가 없다): 탭을 열지 않는다
  const legacy = pageOf({ 'whosup-open-url-on': 'off', 'whosup-raise': 'on' }, defaults)
  assert.deepEqual([legacy.hasLocalClick(), legacy.clickMode(), legacy.lsGet('whosup-open-url-app')], [true, 'terminal', 'off'])
  assert.deepEqual(legacy.clickPlan(appCard(ON)), { url: '', raise: true })
  assert.equal(Object.hasOwn(legacy.localStorage, 'whosup-open-url-app'), false, '읽기만 한다 — 브라우저 저장소에 옮겨 적지 않는다')
  // 두 열쇠 가운데 하나만 남아 있어도 "따로 골랐다"(설정 화면의 hasLocalClick 과 같은 판정)
  assert.deepEqual(press({ 'whosup-raise': 'on' }), { url: '', raise: true })
  // 예전에 웹 터미널·둘 다를 골라 둔 브라우저: 탭을 연다 — 탭으로만 보여 줄 수 있는 세션이므로 앱 창은 올리지 않는다(U2)
  assert.deepEqual(press({ 'whosup-open-url-on': 'on', 'whosup-raise': 'off' }), { url, raise: false })
  assert.deepEqual(press({ 'whosup-open-url-on': 'on', 'whosup-raise': 'on' }), { url, raise: false })
  // 여는 곳이 아닌 것(주소·언어 등)만 저장한 브라우저는 "따로 골랐다"가 아니다: 서버 기본값대로
  assert.deepEqual(press({ 'whosup-open-url:elsewhere': 'http://127.0.0.1:48030/?pane={pane}', 'whosup-lang': 'ko' }), { url, raise: false })
  // 이 판에서 고르면(setClickMode) 그 열쇠까지 적는다 — 결과는 같다
  const now = pageOf({}, defaults)
  now.setClickMode('terminal')
  assert.deepEqual([now.localStorage['whosup-open-url-app'], now.clickPlan(appCard(ON))], ['off', { url: '', raise: true }])
  // 서버 쪽에서 정한 값('off')과 그 값을 모르는 예전 서버는 예전 그대로이고, 다른 열쇠는 저장값 → 서버 값 → null 순서 그대로다
  assert.deepEqual(pageOf({}, { ...defaults, 'whosup-open-url-app': 'off' }).clickPlan(appCard(ON)), { url: '', raise: true })
  const mixed = pageOf({ 'whosup-raise': 'off' }, { 'whosup-raise': 'on', 'whosup-open-url-on': 'on' })
  assert.deepEqual(['whosup-raise', 'whosup-open-url-on', 'whosup-open-url', 'whosup-open-url-app'].map(mixed.lsGet), ['off', 'on', null, 'off'])
  assert.equal(pageOf({}, {}).lsGet('whosup-open-url-app'), null)
  // 설정 화면의 "이 브라우저에만 따로 정한 값이 있는지"도 같은 판정을 쓴다
  assert.match(HTML, /const hasLocalClick = \(\) => localClickOf\(lsLocal\)/)
})

test('화면의 세션 누르기: 서버가 알려 준 주소가 방금 연 탭과 포트만 다르면 그 탭을 다시 보내고, 탭으로 보여 준 세션은 "앱 안에서 골라 주세요"가 아니라 탭으로 열었다고 말한다', async () => {
  assert.equal(web.portFixedUrl(paneUrl(48001, 't1'), paneUrl(48002, 't1')), paneUrl(48002, 't1'))
  assert.equal(web.portFixedUrl(paneUrl(48001, 't1'), paneUrl(48001, 't1')), '', '같은 주소면 건드리지 않는다')
  assert.equal(web.portFixedUrl('https://desk.example.test/?pane=t1&view=terminal', paneUrl(48002, 't1')), '', '사람이 적어 둔 다른 호스트의 주소는 건드리지 않는다')
  assert.equal(web.portFixedUrl('http://127.0.0.1:48001/t/t1', paneUrl(48002, 't1')), '', '경로가 다른 주소는 건드리지 않는다')
  assert.equal(web.portFixedUrl(paneUrl(48001, 't1'), paneUrl(48002, 't2')), '', '다른 세션의 주소로는 보내지 않는다')
  assert.equal(web.portFixedUrl('', paneUrl(48002, 't1')), '')
  const u = paneUrl(48002, 't4')
  assert.equal(web.shownReply({ ok: true, code: 'focused_app_only', url: u, app: APP }, true).code, 'focused_app_tab')
  for (const code of ['app_raise_unsupported', 'app_raise_failed', 'app_closed']) assert.equal(web.shownReply({ ok: true, code, url: u }, true).code, 'focused_tab', code)
  assert.equal(web.shownReply({ ok: true, code: 'focused_app_only', url: u }, false).code, 'focused_app_only', '탭을 열지 않았다: 앱 안에서 고르라는 말 그대로')
  assert.equal(web.shownReply({ ok: true, code: 'focused_app_only' }, true).code, 'focused_app_only', '그 앱의 서버가 없다(주소 없음): 탭이 그 세션을 보여 준다고 말하지 않는다')
  assert.equal(web.shownReply({ ok: false, code: 'core_unavailable', url: u }, true).code, 'core_unavailable')
  assert.equal(web.shownReply({ ok: true, code: 'focused', url: u }, true).code, 'focused')

  // 화면의 openCard 를 그대로 읽어, 화면에 닿는 것(판·탭·알림·요청)만 가짜로 바꿔 돌린다(test/weburl.test.mjs 와 같은 방식)
  const src = HTML.slice(HTML.indexOf('async function openCard(id) {'), HTML.indexOf('async function doAct('))
  const press = async (card, saved, reply, { blocked = false } = {}) => {
    const sent = [], opened = [], toasts = [], moved = []
    const env = {
      can: () => true, denied: () => {}, cardById: () => card, refresh: () => {}, msgOf: (d) => d.code, T: { going: 'going', popupBlocked: 'blocked' }, board: { readonly: false }, openedTabs: new Map(),
      toast: (t, bad) => toasts.push([t, Boolean(bad)]), portFixedUrl: web.portFixedUrl, shownReply: web.shownReply,
      clickPlan: (c) => web.clickPlanOf(c, store(saved), Object.keys(saved)),
      openTab: (desk, url) => { opened.push([desk, url]); return blocked ? { ok: false } : { ok: true, fresh: true, win: { location: { replace: (to) => moved.push(to) } } } },
      post: async (path, body) => { sent.push([path, body]); return reply },
    }
    await new Function(...Object.keys(env), `let clickN = 0; ${src}; return openCard`)(...Object.values(env))(7)
    return { body: sent[0][1], opened, toasts, moved }
  }
  const saved = { [`whosup-open-url-core:${OTHER}`]: ovis.paneUrlTemplate(48001), 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'on' }
  // 포트가 그대로다: 탭을 열고 앱 창은 올리지 말라고 한다(U2). 탭을 다시 보내지 않고, 탭으로 열었다고 말한다
  let r = await press(appCard(ON), saved, { ok: true, data: { ok: true, code: 'focused_app_only', app: APP, url: paneUrl(48001, 't4'), means: 'open_url' } })
  assert.deepEqual([r.body.web, r.body.raise, r.opened, r.moved, r.toasts.at(-1)], [true, false, [[DESK_B, paneUrl(48001, 't4')]], [], ['focused_app_tab', false]])
  // 그 앱을 다시 켜 포트가 바뀌었다(자동 감지는 아직 옛 포트): 방금 연 탭을 서버가 알려 준 주소로 다시 보낸다
  r = await press(appCard(ON), saved, { ok: true, data: { ok: true, code: 'focused_app_only', app: APP, url: paneUrl(48002, 't4'), means: 'open_url' } })
  assert.deepEqual([r.moved, r.toasts.at(-1)], [[paneUrl(48002, 't4')], ['focused_app_tab', false]])
  // 그 앱의 서버가 없다(주소가 오지 않았다): 탭을 다시 보내지 않고 서버의 답 그대로 알린다
  r = await press(appCard(ON), saved, { ok: true, data: { ok: true, code: 'app_closed', app: APP } })
  assert.deepEqual([r.moved, r.toasts.at(-1)], [[], ['app_closed', false]])
  // 브라우저가 탭을 막았다: 다시 보낼 탭이 없고, 막혔다고 알린다
  r = await press(appCard(ON), saved, { ok: true, data: { ok: true, code: 'focused_app_only', app: APP, url: paneUrl(48002, 't4') } }, { blocked: true })
  assert.deepEqual([r.body.web, r.moved, r.toasts.at(-1)], [false, [], ['blocked', true]])
  // 터미널 창을 고른 사람: 탭을 열지 않고, 앱 창만 올렸다는 답 그대로다
  r = await press(appCard(ON), { ...saved, 'whosup-open-url-app': 'off' }, { ok: true, data: { ok: true, code: 'focused_app_only', app: APP, url: paneUrl(48001, 't4') } })
  assert.deepEqual([r.body.web, r.body.raise, r.opened, r.toasts.at(-1)], [false, true, [], ['focused_app_only', false]])
})

test('화면의 단추와 새 세션 창: 닫기·이어서 열기는 카드의 caps 로 보이고, 그 앱의 "새 데스크" 자리는 다른 데스크와 같은 단추 줄에 뜬다. 앱이 꺼져 새 세션을 못 여는 코어는 까닭 한 줄로 알린다', () => {
  // 닫기·이어서 열기 단추는 caps 로 정한다(런타임 이름·앱 이름으로 가리지 않는다) — 그 앱이 켜져 있으면 caps 에 들어온다(위 보드 서버 시험)
  assert.match(HTML, /\$\{c\.caps\.includes\('close'\) \? `<button data-closepane=/)
  assert.match(HTML, /st === 'shell' && !ro && c\.caps\.includes\('resume'\) \? `<button class="resume" data-resume=/)
  assert.match(HTML, /c\.caps && !c\.caps\.includes\('resume'\) \? '' : `<button data-resume=/)
  // 새 세션 창의 대상: 같은 단추 줄(.seg) 안에 이름만 달리 적는다
  for (const [lang, T] of Object.entries(I18N)) {
    assert.equal(appcore.targetLabel({ key: DESK_B, label: `${APP} · work` }, T), `${APP} · work`, lang)
    assert.equal(appcore.targetLabel({ key: 'main', label: 'main' }, T), 'main', lang)
    assert.deepEqual([appcore.targetLabel({ key: `core:${OTHER}@`, label: APP, kind: 'new_desk' }, T), appcore.targetTip({ key: `core:${OTHER}@`, label: APP, kind: 'new_desk' }, T)], [T.newDeskIn(APP), T.newDeskTip(APP)], lang)
    // 앱이 꺼져 새 세션을 못 여는 코어: 앱 이름을 아는 것만 한 줄씩(같은 앱은 한 번)
    const cores = [{ name: 'default', app: null, features: ovis.allFeatures('app_command') }, { name: OTHER, app: APP, features: OFF }, { name: 'x2', app: APP, features: OFF },
      { name: 'x3', app: null, features: OFF }, { name: 'x4', app: 'Other', features: ON }, { name: 'x5', app: 'Viewonly', features: ovis.allFeatures('none', 'not_supported') }]
    assert.deepEqual(appcore.newOffLines(cores, T), [T.newAppOff(APP)], lang)
    assert.deepEqual([appcore.newOffLines(undefined, T), appcore.newOffLines([], T)], [[], []])
  }
  assert.match(HTML, /<div class="seg">\$\{newState\.targets\.map\(\(t\) => `<button data-target="\$\{esc\(t\.key\)\}"[^\n]*title="\$\{esc\(targetTip\(t, T\)\)\}">\$\{esc\(clip\(targetLabel\(t, T\), 24\)\)\}<\/button>`\)\.join\(''\)\}<\/div>\$\{newOffLines\(board\?\.cores, T\)\.map\(\(l\) => `<div class="hint">\$\{esc\(l\)\}<\/div>`\)\.join\(''\)\}/)
})

// ── 방금 만든 터미널에 명령을 넣기 전에 그 셸이 뜨기를 기다린다(가-12 B3-1: 명령이 두 번 찍혀 보임) ──
// 가짜 코어의 화면을 "읽을 때마다" 바꾼다: n 번째 읽기부터 프롬프트가 그려져 있다(그 전에는 빈 줄뿐인 화면 — 아직 아무것도 그려지지 않았다).
const promptAfter = (fake, n, line) => { const seen = new Map(); fake.override = (method, p) => { if (method === 'terminal.read' && p.lines === 20) { const k = (seen.get(p.terminal) || 0) + 1; seen.set(p.terminal, k); fake.screens.set(p.terminal, k >= n ? 'me@host work % ' : '\n  \n') } line?.push(`core:${method}`) } }
test('새 세션(Herdr 앱·코어 직접): 터미널을 만들자마자 명령을 보내지 않는다 — 그 화면에 프롬프트가 그려져 두 번 이어 같을 때 보낸다. 한도를 넘기거나 화면을 읽지 못하면 예전처럼 그냥 보낸다', async () => {
  await reset()
  core._setShellWait({ stepMs: 5, maxMs: 3000, readMs: 500 })
  try {
    promptAfter(A, 3)
    const r = await core.newSession({ session: 'core:', cwd: WORK, command: 'claude', raise: false })
    const mine = A.calls.filter((c) => c.params.terminal === r.pane).map((c) => c.method)
    assert.deepEqual(mine.slice(0, mine.indexOf('terminal.send') + 1), ['terminal.read', 'terminal.read', 'terminal.read', 'terminal.read', 'terminal.send'], '빈 화면 두 번 → 프롬프트 → 같은 프롬프트 한 번 더, 그 뒤에 보낸다')
    assert.deepEqual(A.sent(), [[r.pane, 'claude']], '명령은 한 번만 보낸다')
    // 명령이 없으면 기다리지 않는다
    A.calls.length = 0
    const r0 = await core.newSession({ session: 'core:', cwd: WORK, command: '', raise: false })
    assert.deepEqual(A.calls.filter((c) => c.params.terminal === r0.pane && ['terminal.read', 'terminal.send'].includes(c.method)), [], '화면을 읽지도, 무엇을 보내지도 않는다')
    // 프롬프트가 끝내 그려지지 않는다: 한도까지만 기다리고 보낸다
    A.override = null; A.calls.length = 0
    core._setShellWait({ stepMs: 5, maxMs: 120 })
    const t0 = Date.now()
    const r2 = await core.newSession({ session: 'core:', cwd: WORK, command: 'claude', raise: false })
    assert.ok(Date.now() - t0 >= 100 && Date.now() - t0 < 2000, `waited ${Date.now() - t0}ms`)
    assert.equal(A.calls.filter((c) => c.params.terminal === r2.pane && c.method !== 'terminal.label').at(-1).method, 'terminal.send')
    // 화면을 읽지 못한다: 곧바로 보낸다
    A.calls.length = 0
    core._setShellWait({ stepMs: 5, maxMs: 3000 })
    A.override = (method) => (method === 'terminal.read' ? `${JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'cannot read' } })}\n` : undefined)
    const t1 = Date.now()
    const r3 = await core.newSession({ session: 'core:', cwd: WORK, command: 'claude', raise: false })
    assert.ok(Date.now() - t1 < 1500)
    assert.deepEqual(A.sent().at(-1), [r3.pane, 'claude'])
  } finally { A.override = null; core._setShellWait({ stepMs: 80, maxMs: 0, readMs: 1500 }) }
})

test('새 세션(자기 서버로 보여 주는 앱): 그 앱의 서버가 터미널을 만든 뒤, 이 코어에서 그 화면에 프롬프트가 그려진 것을 보고 나서 명령을 입력해 달라고 한다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  core._setShellWait({ stepMs: 5, maxMs: 3000, readMs: 500 })
  const line = []
  S.delay = (m, p) => { if (m === 'POST') line.push(`app:${p}`); return 0 }
  try {
    promptAfter(B, 2, line)
    const r = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false })
    const steps = line.filter((x) => x.startsWith('app:') || x === 'core:terminal.read')
    assert.deepEqual(steps, ['app:/api/workspace/create', 'core:terminal.read', 'core:terminal.read', 'core:terminal.read', 'app:/api/pane/input'], '만들기 → 화면 읽기(빈 화면 · 프롬프트 · 같은 프롬프트) → 입력')
    assert.deepEqual(S.posts().at(-1), ['/api/pane/input', { pane_id: r.pane, text: 'claude\r' }])
    assert.deepEqual(B.sent(), [], '입력은 그 앱의 서버로만 간다')
  } finally { B.override = null; S.delay = null; core._setShellWait({ stepMs: 80, maxMs: 0, readMs: 1500 }) }
})

test('데스크 켜기(Herdr 앱): 새로 만든 공간의 첫 터미널에도 그 셸이 뜬 것을 보고 나서 이어 열 명령을 보낸다', async () => {
  await reset()
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }, cwd: WORK, created_ms: Date.now() - 60000 }))
  await core.stopSession('core:spA')
  core._setShellWait({ stepMs: 5, maxMs: 3000, readMs: 500 })
  try {
    promptAfter(A, 2)
    A.calls.length = 0
    const r = await core.startSession('core:spA', undefined, { raise: false, commands: [{ id: 1, cwd: WORK, command: `claude --resume ${SID}` }] })
    const mine = A.calls.filter((c) => c.params.terminal === r.opened[0] && ['terminal.read', 'terminal.send'].includes(c.method)).map((c) => c.method)
    assert.deepEqual([mine, r.done, r.failed], [['terminal.read', 'terminal.read', 'terminal.read', 'terminal.send'], [1], []], '빈 화면 → 프롬프트 → 같은 프롬프트, 그 뒤에 보낸다')
    assert.deepEqual(A.sent(), [[r.opened[0], `claude --resume ${SID}`]])
  } finally { A.override = null; core._setShellWait({ stepMs: 80, maxMs: 0, readMs: 1500 }) }
})

// ── 앱 링크(ovis://open?pane=…) ─────────────────────────────────────
test('앱 링크: 깔린 앱이 링크를 알면 누르기·새 세션이 그 링크로 앱 창에서 그 세션을 고르게 한다(브라우저 탭 아님). 창을 올리지 말라는 클릭은 링크도 열지 않는다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK }))
  linkApp()
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`).focus, { means: 'app_link' }, '이동의 수단이 app_link 다(화면은 탭을 열지 않는다 — tabOnly 가 아니다)')
  assert.deepEqual(core.profilesView().find((x) => x.name === OTHER).features, ovis.coreFeatures({ server: 'ok', app: APP, link: true }))
  const raised = []
  core._setWindowOps({ ...noWindows, appRunning: async () => true, raiseApp: async (...a) => { raised.push(a); return 'raised' } })
  const r = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([r.window, r.means, r.opened, r.url], ['app_link', 'app_link', 'app_link', paneUrl(S.port, 't1')])
  assert.deepEqual(LAUNCHES, [linkOf('t1')], '정확히 그 링크 하나를 연다')
  assert.deepEqual(raised, [], '앱 창 올리기를 따로 하지 않는다(링크가 앱 창을 앞으로 가져온다)')
  // 창을 올리지 말라는 클릭(그 브라우저가 탭을 열었다): 링크를 열지 않는다
  LAUNCHES.length = 0
  const r2 = await core.focus(`${OTHER}/t1`, { seq: seq(), raise: false })
  assert.deepEqual([r2.window, r2.opened, r2.url, LAUNCHES], ['skipped', undefined, paneUrl(S.port, 't1'), []])
  // 새 세션: 방금 만든 그 세션의 링크를 연다(서버가 알려 준 터미널 주소)
  const n = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude' })
  assert.deepEqual([n.window, n.opened, n.means, n.url], ['app_link', 'app_link', 'server_api', paneUrl(S.port, n.pane)])
  assert.deepEqual(LAUNCHES, [linkOf(n.pane)])
  LAUNCHES.length = 0
  const n2 = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude', raise: false })
  assert.deepEqual([n2.window, n2.opened, LAUNCHES], ['skipped', undefined, []])
  // 이어서 열기(그 세션에 명령을 넣는다)도 그 세션을 링크로 보인다
  B.add(appTerm('t9', { cwd: WORK }))
  const rs = await core.focus(`${OTHER}/t9`, { run: 'claude', incarnation: inc(B, 't9') })
  assert.deepEqual([rs.means, rs.opened, LAUNCHES], ['server_api', 'app_link', [linkOf('t9')]])
  await S.close()
})

test('앱 링크: 깔린 앱이 링크를 모르면(0.5.3) 예전 그대로다 — 이동은 open_url(화면이 브라우저 탭을 연다), 창을 올리는 클릭은 앱 창만, 링크는 열지 않는다. 앱 이름을 모르면 macOS 에서는 링크를 쓰지 않는다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK }))
  linkApp([])
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`).focus, { means: 'open_url' })
  const a = await core.focus(`${OTHER}/t1`, { seq: seq(), raise: false })
  assert.deepEqual([a.window, a.url, a.opened, a.means], ['skipped', paneUrl(S.port, 't1'), undefined, undefined])
  const b = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([b.window, b.opened], ['app_closed', undefined], '창을 올리는 클릭: 예전처럼 앱 창 올리기(가짜 창 조작에서는 앱이 꺼져 있다)')
  const n = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude' })
  assert.deepEqual([n.window, n.opened], ['app_closed', undefined])
  assert.deepEqual(LAUNCHES, [])
  // 링크를 아는 앱 묶음이 있어도 프로필에 앱 이름이 없으면(macOS) 쓰지 않는다
  linkApp()
  setAutoValues({ cores: [{ name: OTHER, focus: false, url: ovis.paneUrlTemplate(S.port) }] })
  assert.deepEqual(core.featuresOf(`${OTHER}/t1`).focus, { means: 'open_url' })
  await S.close()
})

test('앱 링크: 링크를 여는 명령이 실패하면 그 세션의 주소를 브라우저 탭으로 연다(이번에 찾은 포트). 그것도 실패하면 예전처럼 앱 창만 올린다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK }))
  linkApp()
  ovis._setLinkOps({ launch: async (...x) => { LAUNCHES.push(x); if (x[1][0].startsWith('ovis:')) throw Object.assign(new Error('open exited with 1'), { code: 'opener_failed' }); return 'ok' } })
  const r = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([r.window, r.opened, r.means, r.url], ['browser', 'browser', undefined, paneUrl(S.port, 't1')])
  assert.deepEqual(LAUNCHES, [linkOf('t1'), tabOf(S.port, 't1')])
  LAUNCHES.length = 0
  const n = await core.newSession({ session: `core:${OTHER}@`, cwd: WORK, command: 'claude' })
  assert.deepEqual([n.window, n.opened], ['browser', 'browser'])
  assert.deepEqual(LAUNCHES, [linkOf(n.pane), tabOf(S.port, n.pane)])
  // 둘 다 실패: 앱 창 올리기(예전 길)
  LAUNCHES.length = 0
  ovis._setLinkOps({ launch: async (...x) => { LAUNCHES.push(x); throw new Error('spawn ENOENT') } })
  const raised = []
  core._setWindowOps({ ...noWindows, appRunning: async () => true, raiseApp: async (...a) => { raised.push(a[0]); return 'raised' } })
  const r2 = await core.focus(`${OTHER}/t1`, { seq: seq() })
  assert.deepEqual([r2.window, r2.opened, LAUNCHES.length, raised], ['app_only', undefined, 2, [APP]])
  await S.close()
})

test('앱 링크: 다른 세션은 그대로다 — Herdr 앱 코어의 세션과 수단을 모르는 코어의 세션은 링크를 열지 않는다(링크를 아는 앱이 깔려 있어도)', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [profile(S.port)] })
  A.add(agentTerm('t1', 'idle', { labels: { 'herdr.space': 'spA', 'herdr.tab': 'tb1', where: 'my project / 1' }, cwd: WORK }))
  linkApp()
  assert.deepEqual(core.featuresOf('default/t1').focus, { means: 'app_command' })
  await core.focus('default/t1', { seq: seq() })
  await core.newSession({ session: 'core:spA', cwd: WORK, command: 'claude' })
  assert.deepEqual(LAUNCHES, [], 'Herdr 앱 코어: herdr-app 으로만')
  // 프로필이 없는 코어(보기 전용)
  setAutoValues(null)
  B.add(appTerm('t1', { cwd: WORK }))
  core.keepReading([OTHER])
  try { await core.focus(`${OTHER}/t1`, { seq: seq() }) } catch {}
  assert.deepEqual(LAUNCHES, [])
  core.keepReading([])
  await S.close()
})

test('앱 링크 — 보드 서버 끝에서 끝까지: 누르기·새 세션의 답이 어느 길로 보였는지(opened, means)를 싣는다. 링크가 실패해 탭으로 열었으면 화면이 앱 이름과 함께 그렇게 덧붙인다', async () => {
  await reset()
  const S = await appServer()
  setAutoValues({ cores: [plainProfile(S.port)] })
  B.add(appTerm('t1', { cwd: WORK }))
  linkApp()
  const db = openDb(':memory:'); await collectAll(db)
  const W = await boardFor(db)
  try {
    const c1 = await W.card(`${OTHER}/t1`)
    assert.deepEqual(c1.features.focus, { means: 'app_link' })
    const o = await W.post('/api/open', { id: W.idOf(`${OTHER}/t1`), seq: seq(), raise: true, web: false })
    assert.deepEqual([o.status, o.data.ok, o.data.code, o.data.means, o.data.opened, o.data.url], [200, true, 'focused', 'app_link', 'app_link', paneUrl(S.port, 't1')])
    assert.match(o.data.message, /shown in the app window by its link/)
    const nw = await W.post('/api/new', { session: `core:${OTHER}@`, cwd: homedir(), raise: true })
    assert.deepEqual([nw.status, nw.data.code, nw.data.means, nw.data.opened], [200, 'opened_new', 'server_api', 'app_link'])
    // 링크가 실패했다: 서버가 그 세션의 탭을 열었다
    ovis._setLinkOps({ launch: async (...x) => { LAUNCHES.push(x); if (x[1][0].startsWith('ovis:')) throw new Error('open exited with 1'); return 'ok' } })
    const f = await W.post('/api/open', { id: W.idOf(`${OTHER}/t1`), seq: seq(), raise: true, web: false })
    assert.deepEqual([f.data.ok, f.data.code, f.data.means, f.data.opened, f.data.app, f.data.url], [true, 'focused', 'open_url', 'browser', APP, paneUrl(S.port, 't1')])
    // 화면 문구: 그 덧붙임이 두 언어에 짝으로 있고, 받은 앱 이름만 끼워 넣는다
    for (const T of [I18N.ko, I18N.en]) for (const app of [APP, null]) {
      const text = T.linkTab(app)
      assert.ok(typeof text === 'string' && text.length > 10 && !/undefined|null/.test(text))
      assert.equal(text.includes(APP), Boolean(app))
    }
    assert.match(I18N.ko.linkTab(APP), /[가-힣].*브라우저 탭/); assert.doesNotMatch(I18N.en.linkTab(APP), /[가-힣]/); assert.match(I18N.en.linkTab(APP), /browser tab/)
    assert.match(HTML, /l = data\?\.ok && data\.opened === 'browser' \? T\.linkTab\(data\.app\) : ''/)
    // 다른 세션의 답에는 opened 가 없다(예전 그대로)
    for (const text of W.said) assert.equal(text.includes(TOKEN), false)
  } finally { await W.close(); await S.close() }
})

test('앱 링크 — 화면의 클릭 계획: 이동의 수단이 app_link 인 세션은 "탭으로만 보여 줄 세션"이 아니다 — 여는 곳을 아무도 정하지 않았으면 탭을 열지 않고 서버에 창을 보이게 한다. 웹 터미널·둘 다를 고른 사람은 그 값 그대로다', () => {
  const LINKED = ovis.coreFeatures({ server: 'ok', app: APP, link: true })
  const tpl = { [`whosup-open-url-core:${OTHER}`]: ovis.paneUrlTemplate(48021) }
  const url = paneUrl(48021, 't4')
  const plan = (card, saved) => web.clickPlanOf(card, store(saved), Object.keys(saved))
  assert.equal(web.tabOnly(appCard(LINKED)), false)
  assert.deepEqual(plan(appCard(LINKED), { ...tpl, 'whosup-open-url-on': 'off', 'whosup-raise': 'on', 'whosup-open-url-app': 'on' }), { url: '', raise: true }, '기본값: 링크로 앱 창에서(서버가 연다)')
  assert.deepEqual(plan(appCard(LINKED), { ...tpl, 'whosup-open-url-on': 'on', 'whosup-raise': 'off' }), { url, raise: false }, '웹 터미널을 고른 사람: 탭만')
  assert.deepEqual(plan(appCard(LINKED), { ...tpl, 'whosup-open-url-on': 'on', 'whosup-raise': 'on' }), { url, raise: true }, '둘 다를 고른 사람: 탭과 앱 창')
  // 새 세션·이어서 열기도 탭을 잡아 두지 않는다
  const later = new Function(`${blockOf('weburl')}\n${blockOf('latertab')}; return { laterTabPlan, coreShowOf }`)()
  assert.deepEqual(later.laterTabPlan(appCard(LINKED), store({ ...tpl, 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' })), { tab: false, raise: undefined })
  assert.equal(later.coreShowOf({ name: OTHER, app: APP, features: LINKED }, store({ ...tpl, 'whosup-open-url-on': 'off', 'whosup-open-url-app': 'on' })), 'app', '감지한 환경 줄: "누르면 그 앱 창이 앞으로 온다"')
})
