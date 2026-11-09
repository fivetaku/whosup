// 칸마다 화면에 쓸 문맥: 기다리는 질문 원문(herdr 칸 화면), 마지막 요청(Claude 세션 기록), git 브랜치, 데스크 라벨.
// 전부 읽기 전용이고 짧게 캐시한다. 못 읽으면 null을 돌려주고 판은 그대로 뜬다.
import { execFileSync } from 'node:child_process'
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { bin as herdrBin } from '../runtime/herdr.mjs'

const cache = new Map()
function memo(key, ttlMs, fn, now = Date.now()) {
  const hit = cache.get(key)
  if (hit && now - hit.at < ttlMs) return hit.value
  let value = null
  try { value = fn() } catch { value = null }
  cache.set(key, { at: now, value })
  return value
}
export const clearContextCache = () => cache.clear()


// ── 칸 화면 글 ───────────────────────────────────────────────
export function readPane(session, pane, lines = 60) {
  return execFileSync(herdrBin(), ['--session', session, 'pane', 'read', pane, '--source', 'detection', '--lines', String(lines)], { encoding: 'utf8', timeout: 4000, killSignal: 'SIGKILL' })
}

const RULE = /^[\s]*[─—-]{10,}\s*$/
const NOISE = /^\s*(❯|◆|📁|⏵⏵|⎿|✻|✽|✶|✳|✢|·\s*(Thinking|Working)|\?\s*for shortcuts|View Observations|✨ 30 Day|Get up to|https?:\/\/cmem\.ai)/
const ANSWER_OPTION = /^\s*(❯\s*)?\d+\.\s/

// Claude Code 화면의 아래쪽 입력줄·상태줄을 떼고 본문 줄만 남긴다.
export function bodyLines(text) {
  const lines = text.replace(/\r/g, '').split('\n')
  // 입력줄(❯)을 찾고 그 위의 괘선에서 자른다. 입력줄이 없으면 마지막 괘선, 그것도 없으면 전부.
  let end = lines.length
  let input = -1
  // 입력줄 = 괘선 바로 아래의 ❯ 줄. 객관식·폴더 신뢰 화면의 선택 커서(❯ 1. …, ❯ No, exit)는 입력줄이 아니다
  // (2026-11-08 3대 QA: 커서를 입력줄로 오인해 질문 상자 머리에서 잘라 question이 늘 비었다).
  for (let i = lines.length - 1; i >= 1; i--) if (/^\s*❯/.test(lines[i]) && RULE.test(lines[i - 1])) { input = i; break }
  // 입력줄이 없으면(질문·신뢰·승인 선택 화면) 자르지 않는다 — 질문은 마지막 괘선 아래에 있다.
  if (input >= 0) for (let i = input - 1; i >= 0; i--) {
    if (RULE.test(lines[i])) { end = i; break }
  }
  return lines.slice(0, end).map((l) => l.replace(/\s+$/, ''))
}

// 승인·질문 대기 칸: 화면 아래쪽에서 질문 문장을 찾는다. 선택지 번호줄은 질문이 아니다.
// 권한 상자(╭ │ ╰)는 "명령 — 승인?" 꼴로 줄인다.
const BOX = /^[\s│╭╰╮╯]+|[\s│]+$/g
const unbox = (l) => l.replace(BOX, '').replace(/^[⏺●]\s*/, '')
// #17 질문 문장과 종류: approval(권한 상자·폴더 신뢰) | question(그 밖의 물음).
export function questionOf(text) {
  const raw = bodyLines(text)
  const body = raw.map(unbox).filter((l) => l.trim() && !NOISE.test(l) && !/^[─╭╰╮╯]+$/.test(l))
  for (let i = body.length - 1; i >= 0; i--) {
    const l = body[i].trim()
    if (ANSWER_OPTION.test(l) || /^(Esc|Enter|Tab) /.test(l)) continue
    if (/Do you want to (proceed|make this edit|allow)/i.test(l)) {
      // 상자 안 명령: 상자 제목줄(Bash command / Edit file …) 다음 첫 비어 있지 않은 줄
      const head = body.slice(Math.max(0, i - 12), i)
      const titleIdx = head.findIndex((h) => /^(Bash command|Edit file|Write file|Create file|Read file|Tool use|Run)/i.test(h.trim()))
      const cmd = (titleIdx >= 0 ? head.slice(titleIdx + 1) : head).map((h) => h.trim()).find((h) => h && !/^(Bash command|Edit file|Write file)/i.test(h))
      return { text: cmd ? `${cmd.slice(0, 120)} — 승인할까요?` : '승인할까요?', kind: 'approval' }
    }
    if (/trust this folder/i.test(l)) return { text: '이 폴더를 신뢰할까요? (Yes, I trust this folder)', kind: 'approval' }
    if (/^Enter to confirm/i.test(l)) {
      for (let k = i - 1; k >= Math.max(0, i - 12); k--) if (/[?？]/.test(body[k])) return { text: joinWrapped(body, k), kind: 'question' }
    }
    if (/[?？]$/.test(l) || /승인|진행할까|허용/i.test(l)) return { text: joinWrapped(body, i), kind: 'question' }
  }
  return null
}
export const extractQuestion = (text) => questionOf(text)?.text ?? null

