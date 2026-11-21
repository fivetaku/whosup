// 설치기 시험 도구(test-support/install-rig.mjs)의 정리: 시험 프로세스가 끝나면(정상 종료·SIGTERM) 자기가 만든 임시 폴더의
// server.pid 또는 시험 전용 장부가 가리키고 작업 폴더도 자기가 만든 폴더 안인 보드를 끝낸다. 그 보드 파일을 인자로 연 다른 프로세스와, 남의 PID를
// 가리키는 pid 파일의 프로세스(작업 폴더가 밖)는 남긴다. 2026-11-17~20 야간 회귀가 시험을 SIGTERM으로 끊을 때마다 보드가 남았다.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { ROOT, posix } from '../test-support/install-rig.mjs'

const RIG = pathToFileURL(join(ROOT, 'test-support', 'install-rig.mjs')).href
// 띄운 프로세스는 스크립트를 다 읽고 'ready'를 찍는다 — 시험 프로세스 흉내는 그것을 받은 뒤에야 끝난다(먼저 끝나면 폴더가 지워져
// 스크립트를 못 읽고 스스로 죽으므로, 정리가 끝낸 것과 구별되지 않는다).
const IDLE = "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\n"
// 보드가 아닌 프로세스는 SIGTERM에 그냥 끝난다 — 흉내의 프로세스 그룹에 SIGTERM을 보내면 같이 끝난다.
const PLAIN = "console.log('ready'); setInterval(() => {}, 1000)\n"
const OUTSIDE = join(tmpdir(), `whosup-reap-outside-${process.pid}.mjs`)
const CHILD_FILE = join(tmpdir(), `whosup-reap-child-${process.pid}.mjs`)
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
console.log('pids ' + JSON.stringify(pids))
if (process.argv[2] === 'wait') setInterval(() => {}, 1000)
`

const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
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
