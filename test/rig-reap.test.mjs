// 설치기 시험 도구(test-support/install-rig.mjs)의 정리: 시험 프로세스가 끝나면(정상 종료·SIGTERM) 자기가 만든 임시 폴더의
// server.pid 또는 시험 전용 장부가 가리키고 작업 폴더도 자기가 만든 폴더 안인 보드를 끝낸다. 그 보드 파일을 인자로 연 다른 프로세스와, 남의 PID를
// 가리키는 pid 파일의 프로세스(작업 폴더가 밖)는 남긴다. 2026-11-17~20 야간 회귀가 시험을 SIGTERM으로 끊을 때마다 보드가 남았다.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, posix, rig } from '../test-support/install-rig.mjs'

const RIG = pathToFileURL(join(ROOT, 'test-support', 'install-rig.mjs')).href
// 띄운 프로세스는 스크립트를 다 읽고 'ready'를 찍는다 — 시험 프로세스 흉내는 그것을 받은 뒤에야 끝난다(먼저 끝나면 폴더가 지워져
// 스크립트를 못 읽고 스스로 죽으므로, 정리가 끝낸 것과 구별되지 않는다).
const IDLE = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\n"
// 보드가 아닌 프로세스는 SIGTERM에 그냥 끝난다 — 흉내의 프로세스 그룹에 SIGTERM을 보내면 같이 끝난다.
const PLAIN = "console.log('ready'); setInterval(() => {}, 1000)\n"
const OUTSIDE = join(tmpdir(), `whosup-reap-outside-${process.pid}.mjs`)
const CHILD_FILE = join(tmpdir(), `whosup-reap-child-${process.pid}.mjs`)
const PRELOAD = pathToFileURL(join(ROOT, 'test-support', 'install-board-pid.mjs')).href
// 유닉스 소켓을 열고 'up', 연결이 들어올 때마다 'conn'을 찍는다(소유자 소켓 흉내).
const LISTEN = "require('node:net').createServer(() => console.log('conn')).listen(process.argv[1], () => console.log('up'))"
const FOREIGN_DIR = join(tmpdir(), `whosup-reap-foreign-${process.pid}`)
const FOREIGN_BOARD = join(FOREIGN_DIR, 'whosup.mjs')

// 이 시험이 어떻게 끝나든(실패·SIGTERM 포함) 흉내와 그것이 띄운 프로세스, 임시 스크립트를 치운다. 흉내는 새 프로세스 그룹으로
// 띄우고(띄우는 순간 그룹 번호를 안다), 보드가 아닌 프로세스는 그 그룹 안에 띄운다 — PID를 받기 전에 끊겨도 그룹에 SIGTERM을
// 보내면 흉내는 rig 정리로 보드를 끝내고, 나머지는 그냥 끝난다. 보드(새 세션)는 PID를 받았으면 여기서도 끝낸다.
const groups = new Set(), spawned = new Set()
const tidy = () => {
  for (const g of groups) { try { process.kill(-g, 'SIGTERM') } catch {} }
  for (const pid of spawned) { try { process.kill(pid, 'SIGKILL') } catch {} }
  groups.clear(); spawned.clear()
  for (const f of [OUTSIDE, CHILD_FILE]) rmSync(f, { force: true })
  rmSync(FOREIGN_DIR, { recursive: true, force: true })
}
process.once('exit', tidy)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => { tidy(); process.kill(process.pid, sig) })
after(tidy)

