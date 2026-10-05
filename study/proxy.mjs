import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { studentMessage } from "./policy.mjs";
import { persistImages } from "./images.mjs";
import { rewriteGeneratedImageMarkdown } from "./outputs.mjs";
import { filterStudentResponse } from "./native-controls.mjs";
import { documentRecords, DOCUMENT_LIMITS } from "./documents.mjs";
import { createNativeUploadTracker, NATIVE_UPLOAD_LIMITS } from "./native-uploads.mjs";

const MAX_CONTROL_FRAME_BYTES = 12 * 1024 * 1024;
const MAX_QUEUED_INPUT_BYTES = 16 * 1024 * 1024;
// Four active 10 MiB transfers define the largest valid upload backlog.
const MAX_PENDING_DATA_BYTES = 40 * 1024 * 1024;
const MAX_QUEUED_CONTROL_FRAMES = 100;
const MAX_QUEUED_BINARY_FRAMES =
  NATIVE_UPLOAD_LIMITS.active *
  (Math.ceil(DOCUMENT_LIMITS.fileBytes / NATIVE_UPLOAD_LIMITS.chunkBytes) + 2);

function rewriteImages(text, records, origin) {
  return rewriteGeneratedImageMarkdown(text, records, origin + "/study/output/");
}
function deny(browser, message, error) {
  if (!message?.requestId || browser.readyState !== WebSocket.OPEN) return;
  browser.send(
    JSON.stringify({
      type: "session",
      message: {
        type: "rpc_error",
        payload: {
          requestId: message.requestId,
          requestType: message.type,
          code: "access_denied",
          error,
        },
      },
    }),
  );
}

function sendUpstream(data, binary, browser, upstream, pending, pendingState) {
  const size = typeof data === "string" ? Buffer.byteLength(data) : data.length;
  if (upstream.readyState === WebSocket.OPEN) {
    if (upstream.bufferedAmount + size > MAX_PENDING_DATA_BYTES) {
      browser.close(1013, "Upload queue is full; reconnect");
      return;
    }
    upstream.send(data, { binary });
    return;
  }
  if (
    upstream.readyState === WebSocket.CONNECTING &&
    pendingState.bytes + size <= MAX_PENDING_DATA_BYTES
  ) {
    pending.push({ data, binary });
    pendingState.bytes += size;
    return;
  }
  browser.close(1013, "Try reconnecting");
}

function relayNativeUploadFrame({ raw, browser, upstream, pending, tracker, pendingState }) {
  try {
    tracker.receive(raw);
  } catch {
    browser.close(1008, "Unregistered or invalid file transfer");
    return;
  }
  sendUpstream(raw, true, browser, upstream, pending, pendingState);
}

async function archiveUploadResponse({ message, browser, student, tracker, recordNativeUpload }) {
  if (message?.type !== "file.upload.response") return false;
  const requestId = message.payload?.requestId;
  if (message.payload?.error) {
    tracker.cancel(requestId);
    return false;
  }
  try {
    const upload = tracker.complete(requestId, message.payload?.file);
    if (!upload.file) throw new Error("The uploaded file was not returned by the daemon");
    if (typeof recordNativeUpload !== "function")
      throw new Error("The uploaded file could not be archived");
    await recordNativeUpload(student, upload.request, upload.file);
    return false;
  } catch (error) {
    tracker.cancel(requestId);
    deny(
      browser,
      { requestId, type: "file.upload.request" },
      error.message || "Could not archive the uploaded file",
    );
    if (typeof requestId !== "string" || !requestId)
      browser.close(1011, "Uploaded file archival failed");
    return true;
  }
}

function collectAssistantMessages(value, entries) {
  if (!value || typeof value !== "object") return;
  if (value.type === "assistant_message" && typeof value.text === "string")
    entries.push({ item: value });
  for (const child of Object.values(value)) collectAssistantMessages(child, entries);
}

