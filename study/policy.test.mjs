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

test("student direct agent creation and model controls remain blocked", () => {
  assert.equal(
    studentMessage(request("create_agent_request", { workspaceId: student.workspaceId }), student),
    null,
  );
  assert.equal(
    studentMessage(
      request("set_agent_model_request", { agentId: "primary", model: "other" }),
      student,
    ),
    null,
  );
  assert.equal(
    studentMessage(request("create_terminal_request", { agentId: "primary" }), student),
    null,
  );
});
