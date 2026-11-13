// Hermes creates a Java ICU Collator for each String.localeCompare call.
// Workspace update bursts sort the same labels repeatedly; keep the native objects reusable.
const textCollator = new Intl.Collator();
const naturalNameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

export function compareLocalizedText(left: string, right: string): number {
  return textCollator.compare(left, right);
}

export function compareNaturalNames(left: string, right: string): number {
  return naturalNameCollator.compare(left, right);
}
