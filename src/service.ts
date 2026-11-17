import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, getProfile, type ProfileRow, type TicketRow } from './db.js';
import { getMasterKey } from './config.js';
import { decryptText, encryptText } from './crypto.js';
import { analyzeCsf, analyzeTicket, type TicketAnalysis, type CsfAnalysis } from './ingest/index.js';
import { saveFile, removeFile, withTemporaryFile } from './storage.js';
import { detectPortal, getPortalDefinition, type PortalDetection } from './portals/index.js';
import { discoverInvoicePortal, type DiscoveryResult } from './discovery/index.js';
import { exploreInvoicePortal, type PortalExploration } from './automation/index.js';
import { validatePortalUrl } from './validation.js';

export interface PublicTicket {
  id: string; fileId: string; analysis: TicketAnalysis; detection: PortalDetection;
  discovery: DiscoveryResult | null; exploration: Omit<PortalExploration, 'screenshot'> | null;
  createdAt: string;
}

function removeCsfWhenUnused(userId: string, fileId: string | null): void {
  if (!fileId) return;
  const needed = db.prepare(`SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running') AND json_extract(request_json,'$.csfFileId')=? LIMIT 1`).get(userId, fileId);
  if (!needed) removeFile(userId, fileId);
}

export function publicProfile(row: ProfileRow): Record<string, unknown> {
  return {
    rfc: row.rfc, nombre: row.nombre, codigoPostal: row.codigo_postal,
    regimenFiscal: row.regimen_fiscal, usoCfdi: row.uso_cfdi,
    facturaEmail: row.factura_email, domicilio: row.domicilio,
    hasCsf: Boolean(row.csf_file_id), hasOpenAiKey: Boolean(row.openai_key_enc),
    smtp: { host: row.smtp_host, port: row.smtp_port, secure: Boolean(row.smtp_secure),
      user: row.smtp_user, from: row.smtp_from, hasPassword: Boolean(row.smtp_pass_enc) },
  };
}

