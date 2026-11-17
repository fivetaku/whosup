// whosup 전용 Node(install.sh — 쓸 만한 node가 없을 때 nodejs.org의 공식 배포 파일을 <데이터 폴더>/node에 받아 whosup만 쓴다).
// 네트워크에 닿지 않는다: WHOSUP_NODE_DIST_URL을 127.0.0.1의 가짜 배포 서버로 준다. 그 서버의 tar.gz 안 bin/node는 이 시험을 돌리는
// node를 부르는 작은 스크립트이고, SHASUMS256.txt는 그 파일의 sha256이다(틀린 값을 주는 시험도 있다).
// 이 기계의 node는 PATH에서 뺀다(rig({ node: false }) — <임시>/bin:/usr/bin:/bin만 본다). /usr/bin·/bin에 node가 있는 기계에서는 건너뛴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { basename, join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import { NODE_MARK, NODE_MARK_FILE } from '../src/standalone.mjs'
import { INSTALL, ROOT, exe, posix, rig as bareRig, shq } from '../test-support/install-rig.mjs'

if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'

const PIN = /^NODE_PIN="([^"]+)"$/m.exec(readFileSync(INSTALL, 'utf8'))[1]
const PLAT = `${process.platform === 'darwin' ? 'darwin' : 'linux'}-${process.arch === 'arm64' ? 'arm64' : 'x64'}`
const FILE = `node-${PIN}-${PLAT}.tar.gz`
const systemNode = existsSync('/usr/bin/node') || existsSync('/bin/node')
const opts = { ...posix, skip: posix.skip || (systemNode ? '/usr/bin·/bin에 node가 있어 "node 없음"을 만들 수 없다' : false) || (['darwin', 'linux'].includes(process.platform) ? false : 'macOS·Linux만') }

// 시험마다 격리 환경 + 앱 설치기 대역(진짜 앱 설치기를 부르지 않는다)
const rig = async (o) => {
  const r = await bareRig(o), env = r.env
  r.env = (over = {}) => env({ WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), ...over })
  return r
}

