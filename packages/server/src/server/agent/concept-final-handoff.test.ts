// SOURCE_ONLY actual provider+manager+private handoff+exported facade, fake SDK/store/Root records.
import { afterEach, expect, test, vi } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { fixture as nativeFixture } from "./providers/claude/concept-completion-fixture.js";
import { startConceptHandoff, conceptFrameName } from "./concept-handoff.js";
afterEach(() => vi.restoreAllMocks());
async function setup(resultText = "VISIBLE FINAL") {
  const { fixture } = await import(
    new URL("../../../../../study/employee-concept-reader-fixture.mjs", import.meta.url).href
  );
  const root = fixture();
  const native = await nativeFixture("streamed", root.config.workspace, resultText);
  const observed = await native.observe();
  expect(observed?.committed_completion).not.toBeNull();
  const info = observed!.runtimeInfo!.extra!.conceptText as {
    session_incarnation: string;
    query_incarnation: string;
    spawn: { child_incarnation: string; pid: number };
    init: { native_session_id: string };
  };
  root.config.agentId = native.agent.id;
  root.request.requested_id = native.agent.id;
  root.request.tuple = {
    cwd: root.config.workspace,
    model: "opus",
    thinking: "high",
    mode: "default",
  };
  Object.assign(root.scope, {
    producer_id: native.agent.id,
    worker_id: native.agent.id,
    runtime_generation: observed!.manager_generation,
    worker_generation: info.session_incarnation,
  });
  Object.assign(root.binding, root.scope, { model: "opus" });
  const stored = {
    id: native.agent.id,
    provider: "claude",
    cwd: root.config.workspace,
    workspaceId: root.config.workspaceId,
    internal: false,
    config: {
      model: "opus",
      modeId: "default",
      thinkingOptionId: "high",
      providerOptions: { textOnly: true },
    },
  };
  const selected = {
    id: native.agent.id,
    workspaceId: root.config.workspaceId,
    workspace: root.config.workspace,
    reader: root.config,
    finalText: "sdk-success-result" as const,
  };
  const host = dirname(root.paths.owner),
    cfg = { target: root.config.target, outputDir: host, agents: [selected] };
  const path = join(host, "final-host-config.json"),
    bytes = JSON.stringify(cfg);
  writeFileSync(path, bytes, { mode: 0o600 });
  const spec = createHash("sha256").update(bytes).digest("hex") + ":" + path;
  const handoff = startConceptHandoff({
    spec,
    home: cfg.target.home,
    serverId: "source-only-server",
    manager: native.manager,
    storage: { getCurrent: () => structuredClone(stored) } as never,
  });
  await handoff.refresh();
  const name = conceptFrameName(native.agent.id),
    finalPath = join(host, name.replace(".json", ".final.json"));
  const readFinal = () => JSON.parse(readFileSync(finalPath, "utf8"));
  expect(readFinal().state).toBe("unknown");
  expect(readFinal().final?.text).toBeUndefined();
  const owner = JSON.parse(readFileSync(join(host, "live-owner.json"), "utf8"));
  root.scope.broker_generation = owner.observer_generation;
  Object.assign(root.binding, root.scope);
  const proof = {
    ...root.proof,
    scope: root.scope,
    manager_generation: observed!.manager_generation,
    session_incarnation: info.session_incarnation,
    query_incarnation: info.query_incarnation,
    child_incarnation: info.spawn.child_incarnation,
    native_session_id: info.init.native_session_id,
    native_model: "opus",
    pid: info.spawn.pid,
  };
  root.write("owner", {
    kind: "registered-concept-runtime-owner",
    manager_generation: observed!.manager_generation,
    broker_generation: owner.observer_generation,
    runtime_id: root.scope.runtime_id,
    broker_id: root.scope.broker_id,
    target: cfg.target,
    ...root.fresh(),
  });
  root.write("registry", {
    kind: "registered-exact-concept-job",
    scope: root.scope,
    assignment: root.binding,
    request: root.request,
    target: cfg.target,
    ...root.fresh(),
  });
  root.write("boundary", proof);
  root.write("currentApproval", { ...root.approval, binding: root.binding });
  await handoff.refresh();
  const { createConceptBoundary } = await import(
    new URL("../../../../../study/employee-concept-boundary.mjs", import.meta.url).href
  );
  const facade = createConceptBoundary(spec);
  return {
    root,
    native,
    observed,
    handoff,
    spec,
    host,
    finalPath,
    readFinal,
    facade,
    writeFinal: (value: unknown) =>
      writeFileSync(finalPath, JSON.stringify(value), { mode: 0o600 }),
    close: async () => {
      await handoff.stop();
      await native.close();
    },
  };
}
test("actual streamed success crosses approved fake Root/private handoff and actual exported facade with derived turn", async () => {
  const f = await setup();
  try {
    expect(f.readFinal().state).toBe("current");
    const request = { clientMessageId: "actual-client-id" };
    const result = await f.facade.readConceptFinal(f.root.binding, request);
    expect(result.text).toBe("VISIBLE FINAL");
    expect(result.completion.final_message_id).toBe("actual-result-uuid");
    expect(JSON.stringify(result)).not.toContain("SECRET PROMPT");
    expect(JSON.stringify(result)).not.toContain("STREAMED PREFIX");
    const metadata = readFileSync(join(f.host, conceptFrameName(f.native.agent.id)), "utf8");
    expect(metadata).not.toContain("VISIBLE FINAL");
    const api = await import(
      new URL("../../../../../study/employee-concept-boundary.mjs", import.meta.url).href
    );
    const previous = process.env.PASEO_CONCEPT_OBSERVATION_CONFIG;
    process.env.PASEO_CONCEPT_OBSERVATION_CONFIG = f.spec;
    try {
      expect(
        (
          await api.observeConceptCompletion(f.root.binding, {
            clientMessageId: request.clientMessageId,
            turnId: result.completion.provider_turn_id,
          })
        ).completion.result_uuid,
      ).toBe("actual-result-uuid");
      expect((await api.readConceptFinal(f.root.binding, request)).text).toBe("VISIBLE FINAL");
    } finally {
      if (previous === undefined) delete process.env.PASEO_CONCEPT_OBSERVATION_CONFIG;
      else process.env.PASEO_CONCEPT_OBSERVATION_CONFIG = previous;
    }
  } finally {
    await f.close();
  }
});
test("wrong input, artifact identity/hash/epoch/cursor/generation, revoke, uncommitted and stale deny text", async () => {
  const f = await setup();
  try {
    const request = { clientMessageId: "actual-client-id" },
      pristine = f.readFinal();
    await expect(
      f.facade.readConceptFinal(f.root.binding, { clientMessageId: "foreign" }),
    ).rejects.toThrow();
    await expect(
      f.facade.readConceptFinal(f.root.binding, { ...request, turnId: "desired" }),
    ).rejects.toThrow();
    for (const mutate of [
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.completion.cursor++;
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.completion.epoch = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.completion.result_uuid = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.text = "CHANGED";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.completion.query_incarnation = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.completion.native_session_id = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.final.scope.revision = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.observer_generation = "foreign";
      },
      (v: ReturnType<typeof f.readFinal>) => {
        v.expires_ms = 0;
      },
    ]) {
      const value = structuredClone(pristine);
      mutate(value);
      f.writeFinal(value);
      await expect(f.facade.readConceptFinal(f.root.binding, request)).rejects.toThrow();
    }
    f.writeFinal(pristine);
    f.root.write("currentApproval", { ...f.root.approval, binding: f.root.binding, revoked: true });
    await f.handoff.refresh();
    expect(f.readFinal().state).toBe("unknown");
    expect(f.readFinal().final?.text).toBeUndefined();
    await expect(f.facade.readConceptFinal(f.root.binding, request)).rejects.toThrow();
    f.root.write("currentApproval", { ...f.root.approval, binding: f.root.binding });
    f.native.hold();
    await f.handoff.refresh();
    expect(f.readFinal().state).toBe("unknown");
    await expect(f.facade.readConceptFinal(f.root.binding, request)).rejects.toThrow();
  } finally {
    await f.close();
  }
});

test("oversize malformed UTF8 and native exit never release a selected text artifact", async () => {
  for (const text of ["X".repeat(65537), "\ud800"]) {
    const f = await setup(text);
    try {
      expect(f.readFinal().state).toBe("unknown");
      expect(f.readFinal().final?.text).toBeUndefined();
      await expect(
        f.facade.readConceptFinal(f.root.binding, { clientMessageId: "actual-client-id" }),
      ).rejects.toThrow();
    } finally {
      await f.close();
    }
  }
  const f = await setup();
  try {
    f.native.child.emit("exit", 0);
    await f.handoff.refresh();
    expect(f.readFinal().state).toBe("unknown");
    await expect(
      f.facade.readConceptFinal(f.root.binding, { clientMessageId: "actual-client-id" }),
    ).rejects.toThrow();
  } finally {
    await f.close();
  }
});
