// 한 줄 설치기(install.sh)의 단독 설치 길을 임시 HOME에서 실제로 돌린다: 만든 파일과 실행 명령의 표식, 로그인할 때 자동으로 켜기
// (plist·service의 내용과 가짜 launchctl·systemctl이 받은 인자), whosup start·status·stop·update·uninstall, 끄는 스위치, 기존 사용자의 폴더.
// 길 선택은 test/install.test.mjs. 격리 환경은 test-support/install-rig.mjs — 실제 herdr·launchctl·systemctl·네트워크에 닿지 않는다.
// 윈도우에는 sh가 없어 이 파일의 시험은 건너뛴다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { APP_MARK, APP_MARK_FILE, LAUNCHER_MARK } from '../src/standalone.mjs'
import { INSTALL, ROOT, exe, lines, mac, posix, rig as bareRig, rx, shownRx, shq, summaryOf, walk } from '../test-support/install-rig.mjs'
import { tmpdir as osTmpdir } from 'node:os'

// 격리 폴더는 셸이 따옴표로 싸지 않는 경로에 만든다. 임시 폴더의 경로에 공백·한글 같은 글자가 있으면 설치기와 안내 문구가 화면의 경로를 '…'로
// 싸서 내놓는데(제품의 바른 동작이다), 이 파일의 단언은 싸지 않은 경로를 글자 그대로 견준다 — TMPDIR에 따라 결과가 갈리지 않게 그때는 /tmp를 쓴다.
// 싸는 동작은 그것을 보는 시험이 그런 폴더를 따로 만들어 본다.
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'

// 아무것도 없는 기계에서 설치기는 쓸 환경을 골라 깔아 준다(test/env-install.test.mjs가 본다). 이 파일의 시험이 진짜 앱 설치기를 부르는 일이
// 없게 두 앱의 설치 명령을 실패하는 대역으로 채워 두고, 이 기계에 깔린 앱(/Applications)을 보지 않게 한다.
const rig = async (o) => {
  const r = await bareRig(o), env = r.env
  r.env = (over = {}) => env({ WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), ...over })
  return r
}

// 새 버전 흉내: 이 저장소를 <임시>/<이름>으로 복사하고 scripts/standalone.mjs를 고친다(WHOSUP_INSTALL_SOURCE로 넘긴다).
const copyOf = (r, name, patch) => {
  const src = join(r.base, name)
  cpSync(ROOT, src, { recursive: true, filter: (p) => !['.git', 'node_modules', '.whosup'].includes(basename(p)) })
  const f = join(src, 'scripts', 'standalone.mjs'); writeFileSync(f, patch(readFileSync(f, 'utf8')))
  return src
}
const until = async (fn, ms = 20000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await fn()) return true; await sleep(50) } return false }
const notRoot = process.getuid?.() !== 0
// 이미 끝난 프로세스의 PID(죽은 주인) · SIGTERM을 무시하는 프로세스(끄라고 해도 꺼지지 않는 보드 흉내 — 시험이 끝나면 SIGKILL로 끝낸다)
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
// 끄는 쪽(whosup stop)은 pid 파일의 프로세스가 후즈업 보드일 때만 끈다(명령 줄에 보드의 진입점 이름이 있는가 — scripts/launch.mjs boardProcess):
// 보드로 보이게 whosup.mjs라는 이름의 스크립트로 띄운다. 보드가 아닌 프로세스를 가리키는 pid 파일은 test/harden-board.test.mjs가 본다.
const stubborn = () => new Promise((ok) => {
  const file = join(mkdtempSync(join(osTmpdir(), 'wsi-stubborn-')), 'whosup.mjs')
  writeFileSync(file, "process.on('SIGTERM', () => {}); console.log('ready'); setInterval(() => {}, 1000)\n")
  const child = spawn(process.execPath, [file], { stdio: ['ignore', 'pipe', 'ignore'] })
  child.stdout.once('data', () => ok(child))
})
const gone = (pid) => { try { process.kill(pid, 0); return false } catch { return true } }

test('단독 설치: 만든 파일, 실행 명령의 표식, 로그인 항목과 가짜 launchctl·systemctl이 받은 인자, 터미널 없는 실행의 요약, start → status → stop', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(a.code, 0, a.all)
    // 만든 것: 앱 폴더, 실행 명령, 로그인 항목, 상태 폴더 — 그 밖에는 없다(설정 폴더는 고른 값이 있을 때 생긴다)
    const top = walk(r.home).filter((p) => !p.startsWith('.local/share/whosup/app/') && !p.startsWith('.state/whosup/'))
    const login = mac ? ['Library', 'Library/LaunchAgents', 'Library/LaunchAgents/dev.whosup.board.plist'] : ['.config', '.config/systemd', '.config/systemd/user', '.config/systemd/user/whosup.service']
    assert.deepEqual(top, ['.local', '.local/bin', '.local/bin/whosup', '.local/share', '.local/share/whosup', '.local/share/whosup/app', '.local/share/whosup/install.json', '.state', '.state/whosup', ...login].sort(), '잠금·임시 폴더를 남기지 않는다')
    for (const f of ['install.sh', 'bin/whosup.mjs', 'scripts/standalone.sh', 'scripts/standalone.mjs', 'src/standalone.mjs', 'herdr-plugin.toml', 'package.json']) assert.equal(existsSync(join(r.app, f)), true, f)
    for (const f of ['.git', 'node_modules']) assert.equal(existsSync(join(r.app, f)), false, `${f}는 복사하지 않는다`)
    assert.equal(existsSync(`${r.app}.new`), false)
    // 설치 기록: 이 제품의 것이고, 이 설치가 쓰는 폴더(절대 경로)와 설치 때 고른 node를 적는다. 앱 폴더에는 설치기의 표식이 있다
    const rec = JSON.parse(readFileSync(r.record, 'utf8'))
    assert.deepEqual({ ...rec, at: null }, { product: 'whosup', id: 'fivetaku.whosup', version: JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version, at: null, data: r.data, app: r.app, launcher: r.launcher, conf: r.conf, state: r.state, node: join(r.bin, 'node'), login: r.loginFile, env_installed: '' })
    assert.ok(Math.abs(Date.parse(rec.at) - Date.now()) < 120000); assert.equal(statSync(r.record).mode & 0o777, 0o600)
    // 표식의 둘째 줄: 이 설치가 쓰는 상태 폴더(끝내지 못한 설치를 치우는 설치기가 그 폴더의 보드를 찾는다 — 굳히기 Q2-F3)
    assert.equal(readFileSync(join(r.app, APP_MARK_FILE), 'utf8'), `${APP_MARK}\nstate=${r.state}\n`)
    // 실행 명령: 둘째 줄 표식, 실행 권한, 설치 때 고른 node
    const launcher = readFileSync(r.launcher, 'utf8').split('\n')
    assert.equal(launcher[0], '#!/bin/sh'); assert.equal(launcher[1], LAUNCHER_MARK); assert.equal(launcher[1], '# whosup launcher, written by install.sh')
    // 앱 폴더는 sh의 한 낱말로 적힌다(작은따옴표 — 폴더 이름에 공백·작은따옴표가 있어도). 따옴표 규칙 자체는 test/standalone.test.mjs가 글자로 고정한다
    assert.equal(statSync(r.launcher).mode & 0o777, 0o755); assert.ok(launcher.includes(`app=${shq(r.app)}`)); assert.ok(launcher.includes(`WHOSUP_NODE=${shq(join(r.bin, 'node'))}`))
    assert.deepEqual(readdirSync(join(r.home, '.local', 'bin')), ['whosup'], '임시 파일을 남기지 않는다'); assert.equal(statSync(r.loginFile).mode & 0o777, 0o600)
    // 로그인 항목의 내용과 서비스 관리자가 받은 인자
    const item = readFileSync(r.loginFile, 'utf8')
    if (mac) {
      assert.match(item, new RegExp(`<key>ProgramArguments</key><array><string>/bin/sh</string><string>${r.app}/scripts/standalone\\.sh</string><string>start</string></array>`))
      assert.match(item, /<key>Label<\/key><string>dev\.whosup\.board<\/string>/); assert.match(item, /<key>RunAtLoad<\/key><true\/>/); assert.match(item, /<key>AbandonProcessGroup<\/key><true\/>/)
      // PATH는 고른 node의 폴더와 시스템 기본 폴더뿐이다(설치할 때의 PATH 전체를 싣지 않는다). node는 절대 경로로 따로 싣는다
      assert.match(item, new RegExp(`<key>PATH</key><string>${r.bin}:/usr/bin:/bin:/usr/sbin:/sbin</string>`)); assert.match(item, new RegExp(`<key>XDG_STATE_HOME</key><string>${r.home}/\\.state</string>`))
      assert.match(item, new RegExp(`<key>WHOSUP_NODE</key><string>${r.bin}/node</string>`)); assert.match(item, /<key>WHOSUP_LOGIN_START<\/key><string>1<\/string>/)
      assert.deepEqual(r.ctlCalls().filter((c) => !c.startsWith('print ')), [`bootout gui/${process.getuid()}/dev.whosup.board`, `bootstrap gui/${process.getuid()} ${r.plist}`])
    } else {
      assert.match(item, new RegExp(`^ExecStart="/bin/sh" "${r.app}/scripts/standalone\\.sh" start$`, 'm')); assert.match(item, new RegExp(`^ExecStop="/bin/sh" "${r.app}/scripts/standalone\\.sh" stop --service$`, 'm'))
      assert.match(item, new RegExp(`^Environment="WHOSUP_NODE=${r.bin}/node"$`, 'm')); assert.match(item, new RegExp(`^Environment="PATH=${r.bin}:/usr/bin:/bin:/usr/sbin:/sbin"$`, 'm'))
      assert.match(item, /^Type=oneshot$/m); assert.match(item, /^WantedBy=default\.target$/m); assert.match(item, new RegExp(`^Environment="XDG_STATE_HOME=${r.home}/\\.state"$`, 'm'))
      assert.deepEqual(r.ctlCalls().filter((c) => !c.includes('show-environment') && !c.includes('is-enabled')), ['--user daemon-reload', '--user enable --now whosup.service'])
    }
    const ctlBeforeStop = r.ctlCalls().length
    // 터미널 없는 실행(에이전트): 요약이 설치 출력(표준 출력)에 남는다. 진단 줄(첫 실행 안내 상태 · 보드 켜기 · 로그인 항목)은 화면이 아니라
    // <상태 폴더>/install.log에 남는다(실기기 걷기 B2 — 성공한 설치의 화면에 영어 내부 줄이 섞이지 않는다)
    assert.doesNotMatch(a.out, /whosup setup: |whosup listening at |start at login: /)
    const ilog = readFileSync(join(r.state, 'install.log'), 'utf8')
    assert.match(ilog, /whosup setup: no terminal — nothing asked\n/); assert.match(ilog, new RegExp(`whosup listening at http://127\\.0\\.0\\.1:${r.port}\\n`))
    const s = summaryOf(a.out)
    assert.match(s, new RegExp(`^whosup install summary\\n {2}Installed on its own, without herdr \\(standalone\\)\\.\\n {2}Program: ${r.app}\\n {2}The board is running: {2}http://127\\.0\\.0\\.1:${r.port}\\n`))
    assert.match(s, new RegExp(` {2}It starts by itself when you log in\\. To turn that off, type this in a terminal:\\n {6}${shownRx(r.launcher)} autostart off\\n`))
    assert.match(s, new RegExp(`${rx(r.home)}/\\.local/bin is not on your PATH, so the command is spelled with its full path\\.`)); assert.match(s, / {2}The board asks on first open\.\n/)
    assert.match(s, new RegExp(` {6}${shownRx(r.launcher)} help\\n {2}To change any of this, use settings in the board\\.\\n$`))
    assert.doesNotMatch(a.out, /herdr plugin|plugin action|`/); assert.deepEqual(r.herdrCalls(), [])
    // 보드가 실제로 답하고, 상태 폴더는 <XDG_STATE_HOME>/whosup — ~/.config/whosup은 만들지 않았다
    assert.equal(await r.health(), true); const pid = r.pid(); assert.ok(pid > 1); assert.equal(existsSync(join(r.state, 'whosup.db')), true); assert.equal(existsSync(r.conf), false)
    // status → stop → status → start
    const st = await r.whosup(['status'])
    assert.equal(st.code, 0, st.all); assert.match(st.out, new RegExp(`^whosup listening at http://127\\.0\\.0\\.1:${r.port} \\(pid ${pid}\\)\\nStart at login: on \\(${r.loginFile}\\)\\n$`))
    const stop = await r.whosup(['stop'])
    assert.equal(stop.code, 0, stop.all); assert.match(stop.out, /^whosup stopped\n$/); assert.equal(await r.health(), false)
    // Linux: stop은 사용자 서비스도 멈춘다(active (exited)로 남으면 다시 켜지지 않는다). macOS에서는 서비스 관리자를 부르지 않는다
    const stopCalls = r.ctlCalls().slice(ctlBeforeStop).filter((c) => !c.startsWith('print ') && !c.includes('show-environment') && !c.includes('is-enabled'))
    assert.deepEqual(stopCalls, mac ? [] : ['--user is-active --quiet whosup.service', '--user stop whosup.service', '--user is-active --quiet whosup.service'], '멈춘 뒤 멈췄는지 다시 묻는다')
    const down = await r.whosup(['status'])
    assert.equal(down.code, 1); assert.match(down.out, /^whosup not running\nStart at login: on /)
    const start = await r.whosup(['start'])
    assert.equal(start.code, 0, start.all); assert.match(start.out, /^whosup listening at /); assert.equal(await r.health(), true); assert.notEqual(r.pid(), pid)
    assert.match((await r.whosup(['start'])).out, /already listening/)
    // setup: 묻지 않게 한 실행(터미널 없음)도 0으로 끝난다
    const again = await r.whosup(['setup'], { WHOSUP_NO_SETUP: '1' })
    assert.equal(again.code, 0, again.all)
    // help · 모르는 명령
    const help = await r.whosup(['help'])
    assert.equal(help.code, 0); assert.match(help.out, /whosup uninstall \[--purge\]/); assert.equal((await r.whosup(['nope'])).code, 2)
    await r.whosup(['stop'])
  } finally { r.cleanup() }
})

