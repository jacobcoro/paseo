import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createResearchArchive } from "./export-archive.mjs";
import { createRecorder } from "./recorder.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "research-export-test-"));
  const config = { recordsDir: join(root, "records") };
  const sessionId = "11111111-2222-4333-a444-555555555555";
  const student = {
    id: "s0101",
    agentId: "agent-one",
    ownedConversationIds: ["agent-two"],
    providerRecordsDirs: [join(root, "sessions")],
  };
  mkdirSync(config.recordsDir);
  const write = (path, bytes) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, bytes);
  };
  const image = Buffer.from("original-image-bytes");
  const provider = Buffer.from("processed-image-bytes");
  const id = createHash("sha256").update(image).digest("hex");
  const providerId = createHash("sha256").update(provider).digest("hex");
  const docId = "d".repeat(64);
  const generatedId = "e".repeat(64);
  const data = {
    studentId: student.id,
    conversations: [
      {
        agentId: student.agentId,
        entries: [
          { item: { type: "user_message", text: "first" } },
          { item: { type: "assistant_message", text: "answer" } },
        ],
      },
    ],
    providerSessions: [{ agentId: student.agentId, sessionId, provider: "codex" }],
    submittedImages: [{ id, providerId, format: "png", clientMessageId: "prompt-one" }],
    generatedImages: [{ id: generatedId, studentId: student.id, format: "png" }],
    submittedDocuments: [{ id: docId, name: "design.docx" }],
    documentOutputs: [],
  };
  for (const [suffix, records] of [
    ["images", data.submittedImages],
    ["generated-images", data.generatedImages],
    ["documents", data.submittedDocuments],
  ])
    write(
      join(config.recordsDir, `${student.id}.${suffix}.jsonl`),
      records.map(JSON.stringify).join("\n") + "\n",
    );
  write(join(config.recordsDir, "images", student.id, id + ".png"), image);
  write(join(config.recordsDir, "images", student.id, providerId + ".png"), provider);
  write(
    join(config.recordsDir, "generated-images", student.id, generatedId + ".png"),
    "generated-bytes",
  );
  write(join(config.recordsDir, "documents", student.id, docId), "document-bytes");
  write(join(config.recordsDir, "s0101.requests.jsonl"), '{"prompt":"first"}\n{"partial":');
  write(
    join(root, "sessions/2026/10/06", `rollout-2026-10-06T00-00-00-${sessionId}.jsonl`),
    '{"type":"turn_context","payload":{"model":"gpt-6-luna","effort":"low"}}\n',
  );
  write(
    join(
      root,
      "sessions/2026/10/06",
      "rollout-2026-10-06T00-00-00-ffffffff-ffff-4fff-afff-ffffffffffff.jsonl",
    ),
    "unrelated-session\n",
  );
  write(join(config.recordsDir, "config.json"), "private-auth-do-not-export");
  return { root, config, student, data, id, providerId, docId, generatedId };
}

test("archive restores all conversations, original/processed/generated assets, logs and only registered native sessions", async () => {
  const f = fixture();
  let archive;
  try {
    archive = await createResearchArchive(f.config, [f.student], { students: [f.data] });
    const restored = join(f.root, "restored");
    mkdirSync(restored);
    execFileSync("tar", ["-xzf", archive.path, "-C", restored]);
    const root = join(restored, "research");
    const manifest = JSON.parse(readFileSync(join(root, "manifest.json")));
    for (const entry of manifest.files) {
      const bytes = readFileSync(join(root, entry.path));
      assert.equal(bytes.length, entry.bytes);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), entry.sha256);
    }
    assert.deepEqual(JSON.parse(readFileSync(join(root, "results.json"))).students[0], f.data);
    for (const path of [
      `images/s0101/${f.id}.png`,
      `images/s0101/${f.providerId}.png`,
      `generated-images/s0101/${f.generatedId}.png`,
      `documents/s0101/${f.docId}`,
    ])
      assert.ok(existsSync(join(root, path)));
    assert.equal(
      readFileSync(join(root, "logs/s0101.requests.jsonl"), "utf8"),
      '{"prompt":"first"}\n',
    );
    assert.ok(manifest.gaps.some((item) => /incomplete/.test(item.reason)));
    assert.equal(manifest.files.filter((item) => item.path.startsWith("provider/")).length, 1);
    assert.ok(!manifest.files.some((item) => /config|auth|ffffffff/.test(item.path)));
    const directory = join(archive.path, "..");
    await archive.cleanup();
    archive = null;
    assert.equal(existsSync(directory), false);
  } finally {
    if (archive) await archive.cleanup();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("missing registered assets fail export instead of silently producing an incomplete archive", async () => {
  const f = fixture();
  try {
    rmSync(join(f.config.recordsDir, "images", "s0101", f.id + ".png"));
    await assert.rejects(
      createResearchArchive(f.config, [f.student], { students: [f.data] }),
      /ENOENT/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("symlinked research files are never archived", async () => {
  const f = fixture();
  try {
    rmSync(join(f.config.recordsDir, "s0101.requests.jsonl"));
    symlinkSync(
      join(f.config.recordsDir, "config.json"),
      join(f.config.recordsDir, "s0101.requests.jsonl"),
    );
    await assert.rejects(
      createResearchArchive(f.config, [f.student], { students: [f.data] }),
      /regular files/,
    );
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("recorder owns one timeline and keeps raw events independent of browser connections", async () => {
  const f = fixture();
  let receive;
  const selected = [];
  const released = [];
  const client = {
    subscribeRawMessages(handler) {
      receive = handler;
      return () => {
        receive = null;
      };
    },
    subscribeAgentTimeline(id) {
      selected.push(id);
      return {
        ready: Promise.resolve(),
        async release() {
          released.push(id);
        },
      };
    },
  };
  try {
    const recorder = createRecorder(client, f.config, f.student);
    await recorder.select("agent-one");
    await recorder.select("agent-one");
    receive({
      type: "agent_stream",
      payload: {
        agentId: "agent-one",
        event: { type: "assistant_text", text: "recorded while browser absent" },
      },
    });
    receive({
      type: "agent_stream",
      payload: { agentId: "foreign", event: { text: "must not record" } },
    });
    await recorder.select("new");
    await recorder.select("agent-two");
    receive({ type: "agent.timeline.replacement", payload: { agentId: "agent-two", entries: [] } });
    await recorder.close();
    assert.deepEqual(selected, ["agent-one", "agent-two"]);
    assert.deepEqual(released, selected);
    assert.equal(receive, null);
    const events = readFileSync(join(f.config.recordsDir, "s0101.events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map(JSON.parse);
    assert.equal(events.length, 2);
    assert.equal(events[0].message.payload.event.text, "recorded while browser absent");
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
