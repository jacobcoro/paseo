// SOURCE_ONLY fake clients and independently labelled synthetic observations.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fixture } from "./employee-concept-fixture.mjs";
import {
  conceptConfig,
  digest,
  conceptAssignmentFields,
  conceptBoundaryChecks,
} from "./employee-concept-profile.mjs";
import { resumeConceptExact } from "./employee-concept-resume.mjs";
import { startEmployeeOwner } from "./employee-lifecycle.mjs";
import { handleTool, runPythonJob, startToolWorker } from "./tool-worker.mjs";
const pending = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};

test("modern selected UUID/key creates inactive; observed nine remain separately inactive", async () => {
  const f = fixture();
  assert.equal((await f.host().createPending(f.request)).status, "accepted-inactive");
  const input = f.calls.find((call) => call[0] === "create")[1];
  assert.equal(input.agentId, f.request.requested_id);
  assert.equal(input.idempotencyKey, f.request.idempotency_key);
  assert.deepEqual(input.config, conceptConfig(f.request.tuple));
  assert.equal(f.intent().active, false);
  assert.equal(existsSync(f.worker.employeeControlFile), false);
  assert.equal((await f.host().admitInactive(f.request, f.worker, {})).status, "admitted-inactive");
  assert.throws(() => startEmployeeOwner(f.worker)); // Cannot become a tool executor.
});

test("missing proof and unsupported actor/config overrides reject before connect", async () => {
  for (const key of ["authorize", "assertPrecreation", "observeOwner", "connect"]) {
    const f = fixture({ [key]: undefined });
    await assert.rejects(f.host().createPending(f.request));
    assert.equal(f.calls.length, 0);
  }
  for (const key of [
    "initialPrompt",
    "env",
    "attachments",
    "internal",
    "providerOptions",
    "actor",
  ]) {
    const f = fixture();
    f.request[key] = "forbidden";
    await assert.rejects(f.host().createPending(f.request));
    assert.equal(f.calls.length, 0);
  }
  const f = fixture();
  f.args.assertPrecreation = async () => ({});
  await assert.rejects(f.host().createPending(f.request));
  assert.equal(f.calls.length, 0);
});

test("legacy, collision, wrong identity/seal and unknown acceptance retain ownership", async () => {
  const variants = [
    (f) => {
      f.client.getLastServerInfoMessage = () => ({});
    },
    (f) => {
      f.client.fetchAgent = async () => ({ agent: f.agent });
    },
    ...["id", "provider", "workspaceId", "model", "thinkingOptionId", "currentModeId"].map(
      (key) => (f) => {
        f.agent[key] = "foreign";
      },
    ),
    (f) => {
      f.args.observeOwner = async () => ({});
    },
    (f) => {
      f.client.createAgent = async () => {
        throw Error("synthetic unknown timeout");
      };
    },
  ];
  for (const change of variants) {
    const f = fixture();
    change(f);
    await assert.rejects(f.host().createPending(f.request));
    assert.equal(f.intent().active, false);
    assert.equal(existsSync(f.args.intentFile + ".create"), true);
    await assert.rejects(f.host().createPending(f.request));
  }
});

test("withdraw during create survives expiry and late acceptance; no admission/reactivation", async () => {
  const f = fixture(),
    accepted = pending(),
    started = pending();
  f.client.createAgent = () => {
    started.resolve();
    return accepted.promise;
  };
  const creating = f.host().createPending(f.request);
  await started.promise;
  f.args.now = () => f.now + 100000;
  const first = await f.host().withdrawPending(f.request),
    nonce = f.intent().revoke_nonce;
  assert.equal(first.quiescent, false);
  await f.host().withdrawPending(f.request);
  assert.equal(f.intent().revoke_nonce, nonce);
  assert.equal(f.intent().revoke_epoch, 1);
  accepted.resolve(f.agent);
  await assert.rejects(creating);
  assert.equal(f.intent().active, false);
  await assert.rejects(f.host().admitInactive(f.request, f.worker, {}));
  assert.equal(existsSync(f.worker.employeeControlFile), false);
});

test("bounded late create and malformed/fabricated observation cannot release creation lease", async () => {
  const f = fixture({ timeoutMs: 25 }),
    accepted = pending();
  f.client.createAgent = () => accepted.promise;
  await assert.rejects(f.host().createPending(f.request));
  accepted.resolve(f.agent);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(f.args.intentFile + ".create"), true);
  assert.equal(f.intent().active, false);
  for (const change of [
    (o) => {
      delete o.scope.runtime_generation;
    },
    (o) => {
      o.internal = true;
    },
    (o) => {
      delete o.issued_ms;
    },
    (o) => {
      o.config.providerOptions = { textOnly: false };
    },
  ]) {
    const g = fixture(),
      reader = g.args.observeOwner;
    g.args.observeOwner = async () => {
      const o = structuredClone(await reader());
      change(o);
      return o;
    };
    await assert.rejects(g.host().createPending(g.request));
  }
});

