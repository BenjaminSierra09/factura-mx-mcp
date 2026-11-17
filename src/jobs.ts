import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { db, getProfile, type JobRow, type ProfileRow, type TicketRow } from './db.js';
import { getMasterKey } from './config.js';
import { decryptText } from './crypto.js';
import { getFile, saveJobScreenshot } from './storage.js';
import { saveInvoiceArtifact, type SavedDocument } from './documents.js';
import { validatePortalUrl } from './validation.js';
import { runInvoiceAutomation } from './automation/index.js';
import type { HumanActionSession, AutomationResult } from './automation/types.js';
import { detectPortal, getPortalDefinition, type ProviderId } from './portals/index.js';
import type { TicketAnalysis } from './ingest/types.js';
import type { DiscoveryResult } from './discovery/index.js';
import { sendInvoiceEmail, type InvoiceEmailAttachment } from './email/index.js';

const PRIMERA_URL = 'https://www.facturaelectronicagfa.mx/';
const PRIMERA_EMAIL = 'cfdiboletoprimeraplus@flecha-amarilla.com';
const liveSessions = new Map<string, HumanActionSession>();
let active = false;

export function startPendingJobs(): void { queueMicrotask(() => void runNext()); }

export interface JobRequest {
  ticketId: string;
  provider: ProviderId | 'auto';
  portalUrl?: string;
  token?: string;
  ticketData?: Record<string, string | number | null>;
  channel: 'portal' | 'email';
  recipientEmail?: string;
  includeCsf?: boolean;
  operation?: 'issue' | 'recover';
  force?: boolean;
}

interface StoredJobRequest extends JobRequest {
  provider: ProviderId;
  ticketData: Record<string, string | number | null>;
  allowedHosts: string[];
  fiscalSnapshot: { rfc: string; nombre: string; codigoPostal: string; regimenFiscal: string; usoCfdi: string; facturaEmail: string; domicilio: string };
  csfFileId: string | null;
}

export interface PublicJob {
  id: string; ticketId: string; provider: ProviderId; status: string; portalUrl: string;
  result: Record<string, unknown> | null; error: string | null;
  createdAt: string; updatedAt: string;
}

function publicJob(row: JobRow): PublicJob {
  const result = row.result_json ? JSON.parse(row.result_json) as Record<string, unknown> : null;
  if (result) result.retrySafe = isSafeRetry(row);
  const request = JSON.parse(row.request_json) as StoredJobRequest;
  return {
    id: row.id, ticketId: row.ticket_id, provider: request.provider, status: row.status, portalUrl: row.portal_url,
    result,
    error: row.error_text, createdAt: row.created_at, updatedAt: row.updated_at,
  };
}

function isSafeRetry(row: JobRow): boolean {
  if (row.status !== 'needs_action' || liveSessions.has(row.id) ||
      row.error_text?.includes('interrumpido') || !row.result_json) return false;
  const request = JSON.parse(row.request_json) as StoredJobRequest;
  if (request.channel !== 'portal') return false;
  const result = JSON.parse(row.result_json) as { reason?: string; steps?: string[]; documents?: SavedDocument[] };
  if (['invoice_not_downloaded', 'submission_pending'].includes(result.reason || '') ||
      result.documents?.some(document => document.valid)) return false;
  const events = db.prepare('SELECT message FROM job_events WHERE job_id=?').all(row.id) as { message: string }[];
  const actions = [...(result.steps || []), ...events.map(item => item.message)].join('\n');
  return !/emisi[oó]n solicitada|confirmaci[oó]n de env[ií]o manual|hacer clic en.{0,100}\b(?:emitir|generar|facturar|confirmar|solicitar|enviar)\b/i.test(actions);
}

export function getJob(userId: string, jobId: string): PublicJob | null {
  const row = db.prepare('SELECT * FROM jobs WHERE id=? AND user_id=?').get(jobId, userId) as JobRow | undefined;
  return row ? publicJob(row) : null;
}

