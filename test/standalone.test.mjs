// 단독 설치(herdr 없이 — install.sh의 standalone 길)의 부품: 폴더 규칙, 실행 명령, 로그인할 때 자동으로 켜기, 제거, 마무리 문구, 첫 실행 안내의 단독 설치 갈래.
// 실제 launchctl·systemctl·herdr·/dev/tty에 닿지 않는다: 실행기·터미널·감지 결과·플랫폼을 주입하고, 폴더는 임시 폴더만 쓴다.
// 설치기를 실제로 돌리는 시험은 test/install.test.mjs.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { PIN_KEYS, configDirOf, dataDirOf, ownDir, standaloneDirs, stateDirOf, xdgDir } from '../src/paths.mjs'
import { TEXT, manifestId, readSetup, runSetup as runSetupRaw, standaloneLines, watchdogMsOf } from '../src/setup.mjs'
import {
  APP_MARK, APP_MARK_FILE, INSTALL_URL, LABEL, LAUNCHER_MARK, LOCK_GRACE_S, LOCK_NAME, RECORD_FILE, SERVICE, SERVICE_STOP_FLAG, appOwned, autostartStatus, boardNow, browserOpens,
  clearStaleLock, commandName, coreNotes, launcherState, launcherText, layout, nodeOf, pinEnv, plistText, readRecord, readRecordFile, registerAutostart, removeInstall, serviceVars, shown,
  standaloneEnv, standaloneFacts, stopService, supported, takeLock, unitText, unregisterAutostart, writeExclusive, writeLauncher, writeRecord,
} from '../src/standalone.mjs'
import { looksLikeInstaller, main as cli } from '../scripts/standalone.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const tmp = (name) => mkdtempSync(join(tmpdir(), `whosup-sa-${name}-`))
const isoEnv = (home, over = {}) => ({ HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_STATE_HOME: join(home, '.local', 'state'), PATH: '/usr/bin:/bin', ...over })
const touch = (file, text = '') => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, text) }
// 가짜 서비스 관리자: 받은 인자를 적고, 정한 답을 돌려준다(fail = 실패시킬 인자 줄).
// launchd가 지금 불러 둔 상태(loaded: bootstrap → true, bootout → false, print가 그것을 답한다)와 systemd의 active(enable --now·start → true,
// stop → false, is-active가 답한다)·enabled(enable → true, disable → false, is-enabled가 답한다)도 흉내 낸다.
const fakeCtl = ({ fail = [], loaded = false, active = false, enabled = false } = {}) => {
  const calls = []; const st = { loaded, active, enabled }
  const run = (bin, args) => {
    const a = args.join(' '); calls.push([bin, ...args].join(' '))
    if (fail.some((f) => a.includes(f))) return { ok: false, out: '' }
    if (args[0] === 'bootstrap') st.loaded = true
    if (args[0] === 'bootout') { const was = st.loaded; st.loaded = false; return { ok: was, out: '' } }
    if (args[0] === 'print') return { ok: st.loaded, out: '' }
    if (args.includes('is-active')) return { ok: st.active, out: '' }
    if (args.includes('is-enabled')) return { ok: st.enabled, out: '' }
    if (args.includes('enable')) st.enabled = true
    if (args.includes('disable')) st.enabled = false
    if (args.includes('enable') && args.includes('--now')) st.active = true
    if (args.includes('start')) st.active = true
    if (args.includes('stop')) st.active = false
    return { ok: true, out: '' }
  }
  return { calls, run, st }
}

test('폴더 규칙: 앱 <XDG_DATA_HOME 또는 ~/.local/share>/whosup/app, 설정 ~/.config/whosup, 상태 <XDG_STATE_HOME 또는 ~/.local/state>/whosup', () => {
  assert.equal(dataDirOf({}, '/h'), join('/h', '.local', 'share', 'whosup')); assert.equal(dataDirOf({ XDG_DATA_HOME: '/d' }, '/h'), join('/d', 'whosup'))
  const none = () => false
  assert.deepEqual(standaloneDirs({}, '/h', none), { conf: join('/h', '.config', 'whosup'), state: join('/h', '.local', 'state', 'whosup'), fresh: join('/h', '.local', 'state', 'whosup') })
  assert.equal(standaloneDirs({ XDG_STATE_HOME: '/s' }, '/h', none).state, join('/s', 'whosup'))
  // 이미 ~/.config/whosup에 whosup.db가 있는 사람(폴더에서 손으로 띄워 쓰던 사람): 상태 폴더를 옮기지 않고 그 폴더를 그대로 쓴다
  const legacyDb = join('/h', '.config', 'whosup', 'whosup.db')
  assert.equal(standaloneDirs({}, '/h', (p) => p === legacyDb).state, join('/h', '.config', 'whosup'))
  // 새 상태 폴더에 이미 whosup.db가 있으면 새 폴더가 이긴다
  assert.equal(standaloneDirs({}, '/h', () => true).state, join('/h', '.local', 'state', 'whosup'))
  const L = layout({ XDG_CONFIG_HOME: '/xc' }, '/h')
  assert.equal(L.app, join('/h', '.local', 'share', 'whosup', 'app')); assert.equal(L.launcher, join('/h', '.local', 'bin', 'whosup'))
  // systemd unit은 XDG_CONFIG_HOME이 아니라 표준 위치에 둔다: 다음 로그인의 사용자 관리자는 기본 위치만 본다
  assert.equal(L.plist, join('/h', 'Library', 'LaunchAgents', 'dev.whosup.board.plist')); assert.equal(L.unit, join('/h', '.config', 'systemd', 'user', 'whosup.service'))
  assert.equal(layout({}, '/h').unit, join('/h', '.config', 'systemd', 'user', 'whosup.service')); assert.equal(L.record, join('/h', '.local', 'share', 'whosup', 'install.json'))
  // XDG 값은 절대 경로일 때만 쓴다: 상대 경로(XDG_DATA_HOME=.)와 제어 문자가 든 값은 무시하고 기본값을 쓴다
  for (const bad of ['.', 'rel/dir', '', '/x\ny', '/x\u0001', '/x\ty']) {
    assert.equal(xdgDir(bad), '', JSON.stringify(bad))
    assert.equal(dataDirOf({ XDG_DATA_HOME: bad }, '/h'), join('/h', '.local', 'share', 'whosup'), JSON.stringify(bad))
    assert.equal(standaloneDirs({ XDG_STATE_HOME: bad }, '/h', none).state, join('/h', '.local', 'state', 'whosup'), JSON.stringify(bad))
  }
  assert.equal(xdgDir('/abs dir/x'), '/abs dir/x'); assert.equal(xdgDir(undefined), '')
  // 설치 기록의 폴더(고정 값)가 환경에 있으면 XDG 값보다 먼저다 — 설치한 뒤 XDG 값이 달라져도 같은 폴더를 쓴다
  // (기록의 설정·상태 경로는 후즈업 자신의 폴더일 때만 고정한다 — 설정은 그 사용자의 ~/.config/whosup, 상태는 마지막 마디가 whosup인 폴더:
  //  test/harden-installer.test.mjs가 아닌 경로를 본다)
  const ownConf = join('/h', '.config', 'whosup')
  const pinned = pinEnv({ XDG_DATA_HOME: '/other', XDG_STATE_HOME: '/other-state' }, { data: '/d/whosup', conf: ownConf, state: '/s/whosup' }, '/h')
  assert.deepEqual([pinned[PIN_KEYS.data], pinned[PIN_KEYS.conf], pinned[PIN_KEYS.state]], ['/d/whosup', ownConf, '/s/whosup'])
  const LP = layout(pinned, '/h')
  assert.deepEqual([LP.data, LP.app, LP.conf, LP.state], ['/d/whosup', join('/d/whosup', 'app'), ownConf, '/s/whosup'])
  assert.equal(standaloneEnv(pinned, '/h').HERDR_PLUGIN_STATE_DIR, '/s/whosup'); assert.equal(standaloneEnv(pinned, '/h').HERDR_PLUGIN_CONFIG_DIR, ownConf)
  // 기록이 없으면 물려받은 고정 값을 걷어 낸다(기록만이 그 값의 출처다)
  assert.deepEqual(Object.keys(pinEnv(pinned, null)).filter((k) => k.startsWith('WHOSUP_PIN_')), [])
  assert.throws(() => layout({}, 'relative'), /absolute/)
  // 실행 명령은 그 두 폴더를 HERDR_PLUGIN_*_DIR에 채워 기존 규칙(configDirOf·stateDirOf)을 그대로 쓴다 — 물려받은 값이 있어도 덮는다
  const home = tmp('env')
  const env = standaloneEnv({ HERDR_PLUGIN_CONFIG_DIR: '/herdr/conf', HERDR_PLUGIN_STATE_DIR: '/herdr/state', KEEP: '1' }, home)
  assert.equal(configDirOf(env, home), ownDir(home)); assert.equal(stateDirOf(env, home), join(home, '.local', 'state', 'whosup')); assert.equal(env.KEEP, '1')
  // 이름은 제품 이름에서 만든다
  assert.equal(LABEL, 'dev.whosup.board'); assert.equal(SERVICE, 'whosup.service')
})

