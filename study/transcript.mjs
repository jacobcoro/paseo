// A provider restart may return an empty or shorter timeline. Keep the research archive.
export function mergeTranscript(saved, current) {
  const entries = new Map();
  for (const entry of [...saved, ...current]) {
    const key = entry.item.messageId
      ? `${entry.provider}:${entry.item.type}:${entry.item.messageId}`
      : JSON.stringify([
          entry.provider,
          entry.timestamp,
          entry.turnId,
          entry.seqStart,
          entry.item.type,
        ]);
    entries.set(key, entry);
  }
  return [...entries.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
