import path from 'node:path';
import nodemailer from 'nodemailer';
import * as z from 'zod/v4';
import { assertPublicHostname } from '../validation.js';
import { isFormaPago } from '../fiscalCatalogs.js';

export interface InvoiceEmailAttachment {
  filename: string;
  content: Buffer;
  contentType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/webp';
}

export interface InvoiceEmailInput {
  /** A single address that the account owner has reviewed before starting the job. */
  recipientEmail: string;
  issuerName: string;
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    password: string;
    from: string;
  };
  fiscal: {
    rfc: string;
    razonSocial: string;
    codigoPostal: string;
    regimenFiscal: string;
    usoCfdi: string;
    email: string;
    domicilio?: string;
  };
  ticket: InvoiceEmailAttachment;
  formaPago?: string;
  csf?: InvoiceEmailAttachment;
}

export interface EmailMessage {
  from: string;
  to: string;
  replyTo: string;
  subject: string;
  text: string;
  attachments: InvoiceEmailAttachment[];
}

interface EmailTransport {
  sendMail(message: EmailMessage): Promise<unknown>;
  close(): void;
}

interface SmtpOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  auth: { user: string; pass: string };
  tls: { minVersion: 'TLSv1.2'; rejectUnauthorized: true };
  connectionTimeout: number;
  socketTimeout: number;
}

/** Injectable transport makes the send path testable without a live SMTP account. */
export interface EmailDependencies {
  assertPublicHost?: (hostname: string) => Promise<void>;
  createTransport?: (options: SmtpOptions) => EmailTransport;
}

const emailSchema = z.email().max(254);
const allowedPorts = new Set([465, 587, 2525]);
const allowedTypes = new Set<InvoiceEmailAttachment['contentType']>([
  'application/pdf', 'image/jpeg', 'image/png', 'image/webp',
]);

function singleEmail(value: string, label: string): string {
  const trimmed = value.trim();
  if (!emailSchema.safeParse(trimmed).success || /[,;<>\r\n\s]/.test(trimmed)) {
    throw new Error(`${label} inválido`);
  }
  return trimmed;
}

function cleanText(value: string, label: string, maxLength: number): string {
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned.length > maxLength) throw new Error(`${label} inválido`);
  return cleaned;
}

function validateAttachment(file: InvoiceEmailAttachment, label: string): InvoiceEmailAttachment {
  if (!Buffer.isBuffer(file.content) || !file.content.length || file.content.length > 15 * 1024 * 1024 ||
      !allowedTypes.has(file.contentType)) throw new Error(`${label} inválido`);
  const filename = path.basename(file.filename.replaceAll('\\', '/'))
    .replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  if (!filename || filename === '.' || filename === '..') throw new Error(`Nombre de ${label} inválido`);
  return { filename, content: file.content, contentType: file.contentType };
}

export function buildInvoiceEmail(input: InvoiceEmailInput): EmailMessage {
  const recipientEmail = singleEmail(input.recipientEmail, 'Correo del emisor');
  const from = singleEmail(input.smtp.from, 'Remitente SMTP');
  const replyTo = singleEmail(input.fiscal.email, 'Correo de recepción');
  const issuer = cleanText(input.issuerName, 'Emisor', 120);
  const fiscal = input.fiscal;
  if (!/^[A-Z&Ñ]{3,4}\d{6}[A-Z0-9]{3}$/.test(fiscal.rfc) ||
      !/^\d{5}$/.test(fiscal.codigoPostal) || !/^\d{3}$/.test(fiscal.regimenFiscal) ||
      !/^[A-Z0-9]{3}$/.test(fiscal.usoCfdi)) {
    throw new Error('Datos fiscales incompletos o inválidos');
  }
  const razonSocial = cleanText(fiscal.razonSocial, 'Razón social', 250);
  const domicilio = fiscal.domicilio?.trim()
    ? cleanText(fiscal.domicilio, 'Domicilio fiscal', 500) : null;
  const ticket = validateAttachment(input.ticket, 'ticket');
  if (input.formaPago && !isFormaPago(input.formaPago)) throw new Error('Forma de pago inválida');
  const csf = input.csf ? validateAttachment(input.csf, 'constancia') : null;
  if (ticket.content.length + (csf?.content.length ?? 0) > 25 * 1024 * 1024) {
    throw new Error('Los adjuntos superan 25 MB');
  }
  const text = [
    `Solicito la factura CFDI 4.0 del ticket adjunto de ${issuer}.`,
    '',
    `RFC: ${fiscal.rfc}`,
    `Nombre o razón social: ${razonSocial}`,
    `Código postal fiscal: ${fiscal.codigoPostal}`,
    `Régimen fiscal: ${fiscal.regimenFiscal}`,
    `Uso CFDI: ${fiscal.usoCfdi}`,
    ...(input.formaPago ? [`Forma de pago: ${input.formaPago}`] : []),
    `Correo para recibir la factura: ${replyTo}`,
    ...(domicilio ? [`Domicilio fiscal: ${domicilio}`] : []),
    '',
    'Adjunto el ticket' + (csf ? ' y la constancia de situación fiscal.' : '.'),
    'Gracias.',
  ].join('\n');
  return {
    from, to: recipientEmail, replyTo,
    subject: `Solicitud de CFDI 4.0 - ${issuer}`,
    text, attachments: csf ? [ticket, csf] : [ticket],
  };
}

/**
 * Send one reviewed request over SMTP with TLS. A successful send only means
 * the SMTP server accepted the message; it does not mean a CFDI was issued.
 */
export async function sendInvoiceEmail(input: InvoiceEmailInput, deps: EmailDependencies = {}): Promise<{ recipientEmail: string }> {
  const message = buildInvoiceEmail(input);
  const smtp = input.smtp;
  const host = smtp.host.trim().toLowerCase();
  if (!host || host.length > 253 || !allowedPorts.has(smtp.port) ||
      (smtp.secure && smtp.port !== 465) || (!smtp.secure && smtp.port === 465) ||
      !smtp.user.trim() || !smtp.password) throw new Error('Configuración SMTP incompleta o inválida');
  await (deps.assertPublicHost ?? assertPublicHostname)(host);
  const options: SmtpOptions = {
    host, port: smtp.port, secure: smtp.secure,
    requireTLS: !smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { minVersion: 'TLSv1.2', rejectUnauthorized: true },
    connectionTimeout: 15_000, socketTimeout: 30_000,
  };
  const transport = (deps.createTransport ?? nodemailer.createTransport)(options) as EmailTransport;
  try {
    const result = await transport.sendMail(message);
    if (result && typeof result === 'object' && 'accepted' in result && Array.isArray(result.accepted) &&
        !result.accepted.some((address: unknown) => typeof address === 'string' &&
          address.toLowerCase() === message.to.toLowerCase())) {
      throw new Error('El servidor SMTP no aceptó el destinatario');
    }
    return { recipientEmail: message.to };
  } finally {
    transport.close();
  }
}
