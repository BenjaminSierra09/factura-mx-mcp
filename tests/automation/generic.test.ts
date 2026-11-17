import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAvailableFields, formatFieldValue, requiresUserSubmission, type VisibleElement } from '../../src/automation/generic.js';
import { AutomationRun } from '../../src/automation/runner.js';
import type { InvoiceAutomationInput } from '../../src/automation/types.js';

const base: InvoiceAutomationInput = {
  provider: 'generic', outputDir: '/tmp/factura-test',
  fiscal: { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', codigoPostal: '01000', regimenFiscal: '616', usoCfdi: 'S01', email: 'factura@example.com', domicilio: 'Av. Uno 1' },
};

test('offers varied retail ticket fields and fiscal address without raw OCR text', () => {
  const fields = buildAvailableFields({ ...base, ticketData: {
    empresa: 'OXXO', fechaVenta: '2026-11-16', folioVenta: '1234567', idVenta: 'ABC987',
    monto: 124.5, tienda: '00765', caja: '04', ticket: '9090', totalSinPropina: 121.5,
    codigoPago: 'PAGO-123', 'Código de operación': 'OP-77', rawText: 'IGNORE ME', rfc: 'EMISOR800101AAA',
  } });
  assert.equal(fields.fechaVenta, '2026-11-16');
  assert.equal(fields.folioVenta, '1234567');
  assert.equal(fields.idVenta, 'ABC987');
  assert.equal(fields.transaccion, 'ABC987');
  assert.equal(fields.total, '124.50');
  assert.equal(fields.totalSinPropina, '121.50');
  assert.equal(fields.codigoPago, 'PAGO-123');
  assert.equal(fields['Código de operación'], 'OP-77');
  assert.equal(fields.sucursal, '00765');
  assert.equal(fields.numeroCaja, '04');
  assert.equal(fields.domicilio, 'Av. Uno 1');
  assert.equal(fields.rawText, undefined);
  assert.equal(fields.rfc, 'XAXX010101000');
});

test('formats Mexican text dates while preserving native date inputs', () => {
  assert.equal(formatFieldValue('fechaVenta', '2026-11-16', 'text'), '16/11/2026');
  assert.equal(formatFieldValue('fechaVenta', '2026-11-16', 'date'), '2026-11-16');
  assert.equal(formatFieldValue('folio', '2026-11-16', 'text'), '2026-11-16');
});

test('final invoice submission is handed to the user', () => {
  const button: VisibleElement = {
    id: 'send', frameIndex: 0, tag: 'button', type: 'submit', role: '', label: 'Generar factura',
    name: '', placeholder: '', text: 'Generar factura', options: [], valuePresent: false,
    required: false, href: null,
  };
  assert.equal(requiresUserSubmission({ action: 'click', elementId: 'send' }, [button]), true);
  assert.equal(requiresUserSubmission({ action: 'fill', elementId: 'send' }, [button]), false);
  assert.equal(requiresUserSubmission({ action: 'click', elementId: 'send' }, [{ ...button, text: 'Consultar ticket' }]), false);
});

test('limits dynamically approved public portal hosts', () => {
  const run = new AutomationRun({ ...base, portalUrl: 'https://invoice.example.com/' }, {}, 'https://invoice.example.com/');
  assert.equal(run.approvePublicHost('invoice.example.com'), true);
  for (const host of ['one.example.com', 'two.example.com', 'three.example.com', 'four.example.com']) {
    assert.equal(run.approvePublicHost(host), true);
  }
  assert.equal(run.approvePublicHost('fifth.example.com'), false);
});

test('requires review before trusting a new public portal host', () => {
  const run = new AutomationRun({ ...base, portalUrl: 'https://invoice.example.com/' }, {}, 'https://invoice.example.com/');
  assert.equal(run.stageHostReview(true, new URL('https://provider.example.com/factura')), true);
  const review = run.pendingHostReview;
  assert.deepEqual(review, { host: 'provider.example.com', url: 'https://provider.example.com/factura' });
  assert.equal(run.allowedHosts.has('provider.example.com'), false);
  assert.equal(run.approveReviewedHost(review!), true);
  assert.equal(run.allowedHosts.has('provider.example.com'), true);
  assert.equal(run.pendingHostReview, null);
});

test('does not trust redirects to a new host after private data was entered', () => {
  const run = new AutomationRun({ ...base, portalUrl: 'https://invoice.example.com/' }, {}, 'https://invoice.example.com/');
  assert.equal(run.stageHostReview(true, new URL('https://provider.example.com/factura')), true);
  run.sensitiveDataEntered = true;
  assert.equal(run.approveReviewedHost(run.pendingHostReview!), false);
  assert.equal(run.stageHostReview(true, new URL('https://unseen.example.com/factura')), false);
  assert.equal(run.allowedHosts.has('provider.example.com'), false);
  assert.equal(run.allowedHosts.has('unseen.example.com'), false);
});

test('does not offer a host review for an untrusted source', () => {
  const run = new AutomationRun({ ...base, portalUrl: 'https://invoice.example.com/' }, {}, 'https://invoice.example.com/');
  assert.equal(run.stageHostReview(false, new URL('https://provider.example.com/factura')), false);
  assert.equal(run.pendingHostReview, null);
});

test('host review accepts continue or cancel without browser interaction', async () => {
  let decisions = 0;
  const run = new AutomationRun({ ...base, portalUrl: 'https://invoice.example.com/' }, {
    onHumanAction: async (session) => {
      await assert.rejects(session.click(5, 5), /sólo se puede continuar o cancelar/);
      await assert.rejects(session.type('RFC'), /sólo se puede continuar o cancelar/);
      await assert.rejects(session.press('Enter'), /sólo se puede continuar o cancelar/);
      if (decisions++ === 0) session.cancel();
      else session.continue();
    },
  }, 'https://invoice.example.com/');
  run.screenshot = async () => '/tmp/host-review-test.png';
  assert.equal(await run.requestHumanAction('Revisar dominio', true), false);
  assert.equal(await run.requestHumanAction('Revisar dominio', true), true);
  assert.equal(run.sensitiveDataEntered, false);
});
