import { validateVisibleFinal } from "./employee-concept-final-artifact.mjs";
import { held } from "./employee-control.mjs";
import { same } from "./employee-concept-profile.mjs";
// Exact accepted client ID only. Desired turn, filename or timeline selectors are absent.
export function finalReader(actual, completionReader, records, config, manager) {
  return async (binding, request) => {
    if (
      !request ||
      Object.keys(request).join() !== "clientMessageId" ||
      typeof request.clientMessageId !== "string" ||
      !request.clientMessageId
    )
      held();
    const current = await actual(binding),
      native = current.info.completion;
    if (
      !native ||
      native.client_message_id !== request.clientMessageId ||
      !manager.readConceptFinalText
    )
      held();
    const delivered = { clientMessageId: request.clientMessageId, turnId: native.provider_turn_id };
    const before = await completionReader(binding, delivered);
    const result = await manager.readConceptFinalText(config.agentId, before.completion);
    if (
      !result ||
      typeof result.text !== "string" ||
      !same(result.completion, before.completion) ||
      result.manager_generation !== before.manager_generation
    )
      held();
    validateVisibleFinal(result.text, before.completion.text_sha256);
    const after = await completionReader(binding, delivered);
    if (
      !same(after.completion, before.completion) ||
      !same(after.scope, before.scope) ||
      [
        "manager_generation",
        "session_incarnation",
        "child_incarnation",
        "broker_generation",
        "native_model",
      ].some((key) => after[key] !== before[key]) ||
      after.scope.revision !== binding.revision
    )
      held();
    const approval = records.root("currentApproval");
    if (approval.revoked !== false || !same(approval.binding, binding)) held();
    return {
      kind: "observed-selected-concept-final",
      scope: before.scope,
      client_message_id: request.clientMessageId,
      completion: before.completion,
      manager_generation: before.manager_generation,
      session_incarnation: before.session_incarnation,
      child_incarnation: before.child_incarnation,
      broker_generation: before.broker_generation,
      native_model: before.native_model,
      source_hashes: before.source_hashes,
      text: result.text,
    };
  };
}
