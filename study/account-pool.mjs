import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { z } from "zod";

const Pool = z
  .object({
    accounts: z
      .array(
        z
          .object({
            id: z.string().min(1),
            authFile: z.string().refine(isAbsolute),
            enabled: z.boolean(),
          })
          .strict(),
      )
      .min(1),
    assignments: z.record(z.string(), z.string()),
  })
  .strict();

export function selectStudentAccount(pool, studentId) {
  const existing = pool.assignments[studentId];
  if (existing) {
    const account = pool.accounts.find((item) => item.id === existing);
    if (!account?.enabled) throw Error("The student's assigned subscription is unavailable");
    return account;
  }
  const enabled = pool.accounts.filter((account) => account.enabled);
  if (!enabled.length) throw Error("No GPT subscription is available");
  const count = (id) => Object.values(pool.assignments).filter((value) => value === id).length;
  enabled.sort((a, b) => count(a.id) - count(b.id));
  const selected = enabled[0];
  pool.assignments[studentId] = selected.id;
  return selected;
}

export function assignStudentAccount(poolPath, studentId) {
  const lock = openSync(poolPath + ".lock", "wx", 0o600);
  try {
    return assignLocked(poolPath, studentId);
  } finally {
    closeSync(lock);
    unlinkSync(poolPath + ".lock");
  }
}

function assignLocked(poolPath, studentId) {
  const pool = Pool.parse(JSON.parse(readFileSync(poolPath, "utf8")));
  if (new Set(pool.accounts.map((account) => account.id)).size !== pool.accounts.length)
    throw Error("GPT subscription pool names must be unique");
  const identities = pool.accounts.map((account) => {
    const auth = JSON.parse(readFileSync(account.authFile, "utf8"));
    if (auth.auth_mode !== "chatgpt" || !auth.tokens?.account_id)
      throw Error("A pool entry is not a logged-in GPT subscription");
    return auth.tokens.account_id;
  });
  if (new Set(identities).size !== identities.length)
    throw Error("GPT subscription pool entries must use distinct accounts");
  const account = selectStudentAccount(pool, studentId);
  const temporary = poolPath + "." + randomUUID();
  writeFileSync(temporary, JSON.stringify(pool, null, 2), { mode: 0o600 });
  renameSync(temporary, poolPath);
  return account;
}
