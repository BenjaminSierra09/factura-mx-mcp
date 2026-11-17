import express, { type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import { rateLimit, ipKeyGenerator } from 'express-rate-limit';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { config } from './config.js';
import { db, getProfile } from './db.js';
import { createUser, authenticate, createSession, setSessionCookie, clearSessionCookie, requireSession, requireCsrf, checkOrigin, deleteSession, createMcpToken, getMcpUser } from './auth.js';
import { createTicket, deleteCsf, discoverTicket, exploreTicket, getTicket, listTickets, publicProfile, saveCsf, updateProfile } from './service.js';
import { listPortals } from './portals/index.js';
import { createInvoiceJob, continueHumanAction, getJob, getJobEvents, getLiveSession, listJobs, startPendingJobs } from './jobs.js';
import { getFile, getJobScreenshot } from './storage.js';
import { mcpHandler } from './mcp.js';
import { publicInputErrorMessage } from './errors.js';
import { assertRecaptchaConfiguration, recaptchaSiteKey, verifyRecaptchaToken } from './recaptcha.js';
import { fiscalCatalogSource, formasPago, isFormaPago, regimenes, usosCfdi } from './fiscalCatalogs.js';
import { suggestPaymentForm } from './payment.js';
import { autoInvoiceTicket } from './autoInvoice.js';

assertRecaptchaConfiguration();
const app = express();
const publicDir = path.resolve(process.cwd(), 'public');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1 } });

app.disable('x-powered-by');
app.use((req, res, next) => {
  const host = req.headers.host;
  if (!host) { res.status(400).end(); return; }
  let hostname: string;
  try { hostname = new URL(`http://${host}`).hostname.replace(/^\[|\]$/g, '').toLowerCase(); }
  catch { res.status(400).end(); return; }
  if (!config.allowedHosts.includes(hostname)) { res.status(403).end(); return; }
  next();
});
app.use(helmet({ contentSecurityPolicy: {
  directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'", 'https://www.google.com/recaptcha/', 'https://www.gstatic.com/recaptcha/'],
    styleSrc: ["'self'"], imgSrc: ["'self'", 'data:', 'blob:'],
    frameSrc: ['https://www.google.com/recaptcha/', 'https://recaptcha.google.com/recaptcha/'],
    connectSrc: ["'self'", 'https://www.google.com/recaptcha/'], objectSrc: ["'none'"], frameAncestors: ["'none'"] },
} }));
app.use(express.json({ limit: '10mb', strict: true }));

// A generous per-connector ceiling plus a stricter per-email ceiling prevents
// one shared cloudflared IP from limiting all legitimate accounts to 20 attempts.
const authGlobalLimit = rateLimit({ windowMs: 15 * 60_000, limit: 300, standardHeaders: 'draft-8', legacyHeaders: false,
  message: { error: 'Demasiados intentos. Espera unos minutos.' } });
const authEmailLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false,
  keyGenerator: req => {
    const value = req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).email : undefined;
    if (typeof value === 'string') {
      const email = value.trim().toLowerCase();
      if (email && email.length <= 254) return `email:${createHash('sha256').update(email).digest('hex')}`;
    }
    return `ip:${ipKeyGenerator(req.ip || '127.0.0.1')}`;
  },
  message: { error: 'Demasiados intentos para esta cuenta. Espera unos minutos.' },
});

function configuredLimit(name: string, fallback: number, maximum: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= maximum ? parsed : fallback;
}

// These limits are keyed by the authenticated account, not by a shared proxy IP.
// A shared store is required before running multiple API instances.
const userKey = (_req: Request, res: Response): string => String(res.locals.userId);
const intensiveLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: configuredLimit('API_EXPENSIVE_LIMIT', 60, 10_000),
  keyGenerator: userKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Límite de operaciones de facturación alcanzado. Intenta más tarde.' },
});
const actionLimit = rateLimit({
  windowMs: 15 * 60_000,
  limit: configuredLimit('API_ACTION_LIMIT', 240, 10_000),
  keyGenerator: userKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Demasiadas acciones en el navegador. Espera unos minutos.' },
});
// Counts authenticated MCP HTTP requests, including tools/list, not individual tool operations.
const mcpLimit = rateLimit({
  windowMs: 60 * 60_000,
  limit: configuredLimit('API_MCP_LIMIT', 300, 100_000),
  keyGenerator: userKey,
  standardHeaders: 'draft-8',
  legacyHeaders: false,
  message: { error: 'Límite de solicitudes MCP alcanzado. Intenta más tarde.' },
});
const inFlightByUser = new Map<string, number>();
function limitIntensiveConcurrency(_req: Request, res: Response, next: NextFunction): void {
  const userId = String(res.locals.userId);
  const active = inFlightByUser.get(userId) ?? 0;
  if (active >= configuredLimit('API_EXPENSIVE_CONCURRENCY', 2, 10)) {
    res.setHeader('Retry-After', '2');
    res.status(429).json({ error: 'Ya hay operaciones costosas en curso para esta cuenta. Intenta en unos segundos.' });
    return;
  }
  inFlightByUser.set(userId, active + 1);
  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    const remaining = (inFlightByUser.get(userId) ?? 1) - 1;
    if (remaining <= 0) inFlightByUser.delete(userId);
    else inFlightByUser.set(userId, remaining);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

app.get('/healthz', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json({ recaptchaSiteKey, registrationEnabled: process.env.ALLOW_REGISTRATION !== 'false' });
});
app.get('/api/fiscal-catalogs', (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.json({ source: fiscalCatalogSource, regimenes, formasPago, usosCfdi });
});

