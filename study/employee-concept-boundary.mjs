// Host-only boundary module for the existing Hermes module loader. No network/SDK.
import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { held, read } from "./employee-control.mjs";
import { privatePath } from "./employee-concept-reader-records.mjs";
import { same } from "./employee-concept-profile.mjs";
import { createConceptReaders } from "./employee-concept-readers.mjs";

export function createConceptBoundary(spec, now = Date.now) {
  const match = /^([a-f0-9]{64}):(\/[^\n]+)$/.exec(spec || "");
  if (!match) held();
  // Validate private parent before parsing the host-only pinned file.
  const parent = dirname(match[2]),
    stat = lstatSync(parent);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077 ||
    realpathSync(parent) !== parent
  )
    held();
  const host = read(match[2]);
  if (
    host.target?.kind !== "instance" ||
    !host.target.home ||
    !Array.isArray(host.agents) ||
    host.agents.length > 10 ||
    new Set(host.agents.map((a) => a.id)).size !== host.agents.length ||
    createHash("sha256").update(readFileSync(match[2])).digest("hex") !== match[1]
  )
    held();
  for (const selected of host.agents) {
    privatePath(match[2], selected.workspace);
    privatePath(host.outputDir + "/live-owner.json", selected.workspace);
  }
  const cache = new Map();
  function owner(selected) {
    read(privatePath(match[2], selected.workspace)); // Recheck regular private file before hashing.
    if (
      createHash("sha256")
        .update(readFileSync(privatePath(match[2], selected.workspace)))
        .digest("hex") !== match[1]
    )
      held();
    privatePath(match[2], selected.workspace);
    const path = privatePath(host.outputDir + "/live-owner.json", selected.workspace);
    const directory = lstatSync(dirname(path));
    if (directory.mode & 0o077) held();
    const value = read(path);
    if (
      value.kind !== "actual-concept-daemon-owner" ||
      value.state !== "current" ||
      value.config_sha256 !== match[1] ||
      !same(value.target, host.target) ||
      !value.server_id ||
      !value.manager_generation ||
      !value.observer_generation ||
      !Number.isSafeInteger(value.daemon_pid) ||
      value.daemon_pid < 1 ||
      !Number.isSafeInteger(value.observed_ms) ||
      value.observed_ms > now() ||
      now() - value.observed_ms > 4000 ||
      value.expires_ms <= now()
    )
      held();
    return value;
  }
  function frame(selected) {
    const before = owner(selected);
    const name = createHash("sha256").update(selected.id).digest("hex") + ".json";
    const value = read(privatePath(host.outputDir + "/" + name, selected.workspace));
    const after = owner(selected);
    if (
      value.kind !== "actual-concept-private-frame" ||
      value.id !== selected.id ||
      value.state !== "current" ||
      value.config_sha256 !== match[1] ||
      !same(value.target, host.target) ||
      value.server_id !== before.server_id ||
      value.manager_generation !== before.manager_generation ||
      value.observer_generation !== before.observer_generation ||
      value.daemon_pid !== before.daemon_pid ||
      before.manager_generation !== after.manager_generation ||
      before.observer_generation !== after.observer_generation ||
      before.server_id !== after.server_id ||
      before.daemon_pid !== after.daemon_pid ||
      !Number.isSafeInteger(value.observed_ms) ||
      value.observed_ms > now() ||
      now() - value.observed_ms > 4000 ||
      value.expires_ms <= now() ||
      !value.stored ||
      !value.observation
    )
      held();
    return value;
  }
  function reader(binding) {
    const id = binding?.requested_id ?? binding?.producer_id;
    const selected = host.agents.find((agent) => agent.id === id);
    if (
      !selected ||
      !selected.reader ||
      selected.reader.agentId !== id ||
      selected.reader.workspace !== selected.workspace ||
      selected.reader.workspaceId !== selected.workspaceId ||
      !same(selected.reader.target, host.target)
    )
      held();
    if (!cache.has(id)) {
      const manager = {
        get conceptOwnerGeneration() {
          return owner(selected).manager_generation;
        },
        observeConceptAgent: async (exactId) => {
          if (exactId !== id) held();
          return frame(selected).observation;
        },
      };
      const storage = {
        getCurrent: (exactId) => {
          if (exactId !== id) held();
          return frame(selected).stored;
        },
      };
      cache.set(
        id,
        createConceptReaders(selected.reader, {
          manager,
          storage,
          liveOwner: () => owner(selected),
          now,
        }),
      );
    }
    return cache.get(id);
  }
  return Object.fromEntries(
    [
      "authorize",
      "assertPrecreation",
      "observeOwner",
      "verifyAdmission",
      "assertConceptCurrent",
      "assertConceptQuiescent",
      "observeConceptTerminal",
      "observeConceptCompletion",
    ].map((name) => [name, (...args) => reader(args[0])[name](...args)]),
  );
}
let boundary;
const call = (name, args) => {
  boundary ??= createConceptBoundary(process.env.PASEO_CONCEPT_OBSERVATION_CONFIG);
  return boundary[name](...args);
};
export const authorize = (...args) => call("authorize", args);
export const assertPrecreation = (...args) => call("assertPrecreation", args);
export const observeOwner = (...args) => call("observeOwner", args);
export const verifyAdmission = (...args) => call("verifyAdmission", args);
export const assertConceptCurrent = (...args) => call("assertConceptCurrent", args);
export const assertConceptQuiescent = (...args) => call("assertConceptQuiescent", args);
export const observeConceptTerminal = (...args) =>
  call("observeConceptTerminal", "observeConceptCompletion", args);

export const observeConceptCompletion = (...args) => call("observeConceptCompletion", args);
