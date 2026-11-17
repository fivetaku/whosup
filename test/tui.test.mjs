// 설치 화면 도우미(src/tui.mjs): 모드 판정, 폭 세기, 내어쓰기 줄바꿈, 블록 그리기, 메뉴의 키 처리 — 터미널 없이 함수로 본다.
// install.sh에 든 사본(UI_JS)이 src/tui.mjs와 같은지도 여기서 본다(scripts/gen-install-ui.mjs).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  UI_TEXT, blockHeight, collapseLine, menuFeed, menuFits, menuLines, renderBlocks, strWidth, stripAnsi, tildePath, uiCols, uiJsBlock, uiMode, uiStyle, uiSymbols, wrap,
} from '../src/tui.mjs'
import { installUiSection, withUiSection } from '../scripts/gen-install-ui.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const TUI = readFileSync(`${ROOT}src/tui.mjs`, 'utf8')
const INSTALL = readFileSync(`${ROOT}install.sh`, 'utf8')

test('install.sh의 UI_JS는 src/tui.mjs의 UI_JS 묶음을 그대로 옮긴 것이다(작은따옴표 없음 — 셸 문자열이 끊긴다)', () => {
  assert.equal(withUiSection(INSTALL, TUI), INSTALL, 'install.sh가 낡았다: node scripts/gen-install-ui.mjs')
  assert.ok(INSTALL.includes(installUiSection(TUI)))
  assert.doesNotMatch(uiJsBlock(TUI), /'/)
  assert.doesNotMatch(uiJsBlock(TUI), /^\s*(import|export)\s/m, '사본은 모듈이 아닌 스크립트로 돈다')
  // 사본만으로 돈다(node -e, 모듈 아님)
  const js = INSTALL.slice(INSTALL.indexOf("UI_JS='\n") + 8, INSTALL.indexOf("\n'\n# <<< UI_JS"))
  const { spawnSync } = process.getBuiltinModule('child_process')
  const r = spawnSync(process.execPath, ['-e', js, 'print'], { input: 'ok\tNode v1\t\n', encoding: 'utf8', env: { WHOSUP_UI_COLS: '60', NO_COLOR: '1', LANG: 'en_US.UTF-8' } })
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '  ✓ Node v1\n')
})

test('모드: WHOSUP_UI가 먼저, 없으면 터미널·TERM·CI·WHOSUP_NO_SETUP으로. NO_COLOR는 색만 끄고 UTF-8이 아닌 로캘은 ASCII 기호', () => {
  const tty = { stdoutTTY: true, ttyOK: true }
  const on = { TERM: 'xterm-256color', LANG: 'ko_KR.UTF-8' }
  assert.equal(uiMode({ env: on, ...tty }).mode, 'rich')
  assert.equal(uiMode({ env: { ...on, WHOSUP_UI: 'plain' }, ...tty }).mode, 'plain')
  assert.equal(uiMode({ env: { WHOSUP_UI: 'RICH' } }).mode, 'rich', '시험용으로 강제한다')
  for (const env of [{ ...on, TERM: '' }, { ...on, TERM: 'dumb' }, { ...on, CI: '1' }, { ...on, WHOSUP_NO_SETUP: 'yes' }]) assert.equal(uiMode({ env, ...tty }).mode, 'plain', JSON.stringify(env))
  assert.equal(uiMode({ env: { ...on, CI: 'false' }, ...tty }).mode, 'rich', 'CI=false는 꺼짐')
  assert.equal(uiMode({ env: on, stdoutTTY: false, ttyOK: true }).mode, 'plain'); assert.equal(uiMode({ env: on, stdoutTTY: true, ttyOK: false }).mode, 'plain')
  assert.deepEqual(uiMode({ env: { ...on, NO_COLOR: '1' }, ...tty }), { mode: 'rich', color: false, utf8: true })
  assert.equal(uiMode({ env: { ...on, LANG: 'C' }, ...tty }).utf8, false); assert.equal(uiMode({ env: { ...on, LC_ALL: 'en_US.utf8' }, ...tty }).utf8, true)
  assert.deepEqual(uiSymbols(false), { ok: 'ok', run: '..', fail: 'x', warn: '!', dot: '-', sel: '>' })
  assert.equal(uiStyle(false).bold('x'), 'x'); assert.equal(uiStyle(true).green('✓'), '\x1b[32m✓\x1b[0m')
})

