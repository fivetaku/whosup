// 한 줄 설치기(install.sh)가 화면에 남기는 것 — 가-5(F7) PATH · 가-6(F8) 출력 줄이기. 임시 HOME에서 설치기를 실제로 돌린다.
//   F7  herdr가 있는 폴더가 사람의 PATH에 없으면 요약의 명령을 전체 경로로 적는다: 그 줄을 그대로 셸에 넣으면 그 herdr가 돈다.
//       PATH에 넣는 법은 한 번, "새로 여는 터미널부터 짧은 이름으로"라는 뜻으로. PATH에 있으면 짧은 이름 그대로.
//   F8  설치기가 대신 돌리는 것(herdr의 설치기 · herdr plugin install)의 출력은 성공하면 한 줄로 줄이고 실패하면 전부 보여 준다.
//       같은 안내("herdr를 켜세요" · "herdr를 켤 때마다 보드가 뜹니다" · 바꾸는 곳)는 화면 전체에서 한 번.
// 격리 환경은 test-support/install-rig.mjs(가짜 herdr·좁은 PATH·임시 HOME). 터미널이 있는 설치는 script 명령의 가짜 터미널에서 돌리고,
// 그때의 가짜 herdr는 진짜 herdr처럼 build 훅으로 이 저장소의 scripts/setup.mjs --install 을 돌린다(첫 실행 안내가 그 터미널에 직접 쓴다).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { instanceOf } from '../src/paths.mjs'
import { shown } from '../src/standalone.mjs'
import { ID, INSTALL, ROOT, SH, exe, mac, posix, rig as bareRig, rx, shq, summaryOf } from '../test-support/install-rig.mjs'
import { tmpdir as osTmpdir } from 'node:os'

// 격리 폴더는 셸이 따옴표로 싸지 않는 경로에 만든다. 임시 폴더의 경로에 공백·한글 같은 글자가 있으면 설치기와 안내 문구가 화면의 경로를 '…'로
// 싸서 내놓는데(제품의 바른 동작이다), 이 파일의 단언은 싸지 않은 경로를 글자 그대로 견준다 — TMPDIR에 따라 결과가 갈리지 않게 그때는 /tmp를 쓴다.
// 싸는 동작은 그것을 보는 시험이 그런 폴더를 따로 만들어 본다.
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'

const FAKE_HERDR = join(ROOT, 'test-support', 'fake-herdr-install.mjs')
// 이 파일의 시험이 진짜 앱 설치기를 부르는 일이 없게(아무것도 없는 기계의 환경 고르기) 두 앱의 설치 명령을 실패하는 대역으로 채운다.
const rig = async (o) => {
  const r = await bareRig(o), env = r.env
  // DISPLAY: 리눅스에서는 화면이 없으면 원격으로 보아 요약에 "포트를 넘기세요" 줄이 더 붙는다 — 책상 앞의 설치를 보도록 화면이 있는 것으로 둔다(맥에서는 쓰이지 않는다)
  r.env = (over = {}) => env({ WHOSUP_HERDR_APP_INSTALL_CMD: 'false', WHOSUP_OVIS_APP_INSTALL_CMD: 'false', WHOSUP_SYSTEM_APPS: join(r.base, 'no-apps'), DISPLAY: ':0', ...over })
  r.tmpLeft = () => readdirSync(join(r.base, 't'))
  // 사람의 PATH(설치기를 돌린 셸의 PATH)로 명령 한 줄을 그대로 돌린다
  r.type = (cmd, path = `${r.bin}:/usr/bin:/bin`) => spawnSync('/bin/sh', ['-c', cmd], { env: { ...r.env(), PATH: path }, cwd: r.base, encoding: 'utf8', timeout: 20000 })
  return r
}
const TERM_ENV = { WHOSUP_ENV: 'herdr' }
// 진짜 herdr처럼 말이 많은 herdr: `plugin install`이면 설치 내역 미리보기(PREVIEW줄)를 찍고, build = true면 build 훅(첫 실행 안내)을 돌린 뒤
// 가짜 herdr에 넘긴다(그것이 "Installed plugin <id>" 한 줄을 찍는다 — 실패시키면 stderr에 한 줄).
const PREVIEW = 31
const noisyHerdr = ({ build = false } = {}) => `#!/bin/sh
if [ "\${1:-} \${2:-}" = "plugin install" ]; then
  echo "Plugin install preview:"
  i=1; while [ "$i" -lt ${PREVIEW} ]; do echo "    action a$i: sh scripts/plugin.sh a$i"; i=$((i + 1)); done
  ${build ? `WHOSUP_INSTALLER_PID=$$ ${shq(process.execPath)} ${shq(join(ROOT, 'scripts', 'setup.mjs'))} --install >/dev/null 2>&1` : ':'}
fi
exec ${shq(process.execPath)} ${shq(FAKE_HERDR)} "$@"
`
const count = (text, re) => text.split('\n').filter((l) => re.test(l)).length
const NEXT = /^\s*(Next|다음에 할 일)\s*:/
const HERDR_LINE = /^\s+(\S*\/)?herdr'?\s*$/
const WHENEVER = /whenever herdr starts|herdr starts the board whenever|starts with herdr every time|herdr를 켤 때마다|herdr를 켤 때 보드가/
const CHANGE = /To change any of this|바꾸려면 보드의 설정에서/
// "다음에 할 일" 줄 바로 아래의 명령(들여 쓴 한 줄)
const nextCommand = (text) => { const rows = text.split('\n'); const i = rows.findIndex((l) => NEXT.test(l)); return i < 0 ? null : rows[i + 1].trim() }

