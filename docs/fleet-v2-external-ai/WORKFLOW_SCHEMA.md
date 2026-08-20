# Workflow Definition and Validator

## Contract

`WorkflowDefinition` uses `schemaVersion: 1`, a stable `id`, an immutable
`revision`, a lifecycle `status`, an owner/scope, nodes, edges, typed inputs
and outputs, and a policy budget.

Supported node kinds:

- `task`;
- `sequential`;
- `parallel`;
- `condition`;
- `map`;
- `reduce`;
- `approval`;
- `retry`;
- `timeout`;
- `compensation`.

References are structured rather than executable strings:

```json
{ "kind": "input", "name": "topic" }
{ "kind": "node-output", "nodeId": "research", "output": "result" }
{ "kind": "constant", "value": "bounded text" }
```

There is no arbitrary expression, JavaScript, shell, URL credential, provider
credential, or opaque executable field in the schema.

## Validation guarantees

`validateWorkflowDraft()` and `validateWorkflow()` return structured
diagnostics. The assertion functions throw `WorkflowValidationError` with the
first error code and the full diagnostic list.

The validator checks:

1. schema version, JSON shape, IDs and field limits;
2. unique node/input/output/edge identities;
3. known nodes, typed references and declared node outputs;
4. explicit edges, dependencies, children, conditions and map templates;
5. graph cycles and entry-node reachability;
6. maximum depth and fan-out;
7. capability, permission, token, message, cost and concurrency budgets;
8. external-effect declarations and default-deny policy;
9. credential-bearing material and executable JavaScript/shell text.

The migration seam is `migrateWorkflowManifest()`. Version 1 is canonical;
future versions should be upgraded there before validation and persistence.

## Error codes

`WORKFLOW_INVALID_SHAPE`, `WORKFLOW_UNSUPPORTED_SCHEMA`, `WORKFLOW_INVALID_ID`,
`WORKFLOW_DUPLICATE_ID`, `WORKFLOW_DUPLICATE_NAME`, `WORKFLOW_UNKNOWN_NODE`,
`WORKFLOW_UNKNOWN_REFERENCE`, `WORKFLOW_CYCLE`, `WORKFLOW_ORPHAN_NODE`,
`WORKFLOW_DEPTH_EXCEEDED`, `WORKFLOW_LIMIT_EXCEEDED`, `WORKFLOW_UNSAFE_INPUT`,
`WORKFLOW_CREDENTIAL_MATERIAL`, `WORKFLOW_EXTERNAL_EFFECT_UNDECLARED`, and
`WORKFLOW_POLICY_VIOLATION` are stable integration-facing diagnostics.

## Store boundary

`WorkflowStore` persists only definitions and immutable revisions. It supports
create, list, get, update, soft delete, validation, export and import. Each
write has an operation key and fingerprint. Reusing a key returns the original
result; reusing it for another operation raises
`WORKFLOW_IDEMPOTENCY_CONFLICT`.

Exported manifests contain a SHA-256 over the canonical Workflow definition.
Import creates a new user-scoped identity rather than silently reviving the
source owner or ID.

## 中文说明

Workflow 是产品层的“定义”，不是执行器。它可以描述串行、并行、条件、
fan-out、reduce、审批、重试、超时和补偿，但不会自行发送消息或调用模型。
Store 只保存版本和 manifest，不保存密钥、Mailbox lease、Task/Run 状态或
运行时锁。真正执行前，Codex 需要把定义编译成受 ACL、审批、TTL、fencing
和配额保护的 Gateway/Task/Run 图。
