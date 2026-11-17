#!/usr/bin/env node
// 가짜 herdr(설치기 install.sh 시험용): 실제 herdr를 띄우지 않는다. 시험이 이 파일을 감싼 실행 파일 `herdr`를 임시 PATH에 둔다.
// 받은 인자를 FAKE_HERDR_LOG에 한 줄(JSON 배열)씩 적는다. 플러그인 목록은 파일(FAKE_HERDR_REGISTRY)에 둔다 — 설치하면 그 파일에 id가 는다.
//   FAKE_HERDR_VERSION       `--version`이 찍을 판 번호(기본 0.9.5)
//   FAKE_HERDR_REGISTRY      등록된 플러그인 id를 한 줄씩 적는 파일(없으면 등록된 것 없음)
//   FAKE_HERDR_INSTALL_FAIL  `plugin install`을 실패시킨다(1로 끝난다)
//   FAKE_HERDR_SESSIONS      `session list --json`이 돌려줄 sessions 배열(JSON). 없으면 빈 목록(실행 중인 데스크 없음)
//   FAKE_HERDR_HANG          이 값과 같은 인자 줄(예: `--version`, `plugin list`)을 받으면 아무것도 찍지 않고 끝나지 않는다(멈춘 herdr)
// `plugin install <소스> --yes [--ref <ref>]`: 소스가 폴더면 그 안의 herdr-plugin.toml에서 id를 읽고, 아니면 owner/repo → owner.repo.
// build 훅은 돌리지 않는다(설치 셋업은 test/setup.test.mjs가 따로 본다).
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(argv)}\n`)
// FAKE_HERDR_READ_STDIN=1: 표준 입력을 끝까지 읽고 읽은 바이트 수를 적는다 — `curl | sh`에서 설치기가 herdr에 /dev/null을 주지 않으면
// 스크립트의 나머지를 여기서 먹게 되고(0이 아니다), 설치기는 요약을 찍지 못한 채 끝난다.
if (process.env.FAKE_HERDR_READ_STDIN && process.env.FAKE_HERDR_LOG) {
  let n = -1
  try { n = readFileSync(0).length } catch {}
  appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify({ stdin: n })}\n`)
}
const reg = process.env.FAKE_HERDR_REGISTRY
const listed = () => { try { return readFileSync(reg, 'utf8').split('\n').filter(Boolean) } catch { return [] } }
const a = argv.join(' ')
if (process.env.FAKE_HERDR_HANG && a === process.env.FAKE_HERDR_HANG) setInterval(() => {}, 1 << 30)
else if (a === '--version') console.log(`herdr ${process.env.FAKE_HERDR_VERSION || '0.9.5'}`)
else if (a === 'plugin list') {
  const ids = listed()
  console.log(ids.length ? [`${ids.length} plugin installed:`, ...ids.map((id) => `- ${id} (${id.split('.').pop()}) enabled [github:x/y@0]`)].join('\n') : 'No plugins installed.')
} else if (argv[0] === 'plugin' && argv[1] === 'install') {
  if (process.env.FAKE_HERDR_INSTALL_FAIL) { process.stderr.write('fake herdr: plugin install failed\n'); process.exit(1) }
  const src = argv[2] || ''
  const toml = join(src, 'herdr-plugin.toml')
  const id = existsSync(toml) ? /^id = "([^"]+)"$/m.exec(readFileSync(toml, 'utf8'))?.[1] : src.replace('/', '.')
  if (reg && id && !listed().includes(id)) appendFileSync(reg, `${id}\n`)
  console.log(`Installed plugin ${id}`)
} else if (a === 'session list --json') console.log(JSON.stringify({ sessions: JSON.parse(process.env.FAKE_HERDR_SESSIONS || '[]') }))
else if (a === 'session list') console.log('NAME STATUS DIRECTORY SOCKET')
else { process.stderr.write(`fake herdr: ${a}\n`); process.exitCode = 1 }
