import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
export function createLimits(config) {
  const windows = new Map();
  const daily = new Map();
  function allow(key, maximum, duration = 60000) {
    const previous = windows.get(key);
    const window =
      previous && previous.until > Date.now()
        ? previous
        : { count: 0, until: Date.now() + duration };
    windows.set(key, window);
    return ++window.count <= maximum;
  }
  function prompt(student) {
    const day = new Date().toISOString().slice(0, 10);
    const key = student.id + ":" + day;
    if (!daily.has(key)) {
      const path = join(config.recordsDir, `${student.id}.requests.jsonl`);
      const lines = existsSync(path)
        ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean)
        : [];
      daily.set(key, lines.filter((line) => JSON.parse(line).receivedAt.startsWith(day)).length);
    }
    if (daily.get(key) >= (config.maxDailyPrompts || 200)) return "Daily prompt limit reached";
    if (!allow("prompt:" + student.id, config.maxPromptsPerMinute || 10))
      return "Please wait before sending another prompt";
    daily.set(key, daily.get(key) + 1);
    return null;
  }
  return { allow, prompt };
}
