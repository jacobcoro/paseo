// SOURCE_ONLY fake actual-record fixtures, never runtime proof.
import test from "node:test";
import assert from "node:assert/strict";
import { fields } from "./employee-control.mjs";
import { digest } from "./employee-concept-profile.mjs";
import { fixture } from "./employee-concept-reader-fixture.mjs";

test("pending managed owner stays distinct from unknown native init; actual records required", async () => {
  const f = fixture();
  f.info.init = null;
  const owner = await f.reader.observeOwner(f.request);
  assert.deepEqual(owner.scope, f.scope);
  assert.equal(owner.checks, undefined);
  await assert.rejects(f.reader.assertConceptCurrent(f.binding, f.approval));
  const authorization = await f.reader.authorize(f.request);
  assert.equal((await f.reader.assertPrecreation(f.request, authorization)).result, "passed");
});
test("current exact fake records allow projection; every missing/nonempty/malformed catalog denies", async () => {
  const f = fixture();
  assert.equal((await f.reader.assertConceptCurrent(f.binding, f.approval)).result, "passed");
  for (const name of Object.keys(f.info.init.catalogs)) {
    for (const value of [
      { status: "unknown", raw: null },
      { status: "malformed", raw: null },
      { status: "observed", raw: ["forbidden"] },
    ]) {
      const previous = f.info.init.catalogs[name];
      f.info.init.catalogs[name] = value;
      await assert.rejects(f.reader.assertConceptCurrent(f.binding, f.approval));
      f.info.init.catalogs[name] = previous;
    }
  }
});
test("manager/session/query/native/PID/source/private-seal/visibility drift all deny", async () => {
  for (const mutate of [
    (f) => (f.observed.manager_generation = "stale"),
    (f) => (f.info.session_incarnation = "stale"),
    (f) => (f.info.query_incarnation = "stale"),
    (f) => (f.info.init.native_session_id = "stale"),
    (f) => (f.info.spawn.pid = 456),
    (f) => (f.stored.config.providerOptions = {}),
    (f) => (f.observed.internal = true),
    (f) => f.write("boundary", { ...f.proof, source_hashes: {} }),
    (f) => f.write("boundary", { ...f.proof, expires_ms: 0 }),
    (f) => f.write("boundary", { ...f.proof, provenance: "actor" }),
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.reader.assertConceptCurrent(f.binding, f.approval));
  }
});
test("closed alternate ingress remains mandatory; lease pending, old revoke and synthetic timeout refuse terminal", async () => {
  const f = fixture();
  f.write("boundary", {
    ...f.proof,
    checks: { ...f.proof.checks, alternate_entrypoints_denied: false },
  });
  await assert.rejects(f.reader.assertConceptCurrent(f.binding, f.approval));
  f.write("submit", { nonce: "inflight-acceptance" });
  await assert.rejects(f.reader.assertConceptQuiescent(f.binding, f.revoked));
});
test("withdrawal observation survives expired/revoked submit; genuine exact settlement only", async () => {
  const f = fixture();
  f.binding.expires_ms = 0;
  f.write("registry", {
    kind: "registered-exact-concept-job",
    scope: f.scope,
    assignment: f.binding,
    request: f.request,
    target: f.config.target,
    ...f.fresh(),
  });
  f.write("currentApproval", { ...f.approval, revoked: true, expires_ms: 0 });
  await assert.rejects(f.reader.assertConceptCurrent(f.binding, f.approval));
  await assert.rejects(
    f.reader.assertConceptQuiescent(f.binding, { ...f.revoked, revoke_nonce: "old" }),
  );
  await f.reader.assertConceptQuiescent(f.binding, f.revoked);
  f.info.delivery.active = true;
  f.info.delivery.terminal = false; // Manager reports idle after synthetic cancellation.
  await assert.rejects(f.reader.observeConceptTerminal(f.binding, f.revoked));
  f.info.delivery.active = false;
  f.info.delivery.terminal = true;
  assert.equal(
    (await f.reader.observeConceptTerminal(f.binding, f.revoked)).delivery_terminal,
    true,
  );
  f.info.query_incarnation = "replacement";
  await assert.rejects(f.reader.observeConceptTerminal(f.binding, f.revoked));
});
test("foreign ID and wanted UUID cannot populate actual logical owners", async () => {
  const f = fixture();
  await assert.rejects(f.reader.observeOwner({ ...f.request, requested_id: "foreign" }));
  f.write("registry", {
    kind: "registered-exact-concept-job",
    scope: Object.fromEntries(fields.map((key) => [key, "wanted"])),
    target: f.config.target,
    ...f.fresh(),
  });
  await assert.rejects(f.reader.observeOwner(f.request));
});

test("Root callback schemas support inactive admission and exact resume, not actor creation", async () => {
  const f = fixture();
  const resumeApproval = f.root({
    kind: "root-authorized-concept-resume",
    binding: f.binding,
    revoked: false,
  });
  f.write("resumeApproval", resumeApproval);
  assert.deepEqual(await f.reader.authorize(f.binding), resumeApproval);
  const owner = await f.reader.observeOwner(f.binding);
  assert.equal(owner.resume_checks.native_idle, true);
  const admission = f.root({
    kind: "independent-root-concept-admission",
    scope: f.scope,
    intent_digest: digest(f.request),
    revoked: false,
    checks: f.proof.checks,
  });
  f.write("admissionApproval", admission);
  assert.deepEqual(await f.reader.verifyAdmission(f.scope, admission, owner), admission);
  f.write("admissionApproval", { ...admission, revoked: true });
  await assert.rejects(f.reader.verifyAdmission(f.scope, admission, owner));
  f.write("resumeApproval", { ...resumeApproval, approved_by: "foreign" });
  await assert.rejects(f.reader.authorize(f.binding));
  f.write("boundary", { ...f.proof, kind: "other-approval" });
  await assert.rejects(f.reader.observeOwner(f.binding));
});
