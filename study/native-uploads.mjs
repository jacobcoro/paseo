import { posix } from "node:path";
import {
  decodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { DOCUMENT_LIMITS, nativeDocumentMimeType, registerDocument } from "./documents.mjs";

// The student image sets PASEO_HOME to /home/node/.paseo.
const UPLOAD_ROOT = "/home/node/.paseo/uploads";
const SENSITIVE_NAME = /(^|[._-])(auth|credentials?|secret|token|private)([._-]|$)/i;

function safeDocumentName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= 180 &&
    Buffer.byteLength(name) <= 255 &&
    name.trim() === name &&
    name === posix.basename(name) &&
    !/[\\/:*?"<>|]/.test(name) &&
    !/\p{Cc}/u.test(name) &&
    !name.startsWith(".") &&
    !/^\.env(?:\.|$)/i.test(name) &&
    !SENSITIVE_NAME.test(name) &&
    nativeDocumentMimeType(name) !== null
  );
}

function safeMimeType(name, mimeType) {
  const expected = nativeDocumentMimeType(name);
  return mimeType === "application/octet-stream" || mimeType === expected;
}

function safeUploadSize(size) {
  return Number.isInteger(size) && size > 0 && size <= DOCUMENT_LIMITS.fileBytes;
}

export function validateNativeUploadRequest(request) {
  return (
    request?.type === "file.upload.request" &&
    typeof request.requestId === "string" &&
    request.requestId.length > 0 &&
    request.requestId.length <= 512 &&
    typeof request.modifiedAt === "string" &&
    request.modifiedAt.length > 0 &&
    request.modifiedAt.length <= 64 &&
    safeDocumentName(request.fileName) &&
    safeMimeType(request.fileName, request.mimeType) &&
    safeUploadSize(request.size)
  );
}

export function isRegisteredNativeAttachment(attachment, records) {
  if (!attachment || attachment.type !== "uploaded_file") return false;
  return records.some(
    (record) =>
      record.kind === "upload" &&
      record.nativeUploadId === attachment.id &&
      record.nativePath === attachment.path &&
      record.name === attachment.fileName &&
      record.nativeMimeType === attachment.mimeType &&
      record.bytes === attachment.size,
  );
}

export function validateNativeUploadFile(request, file) {
  if (
    !validateNativeUploadRequest(request) ||
    !file ||
    file.type !== "uploaded_file" ||
    typeof file.id !== "string" ||
    !/^upload_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      file.id,
    ) ||
    file.fileName !== request.fileName ||
    file.mimeType !== request.mimeType ||
    file.size !== request.size ||
    file.path !== `${UPLOAD_ROOT}/${file.id}/${file.fileName}` ||
    posix.normalize(file.path) !== file.path
  )
    throw new Error("Native file upload path or metadata is invalid");
  return file;
}

export async function archiveNativeUpload({ config, student, request, file, readFile }) {
  validateNativeUploadFile(request, file);
  const bytes = await readFile(file.path, DOCUMENT_LIMITS.fileBytes);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== request.size)
    throw new Error("Uploaded file size does not match its request");
  return registerDocument(config, student, file.fileName, bytes, "upload", {
    nativeUploadId: file.id,
    nativePath: file.path,
    nativeMimeType: file.mimeType,
  });
}

export function createNativeUploadTracker() {
  const pending = new Map();
  function begin(request) {
    if (!validateNativeUploadRequest(request)) throw new Error("Unsupported or oversized file");
    if (pending.has(request.requestId)) throw new Error("File upload is already active");
    pending.set(request.requestId, { request, started: false, ended: false, received: 0 });
  }
  function receive(bytes) {
    const frame = decodeFileTransferFrame(bytes);
    const state = frame && pending.get(frame.requestId);
    if (!frame || !state || state.ended) throw new Error("Unregistered file transfer frame");
    if (frame.opcode === FileTransferOpcode.FileBegin) {
      if (
        state.started ||
        frame.metadata.size !== state.request.size ||
        frame.metadata.mime !== state.request.mimeType ||
        frame.metadata.fileName !== state.request.fileName ||
        frame.metadata.encoding !== "binary" ||
        frame.metadata.modifiedAt !== state.request.modifiedAt
      )
        throw new Error("File transfer metadata does not match its request");
      state.started = true;
      return { request: state.request, frame };
    }
    if (!state.started) throw new Error("File transfer started without metadata");
    if (frame.opcode === FileTransferOpcode.FileChunk) {
      state.received += frame.payload.byteLength;
      if (state.received > state.request.size) throw new Error("File transfer is oversized");
      return { request: state.request, frame };
    }
    if (state.received !== state.request.size)
      throw new Error("File transfer size does not match its request");
    state.ended = true;
    return { request: state.request, frame };
  }
  function complete(requestId, file) {
    const state = pending.get(requestId);
    if (!state) throw new Error("File upload response has no matching request");
    if (file && (!state.ended || file.size !== state.request.size))
      throw new Error("File upload completed before its transfer ended");
    pending.delete(requestId);
    return { request: state.request, file };
  }
  function cancel(requestId) {
    pending.delete(requestId);
  }
  return { begin, receive, complete, cancel };
}
