#!/bin/sh
# whosup <command> for the standalone install (no herdr): start | stop | status | open | setup | update | uninstall | autostart | help.
# ~/.local/bin/whosup (the launcher install.sh writes) and the login item (launchd / systemd --user) both run this file,
# so node is looked up in one place. The node picked at install time comes first (WHOSUP_NODE, an absolute path the launcher
# and the login item hand over); if that file is gone or is no longer 22.13 or newer (node moved, was upgraded away, or was
# replaced by an older one in place), node is looked for again each time.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# 사람의 셸 PATH를 기억해 둔다: node-path.sh가 ~/.local/bin 등을 덧붙이기 전의 값으로 "whosup 만 쳐도 되는가"를 판단한다.
WHOSUP_USER_PATH="${WHOSUP_USER_PATH:-${PATH:-}}"
export WHOSUP_USER_PATH
# 설치 때 고른 node(절대 경로)가 지금도 22.13 이상이면 그것을 쓴다(다시 찾지 않는다). 그 판정은 node-path.sh가 한다(whosup_node_ok — 파일이
# 없어졌거나 그 자리의 node가 낮아졌으면 다시 찾는다). node-path.sh는 어느 쪽이든 읽는다: 보드가 물려받을 PATH에 흔한 설치 폴더를 덧붙인다.
WHOSUP_NODE_PINNED=""
case "${WHOSUP_NODE:-}" in /*) WHOSUP_NODE_PINNED="$WHOSUP_NODE" ;; esac
. "$ROOT/scripts/node-path.sh"
WHOSUP_NODE="${WHOSUP_NODE_PICK:-}"
if [ -z "$WHOSUP_NODE" ]; then
  if [ -n "${WHOSUP_NODE_SEEN:-}" ]; then
    echo "whosup needs Node 22.13 or newer (found $("$WHOSUP_NODE_SEEN" -v 2>/dev/null </dev/null || echo unknown)). Update it from https://nodejs.org or with 'brew upgrade node', then run this again." >&2
  else
    echo "whosup needs Node 22.13 or newer (node not found on PATH). Install it from https://nodejs.org or with 'brew install node', then run this again." >&2
  fi
  exit 1
fi
export WHOSUP_NODE
exec "$WHOSUP_NODE" "$ROOT/scripts/standalone.mjs" "$@"
