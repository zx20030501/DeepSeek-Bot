# DSH Web 本地验证指南

本文是 [HANDOFF-DSH-WEB-FLEET-UI.md](HANDOFF-DSH-WEB-FLEET-UI.md) 手测清单的打勾副本。冲突以交接文档 + 代码为准。

## 环境准备

### 1. 拉取分支

```bash
cd /path/to/DeepSeek-Bot
git fetch origin
git checkout cursor/hermes-fleet-sidebar-cf56
git pull origin cursor/hermes-fleet-sidebar-cf56
git rev-parse --short HEAD
# 期望：功能至少 2c7ff5b；文档可能更新于此
```

### 2. 构建

```bash
npm ci
npm run build:all
```

| 要求 | 说明 |
|------|------|
| Node | `^22.18.0` 或 `>=24.11.0`（见 `package.json`） |
| 产物 | `dist/index.js` + `dist/client.js` 必须本地 build（gitignore） |

### 3. 接入 DSH

```bash
dsh plugin --profile web add . --ignore-scripts
# 建议从 Harness 源码起：node apps/cli/lib/bin.js web --port 3080
# 仓库 restart-dsh.ps1 写死了本机路径，换机器请改
```

浏览器：`http://127.0.0.1:3080`。改 `dist/` 后必须重启 DSH，Cursor 内置浏览器请硬刷新。

---

## 手测流程（按顺序）

### Step 0：右栏出现（暗色必测）

- [ ] 打开 3080，右侧 BOTS 约 **300–360px**（折叠约 40px）
- [ ] 暗色下 Bot 名、副标题、「自动规划 / Owner 会话」能看清，不是空矩形
- [ ] DevTools 存在 `dsh-hermes-fleet-rail`
- [ ] **无** `读取 Fleet 状态失败` / `Failed to fetch` / `[ERR] Fetch [DSH]`
- [ ] **无** 右下角旧 Fleet Dock 遮挡 composer

### Step 1：Owner 会话注册

- [ ] 中栏 **New Session** 创建编程会话（非 `hermes-bot-*`）
- [ ] Network 出现 `register_owner_web_session` 200
- [ ] 右栏不再长期显示「Fleet Web 尚未启用」

### Step 2：一键启用 Fleet

- [ ] 右栏点 **一键启用**（或设置页勾选 Fleet + webChatBotCreation）
- [ ] `POST save_fleet_config` 返回 200
- [ ] diagnostics 中 `collaboration.enabled === true`

### Step 3：创建 Bot（模态）

- [ ] 右栏 **+ New Agent**
- [ ] 模态文字颜色正常（非白字不可见）
- [ ] 填写 handle / title / 职责后提交成功
- [ ] 右栏点击草稿 → 「确认激活」成功（`bot_registry_status`，**不**输入确认码、**不** `/bot confirm`）
- [ ] 右栏 BOTS 出现 `@handle`

### Step 4：1:1 切换 Session

- [ ] 点击 `@handle` 后中栏切换到 `hermes-bot-*`（没有该 session 时应自动 `sessions.create`）
- [ ] 中栏仍是 DSH 原生 conversation；空白时出现 DSH 落地页 + 绿条引导，**不是插件崩了**
- [ ] 左栏看不到 `hermes-bot-*`（DOM hide）
- [ ] ⋯「编辑档案」标题立刻变

### Step 5：Fleet / Group Room（全部按钮，禁止 slash）

- [ ] ⋯「派任务」走 `fleet_dispatch`，绿条较快出现
- [ ] 「自动规划」走 `fleet_plan`
- [ ] 群组：新建 Team；同名同成员再次创建应复用
- [ ] 「发任务」出现「群聊 · @…」，HTTP 较快返回
- [ ] ⋯「删除」Team，列表少一条
- [ ] 「继续协作」走 `fleet_room_dispatch`

### Step 6：CRON Tab

- [ ] CRON：新建一条 crontab，列表出现
- [ ] ⋯ 启用 / 停用 / 删除可用

### Step 7：设置页

- [ ] 侧栏标签为 **DeepSeek Bot**
- [ ] 「DSH Web 右栏创建 Bot」开关可保存
- [ ] 「启用 Cron Workflow」开关可保存

### Step 8：回归测试

```bash
npm test
# 期望：179/179（或分支当前测试总数）全部通过
```

---

## 故障排查速查

| 现象 | 检查 |
|------|------|
| 右栏不出现 | `dist/client.js` 是否最新；DSH 是否加载 `@dsh-hermes-bot/client`；控制台 slot 报错 |
| build:client 失败 | `node -v`；升级 Node 后重试 |
| 建 Bot 失败 | `webChatBotCreation`；是否先有 owner session；Network 看 setup 响应 |
| 点击 Bot 无切换 | list 里没有该 id 时必须 `sessions.create({ sessionId, cwd })`；**禁止** `ctx.workspaces` |
| 暗色看不见字 | 必须用 `--dsw-alias-label-primary`，不要用不存在的 `fg-primary` |
| Cursor 浏览器 Failed to fetch | setup 必须允许 `vscode-webview:` Origin；DSH 自己的 `/api` 围栏不要靠 fork Harness 修 |
| 飞书保存要 Secret | 用右栏「一键启用」或 `save_fleet_config` |

详见 [HANDOFF-DSH-WEB-FLEET-UI.md](HANDOFF-DSH-WEB-FLEET-UI.md)。

---

## 本地验证记录（请手测后填写）

> 接手人完成 3080 UI 手测后，在本节追加记录；也可直接写在 HANDOFF 文档末尾 §「本地验证记录」。

### 记录模板

```markdown
### 本地验证记录 — YYYY-MM-DD

- **执行人**：
- **分支 / commit**：
- **Node 版本**：
- **DSH 版本 / profile**：
- **npm test**：通过 / 失败（数量）
- **build:client**：通过 / 失败
- **3080 UI 手测**：通过 / 部分通过 / 未测

#### 通过项
- （列举）

#### 问题
1. （描述 + 截图路径 + 是否阻塞 merge）

#### 截图 / 录屏
- （路径或链接）

#### 结论
- [ ] 建议 merge PR #38
- [ ] 需继续迭代（列出 P0 修复项）
```

### 本地验证记录 — 2026-08-28（开发机）

- **执行人**：开发机 Windows Cursor 会话
- **分支 / commit**：`cursor/hermes-fleet-sidebar-cf56` @ `2c7ff5b`
- **DSH**：`http://127.0.0.1:3080`（harness-dev 源码）
- **npm test**：✅ **179/179**
- **3080 UI 手测**：✅ 暗色对比度、webview CORS、确认激活、点 Bot 开会话、编辑档案、派任务/自动规划、Team 复用删除、CRON 新建、空白会话引导

#### 待办（下一台机器优先）
1. 群聊中栏多人消息头 / 会话里点选 `@人`
2. 点群聊打开 `hermes-group-*` 中栏会话
3. Team 发任务后立刻切到该房间
4. 决定是否 merge PR #38
