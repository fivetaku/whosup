#!/usr/bin/env node
// desks — declare which herdr sessions and panes you want (one session per monitor is the usual shape),
// and whosup creates what is missing. Idempotent: existing sessions/panes are left alone.
//
//   herdr plugin action invoke fivetaku.whosup.desks-apply    create sessions + panes from desks.json
//   herdr plugin action invoke fivetaku.whosup.desks-status   show what exists vs what is declared
//
// Config: $HERDR_PLUGIN_CONFIG_DIR/desks.json (or ~/.config/whosup/desks.json)
// {
//   "desks": [
//     { "session": "main", "note": "left monitor", "panes": [ { "label": "api", "cwd": "~/work/api" }, ... ], "agent": true },
//     { "session": "side", "panes": [ ... ], "agent": false }
//   ],
//   "agent_cmd": "claude"            // optional; else AGENT_CMD env, else "claude"
// }
// Opening a terminal window per session is up to you (any terminal: `herdr --session main`).
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { bin as herdrBin } from '../src/runtime/herdr.mjs'

const CONF = process.env.HERDR_PLUGIN_CONFIG_DIR || join(homedir(), '.config', 'whosup')
const FILE = join(CONF, 'desks.json')
const BIN = herdrBin()
const h = (session, ...args) => execFileSync(BIN, ['--session', session, ...args], { encoding: 'utf8', timeout: 15000 })
const hj = (session, ...args) => JSON.parse(h(session, ...args)).result
const tilde = (p) => p.replace(/^~(?=$|\/)/, homedir())

function sessions() {
  return execFileSync(BIN, ['session', 'list'], { encoding: 'utf8', timeout: 15000 }).split('\n').slice(1).map((l) => l.trim().split(/\s+/)).filter((c) => c.length >= 4).map(([name, status, dir]) => ({ name, status, dir }))
}
const running = (name) => sessions().some((s) => s.name === name && s.status === 'running')

async function ensureSession(name, cwd) {
  if (running(name)) return false
  let spawnErr = null
  const child = spawn(BIN, ['--session', name, 'server'], { cwd, detached: true, stdio: 'ignore' })
  child.once('error', (err) => { spawnErr = err })
  child.unref()
  for (let i = 0; i < 40 && !spawnErr && !running(name); i++) await sleep(250)
  if (spawnErr) throw new Error(`could not start herdr session ${name}: ${spawnErr.message}`)
  if (!running(name)) throw new Error(`could not start herdr session ${name}`)
  await sleep(1000)
  return true
}

function load() {
  if (!existsSync(FILE)) { console.error(`no ${FILE} — create it by hand (see README: desks)`); process.exit(2) }
  return JSON.parse(readFileSync(FILE, 'utf8'))
}

async function apply() {
  const cfg = load()
  const agentCmd = cfg.agent_cmd || process.env.AGENT_CMD || 'claude'
  for (const d of cfg.desks || []) {
    const panes = (d.panes || []).map((p) => ({ label: p.label || basename(tilde(p.cwd || '~')), cwd: tilde(p.cwd || '~') }))
    if (!panes.length) continue
    const started = await ensureSession(d.session, panes[0].cwd)
    let existing = hj(d.session, 'pane', 'list').panes || []
    if (existing.length >= panes.length) { console.log(`[${d.session}] ${existing.length} panes already — skipped`); continue }
    if (!existing.length) {
      // a fresh headless session has no workspace yet
      h(d.session, 'workspace', 'create', '--cwd', panes[0].cwd, '--label', `desk-${d.session}`)
      for (let i = 0; i < 20 && !existing.length; i++) { await sleep(250); existing = hj(d.session, 'pane', 'list').panes || [] }
      if (!existing.length) throw new Error(`[${d.session}] workspace created but no pane appeared`)
    }
    const root = existing[0]
    const ws = root.pane_id.split(':')[0]
    try { h(d.session, 'workspace', 'rename', ws, `desk-${d.session}`) } catch {}
    h(d.session, 'pane', 'rename', root.pane_id, panes[0].label)
    h(d.session, 'pane', 'run', root.pane_id, `cd ${JSON.stringify(panes[0].cwd)}; clear`)
    let cur = root.pane_id
    const ids = [cur]
    for (let k = 1; k < panes.length; k++) {
      const remaining = panes.length - k + 1
      const ratio = (1 / remaining).toFixed(4)
      const res = hj(d.session, 'pane', 'split', cur, '--direction', 'right', '--ratio', ratio, '--cwd', panes[k].cwd, '--no-focus')
      const id = res?.pane?.pane_id || res?.pane_id
      h(d.session, 'pane', 'rename', id, panes[k].label)
      ids.push(id)
      cur = id
    }
    console.log(`[${d.session}] ${started ? 'started, ' : ''}${panes.length} panes created: ${panes.map((p) => p.label).join(' · ')}`)
    if (d.agent) {
      await sleep(500)
      for (const id of ids) h(d.session, 'pane', 'run', id, agentCmd)
      console.log(`[${d.session}] ran "${agentCmd}" in every pane`)
    }
  }
}

function status() {
  const cfg = load()
  const live = sessions()
  for (const d of cfg.desks || []) {
    const s = live.find((x) => x.name === d.session)
    const n = s?.status === 'running' ? (hj(d.session, 'pane', 'list').panes || []).length : 0
    console.log(`${d.session.padEnd(10)} ${(s?.status || 'absent').padEnd(8)} panes ${n}/${(d.panes || []).length}${d.note ? `  — ${d.note}` : ''}`)
  }
}

function init() {
  mkdirSync(CONF, { recursive: true })
  if (existsSync(FILE)) { console.log(`${FILE} exists`); return }
  writeFileSync(FILE, JSON.stringify({ desks: [{ session: 'main', note: 'main monitor', agent: true, panes: [{ label: 'app', cwd: '~/src/app' }, { label: 'api', cwd: '~/src/api' }, { label: 'home', cwd: '~' }] }] }, null, 2) + '\n')
  console.log(`wrote ${FILE} — edit it, then: whosup desks apply`)
}

const cmd = process.argv[2]
if (cmd === 'apply') await apply()
else if (cmd === 'status') status()
else if (cmd === 'init') init()
else { console.log('usage: desks.mjs apply|status|init'); process.exit(2) }
