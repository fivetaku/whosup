# Sourced by preflight.sh, plugin.sh, standalone.sh and the desks actions so every entry point finds the same node.
# herdr may run us with a minimal PATH; append the usual install locations (Homebrew, ~/.local, nvm).
# install.sh carries the same search (it runs before any of these files is on the machine): keep the two alike.
# WHOSUP_EXTRA_PATH replaces the appended folders (empty = append nothing): the tests use it so that only the PATH they give is searched.
#
# Which node: the folders are tried in order (PATH, the appended folders, then nvm versions newest first and the fnm default) and
# the first node that is 22.13 or newer wins. When that is not the node PATH finds first (an older node sits in front, or none is
# on the PATH), its folder is put in front of PATH so that a plain `node` is the right one. A PATH whose first node is already
# good is left as it was. WHOSUP_NODE_PICK is the node picked (empty when none is good); WHOSUP_NODE_SEEN the first node found.
# standalone.sh sets WHOSUP_NODE_PINNED (the node picked at install time): when that one still passes the same test
# (whosup_node_ok: the file is there and it is 22.13 or newer) the search is skipped; when it does not, node is looked for again.
WHOSUP_APPEND_PATH="${WHOSUP_EXTRA_PATH-/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin${NVM_BIN:+:$NVM_BIN}:$HOME/.nvm/current/bin}"
[ -z "$WHOSUP_APPEND_PATH" ] || PATH="${PATH:+$PATH:}$WHOSUP_APPEND_PATH"
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
# whosup_node_dirs: PATH, then (unless WHOSUP_EXTRA_PATH is given) nvm versions by version number, newest first, and the fnm default
whosup_node_dirs() {
  whosup_dirs="${PATH:-}"
  [ -z "${WHOSUP_EXTRA_PATH+set}" ] || return 0
  if [ -d "$HOME/.nvm/versions/node" ]; then
    for whosup_v in $(ls "$HOME/.nvm/versions/node" 2>/dev/null | sed -n 's/^v\([0-9][0-9.]*\)$/\1/p' | sort -t. -k1,1nr -k2,2nr -k3,3nr); do
      whosup_dirs="$whosup_dirs:$HOME/.nvm/versions/node/v$whosup_v/bin"
    done
  fi
  for whosup_fnm in "${FNM_DIR:-}" "${XDG_DATA_HOME:-$HOME/.local/share}/fnm" "$HOME/Library/Application Support/fnm" "$HOME/.fnm"; do
    if [ -n "$whosup_fnm" ] && [ -x "$whosup_fnm/aliases/default/bin/node" ]; then whosup_dirs="$whosup_dirs:$whosup_fnm/aliases/default/bin"; fi
  done
}
# <<< node pick
if [ -n "${WHOSUP_NODE_PINNED:-}" ] && whosup_node_ok "$WHOSUP_NODE_PINNED"; then
  WHOSUP_NODE_PICK="$WHOSUP_NODE_PINNED"; WHOSUP_NODE_SEEN="$WHOSUP_NODE_PINNED"
else
  whosup_node_dirs
  if whosup_pick_node "$whosup_dirs" && [ "$(command -v node 2>/dev/null || true)" != "$WHOSUP_NODE_PICK" ]; then
    PATH="${WHOSUP_NODE_PICK%/node}:$PATH"
  fi
fi
export PATH
