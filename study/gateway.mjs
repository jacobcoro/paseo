import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  renameSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  statSync,
  createReadStream,
} from "node:fs";
import { dirname, resolve, extname, join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Annotation, studentMessage } from "./policy.mjs";
import { loginHtml } from "./login.mjs";

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function jsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 65536) throw new Error("Request too large");
  }
  return JSON.parse(body);
}
export function passwordHash(password, salt) {
  return scryptSync(password, salt, 32).toString("hex");
}
function validPassword(password, student) {
  if (typeof password !== "string" || password.length > 200) return false;
  const actual = Buffer.from(passwordHash(password, student.salt), "hex");
  const expected = Buffer.from(student.passwordHash, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function startGateway(config) {
  const sessions = new Map();
  const attempts = new Map();
  const students = new Map(config.students.map((student) => [student.id, student]));
  const clients = new Map();
  const socketPairs = new Set();
  mkdirSync(config.recordsDir, { recursive: true, mode: 0o700 });
  for (const student of config.students) {
    const client = new DaemonClient({
      url: student.daemonUrl,
      password: student.daemonPassword,
      clientId: `study-recorder-${student.id}`,
      clientType: "cli",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: true },
    });
    await client.connect();
    clients.set(student.id, client);
    client.on((message) => {
      if (
        message.type === "agent_stream" ||
        message.type === "agent_status" ||
        message.type === "agent.timeline.replacement"
      ) {
        appendFileSync(
          join(config.recordsDir, `${student.id}.events.jsonl`),
          JSON.stringify({ recordedAt: new Date().toISOString(), studentId: student.id, message }) +
            "\n",
          { mode: 0o600 },
        );
      }
    });
  }
  function authenticate(request) {
    const token = /(?:^|;\s*)study_session=([^;]+)/.exec(request.headers.cookie || "")?.[1];
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) return null;
    return { ...session, token, student: students.get(session.studentId) };
  }
  function checkOrigin(request) {
    if (!request.headers.origin) return true;
    try {
      return new URL(request.headers.origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
  async function transcript(student) {
    const client = clients.get(student.id);
    let page = await client.fetchAgentTimeline(student.agentId, {
      projection: "canonical",
      limit: 200,
    });
    const entries = [...page.entries];
    const seen = new Set();
    while (page.hasOlder && page.startCursor) {
      const key = JSON.stringify(page.startCursor);
      if (seen.has(key)) throw new Error("Transcript pagination stalled");
      seen.add(key);
      page = await client.fetchAgentTimeline(student.agentId, {
        projection: "canonical",
        limit: 200,
        direction: "before",
        cursor: page.startCursor,
      });
      entries.unshift(...page.entries);
    }
    const result = {
      studentId: student.id,
      agentId: student.agentId,
      model: config.model,
      mode: config.mode,
      entries,
    };
    const destination = join(config.recordsDir, `${student.id}.transcript.json`);
    writeFileSync(destination + ".tmp", JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(destination + ".tmp", destination);
    return result;
  }
  function annotations(student) {
    const filename = join(config.recordsDir, `${student.id}.annotations.jsonl`);
    return existsSync(filename)
      ? readFileSync(filename, "utf8")
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  }
  async function handleLogin(request, response) {
    const address = request.socket.remoteAddress;
    const previous = attempts.get(address);
    const attempt =
      previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 60000 };
    attempts.set(address, attempt);
    if (++attempt.count > 20)
      return reply(response, 429, { error: "Wait a minute before trying again" });
    const input = await jsonBody(request);
    const student = students.get(input.studentId);
    if (!student || !validPassword(input.password, student))
      return reply(response, 401, { error: "Invalid login" });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, { studentId: student.id, expires: Date.now() + 6 * 3600000 });
    const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return reply(
      response,
      200,
      { studentId: student.id },
      {
        "Set-Cookie": `study_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=21600${secure}`,
      },
    );
  }
  const researchRoutes = new Map([
    [
      "/study/logout",
      {
        method: "POST",
        run: async (request, response, session) => {
          sessions.delete(session.token);
          for (const pair of socketPairs)
            if (pair.token === session.token) {
              pair.browser.close(1008, "Signed out");
              pair.upstream.close();
            }
          return reply(
            response,
            200,
            { ok: true },
            { "Set-Cookie": "study_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" },
          );
        },
      },
    ],
    [
      "/study/me",
      {
        method: "GET",
        run: async (request, response, { student }) =>
          reply(response, 200, {
            studentId: student.id,
            mode: config.mode,
            agentId: student.agentId,
            serverId: student.serverId,
            model: config.model,
          }),
      },
    ],
    [
      "/study/records",
      {
        method: "GET",
        run: async (request, response, { student }) => {
          const saved = await transcript(student);
          const prompts = saved.entries
            .filter((entry) => entry.item.type === "user_message")
            .map((entry) => ({
              id: entry.item.messageId || String(entry.seqStart),
              text: entry.item.text,
              timestamp: entry.timestamp,
            }));
          return reply(response, 200, { prompts, annotations: annotations(student) });
        },
      },
    ],
    [
      "/study/annotations",
      {
        method: "POST",
        run: async (request, response, { student }) => {
          const parsed = Annotation.safeParse(await jsonBody(request));
          if (!parsed.success)
            return reply(response, 400, { error: "Complete the required research fields" });
          const saved = await transcript(student);
          const ids = saved.entries
            .filter((entry) => entry.item.type === "user_message")
            .map((entry) => entry.item.messageId || String(entry.seqStart));
          if (parsed.data.promptId !== "non-ai" && !ids.includes(parsed.data.promptId))
            return reply(response, 403, { error: "Prompt does not belong to this student" });
          const record = {
            id: randomUUID(),
            studentId: student.id,
            agentId: student.agentId,
            recordedAt: new Date().toISOString(),
            ...parsed.data,
          };
          appendFileSync(
            join(config.recordsDir, `${student.id}.annotations.jsonl`),
            JSON.stringify(record) + "\n",
            { mode: 0o600 },
          );
          return reply(response, 201, record);
        },
      },
    ],
    [
      "/study/export",
      {
        method: "GET",
        run: async (request, response, { student }) => {
          const saved = await transcript(student);
          return reply(
            response,
            200,
            {
              schemaVersion: 1,
              exportedAt: new Date().toISOString(),
              ...saved,
              annotations: annotations(student),
            },
            { "Content-Disposition": `attachment; filename="${student.id}-research.json"` },
          );
        },
      },
    ],
  ]);
  function serveAsset(pathname, response, student) {
    const requested = resolve(config.webDir, "." + decodeURIComponent(pathname));
    if (!requested.startsWith(resolve(config.webDir) + "/") && requested !== resolve(config.webDir))
      return reply(response, 403, { error: "Invalid path" });
    let filename = requested;
    if (!existsSync(filename) || !statSync(filename).isFile()) {
      if (extname(pathname)) return reply(response, 404, { error: "Not found" });
      filename = join(config.webDir, "index.html");
    }
    const types = {
      ".html": "text/html",
      ".js": "application/javascript",
      ".css": "text/css",
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".json": "application/json",
      ".woff2": "font/woff2",
      ".ttf": "font/ttf",
    };
    response.writeHead(200, {
      "Content-Type": types[extname(filename)] || "application/octet-stream",
      "Cache-Control": "private, no-store",
    });
    if (extname(filename) === ".html") {
      const initialRoute = `/h/${student.serverId}/agent/${student.agentId}`;
      const bootstrap =
        '<script>window.__PASEO_INITIAL_DAEMON_CONNECTION__={listen:window.location.hostname+":"+(window.location.port||(window.location.protocol==="https:"?"443":"80")),useTls:window.location.protocol==="https:"};if(["/","/welcome","/open-project"].includes(window.location.pathname))window.history.replaceState(null,"",' +
        JSON.stringify(initialRoute) +
        ")</script>";
      response.end(readFileSync(filename, "utf8").replace(/<\/head>/i, bootstrap + "</head>"));
      return;
    }
    createReadStream(filename).pipe(response);
  }
  const server = createServer(async (request, response) => {
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "same-origin");
    try {
      const pathname = new URL(request.url, "http://study.local").pathname;
      const publicData = new Map([
        ["/manifest.json", { name: "Lulu design study", start_url: "/", display: "standalone" }],
        ["/health", { ok: true, mode: config.mode }],
      ]);
      if (publicData.has(pathname)) return reply(response, 200, publicData.get(pathname));
      if (request.method !== "GET" && !checkOrigin(request))
        return reply(response, 403, { error: "Origin rejected" });
      if (pathname === "/study/login" && request.method === "POST")
        return handleLogin(request, response);
      const session = authenticate(request);
      if (!session) {
        if (pathname.startsWith("/study/") || pathname.startsWith("/api/"))
          return reply(response, 401, { error: "Sign in first" });
        return reply(response, 200, loginHtml, { "Content-Type": "text/html; charset=utf-8" });
      }
      const student = session.student;
      const route = researchRoutes.get(pathname);
      if (route) {
        if (request.method !== route.method)
          return reply(response, 405, { error: "Method not allowed" });
        return route.run(request, response, session);
      }
      if (pathname === "/api/health" && request.method === "GET") {
        const origin = student.daemonUrl.replace("ws://", "http://").replace(/\/ws$/, "");
        const upstream = await fetch(origin + "/api/health");
        return reply(response, upstream.status, await upstream.text());
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/mcp") || pathname.startsWith("/."))
        return reply(response, 403, { error: "Unavailable in the student study" });
      if (request.method !== "GET") return reply(response, 405, { error: "Method not allowed" });
      if (pathname.endsWith(".map")) return reply(response, 404, { error: "Not found" });
      return serveAsset(pathname, response, student);
    } catch (error) {
      if (!response.headersSent)
        reply(response, 400, { error: "The request failed. Please retry." });
      console.error("Study request failed:", error.message);
    }
  });
  const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on("upgrade", (request, socket, head) => {
    const session = authenticate(request);
    if (request.url !== "/ws" || !session || !checkOrigin(request)) {
      socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (browser) => {
      const upstream = new WebSocket(session.student.daemonUrl, {
        headers: { Authorization: `Bearer ${session.student.daemonPassword}` },
      });
      const pair = { browser, upstream, token: session.token };
      socketPairs.add(pair);
      const pending = [];
      upstream.on("open", () => {
        for (const frame of pending) upstream.send(frame);
        pending.length = 0;
      });
      browser.on("message", (raw, binary) => {
        if (binary || !sessions.has(session.token) || session.expires < Date.now()) {
          browser.close(1008, "Session expired or unsupported message");
          return;
        }
        try {
          const original = JSON.parse(raw.toString());
          const allowed = studentMessage(original, session.student);
          if (!allowed) {
            const message = original.message;
            appendFileSync(
              join(config.recordsDir, `${session.studentId}.denied.jsonl`),
              JSON.stringify({
                at: new Date().toISOString(),
                type: message?.type || original.type,
              }) + "\n",
              { mode: 0o600 },
            );
            if (message?.requestId)
              browser.send(
                JSON.stringify({
                  type: "session",
                  message: {
                    type: "rpc_error",
                    payload: {
                      requestId: message.requestId,
                      requestType: message.type,
                      code: "access_denied",
                      error: "This action is unavailable in the student study",
                    },
                  },
                }),
              );
            return;
          }
          if (allowed.type === "session" && allowed.message.type === "send_agent_message_request")
            appendFileSync(
              join(config.recordsDir, `${session.studentId}.requests.jsonl`),
              JSON.stringify({ receivedAt: new Date().toISOString(), message: allowed.message }) +
                "\n",
              { mode: 0o600 },
            );
          const frame = JSON.stringify(allowed);
          if (upstream.readyState === WebSocket.OPEN) upstream.send(frame);
          else if (upstream.readyState === WebSocket.CONNECTING && pending.length < 100)
            pending.push(frame);
          else browser.close(1013, "Try reconnecting");
        } catch {
          browser.close(1008, "Invalid request");
        }
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
  await new Promise((accept) => server.listen(config.port || 0, "127.0.0.1", accept));
  const maintenance = setInterval(() => {
    for (const [token, session] of sessions)
      if (session.expires < Date.now()) sessions.delete(token);
    for (const [address, attempt] of attempts)
      if (attempt.until < Date.now()) attempts.delete(address);
    for (const student of students.values())
      transcript(student).catch((error) =>
        console.error("Transcript checkpoint failed:", error.message),
      );
  }, 15000);
  maintenance.unref();
  return {
    server,
    port: server.address().port,
    close: async () => {
      clearInterval(maintenance);
      for (const pair of socketPairs) {
        pair.browser.terminate();
        pair.upstream.terminate();
      }
      for (const student of students.values()) await transcript(student);
      for (const client of clients.values()) await client.close();
      await new Promise((accept) => server.close(accept));
    },
  };
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
  const gateway = await startGateway(config);
  writeFileSync(
    join(dirname(process.argv[2]), "gateway.json"),
    JSON.stringify({ port: gateway.port, mode: config.mode }),
    { mode: 0o600 },
  );
  console.log(`Study gateway ready on loopback port ${gateway.port} (${config.mode})`);
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, async () => {
      await gateway.close();
      process.exit(0);
    });
}
