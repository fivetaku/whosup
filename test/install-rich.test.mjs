// rich 설치 화면(WHOSUP_UI=rich): 가짜 터미널(script 명령) 안에서 install.sh를 돌려 화살표 메뉴 · 접힌 줄 · 진행 줄 · 요약 순서를 보고,
// Ctrl-C로 그만둘 때 터미널 설정(stty)과 커서가 되돌아오는지 본다. plain 화면(지금까지의 출력)은 다른 설치기 시험들이 그대로 본다 —
// 그 시험들은 TERM 없이 돌기 때문에 값을 주지 않아도 plain이다(아래 마지막 시험이 그것도 본다).
// 격리 환경은 test-support/install-rig.mjs(임시 HOME · 좁은 PATH · 가짜 herdr). 앱 설치기는 대역이고, 창·브라우저는 열지 않는다(OPEN_BROWSER=0).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir as osTmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { INSTALL, SH, exe, lines, mac, rig as bareRig, shq } from '../test-support/install-rig.mjs'
import { strWidth } from '../src/tui.mjs'

if (process.platform !== 'win32' && !/^[A-Za-z0-9_@%+=:,./-]+$/.test(osTmpdir())) process.env.TMPDIR = '/tmp'
const hasScript = process.platform !== 'win32' && spawnSync('sh', ['-c', 'command -v script'], { encoding: 'utf8' }).status === 0
const tty = { skip: hasScript ? false : '가짜 터미널을 만들 script 명령이 없다' }

const fakeApp = (log, kind) => `#!/bin/sh
printf '%s\\n' ${kind} >> ${shq(log)}
mkdir -p "$HOME/.local/bin" || exit 1
if [ ${kind} = herdr-app ]; then
  if [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/Herdr.app/Contents/MacOS" || exit 1; fi
  printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/herdr-app"; printf '#!/bin/sh\\nexit 0\\n' > "$HOME/.local/bin/herdr-core"; chmod 755 "$HOME/.local/bin/herdr-app" "$HOME/.local/bin/herdr-core"
elif [ "$(uname -s)" = Darwin ]; then mkdir -p "$HOME/Applications/Ovis.app/Contents/MacOS" || exit 1
else d="\${XDG_DATA_HOME:-$HOME/.local/share}/ovis-desktop"; mkdir -p "$d" && printf '#!/bin/sh\\nexit 0\\n' > "$d/Ovis-linux-x64.AppImage" && chmod 755 "$d/Ovis-linux-x64.AppImage"
fi
`
async function rig() {
  const r = await bareRig(), env = r.env
  r.envLog = join(r.base, 'env-installers.log')
  r.sysApps = join(r.base, 'sysapps'); mkdirSync(r.sysApps)
  exe(join(r.bin, 'sysctl'), '#!/bin/sh\necho 1\n')
  r.env = (over = {}) => env({
    WHOSUP_HERDR_APP_INSTALL_CMD: `sh ${shq(exe(join(r.base, 'get-herdr-app.sh'), fakeApp(r.envLog, 'herdr-app')))}`,
    WHOSUP_OVIS_APP_INSTALL_CMD: `sh ${shq(exe(join(r.base, 'get-ovis-app.sh'), fakeApp(r.envLog, 'ovis-app')))}`,
    WHOSUP_SYSTEM_APPS: r.sysApps, WHOSUP_NO_AUTOSTART: '1', WHOSUP_NO_LOGIN_START: '1', DISPLAY: ':0',
    WHOSUP_UI: 'rich', TERM: 'xterm-256color', LANG: 'en_US.UTF-8', ...over,
  })
  r.envCalls = () => lines(r.envLog)
  return r
}

