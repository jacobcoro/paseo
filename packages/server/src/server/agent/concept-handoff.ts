// Passive exact private observation handoff; neither authorization nor native probing.
import {
  openSync,
  closeSync,
  writeFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  existsSync,
  readFileSync,
  lstatSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import type { AgentManager } from "./agent-manager.js";
import type { AgentStorage, StoredAgentRecord } from "./agent-storage.js";
import { assertClaudeTextOnlyConfig } from "./providers/claude/text-only.js";
import { loadConceptHandoffConfig, privateDirectory } from "./concept-handoff-config.js";
import { conceptFinalHandoffModuleUrl } from "./concept-handoff-module.js";

function projectStored(before: StoredAgentRecord) {
  const config = before.config;
  if (
    !config ||
    config.systemPrompt ||
    config.toolPolicy ||
    (config.mcpServers && Object.keys(config.mcpServers).length)
  )
    return null;
  return {
    id: before.id,
    provider: before.provider,
    cwd: before.cwd,
    workspaceId: before.workspaceId,
    internal: before.internal === true,
    config: {
      model: config.model,
      thinkingOptionId: config.thinkingOptionId,
      modeId: config.modeId,
      providerOptions: config.providerOptions,
    },
  };
}
function exactSnapshot(
  before: StoredAgentRecord,
  after: StoredAgentRecord,
  observation: NonNullable<Awaited<ReturnType<AgentManager["observeConceptAgent"]>>>,
  selected: { id: string; workspace: string; workspaceId: string },
  managerGeneration: string,
) {
  return (
    JSON.stringify(before) === JSON.stringify(after) &&
    before.id === selected.id &&
    observation.id === selected.id &&
    observation.cwd === selected.workspace &&
    observation.workspaceId === selected.workspaceId &&
    !observation.internal &&
    observation.visible &&
    observation.manager_generation === managerGeneration
  );
}
export const conceptFrameName = (id: string): string =>
  createHash("sha256").update(id).digest("hex") + ".json";
export function startConceptHandoff(input: {
  spec?: string;
  home: string;
  serverId: string;
  manager: Pick<
    AgentManager,
    | "conceptOwnerGeneration"
    | "getAgent"
    | "observeConceptAgent"
    | "subscribe"
    | "readConceptFinalText"
  >;
  storage: Pick<AgentStorage, "getCurrent">;
  now?: () => number;
}) {
  if (!input.spec) return { stop: async () => undefined, refresh: async () => undefined };
  const config = loadConceptHandoffConfig(input.spec, input.home),
    now = input.now ?? Date.now;
  const observerGeneration = randomUUID(),
    lock = join(config.outputDir, ".observer-owner");
  // Never steal an unknown old writer. Root separately reconciles crash remnants.
  const fd = openSync(lock, "wx", 0o600);
  writeFileSync(
    fd,
    JSON.stringify({ observer_generation: observerGeneration, daemon_pid: process.pid }),
  );
  fsyncSync(fd);
  closeSync(fd);
  let stopped = false,
    active: Promise<void> | null = null;
  const known = new Set<string>(),
    unsubscribers: (() => void)[] = [];
  const identity = () => ({
    kind: "actual-concept-daemon-owner",
    schema: 1,
    target: config.target,
    server_id: input.serverId,
    manager_generation: input.manager.conceptOwnerGeneration,
    observer_generation: observerGeneration,
    daemon_pid: process.pid,
    config_sha256: input.spec!.slice(0, 64),
    observed_ms: now(),
    expires_ms: now() + 4000,
    state: stopped ? "closed" : "current",
  });
  function owned() {
    privateDirectory(
      config.outputDir,
      config.agents.map((a) => a.workspace),
    );
    const st = lstatSync(lock);
    if (
      !st.isFile() ||
      st.isSymbolicLink() ||
      st.mode & 0o077 ||
      st.uid !== process.getuid?.() ||
      st.size > 4096 ||
      JSON.parse(readFileSync(lock, "utf8")).observer_generation !== observerGeneration
    )
      throw Error("Concept observer writer ownership unknown");
  }
  function write(name: string, record: unknown) {
    owned();
    const temporary = join(config.outputDir, name + "." + randomUUID());
    const bytes = JSON.stringify(record);
    if (Buffer.byteLength(bytes) > (name.endsWith(".final.json") ? 458752 : 65536))
      throw Error("Concept observation frame too large");
    const handle = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(handle, bytes);
      fsyncSync(handle);
    } finally {
      closeSync(handle);
    }
    renameSync(temporary, join(config.outputDir, name));
    const directory = openSync(config.outputDir, "r");
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  function closed(id: string) {
    write(conceptFrameName(id).replace(".json", ".final.json"), {
      ...identity(),
      kind: "actual-concept-selected-final",
      id,
      state: "unknown",
    });
    write(conceptFrameName(id), {
      ...identity(),
      kind: "actual-concept-private-frame",
      id,
      state: "unknown",
    });
  }
  async function captureFinal(
    selected: (typeof config.agents)[number],
    after: StoredAgentRecord,
    observation: NonNullable<Awaited<ReturnType<AgentManager["observeConceptAgent"]>>>,
  ) {
    let final = null;
    if (selected.finalText === "sdk-success-result") {
      try {
        const { selectedFinalForHandoff } = await import(
          conceptFinalHandoffModuleUrl(new URL(import.meta.url)).href
        );
        final = await selectedFinalForHandoff(selected, {
          manager: input.manager,
          storage: input.storage,
          liveOwner: identity,
          now,
        });
      } catch {
        final = null;
      }
      if (stopped) return false;
      const fresh = await input.manager.observeConceptAgent(selected.id);
      if (stopped) return false;
      if (
        JSON.stringify(input.storage.getCurrent(selected.id)) !== JSON.stringify(after) ||
        JSON.stringify(fresh?.committed_completion) !==
          JSON.stringify(observation.committed_completion)
      ) {
        closed(selected.id);
        return false;
      }
      write(conceptFrameName(selected.id).replace(".json", ".final.json"), {
        ...identity(),
        kind: "actual-concept-selected-final",
        id: selected.id,
        state: final ? "current" : "unknown",
        ...(final ? { final } : {}),
      });
    }
    return !stopped;
  }
  async function capture() {
    if (stopped) return;
    write("live-owner.json", identity());
    for (const selected of config.agents) {
      if (stopped) return;
      try {
        const current = input.manager.getAgent(selected.id);
        if (!current || !assertClaudeTextOnlyConfig(current.config)) {
          if (known.has(selected.id)) closed(selected.id);
          continue;
        }
        known.add(selected.id);
        const before = input.storage.getCurrent(selected.id);
        const observation = await input.manager.observeConceptAgent(selected.id);
        const after = input.storage.getCurrent(selected.id);
        if (stopped) return;
        if (
          !before ||
          !after ||
          !observation ||
          !exactSnapshot(before, after, observation, selected, input.manager.conceptOwnerGeneration)
        ) {
          closed(selected.id);
          continue;
        }
        const stored = projectStored(before);
        if (!stored) {
          closed(selected.id);
          continue;
        }
        if (!(await captureFinal(selected, after, observation))) continue;
        write(conceptFrameName(selected.id), {
          ...identity(),
          kind: "actual-concept-private-frame",
          id: selected.id,
          state: "current",
          stored,
          observation,
        });
      } catch {
        if (known.has(selected.id)) closed(selected.id);
      }
    }
  }
  const refresh = () => {
    if (stopped) return Promise.resolve();
    if (active) return active;
    active = capture().finally(() => {
      active = null;
    });
    return active;
  };
  for (const selected of config.agents)
    unsubscribers.push(
      input.manager.subscribe(
        () => {
          void refresh().catch(() => undefined);
        },
        { agentId: selected.id, replayState: false },
      ),
    );
  const timer = setInterval(() => {
    void refresh().catch(() => undefined);
  }, 2000);
  timer.unref();
  void refresh().catch(() => undefined);
  return {
    refresh,
    async stop() {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      unsubscribers.forEach((fn) => fn());
      // Pending passive reads cannot write after stopped. No native quiescence is asserted.
      for (const id of known) closed(id);
      write("live-owner.json", identity());
      owned();
      if (existsSync(lock)) unlinkSync(lock); // Only this component's exclusive writer; no peer shutdown.
    },
  };
}

export function conceptHandoffLifecycle(input: Parameters<typeof startConceptHandoff>[0]) {
  let handoff: ReturnType<typeof startConceptHandoff> | undefined;
  return {
    start() {
      if (handoff) throw Error("Concept observer already started");
      handoff = startConceptHandoff(input);
    },
    async stop() {
      const current = handoff;
      handoff = undefined;
      await current?.stop();
    },
  };
}
