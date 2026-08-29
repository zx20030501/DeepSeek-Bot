# DSH Web Fleet UI 交接（2026-08-28 夜）

> 给**另一台机器 / 新会话**用：读完本文就能继续探索，不必回溯聊天记录。  
> 旧版云端交接内容已过时（当时还要求 `/bot confirm`、166 测、未手测），以本文为准。

| 项 | 值 |
|----|-----|
| **仓库** | https://github.com/zx20030501/DeepSeek-Bot |
| **分支** | `cursor/hermes-fleet-sidebar-cf56` |
| **HEAD** | `2c7ff5b` — `feat: make the DSH Web BOTS rail usable in dark mode and click-complete` |
| **PR** | https://github.com/zx20030501/DeepSeek-Bot/pull/38 （Draft，未合 main） |
| **main** | 已含 PR #36 / #37（owner-web + Group Room）；**没有**右栏 UI |
| **单测** | `npm test` → **179/179**（`2c7ff5b` 时） |
| **手测环境** | 本机 Windows：DSH Web `http://127.0.0.1:3080`，Harness 源码 `E:\projects\repos\deepseek-harness-dev` |
| **回复语言** | 用户要求中文 |

新开会话可直接粘贴：

```text
请阅读 docs/HANDOFF-DSH-WEB-FLEET-UI.md。
分支 cursor/hermes-fleet-sidebar-cf56（PR #38），HEAD 至少 2c7ff5b。
目标：DSH Web 右栏 BOTS 通讯录，不 fork Harness。禁止斜杠命令当主交互。
先 git pull、npm run build:all、接入 3080，再按文档「下一步」继续。
```

---

## 1. 产品是什么

DeepSeek-Bot（npm `dsh-hermes-bot`）是 **DeepSeek Harness 的 Cordis 插件**，不是独立 App，**不 fork DSH**。

目标体验接近 Grok Bot / Hermes Agent Desktop：

| 区域 | 规则 |
|------|------|
| **中栏** | 永远一个编程 Session。点 Bot / 点群 = `ctx.sessions.open(sessionId)` |
| **右栏** | BOTS 通讯录（搜索、pin、+ New Agent、群组、CRON），不是第二套聊天 App |
| **左栏** | `hermes-bot-*` / `hermes-group-*` 应从工作区树隐藏，入口只在右栏 |

### 不可破坏的不变式

1. **One bot = one canonical session**：`hermes-bot-<handle>`，禁止每次新建。
2. **群 = Group Room**；成员在各自 canonical session 干活，结论回房间。
3. **Owner web 会话** 与 **hermes-bot-* worker** 硬隔离；owner 工具绝不装到 worker。
4. Web 主路径做成 **按钮 / 行尾 ⋯ / 右键**。除群 `@人` 和少数主技能外，**不要再灌 `/bot confirm`、`/fleet`、`/routine create`**。

### 实现上绝对不要做

| 禁止 | 原因 |
|------|------|
| `inject` 里加 `workspaces`，或读 `ctx.workspaces` | Cordis：`cannot get property "workspaces" without inject` |
| `archiveSession` 藏左栏 | 选中 archived session 会被 DSH clear |
| `sessions.provide` 去掉 `resolve` 的 `{ props: { fleetKind } }` | 元数据接不上 |
| `owner_web_command` 给 hermes-bot 会话灌命令 | 会撞 bound scope / 污染 worker |
| 改 Harness 核心来「修」右栏 | 产品约束：只做插件 |

`sessions.provide` 正确形态：

