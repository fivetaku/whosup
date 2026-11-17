// 환경 고르기: 아무것도 없는 기계(herdr도, herdr-core도, Herdr 앱·Ovis 앱도 없다)에서 한 줄 설치기(install.sh)가 쓸 환경을 정하고(F1),
// 그것을 깐 뒤(F2), whosup을 맞는 길로 붙이고 다음에 할 일을 그 환경의 말로 한 번 알린다(F3).
// 격리 환경은 test-support/install-rig.mjs(임시 HOME · 좁은 PATH · 가짜 herdr). 여기에 더하는 것:
//   - 두 앱의 설치 명령 대역(WHOSUP_HERDR_APP_INSTALL_CMD · WHOSUP_OVIS_APP_INSTALL_CMD): 진짜 설치기처럼 임시 HOME에 앱과 명령을 놓고, 불린 것을 적는다.
//   - 이 기계에 깔린 앱(/Applications)을 보지 않게 빈 폴더(WHOSUP_SYSTEM_APPS), 맥의 칩 판별을 정해 두는 가짜 sysctl(애플 실리콘).
//   - 터미널에서 묻는 경우는 script 명령으로 가짜 터미널을 만들어 돌린다(질문은 /dev/tty에 나오고 답도 거기서 읽는다).
//   - 진짜 내려받기 길(Herdr 앱의 공식 설치 스크립트 · Ovis 앱의 릴리스 파일)은 이 시험이 띄운 로컬 서버(127.0.0.1)를 릴리스 주소로 준다. 바깥 네트워크에 닿지 않는다.
// 진짜 앱 설치기는 어디서도 돌지 않는다. 브라우저·앱도 열지 않는다(OPEN_BROWSER=0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { TEXT, standaloneLines } from '../src/setup.mjs'
import { envOf, layout, openApp, pickedEnv, readRecordFile, writeRecord } from '../src/standalone.mjs'
import { INSTALL, ROOT, SH, exe, freePort, lines, mac, posix, rig as bareRig, shq, summaryOf, walk } from '../test-support/install-rig.mjs'
import { tmpdir as osTmpdir } from 'node:os'

// 격리 폴더는 셸이 따옴표로 싸지 않는 경로에 만든다. 임시 폴더의 경로에 공백·한글 같은 글자가 있으면 설치기와 안내 문구가 화면의 경로를 '…'로
// 싸서 내놓는데(제품의 바른 동작이다), 이 파일의 단언은 싸지 않은 경로를 글자 그대로 견준다 — TMPDIR에 따라 결과가 갈리지 않게 그때는 /tmp를 쓴다.
// 싸는 동작은 그것을 보는 시험이 그런 폴더를 따로 만들어 본다.
if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'

// 대역 설치 명령. 끄고 켜는 값(환경변수): FAKE_APP_FAIL(무엇인가 받다가 실패) · FAKE_APP_NOTHING(0으로 끝나는데 아무것도 놓지 않는다 —
// 공식 설치 스크립트가 그럴 수 있다) · FAKE_APP_NO_CORE(앱만 놓고 코어는 놓지 않는다) · FAKE_APP_HANG(끝나지 않는다) · FAKE_OVIS_NAME(놓는 앱의 이름).
const fakeHerdrApp = (log) => `#!/bin/sh
tty=0; [ -t 0 ] && tty=1
printf 'herdr-app stdin_tty=%s\\n' "$tty" >> ${shq(log)}
cat >/dev/null
echo "fake herdr app installer: downloading"
echo partial > "\${TMPDIR:-/tmp}/herdr-app-download.part"
if [ -n "\${FAKE_APP_HANG:-}" ]; then echo $$ > ${shq(`${log}.pid`)}; exec sleep 300; fi
if [ -n "\${FAKE_APP_FAIL:-}" ]; then echo "fake herdr app installer: boom" >&2; exit 7; fi
[ -z "\${FAKE_APP_NOTHING:-}" ] || exit 0
mkdir -p "$HOME/.local/bin" || exit 1
if [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/Herdr.app/Contents/MacOS" || exit 1; fi
printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/herdr-app" && chmod 755 "$HOME/.local/bin/herdr-app" || exit 1
if [ -z "\${FAKE_APP_NO_CORE:-}" ]; then printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/herdr-core" && chmod 755 "$HOME/.local/bin/herdr-core" || exit 1; fi
echo "fake herdr app installer: done"
`
const fakeOvisApp = (log) => `#!/bin/sh
tty=0; [ -t 0 ] && tty=1
printf 'ovis-app stdin_tty=%s\\n' "$tty" >> ${shq(log)}
cat >/dev/null
echo partial > "\${TMPDIR:-/tmp}/ovis-download.part"
if [ -n "\${FAKE_APP_FAIL:-}" ]; then echo "fake ovis app installer: boom" >&2; exit 7; fi
[ -z "\${FAKE_APP_NOTHING:-}" ] || exit 0
name="\${FAKE_OVIS_NAME:-Ovis}"
if [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/$name.app/Contents/MacOS" || exit 1
else d="\${XDG_DATA_HOME:-$HOME/.local/share}/ovis-desktop"; mkdir -p "$d" && printf '#!/bin/sh\\nexit 0\\n' > "$d/$name.AppImage" && chmod 755 "$d/$name.AppImage" || exit 1
fi
echo "fake ovis app installer: done"
`
async function rig(opts) {
  const r = await bareRig(opts), env = r.env
  r.envLog = join(r.base, 'env-installers.log')
  r.sysApps = join(r.base, 'sysapps'); mkdirSync(r.sysApps)
  r.getHerdrApp = `sh ${shq(exe(join(r.base, 'get-herdr-app.sh'), fakeHerdrApp(r.envLog)))}`
  r.getOvisApp = `sh ${shq(exe(join(r.base, 'get-ovis-app.sh'), fakeOvisApp(r.envLog)))}`
  exe(join(r.bin, 'sysctl'), '#!/bin/sh\necho 1\n')   // 애플 실리콘(맥에서만 불린다)
  // 보드를 켜지 않고 로그인 항목도 두지 않는다(시험이 가볍다). 그것을 보는 시험만 값을 비워 켠다.
  // DISPLAY: 리눅스에서 화면이 없는 세션은 데스크톱 앱을 내놓지 않는다(기본값이 herdr가 된다) — 책상 앞의 설치를 보도록 화면이 있는 것으로 둔다
  // (맥에서는 쓰이지 않는다). 화면이 없는 설치는 그것을 보는 시험이 값을 뺀다(headless).
  r.env = (over = {}) => env({
    WHOSUP_HERDR_APP_INSTALL_CMD: r.getHerdrApp, WHOSUP_OVIS_APP_INSTALL_CMD: r.getOvisApp, WHOSUP_SYSTEM_APPS: r.sysApps,
    WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1', DISPLAY: ':0', ...over,
  })
  r.envCalls = () => lines(r.envLog)
  r.rec = () => JSON.parse(readFileSync(r.record, 'utf8'))
  // 놓인 앱의 경로(대역이 놓는 자리 = 진짜 설치기가 놓는 자리)
  r.herdrApp = mac ? join(r.home, 'Applications', 'Herdr.app') : join(r.home, '.local', 'bin', 'herdr-app')
  r.ovisApp = (name = 'Ovis') => (mac ? join(r.home, 'Applications', `${name}.app`) : join(r.home, '.local', 'share', 'ovis-desktop', `${name}.AppImage`))
  r.tmpLeft = () => readdirSync(join(r.base, 't'))
  return r
}
// 이 기계가 두 앱을 못 받는 기계인 척한다: 맥은 인텔(Herdr 앱 없음, Ovis 앱 있음), 리눅스는 두 앱 모두 판이 없는 프로세서.
const oddMachine = (r) => {
  if (mac) exe(join(r.bin, 'sysctl'), '#!/bin/sh\necho 0\n')
  else exe(join(r.bin, 'uname'), '#!/bin/sh\ncase "${1:-}" in -m) echo riscv64 ;; *) PATH=/usr/bin:/bin exec uname "$@" ;; esac\n')
}
// 이 기계가 리눅스인 척한다(맥에서 돌 때): 설치기가 보는 uname -s 만 바꾼다. 리눅스에서는 아무것도 하지 않는다.
const linuxBox = (r) => { if (mac) exe(join(r.bin, 'uname'), '#!/bin/sh\ncase "${1:-}" in -s) echo Linux ;; *) exec /usr/bin/uname "$@" ;; esac\n') }
// 화면이 없는 세션(SSH로 들어온 서버, 컨테이너): DISPLAY도 WAYLAND_DISPLAY도 없다
const headless = { DISPLAY: undefined, WAYLAND_DISPLAY: undefined }
const nexts = (out) => out.split('\n').filter((l) => /^\s*(Next|다음에 할 일)\s*:/.test(l))
const herdrCommandLines = (out) => out.split('\n').filter((l) => /^\s+(\S*\/)?herdr\s*$/.test(l))

