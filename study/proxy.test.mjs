import test from "node:test";
import assert from "node:assert/strict";
import { randomFillSync } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import sharp from "sharp";
import {
  encodeFileTransferFrame,
  FileTransferOpcode,
} from "@getpaseo/protocol/binary-frames/index";
import { installProxy } from "./proxy.mjs";

const wait = (eventSource, event, predicate = () => true, timeoutMs = 2000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      eventSource.off(event, listener);
      reject(new Error(`Timed out waiting for ${event}`));
    }, timeoutMs);
    const listener = (...args) => {
      if (!predicate(...args)) return;
      clearTimeout(timer);
      eventSource.off(event, listener);
      resolve(args);
    };
    eventSource.on(event, listener);
  });

async function createProxy({ recordNativeUpload = async () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), "study-proxy-"));
  const config = { recordsDir: join(root, "records") };
  mkdirSync(config.recordsDir);
  const daemonHttp = createServer();
  const daemonWs = new WebSocketServer({ noServer: true });
  daemonHttp.on("upgrade", (request, socket, head) =>
    daemonWs.handleUpgrade(request, socket, head, (upstream) =>
      daemonWs.emit("connection", upstream, request),
    ),
  );
  await new Promise((resolve) => daemonHttp.listen(0, "127.0.0.1", resolve));
  const daemonMessages = [];
  let daemonSocket;
  daemonWs.on("connection", (socket) => {
    daemonSocket = socket;
    socket.on("message", (raw, binary) => {
      daemonMessages.push({ raw, binary });
      if (binary) {
        const bytes = new Uint8Array(raw);
        if (bytes[0] === FileTransferOpcode.FileEnd) {
          socket.send(
            JSON.stringify({
              type: "session",
              message: {
                type: "file.upload.response",
                payload: { requestId: "upload-request", file },
              },
            }),
          );
        }
        return;
      }
      const envelope = JSON.parse(raw.toString());
      if (envelope.type === "hello") socket.send(JSON.stringify({ type: "hello.ack" }));
      if (envelope.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
    });
  });

  const port = daemonHttp.address().port;
  const student = {
    id: "s01",
    agentId: "agent-1",
    workspaceId: "workspace-1",
    daemonUrl: `ws://127.0.0.1:${port}/ws`,
    daemonPassword: "test-password",
  };
  const session = {
    token: "session-token",
    studentId: student.id,
    student,
    expires: Date.now() + 60000,
  };
  const sessions = new Map([[session.token, session]]);
  const pairs = new Set();
  const proxyHttp = createServer();
  installProxy({
    server: proxyHttp,
    config,
    authenticate: () => session,
    checkOrigin: () => true,
    sessions,
    socketPairs: pairs,
    limits: { allow: () => true, prompt: () => null },
    getConversationSettings: async () => ({}),
    handleStudentRequest: async () => null,
    recordNativeUpload,
  });
  await new Promise((resolve) => proxyHttp.listen(0, "127.0.0.1", resolve));
  const client = () => new WebSocket(`ws://127.0.0.1:${proxyHttp.address().port}/ws`);
  return {
    client,
    daemonMessages,
    pairs,
    expireSession: () => sessions.delete(session.token),
    get daemonSocket() {
      return daemonSocket;
    },
    close: async () => {
      for (const pair of pairs) {
        pair.browser.terminate();
        pair.upstream.terminate();
      }
      await new Promise((resolve) => proxyHttp.close(resolve));
      for (const socket of daemonWs.clients) socket.terminate();
      await new Promise((resolve) => daemonWs.close(resolve));
      await new Promise((resolve) => daemonHttp.close(resolve));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

const file = {
  type: "uploaded_file",
  id: "upload_12345678-1234-4123-8123-123456789abc",
  fileName: "notes.txt",
  mimeType: "text/plain",
  size: 5,
  path: "/home/node/.paseo/uploads/upload_12345678-1234-4123-8123-123456789abc/notes.txt",
};

test("proxy forwards hello and ping without a nested message", async () => {
  const proxy = await createProxy();
  try {
    const client = proxy.client();
    await wait(client, "open");
    client.send(JSON.stringify({ type: "hello", clientType: "browser" }));
    client.send(JSON.stringify({ type: "ping" }));
    const waitForCount = async () => {
      const deadline = Date.now() + 2000;
      while (proxy.daemonMessages.length < 2 && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(proxy.daemonMessages.length, 2);
    };
    await waitForCount();
    const [hello, ping] = proxy.daemonMessages.map((entry) => JSON.parse(entry.raw.toString()));
    assert.equal(hello.type, "hello");
    assert.equal(hello.auth.password, "test-password");
    assert.equal(ping.type, "ping");
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
  } finally {
    await proxy.close();
  }
});

test("proxy cleans an interrupted upload and accepts a fresh socket upload", async () => {
  const archived = [];
  const proxy = await createProxy({ recordNativeUpload: async (...args) => archived.push(args) });
  const request = {
    type: "session",
    message: {
      type: "file.upload.request",
      requestId: "upload-request",
      fileName: file.fileName,
      mimeType: file.mimeType,
      size: file.size,
      modifiedAt: "2026-10-06T00:00:00.000Z",
    },
  };
  const begin = () =>
    encodeFileTransferFrame({
      opcode: FileTransferOpcode.FileBegin,
      requestId: "upload-request",
      metadata: {
        mime: file.mimeType,
        size: file.size,
        encoding: "binary",
        modifiedAt: request.message.modifiedAt,
        fileName: file.fileName,
      },
    });
  const handshake = async (client) => {
    await wait(client, "open");
    const ack = wait(client, "message", (raw) => JSON.parse(raw.toString()).type === "hello.ack");
    client.send(JSON.stringify({ type: "hello", clientType: "browser" }));
    await ack;
  };
  try {
    const first = proxy.client();
    await handshake(first);
    const upstream = proxy.daemonSocket;
    first.send(JSON.stringify(request));
    first.send(begin());
    first.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "upload-request",
        payload: Buffer.from("he"),
      }),
    );
    const received = wait(
      upstream,
      "message",
      (raw, binary) => binary && new Uint8Array(raw)[0] === FileTransferOpcode.FileChunk,
    );
    await received;
    const upstreamClosed = wait(upstream, "close");
    const firstClosed = wait(first, "close");
    first.close();
    await Promise.all([upstreamClosed, firstClosed]);
    assert.equal(proxy.pairs.size, 0);
    assert.equal(archived.length, 0);

    const second = proxy.client();
    await handshake(second);
    assert.notEqual(proxy.daemonSocket, upstream);
    const response = wait(
      second,
      "message",
      (raw) => JSON.parse(raw.toString()).message?.type === "file.upload.response",
    );
    second.send(JSON.stringify(request));
    second.send(begin());
    second.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "upload-request",
        payload: Buffer.from("hello"),
      }),
    );
    second.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileEnd,
        requestId: "upload-request",
      }),
    );
    const [raw] = await response;
    assert.deepEqual(JSON.parse(raw.toString()).message.payload.file, file);
    assert.equal(archived.length, 1);
    second.close();
  } finally {
    await proxy.close();
  }
});