// 가짜 터미널(cols × 40)에서 install.sh를 돌린다. steps = [{ wait: 정규식, send: 글자 }] — 화면에 그 글이 (앞 단계 뒤로) 나오면 보낸다.
// 감싼 셸은 Ctrl-C에 죽지 않고(trap :) 설치기의 종료 코드와, 설치 전후의 stty -g가 같은지를 찍는다.
const DONE = /@@RICH-DONE (\d+) (same|changed)/
// rest: 단계를 다 쓴 뒤 번호 입력 줄(plain 질문 · 첫 실행 안내의 질문)이 더 나오면 Enter를 넣는다.
const PROMPT = /Type a number|번호를 입력하세요/g
function onTerminal(r, cols, steps, over = {}) {
  const env = Object.fromEntries(Object.entries(r.env(over)).filter(([, v]) => v !== undefined))
  // stty -a에서 pendin은 뺀다: BSD 계열은 터미널을 canonical로 되돌리는 순간 그 표시를 켰다가 다음 읽기에서 지운다(설정이 아니라 상태)
  const sttyNow = `stty -a | sed 's/-*pendin//'`
  const body = `stty cols ${cols} rows 40 2>/dev/null; trap : INT; before=$(${sttyNow}); ${shq(SH)} ${shq(INSTALL)}; rc=$?; after=$(${sttyNow}); `
    + `if [ "$before" = "$after" ]; then s=same; else s=changed; fi; echo "@@RICH-DONE $rc $s"`
  const inner = mac ? `script -q /dev/null /bin/sh -c ${shq(body)}` : `script -qec ${shq(`/bin/sh -c ${shq(body)}`)} /dev/null`
  return new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `cat | { ${inner}; }`], { env, cwd: r.base, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let raw = '', from = 0, ended = false
    const left = [...steps]
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} reject(new Error(`timed out on the terminal\n${raw}`)) }, 90000)
    child.stdin.on('error', () => {})
    // 글자 단위로 받는다: 조각 경계에서 한글 같은 여러 바이트 글자가 깨지지 않게
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    let seen = 0
    const feed = () => {
      if (ended) return
      if (!left.length) {
        const n = (raw.slice(from).match(PROMPT) || []).length
        for (; seen < n; seen++) setTimeout(() => { try { child.stdin.write('\n') } catch {} }, 250)
        return
      }
      const m = left[0].wait.exec(raw.slice(from))
      if (!m) return
      from += m.index + m[0].length
      const { send } = left.shift()
      setTimeout(() => { try { child.stdin.write(send) } catch {} feed() }, 250)
    }
    child.stdout.on('data', (c) => {
      raw += c
      if (!ended && DONE.test(raw)) { ended = true; setTimeout(() => { try { child.stdin.end() } catch {} }, 50); return }
      feed()
    })
    child.stderr.on('data', (c) => { raw += c })
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('close', () => {
      clearTimeout(timer)
      const m = DONE.exec(raw)
      resolve({ code: m ? Number(m[1]) : null, stty: m ? m[2] : null, raw, left: left.length })
    })
  })
}
// 터미널이 그린 최종 화면(대략): 커서를 위로 올려 지운 부분을 지운 뒤의 줄들. \x1b[<n>A\r\x1b[J 를 만나면 그만큼의 줄을 걷어 낸다.
function finalScreen(raw) {
  const rows = ['']
  const text = raw.replace(/\r\n/g, '\n').replace(/\^D\x08\x08/g, '')
  for (let i = 0; i < text.length; i++) {
    const rest = text.slice(i)
    let m = /^\x1b\[(\d+)A\r\x1b\[J/.exec(rest)
    if (m) { rows.splice(rows.length - 1 - Number(m[1]), Number(m[1]) + 1, ''); i += m[0].length - 1; continue }
    m = /^\r\x1b\[K/.exec(rest)
    if (m) { rows[rows.length - 1] = ''; i += m[0].length - 1; continue }
    m = /^\x1b\[[0-9;?]*[A-Za-z]/.exec(rest)
    if (m) { i += m[0].length - 1; continue }
    if (text[i] === '\n') rows.push('')
    else if (text[i] !== '\r') rows[rows.length - 1] += text[i]
  }
  return rows
}
const HINT = /Enter to pick[^\n]*\n|번호를 누르면 바로[^\n]*\n(?:[^\n]*\n)?/

test('rich 화면 · 한국어 · 60칸: 데스크톱 앱(Enter) → Ovis(번호 "2"+Enter 한 번에) — 메뉴는 "✓ …" 한 줄로 접히고, 진행 줄은 whosup: 없이 ✓, 경로는 쪼개지지 않는다', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 60, [{ wait: /120초 뒤 1번/, send: '\r' }, { wait: /어느 앱을 쓸까요\?[\s\S]*120초 뒤 1번/, send: '2\r' }], { WHOSUP_LANG: 'ko', NO_COLOR: '1', LANG: 'ko_KR.UTF-8' })
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same', '터미널 설정이 그대로 돌아왔다'); assert.equal(a.left, 0)
    assert.deepEqual(r.envCalls(), ['ovis-app'], '둘째 질문의 "2" 뒤 Enter는 다음 질문에 넘어가지 않았다(질문이 둘뿐)')
    assert.ok(a.raw.includes('\x1b[?25l') && a.raw.lastIndexOf('\x1b[?25h') > a.raw.lastIndexOf('\x1b[?25l'), '숨긴 커서를 다시 보인다')
    const screen = finalScreen(a.raw)
    const at = (re) => screen.findIndex((l) => re.test(l))
    assert.ok(at(/^ {2}whosup 설치 {2}· {2}에이전트 세션 보드$/) >= 0, screen.join('\n'))
    const c1 = at(/^ {2}✓ 세션을 쓸 곳: 데스크톱 앱$/), c2 = at(/^ {2}✓ 앱: Ovis$/)
    assert.ok(c1 > 0 && c2 === c1 + 1, `접힌 두 줄이 이어진다\n${screen.join('\n')}`)
    assert.equal(at(/세션을 어디에서 쓸까요/), -1, '접힌 메뉴는 화면에 남지 않는다')
    assert.ok(at(/^ {2}✓ Ovis 앱 설치 \(약 175MB\)$/) > c2); assert.ok(at(/^ {2}✓ whosup 설치$/) > c2)
    // 설치기가 찍은 줄(단독 설치의 마지막 단계 앞까지)에는 whosup: 접두어가 없고 60칸을 넘지 않는다
    const mine = screen.slice(0, at(/^ {2}✓ whosup 설치$/) + 1)
    assert.ok(mine.every((l) => !l.startsWith('whosup: ')), mine.join('\n'))
    assert.ok(mine.every((l) => strWidth(l, { amb: 2 }) <= 60), mine.join('\n'))
    const intro = at(/^ {2}세션을 띄울 환경이 아직 없습니다\./)
    assert.ok(intro > 0 && intro < c1, screen.join('\n'))
    assert.equal(`${screen[intro]} ${screen[intro + 1].trim()}`, '  세션을 띄울 환경이 아직 없습니다. 고른 것을 먼저 설치한 뒤 whosup을 설치합니다.', '60칸에서 두 줄로, 같은 들여쓰기')
    // 메뉴가 그려진 모습: 둘째 선택지의 설치 위치는 ~로 줄였고 한 줄에 통째로
    assert.match(a.raw, /herdr를 ~\/\.local\/bin 에/)
  } finally { r.cleanup() }
})

test('rich 화면 · 영어 · 80칸: 아래 화살표 + Enter = 터미널 → herdr를 깔고 플러그인. 요약은 "다음에 할 일"부터, 칠 명령은 한 번, 줄은 80칸 안', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 80, [{ wait: /Enter to pick/, send: '\x1b[B' }, { wait: /> 2 {2}Terminal[\s\S]*Enter to pick/, send: '\r' }], { WHOSUP_HERDR_INSTALL_CMD: r.getHerdr })
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), [])
    const screen = finalScreen(a.raw).map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''))
    const at = (re) => screen.findIndex((l) => re.test(l))
    assert.ok(at(/^ {2}✓ Sessions run in: Terminal$/) > 0, screen.join('\n'))
    assert.ok(at(/^ {2}✓ herdr 0\.9\.\d+ installed$/) > 0, '… 줄은 같은 자리에서 ✓ 줄로 바뀐다'); assert.equal(at(/downloading herdr/), -1)
    // 플러그인 설치 중 첫 실행 안내가 아무것도 찍지 않았다: "… installing whosup as a herdr plugin"도 같은 자리에서 ✓ 줄로 바뀐다
    assert.ok(at(/^ {2}✓ whosup installed as a herdr plugin$/) > 0, screen.join('\n')); assert.equal(at(/installing whosup as a herdr plugin/), -1, screen.join('\n'))
    const done = at(/^ {2}✓ whosup is installed$/), next = at(/^ {2}Next$/), inst = at(/^ {2}Installed$/), foot = at(/Change settings in the board's settings\./)
    assert.ok(done > 0 && next > done && inst > next && foot > inst, screen.join('\n'))
    const herdr = join(r.home, '.local', 'bin', 'herdr')
    assert.deepEqual(screen.filter((l) => /^ {6}~\/\.local\/bin\/herdr$/.test(l)).length, 1, '칠 명령은 한 번(~ 경로 — 그대로 쳐도 된다)')
    assert.ok(!screen.some((l) => l.includes(herdr)), '집 폴더의 경로는 ~로 보인다')
    assert.ok(screen.some((l) => /echo 'export PATH="\$HOME\/\.local\/bin:\$PATH"' >> /.test(l)), 'PATH 안내도 그대로 칠 수 있는 줄')
    for (const l of screen) if (!/^ {2,6}(echo|~)/.test(l)) assert.ok(strWidth(l, { amb: 2 }) <= 80, JSON.stringify(l))
    assert.ok(!screen.some((l) => l.startsWith('whosup: ')), screen.join('\n'))
    assert.ok(!a.raw.includes('whosup install summary'), 'plain 요약은 찍지 않는다')
  } finally { r.cleanup() }
})

