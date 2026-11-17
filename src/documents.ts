import { XMLParser } from 'fast-xml-parser';
import { unzipSync } from 'fflate';
import path from 'node:path';
import { saveFile } from './storage.js';
import { extractPdf } from './ingest/read.js';

export interface SavedDocument {
  fileId: string;
  filename: string;
  kind: 'pdf' | 'xml';
  valid: boolean;
  uuid?: string;
  receptorRfc?: string;
}

function findNode(value: unknown, suffix: string): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  for (const [key, child] of Object.entries(value)) {
    if (key.split(':').at(-1) === suffix && child && typeof child === 'object' && !Array.isArray(child)) return child as Record<string, unknown>;
    const nested = findNode(child, suffix);
    if (nested) return nested;
  }
  return null;
}

export function inspectCfdiXml(data: Buffer, expectedRfc: string): { valid: boolean; uuid?: string; receptorRfc?: string } {
  if (data.length > 15 * 1024 * 1024) return { valid: false };
  try {
    const parsed = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', processEntities: false }).parse(data.toString('utf8'));
    const comprobante = findNode(parsed, 'Comprobante');
    const receptor = findNode(comprobante, 'Receptor');
    const timbre = findNode(comprobante, 'TimbreFiscalDigital');
    const receptorRfc = String(receptor?.['@_Rfc'] ?? receptor?.['@_rfc'] ?? '').toUpperCase();
    const uuid = String(timbre?.['@_UUID'] ?? timbre?.['@_Uuid'] ?? '').toUpperCase();
    const valid = Boolean(comprobante && comprobante['@_Version'] === '4.0' && receptorRfc === expectedRfc.toUpperCase() &&
      /^[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}$/.test(uuid) && String(timbre?.['@_SelloSAT'] ?? '').length > 20);
    return { valid, ...(uuid ? { uuid } : {}), ...(receptorRfc ? { receptorRfc } : {}) };
  } catch { return { valid: false }; }
}

export async function saveInvoiceArtifact(userId: string, filename: string, data: Buffer, expectedRfc: string): Promise<SavedDocument[]> {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.zip') || data.subarray(0, 4).equals(Buffer.from([0x50,0x4b,0x03,0x04]))) {
    let count = 0;
    let total = 0;
    const entries = unzipSync(data, { filter: info => {
      if (count >= 10 || info.originalSize > 15 * 1024 * 1024 || total + info.originalSize > 30 * 1024 * 1024) return false;
      if (!/\.(xml|pdf)$/i.test(info.name)) return false;
      count += 1; total += info.originalSize; return true;
    }});
    const documents: SavedDocument[] = [];
    for (const [name, content] of Object.entries(entries)) documents.push(...await saveInvoiceArtifact(userId, path.basename(name), Buffer.from(content), expectedRfc));
    return documents;
  }
  if (lower.endsWith('.pdf') && data.subarray(0, 4).toString() === '%PDF') {
    let uuid: string | undefined;
    let valid = false;
    try {
      const { text } = await extractPdf(data);
      uuid = text.toUpperCase().match(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/)?.[0];
      valid = Boolean(uuid && text.toUpperCase().includes(expectedRfc.toUpperCase()) && /(?:FOLIO\s+FISCAL|UUID|TIMBRE\s+FISCAL)/i.test(text));
    } catch { /* Store the PDF, but do not call it a verified CFDI. */ }
    const row = saveFile(userId, 'invoice_pdf', filename, data);
    return [{ fileId: row.id, filename: row.original_name, kind: 'pdf', valid, ...(uuid ? { uuid } : {}) }];
  }
  if (lower.endsWith('.xml') && data.toString('utf8', 0, 1000).includes('<')) {
    const inspected = inspectCfdiXml(data, expectedRfc);
    const row = saveFile(userId, 'invoice_xml', filename, data);
    return [{ fileId: row.id, filename: row.original_name, kind: 'xml', valid: inspected.valid, uuid: inspected.uuid, receptorRfc: inspected.receptorRfc }];
  }
  return [];
}