```ts
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

`package.json` → `dsh.client.inject` 只用 connection / runtime / settings / slots / locale。左栏隐藏走 DOM（`installFleetSessionSidebarHide`），不要碰 workspaces。

---

## 2. 现在已经能做什么（已手测）

右栏挂 `shell.overlay`，宽约 **300–360px**，中栏 `padding-right` 让位。暗色用 DSH 真 token：`--dsw-alias-label-primary` / `label-secondary` / `border-l2` / `bg-layer-*`（不是不存在的 `fg-primary`）。

| 能力 | 怎么用 | 走哪条 API | 状态 |
|------|--------|------------|------|
| 一键启用 Fleet | 右栏按钮 | `save_fleet_config` | ✅ |
| 新建 Bot | + New Agent 对话框 | `bot_create_draft` | ✅ |
| 确认激活 | 草稿行「确认激活」 | `bot_registry_status` → active | ✅ 不需要确认码 |
| 打开 1:1 | 点 Bot 名 | `sessions.create({ sessionId, cwd })`（没有则建）再 `open` | ✅ |
| 编辑档案 | ⋯ → 编辑档案 | `bot_update` | ✅ draft/active 都能改 |
| 派任务 | ⋯ → 派任务 | `fleet_dispatch` + `LOCAL_WEB_TARGET` | ✅ 不灌 `/fleet` |
| 自动规划 | 右栏底部 | `fleet_plan` | ✅ |
| 新建 Team | 群组 Tab | `team_create`；同名同成员会 **复用** | ✅ |
| 删除 Team | 群组 ⋯ | `team_delete` | ✅ |
| Team 发任务 | 「发任务」 | `fleet_team_dispatch`；**房间建完即返回**（ack 后台 flush） | ✅ |
| 群聊列表 | 群组 Tab | 标题 `群聊 · @a、@b`；同成员只留最新开着的房间 | ✅ |
| 继续群聊 | 「继续协作」 | `fleet_room_dispatch` | ✅ |
| CRON 新建/启停/删 | CRON Tab | `routine_create` / `routine_update` | ✅ |
| 左栏藏 worker | 自动 | CSS `[data-dsh-hermes-hidden]` | ✅ DOM 方案 |
| 暗色可读 | 自动 | `body[data-ds-dark-theme]` 覆盖 | ✅ |
| Cursor 内置浏览器 fetch | 自动 | loopback 允许 `vscode-webview:` Origin + `sec-fetch-site: cross-site` | ✅ |
| 空白会话引导 | 打开空 Bot 会话时 | 绿条 + 右栏 notice | ✅ DSH「探索未至之境」落地页本身正常 |

空白会话中间是 DSH 自己的落地页，**不是插件崩了**。

---

## 3. 还没做 / 下一步（按优先级）

> **顺序修正（2026-08-28 深夜）**：设计依据见 [CHAT-COLLAB-RESEARCH-GROK-HERMES.md](CHAT-COLLAB-RESEARCH-GROK-HERMES.md)（Grok × Hermes 群聊调研，v1.0）。按其 §8，执行顺序应以「**点群打开 `hermes-group-*`**（容器）→ 按 Bot 归属灌 transcript → Room 长期化 → 驱动器 v1 → 人头」为准——消息头需要群会话容器才有落点，下面第 1 条的「多人消息头」相应后移到容器就绪之后（§8 第 6 步，DSH `conversation` 接不上时仅 overlay fallback）。

1. **群聊中栏**：多人消息头、会话里点选 `@人` / `@everyone`。要接 DSH `conversation` 节点，不要再走 slash。这是产品缺口最大的一块。
2. **点群聊打开中栏房间会话**：现在「继续协作」是对话框发任务，中栏不一定切到 `hermes-group-*`。应对齐点 Bot 的 `sessions.open`。**（← 实际先做这条，见上方顺序修正）**
3. **Team 发任务创建完房间后立刻切到该群聊**（与 2 一起）。
4. **审批卡片**：已按 `entityId` 去重、过期过滤、「忽略」= reject。仍可能留下历史 workflow 卡，可再加批量清理。
5. **PR #38 是否 merge**：建议群聊中栏有一版能用的再合；或先合右栏点击化，中栏当 follow-up。
6. **Fleet v2 设置页面板 / Workflow 编辑器**：见 `docs/FLEET_V2_IMPLEMENTATION_PLAN.md`，不是本分支主线。

---

## 4. 另一台机器怎么起来

### 4.1 代码

```bash
git fetch origin
git checkout cursor/hermes-fleet-sidebar-cf56
git pull origin cursor/hermes-fleet-sidebar-cf56
git rev-parse --short HEAD   # 至少 2c7ff5b

npm ci
npm run build:all            # tsc + tsdown → dist/index.js + dist/client.js
npm test                     # 期望 179+ 全绿
```

Node：`^22.18.0` 或 `>=24.11.0`（tsdown）。`dist/` gitignore，**必须本地 build**。

### 4.2 接到 DSH Web

插件：

```bash
dsh plugin --profile web add . --ignore-scripts
```

本机（Windows）常用：symlink `dsh-hermes-bot@link:E:/projects/repos/DeepSeek-Bot`。改 `dist/` 后 **重启 DSH** 才会进浏览器。

本机 3080 从 **harness 源码**起（不是 npm 全局旧包）：

```text
Harness：<your>/deepseek-harness-dev
命令：   node apps/cli/lib/bin.js web --port 3080
仓库里： restart-dsh.ps1   ← 路径写死了本机 E:\...，换机器请改或手起
```

浏览器：`http://127.0.0.1:3080`。改 client 后硬刷新（Cursor 内置浏览器尤其容易缓存）。

### 4.3 安全 / CORS（换机器必知）

`POST|GET /api/dsh-hermes-bot/setup`：

- Host + socket 必须 loopback
- **外部** `http(s)` Origin 仍拒绝
- 允许：无 Origin、`origin: null`、`vscode-webview:`、loopback 上的 `sec-fetch-site: cross-site`
- 信任通过后回写 `access-control-allow-origin`

Cursor 内置浏览器以前会 `[ERR] Fetch [DSH]: TypeError: Failed to fetch`，根因是旧逻辑把 webview 当 CSRF 拦了。`2c7ff5b` 已修。DSH **自己的** `/api` 仍用 `isTrustedApiRequest`，若整页 RPC 也 Failed to fetch，那是 Harness 核心围栏，**不要为了修 UI 去 fork DSH**。

---

## 5. 关键代码地图

