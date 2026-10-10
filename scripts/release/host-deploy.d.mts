// Types de scripts/release/host-deploy.mjs (Node seul, importé par les essais).
export type JournalRecord = Record<string, string>;
export type DeployDecision =
  | { ok: true; entry: JournalRecord; securityRefused?: string }
  | { ok: false; refused: 'not-published' | 'code-hash' | 'seven-days'; detail: string; securityRefused?: string };
export function readJournal(text: string): JournalRecord[];
export function lastDeployed(entries: JournalRecord[]): JournalRecord | null;
export function journalSeverity(raw: unknown): string | null;
export function decide(input: {
  entries: JournalRecord[];
  tag: string;
  codeHash: string;
  kind: string;
  advisory?: string;
  severity?: string;
  ancestor: boolean;
  now: number;
}): DeployDecision;
