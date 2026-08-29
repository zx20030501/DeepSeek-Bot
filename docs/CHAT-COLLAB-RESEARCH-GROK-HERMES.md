# 群聊协作调研：Grok Bot × Hermes Bot Mode × DeepSeek-Bot

日期：2026-08-28
目的：把「像即时通讯群聊一样、用自然语言 @ 人分配任务、负责人在群里编排、过程可观察」做成可落地的产品设计，而不是再做一个隐藏的轮询调度器。
范围：只依据 xAI 公开文档 / 产品说明 与 Hermes 官方 Bot Mode 文档 + 公开 GitHub issue。不猜测未公开的 Grok 内部调度源码。
对照代码：本仓库 src/collaboration.ts Group Room、src/gateway.ts Team/Room dispatch、src/client.tsx 右栏群组 Tab。

## 1. 结论先行

你要的不是「多 Bot 各跑一遍再把结果贴回 Owner 会话」。那是我们现在的 Group Room。你要的是 即时通讯意义上的群：

- 点群 → 中间栏就是这个群的共享时间线。
- 人用 @负责人 或 @everyone 布置任务。
- 负责人（只是一个有角色的 Bot，不是新原语）在同一条群时间线里用自然语言 @其他人 再分配。
- 成员按各自交付节点回群：进展、质疑、交叉验证、卡住时 @user。
- 人在群里看过程，而不是去翻每个 Bot 的私聊。

Grok Bot 和 Hermes Bot Mode 都把群聊做成一等会话，再用 @ 当路由，而不是用 /fleet 或隐藏 DAG 代替聊天。两者机制不同：

| 维度 | Grok Bot | Hermes Bot Mode | DeepSeek-Bot 现状 |
|------|----------|-----------------|-------------------|
| 群是不是一等会话 | 是：New → 选 2–6 Bot → 打开群 | 是：roster 里独立群行，点开房间 | 否：右栏列表 + 对话框发任务 |
| 中栏看到什么 | 共享群 transcript，handoff 可见 | 共享房间；每人另有 Group: 工作会话 | Owner 会话绿条 @bot：… |
| 谁先说话 | 不 @ 则成员自己决定；@ 则指定 | 不 @ = 全员一轮；@ = 只点名者 | 强制全员轮流，不能 pass |
| Bot 再 @ 队友 | 可在群里发、也可异步私聊唤醒 | @name 拉进下一轮；私聊另走 message_agent | 几乎没有：Room 内动态改图被关掉 |
| 总负责人 | 产品上就是普通 Bot + 职责描述 | 普通 Bot；@user 升级给人 | fleetRole / Team.manager 存在，没有群内 NL 编排 |
| 防炸群 | 文档强调「每阶段一个 owner」 | 硬顶：每条用户消息最多 3 轮、10 条；一轮全 pass 则 settle | 3 轮 × N 人、10 条后 关房 |
| 共享工作面 | 账号级一台云电脑（文件/登录共用） | 每人在自己机器的 Group: session 干活 | 每人 hermes-bot-*；无共享群会话 |

对本项目的建议： UX 对齐 Grok（群就是聊天软件），调度对齐 Hermes 的「房间驱动器 + 每成员独立工作会话 + pass/settle/@ 拉人」，再把我们已有的 Mailbox / Task / Handoff 接到这条可见时间线上。不要复制 Grok 的「全账号共用云电脑」当安全边界，也不要复制 Hermes 把 (pass) 当正文扫描的协议坑。

## 2. 你要移植的「人类组织」到底是什么

这不是工作流画布，是组织在聊天软件里的显化：

```
你 ──@总负责──► 群时间线
                    │
                    ├── 总负责 @研究员：今晚把来源钉死
                    ├── 总负责 @写手：等来源后再起草
                    ├── 研究员 回群：来源表已贴，请 @写手 接手
                    ├── 写手 回群：草稿在仓库，请 @审查 只找阻断项
                    ├── 审查 回群：第 3 节和来源冲突，@研究员 复核
                    └── 卡住时 @user：要不要对外发布
```

三个产品要求：