export function listJobs(userId: string): PublicJob[] {
  const rows = db.prepare('SELECT * FROM jobs WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId) as JobRow[];
  return rows.map(publicJob);
}

export function getJobEvents(userId: string, jobId: string): { kind: string; message: string; createdAt: string }[] {
  const exists = db.prepare('SELECT 1 FROM jobs WHERE id=? AND user_id=?').get(jobId, userId);
  if (!exists) throw new Error('Trabajo no encontrado');
  return (db.prepare('SELECT kind,message,created_at FROM job_events WHERE job_id=? ORDER BY id').all(jobId) as { kind: string; message: string; created_at: string }[])
    .map(event => ({ kind: event.kind, message: event.message, createdAt: event.created_at }));
}

function event(jobId: string, kind: string, message: string): void {
  db.prepare('INSERT INTO job_events (job_id,kind,message) VALUES (?,?,?)').run(jobId, kind, message.slice(0, 1000));
}

function safeJobError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/^(?:El boleto supera el límite de 4 MB|Falta el destinatario revisado|El adjunto tiene un formato no admitido|Configuración SMTP incompleta|Datos fiscales incompletos o inválidos)/.test(message)) {
    return message.slice(0, 300);
  }
  console.error('Error inesperado en facturación', { type: error instanceof Error ? error.name : typeof error });
  return 'No se pudo completar el trámite por un error interno. Revisa la configuración y vuelve a intentarlo.';
}

function setStatus(jobId: string, status: JobRow['status'], error: string | null = null, result?: object): void {
  db.prepare('UPDATE jobs SET status=?, error_text=?, result_json=COALESCE(?,result_json), updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(status, error, result ? JSON.stringify(result) : null, jobId);
}

function validateFiscal(profile: ProfileRow): void {
  if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(profile.rfc) || !profile.nombre || !/^\d{5}$/.test(profile.codigo_postal) || !/^\d{3}$/.test(profile.regimen_fiscal) || !profile.uso_cfdi || !profile.factura_email) {
    throw new Error('Completa y revisa tu perfil fiscal antes de facturar');
  }
}

function normalizeTicketData(analysis: TicketAnalysis, edits?: JobRequest['ticketData']): Record<string, string | number | null> {
  const fields = ['folio', 'fecha', 'monto', 'referencia', 'numeroTicket', 'numeroTienda',
    'fechaVenta', 'horaVenta', 'folioVenta', 'idVenta', 'caja', 'transaccion', 'marca', 'totalSinPropina'] as const;
  const values: Record<string, string | number | null> = Object.create(null) as Record<string, string | number | null>;
  for (const key of fields) {
    const value = analysis[key];
    if (typeof value === 'string' && value.trim()) values[key] = value.trim();
    else if (typeof value === 'number' && Number.isFinite(value)) values[key] = value;
  }
  for (const [key, value] of Object.entries(edits ?? {})) {
    if (!/^[\p{L}\p{N}_ .-]{1,80}$/u.test(key) || ['__proto__', 'prototype', 'constructor'].includes(key.toLowerCase()))
      throw new Error('Nombre de dato del ticket inválido');
    if (value === null) { values[key] = null; continue; }
    if (typeof value === 'number' && Number.isFinite(value)) { values[key] = value; continue; }
    if (typeof value === 'string' && value.length <= 250) { values[key] = value.trim(); continue; }
    throw new Error('Dato del ticket inválido');
  }
  if (Object.keys(values).length > 40) throw new Error('Demasiados campos del ticket');
  return values;
}