test('PATH(가-5): herdr를 깐 폴더가 사람의 PATH에 없으면 "다음에 할 일"의 명령을 전체 경로로 적는다 — 그 줄을 그대로 치면 그 herdr가 돌고, PATH에 넣는 법은 한 번만 "새로 여는 터미널부터"로 말한다', posix, async () => {
  for (const lang of ['en', 'ko']) {
    const r = await rig()
    const a = await r.install({ WHOSUP_HERDR_INSTALL_CMD: r.getHerdr, WHOSUP_LANG: lang, ...TERM_ENV })
    assert.equal(a.code, 0, a.all)
    const full = join(r.home, '.local', 'bin', 'herdr')
    const cmd = nextCommand(a.out)
    assert.equal(cmd, full, a.out)
    // 안내한 명령 문자열을 사람의 PATH로 그대로 돌리면 대역 herdr가 돈다(짧은 이름으로는 그 PATH에서 실행되지 않는다)
    const before = r.herdrCalls().length
    const ran = r.type(cmd)
    assert.ok(![126, 127].includes(ran.status), `${cmd}: ${ran.status} ${ran.stderr}`); assert.equal(r.herdrCalls().length, before + 1, '그 herdr가 불렸다'); assert.equal(r.herdrCalls().at(-1), '', '인자 없이')
    assert.equal(r.type('herdr').status, 127, '짧은 이름은 그 PATH에 없다')
    // 화면 전체에서 herdr를 치라는 줄은 그 하나, PATH 안내도 하나이고 명령 아래에 온다. "넣은 뒤 새 터미널을 여세요"처럼 지금 칠 명령과 어긋나는 말은 없다
    const rows = a.out.split('\n')
    assert.deepEqual(rows.filter((l) => HERDR_LINE.test(l)), [`      ${full}`]); assert.equal(count(a.out, NEXT), 1)
    const hint = rows.findIndex((l) => /is not on your PATH|PATH에 없어/.test(l))
    assert.equal(count(a.out, /is not on your PATH|PATH에 없어/), 1); assert.ok(hint > rows.indexOf(`      ${full}`), 'PATH 안내는 명령 아래에')
    assert.match(rows[hint], lang === 'ko'
      ? new RegExp(`^ {2}${rx(r.home)}/\\.local/bin 폴더가 PATH에 없어 위에서는 herdr 를 전체 경로로 적었습니다\\(그대로 치면 됩니다\\)\\. 새로 여는 터미널부터 herdr 만 쳐도 되게 하려면 아래를 한 번 치세요:$`)
      : new RegExp(`^ {2}${rx(r.home)}/\\.local/bin is not on your PATH, so herdr is spelled with its full path above \\(it runs as it is\\)\\. To type just herdr in terminals you open from now on, type this once:$`))
    assert.match(rows[hint + 1], /^ {6}echo 'export PATH=".*\/\.local\/bin:\$PATH"' >> ~\/\.profile$/)
    assert.doesNotMatch(a.out, /open a new terminal|새 터미널을 여세요|Add it, then/)
    // 그 한 줄(PATH에 넣기)을 그대로 돌린 뒤 그 설정 파일을 읽은 셸에서는 짧은 이름으로 실행된다
    const put = rows[hint + 1].trim()
    assert.equal(r.type(put.replace('~/.profile', shq(join(r.base, 'profile')))).status, 0)
    assert.equal(r.type(`. ${shq(join(r.base, 'profile'))}; command -v herdr`).stdout.trim(), full)
  }
  // 사람의 PATH는 설치기가 덧붙이기 전의 것이다(WHOSUP_USER_PATH가 있으면 그것): 거기에 그 폴더가 있으면 짧은 이름, 없으면 전체 경로
  const on = await rig()
  const b = await on.install({ WHOSUP_HERDR_INSTALL_CMD: on.getHerdr, PATH: `${on.bin}:${on.home}/.local/bin:/usr/bin:/bin`, ...TERM_ENV })
  assert.equal(b.code, 0, b.all); assert.equal(nextCommand(b.out), 'herdr'); assert.doesNotMatch(b.out, /not on your PATH|full path/)
  assert.ok(![126, 127].includes(on.type('herdr', `${on.bin}:${on.home}/.local/bin:/usr/bin:/bin`).status), 'PATH에 있으면 짧은 이름이 실행된다')
  const told = await rig()
  const c = await told.install({ WHOSUP_HERDR_INSTALL_CMD: told.getHerdr, WHOSUP_USER_PATH: `/usr/bin:${told.home}/.local/bin`, ...TERM_ENV })
  assert.equal(c.code, 0, c.all); assert.equal(nextCommand(c.out), 'herdr', 'WHOSUP_USER_PATH에 그 폴더가 있다')
  const hidden = await rig()
  const d = await hidden.install({ WHOSUP_HERDR_INSTALL_CMD: hidden.getHerdr, WHOSUP_USER_PATH: '/usr/bin:/bin', PATH: `${hidden.bin}:${hidden.home}/.local/bin:/usr/bin:/bin`, ...TERM_ENV })
  assert.equal(d.code, 0, d.all); assert.equal(nextCommand(d.out), join(hidden.home, '.local', 'bin', 'herdr'), '설치기의 PATH에는 있어도 사람의 PATH에 없으면 전체 경로')
})

