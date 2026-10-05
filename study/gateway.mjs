import { createServer } from "node:http";
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createHash } from "node:crypto";
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
import { WebSocket } from "ws";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { Annotation } from "./policy.mjs";
import { loginHtml } from "./login.mjs";
import { adminHtml } from "./admin.mjs";
import { imageRecords, imageFile } from "./images.mjs";
import { createLimits } from "./limits.mjs";
import { installProxy } from "./proxy.mjs";
import { mergeTranscript } from "./transcript.mjs";
import { releaseIdleRuntime } from "./runtime-control.mjs";
import { researchSession } from "./research-session.mjs";
import { nativeCreation, savedTimeline } from "./native-controls.mjs";
import { persistImages } from "./images.mjs";
import { createResearchArchive, sendResearchArchive } from "./export-archive.mjs";
import { createRecorder } from "./recorder.mjs";
import {
  ModelSettingsInput,
  studentModels,
  validModelSettings,
  conversationSettings,
} from "./model-settings.mjs";
import {
  documentRecords,
  documentFile,
  persistDocumentUpload,
  readStudentMemory,
  writeStudentMemory,
} from "./documents.mjs";
import {
  archiveAssistantImages,
  generatedImageRecords,
  generatedImageFile,
  rewriteGeneratedImageMarkdown,
} from "./outputs.mjs";

