// SOURCE ONLY: synthetic private state, fake container metadata and plain Node
// fixture processes. No Docker/native/provider/security test is executed.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  startEmployeeOwner,
  assertEmployeeControl,
  withdrawEmployeeLifecycle,
  revokeEmployeeLifecycle,
  withEmployeeSubmitLease,
} from "./employee-lifecycle.mjs";
import { startToolWorker, handleTool } from "./tool-worker.mjs";
import { registerDocument } from "./documents.mjs";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function fixture() {
  const base =
    process.env.EMPLOYEE_LIFECYCLE_TEST_ROOT ||
    join(homedir(), ".local/state/paseo-employee-tests");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(base, "lifecycle-"));
  const recordsDir = join(root, "records");
  mkdirSync(recordsDir, { mode: 0o700 });
  const assignment = {
    job_id: "synthetic-job",
    producer_id: "synthetic-producer",
    revision: "synthetic-r1",
  };
  const binding = {
    ...assignment,
    runtime_id: createHash("sha256").update(recordsDir).digest("hex"),
    runtime_generation: "synthetic-runtime-1",
    broker_id: "synthetic-broker",
    broker_generation: "synthetic-broker-1",
    worker_id: "synthetic-worker",
    worker_generation: "synthetic-worker-1",
  };
  const worker = {
    id: binding.worker_id,
    profile: "employee-production",
    employeeScope: binding,
    workspacePath: join(root, "workspace"),
    employeeControlFile: join(root, "control.json"),
  };
  const current = {
    ...binding,
    active: true,
    expires_ms: Date.now() + 60000,
    revoke_epoch: 0,
    revoke_nonce: null,
  };
  const write = (value) =>
    writeFileSync(worker.employeeControlFile, JSON.stringify(value), { mode: 0o600 });
  write(current);
  const read = () => JSON.parse(readFileSync(worker.employeeControlFile, "utf8"));
  return {
    root,
    worker,
    assignment,
    binding,
    current,
    write,
    read,
    config: { recordsDir, students: [worker] },
  };
}
function fake(f, hooks = {}) {
  const calls = [],
    containers = new Map();
  function execute(args) {
    calls.push([...args]);
    const killed = deferred();
    const child = {
      kill() {
        killed.reject(Error("Synthetic owned wait interrupted"));
      },
    };
    const result = (async () => {
      const command = args[0];
      if (command === "create") {
        await hooks.beforeCreate?.();
        const name = args[args.indexOf("--name") + 1];
        const cid = createHash("sha256").update(name).digest("hex");
        const labels = {};
        for (let i = 0; i < args.length; i++)
          if (args[i] === "--label") {
            const at = args[i + 1].indexOf("=");
            labels[args[i + 1].slice(0, at)] = args[i + 1].slice(at + 1);
          }
        containers.set(cid, { Id: cid, Name: "/" + name, Config: { Labels: labels } });
        await hooks.afterCreate?.(cid);
        return { stdout: cid + "\n", stderr: "" };
      }
      if (command === "start") {
        assert.equal(f.read().active, true);
        await hooks.start?.();
        return { stdout: args[1], stderr: "" };
      }
      if (command === "wait") {
        const completed = hooks.wait ? hooks.wait() : Promise.resolve();
        await Promise.race([completed, killed.promise]);
        return { stdout: hooks.exitStatus || "0", stderr: "" };
      }
      if (command === "logs") return { stdout: "synthetic result", stderr: "" };
      if (command === "rm") {
        await hooks.remove?.();
        containers.delete(args[2]);
        return { stdout: args[2], stderr: "" };
      }
      throw Error("Unexpected fake command");
    })();
    // A killed read-only child rejects its active promise; no OS kill occurs.
    return { child, result };
  }
  return {
    execute,
    observe: async (cid) => {
      await hooks.observe?.();
      return containers.get(cid) || null;
    },
    calls,
    containers,
  };
}
const args = (name) => [
  "run",
  "--rm",
  "--name",
  name,
  "--label",
  "lulu.study.compute=owned",
  "image",
  "python",
  "-I",
  "/work/watchdog.py",
];
async function using(fn) {
  const f = fixture();
  try {
    await fn(f);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
}

test("source-only durable withdrawal survives expiry and old-epoch reactivation", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker); // No executor is called for an empty job.
    f.write({ ...f.current, expires_ms: 1 });
    assert.throws(() => assertEmployeeControl(f.worker, f.assignment));
    const denied = await withdrawEmployeeLifecycle(f.worker, f.assignment);
    assert.equal(f.read().active, false);
    assert.equal(denied.revoke_epoch, 1);
    await owner.poll();
    const ack = await revokeEmployeeLifecycle(f.worker, f.assignment);
    assert.equal(ack.revoke_nonce, denied.revoke_nonce);
    f.write({ ...denied, active: true });
    assert.throws(() => assertEmployeeControl(f.worker, f.assignment));
    await assert.rejects(withdrawEmployeeLifecycle(f.worker, f.assignment));
    owner.close();
  }));