// 시험 프로세스 흉내: rig를 만들고, SIGTERM을 무시하는 보드 둘을 띄운다 — 하나는 rig 안(공백 든 경로, node 플래그),
// 하나는 따로 등록한(track) 다른 임시 폴더 안. 둘의 PID는 rig 안의 server.pid들에 적는다. 같은 rig 안의 스크립트로 보드 파일을
// 인자로 여는 프로세스(작업 폴더는 밖 — 명령 줄만 보면 보드처럼 보인다)와, 남의 프로세스를 가리키는 pid 파일도 둔다.
// 보드는 실제 보드처럼 새 세션(detached)에, 나머지는 흉내의 프로세스 그룹 안에 띄운다. wait면 끝나지 않고 기다린다.
const CHILD = `
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
const { rig, track } = await import(${JSON.stringify(RIG)})
const IDLE = ${JSON.stringify(IDLE)}, PLAIN = ${JSON.stringify(PLAIN)}
// PID 기록 전을 재현할 때는 server.pid를 쓰지 않는다. 장부는 Node가 실제 스크립트를 읽기 전에 별도로 적는다.
const start = (args, cwd, detached = false, pidFile = null, root = r.base) => new Promise((ok, fail) => {
  const p = spawn(process.execPath, args, { cwd, detached, env: r.env({ WHOSUP_TEST_BOARD_PIDS: join(root, '.board-pids') }), stdio: ['ignore', 'pipe', 'ignore'] })
  if (pidFile && process.argv[3] !== 'no-pid') { mkdirSync(dirname(pidFile), { recursive: true }); writeFileSync(pidFile, String(p.pid)) }
  console.log('pid ' + p.pid)
  p.once('exit', (code) => fail(new Error('exited before ready: ' + code)))
  p.stdout.once('data', () => { p.removeAllListeners('exit'); p.stdout.destroy(); p.unref(); ok(p.pid) })
})
const r = await rig()
const app = join(r.home, 'my app'); mkdirSync(join(app, 'bin'), { recursive: true }); mkdirSync(r.state, { recursive: true })
const board = join(app, 'bin', 'whosup.mjs'); writeFileSync(board, IDLE)
const elsewhere = track(mkdtempSync(join(tmpdir(), 'wsi-reap-')))
const board2 = join(elsewhere, 'whosup.mjs'); writeFileSync(board2, IDLE)
const reader = join(r.base, 'reader.mjs'); writeFileSync(reader, PLAIN)
const pids = {
  board: await start(['--no-warnings', board], app, true, join(r.state, 'server.pid')),
  board2: await start([board2], elsewhere, true, join(r.base, 'xb', 'whosup', 'server.pid'), elsewhere),
  reader: await start([reader, board], ${JSON.stringify(tmpdir())}),
  readerInside: await start([reader, board], app),
  evalReader: await start(['--eval', PLAIN, board], app),
  outsideScript: await start([${JSON.stringify(FOREIGN_BOARD)}], app),
  outsideCwd: await start([board], ${JSON.stringify(tmpdir())}),
  other: await start([${JSON.stringify(OUTSIDE)}], ${JSON.stringify(tmpdir())}),
}
mkdirSync(join(r.base, 'xs', 'whosup'), { recursive: true }); writeFileSync(join(r.base, 'xs', 'whosup', 'server.pid'), String(pids.other))
console.log('pids ' + JSON.stringify({ ...pids, base: r.base, elsewhere }))
if (process.argv[2] !== 'exit') setInterval(() => {}, 1000)
`

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
// node 프로세스를 띄우고 첫 출력을 기다린다. p.out에 출력이 쌓인다. 띄운 것은 tidy가 끝낸다.
const ready = (args, opts = {}) => new Promise((ok, fail) => {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'ignore'], ...opts })
  spawned.add(p.pid)
  p.out = ''
  p.once('exit', (code) => fail(new Error(`exited before ready: ${code}`)))
  p.stdout.on('data', (d) => { p.out += d; p.emit('out') })
  p.stdout.once('data', () => { p.removeAllListeners('exit'); ok(p) })
})
// 남은 소켓 파일: 받던 프로세스를 SIGKILL로 끝내면 파일은 남고 연결은 거절된다.
const staleSocket = async (path) => { const l = await ready(['-e', LISTEN, path]); const done = new Promise((r) => l.once('exit', r)); l.kill('SIGKILL'); await done; return path }
// SIGKILL을 받은 남의(자식이 아닌) 프로세스가 사라지는 것은 알려 주는 사건이 없다 — 그 상태를 기한 안에서 다시 본다.
const gone = async (pid, ms = 5000) => { const end = Date.now() + ms; while (alive(pid)) { if (Date.now() > end) return false; await new Promise((r) => setTimeout(r, 20)) } return true }