test('PATH(가-5): 방금 깐 herdr만이 아니다 — 설치기가 덧붙인 폴더에서 찾은 herdr도 사람의 PATH에 없으면 전체 경로로 적는다(이미 깔려 있다는 요약의 명령도). 공백·따옴표가 든 경로는 셸의 한 낱말로 싼다', posix, async () => {
  // herdr가 사람의 PATH 밖(WHOSUP_EXTRA_PATH — 설치기가 PATH 뒤에 덧붙여 찾는 폴더)에 있다: 플러그인 길, 명령은 전체 경로
  const r = await rig()
  const extra = join(r.base, 'extra'); mkdirSync(extra)
  exe(join(extra, 'herdr'), `#!/bin/sh\nexec ${shq(process.execPath)} ${shq(FAKE_HERDR)} "$@"\n`)
  const a = await r.install({ WHOSUP_EXTRA_PATH: extra })
  assert.equal(a.code, 0, a.all); assert.ok(r.herdrCalls().includes(`plugin install ${ROOT} --yes`)); assert.doesNotMatch(a.out, /was installed too/)
  assert.equal(nextCommand(a.out), join(extra, 'herdr')); assert.equal(count(a.out, /is not on your PATH/), 1); assert.match(a.out, new RegExp(` {2}${rx(extra)} is not on your PATH`))
  const n = r.herdrCalls().length
  assert.ok(![126, 127].includes(r.type(nextCommand(a.out)).status)); assert.equal(r.herdrCalls().length, n + 1)
  // 다시 돌린 설치(이미 플러그인으로 깔려 있다): "다음에 할 일"과 "다시 설치하려면"의 명령 둘 다 전체 경로, PATH 안내는 한 번
  const again = await r.install({ WHOSUP_EXTRA_PATH: extra })
  assert.equal(again.code, 0, again.all)
  const s = summaryOf(again.out)
  assert.match(s, /Already installed as a herdr plugin/); assert.equal(nextCommand(s), join(extra, 'herdr'))
  assert.ok(s.includes(`      ${join(extra, 'herdr')} plugin install fivetaku/whosup --yes\n`), s); assert.equal(count(s, /is not on your PATH/), 1)
  assert.doesNotMatch(s, /^ {6}herdr( |$)/m, '짧은 이름으로 적은 명령은 없다')
  // PATH에 있는 herdr(보통의 경우)는 전과 같이 짧은 이름이다
  const plain = await rig({ herdr: true })
  writeFileSync(join(plain.base, 'plugins.txt'), `${ID}\n`)
  const p = summaryOf((await plain.install()).out)
  assert.equal(nextCommand(p), 'herdr'); assert.ok(p.includes('      herdr plugin install fivetaku/whosup --yes\n')); assert.doesNotMatch(p, /is not on your PATH/)
  // 폴더 이름에 공백·작은따옴표·$ 가 있어도 그 줄을 그대로 셸에 넣으면 그 herdr가 돈다(다른 명령은 돌지 않는다)
  for (const name of ['my dir', `it's $HOME; echo x`]) {
    const odd = await rig()
    const dir = join(odd.base, name)
    const put = `mkdir -p "$HERDR_INSTALL_DIR" && cp ${shq(join(odd.base, 'herdr-wrapper'))} "$HERDR_INSTALL_DIR/herdr" && chmod 755 "$HERDR_INSTALL_DIR/herdr"`
    const o = await odd.install({ WHOSUP_HERDR_INSTALL_CMD: put, HERDR_INSTALL_DIR: dir, ...TERM_ENV })
    assert.equal(o.code, 0, o.all)
    const cmd = nextCommand(o.out)
    assert.equal(cmd, shown(join(dir, 'herdr')), name)
    const before = odd.herdrCalls().length
    const ran = odd.type(cmd)
    assert.ok(![126, 127].includes(ran.status), `${cmd}: ${ran.status} ${ran.stderr}`); assert.equal(ran.stdout, '', '다른 명령은 돌지 않는다'); assert.equal(odd.herdrCalls().length, before + 1, name)
  }
})