// 끝난 칸: 마지막 ⏺ 문단(에이전트의 마지막 말)
export function extractLastSay(text) {
  const body = bodyLines(text)
  let start = -1
  for (let i = body.length - 1; i >= 0; i--) if (/^\s*[⏺●]\s/.test(body[i]) && !/^\s*[⏺●]\s+\S+\(/.test(body[i])) { start = i; break }
  // ⏺ 문단이 화면에 없으면(세션 시작 배너·긴 출력 뒤) 지어내지 않고 null — 판은 마지막 요청·제목으로 대신한다.
  if (start < 0) return null
  const out = [body[start].replace(/^\s*[⏺●]\s*/, '')]
  for (let i = start + 1; i < body.length && out.join(' ').length < 200; i++) {
    const l = body[i]
    if (!l.trim() || /^\s*[⏺●]/.test(l) || NOISE.test(l)) break
    out.push(l.trim())
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, 200) || null
}

// 화면 폭 때문에 줄바꿈된 문장을 위로 올라가며 한 문장으로 잇는다.
function joinWrapped(body, i) {
  const parts = [body[i].trim()]
  const indent = body[i].match(/^\s*/)[0].length
  for (let k = i - 1; k >= 0 && parts.length < 4; k--) {
    const l = body[k]
    // 객관식 질문 위의 탭 줄(☐ Color, ✔ Submit, ← → 화살표)은 질문 문장이 아니다
    if (!l.trim() || ANSWER_OPTION.test(l) || /[.!?。]$/.test(l.trim()) || /^\s*(←|[☐✔☒]\s)/.test(l)) break
    const own = l.match(/^\s*/)[0].length
    const starts = /^\s*[⏺●]/.test(l)
    if (own !== indent && !starts) break
    parts.unshift(l.replace(/^\s*[⏺●]\s*/, '').trim())
    if (starts) break
  }
  return parts.join(' ').replace(/\s+/g, ' ').slice(0, 200)
}

// 실패로 볼 신호(화면 아래쪽 20줄 안)
export function looksFailed(text) {
  const tail = bodyLines(text).slice(-20).join('\n')
  return /API Error|rate.?limit|429|overloaded|exit code [1-9]|command not found|Traceback|FAILED|✘|Error:/i.test(tail)
}

// 질문·승인을 기다리는 칸은 실패로 보지 않는다 — 기다리는 건 사람의 답이다.
// (2026-11-08 실측: 질문 바로 위 `⎿  Error: PreToolUse:AskUserQuestion hook error` 줄 때문에 입력 필요 칸이 실패로 떴다)
export function failedFor(text, status, question) {
  if (status === 'blocked' && question) return false
  return looksFailed(text)
}

export function paneContext(session, pane, status, now = Date.now()) {
  return memo(`pane:${session}/${pane}:${status}`, 10000, () => {
    const text = readPane(session, pane)
    const asked = status === 'blocked' ? questionOf(text) : null
    const question = asked?.text ?? null
    return {
      question,
      ask_kind: asked?.kind ?? null,
      last_say: status === 'done' ? extractLastSay(text) : null,
      failed: failedFor(text, status, question),
    }
  }, now)
}

// ── Claude 세션 기록(jsonl)의 마지막 요청 ────────────────────
const projectsDir = () => process.env.CLAUDE_PROJECTS_DIR || join(homedir(), '.claude', 'projects')

export function findSessionFile(sessionId) {
  if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId)) return null
  return memo(`file:${sessionId}`, 300000, () => {
    const root = projectsDir()
    for (const dir of readdirSync(root)) {
      const p = join(root, dir, `${sessionId}.jsonl`)
      if (existsSync(p)) return p
    }
    return null
  })
}

function tailText(path, bytes) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const len = Math.min(bytes, size)
    const buf = Buffer.alloc(len)
    readSync(fd, buf, 0, len, size - len)
    return buf.toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export function lastPromptIn(text) {
  let last = null
  for (const line of text.split('\n')) {
    if (!line.startsWith('{') || !line.includes('"user"')) continue
    let o
    try { o = JSON.parse(line) } catch { continue }
    if (o.type !== 'user' || o.isMeta) continue
    const c = o.message?.content
    const t = (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text).join(' ') : '').trim()
    if (!t || t.startsWith('<') || /^This session is being continued/.test(t) || /^claude --resume/.test(t)) continue
    last = { at: o.timestamp || null, text: t.replace(/\s+/g, ' ').slice(0, 200) }
  }
  return last
}

export function lastPrompt(sessionId, now = Date.now()) {
  return memo(`prompt:${sessionId}`, 15000, () => {
    const file = findSessionFile(sessionId)
    if (!file) return null
    for (const bytes of [262144, 4194304]) {
      const hit = lastPromptIn(tailText(file, bytes))
      if (hit) return hit
    }
    return null
  }, now)
}

