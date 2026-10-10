// Types de scripts/release/journal.mjs (Node seul, importé par les essais).
export type JournalEntry = Record<string, string>;
export const KINDS: readonly string[];
export const DELAY_SECONDS: number;
export const SECURITY_NOTE: string;
export const SEVERITIES: readonly string[];
export function canonical(v: unknown): string;
export function codeHashOf(sumsBytes: Uint8Array | string): string;
export function checkEntry(e: unknown): string[];
export function journalEntry(fields: JournalEntry): JournalEntry;
export function journalLine(entry: JournalEntry): string;
