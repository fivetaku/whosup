// node:sqlite 를 조용히 불러온다. Node 22.13~22.x 는 처음 불러올 때 "ExperimentalWarning: SQLite is an experimental feature …"를
// 표준 오류로 찍는데, 설치 화면·whosup 명령 출력 한가운데 영어 경고가 끼어든다(Linux 컨테이너 node 22.13.1 실측, 11-14).
// 불러오는 동안만 그 경고 하나를 거르고 다른 경고는 그대로 둔다. 플래그(--disable-warning)를 쓰지 않는 것은 node 를 띄우는
// 곳(설치기, herdr 훅, 로그인 자동 실행, 사용자가 치는 명령)이 여럿이라 모두 고치기보다 불러오는 한 곳에서 막는 편이 빠짐이 없어서다.
export async function loadSqlite() {
  const emit = process.emitWarning
  process.emitWarning = function (warning, ...rest) {
    const type = typeof rest[0] === 'string' ? rest[0] : rest[0] && rest[0].type
    const text = String(warning && warning.message !== undefined ? warning.message : warning)
    if ((type === 'ExperimentalWarning' || (warning && warning.name === 'ExperimentalWarning')) && /sqlite/i.test(text)) return
    return emit.call(process, warning, ...rest)
  }
  try { return await import('node:sqlite') } finally { process.emitWarning = emit }
}
