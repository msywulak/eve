import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type { AuthFn } from "#public/channels/auth.js";
import { routeAuth } from "#public/channels/auth.js";
import { defineChannel, DELETE, GET, POST, type Channel } from "#public/definitions/channel.js";
import { readRouteAgent } from "#internal/nitro/routes/channel-route-context.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import type { SessionAuthContext } from "#channel/types.js";
import {
  AgentInvocationService,
  type AgentInvocation,
} from "#internal/invocation/agent-invocation-service.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import {
  createMcpStreamableHttpServer,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpAuthChallenge,
  createMcpProtectedResourceMetadata,
} from "#internal/mcp/protected-resource.js";
import { inputResponseSchema } from "#runtime/input/types.js";

export interface McpChannelInput {
  readonly agent: {
    readonly description: string;
    readonly outputSchema?: JsonObject;
  };
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  readonly oauth: {
    readonly authorizationServers: readonly string[];
    readonly resource: string;
    readonly scopesSupported?: readonly string[];
  };
}

/** Public MCP channel exposing durable agent invocation compatibility tools. */
export type McpChannel = Channel;

/**
 * Publishes this agent as a protected, stateless Streamable HTTP MCP server.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  const metadataUrl = protectedResourceMetadataUrl(input.oauth.resource);
  const authenticate = async (request: Request) => {
    const result = await routeAuth(request, input.auth);
    return result instanceof Response && result.status === 401
      ? createMcpAuthChallenge(metadataUrl)
      : result;
  };

  return defineChannel({
    routes: [
      GET("/.well-known/oauth-protected-resource", async () =>
        Response.json(createMcpProtectedResourceMetadata(input.oauth), {
          headers: { "cache-control": "no-store" },
        }),
      ),
      GET(
        "/mcp",
        async (request, args) => await handleMcpRequest(request, args, authenticate, input.agent),
      ),
      POST(
        "/mcp",
        async (request, args) => await handleMcpRequest(request, args, authenticate, input.agent),
      ),
      DELETE(
        "/mcp",
        async (request, args) => await handleMcpRequest(request, args, authenticate, input.agent),
      ),
    ],
  });
}

async function handleMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  authenticate: (request: Request) => Promise<SessionAuthContext | Response>,
  config: McpChannelInput["agent"],
): Promise<Response> {
  const auth = await authenticate(request);
  if (auth instanceof Response) return auth;
  const agent = readRouteAgent(args);
  if (agent === undefined) {
    return Response.json(
      { error: "MCP requires internal channel dispatch context." },
      { status: 500 },
    );
  }
  const service = new AgentInvocationService(new WorkflowAgentInvocationExecution(agent, "mcp"));
  return await createMcpStreamableHttpServer({
    authenticate: async () => auth,
    name: "eve-agent",
    tools: createInvocationTools(service, config),
    version: "1.0.0",
  })(request);
}

function createInvocationTools(
  service: AgentInvocationService,
  config: McpChannelInput["agent"],
): readonly McpServerTool[] {
  const tools: McpServerTool[] = [
    {
      definition: {
        description: `${config.description} Starts durable work and returns an invocation handle immediately.`,
        inputSchema: {
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            outputSchema: { type: "object" },
          },
          required: ["message"],
          type: "object",
        },
        name: "agent_start",
      },
      async call(value, context) {
        const body = record(value);
        if (typeof body.message !== "string" || body.message.length === 0)
          throw new Error("message is required.");
        const invocation = await service.create({
          auth: context.auth,
          message: body.message,
          outputSchema: asJsonObject(body.outputSchema) ?? config.outputSchema,
        });
        return invocationResult(invocation);
      },
    },
    {
      definition: {
        description: "Reads complete durable invocation state.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            invocationId: { type: "string" },
          },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_get",
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.read({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
    {
      definition: {
        description: "Answers a pending input request on a durable invocation.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            invocationId: { type: "string" },
            responses: { items: { type: "object" }, type: "array" },
          },
          required: ["invocationId", "responses"],
          type: "object",
        },
        name: "agent_update",
      },
      async call(value, context) {
        const body = record(value);
        if (!Array.isArray(body.responses)) throw new Error("responses must be an array.");
        const responses = body.responses.map((response) => inputResponseSchema.parse(response));
        return invocationResult(
          await service.update({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
            responses,
          }),
        );
      },
    },
    {
      definition: {
        description:
          "Requests cancellation of a durable invocation. Read it again to observe acknowledgement.",
        inputSchema: {
          additionalProperties: false,
          properties: { invocationId: { type: "string" } },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_cancel",
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.cancel({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
  ];
  return tools;
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  return {
    content: [{ text: JSON.stringify(invocation), type: "text" }],
    structuredContent: { ...invocation },
  };
}

function protectedResourceMetadataUrl(resource: string): string {
  return new URL("/.well-known/oauth-protected-resource", resource).toString();
}
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  return value === undefined ? undefined : parseJsonObject(value);
}
