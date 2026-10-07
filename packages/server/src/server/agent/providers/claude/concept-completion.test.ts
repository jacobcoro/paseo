// SOURCE_ONLY actual provider/manager glue through the shared fake SDK/child/store fixture.
import { afterEach, expect, test, vi } from "vitest";
import { ConceptCompletion } from "./concept-completion.js";
import { fixture } from "./concept-completion-fixture.js";
afterEach(() => vi.restoreAllMocks());
test("actual native echo/success yields exact committed epoch/cursor/turn/hash without hidden output", async () => {
  const f = await fixture("streamed");
  try {
    await vi.waitFor(async () => expect((await f.observe())?.committed_completion).not.toBeNull());
    const actual = await f.observe();
    expect(actual?.committed_completion).toMatchObject({
      client_message_id: "actual-client-id",
      input_uuid: f.inputUuid,
      result_uuid: "actual-result-uuid",
      final_message_id: "actual-result-uuid",
      provenance: "sdk_success_result",
      committed: true,
    });
    expect(actual?.committed_completion?.epoch).toBeTruthy();
    expect(actual?.committed_completion?.cursor).toBeGreaterThan(
      actual?.committed_completion?.user_cursor ?? 0,
    );
    expect(JSON.stringify(actual)).not.toContain("SECRET PROMPT");
    expect(JSON.stringify(actual)).not.toContain("VISIBLE FINAL");
    f.hold();
    expect((await f.observe())?.committed_completion).toBeNull();
    f.release();
    const final = [...f.rows.values()].find(
      (row) => row.item.type === "assistant_message" && row.item.messageId === "actual-result-uuid",
    )!;
    f.rows.set(final.seq, {
      ...final,
      item: { type: "assistant_message", text: "CHANGED", messageId: "actual-result-uuid" },
    });
    expect((await f.observe())?.committed_completion).toBeNull();
    f.rows.set(final.seq, { ...final, turnId: "foreign" });
    expect((await f.observe())?.committed_completion).toBeNull();
    f.rows.set(final.seq, final);
    f.child.emit("exit", 0);
    expect((await f.observe())?.committed_completion).toBeNull();
  } finally {
    await f.close();
  }
});
test("real provider glue rejects missing native echo, is_error true, failed result and native drift", async () => {
  for (const kind of ["missingecho", "iserror", "failed", "drift", "synthetic", "replay"]) {
    const f = await fixture(kind);
    try {
      expect((await f.observe())?.committed_completion).toBeNull();
    } finally {
      await f.close();
    }
  }
});
test("competing input, canceled observation, old query, missing fields and sidechain remain unknown", () => {
  const c = new ConceptCompletion();
  const echo = { type: "user", uuid: "input", session_id: "native" };
  const result = {
    type: "result",
    uuid: "result",
    session_id: "native",
    subtype: "success",
    is_error: false,
    result: "FINAL",
  };
  const begin = () => {
    c.resetQuery();
    c.begin("input", "client", "turn", "query");
  };
  begin();
  c.observe("query", "native", echo, "turn");
  expect(c.observe("old", "native", result, "turn")).toBeNull();
  c.begin("steer", undefined, undefined, "query");
  expect(c.observe("query", "native", result, "turn")).toBeNull();
  begin();
  c.observe("query", "native", echo, "turn");
  c.invalidate();
  expect(c.observe("query", "native", result, "turn")).toBeNull();
  for (const changed of [
    { ...result, is_error: undefined },
    { ...result, uuid: undefined },
    { ...result, parent_tool_use_id: "sidechain" },
  ]) {
    begin();
    c.observe("query", "native", echo, "turn");
    expect(c.observe("query", "native", changed, "turn")).toBeNull();
  }
});

test("ordinary streamed session retains its rendering without sealed result projection", async () => {
  const f = await fixture("ordinary");
  try {
    const texts = [...f.rows.values()]
      .filter((row) => row.item.type === "assistant_message")
      .map((row) => (row.item.type === "assistant_message" ? row.item.text : ""));
    expect(texts).toContain("STREAMED PREFIX");
    expect(texts).not.toContain("VISIBLE FINAL");
    expect(await f.observe()).toBeNull();
  } finally {
    await f.close();
  }
});
