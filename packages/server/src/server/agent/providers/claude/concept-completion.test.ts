// SOURCE_ONLY: REAL provider/manager mapping, fake SDK iterator/child and durable API.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
import { ConceptCompletion } from "./concept-completion.js";
import { AgentManager } from "../../agent-manager.js";
import type { AgentTimelineStore, AgentTimelineRow } from "../../agent-timeline-store-types.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
vi.mock("./project-dir.js", () => ({
  claudeConfigDir: () => "/synthetic",
  claudeProjectDirSync: () => "/synthetic/projects",
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: () => {
    throw Error("Real SDK forbidden");
  },
  query: () => {
    throw Error("Real SDK forbidden");
  },
}));
vi.mock("../../../../utils/tree-kill.js", () => ({
  terminateWithTreeKill: vi.fn(async () => ({ exited: true })),
}));
afterEach(() => vi.restoreAllMocks());
async function fixture(kind = "success") {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcess;
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child);
  let inputUuid: string | undefined,
    release: ((value: IteratorResult<unknown>) => void) | undefined;
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/synthetic/unused",
    queryFactory: (input) => {
      input.options.spawnClaudeCodeProcess!({
        command: "/synthetic/native",
        args: [],
        env: {},
        cwd: "/synthetic",
        signal: new AbortController().signal,
      });
      const incoming = (input.prompt as AsyncIterable<{ uuid?: string }>)[Symbol.asyncIterator]();
      let stage = 0;
      return {
        next: async () => {
          if (stage++ === 0)
            return {
              done: false,
              value: {
                type: "system",
                subtype: "init",
                session_id: "native",
                model: "opus",
                permissionMode: "default",
                tools: [],
                mcp_servers: [],
                plugins: [],
                slash_commands: [],
                skills: [],
              },
            };
          if (stage === 2) {
            inputUuid = (await incoming.next()).value?.uuid;
            return {
              done: false,
              value: {
                type: "user",
                uuid: kind === "missingecho" ? "foreign" : inputUuid,
                session_id: "native",
                parent_tool_use_id: null,
                isSynthetic: kind === "synthetic",
                isReplay: kind === "replay",
                message: { role: "user", content: [] },
              },
            };
          }
          if (stage === 3 && ["streamed", "ordinary"].includes(kind))
            return {
              done: false,
              value: {
                type: "assistant",
                uuid: "actual-assistant-uuid",
                session_id: "native",
                parent_tool_use_id: null,
                message: {
                  id: "actual-message",
                  role: "assistant",
                  model: "opus",
                  type: "message",
                  stop_reason: "end_turn",
                  stop_sequence: null,
                  usage: { input_tokens: 1, output_tokens: 1 },
                  content: [{ type: "text", text: "STREAMED PREFIX" }],
                },
              },
            };
          if (stage === 3 || (stage === 4 && ["streamed", "ordinary"].includes(kind)))
            return {
              done: false,
              value: {
                type: "result",
                uuid: "actual-result-uuid",
                session_id: kind === "drift" ? "foreign" : "native",
                subtype: kind === "failed" ? "error_during_execution" : "success",
                is_error: kind === "iserror",
                result: "VISIBLE FINAL",
                usage: { input_tokens: 1, output_tokens: 1 },
                total_cost_usd: 0,
              },
            };
          return new Promise((resolve) => {
            release = resolve;
          });
        },
        close: () => release?.({ done: true, value: undefined }),
        return: async () => ({ done: true, value: undefined }),
        interrupt: async () => undefined,
        [Symbol.asyncIterator]() {
          return this;
        },
      } as unknown as Query;
    },
  });
  vi.spyOn(client, "isAvailable").mockResolvedValue(true);
  vi.spyOn(client, "fetchCatalog").mockResolvedValue({ models: [], modes: [] });
  const rows = new Map<number, AgentTimelineRow>();
  let committed = true;
  const store = {
    deleteAgent: async () => {
      rows.clear();
    },
    getLatestCommittedSeq: async () => 0,
    getCommittedRows: async () =>
      committed ? [...rows.values()].map((row) => structuredClone(row)) : [],
    bulkInsert: async (_id: string, entries: AgentTimelineRow[]) => {
      for (const row of entries) rows.set(row.seq, structuredClone(row));
    },
    updateCommittedRow: async (_id: string, row: AgentTimelineRow) => {
      rows.set(row.seq, structuredClone(row));
    },
  } as unknown as AgentTimelineStore;
  const manager = new AgentManager({
    logger: createTestLogger(),
    clients: { claude: client },
    durableTimelineStore: store,
  });
  const agent = await manager.createAgent(
    {
      provider: "claude",
      cwd: process.cwd(),
      model: "opus",
      modeId: "default",
      providerOptions: kind === "ordinary" ? undefined : { textOnly: true },
    },
    undefined,
    { workspaceId: "synthetic-workspace" },
  );
  try {
    await manager.runAgent(agent.id, "SECRET PROMPT", { clientMessageId: "actual-client-id" });
  } catch (error) {
    if (["success", "streamed", "ordinary"].includes(kind)) throw error; // A positive fixture must actually complete.
  }
  const observe = () => manager.observeConceptAgent(agent.id);
  return {
    manager,
    agent,
    rows,
    observe,
    inputUuid,
    hold: () => {
      committed = false;
    },
    release: () => {
      committed = true;
    },
    child,
    close: () => manager.closeAgent(agent.id),
  };
}
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
