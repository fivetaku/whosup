// 창 올리기 권한은 필요할 때만(F4), 거부는 종류별로(F5), 권한 대상 앱 이름(F6 서버 쪽).
// 실제 osascript·System Events·open·ps 는 돌리지 않는다: 상주 도우미와 실행기를 대역으로 바꿔(herdr._setMacOps) 무엇을 불렀는지만 본다.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { basename } from 'node:path'

delete process.env.FRONT_APP
const herdr = await import('../src/runtime/herdr.mjs')
const { _setPlatform } = await import('../src/platform.mjs')

const APP = '/Applications/Fake Term.app'
const SESSION = 'desk1'
// 100 = 그 세션(desk1)의 herdr 클라이언트를 품은 터미널 앱 프로세스
const PS = `
  100     1 ${APP}/Contents/MacOS/faketerm
  101   100 -zsh
  102   101 /opt/homebrew/bin/herdr --session ${SESSION}
`
const tail = (o) => `|${Object.entries(o).map(([k, v]) => `${k}=${k === 'app' || k === 'own' ? encodeURIComponent(v) : v}`).join(';')}`
const LACK = { ax: 0, ae: -1744, inst: 1, app: APP }   // 권한을 주지 않은 사람(아직 안 물음), 그 앱은 한 벌
const DENIED_1743 = 'execution error: System Events에 Apple 이벤트를 보낼 권한이 없습니다. (-1743)'
const DENIED_25211 = 'execution error: System Events에 오류 발생: osascript에 보조 접근이 허용되지 않습니다. (-25211)'

