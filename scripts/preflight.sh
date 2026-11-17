#!/bin/sh
# One line about what is missing, before anything else fails later.
#   preflight.sh            node 확인 → autoconf(상태 폴더 auto.json 쓰기). plugin.sh start가 이 경로를 쓴다.
#   preflight.sh install    herdr의 build 훅: node 확인 → 설치에 이어지는 셋업(scripts/setup.mjs --install). auto.json은 쓰지 않는다.
set -u
. "$(dirname "$0")/node-path.sh"
if ! command -v node >/dev/null 2>&1; then
  echo "whosup needs Node 22.13 or newer (node not found on PATH). Install from https://nodejs.org or 'brew install node'." >&2
  exit 1
fi
# Check what whosup actually needs — node:sqlite without flags (Node 22.13+ / 23.4+) — not just the major version.
if ! node --input-type=module -e "import 'node:sqlite'" >/dev/null 2>&1; then
  echo "whosup needs Node 22.13 or newer (found $(node -v)): node:sqlite is not available without flags." >&2
  exit 1
fi
echo "node $(node -v) ok"
if [ "${1:-}" = "install" ]; then
  # 설치(build 훅): 이때는 herdr가 HERDR_PLUGIN_STATE_DIR을 주지 않으므로 auto.json을 쓰지 않는다(시작 때 상태 폴더에 쓴다).
  # 셋업은 제어 터미널에 묻고 <설정 폴더>/setup.json에 답을 남긴다. 여기서 $PPID는 설치 명령(herdr)이다 — 그것이 끝난 뒤 보드를 띄운다.
  # 셋업이 어떤 이유로 실패해도 설치는 막지 않는다 — 그때는 보드를 처음 열 때 첫 실행 안내가 묻는다.
  WHOSUP_INSTALLER_PID="$PPID" node "$(dirname "$0")/setup.mjs" --install || echo "whosup setup did not finish: the board asks on first open" >&2
  exit 0
fi
# 시작 때 실행 환경을 확인해 자동 값을 상태 폴더 auto.json에 쓴다(.env·설정은 건드리지 않는다).
# 감지에 실패해도 시작은 막지 않는다 — 그때는 기본값으로 뜬다.
node "$(dirname "$0")/autoconf.mjs" || echo "whosup autoconf failed: starting with defaults" >&2