// 흉내를 돌려 PID들을 받는다. 다 띄우기 전에 끝나거나 20초 안에 알리지 않으면 실패한다(흉내는 SIGTERM으로 끝내 rig 정리가 돈다).
function run(mode, pidMode = 'pid') {
  const child = spawn(process.execPath, [CHILD_FILE, mode, pidMode], { detached: true, stdio: ['ignore', 'pipe', 'inherit'] })
  groups.add(child.pid)
  const exited = new Promise((resolve) => child.once('exit', resolve))
  return new Promise((resolve, reject) => {
    let buf = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('the simulated test did not report its processes in 20s')) }, 20000)
    const early = (code) => { clearTimeout(timer); reject(new Error(`the simulated test exited before reporting (${code})`)) }
    child.once('exit', early)
    child.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1)
        if (line.startsWith('pid ')) spawned.add(Number(line.slice(4)))
        if (line.startsWith('pids ')) {
          clearTimeout(timer); child.off('exit', early)
          const pids = JSON.parse(line.slice(5))
          if (mode === 'wait') child.kill('SIGTERM')
          if (mode === 'kill') child.kill('SIGKILL')   // 그 프로세스만(그룹이 아니다) — 정리 코드가 돌 틈이 없다
          exited.then(() => resolve(pids))
        }
      }
    })
  })
}

writeFileSync(OUTSIDE, PLAIN)
writeFileSync(CHILD_FILE, CHILD)
mkdirSync(FOREIGN_DIR, { recursive: true }); writeFileSync(FOREIGN_BOARD, PLAIN)
for (const mode of ['exit', 'wait']) for (const pidMode of ['pid', 'no-pid']) {
  test(`정리(${mode === 'exit' ? '정상 종료' : 'SIGTERM'}, ${pidMode === 'pid' ? 'PID 기록 후' : 'PID 기록 전'}): 자기 폴더의 보드만 끝내고, 보드 파일을 연 프로세스와 남의 PID는 남긴다`, posix, async () => {
    try {
      const { board, board2, reader, readerInside, evalReader, outsideScript, outsideCwd, other } = await run(mode, pidMode)
      assert.equal(await gone(board), true, 'SIGTERM을 무시하는 보드가 남았다')
      assert.equal(await gone(board2), true, '다른 임시 폴더(track)에서 도는 보드가 남았다')
      assert.equal(alive(reader), true, '보드 파일을 인자로 연 프로세스를 끝냈다')
      assert.equal(alive(readerInside), true, '같은 작업 폴더에서 보드 파일을 인자로 연 프로세스를 끝냈다')
      assert.equal(alive(evalReader), true, 'node --eval의 인자를 실행할 스크립트로 잘못 보았다')
      assert.equal(alive(outsideScript), true, '스크립트가 임시 폴더 밖인 프로세스를 끝냈다')
      assert.equal(alive(outsideCwd), true, '작업 폴더가 임시 폴더 밖인 프로세스를 끝냈다')
      assert.equal(alive(other), true, '작업 폴더가 밖인 남의 프로세스를 끝냈다')
    } finally { tidy(); writeFileSync(OUTSIDE, PLAIN); writeFileSync(CHILD_FILE, CHILD); mkdirSync(FOREIGN_DIR, { recursive: true }); writeFileSync(FOREIGN_BOARD, PLAIN) }
  })
}

