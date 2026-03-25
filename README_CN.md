# Claude-to-IM Skill

将 Claude Code / Codex 桥接到 IM 平台 —— 在 Telegram、Discord、飞书或 QQ 中与 AI 编程代理对话。

[English](README.md)

---

## 新增功能

- **`/clear`** — 清空当前会话上下文，重新开始对话
- **`/compact`** — 触发 Claude CLI 上下文压缩
- **`/stop`** — 中断当前正在执行的任务
- **流式输出** — 飞书、Telegram、Discord 实时预览 AI 回复
- **权限控制** — 工具调用内联审批按钮（飞书、Telegram、Discord）
- **PDF 识别** — 直接在对话中上传 PDF 文件进行分析
- **权限跳过** — 使用 `/perm allow <id>` 预先批准或跳过特定工具调用

---

## 工作原理

本 Skill 运行一个后台守护进程，将你的 IM 机器人连接到 Claude Code 或 Codex 会话。来自 IM 的消息被转发给 AI 编程代理，响应（包括工具调用、权限请求、流式预览）会发回到聊天中。

```
你 (Telegram/Discord/飞书/QQ)
  ↕ Bot API
后台守护进程 (Node.js)
  ↕ Claude Agent SDK 或 Codex SDK（通过 CTI_RUNTIME 配置）
Claude Code / Codex → 读写你的代码库
```

## 功能特点

- **四大 IM 平台** — Telegram、Discord、飞书、QQ，可任意组合启用
- **交互式配置** — 引导式向导逐步收集 token，附带详细获取说明
- **流式预览** — 实时查看 Claude 的输出（飞书卡片、Telegram、Discord 支持）
- **权限控制** — 工具调用需要在聊天中通过内联按钮或 `/perm` 命令批准
- **PDF 识别** — 直接在对话中上传 PDF 文件进行分析
- **会话持久化** — 对话在守护进程重启后保留
- **密钥保护** — token 以 `chmod 600` 存储，日志中自动脱敏
- **Watchdog 守护** — 进程崩溃或卡死时自动重启

## 前置要求

- **Node.js >= 20**
- **Claude Code CLI**（`CTI_RUNTIME=claude` 或 `auto` 模式）— 已安装并认证（`claude` 命令可用）
- **Codex CLI**（`CTI_RUNTIME=codex` 或 `auto` 模式）— `npm install -g @openai/codex`

## 安装

### npx skills（推荐）

```bash
npx skills add YoungDroid/Claude-to-IM-skill
```

### Git 克隆

```bash
git clone https://github.com/YoungDroid/Claude-to-IM-skill.git ~/.claude/skills/claude-to-im
cd ~/.claude/skills/claude-to-im
npm install
```

## 命令

| 命令 | 说明 |
|------|------|
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

MIT（与原项目相同）