1. 过程可观察：handoff、质疑、验证都落在同一条群时间线。
2. 组织结构可设定：Team 成员、谁是负责人、谁是 specialist，是 roster 属性，不是每次 /fleet 临时匹配。
3. 编排用自然语言：负责人用 @名 + 一句话 分配，而不是人去点「给 Team 发任务」再等系统轮询。

Grok 把这叫 you are not the middleman。Hermes 把这叫 group row is a shared room; bots pull each other in with @name。

## 3. Grok Bot：公开机制（不是内部源码）

来源：

- Grok Bot overview（2026-08-11）
- Message and collaborate（2026-08-11）
- Introducing Grok Bot

产品说明：没有单独的 manager Bot 类型；Chief of Staff 是写进职责描述的普通 Bot。

### 3.1 产品合同（可观察行为）

- 群是聊天对象，不是任务对象。 New chat 勾选 2–6 个 Bot → 打开群 → 可改名 → 以后还能改成员。用法是「几个 Bot 需要同一份可见结果和可见交接」。
- 寻址四种： 普通说话（让在场 Bot 自己决定谁回）、@一个、@多个、少用的 @everyone。
- Bot 可以在群里发消息，并在彼此之间传递工作。 推荐开场就是一段同时 @ 三人的自然语言分工。
- 异步私聊 handoff： Bot 可给另一个 Bot 发异步消息；对方醒来处理，稍后回复；你能在对话里看到这次交接。适用：系统归属不同、需要专家审稿、阻塞属于另一个角色、长任务不需要你每步转发。
- 每阶段一个 owner。 并行 handoff 太多会重复劳动和刷屏。
- 线程和表情。 对单条结果/审批用 thread；表情只是轻量确认，不能当安全决策。
- 群内 Bot 交接目前文本优先。 图片应私发给必须看图的那个 Bot。

### 3.2 实现层面能合理推断、但不能当源码的部分

xAI 没有公开群调度器。从合同只能推断到这一层：

```
人类消息（可带 @ 元数据）
        │
        ▼
  群会话投影（所有人看见的时间线）
        │
        ├── 被 @ 的 Bot 各自醒来（可并行）
        ├── 未 @ 时由模型/策略决定谁开口
        └── Bot 再发：
              ├─ 回群（可见编排）
              └─ 异步 DM（可见 handoff 卡片）
```

工作真正发生在 Bot 自己的电脑屏幕 上；群是协调面。全账号共用一台云电脑，所以文件和登录能交接，但文档明确：不要把「不同 Bot」当成安全隔离。

### 3.3 对我们有用的 / 不要照搬的

要学：

- 点群 = 打开群，不是打开对话框。
- @ 自动完成：Bot / 群 / Routine / 连接器。
- Chief of Staff 是组织角色，不是新实体。
- 交接必须出现在人正在看的 transcript 里。
- 人的新消息可以改正在进行的工作；「立刻停止」是一等指令。

不要搬：

- 账号级共享 VM 当默认工作面（和 DSH「一 Bot 一 canonical session、按 requester 隔离」冲突，也和安全目标冲突）。
- 未公开的「谁该回这条消息」模型。第一版用 显式 @ + 可选全员一轮，不要做黑盒选人。

## 4. Hermes Bot Mode：公开机制（文档 + 实现痕迹）

来源：

- Bot Mode
- Sessions

公开缺陷：#94478（@ 了但房间已 settle）、#91397（路由 token 留在正文导致二次路由）、#96575（多 @ 取消粒度）、#96239（(pass) / (empty) 哨兵）

### 4.1 两个完全不同的通道

Hermes 把「群里说话」和「私聊交接」拆开，这是最值得抄的结构。

**A. 群房间驱动器（Group driver）**

- 群在 roster 里是独立一行（人数、最后一条、needs-you）。
- 点开 = 共享房间。你的一条消息触发 最多 3 个串行轮次。
- @ 了谁，谁就回；谁都没 @，全员都有一轮。
- 每个 Bot 自己决定说还是 pass。一整轮全沉默 → 房间 settle。
- Bot 用 @name 把队友拉进下一轮；用 @user 把判断升级给你（群行 needs-you）。
- 硬顶：每条用户发送 10 条消息、3 轮，防止自旋。
- 每个成员有自己的持久 Group: … session。 房间是共享投影；干活、工具、记忆仍在成员自己的会话里。跨机器时，回合跑在 Bot 所在机器上。

