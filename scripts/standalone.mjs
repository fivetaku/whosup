#!/usr/bin/env node
// whosup <명령> — 단독 설치(herdr 없이 — install.sh의 standalone 길)의 명령 줄. 부품은 src/standalone.mjs.
// ~/.local/bin/whosup(실행 명령)과 로그인 항목이 scripts/standalone.sh를 거쳐 이 파일을 부른다.
//
//   start | stop | status | open       보드 켜기·끄기·상태·브라우저로 열기(scripts/launch.mjs와 같은 동작, 폴더만 단독 설치의 것)
//                                      stop은 Linux에서 사용자 서비스(whosup.service)도 멈춘다 — 멈추지 않으면 active (exited)로 남아 다시 켜지지 않는다
//                                      (멈추라고 한 뒤에도 active면 그 사실과 손으로 칠 명령을 알리고 1로 끝낸다)
//   setup                              첫 실행 안내를 터미널에서 다시(scripts/setup.mjs의 단독 설치 갈래)
//   update                             새 버전으로 교체: 설치기(install.sh)를 standalone 길로 다시 돌린다. 설정·상태는 그대로, 켜져 있었으면 다시 켠다
//   uninstall [--purge]                보드 끄기 → 로그인 항목 해제 → 실행 명령·앱 폴더 삭제. 설정·상태 폴더는 --purge일 때만
//                                      로그인 항목을 치우지 못했으면(파일이 남았다 · 서비스 관리자에 아직 살아 있다) 프로그램을 지우기 전에 멈춘다
//                                      (로그인 때 없는 스크립트를 부르지 않게)
//   autostart on|off|status            로그인할 때 자동으로 켜기(macOS LaunchAgent · Linux systemd --user)
//                                      uninstall과 autostart on|off는 설치기와 같은 잠금(<데이터 폴더>/install.lock)을 잡는다: 설치·새 버전으로 바꾸기가
//                                      진행 중이면 알리고 1로 끝낸다(update는 설치기가 잡는다)
//   help
//   stop-at <상태 폴더>                (설치기 전용) 그 상태 폴더의 보드를 끈다: 끝내지 못한 설치가 지금과 다른 상태 폴더에서 켠 보드
//                                      (그 폴더는 그 설치의 표식 파일에 적혀 있다 — src/standalone.mjs noteState · install.sh clear_leftover)
//   install                            (설치기 전용) 앱 폴더를 놓은 뒤의 나머지: 첫 실행 안내 → 설치 기록 → 실행 명령 → 보드 켜기 → 로그인 항목 → 설치 요약
//                                      첫 실행 안내가 그만두면(Ctrl-C · 설치 명령이 죽음) 130으로 끝낸다: 새 설치는 놓은 것을 치우고, 새 버전으로 바꾸던 설치는
//                                      설치기가 이전 버전을 되돌린다. 새 버전으로 바꾸던 설치에서 켜져 있던 보드가 새 버전에서 켜지지 않아도 0이 아닌 값이다(되돌린다).
//                                      install·setup이 시간 초과로 끝나면 124(끝내지 못한 것이다 — 설치기가 완료로 보지 않는다)
//
// 폴더: 앱 폴더 옆의 설치 기록(<데이터 폴더>/install.json)이 이 앱을 가리키면 거기 적힌 설정·상태·데이터 폴더를 쓴다 — 설치한 뒤
//   다른 환경(로그인 항목·XDG 값이 다른 셸)에서 불러도 같은 폴더다. 기록이 없으면 지금 환경으로 계산한다(src/paths.mjs).
// 환경변수(설치기·install): WHOSUP_NO_SETUP=1 질문 없음 · WHOSUP_NO_AUTOSTART=1 설치 직후 보드를 켜지 않음 · WHOSUP_NO_LOGIN_START=1 로그인 항목을
//   등록하지 않음 · CI 셋 다 하지 않음 · WHOSUP_LANG=ko|en · WHOSUP_INSTALL_KIND=install|update · WHOSUP_WAS_RUNNING=1(업데이트 전에 보드가 켜져 있었다)
//   WHOSUP_LOGIN_START=1 로그인 항목이 부른 start(브라우저를 열지 않는다) · WHOSUP_INSTALL_SOURCE=<폴더> update가 내려받는 대신 그 폴더의 install.sh를 쓴다
//   WHOSUP_NODE 이 명령을 돌리는 node(scripts/standalone.sh가 채운다 — 설치 기록·실행 명령·로그인 항목에 적는다)
//   WHOSUP_INSTALLER_PID 설치기(install.sh)의 PID — 죽으면 설치가 취소된 것으로 본다. 그 설치기가 잠금을 잡고 있으면 uninstall·autostart는 그 잠금 아래에서 돈다
//     (그 PID가 정말 우리를 띄운 조상일 때만 — src/standalone.mjs startedBy. 환경변수로 다른 설치기의 PID를 대도 그 잠금 아래로 들어가지 않는다)
//   WHOSUP_LAUNCHCTL·WHOSUP_SYSTEMCTL launchctl·systemctl 대신 부를 프로그램(시험용)
//   WHOSUP_ENV_PICK·WHOSUP_ENV_INSTALLED·WHOSUP_ENV_APP (설치기가 install에만 넘긴다) 아무것도 없던 기계에서 설치기가 정한 앱(herdr-app | ovis-app) ·
//     이번에 함께 깐 환경(설치 기록의 env_installed — uninstall이 "그 앱은 지우지 않았다"를 한 줄로 알린다) · 그 앱의 경로.
//     요약의 "다음에 할 일"을 그 앱의 말로 한 번 싣고, 브라우저를 여는 설치면 그 앱도 전체 경로로 열어 준다(src/standalone.mjs pickedEnv · openApp)
// 윈도우: 지원하지 않는다(sh가 없어 설치기가 깔 수 없다) — 어떤 명령이든 그 사실과 herdr 플러그인 설치 명령을 알리고 1로 끝낸다.
import { spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { xdgDir } from '../src/paths.mjs'
import { INSTALL_SOURCE, TEXT, UI_ENV_KEYS, envOn, manifestId, openTerminal, pickLang, runSetup, skipMode, standaloneBlocks, standaloneLines, uiForStdout, watchdogMsOf } from '../src/setup.mjs'
import { renderBlocks } from '../src/tui.mjs'
import {
  HARDEN_TEXT, INSTALL_URL, PRODUCT, SERVICE, SERVICE_STOP_FLAG, appOwned, autostartStatus, browserOpens, coreNotes, envLeftovers, envOf, foreignRecord, launcherState, layout, nodeOf, noteState, pickedEnv, pinEnv,
  readRecord, readRecordFile, registerAutostart, removeInstall, shown, standaloneEnv, standaloneFacts, startedBy, withPathAdd, stopService, supported, takeLock, unregisterAutostart, writeLauncher, writeRecord,
} from '../src/standalone.mjs'
import { loadEnv, main as launch, parseEnvFile } from './launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const readEnvFile = (dir) => { try { return parseEnvFile(readFileSync(join(dir, '.env'), 'utf8')) } catch { return {} } }
const realOf = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }

