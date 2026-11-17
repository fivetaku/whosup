// 상주 도우미(osascript JXA) 글을 osascript 없이 돌려 본다: macOS 다리($·ObjC)를 대역으로 바꾼 node:vm 안에서 실행해
// 한 줄을 받아 한 줄로 답하는 규칙·권한을 묻지 않고 읽는 호출·"화면에 보이는 보통 크기 창" 판정을 확인한다.
// 여기서 보는 것은 도우미의 자바스크립트 논리다 — 실제 macOS 호출이 그렇게 답하는지는 실기기(맥북에어)에서 따로 확인한다.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

const herdr = await import('../src/runtime/herdr.mjs')
const JS = herdr._macHelperSource()

const TERMINAL = { bundleIdentifier: 'com.apple.Terminal', path: '/System/Applications/Utilities/Terminal.app', localizedName: '터미널', instances: 1 }
const win = (pid, w, h, on, more = {}) => ({ kCGWindowOwnerPID: pid, kCGWindowLayer: 0, kCGWindowAlpha: 1, kCGWindowBounds: { X: 0, Y: 0, Width: w, Height: h }, ...(on ? { kCGWindowIsOnscreen: true } : {}), ...more })
// 맥북에어 실측(2026-11-14): Terminal.app 은 창이 보일 때도 숨은 창 여섯 개가 화면 밖(on=0)으로 나온다.
const HIDDEN = (pid) => [win(pid, 260, 251, false), win(pid, 500, 500, false), ...[1, 2, 3, 4].map(() => win(pid, 1280, 29, false))]

// lines: 도우미가 받는 줄들. 돌려주는 것: 도우미가 쓴 줄들(첫 줄 'ready' 제외)과 불린 것들.
function sim(lines, { ax = false, ae = -1744, wins = [], apps = { 700: TERMINAL }, respPid = 700, broken = [], clock = { t: 1_000_000 } } = {}) {
  const seen = { out: [], activated: [], aeArgs: [], winReads: 0, descriptors: [], bound: [] }
  const nil = { isNil: () => true }
  const appOf = (pid) => (apps[pid] ? {
    isNil: () => false, activateWithOptions: (o) => seen.activated.push([pid, o]),
    bundleIdentifier: apps[pid].bundleIdentifier, bundleURL: { path: apps[pid].path }, localizedName: apps[pid].localizedName,
  } : nil)
  const chunks = [{ length: 1, text: `${lines.join('\n')}\n` }, { length: 0, text: '' }]
  const $ = (text) => ({ dataUsingEncoding: () => ({ text }) })
  Object.assign($, {
    NSUTF8StringEncoding: 4, kCGWindowListOptionAll: 0, NSApplicationActivateAllWindows: 2,
    NSFileHandle: { fileHandleWithStandardInput: { get availableData() { return chunks.shift() } }, fileHandleWithStandardOutput: { writeData: (d) => seen.out.push(d.text.replace(/\n$/, '')) } },
    NSString: { alloc: { initWithDataEncoding: (d) => ({ js: d.text }) } },
    CGWindowListCopyWindowInfo: () => { seen.winReads++; if (broken.includes('wins')) throw new Error('no window list'); return wins },
    AXIsProcessTrusted: () => { if (broken.includes('ax')) throw new Error('no AX'); return ax },
    NSAppleEventDescriptor: { descriptorWithBundleIdentifier: (id) => { seen.descriptors.push(id); return { aeDesc: { id } } } },
    NSProcessInfo: { processInfo: { processIdentifier: 4242 } },
    NSRunningApplication: { runningApplicationWithProcessIdentifier: appOf, runningApplicationsWithBundleIdentifier: (bid) => ({ count: Object.values(apps).find((a) => a.bundleIdentifier === bid)?.instances ?? 0 }) },
    NSWorkspace: { sharedWorkspace: { frontmostApplication: { processIdentifier: 900 } } },
    NSScreen: { screens: Object.assign([{ frame: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 900 } }, visibleFrame: { origin: { x: 0, y: 0 }, size: { width: 1440, height: 875 } } }], { objectAtIndex(i) { return this[i] } }) },
  })
  const ObjC = {
    import: () => {}, unwrap: (x) => x, deepUnwrap: (x) => x, castRefToObject: (x) => x,
    bindFunction: (name) => {
      seen.bound.push(name)
      if (broken.includes(name)) throw new Error(`cannot bind ${name}`)
      if (name === 'AEDeterminePermissionToAutomateTarget') $[name] = (...a) => { seen.aeArgs.push(a); return typeof ae === 'function' ? ae() : ae }
      if (name === 'responsibility_get_pid_responsible_for_pid') $[name] = (pid) => { assert.equal(pid, 4242); return respPid }
    },
  }
  const ctx = vm.createContext({ $, ObjC, Date: { now: () => clock.t }, encodeURIComponent, String, Number, Math })
  vm.runInContext(`${JS}\n;run()`, ctx)
  assert.equal(seen.out.shift(), 'ready')
  return seen
}
const stateOf = (line) => herdr.parseHelperReply(line)

