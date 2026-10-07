import { expect, test, vi } from "vitest";
import { AgentManager } from "./agent-manager.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
import type {
  AgentClient,
  AgentSession,
  AgentSessionConfig,
  AgentLaunchContext,
  AgentPersistenceHandle,
} from "./agent-sdk-types.js";
import type { PluginLifecycle } from "../plugins/lifecycle/index.js";

const config = (): AgentSessionConfig => ({
  provider: "claude",
  cwd: process.cwd(),
  model: "opus",
  providerOptions: { textOnly: true },
});

function fixture(mutate?: (config: AgentSessionConfig) => void) {
  const launches: { config: AgentSessionConfig; context?: AgentLaunchContext }[] = [];
  const capabilities = {
    supportsStreaming: false,
    supportsSessionPersistence: true,
    supportsSessionListing: false,
    supportsDynamicModes: false,
    supportsMcpServers: true,
    supportsNativePaseoTools: true,
    supportsReasoningStream: false,
    supportsToolInvocations: false,
  };
  function session(c: AgentSessionConfig): AgentSession {
    return {
      provider: "claude",
      id: "synthetic-managed-session",
      capabilities,
      subscribe: () => () => undefined,
      getRuntimeInfo: () => null,
      describePersistence: () => ({
        provider: "claude",
        sessionId: "synthetic-managed-session",
        metadata: c,
      }),
      getPendingPermissions: () => [],
      close: async () => undefined,
    } as unknown as AgentSession;
  }
  const createSession = vi.fn(async (c: AgentSessionConfig, context?: AgentLaunchContext) => {
    launches.push({ config: c, context });
    return session(c);
  });
  const resumeSession = vi.fn(
    async (
      _handle: AgentPersistenceHandle,
      c: AgentSessionConfig,
      context?: AgentLaunchContext,
    ) => {
      launches.push({ config: c, context });
      return session(c);
    },
  );
  const client = {
    provider: "claude",
    capabilities,
    createSession,
    resumeSession,
    isAvailable: vi.fn(async () => true),
    fetchCatalog: vi.fn(async () => ({ models: [], modes: [] })),
  } as unknown as AgentClient;
  const before = vi.fn(async (name: string, request: { config?: AgentSessionConfig }) => {
    if (name === "agent.create" && request.config) mutate?.(request.config);
    return request;
  });
  const nativeCatalog = vi.fn(() => ({
    tools: new Map(),
    getTool: () => undefined,
    executeTool: async () => {
      throw Error("Synthetic catalog has no executable tools");
    },
  }));
  const manager = new AgentManager({
    logger: createTestLogger(),
    clients: { claude: client },
    pluginLifecycle: { before, emit: vi.fn() } as unknown as PluginLifecycle,
    paseoToolsEnabled: true,
    mcpBaseUrl: "http://synthetic.invalid/mcp",
    mcpAuthToken: "SYNTHETIC-NOT-A-CREDENTIAL",
    paseoToolCatalogFactory: nativeCatalog,
  });
  return { manager, launches, before, createSession, resumeSession, nativeCatalog };
}

test("text-only managed create and resume remain visible with no MCP or native catalog", async () => {
  const f = fixture();
  const created = await f.manager.createAgent(config(), undefined, {
    workspaceId: "synthetic-workspace",
  });
  expect(created.internal).toBe(false);
  expect(f.manager.listAgents().map((agent) => agent.id)).toContain(created.id);
  expect(f.before.mock.calls.map((call) => call[0])).toEqual([
    "agent.create",
    "agent.session_open",
  ]);
  expect(f.launches[0].config.mcpServers).toBeUndefined();
  expect(f.launches[0].context?.paseoTools).toBeUndefined();
  expect(f.manager.getPaseoToolPolicy(created.id)).toEqual({ enabled: false });
  expect(f.nativeCatalog).not.toHaveBeenCalled();
  const resumed = await f.manager.resumeAgentFromPersistence({
    provider: "claude",
    sessionId: "synthetic-other-session",
    metadata: { ...config(), claudeTextOnly: true },
  });
  expect(resumed.internal).toBe(false);
  expect(f.launches[1].config.mcpServers).toBeUndefined();
  expect(f.launches[1].context?.paseoTools).toBeUndefined();
  expect(f.nativeCatalog).not.toHaveBeenCalled();
});