test('update: 새 버전으로 바꾸고 설정·상태를 지키며 켜져 있었으면 다시 켠다. uninstall은 설정·상태만 남기고, --purge는 아무것도 남기지 않는다', posix, async () => {
  const r = await rig()
  const onPath = { PATH: `${r.bin}:${r.home}/.local/bin:/usr/bin:/bin` }
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', ...onPath })
    assert.equal(a.code, 0, a.all)
    assert.match(summaryOf(a.out), / {6}whosup autostart off\n/, 'PATH에 ~/.local/bin이 있으면 명령은 whosup 한 낱말'); assert.doesNotMatch(a.out, /not on your PATH/)
    const pid = r.pid()
    // 설정(.env · setup.json)과 상태(표식 파일)를 두고, 이전 버전의 표식을 앱 폴더에 둔다
    mkdirSync(r.conf, { recursive: true })
    writeFileSync(join(r.conf, '.env'), `PORT=${r.port}\n`); writeFileSync(join(r.conf, 'setup.json'), '{"version":1,"at":"2026-01-01T00:00:00.000Z","choices":{"agent_cmd":"codex"}}\n')
    writeFileSync(join(r.state, 'keep.txt'), 'history'); writeFileSync(join(r.app, 'OLD_VERSION'), 'old')
    const ctlBefore = r.ctlCalls().length
    const u = await r.whosup(['update'], onPath)
    assert.equal(u.code, 0, u.all)
    assert.match(u.out, /a standalone whosup is here .*replacing it with the new version, settings and history kept/)
    assert.match(readFileSync(join(r.state, 'install.log'), 'utf8'), /already set up — nothing asked/); assert.doesNotMatch(u.out, /nothing asked/, '진단 줄은 화면에 없다')
    assert.match(summaryOf(u.out), new RegExp(`^whosup install summary\\n {2}whosup updated to the new version\\. Your settings and history are kept\\.\\n {2}Program: ${r.app}\\n {2}The board is running: {2}http://127\\.0\\.0\\.1:${r.port}\\n`))
    assert.equal(existsSync(join(r.app, 'OLD_VERSION')), false, '앱 폴더가 새 것으로 바뀌었다'); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(existsSync(`${r.app}.new`), false)
    assert.equal(readFileSync(join(r.conf, '.env'), 'utf8'), `PORT=${r.port}\n`); assert.match(readFileSync(join(r.conf, 'setup.json'), 'utf8'), /"agent_cmd":"codex"/)
    assert.equal(readFileSync(join(r.state, 'keep.txt'), 'utf8'), 'history'); assert.equal(existsSync(join(r.state, 'whosup.db')), true)
    assert.equal(await r.health(), true, '켜져 있었으니 다시 켠다'); assert.notEqual(r.pid(), pid)
    assert.equal(existsSync(r.loginFile), true, '로그인 항목은 그대로'); assert.ok(r.ctlCalls().length > ctlBefore)
    // 꺼 둔 보드·꺼 둔 로그인 항목은 업데이트가 다시 켜지 않는다
    assert.equal((await r.whosup(['stop'], onPath)).code, 0)
    const off = await r.whosup(['autostart', 'off'], onPath)
    assert.equal(off.code, 0); assert.match(off.out, /^Start at login: off\n$/); assert.equal(existsSync(r.loginFile), false)
    const u2 = await r.whosup(['update'], onPath)
    assert.equal(u2.code, 0, u2.all); assert.equal(await r.health(), false); assert.equal(existsSync(r.loginFile), false)
    assert.match(summaryOf(u2.out), / {2}The board is not running\. To start it, type this in a terminal:\n {6}whosup start\n {2}It does not start by itself when you log in\. To make it do so, type this in a terminal:\n {6}whosup autostart on\n/)
    // autostart on: 보드가 꺼져 있으면 파일만 둔다(지금 켜지 않는다)
    const calls = r.ctlCalls().length
    const on = await r.whosup(['autostart', 'on'], onPath)
    assert.equal(on.code, 0, on.all); assert.match(on.out, new RegExp(`^Start at login: on \\(${r.loginFile}\\)\\n$`)); assert.equal(existsSync(r.loginFile), true)
    assert.equal(r.ctlCalls().slice(calls).some((c) => /bootstrap|--now/.test(c)), false); assert.equal(await r.health(), false)

    // uninstall: 보드 끄기 → 로그인 항목 해제 → 실행 명령·앱 폴더 삭제. 설정·상태만 남는다
    await r.whosup(['start'], onPath); assert.equal(await r.health(), true)
    const un = await r.whosup(['uninstall'], onPath)
    assert.equal(un.code, 0, un.all); assert.equal(await r.health(), false, '보드를 끈다')
    assert.match(un.out, new RegExp(`^whosup is uninstalled\\.\\n {2}Removed: ${r.launcher}, ${r.app}\\n {2}Kept \\(your settings and history\\): ${r.conf}, ${r.state}\\n`))
    const left = walk(r.home)
    assert.deepEqual(left.filter((p) => /whosup/.test(p) && !p.startsWith('.config/whosup') && !p.startsWith('.state/whosup')), [], '설정·상태 말고 whosup의 것은 없다')
    assert.equal(existsSync(r.launcher), false); assert.equal(existsSync(r.app), false); assert.equal(existsSync(r.loginFile), false)
    assert.deepEqual(readdirSync(r.conf).sort(), ['.env', 'setup.json']); assert.equal(readFileSync(join(r.state, 'keep.txt'), 'utf8'), 'history'); assert.equal(existsSync(join(r.state, 'whosup.db')), true)
    // 로그인 항목 해제: 내린 뒤(bootout · disable) 서비스 관리자에 아직 살아 있는지 다시 묻는다(print · is-enabled)
    assert.deepEqual(r.ctlCalls().slice(mac ? -2 : -3).map((c) => c.split(' ').slice(0, mac ? 1 : 2).join(' ')), mac ? ['bootout', 'print'] : ['--user disable', '--user is-enabled', '--user daemon-reload'])

    // 다시 깔고(기록이 남아 있으니 묻지 않는다) --purge로 지우면 아무것도 남지 않는다
    const re = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', ...onPath })
    assert.equal(re.code, 0, re.all); assert.match(readFileSync(join(r.state, 'install.log'), 'utf8'), /already set up — nothing asked/); assert.doesNotMatch(re.out, /nothing asked/, '진단 줄은 화면에 없다')
    assert.doesNotMatch(summaryOf(re.out), /asks on first open/); assert.equal(await r.health(), true)
    const purge = await r.whosup(['uninstall', '--purge'], { ...onPath, WHOSUP_LANG: 'ko' })
    assert.equal(purge.code, 0, purge.all); assert.match(purge.out, /^whosup을 지웠습니다\.\n {2}지운 것: /); assert.doesNotMatch(purge.out, /남겨 둔 것/)
    assert.equal(await r.health(), false)
    assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [], 'whosup의 것은 하나도 남지 않는다')
    assert.deepEqual(walk(r.home).filter((p) => { try { return statSync(join(r.home, p)).isFile() } catch { return false } }), [], '파일은 하나도 남지 않는다')
    // 없는 것을 지우라고 하면 그렇다고 말한다(실행 명령이 없으니 앱의 스크립트를 직접 부를 수도 없다 — 설치기 사본으로 확인)
    const none = await r.run('/bin/sh', [join(ROOT, 'scripts', 'standalone.sh'), 'uninstall'], onPath)
    assert.equal(none.code, 1); assert.match(none.out, /^There is no standalone whosup install here\.\n$/)
  } finally { r.cleanup() }
})

test('update 중간 실패: 새 버전의 마지막 단계가 죽으면 이전 버전으로 되돌리고 켜져 있던 보드를 다시 켠다 — 새 버전이 돌지도 않으면 아무것도 바꾸지 않는다', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
    writeFileSync(join(r.app, 'OLD_VERSION'), 'old'); writeFileSync(join(r.state, 'keep.txt'), 'history')
    const loginBefore = readFileSync(r.loginFile, 'utf8')
    // 새 버전: help는 되지만 설치의 마지막 단계(install)에서 죽는다
    const marker = "case 'install': return install(ctx)"
    const crashing = copyOf(r, 'crashing', (text) => { assert.ok(text.includes(marker)); return text.replace(marker, "case 'install': throw new Error('boom in the new version')") })
    const u = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: crashing })
    assert.equal(u.code, 1, u.all); assert.doesNotMatch(u.out, /install summary/)
    assert.match(u.err, /boom in the new version/, '새 버전이 한 말은 그대로 보인다')
    assert.match(u.err, /whosup: the new version did not finish installing \(its last step ended with 1; what it said is above\), so the version that was here before is back in place\. Your settings and history are kept\. If the board is not running, start it: whosup start\n$/)
    assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old', '이전 버전이 제자리에 있다'); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(existsSync(`${r.app}.new`), false)
    assert.doesNotMatch(readFileSync(join(r.app, 'scripts', 'standalone.mjs'), 'utf8'), /boom in the new version/)
    assert.equal(await r.health(), true, '켜져 있던 보드를 다시 켠다'); assert.equal(readFileSync(join(r.state, 'keep.txt'), 'utf8'), 'history')
    assert.equal(readFileSync(r.loginFile, 'utf8'), loginBefore, '로그인 항목은 그대로'); assert.equal((await r.whosup(['status'])).code, 0)
    // 한국어, 꺼져 있던 보드: 되돌린 뒤에도 켜지 않는다
    assert.equal((await r.whosup(['stop'])).code, 0)
    const ko = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: crashing, WHOSUP_LANG: 'ko' })
    assert.equal(ko.code, 1); assert.match(ko.err, /whosup: 새 버전의 설치를 끝내지 못해\(마지막 단계 종료 코드 1, 위에 그 출력이 있습니다\) 전에 쓰던 버전으로 되돌렸습니다\. 설정과 기록은 그대로입니다\./)
    assert.equal(await r.health(), false, '꺼 둔 보드는 켜지 않는다'); assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old')
    // 새 버전이 이 Node에서 돌지도 않는다(help 실패): 보드를 끄지도 폴더를 바꾸지도 않는다
    await r.whosup(['start']); const pid = r.pid()
    const broken = copyOf(r, 'broken', () => 'this is not javascript (\n')
    const b = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: broken })
    assert.equal(b.code, 1); assert.match(b.err, /whosup: the downloaded whosup does not run here; what it said is above\. Nothing was changed\.\n$/)
    assert.equal(r.pid(), pid, '보드는 그대로 돌고 있다'); assert.equal(await r.health(), true); assert.equal(existsSync(`${r.app}.new`), false); assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old')
    await r.whosup(['stop'])
    // 새 설치의 마지막 단계가 죽는다: 무엇이 남았고 무엇을 하면 되는지 한 줄로 알린다
    const fresh = await rig()
    const f = await fresh.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: crashing })
    assert.equal(f.code, 1)
    assert.match(f.err, /whosup: the install did not finish \(its last step ended with 1; what it said is above\)\. What it had put in place was removed, so whosup is not installed; settings and history, if you had any, are kept\. Run this installer again\.\n$/)
    assert.equal(existsSync(fresh.launcher), false); assert.equal(existsSync(fresh.loginFile), false); assert.equal(await fresh.health(), false)
    assert.deepEqual(walk(fresh.home).filter((p) => /whosup/.test(p)), [], '반쯤 깔린 것을 남기지 않는다(다음 실행은 새 설치다)')
    // 그 뒤 온전한 판으로 다시 돌리면 새 설치로 끝난다(보드를 켜고 로그인 항목을 등록한다)
    const retry = await fresh.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    try {
      assert.equal(retry.code, 0, retry.all); assert.match(summaryOf(retry.out), /Installed on its own, without herdr \(standalone\)\./)
      assert.equal(await fresh.health(), true); assert.equal(existsSync(fresh.loginFile), true)
    } finally { fresh.cleanup() }
  } finally { r.cleanup() }
})

