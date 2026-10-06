import { EventEmitter, once } from "node:events";
import { resolveDaemonVersion } from "../daemon-version.js";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { z } from "zod";
import { DaemonClient } from "../test-utils/daemon-client.js";
import { createTestPaseoDaemon } from "../test-utils/paseo-daemon.js";
import { createTestAgentClient, createTestAgentClients } from "../test-utils/fake-agent-client.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("plugin handlers create workspaces and agents through their Paseo API", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-api-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "paseo-api",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";

const create = defineRpc({
  name: "create",
  input: z.object({ path: z.string() }),
  output: z.object({ workspaceId: z.string(), agentId: z.string() }),
});

const list = defineRpc({
  name: "list",
  input: z.object({}),
  output: z.object({ agentIds: z.array(z.string()) }),
});

const append = defineRpc({
  name: "append",
  input: z.object({ agentId: z.string(), status: z.string() }),
  output: z.object({ seq: z.number(), epoch: z.string() }),
});

export default function contribute(server: PluginServerContext) {
  server.handle(create, async ({ path }, { paseo }) => {
    const workspace = await paseo.workspaces.create({
      source: { kind: "directory", path },
      title: "Plugin workspace",
    });
    const agent = await workspace.agents.create({
      config: { provider: "pi/test" },
      prompt: "Created by a plugin handler",
    });
    return { workspaceId: workspace.id, agentId: agent.id };
  });
  server.handle(list, async (_input, { paseo }) => {
    const result = await paseo.agents.list({ page: { limit: 100 } });
    return { agentIds: result.entries.map((entry) => entry.agent.id) };
  });
  server.handle(append, ({ agentId, status }, { paseo }) =>
    paseo.agents.ref(agentId).timeline.append({
      type: "plugin",
      id: "review-1",
      kind: "review",
      version: 1,
      data: { status },
    }),
  );
  return () => undefined;
}`,
  );

  const daemon = await createTestPaseoDaemon({
    agentClients: { ...createTestAgentClients(), pi: createTestAgentClient("pi") },
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });

  try {
    await client.connect();
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await expect(client.installDirectoryPlugin(pluginDirectory)).resolves.toMatchObject({
      id: "paseo-api",
      status: "running",
    });

    const created = await client.invokePluginRpc("paseo-api", "create", {
      path: workspaceDirectory,
    });

    expect(created).toEqual({
      workspaceId: expect.stringMatching(/^wks_/),
      agentId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    if (typeof created !== "object" || created === null) {
      throw new Error("Plugin returned an invalid creation result");
    }
    const listed = await client.invokePluginRpc("paseo-api", "list", {});
    expect(listed).toEqual({
      agentIds: expect.arrayContaining([Reflect.get(created, "agentId")]),
    });
    const agentId = Reflect.get(created, "agentId");
    await expect(
      client.invokePluginRpc("paseo-api", "append", { agentId, status: "running" }),
    ).resolves.toEqual({ seq: expect.any(Number), epoch: expect.any(String) });
    await client.invokePluginRpc("paseo-api", "append", { agentId, status: "complete" });
    const timeline = await client.fetchAgentTimeline(agentId, { projection: "projected" });
    expect(timeline.entries.filter((entry) => entry.item.type === "plugin")).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({
          type: "plugin",
          id: "review-1",
          pluginId: "paseo-api",
          data: { status: "complete" },
        }),
      }),
    ]);
    await client.removePlugin("paseo-api");
    const workspaces = await client.fetchWorkspaces();
    const agents = await client.fetchAgents();
    expect(workspaces.entries.map((workspace) => workspace.id)).toContain(
      Reflect.get(created, "workspaceId"),
    );
    expect(agents.entries.map((entry) => entry.agent.id)).toContain(
      Reflect.get(created, "agentId"),
    );
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

test("daemon config reload enables and disables configured plugins without restarting", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reload-plugin-"));
  const paseoHomeRoot = await mkdtemp(path.join(tmpdir(), "paseo-reload-home-"));
  const paseoHome = path.join(paseoHomeRoot, ".paseo");
  roots.push(pluginDirectory, paseoHomeRoot);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "reloadable-plugin",
      requirements: { paseo: `>=${resolveDaemonVersion(import.meta.url)}` },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `export default function contribute(server: unknown) {
  void server;
  return () => undefined;
    }`,
  );

  const plugins = {
    "reloadable-plugin": { source: "directory" as const, path: pluginDirectory, enabled: true },
  };
  await mkdir(paseoHome, { recursive: true });
  await writeFile(
    path.join(paseoHome, "config.json"),
    `${JSON.stringify({ version: 1, pluginsEnabled: false, plugins }, null, 2)}\n`,
  );
  const daemon = await createTestPaseoDaemon({
    paseoHomeRoot,
    cleanup: false,
    pluginsEnabled: false,
    plugins,
  });
  const client = new DaemonClient({
    url: `ws://127.0.0.1:${daemon.port}/ws`,
    appVersion: "0.4.0",
  });
  const configPath = path.join(daemon.paseoHome, "config.json");
  const catalogChanges = new EventEmitter();

  async function setPluginsEnabled(enabled: boolean): Promise<void> {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    await writeFile(
      configPath,
      `${JSON.stringify({ ...config, pluginsEnabled: enabled }, null, 2)}\n`,
    );
  }

  try {
    await client.connect();
    // v0.8.0 exposes catalog status through the native event listener API.
    const releaseCatalog = client.on("status", (message) => {
      if (
        message.payload.status === "plugin_catalog_changed" &&
        message.payload.pluginId === "reloadable-plugin"
      ) {
        catalogChanges.emit("changed");
      }
    });
    await expect(client.listPlugins()).resolves.toEqual([
      expect.objectContaining({ id: "reloadable-plugin", status: "disabled" }),
    ]);

    const enabled = once(catalogChanges, "changed");
    await setPluginsEnabled(true);
    await expect(client.reloadDaemonConfig()).resolves.toMatchObject({
      requestId: expect.any(String),
      appliedPaths: expect.arrayContaining(["pluginsEnabled"]),
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await enabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "running" },
    );

    const disabled = once(catalogChanges, "changed");

    await setPluginsEnabled(false);
    await expect(client.reloadDaemonConfig()).resolves.toEqual({
      requestId: expect.any(String),
      appliedPaths: ["pluginsEnabled"],
      restartRequiredPaths: [],
      overrideControlledPaths: [],
    });
    await disabled;
    expect((await client.listPlugins()).find(({ id }) => id === "reloadable-plugin")).toMatchObject(
      { enabled: true, status: "disabled" },
    );
    releaseCatalog();
  } finally {
    await client.close().catch(() => undefined);
    await daemon.close();
  }
}, 60_000);

