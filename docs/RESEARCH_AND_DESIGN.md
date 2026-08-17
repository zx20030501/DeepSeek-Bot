# DeepSeek-Bot：Hermes Bot 能力调研与改进设计

更新时间：2026-08-17

## 1. 结论先行

`DeepSeek-Bot` 当前是空仓库，因此本项目第一版不修改 DeepSeek Harness 上游源码，而是实现一个可通过 `dsh plugin` 安装的 Cordis 插件：

```text
Telegram / 其他平台适配器
          │
          ▼
入站去重 → Inbound WAL → 每会话串行队列 → ctx.agents
                                      │
                                      ▼
                         session/event 监听
                                      │
                                      ▼
                           Outbox → 平台发送
```

这样可以同时获得 Hermes 的 Bot 使用体验与 DSH 的原生会话、Agent、工具和事件模型，避免维护一份与 DSH 核心分叉的 Agent Loop。

## 2. GitHub 调研结果

### Hermes Agent

上游仓库：<https://github.com/NousResearch/hermes-agent>

Hermes 当前的 Bot 能力可以分成两层：

1. **消息网关层**：Telegram、Discord、Slack、WhatsApp、Signal 等渠道；会话连续性、媒体、命令、cron 投递、访问控制、重连和多平台路由。
2. **Bot Mode / Agent roster 层**：一个 profile 对应一个 Bot，固定的 canonical chat、未读活动、Bot 间 @mention、群聊房间、Routine、头像/宠物、MCP/Skill 配置和多网关 roster。

真正值得迁移的不是 Hermes 的 Python 平台类，而是这些可靠性不变量：

- 入站请求在交给 Agent 前先持久化；崩溃后可以有限次数补发。
- 出站发送走持久 Outbox；发送成功后才确认，允许 at-least-once，而不是假设网络调用绝对成功。
- 更新 ID、事件序号和出站幂等键都要去重。
- 一个聊天目标对应一个稳定会话，多个消息不得并发写入同一 Agent。
- 命令、普通消息和 DSH 原生命令分流；未知命令不能被静默丢弃。
- 访问控制必须在入站边界执行，默认不把 Bot 暴露为开放中继。

### DeepSeek Harness

上游仓库：<https://github.com/deepseek-ai/deepseek-harness>

DSH 的官方扩展边界是：

- Cordis 插件导出 `name` 与 `apply(ctx)`。
- 用 `ctx.agents` 创建、恢复和查找 Agent。
- 用 `agent.followup()` 把外部用户消息作为新的回合交给 Agent。
- 监听 `session/event`，从 `assistant/message` 获取模型输出。
- 用 `ctx.commands.execute(agent, line, signal)` 复用已安装的 DSH 原生命令。
- 需要后台工作时使用 `ctx.jobs`，而不是自建一个平行 Agent Loop。

因此本项目把平台层做成独立接口，把 DSH 只当作一个可替换的 Agent Runtime。

### 已有社区实现