app.post('/api/fiscal/payment-suggestion', requireSession, checkOrigin, requireCsrf, (req, res) => {
  const { textoAdicional } = z.object({ textoAdicional: z.string().trim().min(1).max(500) }).parse(req.body);
  res.json({ sugerencia: suggestPaymentForm(textoAdicional, 'usuario') });
});

async function requireAuthRecaptcha(token: string | undefined, req: Request, res: Response): Promise<boolean> {
  if (!recaptchaSiteKey) return true;
  const result = await verifyRecaptchaToken(token, req.hostname);
  if (result === 'valid') return true;
  res.status(result === 'unavailable' ? 503 : 403).json({ error: result === 'unavailable'
    ? 'No se pudo verificar reCAPTCHA. Intenta de nuevo en unos momentos.'
    : 'Completa la verificación reCAPTCHA y vuelve a intentarlo.' });
  return false;
}

app.post('/api/auth/register', checkOrigin, authGlobalLimit, authEmailLimit, async (req, res) => {
  if (process.env.ALLOW_REGISTRATION === 'false') { res.status(403).json({ error: 'Registro desactivado' }); return; }
  const input = z.object({ email: z.email(), password: z.string().min(12).max(256), recaptchaToken: z.string().max(4096).optional() }).parse(req.body);
  if (!(await requireAuthRecaptcha(input.recaptchaToken, req, res))) return;
  const user = await createUser(input.email, input.password);
  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  res.status(201).json({ id: user.id, email: user.email, csrfToken: session.csrfToken });
});

app.post('/api/auth/login', checkOrigin, authGlobalLimit, authEmailLimit, async (req, res) => {
  const input = z.object({ email: z.email(), password: z.string(), recaptchaToken: z.string().max(4096).optional() }).parse(req.body);
  if (!(await requireAuthRecaptcha(input.recaptchaToken, req, res))) return;
  const user = await authenticate(input.email, input.password);
  if (!user) { res.status(401).json({ error: 'Correo o contraseña incorrectos' }); return; }
  const session = createSession(user.id);
  setSessionCookie(res, session.token);
  res.json({ id: user.id, email: user.email, csrfToken: session.csrfToken });
});

app.get('/api/me', requireSession, (_req, res) => {
  res.json({ id: res.locals.userId, email: res.locals.email, csrfToken: res.locals.csrfToken });
});

app.post('/api/auth/logout', requireSession, checkOrigin, requireCsrf, (_req, res) => {
  deleteSession(res.locals.sessionToken);
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/profile', requireSession, (_req, res) => res.json(publicProfile(getProfile(res.locals.userId))));

const optionalFiscal = z.object({
  rfc: z.string().trim().toUpperCase().refine(value => value === '' || /^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(value), 'RFC inválido').optional(),
  nombre: z.string().trim().max(250).optional(),
  codigoPostal: z.string().refine(value => value === '' || /^\d{5}$/.test(value), 'Código postal inválido').optional(),
  regimenFiscal: z.string().refine(value => value === '' || /^\d{3}$/.test(value), 'Régimen fiscal inválido').optional(),
  usoCfdi: z.string().trim().toUpperCase().refine(value => value === '' || /^[A-Z0-9]{3}$/.test(value), 'Uso CFDI inválido').optional(),
  facturaEmail: z.string().refine(value => value === '' || z.email().safeParse(value).success, 'Correo inválido').optional(),
  domicilio: z.string().trim().max(500).optional(),
  openAiKey: z.string().max(512).optional(),
  smtp: z.object({ host: z.string().trim().max(253).optional(), port: z.number().int().refine(value => [465,587,2525].includes(value)).optional(),
    secure: z.boolean().optional(), user: z.string().max(254).optional(), from: z.string().refine(value => value === '' || z.email().safeParse(value).success).optional(), password: z.string().max(512).optional() }).optional(),
});

app.put('/api/profile', requireSession, checkOrigin, requireCsrf, (req, res) => {
  const values = optionalFiscal.parse(req.body);
  res.json(updateProfile(res.locals.userId, values));
});

app.post('/api/csf', requireSession, checkOrigin, requireCsrf, intensiveLimit, limitIntensiveConcurrency, upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'Selecciona una constancia' }); return; }
  res.status(201).json(await saveCsf(res.locals.userId, req.file.originalname, req.file.buffer));
});

