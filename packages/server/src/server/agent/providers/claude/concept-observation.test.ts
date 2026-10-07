// SOURCE_ONLY fake SDK and EventEmitter child handles. No native or OS probe.
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, expect, test, vi } from "vitest";
import { ConceptObservation, safeClaudeSpawn } from "./concept-observation.js";
import { claudeQuery, type ClaudeQueryInput } from "./query.js";
import { ClaudeAgentClient } from "./agent.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import * as spawnUtils from "../../../../utils/spawn.js";
vi.mock("./project-dir.js", () => ({
  claudeConfigDir: () => "/synthetic-no-state",
  claudeProjectDirSync: () => "/synthetic-no-state/projects",
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: () => {
    throw Error("Real SDK fork forbidden");
  },
  query: () => {
    throw Error("Real SDK forbidden");
  },
}));
vi.mock("../../../../utils/tree-kill.js", () => ({
  terminateWithTreeKill: vi.fn(async () => ({ exited: true })),
}));
afterEach(() => vi.restoreAllMocks());
function child(pid = 123) {
  return Object.assign(new EventEmitter(), {
    pid,
    stdin: new EventEmitter(),
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  }) as unknown as ChildProcess;
}
const init = () => ({
  type: "system",
  subtype: "init",
  session_id: "synthetic-native",
  model: "opus",
  permissionMode: "default",
  tools: [],
  mcp_servers: [],
  plugins: [],
  slash_commands: [],
  skills: [],
});
function observed() {
  const o = new ConceptObservation(),
    token = o.beginQuery(),
    process = child();
  o.spawned(token, process, "/synthetic/node", ["--tools", "", "--disable-slash-commands"]);
  o.initialized(init());
  return { o, token, process };
}
test("before real spawn/init stays unknown; missing and malformed catalogs are retained", () => {
  const o = new ConceptObservation();
  expect(o.snapshot().init).toBeNull();
  o.beginQuery();
  o.initialized(init());
  expect(o.snapshot().init).toBeNull();
  const f = observed();
  const partial = init();
  delete (partial as Partial<typeof partial>).tools;
  f.o.initialized(partial);
  expect((f.o.snapshot().init?.catalogs as Record<string, unknown> | undefined)?.tools).toEqual({
    status: "unknown",
    raw: null,
  });
  f.o.initialized({ ...init(), tools: "bad" });
  expect((f.o.snapshot().init?.catalogs as Record<string, unknown> | undefined)?.tools).toEqual({
    status: "malformed",
    raw: null,
  });
});
test("raw nonempty catalogs survive, but prompt/env/auth fields never enter observation", () => {
  const f = observed();
  f.o.initialized({
    ...init(),
    tools: ["Read"],
    mcp_servers: [{ name: "foreign", status: "connected" }],
    plugins: [{ name: "foreign", path: "/synthetic/plugin", version: "1" }],
    apiKeySource: "SECRET",
    prompt: "SECRET",
  });
  expect(JSON.stringify(f.o.snapshot())).not.toContain("SECRET");
  expect(f.o.snapshot().init?.catalogs).toMatchObject({
    tools: { raw: ["Read"] },
    plugins: { raw: [{ name: "foreign", path: "/synthetic/plugin", version: "1" }] },
  });
  expect(
    safeClaudeSpawn("/synthetic/node", [
      "--prompt",
      "SECRET",
      "--settings",
      "SECRET",
      "--tools",
      "",
    ]),
  ).toEqual({
    command: "/synthetic/node",
    controls: { "--tools": "" },
    redacted_arguments: 4,
    truncated: false,
  });
});
test("query replacement, old child exit and native drift cannot refresh current evidence", () => {
  const f = observed(),
    old = f.o.snapshot(),
    next = f.o.beginQuery();
  f.o.spawned(f.token, child(44), "old", []);
  expect(f.o.snapshot().spawn).toBeNull();
  f.o.spawned(next, child(456), "current", []);
  f.o.initialized(init());
  f.process.emit("exit", 0);
  expect(f.o.snapshot().spawn?.pid).toBe(456);
  expect(f.o.snapshot().query_incarnation).not.toBe(old.query_incarnation);
  f.o.initialized({ ...init(), session_id: "replacement-native" });
  expect(f.o.snapshot().init).toBeNull();
  expect(f.o.snapshot().spawn).toBeNull();
});
test("real same-query result settles delivered input; synthetic cancel alone cannot", () => {
  const f = observed();
  f.o.delivered("delivery-1");
  expect(f.o.snapshot().delivery.terminal).toBe(false);
  f.o.message("old-query", { type: "result" });
  expect(f.o.snapshot().delivery.terminal).toBe(false);
  f.o.message(f.token, { type: "result" });
  expect(f.o.snapshot().delivery.terminal).toBe(false);
  f.o.message(f.token, { type: "user", uuid: "delivery-1" });
  f.o.message(f.token, { type: "result", session_id: "synthetic-native" });
  expect(f.o.snapshot().delivery).toEqual({ pending: 0, active: false, terminal: true });
  f.process.emit("exit", 0);
  expect(f.o.snapshot().delivery.terminal).toBeNull();
});
test("final resolved SDK spawn boundary is observed using only a fake process", () => {
  const spawn = vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child());
  const onConceptSpawn = vi.fn();
  let options: ClaudeQueryInput["options"] | undefined;
  claudeQuery(
    { prompt: "unused", options: {} },
    {
      textOnly: true,
      onConceptSpawn,
      queryFactory: (input) => {
        options = input.options;
        return {} as Query;
      },
    },
  );
  options!.spawnClaudeCodeProcess!({
    command: "/synthetic/native",
    args: ["--tools", ""],
    cwd: "/synthetic",
    env: { TOKEN: "SECRET" },
    signal: new AbortController().signal,
  });
  expect(onConceptSpawn).toHaveBeenCalledWith(spawn.mock.results[0].value, "/synthetic/native", [
    "--tools",
    "",
  ]);
  expect(JSON.stringify(onConceptSpawn.mock.calls)).not.toContain("SECRET");
});
test("sealed runtime info bypasses stale cache without starting a query; ordinary stays unchanged", async () => {
  const queryFactory = vi.fn(() => {
    throw Error("No query authorized");
  });
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary: async () => "/synthetic/unused",
  });
  const session = await client.createSession({
    provider: "claude",
    cwd: "/synthetic",
    providerOptions: { textOnly: true },
  });
  const internals = session as unknown as {
    cachedRuntimeInfo: unknown;
    conceptObservation: ConceptObservation;
  };
  internals.cachedRuntimeInfo = { provider: "claude", sessionId: "old", model: "old" };
  expect(await session.getRuntimeInfo()).toMatchObject({
    sessionId: null,
    model: null,
    extra: { conceptText: { spawn: null, init: null } },
  });
  expect(queryFactory).not.toHaveBeenCalled();
  const ordinary = await client.createSession({ provider: "claude", cwd: "/synthetic" });
  expect((await ordinary.getRuntimeInfo()).extra?.conceptText).toBeUndefined();
  await session.close();
  await ordinary.close();
});

