# Fleet v2：动态 Agent Network 实施计划

## 目标

把现有“静态配置的 2–6 Bot Fleet”逐步升级为可在会话中创建 Bot、跨会话协作、由 Manager Agent 管理、可保存 Workflow，并可接入 Hermes/Grok Runtime 的动态 Agent Network。

升级采用渐进方式。每个阶段有独立开关、测试和回退路径；现有飞书连接、配对、allowlist、静态 Bot 和 Fleet v1 始终保持可用。

## 不可破坏的安全边界

1. API Key、App Secret、Token 不进入 Registry、Team State、日志或 Git。
2. 用户聊天中的普通未知 `@bot` 文本不产生路由副作用；只有开启 `peerMessaging` 后，受 Gateway 管理的内部 Bot Run 输出中的已知 `@bot` 才能经过 ACL、审批、hop、visited、TTL、预算和幂等检查创建 Peer Task。
3. Bot 不能修改自己的 ACL、Tool 权限、作用域或审批策略。
4. Bot 修改使用不可变 Revision；正在运行的会话固定到启动时的 Revision。
5. 每次写入使用版本冲突检查，删除使用 tombstone，不复用旧 Bot handle。
6. Team 默认最多 6 Bot、并发 3、嵌套深度 2；Peer Message 有 TTL、hop 和消息总数上限。
7. 所有 Fleet v2 功能默认关闭，可单独回退，不自动迁移生产流量。

## 执行进度

| 阶段 | 交付物 | 状态 |
| --- | --- | --- |
| 0 | PR #9 基线、功能开关、回归门 | 已完成 |
| 1 | 动态 Bot Registry、Team、Agent Thread 数据层 | 已完成 |
| 2 | 会话内创建/编辑/确认 Bot并自动加入 Fleet roster | 已完成 |
| 3 | Bot 跨会话 Peer Messaging | 有界核心路径已完成；通用等待工具待开发 |
| 4 | Manager Agent 与动态任务图 | 确定性控制面已完成；自主 Manager 工具链待开发 |
| 5 | Saved Workflow 与 Fleet Dashboard | Store 与 task-node DAG 已完成；完整节点运行时和编辑器待开发 |
| 6 | Hermes/Grok Runtime Adapter | 未开始 |

## 阶段 0：基线与回退门

完成条件：

- 从 PR #9 独立分支开发，不修改 `main`；
- 记录 `npm run check`、`npm test`、`npm run build:client`、`npm run pack:check` 基线；
- 新增的 6 个开关默认全部为 `false`；
- 保持飞书 App ID/Secret、配对、allowlist 和现有状态目录兼容。

## 阶段 1：动态 Registry 数据层

### 数据结构

- `BotDefinition`：稳定 UUID、handle、owner、scope、状态和当前 Revision；
- `BotRevision`：模型、角色、能力、技能、SOUL、ACL 和会话隔离的不可变快照；
- `TeamDefinition`：成员、Manager、并发上限和作用域；
- `AgentThread`：Team 的持久协作上下文；
- `ArtifactReference`：只保存引用，不复制文件正文或凭据。

### 作用域

- `session`：仅创建它的用户和指定会话可见；
- `user`：同一用户的多个会话可见；
- `workspace`：同一工作区可见；
- `shared`：Gateway 授权范围内共享。

### 持久化

- `${DSH_HOME}/hermes-bot/bot-registry.jsonl`；
- `${DSH_HOME}/hermes-bot/teams.jsonl`；
- 每条事件带 `schemaVersion` 和 UUID；
- 追加式写入、重启回放、重复事件去重、版本冲突拒绝；
- 支持静态 `profiles` 幂等播种，但当前不自动替换静态运行路径。

### 测试

- 作用域隔离；
- Revision 历史和生命周期；
- 并发修改只能成功一次；
- 重启恢复；
- 静态 Profile 幂等迁移；
- API Key/凭据 URL 拒绝写入；
- Team 成员、Manager 和并发边界。

## 阶段 2：会话内创建 Bot

### 用户流程

1. 用户发送“创建一个研究 Bot”或 `/bot create research`；
2. Agent 只调用 `bot_create_draft`，生成草稿，不立即启用；
3. Gateway 返回名称、模型、能力、作用域和权限摘要；
4. 用户发送 `/bot confirm <code>` 或点击本机确认按钮；
5. Registry 激活 Revision，Gateway 验证其进入 owner-scoped Fleet roster，Bot 才能被 `@handle`、Planner、Manager 或 Workflow 使用。