test('고르기: 터미널 없는 설치는 묻지 않고 기본값(데스크톱 앱 → Herdr 앱)을 깔고 단독 설치로 붙인다 — 설치 기록의 env_installed, 요약의 이름과 다음에 할 일 한 번', posix, async () => {
  for (const [lang, more] of [['en', {}], ['ko', {}], ['en', { CI: '1' }], ['en', { WHOSUP_NO_SETUP: '1' }]]) {
    const r = await rig()
    const a = await r.install({ WHOSUP_LANG: lang, ...more })
    const tag = `${lang} ${JSON.stringify(more)}: ${a.all}`
    assert.equal(a.code, 0, tag)
    assert.deepEqual(r.envCalls(), ['herdr-app stdin_tty=0'], 'Herdr 앱의 설치 명령만 한 번, 입력 없이')
    assert.deepEqual(r.herdrCalls(), [], 'herdr를 부르지 않는다'); assert.equal(existsSync(join(r.home, '.local', 'bin', 'herdr')), false, 'herdr를 깔지 않는다')
    assert.match(a.out, lang === 'ko' ? /whosup: 세션을 띄울 환경이 아직 없습니다: 먼저 Herdr 앱부터 설치합니다\(묻지 않을 때의 기본값입니다\. .*WHOSUP_ENV=herdr-app, ovis-app, herdr/ : /whosup: nothing to run sessions in is here yet: installing the Herdr app first \(the default when nothing is asked\. To choose, set WHOSUP_ENV=herdr-app, ovis-app or herdr\)\n/)
    assert.ok(a.out.includes(lang === 'ko' ? `whosup: Herdr 앱을 설치했습니다: ${r.herdrApp}\n` : `whosup: the Herdr app is installed: ${r.herdrApp}\n`), tag)
    assert.doesNotMatch(a.all, /fake herdr app installer/, '다른 설치기의 출력은 성공하면 보이지 않는다')
    assert.doesNotMatch(a.out, /Type a number|번호를 입력하세요/, '묻지 않는다')
    // 단독 설치로 붙었다: 앱 폴더와 설치 기록. 기록에 이번에 함께 깐 환경과 그 앱의 경로
    assert.equal(existsSync(join(r.app, 'scripts', 'standalone.sh')), true, tag)
    assert.equal(r.rec().env_installed, 'herdr-app'); assert.equal(r.rec().env_app, r.herdrApp)
    // 요약: 함께 깐 앱의 이름, 다음에 할 일은 화면 전체에서 한 번이고 그 앱의 말이다. herdr를 치라는 줄은 없다
    const s = a.out.slice(a.out.indexOf(lang === 'ko' ? 'whosup 설치 요약' : 'whosup install summary'))
    assert.ok(s.includes(lang === 'ko' ? `  Herdr 앱도 함께 설치했습니다(${r.herdrApp}).\n` : `  Installed too: the Herdr app (${r.herdrApp}).\n`), s)
    assert.deepEqual(nexts(a.out), [lang === 'ko'
      ? '  다음에 할 일: Herdr 앱을 한 번 여세요(한 번 열어야 그 앱의 세션이 보드에 보입니다). 그다음 보드에서 새 세션을 엽니다.'
      : '  Next: open the Herdr app once (its sessions show on the board only after it has been opened). Then start a new session from the board.'], tag)
    assert.ok(s.includes(nexts(a.out)[0]), '다음에 할 일은 요약 안에 있다'); assert.deepEqual(herdrCommandLines(a.out), [])
    assert.deepEqual(r.tmpLeft(), [], '임시 폴더를 남기지 않는다')
  }
})

test('고르기: WHOSUP_ENV=herdr-app|ovis-app|herdr 가 있으면 묻지 않고 그 환경만 깐다 — 앱은 단독 설치, herdr는 깔고 플러그인(기존 길 그대로)', posix, async () => {
  const h = await rig()
  const a = await h.install({ WHOSUP_ENV: 'herdr-app' })
  assert.equal(a.code, 0, a.all); assert.deepEqual(h.envCalls(), ['herdr-app stdin_tty=0'])
  assert.match(a.out, /whosup: nothing to run sessions in is here yet: installing the Herdr app first \(WHOSUP_ENV=herdr-app\)\n/)
  assert.equal(h.rec().env_installed, 'herdr-app'); assert.deepEqual(h.herdrCalls(), [])
  // Ovis 앱: PATH에 놓이는 명령도, 코어 흔적도 없다(앱을 열기 전) — 그래도 단독 설치로 간다
  const o = await rig()
  const b = await o.install({ WHOSUP_ENV: 'ovis-app', WHOSUP_LANG: 'ko' })
  assert.equal(b.code, 0, b.all); assert.deepEqual(o.envCalls(), ['ovis-app stdin_tty=0']); assert.deepEqual(o.herdrCalls(), [])
  assert.equal(existsSync(join(o.home, '.local', 'bin', 'herdr')), false); assert.equal(existsSync(join(o.app, 'scripts', 'standalone.sh')), true)
  assert.equal(o.rec().env_installed, 'ovis-app'); assert.equal(o.rec().env_app, o.ovisApp())
  assert.ok(b.out.includes(`  Ovis 앱도 함께 설치했습니다(${o.ovisApp()}).\n`), b.out)
  assert.deepEqual(nexts(b.out), ['  다음에 할 일: Ovis 앱을 한 번 여세요(한 번 열어야 그 앱의 세션이 보드에 보입니다). 그다음 보드에서 새 세션을 엽니다.']); assert.deepEqual(herdrCommandLines(b.out), [])
  // 대역이 놓는 앱의 이름이 달라도(무엇을 놓을지는 그 명령이 정한다) 새로 놓인 것을 그 앱으로 본다
  const n = await rig()
  const c = await n.install({ WHOSUP_ENV: 'ovis-app', FAKE_OVIS_NAME: 'RigOvisApp7' })
  assert.equal(c.code, 0, c.all); assert.equal(n.rec().env_app, n.ovisApp('RigOvisApp7'))
  // herdr: 기존 길 그대로(herdr를 깔고 플러그인). 앱의 설치 명령은 부르지 않고 단독 설치의 것도 만들지 않는다. 진행 줄도 그대로다
  const t = await rig()
  const d = await t.install({ WHOSUP_ENV: 'herdr', WHOSUP_HERDR_INSTALL_CMD: t.getHerdr })
  assert.equal(d.code, 0, d.all); assert.deepEqual(t.envCalls(), [])
  assert.ok(d.out.startsWith(`whosup: node ${process.version} ok\nwhosup: herdr is not here: installing herdr (https://herdr.dev) into ${t.home}/.local/bin first\n`), d.out)
  assert.deepEqual(t.herdrCalls(), ['--version', 'plugin list', `plugin install ${ROOT} --yes`, 'session list --json'])
  assert.match(summaryOf(d.out), /Installed as a herdr plugin \(fivetaku\.whosup\)\./); assert.equal(existsSync(t.data), false)
  // herdr를 깐 폴더(~/.local/bin)가 이 시험의 PATH에 없다: 칠 명령은 전체 경로로 한 번(가-5 · F7 — 전에는 실행되지 않는 짧은 이름 'herdr'였다)
  assert.equal(nexts(d.out).length, 1); assert.deepEqual(herdrCommandLines(d.out), [`      ${join(t.home, '.local', 'bin', 'herdr')}`])
})

test('고르기: 모르는 WHOSUP_ENV 값은 이유를 말하고 끝낸다 — 무엇이 깔려 있든 아무것도 깔지 않는다', posix, async () => {
  for (const herdr of [false, true]) {
    const r = await rig({ herdr })
    for (const [lang, want] of [['en', /^whosup: WHOSUP_ENV=docker is not something this installer can install: use herdr-app, ovis-app or herdr\. Nothing was installed\.\n$/], ['ko', /^whosup: WHOSUP_ENV=docker: 모르는 값입니다\. herdr-app, ovis-app, herdr 중 하나를 쓰세요\. 아무것도 설치하지 않았습니다\.\n$/]]) {
      const a = await r.install({ WHOSUP_ENV: 'docker', WHOSUP_LANG: lang, WHOSUP_HERDR_INSTALL_CMD: r.getHerdr })
      assert.equal(a.code, 1); assert.equal(a.out, ''); assert.match(a.err, want)
    }
    assert.deepEqual(walk(r.home), []); assert.deepEqual(r.envCalls(), []); assert.deepEqual(r.herdrCalls(), [])
  }
})

test('고르기: 이 기계에 깔 수 없는 환경 — WHOSUP_ENV로 받으면 이유와 받는 곳을 말하고 끝내고, 기본값은 깔 수 있는 것으로 넘어간다(Herdr 앱 → Ovis 앱 → herdr)', posix, async () => {
  const r = await rig(); oddMachine(r)
  // 맥: 인텔 맥에는 Herdr 앱이 없다. 리눅스: 판이 없는 프로세서
  const a = await r.install({ WHOSUP_ENV: 'herdr-app' })
  assert.equal(a.code, 1, a.all); assert.equal(a.out.includes('install summary'), false)
  assert.match(a.err, mac
    ? /^whosup: WHOSUP_ENV=herdr-app cannot be installed on this computer: the Herdr app does not run on Intel Macs\. Nothing was installed\. Set WHOSUP_ENV to another one \(herdr-app, ovis-app or herdr\), or get it yourself: https:\/\/github\.com\/herdrdev\/herdr-app\n$/
    : /^whosup: WHOSUP_ENV=herdr-app cannot be installed on this computer: the Herdr app has no build for this processor \(riscv64\)\. Nothing was installed\./)
  assert.deepEqual(walk(r.home), [], '아무것도 깔지 않는다'); assert.deepEqual(r.envCalls(), [])
  // 기본값: 맥(인텔)은 Ovis 앱, 두 앱 모두 안 되는 기계는 터미널용 herdr
  const b = await r.install({ WHOSUP_HERDR_INSTALL_CMD: r.getHerdr })
  assert.equal(b.code, 0, b.all)
  if (mac) {
    assert.deepEqual(r.envCalls(), ['ovis-app stdin_tty=0']); assert.equal(r.rec().env_installed, 'ovis-app')
    assert.match(b.out, /whosup: nothing to run sessions in is here yet: installing the Ovis app first \(the Herdr app does not run on Intel Macs\. To choose, set WHOSUP_ENV=ovis-app or herdr\)\n/)
  } else {
    assert.deepEqual(r.envCalls(), []); assert.match(summaryOf(b.out), /Installed as a herdr plugin/)
    assert.match(b.out, /neither app can be installed on this computer \(the Herdr app has no build for this processor \(riscv64\); the Ovis app has no build for this processor \(riscv64\)\): herdr, for the terminal, is installed\n/)
  }
  // 진짜 설치 방법이 쓰는 도구가 없어도 깔 수 없다: curl이 없는 PATH(대역 명령을 주지 않았을 때만 본다)
  const c = await rig()
  for (const tool of ['node', 'sh', 'uname', 'sed', 'tr', 'awk', 'grep', 'cat', 'mkdir', 'ls', 'sw_vers', 'dirname', 'printf', 'tar']) { const at = ['/bin', '/usr/bin'].map((d) => join(d, tool)).find((f) => existsSync(f)); if (at && !existsSync(join(c.bin, tool))) exe(join(c.bin, tool), `#!/bin/sh\nexec ${at} "$@"\n`) }
  const x = await c.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', PATH: c.bin })
  assert.equal(x.code, 1, x.all); assert.match(x.err, /WHOSUP_ENV=herdr-app cannot be installed on this computer: installing the Herdr app needs curl and tar, and one of them is not here\. Nothing was installed\./)
  assert.deepEqual(walk(c.home), [])
})

test('깔기: 설치 명령이 실패하면 그 출력과 무엇이 안 됐는지·직접 받는 곳을 알리고 1로 끝낸다 — whosup도, 받다 만 파일도 남기지 않는다', posix, async () => {
  for (const [envName, name, docs, koName] of [['herdr-app', 'the Herdr app', 'https://github.com/herdrdev/herdr-app', 'Herdr 앱'], ['ovis-app', 'the Ovis app', 'https://ovis.sh', 'Ovis 앱']]) {
    const r = await rig()
    const a = await r.install({ WHOSUP_ENV: envName, FAKE_APP_FAIL: '1' })
    assert.equal(a.code, 1, a.all); assert.doesNotMatch(a.out, /install summary/)
    const said = envName === 'herdr-app' ? 'fake herdr app installer: downloading\nfake herdr app installer: boom\n' : 'fake ovis app installer: boom\n'
    const why = envName === 'herdr-app' ? 'its installer ended with 7 and the app is not in place' : 'its installer ended with 7'
    assert.equal(a.err, `${said}whosup: ${name} was not installed: ${why}. Get it yourself (${docs}), then run this installer again. whosup was not installed.\n`)
    assert.deepEqual(walk(r.home), [], '아무것도 놓지 않았다'); assert.deepEqual(r.tmpLeft(), [], '받다 만 파일(임시 폴더)을 남기지 않는다')
    const k = await r.install({ WHOSUP_ENV: envName, FAKE_APP_FAIL: '1', WHOSUP_LANG: 'ko' })
    assert.equal(k.code, 1); assert.ok(k.err.includes(`whosup: ${koName}을 설치하지 못했습니다: `) && k.err.includes(`직접 받아 설치한 뒤(${docs}) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다.\n`), k.err)
  }
})

test('깔기: 설치 명령이 0으로 끝나도 놓인 것을 확인한다 — 앱이 없거나 코어가 없으면 다음으로 가지 않는다', posix, async () => {
  // 0으로 끝났는데 아무것도 놓지 않았다(공식 설치 스크립트는 내려받기가 실패해도 0으로 끝날 수 있다)
  const none = await rig()
  const a = await none.install({ WHOSUP_ENV: 'herdr-app', FAKE_APP_NOTHING: '1' })
  assert.equal(a.code, 1, a.all); assert.match(a.err, /whosup: the Herdr app was not installed: its installer ended with 0 and the app is not in place\. Get it yourself /)
  assert.deepEqual(walk(none.home), []); assert.deepEqual(none.tmpLeft(), []); assert.doesNotMatch(a.out, /install summary/)
  const ovis = await rig()
  const b = await ovis.install({ WHOSUP_ENV: 'ovis-app', FAKE_APP_NOTHING: '1' })
  const where = mac ? join(ovis.home, 'Applications') : join(ovis.home, '.local', 'share', 'ovis-desktop')
  assert.equal(b.code, 1, b.all); assert.ok(b.err.includes(`whosup: the Ovis app was not installed: its installer ended with 0 and nothing new is in ${where}. Get it yourself (https://ovis.sh)`), b.err)
  assert.equal(existsSync(ovis.data), false); assert.deepEqual(ovis.tmpLeft(), [])
  // 앱은 놓였는데 코어(herdr-core)가 없다: 세션을 띄울 수 없는 설치다 — whosup을 붙이지 않고 그 사실을 알린다
  const core = await rig()
  const c = await core.install({ WHOSUP_ENV: 'herdr-app', FAKE_APP_NO_CORE: '1' })
  assert.equal(c.code, 1, c.all); assert.ok(c.err.includes(`whosup: the Herdr app was not installed: the app is in place (${core.herdrApp}) but its core, herdr-core, is not, so it cannot run sessions.`), c.err)
  assert.equal(existsSync(core.data), false, 'whosup은 설치하지 않았다'); assert.deepEqual(core.tmpLeft(), [])
})

test('깔기: 끝나지 않는 설치 명령은 시간 제한 뒤 끝내고(그 프로세스도) 그 사실을 알린다. 설치 명령은 표준 입력을 읽어도 스크립트를 먹지 못한다', posix, async () => {
  const r = await rig()
  const began = Date.now()
  const a = await r.install({ WHOSUP_ENV: 'herdr-app', FAKE_APP_HANG: '1', WHOSUP_ENV_TIMEOUT: '1' })
  assert.equal(a.code, 1, a.all); assert.ok(Date.now() - began < 30000, '설치기가 섰다')
  assert.match(a.err, /whosup: the Herdr app was not installed: its installer did not finish within 1 s and was stopped and the app is not in place\./)
  const pid = Number(lines(`${r.envLog}.pid`)[0])
  assert.ok(pid > 1); assert.throws(() => process.kill(pid, 0), '멈춘 설치 명령의 프로세스가 남지 않는다')
  assert.deepEqual(walk(r.home), []); assert.deepEqual(r.tmpLeft(), [])
  // 설치기가 신호를 받으면(Ctrl-C) 돌던 설치 명령을 같이 끝내고, 임시 폴더를 치운 뒤 130으로 끝낸다
  const s = await rig()
  let watch = null
  const c = await s.run(SH, [INSTALL], { WHOSUP_ENV: 'herdr-app', FAKE_APP_HANG: '1' }, { onSpawn: (child) => { watch = setInterval(() => { if (!existsSync(`${s.envLog}.pid`)) return; clearInterval(watch); setTimeout(() => { try { process.kill(-child.pid, 'SIGINT') } catch {} }, 200) }, 50) } })
  clearInterval(watch)
  assert.equal(c.code, 130, c.all); assert.doesNotMatch(c.out, /install summary/)
  const hung = Number(lines(`${s.envLog}.pid`)[0])
  assert.ok(hung > 1); assert.throws(() => process.kill(hung, 0), '돌던 설치 명령이 남지 않는다')
  assert.deepEqual(walk(s.home), []); assert.deepEqual(s.tmpLeft(), [])
  // 값이 양의 정수가 아니면 기본값(900초)이다: 멈추지 않는 설치는 평소대로 간다
  const d = await rig()
  assert.equal((await d.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_ENV_TIMEOUT: 'soon' })).code, 0)
  // 파이프 실행(curl … | sh): 앱의 설치 명령이 표준 입력을 끝까지 읽어도(대역이 cat을 돌린다) 스크립트의 나머지는 남는다
  const p = await rig()
  const b = await p.run(SH, [], {}, { input: readFileSync(INSTALL, 'utf8') })
  assert.equal(b.code, 0, b.all); assert.deepEqual(p.envCalls(), ['herdr-app stdin_tty=0']); assert.match(summaryOf(b.out), /^whosup install summary\n {2}Installed on its own, without herdr \(standalone\)\./)
})

