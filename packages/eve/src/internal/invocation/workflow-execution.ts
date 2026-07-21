import type { UserContent } from "ai";
import { RunExpiredError, WorkflowRunNotFoundError } from "#compiled/@workflow/errors/index.js";

import type { SessionAuthContext } from "#channel/types.js";
import type {
  AgentInvocation,
  AgentInvocationExecution,
  AgentInvocationMutationResult,
  AgentInvocationStatus,
} from "#internal/invocation/agent-invocation-service.js";
import {
  INVOCATION_KIND,
  INVOCATION_KIND_ATTRIBUTE,
  INVOCATION_TOKEN_ATTRIBUTE,
} from "#internal/invocation/metadata.js";
import { getRun, getWorld } from "#internal/workflow/runtime.js";
import type { HandleMessageStreamEvent } from "#protocol/message.js";
import type { Agent } from "#public/definitions/channel.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";

export class WorkflowAgentInvocationExecution implements AgentInvocationExecution {
  readonly #agent: Agent;
  readonly #channelName: string;

  constructor(agent: Agent, channelName: string) {
    this.#agent = agent;
    this.#channelName = channelName;
  }

  async create(input: {
    readonly auth: SessionAuthContext;
    readonly message: string | UserContent;
    readonly outputSchema?: JsonObject;
  }): Promise<AgentInvocation> {
    const continuationToken = `invocation:${crypto.randomUUID()}`;
    const handle = await this.#agent.run({
      adapter: { kind: "http" },
      auth: input.auth,
      capabilities: { requestInput: true },
      channelName: this.#channelName,
      continuationToken: `${this.#channelName}:${continuationToken}`,
      externalInvocation: { continuationToken },
      input: { message: input.message, outputSchema: input.outputSchema },
      mode: "task",
    });

    return workingInvocation(handle.sessionId, new Date().toISOString());
  }

  async read(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const run = await this.#readInvocationRun(input.invocationId);
    if (run === undefined) return undefined;

    const events = await readPersistedEvents(input.invocationId);
    if (isTerminalRunStatus(run.status)) {
      return await terminalInvocation(run);
    }
    return projectNonterminal(run.runId, run.createdAt.toISOString(), events);
  }

  async update(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
    readonly responses: readonly InputResponse[];
  }): Promise<AgentInvocationMutationResult> {
    const current = await this.read(input);
    if (current === undefined) return { type: "not_found" };
    if (current.status !== "input_required") {
      return conflict("Invocation is not waiting for input.");
    }
    for (const response of input.responses) {
      if (current.inputRequests?.[response.requestId] === undefined) {
        return conflict(`Unknown input request: ${response.requestId}`);
      }
    }

    const run = await this.#readInvocationRun(input.invocationId);
    const token = run?.attributes[INVOCATION_TOKEN_ATTRIBUTE];
    if (token === undefined) return { type: "not_found" };
    try {
      await this.#agent.deliver({
        continuationToken: `${this.#channelName}:${token}`,
        payload: { inputResponses: input.responses },
      });
    } catch (error) {
      if (RunExpiredError.is(error)) return { type: "not_found" };
      throw error;
    }

    const invocation = await this.read(input);
    return invocation === undefined ? { type: "not_found" } : { invocation, type: "success" };
  }

  async cancel(input: {
    readonly auth: SessionAuthContext;
    readonly invocationId: string;
  }): Promise<AgentInvocation | undefined> {
    const current = await this.read(input);
    if (current === undefined || isTerminal(current.status)) return current;
    try {
      await getRun(input.invocationId).cancel({ cancelReason: "Agent invocation cancelled." });
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
    return await this.read(input);
  }

  async #readInvocationRun(invocationId: string) {
    const world = await getWorld();
    try {
      const run = await world.runs.get(invocationId);
      return run.attributes[INVOCATION_KIND_ATTRIBUTE] === INVOCATION_KIND ? run : undefined;
    } catch (error) {
      if (WorkflowRunNotFoundError.is(error) || RunExpiredError.is(error)) return undefined;
      throw error;
    }
  }
}

async function readPersistedEvents(invocationId: string): Promise<HandleMessageStreamEvent[]> {
  const readable = getRun(invocationId).getReadable<Uint8Array>({ startIndex: 0 });
  const tailIndex = await readable.getTailIndex();
  if (tailIndex < 0) {
    await readable.cancel("invocation event stream is empty").catch(() => {});
    return [];
  }

  const reader = readable.getReader();
  const decoder = new TextDecoder();
  const events: HandleMessageStreamEvent[] = [];
  let buffer = "";
  try {
    while (events.length <= tailIndex) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.length > 0) events.push(JSON.parse(line) as HandleMessageStreamEvent);
      }
    }
  } finally {
    await reader.cancel("invocation event snapshot complete").catch(() => {});
    reader.releaseLock();
  }
  return events;
}

function projectNonterminal(
  invocationId: string,
  createdAt: string,
  events: readonly HandleMessageStreamEvent[],
): AgentInvocation {
  let status: "working" | "input_required" = "working";
  let inputRequests: Readonly<Record<string, InputRequest>> | undefined;
  for (const event of events) {
    if (event.type === "input.requested") {
      status = "input_required";
      inputRequests = Object.fromEntries(
        event.data.requests.map((request) => [request.requestId, request]),
      );
    } else if (event.type === "turn.started") {
      status = "working";
      inputRequests = undefined;
    }
  }
  return {
    createdAt,
    inputRequests,
    invocationId,
    pollAfterMs: status === "working" ? 1_000 : undefined,
    status,
  };
}

async function terminalInvocation(run: {
  readonly createdAt: Date;
  readonly error?: unknown;
  readonly runId: string;
  readonly status: string;
}): Promise<AgentInvocation> {
  const base = { createdAt: run.createdAt.toISOString(), invocationId: run.runId };
  if (run.status === "cancelled") return { ...base, status: "cancelled" };
  if (run.status === "failed") {
    return {
      ...base,
      error: { code: -32603, data: safeJson(run.error), message: errorMessage(run.error) },
      status: "failed",
    };
  }
  const returned = await getRun<{ readonly output: unknown }>(run.runId).returnValue;
  return { ...base, result: safeJson(returned.output), status: "completed" };
}

function workingInvocation(invocationId: string, createdAt: string): AgentInvocation {
  return { createdAt, invocationId, pollAfterMs: 1_000, status: "working" };
}

function safeJson(value: unknown): JsonValue {
  try {
    return parseJsonValue(value);
  } catch {
    return String(value);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Session failed.";
}

function conflict(message: string): AgentInvocationMutationResult {
  return { message, type: "conflict" };
}

function isTerminal(status: AgentInvocationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function isTerminalRunStatus(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}