test("source-only foreign scope/revision/generation denies before executor", () =>
  using(async (f) => {
    const adapter = fake(f),
      owner = startEmployeeOwner(f.worker, adapter);
    for (const key of Object.keys(f.binding)) {
      f.write({ ...f.current, [key]: "foreign" });
      assert.throws(() => assertEmployeeControl(f.worker, f.assignment));
      await assert.rejects(withdrawEmployeeLifecycle(f.worker, f.assignment));
    }
    f.write(f.current);
    assert.throws(() => startEmployeeOwner({ ...f.worker, profile: "ordinary" }, adapter));
    await assert.rejects(owner.operation({ ...f.assignment, revision: "stale" }, () => {}));
    assert.equal(adapter.calls.length, 0);
    owner.close();
  }));

test("source-only revoke during asynchronous preparation blocks spawn and queued operations", () =>
  using(async (f) => {
    const adapter = fake(f),
      owner = startEmployeeOwner(f.worker, adapter),
      entered = deferred(),
      release = deferred();
    const op = owner.operation(f.assignment, async (token) => {
      entered.resolve();
      await release.promise;
      return owner.compute(token, args(token.name), {});
    });
    await entered.promise;
    await withdrawEmployeeLifecycle(f.worker, f.assignment);
    release.resolve();
    await assert.rejects(op);
    await assert.rejects(owner.operation(f.assignment, () => {}));
    await owner.poll();
    assert.equal((await revokeEmployeeLifecycle(f.worker, f.assignment)).pending, 0);
    assert.equal(adapter.calls.length, 0);
    owner.close();
  }));

test("source-only known create/start completion permits exact-CID cleanup after owned wait settles", () =>
  using(async (f) => {
    const entered = deferred(),
      waiting = deferred();
    const adapter = fake(f, {
      wait: () => {
        entered.resolve();
        return waiting.promise;
      },
    });
    const owner = startEmployeeOwner(f.worker, adapter);
    const op = owner.operation(f.assignment, (token) => owner.compute(token, args(token.name), {}));
    await entered.promise;
    await withdrawEmployeeLifecycle(f.worker, f.assignment);
    await owner.poll();
    await assert.rejects(op);
    await owner.poll();
    const ack = await revokeEmployeeLifecycle(f.worker, f.assignment);
    assert.equal(ack.owned_absent, true);
    assert.equal(adapter.containers.size, 0);
    assert.deepEqual(
      adapter.calls.map((a) => a[0]),
      ["create", "start", "wait", "rm"],
    );
    assert.match(adapter.calls.at(-1)[2], /^[a-f0-9]{64}$/);
    owner.close();
  }));

for (const phase of ["beforeCreate", "afterCreate", "start", "remove", "observe"]) {
  test("source-only unknown " + phase + " retains ownership and denies quiescence", () =>
    using(async (f) => {
      const adapter = fake(f, {
        [phase]: () => {
          throw Error("synthetic unknown outcome");
        },
      });
      const owner = startEmployeeOwner(f.worker, adapter);
      await assert.rejects(
        owner.operation(f.assignment, (token) => owner.compute(token, args(token.name), {})),
      );
      await withdrawEmployeeLifecycle(f.worker, f.assignment);
      await owner.poll();
      assert.equal(existsSync(f.worker.employeeControlFile + ".ack"), false);
      assert.throws(() => owner.close());
      assert.throws(() => startEmployeeOwner(f.worker, adapter));
      assert.equal(
        adapter.calls.some((call) => call[0] === "ps"),
        false,
      );
      if (phase === "afterCreate") assert.equal(adapter.containers.size, 1); // A late create cannot be treated as absent.
    }),
  );
}

