import { execute, getProfile, queryOne, type ProfileRow } from './db.js';
import { getTicket, type PublicTicket } from './service.js';
import { createInvoiceJob, getJob, type PublicJob } from './jobs.js';
import { getPortalDefinition } from './portals/index.js';
import { suggestPaymentForm, type PaymentSuggestion } from './payment.js';
import { formasPago, isFormaPago } from './fiscalCatalogs.js';
import { profileSchema } from './validation.js';

export type AutoInvoiceReviewReason = 'profile' | 'issuer' | 'portal' | 'ticket_data' | 'openai_key' | 'payment' | 'other';

export type AutoInvoiceResult =
  | { status: 'started'; job: PublicJob; paymentSuggestion: PaymentSuggestion | null }
  | { status: 'needs_review'; reason: AutoInvoiceReviewReason; message: string;
      ticket: PublicTicket; paymentSuggestion: PaymentSuggestion | null };

type Review = { reason: AutoInvoiceReviewReason; message: string };
const inFlight = new Map<string, Promise<AutoInvoiceResult>>();

/** Decide whether a ticket has enough trusted evidence to start a portal job. */
export function assessAutoInvoice(ticket: PublicTicket, profile: ProfileRow): Review | null {
  const validProfile = profileSchema.safeParse({
    rfc: profile.rfc, nombre: profile.nombre, codigoPostal: profile.codigo_postal,
    regimenFiscal: profile.regimen_fiscal, usoCfdi: profile.uso_cfdi,
    facturaEmail: profile.factura_email, domicilio: profile.domicilio,
  }).success;
  if (!validProfile) return { reason: 'profile', message: 'Completa y revisa tu perfil fiscal para iniciar el trámite.' };

  const provider = ticket.detection.provider;
  if (provider === 'generic' && !ticket.analysis.empresa && !ticket.analysis.marca && !ticket.discovery?.selected) {
    return { reason: 'issuer', message: 'No pudimos identificar al emisor del ticket. Revisa el nombre del comercio.' };
  }
  const definition = getPortalDefinition(provider);
  const trustedPortal = provider === 'generic' ? ticket.discovery?.selected?.url : definition.portalUrl;
  if (!trustedPortal) {
    return { reason: 'portal', message: 'No encontramos un portal de facturación respaldado por el emisor. Revisa la dirección antes de compartir tus datos.' };
  }
  if (definition.automation === 'ai' && !profile.openai_key_enc) {
    return { reason: 'openai_key', message: 'Guarda tu API key de OpenAI en el perfil para explorar este portal.' };
  }
  return null;
}

export function choosePaymentSuggestion(ticket: PublicTicket, textoAdicional?: string, formaPago?: string):
  { suggestion: PaymentSuggestion | null; conflict: boolean } {
  if (formaPago) {
    if (!isFormaPago(formaPago)) throw new Error('Forma de pago inválida');
    const nombre = formasPago.find(item => item.codigo === formaPago)!.nombre;
    return { suggestion: { codigo: formaPago, evidencia: `Confirmada por el usuario: ${nombre}`, confianza: 'alta' }, conflict: false };
  }
  if (ticket.analysis.formaPagoUsuario?.confirmada) {
    return { suggestion: ticket.analysis.formaPagoUsuario, conflict: false };
  }
  const supplied = (textoAdicional?.trim() ? suggestPaymentForm(textoAdicional, 'usuario') : null) ??
    ticket.analysis.formaPagoUsuario ?? null;
  const printed = ticket.analysis.formaPagoSugerida ?? null;
  if (supplied?.confianza === 'alta' && printed?.confianza === 'alta' && supplied.codigo !== printed.codigo) {
    return { suggestion: null, conflict: true };
  }
  return { suggestion: supplied && printed?.confianza !== 'alta' ? supplied : printed ?? supplied, conflict: false };
}

