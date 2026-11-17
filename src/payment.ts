import { formasPago, isFormaPago } from './fiscalCatalogs.js';

export interface PaymentSuggestion {
  codigo: string;
  evidencia: string;
  confianza: 'alta' | 'media';
}

const paymentSignals: { codigo: string; pattern: RegExp }[] = [
  { codigo: '29', pattern: /\bTARJETA\s+DE\s+SERVICIOS\b/ },
  { codigo: '28', pattern: /\b(?:TARJETA\s+(?:DE\s+)?DEBITO|DEBITO\s+(?:CON\s+)?TARJETA|(?:VISA|MASTERCARD)\s+DEBITO)\b/ },
  { codigo: '04', pattern: /\b(?:TARJETA\s+(?:DE\s+)?CREDITO|CREDITO\s+(?:CON\s+)?TARJETA|(?:VISA|MASTERCARD)\s+CREDITO)\b/ },
  { codigo: '08', pattern: /\bVALES?(?:\s+DE\s+DESPENSA)?\b/ },
  { codigo: '05', pattern: /\bMONEDERO\s+ELECTRONICO\b/ },
  { codigo: '06', pattern: /\bDINERO\s+ELECTRONICO\b/ },
  { codigo: '03', pattern: /\b(?:TRANSFERENCIA(?:\s+ELECTRONICA)?|SPEI|CODI)\b/ },
  { codigo: '02', pattern: /\bCHEQUE(?:\s+NOMINATIVO)?\b/ },
  { codigo: '01', pattern: /\b(?:EFECTIVO|CASH)\b/ },
];

function normalize(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

/** Suggest only from a printed or supplied payment clue; card brand alone is ambiguous. */
export function suggestPaymentForm(
  text: string,
  source: 'ticket' | 'usuario' = 'ticket',
): PaymentSuggestion | null {
  const candidates: { codigo: string; confidence: 'alta' | 'media' }[] = [];
  for (const rawLine of text.slice(0, 50_000).split(/\r?\n/).slice(0, 250)) {
    const line = normalize(rawLine.slice(0, 250));
    if (/\b(?:NO|SIN)\s+(?:(?:PAGUE|PAGO|PAGADO|FUE|ERA|USE|UTILICE)\s+)?(?:CON\s+|EN\s+)?(?:TARJETA|EFECTIVO|CREDITO|DEBITO|TRANSFERENCIA|SPEI)\b/.test(line)) return null;
    const explicit = /\b(?:(?:FORMA|MEDIO|TIPO)\s+DE\s+PAGO|PAGO\s*(?::|CON\b|EN\b)|PAG(?:ADO|UE)\s+(?:CON|EN))/.test(line);
    const codeMatch = /\b(?:FORMA|MEDIO|TIPO)\s+DE\s+PAGO\s*[:#-]?\s*(\d{2})\b/.exec(line);
    const matches = paymentSignals.filter(signal => signal.pattern.test(line)).map(signal => signal.codigo);
    if (codeMatch && isFormaPago(codeMatch[1]!) && codeMatch[1] !== '99') matches.push(codeMatch[1]!);
    const unique = [...new Set(matches)];
    if (unique.length > 1) return null;
    if (unique.length === 1) candidates.push({ codigo: unique[0]!, confidence: explicit || codeMatch ? 'alta' : 'media' });
  }
  const uniqueCodes = [...new Set(candidates.map(candidate => candidate.codigo))];
  if (uniqueCodes.length !== 1) return null;
  const codigo = uniqueCodes[0]!;
  const nombre = formasPago.find(item => item.codigo === codigo)?.nombre;
  if (!nombre) return null;
  return {
    codigo,
    evidencia: `${source === 'ticket' ? 'Ticket' : 'Información adicional'}: ${nombre}`,
    confianza: candidates.some(candidate => candidate.confidence === 'alta') ? 'alta' : 'media',
  };
}