test("proxy accepts the existing four-image request size", async () => {
  const proxy = await createProxy();
  try {
    const client = proxy.client();
    await wait(client, "open");
    const width = 832;
    const height = 832;
    const raw = Buffer.allocUnsafe(width * height * 3);
    randomFillSync(raw);
    const png = await sharp(raw, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0, adaptiveFiltering: false })
      .toBuffer();
    assert.ok(png.byteLength <= 2 * 1024 * 1024);
    const data = png.toString("base64");
    const frame = JSON.stringify({
      type: "session",
      message: {
        type: "agent.create.request",
        workspaceId: "workspace-1",
        config: { provider: "codex", cwd: "/workspace" },
        initialPrompt: "Describe these references",
        idempotencyKey: "four-image-request",
        images: Array.from({ length: 4 }, () => ({ mimeType: "image/png", data })),
      },
    });
    assert.ok(Buffer.byteLength(frame) > 10 * 1024 * 1024);
    assert.ok(Buffer.byteLength(frame) < 12 * 1024 * 1024);
    client.send(frame);
    const deadline = Date.now() + 5000;
    while (!proxy.daemonMessages.length && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(proxy.daemonMessages.length, 1);
    const forwarded = JSON.parse(proxy.daemonMessages[0].raw.toString()).message;
    assert.equal(forwarded.images.length, 4);
    assert.equal(client.readyState, WebSocket.OPEN);
    client.close();
  } finally {
    await proxy.close();
  }
});

