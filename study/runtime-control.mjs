// Trusted recorder only. The browser never receives this daemon credential.
export async function releaseIdleRuntime(student, agentId) {
  const url = new URL(student.daemonUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/mcp/agents";
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${student.daemonPassword}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: "release_idle_agent", arguments: { agentId } },
    }),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw Error("Cannot release idle conversation runtime");
  const text = await response.text();
  const payload = JSON.parse(
    text.startsWith("event:") || text.startsWith("data:")
      ? text
          .split("\n")
          .find((line) => line.startsWith("data:"))
          .slice(5)
          .trim()
      : text,
  );
  if (payload.error || payload.result?.isError) throw Error("Idle runtime release failed");
  return payload.result?.structuredContent?.success === true;
}
