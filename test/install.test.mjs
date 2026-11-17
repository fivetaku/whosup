// 한 줄 설치기(install.sh)를 임시 HOME에서 실제로 돌린다 — 길 선택: herdr 플러그인 · herdr 없이 단독 설치 · herdr를 깔고 플러그인,
// Node 확인, 이미 깔려 있을 때, 길 강제, 파이프 실행. 단독 설치가 만든 것과 whosup 명령은 test/install-standalone.test.mjs.
// 격리 환경(임시 HOME·가짜 herdr·가짜 launchctl·빈 포트)은 test-support/install-rig.mjs — 실제 herdr·launchctl·네트워크에 닿지 않는다.
// 윈도우에는 sh가 없어 이 파일의 시험은 건너뛴다(단독 설치는 윈도우를 지원하지 않는다 — test/standalone.test.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer as httpServer } from 'node:http'
import { isAbsolute, join } from 'node:path'
import { instanceOf } from '../src/paths.mjs'
import { shown } from '../src/standalone.mjs'
import { ID, INSTALL, ROOT, SH, exe, lines, liveCore, posix, rig as bareRig, rx, shq, summaryOf, walk } from '../test-support/install-rig.mjs'
import { tmpdir as osTmpdir } from 'node:os'

// 격리 폴더는 셸이 따옴표로 싸지 않는 경로에 만든다. 임시 폴더의 경로에 공백·한글 같은 글자가 있으면 설치기와 안내 문구가 화면의 경로를 '…'로
// 싸서 내놓는데(제품의 바른 동작이다), 이 파일의 단언은 싸지 않은 경로를 글자 그대로 견준다 — TMPDIR에 따라 결과가 갈리지 않게 그때는 /tmp를 쓴다.
// 싸는 동작은 그것을 보는 시험이 그런 폴더를 따로 만들어 본다.
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'

// 아무것도 없는 기계에서 설치기는 쓸 환경을 골라 깔아 준다(고르기·깔기·이어 주기는 test/env-install.test.mjs가 본다). 이 파일의 시험이 진짜
// 앱 설치기를 부르는 일이 없게 두 앱의 설치 명령을 실패하는 대역으로 채워 두고, 이 기계에 깔린 앱(/Applications)을 보지 않게 한다.
// "터미널(herdr)" 환경의 길 — herdr를 깔고 플러그인 — 을 보는 시험은 WHOSUP_ENV=herdr를 준다(TERM_ENV).
const rig = async (o) => {
  const r = await bareRig(o), env = r.env
  // DISPLAY: 리눅스에서는 화면이 없으면 원격으로 보아 요약의 보드 줄 아래에 "포트를 넘기세요" 줄이 더 붙는다 — 책상 앞의 설치를 보도록 화면이 있는 것으로 둔다(맥에서는 쓰이지 않는다)
  r.env = (over = {}) => env({ WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), DISPLAY: ':0', ...over })
  return r
}
const TERM_ENV = { WHOSUP_ENV: 'herdr' }

test('Node: 없거나 낮으면 아무것도 깔지 않고 "무엇을 하라"를 한 줄로 알리고 1로 끝낸다', posix, async (t) => {
  // 낮은 Node: -v는 답하지만 node:sqlite를 쓰지 못한다
  const low = await rig({ node: false, herdr: true })
  exe(join(low.bin, 'node'), '#!/bin/sh\ncase "$1" in -v | --version) echo v20.11.0; exit 0 ;; esac\nexit 1\n')
  for (const [lang, want] of [['en', /^whosup: needs Node 22\.13 or newer; this is v20\.11\.0\. Update Node .*run this installer again\. Nothing was installed\.\n$/], ['ko', /^whosup: Node 22\.13 이상이 필요한데 지금은 v20\.11\.0 입니다\..*아무것도 설치하지 않았습니다\.\n$/]]) {
    const r = await low.install({ WHOSUP_LANG: lang, WHOSUP_HERDR_INSTALL_CMD: low.getHerdr })
    assert.equal(r.code, 1); assert.equal(r.out, ''); assert.match(r.err, want); assert.equal(r.err.trimEnd().split('\n').length, 1, '한 줄')
  }
  assert.deepEqual(walk(low.home), [], '아무것도 만들지 않는다'); assert.deepEqual(low.herdrCalls(), [], 'herdr도 부르지 않는다')
  // Node 없음(이 기계의 /usr/bin·/bin에 node가 있으면 가려 둘 방법이 없어 건너뛴다)
  if (existsSync('/usr/bin/node') || existsSync('/bin/node')) return t.diagnostic('system node in /usr/bin: "no node" case skipped')
  const none = await rig({ node: false, herdr: true })
  const r = await none.install({ WHOSUP_HERDR_INSTALL_CMD: none.getHerdr })
  assert.equal(r.code, 1); assert.equal(r.out, '')
  assert.match(r.err, /^whosup: needs Node 22\.13 or newer, and node is not on the PATH\. Install it from https:\/\/nodejs\.org .*Nothing was installed\.\n$/)
  assert.equal(r.err.trimEnd().split('\n').length, 1); assert.deepEqual(walk(none.home), []); assert.deepEqual(none.herdrCalls(), [])
  const ko = await none.install({ LANG: 'ko_KR.UTF-8', WHOSUP_LANG: '' })
  assert.match(ko.err, /^whosup: Node 22\.13 이상이 필요한데 PATH에 node가 없습니다\./, '로캘이 한국어면 한국어')
})

