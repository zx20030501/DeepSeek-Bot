# DSH Web Fleet UI 交接文档（Handoff）

> **交接时间**：2026-08-28（UTC）  
> **交接方**：Cursor Cloud Agent（云端 VM）  
> **接手方**：本地 Cursor / 开发者会话  
> **仓库**：https://github.com/zx20030501/DeepSeek-Bot  
> **本交接对应分支**：`cursor/hermes-fleet-sidebar-cf56`  
> **Draft PR**：https://github.com/zx20030501/DeepSeek-Bot/pull/38  
> **基线分支（main）**：`1674cf5`（已合并 PR #37）

---

## 1. 一句话总结

DeepSeek-Bot 是一个 **DeepSeek Harness 插件**（不 fork DSH、不做独立 App），目标是在 DSH Web（127.0.0.1:3080）上实现接近 **Grok Bot / Hermes Agent Desktop** 的协作体验。

**后端 Fleet 能力**（Gateway、Registry、Group Room、owner web 命令分流）已在 `main` 上基本就绪；**本次云端工作**补上了 **Hermes 式右栏 BOTS UI + Web 专用 setup API**，但 **尚未在真实 DSH Web 3080 环境做 UI 手测**，也 **未自动同步到您的本地电脑**——需本地拉分支、构建、接入 DSH 后验证。

---

## 2. 项目愿景与产品形态（共识）

### 2.1 我们要做什么

| 维度 | 目标 |
|------|------|
| **产品体验** | 对齐 Grok Bot / Hermes：建 Bot（对话框填名称/职责，不是往输入框塞提示语）、1:1 Bot 对话、群协作时间线、右栏 BOTS 通讯录 + CRON |
| **实现方式** | 对齐 Hermes **插件法**：`apply(ctx)` + DSH slots，**不改 Harness 核心** |
| **中间区域** | 永远只有一个活跃 Session；点 Bot / 点群 = `ctx.sessions.open(sessionId)` |
| **右栏** | BOTS 名单（搜索、分组、+ New Agent、状态点），**不是**第二场独立聊天 App |
| **左栏** | Bot/群 Session  ideally 从 Sessions 树隐藏，只在右栏 BOTS 出现（`fleetKind` 元数据 + sidebar filter） |

### 2.2 Hermes 核心不变式（必须遵守）

1. **One bot = ONE canonical forever-chat**（`canonicalSessionId`，禁止每次新建）
2. **群 = room session**；成员在各自 canonical session 干活，结论写回 room（Mailbox / Group Room）
3. **Owner DSH web 会话** 与 **hermes-bot-* worker 会话** 严格隔离（owner 工具不装到 worker 上）

### 2.3 分阶段计划（用户已批准「全部实现」）

| Phase | 内容 | 云端状态 | 本地待办 |
|-------|------|----------|----------|
| **A** | 右栏 BOTS：roster UI、+ New Agent 对话框、`bot_create_draft`、点击切换 session | **已实现（PR #38）** | UI 手测、样式/交互微调 |
| **B** | 左栏过滤 `hermes-bot-*` / group session | **部分**：`sessions.provide({ fleetKind })` 已写入；**左栏 DOM 隐藏未做**（需 DSH ui-workspace slot 或 archive 方案） | 评估 DSH sidebar 扩展或接受「右栏为主入口」 |
| **C** | 群聊中间视图：多人消息头、`@name` / `@everyone` | **部分**：群组 Tab + `owner_web_command` 注入协作命令；**中间 conversation 多人渲染未做** | 接 Group Room transcript / conversation node |
| **D** | 右栏 CRONJOBS：`routines` 列表 + Create | **部分**：CRON Tab 展示 `fleetStatus.routines` + `/routine list`；**Create 对话框未做** | 补 Create Routine UI 或命令向导 |
| **E** | Bot 档案编辑、分组/pin、needs-you 徽章 | **部分**：pin + needs-you 徽章已有；**档案编辑 Modal 未做** | Bot 编辑 / 确认 / 停用入口 |

---

## 3. 整个项目发展到哪一步了

### 3.1 仓库定位