### 命令与 Tool

- `/bot create`、`/bot confirm`、`/bot edit`、`/bot clone`；
- `/bot disable`、`/bot delete`、`/bot list`；
- Tool：`bot_create_draft`、`bot_update_draft`；
- 模型不能填写 owner、ACL、session ID 或批准自己。

### 已落地说明

- 设置页需同时开启 `dynamicRegistry` 与 `chatBotCreation`；两项默认仍为关闭；
- 聊天创建当前固定为 `user` scope，Gateway 从消息上下文写入带平台的 owner principal（例如 `user:feishu:ou_x`），模型不能传入；
- `bot_create_draft` 和 `bot_update_draft` 只处理草稿；每个 Revision 获得新的 8 位确认码，审批绑定 definition version、revision 和内容指纹，旧码不能激活修改后的草稿；
- `/bot edit` 可修改已激活 Bot；修改后建议发送 `/new`，让新 Revision 进入新会话；
- `/bot disable`、`/bot enable`、两步 `/bot delete`、`/bot clone` 和 `/bot list` 已实现；
- 本机控制台可一键确认并激活、停用、重新启用或删除动态 Bot；
- 激活、跨平台 ACL 隔离、重复创建幂等、旧审批重放保护、损坏 JSONL 尾行恢复、生命周期并发栅栏、常见凭据模式拒绝和本机路由均有自动测试。Bot Registry、Team、Thread 和 Artifact 共用同一套凭据扫描；URL 会在最多两次解码后结构化解析，并把 query/fragment 参数名按大小写、下划线、连字符和 camelCase 归一化。provider/model 只接受配置标识，不接受 URL。自由文本使用 best-effort secret scanning（尽力扫描）拦截常见密钥、认证头、凭据 URL 和高风险标签；它不是完整的密钥识别器，使用者仍不得把任何凭据写入 Bot 或 Team 文本字段。

### 完成门

- 自然语言和命令都只创建草稿；
- 未确认草稿不能执行；
- 用户看不到其他用户的 `user/session` Bot；
- 静态 Bot 和动态 Bot 共用单一 handle 命名空间；无论哪一方后加入都拒绝冲突，已删除动态 Bot 的 tombstone 也永久保留 handle；
- 静态设置提交与动态 Bot 创建共用串行 mutation lane；运行时切换或持久提交失败时恢复旧配置、directory 和 runtime metadata；
- 普通停用/删除会拒绝仍在运行或排队的直接 Agent，不把生命周期操作偷偷转换成 force-cancel；直接会话索引可跨插件重载恢复，在无 Transport 时仍可查询 Agent，Agent 服务未知时 fail closed，并在后续检查中清理已解绑且不再忙的旧记录；
- 插件停止先关闭统一的 durable mutation admission，并在首次 await 前取消尚未触发的 Mailbox heartbeat，再排空全部 mutation lease、生命周期/命名空间事务和任务 lane；草稿更新、审批、Task、配对、状态页 reconciliation、Transport 回调、Mailbox heartbeat 与审批定时 reconciliation 使用同一停止栅栏，旧实例停止完成后不能继续覆盖新实例状态；停止完成前还会等待活动 Agent idle、加栅栏并交还本 worker 的活动 Mailbox lease、清理活动 Run 索引，因此同一 Gateway 重启后可安全重新领取任务，并按当前配置重建 Transport；每次重新 dispatch 会绑定下一 DSH turn 与事件 seq 下界，旧 turn 的迟到事件不能完成新 lease；
- 设置/凭据 Provider 的原始错误不进入本机 HTTP 响应，避免错误文本反射 App Secret；
- 飞书文本确认和本机 Web 确认都可恢复、幂等。
- 激活和重新启用后会核验动态 Revision 已安全投影进 Fleet directory，并记录 `bot.fleet_joined` 审计；状态页显示 `joined`、`blocked` 或 `not-joined`。
- 自动加入的是逻辑 Fleet roster，不是所有 Team；Team 成员仍需显式修改，以维持最多 6 Bot 和独立 manager/concurrency 边界。

以上完成门已通过。`session/workspace` 动态运行时投影暂时保持关闭，直到后续阶段能把完整作用域上下文带入每次调用；这避免把同一用户的会话级 Bot 意外扩大到其他会话。

## 阶段 3：跨会话 Peer Messaging

