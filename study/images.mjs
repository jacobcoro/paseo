import sharp from "sharp";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export const IMAGE_LIMITS = {
  count: 4,
  bytes: 2 * 1024 * 1024,
  pixels: 16 * 1024 * 1024,
  storage: 50 * 1024 * 1024,
};
const formats = { "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" };
let decoding = 0;
const waiting = [];
async function acquireDecoder() {
  if (decoding < 4) {
    decoding++;
    return;
  }
  // Bound retained uploads while allowing a classroom to share four decoders.
  if (waiting.length >= 64) throw new Error("Image processing is busy. Please retry.");
  await new Promise((resolve) => waiting.push(resolve));
}
function releaseDecoder() {
  const next = waiting.shift();
  if (next) next();
  else decoding--;
}
export function validImages(images) {
  if (images === undefined) return true;
  if (!Array.isArray(images) || images.length > IMAGE_LIMITS.count) return false;
  return images.every(
    (image) =>
      image &&
      formats[image.mimeType] &&
      typeof image.data === "string" &&
      image.data.length <= Math.ceil(IMAGE_LIMITS.bytes / 3) * 4 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(image.data),
  );
}
export function imageRecords(config, student) {
  const path = join(config.recordsDir, `${student.id}.images.jsonl`);
  return existsSync(path)
    ? readFileSync(path, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
export async function persistImages(request, student, config) {
  if (!request.images?.length) return [];
  await acquireDecoder();
  try {
    const processed = [];
    for (const image of request.images) {
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.length > IMAGE_LIMITS.bytes || bytes.toString("base64") !== image.data)
        throw new Error("Invalid or oversized image");
      const decoder = sharp(bytes, { limitInputPixels: IMAGE_LIMITS.pixels, failOn: "warning" });
      const metadata = await decoder.metadata();
      if (metadata.format !== formats[image.mimeType] || (metadata.pages || 1) !== 1)
        throw new Error("Use a PNG, JPEG, or WebP still image");
      const output = await decoder.rotate().toFormat(metadata.format, { quality: 90 }).toBuffer();
      if (output.length > IMAGE_LIMITS.bytes)
        throw new Error("Image is too large after processing");
      processed.push({
        bytes,
        output,
        mimeType: image.mimeType,
        format: metadata.format,
        width: metadata.width,
        height: metadata.height,
      });
    }
    const previous = imageRecords(config, student);
    const used = previous.reduce(
      (total, record) => total + record.originalBytes + record.providerBytes,
      0,
    );
    const added = processed.reduce(
      (total, image) => total + image.bytes.length + image.output.length,
      0,
    );
    if (used + added > IMAGE_LIMITS.storage) throw new Error("Student image storage limit reached");
    const directory = join(config.recordsDir, "images", student.id);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const records = processed.map((image) => {
      const id = createHash("sha256").update(image.bytes).digest("hex");
      const providerId = createHash("sha256").update(image.output).digest("hex");
      writeFileSync(join(directory, `${id}.${image.format}`), image.bytes, { mode: 0o600 });
      writeFileSync(join(directory, `${providerId}.${image.format}`), image.output, {
        mode: 0o600,
      });
      return {
        id,
        providerId,
        mimeType: image.mimeType,
        format: image.format,
        width: image.width,
        height: image.height,
        originalBytes: image.bytes.length,
        providerBytes: image.output.length,
        clientMessageId: request.messageId,
        studentId: student.id,
        recordedAt: new Date().toISOString(),
      };
    });
    appendFileSync(
      join(config.recordsDir, `${student.id}.images.jsonl`),
      records.map((record) => JSON.stringify(record)).join("\n") + "\n",
      { mode: 0o600 },
    );
    request.images = processed.map((image) => ({
      mimeType: image.mimeType,
      data: image.output.toString("base64"),
    }));
    return records;
  } finally {
    releaseDecoder();
  }
}
export function imageFile(config, student, id) {
  if (!/^[a-f0-9]{64}$/.test(id || "")) return null;
  const record = imageRecords(config, student).find(
    (image) => image.id === id || image.providerId === id,
  );
  return record
    ? {
        path: join(config.recordsDir, "images", student.id, `${id}.${record.format}`),
        mimeType: record.mimeType,
      }
    : null;
}
