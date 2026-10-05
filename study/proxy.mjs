import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { studentMessage } from "./policy.mjs";
import { persistImages } from "./images.mjs";
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
              message: { ...allowed.message, images },
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
      upstream.on("message", (raw, binary) => {
        if (browser.readyState === WebSocket.OPEN) browser.send(raw, { binary });
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
