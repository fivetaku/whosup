// 사람마다 바꾸는 수치. 우선순위: DB meta(설정 패널) > 환경변수 > 기본값. 범위 밖 값은 거절한다.
import { getMeta, setMeta } from './db.mjs'

const RESET = Symbol('reset')

export const SETTINGS = {
  seen_snooze_min: { def: 30, min: 1, max: 1440, env: 'WHOSUP_SEEN_SNOOZE_MIN' },
  renotify_min: { def: 15, min: 1, max: 240, env: 'WHOSUP_RENOTIFY_MIN' },
  renotify_max: { def: 4, min: 0, max: 20, env: 'WHOSUP_RENOTIFY_MAX' },
  gone_misses: { def: 3, min: 1, max: 20, env: 'WHOSUP_GONE_MISSES' },
  stale_collect_sec: { def: 30, min: 5, max: 600, env: 'WHOSUP_STALE_COLLECT_SEC' },
  closed_keep_days: { def: 7, min: 1, max: 90, env: 'WHOSUP_CLOSED_KEEP_DAYS' },
  stale_days: { def: 3, min: 1, max: 60, env: ['WHOSUP_STALE_DAYS', 'STALE_DAYS'] },
  os_notify: { def: 0, min: 0, max: 1, env: 'WHOSUP_OS_NOTIFY' },
  unreachable_ttl_h: { def: 24, min: 1, max: 168, env: 'WHOSUP_UNREACHABLE_TTL_H' },
  // 화면 나눠 쓰기: 칸을 누르면 보드 창을 화면 왼쪽 N%에, 터미널 창을 나머지 오른쪽에 붙인다. 0이면 끈다(작은 노트북 화면용).
  split_pct: { def: 0, min: 0, max: 60, env: 'WHOSUP_SPLIT_PCT' },
}

// 글자 설정: 새 세션·이어서 열기에 쓸 명령. 한 줄, 200자 이하.
// front_app: 칸을 누르면 앞으로 올릴(없으면 새 창을 열) 터미널 앱 이름. 비어 있으면 자동(떠 있는 앱 > 기본 터미널).
// 앱 이름은 명령줄과 AppleScript에 들어가므로 글자를 좁게 받는다.
export const TEXT_SETTINGS = {
  agent_cmd: { def: 'claude', env: 'AGENT_CMD', max: 200 },
  front_app: { def: '', env: 'FRONT_APP', max: 60, pattern: /^[A-Za-z0-9 ._-]+$/ },
}
const validText = (spec, v) => typeof v === 'string' && v.trim().length > 0 && v.length <= spec.max && !/[\r\n\0]/.test(v) && (!spec.pattern || spec.pattern.test(v.trim()))

const fromEnv = (spec) => {
  for (const k of [].concat(spec.env)) if (process.env[k] !== undefined && process.env[k] !== '') return Number(process.env[k])
  return undefined
}
const valid = (spec, v) => Number.isFinite(v) && Number.isInteger(v) && v >= spec.min && v <= spec.max

export function getSettings(db) {
  const out = {}
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const saved = db ? getMeta(db, `setting.${key}`) : null
    const cands = [saved == null ? undefined : Number(saved), fromEnv(spec), spec.def]
    out[key] = cands.find((v) => v !== undefined && valid(spec, v)) ?? spec.def
  }
  for (const [key, spec] of Object.entries(TEXT_SETTINGS)) {
    const cands = [db ? getMeta(db, `setting.${key}`) : null, process.env[spec.env], spec.def]
    out[key] = (cands.find((v) => v != null && validText(spec, v)) ?? spec.def).trim()
  }
  return out
}

// patch의 키·값을 검사해 저장한다. 하나라도 틀리면 아무것도 저장하지 않고 이유를 돌려준다.
export function setSettings(db, patch) {
  const errors = []
  const clean = {}
  for (const [key, raw] of Object.entries(patch || {})) {
    if (raw === null || raw === '') { if (SETTINGS[key] || TEXT_SETTINGS[key]) clean[key] = RESET; else errors.push(`unknown setting ${key}`); continue } // 비우면 기본값(환경변수 > 코드 기본값)으로 되돌린다
    if (TEXT_SETTINGS[key]) {
      if (!validText(TEXT_SETTINGS[key], raw)) { errors.push(TEXT_SETTINGS[key].pattern ? `${key} must be an app name: letters, digits, spaces, . _ - (up to ${TEXT_SETTINGS[key].max})` : `${key} must be one line of 1–${TEXT_SETTINGS[key].max} characters`); continue }
      clean[key] = raw.trim(); continue
    }
    const spec = SETTINGS[key]
    if (!spec) { errors.push(`unknown setting ${key}`); continue }
    const v = typeof raw === 'boolean' ? Number(raw) : Number(raw)
    if (!valid(spec, v)) { errors.push(`${key} must be an integer ${spec.min}–${spec.max}`); continue }
    clean[key] = v
  }
  if (errors.length) return { ok: false, errors }
  for (const [k, v] of Object.entries(clean)) {
    if (v === RESET) db.prepare('DELETE FROM meta WHERE key = ?').run(`setting.${k}`)
    else setMeta(db, `setting.${k}`, v)
  }
  return { ok: true, settings: getSettings(db) }
}

// 키마다 지금 값이 어디서 왔는지: saved(설정 패널) | env(환경변수) | default(코드 기본값). 패널이 '(환경변수)'처럼 보인다(I-11).
export function settingSources(db) {
  const out = {}
  for (const [key, spec] of Object.entries(SETTINGS)) {
    const saved = db ? getMeta(db, `setting.${key}`) : null
    const env = fromEnv(spec)
    out[key] = saved != null && valid(spec, Number(saved)) ? 'saved' : env !== undefined && valid(spec, env) ? 'env' : 'default'
  }
  for (const [key, spec] of Object.entries(TEXT_SETTINGS)) {
    const saved = db ? getMeta(db, `setting.${key}`) : null
    out[key] = saved != null && validText(spec, saved) ? 'saved' : process.env[spec.env] != null && validText(spec, process.env[spec.env]) ? 'env' : 'default'
  }
  return out
}

export const SETTING_RANGES = Object.fromEntries([
  ...Object.entries(SETTINGS).map(([k, s]) => [k, { def: s.def, min: s.min, max: s.max }]),
  ...Object.entries(TEXT_SETTINGS).map(([k, s]) => [k, { def: s.def, text: true, max: s.max }]),
])