// I-5 기록의 구조 표식: Claude는 재시도를 다 쓴 뒤 isApiErrorMessage 합성 줄을 남긴다. 마지막 대화 줄이 그것이면 실패다.
// 꼬리 끝에서 거꾸로 첫 대화 줄(user·assistant)만 본다. 그 뒤에 사람이 말했거나 정상 답이 왔으면 실패가 아니다.
export function apiErrorIn(text) {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (!l.startsWith('{')) continue
    let o
    try { o = JSON.parse(l) } catch { continue }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    if (o.type === 'user' && (o.isMeta || o.toolUseResult)) continue
    return o.type === 'assistant' && o.isApiErrorMessage === true ? { kind: o.error || 'unknown', at: o.timestamp || null } : null
  }
  return null
}
export function lastApiError(sessionId, now = Date.now()) {
  return memo(`apierr:${sessionId}`, 15000, () => {
    const file = findSessionFile(sessionId)
    return file ? apiErrorIn(tailText(file, 65536)) : null
  }, now)
}

// ── git 브랜치 ───────────────────────────────────────────────
export function branchOf(cwd, now = Date.now()) {
  if (!cwd || !existsSync(cwd)) return null
  return memo(`branch:${cwd}`, 60000, () => {
    const quiet = { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', stdio: ['ignore', 'pipe', 'ignore'] }
    const b = execFileSync('/usr/bin/git', ['-C', cwd, 'branch', '--show-current'], quiet).trim() // guard-ok: quiet에 timeout
    if (!b) return null
    const dirty = execFileSync('/usr/bin/git', ['-C', cwd, 'status', '--porcelain', '--untracked-files=no'], quiet).trim() !== '' // guard-ok: quiet에 timeout
    return dirty ? `${b}*` : b
  }, now)
}


// ── 이어서 열기 대상 ─────────────────────────────────────────
// 판에 보인 대상과 버튼이 여는 대상은 이 함수 하나로 정한다(I-3). 서버도 누를 때 같은 함수로 다시 계산해 비교한다.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const KNOWN_AGENTS = ['claude', 'codex', 'gemini', 'opencode', 'cursor-agent', 'amp', 'aider', 'goose', 'qwen', 'pi', 'grok', 'droid']
// 실행 명령의 첫 단어가 알려진 에이전트면 그 이름, 래퍼(cco 등)처럼 모르는 명령이면 null.
export const cmdAgent = (cmd) => { const b = String(cmd || '').trim().split(/\s+/)[0].split('/').pop(); return KNOWN_AGENTS.includes(b) ? b : null }

function headText(path, bytes) {
  const fd = openSync(path, 'r')
  try { const buf = Buffer.alloc(Math.min(bytes, fstatSync(fd).size)); readSync(fd, buf, 0, buf.length, 0); return buf.toString('utf8') } finally { closeSync(fd) }
}
// 대화 줄(user·assistant)이 하나라도 있는 기록인가(#20). 요약·스냅숏만 있는 파일은 --resume으로 열어도 빈 대화다.
export function hasConversationLine(file) {
  const isConv = (text) => text.split('\n').some((l) => { if (!l.startsWith('{')) return false; try { const t = JSON.parse(l).type; return t === 'user' || t === 'assistant' } catch { return false } })
  try { return isConv(headText(file, 65536)) || isConv(tailText(file, 65536)) } catch { return false }
}
function describe(file, sid, from) {
  let prompt = null
  for (const bytes of [262144, 4194304]) { prompt = lastPromptIn(tailText(file, bytes)); if (prompt) break }
  return { sid, from, at: new Date(statSync(file).mtimeMs).toISOString(), prompt: prompt?.text ?? null }
}

// s: 세션 행(provider, provider_session, cwd). exclude: 다른 칸에서 지금 살아 있는 대화 id(#9). cmd: 실행 명령.
// 돌려주는 값 {sid, from:'pane'|'folder', at, prompt} 또는 null(새 대화로 시작).
export function resumeTarget(s, { exclude = new Set(), cmd = 'claude' } = {}) {
  // 재개 후보는 Claude 기록뿐이다. 실행 명령이나 칸의 공급자가 다른 에이전트면 그 id로 열지 않는다(#18).
  const agent = cmdAgent(cmd)
  if (agent && agent !== 'claude') return null
  if (s.provider && s.provider !== 'claude') return null
  const key = `resume:${s.provider_session || ''}:${s.cwd || ''}:${[...exclude].sort().join(',')}`
  return memo(key, 15000, () => {
    const own = s.provider_session
    if (UUID.test(own || '') && !exclude.has(own)) {
      const file = findSessionFile(own)
      if (file && hasConversationLine(file)) return describe(file, own, 'pane')
    }
    if (!s.cwd) return null
    const dir = join(projectsDir(), s.cwd.replace(/[^A-Za-z0-9]/g, '-'))
    if (!existsSync(dir)) return null
    const cands = readdirSync(dir).filter((f) => f.endsWith('.jsonl') && UUID.test(f.slice(0, -6)) && !exclude.has(f.slice(0, -6)))
      .map((f) => ({ sid: f.slice(0, -6), file: join(dir, f), mtime: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    const hit = cands.find((c) => hasConversationLine(c.file))
    return hit ? describe(hit.file, hit.sid, 'folder') : null
  })
}
