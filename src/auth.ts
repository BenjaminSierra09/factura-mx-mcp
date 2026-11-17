import type { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'node:crypto';
import { execute, queryOne, transaction, type UserRow } from './db.js';
import { hashPassword, randomToken, sha256, verifyPassword } from './crypto.js';
import { config } from './config.js';

const SESSION_DAYS = 30;

export async function createUser(email: string, password: string): Promise<UserRow> {
  const normalized = email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) || normalized.length > 254) throw new Error('Correo inválido');
  if (password.length < 12 || password.length > 256) throw new Error('La contraseña debe tener entre 12 y 256 caracteres');
  const id = randomUUID();
  const passwordHash = await hashPassword(password);
  await transaction(async tx => {
    await tx.execute('INSERT INTO users (id,email,password_hash) VALUES (?,?,?)', [id, normalized, passwordHash]);
    await tx.execute('INSERT INTO profiles (user_id,factura_email) VALUES (?,?)', [id, normalized]);
  });
  return { id, email: normalized, password_hash: passwordHash };
}

export async function authenticate(email: string, password: string): Promise<UserRow | null> {
  const row = await queryOne<UserRow>('SELECT * FROM users WHERE email=?', [email.trim().toLowerCase()]);
  // Perform a real scrypt check even for unknown users to reduce user enumeration.
  const placeholder = 'scrypt:16384:8:1:AAAAAAAAAAAAAAAAAAAAAA==:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==';
  const valid = await verifyPassword(password, row?.password_hash || placeholder);
  return row && valid ? row : null;
}

export async function createSession(userId: string): Promise<{ token: string; csrfToken: string }> {
  const token = randomToken();
  const csrfToken = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  await execute('INSERT INTO sessions (token_hash,user_id,csrf_token,expires_at) VALUES (?,?,?,?)',
    [sha256(token), userId, csrfToken, expiresAt]);
  return { token, csrfToken };
}

export function setSessionCookie(res: Response, token: string): void {
  const secure = config.publicOrigin.startsWith('https://');
  res.cookie('factura_session', token, {
    httpOnly: true, sameSite: 'strict', secure, path: '/',
    maxAge: SESSION_DAYS * 86400_000,
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie('factura_session', { httpOnly: true, sameSite: 'strict', secure: config.publicOrigin.startsWith('https://'), path: '/' });
}

function cookieValue(req: Request, name: string): string | undefined {
  const cookies = req.headers.cookie?.split(';') || [];
  for (const cookie of cookies) {
    const [rawKey, ...rawValue] = cookie.trim().split('=');
    if (rawKey === name) return rawValue.join('=');
  }
  return undefined;
}

export async function requireSession(req: Request, res: Response, next: NextFunction): Promise<void> {
  const token = cookieValue(req, 'factura_session');
  if (!token) { res.status(401).json({ error: 'Inicia sesión' }); return; }
  const row = await queryOne<{ user_id: string; csrf_token: string; email: string }>(
    `SELECT s.user_id, s.csrf_token, u.email FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`,
    [sha256(token), new Date().toISOString()]);
  if (!row) { res.status(401).json({ error: 'Sesión vencida' }); return; }
  res.locals.userId = row.user_id;
  res.locals.email = row.email;
  res.locals.csrfToken = row.csrf_token;
  res.locals.sessionToken = token;
  next();
}

export function requireCsrf(req: Request, res: Response, next: NextFunction): void {
  const submitted = req.headers['x-csrf-token'];
  if (typeof submitted !== 'string' || submitted !== res.locals.csrfToken) {
    res.status(403).json({ error: 'Token CSRF inválido' }); return;
  }
  next();
}

export function checkOrigin(req: Request, res: Response, next: NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    const expected = config.publicOrigin || `${req.protocol}://${req.headers.host}`;
    if (origin !== expected) { res.status(403).json({ error: 'Origen no permitido' }); return; }
  }
  next();
}

export async function deleteSession(rawToken: string): Promise<void> {
  await execute('DELETE FROM sessions WHERE token_hash=?', [sha256(rawToken)]);
}

export async function createMcpToken(userId: string, name: string): Promise<{ id: string; token: string }> {
  const id = randomUUID();
  const token = `fxmcp_${randomToken()}`;
  await execute('INSERT INTO mcp_tokens (id,user_id,name,token_hash) VALUES (?,?,?,?)', [id, userId, name, sha256(token)]);
  return { id, token };
}

export async function getMcpUser(token: string): Promise<string | null> {
  if (!token.startsWith('fxmcp_')) return null;
  const row = await queryOne<{ id: string; user_id: string }>('SELECT id,user_id FROM mcp_tokens WHERE token_hash=?', [sha256(token)]);
  if (!row) return null;
  await execute('UPDATE mcp_tokens SET last_used_at=CURRENT_TIMESTAMP(3) WHERE id=?', [row.id]);
  return row.user_id;
}
