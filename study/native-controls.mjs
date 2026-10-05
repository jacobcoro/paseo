import { z } from "zod";
import { studyAgentConfig, studyModel, studyReasoning } from "./chat-profile.mjs";
import { validImages } from "./images.mjs";
import { studentModels, validModelSettings } from "./model-settings.mjs";

const Creation = z
  .object({
    workspaceId: z.string(),
    config: z
      .object({
        provider: z.literal("codex"),
        cwd: z.literal("/workspace"),
        model: z.string().optional(),
        thinkingOptionId: z.string().optional(),
      })
      .passthrough(),
    initialPrompt: z.string().min(1).max(32000),
    idempotencyKey: z.string().min(1).max(512),
    clientMessageId: z.string().max(512).optional(),
    agentId: z.uuid().optional(),
    images: z.array(z.unknown()).optional(),
    attachments: z.array(z.unknown()).optional(),
  })
  .passthrough();

// Native UI owns drafts, tabs and model selection. Only the trusted study profile
// reaches the daemon; client-supplied tools, environment and worktrees do not.
export function nativeCreation(request, student, models) {
  const input = Creation.parse(request);
  if (
    input.workspaceId !== student.workspaceId ||
    input.attachments?.length ||
    !validImages(input.images)
  )
    throw Error("This chat or attachment is unavailable");
  const modelId = input.config.model || studyModel;
  const model = studentModels(models).find((item) => item.id === modelId);
  const thinkingOptionId =
    input.config.thinkingOptionId ||
    (model?.thinkingOptions.some((item) => item.id === studyReasoning)
      ? studyReasoning
      : model?.defaultThinkingOptionId);
  if (!validModelSettings({ agentId: "new", modelId, thinkingOptionId }, models))
    throw Error("This model or reasoning level is unavailable. Astra is blocked.");
  return {
    workspaceId: student.workspaceId,
    idempotencyKey: input.idempotencyKey,
    ...(input.agentId ? { agentId: input.agentId } : {}),
    config: { ...studyAgentConfig(), model: modelId, thinkingOptionId },
    initialPrompt: input.initialPrompt,
    clientMessageId: input.clientMessageId,
    ...(input.images ? { images: input.images } : {}),
    labels: { "study.student": student.id, "study.conversation": "true" },
  };
}

// Keep the native wire shapes and full model metadata. Filter only capabilities
// students cannot select; both the full and compact native catalogs are covered.
export function filterStudentResponse(message) {
  const payload = message.payload;
  if (!payload) return message;
  function models(items) {
    return items?.filter((item) => !/astra/i.test(item.id + " " + item.label));
  }
  function providers(entries) {
    return entries
      ?.filter((item) => item.provider === "codex")
      .map((item) =>
        Object.assign({}, item, { models: models(item.models), modes: [], defaultModeId: null }),
      );
  }
  if (message.type === "list_available_providers_response")
    payload.providers = payload.providers?.filter((item) => item.provider === "codex");
  if (message.type === "list_provider_models_response")
    payload.models = payload.provider === "codex" ? models(payload.models) : [];
  if (message.type === "list_provider_modes_response") payload.modes = [];
  if (message.type === "list_provider_features_response") payload.features = [];
  if (
    message.type === "get_providers_snapshot_response" ||
    message.type === "providers_snapshot_update"
  ) {
    payload.entries = providers(payload.entries);
    if (payload.compactSnapshot)
      payload.compactSnapshot.entries = providers(payload.compactSnapshot.entries);
    delete payload.snapshotHash;
    delete payload.notModified;
  }
  function removeFeatures(value) {
    if (!value || typeof value !== "object") return;
    if (value.provider === "codex" && typeof value.id === "string" && "status" in value) {
      value.features = [];
      value.availableModes = [];
    }
    for (const child of Object.values(value)) if (typeof child === "object") removeFeatures(child);
  }
  removeFeatures(payload);
  return message;
}

export function savedTimeline(request, entries, agent) {
  const epoch = "study-saved-" + request.agentId;
  const direction = request.direction || (request.cursor ? "after" : "tail");
  const limit = Math.min(request.limit || 200, 200);
  const candidates = entries.filter((entry) => {
    if (direction === "before") return entry.seqEnd < request.cursor?.seq;
    if (direction === "after") return entry.seqStart > (request.cursor?.seq || 0);
    return true;
  });
  const selected = direction === "after" ? candidates.slice(0, limit) : candidates.slice(-limit);
  const start = selected[0]?.seqStart ?? null;
  const end = selected.at(-1)?.seqEnd ?? null;
  return {
    type: "fetch_agent_timeline_response",
    payload: {
      requestId: request.requestId,
      agentId: request.agentId,
      agent,
      direction,
      projection: "canonical",
      epoch,
      reset: !request.cursor || request.cursor.epoch !== epoch,
      staleCursor: false,
      gap: false,
      window: {
        minSeq: entries[0]?.seqStart || 0,
        maxSeq: entries.at(-1)?.seqEnd || 0,
        nextSeq: (entries.at(-1)?.seqEnd || 0) + 1,
      },
      startCursor: start === null ? null : { epoch, seq: start },
      endCursor: end === null ? null : { epoch, seq: end },
      hasOlder: start !== null && entries.some((entry) => entry.seqEnd < start),
      hasNewer: end !== null && entries.some((entry) => entry.seqStart > end),
      entries: selected,
      error: null,
    },
  };
}