const ReconnectingPluginStateSchema = z.object({ observations: z.array(z.string()) });

test("plugin APIs and agent observer demand recover after repeated socket closes", async () => {
  const pluginDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-plugin-"));
  const workspaceDirectory = await mkdtemp(path.join(tmpdir(), "paseo-reconnecting-workspace-"));
  roots.push(pluginDirectory, workspaceDirectory);
  await writeFile(
    path.join(pluginDirectory, "paseo-plugin.json"),
    JSON.stringify({
      id: "reconnecting",
      requirements: { paseo: ">=0.8.0" },
    }),
  );
  await writeFile(
    path.join(pluginDirectory, "index.server.ts"),
    `
import { defineRpc } from "@getpaseo/plugin";
import { type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
export default function contribute(server: PluginServerContext) {
  const observations: string[] = [];
  const waiters = new Map<string, () => void>();
  function observed(value: string) {
    observations.push(value);
    waiters.get(value)?.();
    waiters.delete(value);
  }
  let reconnected = Promise.resolve();
  let release = () => {};
  let observing = false;
  server.handle(defineRpc({ name: "observe", input: z.object({ agentId: z.string() }), output: z.null() }), async ({ agentId }, { paseo }) => {
    const offAgents = paseo.agents.subscribe((update) => {
      if (update.kind === "upsert" && update.agent.id === agentId && update.agent.title) {
        observed("metadata:" + update.agent.title);
      }
    });
    const offTimeline = paseo.agents.ref(agentId).timeline.subscribe(({ event }) => {
      if (event.type === "timeline" && event.item.type === "assistant_message") observed("timeline:" + event.item.messageId);
    });
    await offTimeline.ready;
    await paseo.agents.list({ subscribe: { subscriptionId: "observer-metadata" } });
    observing = true;
    release = () => { observing = false; offAgents(); offTimeline(); };
    return null;
  });
  server.handle(defineRpc({ name: "wait", input: z.object({ value: z.string() }), output: z.null() }), async ({ value }) => {
    if (!observations.includes(value)) await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { waiters.delete(value); reject(new Error("Missing " + value + ": " + JSON.stringify(observations))); }, 5000);
      waiters.set(value, () => { clearTimeout(timeout); resolve(); });
    });
    return null;
  });
  server.handle(defineRpc({ name: "state", input: z.object({}), output: z.object({ observations: z.array(z.string()) }) }), () => ({ observations }));
  server.handle(defineRpc({ name: "probe", input: z.object({}), output: z.object({ pid: z.number(), projectIds: z.array(z.string()) }) }), async (_, { paseo }) => {
    await Promise.race([reconnected, new Promise<void>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("Reconnect handshake not received")), 5000);
      reconnected.then(() => clearTimeout(timer));
    })]);
    // v0.8.0 directory subscriptions require an explicit refresh after reconnect.
    // Timeline listener demand is restored by the SDK without re-registering.
    if (observing) await paseo.agents.list({ subscribe: { subscriptionId: "observer-metadata" } });
    return { pid: process.pid, projectIds: (await paseo.projects.list()).projects.map((project) => project.projectId) };
  });
  server.handle(defineRpc({ name: "release", input: z.object({}), output: z.null() }), () => { release(); return null; });
  server.handle(defineRpc({ name: "disconnect", input: z.object({}), output: z.null() }), () => new Promise((resolve) => {
    function closed(message: { type: string }) {
      if (message.type !== "paseo_close") return;
      process.off("message", closed);
      resolve(null);
    }
    process.on("message", closed);
    reconnected = new Promise<void>((connected) => {
      function ready(message: { type: string; data?: unknown }) {
        if (message.type !== "paseo_frame" || typeof message.data !== "string") return;
        const frame = JSON.parse(message.data);
        if (frame.type !== "session" || frame.message.type !== "status" || frame.message.payload.status !== "server_info") return;
        process.off("message", ready);
        connected();
      }
      process.on("message", ready);
    });
    // A real IPC protocol violation closes the current daemon-side session.
    process.send!({ type: "paseo_frame", isBinary: false, data: JSON.stringify({
      type: "hello", clientId: "plugin:reconnecting", clientType: "cli", protocolVersion: 1,
    }) });
  }));
  return () => release();
}`,
  );
  const daemon = await createTestPaseoDaemon();
  const client = new DaemonClient({ url: `ws://127.0.0.1:${daemon.port}/ws` });
  let projectId: string | undefined;
  try {
    await client.connect();
    const opened = await client.openProject(workspaceDirectory);
    if (!opened.workspace) throw new Error(opened.error ?? "Workspace did not open");
    projectId = opened.workspace.projectId;
    const agent = await client.createAgent({ provider: "claude", cwd: workspaceDirectory });
    await client.patchDaemonConfig({ pluginsEnabled: true });
    await client.installDirectoryPlugin(pluginDirectory);
    const original = await client.invokePluginRpc("reconnecting", "probe", {});
    expect(original).toEqual({ pid: expect.any(Number), projectIds: [projectId] });
    await client.invokePluginRpc("reconnecting", "observe", { agentId: agent.id });
    const appUpdates = new EventEmitter();
    const offApp = client.subscribeAgentTimeline(agent.id, (message) => {
      if (
        message.type === "agent_stream" &&
        message.payload.event.type === "timeline" &&
        message.payload.event.item.type === "assistant_message"
      ) {
        appUpdates.emit(message.payload.event.item.messageId);
      }
    });
    await offApp.ready;
    async function emitMarker(marker: string): Promise<void> {
      const appUpdate = once(appUpdates, marker, { signal: AbortSignal.timeout(5000) });
      await client.updateAgent(agent.id, { name: marker });
      await daemon.daemon.agentManager.emitLiveTimelineItem(agent.id, {
        type: "assistant_message",
        messageId: marker,
        text: "Controlled observer demand probe",
      });
      await appUpdate;
    }
    const markers = ["Before disconnect", "First recovery", "Second recovery"];
    for (const [index, marker] of markers.entries()) {
      if (index > 0) await client.invokePluginRpc("reconnecting", "disconnect", {});
      expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
      await emitMarker(marker);
      for (const value of ["metadata:" + marker, "timeline:" + marker]) {
        await expect(client.invokePluginRpc("reconnecting", "wait", { value })).resolves.toBeNull();
      }
    }
    const beforeRelease = ReconnectingPluginStateSchema.parse(
      await client.invokePluginRpc("reconnecting", "state", {}),
    );
    expect(beforeRelease.observations).toEqual(
      markers.flatMap((marker) => ["metadata:" + marker, "timeline:" + marker]),
    );
    await client.invokePluginRpc("reconnecting", "release", {});
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    expect(await client.invokePluginRpc("reconnecting", "probe", {})).toEqual(original);
    await emitMarker("After release");
    await client.invokePluginRpc("reconnecting", "probe", {});
    expect(await client.invokePluginRpc("reconnecting", "state", {})).toEqual(beforeRelease);
    offApp();
    await client.invokePluginRpc("reconnecting", "disconnect", {});
    await client.removePlugin("reconnecting");
    expect(await client.listPlugins()).toEqual([]);
    await expect(client.invokePluginRpc("reconnecting", "probe", {})).rejects.toThrow(
      "Plugin is not available",
    );
  } finally {
    if (projectId) await client.removeProject(projectId);
    await client.close();
    await daemon.close();
  }
}, 60_000);
