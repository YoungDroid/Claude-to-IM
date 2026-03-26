/**
 * Watchdog Deep Health Check
 *
 * Performs per-channel health checks that require JSON parsing or SDK interaction:
 *   1. Stuck streaming card detection (Feishu CardKit cards open > threshold)
 *   2. Claude CLI responsiveness probe
 *
 * Exit codes:
 *   0 — all healthy (or internal error; don't restart on internal error)
 *   1 — needs restart (stuck card or unresponsive CLI)
 *
 * Stdout messages:
 *   "OK"                      — all healthy
 *   "STUCK_STREAMING_CARD"    — a channel has a streaming card open > threshold
 *   "CLI_UNRESPONSIVE"        — Claude CLI did not respond to --version within timeout
 */

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import os from 'node:os';

const CTI_HOME = process.env.CTI_HOME || path.join(os.homedir(), '.claude-to-im');
const LOG_FILE = path.join(CTI_HOME, 'logs', 'bridge.log');
const STREAM_TIMEOUT_MS = Number(process.env.CTI_WATCHDOG_STREAM_TIMEOUT_SECS || '600') * 1000;
const CLI_PROBE_TIMEOUT_MS = 15000;

// ── Health checks ────────────────────────────────────────────

/**
 * Check for stuck streaming cards.
 *
 * Detects cards that were created (logged as "Streaming card created: cardId=X")
 * but never finalized (no "Card finalized: cardId=X" in log) within the timeout window.
 * We also skip cards whose creation timestamp is within the timeout window (they
 * might still be legitimately in progress).
 */
function checkStuckStreamingCard(): boolean {
  if (!fs.existsSync(LOG_FILE)) return false;

  try {
    // Only read the last portion of the log to avoid reading the entire file
    const stats = fs.statSync(LOG_FILE);
    const maxBytes = 5 * 1024 * 1024; // 5MB max
    const readStart = stats.size > maxBytes ? stats.size - maxBytes : 0;
    const fd = fs.openSync(LOG_FILE, 'r');
    const buffer = Buffer.alloc(stats.size - readStart);
    fs.readSync(fd, buffer, 0, buffer.length, readStart);
    fs.closeSync(fd);
    const logContent = buffer.toString('utf-8');
    const lines = logContent.split('\n');

    const now = Date.now();
    const cutoff = now - STREAM_TIMEOUT_MS;

    // Match: "Streaming card created: cardId=XXX, msgId=YYY"
    const createdRE = /\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z)\].*Streaming card created: cardId=(\d+)/;
    // Match: "Card finalized: cardId=XXX, status=completed, elapsed=T"
    const finalizedRE = /Card finalized: cardId=(\d+)/;

    const activeCards = new Map<string, number>(); // cardId -> creation timestamp

    for (const line of lines) {
      const created = line.match(createdRE);
      if (created) {
        const timestamp = new Date(created[1]).getTime();
        if (!isNaN(timestamp)) {
          activeCards.set(created[2], timestamp);
        }
        continue;
      }

      const finalized = line.match(finalizedRE);
      if (finalized) {
        activeCards.delete(finalized[1]);
      }
    }

    // Find cards that are older than the timeout threshold
    for (const [cardId, createdAt] of activeCards.entries()) {
      if (createdAt < cutoff) {
        console.log(`[watchdog-health] Stuck card detected: cardId=${cardId}, createdAt=${new Date(createdAt).toISOString()}, age=${Math.round((now - createdAt) / 1000)}s`);
        return true;
      }
    }

    return false;
  } catch (err) {
    console.warn('[watchdog-health] Error checking stuck cards:', err);
    return false;
  }
}

/**
 * Check for stuck Claude CLI sessions.
 *
 * Detects Claude CLI processes that are children of the bridge daemon and have
 * been running longer than the stream timeout threshold. These are sessions that
 * appear to be hung (waiting for input, blocked on API call, etc.).
 */