test('도우미: 권한 없는 사람·창이 보임 — 권한은 묻지 않고 읽고(와일드카드·묻지 않기), 보이는 보통 크기 창이 있다고 답한다', () => {
  const s = sim(['700;0'], { wins: [...HIDDEN(700), win(700, 636, 803, true)] })
  assert.equal(s.out.length, 1)
  assert.match(s.out[0], /^ok:700\|/, '예전 응답 머리 그대로')
  assert.deepEqual(s.activated, [[700, 2]], 'pid 로 앞으로 올리기는 예전 그대로')
  assert.deepEqual(s.descriptors, ['com.apple.systemevents'])
  assert.deepEqual(s.aeArgs, [[{ id: 'com.apple.systemevents' }, 0x2a2a2a2a, 0x2a2a2a2a, false]], '와일드카드 둘, 묻지 않기')
  const r = stateOf(s.out[0])
  assert.deepEqual(r.state, { ax: false, ae: -1744, vis: true, inst: 1, app: TERMINAL.path })
  assert.equal(r.own, '터미널', 'macOS 권한 창이 말하는 주체(책임 앱)의 이름')
  assert.equal(herdr.raisePlan(r.state, 0), 'skip')
})

test('도우미: 최소화하면 본 창도 화면 밖 — 보이는 창이 없다고 답한다(숨은 창·띠·점·투명 창·다른 프로세스의 창은 세지 않는다)', () => {
  const min = stateOf(sim(['700;0'], { wins: [...HIDDEN(700), win(700, 636, 803, false)] }).out[0]).state
  assert.equal(min.vis, false)
  assert.equal(herdr.raisePlan(min, 0), 'reopen')
  const noise = [
    win(700, 1280, 29, true),                              // 화면에 걸친 띠(제목 막대 높이)
    win(700, 1, 1, true), win(700, 40, 600, true),         // 점 같은 창, 세로 띠
    win(700, 800, 600, true, { kCGWindowAlpha: 0 }),       // 투명한 창
    win(700, 800, 600, true, { kCGWindowLayer: 25 }),      // 층 0 이 아닌 것(메뉴·떠 있는 판)
    win(701, 800, 600, true),                              // 다른 프로세스의 창
  ]
  assert.equal(stateOf(sim(['700;0'], { wins: noise }).out[0]).state.vis, false)
  // 작은 터미널 창(제목 막대 + 글자 몇 줄)은 놓치지 않는다
  assert.equal(stateOf(sim(['700;0'], { wins: [...noise, win(700, 90, 45, true)] }).out[0]).state.vis, true)
  assert.equal(stateOf(sim(['700;0'], { wins: [win(700, 80, 40, true)] }).out[0]).state.vis, true, '기준: 폭 80·높이 40 이상')
  assert.equal(stateOf(sim(['700;0'], { wins: [win(700, 79, 400, true), win(700, 400, 39, true)] }).out[0]).state.vis, false)
})

test('도우미: 권한을 다 가진 사람 — 창 목록을 읽지 않고, 30초 동안은 권한도 다시 묻지 않는다', () => {
  const clock = { t: 5_000_000 }
  let asked = 0
  const s = sim(['700;0', '700;0'], { ax: true, ae: () => { asked++; return 0 }, clock })
  assert.deepEqual(s.out, ['ok:700|ax=1;ae=0;own=%ED%84%B0%EB%AF%B8%EB%84%90', 'ok:700|ax=1;ae=0;own=%ED%84%B0%EB%AF%B8%EB%84%90'])
  assert.equal(s.winReads, 0)
  assert.equal(asked, 1, '두 번째 클릭은 방금 본 값을 쓴다')
  assert.equal(herdr.raisePlan(stateOf(s.out[0]).state, 0), 'precise')
  assert.deepEqual(s.bound.filter((n) => n === 'responsibility_get_pid_responsible_for_pid').length, 1, '책임 앱 이름은 한 번만 찾는다')
})

