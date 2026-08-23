# Hermes/Grok 风格 Bot Fleet

DeepSeek-Bot Fleet 是运行在单个 DeepSeek Harness 实例内的多 Bot 控制平面。它组合了两类公开设计：

- Hermes Agent 的身份配对、按使用者隔离的消息会话、SOUL/技能和独立子代理思路；
- Grok Build 公开的 plan/review/approve、并行 subagents、Workflow 分阶段执行和统一 Agent Dashboard 思路。

参考资料：

- Hermes Sessions：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md>
- Hermes Delegation：<https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/delegation.md>
- xAI Workflows in Grok Build：<https://x.ai/news/workflows>
- xAI Agent Dashboard：<https://x.ai/news/agent-dashboard>

“Grok 风格”表示交互和控制原则相似，不表示复制 xAI 未公开的内部架构。当前实现支持单机动态逻辑 roster；单次 Team、Group Room、Planner fan-out 和同时运行的 Agent 继续受最多 6 Bot 等配置边界约束。

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

## 在聊天中创建并自动加入 Fleet

先在本机设置页同时开启“动态 Bot 注册表”和“允许在对话中创建 Bot”，保存后发送：

```text
/new
/bot create analyst 数据分析师
/bot edit analyst capabilities analysis,research
/bot confirm ABCD2345
```

创建和修改只产生用户私有草稿。用户确认绑定到确切 definition version、revision 和内容指纹的八位码后，Registry 才会激活该 Revision；Gateway 随即验证它是否已经安全投影到当前用户的 Fleet roster。成功回复会明确显示“已自动加入 Fleet”。

加入 roster 后，动态 Bot 与静态 Bot 共用同一条授权和执行链：

- `@analyst <任务>` 直接创建 Task/Run；
- `/fleet <任务>` 可以按 capability 选择它；
- 开启 `managerAgent` 后，`@manager <任务>` 可以在预算内委派给它；
- 开启 `peerMessaging` 后，另一个 Bot 的已授权 `@analyst` 输出可以创建有界 Peer Task；
- 开启 `savedWorkflows` 后，Workflow task 节点可以按 capability 选择它。

自动加入的是所有者私有的逻辑 Fleet roster，不是所有 Team。Team 最多六名成员且有独立 manager、revision 和并发约束，仍需显式加入，避免创建 Bot 时偷偷扩大 Team 权限。

相关功能全部默认关闭。`peerMessaging`、`managerAgent` 和 `savedWorkflows` 不仅是配置字段，Gateway 的实际执行入口也会检查开关。本机设置页可以显式开启当前已经接通的能力；未实现的 `externalRuntimes` 不开放。

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

每次 Mailbox claim 都有 lease ID 和递增 fencing token。长模型回合会续租；租约过期以后，旧 worker 即使迟到也不能提交结果。每次内部 Agent dispatch 还会绑定具体 DSH turn 和事件序号下界；同一 session 重启复用时，旧 turn 的文本、正常结束或取消结束只记为 stale audit，不能完成新 lease。插件正常停止时会先等待 Agent 进入 idle，再加栅栏并交还本 worker 的活动租约、清理内存中的 Run 占用；所以同一 Gateway 重新启动也能立即重新领取，而不会等自己的旧租约超时。单机进程异常重启则立即回收上一 worker ID 的租约；其他延迟任务再按最早的 `nextAttemptAt`、`leaseExpiresAt` 或消息 TTL 精确唤醒，不依赖固定轮询。

模型调用失败时，旧 Run 终止并创建一个新的 Run/attempt；这与简单地把同一个失败 Run 放回队列不同，第二次会真正再次调用模型。超过上限后进入 dead-letter，并在 Fleet 控制台显示原因。

如果进程恰好在 Mailbox 已确认结果、但 Run 输出尚未写入的狭窄窗口退出，重启恢复会识别这个不完整提交并创建新的 Run，而不会让 Task 永久停在 `running`。Workflow 的并发输出更新按工作流串行写入，避免多个 worker 同时结束时互相覆盖。

结构化 Handoff 获批后会先推进源 Run 的 fencing token 并取消源投递，再创建目标 Run；`accepted` Handoff 和已经持久化的审批决定都会在重启后幂等恢复。恢复轮询不会重复创建目标 Run，也不会把已经运行的目标任务重置回等待状态。低层 `sendBotMessage()` 会执行 Bot ACL，并拒绝绕过 `approvalRequired` 或全局 `always` 审批策略。

BotMesh 内部 Bot Session 还会获得受限 DSH Tool `bot_fleet_handoff`。模型只能填写目标 Bot、理由和是否主动要求审批；Task ID、Run ID、请求者和回复目标都由 Gateway 从当前执行上下文推导，不能由模型伪造。工具会结束源 Bot 当前回合，直接任务可以转交；固定 Workflow 和 Group Room 暂不允许在运行中动态改图。

## 状态与命令

