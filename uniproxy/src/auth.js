import crypto from 'node:crypto';

/**
 * Accounts and password hashes.
 *
 * Each account stores `scrypt$<salt>$<hash>`; the plaintext password never
 * touches the config. `ui.users` holds the accounts created from the panel or
 * the setup wizard. When it is empty we fall back to the legacy single-password
 * keys (`ui.password` / `ui.viewerPassword`) so old configs keep working.
 */

export const USERNAME_RE = /^[A-Za-z0-9_-]{3,32}$/;

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return 'scrypt$' + salt + '$' + hash;
}

export function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  try {
    const calc = crypto.scryptSync(String(password), parts[1], 32);
    const want = Buffer.from(parts[2], 'hex');
    return calc.length === want.length && crypto.timingSafeEqual(calc, want);
  } catch (e) {
    return false;
  }
}

export function accountsOf(raw, legacy) {
  const users = raw && raw.ui && Array.isArray(raw.ui.users) ? raw.ui.users : [];
  if (users.length) {
    return users
      .filter(function (u) { return u && USERNAME_RE.test(String(u.username || '')); })
      .map(function (u) {
        return { username: String(u.username), role: u.role === 'viewer' ? 'viewer' : 'admin', hash: String(u.hash || '') };
      });
  }
  const out = [];
  if (legacy && legacy.admin) out.push({ username: 'admin', role: 'admin', plain: String(legacy.admin) });
  if (legacy && legacy.viewer) out.push({ username: 'viewer', role: 'viewer', plain: String(legacy.viewer) });
  return out;
}
