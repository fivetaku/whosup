// 설치기 굳히기(F16) — 보드 살아 있음 확인과 끄기.
//   Q3-F5  보드가 떴는지를 "그 포트가 200을 준다"가 아니라 건강 응답의 이름과 이 설치의 표식으로 본다(실행기 둘 · 단독 설치의 상태).
//   Q3-F3  stop은 pid 파일의 프로세스가 이 상태 폴더의 보드인지 확인한 뒤에 끈다.
// 실제 herdr·브라우저에는 닿지 않는다: 없는 herdr 경로, OPEN_BROWSER=0, 임시 상태 폴더, 48100~48799의 빈 포트.
// 설치기(install.sh)가 같은 값으로 판단하는지는 test/install.test.mjs("이미 플러그인으로 깔려 있으면 …")가 본다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'
import { BOARD_APP, boardReply, instanceOf } from '../src/paths.mjs'
import { boardAt, boardProcess, filedBoardPid, pidAlive } from '../scripts/launch.mjs'
import { boardNow } from '../src/standalone.mjs'
import { freePort } from '../test-support/install-rig.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const posix = { skip: process.platform === 'win32' ? '윈도우에는 sh가 없다' : false }
const NO_HERDR = join(tmpdir(), 'whosup-test-no-herdr', 'herdr')
const tmp = (name) => mkdtempSync(join(tmpdir(), `whosup-hb-${name}-`))
// 실행기 둘: 윈도우의 herdr가 부르는 scripts/launch.mjs, macOS·Linux의 herdr가 부르는 scripts/plugin.sh. 같은 판정이어야 한다.
const LAUNCHERS = process.platform === 'win32' ? ['launch'] : ['launch', 'plugin']
// 이 시험 프로세스의 서버(다른 서버 흉내)가 답할 수 있게 실행기는 기다리지 않고(spawn) 띄운다.
const run = (kind, cmd, env) => new Promise((resolve, reject) => {
  const [file, args] = kind === 'launch' ? [process.execPath, [join(ROOT, 'scripts', 'launch.mjs'), cmd]] : ['/bin/sh', [join(ROOT, 'scripts', 'plugin.sh'), cmd]]
  const child = spawn(file, args, { env, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout.on('data', (c) => { out += c }); child.stderr.on('data', (c) => { out += c })
  const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`timed out: ${kind} ${cmd}\n${out}`)) }, 60000)
  child.on('error', (e) => { clearTimeout(timer); reject(e) })
  child.on('exit', (code) => { clearTimeout(timer); resolve({ code, out }) })
})
const place = async (name) => {
  const base = tmp(name), state = join(base, 'state'), conf = join(base, 'conf'), port = await freePort()
  mkdirSync(state); mkdirSync(conf)
  const env = { ...process.env, HOME: base, HERDR_PLUGIN_STATE_DIR: state, HERDR_PLUGIN_CONFIG_DIR: conf, PORT: String(port), OPEN_BROWSER: '0', HERDR_BIN: NO_HERDR, HERDR_BIN_PATH: NO_HERDR, WHOSUP_INTERVAL: '60', WHOSUP_NO_EVENTS: '1' }
  delete env.WHOSUP_STATE_DIR; delete env.WHOSUP_DB
  return { base, state, conf, port, env, pidFile: join(state, 'server.pid'), filed: () => { try { return Number(readFileSync(join(state, 'server.pid'), 'utf8').trim()) } catch { return 0 } } }
}
// 그 포트에서 무엇을 물어도 200과 정한 본문을 주는 서버(후즈업이 아닌 다른 서비스).
const otherServer = async (port, body = () => '{}') => {
  const s = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(body()) })
  await new Promise((ok, no) => { s.once('error', no); s.listen(port, '127.0.0.1', ok) })
  return { close: () => new Promise((ok) => { s.closeAllConnections?.(); s.close(ok) }) }
}
// 오래 사는 프로세스 하나. script = 그 프로세스의 스크립트 파일 이름(명령 줄에 그 이름이 보인다).
const sleeper = (dir, script) => new Promise((ok, no) => {
  const file = join(dir, script)
  writeFileSync(file, "console.log('ready'); setInterval(() => {}, 1000)\n")
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'] })
  child.once('error', no); child.stdout.once('data', () => ok(child))
})
const gone = async (pid, ms = 8000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (!pidAlive(pid)) return true; await sleep(50) } return !pidAlive(pid) }
const kill = (pid) => { if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch {} } }

