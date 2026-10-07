import { ConceptCompletion } from "./concept-completion.js";
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";

const catalogNames = ["tools", "mcp_servers", "plugins", "slash_commands", "skills"] as const;
const scalar = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= 2048 ? v : null;

function catalog(value: unknown, name: string): { status: string; raw: unknown } {
  if (value === undefined) return { status: "unknown", raw: null };
  if (!Array.isArray(value) || value.length > 128) return { status: "malformed", raw: null };
  const keys = name === "mcp_servers" ? ["name", "status"] : ["name", "path", "version"];
  const raw = value.map((item: unknown) => {
    if (["tools", "slash_commands", "skills"].includes(name)) return scalar(item);
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    return Object.fromEntries(
      keys
        .filter((key) => Object.hasOwn(item, key))
        .map((key) => [key, scalar((item as Record<string, unknown>)[key])]),
    );
  });
  if (
    raw.some(
      (item) =>
        item === null ||
        (typeof item === "object" &&
          (Object.keys(item).length === 0 || Object.values(item).some((v) => v === null))),
    )
  )
    return { status: "malformed", raw: null };
  return { status: "observed", raw };
}

// Only SDK control values are exposed. Unknown flags/values, prompts and env stay out.
export function safeClaudeSpawn(command: string, args: string[]) {
  const controls: Record<string, string | boolean> = {};
  const enums: Record<string, string[]> = {
    "--input-format": ["stream-json"],
    "--output-format": ["stream-json"],
    "--permission-mode": ["default", "dontAsk", "plan", "acceptEdits", "bypassPermissions", "auto"],
    "--tools": ["", "[]"],
    "--disallowedTools": ["*"],
    "--setting-sources": [""],
    "--settings": ['{"disableAllHooks":true,"autoMemoryEnabled":false}'],
    "--mcp-config": ['{"mcpServers":{}}'],
  };
  let redacted = 0;
  for (let i = 0; i < Math.min(args.length, 256); i++) {
    const flag = args[i];
    if (["--strict-mcp-config", "--disable-slash-commands"].includes(flag)) controls[flag] = true;
    else if (enums[flag]?.includes(args[i + 1])) controls[flag] = args[++i];
    else redacted++;
  }
  return {
    command: scalar(command),
    controls,
    redacted_arguments: redacted,
    truncated: args.length > 256,
  };
}

// A passive provider observation, never a security attestation. No native calls here.
export class ConceptObservation {
  readonly sessionIncarnation = randomUUID();
  readonly completion = new ConceptCompletion();
  private generation: string | null = null;
  private child: ChildProcess | null = null;
  private pending = new Set<string>();
  private active: boolean | null = null;
  private terminal: boolean | null = null;
  private spawn: Record<string, unknown> | null = null;
  private init: Record<string, unknown> | null = null;
  private changed = Date.now();
  beginQuery(): string {
    this.invalidate();
    this.generation = randomUUID();
    this.completion.resetQuery();
    this.changed = Date.now();
    return this.generation;
  }
  isCurrent(generation: string): boolean {
    return generation === this.generation;
  }
  spawned(generation: string, child: ChildProcess, command: string, args: string[]): void {
    if (!this.isCurrent(generation)) return;
    this.child = child;
    this.spawn = {
      ...safeClaudeSpawn(command, args),
      pid: child.pid ?? null,
      child_incarnation: randomUUID(),
      observed_ms: Date.now(),
      source_module: import.meta.url,
    };
    this.init = null;
    this.active = null;
    this.terminal = null;
    child.once("exit", () => {
      if (this.child === child) this.invalidate();
    });
    this.changed = Date.now();
  }
  initialized(message: Record<string, unknown>): void {
    if (!this.generation || !this.spawn) return;
    const native = scalar(message.session_id),
      model = scalar(message.model);
    if (!native || !model) {
      this.init = null;
      return;
    }
    if (this.init && this.init.native_session_id !== native) {
      this.invalidate();
      return;
    }
    this.init = {
      native_session_id: native,
      model,
      mode: scalar(message.permissionMode),
      catalogs: Object.fromEntries(
        catalogNames.map((name) => [name, catalog(message[name], name)]),
      ),
      observed_ms: Date.now(),
    };
    this.changed = Date.now();
  }
  delivered(uuid: string | undefined, client?: string, turn?: string): void {
    if (!this.generation) return;
    this.completion.begin(uuid, client, turn, this.generation);
    this.pending.add(uuid ?? randomUUID());
    this.active = true;
    this.terminal = false;
    this.changed = Date.now();
  }
  message(generation: string, message: Record<string, unknown>): void {
    if (!this.isCurrent(generation) || !this.init) return;
    if (
      typeof message.session_id === "string" &&
      message.session_id !== this.init.native_session_id
    ) {
      this.invalidate();
      return;
    }
    if (message.type === "user" && typeof message.uuid === "string")
      this.pending.delete(message.uuid);
    if (message.type === "result") {
      this.terminal = this.pending.size === 0;
      this.active = this.pending.size > 0;
    } else if (["assistant", "stream_event", "tool_progress"].includes(String(message.type))) {
      this.active = true;
      this.terminal = false;
    }
    this.changed = Date.now();
  }
  observeCompletion(message: Record<string, unknown>, turn: string | null) {
    return this.generation
      ? this.completion.observe(
          this.generation,
          (this.init?.native_session_id as string) ?? null,
          message,
          turn,
        )
      : null;
  }
  invalidate(): void {
    this.completion.invalidate();
    this.generation = null;
    this.child = null;
    this.spawn = null;
    this.init = null;
    this.pending.clear();
    this.active = null;
    this.terminal = null;
    this.changed = Date.now();
  }
  snapshot() {
    return structuredClone({
      schema: 1,
      session_incarnation: this.sessionIncarnation,
      query_incarnation: this.generation,
      spawn: this.spawn,
      init: this.init,
      completion: this.completion.snapshot(),
      delivery: { pending: this.pending.size, active: this.active, terminal: this.terminal },
      changed_ms: this.changed,
      observed_ms: Date.now(),
    });
  }
}
