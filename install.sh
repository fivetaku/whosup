#!/bin/sh
# whosup installer. One line:
#
#   curl -fsSL https://raw.githubusercontent.com/fivetaku/whosup/main/install.sh | sh
#
# or, from a checkout:  sh install.sh
#
# It looks at this machine and takes one of three paths:
#   plugin      herdr is here (0.9.0 or newer): whosup is installed as a herdr plugin (herdr plugin install fivetaku/whosup --yes).
#               herdr starts the board whenever it starts. Already installed as a plugin: nothing is installed again.
#   standalone  no herdr, but herdr-core is here (the Herdr app, the Ovis app): whosup is installed on its own, without herdr.
#               "Here" = a core is running now, or herdr-core / hc is on the PATH, or an app that brings its own core has run
#               on this machine before and is off now (a core.lock under <XDG_STATE_HOME or ~/.local/state>/herdr-core/<name>/).
#               Program in <XDG_DATA_HOME or ~/.local/share>/whosup/app, the whosup command in ~/.local/bin, settings in
#               ~/.config/whosup, state in <XDG_STATE_HOME or ~/.local/state>/whosup. The board starts now and at every login
#               (macOS LaunchAgent, Linux systemd --user); `whosup autostart off` turns that off.
#               What was installed is written to <data>/whosup/install.json (the install record: the folders and the node
#               this install uses), and the program folder carries the installer's mark (.whosup-install). Only a folder
#               that has both, the record pointing at it and the mark in it, counts as "a standalone install is here": any
#               other folder in that place is neither run nor replaced (the installer says so and ends with 1). That is
#               checked again right before anything in that folder is run and before the folder is moved or removed.
#   neither     nothing to run sessions in is here (no herdr, no herdr-core, no Herdr app, no Ovis app): one is installed first,
#               then whosup is attached to it. On a terminal it is asked in two steps, by number (Enter = the one marked *):
#                 1) Desktop app *   2) Terminal        and, for an app:   1) Herdr *   2) Ovis
#               The line under "Desktop app" names the apps this machine can install; with only one, the second question
#               is not asked.
#               With no terminal to ask in (an agent, a script, CI, WHOSUP_NO_SETUP=1) nothing is asked: the default is the
#               Herdr app; on a machine it does not run on, the Ovis app; where neither can be installed, herdr.
#               On Linux with no desktop in this session (DISPLAY and WAYLAND_DISPLAY are not set) an app could not be
#               opened, so neither app is offered and herdr is installed; WHOSUP_ENV still installs an app there.
#               An app that is already here and was never opened is not installed again: whosup is attached to it. For
#               the Herdr app its core (herdr-core) is checked too, and installed when it is missing.
#               WHOSUP_ENV=herdr-app|ovis-app|herdr sets it without asking. A choice this machine cannot install is not
#               shown (asked for by WHOSUP_ENV: the reason is printed and nothing is installed).
#                 herdr-app   the Herdr app's own installer (no sudo), then the standalone path. macOS on Apple silicon, Linux x86_64/arm64.
#                 ovis-app    the Ovis app from its release files (no sudo), checked against the release's checksum (and, on macOS,
#                             its signature), then the standalone path. macOS: into ~/Applications. Linux: the AppImage, only
#                             where its libraries and FUSE are already here.
#                 herdr       herdr's own installer (no sudo, into ~/.local/bin), then the plugin path.
#               Each of these installers runs with no input and a time limit; what it prints is shown only when it fails. If an app's fails,
#               or what it should have put in place is not there afterwards, the installer says what failed and where to get
#               the app by hand, and ends with 1: whosup is not installed, and no half-downloaded file is left behind.
#               An app that is already in the applications folder is not installed again: whosup is attached to it.
#               whosup does not remove an app it installed: `whosup uninstall` says so in one line (install.json: env_installed).
# A standalone install that is already here is updated in place (`whosup update` runs this installer that way).
# The standalone path holds a lock (<data>/whosup/install.lock, with this installer's PID in it) while it runs, so two
# installers do not replace the same folders at once; `whosup uninstall` and `whosup autostart on|off` take the same lock.
# A lock is taken over only when the process that holds it is gone, never because time has passed. Ctrl-C or a kill in the
# middle of an update puts the version that was here before back in place. An install that cannot be undone cleanly (a
# board that will not stop, a start-at-login entry that will not go) leaves the program where it is and says what to do.
#
# Needs Node 22.13 or newer (node:sqlite). Every node on the PATH and in the usual install places is tried in order and the
# first that is new enough is used (an older node in front does not hide it). With none, whosup can get a Node of its own:
# the official build of Node v24 LTS (NODE_PIN) from nodejs.org, checked against that release's SHASUMS256.txt, unpacked into
# <data>/whosup/node and used by whosup only (the system Node, if any, is not touched). On a terminal it asks once
# (Enter = yes); with no terminal it does so only when WHOSUP_INSTALL_NODE=1. Declined, off, or not possible here (Windows,
# musl Linux, another processor): nothing is installed and one line says what to do, as before. A failed or stopped install
# removes the Node it downloaded; `whosup update` replaces an older one of its own; `whosup uninstall` removes it.
#
# What it prints goes to standard output: progress lines, then a summary (which path, the board's address, what to do next,
# and, when the board was set to start at login, that fact and how to turn it off). What another program prints while this
# installer runs it for you (herdr's installer, `herdr plugin install`, an app's installer) is kept out of the way: when it
# succeeds one line says so, when it fails everything it printed is shown. What to do next is said once, in the summary:
# first-run setup, which herdr runs during `herdr plugin install`, is told that this installer called it (WHOSUP_FROM_INSTALLER=1)
# and leaves its own closing lines out. A command the summary tells you to type is spelled so that it runs as typed: when the
# folder herdr is in is not on your PATH (the PATH this installer was started with: WHOSUP_USER_PATH, otherwise PATH), the
# command is written with its full path, and one line says how to add the folder for terminals opened from then on.
# Run by an agent or a script, with no
# terminal, the summary is still in the output. First-run setup's questions are asked on the terminal itself (/dev/tty) by
# scripts/setup.mjs, only when there is one; every command run here reads /dev/null, so `curl | sh` loses none of this script.
#
# Environment:
#   WHOSUP_INSTALL_MODE=plugin|standalone   take that path whatever is on this machine
#   WHOSUP_ENV=herdr-app|ovis-app|herdr     with nothing to run sessions in on this machine: install that one, without asking
#                                           (not used when something is here already, or when WHOSUP_INSTALL_MODE is given)
#   WHOSUP_REF=<git ref>                    install that branch, tag or commit instead of the release tag (RELEASE_REF)
#   WHOSUP_NO_SETUP=1                       ask nothing
#   WHOSUP_INSTALL_NODE=1|0                 no Node 22.13+ here: 1 = download whosup's own Node without asking (also with no
#                                           terminal), 0 = never (not asked, not downloaded — the old behavior)
#   WHOSUP_NO_AUTOSTART=1                   do not start the board right after the install
#   WHOSUP_NO_LOGIN_START=1                 standalone: do not set the board to start at login
#   CI                                      none of the three
#   WHOSUP_LANG=ko|en                       language of what is printed (otherwise Korean for a Korean locale)
#   WHOSUP_UI=plain|rich                    how it is printed. plain: lines as they always were ("whosup: …", numbered questions).
#                                           rich: a header, arrow-key questions that fold into one "✓ …" line, ✓/…/✗ progress
#                                           lines and explanations wrapped to the terminal's width, a summary that starts with what
#                                           to do next. Not given: rich only for a person at a terminal (stdout and /dev/tty are
#                                           terminals, TERM is set and not dumb, no CI, no WHOSUP_NO_SETUP). NO_COLOR: rich without
#                                           colors. Passed on to what this runs, with the width it measured (WHOSUP_UI_COLS).
# For tests and the scenario rig (nothing here reaches the network or the real launchd/systemd when these are set):
#   WHOSUP_INSTALL_SOURCE=<folder>          a local checkout instead of a download: handed to `herdr plugin install` on the
#                                           plugin path, copied on the standalone path
#                                           (on the plugin path it must be in the shape herdr takes, OWNER/REPO[/SUBDIR]: a real herdr does not take a folder)
#   WHOSUP_HERDR_INSTALL_CMD=<command>      run instead of herdr's own installer
#   WHOSUP_HERDR_APP_INSTALL_CMD=<command>  run instead of the Herdr app's own installer (sh -c, no input)
#   WHOSUP_OVIS_APP_INSTALL_CMD=<command>   run instead of getting the Ovis app from its release files (sh -c, no input)
#   WHOSUP_ENV_TIMEOUT=<seconds>            how long an app's installer (and each of its downloads), or herdr's installer, may take before it is stopped
#                                           (a positive whole number; anything else means 900)
#   WHOSUP_USER_PATH=<PATH>                 the PATH of the shell this was started from, when the caller changed PATH before running this
#                                           (scripts/standalone.sh does): commands in the summary are spelled against it
#   WHOSUP_SYSTEM_APPS=<folder>             macOS: looked at instead of /Applications for an app that is already installed
#                                           (~/Applications is always looked at)
#   WHOSUP_OVIS_RELEASES_URL=<address>      the Ovis app's release files are read from there instead of GitHub
#                                           (the Herdr app's installer reads HERDR_RELEASES_URL the same way)
#   WHOSUP_HERDR_TIMEOUT=<seconds>          how long `herdr --version` and `herdr plugin list` may take before they are stopped
#                                           (a positive whole number; anything else means 10)
#   WHOSUP_LAUNCHCTL, WHOSUP_SYSTEMCTL      run instead of launchctl, systemctl
#   WHOSUP_NODE_DIST_URL=<address>          whosup's own Node is read from there instead of https://nodejs.org/dist
#                                           (<address>/<version>/node-<version>-<os>-<arch>.tar.gz and SHASUMS256.txt)
#   WHOSUP_EXTRA_PATH=<folders>             searched after PATH for node and herdr instead of the usual install places
#                                           (empty: PATH only) — scripts/node-path.sh reads it the same way
set -u

REPO="fivetaku/whosup"
PLUGIN_ID="fivetaku.whosup"
INSTALL_URL="https://raw.githubusercontent.com/fivetaku/whosup/main/install.sh"
# 받을 출시판(태그). WHOSUP_REF가 없으면 이것을 받는다 — main 브랜치의 그때그때 상태가 아니다. package.json의 판과 같아야 한다(시험이 본다).
# 이 판의 태그가 GitHub에 올라간 뒤에 이 파일을 main에 올린다(태그가 없으면 한 줄 설치가 받을 것이 없다).
RELEASE_REF="v0.2.0"
HERDR_MIN="0.9.0"
HERDR_DOCS="https://herdr.dev/docs/install/"
# herdr's own installer: no sudo, one file into ${HERDR_INSTALL_DIR:-~/.local/bin}
HERDR_INSTALL_CMD_DEFAULT="curl -fsSL --proto '=https' --proto-redir '=https' https://herdr.dev/install.sh | sh"
# 아무것도 없는 기계에서 깔아 주는 앱 둘(환경 고르기 — 아래 "환경 고르기"). 주소는 그 앱의 공식 배포처다.
#   Herdr 앱: 공식 한 줄 설치기 <HERDR_RELEASES>/app/install.sh(관리자 권한 없음, 묻지 않음). 코어는 <HERDR_RELEASES>/core/install.sh.
#   Ovis 앱: GitHub 릴리스의 파일(맥 zip · 리눅스 AppImage)과 그 릴리스의 체크섬 파일(latest-*.yml의 sha512). 맥은 서명한 개발자(팀 ID)까지 본다.
HERDR_RELEASES="https://releases.herdr.dev"
HERDR_APP_DOCS="https://github.com/herdrdev/herdr-app"
OVIS_RELEASES="https://github.com/devswha/ovis/releases"
OVIS_DOCS="https://ovis.sh"
OVIS_TEAM_ID="5987KT43TJ"
# 설치기가 만든 폴더(app · app.new · app.old)에 두는 표식 파일과 그 첫 줄(src/standalone.mjs의 APP_MARK_FILE·APP_MARK와 같아야 한다).
MARK_FILE=".whosup-install"
MARK_TEXT="whosup: put here by install.sh"

# ── 화면 문구: 영어와 한국어. 언어는 WHOSUP_LANG(ko|en) > 로캘(LC_ALL > LC_MESSAGES > LANG)이 ko로 시작 > 영어 (src/setup.mjs pickLang과 같다) ──
lang=en
pick_lang() {
  case "$(printf '%s' "${WHOSUP_LANG:-}" | tr 'A-Z' 'a-z')" in
    ko) lang=ko; return 0 ;;
    en) lang=en; return 0 ;;
  esac
  locale="${LC_ALL:-}"
  [ -n "$locale" ] || locale="${LC_MESSAGES:-}"
  [ -n "$locale" ] || locale="${LANG:-}"
  case "$(printf '%s' "$locale" | tr 'A-Z' 'a-z')" in ko*) lang=ko ;; *) lang=en ;; esac
}
# pick "<english>" "<한국어>": 고른 언어의 글자
pick() { if [ "$lang" = ko ]; then printf '%s' "$2"; else printf '%s' "$1"; fi; }
# 진행 줄(앞에 whosup: 이 붙는다)과 요약 줄(붙지 않는다). rich 화면(아래 "화면 모드")에서는 whosup: 없이 폭에 맞춰 내어쓰기로 나눈 문단이다.
say() { if [ "$ui" = rich ]; then ui_print para "$(pick "$1" "$2")"; else printf 'whosup: %s\n' "$(pick "$1" "$2")"; fi; }
line() { printf '%s\n' "$(pick "$1" "$2")"; }
fail() {
  if [ "$ui" = rich ]; then ui_print fail "$(pick "$(fail_en "$1")" "$(fail_ko "$2")")" >&2
  else printf 'whosup: %s\n' "$(pick "$(fail_en "$1")" "$(fail_ko "$2")")" >&2
  fi
  left_note; exit 1
}

# ── 화면 모드: plain(지금까지의 출력 그대로 — 글자 하나 다르지 않다) · rich(사람이 터미널 앞에 있을 때: 머리말, 화살표 메뉴, ✓/…/✗ 진행 줄,
# 폭에 맞춘 내어쓰기 줄바꿈, "다음에 할 일"부터 쓰는 요약). src/tui.mjs uiMode와 같은 판정이다:
#   WHOSUP_UI=plain → plain · WHOSUP_UI=rich → rich(시험용) · 값이 없으면 표준 출력이 터미널이고 /dev/tty를 열 수 있고 TERM이 비어 있지 않고
#   dumb가 아니며 CI · WHOSUP_NO_SETUP이 꺼져 있을 때만 rich. NO_COLOR면 배치는 그대로 두고 색만 뺀다. 로캘이 UTF-8이 아니면 기호를 ASCII로.
# 폭: /dev/tty의 열 수 > COLUMNS > stty size > 80, 40~100으로 자른다. 정한 모드와 폭은 자식에게 WHOSUP_UI · WHOSUP_UI_COLS로 넘긴다
# (COLUMNS는 export하지 않는다 — 다른 프로그램의 출력 폭까지 바뀐다).
ui=plain; ui_pending=0; ui_saved=""; ui_buf=""; ui_cols=80
c_b=""; c_d=""; c_g=""; c_r=""; c_0=""
ui_s_ok="ok"; ui_s_run=".."; ui_s_x="x"; ui_s_dot="-"
ui_tab="$(printf '\t')"
ui_init() {
  case "$(printf '%s' "${WHOSUP_UI:-}" | tr 'A-Z' 'a-z')" in
    plain) ui=plain ;;
    rich) ui=rich ;;
    *)
      ui=plain
      if [ -t 1 ] && { : >/dev/tty; } 2>/dev/null && [ -n "${TERM:-}" ] && [ "${TERM:-}" != dumb ] && ! on "${CI:-}" && ! on "${WHOSUP_NO_SETUP:-}"; then ui=rich; fi ;;
  esac
  ui_size="$( { stty size </dev/tty; } 2>/dev/null)" || ui_size=""
  ui_cols="${ui_size#* }"
  case "$ui_cols" in '' | *[!0-9]* | 0) ui_cols="${COLUMNS:-}" ;; esac
  case "$ui_cols" in
    '' | *[!0-9]* | 0) ui_size="$(stty size 2>/dev/null)" || ui_size=""; ui_cols="${ui_size#* }" ;;
  esac
  case "$ui_cols" in '' | *[!0-9]* | 0) ui_cols=80 ;; ????*) ui_cols=100 ;; esac
  [ "$ui_cols" -ge 40 ] || ui_cols=40
  [ "$ui_cols" -le 100 ] || ui_cols=100
  WHOSUP_UI="$ui"; WHOSUP_UI_COLS="$ui_cols"; export WHOSUP_UI WHOSUP_UI_COLS
  [ "$ui" = rich ] || return 0
  case "${LC_ALL:-${LC_CTYPE:-${LANG:-}}}" in
    *[Uu][Tt][Ff]-8* | *[Uu][Tt][Ff]8*) ui_s_ok="✓"; ui_s_run="…"; ui_s_x="✗"; ui_s_dot="·" ;;
  esac
  if [ -z "${NO_COLOR:-}" ]; then
    c_b="$(printf '\033[1m')"; c_d="$(printf '\033[2m')"; c_g="$(printf '\033[32m')"; c_r="$(printf '\033[1;31m')"; c_0="$(printf '\033[0m')"
  fi
  printf '\n  %s%s%s  %s  %s\n\n' "$c_b" "$(pick "whosup install" "whosup 설치")" "$c_0" "$ui_s_dot" "$(pick "agent session board" "에이전트 세션 보드")"
}
# 집 폴더 안의 경로는 ~로 줄여 보여 준다(보여 주는 글자에만 — 칠 명령에는 쓰지 않는다. src/tui.mjs tildePath와 같다)
ui_path() { case "$1" in "$HOME") printf '~' ;; "$HOME"/*) printf '~/%s' "${1#"$HOME"/}" ;; *) printf '%s' "$1" ;; esac; }
# 진행 줄(rich에서만): ui_step ok|run|warn "<english>" "<한국어>". run은 줄을 끝내지 않는다 — 그사이 아무것도 찍히지 않았으면 다음 ok 줄이
# 그 자리를(\r + 줄 지우기) 차지하고, 무엇이 찍히면 그 앞에서 줄을 끝낸다(ui_break). 다른 프로그램이 그사이 터미널에 찍을 수 있는 단계(첫 실행 안내)는
# 그 프로그램이 처음 찍기 전에 줄을 끝내고 표식 파일을 남긴다(WHOSUP_UI_OPEN — install_plugin). 위로 올라가 덮어쓰는 커서 이동은 쓰지 않는다.
# 흐리게(dim)는 쓰지 않는다: 키 안내 줄과 마지막 각주에만 쓴다(밝은 배경에서 흐린 글자는 읽기 어렵다).
ui_step() {
  [ "$ui" = rich ] || return 0
  ui_t="$(pick "$2" "$3")"
  case "$1" in
    run) ui_break; printf '  %s %s' "$ui_s_run" "$ui_t"; ui_pending=1 ;;
    ok) if [ "$ui_pending" = 1 ]; then printf '\r\033[K'; ui_pending=0; fi; printf '  %s%s%s %s\n' "$c_g" "$ui_s_ok" "$c_0" "$ui_t" ;;
    warn) ui_break; printf '  %s!%s %s\n' "$c_b" "$c_0" "$ui_t" ;;
  esac
}
# node 도우미(…_JS)를 짧은 명령 줄로 돌린다: 코드는 그 명령 하나에만 붙는 환경변수 WHOSUP_JS로 넘기고 명령 줄에는 eval 한 줄과 인자만
# 둔다. 터미널 앱(Terminal.app)은 앞에서 도는 명령 줄을 창 제목에 보여 주는데, node -e "<코드>"로 돌리면 코드 전체가 제목에 나왔다(맥북에어
# r4). process.title로 이름을 바꾸면 제목이 환경변수까지 이어 보여 쓰지 않는다(r5). 같은 까닭으로 빈 인자는 \001로 바꿔 넘기고 node 쪽에서
# 빈 문자열로 되돌린다(빈 인자가 있으면 터미널이 인자 수만큼 읽다가 환경변수 하나를 끌어온다). 코드 앞머리(NODE_JS_PRE)는 WHOSUP_JS를
# 지워 이 도우미가 띄우는 프로세스(설치기·herdr·보드)에 물려주지 않는다.
NODE_JS_PRE='delete process.env.WHOSUP_JS; process.argv = process.argv.map((a) => (a === "\u0001" ? "" : a));
'
node_js_nul="$(printf '\001')"
node_js() {
  _node_js="$1"; shift; _node_js_n=$#
  while [ "$_node_js_n" -gt 0 ]; do
    _node_js_a="$1"; shift; [ -n "$_node_js_a" ] || _node_js_a="$node_js_nul"; set -- "$@" "$_node_js_a"; _node_js_n=$((_node_js_n - 1))
  done
  WHOSUP_JS="$NODE_JS_PRE$_node_js" node -e 'eval(process.env.WHOSUP_JS)' "$@"
}
ui_break() { if [ "$ui_pending" = 1 ]; then printf '\n'; ui_pending=0; fi; }
# 블록 출력(src/tui.mjs renderBlocks): ui_add <종류> <글> [<값>] 로 모았다가 ui_flush가 node로 한 번에 그린다(폭 · 색 · 기호 · 내어쓰기).
# node를 쓸 수 없으면(아직 없거나 낡았다) 줄마다 두 칸 들여 그대로 찍는다. ui_print = 블록 하나를 바로 찍는다.
ui_add() { ui_buf="$ui_buf$1$ui_tab${2:-}$ui_tab${3:-}
"; }
ui_flush() {
  ui_break
  if ! printf '%s' "$ui_buf" | node_js "$UI_JS" print 2>/dev/null; then
    printf '%s' "$ui_buf" | while IFS="$ui_tab" read -r ui_k ui_a ui_v; do
      case "$ui_k" in
        blank) printf '\n' ;;
        fail) printf '  %s%s%s %s\n' "$c_r" "$ui_s_x" "$c_0" "$ui_a" ;;
        ok | done) printf '  %s%s%s %s\n' "$c_g" "$ui_s_ok" "$c_0" "$ui_a" ;;
        warn) printf '  %s!%s %s\n' "$c_b" "$c_0" "$ui_a" ;;
        *) printf '  %s\n' "$ui_a${ui_v:+ $ui_v}" ;;
      esac
    done
  fi
  ui_buf=""
}
ui_print() { ui_buf=""; ui_add "$@"; ui_flush; }
# 메뉴가 바꾼 터미널 설정(stty)을 되돌리고 커서를 다시 보인다. 메뉴가 어떻게 끝나든, 그리고 모든 EXIT/INT/TERM/HUP 갈무리에서 부른다(저장한 값이 없으면 아무것도 하지 않는다).
ui_restore() {
  [ -n "$ui_saved" ] || return 0
  { stty "$ui_saved" </dev/tty; printf '\033[?25h' >/dev/tty; } 2>/dev/null
  ui_saved=""
}
# 실패 문장의 끝 "Nothing was changed." / "바꾼 것은 없습니다.": 이번 실행이 이미 환경(앱 · herdr)을 깔았으면 거짓이다 — 그때는 "whosup은 설치하지
# 않았다"로 바꾼다(깔린 것은 left_note가 바로 뒤에 알린다). 아무것도 깔지 않았으면 문장은 그대로다.
left_any() { case "${env_installed:-}" in herdr-app | ovis-app) return 0 ;; esac; [ "${herdr_installed:-0}" = 1 ]; }
fail_en() { if left_any; then case "$1" in *" Nothing was changed.") printf '%s' "${1% Nothing was changed.} whosup was not installed."; return 0 ;; esac; fi; printf '%s' "$1"; }
fail_ko() { if left_any; then case "$1" in *" 바꾼 것은 없습니다.") printf '%s' "${1% 바꾼 것은 없습니다.} whosup은 설치하지 않았습니다."; return 0 ;; esac; fi; printf '%s' "$1"; }
# 이 실행이 이미 깐 환경(앱 또는 herdr)이 있는데 뒤 단계가 실패했다: "바꾼 것은 없다"가 아니다 — 깔린 것이 남아 있고 그대로 써도, 직접 지워도 된다고
# 한 줄 알린다(표준 오류). env_installed·env_here는 환경 고르기가, herdr_installed는 install_herdr가 채운다(깔리기 전에는 빈 값이라 아무 말도 없다).
left_note() {
  # rich: 보여 주는 경로는 집 폴더 안이면 ~로(plain은 지금까지 그대로 전체 경로)
  ln_env="${env_here:-}"; ln_herdr="${HERDR_DIR:-}"
  if [ "$ui" = rich ]; then ln_env="$(ui_path "$ln_env")"; ln_herdr="$(ui_path "$ln_herdr")"; fi
  case "${env_installed:-}" in
    herdr-app | ovis-app)
      say "$(env_name "$env_installed") that this run installed is still in place ($ln_env). You can use it as it is, or remove it yourself." \
        "이번 실행이 설치한 $(env_name "$env_installed")은 그대로 남아 있습니다($ln_env). 그대로 써도 되고, 직접 지워도 됩니다." >&2 ;;
  esac
  if [ "${herdr_installed:-0}" = 1 ]; then
    say "herdr ${herdr_version:-} that this run installed is still in place ($ln_herdr). You can use it as it is, or remove it yourself." \
      "이번 실행이 설치한 herdr ${herdr_version:-}는 그대로 남아 있습니다($ln_herdr). 그대로 써도 되고, 직접 지워도 됩니다." >&2
  fi
}
# 스위치 판정(src/setup.mjs envOn과 같다): 없음·빈 값·0·false·no·off는 꺼짐, 그 밖은 켜짐
on() {
  case "$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | tr -d ' ')" in
    '' | 0 | false | no | off) return 1 ;;
    *) return 0 ;;
  esac
}
# 화면에 찍는 붙여넣기용 명령에 경로·값을 넣을 때 쓴다.
# quote <글자>: sh의 한 낱말로 싼다(작은따옴표, 안의 작은따옴표는 '\'' 로). shown <글자>: 흔한 글자뿐이면 그대로, 아니면 quote
# (src/standalone.mjs의 shq·shown과 같다). dq <글자>: 큰따옴표 안에 넣을 수 있게 \ " $ ` 를 막는다.
quote() { printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"; }
shown() { case "$1" in '' | *[!A-Za-z0-9_@%+=:,./-]*) quote "$1" ;; *) printf '%s' "$1" ;; esac; }
dq() { printf '%s' "$1" | sed 's/[\\"$`]/\\&/g'; }
# abs_dir <값>: XDG 폴더 값은 절대 경로일 때만 쓴다(XDG 명세: 상대 경로는 무시한다 — XDG_DATA_HOME=. 이면 지금 폴더에 깔린다).
# 제어 문자가 든 값도 무시한다. 그때는 아무것도 찍지 않는다(부른 쪽이 기본값을 쓴다). src/paths.mjs xdgDir과 같은 판정이다.
abs_dir() {
  case "${1:-}" in /*) ;; *) return 0 ;; esac
  [ "$(printf '%s' "$1" | LC_ALL=C tr -d '\000-\037\177')" = "$1" ] || return 0
  printf '%s' "$1"
}
# at_least 0.9.0 0.9.5: 둘째 판 번호가 첫째와 같거나 높은가. 앞에 붙은 글자(v1.0.0의 v)는 떼고 본다.
at_least() {
  awk -v want="$1" -v have="$2" 'BEGIN { sub(/^[^0-9]*/, "", want); sub(/^[^0-9]*/, "", have); split(want, w, "."); split(have, h, ".");
    for (i = 1; i <= 3; i++) { if (h[i] + 0 > w[i] + 0) exit 0; if (h[i] + 0 < w[i] + 0) exit 1 } exit 0 }'
}
# limited <초> <명령> [인자…]: 시간 제한을 두고 돌린다. macOS에는 timeout 명령이 없어 node로 한다(check_node 뒤에만 부른다).
# 그 명령의 표준 출력만 내보낸다(표준 입력은 /dev/null). 제한 안에 끝나지 않으면 끝내고(SIGKILL) 124, 실행하지 못했으면 127, 그 밖에는 그 명령의 종료 코드.
LIMITED_JS='
const cp = require("child_process");
const [limit, cmd, ...args] = process.argv.slice(1);
const r = cp.spawnSync(cmd, args, { timeout: Math.max(1, Number(limit) || 10) * 1000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] });
if (r.stdout && r.stdout.length) process.stdout.write(r.stdout);
process.exitCode = r.error ? (r.error.code === "ETIMEDOUT" ? 124 : 127) : (r.status === null ? 1 : r.status);
'
limited() { node_js "$LIMITED_JS" "$@" </dev/null 2>/dev/null; }