test('길 선택 (가): herdr가 있으면(0.9.0 이상) herdr 플러그인으로 설치하고, 요약에 길·보드 주소·다음에 할 일을 싣는다', posix, async () => {
  const r = await rig({ herdr: true })
  const a = await r.install()
  assert.equal(a.code, 0, a.all)
  assert.deepEqual(r.herdrCalls(), ['--version', 'plugin list', `plugin install ${ROOT} --yes`, 'session list --json'])
  assert.match(a.out, /whosup: herdr 0\.9\.5 is here: installing whosup as a herdr plugin/)
  const s = summaryOf(a.out)
  // 같은 안내는 한 번만(가-6 · F8): "herdr를 켤 때마다 보드가 뜬다"는 보드 줄 하나가 말하고, 첫 줄은 되풀이하지 않는다. 브라우저가 저절로 열리지 않는
  // 설치(OPEN_BROWSER=0)에는 그 사실이 보드 줄 아래에 한 줄. 터미널 없이 돈 설치라 첫 실행 안내가 묻지 않았다는 것도 한 줄(test/env-output.test.mjs가 자세히 본다)
  assert.match(s, /^whosup install summary\n {2}Installed as a herdr plugin \(fivetaku\.whosup\)\.\n/)
  assert.match(s, new RegExp(`The board starts whenever herdr starts: {2}http://127\\.0\\.0\\.1:${r.port} \\(next port if taken\\)\\n {4}No browser opens by itself here\\. Open that address on this computer\\.\\n {2}Next: start herdr\\. Type this in a terminal and press Enter:\\n {6}herdr\\n`))
  assert.match(s, /First-run setup: nothing was asked during this install\. The board asks on first open \(not if you have been through it before\)\.\n {2}To change any of this, use settings in the board\.\n$/)
  assert.doesNotMatch(s, /was installed too|not on your PATH/, 'herdr는 이미 있었다')
  // 단독 설치의 것은 아무것도 만들지 않는다
  assert.equal(existsSync(join(r.home, '.local')), false); assert.equal(existsSync(join(r.home, 'Library')), false); assert.deepEqual(r.ctlCalls(), [])
  // WHOSUP_REF는 herdr에 --ref로 넘긴다. 소스를 주지 않으면 GitHub 약칭을 넘긴다
  const ref = await rig({ herdr: true })
  await ref.install({ WHOSUP_REF: 'v9.9.9', WHOSUP_INSTALL_SOURCE: '' })
  assert.equal(ref.herdrCalls()[2], 'plugin install fivetaku/whosup --yes --ref v9.9.9')
  // herdr가 설치에 실패하면 그 사실을 알리고 1로 끝낸다
  const bad = await rig({ herdr: true })
  const f = await bad.install({ FAKE_HERDR_INSTALL_FAIL: '1' })
  assert.equal(f.code, 1); assert.match(f.err, /fake herdr: plugin install failed\nwhosup: herdr could not install the plugin; what it said is above\./); assert.doesNotMatch(f.out, /install summary/)
})

test('herdr 판 번호: 앞에 v가 붙어도("herdr v1.0.0") 맞게 비교한다 — 두 자리 숫자·꼬리표가 붙은 판도', posix, async () => {
  // 플러그인을 받는 판(0.9.0 이상): 플러그인 길. 적는 판 번호에서 v는 뗀다
  await Promise.all([['v1.0.0', '1.0.0'], ['v0.9.0', '0.9.0'], ['V0.9.3', '0.9.3'], ['1.0', '1.0'], ['0.10.0', '0.10.0'], ['0.9.0-beta.1', '0.9.0-beta.1']].map(async ([printed, shownAs]) => {
    const r = await rig({ herdr: true })
    const a = await r.install({ FAKE_HERDR_VERSION: printed })
    assert.equal(a.code, 0, `${printed}: ${a.all}`)
    assert.ok(a.out.includes(`whosup: herdr ${shownAs} is here: installing whosup as a herdr plugin`), `${printed}: ${a.out}`)
    assert.ok(r.herdrCalls().includes(`plugin install ${ROOT} --yes`), printed)
  }))
  // 낮은 판은 v가 붙어도 낮은 판이다
  await Promise.all(['v0.8.9', '0.8.12', 'v0.1'].map(async (printed) => {
    const r = await rig({ herdr: true })
    const a = await r.install({ FAKE_HERDR_VERSION: printed })
    assert.equal(a.code, 1, `${printed}: ${a.all}`)
    assert.ok(a.err.includes(`needs herdr 0.9.0 or newer for plugins; this is ${printed.replace(/^v/, '')}.`), `${printed}: ${a.err}`)
    assert.equal(r.herdrCalls().some((c) => c.startsWith('plugin install')), false, printed)
  }))
})

