/**
 * The MCP endpoint is minted for the host (`127.0.0.1:<port>/mcp`); inside a
 * container that address is the container itself, so only the host name
 * changes. Port, path, and the credential stay as issued.
 */
export function rewriteMcpEndpointHost(endpoint: string, host: string): string {
  const url = new URL(endpoint);
  url.hostname = host;
  return url.toString();
}