test('남의 ~/.local/bin/whosup은 덮지 않고 알린다 — 설치는 계속되고, 지울 때도 그 파일은 그대로다', posix, async () => {
  const r = await rig()
  try {
    mkdirSync(join(r.home, '.local', 'bin'), { recursive: true })
    const mine = '#!/bin/sh\necho "someone else\'s whosup"\n'
    exe(r.launcher, mine)
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(a.code, 0, a.all); assert.equal(readFileSync(r.launcher, 'utf8'), mine, '덮지 않는다')
    const s = summaryOf(a.out)
    assert.match(s, new RegExp(`${r.launcher} is already there and is not whosup's, so it was left as it is\\. Use the long command below\\.`))
    assert.match(s, new RegExp(` {6}sh ${shownRx(join(r.app, 'scripts', 'standalone.sh'))} help\\n`)); assert.equal(await r.health(), true, '보드는 켜졌다')
    const un = await r.run('/bin/sh', [join(r.app, 'scripts', 'standalone.sh'), 'uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.match(un.out, new RegExp(`${r.launcher} is not whosup's, so it was left as it is\\.`))
    assert.equal(readFileSync(r.launcher, 'utf8'), mine); assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), ['.local/bin/whosup'])
  } finally { r.cleanup() }
})

test('스위치: WHOSUP_NO_AUTOSTART(지금 켜지 않음) · WHOSUP_NO_LOGIN_START(로그인 항목만 끔) · CI(둘 다 안 함)', posix, async () => {
  // WHOSUP_NO_AUTOSTART: 보드를 켜지 않는다. 로그인 항목은 파일만 둔다(지금 불러 두면 보드가 켜진다)
  const a = await rig()
  try {
    const x = await a.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_AUTOSTART: '1' })
    assert.equal(x.code, 0, x.all); assert.equal(await a.health(), false); assert.equal(a.pid(), 0); assert.equal(existsSync(a.loginFile), true)
    assert.equal(a.ctlCalls().some((c) => /bootstrap|--now/.test(c)), false, a.ctlCalls().join(' | '))
    const s = summaryOf(x.out)
    assert.match(s, new RegExp(` {2}The board is not running\\. To start it, type this in a terminal:\\n {6}${shownRx(a.launcher)} start\\n {2}It starts by itself when you log in\\. To turn that off, type this in a terminal:\\n {6}${shownRx(a.launcher)} autostart off\\n`))
    const ilog = readFileSync(join(a.state, 'install.log'), 'utf8')
    assert.match(ilog, /start at login: on \(.*, loads at the next login\)/); assert.doesNotMatch(ilog, /could not be loaded now/, '불러 두지 않기로 한 것이지 실패가 아니다')
    assert.doesNotMatch(x.out, /start at login: /, '진단 줄은 화면에 없다(install.log에 있다)')
  } finally { a.cleanup() }
  // WHOSUP_NO_LOGIN_START: 보드는 켜고 로그인 항목은 등록하지 않는다
  const b = await rig()
  try {
    const x = await b.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_LOGIN_START: '1', WHOSUP_LANG: 'ko' })
    assert.equal(x.code, 0, x.all); assert.equal(await b.health(), true); assert.equal(existsSync(b.plist), false); assert.equal(existsSync(b.unit), false)
    assert.deepEqual(b.ctlCalls().filter((c) => !c.includes('show-environment') && !c.includes('is-enabled')), [])
    assert.match(x.out, /whosup 설치 요약\n {2}herdr 없이 단독으로 설치했습니다\.\n/); assert.match(x.out, new RegExp(` {2}로그인할 때 자동으로 켜지지는 않습니다\\. 그렇게 하려면 터미널에 아래를 치세요:\\n {6}${shownRx(b.launcher)} autostart on\\n`))
    assert.match(x.out, new RegExp(`보드가 켜져 있습니다: {2}http://127\\.0\\.0\\.1:${b.port}\\n`))
    await b.whosup(['stop'])
  } finally { b.cleanup() }
  // CI: 묻지도 켜지도 등록하지도 않는다 — 파일은 놓고 요약은 찍는다
  const c = await rig()
  try {
    const x = await c.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: 'true' })
    assert.equal(x.code, 0, x.all); assert.equal(await c.health(), false); assert.equal(existsSync(c.state), false, '상태 폴더도 만들지 않는다')
    assert.equal(existsSync(c.plist), false); assert.equal(existsSync(c.unit), false); assert.equal(existsSync(c.launcher), true); assert.equal(existsSync(join(c.app, 'bin', 'whosup.mjs')), true)
    // 진단 줄은 화면에 찍지 않는다(상태 폴더가 없으니 install.log도 없다 — 요약이 같은 사실을 말한다)
    assert.doesNotMatch(x.out, /whosup setup: CI/); assert.match(summaryOf(x.out), /The board is not running\. To start it.*\n.*\n {2}It does not start by itself when you log in\./)
    assert.deepEqual(c.ctlCalls().filter((l) => !l.includes('show-environment') && !l.includes('is-enabled')), [])
  } finally { c.cleanup() }
})

test('macOS: launchctl bootstrap이 실패해도 설치는 끝난다 — 로그인 항목 파일은 놓이고, 출력은 "지금 바로 불러 두지는 못했다"를 구분해 적는다', { skip: mac ? posix.skip : 'launchctl bootstrap은 macOS의 것이다(Linux의 enable 실패는 test/standalone.test.mjs)' }, async () => {
  const r = await rig()
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', FAKE_CTL_FAIL: 'bootstrap' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true, '보드는 설치기가 직접 켰다')
    assert.equal(existsSync(r.plist), true, '파일은 놓였다: 다음 로그인부터 켜진다')
    assert.deepEqual(r.ctlCalls().filter((c) => !c.startsWith('print ')), [`bootout gui/${process.getuid()}/dev.whosup.board`, `bootstrap gui/${process.getuid()} ${r.plist}`])
    assert.match(readFileSync(join(r.state, 'install.log'), 'utf8'), new RegExp(`whosup: start at login: on \\(${rx(r.plist)}, could not be loaded now: loads at the next login\\)\\n`))
    assert.doesNotMatch(a.out, /start at login: /, '진단 줄은 화면이 아니라 install.log에')
    // 요약: 등록은 된 것이다 — "등록하지 못했다"·"자동으로 켜지지 않는다"로 말하지 않는다
    const s = summaryOf(a.out)
    assert.doesNotMatch(s, /Could not set it to start|does not start by itself|It starts by itself/)
    // 요약이 그 사실을 말한다: 등록은 됐고 다음 로그인부터 켜진다 — 끄는 법도 그대로 싣는다
    assert.match(s, new RegExp(` {2}It is set to start when you log in, but could not be loaded right now, so that begins at your next login\\. To turn that off, type this in a terminal:\\n {6}${shownRx(r.launcher)} autostart off\\n`))
    // 상태: 파일은 있지만 launchd가 불러 두지 않았다 → "다음 로그인부터"
    const st = await r.whosup(['status'])
    assert.equal(st.code, 0, st.all); assert.ok(st.out.includes(`Start at login: on, from your next login (${r.plist})\n`), st.out)
    // autostart on(보드가 켜져 있어 지금 불러 두려 한다)도 같은 사실을 말한다. 한국어 요약 문구도 같다
    const on = await r.whosup(['autostart', 'on'], { FAKE_CTL_FAIL: 'bootstrap' })
    assert.equal(on.code, 0, on.all); assert.equal(on.out, `Start at login: on (${r.plist})\n  It is set to start when you log in, but could not be loaded right now, so that begins at your next login.\n`)
    const loaded = await r.whosup(['autostart', 'on'])
    assert.equal(loaded.out, `Start at login: on (${r.plist})\n`); assert.ok((await r.whosup(['status'])).out.includes(`Start at login: on (${r.plist})\n`), '불러 둔 뒤에는 그냥 켜짐이다')
    await r.whosup(['stop'])
  } finally { r.cleanup() }
})

test('기존 사용자: ~/.config/whosup에 이미 상태(whosup.db)가 있으면 그 폴더를 그대로 쓴다 — 옮기지도 새 상태 폴더를 만들지도 않는다', posix, async () => {
  const r = await rig()
  try {
    // 폴더에서 손으로 띄워 쓰던 사람: 설정과 상태가 ~/.config/whosup 한 폴더에 있다
    mkdirSync(r.conf, { recursive: true })
    const { DatabaseSync } = await import('node:sqlite')
    const db = new DatabaseSync(join(r.conf, 'whosup.db')); db.exec('CREATE TABLE IF NOT EXISTS legacy_mark (v TEXT)'); db.exec("INSERT INTO legacy_mark VALUES ('mine')"); db.close()
    writeFileSync(join(r.conf, '.env'), `PORT=${r.port}\nOPEN_BROWSER=0\n`); writeFileSync(join(r.conf, 'notes.txt'), 'keep me')
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', PORT: '' })
    assert.equal(a.code, 0, a.all)
    // 쓰던 사람에게는 묻지 않는다(진단 줄은 화면이 아니라 그 폴더의 install.log에 — 상태 폴더가 설정 폴더와 같다)
    assert.match(readFileSync(join(r.conf, 'install.log'), 'utf8'), /already set up — nothing asked/); assert.doesNotMatch(a.out, /nothing asked/)
    assert.match(summaryOf(a.out), new RegExp(`The board is running: {2}http://127\\.0\\.0\\.1:${r.port}\\n`), '.env의 PORT로 뜬다')
    assert.equal(existsSync(r.state), false, '새 상태 폴더를 만들지 않는다')
    assert.equal(readFileSync(join(r.conf, 'notes.txt'), 'utf8'), 'keep me'); assert.equal(readFileSync(join(r.conf, '.env'), 'utf8'), `PORT=${r.port}\nOPEN_BROWSER=0\n`)
    assert.ok(r.pid(r.conf) > 1, 'pid·port는 쓰던 폴더에 적는다'); assert.equal(lines(join(r.conf, 'port'))[0], String(r.port)); assert.equal(await r.health(r.port), true)
    // 로그인 항목의 기록 파일도 그 폴더를 가리킨다
    if (mac) assert.match(readFileSync(r.plist, 'utf8'), new RegExp(`<key>StandardOutPath</key><string>${r.conf}/autostart\\.log</string>`))
    const st = await r.whosup(['status'], { PORT: '' })
    assert.equal(st.code, 0, st.all); assert.match(st.out, new RegExp(`whosup listening at http://127\\.0\\.0\\.1:${r.port} \\(pid ${r.pid(r.conf)}\\)`))
    assert.equal((await r.whosup(['stop'], { PORT: '' })).code, 0)
    // 그 사람의 기록은 그대로다
    const again = new DatabaseSync(join(r.conf, 'whosup.db')); assert.deepEqual(again.prepare('SELECT v FROM legacy_mark').all().map((x) => x.v), ['mine']); again.close()
    // 지워도(--purge 없이) 그 폴더는 남는다
    const un = await r.whosup(['uninstall'], { PORT: '' })
    assert.equal(un.code, 0, un.all); assert.match(un.out, new RegExp(`Kept \\(your settings and history\\): ${r.conf}\\n`)); assert.equal(readFileSync(join(r.conf, 'notes.txt'), 'utf8'), 'keep me')
  } finally { r.cleanup() }
})

