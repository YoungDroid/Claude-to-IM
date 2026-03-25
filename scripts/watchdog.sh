#!/usr/bin/env bash
# Watchdog daemon for claude-to-im bridge.
# Runs as an external process — survives bridge hangs — and auto-restarts the bridge.
set -euo pipefail

CTI_HOME="${CTI_HOME:-$HOME/.claude-to-im}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WATCHDOG_PID_FILE="$CTI_HOME/runtime/watchdog.pid"
BRIDGE_PID_FILE="$CTI_HOME/runtime/bridge.pid"
STATUS_FILE="$CTI_HOME/runtime/status.json"
LOG_FILE="$CTI_HOME/logs/bridge.log"
STATS_FILE="$CTI_HOME/runtime/watchdog-stats.json"
HEALTH_CHECK_SCRIPT="$SKILL_DIR/dist/watchdog-health.mjs"
WATCHDOG_LOG_FILE="$CTI_HOME/logs/watchdog.log"

# Load config (set -a makes all CTI_* vars available)
[ -f "$CTI_HOME/config.env" ] && set -a && source "$CTI_HOME/config.env" && set +a

# ── Defaults ─────────────────────────────────────────────────
CHECK_INTERVAL="${CTI_WATCHDOG_CHECK_INTERVAL:-60}"
WS_LOOKBACK_LINES="${CTI_WATCHDOG_WS_LOOKBACK:-200}"
MAX_RESTARTS_PER_HOUR="${CTI_WATCHDOG_MAX_RESTARTS_PER_HOUR:-10}"
DEEP_CHECK_EVERY="${CTI_WATCHDOG_DEEP_CHECK_EVERY:-3}"
STREAM_TIMEOUT_SECS="${CTI_WATCHDOG_STREAM_TIMEOUT_SECS:-600}"
WATCHDOG_ENABLED="${CTI_WATCHDOG_ENABLED:-true}"
# Grace period after startup before WS/stuck-card checks become active (seconds)
START_GRACE_PERIOD="${CTI_WATCHDOG_START_GRACE_PERIOD:-120}"

# ── Helpers ──────────────────────────────────────────────────

ensure_dirs() { mkdir -p "$CTI_HOME"/{data,logs,runtime,data/messages}; }

read_pid() { [ -f "$1" ] && cat "$1" 2>/dev/null || echo ""; }

pid_alive() { local pid="$1"; [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; }

log() { echo "[$(date -u '+%Y-%m-%dT%H:%M:%SZ')] [watchdog] $*" >> "$WATCHDOG_LOG_FILE"; }

# ── Rate limiting ────────────────────────────────────────────

load_stats() {
  if [ -f "$STATS_FILE" ]; then
    cat "$STATS_FILE" 2>/dev/null || echo '{"restarts":[]}'
  else
    echo '{"restarts":[]}'
  fi
}

save_stats() { echo "$1" | tee "$STATS_FILE" > /dev/null; }

can_restart() {
  local stats="$1"
  local now
  now=$(date '+%s')
  local cutoff=$((now - 3600))

  local count
  count=$(echo "$stats" | grep -oE '"timestamp":[0-9]+' 2>/dev/null | grep -oE '[0-9]+' | while read -r ts; do [ "$ts" -gt "$cutoff" ] && echo "$ts"; done | wc -l)
  [ "${count:-0}" -lt "$MAX_RESTARTS_PER_HOUR" ]
}

record_restart() {
  local stats="$1"
  local now
  now=$(date '+%s')
  local cutoff=$((now - 3600))

  # Keep only entries from the last hour
  local new_entries
  new_entries=$(echo "$stats" | grep -oE '"timestamp":[0-9]+' 2>/dev/null | grep -oE '[0-9]+' | while read -r ts; do
    [ "$ts" -gt "$cutoff" ] && echo "  { \"timestamp\": $ts }"
  done | paste -sd ',' | tr '\t' ',')

  local final_entries
  if [ -z "$new_entries" ]; then
    final_entries="  { \"timestamp\": $now }"
  else
    final_entries="$new_entries,  { \"timestamp\": $now }"
  fi

  save_stats "{\"restarts\":[$final_entries]}"
}

# ── Health checks ─────────────────────────────────────────────

check_bridge_pid_gone() {
  local bridge_pid
  bridge_pid=$(read_pid "$BRIDGE_PID_FILE")

  if [ -n "$bridge_pid" ] && ! pid_alive "$bridge_pid"; then
    log "Bridge PID $bridge_pid is dead but PID file exists — bridge crashed"
    return 0
  fi

  if [ -z "$bridge_pid" ] && [ -f "$STATUS_FILE" ]; then
    if grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null; then
      log "Bridge PID file missing but status.json reports running=true — unclean shutdown"
      return 0
    fi
  fi

  return 1
}

check_websocket_timeout() {
  if ! [ -f "$LOG_FILE" ]; then return 1; fi

  local timeout_count
  timeout_count=$(tail -n "$WS_LOOKBACK_LINES" "$LOG_FILE" 2>/dev/null | grep -cE '\[ws\].*timeout of [0-9]+ms exceeded' || true)

  local reconnect_count
  reconnect_count=$(tail -n "$WS_LOOKBACK_LINES" "$LOG_FILE" 2>/dev/null | grep -cE '\[ws\].*reconnect' || true)

  if [ "$timeout_count" -ge 3 ] || [ "$reconnect_count" -ge 10 ]; then
    log "WebSocket stuck (timeouts: $timeout_count, reconnects: $reconnect_count in last $WS_LOOKBACK_LINES log lines)"
    return 0
  fi

  return 1
}

run_deep_health_check() {
  if ! [ -f "$HEALTH_CHECK_SCRIPT" ]; then
    log "Deep health check script not found: $HEALTH_CHECK_SCRIPT"
    return 1
  fi

  local result
  result=$(CTI_HOME="$CTI_HOME" CTI_WATCHDOG_STREAM_TIMEOUT_SECS="$STREAM_TIMEOUT_SECS" \
    CTI_CLAUDE_CODE_EXECUTABLE="${CTI_CLAUDE_CODE_EXECUTABLE:-claude}" \
    node "$HEALTH_CHECK_SCRIPT" 2>&1) || true

  log "Deep health check result: ${result:-<empty>}"

  case "$result" in
    *STUCK_STREAMING_CARD*)
      log "Detected stuck streaming card — needs restart"
      return 0
      ;;
    *CLI_UNRESPONSIVE*)
      log "Claude CLI is unresponsive — killing stuck CLI processes"
      pkill -f "claude.*agent" 2>/dev/null || true
      sleep 2
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

