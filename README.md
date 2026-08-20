# DeepSeek-Bot

面向 DeepSeek Harness 的 Telegram 与飞书/Lark 消息接入插件。

DeepSeek-Bot 通过 DeepSeek Harness 的公开 Cordis 插件边界接入外部聊天平台，不修改 Harness 核心，也不替代 Harness 的 Agent Loop。仓库保留 `dsh-hermes-bot` 作为 DSH 插件 ID 和旧环境变量前缀，以兼容已经安装的 profile；项目名称和新配置前缀统一使用 DeepSeek-Bot。

## 当前功能

- Telegram Bot API 长轮询，以及飞书/Lark 官方 SDK WebSocket 长连接；
- 飞书私聊、群聊 @机器人、话题/回复上下文和 Markdown 回复；
- Inbound WAL：消息交给 Agent 前先落盘，失败时有限次数退避重试，重启后可恢复；
- Telegram 只有在 WAL 接收成功后才推进 polling offset，避免处理失败时丢消息；
- Outbox：幂等键、按聊天串行发送、重试、指数退避和 dead 状态；
- 平台事件去重，平台/聊天/线程到 DSH session 的稳定绑定；
- `/new`、`/reset`、`/stop`、`/status`、`/help`、`/bots`、`/bot`、`/model`；
- Bot Fleet：可编辑 roster、能力/SOUL/模型/角色、每 Bot ACL，以及默认按使用者隔离的稳定会话；
- 结构化 Mailbox、Task/Run/Handoff/Audit、租约续期、fencing、真实退避重试、重启恢复和 dead-letter；
- Peer Messaging v1：带地址、schemaVersion、correlation/reply/trace、TTL、显式幂等键、大小上限和有界 hop 的结构化 Bot 消息；
- 直接 Bot 输出中的已授权 @bot 会被转换为新的有界 Peer Task/Run；ACL、审批、visitedBots 和 maxHops 会阻止越权与循环。
- `@bot` 路由、2–6 Bot 顺序 Group Room，以及 `/fleet` 并行“执行 → 验证 → 汇总”工作流；
- `/tasks`、`/task`、`/cancel`、`/replay`、`/approvals`、`/approve`、`/reject`、`/mesh` 和本机 Fleet 控制台；
- 仅在内部 Bot Session 注册的结构化 Handoff Tool，Gateway 推导任务身份并支持审批后恢复；
- `/model provider:model` 覆盖，以及 DSH 默认模型继承；
- allowlist 访问控制，按用户 ID 或聊天 ID 授权；
- 未授权飞书私聊的一次性配对码，平台隔离、过期、限量和撤销；
- 飞书消息接收诊断：连接状态、open_id、chat_id、@状态和拒绝原因，不记录正文；
- 可选的 DSH Web 设置页：App ID/Secret、白名单、UID 自动识别、配对、Bot roster、Fleet 参数、审批和运行诊断；
- TypeScript 严格检查、Node 单元测试和标准 `dsh.bundle` 分发格式。

## 工作方式

```text
Telegram / 飞书事件
        │
        ▼
平台消息归一化 → 访问控制 → 去重 → Inbound WAL
        │
        ▼
普通消息 ─────────────────────────────→ 当前聊天 DSH Session
@bot / /fleet → Task/Workflow/Run → Typed Mailbox → 隔离的 Bot Session
        │
        ▼
session/event → Audit/Group Room → Outbox → 原平台回复
```

平台适配、可靠投递、会话路由和 Harness 调用彼此分离。新增平台时主要扩展 Transport，不需要重新实现 WAL、Outbox 和 Agent 会话逻辑。

Fleet 使用方式和与 Hermes/Grok 的对应关系见 [docs/FLEET.md](docs/FLEET.md)；底层协议见 [docs/BOTMESH.md](docs/BOTMESH.md)。

## 安装和构建

在已经安装 DeepSeek Harness 的环境中：

```bash
npm ci
npm run build
# 如果使用 DSH Web 设置页，还要构建客户端模块：
npm run build:client

dsh plugin --profile web add . --ignore-scripts
dsh web
```

如果只使用后端环境变量，可以只运行 `npm run build`；Web 设置页依赖 DSH Web 的 client peer 组件。

## 配置

新配置前缀是 `DEEPSEEK_BOT_`，旧的 `DSH_HERMES_BOT_` 变量仍兼容：

```bash
export DEEPSEEK_BOT_TELEGRAM_TOKEN='你的 Telegram Bot Token'
export DEEPSEEK_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DEEPSEEK_BOT_FEISHU_APP_SECRET='你的飞书 App Secret'
export DEEPSEEK_BOT_ALLOWED_USERS='ou_xxxxxxxxxxxx'
# 或按聊天授权：
# export DEEPSEEK_BOT_ALLOWED_CHATS='oc_xxxxxxxxxxxx'
```

飞书 App Secret 也可以通过 DSH Web 设置页保存到本机凭据库；它不会写入 settings、状态文件、README 或 Git。群聊默认要求 @机器人；单聊不要求 @。

如果只使用飞书，可以在 profile overlay 中关闭 Telegram：

```yaml
telegram:
  enabled: false
feishu:
  enabled: true
  domain: feishu # 海外 Lark 使用 lark
  requireMention: true
access:
  mode: allowlist
  pairing: true
```

完整配置和飞书开放平台开通步骤见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 安全和状态

默认是 allowlist；没有用户或聊天白名单时，普通消息不会交给 Agent。一次性配对只接受私聊、按 platform + userId 隔离，默认 1 小时过期，并限制待确认数量。

设置接口只接受本机 loopback 请求，并检查 Host、Origin、Fetch Metadata 和 socket 对端地址。诊断只保留短期计数和 ID 元数据，不保存正文。运行状态默认位于：

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── state.json
├── pairing.json
├── inbound-wal.jsonl
├── outbox.jsonl
├── mailbox.jsonl
├── tasks.jsonl
├── rooms.json
└── approvals.json
```

该目录可能包含聊天消息和模型回复，不应提交到 GitHub。大体积回放、诊断压缩包、压测日志和构建归档不进入仓库；本次实现没有生成需要上传 Google Drive 的大文件。

## 测试

```bash
npm run check
npm test
npm run pack:check
```

测试覆盖命令解析、模型覆盖、WAL/Outbox、平台适配、配对、UID 发现、本机设置接口，以及 Fleet ACL、会话隔离、Mailbox TTL/租约/fencing/恢复、六 Bot 完整轮次、epoch、审批崩溃恢复、模型 Handoff、Task 详情/取消/重放、并行状态、真实失败重试和“执行 → 验证 → 汇总”端到端流程。

## 当前边界

这是单机 DeepSeek Harness 内的 Fleet v1，不是 xAI 内部系统的复制品。当前 Planner 是可审计的确定性能力匹配，工作流采用固定的“执行 → 验证 → 汇总”阶段，最多 6 个不同 Bot；结构化 Handoff 已有公开 API、受限模型 Tool 和审批恢复。尚未实现 Grok Build 的数百代理弹性 fan-out、可保存任意工作流脚本、跨机器 Transport、定时 Routine、文件/媒体完整转发、通用 Task DAG 编辑器，以及 Workflow/Group Room 中途动态改图。

## 项目链接

- GitHub：<https://github.com/zx20030501/DeepSeek-Bot>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- Hermes Agent：<https://github.com/NousResearch/hermes-agent>
- 飞书官方 Node SDK：<https://github.com/larksuite/node-sdk>
