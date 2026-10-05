import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { documentFile, documentRecords, registerDocument } from "./documents.mjs";

test("registered files retain originals, list across chats and reject other students", () => {
  const root = mkdtempSync(join(tmpdir(), "lulu-documents-"));
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir);
  const student = { id: "s01", workspacePath: join(root, "workspace") };
  try {
    const bytes = Buffer.from("产品,容量\n水杯,500\n");
    const record = registerDocument(config, student, "研究数据.csv", bytes);
    assert.equal(readFileSync(documentFile(config, student, record.id).path).equals(bytes), true);
    assert.equal(documentRecords(config, { ...student, agentId: "second-chat" })[0].id, record.id);
    assert.equal(documentFile(config, { id: "s02" }, record.id), null);
    assert.throws(() => registerDocument(config, student, "../escape.csv", bytes));
    assert.throws(() => registerDocument(config, student, "bad.pdf", bytes));
    assert.throws(() => registerDocument(config, student, "script.html", bytes));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("storage quotas count each archival document ID once", () => {
  const root = mkdtempSync(join(tmpdir(), "lulu-document-quota-"));
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir);
  const student = { id: "s01", workspacePath: join(root, "workspace") };
  try {
    const ledger = join(config.recordsDir, `${student.id}.documents.jsonl`);
    const duplicate = { id: "same-archive-id", bytes: 60 * 1024 * 1024 };
    appendFileSync(ledger, `${JSON.stringify(duplicate)}\n${JSON.stringify(duplicate)}\n`);
    const record = registerDocument(config, student, "new.txt", Buffer.from("new"));
    assert.equal(record.bytes, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