test('실행 명령(~/.local/bin/whosup): 둘째 줄 표식, 남의 파일·링크는 건드리지 않는다, 사람이 칠 명령 이름', () => {
  assert.equal(LAUNCHER_MARK, '# whosup launcher, written by install.sh')
  const text = launcherText("/a b/it's/app")
  assert.deepEqual(text.split('\n').slice(0, 2), ['#!/bin/sh', LAUNCHER_MARK])
  assert.match(text, /^app='\/a b\/it'\\''s\/app'$/m, '경로는 작은따옴표로 싼다'); assert.match(text, /exec sh "\$app\/scripts\/standalone\.sh" "\$@"\n$/)
  const home = tmp('launcher')
  const L = layout(isoEnv(home), home)
  assert.equal(launcherState(L.launcher), 'none')
  assert.deepEqual(writeLauncher({ app: L.app, file: L.launcher }), { state: 'written', file: L.launcher })
  assert.equal(launcherState(L.launcher), 'ours'); assert.equal(statSync(L.launcher).mode & 0o777, 0o755); assert.equal(readFileSync(L.launcher, 'utf8'), launcherText(L.app))
  assert.deepEqual(readdirSync(L.bin), ['whosup'], '임시 파일을 남기지 않는다')
  assert.equal(writeLauncher({ app: L.app, file: L.launcher }).state, 'written', '우리 것은 다시 쓴다')
  // 설치 때 고른 node를 적는다: scripts/standalone.sh가 그것을 먼저 쓴다(WHOSUP_NODE). 주지 않으면 그 줄이 없다
  const pinnedText = launcherText('/x/app', "/n o'de/bin/node")
  assert.match(pinnedText, /^WHOSUP_NODE='\/n o'\\''de\/bin\/node'\nexport WHOSUP_NODE\nexec sh "\$app\/scripts\/standalone\.sh" "\$@"\n$/m); assert.doesNotMatch(text, /WHOSUP_NODE/)
  assert.equal(writeLauncher({ app: L.app, file: L.launcher, node: '/n/bin/node' }).state, 'written'); assert.equal(readFileSync(L.launcher, 'utf8'), launcherText(L.app, '/n/bin/node'))
  assert.equal(statSync(L.launcher).mode & 0o777, 0o755); assert.deepEqual(readdirSync(L.bin), ['whosup'])
  // 임시 파일: 무작위 이름을 배타적으로 만든다 — 예전의 예측할 수 있는 이름(.whosup.<pid>.tmp)에 남이 놓아 둔 링크를 따라 쓰지 않는다
  const victim = join(home, 'victim.txt'); writeFileSync(victim, 'untouched')
  symlinkSync(victim, join(L.bin, `.whosup.${process.pid}.tmp`)); symlinkSync(victim, `${L.launcher}.${process.pid}.tmp`)
  assert.equal(writeLauncher({ app: L.app, file: L.launcher }).state, 'written'); assert.equal(readFileSync(victim, 'utf8'), 'untouched')
  // writeExclusive: 쓴 파일은 0600(실행 명령만 0755), 폴더에 임시 파일을 남기지 않는다
  const ex = join(home, 'ex', 'file.txt'); writeExclusive(ex, 'one'); writeExclusive(ex, 'two')
  assert.equal(readFileSync(ex, 'utf8'), 'two'); assert.equal(statSync(ex).mode & 0o777, 0o600); assert.deepEqual(readdirSync(join(home, 'ex')), ['file.txt'])
  // 남의 파일: 그대로 둔다
  const other = tmp('foreign'); const LO = layout(isoEnv(other), other)
  touch(LO.launcher, '#!/bin/sh\necho mine\n')
  assert.equal(launcherState(LO.launcher), 'foreign'); assert.equal(writeLauncher({ app: LO.app, file: LO.launcher }).state, 'foreign')
  assert.equal(readFileSync(LO.launcher, 'utf8'), '#!/bin/sh\necho mine\n')
  // 링크: 가리키는 것이 우리 것이어도 남의 것으로 본다
  const linked = tmp('link'); const LL = layout(isoEnv(linked), linked)
  mkdirSync(LL.bin, { recursive: true }); symlinkSync(L.launcher, LL.launcher)
  assert.equal(launcherState(LL.launcher), 'foreign'); assert.equal(writeLauncher({ app: LL.app, file: LL.launcher }).state, 'foreign')

  // 사람이 칠 명령: PATH에서 whosup이 우리 실행 명령이면 whosup, PATH에 없으면 전체 경로, 다른 프로그램이 먼저면 전체 경로, 남의 파일이면 긴 명령
  assert.deepEqual(commandName(L, { WHOSUP_USER_PATH: `/usr/bin:${L.bin}`, PATH: '/usr/bin' }), { cmd: 'whosup' })
  assert.deepEqual(commandName(L, { PATH: `/usr/bin:${L.bin}` }), { cmd: 'whosup' }, 'WHOSUP_USER_PATH가 없으면 PATH')
  assert.deepEqual(commandName(L, { WHOSUP_USER_PATH: '/usr/bin', PATH: `/usr/bin:${L.bin}` }), { cmd: shown(L.launcher), why: 'path' }, '사람의 PATH에 없다(스크립트가 덧붙인 PATH는 보지 않는다)')
  const shadow = tmp('shadow'); touch(join(shadow, 'whosup'), '#!/bin/sh\n')
  assert.deepEqual(commandName(L, { WHOSUP_USER_PATH: `${shadow}:${L.bin}` }), { cmd: shown(L.launcher), why: 'shadowed', other: join(shadow, 'whosup') })
  assert.deepEqual(commandName(LO, { WHOSUP_USER_PATH: LO.bin }), { cmd: `sh ${shown(join(LO.app, 'scripts', 'standalone.sh'))}`, why: 'foreign' })
  // 적는 모양: 흔한 글자뿐이면 그대로, 공백·따옴표·ASCII가 아닌 글자가 있으면 작은따옴표로 싼다(그대로 붙여 넣어도 한 낱말이다)
  assert.equal(shown('/h/.local/bin/whosup'), '/h/.local/bin/whosup'); assert.equal(shown('/my home/x'), "'/my home/x'"); assert.equal(shown("/it's/x"), "'/it'\\''s/x'"); assert.equal(shown('/홈/x'), "'/홈/x'")
  const spaced = layout({}, join(tmp('sp'), 'my home'))
  assert.match(commandName(spaced, {}).cmd, /^sh '.*my home.*standalone\.sh'$/, '공백이 든 경로는 따옴표로 싼다')
})

test('로그인 항목의 글자: plist(XML 이스케이프·RunAtLoad·AbandonProcessGroup)와 systemd unit(oneshot·ExecStop·이스케이프)', () => {
  // 싣는 것은 필요한 최소다: 설치 때 고른 node(WHOSUP_NODE)와 그 폴더 + 시스템 기본 폴더(PATH), 절대 경로인 XDG 폴더.
  // 등록할 때의 PATH 전체는 싣지 않는다(그때만 있던 폴더·"."이 로그인 때마다 node를 찾는 길이 되지 않게)
  const vars = serviceVars({ PATH: '.:/tmp/writable:/a&b:/usr/bin', WHOSUP_NODE: '/a&b/node', XDG_STATE_HOME: '/s<1>', XDG_DATA_HOME: '', XDG_CONFIG_HOME: 'relative', HOME: '/h', SECRET: 'x' })
  assert.deepEqual(vars, { PATH: '/a&b:/usr/bin:/bin:/usr/sbin:/sbin', XDG_STATE_HOME: '/s<1>', WHOSUP_NODE: '/a&b/node', WHOSUP_LOGIN_START: '1' })
  assert.equal(nodeOf({ WHOSUP_NODE: '/n/node' }), '/n/node'); assert.equal(nodeOf({ WHOSUP_NODE: 'node' }), process.execPath, '절대 경로가 아니면 지금 이 node')
  assert.equal(serviceVars({}).WHOSUP_NODE, process.execPath); assert.equal(serviceVars({ WHOSUP_NODE: '/usr/bin/node' }).PATH, '/usr/bin:/bin:/usr/sbin:/sbin')
  const plist = plistText({ app: '/d/who & <sup>/app', state: '/s/whosup', vars })
  assert.match(plist, /<key>Label<\/key><string>dev\.whosup\.board<\/string>/)
  assert.match(plist, /<key>ProgramArguments<\/key><array><string>\/bin\/sh<\/string><string>\/d\/who &amp; &lt;sup&gt;\/app\/scripts\/standalone\.sh<\/string><string>start<\/string><\/array>/)
  assert.match(plist, /<key>PATH<\/key><string>\/a&amp;b:\/usr\/bin:\/bin:\/usr\/sbin:\/sbin<\/string>/); assert.match(plist, /<key>XDG_STATE_HOME<\/key><string>\/s&lt;1&gt;<\/string>/)
  assert.match(plist, /<key>WHOSUP_NODE<\/key><string>\/a&amp;b\/node<\/string>/)
  assert.match(plist, /<key>WHOSUP_LOGIN_START<\/key><string>1<\/string>/, '로그인할 때의 start는 브라우저를 열지 않는다')
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/); assert.match(plist, /<key>AbandonProcessGroup<\/key><true\/>/)
  assert.match(plist, /<key>StandardOutPath<\/key><string>\/s\/whosup\/autostart\.log<\/string>/); assert.doesNotMatch(plist, /KeepAlive/)
  assert.doesNotMatch(plist.replace(/&(amp|lt|gt);/g, ''), /&|<sup>/, '값의 &·<·>는 모두 바꿔 싣는다')

  const unit = unitText({ app: '/d/50% "q" $HOME/app', vars: { PATH: '/x:%y', WHOSUP_LOGIN_START: '1' } })
  assert.match(unit, /^Type=oneshot$/m); assert.match(unit, /^RemainAfterExit=yes$/m); assert.match(unit, /^WantedBy=default\.target$/m)
  assert.match(unit, /^Environment="PATH=\/x:%%y"$/m); assert.match(unit, /^Environment="WHOSUP_LOGIN_START=1"$/m)
  assert.ok(unit.includes('ExecStart="/bin/sh" "/d/50%% \\"q\\" $$HOME/app/scripts/standalone.sh" start\n'), unit)
  // ExecStop의 stop에는 --service가 붙는다: 서비스 관리자가 부른 stop은 보드만 끈다(whosup stop → 서비스 멈춤 → stop 의 되풀이를 막는다)
  assert.equal(SERVICE_STOP_FLAG, '--service')
  assert.ok(unit.includes('ExecStop="/bin/sh" "/d/50%% \\"q\\" $$HOME/app/scripts/standalone.sh" stop --service\n'), unit)
})

test('로그인할 때 자동으로 켜기(macOS): plist를 쓰고 launchctl bootout → bootstrap gui/<uid>, 해제는 bootout 뒤 파일 삭제', () => {
  const home = tmp('mac'); const env = isoEnv(home, { WHOSUP_LAUNCHCTL: '/fake/launchctl' })
  const L = layout(env, home)
  const ctl = fakeCtl()
  assert.deepEqual(autostartStatus({ env, home, platform: 'darwin', run: ctl.run }), { state: 'off' })
  const r = registerAutostart({ env, home, platform: 'darwin', run: ctl.run, uid: 501 })
  assert.deepEqual(r, { state: 'on', file: L.plist, loaded: true })
  assert.deepEqual(ctl.calls, ['/fake/launchctl bootout gui/501/dev.whosup.board', `/fake/launchctl bootstrap gui/501 ${L.plist}`])
  assert.equal(readFileSync(L.plist, 'utf8'), plistText({ app: L.app, state: L.state, vars: serviceVars(env) }))
  assert.deepEqual(readdirSync(join(home, 'Library', 'LaunchAgents')), ['dev.whosup.board.plist'], '임시 파일을 남기지 않는다')
  assert.equal(statSync(L.plist).mode & 0o777, 0o600, '로그인 항목 파일은 0600')
  // 상태: launchd에 실제로 불려 있는지 묻는다(launchctl print) — 불려 있으면 loaded: true
  assert.deepEqual(autostartStatus({ env, home, platform: 'darwin', run: ctl.run, uid: 501 }), { state: 'on', file: L.plist, loaded: true })
  assert.equal(ctl.calls.at(-1), '/fake/launchctl print gui/501/dev.whosup.board')
  // 지금 불러 두지 않기(보드를 켜지 않기로 한 설치): 파일만 둔다 — 다음 로그인부터 켜진다
  const quiet = fakeCtl()
  assert.deepEqual(registerAutostart({ env, home, platform: 'darwin', run: quiet.run, uid: 501, activate: false }), { state: 'on', file: L.plist, loaded: false })
  assert.deepEqual(quiet.calls, [])
  // bootstrap이 안 돼도(화면 세션이 없는 SSH) 파일은 남는다: 등록은 된 것이다(다음 로그인부터 켜진다).
  // 다만 "불러 두지 않기로 한 것"(위)과 구분된다 — loadFailed: 지금 바로 불러 두지는 못했다
  const ssh = fakeCtl({ fail: ['bootstrap'] })
  assert.deepEqual(registerAutostart({ env, home, platform: 'darwin', run: ssh.run, uid: 501 }), { state: 'on', file: L.plist, loaded: false, loadFailed: true })
  assert.deepEqual(ssh.calls, ['/fake/launchctl bootout gui/501/dev.whosup.board', `/fake/launchctl bootstrap gui/501 ${L.plist}`]); assert.equal(existsSync(L.plist), true)
  assert.deepEqual(autostartStatus({ env, home, platform: 'darwin', run: ssh.run }), { state: 'on', file: L.plist, loaded: false }, '등록 상태는 켜짐이다. 다만 지금 불려 있지는 않다(다음 로그인부터)')
  // 기본 실행기 이름은 launchctl
  const def = fakeCtl(); registerAutostart({ env: isoEnv(home), home, platform: 'darwin', run: def.run, uid: 7 })
  assert.match(def.calls[0], /^launchctl bootout gui\/7\//)
  // 해제
  const off = fakeCtl()
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'darwin', run: off.run, uid: 501 }), { state: 'off', removed: true, file: L.plist })
  // bootout의 답만 믿지 않는다: launchd가 그 항목을 놓았는지 다시 묻는다(print)
  assert.deepEqual(off.calls, ['/fake/launchctl bootout gui/501/dev.whosup.board', '/fake/launchctl print gui/501/dev.whosup.board']); assert.equal(existsSync(L.plist), false)
  // bootout이 안 됐고 launchd가 그 항목을 아직 불러 두었다: 꺼졌다고 말하지 않는다 — 'failed'와 손으로 칠 명령, 파일은 그대로 둔다(다시 돌리면 다시 내린다)
  const stuck = fakeCtl({ fail: ['bootout'] })
  assert.equal(registerAutostart({ env, home, platform: 'darwin', run: stuck.run, uid: 501 }).loaded, true)
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'darwin', run: stuck.run, uid: 501, waitMs: 0 }),
    { state: 'failed', removed: false, file: L.plist, left: [L.plist], live: 'dev.whosup.board', fix: 'launchctl bootout gui/501/dev.whosup.board' })
  assert.equal(existsSync(L.plist), true); assert.equal(stuck.calls.at(-1), '/fake/launchctl print gui/501/dev.whosup.board')
  // launchd가 조금 뒤에 놓는 경우: waitMs 동안 다시 물어 본다
  let asked = 0
  const slow = (bin, args) => (args[0] === 'print' ? { ok: ++asked < 2, out: '' } : { ok: true, out: '' })
  assert.equal(unregisterAutostart({ env, home, platform: 'darwin', run: slow, uid: 501, waitMs: 2000 }).state, 'off'); assert.equal(asked, 2); assert.equal(existsSync(L.plist), false)
  const again = fakeCtl()
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'darwin', run: again.run, uid: 501 }), { state: 'off', removed: false }); assert.deepEqual(again.calls, [], '등록된 것이 없으면 아무것도 부르지 않는다')
  // 해제의 결과는 파일이 실제로 없어졌는지로 본다: 지우지 못하면(폴더에 쓸 수 없음) 'failed'와 남은 파일을 돌려준다
  if (process.getuid?.() !== 0) {
    registerAutostart({ env, home, platform: 'darwin', run: fakeCtl().run, uid: 501, activate: false })
    chmodSync(join(home, 'Library', 'LaunchAgents'), 0o500)
    try { assert.deepEqual(unregisterAutostart({ env, home, platform: 'darwin', run: fakeCtl().run, uid: 501 }), { state: 'failed', removed: false, file: L.plist, left: [L.plist] }) } finally { chmodSync(join(home, 'Library', 'LaunchAgents'), 0o700) }
    assert.equal(unregisterAutostart({ env, home, platform: 'darwin', run: fakeCtl().run, uid: 501 }).state, 'off')
  }
  // 줄 바꿈·XML 1.0에 없는 제어 문자·짝 없는 서러게이트가 든 값은 싣지 않는다(아무것도 쓰지 않는다)
  for (const bad of ['\n', '\r', '\u0000', '\u0001', '\u0008', '\u000b', '\u000c', '\u001f', '\ufffe', '\uffff', '\ud800']) {
    const odd = join(tmp('odd'), `a${bad}b`)
    assert.equal(registerAutostart({ env: isoEnv(odd), home: odd, platform: 'darwin', run: fakeCtl().run }).state, 'failed', JSON.stringify(bad))
    assert.equal(registerAutostart({ env: isoEnv(odd), home: odd, platform: 'linux', run: fakeCtl().run }).state, 'failed', JSON.stringify(bad))
    assert.equal(existsSync(odd), false)
  }
  assert.equal(existsSync(L.plist), false)
  assert.equal(registerAutostart({ env: isoEnv(join(home, 'tab\there')), home: join(home, 'tab\there'), platform: 'darwin', run: fakeCtl().run, activate: false }).state, 'on', '탭은 XML에 실을 수 있다')
})

