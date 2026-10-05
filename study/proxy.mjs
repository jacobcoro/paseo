import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { studentMessage } from "./policy.mjs";
import { persistImages } from "./images.mjs";
import { rewriteGeneratedImageMarkdown } from "./outputs.mjs";
import { documentRecords } from "./documents.mjs";

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
}) {
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 12 * 1024 * 1024 });
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
      let chain = Promise.resolve();
      upstream.on("open", () => {
        for (const frame of pending) upstream.send(frame);
        pending.length = 0;
      });
      async function handle(raw, binary) {
        if (binary || !sessions.has(session.token) || session.expires < Date.now()) {
          browser.close(1008, "Session expired or unsupported message");
          return;
        }
        const original = JSON.parse(raw.toString());
        const allowed = studentMessage(original, session.student);
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
            return;
          }
        }
        if (allowed.type === "session" && allowed.message.type === "send_agent_message_request") {
          const quotaError = limits.prompt(session.student);
          if (quotaError) {
            deny(browser, allowed.message, quotaError);
            return;
          }
          let images;
          try {
            images = await persistImages(allowed.message, session.student, config);
          } catch (error) {
            deny(browser, allowed.message, error.message);
            return;
          }
          appendFileSync(
            join(config.recordsDir, `${session.studentId}.requests.jsonl`),
            JSON.stringify({
              receivedAt: new Date().toISOString(),
              agentId: allowed.message.agentId,
              message: { ...allowed.message, images },
              documents: documentRecords(config, session.student).map(
                ({ id, name, mimeType, bytes, kind }) => ({ id, name, mimeType, bytes, kind }),
              ),
              settings: await getConversationSettings(session.student, allowed.message.agentId),
            }) + "\n",
            { mode: 0o600 },
          );
        }
        const frame = JSON.stringify(allowed);
        if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
        else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 100)
          pending.push(frame);
        else browser.close(1013, "Try reconnecting");
      }
      let queued = 0;
      function invalid() {
        browser.close(1008, "Invalid request");
      }
      function dequeue() {
        queued--;
      }
      browser.on("message", (raw, binary) => {
        if (!limits.allow("frames:" + session.studentId, 120, 10000)) {
          browser.close(1008, "Too many requests");
          return;
        }
        if (++queued > 100) {
          browser.close(1008, "Too many pending messages");
          return;
        }
        chain = chain
          .then(handle.bind(null, raw, binary))
          .catch(invalid)
          .finally(dequeue);
      });
      const origin = `${request.headers["x-forwarded-proto"] === "https" ? "https" : "http"}://${request.headers.host}`;
      let outputChain = Promise.resolve();
      let queuedOutputBytes = 0;
      function outputDelivered(size) {
        queuedOutputBytes -= size;
      }
      async function forward(raw, binary) {
        if (!binary && onAssistantTimeline) {
          try {
            const envelope = JSON.parse(raw.toString());
            const message = envelope.type === "session" ? envelope.message : envelope;
            const payload = message?.payload || message;
            const ownedAgents = [
              session.student.agentId,
              ...(session.student.ownedConversationIds || []),
              ...(session.student.historicalAgentIds || []),
              ...(session.student.preservedAgentIds || []),
            ];
            const entries = [];
            function collect(value) {
              if (!value || typeof value !== "object") return;
              if (value.type === "assistant_message" && typeof value.text === "string")
                entries.push({ item: value });
              for (const child of Object.values(value)) collect(child);
            }
            if (ownedAgents.includes(payload?.agentId)) collect(payload);
            if (entries.length) {
              const records = await onAssistantTimeline(session.student, entries);
              for (const entry of entries)
                entry.item.text = rewriteImages(entry.item.text, records || [], origin);
              if (browser.readyState === WebSocket.OPEN) browser.send(JSON.stringify(envelope));
              return;
            }
          } catch {}
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
        upstream.close();
        socketPairs.delete(pair);
      });
    });
  });
}