# ── Recovery ─────────────────────────────────────────────────

send_feishu_notification() {
  local reason="$1"

  # Check if Feishu is configured
  if [ -z "${CTI_FEISHU_APP_ID:-}" ] || [ -z "${CTI_FEISHU_APP_SECRET:-}" ]; then
    log "Feishu not configured, skipping notification"
    return
  fi

  local message="[Watchdog] Bridge 自动重启已完成 (trigger: $reason)"

  # Get tenant access token
  local token_response
  token_response=$(curl -s -X POST \
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal" \
    -H "Content-Type: application/json" \
    -d "{\"app_id\": \"$CTI_FEISHU_APP_ID\", \"app_secret\": \"$CTI_FEISHU_APP_SECRET\"}" 2>/dev/null) || true

  local token
  token=$(echo "$token_response" | grep -oE '"tenant_access_token":"[^"]+"' 2>/dev/null | sed 's/"tenant_access_token":"//;s/"$//')

  if [ -z "$token" ]; then
    log "Failed to get Feishu tenant access token"
    return
  fi

  # Send message to user (use send_id_type=user_id for user DM)
  local user_id="${CTI_FEISHU_ALLOWED_USERS%%,*}"

  if [ -n "$user_id" ]; then
    curl -s -X POST \
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=user_id" \
      -H "Authorization: Bearer $token" \
      -H "Content-Type: application/json" \
      -d "{\"receive_id\": \"$user_id\", \"msg_type\": \"text\", \"content\": \"{\\\"text\\\": \\\"$message\\\"}\"}" >> "$WATCHDOG_LOG_FILE" 2>&1 || true
    log "Feishu notification sent"
  fi
}

restart_bridge() {
  local reason="$1"

  log "Initiating bridge restart (reason: $reason)"

  local stats
  stats=$(load_stats)

  if ! can_restart "$stats"; then
    log "RESTART RATE LIMIT HIT — skipping restart (max $MAX_RESTARTS_PER_HOUR/hour)"
    return 1
  fi

  # Kill the bridge process and all its children
  local bridge_pid
  bridge_pid=$(read_pid "$BRIDGE_PID_FILE")
  if [ -n "$bridge_pid" ]; then
    # Step 1: SIGTERM first (allow graceful shutdown — SDK abort handlers run)
    # Use process group kill to cover all children of the bridge
    kill -TERM -"$bridge_pid" 2>/dev/null || true
    kill -TERM "$bridge_pid" 2>/dev/null || true

    # Wait up to 5s for graceful exit
    for i in $(seq 1 5); do
      if ! kill -0 "$bridge_pid" 2>/dev/null; then
        break
      fi
      sleep 1
    done

    # Step 2: SIGKILL if still alive (force kill after grace period)
    if kill -0 "$bridge_pid" 2>/dev/null; then
      kill -9 -"$bridge_pid" 2>/dev/null || true
      kill -9 "$bridge_pid" 2>/dev/null || true
    fi

    # Step 3: Clean up orphaned claude processes that got reparented to init (PPID=1)
    # These are claude CLI processes that were children of the bridge daemon.
    # We identify them by: PPID=1 (reparented after hard kill) + no controlling TTY
    # This avoids killing the user's own claude sessions which have a TTY.
    for pid in $(pgrep -x claude 2>/dev/null || true); do
      local pppid
      pppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ' || echo "1")
      local tty
      tty=$(ps -o tty= -p "$pid" 2>/dev/null | tr -d ' ' || echo "?")
      # Only kill if: reparented to init (PPID=1) and no TTY (not a user session)
      if [ "$pppid" = "1" ] && [ "$tty" = "?" ]; then
        kill -9 "$pid" 2>/dev/null || true
      fi
    done
  fi
  rm -f "$BRIDGE_PID_FILE" "$STATUS_FILE" 2>/dev/null || true

  # Small delay to let ports/release resources
  sleep 3

  # Start bridge directly with node — daemon.mjs daemonizes itself via setsid internally
  log "Starting bridge..."
  node "$SKILL_DIR/dist/daemon.mjs" >> "$LOG_FILE" 2>&1 &
  # Wait for daemon.mjs to write its real PID (it does this on startup)
  sleep 2

  # Wait for bridge to come up (poll for up to 15s)
  local started=false
  for _ in $(seq 1 15); do
    if [ -f "$STATUS_FILE" ] && grep -q '"running"[[:space:]]*:[[:space:]]*true' "$STATUS_FILE" 2>/dev/null; then
      started=true
      break
    fi
    sleep 1
  done

  if [ "$started" = "true" ]; then
    local new_pid
    new_pid=$(read_pid "$BRIDGE_PID_FILE")
    log "Bridge restarted successfully (PID: $new_pid)"
    record_restart "$stats"
    send_feishu_notification "$reason"
  else
    log "Bridge restart failed — bridge did not come up"
    return 1
  fi
}

# ── Main loop ────────────────────────────────────────────────

main_loop() {
  local cycle=0
  local start_time
  start_time=$(date '+%s')
  log "Starting watchdog loop (check interval: ${CHECK_INTERVAL}s, grace period: ${START_GRACE_PERIOD}s, enabled: $WATCHDOG_ENABLED)"

  if [ "$WATCHDOG_ENABLED" != "true" ]; then
    log "Watchdog is disabled (CTI_WATCHDOG_ENABLED != true)"
    return
  fi

  while true; do
    cycle=$((cycle + 1))
    local needs_restart=0
    local restart_reason=""
    local now
    now=$(date '+%s')
    local elapsed=$((now - start_time))
    local in_grace=$([ "$elapsed" -lt "$START_GRACE_PERIOD" ] && echo 1 || echo 0)

    if check_bridge_pid_gone; then
      needs_restart=1
      restart_reason="bridge_pid_gone"
    fi

    # Skip log-based checks during grace period (old log entries may contain stale WS errors)
    if [ "$in_grace" = "0" ]; then
      if check_websocket_timeout; then
        needs_restart=1
        restart_reason="ws_timeout"
      fi

      # Run deep health check every DEEP_CHECK_EVERY cycles (only after grace period)
      if [ $((cycle % DEEP_CHECK_EVERY)) -eq 0 ]; then
        if run_deep_health_check; then
          needs_restart=1
          restart_reason="${restart_reason:-deep_check}"
        fi
      fi
    else
      log "Grace period active (${elapsed}s/${START_GRACE_PERIOD}s) — skipping log-based checks"
    fi

    if [ "$needs_restart" -eq 1 ]; then
      restart_bridge "$restart_reason" || log "restart_bridge returned $? — continuing"
    fi

    sleep "$CHECK_INTERVAL"
  done
}

# ── Entry point ───────────────────────────────────────────────

ensure_dirs

# Ensure we are not already running
WATCHDOG_SELF=$(read_pid "$WATCHDOG_PID_FILE")
if [ -n "$WATCHDOG_SELF" ] && pid_alive "$WATCHDOG_SELF" && [ "$$" != "$WATCHDOG_SELF" ]; then
  echo "Watchdog already running (PID: $WATCHDOG_SELF)"
  exit 1
fi

# Write our PID
echo $$ > "$WATCHDOG_PID_FILE"

# Clean PID file on exit
trap 'rm -f "$WATCHDOG_PID_FILE"; exit' EXIT INT TERM HUP

# Redirect all output to watchdog log
exec >> "$WATCHDOG_LOG_FILE" 2>&1

main_loop
