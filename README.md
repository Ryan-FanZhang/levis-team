# 工位小队 · pi 原型

3D 办公室界面 + [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) agent 后端。
你给经理派活，经理（一个只能"派活"的 pi 会话）把任务拆给同事（各自独立的 pi 会话），
页面上的每个动画都对应后端真实发生的事件。

## 运行

```bash
npm install
npm run mock      # 模拟模型，不需要 API key，用来看整个流程
npm start         # 真实模型
```

打开 http://localhost:5180

真实模型的凭据（三选一）：
- 环境变量：`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / … （pi 支持的都行）
- 运行 `npx pi`，在里面 `/login`，凭据存到 `~/.pi/agent/auth.json`，这里会自动复用
- 指定模型：`OFFICE_MODEL=anthropic/claude-sonnet-5-5`，同事可单独用便宜模型：`OFFICE_WORKER_MODEL=anthropic/claude-haiku-5-5`

其他环境变量：`PORT`（默认 5180）、`OFFICE_WORKSPACE`（同事能操作的目录，默认 `./workspace`）。

## 结构

| 文件 | 作用 |
|---|---|
| `src/roster.ts` | 同事名单：名字、颜色、工位、能用的工具、提示词。**加人就改这里** |
| `src/office.ts` | 编排：经理会话 + `delegate` 工具、每个同事的会话、审批与路径守卫 |
| `src/events.ts` | 后端 ↔ 页面的事件协议 |
| `src/mock.ts` | 脚本化的假模型（pi-ai 的 faux provider） |
| `src/server.ts` | HTTP + WebSocket，只监听 127.0.0.1 |
| `public/index.html` | 3D 页面；连不上后端时自动退回演示模式 |

## 事件 → 动画

| 事件 | 页面上 |
|---|---|
| `task_received` | 经理说"收到" |
| `delegate` | 经理走到同事工位，拍肩、交代任务 |
| `worker_step` | 同事屏幕和气泡显示当前步骤（读取 / 写入 / 打开网页…） |
| `need_approval` | 同事举手，下方出现"同意 / 拒绝"卡片 |
| `worker_done` | 同事举手庆祝，日志里出现汇报 |
| `manager_reply` | 右侧"经理汇报"显示最终总结 |

## 安全边界（原型级）

- 同事的文件工具只能访问工作目录，越界路径直接拦截
- `write` / `edit` / `bash` 每次都要你在页面上点同意（10 分钟无响应视为拒绝）
- 目前没有给任何同事 `bash` 工具；`fetch_url` 只做 GET
- WebSocket 只接受本页面来源的连接，防止别的网站驱动你的 agent

## 下一步可以做

- 加同事：在 `roster.ts` 里加一项（6 个工位，现在用了 2 个）
- 接 MCP：pi 的 `createMcpExtension()`，给对应同事挂上
- 长期记忆、定时任务、手机入口（Telegram / 飞书机器人往 `office.submit()` 里投任务）
- 用 Electron / Tauri 打包成桌面应用
