import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { startGateway } from "./gateway.mjs";

const runtime = process.env.STUDY_TEST_RUNTIME;
if (!runtime) throw new Error("STUDY_TEST_RUNTIME must name an isolated fixture runtime");
const config = JSON.parse(readFileSync(join(runtime, "config.json"), "utf8"));
assert.equal(
  config.mode,
  "fixture",
  "Never run these destructive session tests against live research",
);
config.port = 0;
config.recordsDir = mkdtempSync(join(tmpdir(), "lulu-gateway-test-"));
let gateway = await startGateway(config);
let base = `http://127.0.0.1:${gateway.port}`;
const connections = [];
async function signIn(studentId) {
  const password = readFileSync(join(runtime, `${studentId}.login.txt`), "utf8")
    .trim()
    .split("\n")[1];
  const response = await fetch(base + "/study/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: base },
    body: JSON.stringify({ studentId, password }),
  });
  assert.equal(response.status, 200);
  return response.headers.get("set-cookie").split(";")[0];
}
function call(path, cookie, body) {
  return fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Cookie: cookie, Origin: base, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function connect(cookie) {
  const client = new DaemonClient({
    url: base.replace("http:", "ws:") + "/ws",
    clientId: crypto.randomUUID(),
    clientType: "browser",
    reconnect: { enabled: false },
    webSocketFactory: (url) => new WebSocket(url, { headers: { Cookie: cookie, Origin: base } }),
  });
  await client.connect();
  connections.push(client);
  return client;
}
const record = {
  promptId: "non-ai",
  phase: "Discover",
  task: "绘制草图",
  purpose: "",
  nextAction: "对比两种杯盖",
  modified: "not-applicable",
  adoption: "not-applicable",
  finalUse: "Synthetic test",
};
try {
  await test("anonymous requests and cross-origin login are rejected", async () => {
    assert.equal((await fetch(base + "/study/export")).status, 401);
    assert.equal(
      (
        await fetch(base + "/study/login", {
          method: "POST",
          headers: { Origin: "https://elsewhere.example" },
          body: "{}",
        })
      ).status,
      403,
    );
    await assert.rejects(connect(""));
  });
  const cookie1 = await signIn("s0101");
  const cookie2 = await signIn("s0102");
  const first = await connect(cookie1);
  const second = await connect(cookie2);
  const [one, two] = config.students;
  await test("student isolation holds for direct WebSocket requests", async () => {
    await assert.rejects(first.fetchAgent(two.agentId));
    await assert.rejects(first.sendMessage(two.agentId, "Must be denied"));
    await assert.rejects(first.createTerminal("/workspace"));
    await assert.rejects(first.setAgentModel(one.agentId, "different-model"));
    await assert.rejects(first.setAgentMode(one.agentId, "full-access"));
    await assert.rejects(first.createAgent({ config: { provider: "mock", cwd: "/workspace" } }));
    await assert.rejects(
      first.resumeAgent(
        { provider: "mock", sessionId: "foreign", cwd: "/workspace" },
        { model: "another-model" },
      ),
    );
    assert.equal((await call("/api/files", cookie1)).status, 403);
    assert.equal((await call("/mcp", cookie1)).status, 403);
  });
  await test("simultaneous prompts produce complete separate exports", async () => {
    await Promise.all([
      first.sendMessage(one.agentId, "隔离测试：学生一选择把手。"),
      second.sendMessage(two.agentId, "隔离测试：学生二选择杯盖。"),
    ]);
    await Promise.all([
      first.waitForFinish(one.agentId, 15000),
      second.waitForFinish(two.agentId, 15000),
    ]);
    const export1 = await (await call("/study/export", cookie1)).json();
    const export2 = await (await call("/study/export", cookie2)).json();
    assert.ok(
      export1.entries.some(
        (entry) => entry.item.type === "user_message" && entry.item.text.includes("学生一"),
      ),
    );
    assert.ok(
      export1.entries.some(
        (entry) => entry.item.type === "assistant_message" && entry.item.text.includes("演示回答"),
      ),
    );
    assert.ok(!JSON.stringify(export1).includes("学生二"));
    assert.ok(JSON.stringify(export2).includes("学生二"));
    assert.ok(!JSON.stringify(export2).includes("学生一"));
    const foreignPrompt = export2.entries.find((entry) => entry.item.type === "user_message").item
      .messageId;
    assert.equal(
      (await call("/study/annotations", cookie1, { ...record, promptId: foreignPrompt })).status,
      403,
    );
  });
  await test("research records validate ownership and persist on disk", async () => {
    assert.equal(
      (await call("/study/annotations", cookie1, { ...record, studentId: "s0102" })).status,
      400,
    );
    assert.equal((await call("/study/annotations", cookie1, { ...record, task: "" })).status, 400);
    assert.equal((await call("/study/annotations", cookie1, record)).status, 201);
    const exported = await (await call("/study/export", cookie1)).json();
    assert.equal(exported.annotations.length, 1);
    assert.equal(exported.annotations[0].studentId, "s0101");
    assert.equal(
      JSON.parse(readFileSync(join(config.recordsDir, "s0101.annotations.jsonl"), "utf8"))
        .nextAction,
      record.nextAction,
    );
  });
  await test("logout revokes HTTP and existing WebSocket access", async () => {
    assert.equal((await call("/study/logout", cookie1, {})).status, 200);
    assert.equal((await call("/study/export", cookie1)).status, 401);
    await assert.rejects(connect(cookie1));
  });
  await test("gateway restart restores saved research records", async () => {
    for (const client of connections) await client.close();
    await gateway.close();
    gateway = await startGateway(config);
    base = `http://127.0.0.1:${gateway.port}`;
    const freshCookie = await signIn("s0101");
    const exported = await (await call("/study/export", freshCookie)).json();
    assert.equal(exported.annotations.length, 1);
    assert.equal(exported.annotations[0].nextAction, record.nextAction);
    assert.ok(exported.entries.some((entry) => entry.item.type === "assistant_message"));
  });
} finally {
  for (const client of connections) await client.close();
  await gateway.close();
}