test('Q3-F5 건강 응답의 판정(boardReply): 이름과 이 상태 폴더의 표식이 맞을 때만 보드다 — 200만 주는 다른 서버·다른 상태 폴더의 보드는 아니다', () => {
  const a = tmp('reply-a'), b = tmp('reply-b')
  // 표식: 상태 폴더마다 다르고, 같은 폴더면 링크를 거친 경로로 불러도 같다(짧은 16진 글자 — 경로를 싣지 않는다)
  assert.match(instanceOf(a), /^[0-9a-f]{16}$/); assert.notEqual(instanceOf(a), instanceOf(b)); assert.equal(instanceOf(a), instanceOf(`${a}/`))
  const via = join(tmp('reply-link'), 'state'); symlinkSync(a, via); assert.equal(instanceOf(via), instanceOf(a))
  const good = { ok: true, app: BOARD_APP, instance: instanceOf(a), pid: 4242, readonly: false, herdr: [], targets: [] }
  assert.equal(BOARD_APP, 'whosup'); assert.equal(boardReply(good, a), 'board'); assert.equal(boardReply(good, via), 'board')
  assert.equal(boardReply(good, b), null, '다른 상태 폴더의 보드')
  assert.equal(boardReply({ ...good, app: 'other' }, a), null); assert.equal(boardReply({ ...good, instance: undefined }, a), null); assert.equal(boardReply({ ...good, ok: false }, a), null)
  for (const other of [{}, { ok: true }, null, [], 'ok', { status: 'ok' }, { ok: true, readonly: 'no', targets: [] }]) assert.equal(boardReply(other, a), null, JSON.stringify(other))
  // 이름·표식을 싣기 전 판의 보드가 보내던 모양: 'legacy' — 부른 쪽이 pid 파일로 한 번 더 확인한다
  assert.equal(boardReply({ ok: true, readonly: false, herdr: null, targets: [] }, a), 'legacy')
})

test('Q3-F5 실행기: 그 포트에서 다른 서버가 200을 줘도 "이미 떠 있다"로 보지 않는다 — 보드를 띄우고, 떠 있는 보드는 이름·표식·PID로 알아본다', posix, async () => {
  for (const kind of LAUNCHERS) {
    const p = await place(`up-${kind}`)
    let body = '{}'
    const other = await otherServer(p.port, () => body)
    try {
      // 다른 서버만 있다: 떠 있지 않다(전에는 "whosup listening at …"이라고 했다). 옛 모양으로 답해도 pid 파일이 없으면 보드가 아니다
      for (const b of ['{}', '<html>hello</html>', JSON.stringify({ ok: true, app: 'whosup', instance: instanceOf(join(p.base, 'elsewhere')), pid: process.pid }), JSON.stringify({ ok: true, readonly: false, herdr: [], targets: [] })]) {
        body = b
        const st = await run(kind, 'status', p.env)
        assert.equal(st.code, 1, `${kind} ${b}: ${st.out}`); assert.match(st.out, /whosup not running/, kind)
      }
      assert.deepEqual(await boardNow({ state: p.state }, { PORT: String(p.port) }), { up: false, port: null, url: null }, '단독 설치의 상태도 같다')
      assert.equal((await run(kind, 'open', p.env)).code, 1, kind)
      body = '{}'
      // start: "already listening"으로 끝내지 않고 보드를 띄운다(그 포트는 차 있으므로 보드는 다음 포트로 뜬다)
      const start = await run(kind, 'start', p.env)
      assert.equal(start.code, 0, `${kind}: ${start.out}`); assert.doesNotMatch(start.out, /already listening/, kind)
      assert.match(start.out, new RegExp(`whosup listening at http://127\\.0\\.0\\.1:${p.port + 1}\\b`), kind)
      const pid = p.filed()
      assert.ok(pidAlive(pid), kind); assert.equal(boardProcess(pid), 'yes', 'pid 파일은 보드 프로세스를 가리킨다')
      // 보드의 건강 응답: 이름 · 이 상태 폴더의 표식 · 자기 PID
      const health = await (await fetch(`http://127.0.0.1:${p.port + 1}/api/health`)).json()
      assert.equal(health.ok, true); assert.equal(health.app, 'whosup'); assert.equal(health.instance, instanceOf(p.state)); assert.equal(health.pid, pid)
      assert.deepEqual(Object.keys(health).slice(0, 4), ['ok', 'app', 'instance', 'pid'], 'plugin.sh가 글자로 견주는 순서')
      assert.deepEqual(await boardAt(`http://127.0.0.1:${p.port + 1}`, p.state), { url: `http://127.0.0.1:${p.port + 1}`, pid })
      assert.equal(await boardAt(`http://127.0.0.1:${p.port + 1}`, join(p.base, 'elsewhere')), null, '다른 상태 폴더가 물으면 그 보드가 아니다')
      assert.equal(await boardAt(`http://127.0.0.1:${p.port}`, p.state), null, '다른 서버')
      assert.deepEqual(await boardNow({ state: p.state }, { PORT: String(p.port) }), { up: true, port: String(p.port + 1), url: `http://127.0.0.1:${p.port + 1}` })
      const st = await run(kind, 'status', p.env)
      assert.equal(st.code, 0, st.out); assert.match(st.out, new RegExp(`whosup listening at http://127\\.0\\.0\\.1:${p.port + 1} \\(pid ${pid}\\)`), kind)
      const again = await run(kind, 'start', p.env)
      assert.equal(again.code, 0, again.out); assert.match(again.out, new RegExp(`whosup already listening at http://127\\.0\\.0\\.1:${p.port + 1}`), kind); assert.equal(p.filed(), pid)
      // 다른 상태 폴더의 실행기가 같은 포트를 본다(설정한 포트가 같은 두 설치): 남의 보드를 자기 보드로 보지 않는다
      const q = await place(`up-${kind}-other`)
      const foreign = await run(kind, 'status', { ...q.env, PORT: String(p.port + 1) })
      assert.equal(foreign.code, 1, foreign.out); assert.match(foreign.out, /whosup not running/)
      const stop = await run(kind, 'stop', p.env)
      assert.equal(stop.code, 0, stop.out); assert.match(stop.out, /whosup stopped/); assert.equal(await gone(pid), true); assert.equal(existsSync(p.pidFile), false)
    } finally { kill(p.filed()); await other.close() }
  }
})