test('로그인할 때 자동으로 켜기(Linux): systemd --user 서비스 — 없으면 등록하지 않는다, 실패는 실패로 돌려준다', () => {
  const home = tmp('linux'); const env = isoEnv(home, { WHOSUP_SYSTEMCTL: '/fake/systemctl' })
  const L = layout(env, home)
  // systemd --user가 없다: 아무것도 쓰지 않고 'none'
  const none = fakeCtl({ fail: ['show-environment'] })
  assert.deepEqual(registerAutostart({ env, home, platform: 'linux', run: none.run }), { state: 'none' })
  assert.deepEqual(none.calls, ['/fake/systemctl --user show-environment']); assert.equal(existsSync(L.unit), false)
  assert.deepEqual(autostartStatus({ env, home, platform: 'linux', run: none.run }), { state: 'none' })
  // 있다: unit을 쓰고 daemon-reload → enable --now
  const ctl = fakeCtl()
  assert.deepEqual(registerAutostart({ env, home, platform: 'linux', run: ctl.run }), { state: 'on', file: L.unit, loaded: true })
  assert.deepEqual(ctl.calls, ['/fake/systemctl --user show-environment', '/fake/systemctl --user daemon-reload', '/fake/systemctl --user enable --now whosup.service'])
  assert.equal(readFileSync(L.unit, 'utf8'), unitText({ app: L.app, vars: serviceVars(env) })); assert.equal(L.unit, join(home, '.config', 'systemd', 'user', 'whosup.service'))
  assert.equal(statSync(L.unit).mode & 0o777, 0o600); assert.deepEqual(readdirSync(join(home, '.config', 'systemd', 'user')), ['whosup.service'], '임시 파일을 남기지 않는다')
  // XDG_CONFIG_HOME이 다른 곳이어도 unit은 표준 위치에 둔다(다음 로그인의 사용자 관리자는 그 값을 모른다)
  const custom = tmp('linux-xdg'); const customEnv = isoEnv(custom, { XDG_CONFIG_HOME: join(custom, 'cfg'), WHOSUP_SYSTEMCTL: '/fake/systemctl' })
  assert.equal(registerAutostart({ env: customEnv, home: custom, platform: 'linux', run: fakeCtl().run }).file, join(custom, '.config', 'systemd', 'user', 'whosup.service'))
  assert.equal(existsSync(join(custom, 'cfg')), false)
  assert.deepEqual(autostartStatus({ env, home, platform: 'linux', run: ctl.run }), { state: 'on', file: L.unit })
  assert.equal(autostartStatus({ env, home, platform: 'linux', run: fakeCtl({ fail: ['is-enabled'] }).run }).state, 'off')
  // 지금 켜지 않기: enable만(--now 없음)
  const quiet = fakeCtl()
  assert.equal(registerAutostart({ env, home, platform: 'linux', run: quiet.run, activate: false }).loaded, false)
  assert.equal(quiet.calls.at(-1), '/fake/systemctl --user enable whosup.service')
  // enable 실패: 설치 실패가 아니라 'failed'를 돌려준다(던지지 않는다)
  assert.equal(registerAutostart({ env, home, platform: 'linux', run: fakeCtl({ fail: ['enable'] }).run }).state, 'failed')
  // 해제: disable(보드는 끄지 않는다 — --now 없음) → 파일 삭제 → daemon-reload
  const off = fakeCtl()
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'linux', run: off.run }), { state: 'off', removed: true, file: L.unit })
  // disable의 답만 믿지 않는다: 사용자 관리자가 아직 enabled라고 하는지 다시 묻는다(is-enabled)
  assert.deepEqual(off.calls, ['/fake/systemctl --user disable whosup.service', '/fake/systemctl --user is-enabled --quiet whosup.service', '/fake/systemctl --user daemon-reload']); assert.equal(existsSync(L.unit), false)
  // disable이 안 됐다(사용자 관리자에 닿지 못함 — is-enabled도 답하지 못한다): enable이 만든 링크를 직접 지우고, 파일이 다 없어졌으면 꺼진 것이다(파일 기준)
  registerAutostart({ env, home, platform: 'linux', run: fakeCtl().run })
  const link = join(home, '.config', 'systemd', 'user', 'default.target.wants', 'whosup.service'); touch(link, '')
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'linux', run: fakeCtl({ fail: ['disable', 'is-enabled'] }).run }), { state: 'off', removed: true, file: L.unit })
  assert.equal(existsSync(L.unit), false); assert.equal(existsSync(link), false)
  // disable이 안 됐는데 사용자 관리자는 여전히 enabled라고 답한다: 꺼졌다고 말하지 않는다 — 'failed'와 손으로 칠 명령, unit 파일은 그대로 둔다
  const stuck = fakeCtl({ fail: ['disable'] })
  registerAutostart({ env, home, platform: 'linux', run: stuck.run })
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'linux', run: stuck.run, waitMs: 0 }),
    { state: 'failed', removed: false, file: L.unit, left: [L.unit], live: 'whosup.service', fix: 'systemctl --user disable whosup.service' })
  assert.equal(existsSync(L.unit), true); assert.equal(unregisterAutostart({ env, home, platform: 'linux', run: fakeCtl({ enabled: true }).run }).state, 'off')
  // 파일을 지우지 못했다: 'failed'와 남은 파일
  if (process.getuid?.() !== 0) {
    registerAutostart({ env, home, platform: 'linux', run: fakeCtl().run })
    chmodSync(join(home, '.config', 'systemd', 'user'), 0o500)
    try { assert.deepEqual(unregisterAutostart({ env, home, platform: 'linux', run: fakeCtl().run }), { state: 'failed', removed: false, file: L.unit, left: [L.unit] }) } finally { chmodSync(join(home, '.config', 'systemd', 'user'), 0o700) }
    assert.equal(unregisterAutostart({ env, home, platform: 'linux', run: fakeCtl().run }).state, 'off')
  }
  // 서비스 멈추기(whosup stop이 부른다): active일 때만 stop을 부르고, 멈췄는지 is-active로 다시 묻는다. macOS에서는 아무것도 부르지 않는다
  const act = fakeCtl({ active: true })
  assert.deepEqual(stopService({ env, platform: 'linux', run: act.run }), { asked: true, ok: true })
  assert.deepEqual(act.calls, ['/fake/systemctl --user is-active --quiet whosup.service', '/fake/systemctl --user stop whosup.service', '/fake/systemctl --user is-active --quiet whosup.service']); assert.equal(act.st.active, false)
  const idle = fakeCtl()
  assert.deepEqual(stopService({ env, platform: 'linux', run: idle.run }), { asked: false, ok: true }); assert.deepEqual(idle.calls, ['/fake/systemctl --user is-active --quiet whosup.service'])
  // stop이 안 먹었다(여전히 active): 실패로 돌려준다 — 부른 쪽이 알린다
  const held = fakeCtl({ active: true, fail: ['--user stop'] })
  assert.deepEqual(stopService({ env, platform: 'linux', run: held.run }), { asked: true, ok: false, fix: 'systemctl --user stop whosup.service' })
  const macCtl = fakeCtl({ active: true })
  assert.deepEqual(stopService({ env, platform: 'darwin', run: macCtl.run }), { asked: false, ok: true }); assert.deepEqual(macCtl.calls, [])
  // 그 밖의 POSIX(서비스 관리자를 모른다): 등록하지 않는다
  assert.deepEqual(registerAutostart({ env, home, platform: 'freebsd', run: fakeCtl().run }), { state: 'none' })
})

test('Windows: 단독 설치를 지원하지 않는다 — 아무것도 쓰지 않고 분명히 돌려준다', async () => {
  const home = tmp('win'); const env = isoEnv(home)
  assert.equal(supported('win32'), false); assert.equal(supported('darwin'), true); assert.equal(supported('linux'), true)
  const ctl = fakeCtl()
  assert.deepEqual(registerAutostart({ env, home, platform: 'win32', run: ctl.run }), { state: 'unsupported' })
  assert.deepEqual(unregisterAutostart({ env, home, platform: 'win32', run: ctl.run }), { state: 'unsupported' })
  assert.deepEqual(autostartStatus({ env, home, platform: 'win32', run: ctl.run }), { state: 'unsupported' })
  assert.equal(removeInstall({ env, home, platform: 'win32', purge: true }).state, 'unsupported')
  assert.deepEqual(ctl.calls, []); assert.deepEqual(readdirSync(home), [])
  // 명령 줄: 어떤 명령이든 지원하지 않는다고 알리고 herdr 플러그인 설치 명령을 보여 준 뒤 1로 끝난다(help만 된다)
  for (const lang of ['en', 'ko']) {
    for (const cmd of ['start', 'install', 'update', 'uninstall', 'autostart', 'setup', 'status']) {
      const out = []
      assert.equal(await cli([cmd], { ...env, WHOSUP_LANG: lang }, { log: (l) => out.push(l), platform: 'win32', home }), 1, cmd)
      assert.deepEqual(out, [TEXT[lang].saWindows, '    herdr plugin install fivetaku/whosup --yes'], cmd)
    }
  }
  assert.match(TEXT.en.saWindows, /does not support Windows/); assert.match(TEXT.ko.saWindows, /Windows를 지원하지 않습니다/)
  const help = []
  assert.equal(await cli(['help'], env, { log: (l) => help.push(l), platform: 'win32', home }), 0); assert.match(help.join('\n'), /whosup uninstall \[--purge\]/)
  assert.deepEqual(readdirSync(home), [])
  // 첫 실행 안내의 단독 설치 갈래도 같다
  const r = await runSetupRaw({ standalone: true, install: true, env, home, platform: 'win32', root: ROOT, terminal: null })
  assert.equal(r.state, 'unsupported'); assert.deepEqual(readdirSync(home), [])
})

