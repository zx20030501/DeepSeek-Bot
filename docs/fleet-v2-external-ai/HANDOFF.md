# Part B Handoff

## Baseline and branch

- Base repository: `zx20030501/DeepSeek-Bot`;
- Base branch: `origin/codex/dynamic-bot-registry-v2`;
- Base commit: `c3a7c2f5ee6a0a0200efdef76193c2d1e9d0ef7a`;
- Working branch: `agent/fleet-product-layer-external-ai`;
- Local Part B development commits: `1568b85`, `6a6ae07`, `b73637b`,
  `b706aac`, `8273315`, `d19a6c0`, `4cbcd09`;
- Handoff tip: `4cbcd09`.
- GitHub Draft PR delivery commit: `d6d3942f89b69b2bd81406ba4579db66b0d765ed`;
- The GitHub branch was published as one connector-created commit. The local
  commit list is retained for development traceability; reviewers should use
  the Draft PR branch or its remote commit rather than cherry-picking local
  workspace-only SHAs.

This branch does not modify `main` and does not modify any protected runtime
file listed in the task brief.

## Changed files

### Product contracts and Workflow

- `src/fleet-v2-types.ts` — versioned serializable Workflow, Manager and Mention contracts;
- `src/workflow-schema.ts` — schema parser, validator, diagnostics and migration seam;
- `src/workflow-store.ts` — append-only immutable revision Store, idempotency, soft delete and manifests;
- `test/workflow-schema.test.mjs`;
- `test/workflow-store.test.mjs`;
- `docs/fleet-v2-external-ai/WORKFLOW_SCHEMA.md`.

### Manager and mentions

- `src/manager-policy.ts` — pure bounded plan/delegation/replan policy;
- `src/manager-prompt.ts` — Manager prompt and tool contract only;
- `src/mention-parser.ts` — pure Bot/Team/Manager mention parser;
- `test/manager-policy.test.mjs`;
- `test/mention-parser.test.mjs`;
- `docs/fleet-v2-external-ai/MANAGER_POLICY.md`;
- `docs/fleet-v2-external-ai/MENTION_PARSER.md`.

### UI and integration documentation

- `src/fleet-v2-panel.ts` — independent React presentational component;
- `test/fleet-v2-panel.test.mjs`;
- `docs/fleet-v2-external-ai/README.md`;
- `docs/fleet-v2-external-ai/UI_INTEGRATION.md`;
- `docs/fleet-v2-external-ai/INTEGRATION_REQUEST.md`.

## Public interfaces for Codex

1. Validate a draft with `validateWorkflowDraft()` or assert with
   `assertValidWorkflowDraft()`.
2. Validate a full definition with `validateWorkflow()` or assert with
   `assertValidWorkflow()`.
3. Persist definitions with `WorkflowStore.create/list/get/update/softDelete`.
4. Export/import with `WorkflowStore.exportManifest/importManifest`.
5. Generate a product-layer plan with `generateManagerPlan()`.
6. Generate a failure replacement suggestion with
   `generateReplanSuggestion()`.
7. Parse user text with `parseFleetMentions()`; re-check every target through
   canonical Gateway principal and ACL logic.
8. Render `FleetV2Panel` from bounded snapshots through props.

## Codex integration points

- Gateway mention processing: see `INTEGRATION_REQUEST.md`.
- Manager plan approval and Task/Run compilation: the control plane must bind
  task identity, requester, reply target, run identity, ACL and approval.
- Workflow execution: compile validated definitions into the existing
  Task/Run/Mailbox lifecycle; the Store is not an executor.
- UI: adapt existing setup/status snapshots without exposing full task bodies,
  model output, SOUL or credential material in polling responses.

## Known risks and intentional limits

- The product layer cannot prove runtime authorization; `authorized` and
  `routableTargets` are input facts/registry hints only.
- The Manager Policy is deterministic and bounded; it is not a Manager Agent
  runtime and cannot send messages or approve work.
- Workflow external effects are declaration-only and default-deny.
- `WorkflowStore` uses the existing `JsonlJournal` without changing it. It is a
  single-process definition store, not a distributed lock or runtime database.
- The component is `.ts` rather than standalone `.tsx` because the current
  server `tsconfig` includes `.ts` but excludes standalone `.tsx`; it still
  produces a React element and has an independent test.
- No large fixture or runtime artifact was added to Git or Google Drive.

## Rollback

The local feature and handoff records are isolated in the commits listed
above. To remove the local Part B work from a checkout, do not reset shared
branches; revert the local commits in reverse order:

```text
git revert 4cbcd09
git revert d19a6c0
git revert 8273315
git revert b706aac
git revert b73637b
git revert 6a6ae07
git revert 1568b85
```

The protected runtime remains unchanged, so Codex can also cherry-pick only a
subset of the commits or integrate file-by-file.

## Validation record

- `npm run check` — passed;
- `npm test` — passed, 101/101 tests;
- `npm run build:client` — underlying `tsdown` build passed;
- `npm pack --dry-run` with an isolated npm config — passed, 129 package files;
- `npm run pack:check` — the direct wrapper was affected by the environment's
  transient npm approval/network issue; the equivalent isolated dry-run passed;
- `npm run pack:smoke` — build and client bundle passed, but the temporary
  install could not resolve the uncached `@larksuiteoapi/node-sdk` from the
  restricted/offline environment. This is an environment dependency issue,
  not a Part B test failure.

## Security review notes

- No API keys, App Secrets, tokens, cookies, `.env` files or runtime state were
  added or committed.
- No Gateway, Mailbox, lease/fencing, ACL, Agent lifecycle, protected client,
  package manifest or CI file was modified.
- Tests cover credentials, executable input, cycles, orphan nodes, unknown
  references, budgets, long input, 500 logical Bots, 500 mentions and torn
  JSONL tail recovery.

## 中文交接摘要

Part B 已经完成定义层、策略层、解析层、独立 UI 和测试，但没有接入真实
Gateway。Codex 下一步需要把这些纯模块接入主干控制平面，并重新完成身份、ACL、
审批、TTL、lease、fencing、Task/Run、Agent session 和分布式调度审查。
