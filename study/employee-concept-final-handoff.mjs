import { createConceptReaders } from "./employee-concept-readers.mjs";
import { privatePath } from "./employee-concept-reader-records.mjs";
import { read, held } from "./employee-control.mjs";
// Same actual daemon objects; trusted Root-selected config. No new manager/endpoint.
export async function selectedFinalForHandoff(selected, dependencies) {
  if (selected.finalText !== "sdk-success-result") return null;
  const config = selected.reader;
  if (
    config.agentId !== selected.id ||
    config.workspace !== selected.workspace ||
    config.workspaceId !== selected.workspaceId
  )
    held();
  const registry = read(privatePath(config.paths.registry, config.workspace));
  const observation = await dependencies.manager.observeConceptAgent(selected.id);
  const completion = observation?.runtimeInfo?.extra?.conceptText?.completion;
  if (!completion || !registry.assignment) held();
  const reader = createConceptReaders(config, dependencies);
  return reader.readConceptFinal(registry.assignment, {
    clientMessageId: completion.client_message_id,
  });
}
