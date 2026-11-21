// 설치 시험에서만 NODE_OPTIONS로 읽는다(test-support/install-rig.mjs). 시험이 띄운 보드가 시작하자마자 두 가지를 한다:
// - 제품의 server.pid는 건강 확인 뒤에 쓰므로, 그 전의 보드도 rig 정리가 찾게 별도 장부(.board-pids)에 자기 PID를 적는다.
// - 시험 프로세스가 열어 둔 소켓(WHOSUP_TEST_OWNER)에 붙어, 붙어 있던 연결이 끊기면(그 프로세스가 끝났다 — SIGKILL로 정리 코드가
//   돌지 못한 경우 포함) 스스로 끝난다. 붙지 못했다는 것만으로는 끝나지 않는다(살아 있는 소켓도 대기열이 차면 거절한다):
//   주인 PID(WHOSUP_TEST_OWNER_PID)의 프로세스가 없으면(ESRCH) 끝나고, 있으면 조금 뒤 다시 붙는다.
// 명령 줄 문자열을 파싱하지 않는다: Node가 읽을 스크립트와 cwd가 장부를 둔 임시 폴더 안인 보드만 이렇게 한다.
import { appendFileSync, realpathSync } from 'node:fs'
import { connect } from 'node:net'
import { basename, dirname, sep } from 'node:path'

const file = process.env.WHOSUP_TEST_BOARD_PIDS
const owner = process.env.WHOSUP_TEST_OWNER, ownerPid = Number(process.env.WHOSUP_TEST_OWNER_PID)
const ownerGone = () => { try { process.kill(ownerPid, 0); return false } catch (e) { return e.code === 'ESRCH' } }
const watch = () => {
  const s = connect(owner)
  let joined = false
  s.unref()                                   // 보드가 끝나는 것을 이 연결이 막지 않는다
  s.once('connect', () => { joined = true })
  s.on('error', () => {})                     // 붙지 못함·끊김은 아래 close로 온다
  s.once('close', () => {
    if (joined || ownerGone()) process.exit(0)
    setTimeout(watch, 250).unref()            // 주인은 살아 있는데 받지 못했다(대기열이 찼다·아직 열지 않았다)
  })
}
// -e/-p에서는 argv[1]도 실행할 파일이 아니라 코드에 넘긴 첫 인자다.
const evalMode = process.execArgv.some((a) => /^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(a))
if (file && !evalMode && process.argv[1] && basename(process.argv[1]) === 'whosup.mjs') {
  const root = realpathSync(dirname(file))
  const script = realpathSync(process.argv[1])
  const cwd = realpathSync(process.cwd())
  if (script.startsWith(root + sep) && (cwd === root || cwd.startsWith(root + sep))) {
    appendFileSync(file, `${process.pid}\n`)
    if (owner && ownerPid > 1) watch()
  }
}
