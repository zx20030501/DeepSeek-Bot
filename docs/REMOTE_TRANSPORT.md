# Remote Bot Transport

Remote Bot Transport is the cross-machine boundary for the DeepSeek Bot Fleet. It carries the existing typed BotMessageEnvelope; it does not create a second task protocol.

## What is included

- Schema-versioned delivery envelopes.
- correlationId, leaseId, fencingToken, issuedAt, and expiresAt.
- HMAC-SHA256 signatures over the exact HTTP body.
- Durable receiver fencing through RemoteDeliveryLedger.
- Idempotent delivery by source node plus Peer Message idempotency key.
- HTTP sender/receiver helpers and an in-memory loopback transport.
- Payload size, TTL, hop, and credential-like payload checks inherited from Peer Message v1.

## Message flow

1. The sender creates a normal BotMessageEnvelope.
2. createRemoteTransportMessage() wraps it with a target node and delivery lease.
3. HttpRemoteBotTransport signs and sends the JSON body.
4. The receiving HTTP route calls createRemoteTransportHandler().
5. The handler authenticates the body, checks expiry, admits the fencing token, and invokes the Gateway receiver.
6. The Gateway receiver must durably create or reconcile the local Task/Run and enqueue the local Mailbox before returning accepted: true.
7. A retry with the same idempotency key is a duplicate; a lower fencing token is stale.

## Security boundary

The shared secret is only passed to the transport constructor or resolved from a secret manager by the host application. It must never be stored inside a Bot Message payload, Workflow input, Git repository, or Google Drive research artifact.

The transport does not trust from merely because the HMAC is valid. The receiving Gateway still applies its local Bot ACL and target-node checks before accepting the message.

## Host integration

The package exposes:

- HttpRemoteBotTransport for outbound delivery;
- createRemoteTransportHandler() for an HTTP route;
- RemoteDeliveryLedger for a node-local JSONL fence;
- BotGateway.receiveRemoteBotMessage() for durable local admission.

A DSH host should mount the handler at a private endpoint such as:

POST /internal/dsh/bot-messages

The endpoint must be protected by network policy in addition to HMAC. Do not expose it to the public Internet without a gateway, rate limit, replay policy, and secret rotation plan.

This first slice intentionally keeps HTTP server registration host-owned. It allows DSH Cordis deployments, standalone Node servers, and tests to use the same receiver contract without coupling the plugin to one web-server implementation.

## Operational defaults

- Default delivery lease: 2 minutes.
- Maximum delivery lease: 30 minutes.
- Default payload limit: 512 KiB for the complete remote message.
- Default clock-skew tolerance: 30 seconds.
- Fencing tokens start at 1 and must increase for a new delivery attempt using the same idempotency key.

Cross-machine Workflow scheduling remains Gateway-owned: the remote transport is only the durable message hop. A Workflow node must still be admitted through the local Task/Run/Mailbox state machine.


## Automatic Bot route dispatch

When BotGateway is configured with remoteTransport.enabled, nodeId, a secret environment name, and a routes map, sendBotMessage() can target a Bot that is not in the local roster:

    collaboration:
      remoteTransport:
        enabled: true
        nodeId: node-a
        sharedSecretEnv: DSH_BOT_TRANSPORT_SECRET
        routes:
          researcher:
            nodeId: node-b
            endpoint: https://node-b.example/internal/dsh/bot-messages

Remote route messages require an explicit idempotencyKey. The sender persists the exact outbound envelope before the network call, retries the same envelope after a restart, and commits the outbound ledger only after a positive receipt. The receiver sends a report envelope back to the source node after the local Bot finishes. The source node then completes the original Task/Run and emits the reply to the original platform target.

The route endpoint and shared secret are operational configuration. Keep the secret in the environment or DSH credentials service; never put it in the JSON settings body.
