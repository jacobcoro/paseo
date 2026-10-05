import test from "node:test";
import assert from "node:assert/strict";
import { researchSession } from "./research-session.mjs";

test("research links select exactly one recorded session and its prompt images, generated images and annotations", () => {
  const entry = {
    item: { type: "assistant_message", text: "![design](/workspace/design.png)", messageId: "m1" },
  };
  const data = {
    studentId: "s01",
    entries: [entry],
    conversations: [
      { agentId: "a1", entries: [entry] },
      { agentId: "a2", entries: [] },
    ],
    submittedImages: [
      { agentId: "a1", id: "own" },
      { agentId: "a2", id: "other" },
      { clientMessageId: "m1", id: "legacy" },
    ],
    generatedImages: [
      { id: "generated", sources: ["/workspace/design.png"] },
      { id: "other", sources: ["/workspace/other.png"] },
    ],
    annotations: [{ agentId: "a1" }, { agentId: "a2" }],
    settingChanges: [{ agentId: "a1" }, { agentId: "a2" }],
  };
  const selected = researchSession(data, "a1");
  assert.equal(selected.studentId, "s01");
  assert.deepEqual(
    selected.conversations.map((c) => c.agentId),
    ["a1"],
  );
  assert.deepEqual(
    selected.submittedImages.map((i) => i.id),
    ["own", "legacy"],
  );
  assert.deepEqual(
    selected.generatedImages.map((i) => i.id),
    ["generated"],
  );
  assert.equal(selected.annotations.length, 1);
  assert.equal(selected.settingChanges.length, 1);
  assert.equal(researchSession(data, "unowned"), null);
  assert.equal(data.conversations.length, 2);
});
