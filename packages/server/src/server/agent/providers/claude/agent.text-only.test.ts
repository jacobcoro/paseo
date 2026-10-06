import { afterEach, describe, expect, test, vi } from "vitest";
import type { Query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeAgentClient } from "./agent.js";
import { claudeQuery, type ClaudeQueryInput } from "./query.js";
import { ClaudeProviderOptionsSchema } from "./options.js";
import { createTestLogger } from "../../../../test-utils/test-logger.js";
import type { AgentSessionConfig, AgentPersistenceHandle } from "../../agent-sdk-types.js";

vi.mock("./project-dir.js", () => ({
  claudeConfigDir: () => "/synthetic-no-user-state",
  claudeProjectDirSync: () => "/synthetic-no-user-state/projects",
}));
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  forkSession: () => {
    throw Error("Real SDK fork forbidden in source-only fixtures");
  },
  query: () => {
    throw Error("Real SDK query forbidden in source-only fixtures");
  },
}));

function fixture() {
  const captured: ClaudeQueryInput["options"][] = [];
  const queryFactory = vi.fn((input: ClaudeQueryInput) => {
    captured.push(input.options);
    const events = [
      { type: "system", subtype: "init", session_id: "synthetic-text-session", model: "opus" },
      { type: "assistant", message: { content: "fixture text" } },
      {
        type: "result",
        subtype: "success",
        usage: { input_tokens: 1, output_tokens: 1 },
        total_cost_usd: 0,
      },
    ];
    return {
      next: vi.fn(async () =>
        events.length ? { done: false, value: events.shift() } : { done: true },
      ),
      return: vi.fn(async () => ({ done: true })),
      interrupt: vi.fn(async () => undefined),
      close: vi.fn(),
      setPermissionMode: vi.fn(async () => undefined),
      setModel: vi.fn(async () => undefined),
      supportedCommands: vi.fn(async () => [{ name: "unsafe", description: "fixture" }]),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as unknown as Query;
  });
  const resolveBinary = vi.fn(async () => "/synthetic-never-executed/claude");
  const client = new ClaudeAgentClient({
    logger: createTestLogger(),
    queryFactory,
    resolveBinary,
    resolveVersion: async () => "synthetic",
    defaults: { agents: { fake: { description: "fake", prompt: "fake" } } },
  });
  return { client, captured, queryFactory, resolveBinary };
}

const config = (): AgentSessionConfig => ({
  provider: "claude",
  cwd: process.cwd(),
  model: "opus",
  providerOptions: { textOnly: true },
});
const handle = (): AgentPersistenceHandle => ({
  provider: "claude",
  sessionId: "synthetic-text-session",
  metadata: { ...config(), claudeTextOnly: true },
});

function expectRestricted(options: ClaudeQueryInput["options"]) {
  expect(options).toMatchObject({
    tools: [],
    disallowedTools: ["*"],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    agents: {},
    plugins: [],
    additionalDirectories: [],
    settings: { disableAllHooks: true, autoMemoryEnabled: false },
    hooks: {},
    enableFileCheckpointing: false,
    extraArgs: { "disable-slash-commands": null },
  });
  expect(Object.hasOwn(options, "textOnly")).toBe(false);
  expect(typeof options.systemPrompt).toBe("string");
}

afterEach(() => vi.restoreAllMocks());
describe("Claude fixed text-only source contract (no runtime proof)", () => {
  test("fresh, persisted resume and model/thinking restarts retain the fixed seal", async () => {
    const f = fixture();
    const session = await f.client.createSession(config());
    await session.run("synthetic text");
    expectRestricted(f.captured[0]);
    await expect(
      f.captured[0].canUseTool!(
        "Read",
        {},
        {
          signal: new AbortController().signal,
          toolUseID: "synthetic",
          requestId: "synthetic-request",
        },
      ),
    ).resolves.toEqual({ behavior: "deny", message: "Claude text-only has no tools" });
    const persisted = session.describePersistence();
    expect(persisted?.metadata).toMatchObject({
      claudeTextOnly: true,
      providerOptions: { textOnly: true },
    });
    expect(await session.listCommands!()).toEqual([]);
    await session.setMode("bypassPermissions");
    await session.setModel?.("sonnet");
    await session.setThinkingOption?.("default");
    await session.run("synthetic restart");
    expectRestricted(f.captured[1]);
    await session.close();
    const resumed = await f.client.resumeSession(persisted!);
    await resumed.setMode("default");
    expectRestricted(f.captured[2]);
    expect(f.captured[2].resume).toBe("synthetic-text-session");
    await resumed.close();
  });

  test.each([
    { providerOptions: { textOnly: false } },
    { providerOptions: { textOnly: "true" } },
    { providerOptions: { textOnly: true, allowedTools: ["Read"] } },
    { providerOptions: { textOnly: true, settings: {} } },
    { providerOptions: { textOnly: true, extraArgs: { tools: "Read" } } },
    { toolPolicy: { preapproved: [] } },
    { mcpServers: { foreign: { type: "stdio", command: "forbidden" } } },
    { internal: true },
  ])("rejects conflicting creation before binary or query discovery: %j", async (override) => {
    const f = fixture();
    await expect(
      f.client.createSession({ ...config(), ...override } as AgentSessionConfig),
    ).rejects.toThrow("text-only");
    expect(f.queryFactory).not.toHaveBeenCalled();
    expect(f.resolveBinary).not.toHaveBeenCalled();
  });

  test.each([undefined, {}, { textOnly: false }, { textOnly: true, unknown: true }])(
    "recognized corrupt metadata never loses the seal: %j",
    async (providerOptions) => {
      const f = fixture();
      const h = handle();
      h.metadata = { ...h.metadata, providerOptions };
      await expect(f.client.resumeSession(h)).rejects.toThrow("text-only");
      expect(f.queryFactory).not.toHaveBeenCalled();
    },
  );

  test.each([
    { providerOptions: {} },
    { providerOptions: undefined },
    { toolPolicy: { preapproved: [] } },
    { providerOptions: { textOnly: false } },
  ])("rejects removing or overriding persisted seal: %j", async (override) => {
    const f = fixture();
    await expect(f.client.resumeSession(handle(), override)).rejects.toThrow("text-only");
    expect(f.queryFactory).not.toHaveBeenCalled();
  });

  test("unknown seal version and corrupted option key fail before resume", async () => {
    const f = fixture();
    const h = handle();
    h.metadata = { ...h.metadata, claudeTextOnly: "future" };
    await expect(f.client.resumeSession(h)).rejects.toThrow("text-only");
    expect(f.queryFactory).not.toHaveBeenCalled();
  });

  test("unknown sealed metadata fields deny rather than silently coerce", async () => {
    const f = fixture();
    const h = handle();
    h.metadata = { ...h.metadata, unknownLaunchCapability: true };
    await expect(f.client.resumeSession(h)).rejects.toThrow("text-only");
    expect(f.queryFactory).not.toHaveBeenCalled();
  });

  test("denies non-default command overrides before fake query", async () => {
    const f = fixture();
    expect(() =>
      claudeQuery(
        { prompt: "fixture", options: {} as ClaudeQueryInput["options"] },
        {
          textOnly: true,
          queryFactory: f.queryFactory,
          runtimeSettings: { command: { mode: "append", args: ["--tools=Read"] } },
        },
      ),
    ).toThrow("default provider command");
    const client = new ClaudeAgentClient({
      logger: createTestLogger(),
      queryFactory: f.queryFactory,
      runtimeSettings: { command: { mode: "replace", argv: ["forbidden"] } },
      resolveBinary: f.resolveBinary,
    });
    await expect(client.createSession(config())).rejects.toThrow("default provider command");
    expect(f.queryFactory).not.toHaveBeenCalled();
    expect(f.resolveBinary).not.toHaveBeenCalled();
  });

  test("slash commands, non-text attachments and file rewind reject before query", async () => {
    const f = fixture();
    const session = await f.client.createSession(config());
    await expect(session.startTurn("/rewind")).rejects.toThrow("text-only");
    await expect(
      session.startTurn([{ type: "text", text: "attachment-style input" }]),
    ).rejects.toThrow("text-only");
    await expect(session.revertFiles?.({ messageId: "synthetic" })).rejects.toThrow("text-only");
    expect(f.queryFactory).not.toHaveBeenCalled();
    await session.close();
  });

  test("ordinary Claude keeps default options, hooks, checkpointing and commands", async () => {
    const f = fixture();
    const ordinary = config();
    delete ordinary.providerOptions;
    const session = await f.client.createSession(ordinary);
    await session.setMode("default");
    expect(f.captured[0].settingSources).toEqual(["user", "project", "local"]);
    expect(f.captured[0].enableFileCheckpointing).toBe(true);
    expect(f.captured[0].tools).toBeUndefined();
    expect(f.captured[0].agents).toHaveProperty("fake");
    expect((await session.listCommands!()).map((command) => command.name)).toContain("unsafe");
    expect(ClaudeProviderOptionsSchema.safeParse({ allowedTools: ["Read"] }).success).toBe(true);
    await session.close();
  });
});
