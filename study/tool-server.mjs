import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const root = process.env.STUDY_TOOL_DIRECTORY || "/workspace/.study-tools";
const settingsPath = "/home/node/.codex/study-tools.json";
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
const publicUrl = process.env.STUDY_PUBLIC_URL || settings.publicUrl || "";
const workflows = Object.fromEntries(
  ["study-documents", "study-analysis", "study-research"].map((name) => [
    name,
    readFileSync(new URL(`./skills/${name}/SKILL.md`, import.meta.url), "utf8"),
  ]),
);
const tools = [
  {
    name: "list_files",
    description: "List this student's uploaded and generated files, including IDs and names.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "read_file",
    description: "Read an uploaded UTF-8 text, CSV, Markdown or JSON file by its ID.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    name: "run_python",
    description:
      "Run Python in an isolated credential-free container to analyze selected uploaded files or generate charts/documents. Libraries pandas, matplotlib, python-docx, openpyxl, python-pptx, pymupdf and reportlab are installed. Input files: /work/inputs/<id>-<name>. Write downloads to /work/outputs/<name>. No network; 40-second limit. Returns stdout, errors and real downloadable files.",
    inputSchema: {
      type: "object",
      properties: {
        code: { type: "string", maxLength: 32000 },
        files: { type: "array", items: { type: "string" }, maxItems: 10 },
      },
      required: ["code"],
    },
  },
  {
    name: "write_text",
    description: "Create a downloadable TXT, Markdown, CSV or JSON file from text.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, text: { type: "string", maxLength: 60000 } },
      required: ["name", "text"],
    },
  },
  {
    name: "read_memory",
    description:
      "Read this student's saved preferences and project facts across their conversations.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "save_memory",
    description:
      "Save or replace this student's memory only when they ask to remember something or correct existing memory. Do not store passwords or other students' information. Pass the full updated memory text.",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", maxLength: 8192 } },
      required: ["text"],
    },
  },
  {
    name: "read_skill",
    description:
      "Read the workflow for study-documents, study-analysis or study-research when that task benefits from specialized file/research handling.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string", enum: Object.keys(workflows) } },
      required: ["name"],
    },
  },
];
async function submit(operation, args) {
  const id = randomUUID();
  const input = join(root, "inbox", id + ".json");
  const output = join(root, "results", id + ".json");
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "results"), { recursive: true, mode: 0o700 });
  writeFileSync(input + ".tmp", JSON.stringify({ ...args, operation, files: args.files || [] }), {
    mode: 0o600,
  });
  renameSync(input + ".tmp", input);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (existsSync(output)) {
      const result = JSON.parse(readFileSync(output, "utf8"));
      rmSync(output);
      if (result.error) throw Error(result.error);
      return result.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error("Study tool timed out. Retry once; do not claim completion.");
}
function addLinks(value) {
  if (Array.isArray(value)) return value.map(addLinks);
  if (!value || typeof value !== "object") return value;
  const result = Object.fromEntries(
    Object.entries(value).map(([key, child]) => [key, addLinks(child)]),
  );
  if (result.id && result.name && result.mimeType)
    result.downloadUrl = publicUrl + "/study/file/" + result.id;
  return result;
}
const server = new Server(
  { name: "lulu-study-tools", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions:
      "Use these tools for this student's uploaded documents, calculations, charts, generated downloads and saved memory. Read relevant study workflow with read_skill. All computations and files belong only to this student. Tools do not grant local shell, other accounts or desktop access.",
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args = {} } = request.params;
    if (!tools.some((tool) => tool.name === name)) throw Error("Unknown tool");
    const result =
      name === "read_skill" ? workflows[args.name] : addLinks(await submit(name, args));
    if (result === undefined) throw Error("Unknown workflow");
    return {
      content: [
        { type: "text", text: typeof result === "string" ? result : JSON.stringify(result) },
      ],
    };
  } catch (error) {
    return { isError: true, content: [{ type: "text", text: error.message }] };
  }
});
await server.connect(new StdioServerTransport());
