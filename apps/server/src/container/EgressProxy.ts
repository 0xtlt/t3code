/**
 * The egress proxy sidecar of a restricted-network container thread: the only
 * container attached to both the internal network and the engine's default
 * bridge. Plain Node so the stock `node:24-alpine` image runs it with `node -e`.
 *
 * Allowlist entries are hostnames, `*.suffix` (any subdomain, not the apex),
 * each optionally followed by `:port`. Anything else gets a 403.
 */
export const EGRESS_PROXY_IMAGE = "node:24-alpine";
export const EGRESS_PROXY_PORT = 3128;

export const EGRESS_PROXY_SOURCE = String.raw`
const net = require("net");
const http = require("http");

function hostAllowed(host, port, allow) {
  const name = String(host).toLowerCase().replace(/\.$/, "");
  return allow.some((raw) => {
    const entry = raw.trim().toLowerCase();
    const portAt = entry.lastIndexOf(":");
    const pattern = portAt === -1 ? entry : entry.slice(0, portAt);
    const entryPort = portAt === -1 ? null : entry.slice(portAt + 1);
    if (entryPort !== null && String(port) !== entryPort) return false;
    if (pattern.startsWith("*.")) return name.endsWith(pattern.slice(1)) && name.length > pattern.length - 1;
    return name === pattern;
  });
}

const allow = (process.env.T3_PROXY_ALLOW || "").split(",").filter(Boolean);
const deny = (socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");

if (process.env.T3_PROXY_ALLOW !== undefined) {
  const server = http.createServer((req, res) => {
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400).end();
      return;
    }
    const port = target.port || "80";
    if (target.protocol !== "http:" || !hostAllowed(target.hostname, port, allow)) {
      res.writeHead(403).end();
      return;
    }
    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    delete headers["proxy-authorization"];
    const upstream = http.request(
      { host: target.hostname, port, path: target.pathname + target.search, method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => res.headersSent ? res.destroy() : res.writeHead(502).end());
    req.pipe(upstream);
  });

  server.on("connect", (req, client, head) => {
    client.on("error", () => {});
    let target;
    try {
      target = new URL("http://" + req.url);
    } catch {
      return deny(client);
    }
    const port = target.port || "443";
    if (!hostAllowed(target.hostname.replace(/^\[|\]$/g, ""), port, allow)) return deny(client);
    const upstream = net.connect(Number(port), target.hostname.replace(/^\[|\]$/g, ""), () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });

  server.listen(Number(process.env.T3_PROXY_PORT || 3128), "0.0.0.0", () => {
    console.log("t3-egress-proxy listening");
  });
} else {
  module.exports = { hostAllowed };
}
`;