test('도우미: 화면 나눠 쓰기 줄(pct > 0)은 예전 모양(맨 앞 앱 pid·화면 목록) 뒤에 상태를 붙인다', () => {
  const s = sim(['700;33'], { wins: [win(700, 636, 803, true)] })
  const r = stateOf(s.out[0])
  assert.deepEqual([r.m[1], r.m[2], r.m[3]], ['700', '900', '0,0,1440,900,0,25,1440,875'])
  assert.equal(r.state.vis, true)
  assert.equal(herdr.raisePlan(r.state, 33), 'precise')
})

test('도우미: "?<pid>"는 올리지 않고 상태만 답한다. 없는 프로세스는 예전처럼 none', () => {
  const s = sim(['?700', '?999', '999;0'], { ae: -1743, wins: [win(700, 636, 803, true)] })
  assert.match(s.out[0], /^st:700\|/)
  assert.deepEqual(stateOf(s.out[0]).state, { ax: false, ae: -1743, vis: true, inst: 1, app: TERMINAL.path })
  assert.deepEqual(s.out.slice(1), ['none', 'none'])
  assert.deepEqual(s.activated, [], '상태만 읽을 때는 아무 앱도 올리지 않는다')
})

test('도우미: 읽지 못한 값은 비워 답한다 — 서버는 그 응답을 "모름"으로 보고 예전 동작으로 물러난다. 올리기 자체는 그대로 된다', () => {
  for (const broken of [['ax'], ['AEDeterminePermissionToAutomateTarget'], ['wins']]) {
    const s = sim(['700;0'], { broken, wins: [win(700, 636, 803, true)] })
    assert.match(s.out[0], /^ok:700\|/, String(broken))
    assert.deepEqual(s.activated, [[700, 2]], String(broken))
    assert.equal(herdr.raisePlan(stateOf(s.out[0]).state, 0), 'precise', String(broken))
  }
  // 책임 앱 이름을 못 찾아도(묶지 못함·앱이 아님) 나머지 값은 그대로다 — 이름은 서버가 다른 길로 찾는다
  for (const opt of [{ broken: ['responsibility_get_pid_responsible_for_pid'] }, { respPid: 1 }, { respPid: -1 }]) {
    const r = stateOf(sim(['700;0'], { ...opt, wins: [win(700, 636, 803, true)] }).out[0])
    assert.equal(r.own, '')
    assert.deepEqual(r.state, { ax: false, ae: -1744, vis: true, inst: 1, app: TERMINAL.path })
  }
  // 그 앱이 여러 벌이면 그 수를 그대로 알린다(서버가 다시 열기를 건너뛴다)
  const multi = stateOf(sim(['700;0'], { apps: { 700: { ...TERMINAL, instances: 3 } }, wins: [] }).out[0]).state
  assert.deepEqual([multi.inst, multi.vis], [3, false])
})

// ── Codex 리뷰 반영(2026-11-14) ──
test('리뷰 3 도우미: 여러 벌이면 창이 가장 큰 벌을 고른다(숨어 있어도 — 예전 그대로). 서버가 다른 벌을 "?<pid>"로 읽고 "<pid>;0"으로 올릴 수 있다', () => {
  const apps = { 700: { ...TERMINAL, instances: 2 }, 800: { ...TERMINAL, instances: 2 } }
  const wins = [win(700, 1600, 1000, false), win(800, 636, 803, true)]   // 700: 큰 창이 숨어 있다(최소화), 800: 작은 창이 보인다
  const s = sim(['800,700;0', '?800', '800;0'], { apps, wins })
  assert.match(s.out[0], /^ok:700\|/, '고르기는 그대로: 가장 큰 창의 벌')
  assert.deepEqual([stateOf(s.out[0]).state.vis, stateOf(s.out[0]).state.inst], [false, 2])
  assert.match(s.out[1], /^st:800\|/)
  assert.equal(stateOf(s.out[1]).state.vis, true, '다른 벌의 창은 보인다')
  assert.match(s.out[2], /^ok:800\|/)
  assert.deepEqual(s.activated, [[700, 2], [800, 2]], '"?" 줄은 올리지 않고, "800;0" 이 그 벌을 pid 로 올린다')
  // 권한을 다 가진 사람: 고르기도 응답도 예전 그대로(창 상태를 붙이지 않는다)
  const full = sim(['800,700;0'], { ax: true, ae: 0, apps, wins })
  assert.deepEqual(full.out, ['ok:700|ax=1;ae=0;own=%ED%84%B0%EB%AF%B8%EB%84%90'])
})