// ── 그만둔 설치 · 신호 · 남의 폴더 · 폴더 고정 · 잠금 · 내려받기 · Node 고르기 · PATH 없음 ──
const quiet = (calls) => calls.filter((c) => !c.startsWith('print ') && !c.includes('show-environment') && !c.includes('is-enabled') && !c.includes('is-active'))

test('그만둔 설치: 첫 실행 안내가 그만두면(Ctrl-C · 설치기가 죽음) 더 나아가지 않는다 — 새 설치는 놓은 것을 치우고, 새 버전으로 바꾸던 설치는 이전 버전으로 되돌린다(130)', posix, async () => {
  // runSetup이 돌려주는 두 상태(src/setup.mjs): 'interrupted' = 질문에서 Ctrl-C, 'cancelled' = 설치 명령(WHOSUP_INSTALLER_PID)이 죽었다
  await Promise.all(['cancelled', 'interrupted'].map(async (state) => {
    const r = await rig()
    try {
      const marker = 'return await runSetup({'
      const quitting = copyOf(r, `quit-${state}`, (text) => { assert.ok(text.includes(marker)); return text.replace(marker, `return { state: '${state}' }; await runSetup({`) })
      // 새 설치: 실행 명령·보드·로그인 항목·설치 기록을 놓지 않고, 방금 놓은 앱 폴더와 잠금도 남기지 않는다
      const f = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: quitting })
      assert.equal(f.code, 130, `${state}: ${f.all}`); assert.doesNotMatch(f.out, /install summary/)
      assert.deepEqual(walk(r.home).filter((p) => /whosup|Library|systemd/.test(p)), [], state); assert.equal(await r.health(), false); assert.deepEqual(quiet(r.ctlCalls()), [])
      // 새 버전으로 바꾸던 설치: 130으로 끝나고 이전 버전이 제자리에 돌아온다(켜져 있던 보드도 다시 켠다)
      const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
      assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
      writeFileSync(join(r.app, 'OLD_VERSION'), 'old')
      const loginBefore = readFileSync(r.loginFile, 'utf8'), launcherBefore = readFileSync(r.launcher, 'utf8'), calls = r.ctlCalls().length
      const u = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: quitting })
      assert.equal(u.code, 130, `${state}: ${u.all}`); assert.doesNotMatch(u.out, /install summary/)
      assert.match(u.err, /whosup: stopped: the version that was here before is back in place\. Your settings and history are kept\.\n$/)
      assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old'); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(existsSync(`${r.app}.new`), false)
      assert.equal(existsSync(join(r.data, 'install.lock')), false, '잠금을 푼다'); assert.equal(await r.health(), true, '켜져 있던 보드를 다시 켠다')
      assert.equal(readFileSync(r.loginFile, 'utf8'), loginBefore); assert.equal(readFileSync(r.launcher, 'utf8'), launcherBefore)
      assert.deepEqual(quiet(r.ctlCalls().slice(calls)).filter((c) => !/ stop /.test(` ${c} `)), [], '새 버전은 로그인 항목을 건드리지 않았다')
      const ko = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: quitting, WHOSUP_LANG: 'ko' })
      assert.equal(ko.code, 130); assert.match(ko.err, /whosup: 그만두었습니다: 전에 쓰던 버전으로 되돌렸습니다\. 설정과 기록은 그대로입니다\.\n$/)
      await r.whosup(['stop'])
    } finally { r.cleanup() }
  }))
})

test('신호: 새 버전으로 바꾸는 중에 설치기가 kill·Ctrl-C를 받으면 이전 버전으로 되돌리고 켜져 있던 보드를 다시 켠 뒤 잠금을 푼다', posix, async () => {
  const r = await rig()
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
    writeFileSync(join(r.app, 'OLD_VERSION'), 'old')
    // 새 버전: 설치의 마지막 단계에 들어가면 표식 파일을 쓰고 오래 머문다(질문을 기다리는 설치처럼)
    const flag = join(r.base, 'in-install')
    const marker = "case 'install': return install(ctx)"
    const slow = copyOf(r, 'slow', (text) => { assert.ok(text.includes(marker)); return text.replace(marker, `case 'install': { (await import('node:fs')).writeFileSync(${JSON.stringify(flag)}, ''); await new Promise((ok) => setTimeout(ok, 60000)); return 0 }`) })
    for (const [signal, code] of [['SIGTERM', 143], ['SIGINT', 130], ['SIGHUP', 129]]) {
      let child = null
      const running = r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: slow }, { onSpawn: (c) => { child = c } })
      assert.equal(await until(() => existsSync(flag)), true, `${signal}: 새 버전의 마지막 단계까지 간다`)
      assert.equal(existsSync(`${r.app}.old`), true, '바꾸는 중이다: 이전 버전은 app.old에 있다'); assert.equal(existsSync(join(r.data, 'install.lock')), true); assert.equal(await r.health(), false)
      assert.deepEqual(lines(join(r.data, 'install.lock', 'pid')), [String(child.pid)], '잠금에 주인(설치기)의 PID를 적는다')
      if (signal === 'SIGTERM') {
        // 진행 중인 설치의 잠금은 시간이 지나도 걷지 않는다(질문을 기다리는 설치는 10분을 넘길 수 있다): 다른 설치기도 whosup uninstall도 기다리라고 알리고 1
        const old = new Date(Date.now() - 24 * 3600 * 1000); utimesSync(join(r.data, 'install.lock'), old, old)
        const second = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
        assert.equal(second.code, 1, second.all); assert.match(second.err, /another whosup install is running here/)
        const un = await r.run('/bin/sh', [join(ROOT, 'scripts', 'standalone.sh'), 'uninstall', '--purge'])
        assert.equal(un.code, 1, un.all); assert.match(un.out, /^Another whosup install or removal is running here \(the lock .*install\.lock is held\)\. Wait for it to end, then run this again\. Nothing was changed\.\n$/)
        assert.equal(existsSync(`${r.app}.old`), true, '바꾸는 도중의 폴더를 건드리지 않았다'); assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true)
        assert.deepEqual(lines(join(r.data, 'install.lock', 'pid')), [String(child.pid)], '남의 잠금은 그대로다')
      }
      process.kill(-child.pid, signal)   // 설치기와 그 자식(새 버전의 마지막 단계)이 같이 받는다 — 터미널의 Ctrl-C처럼
      const u = await running
      assert.equal(u.code, code, `${signal}: ${u.all}`); assert.doesNotMatch(u.out, /install summary/)
      assert.match(u.err, /whosup: stopped: the version that was here before is back in place\. Your settings and history are kept\.\n$/, signal)
      assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old', `${signal}: 이전 버전이 제자리에 있다`); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(existsSync(`${r.app}.new`), false)
      assert.equal(existsSync(join(r.data, 'install.lock')), false, `${signal}: 잠금을 푼다`); assert.equal(await r.health(), true, `${signal}: 켜져 있던 보드를 다시 켠다`)
      renameSync(flag, `${flag}.${signal}`)
    }
    // 그 뒤의 업데이트는 평소대로 된다(잠금·남은 폴더에 막히지 않는다)
    const again = await r.whosup(['update'])
    assert.equal(again.code, 0, again.all); assert.equal(existsSync(join(r.app, 'OLD_VERSION')), false)
    await r.whosup(['stop'])
  } finally { r.cleanup() }
})

