import type { ProviderRuntimeSettings } from "../../provider-launch-config.js";
import type { ClaudeOptions } from "./query.js";

function record(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return undefined;
}

const owns = (value: Record<string, unknown> | undefined, key: string): boolean =>
  value !== undefined && Object.hasOwn(value, key);

// Recognize malformed seals too: corruption must never select ordinary behavior.
export function hasClaudeTextOnlySeal(value: unknown): boolean {
  const config = record(value);
  return owns(config, "claudeTextOnly") || owns(record(config?.providerOptions), "textOnly");
}

function emptyRecord(value: unknown): boolean {
  const object = record(value);
  return value === undefined || (object !== undefined && Object.keys(object).length === 0);
}

export function assertClaudeTextOnlyConfig(value: unknown, sealed = false): boolean {
  if (!sealed && !hasClaudeTextOnlySeal(value)) return false;
  const config = record(value);
  const knownFields = new Set([
    "provider",
    "cwd",
    "modeId",
    "model",
    "thinkingOptionId",
    "featureValues",
    "title",
    "providerOptions",
    "toolPolicy",
    "systemPrompt",
    "mcpServers",
    "internal",
    "daemonAppendSystemPrompt",
    "claudeTextOnly",
  ]);
  const knownConfig =
    config !== undefined && Object.keys(config).every((key) => knownFields.has(key));
  const options = record(config?.providerOptions);
  const validOptions = options?.textOnly === true && Object.keys(options).length === 1;
  const validMetadata = !owns(config, "claudeTextOnly") || config?.claudeTextOnly === true;
  const emptyMcp = emptyRecord(config?.mcpServers);
  if (
    config?.provider !== "claude" ||
    !knownConfig ||
    !validOptions ||
    !validMetadata ||
    !emptyMcp ||
    config.toolPolicy !== undefined ||
    config.internal === true
  ) {
    throw new Error("Claude text-only restriction is invalid or was changed");
  }
  return true;
}

export function assertClaudeTextOnlyTransition(previous: unknown, next: unknown): void {
  const sealed = assertClaudeTextOnlyConfig(previous);
  assertClaudeTextOnlyConfig(next, sealed);
}

export function assertClaudeTextOnlyRuntime(settings?: ProviderRuntimeSettings): void {
  const command = settings?.command;
  const defaultCommand =
    command === undefined || (command.mode === "default" && Object.keys(command).length === 1);
  if (!defaultCommand) throw new Error("Claude text-only requires the default provider command");
}

// Fixed SDK controls, never caller flags and never employee admission evidence.
export function claudeTextOnlyOptions(): Partial<ClaudeOptions> {
  return {
    tools: [],
    disallowedTools: ["*"],
    settingSources: [],
    mcpServers: {},
    strictMcpConfig: true,
    additionalDirectories: [],
    agents: {},
    plugins: [],
    settings: { disableAllHooks: true, autoMemoryEnabled: false },
    hooks: {},
    enableFileCheckpointing: false,
    extraArgs: { "disable-slash-commands": null },
    canUseTool: async () => ({ behavior: "deny", message: "Claude text-only has no tools" }),
  };
}

export function assertClaudeTextOnlyPrompt(prompt: unknown): void {
  if (typeof prompt !== "string" || prompt.trimStart().startsWith("/")) {
    throw new Error("Claude text-only accepts text without slash commands or attachments");
  }
}