**B. 私聊 message_agent（只在 canonical Bot Chat）**

- 工具：message_agent(target="researcher", message="…")。
- 校验 roster，自动加 Message from … 归属，送到对方 永远聊天。
- 即发即忘： 发送方先收到 ack 并结束回合，回复稍后作为后台完成通知回来。
- 群房间成员 session 和普通 CLI session 没有这个工具。 群里的 @ 是驱动器解析的，不是再调一次 message_agent。
- 你的原文不会被原样转发；被 @ 的 Bot 自己组织要说的话。

### 4.2 从 issue 能看到的实现细节（可当反面教材）

| 现象 | 机制含义 | 我们应怎么做 |
|------|----------|--------------|
| @队友 发生在 round/message cap 附近，房间仍标 settle，被点名者永不跑 | mention 被设计成 加入下一轮；下一轮若不存在，handoff 静默丢失 | cap 命中时房间应停在 unresolved handoff，提供「继续一轮」，不要标完成 |
| 抽取「最后一条 assistant」时若末尾是 (pass)，真回复被当成沉默 | 协议哨兵和自然语言混在同一条正文 | 结构化 pass（字段 / 事件），不要扫描正文 |
| 远程投递把 @name 留在 body 里，接收方当成新的 bot-to-bot 指令再路由 | 路由 token 与可见文本未分开 | @ 解析后写入 元数据；投递给成员 session 的 body 去掉已解析 mention |
| 一条用户消息拆成多条 gc_execution_queue；取消要求全部仍是 queued | 多 @ = 多队列行 | 取消按 行，不要按整条用户消息一票否决 |

### 4.3 平台群聊（Telegram/Discord）不要和 Bot Mode 群搞混

Hermes 网关里的「群」是 人类平台群，默认 group_sessions_per_user: true（同频道里 Alice/Bob 各有一份 transcript）。那是隔离人类用户。Bot Mode 的 Group Chat 是 Bot 之间的共享房间。产品上要的是后者。

## 5. DeepSeek-Bot 现在实际在干什么

后台 有 协作，但 不是聊天软件。

```
右栏「发任务」
    → handleTeamMention / handleCollaborationRequest
    → 成员 ≥ 2 则 rooms.open()
    → 全员 round-robin：reserveNext → 每人 hermes-bot-* 跑一轮
    → 结果 sendText 到 LOCAL_WEB_TARGET
    → deliverLocalWebNotice 追加进 Owner 会话（plugin notice）
    → 轮次或 10 条用尽 → rooms.close()
```

和目标体验的差距：

| 目标 | 现状 |
|------|------|
| 点群打开中栏群会话 | 只有「继续协作」对话框；没有 hermes-group-* 可 sessions.open |
| 群时间线多人头 | notice 全部像 Owner 会话里的系统条 |
| 负责人在群里 @ 人 | Group Room 不允许动态改图；bot_fleet_handoff 不进 Room |
| 成员可 pass | reserveNext 按座位表强制下一位 |
| 群是长期房间 | 任务级房间，跑完即 closed |
| 组织显化 | Team 是通讯录；Planner 是确定性标签匹配，不是群内 NL 编排 |

已有、应该 接上群时间线而不是重写 的资产：

- GroupRoomStore：epoch、transcript、人数上限 2–6
- Mailbox + lease/fencing
- requestHandoff / bot_fleet_handoff（现在被挡在 Room 外）
- Team + managerBotId
- fleetRole: worker / verifier / synthesizer
- 右栏群组列表（缺的是 open，不是列表）

## 6. 推荐架构（本仓库、不 fork DSH）

原则：群是投影，工作仍在 Bot 自己的 canonical session。 这是 Hermes 已验证的拆法，也兼容 DSH「中栏一个 session、一 Bot 一 hermes-bot-*」。