test('출력(가-6): 설치기가 대신 돌리는 herdr plugin install 의 출력(설치 내역 미리보기 30여 줄)은 성공하면 한 줄로 줄이고, 실패하면 전부 보여 준다', posix, async () => {
  for (const lang of ['en', 'ko']) {
    const r = await rig()
    exe(join(r.bin, 'herdr'), noisyHerdr())
    const a = await r.install({ WHOSUP_LANG: lang })
    assert.equal(a.code, 0, a.all); assert.ok(r.herdrCalls().includes(`plugin install ${ROOT} --yes`))
    // 성공: herdr가 찍은 줄(미리보기 PREVIEW줄 + "Installed plugin …" 1줄)은 화면에 없고, 몇 줄을 접었는지 한 줄
    assert.doesNotMatch(a.all, /Plugin install preview|action a\d+|Installed plugin/)
    assert.ok(a.out.includes(lang === 'ko' ? `whosup: herdr가 플러그인을 설치했습니다(herdr가 찍은 ${PREVIEW + 1}줄은 접었습니다)\n` : `whosup: herdr installed the plugin (what it printed is not shown: ${PREVIEW + 1} line(s))\n`), a.out)
    const rows = a.out.trimEnd().split('\n')
    assert.ok(rows.indexOf(rows.find((l) => /installing whosup as a herdr plugin|herdr 플러그인으로 설치합니다/.test(l))) < rows.findIndex((l) => /herdr installed the plugin|플러그인을 설치했습니다\(/.test(l)), '설치한다는 줄 → 설치했다는 줄')
    assert.ok(rows.length <= 12, `화면이 ${rows.length}줄이다(접기 전에는 미리보기만 ${PREVIEW}줄): ${a.out}`)
    assert.deepEqual(r.tmpLeft(), [], '출력을 모아 둔 임시 폴더를 남기지 않는다')
  }
  // 실패: herdr가 찍은 것을 전부(미리보기와 그 오류 줄) 보여 준 뒤 무엇이 안 됐는지 알리고 1로 끝낸다. 요약은 없다
  const bad = await rig()
  exe(join(bad.bin, 'herdr'), noisyHerdr())
  const f = await bad.install({ FAKE_HERDR_INSTALL_FAIL: '1' })
  assert.equal(f.code, 1, f.all); assert.doesNotMatch(f.out, /install summary/)
  assert.equal(count(f.err, /^ {4}action a\d+: /), PREVIEW - 1, '미리보기를 전부 보여 준다'); assert.match(f.err, /^Plugin install preview:\n/)
  assert.match(f.err, /fake herdr: plugin install failed\nwhosup: herdr could not install the plugin; what it said is above\. /)
  assert.deepEqual(bad.tmpLeft(), [])
  // 아무것도 찍지 않는 herdr면 접었다는 말도 없다
  const quiet = await rig()
  exe(join(quiet.bin, 'herdr'), `#!/bin/sh\nif [ "\${1:-} \${2:-}" = "plugin install" ]; then exec ${shq(process.execPath)} ${shq(FAKE_HERDR)} "$@" >/dev/null; fi\nexec ${shq(process.execPath)} ${shq(FAKE_HERDR)} "$@"\n`)
  const q = await quiet.install()
  assert.equal(q.code, 0, q.all); assert.ok(q.out.includes('whosup: herdr installed the plugin\n'), q.out)
})

test('출력(가-6): herdr의 설치기도 같다 — 입력 없이 시간 제한을 두고 돌리고, 깔렸으면 그 출력을 보여 주지 않고, 깔리지 않았으면 전부 보여 준다', posix, async () => {
  // 성공: 설치기가 찍은 것(표준 출력·표준 오류)은 화면에 없다. "herdr <판> 설치함" 한 줄이 대신한다
  const ok = await rig()
  const a = await ok.install({ WHOSUP_HERDR_INSTALL_CMD: `echo "  > downloading v0.9.5..."; echo "  > ready. run 'herdr' to get started." >&2; ${ok.getHerdr}`, ...TERM_ENV })
  assert.equal(a.code, 0, a.all); assert.doesNotMatch(a.all, /downloading v0\.9\.5|ready\. run|installed herdr to/); assert.match(a.out, /\nwhosup: herdr 0\.9\.5 installed\n/)
  assert.equal(count(a.out, /^\s+(\S*\/)?herdr\s*$/), 1, 'herdr를 치라는 줄은 요약의 하나뿐이다(herdr 설치기의 "run herdr"가 겹치지 않는다)'); assert.deepEqual(ok.tmpLeft(), [])
  // 실패: 그 출력을 전부 보여 준 뒤 이유와 직접 받는 곳. whosup은 설치하지 않는다
  const bad = await rig()
  const f = await bad.install({ WHOSUP_HERDR_INSTALL_CMD: 'echo "getting herdr"; echo "boom: no network" >&2; exit 3', ...TERM_ENV })
  assert.equal(f.code, 1, f.all); assert.doesNotMatch(f.out, /install summary/)
  assert.match(f.err, /getting herdr\nboom: no network\nwhosup: herdr did not install \(its installer ended with 3; what it said is above\)\. Install it yourself \(https:\/\/herdr\.dev\/docs\/install\/\)/)
  assert.deepEqual(bad.tmpLeft(), []); assert.equal(existsSync(join(bad.home, '.local')), false)
  // 끝나지 않는 설치기: 시간 제한(WHOSUP_ENV_TIMEOUT) 뒤 끝내고 그 사실을 알린다. 그 프로세스도 남지 않는다
  const slow = await rig()
  const pidFile = join(slow.base, 'installer.pid')
  const began = Date.now()
  const h = await slow.install({ WHOSUP_HERDR_INSTALL_CMD: `echo started; echo $$ > ${shq(pidFile)}; exec sleep 300`, WHOSUP_ENV_TIMEOUT: '1', WHOSUP_LANG: 'ko', ...TERM_ENV })
  assert.equal(h.code, 1, h.all); assert.ok(Date.now() - began < 60000)
  assert.match(h.err, /started\nwhosup: herdr를 설치하지 못했습니다\(설치 스크립트 1초 안에 끝나지 않아 멈췄습니다, 위에 그 출력이 있습니다\)/)
  const pid = Number(spawnSync('/bin/cat', [pidFile], { encoding: 'utf8' }).stdout.trim())
  assert.ok(pid > 1); assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, '그 설치기 프로세스가 남지 않는다')
})

