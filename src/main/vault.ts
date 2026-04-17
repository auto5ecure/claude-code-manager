/**
 * ClaudeMC Vault — Encrypted credential store
 *
 * Uses Electron safeStorage (→ macOS Keychain, single app-scoped entry).
 * Encrypted blobs are stored in ~/.claude/vault.enc.json (mode 0600).
 *
 * Claude CLI subprocesses CANNOT access safeStorage — it is Electron
 * main-process only. Plaintext credentials are never written to disk.
 *
 * Key naming convention:
 *   mail:{accountId}:password
 *   mail:{accountId}:oauth2:accessToken
 *   mail:{accountId}:oauth2:refreshToken
 *   deploy:{projectId}:sshPassphrase   (future)
 */

import { safeStorage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const VAULT_PATH = path.join(os.homedir(), '.claude', 'vault.enc.json');

type VaultData = Record<string, string>; // key → base64(encrypted)

let cache: VaultData | null = null;

function load(): VaultData {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(VAULT_PATH, 'utf8');
    cache = JSON.parse(raw) as VaultData;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(data: VaultData): void {
  const dir = path.dirname(VAULT_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(VAULT_PATH, JSON.stringify(data, null, 2), { mode: 0o600 });
  cache = data;
}

export function vaultAvailable(): boolean {
  try { return safeStorage.isEncryptionAvailable(); } catch { return false; }
}

export function vaultSet(key: string, value: string): void {
  if (!value) { vaultDelete(key); return; }
  if (!vaultAvailable()) throw new Error('ClaudeMC Vault: safeStorage not available');
  const encrypted = safeStorage.encryptString(value).toString('base64');
  const data = load();
  data[key] = encrypted;
  persist(data);
}

export function vaultGet(key: string): string | null {
  if (!vaultAvailable()) return null;
  const data = load();
  const blob = data[key];
  if (!blob) return null;
  try {
    return safeStorage.decryptString(Buffer.from(blob, 'base64'));
  } catch {
    console.error(`[vault] Failed to decrypt key "${key}"`);
    return null;
  }
}

export function vaultHas(key: string): boolean {
  return key in load();
}

export function vaultDelete(key: string): void {
  const data = load();
  if (key in data) {
    delete data[key];
    persist(data);
  }
}

/** Delete all vault entries whose key starts with prefix */
export function vaultDeletePrefix(prefix: string): void {
  const data = load();
  let changed = false;
  for (const key of Object.keys(data)) {
    if (key.startsWith(prefix)) { delete data[key]; changed = true; }
  }
  if (changed) persist(data);
}

/** One-time migration: move plaintext value to vault, return sentinel */
export const VAULT_SENTINEL = '__vault__';

export function migrateToVault(key: string, plaintext: string | undefined): string {
  if (!plaintext || plaintext === VAULT_SENTINEL || plaintext === '') return plaintext ?? '';
  try {
    vaultSet(key, plaintext);
    return VAULT_SENTINEL;
  } catch (err) {
    console.warn(`[vault] Migration failed for "${key}":`, (err as Error).message);
    return plaintext; // keep as-is if vault unavailable
  }
}