test('폭: /dev/tty 열 수 > WHOSUP_UI_COLS > COLUMNS > stty > 80, 40~100으로 자른다. 0이나 숫자가 아니면 건너뛴다', () => {
  assert.deepEqual(uiCols({ ttyCols: 72, env: { COLUMNS: '120' } }), { cols: 72, known: true })
  assert.deepEqual(uiCols({ ttyCols: 0, env: { WHOSUP_UI_COLS: '61', COLUMNS: '90' } }), { cols: 61, known: false })
  assert.equal(uiCols({ env: { COLUMNS: 'abc' }, sttyCols: 70 }).cols, 70)
  assert.equal(uiCols({}).cols, 80); assert.equal(uiCols({ ttyCols: 20 }).cols, 40); assert.equal(uiCols({ ttyCols: 300 }).cols, 100)
})

test('글자 폭: 한글은 2칸, 결합 문자·제어 문자는 0칸, 이스케이프는 0칸, 모호폭(· … —)은 셈법에 따라 1 또는 2칸', () => {
  assert.equal(strWidth('세션 abc'), 8); assert.equal(strWidth('e\u0301'), 1); assert.equal(strWidth('\x1b[1;32m✓\x1b[0m ok'), 4)
  assert.equal(strWidth('a·b…c—'), 6); assert.equal(strWidth('a·b…c—', { amb: 2 }), 9)
  assert.equal(stripAnsi('\x1b[2mdim\x1b[0m'), 'dim')
  assert.equal(blockHeight(['x'.repeat(10), '', '한'.repeat(10)], 10), 1 + 1 + 2)
})

test('줄바꿈: 폭(60·80) 안에서 내어쓰기를 지키고, 경로·URL·따옴표로 싼 경로는 쪼개지 않는다(긴 덩어리는 다음 줄에 통째로)', () => {
  const path = '/Users/someone/.local/bin', url = 'https://github.com/devswha/ovis/releases'
  const text = `지금 쓰는 터미널 안에서 세션을 관리하는 작은 프로그램 herdr를 ${path} 에 설치합니다. 직접 받으려면 ${url} 를 여세요. '/tmp/a b/c' 그대로.`
  for (const width of [40, 59, 60, 79, 80]) {
    const ls = wrap(text, width, { first: '       ' })
    assert.ok(ls.length > 1)
    ls.forEach((l, i) => {
      assert.ok(l.startsWith('       ') && !l.startsWith('        '), `${width}: 7칸 내어쓰기 ${JSON.stringify(l)}`)
      if (!l.includes(url) || strWidth(`       ${url}`) <= width) assert.ok(strWidth(l, { amb: 2 }) <= width, `${width}: ${i} ${JSON.stringify(l)}`)
    })
    const joined = ls.map((l) => l.trim()).join(' ')
    assert.equal(joined, text, '단어는 그대로, 순서도 그대로'); for (const piece of [path, url, "'/tmp/a b/c'"]) assert.ok(ls.some((l) => l.includes(piece)), `${width}: ${piece}`)
  }
  assert.deepEqual(wrap('aaa bbb', 5, { first: '  ', hang: 4 }), ['  aaa', '    bbb'])
  assert.deepEqual(wrap(`x ${'y'.repeat(30)} z`, 10, { first: '  ' }), ['  x', `  ${'y'.repeat(30)}`, '  z'], '폭보다 긴 덩어리는 홀로 한 줄')
  assert.deepEqual(wrap('', 10, { first: '  ' }), ['  '])
})

