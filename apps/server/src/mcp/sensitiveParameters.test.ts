import { expect, it } from "@effect/vitest";
import { EnvironmentId, OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Tracer from "effect/Tracer";
import { McpSchema, McpServer, Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpToolAccess from "./McpToolAccess.ts";
import { liveThreadShell } from "./McpToolAccess.testkit.ts";
import { SensitiveParameters } from "./sensitiveParameters.ts";

const SECRET = "e2e-secret-value-4242";

const shared = {
  parameters: Schema.Struct({ value: Schema.String }),
  success: Schema.Struct({ ok: Schema.Boolean }),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
  ],
};
const TestToolkit = Toolkit.make(
  Tool.make("store_secret", shared).annotate(SensitiveParameters, true),
  Tool.make("store_note", shared),
);
const layerHandlers = McpToolAccess.toLayer(TestToolkit, {
  store_secret: McpToolAccess.reads(() =>
    Effect.succeed({ ok: true }).pipe(Effect.withSpan("handler.child")),
  ),
  store_note: McpToolAccess.reads(() => Effect.succeed({ ok: true })),
});

const layerTest = McpHttpServer.toolkitRegistration(TestToolkit, layerHandlers).pipe(
  Layer.provideMerge(McpServer.McpServer.layer),
  Layer.provideMerge(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(liveThreadShell("thread-sensitive" as never)),
    }),
  ),
);

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:session",
  thread: undefined,
  client: { sessionId: "session", label: "Claude Code", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const recordSpans = () => {
  const spans: Array<Tracer.NativeSpan> = [];
  const tracer = Tracer.make({
    span: (options) => {
      const span = new Tracer.NativeSpan(options);
      spans.push(span);
      return span;
    },
  });
  return { spans, tracer };
};

const callUnderRpcSpan = (tool: string, tracer: Tracer.Tracer) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) =>
      server
        .callTool({ name: tool, arguments: { value: SECRET } })
        .pipe(Effect.withSpan("rpc.tools.call")),
    ),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
    Effect.withTracer(tracer),
  );

it.effect("keeps parameters of a sensitive tool off the span", () =>
  Effect.gen(function* () {
    const { spans, tracer } = recordSpans();
    const result = yield* callUnderRpcSpan("store_secret", tracer);
    expect(result.isError).toBe(false);

    const rpc = spans.find((span) => span.name === "rpc.tools.call")!;
    expect(rpc.attributes.get("tool")).toBe("store_secret");
    expect(rpc.attributes.has("parameters")).toBe(false);
    expect(JSON.stringify(spans.map((span) => [...span.attributes]))).not.toContain(SECRET);

    // The stand-in parent must not detach the handler's own spans from the trace.
    const child = spans.find((span) => span.name === "handler.child")!;
    expect(child.traceId).toBe(rpc.traceId);
    expect(child.parent._tag === "Some" && child.parent.value.spanId).toBe(rpc.spanId);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("still records parameters of other tools", () =>
  Effect.gen(function* () {
    const { spans, tracer } = recordSpans();
    yield* callUnderRpcSpan("store_note", tracer);
    const rpc = spans.find((span) => span.name === "rpc.tools.call")!;
    expect(rpc.attributes.get("parameters")).toEqual({ value: SECRET });
  }).pipe(Effect.provide(layerTest)),
);