test('남의 폴더: 설치 기록이 가리키지 않는 폴더는 단독 설치가 아니다 — 그 안의 스크립트를 돌리지도 덮지도 지우지도 않고 알린 뒤 1로 끝난다', posix, async () => {
  // 그 자리(<데이터 폴더>/whosup/app)에 남의 폴더: scripts/standalone.sh가 있고 herdr-plugin.toml까지 흉내 냈다 — 돌리면 표식 파일이 생긴다
  const plant = (r) => {
    const ran = join(r.base, 'foreign-ran')
    mkdirSync(join(r.app, 'scripts'), { recursive: true }); exe(join(r.app, 'scripts', 'standalone.sh'), `#!/bin/sh\necho ran >> ${shq(ran)}\n`)
    writeFileSync(join(r.app, 'herdr-plugin.toml'), 'id = "fivetaku.whosup"\n'); writeFileSync(join(r.app, 'mine.txt'), 'keep')
    return ran
  }
  const intact = (r) => { assert.equal(readFileSync(join(r.app, 'mine.txt'), 'utf8'), 'keep'); assert.deepEqual(walk(r.app), ['herdr-plugin.toml', 'mine.txt', 'scripts', 'scripts/standalone.sh']) }
  const r = await rig()
  const ran = plant(r)
  const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
  assert.equal(a.code, 1, a.all); assert.doesNotMatch(a.out, /install summary|replacing it with the new version/)
  assert.match(a.err, new RegExp(`^whosup: ${rx(r.app)} is there but is not a whosup install \\(no install record points at it\\)\\. Nothing in it was run or changed\\. Move it away and run this installer again\\.\\n$`))
  assert.equal(existsSync(ran), false, '그 안의 스크립트를 돌리지 않는다'); intact(r); assert.equal(existsSync(r.launcher), false); assert.equal(existsSync(r.loginFile), false)
  assert.equal(existsSync(join(r.data, 'install.lock')), false); assert.equal(existsSync(`${r.app}.new`), false)
  const ko = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_LANG: 'ko' })
  assert.equal(ko.code, 1); assert.match(ko.err, /폴더가 이미 있는데 whosup 설치가 아닙니다\(그 폴더를 가리키는 설치 기록이 없습니다\)\. 그 안의 것은 실행하지도 바꾸지도 않았습니다\./)
  // 기록이 있어도 이 제품의 것이 아니거나 다른 폴더를 가리키면 같다. 기록이 맞아도 그 폴더가 이 플러그인이 아니면(herdr-plugin.toml의 id) 같다
  for (const rec of [{ product: 'other', app: r.app }, { product: 'whosup', app: join(r.base, 'elsewhere', 'app') }, 'not json']) {
    writeFileSync(r.record, typeof rec === 'string' ? rec : JSON.stringify(rec))
    assert.equal((await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 1, JSON.stringify(rec)); assert.equal(existsSync(ran), false)
  }
  writeFileSync(r.record, JSON.stringify({ product: 'whosup', app: r.app })); writeFileSync(join(r.app, 'herdr-plugin.toml'), 'id = "someone.else"\n')
  assert.equal((await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 1); assert.equal(existsSync(ran), false); assert.equal(readFileSync(join(r.app, 'mine.txt'), 'utf8'), 'keep')
  // 기록이 온전하고 그 폴더를 가리키며 id까지 맞아도, 설치기의 표식이 없으면(또는 표식이 링크면) 설치가 아니다 — 설치 기록과 표식은 한 쌍이다
  const full = JSON.stringify({ product: 'whosup', id: 'fivetaku.whosup', data: r.data, app: r.app, conf: r.conf, state: r.state })
  writeFileSync(r.record, full); writeFileSync(join(r.app, 'herdr-plugin.toml'), 'id = "fivetaku.whosup"\n')
  const noMark = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
  assert.equal(noMark.code, 1, noMark.all); assert.match(noMark.err, /is there but is not a whosup install/); assert.equal(existsSync(ran), false); assert.equal(readFileSync(join(r.app, 'mine.txt'), 'utf8'), 'keep')
  writeFileSync(join(r.base, 'mark-elsewhere'), `${APP_MARK}\n`); symlinkSync(join(r.base, 'mark-elsewhere'), join(r.app, APP_MARK_FILE))
  assert.equal((await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 1, '표식이 링크다'); assert.equal(existsSync(ran), false); assert.equal(readFileSync(join(r.app, 'mine.txt'), 'utf8'), 'keep')
  assert.equal(readFileSync(r.record, 'utf8'), full, '기록도 건드리지 않는다'); assert.equal(existsSync(join(r.data, 'install.lock')), false)
  // 길을 고를 때도 그 폴더는 "이미 깔린 단독 설치"가 아니다: herdr가 있으면 플러그인 길로 가고, 그 폴더는 그대로다
  const p = await rig({ herdr: true })
  const ranP = plant(p)
  const b = await p.install()
  assert.equal(b.code, 0, b.all); assert.match(summaryOf(b.out), /Installed as a herdr plugin/); assert.doesNotMatch(b.out, /standalone whosup is also installed/); assert.equal(existsSync(ranP), false); intact(p)
  // 지우라고 해도(설치기 사본으로 부른다) 설치가 없다고 말하고 건드리지 않는다
  const un = await p.run('/bin/sh', [join(ROOT, 'scripts', 'standalone.sh'), 'uninstall', '--purge'])
  assert.equal(un.code, 1); assert.match(un.out, /^There is no standalone whosup install here\.\n$/); intact(p); assert.equal(existsSync(ranP), false)

  // app.new·app.old: 설치기가 만든 것(표식)일 때만 치운다. 남의 것이 그 자리에 있으면 그대로 두고 알린 뒤 1
  const n = await rig()
  mkdirSync(`${n.app}.new`, { recursive: true }); writeFileSync(join(`${n.app}.new`, 'keep.txt'), 'mine')
  const c = await n.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
  assert.equal(c.code, 1, c.all); assert.match(c.err, new RegExp(`whosup: ${rx(`${n.app}.new`)} is there and this installer did not put it there, so it was left as it is\\. Move it away and run this installer again\\. Nothing was changed\\.\\n$`))
  assert.equal(readFileSync(join(`${n.app}.new`, 'keep.txt'), 'utf8'), 'mine'); assert.equal(existsSync(n.app), false); assert.equal(existsSync(join(n.data, 'install.lock')), false)
  const o = await rig()
  try {
    assert.equal((await o.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 0); const pid = o.pid()
    mkdirSync(`${o.app}.old`); writeFileSync(join(`${o.app}.old`, 'keep.txt'), 'mine'); writeFileSync(join(o.app, 'OLD_VERSION'), 'old')
    const u = await o.whosup(['update'])
    assert.equal(u.code, 1, u.all); assert.match(u.err, /app\.old is there and this installer did not put it there/)
    assert.equal(readFileSync(join(`${o.app}.old`, 'keep.txt'), 'utf8'), 'mine'); assert.equal(readFileSync(join(o.app, 'OLD_VERSION'), 'utf8'), 'old'); assert.equal(o.pid(), pid, '보드도 끄지 않았다'); assert.equal(await o.health(), true)
    // 설치기가 남긴 것(표식이 있다)은 치우고 간다: 죽은 설치의 app.new
    renameSync(`${o.app}.old`, join(o.base, 'moved-away')); mkdirSync(`${o.app}.new`); writeFileSync(join(`${o.app}.new`, APP_MARK_FILE), `${APP_MARK}\n`); writeFileSync(join(`${o.app}.new`, 'half'), 'x')
    const u2 = await o.whosup(['update'])
    assert.equal(u2.code, 0, u2.all); assert.equal(existsSync(join(o.app, 'OLD_VERSION')), false); assert.equal(existsSync(join(o.app, 'half')), false); assert.equal(existsSync(`${o.app}.new`), false)
    await o.whosup(['stop'])
  } finally { o.cleanup() }
  // 끝내지 못한 설치가 남긴 앱 폴더(표식은 있고 설치 기록이 없다): 치우고 새로 설치한다(새 버전으로 교체가 아니다 — 보드를 켜고 로그인 항목을 등록하는 새 설치)
  const h = await rig()
  mkdirSync(h.app, { recursive: true }); writeFileSync(join(h.app, APP_MARK_FILE), `${APP_MARK}\n`); writeFileSync(join(h.app, 'half'), 'x')
  const d = await h.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
  assert.equal(d.code, 0, d.all); assert.match(d.out, /whosup: an install that did not finish left .* behind: removing it and installing again\n/)
  assert.match(summaryOf(d.out), /Installed on its own, without herdr \(standalone\)\./); assert.equal(existsSync(join(h.app, 'half')), false); assert.equal(JSON.parse(readFileSync(h.record, 'utf8')).app, h.app)
})

test('폴더 고정: 설치 때의 폴더(사용자 지정 XDG)를 설치 기록에 적어 두고, 나중에 다른 환경에서 불러도 같은 폴더를 쓴다 — 상대 경로·제어 문자가 든 XDG 값은 무시한다', posix, async () => {
  const r = await rig()
  try {
    const xdg = { XDG_DATA_HOME: join(r.base, 'xd'), XDG_STATE_HOME: join(r.base, 'xs'), XDG_CONFIG_HOME: join(r.base, 'xc') }
    const data = join(xdg.XDG_DATA_HOME, 'whosup'), app = join(data, 'app'), state = join(xdg.XDG_STATE_HOME, 'whosup')
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', ...xdg })
    assert.equal(a.code, 0, a.all); assert.equal(existsSync(join(app, 'bin', 'whosup.mjs')), true); assert.equal(existsSync(r.app), false)
    const rec = JSON.parse(readFileSync(join(data, 'install.json'), 'utf8'))
    assert.deepEqual([rec.data, rec.app, rec.state, rec.conf], [data, app, state, r.conf])
    const pid = r.pid(state); assert.ok(pid > 1); assert.equal(await r.health(r.port), true)
    // 로그인 항목은 표준 위치다(XDG_CONFIG_HOME 아래가 아니다 — 다음 로그인의 사용자 관리자는 그 값을 모른다)
    assert.equal(existsSync(r.loginFile), true); assert.equal(existsSync(join(xdg.XDG_CONFIG_HOME, 'systemd')), false)
    // 다른 환경(XDG 값이 없거나 다르다): 실행 명령은 설치 기록의 폴더를 쓴다 — 새 폴더를 만들지 않는다
    const drift = { XDG_DATA_HOME: undefined, XDG_STATE_HOME: join(r.base, 'elsewhere'), XDG_CONFIG_HOME: undefined }
    const st = await r.whosup(['status'], drift)
    assert.equal(st.code, 0, st.all); assert.match(st.out, new RegExp(`^whosup listening at http://127\\.0\\.0\\.1:${r.port} \\(pid ${pid}\\)\\n`))
    assert.equal((await r.whosup(['stop'], drift)).code, 0); assert.equal(await r.health(r.port), false)
    // 로그인 항목이 부르는 모양(환경이 거의 없다): 앱의 스크립트를 직접 불러도 같은 폴더에서 켜진다
    const login = await r.run('/bin/sh', [join(app, 'scripts', 'standalone.sh'), 'start'], { ...drift, WHOSUP_LOGIN_START: '1' })
    assert.equal(login.code, 0, login.all); assert.ok(r.pid(state) > 1); assert.notEqual(r.pid(state), pid); assert.equal(await r.health(r.port), true)
    assert.equal(existsSync(join(r.base, 'elsewhere')), false); assert.equal(existsSync(r.state), false); assert.equal(existsSync(join(r.home, '.local', 'state')), false); assert.equal(existsSync(r.data), false)
    // 새 버전으로 바꾸기도 같은 자리를 본다(다른 환경에서 불러도 두 번째 설치를 만들지 않는다)
    const u = await r.whosup(['update'], drift)
    assert.equal(u.code, 0, u.all); assert.match(u.out, new RegExp(`a standalone whosup is here \\(${rx(app)}\\)`)); assert.equal(existsSync(r.data), false); assert.equal(await r.health(r.port), true)
    // 지우기도 기록에 적힌 폴더를 지운다
    const un = await r.whosup(['uninstall', '--purge'], drift)
    assert.equal(un.code, 0, un.all); assert.equal(await r.health(r.port), false)
    assert.equal(existsSync(data), false); assert.equal(existsSync(state), false); assert.equal(existsSync(r.loginFile), false); assert.equal(existsSync(r.launcher), false)
  } finally { r.cleanup(); const pid = r.pid(join(r.base, 'xs', 'whosup')); if (pid > 1) { try { process.kill(pid, 'SIGTERM') } catch {} } }
  // 상대 경로(XDG_DATA_HOME=.)와 제어 문자가 든 값: 무시하고 기본 폴더에 깐다 — 지금 폴더(여기서는 <임시>)에 깔리지 않는다
  await Promise.all([{ XDG_DATA_HOME: '.', XDG_STATE_HOME: 'rel/state' }, { XDG_DATA_HOME: 'rel', XDG_STATE_HOME: '.' }, { XDG_DATA_HOME: '/tmp/a\nb', XDG_STATE_HOME: '/tmp/a\u0001b' }].map(async (bad) => {
    const b = await rig()
    const x = await b.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_AUTOSTART: '1', ...bad })
    assert.equal(x.code, 0, `${JSON.stringify(bad)}: ${x.all}`); assert.equal(existsSync(join(b.app, 'bin', 'whosup.mjs')), true, JSON.stringify(bad))
    const rec = JSON.parse(readFileSync(b.record, 'utf8'))
    assert.deepEqual([rec.data, rec.state], [b.data, join(b.home, '.local', 'state', 'whosup')], JSON.stringify(bad))
    assert.deepEqual(readdirSync(b.base).filter((n) => /^(whosup|rel|app)/.test(n)), [], '지금 폴더에는 아무것도 놓지 않는다')
    assert.equal((await b.whosup(['uninstall'], bad)).code, 0)
  }))
})