test('이미 무엇이든 깔려 있으면 고르지도 깔지도 않는다 — herdr · herdr-core의 흔적 · 단독 설치 · 강제한 길. 쓰지 않은 WHOSUP_ENV는 한 줄로 알린다', posix, async () => {
  // herdr가 있다: 플러그인 길 그대로
  const h = await rig({ herdr: true })
  const a = await h.install()
  assert.equal(a.code, 0, a.all); assert.deepEqual(h.envCalls(), []); assert.doesNotMatch(a.all, /nothing to run sessions|WHOSUP_ENV/)
  assert.ok(a.out.startsWith(`whosup: node ${process.version} ok\nwhosup: herdr 0.9.5 is here: installing whosup as a herdr plugin (${ROOT})\n`), a.out)
  const a2 = await (await rig({ herdr: true })).install({ WHOSUP_ENV: 'ovis-app' })
  assert.equal(a2.code, 0, a2.all); assert.match(a2.out, /whosup: WHOSUP_ENV=ovis-app was not used: it only applies when nothing to run sessions in is on this computer and no path is forced\n/); assert.match(summaryOf(a2.out), /Installed as a herdr plugin/)
  // herdr-core를 쓴 흔적(꺼 둔 앱): 단독 설치 그대로. 설치 기록의 env_installed는 빈 값이고 요약에 "다음에 할 일"이 없다
  const c = await rig()
  mkdirSync(join(c.home, '.state', 'herdr-core', 'appcore'), { recursive: true }); writeFileSync(join(c.home, '.state', 'herdr-core', 'appcore', 'core.lock'), `${join(c.base, 'gone.sock')}\n`)
  const b = await c.install()
  assert.equal(b.code, 0, b.all); assert.deepEqual(c.envCalls(), []); assert.match(b.out, /an app that uses herdr-core has run on this computer and is not running now/)
  assert.equal(c.rec().env_installed, ''); assert.equal('env_app' in c.rec(), false); assert.deepEqual(nexts(b.out), []); assert.doesNotMatch(b.out, /Installed too/)
  // 그 단독 설치 위에서 다시 돌리면 새 버전으로 바꾸는 길이다(환경을 고르지 않는다)
  const again = await c.install()
  assert.equal(again.code, 0, again.all); assert.deepEqual(c.envCalls(), []); assert.match(again.out, /a standalone whosup is here/)
  // 길을 강제했다: 아무것도 없는 기계여도 환경을 고르지 않는다
  const f = await rig()
  const s = await f.install({ WHOSUP_INSTALL_MODE: 'standalone', WHOSUP_ENV: 'herdr-app' })
  assert.equal(s.code, 0, s.all); assert.deepEqual(f.envCalls(), []); assert.match(s.out, /WHOSUP_ENV=herdr-app was not used/); assert.equal(f.rec().env_installed, '')
  // 쓸 수 없는 herdr(이전 버전)가 있는 기계도 "아무것도 없는 기계"가 아니다: 전처럼 올리라고 알리고 끝낸다
  const old = await rig({ herdr: true })
  const o = await old.install({ FAKE_HERDR_VERSION: '0.8.9' })
  assert.equal(o.code, 1); assert.match(o.err, /needs herdr 0\.9\.0 or newer for plugins; this is 0\.8\.9\./); assert.deepEqual(old.envCalls(), [])
})

// 이미 놓여 있는 Herdr 앱(설치 명령을 돌리지 않고 놓는다): 맥은 시스템 응용 프로그램 폴더의 Herdr.app, 리눅스는 ~/.local/bin/herdr-app. 그 경로를 돌려준다.
function placeHerdrApp(r) {
  const at = mac ? join(r.sysApps, 'Herdr.app') : r.herdrApp
  if (mac) mkdirSync(at); else { mkdirSync(join(r.home, '.local', 'bin'), { recursive: true }); exe(at, '#!/bin/sh\nexit 0\n') }
  return at
}
function placeHerdrCore(r) { mkdirSync(join(r.home, '.local', 'bin'), { recursive: true }); return exe(join(r.home, '.local', 'bin', 'herdr-core'), '#!/bin/sh\nexit 0\n') }

