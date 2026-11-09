// 이동 시 앞으로 올릴 터미널 찾기: 앱 인스턴스가 여러 개여도 그 세션을 붙든 인스턴스만 고른다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { terminalPidsFor } from '../src/runtime/herdr.mjs'

const PS = `
  100     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
  200     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
  300     1 /Applications/Ghostty.app/Contents/MacOS/ghostty
  101   100 /usr/bin/login -flp me /bin/bash --noprofile --norc -c exec -l /Users/me/.local/bin/herdr-launch
  102   101 /opt/homebrew/bin/herdr --session main
  201   200 /usr/bin/login -flp me /bin/bash --noprofile --norc -c exec -l /Users/me/.local/bin/herdr-launch
  202   201 /opt/homebrew/bin/herdr --session side
  301   300 /usr/bin/login -flp me /bin/zsh
  302   301 herdr
  400     1 /opt/homebrew/bin/herdr --session main server
  401     1 /opt/homebrew/bin/herdr server
  500     1 /Applications/iTerm.app/Contents/MacOS/iTerm2
  501   500 /opt/homebrew/bin/herdr --session air
`

test('jump: 세션을 붙든 터미널 인스턴스만 고른다(서버·다른 세션 제외)', () => {
  assert.deepEqual(terminalPidsFor(PS, 'main', 'Ghostty'), [100])
  assert.deepEqual(terminalPidsFor(PS, 'side', 'Ghostty'), [200])
  assert.deepEqual(terminalPidsFor(PS, 'default', 'Ghostty'), [300])
})

test('jump: 창이 없는 세션·다른 앱의 창은 고르지 않는다', () => {
  assert.deepEqual(terminalPidsFor(PS, 'air', 'Ghostty'), [])
  assert.deepEqual(terminalPidsFor(PS, 'air', 'iTerm'), [500])
  assert.deepEqual(terminalPidsFor(PS, 'nope', 'Ghostty'), [])
})
