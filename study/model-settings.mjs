import { z } from "zod";

export const ModelSettingsInput = z
  .object({
    agentId: z.string().min(1),
    modelId: z.string().min(1).max(200),
    thinkingOptionId: z.string().min(1).max(80),
  })
  .strict();

export function studentModels(models) {
  return models
    .filter((model) => model.provider === "codex" && !/astra/i.test(model.id + " " + model.label))
    .map((model) => ({
      id: model.id,
      label: model.label,
      thinkingOptions: (model.thinkingOptions || []).map(({ id, label }) => ({ id, label })),
      defaultThinkingOptionId: model.defaultThinkingOptionId || null,
    }));
}

export function validModelSettings(input, models) {
  const parsed = ModelSettingsInput.safeParse(input);
  if (!parsed.success) return false;
  const model = studentModels(models).find((item) => item.id === parsed.data.modelId);
  return Boolean(model?.thinkingOptions.some((item) => item.id === parsed.data.thinkingOptionId));
}

export function conversationSettings(agent) {
  return { modelId: agent.model, thinkingOptionId: agent.thinkingOptionId };
}
