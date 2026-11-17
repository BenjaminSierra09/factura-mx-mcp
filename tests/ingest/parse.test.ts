import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeCsf, normaliseDate, parseCsfText, parseTicketText } from '../../src/ingest/parse.js';

test('extrae campos explícitos de un boleto y su URL QR', () => {
  const result = parseTicketText([
    'PRIMERA PLUS',
    'Folio de boleto: PP-0483821',
    'Fecha de compra: 15/11/2026',
    'Total: MXN $1,234.50',
    'Referencia: R8GH92',
  ].join('\n'), 'https://factura.example.com/inicio?folio=PP-0483821');
  assert.equal(result.empresa, 'Primera Plus');
  assert.equal(result.folio, 'PP-0483821');
  assert.equal(result.fecha, '2026-11-15');
  assert.equal(result.monto, 1234.5);
  assert.equal(result.referencia, 'R8GH92');
  assert.equal(result.qrUrl, 'https://factura.example.com/inicio?folio=PP-0483821');
  assert.equal(result.url, result.qrUrl);
});

test('no inventa campos ausentes ni acepta fechas imposibles', () => {
  const result = parseTicketText('Gracias por su compra\nTotal sin etiqueta 5.00');
  assert.equal(result.folio, null);
  assert.equal(result.empresa, null);
  assert.equal(result.fecha, null);
  assert.equal(result.monto, null);
  assert.equal(normaliseDate('31/02/2026'), null);
});

test('separa los cuatro datos que pide OXXO', () => {
  const result = parseTicketText('OXXO\nFecha de venta: 16/11/2026\nFolio de venta: 12345678\nID de venta: 987654\nTotal: $235.50');
  assert.equal(result.empresa, 'OXXO');
  assert.equal(result.fechaVenta, '2026-11-16');
  assert.equal(result.folioVenta, '12345678');
  assert.equal(result.idVenta, '987654');
  assert.equal(result.monto, 235.5);
});

test('separa ticket, tienda, fecha y marca de Alsea', () => {
  const result = parseTicketText('STARBUCKS\nTicket: 123456789\nTienda: 01234\nFecha de consumo: 15/11/2026\nTotal sin propina: $180.00');
  assert.equal(result.marca, 'Starbucks');
  assert.equal(result.numeroTicket, '123456789');
  assert.equal(result.numeroTienda, '01234');
  assert.equal(result.fechaVenta, '2026-11-15');
  assert.equal(result.totalSinPropina, 180);
});

test('extrae datos fiscales de una constancia con RFC y CP válidos', () => {
  const result = parseCsfText([
    'CONSTANCIA DE SITUACIÓN FISCAL',
    'RFC: ABCD010203A12',
    'Nombre (s): MARÍA',
    'Primer Apellido: LÓPEZ',
    'Segundo Apellido: GARCÍA',
    'Código Postal: 01234',
    'Régimen Fiscal: 605 - Sueldos y Salarios',
    'Correo electrónico: maria@example.com',
  ].join('\n'));
  assert.equal(result.rfc, 'ABCD010203A12');
  assert.equal(result.nombre, 'MARÍA LÓPEZ GARCÍA');
  assert.equal(result.codigoPostal, '01234');
  assert.equal(result.regimenFiscal, '605 - Sueldos y Salarios');
  assert.equal(result.email, 'maria@example.com');
});

test('descarta RFC y CP mal formados aun si los devuelve la visión', () => {
  const local = parseCsfText('Sin datos fiscales');
  const merged = mergeCsf(local, { rfc: 'INVENTADO', codigoPostal: '123', nombre: 'PERSONA', text: 'Sin datos fiscales' });
  assert.equal(merged.rfc, null);
  assert.equal(merged.codigoPostal, null);
  assert.equal(merged.nombre, 'PERSONA');
});
