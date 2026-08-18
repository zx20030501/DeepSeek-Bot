# Hermes/Grok 风格 Bot Fleet

DeepSeek-Bot Fleet 是运行在单个 DeepSeek Harness 实例内的多 Bot 控制平面。它组合了两类公开设计：

- Hermes Agent 的身份配对、按使用者隔离的消息会话、SOUL/技能和独立子代理思路；
- Grok Build 公开的 plan/review/approve、并行 subagents、Workflow 分阶段执行和统一 Agent Dashboard 思路。

参考资料：

- Hermes Sessions：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md>
- Hermes Delegation：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md>
- xAI Workflows in Grok Build：<https://x.ai/news/workflows>
- xAI Agent Dashboard：<https://x.ai/news/agent-dashboard>

“Grok 风格”表示交互和控制原则相似，不表示复制 xAI 未公开的内部架构。当前实现是本机最多 6 个不同 Bot 的 Fleet v1。

## 最快配置

在 DSH Web 的“飞书机器人”设置区域：

1. 先完成 App ID、App Secret、UID 自动识别或安全配对；
2. 打开“Bot Fleet 设置”，保留推荐的“自动计划需要批准”和“按使用者隔离”；
3. 在 Bot roster 添加至少一个执行 Bot；推荐再添加一个验证 Bot 和一个汇总 Bot；
4. 为每个 Bot 填写能力标签，Planner 会用这些标签匹配任务；
5. 点击“保存并启动”；
6. 在飞书同一聊天发送 `/new`，再发送 `/fleet 你的任务`。

推荐的三个角色：

```text
@researcher   worker       research, source-review
@reviewer     verifier     verify, audit, contradiction-check
@writer       synthesizer  synthesis, writing, summary
```

模型提供方和模型留空时，Bot 继承 DSH 当前默认模型。App Secret 仍只进入本机 DSH 凭据库，不进入 roster、状态文件或 Git。

## 两种协作方式

### 显式路由

```text
@researcher 请核对这份技术方案
```

单个 mention 创建一个 Task、一个 Run 和一条 Mailbox 消息。

```text
@researcher @writer 先研究，再整理成实施方案
```

多个 mention 创建顺序 Group Room。一个“完整轮次”表示所有参与 Bot 各执行一次；不再把一个 Bot 的一次调用误算成一整轮。房间同时受轮数和消息数限制。

### 自动 Fleet

```text
/fleet 调研三个可行方案，独立验证风险并给出最终建议
```

Planner 会：

1. 先经过总 allowlist/配对和每 Bot ACL；
2. 按标题、职责、能力和技能标签选择 worker；
3. 优先选择 `verifier` 角色做独立验证；
4. 优先选择 `synthesizer` 角色汇总；
5. 展示计划和审批码；
6. 批准后并行执行 worker，随后验证并汇总。

Planner 是确定性的，选择理由会保留；它不会调用另一个模型偷偷生成不可检查的路由决定。

## 审批

默认 `approvalMode: auto-planned`：自动 `/fleet` 计划需要批准，用户明确写出的普通 `@bot` 不重复询问。可选策略：

- `never`：不要求 Fleet 审批；
- `auto-planned`：自动计划需要审批；
- `multi-bot`：多 Bot 操作需要审批；
- `always`：所有 Fleet 操作都需要审批。

单个 Bot 还可以启用 `approvalRequired`。审批可以在同一聊天中执行：

```text
/approvals
/approve ABCD1234
/reject ABCD1234
```

也可以在本机 Fleet 控制台点击“批准”或“拒绝”。聊天审批只接受原请求者；本机受信设置页视为管理员入口。审批默认 30 分钟过期，过期的 Workflow 会取消，过期的 Handoff 会拒绝。审批决定先持久化；如果进程恰好在“已批准”落盘后、实际派发前退出，重启会幂等补做 Workflow 或 Handoff，不会永久卡在等待状态。

聊天中的 `/tasks`、`/approvals` 和 `/mesh` 只显示当前请求者自己的记录；本机受信控制台才提供整机管理员视图。

## 会话隔离

默认 `requester` 与 Hermes 的推荐群聊隔离原则一致：同一个 Bot 服务不同用户时使用不同 DSH Session，避免上下文、工具状态和 token 消耗互相污染。

每个 Bot 可选：

- `requester`：按请求者隔离，推荐；
- `chat`：同一聊天共享；
- `task`：每个 Task 新建稳定会话；
- `shared`：所有请求共享一个长期会话，有串话风险，必须明确选择。

当平台没有提供群成员 ID 时，`requester` 会退化为按聊天身份隔离。

## 两层权限

权限按以下顺序收紧：