| 路径 | 职责 |
|------|------|
| `src/client.tsx` | 设置页 + `FleetSidebarRail` + 对话框 + 暗色 CSS + 左栏隐藏 |
| `src/setup-route.ts` | `/api/dsh-hermes-bot/setup` 全部 action + CORS |
| `src/setup-security.ts` | `isTrustedLocalRequest` |
| `src/gateway.ts` | Web dashboard：create/update/dispatch/plan/team/room/routine；`fleetStatus` |
| `src/index.ts` | 接线 |
| `src/harness-bridge.ts` | Bot session → DSH；`hermes-bot-*` |
| `restart-dsh.ps1` | 杀 3080 再从 harness-dev 拉起（改路径） |
| `test/setup-route.test.mjs` | Web action + CORS |
| `test/setup-security.test.mjs` | webview Origin |
| `test/gateway.test.mjs` | Team 复用/删除、房间标题、Web 激活/编辑 |

右栏轮询：每 2s `GET` setup；**静默失败且已有数据时不要用红条盖住列表**。

### Web setup actions（Fleet UI 相关）

`save_fleet_config` · `bot_create_draft` · `bot_update` · `bot_registry_status` · `register_owner_web_session` · `fleet_dispatch` · `fleet_plan` · `fleet_team_dispatch` · `fleet_room_dispatch` · `team_create` · `team_delete` · `routine_create` · `routine_update` · `fleet_approval_resolve`

完整字段见 [DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md)（若缺新 action，以 `setup-route.ts` 为准）。

---

## 6. 踩过的坑（换机器很容易再踩）

1. **点 Bot 打不开**：list 里没有 `hermes-bot-*` 时必须 `sessions.create({ sessionId, cwd })`，不要 `ctx.workspaces`。
2. **确认激活是假的**：过期 8 位码不会渲染按钮。Web 走 `bot_registry_status` 直接 draft→active。
3. **暗色看不见字**：用了 `--dsw-alias-fg-primary`（不存在），fallback 成浅色深字。必须用 `--dsw-alias-label-primary`。暗色变量在 `body[data-ds-dark-theme]`。
4. **右栏 overlay 盖住对话**：host 宽度跟 rail 走，并对中栏写 `padding-right`。
5. **Team 发任务绿条很慢**：`sendText` 对 local target 会 `await outbox.flush()`。Web ack 改为入队后后台 flush。
6. **同名 Team 刷屏**：`createWebDashboardTeam` 对相同 name+成员集复用；可 `team_delete`。
7. **`inject: ['slots','sessions']` 不够还去读 workspaces**：必崩。
8. **内置浏览器 MCP 30s 掉线**：本机用 headless Chrome CDP（仓库里曾有 `tmp-verify-*.mjs`，未提交）。不要死磕 MCP。

---

## 7. 建议手测（30 分钟）

暗色主题下打开 3080：

- [ ] 右栏 Bot 名、副标题、「自动规划 / Owner 会话」能看清，不是空框
- [ ] 无 `读取 Fleet 状态失败` / `Failed to fetch`
- [ ] + New Agent → 草稿 → 「确认激活」变 active
- [ ] 点 Bot：中栏切到该 Bot；左栏看不到 `hermes-bot-*`
- [ ] ⋯ 编辑档案，标题立刻变
- [ ] 群组：新建 Team、发任务出现「群聊 · @…」、绿条较快出现
- [ ] ⋯ 删除 Team，列表少一条
- [ ] CRON：新建一条 crontab，列表出现
- [ ] 亮色主题扫一眼，没有浅底浅字

---

## 8. 相关文档

| 文档 | 用途 |
|------|------|
| [README.md](README.md) | 文档索引 |
| [DSH_WEB_FLEET_UI.md](DSH_WEB_FLEET_UI.md) | 槽位 / Phase 说明（部分段落可能旧于本文） |
| [DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md) | setup action 字段 |
| [DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md) | 更长的打勾清单 |
| [FLEET.md](FLEET.md) | Fleet 用户文档 |
| [FLEET_V2_IMPLEMENTATION_PLAN.md](FLEET_V2_IMPLEMENTATION_PLAN.md) | 更长的 v2 路线 |

冲突时：**代码 + 本文 > 旧 Phase 表**。API 字段以 `src/setup-route.ts` 为准。

---

## 9. Git

```bash
git fetch origin
git log -1 origin/cursor/hermes-fleet-sidebar-cf56 --oneline
git diff origin/main...origin/cursor/hermes-fleet-sidebar-cf56 --stat
```

不要把 `.env`、`balance-state.json`、`restart-dsh.log`、`tmp-verify/` 推进仓库。

---

**文档版本**：2.0  
**对应 commit**：写本文时远程 HEAD 为 `2c7ff5b`；若你 `git pull` 后更新，请改本行并补「验证记录」。

### 验证记录

| 日期 | 机器 | HEAD | 结果 |
|------|------|------|------|
| 2026-08-28 | 开发机 Windows + 3080 | `2c7ff5b` | 暗色/CORS/Team 复用删除/发任务返回 已测；179 测绿；已推 PR #38 |
| | （下一台填） | | |