test('잠금: 다른 설치가 진행 중이면(install.lock — 주인의 PID) 알리고 1로 끝난다 — 주인이 살아 있으면 오래돼도 걷지 않고 죽었으면 걷는다. whosup uninstall·autostart도 같은 잠금을 잡는다', posix, async () => {
  const r = await rig()
  try {
    const lock = join(r.data, 'install.lock'), pidFile = join(lock, 'pid')
    const ago = (min) => { const t = new Date(Date.now() - min * 60 * 1000); utimesSync(lock, t, t) }
    mkdirSync(lock, { recursive: true }); writeFileSync(pidFile, `${process.pid}\n`)   // 살아 있는 주인(이 시험 프로세스)
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
    assert.equal(a.code, 1, a.all); assert.doesNotMatch(a.out, /install summary/)
    assert.match(a.err, new RegExp(`^whosup: another whosup install is running here \\(the lock ${rx(lock)} is held\\)\\. Wait for it to end, then run this again\\. Nothing was changed\\.\\n$`))
    assert.equal(readFileSync(pidFile, 'utf8'), `${process.pid}\n`, '남의 잠금은 풀지 않는다'); assert.deepEqual(readdirSync(r.data), ['install.lock']); assert.deepEqual(readdirSync(lock), ['pid'])
    const ko = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1', WHOSUP_LANG: 'ko' })
    assert.equal(ko.code, 1); assert.match(ko.err, /whosup: 다른 whosup 설치가 진행 중입니다\(잠금 .*install\.lock\)\. 그 설치가 끝난 뒤 다시 실행하세요\. 바꾼 것은 없습니다\./)
    // 주인이 살아 있으면 시간이 지나도 걷지 않는다(전에는 10분 넘은 잠금을 주인 확인 없이 걷었다): 11분 · 하루
    for (const min of [11, 24 * 60]) { ago(min); assert.equal((await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })).code, 1, `${min}분 된 잠금`); assert.equal(readFileSync(pidFile, 'utf8'), `${process.pid}\n`) }
    // 주인이 죽은 잠금: 방금 만들어진 것이어도 걷고 설치한다. 끝나면 자기 잠금을 푼다
    writeFileSync(pidFile, `${deadPid()}\n`); ago(0)
    const b = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
    assert.equal(b.code, 0, b.all); assert.equal(existsSync(lock), false, '끝나면 잠금을 푼다'); assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true)
    // 주인을 알 수 없는 잠금(pid 파일이 없다 · 읽을 수 없다): 시간으로만 본다 — 첫 실행 안내가 기다릴 수 있는 가장 긴 시간보다 넉넉한 6시간.
    // 1시간 된 것은 살아 있는 것으로 보고, 7시간 된 것은 걷는다. 새 버전으로 바꿀 때도 같은 잠금이다
    mkdirSync(lock); writeFileSync(join(r.app, 'OLD_VERSION'), 'old'); ago(60)
    const u = await r.whosup(['update'])
    assert.equal(u.code, 1); assert.match(u.err, /another whosup install is running here/); assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old')
    writeFileSync(pidFile, 'garbage\n'); ago(5 * 60); assert.equal((await r.whosup(['update'])).code, 1, '읽을 수 없는 pid 파일도 같다')
    // whosup uninstall · autostart on|off: 잠금이 잡혀 있으면 알리고 1 — 아무것도 바꾸지 않는다(읽기만 하는 status는 된다)
    writeFileSync(pidFile, `${process.pid}\n`)
    for (const argv of [['uninstall'], ['uninstall', '--purge'], ['autostart', 'off'], ['autostart', 'on']]) {
      const x = await r.whosup(argv, { WHOSUP_LANG: argv.length > 1 ? 'en' : 'ko' })
      assert.equal(x.code, 1, `${argv.join(' ')}: ${x.all}`)
      assert.match(x.out, argv.length > 1 ? /^Another whosup install or removal is running here \(the lock .*install\.lock is held\)\./ : /^whosup을 설치하거나 지우는 다른 작업이 진행 중입니다\(잠금 .*install\.lock\)\./, argv.join(' '))
    }
    assert.equal(existsSync(join(r.app, 'OLD_VERSION')), true); assert.equal(existsSync(r.record), true); assert.equal(existsSync(r.launcher), true); assert.equal(readFileSync(pidFile, 'utf8'), `${process.pid}\n`)
    assert.equal((await r.whosup(['autostart', 'status'])).code, 0)
    unlinkSync(pidFile); ago(7 * 60)
    const u2 = await r.whosup(['update'])
    assert.equal(u2.code, 0, u2.all); assert.equal(existsSync(join(r.app, 'OLD_VERSION')), false); assert.equal(existsSync(lock), false)
    // 지우기가 끝나면 잠금도 데이터 폴더도 남지 않는다
    const un = await r.whosup(['uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [])
  } finally { r.cleanup() }
})

test('끝내지 못한 설치가 남긴 앱 폴더(표식은 있는데 설치 기록과 한 쌍이 아니다): 그 폴더에서 켜진 보드를 끄고 로그인 항목을 해제한 뒤에만 치운다 — 끄지 못하면 폴더를 두고 알린 뒤 1로 끝난다', posix, async () => {
  const r = await rig()
  let stuck = null
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
    const pid = r.pid(); assert.ok(pid > 1)
    // 설치 기록이 사라졌다(지워졌거나 읽을 수 없게 됐다): 표식만 남은 폴더에서 보드가 돌고 있고 로그인 항목이 그 폴더를 가리킨다
    unlinkSync(r.record); writeFileSync(join(r.app, 'half'), 'x')
    const calls = r.ctlCalls().length
    const b = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(b.code, 0, b.all); assert.match(b.out, /whosup: an install that did not finish left .* behind: removing it and installing again\n/)
    assert.match(summaryOf(b.out), /Installed on its own, without herdr \(standalone\)\./)
    assert.equal(await until(() => gone(pid), 5000), true, '그 폴더에서 켜진 보드를 끈 뒤에 치웠다(돌고 있는 보드의 프로그램을 지우지 않는다)')
    assert.equal(existsSync(join(r.app, 'half')), false); assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).app, r.app)
    assert.equal(await r.health(), true, '새 설치의 보드가 켜졌다'); assert.notEqual(r.pid(), pid); assert.equal(existsSync(r.loginFile), true)
    // 로그인 항목이 그 폴더를 가리켰다: 치우기 전에 해제했다(그 뒤 새 설치가 다시 등록한다)
    const ctl = quiet(r.ctlCalls().slice(calls))
    assert.deepEqual(ctl, mac
      ? [`bootout gui/${process.getuid()}/dev.whosup.board`, `bootout gui/${process.getuid()}/dev.whosup.board`, `bootstrap gui/${process.getuid()} ${r.plist}`]
      : ['--user stop whosup.service', '--user disable whosup.service', '--user daemon-reload', '--user daemon-reload', '--user enable --now whosup.service'], ctl.join(' | '))
    // 끄지 못하는 보드(SIGTERM을 받고도 살아 있다): 폴더를 그대로 두고 손으로 할 일을 알린 뒤 1 — 받아 둔 새 버전과 잠금은 남기지 않는다
    assert.equal((await r.whosup(['stop'])).code, 0)
    unlinkSync(r.record)
    stuck = await stubborn(); writeFileSync(join(r.state, 'server.pid'), String(stuck.pid))
    for (const [lang, want] of [['en', /whosup: could not clear .*\/app safely \(the reason, if any was given, is above\): the board started from it could not be stopped, or its start-at-login entry could not be removed, so the folder was left as it is\. Stop that board, remove the folder yourself, then run this installer again\.\n$/], ['ko', /whosup: .*\/app 폴더를 안전하게 치우지 못했습니다.*폴더를 그대로 두었습니다\. 보드를 끄고 그 폴더를 직접 지운 뒤 이 설치 명령을 다시 실행하세요\.\n$/]]) {
      const c = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_LANG: lang })
      assert.equal(c.code, 1, c.all); assert.doesNotMatch(c.out, /install summary|설치 요약/); assert.match(c.err, want)
      assert.match(c.err, new RegExp(`still running pid=${stuck.pid}\\n`), '끄지 못한 까닭(그 명령이 한 말)도 보인다')
      assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true, '폴더는 그대로다'); assert.equal(gone(stuck.pid), false)
      assert.equal(existsSync(`${r.app}.new`), false); assert.equal(existsSync(join(r.data, 'install.lock')), false); assert.equal(existsSync(r.record), false); assert.equal(existsSync(r.loginFile), true)
    }
    // 그 보드가 끝난 뒤에는 치우고 새로 설치한다
    stuck.kill('SIGKILL'); unlinkSync(join(r.state, 'server.pid'))
    const d = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(d.code, 0, d.all); assert.equal(await r.health(), true)
    const un = await r.whosup(['uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [])
  } finally { try { stuck?.kill('SIGKILL') } catch {} r.cleanup() }
})

test('치우지 못한 새 설치: 마지막 단계가 끝나지 않았는데 놓은 것을 치울 수 없으면(로그인 항목이 서비스 관리자에 아직 살아 있다) 앱 폴더를 지우지 않고 남은 것을 알린 뒤 1로 끝난다', posix, async () => {
  const r = await rig()
  try {
    // 새 버전: 설치의 마지막 단계를 다 한 뒤(보드 · 로그인 항목 · 실행 명령 · 설치 기록) 실패로 끝난다
    const marker = "case 'install': return install(ctx)"
    const half = copyOf(r, 'half', (text) => { assert.ok(text.includes(marker)); return text.replace(marker, "case 'install': { await install(ctx); return 1 }") })
    // 서비스 관리자가 그 항목을 놓지 않는다: macOS는 bootout이, Linux는 disable이 실패하고 그 뒤에도 불려 있다(enabled)고 답한다
    const f = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: half, FAKE_CTL_FAIL: mac ? 'bootout' : 'disable' })
    assert.equal(f.code, 1, f.all)
    // 그 판의 uninstall이 멈춘 까닭이 보이고, "놓았던 것은 치웠다"고 말하지 않는다
    assert.match(f.err, new RegExp(`Could not turn off start at login: the service manager still has ${mac ? 'dev\\.whosup\\.board' : 'whosup\\.service'}\\. Turn it off yourself by typing this in a terminal, then run this again:\\n {4}${mac ? 'launchctl bootout gui/[0-9]+/dev\\.whosup\\.board' : 'systemctl --user disable whosup\\.service'}\\nThe program was not removed, so that your login does not call a program that is gone\\.\\n`))
    assert.match(f.err, /whosup: the install did not finish \(its last step ended with 1; what it said is above\)\.\nwhosup: what the install had put in place could not be fully removed \(the reason is above\), so .*\/app is still there\. Stop the board if it is running, remove it yourself \(sh .*\/app\/scripts\/standalone\.sh uninstall\), then run this installer again\.\n$/)
    assert.doesNotMatch(f.err, /What it had put in place was removed/)
    // 로그인 항목이 가리키는 프로그램은 그대로 있다(로그인 때 없는 스크립트를 부르지 않는다). 잠금은 풀었다
    assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true); assert.equal(existsSync(r.loginFile), true); assert.equal(existsSync(r.record), true)
    assert.equal(existsSync(join(r.data, 'install.lock')), false); assert.equal(await r.health(), false, '보드는 그 uninstall이 껐다')
    const ko = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: half, WHOSUP_LANG: 'ko', WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
    assert.equal(ko.code, 1, ko.all)   // 남은 것은 온전한 설치다(기록과 표식이 한 쌍): 다시 돌리면 새 버전으로 바꾸기로 가고, 실패하면 되돌린다
    assert.match(ko.err, /전에 쓰던 버전으로 되돌렸습니다/)
    // 서비스 관리자가 놓은 뒤에는 평소대로 지워진다
    const un = await r.whosup(['uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [])
  } finally { r.cleanup() }
})

