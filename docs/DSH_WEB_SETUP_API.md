# DSH Web Setup API 参考

本机 Fleet Web UI 与设置页共用同一 HTTP 端点。Web 右栏（PR #38）新增的 action 在此说明。

## 端点

| 项 | 值 |
|----|-----|
| **URL** | `POST /api/dsh-hermes-bot/setup` |
| **常量** | `HERMES_BOT_SETUP_ROUTE`（`src/setup-constants.ts`） |
| **GET** | 返回当前 settings + diagnostics 快照（右栏轮询用） |
| **OPTIONS** | CORS 预检；`allow-methods: GET, POST, OPTIONS` |
| **安全** | Host + socket 必须 loopback。允许无 Origin、`origin: null`、`vscode-webview:`、loopback 上的 `sec-fetch-site: cross-site`。仅当 Origin 是**外部** `http(s)` 非 loopback 才拒绝。见 `src/setup-security.ts` |
| **CORS** | 信任通过后回写 `access-control-allow-origin`（Cursor Simple Browser / webview 需要） |

完整设置页 action（`save_settings`、`fleet_task_replay` 等）见 `src/setup-route.ts`；本文只列 **DSH Web Fleet UI 专用** 扩展。

---

## `save_fleet_config`

Web 专用保存 Fleet 配置。**不校验飞书 App ID / App Secret**，适合右栏「一键启用」。

### 请求

```http
POST /api/dsh-hermes-bot/setup
Content-Type: application/json

{
  "action": "save_fleet_config",
  "enableFleet": true,
  "collaboration": {
    "enabled": true,
    "features": {
      "webChatBotCreation": true,
      "dynamicRegistry": true,
      "savedWorkflows": true,
      "routines": true
    }
  },
  "profiles": []
}
```

### 字段

| 字段 | 类型 | 说明 |
|------|------|------|
| `enableFleet` | `boolean?` | 为 `true` 时设置 `collaboration.enabled = true` |
| `collaboration` | `object?` | 与设置页 `FleetSettings` 同形，浅合并到当前配置 |
| `collaboration.features.*` | `boolean?` | `webChatBotCreation`、`dynamicRegistry`、`savedWorkflows`、`routines` 等 |
| `profiles` | `array?` | 静态 Bot roster；省略则保留现有 |

### 响应

标准 setup 快照 + `message`：

```json
{
  "message": "Fleet 设置已保存并启用；右栏 BOTS 与 Web Bot 创建现已可用。",
  "settings": { "...": "..." },
  "diagnostics": { "...": "..." }
}
```

### 与「保存并启动」的区别

| 路径 | 飞书 Secret | 用途 |
|------|-------------|------|
| `save_fleet_config` | **不要求** | Web Fleet 快速启用 |
| 默认 `save_settings` | **要求** App ID + Secret | 完整飞书机器人配置 |

---

## `bot_create_draft`

从 Web 右栏创建动态 Bot 草稿（不经飞书/Telegram）。

### 请求

```http
POST /api/dsh-hermes-bot/setup
Content-Type: application/json

{
  "action": "bot_create_draft",
  "sessionId": "<owner-dsh-session-id>",
  "handle": "researcher",
  "title": "研究员",
  "description": "负责调研与技术方案核对",
  "capabilities": "research,analysis",
  "soul": "先列证据再下结论",
  "fleetRole": "worker"
}
```

### 字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `sessionId` | 推荐 | owner 编程会话 ID；非空时会先 `register_owner_web_session` |
| `handle` | 是 | 小写 Bot ID，如 `researcher` |
| `title` | 是 | 显示名称 |
| `description` | 否 | 职责说明 |
| `capabilities` | 否 | 逗号分隔能力标签 |
| `soul` | 否 | SOUL 风格提示 |
| `fleetRole` | 否 | `worker` / `verifier` / `synthesizer` / `generalist` |

### 响应

```json
{
  "draft": {
    "handle": "researcher",
    "activationCode": "ABCD2345",
    "message": "..."
  },
  "message": "...",
  "diagnostics": { "...": "..." }
}
```

### 后续

右栏点「确认激活」或创建时选「创建并激活」，走 **`bot_registry_status`**（`status: "active"`）。不要走 `fleet_approval_resolve`（那是 Workflow 审批），也不要往会话里塞 `/bot confirm`。

### 前置条件

- `webChatBotCreation: true`（`save_fleet_config` 一键启用会打开）  
- Gateway `createWebDashboardBotDraft` 已接线（`src/index.ts`）

---

## `bot_update`

右栏 ⋯「编辑档案」。draft / active 都能改；Gateway `updateWebDashboardBot`。

### 请求

```json
{
  "action": "bot_update",
  "handle": "researcher",
  "title": "研究员",
  "description": "负责调研",
  "capabilities": "research,analysis",
  "soul": "先列证据再下结论",
  "fleetRole": "worker"
}
```

至少提供一个可改字段。`handle` 必填。

---

## `bot_registry_status`