export function updateProfile(userId: string, values: {
  rfc?: string; nombre?: string; codigoPostal?: string; regimenFiscal?: string;
  usoCfdi?: string; facturaEmail?: string; domicilio?: string; openAiKey?: string;
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; from?: string; password?: string };
}): Record<string, unknown> {
  const current = getProfile(userId);
  const next = {
    rfc: values.rfc ?? current.rfc, nombre: values.nombre ?? current.nombre,
    codigoPostal: values.codigoPostal ?? current.codigo_postal,
    regimenFiscal: values.regimenFiscal ?? current.regimen_fiscal,
    usoCfdi: values.usoCfdi ?? current.uso_cfdi,
    facturaEmail: values.facturaEmail ?? current.factura_email,
    domicilio: values.domicilio ?? current.domicilio,
    csfFileId: values.rfc !== undefined && values.rfc !== current.rfc ? null : current.csf_file_id,
    openAiKeyEnc: values.openAiKey === undefined ? current.openai_key_enc : values.openAiKey ? encryptText(values.openAiKey, getMasterKey(), `${userId}:openai_key`) : null,
    smtpHost: values.smtp?.host ?? current.smtp_host,
    smtpPort: values.smtp?.port ?? current.smtp_port,
    smtpSecure: values.smtp?.secure === undefined ? current.smtp_secure : Number(values.smtp.secure),
    smtpUser: values.smtp?.user ?? current.smtp_user,
    smtpFrom: values.smtp?.from ?? current.smtp_from,
    smtpPassEnc: values.smtp?.password === undefined ? current.smtp_pass_enc : values.smtp.password ? encryptText(values.smtp.password, getMasterKey(), `${userId}:smtp_password`) : null,
  };
  db.prepare(`UPDATE profiles SET rfc=?,nombre=?,codigo_postal=?,regimen_fiscal=?,uso_cfdi=?,factura_email=?,domicilio=?,csf_file_id=?,openai_key_enc=?,smtp_host=?,smtp_port=?,smtp_secure=?,smtp_user=?,smtp_pass_enc=?,smtp_from=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
    .run(next.rfc, next.nombre, next.codigoPostal, next.regimenFiscal, next.usoCfdi,
      next.facturaEmail, next.domicilio, next.csfFileId, next.openAiKeyEnc, next.smtpHost, next.smtpPort,
      next.smtpSecure, next.smtpUser, next.smtpPassEnc, next.smtpFrom, userId);
  if (!next.csfFileId) removeCsfWhenUnused(userId, current.csf_file_id);
  return publicProfile(getProfile(userId));
}

function openAiKey(userId: string): string | undefined {
  const stored = getProfile(userId).openai_key_enc;
  return stored ? decryptText(stored, getMasterKey(), `${userId}:openai_key`) : undefined;
}

function toPublicTicket(row: TicketRow): PublicTicket {
  const analysis = JSON.parse(row.analysis_json) as TicketAnalysis;
  return { id: row.id, fileId: row.file_id, analysis, detection: detectPortal(analysis),
    discovery: row.discovery_json ? JSON.parse(row.discovery_json) as DiscoveryResult : null,
    exploration: row.exploration_json ? JSON.parse(row.exploration_json) as Omit<PortalExploration, 'screenshot'> : null,
    createdAt: row.created_at };
}

export async function createTicket(userId: string, filename: string, data: Buffer): Promise<{ ticket: PublicTicket; warning?: string }> {
  const file = saveFile(userId, 'ticket', filename, data);
  let analysis: TicketAnalysis = { text: '', qrUrl: null, empresa: null, folio: null, fecha: null, monto: null, referencia: null, url: null };
  let warning: string | undefined;
  try {
    analysis = await withTemporaryFile(userId, file.id, (filePath, row) => analyzeTicket(filePath, row.mime_type, openAiKey(userId)));
  } catch {
    warning = 'No se pudo extraer el contenido automáticamente. Revisa el archivo o inténtalo más tarde.';
  }
  let discovery: DiscoveryResult | null = null;
  const detection = detectPortal(analysis);
  const issuer = analysis.empresa || analysis.marca;
  if (detection.provider === 'generic' && issuer && openAiKey(userId)) {
    try { discovery = await discoverInvoicePortal(issuer, openAiKey(userId)!); }
    catch { warning = 'Ticket guardado, pero no se pudo buscar el portal en este momento.'; }
  }
  const id = randomUUID();
  db.prepare('INSERT INTO tickets (id,user_id,file_id,analysis_json,discovery_json) VALUES (?,?,?,?,?)')
    .run(id, userId, file.id, JSON.stringify(analysis), discovery ? JSON.stringify(discovery) : null);
  const row = db.prepare('SELECT * FROM tickets WHERE id=?').get(id) as TicketRow;
  return { ticket: toPublicTicket(row), ...(warning ? { warning } : {}) };
}

export async function discoverTicket(userId: string, ticketId: string, issuer: string): Promise<PublicTicket> {
  const row = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(ticketId, userId) as TicketRow | undefined;
  if (!row) throw new Error('Ticket no encontrado');
  const key = openAiKey(userId);
  if (!key) throw new Error('Guarda tu API key de OpenAI para buscar portales automáticamente');
  const cleaned = issuer.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  if (cleaned.length < 3) throw new Error('Escribe el nombre del emisor del ticket');
  const discovery = await discoverInvoicePortal(cleaned, key);
  const analysis = JSON.parse(row.analysis_json) as TicketAnalysis;
  if (!analysis.empresa) analysis.empresa = cleaned;
  db.prepare('UPDATE tickets SET analysis_json=?, discovery_json=?, exploration_json=NULL WHERE id=? AND user_id=?')
    .run(JSON.stringify(analysis), JSON.stringify(discovery), ticketId, userId);
  return toPublicTicket(db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId) as TicketRow);
}

export async function exploreTicket(userId: string, ticketId: string, requestedUrl?: string): Promise<PublicTicket> {
  const row = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(ticketId, userId) as TicketRow | undefined;
  if (!row) throw new Error('Ticket no encontrado');
  const ticket = toPublicTicket(row);
  const suggested = ticket.discovery?.selected?.url || ticket.detection.portalUrl || ticket.detection.candidateUrl;
  const portalUrl = await validatePortalUrl(requestedUrl || suggested || '');
  const definition = getPortalDefinition(ticket.detection.provider);
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'factura-explore-'));
  try {
    const observed = await exploreInvoicePortal({ portalUrl, outputDir: workDir,
      allowedHosts: [...definition.allowedHosts], browser: { headless: process.env.HEADLESS !== 'false' } });
    const { screenshot: _screenshot, ...exploration } = observed;
    db.prepare('UPDATE tickets SET exploration_json=? WHERE id=? AND user_id=?')
      .run(JSON.stringify(exploration), ticketId, userId);
    return toPublicTicket(db.prepare('SELECT * FROM tickets WHERE id=?').get(ticketId) as TicketRow);
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
}

export async function saveCsf(userId: string, filename: string, data: Buffer): Promise<{ analysis: CsfAnalysis; profile: Record<string, unknown>; warning?: string }> {
  const file = saveFile(userId, 'csf', filename, data);
  let analysis: CsfAnalysis = { text: '', rfc: null, nombre: null, codigoPostal: null, regimenFiscal: null, email: null };
  let warning: string | undefined;
  try {
    analysis = await withTemporaryFile(userId, file.id, (filePath, row) => analyzeCsf(filePath, row.mime_type, openAiKey(userId)));
  } catch {
    warning = 'No se pudo leer la constancia automáticamente. Revisa el archivo o inténtalo más tarde.';
  }
  const current = getProfile(userId);
  if (current.rfc && analysis.rfc && current.rfc !== analysis.rfc) {
    removeFile(userId, file.id);
    throw new Error('La constancia corresponde a otro RFC. Actualiza el perfil fiscal antes de usarla.');
  }
  const regimen = analysis.regimenFiscal?.match(/\b\d{3}\b/)?.[0] || '';
  db.prepare(`UPDATE profiles SET csf_file_id=?,rfc=?,nombre=?,codigo_postal=?,regimen_fiscal=?,updated_at=CURRENT_TIMESTAMP WHERE user_id=?`)
    .run(file.id, current.rfc || analysis.rfc || '', current.nombre || analysis.nombre || '',
      current.codigo_postal || analysis.codigoPostal || '', current.regimen_fiscal || regimen, userId);
  removeCsfWhenUnused(userId, current.csf_file_id);
  return { analysis, profile: publicProfile(getProfile(userId)), ...(warning ? { warning } : {}) };
}

export function deleteCsf(userId: string): Record<string, unknown> {
  const current = getProfile(userId);
  db.prepare('UPDATE profiles SET csf_file_id=NULL,updated_at=CURRENT_TIMESTAMP WHERE user_id=?').run(userId);
  removeCsfWhenUnused(userId, current.csf_file_id);
  return publicProfile(getProfile(userId));
}

export function listTickets(userId: string): PublicTicket[] {
  const rows = db.prepare('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId) as TicketRow[];
  return rows.map(toPublicTicket);
}

export function getTicket(userId: string, ticketId: string): PublicTicket | null {
  const row = db.prepare('SELECT * FROM tickets WHERE id=? AND user_id=?').get(ticketId, userId) as TicketRow | undefined;
  return row ? toPublicTicket(row) : null;
}