// 가짜 배포 서버: /<PIN>/<FILE> 과 /<PIN>/SHASUMS256.txt. sum = SHASUMS에 적을 값(기본은 맞는 값). hold = 받기 요청을 붙잡아 둔다(신호 시험).
async function distServer(base, { sum = null, hold = false } = {}) {
  const work = join(base, 'dist-build'), top = `node-${PIN}-${PLAT}`
  mkdirSync(join(work, top, 'bin'), { recursive: true })
  exe(join(work, top, 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`)
  writeFileSync(join(work, top, 'README.md'), 'fake node\n')
  const tgz = join(base, FILE)
  execFileSync('tar', ['-czf', tgz, '-C', work, top])
  const body = readFileSync(tgz)
  const real = createHash('sha256').update(body).digest('hex')
  const shasums = `${'0'.repeat(64)}  node-${PIN}-aix-ppc64.tar.gz\n${sum ?? real}  ${FILE}\n`
  const hits = []
  let release = null
  const held = new Promise((ok) => { release = ok })
  const server = createServer(async (req, res) => {
    hits.push(req.url)
    if (req.url === `/${PIN}/${FILE}`) {
      if (hold) { res.writeHead(200, { 'content-length': String(body.length) }); res.write(body.subarray(0, 100)); await held; res.destroy(); return }
      res.writeHead(200); res.end(body); return
    }
    if (req.url === `/${PIN}/SHASUMS256.txt`) { res.writeHead(200); res.end(shasums); return }
    res.writeHead(404); res.end()
  })
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => { release(); server.closeAllConnections?.(); server.close() } }
}
const own = (r) => join(r.data, 'node')
const leftovers = (r) => (existsSync(r.data) ? readdirSync(r.data).filter((n) => n.startsWith('.node-new')) : [])
// 새 버전 흉내: 이 저장소를 복사해 scripts/standalone.mjs를 갈아 끼운다(그 판이 설치기의 확인 단계에서 돌지 않게)
const broken = (r) => {
  const src = join(r.base, 'broken')
  cpSync(ROOT, src, { recursive: true, filter: (p) => !['.git', 'node_modules', '.whosup'].includes(basename(p)) })
  writeFileSync(join(src, 'scripts', 'standalone.mjs'), 'process.exit(3)\n')
  return src
}
// 이전 설치기가 놓은 전용 Node(낮은 판)
const oldOwn = (r, version = 'v22.13.0') => {
  mkdirSync(join(own(r), 'bin'), { recursive: true })
  exe(join(own(r), 'bin', 'node'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`)
  writeFileSync(join(own(r), NODE_MARK_FILE), `${NODE_MARK}\nversion=${version}\n`)
}
const markVersion = (r) => /^version=(.*)$/m.exec(readFileSync(join(own(r), NODE_MARK_FILE), 'utf8'))?.[1]

test('전용 Node: 쓸 만한 node가 없고 WHOSUP_INSTALL_NODE=1이면 받아(체크섬 확인) <데이터 폴더>/node에 놓고, 설치 기록·실행 명령·로그인 항목·보드가 그 node를 쓴다. uninstall이 지운다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base)
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(a.code, 0, a.all)
    assert.deepEqual(d.hits, [`/${PIN}/${FILE}`, `/${PIN}/SHASUMS256.txt`])
    const node = join(own(r), 'bin', 'node')
    assert.ok(existsSync(node)); assert.equal(markVersion(r), PIN)
    assert.match(readFileSync(join(own(r), NODE_MARK_FILE), 'utf8'), new RegExp(`^${NODE_MARK}\n`))
    assert.match(a.out, new RegExp(`whosup's own Node ${PIN.replace(/\./g, '\\.')} is in`))
    assert.deepEqual(leftovers(r), [], '받던 폴더를 남기지 않는다')
    assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).node, node)
    assert.ok(readFileSync(r.launcher, 'utf8').includes(`WHOSUP_NODE=${shq(node)}`), '실행 명령')
    assert.ok(readFileSync(r.loginFile, 'utf8').includes(node), '로그인 항목')
    assert.equal(await r.health(), true)
    // 실행 명령도 그 node로 돈다(PATH에 node가 없어도)
    const s = await r.whosup(['status'])
    assert.equal(s.code, 0, s.all)
    // 제거: 전용 Node는 프로그램 쪽이다(--purge가 아니어도 지운다)
    const u = await r.whosup(['uninstall'])
    assert.equal(u.code, 0, u.all)
    assert.ok(!existsSync(own(r)), u.all); assert.match(u.out, new RegExp(`${own(r).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))
    assert.ok(!existsSync(r.data), '빈 데이터 폴더도 치운다')
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: SHASUMS256.txt의 체크섬과 맞지 않으면 설치 전체를 멈추고 아무것도 남기지 않는다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base, { sum: 'f'.repeat(64) })
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(a.code, 1, a.all)
    assert.match(a.err, /could not get whosup's own Node .*: the download does not match its checksum in SHASUMS256\.txt, so it was not used\. Nothing was installed\./)
    assert.ok(!existsSync(r.data), `데이터 폴더가 남았다: ${existsSync(r.data) ? readdirSync(r.data) : ''}`)
    assert.ok(!existsSync(r.launcher))
  } finally { d.close(); r.cleanup() }
  // 배포 서버에 그 파일이 없다(404): 같은 방식으로 멈춘다
  const r2 = await rig({ node: false })
  try {
    const b = await r2.install({ WHOSUP_INSTALL_NODE: 'yes', WHOSUP_NODE_DIST_URL: 'http://127.0.0.1:9/none' })
    assert.equal(b.code, 1, b.all); assert.match(b.err, /could not be downloaded\. Check the connection\. Nothing was installed\./)
    assert.ok(!existsSync(r2.data))
  } finally { r2.cleanup() }
})

test('전용 Node: 터미널이 없고 스위치도 없으면 받지 않는다 — 지금까지의 안내 한 줄 그대로. WHOSUP_INSTALL_NODE=0(·빈 값)이어도 같다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base)
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(a.code, 1, a.all)
    assert.equal(a.err.trimEnd().split('\n').length, 1, a.err)
    assert.match(a.err, /needs Node 22\.13 or newer, and node is not on the PATH\. .* Nothing was installed\./)
    for (const off of ['0', '', 'off']) {
      const b = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NODE_DIST_URL: d.url, WHOSUP_INSTALL_NODE: off })
      assert.equal(b.code, 1, b.all); assert.doesNotMatch(b.all, /WHOSUP_INSTALL_NODE/); assert.match(b.err, /needs Node 22\.13 or newer/)
    }
    // 낮은 node만 있다: 받지 않고 그 판을 알린다(지금까지와 같다)
    exe(join(r.bin, 'node'), '#!/bin/sh\nif [ "$1" = -v ]; then echo v20.11.0; exit 0; fi\nexit 1\n')
    const c = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(c.code, 1, c.all); assert.match(c.err, /needs Node 22\.13 or newer; this is v20\.11\.0\./)
    assert.deepEqual(d.hits, [])
    assert.ok(!existsSync(r.data))
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: 쓸 만한 시스템 node가 있으면 스위치가 켜져 있어도 아무것도 받지 않는다', { ...posix }, async () => {
  const r = await rig()
  const d = await distServer(r.base)
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(a.code, 0, a.all)
    assert.deepEqual(d.hits, []); assert.ok(!existsSync(own(r)))
    assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).node, join(r.bin, 'node'))
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: 설치가 끝나지 못하면(받은 판이 돌지 않음) 이번에 받은 Node를 치운다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base)
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url, WHOSUP_INSTALL_SOURCE: broken(r) })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /does not run here/)
    assert.equal(d.hits.length, 2)
    assert.ok(!existsSync(r.data), `남았다: ${existsSync(r.data) ? readdirSync(r.data) : ''}`)
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: 받는 도중 Ctrl-C(SIGINT)면 받던 폴더를 치우고 130으로 끝난다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base, { hold: true })
  try {
    let child = null
    const run = r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url }, { onSpawn: (c) => { child = c } })
    for (let i = 0; i < 400 && !d.hits.length; i++) await sleep(25)
    assert.equal(d.hits.length, 1)
    await sleep(200)
    process.kill(-child.pid, 'SIGINT')
    const a = await run
    assert.equal(a.code, 130, a.all)
    assert.ok(!existsSync(r.data), `남았다: ${existsSync(r.data) ? readdirSync(r.data) : ''}`)
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: 이전 설치기가 받은 낮은 판은 묻지 않고 고정한 판으로 바꾼다 — 설치가 끝나지 못하면 이전 판을 되돌린다. WHOSUP_INSTALL_NODE=0이면 바꾸지 않는다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base)
  try {
    oldOwn(r)
    // 끝나지 못한 설치: 바꾼 판을 치우고 이전 판을 되돌린다
    const f = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NODE_DIST_URL: d.url, WHOSUP_INSTALL_SOURCE: broken(r) })
    assert.equal(f.code, 1, f.all); assert.match(f.out, /whosup's own Node v22\.13\.0 is older than/)
    assert.equal(markVersion(r), 'v22.13.0'); assert.deepEqual(leftovers(r), [])
    // 스위치가 꺼져 있으면 낮은 판(그래도 22.13 이상)을 그대로 쓴다
    const k = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1', WHOSUP_NODE_DIST_URL: d.url, WHOSUP_INSTALL_NODE: '0' })
    assert.equal(k.code, 0, k.all); assert.equal(markVersion(r), 'v22.13.0'); assert.equal(d.hits.length, 2)
    assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).node, join(own(r), 'bin', 'node'))
    // 새 버전으로 바꾸는 설치(whosup update와 같은 길): 터미널이 없어도 묻지 않고 바꾼다
    const u = await r.whosup(['update'], { WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(u.code, 0, u.all); assert.equal(markVersion(r), PIN); assert.equal(d.hits.length, 4); assert.deepEqual(leftovers(r), [])
    assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).node, join(own(r), 'bin', 'node'))
    // 이미 고정한 판이면 받지 않는다
    const again = await r.whosup(['update'], { WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(again.code, 0, again.all); assert.equal(d.hits.length, 4)
    assert.equal((await r.whosup(['uninstall'])).code, 0); assert.ok(!existsSync(own(r)))
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: 그 자리에 남의 폴더가 있으면 받지도 건드리지도 않는다. uninstall도 표식 없는 node 폴더는 남긴다', opts, async () => {
  const r = await rig({ node: false })
  const d = await distServer(r.base)
  try {
    mkdirSync(join(own(r), 'bin'), { recursive: true }); writeFileSync(join(own(r), 'mine'), 'x')
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_NODE: '1', WHOSUP_NODE_DIST_URL: d.url })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /is there and is not whosup's own Node/)
    assert.deepEqual(d.hits, []); assert.ok(existsSync(join(own(r), 'mine')))
  } finally { d.close(); r.cleanup() }
})

test('전용 Node: herdr 플러그인의 입구(scripts/node-path.sh)는 전용 Node를 맨 뒤 후보로 찾는다 — 내려받지는 않는다', posix, () => {
  const base = execFileSync('mktemp', ['-d', join(osTmpdir(), 'wsn-XXXXXX')], { encoding: 'utf8' }).trim()
  const home = join(base, 'h'), bin = join(home, '.local', 'share', 'whosup', 'node', 'bin')
  mkdirSync(bin, { recursive: true })
  exe(join(bin, 'node'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`)
  const pick = (env) => execFileSync('/bin/sh', ['-c', '. "$1"; printf "%s|%s" "$WHOSUP_NODE_PICK" "$PATH"', 'sh', join(ROOT, 'scripts', 'node-path.sh')], { env, encoding: 'utf8' })
  assert.equal(pick({ HOME: home, PATH: '/nonexistent', WHOSUP_EXTRA_PATH: '' }), `${join(bin, 'node')}|${bin}:/nonexistent`)
  // 쓸 만한 node가 PATH에 있으면 그것이 먼저다
  const sys = join(base, 'sys'); mkdirSync(sys); exe(join(sys, 'node'), `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`)
  assert.equal(pick({ HOME: home, PATH: sys, WHOSUP_EXTRA_PATH: '' }).split('|')[0], join(sys, 'node'))
  // 플러그인 입구는 받지 않는다
  for (const f of ['preflight.sh', 'node-path.sh', 'plugin.sh']) assert.doesNotMatch(readFileSync(join(ROOT, 'scripts', f), 'utf8'), /nodejs\.org\/dist|WHOSUP_NODE_DIST_URL|NODE_PIN=/)
})

