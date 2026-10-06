// Root-only exact-ID reload. Never route resumeAgent(handle), which allocates a new ID.
import { performance } from "node:perf_hooks";
import { isAbsolute } from "node:path";
import {
  fields,
  held,
  assertEmployeeControl,
  withEmployeeSubmitLease,
  scope,
} from "./employee-control.mjs";
import { registerConceptDelivery } from "./employee-concept-lifecycle.mjs";
import {
  assertConceptAssignment,
  conceptConfig,
  conceptProfile,
  assertConceptSnapshot,
  assertObservedConcept,
  exact,
  same,
  fresh,
  bounded,
} from "./employee-concept-profile.mjs";

function resumeConfig(binding, worker) {
  if (
    !exact(binding.daemon_target, ["kind", "home"]) ||
    binding.daemon_target.kind !== "instance" ||
    !isAbsolute(binding.daemon_target.home || "") ||
    !exact(binding.source_hashes, [
      "host",
      "profile",
      "control",
      "client",
      "daemon",
      "provider",
      "sdk",
      "host_config",
    ]) ||
    Object.values(binding.source_hashes).some(
      (value) => typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value),
    )
  )
    held();
  const config = conceptConfig(binding.tuple);
  if (
    config.cwd !== worker.workspacePath ||
    config.model !== binding.model ||
    config.modeId !== binding.mode ||
    config.thinkingOptionId !== binding.thinking
  )
    held();
  return config;
}

export async function resumeConceptExact({
  binding,
  worker,
  authority,
  authorize,
  observeOwner,
  connect,
  now = Date.now,
} = {}) {
  if (
    worker?.profile !== conceptProfile ||
    worker.provider !== "claude" ||
    binding?.profile !== conceptProfile ||
    binding.provider !== "claude" ||
    !authority ||
    fields.some((key) => !binding[key] || scope(worker)[key] !== binding[key]) ||
    ![authorize, observeOwner, connect].every((fn) => typeof fn === "function")
  )
    held();
  const config = resumeConfig(binding, worker);
  const assignment = Object.fromEntries(
    ["job_id", "producer_id", "revision"].map((key) => [key, binding[key]]),
  );
  async function preflight() {
    const approval = await authorize(binding);
    if (
      approval?.kind !== "root-authorized-concept-resume" ||
      approval.approved_by !== authority ||
      !approval.root_receipt ||
      approval.revoked !== false ||
      !same(approval.binding, binding) ||
      !fresh(approval, now())
    )
      held();
    const observed = await observeOwner(binding, approval);
    const actual = assertObservedConcept(observed, binding, config, now());
    assertConceptAssignment(binding, observed, now());
    if (
      !same(actual, scope(worker)) ||
      !same(observed.source_hashes, binding.source_hashes) ||
      ["workspace_prepared", "no_setup_or_restore", "native_idle", "stored_seal_current"].some(
        (key) => observed.resume_checks?.[key] !== true,
      )
    )
      held();
  }
  const deadline = performance.now() + 8000;
  const live = () => {
    if (performance.now() >= deadline) held();
  };
  const run = (fn) => bounded(fn, Math.max(1, Math.floor(deadline - performance.now())));
  await run(preflight); // Current independent proof BEFORE client access.
  return withEmployeeSubmitLease(worker, assignment, (nonce) =>
    run(async () => {
      await preflight();
      if (assertEmployeeControl(worker, assignment).expires_ms !== binding.expires_ms) held();
      let client;
      try {
        live();
        client = await connect({ target: binding.daemon_target, timeout: 1500 });
        live();
        const agent = (await client.fetchAgent({ agentId: binding.producer_id }))?.agent;
        assertConceptSnapshot(agent, binding);
        if (agent.status !== "idle") held();
        await preflight();
        // Native refresh revalidates the persisted constructor in the accepted manager.
        const result = await registerConceptDelivery(worker, assignment, nonce, () => {
          live();
          return client.refreshAgent(binding.producer_id);
        });
        if (result?.agentId !== binding.producer_id || result.status !== "agent_refreshed") held();
        const refreshed = (await client.fetchAgent({ agentId: binding.producer_id }))?.agent;
        assertConceptSnapshot(refreshed, binding);
        if (refreshed.status !== "idle") held();
        await preflight();
        return { producer_id: binding.producer_id, resumed: true };
      } finally {
        if (client) await bounded(() => client.close(), 250);
      }
    }),
  );
}
