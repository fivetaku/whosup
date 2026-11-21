// 설치 시험에서만 NODE_OPTIONS로 읽는다. 제품의 server.pid는 건강 확인 뒤에 쓰므로 그 전의 보드도 별도 장부에 적는다.
// 명령 줄 문자열을 파싱하지 않는다: Node가 읽을 스크립트와 cwd가 장부를 둔 임시 폴더 안인 보드만 자기 PID를 적는다.
import { appendFileSync, realpathSync } from 'node:fs'
import { basename, dirname, sep } from 'node:path'

const file = process.env.WHOSUP_TEST_BOARD_PIDS
// -e/-p에서는 argv[1]도 실행할 파일이 아니라 코드에 넘긴 첫 인자다.
const evalMode = process.execArgv.some((a) => /^(?:-[ep]|--(?:eval|print)(?:=|$))/.test(a))
if (file && !evalMode && process.argv[1] && basename(process.argv[1]) === 'whosup.mjs') {
  const root = realpathSync(dirname(file))
  const script = realpathSync(process.argv[1])
  const cwd = realpathSync(process.cwd())
  if (script.startsWith(root + sep) && (cwd === root || cwd.startsWith(root + sep))) appendFileSync(file, `${process.pid}\n`)
}
