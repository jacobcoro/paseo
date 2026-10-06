// SYNTHETIC fixture child only. Never imports an SDK, provider or executor.
import { existsSync } from "node:fs";
import { read, durable, withEmployeeSubmitLease } from "./employee-control.mjs";
import { registerConceptDelivery, withdrawConceptText } from "./employee-concept-lifecycle.mjs";
import { createConceptHost } from "./employee-concept-host.mjs";
import { digest, conceptConfig } from "./employee-concept-profile.mjs";
const [operation, input] = process.argv.slice(2);
const { worker, signals, before, request, intentFile, agent } = read(input);
const tuple = Object.fromEntries(
  ["job_id", "producer_id", "revision"].map((key) => [key, worker.employeeScope[key]]),
);
async function wait(path) {
  const deadline = Date.now() + 4000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw Error("SOURCE_ONLY fixture coordination timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
try {
  if (operation === "create") {
    const fresh = () => ({ issued_ms: Date.now(), expires_ms: Date.now() + 30000 });
    const host = createConceptHost({
      authority: request.requested_by,
      intentFile,
      authorize: async () => ({
        kind: "root-authorized-concept-creation",
        approved_by: request.requested_by,
        root_receipt: "SOURCE_ONLY",
        revoked: false,
        intent_digest: digest(request),
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
        visible: true,
        internal: false,
        workspace_id: request.workspace_id,
        config: conceptConfig(request.tuple),
        scope: worker.employeeScope,
        ...fresh(),
      }),
      connect: async () => ({
        getLastServerInfoMessage: () => ({ features: { creationLifecycle: true } }),
        fetchAgent: async () => null,
        close: async () => {},
        createAgent: async () => {
          durable(signals.ready, {});
          await wait(signals.accept);
          return agent;
        },
      }),
    });
    await host.createPending(request);
  } else if (operation === "submit") {
    await withEmployeeSubmitLease(worker, tuple, async (nonce) => {
      if (before) {
        durable(signals.ready, {});
        await wait(signals.allow);
      }
      await registerConceptDelivery(worker, tuple, nonce, () => {
        durable(signals.sent, { producer_id: tuple.producer_id });
        durable(signals.ready, {});
        return wait(signals.accept);
      });
    });
  } else if (operation === "withdraw") await withdrawConceptText(worker, tuple);
  else throw Error("Unknown fixture operation");
  console.log("SOURCE_ONLY " + operation + " settled");
} catch {
  console.log("SOURCE_ONLY " + operation + " held");
  process.exitCode = 2;
}