test('멈춘 herdr: herdr --version · herdr plugin list 가 끝나지 않아도 설치기는 서지 않는다 — 시간 제한 뒤 끝내고 그 사실을 알린다', posix, async () => {
  // 시간 제한은 기본 10초 — 시험에서는 1초(WHOSUP_HERDR_TIMEOUT). 멈춘 herdr로는 아무것도 깔지 않는다
  await Promise.all([['--version', 'en'], ['plugin list', 'en'], ['plugin list', 'ko']].map(async ([hang, lang]) => {
    const r = await rig({ herdr: true })
    const began = Date.now()
    const a = await r.install({ FAKE_HERDR_HANG: hang, WHOSUP_HERDR_TIMEOUT: '1', WHOSUP_LANG: lang })
    assert.equal(a.code, 1, `${hang}: ${a.all}`); assert.ok(Date.now() - began < 30000, `${hang}: 설치기가 섰다`)
    assert.match(a.err, lang === 'ko'
      ? new RegExp(`^whosup: herdr가 있지만 응답하지 않습니다\\. 1초 안에 끝나지 않아 멈춘 명령: herdr ${hang}\\. .*whosup은 설치하지 않았습니다\\.\\n$`)
      : new RegExp(`^whosup: herdr is here but did not answer: herdr ${hang} gave no answer within 1 s and was stopped\\. Check that herdr runs \\(type: herdr --version\\), then run this installer again\\. whosup was not installed\\.\\n$`))
    assert.doesNotMatch(a.out, /install summary|설치 요약/); assert.deepEqual(walk(r.home), [], '아무것도 만들지 않는다')
    assert.deepEqual(r.herdrCalls(), hang === '--version' ? ['--version'] : ['--version', 'plugin list'], '멈춘 herdr를 더 부르지 않는다')
  }))
  // herdr-core가 있으면 그 herdr는 그대로 두고 단독 설치로 간다
  const c = await rig({ herdr: true }); exe(join(c.bin, 'herdr-core'), '#!/bin/sh\nexit 0\n')
  const x = await c.install({ CI: '1', FAKE_HERDR_HANG: '--version', WHOSUP_HERDR_TIMEOUT: '1' })
  assert.equal(x.code, 0, x.all); assert.match(x.out, /whosup: herdr here did not answer \(herdr --version gave no answer within 1 s and was stopped\), so it is left alone\n/)
  assert.equal(existsSync(join(c.app, 'scripts', 'standalone.sh')), true); assert.deepEqual(c.herdrCalls(), ['--version'])
  // 값이 숫자가 아니면 기본값(10초)을 쓴다: 멈추지 않은 herdr는 평소대로 간다
  const d = await rig({ herdr: true })
  const y = await d.install({ WHOSUP_HERDR_TIMEOUT: 'soon' })
  assert.equal(y.code, 0, y.all); assert.match(summaryOf(y.out), /Installed as a herdr plugin/)
  // 양의 정수만 받는다: 0·0으로 시작하는 값·소수·음수는 기본값(10초)이다 — 멈춘 herdr를 10초 기다린 뒤 그 초를 알린다
  await Promise.all(['0', '007', '1.5', '-3', '1e3'].map(async (value) => {
    const r = await rig({ herdr: true })
    const a = await r.install({ FAKE_HERDR_HANG: '--version', WHOSUP_HERDR_TIMEOUT: value, WHOSUP_LANG: 'ko' })
    assert.equal(a.code, 1, `${value}: ${a.all}`); assert.ok(a.err.includes('10초 안에 끝나지 않아 멈춘 명령: herdr --version.'), `${value}: ${a.err}`)
  }))
  // 한국어 문구: 명령·값 뒤에 조사를 바로 붙이지 않는다("herdr --version 가", "0.9.5 이", "<폴더> 가")
  const script = readFileSync(INSTALL, 'utf8')
  assert.deepEqual(script.split('\n').filter((l) => /(\$[A-Za-z_]+|\$\{[^}]+\}) (가|은|는|을|를) /.test(l) || /\$herdr_version 이 /.test(l)), [])
})

