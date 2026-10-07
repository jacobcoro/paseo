// SOURCE_ONLY: REAL provider/manager mapping, fake SDK iterator/child and durable API.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { vi } from "vitest";
import { ClaudeAgentClient } from "./agent.js";
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
export async function fixture(kind = "success", cwd = process.cwd(), resultText = "VISIBLE FINAL") {
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
                result: resultText,
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
      cwd,
      thinkingOptionId: "high",
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