# ── node·herdr를 찾을 곳: scripts/node-path.sh와 같은 방식(이 파일은 그 스크립트가 기계에 놓이기 전에 돈다 — 둘을 같게 둔다) ──
# PATH와 덧붙인 폴더, nvm(판 번호가 높은 것부터)·fnm 기본 위치의 node를 차례로 시험해 22.13 이상인 첫 번째를 고른다(NODE — 절대 경로).
# 앞쪽에 낡은 node가 있어도 뒤의 맞는 node를 쓴다. 고른 node가 PATH에서 먼저 나오지 않으면 그 폴더를 PATH 앞에 둔다(아래의 node 호출과
# 설치한 스크립트들이 같은 node를 쓴다).
# >>> node pick: the same lines in install.sh and scripts/node-path.sh
# 22.13 or newer = node:sqlite without flags
whosup_node_ok() { [ -f "$1" ] && [ -x "$1" ] && "$1" --input-type=module -e "import 'node:sqlite'" </dev/null >/dev/null 2>&1; }
# whosup_pick_node <folders, colon-separated>: only absolute folders are looked at
whosup_pick_node() {
  WHOSUP_NODE_PICK=""; WHOSUP_NODE_SEEN=""
  set -f; IFS=:
  for whosup_dir in $1; do
    case "$whosup_dir" in /*) ;; *) continue ;; esac
    if [ ! -f "$whosup_dir/node" ] || [ ! -x "$whosup_dir/node" ]; then continue; fi
    [ -n "$WHOSUP_NODE_SEEN" ] || WHOSUP_NODE_SEEN="$whosup_dir/node"
    if whosup_node_ok "$whosup_dir/node"; then WHOSUP_NODE_PICK="$whosup_dir/node"; break; fi
  done
  unset IFS; set +f
  [ -n "$WHOSUP_NODE_PICK" ]
}
# whosup_node_dirs: PATH, then (unless WHOSUP_EXTRA_PATH is given) nvm versions by version number, newest first, and the fnm default,
# then, always last, whosup's own node (<XDG_DATA_HOME or ~/.local/share>/whosup/node — install.sh puts it there only when no node
# of yours was good enough): a node of your own always comes first
whosup_node_dirs() {
  whosup_dirs="${PATH:-}"
  if [ -z "${WHOSUP_EXTRA_PATH+set}" ]; then
    if [ -d "$HOME/.nvm/versions/node" ]; then
      for whosup_v in $(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9.]*\)$/\1/p' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
        whosup_dirs="$whosup_dirs:$HOME/.nvm/versions/node/v$whosup_v/bin"
      done
    fi
    for whosup_fnm in "${FNM_DIR:-}" "${XDG_DATA_HOME:-$HOME/.local/share}/fnm" "$HOME/Library/Application Support/fnm" "$HOME/.fnm"; do
      if [ -n "$whosup_fnm" ] && [ -x "$whosup_fnm/aliases/default/bin/node" ]; then whosup_dirs="$whosup_dirs:$whosup_fnm/aliases/default/bin"; fi
    done
  fi
  case "${XDG_DATA_HOME:-}" in /*) whosup_own="$XDG_DATA_HOME" ;; *) whosup_own="$HOME/.local/share" ;; esac
  whosup_dirs="$whosup_dirs:$whosup_own/whosup/node/bin"
}
# <<< node pick
search_path() {
  append="${WHOSUP_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin${NVM_BIN:+:$NVM_BIN}:$HOME/.nvm/current/bin}"
  [ -z "$append" ] || PATH="$PATH:$append"
  whosup_node_dirs
  NODE=""
  if whosup_pick_node "$whosup_dirs"; then
    NODE="$WHOSUP_NODE_PICK"
    [ "$(command -v node 2>/dev/null || true)" = "$NODE" ] || PATH="${NODE%/node}:$PATH"
  fi
  export PATH
}

# ── whosup 전용 Node: 쓸 만한 node(22.13 이상)가 하나도 없을 때만 ──
# 시스템 Node(brew·nvm·직접 깐 것)는 건드리지 않는다. 데이터 폴더 아래(<데이터 폴더>/node — 단독 설치의 app 옆)에 nodejs.org의 공식 배포 파일을
# 풀어 whosup만 쓴다. 고른 node가 그것이면 설치 기록·실행 명령·로그인 항목에 그 경로가 적힌다(WHOSUP_NODE — 다른 node와 같다).
# 찾는 순서에서는 맨 뒤다(node pick — whosup_node_dirs): 나중에 쓸 만한 node를 깔면 다음 설치·새 버전부터 그것을 쓴다.
#   묻기: 터미널이 있으면 한 번 묻는다(Enter = 예). 터미널이 없으면(에이전트·스크립트·CI) WHOSUP_INSTALL_NODE가 켜져 있을 때만 받는다.
#         WHOSUP_INSTALL_NODE가 꺼져 있으면(0·false·no·off·빈 값) 묻지도 받지도 않는다 — 지금까지처럼 무엇을 하면 되는지만 알린다.
#   받기: 고정한 판(NODE_PIN)의 .tar.gz와 같은 폴더의 SHASUMS256.txt를 받아 sha256을 맞춰 본다. 맞지 않거나 받지 못하거나 풀어 돌려 보지 못하면
#         설치 전체를 멈추고 받던 것을 남기지 않는다. 받는 곳은 데이터 폴더 안의 이 실행만 쓰는 폴더(.node-new.<PID>)이고, 다 확인한 뒤에야 제자리에 놓는다.
#   되돌리기: 이 실행이 놓은 전용 Node는 설치가 끝나지 못하면(실패·Ctrl-C) 치운다 — 이 실행 전에 있던 전용 Node(낮은 판을 바꾸던 중)는 되돌려 놓는다.
#         끄지 못한 보드·치우지 못한 앱 폴더가 남는 실패(fresh_left · back_hint)는 그 프로그램이 이 node로 돌 수 있어 치우지 않는다(node_keep).
#   새 버전: 고른 node가 전용 Node이고 고정한 판보다 낮으면 묻지 않고 바꾼다(처음에 받기로 한 것이다). WHOSUP_INSTALL_NODE가 꺼져 있으면 바꾸지 않는다.
#   제거: `whosup uninstall`이 프로그램 쪽으로 지운다(--purge와 상관없이 — src/standalone.mjs removeInstall). 표식 파일(NODE_MARK_FILE)이 든 폴더만.
# NODE_PIN: Node 24 LTS(Krypton)의 최신 보안 판(2026-11-10, nodejs.org/dist/index.json). 올릴 때는 이 줄만 바꾼다.
# WHOSUP_NODE_DIST_URL: 시험이 nodejs.org/dist 대신 쓰는 주소(127.0.0.1의 http만 함께 연다 — curl_proto).
NODE_PIN="v24.22.3"
NODE_DIST="https://nodejs.org/dist"
# 전용 Node 폴더의 표식(src/standalone.mjs의 NODE_MARK_FILE·NODE_MARK와 같아야 한다 — 시험이 대조한다). 둘째 줄 = version=<판>
NODE_MARK_FILE=".whosup-node"
NODE_MARK_TEXT="whosup: node put here by install.sh"
node_pending=0; node_fetched=0; node_keep=0; node_rc=0; node_stage=""; node_stage_want=""; node_prev=""; node_home=""; node_plat=""; node_why_en=""; node_why_ko=""
node_ours() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$NODE_MARK_FILE" ] && [ ! -L "$1/$NODE_MARK_FILE" ] && [ "$(sed -n 1p "$1/$NODE_MARK_FILE" 2>/dev/null)" = "$NODE_MARK_TEXT" ]
}
node_ours_version() { sed -n 's/^version=//p' "$1/$NODE_MARK_FILE" 2>/dev/null | sed -n 1p; }
# 전용 Node를 묻지도 받지도 않는가(WHOSUP_INSTALL_NODE가 있는데 꺼져 있다 — 빈 값 포함)
node_switch_off() { [ -n "${WHOSUP_INSTALL_NODE+set}" ] && ! on "$WHOSUP_INSTALL_NODE"; }
# sha256(소문자 16진수 64자). 도구: sha256sum(Linux · 최근 macOS) > shasum -a 256(macOS) > openssl.
node_sum() {
  if command -v sha256sum >/dev/null 2>&1; then node_sum_out="$(sha256sum "$1" </dev/null 2>/dev/null)" || return 1
  elif command -v shasum >/dev/null 2>&1; then node_sum_out="$(shasum -a 256 "$1" </dev/null 2>/dev/null)" || return 1
  elif command -v openssl >/dev/null 2>&1; then node_sum_out="$(openssl dgst -sha256 -r "$1" </dev/null 2>/dev/null)" || return 1
  else return 1
  fi
  printf '%s' "${node_sum_out%% *}" | tr 'A-F' 'a-f'
}
# 이 기계에 맞는 배포 파일이 있는가(node_plat = darwin-arm64 · darwin-x64 · linux-x64 · linux-arm64). 없으면 1과 이유(node_why_*).
# Linux의 musl(Alpine 등)은 공식 배포 파일이 glibc용이라 돌지 않는다: 받지 않는다.
node_platform() {
  node_plat=""; node_why_en=""; node_why_ko=""
  case "$(uname -s)" in Darwin) node_os=darwin ;; Linux) node_os=linux ;; *) return 1 ;; esac
  case "$(uname -m)" in
    arm64 | aarch64) node_arch=arm64 ;;
    x86_64 | amd64) node_arch=x64 ;;
    *) node_why_en="nodejs.org has no build for this processor ($(uname -m))"; node_why_ko="이 프로세서($(uname -m))용 공식 Node가 없습니다"; return 1 ;;
  esac
  if [ "$node_os" = linux ] && ls /lib/ld-musl-* >/dev/null 2>&1; then
    node_why_en="this Linux uses musl, and nodejs.org's builds need glibc"; node_why_ko="이 Linux는 musl을 써서 nodejs.org의 공식 Node가 돌지 않습니다"; return 1
  fi
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then
    node_why_en="downloading it needs curl and tar"; node_why_ko="내려받으려면 curl과 tar가 필요합니다"; return 1
  fi
  if ! node_sum /dev/null >/dev/null; then
    node_why_en="checking the download needs sha256sum, shasum or openssl"; node_why_ko="받은 파일을 확인하려면 sha256sum, shasum, openssl 중 하나가 필요합니다"; return 1
  fi
  node_plat="$node_os-$node_arch"
}
# 이 설치기가 끝날 때(EXIT 갈무리 — node_traps · env_begin · ask_env_rich · take_lock이 모두 부른다). node_rc = 끝나는 종료 코드.
# 받던 폴더는 늘 치운다. 이 실행이 놓은 전용 Node는 0으로 끝났거나 남겨야 할 때(node_keep)만 두고, 아니면 치운 뒤 전에 있던 것을 되돌린다.
node_settle() {
  [ "$node_pending" = 1 ] || return 0
  node_pending=0
  if [ -n "$node_stage" ]; then rm -rf "$node_stage" 2>/dev/null; node_stage=""; fi
  if [ "$node_fetched" = 1 ]; then
    if [ "$node_rc" = 0 ] || [ "$node_keep" = 1 ]; then
      [ -z "$node_prev" ] || rm -rf "$node_prev" 2>/dev/null
    else
      if node_ours "$node_home"; then rm -rf "$node_home" 2>/dev/null; fi
      if [ -n "$node_prev" ] && [ -d "$node_prev" ] && [ ! -e "$node_home" ]; then mv "$node_prev" "$node_home" 2>/dev/null; fi
    fi
  elif [ -n "$node_prev" ] && [ -d "$node_prev" ] && [ ! -e "$node_home" ]; then
    mv "$node_prev" "$node_home" 2>/dev/null   # 옮겨 둔 이전 판을 놓기 전에 멈췄다: 제자리로
  fi
  rmdir "$DATA" 2>/dev/null
  return 0
}
# 전용 Node를 받기 시작한 뒤: 신호(Ctrl-C·kill·터미널 닫힘)와 끝에서 node_settle이 돌게 한다. 받지 않은 실행은 갈무리를 비운다(지금까지와 같다).
# 다른 갈무리를 걷는 곳(ui_menu_end · env_end)도 trap - 대신 이것을 부른다.
node_traps() {
  # 잠금을 쥔 뒤(전용 Node를 바꾸기 직전 — fetch_node)에도 갈무리가 바뀔 수 있다: 끝날 때 늘 푼다(unlock은 쥐지 않았으면 아무것도 안 한다).
  if [ "$node_pending" = 1 ] || [ "$lock_held" = 1 ]; then
    trap 'node_rc=$?; unlock; node_settle' EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
  else
    trap - EXIT HUP INT TERM
  fi
}
node_fail() {
  ui_break
  fail "could not get whosup's own Node ${NODE_PIN}: $1. Nothing was installed." "whosup 전용 Node ${NODE_PIN}을 받지 못했습니다: $2. 아무것도 설치하지 않았습니다."
}
# 물을 수 있는가(node 없이 본다): 끄는 스위치(CI · WHOSUP_NO_SETUP)가 없고, 제어 터미널을 열 수 있고, 그 앞(foreground)에서 돌고 있다.
node_can_ask() {
  if on "${CI:-}" || on "${WHOSUP_NO_SETUP:-}"; then return 1; fi
  # 서브셸로 감싼다: dash는 특수 내장 명령(:)의 리디렉션이 실패하면 셸 전체를 끝낸다(종료 코드 2)
  ( : </dev/tty ) 2>/dev/null || return 1
  node_pg="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ')"; node_tpg="$(ps -o tpgid= -p $$ 2>/dev/null | tr -d ' ')"
  [ -z "$node_pg" ] || [ -z "$node_tpg" ] || [ "$node_pg" = "$node_tpg" ]
}
# 한 번 묻는다. Enter·y·yes·예·네 = 받는다, n·no·아니요·아니오 = 받지 않는다. 터미널이 닫히면(읽지 못함) 받지 않는다.
node_ask() {
  node_seen_v=""
  [ -z "$WHOSUP_NODE_SEEN" ] || node_seen_v="$("$WHOSUP_NODE_SEEN" -v 2>/dev/null </dev/null || echo unknown)"
  printf '\n' > /dev/tty
  if [ -n "$node_seen_v" ]; then
    tty_line "  whosup needs Node 22.13 or newer; the Node here is $node_seen_v." "  whosup에는 Node 22.13 이상이 필요한데 지금 있는 Node는 $node_seen_v 입니다."
  else
    tty_line "  whosup needs Node 22.13 or newer, and none was found." "  whosup에는 Node 22.13 이상이 필요한데 찾지 못했습니다."
  fi
  printf '  %s' "$(pick "Download whosup's own Node ${NODE_PIN} into $(ui_path "$node_home")? (Your system Node is left as it is.) [Y/n] " "whosup 전용 Node ${NODE_PIN}를 $(ui_path "$node_home") 에 받을까요? (시스템 Node는 그대로) [Y/n] ")" > /dev/tty
  node_answer=""
  IFS= read -r node_answer </dev/tty || { printf '\n' > /dev/tty; return 1; }
  case "$(printf '%s' "$node_answer" | tr -d ' \t\r' | tr 'A-Z' 'a-z')" in
    n | no | 아니요 | 아니오 | 아니 | ㄴ) return 1 ;;
  esac
  return 0
}
# 받아서 확인한 뒤 제자리(<데이터 폴더>/node)에 놓는다. 고른 node(NODE)를 그것으로 바꾼다. 실패하면 설치 전체를 멈춘다(node_fail — 받던 것은 node_settle이 치운다).
fetch_node() {
  if { [ -e "$node_home" ] || [ -L "$node_home" ]; } && ! node_ours "$node_home"; then
    fail "$node_home is there and is not whosup's own Node, so it was left as it is and nothing was downloaded. Move it away and run this installer again. Nothing was installed." \
      "$node_home 폴더가 이미 있는데 whosup 전용 Node가 아니어서 그대로 두고 받지 않았습니다. 다른 곳으로 옮긴 뒤 이 설치 명령을 다시 실행하세요. 아무것도 설치하지 않았습니다."
  fi
  case "${WHOSUP_ENV_TIMEOUT:-}" in '' | *[!0-9]* | 0* | ??????*) node_limit=900 ;; *) node_limit="$WHOSUP_ENV_TIMEOUT" ;; esac
  node_base="${WHOSUP_NODE_DIST_URL:-$NODE_DIST}"; node_base="${node_base%/}"
  node_file="node-${NODE_PIN}-$node_plat.tar.gz"
  curl_proto "$node_base"
  mkdir -p "$DATA" 2>/dev/null || node_fail "could not create $DATA" "$DATA 폴더를 만들지 못했습니다"
  node_pending=1; node_traps
  if ! mkdir "$node_stage_want" 2>/dev/null; then node_fail "could not create $node_stage_want" "$node_stage_want 폴더를 만들지 못했습니다"; fi
  node_stage="$node_stage_want"
  if [ "$ui" = rich ]; then ui_step run "downloading whosup's own Node ${NODE_PIN}" "whosup 전용 Node ${NODE_PIN} 내려받는 중"
  else say "downloading whosup's own Node ${NODE_PIN} ($node_plat) from $node_base" "$node_base 에서 whosup 전용 Node ${NODE_PIN}($node_plat)을 내려받습니다"
  fi
  for node_get in "$node_file" SHASUMS256.txt; do
    if ! curl -fsSL --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" --connect-timeout 30 --max-time "$node_limit" -o "$node_stage/$node_get" "$node_base/${NODE_PIN}/$node_get" </dev/null 2>/dev/null; then
      node_fail "$node_base/${NODE_PIN}/$node_get could not be downloaded. Check the connection" "$node_base/${NODE_PIN}/$node_get 파일을 내려받지 못했습니다. 연결을 확인하세요"
    fi
  done
  node_want="$(awk -v f="$node_file" '$2 == f || $2 == "*" f { print $1; exit }' "$node_stage/SHASUMS256.txt" 2>/dev/null | tr 'A-F' 'a-f')"
  node_have="$(node_sum "$node_stage/$node_file")" || node_have=""
  case "$node_want" in *[!0-9a-f]* | '') node_want="" ;; esac
  if [ "${#node_want}" != 64 ] || [ "$node_have" != "$node_want" ]; then
    node_fail "the download does not match its checksum in SHASUMS256.txt, so it was not used" "받은 파일이 SHASUMS256.txt의 체크섬과 맞지 않아 쓰지 않았습니다"
  fi
  mkdir "$node_stage/node" 2>/dev/null && tar -xzf "$node_stage/$node_file" -C "$node_stage/node" --strip-components 1 </dev/null >/dev/null 2>&1 \
    || node_fail "the download could not be unpacked" "받은 파일을 풀지 못했습니다"
  rm -f "$node_stage/$node_file" "$node_stage/SHASUMS256.txt"
  whosup_node_ok "$node_stage/node/bin/node" || node_fail "the downloaded Node does not run here" "받은 Node가 여기서 돌지 않습니다"
  { printf '%s\nversion=%s\n' "$NODE_MARK_TEXT" "${NODE_PIN}" > "$node_stage/node/$NODE_MARK_FILE"; } 2>/dev/null && node_ours "$node_stage/node" \
    || node_fail "could not mark $node_stage/node" "$node_stage/node 폴더에 표식을 두지 못했습니다"
  # 놓기 전에 설치 잠금을 잡는다: 다른 설치기가 일하는 동안(그 설치기와 그 판의 보드가 이 node로 돈다) 바꿔 끼우지 않는다.
  # 묵은 잠금인지 보는 데 node가 필요하다 — 방금 받아 확인한 것을 잠깐 쓴다. 잠금이 잡혀 있으면 fail(받던 폴더는 node_settle이 치운다).
  node_path_was=$PATH; PATH="$node_stage/node/bin:$PATH"; take_lock; PATH=$node_path_was
  # 제자리에 놓는다: 전에 있던 전용 Node(낮은 판)는 끝날 때까지 옆(.node-new.<PID>.old — 받던 폴더 밖)에 둔다. 설치가 끝나지 못하면 node_settle이 되돌린다.
  if [ -e "$node_home" ] || [ -L "$node_home" ]; then
    node_ours "$node_home" || node_fail "$node_home changed while Node was being downloaded" "Node를 받는 사이에 $node_home 폴더가 달라졌습니다"
    node_prev="$node_stage_want.old"
    mv "$node_home" "$node_prev" 2>/dev/null || { node_prev=""; node_fail "could not move the older Node in $node_home aside" "$node_home 의 이전 Node를 옮기지 못했습니다"; }
  fi
  mv "$node_stage/node" "$node_home" 2>/dev/null || node_fail "could not put it into $node_home" "$node_home 에 놓지 못했습니다"
  node_fetched=1
  rm -rf "$node_stage" 2>/dev/null; node_stage=""
  NODE="$node_home/bin/node"; WHOSUP_NODE_SEEN="$NODE"
  [ "$(command -v node 2>/dev/null || true)" = "$NODE" ] || PATH="$node_home/bin:$PATH"
  export PATH
  if [ "$ui" = rich ]; then ui_step ok "whosup's own Node ${NODE_PIN} ($(ui_path "$node_home"))" "whosup 전용 Node ${NODE_PIN} ($(ui_path "$node_home"))"
  else say "whosup's own Node ${NODE_PIN} is in $node_home (your system Node was not changed)" "whosup 전용 Node ${NODE_PIN}을 $node_home 에 놓았습니다(시스템 Node는 그대로입니다)"
  fi
}
# 쓸 만한 node가 없을 때: 물어서(또는 WHOSUP_INSTALL_NODE가 켜져 있으면 묻지 않고) 전용 Node를 받는다. 받지 않으면 그냥 돌아간다(check_node가 알린다).
own_node_offer() {
  node_home="$DATA/node"; node_stage_want="$DATA/.node-new.$$"
  node_switch_off && return 0
  if ! node_platform; then
    if on "${WHOSUP_INSTALL_NODE:-}" && [ -n "$node_why_en" ]; then say "whosup's own Node cannot be downloaded here: $node_why_en" "whosup 전용 Node를 여기서는 받을 수 없습니다: $node_why_ko" >&2; fi
    return 0
  fi
  if on "${WHOSUP_INSTALL_NODE:-}"; then :
  elif node_can_ask; then
    node_ask || return 0
  else
    # 묻지 못한다(에이전트·스크립트): 받지 않고 지금까지의 안내(한 줄) 그대로 끝낸다. 받게 하는 스위치는 README·이 파일 머리말에 있다.
    return 0
  fi
  fetch_node
}
# 고른 node가 전용 Node이고 고정한 판보다 낮다(이전 설치기가 받은 것): 묻지 않고 바꾼다. 스위치가 꺼져 있거나 이 기계용 파일이 없으면 그대로 쓴다.
own_node_refresh() {
  node_home="$DATA/node"; node_stage_want="$DATA/.node-new.$$"
  [ "$NODE" = "$node_home/bin/node" ] && node_ours "$node_home" || return 0
  node_old_v="$(node_ours_version "$node_home")"
  if [ -n "$node_old_v" ] && at_least "${NODE_PIN}" "$node_old_v"; then return 0; fi
  node_switch_off && return 0
  node_platform || return 0
  say "whosup's own Node ${node_old_v:-(unknown version)} is older than ${NODE_PIN}: replacing it" "whosup 전용 Node(${node_old_v:-판 알 수 없음})가 ${NODE_PIN} 보다 낮아 새 버전으로 바꿉니다"
  fetch_node
}

# Node 22.13 이상(node:sqlite를 플래그 없이 쓸 수 있는가 — scripts/preflight.sh와 같은 검사). 없거나 낮으면 전용 Node를 권하고(own_node_offer),
# 그래도 없으면 한 줄 알리고 1로 끝낸다.
# 고른 node는 WHOSUP_NODE로 넘긴다: 설치한 판(scripts/standalone.sh)이 그것으로 돌고, 설치 기록·실행 명령·로그인 항목에 그 경로를 적는다.
check_node() {
  if [ -z "$NODE" ]; then own_node_offer; else own_node_refresh; fi
  if [ -z "$NODE" ] && [ -z "$WHOSUP_NODE_SEEN" ]; then
    fail "needs Node 22.13 or newer, and node is not on the PATH. Install it from https://nodejs.org (or with: brew install node), then run this installer again. Nothing was installed." \
      "Node 22.13 이상이 필요한데 PATH에 node가 없습니다. https://nodejs.org 에서 설치한 뒤(또는 brew install node) 이 설치 명령을 다시 실행하세요. 아무것도 설치하지 않았습니다."
  fi
  if [ -z "$NODE" ]; then
    node_version="$("$WHOSUP_NODE_SEEN" -v 2>/dev/null </dev/null || echo unknown)"
    fail "needs Node 22.13 or newer; this is $node_version. Update Node (https://nodejs.org, or: brew upgrade node), then run this installer again. Nothing was installed." \
      "Node 22.13 이상이 필요한데 지금은 $node_version 입니다. Node를 올린 뒤(https://nodejs.org 또는 brew upgrade node) 이 설치 명령을 다시 실행하세요. 아무것도 설치하지 않았습니다."
  fi
  WHOSUP_NODE="$NODE"; export WHOSUP_NODE
  if [ "$ui" = rich ]; then ui_step ok "Node $("$NODE" -v </dev/null)" "Node $("$NODE" -v </dev/null)"
  else say "node $("$NODE" -v </dev/null) ok" "node $("$NODE" -v </dev/null) 확인"
  fi
}

# ── 이 기계에 무엇이 있나 ──
# herdr: 있는가(herdr_found), 판 번호(herdr_version), 플러그인을 받는 판인가(herdr_ok), whosup이 이미 플러그인으로 등록돼 있는가(plugin_listed)
# 두 물음(herdr --version · herdr plugin list)에는 시간 제한을 둔다(herdr_limit 초): herdr가 멈춰 있어도 설치기는 서지 않는다.
# 제한을 넘기면 herdr_hung에 그 명령을 적고 그 herdr는 쓸 수 없는 것으로 본다(herdr_ok=0).
look_herdr() {
  herdr_found=0; herdr_ok=0; herdr_version=""; plugin_listed=0; herdr_hung=""
  # 양의 정수만 받는다: 빈 값·숫자가 아닌 값·0으로 시작하는 값(0, 007)·여섯 자리가 넘는 값은 기본값(10초)
  case "${WHOSUP_HERDR_TIMEOUT:-}" in '' | *[!0-9]* | 0* | ??????*) herdr_limit=10 ;; *) herdr_limit="$WHOSUP_HERDR_TIMEOUT" ;; esac
  command -v herdr >/dev/null 2>&1 || return 0
  herdr_found=1
  asked=0
  herdr_said="$(limited "$herdr_limit" herdr --version)" || asked=$?
  if [ "$asked" = 124 ]; then herdr_hung="herdr --version"; return 0; fi
  # 판 번호: 첫 줄에서 숫자로 시작하는 첫 낱말("herdr 0.9.3"). v가 앞에 붙어 있으면("herdr v1.0.0") 뗀다.
  herdr_version="$(printf '%s\n' "$herdr_said" | awk 'NR == 1 { for (i = 1; i <= NF; i++) if ($i ~ /^[vV]?[0-9]/) { sub(/^[vV]/, "", $i); print $i; exit } }')"
  if at_least "$HERDR_MIN" "${herdr_version:-0}"; then herdr_ok=1; fi
  # 목록에서 id를 낱말로 찾는다(src/setup.mjs listed와 같은 경계)
  id_pattern="$(printf '%s' "$PLUGIN_ID" | sed 's/\./\\./g')"
  asked=0
  herdr_said="$(limited "$herdr_limit" herdr plugin list)" || asked=$?
  if [ "$asked" = 124 ]; then herdr_hung="herdr plugin list"; herdr_ok=0; return 0; fi
  if printf '%s\n' "$herdr_said" | grep -Eq "(^|[^A-Za-z0-9._%-])$id_pattern([^A-Za-z0-9._%-]|\$)"; then plugin_listed=1; fi
}

# herdr-core가 있는가: 살아 있는 코어 소켓이 하나라도 있거나(상태 폴더 <XDG_STATE_HOME 또는 ~/.local/state>/herdr-core/*/core.lock 이 가리키는
# 소켓 — 리눅스에서는 XDG_RUNTIME_DIR 아래에 있다. HC_SOCKET이 있으면 그것도 — src/runtime/core.mjs가 찾는 방식), PATH에 herdr-core·hc가 있으면.
# 소켓에는 붙어 보기만 한다(아무것도 보내지 않는다). hc는 --version만 돌린다: 다른 hc 명령은 꺼진 코어를 켜고, hc라는 이름의 다른 프로그램도 있다.
# 그 셋이 다 아니어도, 이 기계에서 herdr-core를 쓴 흔적(core.lock 파일이 하나라도 있음)이 있으면 "있다"로 본다(core_why=trace): 자기 코어를 띄우는 앱
# (Herdr 앱 등)만 쓰는 사람이 앱을 꺼 둔 채 설치하는 경우다 — herdr를 깔 일이 아니다. core.lock 없이 남은 소켓 파일이나 죽은 HC_SOCKET은 흔적이 아니다.
# 탐침의 종료 코드: 0 = 살아 있는 코어가 있다 · 2 = 살아 있는 것은 없고 흔적(core.lock)만 있다 · 1 = 아무것도 없다
# XDG_STATE_HOME은 절대 경로일 때만 쓴다(상대 경로·제어 문자가 든 값은 없는 것으로 본다 — abs_dir · src/paths.mjs xdgDir과 같은 판정).
CORE_PROBE_JS='
const fs = require("fs"), path = require("path"), net = require("net"), os = require("os");
const xdg = (v) => (typeof v === "string" && path.isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v) ? v : "");
const state = xdg(process.env.XDG_STATE_HOME) || path.join(os.homedir(), ".local", "state");
const socks = process.env.HC_SOCKET ? [process.env.HC_SOCKET] : [];
let trace = false;
try {
  for (const d of fs.readdirSync(path.join(state, "herdr-core"))) {
    const lock = path.join(state, "herdr-core", d, "core.lock");
    try { if (fs.statSync(lock).isFile()) trace = true } catch {}
    try { const p = fs.readFileSync(lock, "utf8").trim(); if (p) socks.push(p) } catch {}
  }
} catch {}
const live = (p) => new Promise((r) => {
  const s = net.createConnection(p);
  const t = setTimeout(() => { s.destroy(); r(false) }, 1000);
  s.once("connect", () => { clearTimeout(t); s.destroy(); r(true) });
  s.once("error", () => { clearTimeout(t); r(false) });
});
(async () => { for (const p of socks) if (await live(p)) process.exit(0); process.exit(trace ? 2 : 1) })();
'
core_here() {
  core_why=""
  probe=0
  node_js "$CORE_PROBE_JS" </dev/null >/dev/null 2>&1 || probe=$?
  if [ "$probe" = 0 ]; then core_why="socket"; return 0; fi
  if command -v herdr-core >/dev/null 2>&1; then core_why="herdr-core"; return 0; fi
  if command -v hc >/dev/null 2>&1 && [ "$(hc --version 2>/dev/null </dev/null | sed -n '1s/^hc [0-9].*/yes/p')" = yes ]; then core_why="hc"; return 0; fi
  if [ "$probe" = 2 ]; then core_why="trace"; return 0; fi
  return 1
}