// reply(line, n): 상주 도우미의 답(n = 몇 번째 물음). precise(): 정밀 올리기(System Events AppleScript)의 결과 — 던지면 실패.
function rig({ reply, precise = () => '100', ps = PS }) {
  const calls = { helper: [], run: [], slept: [] }
  herdr._setMacOps({
    helper: { send: async (line) => { calls.helper.push(line); return reply(line, calls.helper.length) } },
    run: async (file, args) => {
      if (file === '/bin/ps') return ps
      const script = args.join('\n')
      const kind = file === '/usr/bin/open' ? 'reopen'
        : !/System Events/.test(script) ? (/to activate/.test(script) ? 'app-activate' : 'other')
          : /splitNums/.test(script) ? 'layout' : 'precise'
      calls.run.push({ kind, file, args })
      if (kind === 'precise') return precise()
      return ''
    },
    sleep: async (ms) => { calls.slept.push(ms) },
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
  return calls
}
const kinds = (calls) => calls.run.map((c) => c.kind)
const systemEvents = (calls) => calls.run.filter((c) => c.kind === 'precise' || c.kind === 'layout')
async function click(split = 0) {
  const r = await herdr.activateTerminal(SESSION, split)
  await herdr._raiseSettled()
  await new Promise((r) => setImmediate(r))   // 실패 뒤의 앱 단위 올리기(기다리지 않는 호출)까지 지나가게
  return r
}
afterEach(() => { herdr._setMacOps(null); _setPlatform(null); herdr.setFrontApp('') })

test('① 권한 있음(손쉬운 사용 + 자동화 허용): 예전과 똑같이 매번 정밀 올리기를 부른다', async () => {
  const calls = rig({ reply: () => `ok:100${tail({ ax: 1, ae: 0 })}` })
  assert.equal(await click(), 'raised')
  assert.equal(await click(), 'raised')
  assert.deepEqual(calls.helper, ['100;0', '100;0'], '도우미에 보내는 줄은 예전 그대로')
  assert.deepEqual(kinds(calls), ['precise', 'precise'])
  const c = calls.run[0]
  assert.equal(c.file, '/usr/bin/osascript')
  assert.deepEqual([c.args[0], c.args[2], c.args.length], ['-e', '100', 3], '고른 pid 하나만 넘긴다')
  assert.match(c.args[1], /AXMinimized[\s\S]*AXRaise[\s\S]*set frontmost to true/, '최소화 창 펼치기·올리기 스크립트 그대로')
  assert.equal(herdr.raiseWarning(), null)
})

test('② 권한 없음 + 화면에 보이는 창 있음: System Events 를 부르지 않는다(권한 창 0개), 다시 열기도 하지 않는다', async () => {
  const calls = rig({ reply: () => `ok:100${tail({ ...LACK, vis: 1 })}` })
  assert.equal(await click(), 'raised')
  assert.equal(await click(), 'raised')
  assert.deepEqual(calls.run, [], 'osascript·open 을 하나도 부르지 않았다')
  assert.deepEqual(calls.helper, ['100;0', '100;0'], 'pid 로 앞으로 올리기는 도우미가 이미 했다')
  assert.equal(herdr.raiseWarning(), null)
  assert.equal(herdr.raiseWarningApp(), null, '경고가 없으면 대상 앱 이름도 없다')
})

test('③ 권한 없음 + 보이는 창 없음: 다시 열기를 먼저 하고, 창이 나오면 System Events 를 부르지 않는다', async () => {
  const calls = rig({ reply: (line, n) => (line.startsWith('?') ? `st:100${tail({ ...LACK, vis: n >= 3 ? 1 : 0 })}` : `ok:100${tail({ ...LACK, vis: 0 })}`) })
  assert.equal(await click(), 'raised')
  assert.deepEqual(kinds(calls), ['reopen'])
  assert.deepEqual([calls.run[0].file, calls.run[0].args], ['/usr/bin/open', ['-a', APP]], '그 앱을 한 번 더 연다(권한 불필요)')
  assert.deepEqual(calls.helper, ['100;0', '?100', '?100'], '잠깐 뒤 창 목록을 다시 읽고, 보이면 거기서 멈춘다')
  assert.deepEqual(calls.slept, herdr.REOPEN_WAITS.slice(0, 2))
  assert.equal(herdr.raiseWarning(), null)
})

test('③ 권한 없음 + 보이는 창 없음: 다시 연 뒤에도 창이 없을 때만 정밀 올리기를 부른다("필요해진 순간")', async () => {
  const calls = rig({ reply: (line) => (line.startsWith('?') ? `st:100${tail({ ...LACK, vis: 0 })}` : `ok:100${tail({ ...LACK, vis: 0 })}`) })
  await click()
  assert.deepEqual(kinds(calls), ['reopen', 'precise'], '다시 열기가 먼저, 정밀 올리기는 그 뒤')
  assert.deepEqual(calls.helper, ['100;0', ...herdr.REOPEN_WAITS.map(() => '?100')], '정해 둔 횟수만큼 다시 읽었다')
  assert.deepEqual(calls.slept, herdr.REOPEN_WAITS)
})

test('③ 그 앱이 여러 벌 떠 있으면 다시 열기를 건너뛰고 바로 정밀 올리기를 부른다', async () => {
  const calls = rig({ reply: () => `ok:100${tail({ ...LACK, inst: 2, vis: 0 })}` })
  await click()
  assert.deepEqual(kinds(calls), ['precise'])
  assert.deepEqual(calls.helper, ['100;0'])
  // 앱 묶음 경로를 모르거나(빈 값) 몇 벌인지 모를 때도 다시 열기는 하지 않는다
  const c2 = rig({ reply: () => `ok:100${tail({ ax: 0, ae: -1744, vis: 0, inst: '', app: '' })}` })
  await click()
  assert.deepEqual(kinds(c2), ['precise'])
})

test('④ 정밀 올리기가 -1743(자동화 거부)으로 실패하면 경고는 mac_automation — 손쉬운 사용 경고와 다른 종류', async () => {
  const seen = []
  const off = herdr.onRaiseWarning((k) => seen.push(k))
  try {
    const calls = rig({ reply: () => 'ok:100', precise: () => { throw new Error(DENIED_1743) } })
    await click()
    assert.equal(herdr.raiseWarning(), 'mac_automation')
    assert.deepEqual(seen, ['mac_automation'], '경고가 생기면 듣는 쪽(보드 서버)에 알린다')
    assert.deepEqual(kinds(calls), ['precise', 'app-activate'], '실패하면 예전처럼 앱 단위로라도 앞으로')
  } finally { off() }
})

test('④ 자동화를 이미 거부(-1743)했다고 도우미가 알려 주면: 창이 보이면 조용히, 안 보이면 부르지 않고 경고만 올린다', async () => {
  const D = { ...LACK, ae: -1743 }
  const shown = rig({ reply: () => `ok:100${tail({ ...D, vis: 1 })}` })
  await click()
  assert.deepEqual(shown.run, [])
  assert.equal(herdr.raiseWarning(), null, '권한이 필요 없었다')

  const hidden = rig({ reply: (line) => (line.startsWith('?') ? `st:100${tail({ ...D, vis: 0 })}` : `ok:100${tail({ ...D, vis: 0 })}`) })
  await click()
  assert.deepEqual(kinds(hidden), ['reopen'], '다시 열기는 해 보지만 System Events 는 부르지 않는다(불러도 실패할 뿐 다시 묻지도 않는다)')
  assert.equal(herdr.raiseWarning(), 'mac_automation')

  // 권한을 켠 것을 도우미가 알려 주면(자동화 허용) 경고를 지운다 — 정밀 올리기를 부르지 않는 길에서도.
  // (대역을 새로 넣으면 경고가 비워지므로, 거부 → 허용의 흐름을 한 대역 안에서 만든다.)
  let state = { ...D, vis: 0 }
  const flow = rig({ reply: (line) => (line.startsWith('?') ? `st:100${tail(state)}` : `ok:100${tail(state)}`) })
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_automation')
  state = { ...LACK, ae: 0, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), null, '자동화가 허용으로 바뀐 것을 도우미가 알려 줬다')
  assert.deepEqual(kinds(flow), ['reopen'], '그 뒤 클릭은 창이 보여 아무것도 부르지 않았다')
})

test('⑤ 정밀 올리기가 -25211(손쉬운 사용 없음)로 실패하면 경고는 mac_accessibility, 다음 성공에서 지운다', async () => {
  let fail = true
  rig({ reply: () => 'ok:100', precise: () => { if (fail) throw new Error(DENIED_25211); return '100' } })
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_accessibility')
  fail = false
  await click()
  assert.equal(herdr.raiseWarning(), null, '정밀 올리기가 성공하면 지운다')
})

test('⑤ 손쉬운 사용 경고는 도우미가 그 권한이 생겼다고 알려 주면 지운다(자동화 값과 상관없이), 없다고 하면 남는다', async () => {
  let state = { ...LACK, ae: 0, vis: 0, inst: 2 }
  rig({ reply: () => `ok:100${tail(state)}`, precise: () => { throw new Error(DENIED_25211) } })
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_accessibility')
  state = { ...LACK, ae: 0, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_accessibility', '창은 보이지만 권한은 여전히 없다: 경고는 그대로')
  state = { ...LACK, ax: 1, ae: -1744, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), null)
})

test('종류 판정: -1743 과 -25211 을 한데 묶지 않는다(영어·한국어 문구 모두), 다른 오류는 경고가 아니다', () => {
  assert.equal(herdr.raiseErrorKind(DENIED_1743), 'mac_automation')
  assert.equal(herdr.raiseErrorKind('execution error: Not authorized to send Apple events to System Events. (-1743)'), 'mac_automation')
  assert.equal(herdr.raiseErrorKind(DENIED_25211), 'mac_accessibility')
  assert.equal(herdr.raiseErrorKind('System Events got an error: osascript is not allowed assistive access. (-1719)'), 'mac_accessibility')
  assert.equal(herdr.raiseErrorKind('timed out after 4000ms (macOS automation permission prompt pending?)'), null)
  assert.equal(herdr.raiseErrorKind(undefined), null)
})

// 권한 창을 4초 넘게 읽은 사람(검토 R1): 정밀 올리기는 시간 초과로 끝나고, 그 뒤에 고른 답은 상주 도우미가 읽어 준다.
const TIMED_OUT = 'timed out after 4000ms (macOS automation permission prompt pending?)'
const timeout = () => { throw new Error(TIMED_OUT) }
test('④ 권한 창을 오래 읽다가 거부: 정밀 올리기가 시간 초과로 끝난 뒤 도우미로 답을 다시 읽어 mac_automation 경고를 올린다', async () => {
  const seen = []
  const off = herdr.onRaiseWarning((k) => seen.push(k))
  try {
    // 누를 때와 첫 다시 읽기까지는 "아직 안 고름"(-1744), 둘째 다시 읽기에서 "거부"(-1743)
    const calls = rig({ precise: timeout, reply: (line, n) => (line.startsWith('?') ? `st:100${tail({ ...LACK, inst: 2, ae: n >= 3 ? -1743 : -1744, vis: 0 })}` : `ok:100${tail({ ...LACK, inst: 2, vis: 0 })}`) })
    await click()
    assert.equal(herdr.raiseWarning(), 'mac_automation', '4초 안에 거부했을 때와 같은 경고')
    assert.deepEqual(seen, ['mac_automation'], '듣는 쪽(보드 서버)에 알린다')
    assert.deepEqual(calls.helper, ['100;0', '?100', '?100'], '답을 읽으면 더 묻지 않는다')
    assert.deepEqual(calls.slept, herdr.ASK_WAITS.slice(0, 2))
    assert.deepEqual(kinds(calls), ['precise', 'app-activate'], 'System Events 를 다시 부르지 않는다(권한 창을 또 띄우지 않는다)')
  } finally { off() }
})

test('④ 권한 창을 더 오래 두었다가 거부: 다시 읽기가 끝난 뒤에도 다음 클릭의 도우미 응답에서 알아챈다(창이 보여 아무것도 부르지 않는 클릭이어도)', async () => {
  let state = { ...LACK, inst: 2, vis: 0 }
  const calls = rig({ precise: timeout, reply: (line) => (line.startsWith('?') ? `st:100${tail(state)}` : `ok:100${tail(state)}`) })
  await click()
  assert.equal(herdr.raiseWarning(), null, '아직 고르지 않았다: 경고가 아니다')
  assert.deepEqual(calls.helper, ['100;0', ...herdr.ASK_WAITS.map(() => '?100')], '정해 둔 횟수만큼만 다시 읽는다')
  assert.deepEqual(calls.slept, herdr.ASK_WAITS)
  state = { ...LACK, ae: -1743, vis: 1 }   // 그 뒤 "허용 안 함"을 눌렀고, 창은 화면에 보인다
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_automation')
  assert.deepEqual(kinds(calls), ['precise', 'app-activate'], '둘째 클릭은 아무것도 부르지 않았다')
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_automation', '거부한 동안에는 남는다')
  state = { ...LACK, ae: 0, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), null, '자동화를 켜면 지운다')
})