// 설치기가 만든 폴더의 표식과 설치 기록을 둔다(install.sh와 scripts/standalone.mjs install이 하는 일).
const own = (dir) => touch(join(dir, APP_MARK_FILE), `${APP_MARK}\n`)
test('설치 기록과 표식: <데이터 폴더>/install.json에 제품·판·폴더·node를 적고, 모양이 틀린 파일·링크는 기록이 아니다', () => {
  const home = tmp('rec'); const env = isoEnv(home); const L = layout(env, home)
  assert.equal(RECORD_FILE, 'install.json'); assert.equal(readRecordFile(L.data), null); assert.equal(readRecord(L.data), null)
  const body = writeRecord(L, { id: 'fivetaku.whosup', version: '0.1.0', node: '/n/bin/node', login: L.plist, now: new Date('2026-01-02T03:04:05Z') })
  assert.deepEqual(body, { product: 'whosup', id: 'fivetaku.whosup', version: '0.1.0', at: '2026-01-02T03:04:05.000Z', data: L.data, app: L.app, launcher: L.launcher, conf: L.conf, state: L.state, node: '/n/bin/node', login: L.plist, env_installed: '' })
  assert.deepEqual(readRecordFile(L.data), body); assert.equal(statSync(L.record).mode & 0o777, 0o600); assert.deepEqual(readdirSync(L.data), ['install.json'], '임시 파일을 남기지 않는다')
  for (const bad of ['', '{}', 'not json', '[]', JSON.stringify({ ...body, product: 'other' }), JSON.stringify({ ...body, app: 'relative/app' }), JSON.stringify({ ...body, state: undefined })]) {
    writeFileSync(L.record, bad); assert.equal(readRecordFile(L.data), null, bad); assert.equal(readRecord(L.data), null, bad)
  }
  const linked = tmp('rec-link'); const LL = layout(isoEnv(linked), linked)
  mkdirSync(LL.data, { recursive: true }); writeFileSync(join(linked, 'elsewhere.json'), JSON.stringify(body)); symlinkSync(join(linked, 'elsewhere.json'), LL.record)
  assert.equal(readRecordFile(LL.data), null, '링크는 기록이 아니다')
  // "단독 설치가 있다"(readRecord — install.sh의 RECORD_JS와 같은 조건): 기록과 설치기의 표식이 한 쌍으로 맞아야 한다. 한쪽만 있으면 설치가 아니다
  const pairHome = tmp('rec-pair'); const P = layout(isoEnv(pairHome), pairHome)
  const good = () => { writeRecord(P, { id: 'fivetaku.whosup' }); touch(join(P.app, 'scripts', 'standalone.sh'), '#'); touch(join(P.app, 'herdr-plugin.toml'), 'name = "x"\nid = "fivetaku.whosup"\n'); own(P.app) }
  writeRecord(P, { id: 'fivetaku.whosup' })
  assert.equal(readRecord(P.data), null, '기록만 있고 앱 폴더가 없다'); assert.notEqual(readRecordFile(P.data), null)
  good(); assert.deepEqual(readRecord(P.data), readRecordFile(P.data)); assert.equal(readRecord(P.data).app, P.app)
  renameSync(join(P.app, APP_MARK_FILE), join(pairHome, 'mark-away')); assert.equal(readRecord(P.data), null, '기록은 맞는데 표식이 없다')
  touch(join(P.app, APP_MARK_FILE), 'something else\n'); assert.equal(readRecord(P.data), null, '표식의 글자가 다르다')
  good(); renameSync(join(P.app, APP_MARK_FILE), join(pairHome, 'mark-real')); symlinkSync(join(pairHome, 'mark-real'), join(P.app, APP_MARK_FILE)); assert.equal(readRecord(P.data), null, '표식이 링크다')
  unlinkSync(join(P.app, APP_MARK_FILE)); good(); assert.notEqual(readRecord(P.data), null)
  // 기록의 data·app이 지금 기대하는 자리와 다르다(다른 데이터 폴더의 기록을 가져다 놓았다)
  writeRecord({ ...P, data: join(pairHome, 'elsewhere', 'whosup') }, { id: 'fivetaku.whosup' }); assert.equal(readRecord(P.data), null, '기록의 data가 다른 자리다')
  writeRecord({ ...P, app: join(pairHome, 'elsewhere', 'whosup', 'app') }, { id: 'fivetaku.whosup' }); assert.equal(readRecord(P.data), null, '기록의 app이 다른 자리다')
  good(); assert.notEqual(readRecord(P.data), null)
  // 앱 폴더의 herdr-plugin.toml이 이 플러그인이 아니다 · scripts/standalone.sh가 없다 · 앱 폴더가 링크다
  assert.equal(readRecord(P.data, 'someone.else'), null); touch(join(P.app, 'herdr-plugin.toml'), 'id = "someone.else"\n'); assert.equal(readRecord(P.data), null, 'id가 다르다')
  good(); renameSync(join(P.app, 'scripts', 'standalone.sh'), join(pairHome, 'sh-away')); assert.equal(readRecord(P.data), null, '스크립트가 없다')
  good(); renameSync(P.app, join(pairHome, 'real-app')); symlinkSync(join(pairHome, 'real-app'), P.app); assert.equal(readRecord(P.data), null, '앱 폴더가 링크다')
  // 홈이 링크를 거치는 경로여도(예: /var → /private/var) 같은 자리로 본다: 링크를 푼 경로로 견준다
  const realHome = tmp('rec-real'); const viaLink = join(tmp('rec-via'), 'home'); symlinkSync(realHome, viaLink)
  const R = layout(isoEnv(realHome), realHome), V = layout(isoEnv(viaLink), viaLink)
  writeRecord(V, { id: 'fivetaku.whosup' }); touch(join(R.app, 'scripts', 'standalone.sh'), '#'); touch(join(R.app, 'herdr-plugin.toml'), 'id = "fivetaku.whosup"\n'); own(R.app)
  assert.notEqual(readRecord(R.data), null); assert.notEqual(readRecord(V.data), null)
  // 설치기가 만든 폴더인가: 표식 파일의 첫 줄이 맞는, 링크가 아닌 폴더
  assert.equal(APP_MARK_FILE, '.whosup-install'); assert.equal(appOwned(L.app), false)
  touch(join(L.app, 'x'), '1'); assert.equal(appOwned(L.app), false, '표식이 없으면 남의 폴더다')
  touch(join(L.app, APP_MARK_FILE), 'something else\n'); assert.equal(appOwned(L.app), false)
  own(L.app); assert.equal(appOwned(L.app), true)
  symlinkSync(L.app, `${L.app}.old`); assert.equal(appOwned(`${L.app}.old`), false, '링크는 따라가지 않는다')
})

test('잠금: <데이터 폴더>/install.lock에 주인의 PID를 적는다 — 주인이 살아 있으면 오래돼도 걷지 않고 죽었으면 걷는다, 자기가 잡은 잠금만 푼다', () => {
  const home = tmp('lock'); const data = join(home, '.local', 'share', 'whosup'); const lock = join(data, LOCK_NAME), file = join(lock, 'pid')
  const dead = spawnSync(process.execPath, ['-e', '']).pid   // 이미 끝난 프로세스의 PID
  const hoursOld = (h) => { const t = new Date(Date.now() - h * 3600 * 1000); utimesSync(lock, t, t) }
  // 잡기: 폴더와 그 안의 pid 파일(자기 PID 한 줄, 0600)
  const a = takeLock(data)
  assert.equal(a.ok, true); assert.equal(a.lock, lock); assert.equal(readFileSync(file, 'utf8'), `${process.pid}\n`); assert.equal(statSync(file).mode & 0o777, 0o600)
  // 주인이 살아 있다: 못 잡는다. 시간이 아무리 지나도 걷지 않는다(질문을 기다리는 설치는 오래 걸린다)
  assert.deepEqual(takeLock(data, { pid: 4242 }), { ok: false, lock })
  hoursOld(LOCK_GRACE_S / 3600 + 24)
  assert.equal(takeLock(data, { pid: 4242 }).ok, false, '살아 있는 주인의 잠금은 오래돼도 걷지 않는다'); assert.equal(clearStaleLock(lock), false); assert.equal(readFileSync(file, 'utf8'), `${process.pid}\n`)
  // 우리를 부른 설치기(parent)가 잡고 있는 잠금: 그 아래에서 돈다 — 다시 잡지도 풀지도 않는다. 주인이 아닌 PID를 대면 통하지 않는다
  const under = takeLock(data, { pid: 4242, parent: process.pid })
  assert.equal(under.ok, true); under.release(); assert.equal(readFileSync(file, 'utf8'), `${process.pid}\n`)
  assert.equal(takeLock(data, { pid: 4242, parent: dead }).ok, false)
  // 풀기: 잠금 폴더와 아무것도 남지 않은 데이터 폴더를 치운다(두 번 불러도 된다)
  a.release(); a.release(); assert.equal(existsSync(lock), false); assert.equal(existsSync(data), false)
  // 주인이 죽은 잠금: 방금 만들어진 것이어도 걷고 잡는다
  mkdirSync(lock, { recursive: true }); writeFileSync(file, `${dead}\n`)
  const b = takeLock(data, { pid: 4242 })
  assert.equal(b.ok, true); assert.equal(readFileSync(file, 'utf8'), '4242\n'); assert.deepEqual(readdirSync(lock), ['pid'], '걷다 만 흔적을 남기지 않는다')
  // 자기가 잡은 잠금만 푼다: 그 사이에 주인이 바뀌었으면(pid 파일이 다른 PID) 건드리지 않는다
  writeFileSync(file, `${process.pid}\n`); b.release(); assert.equal(readFileSync(file, 'utf8'), `${process.pid}\n`)
  // pid 파일이 없거나 읽을 수 없는 잠금: 시간으로만 본다 — LOCK_GRACE_S 안이면 살아 있는 것으로 보고, 넘겼을 때만 걷는다
  unlinkSync(file)
  assert.equal(takeLock(data).ok, false); hoursOld(1); assert.equal(takeLock(data).ok, false, '옛 기준(10분)으로는 걷지 않는다')
  writeFileSync(file, 'not a pid\n'); hoursOld(LOCK_GRACE_S / 3600 - 0.5); assert.equal(takeLock(data).ok, false)
  hoursOld(LOCK_GRACE_S / 3600 + 0.5)
  const c = takeLock(data)
  assert.equal(c.ok, true); assert.equal(readFileSync(file, 'utf8'), `${process.pid}\n`); c.release(); assert.equal(existsSync(data), false)
  // 시간 기준은 첫 실행 안내가 기다릴 수 있는 가장 긴 시간(질문 넷 × 최대 3600초 + 여유)보다 길다. install.sh도 같은 값·같은 이름을 쓴다
  assert.ok(LOCK_GRACE_S * 1000 > watchdogMsOf({ WHOSUP_SETUP_TIMEOUT_S: '1e12' }) + 120000)
  const install = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  assert.equal(LOCK_NAME, 'install.lock'); assert.match(install, new RegExp(`^LOCK_GRACE_S=${LOCK_GRACE_S}$`, 'm')); assert.match(install, /^ {2}LOCK="\$DATA\/install\.lock"$/m)
  assert.match(install, /node_js "\$LOCK_STALE_JS" "\$LOCK" "\$LOCK_GRACE_S"/); assert.doesNotMatch(install, /LOCK_AGE_JS|600000/, '10분 기준은 없다')
})

