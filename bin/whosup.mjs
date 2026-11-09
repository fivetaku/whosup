#!/usr/bin/env node
// whosup — one process: collects herdr pane state every few seconds and serves the board.
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { acquireLock, openDb, STATE_DIR } from '../src/db.mjs'
import { collectOnce } from '../src/collector.mjs'
import { startBoard } from '../src/board/server.mjs'
import { notifyPass } from '../src/notify.mjs'
import * as herdr from '../src/runtime/herdr.mjs'

const INTERVAL_MS = Number(process.env.WHOSUP_INTERVAL || 3) * 1000
mkdirSync(STATE_DIR, { recursive: true })
const log = (...a) => console.log(new Date().toISOString(), ...a)
// 같은 상태 폴더의 후즈업은 하나만(#1). 이미 돌고 있으면 수집·알림을 시작하지 않고 그 주소만 알린다.
// 잠금 핸들은 프로세스 수명 동안 쥐고 있어야 한다. 아무도 참조하지 않으면 GC가 거둬 잠금이 풀린다.
// stop에서 닫고, 전역에도 붙여 강하게 참조한다.
const lock = acquireLock(STATE_DIR)
if (!lock) {
  let port = '?'
  try { port = readFileSync(join(STATE_DIR, 'port'), 'utf8').trim() } catch {}
  log(`whosup already running for ${STATE_DIR} at http://127.0.0.1:${port}`)
  process.exit(0)
}
globalThis.__whosupLock = lock
const db = openDb()

let first = true
const tick = () => {
  try {
    const r = collectOnce(db, herdr, { emit: !first })
    if (first || r.added || r.events || r.gone) log(`herdr panes=${r.sessions} added=${r.added} events=${r.events}${r.gone ? ` gone=${r.gone}` : ''}${r.held ? ` unreachable=${r.unreachable.join(',')}` : ''}`)
  } catch (err) { log(`collect failed: ${err.message.slice(0, 200)}`) }
  try { notifyPass(db, { prime: first }) } catch (err) { log(`notify failed: ${err.message.slice(0, 200)}`) }
  first = false
}
tick()
const timer = setInterval(tick, INTERVAL_MS)

let port = Number(process.env.PORT || 4790)
let server
for (let i = 0; i < 10; i++) {
  try { server = await startBoard(db, { port, heartbeatPath: join(STATE_DIR, 'board-heartbeat') }); break } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    port += 1
  }
}
if (!server) { log('no free port'); process.exit(1) }
writeFileSync(join(STATE_DIR, 'port'), String(port))
log(`whosup listening at http://127.0.0.1:${port}`)
herdr.startHelpers()

const stop = () => { clearInterval(timer); herdr.stopHelpers(); server.close(); try { lock.close() } catch {}; log('stopped'); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('exit', () => herdr.stopHelpers())
