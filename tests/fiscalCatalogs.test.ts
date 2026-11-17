import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formasPago, isFormaPago, isRegimenCompatible, isUsoCfdiCompatible, regimenes, usosCfdi } from '../src/fiscalCatalogs.js';
import { parseTicketText } from '../src/ingest/parse.js';
import { suggestPaymentForm } from '../src/payment.js';

test('the SAT catalogue snapshot exposes current codes and fiscal compatibility', () => {
  assert.equal(regimenes.length, 19);
  assert.equal(formasPago.length, 22);
  assert.equal(usosCfdi.length, 24);
  assert.equal(new Set<string>(regimenes.map(item => item.codigo)).has('602'), false,
    '602 is absent from the current CFDI 4.0 catalogue');
  assert.equal(isRegimenCompatible('612', 'ABCD010101ABC'), true);
  assert.equal(isRegimenCompatible('612', 'ABC010101ABC'), false);
  assert.equal(isUsoCfdiCompatible('G03', '612', 'ABCD010101ABC'), true);
  assert.equal(isUsoCfdiCompatible('G03', '605', 'ABCD010101ABC'), false);
  assert.equal(isUsoCfdiCompatible('D01', '612', 'ABC010101ABC'), false);
  assert.equal(isUsoCfdiCompatible('CN01', '605', 'ABCD010101ABC'), true);
  assert.equal(isFormaPago('28'), true);
  assert.equal(isFormaPago('07'), false);
});

test('payment suggestion uses explicit evidence without guessing card type', () => {
  assert.deepEqual(suggestPaymentForm('FORMA DE PAGO: TARJETA DE DÉBITO'), {
    codigo: '28', evidencia: 'Ticket: Tarjeta de débito', confianza: 'alta',
  });
  assert.equal(suggestPaymentForm('VISA 1234 AUTORIZADO'), null, 'brand does not establish debit or credit');
  assert.equal(suggestPaymentForm('EFECTIVO $50\nTARJETA DE DÉBITO $50'), null, 'split tenders need review');
  assert.equal(suggestPaymentForm('FORMA DE PAGO: 99'), null, '99 is not a fallback for a paid ticket');
  assert.equal(suggestPaymentForm('No pagué con tarjeta de crédito', 'usuario'), null,
    'a negated payment clue is not treated as a positive payment method');
  assert.deepEqual(suggestPaymentForm('Pagué con transferencia SPEI', 'usuario'), {
    codigo: '03', evidencia: 'Información adicional: Transferencia electrónica de fondos', confianza: 'alta',
  });
});

test('ticket OCR carries a payment suggestion with evidence', () => {
  const ticket = parseTicketText('OXXO\nFOLIO: 12345\nPAGO CON EFECTIVO\nTOTAL: 45.00');
  assert.deepEqual(ticket.formaPagoSugerida, {
    codigo: '01', evidencia: 'Ticket: Efectivo', confianza: 'alta',
  });
});
