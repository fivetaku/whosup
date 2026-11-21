// 설치에 이어지는 셋업(터미널판 첫 실행 안내): `herdr plugin install`의 build 훅이 scripts/setup.mjs --install로 부른다.
//
// 하는 일: 이 컴퓨터를 확인하고(src/autoconf.mjs detect·evaluate — 메모리에서만, auto.json을 쓰지 않는다) 보드의 첫 실행 안내와
// 같은 네 항목을 같은 조건으로 묻고, 번호로 직접 고른 것만(첫 설치에서 다 답했으면 마친 표시도) <설정 폴더>/setup.json에 쓰고, herdr가 켜져 있으면 설치가 끝난 뒤
// 보드를 띄울 분리 도우미를 남기고, 다음에 일어날 일을 알려 준다.
//
// 지키는 것:
//  - herdr는 build를 시간 제한 없이 기다린다 → 질문마다 시간 제한이 있고, 어떤 경우에도 끝난다(scripts/setup.mjs가 process.exit).
//  - build의 표준 출력은 herdr가 버린다 → 사람에게 보일 글자는 제어 터미널(/dev/tty)에 쓴다. 터미널의 앞 프로세스 그룹이 아니거나
//    윈도우 설치면(build가 보이지 않는 콘솔에서 돈다) 묻지 않는다 — 보드의 첫 실행 안내가 묻는다(openTerminal).
//  - 사용자 입력은 번호만 받는다. herdr는 인자 배열로만 부른다(셸 문자열 없음). .env·DB는 고치지 않는다(setup.json만 쓴다).
//  - build가 남기는 도우미는 파일 경로에 기대지 않는다(herdr 0.9.3은 build를 임시 폴더에서 돌린 뒤 옮긴다).
//  - 설치 명령(WHOSUP_INSTALLER_PID)이 죽었으면 설치는 취소된 것이다(Ctrl-C·터미널 닫힘·kill): 저장도 도우미도 마무리 문구도 없고,
//    아무 글자도 더 찍지 않는다(셸 프롬프트가 이미 돌아와 있다).
//  - 사람이 그대로 칠 명령은 백틱으로 싸지 않고, 설명 줄 아래에 따로 들여 쓴 한 줄로 싣는다(어디에 치는지는 설명 줄이 말한다).
// 화면 문구의 정본은 src/board/index.html의 I18N이다 — 여기 TEXT의 같은 이름 열쇠는 그 글자 그대로다(test/setup.test.mjs가 대조한다).
import { execFile, execFileSync, spawn } from 'node:child_process'
import { createReadStream, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { ReadStream as TtyReadStream, WriteStream as TtyWriteStream } from 'node:tty'
import { detect, evaluate, remoteWhy, renameRetry } from './autoconf.mjs'
import { configDirOf, herdrDirs, stateDirOf } from './paths.mjs'
import { commandFor } from './platform.mjs'
import { parseSessionJson, parseSessionTable } from './runtime/herdr.mjs'
import { linkSupported } from './runtime/ovis.mjs'
import { TEXT_SETTINGS, validTextSetting } from './settings.mjs'
import { which } from '../scripts/doctor.mjs'
import { renderBlocks, runMenu, uiCols, uiMode, uiSymbols } from './tui.mjs'

export const SETUP_FILE = 'setup.json'
export const SETUP_VERSION = 1
// 묻는 항목 = 보드 첫 실행 안내의 항목(src/board/server.mjs FIRST_RUN_KEYS와 같아야 한다 — 시험이 대조한다).
export const SETUP_KEYS = ['click_target', 'front_app', 'core_target', 'agent_cmd']
// 다시 설치하는 명령에 쓰는 GitHub 약칭(README의 설치 명령과 같다).
export const INSTALL_SOURCE = 'fivetaku/whosup'
export const DEFAULT_TIMEOUT_S = 120
export const MAX_TIMEOUT_S = 3600   // 이보다 큰 값은 자른다: setTimeout은 2^31-1 ms를 넘으면 1 ms로 바뀐다(셋업 전체가 건너뛰어진다)
export const MAX_TRIES = 3
const FALLBACK_ID = 'fivetaku.whosup'

// ── 언어: WHOSUP_LANG(ko|en) > 로캘(LC_ALL > LC_MESSAGES > LANG)이 ko로 시작 > 영어 ──
export function pickLang(env = process.env) {
  const forced = String(env.WHOSUP_LANG || '').toLowerCase()
  if (forced === 'ko' || forced === 'en') return forced
  const loc = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((v) => v !== undefined && v !== '') || ''
  return loc.toLowerCase().startsWith('ko') ? 'ko' : 'en'
}

// 같은 이름 열쇠(env*·click*·ch*·app*·cmdLabel)는 index.html I18N의 글자 그대로. 그 아래는 터미널 첫 실행 안내만의 문구.
// 명령을 싣는 문구는 "어디에 치는지"까지만 말하고 ':'로 끝난다 — 명령 자체는 closingLines·updatedLines가 다음 줄에 들여 써 붙인다.
export const TEXT = {
  ko: {
    envTerm: '터미널 앱', envApp: 'Herdr 앱',
    envTermDef: (os) => os === 'win32' ? 'PowerShell(기본)' : os === 'darwin' ? 'Terminal(기본)' : '창 올리기 없음',
    clickLabel: '세션을 여는 곳', clickTerminal: '터미널 창', clickWeb: '웹 터미널', clickBoth: '둘 다',
    chClickOnly: '웹 터미널(ovis 등)을 감지하면 여기에 선택지가 더 생깁니다.', chClickWeb: (l) => `감지한 웹 터미널: ${l}`,
    chShowing: '지금 herdr를 띄운 앱', chRaiseOnly: '떠 있는 창만 올림', chAutoNote: '그때그때 herdr를 띄운 앱', chNotFound: '감지되지 않음',
    chCore: 'Herdr 앱 세션을 여는 곳', chCoreApp: 'Herdr 앱', chCoreHint: 'Herdr 앱에 있는 세션을 누르면 어디서 열지 정합니다. Herdr 앱을 골라도 앱 창이 없으면 터미널 창에서 엽니다.',
    appLabel: '터미널 앱', appAuto: '자동', cmdLabel: '세션을 열 때 실행할 명령',
    // 자기 herdr-core 코어를 띄우는 앱의 세션(보기와 앱 창 올리기만). app = 그 앱 이름(못 찾았으면 비어 있다 — 코어 이름으로 말한다).
    envCoreSeen: (name, app, show) => app ? (show === 'tab' ? `${app}의 세션도 보드에 보입니다. 누르면 그 세션이 브라우저 탭으로 열립니다.` : `${app}의 세션도 보드에 보입니다. 누르면 ${app} 창이 앞으로 옵니다.`) : `herdr-core "${name}"의 세션도 보드에 보입니다.`,
    // 터미널 첫 실행 안내
    title: 'whosup 첫 실행 안내',
    checking: '이 컴퓨터를 확인하는 중…',
    detected: '감지한 것',
    sumWeb: (port, desk) => `웹 터미널 ovis ${port}(데스크 ${desk})`, sumCore: (who) => `${who}의 세션`, agents: '에이전트',
    detectFail: '이 컴퓨터를 확인하지 못해 기본값으로 시작합니다. 보드를 처음 열 때 첫 실행 안내가 묻습니다.',
    // 질문마다 "이것이 무엇을 정하는지" 한 줄(제목 옆에 붙는다). 선택지 덧붙임 두 개는 터미널에서만 풀어 쓴다.
    askClick: '보드에서 세션을 누르면 그 세션을 어디에서 열지',
    askApp: '세션을 눌렀을 때 앞으로 올릴 앱',
    askCore: 'Herdr 앱에 있는 세션을 누르면 어디에서 열지',
    askCmd: '새 세션에서 띄울 에이전트',
    autoNote: '정해 두지 않음: 그때그때 herdr가 떠 있는 앱',
    raiseNote: '떠 있는 창만 앞으로 올림, 새 창은 못 엶',
    intro: 'Enter만 치면 * 표시한 값을 그대로 씁니다. 번호를 치면 그 값으로 정합니다.',
    // 다시 묻는 실행(WHOSUP_SETUP·--force·손 실행): Enter는 '자동 감지로 되돌리기'가 아니라 '지금 설정 그대로'다(전에 정한 값은 DB에 남는다).
    introAgain: 'Enter만 치면 그 항목은 지금 설정 그대로 둡니다(전에 직접 정한 값은 남습니다).',
    introAgainStar: '*는 직접 정한 값이 없을 때 쓰는 값입니다. 번호를 치면 그 값으로 정합니다.',
    waitNote: (s) => `${s}초 동안 답이 없으면 자동으로 넘어갑니다.`,
    // 물을 것이 없던 첫 설치: 한 줄로 말한다("고를 것이 없습니다" 바로 아래에 "첫 실행 안내가 묻습니다"가 오면 서로 어긋난다 — 보드는 그 값을 보여 준다).
    noQuestions: '지금은 고를 것이 없어 자동 감지 값을 그대로 씁니다. 보드를 처음 열 때 첫 실행 안내가 그 값을 한 번 보여 줍니다.',
    noQuestionsAgain: '고를 것이 없습니다. 설정은 지금 그대로입니다.',
    prompt: (n) => `번호를 입력하세요 (Enter만 치면 ${n}번): `,
    promptAgain: () => '번호를 입력하세요 (Enter만 치면 지금 설정 그대로): ',
    bad: (n) => `1부터 ${n}까지의 번호를 입력해 주세요.`,
    giveUp: '* 표시한 값을 그대로 씁니다.',
    giveUpAgain: '지금 설정 그대로 둡니다.',
    timedOut: (s) => `${s}초 동안 입력이 없어 남은 항목은 자동 감지 값을 그대로 씁니다.`,
    timedOutAgain: (s) => `${s}초 동안 입력이 없어 남은 항목은 지금 설정 그대로 둡니다.`,
    askLater: '보드를 처음 열 때 첫 실행 안내가 묻습니다.',
    interrupted: '첫 실행 안내를 건너뜁니다(저장한 것 없음).',
    interruptedAgain: '질문을 건너뜁니다(바꾼 것 없음). 설정은 지금 그대로입니다.',
    stopped: '그만둡니다(저장한 것 없음).',
    saved: (l) => `저장했습니다: ${l}`,
    savedNone: '직접 정한 값이 없습니다. 보드를 처음 열 때 첫 실행 안내가 한 번 묻습니다.',
    savedNoneDone: '직접 정한 값이 없어 자동 감지 값을 계속 따릅니다. 보드 설정에서 언제든 바꿀 수 있습니다.',
    savedNoneAgain: '바꾼 것이 없습니다. 설정은 지금 그대로입니다.',
    saveFail: (m) => `고른 값을 저장하지 못했습니다(${m}). 보드를 처음 열 때 첫 실행 안내가 묻습니다.`,
    // 마무리 문구
    starting: '보드가 지금 뜹니다:',
    portNote: '(사용 중이면 다음 포트)',
    browserOpens: '브라우저가 열립니다.',
    browserManual: '여기서는 브라우저가 저절로 열리지 않습니다. 이 컴퓨터에서 위 주소를 여세요.',
    browserRemote: (p) => `다른 기기에서 보려면 먼저 포트를 넘깁니다: ssh -L ${p}:127.0.0.1:${p} <host>`,
    boardRunning: '보드는 이미 실행 중입니다:',
    boardAt: '보드 주소:',
    picksUp: '고른 값은 재시작 없이 반영됩니다.',
    picksUpRestart: '고른 값은 보드를 다시 시작하면 들어갑니다.',
    herdrOff: 'herdr가 꺼져 있습니다.',
    typeHere: '이 터미널에 아래를 치고 Enter를 누르세요:',
    thenOpens: (url) => `herdr를 켤 때마다 보드가 같이 뜨고 브라우저에서 열립니다: ${url}`,
    thenManual: (url) => `herdr를 켤 때마다 보드가 같이 뜹니다. 여기서는 브라우저가 저절로 열리지 않으니 이 주소를 여세요: ${url}`,
    herdrUnknown: 'herdr가 켜져 있는지 확인하지 못했습니다.',
    ifOff: '꺼져 있으면 이 터미널에 아래를 치고 Enter를 누르세요:',
    ifOn: '켜져 있으면 herdr 안의 터미널에 아래를 치세요:',
    spawnFailed: '여기서 보드를 띄우지 못했습니다.',
    nextStart: '보드는 herdr를 다음에 켤 때 같이 뜹니다:',
    always: '이후로는 herdr를 켤 때 보드가 같이 뜹니다.',
    change: '바꾸려면 보드의 설정에서 바꿉니다.',
    byHand: (inside) => `손으로 띄우려면 ${inside ? 'herdr 안의 터미널' : '터미널'}에 아래를 치세요:`,
    updated: 'whosup을 업데이트했습니다. 설정은 그대로입니다.',
    updatedOld: '실행 중인 보드는 다시 시작해야 새 버전이 됩니다.',
    updatedRestart: (inside) => `다시 시작하려면 ${inside ? 'herdr 안의 터미널(herdr가 꺼져 있으면 먼저 herdr를 켭니다)' : '터미널'}에 아래 두 줄을 치세요:`,
    updatedStarts: '보드가 꺼져 있어 지금 띄웁니다:',
    updatedAgain: '다시 물어보게 하려면 터미널에 아래를 치세요(보드의 설정에서 "첫 실행 안내 다시 보기"를 눌러도 됩니다):',
    updatedAgainWin: '다시 물어보게 하려면 보드의 설정에서 "첫 실행 안내 다시 보기"를 누르거나, whosup 플러그인 폴더에서 아래를 치세요:',
    notRegistered: 'whosup이 herdr에 플러그인으로 등록돼 있지 않아 herdr가 보드를 띄워 주지 않습니다.',
    npmHow: '직접 띄우려면 whosup 폴더에서 아래를 치세요:',
    regUnknown: 'whosup이 herdr에 플러그인으로 등록돼 있는지 확인하지 못했습니다.',
    regIfYes: (inside) => `등록돼 있으면 herdr를 켤 때 보드가 같이 뜹니다. 지금 띄우려면 ${inside ? 'herdr 안의 터미널' : '터미널'}에 아래를 치세요:`,
    regIfNo: 'whosup 폴더에서 직접 띄워 쓰고 있으면 그 폴더에서 아래를 치세요:',
    // 단독 설치(herdr 없이 — install.sh의 standalone 길): 설치 요약 · `whosup setup`의 마무리 문구 · whosup 명령이 찍는 줄
    saTitle: 'whosup 설치 요약',
    saInstalled: 'herdr 없이 단독으로 설치했습니다.',
    saUpdated: 'whosup을 새 버전으로 바꿨습니다. 설정과 기록은 그대로입니다.',
    saApp: (p) => `프로그램: ${p}`,
    saBoardUp: '보드가 켜져 있습니다:',
    saBoardDown: '보드는 꺼져 있습니다. 켜려면 터미널에 아래를 치세요:',
    saBoardFailed: (log) => `보드를 켜지 못했습니다(기록: ${log}). 다시 켜려면 터미널에 아래를 치세요:`,
    saLoginOn: '로그인할 때 자동으로 켜집니다. 끄려면 터미널에 아래를 치세요:',
    saLoginOnLater: '로그인할 때 자동으로 켜지게 등록했지만 지금 바로 불러 두지는 못했습니다. 다음 로그인부터 켜집니다. 끄려면 터미널에 아래를 치세요:',
    saLoadLater: '로그인할 때 자동으로 켜지게 등록했지만 지금 바로 불러 두지는 못했습니다. 다음 로그인부터 켜집니다.',
    saLoginOff: '로그인할 때 자동으로 켜지지는 않습니다. 그렇게 하려면 터미널에 아래를 치세요:',
    saLoginFailed: '로그인할 때 자동으로 켜지게 등록하지 못했습니다. 다시 등록하려면 터미널에 아래를 치세요:',
    saLoginNone: '이 컴퓨터에는 사용자 서비스 관리자(systemd --user)가 없어 로그인할 때 자동으로 켜지지 않습니다. 컴퓨터를 다시 켠 뒤에는 터미널에 아래를 치세요:',
    saCommands: '보드 켜기·끄기, 새 버전으로 바꾸기, 지우기는 whosup 명령으로 합니다(start · stop · status · update · uninstall). 전체 목록은 터미널에 아래를 치세요:',
    saLauncherForeign: (f) => `${f} 파일이 이미 있고 whosup이 만든 것이 아니어서 그대로 두었습니다. 아래의 긴 명령을 쓰세요.`,
    saLauncherFailed: (f) => `${f} 파일을 만들지 못했습니다. 아래의 긴 명령을 쓰세요.`,
    saPathHint: (d) => `${d} 폴더가 PATH에 없어 명령을 전체 경로로 적었습니다. PATH에 넣으면 whosup 만 쳐도 됩니다.`,
    uiPathHint: (d) => `${d} 폴더가 PATH에 없어 위에서는 명령을 전체 경로로 적었습니다(그대로 치면 됩니다). 새로 여는 터미널부터 whosup만 쳐도 되게 하려면 아래를 한 번 치세요:`,
    saShadowed: (o) => `PATH에서 whosup 은 다른 프로그램(${o})을 가리켜 명령을 전체 경로로 적었습니다.`,
    saWindows: '단독 설치는 Windows를 지원하지 않습니다. Windows에서는 herdr 플러그인으로 설치하세요:',
    saAutoOn: (f) => `로그인할 때 자동으로 켜기: 켜짐 (${f})`,
    saAutoOnLater: (f) => `로그인할 때 자동으로 켜기: 켜짐, 다음 로그인부터 (${f})`,
    saAutoOff: '로그인할 때 자동으로 켜기: 꺼짐',
    saAutoOffFailed: (l) => `로그인할 때 자동으로 켜기를 끄지 못했습니다. 이 파일이 남아 있습니다: ${l}. 직접 지운 뒤 다시 실행하세요.`,
    saAutoStillLoaded: (n) => `로그인할 때 자동으로 켜기를 끄지 못했습니다. 서비스 관리자에 ${n} 항목이 아직 살아 있습니다. 터미널에 아래를 쳐서 직접 내린 뒤 다시 실행하세요:`,
    saServiceStillOn: (n) => `사용자 서비스(${n})를 멈추지 못했습니다. 이대로 두면 보드가 다시 켜지지 않습니다. 터미널에 아래를 쳐서 직접 멈추세요:`,
    saLocked: (f) => `whosup을 설치하거나 지우는 다른 작업이 진행 중입니다(잠금 ${f}). 그 작업이 끝난 뒤 다시 실행하세요. 바꾼 것은 없습니다.`,
    saAutoNone: '로그인할 때 자동으로 켜기: 쓸 수 없음(이 컴퓨터에 사용자 서비스 관리자 systemd --user 가 없습니다)',
    saAutoFailed: (why) => `로그인할 때 자동으로 켜지게 등록하지 못했습니다${why ? `(${why})` : ''}.`,
    saLauncherKept: (f) => `${f} 파일은 whosup이 만든 것이 아니어서 그대로 두었습니다.`,
    saStillRunning: '보드를 끄지 못해 아무것도 지우지 않았습니다.',
    saUninstallHalted: '로그인할 때 없는 프로그램을 부르지 않게, 프로그램은 지우지 않았습니다.',
    saUninstalled: 'whosup을 지웠습니다.',
    saUninstallPartly: 'whosup을 다 지우지 못했습니다.',
    saLeft: (l) => `지우지 못한 것: ${l}. 직접 지우세요.`,
    saForeignKept: (l) => `whosup 설치기가 만든 폴더가 아니어서 그대로 둔 것: ${l}`,
    saRemoved: (l) => `지운 것: ${l}`,
    saKept: (l) => `남겨 둔 것(설정과 기록): ${l}`,
    saKeptHow: '이것까지 지우려면 그 폴더를 직접 지우세요.',
    saNotInstalled: '단독 설치된 whosup이 없습니다.',
    // 환경 고르기(install.sh — 아무것도 없는 기계에서 설치기가 깔아 준 앱). envNames의 열쇠 = 환경 값(install.sh의 WHOSUP_ENV · 설치 기록의 env_installed).
    // 한국어 이름은 받침으로 끝난다("앱") — 조사를 붙여 쓴다.
    envNames: { 'herdr-app': 'Herdr 앱', 'ovis-app': 'Ovis 앱' },
    saEnvInstalled: (name, p) => `${name}도 함께 설치했습니다${p ? `(${p})` : ''}.`,
    saEnvNext: (name) => `다음에 할 일: ${name}을 한 번 여세요(한 번 열어야 그 앱의 세션이 보드에 보입니다). 그다음 보드에서 새 세션을 엽니다.`,
    saEnvNextOpened: (name) => `다음에 할 일: ${name}을 지금 엽니다. 앱의 첫 화면을 마친 뒤 보드에서 새 세션을 여세요.`,
    saEnvKept: (name, p) => `${name}은 whosup과 함께 설치한 것으로, 지우지 않았습니다(whosup은 앱을 지우지 않습니다). 지우려면 그 앱을 끝낸 뒤 ${p ? `${p} 항목을` : '그 앱을'} 직접 지우세요.`,
    saEnvKeptFolders: (l) => `그 앱이 두는 폴더도 그대로 남겨 두었습니다: ${l}`,
    // rich 화면(src/tui.mjs — 사람이 터미널 앞에 있을 때)에만 쓰는 문구. plain 화면은 위의 문구를 글자 그대로 쓴다.
    // 첫 실행 안내: 진행 줄 · 질문 제목(화살표 메뉴) · 감지한 것이 하나도 없을 때의 ✓ 줄
    uiChecking: '이 컴퓨터를 확인하는 중', uiChecked: '이 컴퓨터를 확인했습니다',
    uiAskClick: '보드에서 세션을 누르면 어디에서 열까요?', uiAskApp: '세션을 눌렀을 때 어느 앱을 앞으로 올릴까요?',
    uiAskCore: 'Herdr 앱에 있는 세션을 누르면 어디에서 열까요?', uiAskCmd: '새 세션에서 어떤 에이전트를 띄울까요?',
    // 설치 요약: ✓ 끝났다 → 다음에 할 일 → 설치한 것 → 알아 둘 것 → 명령 → 설정 바꾸는 곳
    uiDone: 'whosup 설치를 마쳤습니다', uiUpdated: 'whosup을 새 버전으로 바꿨습니다(설정과 기록은 그대로)',
    uiNext: '다음에 할 일', uiInstalled: '설치한 것', uiNotes: '알아 둘 것', uiCommands: '명령', uiFoot: '설정은 보드의 설정 화면에서 바꿉니다.',
    uiEnvOpened: (name) => `${name}이 열렸습니다. 앱의 첫 화면을 마치세요.`,
    uiEnvOpen: (name) => `${name}을 한 번 여세요. 한 번 열어야 그 앱의 세션이 보드에 보입니다.`,
    uiBoardOpened: '브라우저에 열린 보드에서 새 세션을 여세요.',
    uiBoardOpen: '이 컴퓨터의 브라우저에서 아래 주소를 열고, 보드에서 새 세션을 여세요.',
    uiBoardDown: '보드가 꺼져 있습니다. 터미널에 아래를 쳐서 켜세요.',
    uiBoardFailed: (log) => `보드를 켜지 못했습니다(기록: ${log}). 터미널에 아래를 쳐서 다시 켜 보세요.`,
    uiRemote: '다른 기기에서 보려면 먼저 포트를 넘기세요:',
    uiStandalone: 'herdr 없이 단독', uiBoard: '보드', uiBoardOff: '꺼져 있음',
    uiLoginOn: '로그인할 때 자동으로 켜집니다', uiLoginLater: '다음 로그인부터 자동으로 켜집니다',
    uiLoginOff: '로그인할 때 저절로 켜지지 않습니다', uiLoginNone: '로그인할 때 저절로 켜지지 않습니다(systemd --user 없음)',
    uiHere: '설치함',
    uiCmdHelp: '전체 명령 보기', uiCmdAutoOff: '로그인할 때 켜지 않게 하기', uiCmdAutoOn: '로그인할 때 자동으로 켜기',
    saHelp: (c) => [
      'whosup — 에이전트 세션 보드 (단독 설치)',
      '',
      `  ${c} start                     보드를 켭니다`,
      `  ${c} stop                      보드를 끕니다`,
      `  ${c} status                    보드가 켜져 있는지, 주소, 로그인할 때 자동으로 켜는지`,
      `  ${c} open                      브라우저에서 보드를 엽니다`,
      `  ${c} setup                     첫 실행 안내를 터미널에서 다시 합니다`,
      `  ${c} update                    새 버전으로 바꿉니다(설정과 기록은 그대로, 켜져 있었으면 다시 켭니다)`,
      `  ${c} uninstall [--purge]       지웁니다(설정과 기록은 --purge 일 때만 지웁니다)`,
      `  ${c} autostart on|off|status   로그인할 때 자동으로 켜기`,
    ],
  },
  en: {
    envTerm: 'terminal app', envApp: 'Herdr app',
    envTermDef: (os) => os === 'win32' ? 'PowerShell (default)' : os === 'darwin' ? 'Terminal (default)' : 'no window raising',
    clickLabel: 'Sessions open in', clickTerminal: 'terminal window', clickWeb: 'web terminal', clickBoth: 'both',
    chClickOnly: 'More choices show up here once a web terminal (ovis and the like) is detected.', chClickWeb: (l) => `Detected web terminal: ${l}`,
    chShowing: 'showing herdr now', chRaiseOnly: 'raises open windows only', chAutoNote: 'whichever app shows herdr', chNotFound: 'not detected',
    chCore: 'Herdr app sessions open in', chCoreApp: 'Herdr app', chCoreHint: 'Where a click on a session of the Herdr app opens it. With Herdr app chosen and no app window open, it opens in a terminal window.',
    appLabel: 'Terminal app', appAuto: 'auto', cmdLabel: 'Command to run in a new session',
    // sessions of an app that runs a herdr-core core of its own (viewing and raising the app window only). app = its name ('' when not found: the core is named instead).
    envCoreSeen: (name, app, show) => app ? (show === 'tab' ? `Sessions of ${app} show on the board too. A click opens the session in a browser tab.` : `Sessions of ${app} show on the board too. A click brings the ${app} window to the front.`) : `Sessions of herdr-core "${name}" show on the board too.`,
    // terminal first-run setup
    title: 'whosup first-run setup',
    checking: 'checking this machine…',
    detected: 'Detected',
    sumWeb: (port, desk) => `web terminal ovis ${port} (desk ${desk})`, sumCore: (who) => `sessions of ${who}`, agents: 'agents',
    detectFail: 'Could not check this machine, so whosup starts with its defaults. The board asks on first open.',
    // one line per question saying what it decides (shown next to the title). The two option notes are spelled out for the terminal only.
    askClick: 'where a click on a session in the board opens it',
    askApp: 'the app brought to the front when you click a session',
    askCore: 'where a click on a Herdr app session opens it',
    askCmd: 'the agent a new session starts',
    autoNote: 'not fixed: whichever app is showing herdr at that moment',
    raiseNote: 'brings an open window forward, cannot open a new one',
    intro: 'Enter keeps the value marked *. A number sets your own choice.',
    // asking again (WHOSUP_SETUP · --force · run by hand): Enter leaves the item as it is set now, it does not go back to auto-detect.
    introAgain: 'Enter leaves an item as it is set now (a value you set earlier stays).',
    introAgainStar: '* marks the value used when you set none. A number sets your own choice.',
    waitNote: (s) => `With no answer for ${s} second${s === 1 ? '' : 's'}, setup moves on by itself.`,
    noQuestions: 'Nothing to choose here: the auto-detected values are used. The board shows them once on first open.',
    noQuestionsAgain: 'Nothing to choose here: your settings stay as they are.',
    prompt: (n) => `Type a number, or press Enter for ${n}: `,
    promptAgain: () => 'Type a number, or press Enter to leave it as it is: ',
    bad: (n) => `Please type a number from 1 to ${n}.`,
    giveUp: 'Keeping the value marked *.',
    giveUpAgain: 'Leaving it as it is.',
    timedOut: (s) => `No input for ${s} second${s === 1 ? '' : 's'}: the remaining items keep their auto-detected values.`,
    timedOutAgain: (s) => `No input for ${s} second${s === 1 ? '' : 's'}: the remaining items stay as they are.`,
    askLater: 'The board asks on first open.',
    interrupted: 'Setup skipped: nothing saved.',
    interruptedAgain: 'Questions skipped: nothing changed, your settings stay as they are.',
    stopped: 'Stopped: nothing saved.',
    saved: (l) => `Saved: ${l}`,
    savedNone: 'Nothing set by hand: the board asks once on first open.',
    savedNoneDone: 'Nothing set by hand: auto-detect keeps applying. Change it in the board settings.',
    savedNoneAgain: 'Nothing changed: your settings stay as they are.',
    saveFail: (m) => `Could not save your choices (${m}). The board asks on first open.`,
    // closing lines
    starting: 'The board is starting now:',
    portNote: '(next port if taken)',
    browserOpens: 'Your browser opens it.',
    browserManual: 'No browser opens by itself here. Open that address on this computer.',
    browserRemote: (p) => `From another device, forward the port first: ssh -L ${p}:127.0.0.1:${p} <host>`,
    boardRunning: 'The board is already running:',
    boardAt: 'The board:',
    picksUp: 'It picks up your choices without a restart.',
    picksUpRestart: 'Your choices take effect when the board restarts.',
    herdrOff: 'herdr is not running right now.',
    typeHere: 'Type this in this terminal and press Enter:',
    thenOpens: (url) => `The board starts with herdr every time. Your browser opens ${url}`,
    thenManual: (url) => `The board starts with herdr every time. No browser opens by itself here, so open ${url}`,
    herdrUnknown: 'Could not check whether herdr is running.',
    ifOff: 'If it is not running, type this in this terminal and press Enter:',
    ifOn: 'If it is running, type this in a terminal inside herdr:',
    spawnFailed: 'Could not start the board from here.',
    nextStart: 'The board starts the next time herdr starts:',
    always: 'From now on the board starts whenever herdr starts.',
    change: 'To change any of this, use settings in the board.',
    byHand: (inside) => `To start it by hand, type this in ${inside ? 'a terminal inside herdr' : 'a terminal'}:`,
    updated: 'whosup updated. Your settings are kept.',
    updatedOld: 'A running board keeps the old version until it restarts.',
    updatedRestart: (inside) => `To restart it, type these two lines in ${inside ? 'a terminal inside herdr (start herdr first if it is not running)' : 'a terminal'}:`,
    updatedStarts: 'The board was not running, so it starts now:',
    updatedAgain: 'To be asked again, type this in a terminal (or use "open first-run setup again" in the board\'s settings):',
    updatedAgainWin: 'To be asked again, use "open first-run setup again" in the board\'s settings, or type this in the whosup plugin folder:',
    notRegistered: 'whosup is not registered with herdr as a plugin, so herdr does not start the board.',
    npmHow: 'To start it yourself, type this in the whosup folder:',
    regUnknown: 'Could not check whether whosup is registered with herdr as a plugin.',
    regIfYes: (inside) => `If it is, the board starts whenever herdr starts. To start it now, type this in ${inside ? 'a terminal inside herdr' : 'a terminal'}:`,
    regIfNo: 'If you run whosup from its own folder, type this in that folder:',
    // standalone install (no herdr — the standalone path of install.sh): install summary · closing lines of `whosup setup` · lines of the whosup command
    saTitle: 'whosup install summary',
    saInstalled: 'Installed on its own, without herdr (standalone).',
    saUpdated: 'whosup updated to the new version. Your settings and history are kept.',
    saApp: (p) => `Program: ${p}`,
    saBoardUp: 'The board is running:',
    saBoardDown: 'The board is not running. To start it, type this in a terminal:',
    saBoardFailed: (log) => `The board did not start (log: ${log}). To start it again, type this in a terminal:`,
    saLoginOn: 'It starts by itself when you log in. To turn that off, type this in a terminal:',
    saLoginOnLater: 'It is set to start when you log in, but could not be loaded right now, so that begins at your next login. To turn that off, type this in a terminal:',
    saLoadLater: 'It is set to start when you log in, but could not be loaded right now, so that begins at your next login.',
    saLoginOff: 'It does not start by itself when you log in. To make it do so, type this in a terminal:',
    saLoginFailed: 'Could not set it to start when you log in. To try that again, type this in a terminal:',
    saLoginNone: 'This computer has no user service manager (systemd --user), so the board does not start by itself when you log in. After a restart, type this in a terminal:',
    saCommands: 'Start, stop, update and remove whosup with the whosup command (start · stop · status · update · uninstall). For the full list, type this in a terminal:',
    saLauncherForeign: (f) => `${f} is already there and is not whosup's, so it was left as it is. Use the long command below.`,
    saLauncherFailed: (f) => `Could not write ${f}. Use the long command below.`,
    saPathHint: (d) => `${d} is not on your PATH, so the command is spelled with its full path. Put it on your PATH to type just whosup.`,
    uiPathHint: (d) => `${d} is not on your PATH, so the commands above are written with their full path (they run as typed). To type just whosup in terminals you open from now on, type this once:`,
    saShadowed: (o) => `On your PATH, whosup is another program (${o}), so the command is spelled with its full path.`,
    saWindows: 'The standalone install does not support Windows. On Windows, install the herdr plugin:',
    saAutoOn: (f) => `Start at login: on (${f})`,
    saAutoOnLater: (f) => `Start at login: on, from your next login (${f})`,
    saAutoOff: 'Start at login: off',
    saAutoOffFailed: (l) => `Could not turn off start at login. This file is still there: ${l}. Remove it yourself, then run this again.`,
    saAutoStillLoaded: (n) => `Could not turn off start at login: the service manager still has ${n}. Turn it off yourself by typing this in a terminal, then run this again:`,
    saServiceStillOn: (n) => `Could not stop the user service (${n}). While it stays active the board does not start again. Stop it yourself by typing this in a terminal:`,
    saLocked: (f) => `Another whosup install or removal is running here (the lock ${f} is held). Wait for it to end, then run this again. Nothing was changed.`,
    saAutoNone: 'Start at login: not available (this computer has no user service manager, systemd --user)',
    saAutoFailed: (why) => `Could not set whosup to start at login${why ? ` (${why})` : ''}.`,
    saLauncherKept: (f) => `${f} is not whosup's, so it was left as it is.`,
    saStillRunning: 'Could not stop the board, so nothing was removed.',
    saUninstallHalted: 'The program was not removed, so that your login does not call a program that is gone.',
    saUninstalled: 'whosup is uninstalled.',
    saUninstallPartly: 'whosup was not fully removed.',
    saLeft: (l) => `Could not remove: ${l}. Remove it yourself.`,
    saForeignKept: (l) => `Left as it is, because whosup's installer did not put it there: ${l}`,
    saRemoved: (l) => `Removed: ${l}`,
    saKept: (l) => `Kept (your settings and history): ${l}`,
    saKeptHow: 'To remove those too, delete that folder yourself.',
    saNotInstalled: 'There is no standalone whosup install here.',
    // choosing an environment (install.sh: the app the installer put in on a machine that had nothing). Keys of envNames = the environment values
    // (WHOSUP_ENV in install.sh, env_installed in the install record).
    envNames: { 'herdr-app': 'the Herdr app', 'ovis-app': 'the Ovis app' },
    saEnvInstalled: (name, p) => `Installed too: ${name}${p ? ` (${p})` : ''}.`,
    saEnvNext: (name) => `Next: open ${name} once (its sessions show on the board only after it has been opened). Then start a new session from the board.`,
    saEnvNextOpened: (name) => `Next: ${name} is opening now. Finish its first screens, then start a new session from the board.`,
    saEnvKept: (name, p) => `whosup does not remove apps: ${name}, installed together with whosup, was left in place. To remove it, quit it and delete ${p || 'the app'} yourself.`,
    saEnvKeptFolders: (l) => `Left as they are, the folders that app keeps: ${l}`,
    // only for the rich screen (src/tui.mjs — a person at a terminal). The plain screen uses the lines above as they are.
    // first-run setup: progress line · question titles (arrow-key menu) · the check line when nothing was detected
    uiChecking: 'checking this machine', uiChecked: 'checked this machine',
    uiAskClick: 'Where should a click on a session in the board open it?', uiAskApp: 'Which app should come to the front when you click a session?',
    uiAskCore: 'Where should a click on a Herdr app session open it?', uiAskCmd: 'Which agent should a new session start?',
    // install summary: done → next → installed → good to know → commands → where settings change
    uiDone: 'whosup is installed', uiUpdated: 'whosup is updated (settings and history kept)',
    uiNext: 'Next', uiInstalled: 'Installed', uiNotes: 'Good to know', uiCommands: 'Commands', uiFoot: "Change settings in the board's settings.",
    uiEnvOpened: (name) => `${String(name).charAt(0).toUpperCase()}${String(name).slice(1)} is open now. Finish its first screens.`,
    uiEnvOpen: (name) => `Open ${name} once (its sessions show on the board only after it has been opened).`,
    uiBoardOpened: 'In the board that opened in your browser, start a new session.',
    uiBoardOpen: 'Open this address in a browser on this computer, then start a new session in the board.',
    uiBoardDown: 'The board is not running. Start it by typing this in a terminal:',
    uiBoardFailed: (log) => `The board did not start (log: ${log}). Try starting it again by typing this in a terminal:`,
    uiRemote: 'From another device, forward the port first:',
    uiStandalone: 'standalone, no herdr', uiBoard: 'board', uiBoardOff: 'not running',
    uiLoginOn: 'starts when you log in', uiLoginLater: 'starts at login, from your next login',
    uiLoginOff: 'does not start by itself when you log in', uiLoginNone: 'does not start by itself when you log in (no systemd --user)',
    uiHere: 'installed',
    uiCmdHelp: 'show all commands', uiCmdAutoOff: 'do not start at login', uiCmdAutoOn: 'start at login',
    saHelp: (c) => [
      'whosup — a board for your agent sessions (standalone install)',
      '',
      `  ${c} start                     start the board`,
      `  ${c} stop                      stop the board`,
      `  ${c} status                    whether the board is running, its address, and whether it starts at login`,
      `  ${c} open                      open the board in your browser`,
      `  ${c} setup                     go through first-run setup again, in the terminal`,
      `  ${c} update                    replace it with the new version (settings and history kept; restarted if it was running)`,
      `  ${c} uninstall [--purge]       remove it (settings and history only with --purge)`,
      `  ${c} autostart on|off|status   start the board when you log in`,
    ],
  },
}

// ── 건너뛰기 조건 ──
// CI: 질문도 자동 시작도 없음. WHOSUP_NO_SETUP=1: 질문 없이 통과(자동 시작은 그대로). WHOSUP_NO_AUTOSTART=1: 자동 시작만 끔.
// 스위치 판정은 한 가지다(CI·WHOSUP_NO_SETUP·WHOSUP_SETUP·WHOSUP_NO_AUTOSTART·WHOSUP_SETUP_CONSOLE):
// 없음·빈 값·0·false·no·off는 꺼짐, 그 밖의 값(1·true·yes …)은 켜짐. 대소문자와 앞뒤 공백은 보지 않는다.
export const envOn = (v) => v !== undefined && v !== null && !['', '0', 'false', 'no', 'off'].includes(String(v).trim().toLowerCase())
export function skipMode(env = process.env) {
  if (envOn(env.CI)) return { ask: false, autostart: false, why: 'CI' }
  const noSetup = envOn(env.WHOSUP_NO_SETUP)
  return { ask: !noSetup, autostart: !envOn(env.WHOSUP_NO_AUTOSTART), why: noSetup ? 'WHOSUP_NO_SETUP' : null }
}
export function timeoutMsOf(env = process.env) {
  const s = Number(env.WHOSUP_SETUP_TIMEOUT_S)
  return Math.round(Math.min(Number.isFinite(s) && s > 0 ? s : DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000)
}
// 화면에 적는 초: 1초 미만의 시간 제한도 '0초'라고 적지 않는다.
export const secondsOf = (ms) => Math.max(1, Math.round(ms / 1000))
// 전체 감시 타이머(scripts/setup.mjs): herdr는 build를 무기한 기다리므로, 질문마다의 시간 제한으로도 못 끝나면 이 시간 뒤에 끝낸다.
// 질문 수 × 질문 하나의 시간 제한 + 여유 2분. setTimeout이 받는 최댓값(2^31-1 ms)을 넘지 않는다(넘으면 1 ms로 바뀐다).
export const watchdogMsOf = (env = process.env) => Math.min(SETUP_KEYS.length * timeoutMsOf(env) + 120000, 2 ** 31 - 1)

// ── 지금 값과 출처(DB 없이): 환경변수(.env 포함) > 자동 감지 > 기본값. 서버 autoconfView의 chosen과 같은 모양 ──
export function chosenOf(result, env = {}) {
  const out = {}
  for (const k of SETUP_KEYS) {
    const spec = TEXT_SETTINGS[k]
    const e = env[spec.env], a = result?.values?.[k]
    if (e != null && validTextSetting(k, e)) out[k] = { value: e.trim(), origin: { source: 'env', name: spec.env } }
    else if (typeof a === 'string' && validTextSetting(k, a)) out[k] = { value: a.trim(), origin: { source: 'auto', reason: result.reasons?.[k] || 'detected' } }
    else out[k] = { value: spec.def, origin: { source: 'default' } }
  }
  return out
}

// ── 고를 줄: index.html의 choiceRows를 그대로 옮긴 것(같은 입력에 같은 줄 — test/setup.test.mjs가 화면 함수와 대조한다) ──
// 터미널 앱(front_app)은 지금 켜져 있는 herdr 데스크가 하나라도 있을 때만 묻는다: herdr가 없거나 꺼져 있으면 올릴 터미널 창이 아직 없다
//   (오비스 앱만·Herdr 앱만 쓰는 설치, herdr를 방금 깐 설치). 데스크가 생긴 뒤에는 보드가 그때 띄운 앱을 자동 감지하고, 설정에서 바꿀 수 있다.
// Herdr 앱 세션을 여는 곳(core_target)은 herdr-app 으로 보낼 수 있는 코어(Herdr 앱 코어)가 있을 때만 묻는다: 보기 전용 앱의 코어
//   (summary.cores — 자기 코어를 띄우는 앱)만 있을 때는 묻지 않는다.
const deskOn = (s) => Boolean(s.herdr?.sessions?.length)
const appCoreOn = (s) => Boolean(s.herdr_app?.found || (s.herdr_core?.running && !s.herdr_core?.view_only))
// firstRun = 첫 실행 안내의 줄(보드의 choiceRows와 같은 규칙): 선택지가 하나뿐인 줄은 싣지 않는다. '자동'(값 '')은 세지 않는다(questionsOf와 같다).
export function setupRows(view, T, { firstRun = false } = {}) {
  const s = view?.summary || {}, o = s.options || {}, ch = view?.chosen || {}
  const cur = (k) => String(ch[k]?.value ?? '')
  const rows = []
  const web = (Array.isArray(s.ovis) ? s.ovis : []).filter((x) => x.confirmed && x.session)
  const click = [{ value: 'terminal', label: T.clickTerminal }]
  if (web.length) click.push({ value: 'web', label: T.clickWeb }, { value: 'both', label: T.clickBoth })
  rows.push({ key: 'click_target', label: T.clickLabel, hint: web.length ? T.chClickWeb(web.map((x) => `ovis ${x.port} ↔ ${x.session}`).join(', ')) : T.chClickOnly, options: click, value: click.some((x) => x.value === cur('click_target')) ? cur('click_target') : 'terminal' })
  const apps = Array.isArray(o.terminal_apps) ? o.terminal_apps : []
  if (apps.length && deskOn(s)) {
    const opts = apps.map((a) => ({ value: a.name, label: a.name, note: a.showing ? T.chShowing : a.opens_new ? '' : T.chRaiseOnly }))
    const v = cur('front_app')
    const same = (x) => x.value.toLowerCase() === v.toLowerCase()
    if (v && v.toLowerCase() !== 'off' && !opts.some(same)) opts.push({ value: v, label: v })
    opts.push({ value: '', label: T.appAuto, note: T.chAutoNote })
    rows.push({ key: 'front_app', label: T.appLabel, hint: '', options: opts, value: (v && opts.find(same)?.value) || '' })
  }
  if (appCoreOn(s)) rows.push({ key: 'core_target', label: T.chCore, hint: T.chCoreHint, options: [{ value: 'app', label: T.chCoreApp }, { value: 'terminal', label: T.clickTerminal }], value: cur('core_target') === 'terminal' ? 'terminal' : 'app' })
  const agents = Array.isArray(o.agents) ? o.agents : []
  const cmd = cur('agent_cmd')
  const cmds = agents.map((a) => ({ value: a, label: a }))
  if (cmd && !cmds.some((x) => x.value === cmd)) cmds.unshift({ value: cmd, label: cmd, note: ch.agent_cmd?.origin?.source === 'default' ? T.chNotFound : '' })
  if (cmds.length) rows.push({ key: 'agent_cmd', label: T.cmdLabel, hint: '', options: cmds, value: cmd || cmds[0].value })
  return firstRun ? rows.filter((r) => r.options.filter((o) => o.value !== '').length >= 2) : rows
}
// 물을 줄: 고를 것이 실제로 둘 이상인 줄만. '자동'(값 '')은 고를 것으로 세지 않는다 — 터미널 앱이 하나뿐이면 자동과 같은 뜻이다.
// T를 주면 터미널용으로 풀어 쓴다(보드와 같은 이름의 열쇠는 그대로 두고 터미널 전용 열쇠만 쓴다):
//   ask = 이 질문이 무엇을 정하는지 한 줄(제목 옆에 붙는다. 'Saved: …' 줄은 짧은 제목 label을 쓴다),
//   '자동' 선택지와 '떠 있는 창만 올림' 덧붙임은 뜻을 풀어 쓴 말로 바꾼다. 감지한 웹 터미널 목록은 위의 감지 요약에 있어 다시 싣지 않는다.
const ASK = { click_target: 'askClick', front_app: 'askApp', core_target: 'askCore', agent_cmd: 'askCmd' }
export function questionsOf(rows, T = null) {
  const noteOf = (r, o) => (!T ? o.note : r.key === 'front_app' && o.value === '' ? T.autoNote : o.note && o.note === T.chRaiseOnly ? T.raiseNote : o.note)
  return rows.filter((r) => SETUP_KEYS.includes(r.key) && r.options.filter((o) => o.value !== '').length >= 2)
    .map((r) => ({ key: r.key, label: r.label, ask: T ? T[ASK[r.key]] : '', options: r.options.map((o) => ({ ...o, note: noteOf(r, o) })), value: r.value, preset: Math.max(0, r.options.findIndex((o) => o.value === r.value)) + 1 }))
}

// ── 감지한 것 요약: 감지한 것만 사람 말로 싣는다 — 터미널 앱 · Herdr 앱 · <앱>의 세션 · 웹 터미널 ovis <포트>(데스크 <이름>) · 에이전트 ──
// <앱>의 세션 = 자기 코어를 띄우는 앱의 코어(summary.cores): 앱 이름을 못 찾았으면 코어 이름으로 말한다.
// 없는 것은 싣지 않는다('없음'·'꺼짐'을 늘어놓지 않는다). 데스크를 맞추지 못한 ovis와 코어 실행 여부 같은 속사정은 보드의 "감지한 환경"이 보여 준다.
// 돌려주는 것 = 화면 줄(너비에 맞춰 나눈다). 감지한 것이 하나도 없으면 빈 목록.
export function summaryLines(s, T, width = 68) {
  if (!s) return []
  const parts = []
  const term = s.terminal && s.terminal !== 'off' ? s.terminal : !s.terminal && s.desktop !== false && (s.os === 'darwin' || s.os === 'win32') ? T.envTermDef(s.os) : ''
  if (term) parts.push(`${T.envTerm} ${term}`)
  if (appCoreOn(s)) parts.push(T.envApp)
  for (const c of coresOf(s)) parts.push(T.sumCore(c.app || `herdr-core "${c.name}"`))
  for (const o of Array.isArray(s.ovis) ? s.ovis : []) if (o.confirmed && o.session) parts.push(T.sumWeb(o.port, o.session))
  if (s.options?.agents?.length) parts.push(`${T.agents} ${s.options.agents.join(', ')}`)
  const lines = []
  for (const p of parts) {
    if (lines.length && cols(`${lines.at(-1)} · ${p}`) <= width) lines[lines.length - 1] += ` · ${p}`
    else lines.push(p)
  }
  return lines
}

// 감지한 앱 코어(summary.cores)와 그 한 줄 안내("<앱>의 세션도 보드에 보입니다. 누르면 <앱> 창이 앞으로 옵니다") — 마무리 문구에 싣는다.
const coresOf = (s) => (Array.isArray(s?.cores) ? s.cores : []).filter((c) => c && typeof c.name === 'string')
// 웹 주소를 가진 앱 코어(web — 자기 서버로 코어를 보여 주는 앱)의 세션은 보드에서 누르면 브라우저 탭으로 열린다(보드의 coreShowOf 'tab' 과 같은 글자).
// 다만 깔린 그 앱이 ovis:// 링크를 알면(runtime/ovis.mjs linkSupported — 런타임이 이동을 app_link 로 하는 조건과 같다) 그 앱 창에서
// 열린다('app' — 보드는 실시간 features 로 같은 답을 낸다). 요약(auto.json)에는 링크 여부가 없어서 여기서 그때 본다.
export const coreLines = (s, T, { link = linkSupported } = {}) => coresOf(s).map((c) => {
  let show = 'app'
  if (c.web) { try { show = link(c.app || null) ? 'app' : 'tab' } catch { show = 'tab' } }
  return T.envCoreSeen(c.name, c.app || '', show)
})

// ── 질문 그리기 ──
// 터미널에서 차지하는 칸 수: 한글·한자·전각 글자는 두 칸으로 센다(줄 바꿈·들여쓰기 계산용).
export const cols = (s) => [...String(s)].reduce((n, ch) => n + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/.test(ch) ? 2 : 1), 0)
const optText = (o, i, preset) => `${i + 1}) ${o.label}${o.note ? ` (${o.note})` : ''}${i + 1 === preset ? ' *' : ''}`
export function renderQuestion(q, width = 80) {
  const head = `  ${q.label}${q.ask ? ` — ${q.ask}` : ''}`
  const parts = q.options.map((o, i) => optText(o, i, q.preset))
  const one = `    ${parts.join('   ')}`
  return [head, ...(cols(one) <= width ? [one] : parts.map((p) => `    ${p}`))]
}

// ── 입력: 줄 단위로 읽는다. 시간 초과·스트림 닫힘·읽기 오류를 구분해 돌려준다 ──
export function lineReader(input) {
  let buf = '', closed = false, waiting = null
  const lines = []
  const settle = () => {
    if (!waiting) return
    if (lines.length) { const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve({ line: lines.shift() }) }
    else if (closed) { const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve({ closed: true }) }
  }
  const onData = (c) => { buf += String(c); const parts = buf.split(/\r?\n|\r/); buf = parts.pop(); lines.push(...parts); settle() }
  const onEnd = () => { closed = true; settle() }
  input.on('data', onData); input.on('end', onEnd); input.on('close', onEnd); input.on('error', onEnd)
  return {
    next(timeoutMs) {
      return new Promise((resolve) => {
        waiting = { resolve, timer: null }
        if (lines.length || closed) return settle()
        waiting.timer = setTimeout(() => { if (waiting) { waiting = null; resolve({ timeout: true }) } }, timeoutMs)
      })
    },
    stop() {
      closed = true   // 멈춘 뒤의 next()는 기다리지 않고 바로 닫힘을 돌려준다
      if (waiting) { clearTimeout(waiting.timer); const w = waiting; waiting = null; w.resolve({ closed: true }) }
      input.off('data', onData); input.off('end', onEnd); input.off('close', onEnd); input.off('error', onEnd)
      try { input.pause?.() } catch {}
    },
  }
}

// 질문을 차례로 묻는다. Enter = 감지 값(저장하지 않음), 번호 = 사람이 정한 값, 잘못된 입력 3번 = 감지 값.
// 시간 초과·닫힘이면 남은 질문을 모두 감지 값으로 넘긴다. 돌려주는 choices에는 번호로 고른 항목만 있다.
export async function askAll(questions, /** @type {{ reader?: any, write?: (s: string) => void, T?: any, timeoutMs?: number, width?: number, maxTries?: number }} */ { reader, write, T, timeoutMs = DEFAULT_TIMEOUT_S * 1000, width = 80, maxTries = MAX_TRIES } = {}) {
  const choices = {}
  let ended = null, answered = 0
  for (const [i, q] of questions.entries()) {
    write(`${i ? '' : '\n'}${renderQuestion(q, width).join('\n')}\n`)   // 빈 줄은 첫 질문 앞에만(한 화면에 들어오게)
    for (let tries = 0; ;) {
      write(`    ${T.prompt(q.preset)}`)
      const r = await reader.next(timeoutMs)
      if (r.timeout) { ended = 'timeout'; write(`\n  ${T.timedOut(secondsOf(timeoutMs))}\n`); break }
      if (r.closed) { ended = 'closed'; break }
      const s = r.line.trim()
      if (s === '') { answered++; break }
      const n = /^\d{1,2}$/.test(s) ? Number(s) : 0
      if (n >= 1 && n <= q.options.length) { choices[q.key] = q.options[n - 1].value; answered++; break }
      if (++tries >= maxTries) { write(`    ${T.giveUp}\n`); break }
      write(`    ${T.bad(q.options.length)}\n`)
    }
    if (ended) break
  }
  return { choices, ended, answered }
}

// ── setup.json ──
// 보드가 읽는 곳(bin/whosup.mjs): 설정 폴더 규칙은 src/paths.mjs 한곳 — 손 실행이 쓰는 곳·scripts/launch.mjs와 같다.
export const setupFilePath = (env = process.env, home = homedir()) => join(configDirOf(env, home), SETUP_FILE)
// 원자적으로 쓴다(임시 파일 → 같은 폴더 안 이름 바꾸기). choices = 번호로 직접 고른 항목만.
// done = 첫 설치의 첫 실행 안내에서 모든 질문에 답했다(시간 초과·Ctrl-C·닫힘 없이 — Enter만 쳤어도). 그때만 "done": true를 싣는다:
// 보드는 그 표시를 보고 첫 실행 안내를 마친 것으로 적는다(고른 값이 없어도 — 값은 고정하지 않고 자동 감지를 따른다).
export function writeSetup(dir, choices, { now = new Date(), done = false } = {}) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, SETUP_FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const body = { version: SETUP_VERSION, at: now.toISOString(), choices: { ...choices }, ...(done ? { done: true } : {}) }
  writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`)
  renameRetry(tmp, file)
  return { file, body }
}
// 읽기: 모양이 틀리면 null(서버는 죽지 않는다). 항목 검사는 가져오는 쪽(src/board/server.mjs importSetup)이 한다.
export function readSetup(file) {
  try {
    if (statSync(file).size > 64 * 1024) return null
    const o = JSON.parse(readFileSync(file, 'utf8'))
    if (!o || typeof o !== 'object' || Array.isArray(o) || o.version !== SETUP_VERSION || typeof o.at !== 'string' || !o.at) return null
    const choices = o.choices && typeof o.choices === 'object' && !Array.isArray(o.choices) ? o.choices : {}
    // done: 첫 실행 안내를 끝까지 답했다는 표시(true일 때만 싣는다 — 그 표시가 없는 옛 파일은 지금까지와 같다)
    return { version: o.version, at: o.at, choices, ...(o.done === true ? { done: true } : {}) }
  } catch { return null }
}

// ── herdr가 플러그인에 주는 폴더(규칙으로 계산): herdr 소스 src/config/io.rs·src/plugin_paths.rs(0.9.5) ──
// 설정: <config>/plugins/config/<id>, 상태: <state>/plugins/<id>. <config>·<state>는 src/paths.mjs herdrDirs.
const idComponent = (id) => { let c = [...Buffer.from(String(id))].map((b) => { const ch = String.fromCharCode(b); return /[a-z0-9._-]/.test(ch) ? ch : `%${b.toString(16).toUpperCase().padStart(2, '0')}` }).join(''); if (c.endsWith('.')) c = `${c.slice(0, -1)}%2E`; return c || '%plugin' }
export function herdrPluginDirs(id, env = process.env, platform = process.platform, home = homedir()) {
  const P = platform === 'win32' ? win32 : posix
  const { config, state } = herdrDirs(env, platform, home)
  return { config: P.join(config, 'plugins', 'config', idComponent(id)), state: P.join(state, 'plugins', idComponent(id)) }
}
// 이미 셋업한 설치(업데이트·재설치): 설정 폴더에 읽을 수 있는 setup.json이 있거나 상태 폴더에 whosup.db(SQLite 파일)가 있다.
// 이름만 같은 빈 파일·깨진 파일은 기존 설치가 아니다 — 그런 파일 하나 때문에 첫 실행 안내를 건너뛰지 않는다.
// exists는 시험이 갈아 끼운다(파일이 있는가). 내용 확인(usable)도 같이 갈아 끼울 수 있다.
const SQLITE_MAGIC = 'SQLite format 3\u0000'
export function sqliteFile(file) {
  let fd = null
  try {
    fd = openSync(file, 'r')
    const head = Buffer.alloc(SQLITE_MAGIC.length)
    return readSync(fd, head, 0, head.length, 0) === head.length && head.toString('latin1') === SQLITE_MAGIC
  } catch { return false } finally { if (fd !== null) { try { closeSync(fd) } catch {} } }
}
export function isExistingInstall({ confDir, stateDir }, exists = existsSync, usable = { setup: (f) => readSetup(f) !== null, db: sqliteFile }) {
  const setup = confDir ? join(confDir, SETUP_FILE) : null
  const db = stateDir ? join(stateDir, 'whosup.db') : null
  return Boolean((setup && exists(setup) && usable.setup(setup)) || (db && exists(db) && usable.db(db)))
}
export function manifestId(root) {
  try { return /^id = "([^"]+)"$/m.exec(readFileSync(join(root, 'herdr-plugin.toml'), 'utf8'))?.[1] || FALLBACK_ID } catch { return FALLBACK_ID }
}

// ── herdr 부르기(인자 배열로만) ──
export const findHerdr = (env = process.env) => env.HERDR_BIN_PATH || env.HERDR_BIN || which('herdr', env) || null
export function runHerdr(bin, args, { timeout = 5000, env = process.env } = {}) {
  const [file, argv] = commandFor(bin, args)
  return new Promise((resolve) => {
    execFile(file, argv, { encoding: 'utf8', timeout, killSignal: 'SIGKILL', windowsHide: true, env, maxBuffer: 1024 * 1024 }, (err, out) => resolve({ ok: !err, out: String(out || '') }))
  })
}
// 보드를 띄울 데스크(herdr session): 지금 이 터미널이 속한 데스크(HERDR_SOCKET_PATH·HERDR_SESSION) > 기본 데스크 > 실행 중인 첫 데스크.
// 설치 때는 herdr가 build 환경에서 HERDR_SOCKET_PATH·HERDR_SESSION을 지우므로(herdr cli/plugin.rs scrub_herdr_runtime_env) 앞의 두 가지는
// 손 실행(herdr 안의 터미널에서 node scripts/setup.mjs)에서만 통한다 — 설치 때는 기본 데스크 > 실행 중인 첫 데스크다.
// 실행 중인 것이 없으면 null. args = herdr에 붙일 인자(기본 데스크에도 --session default를 붙인다).
export function pickDesk(sessions, env = {}) {
  const running = (sessions || []).filter((s) => s.status === 'running')
  if (!running.length) return null
  const hit = (env.HERDR_SOCKET_PATH && running.find((s) => s.socket && s.socket === env.HERDR_SOCKET_PATH))
    || (env.HERDR_SESSION && running.find((s) => s.name === env.HERDR_SESSION))
    || running.find((s) => s.name === 'default') || running[0]
  return { name: hit.name, args: ['--session', hit.name] }
}

// ── 분리 도우미: 설치 명령이 끝나기를 기다렸다가 플러그인이 등록됐는지 보고 start 액션을 한 번 부른다 ──
// `node -e <이 문자열>`로 돈다(파일 경로에 기대지 않는다). 어디에도 글자를 쓰지 않는다. 값은 JSON으로만 싣는다.
export function helperParams({ installerPid, herdr, sessionArgs = [], id, platform = process.platform, waitMs = 120000, listMs = 10000 }) {
  const [file, base] = commandFor(herdr, [])
  const pid = Number(installerPid)
  return { pid: Number.isInteger(pid) && pid > 1 ? pid : 0, file, base, session: sessionArgs.map(String), id: String(id), action: `${id}.${platform === 'win32' ? 'win-start' : 'start'}`, waitMs, listMs }
}
export function helperScript(params) {
  return `const P = ${JSON.stringify(params)}
const { execFile } = require('node:child_process')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const run = (args, timeout) => new Promise((r) => execFile(P.file, P.base.concat(args), { timeout, killSignal: 'SIGKILL', windowsHide: true, encoding: 'utf8' }, (err, out) => r({ ok: !err, out: String(out || '') })))
;(async () => {
  if (P.pid) { const end = Date.now() + P.waitMs; while (alive(P.pid)) { if (Date.now() > end) return; await sleep(200) } }
  for (const end = Date.now() + P.listMs; ;) {
    const r = await run(['plugin', 'list'], 5000)
    if (r.ok && r.out.split(/[^A-Za-z0-9._%-]+/).includes(P.id)) break
    if (Date.now() > end) return
    await sleep(500)
  }
  await run(P.session.concat(['plugin', 'action', 'invoke', P.action]), 60000)
})().catch(() => {}).then(() => process.exit(0))
`
}
export function spawnHelper(script, { env = process.env } = {}) {
  const child = spawn(process.execPath, ['-e', script], { cwd: homedir(), env, stdio: 'ignore', detached: true, windowsHide: true })
  child.once('error', () => {})
  child.unref()
  return child.pid || null
}

// 지금 도는 보드: 상태 폴더의 server.pid가 살아 있는 프로세스이고, 그 보드가 /api/health에 답한다 → { up, port }.
// port = 보드가 실제로 뜬 포트(<상태 폴더>/port, 없으면 null). pid만 보면 재부팅·강제 종료 뒤 남은 pid 파일의 번호를 다른 프로세스가
// 다시 받았을 때 꺼진 보드를 실행 중으로 본다(server.pid는 stop 액션만 지운다) — 그래서 pid가 살아 있으면 <상태 폴더>/port(없으면 설정 포트
// confPort)에 짧은 시간 제한으로 한 번 물어 확인하고, 답이 없으면 꺼짐으로 본다(scripts/launch.mjs의 healthy()와 같은 순서).
// 첫 설치에는 상태 폴더가 없어 늘 꺼짐이다. 업데이트·다시 묻기·손 실행에서 '이미 떠 있는 보드'를 건드리지 않으려고 본다.
const pidAlive = (pid) => { if (!Number.isInteger(pid) || pid <= 1) return false; try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
export async function boardAnswers(port, { timeoutMs = 1500 } = {}) {
  try { return (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })).ok } catch { return false }
}
export async function boardStatus(stateDir, { alive = pidAlive, read = (f) => readFileSync(f, 'utf8'), confPort = '4790', probe = boardAnswers } = {}) {
  const text = (name) => { try { return String(read(join(stateDir, name))).trim() } catch { return '' } }
  if (!stateDir || !alive(Number(text('server.pid')))) return { up: false, port: null }
  const port = /^\d{1,5}$/.test(text('port')) ? text('port') : null
  return (await probe(port || confPort)) ? { up: true, port } : { up: false, port: null }
}
const listed = (out, id) => String(out).split(/[^A-Za-z0-9._%-]+/).includes(id)
// 데스크 목록은 런타임(src/runtime/herdr.mjs readSessions)과 같은 순서로 읽는다: `session list --json` 먼저, 그것을 받지 않거나
// 읽을 수 없는 herdr면 표(`session list`). --json이 안 통한다고 "herdr가 꺼져 있다"로 안내하지 않으려는 것이다.
// 두 방식 모두 못 읽으면 null(모름) — 빈 목록(읽었는데 데스크가 없다)과 구분한다. herdr가 꺼져 있을 때도 두 명령은 답한다(실행 중이 아닌 데스크로).
export async function listDesks({ herdrBin, run = runHerdr, env }) {
  const json = await run(herdrBin, ['session', 'list', '--json'], { timeout: 5000, env })
  if (json.ok) { try { return parseSessionJson(json.out) } catch {} }
  const table = await run(herdrBin, ['session', 'list'], { timeout: 5000, env })
  if (table.ok) { try { return parseSessionTable(table.out) } catch {} }
  return null
}
export async function runningDesk({ herdrBin, run = runHerdr, env }) {
  if (!herdrBin) return null
  return pickDesk(await listDesks({ herdrBin, run, env }), env)
}

// 자동 시작: herdr를 찾고, 실행 중인 데스크가 있으면 도우미를 띄운다. 돌려주는 state:
//   starting(도우미를 띄움) | running(보드가 이미 떠 있어 건드리지 않음) | herdr_off(herdr는 있는데 실행 중인 데스크 없음) | no_herdr |
//   unknown(데스크 목록을 두 방식 모두 못 읽음 — 꺼져 있다고 단정하지 않는다) | spawn_failed(데스크는 찾았는데 도우미를 못 띄움 — herdr는 켜져 있다) |
//   not_registered(손 실행인데 herdr에 등록 안 됨) | reg_unknown(손 실행인데 등록 여부를 확인하지 못함 — 단정하지 않는다) |
//   off(끔 — herdrUp: 그래도 실행 중인 데스크가 있는지는 알려 준다. herdr: 'none'(herdr를 못 찾음)·'unknown'(목록을 못 읽음)일 때만 붙는다 —
//   문구가 "herdr가 꺼져 있습니다"라고 단정하지 않게)
// registered: 손 실행에서 runSetup이 미리 본 등록 여부(true·false, 확인하지 못했으면 undefined). undefined면 여기서 데스크를 찾은 뒤 다시 본다.
// 설치기가 이 실행에만 넘긴 화면 값(WHOSUP_UI · WHOSUP_UI_COLS · WHOSUP_UI_OPEN): 오래 사는 프로세스(도우미 · 보드)는 물려받지 않는다 —
// 그 환경에서 나중에 돌린 명령이 그때의 모드와 폭을 쓰지 않게.
export const UI_ENV_KEYS = ['WHOSUP_UI', 'WHOSUP_UI_COLS', 'WHOSUP_UI_OPEN']
export function withoutUi(env = {}) { const e = { ...env }; for (const k of UI_ENV_KEYS) delete e[k]; return e }
export async function autostart({ enabled = true, install, registered, boardUp = false, id, env, platform, herdrBin, run = runHerdr, spawnFn = spawnHelper, installerPid }) {
  // 등록되지 않은 손 실행(폴더에서 npm start로 쓰는 사람)은 herdr가 켜져 있든 아니든 herdr가 보드를 띄워 주지 않는다.
  if (!install && registered === false) return { state: 'not_registered' }
  if (boardUp) return { state: 'running', desk: (await runningDesk({ herdrBin, run, env }))?.name }
  if (!enabled) {
    const all = herdrBin ? await listDesks({ herdrBin, run, env }) : []
    return { state: 'off', herdrUp: Boolean(pickDesk(all, env)), ...(!herdrBin ? { herdr: 'none' } : all === null ? { herdr: 'unknown' } : {}) }
  }
  if (!herdrBin) return { state: 'no_herdr' }
  const desks = await listDesks({ herdrBin, run, env })
  const desk = pickDesk(desks, env)
  if (!install && registered === undefined) {
    // 등록 여부를 아직 모른다(runSetup의 `plugin list`가 실패했다): 데스크를 찾았으면 그 데스크에 한 번 더 묻는다.
    // 목록을 읽었는데 없을 때만 '등록 안 됨'이다. 이번에도 못 읽으면 모르는 채로 둔다.
    const pl = desk ? await run(herdrBin, [...desk.args, 'plugin', 'list'], { timeout: 5000, env }) : { ok: false, out: '' }
    if (pl.ok && !listed(pl.out, id)) return { state: 'not_registered', desk: desk.name }
    if (!pl.ok) return { state: 'reg_unknown', ...(desk ? { desk: desk.name } : {}) }
  }
  if (desks === null) return { state: 'unknown' }
  if (!desk) return { state: 'herdr_off' }
  const params = helperParams({ installerPid: install ? installerPid : 0, herdr: herdrBin, sessionArgs: desk.args, id, platform })
  let pid = null
  try { pid = spawnFn(helperScript(params), { env: withoutUi(env) }) } catch { return { state: 'spawn_failed', desk: desk.name } }
  if (!pid) return { state: 'spawn_failed', desk: desk.name }   // 프로세스를 만들지 못했다(pid 없음): '지금 뜹니다'라고 하지 않는다
  return { state: 'starting', desk: desk.name, pid, params }
}

// ── 마무리 문구 ──
// 주소·브라우저 판단은 설치한 셸의 환경 + <설정 폴더>/.env로 한다. 보드는 herdr 서버가 띄우므로 정확히는 서버의 환경을 따르지만,
// 설치 시점에 볼 수 있는 가장 가까운 값이 이것이다(둘 다 같은 사용자의 셸에서 나온다).
// 그대로 칠 명령은 백틱 없이, 설명 줄보다 네 칸 더 들여 쓴 한 줄로 싣는다. 주소는 어느 갈래에서든 한 번은 나온다(설정한 포트 기준).
const portOf = (env) => (/^\d{1,5}$/.test(String(env.PORT || '')) ? String(env.PORT) : '4790')
// 사람이 복사해 칠 명령: 데스크를 알고 이름이 기본이 아니면 --session <이름>을 넣는다(herdr 밖 터미널에서는 그것 없이 기본 데스크로 간다).
// 기본 데스크면 --session 없이 그대로다 — 어느 데스크에서 start를 불러도 보드는 하나(같은 상태 폴더·같은 포트)라서 인자를 더 싣지 않는다.
// 데스크를 모르면 명령은 그대로 두고 'herdr 안의 터미널'에 치라고 적는다. inside = 그 덧붙임이 필요한가.
// herdrCmd = 그 명령의 첫 낱말(아래 herdrWord): 보통 'herdr', herdr가 사람의 PATH에 없으면 전체 경로.
function handCommand({ id, platform, desk, herdrCmd = 'herdr' }) {
  const named = typeof desk === 'string' && desk !== 'default' && /^[A-Za-z0-9._-]+$/.test(desk)
  const cmd = (a) => `${herdrCmd} ${named ? `--session ${desk} ` : ''}plugin action invoke ${id}.${platform === 'win32' ? `win-${a}` : a}`
  return { cmd, inside: !(named || desk === 'default') }
}
// 사람이 그대로 칠 herdr 명령의 첫 낱말: 사람의 PATH(WHOSUP_USER_PATH — install.sh가 PATH를 손대기 전에 적어 둔 값, 없으면 PATH)로 herdr가
// 잡히면 'herdr', 아니면 찾아 둔 herdr 실행 파일의 전체 경로다(안내한 줄을 그대로 붙여 넣으면 실행되게 — 셸의 한 낱말로 싼다: src/standalone.mjs
// shown과 같은 규칙). 윈도우와 그 실행 파일의 전체 경로를 모르는 경우는 'herdr' 그대로다.
const shownWord = (s) => (/^[A-Za-z0-9_@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, `'\\''`)}'`)
export function herdrWord({ env = process.env, herdrBin = null, platform = process.platform } = {}) {
  if (platform === 'win32' || typeof herdrBin !== 'string' || !posix.isAbsolute(herdrBin)) return 'herdr'
  return which('herdr', { PATH: env.WHOSUP_USER_PATH ?? env.PATH ?? '' }, false) ? 'herdr' : shownWord(herdrBin)
}
// 문구가 함께 쓰는 값: 설정한 포트·주소·브라우저가 저절로 열리는가·원격일 때 포트 넘기는 줄·손으로 칠 명령(herdr = 그 첫 낱말).
function closingCtx(/** @type {{ id: any, env?: Record<string, any>, platform?: string, desktop?: boolean | null, desk?: any, herdrCmd?: string }} */ { id, env = {}, platform = process.platform, desktop = null, desk = null, herdrCmd = 'herdr' }, T) {
  const opens = desktop !== false && String(env.OPEN_BROWSER ?? '1') === '1'
  return { conf: portOf(env), urlOf: (p) => `http://127.0.0.1:${p}`, opens, remote: (p) => (desktop === false ? [`  ${T.browserRemote(p)}`] : []), herdr: herdrCmd, ...handCommand({ id, platform, desk, herdrCmd }) }
}
// 보드가 아직 뜨지 않는 상태들의 안내 줄(첫 설치의 마무리 문구와 업데이트 문구가 같이 쓴다).
//   herdr_off(자동 시작을 껐고 herdr도 꺼져 있을 때 포함): 이 터미널에 herdr를 치라고 한다 — 그 상태에서 실패하는 손 명령(plugin action invoke)은 싣지 않는다.
//   unknown: 꺼져 있다고 단정하지 않고 두 경우를 나눠 안내한다. spawn_failed: herdr는 켜져 있으므로 손으로 띄우는 명령을 안내한다.
//   그 밖(no_herdr · 자동 시작을 껐고 herdr는 켜져 있음): 다음에 herdr를 켤 때 뜬다 + 주소. herdr가 켜져 있을 때만 손 명령을 붙인다.
function waitingLines({ state: given, herdrUp = false, herdr = null }, c, T) {
  // 자동 시작을 끈 설치(off)는 herdr의 상태에 따라 같은 안내를 쓴다: 켜져 있음 → 손 명령, 못 찾음·모름·꺼짐 → 그 상태의 안내.
  const state = given !== 'off' || herdrUp ? given : herdr === 'none' ? 'no_herdr' : herdr === 'unknown' ? 'unknown' : 'herdr_off'
  const url = c.urlOf(c.conf)
  const then = [`  ${c.opens ? T.thenOpens(url) : T.thenManual(url)}`, ...(c.opens ? [] : c.remote(c.conf))]
  const hand = [T.byHand(c.inside), `    ${c.cmd('start')}`]
  if (state === 'herdr_off') return [T.herdrOff, `  ${T.typeHere}`, `      ${c.herdr}`, ...then]
  if (state === 'unknown') return [T.herdrUnknown, `  ${T.ifOff}`, `      ${c.herdr}`, `  ${T.ifOn}`, `      ${c.cmd('start')}`, ...then]
  if (state === 'spawn_failed') return [T.spawnFailed, ...hand, `${T.boardAt}  ${url} ${T.portNote}`, T.always]
  return [`${T.nextStart}  ${url}`, ...(c.opens ? [] : [`  ${T.browserManual}`, ...c.remote(c.conf)]), ...(state === 'off' ? hand : [])]
}
// state: starting | running | herdr_off | unknown | spawn_failed | not_registered | reg_unknown | no_herdr · off(herdrUp = herdr는 켜져 있는가,
//   herdr = 켜져 있지 않을 때의 사정 'none'·'unknown' — autostart가 준 그대로).
// freePort = 감지가 찾은 빈 포트(보드가 실제로 뜰 포트), boardPort = 이미 떠 있는 보드의 포트, picked = 이번에 번호로 고른 항목 수,
// install = 설치 경로(다시 묻는 업데이트면 실행 중인 보드에 재시작 안내를 붙이고, 고른 값은 재시작 뒤에 들어간다고 말한다 —
//   돌고 있는 보드가 setup.json을 읽지 않는 옛 버전일 수 있다. "재시작 없이 반영"은 손 실행에서만 말한다).
// notes = 덧붙일 줄(감지한 앱 코어 안내 — coreLines): "바꾸려면 보드의 설정에서" 줄 바로 앞에 싣는다.
export function closingLines(/** @type {{ notes?: string[], state: string, id: any, [k: string]: any }} */ { notes = [], ...o }, T) {
  const lines = closingBody(o, T)
  if (!notes.length) return lines
  const i = lines.lastIndexOf(T.change)
  return i < 0 ? [...lines, ...notes] : [...lines.slice(0, i), ...notes, ...lines.slice(i)]
}
function closingBody({ state, id, env = {}, platform = process.platform, desktop = null, desk = null, freePort = null, boardPort = null, picked = 0, install = false, herdrUp = false, herdr = null, herdrCmd = 'herdr' }, T) {
  const c = closingCtx({ id, env, platform, desktop, desk, herdrCmd }, T)
  if (state === 'not_registered') return [T.notRegistered, `  ${T.npmHow}`, '      npm start', T.change]
  if (state === 'reg_unknown') return [T.regUnknown, `  ${T.regIfYes(c.inside)}`, `      ${c.cmd('start')}`, `  ${T.regIfNo}`, '      npm start', T.change]
  if (state === 'running') {
    const p = boardPort || c.conf
    return [`${T.boardRunning}  ${c.urlOf(p)}`, ...c.remote(p), ...(picked ? [`  ${install ? T.picksUpRestart : T.picksUp}`] : []), ...(install ? [`  ${T.updatedOld}`, `  ${T.updatedRestart(c.inside)}`, `      ${c.cmd('stop')}`, `      ${c.cmd('start')}`] : []), T.change]
  }
  if (state === 'starting') {
    // 감지가 찾은 빈 포트는 설정한 포트에서 시작해 찾은 것일 때만 믿는다(보드도 그 포트부터 다음 포트로 넘어간다).
    const free = Number(freePort)
    const p = Number.isInteger(free) && free >= Number(c.conf) && free < Number(c.conf) + 10 ? String(free) : c.conf
    return [`${T.starting}  ${c.urlOf(p)} ${T.portNote}`, `  ${c.opens ? T.browserOpens : T.browserManual}`, ...(c.opens ? [] : c.remote(p)), T.always, T.change, T.byHand(c.inside), `    ${c.cmd('start')}`]
  }
  return [...waitingLines({ state, herdrUp, herdr }, c, T), T.change]
}
// 기존 설치(업데이트·재설치). state = autostart 결과:
//   running(보드가 떠 있음 → 재시작 방법 + 실제 주소) | starting(꺼져 있어 지금 띄움 → 주소·다음 포트·브라우저·원격 안내) |
//   그 밖(herdr 꺼짐 → 이 터미널에 herdr를 치라고 안내, 그 밖은 다음에 herdr를 켤 때).
// 감지를 돌리지 않으므로 빈 포트는 모른다: 설정한 포트에 '(사용 중이면 다음 포트)'를 붙인다. desktop = 원격인지(false면 포트 넘기는 줄).
// brief = 보드가 아직 뜨지 않는 상태의 안내("herdr를 치세요" 등)를 싣지 않는다 — 한 줄 설치기가 herdr를 방금 깔고 부른 설치는 그 안내를
//   설치 요약이 한 번만 말한다(runSetup의 WHOSUP_ENV_INSTALLED).
// summarized = 한 줄 설치기가 부른 설치다(runSetup의 WHOSUP_FROM_INSTALLER): 보드 주소와 다음에 할 일은 설치기의 설치 요약이 말하므로, 요약이
//   말하지 않는 것(돌고 있는 보드는 다시 시작해야 새 버전이 된다 — state 'running')만 남긴다. "지금 띄웁니다"(starting)도 싣지 않는다.
// herdrCmd = 사람이 칠 herdr 명령의 첫 낱말(herdrWord).
export function updatedLines({ id, platform = process.platform, state = 'running', desk = null, env = {}, desktop = null, boardPort = null, herdrUp = false, herdr = null, brief = false, summarized = false, herdrCmd = 'herdr' }, T) {
  const c = closingCtx({ id, env, platform, desktop, desk, herdrCmd }, T)
  const p = boardPort || c.conf
  const mid = (summarized && state !== 'running') || (brief && !['running', 'starting'].includes(state)) ? []
    : state === 'running' ? [`  ${T.updatedOld}`, `  ${T.updatedRestart(c.inside)}`, `      ${c.cmd('stop')}`, `      ${c.cmd('start')}`, `  ${T.boardAt}  ${c.urlOf(p)}`, ...c.remote(p)]
    : state === 'starting' ? [`  ${T.updatedStarts}  ${c.urlOf(c.conf)} ${T.portNote}`, `  ${c.opens ? T.browserOpens : T.browserManual}`, ...(c.opens ? [] : c.remote(c.conf))]
    : waitingLines({ state, herdrUp, herdr }, c, T).map((l) => `  ${l}`)
  // 다시 묻게 하는 법: 그대로 칠 수 있는 한 줄(WHOSUP_SETUP=1 재설치). 윈도우 설치는 묻지 않으므로 보드의 설정이나 손 실행을 알려 준다.
  return [T.updated, ...mid, ...(platform === 'win32' ? [`  ${T.updatedAgainWin}`, '      node scripts\\setup.mjs'] : [`  ${T.updatedAgain}`, `      WHOSUP_SETUP=1 ${c.herdr} plugin install ${INSTALL_SOURCE} --yes`])]
}

