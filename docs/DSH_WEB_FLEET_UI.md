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
- **布局**：`position: fixed; right: 0; width: 320px`（可折叠为 52px）  
- **状态轮询**：`FleetWebController` 每 2s `GET` setup route 刷新 diagnostics

> **说明**：`shell.overlay` 不参与 AppFrame 三栏 grid，会浮在对话上方。上游 [DSH discussion #4070](https://github.com/deepseek-ai/deepseek-harness/discussions/4070) 正在讨论 additive `shell.right-rail`；中期应向该槽位迁移。

### 4.2 点击优先（禁止斜杠命令操作）

Web 右栏是产品主入口。用户**不需要、也不应该**在输入框里敲 `/bot`、`/team`、`/routine`、`/fleet`、`/approve`。

允许保留的文本输入只有两类：

1. **群协作里的 `@人` / `@everyone`**（派任务对话框里填写自然语言任务，系统自动带上 mention）
2. **个别主技能**：例如「自动规划」对话框里写任务描述（后台可走 Fleet planner，界面不出现斜杠）

其余全部做成：**行点击、行尾 ⋯、右键菜单、对话框按钮**。

| Tab | 内容 | 点击动作 |
|-----|------|----------|
| **BOTS** | roster + registry 草稿 | 左键打开会话 / 确认草稿；⋯ 与右键：置顶、派任务、停用、启用、删除 |
| **群组** | `fleet.teams` + `fleet.rooms` | 「+ 新建 Team」对话框；⋯：给群发任务（`@team`） |
| **CRON** | `fleet.routines` | 刷新走 GET；⋯：启用 / 停用 / 删除（`routine_update`） |

### 4.3 + New Agent 流程

1. 用户在中栏先打开 **owner 编程 Session**（非 `hermes-bot-*`）  
2. 右栏打开模态对话框（**不写 composer 提示语**）  
3. `POST save_fleet_config`（若 Fleet 未启用则一键打开）  
4. `POST bot_create_draft` → 返回 8 位确认码  
5. **同一对话框点「创建并激活」**：`POST fleet_approval_resolve`（不再往会话里塞 `/bot confirm`）  
6. 右栏 BOTS 列表出现 `@handle`；点击 → `ctx.sessions.open(canonicalSessionId)`

### 4.4 点击 Bot 行为

| Bot 状态 | 左键 | ⋯ / 右键 |
|----------|------|----------|
| 草稿 + 有确认码 | `fleet_approval_resolve` 激活 | 确认激活、删除草稿 |
| 已激活 + 有 `canonicalSessionId` | `ctx.sessions.open(canonicalSessionId)` | 打开会话、派任务、置顶、停用、删除 |
| 无 canonical session | 提示用「派任务」开始对话 | 派任务（`@handle <任务>`，允许的 mention 例外） |

### 4.5 状态展示

- **状态点**：结合 session `running`、registry `busy`、草稿 `needsYou`  
- **needs-you 徽章**：待 confirm 草稿、待审批、session `pendingInteraction`  
- **pin**：仅客户端 localStorage，不上传服务端

## 5. Phase 进度（A–E）

| Phase | 内容 | 状态 |
|-------|------|------|
| **A** | 右栏 BOTS、+ New Agent、session 切换 | **基本实现（PR #38）** |
| **B** | 左栏隐藏 `hermes-bot-*` / group session | **部分**：`fleetKind` metadata 已有；DOM 过滤未做 |
| **C** | 群聊中间视图多人消息头 | **部分**：群组 Tab 用对话框发 `@team` 任务；conversation 多人渲染未做 |
| **D** | CRON Create UI | **部分**：列表 + 点击启用/停用/删除；Create 对话框未做 |
| **E** | Bot 档案编辑、分组、needs-you | **部分**：pin + 徽章 + ⋯ 菜单已有；编辑 Modal 未做 |

### Phase B 已知限制

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

未实现：左栏 `ui-workspace` Session 行 DOM 过滤。DSH 暂无公开 per-session sidebar filter slot；`archiveSession` 会导致选中 archived session 时被 clear，不可行。

**短期 UX**：以右栏为主入口；左栏 duplicate 可接受。  
**中期**：向 DSH 提 `sidebar.workspaces.session` chain slot。

## 6. 与 main 的差异

| 能力 | main | PR #38 分支 |
|------|------|-------------|
| Gateway owner-web / Group Room | 有 | 有 |
| 320px 右栏 BOTS UI | 无 | 有 |
| `save_fleet_config`（免飞书 Secret） | 无 | 有 |
| Web `bot_create_draft` setup action | 无 | 有 |
| 右下角 Fleet Dock | 可能有旧版 | **已移除**，改为右栏 |

## 7. 关键源码

| 文件 | 职责 |
|------|------|
| `src/client.tsx` | `FleetWebController`、`FleetSidebarRail`、`BotCreateDialog` |
| `src/setup-route.ts` | Web 专用 POST actions |
| `src/gateway.ts` | `dispatchOwnerWebCommand`、`createWebDashboardBotDraft`、`fleetStatus` |
| `src/harness-bridge.ts` | `stableSessionId` → `hermes-bot-*` |
| `src/ambient.d.ts` | `shell.overlay` slot 类型声明 |

## 8. 相关文档

- API 细节：[DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md)  
- 本地手测：[DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md)  
- Fleet 用户命令：[FLEET.md](FLEET.md)  
- 底层协议：[BOTMESH.md](BOTMESH.md)