// 앱 폴더 옆의 설치 기록: 이 스크립트가 든 폴더가 설치된 앱 폴더(<데이터 폴더>/app)이고 기록이 그 폴더를 가리킬 때만 쓴다
// (readRecord — 기록과 설치기의 표식이 한 쌍으로 맞아야 한다).
// 저장소 폴더에서 직접 돌린 것(시험·개발)에는 기록이 없다.
function recordHere() {
  const app = resolve(ROOT)
  if (basename(app) !== 'app') return null
  const rec = readRecord(dirname(app))
  return rec && realOf(rec.app) === realOf(app) ? rec : null
}

// 로그인할 때 자동으로 켜기의 지금 상태 한 줄. macOS에서 파일만 있고 launchd가 불러 두지 않았으면(loaded === false) "다음 로그인부터"라고 말한다.
const autoLine = (st, T) => (st.state === 'on' ? (st.loaded === false ? T.saAutoOnLater(st.file) : T.saAutoOn(st.file)) : st.state === 'none' ? T.saAutoNone : T.saAutoOff)

// 첫 실행 안내(터미널). install = 설치기 안에서 부른 것(첫 설치의 말투, 마무리 문구는 설치 요약이 찍는다).
async function setup({ env, home, platform, log, install, T }) {
  const terminal = openTerminal({ install, env })
  try {
    return await runSetup({
      standalone: true, install, closing: !install, env: standaloneEnv(env, home), home, platform, root: ROOT, terminal, readEnvFile,
      standaloneFacts: async () => withPathAdd(await standaloneFacts({ env, home, platform, T }), { env, home, platform, T }),
      log: !install && terminal && process.stdout.isTTY ? () => {} : log,   // 손 실행 화면에는 진단 줄을 섞지 않는다
    })
  } catch (err) {
    console.error(`whosup setup: ${String(err?.message || err).slice(0, 300)}`)
    return { state: 'failed' }
  } finally { try { terminal?.close() } catch {} }
}

