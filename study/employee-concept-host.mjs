// Trusted ROOT-only source API; never imported by actor intake or dispatcher.
import { existsSync } from "node:fs";
import { pendingPath, pendingState, validate } from "./employee-concept-intent.mjs";
import { performance } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import { durable, exclusive, lease, held, root, fields } from "./employee-control.mjs";
import {
  conceptConfig,
  assertConceptSnapshot,
  assertObservedConcept,
  exact,
  same,
  digest,
  conceptProfile,
  fresh,
  bounded,
  assertConceptAdmission,
} from "./employee-concept-profile.mjs";

export function createConceptHost({
  authority,
  intentFile,
  authorize,
  assertPrecreation,
  observeOwner,
  verifyAdmission,
  connect,
  now = Date.now,
  timeoutMs = 8000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 8000) held();
  const state = (request) => pendingState(intentFile, request);
  async function trusted(request) {
    const config = validate(request, authority, now());
    if (
      ![authorize, assertPrecreation, observeOwner, connect].every((fn) => typeof fn === "function")
    )
      held();
    const approval = await authorize(request);
    if (
      approval?.kind !== "root-authorized-concept-creation" ||
      approval.approved_by !== authority ||
      approval.intent_digest !== digest(request) ||
      approval.revoked !== false ||
      !approval.root_receipt ||
      !fresh(approval, now(), 300000)
    )
      held();
    const boundary = await assertPrecreation(request, approval);
    if (
      boundary?.kind !== "independent-current-concept-precreation" ||
      boundary.result !== "passed" ||
      boundary.intent_digest !== digest(request) ||
      !same(boundary.source_hashes, request.source_hashes) ||
      !fresh(boundary, now())
    )
      held();
    return config;
  }
  const writer = (fn) => lease(intentFile + ".writer", fn, performance.now() + 1000);
  return {
    async createPending(request) {
      const deadline = performance.now() + timeoutMs;
      const live = () => {
        if (performance.now() >= deadline) held();
      };
      return bounded(async () => {
        const config = await trusted(request),
          path = pendingPath(intentFile, request.tuple.cwd);
        if (existsSync(path) || existsSync(path + ".revoked")) held();
        const release = exclusive(path + ".create", {
          nonce: request.creation_nonce,
          intent_digest: digest(request),
        });
        let accepted = false,
          client;
        try {
          await writer(() => {
            if (existsSync(path) || existsSync(path + ".revoked")) held();
            durable(path, {
              kind: "root-concept-pending",
              active: false,
              request,
              creation_nonce: request.creation_nonce,
              intent_digest: digest(request),
              phase: "pending",
              revoke_epoch: 0,
              revoke_nonce: null,
            });
          });
          client = await connect({ target: request.daemon_target, timeout: 1500 });
          live();
          if (client.getLastServerInfoMessage()?.features?.creationLifecycle !== true) held();
          if ((await client.fetchAgent({ agentId: request.requested_id }))?.agent) held();
          await trusted(request);
          let acceptance;
          await writer(() => {
            live();
            const current = state(request);
            if (current.revoke_nonce || existsSync(path + ".revoked")) held();
            durable(path, { ...current, phase: "creating" });
            // Register acceptance synchronously under writer, then release it before waiting.
            acceptance = client.createAgent({
              agentId: request.requested_id,
              idempotencyKey: request.idempotency_key,
              workspaceId: request.workspace_id,
              config,
            });
          });
          const agent = await acceptance;
          live();
          const binding = {
            producer_id: request.requested_id,
            workspace_id: request.workspace_id,
            job_id: request.job_id,
            revision: request.revision,
            ...request.tuple,
          };
          assertConceptSnapshot(agent, binding);
          const observation = await observeOwner(request, agent);
          const scope = assertObservedConcept(observation, binding, config, now());
          await writer(() => {
            live();
            const current = state(request);
            durable(path, {
              ...current,
              phase: current.revoke_nonce ? "withdrawn-accepted" : "accepted-inactive",
              accepted_id: agent.id,
              observed_scope: scope,
            });
            if (current.revoke_nonce || existsSync(path + ".revoked")) held();
            accepted = true;
          });
          return {
            status: "accepted-inactive",
            requested_id: request.requested_id,
            creation_nonce: request.creation_nonce,
          };
        } finally {
          if (accepted) release(); // Any ambiguity retains ownership; no retry or stale steal.
          if (client) await bounded(() => client.close(), 250);
        }
      }, timeoutMs);
    },
    async admitInactive(request, worker, approval) {
      const deadline = performance.now() + timeoutMs;
      return bounded(async () => {
        await trusted(request);
        if (typeof verifyAdmission !== "function") held();
        const current = state(request);
        if (current.phase !== "accepted-inactive" || existsSync(intentFile + ".create")) held();
        const observed = await observeOwner(request, { id: current.accepted_id });
        const binding = {
          producer_id: current.accepted_id,
          workspace_id: request.workspace_id,
          job_id: request.job_id,
          revision: request.revision,
          ...request.tuple,
        };
        const actual = assertObservedConcept(
          observed,
          binding,
          conceptConfig(request.tuple),
          now(),
        );
        if (
          worker.profile !== conceptProfile ||
          worker.provider !== "claude" ||
          worker.workspacePath !== request.tuple.cwd ||
          !exact(worker.employeeScope, fields) ||
          !same(worker.employeeScope, actual) ||
          worker.id !== actual.worker_id
        )
          held();
        const admission = await verifyAdmission(actual, approval, observed);
        assertConceptAdmission(admission, authority, actual, request, now());
        return writer(async () => {
          if (performance.now() >= deadline) held();
          const latest = state(request);
          if (
            latest.revoke_nonce ||
            existsSync(intentFile + ".revoked") ||
            latest.phase !== "accepted-inactive"
          )
            held();
          const path = root(worker);
          return lease(
            path + ".writer",
            () => {
              if (existsSync(path) || existsSync(path + ".revoked")) held();
              durable(path, {
                ...actual,
                active: false,
                expires_ms: request.expires_ms,
                revoke_epoch: 0,
                revoke_nonce: null,
              });
              durable(intentFile, { ...latest, phase: "admitted-inactive" });
              return { status: "admitted-inactive", scope: actual }; // Never writes an active actor assignment.
            },
            performance.now() + 1000,
          );
        });
      }, timeoutMs);
    },
    async withdrawPending(request) {
      validate(request, authority, Number.MIN_SAFE_INTEGER); // Owned withdrawal survives expiry/revoked approval.
      pendingPath(intentFile, request.tuple.cwd);
      return writer(() => {
        const current = state(request);
        const inactive = {
          ...current,
          active: false,
          phase: "withdrawn",
          revoke_epoch: current.revoke_nonce ? current.revoke_epoch : current.revoke_epoch + 1,
          revoke_nonce: current.revoke_nonce || randomUUID(),
        };
        durable(intentFile, inactive);
        durable(intentFile + ".revoked", inactive);
        return { status: "withdrawn", quiescent: false }; // Pending/late SDK acceptance is not a stopped claim.
      });
    },
  };
}
