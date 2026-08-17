# 配置示例

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