test('update 되돌리기: 켜져 있던 보드가 새 버전에서 켜지지 않으면 이전 버전으로 되돌린다 — 이전 버전의 보드를 다시 켜지 못했거나 새 버전의 보드를 끄지 못했으면 "되돌렸다"고만 말하지 않고 그 사실을 알린다', posix, async () => {
  const r = await rig()
  let stuck = null
  try {
    const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true)
    writeFileSync(join(r.app, 'OLD_VERSION'), 'old')
    const marker = "case 'install': return install(ctx)"
    // (1) 새 버전의 보드가 켜지지 않는다: 마지막 단계가 0이 아닌 값으로 끝나고 설치기가 이전 버전으로 되돌려 그 보드를 다시 켠다(이전 버전을 지우지 않는다)
    const noBoard = copyOf(r, 'no-board', (text) => text); writeFileSync(join(noBoard, 'bin', 'whosup.mjs'), 'process.exit(3)\n')
    const u = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: noBoard })
    assert.equal(u.code, 1, u.all); assert.doesNotMatch(u.out, /install summary/)
    assert.match(u.out, /whosup: the board was running before the update and did not start in the new version \(log: .*server\.log\)\n/)
    assert.match(u.err, /whosup: the new version did not finish installing \(its last step ended with 1; what it said is above\), so the version that was here before is back in place\./)
    assert.doesNotMatch(u.err, /could not be started again/)
    assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old'); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(await r.health(), true, '이전 버전의 보드가 다시 켜졌다')
    // (2) 시간 초과로 끝난 마지막 단계(124)도 끝내지 못한 것이다: 되돌린다. 이전 버전의 보드를 다시 켜지 못했으면 그 사실을 알린다
    const sabotage = copyOf(r, 'sabotage', (text) => text.replace(marker, "case 'install': { (await import('node:fs')).writeFileSync(join(dirname(ROOT), 'app.old', 'bin', 'whosup.mjs'), 'process.exit(3)\\n'); return 124 }"))
    const t = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: sabotage })
    assert.equal(t.code, 1, t.all)
    assert.match(t.err, /whosup: the board that was running before could not be started again, so it is not running now\. Start it: whosup start\nwhosup: the new version did not finish installing \(its last step ended with 124; what it said is above\), so the version that was here before is back in place\./)
    assert.equal(readFileSync(join(r.app, 'OLD_VERSION'), 'utf8'), 'old', '이전 버전은 제자리에 있다'); assert.equal(existsSync(`${r.app}.old`), false); assert.equal(await r.health(), false)
    const tk = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: sabotage, WHOSUP_LANG: 'ko' })
    assert.equal(tk.code, 1); assert.doesNotMatch(tk.err, /다시 켜지 못했습니다/, '꺼져 있던 보드는 켜려 하지 않았다: 그 말을 하지 않는다'); assert.match(tk.err, /전에 쓰던 버전으로 되돌렸습니다/)
    writeFileSync(join(r.app, 'bin', 'whosup.mjs'), readFileSync(join(ROOT, 'bin', 'whosup.mjs')))
    assert.equal((await r.whosup(['start'])).code, 0); assert.equal(await r.health(), true)
    const ko = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: sabotage, WHOSUP_LANG: 'ko' })
    assert.equal(ko.code, 1); assert.match(ko.err, /whosup: 켜져 있던 보드를 다시 켜지 못했습니다\. 지금 보드는 꺼져 있습니다\. 켜세요: whosup start\nwhosup: 새 버전의 설치를 끝내지 못해\(마지막 단계 종료 코드 124/)
    writeFileSync(join(r.app, 'bin', 'whosup.mjs'), readFileSync(join(ROOT, 'bin', 'whosup.mjs')))
    assert.equal((await r.whosup(['start'])).code, 0)
    // (3) 새 버전이 켠 보드를 끄지 못한다: 돌고 있는 보드의 프로그램을 치우지 않는다 — 새 버전을 제자리에 두고, 이전 버전은 app.old에 남기고, 손으로 할 일을 알린다
    stuck = await stubborn()
    const sticky = copyOf(r, 'sticky', (text) => text.replace(marker, "case 'install': { (await import('node:fs')).writeFileSync(join(layout(ctx.env, ctx.home).state, 'server.pid'), process.env.STUBBORN_PID); return 1 }"))
    const s3 = await r.whosup(['update'], { WHOSUP_INSTALL_SOURCE: sticky, STUBBORN_PID: String(stuck.pid) })
    assert.equal(s3.code, 1, s3.all)
    assert.match(s3.err, /whosup: the new version did not finish installing \(its last step ended with 1; what it said is above\), and the version that was here before could not be put back: the board the new version started could not be stopped, so the new version was left in .*\/app\. Stop that board \(whosup stop\), move .*\/app away, move .*\/app\.old to .*\/app, then start the board \(whosup start\)\. Your settings and history are kept\.\n$/)
    assert.doesNotMatch(s3.err, /is back in place/)
    assert.equal(readFileSync(join(`${r.app}.old`, 'OLD_VERSION'), 'utf8'), 'old', '이전 버전은 app.old에 그대로 있다'); assert.equal(existsSync(join(r.app, 'OLD_VERSION')), false); assert.equal(existsSync(join(r.app, 'bin', 'whosup.mjs')), true)
    assert.equal(gone(stuck.pid), false); assert.equal(existsSync(join(r.data, 'install.lock')), false)
  } finally { try { stuck?.kill('SIGKILL') } catch {} try { unlinkSync(join(r.state, 'server.pid')) } catch {} r.cleanup() }
})

test('내려받기: curl이 실패하면 풀지 않고 그만둔다(파일로 받아 종료 코드를 본다) — git으로 받을 때는 브랜치·태그뿐 아니라 커밋 지정도 받는다', posix, async () => {
  // 네트워크에 닿지 않는다: curl·git은 가짜다. 소스를 주지 않으면(WHOSUP_INSTALL_SOURCE='') 내려받는 길로 간다
  const net = { WHOSUP_INSTALL_MODE: 'standalone', CI: '1', WHOSUP_INSTALL_SOURCE: '' }
  const r = await rig()
  exe(join(r.bin, 'curl'), '#!/bin/sh\necho "curl: (22) The requested URL returned error: 404" >&2\nexit 22\n')
  const a = await r.install({ ...net, WHOSUP_REF: 'no-such-ref' })
  assert.equal(a.code, 1, a.all); assert.match(a.err, /curl: \(22\) .*\nwhosup: could not get whosup's files \(github\.com\/fivetaku\/whosup\)\. Check the connection and run this installer again\. Nothing was changed\.\n$/)
  assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [], '받다 만 것을 남기지 않는다')
  // curl이 받아 온 파일을 푼다: 받는 곳은 설치기가 방금 만든 폴더 안의 파일이고, 푼 뒤에는 남기지 않는다
  const b = await rig()
  const tgz = join(b.base, 'src.tgz'), curlLog = join(b.base, 'curl.log')
  execFileSync('tar', ['-czf', tgz, '--exclude', '.git', '--exclude', 'node_modules', '-C', join(ROOT, '..'), basename(ROOT)])
  exe(join(b.bin, 'curl'), `#!/bin/sh\nprintf '%s\\n' "$*" >> ${shq(curlLog)}\nwhile [ $# -gt 0 ]; do if [ "$1" = -o ]; then cp ${shq(tgz)} "$2"; exit 0; fi; shift; done\nexit 2\n`)
  const c = await b.install({ ...net, WHOSUP_REF: '0123abc' })
  assert.equal(c.code, 0, c.all); assert.match(c.out, /whosup: downloading whosup \(0123abc\) from github\.com\/fivetaku\/whosup\n/)
  // 받는 곳은 이 실행만 쓰는 임시 폴더다(무작위 이름 — 고정된 이름 .whosup-download.tgz에 받지 않는다). 푼 뒤에는 남기지 않는다
  // https만 받는다(--proto · --proto-redir): 받는 곳과 돌려보내는 곳 모두
  assert.equal(lines(curlLog).length, 1); assert.match(lines(curlLog)[0], new RegExp(`^-fsSL --proto =https --proto-redir =https -o ${rx(b.app)}\\.new/\\.whosup-download-[A-Za-z0-9]{6}/src\\.tgz https://github\\.com/fivetaku/whosup/archive/0123abc\\.tar\\.gz$`))
  const c2 = await b.install({ ...net, WHOSUP_REF: '0123abc' })
  assert.equal(c2.code, 0, c2.all); assert.notEqual(lines(curlLog)[1], lines(curlLog)[0], '실행마다 이름이 다르다')
  assert.equal(existsSync(join(b.app, 'bin', 'whosup.mjs')), true); assert.deepEqual(readdirSync(b.app).filter((n) => n.startsWith('.whosup-download')), []); assert.equal(readFileSync(join(b.app, APP_MARK_FILE), 'utf8'), `${APP_MARK}\nstate=${b.state}\n`)
  // 표식을 둘 수 없는 판(받은 것 안에 표식과 같은 이름의 폴더가 있다): 제자리의 것을 바꾸기 전에 멈추고 받아 둔 폴더만 치운다 — 표식 없는 폴더를 놓지 않는다
  writeFileSync(join(b.app, 'OLD_VERSION'), 'old')
  const odd = join(b.base, 'odd'); cpSync(ROOT, odd, { recursive: true, filter: (p) => !['.git', 'node_modules', '.whosup'].includes(basename(p)) })
  mkdirSync(join(odd, APP_MARK_FILE)); writeFileSync(join(odd, APP_MARK_FILE, 'x'), '1')
  execFileSync('tar', ['-czf', tgz, '-C', b.base, 'odd'])
  const m = await b.install({ ...net })
  assert.equal(m.code, 1, m.all); assert.doesNotMatch(m.out, /install summary/)
  // (tar가 그 이름의 파일을 폴더로 바꿔 풀면 표식을 다시 두지 못해 멈추고, 풀기를 거절하면 받지 못한 것으로 멈춘다 — 어느 쪽이든 바꾸기 전이다)
  assert.match(m.err, /whosup: could not put the installer's mark in .*app\.new, so nothing was replaced\. Nothing was changed\.\n$|whosup: could not get whosup's files/)
  assert.equal(existsSync(`${b.app}.new`), false); assert.equal(readFileSync(join(b.app, 'OLD_VERSION'), 'utf8'), 'old'); assert.equal(existsSync(`${b.app}.old`), false); assert.equal(existsSync(join(b.data, 'install.lock')), false)
  // git: curl이 없는 기계. PATH는 필요한 도구만 든 폴더다(이 기계의 curl이 보이지 않게)
  const g = await rig()
  const tools = join(g.base, 'tools'); mkdirSync(tools)
  for (const t of ['uname', 'tr', 'awk', 'sed', 'grep', 'mkdir', 'rmdir', 'mv', 'rm', 'sort', 'ls', 'dirname', 'sh', 'cat', 'tar']) {
    const at = ['/usr/bin', '/bin'].map((d) => join(d, t)).find((f) => existsSync(f)); assert.ok(at, t); symlinkSync(at, join(tools, t))
  }
  const gitLog = join(g.base, 'git.log'), gitJs = join(g.base, 'fake-git.mjs')
  // 가짜 git: 받은 인자를 적고, checkout이면 이 저장소를 -C 가 가리키는 폴더로 복사한다
  writeFileSync(gitJs, `import { appendFileSync, cpSync } from 'node:fs'\nimport { basename } from 'node:path'\nconst a = process.argv.slice(2)\nappendFileSync(${JSON.stringify(gitLog)}, a.join(' ') + '\\n')\nif (a.includes('checkout')) cpSync(${JSON.stringify(ROOT)}, a[a.indexOf('-C') + 1], { recursive: true, filter: (p) => !['.git', 'node_modules', '.whosup'].includes(basename(p)) })\n`)
  exe(join(tools, 'git'), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(gitJs)} "$@"\n`)
  const sha = '4af4494c0ffee4af4494c0ffee4af4494c0ffee0'
  const d = await g.install({ ...net, WHOSUP_REF: sha, PATH: `${g.bin}:${tools}` })
  assert.equal(d.code, 0, d.all)
  assert.deepEqual(lines(gitLog), [`-C ${g.app}.new init --quiet`, `-C ${g.app}.new fetch --quiet --depth 1 https://github.com/fivetaku/whosup.git ${sha}`, `-C ${g.app}.new -c advice.detachedHead=false checkout --quiet FETCH_HEAD`])
  assert.equal(existsSync(join(g.app, 'bin', 'whosup.mjs')), true)
  // ref를 주지 않으면 기본 브랜치의 머리(HEAD)
  writeFileSync(gitLog, '')
  assert.equal((await g.install({ ...net, PATH: `${g.bin}:${tools}` })).code, 0); assert.match(lines(gitLog)[1], /fetch --quiet --depth 1 https:\/\/github\.com\/fivetaku\/whosup\.git HEAD$/)
})