// ── 단독 설치(herdr 없이)의 마무리 문구 ──
// install.sh의 설치 요약(표준 출력 — 터미널 없이 에이전트가 돌려도 남는다)과 `whosup setup`의 끝(터미널)이 같이 쓴다.
// herdr 플러그인 액션·"herdr를 치세요" 대신 보드 주소, whosup 명령, 로그인할 때 자동으로 켜기, 바꾸는 곳을 싣는다.
// 그대로 칠 명령은 설명 줄 아래에 따로 들여 쓴 한 줄이다(백틱 없음).
//   kind: 'install'(새 설치) | 'update'(새 버전으로 교체) | 'setup'(첫 실행 안내를 다시 — 제목·설치 줄 없이 왼쪽에 붙여 쓴다)
//   board: { up, url, port, log }(log = 켜려다 실패했을 때 볼 기록 파일) · opens = 방금 브라우저를 열었는가 · desktop = false면 원격
//   login: 'on' | 'off' | 'failed' | 'none'(서비스 관리자 없음) · cmd = 사람이 칠 명령(보통 whosup) · notes = 덧붙일 줄 · picked = 이번에 번호로 고른 항목 수
//   loginLoad: 'failed' = 등록은 됐는데(login 'on') 지금 바로 불러 두지는 못했다(launchctl bootstrap 실패) — 다음 로그인부터 켜진다고 말한다
//   env: 환경 고르기의 결과(아무것도 없는 기계에서 설치기가 정한 앱 — install.sh choose_env). 새 설치(kind 'install')의 요약에만 싣는다.
//     { pick: 'herdr-app' | 'ovis-app', installed: 이번에 함께 깔았는가, app: 그 앱의 경로, opened: 설치기가 그 앱을 열었는가 }
//     함께 깐 앱은 설치 줄 아래에 한 줄, "다음에 할 일"은 보드 줄 아래에 그 앱의 말로 한 줄(요약에서 한 번뿐이다).
/**
 * 단독 설치 요약에 싣는 사실(standaloneLines · standaloneBlocks).
 * @typedef {{ kind?: string, app?: string, board?: { up?: boolean, url?: string, port?: number | string, log?: string }, opens?: boolean,
 *   desktop?: boolean | null, login?: string, loginLoad?: string | null, cmd?: string, notes?: string[], picked?: number,
 *   env?: { pick?: string, installed?: boolean, app?: string, opened?: boolean } | null, home?: string, pathAdd?: { dir?: string, cmd?: string } | null }} StandaloneFacts
 */
