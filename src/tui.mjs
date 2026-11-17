// whosup's terminal screen helpers (the "rich" install screen): which mode to draw in, styles with NO_COLOR, symbols with an
// ASCII fallback, display width (East Asian wide = 2 cells), wrapping with a hanging indent that never splits a path or URL,
// blocks of output (progress lines, sections, commands, key/value rows), and an arrow-key menu.
//
// install.sh asks its questions before whosup's files are on the machine, so it carries a copy of the code between the two
// UI_JS marker lines below in a single-quoted shell variable (UI_JS) and runs it with `node_js "$UI_JS" <command>` (the code goes in an environment variable, see node_js in install.sh).
// scripts/gen-install-ui.mjs writes that copy; test/tui.test.mjs checks that the two are the same. Inside the markers:
// no single-quote character (it would end the shell string), no import/export (the copy runs as a plain script), no line that
// starts with the word function (install.sh is checked for bash-only syntax line by line: functions are const = function) — modules
// come from process.getBuiltinModule (Node 22.3+; whosup needs 22.13).
//
// Modes:
//   plain  what the installer printed before this screen, byte for byte. WHOSUP_UI=plain, or (WHOSUP_UI not given) stdout or
//          /dev/tty is not a terminal, TERM is empty or dumb, CI is on, WHOSUP_NO_SETUP is on.
//   rich   a person at a terminal. WHOSUP_UI=rich forces it (tests). NO_COLOR keeps the layout without colors. A locale that
//          is not UTF-8 gets ASCII symbols.
// The menu switches the terminal with `stty -icanon -echo min 1 time 0` (ISIG stays on: Ctrl-C still reaches the whole process
// group as SIGINT) — never setRawMode — and puts the saved settings back however it ends.

// >>> UI_JS (copied into install.sh by scripts/gen-install-ui.mjs; keep it free of single quotes)
const UI_TEXT = {
  en: {
    def: "(default)",
    hint: (n, secs) => `Up/Down arrows to move, Enter to pick | a number picks at once | ${n} after ${secs}s`,
    auto: " (no answer, picked by itself)",
  },
  ko: {
    def: "(기본)",
    hint: (n, secs) => `위/아래 화살표로 고르고 Enter | 번호를 누르면 바로 정합니다 | ${secs}초 뒤 ${n}번`,
    auto: " (답이 없어 자동으로 골랐습니다)",
  },
}

// switch values the way install.sh `on` and src/setup.mjs envOn read them: unset, empty, 0, false, no, off = off
const uiOn = function (v) { return !["", "0", "false", "no", "off"].includes(String(v ?? "").toLowerCase().replace(/ /g, "")) }

// uiMode({ env, stdoutTTY, ttyOK }) -> { mode: "rich" | "plain", color, utf8 }
//   stdoutTTY: stdout is a terminal. ttyOK: /dev/tty can be opened. color: NO_COLOR is empty. utf8: the locale says UTF-8.
const uiMode = function ({ env = {}, stdoutTTY = false, ttyOK = false } = {}) {
  const want = String(env.WHOSUP_UI || "").toLowerCase()
  let mode
  if (want === "plain") mode = "plain"
  else if (want === "rich") mode = "rich"
  else {
    const term = String(env.TERM || "")
    mode = stdoutTTY && ttyOK && term !== "" && term !== "dumb" && !uiOn(env.CI) && !uiOn(env.WHOSUP_NO_SETUP) ? "rich" : "plain"
  }
  return { mode, color: !env.NO_COLOR, utf8: uiUtf8(env) }
}
// the locale that decides the character set: LC_ALL > LC_CTYPE > LANG
const uiUtf8 = function (env = {}) { return /utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "") }

// uiCols({ ttyCols, env, sttyCols }) -> { cols, known }: the first positive of the terminal size (/dev/tty), WHOSUP_UI_COLS
// (what install.sh measured for its children), COLUMNS, `stty size`; else 80. Clamped to 40..100. known = it came from a real
// measurement of the terminal (the menu only moves the cursor back over what it drew when it knows the width).
const uiCols = function ({ ttyCols = 0, env = {}, sttyCols = 0 } = {}) {
  const pos = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0 }
  const raw = pos(ttyCols) || pos(env.WHOSUP_UI_COLS) || pos(env.COLUMNS) || pos(sttyCols)
  return { cols: Math.min(100, Math.max(40, raw || 80)), known: pos(ttyCols) > 0 }
}

