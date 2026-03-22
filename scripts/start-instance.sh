#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTANCE="${1:-}"

if [[ -z "$INSTANCE" ]]; then
  echo "usage: $0 <instance-name>" >&2
  exit 1
fi

COMMON_ENV="$ROOT/instances/common.env"
INSTANCE_ENV="$ROOT/instances/${INSTANCE}.env"

if [[ ! -f "$INSTANCE_ENV" ]]; then
  echo "missing instance env: $INSTANCE_ENV" >&2
  exit 1
fi

SESSION="ccmm-${INSTANCE}"
LOG_DIR="$ROOT/data/${INSTANCE}"
LOG_FILE="$LOG_DIR/bridge.log"

mkdir -p "$LOG_DIR"

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true

CMD="cd '$ROOT' && set -a && export CCMM_INSTANCE='$INSTANCE' && [[ -f '$COMMON_ENV' ]] && source '$COMMON_ENV' || true && source '$INSTANCE_ENV' && : \${BRIDGE_DATA_DIR:='$LOG_DIR'} && mkdir -p \"\$BRIDGE_DATA_DIR\" && set +a && node src/app/main.mjs 2>&1 | tee -a '$LOG_FILE'"
tmux new-session -d -s "$SESSION" "bash -lc $(
  printf '%q' "$CMD"
)"

sleep 2
echo "instance=$INSTANCE"
echo "session=$SESSION"
echo "log=$LOG_FILE"
