#!/usr/bin/env node
// whosup setup — 설치에 이어지는 셋업(터미널판 첫 실행 안내). 로직은 src/setup.mjs.
//
//   node scripts/setup.mjs --install   herdr의 build 훅이 부른다(preflight.sh install · launch.mjs install).
//                                      herdr가 build의 표준 출력을 버리므로 제어 터미널(/dev/tty)에 묻는다.
//                                      제어 터미널이 없으면(에이전트·스크립트) 아무것도 묻지 않고 자동 시작만 시도한다. 터미널의 뒤(background)
//                                      프로세스 그룹에서 돌 때와 윈도우 설치(herdr가 build를 보이지 않는 콘솔에서 돌린다)도 같다.
//                                      터미널에서 돌린 스크립트는 제어 터미널이 있으므로 묻는다(WHOSUP_NO_SETUP=1이면 건너뛴다).
//                                      질문 중 Ctrl-C: 같은 신호로 설치 명령(herdr)이 죽으면 설치가 취소된 것이라 아무것도 찍지 않고 조용히
//                                      끝낸다(저장·보드 띄우기 없음). 설치 명령이 이미 죽어 있을 때(kill·터미널 닫힘)와 같다.
//                                      설치 명령이 살아 있으면(신호를 무시하는 실행기) 질문만 건너뛰고 설치는 이어진다.
//   node scripts/setup.mjs             손으로 다시 셋업(link로 쓰는 사람·다시 고르고 싶은 사람). 표준 입출력이 터미널이면 그것을 쓴다.
//                                      Ctrl-C는 저장 없이 그만둔다.
//   --force                            이미 셋업한 설치여도 다시 묻는다(WHOSUP_SETUP=1과 같다).
//
// 환경변수: WHOSUP_NO_SETUP=1 질문 없이 통과 · WHOSUP_NO_AUTOSTART=1 자동 시작 끔 · CI 둘 다 안 함 · WHOSUP_SETUP=1 다시 묻기
//           (스위치는 모두 같은 판정이다: 빈 값·0·false·no·off는 꺼짐, 그 밖의 값은 켜짐 — src/setup.mjs envOn) ·
//           WHOSUP_SETUP_TIMEOUT_S 질문 하나를 기다리는 초(기본 120, 최대 3600) · WHOSUP_LANG=ko|en · WHOSUP_INSTALLER_PID 설치 명령(herdr)의 PID ·
//           WHOSUP_SETUP_CONSOLE=1 윈도우 설치에서도 콘솔(CONIN$·CONOUT$)에 묻는다(실기 확인용 — 기본은 묻지 않는다) ·
//           WHOSUP_ENV_INSTALLED=herdr 한 줄 설치기(install.sh)가 아무것도 없는 기계에 herdr를 방금 깔고 부른 설치다 — 보드가 아직 뜨지 않는
//           상태의 마무리 문구("herdr를 치세요")를 찍지 않는다(설치기의 설치 요약이 "다음에 할 일"로 한 번만 말한다) ·
//           WHOSUP_FROM_INSTALLER=1 한 줄 설치기(install.sh)가 부른 설치다(herdr를 방금 깔았든 아니든) — 질문까지만 하고 마무리 문구(보드 주소 ·
//           "herdr를 치세요" · "herdr를 켤 때마다 보드가 뜹니다" · 바꾸는 곳)는 찍지 않는다: 같은 안내를 설치기의 설치 요약이 한 번만 말한다.
//           보드가 이미 돌고 있던 설치의 "다시 시작해야 새 버전이 된다"는 그대로 찍는다(요약에 없는 말이다) ·
//           WHOSUP_USER_PATH 사람의 PATH(install.sh가 PATH를 손대기 전에 적어 둔 값, 없으면 PATH): herdr가 거기에 없으면 안내하는 herdr 명령을
//           전체 경로로 적는다(그대로 붙여 넣으면 실행되게).
// 고른 값은 <설정 폴더>/setup.json에만 쓴다(.env·DB는 건드리지 않는다). 보드 서버가 그 파일을 읽어 설정에 넣는다.
// 설치(--install)는 어떤 경우에도 0으로 끝나고(설치를 막지 않는다), 프로세스가 남아 설치를 붙잡지 않는다. 그만둔 설치(취소 — 설치 명령이
// 죽었다)도 0이다: 그 뒤에 이어지는 단계가 없고(herdr가 플러그인을 등록하지 않는다), 0이 아니면 preflight.sh가 이미 돌아온 프롬프트 뒤에
// 한 줄을 더 찍는다. 손 실행에서 Ctrl-C로 그만두면 130으로 끝낸다(저장한 것 없음).
import { readFileSync, realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openTerminal, runSetup, watchdogMsOf } from '../src/setup.mjs'
import { parseEnvFile } from './launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

export async function main(argv = process.argv.slice(2), env = process.env) {
  const install = argv.includes('--install')
  const terminal = openTerminal({ install })
  let state = null
  try {
    ({ state } = await runSetup({
      install, force: argv.includes('--force'), env, root: ROOT, terminal,
      log: !install && terminal && process.stdout.isTTY ? () => {} : console.log,   // 손 실행 화면에는 진단 줄을 섞지 않는다
      readEnvFile: (dir) => { try { return parseEnvFile(readFileSync(join(dir, '.env'), 'utf8')) } catch { return {} } },
    }))
  } catch (err) {
    console.error(`whosup setup: ${String(err?.message || err).slice(0, 300)}`)
  } finally { try { terminal?.close() } catch {} }
  return !install && state === 'interrupted' ? 130 : 0
}

// 표준 출력(진단 한두 줄)을 내보낸 뒤 끝낸다. 읽기 스트림·타이머가 남아 있어도 여기서 끝난다.
function exitFlushed(code) {
  let left = 2
  const done = () => process.exit(code)
  const one = () => { if (--left === 0) done() }
  for (const s of [process.stdout, process.stderr]) { s.on('error', () => {}); try { s.write('', one) } catch { one() } }
  setTimeout(done, 1000)
}

// 직접 실행했는가: import.meta.url은 실제 경로라서, 심볼릭 링크가 낀 경로로 불러도(/tmp → /private/tmp, 링크된 설정 폴더) 맞게 푼 뒤 비교한다.
const realOf = (p) => { try { return realpathSync(p) } catch { return resolve(p) } }
if (process.argv[1] && realOf(process.argv[1]) === realOf(fileURLToPath(import.meta.url))) {
  // herdr는 build를 무기한 기다린다: 질문마다 시간 제한이 있지만, 그래도 못 끝나면 여기서 끝낸다(시간 계산은 src/setup.mjs watchdogMsOf).
  setTimeout(() => process.exit(0), watchdogMsOf()).unref()
  exitFlushed(await main())
}
