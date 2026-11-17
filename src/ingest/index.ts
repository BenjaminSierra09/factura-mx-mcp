import { mergeCsf, mergeTicket, parseCsfText, parseTicketText } from './parse.js';
import { extractPdf, extractQrFromImage, readSupportedFile } from './read.js';
import { readCsfWithVision, readTicketWithVision } from './vision.js';
import type { CsfAnalysis, TicketAnalysis } from './types.js';

export type { CsfAnalysis, TicketAnalysis } from './types.js';

export async function analyzeTicket(filePath: string, mimeType: string, openAiApiKey?: string): Promise<TicketAnalysis> {
  const file = await readSupportedFile(filePath, mimeType);
  const local = file.mimeType === 'application/pdf'
    ? await extractPdf(file.buffer)
    : { text: '', qrData: await extractQrFromImage(file.buffer) };
  const result = parseTicketText(local.text, local.qrData);
  if (!openAiApiKey) return result;
  if (file.mimeType === 'application/pdf' && result.empresa && result.folio && result.fecha && result.monto !== null) return result;
  return mergeTicket(result, await readTicketWithVision(file.buffer, file.mimeType, openAiApiKey));
}

export async function analyzeCsf(filePath: string, mimeType: string, openAiApiKey?: string): Promise<CsfAnalysis> {
  const file = await readSupportedFile(filePath, mimeType);
  const local = file.mimeType === 'application/pdf' ? await extractPdf(file.buffer) : { text: '', qrData: null };
  const result = parseCsfText(local.text);
  if (!openAiApiKey) return result;
  if (file.mimeType === 'application/pdf' && result.rfc && result.nombre && result.codigoPostal && result.regimenFiscal) return result;
  return mergeCsf(result, await readCsfWithVision(file.buffer, file.mimeType, openAiApiKey));
}
