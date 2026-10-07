// Fixed private fork layouts only; no discovery or actor-selected module path.
export function conceptFinalHandoffModuleUrl(handoffModule: URL): URL {
  if (handoffModule.protocol !== "file:" || handoffModule.search || handoffModule.hash)
    throw Error("Unknown concept handoff module layout");
  if (handoffModule.pathname.endsWith("/packages/server/src/server/agent/concept-handoff.ts"))
    return new URL("../../../../../study/employee-concept-final-handoff.mjs", handoffModule);
  if (
    handoffModule.pathname.endsWith("/packages/server/dist/server/server/agent/concept-handoff.js")
  )
    return new URL("../../../../../../study/employee-concept-final-handoff.mjs", handoffModule);
  throw Error("Unknown concept handoff module layout");
}