test('한 번도 켜지 않은 앱이 이미 놓여 있으면 다시 깔지 않고 그 앱에 붙인다(묻지 않는다) — 함께 깐 것이 아니므로 env_installed는 빈 값', posix, async () => {
  // 앱과 그 코어(herdr-core)가 놓여 있다. 코어는 설치기가 찾는 길(PATH)에 없어 길 고르기가 보지 못한 것 — 이 시험의 PATH에는 ~/.local/bin이 없다
  const r = await rig()
  const at = placeHerdrApp(r); placeHerdrCore(r)
  const a = await r.install()
  assert.equal(a.code, 0, a.all); assert.deepEqual(r.envCalls(), [], '설치 명령을 부르지 않는다')
  assert.ok(a.out.includes(`whosup: the Herdr app is already on this computer (${at}) and has not been opened yet: whosup is installed next to it, nothing else is installed\n`), a.out)
  assert.equal(r.rec().env_installed, ''); assert.doesNotMatch(a.out, /Installed too/)
  assert.deepEqual(nexts(a.out), ['  Next: open the Herdr app once (its sessions show on the board only after it has been opened). Then start a new session from the board.'])
  // Ovis 앱이 놓여 있을 때(맥: 응용 프로그램 폴더의 Ovis.app)
  if (mac) {
    const o = await rig(); mkdirSync(join(o.home, 'Applications', 'Ovis.app'), { recursive: true })
    const b = await o.install({ WHOSUP_LANG: 'ko' })
    assert.equal(b.code, 0, b.all); assert.deepEqual(o.envCalls(), []); assert.equal(o.rec().env_installed, '')
    assert.ok(b.out.includes(`whosup: Ovis 앱이 이미 이 컴퓨터에 있고(${join(o.home, 'Applications', 'Ovis.app')}) 아직 켠 적이 없습니다: 다른 것은 깔지 않고 whosup만 설치합니다\n`), b.out)
    assert.equal(nexts(b.out).length, 1); assert.match(nexts(b.out)[0], /Ovis 앱을 한 번 여세요/)
  }
  // WHOSUP_ENV가 있으면 그것이 먼저다
  const w = await rig(); if (mac) mkdirSync(join(w.sysApps, 'Herdr.app'))
  const c = await w.install({ WHOSUP_ENV: 'ovis-app' })
  assert.equal(c.code, 0, c.all); assert.deepEqual(w.envCalls(), ['ovis-app stdin_tty=0']); assert.equal(w.rec().env_installed, 'ovis-app')
})

test('코어 없이 놓여 있는 Herdr 앱(앞 설치가 코어에서 멈춘 채 남은 것): 다시 돌린 설치기가 정상 설치로 받지 않는다 — 코어를 채우고, 채우지 못하면 whosup을 붙이지 않고 알린다', posix, async () => {
  const coreScript = '#!/bin/sh\nmkdir -p "$HC_INSTALL_DIR" && printf \'#!/bin/sh\\nexit 0\\n\' > "$HC_INSTALL_DIR/herdr-core" && chmod 755 "$HC_INSTALL_DIR/herdr-core"\n'
  const real = { WHOSUP_HERDR_APP_INSTALL_CMD: '' }
  // 코어 설치기를 받을 수 있다: 앱은 다시 깔지 않고(앱 설치 스크립트를 받지 않는다) 코어만 채운 뒤 whosup을 붙인다. 함께 깐 앱이 아니므로 env_installed는 빈 값
  const r = await rig(); const at = placeHerdrApp(r)
  const m = await mirror({ '/core/install.sh': coreScript })
  try {
    const a = await r.install({ ...real, HERDR_RELEASES_URL: m.url })
    assert.equal(a.code, 0, a.all); assert.deepEqual(m.hits, ['GET /core/install.sh'], '앱의 설치 스크립트는 받지 않는다'); assert.deepEqual(r.envCalls(), [])
    assert.equal(existsSync(join(r.home, '.local', 'bin', 'herdr-core')), true, '코어가 놓였다')
    assert.ok(a.out.includes(`whosup: the Herdr app is already on this computer (${at}), but its core, herdr-core, is not: the core is installed first, then whosup next to the app\n`), a.out)
    assert.ok(a.out.includes('whosup: herdr-core, the core of the Herdr app, is installed\n'), a.out)
    assert.doesNotMatch(a.out, /nothing else is installed|the Herdr app is installed:/)
    assert.equal(r.rec().env_installed, ''); assert.equal(nexts(a.out).length, 1); assert.match(nexts(a.out)[0], /open the Herdr app once/)
    assert.deepEqual(r.tmpLeft(), [], '받은 코어 설치 스크립트를 남기지 않는다')
  } finally { await m.close() }
  // 코어 설치기를 받지 못한다(404): whosup을 붙이지 않고 그 사실을 알린 뒤 1로 끝낸다. 놓여 있던 앱은 건드리지 않는다
  for (const lang of ['en', 'ko']) {
    const f = await rig(); const here = placeHerdrApp(f)
    const m2 = await mirror({})
    try {
      const a = await f.install({ ...real, HERDR_RELEASES_URL: m2.url, WHOSUP_LANG: lang })
      assert.equal(a.code, 1, a.all); assert.deepEqual(m2.hits, ['GET /core/install.sh']); assert.doesNotMatch(a.out, /install summary|설치 요약/)
      assert.ok(a.err.endsWith(lang === 'ko'
        ? `whosup: Herdr 앱은 이 컴퓨터에 있는데(${here}) 그 코어(herdr-core)가 없고 설치하지도 못해 세션을 띄울 수 없습니다. Herdr 앱을 직접 다시 설치한 뒤(https://github.com/herdrdev/herdr-app) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다.\n`
        : `whosup: the Herdr app is on this computer (${here}) but its core, herdr-core, is not and could not be installed, so the app cannot run sessions. Install the Herdr app again yourself (https://github.com/herdrdev/herdr-app), then run this installer again. whosup was not installed.\n`), a.err)
      assert.match(a.err, /^curl: /, '받지 못한 까닭(curl의 말)을 먼저 보여 준다')
      assert.equal(existsSync(f.data), false, 'whosup은 설치하지 않았다'); assert.equal(existsSync(here), true, '놓여 있던 앱은 그대로'); assert.deepEqual(f.tmpLeft(), [])
    } finally { await m2.close() }
  }
  // 검토가 짚은 순서 그대로: ① 첫 설치가 앱만 놓고 코어에서 멈춘다(1) ② 같은 명령을 다시 친다 — 남은 앱을 "이미 있는 앱"으로 받아 0으로 끝내지 않는다
  const again = await rig()
  const first = await again.install({ FAKE_APP_NO_CORE: '1' })
  assert.equal(first.code, 1, first.all); assert.equal(existsSync(again.herdrApp), true, '첫 설치가 앱을 남겼다')
  const second = await again.install({ FAKE_APP_NO_CORE: '1' })
  assert.equal(second.code, 1, second.all); assert.match(second.err, /its core, herdr-core, is not and could not be installed, so the app cannot run sessions\./)
  assert.equal(again.envCalls().length, 1, '남은 앱을 다시 깔지는 않는다'); assert.equal(existsSync(again.data), false, 'whosup은 설치하지 않았다'); assert.doesNotMatch(second.out, /install summary/)
  // WHOSUP_ENV=herdr-app으로 다시 치면 앱부터 다시 깐다(그 설치가 코어를 놓으면 이어 간다)
  const third = await again.install({ WHOSUP_ENV: 'herdr-app' })
  assert.equal(third.code, 0, third.all); assert.equal(again.envCalls().length, 2); assert.equal(again.rec().env_installed, 'herdr-app')
})

test('화면이 없는 리눅스 세션(DISPLAY도 WAYLAND_DISPLAY도 없다): 데스크톱 앱을 기본값으로 깔지 않고 터미널용 herdr로 간다 — WHOSUP_ENV로 받은 앱은 깐다. 맥은 화면을 보지 않는다', posix, async () => {
  // 화면 없음: 앱의 설치 명령을 부르지 않고 herdr를 깔아 플러그인으로(전의 길). 이유와 그래도 앱을 까는 법을 한 줄로 알린다
  for (const lang of ['en', 'ko']) {
    const r = await rig(); linuxBox(r)
    const a = await r.install({ ...headless, WHOSUP_HERDR_INSTALL_CMD: r.getHerdr, WHOSUP_LANG: lang })
    assert.equal(a.code, 0, a.all); assert.deepEqual(r.envCalls(), [], '앱의 설치 명령을 부르지 않는다')
    assert.ok(r.herdrCalls().includes(`plugin install ${ROOT} --yes`), 'herdr를 깔고 플러그인으로'); assert.equal(existsSync(r.data), false, '단독 설치의 것을 만들지 않는다')
    assert.ok(a.out.includes(lang === 'ko'
      ? 'whosup: 세션을 띄울 환경이 아직 없고 이 세션에는 데스크톱 화면이 없어(DISPLAY·WAYLAND_DISPLAY 없음) 데스크톱 앱을 깔아도 여기서 열 수 없습니다: 터미널용 herdr를 설치합니다(그래도 앱을 깔려면 이 값을 주세요: WHOSUP_ENV=herdr-app 또는 ovis-app)\n'
      : 'whosup: nothing to run sessions in is here yet, and no desktop is open in this session (DISPLAY and WAYLAND_DISPLAY are not set), so a desktop app could not be opened from here: herdr, for the terminal, is installed (to install an app anyway, set WHOSUP_ENV=herdr-app or ovis-app)\n'), a.out)
    assert.doesNotMatch(a.out, /open the Herdr app|Herdr 앱을 한 번 여세요/, '열 수 없는 앱을 열라고 하지 않는다')
  }
  // 화면이 있다(DISPLAY 또는 WAYLAND_DISPLAY 하나만 있어도): 기본값은 그대로 Herdr 앱
  for (const screen of [{ DISPLAY: ':0', WAYLAND_DISPLAY: undefined }, { DISPLAY: undefined, WAYLAND_DISPLAY: 'wayland-0' }]) {
    const r = await rig(); linuxBox(r)
    const a = await r.install(screen)
    assert.equal(a.code, 0, a.all); assert.deepEqual(r.envCalls(), ['herdr-app stdin_tty=0'], JSON.stringify(screen)); assert.equal(r.rec().env_installed, 'herdr-app')
  }
  // 화면이 없어도 WHOSUP_ENV로 받은 앱은 깐다(환경변수 > 자동 감지 — SSH로 들어온 데스크톱 기계)
  const w = await rig(); linuxBox(w)
  const b = await w.install({ ...headless, WHOSUP_ENV: 'herdr-app' })
  assert.equal(b.code, 0, b.all); assert.deepEqual(w.envCalls(), ['herdr-app stdin_tty=0']); assert.equal(w.rec().env_installed, 'herdr-app')
  // 앱이 어차피 안 되는 기계(판이 없는 프로세서)는 화면이 아니라 그 이유를 말한다
  if (!mac) {
    const odd = await rig(); oddMachine(odd)
    const c = await odd.install({ ...headless, WHOSUP_HERDR_INSTALL_CMD: odd.getHerdr })
    assert.equal(c.code, 0, c.all); assert.match(c.out, /neither app can be installed on this computer/); assert.doesNotMatch(c.out, /no desktop is open/)
  }
  // 맥: DISPLAY가 없어도(늘 없다) 기본값은 Herdr 앱 — SSH로 들어온 설치도 같다
  if (mac) {
    for (const over of [headless, { ...headless, SSH_CONNECTION: '10.0.0.2 50000 10.0.0.1 22', SSH_TTY: '/dev/ttys009' }]) {
      const m = await rig()
      const d = await m.install(over)
      assert.equal(d.code, 0, d.all); assert.deepEqual(m.envCalls(), ['herdr-app stdin_tty=0']); assert.doesNotMatch(d.out, /no desktop is open/)
    }
  }
})