test("source-only forged or old ack/owner nonce cannot resolve withdrawal", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker),
      revoked = await withdrawEmployeeLifecycle(f.worker, f.assignment);
    await owner.poll();
    const path = f.worker.employeeControlFile + ".ack",
      ack = JSON.parse(readFileSync(path));
    for (const patch of [
      { owner_nonce: "stale" },
      { revoke_nonce: "stale" },
      { revoke_epoch: 0 },
      { worker_generation: "other" },
      { issued_ms: 0 },
    ]) {
      writeFileSync(path, JSON.stringify({ ...ack, ...patch }), { mode: 0o600 });
      // The independently running owner refreshes only its exact current nonce.
      const pending = revokeEmployeeLifecycle(f.worker, f.assignment);
      let resolved = false;
      pending.then(() => {
        resolved = true;
        return null;
      });
      await delay(20);
      assert.equal(resolved, false);
      await owner.poll();
      assert.equal((await pending).revoke_nonce, revoked.revoke_nonce);
    }
    owner.close();
  }));

const fixtureSource = `import { readFileSync } from 'node:fs';
const lifecycle = await import(process.argv[2]);
const worker = JSON.parse(readFileSync(process.argv[3]));
try {
 if (process.argv[4] === 'owner') lifecycle.startEmployeeOwner(worker);
 else if(process.argv[4] === 'withdraw') {process.send({kind:'requested'});await lifecycle.withdrawEmployeeLifecycle(worker,{job_id:worker.employeeScope.job_id,producer_id:worker.employeeScope.producer_id,revision:worker.employeeScope.revision});}
 else await lifecycle.withEmployeeSubmitLease(worker, {job_id:worker.employeeScope.job_id,producer_id:worker.employeeScope.producer_id,revision:worker.employeeScope.revision}, async()=>{
   process.send({kind:'admitted'});await new Promise(resolve=>process.once('message',resolve));
 });
 process.send({kind:'complete'});
} catch(error){process.send({kind:'denied',code:error.code});}
process.disconnect();`;
function fixtureProcess(f, mode) {
  const script = join(f.root, "synthetic-fixture.mjs"),
    settings = join(f.root, "synthetic-worker.json");
  writeFileSync(script, fixtureSource, { mode: 0o600 });
  writeFileSync(settings, JSON.stringify(f.worker), { mode: 0o600 });
  return spawn(
    process.execPath,
    [script, new URL("./employee-lifecycle.mjs", import.meta.url).href, settings, mode],
    { env: { LANG: "C" }, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
}
test("source-only separate-process submit lease fences inactive withdrawal without a Promise-only claim", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker),
      process = fixtureProcess(f, "submit"),
      exit = once(process, "exit");
    assert.equal((await once(process, "message"))[0].kind, "admitted");
    const pending = revokeEmployeeLifecycle(f.worker, f.assignment);
    while (f.read().active) await delay(5);
    await owner.poll();
    assert.equal(existsSync(f.worker.employeeControlFile + ".ack"), false);
    const complete = once(process, "message");
    process.send("finish synthetic acceptance");
    assert.equal((await complete)[0].kind, "complete");
    await exit;
    await owner.poll();
    assert.equal((await pending).pending, 0);
    await assert.rejects(
      withEmployeeSubmitLease(f.worker, f.assignment, () => {
        throw Error("must not send");
      }),
    );
    owner.close();
  }));

test("source-only separate-process duplicate worker ownership fails without stale stealing", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker),
      process = fixtureProcess(f, "owner"),
      exit = once(process, "exit");
    assert.equal((await once(process, "message"))[0].kind, "denied");
    await exit;
    owner.close();
    writeFileSync(
      f.worker.employeeControlFile + ".owner",
      JSON.stringify({ ...f.binding, nonce: "unknown-dead-owner" }),
      { mode: 0o600 },
    );
    assert.throws(() => startEmployeeOwner(f.worker));
  }));

test("source-only queued worker entries prevent acknowledgment until rejected", () =>
  using(async (f) => {
    let pending = 1;
    const owner = startEmployeeOwner(f.worker, { pending: () => pending });
    await withdrawEmployeeLifecycle(f.worker, f.assignment);
    await owner.poll();
    assert.equal(existsSync(f.worker.employeeControlFile + ".ack"), false);
    pending = 0;
    await owner.poll();
    assert.equal((await revokeEmployeeLifecycle(f.worker, f.assignment)).pending, 0);
    owner.close();
  }));