test('④ 시간 초과 뒤 허용했거나 권한을 다 가진 사람이면 경고 없이 그만 본다, 권한 값을 못 읽는 도우미면 다시 읽지 않는다', async () => {
  // 오래 읽다가 "허용": 첫 다시 읽기에서 0 → 끝. 그 뒤의 거부 값은(시간 초과와 무관) 창이 보이는 한 조용하다 — 예전 판정 그대로.
  let state = { ...LACK, inst: 2, vis: 0 }
  const allowed = rig({ precise: timeout, reply: (line) => { const r = line.startsWith('?') ? `st:100${tail(state)}` : `ok:100${tail(state)}`; if (line.startsWith('?')) state = { ...state, ae: 0 }; return r } })
  await click()
  assert.deepEqual(allowed.helper, ['100;0', '?100', '?100'], '-1744 한 번, 0 한 번에서 멈춘다')
  assert.equal(herdr.raiseWarning(), null)
  state = { ...LACK, ae: -1743, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), null, '답을 이미 들었다: 시간 초과 때문에 올리는 경고는 없다')

  // 권한을 다 가진 사람의 시간 초과(System Events 가 느렸다): 권한 창이 뜰 일이 없다 — 다시 읽지 않는다(예전 동작 그대로)
  const full = rig({ precise: timeout, reply: (line) => `${line.startsWith('?') ? 'st' : 'ok'}:100${tail({ ax: 1, ae: 0 })}` })
  await click()
  assert.deepEqual(full.helper, ['100;0'])
  assert.deepEqual(full.slept, [])
  assert.equal(herdr.raiseWarning(), null)

  // 권한 창에서 4초 안에 "허용"했지만 손쉬운 사용이 없다(-25211): 답을 들었으니 더 읽지 않는다
  const answered = rig({ precise: () => { throw new Error(DENIED_25211) }, reply: () => `ok:100${tail({ ...LACK, inst: 2, vis: 0 })}` })
  await click()
  assert.deepEqual(answered.helper, ['100;0'])
  assert.equal(herdr.raiseWarning(), 'mac_accessibility')

  // 옛 응답 형식: 도우미가 권한 값을 모른다 — 다시 읽지 않는다(예전 동작 그대로)
  const old = rig({ precise: timeout, reply: () => 'ok:100' })
  await click()
  assert.deepEqual(old.helper, ['100;0'])
  assert.deepEqual(old.slept, [])
  assert.equal(herdr.raiseWarning(), null)
})

test('④ 권한 창이 떠 있는 동안 더 새 클릭이 정밀 올리기를 끊어도, 그 뒤의 거부를 놓치지 않는다', async () => {
  // 'exit null' = 더 새 클릭이 앞 클릭의 osascript 를 끊었을 때의 오류. 그것만으로는 경고가 아니다.
  let state = { ...LACK, inst: 2, vis: 0 }
  const calls = rig({ precise: () => { throw new Error('exit null') }, reply: (line) => (line.startsWith('?') ? `st:100${tail(state)}` : `ok:100${tail(state)}`) })
  await click()
  assert.equal(herdr.raiseWarning(), null)
  assert.deepEqual(kinds(calls), ['precise'], '끊긴 호출은 실패로 치지 않는다(앱 단위 올리기 없음)')
  assert.deepEqual(calls.helper, ['100;0', ...herdr.ASK_WAITS.map(() => '?100')], '권한 창의 답은 계속 기다린다')
  state ={ ...LACK, ae: -1743, vis: 1 }
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_automation')

  // 권한 창을 띄운 적이 없으면(자동화를 이미 허용) 끊겨도 아무것도 읽지 않는다
  const none = rig({ precise: () => { throw new Error('exit null') }, reply: () => `ok:100${tail({ ax: 1, ae: 0 })}` })
  await click()
  assert.deepEqual(none.helper, ['100;0'])
})

test('⑥ 화면 나눠 쓰기를 켰으면(split > 0) 권한이 없어도 예전대로 부른다(그 기능이 권한을 쓴다)', async () => {
  const screens = '0,0,1440,900,0,25,1440,875 1440,0,1920,1080,1440,0,1920,1080'
  const calls = rig({ reply: () => `ok:100:900:${screens}${tail({ ...LACK, vis: 1 })}` })
  await click(33)
  assert.deepEqual(calls.helper, ['100;33'])
  assert.deepEqual(kinds(calls).sort(), ['layout', 'precise'])
  const layout = calls.run.find((c) => c.kind === 'layout')
  assert.deepEqual(layout.args.slice(2), ['900', '100', '33', ...screens.split(' ')], '뒤에 상태가 붙어도 맨 앞 앱 pid·화면 목록을 예전대로 읽는다')
})

test('⑦ 옛 응답 형식(권한 값 없음)·읽지 못한 값·도우미 오류: 예전 동작(매번 정밀 올리기)으로 물러난다', async () => {
  for (const got of ['ok:100', `ok:100${tail({ ax: 1 })}`, `ok:100${tail({ ax: '', ae: '', vis: 1 })}`, `ok:100${tail({ ax: 0, ae: -1744, vis: '' })}`]) {
    const calls = rig({ reply: () => got })
    await click()
    assert.deepEqual(kinds(calls), ['precise'], got)
  }
  // 도우미가 답하지 못했다(시간 초과·죽음): 예전처럼 pid 로 올리는 단발 스크립트 + 정밀 올리기
  for (const got of ['timeout', 'dead', 'err']) {
    const calls = rig({ reply: () => got })
    await click()
    assert.deepEqual(kinds(calls).sort(), ['other', 'precise'], got)
    assert.deepEqual(calls.run.find((c) => c.kind === 'other').args.slice(0, 2), ['-l', 'JavaScript'])
  }
  // 그 프로세스가 사라졌다('none'): 예전 그대로 정밀 올리기만
  const gone = rig({ reply: () => 'none' })
  await click()
  assert.deepEqual(kinds(gone), ['precise'])
})

test('도우미 응답 읽기: 예전 모양은 그대로 읽고, 뒤에 붙은 상태는 따로 읽는다', () => {
  const old = herdr.parseHelperReply('ok:42:7:0,0,10,10,0,0,10,10 5,5,5,5,5,5,5,5')
  assert.deepEqual([old.m[1], old.m[2], old.m[3], old.state, old.own], ['42', '7', '0,0,10,10,0,0,10,10 5,5,5,5,5,5,5,5', null, ''])
  assert.deepEqual(herdr.parseHelperReply('ok:42').state, null)
  assert.deepEqual(herdr.parseHelperReply('none').m, [])
  const neu = herdr.parseHelperReply(`ok:42:7:0,0,10,10,0,0,10,10${tail({ ax: 0, ae: -1743, vis: 0, inst: 1, app: '/Apps/A;B|C=D.app', own: '터미널' })}`)
  assert.deepEqual([neu.m[1], neu.m[2], neu.m[3]], ['42', '7', '0,0,10,10,0,0,10,10'])
  assert.deepEqual(neu.state, { ax: false, ae: -1743, vis: false, inst: 1, app: '/Apps/A;B|C=D.app' })
  assert.equal(neu.own, '터미널')
  assert.deepEqual(herdr.parseHelperReply(`st:42${tail({ ax: 1, ae: 0 })}`).state, { ax: true, ae: 0, vis: null, inst: null, app: '' })
})