export const ENV_APPS = ['herdr-app', 'ovis-app']
export function standaloneLines(/** @type {StandaloneFacts} */ { kind = 'install', app = '', board = {}, opens = false, desktop = null, login = 'off', loginLoad = null, cmd = 'whosup', notes = [], picked = 0, env = null } = {}, T) {
  const body = []
  const hand = (line, command) => body.push(line, `    ${command}`)
  const envName = kind === 'install' && env && ENV_APPS.includes(env.pick) ? T.envNames[env.pick] : ''
  if (board.up) {
    body.push(`${T.saBoardUp}  ${board.url}`)
    if (kind === 'setup') { if (picked) body.push(`  ${T.picksUp}`) }
    else if (kind === 'install') body.push(`  ${opens ? T.browserOpens : T.browserManual}`)   // 새 버전으로 바꾼 뒤의 재시작은 브라우저를 열지 않는다
    if (desktop === false && board.port) body.push(`  ${T.browserRemote(board.port)}`)
  } else hand(board.log ? T.saBoardFailed(board.log) : T.saBoardDown, `${cmd} start`)
  if (envName) body.push(env.opened ? T.saEnvNextOpened(envName) : T.saEnvNext(envName))
  if (login === 'on') hand(loginLoad === 'failed' ? T.saLoginOnLater : T.saLoginOn, `${cmd} autostart off`)
  else if (login === 'none') hand(T.saLoginNone, `${cmd} start`)
  else hand(login === 'failed' ? T.saLoginFailed : T.saLoginOff, `${cmd} autostart on`)
  for (const n of notes) body.push(n)
  hand(T.saCommands, `${cmd} help`)
  body.push(T.change)
  if (kind === 'setup') return body
  return [T.saTitle, `  ${kind === 'update' ? T.saUpdated : T.saInstalled}`, ...(app ? [`  ${T.saApp(app)}`] : []), ...(envName && env.installed ? [`  ${T.saEnvInstalled(envName, env.app || '')}`] : []), ...body.map((l) => `  ${l}`)]
}