async function persistUserPayment(userId: string, ticket: PublicTicket,
  options: { textoAdicional?: string; formaPago?: string }): Promise<void> {
  let userSuggestion: (PaymentSuggestion & { confirmada?: boolean }) | null = null;
  if (options.formaPago) {
    if (!isFormaPago(options.formaPago)) throw new Error('Forma de pago inválida');
    const nombre = formasPago.find(item => item.codigo === options.formaPago)!.nombre;
    userSuggestion = { codigo: options.formaPago, evidencia: `Confirmada por el usuario: ${nombre}`,
      confianza: 'alta', confirmada: true };
  } else if (options.textoAdicional?.trim()) {
    userSuggestion = suggestPaymentForm(options.textoAdicional, 'usuario');
  }
  if (!userSuggestion) return;
  const row = await queryOne<{ analysis_json: string }>('SELECT analysis_json FROM tickets WHERE id=? AND user_id=?', [ticket.id, userId]);
  if (!row) throw new Error('Ticket no encontrado');
  const analysis = JSON.parse(row.analysis_json) as PublicTicket['analysis'];
  if (analysis.formaPagoUsuario?.confirmada && !options.formaPago) return;
  analysis.formaPagoUsuario = userSuggestion;
  await execute('UPDATE tickets SET analysis_json=? WHERE id=? AND user_id=?', [JSON.stringify(analysis), ticket.id, userId]);
  ticket.analysis = analysis;
}

function classifyExpectedError(message: string): Review | null {
  if (/^Completa y revisa tu perfil fiscal/.test(message)) return { reason: 'profile', message };
  if (/^Completa los datos del ticket/.test(message)) return { reason: 'ticket_data', message };
  if (/^Guarda tu API key de OpenAI/.test(message)) return { reason: 'openai_key', message };
  if (/^(?:URL del portal inválida|El portal debe usar HTTPS público|El destino debe ser un dominio público|El destino resuelve a una dirección no pública)/.test(message)) {
    return { reason: 'portal', message: 'No se pudo verificar la dirección del portal. Revisa el sitio del emisor.' };
  }
  return null;
}

/** Start with the detected issuer and an official portal, without a manual issuer/channel form. */
export function autoInvoiceTicket(userId: string, ticketId: string,
  options: { textoAdicional?: string; formaPago?: string } = {}): Promise<AutoInvoiceResult> {
  const key = `${userId}:${ticketId}`;
  const pending = inFlight.get(key);
  if (pending) return pending;
  const work = runAutoInvoiceTicket(userId, ticketId, options);
  inFlight.set(key, work);
  void work.then(() => inFlight.delete(key), () => inFlight.delete(key));
  return work;
}

async function runAutoInvoiceTicket(userId: string, ticketId: string,
  options: { textoAdicional?: string; formaPago?: string } = {}): Promise<AutoInvoiceResult> {
  const ticket = await getTicket(userId, ticketId);
  if (!ticket) throw new Error('Ticket no encontrado');
  const previous = await queryOne<{ id: string }>(`SELECT id FROM jobs WHERE user_id=? AND ticket_id=? ORDER BY created_at DESC,id DESC LIMIT 1`,
    [userId, ticketId]);
  const existingJob = previous ? await getJob(userId, previous.id) : null;
  if (existingJob && existingJob.status !== 'failed') {
    return { status: 'started', job: existingJob,
      paymentSuggestion: choosePaymentSuggestion(ticket).suggestion };
  }
  await persistUserPayment(userId, ticket, options);
  const { suggestion, conflict } = choosePaymentSuggestion(ticket, options.textoAdicional, options.formaPago);
  if (previous) {
    if (existingJob) {
      return { status: 'needs_review', reason: 'other',
        message: 'Ya se intentó este ticket y el trámite no se completó. Revisa el resultado antes de repetirlo.',
        ticket, paymentSuggestion: suggestion };
    }
  }

  const review = assessAutoInvoice(ticket, await getProfile(userId));
  if (review) return { status: 'needs_review', ...review, ticket, paymentSuggestion: suggestion };
  if (conflict) {
    return { status: 'needs_review', reason: 'payment',
      message: 'El ticket y tu información adicional indican formas de pago distintas. Confirma cuál aparece en el comprobante.',
      ticket, paymentSuggestion: null };
  }

  try {
    const job = await createInvoiceJob(userId, {
      ticketId, provider: 'auto', channel: 'portal',
      ...(suggestion?.confianza === 'alta' ? { ticketData: { formaPago: suggestion.codigo } } : {}),
    });
    return { status: 'started', job, paymentSuggestion: suggestion };
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    const expected = classifyExpectedError(message);
    if (expected) return { status: 'needs_review', ...expected, ticket, paymentSuggestion: suggestion };
    throw error;
  }
}
