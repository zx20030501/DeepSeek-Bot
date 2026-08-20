# Manager Policy and Plan Generation

## Design

`generateManagerPlan()` is a pure product-layer policy function. It consumes:

- task identity and trace identity supplied by the control plane;
- instruction, required capabilities and acceptance criteria;
- Bot capability/status snapshots;
- an explicit budget;
- a Manager Bot identity supplied by the future runtime.

It returns a `ManagerPlan` containing:

- `planId` and `planRevision`;
- `traceId` and `taskId`;
- `policyDecision` (`allow`, `approval-required`, `deny`, or `replan-required`);
- reasons and budget;
- bounded `DelegationIntent` objects;
- an `ApprovalRequirement`.

It never sends a message, calls a model, changes ACL, changes Bot state, reads
credentials, or approves its own work.

## Candidate policy

Candidates must be enabled and authorized according to the snapshot supplied by
Gateway. Manager-role Bots, the Manager itself, unavailable/failed/timed-out/
low-confidence Bots, and Bots over the in-flight limit are excluded. Capability
coverage and instruction terms are scored deterministically; ties are resolved
by Bot ID.

The output is bounded by `maxBots`, `maxParallelRuns`, `maxFanOut`, `maxDepth`,
`maxMessages`, `maxTokens`, `maxCostUnits`, and `maxHops`. Candidate cost per
run is included in the cost guard. The implementation can process hundreds of
logical Bot descriptors as data, but it does not create workers or schedule
runtime work.

## Approval and replan

High-risk tasks and external effects produce an approval requirement. A failed,
unavailable, timed-out, or low-confidence observation is handled by
`generateReplanSuggestion()`, which returns replacement intents and a new plan
revision. The suggestion explicitly tells the control plane that it is only a
suggestion; dispatch and approval remain outside this module.

## Prompt contract

`MANAGER_SYSTEM_PROMPT` and `MANAGER_TOOL_CONTRACT` document the future Manager
runtime. The prompt requires plan-before-execute, identity fencing, bounded
retry/replan, approval for high-risk actions, and evidence-based final output.
It forbids secrets, arbitrary code, invented IDs, ACL changes, self-approval,
and Manager creation through the ordinary dynamic Bot tool.

## 中文说明

Manager Policy 只负责回答“为什么选择哪些 Bot、预算是多少、是否需要审批、
失败后有哪些替代方案”。它不回答“如何实际发送消息”和“如何执行 Run”。
这使策略层可以先独立测试，也避免产品层绕过 Gateway 的身份、ACL、审批、
Mailbox 和 fencing 边界。