test('rich 화면: 첫 질문에서 Ctrl-C — 130으로 끝나고, 아무것도 깔지 않으며, 터미널 설정(stty)과 커서가 되돌아온다', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 70, [{ wait: /Enter to pick/, send: '\x03' }])
    assert.equal(a.code, 130, a.raw); assert.equal(a.stty, 'same', '바꿨던 -icanon -echo가 남지 않았다')
    assert.ok(a.raw.lastIndexOf('\x1b[?25h') > a.raw.indexOf('\x1b[?25l'), '커서를 다시 보인다')
    assert.match(a.raw, /Stopped\. Nothing was installed\./)
    assert.deepEqual(r.envCalls(), []); assert.deepEqual(r.herdrCalls(), [])
  } finally { r.cleanup() }
})

test('rich 화면: 둘째 질문에서 답이 없으면 시간 제한 뒤 기본값(Herdr 앱)으로 접고, 자동으로 골랐다고 쓴다', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 70, [{ wait: /Enter to pick/, send: '1' }], { WHOSUP_SETUP_TIMEOUT_S: '1' })
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), ['herdr-app'])
    const screen = finalScreen(a.raw)
    assert.ok(screen.some((l) => /^ {2}✓ Sessions run in: Desktop app$/.test(l)), '번호 1은 바로 정한다')
    assert.ok(screen.some((l) => /^ {2}✓ App: Herdr \(no answer, picked by itself\)$/.test(l)), screen.join('\n'))
  } finally { r.cleanup() }
})

