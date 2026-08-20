# Fleet v2 Panel Integration

## Component

`src/fleet-v2-panel.ts` exports `FleetV2Panel` and `FleetV2PanelProps`.
It is a presentational React component that receives bounded snapshots through
props and displays:

- Workflow names, revisions, status and node counts;
- Manager plan decisions, delegation counts and approval state;
- Team members, Manager and concurrency;
- Agent Thread participants and task linkage;
- Bot capability/status summaries;
- a bounded recent audit summary.

It has no Gateway, transport, credential, fetch, or mutation dependency. The
optional `onSelectWorkflow` callback is the only interaction hook.

The current project TypeScript configuration includes `.ts` sources in the
server build but does not include standalone `.tsx` files. The component uses
`React.createElement` in `.ts` so it can be independently type-checked without
modifying the protected `tsconfig`, `client.tsx`, or client bundler entry.
Codex may adapt the component to the client JSX convention when integrating it.

## Suggested integration

1. Convert Gateway/Team/Task snapshots into the panel prop types in a protected
   client adapter.
2. Keep full instructions, model output, SOUL, credentials and message bodies
   out of the two-second status snapshot.
3. Load full Workflow/Task/Audit details only after an authorized user action.
4. Wire `onSelectWorkflow` to an ACL-checked detail route; do not add mutation
   endpoints to the panel itself.

## 中文说明

这个组件只展示快照，不自己访问 Gateway，也不自己修改 Workflow、Team、Bot
或审批状态。Codex 接入时应继续保留“短状态轮询、详情按需加载、所有修改走
受保护 API”的边界。
