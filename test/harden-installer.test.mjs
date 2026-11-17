// 설치기 굳히기(F16) — 설치기(install.sh)와 단독 설치 명령(whosup …)이 "보통은 일어나지 않는 상태"에서 남의 것을 건드리지 않는가.
//   Q2-F2        서비스 관리자에 물을 수 없음과 없음을 가른다
//   Q2-F1        잠금의 pid 파일을 링크를 따라 쓰지 않는다 · 설치기의 PID라고 받은 값은 우리를 띄운 조상일 때만 받는다
//   Q2-F3·Q3-F6  끝내지 못한 설치를 치울 때 그 설치가 쓰던 상태 폴더의 보드를 찾아 끈다 · 끌 스크립트가 없는 폴더는 끄지 못한 채 지우지 않는다
//   Q2-F4        확인과 사용 사이의 틈(가능한 범위): 지우기는 그 폴더 안에서 다시 확인하고, 옮긴 뒤 옮긴 것을 다시 확인한다
//   Q3-F2·M6     설치 기록의 설정·상태 경로는 후즈업 자신의 폴더일 때만 쓴다 · 앱 자리가 남의 폴더면 --purge도 기록된 폴더를 지우지 않는다
//   Q3-F4        설치 원본의 스크립트가 링크면 돌리지 않는다
//   Q3-F7        후즈업 것이 아닌 install.json은 덮지 않는다
//   M2·M4·M5     치우지 못한 빈 설정·상태 폴더를 알린다
// 보드 살아 있음 확인(Q3-F5)과 stop(Q3-F3)은 test/harden-board.test.mjs.
// 실기기 걷기(에어 r2)·독립 검토가 짚은 것(B):
//   B1  이번 실행이 환경(앱·herdr)을 깐 뒤 뒤 단계가 실패하면 깔린 것이 남아 있다고 말한다("바꾼 것은 없다"가 아니다)
//   B2  성공한 설치의 화면에 영어 내부 줄(whosup setup: · listening at · start at login:)이 없다 — <상태 폴더>/install.log에 남고, 실패하면 보여 준다
//   B3  WHOSUP_ENV로 받은 앱이 이미 놓여 있으면 다시 깔지 않고 붙는다(env_here)
//   B4  내려받기는 https만(--proto · --proto-redir), 시험의 127.0.0.1 http 서버만 예외
//   B5  리눅스에서 앱을 열 때 설치기의 환경(WHOSUP_* · 덧붙인 PATH)을 물려주지 않는다
//   B6  uninstall은 함께 깐 앱이 두는 폴더도 "그대로 남겨 두었다"로 알린다
// 격리 환경은 test-support/install-rig.mjs(임시 HOME · 가짜 launchctl·systemctl · 빈 포트) — 실제 herdr·서비스 관리자·네트워크에 닿지 않는다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { PIN_KEYS } from '../src/paths.mjs'
import { TEXT } from '../src/setup.mjs'
import {
  APP_MARK, APP_MARK_FILE, HARDEN_TEXT, LOCK_NAME, appEnv, envLeftovers, foreignRecord, layout, noteState, notedState, openApp, ownPlaces, pickedEnv, pinEnv, readRecord, removeInstall,
  startedBy, stopService, unregisterAutostart, writeRecord,
} from '../src/standalone.mjs'
import { main as cli } from '../scripts/standalone.mjs'
import { INSTALL, ROOT, SH, exe, mac, posix, rig as bareRig, shq, walk } from '../test-support/install-rig.mjs'

const notRoot = process.getuid?.() !== 0
const tmp = (name) => mkdtempSync(join(tmpdir(), `whosup-hi-${name}-`))
const touch = (file, text = '') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
const isoEnv = (home, over = {}) => ({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), PATH: '/usr/bin:/bin', WHOSUP_LANG: 'en', ...over })
const own = (dir) => touch(join(dir, APP_MARK_FILE), `${APP_MARK}\n`)
const rmSyncQuiet = (p) => { try { rmSync(p, { recursive: true, force: true }) } catch {} }
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
// 임시 HOME에 남은 후즈업의 것(데이터·설정·상태·실행 명령·로그인 항목). 설치기가 만든 빈 윗폴더(~/.local/share)는 세지 않는다.
const leftOf = (r) => walk(r.home).filter((p) => /whosup/i.test(p))
const until = async (fn, ms = 10000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(50) } return false }
// 아무것도 없는 기계의 환경 고르기로 새지 않게(진짜 앱 설치기를 부르지 않는다) — 이 파일의 설치는 모두 단독 설치 길을 강제한다.
const rig = async (o) => {
  const r = await bareRig(o), env = r.env
  r.env = (over = {}) => env({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), ...over })
  return r
}
// 이 저장소의 사본(설치 원본 흉내). edit(폴더)로 고친다.
const copyOf = (r, name, edit = () => {}) => {
  const src = join(r.base, name)
  cpSync(ROOT, src, { recursive: true, filter: (p) => !['.git', 'node_modules', '.whosup'].includes(basename(p)) })
  edit(src)
  return src
}
const patchCli = (src, from, to) => { const f = join(src, 'scripts', 'standalone.mjs'); const text = readFileSync(f, 'utf8'); assert.ok(text.includes(from), from); writeFileSync(f, text.replace(from, to)) }
const real = (name) => ['/bin', '/usr/bin'].map((d) => join(d, name)).find((f) => existsSync(f))
const sleeper = () => new Promise((ok, no) => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] })
  child.once('error', no); child.stdout.once('data', () => ok(child))
})

// ── Q2-F2 ──
test('Q2-F2 서비스 관리자의 답: "없다"와 "물을 수 없었다"를 가른다 — 물을 수 없었으면 꺼졌다고만 말하지 않고 그 사실과 확인할 명령을 돌려준다', () => {
  const home = tmp('ctl'); const env = isoEnv(home); const L = layout(env, home)
  // run = 서비스 관리자 대역: 물음(print · is-enabled · is-active)에 정한 답을 준다. 그 밖의 호출은 성공.
  const ctl = (answer) => { const calls = []; return { calls, run: (bin, args) => { calls.push(args.join(' ')); return ['print', 'is-enabled', 'is-active'].some((q) => args.includes(q)) ? answer : { ok: true, out: '', code: 0, ran: true } } } }
  const cases = {
    none113: [{ ok: false, out: 'Bad request.\nCould not find service "dev.whosup.board" in domain for user gui: 501\n', code: 113, ran: true }, false],
    noneText: [{ ok: false, out: 'Could not find service', code: 1, ran: true }, false],
    cantAsk: [{ ok: false, out: 'Could not find domain for user gui: 501\n', code: 112, ran: true }, true],
    failed5: [{ ok: false, out: 'Input/output error', code: 5, ran: true }, true],
    notRun: [{ ok: false, out: '', code: null, ran: false }, true],
    // 종료 코드를 주지 않는 대역(다른 시험의 가짜 run): 예전처럼 "없다"로 본다
    legacyFake: [{ ok: false, out: '' }, false],
  }
  for (const [name, [answer, unsure]] of Object.entries(cases)) {
    touch(L.plist, '<plist/>')
    const r = unregisterAutostart({ env, home, platform: 'darwin', run: ctl(answer).run, uid: 501, waitMs: 0 })
    assert.equal(r.state, 'off', name); assert.equal(existsSync(L.plist), false, `${name}: 로그인 항목 파일은 어느 쪽이든 지운다(다음 로그인에는 켜지지 않는다)`)
    assert.deepEqual(r.unsure, unsure ? { name: 'dev.whosup.board', check: 'launchctl print gui/501/dev.whosup.board' } : undefined, name)
  }
  // Linux: 사용자 관리자에 닿지 못했다는 말(버스 없음) · systemctl을 실행하지 못함 = 물을 수 없었다. 그냥 0이 아닌 값 = 아니다
  const bus = { ok: false, out: 'Failed to connect to bus: No medium found\n', code: 1, ran: true }
  const sys = { no: [{ ok: false, out: 'disabled\n', code: 1, ran: true }, false], inactive: [{ ok: false, out: '', code: 3, ran: true }, false], bus: [bus, true], notRun: [{ ok: false, out: '', code: null, ran: false }, true] }
  for (const [name, [answer, unsure]] of Object.entries(sys)) {
    touch(L.unit, '[Unit]\n')
    const off = unregisterAutostart({ env, home, platform: 'linux', run: ctl(answer).run, waitMs: 0 })
    assert.equal(off.state, 'off', name); assert.equal(existsSync(L.unit), false, name)
    assert.deepEqual(off.unsure, unsure ? { name: 'whosup.service', check: 'systemctl --user is-enabled whosup.service' } : undefined, name)
    // 서비스 멈추기: 물을 수 없었으면 멈췄다고 단정하지 않는다 — 우리 unit 파일이 놓여 있을 때만 알린다(없으면 등록한 적이 없다)
    const bare = stopService({ env, home, platform: 'linux', run: ctl(answer).run })
    assert.deepEqual(bare, { asked: false, ok: true }, `${name}: unit 파일이 없으면 알릴 것이 없다`)
    touch(L.unit, '[Unit]\n')
    const st = stopService({ env, home, platform: 'linux', run: ctl(answer).run })
    assert.deepEqual(st, unsure ? { asked: false, ok: true, unsure: { name: 'whosup.service', check: 'systemctl --user is-active whosup.service' } } : { asked: false, ok: true }, name)
    unlinkSync(L.unit)
  }
  // 멈추라고 한 뒤에 물을 수 없게 됐다: 멈췄다고도, 안 멈췄다고도 하지 않는다
  let n = 0
  touch(L.unit, '[Unit]\n')
  const flip = stopService({ env, home, platform: 'linux', run: (bin, args) => (args.includes('is-active') ? (n++ === 0 ? { ok: true, out: '', code: 0, ran: true } : bus) : { ok: true, out: '', code: 0, ran: true }) })
  assert.deepEqual(flip, { asked: true, ok: true, unsure: { name: 'whosup.service', check: 'systemctl --user is-active whosup.service' } })
  for (const lang of ['en', 'ko']) { assert.match(HARDEN_TEXT[lang].unsure('이름표'), /이름표/); assert.match(HARDEN_TEXT[lang].unsure('x'), /:$/) }
  assert.match(HARDEN_TEXT.ko.unsure('x'), /서비스 관리자에 물을 수 없어/); assert.match(HARDEN_TEXT.en.unsure('x'), /Could not ask the service manager/)
})

