import fs from 'fs';
import { ACCOUNTS_DIR, accountDir, tokensPath } from './paths.js';

export function listAccountIds() {
  if (!fs.existsSync(ACCOUNTS_DIR)) return [];
  return fs
    .readdirSync(ACCOUNTS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}

export function loadTokens(userId) {
  if (!userId) return null;
  const p = tokensPath(userId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

export function saveTokens(userId, tokens) {
  const dir = accountDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  safeWriteAtomic(tokensPath(userId), JSON.stringify(tokens, null, 2));
}

export function clearTokens(userId) {
  const p = tokensPath(userId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function safeWriteAtomic(file, content) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}