test('이어 주기: 보드를 켜고 로그인 항목을 둔 설치의 요약, 새 버전으로 바꿔도 남는 env_installed, uninstall은 그 앱을 지우지 않고 한 줄로 알린다', posix, async () => {
  const r = await rig()
  try {
    // DISPLAY: 리눅스에서 화면이 없으면 원격으로 보아 브라우저 줄 아래에 "포트를 넘기세요" 줄이 더 붙는다(아래 줄 번호가 어긋난다) — 화면이 있는 것으로 둔다
    const a = await r.install({ WHOSUP_NO_AUTOSTART: '', WHOSUP_NO_LOGIN_START: '', DISPLAY: ':0' })
    assert.equal(a.code, 0, a.all); assert.equal(await r.health(), true, '보드가 켜졌다')
    const s = summaryOf(a.out).split('\n')
    // 설치 줄 · 프로그램 · 함께 깐 앱 · 보드 · 브라우저 · 다음에 할 일(브라우저를 열지 않는 설치는 앱도 열지 않는다 — "여세요") · 로그인 …
    assert.deepEqual(s.slice(0, 4), ['whosup install summary', '  Installed on its own, without herdr (standalone).', `  Program: ${r.app}`, `  Installed too: the Herdr app (${r.herdrApp}).`])
    assert.match(s[4], /^ {2}The board is running: {2}http:\/\/127\.0\.0\.1:\d+$/); assert.equal(s[5], '    No browser opens by itself here. Open that address on this computer.')
    assert.equal(s[6], '  Next: open the Herdr app once (its sessions show on the board only after it has been opened). Then start a new session from the board.')
    assert.equal(nexts(a.out).length, 1); assert.equal(existsSync(r.loginFile), true)
    // 설치기가 이 단계에만 넘긴 값은 켜진 보드가 물려받지 않는다
    const pid = r.pid(); assert.ok(pid > 1)
    const envOfBoard = spawnSync('ps', ['eww', '-o', 'command=', '-p', String(pid)], { encoding: 'utf8' }).stdout
    assert.doesNotMatch(envOfBoard, /WHOSUP_ENV_(PICK|INSTALLED|APP)=/)
    // 새 버전으로 바꾼다: 기록의 env_installed는 그대로이고, 요약에 "다음에 할 일"을 다시 싣지 않는다
    const u = await r.whosup(['update'], { WHOSUP_NO_AUTOSTART: '', WHOSUP_NO_LOGIN_START: '' })
    assert.equal(u.code, 0, u.all); assert.equal(r.rec().env_installed, 'herdr-app'); assert.equal(r.rec().env_app, r.herdrApp)
    assert.deepEqual(nexts(u.out), []); assert.doesNotMatch(u.out, /Installed too/); assert.deepEqual(r.envCalls(), ['herdr-app stdin_tty=0'], '앱을 다시 깔지 않는다')
    // 지운다: 앱은 그대로 두고 한 줄로 알린다
    const x = await r.whosup(['uninstall'])
    assert.equal(x.code, 0, x.all)
    assert.ok(x.out.endsWith(`  whosup does not remove apps: the Herdr app, installed together with whosup, was left in place. To remove it, quit it and delete ${r.herdrApp} yourself.\n`), x.out)
    assert.equal(x.out.split('\n').filter((l) => /Herdr app/.test(l)).length, 1, '한 줄만')
    assert.equal(existsSync(r.herdrApp), true, '앱을 지우지 않는다'); assert.equal(existsSync(join(r.home, '.local', 'bin', 'herdr-core')), true); assert.equal(existsSync(r.app), false)
  } finally { r.cleanup() }
  // 한국어, Ovis 앱
  const o = await rig()
  assert.equal((await o.install({ WHOSUP_ENV: 'ovis-app' })).code, 0)
  const k = await o.whosup(['uninstall', '--purge'], { WHOSUP_LANG: 'ko' })
  assert.equal(k.code, 0, k.all); assert.ok(k.out.endsWith(`  Ovis 앱은 whosup과 함께 설치한 것으로, 지우지 않았습니다(whosup은 앱을 지우지 않습니다). 지우려면 그 앱을 끝낸 뒤 ${o.ovisApp()} 항목을 직접 지우세요.\n`), k.out)
  assert.equal(existsSync(o.ovisApp()), true)
  // 함께 깐 앱이 없는 설치의 uninstall에는 그 줄이 없다
  const p = await rig()
  assert.equal((await p.install({ WHOSUP_INSTALL_MODE: 'standalone' })).code, 0)
  const q = await p.whosup(['uninstall'])
  assert.equal(q.code, 0, q.all); assert.doesNotMatch(q.out, /left in place|does not remove apps/)
})

test('설치 기록의 env_installed·env_app, 요약의 줄, 앱 열기: 아는 값만 받고, 여는 것은 브라우저와 같은 판정이며 깐 앱의 전체 경로로 연다', () => {
  // 기록: 아는 환경만, 경로는 절대 경로만
  assert.deepEqual(envOf({ env_installed: 'herdr-app', env_app: '/h/Applications/Herdr.app' }), { installed: 'herdr-app', app: '/h/Applications/Herdr.app' })
  assert.deepEqual(envOf({ env_installed: 'ovis-app' }), { installed: 'ovis-app', app: '' })
  for (const bad of [null, {}, { env_installed: 'herdr' }, { env_installed: 'docker', env_app: '/x' }, { env_installed: ['herdr-app'] }, { env_app: '/only/path' }]) assert.deepEqual(envOf(bad), { installed: '', app: '' }, JSON.stringify(bad))
  for (const badPath of ['rel/Herdr.app', '/a\nb', 7, `/${'x'.repeat(1100)}`]) assert.equal(envOf({ env_installed: 'herdr-app', env_app: badPath }).app, '')
  const home = join(bareHome(), 'h'); mkdirSync(home, { recursive: true })
  const L = layout({ XDG_STATE_HOME: join(home, '.state') }, home)
  assert.equal(writeRecord(L, { id: 'fivetaku.whosup' }).env_installed, '', '없으면 빈 값'); assert.equal('env_app' in readRecordFile(L.data), false)
  const body = writeRecord(L, { id: 'fivetaku.whosup', envInstalled: 'ovis-app', envApp: '/h/Applications/Ovis.app' })
  assert.equal(body.env_installed, 'ovis-app'); assert.equal(body.env_app, '/h/Applications/Ovis.app'); assert.deepEqual(readRecordFile(L.data), body)
  assert.equal(writeRecord(L, { id: 'fivetaku.whosup', envInstalled: 'nope', envApp: '/x' }).env_installed, '')

  // 요약의 환경 고르기 결과: 새 설치이고 정한 앱이 있을 때만
  const calls = []
  const open = (p, o) => { calls.push([p, o.platform]); return true }
  const envIn = { WHOSUP_ENV_PICK: 'herdr-app', WHOSUP_ENV_APP: '/h/Applications/Herdr.app' }
  assert.equal(pickedEnv({ env: {}, open }), null); assert.equal(pickedEnv({ env: { WHOSUP_ENV_PICK: 'herdr' }, open }), null); assert.equal(pickedEnv({ env: envIn, kind: 'update', mayOpen: true, open }), null)
  // 열어도 되지 않으면(OPEN_BROWSER=0 · 원격 · CI · 켜지 않기로 한 설치) 열지 않는다
  assert.deepEqual(pickedEnv({ env: envIn, installed: 'herdr-app', mayOpen: false, open }), { pick: 'herdr-app', installed: true, app: '/h/Applications/Herdr.app', opened: false }); assert.deepEqual(calls, [])
  // 열어도 되면 그 앱의 전체 경로로 연다
  assert.deepEqual(pickedEnv({ env: envIn, installed: '', mayOpen: true, platform: 'darwin', open }), { pick: 'herdr-app', installed: false, app: '/h/Applications/Herdr.app', opened: true }); assert.deepEqual(calls, [['/h/Applications/Herdr.app', 'darwin']])
  assert.equal(pickedEnv({ env: { WHOSUP_ENV_PICK: 'ovis-app', WHOSUP_ENV_APP: 'Ovis.app' }, mayOpen: true, open }).opened, false, '경로를 모르면 열지 않는다'); assert.equal(calls.length, 1)

  // 앱 열기: 맥은 /usr/bin/open <전체 경로>, 그 밖은 그 실행 파일. 이름으로(PATH에서) 찾지 않는다. 없는 경로·상대 경로·윈도우는 열지 않는다
  const spawned = []
  const spawnFn = (file, args, o) => { spawned.push([file, args, o.detached, o.stdio]); return { once() {}, unref() {} } }
  const yes = () => true
  assert.equal(openApp('/h/Applications/Herdr.app', { platform: 'darwin', spawnFn, exists: yes }), true)
  assert.equal(openApp('/h/.local/bin/herdr-app', { platform: 'linux', spawnFn, exists: yes }), true)
  assert.deepEqual(spawned, [['/usr/bin/open', ['/h/Applications/Herdr.app'], true, 'ignore'], ['/h/.local/bin/herdr-app', [], true, 'ignore']])
  assert.equal(openApp('/h/gone.app', { platform: 'darwin', spawnFn, exists: () => false }), false); assert.equal(openApp('Herdr.app', { platform: 'darwin', spawnFn, exists: yes }), false)
  assert.equal(openApp('/h/x', { platform: 'win32', spawnFn, exists: yes }), false); assert.equal(openApp('/h/x', { platform: 'linux', spawnFn: () => { throw new Error('no') }, exists: yes }), false)
  assert.equal(spawned.length, 2)

  // 요약의 줄: 함께 깐 앱은 설치 줄 아래 한 줄, 다음에 할 일은 보드 줄 아래 한 줄. 연 경우와 열지 않은 경우의 말이 다르다. 영어·한국어 짝
  const up = { up: true, url: 'http://127.0.0.1:4790', port: '4790' }
  for (const lang of ['en', 'ko']) {
    const T = TEXT[lang]
    assert.deepEqual(Object.keys(T.envNames), ['herdr-app', 'ovis-app'])
    for (const pick of ['herdr-app', 'ovis-app']) {
      const name = T.envNames[pick]
      const closed = standaloneLines({ kind: 'install', app: '/a', board: up, login: 'on', env: { pick, installed: true, app: '/h/App.app', opened: false } }, T)
      assert.equal(closed[3], `  ${T.saEnvInstalled(name, '/h/App.app')}`); assert.equal(closed[6], `  ${T.saEnvNext(name)}`)
      assert.equal(nexts(closed.join('\n')).length, 1); assert.deepEqual(herdrCommandLines(closed.join('\n')), [])
      const opened = standaloneLines({ kind: 'install', app: '/a', board: up, login: 'on', env: { pick, installed: false, app: '/h/App.app', opened: true } }, T)
      assert.equal(opened[5], `  ${T.saEnvNextOpened(name)}`); assert.equal(opened.includes(`  ${T.saEnvInstalled(name, '/h/App.app')}`), false, '함께 깐 것이 아니면 그 줄이 없다')
      // 보드가 꺼져 있어도 다음에 할 일은 한 번 나온다
      assert.equal(nexts(standaloneLines({ kind: 'install', board: { up: false }, env: { pick, installed: true, app: '', opened: false } }, T).join('\n')).length, 1)
    }
    // 환경을 고르지 않은 설치·새 버전으로 바꾼 설치·다시 하는 첫 실행 안내의 줄은 그대로다
    const plain = standaloneLines({ kind: 'install', app: '/a', board: up, login: 'on' }, T)
    assert.deepEqual(standaloneLines({ kind: 'install', app: '/a', board: up, login: 'on', env: null }, T), plain); assert.deepEqual(standaloneLines({ kind: 'install', app: '/a', board: up, login: 'on', env: { pick: 'herdr' } }, T), plain)
    for (const kind of ['update', 'setup']) assert.deepEqual(standaloneLines({ kind, app: '/a', board: up, login: 'on', env: { pick: 'herdr-app', installed: true, app: '/x', opened: true } }, T), standaloneLines({ kind, app: '/a', board: up, login: 'on' }, T))
    assert.match(T.saEnvKept(T.envNames['herdr-app'], '/h/Herdr.app'), /\/h\/Herdr\.app/); assert.doesNotMatch(T.saEnvKept(T.envNames['ovis-app'], ''), /undefined|  /)
  }
})