test('배선: 전용 Node의 표식·고정 판·배포 주소', () => {
  const install = readFileSync(INSTALL, 'utf8')
  assert.equal(/^NODE_MARK_FILE="([^"]+)"$/m.exec(install)[1], NODE_MARK_FILE)
  assert.equal(/^NODE_MARK_TEXT="([^"]+)"$/m.exec(install)[1], NODE_MARK)
  assert.match(PIN, /^v(22|24)\.\d+\.\d+$/, 'Node 22 또는 24 LTS')
  assert.match(install, /^NODE_DIST="https:\/\/nodejs\.org\/dist"$/m)
  // 받기는 https만(시험의 127.0.0.1 http만 예외 — curl_proto), 체크섬 확인을 건너뛰는 길이 없다
  assert.match(install, /curl_proto "\$node_base"/)
  assert.match(install, /if \[ "\$\{#node_want\}" != 64 \] \|\| \[ "\$node_have" != "\$node_want" \]; then/)
})

// 터미널에서 묻기: python3의 pty로 가짜 터미널을 만들어 설치기를 돌린다(그 터미널이 제어 터미널이 된다). 질문이 나오면 답을 친다.
// Enter = 받는다, n = 받지 않는다.
const PTY_PY = `
import os, pty, sys, select, time
answer = sys.argv[1].encode().decode('unicode_escape').encode()
pid, fd = pty.fork()
if pid == 0:
    os.execvp(sys.argv[2], sys.argv[2:])
out = b''; sent = False; end = time.time() + 80
while time.time() < end:
    r, _, _ = select.select([fd], [], [], 0.2)
    if r:
        try: chunk = os.read(fd, 4096)
        except OSError: break
        if not chunk: break
        out += chunk
        if not sent and b'[Y/n] ' in out:
            os.write(fd, answer); sent = True
sys.stdout.buffer.write(out)
_, st = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(st) if hasattr(os, 'waitstatus_to_exitcode') else 0)
`
const hasPy = (() => { try { execFileSync('python3', ['-c', 'import pty'], { stdio: 'ignore' }); return true } catch { return false } })()
test('전용 Node: 터미널이면 한 번 묻는다 — Enter는 받고, n은 받지 않고 지금까지의 안내로 끝낸다', { ...opts, skip: opts.skip || (hasPy ? false : 'python3 pty 없음') }, async () => {
  for (const [answer, want] of [['n\\r', 'no'], ['\\r', 'yes']]) {
    const r = await rig({ node: false })
    const d = await distServer(r.base)
    try {
      const env = Object.fromEntries(Object.entries(r.env({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NODE_DIST_URL: d.url, WHOSUP_UI: 'plain', WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1', WHOSUP_NO_SETUP: undefined, TERM: 'dumb', WHOSUP_SETUP_TIMEOUT_S: '5' })).filter(([, v]) => v !== undefined))
      const out = await new Promise((ok, no) => {
        const c = spawn('python3', ['-I', '-c', PTY_PY, answer, '/bin/sh', INSTALL], { env: { ...env, PATH: `${r.bin}:/usr/bin:/bin` }, cwd: r.base, stdio: ['ignore', 'pipe', 'pipe'] })
        let o = ''
        c.stdout.on('data', (x) => { o += x }); c.stderr.on('data', (x) => { o += x })
        const t = setTimeout(() => { c.kill('SIGKILL'); no(new Error(`timed out\n${o}`)) }, 90000)
        c.on('close', (code) => { clearTimeout(t); ok({ code, o }) })
      })
      assert.match(out.o, new RegExp(`Download whosup's own Node ${PIN.replace(/\./g, '\\.')} into ~/\\.local/share/whosup/node\\? \\(Your system Node is left as it is\\.\\) \\[Y/n\\]`), out.o)
      if (want === 'no') { assert.deepEqual(d.hits, [], out.o); assert.match(out.o, /needs Node 22\.13 or newer/); assert.ok(!existsSync(r.data)) }
      else { assert.equal(d.hits.length, 2, out.o); assert.equal(markVersion(r), PIN); assert.ok(existsSync(r.record), out.o) }
    } finally { d.close(); r.cleanup() }
  }
})