export function installProxy({
  server,
  config,
  authenticate,
  checkOrigin,
  sessions,
  socketPairs,
  limits,
  getConversationSettings,
  onAssistantTimeline,
  prepareConversation,
  handleStudentRequest,
  recordNativeUpload,
}) {
  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_CONTROL_FRAME_BYTES,
  });
  server.on("upgrade", (request, socket, head) => {
    const session = authenticate(request);
    const owned = [...socketPairs].filter((pair) => pair.studentId === session?.studentId).length;
    if (request.url !== "/ws" || !session?.student || !checkOrigin(request) || owned >= 3) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (browser) => {
      const upstream = new WebSocket(session.student.daemonUrl, {
        headers: { Authorization: `Bearer ${session.student.daemonPassword}` },
      });
      const pair = { browser, upstream, token: session.token, studentId: session.studentId };
      socketPairs.add(pair);
      const pending = [];
      const pendingState = { bytes: 0 };
      const nativeUploads = createNativeUploadTracker({
        onExpire: (upload) => {
          deny(
            browser,
            { requestId: upload.requestId, type: upload.type },
            "File upload timed out",
          );
          browser.close(1008, "File upload timed out");
        },
      });
      let chain = Promise.resolve();
      upstream.on("open", () => {
        for (const frame of pending) upstream.send(frame.data, { binary: frame.binary });
        pending.length = 0;
        pendingState.bytes = 0;
      });
      async function prepare(allowed) {
        if (
          allowed.message?.agentId &&
          [
            "send_agent_message_request",
            "fetch_agent_timeline_request",
            "agent.timeline.set_subscription.request",
          ].includes(allowed.message.type)
        ) {
          try {
            await prepareConversation?.(session.student, allowed.message.agentId);
          } catch (error) {
            deny(browser, allowed.message, error.message);
            return false;
          }
        }
        return true;
      }
      async function archiveHandled(message) {
        const entries = message.payload?.entries?.filter(
          (entry) => entry.item?.type === "assistant_message",
        );
        if (entries?.length && onAssistantTimeline) {
          const records = await onAssistantTimeline(session.student, entries);
          for (const entry of entries)
            entry.item.text = rewriteImages(entry.item.text, records || [], origin);
        }
        return filterStudentResponse(message);
      }
      async function prepareAllowedMessage(allowed) {
        if (allowed.message?.type === "file.upload.request") {
          try {
            nativeUploads.begin(allowed.message);
          } catch (error) {
            deny(browser, allowed.message, error.message);
            return false;
          }
        }
        try {
          const handled = await handleStudentRequest(session.student, allowed.message);
          if (handled) {
            browser.send(
              JSON.stringify({ type: "session", message: await archiveHandled(handled) }),
            );
            return false;
          }
        } catch (error) {
          deny(browser, allowed.message, error.message);
          return false;
        }
        return prepare(allowed);
      }
      async function recordPrompt(allowed) {
        const quotaError = limits.prompt(session.student);
        if (quotaError) {
          deny(browser, allowed.message, quotaError);
          return false;
        }
        let images;
        try {
          images = await persistImages(allowed.message, session.student, config);
        } catch (error) {
          deny(browser, allowed.message, error.message);
          return false;
        }
        appendFileSync(
          join(config.recordsDir, `${session.studentId}.requests.jsonl`),
          JSON.stringify({
            receivedAt: new Date().toISOString(),
            agentId: allowed.message.agentId,
            message: { ...allowed.message, images },
            documents: documentRecords(config, session.student).map((document) => {
              const result = {
                id: document.id,
                name: document.name,
                mimeType: document.mimeType,
                bytes: document.bytes,
                kind: document.kind,
              };
              if (document.nativeUploadId) {
                result.nativeUploadId = document.nativeUploadId;
                result.nativePath = document.nativePath;
              }
              return result;
            }),
            settings: await getConversationSettings(session.student, allowed.message.agentId),
          }) + "\n",
          { mode: 0o600 },
        );
        return true;
      }
      async function handleText(raw) {
        const original = JSON.parse(raw.toString());
        const allowed = studentMessage(
          original,
          session.student,
          documentRecords(config, session.student),
        );
        if (!allowed) {
          appendFileSync(
            join(config.recordsDir, `${session.studentId}.denied.jsonl`),
            JSON.stringify({
              at: new Date().toISOString(),
              type: original.message?.type || original.type,
            }) + "\n",
            { mode: 0o600 },
          );
          deny(
            browser,
            original.message,
            "This action is unavailable in the student study. Use up to 4 PNG/JPEG/WebP images, each under 2 MiB.",
          );
          return;
        }
        if (!(await prepareAllowedMessage(allowed))) return;
        if (
          allowed.type === "session" &&
          allowed.message?.type === "send_agent_message_request" &&
          !(await recordPrompt(allowed))
        )
          return;
        if (allowed.message?.type === "get_providers_snapshot_request")
          delete allowed.message.ifNoneMatch;
        sendUpstream(JSON.stringify(allowed), false, browser, upstream, pending, pendingState);
      }
      async function handle(raw, binary) {
        if (!sessions.has(session.token) || session.expires < Date.now()) {
          browser.close(1008, "Session expired");
          return;
        }
        if (binary)
          return relayNativeUploadFrame({
            raw,
            browser,
            upstream,
            pending,
            tracker: nativeUploads,
            pendingState,
          });
        await handleText(raw);
      }
      let queued = 0;
      let queuedInputBytes = 0;
      let queuedBinaryFrames = 0;
      function invalid() {
        browser.close(1008, "Invalid request");
      }
      function dequeue() {
        queued--;
      }
      function finishInput(binary, size) {
        return () => {
          queuedInputBytes -= size;
          if (binary) queuedBinaryFrames--;
          else dequeue();
        };
      }
      browser.on("message", (raw, binary) => {
        if (!binary && !limits.allow("frames:" + session.studentId, 120, 10000)) {
          browser.close(1008, "Too many requests");
          return;
        }
        if (
          raw.length > (binary ? NATIVE_UPLOAD_LIMITS.frameBytes : MAX_CONTROL_FRAME_BYTES) ||
          (binary
            ? queuedBinaryFrames >= MAX_QUEUED_BINARY_FRAMES
            : queued >= MAX_QUEUED_CONTROL_FRAMES) ||
          queuedInputBytes + raw.length > MAX_QUEUED_INPUT_BYTES
        ) {
          browser.close(1008, "Too much pending data");
          return;
        }
        if (binary) queuedBinaryFrames++;
        else queued++;
        queuedInputBytes += raw.length;
        chain = chain
          .then(handle.bind(null, raw, binary))
          .catch(invalid)
          .finally(finishInput(binary, raw.length));
      });
      const origin = `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${request.headers.host}`;
      let outputChain = Promise.resolve();
      let queuedOutputBytes = 0;
      function outputDelivered(size) {
        queuedOutputBytes -= size;
      }
      async function forwardEnvelope(raw) {
        const envelope = JSON.parse(raw.toString());
        const message = envelope.type === "session" ? envelope.message : envelope;
        filterStudentResponse(message);
        if (
          await archiveUploadResponse({
            message,
            browser,
            student: session.student,
            tracker: nativeUploads,
            recordNativeUpload,
          })
        )
          return;
        if (message?.type === "rpc_error" && message.payload?.requestType === "file.upload.request")
          nativeUploads.cancel(message.payload.requestId);
        const payload = message?.payload || message;
        const ownedAgents = [
          session.student.agentId,
          ...(session.student.ownedConversationIds || []),
          ...(session.student.historicalAgentIds || []),
          ...(session.student.preservedAgentIds || []),
        ];
        const entries = [];
        if (ownedAgents.includes(payload?.agentId)) collectAssistantMessages(payload, entries);
        if (entries.length && onAssistantTimeline) {
          const records = await onAssistantTimeline(session.student, entries);
          for (const entry of entries)
            entry.item.text = rewriteImages(entry.item.text, records || [], origin);
        }
        if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(envelope));
      }
      async function forward(raw, binary) {
        if (!binary) {
          try {
            await forwardEnvelope(raw);
            return;
          } catch {
            try {
              const envelope = JSON.parse(raw.toString());
              const message = envelope.type === "session" ? envelope.message : envelope;
              if (message?.type === "file.upload.response") {
                browser.close(1011, "Uploaded file archival failed");
                return;
              }
            } catch {}
          }
        }
        if (browser.readyState === WebSocket.OPEN) browser.send(raw, { binary });
      }
      function outputFailed() {
        browser.close(1011, "Image delivery failed; reconnect");
      }
      upstream.on("message", (raw, binary) => {
        queuedOutputBytes += raw.length;
        if (queuedOutputBytes > 8 * 1024 * 1024) {
          browser.close(1013, "Connection fell behind; reconnect to load saved replies");
          return;
        }
        outputChain = outputChain
          .then(forward.bind(null, raw, binary))
          .catch(outputFailed)
          .finally(outputDelivered.bind(null, raw.length));
      });
      upstream.on("error", () => browser.close(1011, "Student runtime unavailable"));
      browser.on("error", () => upstream.close());
      upstream.on("close", () => browser.close());
      browser.on("close", () => {
        nativeUploads.cancelAll();
        pending.length = 0;
        pendingState.bytes = 0;
        upstream.close();
        socketPairs.delete(pair);
      });
    });
  });
}
