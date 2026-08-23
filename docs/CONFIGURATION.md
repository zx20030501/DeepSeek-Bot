# DeepSeek-Bot 配置

## 1. Profile 配置

插件 ID 继续使用 `dsh-hermes-bot`，这是为了兼容当前 DSH profile。项目名称是 DeepSeek-Bot。

```yaml
- insert:
    - id: dsh-hermes-bot
      name: dsh-hermes-bot
      config:
        enabled: true
        defaultProfile: default
        access:
          mode: allowlist
          userIds: []
          chatIds: []
          pairing: true
          notifyUnauthorized: false
        profiles:
          default:
            title: DeepSeek Bot
          research:
            title: Research Bot
            provider: deepseek
            model: deepseek-v4-flash
            maxTokens: 8192
            capabilities: [research, source-review]
            skills: [web-research]
            soul: "先给证据，再给结论；不把未验证推测当成事实。"
            fleetRole: worker
            sessionScope: requester
            allowedUserIds: []
            allowedChatIds: []
            approvalRequired: false
          reviewer:
            title: Review Bot
            capabilities: [verify, audit]
            fleetRole: verifier
          writer:
            title: Writer Bot
            capabilities: [writing, synthesis]
            fleetRole: synthesizer
        telegram:
          enabled: true
          pollTimeoutSeconds: 30
          requestTimeoutMs: 70000
        feishu:
          enabled: true
          domain: feishu
          requireMention: true
          handshakeTimeoutMs: 15000
          maxMessageChars: 4000
        maxInboundAttempts: 3
        outboxMaxAttempts: 5
        retryBaseMs: 1000
        retryMaxMs: 60000
        collaboration:
          enabled: true
          autoPlanner: true
          approvalMode: auto-planned
          defaultSessionScope: requester
          maxGroupBots: 6
          maxGroupRounds: 3
          maxGroupMessages: 10
          maxParallelRuns: 6
          botRunMaxAttempts: 3
          mailboxMaxAttempts: 3
          mailboxLeaseMs: 120000
          mailboxRetryBaseMs: 1000
          mailboxRetryMaxMs: 60000
          features:
            dynamicRegistry: false
            chatBotCreation: false
            peerMessaging: false
            managerAgent: false
            savedWorkflows: false
            externalRuntimes: false
```

`DEEPSEEK_BOT_*` 是推荐前缀；旧的 `DSH_HERMES_BOT_*` 仍可用：

```bash
export DEEPSEEK_BOT_TELEGRAM_TOKEN='...'
export DEEPSEEK_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DEEPSEEK_BOT_FEISHU_APP_SECRET='...'
export DEEPSEEK_BOT_ALLOWED_USERS='123456789,ou_xxxxxxxxxxxx'
export DEEPSEEK_BOT_HOME='/path/to/persistent/state'
```

不要把 Token 或 App Secret 写入 YAML、源码、日志或提交记录。网页设置页使用 DSH 凭据服务保存飞书 App Secret。

## 2. 飞书 / Lark

飞书适配器使用官方 `@larksuiteoapi/node-sdk` WebSocket 长连接，不需要公网 HTTP Webhook。

飞书开放平台需要完成：

1. 创建企业自建应用并开启机器人能力；
2. 在“事件与回调”中选择“使用长连接接收事件”；
3. 订阅 `im.message.receive_v1`；
4. 开通接收消息和发送消息所需权限；
5. 创建并发布应用版本；
6. 把机器人加入目标单聊或群聊。

推荐配置：

```yaml
telegram:
  enabled: false
feishu:
  enabled: true
  domain: feishu       # 海外 Lark 使用 lark
  requireMention: true # 群聊默认需要 @机器人
access:
  mode: allowlist
  pairing: true
```

用户白名单使用飞书 `open_id`（通常是 `ou_...`），群聊白名单使用 `chat_id`（通常是 `oc_...`）。

### 一次性配对

开启 `access.pairing: true` 后，陌生用户的飞书私聊不会进入 Agent，而会收到一个 8 位配对码。管理员在本机 DSH Web 设置页输入配对码并确认：

- 配对码只对私聊生成；
- 默认 1 小时过期；
- 同一平台最多保留少量待确认请求；
- 审批按 `platform:userId` 隔离；
- 可以在设置页撤销配对；
- 确认后建议用户在同一个聊天发送 `/new`。

### 自动识别 UID

设置页可以启动一次性诊断。插件会临时等待飞书私聊中的精确命令 `/bind <code>`，捕获发送者的 `open_id` 和 `chat_id`，只向本机页面返回元数据，不保存消息正文。Telegram 或飞书群聊不会被当作 UID 发现结果。

## 3. DSH Web 设置页

安装 DSH Web client peer 依赖后，执行：

```bash
npm run build
npm run build:client
dsh web
```

进入“飞书机器人”设置区域，可以：

- 设置 App ID、平台和群聊 @规则；
- 保存或更新 App Secret（页面不回显）；
- 增删用户 ID 和群聊 ID；
- 启用一次性配对；
- 一键测试连接并自动识别 UID；
- 查看长连接状态、实际收到的 user/chat ID、@状态和 allowlist 决策；
- 可视化增删 Bot，设置角色、模型、能力、技能、SOUL、会话隔离和每 Bot ACL；
- 设置 Planner、审批策略、并行数、完整轮次和失败重试次数；
- 查看 Task、Workflow、Run、审批和 dead-letter，并在本机查看详情、取消、重放、批准或拒绝；
- 修改后热重载 Telegram/飞书 Transport，不需要重启 DSH。

设置 API 是插件自带的本机接口 `/api/dsh-hermes-bot/setup`，会检查 loopback Host、Origin、Fetch Metadata 和 socket 对端地址。

## 4. 状态目录

