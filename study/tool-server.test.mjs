import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startToolWorker } from "./tool-worker.mjs";
import { registerDocument } from "./documents.mjs";
import { handleEmployeeTool } from "./employee-tools.mjs";

test("real MCP transport reads workflows, persists own files and returns download links", async () => {
  const root = mkdtempSync(join(tmpdir(), "lulu-mcp-"));
  const config = {
    recordsDir: join(root, "records"),
    students: [{ id: "s01", workspacePath: join(root, "workspace") }],
  };
  mkdirSync(config.recordsDir);
  const stop = startToolWorker(config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("study/tool-server.mjs")],
    env: {
      PATH: process.env.PATH,
      STUDY_TOOL_DIRECTORY: join(root, "workspace", ".study-tools"),
      STUDY_PUBLIC_URL: "https://study.example",
    },
  });
  const client = new Client({ name: "study-test", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.equal(listed.tools.length, 5);
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "list_files",
      "read_file",
      "read_skill",
      "run_python",
      "write_text",
    ]);
    const workflow = await client.callTool({
      name: "read_skill",
      arguments: { name: "study-documents" },
    });
    assert.equal(workflow.isError, undefined);
    assert.match(workflow.content[0].text, /python|Python/);
    const write = await client.callTool({
      name: "write_text",
      arguments: { name: "report.txt", text: "A real saved report" },
    });
    const file = JSON.parse(write.content[0].text);
    assert.equal(file.downloadUrl, "https://study.example/study/file/" + file.id);
    const read = await client.callTool({ name: "read_file", arguments: { id: file.id } });
    assert.equal(JSON.parse(read.content[0].text).text, "A real saved report");
    const foreign = await client.callTool({ name: "read_file", arguments: { id: "0".repeat(64) } });
    assert.equal(foreign.isError, true);
    for (const name of ["read_memory", "save_memory"]) {
      const unavailable = await client.callTool({ name, arguments: {} });
      assert.equal(unavailable.isError, true);
    }
  } finally {
    await client.close();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("employee MCP inventory exposes scoped production tools and denies command, send and spend tools", async () => {
  const scratch = join(homedir(), ".local", "state", "paseo-employee-tests");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, "inventory-"));
  const settings = join(root, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      profile: "employee-production",
      assignment: {
        job_id: "fixture-job",
        producer_id: "fixture-producer",
        revision: "fixture-r1",
      },
    }),
    { mode: 0o600 },
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("study/tool-server.mjs")],
    env: {
      PATH: process.env.PATH,
      STUDY_TOOL_DIRECTORY: join(root, "workspace", ".study-tools"),
      STUDY_TOOL_SETTINGS: settings,
    },
  });
  const client = new Client({ name: "employee-fixture", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), [
      "list_files",
      "read_file",
      "write_text",
    ]);
    for (const name of [
      "render_video",
      "run_python",
      "shell",
      "read_memory",
      "launch_agent",
      "send",
      "spend",
      "publish",
      "grant_access",
    ]) {
      const denied = await client.callTool({ name, arguments: {} });
      assert.equal(denied.isError, true, name);
    }
    for (const args of [{ path: "/etc/passwd" }, { id: "0".repeat(64), worker: "another-job" }]) {
      const denied = await client.callTool({ name: "read_file", arguments: args });
      assert.equal(denied.isError, true);
    }
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing configured employee settings cannot advertise the default Python tool profile", async () => {
  const scratch = join(homedir(), ".local", "state", "paseo-employee-tests");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, "missing-settings-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("study/tool-server.mjs")],
    stderr: "pipe",
    env: { PATH: process.env.PATH, STUDY_TOOL_SETTINGS: join(root, "missing.json") },
  });
  const client = new Client(
    { name: "employee-missing-settings", version: "1" },
    { capabilities: {} },
  );
  try {
    await assert.rejects(client.connect(transport));
  } finally {
    await client.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("employee host queue checks the exact job revision on every file tool and rejects revocation", async () => {
  const scratch = join(homedir(), ".local", "state", "paseo-employee-tests");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, "scope-"));
  const assignment = {
    job_id: "fixture-job",
    producer_id: "fixture-producer",
    revision: "fixture-r1",
  };
  const control = { ...assignment, active: true, expires_ms: Date.now() + 60000 };
  const controlFile = join(root, "control.json");
  writeFileSync(controlFile, JSON.stringify(control), { mode: 0o600 });
  const settings = join(root, "settings.json");
  writeFileSync(settings, JSON.stringify({ profile: "employee-production", assignment }), {
    mode: 0o600,
  });
  const worker = {
    id: "fixture-worker",
    profile: "employee-production",
    workspacePath: join(root, "workspace"),
    employeeControlFile: controlFile,
  };
  const config = { recordsDir: join(root, "records"), students: [worker] };
  mkdirSync(config.recordsDir, { mode: 0o700 });
  const own = registerDocument(
    config,
    worker,
    "packet.txt",
    Buffer.from("Approved fixture packet."),
  );
  const other = registerDocument(
    config,
    { id: "other-job", workspacePath: join(root, "other") },
    "private.txt",
    Buffer.from("Other job fixture."),
  );
  const stop = startToolWorker(config);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve("study/tool-server.mjs")],
    env: {
      PATH: process.env.PATH,
      STUDY_TOOL_DIRECTORY: join(root, "workspace", ".study-tools"),
      STUDY_TOOL_SETTINGS: settings,
    },
  });
  const client = new Client({ name: "employee-scope-fixture", version: "1" }, { capabilities: {} });
  try {
    await client.connect(transport);
    const read = await client.callTool({ name: "read_file", arguments: { id: own.id } });
    assert.equal(read.isError, undefined);
    assert.equal(JSON.parse(read.content[0].text).text, "Approved fixture packet.");
    const foreign = await client.callTool({ name: "read_file", arguments: { id: other.id } });
    assert.equal(foreign.isError, true);
    const first = await client.callTool({
      name: "write_text",
      arguments: { name: "concept.txt", text: "Unchanged fixture text." },
    });
    writeFileSync(controlFile, JSON.stringify({ ...control, revision: "fixture-r2" }));
    const stale = await client.callTool({ name: "read_file", arguments: { id: own.id } });
    assert.equal(stale.isError, true);
    const next = { ...assignment, revision: "fixture-r2" };
    writeFileSync(settings, JSON.stringify({ profile: "employee-production", assignment: next }));
    const revised = await client.callTool({
      name: "write_text",
      arguments: { name: "concept.txt", text: "Unchanged fixture text." },
    });
    assert.equal(revised.isError, undefined);
    const oldArtifact = JSON.parse(first.content[0].text);
    const newArtifact = JSON.parse(revised.content[0].text);
    assert.equal(oldArtifact.revision, "fixture-r1");
    assert.equal(newArtifact.revision, "fixture-r2");
    assert.notEqual(oldArtifact.id, newArtifact.id);
    assert.equal(newArtifact.producer_id, assignment.producer_id);
    writeFileSync(
      settings,
      JSON.stringify({
        profile: "employee-production",
        assignment: { ...next, producer_id: "another-producer" },
      }),
    );
    const changedOwner = await client.callTool({ name: "list_files", arguments: {} });
    assert.equal(changedOwner.isError, true);
    writeFileSync(settings, JSON.stringify({ profile: "employee-production", assignment: next }));
    writeFileSync(controlFile, JSON.stringify({ ...control, active: false }));
    const revoked = await client.callTool({ name: "list_files", arguments: {} });
    assert.equal(revoked.isError, true);
  } finally {
    await client.close();
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("employee media registration and render admission reject unapproved and foreign footage before execution", async () => {
  const scratch = join(homedir(), ".local", "state", "paseo-employee-tests");
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(scratch, "media-admission-"));
  const assignment = {
    job_id: "fixture-job",
    producer_id: "fixture-producer",
    revision: "fixture-r1",
  };
  const worker = {
    id: "fixture-worker",
    profile: "employee-production",
    workspacePath: join(root, "workspace"),
    employeeControlFile: join(root, "control.json"),
    employeeMediaImage: "sha256:" + "a".repeat(64),
  };
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir, { mode: 0o700 });
  writeFileSync(
    worker.employeeControlFile,
    JSON.stringify({ ...assignment, active: true, expires_ms: Date.now() + 60000 }),
    { mode: 0o600 },
  );
  const bytes = Buffer.from([0, 0, 0, 20, 102, 116, 121, 112, 105, 115, 111, 109]);
  try {
    assert.throws(() =>
      registerDocument(config, { ...worker, profile: undefined }, "source.mp4", bytes, "upload", {
        productionMedia: true,
      }),
    );
    assert.throws(() => registerDocument(config, worker, "source.mp4", bytes));
    assert.throws(() =>
      registerDocument(config, worker, "bad.mp4", Buffer.from("not video"), "upload", {
        productionMedia: true,
      }),
    );
    const unapproved = registerDocument(config, worker, "source.mp4", bytes, "upload", {
      productionMedia: true,
    });
    const foreign = registerDocument(
      config,
      { ...worker, id: "other", workspacePath: join(root, "other") },
      "foreign.mp4",
      bytes,
      "upload",
      { productionMedia: true, approvedSource: true },
    );
    for (const id of [unapproved.id, foreign.id]) {
      await assert.rejects(
        handleEmployeeTool(config, worker, {
          operation: "render_video",
          assignment,
          files: [id],
          duration_seconds: 2,
        }),
        /approved footage/,
      );
    }
    await assert.rejects(
      handleEmployeeTool(config, worker, {
        operation: "run_python",
        assignment,
        files: [],
        code: "print('escape')",
      }),
      /operation denied/,
    );
    await assert.rejects(
      handleEmployeeTool(config, worker, {
        operation: "write_text",
        assignment,
        files: [],
        name: "fake.mp4",
        text: "fake",
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
