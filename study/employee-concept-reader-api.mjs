import { completionReader } from "./employee-concept-completion.mjs";
import { finalReader } from "./employee-concept-final.mjs";
export function readerApi(callbacks, context) {
  const { actual, checked, records, config, manager, now, brokerGeneration } = context;
  const completion = completionReader(
    actual,
    checked,
    records,
    config,
    now,
    callbacks.assertConceptCurrent,
  );
  return {
    ...callbacks,
    get brokerGeneration() {
      return brokerGeneration();
    },
    observeConceptCompletion: completion,
    readConceptFinal: finalReader(actual, completion, records, config, manager),
  };
}