// ── 터미널에서 묻기(가짜 터미널) ──
// script 명령이 가짜 터미널을 만들어 그 안에서 설치기를 돌린다. 번호 입력 줄이 나올 때마다 answers의 답을 차례로 넣고, 다 쓰면 Enter를 넣는다
// (뒤에 이어지는 whosup 첫 실행 안내의 질문도 Enter로 넘긴다). 돌려주는 것: 화면 글자(줄 끝의 \r은 뗀다)와 넣은 답의 수.
const hasScript = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
const tty = { skip: hasScript ? false : '가짜 터미널을 만들 script 명령이 없다' }
const PROMPT = /Type a number|번호를 입력하세요/g
// node가 주는 표준 입력은 소켓이라 script가 받지 못한다(맥): cat을 사이에 두어 파이프로 넘긴다. 설치기가 끝나면 표식 줄(@@ENV-DONE <종료 코드>)을
// 찍게 하고, 그것을 보면 입력을 닫는다(cat이 끝난다). silent = 아무 답도 넣지 않는다(자리에 없는 설치).
const DONE = /@@ENV-DONE (\d+)/
function onTerminal(r, answers, over = {}, { silent = false } = {}) {
  const env = Object.fromEntries(Object.entries(r.env(over)).filter(([, v]) => v !== undefined))
  const inner = mac ? `script -q /dev/null ${shq(SH)} ${shq(INSTALL)}` : `script -qec ${shq(`${shq(SH)} ${shq(INSTALL)}`)} /dev/null`
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `cat | { ${inner}; echo "@@ENV-DONE $?"; }`], { env, cwd: r.base, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let screen = '', seen = 0, typed = 0, ended = false
    const left = [...answers]
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} reject(new Error(`timed out on the terminal\n${screen}`)) }, 90000)
    child.stdin.on('error', () => {})
    child.stdout.on('data', (c) => {
      screen += c
      if (!ended && DONE.test(screen)) { ended = true; setTimeout(() => { try { child.stdin.end() } catch {} }, 50); return }
      if (silent || ended) return
      const n = (screen.match(PROMPT) || []).length
      for (; seen < n; seen++) { typed++; const reply = left.length ? left.shift() : ''; setTimeout(() => { try { child.stdin.write(`${reply}\n`) } catch {} }, 150) }
    })
    child.stderr.on('data', (c) => { screen += c })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      const m = DONE.exec(screen)
      resolve({ code: m ? Number(m[1]) : null, typed, screen: screen.replace(/\r/g, '').replace(/\^D\x08\x08/g, '').replace(/@@ENV-DONE \d+\n?/, '') })
    })
  })
}
// 화면에서 환경 질문을 뽑는다: 번호 입력 줄 위의 선택지("N) 글")와 제목 줄, 선택지 아래의 설명 줄(notes = 그 수, desc = 글).
function envQuestions(screen) {
  const out = []
  const rows = screen.split('\n')
  rows.forEach((row, i) => {
    if (!/Type a number|번호를 입력하세요/.test(row)) return
    const block = []
    for (let k = i - 1; k >= 0 && rows[k].trim() && !/Type a number|번호를 입력하세요/.test(rows[k]); k--) block.unshift(rows[k])
    const options = block.filter((l) => /^ {4}\d+\) \S/.test(l)).map((l) => l.trim())
    const desc = block.filter((l) => /^ {7}\S/.test(l)).map((l) => l.trim())
    if (/^1\) (Desktop app|데스크톱 앱|Herdr) \*$/.test(options[0] || '')) out.push({ title: block[0].trim(), options, notes: desc.length, desc, prompt: row.trim() })
  })
  return out
}

test('터미널에서 고르기: 두 번 묻는다(데스크톱 앱 / 터미널 → Herdr / Ovis). 번호만 치면 되고 Enter는 * 표시(앱 → Herdr), 선택지마다 한 줄 설명', tty, async () => {
  // Enter 두 번 = 기본값(Herdr 앱)
  const d = await rig()
  const a = await onTerminal(d, ['', ''])
  assert.equal(a.code, 0, a.screen); assert.deepEqual(d.envCalls(), ['herdr-app stdin_tty=0'], '설치 명령은 터미널 입력을 받지 못한다'); assert.equal(d.rec().env_installed, 'herdr-app')
  const qa = envQuestions(a.screen)
  assert.deepEqual(qa.map((q) => [q.title, q.options, q.notes]), [
    ['Where do you want to run your sessions', ['1) Desktop app *', '2) Terminal'], 2],
    ['Which app', ['1) Herdr *', '2) Ovis'], 2],
  ], a.screen)
  assert.ok(qa.every((q) => /^Type a number, or press Enter for 1: ?$/.test(q.prompt)), a.screen)
  assert.match(a.screen, /whosup: nothing to run agent sessions in is here yet\. Pick one and it is installed for you, then whosup\.\n {2}Enter takes the choice marked \*\. With no answer for 120 s, the install goes on with it by itself\.\n/)
  assert.match(a.screen, / {7}The Ovis app, a download of about 175 MB/, '큰 것은 크기를 말한다')
  assert.equal(qa[0].desc[0], 'An app with its own window (Herdr or Ovis — you pick it next). Nothing to learn in the terminal.', '첫 질문에서부터 깔 수 있는 앱의 이름이 보인다')
  assert.equal(nexts(a.screen).length, 1); assert.match(nexts(a.screen)[0], /the Herdr app/); assert.deepEqual(herdrCommandLines(a.screen), [])
  // 1 · 1 = Herdr 앱, Enter · 2 = Ovis 앱(한국어 화면)
  const h = await rig()
  assert.equal((await onTerminal(h, ['1', '1'])).code, 0); assert.deepEqual(h.envCalls(), ['herdr-app stdin_tty=0'])
  const o = await rig()
  const b = await onTerminal(o, ['', '2'], { WHOSUP_LANG: 'ko' })
  assert.equal(b.code, 0, b.screen); assert.deepEqual(o.envCalls(), ['ovis-app stdin_tty=0']); assert.equal(o.rec().env_installed, 'ovis-app')
  assert.deepEqual(envQuestions(b.screen).map((q) => [q.title, q.options, q.notes]), [
    ['세션을 어디에서 쓸까요', ['1) 데스크톱 앱 *', '2) 터미널'], 2],
    ['어느 앱을 쓸까요', ['1) Herdr *', '2) Ovis'], 2],
  ], b.screen)
  assert.ok(envQuestions(b.screen).every((q) => /^번호를 입력하세요 \(Enter만 치면 1번\): ?2?$/.test(q.prompt)), b.screen)
  assert.equal(envQuestions(b.screen)[0].desc[0], '창이 따로 뜨는 앱(Herdr 또는 Ovis — 다음 질문에서 고릅니다)을 설치합니다. 터미널을 몰라도 됩니다.', b.screen)
  assert.match(envQuestions(b.screen)[0].desc[1], /herdr를/, '터미널의 설명은 herdr를 댄다')
  assert.equal(nexts(b.screen).length, 1); assert.match(nexts(b.screen)[0], /Ovis 앱을 한 번 여세요/)
  // 2 = 터미널: 둘째 질문 없이 herdr를 깔고 플러그인으로(기존 길). "다음에 할 일"과 herdr를 치라는 줄은 한 번씩
  const t = await rig()
  const c = await onTerminal(t, ['2'], { WHOSUP_HERDR_INSTALL_CMD: t.getHerdr })
  assert.equal(c.code, 0, c.screen); assert.deepEqual(t.envCalls(), []); assert.equal(envQuestions(c.screen).length, 1, c.screen)
  assert.ok(t.herdrCalls().includes(`plugin install ${ROOT} --yes`)); assert.equal(existsSync(t.data), false)
  assert.equal(nexts(c.screen).length, 1); assert.deepEqual(herdrCommandLines(c.screen), [`      ${join(t.home, '.local', 'bin', 'herdr')}`], '칠 명령은 한 번, PATH에 없는 폴더라 전체 경로로(가-5 · F7)')
})

