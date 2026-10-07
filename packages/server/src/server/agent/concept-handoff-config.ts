import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative } from "node:path";
import { createHash } from "node:crypto";
export interface ConceptHandoffConfig {
  target: { kind: "instance"; home: string };
  outputDir: string;
  agents: { id: string; workspaceId: string; workspace: string; reader: Record<string, unknown> }[];
}
export function privateDirectory(path: string, workspaces: string[]): void {
  const st = lstatSync(path);
  if (
    !isAbsolute(path) ||
    st.isSymbolicLink() ||
    !st.isDirectory() ||
    st.uid !== process.getuid?.() ||
    st.mode & 0o077 ||
    realpathSync(path) !== path ||
    workspaces.some((workspace) => {
      const inside = relative(workspace, path);
      return !inside || (!inside.startsWith("../") && inside !== "..");
    })
  )
    throw Error("Concept private observation path held");
}
export function loadConceptHandoffConfig(spec: string, home: string): ConceptHandoffConfig {
  if (!isAbsolute(home)) throw Error("Absolute private instance required");
  const match = /^([a-f0-9]{64}):(\/[^\n]+)$/.exec(spec);
  if (!match) throw Error("Pinned concept observation configuration required");
  const path = match[2],
    st = lstatSync(path);
  privateDirectory(dirname(path), []);
  if (
    !st.isFile() ||
    st.isSymbolicLink() ||
    st.mode & 0o077 ||
    st.uid !== process.getuid?.() ||
    st.size > 65536
  )
    throw Error("Concept private host configuration held");
  const bytes = readFileSync(path);
  if (createHash("sha256").update(bytes).digest("hex") !== match[1])
    throw Error("Concept host config drift");
  const value = JSON.parse(bytes.toString()) as ConceptHandoffConfig;
  if (
    !value.target ||
    value.target.kind !== "instance" ||
    value.target.home !== home ||
    !Array.isArray(value.agents) ||
    value.agents.length > 10 ||
    new Set(value.agents.map((a) => a.id)).size !== value.agents.length
  )
    throw Error("Exact concept private target required");
  validateSelection(value.agents);
  const workspaces = value.agents.map((a) => a.workspace);
  privateDirectory(dirname(path), workspaces);
  privateDirectory(value.outputDir, workspaces);
  return value;
}

function validateSelection(agents: ConceptHandoffConfig["agents"]) {
  for (const agent of agents) {
    if (
      !/^[a-f0-9-]{36}$/.test(agent.id) ||
      !agent.workspaceId ||
      !isAbsolute(agent.workspace) ||
      !agent.reader
    )
      throw Error("Exact registered concept selection required");
  }
}
