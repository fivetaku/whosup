#!/bin/sh
# start | stop | status | open — run by herdr (startup hook / actions) or by hand from the plugin root.
# State (pid, db, seen marks) lives in HERDR_PLUGIN_STATE_DIR when herdr runs us, else ~/.config/whosup.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
. "$ROOT/scripts/node-path.sh"
STATE="${HERDR_PLUGIN_STATE_DIR:-$HOME/.config/whosup}"
CONF="${HERDR_PLUGIN_CONFIG_DIR:-$HOME/.config/whosup}"
mkdir -p "$STATE"
# user settings: KEY=value lines in $CONF/.env (PORT, OPEN_BROWSER, AGENT_CMD, FRONT_APP, STALE_DAYS, WHOSUP_READONLY)
if [ -f "$CONF/.env" ]; then
  set -a; . "$CONF/.env"; set +a
fi
PORT="${PORT:-4790}"
PID="$STATE/server.pid"
LOG="$STATE/server.log"
URL="http://127.0.0.1:$PORT"

# board_pid <PID>: 그 프로세스가 살아 있는 보드인가(alive = pid 파일의 PID로). 번호가 살아 있어도 다른 프로그램인 것이 확인되면 아니다(재부팅·강제 종료 뒤 남은 번호를
# 다른 프로그램이 받았다): 명령 줄에 보드의 진입점(whosup.mjs)이 있는지 본다 — Linux는 /proc/<pid>/cmdline, 그 밖에는 ps -o command=.
# 명령 줄을 읽지 못하면 예전처럼 pid 파일을 믿는다(scripts/launch.mjs boardProcess · filedBoardPid와 같은 판정).
board_pid() {
  case "$1" in '' | *[!0-9]*) return 1 ;; esac
  kill -0 "$1" 2>/dev/null || return 1
  if [ -r "/proc/$1/cmdline" ]; then pid_cmd="$(tr '\000' ' ' < "/proc/$1/cmdline" 2>/dev/null)"; else pid_cmd="$(ps -ww -o command= -p "$1" 2>/dev/null)"; fi
  case "$pid_cmd" in '' | *whosup.mjs*) return 0 ;; esac
  return 1
}
alive() { [ -f "$PID" ] && board_pid "$(cat "$PID" 2>/dev/null)"; }
# 보드가 떠 있는가는 "그 포트가 답한다"가 아니라 건강 응답의 이름과 이 설치의 표식으로 본다(src/paths.mjs boardReply와 같은 판정):
# 보드가 죽은 뒤 다른 서버가 그 포트를 받아 200을 줘도, 다른 상태 폴더의 후즈업이 그 포트에 있어도 "이미 떠 있다"로 보지 않는다.
# 표식은 scripts/launch.mjs가 계산한다(한 번만 묻는다). 이름·표식을 싣기 전 판의 보드(응답이 {"ok":true,"readonly": 로 시작한다)는
# pid 파일의 프로세스가 살아 있는 보드일 때만 받는다 — 새 버전으로 바꾼 직후에는 이전 버전의 보드가 아직 돌고 있다.
# BOARD_PID = 답에 실린 보드의 PID(이전 버전의 보드면 빈 값).
INSTANCE=""; BOARD_PID=""
is_board() {
  [ -n "$INSTANCE" ] || INSTANCE="$(HERDR_PLUGIN_STATE_DIR="$STATE" node "$ROOT/scripts/launch.mjs" instance 2>/dev/null </dev/null)"
  case "$INSTANCE" in '' | *[!0-9a-f]*) return 1 ;; esac
  BOARD_PID=""
  body="$(curl -fsS -m 2 "$1/api/health" 2>/dev/null)" || return 1
  case "$body" in
    *"\"app\":\"whosup\",\"instance\":\"$INSTANCE\",\"pid\":"*)
      BOARD_PID="$(printf '%s' "$body" | sed -n "s/.*\"instance\":\"$INSTANCE\",\"pid\":\([0-9][0-9]*\).*/\1/p")"
      return 0 ;;
    '{"ok":true,"readonly":'*) alive; return $? ;;
  esac
  return 1
}
# 4790이 차 있으면 whosup은 다음 포트로 뜨고 $STATE/port에 적는다 — 그 포트를 먼저 본다.
healthy() {
  if [ -f "$STATE/port" ]; then
    p="$(cat "$STATE/port" 2>/dev/null)"
    case "$p" in '' | *[!0-9]*) ;; *) if is_board "http://127.0.0.1:$p"; then URL="http://127.0.0.1:$p"; return 0; fi ;; esac
  fi
  is_board "$URL"
}
# OPEN_BROWSER: 환경변수·.env > 자동 감지(원격이면 0, auto.json) > 1.
auto_open_browser() { [ -n "${OPEN_BROWSER:-}" ] || OPEN_BROWSER="$(node "$ROOT/scripts/autoconf.mjs" --read open_browser 2>/dev/null)"; }
open_browser() {
  [ "${1:-}" = "force" ] || auto_open_browser
  [ "${OPEN_BROWSER:-1}" = "1" ] || return 0
  # skip when a tab already talks to us (heartbeat written by the page in the last 15 s)
  hb="$STATE/board-heartbeat"
  if [ -f "$hb" ] && [ -n "$(find "$hb" -newermt '-15 seconds' 2>/dev/null)" ]; then return 0; fi
  # herdr가 켜질 때(start): 가려진 탭이라도 보드에 붙어 있으면 새 탭을 또 열지 않는다. 직접 고른 open(force)은 연다.
  cn="$STATE/board-connected"
  if [ "${1:-}" != "force" ] && [ -f "$cn" ] && [ -n "$(find "$cn" -newermt '-15 seconds' 2>/dev/null)" ]; then return 0; fi
  case "$(uname)" in
    Darwin) [ -n "${SSH_CONNECTION:-}" ] || /usr/bin/open "$URL" ;;
    *) [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1 && xdg-open "$URL" >/dev/null 2>&1 ;;
  esac
}