```
┌──────────────────────────────────────────────────────────┐
│ 中栏：hermes-group-<roomId>  共享时间线（人 + 各 Bot 气泡）│
│ 输入：自然语言 + @ 自动完成（Bot / @everyone / @user）     │
└────────────────────────────┬─────────────────────────────┘
                             │ 解析后的 mentions[] 进元数据
                             ▼
                    Room Driver（新）
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
  被 @ 的 Bot          未 @ 且策略=全员        pass / settle
  入队下一回合         入队全员一轮            不唤醒
        │
        ▼
  Mailbox → hermes-bot-<handle>（干活、工具、代码）
        │
        ▼
  结果 append 回群时间线（归属 = 该 Bot）
  若正文/工具提出 @其他人 → 元数据 mentions[] → 再入队
  若 @user → needs-you，停下来等人
```

### 6.1 三层对象（把人类组织写进数据）

| 对象 | 像什么 | 本仓库对应 |
|------|--------|------------|
| Bot | 人：身份、职责、私聊 | registry + hermes-bot-* |
| Team | 部门/项目组：稳定成员 + 可选负责人 | 已有 teams；补 managerBotId 的 UI 与默认 @ |
| Room | 这个组正在用的群聊窗口 | 今天的 room_* 应 长期存在，不要任务结束就 close；任务是房间里的一段 thread |

Chief of Staff = fleetRole 或 Team.managerBotId 指向的那个 Bot。没有第三种实体。

### 6.2 房间驱动器（学 Hermes，修它的坑）

对 每一条人类或 Bot 发进群的消息：

1. 解析 @handle / @everyone / @user → mentions: string[]，从投递给 worker 的正文里剥掉路由 token。
2. 唤醒集合：有 @ 则只唤醒被点名 Bot；无 @ 则唤醒全员（或仅 manager，见 6.4）。
3. 每人一轮：模型输出 speak 或结构化 pass。
4. 输出里的新 @ → 排进下一轮，不立刻无限递归。
5. 一轮全 pass → settle。
6. 仍有未消费 mention 但已触顶 → 状态 = blocked-handoff，UI 出「再开一轮」，禁止标完成。
7. 默认顶：3 轮 / 10 条气泡（与 Hermes、我们现配置同量级）；可按房间改。

### 6.3 两条发言通道

| 通道 | 用途 | 群里怎么显示 |
|------|------|--------------|
| 回群 | 分工、进展、质疑、交叉验证 | 普通气泡，发送者 = Bot |
| 异步 DM | 长活、看图、私密材料 | 群里一条「handoff 卡片」：@a → @b，点开进对方 1:1 |

DM 复用已有 bot_fleet_handoff + Mailbox，但 必须在群时间线留痕。没有卡片 = 人看不见过程 = 失败。

### 6.4 两种开场（都要支持）

**A. 人直接 @ 若干专家（Grok 文档里的 kickoff）**

```
@researcher 钉来源  @writer 等来源后起草  @reviewer 只找阻断项
```

驱动器并行或按提及顺序入队；群里每人都有气泡。

**B. 人只 @ 总负责（你说的组织形态）**

```
@lead 这次发布你来拆；专家都在群里，你自己 @ 他们。
```

只唤醒 lead。lead 的工作会话里能看见群成员名册（Hermes 把 teammate roster 写进 Bot Chat 系统提示）。lead 回群 再 @ 他人，而不是人去点「发任务」。

无 @ 的默认策略建议：只唤醒 manager（若有），否则全员一轮。比「每次无 @ 就 6 个模型全跑」更像真群，也更省。

### 6.5 DSH 中栏怎么做（最大工程风险）

约束：不 fork Harness；中栏尽量仍是 DSH session。

推荐路径（分两步）：

1. 先做可读的群时间线： 打开/创建 hermes-group-<roomId>，用已有 deliverLocalWebNotice 的同类能力按 Bot 归属写入（前缀或 source 元数据）。右栏点群 = sessions.open，发任务后切到该 session。人立刻看到「这是一个群」。
2. 再做人头： 探测 DSH conversation 是否暴露 author/avatar；能接就接。接不上则在 shell.overlay 仅当 current session 是 hermes-group-* 时叠一层气泡列表（通讯录仍是右栏，聊天面在中栏）。不要做成第二套全屏 App。

