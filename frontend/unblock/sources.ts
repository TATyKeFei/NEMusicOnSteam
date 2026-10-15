export const UNBLOCK_SOURCES = ["kuwo", "kugou", "bodian", "bilibili", "bilivideo"] as const;
export type UnblockSource = typeof UNBLOCK_SOURCES[number];
export const DEFAULT_UNBLOCK_SOURCES: UnblockSource[] = ["kuwo", "kugou", "bilivideo"];

export function sanitizeUnblockSources(value: unknown): UnblockSource[] {
  if (!Array.isArray(value)) return [...DEFAULT_UNBLOCK_SOURCES];
  const sources = [...new Set(value.filter((source): source is UnblockSource => UNBLOCK_SOURCES.includes(source)))];
  return sources.length ? sources : [...DEFAULT_UNBLOCK_SOURCES];
}
