import { z } from "zod";
import { validImages } from "./images.mjs";

export const Annotation = z
  .object({
    promptId: z.string().min(1).max(200),
    phase: z.enum(["Discover", "Define", "Develop", "Deliver"]),
    task: z.string().trim().min(1).max(2000),
    purpose: z.string().max(2000),
    nextAction: z.string().trim().min(1).max(4000),
    modified: z.enum(["yes", "no", "not-applicable"]),
    adoption: z.enum(["all", "most", "some", "little", "none", "not-applicable"]),
    finalUse: z.string().max(4000),
  })
  .strict();

// The browser never receives an administrative daemon credential. This allowlist
// is the second boundary after the dedicated student container.
const READS = new Set([
  "session.events.set_subscription.request",
  "fetch_agents_request",
  "fetch_agent_history_request",
  "fetch_agent_request",
  "fetch_workspaces_request",
  "project.list.request",
  "fetch_agent_timeline_request",
  "agent.timeline.set_subscription.request",
  "agent.timeline.search.request",
  "agent.timeline.list_prompts.request",
  "get_providers_snapshot_request",
  "list_available_providers_request",
  "list_provider_models_request",
  "list_provider_modes_request",
  "list_provider_features_request",
  "list_commands_request",
  "daemon.get_status.request",
  "agent.mark_read.request",
  "agent.mark_unread.request",
  "clear_agent_attention",
  "subscribe_agent_request",
  "unsubscribe_agent_request",
  "workspace.subscribe.request",
  "workspace.unsubscribe.request",
  "client_heartbeat",
  "workspace.label.list.request",
  "project.icon.get.request",
  "plugin.catalog.get.request",
  "wait_for_finish_request",
  "subscription.release.request",
]);
const ACTIONS = new Set(["send_agent_message_request", "cancel_agent_request"]);

export function studentMessage(message, student) {
  if (message.type === "hello") {
    return {
      ...message,
      clientType: "browser",
      auth: { kind: "password", password: student.daemonPassword },
    };
  }
  if (message.type === "ping") return message;
  if (message.type !== "session") return null;
  const request = message.message;
  if (!request || !(READS.has(request.type) || ACTIONS.has(request.type))) return null;
  const ownedAgents = ACTIONS.has(request.type)
    ? [student.agentId]
    : [student.agentId, ...(student.historicalAgentIds || [])];
  if (request.agentId && !ownedAgents.includes(request.agentId)) return null;
  if (request.agentIds && request.agentIds.some((id) => !ownedAgents.includes(id))) return null;
  if (request.workspaceId && request.workspaceId !== student.workspaceId) return null;
  if (request.cwd && request.cwd !== "/workspace") return null;
  if (!validAction(request)) return null;
  return message;
}

function validAction(request) {
  if (request.type === "send_agent_message_request") {
    if (typeof request.text !== "string" || request.text.length > 32000) return false;
    // Path-based attachments require their own ownership checks before enabling.
    if (request.attachments?.length || !validImages(request.images)) return false;
  }
  return true;
}
