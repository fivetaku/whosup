// 보드 화면: 설정 "데스크를 켤 때 대화 이어 열기"(desk_resume)와, ask일 때 켜기를 누르면 이번 한 번 묻는 것.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const html = readFileSync(new URL('../src/board/index.html', import.meta.url), 'utf8')
const fnSrc = () => {
  const at = html.indexOf('function deskStartBody(')
  assert.ok(at > 0, '화면에 deskStartBody가 없다')
  return html.slice(at, html.indexOf('\n}', at) + 2)
}

test('켜기 요청: 설정이 ask면 물어서 resume을 싣고(확인=이어서, 취소=새로), on·off면 묻지 않고 서버 설정에 맡긴다', () => {
  const deskStartBody = new Function(`${fnSrc()}; return deskStartBody`)()
  let asked = 0
  const yes = () => { asked++; return true }, no = () => { asked++; return false }
  assert.deepEqual(deskStartBody('side', 'ask', yes), { session: 'side', on: true, resume: true })
  assert.deepEqual(deskStartBody('side', 'ask', no), { session: 'side', on: true, resume: false })
  assert.equal(asked, 2)
  assert.deepEqual(deskStartBody('side', 'on', yes), { session: 'side', on: true })
  assert.deepEqual(deskStartBody('side', 'off', yes), { session: 'side', on: true })
  assert.equal(asked, 2, 'on·off에서는 묻지 않는다')
})

test('켜기 버튼이 deskStartBody로 요청을 만든다', () => {
  assert.match(html, /const body = deskStartBody\(desk, board\?\.settings\?\.desk_resume, \(\) => confirm\(T\.deskResumeQ\(label\)\)\)/)
  assert.match(html, /post\('\/api\/desk', body\)/)
})

test('설정 화면: desk_resume 행에 늘·묻기·안 함 세 버튼과 저장용 칸이 있고, 두 언어 문구가 있다', () => {
  assert.match(html, /data-setting-text="desk_resume"/)
  for (const v of ['on', 'ask', 'off']) assert.ok(html.includes(`['${v}', T.deskResume`), `${v} 버튼`)
  const I18N = new Function(`${html.match(/const I18N = \{[\s\S]*?\n\}\n/)[0]}; return I18N`)()
  for (const lang of ['ko', 'en']) {
    for (const k of ['deskResumeLabel', 'deskResumeHint', 'deskResumeOn', 'deskResumeAsk', 'deskResumeOff']) assert.equal(typeof I18N[lang][k], 'string', `${lang}.${k}`)
    assert.equal(typeof I18N[lang].deskResumeQ, 'function', `${lang}.deskResumeQ`)
  }
})
