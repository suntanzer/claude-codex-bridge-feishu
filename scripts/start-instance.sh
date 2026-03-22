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

# Restart policy: auto-restart on crash with back-off.
# Set CCMM_NO_RESPAWN=1 to disable auto-restart.
MAX_BACKOFF=60
MIN_UPTIME=10

mkdir -p "$LOG_DIR"

tmux has-session -t "$SESSION" 2>/dev/null && tmux kill-session -t "$SESSION" || true

INNER=$(cat <<'HEREDOC'
cd '__ROOT__'
set -a
export CCMM_INSTANCE='__INSTANCE__'
[[ -f '__COMMON_ENV__' ]] && source '__COMMON_ENV__' || true
source '__INSTANCE_ENV__'
: ${BRIDGE_DATA_DIR:='__LOG_DIR__'}
mkdir -p "$BRIDGE_DATA_DIR"
set +a

backoff=1
while true; do
  start_ts=$(date +%s)
  echo "[$(date '+%F %T')] starting instance=__INSTANCE__ pid=$$" | tee -a '__LOG_FILE__'
  node src/app/main.mjs 2>&1 | tee -a '__LOG_FILE__'
  exit_code=$?
  elapsed=$(( $(date +%s) - start_ts ))

  if [[ "${CCMM_NO_RESPAWN:-}" == "1" ]]; then
    echo "[$(date '+%F %T')] process exited code=$exit_code, respawn disabled" | tee -a '__LOG_FILE__'
    break
  fi

  if (( elapsed >= __MIN_UPTIME__ )); then
    backoff=1
  else
    backoff=$(( backoff * 2 ))
    (( backoff > __MAX_BACKOFF__ )) && backoff=__MAX_BACKOFF__
  fi

  echo "[$(date '+%F %T')] process exited code=$exit_code uptime=${elapsed}s, restarting in ${backoff}s..." | tee -a '__LOG_FILE__'
  sleep "$backoff"
done
HEREDOC
)

INNER="${INNER//__ROOT__/$ROOT}"
INNER="${INNER//__INSTANCE__/$INSTANCE}"
INNER="${INNER//__COMMON_ENV__/$COMMON_ENV}"
INNER="${INNER//__INSTANCE_ENV__/$INSTANCE_ENV}"
INNER="${INNER//__LOG_DIR__/$LOG_DIR}"
INNER="${INNER//__LOG_FILE__/$LOG_FILE}"
INNER="${INNER//__MIN_UPTIME__/$MIN_UPTIME}"
INNER="${INNER//__MAX_BACKOFF__/$MAX_BACKOFF}"

tmux new-session -d -s "$SESSION" "bash -lc $(printf '%q' "$INNER")"

sleep 2
echo "instance=$INSTANCE"
echo "session=$SESSION"
echo "log=$LOG_FILE"
