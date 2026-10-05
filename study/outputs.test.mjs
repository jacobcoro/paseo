import test from "node:test";
import assert from "node:assert/strict";
import sharp from "sharp";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { studentMessage } from "./policy.mjs";
import {
  archiveAssistantImages,
  assistantImageReferences,
  generatedImageFile,
  generatedImageRecords,
  rewriteGeneratedImageMarkdown,
} from "./outputs.mjs";

const directory = mkdtempSync(join(tmpdir(), "study-output-test-"));
const student = { id: "s01", agentId: "agent-1" };
const config = { recordsDir: directory };
test("archives only assistant referenced raster bytes, survives reload, and serves only owning student", async () => {
  try {
    const image = await sharp({
      create: { width: 12, height: 9, channels: 3, background: "#123456" },
    })
      .png()
      .toBuffer();
    const source = "/tmp/paseo-attachments-test/one.png";
    const readCalls = [];
    const records = await archiveAssistantImages({
      config,
      student,
      entries: [
        { item: { type: "user_message", text: `![user](${source})` } },
        { item: { type: "assistant_message", text: `Generated ![cup](${source})` } },
      ],
      readFile: async (path, maxBytes) => {
        readCalls.push([path, maxBytes]);
        return { bytes: image };
      },
    });
    assert.equal(readCalls.length, 1);
    assert.equal(readCalls[0][0], source);
    assert.equal(records.length, 1);
    assert.deepEqual(generatedImageRecords(config, student), records);
    const saved = generatedImageFile(config, student, records[0].id);
    assert.equal(readFileSync(saved.path).equals(image), true);
    assert.equal(generatedImageFile(config, { id: "s02" }, records[0].id), null);
    assert.equal(
      rewriteGeneratedImageMarkdown(`![cup](${source})`, records),
      `![cup](/study/output/${records[0].id})`,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
test("rejects prompts, traversal, credential roots, external URLs, and invalid raster payloads", async () => {
  const refs = assistantImageReferences([
    { item: { type: "user_message", text: "![prompt](/tmp/p.png)" } },
    {
      item: {
        type: "assistant_message",
        text: "![auth](file:///home/node/.codex/auth.json) ![escape](file:///tmp/../etc/passwd) ![web](https://example.test/a.png) ![svg](/tmp/a.svg) ![arbitrary temp](/tmp/private.png)",
      },
    },
  ]);
  assert.deepEqual(refs, []);
  const svg = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
  const local = mkdtempSync(join(tmpdir(), "study-output-invalid-"));
  try {
    const path = "/tmp/paseo-attachments-test/bad.png";
    const records = await archiveAssistantImages({
      config: { recordsDir: local },
      student,
      entries: [{ item: { type: "assistant_message", text: `![x](${path})` } }],
      readFile: async () => ({ bytes: svg }),
    });
    assert.deepEqual(records, []);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

test("student sockets cannot call file reads with arbitrary paths", () => {
  const account = {
    id: "s01",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    daemonPassword: "secret",
  };
  const request = (path) => ({
    type: "session",
    message: {
      type: "file_explorer_request",
      cwd: "/workspace",
      path,
      mode: "file",
      requestId: "read",
      acceptBinary: true,
    },
  });
  assert.equal(studentMessage(request("/tmp/paseo-attachments/image.png"), account), null);
  assert.equal(studentMessage(request("/home/node/.codex/auth.json"), account), null);
});

test("archives native generated images once across concurrent stream and checkpoint reads", async () => {
  const local = mkdtempSync(join(tmpdir(), "study-native-output-"));
  try {
    const bytes = await sharp({ create: { width: 10, height: 8, channels: 3, background: "blue" } })
      .png()
      .toBuffer();
    const source = "/home/node/.codex/generated_images/thread/generated.png";
    const entries = [{ item: { type: "assistant_message", text: `![Image](file://${source})` } }];
    let reads = 0;
    const input = {
      config: { recordsDir: local },
      student,
      entries,
      readFile: async () => {
        reads++;
        return { bytes };
      },
    };
    const results = await Promise.all([
      archiveAssistantImages(input),
      archiveAssistantImages(input),
    ]);
    assert.equal(reads, 1);
    assert.equal(results[0].length, 1);
    assert.deepEqual(results[1], results[0]);
    assert.equal(generatedImageRecords(input.config, student).length, 1);
    assert.equal(
      rewriteGeneratedImageMarkdown(
        entries[0].item.text,
        results[0],
        "https://study.test/study/output/",
      ),
      `![Image](https://study.test/study/output/${results[0][0].id})`,
    );
    assert.deepEqual(
      assistantImageReferences([
        { item: { type: "assistant_message", text: "![secret](/home/node/.codex/auth.png)" } },
      ]),
      [],
    );
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});

test("students can read their archived conversations but cannot send to archived or other agents", () => {
  const account = { agentId: "current", historicalAgentIds: ["previous"], workspaceId: "own" };
  const read = {
    type: "session",
    message: { type: "fetch_agent_timeline_request", agentId: "previous" },
  };
  assert.deepEqual(studentMessage(read, account), read);
  assert.equal(
    studentMessage(
      {
        type: "session",
        message: { type: "send_agent_message_request", agentId: "previous", text: "Hello" },
      },
      account,
    ),
    null,
  );
  assert.equal(
    studentMessage(
      { type: "session", message: { ...read.message, agentId: "someone-else" } },
      account,
    ),
    null,
  );
});

test("generated image collection bounds active transfers and rejects queue overflow", async () => {
  const local = mkdtempSync(join(tmpdir(), "study-output-queue-"));
  try {
    const bytes = await sharp({ create: { width: 2, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    let unblock;
    let fourStarted;
    const held = new Promise((accept) => {
      unblock = accept;
    });
    const ready = new Promise((accept) => {
      fourStarted = accept;
    });
    let active = 0,
      peak = 0,
      started = 0;
    const attempts = Array.from({ length: 70 }, (_, index) =>
      archiveAssistantImages({
        config: { recordsDir: local },
        student: { id: `queue-${index}`, agentId: `agent-${index}` },
        entries: [
          { item: { type: "assistant_message", text: "![image](/workspace/generated.png)" } },
        ],
        readFile: async () => {
          active++;
          started++;
          peak = Math.max(peak, active);
          if (started === 4) fourStarted();
          await held;
          active--;
          return { bytes };
        },
      }),
    );
    const completed = Promise.allSettled(attempts);
    await ready;
    assert.equal(started, 4);
    unblock();
    const results = await completed;
    assert.equal(peak, 4);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 68);
    assert.equal(results.filter((result) => result.status === "rejected").length, 2);
    assert.equal(active, 0);
  } finally {
    rmSync(local, { recursive: true, force: true });
  }
});
