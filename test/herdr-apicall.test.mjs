// herdr 소켓이 해석할 수 없는 줄을 돌려줘도 보드 프로세스가 죽지 않고 그 요청만 실패하는가.
// apiCall은 소켓 'data' 처리기 안에서 JSON.parse를 한다 — 거기서 던지면 잡히지 않은 예외로 프로세스 전체가 끝난다.
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { connectTarget } from '../src/platform.mjs'

const dir = await mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'ha-'))
const socket = join(dir, 'desk.sock')
const fake = join(dir, 'herdr.mjs')
await writeFile(fake, `process.stdout.write(JSON.stringify({ sessions: [{ name: 'desk', running: true, session_dir: ${JSON.stringify(dir)}, socket_path: ${JSON.stringify(socket)} }] }))\n`)
process.env.HERDR_BIN_PATH = fake
process.env.WHOSUP_STATE_DIR = dir
const { apiCall } = await import('../src/runtime/herdr.mjs')
after(() => rm(dir, { recursive: true, force: true }))

test('herdr가 해석할 수 없는 줄을 주면 그 요청만 거절하고 프로세스는 산다', { timeout: 5000 }, async (t) => {
  const server = createServer((sock) => sock.on('data', () => sock.write('this is not json\n')))
  await new Promise((resolve) => server.listen(connectTarget(socket), resolve))
  t.after(() => new Promise((done) => server.close(done)))
  let crashed = null
  const onCrash = (err) => { crashed = err }
  process.prependListener('uncaughtException', onCrash)
  t.after(() => process.removeListener('uncaughtException', onCrash))
  await assert.rejects(apiCall('desk', 'pane.focus', { pane_id: 'p' }, { timeoutMs: 2000 }), /herdr pane\.focus/)
  assert.equal(crashed, null, `잡히지 않은 예외가 났다: ${crashed?.message}`)
})
