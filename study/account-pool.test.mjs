import test from "node:test";
import assert from "node:assert/strict";
import { selectStudentAccount } from "./account-pool.mjs";

test("student assignments balance distinct subscription routes and keep each student pinned", () => {
  const pool = {
    accounts: [
      { id: "one", enabled: true },
      { id: "two", enabled: true },
    ],
    assignments: {},
  };
  for (let i = 0; i < 60; i++) selectStudentAccount(pool, "s" + i);
  assert.equal(Object.values(pool.assignments).filter((id) => id === "one").length, 30);
  assert.equal(Object.values(pool.assignments).filter((id) => id === "two").length, 30);
  assert.equal(selectStudentAccount(pool, "s0").id, pool.assignments.s0);
  pool.accounts[1].enabled = false;
  assert.equal(selectStudentAccount(pool, "new").id, "one");
  assert.throws(() => selectStudentAccount(pool, "s1"), /unavailable/);
  pool.accounts[0].enabled = false;
  assert.throws(() => selectStudentAccount(pool, "unknown"), /No GPT subscription/);
});
