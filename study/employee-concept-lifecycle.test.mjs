import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fixture } from "./employee-concept-fixture.mjs";
import { durable, read, withEmployeeSubmitLease } from "./employee-control.mjs";
import { registerConceptDelivery, withdrawConceptText } from "./employee-concept-lifecycle.mjs";
const tuple = (f) =>
  Object.fromEntries(["job_id", "producer_id", "revision"].map((key) => [key, f.actual[key]]));
async function wait(fn) {
  const deadline = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > deadline) throw Error("synthetic coordination timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}
function child(operation, input) {
  const processChild = spawn(
    process.execPath,
    [
      fileURLToPath(new URL("./employee-concept-process-fixture.mjs", import.meta.url)),
      operation,
      input,
    ],
    { env: { LANG: "C.UTF-8" }, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "",
    errors = "";
  processChild.stdout.on("data", (data) => {
    output += data;
  });
  processChild.stderr.on("data", (data) => {
    errors += data;
  });
  const result = new Promise((resolve, reject) => {
    processChild.on("error", reject);
    processChild.on("exit", (code) => {
      console.log(output.trim());
      if (errors) console.log(errors);
      resolve(code);
    });
  });
  return result;
}

test("separate synthetic process withdrawal defeats pending registration and duplicate owner", async () => {
  const f = fixture();
  f.activate();
  const signals = Object.fromEntries(
    ["ready", "allow", "sent", "accept"].map((key) => [key, join(f.folder, key + ".json")]),
  );
  const input = join(f.folder, "input.json");
  durable(input, { worker: f.worker, signals, before: true });
  const a = child("submit", input);
  await wait(() => existsSync(signals.ready));
  const duplicate = child("submit", input),
    b = child("withdraw", input);
  await wait(() => read(f.worker.employeeControlFile).active === false);
  durable(signals.allow, {});
  assert.deepEqual(await Promise.all([a, duplicate, b]), [2, 2, 2]);
  assert.equal(existsSync(signals.sent), false);
  assert.equal(existsSync(f.worker.employeeControlFile + ".submit"), true);
  assert.equal(read(f.worker.employeeControlFile).revoke_epoch, 1);
});

test("separate process inactive-first withdrawal waits for exact known SDK acceptance", async () => {
  const f = fixture();
  f.activate();
  const signals = Object.fromEntries(
    ["ready", "allow", "sent", "accept"].map((key) => [key, join(f.folder, key + ".json")]),
  );
  const input = join(f.folder, "input.json");
  durable(input, { worker: f.worker, signals, before: false });
  const a = child("submit", input);
  await wait(() => existsSync(signals.ready));
  const b = child("withdraw", input);
  await wait(() => read(f.worker.employeeControlFile).active === false);
  assert.equal(existsSync(f.worker.employeeControlFile + ".submit"), true);
  durable(signals.accept, {});
  assert.deepEqual(await Promise.all([a, b]), [0, 0]);
  assert.equal(existsSync(f.worker.employeeControlFile + ".submit"), false);
  assert.equal(read(f.worker.employeeControlFile).active, false);
});

test("foreign nonce/generation and expired submit cannot block owned withdrawal or permit replay", async () => {
  const f = fixture();
  f.activate();
  let sends = 0;
  await withEmployeeSubmitLease(f.worker, tuple(f), async () => {
    await assert.rejects(
      registerConceptDelivery(f.worker, tuple(f), "foreign", () => {
        sends++;
      }),
    );
  });
  const current = read(f.worker.employeeControlFile);
  durable(f.worker.employeeControlFile, { ...current, expires_ms: 0 });
  await assert.rejects(withEmployeeSubmitLease(f.worker, tuple(f), () => {}));
  const revoked = await withdrawConceptText(f.worker, tuple(f));
  assert.equal(revoked.active, false);
  assert.equal(sends, 0);
  const again = await withdrawConceptText(f.worker, tuple(f));
  assert.equal(again.revoke_nonce, revoked.revoke_nonce);
  await assert.rejects(
    withdrawConceptText(
      { ...f.worker, employeeScope: { ...f.actual, worker_generation: "foreign" } },
      tuple(f),
    ),
  );
  durable(f.worker.employeeControlFile, current);
  await assert.rejects(
    withEmployeeSubmitLease(f.worker, tuple(f), () => {
      sends++;
    }),
  );
  assert.equal(sends, 0);
});

test("separate process pending create ownership rejects duplicates and late withdrawn acceptance", async () => {
  const f = fixture();
  const signals = { ready: join(f.folder, "ready.json"), accept: join(f.folder, "accept.json") };
  const input = join(f.folder, "create-input.json");
  durable(input, {
    worker: f.worker,
    signals,
    request: f.request,
    intentFile: f.args.intentFile,
    agent: f.agent,
  });
  const creating = child("create", input);
  await wait(() => existsSync(signals.ready));
  assert.equal(f.intent().active, false);
  assert.equal(existsSync(f.worker.employeeControlFile), false);
  assert.equal(await child("create", input), 2);
  await f.host().withdrawPending(f.request);
  durable(signals.accept, {});
  assert.equal(await creating, 2);
  assert.equal(f.intent().active, false);
  assert.equal(existsSync(f.args.intentFile + ".create"), true);
});
