import test from "node:test";
import assert from "node:assert/strict";
import { ModelSettingsInput, studentModels, validModelSettings } from "./model-settings.mjs";
import { studentMessage } from "./policy.mjs";

const models = [
  {
    provider: "codex",
    id: "gpt-6.1-sol",
    label: "Sol",
    thinkingOptions: [
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ],
  },
  {
    provider: "codex",
    id: "gpt-6-astra",
    label: "Astra",
    thinkingOptions: [{ id: "high", label: "High" }],
  },
  {
    provider: "codex",
    id: "GPT-6.2-ASTRA",
    label: "Future Astra",
    thinkingOptions: [{ id: "high", label: "High" }],
  },
  {
    provider: "codex",
    id: "premium-alias",
    label: "GPT Astra",
    thinkingOptions: [{ id: "high", label: "High" }],
  },
];
const input = { agentId: "primary", modelId: "gpt-6.1-sol", thinkingOptionId: "low" };
test("student settings reject Astra variants and aliases, unknown models, unsupported reasoning and extra capabilities", () => {
  assert.deepEqual(
    studentModels(models).map((model) => model.id),
    ["gpt-6.1-sol"],
  );
  assert.ok(validModelSettings(input, models));
  for (const modelId of [
    "gpt-6-astra",
    "GPT-6.2-ASTRA",
    "premium-alias",
    "unknown",
    "codex/gpt-6-astra",
  ]) {
    assert.equal(validModelSettings({ ...input, modelId }, models), false);
  }
  assert.equal(validModelSettings({ ...input, thinkingOptionId: "ultra" }, models), false);
  assert.equal(
    ModelSettingsInput.safeParse({ ...input, featureValues: { shell_tool: true } }).success,
    false,
  );
});

test("native websocket settings cannot bypass the authenticated model endpoint", () => {
  const student = { agentId: "primary", ownedConversationIds: [], workspaceId: "workspace" };
  for (const type of [
    "set_agent_model_request",
    "set_agent_thinking_request",
    "agent.config.apply.request",
    "set_agent_mode_request",
    "set_agent_feature_request",
  ]) {
    assert.equal(
      studentMessage(
        {
          type: "session",
          message: {
            type,
            agentId: "primary",
            modelId: "gpt-6-astra",
            config: { modelId: "gpt-6-astra" },
          },
        },
        student,
      ),
      null,
    );
  }
});
