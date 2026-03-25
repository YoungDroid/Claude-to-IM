# Claude-to-IM Skill

Bridge Claude Code / Codex to IM platforms — chat with AI coding agents from Telegram, Discord, Feishu/Lark, or QQ.

> **基于 [op7418/claude-to-IM](https://github.com/op7418/claude-to-im)（官方）魔改。**
> 原项目地址：[github.com/op7418/claude-to-im](https://github.com/op7418/claude-to-im)
>
> 本仓库为活跃维护版本，持续更新中。

[中文文档](README_CN.md)

---

## 新增功能 / New Features

- **`/clear`** — 清空当前会话上下文，重新开始对话
- **`/compact`** — 触发 Claude CLI 上下文压缩
- **飞书停止按钮** — Streaming card 右下角 ⏹ 停止按钮，可随时中断正在执行的任务

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
- **Permission control** — tool calls require explicit approval via inline buttons (Telegram/Discord) or text `/perm` commands (Feishu/QQ)
- **Streaming preview** — see Claude's response as it types (Telegram & Discord)
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
