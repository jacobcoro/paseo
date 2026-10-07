// SOURCE_ONLY in-memory storage fixture; no load, directory scan or filesystem read.
import { expect, test, vi } from "vitest";
import { AgentStorage } from "./agent-storage.js";
import { createTestLogger } from "../../test-utils/test-logger.js";
test("exact current cache projection denies unloaded/pending/deleting and copies only owned record", () => {
  const storage = new AgentStorage("/synthetic-never-opened", createTestLogger());
  const load = vi.spyOn(storage, "load");
  const inner = storage as unknown as {
    loaded: boolean;
    cache: Map<string, unknown>;
    pendingWrites: Map<string, Promise<void>>;
    deleting: Set<string>;
  };
  inner.cache.set("owned", { id: "owned", config: { providerOptions: { textOnly: true } } });
  inner.cache.set("foreign", { id: "foreign" });
  expect(storage.getCurrent("owned")).toBeNull();
  inner.loaded = true;
  const observed = storage.getCurrent("owned");
  expect(observed?.id).toBe("owned");
  observed!.id = "changed-copy";
  expect(storage.getCurrent("owned")?.id).toBe("owned");
  inner.pendingWrites.set("owned", Promise.resolve());
  expect(storage.getCurrent("owned")).toBeNull();
  inner.pendingWrites.delete("owned");
  inner.deleting.add("owned");
  expect(storage.getCurrent("owned")).toBeNull();
  expect(load).not.toHaveBeenCalled();
});
