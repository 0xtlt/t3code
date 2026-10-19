import { describe, expect, it } from "@effect/vitest";

import { EGRESS_PROXY_SOURCE } from "./EgressProxy.ts";

// The proxy source is a script for `node -e`; with no T3_PROXY_ALLOW it only
// exports its matcher, which is what these tests load.
const { hostAllowed } = (() => {
  const exported: {
    exports: {
      hostAllowed?: (host: string, port: string | number, allow: Array<string>) => boolean;
    };
  } = {
    exports: {},
  };
  new Function("require", "module", "process", EGRESS_PROXY_SOURCE)(() => ({}), exported, {
    env: {},
  });
  return exported.exports as {
    hostAllowed: (host: string, port: string | number, allow: Array<string>) => boolean;
  };
})();

describe("egress proxy allowlist matcher", () => {
  it("matches exact hostnames case-insensitively and ignores a trailing dot", () => {
    expect(hostAllowed("API.Anthropic.com.", 443, ["api.anthropic.com"])).toBe(true);
    expect(hostAllowed("evil.com", 443, ["api.anthropic.com"])).toBe(false);
  });

  it("does not treat an exact entry as a suffix", () => {
    expect(hostAllowed("api.anthropic.com.evil.com", 443, ["api.anthropic.com"])).toBe(false);
    expect(hostAllowed("xapi.anthropic.com", 443, ["api.anthropic.com"])).toBe(false);
  });

  it("matches wildcard entries on subdomains only, not the apex or lookalikes", () => {
    const allow = ["*.github.com"];
    expect(hostAllowed("api.github.com", 443, allow)).toBe(true);
    expect(hostAllowed("a.b.github.com", 443, allow)).toBe(true);
    expect(hostAllowed("github.com", 443, allow)).toBe(false);
    expect(hostAllowed("evilgithub.com", 443, allow)).toBe(false);
  });

  it("honors an optional port", () => {
    expect(hostAllowed("host.docker.internal", 3773, ["host.docker.internal:3773"])).toBe(true);
    expect(hostAllowed("host.docker.internal", 22, ["host.docker.internal:3773"])).toBe(false);
    expect(hostAllowed("host.docker.internal", 22, ["host.docker.internal"])).toBe(true);
  });

  it("denies everything for an empty allowlist", () => {
    expect(hostAllowed("api.anthropic.com", 443, [])).toBe(false);
  });
});