```text
平台 allowlist / 安全配对
            ↓
每 Bot allowedUserIds / allowedChatIds
            ↓
审批策略
            ↓
DSH Agent 与工具自身权限
```

Bot ACL 都为空时继承总白名单；只要填写任一 Bot ACL，就只有匹配该用户或聊天的请求可以调用这个 Bot。Planner 不会把无权使用的 Bot 放进计划。

## 可靠执行

Fleet 使用两条彼此独立的持久化链：

- Inbound WAL 保证平台消息接收后可恢复；
- Typed Mailbox 保证 Bot 任务租约、重试和结果提交可恢复。

每次 Mailbox claim 都有 lease ID 和递增 fencing token。长模型回合会续租；租约过期以后，旧 worker 即使迟到也不能提交结果。单机进程重启会立即回收上一 worker ID 的租约；其他延迟任务再按最早的 `nextAttemptAt`、`leaseExpiresAt` 或消息 TTL 精确唤醒，不依赖固定轮询。

模型调用失败时，旧 Run 终止并创建一个新的 Run/attempt；这与简单地把同一个失败 Run 放回队列不同，第二次会真正再次调用模型。超过上限后进入 dead-letter，并在 Fleet 控制台显示原因。

如果进程恰好在 Mailbox 已确认结果、但 Run 输出尚未写入的狭窄窗口退出，重启恢复会识别这个不完整提交并创建新的 Run，而不会让 Task 永久停在 `running`。Workflow 的并发输出更新按工作流串行写入，避免多个 worker 同时结束时互相覆盖。

结构化 Handoff 获批后会先推进源 Run 的 fencing token 并取消源投递，再创建目标 Run；`accepted` Handoff 和已经持久化的审批决定都会在重启后幂等恢复。恢复轮询不会重复创建目标 Run，也不会把已经运行的目标任务重置回等待状态。低层 `sendBotMessage()` 会执行 Bot ACL，并拒绝绕过 `approvalRequired` 或全局 `always` 审批策略。

BotMesh 内部 Bot Session 还会获得受限 DSH Tool `bot_fleet_handoff`。模型只能填写目标 Bot、理由和是否主动要求审批；Task ID、Run ID、请求者和回复目标都由 Gateway 从当前执行上下文推导，不能由模型伪造。工具会结束源 Bot 当前回合，直接任务可以转交；固定 Workflow 和 Group Room 暂不允许在运行中动态改图。

## 状态与命令

- `/bots`：可用 roster；
- `/fleet <任务>`：自动工作流；
- `/tasks`：最近 Task；
- `/task <id>`：按需查看自己 Task 的完整详情、Run、Handoff 和 Workflow；
- `/cancel <id>`：取消自己仍在执行的 Task，并 fence 相关投递和迟到结果；
- `/replay <id>`：以新的 Task/Run/Workflow ID 重放自己的历史 Task；
- `/approvals`：待审批；
- `/approve`、`/reject`：处理审批；
- `/mesh`：Mailbox、Task、Run、Handoff、Workflow 和运行数量。

本机控制台显示 Bot、活动 Run、Workflow、Task、审批和 dead-letter。Task 行可按需展开详情、取消或重放；取消前会二次确认。常规 2 秒状态刷新只携带短标题和状态，不携带完整指令、结果或模型输出；只有点击详情时才读取完整内容。重放会创建全新身份并重新检查当前 ACL；聊天发起的重放继续遵守审批策略，本机管理员的明确点击本身视为人工批准，不会复活旧 Run。本机控制台是受信管理员入口；聊天命令只允许原请求者操作自己的 Task。持久化文件位于：

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── mailbox.jsonl
├── tasks.jsonl
├── rooms.json
└── approvals.json
```

这些文件包含任务或模型结果，只应保存在运行机。

## 当前真实边界

已实现的是单机 Fleet v1：确定性 Planner、最多 6 个 Bot、固定的 execute/verify/synthesize Workflow、可靠 Mailbox、可恢复审批、公开 Handoff API、受限模型 Handoff Tool，以及带详情/取消/重放的本机控制台。

尚未实现：

- Grok Build 式数百代理弹性 fan-out；
- 用户可保存和复用的任意 Workflow 脚本；
- 通用 DAG 编辑器和动态阶段；
- 跨机器 Fleet Transport 与分布式一致性；
- Routine/cron 触发器；
- Workflow 或 Group Room 运行中的任意动态 Handoff/DAG 改图；
- 完整 transcript/audit 搜索和通用 DAG 编辑界面。

这些边界不影响当前本机 2–6 Bot 协作，但不能把本项目描述成 xAI Grok Build 的完整复制品。
