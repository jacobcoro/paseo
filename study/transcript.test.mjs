import test from "node:test";
import assert from "node:assert/strict";
import { mergeTranscript } from "./transcript.mjs";

test("research history survives provider reset and reused sequence numbers", () => {
  const first = {
    provider: "mock",
    timestamp: "2026-10-04T07:00:00Z",
    seqStart: 1,
    item: { type: "user_message", messageId: "old", text: "Old prompt" },
  };
  const second = {
    ...first,
    timestamp: "2026-10-04T08:00:00Z",
    item: { ...first.item, messageId: "new", text: "New prompt" },
  };
  assert.deepEqual(mergeTranscript([first], []), [first]);
  assert.deepEqual(mergeTranscript([first], [second]), [first, second]);
  assert.deepEqual(mergeTranscript([first, second], [second]), [first, second]);
});

test("current assistant content replaces the saved partial response", () => {
  const partial = {
    provider: "mock",
    timestamp: "2026-10-04T07:00:00Z",
    item: { type: "assistant_message", messageId: "answer", text: "Partial" },
  };
  const complete = { ...partial, item: { ...partial.item, text: "Complete" } };
  assert.deepEqual(mergeTranscript([partial], [complete]), [complete]);
});
