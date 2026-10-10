// Types de scripts/release/tag-check.mjs (Node seul, importé par les essais).
export interface Signer {
  principal: string;
  role: 'release' | 'security';
  name: string;
  keyB64: string;
  publicKey: Buffer;
}
export type TagRefusal = 'tag-name' | 'signers' | 'unsigned' | 'tag-mismatch' | 'not-commit' | 'signature-invalid' | 'signer-unknown';
export type SecurityRefusal = 'role' | 'kind-line-missing' | 'advisory-line-missing' | 'advisory-format' | 'advisory-unknown';
export type TagCheck =
  | { ok: false; tag: string; refused: TagRefusal; detail: string }
  | {
      ok: true;
      tag: string;
      version: string;
      commit: string;
      principal: string;
      role: 'release' | 'security';
      kind: 'release' | 'security';
      security?: { advisory?: string; refused?: SecurityRefusal };
    };
export const ROLES: readonly string[];
export const NAMESPACE: string;
export const KIND_TRAILER: string;
export const ADVISORY_TRAILER: string;
export const TAG_NAME: RegExp;
export const ADVISORY_ID: RegExp;
export function ed25519FromBlob(blob: Buffer): Buffer;
export function parseSigners(text: string): Signer[];
export function splitSignedTag(raw: string): { payload: string; armored: string } | null;
export function parseTagObject(payload: string): { object?: string; type?: string; tag?: string; tagger?: string; message: string };
export function verifySshSignature(armored: string, message: string, namespace?: string): { publicKey: Buffer; keyB64: string; hashAlg: string };
export function trailers(message: string): Array<[string, string]>;
export function checkTag(input: {
  tag: string;
  raw: string;
  signers: string;
  advisoryExists: (id: string) => Promise<boolean> | boolean;
}): Promise<TagCheck>;
export function githubAdvisoryExists(id: string, opts?: { repository?: string; token?: string }): Promise<boolean>;