test('Q3-F3 그 PID가 보드인가(boardProcess): 명령 줄에 보드의 진입점이 있으면 보드, 다른 프로그램이면 아니다, 읽지 못하면 모른다(그때는 pid 파일을 믿는다)', () => {
  const ps = (out, status = 0) => ({ run: (bin, args) => { assert.equal(bin, 'ps'); assert.deepEqual(args, ['-ww', '-o', 'command=', '-p', '4242']); return { status, stdout: out } } })
  assert.equal(boardProcess(4242, { platform: 'darwin', ...ps('/opt/n/bin/node /Users/x/.local/share/whosup/app/bin/whosup.mjs\n') }), 'yes')
  assert.equal(boardProcess(4242, { platform: 'darwin', ...ps('node bin/whosup.mjs\n') }), 'yes', 'plugin.sh가 띄운 모양')
  assert.equal(boardProcess(4242, { platform: 'darwin', ...ps('/usr/bin/vim notes.txt\n') }), 'no')
  assert.equal(boardProcess(4242, { platform: 'darwin', ...ps('/usr/bin/vim not-whosup.mjs.bak\n') }), 'no')
  assert.equal(boardProcess(4242, { platform: 'darwin', ...ps('', 1) }), 'unknown'); assert.equal(boardProcess(4242, { platform: 'darwin', run: () => { throw new Error('no ps') } }), 'unknown')
  // Linux: /proc/<pid>/cmdline(ps가 없는 기계에도 있다)이 먼저다
  const noPs = () => { throw new Error('ps must not be needed') }
  assert.equal(boardProcess(4242, { platform: 'linux', read: (f) => { assert.equal(f, '/proc/4242/cmdline'); return 'node\0/app/bin/whosup.mjs\0' }, run: noPs }), 'yes')
  assert.equal(boardProcess(4242, { platform: 'linux', read: () => 'sleep\x00100\x00', run: noPs }), 'no')
  assert.equal(boardProcess(4242, { platform: 'linux', read: () => { throw new Error('gone') }, ...ps('node /app/bin/whosup.mjs\n') }), 'yes')
  // 윈도우·틀린 PID: 모른다
  assert.equal(boardProcess(4242, { platform: 'win32', run: noPs }), 'unknown'); assert.equal(boardProcess(0, { run: noPs }), 'unknown'); assert.equal(boardProcess(1, { run: noPs }), 'unknown')
})