Composer：@ 自动完成成员；发送走 fleet_room_dispatch（已有）但带 roomId + mentions[]，不要再灌斜杠命令。

### 6.6 明确不做

- 不把 Group Room 当固定 execute→verify→synthesize DAG 的替代品；DAG 留给「自动规划」。群聊是 组织沟通面。
- 不让 worker session 安装 bot_create_draft。
- 不 archiveSession、不读 ctx.workspaces。
- 不把 @token 留在成员 session 的用户正文里。
- 不用共享云电脑模拟交接；交接传 群 transcript + 仓库路径 + 可选 DM。

## 7. 和现有 Fleet 能力怎么分工

| 场景 | 走哪条 |
|------|--------|
| 一次性「研究→验证→汇总」、人要看计划再批准 | 现有 fleet_plan / Workflow |
| 一个稳定小组日常协作、过程要像群聊 | 新：长期 Room + 驱动器 |
| 点对点深聊、改代码 | 现有 1:1 hermes-bot-* |
| 定时 | 现有 Routine；结果应能 帖回指定群（尚未做） |
| 审批 / 对外动作 | 现有 approvals；群里 @user + needs-you |

群聊 不取代 Planner。Planner 是确定性路由；群是人类组织的可见运行时。

## 8. 建议落地顺序

1. 点群打开中栏 hermes-group-*，发任务/继续协作后切过去；把现有 transcript 与后续 @bot： 灌进这个 session，不再只灌 Owner。
2. Room 改为长期房间；任务是房间内 thread，跑完不 close。
3. 驱动器 v1： 解析 @、只唤醒被点名者、结构化 pass、settle、cap 时 blocked-handoff。
4. 允许 Room 内 Handoff / 回群 @，并在时间线画 handoff 卡片。
5. Team.managerBotId 接到「只 @ 负责人」默认策略。
6. 多人头 / composer @ 选人（DSH 能力不够就 overlay）。
7. Routine 帖回群。

第 1 步就能让产品「看起来像群」；第 3–4 步才是「他们会在群里互相 @」。不要颠倒。

## 9. 验证标准（以后做完用来打勾）

1. 点「群聊 · @a、@b」中栏打开该房间，而不是 Owner 会话。
2. 人只 @lead，只有 lead 先说话。
3. lead 回群 @researcher 请… 后，researcher 在同一时间线出现气泡。
4. researcher 完成后 @reviewer，审查意见也在同一时间线。
5. 某 Bot 选择 pass，不产生假气泡。
6. @user 时右栏 needs-you，房间不标完成。
7. 触顶后仍有未消费 @，UI 为「未完成交接」+「再开一轮」。
8. 1:1 Bot 会话未被群消息污染；worker 仍无 owner 工具。
9. npm test 覆盖：mention 元数据剥离、pass、cap+未消费 mention、epoch fence。

## 10. 参考链接

| 材料 | 用途 |
|------|------|
| https://docs.x.ai/grok-bot/overview | Grok 产品定义、共享电脑、并行 Bot |
| https://docs.x.ai/grok-bot/chat-and-collaboration | 建群、@、handoff、线程 |
| https://x.ai/news/introducing-grok-bot | Chief of staff 组织形态（产品叙事） |
| https://hermes-agent.nousresearch.com/docs/user-guide/bot-mode | 房间驱动器、Group: session、message_agent |
| https://github.com/NousResearch/hermes-agent/issues/94478 | mention 被 settle 吞掉 |
| https://github.com/NousResearch/hermes-agent/issues/91397 | 路由 token 二次路由 |
| FLEET.md / BOTMESH.md | 本仓库现有 Room/Workflow 合同 |
| HANDOFF-DSH-WEB-FLEET-UI.md | Web UI 现状与禁止项 |

文档版本： 1.0
下一步： 若认可第 6–8 节，从「点群打开 hermes-group-*」开工，而不是先做 overlay 人头。