test('터미널에서 고르기: 틀린 입력은 다시 묻고 세 번이면 * 표시로, 답이 없으면 시간 제한 뒤 * 표시로 넘어간다. 묻지 않기로 한 설치(WHOSUP_NO_SETUP · CI · WHOSUP_ENV)는 터미널이 있어도 묻지 않는다', tty, async () => {
  const bad = await rig()
  const a = await onTerminal(bad, ['9', 'x', '0', '2'])
  assert.equal(a.code, 0, a.screen); assert.deepEqual(bad.envCalls(), ['ovis-app stdin_tty=0'], '첫 질문은 세 번 틀려 1번(앱), 둘째 질문은 2번(Ovis)')
  assert.equal((a.screen.match(/Please type a number from 1 to 2\./g) || []).length, 2); assert.match(a.screen, / {4}Going on with the choice marked \*\.\n/)
  assert.equal(envQuestions(a.screen).length, 2, a.screen)
  // 틀린 입력 뒤 맞는 번호: 다시 물은 데서 고른다(첫 질문 3 → 2 = 터미널, 둘째 질문 없이 herdr)
  const fix = await rig()
  const f = await onTerminal(fix, ['3', '2'], { WHOSUP_HERDR_INSTALL_CMD: fix.getHerdr })
  assert.equal(f.code, 0, f.screen); assert.deepEqual(fix.envCalls(), []); assert.ok(fix.herdrCalls().includes(`plugin install ${ROOT} --yes`))
  assert.equal((f.screen.match(/Please type a number from 1 to 2\./g) || []).length, 1); assert.equal(envQuestions(f.screen).length, 1, f.screen)
  // 답이 없다: 시간 제한(WHOSUP_SETUP_TIMEOUT_S — 첫 실행 안내와 같은 값) 뒤 기본값으로 넘어가고 남은 질문도 묻지 않는다
  const away = await rig()
  const child = await onTerminal(away, [], { WHOSUP_SETUP_TIMEOUT_S: '1' }, { silent: true })
  assert.equal(child.code, 0, child.screen); assert.deepEqual(away.envCalls(), ['herdr-app stdin_tty=0'])
  assert.match(child.screen, /No input for 1 s: going on with the choice marked \*\./); assert.equal(envQuestions(child.screen).length, 1, '둘째 질문은 묻지 않는다')
  // 묻지 않기로 한 설치
  for (const over of [{ WHOSUP_NO_SETUP: '1' }, { CI: '1' }, { WHOSUP_ENV: 'ovis-app' }]) {
    const r = await rig()
    const x = await onTerminal(r, [], over)
    assert.equal(x.code, 0, x.screen); assert.equal(envQuestions(x.screen).length, 0, JSON.stringify(over))
    assert.deepEqual(r.envCalls(), [over.WHOSUP_ENV ? 'ovis-app stdin_tty=0' : 'herdr-app stdin_tty=0'])
  }
})

test('터미널에서 고르기: 이 기계에 깔 수 없는 환경은 선택지에 없고(받는 곳을 알린다), 남는 것이 하나면 묻지 않는다', tty, async () => {
  const r = await rig(); oddMachine(r)
  const a = await onTerminal(r, [''], { WHOSUP_HERDR_INSTALL_CMD: r.getHerdr })
  assert.equal(a.code, 0, a.screen)
  if (mac) {
    // 인텔 맥: Herdr 앱이 없다 — 첫 질문만 묻고(앱 / 터미널), 앱이면 Ovis 하나라 둘째 질문은 없다
    assert.deepEqual(envQuestions(a.screen).map((q) => q.options), [['1) Desktop app *', '2) Terminal']], a.screen)
    assert.match(a.screen, / {2}The Herdr app is not offered here: the Herdr app does not run on Intel Macs\. To get it yourself: https:\/\/github\.com\/herdrdev\/herdr-app\n/)
    assert.deepEqual(r.envCalls(), ['ovis-app stdin_tty=0']); assert.doesNotMatch(a.screen, /1\) Herdr/)
    assert.equal(envQuestions(a.screen)[0].desc[0], 'An app with its own window (Ovis — the only one offered here, so nothing more is asked). Nothing to learn in the terminal.', '첫 질문에서 Ovis가 보인다')
  } else {
    // 두 앱 모두 안 되는 기계: 고를 것이 없다 — 묻지 않고 터미널용 herdr
    assert.equal(envQuestions(a.screen).length, 0, a.screen); assert.deepEqual(r.envCalls(), []); assert.ok(r.herdrCalls().includes(`plugin install ${ROOT} --yes`))
  }
  // 화면이 없는 리눅스 세션(SSH로 들어온 터미널): 열 수 없는 앱을 고르라고 묻지 않는다 — 터미널용 herdr
  const h = await rig(); linuxBox(h)
  const b = await onTerminal(h, [''], { ...headless, WHOSUP_HERDR_INSTALL_CMD: h.getHerdr })
  assert.equal(b.code, 0, b.screen); assert.equal(envQuestions(b.screen).length, 0, b.screen); assert.deepEqual(h.envCalls(), [])
  assert.match(b.screen, /no desktop is open in this session/); assert.ok(h.herdrCalls().includes(`plugin install ${ROOT} --yes`))
})

test('터미널에서 고르기: "데스크톱 앱"의 설명 줄은 이 기계에 깔 수 있는 앱의 이름을 댄다 — 둘이면 둘 다(다음 질문에서 고른다), 하나면 그 하나(더 묻지 않는다)', tty, async () => {
  // 둘 다 깔 수 있다
  const both = await rig()
  const a = await onTerminal(both, ['2'], { WHOSUP_LANG: 'ko', WHOSUP_HERDR_INSTALL_CMD: both.getHerdr })
  assert.equal(a.code, 0, a.screen)
  assert.deepEqual(envQuestions(a.screen).map((q) => [q.options, q.desc[0]]), [[['1) 데스크톱 앱 *', '2) 터미널'], '창이 따로 뜨는 앱(Herdr 또는 Ovis — 다음 질문에서 고릅니다)을 설치합니다. 터미널을 몰라도 됩니다.']], a.screen)
  // Herdr 앱만: Ovis 앱을 깔 수 없는 기계(맥은 macOS 12, 리눅스는 라이브러리·FUSE가 없다 — 대역 설치 명령을 빼서 진짜 판정을 보게 한다)
  const h = await rig(); if (mac) exe(join(h.bin, 'sw_vers'), '#!/bin/sh\necho 12.7\n')
  const b = await onTerminal(h, [''], { WHOSUP_OVIS_APP_INSTALL_CMD: '' })
  assert.equal(b.code, 0, b.screen); assert.deepEqual(h.envCalls(), ['herdr-app stdin_tty=0'], '앱이 하나라 둘째 질문 없이 Herdr 앱')
  assert.deepEqual(envQuestions(b.screen).map((q) => [q.options, q.desc[0]]), [[['1) Desktop app *', '2) Terminal'], 'An app with its own window (Herdr — the only one offered here, so nothing more is asked). Nothing to learn in the terminal.']], b.screen)
  assert.match(b.screen, / {2}The Ovis app is not offered here: /); assert.doesNotMatch(b.screen, /Which app/)
  // Ovis 앱만: 인텔 맥(리눅스에서는 이 대역이 두 앱을 다 막으므로 맥에서만 본다)
  if (mac) {
    const o = await rig(); oddMachine(o)
    const c = await onTerminal(o, ['1'], { WHOSUP_LANG: 'ko' })
    assert.equal(c.code, 0, c.screen); assert.deepEqual(o.envCalls(), ['ovis-app stdin_tty=0'])
    assert.deepEqual(envQuestions(c.screen).map((q) => [q.options, q.desc[0]]), [[['1) 데스크톱 앱 *', '2) 터미널'], '창이 따로 뜨는 앱(Ovis — 여기서 깔 수 있는 앱은 이것뿐이라 더 묻지 않습니다)을 설치합니다. 터미널을 몰라도 됩니다.']], c.screen)
    assert.doesNotMatch(c.screen, /어느 앱을 쓸까요/)
  }
})

