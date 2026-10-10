// Types de scripts/host/config-guard.mjs (Node seul, importé par les essais).
export function readJsonc(text: string): Record<string, any>;
export const HOST_SCRIPT: string;
export const HOST_ROUTE: { pattern: string; zone_name: string };
export const HOST_DO: Array<{ name: string; class_name: string }>;
export const HOST_SECRETS: string[];
export const HOST_ALLOWED_KEYS: string[];
export function hostConfigViolations(config: Record<string, any>): string[];
export function crossBindingViolations(apiToml: string, hostConfig: Record<string, any>): string[];
