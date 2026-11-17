// 앱 링크(ovis://open?pane=…): 깔려 있는 그 앱이 링크를 아는지 가리기(운영체제마다)와 링크·여는 명령의 모양.
// 실제 앱 묶음·실제 등록부·실제 xdg-mime·reg 에는 닿지 않는다: 앱 묶음은 임시 폴더, 조회 명령과 여는 명령은 가짜다(ovis._setLinkOps).
// 앱 이름은 시험이 지어낸 것이다(Deskapp) — 코드는 어떤 앱 이름도 알고 있지 않다.
import { test, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import * as ovis from '../src/runtime/ovis.mjs'

const dir = mkdtempSync(join(tmpdir(), 'wl-'))
after(() => rmSync(dir, { recursive: true, force: true }))
const APP = 'Deskapp'
const BUNDLE = join(dir, 'apps', `${APP}.app`)
const PLIST = join(BUNDLE, 'Contents', 'Info.plist')
const ORIGINAL = ovis._linkOps()
const plist = (schemes) => `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>${APP}</string>
${schemes === null ? '' : `  <key>CFBundleURLTypes</key>
  <array>
    <dict>
      <key>CFBundleURLName</key>
      <string>${APP}</string>
      <key>CFBundleURLSchemes</key>
      <array>
${schemes.map((s) => `        <string>${s}</string>`).join('\n')}
      </array>
    </dict>
  </array>
`}  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppTransportSecurity</key>
  <dict><key>NSExceptionDomains</key><dict><key>x</key><array><string>ovis</string></array></dict></dict>
</dict>
</plist>
`
const writePlist = (text, mtime) => { mkdirSync(join(BUNDLE, 'Contents'), { recursive: true }); writeFileSync(PLIST, text); if (mtime) utimesSync(PLIST, mtime, mtime) }
let execs = []
let launches = []
beforeEach(() => {
  rmSync(join(dir, 'apps'), { recursive: true, force: true })
  ovis._clearLinkCache()
  execs = []; launches = []
  ovis._setLinkOps({
    ...ORIGINAL,
    appBundles: (app) => [join(dir, 'apps', `${app}.app`)],
    exec: (file, args) => { execs.push([file, args]); throw new Error('no such command (test)') },
    launch: async (file, args, opts) => { launches.push([file, args, opts]); return 'ok' },
  })
})
after(() => ovis._setLinkOps(ORIGINAL))

test('링크: 코어에서 읽은 모양의 터미널 주소만 받고, 값은 URL 인코딩한다', () => {
  assert.equal(ovis.appLink('t4'), 'ovis://open?pane=t4&view=terminal')
  assert.equal(ovis.appLink('t:4'), 'ovis://open?pane=t%3A4&view=terminal', '주소의 : 는 인코딩한다')
  assert.equal(ovis.appLink('t4', 'chat'), 'ovis://open?pane=t4&view=chat')
  for (const odd of ['', 't4&view=chat', 't4#x', 't4?ws=1', 'a b', 'a/b', '../t1', 'x'.repeat(65), null, undefined, 4]) assert.equal(ovis.appLink(odd), null, JSON.stringify(odd))
  assert.equal(ovis.appLink('t4', 'settings'), null, '보기는 terminal·chat 만')
})

test('여는 명령: 운영체제마다 인자 배열이다(셸 문자열이 아니다). Windows 는 cmd 의 start 에 따옴표째로 넘기고, 그 줄을 바꿀 수 있는 글자가 든 주소는 열지 않는다', async () => {
  const link = 'ovis://open?pane=t4&view=terminal'
  assert.deepEqual(ovis.openerFor(link, 'darwin'), ['/usr/bin/open', [link], {}])
  assert.deepEqual(ovis.openerFor(link, 'linux'), ['xdg-open', [link], {}])
  const CMD = ovis.winSystemExe('cmd.exe')
  assert.deepEqual(ovis.openerFor(link, 'win32'), [CMD, ['/d', '/s', '/c', `"start "" "${link}""`], { windowsVerbatimArguments: true }])
  // cmd·reg 는 시스템 폴더의 것을 경로째로 부른다(맨 이름이면 현재 폴더의 같은 이름 파일이 먼저 잡힐 수 있다)
  assert.equal(ovis.openerFor(link, 'win32', { SystemRoot: 'D:\\Win' })[0], 'D:\\Win\\System32\\cmd.exe')
  assert.equal(ovis.winSystemExe('reg.exe', { windir: 'E:\\W' }), 'E:\\W\\System32\\reg.exe')
  assert.equal(ovis.winSystemExe('cmd.exe', {}), 'C:\\Windows\\System32\\cmd.exe')
  // 터미널 주소의 ':'(w1:p1 꼴)는 링크에서 %3A 가 되는데 cmd 는 % 를 변수 꺼내기로 읽는다: %3A 만 ':' 로 되돌려 넘긴다(받는 쪽이 URL 로 풀면 같은 값)
  const colon = ovis.appLink('w1:p1')
  assert.equal(colon, 'ovis://open?pane=w1%3Ap1&view=terminal')
  assert.equal(ovis.openerFor(colon, 'win32')[1][3], '"start "" "ovis://open?pane=w1:p1&view=terminal""')
  assert.equal(new URL('ovis://open?pane=w1:p1&view=terminal').searchParams.get('pane'), new URL(colon).searchParams.get('pane'), '풀면 같은 값')
  assert.equal(ovis.openerFor(ovis.paneUrl(48123, 'w1:p1'), 'win32')[1][3], '"start "" "http://127.0.0.1:48123/?pane=w1:p1&view=terminal""', '브라우저 탭으로 여는 폴백도 같다')
  assert.deepEqual(ovis.openerFor(colon, 'darwin'), ['/usr/bin/open', [colon], {}], '다른 운영체제는 그대로 넘긴다')
  const web = 'http://127.0.0.1:48123/?pane=t4&view=terminal'
  assert.deepEqual(ovis.openerFor(web, 'darwin'), ['/usr/bin/open', [web], {}])
  assert.deepEqual(ovis.openerFor(web, 'win32')[1][3], `"start "" "${web}""`)

  for (const p of ['darwin', 'linux', 'win32']) {
    for (const odd of ['file:///etc/passwd', 'javascript:alert(1)', 'ovis://open?pane=t4\n&view=terminal', 'ovis://open?pane=a b', '', null]) assert.equal(ovis.openerFor(odd, p), null, `${p} ${JSON.stringify(odd)}`)
  }
  for (const odd of ['ovis://open?pane=t%2F4&view=terminal', 'ovis://open?pane=%PATH%', 'ovis://open?pane="x"', 'ovis://open?pane=^x', 'ovis://open?pane=!x']) assert.equal(ovis.openerFor(odd, 'win32'), null, `cmd 가 다르게 읽을 글자: ${odd}`)
  // openExternal 은 그 명령을 그대로 띄운다(가짜 launch). 열 수 없는 주소는 띄우지 않고 던진다
  ovis._setLinkOps({ platform: () => 'darwin' })
  await ovis.openExternal(link)
  assert.deepEqual(launches, [['/usr/bin/open', [link], {}]])
  await assert.rejects(ovis.openExternal('file:///x'), (e) => e.code === 'opener_refused')
  assert.equal(launches.length, 1)
})

test('여는 명령의 끝: 끝 코드 0 이면 열었다, 0 이 아니거나 띄우지 못하면 던진다, 오래 걸리면(그 앱이 끝날 때까지 기다리는 opener) 연 것으로 본다', async () => {
  const launch = ORIGINAL.launch
  ovis._setLinkOps({ settleMs: 3000 })
  assert.equal(await launch(process.execPath, ['-e', 'process.exit(0)']), 'ok')
  await assert.rejects(launch(process.execPath, ['-e', 'process.exit(3)']), (e) => e.code === 'opener_failed')
  await assert.rejects(launch(join(dir, 'no-such-opener'), []), (e) => e.code === 'ENOENT')
  ovis._setLinkOps({ settleMs: 50 })
  assert.equal(await launch(process.execPath, ['-e', 'setTimeout(() => {}, 400)']), 'running')
  ovis._setLinkOps({ settleMs: ORIGINAL.settleMs })
})

test('plist 읽기: CFBundleURLTypes 의 CFBundleURLSchemes 만 본다(다른 배열에 적힌 같은 글자는 세지 않는다)', () => {
  assert.deepEqual(ovis.plistUrlSchemes(plist(['ovis'])), ['ovis'])
  assert.deepEqual(ovis.plistUrlSchemes(plist(['other', 'OVIS'])), ['other', 'ovis'])
  assert.deepEqual(ovis.plistUrlSchemes(plist(null)), [], '링크를 적지 않은 앱(오비스 0.5.3 의 모양) — 다른 곳의 <string>ovis</string> 는 세지 않는다')
  for (const odd of ['', null, '<plist><dict><key>CFBundleURLTypes</key><array><dict>', 'bplist00garbage']) assert.deepEqual(ovis.plistUrlSchemes(odd), [])
})

test('macOS: 그 앱 묶음의 Info.plist 가 ovis 를 적었으면 링크를 안다. 앱 이름을 모르거나 묶음이 없으면 모른다. 답은 그 파일이 바뀔 때까지 기억한다', () => {
  const p = 'darwin'
  assert.equal(ovis.linkSupported(APP, p), false, '앱 묶음이 없다')
  writePlist(plist(null), new Date('2026-11-01T00:00:00Z'))
  assert.equal(ovis.linkSupported(APP, p), false, '링크를 적지 않은 판(0.5.3)')
  // 새 버전으로 바꿨다(파일이 바뀌었다): 다시 읽는다
  writePlist(plist(['ovis']), new Date('2026-11-15T00:00:00Z'))
  assert.equal(ovis.linkSupported(APP, p), true)
  // 같은 파일이면 다시 읽지 않는다: 내용만 몰래 바꾸고 바뀐 때·크기를 맞춰 두면 기억한 답이 나온다
  const same = plist(['ovis']).replace('ovis', 'xxxx')
  writePlist(same, new Date('2026-11-15T00:00:00Z'))
  assert.equal(ovis.linkSupported(APP, p), true, '경로·바뀐 때·크기가 같으면 기억한 답')
  writePlist(same, new Date('2026-11-16T00:00:00Z'))
  assert.equal(ovis.linkSupported(APP, p), false, '바뀐 때가 달라지면 다시 읽는다')
  for (const odd of [null, '', '../x', 'a/b', ' Deskapp', 'Bad"; do']) assert.equal(ovis.linkSupported(odd, p), false, `앱 이름 ${JSON.stringify(odd)}`)
  assert.deepEqual(execs, [], 'XML plist 는 명령 없이 읽는다')
})

test('macOS: 두 곳(/Applications 와 홈의 Applications)에 같은 이름의 앱이 다 있으면 둘 다 링크를 알아야 안다(이전 버전이 켜져 있으면 링크가 다른 사본을 띄울 수 있다)', () => {
  const OTHER = join(dir, 'apps2', `${APP}.app`, 'Contents', 'Info.plist')
  ovis._setLinkOps({ appBundles: (app) => [join(dir, 'apps', `${app}.app`), join(dir, 'apps2', `${app}.app`)] })
  rmSync(join(dir, 'apps2'), { recursive: true, force: true })
  writePlist(plist(['ovis']))
  assert.equal(ovis.linkSupported(APP, 'darwin'), true, '한 곳에만 있다')
  mkdirSync(dirname(OTHER), { recursive: true }); writeFileSync(OTHER, plist(null))
  assert.equal(ovis.linkSupported(APP, 'darwin'), false, '다른 곳에 링크를 모르는 이전 버전이 있다')
  writeFileSync(OTHER, plist(['ovis', 'x']))
  assert.equal(ovis.linkSupported(APP, 'darwin'), true, '둘 다 안다')
  rmSync(join(dir, 'apps2'), { recursive: true, force: true })
})

test('macOS: 이진 plist 는 plutil 로 XML 로 바꿔 읽는다(그 파일 경로를 인자로). plutil 이 실패하면 모른다', () => {
  writePlist('bplist00' + 'x'.repeat(40))
  ovis._setLinkOps({ exec: (file, args) => { execs.push([file, args]); return plist(['ovis']) } })
  assert.equal(ovis.linkSupported(APP, 'darwin'), true)
  assert.deepEqual(execs, [['/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', PLIST]]])
  ovis._clearLinkCache(); execs = []
  ovis._setLinkOps({ exec: (file, args) => { execs.push([file, args]); throw new Error('plutil failed') } })
  assert.equal(ovis.linkSupported(APP, 'darwin'), false)
  assert.equal(execs.length, 1)
})

