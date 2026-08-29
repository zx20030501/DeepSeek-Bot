# DeepSeek-Bot 文档索引

本目录包含 DeepSeek-Bot 插件的设计、配置、Fleet 协议与 DSH Web UI 相关文档。

## 接手必读（DSH Web Fleet UI）

| 文档 | 用途 |
|------|------|
| [HANDOFF-DSH-WEB-FLEET-UI.md](HANDOFF-DSH-WEB-FLEET-UI.md) | **跨机器交接主文档**（分支 `cursor/hermes-fleet-sidebar-cf56`，PR #38，功能 HEAD `2c7ff5b`） |
| [DSH_WEB_FLEET_UI.md](DSH_WEB_FLEET_UI.md) | 右栏 BOTS UI 产品形态、槽位挂载、Phase A–E 进度 |
| [DSH_WEB_SETUP_API.md](DSH_WEB_SETUP_API.md) | `/api/dsh-hermes-bot/setup` Web 专用 action 参考 |
| [DSH_WEB_LOCAL_VERIFICATION.md](DSH_WEB_LOCAL_VERIFICATION.md) | 本地 3080 手测流程与检查清单（含验证记录模板） |

另一台机器 / 新开会话可直接粘贴：

```text
请阅读 docs/HANDOFF-DSH-WEB-FLEET-UI.md。
分支 cursor/hermes-fleet-sidebar-cf56（PR #38），功能 HEAD 至少 2c7ff5b。
目标：DSH Web 右栏 BOTS 通讯录，不 fork Harness。禁止斜杠命令当主交互。
先 git pull、npm run build:all、接入 3080，再按文档「下一步」继续。优先：群聊中栏多人消息头。
```

## 产品与架构

| 文档 | 用途 |
|------|------|
| [RESEARCH_AND_DESIGN.md](RESEARCH_AND_DESIGN.md) | Hermes / DSH 调研结论与分层设计 |
| [FLEET.md](FLEET.md) | Fleet 用户指南（命令、审批、会话隔离） |
| [DYNAMIC_BOT_FLEET_V1.md](DYNAMIC_BOT_FLEET_V1.md) | 动态 Bot 注册与自动加入 Fleet roster |
| [FLEET_V2_IMPLEMENTATION_PLAN.md](FLEET_V2_IMPLEMENTATION_PLAN.md) | Fleet v2 分阶段实施计划与完成门 |
| [BOTMESH.md](BOTMESH.md) | BotMesh 协议（Mailbox、Workflow、Group Room） |

## 配置与运行时

| 文档 | 用途 |
|------|------|
| [CONFIGURATION.md](CONFIGURATION.md) | 环境变量、飞书开通、profile 示例 |
| [FLEET_CONTRACTS_V1.md](FLEET_CONTRACTS_V1.md) | 消息 Envelope 与地址契约 |
| [RUNTIME_ADAPTERS.md](RUNTIME_ADAPTERS.md) | Hermes/Grok Runtime 适配器边界 |
| [RUNTIME_ROUTINES_GATEWAY.md](RUNTIME_ROUTINES_GATEWAY.md) | Routine 与 Gateway 接入 |
| [ROUTINES.md](ROUTINES.md) | Cron Workflow 用户说明 |
| [REMOTE_TRANSPORT.md](REMOTE_TRANSPORT.md) | 跨机器 Bot Transport |

## 外部协作包（fleet-v2-external-ai）

| 文档 | 用途 |
|------|------|
| [fleet-v2-external-ai/README.md](fleet-v2-external-ai/README.md) | 外部 AI 协作包总览 |
| [fleet-v2-external-ai/HANDOFF.md](fleet-v2-external-ai/HANDOFF.md) | Fleet v2 面板交接 |
| [fleet-v2-external-ai/UI_INTEGRATION.md](fleet-v2-external-ai/UI_INTEGRATION.md) | `FleetV2Panel` 接入说明 |

## 分支与 PR 对照（2026-08-28）

| 分支 / PR | 内容 | 是否在 main |
|-----------|------|-------------|
| main @ `1674cf5+` | Gateway owner-web、Group Room（#36/#37） | 是 |
| `cursor/hermes-fleet-sidebar-cf56` / **#38** | Hermes 右栏 BOTS：点击化 + 暗色 + CORS/webview + Team 去重删除 | **否（Draft）** |