当前已完成：类型化 Envelope、公开 send/request/reply seam、直接 Bot Run 输出中的有界 `@bot` 路由、ACL/审批/TTL/hop/visited/大小限制、幂等 Mailbox 和重启恢复。功能由 `peerMessaging` 在执行入口强制门禁。

尚待完成：面向模型的通用 `bot_ask`、`bot_wait`、聚合等待和跨 Team canonical Thread 路由。

### 结构化 Tool

- `bot_send`：异步发消息；
- `bot_ask`：发出请求并等待回复；
- `bot_reply`：关联 `correlationId/replyTo`；
- `bot_delegate`：创建子任务；
- `bot_wait`：等待一组消息或任务完成。

### Envelope 新字段

- `fromBotId/toBotId`；
- `sourceSessionId/targetSessionId` 由 Gateway 推导；
- `teamId/taskId/threadId/correlationId/replyTo`；
- `artifacts/hopCount/maxHops/expiresAt/fencingToken`。

### 默认限制

- 最多 6 Bot、20 条 Peer Message、6 hops、TTL 30 分钟；
- 目标 Bot 忙碌时进入 Mailbox，在安全回合边界消费；
- 重复消息、过期消息和迟到结果不能产生第二次副作用。

## 阶段 4：Manager Agent

当前已完成：`@manager` 用户入口、纯策略计划、能力与 ACL 候选选择、预算/风险/审批决定、plan revision、类型化 delegation intent，以及 Gateway 到 Task/Run/Mailbox 的有界编译。功能由 `managerAgent` 在执行入口强制门禁。

尚待完成：可观察 Team 状态并执行有限 wait/steer/replan 的自主 Manager 模型工具链。Manager 仍不能创建 manager-role Bot、修改 ACL、读取密钥或自行批准高风险操作。

### Manager Tool

- `team_list`、`team_delegate`、`team_send`、`team_wait`；
- `team_steer`、`team_stop`、`team_spawn_temporary`；
- `team_complete_task`。

### 管理命令

- `/team create`、`/team manager`、`/team add`、`/team remove`；
- `/team run`、`/team status`、`/team pause`、`/team resume`、`/team stop`。

Manager 可以安排任务和催办，但不能改变 ACL、Secret、Tool 权限、审批策略或越过用户确认。高风险动作继续走 Fleet Approval。

## 阶段 5：Saved Workflow 与控制台

当前已完成：版本化 Workflow Definition、验证器、不可变 Revision、幂等 Store、导入/导出、task-node DAG 编译、依赖输出解析、并发/扇出限制、失败收敛、幂等启动和重启恢复。功能由 `savedWorkflows` 在执行入口强制门禁。

尚待完成：condition、map/reduce、approval、compensation 等全部节点的运行时 Adapter，以及 Workflow 创建/编辑/激活界面。

- Workflow Spec：输入、节点、依赖、Artifact、审批和预算；
- 自然语言先生成草稿，经过静态校验和人工确认后保存；
- 控制台增加 Bots、Teams、Live Network、Workflows 四个视图；
- 支持查看、暂停、steer、stop、takeover、重放和 dead-letter；
- 轮询摘要不携带完整 Prompt、模型输出或 Secret。

## 阶段 6：Runtime Adapter

统一接口：

```text
createOrResume
send
steer
stop
inspect
listSessions
```

- DSH Adapter：继续使用当前 `HarnessBridge`，作为默认稳定路径；
- Hermes Adapter：持久 Bot 映射 Profile，短任务使用 delegation，耐久任务映射 Kanban；
- Grok Adapter：映射 Agent/Persona 和 ACP session；
- Peer Messaging、ACL、审批和耐久 Mailbox 仍由本插件掌控，避免依赖不同 Runtime 的私有行为。

## 每阶段统一验证

```powershell
npm run check
npm test
npm run build:client
npm run pack:check
npm run pack:smoke
```

另外进行：

- 同一完整测试至少连续运行 3 次；
- 插件重启恢复；
- 飞书人工创建、确认、`@` 协作、暂停和取消；
- 状态目录检索敏感信息；
- Git diff 检查无 Secret、无本机状态文件。

## 发布顺序

每个阶段使用独立 Draft PR，后一阶段基于前一阶段：

1. Registry/Data；
2. Chat Creation；
3. Peer Messaging；
4. Manager；
5. Workflow/Dashboard；
6. Runtime Adapters。

每个 PR 可单独审查和回退。前 4 个阶段完成后，才算动态 Bot Fleet 的核心 MVP；第 5–6 阶段属于产品化和外部 Runtime 扩展。