// 보드 끄기. Linux에서는 사용자 서비스도 멈춘다: 서비스는 oneshot + RemainAfterExit라 보드를 꺼도 active (exited)로 남고, 남아 있는 동안은
// 다시 시작되지 않는다. 보드를 먼저 끄고 서비스를 멈춘다 — 그 멈춤(ExecStop)이 부르는 stop(--service)은 보드만 보므로 되풀이되지 않는다.
// 멈추라고 한 뒤에도 서비스가 active면(stopService) 그 사실과 손으로 칠 명령을 알리고 0이 아닌 값으로 끝낸다.
// 상태 폴더가 없으면 끌 보드도 없다: 그 폴더를 새로 만들지 않는다(설치기가 끝내지 못한 설치를 치우기 전에 이 stop을 부른다).
// 서비스 관리자에 물을 수 없었으면(svc.unsure) 멈췄다고만 말하지 않고 그 사실과 손으로 확인할 명령을 알린다(종료 코드는 그대로다).
const logUnsure = (u, X, log, pad = '') => { if (u) { log(`${pad}${X.unsure(u.name)}`); log(`${pad}    ${u.check}`) } }
async function stop({ env, home, platform, log, T, X, fromService = false }) {
  let code = 0
  if (existsSync(layout(env, home).state)) code = await launch('stop', standaloneEnv(env, home), log)
  else log('whosup not running')
  if (fromService) return code
  const svc = stopService({ env, home, platform })
  if (svc.ok) { logUnsure(svc.unsure, X, log); return code }
  log(T.saServiceStillOn(SERVICE)); log(`    ${svc.fix}`)
  return code || 1
}
// (설치기 전용) 그 상태 폴더의 보드를 끈다. 받는 폴더는 절대 경로이고 마지막 마디가 제품 이름인 것뿐이다(단독 설치의 상태 폴더는 늘 그렇다).
// 그 폴더가 없으면 끌 보드도 없다(새로 만들지 않는다). 끄는 것은 그 폴더의 보드로 확인된 프로세스뿐이다(scripts/launch.mjs stop).
async function stopAt({ env, home, log, X, dir }) {
  if (!xdgDir(dir) || basename(resolve(dir)) !== PRODUCT) { log(X.stopAtUsage); return 2 }
  if (!existsSync(dir)) { log('whosup not running'); return 0 }
  return launch('stop', { ...standaloneEnv(env, home), HERDR_PLUGIN_STATE_DIR: dir }, log)
}

// 설치기와 같은 잠금을 잡는다(제거·로그인 항목 켜고 끄기). 우리를 부른 설치기(WHOSUP_INSTALLER_PID)가 잡고 있으면 그 아래에서 돈다.
// 다른 설치·제거가 잡고 있으면 알리고 null.
function locked({ env, L, log, T }) {
  // 설치기의 PID라고 받은 값은 정말 우리를 띄운 조상일 때만 받는다(startedBy) — 아니면 보통의 잠금을 잡는다(쥔 쪽이 있으면 알리고 끝낸다)
  const claimed = Number(env.WHOSUP_INSTALLER_PID) || 0
  const lock = takeLock(L.data, { parent: startedBy(claimed) ? claimed : 0 })
  if (!lock.ok) { log(T.saLocked(lock.lock)); return null }
  return lock
}
// 로그인 항목을 끄지 못했다: 서비스 관리자에 아직 살아 있으면 그 이름과 손으로 칠 명령을, 파일이 남았으면 그 파일을 알린다.
const logOffFailed = (r, T, log) => { if (r.live) { log(T.saAutoStillLoaded(r.live)); log(`    ${r.fix}`) } else log(T.saAutoOffFailed(r.left.join(', '))) }