- **名称**：DeepSeek-Bot（npm 包 `dsh-hermes-bot`）
- **类型**：DSH Cordis 插件（Telegram + 飞书/Lark + Fleet 控制平面）
- **状态目录**：`${DSH_HOME}/hermes-bot/`（或 `DEEPSEEK_BOT_HOME`）
- **文档入口**：[README.md](../README.md)、[docs/FLEET.md](FLEET.md)、[docs/DYNAMIC_BOT_FLEET_V1.md](DYNAMIC_BOT_FLEET_V1.md)

### 3.2 Fleet 能力分层（已完成 vs 待做）

```text
┌─────────────────────────────────────────────────────────────┐
│  DSH Web UI（client.tsx）          ← PR #38 主要改这里       │
├─────────────────────────────────────────────────────────────┤
│  Setup Route（/api/dsh-hermes-bot/setup）  ← PR #38 扩展     │
├─────────────────────────────────────────────────────────────┤
│  BotGateway（gateway.ts）          ← main 已有 + PR #38 小改 │
│  Registry / Team / GroupRoom / Routines / Workflow           │
├─────────────────────────────────────────────────────────────┤
│  HarnessBridge（harness-bridge.ts）  ← Bot Session 进 DSH    │
└─────────────────────────────────────────────────────────────┘
```

### 3.3 Fleet v2 实施计划进度（摘自 docs/FLEET_V2_IMPLEMENTATION_PLAN.md）

| 阶段 | 交付物 | 状态 |
|------|--------|------|
| 0 | 基线、功能开关、回归门 | 已完成 |
| 1 | 动态 Bot Registry、Team、Agent Thread 数据层 | 已完成 |
| 2 | 会话内创建/确认 Bot 并加入 Fleet roster | 已完成 |
| 3 | Bot 跨会话 Peer Messaging | 有界核心已完成 |
| 4 | Manager Agent 与动态任务图 | 确定性控制面已完成 |
| 5 | Saved Workflow + Fleet Dashboard | Store + DAG 已完成；完整编辑器待做 |
| 6 | Hermes/Grok Runtime Adapter | 未开始 |

### 3.4 近期 Git 里程碑（与 DSH Web Fleet 相关）

| PR / 分支 | 内容 | 是否在 main |
|-----------|------|-------------|
| **#36** `cursor/web-chat-bot-creation-d988` | owner web 会话注册、`bot_create_draft` 工具隔离 | ✅ 已合并 |
| **#37** `cursor/dsh-web-fleet-group-room-9c92` | 未绑定 DSH web 会话可触发 Fleet / Group Room；`deliverLocalWebNotice` | ✅ 已合并 |
| **#38** `cursor/hermes-fleet-sidebar-cf56` | Hermes 右栏 BOTS + Web setup API + CRON/群组 Tab | ❌ **Draft PR，未合并** |

**main 上已有**：Gateway 层 owner web 命令分流、Group Room、动态 Bot 创建 API 路径。  
**main 上没有**：320px 右栏 UI、Web 一键启用 Fleet、`save_fleet_config` 等 setup action。

---

## 4. 云端最近几轮工作详情（PR #38）

### 4.1 改动文件一览（+827 行）

| 文件 | 改动要点 |
|------|----------|
| `src/client.tsx` | +545 行：`FleetWebController`、`FleetSidebarRail`、`BotCreateDialog`；`shell.overlay` 注册；设置页新开关 |
| `src/setup-route.ts` | +154 行：4 个新 POST action |
| `src/gateway.ts` | +68 行：Web dashboard 方法；`fleetStatus` 增加 teams/routines |
| `src/index.ts` | 接线 setup-route actions |
| `src/ambient.d.ts` | 声明 `shell.overlay` slot（TypeScript） |
| `test/setup-route.test.mjs` | 新 action 测试 |

**Commit**：`daa5c31` — `feat: Hermes-style web Fleet sidebar with BOTS, groups, and cronjobs`

### 4.2 右栏 UI 行为（`FleetSidebarRail`）