const uiSymbols = function (utf8) {
  return utf8 ? { ok: "✓", run: "…", fail: "✗", warn: "!", dot: "·", sel: ">" } : { ok: "ok", run: "..", fail: "x", warn: "!", dot: "-", sel: ">" }
}
// SGR styles. No yellow, white, gray or black (light and dark backgrounds): bold, dim, green (only the check mark), red (failure).
const uiStyle = function (color) {
  const w = (a) => (s) => (color && s !== "" ? `\x1b[${a}m${s}\x1b[0m` : String(s))
  return { bold: w("1"), dim: w("2"), green: w("32"), red: w("31"), redBold: w("1;31") }
}

// ── display width ──
const UI_WIDE = [0x1100, 0x115f, 0x231a, 0x231b, 0x2329, 0x232a, 0x23e9, 0x23ec, 0x23f0, 0x23f0, 0x23f3, 0x23f3, 0x25fd, 0x25fe, 0x2614, 0x2615,
  0x2648, 0x2653, 0x267f, 0x267f, 0x2693, 0x2693, 0x26a1, 0x26a1, 0x26aa, 0x26ab, 0x26bd, 0x26be, 0x26c4, 0x26c5, 0x26ce, 0x26ce, 0x26d4, 0x26d4,
  0x26ea, 0x26ea, 0x26f2, 0x26f3, 0x26f5, 0x26f5, 0x26fa, 0x26fa, 0x26fd, 0x26fd, 0x2705, 0x2705, 0x270a, 0x270b, 0x2728, 0x2728, 0x274c, 0x274c,
  0x274e, 0x274e, 0x2753, 0x2755, 0x2757, 0x2757, 0x2795, 0x2797, 0x27b0, 0x27b0, 0x27bf, 0x27bf, 0x2b1b, 0x2b1c, 0x2b50, 0x2b50, 0x2b55, 0x2b55,
  0x2e80, 0x303e, 0x3041, 0x33ff, 0x3400, 0x4dbf, 0x4e00, 0x9fff, 0xa000, 0xa4cf, 0xa960, 0xa97f, 0xac00, 0xd7a3, 0xf900, 0xfaff, 0xfe10, 0xfe19,
  0xfe30, 0xfe6f, 0xff00, 0xff60, 0xffe0, 0xffe6, 0x1f004, 0x1f004, 0x1f0cf, 0x1f0cf, 0x1f18e, 0x1f18e, 0x1f191, 0x1f19a, 0x1f200, 0x1f251,
  0x1f300, 0x1f64f, 0x1f680, 0x1f6ff, 0x1f900, 0x1f9ff, 0x1fa70, 0x1faff, 0x20000, 0x3fffd]