// 설치기(install.sh)가 앱 폴더를 놓은 뒤에 부른다. 로그인 항목 등록이 실패해도, 새 설치의 보드 켜기가 실패해도 설치는 실패가 아니다(0으로 끝나고
// 요약이 그 사실을 말한다). 0이 아닌 값은 설치기가 "끝내지 못했다"로 본다(새 설치는 놓은 것을 치우고, 새 버전으로 바꾸던 설치는 이전 버전으로 되돌린다):
// 그만둔 설치(130) · 설치 기록을 쓰지 못함(1) · 새 버전으로 바꾸던 설치에서 켜져 있던 보드가 새 버전에서 켜지지 않음(1).
async function install({ env, home, platform, log, T, X }) {
  const L = layout(env, home)
  // 데이터 폴더에 후즈업 것이 아닌 install.json이 있다: 덮지 않는다. 묻거나 켜기 전에 알리고 끝낸다(설치기가 방금 놓은 것을 치운다).
  if (foreignRecord(L.data)) { log(`whosup: ${X.foreignRecord(L.record)}`); return 1 }
  // 이 설치가 쓰는 상태 폴더를 앱 폴더의 표식에 적어 둔다(무엇을 켜기 전에): 이 설치가 끝나지 못하고 남으면, 다음 설치기가 그 줄로
  // 이 설치의 보드를 찾아 끈 뒤에 폴더를 치운다 — 그때의 환경(XDG_STATE_HOME)이 지금과 달라도.
  noteState(L.app, L.state)
  // 진단 줄(첫 실행 안내의 상태 "whosup setup: …" · 보드 켜기 "whosup listening at …" · 로그인 항목 "whosup: start at login: …")은 설치 요약이 같은
  // 사실을 사람의 말로 싣는 내부 줄이다: 화면에는 찍지 않고 기록 파일(<상태 폴더>/install.log)에 둔다. 끝내지 못한 설치(0이 아닌 값)와 켜지지
  // 못한 보드는 그 줄을 화면에도 보여 준다 — 무엇이 안 됐는지가 그 안에 있다.
  const diag = []
  const note = (l) => diag.push(l)
  // make = 상태 폴더가 아직 없어도 만들어 둔다: 로그인 항목을 놓은 설치(보드는 켜지 않은 WHOSUP_NO_AUTOSTART 포함)는 다음 로그인부터 그 폴더를
  // 쓴다 — 지금 만들지 않으면 진단 줄을 잃는다(Linux 에서는 로그인 항목이 상태 폴더를 만들지 않는다, 2026-11-14 Linux 컨테이너 실측).
  // 아무것도 켜지도 등록하지도 않는 설치(CI)는 상태 폴더를 만들지 않는다.
  const keep = (make = false) => {
    if (!diag.length) return
    if (!existsSync(L.state)) { if (!make) return; try { mkdirSync(L.state, { recursive: true }) } catch { return } }
    const at = new Date().toISOString()
    try { appendFileSync(join(L.state, 'install.log'), `${diag.map((l) => `${at} ${l}`).join('\n')}\n`) } catch {}
  }
  const shown = () => { for (const l of diag) log(l); diag.length = 0 }
  const bail = (code) => { keep(); shown(); return code }
  const senv = standaloneEnv(env, home)
  // 설치기가 이 단계에만 넘긴 값(환경 고르기의 결과)은 여기서 켜는 보드가 물려받지 않게 한다
  // 화면 값(WHOSUP_UI · WHOSUP_UI_COLS · WHOSUP_UI_OPEN)도 같다: 보드와 그 자식이 설치 때의 모드와 폭을 물려받지 않게(src/setup.mjs UI_ENV_KEYS)
  for (const k of ['WHOSUP_ENV_PICK', 'WHOSUP_ENV_INSTALLED', 'WHOSUP_ENV_APP', ...UI_ENV_KEYS]) delete senv[k]
  const kind = env.WHOSUP_INSTALL_KIND === 'update' ? 'update' : 'install'
  const mode = skipMode(env)
  const ci = mode.why === 'CI'
  const loginBefore = autostartStatus({ env, home, platform }).state

  // 1. 첫 실행 안내: 터미널이 있으면 묻고, 없으면(에이전트·스크립트) 묻지 않는다 — 보드를 처음 열 때 묻는다.
  //    첫 실행 안내가 오류로 끝난 것(state 'failed')은 설치를 막지 않는다(새 설치·새 버전으로 바꾸기 모두): 번호로 고른 값이 없을 뿐이다.
  const asked = await setup({ env, home, platform, log: note, install: true, T })
  if (['interrupted', 'cancelled'].includes(asked.state)) {
    // 그만둔 설치(질문에서 Ctrl-C · 설치기가 죽었다 — kill·터미널 닫힘): 더 나아가지 않는다. 실행 명령·보드·로그인 항목을 놓지 않는다.
    // 새 설치: 방금 놓은 앱 폴더를 치운다(설정·상태는 건드리지 않는다). 새 버전으로 바꾸던 설치: 그대로 130으로 끝내고 설치기가 이전 버전을 되돌린다.
    if (kind === 'install') removeInstall({ env, home, platform })
    // rich: 첫 실행 안내가 이미 "✗ 그만둡니다"를 그 언어로 찍었다 — 같은 뜻의 영어 진단 줄은 화면에 싣지 않고 기록 파일에만 둔다
    if (uiForStdout({ env, platform }).mode === 'rich') { keep(); diag.length = 0; return 130 }
    return bail(130)
  }

  // 2. 설치 기록(<데이터 폴더>/install.json): 이 설치가 쓰는 폴더와 node. 설치기는 이 기록으로 "단독 설치가 있다"를 알아보고,
  //    실행 명령·로그인 항목·제거가 여기 적힌 폴더를 쓴다. 쓰지 못하면 설치를 끝내지 않는다(설치기가 놓은 것을 치우거나 이전 버전을 되돌린다).
  //    함께 깐 환경(env_installed): 설치기가 이번에 깐 앱(WHOSUP_ENV_INSTALLED · WHOSUP_ENV_APP). 새 버전으로 바꾸는 설치는 앞 기록의 값을 이어 적는다.
  const node = nodeOf(env)
  let version = ''
  try { version = String(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version || '') } catch {}
  const withEnv = envOf({ env_installed: env.WHOSUP_ENV_INSTALLED, env_app: env.WHOSUP_ENV_APP })
  const kept = withEnv.installed ? withEnv : envOf(readRecordFile(L.data))
  try { writeRecord(L, { id: manifestId(ROOT), version, node, login: platform === 'darwin' ? L.plist : L.unit, envInstalled: kept.installed, envApp: kept.app }) } catch (err) {
    bail(1)
    log(`whosup: could not write the install record ${L.record} (${String(err?.code || err?.message || err).slice(0, 120)})`)
    return 1
  }

  // 3. 실행 명령(~/.local/bin/whosup): 남의 파일이면 건드리지 않는다.
  const launcher = writeLauncher({ app: L.app, file: L.launcher, node })

  // 4. 보드 켜기: 새 설치는 바로 켠다. 새 버전으로 바꾼 설치는 켜져 있었을 때만 다시 켠다(브라우저는 열지 않는다).
  let started = false, failed = false
  if (!ci && mode.autostart && (kind === 'install' || env.WHOSUP_WAS_RUNNING === '1')) {
    started = (await launch('start', senv, note, { noBrowser: kind === 'update' })) === 0
    failed = !started
  }
  // 새 버전으로 바꾼 설치에서 켜져 있던 보드가 새 버전에서 켜지지 않았다: 설치를 끝내지 않는다. 0으로 끝내면 설치기가 이전 버전을 지워, 돌던 보드가 꺼진 채
  // 새 버전만 남는다 — 0이 아닌 값을 돌려 설치기가 이전 버전으로 되돌리고 그 보드를 다시 켜게 한다. (새 설치의 보드 켜기 실패는 요약이 알린다.)
  if (failed && kind === 'update') {
    bail(1)
    log(`whosup: the board was running before the update and did not start in the new version (log: ${join(L.state, 'server.log')})`)
    return 1
  }

  // 5. 로그인할 때 자동으로 켜기: 새 설치는 등록한다. 새 버전으로 바꾼 설치는 등록돼 있던 것만 다시 쓴다(꺼 둔 사람의 선택을 지킨다).
  //    보드를 방금 켰을 때만 지금 불러 둔다(불러 두면 start가 한 번 돈다 — 켜지 않기로 한 보드를 켜지 않는다).
  let reg = null
  if (!ci && !envOn(env.WHOSUP_NO_LOGIN_START) && (kind === 'install' || loginBefore === 'on')) {
    reg = registerAutostart({ env, home, platform, activate: started })
    // 지금 불러 두지 않은 것(activate = false)과 불러 두려다 못 한 것(loadFailed — launchctl bootstrap 실패)을 구분해 적는다. 둘 다 다음 로그인부터 켜진다.
    const later = reg.loadFailed ? ', could not be loaded now: loads at the next login' : reg.loaded === false ? ', loads at the next login' : ''
    note(`whosup: start at login: ${reg.state}${reg.file ? ` (${reg.file}${later})` : ''}${reg.why ? ` — ${reg.why}` : ''}`)
  }
  // 진단 줄은 기록 파일에 두고, 보드가 켜지지 못했을 때만 화면에도 보여 준다(그 이유가 그 안에 있다)
  keep(Boolean(reg) || started)
  if (failed) shown()

  // 6. 설치 요약(표준 출력): 터미널 없이 돌려도 설치 출력에 남는다.
  const facts = await standaloneFacts({ env, home, platform, T })
  if (failed && !facts.board.up) facts.board.log = join(L.state, 'server.log')
  if (reg?.state === 'failed') facts.login = 'failed'
  // 등록은 됐는데(login = 'on') 지금 불러 두지는 못했다: 요약이 "다음 로그인부터 켜진다"고 말한다(src/setup.mjs standaloneLines saLoginOnLater).
  if (reg?.loadFailed) facts.loginLoad = 'failed'
  if (launcher.state === 'failed') facts.notes = [T.saLauncherFailed(L.launcher)]
  // 번호로 고른 값이 없는 첫 설치: 보드를 처음 열 때 첫 실행 안내가 묻는다. 그 말은 한 번만 한다 — 터미널에서 물은 설치(state 'done')는 첫 실행
  // 안내가 질문 아래에 이미 말했으므로("직접 정한 값이 없습니다. 보드를 처음 열 때 … 한 번 묻습니다" · "고를 것이 없어 … 한 번 보여 줍니다")
  // 요약에 다시 싣지 않는다. 터미널 없이 돈 설치(state 'silent' — 에이전트·스크립트·WHOSUP_NO_SETUP)에는 그 말을 한 곳이 없어 요약이 싣는다.
  // 이미 셋업한 설치(지웠다가 다시 깐 경우 — 설정·기록이 남아 있다)에는 싣지 않는다.
  if (asked.state === 'silent' && !asked.saved?.length) facts.notes.push(T.askLater)
  // 감지한 앱의 세션도 보드에 보인다는 한 줄: 터미널에서 물은 설치는 질문 아래에 이미 찍었다(runSetup). 묻지 않은 설치(에이전트가 돌린 설치 등)는
  // 감지를 돌리지 않았으므로, 방금 켠 보드의 자동 감지 결과(<상태 폴더>/auto.json)에서 가져온다. 보드가 꺼져 있으면 싣지 않는다.
  if (asked.state !== 'done' && facts.board.up) facts.notes.push(...await coreNotes(L.state, T))
  const opens = started && browserOpens(L, loadEnv(senv), platform)
  // 7. 환경 고르기로 정한 앱(아무것도 없던 기계의 새 설치 — WHOSUP_ENV_PICK): 요약에 그 앱의 말로 "다음에 할 일"을 한 번 싣는다.
  //    그 앱을 대신 열어 주는 것은 브라우저를 여는 것과 같은 판정이다(OPEN_BROWSER=0 · 원격 · CI · WHOSUP_NO_AUTOSTART면 열지 않는다).
  //    열 때는 설치기가 넘긴 그 앱의 전체 경로로 연다.
  const picked = pickedEnv({ env, kind, installed: withEnv.installed, mayOpen: !ci && mode.autostart && browserOpens(L, loadEnv(senv), platform), platform })
  // 설치 요약의 모양: rich(사람이 터미널 앞에 있다 — 설치기가 WHOSUP_UI로 넘긴다)면 "다음에 할 일"부터 쓰는 블록(src/setup.mjs standaloneBlocks),
  // 아니면 지금까지의 줄 그대로(standaloneLines).
  const ui = uiForStdout({ env, platform })
  if (ui.mode === 'rich') { for (const l of renderBlocks(standaloneBlocks({ ...withPathAdd(facts, { env, home, platform, T }), kind, opens, env: picked, home }, T, ui), ui)) log(l); return 0 }
  log('')
  for (const l of standaloneLines({ ...facts, kind, opens, env: picked }, T)) log(l)
  return 0
}