右栏「确认激活 / 停用 / 删除」。Web **确认激活**走这条，把 draft 直接改成 `active`。

```json
{ "action": "bot_registry_status", "botId": "researcher", "status": "active" }
```

`status`：`active` | `disabled` | `deleted`。

---

## `fleet_dispatch` / `fleet_plan`

点对点派任务、右栏底部「自动规划」。目标是 local web，不灌 `/fleet`。

```json
{ "action": "fleet_dispatch", "to": "researcher", "instruction": "审查当前仓库" }
```

```json
{ "action": "fleet_plan", "instruction": "把发布清单拆成可执行步骤" }
```

---

## `fleet_team_dispatch` / `fleet_room_dispatch`

Team「发任务」、群聊「继续协作」。local 平台 **房间创建完即 HTTP 返回**，ack 后台 flush，不要再 `await outbox.flush()`。

```json
{ "action": "fleet_team_dispatch", "teamId": "team_xxx", "instruction": "一起写发布说明" }
```

```json
{ "action": "fleet_room_dispatch", "botIds": ["researcher", "reviewer"], "instruction": "继续刚才的审查" }
```

---

## `owner_web_command`

遗留通道：把文本注入 owner 会话。右栏主路径**不要**再用它灌 `/bot confirm`、`/fleet`、`/routine create`。派任务请走 `fleet_dispatch` / `fleet_team_dispatch`。

---

## `routine_update`

右栏 CRON 的启用 / 停用 / 删除。不经过 `/routine` 命令。

### 请求

```json
{
  "action": "routine_update",
  "routineId": "<routine-id>",
  "enabled": false
}
```

删除时传 `"delete": true`。

---

## `team_create`

从 Web 设置页或右栏创建 Team。

### 请求

```http
POST /api/dsh-hermes-bot/setup
Content-Type: application/json

{
  "action": "team_create",
  "sessionId": "<owner-dsh-session-id>",
  "name": "Launch",
  "memberBotIds": ["researcher", "reviewer", "writer"]
}
```

`memberBotIds` 也接受逗号/空格分隔的字符串。Gateway 对**同名 + 同成员集**会复用已有 Team，避免右栏刷屏。

### 响应

```json
{
  "team": {
    "id": "team_xxx",
    "name": "Launch",
    "memberBotIds": ["researcher", "reviewer", "writer"],
    "status": "active"
  },
  "message": "Team「Launch」已就绪，可在群组里点「发任务」开始协作。"
}
```

---

## `team_delete`

右栏群组 ⋯「删除」。

```json
{ "action": "team_delete", "teamId": "team_xxx" }
```

---

## `register_owner_web_session`

（main 已有，Web UI 依赖）注册 owner 编程会话并安装 `bot_create_draft` 工具。

### 请求

```json
{
  "action": "register_owner_web_session",
  "sessionId": "<owner-dsh-session-id>"
}
```

插件在检测到非 `hermes-bot-*` 的当前 session 时会自动调用。

---

## diagnostics 扩展字段（PR #38）

`GET` 或任意 POST 响应中的 `diagnostics.fleet` 新增：

### `fleet.teams[]`

| 字段 | 说明 |
|------|------|
| `id` | Team ID |
| `name` | 显示名 |
| `memberBotIds` | 成员 Bot handle 列表 |
| `managerBotId` | Manager Bot（若有） |
| `status` | `active` 等 |

### `fleet.routines[]`

| 字段 | 说明 |
|------|------|
| `id` | Routine ID |
| `name` | 名称 |
| `cron` | Cron 表达式 |
| `timezone` | 时区 |
| `workflowId` | 绑定的 Workflow |
| `status` | 状态 |
| `nextRunAt` | 下次运行时间戳 |

### `diagnostics.bots[]`

右栏 BOTS 列表主要数据源之一：

| 字段 | 说明 |
|------|------|
| `id` | Bot handle |
| `title` | 显示名 |
| `fleetRole` | 角色 |
| `canonicalSessionId` | 1:1 会话 ID（`hermes-bot-*`） |

### `fleet.registryBots[]`

动态 Registry 草稿与状态：

| 字段 | 说明 |
|------|------|
| `handle` | Bot handle |
| `status` | `draft` / `active` / … |
| `activationCode` | 8 位确认码（草稿） |
| `busy` | 是否有活动 Run |

---

## 错误码

| HTTP | 含义 |
|------|------|
| 400 | 缺少必填字段、格式错误 |
| 409 | Bot handle 冲突、Registry 版本冲突 |
| 503 | Gateway / 设置服务未就绪 |

错误 body 为 `{ "error": "..." }`，**不反射** App Secret 或凭据库原始错误。

---

## 测试

```bash
npm test -- test/setup-route.test.mjs
```

覆盖 `save_fleet_config`、`bot_create_draft`、`bot_update`、`team_create`、`team_delete`、CORS / webview Origin 等。以 `src/setup-route.ts` 的 action 白名单为准。
