import { config } from '../config.js';
import { one, many } from '../db/index.js';
import { forbidden } from '../lib/http.js';

const PUBLIC_COLUMNS = 'id, email, name, role, department, avatar_url, created_at';

export function toPublicUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    department: row.department,
    avatarUrl: row.avatar_url ?? null,
  };
}

export function emailDomain(email) {
  return String(email || '').split('@')[1]?.toLowerCase() || '';
}

/**
 * Enforces the college-domain restriction (SPEC.md §10). Works both for Google
 * Workspace accounts — where Google supplies the `hd` claim — and for plain
 * addresses, where the email suffix is all we have. An empty allow-list means
 * no restriction, which is the local-development default.
 */
export function assertAllowedEmail(email, hostedDomain = null) {
  const allowed = config.auth.allowedEmailDomains;
  if (allowed.length === 0) return;
  const domain = emailDomain(email);
  const hd = String(hostedDomain || '').toLowerCase();
  if (allowed.includes(domain) || (hd && allowed.includes(hd))) return;
  throw forbidden(
    `Sign-in is restricted to ${allowed.join(', ')}. The account ${email} is not in an allowed domain.`,
  );
}

/** Role assigned on first sign-in. Existing users keep whatever role they have. */
export function initialRoleFor(email) {
  return config.auth.teacherEmails.includes(String(email).toLowerCase()) ? 'teacher' : 'student';
}

export async function findUserById(id) {
  return one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE id = $1`, [id]);
}

export async function findUserByEmail(email) {
  return one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE lower(email) = lower($1)`, [email]);
}

export async function listUsers({ role } = {}) {
  if (role) return many(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE role = $1 ORDER BY name`, [role]);
  return many(`SELECT ${PUBLIC_COLUMNS} FROM users ORDER BY role, name`);
}

/**
 * Finds or creates the local user for a verified Google profile.
 *
 * A pre-seeded user (created by the roster seed, with no google_sub yet) is
 * claimed on first sign-in by matching email, which keeps their role and
 * enrolments intact.
 */
export async function upsertGoogleUser({ sub, email, name, picture, hd }) {
  assertAllowedEmail(email, hd);

  const bySub = await one(`SELECT ${PUBLIC_COLUMNS} FROM users WHERE google_sub = $1`, [sub]);
  if (bySub) {
    return one(
      `UPDATE users SET name = $2, avatar_url = $3, email = $4, updated_at = now()
       WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [bySub.id, name || bySub.name, picture ?? bySub.avatar_url, email],
    );
  }

  const byEmail = await findUserByEmail(email);
  if (byEmail) {
    return one(
      `UPDATE users SET google_sub = $2, name = $3, avatar_url = $4, updated_at = now()
       WHERE id = $1 RETURNING ${PUBLIC_COLUMNS}`,
      [byEmail.id, sub, name || byEmail.name, picture ?? byEmail.avatar_url],
    );
  }

  return one(
    `INSERT INTO users (google_sub, email, name, role, department, avatar_url)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${PUBLIC_COLUMNS}`,
    [sub, email, name || email.split('@')[0], initialRoleFor(email), config.auth.defaultDepartment, picture ?? null],
  );
}
