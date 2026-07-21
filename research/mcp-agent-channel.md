---
issue: https://github.com/vercel/eve/issues/883
status: proposed
last_updated: "2026-07-20"
---

# MCP agent channel

## Goal

Ship a demo in which an eve agent opts into an authenticated MCP endpoint, Claude Code connects to
it, and Claude delegates durable work to the agent. Keep the first usable slice small while making
its invocation state reusable by the MCP Tasks extension and a future MCP-backed replacement for
the proprietary remote-agent transport.

Success for the demo is:

1. an author adds `agent/channels/mcp.ts` and deploys the agent;
2. Claude Code discovers the agent invocation tools over Streamable HTTP;
3. `claude mcp login <name>` authenticates through an external OAuth/OIDC authorization server;
4. Claude starts work, retains a durable invocation handle, and retrieves the terminal result;
5. losing an individual HTTP request does not require starting the agent run again.

The first demo targets Claude Code's ordinary MCP tool support. It must not depend on Claude Code
implementing `io.modelcontextprotocol/tasks`.

This plan narrows issue #883's broad MCP publication proposal around the demo's agent-invocation
goal. Directly publishing compiled instructions, skills, and authored tools remains compatible with
the channel but is deferred; it must not delay or become an implicit side effect of publishing the
agent invocation surface.

## Product model

MCP is the remote transport. The receiving eve deployment owns an invocation independently unless
a future, trusted eve delegation extension explicitly adopts it into a caller's execution tree.

```text
Claude Code or another harness                 eve agent

 tools/call agent_start  --------------------> create task-mode eve session
                         <-------------------- durable invocation handle
 tools/call agent_get    --------------------> read invocation state
                         <-------------------- working | input_required | terminal

MCP Tasks-capable client

 tools/call agent        --------------------> same invocation service
                         <-------------------- CreateTaskResult
 tasks/get/update/cancel --------------------> same invocation service
```

The compatibility tools and MCP Tasks methods are adapters over one internal invocation service.
They must not own separate state machines, result conversion, authorization rules, or cancellation
behavior.

Protocols describe capabilities; mounts describe relationships. A later MCP-backed subagent mount
may add lineage, inherited ceilings, child-session UI, and aggregate attribution without changing
the remote transport or the receiving agent's public MCP endpoint.

## Authoring API

An agent opts in explicitly:

```ts title="agent/channels/mcp.ts"
import { mcpChannel } from "eve/channels/mcp";
import { oidc } from "eve/channels/auth";

export default mcpChannel({
  agent: {
    description: "Investigates software tasks and returns a concise report.",
  },
  auth: oidc({
    issuer: process.env.MCP_OIDC_ISSUER!,
    audience: process.env.MCP_OIDC_AUDIENCE!,
  }),
  oauth: {
    authorizationServers: [process.env.MCP_OIDC_ISSUER!],
    resource: process.env.MCP_RESOURCE_URL!,
  },
});
```

`mcpChannel()` owns `POST /mcp` and the OAuth protected-resource metadata route. It uses the same
`AuthFn` contract and `SessionAuthContext` projection as other HTTP channels. The OAuth metadata
config describes an external authorization server; eve is a protected resource, not a token issuer.
A static bearer/header path may be used for deterministic tests and local smoke checks, but the
manual demo must exercise `claude mcp login`.

The initial `agent` options are intentionally narrow:

- `description`: required model-facing description;
- `outputSchema`: optional fixed structured result schema for every invocation;

The channel does not automatically publish the agent's authored tools, connections, instructions,
skills, or subagents. Publishing those capabilities directly is a separate surface from invoking
the agent and requires its own security review.

## MCP surface

### Baseline compatibility tools

Clients without MCP Tasks support receive ordinary, short-lived tools:

- `agent_start({ message, outputSchema? })`
- `agent_get({ invocationId })`
- `agent_update({ invocationId, responses })`
- `agent_cancel({ invocationId })`

