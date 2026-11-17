// node:sqlite 를 불러올 때 Node 22.x 가 찍는 "ExperimentalWarning: SQLite …"가 설치 화면·명령 출력에 나오지 않는다.
// (Node 23.4+ 는 이 경고를 찍지 않으므로 맥의 최신 node 에서는 늘 통과한다. 실제 확인은 rig/linux.sh 의 node 22.13 컨테이너다.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const run = (code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, encoding: 'utf8', timeout: 20000, killSignal: 'SIGKILL' })

test('db.mjs 를 불러와도 SQLite 실험 기능 경고가 표준 오류에 찍히지 않는다', () => {
  const r = run("await import('./src/db.mjs'); console.log('ok')")
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.trim(), 'ok')
  assert.doesNotMatch(r.stderr, /ExperimentalWarning|SQLite is an experimental/i, r.stderr)
})

test('loadSqlite 는 그 경고 하나만 거른다 — 다른 경고는 그대로, 끝나면 emitWarning 을 되돌린다', () => {
  const r = run([
    "const { loadSqlite } = await import('./src/sqlite.mjs')",
    'const before = process.emitWarning',
    'const m = await loadSqlite()',
    "if (typeof m.DatabaseSync !== 'function') throw new Error('no DatabaseSync')",
    "if (process.emitWarning !== before) throw new Error('emitWarning not restored')",
    "process.emitWarning('other thing', 'ExperimentalWarning')",
    "await new Promise((r) => setTimeout(r, 50)); console.log('ok')",
  ].join('\n'))
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /other thing/)
})
