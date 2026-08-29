# DSH Web Fleet UI 技术说明

更新时间：2026-08-28  
对应分支：`cursor/hermes-fleet-sidebar-cf56`（PR #38）  
交接文档：[HANDOFF-DSH-WEB-FLEET-UI.md](HANDOFF-DSH-WEB-FLEET-UI.md)

## 1. 设计目标

在 **不 fork DeepSeek Harness**、**不做独立聊天 App** 的前提下，把 Grok Bot / Hermes Desktop 的协作体验嵌进 DSH Web（`127.0.0.1:3080`）：

| 区域 | 职责 |
|------|------|
| **左栏** | DSH 原生 Workspace / Session 树（理想状态：隐藏 `hermes-bot-*` 行，见 Phase B） |
| **中栏** | 永远只有一个活跃编程 Session；点 Bot = `ctx.sessions.open(canonicalSessionId)` |
| **右栏** | BOTS 通讯录：搜索、pin、状态点、+ New Agent、群组与 CRON Tab |

## 2. Hermes 不变式（实现时必须遵守）

1. **One bot = ONE canonical forever-chat**  
   每个 Bot 对应稳定 `canonicalSessionId`（`hermes-bot-*`），禁止每次点击新建会话。

2. **群 = room session**  
   成员在各自 canonical session 执行；结论通过 Group Room / Mailbox 写回房间。

3. **Owner 与 worker 隔离**  
   `bot_create_draft` 等 owner 工具只装到显式注册的 owner web 会话，**never** 装到 `hermes-bot-*` worker。

## 3. 架构分层

```text
┌─────────────────────────────────────────────────────────────┐
│  DSH Web 客户端（src/client.tsx）                            │
│  FleetWebController · FleetSidebarRail · BotCreateDialog     │
│  shell.overlay 槽位 · sessions.provide(fleetKind)            │
├─────────────────────────────────────────────────────────────┤
│  Setup Route（POST /api/dsh-hermes-bot/setup）               │
│  save_fleet_config · bot_create_draft · owner_web_command …  │
├─────────────────────────────────────────────────────────────┤
│  BotGateway（src/gateway.ts）                                │
│  owner web 命令分流 · Web dashboard API · fleetStatus        │
├─────────────────────────────────────────────────────────────┤
│  HarnessBridge · Registry · Team · GroupRoom · Routines      │
└─────────────────────────────────────────────────────────────┘
```

## 4. 右栏实现要点

### 4.1 挂载方式

- **槽位**：`ctx.slots.inject('shell.overlay', …)`  
- **组件**：`FleetSidebarRail`（class `dsh-hermes-fleet-rail`）  
- **布局**：右栏 `clamp(300px, 24vw, 360px)`（折叠约 40px）；host `position:absolute`，中栏 `padding-right` 让位  
- **状态轮询**：`FleetWebController` 每 2s `GET` setup route 刷新 diagnostics（静默失败且已有数据时不要用红条盖住列表）

