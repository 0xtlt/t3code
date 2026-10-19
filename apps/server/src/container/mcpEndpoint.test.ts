import { expect, it } from "@effect/vitest";

import { rewriteMcpEndpointHost } from "./mcpEndpoint.ts";

it("moves the MCP endpoint to the container-reachable host and keeps port, path, and query", () => {
  expect(rewriteMcpEndpointHost("http://127.0.0.1:3773/mcp?x=1", "host.docker.internal")).toBe(
    "http://host.docker.internal:3773/mcp?x=1",
  );
  expect(rewriteMcpEndpointHost("http://localhost:4001/mcp/abc", "172.17.0.1")).toBe(
    "http://172.17.0.1:4001/mcp/abc",
  );
});