# ── herdr 플러그인의 보드가 떠 있는가 ──
# 찍는 것: "up <포트> <herdr>" 또는 "down <설정 포트> <herdr>". herdr = on(실행 중인 데스크 있음) | off | unknown.
# 상태 폴더는 herdr가 플러그인에 주는 곳(규칙: <XDG_STATE_HOME 또는 ~/.local/state>/herdr/plugins/<id> — src/setup.mjs herdrPluginDirs),
# 포트는 그 폴더의 port 파일 > PORT > 4790. herdr가 켜져 있을 때만 <기다릴 초> 동안 보드가 뜨기를 기다린다(설치 셋업의 도우미가 띄운다).
# XDG_STATE_HOME은 절대 경로일 때만 쓴다(src/setup.mjs herdrPluginDirs와 같다 — 상대 경로·제어 문자가 든 값은 없는 것으로 본다).
PLUGIN_BOARD_JS='
const fs = require("fs"), path = require("path"), os = require("os"), cp = require("child_process");
const [id, wait] = process.argv.slice(1);
const xdg = (v) => (typeof v === "string" && path.isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v) ? v : "");
const base = xdg(process.env.XDG_STATE_HOME) ? path.join(xdg(process.env.XDG_STATE_HOME), "herdr") : path.join(os.homedir(), ".local", "state", "herdr");
const state = path.join(base, "plugins", id);
let herdr = "unknown";
try {
  const o = JSON.parse(cp.execFileSync("herdr", ["session", "list", "--json"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
  const list = Array.isArray(o.sessions) ? o.sessions : (o.result && Array.isArray(o.result.sessions) ? o.result.sessions : []);
  herdr = list.some((s) => s && s.running) ? "on" : "off";
} catch {}
const conf = /^\d{1,5}$/.test(process.env.PORT || "") ? process.env.PORT : "4790";
const ports = () => { let p = ""; try { p = fs.readFileSync(path.join(state, "port"), "utf8").trim() } catch {} return [...new Set([/^\d{1,5}$/.test(p) ? p : null, conf].filter(Boolean))] };
// the board is up only when what answers on that port is the board of this state folder: its health reply carries the name
// (app) and the mark of this install (instance — made from the state folder, the same way as src/paths.mjs instanceOf; keep the two
// alike). Another server giving 200 there is not the board. A reply in the shape boards had before those fields counts only
// while the process in server.pid is alive (right after an update the board of the version before is still the one running).
const crypto = require("crypto");
const markOf = (dir) => { let d = path.resolve(dir); try { d = fs.realpathSync(d) } catch {} return crypto.createHash("sha256").update(d).digest("hex").slice(0, 16) };
const filedAlive = () => { try { const n = Number(fs.readFileSync(path.join(state, "server.pid"), "utf8").trim()); if (!Number.isInteger(n) || n <= 1) return false; process.kill(n, 0); return true } catch (e) { return e.code === "EPERM" } };
const up = async (p) => {
  try {
    const r = await fetch("http://127.0.0.1:" + p + "/api/health", { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return false;
    const b = await r.json();
    if (!b || typeof b !== "object" || Array.isArray(b) || b.ok !== true) return false;
    if ("app" in b || "instance" in b) return b.app === "whosup" && b.instance === markOf(state);
    return typeof b.readonly === "boolean" && Array.isArray(b.targets) && filedAlive();
  } catch { return false }
};
// the browser: "remote" (SSH, or Linux with no display: nothing opens on this screen) | "manual" (OPEN_BROWSER is not 1) | "opens".
// OPEN_BROWSER is read the way first-run setup reads it: the .env in the folder herdr gives the plugin for its settings wins over the environment.
const confBase = xdg(process.env.XDG_CONFIG_HOME) ? path.join(xdg(process.env.XDG_CONFIG_HOME), "herdr") : path.join(os.homedir(), ".config", "herdr");
let open = process.env.OPEN_BROWSER;
try {
  for (const raw of fs.readFileSync(path.join(confBase, "plugins", "config", id, ".env"), "utf8").split(/\r?\n/)) {
    const m = /^(?:export\s+)?OPEN_BROWSER\s*=\s*(.*)$/.exec(raw.trim());
    if (!m) continue;
    const v = m[1], q = v[0];
    open = (q === "\"" || q === "\x27") && v.length >= 2 && v.endsWith(q) ? v.slice(1, -1) : v.replace(/\s+#.*$/, "").trim();
  }
} catch {}
const remote = Boolean(process.env.SSH_CONNECTION || process.env.SSH_TTY) || (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY);
const browser = remote ? "remote" : String(open ?? "1") === "1" ? "opens" : "manual";
(async () => {
  const end = Date.now() + (herdr === "on" ? Number(wait) * 1000 : 0);
  for (;;) {
    for (const p of ports()) if (await up(p)) { console.log("up " + p + " " + herdr + " " + browser); return }
    if (Date.now() >= end) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  console.log("down " + conf + " " + herdr + " " + browser);
})();
'
plugin_board() {
  board="$(node_js "$PLUGIN_BOARD_JS" "$PLUGIN_ID" "$1" </dev/null 2>/dev/null)" || board=""
  # shellcheck disable=SC2086 # 네 낱말로 나눈다
  set -- $board
  board_state="${1:-down}"; board_port="${2:-4790}"; herdr_state="${3:-unknown}"; board_browser="${4:-opens}"
}
# 사람의 PATH(USER_PATH — 이 설치기가 덧붙이기 전의 PATH)로 그 이름의 명령이 잡히는가: 안내한 명령을 "그대로 치면 실행되는가"를 이것으로 본다.
on_user_path() {
  set -f; IFS=:
  for user_dir in $USER_PATH; do
    if [ -n "$user_dir" ] && [ -f "$user_dir/$1" ] && [ -x "$user_dir/$1" ]; then unset IFS; set +f; return 0; fi
  done
  unset IFS; set +f
  return 1
}
# 화면에 적을 herdr 명령(HERDR_SAY): 사람의 PATH로 herdr가 잡히면 짧은 이름, 아니면 이 설치기가 찾은 herdr의 전체 경로(붙여 넣을 수 있게 싼다 —
# shown). 전체 경로로 적었으면 그 폴더를 HERDR_OFF_PATH에 둔다: 요약이 PATH에 넣는 법을 한 번 알린다(path_hint).
# 방금 깐 herdr만이 아니다: 이 설치기가 덧붙인 폴더(search_path)에서 찾은 herdr도 사람의 PATH에 없으면 짧은 이름으로는 실행되지 않는다.
herdr_word() {
  HERDR_SAY=herdr; HERDR_OFF_PATH=""; herdr_typed=0
  if on_user_path herdr; then return 0; fi
  herdr_at="$(command -v herdr 2>/dev/null)" || herdr_at=""
  case "$herdr_at" in /*/herdr) ;; *) return 0 ;; esac
  HERDR_SAY="$(shown "$herdr_at")"; HERDR_OFF_PATH="${herdr_at%/herdr}"
}
# 보드 줄 아래: 브라우저가 저절로 열리지 않는 곳이면 그 사실을(원격이면 포트 넘기는 법도) 알린다 — 첫 실행 안내의 마무리 문구가 하던 말이다
# (src/setup.mjs browserManual · browserRemote와 같은 글자). 저절로 열리는 곳에서는 아무 줄도 더하지 않는다.
browser_lines() {
  [ "$board_browser" != opens ] || return 0
  line "    No browser opens by itself here. Open that address on this computer." "    여기서는 브라우저가 저절로 열리지 않습니다. 이 컴퓨터에서 위 주소를 여세요."
  [ "$board_browser" = remote ] || return 0
  line "    From another device, forward the port first: ssh -L $board_port:127.0.0.1:$board_port <host>" "    다른 기기에서 보려면 먼저 포트를 넘깁니다: ssh -L $board_port:127.0.0.1:$board_port <host>"
}
# 요약의 보드 줄과 다음에 할 일(플러그인 길). 칠 명령은 HERDR_SAY로 적는다(herdr_word를 먼저 부른다). 명령을 적었으면 herdr_typed=1.
plugin_board_lines() {
  url="http://127.0.0.1:$board_port"
  if [ "$board_state" = up ]; then
    line "  The board is running:  $url" "  보드가 켜져 있습니다:  $url"
    browser_lines
  elif [ "$herdr_state" = on ]; then
    line "  The board is not running yet. It starts whenever herdr starts:  $url (next port if taken)" "  보드는 아직 꺼져 있습니다. herdr를 켤 때마다 같이 뜹니다:  $url (사용 중이면 다음 포트)"
    browser_lines
    line "  To start it now, type this in a terminal inside herdr:" "  지금 띄우려면 herdr 안의 터미널에 아래를 치세요:"
    printf '      %s plugin action invoke %s.start\n' "$HERDR_SAY" "$PLUGIN_ID"; herdr_typed=1
  else
    line "  The board starts whenever herdr starts:  $url (next port if taken)" "  보드는 herdr를 켤 때마다 같이 뜹니다:  $url (사용 중이면 다음 포트)"
    browser_lines
    line "  Next: start herdr. Type this in a terminal and press Enter:" "  다음에 할 일: herdr를 켭니다. 터미널에 아래를 치고 Enter를 누르세요:"
    printf '      %s\n' "$HERDR_SAY"; herdr_typed=1
  fi
}
# 사람의 셸이 새 터미널을 열 때 읽는 설정 파일(SHELL로 본다). zsh(macOS의 기본 셸)는 ~/.profile을 읽지 않는다 — ~/.zshrc(ZDOTDIR이 있으면 그 폴더).
# bash는 macOS에서 ~/.bash_profile(터미널이 로그인 셸을 연다), 그 밖에서는 ~/.bashrc. 다른 셸·알 수 없으면 ~/.profile.
shell_rc() {
  case "${SHELL:-}" in
    */zsh | zsh) if [ -n "${ZDOTDIR:-}" ] && [ "$ZDOTDIR" != "$HOME" ]; then shown "$ZDOTDIR/.zshrc"; else printf '%s' '~/.zshrc'; fi ;;
    */bash | bash) if [ "$(uname -s)" = Darwin ]; then printf '%s' '~/.bash_profile'; else printf '%s' '~/.bashrc'; fi ;;
    *) printf '%s' '~/.profile' ;;
  esac
}
# herdr가 있는 폴더가 사람의 PATH에 없어 요약의 명령을 전체 경로로 적었을 때(HERDR_OFF_PATH · herdr_typed): 그 까닭과, 새로 여는 터미널부터
# 짧은 이름(herdr)으로 쓰게 PATH에 넣는 법을 한 번 알린다(셸 설정 파일은 고치지 않는다). 위에 적은 전체 경로 명령은 지금 이 터미널에서 그대로 된다 —
# "지금은 전체 경로로, 새 터미널부터는 짧은 이름으로"가 한 묶음이다(전에는 "PATH에 넣고 새 터미널을 여세요" 바로 아래에 "herdr 를 치세요"가 왔다).
# 명령을 적지 않은 요약(보드가 이미 켜져 있다)에는 싣지 않는다.
path_hint() {
  if [ -z "$HERDR_OFF_PATH" ] || [ "$herdr_typed" != 1 ]; then return 0; fi
  line "  $HERDR_OFF_PATH is not on your PATH, so herdr is spelled with its full path above (it runs as it is). To type just herdr in terminals you open from now on, type this once:" \
    "  $HERDR_OFF_PATH 폴더가 PATH에 없어 위에서는 herdr 를 전체 경로로 적었습니다(그대로 치면 됩니다). 새로 여는 터미널부터 herdr 만 쳐도 되게 하려면 아래를 한 번 치세요:"
  # 그대로 붙여 넣을 줄: 폴더 이름은 큰따옴표 안에서 안전하게 막고(dq), echo에 넘길 한 낱말로 싼다(quote) — 폴더 이름에 공백·따옴표·$ 가
  # 있어도 붙여 넣은 명령이 다른 뜻이 되지 않는다. $PATH는 펼치지 않는다(셸 설정 파일에 그대로 적힌다).
  # 막은 글자(\)가 들어간 줄은 echo 대신 printf로 적는다: 셸에 따라 echo가 \ 를 풀어 버린다.
  rc_line="export PATH=\"$(dq "$HERDR_OFF_PATH"):\$PATH\""
  case "$rc_line" in
    *\\*) printf "      printf '%%s\\\\n' %s >> %s\n" "$(quote "$rc_line")" "$(shell_rc)" ;;
    *) printf '      echo %s >> %s\n' "$(quote "$rc_line")" "$(shell_rc)" ;;
  esac
}
standalone_note() {
  [ "$have_standalone" = 1 ] || return 0
  line "  A standalone whosup is also installed here ($APP). To remove it, type this in a terminal:" "  단독으로 설치한 whosup도 있습니다($APP). 지우려면 터미널에 아래를 치세요:"
  printf '      whosup uninstall\n'
}

# ── 길 (다): herdr 설치(관리자 권한 없이 ~/.local/bin에) ──
install_herdr() {
  if [ "$ui" = rich ]; then ui_step run "downloading herdr" "herdr 내려받는 중"
  else say "herdr is not here: installing herdr (https://herdr.dev) into $HERDR_DIR first" "herdr가 없습니다: 먼저 herdr(https://herdr.dev)를 $HERDR_DIR 에 설치합니다"
  fi
  if [ -z "${WHOSUP_HERDR_INSTALL_CMD:-}" ] && ! command -v curl >/dev/null 2>&1; then
    fail "installing herdr needs curl, which is not here. Install herdr yourself ($HERDR_DOCS), then run this installer again." "herdr를 설치하려면 curl이 필요한데 없습니다. herdr를 직접 설치한 뒤($HERDR_DOCS) 이 설치 명령을 다시 실행하세요."
  fi
  # 그 설치기는 앱의 설치기와 같은 방식으로 돌린다(run_quiet: 입력 없이, 시간 제한을 두고, 출력은 기록 파일에). 깔렸으면 그 출력은 보여 주지
  # 않는다 — 아래의 "herdr <판> 설치함" 한 줄이 대신한다. 깔리지 않았으면 그 출력을 전부 보여 준 뒤 알린다.
  env_begin
  herdr_status=0
  run_quiet "${WHOSUP_HERDR_INSTALL_CMD:-$HERDR_INSTALL_CMD_DEFAULT}" || herdr_status=$?
  # herdr의 설치 스크립트는 그 폴더가 PATH에 없어도 0으로 끝난다: PATH에 넣고 다시 확인한다
  PATH="$HERDR_DIR:$PATH"; export PATH
  look_herdr
  if [ "$herdr_found" != 1 ]; then
    ui_break
    if [ -s "$env_log" ]; then cat "$env_log" >&2; fi
    fail "herdr did not install (its installer $(ended_en "$herdr_status"); what it said is above). Install it yourself ($HERDR_DOCS), then run this installer again. whosup was not installed." \
      "herdr를 설치하지 못했습니다(설치 스크립트 $(ended_ko "$herdr_status"), 위에 그 출력이 있습니다). herdr를 직접 설치한 뒤($HERDR_DOCS) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다."
  fi
  env_end
  herdr_installed=1
  if [ "$ui" = rich ]; then ui_step ok "herdr ${herdr_version:-?} installed" "herdr ${herdr_version:-?} 설치"
  else say "herdr ${herdr_version:-?} installed" "herdr ${herdr_version:-?} 설치함"
  fi
}

# ── 환경 고르기: 아무것도 없는 기계(herdr도, herdr-core도 없다)에서 세션을 띄울 환경을 정하고 그것까지 깐다 ──
# 값은 셋이다: herdr-app(Herdr 앱 → 단독 설치) · ovis-app(Ovis 앱 → 단독 설치) · herdr(터미널용 herdr → 플러그인 — 위의 길 (다) 그대로).
# 정하는 순서: WHOSUP_ENV > 이미 놓여 있는 앱(한 번도 켜지 않아 코어 흔적이 없는 앱 — 다시 깔지 않고 그 앱에 붙인다. Herdr 앱은 그 코어가
#   놓여 있는지도 보고 없으면 코어를 채운다) > 화면이 없는 리눅스 세션이면 herdr(no_screen) > 터미널에서 번호로 고른 값
#   > 기본값(Herdr 앱 → 이 기계에서 안 되면 Ovis 앱 → 앱이 하나도 안 되면 herdr).
# 이 기계에 깔 수 없는 환경은 선택지에 없다. 남는 선택지가 하나면 묻지 않는다.
#
# 이 기계: os(Darwin·Linux) · cpu(arm64·x64·빈 값 = 그 밖). 맥의 칩은 uname -m이 아니라 sysctl로 본다(Rosetta 아래의 셸은 애플 실리콘에서도 x86_64라고 답한다).
look_machine() {
  os="$(uname -s)"; cpu=""
  if [ "$os" = Darwin ]; then
    if [ "$(PATH="$PATH:/usr/sbin:/sbin" sysctl -n hw.optional.arm64 2>/dev/null </dev/null)" = 1 ]; then cpu=arm64; else cpu=x64; fi
  else
    case "$(uname -m)" in x86_64 | amd64) cpu=x64 ;; aarch64 | arm64) cpu=arm64 ;; esac
  fi
  # Ovis 앱의 리눅스 버전(AppImage)을 두는 곳: 사용자가 쓸 수 있는 폴더여야 앱이 스스로 새 버전을 받는다(<데이터>/ovis는 Ovis의 한 줄 설치판이 쓰는 자리라 피한다)
  ovis_dir="${data_home:-$HOME/.local/share}/ovis-desktop"
}
# 환경의 이름(문장에 넣는다). 한국어 이름은 받침으로 끝난다("앱") — 조사를 붙여 쓴다.
env_name() { case "$1" in herdr-app) pick "the Herdr app" "Herdr 앱" ;; ovis-app) pick "the Ovis app" "Ovis 앱" ;; *) printf 'herdr' ;; esac; }
env_docs() { case "$1" in herdr-app) printf '%s' "$HERDR_APP_DOCS" ;; ovis-app) printf '%s' "$OVIS_DOCS" ;; *) printf '%s' "$HERDR_DOCS" ;; esac; }
# 이 기계에 깔 수 있는가. 못 깔면 1 과 이유(why_en · why_ko). 대역 설치 명령(WHOSUP_*_INSTALL_CMD)을 받았으면 진짜 설치 방법이 쓰는 도구는 보지 않는다.
herdr_app_ok() {
  why_en=""; why_ko=""
  if [ "$os" = Darwin ] && [ "$cpu" != arm64 ]; then why_en="the Herdr app does not run on Intel Macs"; why_ko="Herdr 앱은 인텔 맥에서 돌지 않습니다"; return 1; fi
  if [ -z "$cpu" ]; then why_en="the Herdr app has no build for this processor ($(uname -m))"; why_ko="이 프로세서($(uname -m))용 Herdr 앱이 없습니다"; return 1; fi
  [ -z "${WHOSUP_HERDR_APP_INSTALL_CMD:-}" ] || return 0
  if ! command -v curl >/dev/null 2>&1 || ! command -v tar >/dev/null 2>&1; then why_en="installing the Herdr app needs curl and tar, and one of them is not here"; why_ko="Herdr 앱을 설치하려면 curl과 tar가 필요한데 없습니다"; return 1; fi
  return 0
}
# Ovis 앱: 맥은 arm64·x64(macOS 13 이상), 리눅스는 관리자 권한이 필요 없는 AppImage 길만 — 그 앱이 쓰는 데스크톱 라이브러리와 FUSE가 이미 있을 때.
# (라이브러리가 없으면 결국 관리자 권한으로 패키지를 깔아야 한다. 그때는 선택지에서 빼고 내려받는 곳을 알린다.)
OVIS_LINUX_LIBS="libgtk-3.so.0 libnss3.so libgbm.so.1 libasound.so.2 libnotify.so.4 libXss.so.1 libXtst.so.6 libsecret-1.so.0"
ovis_app_ok() {
  why_en=""; why_ko=""
  if [ -z "$cpu" ]; then why_en="the Ovis app has no build for this processor ($(uname -m))"; why_ko="이 프로세서($(uname -m))용 Ovis 앱이 없습니다"; return 1; fi
  [ -z "${WHOSUP_OVIS_APP_INSTALL_CMD:-}" ] || return 0
  if ! command -v curl >/dev/null 2>&1; then why_en="getting the Ovis app needs curl, which is not here"; why_ko="Ovis 앱을 받으려면 curl이 필요한데 없습니다"; return 1; fi
  if [ "$os" = Darwin ]; then
    mac_major="$(PATH="$PATH:/usr/bin" sw_vers -productVersion 2>/dev/null </dev/null | sed -n '1s/^\([0-9][0-9]*\).*/\1/p')"
    if [ "${mac_major:-0}" -lt 13 ]; then why_en="the Ovis app needs macOS 13 or newer"; why_ko="Ovis 앱은 macOS 13 이상이 필요합니다"; return 1; fi
    for tool in /usr/bin/ditto /usr/bin/codesign /usr/sbin/spctl; do
      if [ ! -x "$tool" ]; then why_en="checking the Ovis app needs $tool, which is not here"; why_ko="Ovis 앱을 확인하는 데 쓰는 명령($tool)이 없습니다"; return 1; fi
    done
    return 0
  fi
  ovis_libs="$(PATH="$PATH:/sbin:/usr/sbin" ldconfig -p 2>/dev/null </dev/null)" || ovis_libs=""
  for lib in $OVIS_LINUX_LIBS; do
    case "$ovis_libs" in *"$lib"*) ;; *) why_en="the Ovis app needs desktop libraries that are not on this computer ($lib), and installing them takes an administrator password"; why_ko="Ovis 앱이 쓰는 데스크톱 라이브러리($lib)가 이 컴퓨터에 없고, 그것을 깔려면 관리자 암호가 필요합니다"; return 1 ;; esac
  done
  if [ ! -c /dev/fuse ] || [ ! -r /dev/fuse ] || [ ! -w /dev/fuse ] || { ! command -v fusermount3 >/dev/null 2>&1 && ! command -v fusermount >/dev/null 2>&1; }; then
    why_en="the Ovis app's AppImage needs FUSE, which is not available here"; why_ko="Ovis 앱의 AppImage는 FUSE가 필요한데 여기서는 쓸 수 없습니다"; return 1
  fi
  return 0
}
# 이미 놓여 있는 앱의 경로를 찍는다(없으면 아무것도 찍지 않는다). 맥: 응용 프로그램 폴더 둘(/Applications — WHOSUP_SYSTEM_APPS로 바꾼다 — 와 ~/Applications).
# 리눅스: 그 앱의 설치기가 놓는 자리(Herdr 앱 = ~/.local/bin/herdr-app, Ovis 앱 = 이 설치기가 두는 AppImage).
mac_app() {
  for apps in "${WHOSUP_SYSTEM_APPS-/Applications}" "$HOME/Applications"; do
    case "$apps" in /*) ;; *) continue ;; esac
    if [ -d "$apps/$1" ]; then printf '%s' "$apps/$1"; return 0; fi
  done
  return 1
}
herdr_app_at() { if [ "$os" = Darwin ]; then mac_app Herdr.app; elif [ -x "$HOME/.local/bin/herdr-app" ]; then printf '%s' "$HOME/.local/bin/herdr-app"; else return 1; fi; }
ovis_app_at() { if [ "$os" = Darwin ]; then mac_app Ovis.app; elif [ -x "$ovis_dir/Ovis-linux-$cpu.AppImage" ]; then printf '%s' "$ovis_dir/Ovis-linux-$cpu.AppImage"; else return 1; fi; }
herdr_core_at() { [ -x "$HOME/.local/bin/herdr-core" ] || command -v herdr-core >/dev/null 2>&1; }
# 화면이 없는 리눅스 세션인가: DISPLAY도 WAYLAND_DISPLAY도 없다(보드의 "원격" 판정과 같다 — src/autoconf.mjs remoteWhy의 리눅스 줄).
# 데스크톱 앱은 데스크톱 세션이 있어야 열리고, 열지 못하면 그 앱의 코어도 뜨지 않아 보드에 세션이 생기지 않는다. 맥은 늘 화면이 있는 것으로 본다
# (SSH로 들어와 설치해도 그 맥의 화면에서 앱을 열 수 있다). WHOSUP_ENV로 받은 앱은 이 판정과 상관없이 깐다(환경변수 > 자동 감지).
no_screen() { [ "$os" = Linux ] && [ -z "${DISPLAY:-}" ] && [ -z "${WAYLAND_DISPLAY:-}" ]; }

# 터미널에서 묻기. 질문은 제어 터미널(/dev/tty)에 찍고 거기서 읽는다(curl | sh 에서는 표준 입력이 이 스크립트다). 읽기는 node로 한다:
# 시간 제한을 둘 수 있고(자리에 없는 설치가 서 있지 않게 — 첫 실행 안내와 같은 WHOSUP_SETUP_TIMEOUT_S, 기본 120초), 터미널의 뒤(background)
# 프로세스 그룹에서는 읽지 않는다(읽으면 SIGTTIN으로 멈춘다 — src/setup.mjs inForeground와 같은 판정).
#   check: 물을 수 있으면 0, 없으면 3.   read <초>: 한 줄을 찍고 0 · 시간 초과 2 · 터미널이 닫힘 3.
TTY_JS='
const fs = require("fs"), tty = require("tty"), cp = require("child_process");
const [what, secs] = process.argv.slice(1);
let fd;
try { fd = fs.openSync("/dev/tty", "r") } catch { process.exit(3) }
let front = null;
try { const m = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(cp.execFileSync("ps", ["-o", "pgid=", "-o", "tpgid=", "-p", String(process.pid)], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] })); if (m) front = m[1] === m[2] } catch {}
if (front === false) process.exit(3);
if (what === "check") process.exit(0);
let input;
try { input = new tty.ReadStream(fd) } catch { input = fs.createReadStream(null, { fd, autoClose: false }) }
const end = (code, line) => { clearTimeout(timer); try { input.destroy() } catch {} if (line !== undefined) fs.writeSync(1, line + "\n"); process.exit(code) };
const timer = setTimeout(() => end(2), Math.max(1, Number(secs) || 120) * 1000);
let buf = "";
input.on("data", (c) => { buf += String(c); const i = buf.search(/[\r\n]/); if (i >= 0) end(0, buf.slice(0, i)) });
input.on("end", () => end(3)); input.on("error", () => end(3));
'
# rich 화면의 도우미(src/tui.mjs의 UI_JS 묶음을 그대로 옮긴 것 — scripts/gen-install-ui.mjs가 쓰고 test/tui.test.mjs가 같은지 본다).
#   node_js "$UI_JS" menu …   화살표 메뉴(/dev/tty) · print   블록을 폭에 맞춰 그린다(표준 입력: 종류<TAB>글<TAB>값) · width
# >>> UI_JS generated by scripts/gen-install-ui.mjs from src/tui.mjs: do not edit here
UI_JS='
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
const uiMode = function (/** @type {{ env?: Record<string, any>, stdoutTTY?: boolean, ttyOK?: boolean }} */ { env = {}, stdoutTTY = false, ttyOK = false } = {}) {
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
const uiCols = function (/** @type {{ ttyCols?: number, env?: Record<string, any>, sttyCols?: number }} */ { ttyCols = 0, env = {}, sttyCols = 0 } = {}) {
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
const wrap = function (text, width, /** @type {{ first?: string, hang?: string | number, amb?: number }} */ { first = "", hang, amb = 2 } = {}) {
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
const menuLines = function (/** @type {{ title?: string, options?: any[], sel?: number, preset?: number, secs?: number, lang?: string, width?: number, color?: boolean, utf8?: boolean, lead?: boolean }} */ { title, options = [], sel = 1, preset = 1, secs = 120, lang = "en", width = 80, color = true, utf8 = true, lead = false } = {}) {
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
const collapseLine = function (/** @type {{ prefix?: string, label?: string, auto?: boolean, lang?: string, color?: boolean, utf8?: boolean, width?: number }} */ { prefix, label, auto = false, lang = "en", color = true, utf8 = true, width = 0 } = {}) {
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
    /** @type {Array<[NodeJS.Signals, () => void]>} */
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
uiCli(process.argv.slice(1))
'
# <<< UI_JS
# 물을 수 있는가: 끄는 스위치(CI · WHOSUP_NO_SETUP — 첫 실행 안내와 같다)가 없고, 제어 터미널이 있고, 그 앞(foreground)에서 돌고 있다.
can_ask() {
  if on "${CI:-}" || on "${WHOSUP_NO_SETUP:-}"; then return 1; fi
  node_js "$TTY_JS" check </dev/null >/dev/null 2>&1
}
tty_line() { printf '%s\n' "$(pick "$1" "$2")" > /dev/tty; }
# ask_number <선택지 수>: 번호 입력 줄을 찍고 답을 읽는다(첫 실행 안내의 질문과 같은 모양 — src/setup.mjs askAll). 답은 ask_n(기본 1).
# Enter = 1번(* 표시), 번호 = 그 선택지, 틀린 입력 세 번 = 1번. 시간 초과·터미널 닫힘이면 1번으로 두고 남은 질문도 묻지 않는다(ask_over=1).
ask_over=0
ask_number() {
  ask_n=1; ask_tries=0
  while :; do
    printf '    %s' "$(pick "Type a number, or press Enter for 1: " "번호를 입력하세요 (Enter만 치면 1번): ")" > /dev/tty
    ask_rc=0
    ask_line="$(node_js "$TTY_JS" read "$ask_limit" </dev/null 2>/dev/null)" || ask_rc=$?
    if [ "$ask_rc" = 2 ]; then
      printf '\n' > /dev/tty
      tty_line "  No input for $ask_limit s: going on with the choice marked *." "  ${ask_limit}초 동안 입력이 없어 * 표시한 것으로 넘어갑니다."
      ask_over=1; return 0
    fi
    if [ "$ask_rc" != 0 ]; then ask_over=1; return 0; fi
    ask_line="$(printf '%s' "$ask_line" | tr -d ' \t\r')"
    [ -n "$ask_line" ] || return 0
    case "$ask_line" in
      *[!0-9]* | ???*) ;;
      *) if [ "$ask_line" -ge 1 ] && [ "$ask_line" -le "$1" ]; then ask_n="$ask_line"; return 0; fi ;;
    esac
    ask_tries=$((ask_tries + 1))
    if [ "$ask_tries" -ge 3 ]; then tty_line "    Going on with the choice marked *." "    * 표시한 것으로 정합니다."; return 0; fi
    tty_line "    Please type a number from 1 to $1." "    1부터 $1까지의 번호를 입력해 주세요."
  done
}
# 깔 수 없어 선택지에서 뺀 앱: 이유와 직접 받는 곳을 한 줄로 알린다(질문의 제목 줄 위에 찍는다).
left_out() {
  tty_line "  $(env_name "$1" | sed 's/^t/T/') is not offered here: $2. To get it yourself: $(env_docs "$1")" "  $(env_name "$1")은 여기서 고를 수 없습니다: $3. 직접 받으려면: $(env_docs "$1")"
}
# 두 번에 걸쳐 묻는다: ① 데스크톱 앱 / 터미널 ② 앱이면 Herdr / Ovis(둘 다 깔 수 있을 때만). 선택지마다 무엇이 깔리는지 한 줄.
# "데스크톱 앱"의 설명 줄은 이 기계에 깔 수 있는 앱의 이름을 댄다 — 첫 질문에서부터 Ovis가 보이도록. 답은 env_pick.
ask_env() {
  case "${WHOSUP_SETUP_TIMEOUT_S:-}" in '' | *[!0-9]* | 0* | ?????*) ask_limit=120 ;; *) ask_limit="$WHOSUP_SETUP_TIMEOUT_S" ;; esac
  [ "$ask_limit" -le 3600 ] || ask_limit=3600
  ui_head=0
  if [ "$ui" = rich ] && ask_env_rich; then return 0; fi
  # rich 메뉴를 띄우지 못해 번호로 묻는다(ui_head=1: rich의 머리 문단과 빠진 앱 줄은 이미 찍었다 — 같은 말을 두 번 하지 않는다)
  if [ "$ui_head" != 1 ]; then
    printf '\n' > /dev/tty
    tty_line "whosup: nothing to run agent sessions in is here yet. Pick one and it is installed for you, then whosup." "whosup: 에이전트 세션을 띄울 환경이 아직 없습니다. 고르면 그것부터 설치한 뒤 whosup을 설치합니다."
  fi
  tty_line "  Enter takes the choice marked *. With no answer for $ask_limit s, the install goes on with it by itself." "  Enter만 치면 * 표시한 것으로 정합니다. ${ask_limit}초 동안 답이 없으면 그것으로 넘어갑니다."
  if [ "$ui_head" != 1 ]; then
    [ "$can_herdr_app" = 1 ] || left_out herdr-app "$herdr_app_why_en" "$herdr_app_why_ko"
    [ "$can_ovis_app" = 1 ] || left_out ovis-app "$ovis_app_why_en" "$ovis_app_why_ko"
  fi
  printf '\n' > /dev/tty
  tty_line "  Where do you want to run your sessions" "  세션을 어디에서 쓸까요"
  tty_line "    1) Desktop app *" "    1) 데스크톱 앱 *"
  if [ "$can_herdr_app" = 1 ] && [ "$can_ovis_app" = 1 ]; then
    tty_line "       An app with its own window (Herdr or Ovis — you pick it next). Nothing to learn in the terminal." "       창이 따로 뜨는 앱(Herdr 또는 Ovis — 다음 질문에서 고릅니다)을 설치합니다. 터미널을 몰라도 됩니다."
  else
    # 깔 수 있는 앱이 하나뿐이다(ask_env는 앱이 하나라도 될 때만 불린다): 그 이름을 대고, 둘째 질문은 없다고 말한다
    if [ "$can_herdr_app" = 1 ]; then ask_app=Herdr; else ask_app=Ovis; fi
    tty_line "       An app with its own window ($ask_app — the only one offered here, so nothing more is asked). Nothing to learn in the terminal." "       창이 따로 뜨는 앱($ask_app — 여기서 깔 수 있는 앱은 이것뿐이라 더 묻지 않습니다)을 설치합니다. 터미널을 몰라도 됩니다."
  fi
  tty_line "    2) Terminal" "    2) 터미널"
  tty_line "       herdr, a small program that keeps sessions inside the terminal you already use, is installed into $HERDR_DIR." "       지금 쓰는 터미널 안에서 세션을 관리하는 작은 프로그램 herdr를 $HERDR_DIR 에 설치합니다."
  ask_number 2
  if [ "$ask_n" = 2 ]; then env_pick=herdr; return 0; fi
  env_pick="$env_default"
  # 앱이 하나뿐이면 고를 것이 없다. 시간 초과·터미널 닫힘(ask_over)이면 남은 질문도 묻지 않고 env_default(깔 수 있는 첫 앱)
  if [ "$can_herdr_app" != 1 ] || [ "$can_ovis_app" != 1 ] || [ "$ask_over" = 1 ]; then return 0; fi
  ask_app_number
}
# 둘째 질문(Herdr / Ovis)을 번호로 묻는다. 답은 env_pick. rich 메뉴가 둘째 질문에서 터미널을 바꾸지 못했을 때도 이것으로 묻는다.
ask_app_number() {
  tty_line "  Which app" "  어느 앱을 쓸까요"
  tty_line "    1) Herdr *" "    1) Herdr *"
  tty_line "       The Herdr app, a small download. The board opens, switches to and closes its sessions." "       Herdr 앱. 내려받는 크기가 작습니다. 보드에서 세션을 열고, 그 세션으로 가고, 닫을 수 있습니다."
  tty_line "    2) Ovis" "    2) Ovis"
  tty_line "       The Ovis app, a download of about 175 MB (about 400 MB once unpacked)." "       Ovis 앱. 약 175MB를 내려받습니다(풀면 약 400MB)."
  ask_number 2
  if [ "$ask_n" = 2 ]; then env_pick=ovis-app; else env_pick=herdr-app; fi
}
# rich 화면의 같은 두 질문: 화살표 메뉴(위/아래 · k/j로 옮기고 Enter, 번호를 누르면 바로 그것으로). 고르면 메뉴가 "✓ 세션을 쓸 곳: …" 한 줄로 접힌다.
# 터미널은 stty -icanon -echo min 1 time 0 으로만 바꾼다(ISIG는 그대로 — Ctrl-C는 여전히 프로세스 묶음 전체에 SIGINT로 간다). 바꾸기 전의 설정(stty -g)을
# ui_saved에 두고, 메뉴가 어떻게 끝나든 · 이 설치기가 신호로 끝나든 되돌린다(ui_restore — 아래의 갈무리와 env_clean · unlock · on_signal).
# 메뉴를 띄울 수 없으면(stty가 안 됨 · 메뉴가 터미널을 바꾸지 못함) 1 — 부른 쪽(ask_env)이 번호로 묻는다. 답은 env_pick, 시간 초과는 ask_over=1(지금과 같다).
ask_env_rich() {
  ui_saved="$( { stty -g </dev/tty; } 2>/dev/null)" || ui_saved=""
  [ -n "$ui_saved" ] || return 1
  trap 'node_rc=$?; ui_restore; unlock; node_settle' EXIT
  trap 'ui_restore; ui_stopped; exit 130' INT
  trap 'ui_restore; ui_stopped; exit 143' TERM
  trap 'ui_restore; ui_stopped; exit 129' HUP
  if ! { stty -icanon -echo min 1 time 0 </dev/tty; } 2>/dev/null; then ui_menu_end; return 1; fi
  ui_add blank
  ui_add para "$(pick "Nothing to run agent sessions in is here yet. What you pick is installed first, then whosup." "세션을 띄울 환경이 아직 없습니다. 고른 것을 먼저 설치한 뒤 whosup을 설치합니다.")"
  [ "$can_herdr_app" = 1 ] || ui_add warn "$(pick "The Herdr app is not offered here: $herdr_app_why_en. To get it yourself: $HERDR_APP_DOCS" "Herdr 앱은 여기서 고를 수 없습니다: $herdr_app_why_ko. 직접 받으려면: $HERDR_APP_DOCS")"
  [ "$can_ovis_app" = 1 ] || ui_add warn "$(pick "The Ovis app is not offered here: $ovis_app_why_en. To get it yourself: $OVIS_DOCS" "Ovis 앱은 여기서 고를 수 없습니다: $ovis_app_why_ko. 직접 받으려면: $OVIS_DOCS")"
  ui_add blank
  ui_flush > /dev/tty
  ui_head=1
  if [ "$can_herdr_app" = 1 ] && [ "$can_ovis_app" = 1 ]; then
    ui_d1="$(pick "An app with its own window (Herdr or Ovis — you pick it next). Nothing to learn in the terminal." "창이 따로 뜨는 앱(Herdr 또는 Ovis — 다음 질문에서 고릅니다)을 설치합니다. 터미널을 몰라도 됩니다.")"
  else
    if [ "$can_herdr_app" = 1 ]; then ask_app=Herdr; else ask_app=Ovis; fi
    ui_d1="$(pick "An app with its own window ($ask_app — the only one offered here, so nothing more is asked). Nothing to learn in the terminal." "창이 따로 뜨는 앱($ask_app — 여기서 깔 수 있는 앱은 이것뿐이라 더 묻지 않습니다)을 설치합니다. 터미널을 몰라도 됩니다.")"
  fi
  ui_d2="$(pick "herdr, a small program that keeps sessions inside the terminal you already use, is installed into $(ui_path "$HERDR_DIR")." "지금 쓰는 터미널 안에서 세션을 관리하는 작은 프로그램 herdr를 $(ui_path "$HERDR_DIR") 에 설치합니다.")"
  ui_menu 0 0 "$(pick "Sessions run in" "세션을 쓸 곳")" "$(pick "Where do you want to run your sessions?" "세션을 어디에서 쓸까요?")" \
    "$(pick "Desktop app" "데스크톱 앱")" "$ui_d1" "$(pick "Terminal" "터미널")" "$ui_d2" || { ui_menu_end; return 1; }
  if [ "$ui_n" = 2 ]; then env_pick=herdr; ui_menu_end; return 0; fi
  env_pick="$env_default"
  if [ "$can_herdr_app" != 1 ] || [ "$can_ovis_app" != 1 ] || [ "$ask_over" = 1 ]; then ui_menu_end; return 0; fi
  ui_after=0; [ "$ui_how" != digit ] || ui_after=1
  ui_menu "$ui_after" 1 "$(pick "App" "앱")" "$(pick "Which app?" "어느 앱을 쓸까요?")" \
    "Herdr" "$(pick "The Herdr app, a small download. The board opens, switches to and closes its sessions." "Herdr 앱. 내려받는 크기가 작습니다. 보드에서 세션을 열고, 그 세션으로 가고, 닫을 수 있습니다.")" \
    "Ovis" "$(pick "The Ovis app, a download of about 175 MB (about 400 MB once unpacked)." "Ovis 앱. 약 175MB를 내려받습니다(풀면 약 400MB).")" || {
    # 둘째 메뉴가 터미널을 바꾸지 못했다: 터미널을 되돌린 뒤 이 질문만 번호로 묻는다(첫 질문의 답은 그대로)
    ui_menu_end
    tty_line "  Enter takes the choice marked *. With no answer for $ask_limit s, the install goes on with it by itself." "  Enter만 치면 * 표시한 것으로 정합니다. ${ask_limit}초 동안 답이 없으면 그것으로 넘어갑니다."
    ask_app_number
    return 0
  }
  if [ "$ui_n" = 2 ]; then env_pick=ovis-app; else env_pick=herdr-app; fi
  ui_menu_end
  return 0
}
# ui_menu <앞 질문을 번호로 골랐나 0|1> <위에 빈 줄 0|1> <접은 줄의 머리> <제목> <이름> <설명> <이름> <설명>: 답은 ui_n · ui_how.
# 시간 초과 · 터미널 닫힘이면 1번과 ask_over=1. 메뉴가 터미널을 바꾸지 못했으면(4) 1을 돌려준다. 신호로 끝났으면 갈무리(INT 등)가 끝낸다.
ui_menu() {
  ui_rc=0
  ui_out="$(node_js "$UI_JS" menu "$lang" "$ask_limit" 1 "$@" </dev/null 2>/dev/null)" || ui_rc=$?
  ui_n=1; ui_how=""
  case "$ui_rc" in
    0) ui_n="${ui_out%% *}"; ui_how="${ui_out#* }"; case "$ui_n" in 1 | 2) ;; *) ui_n=1 ;; esac ;;
    4) return 1 ;;
    129 | 130 | 143) ui_restore; ui_stopped; exit "$ui_rc" ;;
    *) ask_over=1 ;;
  esac
  return 0
}
ui_menu_end() { ui_restore; node_traps; }
ui_stopped() { printf '  %s%s%s %s\n' "$c_r" "$ui_s_x" "$c_0" "$(pick "Stopped. Nothing was installed." "그만두었습니다. 아무것도 설치하지 않았습니다.")"; }
# 이미 놓여 있는 앱(env_pick · env_here)에 붙인다는 진행 줄. Herdr 앱인데 코어(herdr-core)가 없으면 — 앞 설치가 코어에서 멈춘 채 남았거나,
# 코어를 놓지 않는 방법으로 받은 앱이다 — "정상 설치"로 넘기지 않고 install_herdr_app이 코어를 채운다(채우지 못하면 거기서 끝낸다).
attach_here() {
  if [ "$ui" = rich ]; then
    if [ "$env_pick" = herdr-app ] && ! herdr_core_at; then
      ui_print warn "$(pick "The Herdr app is here ($(ui_path "$env_here")) but its core, herdr-core, is not: the core is installed first, then whosup." "Herdr 앱은 있는데($(ui_path "$env_here")) 그 코어(herdr-core)가 없습니다: 코어부터 설치한 뒤 whosup을 설치합니다.")"
    else
      ui_print ok "$(pick "$(env_name "$env_pick" | sed 's/^t/T/') is already here ($(ui_path "$env_here")) and has not been opened yet: only whosup is installed." "$(env_name "$env_pick")이 이미 있습니다($(ui_path "$env_here"), 아직 켠 적 없음): whosup만 설치합니다.")"
    fi
    return 0
  fi
  if [ "$env_pick" = herdr-app ] && ! herdr_core_at; then
    say "the Herdr app is already on this computer ($env_here), but its core, herdr-core, is not: the core is installed first, then whosup next to the app" \
      "Herdr 앱이 이미 이 컴퓨터에 있는데($env_here) 그 코어(herdr-core)가 없습니다: 코어부터 설치한 뒤 whosup을 설치합니다"
  else
    say "$(env_name "$env_pick") is already on this computer ($env_here) and has not been opened yet: whosup is installed next to it, nothing else is installed" \
      "$(env_name "$env_pick")이 이미 이 컴퓨터에 있고($env_here) 아직 켠 적이 없습니다: 다른 것은 깔지 않고 whosup만 설치합니다"
  fi
}
# 환경을 정한다: env_pick(herdr-app · ovis-app · herdr)과 env_here(이미 놓여 있는 앱의 경로 — 그때는 깔지 않는다).
choose_env() {
  look_machine
  can_herdr_app=0; can_ovis_app=0
  if herdr_app_ok; then can_herdr_app=1; fi
  herdr_app_why_en="$why_en"; herdr_app_why_ko="$why_ko"
  if ovis_app_ok; then can_ovis_app=1; fi
  ovis_app_why_en="$why_en"; ovis_app_why_ko="$why_ko"
  env_default=herdr
  if [ "$can_herdr_app" = 1 ]; then env_default=herdr-app; elif [ "$can_ovis_app" = 1 ]; then env_default=ovis-app; fi
  env_here=""
  if [ -n "${WHOSUP_ENV:-}" ]; then
    env_pick="$WHOSUP_ENV"
    case "$env_pick" in
      herdr-app) env_can="$can_herdr_app"; why_en="$herdr_app_why_en"; why_ko="$herdr_app_why_ko" ;;
      ovis-app) env_can="$can_ovis_app"; why_en="$ovis_app_why_en"; why_ko="$ovis_app_why_ko" ;;
      *) env_can=1 ;;
    esac
    if [ "$env_can" != 1 ]; then
      fail "WHOSUP_ENV=$env_pick cannot be installed on this computer: $why_en. Nothing was installed. Set WHOSUP_ENV to another one (herdr-app, ovis-app or herdr), or get it yourself: $(env_docs "$env_pick")" \
        "WHOSUP_ENV=$env_pick: 이 컴퓨터에는 설치할 수 없습니다. $why_ko. 아무것도 설치하지 않았습니다. WHOSUP_ENV를 다른 값(herdr-app, ovis-app, herdr)으로 주거나 직접 받으세요: $(env_docs "$env_pick")"
    fi
    # 그 앱이 이미 놓여 있으면(한 번도 켜지 않은 앱) 다시 깔지 않고 그 앱에 붙인다 — 자동 감지와 같다(아래 attach_here). 전에는 이 갈래가
    # env_here를 비워 둔 채 돌아가, ~/Applications의 Ovis 앱은 "이미 있다"로 실패하고 /Applications의 것은 둘째 사본을 받았다.
    # 다만 Herdr 앱이 놓여 있는데 그 코어(herdr-core)가 없으면(앞 설치가 코어에서 멈춘 채 남은 것) 붙을 수 있는 앱이 아니다: 직접 고른 값이므로
    # 그 앱의 설치기를 다시 돌린다(자동 감지는 코어만 채우려 한다 — 그것이 안 됐을 때 사람이 쓰는 길이 이 값이다).
    case "$env_pick" in
      herdr-app)
        if env_here="$(herdr_app_at)" && ! herdr_core_at; then
          say "the Herdr app is on this computer ($env_here) but its core, herdr-core, is not: installing the Herdr app again (WHOSUP_ENV=herdr-app)" \
            "Herdr 앱이 이 컴퓨터에 있는데($env_here) 그 코어(herdr-core)가 없습니다: Herdr 앱을 다시 설치합니다(WHOSUP_ENV=herdr-app)"
          env_here=""; return 0
        fi ;;
      ovis-app) env_here="$(ovis_app_at)" || env_here="" ;;
    esac
    if [ -n "$env_here" ]; then attach_here; return 0; fi
    # herdr를 고른 경우의 진행 줄은 install_herdr가 찍는다("herdr가 없습니다: 먼저 herdr를 … 설치합니다") — 같은 말을 두 번 하지 않는다
    [ "$env_pick" = herdr ] || say "nothing to run sessions in is here yet: installing $(env_name "$env_pick") first (WHOSUP_ENV=$env_pick)" "세션을 띄울 환경이 아직 없습니다: 먼저 $(env_name "$env_pick")부터 설치합니다(WHOSUP_ENV=$env_pick)"
    return 0
  fi
  # 한 번도 켜지 않은 앱이 이미 놓여 있다(코어 흔적이 없어 위의 길 고르기가 보지 못했다): 묻지 않고 그 앱에 붙인다
  if env_here="$(herdr_app_at)"; then env_pick=herdr-app
  elif env_here="$(ovis_app_at)"; then env_pick=ovis-app
  else env_here=""
  fi
  if [ -n "$env_here" ]; then attach_here; return 0; fi
  # 화면이 없는 리눅스(no_screen): 데스크톱 앱을 깔아도 여기서는 열 수 없다 — 기본값으로도, 질문으로도 앱을 내놓지 않고 터미널용 herdr로 간다.
  # 앱을 깔 수 있는 기계일 때만 이 줄을 찍는다(프로세서·도구 때문에 어차피 못 까는 기계는 아래의 "두 앱 모두 설치할 수 없습니다"가 그 이유를 말한다).
  if [ "$env_default" != herdr ] && no_screen; then
    env_pick=herdr
    apps_en=""; apps_ko=""
    if [ "$can_herdr_app" = 1 ]; then apps_en="herdr-app"; apps_ko="herdr-app"; fi
    if [ "$can_ovis_app" = 1 ]; then apps_en="${apps_en:+$apps_en or }ovis-app"; apps_ko="${apps_ko:+$apps_ko 또는 }ovis-app"; fi
    say "nothing to run sessions in is here yet, and no desktop is open in this session (DISPLAY and WAYLAND_DISPLAY are not set), so a desktop app could not be opened from here: herdr, for the terminal, is installed (to install an app anyway, set WHOSUP_ENV=$apps_en)" \
      "세션을 띄울 환경이 아직 없고 이 세션에는 데스크톱 화면이 없어(DISPLAY·WAYLAND_DISPLAY 없음) 데스크톱 앱을 깔아도 여기서 열 수 없습니다: 터미널용 herdr를 설치합니다(그래도 앱을 깔려면 이 값을 주세요: WHOSUP_ENV=$apps_ko)"
    return 0
  fi
  env_pick="$env_default"
  # 고를 것이 둘 이상일 때만 묻는다(앱이 하나도 안 되는 기계는 터미널뿐이다)
  if [ "$env_default" != herdr ] && can_ask; then
    ask_env
    return 0
  fi
  if [ "$env_default" = herdr-app ]; then
    say "nothing to run sessions in is here yet: installing the Herdr app first (the default when nothing is asked. To choose, set WHOSUP_ENV=herdr-app, ovis-app or herdr)" \
      "세션을 띄울 환경이 아직 없습니다: 먼저 Herdr 앱부터 설치합니다(묻지 않을 때의 기본값입니다. 직접 정하려면 WHOSUP_ENV=herdr-app, ovis-app, herdr 중 하나를 주세요)"
  elif [ "$env_default" = ovis-app ]; then
    say "nothing to run sessions in is here yet: installing the Ovis app first ($herdr_app_why_en. To choose, set WHOSUP_ENV=ovis-app or herdr)" \
      "세션을 띄울 환경이 아직 없습니다: 먼저 Ovis 앱부터 설치합니다($herdr_app_why_ko. 직접 정하려면 WHOSUP_ENV=ovis-app 또는 herdr를 주세요)"
  else
    say "nothing to run sessions in is here yet, and neither app can be installed on this computer ($herdr_app_why_en; $ovis_app_why_en): herdr, for the terminal, is installed" \
      "세션을 띄울 환경이 아직 없고 이 컴퓨터에는 두 앱 모두 설치할 수 없습니다($herdr_app_why_ko. $ovis_app_why_ko): 터미널용 herdr를 설치합니다"
  fi
}