test("source-only separate-process inactive writer serializes with create/start mutation", () =>
  using(async (f) => {
    const creating = deferred(),
      release = deferred(),
      waiting = deferred();
    const adapter = fake(f, {
      beforeCreate: async () => {
        creating.resolve();
        await release.promise;
      },
      wait: () => waiting.promise,
    });
    const owner = startEmployeeOwner(f.worker, adapter);
    const operation = owner.operation(f.assignment, (token) =>
      owner.compute(token, args(token.name), {}),
    );
    const settled = operation.catch((error) => error); // Attach before the independent writer can abort it.
    await creating.promise;
    const process = fixtureProcess(f, "withdraw"),
      exit = once(process, "exit");
    assert.equal((await once(process, "message"))[0].kind, "requested");
    assert.equal(f.read().active, true); // It cannot enter the held writer lease.
    const complete = once(process, "message");
    release.resolve();
    assert.equal((await complete)[0].kind, "complete");
    await exit;
    assert.equal(f.read().active, false);
    await owner.poll();
    assert.ok((await settled) instanceof Error);
    await owner.poll();
    assert.equal((await revokeEmployeeLifecycle(f.worker, f.assignment)).pending, 0);
    assert.equal(adapter.containers.size, 0);
    owner.close();
  }));

test("source-only foreign container metadata cannot select another owner for cleanup", () =>
  using(async (f) => {
    const adapter = fake(f, {
      afterCreate: (cid) => {
        adapter.containers.get(cid).Config.Labels["lulu.employee.worker_generation"] = "other";
      },
    });
    const owner = startEmployeeOwner(f.worker, adapter);
    await assert.rejects(
      owner.operation(f.assignment, (token) => owner.compute(token, args(token.name), {})),
    );
    await withdrawEmployeeLifecycle(f.worker, f.assignment);
    await owner.poll();
    assert.equal(
      adapter.calls.some((call) => call[0] === "rm"),
      false,
    );
    assert.equal(existsSync(f.worker.employeeControlFile + ".ack"), false);
    assert.throws(() => owner.close());
  }));

test("source-only existing worker queue denies revoked jobs and ordinary document tools stay unchanged", () =>
  using(async (f) => {
    const file = registerDocument(
      f.config,
      f.worker,
      "source.txt",
      Buffer.from("Synthetic source fixture."),
    );
    const stop = startToolWorker(f.config, fake(f));
    const revoked = await withdrawEmployeeLifecycle(f.worker, f.assignment);
    const id = randomUUID() + ".json",
      tools = join(f.worker.workspacePath, ".study-tools");
    writeFileSync(
      join(tools, "inbox", id),
      JSON.stringify({ operation: "read_file", files: [], assignment: f.assignment, id: file.id }),
      { mode: 0o600 },
    );
    const result = join(tools, "results", id);
    for (let count = 0; count < 100 && !existsSync(result); count++) await delay(10);
    assert.match(JSON.parse(readFileSync(result)).error, /held/);
    assert.equal(
      (await revokeEmployeeLifecycle(f.worker, f.assignment)).revoke_nonce,
      revoked.revoke_nonce,
    );
    await stop();
    const ordinary = { id: "synthetic-student", workspacePath: join(f.root, "ordinary") };
    const saved = await handleTool(f.config, ordinary, {
      operation: "write_text",
      name: "normal.txt",
      text: "Ordinary synthetic fixture.",
    });
    assert.equal(
      (await handleTool(f.config, ordinary, { operation: "read_file", id: saved.id })).text,
      "Ordinary synthetic fixture.",
    );
  }));

test("source-only uncertain SDK acceptance retains submit lease; withdrawal still persists inactive", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker);
    await assert.rejects(
      withEmployeeSubmitLease(f.worker, f.assignment, () => {
        throw Error("synthetic unknown/quota outcome");
      }),
    );
    assert.equal(existsSync(f.worker.employeeControlFile + ".submit"), true);
    await withdrawEmployeeLifecycle(f.worker, f.assignment);
    await owner.poll();
    assert.equal(f.read().active, false);
    assert.equal(existsSync(f.worker.employeeControlFile + ".ack"), false);
    owner.close();
  }));

test("source-only simultaneous local admission has one exact owner operation", () =>
  using(async (f) => {
    const owner = startEmployeeOwner(f.worker),
      release = deferred(),
      entered = deferred();
    const first = owner.operation(f.assignment, async () => {
      entered.resolve();
      await release.promise;
    });
    const second = owner.operation(f.assignment, () => {
      throw Error("must never enter");
    });
    await entered.promise;
    await assert.rejects(second, /held/);
    release.resolve();
    await first;
    owner.close();
  }));

test("source-only nonzero owned computation status fails and still cleans exact CID", () =>
  using(async (f) => {
    const adapter = fake(f, { exitStatus: "1" }),
      owner = startEmployeeOwner(f.worker, adapter);
    await assert.rejects(
      owner.operation(f.assignment, (token) => owner.compute(token, args(token.name), {})),
      /unsuccessfully/,
    );
    assert.equal(adapter.containers.size, 0);
    assert.equal(
      adapter.calls.some((call) => call[0] === "logs"),
      false,
    );
    owner.close();
  }));
