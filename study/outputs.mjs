import sharp from "sharp";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const OUTPUT_LIMITS = {
  fileBytes: 8 * 1024 * 1024,
  studentBytes: 50 * 1024 * 1024,
  pixels: 16 * 1024 * 1024,
};
const extFor = { png: "png", jpeg: "jpg", webp: "webp" };
const unsafeRoots = [
  /(?:^|\/)\.codex(?:\/|$)/i,
  /(?:^|\/)\.ssh(?:\/|$)/i,
  /(?:^|\/)\.config(?:\/|$)/i,
  /(?:^|\/)credentials?(?:\/|$)/i,
  /(?:^|\/)secrets?(?:\/|$)/i,
];

function parseFilePath(source) {
  try {
    if (/^file:/i.test(source)) return decodeURIComponent(new URL(source).pathname);
    if (source.startsWith("/")) return decodeURIComponent(source);
  } catch {}
  return null;
}
function safeOutputPath(source) {
  if (/\.(?:png|jpe?g|webp)$/i.test(source) === false) return null;
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(source) || /%2e/i.test(source)) return null;
  const path = parseFilePath(source);
  if (!path || path.includes("\0") || path.split(/[\\/]/).includes("..")) return null;
  if (
    !path.startsWith("/workspace/") &&
    !/^\/tmp\/paseo-attachments-[^/]+\//.test(path) &&
    !path.startsWith("/home/node/")
  )
    return null;
  const generatedRoot = "/home/node/.codex/generated_images/";
  if (!path.startsWith(generatedRoot) && unsafeRoots.some((pattern) => pattern.test(path)))
    return null;
  return path;
}
export function assistantImageReferences(entries) {
  const refs = new Set();
  for (const entry of entries || []) {
    if (entry.item?.type !== "assistant_message" || typeof entry.item.text !== "string") continue;
    for (const match of entry.item.text.matchAll(/!\[[^\]]*\]\(([^\s)]+)(?:\s+[^)]*)?\)/g)) {
      const path = safeOutputPath(match[1].replace(/\\\)/g, ")"));
      if (path) refs.add(path);
    }
  }
  return [...refs];
}
function readIndex(config, student) {
  const index = join(config.recordsDir, `${student.id}.generated-images.jsonl`);
  if (!existsSync(index)) return [];
  return readFileSync(index, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}
export function generatedImageRecords(config, student) {
  return readIndex(config, student);
}
export function generatedImageFile(config, student, id) {
  const record = readIndex(config, student).find((item) => item.id === id);
  if (!record || record.studentId !== student.id || !extFor[record.format]) return null;
  return {
    path: join(config.recordsDir, "generated-images", student.id, `${id}.${extFor[record.format]}`),
    mimeType: record.mimeType,
  };
}
export function rewriteGeneratedImageMarkdown(text, records, base = "/study/output/") {
  const byPath = new Map(
    records.flatMap((record) => record.sources.map((source) => [source, record.id])),
  );
  return text.replace(/(!\[[^\]]*\]\()([^\s)]+)(\))/g, (all, prefix, source, suffix) => {
    const path = safeOutputPath(source);
    const id = path && byPath.get(path);
    return id ? `${prefix}${base}${encodeURIComponent(id)}${suffix}` : all;
  });
}
const archives = new Map();
let transfers = 0;
const waiting = [];
async function acquireTransfer() {
  if (transfers < 4) {
    transfers++;
    return;
  }
  if (waiting.length >= 64)
    throw new Error("Generated image collection is busy. Reconnect to retry.");
  await new Promise((accept) => waiting.push(accept));
}
function releaseTransfer() {
  const next = waiting.shift();
  if (next) next();
  else transfers--;
}
export function archiveAssistantImages(input) {
  const key = join(input.config.recordsDir, input.student.id);
  const previous = archives.get(key) || Promise.resolve();
  const current = previous.catch(() => {}).then(() => archiveImages(input));
  archives.set(key, current);
  void current
    .finally(() => {
      if (archives.get(key) === current) archives.delete(key);
    })
    .catch(() => {});
  return current;
}
async function archiveImages({ config, student, entries, readFile }) {
  const paths = assistantImageReferences(entries);
  if (!paths.length) return generatedImageRecords(config, student);
  const existing = readIndex(config, student);
  const known = new Set(existing.flatMap((record) => record.sources));
  const pending = paths.filter((path) => !known.has(path));
  if (!pending.length) return existing;
  await acquireTransfer();
  try {
    const dir = join(config.recordsDir, "generated-images", student.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let used = existing.reduce((sum, item) => sum + item.bytes, 0);
    const added = [];
    for (const path of pending) {
      let file;
      try {
        file = await readFile(path, OUTPUT_LIMITS.fileBytes);
      } catch {
        continue;
      }
      const bytes = Buffer.from(file.bytes);
      if (!bytes.length || bytes.length > OUTPUT_LIMITS.fileBytes) continue;
      let metadata;
      try {
        metadata = await sharp(bytes, {
          limitInputPixels: OUTPUT_LIMITS.pixels,
          failOn: "warning",
        }).metadata();
      } catch {
        continue;
      }
      if (!extFor[metadata.format] || (metadata.pages || 1) !== 1) continue;
      if (used + bytes.length > OUTPUT_LIMITS.studentBytes) break;
      const id = createHash("sha256").update(bytes).digest("hex");
      const filename = join(dir, `${id}.${extFor[metadata.format]}`);
      if (!existsSync(filename)) writeFileSync(filename, bytes, { mode: 0o600, flag: "wx" });
      const record = {
        id,
        studentId: student.id,
        agentId: student.agentId,
        mimeType: `image/${metadata.format}`,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
        bytes: bytes.length,
        sources: [path],
        recordedAt: new Date().toISOString(),
      };
      added.push(record);
      used += bytes.length;
    }
    if (added.length)
      appendFileSync(
        join(config.recordsDir, `${student.id}.generated-images.jsonl`),
        added.map((item) => JSON.stringify(item)).join("\n") + "\n",
        { mode: 0o600 },
      );
    return [...existing, ...added];
  } finally {
    releaseTransfer();
  }
}
