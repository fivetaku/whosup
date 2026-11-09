#!/bin/sh
# One line about what is missing, before anything else fails later.
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
