import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { passwordHash } from "./gateway.mjs";
export function ensureAdmin(configPath) {
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  if (config.admin) return;
  const password = randomBytes(18).toString("base64url");
  const salt = randomBytes(16).toString("hex");
  config.admin = { id: "lulu-admin", salt, passwordHash: passwordHash(password, salt) };
  writeFileSync(configPath, JSON.stringify(config, null, 2), { mode: 0o600 });
  writeFileSync(join(dirname(configPath), "admin.login.txt"), `lulu-admin\n${password}\n`, {
    mode: 0o600,
  });
}
if (process.argv[1] === new URL(import.meta.url).pathname) ensureAdmin(process.argv[2]);
