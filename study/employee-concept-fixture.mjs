// SOURCE_ONLY isolated synthetic values; passing this cannot certify a runtime.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { fields, durable, read } from "./employee-control.mjs";
import { conceptConfig, digest, conceptBoundaryChecks } from "./employee-concept-profile.mjs";
import { createConceptHost } from "./employee-concept-host.mjs";

export function fixture(options = {}) {
  if (!process.env.EMPLOYEE_CONCEPT_TEST_ROOT) throw Error("Select private synthetic fixture root");
  const folder = mkdtempSync(join(process.env.EMPLOYEE_CONCEPT_TEST_ROOT, "concept-"));
  const cwd = join(folder, "workspace"),
    host = join(folder, "host");
  mkdirSync(cwd, { mode: 0o700 });
  mkdirSync(host, { mode: 0o700 });
  const now = Date.now(),
    calls = [];
  const request = {
    job_id: "synthetic-job",
    revision: "synthetic-revision",
    requested_id: randomUUID(),
    creation_nonce: randomUUID(),
    idempotency_key: randomUUID(),
    workspace_id: "synthetic-workspace",
    daemon_target: { kind: "instance", home: join(host, "synthetic-daemon") },
    tuple: {
      cwd,
      model: "synthetic-model",
      thinking: "synthetic-thinking",
      mode: "synthetic-mode",
    },
    source_hashes: Object.fromEntries(
      ["host", "profile", "control", "client", "daemon", "provider", "sdk", "host_config"].map(
        (key) => [key, "a".repeat(64)],
      ),
    ),
    expires_ms: now + 60000,
    requested_by: "synthetic-root",
    config_sha256: "",
  };
  request.config_sha256 = digest(conceptConfig(request.tuple));
  const actual = Object.fromEntries(fields.map((key) => [key, "observed-synthetic-" + key]));
  Object.assign(actual, {
    producer_id: request.requested_id,
    job_id: request.job_id,
    revision: request.revision,
  });
  const worker = {
    id: actual.worker_id,
    profile: "employee-concept-text",
    provider: "claude",
    workspacePath: cwd,
    employeeScope: actual,
    employeeControlFile: join(host, "control.json"),
  };
  const agent = {
    id: request.requested_id,
    provider: "claude",
    workspaceId: request.workspace_id,
    model: request.tuple.model,
    thinkingOptionId: request.tuple.thinking,
    currentModeId: request.tuple.mode,
    status: "idle",
  };
  const fresh = () => ({ issued_ms: now, expires_ms: now + 60000 });
  const client = {
    getLastServerInfoMessage: () => ({ features: { creationLifecycle: true } }),
    fetchAgent: async () => null,
    createAgent: async (input) => {
      calls.push(["create", input]);
      assert.deepEqual(Object.keys(input).sort(), [
        "agentId",
        "config",
        "idempotencyKey",
        "workspaceId",
      ]);
      assert.equal(read(join(host, "intent.json")).active, false);
      return agent;
    },
    close: async () => {
      calls.push(["close"]);
    },
  };
  const args = {
    authority: request.requested_by,
    intentFile: join(host, "intent.json"),
    now: () => now,
    authorize: async () => ({
      kind: "root-authorized-concept-creation",
      approved_by: request.requested_by,
      intent_digest: digest(request),
      root_receipt: "SOURCE_ONLY",
      revoked: false,
      ...fresh(),
    }),
    assertPrecreation: async () => ({
      kind: "independent-current-concept-precreation",
      result: "passed",
      intent_digest: digest(request),
      source_hashes: request.source_hashes,
      ...fresh(),
    }),
    observeOwner: async () => ({
      kind: "independent-current-concept-owner",
      result: "passed",
      scope: actual,
      visible: true,
      internal: false,
      workspace_id: request.workspace_id,
      config: conceptConfig(request.tuple),
      ...fresh(),
    }),
    verifyAdmission: async () => ({
      kind: "independent-root-concept-admission",
      result: "passed",
      approved_by: request.requested_by,
      root_receipt: "SOURCE_ONLY",
      revoked: false,
      scope: actual,
      intent_digest: digest(request),
      source_hashes: request.source_hashes,
      checks: Object.fromEntries(conceptBoundaryChecks.map((key) => [key, true])),
      ...fresh(),
    }),
    connect: async () => {
      calls.push(["connect"]);
      return client;
    },
    ...options,
  };
  return {
    request,
    actual,
    worker,
    agent,
    client,
    args,
    calls,
    now,
    folder,
    host: () => createConceptHost(args),
    intent: () => read(args.intentFile),
    activate: () =>
      durable(worker.employeeControlFile, {
        ...actual,
        active: true,
        expires_ms: now + 60000,
        revoke_epoch: 0,
        revoke_nonce: null,
      }),
  };
}
