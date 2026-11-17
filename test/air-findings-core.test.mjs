// 실기기 걷기(맥북에어, 2026-11-14)에서 나온 것 — 서버 기록: 다시 감지한 결과가 같으면 같은 줄을 또 적지 않는다.
//   첫 실행 안내가 열려 있는 동안 화면이 5초마다 묻고 서버가 그때 다시 감지한다(board/server.mjs detectIfPending). 감지는 그대로 돌고,
//   기록(server.log)에는 직전에 적은 줄과 다를 때만 적는다(bin/whosup.mjs noteChanged).
// 실제 bin/whosup.mjs 를 임시 상태 폴더와 시험 포트로 띄운다. 창·브라우저는 열지 않는다(OPEN_BROWSER=0), herdr 는 없는 경로로 준다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const BIN = join(ROOT, 'bin', 'whosup.mjs')
const NO_HERDR = '/nonexistent/whosup-test/herdr'
const binText = readFileSync(BIN, 'utf8')

test('기록 줄 거르기(noteChanged): 직전에 적은 글과 같으면 적지 않고, 달라지면 적는다. 지우면(null) 같은 글도 다시 적는다', () => {
  // bin/whosup.mjs 는 부르는 순간 서버를 띄우는 실행 파일이라 가져올(import) 수 없다: 그 한 줄을 글에서 꺼내 그대로 돌려 본다
  const m = /^const noteChanged = (\(\(\) => \{.*\}\)\(\))$/m.exec(binText)
  assert.ok(m, 'bin/whosup.mjs 에 noteChanged 한 줄이 있다')
  const noteChanged = new Function(`return ${m[1]}`)()
  const a = 'autoconf: re-detected 13 values; app cores: deskapp (Deskapp)'
  assert.equal(noteChanged(a), true, '처음은 적는다')
  assert.deepEqual([noteChanged(a), noteChanged(a), noteChanged(a)], [false, false, false], '같은 결과가 이어지면 적지 않는다')
  assert.equal(noteChanged('autoconf: re-detected 12 values'), true, '값의 수·앱 코어가 달라졌다')
  assert.equal(noteChanged('autoconf: re-detected 12 values'), false)
  assert.equal(noteChanged(a), true, '되돌아온 값도 직전 줄과 다르면 적는다')
  noteChanged(null)                                            // 감지가 실패했다: 기억을 지운다
  assert.equal(noteChanged(a), true, '실패 뒤의 첫 성공은 같은 값이어도 적는다')
  assert.equal(noteChanged(a), false)
  // 줄마다 따로 기억하지 않는다: 만들 때마다 새 기억이다(이 시험이 꺼낸 것과 서버가 쓰는 것은 서로 물들지 않는다)
  assert.equal(new Function(`return ${m[1]}`)()(a), true)
})

