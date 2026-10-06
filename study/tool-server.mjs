import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { employeeTools, employeeToolArguments } from "./employee-profile.mjs";

const root = process.env.STUDY_TOOL_DIRECTORY || "/workspace/.study-tools";
const settingsPath = process.env.STUDY_TOOL_SETTINGS || "/home/node/.codex/study-tools.json";
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, "utf8")) : {};
if (settings.profile && settings.profile !== "employee-production")
  throw Error("Unknown tool profile");
const employee = settings.profile === "employee-production";
const publicUrl = process.env.STUDY_PUBLIC_URL || settings.publicUrl || "";
const workflows = Object.fromEntries(
  ["study-documents", "study-analysis", "study-research"].map((name) => [
    name,
    readFileSync(new URL(`./skills/${name}/SKILL.md`, import.meta.url), "utf8"),
  ]),
);
const studyTools = [
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
const tools = employee ? employeeTools(studyTools, settings.mediaReady === true) : studyTools;
async function submit(operation, args) {
  const id = randomUUID();
  const input = join(root, "inbox", id + ".json");
  const output = join(root, "results", id + ".json");
  mkdirSync(join(root, "inbox"), { recursive: true, mode: 0o700 });
  mkdirSync(join(root, "results"), { recursive: true, mode: 0o700 });
  writeFileSync(
    input + ".tmp",
    JSON.stringify({
      ...args,
      operation,
      files: args.files || [],
      ...(employee ? { assignment: settings.assignment } : {}),
    }),
    {
      mode: 0o600,
    },
  );
  renameSync(input + ".tmp", input);
  const deadline = Date.now() + (employee ? 60000 : 120000);
  while (Date.now() < deadline) {
    if (existsSync(output)) {
      const result = JSON.parse(readFileSync(output, "utf8"));
      rmSync(output);
      if (result.error) throw Error(result.error);
      return result.result;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw Error(
    employee
      ? "Employee tool outcome is uncertain; host reconciliation is required before retry."
      : "Study tool timed out. Retry once; do not claim completion.",
  );
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
  { name: employee ? "employee-production-tools" : "lulu-study-tools", version: "1.0.0" },
  {
    capabilities: { tools: {} },
    instructions: employee
      ? "Use only this assigned concept's registered source files and bounded tools. Return saved IDs and exact revisions. The trusted host publishes Experiment links. Tools grant no command, provider, spend, send, posting, or access authority."
      : "Use these tools for this student's uploaded documents, calculations and generated downloads. Read relevant study workflow with read_skill. All computations and files belong only to this student. Tools do not grant local shell, other accounts or desktop access.",
  },
);
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  try {
    const { name, arguments: args = {} } = request.params;
    if (!tools.some((tool) => tool.name === name)) throw Error("Unknown tool");
    const input = employee ? employeeToolArguments(name, args) : args;
    const saved = name === "read_skill" ? workflows[input.name] : await submit(name, input);
    const result = employee ? saved : addLinks(saved);
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
