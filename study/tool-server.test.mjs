import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startToolWorker } from "./tool-worker.mjs";

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
