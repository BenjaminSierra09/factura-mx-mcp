import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assessAutoInvoice, choosePaymentSuggestion } from '../src/autoInvoice.js';
import { detectPortal } from '../src/portals/index.js';
import type { PublicTicket } from '../src/service.js';
import type { ProfileRow } from '../src/db.js';
import type { TicketAnalysis } from '../src/ingest/types.js';

const profile: ProfileRow = {
  user_id: 'user', rfc: 'XAXX010101000', nombre: 'PERSONA DE PRUEBA', codigo_postal: '06000',
  regimen_fiscal: '612', uso_cfdi: 'G03', factura_email: 'fiscal@example.test', domicilio: '',
  csf_file_id: null, openai_key_enc: null, smtp_host: '', smtp_port: 587, smtp_secure: 0,
  smtp_user: '', smtp_pass_enc: null, smtp_from: '',
};

function ticket(overrides: Partial<TicketAnalysis> = {}): PublicTicket {
  const analysis: TicketAnalysis = {
    text: '', qrUrl: null, empresa: null, folio: null, fecha: null, monto: null,
    referencia: null, url: null, ...overrides,
  };
  return { id: 'ticket', fileId: 'file', analysis, detection: detectPortal(analysis),
    discovery: null, exploration: null, createdAt: '2026-11-16 00:00:00' };
}

test('automatic flow starts from a recognized issuer but asks for missing fiscal data', () => {
  const known = ticket({ empresa: 'Primera Plus' });
  assert.equal(assessAutoInvoice(known, profile), null);
  assert.equal(assessAutoInvoice(known, { ...profile, rfc: '' })?.reason, 'profile');
});

test('unknown issuer requires a trusted portal before automatic invoicing', () => {
  assert.equal(assessAutoInvoice(ticket(), profile)?.reason, 'issuer');
  const unknown = ticket({ empresa: 'Tienda Desconocida' });
  assert.equal(assessAutoInvoice(unknown, profile)?.reason, 'portal');
  unknown.discovery = { issuer: 'Tienda Desconocida', status: 'found', reason: 'Fuente oficial',
    candidates: [], selected: { url: 'https://tienda.example/factura', title: 'Facturación',
      sourceUrl: 'https://tienda.example/', confidence: 'high', reason: 'Sitio del emisor' } };
  assert.equal(assessAutoInvoice(unknown, profile)?.reason, 'openai_key');
  assert.equal(assessAutoInvoice(unknown, { ...profile, openai_key_enc: 'encrypted' }), null);
});

test('user payment clue overrides weak OCR; conflicting explicit clues need review', () => {
  const weak = ticket({ empresa: 'Primera Plus',
    formaPagoSugerida: { codigo: '04', evidencia: 'Ticket: tarjeta de crédito', confianza: 'media' } });
  assert.deepEqual(choosePaymentSuggestion(weak, 'Pagué con tarjeta de débito'), {
    suggestion: { codigo: '28', evidencia: 'Información adicional: Tarjeta de débito', confianza: 'alta' },
    conflict: false,
  });
  weak.analysis.formaPagoSugerida = { codigo: '04', evidencia: 'Ticket: tarjeta de crédito', confianza: 'alta' };
  assert.equal(choosePaymentSuggestion(weak, 'Pagué con tarjeta de débito').conflict, true);
  assert.deepEqual(choosePaymentSuggestion(weak, 'Pagué con tarjeta de débito', '28'), {
    suggestion: { codigo: '28', evidencia: 'Confirmada por el usuario: Tarjeta de débito', confianza: 'alta' },
    conflict: false,
  });
  assert.throws(() => choosePaymentSuggestion(weak, '', '00'), /Forma de pago inválida/);
  assert.equal(choosePaymentSuggestion(ticket({ empresa: 'Primera Plus' })).suggestion, null,
    'an unreadable payment form is left blank');
});