app.delete('/api/csf', requireSession, checkOrigin, requireCsrf, (_req, res) => {
  res.json(deleteCsf(res.locals.userId));
});

app.post('/api/tickets', requireSession, checkOrigin, requireCsrf, intensiveLimit, limitIntensiveConcurrency, upload.single('file'), async (req, res) => {
  if (!req.file) { res.status(400).json({ error: 'Selecciona un ticket' }); return; }
  res.status(201).json(await createTicket(res.locals.userId, req.file.originalname, req.file.buffer));
});

app.get('/api/tickets', requireSession, (_req, res) => res.json(listTickets(res.locals.userId)));
app.get('/api/portals', requireSession, (_req, res) => res.json(listPortals()));

app.get('/api/tickets/:id', requireSession, (req, res) => {
  const ticket = getTicket(res.locals.userId, String(req.params.id));
  if (!ticket) { res.status(404).json({ error: 'Ticket no encontrado' }); return; }
  res.json(ticket);
});

app.post('/api/tickets/:id/auto-invoice', requireSession, checkOrigin, requireCsrf,
  intensiveLimit, limitIntensiveConcurrency, async (req, res) => {
    const ticketId = String(req.params.id);
    if (!getTicket(res.locals.userId, ticketId)) { res.status(404).json({ error: 'Ticket no encontrado' }); return; }
    const options = z.object({ textoAdicional: z.string().trim().max(500).optional(),
      formaPago: z.string().refine(isFormaPago, 'Forma de pago inválida').optional() }).parse(req.body ?? {});
    res.json(await autoInvoiceTicket(res.locals.userId, ticketId, options));
  });

app.post('/api/tickets/:id/discover', requireSession, checkOrigin, requireCsrf, intensiveLimit, limitIntensiveConcurrency, async (req, res) => {
  const { issuer } = z.object({ issuer: z.string().trim().min(3).max(120) }).parse(req.body);
  res.json(await discoverTicket(res.locals.userId, String(req.params.id), issuer));
});

app.post('/api/tickets/:id/explore', requireSession, checkOrigin, requireCsrf, intensiveLimit, limitIntensiveConcurrency, async (req, res) => {
  const { portalUrl } = z.object({ portalUrl: z.url().optional() }).parse(req.body ?? {});
  res.json(await exploreTicket(res.locals.userId, String(req.params.id), portalUrl));
});

const jobInput = z.object({
  ticketId: z.uuid(), provider: z.enum(['auto','primera_plus','oxxo','alsea','la_comer','generic']).default('auto'),
  portalUrl: z.url().optional(), token: z.string().optional(),
  recipientEmail: z.email().max(254).optional(),
  ticketData: z.record(z.string().min(1).max(80), z.union([z.string().max(250), z.number().finite(), z.null()]))
    .refine(value => Object.keys(value).length <= 40, 'Demasiados campos del ticket').optional(),
  channel: z.enum(['portal','email']).default('portal'), includeCsf: z.boolean().default(false),
  operation: z.enum(['issue','recover']).default('issue'), force: z.boolean().default(false),
});

app.post('/api/jobs', requireSession, checkOrigin, requireCsrf, intensiveLimit, limitIntensiveConcurrency, async (req, res) => {
  const input = jobInput.parse(req.body);
  res.status(201).json(await createInvoiceJob(res.locals.userId, input));
});

app.get('/api/jobs', requireSession, (_req, res) => res.json(listJobs(res.locals.userId)));

app.get('/api/jobs/:id', requireSession, (req, res) => {
  const job = getJob(res.locals.userId, String(req.params.id));
  if (!job) { res.status(404).json({ error: 'Trabajo no encontrado' }); return; }
  res.json({ job, events: getJobEvents(res.locals.userId, job.id) });
});

