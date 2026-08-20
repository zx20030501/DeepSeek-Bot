# DeepSeek-Bot BotMesh Peer Messaging v1

本文件冻结 Part A 的第一版核心消息契约。它是兼容层：继续使用现有 Task、Run、BotMailbox、Audit 和 DSH Agent Session，不另起一套并行持久化真相。

## 1. 目标与非目标

目标是让跨会话、跨 Bot 的消息具备可验证身份、可追踪关联、幂等投递、有限生命周期和可恢复执行。

本增量还没有宣称完成任意 @bot 图路由、Manager Bot、可保存 Workflow DSL 或跨机器 Transport；这些属于后续 Part A 阶段。第一版先把不会被重写的安全和可靠性边界固定下来。

## 2. 地址

每个消息同时保留旧字段 from/to，并可以携带结构化地址：

~~~json
{
  "id": "researcher",
  "type": "bot",
  "sessionId": "hermes-bot-session-...",
  "roomId": "room_...",
  "threadId": "thread_..."
}
~~~

type 目前为 user、bot、system 或 service。id 是逻辑身份，不是自由文本显示名；Bot id 继续遵守现有小写 roster 规则。sessionId 只能在 Gateway 允许的派生会话或 Bot canonical session 范围内使用。

## 3. Envelope

Peer Message v1 的 schemaVersion 为 1，关键字段如下：

~~~json
{
  "id": "msg_...",
  "kind": "request",
  "from": "user:feishu:ou_xxx",
  "to": "researcher",
  "fromAddress": { "id": "user:feishu:ou_xxx", "type": "user" },
  "toAddress": { "id": "researcher", "type": "bot", "sessionId": "..." },
  "taskId": "task_...",
  "runId": "run_...",
  "attemptId": "attempt_...",
  "correlationId": "conversation-or-task",
  "conversationId": "conversation-or-correlation",
  "replyTo": "msg_previous",
  "traceId": "trace_...",
  "hop": 0,
  "maxHops": 4,
  "payload": {
    "instruction": "structured task",
    "requester": "user:feishu:ou_xxx",
    "replyTarget": { "platform": "feishu", "chatId": "oc_xxx" }
  },
  "createdAt": 0,
  "expiresAt": 0,
  "idempotencyKey": "peer:..."
}
~~~

旧消息没有 schemaVersion 或地址字段时仍然可以由现有 Mailbox 处理。新消息必须通过 createPeerEnvelope；它会复制和验证 JSON payload。

kind 兼容 request、response、handoff、event，也支持更明确的 request、reply、report、event、cancel。taskId/runId/attemptId 仍然是执行真相，不允许由自由文本覆盖。

## 4. 不变量

- correlationId 连接消息、Task、Run、Audit；traceId 在转发链上保持不变；replyTo 指向被回答的消息。
- 新消息从 hop 0 开始，maxHops 默认 4，绝不超过配置上限 8；forwardPeerMessage 在超过上限时拒绝。
- 默认 TTL 为 30 分钟，绝对上限 24 小时；过期消息由现有 Mailbox dead-letter。
- payload 必须是 JSON；单条默认不超过 64 KiB，绝对上限 256 KiB；深度和数组也有上限。
- payload 中的明显 credential-like 字段和常见 token/Bearer/private-key 形态会在进入 Task/Run 前拒绝。它是边界扫描，不替代凭据库或完整 DLP。
- 显式 idempotencyKey 会在创建新 Task/Run 前查询 Mailbox；重复调用返回已有 Envelope，不创建第二个 Task/Run。
- 所有投递仍使用现有 Mailbox 的 lease、fencing token、ack、retry、restart recovery 和 dead-letter。

## 5. 会话路由

默认情况下，Gateway 按现有 requester/chat/task sessionScope 解析目标会话。若消息携带 toAddress.sessionId，Gateway 只接受：

1. 当前请求上下文推导出的 scoped session；或
2. 目标 Bot 的 canonical session。

不满足时消息进入不可投递路径，不会把任意 session id 当作权限凭证。后续跨会话 Bot Mesh 会在这个检查之上增加受控 session registry 和 manager policy。

## 6. 兼容与演进

字段采用向后兼容的 optional 方式；老 JSONL 记录可继续读取。后续 v1.x 只能增加可选字段或新的受限 kind，不能改变 task/run/attempt 的含义。

需要破坏性改变时必须提高 schemaVersion，并同时提供读取旧记录的迁移或拒绝策略。严禁把运行时状态、密钥、完整模型上下文或大体积回放文件提交到 Git；大文件继续放到用户指定的 Google Drive 归档位置。

## 7. 验收

本增量的自动测试覆盖：

- 地址、schemaVersion、trace、hop、TTL 和 payload 大小；
- credential-like payload 拒绝；
- forward hop 限制和 replyTo；
- explicit idempotencyKey 的 Mailbox 去重；
- TTL dead-letter 和重启后的 JSONL 状态恢复。

后续阶段在这个契约上增加任意 @bot 解析、Bot-to-Bot 自主 reply/report、Manager 控制权限、Workflow DAG 和远程 Transport。

## 8. Direct Bot @ routing

直接 Bot 回合输出中的已知 @bot 会被解析为新的结构化 Peer Message。路由会：

- 继承 requester、replyTarget、conversationId、correlationId 和 traceId；
- 创建独立的 Task/Run，并用 parentRunId、replyTo 和 visitedBots 建立父子关系；
- 将 sourceReport 作为不受信报告交给目标 Bot，不允许它覆盖结构化 Task 指令；
- 复用目标 Bot ACL、approvalRequired、Mailbox lease/fencing、TTL 和重试；
- 每一跳增加 hop，超过 maxHops 或命中 visitedBots 时停止；
- Workflow 与 Group Room 不走这条动态路径，避免它们在运行中被自由文本改图。

因此当前增量支持的是“直接任务中的有限 @bot fan-out”。让源 Bot 等待 report、整合结果、按消息类型继续调度，将在后续 A2/A3 中继续完善。