// East Asian Ambiguous (the common part of it): one cell in most terminals, two where the terminal is set to treat them as wide
const UI_AMBIGUOUS = [0xa1, 0xa1, 0xa4, 0xa4, 0xa7, 0xa8, 0xaa, 0xaa, 0xad, 0xae, 0xb0, 0xb4, 0xb6, 0xba, 0xbc, 0xbf, 0xc6, 0xc6, 0xd0, 0xd0,
  0xd7, 0xd8, 0xde, 0xe1, 0xe6, 0xe6, 0xe8, 0xea, 0xec, 0xed, 0xf0, 0xf0, 0xf2, 0xf3, 0xf7, 0xfa, 0xfc, 0xfc, 0xfe, 0xfe, 0x101, 0x101, 0x111, 0x111,
  0x113, 0x113, 0x11b, 0x11b, 0x126, 0x127, 0x12b, 0x12b, 0x131, 0x133, 0x138, 0x138, 0x13f, 0x142, 0x144, 0x144, 0x148, 0x14b, 0x14d, 0x14d,
  0x152, 0x153, 0x166, 0x167, 0x16b, 0x16b, 0x1ce, 0x1dc, 0x251, 0x251, 0x261, 0x261, 0x2c4, 0x2c4, 0x2c7, 0x2c7, 0x2c9, 0x2cb, 0x2cd, 0x2cd,
  0x2d0, 0x2d0, 0x2d8, 0x2db, 0x2dd, 0x2dd, 0x2df, 0x2df, 0x391, 0x3a9, 0x3b1, 0x3c9, 0x401, 0x401, 0x410, 0x44f, 0x451, 0x451, 0x2010, 0x2010,
  0x2013, 0x2016, 0x2018, 0x2019, 0x201c, 0x201d, 0x2020, 0x2022, 0x2024, 0x2027, 0x2030, 0x2030, 0x2032, 0x2033, 0x2035, 0x2035, 0x203b, 0x203b,
  0x203e, 0x203e, 0x2074, 0x2074, 0x207f, 0x207f, 0x2081, 0x2084, 0x20ac, 0x20ac, 0x2103, 0x2103, 0x2105, 0x2105, 0x2109, 0x2109, 0x2113, 0x2113,
  0x2116, 0x2116, 0x2121, 0x2122, 0x2126, 0x2126, 0x212b, 0x212b, 0x2153, 0x2154, 0x215b, 0x215e, 0x2160, 0x216b, 0x2170, 0x2179, 0x2189, 0x2189,
  0x2190, 0x2199, 0x21b8, 0x21b9, 0x21d2, 0x21d2, 0x21d4, 0x21d4, 0x21e7, 0x21e7, 0x2200, 0x2200, 0x2202, 0x2203, 0x2207, 0x2208, 0x220b, 0x220b,
  0x220f, 0x220f, 0x2211, 0x2211, 0x2215, 0x2215, 0x221a, 0x221a, 0x221d, 0x2220, 0x2223, 0x2223, 0x2225, 0x2225, 0x2227, 0x222c, 0x222e, 0x222e,
  0x2234, 0x2237, 0x223c, 0x223d, 0x2248, 0x2248, 0x224c, 0x224c, 0x2252, 0x2252, 0x2260, 0x2261, 0x2264, 0x2267, 0x226a, 0x226b, 0x226e, 0x226f,
  0x2282, 0x2283, 0x2286, 0x2287, 0x2295, 0x2295, 0x2299, 0x2299, 0x22a5, 0x22a5, 0x22bf, 0x22bf, 0x2312, 0x2312, 0x2460, 0x24e9, 0x24eb, 0x254b,
  0x2550, 0x2573, 0x2580, 0x258f, 0x2592, 0x2595, 0x25a0, 0x25a1, 0x25a3, 0x25a9, 0x25b2, 0x25b3, 0x25b6, 0x25b7, 0x25bc, 0x25bd, 0x25c0, 0x25c1,
  0x25c6, 0x25c8, 0x25cb, 0x25cb, 0x25ce, 0x25d1, 0x25e2, 0x25e5, 0x25ef, 0x25ef, 0x2605, 0x2606, 0x2609, 0x2609, 0x260e, 0x260f, 0x261c, 0x261c,
  0x261e, 0x261e, 0x2640, 0x2640, 0x2642, 0x2642, 0x2660, 0x2661, 0x2663, 0x2665, 0x2667, 0x266a, 0x266c, 0x266d, 0x266f, 0x266f, 0x269e, 0x269f,
  0x26bf, 0x26bf, 0x26c6, 0x26cd, 0x26cf, 0x26d3, 0x26d5, 0x26e1, 0x26e3, 0x26e3, 0x26e8, 0x26e9, 0x26eb, 0x26f1, 0x26f4, 0x26f4, 0x26f6, 0x26f9,
  0x26fb, 0x26fc, 0x26fe, 0x26ff, 0x273d, 0x273d, 0x2776, 0x277f, 0x2b56, 0x2b59, 0x3248, 0x324f, 0xe000, 0xf8ff, 0xfffd, 0xfffd,
  0x1f100, 0x1f10a, 0x1f110, 0x1f12d, 0x1f130, 0x1f169, 0x1f170, 0x1f18d, 0x1f18f, 0x1f190, 0x1f19b, 0x1f1ac, 0xf0000, 0x10fffd]
