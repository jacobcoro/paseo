import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pipeline } from "node:stream/promises";
import { createReadStream } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { imageFile } from "./images.mjs";
import { generatedImageFile } from "./outputs.mjs";
import { documentFile } from "./documents.mjs";

const recordKinds = [
  "requests",
  "events",
  "denied",
  "annotations",
  "settings",
  "images",
  "generated-images",
  "documents",
  "tools",
  "memory",
];
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const maxFileBytes = 64 * 1024 * 1024;
const maxArchiveBytes = 4 * 1024 * 1024 * 1024;

// Export a copy of registered research files, never a runtime/auth directory.
// tar streams from disk so classroom archives do not grow gateway memory.
export async function createResearchArchive(config, students, exported) {
  const directory = await mkdtemp(join(tmpdir(), "lulu-research-export-"));
  const root = join(directory, "research");
  const files = new Map();
  const gaps = [];
  let totalBytes = 0;
  async function add(name, contents) {
    if (files.has(name)) return;
    const destination = join(root, name);
    if (relative(root, destination).startsWith("..")) throw Error("Invalid archive path");
    totalBytes += contents.length;
    if (totalBytes > maxArchiveBytes)
      throw Error("Research export exceeds 4 GiB; export after each class");
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, contents, { mode: 0o600 });
    files.set(name, {
      path: name,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    });
  }
  async function addFile(name, path, optional = false) {
    let stat;
    try {
      stat = await lstat(path);
    } catch (error) {
      if (optional && error.code === "ENOENT") {
        gaps.push({ path: name, reason: "Not recorded" });
        return;
      }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink())
      throw Error("Research archive requires regular files");
    if (stat.size > maxFileBytes)
      throw Error("Research log exceeds 64 MiB; export after each class");
    let bytes = await readFile(path);
    if (path.endsWith(".jsonl") && bytes.length && bytes.at(-1) !== 10) {
      // A broker may be appending a record. Keep only completed JSONL lines.
      bytes = bytes.subarray(0, bytes.lastIndexOf(10) + 1);
      gaps.push({ path: name, reason: "An incomplete final line was excluded" });
    }
    await add(name, bytes);
  }
  async function addSubmittedImage(student, image) {
    for (const id of new Set([image.id, image.providerId])) {
      const file = imageFile(config, student, id);
      if (!file) throw Error("Missing registered image");
      await addFile(`images/${student.id}/${id}.${image.format}`, file.path);
    }
  }
  async function rollouts(path, sessions, studentId) {
    let items;
    try {
      items = await readdir(path, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const item of items) {
      if (item.isDirectory() && /^\d{2,4}$/.test(item.name))
        await rollouts(join(path, item.name), sessions, studentId);
      else if (item.isFile() && item.name.startsWith("rollout-") && item.name.endsWith(".jsonl")) {
        const id = item.name.slice(-42, -6);
        if (sessions.has(id))
          await addFile(`provider/${studentId}/${id}.jsonl`, join(path, item.name));
      }
    }
  }
  try {
    await add("results.json", Buffer.from(JSON.stringify(exported, null, 2)));
    for (const student of students) {
      if (!/^[\w-]+$/.test(student.id)) throw Error("Invalid student ID");
      const data = exported.students.find((item) => item.studentId === student.id);
      for (const kind of recordKinds)
        await addFile(
          `logs/${student.id}.${kind}.jsonl`,
          join(config.recordsDir, `${student.id}.${kind}.jsonl`),
          true,
        );
      for (const image of data.submittedImages) await addSubmittedImage(student, image);
      for (const image of data.generatedImages) {
        const file = generatedImageFile(config, student, image.id);
        if (!file) throw Error("Missing registered output image");
        await addFile(`generated-images/${student.id}/${image.id}.${image.format}`, file.path);
      }
      for (const document of [...data.submittedDocuments, ...data.documentOutputs]) {
        const file = documentFile(config, student, document.id);
        if (!file) throw Error("Missing registered document");
        await addFile(`documents/${student.id}/${document.id}`, file.path);
      }
      const sessions = new Set(
        (data.providerSessions || [])
          .map((item) => item.sessionId)
          .filter((id) => uuid.test(id || "")),
      );
      for (const path of student.providerRecordsDirs || [])
        await rollouts(path, sessions, student.id);
      for (const sessionId of sessions)
        if (!files.has(`provider/${student.id}/${sessionId}.jsonl`))
          gaps.push({
            studentId: student.id,
            sessionId,
            reason: "Native provider log unavailable",
          });
    }
    await add(
      "README.txt",
      Buffer.from(
        "Private researcher archive. results.json contains complete recorded conversation groups, annotations and settings. logs/ contains recorded requests, events, tool activity and errors. images/ includes originals and provider-processed copies; generated-images/ and documents/ contain registered outputs. Join files to results.json by student ID and content ID. provider/ contains only registered Codex sessions, when available; turn_context records model/effort and session_meta records CLI version/instructions. These native logs can contain participant and account identifiers: de-identify before sharing. manifest.json records SHA256 and any missing log categories. Missing optional logs can mean no such activity occurred; a historical missing stream log cannot be recreated. A live export is a bounded snapshot, not a database transaction or a backup of login credentials. It cannot recover data never recorded, hidden model reasoning, external work or original browser screenshots. Verify every manifest checksum after extraction. The authenticated admin session view uses the saved agent ID. Keep this archive in restricted storage.\n",
      ),
    );
    await writeFile(
      join(root, "manifest.json"),
      JSON.stringify(
        {
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          snapshot: "Completed records copied during export; live writes can continue",
          files: [...files.values()],
          gaps,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    const path = join(directory, "lulu-study-research.tar.gz");
    await promisify(execFile)("tar", ["-czf", path, "-C", directory, "--", "research"], {
      timeout: 60000,
      maxBuffer: 65536,
    });
    return { path, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function sendResearchArchive(response, archive) {
  try {
    response.writeHead(200, {
      "Content-Type": "application/gzip",
      "Content-Disposition": 'attachment; filename="lulu-study-research.tar.gz"',
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
    await pipeline(createReadStream(archive.path), response);
  } finally {
    await archive.cleanup();
  }
}