case "${1:-status}" in
  start)
    if healthy; then echo "whosup already listening at $URL"; open_browser; exit 0; fi
    # 기록된 whosup이 살아 있는데 답하지 않으면 새로 띄우지 않는다 — pid 파일을 덮어쓰면 그 프로세스가 고아가 된다.
    if alive; then echo "whosup pid $(cat "$PID") is running but not answering — run stop first, see $LOG"; exit 1; fi
    # preflight가 autoconf까지 돌려 auto.json을 새로 쓴다(서버는 시작할 때 그 파일을 읽는다).
    sh "$ROOT/scripts/preflight.sh" >/dev/null || exit 1
    cd "$ROOT" || exit 1
    WHOSUP_STATE_DIR="$STATE" PORT="$PORT" nohup node bin/whosup.mjs >>"$LOG" 2>&1 </dev/null &
    NEW=$!
    i=0; while [ $i -lt 40 ]; do healthy && break; kill -0 "$NEW" 2>/dev/null || break; sleep 0.25; i=$((i+1)); done
    if healthy; then
      # 같은 상태 폴더의 다른 whosup이 이미 답하고 있으면 방금 띄운 것은 스스로 끝난다 — 그때는 pid 파일을 건드리지 않는다.
      kill -0 "$NEW" 2>/dev/null && echo "$NEW" >"$PID"
      echo "whosup listening at $URL"; open_browser
    else
      # 실패로 끝낼 때는 방금 띄운 프로세스를 남기지 않는다.
      kill -TERM "$NEW" 2>/dev/null
      echo "whosup failed to start — see $LOG"; tail -5 "$LOG"; exit 1
    fi
    ;;
  stop)
    # 끌 프로세스: 이 상태 폴더의 보드가 답하면 그 답에 실린 PID(pid 파일이 없거나 낡았어도 그 보드를 끈다), 답하지 않으면 pid 파일의 PID.
    # pid 파일의 번호가 살아 있어도 후즈업 보드가 아닌 것이 확인되면 끄지 않는다(남의 프로세스다) — 낡은 pid 파일만 치운다.
    TARGET=""
    # 답에 실린 PID도 그대로 믿지 않는다: 그 프로세스가 보드가 아닌 것이 확인되면(답을 흉내 낸 서버가 남의 PID를 댔다) 쓰지 않는다.
    if healthy && board_pid "$BOARD_PID"; then TARGET="$BOARD_PID"; elif alive; then TARGET="$(cat "$PID")"; fi
    if [ -z "$TARGET" ]; then rm -f "$PID"; echo "whosup not running"; exit 0; fi
    kill -TERM "$TARGET" 2>/dev/null; i=0; while [ $i -lt 20 ] && kill -0 "$TARGET" 2>/dev/null; do sleep 0.25; i=$((i+1)); done
    kill -0 "$TARGET" 2>/dev/null && { echo "still running pid=$TARGET"; exit 1; }
    rm -f "$PID"; echo "whosup stopped"
    ;;
  status)
    # PID는 보드가 답한 것을 말한다(pid 파일이 낡았을 수 있다). 이전 버전의 보드면 pid 파일의 것.
    if healthy; then echo "whosup listening at $URL (pid ${BOARD_PID:-$(cat "$PID" 2>/dev/null || echo ?)})"; else echo "whosup not running"; exit 1; fi
    ;;
  open)
    healthy || { echo "whosup not running — start it first"; exit 1; }
    OPEN_BROWSER=1 open_browser force; echo "opened $URL"
    ;;
  *) echo "usage: plugin.sh start|stop|status|open"; exit 2 ;;
esac
