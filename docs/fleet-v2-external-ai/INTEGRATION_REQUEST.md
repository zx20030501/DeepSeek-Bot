# Codex Integration Request

Part B intentionally does not modify the following protected files:

- `src/gateway.ts`
- `src/collaboration.ts`
- `src/durable.ts`
- `src/jsonl.ts`
- `src/harness-bridge.ts`
- `src/types.ts`
- `src/client.tsx`
- `src/index.ts`
- `package.json`, `package-lock.json`
- `.github/workflows/*`

## Requested adapters

### 1. Mention routing

Import `parseFleetMentions` from `src/mention-parser.ts` at the Gateway
boundary. Map `MentionTarget` to the canonical Bot/Team/Manager principal
resolver, then re-run ACL and current-session checks. Do not trust
`routableTargets` as an authorization decision.

Minimum adapter behavior:

```text
Inbound text
  -> parseFleetMentions()
  -> canonical principal/ACL resolution
  -> hop/visited/message budget enforcement
  -> existing Task/Run/Mailbox router
```

### 2. Manager runtime

Call `generateManagerPlan()` with Gateway-owned task identity, trace identity,
authorized Bot snapshots and budget. Persist the resulting plan through the
existing control-plane audit path, request approval when required, and compile
approved `DelegationIntent` values into the existing Task/Run/Mailbox seam.
The Manager must not call `sendBotMessage()` directly from this product layer.

### 3. Workflow compiler

Call `assertValidWorkflow()` or `migrateWorkflowManifest()` before compiling a
definition into Task/Run stages. The compiler owns:

- ACL and approval re-checks;
- Task/Run identity and requester/reply target binding;
- Mailbox TTL, lease, retry, fencing and recovery;
- external-effect authorization;
- worker pool, backpressure and distributed transport.

The validator's graph is a product definition. It is not a runtime execution
graph until the compiler has added those control-plane properties.

### 4. Panel

Use `FleetV2Panel` from a protected client adapter. Do not modify the existing
`client.tsx` in this branch. The adapter should map bounded Gateway snapshots
to `FleetV2PanelProps` and retain detail loading behind the current setup-route
and ACL boundary.

## Why these changes are not directly mergeable into the protected runtime

The Part B modules deliberately introduce no canonical Task/Run, Bot principal,
Mailbox, session, or Gateway contract. Directly wiring them without a control-
plane review could cause duplicate execution, stale approvals, cross-user
context leakage, or an accidental route around ACL. Codex should integrate by
small adapter diffs after reviewing the public contracts and tests.

## 中文集成请求

Part B 已经提供“定义、策略、解析、展示”，但没有越过主干安全边界。Codex
接入时必须重新检查身份、ACL、审批、TTL、lease、fencing、session 和
replyTarget；不能把 Manager plan 或 Mention Parser 的输出直接当成已经授权
的执行命令。