function checkStuckCliSessions(): boolean {
  const CTI_HOME = process.env.CTIM_HOME || path.join(os.homedir(), '.claude-to-im');
  const BRIDGE_PID_FILE = path.join(CTI_HOME, 'runtime', 'bridge.pid');
  const STUCK_THRESHOLD_MS = STREAM_TIMEOUT_MS;

  let bridgePid: string | null = null;
  try {
    if (fs.existsSync(BRIDGE_PID_FILE)) {
      bridgePid = fs.readFileSync(BRIDGE_PID_FILE, 'utf-8').trim();
    }
  } catch {
    // Can't read bridge PID file, skip child process check
  }

  if (!bridgePid) {
    return false;
  }

  try {
    // Get all Claude CLI processes
    const output = execSync('ps -eo pid,ppid,etime,cmd --no-headers 2>/dev/null || true', {
      encoding: 'utf-8',
      timeout: 5000,
    });

    const lines = output.trim().split('\n');
    const now = Date.now();
    let hasStuckProcess = false;

    for (const line of lines) {
      if (!line.includes('claude')) continue;

      // Parse: PID PPID ELAPSED CMD
      const parts = line.trim().split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parts[0];
      const ppid = parts[1];
      const elapsed = parts[2]; // format: [[dd-]hh:]mm:ss
      const cmd = parts.slice(3).join(' ');

      // Only check processes that are children of the bridge daemon
      if (ppid !== bridgePid) continue;

      // Skip the watchdog's own probe process
      if (cmd.includes('watchdog-health')) continue;

      // Parse elapsed time to milliseconds
      const elapsedMs = parseElapsedTime(elapsed);
      if (elapsedMs > STUCK_THRESHOLD_MS) {
        console.warn(`[watchdog-health] Stuck Claude CLI detected: PID=${pid}, elapsed=${elapsed}, cmd=${cmd.substring(0, 60)}`);
        hasStuckProcess = true;
      }
    }

    return hasStuckProcess;
  } catch (err) {
    console.warn('[watchdog-health] Error checking stuck CLI sessions:', err);
    return false;
  }
}

/**
 * Parse ps etime format to milliseconds.
 * Format: [[dd-]hh:]mm:ss
 */
function parseElapsedTime(etime: string): number {
  const parts = etime.split(':').map(Number);
  if (parts.length === 3) {
    // mm:ss — minutes and seconds
    return (parts[0] * 60 + parts[1]) * 1000;
  } else if (parts.length === 2) {
    // hh:mm:ss — hours, minutes, seconds
    return ((parts[0] * 60 + parts[1]) * 60 + parts[2]) * 1000;
  } else if (etime.includes('-')) {
    // dd-hh:mm:ss — days, hours, minutes, seconds
    const [dd, timePart] = etime.split('-');
    const [hh, mm, ss] = timePart.split(':').map(Number);
    return ((parseInt(dd, 10) * 24 + hh) * 60 + mm) * 60 * 1000 + ss * 1000;
  }
  return 0;
}

/**
 * Check Claude CLI responsiveness (legacy check).
 *
 * Runs `claude --version` with a short timeout. This catches cases where
 * the CLI binary itself is broken. Combined with checkStuckCliSessions()
 * which catches hung sessions.
 */
function checkCliResponsive(): boolean {
  const cliPath = process.env.CTI_CLAUDE_CODE_EXECUTABLE || 'claude';

  try {
    execSync(`"${cliPath}" --version`, {
      encoding: 'utf-8',
      timeout: CLI_PROBE_TIMEOUT_MS / 1000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return false; // CLI is responsive
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
      console.warn('[watchdog-health] CLI probe timed out — CLI is unresponsive');
    } else {
      console.warn('[watchdog-health] CLI probe failed:', err);
    }
    return true; // CLI is NOT responsive
  }
}

// ── Main ─────────────────────────────────────────────────────

async function main(): Promise<void> {
  let needsRestart = false;

  if (checkStuckStreamingCard()) {
    process.stdout.write('STUCK_STREAMING_CARD\n');
    needsRestart = true;
  }

  // Check for stuck Claude CLI sessions first (more accurate than --version probe)
  if (checkStuckCliSessions()) {
    process.stdout.write('CLI_UNRESPONSIVE\n');
    needsRestart = true;
  } else if (checkCliResponsive()) {
    // Only check --version if no stuck sessions found (legacy fallback)
    process.stdout.write('CLI_UNRESPONSIVE\n');
    needsRestart = true;
  }

  if (!needsRestart) {
    process.stdout.write('OK\n');
  }

  process.exit(needsRestart ? 1 : 0);
}

main().catch((err) => {
  console.error('[watchdog-health] Fatal error:', err);
  process.exit(0); // Don't restart on internal error
});
