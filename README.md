# dsh-hermes-bot

一个参照 Hermes Agent Bot 能力、按 DeepSeek Harness 官方 Cordis 插件边界实现的可靠消息网关。

当前版本先提供 Telegram 长轮询适配器；入站 WAL、出站 Outbox、会话路由、访问控制和 DSH Agent 适配层均与平台解耦，后续可以复用到飞书、Discord、Slack 或 Webhook。

## 已实现

- 每个 Telegram 聊天/线程绑定一个稳定的 DSH session；
- Inbound WAL：消息交给 Agent 之前先落盘，重启后有限次数补发；
- Outbox：幂等键、lane 串行发送、发送后确认、指数退避和 dead 状态；
- Telegram 长轮询、typing、4096 字符切片、文件/图片/语音提示；
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

Token 不写入 patch 或 Git。推荐使用环境变量：

```bash
export DSH_HERMES_BOT_TELEGRAM_TOKEN='替换为 Telegram Bot Token'
export DSH_HERMES_BOT_ALLOWED_USERS='123456789'
# 或按聊天授权：
# export DSH_HERMES_BOT_ALLOWED_CHATS='-1001234567890'
dsh web
```

完整配置示例见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

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
- Token 只从环境变量读取；
- 运行状态默认位于 `DSH_HOME/hermes-bot`，可用 `DSH_HERMES_BOT_HOME` 指定；
- 这是 developer-preview 版 DSH 的外部插件，未来 Harness API 变化集中处理在 `src/harness-bridge.ts`。