test("proxy rejects unowned binary frames and does not forward them", async () => {
  const proxy = await createProxy();
  try {
    const client = proxy.client();
    await wait(client, "open");
    const closed = wait(client, "close");
    client.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "unowned-request",
        payload: Buffer.from("x"),
      }),
    );
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(proxy.daemonMessages.length, 0);
  } finally {
    await proxy.close();
  }
});

test("proxy checks the student session before forwarding native binary data", async () => {
  const proxy = await createProxy();
  try {
    const client = proxy.client();
    await wait(client, "open");
    client.send(
      JSON.stringify({
        type: "session",
        message: {
          type: "file.upload.request",
          requestId: "upload-request",
          fileName: file.fileName,
          mimeType: file.mimeType,
          size: file.size,
          modifiedAt: "2026-10-06T00:00:00.000Z",
        },
      }),
    );
    const deadline = Date.now() + 2000;
    while (!proxy.daemonMessages.some((entry) => !entry.binary) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      proxy.daemonMessages.some((entry) => !entry.binary),
      true,
    );
    proxy.expireSession();
    const closed = wait(client, "close");
    client.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "upload-request",
        metadata: {
          mime: file.mimeType,
          size: file.size,
          encoding: "binary",
          modifiedAt: "2026-10-06T00:00:00.000Z",
          fileName: file.fileName,
        },
      }),
    );
    const [code] = await closed;
    assert.equal(code, 1008);
    assert.equal(
      proxy.daemonMessages.some((entry) => entry.binary),
      false,
    );
  } finally {
    await proxy.close();
  }
});

test("proxy withholds native upload success when archive storage fails", async () => {
  const proxy = await createProxy({
    recordNativeUpload: async () => {
      throw Error("disk full");
    },
  });
  try {
    const client = proxy.client();
    await wait(client, "open");
    const responsePromise = wait(client, "message", (raw) => {
      const envelope = JSON.parse(raw.toString());
      return envelope.message?.type === "rpc_error";
    });
    const request = {
      type: "session",
      message: {
        type: "file.upload.request",
        requestId: "upload-request",
        fileName: file.fileName,
        mimeType: file.mimeType,
        size: file.size,
        modifiedAt: "2026-10-06T00:00:00.000Z",
      },
    };
    client.send(JSON.stringify(request));
    const deadline = Date.now() + 2000;
    while (!proxy.daemonMessages.some((entry) => !entry.binary) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(
      proxy.daemonMessages.some((entry) => !entry.binary),
      true,
    );
    client.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileBegin,
        requestId: "upload-request",
        metadata: {
          mime: file.mimeType,
          size: file.size,
          encoding: "binary",
          modifiedAt: request.message.modifiedAt,
          fileName: file.fileName,
        },
      }),
    );
    client.send(
      encodeFileTransferFrame({
        opcode: FileTransferOpcode.FileChunk,
        requestId: "upload-request",
        payload: Buffer.from("hello"),
      }),
    );
    client.send(
      encodeFileTransferFrame({ opcode: FileTransferOpcode.FileEnd, requestId: "upload-request" }),
    );
    const [raw] = await responsePromise;
    const response = JSON.parse(raw.toString()).message;
    assert.equal(response.type, "rpc_error");
    assert.match(response.payload.error, /disk full/);
    assert.equal(
      proxy.daemonMessages.some((entry) => {
        if (entry.binary) return false;
        return JSON.parse(entry.raw.toString()).message?.type === "file.upload.response";
      }),
      false,
    );
    client.close();
  } finally {
    await proxy.close();
  }
});
