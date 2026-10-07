// ONE host-only adapter. Configure/instantiate outside every actor workspace.
// No SDK connection, native query, endpoint discovery, credential read or registry writes.
import { readerApi } from "./employee-concept-reader-api.mjs";
import { held } from "./employee-control.mjs";
import { conceptBoundaryChecks, digest, same } from "./employee-concept-profile.mjs";
import { readerRecords, assertReaderRows } from "./employee-concept-reader-records.mjs";

const stamp = (observation) => {
  const value = observation.runtimeInfo.extra.conceptText;
  return {
    manager: observation.manager_generation,
    session: value.session_incarnation,
    query: value.query_incarnation,
    child: value.spawn?.child_incarnation,
    native: value.init?.native_session_id,
  };
};
const quietChecks = [
  "durable_inactive",
  "deny_new_tools",
  "inflight_launch_barrier",
  "no_owned_helpers",
];
export function createConceptReaders(config, { manager, storage, liveOwner, now = Date.now } = {}) {
  if (
    !config?.authority ||
    !config.agentId ||
    !config.target ||
    !config.paths ||
    !config.sourceHashes ||
    Object.keys(config.sourceHashes).length !== 8 ||
    Object.keys(config.sourceFiles || {})
      .sort()
      .join() !== Object.keys(config.sourceHashes).sort().join() ||
    typeof liveOwner !== "function" ||
    !manager?.observeConceptAgent ||
    !storage?.getCurrent
  )
    held();
  // Lasting actual daemon-owned observer, independently registered by Root later.
  const brokerGeneration = () => {
    const value = liveOwner();
    if (!value?.observer_generation) held();
    return value.observer_generation;
  };
  const records = readerRecords(config, now, brokerGeneration, manager);
  let withdrawnStamp = null;
  const time = () => ({ issued_ms: now(), expires_ms: now() + 4000 });
  const tuple = (request) =>
    request.tuple ?? {
      cwd: config.workspace,
      model: request.model,
      thinking: request.thinking,
      mode: request.mode,
    };
  const exactAgent = (request) => {
    const id = request.requested_id ?? request.producer_id;
    if (
      id !== config.agentId ||
      request.workspace_id !== config.workspaceId ||
      tuple(request).cwd !== config.workspace
    )
      held();
  };
  async function actual(request) {
    exactAgent(request);
    const owner = records.owner(),
      registry = records.file("registry");
    const stored = storage.getCurrent(config.agentId);
    const observed = await manager.observeConceptAgent(config.agentId);
    const again = storage.getCurrent(config.agentId);
    const info = assertReaderRows(
      stored,
      again,
      observed,
      registry,
      owner,
      config,
      request,
      tuple(request),
      now(),
      brokerGeneration(),
    );
    return { observed, registry, info };
  }
  function nativeZero(value) {
    const { info } = value;
    if (
      !info.query_incarnation ||
      !info.spawn?.child_incarnation ||
      !Number.isSafeInteger(info.spawn?.pid) ||
      !info.init?.native_session_id ||
      !info.init.model ||
      !info.init.mode ||
      value.observed.runtimeInfo.sessionId !== info.init.native_session_id ||
      value.observed.native_session_id !== info.init.native_session_id ||
      value.observed.runtimeInfo.model !== info.init.model ||
      value.observed.runtimeInfo.modeId !== info.init.mode ||
      info.permissions !== 0 ||
      info.tool_calls !== 0 ||
      ["tools", "mcp_servers", "plugins", "slash_commands", "skills"].some(
        (name) =>
          info.init.catalogs?.[name]?.status !== "observed" ||
          !Array.isArray(info.init.catalogs[name].raw) ||
          info.init.catalogs[name].raw.length !== 0,
      )
    )
      held();
  }
  function checked(value, name, keys = conceptBoundaryChecks) {
    nativeZero(value);
    const proof = records.proof(name, value.registry.scope, value.observed);
    if (keys.some((key) => proof.checks?.[key] !== true)) held();
    return proof;
  }
  async function authorize(request) {
    exactAgent(request);
    records.owner();
    const creating = Boolean(request.requested_id);
    const approval = records.root(creating ? "creationApproval" : "resumeApproval");
    const kind = creating ? "root-authorized-concept-creation" : "root-authorized-concept-resume";
    if (
      approval.kind !== kind ||
      approval.revoked !== false ||
      (creating && approval.intent_digest !== digest(request)) ||
      (!creating && !same(approval.binding, request))
    )
      held();
    return approval;
  }
  async function assertPrecreation(request, approval) {
    exactAgent(request);
    if (!same(approval, await authorize(request))) held();
    const owner = records.owner(),
      evidence = records.root("precreation");
    records.sources(evidence);
    if (
      evidence.kind !== "independent-current-concept-precreation" ||
      evidence.result !== "passed" ||
      evidence.intent_digest !== digest(request) ||
      evidence.manager_generation !== owner.manager_generation ||
      evidence.broker_generation !== brokerGeneration() ||
      !same(evidence.target, config.target)
    )
      held();
    return evidence;
  }
  async function observeOwner(request) {
    const value = await actual(request),
      { observed, registry } = value;
    const result = {
      kind: "independent-current-concept-owner",
      result: "passed",
      scope: registry.scope,
      visible: observed.visible,
      internal: observed.internal,
      workspace_id: observed.workspaceId,
      config: observed.config,
      source_hashes: config.sourceHashes,
      ...time(),
    };
    // Pending managed creation is distinct from native init. No zero-tool claim here.
    if (request.profile === "employee-concept-text") {
      const proof = checked(value, "boundary");
      if (!same(registry.assignment, request)) held();
      const resume = records.proof("resumeProof", registry.scope, observed);
      if (
        ["workspace_prepared", "no_setup_or_restore", "stored_seal_current"].some(
          (k) => resume.checks?.[k] !== true,
        ) ||
        value.info.delivery.terminal !== true ||
        value.info.delivery.active !== false ||
        observed.status !== "idle" ||
        value.info.foreground_active ||
        value.info.autonomous_active
      )
        held();
      Object.assign(result, {
        assignment: registry.assignment,
        checks: proof.checks,
        resume_checks: { ...resume.checks, native_idle: true },
      });
    }
    return result;
  }
  async function verifyAdmission(scope, approval, observed) {
    const receipt = records.root("admissionApproval");
    if (
      !same(receipt, approval) ||
      !same(scope, observed.scope) ||
      receipt.kind !== "independent-root-concept-admission" ||
      receipt.revoked !== false
    )
      held();
    const value = await actual(records.file("registry").request);
    checked(value, "boundary");
    if (
      !same(scope, value.registry.scope) ||
      !same(receipt.scope, scope) ||
      receipt.intent_digest !== digest(value.registry.request)
    )
      held();
    return receipt;
  }
  async function assertConceptCurrent(binding, approval) {
    const value = await actual(binding),
      proof = checked(value, "boundary");
    const root = records.root("currentApproval");
    if (
      !same(root, approval) ||
      root.kind !== "root-concept-text-admission" ||
      root.revoked !== false ||
      !same(root.binding, binding) ||
      !same(value.registry.assignment, binding)
    )
      held();
    return {
      kind: "independent-concept-text-current",
      result: "passed",
      binding,
      config: value.observed.config,
      visible: true,
      internal: false,
      checks: proof.checks,
      isolation_sha256: approval.isolation_sha256,
      quiescence_sha256: approval.quiescence_sha256,
      ...time(),
    };
  }
  async function assertConceptQuiescent(binding, revoked) {
    const value = await actual(binding);
    const proof = checked(value, "stopProof", [...conceptBoundaryChecks, ...quietChecks]);
    records.control(value.registry.scope, revoked);
    if (
      !same(value.registry.assignment, binding) ||
      proof.revoke_nonce !== revoked.revoke_nonce ||
      proof.revoke_epoch !== revoked.revoke_epoch ||
      value.info.queued_steers !== 0
    )
      held();
    withdrawnStamp = stamp(value.observed);
    return {
      kind: "independent-concept-text-quiescent",
      result: "passed",
      binding,
      revoke_epoch: revoked.revoke_epoch,
      revoke_nonce: revoked.revoke_nonce,
      checks: proof.checks,
      ...time(),
    };
  }
  async function observeConceptTerminal(binding, revoked) {
    const value = await actual(binding);
    const proof = checked(value, "stopProof", [...conceptBoundaryChecks, ...quietChecks]);
    if (proof.revoke_nonce !== revoked.revoke_nonce || proof.revoke_epoch !== revoked.revoke_epoch)
      held();
    records.control(value.registry.scope, revoked);
    if (
      !withdrawnStamp ||
      !same(stamp(value.observed), withdrawnStamp) ||
      value.info.delivery.terminal !== true ||
      value.info.delivery.active !== false ||
      value.info.delivery.pending !== 0 ||
      value.info.foreground_active ||
      value.info.autonomous_active ||
      value.observed.status !== "idle"
    )
      held();
    return {
      kind: "independent-concept-text-terminal",
      result: "passed",
      binding,
      revoke_epoch: revoked.revoke_epoch,
      revoke_nonce: revoked.revoke_nonce,
      delivery_terminal: true,
      native_idle: true,
      ...time(),
    };
  }
  return readerApi(
    {
      authorize,
      assertPrecreation,
      observeOwner,
      verifyAdmission,
      assertConceptCurrent,
      assertConceptQuiescent,
      observeConceptTerminal,
    },
    { actual, checked, records, config, manager, now, brokerGeneration },
  );
}
