import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  existsSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { join, resolve, basename, extname, dirname } from "node:path";

export const DOCUMENT_LIMITS = { fileBytes: 10 * 1024 * 1024, studentBytes: 100 * 1024 * 1024 };
const types = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
};
export function nativeDocumentMimeType(name) {
  const extension = extname(name).toLowerCase();
  if ([".png", ".jpg", ".jpeg", ".webp"].includes(extension)) return null;
  return types[extension] || null;
}
export function studentWorkspace(config, student) {
  return student.workspacePath || join(dirname(config.recordsDir), student.id, "workspace");
}
export function documentRecords(config, student) {
  const index = join(config.recordsDir, `${student.id}.documents.jsonl`);
  return existsSync(index)
    ? readFileSync(index, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function validate(name, bytes, kind) {
  const extension = extname(name).toLowerCase();
  if (
    !types[extension] ||
    (kind === "upload" && [".png", ".jpg", ".jpeg", ".webp"].includes(extension))
  )
    throw Error("Use PDF, DOCX, XLSX, PPTX, TXT, MD, CSV or JSON files");
  if (!bytes.length || bytes.length > DOCUMENT_LIMITS.fileBytes)
    throw Error("Each file must be 10 MiB or less");
  if (extension === ".pdf" && !bytes.subarray(0, 5).equals(Buffer.from("%PDF-")))
    throw Error("Invalid PDF file");
  if (
    [".docx", ".xlsx", ".pptx"].includes(extension) &&
    !bytes.subarray(0, 4).equals(Buffer.from([80, 75, 3, 4]))
  )
    throw Error("Invalid Office document");
  if ([".txt", ".md", ".csv", ".json"].includes(extension)) {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (bytes.includes(0)) throw Error("Use UTF-8 text files");
  }
  return types[extension];
}
export function registerDocument(config, student, name, bytes, kind = "upload", details = {}) {
  if (
    typeof name !== "string" ||
    !name ||
    name.length > 180 ||
    name !== basename(name) ||
    /[\\/]/.test(name) ||
    [...name].some((char) => char.codePointAt(0) < 32)
  )
    throw Error("Invalid file name");
  const mimeType = validate(name, bytes, kind);
  const previous = documentRecords(config, student);
  const id = createHash("sha256")
    .update(kind + "\0" + name + "\0")
    .update(bytes)
    .digest("hex");
  const existing = previous.find((item) => item.id === id);
  if (existing) {
    if (!details.nativeUploadId) return existing;
    const linkedRecord = { ...existing, ...details };
    appendFileSync(
      join(config.recordsDir, `${student.id}.documents.jsonl`),
      JSON.stringify(linkedRecord) + "\n",
      { mode: 0o600 },
    );
    return linkedRecord;
  }
  const storedBytes = new Map();
  for (const record of previous)
    storedBytes.set(record.id, Math.max(storedBytes.get(record.id) || 0, record.bytes));
  if (
    [...storedBytes.values()].reduce((sum, stored) => sum + stored, 0) + bytes.length >
    DOCUMENT_LIMITS.studentBytes
  )
    throw Error("Student file storage limit reached");
  const safeName = name.replace(/[^\p{L}\p{N}._ -]/gu, "_");
  const category = kind === "upload" ? "inputs" : "outputs";
  const relative = join("study-files", category, id + "-" + safeName);
  const workspace = studentWorkspace(config, student);
  const file = resolve(workspace, relative);
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (realpathSync(directory) !== directory) throw Error("Invalid study file directory");
  writeFileSync(file, bytes, { mode: 0o600, flag: "wx" });
  const archive = join(config.recordsDir, "documents", student.id);
  mkdirSync(archive, { recursive: true, mode: 0o700 });
  writeFileSync(join(archive, id), bytes, { mode: 0o600, flag: "wx" });
  const record = {
    id,
    name,
    mimeType,
    bytes: bytes.length,
    kind,
    path: "/workspace/" + relative,
    recordedAt: new Date().toISOString(),
    ...details,
  };
  appendFileSync(
    join(config.recordsDir, `${student.id}.documents.jsonl`),
    JSON.stringify(record) + "\n",
    { mode: 0o600 },
  );
  return record;
}
export function documentFile(config, student, id) {
  if (!/^[a-f0-9]{64}$/.test(id || "")) return null;
  const record = documentRecords(config, student).find((item) => item.id === id);
  if (!record) return null;
  const path = join(config.recordsDir, "documents", student.id, id);
  return existsSync(path) && !lstatSync(path).isSymbolicLink()
    ? { path, mimeType: record.mimeType, name: record.name }
    : null;
}
export function toolDirectories(config, student) {
  const root = join(studentWorkspace(config, student), ".study-tools");
  for (const sub of ["inbox", "results"])
    mkdirSync(join(root, sub), { recursive: true, mode: 0o700 });
  return { root, inbox: join(root, "inbox"), results: join(root, "results") };
}