test('Q2-F2 명령 줄: launchctl·systemctl이 오류를 내면 autostart off · stop · uninstall이 "확인하지 못했다"와 손으로 확인할 명령을 알린다 — 없다는 답이면 예전 그대로다', posix, async () => {
  const home = tmp('ctl-cli'); const L = layout(isoEnv(home), home)
  const script = (name, text) => { const f = join(home, name); writeFileSync(f, text); chmodSync(f, 0o755); return f }
  // 대역: 없다고 답하는 것(113 · is-…는 3) / 오류를 내는 것(물을 수 없다) / 버스에 닿지 못하는 systemctl
  const noneCtl = script('ctl-none', '#!/bin/sh\ncase " $* " in *" print "*) exit 113 ;; *" is-active "* | *" is-enabled "*) exit 3 ;; esac\nexit 0\n')
  const brokenCtl = script('ctl-broken', '#!/bin/sh\necho "Could not find domain for user gui" >&2\nexit 112\n')
  const busCtl = script('ctl-bus', '#!/bin/sh\necho "Failed to connect to bus: No medium found" >&2\nexit 1\n')
  const run = async (argv, platform, over = {}) => { const out = []; return { code: await cli(argv, isoEnv(home, { WHOSUP_LAUNCHCTL: noneCtl, WHOSUP_SYSTEMCTL: noneCtl, ...over }), { log: (l) => out.push(l), platform, home }), out } }
  const uid = process.getuid?.() ?? 0
  const installed = () => { touch(join(L.app, 'x'), '1'); own(L.app); writeRecord(L, { id: 'fivetaku.whosup' }); touch(L.plist, '<plist/>') }
  // macOS · autostart off
  installed()
  const off = await run(['autostart', 'off'], 'darwin', { WHOSUP_LAUNCHCTL: brokenCtl })
  assert.equal(off.code, 0); assert.deepEqual(off.out, ['Start at login: off', `  ${HARDEN_TEXT.en.unsure('dev.whosup.board')}`, `      launchctl print gui/${uid}/dev.whosup.board`]); assert.equal(existsSync(L.plist), false)
  touch(L.plist, '<plist/>')
  assert.deepEqual((await run(['autostart', 'off'], 'darwin', { WHOSUP_LAUNCHCTL: join(home, 'no-such-launchctl') })).out.slice(1), [`  ${HARDEN_TEXT.en.unsure('dev.whosup.board')}`, `      launchctl print gui/${uid}/dev.whosup.board`], '실행하지 못한 것도 물을 수 없었던 것이다')
  touch(L.plist, '<plist/>')
  assert.deepEqual((await run(['autostart', 'off'], 'darwin')).out, ['Start at login: off'], '없다는 답이면 한 줄뿐이다(성공 길에 줄을 더하지 않는다)')
  // macOS · uninstall: 지운 뒤 끝에 한 번 알린다. 한국어도 같다
  touch(L.plist, '<plist/>')
  const un = await run(['uninstall'], 'darwin', { WHOSUP_LAUNCHCTL: brokenCtl, WHOSUP_LANG: 'ko' })
  assert.equal(un.code, 0, un.out.join('\n')); assert.deepEqual(un.out, [TEXT.ko.saUninstalled, `  ${TEXT.ko.saRemoved(L.app)}`, `  ${HARDEN_TEXT.ko.unsure('dev.whosup.board')}`, `      launchctl print gui/${uid}/dev.whosup.board`])
  installed(); unlinkSync(L.plist)
  assert.deepEqual((await run(['uninstall'], 'darwin', { WHOSUP_LAUNCHCTL: brokenCtl })).out, ['whosup is uninstalled.', `  Removed: ${L.app}`], '로그인 항목이 없으면 서비스 관리자에 묻지 않는다')
  // Linux · stop: unit 파일이 놓여 있는데 사용자 관리자에 닿지 못한다 → 멈췄는지 확인하지 못했다고 알린다(종료 코드는 그대로 0)
  touch(L.unit, '[Unit]\n')
  const stop = await run(['stop'], 'linux', { WHOSUP_SYSTEMCTL: busCtl })
  assert.equal(stop.code, 0); assert.deepEqual(stop.out, ['whosup not running', HARDEN_TEXT.en.unsure('whosup.service'), '    systemctl --user is-active whosup.service'])
  assert.deepEqual((await run(['stop'], 'linux')).out, ['whosup not running'], 'active가 아니라는 답이면 한 줄뿐이다')
  assert.deepEqual((await run(['stop', '--service'], 'linux', { WHOSUP_SYSTEMCTL: busCtl })).out, ['whosup not running'], 'ExecStop이 부른 stop은 서비스를 보지 않는다')
  // Linux · autostart off: 링크와 unit을 직접 지우고, 확인하지 못했다고 알린다
  const offL = await run(['autostart', 'off'], 'linux', { WHOSUP_SYSTEMCTL: busCtl })
  assert.equal(offL.code, 0); assert.deepEqual(offL.out, ['Start at login: off', `  ${HARDEN_TEXT.en.unsure('whosup.service')}`, '      systemctl --user is-enabled whosup.service']); assert.equal(existsSync(L.unit), false)
  // 사용자 관리자가 없는 기계(등록한 적이 없다 — unit 파일 없음): 아무 말도 더하지 않는다
  assert.deepEqual((await run(['stop'], 'linux', { WHOSUP_SYSTEMCTL: busCtl })).out, ['whosup not running'])
})

// ── Q2-F1 ──
test('Q2-F1 잠금의 pid 파일: 잠금 폴더에 링크가 놓여 있으면 그 링크를 따라 쓰지 않는다 — 가리키는 파일은 그대로이고 설치는 알린 뒤 1로 끝난다', posix, async () => {
  const r = await rig()
  // 틈을 만든다: 설치기가 잠금 폴더를 만드는 순간 그 안에 pid라는 링크를 놓는 mkdir(같은 사용자의 다른 프로세스가 끼어든 것과 같다)
  exe(join(r.bin, 'mkdir'), `#!/bin/sh\n${real('mkdir')} "$@" || exit $?\ncase "$#:$1" in 1:*/${LOCK_NAME}) [ -z "\${LOCK_VICTIM:-}" ] || ln -s "$LOCK_VICTIM" "$1/pid" ;; esac\nexit 0\n`)
  const victim = join(r.base, 'victim.txt'); writeFileSync(victim, 'precious\n')
  for (const [target, lang, want] of [[victim, 'en', /^whosup: could not write the lock .*install\.lock\. Nothing was changed\.\n$/], [join(r.base, 'not-there-yet'), 'ko', /^whosup: 잠금\(.*install\.lock\)을 쓰지 못했습니다\. 바꾼 것은 없습니다\.\n$/]]) {
    const a = await r.install({ LOCK_VICTIM: target, WHOSUP_LANG: lang })
    assert.equal(a.code, 1, a.all); assert.match(a.err, want)
    assert.equal(readFileSync(victim, 'utf8'), 'precious\n', '링크가 가리키는 파일에 PID를 쓰지 않았다'); assert.equal(existsSync(join(r.base, 'not-there-yet')), false, '링크가 가리키는 자리에 파일을 만들지 않았다')
    assert.deepEqual(leftOf(r), [], '잠금도 데이터 폴더도 남기지 않는다')
  }
  // 링크가 없으면 평소대로 잡고, 끝나면 푼다
  const ok = await r.install({ WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
  assert.equal(ok.code, 0, ok.all); assert.equal(existsSync(join(r.data, LOCK_NAME)), false); assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true)
})

test('Q2-F1 WHOSUP_INSTALLER_PID: 잠금 주인의 PID를 환경변수로 대도, 그 프로세스가 우리를 띄운 조상이 아니면 그 잠금 아래에서 돌지 않는다', posix, async () => {
  // 조상 판정(startedBy): 자기 자신 · 부모 · 그 위(설치기 → sh → node)만 받는다
  const chain = { 500: 400, 400: 300, 300: 1 }
  const up = (p) => chain[p] ?? 0
  for (const [claimed, want] of [[600, true], [500, true], [400, true], [300, true], [777, false], [1, false], [0, false], [NaN, false], [-5, false]]) assert.equal(startedBy(claimed, { pid: 600, parent: 500, up }), want, String(claimed))
  assert.equal(startedBy(process.pid), true); assert.equal(startedBy(process.ppid), true)
  const other = await sleeper()
  try {
    assert.equal(startedBy(other.pid), false, '옆에서 도는 다른 프로세스는 조상이 아니다(실제 ps·/proc로 본다)')
    // 다른 설치가 잠금을 쥐고 있다(주인 = other). 그 PID를 WHOSUP_INSTALLER_PID로 대고 로그인 항목을 끄거나 지우려 한다: 잠겨 있다고 알리고 1
    const home = tmp('pid'); const L = layout(isoEnv(home), home)
    const noneCtl = join(home, 'ctl-none'); writeFileSync(noneCtl, '#!/bin/sh\ncase " $* " in *" print "*) exit 113 ;; *" is-active "* | *" is-enabled "*) exit 3 ;; esac\nexit 0\n'); chmodSync(noneCtl, 0o755)
    touch(join(L.app, 'x'), '1'); own(L.app); writeRecord(L, { id: 'fivetaku.whosup' }); touch(L.plist, '<plist/>')
    const lock = join(L.data, LOCK_NAME); mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${other.pid}\n`)
    const run = async (argv, over = {}) => { const out = []; return { code: await cli(argv, isoEnv(home, { WHOSUP_LAUNCHCTL: noneCtl, WHOSUP_SYSTEMCTL: noneCtl, ...over }), { log: (l) => out.push(l), platform: 'darwin', home }), out } }
    for (const argv of [['autostart', 'off'], ['uninstall', '--purge']]) {
      const r = await run(argv, { WHOSUP_INSTALLER_PID: String(other.pid) })
      assert.equal(r.code, 1, argv.join(' ')); assert.deepEqual(r.out, [TEXT.en.saLocked(lock)], argv.join(' '))
    }
    assert.equal(existsSync(L.plist), true); assert.equal(existsSync(join(L.app, 'x')), true); assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), `${other.pid}\n`, '남의 잠금은 그대로다')
    // 잠금 주인이 정말 우리를 띄운 쪽이면(여기서는 이 시험 프로세스 자신) 그 아래에서 돈다 — 설치기가 끝내지 못한 설치를 치울 때의 길
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`)
    const under = await run(['autostart', 'off'], { WHOSUP_INSTALLER_PID: String(process.pid) })
    assert.equal(under.code, 0); assert.deepEqual(under.out, ['Start at login: off']); assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), `${process.pid}\n`)
  } finally { other.kill('SIGKILL') }
})

