# DeepSeek-Bot: Hermes Bot Capability Research and Improvement Design

## English

Updated: 2026-08-17

## 1. Executive Summary

`DeepSeek-Bot` is a Cordis plugin that can be installed with `dsh plugin`. It does not modify the DeepSeek Harness upstream source; instead, it implements message ingress, reliable delivery, and session governance at the public service boundary:

```text
Telegram / other platform adapters
          │
          ▼
Inbound deduplication → Inbound WAL → per-session serial queue → ctx.agents
                                                               │
                                                               ▼
                                                    session/event listeners
                                                               │
                                                               ▼
                                                    Outbox → platform send
```

This provides the Hermes-style Bot experience together with DSH's native sessions, Agents, tools, and event model, without maintaining a forked Agent Loop alongside the DSH core.

## 2. Research Findings

### Hermes Agent

Upstream repository: <https://github.com/NousResearch/hermes-agent>

Hermes Bot capabilities can be divided into two layers:

1. **Message gateway layer**: Telegram, Discord, Slack, WhatsApp, Signal, and other channels; session continuity, media, commands, cron delivery, access control, reconnection, and multi-platform routing.
2. **Bot Mode / Agent roster layer**: one Bot per profile, a fixed canonical chat, unread activity, Bot-to-Bot `@mention`, group-chat rooms, Routines, avatars/pets, MCP/Skill configuration, and multi-gateway rosters.

The most valuable things to migrate are not Hermes's Python platform classes, but these reliability invariants:

- Persist inbound requests before handing them to the Agent so they can be retried a bounded number of times after a crash.
- Use a persistent Outbox for outbound sends and acknowledge only after a successful send. This supports at-least-once delivery instead of assuming that a network call always succeeds.
- Deduplicate update IDs, event sequence numbers, and outbound idempotency keys.
- Bind each chat target to a stable session; never write multiple messages concurrently to the same Agent.
- Route commands, ordinary messages, and native DSH commands separately; unknown commands must not be silently discarded.
- Enforce access control at the inbound boundary. By default, a Bot must not become an open relay.

### DeepSeek Harness

Upstream repository: <https://github.com/deepseek-ai/deepseek-harness>

The official DSH extension boundary is:

- A Cordis plugin exports `name` and `apply(ctx)`.
- Use `ctx.agents` to create, restore, and find Agents.
- Use `agent.followup()` to pass an external user's message to the Agent as a new turn.
- Listen to `session/event` and read model output from `assistant/message`.
- Reuse installed native DSH commands through `ctx.commands.execute(agent, line, signal)`.
- Use `ctx.jobs` for background work instead of creating a parallel Agent Loop.

The project therefore keeps platform adapters behind independent interfaces and treats DSH as a replaceable Agent Runtime.

### Existing Community Implementations