test('제거: 실행 명령(우리 것만)·앱 폴더(설치기의 표식이 든 것만)를 지우고 설정·상태는 --purge이고 설치 기록에 적힌 것일 때만 — 남의 파일·폴더는 건드리지 않는다', () => {
  const make = ({ record = true } = {}) => {
    const home = tmp('rm'); const env = isoEnv(home); const L = layout(env, home)
    touch(join(L.app, 'scripts', 'standalone.sh'), '#'); own(L.app); touch(join(`${L.app}.new`, 'x'), '1'); own(`${L.app}.new`); writeLauncher({ app: L.app, file: L.launcher })
    touch(join(L.conf, 'setup.json'), '{}'); touch(join(L.state, 'whosup.db'), 'db'); touch(join(L.bin, 'other-tool'), 'x'); touch(join(home, '.local', 'share', 'other', 'f'), 'x')
    if (record) writeRecord(L, { id: 'fivetaku.whosup' })
    return { home, env, L }
  }
  const a = make()
  const kept = removeInstall({ env: a.env, home: a.home, platform: 'darwin' })
  assert.deepEqual(kept.removed, [a.L.launcher, a.L.app, `${a.L.app}.new`]); assert.deepEqual(kept.kept, [a.L.conf, a.L.state]); assert.equal(kept.launcher, 'ours')
  assert.deepEqual(kept.left, []); assert.deepEqual(kept.foreign, [])
  assert.equal(existsSync(a.L.data), false, '설치 기록과 빈 데이터 폴더도 치운다'); assert.equal(readFileSync(join(a.L.conf, 'setup.json'), 'utf8'), '{}'); assert.equal(readFileSync(join(a.L.state, 'whosup.db'), 'utf8'), 'db')
  assert.deepEqual(readdirSync(a.L.bin), ['other-tool']); assert.equal(existsSync(join(a.home, '.local', 'share', 'other', 'f')), true)
  const b = make()
  const purged = removeInstall({ env: b.env, home: b.home, platform: 'linux', purge: true })
  assert.deepEqual(purged.kept, []); assert.equal(existsSync(b.L.conf), false); assert.equal(existsSync(b.L.state), false); assert.equal(existsSync(b.L.app), false)
  assert.deepEqual(readdirSync(b.L.bin), ['other-tool']); assert.equal(existsSync(join(b.home, '.local', 'share', 'other', 'f')), true)
  // 설치 기록이 없으면 --purge여도 설정·상태 폴더를 지우지 않는다(기록에 적힌 폴더만 지운다). 표식이 든 앱 폴더는 지운다
  const n = make({ record: false })
  const noRec = removeInstall({ env: n.env, home: n.home, platform: 'darwin', purge: true })
  assert.deepEqual(noRec.removed, [n.L.launcher, n.L.app, `${n.L.app}.new`]); assert.deepEqual(noRec.kept, [n.L.conf, n.L.state]); assert.equal(readFileSync(join(n.L.state, 'whosup.db'), 'utf8'), 'db')
  // 기록에 적힌 폴더가 지금 계산한 폴더와 다르면(환경이 달라졌다) 지금 계산한 폴더는 지우지 않는다
  const m = make({ record: false }); writeRecord({ ...m.L, conf: join(m.home, 'old-conf', 'whosup'), state: join(m.home, 'old-state', 'whosup') }, { id: 'fivetaku.whosup' })
  assert.deepEqual(removeInstall({ env: m.env, home: m.home, platform: 'darwin', purge: true }).kept, [m.L.conf, m.L.state])
  // 남의 폴더(표식 없음)가 app·app.new·app.old 자리에 있다: 지우지 않고 그 사실을 돌려준다. 기록이 있어도 같다
  const f = tmp('rm-foreign'); const LF = layout(isoEnv(f), f)
  touch(join(LF.app, 'scripts', 'standalone.sh'), '#'); touch(join(`${LF.app}.new`, 'mine'), '1'); touch(join(`${LF.app}.old`, 'mine'), '1'); writeRecord(LF, { id: 'fivetaku.whosup' })
  const fr = removeInstall({ env: isoEnv(f), home: f, platform: 'darwin', purge: true })
  assert.deepEqual(fr.removed, []); assert.deepEqual(fr.foreign, [LF.app, `${LF.app}.new`, `${LF.app}.old`])
  assert.equal(existsSync(join(LF.app, 'scripts', 'standalone.sh')), true); assert.equal(existsSync(join(`${LF.app}.new`, 'mine')), true); assert.equal(existsSync(join(`${LF.app}.old`, 'mine')), true)
  // 남의 ~/.local/bin/whosup: 그대로 둔다
  const c = tmp('rmf'); const LC = layout(isoEnv(c), c)
  touch(LC.launcher, '#!/bin/sh\necho mine\n'); touch(join(LC.app, 'x'), '1'); own(LC.app)
  const r = removeInstall({ env: isoEnv(c), home: c, platform: 'darwin', purge: true })
  assert.equal(r.launcher, 'foreign'); assert.equal(readFileSync(LC.launcher, 'utf8'), '#!/bin/sh\necho mine\n'); assert.deepEqual(r.removed, [LC.app])
  // 빈 설정·상태 폴더는 남길 것이 없어 치운다
  const d = tmp('rme'); const LD = layout(isoEnv(d), d)
  mkdirSync(LD.conf, { recursive: true }); mkdirSync(LD.state, { recursive: true }); touch(join(LD.app, 'x'), '1'); own(LD.app)
  assert.deepEqual(removeInstall({ env: isoEnv(d), home: d, platform: 'darwin' }).kept, []); assert.equal(existsSync(LD.conf), false); assert.equal(existsSync(LD.state), false)
  // 지우지 못한 것은 left로 돌려준다(성공으로 말하지 않는다): 설치 기록은 남긴다(다시 돌릴 때 그 기록으로 찾는다)
  if (process.getuid?.() !== 0) {
    const e = make()
    chmodSync(e.L.bin, 0o500)
    try {
      const stuck = removeInstall({ env: e.env, home: e.home, platform: 'darwin' })
      assert.deepEqual(stuck.left, [e.L.launcher]); assert.equal(existsSync(e.L.launcher), true); assert.equal(existsSync(e.L.record), true)
    } finally { chmodSync(e.L.bin, 0o700) }
    // --purge여도 프로그램 쪽이 남았으면 설정·상태 폴더를 지우지 않는다(프로그램은 남았는데 설정과 기록만 사라지지 않게)
    const p = make()
    chmodSync(p.L.bin, 0o500)
    try {
      const stuck = removeInstall({ env: p.env, home: p.home, platform: 'darwin', purge: true })
      assert.deepEqual(stuck.left, [p.L.launcher]); assert.deepEqual(stuck.kept, [p.L.conf, p.L.state]); assert.equal(readFileSync(join(p.L.state, 'whosup.db'), 'utf8'), 'db'); assert.equal(existsSync(p.L.record), true)
    } finally { chmodSync(p.L.bin, 0o700) }
    // 고친 뒤 다시 돌리면: 앱 폴더는 이미 없지만 남은 기록으로 찾아 설정·상태까지 지운다
    const again = removeInstall({ env: p.env, home: p.home, platform: 'darwin', purge: true })
    assert.deepEqual(again.left, []); assert.equal(existsSync(p.L.conf), false); assert.equal(existsSync(p.L.state), false); assert.equal(existsSync(p.L.data), false)
    // 설치 기록을 지우지 못했다: 그것도 남은 것이다(성공으로 말하지 않는다)
    const q = tmp('rm-rec'); const LQ = layout(isoEnv(q), q); writeRecord(LQ, { id: 'fivetaku.whosup' })
    chmodSync(LQ.data, 0o500)
    try { assert.deepEqual(removeInstall({ env: isoEnv(q), home: q, platform: 'darwin' }).left, [LQ.record]) } finally { chmodSync(LQ.data, 0o700) }
    assert.deepEqual(removeInstall({ env: isoEnv(q), home: q, platform: 'darwin' }).left, []); assert.equal(existsSync(LQ.data), false)
    // 빈 데이터 폴더를 치우지 못했다: 남은 것이다
    const w = tmp('rm-data'); const LW = layout(isoEnv(w), w); mkdirSync(LW.data, { recursive: true })
    chmodSync(join(LW.data, '..'), 0o500)
    try { assert.deepEqual(removeInstall({ env: isoEnv(w), home: w, platform: 'darwin' }).left, [LW.data]) } finally { chmodSync(join(LW.data, '..'), 0o700) }
  }
})

