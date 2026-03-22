#!/usr/bin/env bash
set -euo pipefail

INSTANCE="${1:-}"

if [[ -z "$INSTANCE" ]]; then
  echo "usage: $0 <instance-name>" >&2
  exit 1
fi

SESSION="ccmm-${INSTANCE}"
tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION"

echo "stopped $INSTANCE"