| Project | Problems solved | Implications for this project |
| --- | --- | --- |
| [amlyczz/dsh-lark-link](https://github.com/amlyczz/dsh-lark-link) | Feishu bidirectional bridge, Inbound WAL, persistent Outbox, idempotency, media, confirmation cards, diagnostic ZIPs, and session recovery | Reliability needs both inbound and outbound ledgers, and diagnostics must be built in |
| [hi-wenw/dsh-telegram-channel](https://github.com/hi-wenw/dsh-telegram-channel) | Telegram long polling, per-chat sessions, history reads, and model-selection buttons | The Telegram adapter can start with zero native dependencies; platform logic must not contaminate the Agent layer |
| [NanmiCoder/dsh-agent-teams](https://github.com/NanmiCoder/dsh-agent-teams) | Persistent sub-Agents, dependent tasks, direct messages, state recovery, and a Web UI | Bot-to-Bot communication should use the native DSH Agent/message boundary rather than shared global variables |
| [GengDaPeng/dsh-agent-message](https://github.com/GengDaPeng/dsh-agent-message) | Cross-session discovery, offline delivery, acknowledgements, and sender navigation | Bot targets and DSH session targets can later be unified as receipt-aware mailboxes |
| [Cavan-Ou/hermes-dsh-collab](https://github.com/Cavan-Ou/hermes-dsh-collab) | Hermes dispatch, DSH execution, quality gates, and a single Git writer | When Hermes orchestrates work, scope, tests, and single-writer constraints are required |
| [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) | A plugin marketplace containing entries for `hermes-dsh-collab`, Telegram, Feishu, message centers, and more | Keep the standard `dsh.bundle` plugin distribution instead of copying a giant fork |

### Feishu Official Capability Constraints

This integration follows the Feishu official documentation and official Node SDK:

- [Receive message events](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive): an application bot receives direct or group-chat messages through `im.message.receive_v1`.
- [Send messages](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create): the application identity sends messages to a `chat_id` or user ID using a `tenant_access_token`.
- [Reply to messages](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply): replies can target a `message_id` and preserve message context.
- [Official Node SDK](https://github.com/larksuite/node-sdk): `@larksuiteoapi/node-sdk` provides WebSocket long connections, event normalization, reconnection, message chunking, and CardKit capabilities.

The current implementation therefore uses an enterprise self-built application bot rather than a group custom-bot Webhook that can only push messages in one direction. This is necessary to receive user messages, distinguish senders, respond to group-chat `@bot` mentions, and preserve identity and event context for future Bot collaboration, approval cards, and cross-session governance.

## 3. A Better Approach Than Direct Porting

### 3.1 Layering

```text
Transport        Telegram, Feishu, Discord, Webhook
                 Only handles platform send/receive and limits

Delivery         Dedupe, Inbound WAL, Outbox, retries, lane serialization
                 Only handles reliable message delivery

Routing          chat → profile → stable session id
                 Only handles binding and permissions

Harness Adapter  ctx.agents, agent.followup, session/event, DSH commands
                 Only handles calls into DeepSeek Harness
```

Each layer can be tested independently. Adding a platform only requires a Transport implementation; session, retry, and security logic do not need to be copied.

### 3.2 Current Implementation Scope

The first version includes:

- Telegram Bot API long polling;
- Feishu/Lark application-bot WebSocket long connection using the official `@larksuiteoapi/node-sdk`;
- Stable DSH sessions per chat/thread;
- Inbound WAL, update deduplication, Outbox, idempotency keys, exponential backoff, and dead-letter state;
- `/new`, `/stop`, `/status`, `/help`, `/bots`, `/bot <name>`, and `/model`;
- Native DSH commands take priority; unknown `/xxx` commands are still passed to the Agent;
- Telegram 4096-character chunking, typing indicators, and access allowlists;
- Feishu direct messages, group-chat `@bot`, topic/reply relationships, Markdown outbound messages, and automatic reconnection;
- Model text returned to Telegram through `session/event`;
- Bounded recovery of incomplete inbound requests after a crash or restart;
- Bounded backoff retries for inbound failures; Telegram advances its offset only after WAL acceptance;
- One-time pairing codes for unknown Feishu direct-message users, with expiration, platform isolation, and revocation;
- Short-lived diagnostics for Feishu connections, `open_id`/`chat_id`, mention state, and allowlist decisions;
- DSH Web settings page, credential-store App Secret persistence, local settings API, and runtime hot reload;
- Unit tests, plugin configuration examples, and an operations guide.

The first version deliberately does not include:

- Discord Gateway, Feishu HTTP Webhooks, or WhatsApp multi-protocol support;
- Image generation, pet avatars, or a complete Bot roster UI;
- A custom cron engine; the project should first reuse the DSH command/jobs/schedule seams;
- Automatic Full Access. Permissions are jointly determined by the DSH profile and the Bot allowlist.

The first Feishu version uses an official WebSocket long connection rather than a Webhook because the project primarily runs inside a local/server DSH process and does not need to expose a public callback address. A Webhook can be added later when a reverse proxy and unified ingress are available. Other capabilities should be added as adapters or UI plugins rather than making the core reliability code difficult to verify.

### 3.3 Secure Defaults

- Default to `allowlist`. Without an explicit user or chat allowlist, ordinary messages are not processed; Feishu direct messages can use one-time pairing instead of entering the Agent directly.
- Read Tokens only from environment variables; do not write them to logs or Git.
- Put the default state directory under `DSH_HOME`; `DEEPSEEK_BOT_HOME` or the compatible `DSH_HERMES_BOT_HOME` can override it.
- Record only targets and text in the Outbox; never record Bot Tokens.
- Support redaction of user IDs and chat IDs in logs.
- Do not silently discard unknown `/xxx`; pass them to the DSH Agent or let the DSH command registry handle them.
- Bound retry counts and backoff to avoid calling the API forever during an outage.
- The Web settings API additionally checks the loopback Host, Origin, Fetch Metadata, and peer socket address; diagnostics do not record message bodies.

## 4. Known Boundaries

`DeepSeek-Bot` is not a copy of the DeepSeek Harness source. Installation requires a DSH profile with the Agent Loop, Session Persistence, and the relevant tools installed and enabled. The Web settings page also requires the DSH Web client, settings, credentials, and webserver peer components. The plugin depends only on the public DSH service contract; if a future DSH developer preview changes the API, compatibility work is concentrated in `src/harness-bridge.ts` and the settings adapter layer.

## 5. Roadmap

1. Run end-to-end smoke tests with real Telegram and Feishu credentials.
2. Add a `dsh-agent-message`-style cross-session mailbox and acknowledgements.
3. Add CardKit streaming replies, button approvals, and media uploads to the existing Feishu channel. Reuse the WAL/Outbox lessons validated by `dsh-lark-link` without copying its business code.
4. Connect Hermes Routines through the DSH `ctx.jobs` / schedule seam.
5. Extend the current settings page with a lightweight Bot roster UI: canonical chat, unread markers, profile selection, and a Routine list.
6. Keep large replays, diagnostic ZIPs, load-test logs, and build archives in Google Drive; GitHub stores only source code, tests, documentation, and small manifests.

---

## 中文

# DeepSeek-Bot：Hermes Bot 能力调研与改进设计

更新时间：2026-08-17

## 1. 结论先行

`DeepSeek-Bot` 当前是一个可通过 `dsh plugin` 安装的 Cordis 插件。本项目不修改 DeepSeek Harness 上游源码，而是在公开服务边界上实现消息接入、可靠投递和会话治理：

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

### 飞书官方能力约束

本次接入以飞书官方文档和官方 Node SDK 为准：

- [接收消息事件](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/events/receive)：应用机器人通过 `im.message.receive_v1` 接收单聊或群聊消息。
- [发送消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create)：应用身份通过 `tenant_access_token` 向 `chat_id` 或用户 ID 发送消息。
- [回复消息](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/reply)：可以按 `message_id` 回复并保留消息上下文。
- [官方 Node SDK](https://github.com/larksuite/node-sdk)：`@larksuiteoapi/node-sdk` 提供 WebSocket 长连接、事件归一化、重连、消息分片和 CardKit 能力。

因此当前实现没有使用只能单向推送的群自定义机器人 Webhook，而是使用企业自建应用机器人。这样才能接收用户消息、区分发送者、响应群聊 @机器人，并为后续 Bot 协作、审批卡片和跨会话治理保留身份与事件上下文。

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

### 3.2 当前实施范围

第一版包含：

- Telegram Bot API 长轮询；
- 飞书/Lark 应用机器人 WebSocket 长连接（使用官方 `@larksuiteoapi/node-sdk`）；
- 每聊天/线程稳定 DSH session；
- Inbound WAL、更新去重、Outbox、幂等键、指数退避、死信状态；
- `/new`、`/stop`、`/status`、`/help`、`/bots`、`/bot <name>`、`/model`；
- DSH 原生命令优先执行，未知 `/xxx` 仍交给 Agent；
- Telegram 4096 字符切片、typing、访问 allowlist；
- 飞书私聊、群聊 @机器人、话题/回复关系、Markdown 出站和自动重连；
- 通过 `session/event` 把模型文本回传 Telegram；
- crash/restart 后有限次数恢复未完成入站请求；
- 入站失败的有限次数退避重试，Telegram 仅在 WAL 接收成功后推进 offset；
- 飞书未知私聊用户的一次性配对码、过期、平台隔离和撤销；
- 飞书连接、open_id/chat_id、@状态和 allowlist 决策的短期诊断；
- DSH Web 设置页、凭据库 App Secret 保存、本机设置接口和运行时热重载；
- 单元测试、插件配置示例和运行手册。

暂不在第一版硬塞入：

- Discord Gateway、飞书 HTTP Webhook 和 WhatsApp 多协议；
- 图片生成、宠物头像、完整 Bot roster UI；
- 自建 cron 引擎；优先复用 DSH 的 command/jobs/schedule seam；
- 自动放开 Full Access。权限由 DSH profile 和 Bot allowlist 共同决定。

飞书第一版选择官方 WebSocket 长连接而非 Webhook，是因为本项目主要运行在 DSH 本地/服务器进程中，不需要额外暴露公网回调地址；Webhook 可在后续有反向代理和统一 ingress 后再补。其他能力会作为后续适配器或 UI 插件增加，而不是让核心可靠性代码变得不可验证。

### 3.3 安全默认值

- 默认 `allowlist`，没有明确的用户/聊天白名单时不处理普通消息；飞书私聊可选择一次性配对，不会直接进入 Agent；
- Token 只从环境变量读取，不写入日志、不写入 Git；
- 状态目录默认位于 `DSH_HOME` 下，可用 `DEEPSEEK_BOT_HOME` 或兼容的 `DSH_HERMES_BOT_HOME` 指定；
- Outbox 只记录目标和文本，不记录 Bot Token；
- 日志中的用户 ID、聊天 ID 支持脱敏；
- 不把未知 `/xxx` 静默丢掉；它会进入 DSH Agent，或由 DSH command registry 接管；
- 失败重试有次数和退避上限，避免断网时无限打 API。
- Web 设置接口额外检查 loopback Host、Origin、Fetch Metadata 和 socket 对端地址；诊断不记录消息正文。

## 4. 已知边界

`DeepSeek-Bot` 不是 DeepSeek Harness 的源码副本。安装时需要一个已安装并启用了 Agent Loop、Session Persistence 和对应工具的 DSH profile；Web 设置页还需要 DSH Web 的 client、settings、credentials 和 webserver peer 组件。插件只依赖公开的 DSH service contract；如果未来 DSH 的 developer preview 改变 API，适配集中在 `src/harness-bridge.ts` 和设置适配层。

## 5. 后续路线

1. Telegram 和飞书真实凭证下做端到端 smoke test。
2. 增加 `dsh-agent-message` 风格的跨会话 mailbox 和回执。
3. 在现有飞书通道上增加 CardKit 流式回复、按钮审批和媒体上传；复用 `dsh-lark-link` 已验证的 WAL/Outbox 经验，但不复制其业务代码。
4. 以 DSH `ctx.jobs` / schedule seam 对接 Hermes Routine。
5. 在当前设置页基础上增加轻量 Bot roster UI：canonical chat、未读标记、profile 选择和 routine 列表。
6. 所有大体积回放、诊断 ZIP、压测日志和构建归档放 Google Drive；GitHub 只保存源代码、测试、文档和小型 manifest。
