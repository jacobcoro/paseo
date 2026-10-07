import { held } from "./employee-control.mjs";
// Uses the same core boundary checks; never use aggregate stop settlement as success.
export function completionReader(actual, checked, records, config, now, assertCurrent) {
  return async (binding, deliveredRequest) => {
    await assertCurrent(binding, records.file("currentApproval"));
    const value = await actual(binding);
    checked(value, "boundary");
    const registered = value.registry.assignment;
    if (JSON.stringify(registered) !== JSON.stringify(binding)) held();
    const native = value.info.completion,
      committed = value.observed.committed_completion;
    if (
      !native ||
      !committed ||
      !deliveredRequest?.clientMessageId ||
      !deliveredRequest.turnId ||
      !exactNative(native, value.info, deliveredRequest) ||
      Object.keys(native).some((key) => committed[key] !== native[key]) ||
      !committed.epoch ||
      !Number.isSafeInteger(committed.cursor) ||
      committed.cursor <= committed.user_cursor ||
      committed.committed !== true ||
      !quiet(value.info)
    )
      held();
    await assertCurrent(binding, records.file("currentApproval"));
    const after = await actual(binding);
    checked(after, "boundary");
    if (!sameCompletion(after, value, committed)) held();
    const approval = records.root("currentApproval");
    if (approval.revoked !== false || JSON.stringify(approval.binding) !== JSON.stringify(binding))
      held();
    records.owner();
    records.sources(records.proof("boundary", value.registry.scope, value.observed));
    return {
      kind: "observed-exact-concept-completion",
      scope: value.registry.scope,
      delivered_request: deliveredRequest,
      completion: committed,
      manager_generation: value.observed.manager_generation,
      session_incarnation: value.info.session_incarnation,
      child_incarnation: value.info.spawn.child_incarnation,
      broker_generation: records.owner().broker_generation,
      native_model: value.info.init.model,
      observed_ms: now(),
      source_hashes: config.sourceHashes,
    };
  };
}

function exactNative(native, info, request) {
  return [
    [native.client_message_id, request.clientMessageId],
    [native.provider_turn_id, request.turnId],
    [native.query_incarnation, info.query_incarnation],
    [native.native_session_id, info.init?.native_session_id],
    [native.result_subtype, "success"],
    [native.is_error, false],
    [native.provenance, "sdk_success_result"],
  ].every(([actual, expected]) => actual === expected);
}
function quiet(info) {
  return [
    [info.delivery?.terminal, true],
    [info.delivery?.active, false],
    [info.delivery?.pending, 0],
    [info.foreground_active, false],
    [info.autonomous_active, false],
    [info.queued_steers, 0],
  ].every(([actual, expected]) => actual === expected);
}

function sameCompletion(after, before, committed) {
  return (
    JSON.stringify(after.observed.committed_completion) === JSON.stringify(committed) &&
    [
      [after.info.session_incarnation, before.info.session_incarnation],
      [after.info.spawn?.child_incarnation, before.info.spawn?.child_incarnation],
      [after.observed.manager_generation, before.observed.manager_generation],
    ].every(([actual, expected]) => actual === expected) &&
    quiet(after.info)
  );
}
