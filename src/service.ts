import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execute, getProfile, queryAll, queryOne, transaction, type DbClient, type ProfileRow, type TicketRow } from './db.js';
import { getMasterKey } from './config.js';
import { decryptText, encryptText } from './crypto.js';
import { analyzeCsf, analyzeTicket, type TicketAnalysis, type CsfAnalysis } from './ingest/index.js';
import { saveFile, removeFile, withTemporaryFile } from './storage.js';
import { detectPortal, getPortalDefinition, type PortalDetection } from './portals/index.js';
import { discoverInvoicePortal, type DiscoveryResult } from './discovery/index.js';
import { exploreInvoicePortal, type PortalExploration } from './automation/index.js';
import { validatePortalUrl } from './validation.js';
import { isRegimenCompatible, isRegimenFiscal, isUsoCfdiCompatible, usosCfdi } from './fiscalCatalogs.js';

export interface PublicTicket {
  id: string; fileId: string; analysis: TicketAnalysis; detection: PortalDetection;
  discovery: DiscoveryResult | null; exploration: Omit<PortalExploration, 'screenshot'> | null;
  createdAt: string;
}

async function lockedProfile(tx: DbClient, userId: string): Promise<ProfileRow> {
  const profile = await tx.queryOne<ProfileRow>('SELECT * FROM profiles WHERE user_id=? FOR UPDATE', [userId]);
  if (!profile) throw new Error('Perfil no encontrado');
  return profile;
}