test('이미 플러그인으로 깔려 있으면 다시 깔지 않고 그 사실과 보드 주소·상태를 알린다', posix, async () => {
  const r = await rig({ herdr: true })
  writeFileSync(join(r.base, 'plugins.txt'), `${ID}\n`)
  // 보드가 꺼져 있다
  const off = await r.install({ WHOSUP_LANG: 'ko' })
  assert.equal(off.code, 0, off.all)
  assert.deepEqual(r.herdrCalls(), ['--version', 'plugin list', 'session list --json'], 'plugin install을 부르지 않는다')
  const s = summaryOf(off.out.replace('whosup 설치 요약', 'whosup install summary'))
  assert.match(s, /이미 herdr 플러그인\(fivetaku\.whosup\)으로 설치돼 있습니다\. 다시 설치하지 않았습니다\.\n/)
  assert.match(s, new RegExp(`보드는 herdr를 켤 때마다 같이 뜹니다: {2}http://127\\.0\\.0\\.1:${r.port} \\(사용 중이면 다음 포트\\)\\n {4}여기서는 브라우저가 저절로 열리지 않습니다\\. 이 컴퓨터에서 위 주소를 여세요\\.\\n.*\\n {6}herdr\\n`))
  assert.match(s, / {6}herdr plugin install fivetaku\/whosup --yes\n/)
  // 보드가 떠 있다(herdr가 플러그인에 준 상태 폴더의 port 파일이 가리키는 곳이 /api/health에 답한다)
  // 보드의 건강 응답 모양으로 답한다: 이름과 그 상태 폴더의 표식(src/paths.mjs instanceOf). 200만 주는 다른 서버는 보드가 아니다(아래에서 본다).
  const state = join(r.home, '.state', 'herdr', 'plugins', ID)
  mkdirSync(state, { recursive: true })
  let reply = () => JSON.stringify({ ok: true, app: 'whosup', instance: instanceOf(state), pid: process.pid, readonly: false, herdr: [], targets: [] })
  const board = httpServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end(reply()) })
  const boardPort = r.port + 1
  await new Promise((ok) => board.listen(boardPort, '127.0.0.1', ok))
  try {
    writeFileSync(join(state, 'port'), `${boardPort}\n`)
    const on = await r.install()
    assert.equal(on.code, 0, on.all)
    assert.match(summaryOf(on.out), new RegExp(`Already installed as a herdr plugin \\(fivetaku\\.whosup\\)\\. Nothing was installed again\\.\\n {2}The board is running: {2}http://127\\.0\\.0\\.1:${boardPort}\\n`))
    assert.equal(r.herdrCalls().some((c) => c.startsWith('plugin install')), false)
    // 굳히기 Q3-F5: 그 포트에서 200을 주는 것이 후즈업 보드가 아니면(다른 서버 · 다른 상태 폴더의 후즈업 · 옛 모양인데 pid 파일이 없다)
    // "보드가 켜져 있습니다"라고 하지 않는다
    const good = reply
    for (const [why, body] of [['다른 서버', '{}'], ['JSON이 아니다', '<html>ok</html>'], ['다른 상태 폴더의 보드', JSON.stringify({ ok: true, app: 'whosup', instance: instanceOf(join(r.base, 'elsewhere')), pid: process.pid, readonly: false, herdr: [], targets: [] })],
      ['이름이 다르다', JSON.stringify({ ok: true, app: 'other', instance: instanceOf(state), readonly: false, targets: [] })], ['옛 모양인데 pid 파일이 없다', JSON.stringify({ ok: true, readonly: false, herdr: [], targets: [] })]]) {
      reply = () => body
      const other = await r.install()
      assert.equal(other.code, 0, other.all); assert.doesNotMatch(summaryOf(other.out), /The board is running/, why)
      assert.match(summaryOf(other.out), new RegExp(`The board starts whenever herdr starts: {2}http://127\\.0\\.0\\.1:${r.port} `), why)
    }
    // 이름·표식을 싣기 전 판의 보드(새 버전으로 바꾼 직후에는 이전 버전의 보드가 아직 돌고 있다): pid 파일의 프로세스가 살아 있을 때만 보드로 본다
    writeFileSync(join(state, 'server.pid'), String(process.pid))
    const legacy = await r.install()
    assert.match(summaryOf(legacy.out), new RegExp(`The board is running: {2}http://127\\.0\\.0\\.1:${boardPort}\\n`))
    writeFileSync(join(state, 'server.pid'), ''); reply = good
    // XDG_STATE_HOME이 상대 경로면 없는 것으로 본다: 지금 폴더 기준의 port 파일을 읽지 않고 기본 위치(~/.local/state/herdr)를 본다 — 거기에는 보드가 없다
    const relState = join(r.base, 'rel', 'herdr', 'plugins', ID)
    mkdirSync(relState, { recursive: true }); writeFileSync(join(relState, 'port'), `${boardPort}\n`)
    const rel = await r.install({ XDG_STATE_HOME: 'rel' })
    assert.equal(rel.code, 0, rel.all); assert.doesNotMatch(summaryOf(rel.out), /The board is running/)
    assert.match(summaryOf(rel.out), new RegExp(`The board starts whenever herdr starts: {2}http://127\\.0\\.0\\.1:${r.port} `))
  } finally { await new Promise((ok) => board.close(ok)) }
  // 그 위에 단독 설치를 억지로 더하지 않는다
  const forced = await r.install({ WHOSUP_INSTALL_MODE: 'standalone' })
  assert.equal(forced.code, 1); assert.match(forced.err, /already runs here as a herdr plugin .* the standalone install was not added/); assert.equal(existsSync(r.app), false)
})