- **挂载方式**：`ctx.slots.inject('shell.overlay', () => ctx.slots.register(...))`
- **布局**：`position: fixed; right: 0; width: 320px; height: 100vh`
- **Tab**：
  - **BOTS**：搜索、pin（localStorage key `dsh-hermes-bot:fleet-pinned`）、状态点、needs-you 徽章
  - **群组**：`fleet.teams` + `fleet.rooms`，按钮注入 `@team` / 多 Bot mention 命令
  - **CRON**：`fleet.routines` 列表 + 「刷新 Cron 列表」→ `/routine list`
- **+ New Agent**：模态对话框 → `POST save_fleet_config`（若未启用）+ `POST bot_create_draft`
- **点击 Bot**：
  - 草稿 + 有 `activationCode` → 注入 `/bot confirm <code>`
  - 否则 → `ctx.sessions.open(canonicalSessionId)` 或 `@bot` 首条消息

### 4.3 新增 Setup Route Actions

| Action | Body 要点 | 作用 |
|--------|-----------|------|
| `save_fleet_config` | `{ enableFleet?: true, collaboration?, profiles? }` | Web 专用保存 Fleet 配置；**不校验飞书 App Secret**；默认打开 `webChatBotCreation` |
| `bot_create_draft` | `{ sessionId, handle, title, description?, capabilities?, soul?, fleetRole? }` | 调用 `gateway.createWebDashboardBotDraft` |
| `owner_web_command` | `{ sessionId, text }` | 调用 `gateway.dispatchOwnerWebCommand` |
| `team_create` | `{ sessionId, name, memberBotIds[] }` | 调用 `gateway.createWebDashboardTeam` |

**Endpoint**：`POST /api/dsh-hermes-bot/setup`（仅 loopback 可信请求，与现有设置页相同）

### 4.4 新增 Gateway 公共方法

```typescript
dispatchOwnerWebCommand(sessionId, text)      // → acceptOwnerWebInbound
createWebDashboardBotDraft(input)             // → createDynamicBotDraft(LOCAL_WEB_TARGET)
createWebDashboardTeam(name, memberBotIds)    // → teams.createTeam
```

`fleetStatus()` 新增返回字段：

- `fleet.teams[]` — id, name, memberBotIds, status, managerBotId, …
- `fleet.routines[]` — id, name, cron, timezone, workflowId, status, nextRunAt, …

### 4.5 设置页变更

- 侧栏标签：**飞书机器人** → **DeepSeek Bot**
- 新 checkbox：
  - 「允许在 DSH Web 右栏创建 Bot（推荐）」→ `webChatBotCreation`
  - 「启用 Cron Workflow（右栏 CRONJOBS）」→ `routines`（依赖 `savedWorkflows`）

### 4.6 Phase B 实际落地情况（重要）

已实现：

```typescript
ctx.sessions.provide({
  props: ['fleetKind'],
  resolve(sessionId) {
    if (sessionId.startsWith('hermes-bot-')) return { fleetKind: 'bot' }
    if (sessionId.startsWith('hermes-group-')) return { fleetKind: 'group' }
    return { fleetKind: undefined }
  },
})
```

**未实现**：左栏 `ui-workspace` Session 行过滤。原因：DSH 当前没有公开的 per-session sidebar filter slot；`archiveSession` 会导致选中 archived session 时被 clear，不可行。

**接手建议**：短期以右栏为主入口；中期向 DSH 提 `sidebar.workspaces.session` chain slot，或在 ui-workspace 合入 `origin: 'subagent'` 同类过滤逻辑。

---

## 5. 云端验证记录（与本地差异）

| 项目 | 云端结果 | 说明 |
|------|----------|------|
| `npm test` | ✅ **166/166** 通过 | 含 setup-route 新 action 测试 |
| `npm run build`（tsc） | ✅ 通过 | |
| `npm run build:client`（tsdown） | ❌ 失败 | 环境缺 `unrun` 模块；**本地 Node 版本需满足 tsdown 要求** |
| DSH Web 3080 UI 手测 | ❌ 未做 | Cloud Agent 无完整 DSH Web 桌面环境 |
| 代码推送到 GitHub | ✅ | branch + Draft PR #38 |
| 同步到用户本地电脑 | ❌ **不会自动发生** | 需本地 `git fetch && checkout` |