test('Linux: 응용 프로그램 폴더의 .desktop 의 MimeType 에 x-scheme-handler/ovis 가 있으면 안다. 없으면 xdg-mime query default 를 묻는다', () => {
  const home = join(dir, 'lhome')
  const data = join(dir, 'ldata')
  const env = { XDG_DATA_HOME: join(home, 'share'), XDG_DATA_DIRS: data, XDG_CONFIG_HOME: join(home, 'cfg') }
  rmSync(home, { recursive: true, force: true }); rmSync(data, { recursive: true, force: true })
  assert.equal(ovis.linkSupported(null, 'linux', env, home), false, '폴더가 없다 · xdg-mime 도 없다')
  assert.deepEqual(execs, [['xdg-mime', ['query', 'default', 'x-scheme-handler/ovis']]])
  mkdirSync(join(data, 'applications'), { recursive: true })
  writeFileSync(join(data, 'applications', 'other.desktop'), '[Desktop Entry]\nName=Other\nMimeType=x-scheme-handler/ovisx;text/plain;\n')
  ovis._clearLinkCache()
  assert.equal(ovis.linkSupported(null, 'linux', env, home), false, '이름이 비슷한 다른 링크')
  writeFileSync(join(data, 'applications', 'deskapp.desktop'), '[Desktop Entry]\nName=Deskapp\nExec=/opt/Deskapp/deskapp %U\nMimeType=x-scheme-handler/ovis;\n')
  utimesSync(join(data, 'applications'), new Date(), new Date(Date.now() + 5000))   // 폴더가 바뀌었다: 다시 읽는다
  assert.equal(ovis.linkSupported(null, 'linux', env, home), true)
  // xdg-mime 이 .desktop 이름을 답하는 경우(폴더를 읽지 못했다)
  ovis._clearLinkCache(); rmSync(data, { recursive: true, force: true })
  ovis._setLinkOps({ exec: (file, args) => { execs.push([file, args]); return 'deskapp.desktop\n' } })
  assert.equal(ovis.linkSupported(null, 'linux', env, home), true)
  ovis._clearLinkCache()
  ovis._setLinkOps({ exec: () => '\n' })
  assert.equal(ovis.linkSupported(null, 'linux', env, home), false, '답이 비었다')
  assert.equal(ovis.desktopKnows('MimeType = text/plain ; x-scheme-handler/ovis'), true)
  assert.equal(ovis.desktopKnows('X-MimeType=x-scheme-handler/ovis;'), false)
})

