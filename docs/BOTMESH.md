# DeepSeek-Bot BotMesh

BotMesh 是 DeepSeek-Bot 的内部协作控制平面。它借鉴 Hermes Bot Mode 的 roster、Canonical Bot Chat、`@mention` 和 Group Room 体验，但把任务状态、可靠投递和审计放在结构化协议中，而不是依赖 Bot 之间的自由文本转发。

## 目标和边界

当前分层如下：

```text
Telegram / 飞书
       │
       ▼
Inbound WAL + chat lane
       │
       ▼
BotDirectory → Task/Run → Typed Mailbox
       │                         │
       │                         ▼
       │                 DSH Agent Canonical Session
       │                         │
       └────────────── Audit ← session events
                         │
                         ▼
               Group Room / Outbox / 原平台回复
```

- `BotDirectory` 描述可用 Bot、profile、能力、技能、SOUL 和长期 Canonical Session。
- `TaskRunStore` 是任务、运行和 handoff 的持久化真相，并追加审计记录。
- `BotMailbox` 负责结构化消息的入队、租约、ack、重试、dead-letter 和 fencing。
- `GroupRoomStore` 保存有界协作房间的参与者、轮次、epoch 和短 transcript。
- DSH Agent Session 是执行层；BotMesh 不修改 DeepSeek Harness 的 Agent Loop。

BotMesh 目前是本机单进程控制平面。跨机器 transport、自动 planner、routines、审批 UI 和完整 Web roster 会在后续阶段建立在这些接口之上。

## 结构化消息

每个内部请求都是 `BotMessageEnvelope`：

```json
{
  "id": "msg_xxx",
  "kind": "request",
  "from": "user:feishu:ou_xxx",
  "to": "researcher",
  "taskId": "task_xxx",
  "runId": "run_xxx",
  "attemptId": "attempt_xxx",
  "correlationId": "task_xxx",
  "roomId": "room_xxx",
  "epoch": 1,
  "payload": {
    "instruction": "研究 Hermes Bot Mode",
    "acceptanceCriteria": [],
    "replyTarget": { "platform": "feishu", "chatId": "oc_xxx" },
    "transcript": []
  },
  "createdAt": 0
}
```

`taskId` 标识业务任务，`runId` 标识一次执行，`attemptId` 标识该次尝试，`correlationId` 把消息、审计和回复串起来。`epoch` 是 Group Room 的代际标记；房间关闭或代际不一致时，迟到结果会被记录为 stale，不再发给用户或继续驱动下一轮。

已知的 Bot ID 才会被 `@mention` 路由。未知的 `@name` 保留在原始任务文本中，避免把平台用户 mention 误判为内部 Bot。

## Mailbox 状态机

```text
queued → claimed → acknowledged → running → completed
                           │           └── failed → queued
                           └──────────────────────→ dead-letter
```

每次 claim 都生成 lease ID 和递增 fencing token。worker 重启、租约过期或旧 worker 晚到时，旧 token 不能再改变当前消息状态。失败消息按退避重试，超过 `mailboxMaxAttempts` 后进入 `dead-letter`，不会无限循环。

Mailbox 使用 JSONL append-only journal，启动时重放最后状态。它与外部消息的 Inbound WAL 分开：Inbound WAL 保证平台消息不丢，Mailbox 保证 Bot 协作消息可恢复。

## Task、Run 和 Group Room

一个 `@bot` 请求创建一个 Task、一个初始 Run 和一条 Mailbox 消息。Bot 运行结束后：

1. 成功结果写入 Run、Task 和 Audit；
2. 结果通过 Outbox 发回原聊天；
3. 多 Bot 请求追加到 Group Room transcript；
4. Room 仍未达到限制时，按参与者顺序创建下一个 Run；
5. 达到限制、失败或出现 stale epoch 时停止继续派发。

默认限制来自 Hermes Bot Mode 的有界协作原则：最多 6 个 Bot、3 轮、10 条房间消息。配置可以收紧限制，但实现会将它们限制在安全上界内。每个 Bot 使用稳定的 Canonical Session，不会为每一条内部消息创建新的长期会话。

当前 Group Room 是串行协作：同一时间一个 Bot 占用一个 Bot lane。这样可以保留可预测的 transcript 顺序，也避免一个 Bot 的旧结果覆盖后续轮次。

## 配置和状态

Bot 能力在 profile 中声明：

```yaml
profiles:
  research:
    title: Research Bot
    capabilities: [research, source-review]
    skills: [web-research]
    soul: "先给证据，再给结论。"
collaboration:
  enabled: true
  maxGroupBots: 6
  maxGroupTurns: 3
  maxGroupMessages: 10
  mailboxMaxAttempts: 3
  mailboxLeaseMs: 120000
```

默认运行状态目录为 `${DSH_HOME:-~/.dsh}/hermes-bot/`，新增：

```text
mailbox.jsonl  # BotMessageEnvelope 和 Mailbox 状态
tasks.jsonl    # Task、Run、Handoff、Audit
rooms.json     # Group Room 元数据和短 transcript
```

这些文件可能包含用户任务和模型输出，只保存在运行机，不提交 Git。大体积回放、压测日志和调研归档放 Google Drive；仓库只保留小型测试和协议文档。

## 使用示例

```text
@research 请比较 Hermes Bot Mode 与当前项目，并列出有源码依据的差异
```

```text
@research @writer 先研究，再把结果整理成实施方案
```

可以使用 `/bots` 查看 roster，使用 `/mesh` 查看 Mailbox、Task、Run、Handoff 和正在执行的 Bot 数量。平台 allowlist、配对和原有 Inbound WAL 仍然先于 BotMesh 生效；未获授权的消息不会创建协作任务。

## 后续扩展顺序

1. 增加显式 Planner：根据能力和 acceptance criteria 生成 Task DAG，而不是只按 mention 顺序分派；
2. 将 `HandoffRecord` 接入结构化 handoff API，并增加审批/拒绝策略；
3. 增加 Routine → Run → Task 入口，避免 cron 直接执行自由文本；
4. 抽象远程 transport，支持跨 gateway、跨机器和连接恢复；
5. 为 Web UI 增加 roster、room transcript、run 状态和审计查询；
6. 在 CI 中加入协议兼容、恢复、并发创建和跨进程 transport 测试。

