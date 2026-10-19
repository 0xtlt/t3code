import { ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildProjectSecretInput, describeProjectSecret } from "./project-secrets-presentation";

const projectId = ProjectId.make("project");

describe("buildProjectSecretInput", () => {
  it("trims the name and scopes the secret to all threads", () => {
    expect(
      buildProjectSecretInput({ projectId, name: " API_KEY ", value: "s3cret", exposeAs: "both" }),
    ).toEqual({
      input: {
        projectId,
        name: "API_KEY",
        value: "s3cret",
        exposeAs: "both",
        scope: { type: "all" },
      },
    });
  });

  it.each(["1KEY", "has space", "dash-name", ""])("rejects the name %j", (name) => {
    expect(
      buildProjectSecretInput({ projectId, name, value: "x", exposeAs: "env" }),
    ).toHaveProperty("error");
  });

  it("requires a value because mobile never edits metadata alone", () => {
    expect(
      buildProjectSecretInput({ projectId, name: "API_KEY", value: "", exposeAs: "env" }),
    ).toHaveProperty("error");
  });
});

describe("describeProjectSecret", () => {
  it("shows a fixed mask, never anything derived from the value", () => {
    expect(
      describeProjectSecret({
        name: "API_KEY",
        exposeAs: "env",
        scope: { type: "all" },
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toBe("•••••••• · Env · All threads");
    expect(
      describeProjectSecret({
        name: "API_KEY",
        exposeAs: "file",
        scope: { type: "threads", threadIds: [ThreadId.make("t1"), ThreadId.make("t2")] },
        updatedAt: "2026-10-01T00:00:00.000Z",
      }),
    ).toBe("•••••••• · File · 2 threads");
  });
});
