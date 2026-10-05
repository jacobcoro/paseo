import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { documentRecords, DOCUMENT_LIMITS } from "./documents.mjs";
import {
  archiveNativeUpload,
  createNativeUploadTracker,
  isRegisteredNativeAttachment,
  validateNativeUploadFile,
  validateNativeUploadRequest,
} from "./native-uploads.mjs";
import { studentMessage } from "./policy.mjs";
import { nativeCreation } from "./native-controls.mjs";
import { studyModel, studyReasoning } from "./chat-profile.mjs";

const request = {
  type: "file.upload.request",
  requestId: "request-1",
  fileName: "brief.pdf",
  mimeType: "application/octet-stream",
  size: 9,
  modifiedAt: "2026-10-06T00:00:00.000Z",
};
const file = {
  type: "uploaded_file",
  id: "upload_12345678-1234-4123-8123-123456789abc",
  fileName: request.fileName,
  mimeType: request.mimeType,
  size: request.size,
  path: "/home/node/.paseo/uploads/upload_12345678-1234-4123-8123-123456789abc/brief.pdf",
};
function frame(opcode, payload) {
  return encodeFileTransferFrame({ opcode, requestId: request.requestId, ...payload });
}

test("native document requests allow supported files within the study limit", () => {
  assert.equal(validateNativeUploadRequest(request), true);
  assert.equal(
    validateNativeUploadRequest({ ...request, size: DOCUMENT_LIMITS.fileBytes + 1 }),
    false,
  );
  assert.equal(validateNativeUploadRequest({ ...request, fileName: "../../brief.pdf" }), false);
  assert.equal(validateNativeUploadRequest({ ...request, fileName: "auth.json" }), false);
  assert.equal(validateNativeUploadRequest({ ...request, fileName: "private.key" }), false);
  assert.equal(validateNativeUploadRequest({ ...request, fileName: "picture.png" }), false);
});

test("native transfer frames must match one registered request and its size", () => {
  const tracker = createNativeUploadTracker();
  tracker.begin(request);
  assert.throws(() =>
    tracker.receive(frame(FileTransferOpcode.FileChunk, { payload: Buffer.alloc(1) })),
  );
  assert.throws(() =>
    tracker.receive(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "foreign-request",
      }),
    ),
  );
  tracker.receive(
    frame(FileTransferOpcode.FileBegin, {
      metadata: {
        mime: request.mimeType,
        size: request.size,
        encoding: "binary",
        modifiedAt: request.modifiedAt,
        fileName: request.fileName,
      },
    }),
  );
  tracker.receive(frame(FileTransferOpcode.FileChunk, { payload: Buffer.alloc(request.size) }));
  tracker.receive(frame(FileTransferOpcode.FileEnd, {}));
  assert.deepEqual(tracker.complete(request.requestId, file), { request, file });

  const invalid = createNativeUploadTracker();
  invalid.begin(request);
  assert.throws(
    () =>
      invalid.receive(
        frame(FileTransferOpcode.FileBegin, {
          metadata: {
            mime: request.mimeType,
            size: request.size + 1,
            encoding: "binary",
            modifiedAt: request.modifiedAt,
            fileName: request.fileName,
          },
        }),
      ),
    /metadata/,
  );
  assert.throws(() =>
    validateNativeUploadFile(request, { ...file, path: "/workspace/foreign.pdf" }),
  );
});

test("native uploads are archived per student and attachments need their exact ledger entry", async () => {
  const root = mkdtempSync(join(tmpdir(), "study-native-upload-"));
  const config = { recordsDir: join(root, "records") };
  const student = { id: "s0101", workspacePath: join(root, "workspace") };
  const bytes = Buffer.from("%PDF-1.7");
  const documentRequest = { ...request, size: bytes.byteLength };
  const documentFile = { ...file, size: bytes.byteLength };
  const record = await archiveNativeUpload({
    config,
    student,
    request: documentRequest,
    file: documentFile,
    readFile: async (path, maxBytes) => {
      assert.equal(path, documentFile.path);
      assert.equal(maxBytes, DOCUMENT_LIMITS.fileBytes);
      return bytes;
    },
  });
  assert.equal(record.nativeUploadId, documentFile.id);
  assert.equal(record.nativePath, documentFile.path);
  assert.equal(record.nativeMimeType, documentFile.mimeType);
  assert.deepEqual(
    readFileSync(join(config.recordsDir, "documents", student.id, record.id)),
    bytes,
  );

  const attachment = { ...documentFile };
  const records = documentRecords(config, student);
  assert.equal(isRegisteredNativeAttachment(attachment, records), true);
  assert.equal(
    isRegisteredNativeAttachment({ ...attachment, path: "/workspace/auth.json" }, records),
    false,
  );
  assert.equal(
    studentMessage(
      {
        type: "session",
        message: {
          type: "send_agent_message_request",
          agentId: "agent-1",
          text: "Summarize the document",
          attachments: [attachment],
        },
      },
      { id: student.id, agentId: "agent-1", workspaceId: "workspace-1" },
      records,
    )?.type,
    "session",
  );
  const creation = {
    type: "agent.create.request",
    workspaceId: "workspace-1",
    config: { provider: "codex", cwd: "/workspace" },
    initialPrompt: "Summarize the document",
    idempotencyKey: "creation-1",
    attachments: [attachment],
  };
  const models = [
    {
      provider: "codex",
      id: studyModel,
      label: studyModel,
      thinkingOptions: [{ id: studyReasoning, label: "High" }],
      defaultThinkingOptionId: studyReasoning,
    },
  ];
  assert.deepEqual(
    nativeCreation(creation, { workspaceId: "workspace-1" }, models, records).attachments,
    [attachment],
  );
  assert.throws(
    () =>
      nativeCreation(
        { ...creation, attachments: [{ ...attachment, path: "/workspace/auth.json" }] },
        { workspaceId: "workspace-1" },
        models,
        records,
      ),
    /attachment is unavailable/,
  );
  assert.equal(
    studentMessage(
      {
        type: "session",
        message: {
          type: "send_agent_message_request",
          agentId: "agent-1",
          text: "Read this foreign path",
          attachments: [{ ...attachment, id: "upload_foreign" }],
        },
      },
      { id: student.id, agentId: "agent-1", workspaceId: "workspace-1" },
      records,
    ),
    null,
  );
  assert.equal(
    studentMessage(
      {
        type: "session",
        message: {
          type: "agent.create.request",
          workspaceId: "workspace-1",
          config: { provider: "codex", cwd: "/workspace" },
          initialPrompt: "Summarize the document",
          idempotencyKey: "creation-1",
          attachments: [attachment],
        },
      },
      { id: student.id, agentId: "agent-1", workspaceId: "workspace-1" },
      records,
    )?.type,
    "session",
  );
  assert.equal(
    studentMessage(
      {
        type: "session",
        message: {
          type: "agent.create.request",
          workspaceId: "workspace-1",
          config: { provider: "codex", cwd: "/workspace" },
          initialPrompt: "Read another student's path",
          idempotencyKey: "creation-2",
          attachments: [{ ...attachment, path: "/home/node/.paseo/uploads/foreign/auth.json" }],
        },
      },
      { id: student.id, agentId: "agent-1", workspaceId: "workspace-1" },
      records,
    ),
    null,
  );
});
