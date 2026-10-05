import { appendFileSync } from "node:fs";
import { join } from "node:path";

// Raw SDK messages differ from the high-level on(event) payloads. One owned
// timeline subscription also keeps recording when a browser disconnects.
export function createRecorder(client, config, student) {
  const types = new Set([
    "agent_stream",
    "agent.timeline.replacement",
    "fetch_agent_timeline_response",
    "agent_permission_request",
    "agent_permission_resolved",
  ]);
  let selected = null;
  let subscription = null;
  const stop = client.subscribeRawMessages((message) => {
    const agentId = message.payload?.agentId;
    if (
      !types.has(message.type) ||
      ![student.agentId, ...(student.ownedConversationIds || [])].includes(agentId)
    )
      return;
    appendFileSync(
      join(config.recordsDir, `${student.id}.events.jsonl`),
      JSON.stringify({ recordedAt: new Date().toISOString(), studentId: student.id, message }) +
        "\n",
      { mode: 0o600 },
    );
  });
  return {
    async select(agentId) {
      if (selected === agentId && subscription) return;
      if (subscription) await subscription.release();
      subscription = null;
      selected = agentId;
      if (agentId === "new") return;
      subscription = client.subscribeAgentTimeline(agentId, () => {});
      await subscription.ready;
    },
    async close() {
      stop();
      if (subscription) await subscription.release();
    },
  };
}