// ── 리뷰 2: 상주 도우미와의 줄 맞추기 ── 가짜 도우미 프로세스(node)로 실제 Helper 를 돌린다: 받은 줄마다 차례대로 한 줄씩 답하고
// (맥 도우미와 같은 규칙), k 번째 줄의 답은 폴더에 hold<k> 가 있으면 go<k> 가 생길 때까지 붙들어 둔다.
const { mkdtempSync, writeFileSync } = await import('node:fs')
const { tmpdir } = await import('node:os')
const { join } = await import('node:path')
const { _setPlatform } = await import('../src/platform.mjs')
const FAKE_DIR = mkdtempSync(join(tmpdir(), 'wh-'))
const FAKE = join(FAKE_DIR, 'fake-helper.mjs')
writeFileSync(FAKE, `import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
const [dir, tails = '{}'] = process.argv.slice(2)
const TAILS = JSON.parse(tails)
const reply = (line) => {
  const q = line.startsWith('?')
  const pid = (q ? line.slice(1) : line.split(';')[0]).split(',')[0]
  return (q ? 'st' : 'ok') + ':' + pid + '|' + (TAILS[pid] || 'ax=0;ae=-1744;vis=1;inst=1;app=')
}
const until = (f) => new Promise((r) => { const t = setInterval(() => { if (existsSync(f)) { clearInterval(t); r() } }, 5) })
let n = 0
let chain = Promise.resolve()
console.log('ready')
createInterface({ input: process.stdin }).on('line', (line) => {
  const k = ++n
  chain = chain.then(async () => { if (existsSync(join(dir, 'hold' + k))) await until(join(dir, 'go' + k)); console.log(reply(line)) })
}).on('close', () => process.exit(0))
`)
function fakeHelper(opts, tails = {}) {
  const dir = mkdtempSync(join(FAKE_DIR, 'run-'))
  const h = herdr._helperFor(process.execPath, [FAKE, dir, JSON.stringify(tails)], opts)
  return { h, hold: (k) => writeFileSync(join(dir, `hold${k}`), ''), go: (k) => writeFileSync(join(dir, `go${k}`), '') }
}
const LONG = 30000   // 답이 올 때까지 기다리는 요청의 한도(넉넉히 — 시간에 기대지 않는다)

test('리뷰 2 줄 맞추기: 시간 초과된 요청의 늦은 답은 다음 요청에게 가지 않는다(제자리에서 버린다)', async () => {
  const { h, hold, go } = fakeHelper({ ordered: true })
  try {
    hold(1)
    assert.equal(await h.send('?100', 150), 'timeout')    // 1번 줄: 답이 늦는다
    const b = h.send('?200', LONG)                         // 2번 줄: 그 뒤에 다른 pid 를 물었다
    go(1)                                                  // 이제 1번 줄의 답(st:100)이 오고, 이어서 2번 줄의 답이 온다
    assert.match(await b, /^st:200\|/, '2번 요청은 제 답을 받는다(1번의 늦은 답 st:100 이 아니다)')
    assert.equal(h.late, 1, '늦은 답 하나를 버렸다')
    assert.match(await h.send('300;0', LONG), /^ok:300\|/, '그 뒤로도 한 칸씩 밀리지 않는다')
  } finally { h.stop() }
})

test('리뷰 2 줄 맞추기: 늦은 답 뒤에 서느라 제 답을 못 받았으면 "late", 도우미가 그냥 답이 없으면 예전대로 "timeout"', async () => {
  const a = fakeHelper({ ordered: true })
  try {
    a.hold(1); a.hold(2)
    assert.equal(await a.h.send('?100', 150), 'timeout')
    const b = a.h.send('200;0', 1500)                      // 2번 줄: 기다리는 동안 1번의 늦은 답이 온다. 제 답은 아직 붙들려 있다
    a.go(1)
    assert.equal(await b, 'late', '늦은 답 때문에 생긴 모름: 부르는 쪽이 한 번 더 묻는다')
    const c = a.h.send('200;0', LONG)                      // 한 번 더 묻는다
    a.go(2)
    assert.match(await c, /^ok:200\|/, '2번의 늦은 답도 제자리에서 버려지고, 다시 물은 요청이 제 답을 받는다')
    assert.equal(a.h.late, 2)
  } finally { a.h.stop() }

  const stuck = fakeHelper({ ordered: true })
  try {
    stuck.hold(1); stuck.hold(2)
    assert.equal(await stuck.h.send('?100', 150), 'timeout')
    assert.equal(await stuck.h.send('200;0', 150), 'timeout', '기다리는 동안 온 늦은 답이 없다: 다시 물을 일이 아니다')
    stuck.go(1); stuck.go(2)
    assert.match(await stuck.h.send('?300', LONG), /^st:300\|/, '뒤늦게 밀려온 답 둘을 버리고 제 답을 받는다')
  } finally { stuck.h.stop() }
})