test('Node 고르기: 앞쪽의 낡은 node가 뒤의 맞는 node를 가리지 않는다 — 설치 기록·실행 명령·로그인 항목은 고른 node의 절대 경로를 쓰고, 그 파일이 없어지면 다시 찾는다', posix, async () => {
  const r = await rig({ node: false })
  const LOW = '#!/bin/sh\ncase "$1" in -v | --version) echo v20.11.0; exit 0 ;; esac\nexit 1\n'
  exe(join(r.bin, 'node'), LOW)   // PATH의 맨 앞: -v는 답하지만 node:sqlite를 쓰지 못하는 낡은 node
  const good = join(r.base, 'good'); mkdirSync(good); symlinkSync(process.execPath, join(good, 'node'))
  const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_AUTOSTART: '1', PATH: `${r.bin}:${good}:/usr/bin:/bin` })
  assert.equal(a.code, 0, a.all); assert.match(a.out, new RegExp(`^whosup: node ${rx(process.version)} ok\\n`))
  assert.equal(JSON.parse(readFileSync(r.record, 'utf8')).node, join(good, 'node'))
  assert.ok(readFileSync(r.launcher, 'utf8').includes(`WHOSUP_NODE=${shq(join(good, 'node'))}\nexport WHOSUP_NODE\n`))
  const item = readFileSync(r.loginFile, 'utf8')
  assert.ok(item.includes(mac ? `<key>WHOSUP_NODE</key><string>${good}/node</string>` : `Environment="WHOSUP_NODE=${good}/node"`), item)
  assert.ok(item.includes(mac ? `<key>PATH</key><string>${good}:/usr/bin:/bin:/usr/sbin:/sbin</string>` : `Environment="PATH=${good}:/usr/bin:/bin:/usr/sbin:/sbin"`), '설치할 때의 PATH 전체(낡은 node의 폴더 포함)를 싣지 않는다')
  // 실행 명령: PATH에 낡은 node만 있어도 설치 때 고른 node로 돈다
  const pinned = await r.whosup(['help'], { PATH: `${r.bin}:/usr/bin:/bin` })
  assert.equal(pinned.code, 0, pinned.all); assert.match(pinned.out, /whosup uninstall \[--purge\]/)
  // 고른 node가 그 자리에서 낮아졌다(같은 경로에 낡은 node가 놓였다): 기록된 경로도 판 번호를 시험하고 다시 찾는다 — 다른 폴더의 맞는 node를 쓴다
  const alt = join(r.base, 'alt'); mkdirSync(alt); symlinkSync(process.execPath, join(alt, 'node'))
  unlinkSync(join(good, 'node')); exe(join(good, 'node'), LOW)
  const down = await r.whosup(['help'], { PATH: `${r.bin}:${alt}:/usr/bin:/bin` })
  assert.equal(down.code, 0, down.all); assert.match(down.out, /whosup uninstall \[--purge\]/)
  for (const shell of ['/bin/sh', '/bin/dash'].filter((x) => existsSync(x))) {
    const pick = (pinned, path) => execFileSync(shell, ['-c', '. "$1"; printf "%s" "$WHOSUP_NODE_PICK"', 'sh', join(ROOT, 'scripts', 'node-path.sh')], { env: { HOME: r.home, PATH: path, WHOSUP_EXTRA_PATH: '', WHOSUP_NODE_PINNED: pinned }, encoding: 'utf8' })
    assert.equal(pick(join(good, 'node'), `${r.bin}:${alt}:/usr/bin:/bin`), join(alt, 'node'), `${shell}: 낮아진 기록 대신 다시 찾은 node`)
    assert.equal(pick(join(alt, 'node'), `${r.bin}:/usr/bin:/bin`), join(alt, 'node'), `${shell}: 맞는 기록은 그대로 쓴다(다시 찾지 않는다)`)
    assert.equal(pick(join(r.base, 'no-such', 'node'), `${alt}:/usr/bin:/bin`), join(alt, 'node'), `${shell}: 없어진 기록`)
  }
  unlinkSync(join(good, 'node')); symlinkSync(process.execPath, join(good, 'node'))
  // 고른 node가 없어졌다(옮겨졌다): 다시 찾는다 — 낡은 node를 건너뛰고 다른 폴더의 맞는 node를 쓴다
  const moved = join(r.base, 'moved'); renameSync(good, moved)
  const found = await r.whosup(['help'], { PATH: `${r.bin}:${moved}:/usr/bin:/bin` })
  assert.equal(found.code, 0, found.all)
  // 맞는 node가 어디에도 없으면 찾은 node의 판 번호와 함께 알린다(이 기계의 /usr/bin·/bin에 node가 있으면 가려 둘 수 없어 건너뛴다)
  if (!existsSync('/usr/bin/node') && !existsSync('/bin/node')) {
    const none = await r.whosup(['help'], { PATH: `${r.bin}:/usr/bin:/bin` })
    assert.equal(none.code, 1); assert.match(none.err, /^whosup needs Node 22\.13 or newer \(found v20\.11\.0\)\./)
  }
  // scripts/node-path.sh(플러그인의 입구들도 읽는다): 맞는 node가 PATH의 첫 node가 아니면 그 폴더를 PATH 앞에 둔다. 첫 node가 맞으면 PATH는 그대로다
  const nodePath = join(ROOT, 'scripts', 'node-path.sh')
  for (const shell of ['/bin/sh', '/bin/dash'].filter((s) => existsSync(s))) {
    const src = (script, env) => execFileSync(shell, ['-c', `. "$1"; ${script}`, 'sh', nodePath], { env, encoding: 'utf8' })
    assert.equal(src('printf "%s|%s" "$WHOSUP_NODE_PICK" "$PATH"', { HOME: r.home, PATH: `${r.bin}:${moved}:/usr/bin:/bin`, WHOSUP_EXTRA_PATH: '' }), `${moved}/node|${moved}:${r.bin}:${moved}:/usr/bin:/bin`, shell)
    assert.equal(src('printf "%s|%s" "$WHOSUP_NODE_PICK" "$PATH"', { HOME: r.home, PATH: `${moved}:${r.bin}:/usr/bin:/bin`, WHOSUP_EXTRA_PATH: '' }), `${moved}/node|${moved}:${r.bin}:/usr/bin:/bin`, shell)
    assert.equal(src('printf "%s|%s" "$WHOSUP_NODE_PICK" "$WHOSUP_NODE_SEEN"', { HOME: r.home, PATH: `rel:.:${r.bin}`, WHOSUP_EXTRA_PATH: '' }), `|${r.bin}/node`, `${shell}: 맞는 것이 없으면 고르지 않는다(상대 경로 폴더는 보지 않는다)`)
    // 찾는 폴더의 순서: PATH와 덧붙인 폴더 → nvm(사전순이 아니라 판 번호가 높은 것부터) → fnm 기본 위치(있을 때만)
    const home = join(r.base, `nvm-${basename(shell)}`)
    for (const v of ['v9.0.0', 'v22.9.0', 'v22.13.0', 'v22.2.1', 'not-a-version']) mkdirSync(join(home, '.nvm', 'versions', 'node', v, 'bin'), { recursive: true })
    const fnm = join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin'); mkdirSync(fnm, { recursive: true }); symlinkSync(process.execPath, join(fnm, 'node'))
    const dirs = src('whosup_node_dirs; printf %s "$whosup_dirs"', { HOME: home, PATH: '/usr/bin:/bin' })
    const nvm = (v) => join(home, '.nvm', 'versions', 'node', v, 'bin')
    // 맨 뒤는 늘 whosup 전용 Node(<XDG_DATA_HOME 또는 ~/.local/share>/whosup/node/bin — install.sh가 쓸 만한 node가 없을 때만 놓는다)
    const own = join(home, '.local', 'share', 'whosup', 'node', 'bin')
    assert.ok(dirs.endsWith(`:${[nvm('v22.13.0'), nvm('v22.9.0'), nvm('v22.2.1'), nvm('v9.0.0'), fnm, own].join(':')}`), `${shell}: ${dirs}`)
    assert.ok(dirs.includes(`/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin:${home}/.local/bin:`), dirs); assert.doesNotMatch(dirs, /not-a-version/)
    // WHOSUP_EXTRA_PATH를 주면(시험) 그 밖의 폴더는 보지 않는다 — 전용 Node 자리만 맨 뒤에 남는다(XDG_DATA_HOME은 절대 경로일 때만)
    assert.equal(src('whosup_node_dirs; printf %s "$whosup_dirs"', { HOME: home, PATH: '/usr/bin:/bin', WHOSUP_EXTRA_PATH: '/x' }), `/usr/bin:/bin:/x:${own}`)
    assert.equal(src('whosup_node_dirs; printf %s "$whosup_dirs"', { HOME: home, PATH: '/usr/bin:/bin', WHOSUP_EXTRA_PATH: '/x', XDG_DATA_HOME: '/d' }), '/usr/bin:/bin:/x:/d/whosup/node/bin')
    assert.equal(src('whosup_node_dirs; printf %s "$whosup_dirs"', { HOME: home, PATH: '/usr/bin:/bin', WHOSUP_EXTRA_PATH: '/x', XDG_DATA_HOME: 'rel' }), `/usr/bin:/bin:/x:${own}`)
  }
  assert.equal((await r.whosup(['uninstall'], { PATH: `${r.bin}:${moved}:/usr/bin:/bin` })).code, 0)
})

test('PATH가 없는 환경과 dash: 설치기는 멈추지 않고 끝까지 돈다(unbound variable 없음) — sh -n 문법 검사 포함', posix, async () => {
  // PATH 없음(env -i 같은 실행): node는 덧붙인 폴더(WHOSUP_EXTRA_PATH)에서 찾는다
  const r = await rig()
  const a = await r.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1', PATH: undefined, WHOSUP_EXTRA_PATH: r.bin })
  assert.equal(a.code, 0, a.all); assert.doesNotMatch(a.all, /unbound variable|parameter not set/); assert.match(summaryOf(a.out), /Installed on its own, without herdr \(standalone\)\./)
  const p = await rig({ herdr: true })
  const b = await p.install({ PATH: undefined, WHOSUP_EXTRA_PATH: p.bin })
  assert.equal(b.code, 0, b.all); assert.match(summaryOf(b.out), /Installed as a herdr plugin/)
  // POSIX sh: 문법 검사(sh, 있으면 dash)와 dash로 돌린 단독 설치 → 새 버전으로 바꾸기 → 지우기
  const scripts = [INSTALL, ...['standalone.sh', 'node-path.sh', 'preflight.sh', 'plugin.sh'].map((f) => join(ROOT, 'scripts', f))]
  for (const shell of ['/bin/sh', '/bin/dash'].filter((s) => existsSync(s))) for (const f of scripts) execFileSync(shell, ['-n', f])
  if (!existsSync('/bin/dash')) return
  const d = await rig()
  try {
    const x = await d.run('/bin/dash', [INSTALL], { WHOSUP_INSTALL_MODE: 'standalone' })
    assert.equal(x.code, 0, x.all); assert.equal(await d.health(), true); assert.match(summaryOf(x.out), /Installed on its own, without herdr \(standalone\)\./)
    writeFileSync(join(d.app, 'OLD_VERSION'), 'old')
    const u = await d.run('/bin/dash', [INSTALL], {})
    assert.equal(u.code, 0, u.all); assert.match(summaryOf(u.out), /whosup updated to the new version/); assert.equal(existsSync(join(d.app, 'OLD_VERSION')), false); assert.equal(await d.health(), true)
    const un = await d.run('/bin/dash', [join(d.app, 'scripts', 'standalone.sh'), 'uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.deepEqual(walk(d.home).filter((f) => /whosup/.test(f)), [])
  } finally { d.cleanup() }
})

test('제거·자동 실행 끄기의 실패: 로그인 항목 파일을 지우지 못하면 남은 파일을 알리고 1로 끝난다 — 프로그램은 지우지 않는다', { skip: posix.skip || (notRoot ? false : 'root는 읽기 전용 폴더에도 쓴다') }, async () => {
  const r = await rig()
  try {
    assert.equal((await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 0)
    const dir = join(r.loginFile, '..')
    chmodSync(dir, 0o500)
    try {
      const off = await r.whosup(['autostart', 'off'])
      assert.equal(off.code, 1, off.all); assert.equal(off.out, `Could not turn off start at login. This file is still there: ${r.loginFile}. Remove it yourself, then run this again.\n`)
      const un = await r.whosup(['uninstall'], { WHOSUP_LANG: 'ko' })
      assert.equal(un.code, 1, un.all)
      assert.equal(un.out, `로그인할 때 자동으로 켜기를 끄지 못했습니다. 이 파일이 남아 있습니다: ${r.loginFile}. 직접 지운 뒤 다시 실행하세요.\n로그인할 때 없는 프로그램을 부르지 않게, 프로그램은 지우지 않았습니다.\n`)
      assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true, '로그인 항목이 부를 스크립트가 그대로 있다'); assert.equal(existsSync(r.launcher), true); assert.equal(existsSync(r.record), true)
    } finally { chmodSync(dir, 0o700) }
    // 고친 뒤에는 평소대로 지워진다
    const un = await r.whosup(['uninstall', '--purge'])
    assert.equal(un.code, 0, un.all); assert.deepEqual(walk(r.home).filter((p) => /whosup/.test(p)), [])
  } finally { r.cleanup() }
})