// ── 진짜 내려받기 길(로컬 서버를 릴리스 주소로) ──
// routes: { '/경로': 글자 | Buffer | { status, headers, body } }. 없는 경로는 404.
async function mirror(routes) {
  const port = await freePort()
  const hits = []
  // 같이 도는 다른 시험이 같은 포트 대역에서 보드를 찾느라 보내는 상태 확인(GET /api/…)은 적지 않는다: 설치기가 보낸 요청만 센다
  const server = createServer((req, res) => {
    if (!/^\/api\//.test(req.url)) hits.push(`${req.method} ${req.url}`)
    const hit = routes[req.url]
    if (hit === undefined) { res.writeHead(404); res.end('not found'); return }
    const o = typeof hit === 'object' && !Buffer.isBuffer(hit) ? hit : { body: hit }
    res.writeHead(o.status || 200, o.headers || {}); res.end(req.method === 'HEAD' ? undefined : o.body || '')
  })
  await new Promise((ok) => server.listen(port, '127.0.0.1', ok))
  return { url: `http://127.0.0.1:${port}`, hits, close: () => new Promise((ok) => server.close(ok)) }
}

test('Herdr 앱의 공식 설치 스크립트: 파일로 받아 확인한 뒤 입력 없이 돌리고, 끝난 뒤 앱과 코어가 놓였는지 본다 — 코어만 빠졌으면 코어 설치기를 한 번 더', posix, async () => {
  const placeApp = (log) => fakeHerdrApp(log)
  const coreScript = '#!/bin/sh\nmkdir -p "$HC_INSTALL_DIR" && printf \'#!/bin/sh\\nexit 0\\n\' > "$HC_INSTALL_DIR/herdr-core" && chmod 755 "$HC_INSTALL_DIR/herdr-core"\n'
  // 받은 스크립트가 앱과 코어를 놓는다
  const r = await rig()
  const m = await mirror({ '/app/install.sh': placeApp(r.envLog) })
  try {
    const a = await r.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', HERDR_RELEASES_URL: m.url })
    assert.equal(a.code, 0, a.all); assert.deepEqual(m.hits, ['GET /app/install.sh']); assert.deepEqual(r.envCalls(), ['herdr-app stdin_tty=0']); assert.equal(r.rec().env_installed, 'herdr-app')
    assert.deepEqual(r.tmpLeft(), [], '받은 스크립트와 그 설치기의 임시 파일을 남기지 않는다')
  } finally { await m.close() }
  // 앱만 놓고 0으로 끝났다(코어 설치기를 받지 못한 경우): 코어 설치기를 한 번 더 돌려 채운다
  const c = await rig()
  const m2 = await mirror({ '/app/install.sh': `${placeApp(c.envLog).replace('if [ -z "${FAKE_APP_NO_CORE:-}" ]', 'if false')}`, '/core/install.sh': coreScript })
  try {
    const a = await c.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', HERDR_RELEASES_URL: m2.url })
    assert.equal(a.code, 0, a.all); assert.deepEqual(m2.hits, ['GET /app/install.sh', 'GET /core/install.sh']); assert.equal(existsSync(join(c.home, '.local', 'bin', 'herdr-core')), true)
  } finally { await m2.close() }
  // 받지 못했다(404) · 스크립트가 아닌 것이 왔다(오류 페이지): 돌리지 않고 알린다. 아무것도 남기지 않는다
  for (const routes of [{}, { '/app/install.sh': '<html>temporarily unavailable</html>\n' }]) {
    const f = await rig()
    const m3 = await mirror(routes)
    try {
      const a = await f.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', HERDR_RELEASES_URL: m3.url })
      assert.equal(a.code, 1, a.all); assert.ok(a.err.includes(`whosup: the Herdr app was not installed: its installer could not be downloaded from ${m3.url}. Get it yourself (https://github.com/herdrdev/herdr-app)`), a.err)
      assert.deepEqual(walk(f.home), []); assert.deepEqual(f.tmpLeft(), []); assert.deepEqual(f.envCalls(), [])
    } finally { await m3.close() }
  }
  // 스크립트는 0으로 끝났는데 아무것도 놓지 않았고 코어 설치기도 없다: 깔린 것으로 보지 않는다
  const n = await rig()
  const m4 = await mirror({ '/app/install.sh': '#!/bin/sh\necho "nothing to do"\nexit 0\n' })
  try {
    const a = await n.install({ WHOSUP_ENV: 'herdr-app', WHOSUP_HERDR_APP_INSTALL_CMD: '', HERDR_RELEASES_URL: m4.url })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /nothing to do\nwhosup: the Herdr app was not installed: its installer ended with 0 and the app is not in place\./); assert.deepEqual(walk(n.home), [])
  } finally { await m4.close() }
})

test('Ovis 앱의 릴리스 파일: 판을 정해 받고 체크섬(맥은 서명까지)이 맞을 때만 놓는다 — 어긋나면 받은 파일도, 풀다 만 폴더도 남기지 않는다', posix, async () => {
  const sha512 = (buf) => createHash('sha512').update(buf).digest('base64')
  const cpu = mac ? 'arm64' : process.arch === 'arm64' ? 'arm64' : 'x64'
  const asset = mac ? `Ovis-mac-${cpu}.zip` : `Ovis-linux-${cpu}.AppImage`
  const feedName = mac ? 'latest-mac.yml' : cpu === 'arm64' ? 'latest-linux-arm64.yml' : 'latest-linux.yml'
  const feedOf = (sum) => (mac ? JSON.stringify({ version: '9.9.9', files: [{ url: asset, sha512: sum, size: 1 }, { url: 'Other.zip', sha512: sha512(Buffer.from('other')) }], path: asset, sha512: sum })
    : `version: 9.9.9\nfiles:\n  - url: Other.AppImage\n    sha512: ${sha512(Buffer.from('other'))}\n    size: 3\n  - url: ${asset}\n    sha512: ${sum}\n    size: 1\npath: ${asset}\nsha512: ${sum}\n`)
  const latest = { status: 302, headers: { location: 'https://example.invalid/devswha/ovis/releases/tag/v9.9.9' } }
  const body = Buffer.from('not really an app\n')
  const real = { WHOSUP_ENV: 'ovis-app', WHOSUP_OVIS_APP_INSTALL_CMD: '' }
  const place = (r) => (mac ? join(r.home, 'Applications') : join(r.home, '.local', 'share', 'ovis-desktop'))
  const nothingLeft = (r) => { assert.deepEqual(existsSync(place(r)) ? readdirSync(place(r)) : [], [], '앱 폴더에 받다 만 것이 없다'); assert.deepEqual(r.tmpLeft(), []); assert.equal(existsSync(r.data), false, 'whosup을 설치하지 않았다') }
  // 이 기계가 그 앱을 받을 수 있는가(리눅스는 데스크톱 라이브러리와 FUSE가 있어야 한다). 없으면 깔 수 없다고 알리는 것까지만 본다
  const probe = await rig()
  const first = await probe.install({ ...real, WHOSUP_OVIS_RELEASES_URL: 'http://127.0.0.1:1' })
  assert.equal(first.code, 1, first.all)
  if (/cannot be installed on this computer/.test(first.err)) {
    assert.match(first.err, /^whosup: WHOSUP_ENV=ovis-app cannot be installed on this computer: .*\. Nothing was installed\. .*get it yourself: https:\/\/ovis\.sh\n$/); assert.deepEqual(walk(probe.home), [])
    return
  }
  // 릴리스를 읽지 못했다(닿지 않는 주소)
  assert.ok(first.err.includes('whosup: the Ovis app was not installed: the latest release could not be read from http://127.0.0.1:1. Get it yourself (https://ovis.sh), then run this installer again. whosup was not installed.\n'), first.err)
  nothingLeft(probe)
  // 체크섬이 다르다: 받은 파일을 남기지 않는다
  const w = await rig()
  const m = await mirror({ '/latest': latest, [`/download/v9.9.9/${asset}`]: body, [`/download/v9.9.9/${feedName}`]: feedOf(sha512(Buffer.from('something else'))) })
  try {
    const a = await w.install({ ...real, WHOSUP_OVIS_RELEASES_URL: m.url })
    assert.equal(a.code, 1, a.all); assert.deepEqual(m.hits, ['HEAD /latest', `GET /download/v9.9.9/${asset}`, `GET /download/v9.9.9/${feedName}`], '판을 먼저 정하고 그 판의 파일과 체크섬 파일을 받는다')
    assert.ok(a.err.includes(`whosup: the Ovis app was not installed: the downloaded ${asset} does not match the checksum its release gives (${feedName}), so it was not kept.`), a.err)
    nothingLeft(w)
  } finally { await m.close() }
  // 체크섬 파일에 그 이름이 없다 · 파일을 받지 못했다
  const miss = await rig()
  const m2 = await mirror({ '/latest': latest, [`/download/v9.9.9/${asset}`]: body, [`/download/v9.9.9/${feedName}`]: feedOf(sha512(body)).split(asset).join('Renamed.bin') })
  try {
    const a = await miss.install({ ...real, WHOSUP_OVIS_RELEASES_URL: m2.url })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /does not match the checksum its release gives/); nothingLeft(miss)
  } finally { await m2.close() }
  const gone = await rig()
  const m3 = await mirror({ '/latest': latest })
  try {
    const a = await gone.install({ ...real, WHOSUP_OVIS_RELEASES_URL: m3.url })
    assert.equal(a.code, 1, a.all); assert.ok(a.err.includes(`whosup: the Ovis app was not installed: ${asset} (v9.9.9) could not be downloaded from ${m3.url}.`), a.err); nothingLeft(gone)
  } finally { await m3.close() }
  // 체크섬은 맞다
  const ok = await rig()
  const m4 = await mirror({ '/latest': latest, [`/download/v9.9.9/${asset}`]: body, [`/download/v9.9.9/${feedName}`]: feedOf(sha512(body)) })
  try {
    const a = await ok.install({ ...real, WHOSUP_OVIS_RELEASES_URL: m4.url })
    if (mac) {
      // 맥: 풀리지 않는 파일(또는 Ovis 개발자가 서명·공증하지 않은 앱)은 놓지 않는다
      assert.equal(a.code, 1, a.all); assert.match(a.err, /whosup: the Ovis app was not installed: the downloaded Ovis-mac-arm64\.zip could not be unpacked\./); nothingLeft(ok)
    } else {
      // 리눅스: 체크섬이 맞으면 AppImage를 실행할 수 있게 놓고 실행기 항목을 둔다
      assert.equal(a.code, 0, a.all); assert.equal(ok.rec().env_app, join(place(ok), asset)); assert.equal(readFileSync(join(place(ok), asset), 'utf8'), String(body))
      assert.match(readFileSync(join(ok.home, '.local', 'share', 'applications', 'ovis.desktop'), 'utf8'), /^\[Desktop Entry\]\nName=Ovis\nExec="/)
    }
  } finally { await m4.close() }
  if (!mac) return
  // 맥: 서명되지 않은 앱이 든 zip(체크섬은 맞다) — 서명을 보고 놓지 않는다
  const u = await rig()
  const stage = join(u.base, 'zip'); mkdirSync(join(stage, 'Ovis.app', 'Contents', 'MacOS'), { recursive: true })
  writeFileSync(join(stage, 'Ovis.app', 'Contents', 'MacOS', 'Ovis'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
  writeFileSync(join(stage, 'Ovis.app', 'Contents', 'Info.plist'), '<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict><key>CFBundleExecutable</key><string>Ovis</string><key>CFBundleIdentifier</key><string>test.unsigned.ovis</string></dict></plist>\n')
  const zip = join(u.base, 'unsigned.zip')
  assert.equal(spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', join(stage, 'Ovis.app'), zip]).status, 0)
  const zipped = readFileSync(zip)
  const m5 = await mirror({ '/latest': latest, [`/download/v9.9.9/${asset}`]: zipped, [`/download/v9.9.9/${feedName}`]: feedOf(sha512(zipped)) })
  try {
    const a = await u.install({ ...real, WHOSUP_OVIS_RELEASES_URL: m5.url })
    assert.equal(a.code, 1, a.all); assert.match(a.err, /whosup: the Ovis app was not installed: the downloaded app is not signed and notarized by the Ovis developer, so it was not kept\./)
    nothingLeft(u); assert.equal(existsSync(join(u.home, 'Applications', 'Ovis.app')), false)
  } finally { await m5.close() }
})

// 임시 폴더 하나(설치기를 돌리지 않는 시험용)
function bareHome() {
  const dir = join(process.env.TMPDIR || '/tmp', `wsenv-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`)
  mkdirSync(dir, { recursive: true })
  return dir
}