// ── Q2-F3 · Q3-F6 ──
test('Q2-F3 끝내지 못한 설치를 치울 때: 그 설치가 다른 XDG_STATE_HOME으로 돌았어도 표식에 적힌 상태 폴더로 보드를 찾아 끈 뒤에 치운다 — 적힌 값을 믿을 수 없으면 치우지 않고 알린다', posix, async () => {
  const r = await rig()
  const xs = join(r.base, 'xs'), there = join(xs, 'whosup')
  let pid = 0
  try {
    // 그때만 다른 상태 폴더로 설치했다: 표식의 둘째 줄에 그 폴더가 적힌다
    const a = await r.install({ XDG_STATE_HOME: xs })
    assert.equal(a.code, 0, a.all); pid = r.pid(there); assert.ok(pid > 1 && alive(pid))
    assert.equal(readFileSync(join(r.app, APP_MARK_FILE), 'utf8'), `${APP_MARK}\nstate=${there}\n`); assert.equal(notedState(r.app), there)
    // 설치 기록이 없어졌다 = 끝내지 못한 설치가 남긴 폴더(표식만 있다). 이번에는 평소의 환경으로 설치기를 돌린다
    unlinkSync(r.record); writeFileSync(join(r.app, 'half'), 'x')
    assert.equal(existsSync(r.state), false, '지금 환경의 상태 폴더에는 아무것도 없다(여기서만 찾으면 보드를 못 찾는다)')
    const b = await r.install()
    assert.equal(b.code, 0, b.all); assert.match(b.out, /an install that did not finish left .* behind: removing it and installing again\n/)
    assert.equal(await until(() => !alive(pid), 5000), true, '다른 상태 폴더에서 돌던 보드를 끈 뒤에 치웠다(돌고 있는 보드의 프로그램을 지우지 않는다)')
    assert.equal(existsSync(join(there, 'server.pid')), false); assert.equal(existsSync(join(r.app, 'half')), false)
    assert.equal(await r.health(), true, '새 설치의 보드는 지금 환경의 상태 폴더에서 켜졌다'); assert.equal(notedState(r.app), r.state)
    // 표식에 적힌 상태 폴더를 믿을 수 없다(절대 경로가 아니다): 보드를 찾을 수 없으므로 폴더를 치우지 않고 알린 뒤 1
    assert.equal((await r.whosup(['stop'])).code, 0)
    unlinkSync(r.record); writeFileSync(join(r.app, APP_MARK_FILE), `${APP_MARK}\nstate=relative/whosup\n`)
    for (const [lang, want] of [['en', /whosup: the mark in .*\/app names a state folder that cannot be used, so the board started from it could not be looked for\n[\s\S]*whosup: could not clear .*\/app safely/], ['ko', /whosup: .*\/app 폴더의 표식에 적힌 상태 폴더를 쓸 수 없어, 그 폴더에서 켜진 보드를 찾지 못했습니다\n[\s\S]*폴더를 그대로 두었습니다/]]) {
      const c = await r.install({ WHOSUP_LANG: lang })
      assert.equal(c.code, 1, c.all); assert.match(c.err, want); assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true, '폴더는 그대로다'); assert.equal(existsSync(`${r.app}.new`), false)
    }
    // 둘째 줄이 없는 표식(이 줄을 적기 전 판이 남긴 폴더): 예전처럼 지금 환경의 상태 폴더만 보고 치운다
    writeFileSync(join(r.app, APP_MARK_FILE), `${APP_MARK}\n`)
    const d = await r.install({ WHOSUP_NO_AUTOSTART: '1' })
    assert.equal(d.code, 0, d.all); assert.equal(notedState(r.app), r.state)
  } finally { r.cleanup(); if (pid > 1) { try { process.kill(pid, 'SIGKILL') } catch {} } }
})

test('Q2-F3 표식의 둘째 줄과 stop-at: 상태 폴더는 절대 경로일 때만 적고 읽는다 — stop-at은 제품 이름으로 끝나는 절대 경로만 받고, 없는 폴더를 만들지 않는다', async () => {
  const home = tmp('note'); const L = layout(isoEnv(home), home)
  assert.equal(noteState(L.app, L.state), false, '표식이 없는 폴더에는 적지 않는다'); assert.equal(notedState(L.app), '')
  touch(join(L.app, 'x'), '1'); own(L.app)
  assert.equal(notedState(L.app), ''); assert.equal(noteState(L.app, 'relative/whosup'), false); assert.equal(noteState(L.app, '/x\ny/whosup'), false)
  assert.equal(noteState(L.app, L.state), true); assert.equal(readFileSync(join(L.app, APP_MARK_FILE), 'utf8'), `${APP_MARK}\nstate=${L.state}\n`); assert.equal(notedState(L.app), L.state)
  assert.deepEqual(readdirSync(L.app).sort(), [APP_MARK_FILE, 'x'], '임시 파일을 남기지 않는다')
  writeFileSync(join(L.app, APP_MARK_FILE), `${APP_MARK}\nstate=relative\n`); assert.equal(notedState(L.app), '')
  // install.sh의 mark_state가 같은 줄을 읽는다(없으면 빈 값, 믿을 수 없으면 ?)
  const sh = readFileSync(INSTALL, 'utf8')
  assert.match(sh, /^mark_state\(\) \{$/m); assert.match(sh, /sh "\$new\/scripts\/standalone\.sh" stop-at "\$left_state"/)
  if (process.platform !== 'win32') {
    const out = []
    const run = async (argv) => { out.length = 0; return cli(argv, isoEnv(home), { log: (l) => out.push(l), platform: 'linux', home }) }
    for (const bad of [[], ['relative/whosup'], [join(home, 'Documents')], ['/x\ny/whosup']]) { assert.equal(await run(['stop-at', ...bad]), 2, JSON.stringify(bad)); assert.deepEqual(out, [HARDEN_TEXT.en.stopAtUsage]) }
    const nowhere = join(home, 'nowhere', 'whosup')
    assert.equal(await run(['stop-at', nowhere]), 0); assert.deepEqual(out, ['whosup not running']); assert.equal(existsSync(nowhere), false, '없는 상태 폴더를 만들지 않는다')
  }
})

test('Q3-F6 끝내지 못한 새 설치의 폴더에 끌 스크립트가 없으면: 끄지 못한 채 지우지 않는다 — 폴더를 두고 알린 뒤 1, 다시 돌린 설치기가 새로 받은 판으로 끄고 치운다', posix, async () => {
  const r = await rig()
  try {
    // 마지막 단계가 자기 폴더의 scripts/standalone.sh를 잃고 실패한다(반쯤 지워진 폴더 흉내)
    const broken = copyOf(r, 'broken', (src) => patchCli(src, "case 'install': return install(ctx)", "case 'install': { (await import('node:fs')).unlinkSync(join(ROOT, 'scripts', 'standalone.sh')); return 1 }"))
    for (const [lang, want] of [['en', /whosup: .*\/app has no script of its own to stop its board with, so the folder was not removed unchecked\n[\s\S]*so .*\/app is still there\./], ['ko', /whosup: .*\/app 폴더에 보드를 끌 스크립트가 없어, 확인하지 못한 채 폴더를 지우지 않았습니다\n[\s\S]*\/app 폴더가 남아 있습니다/]]) {
      const a = await r.install({ WHOSUP_INSTALL_SOURCE: broken, WHOSUP_LANG: lang })
      assert.equal(a.code, 1, a.all); assert.match(a.err, want)
      assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true, '폴더는 그대로다(전에는 끄지 않고 지웠다)'); assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), false)
      assert.equal(existsSync(`${r.app}.new`), false); assert.equal(existsSync(join(r.data, LOCK_NAME)), false)
      if (lang === 'en') { unlinkSync(join(r.app, APP_MARK_FILE)); renameSync(r.app, join(r.base, 'first-try')) }   // 둘째 판(한국어)을 새 설치로 한 번 더 본다
    }
    // 다시 돌린 설치기: 남은 폴더를 새로 받은 판의 명령으로 끄고 치운 뒤 설치한다
    const b = await r.install({ WHOSUP_NO_AUTOSTART: '1' })
    assert.equal(b.code, 0, b.all); assert.match(b.out, /an install that did not finish left .* behind/); assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true)
  } finally { r.cleanup() }
})

