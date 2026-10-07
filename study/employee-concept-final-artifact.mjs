import { lstatSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { privatePath } from "./employee-concept-reader-records.mjs";
import { same } from "./employee-concept-profile.mjs";
import { held, read } from "./employee-control.mjs";
// Only the fixed selected artifact uses this bound (64KiB UTF8 text may JSON-escape 6x).
export function readFinalArtifact(path) {
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    st.mode & 0o077 ||
    st.size > 458752
  )
    held();
  return JSON.parse(readFileSync(path, "utf8"));
}

export function validateVisibleFinal(text, sha256) {
  if (typeof text !== "string") held();
  const bytes = Buffer.from(text, "utf8");
  if (
    bytes.length > 65536 ||
    bytes.toString("utf8") !== text ||
    createHash("sha256").update(bytes).digest("hex") !== sha256
  )
    held();
}
export function selectedFinalArtifact(selected, completion, { frame, host, pin, now }) {
  const before = frame(selected),
    name = createHash("sha256").update(selected.id).digest("hex") + ".final.json";
  const artifact = readFinalArtifact(privatePath(host.outputDir + "/" + name, selected.workspace)),
    after = frame(selected);
  const pairs = [
    [artifact.kind, "actual-concept-selected-final"],
    [artifact.state, "current"],
    [artifact.id, selected.id],
    [artifact.target, host.target],
    [artifact.config_sha256, pin],
    [artifact.server_id, before.server_id],
    [artifact.manager_generation, before.manager_generation],
    [artifact.observer_generation, before.observer_generation],
    [artifact.daemon_pid, before.daemon_pid],
    [artifact.final?.completion, completion],
    [artifact.final?.broker_generation, before.observer_generation],
  ];
  if (
    pairs.some(([actual, expected]) => !same(actual, expected)) ||
    artifact.expires_ms <= now() ||
    !Number.isSafeInteger(artifact.observed_ms) ||
    artifact.observed_ms > now() ||
    now() - artifact.observed_ms > 4000 ||
    !same(before, after)
  )
    held();
  const registry = read(privatePath(selected.reader.paths.registry, selected.workspace)),
    native = before.observation.runtimeInfo.extra.conceptText;
  const final = artifact.final;
  if (
    [
      [final.kind, "observed-selected-concept-final"],
      [final.scope, registry.scope],
      [before.observation.committed_completion, completion],
      [final.manager_generation, before.manager_generation],
      [final.session_incarnation, native.session_incarnation],
      [final.child_incarnation, native.spawn?.child_incarnation],
      [final.native_model, native.init?.model],
      [final.source_hashes, selected.reader.sourceHashes],
    ].some(([actual, expected]) => !same(actual, expected))
  )
    held();
  return {
    text: final.text,
    completion: final.completion,
    manager_generation: artifact.manager_generation,
  };
}