---

## 6. 本地接手：第一步（拉代码）

```bash
cd /path/to/DeepSeek-Bot

git fetch origin
git checkout cursor/hermes-fleet-sidebar-cf56
git pull origin cursor/hermes-fleet-sidebar-cf56

npm ci
npm run build
npm run build:client   # 若失败，见 §8 故障排查
```

确认当前 commit：

```bash
git rev-parse --short HEAD
# 期望：daa5c31
```

---

## 7. 本地接手：接入 DSH Web

### 7.1 安装插件（与 README 一致）

```bash
dsh plugin --profile web add . --ignore-scripts
# 或指向您常用的 profile
dsh web
# 浏览器打开 http://127.0.0.1:3080
```

### 7.2 前置条件

1. DSH Web profile 已启用：`dsh-agent`、`dsh-session`、client peer 组件
2. DeepSeek-Bot 插件已在 profile 的 patch / plugins 中
3. **client 模块已构建**：`dist/client.js` 存在且为最新

### 7.3 推荐测试流程（按顺序）

#### Step 0：确认右栏出现

- 打开 3080，任意页面应看到 **右侧 320px BOTS 面板**（可折叠为 52px）
- 若没有：检查浏览器 DevTools → 是否有 `dsh-hermes-fleet-rail`；检查 DSH 是否加载 `@dsh-hermes-bot/client`

#### Step 1：Owner 会话注册

- 在中间栏 **New Session** 创建一个编程会话（非 `hermes-bot-*`）
- 插件会自动 `POST register_owner_web_session`
- 期望：右栏不再长期显示「Fleet Web 尚未启用」

#### Step 2：一键启用 Fleet

- 右栏点 **一键启用**（或设置页手动勾选 Fleet + webChatBotCreation）
- 期望：`POST save_fleet_config` 200；诊断里 `collaboration.enabled === true`

#### Step 3：创建 Bot（模态，非 composer 塞字）

- 右栏 **+ New Agent**
- 填写：handle=`researcher`，title=`研究员`，职责说明
- 期望：返回草稿 + 8 位确认码（在 setup 响应 / Fleet 控制台可见）
- 在中间 owner 会话发送：`/bot confirm <8位码>`
- 期望：Bot 进入 roster；右栏 BOTS 列表出现 `@researcher`

#### Step 4：1:1 切换 Session

- 右栏点击 `@researcher`
- 期望：中间 `ctx.sessions.open(hermes-bot-…)`；**不是**第二个聊天 App
- 左栏可能仍显示 bot session 行（已知限制，见 §4.6）

#### Step 5：Fleet / Group Room

- 在 owner 会话输入：`/fleet 调研一下 XXX` 或 `@researcher 你好`
- 期望：Gateway 分流到 Fleet planner / Group Room（PR #37 能力）
- 群组 Tab：应能看到 team/room（若已有数据）

#### Step 6：CRON Tab

- 设置页启用 `savedWorkflows` + `routines`
- 右栏 CRON Tab 应列出 routines；或点「刷新 Cron 列表」

#### Step 7：回归

```bash
npm test
# 期望 166/166
```

### 7.4 手测检查清单（可打勾）

- [ ] 右栏不遮挡中间 composer（右下角旧 Fleet Dock 已移除）
- [ ] 建 Bot 对话框文字颜色正常（非白字 invisible）
- [ ] + New Agent 模态可提交
- [ ] Bot 点击切换中间 session
- [ ] needs-you 徽章（草稿待 confirm / 待审批）
- [ ] pin ★/☆ 持久化
- [ ] 群组 Tab 注入命令后 owner 会话有反应
- [ ] CRON Tab 有数据或合理空态
- [ ] 设置页「DeepSeek Bot」可保存 Fleet 开关

---

## 8. 故障排查

### 8.1 右栏完全不出现

1. `dist/client.js` 是否最新：`npm run build:client`
2. DSH profile 是否 inject `@dsh-hermes-bot/client`（见 `package.json` → `dsh.client`）
3. `shell.overlay` 是否被其他插件 shadow（DevTools 查 slot 注册）
4. 控制台是否有 slot 注册报错