export async function createInvoiceJob(userId: string, input: JobRequest): Promise<PublicJob> {
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(input.ticketId, userId) as TicketRow | undefined;
  if (!ticket) throw new Error('Ticket no encontrado');
  const profile = getProfile(userId);
  validateFiscal(profile);
  const analysis = JSON.parse(ticket.analysis_json) as TicketAnalysis;
  const detection = detectPortal(analysis);
  const provider: ProviderId = input.provider === 'auto' ? detection.provider : input.provider;
  const definition = getPortalDefinition(provider);
  const discovery = ticket.discovery_json ? JSON.parse(ticket.discovery_json) as DiscoveryResult : null;
  const ticketData = normalizeTicketData(analysis, input.ticketData);
  if (input.operation === 'recover' && input.channel !== 'portal') throw new Error('La recuperación sólo se realiza en el portal');
  if (input.operation === 'recover' && provider !== 'primera_plus') throw new Error('La recuperación automática por token sólo está configurada para Primera Plus');
  if (input.channel === 'email' && (!profile.smtp_host || !profile.smtp_user || !profile.smtp_pass_enc || !profile.smtp_from)) throw new Error('Configura SMTP en tu perfil para enviar solicitudes por correo');
  if (input.channel === 'email' && provider === 'primera_plus' && !profile.domicilio && !(input.includeCsf && profile.csf_file_id)) throw new Error('Para la solicitud por correo, agrega tu domicilio completo o adjunta tu constancia');
  if (input.channel === 'email' && input.includeCsf && !profile.csf_file_id) throw new Error('No tienes una constancia guardada para adjuntar');
  const recipientEmail = input.recipientEmail?.trim().toLowerCase();
  if (input.channel === 'email' && provider === 'primera_plus' && recipientEmail) throw new Error('El correo de Primera Plus usa un destinatario fijo publicado por el emisor');
  if (input.channel === 'email' && provider !== 'primera_plus' && (!recipientEmail ||
      !/^[^\s@,;<>()]+@[^\s@,;<>()]+\.[^\s@,;<>()]+$/.test(recipientEmail) || recipientEmail.length > 254))
    throw new Error('Indica un único correo del emisor que hayas revisado');
  // A QR can point to any site. Require an official discovery result or an
  // explicit, reviewed URL before sending private fiscal data to a new host.
  let suggestedUrl = definition.portalUrl || discovery?.selected?.url || '';
  if (provider === 'alsea' && typeof ticketData.marca === 'string') {
    const brand = Object.keys(definition.brandEntryUrls || {}).find(name => name.toLowerCase() === ticketData.marca?.toString().toLowerCase());
    if (brand) suggestedUrl = definition.brandEntryUrls?.[brand] || suggestedUrl;
  }
  const portalUrl = input.channel === 'email'
    ? provider === 'primera_plus' ? PRIMERA_URL : `mailto:${recipientEmail}`
    : provider === 'generic' ? await validatePortalUrl(input.portalUrl || suggestedUrl) : await validatePortalUrl(suggestedUrl);
  if (input.channel === 'portal' && definition.automation === 'ai' && !profile.openai_key_enc) throw new Error('Guarda tu API key de OpenAI para explorar y automatizar este portal');
  const brandVariant = provider === 'alsea' && typeof ticketData.marca === 'string'
    ? Object.entries(definition.brandVariants || {}).find(([name]) => name.toLowerCase() === ticketData.marca?.toString().toLowerCase())?.[1] : undefined;
  const required = brandVariant || definition.ticketFields;
  const missing = required.filter(field => field.required && (ticketData[field.key] === null || ticketData[field.key] === undefined || ticketData[field.key] === ''));
  if (input.channel === 'portal' && missing.length) throw new Error(`Completa los datos del ticket: ${missing.map(field => field.label).join(', ')}`);
  const token = input.token?.trim().toUpperCase();
  if (token && !/^[A-Z0-9-]{6,40}$/.test(token)) throw new Error('Token del boleto inválido');
  if (provider === 'primera_plus' && token && !/^[A-Z0-9]{9,25}$/.test(token)) throw new Error('El token de Primera Plus debe tener entre 9 y 25 caracteres alfanuméricos');
  if (input.channel === 'email' && provider === 'primera_plus' && token) throw new Error('El correo automático de Primera Plus es para boletos sin token');
  if (input.operation === 'recover' && !token) throw new Error('Ingresa el token para recuperar el CFDI');
  const existing = db.prepare(`SELECT id,status FROM jobs WHERE user_id=? AND ticket_id=? AND status IN ('queued','running','needs_action','submitted','completed','email_sent') ORDER BY created_at DESC LIMIT 1`)
    .get(userId, input.ticketId) as { id: string; status: string } | undefined;
  const existingRecovery = input.operation === 'recover' ? db.prepare(`SELECT id FROM jobs WHERE user_id=? AND ticket_id=? AND json_extract(request_json,'$.operation')='recover' AND status IN ('queued','running','needs_action') LIMIT 1`)
    .get(userId, input.ticketId) as { id: string } | undefined : undefined;
  if (existingRecovery) throw new Error(`Ya hay una recuperación en curso (${existingRecovery.id})`);
  const canRetry = existing && input.force && isSafeRetry(db.prepare('SELECT * FROM jobs WHERE id=?').get(existing.id) as JobRow);
  if (existing && input.operation !== 'recover' && !canRetry) {
    throw new Error(`Este ticket ya tiene un trabajo activo o enviado (${existing.id}). Revísalo antes de volver a facturar.`);
  }
  const id = randomUUID();
  const request: StoredJobRequest = { ...input, provider, token, portalUrl, recipientEmail, ticketData, allowedHosts: [...definition.allowedHosts],
    fiscalSnapshot: { rfc: profile.rfc, nombre: profile.nombre, codigoPostal: profile.codigo_postal,
      regimenFiscal: profile.regimen_fiscal, usoCfdi: profile.uso_cfdi,
      facturaEmail: profile.factura_email, domicilio: profile.domicilio },
    csfFileId: profile.csf_file_id,
  };
  db.transaction(() => {
    db.prepare('INSERT INTO jobs (id,user_id,ticket_id,portal_url,status,request_json) VALUES (?,?,?,?,?,?)')
      .run(id, userId, input.ticketId, portalUrl, 'queued', JSON.stringify(request));
    event(id, 'queued', 'Trabajo en cola');
    if (canRetry && existing) {
      setStatus(existing.id, 'failed', `Reintentado en el trabajo ${id}; se revisó que el portal no registró una emisión en el historial.`);
      event(existing.id, 'restarted', `El usuario inició un nuevo intento: ${id}`);
    }
  })();
  queueMicrotask(() => void runNext());
  return getJob(userId, id)!;
}

