import { createServer } from 'node:http'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeBoard, markSeen, markUnseen, resumeFor, setPinned, setStashed, markReopened } from './board.mjs'
import { getSettings, setSettings, settingSources, SETTING_RANGES } from '../settings.mjs'
import * as herdr from '../runtime/herdr.mjs'
import { collectOnce } from '../collector.mjs'
// 보드에서 상태를 바꾼 직후 한 번 바로 수집한다 — 다음 수집 주기(3초)를 기다리지 않고 판이 따라오게.
const collectNow = (db) => { try { collectOnce(db, herdr, { source: 'board' }) } catch {} }

const HTML_PATH = fileURLToPath(new URL('./index.html', import.meta.url))
// 화면 판본: 보드 HTML이 바뀐 채로 서버가 다시 뜨면 열려 있던 탭이 스스로 새로고침한다.
const BUILD = String(statSync(HTML_PATH).mtimeMs | 0)
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/
const readonly = () => process.env.WHOSUP_READONLY === '1'

// 칸이 닫혔음을 아는 즉시 최근 닫힘으로(수집이 연속 미검출을 세기 전에) — 보드가 바로 따라오게.
export function markGoneNow(db, id, at = new Date().toISOString()) {
  db.prepare("UPDATE session SET archived = 1, status = 'gone', unreachable = 0, miss_count = 0, updated_at = ? WHERE id = ? AND archived = 0").run(at, id)
  db.prepare('INSERT INTO event (session_id, at, field, before, after, source) VALUES (?, ?, ?, ?, ?, ?)').run(id, at, 'gone', 'false', 'true', 'board')
}

export async function openSession(db, id, seq) {
  const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
  if (!s) return { ok: false, code: 'no_session', message: `no session ${id}` }
  if (s.archived) return { ok: false, code: 'closed', message: 'that pane is closed — use resume' }
  let r
  try { r = await herdr.focus(s.runtime_ref, { cwd: s.cwd || undefined, seq, split: getSettings(db).split_pct }) } catch (err) {
    // 터미널에서 이미 닫은 칸(수집이 아직 못 따라온 3~9초): 오류 대신 바로 최근 닫힘으로 옮긴다.
    if (/pane_not_found|not found/i.test(String(err.message))) { markGoneNow(db, s.id); return { ok: true, code: 'pane_gone', message: `${s.runtime_ref} was already closed` } }
    throw err
  }
  if (r.window === 'superseded') return { ok: true, code: 'superseded', window: r.window, message: `skipped ${r.session} ${r.pane} (a newer click won)` }
  const code = r.client === 'started' ? 'focused_started' : r.window === 'opened' ? 'focused_opened' : 'focused'
  return { ok: true, code, window: r.window, message: `focused ${r.session} ${r.pane}${r.client === 'started' ? ' (session started)' : ''}${r.window === 'opened' ? ' (opened a terminal window)' : ''}` }
}