app.get('/api/jobs/:id/screenshot', requireSession, async (req, res) => {
  const session = getLiveSession(res.locals.userId, String(req.params.id));
  if (!session) { res.status(409).json({ error: 'No hay navegador esperando una acción' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.type('png').send(await session.screenshot());
});

app.get('/api/jobs/:id/last-screenshot', requireSession, (req, res) => {
  const screenshot = getJobScreenshot(res.locals.userId, String(req.params.id));
  if (!screenshot) { res.status(404).json({ error: 'Captura no disponible' }); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.type('png').send(screenshot);
});

app.post('/api/jobs/:id/action', requireSession, checkOrigin, requireCsrf, actionLimit, async (req, res) => {
  const jobId = String(req.params.id);
  const action = z.discriminatedUnion('type', [
    z.object({ type: z.literal('click'), x: z.number().finite(), y: z.number().finite() }),
    z.object({ type: z.literal('type'), text: z.string().max(2000) }),
    z.object({ type: z.literal('press'), key: z.string().max(32) }),
    z.object({ type: z.literal('continue') }), z.object({ type: z.literal('cancel') }),
  ]).parse(req.body);
  const session = getLiveSession(res.locals.userId, jobId);
  if (!session) { res.status(409).json({ error: 'No hay navegador esperando una acción' }); return; }
  if (action.type === 'click') await session.click(action.x, action.y);
  else if (action.type === 'type') await session.type(action.text);
  else if (action.type === 'press') await session.press(action.key);
  else continueHumanAction(res.locals.userId, jobId, action.type === 'cancel');
  res.json({ ok: true });
});

app.get('/api/files/:id', requireSession, (req, res) => {
  const { row, data } = getFile(res.locals.userId, String(req.params.id));
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.original_name)}`);
  res.type(row.mime_type).send(data);
});

app.get('/api/mcp-tokens', requireSession, (_req, res) => {
  const rows = db.prepare('SELECT id,name,created_at,last_used_at FROM mcp_tokens WHERE user_id=? ORDER BY created_at DESC').all(res.locals.userId) as { id: string; name: string; created_at: string; last_used_at: string | null }[];
  res.json(rows.map(row => ({ id: row.id, name: row.name, createdAt: row.created_at, lastUsedAt: row.last_used_at })));
});

app.post('/api/mcp-tokens', requireSession, checkOrigin, requireCsrf, (req, res) => {
  const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(req.body);
  res.status(201).json(createMcpToken(res.locals.userId, name));
});

app.delete('/api/mcp-tokens/:id', requireSession, checkOrigin, requireCsrf, (req, res) => {
  db.prepare('DELETE FROM mcp_tokens WHERE id=? AND user_id=?').run(String(req.params.id), res.locals.userId);
  res.json({ ok: true });
});

const mcpNode = toNodeHandler(mcpHandler, { maxRequestBodySize: 10 * 1024 * 1024 });
app.all('/mcp', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    const expected = config.publicOrigin || `${req.protocol}://${req.headers.host}`;
    if (origin !== expected) { res.status(403).end(); return; }
  }
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : '';
  const userId = getMcpUser(token);
  if (!userId) { res.setHeader('WWW-Authenticate', 'Bearer'); res.status(401).json({ error: 'Token MCP inválido' }); return; }
  res.locals.userId = userId;
  (req as Request & { auth?: { token: string; clientId: string; scopes: string[] } }).auth = { token, clientId: userId, scopes: ['invoice:read','invoice:write'] };
  next();
}, mcpLimit, (req, res, next) => {
  void mcpNode(req, res, req.body).catch(next);
});

app.use(express.static(publicDir, { index: 'index.html', extensions: ['html'] }));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
app.use((_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) { next(error); return; }
  if (error instanceof multer.MulterError) { res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'El archivo supera 15 MB' : error.message }); return; }
  if (error instanceof z.ZodError) { res.status(400).json({ error: error.issues.map(issue => issue.message).join('; ') }); return; }
  const bodyErrorType = error && typeof error === 'object' && 'type' in error ? error.type : undefined;
  if (bodyErrorType === 'entity.parse.failed' || bodyErrorType === 'request.aborted') {
    res.status(400).json({ error: 'Solicitud JSON inválida o incompleta' }); return;
  }
  if (bodyErrorType === 'entity.too.large') { res.status(413).json({ error: 'Solicitud demasiado grande' }); return; }
  if (bodyErrorType === 'encoding.unsupported' || bodyErrorType === 'charset.unsupported') {
    res.status(415).json({ error: 'Codificación de solicitud no admitida' }); return;
  }
  const message = error instanceof Error ? error.message : 'Error inesperado';
  if (message.includes('UNIQUE constraint failed: users.email')) {
    res.status(409).json({ error: 'El correo ya está registrado' });
    return;
  }
  const inputMessage = publicInputErrorMessage(error);
  if (inputMessage) {
    res.status(400).json({ error: inputMessage });
    return;
  }
  console.error('Error inesperado en API', { type: error instanceof Error ? error.name : typeof error, route: req.route?.path || 'unknown' });
  res.status(500).json({ error: 'Error interno. Intenta más tarde.' });
});

app.listen(config.port, config.host, () => {
  console.log(`Factura MX en http://${config.host}:${config.port}`);
  startPendingJobs();
});
