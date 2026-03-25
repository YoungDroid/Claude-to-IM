# Claude-to-IM Skill

Bridge Claude Code / Codex to IM platforms — chat with AI coding agents from Telegram, Discord, Feishu/Lark, or QQ.

[中文文档](README_CN.md)

---

## New Features

- **`/clear`** — Clear current session context and start fresh
- **`/compact`** — Trigger Claude CLI context compression
- **`/stop`** — Interrupt the currently running task
- **Streaming output** — Real-time response preview on Feishu, Telegram, Discord
- **Permission control** — Inline approve/deny buttons for tool calls (Feishu, Telegram, Discord)
- **PDF recognition** — Upload PDF files directly in chat for analysis
- **Permission skip** — Use `/perm allow <id>` to pre-approve or skip specific tool calls

---

## How It Works

This skill runs a background daemon that connects your IM bots to Claude Code or Codex sessions. Messages from IM are forwarded to the AI coding agent, and responses (including tool use, permission requests, streaming previews) are sent back to your chat.

```
You (Telegram/Discord/Feishu/QQ)
  ↕ Bot API
Background Daemon (Node.js)
  ↕ Claude Agent SDK or Codex SDK (configurable via CTI_RUNTIME)
Claude Code / Codex → reads/writes your codebase
```

## Features

- **Four IM platforms** — Telegram, Discord, Feishu/Lark, QQ — enable any combination
- **Interactive setup** — guided wizard collects tokens with step-by-step instructions
- **Streaming preview** — see Claude's response as it types (Feishu, Telegram & Discord)
- **Permission control** — tool calls require explicit approval via inline buttons (Feishu/Telegram/Discord) or text `/perm` commands (QQ)
- **PDF recognition** — upload PDF files directly in chat for analysis
- **Session persistence** — conversations survive daemon restarts
- **Secret protection** — tokens stored with `chmod 600`, auto-redacted in all logs
- **Watchdog daemon** — auto-restart bridge on crash/hang

## Prerequisites

- **Node.js >= 20**
- **Claude Code CLI** (for `CTI_RUNTIME=claude` or `auto`) — installed and authenticated (`claude` command available)
- **Codex CLI** (for `CTI_RUNTIME=codex` or `auto`) — `npm install -g @openai/codex`. Auth: run `codex auth login`, or set `OPENAI_API_KEY` (optional, for API mode)

## Installation

### npx skills (recommended)

```bash
npx skills add YoungDroid/Claude-to-IM-skill
```

### Git clone

```bash
git clone https://github.com/YoungDroid/Claude-to-IM-skill.git ~/.claude/skills/claude-to-im
cd ~/.claude/skills/claude-to-im
npm install
```

## Commands

| Command | Description |
|---------|-------------|
| `/new [path]` | 创建新会话 |
| `/clear` | 清空上下文，重新开始 |
| `/bind <session_id>` | 绑定已有会话 |
| `/cwd /path` | 切换工作目录 |
| `/mode plan\|code\|ask` | 切换模式 |
| `/status` | 显示状态 |
| `/sessions` | 列出最近会话 |
| `/stop` | 停止当前任务 |
| `/compact` | 压缩上下文（调用 CLI） |
| `/perm allow\|deny <id>` | 权限审批 |
| `/help` | 显示帮助 |

## License

MIT (same as original project)