// ── Q2-F4 ──
test('Q2-F4 지우기의 틈: 확인한 직후 그 자리의 폴더가 바뀌어도 남의 폴더를 지우지 않는다 — 그 폴더 안에서 다시 확인하고, 빈 폴더만 걷는다', posix, () => {
  const sh = readFileSync(INSTALL, 'utf8')
  const fn = (name) => { const m = new RegExp(`^${name}\\(\\) \\{\\n[\\s\\S]*?^\\}$`, 'm').exec(sh); assert.ok(m, name); return m[0] }
  const script = `MARK_FILE=${shq(APP_MARK_FILE)}\nMARK_TEXT=${shq(APP_MARK)}\n${fn('ours')}\n${fn('wipe')}\nwipe "$1"\n`
  const run = (dir, env = {}) => spawnSync(SH, ['-c', script, 'wipe-test', dir], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', ...env } })
  const base = tmp('wipe'), data = join(base, 'whosup')
  const make = (name) => { const d = join(data, name); touch(join(d, 'bin', 'whosup.mjs'), 'x'); touch(join(d, '.hidden'), 'x'); touch(join(d, '..odd'), 'x'); touch(join(d, '.dir', 'f'), 'x'); own(d); return d }
  // 평소: 설치기의 표식이 든 app · app.new · app.old는 숨은 파일까지 통째로 지운다
  for (const name of ['app', 'app.new', 'app.old']) { const d = make(name); const r = run(d); assert.equal(r.status, 0, r.stderr); assert.equal(existsSync(d), false, name) }
  // 표식이 없는 폴더 · 이름이 다른 폴더 · 링크는 건드리지 않는다
  const foreign = join(data, 'app'); touch(join(foreign, 'mine.txt'), 'mine'); run(foreign); assert.equal(readFileSync(join(foreign, 'mine.txt'), 'utf8'), 'mine')
  const named = join(base, 'other', 'app'); touch(join(named, 'f'), 'x'); own(named); run(named); assert.equal(existsSync(join(named, 'f')), true, '…/whosup/app 꼴이 아니다')
  const target = make('app.old'); renameSync(target, join(base, 'real-old')); symlinkSync(join(base, 'real-old'), target); run(target); assert.equal(existsSync(join(base, 'real-old', 'bin', 'whosup.mjs')), true, '링크는 따라가지 않는다')
  unlinkSync(target)
  // 틈: 표식을 확인한 직후(확인이 읽는 sed가 끝난 바로 뒤) 그 자리가 남의 폴더로 바뀐다. 전에는 확인한 경로를 다시 열어 지웠다(남의 폴더가 지워졌다)
  const bin = join(base, 'bin'); mkdirSync(bin)
  exe(join(bin, 'sed'), `#!/bin/sh\n${real('sed')} "$@"; rc=$?\nif [ ! -e "$SWAP_DONE" ]; then : > "$SWAP_DONE"; ${real('mv')} "$SWAP_DIR" "$SWAP_DIR.checked" && ${real('mv')} "$SWAP_VICTIM" "$SWAP_DIR"; fi\nexit $rc\n`)
  const checked = make('app.old'); const victim = join(base, 'victim'); touch(join(victim, 'precious.txt'), 'precious'); touch(join(victim, 'sub', 'more.txt'), 'more')
  const r = run(checked, { PATH: `${bin}:/usr/bin:/bin`, SWAP_DONE: join(base, 'swapped'), SWAP_DIR: checked, SWAP_VICTIM: victim })
  assert.equal(r.status, 0, r.stderr); assert.equal(existsSync(join(base, 'swapped')), true, '바꿔치기가 일어났다')
  assert.equal(readFileSync(join(checked, 'precious.txt'), 'utf8'), 'precious', '그 자리에 놓인 남의 폴더는 그대로다'); assert.equal(readFileSync(join(checked, 'sub', 'more.txt'), 'utf8'), 'more')
})

test('Q2-F4 옮기기의 틈: 새 버전으로 바꾸려고 옮긴 폴더가 확인했던 설치가 아니면 제자리에 돌려놓고 그만둔다 — 치우지 못한 app.old 안으로 옮겨 넣지도 않는다', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install({ WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(a.code, 0, a.all)
    // 틈을 만든다: 설치기가 app을 app.old로 옮기려는 순간(확인은 끝났다) 그 자리를 남의 폴더로 바꾸는 mv
    exe(join(r.bin, 'mv'), `#!/bin/sh\nif [ "$#" = 2 ] && [ "$2" = "$1.old" ] && [ -n "\${SWAP_FOREIGN:-}" ] && [ ! -e "$SWAP_FOREIGN.done" ]; then\n  : > "$SWAP_FOREIGN.done"; ${real('mv')} "$1" "$SWAP_FOREIGN.checked" && ${real('mv')} "$SWAP_FOREIGN" "$1"\nfi\nexec ${real('mv')} "$@"\n`)
    for (const [lang, want] of [['en', /whosup: .*\/app changed while it was being replaced: the folder there now is not the whosup install that was checked\. It was put back as it was, nothing in it was run or removed, and the new version was not installed\./], ['ko', /whosup: .*\/app 폴더가 바꾸는 도중에 달라졌습니다\..*제자리에 그대로 돌려놓았고, 그 안의 것은 실행하지도 지우지도 않았으며 새 버전은 설치하지 않았습니다\./]]) {
      const foreign = join(r.base, `foreign-${lang}`); touch(join(foreign, 'mine.txt'), 'mine'); touch(join(foreign, 'scripts', 'standalone.sh'), `#!/bin/sh\necho ran > ${shq(join(r.base, 'foreign-ran'))}\n`)
      const b = await r.install({ SWAP_FOREIGN: foreign, WHOSUP_LANG: lang })
      assert.equal(existsSync(`${foreign}.done`), true, '바꿔치기가 일어났다')
      assert.equal(b.code, 1, b.all); assert.match(b.err, want); assert.doesNotMatch(b.out, /install summary|설치 요약/)
      assert.equal(readFileSync(join(r.app, 'mine.txt'), 'utf8'), 'mine', '남의 폴더는 제자리에 그대로다(전에는 app.old로 밀려나고 그 자리에 새 버전이 놓였다)')
      assert.equal(existsSync(join(r.base, 'foreign-ran')), false, '그 안의 스크립트를 돌리지 않았다')
      assert.equal(existsSync(`${r.app}.old`), false); assert.equal(existsSync(`${r.app}.new`), false); assert.equal(existsSync(join(r.data, LOCK_NAME)), false)
      // 다음 판을 위해 되돌린다: 남의 폴더를 치우고 확인했던 설치를 제자리에
      renameSync(r.app, join(r.base, `foreign-${lang}-back`)); renameSync(`${foreign}.checked`, r.app)
    }
    // 평소의 update는 그대로 된다(같은 mv를 거친다)
    const c = await r.install({ WHOSUP_NO_AUTOSTART: '1' })
    assert.equal(c.code, 0, c.all); assert.match(c.out, /replacing it with the new version/); assert.equal(existsSync(`${r.app}.old`), false)
    // 치우지 못한 app.old(설치기의 것인데 지워지지 않는 것이 들어 있다): 그 안으로 app을 옮겨 넣지 않는다 — 알리고 1, 설치는 그대로다
    if (notRoot) {
      const old = `${r.app}.old`; touch(join(old, 'locked', 'f'), 'x'); own(old); chmodSync(join(old, 'locked'), 0o500)
      try {
        const d = await r.install()
        assert.equal(d.code, 1, d.all); assert.match(d.err, /whosup: could not clear .*\/app\.old, so it was left as it is\. Move it away and run this installer again\. Nothing was changed\.\n$/)
        assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true, '설치는 제자리에 그대로다'); assert.equal(existsSync(join(old, 'app')), false, 'app.old 안으로 옮겨 넣지 않았다'); assert.equal(existsSync(join(old, 'locked', 'f')), true)
        assert.equal(existsSync(`${r.app}.new`), false); assert.equal(existsSync(join(r.data, LOCK_NAME)), false)
        assert.match((await r.install({ WHOSUP_LANG: 'ko' })).err, /app\.old 폴더를 치우지 못해 그대로 두었습니다/)
      } finally { chmodSync(join(old, 'locked'), 0o700) }
    }
  } finally { r.cleanup() }
})

