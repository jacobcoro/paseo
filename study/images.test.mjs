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

test("sixty students can upload together and each original is recorded", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  await Promise.all(
    Array.from({ length: 60 }, async (_, index) => {
      const concurrentStudent = { id: `concurrent-${index}` };
      const records = await persistImages(
        {
          messageId: `image-${index}`,
          images: [{ data: png.toString("base64"), mimeType: "image/png" }],
        },
        concurrentStudent,
        config,
      );
      assert.equal(records.length, 1);
      assert.equal(imageRecords(config, concurrentStudent)[0].clientMessageId, `image-${index}`);
    }),
  );
});

test("the upload queue rejects overflow and releases slots after invalid images", async () => {
  const requests = Array.from({ length: 69 }, (_, index) =>
    persistImages(
      { images: [{ data: Buffer.from("invalid PNG").toString("base64"), mimeType: "image/png" }] },
      { id: `invalid-${index}` },
      config,
    ),
  );
  const results = await Promise.allSettled(requests);
  assert.equal(results.filter((result) => result.reason?.message.includes("busy")).length, 1);
  assert.ok(results.every((result) => result.status === "rejected"));
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#fff" } })
    .png()
    .toBuffer();
  const records = await persistImages(
    { images: [{ data: png.toString("base64"), mimeType: "image/png" }] },
    { id: "after-invalid" },
    config,
  );
  assert.equal(records.length, 1);
});
