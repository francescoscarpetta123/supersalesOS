import fs from 'fs';
import { accountDir, profilePath } from './paths.js';

export function saveProfile(userId, profile) {
  const dir = accountDir(userId);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const data = {
    email: profile.email ?? null,
    name: profile.name ?? null,
    picture: profile.picture ?? null,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(profilePath(userId), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function loadProfile(userId) {
  if (!userId) return null;
  const p = profilePath(userId);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}