// ── Q3-F2 · M6 ──
test('Q3-F2 설치 기록의 설정·상태 경로: 후즈업 자신의 폴더일 때만 쓴다 — 다른 폴더를 가리키게 고친 기록은 고정하지도, --purge로 지우지도 않는다', () => {
  const home = tmp('own'); const env = isoEnv(home); const L = layout(env, home)
  const rec = (over = {}) => ({ product: 'whosup', data: L.data, app: L.app, conf: L.conf, state: L.state, ...over })
  // 제 폴더: 설정 = 그 사용자의 ~/.config/whosup · 상태 = 그 자리이거나, 이름이 whosup이고 아직 없거나 보드의 파일이 든 폴더
  assert.deepEqual(ownPlaces(rec(), home), { conf: L.conf, state: L.state }, '아직 없는 폴더')
  touch(join(L.state, 'whosup.db'), 'db'); touch(join(L.state, 'anything-else'), 'x'); assert.equal(ownPlaces(rec(), home).state, L.state, 'whosup.db가 있다')
  const fresh = join(home, 'xs', 'whosup'); for (const f of ['server.log', 'auto.json', 'port']) touch(join(fresh, f), 'x')
  assert.equal(ownPlaces(rec({ state: fresh }), home).state, fresh, '보드·실행기가 두는 파일뿐이다'); assert.equal(ownPlaces(rec({ state: L.conf }), home).state, L.conf, '예전부터 설정 폴더를 같이 쓰던 사람')
  // 아닌 것: 다른 자리의 설정 폴더 · 남의 파일이 든 whosup 폴더(저장소 사본 등) · 이름이 다른 폴더 · 데이터 폴더와 그 안 · 파일 · 상대 경로
  const checkout = join(home, 'code', 'whosup'); touch(join(checkout, 'README.md'), '#'); touch(join(checkout, 'src', 'x.mjs'), '')
  const docs = join(home, 'Documents'); touch(join(docs, 'thesis.txt'), 'words')
  touch(join(home, 'afile', 'whosup'), 'x')
  for (const [why, over] of [['다른 자리의 설정 폴더', { conf: join(home, 'elsewhere', 'whosup') }], ['문서 폴더', { conf: docs }]]) assert.equal(ownPlaces(rec(over), home).conf, '', why)
  for (const [why, state] of [['저장소 사본', checkout], ['문서 폴더', docs], ['데이터 폴더', L.data], ['앱 폴더', L.app], ['데이터 폴더 안', join(L.data, 'x', 'whosup')], ['파일', join(home, 'afile', 'whosup')], ['상대 경로', 'rel/whosup'], ['없음', undefined]]) {
    assert.equal(ownPlaces(rec({ state }), home).state, '', why)
  }
  // pinEnv: 제 폴더만 고정한다. 아닌 값은 걷어 내고 지금 환경으로 계산한 폴더를 쓴다(물려받은 고정 값도 걷어 낸다)
  const inherited = { ...env, [PIN_KEYS.conf]: '/inherited/whosup', [PIN_KEYS.state]: '/inherited/whosup' }
  const good = pinEnv(inherited, rec({ state: fresh }), home)
  assert.deepEqual([good[PIN_KEYS.data], good[PIN_KEYS.conf], good[PIN_KEYS.state]], [L.data, L.conf, fresh])
  const bad = pinEnv(inherited, rec({ conf: docs, state: checkout }), home)
  assert.deepEqual([bad[PIN_KEYS.data], bad[PIN_KEYS.conf], bad[PIN_KEYS.state]], [L.data, undefined, undefined])
  const LB = layout(bad, home); assert.deepEqual([LB.conf, LB.state], [L.conf, L.state], '지금 환경으로 계산한 폴더')
  // M6: 앱 자리에 남의 폴더가 있다(표식 없음 — 건드리지 않는다). --purge여도 기록된 설정·상태 폴더를 지우지 않는다
  const h2 = tmp('m6'); const e2 = isoEnv(h2); const M = layout(e2, h2)
  touch(join(M.app, 'not-whosup.txt'), 'mine'); writeRecord(M, { id: 'fivetaku.whosup' }); touch(join(M.conf, 'setup.json'), '{}'); touch(join(M.state, 'whosup.db'), 'db')
  const m6 = removeInstall({ env: e2, home: h2, platform: 'darwin', purge: true })
  assert.deepEqual(m6.foreign, [M.app]); assert.deepEqual(m6.removed, []); assert.deepEqual(m6.kept, [M.conf, M.state])
  assert.equal(readFileSync(join(M.state, 'whosup.db'), 'utf8'), 'db'); assert.equal(readFileSync(join(M.conf, 'setup.json'), 'utf8'), '{}'); assert.equal(readFileSync(join(M.app, 'not-whosup.txt'), 'utf8'), 'mine')
  // 제 프로그램이 지워졌으면 --purge는 기록된 제 폴더를 지운다(평소의 길 그대로)
  const h3 = tmp('m6-own'); const e3 = isoEnv(h3); const N = layout(e3, h3)
  touch(join(N.app, 'x'), '1'); own(N.app); writeRecord(N, { id: 'fivetaku.whosup' }); touch(join(N.conf, 'setup.json'), '{}'); touch(join(N.state, 'whosup.db'), 'db')
  assert.deepEqual(removeInstall({ env: e3, home: h3, platform: 'darwin', purge: true }).kept, []); assert.equal(existsSync(N.state), false); assert.equal(existsSync(N.conf), false)
  // 기록된 상태 폴더가 지금 계산한 폴더와 같아도, 후즈업의 상태 폴더로 보이지 않으면(남의 파일뿐이다) --purge가 지우지 않는다
  const h4 = tmp('m6-odd'); const e4 = isoEnv(h4); const O = layout(e4, h4)
  touch(join(O.app, 'x'), '1'); own(O.app); writeRecord(O, { id: 'fivetaku.whosup' }); touch(join(O.conf, 'setup.json'), '{}'); touch(join(O.state, 'thesis.txt'), 'words')
  const odd = removeInstall({ env: e4, home: h4, platform: 'darwin', purge: true })
  assert.deepEqual(odd.kept, [O.state]); assert.equal(readFileSync(join(O.state, 'thesis.txt'), 'utf8'), 'words'); assert.equal(existsSync(O.conf), false, '제 설정 폴더는 지운다')
})

test('Q3-F2 고친 설치 기록으로 whosup uninstall --purge: 기록이 가리키는 남의 폴더는 그대로이고, 보드는 제 상태 폴더에서 찾아 끈다', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install()
    assert.equal(a.code, 0, a.all); const pid = r.pid(); assert.ok(pid > 1 && alive(pid))
    // 누군가 설치 기록의 설정·상태 경로를 다른 폴더로 고쳤다(이름에 whosup이 든 폴더 — 전에는 그것만으로 지웠다)
    const notes = join(r.base, 'notes', 'whosup'), work = join(r.base, 'work', 'whosup')
    touch(join(notes, 'diary.txt'), 'dear diary'); touch(join(work, 'src', 'main.c'), 'int main;'); touch(join(work, 'README'), 'mine')
    const rec = JSON.parse(readFileSync(r.record, 'utf8'))
    writeFileSync(r.record, JSON.stringify({ ...rec, conf: notes, state: work }))
    assert.notEqual(readRecord(r.data), null, '기록 자체는 여전히 이 설치를 가리킨다')
    const st = await r.whosup(['status'])
    assert.equal(st.code, 0, st.all); assert.match(st.out, new RegExp(`whosup listening at .* \\(pid ${pid}\\)`), '고친 경로가 아니라 제 상태 폴더의 보드를 본다')
    const un = await r.whosup(['uninstall', '--purge'])
    assert.equal(un.code, 0, un.all)
    assert.equal(readFileSync(join(notes, 'diary.txt'), 'utf8'), 'dear diary'); assert.equal(readFileSync(join(work, 'src', 'main.c'), 'utf8'), 'int main;'); assert.equal(readFileSync(join(work, 'README'), 'utf8'), 'mine')
    assert.equal(await until(() => !alive(pid), 5000), true, '보드를 끈 뒤에 프로그램을 지웠다'); assert.equal(existsSync(r.app), false); assert.equal(existsSync(r.launcher), false)
    // 기록에 적히지 않은 제 상태 폴더는 --purge여도 남기고 그 사실을 알린다(기록된 폴더만 지운다는 규칙 그대로)
    assert.equal(existsSync(join(r.state, 'whosup.db')), true); assert.match(un.out, /Kept \(your settings and history\): .*\.state\/whosup\n/)
  } finally { r.cleanup() }
})

