import test from "node:test";
import assert from "node:assert/strict";
import { studentMessage } from "./policy.mjs";

const student = {
  id: "s0101",
  agentId: "primary",
  workspaceId: "workspace-one",
  ownedConversationIds: ["own-chat"],
  historicalAgentIds: ["old-chat"],
  preservedAgentIds: ["preserved-chat"],
};
function request(type, fields = {}) {
  return { type: "session", message: { type, ...fields } };
}

test("student chat actions allow only live conversations owned by that student", () => {
  assert.ok(
    studentMessage(
      request("send_agent_message_request", { agentId: "own-chat", text: "hello" }),
      student,
    ),
  );
  assert.equal(
    studentMessage(
      request("send_agent_message_request", { agentId: "old-chat", text: "hello" }),
      student,
    ),
    null,
  );
  assert.equal(
    studentMessage(
      request("send_agent_message_request", { agentId: "other-student-chat", text: "hello" }),
      student,
    ),
    null,
  );
  assert.equal(
    studentMessage(request("send_agent_message_request", { text: "missing target" }), student),
    null,
  );
  assert.equal(
    studentMessage(request("cancel_agent_request", { agentId: "old-chat" }), student),
    null,
  );
  assert.equal(
    studentMessage(
      request("send_agent_message_request", { agentId: "preserved-chat", text: "hello" }),
      student,
    ),
    null,
  );
  assert.ok(
    studentMessage(request("fetch_agent_timeline_request", { agentId: "preserved-chat" }), student),
  );
});

test("student legacy agent creation and terminal access remain blocked", () => {
  assert.equal(
    studentMessage(request("create_agent_request", { workspaceId: student.workspaceId }), student),
    null,
  );
  assert.equal(
    studentMessage(
      request("set_agent_model_request", { agentId: "other-student", modelId: "other" }),
      student,
    ),
    null,
  );
  assert.equal(
    studentMessage(request("create_terminal_request", { agentId: "primary" }), student),
    null,
  );
});

test("employee producer reconfiguration cannot change the pinned native permission profile", () => {
  const employee = { ...student, profile: "employee-production" };
  for (const type of [
    "set_agent_model_request",
    "set_agent_thinking_request",
    "agent.config.apply.request",
    "set_agent_mode_request",
    "set_agent_feature_request",
  ]) {
    const payload = request(type, {
      agentId: "primary",
      modelId: "gpt-6-astra",
      config: {
        providerOptions: {
          default_permissions: ":unrestricted",
          sandbox_mode: "danger-full-access",
        },
      },
    });
    assert.equal(studentMessage(payload, employee), null);
  }
  assert.ok(
    studentMessage(
      request("send_agent_message_request", {
        agentId: "primary",
        text: "Shorten the first shot.",
      }),
      employee,
    ),
  );
  assert.ok(studentMessage(request("cancel_agent_request", { agentId: "primary" }), employee));
  assert.ok(
    studentMessage(
      request("set_agent_model_request", { agentId: "primary", modelId: "gpt-6.1-sol" }),
      student,
    ),
  );
});
