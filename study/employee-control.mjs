import {
  openSync,
  closeSync,
  writeFileSync,
  readFileSync,
  fsyncSync,
  renameSync,
  unlinkSync,
  lstatSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

export const fields = [
  "job_id",
  "producer_id",
  "revision",
  "runtime_id",
  "runtime_generation",
  "broker_id",
  "broker_generation",
  "worker_id",
  "worker_generation",
];
const pause = () => new Promise((resolve) => setTimeout(resolve, 10));
export const same = (a, b) => fields.every((key) => a?.[key] === b?.[key]);
export const scope = (worker) =>
  Object.fromEntries(fields.map((key) => [key, worker.employeeScope?.[key]]));
export const held = () => {
  throw Error("Employee lifecycle held; reconcile exact ownership without retry");
};

export function root(worker) {
  const path = worker.employeeControlFile;
  if (
    worker.profile !== "employee-production" ||
    !isAbsolute(path || "") ||
    fields.some(
      (key) =>
        typeof scope(worker)[key] !== "string" ||
        !scope(worker)[key] ||
        scope(worker)[key].length > 200,
    ) ||
    scope(worker).worker_id !== worker.id ||
    !isAbsolute(worker.workspacePath || "")
  )
    held();
  const parent = dirname(path),
    st = lstatSync(parent),
    inside = relative(worker.workspacePath, parent);
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
export function read(path) {
  const st = lstatSync(path);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.uid !== process.getuid() ||
    st.mode & 0o077 ||
    st.size > 65536
  )
    held();
  return JSON.parse(readFileSync(path, "utf8"));
}
export function durable(path, value) {
  const temporary = path + "." + randomUUID();
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, path);
  const directory = openSync(dirname(path), "r");
  try {
    fsyncSync(directory);
  } finally {
    closeSync(directory);
  }
}
function syncDirectory(path) {
  const fd = openSync(dirname(path), "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function exclusive(path, value) {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    syncDirectory(path);
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  return () => {
    if (read(path).nonce !== value.nonce) held();
    closeSync(fd);
    unlinkSync(path);
    syncDirectory(path);
  };
}
export async function lease(path, fn, deadline, mayRelease = () => true) {
  let release;
  while (!release) {
    try {
      release = exclusive(path, { nonce: randomUUID() });
    } catch (error) {
      if (error.code !== "EEXIST" || performance.now() >= deadline) throw error;
      await pause();
    }
  }
  try {
    return await fn();
  } finally {
    if (mayRelease()) release(); // Unknown sends retain their private lease.
  }
}
export function control(worker, assignment, active = true) {
  const path = root(worker),
    value = read(path);
  if (
    !same(scope(worker), value) ||
    Object.keys(assignment).some((key) => assignment[key] !== value[key]) ||
    !Number.isSafeInteger(value.revoke_epoch) ||
    value.revoke_epoch < 0 ||
    typeof value.active !== "boolean" ||
    !Number.isSafeInteger(value.expires_ms) ||
    !(value.revoke_nonce === null || typeof value.revoke_nonce === "string")
  )
    held();
  if (value.active && (value.revoke_epoch !== 0 || value.revoke_nonce !== null)) held();
  if (active && (!value.active || value.expires_ms <= Date.now() || existsSync(path + ".revoked")))
    held();
  return value;
}
export function assertEmployeeControl(worker, assignment) {
  // Reads during a host writer's critical section deny rather than race it.
  if (existsSync(root(worker) + ".writer")) held();
  return control(worker, assignment);
}
export async function withEmployeeSubmitLease(worker, assignment, send) {
  const path = root(worker);
  let uncertain = false;
  return lease(
    path + ".submit",
    async () => {
      await lease(path + ".writer", () => control(worker, assignment), performance.now() + 1000);
      try {
        return await send(); // Future Hermes caller must await SDK acceptance inside this lease.
      } catch (error) {
        uncertain = true;
        throw error;
      }
    },
    performance.now() + 1000,
    () => !uncertain,
  );
}
export async function withdrawEmployeeLifecycle(worker, assignment) {
  const path = root(worker);
  return lease(
    path + ".writer",
    () => {
      const current = control(worker, assignment, false);
      const tombstone = existsSync(path + ".revoked") ? read(path + ".revoked") : null;
      if (
        tombstone &&
        (!same(tombstone, current) ||
          current.active ||
          current.revoke_epoch !== tombstone.revoke_epoch ||
          current.revoke_nonce !== tombstone.revoke_nonce)
      )
        held();
      const value = current.revoke_nonce
        ? current
        : { ...current, revoke_epoch: current.revoke_epoch + 1, revoke_nonce: randomUUID() };
      const inactive = { ...value, active: false };
      durable(path, inactive); // No cleanup/cancel occurs before both fsyncs complete.
      durable(path + ".revoked", inactive);
      return inactive;
    },
    performance.now() + 2500,
  );
}
export async function revokeEmployeeLifecycle(worker, assignment) {
  const path = root(worker),
    deadline = performance.now() + 5000;
  const revoked = await withdrawEmployeeLifecycle(worker, assignment);
  while (performance.now() < deadline) {
    if (!existsSync(path + ".submit") && existsSync(path + ".ack")) {
      const ack = read(path + ".ack"),
        owner = read(path + ".owner");
      const current = control(worker, assignment, false);
      if (
        same(ack, revoked) &&
        !current.active &&
        current.revoke_epoch === revoked.revoke_epoch &&
        current.revoke_nonce === revoked.revoke_nonce &&
        ack.revoke_nonce === revoked.revoke_nonce &&
        ack.revoke_epoch === revoked.revoke_epoch &&
        ack.owner_nonce === owner.nonce &&
        same(owner, revoked) &&
        ack.issued_ms <= Date.now() &&
        Date.now() - ack.issued_ms <= 1000 &&
        ack.pending === 0 &&
        ack.owned_absent === true
      )
        return ack;
    }
    await pause();
  }
  held();
}
