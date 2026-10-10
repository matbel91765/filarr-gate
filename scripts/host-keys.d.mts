// Types de scripts/host-keys.mjs (Node seul, importé par les essais).
export interface HostKeyEntry {
  id: string;
  encPublicKey: string;
  signPublicKey: string;
  notBefore: string;
  notAfter: string;
}
export const SCRIPT_NAME: string;
export const KEYS_FILE: string;
export function generateHostKeys(input: { id: string; notBefore: string; notAfter: string }): { entry: HostKeyEntry; secrets: { enc: string; sig: string } };
export function wranglerSecretPut(name: string, value: string, opts?: { config?: string }): Promise<void>;
export function main(
  argv: string[],
  io?: { putSecret?: (name: string, value: string) => Promise<void>; log?: (line: string) => void; keysFile?: string; now?: number }
): Promise<{ entry: HostKeyEntry; names: { enc: string; sig: string } }>;
