// SOURCE_ONLY files and in-memory manager/storage; no daemon/provider construction.
import { test, expect, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { startConceptHandoff } from "./concept-handoff.js";
import { conceptHandoffLifecycle, conceptFrameName } from "./concept-handoff.js";
import { loadConceptHandoffConfig } from "./concept-handoff-config.js";
function fixture() {
  const root = process.env.EMPLOYEE_CONCEPT_TEST_ROOT;
  if (!root) throw Error("Select private SOURCE_ONLY fixtures");
  const folder = mkdtempSync(join(root, "handoff-"));
  const host = join(folder, "host"),
    workspace = join(folder, "workspace");
  mkdirSync(host, { mode: 0o700 });
  mkdirSync(workspace, { mode: 0o700 });
  const id = "11111111-1111-4111-8111-111111111111",
    home = join(host, "instance");
  const config = {
    target: { kind: "instance", home },
    outputDir: host,
    agents: [{ id, workspaceId: "workspace", workspace, reader: {} }],
  };
  const path = join(host, "config.json");
  const pin = () => {
    const data = JSON.stringify(config);
    writeFileSync(path, data, { mode: 0o600 });
    return createHash("sha256").update(data).digest("hex") + ":" + path;
  };
  const sealed = {
    provider: "claude",
    cwd: workspace,
    model: "fake",
    modeId: "default",
    thinkingOptionId: "high",
    providerOptions: { textOnly: true },
  };
  let record: unknown = {
    id,
    provider: "claude",
    cwd: workspace,
    workspaceId: "workspace",
    config: sealed,
    prompt: "NEVER_EXPORT",
    auth: "NEVER_EXPORT",
  };
  const observation = {
    id,
    provider: "claude",
    cwd: workspace,
    workspaceId: "workspace",
    visible: true,
    internal: false,
    manager_generation: "actual-fake-manager",
    runtimeInfo: { extra: { conceptText: { init: null } } },
  };
  const subscribe = vi.fn(
    (_callback: () => void, _options: { agentId: string; replayState: boolean }) => vi.fn(),
  );
  const manager = {
    conceptOwnerGeneration: "actual-fake-manager",
    getAgent: vi.fn(() => ({ config: sealed })),
    observeConceptAgent: vi.fn(async () => structuredClone(observation)),
    subscribe,
  };
  const storage = { getCurrent: vi.fn(() => structuredClone(record)) };
  const input = {
    spec: pin(),
    home,
    serverId: "actual-fake-server",
    manager,
    storage,
  } as unknown as Parameters<typeof startConceptHandoff>[0];
  const read = () => JSON.parse(readFileSync(join(host, conceptFrameName(id)), "utf8"));
  return {
    config,
    path,
    pin,
    host,
    workspace,
    id,
    input,
    manager,
    storage,
    observation,
    read,
    setRecord: (next: unknown) => {
      record = next;
    },
  };
}
test("default OFF lifecycle performs no discovery, subscription or observations", async () => {
  const f = fixture();
  const life = conceptHandoffLifecycle({ ...f.input, spec: undefined });
  life.start();
  await life.stop();
  expect(f.manager.getAgent).not.toHaveBeenCalled();
  expect(f.manager.subscribe).not.toHaveBeenCalled();
  expect(existsSync(join(f.host, "live-owner.json"))).toBe(false);
});
test("same injected objects project exact current records; lasting incarnation closes on lifecycle stop", async () => {
  const f = fixture();
  const life = conceptHandoffLifecycle(f.input);
  life.start();
  await vi.waitFor(() => expect(existsSync(join(f.host, conceptFrameName(f.id)))).toBe(true));
  const first = f.read();
  expect(first.observation.runtimeInfo.extra.conceptText.init).toBeNull();
  expect(JSON.stringify(first)).not.toContain("NEVER_EXPORT");
  expect(f.storage.getCurrent).toHaveBeenCalledTimes(2);
  expect(f.manager.subscribe).toHaveBeenCalledWith(expect.any(Function), {
    agentId: f.id,
    replayState: false,
  });
  const callback = f.manager.subscribe.mock.calls[0][0] as unknown as () => void;
  callback();
  await vi.waitFor(() => expect(f.storage.getCurrent).toHaveBeenCalledTimes(4));
  expect(f.read().observer_generation).toBe(first.observer_generation);
  await life.stop();
  expect(f.read().state).toBe("unknown");
  expect(JSON.parse(readFileSync(join(f.host, "live-owner.json"), "utf8")).state).toBe("closed");
  expect(existsSync(join(f.host, ".observer-owner"))).toBe(false);
});
test("pending mutation and removal close; unknown initial ID never receives frame; duplicate writer refused", async () => {
  const f = fixture();
  f.manager.getAgent.mockReturnValue(null as never);
  const life = conceptHandoffLifecycle(f.input);
  life.start();
  await Promise.resolve();
  expect(existsSync(join(f.host, conceptFrameName(f.id)))).toBe(false);
  expect(() => conceptHandoffLifecycle(f.input).start()).toThrow();
  f.manager.getAgent.mockReturnValue({
    config: {
      provider: "claude",
      cwd: f.workspace,
      model: "fake",
      modeId: "default",
      thinkingOptionId: "high",
      providerOptions: { textOnly: true },
    },
  });
  f.manager.observeConceptAgent.mockImplementation(async () => {
    f.setRecord(null);
    return structuredClone(f.observation);
  });
  (f.manager.subscribe.mock.calls[0][0] as unknown as () => void)();
  await vi.waitFor(() => expect(f.read().state).toBe("unknown"));
  await life.stop();
});
test("private hash, target, symlink, ownership mode, outside workspace and selection bounds fail closed", () => {
  const f = fixture();
  expect(loadConceptHandoffConfig(f.input.spec!, f.input.home).agents).toHaveLength(1);
  expect(() => loadConceptHandoffConfig("0".repeat(64) + ":" + f.path, f.input.home)).toThrow();
  expect(() => loadConceptHandoffConfig(f.input.spec!, "/wrong")).toThrow();
  chmodSync(f.path, 0o644);
  expect(() => loadConceptHandoffConfig(f.input.spec!, f.input.home)).toThrow();
  chmodSync(f.path, 0o600);
  const link = join(f.host, "link.json");
  symlinkSync(f.path, link);
  expect(() =>
    loadConceptHandoffConfig(f.input.spec!.split(":")[0] + ":" + link, f.input.home),
  ).toThrow();
  f.config.outputDir = f.workspace;
  expect(() => loadConceptHandoffConfig(f.pin(), f.input.home)).toThrow();
  f.config.outputDir = f.host;
  f.config.agents = [];
  expect(loadConceptHandoffConfig(f.pin(), f.input.home).agents).toHaveLength(0);
});
test("bootstrap uses existing manager/storage and lifecycle, preserves daemon plugin runtime", () => {
  const source = readFileSync(new URL("../bootstrap.ts", import.meta.url), "utf8");
  expect(source).toContain("manager: agentManager,");
  expect(source).toContain("storage: agentStorage,");
  expect(source).toContain("conceptHandoff.start()");
  expect(source).toMatch(/conceptHandoff\s*\.stop\(\)/);
  expect(source).toContain("pluginRuntime");
});

test("unresolved passive read cannot block shutdown or publish late success", async () => {
  const f = fixture();
  let resolve: (value: typeof f.observation) => void = () => {};
  f.manager.observeConceptAgent.mockImplementation(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const life = conceptHandoffLifecycle(f.input);
  life.start();
  await Promise.resolve();
  await life.stop();
  expect(f.read().state).toBe("unknown");
  resolve(f.observation);
  await Promise.resolve();
  await Promise.resolve();
  expect(f.read().state).toBe("unknown");
});