test('판정표: 권한을 다 가진 사람·나눠 쓰기·모름은 예전 동작, 권한이 없는 사람만 창이 보이는지로 가른다', () => {
  const P = herdr.raisePlan
  assert.equal(P(null, 0), 'precise')
  assert.equal(P({ ax: true, ae: 0, vis: null }, 0), 'precise')
  assert.equal(P({ ax: false, ae: -1744, vis: true }, 30), 'precise')
  assert.equal(P({ ax: false, ae: -1744, vis: true }, 0), 'skip')
  assert.equal(P({ ax: false, ae: -1744, vis: false }, 0), 'reopen')
  assert.equal(P({ ax: false, ae: 0, vis: true }, 0), 'skip', '자동화만 있고 손쉬운 사용이 없는 사람')
  assert.equal(P({ ax: true, ae: -1744, vis: true }, 0), 'skip', '손쉬운 사용만 있고 자동화는 아직 안 물은 사람')
  assert.equal(P({ ax: true, ae: -1743, vis: false }, 0), 'reopen')
  assert.equal(P({ ax: false, ae: -1744, vis: null }, 0), 'precise', '창이 보이는지 못 읽었으면 예전 동작')
  // System Events 가 떠 있지 않아 자동화 값을 알 수 없을 때(-600): 손쉬운 사용이 있으면 권한을 준 사람으로 보고 예전 동작 그대로,
  // 손쉬운 사용이 없으면 권한이 없는 사람의 길
  assert.equal(P({ ax: true, ae: -600, vis: true }, 0), 'precise')
  assert.equal(P({ ax: false, ae: -600, vis: true }, 0), 'skip')
})

