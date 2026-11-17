#!/usr/bin/env node
// whosup — one process: collects session state (herdr panes, herdr-core terminals) every few seconds and serves the board.
import { join } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { acquireLock, openDb, STATE_DIR } from '../src/db.mjs'
import { forgetDownSince } from '../src/collector.mjs'
import { applyLiveSettings, startBoard } from '../src/board/server.mjs'
import { notifyPass } from '../src/notify.mjs'
import * as herdr from '../src/runtime/herdr.mjs'
import { collectAll, watchAll, stopWatching } from '../src/runtime/index.mjs'
import { frontAppChoice, setAutoValues } from '../src/settings.mjs'
import { autoIsFresh, detectLine, pendingCoreRetry, readAuto, refreshAuto, watchOvisRegistry } from '../src/autoconf.mjs'
import { setupFilePath } from '../src/setup.mjs'

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
forgetDownSince(db)
// 자동 감지 층: 시작 스크립트(plugin.sh·launch.mjs)가 방금 쓴 auto.json(autoIsFresh: 같은 판본·플랫폼, 2분 안)만 그대로 읽는다.
// 그 밖(직접 실행, 오래된 파일, 다른 플랫폼·판본)에는 옛 값을 쓰지 않고 그 자리에서 다시 감지해 auto.json을 새로 쓴다 —
// 보드를 늦추지 않게 뒤에서 하고, 끝나면 그 값을 쓴다. 감지가 실패하면 자동 값 없음(옛 값을 남기지 않는다).
// 사람이 정한 값(설정·환경변수)은 어느 쪽이든 그대로 이긴다.
// 다시 감지(설정의 "다시 감지" 단추, 첫 실행 안내가 열려 있는 동안): 감지가 실패하면 그 전 자동 값을 그대로 둔다.
// 자동 감지가 찾은 "자기 herdr-core 코어를 띄우는 앱"의 코어(결과의 cores)는 setAutoValues 로 런타임에 닿는다(settings.mjs autoCores →
// runtime/core.mjs plan): 다음 수집부터 그 코어의 세션도 읽는다. 기록에는 코어 이름과 앱 이름만 적는다.
const coresNote = (r) => {
  const names = (Array.isArray(r?.cores) ? r.cores : []).filter((c) => c && typeof c.name === 'string')
    .map((c) => `${c.name}${typeof c.app === 'string' && c.app ? ` (${c.app})` : ''}`.replace(/[^A-Za-z0-9 ._()-]/g, '?').slice(0, 150))
  return names.length ? `; app cores: ${names.join(', ')}` : ''
}
// 감지는 한 줄로 세운다(autoconf.mjs detectLine): 시작할 때의 첫 감지, 등록부 지켜보기, 코어 이름 다시 묻기, 보드의 "다시 감지"와 첫 실행
// 안내(startBoard 에 넘기는 redetect)가 모두 이 줄에 선다. "감지 → auto.json 쓰기 → 자동 값 갈아 끼우기"가 한 번에 하나씩, 부른 순서대로
// 돈다 — 먼저 시작해 늦게 끝난 옛 감지가 새 값을 덮지 않는다. refreshAuto 는 이 줄 안에서만 부른다.
const inLine = detectLine()
// 다시 감지한 결과는 직전에 적은 줄과 다를 때만 기록에 적는다(값의 수·앱 코어 이름이 바뀌었을 때). 첫 실행 안내가 열려 있는 동안에는
// 화면이 5초마다 묻고 서버가 그때 다시 감지해서(board/server.mjs detectIfPending — 실제로는 10초에 한 번), 안내를 닫지 않고 둔 보드는
// 같은 줄을 10초마다 끝없이 쌓았다. 감지는 예전 그대로 돈다 — 줄만 줄인다. 실패하면 그 기억을 지운다: 실패 뒤의 첫 성공은 같은 값이어도 적는다.
const noteChanged = (() => { let last = null; return (note) => { if (note === last) return false; last = note; return true } })()
const redetect = () => inLine(async () => {
  const r = await refreshAuto(STATE_DIR, { onWriteError: (err) => log(`autoconf: could not write auto.json: ${err.message}`) }).catch((err) => { noteChanged(null); throw err })
  if (r.error) { noteChanged(null); throw new Error(r.error) }
  setAutoValues(r)
  const note = `autoconf: re-detected ${Object.keys(r.values).length} values${coresNote(r)}`
  if (noteChanged(note)) log(note)
  coreRetry.check(r)
})
// 방금 켠 앱의 서버는 몇 초 동안 코어 이름을 알려 주지 않는다: 그런 서버가 있으면 잠시 뒤 다시 감지한다(autoconf.mjs pendingCoreRetry).
const coreRetry = pendingCoreRetry(() => {
  redetect().then(() => applyLiveSettings(db)).catch((err) => log(`autoconf failed: ${String(err.message || err).slice(0, 200)}`))
})
// 자기 herdr-core 코어를 띄우는 앱은 보드보다 늦게 켜지기 쉽다(로그인 때 보드가 먼저 뜬다). 그 앱의 서버가 ovis 브리지 등록부에
// 들고 나는 것(켜짐·꺼짐·다시 켜서 포트가 바뀜)이 보이면 다시 감지한다 — 평소에는 등록부 폴더의 파일만 읽고 서버에 묻지 않는다.
// 기준은 시작할 때의 감지보다 먼저 읽는다(그 사이에 켜진 앱도 첫 확인에서 잡힌다). 다시 감지가 실패하면 그 전 자동 값을 그대로 둔다.
const stopRegistryWatch = watchOvisRegistry(() => {
  coreRetry.reset()
  redetect().then(() => applyLiveSettings(db)).catch((err) => log(`autoconf failed: ${String(err.message || err).slice(0, 200)}`))
})
const savedAuto = readAuto(STATE_DIR)
if (autoIsFresh(savedAuto)) { setAutoValues(savedAuto); if (coresNote(savedAuto)) log(`autoconf: using auto.json${coresNote(savedAuto)}`); coreRetry.check(savedAuto) }
else {
  inLine(async () => {
    const r = await refreshAuto(STATE_DIR, { onWriteError: (err) => log(`autoconf: could not write auto.json: ${err.message}`) })
    setAutoValues(r)
    herdr.setFrontApp(...frontAppChoice(db))
    coreRetry.check(r)
    log(r.error ? `autoconf failed: ${r.error} (no detected values)` : `autoconf: ${Object.keys(r.values).length} detected values${savedAuto ? ' (auto.json was stale)' : ''}${coresNote(r)}`)
  }).catch((err) => log(`autoconf failed: ${String(err.message || err).slice(0, 200)}`))
}