// ── Q3-F4 ──
test('Q3-F4 설치 원본의 스크립트가 링크면 돌리지 않는다: scripts/standalone.sh(또는 scripts 폴더)가 원본 밖을 가리켜도 그 스크립트는 실행되지 않고 아무것도 바뀌지 않는다', posix, async () => {
  const r = await rig()
  try {
    const ran = join(r.base, 'outside-ran')
    const outside = exe(join(r.base, 'outside.sh'), `#!/bin/sh\necho ran >> ${shq(ran)}\nexit 0\n`)
    const fileLink = copyOf(r, 'src-file-link', (src) => { unlinkSync(join(src, 'scripts', 'standalone.sh')); symlinkSync(outside, join(src, 'scripts', 'standalone.sh')) })
    const dirLink = copyOf(r, 'src-dir-link', (src) => {
      const away = join(r.base, 'scripts-away'); renameSync(join(src, 'scripts'), away); writeFileSync(join(away, 'standalone.sh'), readFileSync(outside)); symlinkSync(away, join(src, 'scripts'))
    })
    for (const [src, lang, want] of [[fileLink, 'en', /^whosup: that copy of whosup was not installed: scripts\/standalone\.sh in it is a link, not a file of its own, and a link is not run\. Nothing was changed\.\n$/],
      [dirLink, 'ko', /^whosup: 받은 whosup을 설치하지 않았습니다\. 그 안의 파일\(scripts\/standalone\.sh\)이 제 파일이 아니라 링크여서 실행하지 않습니다\. 바꾼 것은 없습니다\.\n$/]]) {
      const a = await r.install({ WHOSUP_INSTALL_SOURCE: src, WHOSUP_LANG: lang })
      assert.equal(a.code, 1, a.all); assert.match(a.err, want)
      assert.equal(existsSync(ran), false, '원본 밖의 스크립트를 돌리지 않았다'); assert.deepEqual(leftOf(r), [], '아무것도 놓지 않았다')
    }
    // 깔린 뒤 앱 폴더의 스크립트가 링크로 바뀌었다: 그것은 더 이상 "단독 설치가 있다"가 아니다(그 스크립트를 돌려 새 버전으로 바꾸지 않는다)
    const ok = await r.install({ WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(ok.code, 0, ok.all); assert.notEqual(readRecord(r.data), null)
    unlinkSync(join(r.app, 'scripts', 'standalone.sh')); symlinkSync(outside, join(r.app, 'scripts', 'standalone.sh'))
    assert.equal(lstatSync(join(r.app, 'scripts', 'standalone.sh')).isSymbolicLink(), true); assert.equal(readRecord(r.data), null)
    const again = await r.install({ WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(again.code, 0, again.all); assert.equal(existsSync(ran), false, '링크가 가리키는 스크립트를 돌리지 않았다')
    assert.doesNotMatch(again.out, /replacing it with the new version/); assert.match(again.out, /an install that did not finish left .* behind/)
    assert.equal(lstatSync(join(r.app, 'scripts', 'standalone.sh')).isFile(), true); assert.notEqual(readRecord(r.data), null)
  } finally { r.cleanup() }
})

// ── Q3-F7 ──
test('Q3-F7 데이터 폴더에 후즈업 것이 아닌 install.json이 있으면: 덮지 않고 알린 뒤 1로 끝난다 — 그 파일은 그대로이고 놓았던 것은 치운다', posix, async () => {
  assert.equal(foreignRecord(tmp('fr-none')), false, '없으면 남의 것도 아니다')
  const r = await rig()
  try {
    mkdirSync(r.data, { recursive: true })
    const theirs = '{"name":"another tool","version":3}\n'
    for (const [lang, want] of [['en', /whosup: .*\/whosup\/install\.json is there and is not a whosup install record, so it was left as it is and whosup was not installed\. Move it away, then run the installer again\.\n/],
      ['ko', /whosup: .*\/whosup\/install\.json 파일이 이미 있는데 whosup의 설치 기록이 아니어서 그대로 두었고, whosup은 설치하지 않았습니다\. 그 파일을 다른 곳으로 옮긴 뒤 설치 명령을 다시 실행하세요\.\n/]]) {
      writeFileSync(r.record, theirs); assert.equal(foreignRecord(r.data), true)
      const a = await r.install({ WHOSUP_LANG: lang })
      assert.equal(a.code, 1, a.all); assert.match(a.all, want); assert.doesNotMatch(a.out, /install summary|설치 요약/)
      assert.equal(readFileSync(r.record, 'utf8'), theirs, '남의 파일을 덮지 않았다'); assert.deepEqual(readdirSync(r.data), ['install.json'], '놓았던 앱 폴더와 잠금은 치웠다')
      assert.equal(existsSync(r.launcher), false); assert.equal(existsSync(r.loginFile), false); assert.equal(await r.health(), false, '보드를 켜지 않았다')
    }
    // 링크(다른 파일을 가리킨다) · JSON이 아닌 파일 · 배열: 모두 남의 것이다
    unlinkSync(r.record); const elsewhere = join(r.base, 'elsewhere.json'); writeFileSync(elsewhere, theirs); symlinkSync(elsewhere, r.record)
    const link = await r.install()
    assert.equal(link.code, 1, link.all); assert.equal(lstatSync(r.record).isSymbolicLink(), true); assert.equal(readFileSync(elsewhere, 'utf8'), theirs, '링크를 따라 쓰지 않았다')
    unlinkSync(r.record)
    for (const text of ['not json at all', '[]', '{"product":"other"}', '']) { writeFileSync(r.record, text); assert.equal(foreignRecord(r.data), true, JSON.stringify(text)) }
    // 이 제품의 기록인데 깨진 것(경로 모양이 틀렸다)은 남의 것이 아니다: 새로 쓰고 설치를 끝낸다
    writeFileSync(r.record, '{"product":"whosup","app":"relative"}'); assert.equal(foreignRecord(r.data), false)
    const own2 = await r.install({ WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(own2.code, 0, own2.all); assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).app, r.app)
  } finally { r.cleanup() }
})

// ── M2 · M4 · M5 ──
test('M2·M4·M5 빈 설정·상태 폴더를 치우지 못했으면: 조용히 넘어가지 않고 남은 폴더를 한 줄로 알린다(1) — 치울 수 있으면 말없이 치운다', { skip: posix.skip || (notRoot ? false : 'root는 읽기 전용 폴더에서도 지운다') }, async () => {
  const home = tmp('empty'); const env = isoEnv(home); const L = layout(env, home)
  const noneCtl = join(home, 'ctl-none'); writeFileSync(noneCtl, '#!/bin/sh\ncase " $* " in *" print "*) exit 113 ;; *" is-active "* | *" is-enabled "*) exit 3 ;; esac\nexit 0\n'); chmodSync(noneCtl, 0o755)
  const run = async (argv, lang = 'en') => { const out = []; return { code: await cli(argv, { ...env, WHOSUP_LAUNCHCTL: noneCtl, WHOSUP_SYSTEMCTL: noneCtl, WHOSUP_LANG: lang }, { log: (l) => out.push(l), platform: mac ? 'darwin' : 'linux', home }), out } }
  const installed = () => { touch(join(L.app, 'x'), '1'); own(L.app); writeRecord(L, { id: 'fivetaku.whosup' }); mkdirSync(L.conf, { recursive: true }); mkdirSync(L.state, { recursive: true }) }
  // 평소: 빈 설정·상태 폴더는 말없이 치운다
  installed()
  const clean = removeInstall({ env, home, platform: 'darwin' })
  assert.deepEqual(clean.left, []); assert.equal(existsSync(L.conf), false); assert.equal(existsSync(L.state), false)
  // 빈 설정 폴더가 지워지지 않는다(그 위 폴더에 쓸 수 없다): 남은 것으로 돌려준다 — 전에는 아무 말 없이 남았다
  installed()
  chmodSync(join(L.conf, '..'), 0o500)
  try {
    const stuck = removeInstall({ env, home, platform: 'darwin' })
    assert.deepEqual(stuck.left, [L.conf]); assert.deepEqual(stuck.kept, []); assert.equal(existsSync(L.conf), true)
    assert.equal(existsSync(L.record), false, '빈 폴더 하나 때문에 설치 기록을 붙잡아 두지는 않는다(프로그램은 다 지워졌다)'); assert.equal(existsSync(L.app), false)
    // 명령 줄: 다 지우지 못했다고 말하고 그 폴더를 알린다
    installed()
    for (const [lang, T] of [['en', TEXT.en], ['ko', TEXT.ko]]) {
      const un = await run(['uninstall'], lang)
      assert.equal(un.code, 1, un.out.join('\n')); assert.equal(un.out[0], T.saUninstallPartly); assert.ok(un.out.includes(`  ${T.saLeft(L.conf)}`), un.out.join('\n'))
      installed()
    }
  } finally { chmodSync(join(L.conf, '..'), 0o700) }
  // 치울 수 있게 된 뒤: 평소대로 말없이 치우고 0
  const done = await run(['uninstall'])
  assert.equal(done.code, 0, done.out.join('\n')); assert.deepEqual(done.out, ['whosup is uninstalled.', `  Removed: ${L.app}`]); assert.equal(existsSync(L.conf), false); assert.equal(existsSync(L.state), false); assert.equal(existsSync(L.data), false)
})

// ── B. 실기기 걷기(에어 r2)·독립 검토 ──
// 맥의 칩 판별(sysctl)을 애플 실리콘으로 둔다 — Herdr 앱을 깔 수 있는 기계로 본다(리눅스에서는 불리지 않는다)
const silicon = (r) => { if (mac) exe(join(r.bin, 'sysctl'), '#!/bin/sh\necho 1\n') }
// 환경 고르기가 도는 격리 환경: 길을 강제하지 않는다(위의 rig는 WHOSUP_INSTALL_MODE=standalone을 강제해 WHOSUP_ENV가 쓰이지 않는다).
// 두 앱의 설치 명령은 실패하는 대역, 이 기계의 /Applications는 보지 않고, 리눅스에서는 화면이 있는 것으로 둔다
const envRig = async (o) => {
  const r = await bareRig(o), env = r.env
  r.env = (over = {}) => env({ WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), DISPLAY: ':0', ...over })
  silicon(r)
  return r
}
const cpu = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : ''
// 두 앱의 설치 명령 대역: 진짜 설치기가 놓는 자리에 앱(과 Herdr 앱의 코어·명령)을 놓는다
const fakeHerdrApp = (r) => `sh ${shq(exe(join(r.base, 'get-herdr-app.sh'), '#!/bin/sh\nmkdir -p "$HOME/.local/bin" || exit 1\nprintf \'#!/bin/sh\\nexit 0\\n\' > "$HOME/.local/bin/herdr-app" && chmod 755 "$HOME/.local/bin/herdr-app" && cp "$HOME/.local/bin/herdr-app" "$HOME/.local/bin/herdr-core" || exit 1\nif [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/Herdr.app/Contents/MacOS" || exit 1; fi\n'))}`
const fakeOvisApp = (r) => `sh ${shq(exe(join(r.base, 'get-ovis-app.sh'), '#!/bin/sh\nif [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/Ovis.app/Contents/MacOS" || exit 1\nelse d="${XDG_DATA_HOME:-$HOME/.local/share}/ovis-desktop"; mkdir -p "$d" && printf \'#!/bin/sh\\nexit 0\\n\' > "$d/Ovis.AppImage" && chmod 755 "$d/Ovis.AppImage" || exit 1; fi\n'))}`
const herdrAppOf = (r) => (mac ? join(r.home, 'Applications', 'Herdr.app') : join(r.home, '.local', 'bin', 'herdr-app'))
const ovisAppOf = (r) => (mac ? join(r.home, 'Applications', 'Ovis.app') : join(r.home, '.local', 'share', 'ovis-desktop', 'Ovis.AppImage'))

test('B1 이번 실행이 환경을 깐 뒤 뒤 단계가 실패하면: 깔린 것이 남아 있고 그대로 써도 지워도 된다고 알린다 — 앱(단독 설치 길)과 herdr(플러그인 길) 모두, 영어·한국어', posix, async () => {
  const r = await envRig()
  // 단독 설치의 마지막 단계가 죽는 판
  const crashing = copyOf(r, 'crashing', (src) => patchCli(src, "case 'install': return install(ctx)", "case 'install': throw new Error('boom in the last step')"))
  for (const [pick, cmdVar, cmd, at, lang] of [['ovis-app', 'WHOSUP_OVIS_APP_INSTALL_CMD', fakeOvisApp(r), ovisAppOf(r), 'en'], ['herdr-app', 'WHOSUP_HERDR_APP_INSTALL_CMD', fakeHerdrApp(r), herdrAppOf(r), 'ko']]) {
    const f = await envRig()
    const a = await f.install({ WHOSUP_ENV: pick, [cmdVar]: cmd, WHOSUP_INSTALL_SOURCE: crashing, WHOSUP_LANG: lang })
    const here = at.replace(r.home, f.home)
    assert.equal(a.code, 1, a.all); assert.equal(existsSync(here), true, '깐 앱은 그대로다'); assert.equal(existsSync(f.data), false, 'whosup은 치웠다')
    const want = lang === 'ko'
      ? `whosup: 이번 실행이 설치한 ${pick === 'ovis-app' ? 'Ovis 앱' : 'Herdr 앱'}은 그대로 남아 있습니다(${here}). 그대로 써도 되고, 직접 지워도 됩니다.\n`
      : `whosup: ${pick === 'ovis-app' ? 'the Ovis app' : 'the Herdr app'} that this run installed is still in place (${here}). You can use it as it is, or remove it yourself.\n`
    assert.ok(a.err.endsWith(want), a.err); assert.match(a.err, lang === 'ko' ? /설치를 끝내지 못했습니다/ : /the install did not finish/)
    assert.doesNotMatch(a.err, /Nothing was changed|바꾼 것은 없습니다/, '"바꾼 것은 없다"고 하지 않는다')
  }
  // herdr를 깔고 플러그인 설치가 실패한다(에어 (라) 걷기): herdr가 남아 있다고 알린다
  const h = await envRig()
  const b = await h.install({ WHOSUP_ENV: 'herdr', WHOSUP_HERDR_INSTALL_CMD: h.getHerdr, FAKE_HERDR_INSTALL_FAIL: '1' })
  assert.equal(b.code, 1, b.all); assert.match(b.err, /whosup: herdr could not install the plugin/)
  assert.ok(b.err.endsWith(`whosup: herdr 0.9.5 that this run installed is still in place (${join(h.home, '.local', 'bin')}). You can use it as it is, or remove it yourself.\n`), b.err)
  assert.equal(existsSync(join(h.home, '.local', 'bin', 'herdr')), true)
  // 이번 실행이 아무것도 깔지 않은 실패에는 그 줄이 없다
  const n = await rig()
  const c = await n.install({ WHOSUP_INSTALL_SOURCE: crashing })
  assert.equal(c.code, 1, c.all); assert.doesNotMatch(c.err, /still in place|그대로 남아 있습니다/)
})

test('B1 앱을 깐 뒤 whosup 쪽이 실패하면(다른 설치가 잡은 잠금 · 남의 app.new 폴더): "바꾼 것은 없다"가 아니라 "whosup은 설치하지 않았다"고 말한 뒤 깔린 앱이 남아 있다고 알린다 — 영어·한국어', posix, async () => {
  for (const [lang, block] of [['en', 'lock'], ['ko', 'lock'], ['en', 'dir'], ['ko', 'dir']]) {
    const f = await envRig()
    if (block === 'lock') { const lock = join(f.data, 'install.lock'); mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'pid'), `${process.pid}\n`) }
    else touch(join(f.data, 'app.new', 'stranger.txt'), 'not ours\n')
    const a = await f.install({ WHOSUP_ENV: 'ovis-app', WHOSUP_OVIS_APP_INSTALL_CMD: fakeOvisApp(f), WHOSUP_LANG: lang })
    const here = ovisAppOf(f)
    assert.equal(a.code, 1, a.all); assert.equal(existsSync(here), true, '깐 앱은 그대로다')
    assert.doesNotMatch(a.err, /Nothing was changed|바꾼 것은 없습니다/, `"바꾼 것은 없다"고 하지 않는다: ${a.err}`)
    const head = block === 'lock'
      ? (lang === 'ko' ? /whosup: Ovis 앱을 설치했습니다: .*\nwhosup: 다른 whosup 설치가 진행 중입니다\(잠금 .*install\.lock\)\. 그 설치가 끝난 뒤 다시 실행하세요\. whosup은 설치하지 않았습니다\.\n/ : /whosup: the Ovis app is installed: .*\nwhosup: another whosup install is running here \(the lock .*install\.lock is held\)\. Wait for it to end, then run this again\. whosup was not installed\.\n/)
      : (lang === 'ko' ? /whosup: .*app\.new 폴더가 이미 있는데 이 설치기가 만든 것이 아니어서 그대로 두었습니다\. 다른 곳으로 옮긴 뒤 이 설치 명령을 다시 실행하세요\. whosup은 설치하지 않았습니다\.\n/ : /whosup: .*app\.new is there and this installer did not put it there, so it was left as it is\. Move it away and run this installer again\. whosup was not installed\.\n/)
    assert.match(a.all, head)
    const tail = lang === 'ko'
      ? `whosup: 이번 실행이 설치한 Ovis 앱은 그대로 남아 있습니다(${here}). 그대로 써도 되고, 직접 지워도 됩니다.\n`
      : `whosup: the Ovis app that this run installed is still in place (${here}). You can use it as it is, or remove it yourself.\n`
    assert.ok(a.err.endsWith(tail), a.err)
    if (block === 'dir') assert.equal(readFileSync(join(f.data, 'app.new', 'stranger.txt'), 'utf8'), 'not ours\n', '남의 폴더는 그대로다')
  }
  // 아무것도 깔지 않은 같은 실패는 전처럼 "바꾼 것은 없다"
  const n = await rig()
  const lock = join(n.data, 'install.lock'); mkdirSync(lock, { recursive: true }); writeFileSync(join(lock, 'pid'), `${process.pid}\n`)
  const c = await n.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
  assert.equal(c.code, 1, c.all); assert.match(c.err, /Nothing was changed\.\n$/); assert.doesNotMatch(c.err, /still in place/)
})

test('B2 성공한 설치의 화면에는 영어 내부 줄이 없다(whosup setup: · listening at · start at login:) — 그 줄은 <상태 폴더>/install.log에 남고, 보드가 켜지지 못한 설치는 화면에도 보여 준다', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install()
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
    assert.doesNotMatch(a.all, /whosup setup: |whosup listening at |start at login: /, a.all)
    const log = readFileSync(join(r.state, 'install.log'), 'utf8')
    assert.match(log, /^\d{4}-\d\d-\d\dT\S+ whosup setup: no terminal — nothing asked/m); assert.match(log, /^\S+ whosup listening at http:\/\/127\.0\.0\.1:\d+$/m); assert.match(log, /^\S+ whosup: start at login: on \(/m)
    assert.match(a.out, /install summary/)
  } finally { r.cleanup() }
  // 보드가 켜지지 않는 판: 진단 줄을 화면에도 보여 준다(무엇이 안 됐는지가 그 안에 있다). 설치 자체는 끝난다(요약이 알린다)
  const f = await rig()
  const noBoard = copyOf(f, 'no-board'); writeFileSync(join(noBoard, 'bin', 'whosup.mjs'), 'process.exit(3)\n')
  const b = await f.install({ WHOSUP_INSTALL_SOURCE: noBoard })
  assert.equal(b.code, 0, b.all); assert.match(b.out, /whosup setup: no terminal — nothing asked\n/); assert.match(b.out, /whosup failed to start/)
  assert.match(readFileSync(join(f.state, 'install.log'), 'utf8'), /whosup failed to start/); assert.match(b.out, /install summary/)
  // 한국어 설치도 같다(그 줄은 영어 내부 줄이라 화면에 없다)
  const k = await rig()
  try {
    const c = await k.install({ WHOSUP_LANG: 'ko' })
    assert.equal(c.code, 0, c.all); assert.doesNotMatch(c.all, /whosup setup: |whosup listening at |start at login: /); assert.match(c.out, /설치 요약/)
  } finally { k.cleanup() }
})

