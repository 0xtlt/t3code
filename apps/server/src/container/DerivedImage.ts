import * as Context from "effect/Context";

import { type ContainerBase, sha256Hex } from "./ContainerDefinition.ts";

/** Bump when the generated Dockerfile changes, so existing derived images rebuild. */
export const LAYER_VERSION = 1;

export const HOME_DIRECTORY = "/t3home";

export interface ContainerLayerOptions {
  /**
   * False builds only the `/t3home` directory, with no package manager or npm
   * access. Integration tests use it to run on tiny images; production always
   * installs the toolchain.
   */
  readonly toolchain: boolean;
}

export const ContainerLayerOptions = Context.Reference<ContainerLayerOptions>(
  "t3/container/ContainerLayerOptions",
  { defaultValue: () => ({ toolchain: true }) },
);

const NPM_MISSING_MESSAGE =
  "t3code: the base image has no npm, so the agent CLIs (claude, codex) cannot be installed. " +
  "Use a Node-based image or install the CLIs in your Dockerfile.";

// Only the packages a CLI-driven agent needs to clone, commit, and make TLS
// calls; anything else belongs in the user's own definition.
const PACKAGE_INSTALL = [
  'missing=""',
  'command -v git >/dev/null 2>&1 || missing="$missing git"',
  'if ! [ -s /etc/ssl/certs/ca-certificates.crt ] && ! [ -s /etc/pki/tls/certs/ca-bundle.crt ] && ! [ -s /etc/ssl/cert.pem ]; then missing="$missing ca-certificates"; fi',
  'if [ -n "$missing" ]; then ' +
    "if command -v apt-get >/dev/null 2>&1; then apt-get update && apt-get install -y --no-install-recommends $missing && rm -rf /var/lib/apt/lists/*; " +
    "elif command -v apk >/dev/null 2>&1; then apk add --no-cache $missing; " +
    "elif command -v dnf >/dev/null 2>&1; then dnf install -y $missing && dnf clean all; " +
    "elif command -v microdnf >/dev/null 2>&1; then microdnf install -y $missing && microdnf clean all; " +
    "elif command -v yum >/dev/null 2>&1; then yum install -y $missing && yum clean all; " +
    'else echo "t3code: no package manager found; continuing without:$missing" >&2; fi; fi',
];

const CLI_INSTALL = [
  'missing=""',
  'command -v claude >/dev/null 2>&1 || missing="$missing @anthropic-ai/claude-code"',
  'command -v codex >/dev/null 2>&1 || missing="$missing @openai/codex"',
  'if [ -n "$missing" ]; then ' +
    `if ! command -v npm >/dev/null 2>&1; then echo "${NPM_MISSING_MESSAGE}" >&2; exit 1; fi; ` +
    "npm install -g $missing; fi",
];

const runScript = (statements: ReadonlyArray<string>) =>
  `RUN set -eu; \\\n    ${statements.join("; \\\n    ")}`;

export function renderDerivedDockerfile(input: {
  readonly baseImage: string;
  readonly layer: ContainerLayerOptions;
}): string {
  const lines = [`FROM ${input.baseImage}`, "USER root"];
  if (input.layer.toolchain) {
    lines.push(runScript(PACKAGE_INSTALL), runScript(CLI_INSTALL));
  }
  // 1777 so the host uid the container runs as can write to a fresh named
  // volume, which copies this directory's mode.
  lines.push(`RUN mkdir -p ${HOME_DIRECTORY} && chmod 1777 ${HOME_DIRECTORY}`);
  return `${lines.join("\n")}\n`;
}

/** Tag of the image built from a user Dockerfile, before the derived layer. */
export function baseImageTag(base: Extract<ContainerBase, { kind: "dockerfile" }>): string {
  const key = JSON.stringify([
    base.dockerfileContent,
    base.context,
    Object.entries(base.buildArgs).toSorted(([a], [b]) => (a < b ? -1 : 1)),
  ]);
  return `t3code-base:${sha256Hex(key).slice(0, 16)}`;
}

/**
 * Tag of the image containers run. It hashes the base definition, the
 * Dockerfile contents, and the layer, so an unchanged definition never rebuilds.
 */
export function derivedImageTag(base: ContainerBase, layer: ContainerLayerOptions): string {
  const baseKey = base.kind === "image" ? base.image : baseImageTag(base);
  const key = JSON.stringify([baseKey, LAYER_VERSION, layer.toolchain]);
  return `t3code-env:${sha256Hex(key).slice(0, 16)}`;
}
