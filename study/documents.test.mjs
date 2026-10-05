import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  documentFile,
  documentRecords,
  persistDocumentUpload,
  readStudentMemory,
  writeStudentMemory,
} from "./documents.mjs";

test("uploads retain originals, list across chats, reject other students and recover stored memory", async () => {
  const root = mkdtempSync(join(tmpdir(), "lulu-documents-"));
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir);
  const student = { id: "s01", workspacePath: join(root, "workspace") };
  try {
    const bytes = Buffer.from("产品,容量\n水杯,500\n");
    const record = await persistDocumentUpload(config, student, {
      name: "研究数据.csv",
      data: bytes.toString("base64"),
    });
    assert.equal(readFileSync(documentFile(config, student, record.id).path).equals(bytes), true);
    assert.equal(documentRecords(config, { ...student, agentId: "second-chat" })[0].id, record.id);
    assert.equal(documentFile(config, { id: "s02" }, record.id), null);
    await assert.rejects(
      persistDocumentUpload(config, student, {
        name: "../escape.csv",
        data: bytes.toString("base64"),
      }),
    );
    await assert.rejects(
      persistDocumentUpload(config, student, { name: "bad.pdf", data: bytes.toString("base64") }),
    );
    await assert.rejects(
      persistDocumentUpload(config, student, {
        name: "script.html",
        data: bytes.toString("base64"),
      }),
    );
    writeStudentMemory(config, student, "项目：老年人水杯");
    assert.equal(readStudentMemory(config, student).text, "项目：老年人水杯");
    writeStudentMemory(config, student, "");
    assert.equal(readStudentMemory(config, student).text, "");
    assert.throws(() => writeStudentMemory(config, student, "x".repeat(8193)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