async function runNext(): Promise<void> {
  if (active) return;
  const row = db.prepare("SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as JobRow | undefined;
  if (!row) return;
  // A conditional UPDATE claims the job atomically if another process reads
  // the same queued row. The deployment still uses one app instance because
  // live browser sessions are held in this process.
  const claimed = db.prepare("UPDATE jobs SET status='running', updated_at=CURRENT_TIMESTAMP WHERE id=? AND status='queued'").run(row.id);
  if (claimed.changes !== 1) { queueMicrotask(() => void runNext()); return; }
  active = true;
  try { await runJob(row); }
  catch (error) {
    const message = safeJobError(error);
    setStatus(row.id, 'failed', message);
    event(row.id, 'error', message);
  }
  finally { active = false; queueMicrotask(() => void runNext()); }
}

async function makePortalTicket(workDir: string, ticket: TicketRow, provider: JobRequest['provider'], token?: string): Promise<string[]> {
  const stored = getFile(ticket.user_id, ticket.file_id);
  if (provider === 'primera_plus' && token) return [];
  const original = stored.data;
  let data = original;
  let extension = stored.row.mime_type === 'application/pdf' ? '.pdf'
    : stored.row.mime_type === 'image/png' ? '.png'
    : stored.row.mime_type === 'image/webp' ? '.webp' : '.jpg';
  if (provider === 'primera_plus' && stored.row.mime_type !== 'application/pdf') {
    data = await sharp(original).rotate().resize({ width: 1900, height: 1900, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    for (const quality of [75, 65, 55]) {
      if (data.length <= 3_900_000) break;
      data = await sharp(original).rotate().resize({ width: 1700, height: 1700, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality, mozjpeg: true }).toBuffer();
    }
    extension = '.jpg';
  }
  if (provider === 'primera_plus' && data.length > 4_000_000) throw new Error('El boleto supera el límite de 4 MB del portal; ingresa el token manualmente');
  const filePath = path.join(workDir, `ticket${extension}`);
  fs.writeFileSync(filePath, data, { mode: 0o600 });
  return [filePath];
}

function emailAttachment(userId: string, fileId: string): InvoiceEmailAttachment {
  const file = getFile(userId, fileId);
  const contentType = file.row.mime_type;
  if (!['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(contentType))
    throw new Error('El adjunto tiene un formato no admitido');
  return { filename: file.row.original_name, content: file.data,
    contentType: contentType as InvoiceEmailAttachment['contentType'] };
}

async function sendReviewedEmail(row: JobRow, request: StoredJobRequest, profile: ProfileRow, fixedRecipient?: string): Promise<string> {
  const recipientEmail = fixedRecipient || request.recipientEmail;
  if (!recipientEmail) throw new Error('Falta el destinatario revisado');
  const password = decryptText(profile.smtp_pass_enc!, getMasterKey(), `${row.user_id}:smtp_password`);
  const ticket = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(row.ticket_id, row.user_id) as TicketRow;
  const analysis = JSON.parse(ticket.analysis_json) as TicketAnalysis;
  const issuerName = analysis.empresa || (typeof request.ticketData.marca === 'string' ? request.ticketData.marca : '') ||
    getPortalDefinition(request.provider).label;
  const result = await sendInvoiceEmail({
    recipientEmail,
    issuerName,
    smtp: { host: profile.smtp_host, port: profile.smtp_port, secure: Boolean(profile.smtp_secure),
      user: profile.smtp_user, password, from: profile.smtp_from },
    fiscal: { rfc: profile.rfc, razonSocial: profile.nombre, codigoPostal: profile.codigo_postal,
      regimenFiscal: profile.regimen_fiscal, usoCfdi: profile.uso_cfdi,
      email: profile.factura_email, domicilio: profile.domicilio },
    ticket: emailAttachment(row.user_id, ticket.file_id),
    ...(request.includeCsf && profile.csf_file_id ? { csf: emailAttachment(row.user_id, profile.csf_file_id) } : {}),
  });
  return result.recipientEmail;
}

async function runJob(row: JobRow): Promise<void> {
  const request = JSON.parse(row.request_json) as StoredJobRequest;
  const currentProfile = getProfile(row.user_id);
  const snapshot = request.fiscalSnapshot;
  const profile: ProfileRow = snapshot ? { ...currentProfile, rfc: snapshot.rfc, nombre: snapshot.nombre,
    codigo_postal: snapshot.codigoPostal, regimen_fiscal: snapshot.regimenFiscal,
    uso_cfdi: snapshot.usoCfdi, factura_email: snapshot.facturaEmail, domicilio: snapshot.domicilio,
    csf_file_id: request.csfFileId } : currentProfile;
  setStatus(row.id, 'running');
  event(row.id, 'started', request.channel === 'email' ? 'Preparando correo' : 'Abriendo portal');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factura-job-'));
  fs.chmodSync(workDir, 0o700);
  try {
    if (request.channel === 'email') {
      const recipient = await sendReviewedEmail(row, request, profile,
        request.provider === 'primera_plus' ? PRIMERA_EMAIL : undefined);
      const result = { message: `Solicitud enviada a ${recipient}. La factura queda pendiente de respuesta.`, documents: [] };
      setStatus(row.id, 'email_sent', null, result);
      event(row.id, 'email_sent', result.message);
      return;
    }
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=?').get(row.ticket_id) as TicketRow;
    const ticketFiles = await makePortalTicket(workDir, ticket, request.provider, request.token);
    let csfFile: string | undefined;
    if (request.includeCsf && profile.csf_file_id) {
      const csf = getFile(row.user_id, profile.csf_file_id);
      const ext = csf.row.mime_type === 'application/pdf' ? '.pdf' : csf.row.mime_type === 'image/png' ? '.png' : '.jpg';
      csfFile = path.join(workDir, `constancia${ext}`);
      fs.writeFileSync(csfFile, csf.data, { mode: 0o600 });
    }
    const outputDir = path.join(workDir, 'output');
    fs.mkdirSync(outputDir, { mode: 0o700 });
    const apiKey = profile.openai_key_enc ? decryptText(profile.openai_key_enc, getMasterKey(), `${row.user_id}:openai_key`) : undefined;
    const automation = await runInvoiceAutomation({
      provider: request.provider, portalUrl: row.portal_url, operation: request.operation || 'issue',
      ticketFiles, csfFile, tokens: request.token ? [request.token] : [],
      fiscal: { rfc: profile.rfc, razonSocial: profile.nombre, codigoPostal: profile.codigo_postal,
        regimenFiscal: profile.regimen_fiscal, usoCfdi: profile.uso_cfdi, email: profile.factura_email,
        domicilio: profile.domicilio },
      ticketData: request.ticketData, allowedHosts: request.allowedHosts,
      outputDir, apiKey, humanActionTimeoutMs: 3_600_000,
      browser: { headless: process.env.HEADLESS !== 'false' },
    }, {
      onEvent: emitted => event(row.id, emitted.type, emitted.message),
      onHumanAction: session => { liveSessions.set(row.id, session); setStatus(row.id, 'needs_action'); },
    });
    liveSessions.delete(row.id);
    const documents: SavedDocument[] = [];
    const downloads = automation.downloads.some(item => item.kind === 'pdf' || item.kind === 'xml')
      ? automation.downloads.filter(item => item.kind !== 'zip') : automation.downloads;
    for (const download of downloads) {
      const resolved = path.resolve(download.path);
      if (!resolved.startsWith(workDir + path.sep)) continue;
      try { documents.push(...await saveInvoiceArtifact(row.user_id, download.filename, fs.readFileSync(resolved), profile.rfc)); }
      catch (error) {
        console.error('No se pudo guardar una descarga', { type: error instanceof Error ? error.name : typeof error });
        event(row.id, 'download_error', 'No se pudo guardar una descarga del portal.');
      }
    }
    const lastScreenshot = automation.screenshots.at(-1);
    if (lastScreenshot && path.resolve(lastScreenshot).startsWith(workDir + path.sep) && fs.existsSync(lastScreenshot)) {
      saveJobScreenshot(row.user_id, row.id, fs.readFileSync(lastScreenshot));
    }
    const result = serializeResult(automation, documents);
    const hasInvoice = documents.some(document => document.valid);
    const status = hasInvoice ? 'completed' : automation.status === 'failed' ? 'failed' : automation.status === 'needs_action' ? 'needs_action' : 'submitted';
    setStatus(row.id, status, automation.status === 'failed' ? automation.message : null, result);
    event(row.id, status, result.message);
  } catch (error) {
    const message = safeJobError(error);
    setStatus(row.id, 'failed', message);
    event(row.id, 'error', message);
  } finally {
    liveSessions.delete(row.id);
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

function serializeResult(result: AutomationResult, documents: SavedDocument[]): { message: string; reason?: string; steps: string[]; documents: SavedDocument[]; verification: string } {
  return {
    message: result.message, ...(result.reason ? { reason: result.reason } : {}), steps: result.steps,
    documents, verification: documents.some(document => document.kind === 'xml' && document.valid) ? 'xml_estructura_rfc_uuid' : documents.some(document => document.valid) ? 'pdf_rfc_uuid' : 'sin_cfdi_verificable',
  };
}

export function getLiveSession(userId: string, jobId: string): HumanActionSession | null {
  const row = db.prepare('SELECT 1 FROM jobs WHERE id=? AND user_id=?').get(jobId, userId);
  return row ? liveSessions.get(jobId) ?? null : null;
}

export function continueHumanAction(userId: string, jobId: string, cancel = false): void {
  const session = getLiveSession(userId, jobId);
  if (!session) throw new Error('No hay una sesión de navegador activa');
  liveSessions.delete(jobId);
  if (cancel) { session.cancel(); event(jobId, 'cancelled', 'Acción cancelada'); }
  else { setStatus(jobId, 'running'); session.continue(); event(jobId, 'resumed', 'Continuando automatización'); }
}
