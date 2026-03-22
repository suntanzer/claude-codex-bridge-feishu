#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:-}"

if [[ -z "$INSTANCE" ]]; then
  echo "usage: $0 <instance-name>" >&2
  exit 1
fi

SESSION="ccmm-${INSTANCE}"
LOG_FILE="$ROOT/data/${INSTANCE}/bridge.log"

echo "instance=$INSTANCE"
echo "session=$SESSION"
tmux has-session -t "$SESSION" 2>/dev/null && echo "tmux=running" || echo "tmux=stopped"

if [[ -f "$LOG_FILE" ]]; then
  echo "--- log tail ---"
  tail -n 40 "$LOG_FILE"
fi