let first = true
let ticking = false
let lastNote = ''
let pending = false
let server
// herdr가 변화를 알려 오면(이벤트 구독) 주기를 기다리지 않고 바로 수집한다. 연달아 오는 알림은 한 번으로 묶는다.
let kickTimer = null
const kick = () => { if (kickTimer) return; kickTimer = setTimeout(() => { kickTimer = null; tick() }, 20) }
// herdr 조회는 비동기로 한다(서버가 그동안 클릭에 답할 수 있게). 앞 수집이 아직 안 끝났으면 겹쳐 돌리지 않고,
// 끝나는 대로 한 번 더 돈다 — 수집이 주기보다 오래 걸려도(부하가 높을 때) 주기가 두 배로 늘어지지 않는다.
const tick = async () => {
  if (ticking) { pending = true; return }
  ticking = true
  try {
    try {
      const { runs, runtimes, failure, notes = [] } = await collectAll(db, { emit: !first })
      // 한 런타임에 닿지 못하게 됐거나 다시 닿게 된 때만 한 줄 적는다(수집마다 적지 않는다).
      const note = notes.join('; ')
      if (note !== lastNote) { log(note || 'all runtimes reachable again'); lastNote = note }
      for (const r of runs) {
        if (first || r.added || r.events || r.gone) log(`${r.name} sessions=${r.sessions} added=${r.added} events=${r.events}${r.gone ? ` gone=${r.gone}` : ''}${r.held ? ` unreachable=${r.unreachable.join(',')}` : ''}`)
      }
      // 판이 달라졌으면 열려 있는 보드 탭에 바로 알린다(화면의 3초 주기를 기다리지 않게).
      if (runs.some((r) => r.added || r.events || r.gone)) server?.notifyChange?.()
      if (failure) log(`collect failed: ${failure.message.slice(0, 200)}`)
      try { watchAll(runtimes, kick) } catch (err) { log(`watch failed: ${err.message.slice(0, 200)}`) }
    } catch (err) { log(`collect failed: ${err.message.slice(0, 200)}`) }
    try { notifyPass(db, { prime: first }) } catch (err) { log(`notify failed: ${err.message.slice(0, 200)}`) }
    first = false
  } finally { ticking = false; if (pending) { pending = false; setTimeout(tick, 0) } }
}
await tick()
const timer = setInterval(tick, INTERVAL_MS)

// 설치 셋업(scripts/setup.mjs)이 터미널에서 받은 답: <설정 폴더>/setup.json을 서버가 시작할 때와 실행 중에 읽어 설정에 넣는다.
const onSetup = (r) => log(`setup: imported choices from setup.json (${r.applied.join(', ') || 'none set by hand'}${r.dropped.length ? `; dropped ${r.dropped.join(', ')}` : ''})`)
let port = Number(process.env.PORT || 4790)
for (let i = 0; i < 10; i++) {
  try { server = await startBoard(db, { port, heartbeatPath: join(STATE_DIR, 'board-heartbeat'), redetect, setupFile: setupFilePath(), onSetup }); break } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err
    port += 1
  }
}
if (!server) { log('no free port'); process.exit(1) }
writeFileSync(join(STATE_DIR, 'port'), String(port))
log(`whosup listening at http://127.0.0.1:${port}`)
herdr.startHelpers()

const stop = () => { clearInterval(timer); stopRegistryWatch(); herdr.stopHelpers(); stopWatching(); server.close(); try { lock.close() } catch {}; log('stopped'); process.exit(0) }
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('exit', () => herdr.stopHelpers())