// ── rich 화면(src/tui.mjs): 사람이 터미널 앞에 있을 때의 그리기 ──
// 모드는 install.sh와 같은 판정이다(src/tui.mjs uiMode): WHOSUP_UI=plain|rich가 먼저(설치기가 정해 넘긴다), 없으면 쓰는 곳이 터미널이고 TERM이
// 비어 있지 않고 dumb가 아니며 CI가 꺼져 있을 때만 rich. 윈도우는 WHOSUP_UI=rich로 강제하지 않는 한 plain(화살표 메뉴를 쓰지 않는다).
// tty = 글자를 쓰는 곳이 터미널인가(첫 실행 안내: 연 터미널, 설치 요약: 표준 출력과 /dev/tty). ttyCols = 그 터미널의 열 수(모르면 0).
// width = 그릴 폭(열 수 − 1: 마지막 칸에 닿아 꺾이지 않게 — src/tui.mjs의 print와 같다).
export function uiFor({ env = process.env, platform = process.platform, tty = false, ttyCols = 0 } = {}) {
  const forced = String(env.WHOSUP_UI || '').toLowerCase() === 'rich'
  const m = platform === 'win32' && !forced ? { mode: 'plain', color: false, utf8: false } : uiMode({ env, stdoutTTY: tty, ttyOK: tty })
  return { ...m, width: uiCols({ ttyCols, env }).cols - 1 }
}
// 표준 출력에 찍는 것(설치 요약)의 모드: 표준 출력이 터미널이고 /dev/tty를 열 수 있어야 rich(WHOSUP_UI가 주어졌으면 그대로).
export function uiForStdout({ env = process.env, platform = process.platform, stdout = process.stdout } = {}) {
  const want = String(env.WHOSUP_UI || '').toLowerCase()
  let tty = false
  if (want !== 'plain' && want !== 'rich' && stdout?.isTTY && platform !== 'win32') { try { closeSync(openSync('/dev/tty', 'w')); tty = true } catch {} }
  return uiFor({ env, platform, tty, ttyCols: stdout?.isTTY ? stdout.columns || 0 : 0 })
}
// 칠 명령의 실행 파일이 집 폴더 안의 전체 경로면 ~/… 로 적는다(그대로 쳐도 셸이 펼친다). cmd = '<경로>' · 'sh <경로>'(경로는 작은따옴표로
// 쌌을 수 있다 — src/standalone.mjs shown). 집 폴더 뒤의 글자가 셸에서 그대로 쓸 수 있는 것일 때만 줄인다(아니면 그대로).
export function tildeCmd(cmd, home) {
  const h = String(home || '').replace(/\/+$/, '')
  const m = /^(sh )?(.*)$/s.exec(String(cmd))
  if (!h || !m) return String(cmd)
  let p = m[2]
  if (/^'.*'$/s.test(p)) p = p.slice(1, -1).replace(/'\\''/g, "'")
  const rest = p.startsWith(`${h}/`) ? p.slice(h.length) : ''
  return rest && /^[A-Za-z0-9_@%+=:,./-]+$/.test(rest) ? `${m[1] || ''}~${rest}` : String(cmd)
}
// 보여 주는 글자 안의 집 폴더 경로를 ~로 줄인다(그 경로가 집 폴더 안일 때만 — 칠 명령에는 쓰지 않는다. src/tui.mjs tildePath와 같은 규칙).
export function tildeText(s, home) {
  const h = String(home || '').replace(/\/+$/, '')
  if (!h) return String(s)
  return String(s).replace(new RegExp(`(^|[\\s(\x27"])${h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=/)`, 'g'), '$1~')
}
// plain 줄(closingLines · updatedLines — 들여쓰기로 짜인 줄)을 블록으로: 빈 줄 → blank, 들여쓰지 않은 줄 → para, 들여 쓴 줄 → item,
// ':'로 끝나는 줄 바로 아래의 더 들여 쓴 줄과 그 뒤의 같은 들여쓰기 줄 → cmd(칠 명령 — 쪼개지 않고 굵게).
export function looseBlocks(lines) {
  const out = []
  let prev = null
  for (const l of lines) {
    if (!String(l).trim()) { out.push(['blank']); prev = null; continue }
    const depth = l.length - l.trimStart().length, text = l.trim()
    const cmd = Boolean(prev && ((!prev.cmd && /:$/.test(prev.text) && depth > prev.depth) || (prev.cmd && depth === prev.depth)))
    out.push(cmd ? ['cmd', text] : [depth ? 'item' : 'para', text])
    prev = { depth, text, cmd }
  }
  return out
}
// 첫 실행 안내의 rich 출력: run = 끝나지 않은 진행 줄("… 이 컴퓨터를 확인하는 중" — 줄을 끝내지 않는다), blocks = 블록을 그린다.
// 진행 줄 뒤에 다른 것이 찍히지 않고 바로 그 결과(replace)가 오면 그 자리를 \r\x1b[K로 차지한다. 커서를 위로 올리지 않는다.
function richOut(write, ui) {
  let pending = false
  const Y = uiSymbols(ui.utf8)
  const blocks = (bs, { replace = false } = {}) => {
    const ls = renderBlocks(bs, ui)
    if (pending) { write(replace ? '\r\x1b[K' : '\n'); pending = false }
    if (ls.length) write(`${ls.join('\n')}\n`)
  }
  return {
    run(t) { if (pending) write('\n'); write(`  ${Y.run} ${t}`); pending = true },
    blocks,
    note: (t) => blocks([['blank'], ['para', t]]),
  }
}
// 첫 글자를 쓰기 전에 줄을 끝내고 표식 파일을 남기는 터미널(위 WHOSUP_UI_OPEN). 메뉴(runMenu)는 터미널에 직접 쓰지만 늘 진행 줄 뒤에 온다.
function openLineTerminal(terminal, mark) {
  let broke = false
  return {
    ...terminal,
    write: (s) => {
      if (!broke && String(s) !== '') { broke = true; try { writeFileSync(mark, '') } catch {} terminal.write('\n') }
      terminal.write(s)
    },
  }
}
// 화살표 메뉴로 묻는다(rich). 질문마다 src/tui.mjs runMenu: 고르면 "✓ <짧은 제목>: <고른 것>" 한 줄로 접힌다.
// 뜻은 번호 질문(askAll)과 같다: 맨 처음 가리킨 값(preset)에서 Enter만 치면 감지 값 그대로(저장하지 않음), 번호를 누르거나 다른 줄로 옮겨 Enter를
// 치면 그 값을 정한다. 시간 초과·닫힘·Ctrl-C면 남은 질문을 묻지 않는다. 메뉴를 띄울 수 없으면(noraw — stty가 터미널을 바꾸지 못했다) 그
// 질문의 번호(noraw)를 돌려준다 — 부른 쪽이 남은 질문을 번호로 묻는다. at = 마지막으로 본 질문의 번호(0부터).
const UI_ASK = { click_target: 'uiAskClick', front_app: 'uiAskApp', core_target: 'uiAskCore', agent_cmd: 'uiAskCmd' }
export async function askMenus(questions, /** @type {{ menu?: typeof runMenu, T?: any, lang?: string, timeoutMs?: number, signal?: AbortSignal, ui?: { color?: boolean, utf8?: boolean, [k: string]: any }, env?: Record<string, any> }} */ { menu = runMenu, T, lang = 'en', timeoutMs = DEFAULT_TIMEOUT_S * 1000, signal, ui = {}, env = {} } = {}) {
  const choices = {}
  let ended = null, answered = 0, how = '', at = 0
  for (const [i, q] of questions.entries()) {
    at = i
    if (signal?.aborted) { ended = 'closed'; break }
    const r = await menu({
      title: T[UI_ASK[q.key]] || q.label, options: q.options.map((o) => ({ label: o.label, desc: o.note ? [o.note] : [] })), preset: q.preset,
      secs: secondsOf(timeoutMs), lang, prefix: q.label, lead: true, afterDigit: how === 'digit', color: ui.color, utf8: ui.utf8, env, signal,
    })
    how = r.how
    if (r.how === 'noraw') return { choices, ended, answered, at, noraw: i, via: 'menu' }
    if (r.how === 'interrupt') { ended = 'interrupted'; break }
    if (r.how === 'closed') { ended = 'closed'; break }
    if (r.how === 'timeout') { ended = 'timeout'; break }
    answered++
    const n = Number(r.n)
    if (n >= 1 && n <= q.options.length && (r.how === 'digit' || n !== q.preset)) choices[q.key] = q.options[n - 1].value
  }
  return { choices, ended, answered, at, via: 'menu' }
}
// 단독 설치의 설치 요약(rich): ✓ 끝났다 → 다음에 할 일(맨 먼저) → 설치한 것 → 알아 둘 것 → 명령 → 설정 바꾸는 곳(맨 끝, 흐리게).
// 받는 것은 standaloneLines와 같은 사실(+ home: 보여 주는 경로를 ~로 줄일 집 폴더). kind 'setup'(whosup setup의 끝)은 ✓ 줄과 설치한 것 없이.
// 칠 명령(cmd)은 그대로 쳐서 되는 모양이다: 집 폴더 안의 전체 경로는 ~/… 로 적는다(셸이 펼친다 — 길어서 줄 끝에서 쪼개지지 않게).
// pathAdd = { dir, cmd }: 실행 명령의 폴더가 PATH에 없을 때 셸 설정 파일에 PATH를 더하는 명령(standaloneFacts) — 알아 둘 것에 그 명령을 싣는다.
// 돌려주는 것 = src/tui.mjs renderBlocks의 블록.
export function standaloneBlocks(/** @type {StandaloneFacts} */ { kind = 'install', app = '', board = {}, opens = false, desktop = null, login = 'off', loginLoad = null, cmd = 'whosup', notes = [], picked = 0, env = null, home = '', pathAdd = null } = {}, T, { utf8 = true } = {}) {
  const tl = (x) => tildeText(x, home)
  cmd = tildeCmd(cmd, home)
  const dot = utf8 ? '·' : '-'
  const envKey = kind === 'install' && env && ENV_APPS.includes(env.pick) ? env.pick : ''
  const b = [['blank']]
  if (kind !== 'setup') b.push(['done', kind === 'update' ? T.uiUpdated : T.uiDone], ['blank'])
  // 다음에 할 일: 함께 깐 앱 → 보드(주소 · 원격이면 포트 넘기기 · 꺼져 있으면 켜는 명령)
  const next = []
  if (envKey) next.push({ text: env.opened ? T.uiEnvOpened(T.envNames[envKey]) : T.uiEnvOpen(T.envNames[envKey]), cmds: [] })
  if (board.up) {
    next.push({ text: opens ? T.uiBoardOpened : T.uiBoardOpen, cmds: [board.url] })
    if (desktop === false && board.port) next.push({ text: T.uiRemote, cmds: [`ssh -L ${board.port}:127.0.0.1:${board.port} <host>`] })
  } else next.push({ text: board.log ? T.uiBoardFailed(tl(board.log)) : T.uiBoardDown, cmds: [`${cmd} start`] })
  b.push(['title', T.uiNext])
  next.forEach((s, i) => { b.push(next.length > 1 ? ['num', String(i + 1), s.text] : ['item', s.text]); for (const c of s.cmds) b.push(['cmd', c]) })
  // 설치한 것
  if (kind !== 'setup') {
    const loginShort = login === 'on' ? (loginLoad === 'failed' ? T.uiLoginLater : T.uiLoginOn) : login === 'none' ? T.uiLoginNone : T.uiLoginOff
    // whosup 줄은 놓은 곳만 적는다("herdr 없이 단독"은 Herdr 앱을 고른 사람에게 herdr와 Herdr를 헷갈리게 한다)
    b.push(['blank'], ['title', T.uiInstalled], ['kv', 'whosup', app ? tl(app) : T.uiStandalone])
    // 표의 이름: 문장 속 이름(envNames — 영어는 'the Herdr app')에서 관사를 뗀 것
    if (envKey && env.installed) b.push(['kv', T.envNames[envKey].replace(/^the /, ''), env.app ? tl(env.app) : T.uiHere])
    b.push(['kv', T.uiBoard, `${board.up ? board.url : T.uiBoardOff} ${dot} ${loginShort}`])
  }
  // 알아 둘 것(항목끼리는 빈 줄로 띄운다)
  const groups = []
  if (kind === 'setup' && picked && board.up) groups.push([['item', T.picksUp]])
  for (const n of notes) {
    // PATH에 없다는 줄: 그 폴더를 PATH에 더하는 명령을 함께 싣는다(플러그인 길의 요약과 같다)
    if (pathAdd?.cmd && n === T.saPathHint(pathAdd.dir)) groups.push([['item', T.uiPathHint(tl(pathAdd.dir))], ['cmd', pathAdd.cmd]])
    else groups.push([['item', tl(n)]])
  }
  if (login === 'failed') groups.push([['item', T.saLoginFailed], ['cmd', `${cmd} autostart on`]])
  else if (login === 'none') groups.push([['item', T.saLoginNone], ['cmd', `${cmd} start`]])
  if (groups.length) { b.push(['blank'], ['title', T.uiNotes]); groups.forEach((g, i) => { if (i) b.push(['blank']); b.push(...g) }) }
  // 명령: 로그인할 때 켜기를 바꾸는 명령과 전체 목록
  b.push(['blank'], ['title', T.uiCommands])
  if (login === 'on') b.push(['cmdkv', `${cmd} autostart off`, T.uiCmdAutoOff])
  else if (login === 'off') b.push(['cmdkv', `${cmd} autostart on`, T.uiCmdAutoOn])
  b.push(['cmdkv', `${cmd} help`, T.uiCmdHelp], ['blank'], ['foot', T.uiFoot])
  return b
}

// ── 터미널 열기 ──
// 이 프로세스가 제어 터미널의 앞(foreground) 프로세스 그룹인가: true | false | null(알 수 없음).
// 뒤 그룹에서 /dev/tty를 읽으면 SIGTTIN으로 멈추고(정지된 프로세스에서는 시간 제한 타이머도 돌지 않는다) herdr는 build를 무기한 기다린다
// — `herdr plugin install … &`, GNU timeout, 명령을 새 프로세스 그룹으로 띄우는 실행기가 그렇다. 그래서 묻기 전에 본다.
// 리눅스: /proc/self/stat의 5번째(pgrp)·8번째(tpgid) 값. 그 밖(macOS 등): ps -o pgid= -o tpgid=.
export function inForeground({ platform = process.platform, pid = process.pid, readFile = readFileSync, exec = execFileSync } = {}) {
  if (platform === 'win32') return null
  if (platform === 'linux') {
    try {
      const stat = String(readFile('/proc/self/stat', 'utf8'))
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ')   // 이름(괄호) 뒤: state ppid pgrp session tty_nr tpgid …
      if (/^\d+$/.test(f[2]) && /^-?\d+$/.test(f[5])) return f[2] === f[5]
    } catch {}
  }
  try {
    const m = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(String(exec('ps', ['-o', 'pgid=', '-o', 'tpgid=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] })))
    if (m) return m[1] === m[2]
  } catch {}
  return null
}
// 설치(--install): 표준 입출력은 herdr의 파이프라 쓰지 않고 제어 터미널을 직접 연다(POSIX /dev/tty).
//   - 터미널의 앞 프로세스 그룹이 아니면 열지 않는다(위 inForeground. 알 수 없으면 연다).
//   - 윈도우 설치는 열지 않는다: herdr가 build를 CREATE_NO_WINDOW로 띄워(herdr src/platform/windows.rs configure_background_command)
//     CONIN$·CONOUT$가 사용자에게 보이지 않는 새 콘솔로 열린다 — 질문이 안 보인 채 시간 제한만큼 설치가 멈춘다(소스 판단, 실기 미확인).
//     보드의 첫 실행 안내가 같은 것을 묻는다. 실기에서 확인할 때만 WHOSUP_SETUP_CONSOLE=1로 콘솔 질문을 켠다.
// 손 실행: 표준 입출력이 터미널이면 그것을 쓰고, 아니면 제어 터미널을 열어 본다. 못 열면 null(= 터미널 없음).
export function openTerminal({ install = false, platform = process.platform, stdin = process.stdin, stdout = process.stdout, env = process.env, foreground = inForeground } = {}) {
  if (!install && stdin.isTTY && stdout.isTTY) {
    return { input: stdin, write: (s) => { try { stdout.write(s) } catch {} }, columns: stdout.columns || 80, colors: Boolean(stdout.hasColors?.()), isTTY: true, ttyCols: stdout.columns || 0, close() { try { stdin.pause() } catch {} } }
  }
  if (platform === 'win32' ? install && !envOn(env.WHOSUP_SETUP_CONSOLE) : foreground({ platform }) === false) return null
  const win = platform === 'win32'
  let rfd = null, wfd = null
  try {
    rfd = openSync(win ? '\\\\.\\CONIN$' : '/dev/tty', win ? 'r+' : 'r')
    wfd = openSync(win ? '\\\\.\\CONOUT$' : '/dev/tty', win ? 'r+' : 'w')
  } catch {
    for (const fd of [rfd, wfd]) if (fd !== null) { try { closeSync(fd) } catch {} }
    return null
  }
  // 터미널 핸들(tty)로 감싼다: 읽기를 바로 그만둘 수 있고, 윈도우 콘솔에 유니코드가 그대로 나간다. 안 되면 파일 읽기·쓰기로.
  let input, out = null
  try { input = new TtyReadStream(rfd) } catch { input = createReadStream(null, { fd: rfd, autoClose: false }) }
  try { out = new TtyWriteStream(wfd) } catch {}
  const write = (s) => { try { if (out) out.write(s); else writeSync(wfd, s) } catch {} }
  input.on('error', () => {}); out?.on('error', () => {})
  return {
    input, write, columns: out?.columns || 80, colors: Boolean(out?.hasColors?.()), isTTY: Boolean(out?.isTTY), ttyCols: out?.columns || 0,
    close() { try { input.destroy() } catch {} try { if (out) out.destroy(); else closeSync(wfd) } catch {} },
  }
}

// ── 한 번의 셋업 ──
// deps는 시험이 갈아 끼운다: terminal(openTerminal 결과 또는 null), detectFn, run(herdr 실행), spawnFn(도우미 띄우기), readEnvFile,
// boardFn(상태 폴더 → 보드가 떠 있는지), exists, home(홈 폴더 — 손 실행의 ~/.config/whosup을 여기서 계산한다),
// onInterrupt(Ctrl-C를 받을 함수를 걸고, 푸는 함수를 돌려준다),
// alive(PID가 살아 있는가 — 설치 명령을 본다), settleMs(Ctrl-C 뒤 설치 명령이 끝나기를 기다려 보는 시간), watchMs(질문 중 설치 명령을 보는 간격).
//
// 단독 설치(standalone = true — herdr 없이 install.sh가 깐 설치. scripts/standalone.mjs가 부른다):
//   - herdr에 아무것도 묻지 않는다. 설정 폴더·상태 폴더는 src/paths.mjs 규칙 그대로(실행 명령이 HERDR_PLUGIN_*_DIR에 채워 준다).
//   - install = true(설치기 안): 첫 설치의 말투(Enter = 자동 감지 값)로 묻는다. 이미 셋업한 설치(업데이트)는 묻지 않는다.
//     install = false(`whosup setup`): 다시 묻는 말투(Enter = 지금 설정 그대로).
//   - 보드를 띄우는 것은 이 함수가 아니라 부른 쪽이다(herdr 도우미를 띄우지 않는다). autostart는 { state: 'standalone' }.
//   - 마무리 문구는 standaloneLines(위). closing = false(설치기 안의 기본값)면 찍지 않는다 — 설치기는 보드를 켜고 자동 실행을 등록한 뒤
//     같은 문구를 설치 요약으로 표준 출력에 찍는다(같은 내용을 두 번 찍지 않는다). standaloneFacts = 그 문구에 실을 지금 상태.
//   - Ctrl-C는 손 실행처럼 "그만둡니다" 한 줄로 끝낸다(state 'interrupted' — 설치기는 그것을 보고 설치를 멈춘다).
/**
 * runSetup의 선택지(시험이 바꿔 끼우는 함수 포함).
 * @typedef {{ install?: boolean, force?: boolean, standalone?: boolean, closing?: boolean, standaloneFacts?: () => Promise<StandaloneFacts>,
 *   env?: Record<string, any>, platform?: NodeJS.Platform, root?: string, id?: string, terminal?: any, detectFn?: (env: Record<string, any>) => Promise<any>,
 *   run?: (...args: any[]) => any, spawnFn?: (...args: any[]) => any, readEnvFile?: (dir: string) => Record<string, string>, herdrBin?: string | null,
 *   installerPid?: string | number, log?: (msg: string) => void, now?: () => Date, detectTimeoutMs?: number, boardFn?: typeof boardStatus,
 *   exists?: (p: string) => boolean, onInterrupt?: (fn: () => void) => () => void, alive?: (pid: any) => boolean, settleMs?: number,
 *   watchMs?: number, home?: string, menu?: typeof runMenu }} SetupOpts
 */
export async function runSetup(/** @type {SetupOpts} */ {
  install = false, force = false, standalone = false, closing = !install, standaloneFacts = async () => ({}),
  env = process.env, platform = process.platform, root, id = manifestId(root),
  terminal = null, detectFn = (e) => detect({ env: e }), run = runHerdr, spawnFn = spawnHelper, readEnvFile = () => ({}),
  herdrBin = findHerdr(env), installerPid = env.WHOSUP_INSTALLER_PID, log = () => {}, now = () => new Date(), detectTimeoutMs = 30000,
  boardFn = boardStatus, exists = existsSync, onInterrupt = (fn) => { process.once('SIGINT', fn); return () => process.off('SIGINT', fn) },
  alive = pidAlive, settleMs = 300, watchMs = 500, home = homedir(), menu = runMenu,
} = {}) {
  const mode = skipMode(env)
  if (mode.why === 'CI') { log('whosup setup: CI — nothing asked, nothing started'); return { state: 'skipped', why: 'CI' } }
  // 한 줄 설치기가 끝나지 않은 진행 줄("… herdr 플러그인으로 whosup 설치 중")을 터미널에 남겨 두고 이 설치를 불렀다(WHOSUP_UI_OPEN = 표식 파일):
  // 처음 찍기 전에 그 줄을 끝내고 표식을 남긴다. 아무것도 찍지 않으면 설치기의 ✓ 줄이 그 자리를 차지한다.
  if (terminal && env.WHOSUP_UI_OPEN) terminal = openLineTerminal(terminal, String(env.WHOSUP_UI_OPEN))
  // 단독 설치는 sh가 없는 윈도우를 지원하지 않는다(install.sh가 깔 수 없다): 묻지도 쓰지도 않고 분명히 돌려준다.
  if (standalone && platform === 'win32') { log('whosup setup: the standalone install is not supported on Windows'); return { state: 'unsupported' } }
  const T = TEXT[pickLang(env)]
  // 설치 명령(herdr plugin install)이 이미 죽었으면 설치는 취소된 것이다 — herdr가 플러그인을 등록하지 않는다. 터미널의 Ctrl-C는
  // 앞 프로세스 그룹 전체에 SIGINT를 보내 herdr를 바로 끝내고(herdr CLI에는 SIGINT 처리기가 없다), 터미널 닫힘·kill도 같다.
  // 그때는 저장도 도우미도 마무리 문구도 없이, 아무 글자도 더 찍지 않고 끝낸다 — 셸 프롬프트가 이미 돌아와 있어서, 뒤늦게 찍는 줄은
  // 프롬프트 뒤에 붙고 커서를 프롬프트 없는 줄에 남긴다(Ctrl-C도 kill·터미널 닫힘과 같다). 설치 명령의 PID를 모르면(손 실행) 보지 않는다.
  const instPid = Number(installerPid)
  const watched = install && Number.isInteger(instPid) && instPid > 1
  const installerGone = () => watched && !alive(instPid)
  const cancelled = (more = {}) => { log('whosup setup: the install command is gone (cancelled) — nothing saved, nothing started'); return { state: 'cancelled', ...more } }
  const again = force || envOn(env.WHOSUP_SETUP)
  // 다시 묻는 실행(WHOSUP_SETUP=1·--force·손 실행): 전에 정한 값이 DB에 있을 수 있고 셋업은 DB를 읽지 않는다 →
  // Enter는 '지금 설정 그대로'라고 말한다(서버는 번호로 고른 항목만 바꾼다). 첫 설치에서는 Enter = 자동 감지 값이다.
  const reask = again || !install
  // 한 줄 설치기(install.sh)가 부른 플러그인 설치(WHOSUP_FROM_INSTALLER): 마무리 문구는 그 설치기의 설치 요약이 한 번만 말한다(아래).
  const summarized = install && !standalone && envOn(env.WHOSUP_FROM_INSTALLER)
  // 사람이 칠 herdr 명령의 첫 낱말: herdr가 사람의 PATH에 없으면 전체 경로(안내한 줄이 그대로 실행되게)
  const herdrCmd = herdrWord({ env, herdrBin, platform })

  // 설정 폴더: 설치 때는 herdr가 알려 주는 경로(그 명령이 폴더도 만든다), 안 되면 규칙으로 계산.
  // 손 실행: 자기 설정 폴더(HERDR_PLUGIN_CONFIG_DIR || ~/.config/whosup — src/paths.mjs, 보드가 읽는 곳·scripts/launch.mjs와 같은 규칙)
  //   + herdr에 등록돼 있으면 herdr의 설정 폴더. 등록된 설치의 보드는 herdr의 설정 폴더만 읽으므로 그 폴더가 기준이다(목록의 첫째 —
  //   .env도 거기서 읽는다). ~/.config/whosup은 이미 있을 때만 함께 쓴다(손으로도 띄우는 사람). 없으면 만들지 않는다(버려지는 파일).
  //   `herdr plugin list`가 실패하면(시간 초과·오류) 등록 여부는 '모름'이다 — 등록 안 됨으로 단정하지 않는다: herdr의 설정 폴더가
  //   이미 있으면 거기에도 쓰고(새로 만들지는 않는다), 자동 시작이 데스크를 찾은 뒤 한 번 더 확인한다.
  const rule = herdrPluginDirs(id, env, platform)
  const askHerdr = async () => { if (!herdrBin) return null; const r = await run(herdrBin, ['plugin', 'config-dir', id], { timeout: 5000, env }); const p = r.ok ? r.out.trim().split(/\r?\n/).pop().trim() : ''; return p || null }
  let confDirs, registered   // registered: 손 실행에서만 본다(herdr에 플러그인으로 등록돼 있는가 — true·false, 확인하지 못했으면 undefined)
  let own = null             // 손 실행의 자기 설정 폴더(herdr 밖에서 띄운 보드가 읽는 곳)
  if (standalone) { own = configDirOf(env, home); confDirs = [own] }   // 단독 설치: 자기 설정 폴더 하나(herdr에 묻지 않는다)
  else if (install) confDirs = [(await askHerdr()) || rule.config]
  else {
    own = configDirOf(env, home)
    let reg = null
    registered = false       // herdr를 찾지 못했다: herdr 플러그인으로 쓰는 설치가 아니다
    if (herdrBin) {
      const pl = await run(herdrBin, ['plugin', 'list'], { timeout: 5000, env })
      registered = pl.ok ? listed(pl.out, id) : undefined
      if (!env.HERDR_PLUGIN_CONFIG_DIR) {
        if (registered) reg = (await askHerdr()) || rule.config
        else if (registered === undefined && exists(rule.config)) reg = rule.config
      }
    }
    confDirs = [...new Set([reg, !reg || exists(own) ? own : null].filter(Boolean))]
  }
  const fileEnv = { ...env, ...readEnvFile(confDirs[0]) }   // 사용자 설정 파일(.env)은 읽기만
  // 이미 떠 있는 보드는 건드리지 않는다(업데이트·다시 묻기·손 실행). 상태 폴더는 herdr가 주는 곳(규칙으로 계산).
  // 상태 폴더: herdr가 주는 곳(규칙으로 계산). 단독 설치는 자기 상태 폴더(src/paths.mjs stateDirOf).
  const stateDir = standalone ? stateDirOf(env, home) : rule.state
  const board = await boardFn(standalone ? stateDir : env.HERDR_PLUGIN_STATE_DIR || rule.state, { confPort: portOf(fileEnv) })
  // 단독 설치의 보드는 부른 쪽(scripts/standalone.mjs)이 켠다 — herdr 도우미를 띄우지 않는다.
  /** @type {() => Promise<Record<string, any>>} */
  const start = () => (standalone ? Promise.resolve({ state: 'standalone' })
    : autostart({ enabled: mode.autostart, install, registered, boardUp: board.up, id, env, platform, herdrBin, run, spawnFn, installerPid }))

  // 진단 줄의 꼬리: herdr 자동 시작의 결과. 단독 설치에는 그 단계가 없어 싣지 않는다.
  const autoNote = (a) => (standalone ? '' : `; autostart: ${a.state}${a.desk ? ` (${a.desk})` : ''}`)
  // 그리는 방식: plain(지금까지의 줄 그대로) · rich(src/tui.mjs — 진행 줄 · 화살표 메뉴 · 폭에 맞춘 내어쓰기). 쓰는 곳은 연 터미널이다.
  const uiOf = () => uiFor({ env, platform, tty: Boolean(terminal?.isTTY), ttyCols: terminal?.ttyCols || 0 })

  // 이미 셋업한 설치(업데이트·재설치)는 다시 묻지 않는다. 손 실행은 다시 하려고 부른 것이라 늘 묻는다.
  // 보드가 떠 있으면 그대로 두고 재시작 방법만 알린다. 꺼져 있고 herdr가 켜져 있으면 띄운다(제거 뒤 재설치·실패한 설치의 재시도).
  if (install && !again && isExistingInstall({ confDir: confDirs[0], stateDir }, exists)) {
    if (installerGone()) return cancelled()
    const a = await start()
    // 감지를 돌리지 않으므로 원격인지는 환경으로만 본다(SSH·화면 없음 — src/autoconf.mjs remoteWhy와 같은 판정).
    const desktop = remoteWhy({ platform, env: fileEnv }) ? false : null
    // 단독 설치의 업데이트는 여기서 찍지 않는다 — 설치기가 설치 요약(standaloneLines)에 "새 버전으로 바꿨습니다"를 싣는다.
    if (terminal && mode.ask && !standalone) {
      const lines = updatedLines({ id, platform, state: a.state, desk: a.desk, env: fileEnv, desktop, boardPort: board.port, herdrUp: a.herdrUp, herdr: a.herdr, brief: env.WHOSUP_ENV_INSTALLED === 'herdr', summarized, herdrCmd }, T)
      const ui = uiOf()
      if (ui.mode === 'rich') richOut(terminal.write, ui).blocks([['blank'], ...looseBlocks(lines), ['blank']])
      else terminal.write(`\n${lines.join('\n')}\n\n`)
    }
    log(`whosup setup: already set up — nothing asked (${standalone ? 'whosup setup' : 'WHOSUP_SETUP=1'} asks again)${autoNote(a)}`)
    return { state: 'existing', confDir: confDirs[0], autostart: a }
  }

  // 제어 터미널 없음(에이전트·cron 같은 자동 실행) 또는 WHOSUP_NO_SETUP: 묻지도 찍지도 않고 자동 시작만. 보드가 열리면 첫 실행 안내가 묻는다.
  if (!terminal || !mode.ask) {
    if (installerGone()) return cancelled()
    const a = await start()
    log(`whosup setup: ${terminal ? mode.why : 'no terminal'} — nothing asked${autoNote(a)}`)
    return { state: 'silent', autostart: a }
  }

  const bold = (s) => (terminal.colors && !env.NO_COLOR && env.TERM !== 'dumb' ? `\x1b[1m${s}\x1b[0m` : s)
  const say = (s = '') => terminal.write(`${s}\n`)
  const ui = uiOf()
  const rich = ui.mode === 'rich'
  // rich: 제목 없이 진행 줄로 잇는다(한 줄 설치기가 머리말을 이미 찍었다). 설치기를 거치지 않은 실행(손 실행 · herdr plugin install)만 제목을 둔다.
  const R = rich ? richOut(terminal.write, ui) : null
  if (!rich) { say(); say(bold(T.title)); say(`  ${T.checking}`) }
  else {
    if (!(install && (standalone || envOn(env.WHOSUP_FROM_INSTALLER)))) R.blocks([['blank'], ['head', T.title], ['blank']])
    R.run(T.uiChecking)
  }

  let result = null
  try {
    let timer
    result = evaluate(await Promise.race([detectFn(fileEnv), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('detect timed out')), detectTimeoutMs) })]).finally(() => clearTimeout(timer)))
  } catch (err) { log(`whosup setup: detect failed: ${String(err?.message || err).slice(0, 200)}`) }

  let asked = { choices: {}, ended: null, answered: 0 }, questions = [], saved = [], a = null
  if (!result?.summary) { if (rich) R.blocks([['warn', T.detectFail]], { replace: true }); else say(`  ${T.detectFail}`) }
  else {
    const width = Math.max(40, (terminal.columns || 80) - 1)
    const pad = cols(T.detected) + 4   // "  감지한 것: " 뒤에서 줄을 맞춘다
    if (rich) {
      // 진행 줄 자리에 "✓ 감지한 것: …" 한 줄(폭에 맞춰 내어쓰기로 나눈다). 감지한 것이 없으면 확인했다는 줄.
      const seen = summaryLines(result.summary, T, Infinity)[0]
      R.blocks([['ok', seen ? `${T.detected}: ${seen}` : T.uiChecked]], { replace: true })
    } else summaryLines(result.summary, T, width - pad).forEach((l, i) => say(i ? `${' '.repeat(pad)}${l}` : `  ${T.detected}: ${l}`))
    questions = questionsOf(setupRows({ summary: result.summary, chosen: chosenOf(result, fileEnv) }, T, { firstRun: true }), T)
    if (questions.length) {
      const timeoutMs = timeoutMsOf(env)
      const intro = () => {
        if (reask) { say(`  ${T.introAgain}`); say(`  ${T.introAgainStar}`) } else say(`  ${T.intro}`)
        say(`  ${T.waitNote(secondsOf(timeoutMs))}`)   // 자리에 없는 설치(에이전트가 터미널에서 돌린 설치)가 멈춘 것처럼 보이지 않게
      }
      if (!rich) intro()   // rich: 메뉴의 안내 줄이 같은 것(Enter · 번호 · 몇 초 뒤 몇 번)을 말한다
      const Tq = reask ? { ...T, prompt: T.promptAgain, giveUp: T.giveUpAgain, timedOut: T.timedOutAgain } : T
      let reader = rich ? null : lineReader(terminal.input)
      // Ctrl-C: 질문을 그만두고 아무것도 저장하지 않는다(그때까지 번호로 고른 것도 버린다). 그 뒤는 설치 명령이 살아 있는지에 달렸다(아래).
      // 메뉴(rich)는 터미널을 -icanon -echo로만 바꾸므로(ISIG는 그대로) Ctrl-C는 여기서도 SIGINT로 온다 — 메뉴는 터미널 설정을 되돌리고 끝난다.
      let interrupted = false
      const stopAsking = new AbortController()
      const offInt = onInterrupt(() => { interrupted = true; stopAsking.abort(); reader?.stop() })
      // 질문을 기다리는 동안 설치 명령이 죽으면(kill·터미널 닫힘) 더 묻지 않는다.
      const watch = watched ? setInterval(() => { if (installerGone()) { stopAsking.abort(); reader?.stop() } }, watchMs) : null
      try {
        if (!rich) asked = await askAll(questions, { reader, write: terminal.write, T: Tq, timeoutMs, width })
        else {
          asked = await askMenus(questions, { menu, T, lang: pickLang(env), timeoutMs, signal: stopAsking.signal, ui, env })
          if (asked.ended === 'interrupted') interrupted = true
          if (asked.noraw !== undefined && !interrupted && !stopAsking.signal.aborted) {
            // 메뉴를 띄울 수 없었다(stty가 터미널을 바꾸지 못했다): 남은 질문은 번호로 묻는다(plain과 같은 질문 줄)
            say(); intro()
            reader = lineReader(terminal.input)
            const rest = await askAll(questions.slice(asked.noraw), { reader, write: terminal.write, T: Tq, timeoutMs, width })
            asked = { choices: { ...asked.choices, ...rest.choices }, ended: rest.ended, answered: asked.answered + rest.answered }
          }
        }
      } finally { offInt(); clearInterval(watch); reader?.stop() }
      if (interrupted) {
        asked = { choices: {}, ended: 'interrupted', answered: 0 }
        // 같은 SIGINT가 설치 명령에도 갔다면 곧 끝난다: 그 신호가 닿아 프로세스가 사라질 짧은 시간을 두고 본다.
        for (const end = Date.now() + settleMs; watched && alive(instPid) && Date.now() < end;) await sleep(15)
      }
      const more = { questions, ...asked, saved, autostart: null }
      // 설치가 취소됐다(Ctrl-C·kill·터미널 닫힘): 아무것도 찍지 않고 조용히 끝낸다. 저장·도우미·마무리 문구 없음.
      if (installerGone()) return cancelled(more)
      const menuTimedOut = rich && asked.via === 'menu' && asked.ended === 'timeout'
      // rich: 시간이 다 된 질문은 "(답이 없어 자동으로 골랐습니다)"로 접혔다 — 남은 질문이 있었을 때만 그것도 묻지 않았다고 말한다
      if (menuTimedOut && asked.at < questions.length - 1) R.note(Tq.timedOut(secondsOf(timeoutMs)))
      if (!rich && asked.ended !== 'timeout') say()   // 시간 초과 알림은 이미 한 줄을 띄웠다
      if (interrupted && (!install || standalone)) {
        // 손 실행의 Ctrl-C: 그만둔다는 한 줄로 끝낸다(보드는 건드리지 않는다). 단독 설치의 설치기 안에서도 같다 —
        // 설치기(scripts/standalone.mjs install)가 이 결과를 보고 설치를 멈춘다(자동 실행 등록·보드 켜기를 하지 않는다).
        if (rich) R.blocks([['fail', T.stopped]]); else say(`  ${T.stopped}`)
        log('whosup setup: stopped by Ctrl-C — nothing saved')
        return { state: 'interrupted', ...more }
      }
      // 설치 명령이 살아 있다(신호를 무시하는 실행기에서 돌았다): 설치는 계속되므로 질문만 건너뛴 것이다.
      // 첫 설치면 보드가 처음 열릴 때 묻는다고 알리고, 기존 설치(다시 묻기)면 바뀐 것이 없고 설정이 그대로라고 알린다.
      const note = (t) => (rich ? R.note(t) : say(`  ${t}`))
      if (interrupted) note(reask ? T.interruptedAgain : `${T.interrupted} ${T.askLater}`)
      else if (asked.ended === 'timeout' && asked.answered === 0 && !reask) note(T.askLater)
    }
  }
  if (installerGone()) return cancelled({ questions, ...asked, saved, autostart: null })
  a = await start()
  if (result?.summary) {
    // setup.json을 쓰는 것은 번호로 고른 값이 하나라도 있을 때, 또는 첫 설치에서 모든 질문에 답했을 때(finished)다.
    // finished: 시간 초과·Ctrl-C·닫힘 없이 질문을 끝까지 답했다(Enter만 쳤어도) — 고른 값(없을 수 있다)과 함께 "done" 표시를 쓴다.
    //   보드는 그 표시로 첫 실행 안내를 마친 것으로 적는다(같은 것을 두 번 묻지 않는다). Enter로 넘긴 값은 고정하지 않는다(자동 감지를 따른다).
    // 물을 것이 없던 설치는 적지 않는다 — 보드를 처음 열 때 첫 실행 안내가 그때 감지한 것으로 한 번 보여 준다
    // (설치 때는 없던 선택지, 예를 들어 나중에 뜬 웹 터미널을 놓치지 않는다). 다 답하지 못한 설치(자리에 없음·시간 초과·Ctrl-C)도 마친 것으로 적지 않는다.
    // 다시 묻는 실행(reask)은 지금까지와 같다(고른 값만 쓴다).
    const away = asked.ended && asked.answered === 0
    const finished = !reask && questions.length > 0 && !asked.ended && asked.answered === questions.length
    if (!questions.length) {
      // 첫 설치의 줄은 "보드를 처음 열 때 한 번 보여 준다"까지 한 줄로 말한다. rich는 묻지 않았으면 아무 말도 하지 않는다(다시 묻는 실행만 말한다).
      if (!rich) say(`  ${reask ? T.noQuestionsAgain : T.noQuestions}`)
      else if (reask) R.note(T.noQuestionsAgain)
    }
    if (!away) {
      const at = now()
      // 다시 묻는 실행에서 이번에 번호로 고르지 않은 항목: 보드가 아직 한 번도 뜨지 않았으면(상태 폴더에 whosup.db 없음) 앞서 고른 값이
      // 이 파일에만 있다 → 이어 쓴다("전에 직접 정한 값은 남습니다"). whosup.db가 있으면 앞 선택은 이미 보드 설정에 들어갔고 그 뒤에
      // 보드에서 바꿨을 수 있으므로, 이번에 고른 것만 쓴다(옛 선택으로 덮지 않는다).
      const stateOf = (dir) => (dir === own ? stateDirOf(env, home) : stateDir)
      const carried = (dir) => {
        if (!reask || exists(join(stateOf(dir), 'whosup.db'))) return {}
        const prev = readSetup(join(dir, SETUP_FILE))?.choices || {}
        return Object.fromEntries(SETUP_KEYS.filter((k) => typeof prev[k] === 'string').map((k) => [k, prev[k]]))
      }
      for (const dir of confDirs) {
        const choices = { ...carried(dir), ...asked.choices }
        if (!Object.keys(choices).length && !finished) continue   // 고른 값도 마친 표시도 없다: 파일을 쓰지 않는다(있던 파일도 건드리지 않는다)
        try { saved.push(writeSetup(dir, choices, { now: at, done: finished }).file) } catch (err) {
          const why = T.saveFail(String(err?.code || err?.message || err).slice(0, 80))
          if (rich) R.blocks([['warn', why]]); else say(`  ${why}`)
        }
      }
      if (questions.length) {
        const picked = questions.filter((q) => Object.hasOwn(asked.choices, q.key)).map((q) => `${q.label} = ${q.options.find((o) => o.value === asked.choices[q.key])?.label ?? asked.choices[q.key]}`)
        // rich: 고른 것은 접힌 "✓ …" 줄이 이미 보여 준다 — 저장했다는 줄은 싣지 않는다
        if (picked.length) { if (saved.length && !rich) say(`  ${T.saved(picked.join(', '))}`) }
        // rich: 처음 가리킨 값에서 Enter로 끝낸 질문은 접힌 "✓ …" 줄이 고른 것을 보여 준다 — 그 바로 아래에 "직접 정한 값이 없습니다"를 달면
        // 방금 고른 것이 무시된 것처럼 읽힌다. 그 줄은 다 묻지 못하고 끝난 설치(시간 초과 등)에만 싣는다.
        else if (rich) { if (reask) R.note(T.savedNoneAgain); else if (asked.ended) R.note(T.savedNone) }
        else if (reask) say(`  ${T.savedNoneAgain}`)
        // 다 답해 마친 것으로 적었다: 보드가 다시 묻지 않으므로 "보드가 묻습니다" 대신 고정한 값 없이 자동 감지를 따른다고 말한다
        else say(`  ${finished && saved.length ? T.savedNoneDone : T.savedNone}`)
      }
    }
  }

  const picked = saved.length ? Object.keys(asked.choices).length : 0
  // 감지한 앱 코어(자기 herdr-core 코어를 띄우는 앱): "<앱>의 세션도 보드에 보입니다. 누르면 <앱> 창이 앞으로 옵니다" 한 줄씩.
  const coreNotes = coreLines(result?.summary, T)
  if (standalone) {
    // 단독 설치: 설치기 안(closing = false)에서는 찍지 않는다 — 보드를 켜고 자동 실행을 등록한 뒤 설치 요약이 같은 문구를 찍는다.
    // 앱 코어 안내는 설치 요약에 없으므로(감지는 여기서만 돈다) 질문 바로 아래에 싣는다.
    if (closing) {
      const facts = await standaloneFacts()
      const sf = { ...facts, notes: [...(facts.notes || []), ...coreNotes], kind: 'setup', picked }
      if (rich) R.blocks([...standaloneBlocks({ ...sf, home }, T, ui), ['blank']])
      else { say(); for (const l of standaloneLines(sf, T)) say(l); say() }
    } else if (rich) for (const l of coreNotes) R.note(l)
    else for (const l of coreNotes) say(`  ${l}`)
  } else if (install && ((summarized && a.state !== 'running') || (env.WHOSUP_ENV_INSTALLED === 'herdr' && !['starting', 'running'].includes(a.state)))) {
    // 한 줄 설치기(install.sh)가 이 설치를 부른 것이다(WHOSUP_FROM_INSTALLER): 마무리 문구(보드 주소·"herdr를 치세요"·"herdr를 켤 때마다 보드가
    // 뜹니다"·바꾸는 곳)는 설치기의 설치 요약이 한 번만 말한다 — 여기서 같은 안내를 한 번 더 찍지 않는다. 보드가 이미 돌고 있던 설치(running)만은
    // 요약이 말하지 않는 것(다시 시작해야 새 버전이 된다)이 있어 그대로 찍는다.
    // WHOSUP_ENV_INSTALLED=herdr(환경 고르기로 herdr를 방금 깔았다 — herdr는 아직 켜지지 않았다)만 받은 설치도 같다: 보드가 뜨지 않는 상태의 안내를 찍지 않는다.
    if (rich) { for (const l of coreNotes) R.note(l); if (coreNotes.length) R.blocks([['blank']]) }
    else { for (const l of coreNotes) say(`  ${l}`); say() }
  } else {
    const lines = closingLines({ notes: coreNotes, state: a.state, desk: a.desk, id, env: fileEnv, platform, desktop: result?.summary?.desktop ?? (remoteWhy({ platform, env: fileEnv }) ? false : null), freePort: result?.values?.port ?? null, boardPort: board.port, picked, install, herdrUp: a.herdrUp, herdr: a.herdr, herdrCmd }, T)
    if (rich) R.blocks([['blank'], ...looseBlocks(lines), ['blank']])
    else { say(); for (const l of lines) say(l); say() }
  }
  log(`whosup setup: asked ${questions.length}, set by hand ${Object.keys(asked.choices).length}${asked.ended ? ` (${asked.ended})` : ''}; saved: ${saved.join(', ') || 'no'}${autoNote(a)}`)
  return { state: 'done', questions, ...asked, saved, autostart: a }
}