### 8.2 `build:client` 失败（unrun / Node 版本）

云端错误：

```text
Error: Failed to import module "unrun"
```

README / package.json 要求 Node `^22.18.0 || >=24.11.0`（tsdown 0.22.14）。本地请：

```bash
node -v
npm run build:client
# 或升级 Node 后重试
```

### 8.3 建 Bot 失败

- 需 `webChatBotCreation: true`（右栏「一键启用」会打开）
- 需先有一个 **owner 编程 session**（非 hermes-bot-*）
- 查看 Network → `POST /api/dsh-hermes-bot/setup` 响应 body

### 8.4 点击 Bot 无 session 切换

- 检查 `diagnostics.bots[].canonicalSessionId` 是否存在
- 草稿 Bot 需先 `/bot confirm`
- 若无 canonical session，会 fallback 为 `@bot 你好…` 命令注入

### 8.5 飞书保存仍要求 App Secret

- `save_fleet_config` 路径**跳过**飞书校验；普通设置页「保存并启动」**仍会**要求
- Web Fleet 快速启用请用右栏「一键启用」或 `action: save_fleet_config`

---

## 9. 关键文件索引

| 路径 | 职责 |
|------|------|
| `src/client.tsx` | DSH Web UI：设置页 + **Fleet 右栏** + owner 会话注册 |
| `src/setup-route.ts` | `/api/dsh-hermes-bot/setup` 全部 action |
| `src/setup-constants.ts` | `HERMES_BOT_SETUP_ROUTE` |
| `src/gateway.ts` | Fleet 控制平面、owner web 分流、Web dashboard API |
| `src/harness-bridge.ts` | Bot/notice 进 DSH Session；`stableSessionId` → `hermes-bot-*` |
| `src/index.ts` | 插件入口、setup-route 接线 |
| `src/collaboration.ts` | BotDirectory、GroupRoomStore、Mailbox、Planner |
| `src/bot-registry.ts` | 动态 Bot Registry |
| `src/team-store.ts` | Team / Thread |
| `src/routine.ts` | Cron Workflow |
| `test/gateway.test.mjs` | owner web / webChatBotCreation 安全测试 |
| `test/setup-route.test.mjs` | setup action 测试 |
| `docs/FLEET.md` | Fleet 用户文档 |
| `docs/FLEET_V2_IMPLEMENTATION_PLAN.md` | v2 阶段计划 |

---

## 10. 后续开发建议（优先级）

### P0 — 本地必须完成

1. **PR #38 UI 手测** + 截图/录屏留档
2. **`npm run build:client` 在本地跑通** 并确认 DSH 加载新 bundle
3. 决定 PR #38 **merge 到 main** 或继续迭代

### P1 — Phase B 左栏过滤

可选方案（择一或组合）：

- 向 DSH 提 Discussion/PR：`sidebar.workspaces.session` chain slot，读取 `fleetKind` 隐藏行
- 或在 Bot session 创建时写 Host session metadata（若 DSH 后续支持 filter）
- 短期 UX：右栏高亮当前 Bot，左栏 duplicate 可接受

### P2 — Phase C 群聊中间视图

- Group Room `transcript` 推到 owner session notice（已有 `deliverLocalWebNotice`）
- 注册 `conversationEvents` / `conversation.chat.node` 渲染带 speaker 头的消息
- 支持 `@everyone` 解析（`parseFleetMentions` 已有）

### P3 — Phase D CRON Create UI

- 右栏 CRON Tab 增加 Create 对话框 → `gateway.createRoutine` 或 `/routine create …`
- 需 `savedWorkflows` + `routines` 开关

### P4 — Phase E Bot 档案编辑

- 右栏 Bot 行长按/菜单 → `bot_update_draft` / 停用 / 删除
- 分组（Folders）与 unread 徽章（结合 `pendingInteraction` + approvals）

### P5 — 与 Fleet v2 产品层整合