- `/bots`：可用 roster；
- `/bot create <id> [名称]`：创建当前用户私有草稿；
- `/bot confirm <code>`：确认并激活草稿；
- `/bot list`、`/bot status`、`/bot edit`、`/bot clone`、`/bot disable`、`/bot enable`、`/bot delete`：管理动态 Bot；`/bot status` 会返回 Fleet membership、当前 Revision、忙碌 Run 和最近失败原因；
- `/teams`、`/team create`、`/team add`、`/team remove`、`/team manager`、`/team status`：显式维护 Team 成员；自动加入 Fleet 不会自动加入任何 Team；
- `/fleet <任务>`：自动工作流；
- `/tasks`：最近 Task；
- `/task <id>`：按需查看自己 Task 的完整详情、Run、Handoff 和 Workflow；
- `/cancel <id>`：取消自己仍在执行的 Task，并 fence 相关投递和迟到结果；
- `/replay <id>`：以新的 Task/Run/Workflow ID 重放自己的历史 Task；
- `/approvals`：待审批；
- `/approve`、`/reject`：处理审批；
- `/mesh`：Mailbox、Task、Run、Handoff、Workflow 和运行数量。

本机控制台显示 Bot、动态 Bot Registry、活动 Run、Workflow、Task、审批和 dead-letter；动态 Registry 支持按已加入、受阻、忙碌、草稿、停用和删除状态筛选。动态 Bot 草稿可一键确认激活，已激活 Bot 可停用、重新启用或删除。普通停用/删除不会强制取消工作：只要该 Bot 仍有未结束 Task、Mailbox、Workflow、Handoff、Room，或直接聊天 Agent 正在运行/排队，操作就会被拒绝；Fleet Task 应先等待或用 `/cancel <任务ID>`，直接聊天回合应在对应会话发送 `/stop`。动态 Bot 的直接会话索引会保存在 `state.json`，所以插件重载后仍能保护已切走但尚未结束的回合，即使当前未启用消息 Transport；如果 Agent 服务暂时不可用，系统会保守拒绝停用/删除，而不会把未知状态当作空闲。已解绑且不再忙的旧索引会在下一次相关生命周期检查时自动清理。插件停止会先关闭所有新的持久化变更入口并取消尚未触发的 Mailbox 心跳，再排空已进入的心跳和其他统一 mutation lease、生命周期/命名空间事务及各任务 lane；完成后旧实例不再写入 Registry、审批、Task、Mailbox、配对或设置。同一 Gateway 再次启动时会按当前配置重建 Transport。Task 行可按需展开详情、取消或重放；取消和删除前会二次确认。常规 2 秒状态刷新只携带短标题和状态，不携带完整指令、结果、SOUL 或模型输出；只有点击任务详情时才读取完整内容。重放会创建全新身份并重新检查当前 ACL；聊天发起的重放继续遵守审批策略，本机管理员的明确点击本身视为人工批准，不会复活旧 Run。本机控制台是受信管理员入口；聊天命令只允许原请求者操作自己的 Task 和动态 Bot。持久化文件位于：

```text
${DSH_HOME:-~/.dsh}/hermes-bot/
├── mailbox.jsonl
├── tasks.jsonl
├── workflows.jsonl
├── rooms.json
├── approvals.json
├── bot-registry.jsonl
└── teams.jsonl
```

这些文件包含任务或模型结果，只应保存在运行机。

## 当前真实边界

已实现的是单机受控 Fleet：可靠 Mailbox、Task/Run、审批、Handoff、Peer Messaging v1、确定性 Manager 控制面、版本化 Workflow Store、task-node DAG 继续执行，以及可在会话中创建/修改/确认并自动加入用户私有 roster 的动态 Bot。单个计划、Team、Group Room 和同时运行 Agent 仍受最多 6 Bot 等配置上限约束。

普通 Hermes Agent 只会获得 `bot_create_draft` 和 `bot_update_draft`；owner、带平台的 ACL principal、scope 和 session identity 全部由 Gateway 推导。模型不能激活自己，用户必须发送 `/bot confirm <code>` 或在本机控制台明确批准。确认码只绑定当时的 definition version、revision 和内容指纹；草稿一经修改，旧码立即失效。确认成功后，Gateway 会核验动态 Revision 已进入正确的运行目录，状态页显示 `joined`、`blocked` 或 `not-joined`。

Peer Messaging 目前接通的是有界、已授权的直接 Bot 输出 `@bot` 和类型化消息入口；Manager 是结构化确定性策略与 Gateway 调度控制面，不是可以任意修改 ACL 或自动扩权的自主模型管理员；Saved Workflow 已支持不可变 Revision、验证、存储和 task-node DAG，但不是任意脚本执行器。所有能力分别受默认关闭的 feature flag、ACL、审批、TTL、hop、预算、幂等和 fencing 约束。

尚未实现：

- Grok Build 式数百个模型会话弹性 fan-out；当前只验证了 500 个逻辑 Bot 的 roster 数据路径；
- condition、map/reduce、approval、compensation 等全部 Workflow 节点的真实运行时适配；
- 通用 DAG 编辑器、聊天 Workflow 管理命令和运行中动态阶段；
- `@team` 到 canonical Team/Thread Router 的完整接入；
- 跨机器 Fleet Transport 与分布式一致性；
- Routine/cron 触发器；
- Workflow 或 Group Room 运行中的任意动态 Handoff/DAG 改图；
- 完整 transcript/audit 搜索和通用 DAG 编辑界面。

这些边界不影响当前本机动态 roster 与有界 2–6 Bot 执行，但不能把本项目描述成 xAI Grok Build 的完整复制品。详细上线、回滚和长期演进计划见 [DYNAMIC_BOT_FLEET_V1.md](DYNAMIC_BOT_FLEET_V1.md)。