| 项目 | 已解决的问题 | 对本项目的启发 |
| --- | --- | --- |
| [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link) | 飞书双向桥、Inbound WAL、持久 Outbox、幂等、媒体、确认卡片、诊断 ZIP、会话恢复 | 可靠性需要入站和出站两本账，且诊断能力必须内置 |
| [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel) | Telegram 长轮询、每聊天会话、历史读取、模型选择按钮 | Telegram 适配器可先用零原生依赖实现，平台逻辑不能污染 Agent 层 |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | 持久子 Agent、依赖任务、直接消息、状态恢复和 Web UI | Bot-to-Bot 应建立在 DSH 原生 Agent/消息边界上，而不是共享全局变量 |
| [GengDaPeng/dsh-agent-message](https://github.com/GengDaPeng/dsh-agent-message) | 跨会话发现、离线投递、回执、发送方导航 | 后续可把 Bot 目标与 DSH 会话目标统一为带回执的 mailbox |
| [Cavan-Ou/hermes-dsh-collab](https://github.com/Cavan-Ou/hermes-dsh-collab) | Hermes 派单、DSH 执行、质量门、Git 单一写者 | Hermes 负责编排时必须有 scope、测试和单写者约束 |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | 插件市场，含 `hermes-dsh-collab`、Telegram、飞书、消息中心等条目 | 不复制一个巨型 fork，保持标准 `dsh.bundle` 插件分发 |

## 3. 比直接移植更好的方案

### 3.1 分层

```text
Transport        Telegram、Feishu、Discord、Webhook
                 只负责收发和平台限制

Delivery         Dedupe、Inbound WAL、Outbox、重试、lane 串行化
                 只负责可靠消息投递

Routing          chat → profile → stable session id
                 只负责绑定和权限

Harness Adapter  ctx.agents、agent.followup、session/event、DSH commands
                 只负责调用 DeepSeek Harness
```

每层都能单独测试。新增平台时只需实现 Transport，不需要复制会话、重试和安全逻辑。

### 3.2 第一版实施范围

第一版包含：

- Telegram Bot API 长轮询；
- 每聊天/线程稳定 DSH session；
- Inbound WAL、更新去重、Outbox、幂等键、指数退避、死信状态；
- `/new`、`/stop`、`/status`、`/help`、`/bots`、`/bot <name>`、`/model`；
- DSH 原生命令优先执行，未知 `/xxx` 仍交给 Agent；
- Telegram 4096 字符切片、typing、访问 allowlist；
- 通过 `session/event` 把模型文本回传 Telegram；
- crash/restart 后有限次数恢复未完成入站请求；
- 单元测试、插件配置示例和运行手册。

暂不在第一版硬塞入：

- Discord Gateway、飞书长连接和 WhatsApp 多协议；
- 图片生成、宠物头像、桌面 Bot roster UI；
- 自建 cron 引擎；优先复用 DSH 的 command/jobs/schedule seam；
- 自动放开 Full Access。权限由 DSH profile 和 Bot allowlist 共同决定。

这些能力会作为后续适配器或 UI 插件增加，而不是让核心可靠性代码变得不可验证。

### 3.3 安全默认值

- Telegram 默认 `allowlist`，没有明确的用户/聊天白名单时不处理普通消息；
- Token 只从环境变量读取，不写入日志、不写入 Git；
- 状态目录默认位于 `DSH_HOME` 下，可单独用 `DSH_HERMES_BOT_HOME` 指定；
- Outbox 只记录目标和文本，不记录 Bot Token；
- 日志中的用户 ID、聊天 ID 支持脱敏；
- 不把未知 `/xxx` 静默丢掉；它会进入 DSH Agent，或由 DSH command registry 接管；
- 失败重试有次数和退避上限，避免断网时无限打 API。

## 4. 已知边界

`DeepSeek-Bot` 是新建插件仓库，不是 DeepSeek Harness 的源码副本。安装时需要一个已安装并启用了 Agent Loop、Session Persistence 和对应工具的 DSH profile。插件只依赖公开的 DSH service contract；如果未来 DSH 的 developer preview 改变 API，适配集中在 `src/harness-bridge.ts`。

## 5. 后续路线

1. Telegram 真实 Bot token 下做端到端 smoke test。
2. 增加 `dsh-agent-message` 风格的跨会话 mailbox 和回执。
3. 以同一 Delivery 核心接入飞书 CardKit；复用 `dsh-lark-link` 已验证的 WAL/Outbox 经验，但不复制其业务代码。
4. 以 DSH `ctx.jobs` / schedule seam 对接 Hermes Routine。
5. 在 DSH Web profile 增加轻量 Bot roster UI：canonical chat、未读标记、profile 选择和 routine 列表。
6. 所有大体积回放、诊断 ZIP、压测日志和构建归档放 Google Drive；GitHub 只保存源代码、测试、文档和小型 manifest。
