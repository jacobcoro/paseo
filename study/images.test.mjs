import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { persistImages, validImages, imageRecords } from "./images.mjs";
const student = { id: "synthetic" };
const config = { recordsDir: mkdtempSync(join(tmpdir(), "lulu-images-")) };
test("corrupt raster, wrong MIME, excessive dimensions, and active SVG cannot be uploaded", async () => {
  const corrupt = {
    images: [{ data: Buffer.from("not a PNG").toString("base64"), mimeType: "image/png" }],
  };
  await assert.rejects(persistImages(corrupt, student, config));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  await assert.rejects(
    persistImages(
      { images: [{ data: png.toString("base64"), mimeType: "image/jpeg" }] },
      student,
      config,
    ),
  );
  const huge = await sharp({
    create: { width: 5000, height: 5000, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    persistImages(
      { images: [{ data: huge.toString("base64"), mimeType: "image/png" }] },
      student,
      config,
    ),
  );
  assert.equal(
    validImages([{ data: Buffer.from("<svg/>").toString("base64"), mimeType: "image/svg+xml" }]),
    false,
  );
  assert.equal(imageRecords(config, student).length, 0);
});
