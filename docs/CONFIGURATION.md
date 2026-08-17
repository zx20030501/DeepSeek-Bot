# 配置示例

## 推荐：网页一键配置

安装插件并启动 `dsh web` 后，进入设置里的“飞书机器人”：

1. 填写飞书 App ID。
2. 填写 App Secret。
3. 填写允许使用机器人的用户 ID 或群聊 ID（每行一个）。
4. 点击“保存并启动”。

App Secret 使用 DSH 的本机凭据库保存，只显示“已配置/未配置”，不会写入项目、settings 文件或 Git。保存后插件会自动重载连接。

网页配置保存的普通字段属于 `dsh-hermes-bot` settings namespace；插件网页通过本机接口读取和保存这组字段，因为 DSH 公共网页设置接口只开放固定的官方 namespace。App Secret 使用固定凭据引用 `DSH_HERMES_BOT_FEISHU_APP_SECRET`，不会作为普通设置返回。

插件配置可以写入 profile 的 overlay，也可以主要通过环境变量提供敏感信息。

```yaml
- insert:
    - id: dsh-hermes-bot
      name: dsh-hermes-bot
      config:
        enabled: true
        defaultProfile: default
        access:
          mode: allowlist
          userIds: [123456789]
          chatIds: []
          notifyUnauthorized: false
        profiles:
          default:
            title: Hermes
          research:
            title: Research Bot
            provider: deepseek
            model: deepseek-v4-flash
            maxTokens: 8192
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
```

Token 推荐只使用环境变量：

```bash
export DSH_HERMES_BOT_TELEGRAM_TOKEN='...'
export DSH_HERMES_BOT_ALLOWED_USERS='123456789,987654321'
```

## 飞书 / Lark

飞书适配器使用官方 `@larksuiteoapi/node-sdk` 的 WebSocket 长连接模式。它不要求部署公网 HTTP 回调地址，适合直接运行在 DSH 所在机器上；SDK 负责长连接握手、重连、事件解密和消息归一化。

只接入飞书时，可以这样配置：

```yaml
telegram:
  enabled: false
feishu:
  enabled: true
  domain: feishu       # 海外 Lark 使用 lark
  requireMention: true # 群聊默认只响应 @机器人
```

敏感凭证推荐使用环境变量：

```bash
export DSH_HERMES_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DSH_HERMES_BOT_FEISHU_APP_SECRET='替换为 App Secret'
# 海外 Lark：
# export DSH_HERMES_BOT_FEISHU_DOMAIN='lark'
```

在飞书开放平台需要完成：

1. 创建企业自建应用并开启机器人能力。
2. 在“事件与回调”中选择“使用长连接接收事件”，订阅 `im.message.receive_v1`（接收消息）。
3. 按后台权限提示开通接收用户/群消息以及以应用身份发送消息的权限；若需要接收群内未 @机器人的全部消息，再申请群消息权限。
4. 创建并发布应用版本，把机器人加入目标单聊或群聊。

飞书的用户白名单使用 `open_id`（通常为 `ou_...`），群白名单使用 `chat_id`（通常为 `oc_...`）：

```yaml
access:
  mode: allowlist
  userIds: [ou_xxxxxxxxxxxx]
  chatIds: [oc_xxxxxxxxxxxx]
```

默认 `requireMention: true`，因此群聊中需要先 @机器人；单聊不受这个条件影响。Telegram 和飞书可以同时开启，二者共用同一套 DSH profile、WAL、Outbox 和会话治理，但会按 `platform:chatId:threadId` 分开保存会话。

## 状态目录

默认：

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── state.json
├── inbound-wal.jsonl
└── outbox.jsonl
```

可以设置 `DSH_HERMES_BOT_HOME` 把它放到单独的持久磁盘。不要把此目录提交到 GitHub；其中可能包含用户消息和模型回复。

## 命令分流

插件先处理自己的命令：`/new`、`/reset`、`/stop`、`/status`、`/help`、`/bots`、`/bot`、`/model`。

随后调用 DSH 的 `ctx.commands.execute()` 尝试执行已安装的原生命令（例如 profile 中提供的命令）。命令不存在时，原始文本作为 Agent prompt 发送，避免出现 Hermes 中常见的“未知命令静默丢失”。
