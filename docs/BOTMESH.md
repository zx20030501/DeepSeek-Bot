# DeepSeek-Bot BotMesh 协议

BotMesh 是 Bot Fleet 的本机可靠执行层。它不修改 DeepSeek Harness Agent Loop；它负责目录、任务状态、投递、租约、审批、协作房间和审计。

面向使用者的配置和命令见 `docs/FLEET.md`。

## 分层

```text
Telegram / 飞书
       │
       ▼
访问控制 + Inbound WAL + chat lane
       │
       ├── 普通消息 ──────────────────────────────→ 当前聊天 Session
       │
       └── @bot / /fleet
                │
                ▼
       BotDirectory + FleetPlanner + Approval
                │
                ▼
       Task / Workflow / Run / Handoff / Audit
                │
                ▼
       Typed Mailbox ──lease/fencing──→ DSH Bot Session
                │                              │
                └──── Group Room / Outbox ←───┘
```

- `BotDirectory`：profile、能力、技能、SOUL、Fleet 角色、会话范围和每 Bot ACL；
- `FleetPlanner`：确定性能力匹配，选择 worker、verifier 和 synthesizer；
- `FleetApprovalStore`：短码、过期、批准和拒绝；
- `TaskRunStore`：Task、Workflow、Run、Handoff 和 Audit 的 append-only 真相；
- `BotMailbox`：幂等入队、TTL、lease、续租、ack、重试唤醒、dead-letter 和 fencing；
- `GroupRoomStore`：2–6 Bot 顺序协作、完整轮次、消息上限和 epoch；
- DSH Agent Session：真正执行模型回合。

## Message Envelope

内部请求使用 `BotMessageEnvelope`：

```json
{
  "id": "msg_xxx",
  "kind": "request",
  "from": "user:feishu:ou_xxx",
  "to": "researcher",
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "attemptId": "attempt_xxx",
  "correlationId": "workflow_xxx",
  "roomId": "room_xxx",
  "epoch": 1,
  "payload": {
    "instruction": "研究并验证这个方案",
    "requester": "user:feishu:ou_xxx",
    "replyTarget": { "platform": "feishu", "chatId": "oc_xxx" },
    "workflowPhase": "execute"
  },
  "createdAt": 0,
  "expiresAt": 0
}
```

`taskId` 是业务任务；每次真正的模型尝试都有新的 `runId` 和 `attemptId`。`correlationId` 连接 Workflow、Message 和 Audit。`epoch` 防止关闭或 supersede 后的房间迟到结果继续驱动状态。

## Mailbox 与重试

单条投递的正常状态：

```text
queued → claimed → acknowledged → running → completed
                                      ├── failed
                                      └── dead-letter
```

模型调用失败时，当前 Message/Run 终止；如果仍可重试，系统创建新的 Run、attempt 和 Message，并设置 `nextAttemptAt`。这样第二次会真正再次调用模型，不会尝试启动一个已经 failed 的旧 Run。

进程崩溃或 worker 消失时，lease 到期的 Message 可以重新排队；单机进程重启还会立即识别并回收上一 worker ID 的租约，不必空等完整 lease 时长。超过 delivery 上限后进入 dead-letter。每次 claim 都有随机 lease ID 和递增 fencing token，并且所有状态变更还会检查 `leaseExpiresAt`。旧 worker 在租约过期或被重启恢复后不能提交结果。运行中的长回合按租约时长的约三分之一自动续租。

调度器计算最早的 `nextAttemptAt`、`leaseExpiresAt` 和 `expiresAt`，按该时间唤醒。不存在固定 1.5 秒唤醒后错过长退避的问题。

Mailbox 是 `mailbox.jsonl` append-only journal；平台 Inbound WAL 是另一条独立恢复链。如果进程在 Mailbox 完成与 Run 输出落盘之间退出，启动恢复会把该不完整提交转换为新的 Run/Message 尝试，避免 Task 永久卡住。

## Workflow

`/fleet` 创建固定三阶段 Workflow：

```text
execute (1–4 workers in parallel)
              ↓
verify (optional verifier)
              ↓
synthesize (one final answer)
```

不同 Bot 可以并行，同一个 Bot 同时只运行一个 Run，避免同一稳定 Session 被并发写入。每个阶段结果作为不受信报告传给后续 Bot，不能覆盖原始任务指令。并发 worker 的 Workflow 更新按 workflow ID 串行提交；选中的 verifier 如果最终失败，Workflow 不会静默跳过验证。

