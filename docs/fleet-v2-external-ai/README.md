# Fleet v2 External Product Layer

## Scope

This directory contains the Part B product-layer implementation for the
DeepSeek-Bot Fleet v2 roadmap. It provides serializable definitions, pure
planning policy, safe mention parsing, a presentational panel, tests, and
integration notes.

It does **not** implement Gateway routing, Mailbox delivery, ACL decisions,
Agent sessions, Workflow execution, Manager tool execution, or distributed
transport. Those remain Codex-owned control-plane responsibilities.

基线是 PR #10 head `c3a7c2f5ee6a0a0200efdef76193c2d1e9d0ef7a`。本部分只实现
产品层、定义层、策略层、独立 UI 和测试，不代表完整 Hermes/Grok Fleet 已经
在运行时接入。

## Delivered modules

| Module | Purpose |
| --- | --- |
| `src/fleet-v2-types.ts` | Versioned serializable contracts shared by the product layer |
| `src/workflow-schema.ts` | Workflow schema, migration seam, validator, diagnostics |
| `src/workflow-store.ts` | Idempotent append-only definition/revision store and manifests |
| `src/manager-policy.ts` | Pure candidate selection, budget policy, delegation plan and replan suggestion |
| `src/manager-prompt.ts` | Manager system prompt and tool contract documentation; no runtime integration |
| `src/mention-parser.ts` | Pure `@bot`, `@team`, and `@manager` parser with hop/visited/budget metadata |
| `src/fleet-v2-panel.ts` | Independent React presentational component; snapshots arrive through props |
| `test/workflow-*.test.mjs` | Schema, security, revision, idempotency and JSONL recovery tests |
| `test/manager-policy.test.mjs` | Policy, budget, replan, credential and 500-Bot tests |
| `test/mention-parser.test.mjs` | Syntax, Markdown/URL/code protection, limits and 500-mention tests |

## Security boundary

- Definitions are JSON-serializable only.
- IDs, references, node kinds, budgets, depth, fan-out and graph reachability
  are validated before persistence.
- Cycles, orphan nodes, unknown references, credential-bearing values,
  executable JavaScript/shell text, and undeclared external effects are
  rejected.
- Workflow Store writes are append-only, revisioned, and idempotent. A torn
  final JSONL line is recovered by the existing `JsonlJournal`; that journal is
  not modified here.
- Manager Policy consumes `authorized` as an input fact. It never grants,
  revokes, infers, or changes ACLs.
- Mention Parser returns syntax-level targets only. `routableTargets` is still
  not an authorization decision; Gateway must re-check identity and ACL.

## Runtime status

The modules are independently buildable and testable, but they are not wired
into `src/gateway.ts`, `src/collaboration.ts`, `src/harness-bridge.ts`, or
`src/client.tsx`. The integration adapter and protected-file requests are
documented in `INTEGRATION_REQUEST.md`.

运行时仍然需要 Codex 完成：

- Mention Parser 到 Gateway Router 的接入；
- Manager plan 到 Task/Run/approval 的编译和派发；
- Workflow definition 到真实执行图的编译；
- 跨会话 Peer Messaging、lease/fencing、Agent lifecycle 和分布式调度；
- 最终安全审查、CI 修复和合并。

## Large artifacts

No large fixture, replay, credential, runtime state, or raw pressure log is
stored in Git. If a future benchmark produces large output, save it to the
specified Google Drive location and commit only a small manifest, summary, and
checksum.
