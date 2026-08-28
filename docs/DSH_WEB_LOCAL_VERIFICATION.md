# DSH Web 本地验证指南

本文是 [HANDOFF-DSH-WEB-FLEET-UI.md](HANDOFF-DSH-WEB-FLEET-UI.md) §7 的独立副本，便于打印打勾与追加验证记录。

## 环境准备

### 1. 拉取分支

```bash
cd /path/to/DeepSeek-Bot
git fetch origin
git checkout cursor/hermes-fleet-sidebar-cf56
git pull origin cursor/hermes-fleet-sidebar-cf56
git rev-parse --short HEAD
# 期望：97d61d9 或更新（含 handoff 文档）
```

### 2. 构建

```bash
npm ci
npm run build
npm run build:client
```

| 要求 | 说明 |
|------|------|
| Node | `^22.18.0` 或 `>=24.11.0`（见 `package.json`） |
| 产物 | `dist/client.js` 必须为最新 |
| 云端已知问题 | `unrun` 模块缺失会导致 `build:client` 失败；本地需满足 Node 版本 |

### 3. 接入 DSH

```bash
dsh plugin --profile web add . --ignore-scripts
dsh web
# 浏览器：http://127.0.0.1:3080
```

前置：profile 已启用 `dsh-agent`、`dsh-session` 及 client peer 组件。

---

## 手测流程（按顺序）

### Step 0：右栏出现

- [ ] 打开 3080，右侧可见 **320px BOTS 面板**（可折叠为 52px）
- [ ] DevTools 存在 `dsh-hermes-fleet-rail` 元素
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
- [ ] 返回 8 位确认码
- [ ] 右栏点击草稿 Bot → 「确认激活」成功（不经过 `/bot confirm`）
- [ ] 右栏 BOTS 出现 `@handle`

### Step 4：1:1 切换 Session

- [ ] 点击 `@handle` 后中栏切换到 `hermes-bot-*` session
- [ ] 中栏仍是 DSH 原生 conversation，不是第二个 App
- [ ] （已知）左栏可能仍显示 bot session 行

### Step 5：Fleet / Group Room

- [ ] owner 会话：`/fleet 调研 XXX` 或 `@researcher 你好` 有 Gateway 响应
- [ ] 群组 Tab 可见 team/room（若有数据）
- [ ] 群组按钮注入命令后 owner 会话有反应

### Step 6：CRON Tab

- [ ] 设置页启用 `savedWorkflows` + `routines`
- [ ] CRON Tab 列出 routines 或合理空态
- [ ] 「刷新 Cron 列表」可用

### Step 7：设置页

- [ ] 侧栏标签为 **DeepSeek Bot**
- [ ] 「DSH Web 右栏创建 Bot」开关可保存
- [ ] 「启用 Cron Workflow」开关可保存

### Step 8：回归测试

```bash
npm test
# 期望：166/166（或分支当前测试总数）全部通过
```

---

## 故障排查速查

| 现象 | 检查 |
|------|------|
| 右栏不出现 | `dist/client.js` 是否最新；DSH 是否加载 `@dsh-hermes-bot/client`；控制台 slot 报错 |
| build:client 失败 | `node -v`；升级 Node 后重试 |
| 建 Bot 失败 | `webChatBotCreation`；是否先有 owner session；Network 看 setup 响应 |
| 点击 Bot 无切换 | `diagnostics.bots[].canonicalSessionId`；草稿是否已 confirm |
| 飞书保存要 Secret | 用右栏「一键启用」或 `save_fleet_config`，不要用完整飞书保存路径 |

详见 [HANDOFF-DSH-WEB-FLEET-UI.md §8](HANDOFF-DSH-WEB-FLEET-UI.md#8-故障排查)。

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

### 本地验证记录 — 2026-08-28（部分）

- **执行人**：本地 Cursor 会话（接手交接）
- **分支 / commit**：`cursor/hermes-fleet-sidebar-cf56` @ `97d61d9` + 本地文档补充（未提交）
- **Node 版本**：v24.14.0
- **npm test**：✅ **166/166** 通过
- **build:client**：✅ 通过（`dist/client.js` 131.90 kB）
- **3080 UI 手测**：❌ **未做**（需 `dsh web` + 浏览器）

#### 已完成
- checkout 交接分支
- 补充本地文档套件（见 HANDOFF §16）
- 单元测试与 client 构建验证

#### 待办（P0）
1. `dsh plugin --profile web add . --ignore-scripts && dsh web`
2. 按上文 Step 0–7 完成 3080 右栏手测
3. 决定是否 merge PR #38

#### 备注
- 之前在 `main` 的未提交改动已 stash：`local-main-work-before-handoff-cf56`
