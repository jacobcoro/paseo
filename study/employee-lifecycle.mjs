import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import {
  fields,
  same,
  scope,
  held,
  root,
  durable,
  exclusive,
  lease,
  control,
} from "./employee-control.mjs";
export {
  assertEmployeeControl,
  withEmployeeSubmitLease,
  withdrawEmployeeLifecycle,
  revokeEmployeeLifecycle,
} from "./employee-control.mjs";
const owners = new Map();

function execute(args, options = {}) {
  let child;
  const result = new Promise((resolve, reject) => {
    child = execFile(
      "docker",
      args,
      { timeout: 1000, maxBuffer: 65536, ...options },
      (error, stdout, stderr) => {
        if (error) {
          reject(Object.assign(error, { stdout, stderr }));
          return;
        }
        resolve({ stdout, stderr });
      },
    );
  });
  return { child, result };
}
async function observe(cid, run) {
  try {
    return JSON.parse((await run(["inspect", "--type", "container", cid])).stdout)[0];
  } catch (error) {
    if (error.code === 1 && error.stderr?.trim() === "Error: No such object: " + cid) return null;
    throw error;
  }
}
export function employeeOwner(worker) {
  if (worker.profile !== "employee-production") held();
  const owner = owners.get(root(worker));
  if (!owner || !same(owner.binding, scope(worker))) held();
  return owner;
}
export function startEmployeeOwner(worker, dependencies = {}) {
  if (worker.profile !== "employee-production") held();
  const path = root(worker),
    binding = scope(worker);
  control(worker, {}, false);
  if (
    readdirSync(dirname(path)).some((name) => name.startsWith(path.split("/").at(-1) + ".intent-"))
  )
    held();
  const nonce = randomUUID(),
    release = exclusive(path + ".owner", { ...binding, nonce });
  const spawn = dependencies.execute || execute;
  const run = async (args) => await spawn(args).result;
  const inspect =
    dependencies.observe ||
    ((cid) => observe(cid, async (args) => await spawn(args, { timeout: 500 }).result));
  const active = new Map();
  const completed = new Set();
  let unknown = false,
    polling = null;
  if (owners.has(path)) {
    release();
    held();
  }
  function save(op) {
    durable(path + ".intent-" + op.id, {
      ...binding,
      id: op.id,
      name: op.name,
      cid: op.cid,
      phase: op.phase,
      owner_nonce: nonce,
    });
  }
  async function cleanup(op) {
    if (!op.cid) return;
    const found = await inspect(op.cid);
    if (found) {
      if (
        found.Id !== op.cid ||
        found.Name !== "/" + op.name ||
        Object.entries(labels).some(([key, value]) => found.Config?.Labels?.[key] !== value)
      )
        held();
      await run(["rm", "-f", op.cid]);
    }
    if ((await inspect(op.cid)) !== null) held();
  }
  const labels = Object.fromEntries(fields.map((key) => ["lulu.employee." + key, binding[key]]));
  async function finish(op) {
    if (unknown) return;
    try {
      await cleanup(op);
      if (op.cid) completed.add(op.cid);
      unlinkSync(path + ".intent-" + op.id);
    } catch (error) {
      unknown = true;
      op.phase = "unknown";
      save(op);
      throw error;
    }
  }
  function pendingCount() {
    const count = dependencies.pending?.() ?? 0;
    if (!Number.isSafeInteger(count) || count < 0) held();
    return count;
  }
  async function acknowledge(current) {
    const deadline = performance.now() + 1000;
    for (const cid of completed) {
      if (performance.now() >= deadline || (await inspect(cid)) !== null) held();
    }
    if (existsSync(path + ".writer") || existsSync(path + ".submit") || pendingCount()) return;
    const latest = control(worker, {}, false);
    if (
      latest.active ||
      latest.revoke_nonce !== current.revoke_nonce ||
      latest.revoke_epoch !== current.revoke_epoch
    )
      held();
    durable(path + ".ack", {
      ...binding,
      revoke_epoch: current.revoke_epoch,
      revoke_nonce: current.revoke_nonce,
      owner_nonce: nonce,
      pending: 0,
      owned_absent: true,
      issued_ms: Date.now(),
    });
  }
  const owner = {
    binding,
    async operation(assignment, fn) {
      if (unknown || active.size) held();
      const op = await lease(
        path + ".writer",
        () => {
          control(worker, assignment);
          if (unknown || active.size) held();
          const id = randomUUID(),
            item = { id, name: "lulu-compute-" + id, cid: null, phase: "preparing", child: null };
          save(item);
          active.set(id, item);
          return item;
        },
        performance.now() + 1000,
      );
      let result, failure;
      try {
        result = await fn(op);
      } catch (error) {
        failure = error;
      }
      try {
        await finish(op);
      } catch (error) {
        failure = error;
      }
      active.delete(op.id);
      if (failure) throw failure;
      return result;
    },
    async compute(op, args, options) {
      if (active.get(op?.id) !== op || op.phase !== "preparing") held();
      const create = args.slice(1).filter((arg) => arg !== "--rm");
      create[create.indexOf("--name") + 1] = op.name;
      for (const [key, value] of Object.entries(labels))
        create.splice(create.length - 4, 0, "--label", key + "=" + value);
      async function mutate(argv) {
        const command = spawn(argv);
        op.child = command.child;
        try {
          return await command.result;
        } finally {
          op.child = null;
        }
      }
      try {
        await lease(
          path + ".writer",
          async () => {
            control(worker, {
              job_id: binding.job_id,
              producer_id: binding.producer_id,
              revision: binding.revision,
            });
            op.phase = "creating";
            save(op);
            const created = await mutate(["create", ...create]);
            if (!/^[a-f0-9]{64}$/.test(created.stdout.trim())) held();
            op.cid = created.stdout.trim();
            op.phase = "created";
            save(op);
          },
          performance.now() + 1000,
        );
        await lease(
          path + ".writer",
          async () => {
            control(worker, {});
            op.phase = "starting";
            save(op);
            await mutate(["start", op.cid]);
            op.phase = "waiting";
            save(op);
          },
          performance.now() + 1000,
        );
        const waiting = spawn(["wait", op.cid], options);
        op.child = waiting.child;
        try {
          const status = (await waiting.result).stdout.trim();
          if (status !== "0") throw Error("Employee computation exited unsuccessfully");
        } finally {
          op.child = null;
        }
        control(worker, {});
        const logging = spawn(["logs", op.cid], options);
        op.child = logging.child;
        try {
          return await logging.result;
        } finally {
          op.child = null;
        }
      } catch (error) {
        if (["creating", "starting"].includes(op.phase)) {
          unknown = true;
          op.phase = "unknown";
          save(op);
        }
        throw error;
      }
    },
    poll() {
      if (polling) return polling;
      polling = (async () => {
        if (existsSync(path + ".writer")) return;
        const current = control(worker, {}, false);
        if (current.active) return;
        for (const op of active.values())
          if (op.child && op.phase === "waiting") op.child.kill("SIGTERM"); // Only owned read-only wait/log CLI; mutations settle under writer lease.
        const pending = pendingCount();
        if (
          !unknown &&
          !active.size &&
          !pending &&
          current.revoke_nonce &&
          !existsSync(path + ".submit")
        ) {
          await acknowledge(current);
        }
      })().finally(() => {
        polling = null;
      });
      return polling;
    },
    close() {
      if (unknown || active.size) held();
      owners.delete(path);
      release();
    },
  };
  owners.set(path, owner);
  return owner;
}
