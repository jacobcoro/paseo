// Fixed trusted host paths only; never accept file/target selection from actor input.
import { lstatSync, realpathSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
import { fields, held, read } from "./employee-control.mjs";
import { fresh, same, conceptConfig } from "./employee-concept-profile.mjs";

export function privatePath(path, workspace) {
  if (!isAbsolute(path || "") || !isAbsolute(workspace || "")) held();
  const parent = dirname(path),
    inside = relative(workspace, parent),
    st = lstatSync(parent);
  if (
    !inside ||
    (!inside.startsWith("../") && inside !== "..") ||
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== process.getuid() ||
    st.mode & 0o077 ||
    realpathSync(parent) !== parent
  )
    held();
  return path;
}
export function readerRecords(config, now, brokerGeneration, manager) {
  const file = (name) => read(privatePath(config.paths[name], config.workspace));
  const absent = (name) => !existsSync(privatePath(config.paths[name], config.workspace));
  function owner() {
    const value = file("owner");
    if (
      value.kind !== "registered-concept-runtime-owner" ||
      !fresh(value, now()) ||
      value.manager_generation !== manager.conceptOwnerGeneration ||
      value.broker_generation !== brokerGeneration() ||
      !value.runtime_id ||
      !value.broker_id ||
      !same(value.target, config.target)
    )
      held();
    return value;
  }
  function root(name) {
    const value = file(name);
    if (
      value.provenance !== "independent-root-system-runtime-review" ||
      value.approved_by !== config.authority ||
      !value.root_receipt ||
      !fresh(value, now())
    )
      held();
    return value;
  }
  function sources(value) {
    if (!same(value.source_hashes, config.sourceHashes)) held();
    for (const [key, path] of Object.entries(config.sourceFiles)) {
      privatePath(path, config.workspace);
      const st = lstatSync(path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.size > 16 * 1024 * 1024 ||
        createHash("sha256").update(readFileSync(path)).digest("hex") !== config.sourceHashes[key]
      )
        held();
    }
  }
  function proof(name, scope, observed) {
    const kinds = {
      boundary: "independent-concept-text-boundary",
      resumeProof: "independent-concept-resume-preflight",
      stopProof: "independent-concept-text-revoke-quiescence",
    };
    const value = root(name);
    sources(value);
    if (value.kind !== kinds[name]) held();
    const actual = observed.runtimeInfo.extra.conceptText;
    if (
      !same(value.scope, scope) ||
      value.manager_generation !== observed.manager_generation ||
      value.session_incarnation !== actual.session_incarnation ||
      value.query_incarnation !== actual.query_incarnation ||
      value.child_incarnation !== actual.spawn?.child_incarnation ||
      value.native_session_id !== actual.init?.native_session_id ||
      value.native_model !== actual.init?.model ||
      value.pid !== actual.spawn?.pid
    )
      held();
    return value;
  }
  function control(scope, revoked) {
    const value = file("control"),
      tombstone = file("tombstone");
    if (
      fields.some((key) => value[key] !== scope[key] || tombstone[key] !== scope[key]) ||
      value.active !== false ||
      tombstone.active !== false ||
      !value.revoke_nonce ||
      value.revoke_nonce !== revoked.revoke_nonce ||
      value.revoke_epoch !== revoked.revoke_epoch ||
      tombstone.revoke_nonce !== value.revoke_nonce ||
      tombstone.revoke_epoch !== value.revoke_epoch ||
      !absent("submit")
    )
      held();
    return value;
  }
  return { file, absent, owner, root, sources, proof, control };
}

function snapshotRows(stored, observed, config, owner, tuple, now) {
  const pairs = [
    [observed.id, stored.id],
    [stored.id, config.agentId],
    [observed.provider, "claude"],
    [observed.visible, true],
    [observed.internal, false],
    [stored.internal === true, false],
    [observed.workspaceId, stored.workspaceId],
    [stored.workspaceId, config.workspaceId],
    [observed.cwd, stored.cwd],
    [stored.cwd, config.workspace],
    [observed.manager_generation, owner.manager_generation],
    [observed.config, conceptConfig(tuple)],
  ];
  if (
    pairs.some(([a, b]) => !same(a, b)) ||
    !Number.isSafeInteger(observed.observed_ms) ||
    now - observed.observed_ms < 0 ||
    now - observed.observed_ms > 4000
  )
    held();
  const sealed = {
    provider: stored.provider,
    cwd: stored.cwd,
    model: stored.config?.model,
    thinkingOptionId: stored.config?.thinkingOptionId,
    modeId: stored.config?.modeId,
    providerOptions: stored.config?.providerOptions,
  };
  if (
    !same(sealed, observed.config) ||
    (stored.config?.mcpServers && Object.keys(stored.config.mcpServers).length) ||
    stored.config?.toolPolicy ||
    stored.config?.systemPrompt
  )
    held();
}
export function assertReaderRows(
  stored,
  again,
  observed,
  registry,
  owner,
  config,
  request,
  tuple,
  now,
  brokerGeneration,
) {
  const info = observed?.runtimeInfo?.extra?.conceptText;
  if (!stored || !same(stored, again) || !observed || !info || !registry.scope) held();
  snapshotRows(stored, observed, config, owner, tuple, now);
  const scope = registry.scope;
  const pairs = [
    [scope.producer_id, observed.id],
    [scope.worker_id, observed.id],
    [scope.runtime_id, owner.runtime_id],
    [scope.broker_id, owner.broker_id],
    [scope.runtime_generation, observed.manager_generation],
    [scope.broker_generation, brokerGeneration],
    [scope.worker_generation, info.session_incarnation],
    [scope.job_id, request.job_id],
    [scope.revision, request.revision],
    [registry.target, config.target],
  ];
  if (
    !fresh(registry, now) ||
    registry.kind !== "registered-exact-concept-job" ||
    pairs.some(([a, b]) => !same(a, b)) ||
    fields.some((key) => typeof scope[key] !== "string" || !scope[key])
  )
    held();
  return info;
}