- [docs/fleet-v2-external-ai/HANDOFF.md](fleet-v2-external-ai/HANDOFF.md) 中的 `FleetV2Panel` 可接入设置页或右栏子 Tab
- Workflow 编辑器仍待做（阶段 5）

---

## 11. 安全与边界提醒（接手勿破坏）

1. **Owner 工具**（`bot_create_draft`）只装到 **显式注册的 owner web 会话**，never 装到 `hermes-bot-*` worker
2. **`webChatBotCreation`** 与 **`chatBotCreation`**（飞书/Telegram）是 **独立开关**
3. Setup route **仅 loopback**；诊断接口 **不返回** 完整 task body / SOUL / 模型输出（详情需 `fleet_task_detail`）
4. 不要把 App Secret 写入 Git 或 Fleet 状态文件

---

## 12. 云端会话未完成的用户反馈项

以下问题在更早对话中提过，PR #38 旨在解决，**需本地确认**：

| 反馈 | 对策 | 本地需验证 |
|------|------|------------|
| Fleet 浮层挡输入框 | 改为固定右栏，不用右下角 Dock | ✅ 应已解决 |
| 输入框白字 | 建 Bot 改模态对话框，不写 composer | ✅ 应已解决 |
| 看不到建 Bot 入口 | 右栏 + New Agent | ✅ 应已解决 |
| 左栏 Bot 会话与编程 session 混在一起 | 仅 metadata，未 DOM 过滤 | ⚠️ 仍可能存在 |

---

## 13. Git 操作参考

```bash
# 查看 PR #38 相对 main 的 diff
git fetch origin
git diff origin/main...origin/cursor/hermes-fleet-sidebar-cf56 --stat

# 合并前在本地 main 上试 merge（可选）
git checkout main
git pull origin main
git merge --no-ff origin/cursor/hermes-fleet-sidebar-cf56

# 推送前跑测试
npm test
```

---

## 14. 联系上下文（给本地 AI 会话的 Prompt 片段）

若本地新开 Cursor 会话，可直接粘贴：

```text
请阅读 docs/HANDOFF-DSH-WEB-FLEET-UI.md。
当前工作在分支 cursor/hermes-fleet-sidebar-cf56（PR #38），目标是 DSH Web Hermes 式右栏 BOTS。
main 已有 Gateway owner-web + Group Room（PR #36/#37），本分支补 UI 和 setup API。
请先本地 build:client、接入 DSH 3080 手测右栏，再决定 Phase B/C/D/E 下一步。
```

---

## 15. 变更日志（本 handoff 覆盖的云端轮次）

| 时间（约） | 内容 |
|------------|------|
| 对话早期 | Fleet 设置页、Gateway Web 命令、owner 会话注册（已进 main） |
| PR #37 | 未绑定 DSH web 可开 Fleet / Group Room |
| PR #38（本轮） | 右栏 BOTS UI、save_fleet_config、bot_create_draft、owner_web_command、team_create、teams/routines 诊断 |

---

**文档版本**：1.1  
**对应 commit**：`97d61d9`（含 handoff 文档本身）  
**维护**：本地会话完成手测后，请在本文件末尾追加「本地验证记录」一节（日期、环境、截图路径、发现的问题）。

---

## 16. 本地文档套件（2026-08-28 本地接手）

本地会话已 checkout `cursor/hermes-fleet-sidebar-cf56` 并补充以下文档（与本文互补，不重复粘贴全文）：

| 文档 | 用途 |
|------|------|
| [docs/README.md](README.md) | 全仓库文档索引 |
| [docs/DSH_WEB_FLEET_UI.md](DSH_WEB_FLEET_UI.md) | 右栏 UI 架构、Phase A–E、槽位与交互 |
| [docs/DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md) | `save_fleet_config` 等 Web API 参考 |
| [docs/DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md) | 3080 手测清单与验证记录模板 |

**本地 git 状态说明**：若之前在 `main` 有未提交改动，已 `git stash` 为 `local-main-work-before-handoff-cf56`；需要时可 `git stash list` / `git stash pop` 合并。

### 本地验证记录 — 待填写

_（接手后完成 `npm run build:client` + DSH 3080 手测，在此或 [DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md) 填写。）_