test('Q3-F3 stop: pid 파일이 남의 프로세스를 가리키면 끄지 않고 낡은 pid 파일만 치운다 — 보드로 확인된 프로세스만 끄고, pid 파일이 낡았어도 답하는 보드는 끈다', posix, async () => {
  for (const kind of LAUNCHERS) {
    const p = await place(`stop-${kind}`)
    let victim = null, lookalike = null
    try {
      // 재부팅·강제 종료 뒤 남은 pid 파일의 번호를 다른 프로그램이 받았다: 그 프로그램을 끄지 않는다(전에는 SIGTERM을 보냈다)
      victim = await sleeper(p.base, 'my-editor.mjs')
      writeFileSync(p.pidFile, String(victim.pid))
      assert.equal(boardProcess(victim.pid), 'no'); assert.equal(filedBoardPid(p.state), 0)
      const stop = await run(kind, 'stop', p.env)
      assert.equal(stop.code, 0, `${kind}: ${stop.out}`); assert.match(stop.out, /whosup not running/, kind); assert.doesNotMatch(stop.out, /stopped/, kind)
      await sleep(300)
      assert.equal(pidAlive(victim.pid), true, `${kind}: 남의 프로세스는 살아 있다`); assert.equal(existsSync(p.pidFile), false, '낡은 pid 파일은 치운다')
      // 그 번호가 살아 있어도 보드가 아니면 start를 막지 않는다(전에는 "running but not answering — run stop first"로 1)
      writeFileSync(p.pidFile, String(victim.pid))
      const start = await run(kind, 'start', p.env)
      assert.equal(start.code, 0, `${kind}: ${start.out}`); assert.match(start.out, new RegExp(`whosup listening at http://127\\.0\\.0\\.1:${p.port}\\b`))
      const board = p.filed()
      assert.notEqual(board, victim.pid); assert.equal(boardProcess(board), 'yes'); assert.equal(filedBoardPid(p.state), board)
      // pid 파일이 다시 남의 프로세스를 가리키게 됐다(보드는 돌고 있다): 답하는 보드를 그 답의 PID로 끈다 — 남의 프로세스는 그대로다
      writeFileSync(p.pidFile, String(victim.pid))
      const st = await run(kind, 'status', p.env)
      assert.equal(st.code, 0, st.out); assert.match(st.out, new RegExp(`\\(pid ${board}\\)`), '상태도 보드가 답한 PID를 말한다')
      const stop2 = await run(kind, 'stop', p.env)
      assert.equal(stop2.code, 0, stop2.out); assert.match(stop2.out, /whosup stopped/); assert.equal(await gone(board), true, `${kind}: 보드를 껐다`)
      assert.equal(pidAlive(victim.pid), true, `${kind}: 남의 프로세스는 살아 있다`); assert.equal(existsSync(p.pidFile), false)
      // pid 파일이 없어도 답하는 보드는 끈다(전에는 "not running"이라 하고 보드를 남겼다)
      assert.equal((await run(kind, 'start', p.env)).code, 0)
      const board2 = p.filed(); assert.ok(pidAlive(board2)); unlinkSync(p.pidFile)
      const stop3 = await run(kind, 'stop', p.env)
      assert.equal(stop3.code, 0, stop3.out); assert.match(stop3.out, /whosup stopped/); assert.equal(await gone(board2), true)
      // 답하지 않는 보드(명령 줄이 보드의 것): pid 파일의 PID로 끈다 — 기존 동작 그대로
      lookalike = await sleeper(mkdtempSync(join(p.base, 'app-')), 'whosup.mjs')
      writeFileSync(p.pidFile, String(lookalike.pid))
      assert.equal(boardProcess(lookalike.pid), 'yes'); assert.equal(filedBoardPid(p.state), lookalike.pid)
      const stop4 = await run(kind, 'stop', p.env)
      assert.equal(stop4.code, 0, stop4.out); assert.match(stop4.out, /whosup stopped/); assert.equal(await gone(lookalike.pid), true); assert.equal(existsSync(p.pidFile), false)
      // 죽은 PID · 숫자가 아닌 pid 파일: 꺼져 있다
      writeFileSync(p.pidFile, 'not-a-pid\n')
      const stop5 = await run(kind, 'stop', p.env)
      assert.equal(stop5.code, 0, stop5.out); assert.match(stop5.out, /whosup not running/)
      // 답을 흉내 낸 서버(이름·표식은 맞고 PID는 남의 것): 답에 실린 PID도 보드가 아니면 끄지 않는다
      const liar = await otherServer(p.port, () => JSON.stringify({ ok: true, app: 'whosup', instance: instanceOf(p.state), pid: victim.pid, readonly: false, herdr: [], targets: [] }))
      try {
        const stop6 = await run(kind, 'stop', p.env)
        assert.equal(stop6.code, 0, stop6.out); assert.match(stop6.out, /whosup not running/, kind)
        await sleep(300); assert.equal(pidAlive(victim.pid), true, `${kind}: 답이 댄 남의 프로세스는 살아 있다`)
      } finally { await liar.close() }
    } finally { kill(p.filed()); kill(victim?.pid); kill(lookalike?.pid) }
  }
})