test('bin/whosup.mjs: 다시 감지한 줄은 noteChanged 를 거쳐서만 적고, 실패는 예전처럼 던져 부른 쪽이 적는다(기억도 지운다)', () => {
  assert.match(binText, /const note = `autoconf: re-detected \$\{Object\.keys\(r\.values\)\.length\} values\$\{coresNote\(r\)\}`\s*\n\s*if \(noteChanged\(note\)\) log\(note\)/)
  assert.doesNotMatch(binText, /log\(`autoconf: re-detected/, '거르지 않고 바로 적는 줄이 없다')
  assert.equal(binText.match(/re-detected/g).length, 1, '다시 감지한 줄을 만드는 곳은 하나다')
  assert.match(binText, /if \(r\.error\) \{ noteChanged\(null\); throw new Error\(r\.error\) \}/)
  // refreshAuto 가 오류를 돌려주지 않고 던져도(auto.json 쓰기 밖의 뜻밖의 오류) 기억을 지운다: 실패 뒤의 첫 성공은 같은 값이어도 적힌다
  assert.match(binText, /const r = await refreshAuto\([^\n]*\)\.catch\(\(err\) => \{ noteChanged\(null\); throw err \}\)/)
  // 감지 자체는 줄이지 않았다: 값을 갈아 끼우고 코어 이름을 다시 물을지 보는 일은 줄을 적든 말든 한다
  assert.match(binText, /setAutoValues\(r\)\s*\n\s*const note = [^\n]*\n\s*if \(noteChanged\(note\)\) log\(note\)\s*\n\s*coreRetry\.check\(r\)/)
})

function start(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [BIN], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.once('error', reject)
    child.stdout.on('data', (d) => { out += d; const m = out.match(/listening at (http:\S+)/); if (m) resolve({ child, url: m[1], log: () => out }) })
    child.stderr.on('data', (d) => { out += d })
    child.on('exit', (code) => reject(new Error(`exited ${code}: ${out}`)))
  })
}
const waitFor = async (fn, ms = 20000) => { const end = Date.now() + ms; while (Date.now() < end) { const v = fn(); if (v) return v; await new Promise((r) => setTimeout(r, 50)) } return fn() }

test('실제 실행 파일: 다시 감지를 여러 번 해도(결과가 같으면) "re-detected" 줄은 한 번만 적힌다 — 감지는 매번 돌아 auto.json 은 새로 쓰인다', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'whosup-relog-'))
  const { child, url, log } = await start({ WHOSUP_STATE_DIR: dir, HERDR_PLUGIN_CONFIG_DIR: join(dir, 'conf'), HERDR_BIN: NO_HERDR, HERDR_BIN_PATH: NO_HERDR, CLAUDE_PROJECTS_DIR: join(dir, 'projects'),
    PORT: String(48400 + Math.floor(Math.random() * 100)), WHOSUP_INTERVAL: '60', WHOSUP_OPEN_BROWSER: '0', OPEN_BROWSER: '0', FRONT_APP: '' })
  try {
    const auto = () => { try { return JSON.parse(readFileSync(join(dir, 'auto.json'), 'utf8')) } catch { return null } }
    const refresh = () => fetch(`${url}/api/autoconf/refresh`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.ok(await waitFor(() => /autoconf: \d+ detected values/.test(log())), `첫 감지가 끝나지 않았다:\n${log()}`)
    const seen = []                                           // 다시 감지할 때마다의 auto.json: [감지 시각, 기록에 적힐 글의 재료]
    for (let i = 0; i < 5; i++) {
      const before = auto()?.at
      const r = await refresh()
      assert.equal(r.status, 200, log())
      const a = auto()
      assert.notEqual(a.at, before, `${i + 1}번째 다시 감지도 실제로 돌았다(auto.json 을 새로 썼다)`)
      seen.push(`${Object.keys(a.values).length}|${(a.cores || []).map((c) => c.name).join(',')}`)
      await new Promise((res) => setTimeout(res, 5))           // 감지 시각(ms)이 겹치지 않게
    }
    const lines = log().split('\n').filter((l) => /autoconf: re-detected/.test(l)).map((l) => l.replace(/^\S+ /, ''))
    assert.ok(lines.length >= 1, `다시 감지한 첫 결과는 적는다:\n${log()}`)
    for (let i = 1; i < lines.length; i++) assert.notEqual(lines[i], lines[i - 1], `같은 줄을 잇달아 적었다:\n${lines.join('\n')}`)
    // 이 기계의 환경이 그 몇 초 사이에 바뀌지 않았으면(보통 그렇다) 다섯 번 감지에 줄은 하나다
    if (new Set(seen).size === 1) assert.equal(lines.length, 1, lines.join('\n'))
    assert.match(lines[0], /^autoconf: re-detected \d+ values/)
    assert.doesNotMatch(log(), /autoconf failed|could not write auto\.json/)
  } finally { child.kill('SIGTERM'); await new Promise((res) => child.once('exit', res)); rmSync(dir, { recursive: true, force: true }) }
})
