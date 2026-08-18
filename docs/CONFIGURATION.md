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
          writer:
            title: Writer Bot
            capabilities: [writing, synthesis]
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
          maxGroupBots: 6
          maxGroupTurns: 3
          maxGroupMessages: 10
          mailboxMaxAttempts: 3
          mailboxLeaseMs: 120000
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

设置页可以启动一次性诊断。插件会临时等待飞书私聊中的精确命令 `/bind <code>)，捕获发送者的 `open_id` 和 `chat_id)，只向本机页面返回元数据，不保存消息正文。Telegram 或飞书群聊不会被当作 UID 发现结果。

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
- 修改后热重载 Telegram/飞书 Transport，不需要重启 DSH。

设置 API 是插件自带的本机接口 `/api/dsh-hermes-bot/setup)，会检查 loopback Host、Origin、Fetch Metadata 和 socket 对端地址。

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
└── rooms.json
```

状态文件可能包含聊天消息和模型回复，不要提交到 GitHub。大体积回放、诊断归档和压测日志放到项目指定的 Google Drive 目录；本仓库只保存代码、测试、文档和小型 manifest。

## 5. 命令

插件本地处理：

- `/new`、`/reset`：新建会话；
- `/stop`：停止当前 Agent 回合；
- `/status`：查看网关、Transport、WAL 和 Outbox 状态；
- `/bots`、`/bot <name>`：查看和切换 profile/Bot roster；
- `/mesh`：查看 mailbox、Task、Run、Handoff 和正在执行的 Bot 数量；
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

BotMesh 会为请求写入结构化 Message Envelope、Task、Run 和审计记录；Bot 之间不通过自由文本 shell 调用。单 Bot 请求使用该 Bot 的长期 Canonical Session，Group Room 默认最多 3 轮、10 条消息。跨机器 Transport、自动 Routine 和完整 Web roster UI 尚未在这一阶段启用。
