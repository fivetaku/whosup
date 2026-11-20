// 폴더 고르기·새 세션의 "홈 아래만" 경계는 글자가 아니라 실제 경로로 본다: 홈 안의 심볼릭 링크가 홈 밖을 가리키면 밖이다.
// HOME을 임시 폴더로 바꾼 뒤에 server.mjs를 불러온다(경계는 불러올 때의 홈으로 정해진다). macOS의 임시 폴더는 /var → /private/var
// 링크 아래라, 홈 자체가 실제 경로와 글자가 다른 경우도 함께 본다.
import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const posix = { skip: process.platform === 'win32' ? '윈도우에서는 심볼릭 링크를 만들 권한이 없을 수 있다' : false }
const base = mkdtempSync(join(tmpdir(), 'whosup-fb-'))
after(() => rmSync(base, { recursive: true, force: true }))
const home = join(base, 'home'), outside = join(base, 'outside')
for (const d of [join(home, 'work', 'app'), join(outside, 'secret'), join(base, 'sibling')]) mkdirSync(d, { recursive: true })
if (process.platform !== 'win32') {
  symlinkSync(outside, join(home, 'out'))            // 홈 안의 링크 → 홈 밖
  symlinkSync(join(home, 'work'), join(home, 'in'))  // 홈 안의 링크 → 홈 안
}
process.env.HOME = home
const { listDirs, underHome } = await import('../src/board/server.mjs')

test('홈과 홈 안의 폴더는 열린다 (홈의 글자가 실제 경로와 달라도)', posix, () => {
  const r = listDirs(home)
  assert.equal(r.ok, true, r.message)
  assert.equal(listDirs(join(home, 'work')).ok, true)
  assert.equal(listDirs(join(home, 'in')).ok, true, '홈 안을 가리키는 링크는 홈 안이다')
})

// 두 폴더는 실제로 있어서(읽을 수 있다) 거절되면 경계 때문이다.
test('홈 안의 링크가 홈 밖을 가리키면 열지 않는다', posix, () => {
  assert.equal(listDirs(join(home, 'out')).ok, false)
  assert.equal(listDirs(join(home, 'out', 'secret')).ok, false)
})

test('경계 판정(underHome): 없는 경로는 있는 조상까지 풀고, 링크 뒤의 ..는 파일시스템이 푸는 대로 본다', posix, () => {
  assert.equal(underHome(join(home, 'work', 'no-such-folder')), true, '홈 안의 아직 없는 폴더는 홈 안이다')
  assert.equal(underHome(join(home, 'out', 'no-such-folder')), false, '홈 밖을 가리키는 링크 아래의 없는 폴더는 밖이다')
  // 글자로 접으면 '홈/sibling'(홈 안)이지만, 파일시스템에서는 outside의 부모 아래 sibling(홈 밖)이다
  assert.equal(underHome(`${join(home, 'out')}/../sibling`), false)
  assert.equal(underHome(`${home}/../sibling`), false)
  assert.equal(underHome(join(home, 'in', 'app')), true)
})

test('홈 목록에는 홈 밖을 가리키는 링크를 싣지 않는다', posix, () => {
  const r = listDirs(home)
  assert.deepEqual(r.dirs, ['in', 'work'])
  assert.equal(r.parent, null, '홈에서는 위로 갈 곳이 없다')
})
