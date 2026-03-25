import * as esbuild from 'esbuild';

const SKILL_DIR = process.cwd();

// Build main daemon
await esbuild.build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/daemon.mjs',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
  banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
});

console.log('Built dist/daemon.mjs');

// Build watchdog health check
await esbuild.build({
  entryPoints: ['src/watchdog-health.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/watchdog-health.mjs',
  external: [
    '@anthropic-ai/claude-agent-sdk',
    '@openai/codex-sdk',
    'bufferutil', 'utf-8-validate', 'zlib-sync', 'erlpack',
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls',
    'stream', 'events', 'url', 'util', 'child_process', 'worker_threads',
    'node:*',
  ],
});

console.log('Built dist/watchdog-health.mjs');
