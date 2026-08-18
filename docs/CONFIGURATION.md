# DeepSeek-Bot Configuration

## English

### 1. Profile Configuration

The plugin ID remains `dsh-hermes-bot` for compatibility with existing DSH profiles. The project name is DeepSeek-Bot.

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

`DEEPSEEK_BOT_*` is the recommended prefix; the legacy `DSH_HERMES_BOT_*` prefix is still supported:

```bash
export DEEPSEEK_BOT_TELEGRAM_TOKEN='...'
export DEEPSEEK_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DEEPSEEK_BOT_FEISHU_APP_SECRET='...'
export DEEPSEEK_BOT_ALLOWED_USERS='123456789,ou_xxxxxxxxxxxx'
export DEEPSEEK_BOT_HOME='/path/to/persistent/state'
```

Do not put Tokens or App Secrets in YAML, source code, logs, or commits. The Web settings page uses the DSH credential service to store the Feishu App Secret.

### 2. Feishu / Lark

The Feishu adapter uses the official `@larksuiteoapi/node-sdk` WebSocket long connection and does not require a public HTTP Webhook.

Complete these steps in the Feishu Open Platform:

1. Create an enterprise self-built application and enable bot capabilities;
2. Under “Events and Callbacks”, choose “Receive events through a long connection”;
3. Subscribe to `im.message.receive_v1`;
4. Enable the permissions required to receive and send messages;
5. Create and publish an application version;
6. Add the bot to the target direct message or group chat.

Recommended configuration:

```yaml
telegram:
  enabled: false
feishu:
  enabled: true
  domain: feishu       # Use lark for overseas Lark
  requireMention: true # Group chats require an @bot mention by default
access:
  mode: allowlist
  pairing: true
```

Use the Feishu `open_id` (normally `ou_...`) for the user allowlist and the `chat_id` (normally `oc_...`) for the group-chat allowlist.

#### One-Time Pairing

When `access.pairing: true` is enabled, a Feishu direct message from an unknown user is not passed to the Agent. The user receives an 8-character pairing code. An administrator enters and confirms that code in the local DSH Web settings page:

- Pairing codes are generated only for direct messages;
- They expire after one hour by default;
- Only a small number of pending requests are retained per platform;
- Approval is isolated by `platform:userId`;
- Pairings can be revoked from the settings page;
- After confirmation, the user should send `/new` in the same chat.

#### Automatic UID Discovery

The settings page can start a one-time diagnostic. The plugin temporarily waits for the exact `/bind <code>` command in a Feishu direct message, captures the sender's `open_id` and `chat_id`, and returns metadata only to the local page without storing the message body. Telegram messages and Feishu group chats are not treated as UID-discovery results.

### 3. DSH Web Settings Page

After installing the DSH Web client peer dependency, run:

```bash
npm run build
npm run build:client
dsh web
```

In the “Feishu Bot” settings area, you can:

- Set the App ID, platform, and group-chat mention rule;
- Save or update the App Secret; the page never displays it again;
- Add or remove user IDs and group-chat IDs;
- Enable one-time pairing;
- Test the connection and discover a UID automatically;
- View long-connection state, the actual received user/chat IDs, mention state, and allowlist decisions;
- Hot-reload the Telegram/Feishu Transport after changes without restarting DSH.

The settings API is the plugin's local endpoint `/api/dsh-hermes-bot/setup`. It checks the loopback Host, Origin, Fetch Metadata, and peer socket address.

### 4. State Directory

Default location:

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── state.json
├── pairing.json
├── inbound-wal.jsonl
└── outbox.jsonl
```

State files may contain chat messages and model replies; do not commit them to GitHub. Store large replays, diagnostic archives, and load-test logs in the project's designated Google Drive directory. This repository stores only source code, tests, documentation, and small manifests.

### 5. Commands

The plugin handles these commands locally:

- `/new`, `/reset`: start a new session;
- `/stop`: stop the current Agent turn;
- `/status`: view gateway, Transport, WAL, and Outbox status;
- `/bots`, `/bot <name>`: list and switch profiles;
- `/model`: view the current model;
- `/model provider:model`: set the provider/model for the next turn in the current chat;
- `/help`: show help.

Installed native DSH commands take priority. Unknown `/xxx` commands are still sent as ordinary Agent prompts.

---

## 中文

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
└── outbox.jsonl
```

状态文件可能包含聊天消息和模型回复，不要提交到 GitHub。大体积回放、诊断归档和压测日志放到项目指定的 Google Drive 目录；本仓库只保存代码、测试、文档和小型 manifest。

## 5. 命令

插件本地处理：

- `/new`、`/reset`：新建会话；
- `/stop`：停止当前 Agent 回合；
- `/status`：查看网关、Transport、WAL 和 Outbox 状态；
- `/bots`、`/bot <name>`：查看和切换 profile；
- `/model`：查看当前模型；
- `/model provider:model`：设置当前聊天下一回合的 provider/model；
- `/help`：查看帮助。

已安装的 DSH 原生命令优先执行；未知的 `/xxx` 仍会作为普通 Agent prompt 发送。