test('명령 줄: stop은 Linux에서 사용자 서비스도 멈추고(ExecStop이 부른 stop --service는 보드만 본다), autostart·uninstall은 치우지 못한 것을 알리고 1로 끝난다', async () => {
  const home = tmp('cli'); const L = layout(isoEnv(home), home)
  const log = join(home, 'ctl.log')
  // 가짜 systemctl·launchctl: 받은 인자를 적는다. is-active는 <기록>.active가 있을 때만 0, stop은 그 파일을 치운다. print는 늘 실패(불려 있지 않다)
  const ctl = join(home, 'fake-ctl')
  writeFileSync(ctl, ['#!/bin/sh', `printf '%s\\n' "$*" >> '${log}'`, 'case " $* " in', `  *" is-active "*) [ -f '${log}.active' ] || exit 3 ;;`, `  *" stop "*) mv '${log}.active' '${log}.stopped' ;;`, '  *" print "*) exit 113 ;;', 'esac', 'exit 0', ''].join('\n')); chmodSync(ctl, 0o755)
  const calls = () => { try { return readFileSync(log, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
  const env = isoEnv(home, { WHOSUP_SYSTEMCTL: ctl, WHOSUP_LAUNCHCTL: ctl, WHOSUP_LANG: 'en' })
  const run = async (argv, platform) => { const out = []; return { code: await cli(argv, env, { log: (l) => out.push(l), platform, home }), out } }
  // 서비스가 active다: 보드를 끈 뒤 서비스를 멈춘다
  writeFileSync(`${log}.active`, '')
  const stop = await run(['stop'], 'linux')
  assert.equal(stop.code, 0); assert.deepEqual(stop.out, ['whosup not running'])
  assert.deepEqual(calls(), ['--user is-active --quiet whosup.service', '--user stop whosup.service', '--user is-active --quiet whosup.service'], '멈춘 뒤 다시 묻는다'); assert.equal(existsSync(`${log}.active`), false)
  // 서비스가 active가 아니다: 묻기만 한다. ExecStop이 부른 stop(--service): 서비스 관리자를 다시 부르지 않는다. macOS: 부르지 않는다
  writeFileSync(log, '')
  assert.equal((await run(['stop'], 'linux')).code, 0); assert.deepEqual(calls(), ['--user is-active --quiet whosup.service'])
  writeFileSync(log, ''); writeFileSync(`${log}.active`, '')
  assert.equal((await run(['stop', '--service'], 'linux')).code, 0); assert.deepEqual(calls(), [], 'ExecStop의 stop은 서비스를 다시 멈추지 않는다'); assert.equal(existsSync(`${log}.active`), true)
  assert.equal((await run(['stop'], 'darwin')).code, 0); assert.deepEqual(calls(), [])
  // autostart status(macOS): 파일은 있는데 launchd가 불러 두지 않았으면 "다음 로그인부터"라고 말한다
  assert.deepEqual((await run(['autostart', 'status'], 'darwin')).out, ['Start at login: off'])
  touch(L.plist, '<plist/>')
  assert.deepEqual((await run(['autostart', 'status'], 'darwin')).out, [`Start at login: on, from your next login (${L.plist})`])
  assert.equal(TEXT.ko.saAutoOnLater('/f'), '로그인할 때 자동으로 켜기: 켜짐, 다음 로그인부터 (/f)')
  // autostart off: 파일을 지우지 못하면 남은 파일을 알리고 1 — 꺼졌다고 말하지 않는다
  if (process.getuid?.() !== 0) {
    chmodSync(join(home, 'Library', 'LaunchAgents'), 0o500)
    try {
      const off = await run(['autostart', 'off'], 'darwin')
      assert.equal(off.code, 1); assert.deepEqual(off.out, [`Could not turn off start at login. This file is still there: ${L.plist}. Remove it yourself, then run this again.`])
      // uninstall: 로그인 항목을 치우지 못했으면 프로그램을 지우기 전에 멈춘다
      touch(join(L.app, 'x'), '1'); own(L.app); writeRecord(L, { id: 'fivetaku.whosup' })
      const un = await run(['uninstall'], 'darwin')
      assert.equal(un.code, 1); assert.deepEqual(un.out, [TEXT.en.saAutoOffFailed(L.plist), TEXT.en.saUninstallHalted])
      assert.equal(existsSync(join(L.app, 'x')), true, '프로그램은 그대로다'); assert.equal(existsSync(L.record), true)
    } finally { chmodSync(join(home, 'Library', 'LaunchAgents'), 0o700) }
    const off = await run(['autostart', 'off'], 'darwin')
    assert.equal(off.code, 0); assert.deepEqual(off.out, ['Start at login: off']); assert.equal(existsSync(L.plist), false)
    const un = await run(['uninstall'], 'darwin')
    assert.equal(un.code, 0); assert.deepEqual(un.out, ['whosup is uninstalled.', `  Removed: ${L.app}`]); assert.equal(existsSync(L.data), false)
  }
  // 그 자리에 폴더가 있다는 것만으로는 설치가 아니다(표식도 기록도 없다): 없다고 말하고 건드리지 않는다. 한국어 문구도 있다
  touch(join(L.app, 'scripts', 'standalone.sh'), 'echo not whosup\n')
  const none = await run(['uninstall', '--purge'], 'darwin')
  assert.equal(none.code, 1); assert.deepEqual(none.out, ['There is no standalone whosup install here.']); assert.equal(existsSync(join(L.app, 'scripts', 'standalone.sh')), true)
  for (const k of ['saAutoOffFailed', 'saLeft', 'saForeignKept']) { assert.match(TEXT.ko[k]('/x'), /\/x/); assert.match(TEXT.en[k]('/x'), /\/x/) }
  assert.match(TEXT.ko.saUninstallHalted, /프로그램은 지우지 않았습니다/); assert.match(TEXT.ko.saUninstallPartly, /다 지우지 못했습니다/)
})

test('명령 줄: uninstall·autostart on|off는 설치기와 같은 잠금을 잡고, 서비스 관리자에 아직 살아 있는 항목·서비스는 꺼졌다고 말하지 않는다', async () => {
  const home = tmp('cli-lock'); const L = layout(isoEnv(home), home)
  const script = (name, text) => { const f = join(home, name); writeFileSync(f, text); chmodSync(f, 0o755); return f }
  // 불려 있지도 active도 아니다. print는 진짜 launchctl이 "그 항목이 없다"고 답할 때의 종료 코드(113)를 낸다 — 그 밖의 코드는 "물을 수 없었다"다
  const quietCtl = script('ctl-quiet', '#!/bin/sh\ncase " $* " in *" print "*) exit 113 ;; *" is-active "* | *" is-enabled "*) exit 3 ;; esac\nexit 0\n')
  const liveCtl = script('ctl-live', '#!/bin/sh\nexit 0\n')   // 무엇을 물어도 0: bootout·stop·disable 뒤에도 여전히 살아 있다고 답한다
  const env = isoEnv(home, { WHOSUP_SYSTEMCTL: quietCtl, WHOSUP_LAUNCHCTL: quietCtl, WHOSUP_LANG: 'en' })
  const run = async (argv, platform, over = {}) => { const out = []; return { code: await cli(argv, { ...env, ...over }, { log: (l) => out.push(l), platform, home }), out } }
  const lock = join(L.data, LOCK_NAME)
  const installed = () => { touch(join(L.app, 'x'), '1'); own(L.app); writeRecord(L, { id: 'fivetaku.whosup' }); touch(L.plist, '<plist/>') }
  // stop: 상태 폴더가 없으면 끌 보드도 없다 — 그 폴더를 새로 만들지 않는다(설치기가 끝내지 못한 설치를 치우기 전에 부른다)
  const idle = await run(['stop'], 'linux')
  assert.equal(idle.code, 0); assert.deepEqual(idle.out, ['whosup not running']); assert.deepEqual(readdirSync(home).sort(), ['ctl-live', 'ctl-quiet'])
  installed()
  // 다른 설치·제거가 잠금을 쥐고 있다(주인이 살아 있다): 알리고 1 — 아무것도 바꾸지 않는다. 읽기만 하는 status는 잠금과 상관없다
  mkdirSync(lock); writeFileSync(join(lock, 'pid'), `${process.pid}\n`)
  for (const argv of [['uninstall'], ['uninstall', '--purge'], ['autostart', 'off'], ['autostart', 'on']]) {
    const r = await run(argv, 'darwin')
    assert.equal(r.code, 1, argv.join(' ')); assert.deepEqual(r.out, [TEXT.en.saLocked(lock)], argv.join(' '))
  }
  assert.equal(existsSync(L.plist), true); assert.equal(existsSync(join(L.app, 'x')), true); assert.equal(existsSync(L.record), true)
  assert.deepEqual((await run(['autostart', 'status'], 'darwin')).out, [`Start at login: on, from your next login (${L.plist})`])
  assert.match(TEXT.ko.saLocked('/l'), /진행 중입니다\(잠금 \/l\)/); assert.match(TEXT.en.saLocked('/l'), /the lock \/l is held/)
  // 우리를 부른 설치기가 쥔 잠금(WHOSUP_INSTALLER_PID가 그 주인)이면 그 아래에서 돈다 — 그 잠금은 풀지 않는다(설치기의 것이다)
  const under = await run(['autostart', 'off'], 'darwin', { WHOSUP_INSTALLER_PID: String(process.pid) })
  assert.equal(under.code, 0); assert.deepEqual(under.out, ['Start at login: off']); assert.equal(readFileSync(join(lock, 'pid'), 'utf8'), `${process.pid}\n`)
  // 주인이 죽은 잠금은 걷고 진행한다. 끝나면 자기 잠금을 푼다
  writeFileSync(join(lock, 'pid'), `${spawnSync(process.execPath, ['-e', '']).pid}\n`)
  const on = await run(['autostart', 'on'], 'darwin')
  assert.equal(on.code, 0); assert.deepEqual(on.out, [`Start at login: on (${L.plist})`]); assert.equal(existsSync(lock), false, '끝나면 잠금을 푼다')
  // autostart off · uninstall: launchd가 그 항목을 아직 불러 두었으면(bootout이 안 먹었다) 꺼졌다고 말하지 않는다 — 손으로 칠 명령을 알리고 1.
  // 파일도 프로그램도 그대로다(다시 돌리면 다시 내린다)
  const fix = `    launchctl bootout gui/${process.getuid?.() ?? 0}/dev.whosup.board`
  const off = await run(['autostart', 'off'], 'darwin', { WHOSUP_LAUNCHCTL: liveCtl })
  assert.equal(off.code, 1); assert.deepEqual(off.out, [TEXT.en.saAutoStillLoaded('dev.whosup.board'), fix]); assert.equal(existsSync(L.plist), true); assert.equal(existsSync(lock), false)
  const un = await run(['uninstall', '--purge'], 'darwin', { WHOSUP_LAUNCHCTL: liveCtl })
  assert.equal(un.code, 1); assert.deepEqual(un.out, [TEXT.en.saAutoStillLoaded('dev.whosup.board'), fix, TEXT.en.saUninstallHalted])
  assert.equal(existsSync(join(L.app, 'x')), true, '프로그램은 그대로다'); assert.equal(existsSync(L.record), true); assert.equal(existsSync(lock), false)
  // Linux: stop이 사용자 서비스를 멈추지 못했다(여전히 active) — 그 사실과 손으로 칠 명령을 알리고 1. uninstall은 프로그램을 지우기 전에 멈춘다
  const stop = await run(['stop'], 'linux', { WHOSUP_SYSTEMCTL: liveCtl })
  assert.equal(stop.code, 1); assert.deepEqual(stop.out, ['whosup not running', TEXT.en.saServiceStillOn('whosup.service'), '    systemctl --user stop whosup.service'])
  assert.equal((await run(['stop', '--service'], 'linux', { WHOSUP_SYSTEMCTL: liveCtl })).code, 0, 'ExecStop이 부른 stop은 서비스를 보지 않는다')
  // (상태 폴더의 내용은 보드가 두는 파일로 둔다: --purge는 기록된 폴더가 후즈업의 상태 폴더로 보일 때만 지운다 — 굳히기 Q3-F2)
  mkdirSync(L.state, { recursive: true }); touch(join(L.state, 'whosup.db'), '1')
  const unL = await run(['uninstall', '--purge'], 'linux', { WHOSUP_SYSTEMCTL: liveCtl })
  assert.equal(unL.code, 1); assert.deepEqual(unL.out, [TEXT.en.saServiceStillOn('whosup.service'), '    systemctl --user stop whosup.service', TEXT.en.saUninstallHalted])
  assert.equal(existsSync(join(L.app, 'x')), true); assert.equal(existsSync(join(L.state, 'whosup.db')), true)
  // Linux: disable 뒤에도 사용자 관리자가 enabled라고 답한다 — autostart off는 꺼졌다고 말하지 않는다
  touch(L.unit, '[Unit]\n')
  const offL = await run(['autostart', 'off'], 'linux', { WHOSUP_SYSTEMCTL: liveCtl })
  assert.equal(offL.code, 1); assert.deepEqual(offL.out, [TEXT.en.saAutoStillLoaded('whosup.service'), '    systemctl --user disable whosup.service']); assert.equal(existsSync(L.unit), true)
  for (const k of ['saAutoStillLoaded', 'saServiceStillOn']) { assert.match(TEXT.ko[k]('이름'), /이름/); assert.match(TEXT.ko[k]('x'), /:$/); assert.match(TEXT.en[k]('x'), /:$/) }
  // 서비스 관리자가 놓은 뒤에는 평소대로 지워진다: 데이터 폴더도 남지 않는다(잠금 폴더가 그 안에 있어도)
  assert.equal((await run(['autostart', 'off'], 'linux')).code, 0)
  const done = await run(['uninstall', '--purge'], 'darwin')
  assert.equal(done.code, 0, done.out.join('\n')); assert.equal(done.out[0], 'whosup is uninstalled.'); assert.equal(existsSync(L.data), false); assert.equal(existsSync(L.plist), false); assert.equal(existsSync(L.state), false)
})

test('update가 내려받은 설치기: 비어 있지 않고 첫 줄이 sh 스크립트이고 끝이 main 호출 줄일 때만 돌린다', () => {
  const real = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  assert.equal(looksLikeInstaller(real), true); assert.equal(looksLikeInstaller(`${real}\n\n`), true)
  assert.equal(looksLikeInstaller(''), false); assert.equal(looksLikeInstaller('#!/bin/sh\n'), false)
  assert.equal(looksLikeInstaller(real.slice(0, real.length - 20)), false, '중간에 끊긴 파일')
  assert.equal(looksLikeInstaller('<html><body>404</body></html>\n'), false); assert.equal(looksLikeInstaller(`#!/bin/bash\n${real.split('\n').slice(1).join('\n')}`), false)
  // 내려받은 파일은 이 실행만 쓰는 임시 폴더(mkdtemp)에 배타적으로 쓴다: 예측할 수 있는 이름(<데이터 폴더>/install.<pid>.sh)을 쓰지 않는다
  const src = readFileSync(join(ROOT, 'scripts', 'standalone.mjs'), 'utf8')
  assert.match(src, /mkdtempSync\(join\(tmpdir\(\), 'whosup-update-'\)\)/); assert.match(src, /writeFileSync\(file, text, \{ flag: 'wx', mode: 0o600 \}\)/); assert.doesNotMatch(src, /process\.pid/)
  // src/standalone.mjs는 잠금의 pid 파일에 자기 PID를 적는다(takeLock의 기본값) — 파일 이름에 PID를 끼워 넣는 곳은 없다
  assert.doesNotMatch(readFileSync(join(ROOT, 'src', 'standalone.mjs'), 'utf8'), /\$\{process\.pid\}|process\.pid\s*\+|\+\s*process\.pid/, '임시 파일 이름에 PID를 쓰지 않는다')
})

test('설치 요약의 앱 코어 안내: 보드의 자동 감지 결과(auto.json)에서 "<앱>의 세션도 보드에 보인다" 줄을 가져온다 — 아직 없으면 잠깐 기다리고, 끝내 없으면 그 줄 없이 간다', async () => {
  const state = tmp('auto')
  const summary = { cores: [{ name: 'appcore', app: 'Ovis', web: true }, { name: 'other', app: null }] }
  // 감지 결과가 있다
  writeFileSync(join(state, 'auto.json'), JSON.stringify({ version: 1, values: {}, summary }))
  assert.deepEqual(await coreNotes(state, TEXT.en, { waitMs: 0 }), ['Sessions of Ovis show on the board too. A click opens the session in a browser tab.', 'Sessions of herdr-core "other" show on the board too.'])
  assert.deepEqual(await coreNotes(state, TEXT.ko, { waitMs: 0 }), ['Ovis의 세션도 보드에 보입니다. 누르면 그 세션이 브라우저 탭으로 열립니다.', 'herdr-core "other"의 세션도 보드에 보입니다.'])
  // 감지한 앱 코어가 없으면 줄도 없다
  writeFileSync(join(state, 'auto.json'), JSON.stringify({ version: 1, values: {}, summary: { cores: [] } }))
  assert.deepEqual(await coreNotes(state, TEXT.en, { waitMs: 0 }), [])
  // 아직 안 끝났다(파일 없음 → 조금 뒤 생긴다): 기다렸다가 싣는다. 끝내 없으면 빈 목록
  const late = tmp('auto-late')
  setTimeout(() => writeFileSync(join(late, 'auto.json'), JSON.stringify({ version: 1, values: {}, summary })), 60)
  assert.equal((await coreNotes(late, TEXT.en, { waitMs: 3000, stepMs: 20 })).length, 2)
  const began = Date.now()
  assert.deepEqual(await coreNotes(tmp('auto-none'), TEXT.en, { waitMs: 100, stepMs: 20 }), []); assert.ok(Date.now() - began < 2000)
  // 설치 요약이 그 줄을 싣는다: 터미널에서 묻지 않은 설치이고 보드가 켜져 있을 때만(물은 설치는 질문 아래에 이미 찍었다)
  const entry = readFileSync(join(ROOT, 'scripts', 'standalone.mjs'), 'utf8')
  assert.match(entry, /if \(asked\.state !== 'done' && facts\.board\.up\) facts\.notes\.push\(\.\.\.await coreNotes\(L\.state, T\)\)/)
  const lines = standaloneLines({ kind: 'install', app: '/a', board: { up: true, url: 'http://127.0.0.1:4790', port: '4790' }, login: 'on', notes: ['Sessions of Ovis show on the board too. A click brings the Ovis window to the front.'] }, TEXT.en)
  assert.equal(lines.at(-4), '  Sessions of Ovis show on the board too. A click brings the Ovis window to the front.')
})

test('마무리 문구(단독 설치): 보드 주소 · whosup 명령 · 로그인할 때 자동으로 켜기와 끄는 법 · 바꾸는 곳 — herdr 안내 없음, 명령은 따로 한 줄, ko·en', () => {
  const up = { up: true, url: 'http://127.0.0.1:4790', port: '4790' }
  assert.deepEqual(standaloneLines({ kind: 'install', app: '/d/whosup/app', board: up, opens: true, login: 'on' }, TEXT.en), [
    'whosup install summary',
    '  Installed on its own, without herdr (standalone).',
    '  Program: /d/whosup/app',
    '  The board is running:  http://127.0.0.1:4790',
    '    Your browser opens it.',
    '  It starts by itself when you log in. To turn that off, type this in a terminal:',
    '      whosup autostart off',
    '  Start, stop, update and remove whosup with the whosup command (start · stop · status · update · uninstall). For the full list, type this in a terminal:',
    '      whosup help',
    '  To change any of this, use settings in the board.',
  ])
  assert.deepEqual(standaloneLines({ kind: 'install', app: '/d/whosup/app', board: up, opens: false, desktop: false, login: 'on' }, TEXT.ko).slice(0, 8), [
    'whosup 설치 요약',
    '  herdr 없이 단독으로 설치했습니다.',
    '  프로그램: /d/whosup/app',
    '  보드가 켜져 있습니다:  http://127.0.0.1:4790',
    '    여기서는 브라우저가 저절로 열리지 않습니다. 이 컴퓨터에서 위 주소를 여세요.',
    '    다른 기기에서 보려면 먼저 포트를 넘깁니다: ssh -L 4790:127.0.0.1:4790 <host>',
    '  로그인할 때 자동으로 켜집니다. 끄려면 터미널에 아래를 치세요:',
    '      whosup autostart off',
  ])
  // 보드가 꺼져 있다(켜지 않기로 한 설치) / 켜려다 실패했다 / 로그인 항목: 꺼짐 · 실패 · 서비스 관리자 없음
  const down = standaloneLines({ kind: 'install', board: { up: false }, login: 'off' }, TEXT.en)
  assert.deepEqual(down.slice(2, 6), ['  The board is not running. To start it, type this in a terminal:', '      whosup start', '  It does not start by itself when you log in. To make it do so, type this in a terminal:', '      whosup autostart on'])
  assert.deepEqual(standaloneLines({ board: { up: false, log: '/s/server.log' }, login: 'failed' }, TEXT.en).slice(2, 6), [
    '  The board did not start (log: /s/server.log). To start it again, type this in a terminal:', '      whosup start',
    '  Could not set it to start when you log in. To try that again, type this in a terminal:', '      whosup autostart on'])
  assert.deepEqual(standaloneLines({ board: up, login: 'none' }, TEXT.en).slice(4, 6), [
    '  This computer has no user service manager (systemd --user), so the board does not start by itself when you log in. After a restart, type this in a terminal:', '      whosup start'])
  // 등록은 됐는데 지금 바로 불러 두지는 못했다(launchctl bootstrap 실패): "다음 로그인부터"라고 말한다 — 끄는 법은 그대로 싣는다
  assert.deepEqual(standaloneLines({ board: up, login: 'on', loginLoad: 'failed' }, TEXT.en).slice(4, 6), [
    '  It is set to start when you log in, but could not be loaded right now, so that begins at your next login. To turn that off, type this in a terminal:', '      whosup autostart off'])
  assert.deepEqual(standaloneLines({ board: up, login: 'on', loginLoad: 'failed' }, TEXT.ko).slice(4, 6), [
    '  로그인할 때 자동으로 켜지게 등록했지만 지금 바로 불러 두지는 못했습니다. 다음 로그인부터 켜집니다. 끄려면 터미널에 아래를 치세요:', '      whosup autostart off'])
  assert.equal(TEXT.en.saLoadLater, 'It is set to start when you log in, but could not be loaded right now, so that begins at your next login.')
  assert.equal(TEXT.ko.saLoadLater, '로그인할 때 자동으로 켜지게 등록했지만 지금 바로 불러 두지는 못했습니다. 다음 로그인부터 켜집니다.')
  // 새 버전으로 바꾼 설치: 그 사실을 말하고, 브라우저 줄은 없다
  const upd = standaloneLines({ kind: 'update', app: '/a', board: up, login: 'off' }, TEXT.en)
  assert.equal(upd[1], '  whosup updated to the new version. Your settings and history are kept.'); assert.doesNotMatch(upd.join('\n'), /browser/i)
  // whosup setup의 끝: 제목 없이 왼쪽에 붙여 쓰고, 고른 값이 있으면 재시작 없이 반영된다고 말한다. 명령 이름·덧붙임도 그대로 싣는다
  const again = standaloneLines({ kind: 'setup', board: up, login: 'on', cmd: '/h/.local/bin/whosup', notes: ['NOTE'], picked: 2 }, TEXT.en)
  assert.deepEqual(again, [
    'The board is running:  http://127.0.0.1:4790', '  It picks up your choices without a restart.',
    'It starts by itself when you log in. To turn that off, type this in a terminal:', '    /h/.local/bin/whosup autostart off', 'NOTE',
    'Start, stop, update and remove whosup with the whosup command (start · stop · status · update · uninstall). For the full list, type this in a terminal:', '    /h/.local/bin/whosup help',
    'To change any of this, use settings in the board.',
  ])
  for (const lang of ['en', 'ko']) {
    for (const o of [{ board: up, login: 'on', opens: true }, { board: { up: false }, login: 'off' }, { board: { up: false, log: '/l' }, login: 'failed' }, { board: up, login: 'none', kind: 'update' }, { board: up, login: 'on', kind: 'setup', picked: 1 }]) {
      const text = standaloneLines(o, TEXT[lang]).join('\n')
      assert.doesNotMatch(text, /herdr plugin|plugin action|`|npm start|\bherdr\n/, `${lang}: herdr 플러그인 안내·백틱 없음`)
      assert.match(text, /whosup (autostart (on|off)|start)\n/, `${lang}: 명령은 따로 한 줄`); assert.match(text, new RegExp(TEXT[lang].change.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    }
    // 명령을 싣는 설명 줄은 ':'로 끝난다(명령은 다음 줄)
    for (const k of ['saBoardDown', 'saLoginOn', 'saLoginOnLater', 'saLoginOff', 'saLoginFailed', 'saLoginNone', 'saCommands', 'saWindows']) assert.match(TEXT[lang][k], /:$/, `${lang}.${k}`)
    assert.match(TEXT[lang].saBoardFailed('/x'), /:$/)
    assert.equal(TEXT[lang].saHelp('whosup').length, 10); for (const c of ['start', 'stop', 'status', 'open', 'setup', 'update', 'uninstall [--purge]', 'autostart on|off|status']) assert.ok(TEXT[lang].saHelp('whosup').some((l) => l.startsWith(`  whosup ${c} `)), `${lang}: ${c}`)
  }
})

// ── 첫 실행 안내의 단독 설치 갈래(src/setup.mjs runSetup standalone) ──
const facts = (over = {}) => ({
  platform: 'darwin', release: '1', env: {}, node: { version: 'v22.13.0', sqlite: true }, herdr: { found: false }, herdrCore: { running: true, socket: '/c' },
  herdrApp: { found: true, bin: 'herdr-app' }, tools: {}, terminal: { showing: null, installed: ['Terminal'] }, ovis: [],
  agents: { claude: '/bin/claude', codex: '/bin/codex', projectsDir: null }, port: { start: 4790, free: 4790 }, ...over,
})
const fakeTerm = (typed = '') => { const input = new PassThrough(); const out = []; if (typed) input.write(typed); return { input, out, write: (s) => out.push(s), columns: 80, colors: false, close() {}, text: () => out.join('') } }
const setupWith = async ({ typed = '', home = tmp('home'), env = {}, terminal, ...over } = {}) => {
  assert.ok(home.startsWith(tmpdir()))
  const term = terminal === null ? null : fakeTerm(typed)
  const herdrCalls = [], spawned = [], logs = []
  const r = await runSetupRaw({
    standalone: true, install: true, env: standaloneEnv(isoEnv(home, env), home), home, platform: 'darwin', root: ROOT, terminal: term, detectFn: async () => facts(),
    run: async (bin, args) => { herdrCalls.push(args); return { ok: false, out: '' } }, herdrBin: '/fake/herdr', spawnFn: (s) => { spawned.push(s); return 1 },
    boardFn: async () => ({ up: false, port: null }), log: (l) => logs.push(l), settleMs: 20, ...over,
  })
  return { r, home, term, herdrCalls, spawned, logs, file: join(home, '.config', 'whosup', 'setup.json') }
}

test('첫 실행 안내(단독 설치·설치기 안): 첫 설치의 말투로 묻고, 번호로 고른 것만 ~/.config/whosup/setup.json에 — herdr를 부르지도 도우미를 띄우지도 않는다', async () => {
  // 고를 것: Herdr 앱 세션을 여는 곳(Herdr 앱·터미널 창), 에이전트 명령(claude·codex)
  const s = await setupWith({ typed: '2\n\n' })
  assert.equal(s.r.state, 'done'); assert.deepEqual(s.r.questions.map((q) => q.key), ['core_target', 'agent_cmd'])
  assert.deepEqual(readSetup(s.file).choices, { core_target: 'terminal' }); assert.deepEqual(s.r.saved, [s.file])
  assert.deepEqual(s.r.autostart, { state: 'standalone' }); assert.deepEqual(s.herdrCalls, [], 'herdr에 아무것도 묻지 않는다'); assert.deepEqual(s.spawned, [], 'herdr 도우미를 띄우지 않는다')
  const text = s.term.text()
  assert.match(text, /whosup first-run setup/); assert.match(text, /Enter keeps the value marked \*\. A number sets your own choice\./, '첫 설치의 말투(Enter = 자동 감지 값)')
  assert.match(text, /Type a number, or press Enter for 1: /); assert.match(text, /Saved: Herdr app sessions open in = terminal window/)
  // 마무리 문구는 설치기가 설치 요약으로 찍는다: 여기서는 찍지 않는다. herdr 플러그인 안내는 어디에도 없다
  assert.doesNotMatch(text, /The board is|herdr plugin|plugin action|Type this in this terminal|starts whenever herdr|npm start|not registered/)
  assert.match(s.logs.join('\n'), /asked 2, set by hand 1; saved: .*setup\.json$/); assert.doesNotMatch(s.logs.join('\n'), /autostart/)
  // Enter만 쳐서 다 답했다: 값은 쓰지 않고 마친 표시만 쓴다(보드가 같은 질문을 다시 묻지 않는다 — 값은 자동 감지를 따른다)
  const enter = await setupWith({ typed: '\n\n' })
  assert.equal(enter.r.state, 'done'); assert.deepEqual(enter.r.saved, [enter.file])
  assert.deepEqual(readSetup(enter.file).choices, {}); assert.equal(readSetup(enter.file).done, true)
  assert.match(enter.term.text(), /Nothing set by hand: auto-detect keeps applying\./)
  // 고를 것이 없다: 묻지 않는다
  const nothing = await setupWith({ typed: '2\n', detectFn: async () => facts({ herdrCore: { running: false }, herdrApp: { found: false, bin: 'herdr-app' }, agents: { claude: '/bin/claude', codex: null, projectsDir: null } }) })
  assert.deepEqual(nothing.r.questions, []); assert.match(nothing.term.text(), /Nothing to choose here: the auto-detected values are used\./); assert.equal(existsSync(nothing.file), false)
  // 한국어
  const ko = await setupWith({ typed: '\n2\n', env: { WHOSUP_LANG: 'ko' } })
  assert.match(ko.term.text(), /whosup 첫 실행 안내/); assert.match(ko.term.text(), /저장했습니다: 세션을 열 때 실행할 명령 = codex/); assert.deepEqual(readSetup(ko.file).choices, { agent_cmd: 'codex' })
})

test('첫 실행 안내(단독 설치): 터미널 없음·WHOSUP_NO_SETUP·CI는 묻지 않고, 이미 셋업한 설치(업데이트)도 묻지 않는다', async () => {
  let detected = 0
  const agent = await setupWith({ terminal: null, detectFn: async () => { detected++; return facts() } })
  assert.equal(agent.r.state, 'silent'); assert.equal(detected, 0); assert.equal(existsSync(join(agent.home, '.config')), false)
  assert.deepEqual(agent.logs, ['whosup setup: no terminal — nothing asked']); assert.deepEqual(agent.herdrCalls, [])
  const quiet = await setupWith({ typed: '2\n', env: { WHOSUP_NO_SETUP: '1' } })
  assert.equal(quiet.r.state, 'silent'); assert.equal(quiet.term.text(), '')
  const ci = await setupWith({ typed: '2\n', env: { CI: 'true' } })
  assert.equal(ci.r.state, 'skipped'); assert.equal(ci.term.text(), '')
  // 이미 셋업한 설치: 설정 폴더에 읽을 수 있는 setup.json이 있거나 상태 폴더에 whosup.db(SQLite 파일)가 있다(새 상태 폴더든, 옛 ~/.config/whosup이든)
  const SETUP = '{"version":1,"at":"2026-01-01T00:00:00.000Z","choices":{}}\n'; const DB = 'SQLite format 3\u0000 and the rest'
  for (const mark of [['.config', 'whosup', 'setup.json'], ['.local', 'state', 'whosup', 'whosup.db'], ['.config', 'whosup', 'whosup.db']]) {
    // 이름만 같은 빈 파일·깨진 파일은 기존 설치가 아니다: 첫 실행 안내를 건너뛰지 않는다
    for (const junk of ['', '{}', 'not a database']) {
      const fresh = tmp('junk'); touch(join(fresh, ...mark), junk)
      assert.equal((await setupWith({ home: fresh, terminal: null })).r.state, 'silent', `${mark.join('/')}: ${JSON.stringify(junk)}`)
    }
    const home = tmp('existing'); touch(join(home, ...mark), mark.at(-1) === 'setup.json' ? SETUP : DB)
    const ex = await setupWith({ home, typed: '2\n2\n' })
    assert.equal(ex.r.state, 'existing', mark.join('/')); assert.equal(ex.term.text(), '', '설치 요약이 "새 버전으로 바꿨습니다"를 말한다 — 여기서는 찍지 않는다')
    assert.match(ex.logs.join('\n'), /already set up — nothing asked \(whosup setup asks again\)$/)
  }
  // Ctrl-C: "그만둡니다" 한 줄로 끝낸다 — 설치기는 이 결과를 보고 설치를 멈춘다
  let fire
  const int = await setupWith({ typed: '', onInterrupt: (fn) => { fire = fn; setTimeout(() => fire(), 30); return () => {} } })
  assert.equal(int.r.state, 'interrupted'); assert.match(int.term.text(), /Stopped: nothing saved\.\n$/); assert.equal(existsSync(int.file), false)
})

test('첫 실행 안내(단독 설치·whosup setup): 다시 묻는 말투, 끝에 단독 설치용 마무리 문구 — 옛 상태 폴더를 쓰는 사람의 이어 쓰기도 그 폴더를 본다', async () => {
  const lines = []
  const s = await setupWith({
    typed: '2\n\n', install: false,
    standaloneFacts: async () => ({ app: '/d/whosup/app', board: { up: true, url: 'http://127.0.0.1:4812', port: '4812' }, desktop: null, login: 'on', cmd: 'whosup', notes: [] }),
  })
  assert.equal(s.r.state, 'done'); assert.deepEqual(readSetup(s.file).choices, { core_target: 'terminal' })
  const text = s.term.text(); lines.push(...text.split('\n'))
  assert.match(text, /Enter leaves an item as it is set now/, '다시 묻는 말투'); assert.match(text, /press Enter to leave it as it is: /)
  assert.ok(text.endsWith(`\n${standaloneLines({ kind: 'setup', board: { up: true, url: 'http://127.0.0.1:4812', port: '4812' }, login: 'on', picked: 1 }, TEXT.en).join('\n')}\n\n`), text)
  assert.match(text, /The board is running: {2}http:\/\/127\.0\.0\.1:4812\n {2}It picks up your choices without a restart\.\n/)
  assert.doesNotMatch(text, /herdr plugin|plugin action|npm start|not registered|starts whenever herdr/)
  assert.deepEqual(s.herdrCalls, []); assert.deepEqual(s.spawned, [])
  // 보드가 아직 한 번도 안 떴으면(상태 폴더에 whosup.db 없음) 앞서 고른 값을 이어 쓴다
  const again = await setupWith({ home: s.home, typed: '\n2\n', install: false })
  assert.deepEqual(readSetup(again.file).choices, { core_target: 'terminal', agent_cmd: 'codex' })
  // 상태 폴더(새 폴더)에 whosup.db가 있으면 이번에 고른 것만 쓴다
  touch(join(s.home, '.local', 'state', 'whosup', 'whosup.db'), 'x')
  const later = await setupWith({ home: s.home, typed: '\n2\n', install: false })
  assert.deepEqual(readSetup(later.file).choices, { agent_cmd: 'codex' })
})

test('지금 상태: 보드는 상태 폴더의 port(없으면 설정한 포트)에 물어 보고, 브라우저를 여는지는 실행기와 같은 판정으로 본다', async () => {
  const home = tmp('facts'); const env = isoEnv(home); const L = layout(env, home)
  const asked = []
  const probe = (up) => async (port) => { asked.push(port); return up.includes(port) }
  assert.deepEqual(await boardNow(L, {}, { probe: probe([]) }), { up: false, port: null, url: null }); assert.deepEqual(asked, ['4790'])
  touch(join(L.state, 'port'), '48123\n')
  assert.deepEqual(await boardNow(L, { PORT: '48120' }, { probe: probe(['48123']) }), { up: true, port: '48123', url: 'http://127.0.0.1:48123' })
  assert.deepEqual(await boardNow(L, { PORT: '48120' }, { probe: probe(['48120']) }), { up: true, port: '48120', url: 'http://127.0.0.1:48120' }, '기록된 포트가 답하지 않으면 설정한 포트')
  assert.equal(browserOpens(L, { OPEN_BROWSER: '0' }, 'darwin'), false); assert.equal(browserOpens(L, {}, 'darwin'), true); assert.equal(browserOpens(L, { SSH_CONNECTION: 'x' }, 'darwin'), false)
  assert.equal(browserOpens(L, {}, 'linux'), false); assert.equal(browserOpens(L, { DISPLAY: ':0' }, 'linux'), true)
  touch(join(L.state, 'auto.json'), JSON.stringify({ values: { open_browser: '0' } }))
  assert.equal(browserOpens(L, {}, 'darwin'), false, '자동 감지(원격이면 0)'); assert.equal(browserOpens(L, { OPEN_BROWSER: '1' }, 'darwin'), true, '환경변수가 이긴다')
  // 요약에 실을 값: 실행 명령이 사람의 PATH에 없으면 전체 경로와 그 사실을 싣는다. .env의 PORT를 읽는다(읽기만)
  writeLauncher({ app: L.app, file: L.launcher }); touch(join(L.conf, '.env'), 'PORT=48130\n')
  const f = await standaloneFacts({ env: { ...env, WHOSUP_USER_PATH: '/usr/bin' }, home, platform: 'darwin', run: fakeCtl().run, probe: probe(['48130']), T: TEXT.en })
  assert.deepEqual(f, { app: L.app, board: { up: true, port: '48130', url: 'http://127.0.0.1:48130' }, desktop: null, login: 'off', cmd: shown(L.launcher), notes: [TEXT.en.saPathHint(L.bin)] })
  const g = await standaloneFacts({ env: { ...env, WHOSUP_USER_PATH: L.bin, SSH_CONNECTION: '1 2 3 4' }, home, platform: 'darwin', run: fakeCtl().run, probe: probe([]), T: TEXT.ko })
  assert.equal(g.cmd, 'whosup'); assert.deepEqual(g.notes, []); assert.equal(g.desktop, false); assert.equal(g.board.up, false)
  assert.equal(readFileSync(join(L.conf, '.env'), 'utf8'), 'PORT=48130\n')
})

test('배선: 설치기·실행 명령·로그인 항목이 같은 이름과 같은 찾는 방식을 쓴다', () => {
  const install = readFileSync(join(ROOT, 'install.sh'), 'utf8')
  const nodePath = readFileSync(join(ROOT, 'scripts', 'node-path.sh'), 'utf8')
  const sh = readFileSync(join(ROOT, 'scripts', 'standalone.sh'), 'utf8')
  const toml = readFileSync(join(ROOT, 'herdr-plugin.toml'), 'utf8')
  // 한 줄 설치 명령의 주소, 플러그인 id, herdr 최소 버전
  assert.match(install, new RegExp(`^INSTALL_URL="${INSTALL_URL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"$`, 'm'))
  assert.match(install, new RegExp(`^PLUGIN_ID="${manifestId(ROOT).replace(/\./g, '\\.')}"$`, 'm'))
  assert.equal(/^HERDR_MIN="([^"]+)"$/m.exec(install)[1], /^min_herdr_version = "([^"]+)"$/m.exec(toml)[1])
  assert.match(install, /^REPO="fivetaku\/whosup"$/m)
  // node를 찾는 방식: scripts/node-path.sh와 같은 덧붙임(WHOSUP_EXTRA_PATH로 갈아 끼운다)
  const appended = /\$\{WHOSUP_EXTRA_PATH-[^\n]*\}"$/m
  assert.equal(appended.exec(install)[0], appended.exec(nodePath)[0])
  assert.match(nodePath, /\/opt\/homebrew\/bin:\/usr\/local\/bin:\$HOME\/\.local\/bin\$\{NVM_BIN:\+:\$NVM_BIN\}:\$HOME\/\.nvm\/current\/bin/, '기본 덧붙임은 전과 같다')
  // POSIX sh, 스크립트 전체를 읽은 뒤 실행(끝이 main "$@")
  assert.match(install, /^#!\/bin\/sh\n/); assert.match(install, /\nmain "\$@"\n$/)
  const bashOnly = install.split('\n').filter((l) => !l.trim().startsWith('#') && /\[\[ |^\s*function \w|^\s*local \w|<<<|\bsource /.test(l))
  assert.deepEqual(bashOnly, [], 'bash 전용 문법 없음')
  // 안에서 부르는 명령의 표준 입력은 /dev/null(curl | sh에서 스크립트의 나머지를 먹지 않는다)
  for (const l of install.split('\n').filter((x) => /^\s*(if ! |if )?(herdr "\$@"|sh "\$(new|APP)\/scripts|node_js "\$COPY_JS"|sh -c "\$\{WHOSUP_HERDR_INSTALL_CMD|git .*clone|WHOSUP_INSTALL_KIND=)/.test(x))) assert.match(l, /<\/dev\/null/, l)
  assert.equal((install.match(/<\/dev\/null/g) || []).length >= 15, true)
  // 실행 명령과 로그인 항목은 scripts/standalone.sh를 거친다
  assert.match(sh, /^\. "\$ROOT\/scripts\/node-path\.sh"$/m); assert.match(sh, /^exec "\$WHOSUP_NODE" "\$ROOT\/scripts\/standalone\.mjs" "\$@"$/m)
  // node 고르기(후보를 하나씩 시험, nvm은 판 번호순, fnm 기본 위치)는 두 파일에 같은 줄로 있다
  const pick = (text) => text.slice(text.indexOf('# >>> node pick'), text.indexOf('# <<< node pick'))
  assert.ok(pick(nodePath).length > 500); assert.equal(pick(install), pick(nodePath))
  assert.match(pick(nodePath), /sort -t\. -k1,1nr -k2,2nr -k3,3nr/, 'nvm 폴더는 판 번호로 비교한다'); assert.match(pick(nodePath), /fnm\/aliases\/default\/bin|aliases\/default\/bin/)
  // 설치기가 만든 폴더의 표식: install.sh와 src/standalone.mjs가 같은 이름·같은 글자를 쓴다
  assert.match(install, new RegExp(`^MARK_FILE="${APP_MARK_FILE.replace(/\./g, '\\.')}"$`, 'm')); assert.match(install, new RegExp(`^MARK_TEXT="${APP_MARK}"$`, 'm'))
  // PATH가 없는 환경에서도 set -u로 죽지 않는다: $PATH를 맨몸으로 읽는 곳은 PATH에 기본값을 준 뒤뿐이다
  assert.match(install, /^ {2}USER_PATH="\$\{WHOSUP_USER_PATH:-\$\{PATH:-\}\}"\n(.*\n)? {2}PATH="\$\{PATH:-\/usr\/bin:\/bin\}"$/m); assert.match(nodePath, /PATH="\$\{PATH:\+\$PATH:\}\$WHOSUP_APPEND_PATH"/)
  assert.match(launcherText('/x'), /scripts\/standalone\.sh/); assert.match(plistText({ app: '/x', state: '/s', vars: {} }), /\/x\/scripts\/standalone\.sh/)
  // 로그인 항목이 부른 start(WHOSUP_LOGIN_START)와 새 버전으로 바꾼 뒤의 재시작은 브라우저를 열지 않는다 — 직접 고른 open은 연다
  const launchSrc = readFileSync(join(ROOT, 'scripts', 'launch.mjs'), 'utf8')
  assert.match(launchSrc, /const openBrowser = \(force = false\) => \{\n    if \(noBrowser && !force\) return\n/)
  const entry = readFileSync(join(ROOT, 'scripts', 'standalone.mjs'), 'utf8')
  assert.match(entry, /case 'start': return launch\('start', standaloneEnv\(env, home\), log, \{ noBrowser: envOn\(env\.WHOSUP_LOGIN_START\) \}\)/)
  assert.match(entry, /launch\('start', senv, note, \{ noBrowser: kind === 'update' \}\)/)
  // 시간 초과 감시: 단독 설치의 install·setup은 0이 아닌 값(124)으로 끝낸다 — 설치기가 완료로 보고 이전 버전을 지우지 않게.
  // herdr 플러그인의 build 훅(scripts/setup.mjs)은 0 그대로다(플러그인 설치를 막지 않는다)
  assert.match(entry, /if \(\['install', 'setup'\]\.includes\(process\.argv\[2\]\)\) setTimeout\(\(\) => process\.exit\(124\), watchdogMsOf\(\) \+ 120000\)\.unref\(\)/)
  assert.doesNotMatch(entry, /process\.exit\(0\)/)
  assert.match(readFileSync(join(ROOT, 'scripts', 'setup.mjs'), 'utf8'), /setTimeout\(\(\) => process\.exit\(0\), watchdogMsOf\(\)\)\.unref\(\)/)
  // 설치기가 로그인 항목을 찾는 이름은 LABEL·SERVICE로 만든 이름과 같다
  assert.ok(install.includes(`"$HOME/Library/LaunchAgents/${LABEL}.plist" "$HOME/.config/systemd/user/${SERVICE}"`))
  // 설치 기록의 판정은 표식 파일까지 본다(기록과 표식이 한 쌍 — src/standalone.mjs readRecord와 같은 조건)
  assert.match(install, /^installed\(\) \{ node_js "\$RECORD_JS" "\$DATA" "\$APP" "\$PLUGIN_ID" "\$MARK_FILE" "\$MARK_TEXT" <\/dev\/null >\/dev\/null 2>&1; \}$/m)
  // XDG 값은 절대 경로일 때만: 코어 탐침·플러그인 보드 탐침도 같은 판정을 쓴다(값을 그대로 읽는 곳이 없다)
  assert.equal((install.match(/const xdg = \(v\) => \(typeof v === "string" && path\.isAbsolute\(v\) && !\/\[\\x00-\\x1f\\x7f\]\/\.test\(v\) \? v : ""\);/g) || []).length, 2)
  assert.deepEqual(install.split('\n').filter((l) => /process\.env\.XDG_[A-Z_]+/.test(l) && !/xdg\(process\.env\.XDG_[A-Z_]+\)/.test(l)), [])
  // 단독 설치의 명령 줄은 herdr를 부르지 않는다
  const cliSrc = readFileSync(join(ROOT, 'scripts', 'standalone.mjs'), 'utf8') + readFileSync(join(ROOT, 'src', 'standalone.mjs'), 'utf8')
  assert.doesNotMatch(cliSrc, /runHerdr|findHerdr|plugin action|shell: true/)
})