test('리뷰 2 줄 맞추기: 윈도우 도우미 방식(ordered 없음)은 예전 그대로다 — 시간 초과된 자리를 줄에서 빼고 "late" 를 말하지 않는다', async () => {
  const plain = fakeHelper()
  const mac = fakeHelper({ ordered: true })
  try {
    plain.hold(1); mac.hold(1)
    assert.equal(await plain.h.send('?100', 150), 'timeout')
    assert.equal(plain.h.waiters.length, 0, '예전처럼 자리를 뺀다')
    assert.equal(await mac.h.send('?100', 150), 'timeout')
    assert.equal(mac.h.waiters.length, 1, '맥 도우미 방식만 버리는 자리를 남긴다')
    plain.hold(2)
    const b = plain.h.send('?200', 600)
    plain.go(1)
    assert.notEqual(await b, 'late')
  } finally { plain.h.stop(); mac.h.stop() }
})

test('리뷰 2 줄 맞추기: 맥 상주 도우미만 버리는 자리 방식으로 띄운다(윈도우 도우미를 띄우는 줄은 그대로)', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/runtime/herdr.mjs', import.meta.url), 'utf8')
  assert.match(src, /\nconst macHelper = new Helper\('mac', [^\n]*, \{ ordered: true \}\)\n/)
  const winLine = src.split('\n').find((l) => l.includes("new Helper('win'"))
  assert.ok(winLine && !winLine.includes('ordered'), '윈도우 도우미는 예전 방식 그대로')
})

test('리뷰 2: 늦은 답이 섞여도 다른 세션의 창 상태로 판정하지 않는다(실제 줄 맞추기 + 서버 판정)', async () => {
  // desk1 은 pid 100(창이 숨어 있고 여러 벌), desk2 는 pid 200(창이 보인다). 둘 다 권한이 없는 사람.
  const PS = `
    100     1 /Applications/Fake Term.app/Contents/MacOS/faketerm
    101   100 -zsh
    102   101 /opt/homebrew/bin/herdr --session desk1
    200     1 /Applications/Other Term.app/Contents/MacOS/otherterm
    201   200 -zsh
    202   201 /opt/homebrew/bin/herdr --session desk2
  `
  const { h, hold, go } = fakeHelper({ ordered: true }, { 100: 'ax=0;ae=-1744;vis=0;inst=2;app=', 200: 'ax=0;ae=-1744;vis=1;inst=1;app=' })
  const sent = []
  const runs = []
  const waits = [150]   // 첫 요청만 짧게 끊는다(서버의 3초 한도 대신), 그 뒤는 답이 올 때까지
  herdr._setMacOps({
    helper: { send: (line) => { sent.push(line); return h.send(line, waits.shift() ?? LONG) } },
    run: async (file, args) => { if (file === '/bin/ps') return PS; runs.push(/System Events/.test(args.join('\n')) ? `precise:${args.at(-1)}` : file === '/usr/bin/open' ? 'reopen' : `other:${args.at(-1)}`); return '' },
    sleep: async () => {},
  })
  herdr.setFrontApp('')
  _setPlatform('darwin')
  const settle = async () => { await herdr._raiseSettled(); await new Promise((r) => setImmediate(r)) }
  try {
    hold(1)
    assert.equal(await herdr.activateTerminal('desk1', 0), 'raised')   // 1번 줄 "100;0": 도우미가 답하지 못했다
    await settle()
    assert.deepEqual(runs.sort(), ['other:100', 'precise:100'], '도우미가 답하지 못하면 예전 동작(그 pid 를 올리고 정밀 올리기)')
    runs.length = 0
    const b = herdr.activateTerminal('desk2', 0)                       // 2번 줄 "200;0"
    for (let i = 0; i < 5000 && sent.length < 2; i++) await new Promise((r) => setImmediate(r))
    assert.equal(sent.length, 2, '둘째 클릭이 도우미에 물었다')
    go(1)                                                               // 1번 줄의 늦은 답(ok:100 … vis=0;inst=2)이 먼저 온다
    assert.equal(await b, 'raised')
    await settle()
    assert.deepEqual(sent, ['100;0', '200;0'])
    assert.deepEqual(runs, [], 'desk2 의 창은 보인다: pid 100 의 늦은 답("보이는 창 없음")으로 권한 창을 띄우지 않는다')
  } finally { herdr._setMacOps(null); _setPlatform(null); herdr.setFrontApp(''); h.stop() }
})
