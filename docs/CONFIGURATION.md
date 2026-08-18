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
- 查看 Task、Workflow、Run、审批和 dead-letter，并在本机批准/拒绝；
- 修改后热重载 Telegram/飞书 Transport，不需要重启 DSH。

设置 API 是插件自带的本机接口 `/api/dsh-hermes-bot/setup`，会检查 loopback Host、Origin、Fetch Metadata 和 socket 对端地址。

## 4. 状态目录

默认：

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

状态文件可能包含聊天消息和模型回复，不要提交到 GitHub。大体积回放、诊断归档和压测日志放到项目指定的 Google Drive 目录；本仓库只保存代码、测试、文档和小型 manifest。

## 5. 命令

插件本地处理：

- `/new`、`/reset`：新建会话；
- `/stop`：停止当前 Agent 回合；
- `/status`：查看网关、Transport、WAL 和 Outbox 状态；
- `/bots`、`/bot <name>`：查看和切换 profile/Bot roster；
- `/mesh`：查看当前请求者自己的 mailbox、Task、Run、Handoff 和正在执行的 Bot 数量；
- `/fleet <任务>`：按能力生成并执行“并行执行 → 验证 → 汇总”计划；
- `/tasks`：查看当前请求者最近的 Fleet Task；
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

默认先返回计划和审批码。批准后 worker 并行执行，可选 verifier 独立检查，最后由 synthesizer 返回一个结果。更完整的说明见 `docs/FLEET.md`。

当前仍是单机最多 6 Bot 的 Fleet；跨机器 Transport、Routine/cron、任意 DAG 和模型可直接调用的 Handoff Tool 尚未实现。