`agent_start` returns only after the task-mode eve session has been durably accepted. Each call
creates a new invocation. Clients must retain the returned handle and must not automatically retry
an ambiguously failed start.

`agent_get` returns the complete current state immediately. Working invocations include a
`pollAfterMs` hint so clients can avoid aggressive model-driven polling without making correctness
depend on one long-lived connection.

The state shape is stable across compatibility tools and MCP Tasks adapters:

```ts
interface AgentInvocation {
  invocationId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  createdAt: string;
  expiresAt?: string;
  pollAfterMs?: number;
  inputRequests?: Record<string, McpInputRequest>;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}
```

Pending input is initially limited to MCP elicitation shapes that can round-trip through eve's
existing `InputRequest` flow. Unknown request methods remain visible but `agent_update` rejects an
unsupported response explicitly. Sampling support is out of the demo.

### Native MCP Tasks adapter

When the client advertises `io.modelcontextprotocol/tasks`, the server additionally exposes a
canonical `agent` tool. Calling it creates the same invocation and may return
`resultType: "task"`. The mapping is mechanical:

| Invocation service   | MCP Tasks                         |
| -------------------- | --------------------------------- |
| create               | task-returning `tools/call agent` |
| read                 | `tasks/get`                       |
| answer input         | `tasks/update`                    |
| request cancellation | `tasks/cancel`                    |
| invocation id        | task id                           |

A completed `tasks/get` includes the final `CallToolResult`; there is no `tasks/result`. Task IDs are
server-generated and durably readable before `CreateTaskResult` is returned. The server advertises
the extension only when the full mapped lifecycle is active.

Capability-aware discovery should prefer one obvious path:

- clients declaring MCP Tasks see `agent` as the preferred invocation tool and do not need the
  compatibility tools;
- clients without Tasks see the compatibility tools;
- if interoperable clients cache one global tool list, expose both temporarily but label the
  compatibility tools unambiguously and verify that Claude selects `agent_start`.

The implementation spike must settle which behavior current Claude Code and the selected MCP SDK
permit before freezing tool visibility semantics.

## Invocation access and storage

Add one protocol-neutral `AgentInvocationService` at the channel/runtime boundary. It starts a
`mode: "task"` eve session and projects that session's durable lifecycle into invocation state.
MCP handlers never implement their own model loop.

The source of truth must survive process and deployment restarts. Do not keep invocation records or
pending input only in module memory. The initial implementation may reconstruct the
current invocation from the existing durable workflow/session event stream to keep the execution
integration narrow. A later optimization can add an execution-owned compact projection without
changing the protocol-neutral invocation service or its public adapters.

Every create, read, update, cancel, and native Tasks operation authenticates against the channel's
configured policy. The opaque, unguessable `invocationId` is a capability handle: any caller
authorized for the endpoint who possesses it may inspect, update, or cancel that invocation. The
durable record contains no bearer token, callback URL, or live MCP transport object.

Terminal projection follows MCP semantics:

- successful eve output becomes `completed.result`;
- an eve/tool result that is an application error remains a completed protocol result;
- workflow or JSON-RPC failure becomes `failed.error`;
- cancellation acknowledgement is eventually consistent and does not claim remote work has
  already stopped;
- expiry returns a stable not-found/expired error without exposing internal session identifiers.

## Authentication

The channel implements MCP's protected-resource discovery and challenge behavior:

1. an unauthenticated `/mcp` request returns `401` with an MCP-compatible `WWW-Authenticate`
   resource-metadata challenge;
2. the protected-resource document names the canonical resource and authorization server;
3. Claude Code performs authorization with that server and retries with a bearer token;
4. the configured eve `AuthFn` verifies the token and produces `SessionAuthContext`;
5. the initiating principal appears as the eve session's current/initiator auth; later authorized
   callers may operate the invocation handle without replacing that durable execution identity.

OAuth issuer quirks must stay outside the MCP transport core. The demo documents one tested
provider, including dynamic client registration or explicit Claude `--client-id` setup as required.
Tests use a local fake issuer or signed token fixture and never depend on the external provider.