# ── 고른 앱 깔기 ──
# 다른 설치기는 입력 없이(표준 입력 /dev/null · 새 세션이라 제어 터미널도 없다) 시간 제한을 두고 돌린다. 그 출력은 기록 파일에 모아 두었다가
# 실패했을 때만 보여 준다. 제한을 넘기면 그 프로세스 묶음을 끝내고(SIGTERM, 3초 뒤 SIGKILL) 124. 이 설치기가 신호를 받으면 같이 끝낸다(130).
# 그 설치기가 쓰는 임시 폴더(TMPDIR)는 이 실행만 쓰는 폴더 안이다: 끊긴 설치기가 받다 만 파일을 남겨도 그 폴더째 치운다.
RUN_JS='
const cp = require("child_process"), fs = require("fs");
const [limit, log, cmd] = process.argv.slice(1);
const out = fs.openSync(log, "a");
const child = cp.spawn("sh", ["-c", cmd], { detached: true, stdio: ["ignore", out, out] });
let why = 0, hard = null;
const signal = (s) => { try { process.kill(-child.pid, s) } catch {} };
const stop = (code) => { if (why) return; why = code; signal("SIGTERM"); hard = setTimeout(() => { signal("SIGKILL"); process.exit(code) }, 3000) };
const timer = setTimeout(() => stop(124), Math.max(1, Number(limit) || 900) * 1000);
for (const s of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(s, () => stop(130));
child.on("error", () => { clearTimeout(timer); process.exit(127) });
child.on("close", (code) => { clearTimeout(timer); clearTimeout(hard); process.exit(why || (code === null ? 1 : code)) });
'
# 체크섬: 릴리스의 체크섬 파일(latest-*.yml — 맥 것은 JSON 모양, 리눅스 것은 YAML)에서 그 파일 이름의 sha512(base64)를 찾아 받은 파일과 견준다.
# 0 = 같다 · 1 = 다르다 · 2 = 체크섬 파일에 그 이름이 없다(또는 읽지 못했다).
SUM_JS='
const fs = require("fs"), crypto = require("crypto");
const [feed, name, file] = process.argv.slice(1);
let want = "";
try {
  const text = fs.readFileSync(feed, "utf8");
  const bare = (s) => String(s).trim().replace(/^["\x27]|["\x27]$/g, "");
  try {
    const o = JSON.parse(text);
    const hit = (Array.isArray(o.files) ? o.files : []).find((f) => f && f.url === name);
    want = hit ? String(hit.sha512 || "") : o.path === name ? String(o.sha512 || "") : "";
  } catch {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length && !want; i++) {
      const m = /^\s*-?\s*url:\s*(.+)$/.exec(lines[i]);
      if (!m || bare(m[1]) !== name) continue;
      for (let j = i + 1; j < lines.length && !/^\s*-\s/.test(lines[j]) && /^\s/.test(lines[j]); j++) { const s = /^\s*sha512:\s*(.+)$/.exec(lines[j]); if (s) { want = bare(s[1]); break } }
    }
  }
} catch {}
if (!/^[A-Za-z0-9+\/]{86}==$/.test(want)) process.exit(2);
const hash = crypto.createHash("sha512"), fd = fs.openSync(file, "r"), buf = Buffer.alloc(1 << 20);
for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) hash.update(buf.subarray(0, n));
process.exit(hash.digest("base64") === want ? 0 : 1);
'
# 이 실행만 쓰는 임시 폴더(env_tmp — 받은 설치 스크립트·파일, 다른 설치기의 TMPDIR, 출력 기록)와 앱을 풀어 보는 폴더(env_stage). 끝나면(성공·실패·신호) 치운다.
env_tmp=""; env_stage=""; env_log=""
env_clean() {
  ui_restore
  case "$env_stage" in */.whosup-env-?*) rm -rf "$env_stage" ;; esac
  case "$env_tmp" in */whosup-env-?*) rm -rf "$env_tmp" ;; esac
  env_stage=""; env_tmp=""
}
env_begin() {
  case "${WHOSUP_ENV_TIMEOUT:-}" in '' | *[!0-9]* | 0* | ??????*) env_limit=900 ;; *) env_limit="$WHOSUP_ENV_TIMEOUT" ;; esac
  tmp_root="${TMPDIR:-/tmp}"
  env_tmp="$(node_js "$TMPDIR_JS" "${tmp_root%/}/whosup-env-" </dev/null 2>/dev/null)" || env_tmp=""
  case "$env_tmp" in /*/whosup-env-?*) ;; *) env_tmp=""; fail "could not create a temporary folder in $tmp_root. Nothing was installed." "$tmp_root 에 임시 폴더를 만들지 못했습니다. 아무것도 설치하지 않았습니다." ;; esac
  mkdir "$env_tmp/t" || fail "could not create a temporary folder in $tmp_root. Nothing was installed." "$tmp_root 에 임시 폴더를 만들지 못했습니다. 아무것도 설치하지 않았습니다."
  env_log="$env_tmp/output.log"
  : > "$env_log"
  trap 'node_rc=$?; env_clean; unlock; node_settle' EXIT
  trap 'env_clean; exit 129' HUP
  trap 'env_clean; exit 130' INT
  trap 'env_clean; exit 143' TERM
}
env_end() { env_clean; node_traps; }
# run_quiet <명령>: 위의 방식으로 돌린다(출력은 env_log에). 종료 코드는 그 명령의 것, 시간 초과는 124.
run_quiet() { WHOSUP_JS="$NODE_JS_PRE$RUN_JS" TMPDIR="$env_tmp/t" node -e 'eval(process.env.WHOSUP_JS)' "$env_limit" "$env_log" "$1" </dev/null >/dev/null 2>&1; }
# fetch_to <파일> <주소>: 받는다(시간 제한, 실패하면 1 — 오류는 env_log에). 받다 만 파일은 env_tmp 안이라 함께 치워진다.
# 주소는 https만 받는다(돌려보내는 곳도 https만 — --proto-redir): 앱 설치기·릴리스 파일은 TLS만이 출처를 보증한다. 시험이 127.0.0.1의 http
# 서버를 릴리스 주소로 줄 때만 http를 함께 연다(CURL_PROTO — 주소가 http://127.0.0.1 로 시작할 때뿐이다).
curl_proto() { case "$1" in http://127.0.0.1:* | http://127.0.0.1/*) CURL_PROTO='=http,https' ;; *) CURL_PROTO='=https' ;; esac; }
fetch_to() { curl_proto "$2"; curl -fsSL --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" --connect-timeout 30 --max-time "$env_limit" -o "$1" "$2" </dev/null >> "$env_log" 2>&1; }
# 앱을 깔지 못했다: 그 설치기가 한 말(있으면)을 보여 주고, 무엇이 안 됐는지와 직접 받는 곳을 알린 뒤 1로 끝낸다. 임시 폴더는 EXIT에서 치운다.
# env_fail <환경> <무엇이 안 됐나(영어)> <한국어>
env_fail() {
  ui_break
  if [ -s "$env_log" ]; then cat "$env_log" >&2; fi
  fail "$(env_name "$1") was not installed: $2. Get it yourself ($(env_docs "$1")), then run this installer again. whosup was not installed." \
    "$(env_name "$1")을 설치하지 못했습니다: $3. 직접 받아 설치한 뒤($(env_docs "$1")) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다."
}
# 종료 코드를 말로: 시간 초과(124)는 그 사실을, 그 밖에는 코드를.
ended_en() { if [ "$1" = 124 ]; then printf 'did not finish within %s s and was stopped' "$env_limit"; else printf 'ended with %s' "$1"; fi; }
ended_ko() { if [ "$1" = 124 ]; then printf '%s초 안에 끝나지 않아 멈췄습니다' "$env_limit"; else printf '종료 코드 %s' "$1"; fi; }
# 내려받은 설치 스크립트인가: 비어 있지 않고 첫 줄이 #! 로 시작한다(오류 페이지·끊긴 파일을 돌리지 않는다).
looks_like_script() { [ -s "$1" ] && case "$(sed -n 1p "$1" 2>/dev/null)" in '#!'*) return 0 ;; *) return 1 ;; esac; }

# Herdr 앱: 공식 설치기(파일로 받아 확인한 뒤 돌린다 — 파이프로 돌리면 받다 끊겨도 0으로 끝난다). 그 설치기는 종료 코드가 0이어도 아무것도
# 놓지 않았을 수 있다(내려받기 실패·코어 설치기 없음): 끝난 뒤 앱과 코어(herdr-core)가 정말 놓였는지 본다. 코어만 빠졌으면 코어 설치기를 한 번 더 돌린다.
install_herdr_app() {
  env_begin
  releases="${HERDR_RELEASES_URL:-$HERDR_RELEASES}"
  if [ -z "$env_here" ]; then
    if [ "$ui" = rich ]; then ui_step run "downloading Herdr app" "Herdr 앱 내려받는 중"
    else say "installing the Herdr app (no administrator password, nothing is asked)" "Herdr 앱을 설치합니다(관리자 암호가 필요 없고 아무것도 묻지 않습니다)"
    fi
    ran=0
    if [ -n "${WHOSUP_HERDR_APP_INSTALL_CMD:-}" ]; then
      run_quiet "$WHOSUP_HERDR_APP_INSTALL_CMD" || ran=$?
    else
      if ! fetch_to "$env_tmp/herdr-app-install.sh" "$releases/app/install.sh" || ! looks_like_script "$env_tmp/herdr-app-install.sh"; then
        env_fail herdr-app "its installer could not be downloaded from $releases" "$releases 에서 설치 스크립트를 받지 못했습니다"
      fi
      run_quiet "sh $(quote "$env_tmp/herdr-app-install.sh")" || ran=$?
    fi
    if ! env_here="$(herdr_app_at)"; then
      env_here=""
      env_fail herdr-app "its installer $(ended_en "$ran") and the app is not in place" "설치 스크립트가 끝났는데($(ended_ko "$ran")) 앱이 놓이지 않았습니다"
    fi
    env_installed=herdr-app
  fi
  # 코어 확인: 방금 깐 앱이든, 이미 놓여 있던 앱이든(앞 설치가 코어에서 멈춘 채 남은 앱 — 다시 돌린 설치기가 그것을 "정상 설치"로 받지 않는다).
  core_added=0
  if ! herdr_core_at && [ -z "${WHOSUP_HERDR_APP_INSTALL_CMD:-}" ]; then
    # 코어만 빠졌다: 코어 설치기를 같은 방식으로 한 번 더
    if fetch_to "$env_tmp/herdr-core-install.sh" "$releases/core/install.sh" && looks_like_script "$env_tmp/herdr-core-install.sh"; then
      run_quiet "HC_INSTALL_DIR=$(quote "$HOME/.local/bin") sh $(quote "$env_tmp/herdr-core-install.sh")" || true
    fi
    if herdr_core_at; then core_added=1; fi
  fi
  if ! herdr_core_at; then
    if [ "$env_installed" = herdr-app ]; then
      env_fail herdr-app "the app is in place ($env_here) but its core, herdr-core, is not, so it cannot run sessions" "앱은 놓였는데($env_here) 그 코어(herdr-core)가 놓이지 않아 세션을 띄울 수 없습니다"
    fi
    # 이미 놓여 있던 앱: "앱을 설치하지 못했습니다"가 아니라 코어를 채우지 못했다고 알린다
    ui_break
    if [ -s "$env_log" ]; then cat "$env_log" >&2; fi
    fail "the Herdr app is on this computer ($env_here) but its core, herdr-core, is not and could not be installed, so the app cannot run sessions. Install the Herdr app again yourself ($HERDR_APP_DOCS), then run this installer again. whosup was not installed." \
      "Herdr 앱은 이 컴퓨터에 있는데($env_here) 그 코어(herdr-core)가 없고 설치하지도 못해 세션을 띄울 수 없습니다. Herdr 앱을 직접 다시 설치한 뒤($HERDR_APP_DOCS) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다."
  fi
  env_app="$env_here"
  env_end
  if [ "$ui" = rich ]; then
    if [ "$env_installed" = herdr-app ]; then ui_step ok "Herdr app installed" "Herdr 앱 설치"
    elif [ "$core_added" = 1 ]; then ui_step ok "herdr-core (app core) installed" "Herdr 앱의 코어(herdr-core) 설치"
    fi
  elif [ "$env_installed" = herdr-app ]; then say "the Herdr app is installed: $env_app" "Herdr 앱을 설치했습니다: $env_app"
  elif [ "$core_added" = 1 ]; then say "herdr-core, the core of the Herdr app, is installed" "Herdr 앱의 코어(herdr-core)를 설치했습니다"
  fi
  # 그 설치기가 명령을 놓는 폴더: 이어지는 자동 감지가 herdr-app을 찾게 한다
  case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) PATH="$PATH:$HOME/.local/bin"; export PATH ;; esac
}

# Ovis 앱: 공식 릴리스의 파일을 받아 체크섬(그 릴리스의 체크섬 파일)을 견준 뒤 놓는다. 판을 먼저 정해(…/latest가 가리키는 태그) 파일과 체크섬 파일이
# 같은 판에서 오게 한다. 풀고 확인하는 동안에는 놓을 폴더 안의 숨은 임시 폴더를 쓴다(같은 디스크 — 제자리에 놓는 것은 이름 바꾸기 한 번이다).
# 실패하면 1 과 이유(why_en · why_ko). 받다 만 파일·풀다 만 폴더는 env_clean이 치운다.
ovis_tag() {
  curl_proto "$1"
  tag="$(curl -fsSI --proto "$CURL_PROTO" --proto-redir "$CURL_PROTO" --connect-timeout 30 --max-time 60 "$1/latest" </dev/null 2>> "$env_log" | tr -d '\r' | sed -n 's/^[Ll][Oo][Cc][Aa][Tt][Ii][Oo][Nn]: .*\/tag\/\([A-Za-z0-9._-][A-Za-z0-9._-]*\)$/\1/p' | sed -n '$p')"
  [ -n "$tag" ]
}
ovis_stage() {
  mkdir -p "$1" 2>> "$env_log" || return 1
  env_stage="$(node_js "$TMPDIR_JS" "$1/.whosup-env-" </dev/null 2>> "$env_log")" || env_stage=""
  case "$env_stage" in "$1"/.whosup-env-?*) return 0 ;; *) env_stage=""; return 1 ;; esac
}
ovis_get() {
  releases="${WHOSUP_OVIS_RELEASES_URL:-$OVIS_RELEASES}"
  if ! ovis_tag "$releases"; then why_en="the latest release could not be read from $releases"; why_ko="$releases 에서 최신 릴리스를 읽지 못했습니다"; return 1; fi
  base="$releases/download/$tag"
  if [ "$os" = Darwin ]; then asset="Ovis-mac-$cpu.zip"; feed="latest-mac.yml"; dest_dir="$HOME/Applications"; dest="$dest_dir/Ovis.app"
  else asset="Ovis-linux-$cpu.AppImage"; feed="latest-linux.yml"; [ "$cpu" != arm64 ] || feed="latest-linux-arm64.yml"; dest_dir="$ovis_dir"; dest="$dest_dir/$asset"
  fi
  if [ -e "$dest" ] || [ -L "$dest" ]; then why_en="$dest is already there and was left as it is"; why_ko="그 자리($dest)에 이미 무엇인가 있어 그대로 두었습니다"; return 1; fi
  if ! ovis_stage "$dest_dir"; then why_en="could not write to $dest_dir"; why_ko="$dest_dir 폴더에 쓰지 못했습니다"; return 1; fi
  if ! fetch_to "$env_stage/$asset" "$base/$asset" || ! fetch_to "$env_tmp/$feed" "$base/$feed"; then
    why_en="$asset ($tag) could not be downloaded from $releases"; why_ko="$releases 에서 $asset($tag)을 받지 못했습니다"; return 1
  fi
  sum=0
  node_js "$SUM_JS" "$env_tmp/$feed" "$asset" "$env_stage/$asset" </dev/null >> "$env_log" 2>&1 || sum=$?
  if [ "$sum" != 0 ]; then
    why_en="the downloaded $asset does not match the checksum its release gives ($feed), so it was not kept"; why_ko="받은 파일($asset)이 그 릴리스의 체크섬($feed)과 달라 남기지 않았습니다"; return 1
  fi
  if [ "$os" = Darwin ]; then
    # 풀고, 서명을 본다: 서명이 온전하고 · macOS가 공증된 Developer ID 앱으로 받아들이고 · 서명한 팀이 Ovis의 개발자다. 하나라도 아니면 놓지 않는다.
    if ! /usr/bin/ditto -x -k "$env_stage/$asset" "$env_stage/x" >> "$env_log" 2>&1 || [ ! -d "$env_stage/x/Ovis.app" ]; then
      why_en="the downloaded $asset could not be unpacked"; why_ko="받은 파일($asset)을 풀지 못했습니다"; return 1
    fi
    if ! /usr/bin/codesign --verify --deep --strict "$env_stage/x/Ovis.app" >> "$env_log" 2>&1 \
      || ! /usr/sbin/spctl -a -vv "$env_stage/x/Ovis.app" 2>&1 | tee -a "$env_log" | grep -q 'source=Notarized Developer ID' \
      || ! /usr/bin/codesign -dv "$env_stage/x/Ovis.app" 2>&1 | grep -q "^TeamIdentifier=$OVIS_TEAM_ID\$"; then
      why_en="the downloaded app is not signed and notarized by the Ovis developer, so it was not kept"; why_ko="받은 앱이 Ovis 개발자가 서명·공증한 것이 아니어서 남기지 않았습니다"; return 1
    fi
    if [ -e "$dest" ] || [ -L "$dest" ] || ! mv "$env_stage/x/Ovis.app" "$dest" 2>> "$env_log"; then why_en="could not put the app into $dest_dir"; why_ko="앱을 $dest_dir 에 놓지 못했습니다"; return 1; fi
  else
    if ! chmod 755 "$env_stage/$asset" 2>> "$env_log" || ! mv "$env_stage/$asset" "$dest" 2>> "$env_log"; then why_en="could not put the app into $dest_dir"; why_ko="앱을 $dest_dir 에 놓지 못했습니다"; return 1; fi
    # 앱 목록에 보이게 실행기 항목을 둔다(이미 있으면 건드리지 않는다)
    entry="${data_home:-$HOME/.local/share}/applications/ovis.desktop"
    if [ ! -e "$entry" ] && mkdir -p "${entry%/*}" 2>/dev/null; then
      printf '[Desktop Entry]\nName=Ovis\nExec="%s" %%U\nTerminal=false\nType=Application\nIcon=ovis\nStartupWMClass=ovis\nCategories=Development;\n' "$(dq "$dest")" > "$entry" 2>/dev/null || true
    fi
  fi
  return 0
}
# new_in <폴더> <전에 있던 이름들(한 줄에 하나)>: 그 폴더에 새로 생긴 첫 항목의 경로를 찍는다. 없으면 1.
new_in() {
  for new_path in "$1"/*; do
    if [ ! -e "$new_path" ] && [ ! -L "$new_path" ]; then continue; fi
    if ! printf '%s\n' "$2" | grep -Fxq -- "${new_path##*/}"; then printf '%s' "$new_path"; return 0; fi
  done
  return 1
}
install_ovis_app() {
  env_begin
  if [ -z "$env_here" ]; then
    if [ "$ui" = rich ]; then ui_step run "downloading Ovis app (about 175 MB)" "Ovis 앱 내려받는 중 (약 175MB)"
    else say "installing the Ovis app (a download of about 175 MB; no administrator password, nothing is asked)" "Ovis 앱을 설치합니다(약 175MB를 내려받습니다. 관리자 암호가 필요 없고 아무것도 묻지 않습니다)"
    fi
    if [ -n "${WHOSUP_OVIS_APP_INSTALL_CMD:-}" ]; then
      # 대역 설치 명령: 0으로 끝나고, 앱이 놓이는 폴더에 전에 없던 것이 생겼어야 한다(그 이름이 Ovis가 아니어도 된다 — 무엇을 놓을지는 그 명령이 정한다)
      if [ "$os" = Darwin ]; then dest_dir="$HOME/Applications"; else dest_dir="$ovis_dir"; fi
      before="$(ls "$dest_dir" 2>/dev/null || true)"
      ran=0
      run_quiet "$WHOSUP_OVIS_APP_INSTALL_CMD" || ran=$?
      [ "$ran" = 0 ] || env_fail ovis-app "its installer $(ended_en "$ran")" "설치 명령이 실패했습니다($(ended_ko "$ran"))"
      if ! env_here="$(ovis_app_at)" && ! env_here="$(new_in "$dest_dir" "$before")"; then env_here=""; fi
      [ -n "$env_here" ] || env_fail ovis-app "its installer ended with 0 and nothing new is in $dest_dir" "설치 명령은 0으로 끝났는데 $dest_dir 에 새로 놓인 것이 없습니다"
    else
      ovis_get || env_fail ovis-app "$why_en" "$why_ko"
      env_here="$dest"
    fi
    env_installed=ovis-app
  fi
  env_app="$env_here"
  env_end
  if [ "$env_installed" = ovis-app ]; then
    if [ "$ui" = rich ]; then ui_step ok "Ovis app installed (about 175 MB)" "Ovis 앱 설치 (약 175MB)"
    else say "the Ovis app is installed: $env_app" "Ovis 앱을 설치했습니다: $env_app"
    fi
  fi
}