test('길 선택 (나): herdr는 없고 herdr-core가 있으면(살아 있는 소켓 · PATH의 herdr-core·hc · 꺼진 코어의 흔적 core.lock) herdr 없이 단독 설치', posix, async () => {
  // 살아 있는 코어 소켓(세션 이름이 default가 아니어도 — 오비스 앱의 코어처럼)
  const sock = await rig()
  const core = await liveCore(sock)
  try {
    const a = await sock.install({ CI: '1' })
    assert.equal(a.code, 0, a.all)
    assert.match(a.out, /whosup: herdr-core is running here and there is no herdr: installing whosup on its own \(standalone\), no herdr needed/)
    assert.equal(existsSync(join(sock.app, 'scripts', 'standalone.sh')), true); assert.deepEqual(sock.herdrCalls(), [], 'herdr를 깔지도 부르지도 않는다')
    assert.match(summaryOf(a.out), /Installed on its own, without herdr \(standalone\)\./)
    assert.deepEqual(core.calls, [], '코어 소켓에는 붙어 보기만 한다(아무것도 보내지 않는다)')
  } finally { await core.close() }
  // 꺼진 코어의 흔적(core.lock은 있는데 듣는 것이 없다 — 자기 코어를 띄우는 앱만 쓰는 사람이 앱을 꺼 둔 채 설치): herdr를 깔지 않고 단독 설치.
  // 진행 줄은 "켜져 있다"고 하지 않고 사실대로 말한다(전에는 이 경우를 herdr-core 없음으로 보아 (다)로 갔다)
  const lockOnly = (r, session) => { const dir = join(r.home, '.state', 'herdr-core', session); mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'core.lock'), `${join(r.base, 'gone.sock')}\n`) }
  const dead = await rig(); lockOnly(dead, 'appcore')
  const d = await dead.install({ CI: '1', WHOSUP_HERDR_INSTALL_CMD: dead.getHerdr })
  assert.equal(d.code, 0, d.all)
  assert.match(d.out, /whosup: an app that uses herdr-core has run on this computer and is not running now: installing whosup on its own \(standalone\), no herdr needed\. Start that app and its sessions show on the board\n/)
  assert.doesNotMatch(d.out, /herdr-core is running|installing herdr|herdr-core \(/); assert.match(summaryOf(d.out), /Installed on its own, without herdr \(standalone\)\./)
  assert.equal(existsSync(join(dead.app, 'scripts', 'standalone.sh')), true); assert.equal(existsSync(join(dead.home, '.local', 'bin', 'herdr')), false, 'herdr를 깔지 않는다'); assert.deepEqual(dead.herdrCalls(), [])
  const deadKo = await rig(); lockOnly(deadKo, 'default')
  const dk = await deadKo.install({ CI: '1', WHOSUP_LANG: 'ko' })
  assert.equal(dk.code, 0, dk.all); assert.match(dk.out, /whosup: herdr-core를 쓰는 앱을 이 컴퓨터에서 쓴 적이 있고 지금은 꺼져 있습니다: herdr 없이 단독으로 설치합니다\. 그 앱을 켜면 세션이 보드에 보입니다\n/)
  // 살아 있는 코어가 하나라도 있으면(다른 코어의 흔적이 같이 있어도) "켜져 있다"고 말한다
  const mixed = await rig(); lockOnly(mixed, 'gone')
  const mixedCore = await liveCore(mixed)
  try {
    const m = await mixed.install({ CI: '1' })
    assert.equal(m.code, 0, m.all); assert.match(m.out, /whosup: herdr-core is running here and there is no herdr/); assert.doesNotMatch(m.out, /is not running now/)
  } finally { await mixedCore.close() }
  // 흔적이 아닌 것: core.lock 없이 남은 소켓 파일, 죽은 HC_SOCKET → herdr-core가 아니다 → (다)로 간다
  const stale = await rig()
  mkdirSync(join(stale.home, '.state', 'herdr-core', 'default'), { recursive: true }); writeFileSync(join(stale.home, '.state', 'herdr-core', 'default', 'core.sock'), '')
  const so = await stale.install({ CI: '1', HC_SOCKET: join(stale.home, '.state', 'herdr-core', 'default', 'core.sock'), ...TERM_ENV })
  assert.equal(so.code, 1); assert.match(so.out, /herdr is not here: installing herdr/); assert.equal(existsSync(stale.app), false)
  // XDG_STATE_HOME이 상대 경로이거나 제어 문자가 든 값이면 없는 것으로 본다(지금 폴더 기준의 폴더를 뒤지지 않는다): 그 자리에 흔적이 있어도
  // herdr-core가 아니다 → (다)로 간다. 같은 흔적이 절대 경로의 상태 폴더에 있으면 단독 설치다(위의 dead)
  await Promise.all(['rel', '.', 'a\nb'].map(async (name) => {
    const x = await rig()
    const bad = name === 'a\nb' ? join(x.base, name) : name
    const dir = join(isAbsolute(bad) ? bad : join(x.base, bad), 'herdr-core', 'appcore')
    mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'core.lock'), `${join(x.base, 'gone.sock')}\n`)
    const a = await x.install({ CI: '1', XDG_STATE_HOME: bad, ...TERM_ENV })
    assert.equal(a.code, 1, `${JSON.stringify(bad)}: ${a.all}`); assert.match(a.out, /herdr is not here: installing herdr/, JSON.stringify(bad)); assert.equal(existsSync(x.app), false)
  }))
  // 길 고르기의 순서는 그대로다: herdr가 있으면(플러그인을 받는 판) 흔적이 있어도 플러그인 길
  const both = await rig({ herdr: true }); lockOnly(both, 'appcore')
  const bo = await both.install()
  assert.equal(bo.code, 0, bo.all); assert.ok(both.herdrCalls().includes(`plugin install ${ROOT} --yes`)); assert.equal(existsSync(both.app), false)
  // PATH의 herdr-core
  const named = await rig(); exe(join(named.bin, 'herdr-core'), '#!/bin/sh\nexit 0\n')
  const n = await named.install({ CI: '1' })
  assert.equal(n.code, 0, n.all); assert.match(n.out, /herdr-core \(herdr-core\) is here and there is no herdr/); assert.equal(existsSync(named.app), true)
  // PATH의 hc: --version이 "hc <판>"이라고 답할 때만(같은 이름의 다른 프로그램은 아니다). --version 말고는 돌리지 않는다(다른 명령은 꺼진 코어를 켠다)
  const hc = await rig(); exe(join(hc.bin, 'hc'), `#!/bin/sh\necho "$*" >> ${shq(join(hc.base, 'hc.log'))}\necho "hc 0.4.2"\n`)
  const h = await hc.install({ CI: '1' })
  assert.equal(h.code, 0, h.all); assert.match(h.out, /herdr-core \(hc\) is here/); assert.equal(existsSync(hc.app), true); assert.deepEqual(lines(join(hc.base, 'hc.log')), ['--version'])
  const other = await rig(); exe(join(other.bin, 'hc'), '#!/bin/sh\necho "hc: an http client"\n')
  const o = await other.install({ CI: '1', ...TERM_ENV })
  assert.equal(o.code, 1); assert.match(o.out, /herdr is not here: installing herdr/); assert.equal(existsSync(other.app), false)
  // 플러그인을 받지 못하는 옛 herdr + herdr-core: herdr는 그대로 두고 단독 설치. 옛 herdr뿐이면 올리라고 알리고 끝낸다
  const old = await rig({ herdr: true }); exe(join(old.bin, 'herdr-core'), '#!/bin/sh\nexit 0\n')
  const oc = await old.install({ CI: '1', FAKE_HERDR_VERSION: '0.8.9' })
  assert.equal(oc.code, 0, oc.all); assert.match(oc.out, /herdr 0\.8\.9 here is older than 0\.9\.0 and cannot take plugins, so it is left alone/); assert.equal(existsSync(old.app), true)
  assert.equal(old.herdrCalls().some((c) => c.startsWith('plugin install')), false)
  const oldOnly = await rig({ herdr: true })
  const oo = await oldOnly.install({ FAKE_HERDR_VERSION: '0.8.9', WHOSUP_HERDR_INSTALL_CMD: oldOnly.getHerdr })
  assert.equal(oo.code, 1); assert.match(oo.err, /needs herdr 0\.9\.0 or newer for plugins; this is 0\.8\.9\. Update herdr \(https:\/\/herdr\.dev\/docs\/install\/\)/)
  assert.equal(existsSync(join(oldOnly.home, '.local')), false, '새 herdr를 따로 깔지 않는다(옛 것이 PATH에서 가린다)')
})