> **说明**：`shell.overlay` 不参与 AppFrame 三栏 grid，会浮在对话上方。上游 [DSH discussion #4070](https://github.com/deepseek-ai/deepseek-harness/discussions/4070) 正在讨论 additive `shell.right-rail`；中期应向该槽位迁移。

### 4.2 点击优先（禁止斜杠命令操作）

Web 右栏是产品主入口。用户**不需要、也不应该**在输入框里敲 `/bot`、`/team`、`/routine`、`/fleet`、`/approve`。

允许保留的文本输入只有两类：

1. **群协作里的 `@人` / `@everyone`**（派任务对话框里填写自然语言任务，系统自动带上 mention）
2. **个别主技能**：例如「自动规划」对话框里写任务描述（后台可走 Fleet planner，界面不出现斜杠）

其余全部做成：**行点击、行尾 ⋯、右键菜单、对话框按钮**。

| Tab | 内容 | 点击动作 |
|-----|------|----------|
| **BOTS** | roster + registry 草稿 | 左键打开会话 / 确认草稿；⋯：编辑档案、派任务、置顶、停用、删除 |
| **群组** | `fleet.teams` + `fleet.rooms` | 「+ 新建 Team」；「发任务」`fleet_team_dispatch`；⋯ 删除 Team；房间标题 `群聊 · @a、@b` |
| **CRON** | `fleet.routines` | 新建对话框 `routine_create`；⋯：启用 / 停用 / 删除（`routine_update`） |

### 4.3 + New Agent 流程

1. 用户在中栏先打开 **owner 编程 Session**（非 `hermes-bot-*`）  
2. 右栏打开模态对话框（**不写 composer 提示语**）  
3. `POST save_fleet_config`（若 Fleet 未启用则一键打开）  
4. `POST bot_create_draft` → 返回 8 位确认码  
5. **同一对话框点「创建并激活」或列表「确认激活」**：`POST bot_registry_status`（`status: active`）。不要 `fleet_approval_resolve`，不要 `/bot confirm`。  
6. 右栏 BOTS 列表出现 `@handle`；点击 → 没有该 session 则 `sessions.create({ sessionId, cwd })`，再 `ctx.sessions.open(canonicalSessionId)`

### 4.4 点击 Bot 行为

| Bot 状态 | 左键 | ⋯ / 右键 |
|----------|------|----------|
| 草稿 | `bot_registry_status` → `active` | 确认激活、删除草稿 |
| 已激活 | `sessions.create`（若缺）+ `open(canonicalSessionId)` | 编辑档案、派任务、置顶、停用、删除 |

### 4.5 状态展示

- **状态点**：结合 session `running`、registry `busy`、草稿 `needsYou`  
- **needs-you 徽章**：待 confirm 草稿、待审批、session `pendingInteraction`  
- **pin**：仅客户端 localStorage，不上传服务端

## 5. Phase 进度（A–E）

| Phase | 内容 | 状态 |
|-------|------|------|
| **A** | 右栏 BOTS、+ New Agent、session 切换 | **完成**（含暗色、栏宽、webview CORS） |
| **B** | 左栏隐藏 `hermes-bot-*` / group session | **完成（DOM）**：`installFleetSessionSidebarHide`；禁止 `archiveSession` / `ctx.workspaces` |
| **C** | 群聊中间视图多人消息头 | **未做**：群组 Tab 可发任务/去重/删除；中栏多人头与点选 `@人` 仍缺 |
| **D** | CRON Create UI | **完成**：新建 + 启用/停用/删除 |
| **E** | Bot 档案编辑、分组、needs-you | **基本完成**：`BotEditDialog` + pin + 徽章；分组未做 |

### Phase B 实现说明

```typescript
ctx.sessions.provide({
  props: ['fleetKind'],
  resolve(binding) {
    const id = typeof binding === 'string' ? binding : String(binding.sessionId ?? binding.id ?? '')
    const fleetKind = id.startsWith('hermes-bot-') ? 'bot'
      : id.startsWith('hermes-group-') ? 'group' : 'session'
    return { props: { fleetKind } }
  },
})
```

`inject` 只用 `['slots', 'sessions']`。左栏隐藏走 fiber + CSS `[data-dsh-hermes-hidden="1"]`。不要读 `ctx.workspaces`。

**下一步优先**：Phase C 群聊中栏多人消息头（不要 fork Harness 核心）。

## 6. 与 main 的差异

| 能力 | main | PR #38 分支 |
|------|------|-------------|
| Gateway owner-web / Group Room | 有 | 有 |
| 右栏 BOTS UI（300–360px） | 无 | 有 |
| `save_fleet_config`（免飞书 Secret） | 无 | 有 |
| Web `bot_create_draft` setup action | 无 | 有 |
| 右下角 Fleet Dock | 可能有旧版 | **已移除**，改为右栏 |

## 7. 关键源码

| 文件 | 职责 |
|------|------|
| `src/client.tsx` | `FleetWebController`、`FleetSidebarRail`、对话框、暗色 CSS、左栏隐藏 |
| `src/setup-route.ts` | Web 专用 POST actions + CORS |
| `src/setup-security.ts` | `isTrustedLocalRequest`（允许 vscode-webview Origin） |
| `src/gateway.ts` | Web dashboard API、`sendAck`、Team 复用/删除、`fleetStatus` |
| `src/harness-bridge.ts` | `stableSessionId` → `hermes-bot-*` |
| `src/ambient.d.ts` | `shell.overlay` slot 类型声明 |

## 8. 相关文档

- API 细节：[DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md)  
- 本地手测：[DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md)  
- Fleet 用户命令：[FLEET.md](FLEET.md)  
- 底层协议：[BOTMESH.md](BOTMESH.md)
