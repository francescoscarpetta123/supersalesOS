import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.join(__dirname, '..');
export const CLIENT_DIST = path.join(ROOT, 'client', 'dist');
export const DATA_DIR = path.resolve(ROOT, '.data');
export const ACCOUNTS_DIR = path.join(DATA_DIR, 'accounts');

/** Ensures `.data` and `.data/sessions` exist; returns absolute path to the session directory. */
export function ensureSessionDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const dir = path.resolve(DATA_DIR, 'sessions');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function accountDir(userId) {
  return path.join(ACCOUNTS_DIR, userId);
}

export function tokensPath(userId) {
  return path.join(accountDir(userId), 'tokens.json');
}

export function storePath(userId) {
  return path.join(accountDir(userId), 'store.json');
}

export function profilePath(userId) {
  return path.join(accountDir(userId), 'profile.json');
}
