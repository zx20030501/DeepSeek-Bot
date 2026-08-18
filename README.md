# DeepSeek-Bot

面向 DeepSeek Harness 的 Telegram 与飞书/Lark 消息接入插件。

本仓库的项目名称是 **DeepSeek-Bot**。它通过 DeepSeek Harness 的公开 Cordis 插件边界接入外部聊天平台，不修改 DeepSeek Harness 核心，也不复制或替代 Harness 的 Agent Loop。

## 当前版本真实提供的功能

- Telegram Bot API 长轮询；
- 飞书/Lark 企业自建应用 WebSocket 长连接；
- 飞书私聊、群聊 @机器人、话题/回复上下文和 Markdown 回复；
- Telegram 线程/回复、typing 和 4096 字符安全切片；
- Telegram 文件、图片、语音以及飞书资源的文本提示占位；
- 入站 WAL：消息交给 Agent 前先落盘，异常退出后可以恢复未完成消息；
- 出站 Outbox：幂等键、按聊天串行发送、重试、指数退避和 dead 状态；
- 入站事件去重，避免同一平台事件重复处理；
- 平台、聊天、线程到 DSH session 的稳定绑定；
- DSH profile 切换和模型覆盖；
- allowlist 访问控制，支持按用户 ID 或聊天 ID 授权；
- 本地命令：\`/new\`、\`/reset\`、\`/stop\`、\`/status\`、\`/help\`、\`/bots\`、\`/bot\`、\`/model\`；
- 优先执行已安装的 DSH 原生命令；未知的 \`/xxx\` 不会静默丢失，而是继续交给 Agent；
- 监听 \`session/event\`，把 Agent 的文本输出发送回原聊天；
- TypeScript 源码、严格类型检查和 Node 测试。

## 工作方式

\`\`\`text
Telegram / 飞书事件
        │
        ▼
平台消息归一化
        │
        ▼
访问控制 → 去重 → Inbound WAL
        │
        ▼
按聊天/线程串行处理
        │
        ▼
DeepSeek Harness Agent / DSH command
        │
        ▼
session/event → Outbox → 原平台回复
\`\`\`

平台适配、可靠投递、会话路由和 Harness 调用彼此分离。新增平台时，主要扩展 Transport，不需要重新实现 WAL、Outbox 和 Agent 会话逻辑。

## 安装

在已经安装 DeepSeek Harness 的环境中运行：

\`\`\`bash
npm install
npm run check
npm run build

dsh plugin --profile web add . --ignore-scripts
dsh web
\`\`\`

也可以先生成 npm 包，再把生成的 tarball 安装到 DSH profile：

\`\`\`bash
npm pack
dsh plugin --profile web add ./生成的-tarball.tgz --ignore-scripts
\`\`\`

插件入口和 DSH profile 的加载方式由仓库中的 \`cordis.patch.yml\` 与 \`package.json\` 提供。

## Telegram 配置

当前实现从环境变量读取 Telegram token：

\`\`\`bash
export DSH_HERMES_BOT_TELEGRAM_TOKEN='你的 Telegram Bot Token'
\`\`\`

Telegram 支持私聊、群聊、线程/回复和 typing。长回复会按 Telegram 的消息长度限制切分。

## 飞书 / Lark 配置

飞书接入使用官方 \`@larksuiteoapi/node-sdk\` 的 WebSocket 长连接模式。运行 DSH 的机器不需要暴露公网 HTTP Webhook 地址。

设置应用凭证：

\`\`\`bash
export DSH_HERMES_BOT_FEISHU_APP_ID='cli_xxxxxxxxxxxx'
export DSH_HERMES_BOT_FEISHU_APP_SECRET='你的 App Secret'

# 海外 Lark 使用：
# export DSH_HERMES_BOT_FEISHU_DOMAIN='lark'
\`\`\`

在飞书开放平台完成：

1. 创建企业自建应用；
2. 开启机器人能力；
3. 选择使用长连接接收事件；
4. 订阅 \`im.message.receive_v1\`；
5. 开通接收消息和发送消息所需权限；
6. 创建并发布应用版本；
7. 把机器人加入目标单聊或群聊。

群聊默认只处理 @机器人的消息；单聊不需要 @。白名单应使用飞书的 \`open_id\` 或 \`chat_id\`。

## 访问控制

默认使用 allowlist。没有配置用户或聊天白名单时，不接受普通消息。

\`\`\`bash
# Telegram 示例
export DSH_HERMES_BOT_ALLOWED_USERS='123456789'
# 或：
export DSH_HERMES_BOT_ALLOWED_CHATS='-1001234567890'

# 飞书示例
export DSH_HERMES_BOT_ALLOWED_USERS='ou_xxxxxxxxxxxx'
# 或：
export DSH_HERMES_BOT_ALLOWED_CHATS='oc_xxxxxxxxxxxx'
\`\`\`

Telegram 与飞书可以同时启用。它们共用 profile、WAL、Outbox 和 DSH Agent 能力，但会按平台、聊天和线程分别绑定会话。

如果只使用飞书，可以在 profile 配置中关闭 Telegram：

\`\`\`yaml
telegram:
  enabled: false

feishu:
  enabled: true
  domain: feishu
  requireMention: true
\`\`\`

完整配置项见 [docs/CONFIGURATION.md](docs/CONFIGURATION.md)。

## 状态和敏感数据

运行状态默认保存在 DSH 的本地状态目录中，也可以通过 \`DSH_HERMES_BOT_HOME\` 指定独立目录。

状态文件可能包含聊天消息和模型回复，不应提交到 GitHub。Bot token、App Secret 等敏感凭证只通过环境变量或本地安全配置提供，不写入源码、README、日志或提交记录。

大体积回放、诊断压缩包、压测日志和构建归档不进入本仓库。GitHub 只保存源代码、测试、文档和小型 manifest；开发过程中产生的大文件按项目约定保存到 Google Drive。用户实际运行时仍使用本地状态目录。

## 测试

\`\`\`bash
npm run check
npm test
npm pack --dry-run
\`\`\`

测试覆盖：

- 命令解析；
- Unicode 文本切分；
- Inbound WAL 重启恢复；
- Outbox 幂等、顺序和重试；
- Telegram 长消息切片；
- 飞书消息归一化；
- 飞书 Transport 的连接、接收、发送和停止生命周期。

当前仓库包含单元测试和模拟 Transport 测试；没有在提交中写入真实 Telegram token 或飞书 App Secret，因此真实平台端到端测试需要由部署者自行配置凭证后执行。

## 当前边界

以下内容不属于当前版本已实现功能：

- 飞书 CardKit 流式卡片和审批按钮；
- 飞书图片、文件、语音的真实上传、下载和转发；
- 飞书 HTTP Webhook 接收模式；
- Discord、Slack、WhatsApp 等其他平台；
- 独立的 Bot roster Web UI；
- 自建定时任务系统。

这些能力可以在后续迭代中基于现有 Transport、Delivery 和 Harness Adapter 扩展，但不能在 README 中当作已经完成的功能描述。

## 目录

\`\`\`text
src/
├── index.ts          Cordis 插件入口
├── gateway.ts        消息网关、权限、会话和平台路由
├── telegram.ts       Telegram 长轮询 Transport
├── feishu.ts         飞书/Lark WebSocket Transport
├── durable.ts        Inbound WAL 与 Outbox
├── state.ts          本地状态与聊天绑定
├── commands.ts       命令解析、文本处理和切片
├── harness-bridge.ts DeepSeek Harness Agent 适配
└── types.ts          平台无关类型

docs/
└── CONFIGURATION.md  配置和飞书开通说明

test/
└── *.test.mjs        单元测试与 Transport 模拟测试
\`\`\`

## 项目链接

- GitHub：<https://github.com/zx20030501/DeepSeek-Bot>
- DeepSeek Harness：<https://github.com/deepseek-ai/deepseek-harness>
- 飞书官方 Node SDK：<https://github.com/larksuite/node-sdk>