test("actual provider glue observes only the current fake query init and terminal, never historical init", async () => {
  vi.spyOn(spawnUtils, "spawnProcess").mockReturnValue(child());
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    resolveBinary: async () => "/synthetic/unused",
    queryFactory: (input) => {
      input.options.spawnClaudeCodeProcess!({
        command: "/synthetic/native",
        args: ["--tools", ""],
        cwd: "/synthetic",
        env: {},
        signal: new AbortController().signal,
      });
      const incoming = (input.prompt as AsyncIterable<{ uuid?: string }>)[Symbol.asyncIterator]();
      let stage = 0,
        release: ((value: IteratorResult<unknown>) => void) | undefined;
      return {
        next: async () => {
          if (stage++ === 0) return { done: false, value: init() };
          if (stage === 2)
            return {
              done: false,
              value: {
                type: "user",
                uuid: (await incoming.next()).value?.uuid,
                session_id: "synthetic-native",
                message: { content: [] },
              },
            };
          if (stage === 3)
            return {
              done: false,
              value: {
                type: "result",
                subtype: "success",
                session_id: "synthetic-native",
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
  const session = await client.createSession({
    provider: "claude",
    cwd: "/synthetic",
    providerOptions: { textOnly: true },
  });
  try {
    await session.startTurn("SOURCE_ONLY secret actor text");
    await vi.waitFor(async () =>
      expect((await session.getRuntimeInfo()).extra?.conceptText).toMatchObject({
        init: {
          native_session_id: "synthetic-native",
          catalogs: { tools: { status: "observed", raw: [] } },
        },
        delivery: { active: false, terminal: true },
      }),
    );
    const current = await session.getRuntimeInfo();
    expect(JSON.stringify(current)).not.toContain("secret actor text");
    const internal = session as unknown as { handleSystemMessage: (value: unknown) => void };
    internal.handleSystemMessage({ ...init(), tools: ["HistoricalRead"] });
    expect(((await session.getRuntimeInfo()).extra!.conceptText as { init: unknown }).init).toEqual(
      (current.extra!.conceptText as { init: unknown }).init,
    );
  } finally {
    await session.close();
  }
});