async function releasableCsf(tx: DbClient, userId: string, previousId: string | null,
  nextId: string | null): Promise<string | null> {
  if (!previousId || previousId === nextId) return null;
  // Job creation takes this same profile lock before it snapshots the CSF ID.
  const needed = await tx.queryOne(
    `SELECT 1 FROM jobs WHERE user_id=? AND status IN ('queued','running','needs_action')
      AND JSON_UNQUOTE(JSON_EXTRACT(request_json,'$.csfFileId'))=? LIMIT 1`, [userId, previousId]);
  return needed ? null : previousId;
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

export async function updateProfile(userId: string, values: {
  rfc?: string; nombre?: string; codigoPostal?: string; regimenFiscal?: string;
  usoCfdi?: string; facturaEmail?: string; domicilio?: string; openAiKey?: string;
  smtp?: { host?: string; port?: number; secure?: boolean; user?: string; from?: string; password?: string };
}): Promise<Record<string, unknown>> {
  const { profile, oldCsfId } = await transaction(async tx => {
    const current = await lockedProfile(tx, userId);
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
    if (values.rfc !== undefined || values.regimenFiscal !== undefined || values.usoCfdi !== undefined) {
      if (next.regimenFiscal && !isRegimenFiscal(next.regimenFiscal)) throw new Error('Régimen fiscal fuera del catálogo vigente');
      if (next.usoCfdi && !usosCfdi.some(item => item.codigo === next.usoCfdi)) throw new Error('Uso CFDI fuera del catálogo vigente');
      if (next.rfc && next.regimenFiscal && !isRegimenCompatible(next.regimenFiscal, next.rfc)) {
        throw new Error('El régimen fiscal no corresponde al tipo de persona del RFC');
      }
      if (next.usoCfdi && next.regimenFiscal && !isUsoCfdiCompatible(next.usoCfdi, next.regimenFiscal, next.rfc || undefined)) {
        throw new Error('El uso CFDI no corresponde al régimen fiscal');
      }
    }
    await tx.execute(`UPDATE profiles SET rfc=?,nombre=?,codigo_postal=?,regimen_fiscal=?,uso_cfdi=?,factura_email=?,domicilio=?,csf_file_id=?,openai_key_enc=?,smtp_host=?,smtp_port=?,smtp_secure=?,smtp_user=?,smtp_pass_enc=?,smtp_from=?,updated_at=CURRENT_TIMESTAMP(3) WHERE user_id=?`,
      [next.rfc, next.nombre, next.codigoPostal, next.regimenFiscal, next.usoCfdi,
        next.facturaEmail, next.domicilio, next.csfFileId, next.openAiKeyEnc, next.smtpHost, next.smtpPort,
        next.smtpSecure, next.smtpUser, next.smtpPassEnc, next.smtpFrom, userId]);
    const oldCsfId = await releasableCsf(tx, userId, current.csf_file_id, next.csfFileId);
    return { profile: publicProfile((await lockedProfile(tx, userId))), oldCsfId };
  });
  if (oldCsfId) await removeFile(userId, oldCsfId);
  return profile;
}

async function openAiKey(userId: string): Promise<string | undefined> {
  const stored = (await getProfile(userId)).openai_key_enc;
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
  const file = await saveFile(userId, 'ticket', filename, data);
  const key = await openAiKey(userId);
  let analysis: TicketAnalysis = { text: '', qrUrl: null, empresa: null, folio: null, fecha: null, monto: null, referencia: null, url: null };
  let warning: string | undefined;
  try {
    analysis = await withTemporaryFile(userId, file.id, (filePath, row) => analyzeTicket(filePath, row.mime_type, key));
  } catch {
    warning = 'No se pudo extraer el contenido automáticamente. Revisa el archivo o inténtalo más tarde.';
  }
  let discovery: DiscoveryResult | null = null;
  const detection = detectPortal(analysis);
  const issuer = analysis.empresa || analysis.marca;
  if (detection.provider === 'generic' && issuer && key) {
    try { discovery = await discoverInvoicePortal(issuer, key); }
    catch { warning = 'Ticket guardado, pero no se pudo buscar el portal en este momento.'; }
  }
  const id = randomUUID();
  await execute('INSERT INTO tickets (id,user_id,file_id,analysis_json,discovery_json) VALUES (?,?,?,?,?)',
    [id, userId, file.id, JSON.stringify(analysis), discovery ? JSON.stringify(discovery) : null]);
  const row = (await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=?', [id]))!;
  return { ticket: toPublicTicket(row), ...(warning ? { warning } : {}) };
}

export async function discoverTicket(userId: string, ticketId: string, issuer: string): Promise<PublicTicket> {
  const row = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=? AND user_id=?', [ticketId, userId]);
  if (!row) throw new Error('Ticket no encontrado');
  const key = await openAiKey(userId);
  if (!key) throw new Error('Guarda tu API key de OpenAI para buscar portales automáticamente');
  const cleaned = issuer.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
  if (cleaned.length < 3) throw new Error('Escribe el nombre del emisor del ticket');
  const discovery = await discoverInvoicePortal(cleaned, key);
  const analysis = JSON.parse(row.analysis_json) as TicketAnalysis;
  if (!analysis.empresa) analysis.empresa = cleaned;
  await execute('UPDATE tickets SET analysis_json=?, discovery_json=?, exploration_json=NULL WHERE id=? AND user_id=?',
    [JSON.stringify(analysis), JSON.stringify(discovery), ticketId, userId]);
  return toPublicTicket((await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=?', [ticketId]))!);
}

export async function exploreTicket(userId: string, ticketId: string, requestedUrl?: string): Promise<PublicTicket> {
  const row = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=? AND user_id=?', [ticketId, userId]);
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
    await execute('UPDATE tickets SET exploration_json=? WHERE id=? AND user_id=?',
      [JSON.stringify(exploration), ticketId, userId]);
    return toPublicTicket((await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=?', [ticketId]))!);
  } finally { fs.rmSync(workDir, { recursive: true, force: true }); }
}

export async function saveCsf(userId: string, filename: string, data: Buffer): Promise<{ analysis: CsfAnalysis; profile: Record<string, unknown>; warning?: string }> {
  const file = await saveFile(userId, 'csf', filename, data);
  const key = await openAiKey(userId);
  let analysis: CsfAnalysis = { text: '', rfc: null, nombre: null, codigoPostal: null, regimenFiscal: null, email: null };
  let warning: string | undefined;
  try {
    analysis = await withTemporaryFile(userId, file.id, (filePath, row) => analyzeCsf(filePath, row.mime_type, key));
  } catch {
    warning = 'No se pudo leer la constancia automáticamente. Revisa el archivo o inténtalo más tarde.';
  }
  const detectedRegimen = analysis.regimenFiscal?.match(/\b\d{3}\b/)?.[0] || '';
  let updated: { profile: Record<string, unknown>; oldCsfId: string | null };
  try {
    updated = await transaction(async tx => {
      const current = await lockedProfile(tx, userId);
      if (current.rfc && analysis.rfc && current.rfc !== analysis.rfc) {
        throw new Error('La constancia corresponde a otro RFC. Actualiza el perfil fiscal antes de usarla.');
      }
      const matchedRfc = current.rfc || analysis.rfc || '';
      const regimen = detectedRegimen && isRegimenFiscal(detectedRegimen) &&
        (!matchedRfc || isRegimenCompatible(detectedRegimen, matchedRfc)) ? detectedRegimen : '';
      await tx.execute(`UPDATE profiles SET csf_file_id=?,rfc=?,nombre=?,codigo_postal=?,regimen_fiscal=?,updated_at=CURRENT_TIMESTAMP(3) WHERE user_id=?`,
        [file.id, current.rfc || analysis.rfc || '', current.nombre || analysis.nombre || '',
          current.codigo_postal || analysis.codigoPostal || '', current.regimen_fiscal || regimen, userId]);
      const oldCsfId = await releasableCsf(tx, userId, current.csf_file_id, file.id);
      return { profile: publicProfile((await lockedProfile(tx, userId))), oldCsfId };
    });
  } catch (error) {
    await removeFile(userId, file.id);
    throw error;
  }
  if (updated.oldCsfId) await removeFile(userId, updated.oldCsfId);
  return { analysis, profile: updated.profile, ...(warning ? { warning } : {}) };
}

export async function deleteCsf(userId: string): Promise<Record<string, unknown>> {
  const { profile, oldCsfId } = await transaction(async tx => {
    const current = await lockedProfile(tx, userId);
    await tx.execute('UPDATE profiles SET csf_file_id=NULL,updated_at=CURRENT_TIMESTAMP(3) WHERE user_id=?', [userId]);
    const oldCsfId = await releasableCsf(tx, userId, current.csf_file_id, null);
    return { profile: publicProfile((await lockedProfile(tx, userId))), oldCsfId };
  });
  if (oldCsfId) await removeFile(userId, oldCsfId);
  return profile;
}

export async function listTickets(userId: string): Promise<PublicTicket[]> {
  const rows = await queryAll<TicketRow>('SELECT * FROM tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 100', [userId]);
  return rows.map(toPublicTicket);
}

export async function getTicket(userId: string, ticketId: string): Promise<PublicTicket | null> {
  const row = await queryOne<TicketRow>('SELECT * FROM tickets WHERE id=? AND user_id=?', [ticketId, userId]);
  return row ? toPublicTicket(row) : null;
}