test('한 번만(가-6): 터미널 없이 돈 플러그인 설치의 화면 — "herdr를 켤 때마다 보드가 뜬다"·herdr를 치라는 줄·바꾸는 곳·첫 실행 안내에 관한 말이 한 번씩이다', posix, async () => {
  for (const lang of ['en', 'ko']) {
    const r = await rig({ herdr: true })
    const a = await r.install({ WHOSUP_LANG: lang })
    assert.equal(a.code, 0, a.all)
    for (const [what, re] of [['켤 때마다', WHENEVER], ['herdr 줄', HERDR_LINE], ['다음에 할 일', NEXT], ['바꾸는 곳', CHANGE], ['첫 실행 안내', /First-run setup|첫 실행 안내/], ['주소', /http:\/\/127\.0\.0\.1:/]]) assert.equal(count(a.out, re), 1, `${lang} ${what}: ${a.out}`)
    // 터미널이 없어 첫 실행 안내가 아무 말도 못 한 설치다: 요약이 그 사실과 "보드를 처음 열 때 묻는다"를 한 줄로 말한다(되풀이·어긋남 없이)
    assert.match(a.out, lang === 'ko' ? /\n {2}첫 실행 안내: 이번 설치에서는 묻지 않았습니다\. 보드를 처음 열 때 묻습니다\(전에 마친 적이 있으면 묻지 않습니다\)\.\n/ : /\n {2}First-run setup: nothing was asked during this install\. The board asks on first open \(not if you have been through it before\)\.\n/)
    assert.doesNotMatch(a.out, /when there was something to choose|고를 것이 있으면/)
  }
  // 보드가 켜져 있는 설치: 주소는 켜진 보드의 것 한 번, "herdr를 켤 때마다"는 첫 줄이 한 번 말한다. 다음에 할 일(herdr를 치세요)은 없다
  const up = await rig({ herdr: true })
  // 가짜 보드는 후즈업 보드의 건강 응답 모양으로 답한다(이름과 그 상태 폴더의 표식 — src/paths.mjs instanceOf): 설치기는 200만 주는 서버를
  // 보드로 보지 않는다. 표식은 링크를 푼 경로로 계산하므로 상태 폴더를 먼저 만든다.
  const state = join(up.home, '.state', 'herdr', 'plugins', ID)
  mkdirSync(state, { recursive: true })
  const board = createServer((req, res) => { res.writeHead(req.url === '/api/health' ? 200 : 404); res.end(JSON.stringify({ ok: true, app: 'whosup', instance: instanceOf(state), pid: process.pid, readonly: false, herdr: [], targets: [] })) })
  await new Promise((ok) => board.listen(up.port + 1, '127.0.0.1', ok))
  try {
    writeFileSync(join(state, 'port'), `${up.port + 1}\n`)
    const b = await up.install({ FAKE_HERDR_SESSIONS: JSON.stringify([{ name: 'default', running: true }]) })
    assert.equal(b.code, 0, b.all)
    const s = summaryOf(b.out)
    assert.match(s, new RegExp(`^whosup install summary\\n {2}Installed as a herdr plugin \\(fivetaku\\.whosup\\)\\. herdr starts the board whenever it starts\\.\\n {2}The board is running: {2}http://127\\.0\\.0\\.1:${up.port + 1}\\n {4}No browser opens by itself here\\. Open that address on this computer\\.\\n`))
    assert.equal(count(b.out, WHENEVER), 1); assert.equal(count(b.out, NEXT), 0); assert.equal(count(b.out, HERDR_LINE), 0); assert.equal(count(b.out, CHANGE), 1)
  } finally { await new Promise((ok) => board.close(ok)) }
  // 브라우저: 저절로 열리는 곳에서는 줄을 더하지 않는다. 원격(SSH)이면 포트 넘기는 법까지. 설정 폴더의 .env가 환경변수보다 먼저다(첫 실행 안내와 같은 판정)
  const opens = await rig({ herdr: true })
  const o = await opens.install({ OPEN_BROWSER: '1' })
  assert.doesNotMatch(o.out, /No browser opens|forward the port/)
  const far = await rig({ herdr: true })
  const x = await far.install({ OPEN_BROWSER: '1', SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22' })
  assert.match(summaryOf(x.out), new RegExp(`\\(next port if taken\\)\\n {4}No browser opens by itself here\\. Open that address on this computer\\.\\n {4}From another device, forward the port first: ssh -L ${far.port}:127\\.0\\.0\\.1:${far.port} <host>\\n {2}Next: `))
  const dot = await rig({ herdr: true })
  const conf = join(dot.home, '.config', 'herdr', 'plugins', 'config', ID)
  mkdirSync(conf, { recursive: true }); writeFileSync(join(conf, '.env'), '# mine\nOPEN_BROWSER=0   # no tabs\n')
  assert.match((await dot.install({ OPEN_BROWSER: '1' })).out, /No browser opens by itself here/, '.env의 OPEN_BROWSER=0')
})

// ── 터미널이 있는 설치(가짜 터미널) ──
// script 명령이 가짜 터미널을 만들어 그 안에서 설치기를 돌린다. 번호 입력 줄이 나올 때마다 Enter를 넣는다. 돌려주는 것: 화면 글자와 종료 코드.
// node가 주는 표준 입력은 소켓이라 script가 받지 못한다(맥): cat을 사이에 두어 파이프로 넘기고, 끝 표식을 보면 입력을 닫는다.
const hasScript = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
const tty = { skip: hasScript ? false : '가짜 터미널을 만들 script 명령이 없다' }
const DONE = /@@OUT-DONE (\d+)/
function onTerminal(r, over = {}) {
  // NO_COLOR: 첫 실행 안내의 제목을 굵게 찍지 않게 한다(화면 글자를 그대로 견준다)
  const env = Object.fromEntries(Object.entries(r.env({ NO_COLOR: '1', ...over })).filter(([, v]) => v !== undefined))
  const inner = mac ? `script -q /dev/null ${shq(SH)} ${shq(INSTALL)}` : `script -qec ${shq(`${shq(SH)} ${shq(INSTALL)}`)} /dev/null`
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `cat | { ${inner}; echo "@@OUT-DONE $?"; }`], { env, cwd: r.base, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let screen = '', seen = 0, ended = false
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} reject(new Error(`timed out on the terminal\n${screen}`)) }, 90000)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (c) => {
      screen += c
      if (!ended && DONE.test(screen)) { ended = true; setTimeout(() => { try { child.stdin.end() } catch {} }, 50); return }
      if (ended) return
      const n = (screen.match(/Type a number|번호를 입력하세요/g) || []).length
      for (; seen < n; seen++) setTimeout(() => { try { child.stdin.write('\n') } catch {} }, 150)
    })
    child.stderr.on('data', (c) => { screen += c })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      const m = DONE.exec(screen)
      resolve({ code: m ? Number(m[1]) : null, screen: screen.replace(/\r/g, '').replace(/\^D\x08\x08/g, '').replace(/@@OUT-DONE \d+\n?/, '') })
    })
  })
}