const uiIn = (cp, ranges) => { for (let i = 0; i < ranges.length; i += 2) { if (cp < ranges[i]) return false; if (cp <= ranges[i + 1]) return true } return false }
const UI_ZERO = /^[\p{Mn}\p{Me}\p{Cf}ᅠ-ᇿ]$/u
const UI_ANSI = /\x1b\[[0-9;?]*[ -\/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[78=>]/g
const stripAnsi = function (s) { return String(s).replace(UI_ANSI, "") }
// cells one code point takes. amb = what an East Asian Ambiguous character counts (1, or 2 to be safe)
const charWidth = function (cp, amb = 1) {
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0
  if (cp < 0x7f) return 1
  if (UI_ZERO.test(String.fromCodePoint(cp))) return 0
  if (uiIn(cp, UI_WIDE)) return 2
  if (uiIn(cp, UI_AMBIGUOUS)) return amb
  return 1
}
// strWidth(text, { amb }): cells the text takes on one line (escape sequences take none)
const strWidth = function (s, { amb = 1 } = {}) { let n = 0; for (const ch of stripAnsi(s)) n += charWidth(ch.codePointAt(0), amb); return n }
// rows the drawn lines take on a terminal that is cols wide
const blockHeight = function (lines, cols, { amb = 1 } = {}) { return lines.reduce((h, l) => h + Math.max(1, Math.ceil(strWidth(l, { amb }) / Math.max(1, cols))), 0) }

// tildePath(path, home): ~ for the home folder, only when the path is inside it (only for showing a path, never in a command)
const tildePath = function (p, home) {
  const s = String(p), h = String(home || "").replace(/\/+$/, "")
  if (!h || h === "") return s
  if (s === h) return "~"
  return s.startsWith(h + "/") ? "~" + s.slice(h.length) : s
}

// wrap(text, width, { first, hang, amb }) -> lines. Breaks only at spaces: a word is never split, so a path, a URL or a
// quoted path with spaces in it stays whole (a word longer than the line gets a line of its own). first = what the first line
// starts with (the indent and a mark), hang = what the lines after it start with (a string, or a number of spaces; default:
// as many spaces as first is wide). Widths are counted with ambiguous characters as amb cells (default 2: the line fits on
// every terminal).
const wrap = function (text, width, { first = "", hang, amb = 2 } = {}) {
  const lead = hang === undefined ? " ".repeat(strWidth(first, { amb })) : typeof hang === "number" ? " ".repeat(hang) : String(hang)
  const words = String(text).match(/\x27[^\x27]*\x27\S*|\S+/g) || []
  const out = []
  let cur = first, empty = true
  for (const w of words) {
    if (empty) { cur += w; empty = false; continue }
    if (strWidth(`${cur} ${w}`, { amb }) <= width) cur += ` ${w}`
    else { out.push(cur); cur = lead + w }
  }
  out.push(cur)
  return out
}

// ── blocks ──
// renderBlocks(blocks, { width, color, utf8 }) -> lines. A block is [kind, a, b]:
//   blank · head <title> <what> · ok|run|warn|fail <text> (a progress line; fail moves a closing sentence such as
//   "Nothing was changed." to a line of its own) · done <text> · title <text> (a section) · para <text> (indent 2) ·
//   item <text> (indent 4, inside a section) · num <n> <text> (a numbered step) · cmd <command> (to type: never split,
//   indent 6, or 7 under a numbered step to line up with its text, or 2 when that does not fit) · kv <key> <value> (rows next
//   to each other share the value column) · cmdkv <command> <what it does> (a kv row whose key is a command, bold; when the
//   value column would be too narrow the command gets a line of its own and what it does goes under it at 8) · foot <text> (dim).
const UI_TAIL = /^(.*\S)\s+(Nothing was changed\.|Nothing was installed\.|whosup was not installed\.|바꾼 것은 없습니다\.|아무것도 설치하지 않았습니다\.|whosup은 설치하지 않았습니다\.)$/
const renderBlocks = function (blocks, { width = 80, color = true, utf8 = true } = {}) {
  const S = uiStyle(color), Y = uiSymbols(utf8), out = []
  const keyCol = (i) => { const k = blocks[i][0]; let w = 0; for (let j = i; j < blocks.length && blocks[j][0] === k; j++) w = Math.max(w, strWidth(blocks[j][1])); for (let j = i - 1; j >= 0 && blocks[j][0] === k; j--) w = Math.max(w, strWidth(blocks[j][1])); return w }
  const mark = { ok: S.green(Y.ok), run: Y.run, warn: S.bold(Y.warn), fail: S.redBold(Y.fail) }
  blocks.forEach((b, i) => {
    const [kind, a = "", c = ""] = b
    if (kind === "blank") out.push("")
    else if (kind === "head") out.push(`  ${S.bold(a)}${c ? `  ${Y.dot}  ${c}` : ""}`)
    else if (kind in mark) {
      let text = a, tail = ""
      if (kind === "fail") { const m = UI_TAIL.exec(a); if (m) { text = m[1]; tail = m[2] } }
      const sym = kind === "run" ? Y.run : Y[kind]
      const ls = wrap(text, width, { first: `  ${sym} `, hang: 2 + strWidth(sym) + 1 })
      ls[0] = `  ${mark[kind]} ${ls[0].slice(3 + sym.length)}`
      out.push(...ls)
      if (tail) out.push("", ...wrap(tail, width, { first: "  " }))
    } else if (kind === "done") { const ls = wrap(a, width, { first: `  ${Y.ok} ` }); ls[0] = `  ${S.green(Y.ok)} ${S.bold(ls[0].slice(3 + Y.ok.length))}`; out.push(...ls) }
    else if (kind === "title") out.push(`  ${S.bold(a)}`)
    else if (kind === "para") out.push(...wrap(a, width, { first: "  " }))
    else if (kind === "item") out.push(...wrap(a, width, { first: "    " }))
    else if (kind === "num") out.push(...wrap(c, width, { first: `    ${a}. ` }))
    else if (kind === "cmd") {
      // under a numbered step the command lines up with the text of the step ("    2. " = 7 cells), else 6
      let j = i - 1
      while (j >= 0 && blocks[j][0] === "cmd") j--
      const ind = " ".repeat(j >= 0 && blocks[j][0] === "num" ? 4 + strWidth(`${blocks[j][1]}. `) : 6)
      out.push(`${strWidth(`${ind}${a}`) <= width ? ind : "  "}${S.bold(a)}`)
    }
    else if (kind === "kv") {
      // a word that cannot be split (a path) and does not fit in the value column: the value goes under the key at 6
      const k = keyCol(i), pad = 4 + k + 3, long = Math.max(0, ...String(c).split(/\s+/).map((w) => strWidth(w)))
      if (pad + long > width) out.push(`    ${a}`, ...wrap(c, width, { first: "      " }))
      else out.push(...wrap(c, width, { first: `    ${a}${" ".repeat(k - strWidth(a) + 3)}`, hang: pad }))
    } else if (kind === "cmdkv") {
      const k = keyCol(i), pad = 4 + k + 2
      if (pad + 20 <= width) out.push(...wrap(c, width, { first: `    ${S.bold(a)}${" ".repeat(k - strWidth(a) + 2)}`, hang: pad }))
      else out.push(`${strWidth(`    ${a}`) <= width ? "    " : "  "}${S.bold(a)}`, ...wrap(c, width, { first: "        " }))
    } else if (kind === "foot") out.push(...wrap(a, width, { first: "  " }).map((l) => (l.trim() ? `  ${S.dim(l.slice(2))}` : l)))
  })
  return out
}

// ── the menu ──
// menuLines({ title, options: [{ label, desc: [lines] }], sel, preset, secs, lang, width, color, utf8, lead }) -> lines:
// (a blank line first when lead), the title, the options (the one under the cursor has ">" and is bold — not color alone),
// the lines of each option under it at 7 cells, and the key hint (dim). desc lines are wrapped to the width.
const menuLines = function ({ title, options = [], sel = 1, preset = 1, secs = 120, lang = "en", width = 80, color = true, utf8 = true, lead = false } = {}) {
  const S = uiStyle(color), Y = uiSymbols(utf8), T = UI_TEXT[lang] || UI_TEXT.en
  const out = lead ? [""] : []
  out.push(...wrap(title, width, { first: "  " }).map((l) => `  ${S.bold(l.slice(2))}`), "")
  options.forEach((o, k) => {
    const n = k + 1, head = `${n}  ${o.label}`, def = n === preset ? `  ${T.def}` : ""
    out.push(n === sel ? `  ${S.bold(`${Y.sel} ${head}`)}${def}` : `    ${head}${def}`)
    for (const d of o.desc || []) out.push(...wrap(d, width, { first: "       " }))
  })
  out.push("", ...hintLines(T.hint(preset, secs), width).map((l) => `  ${S.dim(l.slice(2))}`))
  return out
}
// the key hint: parts separated by " | ", and a line breaks only between two parts (a part that is wider than the line by
// itself is wrapped at its spaces)
const hintLines = function (hint, width) {
  const out = []
  let cur = ""
  for (const part of String(hint).split(" | ")) {
    if (cur && strWidth(`${cur} | ${part}`, { amb: 2 }) <= width) { cur += ` | ${part}`; continue }
    if (cur) out.push(cur)
    const ls = wrap(part, width, { first: "  " })
    cur = ls.pop()
    out.push(...ls)
  }
  if (cur) out.push(cur)
  return out
}
// the line a finished question folds into: "  ✓ <prefix>: <label>" (+ "(no answer, picked by itself)"). With a width it is
// wrapped like a progress line (the lines after the first start under the text, at 4 cells); the lines are joined with "\n".
const collapseLine = function ({ prefix, label, auto = false, lang = "en", color = true, utf8 = true, width = 0 } = {}) {
  const S = uiStyle(color), Y = uiSymbols(utf8), T = UI_TEXT[lang] || UI_TEXT.en
  const text = `${prefix}: ${label}${auto ? T.auto : ""}`
  if (!(width > 0)) return `  ${S.green(Y.ok)} ${text}`
  const ls = wrap(text, width, { first: `  ${Y.ok} `, hang: 2 + strWidth(Y.ok) + 1 })
  ls[0] = `  ${S.green(Y.ok)} ${ls[0].slice(3 + Y.ok.length)}`
  return ls.join("\n")
}
// can what was drawn be erased by moving the cursor up over it? Only when the terminal size is known, every line takes the
// same number of rows whether an ambiguous character is 1 or 2 cells, and the block is shorter than the screen.
const menuFits = function (lines, { cols = 0, rows = 0 } = {}) {
  if (!(cols > 0) || !(rows > 0)) return { sure: false, h: 0 }
  const h1 = blockHeight(lines, cols, { amb: 1 }), h2 = blockHeight(lines, cols, { amb: 2 })
  return { sure: h1 === h2 && h1 < rows, h: h1 }
}
// menuFeed(state, chunk, now) -> { st, done }: keys typed. state = { sel, n, esc (an unfinished escape sequence), skipNl
// (until this time a CR/LF that comes first is dropped: the Enter after a number that already picked) }.
// Up/Down (ESC [ A/B, ESC O A/B) and k/j move (round), Enter picks the option under the cursor, a number picks that option at
// once (what follows it in the same read is not looked at), Ctrl-C (only seen when the terminal does not turn it into SIGINT)
// is "interrupt". done = { n, how: "key" | "digit" | "interrupt" } or null.
const menuFeed = function (state, chunk, now = 0) {
  const st = { ...state, esc: "" }
  const s = (state.esc || "") + String(chunk)
  const move = (d) => { st.sel = ((st.sel - 1 + d + st.n) % st.n) + 1 }
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (c === "\x1b") {
      const rest = s.slice(i)
      const m = /^\x1b[\[O]([AB])/.exec(rest)
      if (m) { move(m[1] === "A" ? -1 : 1); st.skipNl = 0; i += 2; continue }
      if (/^\x1b[\[O]?$/.test(rest)) { st.esc = rest; break }
      const csi = /^\x1b\[[0-9;?]*[ -\/]*[@-~]/.exec(rest)
      if (csi) i += csi[0].length - 1
      continue
    }
    if (c === "\r" || c === "\n") {
      if (st.skipNl && now <= st.skipNl) { st.skipNl = 0; continue }
      return { st, done: { n: st.sel, how: "key" } }
    }
    st.skipNl = 0
    if (c === "\x03") return { st, done: { n: st.sel, how: "interrupt" } }
    if (c === "k") move(-1)
    else if (c === "j") move(1)
    else if (c >= "1" && c <= "9" && Number(c) <= st.n) { st.sel = Number(c); return { st, done: { n: st.sel, how: "digit" } } }
  }
  return { st, done: null }
}

// runMenu(opts) -> Promise<{ n, how }>: draws the menu on /dev/tty and reads keys from it.
//   opts: { title, options, preset, secs, lang, prefix (of the folded line), lead, afterDigit (the question before was picked
//   with a number: drop an Enter that comes first within a second), color, utf8, env, ttyPath, signal (an AbortSignal: when
//   it fires the menu ends as "closed", left on the screen as it is) }
//   how: key | digit | timeout (no key for secs: preset) | closed (no terminal, not in the foreground, input ended) |
//   noraw (stty could not switch the terminal: ask the numbered way instead) | interrupt (SIGINT, signal: SIGTERM, SIGHUP).
// The terminal settings are saved (stty -g) and put back, and the cursor shown again, however it ends.
const runMenu = function (o = {}) {
  const fs = process.getBuiltinModule("fs"), tty = process.getBuiltinModule("tty"), cp = process.getBuiltinModule("child_process")
  const env = o.env || process.env, path = o.ttyPath || "/dev/tty"
  const n = (o.options || []).length, preset = Math.min(Math.max(1, Number(o.preset) || 1), n || 1)
  const secs = Math.max(1, Number(o.secs) || 120), lang = o.lang === "ko" ? "ko" : "en"
  const color = o.color ?? !env.NO_COLOR, utf8 = o.utf8 ?? uiUtf8(env)
  return new Promise((resolve) => {
    if (o.signal && o.signal.aborted) return resolve({ n: preset, how: "closed" })
    let rfd = -1, wfd = -1
    const closeFds = () => { for (const fd of [rfd, wfd]) { try { if (fd >= 0) fs.closeSync(fd) } catch {} } }
    try { rfd = fs.openSync(path, "r"); wfd = fs.openSync(path, "w") } catch { closeFds(); return resolve({ n: preset, how: "closed" }) }
    // the foreground process group of the terminal only (reading from the background stops the process: SIGTTIN)
    try {
      const m = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(cp.execFileSync("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }))
      if (m && m[1] !== m[2]) { closeFds(); return resolve({ n: preset, how: "closed" }) }
    } catch {}
    const stty = (args) => { try { return cp.spawnSync("stty", args, { stdio: [rfd, "pipe", "ignore"], encoding: "utf8", timeout: 3000 }) } catch { return { status: 1, stdout: "" } } }
    const g = stty(["-g"]), saved = g.status === 0 ? String(g.stdout || "").trim() : ""
    if (!saved || stty(["-icanon", "-echo", "min", "1", "time", "0"]).status !== 0) { if (saved) stty([saved]); closeFds(); return resolve({ n: preset, how: "noraw" }) }
    const write = (s) => { try { fs.writeSync(wfd, s) } catch {} }
    const size = () => { const r = stty(["size"]); const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(String(r.stdout || "")); return m ? { rows: Number(m[1]), cols: Number(m[2]) } : { rows: 0, cols: 0 } }
    let sz = size(), resized = false
    const width = () => { const c = uiCols({ ttyCols: sz.cols, env }).cols; return sz.cols > 0 ? Math.min(c, sz.cols) - 1 : c - 1 }
    let st = { sel: preset, n, esc: "", skipNl: o.afterDigit ? Date.now() + 1000 : 0 }
    let drawn = null   // { h, sure } of what is on the screen now
    const lines = () => menuLines({ title: o.title, options: o.options, sel: st.sel, preset, secs, lang, width: width(), color, utf8, lead: o.lead })
    const erase = () => { if (drawn && drawn.sure && !resized) { write(`\x1b[${drawn.h}A\r\x1b[J`); return true } return false }
    const draw = () => {
      const ls = lines()
      if (drawn && !erase()) write("\n")
      write(ls.join("\n") + "\n")
      drawn = menuFits(ls, sz)
    }
    let input = null, timer = null, linger = null, ended = false, restored = false
    const cleanup = () => {
      clearTimeout(timer); clearTimeout(linger)
      for (const [s, f] of handlers) process.removeListener(s, f)
      process.removeListener("exit", onExit)
      if (o.signal) o.signal.removeEventListener("abort", onAbort)
      // the settings go back while the terminal is still open here (the input stream closes its descriptor when destroyed)
      stty([saved]); write("\x1b[?25h"); restored = true
      if (input) { try { input.destroy() } catch {} rfd = -1 }
      closeFds()
    }
    const finish = (r, { fold = true, auto = false } = {}) => {
      if (ended) return
      ended = true
      if (fold) {
        const line = collapseLine({ prefix: o.prefix || "", label: (o.options[r.n - 1] || {}).label || String(r.n), auto, lang, color, utf8, width: width() })
        if (!erase()) write("\n")
        write(line + "\n")
      }
      if (r.how === "digit") {
        // the Enter some people type after the number: take it here so it does not answer the next question
        linger = setTimeout(() => { cleanup(); resolve(r) }, 300)
        input.removeAllListeners("data")
        input.on("data", () => { clearTimeout(linger); cleanup(); resolve(r) })
        return
      }
      cleanup(); resolve(r)
    }
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => finish({ n: preset, how: "timeout" }, { auto: true }), secs * 1000) }
    const handlers = [["SIGINT", () => finish({ n: st.sel, how: "interrupt", signal: "SIGINT" }, { fold: false })],
      ["SIGTERM", () => finish({ n: st.sel, how: "interrupt", signal: "SIGTERM" }, { fold: false })],
      ["SIGHUP", () => finish({ n: st.sel, how: "interrupt", signal: "SIGHUP" }, { fold: false })],
      ["SIGWINCH", () => { const now = size(); if (now.cols !== sz.cols || now.rows !== sz.rows) resized = true; sz = now }]]
    for (const [s, f] of handlers) process.on(s, f)
    // the process ends while the menu is up (process.exit from a watchdog, an uncaught error): put the terminal back on the way
    // out — synchronously, nothing else runs after the exit event
    const onExit = () => { if (!restored) { restored = true; stty([saved]); write("\x1b[?25h") } }
    process.on("exit", onExit)
    const onAbort = () => finish({ n: preset, how: "closed" }, { fold: false })
    if (o.signal) o.signal.addEventListener("abort", onAbort, { once: true })
    try { input = new tty.ReadStream(rfd) } catch { input = fs.createReadStream(null, { fd: rfd, autoClose: false }) }
    input.setEncoding("utf8")
    input.on("data", (chunk) => {
      if (ended) return
      const r = menuFeed(st, chunk, Date.now())
      const moved = r.st.sel !== st.sel
      st = r.st
      arm()
      if (r.done && r.done.how === "interrupt") {
        // the terminal did not turn Ctrl-C into a signal: put it back first, then send SIGINT to the whole process group
        finish({ ...r.done, signal: "SIGINT" }, { fold: false })
        try { process.kill(0, "SIGINT") } catch {}
        return
      }
      if (r.done) return finish(r.done)
      if (moved) draw()
    })
    input.on("end", () => finish({ n: preset, how: "closed" }, { fold: false }))
    input.on("error", () => finish({ n: preset, how: "closed" }, { fold: false }))
    write("\x1b[?25l")
    draw()
    arm()
  })
}

// ── command line (install.sh: node_js "$UI_JS" <command> …) ──
//   menu <lang> <secs> <preset> <after-digit 0|1> <lead 0|1> <prefix> <title> <label> <desc> [<label> <desc> …]
//        desc: the lines under the option, separated by newlines. Draws on /dev/tty; prints "<n> <how>" on stdout.
//        Exit: 0 picked · 2 timeout (n = preset) · 3 no terminal · 4 the terminal could not be switched · 130/143/129 signal.
//   print   reads blocks from stdin (one per line: kind<TAB>a<TAB>b) and prints them (width WHOSUP_UI_COLS, color unless
//           NO_COLOR, ASCII symbols unless the locale is UTF-8).
//   width   prints the width print uses.
//   install.sh passes this script in an environment variable and keeps only `node -e eval(process.env.WHOSUP_JS)` on the
//   command line (node_js): a terminal that shows the foreground command in its window title (Terminal.app) showed the whole
//   inline script. It does not rename itself with process.title: on macOS Node writes the name over the argv memory and the
//   window title then ran on into the environment variables (MacBook Air, r5).
const uiCli = async function (argv) {
  const env = process.env, [cmd, ...a] = argv
  const width = () => uiCols({ env }).cols - 1
  if (cmd === "menu") {
    const [lang, secs, preset, afterDigit, lead, prefix, title, ...rest] = a
    const options = []
    for (let i = 0; i + 1 < rest.length; i += 2) options.push({ label: rest[i], desc: String(rest[i + 1]).split("\n").filter((l) => l !== "") })
    const r = await runMenu({ lang, secs, preset, afterDigit: afterDigit === "1", lead: lead === "1", prefix, title, options, env })
    process.stdout.write(`${r.n} ${r.how}\n`)
    const code = { key: 0, digit: 0, timeout: 2, closed: 3, noraw: 4 }[r.how]
    process.exitCode = code ?? ({ SIGTERM: 143, SIGHUP: 129 }[r.signal] || 130)
    return
  }
  if (cmd === "print") {
    const fs = process.getBuiltinModule("fs")
    let text = ""
    try { text = fs.readFileSync(0, "utf8") } catch {}
    const blocks = text.split("\n").filter((l) => l !== "").map((l) => l.split("\t"))
    const out = renderBlocks(blocks, { width: width(), color: !env.NO_COLOR, utf8: uiUtf8(env) })
    if (out.length) process.stdout.write(out.join("\n") + "\n")
    return
  }
  if (cmd === "width") { process.stdout.write(`${width()}\n`); return }
  process.exitCode = 64
}
// <<< UI_JS

export { UI_TEXT, uiOn, uiMode, uiUtf8, uiCols, uiSymbols, uiStyle, stripAnsi, charWidth, strWidth, blockHeight, tildePath, wrap, renderBlocks, menuLines, collapseLine, menuFits, menuFeed, runMenu, uiCli }

// the block between the two UI_JS marker lines of this file (what install.sh carries)
export function uiJsBlock(source) {
  const start = source.indexOf("// >>> UI_JS"), end = source.indexOf("// <<< UI_JS")
  if (start < 0 || end < 0) throw new Error("no UI_JS block")
  return source.slice(source.indexOf("\n", start) + 1, end)
}
