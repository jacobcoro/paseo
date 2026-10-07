// SOURCE_ONLY synthetic registered records, fake storage/manager and fixed clock.
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createConceptReaders } from "./employee-concept-readers.mjs";
import {
  conceptBoundaryChecks,
  conceptAssignmentFields,
  conceptConfig,
  digest,
} from "./employee-concept-profile.mjs";
import { durable } from "./employee-control.mjs";
export function fixture(agentId = "synthetic-agent") {
  if (!process.env.EMPLOYEE_CONCEPT_TEST_ROOT)
    throw Error("Select private SOURCE_ONLY fixture root");
  const folder = mkdtempSync(join(process.env.EMPLOYEE_CONCEPT_TEST_ROOT, "reader-"));
  const workspace = join(folder, "workspace"),
    host = join(folder, "host");
  mkdirSync(workspace, { mode: 0o700 });
  mkdirSync(host, { mode: 0o700 });
  const now = Date.now(),
    fresh = () => ({ issued_ms: now, expires_ms: now + 60000 });
  const target = { kind: "instance", home: join(host, "synthetic-instance") };
  const pins = ["host", "profile", "control", "client", "daemon", "provider", "sdk", "host_config"];
  const file = join(host, "source.txt");
  writeFileSync(file, "SOURCE_ONLY", { mode: 0o600 });
  const sha = createHash("sha256").update("SOURCE_ONLY").digest("hex");
  const sourceHashes = Object.fromEntries(pins.map((key) => [key, sha]));
  const paths = Object.fromEntries(
    [
      "owner",
      "registry",
      "creationApproval",
      "resumeApproval",
      "admissionApproval",
      "currentApproval",
      "precreation",
      "boundary",
      "resumeProof",
      "stopProof",
      "control",
      "tombstone",
      "submit",
    ].map((name) => [name, join(host, name + ".json")]),
  );
  const tuple = { cwd: workspace, model: "synthetic-model", thinking: "high", mode: "default" };
  const request = {
    requested_id: agentId,
    workspace_id: "synthetic-workspace",
    job_id: "job",
    revision: "revision",
    tuple,
    source_hashes: sourceHashes,
  };
  const info = {
    session_incarnation: "actual-fake-session",
    query_incarnation: "actual-fake-query",
    spawn: { pid: 123, child_incarnation: "actual-fake-child" },
    init: {
      native_session_id: "actual-fake-native",
      model: "synthetic-model",
      mode: "default",
      catalogs: Object.fromEntries(
        ["tools", "mcp_servers", "plugins", "slash_commands", "skills"].map((name) => [
          name,
          { status: "observed", raw: [] },
        ]),
      ),
    },
    delivery: { pending: 0, active: false, terminal: true },
    foreground_active: false,
    autonomous_active: false,
    permissions: 0,
    tool_calls: 0,
    queued_steers: 0,
  };
  const config = {
    authority: "synthetic-root",
    agentId,
    workspaceId: request.workspace_id,
    workspace,
    target,
    sourceHashes,
    sourceFiles: Object.fromEntries(pins.map((key) => [key, file])),
    paths,
  };
  const observed = {
    id: config.agentId,
    provider: "claude",
    cwd: workspace,
    workspaceId: config.workspaceId,
    visible: true,
    internal: false,
    status: "idle",
    native_session_id: "actual-fake-native",
    manager_generation: "actual-fake-manager",
    observed_ms: now,
    config: conceptConfig(tuple),
    runtimeInfo: {
      provider: "claude",
      sessionId: "actual-fake-native",
      model: "synthetic-model",
      modeId: "default",
      extra: { conceptText: info },
    },
  };
  const stored = {
    id: observed.id,
    provider: observed.provider,
    cwd: workspace,
    workspaceId: observed.workspaceId,
    internal: false,
    config: {
      model: tuple.model,
      thinkingOptionId: tuple.thinking,
      modeId: tuple.mode,
      providerOptions: { textOnly: true },
    },
  };
  const manager = {
    conceptOwnerGeneration: observed.manager_generation,
    observeConceptAgent: async () => structuredClone(observed),
  };
  const reader = createConceptReaders(config, {
    manager,
    storage: { getCurrent: () => structuredClone(stored) },
    liveOwner: () => ({ observer_generation: "actual-fake-lasting-observer" }),
    now: () => now,
  });
  const scope = {
    job_id: "job",
    revision: "revision",
    producer_id: observed.id,
    worker_id: observed.id,
    runtime_id: "registered-runtime",
    runtime_generation: observed.manager_generation,
    broker_id: "registered-broker",
    broker_generation: reader.brokerGeneration,
    worker_generation: info.session_incarnation,
  };
  const binding = Object.fromEntries(
    conceptAssignmentFields.map((key) => [key, "synthetic-" + key]),
  );
  Object.assign(binding, scope, {
    workspace_id: observed.workspaceId,
    model: tuple.model,
    thinking: tuple.thinking,
    mode: tuple.mode,
    provider: "claude",
    profile: "employee-concept-text",
    expires_ms: now + 60000,
  });
  const write = (key, value) => durable(paths[key], value);
  const root = (extra) => ({
    provenance: "independent-root-system-runtime-review",
    approved_by: config.authority,
    root_receipt: "SOURCE_ONLY_NOT_PROOF",
    source_hashes: sourceHashes,
    ...fresh(),
    ...extra,
  });
  write("owner", {
    kind: "registered-concept-runtime-owner",
    manager_generation: observed.manager_generation,
    broker_generation: reader.brokerGeneration,
    runtime_id: scope.runtime_id,
    broker_id: scope.broker_id,
    target,
    ...fresh(),
  });
  write("registry", {
    kind: "registered-exact-concept-job",
    scope,
    assignment: binding,
    request,
    target,
    ...fresh(),
  });
  const proof = root({
    kind: "independent-concept-text-boundary",
    scope,
    manager_generation: observed.manager_generation,
    session_incarnation: info.session_incarnation,
    query_incarnation: info.query_incarnation,
    child_incarnation: info.spawn.child_incarnation,
    native_session_id: info.init.native_session_id,
    native_model: info.init.model,
    pid: info.spawn.pid,
    checks: Object.fromEntries(
      [
        ...conceptBoundaryChecks,
        "workspace_prepared",
        "no_setup_or_restore",
        "stored_seal_current",
        "durable_inactive",
        "deny_new_tools",
        "inflight_launch_barrier",
        "no_owned_helpers",
      ].map((key) => [key, true]),
    ),
  });
  write("boundary", { ...proof, kind: "independent-concept-text-boundary" });
  write("resumeProof", { ...proof, kind: "independent-concept-resume-preflight" });
  const approval = root({
    kind: "root-concept-text-admission",
    binding,
    isolation_sha256: sha,
    quiescence_sha256: sha,
    revoked: false,
  });
  write("currentApproval", approval);
  const revoked = { ...scope, active: false, revoke_epoch: 1, revoke_nonce: "actual-fake-revoke" };
  write("control", revoked);
  write("tombstone", revoked);
  write("stopProof", {
    ...proof,
    kind: "independent-concept-text-revoke-quiescence",
    revoke_epoch: 1,
    revoke_nonce: revoked.revoke_nonce,
  });
  write(
    "creationApproval",
    root({
      kind: "root-authorized-concept-creation",
      intent_digest: digest(request),
      revoked: false,
    }),
  );
  write(
    "precreation",
    root({
      kind: "independent-current-concept-precreation",
      result: "passed",
      intent_digest: digest(request),
      target,
      manager_generation: observed.manager_generation,
      broker_generation: reader.brokerGeneration,
    }),
  );
  return {
    reader,
    config,
    request,
    observed,
    stored,
    binding,
    scope,
    info,
    proof,
    approval,
    revoked,
    write,
    root,
    fresh,
    paths,
  };
}