test('경로 보여 주기: 집 폴더 안이면 ~로 줄이고, 밖이거나 이름만 같은 폴더는 그대로', () => {
  assert.equal(tildePath('/Users/a/.local/bin', '/Users/a'), '~/.local/bin'); assert.equal(tildePath('/Users/a', '/Users/a/'), '~')
  assert.equal(tildePath('/Users/ab/x', '/Users/a'), '/Users/ab/x'); assert.equal(tildePath('/opt/x', '/Users/a'), '/opt/x'); assert.equal(tildePath('/x', ''), '/x')
})

test('블록: 색이 꺼지면 이스케이프가 하나도 없고, 켜지면 스타일마다 닫힌다. 진행 줄·실패의 마지막 문장·명령·키-값 열', () => {
  const blocks = [['blank'], ['head', 'whosup 설치', '에이전트 세션 보드'], ['ok', 'Node v26.13.0'], ['run', 'Ovis 앱 내려받는 중 (약 175MB)'], ['warn', 'Herdr 앱은 여기서 고를 수 없습니다: 이 프로세서용 Herdr 앱이 없습니다.'],
    ['fail', 'Ovis 앱을 설치하지 못했습니다: 받은 파일이 그 릴리스의 체크섬과 달라 남기지 않았습니다. 직접 받아 설치한 뒤(https://ovis.sh) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다.'],
    ['done', 'whosup 설치를 마쳤습니다'], ['title', '다음에 할 일'], ['num', '1', 'Ovis 앱이 열렸습니다. 앱의 첫 화면을 마치세요.'], ['item', '터미널에 아래를 치고 Enter를 누르세요. herdr가 켜지면 보드도 같이 뜹니다.'],
    ['cmd', '/Users/someone/.local/bin/herdr'], ['kv', 'whosup', '~/.local/share/whosup/app (herdr 없이 단독)'], ['kv', 'Ovis 앱', '~/Applications/Ovis.app'], ['kv', '보드', 'herdr를 켤 때마다 같이 뜹니다 · http://127.0.0.1:4790 (사용 중이면 다음 포트)'],
    ['para', '설치 위치: /Users/someone/.local/bin'], ['foot', '설정은 보드의 설정 화면에서 바꿉니다.']]
  for (const width of [59, 79]) {
    const plain = renderBlocks(blocks, { width, color: false })
    assert.ok(plain.every((l) => !l.includes('\x1b')), plain.join('\n'))
    for (const l of plain) if (!l.includes('/Users/someone/.local/bin/herdr')) assert.ok(strWidth(l, { amb: 2 }) <= width, `${width}: ${JSON.stringify(l)}`)
    assert.ok(plain.includes('  ✓ Node v26.13.0')); assert.ok(plain.includes('  … Ovis 앱 내려받는 중 (약 175MB)'))
    assert.ok(plain.includes('  whosup은 설치하지 않았습니다.'), '실패 블록의 마지막 문장은 따로'); assert.ok(plain.some((l) => l.startsWith('  ✗ Ovis 앱을 설치하지 못했습니다')))
    assert.ok(plain.includes('      /Users/someone/.local/bin/herdr'), '명령은 쪼개지 않는다')
    const kv = plain.filter((l) => /^ {4}(whosup|Ovis 앱|보드) /.test(l))
    assert.deepEqual(kv.map((l) => strWidth(/^ {4}.*?\S {3,}/.exec(l)[0])), [14, 14, 14], '값 열이 같은 자리(가장 긴 이름 + 3칸)')
    const board = plain.indexOf(kv[2]); assert.ok(/^ {13}\S/.test(plain[board + 1]) || strWidth(kv[2]) <= width, '이어지는 줄은 값 열에 맞춘다')
    assert.ok(plain.includes('    1. Ovis 앱이 열렸습니다. 앱의 첫 화면을 마치세요.'))
    assert.ok(plain.includes('  설치 위치: /Users/someone/.local/bin'))
  }
  const colored = renderBlocks(blocks, { width: 79, color: true })
  for (const l of colored) if (l.includes('\x1b[')) assert.ok(l.endsWith('\x1b[0m') || /\x1b\[0m [^\x1b]*$/.test(l), JSON.stringify(l))
  assert.ok(colored.some((l) => l.includes('\x1b[32m✓\x1b[0m')), '✓만 초록'); assert.ok(colored.some((l) => l.includes('\x1b[1;31m✗\x1b[0m')), '✗는 빨강')
  assert.ok(colored.every((l) => !/\x1b\[(33|37|90|97|30)m/.test(l)), '노랑·흰색·회색·검정은 쓰지 않는다')
  assert.deepEqual(renderBlocks([['ok', 'done']], { width: 60, color: false, utf8: false }), ['  ok done'], 'UTF-8이 아닌 로캘은 ASCII 기호')
})

const OPTS = [{ label: '데스크톱 앱', desc: ['창이 따로 뜨는 앱(Herdr 또는 Ovis — 다음 질문에서 고릅니다)을 설치합니다. 터미널을 몰라도 됩니다.'] },
  { label: '터미널', desc: ['지금 쓰는 터미널 안에서 세션을 관리하는 작은 프로그램 herdr를 /Users/someone/.local/bin 에 설치합니다.'] }]
test('메뉴 그림: 제목, ">"와 굵게로 표시한 선택 줄(색에만 기대지 않는다), 7칸 설명, 폭 안의 안내 줄. 안내 줄은 폭이 확실한 글자만 쓴다', () => {
  for (const width of [59, 79]) {
    const ls = menuLines({ title: '세션을 어디에서 쓸까요?', options: OPTS, sel: 2, preset: 1, secs: 120, lang: 'ko', width, color: false })
    assert.equal(ls[0], '  세션을 어디에서 쓸까요?'); assert.equal(ls[2], '    1  데스크톱 앱  (기본)'); assert.ok(ls.includes('  > 2  터미널'))
    assert.ok(ls.every((l) => strWidth(l, { amb: 2 }) <= width), ls.join('\n'))
    assert.ok(ls.filter((l) => l.includes('/Users/someone/.local/bin')).length === 1, '경로는 한 줄에 통째로')
    assert.ok(ls.slice(3).filter((l) => l && !/^ {2}[> ] \d|^ {2}위\/|^ {2}\S/.test(l)).every((l) => /^ {7}\S/.test(l)), '설명은 7칸')
    assert.deepEqual(menuFits(ls, { cols: width + 1, rows: 40 }), { sure: true, h: ls.length }, '모호폭을 2칸으로 세도 줄 수가 같다')
  }
  for (const lang of ['en', 'ko']) { const h = UI_TEXT[lang].hint(1, 120); assert.equal(strWidth(h), strWidth(h, { amb: 2 }), h); assert.match(h, /120/) }
  const colored = menuLines({ title: 'Where?', options: OPTS, sel: 1, lang: 'en', color: true })
  assert.ok(colored.some((l) => l.includes('\x1b[1m> 1  데스크톱 앱\x1b[0m'))); assert.ok(colored.at(-1).includes('\x1b[2m'), '안내 줄만 흐리게')
  assert.ok(colored.filter((l) => l.includes('창이 따로')).every((l) => !l.includes('\x1b')), '설명은 기본색')
  assert.equal(menuLines({ title: 'x', options: OPTS, lead: true, color: false })[0], '', '둘째 질문은 빈 줄부터(접힌 줄 바로 아래)')
  assert.deepEqual(menuFits(['x'], { cols: 0, rows: 0 }), { sure: false, h: 0 }, '크기를 모르면 지우지 않는다')
  assert.equal(menuFits(['ab·'.repeat(10)], { cols: 30, rows: 40 }).sure, false, '모호폭 때문에 줄 수가 갈릴 수 있으면 지우지 않는다')
  assert.equal(menuFits(new Array(40).fill('x'), { cols: 80, rows: 40 }).sure, false, '화면보다 길면 지우지 않는다')
})

test('메뉴 키: 위/아래(ESC [ A·B, ESC O A·B)와 k/j는 옮기고 Enter는 고른다. 번호는 바로 고르고 뒤따르는 CR은 보지 않는다. 쪼개져 온 화살표도 받는다', () => {
  const s0 = { sel: 1, n: 2, esc: '', skipNl: 0 }
  assert.deepEqual(menuFeed(s0, '\x1b[B\r').done, { n: 2, how: 'key' })
  assert.deepEqual(menuFeed(s0, '\x1bOB\x1bOA\n').done, { n: 1, how: 'key' })
  assert.deepEqual(menuFeed(s0, 'jj\r').done, { n: 1, how: 'key' }, '둘에서 한 번 더 내려가면 처음으로')
  assert.deepEqual(menuFeed(s0, 'k\r').done, { n: 2, how: 'key' })
  assert.deepEqual(menuFeed(s0, '2\r').done, { n: 2, how: 'digit' }, 'rig가 보내는 "2\\r"도 같은 뜻')
  assert.equal(menuFeed(s0, '9').done, null, '없는 번호는 무시'); assert.equal(menuFeed(s0, '0x').done, null)
  const half = menuFeed(s0, '\x1b['); assert.equal(half.done, null); assert.equal(half.st.esc, '\x1b[')
  assert.deepEqual(menuFeed(half.st, 'B\r').done, { n: 2, how: 'key' })
  assert.equal(menuFeed(s0, '\x1b[1;5C').done, null, '다른 이스케이프 시퀀스는 건너뛴다')
  assert.deepEqual(menuFeed(s0, '\x03').done, { n: 1, how: 'interrupt' })
  // 앞 질문을 번호로 골랐을 때: 1초 안에 맨 먼저 오는 Enter 하나는 버린다(그 번호 뒤에 친 Enter)
  const after = { ...s0, skipNl: 1000 }
  assert.equal(menuFeed(after, '\r', 500).done, null); assert.deepEqual(menuFeed(after, '\r\r', 500).done, { n: 1, how: 'key' })
  assert.deepEqual(menuFeed(after, '\r', 1500).done, { n: 1, how: 'key' }, '1초가 지나면 Enter는 Enter'); assert.deepEqual(menuFeed(after, 'j\r', 500).done, { n: 2, how: 'key' })
})

test('접은 줄: "✓ 세션을 쓸 곳: 데스크톱 앱", 시간 초과면 자동으로 골랐다는 말을 붙인다', () => {
  assert.equal(collapseLine({ prefix: '세션을 쓸 곳', label: '데스크톱 앱', lang: 'ko', color: false }), '  ✓ 세션을 쓸 곳: 데스크톱 앱')
  assert.equal(collapseLine({ prefix: 'App', label: 'Ovis', auto: true, lang: 'en', color: false, utf8: false }), '  ok App: Ovis (no answer, picked by itself)')
  assert.equal(collapseLine({ prefix: '앱', label: 'Herdr', lang: 'ko' }), '  \x1b[32m✓\x1b[0m 앱: Herdr')
})

test('install.sh의 진행 줄(ui_step)은 짧다: 한글 2칸으로 세어 36칸 이하(sh가 줄바꿈 없이 찍는다)', () => {
  const steps = [...INSTALL.matchAll(/ui_step (?:ok|run|line|warn) "([^"]*)" "([^"]*)"/g)]
  assert.ok(steps.length >= 12, String(steps.length))
  for (const [, en, ko] of steps) for (const t of [en, ko]) {
    const shown = t.replace(/\$\{?[A-Za-z_]+(:-\??)?\}?/g, '0.9.5').replace(/\$\([^)]*\)/g, 'v26.13.0')
    assert.ok(strWidth(shown, { amb: 2 }) <= 36, t)
  }
})

test('install.sh: 메뉴 앞에 터미널 설정을 저장하고, 메뉴가 어떻게 끝나든 · 모든 신호 갈무리(EXIT/INT/TERM/HUP)에서 되돌린다', () => {
  const fn = (name) => { const a = INSTALL.indexOf(`\n${name}() {`); assert.ok(a >= 0, name); return INSTALL.slice(a, INSTALL.indexOf('\n}\n', a)) }
  const rich = fn('ask_env_rich')
  assert.match(rich, /ui_saved="\$\( \{ stty -g <\/dev\/tty; \} 2>\/dev\/null\)"/)
  for (const sig of ['EXIT', 'INT', 'TERM', 'HUP']) assert.match(rich, new RegExp(`trap '[^']*ui_restore[^']*' ${sig}`), sig)
  assert.match(rich, /stty -icanon -echo min 1 time 0 <\/dev\/tty/); assert.doesNotMatch(INSTALL, /stty[^\n]*\braw\b|setRawMode\(/, 'ISIG를 끄지 않는다')
  assert.match(fn('ui_restore'), /stty "\$ui_saved" <\/dev\/tty; printf '\\033\[\?25h' >\/dev\/tty/)
  for (const name of ['env_clean', 'unlock', 'on_signal', 'ui_menu_end']) assert.match(fn(name), /ui_restore/, name)
  assert.match(fn('ui_init'), /export WHOSUP_UI WHOSUP_UI_COLS/); assert.doesNotMatch(INSTALL, /export[^\n]*\bCOLUMNS\b/, 'COLUMNS는 넘기지 않는다')
})

test('접은 줄은 폭에 맞춰 나뉜다(시간 초과의 긴 줄): 낱말 중간에서 끊지 않고, 이어지는 줄은 ✓ 뒤 글자에 맞춰 4칸', () => {
  for (const [o, width] of [[{ prefix: 'Sessions run in', label: 'Desktop app', auto: true, lang: 'en' }, 59], [{ prefix: 'Herdr app sessions open in', label: 'Herdr app', auto: true, lang: 'en' }, 59],
    [{ prefix: 'Herdr 앱 세션을 여는 곳', label: 'Herdr 앱', auto: true, lang: 'ko' }, 59], [{ prefix: '세션을 쓸 곳', label: '데스크톱 앱', auto: true, lang: 'ko' }, 39]]) {
    const ls = collapseLine({ ...o, color: false, width }).split('\n')
    assert.ok(ls.length >= 2, ls.join('\n'))
    assert.ok(ls.every((l) => strWidth(l, { amb: 2 }) <= width), ls.join('\n'))
    assert.ok(ls.slice(1).every((l) => /^ {4}\S/.test(l)), ls.join('\n'))
    assert.equal(ls.map((l) => l.trim()).join(' '), collapseLine({ ...o, color: false }).trim(), '낱말을 쪼개지 않았다(공백으로 이으면 원래 줄)')
  }
  const c = collapseLine({ prefix: 'Sessions run in', label: 'Desktop app', auto: true, lang: 'en', width: 59 }).split('\n')
  assert.ok(c[0].startsWith('  \x1b[32m✓\x1b[0m Sessions run in:'), c[0]); assert.ok(!c[1].includes('\x1b'))
  assert.equal(collapseLine({ prefix: '앱', label: 'Herdr', lang: 'ko', color: false, width: 79 }), '  ✓ 앱: Herdr', '들어가면 한 줄 그대로')
  assert.equal(collapseLine({ prefix: 'App', label: 'Ovis', auto: true, lang: 'en', color: false, utf8: false, width: 30 }), '  ok App: Ovis (no answer,\n     picked by itself)', 'ASCII 기호(ok)면 그 폭에 맞춘다')
})

test('키 안내 줄은 " | " 사이에서만 나뉜다(구절 중간 · "120s" 안에서 끊지 않는다), 흐리게는 이 줄만', () => {
  assert.match(UI_TEXT.en.hint(1, 120), / \| 1 after 120s$/); assert.match(UI_TEXT.ko.hint(1, 120), / \| 120초 뒤 1번$/)
  for (const lang of ['en', 'ko']) for (const width of [39, 59, 79, 99]) {
    const parts = UI_TEXT[lang].hint(1, 120).split(' | ')
    const ls = menuLines({ title: 'Where?', options: OPTS, lang, width, color: false })
    const hint = ls.slice(ls.lastIndexOf('') + 1)
    assert.ok(hint.every((l) => l.startsWith('  ') && strWidth(l, { amb: 2 }) <= width), `${lang} ${width}\n${hint.join('\n')}`)
    const segs = hint.flatMap((l) => l.slice(2).split(' | '))
    assert.deepEqual(segs, parts, `${lang} ${width}: 줄마다 온전한 구절만\n${hint.join('\n')}`)
  }
  assert.equal(menuLines({ title: 'x', options: OPTS, lang: 'en', width: 99, color: false }).at(-1), `  ${UI_TEXT.en.hint(1, 120)}`, '넓으면 한 줄')
  // 진행 줄(…)은 흐리게 하지 않는다(밝은 배경에서 읽기 어렵다) — 흐리게는 키 안내 줄과 마지막 각주에만
  assert.deepEqual(renderBlocks([['run', 'downloading herdr']], { width: 59, color: true }), ['  … downloading herdr'])
  const all = renderBlocks([['run', 'a'], ['ok', 'b'], ['para', 'c'], ['foot', 'd']], { width: 59, color: true })
  assert.deepEqual(all.filter((l) => l.includes('\x1b[2m')), ['  \x1b[2md\x1b[0m'])
})

test('메뉴가 떠 있는 동안 프로세스가 끝나도(process.exit) 터미널 설정과 커서를 되돌린다: runMenu는 exit 처리기를 건다', () => {
  const src = readFileSync(new URL('../src/tui.mjs', import.meta.url), 'utf8')
  const body = src.slice(src.indexOf('const runMenu = function'), src.indexOf('// ── command line'))
  assert.match(body, /process\.on\("exit", onExit\)/); assert.match(body, /process\.removeListener\("exit", onExit\)/)
  assert.match(body, /const onExit = \(\) => \{ if \(!restored\) \{ restored = true; stty\(\[saved\]\); write\("\\x1b\[\?25h"\) \} \}/)
})

test('kv: 쪼갤 수 없는 경로가 값 칸에 안 들어가면 이름 아래 줄(6칸)로 내린다 — 줄이 폭을 넘지 않는다', async () => {
  const { renderBlocks, strWidth } = await import('../src/tui.mjs')
  const path = '~/.local/share/ovis-desktop/Ovis-linux-x64.AppImage'
  const ls = renderBlocks([['kv', 'whosup', '~/.local/share/whosup/app'], ['kv', 'Ovis 앱', path]], { width: 60, color: false })
  assert.deepEqual(ls, ['    whosup    ~/.local/share/whosup/app', '    Ovis 앱', '      ' + path])
  for (const l of ls) assert.ok(strWidth(l, { amb: 2 }) <= 60, l)
  assert.deepEqual(renderBlocks([['kv', 'Ovis 앱', path]], { width: 80, color: false }), ['    Ovis 앱   ' + path], '넓으면 지금처럼 옆에')
})

// r4(맥북 에어): Terminal.app 창 제목에 앞에서 도는 명령 줄이 그대로 나왔다("node -e \\012const UI_TEXT = {…"). r5: process.title로 이름을
// 바꾸자 제목이 "whosup install NVM_INC=…"처럼 환경변수까지 이어 보였다. 그래서 install.sh는 코드를 그 명령 하나에만 붙는 환경변수로
// 넘기고(node_js) 명령 줄에는 eval 한 줄과 인자만 둔다. 도우미는 process.title을 건드리지 않는다.
test('설치기 도우미(UI_JS · TTY_JS)는 짧은 명령 줄로 돈다: 코드는 환경변수로, process.title은 건드리지 않는다', async () => {
  const { spawnSync } = await import('node:child_process')
  const block = uiJsBlock(TUI)
  assert.doesNotMatch(block, /process\.title\s*=/)
  assert.doesNotMatch(INSTALL, /process\.title\s*=/)
  assert.doesNotMatch(INSTALL, /node -e "\$[A-Z_]+_JS"/, '긴 코드를 명령 줄에 두지 않는다(도우미 모두)')
  for (const call of ['node_js "$UI_JS" print', 'node_js "$UI_JS" menu', 'node_js "$TTY_JS" check', 'node_js "$TTY_JS" read', 'node_js "$LIMITED_JS"', 'node_js "$RECORD_JS"']) assert.ok(INSTALL.includes(call), call)
  assert.match(INSTALL, /run_quiet\(\) \{ WHOSUP_JS="\$NODE_JS_PRE\$RUN_JS" TMPDIR="\$env_tmp\/t" node -e 'eval\(process\.env\.WHOSUP_JS\)' /)
  // 설치기와 같은 모양으로 돌려 본다: 인자는 그대로 닿고(width), 명령 줄(argv)에는 코드가 없다
  const code = `${block}uiCli(process.argv.slice(1)).then(() => process.stderr.write(JSON.stringify(process.argv.slice(1))))`
  const r = spawnSync(process.execPath, ['-e', 'eval(process.env.WHOSUP_JS)', 'width'], { encoding: 'utf8', env: { ...process.env, WHOSUP_UI_COLS: '80', WHOSUP_JS: code } })
  assert.equal(r.status, 0, r.stderr); assert.equal(r.stdout, '79\n'); assert.equal(r.stderr, '["width"]')
  // sh 쪽 node_js(dash·sh): 인자·표준 입력·종료 코드가 그대로 닿고, 빈 인자도 빈 채로 닿되 명령 줄에는 빈 인자가 없다(\001로 바뀜 —
  // 빈 인자가 있으면 터미널이 인자 수만큼 읽다가 환경변수 하나를 끌어온다), WHOSUP_JS는 자식 프로세스에 물려주지 않는다
  const head = INSTALL.slice(INSTALL.indexOf('NODE_JS_PRE='), INSTALL.indexOf('ui_break() {'))
  const probe = 'const cp = require("child_process"); process.stdout.write(JSON.stringify([process.argv.slice(1), require("fs").readFileSync(0, "utf8"), cp.execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.env.WHOSUP_JS))"], { encoding: "utf8" })])); process.exitCode = 7'
  for (const shell of ['sh', 'dash']) {
    const t = spawnSync(shell, ['-c', `${head}node_js '${probe}' a '' 'b c'`], { encoding: 'utf8', input: '!' })
    if (t.error && t.error.code === 'ENOENT') continue
    assert.equal(t.status, 7, `${shell}: ${t.stderr}`)
    const [argv, input, inherited] = JSON.parse(t.stdout)
    assert.deepEqual(argv, ['a', '', 'b c'], shell); assert.equal(input, '!', shell); assert.equal(inherited, 'undefined', `${shell}: WHOSUP_JS가 자식에게 갔다`)
  }
  // 명령 줄에는 빈 인자가 남지 않는다: node_js가 넘기는 실제 argv를 본다(\001)
  const seen = spawnSync('sh', ['-c', `${head}node() { for a in "$@"; do [ -n "$a" ] || { echo EMPTY; return 1; }; done; echo FULL; }; node_js 'x' a '' b`], { encoding: 'utf8' })
  assert.equal(seen.stdout.trim(), 'FULL')
})