// SIGKILL은 받은 프로세스가 아무것도 못 한다. 보드는 새 세션(detached)이라 프로세스 트리·그룹에서도 빠진다 — 보드가 스스로
// 시험 프로세스의 죽음을 알아야 한다. 남는 임시 폴더는 다음 rig가 치운다(그 폴더의 주인 프로세스가 끝난 것이 확인될 때만).
test('정리(SIGKILL): 정리 코드를 돌리지 못하고 죽은 시험 프로세스의 보드는 스스로 끝나고, 다른 프로세스는 남는다. 다음 rig가 그 임시 폴더를 치운다', posix, async () => {
  let dirs = []
  try {
    const { board, board2, reader, readerInside, evalReader, outsideScript, outsideCwd, other, base, elsewhere } = await run('kill')
    dirs = [base, elsewhere]
    assert.equal(await gone(board), true, '죽은 시험 프로세스의 보드가 남았다')
    assert.equal(await gone(board2), true, '죽은 시험 프로세스가 다른 임시 폴더(track)에 띄운 보드가 남았다')
    for (const [name, pid] of Object.entries({ reader, readerInside, evalReader, outsideScript, outsideCwd, other })) assert.equal(alive(pid), true, `보드가 아닌 프로세스(${name})가 끝났다`)
    assert.equal(existsSync(base), true, 'SIGKILL이면 임시 폴더는 남는다(이 시험의 전제)')
    // 주인이 살아 있는 폴더: 그 소켓이 연결을 거절해도(대기열이 찼다·멈췄다 — macOS는 그때도 ECONNREFUSED) 치우지 않는다
    const live = mkdtempSync(join(tmpdir(), 'wsi-live-')); dirs.push(live)
    const holder = await ready(['-e', PLAIN])
    writeFileSync(join(live, 'owner.pid'), String(holder.pid))
    assert.equal(existsSync(await staleSocket(join(live, 'owner.sock'))), true, '거절하는 소켓 파일이 남아야 한다(이 시험의 전제)')
    await rig()   // 이 프로세스의 첫 rig: 주인이 끝난 폴더를 치운다
    assert.equal(existsSync(base), false, '죽은 시험 프로세스의 임시 폴더가 남았다')
    assert.equal(existsSync(live), true, '주인이 살아 있는 임시 폴더를 지웠다')
  } finally { tidy(); for (const d of dirs) rmSync(d, { recursive: true, force: true }); writeFileSync(OUTSIDE, PLAIN); writeFileSync(CHILD_FILE, CHILD); mkdirSync(FOREIGN_DIR, { recursive: true }); writeFileSync(FOREIGN_BOARD, PLAIN) }
})

// 보드는 주인 소켓에 처음 붙지 못했다는 것만으로 끝나지 않는다(주인이 살아 있어도 대기열이 찼거나 아직 받지 않을 수 있다) —
// 주인이 살아 있으면 다시 붙는다. 붙어 있던 연결이 끊기면(주인이 끝났다) 끝난다.
test('보드: 주인 소켓에 처음 붙지 못해도 주인이 살아 있으면 끝나지 않고 다시 붙는다. 붙어 있던 연결이 끊기면 끝난다', posix, async () => {
  const root = mkdtempSync(join(tmpdir(), 'whosup-own-'))
  try {
    const sock = join(root, 'owner.sock'), board = join(root, 'whosup.mjs')
    writeFileSync(board, IDLE)
    const env = { ...process.env, NODE_OPTIONS: `--import=${PRELOAD}`, WHOSUP_TEST_BOARD_PIDS: join(root, '.board-pids'), WHOSUP_TEST_OWNER: sock, WHOSUP_TEST_OWNER_PID: String(process.pid) }
    const b = await ready([board], { cwd: root, env, detached: true })   // 주인(이 프로세스)은 살아 있고, 받는 소켓은 아직 없다
    const l = await ready(['-e', LISTEN, sock])                          // 이제 받는다: 보드가 다시 붙어야 한다
    await new Promise((ok, fail) => {
      const timer = setTimeout(() => fail(new Error('보드가 다시 붙지 않았다(처음 붙지 못하자 끝났다)')), 10000)
      const seen = () => { if (l.out.includes('conn')) { clearTimeout(timer); l.off('out', seen); ok() } }
      l.on('out', seen); seen()
    })
    assert.equal(alive(b.pid), true)
    l.kill('SIGKILL')
    assert.equal(await gone(b.pid), true, '붙어 있던 연결이 끊겼는데 보드가 남았다')
  } finally { tidy(); rmSync(root, { recursive: true, force: true }) }
})
