// Passive single foreground request correlation. Metadata only; never approval.
import { createHash } from "node:crypto";
export interface ConceptCompletionMetadata {
  client_message_id: string;
  input_uuid: string;
  provider_turn_id: string;
  query_incarnation: string;
  native_session_id: string;
  result_uuid: string;
  result_subtype: "success";
  is_error: false;
  final_message_id: string;
  text_sha256: string;
  provenance: "sdk_success_result";
}
export class ConceptCompletion {
  private request: {
    client: string;
    uuid: string;
    turn: string;
    query: string;
    echoed: boolean;
  } | null = null;
  private ambiguous = false;
  private usedQuery: string | null = null;
  resetQuery() {
    this.invalidate();
    this.usedQuery = null;
  }
  private result: ConceptCompletionMetadata | null = null;
  begin(
    uuid: string | undefined,
    client: string | undefined,
    turn: string | undefined,
    query: string,
  ) {
    if (!uuid || !client || !turn || this.usedQuery === query) {
      this.invalidate();
      this.ambiguous = true;
      return;
    }
    this.usedQuery = query;
    this.request = { client, uuid, turn, query, echoed: false };
    this.result = null;
    this.ambiguous = false;
  }
  invalidate() {
    this.request = null;
    this.result = null;
    this.ambiguous = true;
  }
  observe(
    query: string,
    native: string | null,
    message: Record<string, unknown>,
    turn: string | null,
  ) {
    const r = this.request;
    if (!r || this.ambiguous || !native || r.query !== query || r.turn !== turn) return null;
    if (message.session_id !== native || message.parent_tool_use_id || message.isReplay === true) {
      this.invalidate();
      return null;
    }
    if (message.type === "user") {
      if (message.uuid !== r.uuid) {
        this.invalidate();
        return null;
      }
      r.echoed = true;
      return null;
    }
    if (message.type !== "result") return null;
    if (!r.echoed || this.result || !successfulResult(message)) {
      this.invalidate();
      return null;
    }
    this.result = {
      client_message_id: r.client,
      input_uuid: r.uuid,
      provider_turn_id: r.turn,
      query_incarnation: query,
      native_session_id: native,
      result_uuid: message.uuid as string,
      result_subtype: "success",
      is_error: false,
      final_message_id: message.uuid as string,
      text_sha256: createHash("sha256")
        .update(message.result as string)
        .digest("hex"),
      provenance: "sdk_success_result",
    };
    return { metadata: structuredClone(this.result), text: message.result as string };
  }
  verifiedEcho() {
    const r = this.request;
    return r?.echoed && !this.ambiguous
      ? { client_message_id: r.client, input_uuid: r.uuid, provider_turn_id: r.turn }
      : null;
  }
  snapshot() {
    return this.result ? structuredClone(this.result) : null;
  }
}

function successfulResult(message: Record<string, unknown>) {
  return (
    message.subtype === "success" &&
    message.is_error === false &&
    typeof message.uuid === "string" &&
    Boolean(message.uuid) &&
    typeof message.result === "string" &&
    Boolean(message.result) &&
    Buffer.byteLength(message.result as string) <= 1048576
  );
}