// 내려받은 것이 설치기인가: 비어 있지 않고, 첫 줄이 sh 스크립트이고, 끝이 main 호출 줄이다(중간에 끊긴 파일·오류 페이지를 돌리지 않는다).
export function looksLikeInstaller(text) {
  const lines = String(text || '').split('\n')
  while (lines.length && !lines.at(-1).trim()) lines.pop()
  return lines.length > 1 && lines[0] === '#!/bin/sh' && lines.at(-1) === 'main "$@"'
}

// 새 버전으로 교체: 설치기를 standalone 길로 다시 돌린다. 설치기가 보드를 끄고 앱 폴더를 바꾼 뒤 켜져 있었으면 다시 켠다.
// 설치기는 데이터 폴더를 XDG_DATA_HOME으로 계산한다: 지금 설치의 데이터 폴더(설치 기록의 것)를 그대로 넘겨 같은 자리를 보게 한다.
async function update({ env, home, log }) {
  const L = layout(env, home)
  const there = basename(L.data) === 'whosup' ? { XDG_DATA_HOME: dirname(L.data) } : {}
  const runInstaller = (file) => spawnSync('/bin/sh', [file], { stdio: ['ignore', 'inherit', 'inherit'], env: { ...env, ...there, WHOSUP_INSTALL_MODE: 'standalone' } }).status ?? 1
  if (env.WHOSUP_INSTALL_SOURCE) return runInstaller(join(env.WHOSUP_INSTALL_SOURCE, 'install.sh'))
  const url = env.WHOSUP_REF ? INSTALL_URL.replace('/main/', `/${env.WHOSUP_REF}/`) : INSTALL_URL
  // 이 실행만 쓰는 임시 폴더(mkdtemp: 무작위 이름, 0700)에 배타적으로 쓴다(wx, 0600) — 예측할 수 있는 이름의 파일을 sh로 돌리지 않는다.
  let dir = null
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30000) })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    if (!looksLikeInstaller(text)) throw new Error('what came back is not the installer')
    dir = mkdtempSync(join(tmpdir(), 'whosup-update-'))
    const file = join(dir, 'install.sh')
    writeFileSync(file, text, { flag: 'wx', mode: 0o600 })
    return runInstaller(file)
  } catch (err) {
    log(`whosup: could not download the installer (${String(err?.message || err).slice(0, 120)}). Check the connection, or run it yourself:`)
    log(`    curl -fsSL ${shown(url)} | WHOSUP_INSTALL_MODE=standalone sh`)
    return 1
  } finally { if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

async function uninstall({ env, home, platform, log, T, X, purge }) {
  const L = layout(env, home)
  // 깔려 있는가: 설치 기록, 설치기의 표식이 든 앱 폴더, 우리 실행 명령, 로그인 항목 중 하나라도 있다. 그 자리에 폴더가 있다는 것만으로는 아니다.
  // (기록 파일은 모양만 본다 — 앱 폴더가 이미 지워진 뒤에도 남은 기록·실행 명령을 치울 수 있게.)
  if (!readRecordFile(L.data) && !appOwned(L.app) && launcherState(L.launcher) !== 'ours' && !existsSync(L.plist) && !existsSync(L.unit)) { log(T.saNotInstalled); return 1 }
  // 설치기와 같은 잠금: 새 버전으로 바꾸는 도중(app → app.old, app.new → app 사이)에 끼어들어 그 폴더들을 지우지 않는다.
  const lock = locked({ env, L, log, T })
  if (!lock) return 1
  // 설치기가 이 설치와 함께 깐 앱(설치 기록의 env_installed): 그 앱은 지우지 않는다 — 지운 뒤 그 사실과 지우는 법을 한 줄로 알린다.
  const withEnv = envOf(readRecordFile(L.data))
  let unsure = null   // 서비스 관리자에 물을 수 없었던 것(있으면 끝에 한 번 알린다)
  try {
    // 상태 폴더가 없으면 끌 보드도 없다(stop이 그 폴더를 새로 만들지 않게 한다).
    if (existsSync(L.state)) {
      if ((await launch('stop', standaloneEnv(env, home), () => {})) !== 0) { log(T.saStillRunning); return 1 }
      // Linux: 사용자 서비스가 여전히 active면 멈춘다 — 프로그램을 지우면 그 서비스가 없는 스크립트를 가리킨다.
      const svc = stopService({ env, home, platform })
      if (!svc.ok) { log(T.saServiceStillOn(SERVICE)); log(`    ${svc.fix}`); log(T.saUninstallHalted); return 1 }
      unsure = svc.unsure || null
    }
    // 로그인 항목을 치우지 못했으면(파일이 남았다 · 서비스 관리자에 아직 살아 있다) 여기서 멈춘다: 프로그램을 지우면 다음 로그인 때 없는 스크립트를 부른다.
    const off = unregisterAutostart({ env, home, platform })
    if (off.state === 'failed') { logOffFailed(off, T, log); log(T.saUninstallHalted); return 1 }
    unsure = off.unsure || unsure
    const r = removeInstall({ env, home, platform, purge })
    // 잠금 폴더가 데이터 폴더 안에 있다: 잠금을 푼 뒤에야 빈 데이터 폴더가 치워진다. 비었는데도 남았으면 지우지 못한 것이다.
    lock.release()
    try { if (!readdirSync(L.data).length && !r.left.includes(L.data)) r.left.push(L.data) } catch {}
    log(r.left.length ? T.saUninstallPartly : T.saUninstalled)
    if (r.removed.length) log(`  ${T.saRemoved(r.removed.join(', '))}`)
    if (r.left.length) log(`  ${T.saLeft(r.left.join(', '))}`)
    if (r.foreign.length) log(`  ${T.saForeignKept(r.foreign.join(', '))}`)
    if (r.launcher === 'foreign') log(`  ${T.saLauncherKept(L.launcher)}`)
    if (r.kept.length) { log(`  ${T.saKept(r.kept.join(', '))}`); log(`  ${T.saKeptHow}`) }
    // 함께 깐 앱과 그 앱이 두는 폴더: 지우지 않고 남겨 두었다고 알린다(치우지 못한 것을 알리는 줄과 같은 꼴 — 굳히기 M2·M4·M5)
    if (withEnv.installed) {
      const theirs = envLeftovers(withEnv.installed, { env, home, platform })
      if (theirs.length) log(`  ${T.saEnvKeptFolders(theirs.join(', '))}`)
      log(`  ${T.saEnvKept(T.envNames[withEnv.installed], withEnv.app)}`)
    }
    logUnsure(unsure, X, log, '  ')
    return r.left.length ? 1 : 0
  } finally { lock.release() }
}

async function autostart({ env, home, platform, log, T, X, sub }) {
  if (sub === undefined || sub === 'status') { log(autoLine(autostartStatus({ env, home, platform }), T)); return 0 }
  if (sub !== 'on' && sub !== 'off') { log('usage: whosup autostart on|off|status'); return 2 }
  // 켜고 끄기는 설치기와 같은 잠금 아래에서: 설치·새 버전으로 바꾸기·제거가 로그인 항목을 쓰는 도중에 끼어들지 않는다.
  const lock = locked({ env, L: layout(env, home), log, T })
  if (!lock) return 1
  try {
    if (sub === 'on') {
      // 보드가 켜져 있을 때만 지금 불러 둔다(불러 두면 start가 한 번 돈다). 꺼져 있으면 다음 로그인부터 켜진다.
      const up = (await standaloneFacts({ env, home, platform })).board.up
      const r = registerAutostart({ env, home, platform, activate: up })
      if (r.state === 'on') {
        log(T.saAutoOn(r.file))
        if (r.loadFailed) log(`  ${T.saLoadLater}`)   // 불러 두려 했는데 안 됐다(launchctl bootstrap 실패): 다음 로그인부터 켜진다
        return 0
      }
      log(r.state === 'none' ? T.saAutoNone : T.saAutoFailed(r.why || ''))
      return 1
    }
    // off: 서비스 관리자가 그 항목을 놓았고 파일도 실제로 없어졌을 때만 꺼졌다고 말한다. 아니면 남은 것을 알리고 1로 끝낸다.
    const r = unregisterAutostart({ env, home, platform })
    if (r.state === 'failed') { logOffFailed(r, T, log); return 1 }
    log(T.saAutoOff); logUnsure(r.unsure, X, log, '  '); return 0
  } finally { lock.release() }
}

export async function main(argv = process.argv.slice(2), env0 = process.env, { log = console.log, platform = process.platform, home = homedir() } = {}) {
  const T = TEXT[pickLang(env0)]
  const X = HARDEN_TEXT[pickLang(env0)] || HARDEN_TEXT.en
  const cmd = argv[0] || 'help'
  if (['help', '--help', '-h'].includes(cmd)) { for (const l of T.saHelp('whosup')) log(l); return 0 }
  if (!supported(platform)) { log(T.saWindows); log(`    herdr plugin install ${INSTALL_SOURCE} --yes`); return 1 }
  // 설치 기록에 적힌 폴더를 쓴다(없으면 지금 환경으로 계산한다 — 물려받은 고정 값은 걷어 낸다).
  // 기록의 설정·상태 경로는 후즈업 자신의 폴더일 때만 쓴다(pinEnv — ownPlaces).
  const env = pinEnv(env0, recordHere(), home)
  const ctx = { env, home, platform, log, T, X }
  switch (cmd) {
    case 'start': return launch('start', standaloneEnv(env, home), log, { noBrowser: envOn(env.WHOSUP_LOGIN_START) })
    case 'stop': return stop({ ...ctx, fromService: argv.includes(SERVICE_STOP_FLAG) })
    case 'stop-at': return stopAt({ ...ctx, dir: argv[1] })
    case 'open': return launch(cmd, standaloneEnv(env, home), log)
    case 'status': {
      const code = await launch('status', standaloneEnv(env, home), log)
      log(autoLine(autostartStatus({ env, home, platform }), T))
      return code
    }
    // 손 실행의 Ctrl-C는 130(그만둠)으로 끝낸다.
    case 'setup': { const r = await setup({ ...ctx, install: false }); return r.state === 'failed' ? 1 : r.state === 'interrupted' ? 130 : 0 }
    case 'install': return install(ctx)
    case 'update': return update(ctx)
    case 'uninstall': return uninstall({ ...ctx, purge: argv.includes('--purge') })
    case 'autostart': return autostart({ ...ctx, sub: argv[1] })
    default: for (const l of T.saHelp('whosup')) log(l); return 2
  }
}

// 표준 출력을 내보낸 뒤 끝낸다. 터미널 읽기 스트림·타이머가 남아 있어도 여기서 끝난다(scripts/setup.mjs와 같다).
function exitFlushed(code) {
  let left = 2
  const done = () => process.exit(code)
  const one = () => { if (--left === 0) done() }
  for (const s of [process.stdout, process.stderr]) { s.on('error', () => {}); try { s.write('', one) } catch { one() } }
  setTimeout(done, 1000)
}

// 직접 실행했는가: 심볼릭 링크가 낀 경로로 불러도 맞게 푼 뒤 비교한다.
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  // 질문마다 시간 제한이 있지만, 그래도 못 끝나면 여기서 끝낸다(설치기가 무기한 서지 않게). 보드 켜기·내려받기의 여유를 더한다.
  // 시간 초과는 끝내지 못한 것이다: 0이 아닌 값(124)으로 끝낸다 — 설치기가 완료로 보고 이전 버전을 지우지 않게(이전 버전으로 되돌리거나 놓은 것을 치운다).
  // (herdr 플러그인의 build 훅 scripts/setup.mjs의 감시는 0으로 끝낸다: 플러그인 설치를 막지 않는다.)
  if (['install', 'setup'].includes(process.argv[2])) setTimeout(() => process.exit(124), watchdogMsOf() + 120000).unref()
  exitFlushed(await main())
}
