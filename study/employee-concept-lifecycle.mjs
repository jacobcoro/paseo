// No tools, owner process, Docker client, or Root creation API is exposed here.
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import {
  root,
  held,
  read,
  control,
  lease,
  withdrawEmployeeLifecycle,
} from "./employee-control.mjs";
import { conceptProfile } from "./employee-concept-profile.mjs";

const check = (worker) => {
  if (worker.profile !== conceptProfile || worker.provider !== "claude") held();
  return root(worker);
};
export async function registerConceptDelivery(worker, assignment, nonce, send) {
  const path = check(worker);
  // Caller already owns the submission lease through SDK acceptance.
  if (!nonce || !existsSync(path + ".submit") || read(path + ".submit").nonce !== nonce) held();
  let acceptance;
  await lease(
    path + ".writer",
    () => {
      control(worker, assignment);
      acceptance = send(); // Synchronous registration serialized against inactive-first withdrawal.
    },
    performance.now() + 1000,
  );
  return await acceptance;
}
export async function withdrawConceptText(worker, assignment) {
  const path = check(worker);
  const revoked = await withdrawEmployeeLifecycle(worker, assignment);
  const deadline = performance.now() + 2500;
  while (existsSync(path + ".submit") && performance.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  if (existsSync(path + ".submit")) held();
  const current = control(worker, assignment, false);
  if (
    current.active ||
    current.revoke_nonce !== revoked.revoke_nonce ||
    current.revoke_epoch !== revoked.revoke_epoch
  )
    held();
  return revoked; // Current independent quiescence and post-cancel native observation are still mandatory.
}