test('더 새 클릭이 있으면 앞 클릭의 "다시 열기 뒤 정밀 올리기"는 하지 않는다', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let clicks = 0
  const calls = { run: [] }
  herdr._setMacOps({
    helper: { send: async (line) => (line.startsWith('?') ? `st:100${tail({ ...LACK, vis: 0 })}` : `ok:100${tail({ ...LACK, vis: ++clicks > 1 ? 1 : 0 })}`) },
    run: async (file, args) => { if (file === '/bin/ps') return PS; calls.run.push({ kind: file === '/usr/bin/open' ? 'reopen' : /System Events/.test(args.join('\n')) ? 'precise' : 'other' }); return '' },
    sleep: () => gate,
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
  await herdr.activateTerminal(SESSION, 0)   // 첫 클릭: 창이 안 보여 다시 열기 → 기다리는 중
  const first = herdr._raiseSettled()
  await herdr.activateTerminal(SESSION, 0)   // 둘째 클릭: 창이 보인다
  release()
  await first
  assert.deepEqual(kinds(calls), ['reopen'], '앞 클릭은 기다림에서 깨어나 물러났다(정밀 올리기 없음)')
})

test('더 새 클릭이 마지막 다시 읽기 도중에 오면(기다림은 다 지난 뒤) 앞 클릭은 정밀 올리기를 부르지 않는다', async () => {
  let release
  const gate = new Promise((r) => { release = r })
  let asked = 0
  let clicks = 0
  const calls = { run: [] }
  herdr._setMacOps({
    helper: { send: async (line) => {
      if (!line.startsWith('?')) return `ok:100${tail({ ...LACK, vis: ++clicks > 1 ? 1 : 0 })}`
      if (++asked === herdr.REOPEN_WAITS.length) await gate   // 마지막 다시 읽기의 답이 늦게 온다
      return `st:100${tail({ ...LACK, vis: 0 })}`
    } },
    run: async (file, args) => { if (file === '/bin/ps') return PS; calls.run.push({ kind: file === '/usr/bin/open' ? 'reopen' : /System Events/.test(args.join('\n')) ? 'precise' : 'other' }); return '' },
    sleep: async () => {},
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
  await herdr.activateTerminal(SESSION, 0)   // 첫 클릭: 창이 안 보여 다시 열기 → 다시 읽는 중
  const first = herdr._raiseSettled()
  while (asked < herdr.REOPEN_WAITS.length) await new Promise((r) => setImmediate(r))
  await herdr.activateTerminal(SESSION, 0)   // 둘째 클릭: 창이 보인다
  release()
  await first
  assert.equal(asked, herdr.REOPEN_WAITS.length)
  assert.deepEqual(kinds(calls), ['reopen'], '끝까지 창이 없었지만 더 새 클릭이 있어 권한 창을 띄우지 않았다')
})

test('F6 권한 대상 앱 이름: 도우미가 알려 준 책임 앱 >서버의 조상 가운데 앱 묶음에서 실행된 첫 프로세스 > 서버 실행 파일 이름', async () => {
  // 조상 찾기(프로세스 목록): 앱 안의 도우미 앱은 건너뛰고 본체 이름을 쓴다. 조상에 앱이 없으면 빈 값.
  const tree = `
    600     1 /Applications/Visual Studio Code.app/Contents/MacOS/Electron
    610   600 /Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper (Plugin).app/Contents/MacOS/Code Helper (Plugin) --type=utility
    611   610 /bin/zsh -il
    612   611 /opt/homebrew/bin/node bin/whosup.mjs
    700     1 /System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal
    702   700 -zsh
    703   702 /opt/homebrew/bin/node bin/whosup.mjs
    900     1 /opt/homebrew/bin/node bin/whosup.mjs
  `
  assert.equal(herdr.ownerAppOf(tree, 612), 'Visual Studio Code')
  assert.equal(herdr.ownerAppOf(tree, 703), 'Terminal')
  assert.equal(herdr.ownerAppOf(tree, 900), '', '부모가 launchd 뿐(로그인 자동 실행·nohup)')
  assert.equal(herdr.ownerAppOf(tree, 12345), '')

  const fail = () => { throw new Error(DENIED_25211) }
  // ③ 조상에 앱이 없고 도우미도 알려 주지 않았다: 서버 실행 파일 이름(코드에 박은 이름이 아니다)
  rig({ reply: () => 'ok:100', precise: fail })
  await click()
  assert.equal(herdr.raiseWarningApp(), basename(process.execPath).replace(/\.exe$/i, ''))
  // ② 이 서버의 조상에 앱이 있다
  rig({ reply: () => 'ok:100', precise: fail, ps: `${PS}\n  ${process.pid}   101 /opt/homebrew/bin/node bin/whosup.mjs\n` })
  await click()
  assert.equal(herdr.raiseWarningApp(), 'Fake Term')
  // ① 도우미가 macOS 에 물어 알려 준 이름이 먼저다(서버 부모가 launchd 로 바뀌었어도 맞는 이름)
  rig({ reply: () => `ok:100${tail({ ax: 0, ae: -1744, vis: 0, inst: 2, app: APP, own: '터미널' })}`, precise: fail })
  await click()
  assert.equal(herdr.raiseWarning(), 'mac_accessibility')
  assert.equal(herdr.raiseWarningApp(), '터미널')
})

test('상주 도우미(JXA) 글: 권한은 묻지 않고 읽고, 예전 응답 머리("ok:<pid>…")는 그대로 둔다', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/runtime/herdr.mjs', import.meta.url), 'utf8')
  const js = src.match(/const MAC_HELPER_JS = `([\s\S]*?)`\nconst WIN_HELPER_PS/)[1]
  assert.match(js, /\$\.AXIsProcessTrusted\(\)/)
  assert.match(js, /AEDeterminePermissionToAutomateTarget\(d\.aeDesc, 0x2a2a2a2a, 0x2a2a2a2a, false\)/, '와일드카드 둘, 묻지 않기(false)')
  assert.match(js, /descriptorWithBundleIdentifier\('com\.apple\.systemevents'\)/)
  assert.doesNotMatch(js, /AXIsProcessTrustedWithOptions|kAXTrustedCheckOptionPrompt/, '권한 창을 띄우는 호출은 쓰지 않는다')
  assert.doesNotMatch(js, /Application\(['"]System Events['"]\)/, '도우미는 System Events 에 아무것도 시키지 않는다')
  assert.match(js, /out = 'ok:' \+ pid \+ extra/, '예전 응답 머리 그대로')
  assert.match(js, /kCGWindowLayer !== 0 \|\| !w\.kCGWindowIsOnscreen/)
  assert.match(js, /b\.Width >= 80 && b\.Height >= 40/)
  assert.doesNotMatch(js, /\$\{/, '템플릿 글 안에 끼워 넣기가 없다')
})

// ── Codex 리뷰 반영(2026-11-14) ── 연타·늦은 답·여러 벌. 대역의 답과 완료 시점을 시험이 쥐고 순서를 만든다.
const defer = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b }); return { promise, resolve, reject } }
const tick = () => new Promise((r) => setImmediate(r))
const waitFor = async (cond, what) => { for (let i = 0; i < 5000 && !cond(); i++) await tick(); assert.ok(cond(), what) }
const drain = async () => { for (let i = 0; i < 20; i++) await tick() }   // 늦게 끝난 호출 뒤에 이어지는 일(기다리지 않는 호출)까지 지나가게
// 누르기만 하고(응답까지) 뒤에 이어지는 일은 기다리지 않는다 — 앞 클릭의 정밀 올리기가 아직 끝나지 않은 상태를 만든다.
const press = (session = SESSION) => herdr.activateTerminal(session, 0)

test('리뷰 1: 앞 클릭의 정밀 올리기가 늦게 성공해도 더 새 클릭이 올린 경고를 지우지 않는다(최신 클릭의 성공은 예전대로 지운다)', async () => {
  const seen = []
  const off = herdr.onRaiseWarning((k) => seen.push(k))
  try {
    const slow = defer()
    let n = 0
    const calls = rig({ reply: () => 'ok:100', precise: () => { n++; if (n === 1) return slow.promise; if (n === 2) throw new Error(DENIED_25211); return '100' } })
    await press()                                        // 클릭 A: 정밀 올리기가 아직 안 끝났다
    await click()                                        // 클릭 B: 손쉬운 사용 없음(-25211)으로 실패 → 경고
    assert.equal(herdr.raiseWarning(), 'mac_accessibility')
    slow.resolve('100'); await drain()                   // A 가 이제야 성공으로 끝난다
    assert.equal(herdr.raiseWarning(), 'mac_accessibility', '앞 클릭의 늦은 성공이 더 새 클릭의 경고를 지우지 않는다')
    assert.deepEqual(seen, ['mac_accessibility'], '보드에 "경고 없음"을 알린 적이 없다')
    assert.deepEqual(kinds(calls), ['precise', 'precise', 'app-activate'])
    await click()                                        // 클릭 C: 가장 새 클릭이 성공한다
    assert.equal(herdr.raiseWarning(), null, '"정밀 올리기가 성공하면 지운다"는 그대로다 — 최신 클릭의 성공')
  } finally { off() }
})

test('리뷰 1: 앞 클릭의 정밀 올리기가 늦게 실패해도 경고를 올리지 않고 앱도 다시 앞으로 올리지 않는다', async () => {
  for (const late of [DENIED_25211, DENIED_1743, TIMED_OUT]) {
    const slow = defer()
    let n = 0
    const calls = rig({ reply: () => 'ok:100', precise: () => (++n === 1 ? slow.promise : '100') })
    await press()                                        // 클릭 A: 아직 안 끝났다
    await click()                                        // 클릭 B: 성공
    slow.reject(new Error(late)); await drain()          // A 가 이제야 실패로 끝난다
    assert.equal(herdr.raiseWarning(), null, late)
    assert.deepEqual(kinds(calls), ['precise', 'precise'], `더 새 클릭이 올린 창 위로 앞 클릭의 앱을 올리지 않는다: ${late}`)
  }
})

test('리뷰 1: 도우미의 답을 기다리는 사이에 더 새 클릭이 왔으면 앞 클릭은 물러난다(경고·올리기·다시 열기·다시 묻기 없음)', async () => {
  const answers = [
    `ok:100${tail({ ax: 1, ae: 0 })}`,                    // 권한을 다 가진 사람의 답: 예전에는 정밀 올리기 → 성공하면서 경고를 지웠다
    `ok:100${tail({ ...LACK, ax: 1, vis: 1 })}`,          // "손쉬운 사용이 생겼다": 예전에는 여기서 손쉬운 사용 경고를 지웠다
    `ok:100${tail({ ...LACK, vis: 0 })}`,                 // 보이는 창 없음: 예전에는 다시 열기
    `ok:100:900:0,0,10,10,0,0,10,10${tail({ ax: 1, ae: 0 })}`,
    'ok:100', 'err', 'timeout', 'dead', 'none',
    'late', `ok:999${tail({ ...LACK, vis: 0 })}`,         // 제 답이 아니다: 더 새 클릭이 있으면 다시 묻지도 않는다
  ]
  for (const answer of answers) {
    const slow = defer()
    const calls = { helper: [], run: [] }
    herdr._setMacOps({
      helper: { send: async (line) => { calls.helper.push(line); return calls.helper.length === 1 ? slow.promise : 'ok:100' } },
      run: async (file, args) => {
        if (file === '/bin/ps') return PS
        const script = args.join('\n')
        calls.run.push(file === '/usr/bin/open' ? 'reopen' : /to activate/.test(script) ? 'app-activate' : /System Events/.test(script) ? 'precise' : 'other')
        if (/AXRaise/.test(script)) throw new Error(DENIED_25211)
        return ''
      },
      sleep: async () => {},
    })
    herdr.setFrontApp('')
    _setPlatform('darwin')
    const a = press()                                    // 클릭 A: 도우미의 답이 늦는다
    await waitFor(() => calls.helper.length >= 1, '클릭 A 가 도우미에 물었다')
    await click()                                        // 클릭 B: 손쉬운 사용 없음으로 실패 → 경고
    assert.equal(herdr.raiseWarning(), 'mac_accessibility', answer)
    const before = [...calls.run]
    slow.resolve(answer)                                 // A 의 답이 이제야 온다
    assert.equal(await a, 'raised')
    await drain()
    assert.deepEqual(calls.run, before, `앞 클릭은 더 부르지 않는다: ${answer}`)
    assert.equal(herdr.raiseWarning(), 'mac_accessibility', `더 새 클릭의 경고가 남아 있다: ${answer}`)
    assert.deepEqual(calls.helper, ['100;0', '100;0'], `다시 묻지도 않는다: ${answer}`)
  }
})

test('리뷰 1·2: 앞 클릭의 늦은 완료는 더 새 클릭이 띄운 권한 창의 기다림을 끝내지 않는다 — 그 뒤의 거부를 놓치지 않는다', async () => {
  const HID = { ...LACK, inst: 2, vis: 0 }               // 권한 없음·보이는 창 없음·여러 벌 → 곧바로 정밀 올리기(권한 창이 뜬다)
  for (const first of ['ok', DENIED_25211]) {
    const a = defer(); const b = defer()
    let n = 0
    let ae = -1744
    const calls = rig({ precise: () => (++n === 1 ? a.promise : b.promise), reply: (line) => (line.startsWith('?') ? `st:100${tail({ ...HID, ae })}` : `ok:100${tail(HID)}`) })
    await press()                                        // 클릭 A: 권한 창이 떴다
    await press()                                        // 클릭 B: 정밀 올리기를 다시 불렀다 — 권한 창의 답은 이제 B 가 기다린다
    if (first === 'ok') a.resolve('100'); else a.reject(new Error(first))
    await drain()                                        // A 가 늦게 끝났다(더 새 클릭 B 가 있다)
    assert.deepEqual(calls.helper, ['100;0', '100;0'], `B 의 기다림이다: A 는 지우지도, 대신 읽지도 않는다(${first})`)
    assert.equal(herdr.raiseWarning(), null)
    ae = -1743                                           // 사람이 "허용 안 함"을 눌렀다
    b.reject(new Error(TIMED_OUT)); await herdr._raiseSettled(); await drain()   // B 는 답 없이 4초에 끊겼다
    assert.deepEqual(calls.helper, ['100;0', '100;0', '?100'], 'B 가 도우미로 답을 읽는다')
    assert.equal(herdr.raiseWarning(), 'mac_automation', `거부가 보드에 오른다(${first})`)
  }
})

test('리뷰 1: 더 새 클릭에 밀린 앞 클릭이 거부로 끝나면, 그 옛 값이 아니라 도우미가 지금 읽은 값으로 판단한다', async () => {
  const HID = { ...LACK, inst: 2, vis: 0 }
  for (const [now, want] of [[-1743, 'mac_automation'], [0, null]]) {
    const a = defer()
    let state = HID
    const calls = rig({ precise: () => a.promise, reply: (line) => (line.startsWith('?') ? `st:100${tail(state)}` : `ok:100${tail(state)}`) })
    await press()                                        // 클릭 A: 권한 창이 떴다(답을 기다린다)
    state = { ...LACK, vis: 1 }
    await click()                                        // 클릭 B: 창이 보인다 — 아무것도 부르지 않는다
    assert.deepEqual(kinds(calls), ['precise'])
    state = { ...LACK, vis: 1, ae: now }
    a.reject(new Error(DENIED_1743)); await drain()      // A 가 이제야 "거부"로 끝난다
    assert.deepEqual(kinds(calls), ['precise'], '밀린 클릭은 앱을 앞으로 올리지 않는다')
    assert.deepEqual(calls.helper, ['100;0', '100;0', '?100'], '기다리던 답은 도우미로 읽는다')
    assert.equal(herdr.raiseWarning(), want, `지금 값 ${now}`)
  }
})

test('리뷰 2: 도우미의 답이 이번 요청의 것이 아니면(pid 가 다르다) 버리고 한 번 더 묻는다 — 다른 터미널의 창 상태로 판정하지 않는다', async () => {
  // 올리기 줄: 앞서 시간 초과된 다른 요청의 늦은 답(pid 999, 보이는 창 없음)이 먼저 온다
  for (const stray of [`ok:999${tail({ ...LACK, inst: 2, vis: 0 })}`, `st:100${tail({ ...LACK, inst: 2, vis: 0 })}`]) {
    const calls = rig({ reply: (line, n) => (n === 1 ? stray : `ok:100${tail({ ...LACK, vis: 1 })}`) })
    assert.equal(await click(), 'raised')
    assert.deepEqual(calls.helper, ['100;0', '100;0'], '같은 줄을 한 번 더 보냈다')
    assert.deepEqual(calls.run, [], `제 답(창이 보인다)으로 판정했다: 권한 창 0개 — ${stray.slice(0, 6)}`)
  }
  // 다시 물어도 제 답이 아니면 "모름": 도우미가 답하지 못했을 때와 같다(예전 동작). 남의 pid 를 올리지는 않는다
  const twice = rig({ reply: () => `ok:999${tail({ ...LACK, vis: 1 })}` })
  await click()
  assert.deepEqual(twice.helper, ['100;0', '100;0'], '두 번까지만 묻는다')
  assert.deepEqual(kinds(twice).sort(), ['other', 'precise'])
  assert.ok(twice.run.every((c) => c.args.at(-1) === '100'), '후보가 아닌 pid(999)로는 아무것도 부르지 않는다')
})

test('리뷰 2: 늦은 답 뒤에 서느라 제 답을 못 받았으면(late) 한 번 더 물어본 뒤 판단한다 — 곧바로 권한 창 길로 가지 않는다', async () => {
  const again = rig({ reply: (line, n) => (n === 1 ? 'late' : `ok:100${tail({ ...LACK, vis: 1 })}`) })
  await click()
  assert.deepEqual(again.helper, ['100;0', '100;0'])
  assert.deepEqual(again.run, [], '다시 물어 창이 보이는 것을 알았다: System Events 를 부르지 않는다')
  // 다시 물어도 못 받았으면 예전 동작(pid 로 올리는 단발 스크립트 + 정밀 올리기)
  const never = rig({ reply: () => 'late' })
  await click()
  assert.deepEqual(never.helper, ['100;0', '100;0'])
  assert.deepEqual(kinds(never).sort(), ['other', 'precise'])
  // 도우미가 그냥 답하지 못한 것(시간 초과·죽음)은 다시 묻지 않는다 — 클릭이 그만큼 더 늦어지지 않게(예전 그대로)
  for (const got of ['timeout', 'dead', 'err', 'none']) {
    const plain = rig({ reply: () => got })
    await click()
    assert.deepEqual(plain.helper, ['100;0'], got)
  }
})

test('리뷰 2: 상태만 읽는 "?<pid>"의 답도 그 pid 의 것만 믿는다(다시 열기 뒤 창 확인, 권한 창의 답 읽기)', async () => {
  // 다시 열기 뒤: 다른 터미널(pid 999)의 "창이 보인다"를 이 세션의 것으로 믿지 않는다
  const reopen = rig({ reply: (line, n) => (!line.startsWith('?') ? `ok:100${tail({ ...LACK, vis: 0 })}` : n === 2 ? `st:999${tail({ ...LACK, vis: 1 })}` : `st:100${tail({ ...LACK, vis: 0 })}`) })
  await click()
  assert.deepEqual(reopen.helper, ['100;0', '?100', '?100', ...herdr.REOPEN_WAITS.slice(1).map(() => '?100')], '남의 답은 버리고 곧바로 다시 물었다')
  assert.deepEqual(kinds(reopen), ['reopen', 'precise'], '이 세션의 창은 끝내 안 보였다: 정밀 올리기까지 간다')
  // 권한 창의 답 읽기: 남의 답(거부)으로 경고를 올리지 않는다
  const HID = { ...LACK, inst: 2, vis: 0 }
  const watch = rig({ precise: timeout, reply: (line, n) => (!line.startsWith('?') ? `ok:100${tail(HID)}` : n === 2 ? `ok:100${tail({ ...HID, ae: -1743 })}` : n === 3 ? `st:999${tail({ ...HID, ae: -1743 })}` : `st:100${tail(HID)}`) })
  await click()
  assert.equal(herdr.raiseWarning(), null, '제 답은 끝까지 "아직 안 고름"이었다')
  assert.deepEqual(watch.helper, ['100;0', '?100', '?100', ...herdr.ASK_WAITS.slice(1).map(() => '?100')])
})

// 같은 세션(desk1)을 보여 주는 터미널 앱이 두 벌: 200(더 새 클라이언트), 100
const PS_TWO = `${PS}
  200     1 ${APP}/Contents/MacOS/faketerm
  201   200 -zsh
  202   201 /opt/homebrew/bin/herdr --session ${SESSION}
`
test('리뷰 3: 권한 없는 사람 — 고른 벌(가장 큰 창)에 보이는 창이 없고 다른 벌의 창이 보이면 그 벌을 올리고 System Events 를 부르지 않는다', async () => {
  const TWO = { ...LACK, inst: 2 }
  const state = (pid, vis) => tail({ ...TWO, vis })
  // 도우미는 창이 가장 큰 벌(100)을 골랐다 — 그 창은 숨어 있다. 200 의 창은 화면에 보인다
  const calls = rig({ ps: PS_TWO, reply: (line) => (line === '?200' ? `st:200${state(200, 1)}` : line === '200;0' ? `ok:200${state(200, 1)}` : `ok:100${state(100, 0)}`) })
  assert.equal(await click(), 'raised')
  assert.deepEqual(calls.helper, ['200,100;0', '?200', '200;0'], '다른 벌의 창을 읽어 보고, 보이면 그 벌을 pid 로 앞으로 올린다')
  assert.deepEqual(calls.run, [], '권한 창 0개: System Events 도 다시 열기도 없다')
  assert.equal(herdr.raiseWarning(), null)

  // 자동화를 이미 거부한 사람도 같다: 세션이 화면에 있으니 경고를 올릴 순간이 아니다
  const denied = rig({ ps: PS_TWO, reply: (line) => (line === '?200' ? `st:200${tail({ ...TWO, ae: -1743, vis: 1 })}` : line === '200;0' ? `ok:200${tail({ ...TWO, ae: -1743, vis: 1 })}` : `ok:100${tail({ ...TWO, ae: -1743, vis: 0 })}`) })
  await click()
  assert.deepEqual(denied.run, [])
  assert.equal(herdr.raiseWarning(), null)

  // 다른 벌에도 보이는 창이 없으면 예전대로: 고른 벌에 정밀 올리기("필요해진 순간")
  const none = rig({ ps: PS_TWO, reply: (line) => (line.startsWith('?') ? `st:200${state(200, 0)}` : `ok:100${state(100, 0)}`) })
  await click()
  assert.deepEqual(none.helper, ['200,100;0', '?200'])
  assert.deepEqual(kinds(none), ['precise'])
  assert.equal(none.run[0].args.at(-1), '100', '고른 벌(가장 큰 창)을 펼친다')

  // 다른 벌의 창 상태를 못 읽었거나(모름) 올리지 못했으면 예전 길로 간다
  for (const [q, up] of [['none', ''], ['timeout', ''], [`st:200${state(200, 1)}`, 'none']]) {
    const c = rig({ ps: PS_TWO, reply: (line) => (line === '?200' ? q : line === '200;0' ? up : `ok:100${state(100, 0)}`) })
    await click()
    assert.deepEqual(kinds(c), ['precise'], `${q.slice(0, 7)} / ${up}`)
  }
})

test('리뷰 3: 권한을 다 가진 사람의 고르기는 그대로다 — 가장 큰 창의 벌을 정밀 올리기로 펼친다(다른 벌을 읽지 않는다). 화면 나눠 쓰기도 그대로', async () => {
  const full = rig({ ps: PS_TWO, reply: () => `ok:100${tail({ ax: 1, ae: 0 })}` })
  await click()
  assert.deepEqual(full.helper, ['200,100;0'], '도우미에 보내는 줄은 예전 그대로, 더 묻지 않는다')
  assert.deepEqual(kinds(full), ['precise'])
  assert.deepEqual([full.run[0].args[0], full.run[0].args[2], full.run[0].args.length], ['-e', '100', 3], '도우미가 고른 벌 하나만 넘긴다')

  const split = rig({ ps: PS_TWO, reply: () => `ok:100:900:0,0,1440,900,0,25,1440,875${tail({ ...LACK, inst: 2, vis: 0 })}` })
  await click(33)
  assert.deepEqual(split.helper, ['200,100;33'])
  assert.deepEqual(kinds(split).sort(), ['layout', 'precise'])

  // 고른 벌의 창이 보이면(권한 없는 사람) 예전처럼 거기서 끝난다
  const shown = rig({ ps: PS_TWO, reply: () => `ok:100${tail({ ...LACK, inst: 2, vis: 1 })}` })
  await click()
  assert.deepEqual(shown.helper, ['200,100;0'])
  assert.deepEqual(shown.run, [])
})

test('리뷰 3: 다른 벌을 읽는 사이에 더 새 클릭이 왔으면 그 벌을 올리지 않는다', async () => {
  const slow = defer()
  const sent = []
  let clicks = 0
  herdr._setMacOps({
    helper: { send: async (line) => { sent.push(line); if (line === '?200') return slow.promise; return line.startsWith('200,100') ? `ok:100${tail({ ...LACK, inst: 2, vis: ++clicks > 1 ? 1 : 0 })}` : `ok:200${tail({ ...LACK, inst: 2, vis: 1 })}` } },
    run: async (file) => (file === '/bin/ps' ? PS_TWO : ''),
    sleep: async () => {},
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
  await press()                                          // 클릭 A: 고른 벌의 창이 안 보여 다른 벌(200)을 읽는 중
  const first = herdr._raiseSettled()
  await waitFor(() => sent.includes('?200'), '클릭 A 가 다른 벌(200)을 읽는 중이다')
  await click()                                          // 클릭 B: 이번에는 고른 벌의 창이 보인다
  slow.resolve(`st:200${tail({ ...LACK, inst: 2, vis: 1 })}`)
  await first; await drain()
  assert.deepEqual(sent, ['200,100;0', '?200', '200,100;0'], '앞 클릭은 200 을 올리지 않았다')
})

// ── 독립 리뷰가 짚은 빈 곳(X6·X9) ── 권한 창의 기다림(askPending)이 "더 앞 클릭의 것"일 때. 클릭 A 가 권한 창을 띄우고(기다림 = A 의
// 순번), 더 새 클릭 B 는 도우미에서 권한 값을 듣지 못해(옛 응답 형식) 예전처럼 정밀 올리기를 부른다 — B 는 기다림을 제 것으로 바꾸지
// 않는다(권한 창을 띄웠는지 모른다). 그 B 가 답 없이 끝났을 때, A 가 띄운 권한 창의 답은 여전히 도우미로 읽어야 한다.
const ASKED = { ...LACK, inst: 2, vis: 0 }                 // 권한 없음·보이는 창 없음·여러 벌 → 곧바로 정밀 올리기(권한 창이 뜬다)
// 대역: 정밀 올리기는 부른 순서대로 ends[n] 을 따른다(defer = 시험이 끝내는 때를 쥔다, 글 = 그 오류로 바로 실패, null = 바로 성공).
// 도우미는 replies[n](n 번째 올리기 줄)로 답하고, 상태 읽기("?")에는 지금의 자동화 값(ae())으로 답한다.
function askRig({ ends, replies, ae }) {
  let n = 0
  let k = 0
  const calls = rig({
    precise: () => { const e = ends[n++]; if (e && typeof e === 'object') return e.promise; if (e) throw new Error(e); return '100' },
    reply: (line) => (line.startsWith('?') ? `st:100${tail({ ...ASKED, ae: ae() })}` : replies[k++]),
  })
  return { calls, precises: () => n }
}

test('X6 더 새 클릭에 밀리거나 끊긴 정밀 올리기: 권한 창의 기다림이 더 앞 클릭의 것이어도 도우미로 이어 읽는다 — 그 뒤의 거부를 놓치지 않는다', async () => {
  // (가) 클릭 B 의 정밀 올리기가 끊겼다(exit null — 가장 새 클릭이어도 끊긴 호출은 답을 들은 것이 아니다)
  {
    const a = defer()
    let ae = -1744
    const { calls, precises } = askRig({ ends: [a, 'exit null'], replies: [`ok:100${tail(ASKED)}`, 'ok:100'], ae: () => ae })
    await press()                                        // 클릭 A: 권한 창이 떴다(기다림 = A)
    await waitFor(() => precises() === 1, '클릭 A 가 정밀 올리기를 불렀다')
    ae = -1743                                           // 사람이 "허용 안 함"을 눌렀다
    await click()                                        // 클릭 B: 권한 값을 못 들었다 → 정밀 올리기 → 끊겼다
    assert.deepEqual(kinds(calls), ['precise', 'precise'], '끊긴 호출은 실패로 치지 않는다(앱 단위 올리기 없음)')
    assert.deepEqual(calls.helper, ['100;0', '100;0', '?100'], 'A 가 띄운 권한 창의 답을 B 가 끝나면서 도우미로 읽는다')
    assert.deepEqual(calls.slept, herdr.ASK_WAITS.slice(0, 1))
    assert.equal(herdr.raiseWarning(), 'mac_automation', '거부가 보드에 오른다')
    a.reject(new Error(TIMED_OUT)); await drain()        // A 가 이제야 끝난다: 더 할 일이 없다
    assert.deepEqual([calls.helper.length, kinds(calls), herdr.raiseWarning()], [3, ['precise', 'precise'], 'mac_automation'])
  }
  // (나) 클릭 B 의 정밀 올리기가 더 새 클릭 C 에 밀린 뒤에 끝났다(성공이든 실패든): 경고·앱 올리기는 C 의 몫이고, 기다리던 답만 읽는다
  for (const late of [null, TIMED_OUT, DENIED_25211]) {
    const a = defer(); const b = defer()
    let ae = -1744
    const { calls, precises } = askRig({ ends: [a, b], replies: [`ok:100${tail(ASKED)}`, 'ok:100', `ok:100${tail({ ...LACK, vis: 1 })}`], ae: () => ae })
    await press()                                        // 클릭 A: 권한 창이 떴다(기다림 = A)
    await waitFor(() => precises() === 1, '클릭 A 가 정밀 올리기를 불렀다')
    await press()                                        // 클릭 B: 권한 값을 못 들었다 → 정밀 올리기(아직 안 끝났다)
    await waitFor(() => precises() === 2, '클릭 B 가 정밀 올리기를 불렀다')
    await click()                                        // 클릭 C: 창이 보인다 — 아무것도 부르지 않는다. 아직 고르지 않았다(-1744): 기다림은 그대로
    assert.deepEqual([calls.helper, kinds(calls), herdr.raiseWarning()], [['100;0', '100;0', '100;0'], ['precise', 'precise'], null])
    ae = -1743                                           // 사람이 "허용 안 함"을 눌렀다
    if (late) b.reject(new Error(late)); else b.resolve('100')
    await drain()                                        // B 가 이제야 끝난다(더 새 클릭 C 가 있다)
    assert.deepEqual(calls.helper, ['100;0', '100;0', '100;0', '?100'], `B 보다 앞선 클릭(A)의 기다림도 이어 읽는다: ${late}`)
    assert.equal(herdr.raiseWarning(), 'mac_automation', `거부가 보드에 오른다: ${late}`)
    assert.deepEqual(kinds(calls), ['precise', 'precise'], `밀린 클릭은 앱을 앞으로 올리지 않는다: ${late}`)
    a.reject(new Error(TIMED_OUT)); await drain()
    assert.equal(calls.helper.length, 4, '답을 들은 뒤에는 더 읽지 않는다')
  }
})

test('X9 가장 새 클릭의 정밀 올리기가 답 없이 실패했다(시간 초과): 기다리던 권한 창이 더 앞 클릭이 띄운 것이어도 도우미로 답을 읽는다. 기다리는 것이 없으면 읽지 않는다', async () => {
  const seen = []
  const off = herdr.onRaiseWarning((k) => seen.push(k))
  try {
    const a = defer()
    let ae = -1744
    const { calls, precises } = askRig({ ends: [a, TIMED_OUT], replies: [`ok:100${tail(ASKED)}`, 'ok:100'], ae: () => ae })
    await press()                                        // 클릭 A: 권한 창이 떴다(기다림 = A)
    await waitFor(() => precises() === 1, '클릭 A 가 정밀 올리기를 불렀다')
    ae = -1743                                           // 사람이 "허용 안 함"을 눌렀다
    await click()                                        // 클릭 B(가장 새 클릭): 권한 값을 못 들었다 → 정밀 올리기 → 4초에 답 없이 끝났다
    assert.deepEqual(kinds(calls), ['precise', 'precise', 'app-activate'], '실패하면 예전처럼 앱 단위로라도 앞으로')
    assert.deepEqual(calls.helper, ['100;0', '100;0', '?100'], 'A 가 띄운 권한 창의 답을 도우미로 읽는다')
    assert.deepEqual(calls.slept, herdr.ASK_WAITS.slice(0, 1))
    assert.equal(herdr.raiseWarning(), 'mac_automation')
    assert.deepEqual(seen, ['mac_automation'], '듣는 쪽(보드 서버)에 알린다')
    a.reject(new Error(TIMED_OUT)); await drain()
    assert.deepEqual([calls.helper.length, kinds(calls)], [3, ['precise', 'precise', 'app-activate']], '늦게 끝난 A 는 더 하지 않는다')
  } finally { off() }

  // 기다리는 권한 창이 없으면(아무도 띄우지 않았다) 같은 실패에서 아무것도 읽지 않는다 — 예전 동작 그대로
  const { calls: quiet } = askRig({ ends: [TIMED_OUT], replies: ['ok:100'], ae: () => -1743 })
  await click()
  assert.deepEqual([quiet.helper, quiet.slept, kinds(quiet), herdr.raiseWarning()], [['100;0'], [], ['precise', 'app-activate'], null])
})