默认：

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── state.json          # 聊天绑定、Session 目标及动态 Bot 直接会话索引
├── pairing.json
├── inbound-wal.jsonl
├── outbox.jsonl
├── mailbox.jsonl
├── tasks.jsonl
├── rooms.json
├── approvals.json
├── bot-registry.jsonl  # Fleet v2 动态 Bot 身份与修订；实际使用后生成
└── teams.jsonl         # Fleet v2 Team 与 Agent Thread；实际使用后生成
```

状态文件可能包含聊天消息和模型回复，不要提交到 GitHub。大体积回放、诊断归档和压测日志放到项目指定的 Google Drive 目录；本仓库只保存代码、测试、文档和小型 manifest。

## 5. 命令

插件本地处理：

- `/new`、`/reset`：新建会话；
- `/stop`：停止当前 Agent 回合；
- `/status`：查看网关、Transport、WAL 和 Outbox 状态；
- `/bots`、`/bot <name>`：查看和切换 profile/Bot roster；
- `/bot create <id> [名称]`：建立当前用户私有的动态 Bot 草稿；
- `/bot confirm <code>`、`/bot list`、`/bot status <id>`：确认激活、查看自己的动态 Bot，或核实 Fleet 加入和健康状态；
- `/teams`、`/team create|add|remove|manager|status …`：显式维护当前用户可见 Team；新 Bot 不会隐式加入既有 Team；
- `/bot edit|clone|disable|enable|delete …`：修改、复制或管理自己的动态 Bot；
- `/mesh`：查看当前请求者自己的 mailbox、Task、Run、Handoff 和正在执行的 Bot 数量；
- `/fleet <任务>`：按能力生成并执行“并行执行 → 验证 → 汇总”计划；
- `/tasks`：查看当前请求者最近的 Fleet Task；
- `/task <id>`：按需查看当前请求者自己的 Task 详情；
- `/cancel <id>`：取消当前请求者自己的活动 Task；
- `/replay <id>`：以全新的 Task/Run 身份重放当前请求者自己的历史 Task；
- `/approvals`：查看当前请求者自己的待审批操作；
- `/approve <code>`、`/reject <code>`：由原请求者批准或拒绝；
- `/model`：查看当前模型；
- `/model provider:model`：设置当前聊天下一回合的 provider/model；
- `/help`：查看帮助。

已安装的 DSH 原生命令优先执行；未知的 `/xxx` 仍会作为普通 Agent prompt 发送。

## 6. BotMesh 协作

在已经通过 allowlist 或配对授权的聊天中，可以直接提及已配置的 Bot：

```text
@research 请比较 Hermes Bot Mode 与当前项目的差异
```

同时提及两个或更多已知 Bot 会创建一个有界 Group Room：

```text
@research @writer 先研究，再把结果整理成实施方案
```

BotMesh 会为请求写入结构化 Message Envelope、Task、Run 和审计记录；Bot 之间不通过自由文本 shell 调用。默认会话按请求者隔离；Group Room 默认最多 3 个完整轮次、10 条消息，先达到的限制生效。

自动 Fleet：

```text
/fleet 调研方案、独立验证风险并给出最终建议
```

默认先返回计划和审批码。批准后 worker 并行执行，可选 verifier 独立检查，最后由 synthesizer 返回一个结果。审批决定和业务副作用会在重启后对账恢复。内部 Bot 还可以通过受限的 `bot_fleet_handoff` Tool 把直接 Task 转交给另一个有权限的 Bot；身份字段由 Gateway 推导，不能由模型填写。更完整的说明见 `docs/FLEET.md`。

当前仍是单机 Fleet；逻辑 roster 可以大于 6，但单个 Team、Group Room、Planner fan-out 和同时运行 Agent 受最多 6 Bot 等配置上限约束。跨机器 Transport、Routine/cron、全部 Workflow 节点适配，以及 Workflow/Group Room 运行中的任意动态改图尚未实现。

## 7. Fleet v2 渐进开关

Fleet v2 的能力分开启用，全部默认 `false`。当前生产路径不会因为升级代码而自动切换：

- `dynamicRegistry`：加载版本化 Bot Registry，并把已激活且可安全执行 ACL 的动态 Bot 合并进 roster；
- `chatBotCreation`：允许命令或普通 Hermes Agent 通过受限 Tool 创建/修改 Bot 草稿；依赖 `dynamicRegistry`；
- `peerMessaging`：允许结构化 Bot-to-Bot 跨会话消息；
- `managerAgent`：允许 Manager Agent 调度 Team；
- `savedWorkflows`：允许保存和复用 Workflow；
- `externalRuntimes`：允许 Hermes/Grok Runtime Adapter。

聊天创建和自动加入 Fleet 已实现。相关开关可在本机设置页的“Bot Fleet 设置”中开启；保存后在飞书发送 `/new`。创建流程是“草稿 → 绑定具体 Revision 的 8 位确认码 → 激活 → 验证 owner-scoped Fleet roster 投影”，未确认草稿不能运行；修改草稿会生成新码并废止旧码。聊天创建目前只开放用户私有作用域，并把“平台 + UID”写入不可由模型伪造的 principal ACL。静态 Bot、动态 Bot 和删除墓碑共用同一 handle 命名空间；网页保存、运行时重载和聊天创建使用同一命名空间事务，冲突或应用失败时不会保留半完成设置。

`peerMessaging`、`managerAgent` 和 `savedWorkflows` 已接入受控执行入口，本机设置页可分别启用；默认关闭时 Gateway 会拒绝相应副作用。Peer 当前支持类型化入口和直接 Bot 输出中的有界 `@bot`，Manager 当前是确定性计划/委派控制面，Saved Workflow 当前真实执行 task-node DAG。`externalRuntimes` 尚未实现，也不在设置页开放。