test('값이 없으면 터미널이어도 TERM이 없거나 dumb·CI면 plain, WHOSUP_UI=plain이면 TERM이 있어도 plain — 지금 출력 그대로(번호 입력, whosup: 접두어, 이스케이프 없음)', tty, async () => {
  for (const over of [{ WHOSUP_UI: 'plain' }, { WHOSUP_UI: undefined, TERM: 'dumb' }, { WHOSUP_UI: undefined, TERM: undefined }]) {
    const r = await rig()
    try {
      const a = await onTerminal(r, 80, [{ wait: /Type a number/, send: '\n' }, { wait: /Type a number/, send: '\n' }], over)
      assert.equal(a.code, 0, a.raw); assert.deepEqual(r.envCalls(), ['herdr-app'])
      assert.match(a.raw, /whosup: nothing to run agent sessions in is here yet/); assert.doesNotMatch(a.raw, /\x1b\[\?25l|✓ Sessions run in/, JSON.stringify(over))
    } finally { r.cleanup() }
  }
})

// 단독 설치 길의 끝(scripts/standalone.mjs install · src/setup.mjs): 첫 실행 안내와 설치 요약도 rich로 이어진다.
// 진행 줄 → "✓ 감지한 것" → (물을 것이 있으면 화살표 메뉴가 접힌 줄) → "✓ whosup 설치를 마쳤습니다" → 다음에 할 일 → 설치한 것 → 명령 → 설정 각주.
// 칠 명령 줄(쪼개지 않는다 — 7칸에 안 들어가면 2칸으로 내려 쓰고, 그래도 길면 터미널이 꺾는다): 임시 홈의 긴 경로가 든 명령은 폭을 넘을 수 있다
const isCmdLine = (l) => /^ {2}( {4,5})?(\/|~\/|whosup |http|ssh |echo )\S*( \S+)*$/.test(l) && !/\s{2}/.test(l.trim())
test('rich 화면 · 한국어 · 60칸 · Ovis 길의 끝: 첫 실행 안내는 "✓ 감지한 것" 한 줄(고를 것이 없다는 말 없음), 요약은 다음에 할 일부터 — whosup: 없이 60칸 안', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 60, [{ wait: /120초 뒤 1번/, send: '\r' }, { wait: /어느 앱을 쓸까요\?[\s\S]*120초 뒤 1번/, send: '2' }], { WHOSUP_LANG: 'ko', NO_COLOR: '1', LANG: 'ko_KR.UTF-8' })
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same')
    const screen = finalScreen(a.raw)
    const at = (re) => screen.findIndex((l) => re.test(l))
    const placed = at(/^ {2}✓ whosup 설치$/), seen = at(/^ {2}✓ (감지한 것: |이 컴퓨터를 확인했습니다$)/)   // 감지한 것이 없는 기계(Linux 컨테이너)는 "확인했습니다" 한 줄
    assert.ok(placed > 0 && seen === placed + 1, `설치 줄 바로 아래 감지한 것\n${screen.join('\n')}`)
    assert.equal(at(/이 컴퓨터를 확인하는 중/), -1, '진행 줄은 같은 자리에서 ✓ 줄로 바뀌었다')
    assert.doesNotMatch(a.raw, /고를 것이 없어|whosup 첫 실행 안내|whosup 설치 요약/)
    const done = at(/^ {2}✓ whosup 설치를 마쳤습니다$/), next = at(/^ {2}다음에 할 일$/), inst = at(/^ {2}설치한 것$/), cmds = at(/^ {2}명령$/), foot = at(/^ {2}설정은 보드의 설정 화면에서 바꿉니다\.$/)
    assert.ok(done > seen && next > done && inst > next && cmds > inst && foot > cmds, screen.join('\n'))
    assert.match(screen.slice(next, inst).join('\n'), /Ovis 앱을 한 번 여세요[\s\S]*보드가 꺼져 있습니다\. 터미널에 아래를 쳐서 켜세요\.\n {2}( {5})?\S*whosup start/, '창을 열지 않는 설치(OPEN_BROWSER=0): 앱을 한 번 열라고 하고, 꺼 둔 보드를 켜는 명령')
    assert.ok(screen.every((l) => !l.startsWith('whosup: ')), screen.join('\n'))
    for (const l of screen.slice(0, foot + 1)) if (!isCmdLine(l)) assert.ok(strWidth(l, { amb: 2 }) <= 60, JSON.stringify(l))
    assert.ok(!screen.slice(inst, cmds).join('\n').includes(r.home), '설치한 것의 경로는 ~로 줄였다')
  } finally { r.cleanup() }
})