test('길 선택 (다): 아무것도 없는 기계에서 터미널 환경(WHOSUP_ENV=herdr)이면 herdr를 설치한 뒤(~/.local/bin, PATH에 넣고 다시 확인) 플러그인으로 — 실패하면 이유와 수동 설치 주소', posix, async () => {
  const r = await rig()
  const a = await r.install({ WHOSUP_HERDR_INSTALL_CMD: r.getHerdr, ...TERM_ENV })
  assert.equal(a.code, 0, a.all)
  // herdr의 설치기가 찍은 것("installed herdr to …")은 성공하면 보여 주지 않는다 — "herdr <판> 설치함" 한 줄이 대신한다(가-6 · F8)
  assert.match(a.out, new RegExp(`whosup: herdr is not here: installing herdr \\(https://herdr\\.dev\\) into ${rx(r.home)}/\\.local/bin first\\nwhosup: herdr 0\\.9\\.5 installed\\n`))
  assert.doesNotMatch(a.all, /installed herdr to/)
  assert.deepEqual(r.herdrCalls(), ['--version', 'plugin list', `plugin install ${ROOT} --yes`, 'session list --json'], '방금 깐 herdr로 플러그인을 설치한다')
  const s = summaryOf(a.out)
  assert.match(s, /Installed as a herdr plugin \(fivetaku\.whosup\)\./); assert.match(s, new RegExp(`herdr 0\\.9\\.5 was installed too, into ${r.home}/\\.local/bin\\.`))
  // 그 폴더가 사람의 PATH에 없으면(가-5 · F7): 칠 명령을 전체 경로로 적고(그대로 치면 된다), 그 아래에 "새로 여는 터미널부터 짧은 이름으로 쓰게
  // PATH에 넣는 법"을 한 번 알린다(셸 설정 파일은 고치지 않는다). 전에는 "PATH에 넣고 새 터미널을 여세요" 바로 아래에 "herdr 를 치세요"가 왔다
  assert.match(s, new RegExp(`Next: start herdr\\. Type this in a terminal and press Enter:\\n {6}${rx(r.home)}/\\.local/bin/herdr\\n {2}${rx(r.home)}/\\.local/bin is not on your PATH, so herdr is spelled with its full path above \\(it runs as it is\\)\\. To type just herdr in terminals you open from now on, type this once:\\n {6}echo 'export PATH="${rx(r.home)}/\\.local/bin:\\$PATH"' >> ~/\\.profile\\n`))
  assert.doesNotMatch(s, /^ {6}herdr$/m, '짧은 이름만 적은 줄은 없다(그 PATH로는 실행되지 않는다)'); assert.doesNotMatch(s, /open a new terminal/)
  assert.deepEqual(walk(r.home), ['.local', '.local/bin', '.local/bin/herdr'], 'herdr 말고는 아무것도 만들지 않는다')
  // 넣을 파일은 사람의 셸이 읽는 것이다: zsh(macOS의 기본 셸)는 ~/.profile을 읽지 않는다 → ~/.zshrc. bash는 macOS에서 ~/.bash_profile, 그 밖에서는 ~/.bashrc
  for (const [shell, file] of [['/bin/zsh', '~/.zshrc'], ['/opt/homebrew/bin/zsh', '~/.zshrc'], ['/bin/bash', process.platform === 'darwin' ? '~/.bash_profile' : '~/.bashrc'], ['/usr/bin/fish', '~/.profile']]) {
    const z = await rig()
    const zo = await z.install({ WHOSUP_HERDR_INSTALL_CMD: z.getHerdr, SHELL: shell, CI: '1', ...TERM_ENV })
    assert.equal(zo.code, 0, zo.all)
    const hint = summaryOf(zo.out).split('\n').find((l) => l.includes('export PATH='))
    assert.ok(hint.endsWith(`:$PATH"' >> ${file}`), `${shell}: ${hint}`)
  }
  const zd = await rig()
  const zdo = await zd.install({ WHOSUP_HERDR_INSTALL_CMD: zd.getHerdr, SHELL: '/bin/zsh', ZDOTDIR: join(zd.home, '.zsh'), CI: '1', ...TERM_ENV })
  assert.ok(summaryOf(zdo.out).split('\n').find((l) => l.includes('export PATH=')).endsWith(` >> ${shown(join(zd.home, '.zsh', '.zshrc'))}`), 'ZDOTDIR이 있으면 그 폴더의 .zshrc')
  // 붙여 넣는 명령에 들어가는 경로는 셸 인용한다: 폴더 이름에 공백·따옴표·$·백틱·\ 가 있어도, 그 줄을 그대로 셸에 넣으면 그 폴더가 PATH에 들어간다
  for (const [i, name] of ['my dir', `it's "q" $HOME \`id\` b\\s; echo x`].entries()) {
    const odd = await rig()
    const dir = join(odd.base, name), zdot = join(odd.base, `z ${i}'s`)
    const put = `mkdir -p "$HERDR_INSTALL_DIR" && cp ${shq(join(odd.base, 'herdr-wrapper'))} "$HERDR_INSTALL_DIR/herdr" && chmod 755 "$HERDR_INSTALL_DIR/herdr"`
    const oo = await odd.install({ WHOSUP_HERDR_INSTALL_CMD: put, HERDR_INSTALL_DIR: dir, SHELL: '/bin/zsh', ZDOTDIR: zdot, CI: '1', ...TERM_ENV })
    assert.equal(oo.code, 0, oo.all)
    const hint = summaryOf(oo.out).split('\n').find((l) => l.includes('export PATH=')).trim()
    assert.ok(hint.endsWith(` >> ${shown(join(zdot, '.zshrc'))}`), hint)
    // 그 줄을 그대로 돌린다(셸 설정 파일의 폴더만 만들어 둔다) → 적힌 파일을 읽은 셸의 PATH 첫 폴더가 그 폴더다. 다른 명령은 돌지 않는다
    mkdirSync(zdot)
    for (const shell of ['/bin/sh', '/bin/dash', '/bin/bash', '/bin/zsh'].filter((x) => existsSync(x))) {
      writeFileSync(join(zdot, '.zshrc'), '')
      assert.equal(execFileSync(shell, ['-c', hint], { encoding: 'utf8', cwd: odd.base }), '', `${shell}: ${hint}`)
      assert.equal(execFileSync(shell, ['-c', '. "$1"; printf %s "$PATH"', 'sh', join(zdot, '.zshrc')], { env: { PATH: '/usr/bin:/bin', HOME: odd.home }, encoding: 'utf8' }), `${dir}:/usr/bin:/bin`, `${shell}: ${hint}`)
    }
  }
  // PATH에 이미 있으면 그 안내는 없다
  const onPath = await rig()
  const b = await onPath.install({ WHOSUP_HERDR_INSTALL_CMD: onPath.getHerdr, PATH: `${onPath.bin}:${onPath.home}/.local/bin:/usr/bin:/bin`, ...TERM_ENV })
  assert.equal(b.code, 0, b.all); assert.doesNotMatch(b.out, /not on your PATH/); assert.match(summaryOf(b.out), /press Enter:\n {6}herdr\n/, 'PATH에 있으면 짧은 이름 그대로')
  // 설치 명령이 실패한다 / 0으로 끝났는데 herdr가 없다(공식 스크립트는 그럴 수 있다): 이유와 수동 설치 주소, 1로 끝낸다
  for (const cmd of ['false', 'true']) {
    const f = await rig()
    const x = await f.install({ WHOSUP_HERDR_INSTALL_CMD: cmd, WHOSUP_LANG: cmd === 'true' ? 'ko' : 'en', ...TERM_ENV })
    assert.equal(x.code, 1, cmd); assert.doesNotMatch(x.out, /install summary|설치 요약/); assert.deepEqual(walk(f.home), [])
    assert.match(x.err, cmd === 'true' ? /herdr를 설치하지 못했습니다\(설치 스크립트 종료 코드 0.*https:\/\/herdr\.dev\/docs\/install\/.*whosup은 설치하지 않았습니다\./ : /herdr did not install \(its installer ended with 1; .*Install it yourself \(https:\/\/herdr\.dev\/docs\/install\/\).*whosup was not installed\./)
  }
})

test('길 강제: WHOSUP_INSTALL_MODE=plugin|standalone이 기계 상태를 이긴다. 모르는 값은 거절한다', posix, async () => {
  // herdr가 있어도 standalone
  const a = await rig({ herdr: true })
  const sa = await a.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1' })
  assert.equal(sa.code, 0, sa.all); assert.equal(existsSync(join(a.app, 'bin', 'whosup.mjs')), true); assert.equal(a.herdrCalls().some((c) => c.startsWith('plugin install')), false)
  // 아무것도 없어도 standalone(herdr를 깔지 않는다)
  const b = await rig()
  const sb = await b.install({ WHOSUP_INSTALL_MODE: 'standalone', CI: '1', WHOSUP_HERDR_INSTALL_CMD: b.getHerdr })
  assert.equal(sb.code, 0, sb.all); assert.equal(existsSync(b.app), true); assert.equal(existsSync(join(b.home, '.local', 'bin', 'herdr')), false)
  // herdr-core가 있어도 plugin(herdr가 없으면 깔고 나서)
  const c = await rig(); exe(join(c.bin, 'herdr-core'), '#!/bin/sh\nexit 0\n')
  const pc = await c.install({ WHOSUP_INSTALL_MODE: 'plugin', WHOSUP_HERDR_INSTALL_CMD: c.getHerdr })
  assert.equal(pc.code, 0, pc.all); assert.ok(c.herdrCalls().includes(`plugin install ${ROOT} --yes`)); assert.equal(existsSync(c.app), false)
  // 모르는 값
  const d = await rig({ herdr: true })
  const bad = await d.install({ WHOSUP_INSTALL_MODE: 'docker' })
  assert.equal(bad.code, 1); assert.match(bad.err, /WHOSUP_INSTALL_MODE=docker is not a path this installer knows: use plugin or standalone/); assert.deepEqual(d.herdrCalls(), [])
})

test('파이프 실행(curl … | sh): 스크립트를 표준 입력으로 받아도 끝까지 돌고 요약을 찍는다 — 안에서 부르는 명령은 /dev/null을 읽는다', posix, async () => {
  const script = readFileSync(INSTALL, 'utf8')
  // 플러그인 길: 가짜 herdr가 표준 입력을 끝까지 읽어도 스크립트의 나머지를 먹지 못한다(0바이트)
  const p = await rig({ herdr: true })
  const a = await p.run(SH, [], { FAKE_HERDR_READ_STDIN: '1' }, { input: script })
  assert.equal(a.code, 0, a.all); assert.match(summaryOf(a.out), /^whosup install summary\n {2}Installed as a herdr plugin/)
  const read = lines(p.herdrLog).map((l) => JSON.parse(l)).filter((x) => !Array.isArray(x))
  assert.ok(read.length >= 3); assert.deepEqual([...new Set(read.map((x) => x.stdin))], [0], 'herdr는 /dev/null을 읽었다')
  // herdr를 깔고 가는 길
  const n = await rig()
  const b = await n.run(SH, [], { WHOSUP_HERDR_INSTALL_CMD: `cat >/dev/null; ${n.getHerdr}`, ...TERM_ENV }, { input: script })
  assert.equal(b.code, 0, b.all); assert.match(summaryOf(b.out), /Installed as a herdr plugin/, 'herdr 설치 명령이 표준 입력을 읽어도 스크립트는 남는다')
  // 단독 설치 길
  const s = await rig()
  const c = await s.run(SH, [], { WHOSUP_INSTALL_MODE: 'standalone', CI: '1' }, { input: script })
  assert.equal(c.code, 0, c.all); assert.match(summaryOf(c.out), /^whosup install summary\n {2}Installed on its own, without herdr \(standalone\)\./); assert.equal(existsSync(s.launcher), true)
  // 받은 소스가 단독 설치를 모르는 판이면 아무것도 바꾸지 않는다
  const old = await rig()
  const src = join(old.base, 'oldsrc'); mkdirSync(src); writeFileSync(join(src, 'herdr-plugin.toml'), 'id = "fivetaku.whosup"\n')
  const d = await old.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_INSTALL_SOURCE: src })
  assert.equal(d.code, 1); assert.match(d.err, /has no standalone install \(scripts\/standalone\.sh is missing\)\. Nothing was changed\./)
  assert.deepEqual(walk(old.home).filter((p2) => /app/.test(p2)), [], 'app.new를 남기지 않는다')
})