// Empty pane (shell) after a restart: resume the newest conversation for that folder, or start fresh.
// A closed (gone) pane: open a new tab in the same herdr session and resume its conversation there.
// 같은 칸에 대한 요청이 진행 중이면 두 번째는 무시한다(연타 방지 — 재개 명령이 에이전트 입력으로 두 번 들어가지 않게).
const inflight = new Set()
// shownSid: 판이 보여 준 재개 대상(undefined면 옛 탭 — 비교하지 않는다). 다시 계산한 값과 다르면 실행하지 않는다(I-3).
export async function resumeSession(db, id, shownSid) {
  if (inflight.has(id)) return { ok: false, code: 'busy', message: 'already resuming that pane' }
  inflight.add(id)
  try {
    const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
    if (!s) return { ok: false, code: 'no_session', message: `no session ${id}` }
    const cmd = getSettings(db).agent_cmd
    const rows = db.prepare('SELECT id, status, archived, provider_session FROM session WHERE archived = 0').all()
    const sid = resumeFor(rows, s, cmd)?.sid ?? null
    if (shownSid !== undefined && (shownSid || null) !== sid) return { ok: false, code: 'resume_changed', message: 'the conversation to resume changed — check the board and try again' }
    const run = sid ? `${cmd} --resume ${sid}` : cmd
    if (s.archived && s.status === 'gone') {
      const desk = s.runtime_ref.split('/')[0]
      const r = await herdr.newSession({ session: desk, cwd: s.cwd || homedir(), command: run })
      markReopened(db, s.id)
      return { ok: true, code: sid ? 'resumed' : 'started', message: sid ? `resuming ${sid.slice(0, 8)} in a new tab (${r.pane})` : `started ${cmd} in a new tab (${r.pane})`, resumed: Boolean(sid) }
    }
    if (s.status !== 'shell' && s.status !== 'idle' && s.status !== 'unknown') return { ok: false, code: 'has_agent', message: 'that pane already has an agent' }
    const r = await herdr.focus(s.runtime_ref, { cwd: s.cwd || undefined, run })
    return { ok: true, code: sid ? 'resumed' : 'started', message: sid ? `resuming ${sid.slice(0, 8)} in ${r.pane}` : `started ${cmd} in ${r.pane}`, resumed: Boolean(sid) }
  } finally {
    setTimeout(() => inflight.delete(id), 3000)
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin
  const port = req.socket.localPort
  return !origin || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => { data += c; if (data.length > 4096) reject(new Error('body too large')) })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

// 새 세션 창의 폴더 고르기: 홈 아래만, 숨김 폴더는 빼고, 이름순. 경로를 손으로 칠 필요가 없게 한다.
const HOME = homedir()
// Windows 경로(C:\\Users\\…)도 받도록 구분자 대신 relative로 판정 (Windows 실기기 QA: 폴더 탐색이 400)
const underHome = (p) => { const r = relative(HOME, p); return p === HOME || (!!r && !r.startsWith('..') && !isAbsolute(r)) }
export function listDirs(path) {
  const p = resolve(path)
  if (!underHome(p)) return { ok: false, message: 'only folders under home' }
  let names = []
  try { names = readdirSync(p, { withFileTypes: true }).filter((d) => !d.name.startsWith('.') && (d.isDirectory() || (d.isSymbolicLink() && process.platform !== 'win32' && isDir(join(p, d.name))))).map((d) => d.name) }
  catch (err) { return { ok: false, message: String(err.code || err.message) } }
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  return { ok: true, path: p, parent: p === HOME ? null : dirname(p), home: HOME, sep, dirs: names.slice(0, 500), more: Math.max(0, names.length - 500) }
}
const isDir = (p) => { try { return statSync(p).isDirectory() } catch { return false } }
// 최근에 칸이 열렸던 폴더(지금도 있는 것만), 최근 활동 순.
export function recentFolders(db, limit = 12) {
  const rows = db.prepare(`SELECT cwd, MAX(COALESCE(last_user_msg_at, '')) AS t, MAX(updated_at) AS u FROM session WHERE cwd != '' GROUP BY cwd ORDER BY t DESC, u DESC LIMIT 60`).all()
  return rows.map((r) => r.cwd).filter((c) => underHome(c) && c !== HOME && existsSync(c)).slice(0, limit)
}

export function createBoardServer(db, { heartbeatPath } = {}) {
  return createServer(async (req, res) => {
    const send = (code, body, type = 'application/json; charset=utf-8') => { res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' }); res.end(body) }
    try {
      if (!LOCAL_HOST.test(req.headers.host || '')) return send(403, JSON.stringify({ error: 'local only' }))
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && url.pathname === '/') return send(200, readFileSync(HTML_PATH), 'text/html; charset=utf-8')
      // health는 '후즈업 프로세스가 답하는가'만 말한다. herdr에 닿지 못해도 200이고, 그 사정은 herdr_error에 싣는다.
      if (req.method === 'GET' && url.pathname === '/api/health') {
        let sessions = null, herdrError
        try { sessions = herdr.runningSessions() } catch (err) { herdrError = String(err.message || err).slice(0, 300) }
        return send(200, JSON.stringify({ ok: true, readonly: readonly(), herdr: sessions, ...(herdrError ? { herdr_error: herdrError } : {}) }))
      }
      if (req.method === 'GET' && url.pathname === '/api/settings') return send(200, JSON.stringify({ settings: getSettings(db), ranges: SETTING_RANGES, sources: settingSources(db) }))
      // 읽기 전용이면 새 세션 열기가 막혀 있으므로 홈 아래 폴더 목록도 내주지 않는다.
      if (req.method === 'GET' && (url.pathname === '/api/folders' || url.pathname === '/api/dirs') && readonly()) return send(403, JSON.stringify({ error: 'read-only', code: 'read_only' }))
      if (req.method === 'GET' && url.pathname === '/api/folders') return send(200, JSON.stringify({ home: homedir(), recent: recentFolders(db) }))
      if (req.method === 'GET' && url.pathname === '/api/dirs') { const r = listDirs(url.searchParams.get('path') || homedir()); return send(r.ok ? 200 : 400, JSON.stringify(r)) }
      if (req.method === 'GET' && url.pathname === '/api/board') {
        if (heartbeatPath && url.searchParams.get('view') === '1') writeFileSync(heartbeatPath, new Date().toISOString())
        return send(200, JSON.stringify({ ...computeBoard(db), readonly: readonly(), raise_warning: herdr.raiseWarning(), build: BUILD }))
      }
      if (req.method === 'POST') {
        if (!sameOrigin(req)) return send(403, JSON.stringify({ error: 'local page only' }))
        if (readonly()) return send(403, JSON.stringify({ error: 'read-only', code: 'read_only' }))
        const body = JSON.parse((await readBody(req)) || '{}')
        const id = body.id
        if (['/api/open', '/api/seen', '/api/unseen', '/api/pin', '/api/stash', '/api/resume', '/api/close'].includes(url.pathname) && !Number.isInteger(id)) return send(400, JSON.stringify({ error: 'id required', code: 'bad_request' }))
        try {
          if (url.pathname === '/api/open') { const r = await openSession(db, id, Number(body.seq)); return send(r.ok ? 200 : 409, JSON.stringify(r)) }
          if (url.pathname === '/api/close') {
            const s = db.prepare('SELECT * FROM session WHERE id = ?').get(id)
            if (!s || s.archived) return send(409, JSON.stringify({ ok: false, code: 'no_session' }))
            try { herdr.closePane(s.runtime_ref) } catch (err) { if (!/pane_not_found|not found/i.test(String(err.message))) throw err }
            markGoneNow(db, s.id); collectNow(db)
            return send(200, JSON.stringify({ ok: true, code: 'pane_closed' }))
          }
          if (url.pathname === '/api/resume') { const r = await resumeSession(db, id, body.sid); collectNow(db); return send(r.ok ? 200 : 409, JSON.stringify(r)) }
          if (url.pathname === '/api/seen') return send(200, JSON.stringify({ ok: true, seen_at: markSeen(db, id) }))
          if (url.pathname === '/api/unseen') { markUnseen(db, id); return send(200, JSON.stringify({ ok: true })) }
          if (url.pathname === '/api/pin') return send(200, JSON.stringify({ ok: true, pinned_at: setPinned(db, id, body.on !== false) }))
          if (url.pathname === '/api/stash') return send(200, JSON.stringify({ ok: true, stashed_at: setStashed(db, id, body.on !== false) }))
          if (url.pathname === '/api/desk') {
            const session = String(body.session || '')
            if (!herdr.validSessionName(session)) return send(400, JSON.stringify({ ok: false, code: 'bad_request' }))
            if (body.on === false) { await herdr.stopSession(session); collectNow(db); return send(200, JSON.stringify({ ok: true, code: 'desk_stopped' })) }
            const r = await herdr.startSession(session); collectNow(db); return send(200, JSON.stringify({ ok: true, code: 'desk_started', window: r.window }))
          }
          if (url.pathname === '/api/settings') { const r = setSettings(db, body.settings); return send(r.ok ? 200 : 400, JSON.stringify(r)) }
          if (url.pathname === '/api/new') {
            const { session, cwd } = body
            if (!herdr.validSessionName(session)) return send(400, JSON.stringify({ ok: false, code: 'bad_request' }))
            if ( typeof cwd !== 'string' || !underHome(resolve(cwd))) return send(400, JSON.stringify({ ok: false, code: 'bad_folder', message: 'session and a folder under home are required' }))
            if (!isDir(cwd)) return send(400, JSON.stringify({ ok: false, code: 'no_folder', message: `no such folder: ${cwd}` }))
            const r = await herdr.newSession({ session, cwd, command: getSettings(db).agent_cmd }); collectNow(db)
            return send(200, JSON.stringify({ ok: true, code: 'opened_new', message: `opened ${basename(cwd)} in ${session} (${r.pane})` }))
          }
        } catch (err) {
          if (err.code === 'cwd_missing') return send(409, JSON.stringify({ ok: false, code: 'cwd_missing', message: err.message.slice(0, 300) }))
          return send(500, JSON.stringify({ ok: false, code: 'herdr_error', message: err.message.slice(0, 300) }))
        }
      }
      return send(404, JSON.stringify({ error: 'not found' }))
    } catch (err) { return send(500, JSON.stringify({ error: err.message })) }
  })
}

export function startBoard(db, { port = Number(process.env.PORT || 4790), heartbeatPath } = {}) {
  const server = createBoardServer(db, { heartbeatPath })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}
