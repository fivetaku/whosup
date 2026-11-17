#!/usr/bin/env node
// 가짜 herdr(설치 셋업 시험용): 실제 herdr를 띄우지 않는다. 받은 인자를 FAKE_HERDR_LOG에 한 줄(JSON 배열)씩 적는다.
//   FAKE_HERDR_SESSIONS    `session list --json`이 돌려줄 sessions 배열(JSON). 없으면 빈 목록(실행 중인 데스크 없음).
//   FAKE_HERDR_CONFIG_DIR  `plugin config-dir <id>`가 찍을 경로(그 폴더도 만든다 — 진짜 herdr처럼). 없으면 실패.
//   FAKE_HERDR_PLUGINS     `plugin list`에 보일 플러그인 id(쉼표로 구분). 없으면 "No plugins installed."
//   FAKE_HERDR_NO_JSON=1   `session list --json`을 받지 않는 herdr 흉내(사용법을 stderr에 찍고 2로 끝난다).
//   FAKE_HERDR_TABLE       `session list`(표)가 찍을 글자 그대로. 없으면 머리글 한 줄.
import { appendFileSync, mkdirSync } from 'node:fs'

const argv = process.argv.slice(2)
if (process.env.FAKE_HERDR_LOG) appendFileSync(process.env.FAKE_HERDR_LOG, `${JSON.stringify(argv)}\n`)
// --session <name>은 진짜 herdr처럼 어디에 있어도 떼어 낸다.
const args = []
for (let i = 0; i < argv.length; i++) { if (argv[i] === '--session') i++; else args.push(argv[i]) }
const a = args.join(' ')
if (a === '--version') console.log('herdr 0.0.0-fake')
else if (a === 'session list --json' && process.env.FAKE_HERDR_NO_JSON === '1') { process.stderr.write('usage: herdr session list\n'); process.exitCode = 2 }
else if (a === 'session list --json') console.log(JSON.stringify({ sessions: JSON.parse(process.env.FAKE_HERDR_SESSIONS || '[]') }))
else if (a === 'session list') process.stdout.write(process.env.FAKE_HERDR_TABLE || 'NAME STATUS DIRECTORY SOCKET\n')
else if (args[0] === 'plugin' && args[1] === 'config-dir' && process.env.FAKE_HERDR_CONFIG_DIR) { mkdirSync(process.env.FAKE_HERDR_CONFIG_DIR, { recursive: true }); console.log(process.env.FAKE_HERDR_CONFIG_DIR) }
else if (a === 'plugin list') {
  const ids = String(process.env.FAKE_HERDR_PLUGINS || '').split(',').filter(Boolean)
  console.log(ids.length ? [`${ids.length} plugin installed:`, ...ids.map((id) => `- ${id} (${id.split('.').pop()}) enabled [github:x/y@0]`)].join('\n') : 'No plugins installed.')
}
else if (args[0] === 'plugin' && args[1] === 'action' && args[2] === 'invoke') console.log('{"ok":true}')
else { process.stderr.write(`fake herdr: ${a}\n`); process.exitCode = 1 }