## Polling and workflow cost

The receiving eve agent does not poll its own workflow. Initially, `agent_get` reconstructs state from the persisted session event stream. A compact
invocation projection may later replace this replay path so reads remain constant-cost as session
histories grow.

Generic Tasks clients may poll, but that creates HTTP reads rather than model runs on the server.
An eve Tasks client should initially use adaptive durable polling and honor `pollIntervalMs`. A
future `io.eve/task-callback` optimization may wake a parked caller workflow, after which the caller
performs one authoritative `tasks/get`. A callback carries only task identity, is idempotent, and
is never a second result protocol.

Observation preference for a future eve client is:

1. authenticated eve callback wake-up when both peers advertise it;
2. `notifications/tasks` while a reliable stream is available;
3. adaptive `tasks/get` polling as the universal fallback.

This keeps one MCP task state machine while avoiding hundreds of caller workflow steps for
long-running eve-to-eve work.

## Stacked implementation

Use Graphite so each boundary is independently reviewable. Start from an attached branch tracking
current `main`; the present checkout is detached. Every commit must be signed and include the DCO
trailer (`git commit -s`, or Graphite's equivalent commit invocation with a signed-commit setup).
Submit the complete series with `gt submit --stack`.

### PR 1 — MCP transport and OAuth interoperability spike

Establish an eve-owned, stateless Streamable HTTP server adapter behind a test-only channel route.
Vendor the minimal server implementation or generated artifacts into `packages/eve`; do not add a
new runtime dependency. Prove initialize, capability negotiation, `tools/list`, `tools/call`, JSON-RPC
errors, DELETE/session behavior if required by the negotiated transport, request cancellation, and
MCP-compliant auth challenges.

Include a scripted smoke test that connects with the official MCP Inspector and a manual runbook for
current Claude Code. Record the exact protocol/version and OAuth behavior observed. No public API
or agent execution ships in this PR.

Suggested branch: `mcp-agent/transport-spike`.

### PR 2 — Durable agent invocation service

Add `AgentInvocationService` and durable invocation lifecycle handling independently of MCP. Start
task-mode sessions, reconstruct invocation state from the existing durable event stream,
project terminal results, and implement reads, cancellation, expiry, and elicitation update/resume. Expose only internal APIs and exercise them through integration tests.

This PR is the single source of truth used by all later protocol adapters. It must prove that an
accepted invocation remains readable after a process restart and that duplicate update/cancel
requests are safe.

Suggested branch: `mcp-agent/invocation-service` stacked on PR 1.

### PR 3 — Public MCP channel and Claude Code demo

Ship `mcpChannel()` from `eve/channels/mcp`, route registration, protected-resource metadata, and the
four compatibility tools. Add a fixture agent with deterministic work plus an auth policy. Document:

```sh
claude mcp add --transport http eve-demo https://<deployment>/mcp
claude mcp login eve-demo
claude mcp get eve-demo
```

The manual acceptance script asks Claude to start work, retrieve it without duplicating the run, and
report the result. Also verify that clients do not retry an ambiguously failed `agent_start`,
authenticated cross-principal handoff by invocation ID, polling guidance, cancellation, and one
input-required round trip.

This PR updates public docs, adds a patch changeset, and is the demo milestone.

Suggested branch: `mcp-agent/channel-demo` stacked on PR 2.

### PR 4 — Compact invocation projection

Materialize externally visible invocation transitions into a namespaced durable stream attached to
the root session run. Replace full event-stream replay with tail snapshot reads while preserving the
`AgentInvocationService` contract and MCP tool behavior. Thread the
root-owned stream capability through turn execution only in this optimization PR.

Suggested branch: `mcp-agent/invocation-projection` stacked on PR 3.

### PR 5 — `io.modelcontextprotocol/tasks` server adapter

Map the extension onto `AgentInvocationService`; add capability-aware tool discovery, `agent`,
`tasks/get`, `tasks/update`, and `tasks/cancel`. Validate extension payloads at runtime and add MCP
Inspector coverage. Compatibility tools remain adapters, not a parallel implementation.

Document that Claude Code currently uses the compatibility surface until it implements the
extension. Add a patch changeset if this lands separately from PR 3.

Suggested branch: `mcp-agent/tasks-server` stacked on PR 3.

### Follow-up stack — eve Tasks client and MCP-backed subagents

Do not block the external-harness demo on this stack.

1. Extend eve's MCP client with the new Tasks lifecycle, persisting the server task ID before any
   poll and never replaying the original non-idempotent tool call after that commit.
2. Add adaptive polling, elicitation, cancellation, and optional callback wake-up.
3. Introduce an MCP-backed subagent mount that references one MCP connection but locally opts into
   parent/child lineage, delegated ceilings, recursive cancellation, subagent UI, and aggregate
   attribution.
4. Migrate `defineRemoteAgent` onto that MCP transport, then deprecate the proprietary create-session
   and callback protocol only after parity tests pass.

An ordinary MCP connection remains independently owned and records a causal link; an MCP-backed
subagent is adopted into the caller's execution tree. Both use the same endpoint and transport.

## Verification

Use the narrowest tier that expresses each contract:

- unit: JSON-RPC validation, capability projection, task/invocation state mapping, status
  transitions, and result/error conversion;
- integration: route auth, create/read/update/cancel, restart-safe snapshots, duplicate requests, task-mode session completion, and elicitation resume;
- scenario: a real Nitro Streamable HTTP endpoint exercised by an MCP client subprocess, including
  disconnect/reconnect and cancellation;
- fixture/manual: deploy the demo, authenticate with current Claude Code, invoke the agent, and
  retrieve a result through compatibility tools;
- native Tasks: MCP Inspector creates a task and drives every terminal state plus input-required;
- repository: `pnpm fmt`, `pnpm lint`, `pnpm typecheck`, `pnpm guard:invariants`, focused tier tests,
  `pnpm test:unit`, and `pnpm docs:check` for public PRs.

The e2e suite cannot run locally. Add a deterministic fixture eval where protocol behavior can be
asserted in CI without requiring an external OAuth provider or Claude credentials.

## Invariants

- Status reads never start work; clients do not automatically retry an ambiguously failed create.
- Compatibility tools and MCP Tasks share one invocation record and transition implementation.
- A client never receives a task handle before that handle is durably readable.
- Invocation operations require channel authorization and possession of the unguessable invocation
  handle.
- The MCP endpoint exposes agent invocation explicitly and does not accidentally publish internal
  tools or prompts.
- Blocking `tools/call` is not the reliability path for clients without Tasks support.
- Server-side status reads do not run a model or poll the agent workflow.
- MCP remains the transport; eve-specific callbacks are optional wake-up signals only.
- The receiver always enforces its own limits. Future delegated limits can only add a tighter ceiling.

## Out of scope for the demo stack

- Publishing arbitrary authored tools, skills, prompts, or instructions as MCP capabilities;
- MCP sampling requests and arbitrary multi-round-trip request methods;
- conversation-mode continuation through the agent tool;
- replacing local subagents;
- cost transfer or billing settlement between deployments;
- removing `defineRemoteAgent` before the follow-up client/delegation stack reaches parity;
- making eve an OAuth authorization server.

## Decision gates

Resolve these in PR 1 before public API review:

1. Which MCP protocol version and server implementation interoperate with the current Claude Code
   Streamable HTTP client?
2. Can `tools/list` vary cleanly by per-request extension capabilities, or must both native and
   compatibility tools remain visible?
3. Which external OAuth provider gives a reproducible `claude mcp login` demo, and does it require
   dynamic client registration or an explicit client ID?
4. Which existing durable session-store primitive can expose a current invocation snapshot without
   event-stream replay or a new runtime dependency?
