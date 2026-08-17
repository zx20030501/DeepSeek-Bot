# dsh-hermes-bot

一个参照 Hermes Agent Bot 能力、按 DeepSeek Harness 官方 Cordis 插件边界实现的可靠消息网关。

当前版本提供 Telegram 长轮询和飞书/Lark WebSocket 长连接适配器；入站 WAL、出站 Outbox、会话路由、访问控制和 DSH Agent 适配层均与平台解耦，后续可以继续复用到 Discord、Slack 或 Webhook。

## 已实现

- 每个 Telegram 聊天/线程绑定一个稳定的 DSH session；
- Inbound WAL：消息交给 Agent 之前先落盘，重启后有限次数补发；
- Outbox：幂等键、lane 串行发送、发送后确认、指数退避和 dead 状态；
- Telegram 长轮询、typing、4096 字符切片、文件/图片/语音提示；
- 飞书/Lark 应用机器人长连接、私聊、群聊 @机器人、话题/回复关系和 Markdown 消息；
- 默认 allowlist，支持按 user ID 或 chat ID 授权；
- `/new`、`/reset`、`/stop`、`/status`、`/help`、`/bots`、`/bot <name>`、`/model`；
- 已安装的 DSH 原生命令优先执行，未知 `/xxx` 仍交给 Agent；
- 从 `session/event` 读取模型输出并返回原聊天；
- 标准 `dsh.bundle` 分发格式，不修改 Harness 核心。

## 安装

在已安装 DeepSeek Harness 的环境中：

```bash
npm install
npm run build
dsh plugin --profile web add . --ignore-scripts
```

也可以安装打包后的 tarball：

```bash
npm pack
dsh plugin --profile web add ./dsh-hermes-bot-0.1.0.tgz --ignore-scripts
```

让 DSH profile 加载 `cordis.patch.yml` 中的 bundle 后，重启 `dsh web`。

## 配置

安装后打开 `dsh web`，进入设置里的“飞书机器人”。首次使用只需要填写 App ID 和 App Secret，推荐开启“未知用户私聊时自动回复一次性配对码”：陌生用户私聊机器人后会收到配对码，管理员把配对码填回本机设置页确认，插件会绑定该消息对应的 `open_id`，不需要手查 UID。也可以使用“一键测试并自动识别 UID”或直接填写用户 ID / 群聊 ID。保存成功后，还要在飞书同一个聊天中发送 `/new` 开始新的会话，再正常使用。

App Secret 通过 DSH 的本机凭据库保存：页面不会回显，插件不会把它写入 settings 文件、patch 或 Git。保存后插件会自动重载飞书连接，不需要重启 DSH。

如果暂时不使用网页设置，也仍然支持环境变量：

```bash
export DSH_HERMES_BOT_TELEGRAM_TOKEN='替换为 Telegram Bot Token'
# 飞书可与 Telegram 同时启用；只接入飞书时可以关闭 Telegram
export DSH_HERMES_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DSH_HERMES_BOT_FEISHU_APP_SECRET='不要提交到 Git'
export DSH_HERMES_BOT_ALLOWED_USERS='123456789'
# 或按聊天授权：
# export DSH_HERMES_BOT_ALLOWED_CHATS='-1001234567890'
dsh web
```

其中用户 ID 通常是 `ou_...`，群聊 ID 通常是 `oc_...`。设置页会把每个 ID 显示为独立、可删除的编号输入框，保存后再次打开仍会保留；未知用户配对或一键识别到的新 UID 会追加到列表，不会覆盖旧值。未知用户配对码使用 8 位无歧义字符，默认 1 小时过期，并且只对私聊生效。配对确认前不会把陌生用户的普通消息交给 Agent；确认后配对状态保存在本机。

完整配置示例见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

飞书推荐使用官方 SDK 的 WebSocket 长连接模式，不需要公网 Webhook 地址。需要在飞书开放平台创建企业自建应用、开启机器人能力、订阅 `im.message.receive_v1`，并发布应用版本。

## 设计与调研

见 [docs/RESEARCH_AND_DESIGN.md](docs/RESEARCH_AND_DESIGN.md)。其中记录了 Hermes、DeepSeek Harness、社区 Telegram/飞书桥接、Agent Teams 和 Hermes↔DSH 协作项目的调研结果，以及为什么采用“Transport / Delivery / Routing / Harness Adapter”分层。

## 测试

```bash
npm install --cache /tmp/deepseek-bot-npm-cache
npm test
```

大体积的回放、诊断 ZIP、压测日志和构建归档不应进入本仓库；按项目约定放入 Google Drive，GitHub 只保存代码、测试、文档和小型 manifest。

## 安全边界

- 默认 allowlist；空 allowlist 不接受普通消息；
- Telegram Token 只从环境变量读取；飞书 App Secret 通过 DSH 本机凭据库保存；
- 运行状态默认位于 `DSH_HOME/hermes-bot`，可用 `DSH_HERMES_BOT_HOME` 指定；
- 这是 developer-preview 版 DSH 的外部插件，未来 Harness API 变化集中处理在 `src/harness-bridge.ts`。