test('B3 WHOSUP_ENV로 받은 앱이 이미 놓여 있으면(~/Applications · /Applications · 리눅스의 자리) 다시 깔지 않고 그 앱에 붙는다 — 전에는 설치 명령을 다시 돌렸다', posix, async () => {
  for (const [where, lang] of [['user', 'en'], ['system', 'ko']]) {
    const r = await envRig()
    const sys = join(r.base, 'sysapps'); mkdirSync(sys)
    let at
    if (mac) { at = join(where === 'user' ? join(r.home, 'Applications') : sys, 'Ovis.app'); mkdirSync(at, { recursive: true }) }
    else { at = join(r.home, '.local', 'share', 'ovis-desktop', `Ovis-linux-${cpu}.AppImage`); mkdirSync(join(at, '..'), { recursive: true }); exe(at, '#!/bin/sh\nexit 0\n') }
    const a = await r.install({ WHOSUP_ENV: 'ovis-app', WHOSUP_SYSTEM_APPS: sys, WHOSUP_LANG: lang, WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(a.code, 0, a.all)
    assert.ok(a.out.includes(lang === 'ko'
      ? `whosup: Ovis 앱이 이미 이 컴퓨터에 있고(${at}) 아직 켠 적이 없습니다: 다른 것은 깔지 않고 whosup만 설치합니다\n`
      : `whosup: the Ovis app is already on this computer (${at}) and has not been opened yet: whosup is installed next to it, nothing else is installed\n`), a.out)
    assert.doesNotMatch(a.all, /installing the Ovis app|Ovis 앱을 설치합니다|is already there|its installer ended/)
    assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).env_installed, '', '함께 깐 것이 아니다'); assert.equal(existsSync(at), true)
    assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true, '단독 설치로 붙었다')
  }
  // Herdr 앱(코어까지 놓여 있다)
  const h = await envRig()
  const hat = herdrAppOf(h); mkdirSync(join(h.home, '.local', 'bin'), { recursive: true })
  if (mac) mkdirSync(hat, { recursive: true }); else exe(hat, '#!/bin/sh\nexit 0\n')
  exe(join(h.home, '.local', 'bin', 'herdr-core'), '#!/bin/sh\nexit 0\n')
  const b = await h.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
  assert.equal(b.code, 0, b.all)
  assert.ok(b.out.includes(`whosup: the Herdr app is already on this computer (${hat}) and has not been opened yet: whosup is installed next to it, nothing else is installed\n`), b.out)
  assert.doesNotMatch(b.all, /installing the Herdr app/); assert.equal(JSON.parse(readFileSync(h.record, 'utf8')).env_installed, '')
})