test('rich 화면 · 영어 · 80칸 · Herdr 앱 길: 첫 실행 안내의 질문도 화살표 메뉴 — 번호 "2"로 고르면 "✓ <짧은 제목>: 터미널 창"으로 접히고 setup.json에 쓴다', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 80, [{ wait: /Enter to pick/, send: '\r' }, { wait: /Which app\?[\s\S]*Enter to pick/, send: '\r' }, { wait: /Where should a click on a Herdr app session open it\?[\s\S]*Enter to pick/, send: '2' }])
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), ['herdr-app'])
    const screen = finalScreen(a.raw)
    const at = (re) => screen.findIndex((l) => re.test(l))
    const seen = at(/^ {2}✓ Detected: .*Herdr app/), picked = at(/^ {2}✓ Herdr app sessions open in: terminal window$/)
    assert.ok(seen > 0 && picked === seen + 1, `감지한 것 바로 아래 접힌 줄\n${screen.join('\n')}`)
    assert.equal(at(/Where should a click/), -1, '접힌 메뉴는 화면에 남지 않는다'); assert.doesNotMatch(a.raw, /Type a number|Saved:/)
    assert.deepEqual(JSON.parse(readFileSync(join(r.home, '.config', 'whosup', 'setup.json'), 'utf8')).choices, { core_target: 'terminal' })
    const done = at(/^ {2}✓ whosup is installed$/), next = at(/^ {2}Next$/), inst = at(/^ {2}Installed$/)
    assert.ok(done > picked && next > done && inst > next, screen.join('\n'))
    assert.ok(screen.some((l) => /^ {4}Herdr app +~\//.test(l)), `함께 깐 앱도 설치한 것에\n${screen.join('\n')}`)
    for (const l of screen) if (!isCmdLine(l)) assert.ok(strWidth(l, { amb: 2 }) <= 80, JSON.stringify(l))
  } finally { r.cleanup() }
})

