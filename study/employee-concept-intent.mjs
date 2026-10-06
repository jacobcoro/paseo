import { existsSync, lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { read, held } from "./employee-control.mjs";
import { exact, same, digest, conceptConfig } from "./employee-concept-profile.mjs";
const KEYS = [
  "job_id",
  "revision",
  "requested_id",
  "creation_nonce",
  "idempotency_key",
  "workspace_id",
  "daemon_target",
  "tuple",
  "source_hashes",
  "config_sha256",
  "expires_ms",
  "requested_by",
];
const uuid = (value) =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);

export function pendingPath(path, workspace) {
  if (!isAbsolute(path || "")) held();
  const parent = dirname(path),
    st = lstatSync(parent),
    inside = relative(workspace, parent);
  if (
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== process.getuid() ||
    st.mode & 0o077 ||
    realpathSync(parent) !== parent ||
    !inside ||
    (!inside.startsWith("../") && inside !== "..")
  )
    held();
  return path;
}

export function validate(request, authority, now) {
  if (
    !authority ||
    !exact(request, KEYS) ||
    request.requested_by !== authority ||
    !uuid(request.requested_id) ||
    !uuid(request.creation_nonce) ||
    ![request.job_id, request.revision, request.idempotency_key, request.workspace_id].every(
      (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
    ) ||
    !exact(request.daemon_target, ["kind", "home"]) ||
    request.daemon_target.kind !== "instance" ||
    !isAbsolute(request.daemon_target.home || "") ||
    !Number.isSafeInteger(request.expires_ms) ||
    request.expires_ms <= now ||
    !exact(request.source_hashes, [
      "host",
      "profile",
      "control",
      "client",
      "daemon",
      "provider",
      "sdk",
      "host_config",
    ]) ||
    Object.values(request.source_hashes).some(
      (x) => typeof x !== "string" || !/^[a-f0-9]{64}$/.test(x),
    )
  )
    held();
  const config = conceptConfig(request.tuple);
  if (digest(config) !== request.config_sha256) held();
  return config;
}

export function pendingState(intentFile, request) {
  const path = pendingPath(intentFile, request.tuple.cwd),
    value = read(path);
  if (
    value.intent_digest !== digest(request) ||
    !same(value.request, request) ||
    value.active !== false ||
    value.creation_nonce !== request.creation_nonce ||
    value.kind !== "root-concept-pending" ||
    !Number.isSafeInteger(value.revoke_epoch) ||
    value.revoke_epoch < 0 ||
    !(value.revoke_nonce === null || uuid(value.revoke_nonce))
  )
    held();
  if (existsSync(path + ".revoked")) {
    const revoked = read(path + ".revoked");
    if (
      !same(revoked.request, request) ||
      revoked.creation_nonce !== value.creation_nonce ||
      revoked.revoke_nonce !== value.revoke_nonce ||
      revoked.revoke_epoch !== value.revoke_epoch ||
      !value.revoke_nonce
    )
      held();
  }
  return value;
}