Workflow、每个 phase 的 Run、Planner 选择依据、输出和最终结果都写入 `tasks.jsonl`。进程重启后，未完成 Workflow 会从持久化 Run/Mailbox 状态继续。

## Group Room

显式同时 mention 多个 Bot 时使用顺序 Group Room。`maxGroupRounds: 3` 表示每个参与 Bot 最多各执行三次，而不是全房间只执行三次。房间仍受 `maxGroupMessages` 的独立上限约束，哪个限制先到就停止。

`supersede()` 会递增 epoch、清空短 transcript 并重置轮次。旧 epoch 的结果只写 stale audit，不再回复或派发下一轮。

## 会话与 ACL

Bot 会话默认 `requester`：稳定但按使用者隔离。还可配置 `chat`、`task` 或显式高风险的 `shared`。`canonicalSessionId` 只表示 Bot 的共享基准 ID；真正执行时由 session scope、请求者、聊天或 Task 解析 scoped session ID。

平台 allowlist/配对先执行；每 Bot `allowedUserIds` / `allowedChatIds` 再收紧。Planner 在选 Bot 前执行同一 ACL，不会通过自动路由绕过权限。

## Handoff 与审批

`BotGateway.requestHandoff()` 是结构化公开 API。Handoff 有 requested、accepted、completed、rejected 状态；需要审批时，批准后才取消并 fence 源 Run、再创建目标 Run。accepted Handoff 可在重启后幂等恢复，不会同时保留一个可继续执行的旧源投递，也不会因重复恢复而创建多个目标 Run。

BotMesh 拥有的内部 Agent Session 会注册 `bot_fleet_handoff` DSH Tool。模型参数只包含 `toBot`、`reason` 和可选 `requireApproval`；Gateway 从当前 Session/Run 推导 Task、请求者和回复目标，因此模型不能跨任务或替别人构造 Handoff。工具结束源回合；等待人工审批时源 Run 先进入 fenced/cancelled，批准后再派发目标。普通聊天 Agent 不安装此工具。当前只允许直接 Task 使用，固定 Workflow 和 Group Room 不接受动态改图。

Workflow 和 Handoff 审批保存在 `approvals.json`。聊天审批仅允许原请求者；本机受信设置页是管理员入口。过期审批会自动取消 pending Workflow 或拒绝 pending Handoff。所有非 pending 决定都会在启动恢复中重新对账，因此“决定已落盘、业务副作用未完成”的崩溃窗口可以安全补做。

Task 控制同样走 Gateway 的所有权边界：聊天中的详情、取消和重放只对原请求者开放，本机设置页可作为管理员操作。取消会关闭 Workflow/Room、拒绝待审批项、取消 Mailbox/Run，并丢弃迟到结果；重放总是创建新的 Task、Run、attempt 和 Workflow 身份。

## 配置

```yaml
profiles:
  researcher:
    title: Research Bot
    fleetRole: worker
    capabilities: [research, source-review]
    skills: [web-research]
    soul: "先给证据，再给结论。"
    sessionScope: requester
    allowedUserIds: []
    allowedChatIds: []
    approvalRequired: false
  reviewer:
    fleetRole: verifier
    capabilities: [verify, audit]
  writer:
    fleetRole: synthesizer
    capabilities: [synthesis, writing]
collaboration:
  enabled: true
  autoPlanner: true
  approvalMode: auto-planned
  defaultSessionScope: requester
  maxGroupBots: 6
  maxGroupRounds: 3
  maxGroupMessages: 10
  maxParallelRuns: 6
  botRunMaxAttempts: 3
  mailboxMaxAttempts: 3
  mailboxLeaseMs: 120000
  mailboxRetryBaseMs: 1000
  mailboxRetryMaxMs: 60000
```

旧 `maxGroupTurns` 仍作为 `maxGroupRounds` 的兼容别名读取。

## 状态文件

```text
mailbox.jsonl   # Envelope 和 delivery 状态
tasks.jsonl     # Task/Workflow/Run/Handoff/Audit
rooms.json      # Group Room/epoch/transcript
approvals.json  # 审批状态
```

文件可能包含任务和模型输出，只保存在运行机，不提交 Git。

## 边界

BotMesh 当前是单机、单 Node.js 进程的控制平面。没有跨机器共识、远程 worker transport、任意 DAG、Routine/cron 或数百代理弹性 fan-out。Web 控制台提供 roster、状态、审批、dead-letter、Task 详情、取消和重放，但还没有 transcript/audit 搜索或 DAG 编辑。
