// 독립 검토 뒤 고친 것(ui 갈래 후속).
//   · expandHome: 윈도우에서는 "~\폴더" 도 홈 폴더다(src/board/server.mjs — /api/new 의 cwd 를 풀 때). 맥·리눅스에서는 "~\" 를 풀지 않는다
//     (그쪽에서 역슬래시는 보통 글자다).
//   · 설정 화면의 chCoreOther 문구: Herdr 앱을 골라도 창 안에서 세션을 골라 줄 수 없는 앱은 브라우저 탭으로 연다고 말한다 — "창만 앞으로
//     올린다"고 약속하지 않는다(U2 뒤의 실제 동작).
//   · src/board/server.mjs 머리 주석: 탭을 여는 클릭은 앱 창을 올리지 않는다고 적혀 있다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'

process.env.WHOSUP_STATE_DIR = mkdtempSync(join(tmpdir(), 'wafu-'))
process.env.WHOSUP_NO_EVENTS = '1'
const { expandHome } = await import('../src/board/server.mjs')
const { _setPlatform } = await import('../src/platform.mjs')
const HOME = homedir()
const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const server = readFileSync(new URL('../src/board/server.mjs', import.meta.url), 'utf8')
const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()

test('expandHome: 윈도우에서는 "~\\폴더" 도 홈 폴더로 푼다. 맥·리눅스에서는 "~\\" 를 건드리지 않는다. "~/" 는 어디서나 같다', () => {
  _setPlatform('win32')
  try {
    assert.equal(expandHome('~\\proj'), join(HOME, 'proj'))
    assert.equal(expandHome('~\\a\\b'), join(HOME, 'a\\b'))
    assert.equal(expandHome('~/proj'), join(HOME, 'proj'))
    assert.equal(expandHome('~'), HOME)
    for (const same of ['~someone\\x', 'C:\\Users\\me\\~\\x', '']) assert.equal(expandHome(same), same, same)
  } finally { _setPlatform(null) }
  _setPlatform('darwin')
  try {
    assert.equal(expandHome('~\\proj'), '~\\proj', '맥에서는 역슬래시가 글자다 — 풀지 않는다')
    assert.equal(expandHome('~/proj'), join(HOME, 'proj'))
  } finally { _setPlatform(null) }
})

test('설정 화면의 chCoreOther: Herdr 앱을 골라도 창 안에서 세션을 골라 줄 수 없는 앱은 브라우저 탭으로 연다고 말한다(KO·EN)', () => {
  assert.match(I18N.ko.chCoreOther, /브라우저 탭으로/); assert.match(I18N.en.chCoreOther, /browser tab/)
  assert.doesNotMatch(I18N.ko.chCoreOther, /창만 앞으로/); assert.doesNotMatch(I18N.en.chCoreOther, /only brings/)
  // 예전부터 지키던 글귀는 그대로(test/cores.test.mjs)
  assert.match(I18N.ko.chCoreOther, /다른 앱의 세션에도 적용/); assert.match(I18N.en.chCoreOther, /other apps that run a core of their own/)
  // 앱 이름은 들어 있지 않다(Herdr 앱은 '세션을 여는 곳'의 선택지 이름이다)
  assert.doesNotMatch(I18N.ko.chCoreOther + I18N.en.chCoreOther, /ovis/i)
})

test('src/board/server.mjs 의 머리 주석: 탭을 여는 클릭은 앱 창을 올리지 않는다고 적혀 있다(예전의 "앱 창 올리기는 그대로 한다"가 아니다)', () => {
  const head = server.slice(0, server.indexOf('export function clientDefaultsOf'))
  assert.doesNotMatch(head, /앱 창 올리기는 그대로 한다/)
  assert.match(head, /탭을 여는 클릭은 앱 창을 올리지 않는다/)
})
