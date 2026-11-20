// 상주 창 올리기 도우미를 실제 /usr/bin/osascript로 띄우고 표준 입력을 닫으면 스스로 끝나는가(macOS 전용).
// raise-helper.test.mjs는 가짜 ObjC로 돌려서, 실제 JXA가 NSData.length를 숫자가 아니라 문자열("0")로
// 돌려주는 것을 보지 못했다. 그 탓에 whosup가 죽어 입력이 닫혀도 도우미가 빈 읽기를 끝없이 돌며 CPU를 썼다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const herdr = await import('../src/runtime/herdr.mjs')
const mac = process.platform === 'darwin' && existsSync('/usr/bin/osascript')

test('도우미: 실제 osascript에서 표준 입력이 닫히면 5초 안에 끝난다', { skip: !mac && 'macOS 전용(실제 osascript가 필요하다)' }, async () => {
  const child = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', herdr._macHelperSource()], { stdio: ['pipe', 'pipe', 'ignore'] })
  try {
    // 'ready'를 받은 뒤에 입력을 닫는다 — 도우미가 읽기 루프에 들어간 다음이다.
    await new Promise((resolve, reject) => {
      let out = ''
      child.stdout.on('data', (d) => { out += d; if (out.includes('ready')) resolve() })
      child.on('error', reject)
      child.on('exit', () => reject(new Error(`도우미가 ready 전에 끝났다: ${out}`)))
    })
    child.stdin.end()
    const ended = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 5000)
      child.on('exit', () => { clearTimeout(timer); resolve(true) })
    })
    assert.equal(ended, true, '입력이 닫힌 뒤 5초가 지나도 도우미가 살아 있다')
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
