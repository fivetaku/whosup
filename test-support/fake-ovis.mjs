#!/usr/bin/env node
// 가짜 ovis 서버: 자동 감지(src/autoconf.mjs findOvis·probeOvis)가 읽는 두 답과 브리지 등록부 파일만 흉내 낸다. 실제 ovis·앱을 띄우지 않는 시험용.
// 응답 모양은 오비스 소스(server/dispatch.ts 의 /api/health, server/access.ts decideAccess, server/bridge.ts registerBridge)를 따른다:
//   GET /api/health?scope=bridge → { ok, auth, bridge_protocol, web_ui: { boot_id }, runtime, herdr_runtime? }
//   GET /api/health              → { ok, herdr, auth, version?, herdr_core?, herdr_runtime?, web_ui }
//     · herdr_runtime(serving …)·herdr_core 는 "이 PC 를 모는 주인"에게만 준다: 토큰이 걸린 서버(locked)는 인증 없는 요청에 주지 않는다.
//     · herdr_core 는 "이 PC 의 herdr-core 사실"이다: herdr 데스크를 보여 주는 서버(serving 'herdr')도 이 줄을 낸다(pcCore).
//   등록부 파일 <폴더>/<sha256(socket_path)>.json = { managed_remote, port, token, pid, generation, socket_path, bridge_protocol, bundle_version }
// 루프백에서만 듣는다. GET 만 받는다.
//
// 모듈로: startFakeOvis({ … }) → { port, requests, registryFile, close() }, writeBridgeFile(폴더, { port, pid, token, socketPath })
// 프로세스로(서버가 속한 앱 이름을 프로세스 조상에서 찾는 감지를 시험할 때):
//   node fake-ovis.mjs --serving herdr-core --core <이름> [--registry <폴더>] [--token <글자>] [--port <포트>]
//       듣기 시작하면 표준 출력에 {"port":…,"pid":…} 한 줄을 쓴다. SIGTERM 을 받으면 끝난다.
//   <임시>/<이름>.app/Contents/MacOS/<이름> fake-ovis.mjs --parent [위 인자…]
//       앱 본체 노릇: 남아서 서버를 자식 프로세스로 띄운다(자식은 진짜 node 경로로 뜬다 — 실제 앱의 서버처럼 부모와 실행 파일이 다르다).
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const LOCAL = { required: false, authenticated: true, via: 'local', role: 'drive' }
const TOKEN_REQUIRED = { required: true, authenticated: false, reason: 'token_required' }

export function writeBridgeFile(dir, { port, pid = process.pid, token = 'fake-ovis-token', socketPath = '/nonexistent/fake-ovis.sock' } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${createHash('sha256').update(socketPath).digest('hex')}.json`)
  writeFileSync(file, JSON.stringify({ managed_remote: false, port, token, pid, generation: 'fake', socket_path: socketPath, bridge_protocol: 1, bundle_version: 'fake' }), { mode: 0o600 })
  return file
}

// serving: 'herdr-core' | 'herdr'. core = 이 서버가 보여 주는 코어 이름(herdr-core 일 때). pcCore = herdr 를 보여 주는 서버가 내는 "이 PC 의 코어" 이름.
// signed:false = ovis 가 아닌 HTTP 서버(서명 없는 답). locked:true = 토큰이 걸린 서버(주인에게만 주는 사실을 빼고 답한다).
// registry = 등록부 폴더(주면 등록 파일을 쓴다 — token 은 그 파일에만 들어간다).
export function startFakeOvis({ port = 0, serving = 'herdr-core', core = null, pcCore = 'default', signed = true, locked = false, registry = null, token = 'fake-ovis-token', socketPath, pid = process.pid, boot = 'fake-boot' } = {}) {
  const requests = []
  const auth = locked ? TOKEN_REQUIRED : LOCAL
  const runtime = { serving, source: serving === 'herdr-core' ? 'env' : 'detected', switch_to: null, locked: serving === 'herdr-core' ? 'env' : null }
  const facts = locked ? {} : { herdr_runtime: runtime }
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    requests.push({ method: req.method, path: url.pathname + url.search, headers: { ...req.headers } })
    const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)) }
    if (req.method !== 'GET') return json(405, { ok: false })
    if (url.pathname !== '/api/health') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end('<!doctype html><title>fake ovis</title>') }
    if (!signed) return json(200, { ok: true })
    if (url.searchParams.get('scope') === 'bridge') return json(200, { ok: true, auth, bridge_protocol: 1, web_ui: { boot_id: boot }, runtime: serving, ...facts })
    const herdrCore = serving === 'herdr-core' ? { version: '0.0.0-fake', session: core, running: true } : { version: '0.0.0-fake', session: pcCore, running: false }
    return json(200, { ok: true, herdr: { version: '0.0.0-fake', protocol: 22 }, auth, ...(locked ? {} : { version: '0.0.0-fake', herdr_core: herdrCore }), ...facts, web_ui: { boot_id: boot, revision: null } })
  })
  return new Promise((done, fail) => {
    server.once('error', fail)
    server.listen(port, '127.0.0.1', () => {
      const at = server.address().port
      const registryFile = registry ? writeBridgeFile(registry, { port: at, pid, token, ...(socketPath ? { socketPath } : {}) }) : null
      done({ port: at, requests, registryFile, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) }) })
    })
  })
}

// ── 프로세스로 ──
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2)
  const arg = (k, d = undefined) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d }
  if (argv.includes('--parent')) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), ...argv.filter((a) => a !== '--parent')], { stdio: 'inherit' })
    const stop = () => { try { child.kill('SIGTERM') } catch {} setTimeout(() => process.exit(0), 300) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
    child.on('exit', (code) => process.exit(code ?? 0))
  } else {
    const s = await startFakeOvis({ port: Number(arg('--port', 0)), serving: arg('--serving', 'herdr-core'), core: arg('--core', null), registry: arg('--registry', null), token: arg('--token', 'fake-ovis-token'), locked: argv.includes('--locked') })
    console.log(JSON.stringify({ port: s.port, pid: process.pid }))
    const stop = () => { s.close().then(() => process.exit(0)); setTimeout(() => process.exit(0), 300) }
    process.on('SIGTERM', stop); process.on('SIGINT', stop)
  }
}