test.each([
  (c: AgentSessionConfig) => {
    c.providerOptions = {};
  },
  (c: AgentSessionConfig) => {
    c.providerOptions = { textOnly: true, extraArgs: { tools: "Read" } };
  },
  (c: AgentSessionConfig) => {
    c.mcpServers = { foreign: { type: "stdio", command: "forbidden" } };
  },
  (c: AgentSessionConfig) => {
    c.toolPolicy = { preapproved: [] };
  },
])(
  "normal before-create capacity hook runs; incompatible plugin mutation is rejected",
  async (mutate) => {
    const f = fixture(mutate);
    await expect(
      f.manager.createAgent(config(), undefined, { workspaceId: "synthetic-workspace" }),
    ).rejects.toThrow("text-only");
    expect(f.before.mock.calls.map((call) => call[0])).toEqual(["agent.create"]);
    expect(f.createSession).not.toHaveBeenCalled();
    expect(f.nativeCatalog).not.toHaveBeenCalled();
  },
);

test("a capacity refusal remains authoritative for text-only creation", async () => {
  const f = fixture();
  f.before.mockRejectedValueOnce(Error("synthetic capacity hold"));
  await expect(
    f.manager.createAgent(config(), undefined, { workspaceId: "synthetic-workspace" }),
  ).rejects.toThrow("capacity hold");
  expect(f.createSession).not.toHaveBeenCalled();
});

test("session-open plugin cannot erase a retained creation seal", async () => {
  const f = fixture();
  let retained: AgentSessionConfig;
  f.before.mockImplementation(async (name, request) => {
    if (name === "agent.create") retained = request.config!;
    if (name === "agent.session_open") delete retained.providerOptions!.textOnly;
    return request;
  });
  await expect(
    f.manager.createAgent(config(), undefined, { workspaceId: "synthetic-workspace" }),
  ).rejects.toThrow("text-only");
  expect(f.createSession).not.toHaveBeenCalled();
});

test("sealed reload and persistence override cannot remove restriction before provider open", async () => {
  const f = fixture();
  const created = await f.manager.createAgent(config(), undefined, {
    workspaceId: "synthetic-workspace",
  });
  await expect(f.manager.reloadAgentSession(created.id, { providerOptions: {} })).rejects.toThrow(
    "text-only",
  );
  await expect(
    f.manager.resumeAgentFromPersistence(
      {
        provider: "claude",
        sessionId: "synthetic",
        metadata: { ...config(), claudeTextOnly: true },
      },
      { providerOptions: undefined },
    ),
  ).rejects.toThrow("text-only");
  expect(f.resumeSession).not.toHaveBeenCalled();
  expect(f.createSession).toHaveBeenCalledTimes(1);
});

test("ordinary Claude still receives native tools and normal creation hooks", async () => {
  const f = fixture();
  const c = config();
  delete c.providerOptions;
  await f.manager.createAgent(c, undefined, { workspaceId: "synthetic-workspace" });
  expect(f.nativeCatalog).toHaveBeenCalledTimes(1);
  expect(f.launches[0].context?.paseoTools).toEqual(f.nativeCatalog.mock.results[0].value);
  expect(f.before.mock.calls.map((call) => call[0])).toEqual([
    "agent.create",
    "agent.session_open",
  ]);
});

test("private exact observation preserves actual manager owner and mandatory creation guard", async () => {
  const f = fixture();
  const created = await f.manager.createAgent(config(), undefined, {
    workspaceId: "synthetic-workspace",
  });
  const observed = await f.manager.observeConceptAgent(created.id);
  expect(observed).toMatchObject({
    id: created.id,
    manager_generation: f.manager.conceptOwnerGeneration,
    visible: true,
    internal: false,
    workspaceId: "synthetic-workspace",
  });
  expect(observed?.runtimeInfo).toBeNull(); // No actual native observation manufactured.
  expect(f.before.mock.calls.map((call) => call[0])).toEqual([
    "agent.create",
    "agent.session_open",
  ]);
  const ordinary = await f.manager.createAgent(
    { provider: "claude", cwd: process.cwd() },
    undefined,
    {},
  );
  expect(await f.manager.observeConceptAgent(ordinary.id)).toBeNull();
  expect(await f.manager.observeConceptAgent("foreign")).toBeNull();
});
