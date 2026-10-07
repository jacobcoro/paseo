import { createHash } from "node:crypto";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import type { TimelineProjectionEntry } from "./timeline-projection.js";
import type { ConceptCompletionMetadata } from "./providers/claude/concept-completion.js";
// Exact committed canonical association; no last-message or in-memory fallback.
export function selectConceptCommittedCompletion(
  rows: AgentTimelineRow[],
  canonical: TimelineProjectionEntry[],
  epoch: string,
  completion: ConceptCompletionMetadata | null | undefined,
) {
  if (!completion || !epoch || completion.provenance !== "sdk_success_result") return null;
  const finals = rows.filter(
    (row) =>
      row.item.type === "assistant_message" &&
      row.item.messageId === completion.final_message_id &&
      row.turnId === completion.provider_turn_id,
  );
  const inputs = rows.filter(
    (row) =>
      row.item.type === "user_message" &&
      row.item.clientMessageId === completion.client_message_id &&
      row.providerMessageId === completion.input_uuid &&
      row.turnId === completion.provider_turn_id,
  );
  if (finals.length !== 1 || inputs.length !== 1 || finals[0].seq <= inputs[0].seq) return null;
  const final = finals[0];
  if (
    final.item.type !== "assistant_message" ||
    createHash("sha256").update(final.item.text).digest("hex") !== completion.text_sha256 ||
    ![final, inputs[0]].every((row) =>
      canonical.some(
        (current) =>
          current.seqStart === row.seq &&
          current.seqEnd === row.seq &&
          current.turnId === row.turnId &&
          current.providerMessageId === row.providerMessageId &&
          JSON.stringify(current.item) === JSON.stringify(row.item),
      ),
    )
  )
    return null;
  return {
    ...completion,
    epoch,
    cursor: final.seq,
    user_cursor: inputs[0].seq,
    turn_id: final.turnId,
    committed: true,
    provenance: "sdk_success_result" as const,
  };
}

export function selectConceptVisibleFinal(
  rows: AgentTimelineRow[],
  completion: NonNullable<ReturnType<typeof selectConceptCommittedCompletion>>,
) {
  const matches = rows.filter(
    (row) =>
      row.seq === completion.cursor &&
      row.turnId === completion.turn_id &&
      row.item.type === "assistant_message" &&
      row.item.messageId === completion.final_message_id,
  );
  if (matches.length !== 1 || matches[0].item.type !== "assistant_message") return null;
  const text = matches[0].item.text,
    bytes = Buffer.from(text, "utf8");
  if (
    bytes.length > 65536 ||
    bytes.toString("utf8") !== text ||
    createHash("sha256").update(bytes).digest("hex") !== completion.text_sha256
  )
    return null;
  return text;
}
