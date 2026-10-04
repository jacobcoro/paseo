import { ensureAdmin } from "./admin-account.mjs";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { WebSocket } from "ws";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync, copyFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { passwordHash } from "./gateway.mjs";

async function canConnect(url, password) {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${password}` } });
  socket.on("error", () => {});
  try {
    await once(socket, "open", { signal: AbortSignal.timeout(2000) });
    return true;
  } catch {
    return false;
  } finally {
    socket.terminate();
  }
}
const root = resolve(new URL("..", import.meta.url).pathname);
const directory = resolve(process.argv[2]);
const mode = process.argv[3] || "fixture";
if (!["fixture", "live"].includes(mode)) throw new Error("Choose fixture or live");
mkdirSync(directory, { recursive: true, mode: 0o700 });
const configPath = join(directory, "config.json");
if (existsSync(configPath))
  throw new Error("Runtime already exists; use a new private runtime directory");
const students = [];
const containers = [];
try {
  for (const id of ["s0101", "s0102"]) {
    const studentRoot = join(directory, id);
    const home = join(studentRoot, "home");
    const workspace = join(studentRoot, "workspace");
    const paseoHome = join(home, ".paseo");
    const codexHome = join(home, ".codex");
    for (const path of [home, workspace, paseoHome, codexHome])
      mkdirSync(path, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(workspace, "design-brief.md"),
      "设计任务：为老年人设计一款水杯。记录你的分析、选择与修改。\nDesign a drinking cup for older adults. Document your analysis, choices, and revisions.\n",
    );
    writeFileSync(
      join(paseoHome, "config.json"),
      JSON.stringify({
        version: 1,
        daemon: { relay: { enabled: false } },
        features: {
          webUi: { enabled: false },
          dictation: { enabled: false },
          voiceMode: { enabled: false },
        },
      }),
    );
    const daemonPassword = randomBytes(24).toString("hex");
    const password = randomBytes(12).toString("base64url");
    const salt = randomBytes(16).toString("hex");
    const name = `lulu-study-${randomBytes(4).toString("hex")}-${id}`;
    const liveMounts = [];
    if (mode === "live") {
      if (!process.env.STUDY_CODEX_BINARY || !process.env.STUDY_CODEX_AUTH)
        throw new Error("Live smoke requires STUDY_CODEX_BINARY and STUDY_CODEX_AUTH paths");
      copyFileSync(process.env.STUDY_CODEX_AUTH, join(codexHome, "auth.json"));
      writeFileSync(
        join(codexHome, "config.toml"),
        'model = "gpt-6.1-sol"\nmodel_reasoning_effort = "low"\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\n[features]\nshell_tool = false\nmulti_agent = false\napply_patch_freeform = false\n',
      );
      liveMounts.push("-v", `${process.env.STUDY_CODEX_BINARY}:/usr/local/bin/codex:ro`);
    }
    execFileSync(
      "docker",
      [
        "run",
        "-d",
        "--name",
        name,
        "--user",
        `${process.getuid()}:${process.getgid()}`,
        "--read-only",
        "--cap-drop=ALL",
        "--pids-limit=128",
        "--memory=1536m",
        "--cpus=1",
        "--tmpfs",
        "/tmp:rw,nosuid,size=256m",
        "-v",
        `${root}:/app:ro`,
        "-v",
        `${home}:/home/node:rw`,
        "-v",
        `${workspace}:/workspace:rw`,
        ...liveMounts,
        "-p",
        "127.0.0.1::6767",
        "-e",
        "PASEO_HOME=/home/node/.paseo",
        "-e",
        "PASEO_NODE_ENV=development",
        "-e",
        "PASEO_LISTEN=0.0.0.0:6767",
        "-e",
        "PASEO_RELAY_ENABLED=false",
        "-e",
        `PASEO_PASSWORD=${daemonPassword}`,
        "-e",
        "PASEO_LOG_FORMAT=json",
        "-w",
        "/app",
        "lulu-study-runtime:demo",
        "node",
        "packages/server/dist/scripts/supervisor-entrypoint.js",
      ],
      { stdio: "pipe" },
    );
    containers.push(name);
    writeFileSync(join(directory, "containers.json"), JSON.stringify(containers));
    let port;
    for (let attempt = 0; attempt < 30; attempt++) {
      const state = JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8" }))[0];
      port = state.NetworkSettings.Ports["6767/tcp"]?.[0]?.HostPort;
      if (port) break;
      if (!state.State.Running)
        throw new Error(
          execFileSync("docker", ["logs", "--tail", "15", name], { encoding: "utf8" }),
        );
      await new Promise((accept) => setTimeout(accept, 300));
    }
    if (!port) throw new Error("Container did not publish its assigned port");
    const daemonUrl = `ws://127.0.0.1:${port}/ws`;
    let ready = false;
    for (let attempt = 0; attempt < 90; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/api/health`);
        ready = response.ok;
      } catch {
        ready = false;
      }
      if (ready) break;
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!ready)
      throw new Error(
        `Student runtime ${id} did not start: ${execFileSync("docker", ["logs", "--tail", "15", name], { encoding: "utf8" })}`,
      );
    let accepting = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      accepting = await canConnect(daemonUrl, daemonPassword);
      if (accepting) break;
      await new Promise((accept) => setTimeout(accept, 500));
    }
    if (!accepting) throw new Error("Daemon did not accept authenticated WebSocket connections");
    const client = new DaemonClient({
      url: daemonUrl,
      password: daemonPassword,
      clientId: `study-setup-${id}`,
      clientType: "cli",
      webSocketFactory: (url, options) =>
        new WebSocket(url, options?.protocols, { headers: options?.headers }),
      reconnect: { enabled: false },
    });
    await client.connect();
    try {
      const created = await client.createWorkspace({
        source: { kind: "directory", path: "/workspace" },
        title: "水杯设计 / Cup design",
      });
      if (!created.workspace) throw new Error(created.error || "Workspace creation failed");
      const config =
        mode === "fixture"
          ? {
              provider: "mock",
              cwd: "/workspace",
              model: "one-minute-stream",
              featureValues: {
                mockStreamingAssistantResponse:
                  "## 老年人水杯设计 · 演示回答\n\n**这是固定的演示内容，不是真实 AI 推理。**\n\n林阿姨，68 岁，手部握力下降。她需要轻量、易握、防烫、易开启的水杯。\n\n### 需要验证的需求\n- 单手拿握与开盖是否省力\n- 杯口与外壁是否容易烫手\n- 大口径结构是否便于清洗\n\n### 你的设计选择\n你可以采用、修改或拒绝这些建议。请在“研究记录”里填写下一步行动与采用程度。\n\nThis fixture tests streaming, persistence, and research annotations. Live Codex is tested separately.",
                mockStreamingAssistantIntervalMs: 8,
              },
            }
          : {
              provider: "codex",
              cwd: "/workspace",
              model: "gpt-6.1-sol",
              thinkingOptionId: "low",
              modeId: "auto",
              providerOptions: {
                approval_policy: "never",
                sandbox_mode: "read-only",
                web_search: "disabled",
                features: { multi_agent_v2: false },
              },
              mcpServers: {},
              systemPrompt:
                "You assist a student designing a cup for older adults. Answer in the student's language. The student chooses whether to use your suggestions. Do not execute commands, access credentials, or spawn agents.",
            };
      const agent = await client.createAgent({
        workspaceId: created.workspace.id,
        config: { ...config, title: "水杯设计研究 / Cup design study" },
        labels: { "study.student": id },
      });
      const status = await fetch(`http://127.0.0.1:${port}/api/status`, {
        headers: { Authorization: `Bearer ${daemonPassword}` },
      }).then((response) => response.json());
      students.push({
        id,
        salt,
        passwordHash: passwordHash(password, salt),
        daemonPassword,
        daemonUrl,
        serverId: status.serverId,
        agentId: agent.id,
        workspaceId: created.workspace.id,
      });
      writeFileSync(join(directory, `${id}.login.txt`), `${id}\n${password}\n`, { mode: 0o600 });
      console.log(`Prepared ${id}: ${agent.id} (${mode})`);
    } finally {
      await client.close();
    }
  }
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mode,
        model: mode === "fixture" ? "fixture" : "gpt-6.1-sol",
        students,
        recordsDir: join(directory, "records"),
        webDir: join(root, "packages/app/dist"),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  ensureAdmin(configPath);
} catch (error) {
  for (const name of containers) {
    writeFileSync(
      join(directory, `${name}.failure.log`),
      execFileSync("docker", ["logs", "--tail", "80", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" });
  }
  throw error;
}
