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
 * Check Claude CLI responsiveness.
 *
 * Runs `claude --version` with a short timeout. If it fails or times out,
 * the CLI is hung (e.g., waiting for auth, blocked by a hanging subprocess).
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

  if (checkCliResponsive()) {
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
