// SOURCE_ONLY fake private frames; no SDK or daemon and no live evidence.
import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { fixture } from "./employee-concept-reader-fixture.mjs";
import { createConceptBoundary } from "./employee-concept-boundary.mjs";
function setup() {
  const f = fixture("11111111-1111-4111-8111-111111111111"),
    host = join(f.config.workspace, "..", "host");
  const config = {
    target: f.config.target,
    outputDir: host,
    agents: [
      {
        id: f.config.agentId,
        workspaceId: f.config.workspaceId,
        workspace: f.config.workspace,
        reader: f.config,
      },
    ],
  };
  const data = JSON.stringify(config),
    sha = createHash("sha256").update(data).digest("hex"),
    path = join(host, "facade-config.json");
  writeFileSync(path, data, { mode: 0o600 });
  const now = f.observed.observed_ms,
    owner = {
      kind: "actual-concept-daemon-owner",
      state: "current",
      target: config.target,
      server_id: "fake-server",
      manager_generation: f.observed.manager_generation,
      observer_generation: f.scope.broker_generation,
      daemon_pid: 1234,
      config_sha256: sha,
      observed_ms: now,
      expires_ms: now + 4000,
    };
  const frame = {
    ...owner,
    kind: "actual-concept-private-frame",
    id: f.config.agentId,
    stored: f.stored,
    observation: f.observed,
  };
  const framePath = join(
      host,
      createHash("sha256").update(f.config.agentId).digest("hex") + ".json",
    ),
    ownerPath = join(host, "live-owner.json");
  const write = (filePath, value) =>
    writeFileSync(filePath, JSON.stringify(value), { mode: 0o600 });
  write(ownerPath, owner);
  write(framePath, frame);
  return {
    ...f,
    path,
    framePath,
    ownerPath,
    owner,
    frame,
    write,
    make: () => createConceptBoundary(sha + ":" + path, () => now),
  };
}
test("one-shot facade recreation retains actual lasting owner, exact callbacks and real settlement", async () => {
  const f = setup(),
    a = f.make(),
    b = f.make();
  assert.deepEqual(
    (await a.observeOwner(f.request)).scope,
    (await b.observeOwner(f.request)).scope,
  );
  assert.equal((await a.assertConceptCurrent(f.binding, f.approval)).result, "passed");
  await a.assertConceptQuiescent(f.binding, f.revoked);
  assert.equal((await a.observeConceptTerminal(f.binding, f.revoked)).delivery_terminal, true);
  await a.authorize(f.request);
  await a.assertPrecreation(f.request, await a.authorize(f.request));
  assert.equal(JSON.stringify(f.frame).includes("root_receipt"), false);
});
test("missing stale closed drift foreign identity and private file drift deny", async () => {
  for (const mutate of [
    (f) => {
      f.owner.state = "closed";
      f.write(f.ownerPath, f.owner);
    },
    (f) => {
      f.frame.expires_ms = 0;
      f.write(f.framePath, f.frame);
    },
    (f) => {
      f.frame.id = "foreign";
      f.write(f.framePath, f.frame);
    },
    (f) => {
      f.frame.observer_generation = "replacement";
      f.write(f.framePath, f.frame);
    },
    (f) => {
      f.frame.observation.runtimeInfo.extra.conceptText.init = null;
      f.write(f.framePath, f.frame);
    },
    (f) => chmodSync(f.framePath, 0o644),
    (f) => writeFileSync(f.path, readFileSync(f.path) + " "),
  ]) {
    const f = setup();
    mutate(f);
    await assert.rejects(async () => f.make().assertConceptCurrent(f.binding, f.approval));
  }
});

test("aggregate stop settlement cannot satisfy successful completion callback", async () => {
  const f = setup();
  await assert.rejects(
    f
      .make()
      .observeConceptCompletion(f.binding, { clientMessageId: "expected", turnId: "expected" }),
  );
});