test('Windows: HKCU\\Software\\Classes\\ovis 의 "URL Protocol" 값이 있으면 안다(reg query — 인자 배열). 잠시 기억한다', () => {
  let t = 1_000_000
  ovis._setLinkOps({ now: () => t, ttlMs: 60000, exec: (file, args) => { execs.push([file, args]); return 'HKEY_CURRENT_USER\\Software\\Classes\\ovis\n    URL Protocol    REG_SZ    \n' } })
  assert.equal(ovis.linkSupported(null, 'win32'), true)
  assert.deepEqual(execs, [[ovis.winSystemExe('reg.exe'), ['query', 'HKCU\\Software\\Classes\\ovis', '/v', 'URL Protocol']]])
  assert.match(execs[0][0], /\\System32\\reg\.exe$/, '시스템 폴더의 reg 를 경로째로')
  assert.equal(ovis.linkSupported(null, 'win32'), true)
  assert.equal(execs.length, 1, '잠시 동안은 다시 묻지 않는다')
  ovis._setLinkOps({ exec: (file, args) => { execs.push([file, args]); throw Object.assign(new Error('not found'), { status: 1 }) } })
  t += 60000
  assert.equal(ovis.linkSupported(null, 'win32'), false, '등록하지 않은 앱(0.5.3)')
  assert.equal(execs.length, 2)
})

test('되는 기능: 서버가 살아 있고 그 앱이 링크를 알 때만 이동이 app_link 다. 앱이 꺼져 있거나 조작을 받지 않으면 예전 그대로다. 자동 감지(link 를 넘기지 않는다)도 예전 그대로다', () => {
  assert.deepEqual(ovis.coreFeatures({ server: 'ok', app: APP, link: true }).focus, { means: 'app_link' })
  assert.deepEqual(ovis.coreFeatures({ server: 'ok', app: APP }).focus, { means: 'open_url' })
  assert.deepEqual(ovis.coreFeatures({ server: 'none', app: APP, link: true }), ovis.coreFeatures({ server: 'none', app: APP }))
  assert.deepEqual(ovis.coreFeatures({ server: 'locked', app: APP, link: true }), ovis.coreFeatures({ server: 'locked', app: APP }))
  const profile = { name: 'deskapp', app: APP, focus: false, url: ovis.paneUrlTemplate(48123) }
  assert.deepEqual(ovis.profileFeatures(profile).focus, { means: 'open_url' })
  assert.deepEqual(ovis.profileFeatures(profile, { link: true }).focus, { means: 'app_link' })
  assert.ok(ovis.MEANS.includes('app_link'))
})