# rich 화면의 플러그인 길 요약: ✓ 끝났다 → 다음에 할 일(가장 먼저) → 설치한 것 → 알아 둘 것 → (이미 깔려 있었으면) 명령 → 설정 바꾸는 곳.
# 같은 사실을 plain 요약(plugin_board_lines · path_hint · standalone_note)과 같은 판정으로 말한다. 칠 명령은 그대로 쳐서 되는 모양이다:
# 집 폴더 안의 herdr 경로는 ~/… (따옴표로 싸지 않아도 되는 경로일 때만), PATH에 넣는 줄은 "$HOME/…".
# 인자: already = 이미 플러그인으로 깔려 있어 다시 깔지 않았다.
plugin_summary_rich() {
  url="http://127.0.0.1:$board_port"
  ui_herdr="$HERDR_SAY"
  if [ -n "$HERDR_OFF_PATH" ] && [ "$HERDR_SAY" = "${herdr_at:-}" ]; then ui_herdr="$(ui_path "$herdr_at")"; fi
  ui_add blank
  if [ "${1:-}" = already ]; then ui_add done "$(pick "whosup is already installed as a herdr plugin" "whosup은 이미 herdr 플러그인으로 설치돼 있습니다")"
  else ui_add done "$(pick "whosup is installed" "whosup 설치를 마쳤습니다")"
  fi
  ui_add blank
  ui_add title "$(pick "Next" "다음에 할 일")"
  if [ "$board_state" = up ]; then
    if [ "$board_browser" = opens ]; then ui_add item "$(pick "The board is running. See it in your browser:" "보드가 켜져 있습니다. 브라우저에서 보세요:")"
    else ui_add item "$(pick "The board is running. Open this address in a browser on this computer:" "보드가 켜져 있습니다. 이 컴퓨터의 브라우저에서 아래 주소를 여세요:")"
    fi
    ui_add cmd "$url"
    if [ "$board_browser" = remote ]; then
      ui_add item "$(pick "From another device, forward the port first:" "다른 기기에서 보려면 먼저 포트를 넘기세요:")"
      ui_add cmd "ssh -L $board_port:127.0.0.1:$board_port <host>"
    fi
  elif [ "$herdr_state" = on ]; then
    ui_add item "$(pick "herdr is running. To start the board now, type this in a terminal inside herdr:" "herdr가 켜져 있습니다. 보드를 지금 띄우려면 herdr 안의 터미널에 아래를 치세요:")"
    ui_add cmd "$ui_herdr plugin action invoke $PLUGIN_ID.start"; herdr_typed=1
  else
    ui_add item "$(pick "Type this in a terminal and press Enter. When herdr starts, the board starts with it." "터미널에 아래를 치고 Enter를 누르세요. herdr가 켜지면 보드도 같이 뜹니다.")"
    ui_add cmd "$ui_herdr"; herdr_typed=1
  fi
  ui_add blank
  ui_add title "$(pick "Installed" "설치한 것")"
  ui_add kv whosup "$(pick "herdr plugin ($PLUGIN_ID)" "herdr 플러그인 ($PLUGIN_ID)")"
  [ "$herdr_installed" != 1 ] || ui_add kv herdr "${herdr_version:-?} $ui_s_dot $(ui_path "$HERDR_DIR/herdr")"
  if [ "$board_state" = up ]; then ui_add kv "$(pick "board" "보드")" "$(pick "$url $ui_s_dot starts whenever herdr starts" "$url $ui_s_dot herdr를 켤 때마다 같이 뜹니다")"
  else ui_add kv "$(pick "board" "보드")" "$(pick "starts whenever herdr starts $ui_s_dot $url (next port if taken)" "herdr를 켤 때마다 같이 뜹니다 $ui_s_dot $url (사용 중이면 다음 포트)")"
  fi
  ui_notes=0
  # 알아 둘 것: 제목은 처음 한 번, 항목(item)끼리는 빈 줄로 띄운다
  ui_note() {
    if [ "$ui_notes" = 0 ]; then ui_add blank; ui_add title "$(pick "Good to know" "알아 둘 것")"; ui_notes=1
    elif [ "$1" = item ]; then ui_add blank
    fi
    ui_add "$@"
  }
  if [ "$board_state" != up ] && [ "$board_browser" != opens ]; then
    ui_note item "$(pick "No browser opens by itself here. When the board is running, open its address on this computer." "여기서는 브라우저가 저절로 열리지 않습니다. 보드가 켜지면 이 컴퓨터에서 그 주소를 여세요.")"
    if [ "$board_browser" = remote ]; then
      ui_note item "$(pick "From another device, forward the port first:" "다른 기기에서 보려면 먼저 포트를 넘기세요:")"
      ui_note cmd "ssh -L $board_port:127.0.0.1:$board_port <host>"
    fi
  fi
  if [ -n "$HERDR_OFF_PATH" ] && [ "$herdr_typed" = 1 ]; then
    ui_note item "$(pick "$(ui_path "$HERDR_OFF_PATH") is not on your PATH, so herdr is written with its full path above (it runs as typed). To type just herdr in terminals you open from now on, type this once:" "$(ui_path "$HERDR_OFF_PATH") 폴더가 PATH에 없어 위에서는 herdr를 전체 경로로 적었습니다(그대로 치면 됩니다). 새로 여는 터미널부터 herdr만 쳐도 되게 하려면 아래를 한 번 치세요:")"
    # path_hint와 같은 줄이되, 집 폴더 안이면 "$HOME/…"으로 적는다($HOME은 셸 설정 파일에 그대로 적히고 그 파일을 읽을 때 펼쳐진다)
    case "$HERDR_OFF_PATH" in
      "$HOME"/*) rc_line="export PATH=\"\$HOME/$(dq "${HERDR_OFF_PATH#"$HOME"/}"):\$PATH\"" ;;
      *) rc_line="export PATH=\"$(dq "$HERDR_OFF_PATH"):\$PATH\"" ;;
    esac
    case "$rc_line" in
      *\\*) ui_note cmd "printf '%s\\n' $(quote "$rc_line") >> $(shell_rc)" ;;
      *) ui_note cmd "echo $(quote "$rc_line") >> $(shell_rc)" ;;
    esac
  fi
  if [ "$have_standalone" = 1 ]; then
    ui_note item "$(pick "A standalone whosup is also installed here ($(ui_path "$APP")). To remove it, type this in a terminal:" "단독으로 설치한 whosup도 있습니다($(ui_path "$APP")). 지우려면 터미널에 아래를 치세요:")"
    ui_note cmd "whosup uninstall"
  fi
  if [ "${1:-}" != already ] && [ "${setup_spoke:-1}" != 1 ]; then
    ui_note item "$(pick "First-run setup: nothing was asked during this install. The board asks on first open (not if you have been through it before)." "첫 실행 안내: 이번 설치에서는 묻지 않았습니다. 보드를 처음 열 때 묻습니다(전에 마친 적이 있으면 묻지 않습니다).")"
  fi
  if [ "${1:-}" = already ]; then
    ui_add blank
    ui_add title "$(pick "Commands" "명령")"
    ui_add item "$(pick "To install it again (an update), type this in a terminal:" "다시 설치(업데이트)하려면 터미널에 아래를 치세요:")"
    ui_add cmd "$ui_herdr plugin install $REPO --yes"
  fi
  ui_add blank
  ui_add foot "$(pick "Change settings in the board's settings." "설정은 보드의 설정 화면에서 바꿉니다.")"
  ui_flush
}

# ── 길 (가): herdr 플러그인 ──
install_plugin() {
  if [ "$plugin_listed" = 1 ]; then
    [ "$ui" = rich ] || say "already installed as a herdr plugin ($PLUGIN_ID): nothing is installed again" "이미 herdr 플러그인($PLUGIN_ID)으로 설치돼 있습니다: 다시 설치하지 않습니다"
    plugin_board 0
    herdr_word
    if [ "$ui" = rich ]; then plugin_summary_rich already; return 0; fi
    echo
    line "whosup install summary" "whosup 설치 요약"
    line "  Already installed as a herdr plugin ($PLUGIN_ID). Nothing was installed again." "  이미 herdr 플러그인($PLUGIN_ID)으로 설치돼 있습니다. 다시 설치하지 않았습니다."
    plugin_board_lines
    standalone_note
    line "  To install it again (an update), type this in a terminal:" "  다시 설치(업데이트)하려면 터미널에 아래를 치세요:"
    printf '      %s plugin install %s --yes\n' "$HERDR_SAY" "$REPO"; herdr_typed=1
    path_hint
    line "  To change any setting, use settings in the board." "  설정을 바꾸려면 보드의 설정에서 바꿉니다."
    return 0
  fi
  [ "$herdr_found" = 1 ] || install_herdr
  if [ -n "$herdr_hung" ]; then
    fail "herdr is here but did not answer: $herdr_hung gave no answer within $herdr_limit s and was stopped. Check that herdr runs (type: herdr --version), then run this installer again. whosup was not installed." \
      "herdr가 있지만 응답하지 않습니다. ${herdr_limit}초 안에 끝나지 않아 멈춘 명령: $herdr_hung. herdr가 도는지 확인한 뒤(터미널에 herdr --version) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다."
  fi
  if [ "$herdr_ok" != 1 ]; then
    fail "needs herdr $HERDR_MIN or newer for plugins; this is ${herdr_version:-unknown}. Update herdr ($HERDR_DOCS), then run this installer again. whosup was not installed." \
      "플러그인을 쓰려면 herdr $HERDR_MIN 이상이 필요한데 지금은 ${herdr_version:-알 수 없음} 입니다. herdr를 올린 뒤($HERDR_DOCS) 이 설치 명령을 다시 실행하세요. whosup은 설치하지 않았습니다."
  fi
  source="${WHOSUP_INSTALL_SOURCE:-$REPO}"
  if [ "$ui" = rich ]; then
    [ "$herdr_installed" = 1 ] || ui_step ok "herdr $herdr_version found" "herdr $herdr_version 있음"
    # 그사이 첫 실행 안내(herdr가 build 훅으로 부른다)가 터미널에 질문을 찍을 수 있다: 그 안내는 처음 찍기 전에 이 줄을 끝내고 표식 파일을
    # 남긴다(WHOSUP_UI_OPEN, 아래). 표식이 없으면 아무것도 찍히지 않은 것이라 끝난 줄(✓)이 이 자리를 차지한다.
    ui_step run "installing whosup as a herdr plugin" "herdr 플러그인으로 whosup 설치 중"
  else say "herdr $herdr_version is here: installing whosup as a herdr plugin ($source)" "herdr $herdr_version 확인: whosup을 herdr 플러그인으로 설치합니다($source)"
  fi
  set -- plugin install "$source" --yes
  # GitHub에서 받을 때만 출시판을 고정한다(로컬 폴더 소스에는 ref가 없다)
  if [ -n "${WHOSUP_REF:-}" ]; then set -- "$@" --ref "$WHOSUP_REF"
  elif [ "$source" = "$REPO" ]; then set -- "$@" --ref "$RELEASE_REF"
  fi
  # 환경 고르기로 herdr를 방금 깔았다: 플러그인의 첫 실행 안내(scripts/setup.mjs — herdr가 build 훅으로 부른다)가 "herdr를 치세요"를 찍지 않게
  # 알린다. 그 안내는 아래 설치 요약의 "다음에 할 일"이 한 번만 말한다.
  if [ "$env_pick" = herdr ] && [ "$herdr_installed" = 1 ]; then WHOSUP_ENV_INSTALLED=herdr; export WHOSUP_ENV_INSTALLED; fi
  # 이 설치기가 부른 설치라는 것도 알린다(herdr를 방금 깔았든 아니든): 첫 실행 안내는 질문까지만 하고 마무리 문구(보드 주소 · "herdr를 치세요" ·
  # "herdr를 켤 때마다 보드가 뜹니다" · 바꾸는 곳)는 찍지 않는다 — 같은 안내를 아래 설치 요약이 한 번만 말한다(src/setup.mjs runSetup).
  # 첫 실행 안내가 터미널에서 말할 수 있었는가(setup_spoke): 없었으면(에이전트·스크립트·CI·WHOSUP_NO_SETUP) 요약이 "보드를 처음 열 때 묻는다"를 싣는다.
  WHOSUP_FROM_INSTALLER=1; export WHOSUP_FROM_INSTALLER
  setup_spoke=0
  if can_ask; then setup_spoke=1; fi
  # herdr가 찍는 것(설치 내역 미리보기 30여 줄 · "Installed …" · "Config: …")은 기록 파일에 모은다: 성공하면 한 줄로 줄이고, 실패하면 전부 보여 준다.
  # 첫 실행 안내의 질문은 제어 터미널(/dev/tty)에 직접 쓰므로 가려지지 않는다. 시간 제한은 두지 않는다(질문마다 제한이 있고 그 훅이 스스로 끝난다).
  env_begin
  plugin_status=0
  if [ "$ui" = rich ]; then WHOSUP_UI_OPEN="$env_tmp/tty-used"; export WHOSUP_UI_OPEN; fi
  herdr "$@" </dev/null >> "$env_log" 2>&1 || plugin_status=$?
  if [ "$ui" = rich ]; then
    [ ! -e "$WHOSUP_UI_OPEN" ] || ui_pending=0   # 첫 실행 안내가 진행 줄을 이미 끝냈다
    unset WHOSUP_UI_OPEN
  fi
  if [ "$plugin_status" != 0 ]; then
    ui_break
    if [ -s "$env_log" ]; then cat "$env_log" >&2; fi
    fail "herdr could not install the plugin; what it said is above. Fix that and run this installer again, or try: herdr plugin install $REPO --yes" \
      "herdr가 플러그인을 설치하지 못했습니다. 위에 그 출력이 있습니다. 고친 뒤 이 설치 명령을 다시 실행하거나 직접 해 보세요: herdr plugin install $REPO --yes"
  fi
  folded="$(grep -c '' "$env_log" 2>/dev/null)" || folded=0
  env_end
  if [ "$ui" = rich ]; then ui_step ok "whosup installed as a herdr plugin" "whosup을 herdr 플러그인으로 설치"
  elif [ "${folded:-0}" -gt 0 ] 2>/dev/null; then
    say "herdr installed the plugin (what it printed is not shown: $folded line(s))" "herdr가 플러그인을 설치했습니다(herdr가 찍은 ${folded}줄은 접었습니다)"
  else
    say "herdr installed the plugin" "herdr가 플러그인을 설치했습니다"
  fi
  # 보드는 설치 셋업의 도우미가 띄운다(herdr가 켜져 있을 때). 띄우지 않기로 한 설치는 기다리지 않는다.
  wait_s=8
  if on "${CI:-}" || on "${WHOSUP_NO_AUTOSTART:-}"; then wait_s=0; fi
  plugin_board "$wait_s"
  herdr_word
  if [ "$ui" = rich ]; then plugin_summary_rich; return 0; fi
  echo
  line "whosup install summary" "whosup 설치 요약"
  # "herdr를 켤 때마다 보드가 같이 뜬다"는 한 번만: 보드가 켜져 있으면 이 줄이, 아니면 아래 보드 줄이 말한다.
  if [ "$board_state" = up ]; then
    line "  Installed as a herdr plugin ($PLUGIN_ID). herdr starts the board whenever it starts." "  herdr 플러그인($PLUGIN_ID)으로 설치했습니다. herdr를 켤 때마다 보드가 같이 뜹니다."
  else
    line "  Installed as a herdr plugin ($PLUGIN_ID)." "  herdr 플러그인($PLUGIN_ID)으로 설치했습니다."
  fi
  [ "$herdr_installed" != 1 ] || line "  herdr ${herdr_version:-} was installed too, into $HERDR_DIR." "  herdr ${herdr_version:-} 도 $HERDR_DIR 에 설치했습니다."
  plugin_board_lines
  path_hint
  standalone_note
  # 첫 실행 안내가 터미널에서 이미 말했으면("직접 정한 값이 없습니다 …" · "고를 것이 없어 …") 되풀이하지 않는다.
  [ "$setup_spoke" = 1 ] || line "  First-run setup: nothing was asked during this install. The board asks on first open (not if you have been through it before)." "  첫 실행 안내: 이번 설치에서는 묻지 않았습니다. 보드를 처음 열 때 묻습니다(전에 마친 적이 있으면 묻지 않습니다)."
  line "  To change any of this, use settings in the board." "  바꾸려면 보드의 설정에서 바꿉니다."
}

# ── 길 (나): herdr 없이 단독 설치 ──
# 단독 설치가 있는가(installed): 설치 기록과 설치기의 표식이 한 쌍으로 맞아야 한다 — src/standalone.mjs readRecord와 같은 조건이다(둘을 같게 둔다).
#   설치 기록(<데이터 폴더>/install.json — 설치한 판의 scripts/standalone.mjs install이 쓴다)이 읽히고(보통 파일, 이 제품의 것, 폴더들이 절대 경로),
#   기록의 data·app이 지금 기대하는 자리(<데이터 폴더> · <데이터 폴더>/app)와 같고(링크를 푼 경로로 견준다), 앱 폴더가 링크가 아닌 폴더이고,
#   그 안에 표식 파일(MARK_FILE)이 보통 파일로 있고 첫 줄이 맞고, herdr-plugin.toml이 이 플러그인 id이고, scripts/standalone.sh가 그 폴더 안의
#   보통 파일이다(scripts도 standalone.sh도 링크가 아니다 — 링크면 폴더 밖의 스크립트를 돌리게 된다).
# 그 자리에 폴더·파일이 있다는 것만으로는, 기록만 또는 표식만 있는 것으로는 설치로 보지 않는다 — 남의 폴더의 스크립트를 돌리거나 그 폴더를 덮지 않는다.
RECORD_JS='
const fs = require("fs"), path = require("path");
const [data, app, id, markFile, markText] = process.argv.slice(1);
const abs = (v) => typeof v === "string" && path.isAbsolute(v) && !/[\x00-\x1f\x7f]/.test(v);
const real = (p) => { try { return fs.realpathSync(p) } catch { return path.resolve(p) } };
let ok = false;
try {
  const file = path.join(data, "install.json"), st = fs.lstatSync(file);
  const r = st.isFile() && st.size <= 65536 ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
  ok = Boolean(r) && typeof r === "object" && !Array.isArray(r) && r.product === "whosup" && ["data", "app", "conf", "state"].every((k) => abs(r[k]))
    && real(r.data) === real(data) && real(r.app) === real(app)
    && fs.lstatSync(app).isDirectory() && fs.lstatSync(path.join(app, markFile)).isFile()
    && fs.readFileSync(path.join(app, markFile), "utf8").split("\n")[0] === markText
    && fs.readFileSync(path.join(app, "herdr-plugin.toml"), "utf8").split(/\r?\n/).includes("id = \"" + id + "\"")
    && fs.lstatSync(path.join(app, "scripts")).isDirectory() && fs.lstatSync(path.join(app, "scripts", "standalone.sh")).isFile();
} catch {}
process.exit(ok ? 0 : 1);
'
installed() { node_js "$RECORD_JS" "$DATA" "$APP" "$PLUGIN_ID" "$MARK_FILE" "$MARK_TEXT" </dev/null >/dev/null 2>&1; }
# 설치기가 만든 폴더인가: 링크가 아닌 폴더이고, 표식 파일이 (링크가 아닌) 보통 파일이며 첫 줄이 맞다.
ours() {
  [ -d "$1" ] && [ ! -L "$1" ] && [ -f "$1/$MARK_FILE" ] && [ ! -L "$1/$MARK_FILE" ] && [ "$(sed -n 1p "$1/$MARK_FILE" 2>/dev/null)" = "$MARK_TEXT" ]
}
# mark <폴더>: 그 표식을 둔다(그 이름의 것이 이미 있으면 치우고 새로 쓴다 — 링크를 따라 쓰지 않는다). 둔 뒤 ours로 다시 본다:
# 표식을 만들지 못했으면 실패다 — 부른 쪽이 그 폴더를 제자리에 놓지 않는다.
mark() { rm -f "$1/$MARK_FILE" 2>/dev/null; printf '%s\n' "$MARK_TEXT" 2>/dev/null > "$1/$MARK_FILE" && ours "$1"; }
# 지우는 것은 설치기가 만든 app·app.new·app.old뿐이다: 이름이 맞고 표식이 든 폴더만(지우기 직전에 본다). 표식이 없으면(남의 폴더) 건드리지 않는다.
# 확인과 지우기 사이의 틈을 줄인다: 경로로 확인한 뒤 그 경로를 다시 열어 지우지 않는다(그 사이에 폴더가 바뀌면 남의 폴더를 지운다).
# 그 폴더 안으로 들어가(cd — 이때부터는 경로가 아니라 그 폴더 자체를 쥔다) 거기서 표식을 다시 보고, 그 안의 것을 지운 뒤(표식은 맨 나중에),
# 빈 폴더만 걷는다(rmdir — 그 사이에 그 이름이 다른 폴더가 됐으면 비어 있지 않아 걷히지 않는다).
wipe() {
  case "$1" in */whosup/app | */whosup/app.new | */whosup/app.old) ;; *) return 0 ;; esac
  ours "$1" || return 0
  (
    cd "$1" 2>/dev/null || exit 0
    ours . || exit 0
    for wipe_entry in ./* ./.[!.]* ./..?*; do
      [ "$wipe_entry" = "./$MARK_FILE" ] || rm -rf "$wipe_entry"
    done
    # 표식은 나머지가 다 지워졌을 때만 지운다: 지워지지 않는 것이 남은 폴더에서 표식부터 없애면 다음 실행이 그 폴더를 남의 것으로 본다
    for wipe_entry in ./* ./.[!.]* ./..?*; do
      if [ "$wipe_entry" != "./$MARK_FILE" ] && { [ -e "$wipe_entry" ] || [ -L "$wipe_entry" ]; }; then exit 0; fi
    done
    rm -f "./$MARK_FILE"
  )
  rmdir "$1" 2>/dev/null
  return 0
}
# mark_state <폴더>: 표식 파일에 적힌 상태 폴더(state=<절대 경로> 줄 — 그 폴더로 설치를 시작한 판이 무엇을 켜기 전에 적는다: src/standalone.mjs
# noteState). 줄이 없으면 빈 값. 줄은 있는데 절대 경로가 아니거나 제어 문자가 들었으면 "?"(믿을 수 없는 값 — 부른 쪽이 치우지 않고 알린다).
mark_state() {
  noted="$(sed -n 's/^state=//p' "$1/$MARK_FILE" 2>/dev/null | sed -n 1p)"
  if ! grep -q '^state=' "$1/$MARK_FILE" 2>/dev/null; then return 0; fi
  noted="$(abs_dir "$noted")"
  printf '%s' "${noted:-?}"
}
# $APP이 지금도 이 설치기가 다뤄도 되는 폴더인가 — 확인은 이 함수 하나다. 그 안의 스크립트를 돌리거나(status·stop·start·install·uninstall)
# 그 폴더를 옮기기 직전마다 다시 본다(처음 한 번 본 것을 믿지 않는다: 그 사이에 폴더가 바뀌었을 수 있다). 지우기 직전의 확인은 wipe가 한다.
#   새 버전으로 바꾸는 설치(kind=update): 설치 기록과 표식이 한 쌍으로 맞아야 한다(installed)
#   새 설치(kind=install — 방금 놓은 판): 설치 기록은 마지막 단계가 쓴다. 그 전에는 설치기의 표식(ours)을 본다
app_ok() { if [ "$kind" = update ]; then installed; else ours "$APP"; fi; }
# app_run <명령> [인자…]: 확인한 뒤 $APP의 scripts/standalone.sh를 돌린다. 확인에 실패하면 돌리지 않고 126.
app_run() { app_ok || return 126; sh "$APP/scripts/standalone.sh" "$@" </dev/null; }
COPY_JS='
const fs = require("fs"), path = require("path");
const [src, dst] = process.argv.slice(1);
const skip = new Set([".git", "node_modules", ".whosup", ".DS_Store"]);
fs.cpSync(src, dst, { recursive: true, filter: (p) => !skip.has(path.basename(p)) });
'
# 고유한 이름의 임시 폴더를 만들고 그 경로를 찍는다(mktemp -d 대신 — mktemp는 POSIX에 없고 node는 여기에 반드시 있다). 인자 = 이름의 앞부분.
TMPDIR_JS='process.stdout.write(require("fs").mkdtempSync(process.argv[1]))'
# 소스를 $1(app.new — 이미 만들어 둔 빈 폴더)로 받는다: 로컬 폴더(WHOSUP_INSTALL_SOURCE)면 복사, 아니면 GitHub에서 내려받는다(curl+tar, 없으면 git).
fetch_source() {
  dest="$1"
  if [ -n "${WHOSUP_INSTALL_SOURCE:-}" ]; then
    [ -f "$WHOSUP_INSTALL_SOURCE/herdr-plugin.toml" ] || return 1
    if [ "$ui" = rich ]; then ui_step run "copying whosup" "whosup 복사하는 중"
    else say "copying whosup from $WHOSUP_INSTALL_SOURCE" "$WHOSUP_INSTALL_SOURCE 에서 whosup을 복사합니다"
    fi
    node_js "$COPY_JS" "$WHOSUP_INSTALL_SOURCE" "$dest" </dev/null
    return $?
  fi
  ref="${WHOSUP_REF:-$RELEASE_REF}"
  if [ "$ui" = rich ]; then ui_step run "downloading whosup${ref:+ ($ref)}" "whosup${ref:+($ref)} 내려받는 중"
  else say "downloading whosup${ref:+ ($ref)} from github.com/$REPO" "github.com/$REPO 에서 whosup${ref:+($ref)}을 내려받습니다"
  fi
  if command -v curl >/dev/null 2>&1 && command -v tar >/dev/null 2>&1; then
    # 파일로 받아 curl의 종료 코드를 본 뒤에 푼다(curl | tar 는 curl이 실패해도 tar의 종료 코드만 남는다).
    # 받는 곳은 이 실행만 쓰는 임시 폴더다(mkdtemp: 무작위 이름, 0700 — 고정된 이름의 파일에 받지 않는다). 푼 뒤에는 남기지 않는다.
    tarball_dir="$(node_js "$TMPDIR_JS" "$dest/.whosup-download-" </dev/null 2>/dev/null)" || return 1
    case "$tarball_dir" in "$dest"/.whosup-download-?*) ;; *) return 1 ;; esac
    tarball="$tarball_dir/src.tgz"
    curl -fsSL --proto '=https' --proto-redir '=https' -o "$tarball" "https://github.com/$REPO/archive/${ref:-HEAD}.tar.gz" </dev/null || return 1
    tar -xzf "$tarball" -C "$dest" --strip-components 1 || return 1
    rm -rf "$tarball_dir"
    return 0
  fi
  if command -v git >/dev/null 2>&1; then
    # 브랜치·태그·커밋 모두 받는다: 빈 저장소에 그 ref 하나만 가져와 푼다(clone --branch 는 커밋 지정을 받지 못한다).
    git -C "$dest" init --quiet </dev/null >/dev/null 2>&1 || return 1
    git -C "$dest" fetch --quiet --depth 1 "https://github.com/$REPO.git" "${ref:-HEAD}" </dev/null || return 1
    git -C "$dest" -c advice.detachedHead=false checkout --quiet FETCH_HEAD </dev/null || return 1
    return 0
  fi
  say "downloading needs curl and tar, or git, and none is here" "내려받으려면 curl과 tar, 또는 git이 필요한데 없습니다" >&2
  return 1
}
# 잠금: 단독 설치 길 전체에 건다(<데이터 폴더>/install.lock 폴더 — mkdir은 이미 있으면 실패한다 — 와 그 안의 pid 파일: 이 설치기의 PID 한 줄).
# 두 설치기가 같은 app.new·app.old를 서로 지우거나 바꾸지 않게 한다. whosup uninstall·autostart on|off도 같은 잠금을 잡는다(src/standalone.mjs
# takeLock). 끝날 때(정상·실패·신호) 푼다 — 자기가 잡은 잠금(pid 파일이 자기 PID)일 때만.
# 잠겨 있을 때 걷는 조건은 "주인 PID가 살아 있지 않다"뿐이다. 시간이 지났다는 것만으로는 걷지 않는다 — 질문을 기다리는 설치는 오래 걸린다.
# pid 파일이 없거나 읽을 수 없는 잠금만 시간으로 본다: LOCK_GRACE_S(초 — 첫 실행 안내가 기다릴 수 있는 가장 긴 시간보다 길다: src/setup.mjs
# watchdogMsOf. src/standalone.mjs의 LOCK_GRACE_S와 같아야 한다)를 넘겼을 때 걷는다. 걷을 때는 pid 파일의 이름을 바꿔 차지한 뒤 그 내용이
# 방금 본 PID인지 다시 본다(그 사이에 다른 설치기가 새로 잡은 잠금을 걷지 않는다). src/standalone.mjs clearStaleLock과 같은 순서다 — 둘을 같게 둔다.
# 종료 코드: 0 = 죽은 잠금을 걷었다 · 1 = 주인이 살아 있다(또는 걷지 못했다).
LOCK_GRACE_S=21600
LOCK_STALE_JS='
const fs = require("fs"), path = require("path");
const [lock, grace] = process.argv.slice(1);
const file = path.join(lock, "pid");
const pidIn = (f) => { try { const n = Number(fs.readFileSync(f, "utf8").trim()); return Number.isInteger(n) && n > 1 ? n : 0 } catch { return 0 } };
const alive = (pid) => { try { process.kill(pid, 0); return true } catch (err) { return err.code !== "ESRCH" } };
let cleared = false;
try {
  const pid = pidIn(file);
  if (pid) {
    if (alive(pid)) process.exit(1);
    const mine = file + ".stale." + process.pid;
    fs.renameSync(file, mine);
    if (pidIn(mine) !== pid) { fs.renameSync(mine, file); process.exit(1) }
  } else if (Date.now() - fs.statSync(lock).mtimeMs <= Number(grace) * 1000) process.exit(1);
  fs.rmSync(lock, { recursive: true });
  cleared = true;
} catch {}
process.exit(cleared ? 0 : 1);
'
lock_held=0
unlock() {
  ui_restore
  [ "$lock_held" = 1 ] || return 0
  lock_held=0
  # 자기가 잡은 잠금만 푼다: 그 사이에 주인이 바뀌었으면(pid 파일이 다른 PID) 건드리지 않는다
  if [ "$(sed -n 1p "$LOCK/pid" 2>/dev/null)" = "$$" ]; then rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; fi
  rmdir "$DATA" 2>/dev/null   # 아무것도 남기지 않은 실행(설치 실패 뒤)은 빈 데이터 폴더도 치운다 — 비어 있지 않으면 그대로다
  return 0
}
take_lock() {
  [ "$lock_held" != 1 ] || return 0   # 이미 쥐었다(전용 Node를 바꾸려고 먼저 잡았다 — fetch_node)
  LOCK="$DATA/install.lock"
  if ! mkdir "$LOCK" 2>/dev/null; then
    if node_js "$LOCK_STALE_JS" "$LOCK" "$LOCK_GRACE_S" </dev/null 2>/dev/null && mkdir "$LOCK" 2>/dev/null; then :
    else
      fail "another whosup install is running here (the lock $LOCK is held). Wait for it to end, then run this again. Nothing was changed." \
        "다른 whosup 설치가 진행 중입니다(잠금 $LOCK). 그 설치가 끝난 뒤 다시 실행하세요. 바꾼 것은 없습니다."
    fi
  fi
  # 주인을 적는다. 적지 못한 잠금은 쥐고 있지 않는다(주인을 알 수 없는 잠금을 남기지 않는다).
  # pid 파일은 새로 만들 때만 쓴다(set -C: 그 이름의 것이 이미 있으면 — 링크여도 — 쓰지 않는다). 방금 만든 잠금 폴더에 누가 링크를 놓아
  # 두었어도 그 링크를 따라 다른 파일에 쓰지 않는다. 쓴 뒤에는 그것이 링크가 아닌 보통 파일이고 내 PID가 적혔는지 다시 본다.
  if [ -e "$LOCK/pid" ] || [ -L "$LOCK/pid" ] || ! (set -C; printf '%s\n' "$$" > "$LOCK/pid") 2>/dev/null \
    || [ -L "$LOCK/pid" ] || [ ! -f "$LOCK/pid" ] || [ "$(sed -n 1p "$LOCK/pid" 2>/dev/null)" != "$$" ]; then
    rm -f "$LOCK/pid" 2>/dev/null; rmdir "$LOCK" 2>/dev/null; rmdir "$DATA" 2>/dev/null
    fail "could not write the lock $LOCK. Nothing was changed." "잠금($LOCK)을 쓰지 못했습니다. 바꾼 것은 없습니다."
  fi
  lock_held=1
  trap 'node_rc=$?; unlock; node_settle' EXIT
}
# 새 버전으로 바꾸다 실패해 이전 버전으로 되돌렸을 때: 켜져 있던 보드를 다시 켠다(브라우저는 열지 않는다 — WHOSUP_LOGIN_START).
# 켜지 못했으면(그 폴더가 더는 확인되지 않을 때도) 1 — 부른 쪽이 "보드가 꺼져 있다"를 알린다(board_off). 되돌렸다고만 말하지 않는다.
restart_old() {
  [ "$was_running" = 1 ] || return 0
  app_ok || return 1
  WHOSUP_LOGIN_START=1 sh "$APP/scripts/standalone.sh" start </dev/null >/dev/null 2>&1
}
board_off() {
  say "the board that was running before could not be started again, so it is not running now. Start it: whosup start" \
    "켜져 있던 보드를 다시 켜지 못했습니다. 지금 보드는 꺼져 있습니다. 켜세요: whosup start" >&2
}
# 새 버전으로 바꾸던 것을 되돌린다: 새 버전이 켠 보드를 끄고, 새 버전을 치우고, 이전 버전(app.old)을 제자리에 둔 뒤 켜져 있던 보드를 다시 켠다.
# 폴더마다 그 안의 것을 돌리거나 옮기기 직전에 다시 확인한다(app_ok · ours).
# 0 = 이전 버전이 제자리에 있다. 다만 켜져 있던 보드를 다시 켜지 못했으면 back_note=board-off — 부른 쪽이 그 사실을 알린다(board_off).
# 1 = 되돌리지 못했다 — 이전 버전은 app.old에 그대로 있다(지우지 않는다). back_note=new-running이면 새 버전이 켠 보드를 끄지 못해서다:
#     돌고 있는 보드의 프로그램은 치우지 않는다(새 버전을 제자리에 그대로 둔다). 손으로 할 일은 back_hint가 만든다.
back_note=""
put_back() {
  back_note=""
  ours "$APP.old" || return 1
  if [ -e "$APP" ] || [ -L "$APP" ]; then
    app_ok || return 1
    if ! sh "$APP/scripts/standalone.sh" stop </dev/null >/dev/null 2>&1; then back_note=new-running; return 1; fi
    wipe "$new"
    if [ -e "$new" ] || [ -L "$new" ]; then return 1; fi
    mv "$APP" "$new" 2>/dev/null || return 1
  fi
  if ! mv "$APP.old" "$APP" 2>/dev/null; then
    [ ! -e "$new" ] || mv "$new" "$APP" 2>/dev/null || true   # 이전 버전을 놓지 못했다: 새 버전이라도 제자리에 돌려 둔다
    return 1
  fi
  wipe "$new"
  restart_old || back_note=board-off
  return 0
}
# put_back이 1을 돌려준 뒤: 손으로 할 일(문장의 뒷부분)을 back_en·back_ko에 둔다.
back_hint() {
  node_keep=1   # 되돌리지 못한 프로그램이 전용 Node로 돌 수 있다: 치우지 않는다(node_settle)
  if [ "$back_note" = new-running ]; then
    back_en="the board the new version started could not be stopped, so the new version was left in $APP. Stop that board (whosup stop), move $APP away, move $APP.old to $APP, then start the board (whosup start)"
    back_ko="새 버전이 켠 보드를 끄지 못해 새 버전을 $APP 에 그대로 두었습니다. 그 보드를 끄고(whosup stop) $APP 폴더를 다른 곳으로 옮긴 다음, $APP.old 폴더를 $APP 자리로 옮기고 보드를 켜세요(whosup start)"
  else
    back_en="look in $APP.old and move it to $APP, then start the board (whosup start)"
    back_ko="$APP.old 폴더를 $APP 자리로 옮긴 뒤 보드를 켜세요(whosup start)"
  fi
}
# 끝내지 못한 새 설치를 치운다: 마지막 단계가 놓았을 수 있는 것(보드·로그인 항목·실행 명령·설치 기록)과 앱 폴더. 설정·기록은 건드리지 않는다.
# 앱 폴더가 남아 있으면 다음 실행이 "끝내지 못한 설치가 남긴 폴더"로 본다.
# 0 = 치웠다. 1 = 남았다: 그 판의 uninstall이 실패했으면(보드를 끄지 못했다 · 로그인 항목을 치우지 못했다 — 그 말은 표준 오류로 내보낸다)
# 앱 폴더를 지우지 않는다(돌고 있는 보드·로그인 항목이 가리키는 프로그램을 없애지 않는다). 부른 쪽이 남은 것을 알리고(fresh_left) 0이 아닌 값으로 끝낸다.
# WHOSUP_INSTALLER_PID: 그 uninstall은 이 설치기가 잡은 잠금 아래에서 돈다.
clean_fresh() {
  if [ ! -e "$APP" ] && [ ! -L "$APP" ]; then return 0; fi
  app_ok || return 1
  # 그 판의 스크립트가 (그 폴더 안의 보통 파일로) 없으면 보드를 끄고 로그인 항목을 치울 수단이 없다: 끄지 못한 채 폴더를 지우지 않는다.
  # 폴더를 두고 1 — 다시 돌린 설치기가 새로 받은 판의 명령으로 그 보드를 끈 뒤에 치운다(clear_leftover).
  if [ ! -f "$APP/scripts/standalone.sh" ] || [ -L "$APP/scripts/standalone.sh" ] || [ -L "$APP/scripts" ]; then
    say "$APP has no script of its own to stop its board with, so the folder was not removed unchecked" "$APP 폴더에 보드를 끌 스크립트가 없어, 확인하지 못한 채 폴더를 지우지 않았습니다" >&2
    return 1
  fi
  said="$(WHOSUP_INSTALLER_PID="$$" sh "$APP/scripts/standalone.sh" uninstall </dev/null 2>&1)" || { [ -z "$said" ] || printf '%s\n' "$said" >&2; return 1; }
  wipe "$APP"
  [ ! -e "$APP" ] && [ ! -L "$APP" ]
}
fresh_left() {
  node_keep=1   # 남은 프로그램이 전용 Node로 돌 수 있다: 치우지 않는다(node_settle)
  say "what the install had put in place could not be fully removed (the reason is above), so $APP is still there. Stop the board if it is running, remove it yourself (sh $(shown "$APP/scripts/standalone.sh") uninstall), then run this installer again." \
    "설치가 놓았던 것을 다 치우지 못했습니다(이유는 위에 있습니다). $APP 폴더가 남아 있습니다. 보드가 켜져 있으면 끄고 직접 지운 뒤(sh $(shown "$APP/scripts/standalone.sh") uninstall) 이 설치 명령을 다시 실행하세요." >&2
}
# 로그인 항목(macOS LaunchAgent · Linux systemd --user unit — src/standalone.mjs의 LABEL·SERVICE로 만든 이름)이 이 앱 폴더의 스크립트를 가리키는가.
login_points_here() {
  for login_file in "$HOME/Library/LaunchAgents/dev.whosup.board.plist" "$HOME/.config/systemd/user/whosup.service"; do
    if [ -f "$login_file" ] && grep -F -q -- "$APP/scripts/standalone.sh" "$login_file" 2>/dev/null; then return 0; fi
  done
  return 1
}
# 끝내지 못한 설치가 남긴 앱 폴더(설치기의 표식은 있는데 설치 기록과 한 쌍이 아니다)를 치운다. 바로 지우지 않는다: 그 폴더에서 켜진 보드가
# 있을 수 있고 로그인 항목이 그 폴더를 가리킬 수 있다. 방금 받아 확인한 판(app.new)의 명령으로 보드를 끄고(같은 상태 폴더의 보드를 본다 —
# 끝내지 못한 폴더의 스크립트는 온전하다는 보장이 없다), 로그인 항목이 그 폴더를 가리키면 해제한 뒤에만 치운다.
# 1 = 끄지 못했거나 해제하지 못했거나 확인할 수 없다(그 명령이 한 말은 표준 오류로 내보낸다): 폴더를 그대로 둔다 — 부른 쪽이 손으로 할 일을 알리고 1로 끝낸다.
clear_leftover() {
  ours "$new" && ours "$APP" || return 1
  # 그 설치가 쓰던 상태 폴더는 그 폴더의 표식에 적혀 있다(mark_state): 그때만 다른 XDG_STATE_HOME으로 돌았다면 지금 환경의 상태 폴더와 다르고,
  # 그 보드는 아래의 stop(지금 환경의 상태 폴더를 본다)으로는 찾지 못한다 — 적힌 폴더의 보드부터 끈다(stop-at). 적힌 값을 믿을 수 없거나
  # 받은 판이 그 명령을 모르면 찾을 수 없는 것이다: 폴더를 치우지 않는다.
  left_state="$(mark_state "$APP")"
  if [ "$left_state" = "?" ]; then
    say "the mark in $APP names a state folder that cannot be used, so the board started from it could not be looked for" "$APP 폴더의 표식에 적힌 상태 폴더를 쓸 수 없어, 그 폴더에서 켜진 보드를 찾지 못했습니다" >&2
    return 1
  fi
  if [ -n "$left_state" ]; then
    said="$(WHOSUP_INSTALLER_PID="$$" sh "$new/scripts/standalone.sh" stop-at "$left_state" </dev/null 2>&1)" || { [ -z "$said" ] || printf '%s\n' "$said" >&2; return 1; }
  fi
  said="$(WHOSUP_INSTALLER_PID="$$" sh "$new/scripts/standalone.sh" stop </dev/null 2>&1)" || { [ -z "$said" ] || printf '%s\n' "$said" >&2; return 1; }
  if login_points_here; then
    said="$(WHOSUP_INSTALLER_PID="$$" sh "$new/scripts/standalone.sh" autostart off </dev/null 2>&1)" || { [ -z "$said" ] || printf '%s\n' "$said" >&2; return 1; }
  fi
  wipe "$APP"
  [ ! -e "$APP" ] && [ ! -L "$APP" ]
}
# 신호(Ctrl-C·kill·터미널 닫힘)를 받았다: 어디까지 갔는지(stage)에 따라 되돌린 뒤 그 신호의 종료 코드로 끝낸다(잠금은 EXIT에서 푼다).
# 셸은 돌리던 명령(설치한 판의 마지막 단계 등)이 끝난 뒤에 이 함수를 부른다.
stage=""
on_signal() {
  trap '' HUP INT TERM
  ui_restore
  case "$stage" in
    staged)   # 새 버전을 받아 둔 것뿐이다: 그것을 치우고, 바꾸려고 끈 보드가 있으면 다시 켠다
      wipe "$new"
      if [ "$stopped" = 1 ]; then restart_old || board_off; fi ;;
    swapped)
      if [ "$kind" = update ] && [ ! -d "$APP.old" ] && [ -d "$new" ]; then
        # 바꾸기 직전이었다(이전 버전은 제자리에, 새 버전은 아직 app.new에): 받아 둔 것만 치우고 끈 보드를 다시 켠다
        wipe "$new"
        restart_old || board_off
      elif [ "$kind" = update ]; then
        if put_back; then
          say "stopped: the version that was here before is back in place. Your settings and history are kept." "그만두었습니다: 전에 쓰던 버전으로 되돌렸습니다. 설정과 기록은 그대로입니다." >&2
          [ "$back_note" != board-off ] || board_off
        else
          back_hint
          say "stopped, and the version that was here before could not be put back: $back_en." "그만두었는데 전에 쓰던 버전을 되돌리지 못했습니다. $back_ko." >&2
        fi
      else
        clean_fresh || fresh_left
        wipe "$new"
        # rich: 이번 실행이 이미 깐 환경(앱 · herdr)이 남아 있다는 것을 알린다(질문에서 Ctrl-C로 그만둔 새 설치 — 화면에서 그 사실을 알 수 있게)
        [ "$ui" != rich ] || left_note
      fi ;;
  esac
  exit "$1"
}
install_standalone() {
  if [ "$plugin_listed" = 1 ] && [ "$have_standalone" != 1 ]; then
    fail "whosup already runs here as a herdr plugin ($PLUGIN_ID), so the standalone install was not added. To move to the standalone install, remove the plugin first: herdr plugin uninstall $PLUGIN_ID" \
      "whosup이 이미 herdr 플러그인($PLUGIN_ID)으로 설치돼 있어 단독 설치를 더하지 않았습니다. 단독 설치로 옮기려면 먼저 플러그인을 지우세요: herdr plugin uninstall $PLUGIN_ID"
  fi
  was_running=0; stopped=0; kind=install
  new="$APP.new"
  mkdir -p "$DATA" || fail "could not create $DATA" "$DATA 폴더를 만들지 못했습니다"
  take_lock
  trap 'on_signal 129' HUP
  trap 'on_signal 130' INT
  trap 'on_signal 143' TERM
  # 새 버전으로 바꾸던 설치기가 이전 버전을 app.old로 옮긴 직후에 죽었다(kill -9·전원): 그 판은 app.old에만 있다.
  # 아래에서 app.old를 "남은 폴더"로 치우기 전에 제자리에 되살린다 — 그래야 이번 설치가 실패해도 그 판으로 되돌아간다.
  if [ ! -e "$APP" ] && [ ! -L "$APP" ] && ours "$APP.old"; then
    if mv "$APP.old" "$APP" 2>/dev/null; then
      say "the version left in $APP.old by an update that did not finish was put back in place" "끝나지 않은 새 버전 바꾸기가 $APP.old 에 남긴 이전 버전을 제자리에 되살렸습니다"
    fi
  fi
  # 잠금을 잡은 뒤에 다시 본다: 잠금을 기다리는 사이에 다른 설치기가 여기에 설치를 끝냈을 수 있다.
  have_standalone=0
  if installed; then have_standalone=1; fi
  # 그 자리에 있는 것이 whosup 설치가 아니다(설치 기록과 표식이 한 쌍으로 맞지 않는다): 그 안의 것을 돌리지도 덮지도 않고 알린 뒤 끝낸다.
  # 다만 설치기의 표식이 든 폴더는 끝내지 못한 설치가 남긴 것이다 — 새 버전을 받은 뒤 보드를 끄고 치운다(아래 clear_leftover).
  leftover=0
  if [ "$have_standalone" != 1 ] && { [ -e "$APP" ] || [ -L "$APP" ]; }; then
    if ! ours "$APP"; then
      fail "$APP is there but is not a whosup install (no install record points at it). Nothing in it was run or changed. Move it away and run this installer again." \
        "$APP 폴더가 이미 있는데 whosup 설치가 아닙니다(그 폴더를 가리키는 설치 기록이 없습니다). 그 안의 것은 실행하지도 바꾸지도 않았습니다. 다른 곳으로 옮긴 뒤 이 설치 명령을 다시 실행하세요."
    fi
    leftover=1
  fi
  [ "$have_standalone" != 1 ] || kind=update
  if [ "$ui" = rich ]; then
    # 시작 줄은 짧게(무엇이 있어서 단독 설치인가만). 어디에 놓았는지는 끝의 요약이 한 번 말한다.
    if [ "$kind" = update ]; then ui_step ok "standalone whosup found" "단독 설치한 whosup 있음"
    else
      case "$core_why" in
        socket) ui_step ok "herdr-core is running" "herdr-core 켜져 있음" ;;
        herdr-core | hc) ui_step ok "herdr-core found ($core_why)" "herdr-core 있음 ($core_why)" ;;
        trace) ui_print ok "$(pick "An app that uses herdr-core has run on this computer (it is not running now). Start that app and its sessions show on the board." "herdr-core를 쓰는 앱을 이 컴퓨터에서 쓴 적이 있습니다(지금은 꺼져 있음). 그 앱을 켜면 세션이 보드에 보입니다.")" ;;
      esac
    fi
  elif [ "$kind" = update ]; then
    say "a standalone whosup is here ($APP): replacing it with the new version, settings and history kept" "단독으로 설치한 whosup이 있습니다($APP): 새 버전으로 바꿉니다. 설정과 기록은 그대로입니다"
  else
    case "$core_why" in
      socket) say "herdr-core is running here and there is no herdr: installing whosup on its own (standalone), no herdr needed" "herdr-core가 켜져 있고 herdr는 없습니다: herdr 없이 단독으로 설치합니다" ;;
      herdr-core | hc) say "herdr-core ($core_why) is here and there is no herdr: installing whosup on its own (standalone), no herdr needed" "herdr-core($core_why)가 있고 herdr는 없습니다: herdr 없이 단독으로 설치합니다" ;;
      # 살아 있는 코어는 없고 쓴 흔적(core.lock)만 있다: 켜져 있다고 말하지 않는다
      trace) say "an app that uses herdr-core has run on this computer and is not running now: installing whosup on its own (standalone), no herdr needed. Start that app and its sessions show on the board" "herdr-core를 쓰는 앱을 이 컴퓨터에서 쓴 적이 있고 지금은 꺼져 있습니다: herdr 없이 단독으로 설치합니다. 그 앱을 켜면 세션이 보드에 보입니다" ;;
      *) say "installing whosup on its own (standalone), without herdr" "herdr 없이 단독으로 설치합니다" ;;
    esac
  fi
  # app.new·app.old: 설치기가 만든 것(표식)만 치운다. 남의 것이 그 자리에 있으면 건드리지 않고 알린 뒤 끝낸다.
  for d in "$new" "$APP.old"; do
    if [ -e "$d" ] || [ -L "$d" ]; then
      if ! ours "$d"; then
        fail "$d is there and this installer did not put it there, so it was left as it is. Move it away and run this installer again. Nothing was changed." \
          "$d 폴더가 이미 있는데 이 설치기가 만든 것이 아니어서 그대로 두었습니다. 다른 곳으로 옮긴 뒤 이 설치 명령을 다시 실행하세요. 바꾼 것은 없습니다."
      fi
      wipe "$d"
      # 치운 뒤에도 그 자리에 무엇인가 있다(다 지우지 못했거나, 그 사이에 다른 폴더가 그 자리에 놓였다): 그 안으로 옮겨 넣지 않게 멈춘다
      if [ -e "$d" ] || [ -L "$d" ]; then
        fail "could not clear $d, so it was left as it is. Move it away and run this installer again. Nothing was changed." \
          "$d 폴더를 치우지 못해 그대로 두었습니다. 다른 곳으로 옮긴 뒤 이 설치 명령을 다시 실행하세요. 바꾼 것은 없습니다."
      fi
    fi
  done
  # 새 버전을 받을 폴더: 새로 만들고(이미 있으면 실패한다) 표식을 둔다. 표식을 만들지 못하면 방금 만든 그 폴더만 치우고 멈춘다
  # (mkdir이 성공했으니 이 실행이 만든 폴더다 — 표식 없는 폴더를 남기면 다음 실행이 남의 폴더로 본다).
  if ! mkdir "$new"; then fail "could not create $new. Nothing was changed." "$new 폴더를 만들지 못했습니다. 바꾼 것은 없습니다."; fi
  if ! mark "$new"; then
    rm -rf "$new"
    fail "could not create $new. Nothing was changed." "$new 폴더를 만들지 못했습니다. 바꾼 것은 없습니다."
  fi
  stage=staged
  if ! fetch_source "$new"; then
    wipe "$new"
    fail "could not get whosup's files (${WHOSUP_INSTALL_SOURCE:-github.com/$REPO}). Check the connection and run this installer again. Nothing was changed." \
      "whosup 파일을 받지 못했습니다(${WHOSUP_INSTALL_SOURCE:-github.com/$REPO}). 연결을 확인하고 이 설치 명령을 다시 실행하세요. 바꾼 것은 없습니다."
  fi
  # 받은 파일 가운데 같은 이름이 있었어도 표식은 이 설치기의 것이다. 다시 두지 못했으면 바꾸기 전에 멈춘다(표식 없는 폴더를 제자리에 놓지 않는다).
  if ! mark "$new"; then
    stage=""
    rm -rf "$new"
    fail "could not put the installer's mark in $new, so nothing was replaced. Nothing was changed." "$new 폴더에 설치기의 표식을 두지 못해 아무것도 바꾸지 않았습니다. 바꾼 것은 없습니다."
  fi
  # 확인: 단독 설치의 파일이 있고, 그 판이 이 Node에서 돈다(help는 모듈을 읽기만 한다)
  for f in scripts/standalone.sh scripts/standalone.mjs src/standalone.mjs bin/whosup.mjs herdr-plugin.toml; do
    if [ ! -f "$new/$f" ]; then
      wipe "$new"
      fail "that version of whosup has no standalone install ($f is missing). Nothing was changed." "받은 판에는 단독 설치가 없습니다($f 없음). 바꾼 것은 없습니다."
    fi
    # 돌릴 파일은 받은 폴더 안의 보통 파일이어야 한다: 그 파일이나 그것이 든 폴더가 링크면 받은 폴더 밖의 것을 돌리게 된다 — 돌리지 않는다.
    if [ -L "$new/$f" ] || [ -L "$new/${f%/*}" ]; then
      wipe "$new"
      fail "that copy of whosup was not installed: $f in it is a link, not a file of its own, and a link is not run. Nothing was changed." \
        "받은 whosup을 설치하지 않았습니다. 그 안의 파일($f)이 제 파일이 아니라 링크여서 실행하지 않습니다. 바꾼 것은 없습니다."
    fi
  done
  if ! sh "$new/scripts/standalone.sh" help </dev/null >/dev/null; then
    wipe "$new"
    fail "the downloaded whosup does not run here; what it said is above. Nothing was changed." "받은 whosup이 여기서 돌지 않습니다. 위에 그 출력이 있습니다. 바꾼 것은 없습니다."
  fi
  # 끝내지 못한 설치가 남긴 앱 폴더: 보드를 끄고 로그인 항목을 해제한 뒤에만 치운다. 못 했으면 그 폴더를 그대로 두고 끝낸다(clear_leftover).
  if [ "$leftover" = 1 ]; then
    say "an install that did not finish left $APP behind: removing it and installing again" "끝내지 못한 설치가 $APP 폴더를 남겼습니다: 치우고 다시 설치합니다"
    if ! clear_leftover; then
      stage=""
      wipe "$new"
      fail "could not clear $APP safely (the reason, if any was given, is above): the board started from it could not be stopped, or its start-at-login entry could not be removed, so the folder was left as it is. Stop that board, remove the folder yourself, then run this installer again." \
        "$APP 폴더를 안전하게 치우지 못했습니다(이유가 있으면 위에 있습니다). 그 폴더에서 켜진 보드를 끄지 못했거나 로그인할 때 자동으로 켜기를 해제하지 못해 폴더를 그대로 두었습니다. 보드를 끄고 그 폴더를 직접 지운 뒤 이 설치 명령을 다시 실행하세요."
    fi
  fi
  # 새 버전으로 바꿀 때: 켜져 있던 보드를 끄고(설치 뒤 다시 켠다) 폴더를 바꾼다. 그 폴더의 스크립트를 돌리기 직전마다 다시 확인한다(app_run).
  if [ "$kind" = update ]; then
    if app_run status >/dev/null 2>&1; then was_running=1; fi
    if ! app_run stop >/dev/null 2>&1; then
      wipe "$new"
      fail "could not stop the running board, so nothing was changed. Stop it (whosup stop) and run this again." "켜져 있는 보드를 끄지 못해 아무것도 바꾸지 않았습니다. 보드를 끄고(whosup stop) 다시 실행하세요."
    fi
    stopped=1
    # 여기부터 이전 버전이 app.old에 있다: 신호를 받으면 되돌린다(on_signal — swapped)
    stage=swapped
    if ! app_ok || ! mv "$APP" "$APP.old"; then
      stage=staged; wipe "$new"
      restart_old || board_off
      fail "could not replace $APP. Nothing was changed." "$APP 폴더를 바꾸지 못했습니다. 바꾼 것은 없습니다."
    fi
    # 옮긴 것이 방금 확인한 그 폴더인지 한 번 더 본다(확인과 옮기기 사이에 그 자리의 폴더가 바뀌었을 수 있다). 설치기의 표식이 없으면
    # 남의 폴더를 옮긴 것이다: 제자리에 돌려놓고 그만둔다 — 그 폴더를 지우지도, 그 안의 것을 돌리지도, 새 버전을 그 자리에 놓지도 않는다.
    if ! ours "$APP.old"; then
      if [ ! -e "$APP" ] && [ ! -L "$APP" ]; then mv "$APP.old" "$APP" 2>/dev/null; fi
      stage=""; wipe "$new"
      fail "$APP changed while it was being replaced: the folder there now is not the whosup install that was checked. It was put back as it was, nothing in it was run or removed, and the new version was not installed. The board was stopped before this. Check that folder, then run this installer again." \
        "$APP 폴더가 바꾸는 도중에 달라졌습니다. 지금 그 자리의 폴더는 확인했던 whosup 설치가 아닙니다. 그 폴더를 제자리에 그대로 돌려놓았고, 그 안의 것은 실행하지도 지우지도 않았으며 새 버전은 설치하지 않았습니다. 보드는 이 전에 꺼 두었습니다. 그 폴더를 확인한 뒤 이 설치 명령을 다시 실행하세요."
    fi
  fi
  stage=swapped
  # 받은 판을 제자리에 놓는다: 놓기 직전에 그 폴더가 지금도 이 설치기의 것이고 그 자리가 비어 있는지 본다(있는 폴더 안으로 들어가지 않게).
  if ! ours "$new" || [ -e "$APP" ] || [ -L "$APP" ] || ! mv "$new" "$APP"; then
    if ours "$APP.old" && [ ! -e "$APP" ] && [ ! -L "$APP" ]; then mv "$APP.old" "$APP"; fi
    stage=""
    wipe "$new"
    restart_old || board_off
    fail "could not put whosup into $APP. Nothing was changed." "whosup을 $APP 에 놓지 못했습니다. 바꾼 것은 없습니다."
  fi
  if [ "$ui" != rich ]; then say "whosup is in $APP" "whosup을 $APP 에 놓았습니다"
  elif [ "$kind" = update ]; then ui_step ok "whosup updated (settings kept)" "whosup 새 버전으로 바꿈 (설정 유지)"
  else ui_step ok "whosup installed" "whosup 설치"
  fi
  # 나머지(첫 실행 안내 → 설치 기록 → whosup 명령 → 보드 켜기 → 로그인할 때 자동으로 켜기 → 설치 요약)는 방금 놓은 판이 한다.
  # 이전 버전(app.old)은 그 단계가 끝날 때까지 둔다: 새 버전이 거기서 실패하거나 그만두면(130) 이전 버전으로 되돌린다(보드가 꺼진 채 새 버전만 남지 않게).
  # 0이 아닌 값은 모두 "끝내지 못했다"다: 그만둠(130) · 시간 초과(124) · 켜져 있던 보드가 새 버전에서 켜지지 않음 · 그 밖의 오류.
  # WHOSUP_INSTALLER_PID: 이 설치기가 죽으면(kill·터미널 닫힘) 그 단계가 설치를 그만둔다.
  step=0
  if app_ok; then
    # WHOSUP_ENV_*: 환경 고르기의 결과(없으면 빈 값) — 그 단계가 설치 기록에 함께 깐 환경을 적고, 요약의 "다음에 할 일"을 그 앱의 말로 쓴다.
    WHOSUP_INSTALL_KIND="$kind" WHOSUP_WAS_RUNNING="$was_running" WHOSUP_INSTALLER_PID="$$" WHOSUP_ENV_PICK="$env_pick" WHOSUP_ENV_INSTALLED="$env_installed" WHOSUP_ENV_APP="$env_app" sh "$APP/scripts/standalone.sh" install </dev/null || step=$?
  else
    step=126   # 방금 놓은 폴더가 더는 확인되지 않는다: 그 안의 것을 돌리지 않는다
  fi
  if [ "$step" = 0 ]; then stage=""; wipe "$APP.old"; return 0; fi
  if [ "$kind" = update ]; then
    if put_back; then
      stage=""
      # 질문에서 그만둔 것(130 — Ctrl-C, 설치 명령이 죽음): 되돌렸다는 한 줄만 남기고 같은 코드로 끝낸다.
      if [ "$step" = 130 ]; then
        say "stopped: the version that was here before is back in place. Your settings and history are kept." "그만두었습니다: 전에 쓰던 버전으로 되돌렸습니다. 설정과 기록은 그대로입니다." >&2
        [ "$back_note" != board-off ] || board_off
        exit 130
      fi
      # 켜져 있던 보드를 다시 켜지 못했으면 되돌렸다고만 말하지 않는다: 그 사실을 먼저 알린다
      [ "$back_note" != board-off ] || board_off
      fail "the new version did not finish installing (its last step ended with $step; what it said is above), so the version that was here before is back in place. Your settings and history are kept. If the board is not running, start it: whosup start" \
        "새 버전의 설치를 끝내지 못해(마지막 단계 종료 코드 $step, 위에 그 출력이 있습니다) 전에 쓰던 버전으로 되돌렸습니다. 설정과 기록은 그대로입니다. 보드가 꺼져 있으면 켜세요: whosup start"
    fi
    stage=""
    back_hint
    fail "the new version did not finish installing (its last step ended with $step; what it said is above), and the version that was here before could not be put back: $back_en. Your settings and history are kept." \
      "새 버전의 설치를 끝내지 못했고(마지막 단계 종료 코드 $step, 위에 그 출력이 있습니다) 전에 쓰던 버전도 되돌리지 못했습니다. $back_ko. 설정과 기록은 그대로입니다."
  fi
  # 새 설치의 마지막 단계가 끝나지 않았다: 반쯤 깔린 채 두지 않는다. 다만 치우지 못한 것(끄지 못한 보드·해제하지 못한 로그인 항목)이 있으면
  # 앱 폴더를 지우지 않고 남은 것을 알린 뒤 0이 아닌 값으로 끝낸다.
  if ! clean_fresh; then
    stage=""
    [ "$step" = 130 ] || say "the install did not finish (its last step ended with $step; what it said is above)." "설치를 끝내지 못했습니다(마지막 단계 종료 코드 $step, 위에 그 출력이 있습니다)." >&2
    fresh_left
    left_note
    [ "$step" != 130 ] || exit 130
    exit 1
  fi
  stage=""
  # 새 설치의 질문에서 그만둔 것(130): 방금 놓은 판이 "그만둡니다"를 알렸다 — 덧붙일 말은 이번에 깐 환경이 남아 있다는 것뿐이다(left_note).
  [ "$step" != 130 ] || { left_note; exit 130; }
  fail "the install did not finish (its last step ended with $step; what it said is above). What it had put in place was removed, so whosup is not installed; settings and history, if you had any, are kept. Run this installer again." \
    "설치를 끝내지 못했습니다(마지막 단계 종료 코드 $step, 위에 그 출력이 있습니다). 놓았던 것은 치웠으므로 whosup은 설치되지 않았습니다. 설정과 기록이 있었다면 그대로입니다. 이 설치 명령을 다시 실행하세요."
}

main() {
  # PATH가 없는 환경(env -i 등)에서도 멈추지 않는다: 사람의 PATH는 빈 것으로 적어 두고, 찾는 길은 시스템 기본 폴더에서 시작한다.
  # 사람의 셸 PATH(아래에서 덧붙이기 전): "whosup·herdr 만 쳐도 되는가"를 이것으로 본다
  USER_PATH="${WHOSUP_USER_PATH:-${PATH:-}}"
  WHOSUP_USER_PATH="$USER_PATH"; export WHOSUP_USER_PATH
  PATH="${PATH:-/usr/bin:/bin}"
  pick_lang
  ui_init
  [ -n "${HOME:-}" ] || fail "HOME is not set" "HOME이 설정돼 있지 않습니다"
  case "$HOME" in /*) ;; *) fail "HOME is not an absolute path: $HOME" "HOME이 절대 경로가 아닙니다: $HOME" ;; esac
  case "$(uname -s)" in
    Darwin | Linux) ;;
    *) fail "this installer runs on macOS and Linux; this is $(uname -s). On Windows, install the herdr plugin: herdr plugin install $REPO --yes" \
      "이 설치 명령은 macOS와 Linux에서 돕니다(지금은 $(uname -s)). Windows에서는 herdr 플러그인으로 설치하세요: herdr plugin install $REPO --yes" ;;
  esac
  case "${WHOSUP_INSTALL_MODE:-}" in
    '' | plugin | standalone) ;;
    *) fail "WHOSUP_INSTALL_MODE=$WHOSUP_INSTALL_MODE is not a path this installer knows: use plugin or standalone" "WHOSUP_INSTALL_MODE=$WHOSUP_INSTALL_MODE: 모르는 값입니다. plugin 또는 standalone 중 하나를 쓰세요" ;;
  esac
  case "${WHOSUP_ENV:-}" in
    '' | herdr-app | ovis-app | herdr) ;;
    *) fail "WHOSUP_ENV=$WHOSUP_ENV is not something this installer can install: use herdr-app, ovis-app or herdr. Nothing was installed." "WHOSUP_ENV=$WHOSUP_ENV: 모르는 값입니다. herdr-app, ovis-app, herdr 중 하나를 쓰세요. 아무것도 설치하지 않았습니다." ;;
  esac
  # 데이터 폴더: XDG_DATA_HOME은 절대 경로일 때만 쓴다(상대 경로·제어 문자가 든 값은 없는 것으로 본다 — abs_dir).
  # node보다 먼저 정한다: 쓸 만한 node가 없을 때 받는 전용 Node가 이 폴더 안(<데이터 폴더>/node)에 놓인다(check_node).
  data_home="$(abs_dir "${XDG_DATA_HOME:-}")"
  DATA="${data_home:-$HOME/.local/share}/whosup"
  APP="$DATA/app"
  search_path
  check_node

  HERDR_DIR="${HERDR_INSTALL_DIR:-$HOME/.local/bin}"
  herdr_installed=0
  have_standalone=0
  if installed; then have_standalone=1; fi
  core_why=""
  # 환경 고르기의 결과(아무것도 없는 기계에서만 채워진다): 붙일 환경 · 이번에 함께 깐 환경 · 그 앱의 경로
  env_pick=""; env_installed=""; env_app=""
  look_herdr

  # 길 고르기: 강제 값 > 이미 깔린 방식(플러그인 · 단독) > herdr 있음 → 플러그인 > herdr-core 있음(켜져 있음 · PATH에 있음 · 쓴 흔적) → 단독
  #   > 아무것도 없음 → 환경을 고르고(choose_env) 그것을 깐 뒤: 앱이면 단독, herdr면 깔고 플러그인
  mode="${WHOSUP_INSTALL_MODE:-}"
  if [ -z "$mode" ]; then
    if [ "$plugin_listed" = 1 ]; then mode=plugin
    elif [ "$have_standalone" = 1 ]; then mode=standalone
    elif [ "$herdr_ok" = 1 ]; then mode=plugin
    elif core_here; then
      mode=standalone
      if [ -n "$herdr_hung" ]; then say "herdr here did not answer ($herdr_hung gave no answer within $herdr_limit s and was stopped), so it is left alone" "여기 있는 herdr가 응답하지 않습니다(${herdr_limit}초 안에 끝나지 않아 멈춘 명령: $herdr_hung). 그대로 둡니다"
      elif [ "$herdr_found" = 1 ]; then say "herdr ${herdr_version:-unknown} here is older than $HERDR_MIN and cannot take plugins, so it is left alone" "여기 있는 herdr(${herdr_version:-알 수 없음})는 $HERDR_MIN 보다 낮아 플러그인을 받지 못합니다. 그대로 둡니다"
      fi
    # 쓸 수 없는 herdr가 있다(응답 없음 · 플러그인을 받지 못하는 이전 버전): 아무것도 없는 기계가 아니다 — 플러그인 길이 그 사실을 알리고 끝낸다
    elif [ "$herdr_found" = 1 ]; then mode=plugin
    else
      choose_env
      case "$env_pick" in
        herdr-app) install_herdr_app; mode=standalone ;;
        ovis-app) install_ovis_app; mode=standalone ;;
        *) mode=plugin ;;
      esac
    fi
  fi
  # WHOSUP_ENV는 아무것도 없는 기계에서만 쓴다: 쓰지 않았으면 그 사실을 한 줄로 알린다(조용히 다른 길로 가지 않는다)
  if [ -n "${WHOSUP_ENV:-}" ] && [ -z "$env_pick" ]; then
    say "WHOSUP_ENV=$WHOSUP_ENV was not used: it only applies when nothing to run sessions in is on this computer and no path is forced" \
      "WHOSUP_ENV=$WHOSUP_ENV: 쓰지 않았습니다. 세션을 띄울 환경이 이 컴퓨터에 하나도 없고 길을 강제하지 않았을 때만 쓰는 값입니다"
  fi
  if [ "$mode" = standalone ]; then install_standalone; else install_plugin; fi
}

# the whole script is read before anything runs: under `curl | sh` nothing here may start on a half-read file
main "$@"