test('B4 내려받기(fetch_to · ovis_tag)는 https만 받는다(--proto · --proto-redir): http로 돌려보내는 곳은 따르지 않는다 — 시험이 주는 127.0.0.1의 http 서버만 예외', posix, async () => {
  const sh = readFileSync(INSTALL, 'utf8')
  assert.match(sh, /^fetch_to\(\) \{ curl_proto "\$2"; curl -fsSL --proto "\$CURL_PROTO" --proto-redir "\$CURL_PROTO" /m)
  assert.match(sh, /^  tag="\$\(curl -fsSI --proto "\$CURL_PROTO" --proto-redir "\$CURL_PROTO" /m)
  // curl 대역이 받은 인자를 적는다(아무것도 받지 못한다: 22)
  const curlLog = (r) => { const f = join(r.base, 'curl.log'); exe(join(r.bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(f)}\nexit 22\n`); return () => readFileSync(f, 'utf8').trim().split('\n') }
  for (const [url, proto] of [['https://releases.invalid', '=https'], ['http://127.0.0.1:1', '=http,https']]) {
    const r = await envRig(); const calls = curlLog(r)
    const a = await r.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', HERDR_RELEASES_URL: url })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /its installer could not be downloaded/)
    assert.deepEqual(calls().length, 1); assert.match(calls()[0], new RegExp(`^-fsSL --proto ${proto} --proto-redir ${proto} --connect-timeout 30 --max-time \\d+ -o \\S.* ${url.replace(/[.]/g, '\\.')}/app/install\\.sh$`), calls()[0])
    // Ovis: 판을 정하는 HEAD도 같다(이 기계가 그 앱을 받을 수 없으면 거기서 끝나므로 보지 않는다)
    const o = await envRig(); const ocalls = curlLog(o)
    const b = await o.install({ WHOSUP_ENV: 'ovis-app', WHOSUP_OVIS_APP_INSTALL_CMD: '', WHOSUP_OVIS_RELEASES_URL: url })
    assert.equal(b.code, 1, b.all)
    if (!/cannot be installed on this computer/.test(b.err)) assert.match(ocalls()[0], new RegExp(`^-fsSI --proto ${proto} --proto-redir ${proto} --connect-timeout 30 --max-time 60 ${url.replace(/[.]/g, '\\.')}/latest$`), ocalls()[0])
  }
})

test('B5 앱을 열 때 주는 환경: 설치기의 것(WHOSUP_* · 덧붙인 PATH)을 걷어 낸다 — 앱이 여는 셸마다 설치기의 PID·PATH가 따라다니지 않는다', () => {
  const env = { HOME: '/h', PATH: '/h/.local/bin:/usr/bin:/bin:/opt/added', WHOSUP_USER_PATH: '/usr/bin:/bin', WHOSUP_INSTALLER_PID: '123', WHOSUP_INSTALL_KIND: 'install', WHOSUP_ENV_PICK: 'herdr-app', WHOSUP_ENV_APP: '/h/.local/bin/herdr-app', WHOSUP_NODE: '/n/node', WHOSUP_PIN_DATA: '/h/.local/share/whosup', LANG: 'ko_KR.UTF-8', DISPLAY: ':0' }
  assert.deepEqual(appEnv(env), { HOME: '/h', PATH: '/usr/bin:/bin', LANG: 'ko_KR.UTF-8', DISPLAY: ':0' })
  assert.deepEqual(appEnv({ PATH: '/a', X: '1' }), { PATH: '/a', X: '1' }, '사람의 PATH 기록이 없으면 PATH는 그대로다')
  const spawned = []
  const spawnFn = (file, args, o) => { spawned.push({ file, env: o.env, detached: o.detached, stdio: o.stdio }); return { once() {}, unref() {} } }
  assert.equal(openApp('/h/.local/bin/herdr-app', { platform: 'linux', spawnFn, exists: () => true, env }), true)
  assert.deepEqual(spawned[0], { file: '/h/.local/bin/herdr-app', env: appEnv(env), detached: true, stdio: 'ignore' })
  assert.deepEqual(Object.keys(spawned[0].env).filter((k) => k.startsWith('WHOSUP_')), []); assert.equal(spawned[0].env.PATH, '/usr/bin:/bin')
  // 설치 단계(pickedEnv)가 여는 길도 같다: 받은 환경을 openApp에 넘기고, openApp이 걷어 낸다
  const picked = pickedEnv({ env, installed: 'herdr-app', mayOpen: true, platform: 'linux', open: (p, o) => openApp(p, { ...o, spawnFn, exists: () => true }) })
  assert.equal(picked.opened, true); assert.equal(spawned.length, 2); assert.deepEqual(spawned[1].env, appEnv(env))
  // macOS는 /usr/bin/open을 거친다(환경을 넘기지 않지만 주는 것은 같은 걷어 낸 환경이다)
  openApp('/h/Applications/Herdr.app', { platform: 'darwin', spawnFn, exists: () => true, env })
  assert.equal(spawned[2].file, '/usr/bin/open'); assert.deepEqual(spawned[2].env, appEnv(env))
})

test('B6 uninstall: 함께 깐 앱이 두는 폴더(코어·명령·앱 자리)도 "그대로 남겨 두었다"로 한 줄 알린다 — 앱 줄 바로 위에, 치우지 못한 것을 알리는 줄과 같은 꼴', posix, async () => {
  const r = await envRig()
  const core = join(r.home, '.local', 'bin', 'herdr-core')
  const left = mac ? [core] : [core, join(r.home, '.local', 'bin', 'herdr-app')]
  for (const lang of ['en', 'ko']) {
    const a = await r.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: fakeHerdrApp(r), WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(a.code, 0, a.all); assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).env_installed, 'herdr-app')
    const un = await r.whosup(['uninstall', '--purge'], { WHOSUP_LANG: lang })
    const T = TEXT[lang]
    assert.equal(un.code, 0, un.all)
    assert.ok(un.out.endsWith(`  ${T.saEnvKeptFolders(left.join(', '))}\n  ${T.saEnvKept(T.envNames['herdr-app'], herdrAppOf(r))}\n`), un.out)
    assert.equal(existsSync(core), true, '지우지 않는다'); assert.equal(existsSync(herdrAppOf(r)), true)
    // 다음 판을 위해 앱을 치운다(설치 명령이 다시 놓는다)
    for (const p of [...left, herdrAppOf(r)]) rmSyncQuiet(p)
  }
  // 부품: 지금 있는 것만, 아는 환경만
  assert.deepEqual(envLeftovers('herdr-app', { env: {}, home: r.home, platform: mac ? 'darwin' : 'linux' }), [])
  exe(core, '#!/bin/sh\nexit 0\n'); assert.deepEqual(envLeftovers('herdr-app', { env: {}, home: r.home, platform: 'darwin' }), [core])
  assert.deepEqual(envLeftovers('ovis-app', { env: { XDG_DATA_HOME: join(r.base, 'nowhere') }, home: r.home, platform: 'linux' }), [])
  const data = join(r.base, 'xdata'); touch(join(data, 'ovis-desktop', 'Ovis-linux-x64.AppImage'), ''); touch(join(data, 'applications', 'ovis.desktop'), '')
  assert.deepEqual(envLeftovers('ovis-app', { env: { XDG_DATA_HOME: data }, home: r.home, platform: 'linux' }), [join(data, 'ovis-desktop'), join(data, 'applications', 'ovis.desktop')])
  assert.deepEqual(envLeftovers('ovis-app', { env: { XDG_DATA_HOME: data }, home: r.home, platform: 'darwin' }), [], '맥의 Ovis 앱은 앱 묶음뿐이다')
  assert.deepEqual(envLeftovers('', { home: r.home }), []); assert.deepEqual(envLeftovers('docker', { home: r.home }), [])
})
