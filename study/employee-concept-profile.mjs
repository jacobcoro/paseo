import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { fields, held } from "./employee-control.mjs";

export const conceptProfile = "employee-concept-text";
export const conceptBoundaryChecks = [
  "zero_builtin",
  "zero_mcp",
  "hooks_disabled",
  "settings_disabled",
  "plugins_disabled",
  "loaded_source_sdk_cli_plugin_config",
  "exact_native_generation",
  "credential_custody_outside_worker",
  "alternate_entrypoints_denied",
  "caller_assigned_read",
];
export const exact = (value, keys) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).sort().join() === [...keys].sort().join();
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])]),
    );
  return value;
}
export const digest = (value) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");
export const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export const fresh = (value, now, age = 5000) =>
  Number.isSafeInteger(value?.issued_ms) &&
  Number.isSafeInteger(value?.expires_ms) &&
  value.issued_ms <= now &&
  now - value.issued_ms <= age &&
  value.expires_ms > now;
export async function bounded(work, milliseconds = 8000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(Error("Concept outcome uncertain; reconcile without retry")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function conceptConfig(tuple) {
  if (
    !exact(tuple, ["cwd", "model", "thinking", "mode"]) ||
    !isAbsolute(tuple.cwd || "") ||
    Object.values(tuple).some(
      (value) =>
        typeof value !== "string" || !value.trim() || value !== value.trim() || value.length > 1000,
    )
  )
    held();
  return {
    provider: "claude",
    cwd: tuple.cwd,
    model: tuple.model,
    thinkingOptionId: tuple.thinking,
    modeId: tuple.mode,
    providerOptions: { textOnly: true },
  };
}

export function assertConceptSnapshot(agent, binding) {
  if (
    !agent ||
    agent.id !== binding.producer_id ||
    agent.provider !== "claude" ||
    agent.workspaceId !== binding.workspace_id ||
    agent.model !== binding.model ||
    agent.thinkingOptionId !== binding.thinking ||
    agent.currentModeId !== binding.mode ||
    agent.archivedAt ||
    agent.providerUnavailable ||
    agent.pendingPermissions?.length
  )
    held();
}

export function assertObservedConcept(observation, binding, config, now = Date.now()) {
  if (
    observation?.kind !== "independent-current-concept-owner" ||
    observation.result !== "passed" ||
    observation.visible !== true ||
    observation.internal !== false ||
    !same(observation.config, config) ||
    !exact(observation.scope, fields) ||
    fields.some(
      (key) =>
        typeof observation.scope[key] !== "string" ||
        !observation.scope[key] ||
        observation.scope[key].length > 200,
    ) ||
    observation.scope.producer_id !== binding.producer_id ||
    observation.scope.job_id !== binding.job_id ||
    observation.scope.revision !== binding.revision ||
    observation.workspace_id !== binding.workspace_id ||
    !fresh(observation, now)
  )
    held();
  return observation.scope; // Actual reader output only; never derive generations from intended IDs.
}

export const conceptAssignmentFields = [
  ...fields,
  "project",
  "brand",
  "experiment",
  "chat_id",
  "sender_id",
  "concept_thread",
  "review_thread",
  "subject",
  "tenant",
  "lark_profile",
  "workspace_id",
  "provider",
  "model",
  "thinking",
  "mode",
  "profile",
  "capability",
  "assignment_sha256",
  "packet_sha256",
  "source_manifest_sha256",
  "broker_config_sha256",
  "tool_catalog_sha256",
  "expires_ms",
];
export function assertConceptAssignment(binding, observed, now) {
  if (
    conceptAssignmentFields
      .filter((key) => key !== "expires_ms")
      .some(
        (key) => typeof binding[key] !== "string" || !binding[key] || binding[key].length > 1000,
      ) ||
    binding.capability !== "concept-refine" ||
    binding.concept_thread === binding.review_thread ||
    !Number.isSafeInteger(binding.expires_ms) ||
    binding.expires_ms <= now ||
    [
      "assignment_sha256",
      "packet_sha256",
      "source_manifest_sha256",
      "broker_config_sha256",
      "tool_catalog_sha256",
    ].some((key) => !/^[a-f0-9]{64}$/.test(binding[key])) ||
    !exact(observed.assignment, conceptAssignmentFields) ||
    conceptAssignmentFields.some((key) => observed.assignment[key] !== binding[key]) ||
    conceptBoundaryChecks.some((key) => observed.checks?.[key] !== true)
  )
    held();
}

export function assertConceptAdmission(admission, authority, actual, request, now) {
  if (
    admission?.kind !== "independent-root-concept-admission" ||
    admission.result !== "passed" ||
    admission.approved_by !== authority ||
    !admission.root_receipt ||
    admission.revoked !== false ||
    !same(admission.scope, actual) ||
    admission.intent_digest !== digest(request) ||
    !fresh(admission, now) ||
    !same(admission.source_hashes, request.source_hashes) ||
    conceptBoundaryChecks.some((key) => admission.checks?.[key] !== true)
  )
    held();
}
