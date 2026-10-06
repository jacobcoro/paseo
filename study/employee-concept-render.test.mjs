import test from "node:test";
import assert from "node:assert/strict";
import { renderEmployeeVideo } from "./employee-tools.mjs";

test("SOURCE_ONLY direct concept renderer denies before host input access", async () => {
  let accesses = 0;
  const inaccessible = new Proxy(
    {},
    {
      get() {
        accesses += 1;
        throw Error("Host input accessed before concept denial");
      },
    },
  );
  // No assignment, files or policy path exists. A truthy lease must not bypass denial.
  await assert.rejects(
    renderEmployeeVideo(
      inaccessible,
      { profile: "employee-concept-text" },
      inaccessible,
      inaccessible,
      {},
    ),
    { message: "Concept text profile cannot render media" },
  );
  assert.equal(accesses, 0);
});