test("admission missing proof, foreign actual scope or source/model drift deny", async () => {
  for (const change of [
    (f) => {
      f.args.verifyAdmission = undefined;
    },
    (f) => {
      f.args.verifyAdmission = async () => undefined;
    },
    (f) => {
      f.worker.employeeScope = { ...f.actual, worker_generation: "foreign" };
    },
    (f) => {
      f.request.source_hashes.host = "b".repeat(64);
    },
    (f) => {
      f.request.tuple.model = "changed";
      f.request.config_sha256 = digest(conceptConfig(f.request.tuple));
    },
  ]) {
    const f = fixture();
    await f.host().createPending(f.request);
    change(f);
    await assert.rejects(f.host().admitInactive(f.request, f.worker, {}));
    assert.equal(existsSync(f.worker.employeeControlFile), false);
  }
});

test("exact resume uses immutable seal and nine fields; missing preflight never connects", async () => {
  const f = fixture();
  f.activate();
  const binding = {
    ...f.actual,
    profile: f.worker.profile,
    provider: "claude",
    workspace_id: f.request.workspace_id,
    ...f.request.tuple,
    tuple: f.request.tuple,
    source_hashes: f.request.source_hashes,
    daemon_target: f.request.daemon_target,
  };
  for (const key of conceptAssignmentFields)
    if (!(key in binding)) binding[key] = "synthetic-" + key;
  for (const key of [
    "assignment_sha256",
    "packet_sha256",
    "source_manifest_sha256",
    "broker_config_sha256",
    "tool_catalog_sha256",
  ])
    binding[key] = "a".repeat(64);
  binding.capability = "concept-refine";
  binding.expires_ms = f.now + 60000;
  const args = {
    binding,
    worker: f.worker,
    authority: f.request.requested_by,
    now: () => f.now,
    authorize: async () => ({
      kind: "root-authorized-concept-resume",
      approved_by: f.request.requested_by,
      root_receipt: "SOURCE_ONLY",
      revoked: false,
      binding,
      issued_ms: f.now,
      expires_ms: f.now + 10000,
    }),
    observeOwner: async () => ({
      ...(await f.args.observeOwner()),
      source_hashes: binding.source_hashes,
      assignment: Object.fromEntries(conceptAssignmentFields.map((key) => [key, binding[key]])),
      checks: Object.fromEntries(conceptBoundaryChecks.map((key) => [key, true])),
      resume_checks: Object.fromEntries(
        ["workspace_prepared", "no_setup_or_restore", "native_idle", "stored_seal_current"].map(
          (key) => [key, true],
        ),
      ),
    }),
    connect: async () => ({
      fetchAgent: async () => ({ agent: f.agent }),
      refreshAgent: async (id) => {
        f.calls.push(["refresh", id]);
        return { agentId: id, status: "agent_refreshed" };
      },
      close: async () => {},
    }),
  };
  const missing = { ...args, observeOwner: undefined };
  await assert.rejects(resumeConceptExact(missing));
  assert.equal(f.calls.length, 0);
  assert.equal((await resumeConceptExact(args)).resumed, true);
  assert.deepEqual(f.calls, [["refresh", binding.producer_id]]);
  await assert.rejects(
    resumeConceptExact({ ...args, binding: { ...binding, runtime_generation: "foreign" } }),
  );
});

test("withdrawal while independent admission is pending cannot create an actor control", async () => {
  const f = fixture();
  await f.host().createPending(f.request);
  const entered = pending(),
    release = pending(),
    reader = f.args.verifyAdmission;
  f.args.verifyAdmission = async (...args) => {
    entered.resolve();
    await release.promise;
    return reader(...args);
  };
  const admission = f.host().admitInactive(f.request, f.worker, {});
  await entered.promise;
  await f.host().withdrawPending(f.request);
  release.resolve();
  await assert.rejects(admission);
  assert.equal(existsSync(f.worker.employeeControlFile), false);
  assert.equal(f.intent().active, false);
});

test("concept profile cannot enter ordinary tools or initialize an executor/worker", async () => {
  const f = fixture();
  const config = { students: [f.worker] };
  assert.throws(() => startToolWorker(config), /cannot initialize/);
  await assert.rejects(handleTool(config, f.worker, { operation: "list_files" }), /no tools/);
  await assert.rejects(runPythonJob(config, f.worker, { code: "synthetic" }), /no tool executor/);
  assert.equal(existsSync(f.worker.employeeControlFile), false);
});
