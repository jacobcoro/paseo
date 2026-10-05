import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const runtime = resolve(process.argv[2]);
const containers = JSON.parse(readFileSync(join(runtime, "containers.json"), "utf8"));
for (const name of containers) execFileSync("docker", ["rm", "-f", name], { stdio: "inherit" });