// 메뉴를 띄우지 못하는 터미널: PATH 앞의 stty 대역이 n번째 "-icanon"부터 실패한다(그 앞은 진짜 stty에 넘긴다)
const REAL_STTY = hasScript ? spawnSync('sh', ['-c', 'command -v stty'], { encoding: 'utf8' }).stdout.trim() : ''
const sttyFailsFrom = (r, n) => {
  const cnt = join(r.base, 'stty-icanon-count')
  exe(join(r.bin, 'stty'), `#!/bin/sh\ncase " $* " in *" -icanon "*) c=$(cat ${shq(cnt)} 2>/dev/null || echo 0); c=$((c + 1)); echo "$c" > ${shq(cnt)}; [ "$c" -lt ${n} ] || exit 1 ;; esac\nexec ${shq(REAL_STTY)} "$@"\n`)
}
test('rich 화면: 첫 메뉴가 터미널을 바꾸지 못하면 번호로 묻는다 — rich 머리 문단 뒤에 plain 머리("whosup: nothing to run …")를 한 번 더 찍지 않는다', tty, async () => {
  const r = await rig()
  try {
    sttyFailsFrom(r, 2)
    const a = await onTerminal(r, 80, [{ wait: /Type a number/, send: '\n' }, { wait: /Which app[\s\S]*Type a number/, send: '2\n' }])
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), ['ovis-app'])
    assert.equal(a.raw.split('Nothing to run agent sessions in is here yet').length, 2, a.raw)
    assert.doesNotMatch(a.raw, /whosup: nothing to run agent sessions/)
    assert.match(a.raw, /Enter takes the choice marked \*/); assert.match(a.raw, /1\) Desktop app \*/)
  } finally { r.cleanup() }
})
test('rich 화면: 둘째 메뉴(Herdr / Ovis)가 터미널을 바꾸지 못하면 그 질문만 번호로 묻는다 — 묻지 않고 Herdr 앱으로 정하지 않는다', tty, async () => {
  const r = await rig()
  try {
    sttyFailsFrom(r, 3)
    const a = await onTerminal(r, 80, [{ wait: /Enter to pick/, send: '\r' }, { wait: /Which app[\s\S]*Type a number/, send: '2\n' }])
    assert.equal(a.code, 0, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), ['ovis-app'], '번호 질문의 답(2 = Ovis)')
    const screen = finalScreen(a.raw)
    assert.ok(screen.some((l) => /^ {2}✓ Sessions run in: Desktop app$/.test(l)), screen.join('\n'))
    assert.match(a.raw, / {4}2\) Ovis/)
  } finally { r.cleanup() }
})
test('rich 화면 · 한국어 · 80칸 · Herdr 앱 길: 첫 실행 안내의 메뉴에서 Ctrl-C — 130, 영어 진단 줄 없이 "✗ 그만둡니다" 다음에 남아 있는 Herdr 앱을 알린다', tty, async () => {
  const r = await rig()
  try {
    const a = await onTerminal(r, 80, [{ wait: /120초 뒤 1번/, send: '\r' }, { wait: /어느 앱을 쓸까요\?[\s\S]*120초 뒤 1번/, send: '\r' }, { wait: /열까요\?[\s\S]*120초 뒤 1번/, send: '\x03' }],
      { WHOSUP_LANG: 'ko', NO_COLOR: '1', LANG: 'ko_KR.UTF-8' })
    assert.equal(a.code, 130, a.raw); assert.equal(a.stty, 'same'); assert.deepEqual(r.envCalls(), ['herdr-app'])
    assert.doesNotMatch(a.raw, /whosup setup: stopped by Ctrl-C/, '진단 줄은 기록 파일에만')
    const screen = finalScreen(a.raw)
    const x = screen.findIndex((l) => /^ {2}✗ 그만둡니다/.test(l))
    assert.ok(x > 0, screen.join('\n'))
    assert.match(screen.slice(x).join('\n'), /이번 실행이 설치한 Herdr 앱은 그대로 남아 있습니다\(~\//, screen.join('\n'))
    assert.ok(!screen.slice(x).join('\n').includes(r.home), '경로는 ~로')
  } finally { r.cleanup() }
})
test('runMenu: 메뉴가 떠 있는 동안 process.exit로 끝나도(감시 타이머 등) 터미널 설정과 커서가 돌아온다', tty, async () => {
  const tui = join(fileURLToPath(new URL('..', import.meta.url)), 'src', 'tui.mjs')
  const js = `const m = await import(${JSON.stringify(tui)}); m.runMenu({ title: "t", options: [{ label: "a" }, { label: "b" }], lang: "en" }); setTimeout(() => process.exit(0), 600)`
  const sttyNow = `stty -a | sed 's/-*pendin//'`
  const body = `stty cols 60 rows 40 2>/dev/null; before=$(${sttyNow}); node --input-type=module -e ${shq(js)}; after=$(${sttyNow}); if [ "$before" = "$after" ]; then s=same; else s=changed; fi; echo "@@EXIT $s"`
  const inner = mac ? `script -q /dev/null /bin/sh -c ${shq(body)}` : `script -qec ${shq(`/bin/sh -c ${shq(body)}`)} /dev/null`
  const raw = await new Promise((resolve, reject) => {
    const child = spawn('/bin/sh', ['-c', `cat | { ${inner}; }`], { env: { ...process.env, TERM: 'xterm-256color' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8')
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} reject(new Error(`timed out\n${out}`)) }, 20000)
    child.stdout.on('data', (c) => { out += c; if (/@@EXIT \w+/.test(out)) { try { child.stdin.end() } catch {} } })
    child.stderr.on('data', (c) => { out += c })
    child.on('close', () => { clearTimeout(timer); resolve(out) })
  })
  assert.match(raw, /@@EXIT same/, raw)
  assert.ok(raw.includes('\x1b[?25l') && raw.lastIndexOf('\x1b[?25h') > raw.lastIndexOf('\x1b[?25l'), JSON.stringify(raw))
})