function reply(response, status, body, headers = {}) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  response.end(typeof body === "string" ? body : JSON.stringify(body));
}
async function jsonBody(request, maxBytes = 65536) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > maxBytes) throw new Error("Request too large");
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
  const limits = createLimits(config);
  const students = new Map(config.students.map((student) => [student.id, student]));
  const clients = new Map();
  const recorders = new Map();
  let exportingArchive = false;
  const conversationRecords = new Map();
  const conversationCreatedAt = new Map();
  const conversationCreationLocks = new Set();
  const socketPairs = new Set();
  mkdirSync(config.recordsDir, { recursive: true, mode: 0o700 });
  for (const student of config.students) {
    const conversationPath = join(config.recordsDir, `${student.id}.conversations.json`);
    const savedConversations = existsSync(conversationPath)
      ? JSON.parse(readFileSync(conversationPath, "utf8"))
      : { studentId: student.id, conversations: [], lastCreatedAt: null };
    if (
      savedConversations.studentId !== student.id ||
      !Array.isArray(savedConversations.conversations)
    )
      throw new Error("Saved conversations belong to another student");
    conversationRecords.set(student.id, savedConversations.conversations);
    conversationCreatedAt.set(student.id, savedConversations.lastCreatedAt);
    student.ownedConversationIds = savedConversations.conversations.map((item) => item.agentId);
    const transcriptPath = join(config.recordsDir, `${student.id}.transcript.json`);
    const savedTranscript = existsSync(transcriptPath)
      ? JSON.parse(readFileSync(transcriptPath, "utf8"))
      : null;
    const currentIds = new Set([student.agentId, ...student.ownedConversationIds]);
    student.preservedAgentIds = (savedTranscript?.conversations || [])
      .map((item) => item.agentId)
      .filter(
        (agentId) =>
          !currentIds.has(agentId) && !(student.historicalAgentIds || []).includes(agentId),
      );
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
    recorders.set(student.id, createRecorder(client, config, student));
  }
  const activeConversations = new Map(
    config.students.map((student) => [student.id, student.agentId]),
  );
  const preparationLocks = new Map();
  function prepareConversation(student, agentId, operation = () => {}) {
    const previous = preparationLocks.get(student.id) || Promise.resolve();
    const current = previous
      .catch(() => {})
      .then(async () => {
        await prepareConversationUnlocked(student, agentId);
        return operation();
      });
    preparationLocks.set(student.id, current);
    return current;
  }
  async function prepareConversationUnlocked(student, agentId) {
    const previous = activeConversations.get(student.id);
    if (previous !== agentId) await recorders.get(student.id).select("new");
    if (previous && previous !== agentId) await transcript(student);
    // Native tab observers can reopen idle histories. Release every owned idle
    // runtime before loading a chat, rather than only the last selected one.
    for (const id of new Set([student.agentId, ...student.ownedConversationIds])) {
      if (id !== agentId && !(await releaseIdleRuntime(student, id)))
        throw Error("Wait for the current reply before changing chats");
    }
    if (agentId !== "new") {
      const agent = await metadataFor(student, agentId);
      if (
        agent.lastUserMessageAt === null &&
        agent.persistence &&
        !["running", "initializing", "awaiting_input"].includes(agent.status)
      ) {
        if (!(await releaseIdleRuntime(student, agentId)))
          throw Error("Wait for the current reply before changing chats");
      }
    }
    activeConversations.set(student.id, agentId);
    await recorders.get(student.id).select(agentId);
  }
  const modelCatalogs = new Map();
  async function modelsFor(student) {
    let catalog = modelCatalogs.get(student.id);
    if (!catalog || catalog.expires < Date.now()) {
      catalog = {
        expires: Date.now() + 300000,
        promise: clients.get(student.id).listProviderModels("codex", { cwd: "/workspace" }),
      };
      modelCatalogs.set(student.id, catalog);
    }
    const result = await catalog.promise;
    if (result.error) {
      modelCatalogs.delete(student.id);
      throw Error("Model list is unavailable. Retry shortly.");
    }
    return result.models;
  }
  async function metadataFor(student, agentId) {
    const listed = await clients
      .get(student.id)
      .fetchAgents({ filter: { includeArchived: true }, page: { limit: 200 } });
    const entry = listed.entries.find((item) => item.agent.id === agentId);
    if (!entry) throw Error("Conversation not found");
    return entry.agent;
  }
  async function settingsFor(student, agentId) {
    return conversationSettings(await metadataFor(student, agentId));
  }
  function settingChanges(student) {
    const path = join(config.recordsDir, `${student.id}.settings.jsonl`);
    return existsSync(path)
      ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
      : [];
  }
  function authenticate(request) {
    const token = /(?:^|;\s*)study_session=([^;]+)/.exec(request.headers.cookie || "")?.[1];
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) return null;
    return { ...session, token, student: students.get(session.studentId) };
  }
  const archiveImages = (student, entries) =>
    archiveAssistantImages({
      config,
      student,
      entries,
      readFile: (path, maxBytes) =>
        clients
          .get(student.id)
          .readFile(
            path.startsWith("/workspace/") ? "/workspace" : "/",
            path.startsWith("/workspace/") ? path.slice("/workspace".length) : path,
            `study-output-${randomUUID()}`,
            maxBytes,
          ),
    });
  function checkOrigin(request) {
    if (!request.headers.origin) return true;
    try {
      return new URL(request.headers.origin).host === request.headers.host;
    } catch {
      return false;
    }
  }
  const transcriptLocks = new Map();
  function transcript(student) {
    const previous = transcriptLocks.get(student.id) || Promise.resolve();
    const current = previous.catch(() => {}).then(() => collectTranscript(student));
    transcriptLocks.set(student.id, current);
    return current;
  }
  function emptyConversation(previous, conversation, metadata) {
    return {
      ...previous,
      ...conversation,
      settings: conversationSettings(metadata),
      entries: previous?.entries || [],
    };
  }
  async function collectTranscript(student) {
    const client = clients.get(student.id);
    const destination = join(config.recordsDir, `${student.id}.transcript.json`);
    const saved = existsSync(destination) ? JSON.parse(readFileSync(destination, "utf8")) : null;
    if (saved && saved.studentId !== student.id)
      throw new Error("Saved transcript belongs to another student or agent");
    const owned = [
      { agentId: student.agentId, title: "设计对话 / Design chat", createdAt: null },
      ...conversationRecords.get(student.id),
    ];
    const readonlyIds = [
      ...new Set([...(student.historicalAgentIds || []), ...(student.preservedAgentIds || [])]),
    ];
    const readonly = readonlyIds.map((agentId) => ({
      agentId,
      title:
        saved?.conversations?.find((item) => item.agentId === agentId)?.title ||
        "Previous conversation",
      createdAt: saved?.conversations?.find((item) => item.agentId === agentId)?.createdAt || null,
      readonly: true,
    }));
    const previousGroups = Array.isArray(saved?.conversations) ? saved.conversations : [];
    const listedAgentIds = new Set([...owned, ...readonly].map((item) => item.agentId));
    const conversations = [];
    for (const conversation of [
      ...owned,
      ...readonly,
      ...previousGroups
        .filter((item) => !listedAgentIds.has(item.agentId))
        .map((item) => ({
          agentId: item.agentId,
          title: item.title || "Previous conversation",
          createdAt: item.createdAt || null,
          readonly: true,
        })),
    ]) {
      const previous = previousGroups.find((group) => group.agentId === conversation.agentId);
      if (conversation.agentId !== activeConversations.get(student.id)) {
        conversations.push({
          ...previous,
          ...conversation,
          entries: previous?.entries || [],
        });
        continue;
      }
      const metadata = await metadataFor(student, conversation.agentId);
      if (metadata.lastUserMessageAt === null) {
        conversations.push(emptyConversation(previous, conversation, metadata));
        continue;
      }
      let page = await client.fetchAgentTimeline(conversation.agentId, {
        projection: "canonical",
        limit: 200,
      });
      const entries = [...page.entries];
      const seen = new Set();
      while (page.hasOlder && page.startCursor) {
        const key = JSON.stringify(page.startCursor);
        if (seen.has(key)) throw new Error("Transcript pagination stalled");
        seen.add(key);
        page = await client.fetchAgentTimeline(conversation.agentId, {
          projection: "canonical",
          limit: 200,
          direction: "before",
          cursor: page.startCursor,
        });
        entries.unshift(...page.entries);
      }
      conversations.push({
        ...conversation,
        settings: await settingsFor(student, conversation.agentId),
        entries: mergeTranscript(previous?.entries || [], entries).map((entry) =>
          Object.assign({}, entry, { agentId: conversation.agentId }),
        ),
      });
    }
    const entries = mergeTranscript(
      saved?.entries || [],
      conversations.flatMap((conversation) => conversation.entries),
    );
    const result = {
      studentId: student.id,
      agentId: student.agentId,
      model: config.model,
      mode: config.mode,
      entries,
      conversations,
    };
    await archiveImages(
      student,
      conversations.flatMap((conversation) => conversation.entries),
    ).catch((error) => console.error("Generated image archive failed:", error.message));
    const temporary = destination + `.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(result, null, 2), { mode: 0o600 });
    renameSync(temporary, destination);
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
  function saveConversations(student, lastCreatedAt) {
    const filename = join(config.recordsDir, `${student.id}.conversations.json`);
    const saved = {
      studentId: student.id,
      conversations: conversationRecords.get(student.id),
      lastCreatedAt,
    };
    const temporary = filename + `.${randomUUID()}.tmp`;
    writeFileSync(temporary, JSON.stringify(saved, null, 2), { mode: 0o600 });
    renameSync(temporary, filename);
    conversationCreatedAt.set(student.id, lastCreatedAt);
    student.ownedConversationIds = saved.conversations.map((item) => item.agentId);
  }
  async function applySettings(student, input) {
    const parsed = ModelSettingsInput.parse(input);
    if (![student.agentId, ...student.ownedConversationIds].includes(parsed.agentId))
      throw Error("Conversation not found");
    if (!validModelSettings(parsed, await modelsFor(student)))
      throw Error("This model or reasoning level is unavailable. Astra is blocked.");
    if (!limits.allow("settings:" + student.id, 20))
      throw Error("Wait a minute before changing settings again");
    return prepareConversation(student, input.agentId, async () => {
      const client = clients.get(student.id);
      const agent = await metadataFor(student, input.agentId);
      if (["running", "initializing", "awaiting_input"].includes(agent.status))
        throw Error("Wait for the reply to finish before changing settings");
      const audit = {
        recordedAt: new Date().toISOString(),
        agentId: input.agentId,
        before: conversationSettings(agent),
        requested: input,
        success: false,
      };
      try {
        await client.applyAgentConfig(input.agentId, {
          modelId: input.modelId,
          thinkingOptionId: input.thinkingOptionId,
        });
        audit.success = true;
      } finally {
        audit.after = await settingsFor(student, input.agentId);
        appendFileSync(
          join(config.recordsDir, `${student.id}.settings.jsonl`),
          JSON.stringify(audit) + "\n",
          { mode: 0o600 },
        );
      }
      return audit.after;
    });
  }
  async function handleStudentRequest(student, request) {
    if (!request) return null;
    const readonly = new Set([
      ...(student.historicalAgentIds || []),
      ...(student.preservedAgentIds || []),
    ]);
    if (
      request.type === "agent.timeline.set_subscription.request" &&
      request.agentIds?.every((id) => readonly.has(id))
    ) {
      return {
        type: "agent.timeline.set_subscription.response",
        payload: { requestId: request.requestId, agentIds: request.agentIds },
      };
    }
    if (request.type === "agent.timeline.set_subscription.request")
      request.agentIds = request.agentIds?.filter((id) => !readonly.has(id));
    if (request.type === "fetch_agent_timeline_request" && readonly.has(request.agentId)) {
      const path = join(config.recordsDir, `${student.id}.transcript.json`);
      const saved = JSON.parse(readFileSync(path, "utf8"));
      const group = saved.conversations?.find((item) => item.agentId === request.agentId);
      return savedTimeline(
        request,
        group?.entries || [],
        await metadataFor(student, request.agentId),
      );
    }
    if (
      [
        "set_agent_model_request",
        "set_agent_thinking_request",
        "agent.config.apply.request",
      ].includes(request.type)
    )
      return handleNativeSettings(student, request);
    const wakeResponses = {
      fetch_agent_timeline_request: "fetch_agent_timeline_response",
      list_commands_request: "list_commands_response",
      clear_agent_attention: "clear_agent_attention_response",
      "agent.timeline.search.request": "agent.timeline.search.response",
      "agent.timeline.list_prompts.request": "agent.timeline.list_prompts.response",
    };
    const responseType = wakeResponses[request.type];
    if (responseType && typeof request.agentId === "string") {
      return prepareConversation(student, request.agentId, async () => ({
        type: responseType,
        payload: await clients.get(student.id).sendCorrelatedSessionRequest({
          requestId: request.requestId,
          message: request,
          responseType,
        }),
      }));
    }
    if (request.type !== "agent.create.request") return null;
    return handleNativeCreation(student, request);
  }
  async function handleNativeSettings(student, request) {
    const current = await settingsFor(student, request.agentId);
    let update;
    if (request.type === "agent.config.apply.request") {
      if (Object.keys(request.config).some((key) => !["modelId", "thinkingOptionId"].includes(key)))
        throw Error("Only model and reasoning can be changed");
      update = request.config;
    } else
      update =
        request.type === "set_agent_model_request"
          ? { modelId: request.modelId }
          : { thinkingOptionId: request.thinkingOptionId };
    const modelId = update.modelId || current.modelId;
    const model = studentModels(await modelsFor(student)).find((item) => item.id === modelId);
    const thinkingOptionId =
      update.thinkingOptionId ||
      (model?.thinkingOptions.some((item) => item.id === current.thinkingOptionId)
        ? current.thinkingOptionId
        : model?.defaultThinkingOptionId);
    await applySettings(student, { agentId: request.agentId, modelId, thinkingOptionId });
    return {
      type: request.type.replace("request", "response"),
      payload: {
        requestId: request.requestId,
        agentId: request.agentId,
        accepted: true,
        error: null,
      },
    };
  }
  async function handleNativeCreation(student, request) {
    const options = nativeCreation(request, student, await modelsFor(student));
    const fingerprint = createHash("sha256").update(JSON.stringify(options)).digest("hex");
    const prior = conversationRecords
      .get(student.id)
      .find((item) => item.idempotencyKey === options.idempotencyKey);
    if (prior?.fingerprint && prior.fingerprint !== fingerprint)
      throw Error("A retry cannot change the original chat request");
    if (prior)
      return {
        type: "agent.create.response",
        payload: {
          requestId: request.requestId,
          agent: await metadataFor(student, prior.agentId),
          error: null,
        },
      };
    if (conversationCreationLocks.has(student.id))
      throw Error("A new chat is already being created");
    conversationCreationLocks.add(student.id);
    try {
      if (conversationRecords.get(student.id).length >= 19)
        throw Error("You have reached the 20 chat limit");
      const last = conversationCreatedAt.get(student.id);
      if (last && Date.now() - Date.parse(last) < 60000)
        throw Error("Wait one minute before creating another chat");
      const quota = limits.prompt(student);
      if (quota) throw Error(quota);
      return await prepareConversation(student, "new", async () => {
        const identity = createHash("sha256")
          .update(student.id + ":" + options.idempotencyKey)
          .digest("hex");
        options.agentId ||= `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-a${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
        const promptRequest = {
          ...request,
          agentId: options.agentId,
          messageId: request.clientMessageId,
        };
        const images = await persistImages(promptRequest, student, config);
        options.images = promptRequest.images;
        appendFileSync(
          join(config.recordsDir, `${student.id}.requests.jsonl`),
          JSON.stringify({
            receivedAt: new Date().toISOString(),
            agentId: options.agentId,
            message: {
              type: "send_agent_message_request",
              agentId: options.agentId,
              text: options.initialPrompt,
              clientMessageId: options.clientMessageId,
              images,
            },
            documents: documentRecords(config, student).map(
              ({ id, name, mimeType, bytes, kind }) => ({ id, name, mimeType, bytes, kind }),
            ),
            settings: {
              modelId: options.config.model,
              thinkingOptionId: options.config.thinkingOptionId,
            },
          }) + "\n",
          { mode: 0o600 },
        );
        // Native creation receipts preserve retry identity and create-and-prompt behavior.
        const result = await clients.get(student.id).creations.createAgent(options);
        if (!result.agent || result.error) throw Error(result.error || "Could not create chat");
        const agent = result.agent;
        activeConversations.set(student.id, agent.id);
        const createdAt = new Date().toISOString();
        conversationRecords.get(student.id).push({
          agentId: agent.id,
          title: agent.title || "新对话",
          createdAt,
          idempotencyKey: options.idempotencyKey,
          fingerprint,
        });
        saveConversations(student, createdAt);
        await recorders.get(student.id).select(agent.id);
        return {
          type: "agent.create.response",
          payload: {
            requestId: request.requestId,
            agent,
            error: null,
            ...(result.creation ? { creation: result.creation } : {}),
          },
        };
      });
    } finally {
      conversationCreationLocks.delete(student.id);
    }
  }
  async function handleLogin(request, response) {
    const input = await jsonBody(request);
    if (!limits.allow("login-total", 120) || !limits.allow("login:" + input.studentId, 10))
      return reply(response, 429, { error: "Wait a minute before trying again" });
    const student = students.get(input.studentId);
    const admin = config.admin?.id === input.studentId ? config.admin : null;
    const account = student || admin;
    if (!account || !validPassword(input.password, account))
      return reply(response, 401, { error: "Invalid login" });
    const token = randomBytes(32).toString("hex");
    sessions.set(token, {
      studentId: account.id,
      role: admin ? "admin" : "student",
      expires: Date.now() + 6 * 3600000,
    });
    const secure = request.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
    return reply(
      response,
      200,
      { studentId: account.id, role: admin ? "admin" : "student" },
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
      "GET /study/latest",
      {
        method: "GET",
        run: async (request, response, { student }) => {
          const agentId = new URL(request.url, "http://study.local").searchParams.get("agentId");
          const allowed = [
            student.agentId,
            ...(student.ownedConversationIds || []),
            ...(student.historicalAgentIds || []),
            ...(student.preservedAgentIds || []),
          ];
          if (!allowed.includes(agentId))
            return reply(response, 404, { error: "Conversation not found" });
          if ((student.preservedAgentIds || []).includes(agentId)) {
            const transcriptPath = join(config.recordsDir, `${student.id}.transcript.json`);
            const saved = existsSync(transcriptPath)
              ? JSON.parse(readFileSync(transcriptPath, "utf8"))
              : null;
            const conversation = (saved?.conversations || []).find(
              (item) => item.agentId === agentId,
            );
            const latest = conversation?.entries
              .toReversed()
              .find((entry) => entry.item.type === "assistant_message");
            return reply(response, 200, {
              text: latest?.item.text || "",
              timestamp: latest?.timestamp || null,
            });
          }
          await prepareConversation(student, agentId);
          const page = await clients.get(student.id).fetchAgentTimeline(agentId, {
            projection: "canonical",
            limit: 20,
          });
          const latest = page.entries
            .toReversed()
            .find((entry) => entry.item.type === "assistant_message");
          return reply(response, 200, {
            text: latest?.item.text || "",
            timestamp: latest?.timestamp || null,
          });
        },
      },
    ],
    [
      "GET /study/files",
      {
        method: "GET",
        run: async (_request, response, { student }) =>
          reply(response, 200, {
            files: documentRecords(config, student).map(
              ({ id, name, mimeType, bytes, kind, recordedAt }) => ({
                id,
                name,
                mimeType,
                bytes,
                kind,
                recordedAt,
              }),
            ),
          }),
      },
    ],
    [
      "POST /study/files",
      {
        method: "POST",
        run: async (request, response, { student }) => {
          const input = await jsonBody(request, 12 * 1024 * 1024);
          if (typeof input.name !== "string" || typeof input.data !== "string")
            return reply(response, 400, { error: "Choose a supported document" });
          const record = await persistDocumentUpload(config, student, {
            name: input.name,
            data: input.data,
          });
          return reply(response, 201, record);
        },
      },
    ],
    [
      "GET /study/memory",
      {
        method: "GET",
        run: async (_request, response, { student }) => {
          return reply(response, 200, readStudentMemory(config, student));
        },
      },
    ],
    [
      "POST /study/memory",
      {
        method: "POST",
        run: async (request, response, { student }) => {
          const input = await jsonBody(request, 12000);
          if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 8192)
            return reply(response, 400, { error: "Memory must be 8 KiB or less" });
          return reply(response, 200, writeStudentMemory(config, student, input.text));
        },
      },
    ],
    [
      "DELETE /study/memory",
      {
        method: "DELETE",
        run: async (_request, response, { student }) => {
          writeStudentMemory(config, student, "");
          return reply(response, 200, { ok: true });
        },
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
              agentId: entry.agentId,
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
          const promptEntries = saved.entries.filter((entry) => entry.item.type === "user_message");
          const prompt = promptEntries.find(
            (entry) => (entry.item.messageId || String(entry.seqStart)) === parsed.data.promptId,
          );
          if (parsed.data.promptId !== "non-ai" && !prompt)
            return reply(response, 403, { error: "Prompt does not belong to this student" });
          const record = {
            id: randomUUID(),
            studentId: student.id,
            agentId: prompt?.agentId || student.agentId,
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
  ]);
  async function exportStudent(student, outputBase = "/study/output/") {
    const saved = await transcript(student);
    const generatedImages = generatedImageRecords(config, student);
    const listed = await clients
      .get(student.id)
      .fetchAgents({ filter: { includeArchived: true }, page: { limit: 200 } });
    const savedIds = new Set(saved.conversations.map((item) => item.agentId));
    return {
      schemaVersion: 2,
      exportedAt: new Date().toISOString(),
      ...saved,
      providerSessions: listed.entries
        .filter(({ agent }) => savedIds.has(agent.id) && agent.persistence?.provider === "codex")
        .map(({ agent }) => ({
          agentId: agent.id,
          provider: agent.persistence.provider,
          sessionId: agent.persistence.sessionId,
        })),
      entries: saved.entries.map((entry) => {
        if (entry.item?.type !== "assistant_message" || typeof entry.item.text !== "string")
          return entry;
        return Object.assign({}, entry, {
          item: Object.assign({}, entry.item, {
            text: rewriteGeneratedImageMarkdown(entry.item.text, generatedImages, outputBase),
          }),
        });
      }),
      annotations: annotations(student),
      settingChanges: settingChanges(student),
      submittedImages: imageRecords(config, student),
      generatedImages: generatedImageRecords(config, student),
      submittedDocuments: documentRecords(config, student).filter((file) => file.kind === "upload"),
      documentOutputs: documentRecords(config, student).filter((file) => file.kind === "output"),
    };
  }
  function serveImage(response, student, id) {
    const file = imageFile(config, student, id);
    if (!file) return reply(response, 404, { error: "Image not found" });
    response.writeHead(200, {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, no-store",
    });
    createReadStream(file.path).pipe(response);
  }
  function serveGeneratedImage(response, student, id) {
    const file = generatedImageFile(config, student, id);
    if (!file || !existsSync(file.path)) return reply(response, 404, { error: "Image not found" });
    response.writeHead(200, {
      "Content-Type": file.mimeType,
      "Cache-Control": "private, no-store",
    });
    createReadStream(file.path).pipe(response);
  }
  function serveDocument(response, student, id) {
    const file = documentFile(config, student, id);
    if (!file || !existsSync(file.path))
      return reply(response, 404, { error: "Document not found" });
    const encodedName = encodeURIComponent(file.name);
    response.writeHead(200, {
      "Content-Type": file.mimeType,
      "Content-Disposition": `attachment; filename="document"; filename*=UTF-8''${encodedName}`,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    createReadStream(file.path).pipe(response);
  }
  async function exportAdmin(request, response) {
    const archiveRequested =
      new URL(request.url, "http://study.local").searchParams.get("format") === "archive";
    if (archiveRequested && exportingArchive)
      return reply(response, 409, { error: "A research export is already running" });
    if (archiveRequested) exportingArchive = true;
    try {
      const data = {
        schemaVersion: 2,
        students: await Promise.all(
          [...students.values()].map((student) => exportStudent(student, "/study/admin/output/")),
        ),
      };
      if (archiveRequested)
        return await sendResearchArchive(
          response,
          await createResearchArchive(config, [...students.values()], data),
        );
      return reply(response, 200, data, {
        "Content-Disposition": "attachment; filename=lulu-study-results.json",
      });
    } finally {
      if (archiveRequested) exportingArchive = false;
    }
  }
  async function adminRoute(pathname, request, response) {
    if (request.method !== "GET") return reply(response, 405, { error: "Method not allowed" });
    if (pathname === "/study/admin")
      return reply(response, 200, adminHtml, { "Content-Type": "text/html; charset=utf-8" });
    if (pathname === "/study/admin/session") {
      const agentId = new URL(request.url, "http://study.local").searchParams.get("agentId");
      const owner = [...students.values()].find((student) =>
        [
          student.agentId,
          ...student.ownedConversationIds,
          ...(student.historicalAgentIds || []),
          ...(student.preservedAgentIds || []),
        ].includes(agentId),
      );
      if (!owner) return reply(response, 404, { error: "Session not found" });
      const data = researchSession(await exportStudent(owner, "/study/admin/output/"), agentId);
      if (!data) return reply(response, 404, { error: "Session not found" });
      return reply(response, 200, data);
    }
    const selected = students.get(
      new URL(request.url, "http://study.local").searchParams.get("studentId"),
    );
    if (pathname === "/study/admin/student" && selected)
      return reply(response, 200, await exportStudent(selected, "/study/admin/output/"));
    if (pathname === "/study/admin/image" && selected)
      return serveImage(
        response,
        selected,
        new URL(request.url, "http://study.local").searchParams.get("id"),
      );
    if (pathname.startsWith("/study/admin/file/") && selected)
      return serveDocument(response, selected, pathname.slice("/study/admin/file/".length));
    if (pathname.startsWith("/study/admin/output/") && selected)
      return serveGeneratedImage(response, selected, pathname.slice("/study/admin/output/".length));
    if (pathname === "/study/admin/export") return exportAdmin(request, response);
    if (pathname !== "/study/admin/results") return reply(response, 404, { error: "Not found" });
    const summaries = await Promise.all(
      [...students.values()].map(async (student) => {
        const saved = await transcript(student);
        const allEntries = saved.entries;
        const prompts = allEntries.filter((entry) => entry.item.type === "user_message");
        const timestamps = allEntries.map((entry) => entry.timestamp).sort();
        const notes = annotations(student);
        const annotated = new Set(notes.map((record) => record.promptId));
        return {
          studentId: student.id,
          prompts: prompts.length,
          annotations: notes.length,
          images: imageRecords(config, student).length,
          documents: documentRecords(config, student).length,
          missingAnnotations: prompts.filter(
            (entry) => !annotated.has(entry.item.messageId || String(entry.seqStart)),
          ).length,
          lastEventAt: timestamps.at(-1) || null,
        };
      }),
    );
    return reply(response, 200, { mode: config.mode, students: summaries });
  }
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
        '<script>window.__PASEO_INITIAL_DAEMON_CONNECTION__={listen:window.location.hostname+":"+(window.location.port||(window.location.protocol==="https:"?"443":"80")),useTls:window.location.protocol==="https:"};if(["/","/welcome","/open-project","/new","/history","/settings"].includes(window.location.pathname))window.history.replaceState(null,"",' +
        JSON.stringify(initialRoute) +
        ")</script>";
      response.end(readFileSync(filename, "utf8").replace(/<\/head>/i, bootstrap + "</head>"));
      return;
    }
    createReadStream(filename).pipe(response);
  }
  async function handleAuthenticated(pathname, request, response, session) {
    if (pathname.startsWith("/study/admin")) {
      if (session.role !== "admin")
        return reply(response, 403, { error: "Researcher access required" });
      return await adminRoute(pathname, request, response);
    }
    if (session.role === "admin" && pathname !== "/study/logout")
      return reply(response, 403, { error: "Use the researcher view" });
    if (pathname.startsWith("/study/image/"))
      return serveImage(response, session.student, pathname.slice("/study/image/".length));
    if (pathname.startsWith("/study/file/"))
      return serveDocument(response, session.student, pathname.slice("/study/file/".length));
    if (pathname.startsWith("/study/output/"))
      return serveGeneratedImage(
        response,
        session.student,
        pathname.slice("/study/output/".length),
      );
    if (pathname === "/study/export") return reply(response, 404, { error: "Not found" });
    const student = session.student;
    const route =
      researchRoutes.get(`${request.method} ${pathname}`) || researchRoutes.get(pathname);
    if (route) {
      if (request.method !== route.method)
        return reply(response, 405, { error: "Method not allowed" });
      return await route.run(request, response, session);
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
        if (pathname === "/study/admin" && request.method === "GET")
          return reply(response, 200, loginHtml, { "Content-Type": "text/html; charset=utf-8" });
        if (pathname.startsWith("/study/") || pathname.startsWith("/api/"))
          return reply(response, 401, { error: "Sign in first" });
        return reply(response, 200, loginHtml, { "Content-Type": "text/html; charset=utf-8" });
      }
      return await handleAuthenticated(pathname, request, response, session);
    } catch (error) {
      if (!response.headersSent)
        reply(response, 400, { error: "The request failed. Please retry." });
      console.error("Study request failed:", error.message);
    }
  });
  installProxy({
    prepareConversation,
    handleStudentRequest,
    server,
    config,
    authenticate,
    checkOrigin,
    sessions,
    socketPairs,
    limits,
    getConversationSettings: settingsFor,
    onAssistantTimeline: (student, entries) => archiveImages(student, entries).catch(() => {}),
  });
  await new Promise((accept) => server.listen(config.port || 0, "127.0.0.1", accept));
  const maintenance = setInterval(() => {
    for (const [token, session] of sessions)
      if (session.expires < Date.now()) {
        sessions.delete(token);
        for (const pair of socketPairs)
          if (pair.token === token) {
            pair.browser.close(1008, "Session expired");
            pair.upstream.close();
          }
      }
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
      for (const student of students.values())
        await transcript(student).catch((error) =>
          console.error("Final transcript checkpoint failed:", error.message),
        );
      for (const recorder of recorders.values()) await recorder.close();
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
