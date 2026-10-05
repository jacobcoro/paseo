import { assistantImageReferences } from "./outputs.mjs";

// Use Paseo's unchanged Copy agent ID action. Session links resolve only after
// researcher authentication and only against recorded student-owned sessions.
export function researchSession(data, agentId) {
  const conversation = data.conversations?.find((item) => item.agentId === agentId);
  if (!conversation) return null;
  const messageIds = new Set(
    conversation.entries
      .flatMap((entry) => [entry.item.messageId, entry.item.clientMessageId])
      .filter(Boolean),
  );
  const imageSources = new Set(assistantImageReferences(conversation.entries));
  return {
    ...data,
    agentId,
    entries: conversation.entries,
    conversations: [conversation],
    submittedImages: data.submittedImages.filter(
      (image) => image.agentId === agentId || messageIds.has(image.clientMessageId),
    ),
    generatedImages: data.generatedImages.filter((image) =>
      image.sources.some((source) => imageSources.has(source)),
    ),
    annotations: data.annotations.filter((record) => record.agentId === agentId),
    settingChanges: data.settingChanges.filter((record) => record.agentId === agentId),
  };
}