test('한 번만(가-6): 터미널에서 돌린 플러그인 설치 — 첫 실행 안내는 질문까지만 하고, "herdr를 치세요"·"herdr를 켤 때마다"·바꾸는 곳은 설치 요약이 한 번만 말한다. herdr의 미리보기는 접힌다', tty, async () => {
  for (const lang of ['en', 'ko']) {
    const r = await rig()
    const herdr = exe(join(r.bin, 'herdr'), noisyHerdr({ build: true }))
    const a = await onTerminal(r, { WHOSUP_LANG: lang, HERDR_BIN_PATH: herdr, HERDR_BIN: herdr })
    assert.equal(a.code, 0, a.screen)
    // 첫 실행 안내가 그 터미널에서 돌았다(제목과 감지한 것), 그리고 herdr가 찍은 미리보기는 화면에 없다
    assert.equal(count(a.screen, /^whosup (first-run setup|첫 실행 안내)$/), 1, a.screen); assert.match(a.screen, /\n {2}(checking this machine…|이 컴퓨터를 확인하는 중…)\n/)
    assert.doesNotMatch(a.screen, /Plugin install preview|action a\d+|Installed plugin/); assert.equal(count(a.screen, /herdr installed the plugin \(what it printed is not shown|플러그인을 설치했습니다\(herdr가 찍은/), 1)
    // 같은 안내는 화면 전체에서 한 번: herdr를 치라는 줄 · "herdr를 켤 때마다 보드가 뜬다" · 다음에 할 일 · 바꾸는 곳 · 보드 주소
    for (const [what, re] of [['herdr 줄', HERDR_LINE], ['켤 때마다', WHENEVER], ['다음에 할 일', NEXT], ['바꾸는 곳', CHANGE], ['주소', /http:\/\/127\.0\.0\.1:/]]) assert.equal(count(a.screen, re), 1, `${lang} ${what}: ${a.screen}`)
    assert.doesNotMatch(a.screen, /herdr is not running right now|Type this in this terminal|herdr가 꺼져 있습니다|이 터미널에 아래를 치고/, '첫 실행 안내의 마무리 문구는 없다')
    // 순서: 첫 실행 안내 → 접었다는 한 줄 → 설치 요약(다음에 할 일은 요약 안)
    const rows = a.screen.split('\n')
    const at = (re) => rows.findIndex((l) => re.test(l))
    assert.ok(at(/^whosup (first-run setup|첫 실행 안내)$/) < at(/herdr installed the plugin|플러그인을 설치했습니다\(/) && at(/herdr installed the plugin|플러그인을 설치했습니다\(/) < at(/^whosup (install summary|설치 요약)$/) && at(/^whosup (install summary|설치 요약)$/) < at(NEXT), a.screen)
    // 첫 실행 안내가 터미널에서 말했으므로("고를 것이 없어 … 한 번 보여 줍니다" · "직접 정한 값이 없습니다 …") 요약은 그 말을 되풀이하지 않고,
    // "고를 것이 없습니다" 다음 줄에 "묻습니다"가 오는 어긋남도 없다
    assert.equal(count(a.screen, /on first open|보드를 처음 열 때/), 1, a.screen)
    assert.doesNotMatch(a.screen, /First-run setup: |첫 실행 안내: |고를 것이 없습니다\.|asks on first open\.\n {2}The board asks/)
  }
  // 아무것도 없는 기계에서 herdr를 깔고 가는 길(터미널): 칠 명령은 전체 경로로 한 번, 그 줄을 그대로 치면 그 herdr가 돈다
  const fresh = await rig()
  const noisy = exe(join(fresh.base, 'noisy-herdr'), noisyHerdr({ build: true }))
  const put = `mkdir -p "$HOME/.local/bin" && cp ${shq(noisy)} "$HOME/.local/bin/herdr" && chmod 755 "$HOME/.local/bin/herdr" && echo "  > ready. run 'herdr' to get started."`
  const full = join(fresh.home, '.local', 'bin', 'herdr')
  const b = await onTerminal(fresh, { WHOSUP_HERDR_INSTALL_CMD: put, HERDR_BIN_PATH: full, HERDR_BIN: full, ...TERM_ENV })
  assert.equal(b.code, 0, b.screen)
  assert.deepEqual(b.screen.split('\n').filter((l) => HERDR_LINE.test(l)), [`      ${full}`], b.screen); assert.equal(count(b.screen, NEXT), 1); assert.equal(count(b.screen, WHENEVER), 1); assert.equal(count(b.screen, /is not on your PATH/), 1)
  assert.doesNotMatch(b.screen, /ready\. run|Plugin install preview/)
  const before = fresh.herdrCalls().length
  assert.ok(![126, 127].includes(fresh.type(nextCommand(b.screen)).status)); assert.equal(fresh.herdrCalls().length, before + 1)
})

test('한 번만(가-6): 터미널에서 돌린 단독 설치 — "보드를 처음 열 때 첫 실행 안내가 …"는 첫 실행 안내가 한 번 말하고 설치 요약은 되풀이하지 않는다(터미널 없이 돈 설치는 요약이 말한다)', tty, async () => {
  const r = await rig()
  const a = await onTerminal(r, { WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
  assert.equal(a.code, 0, a.screen)
  assert.equal(count(a.screen, /^whosup first-run setup$/), 1, a.screen); assert.match(a.screen, /\nwhosup install summary\n/)
  assert.equal(count(a.screen, /on first open/), 1, a.screen)
  assert.doesNotMatch(summaryOf(a.screen), /on first open/, '요약에는 없다(첫 실행 안내가 위에서 말했다)')
  // 터미널 없이 돈 같은 설치: 첫 실행 안내가 말한 곳이 없으므로 요약이 한 번 말한다
  const quiet = await rig()
  const b = await quiet.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1' })
  assert.equal(b.code, 0, b.all); assert.equal(count(b.out, /on first open/), 1); assert.match(summaryOf(b.out), / {2}The board asks on first open\.\n/)
})
