import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectPortal, getPortalDefinition, listPortals } from '../../src/portals/index.js';

test('registry includes four verified issuer domains and a generic fallback', () => {
  assert.deepEqual(listPortals().map(portal => portal.id), ['primera_plus', 'oxxo', 'alsea', 'la_comer', 'generic']);
  assert.equal(getPortalDefinition('oxxo').ticketFields.filter(field => field.required).length, 4);
  assert.equal(getPortalDefinition('alsea').allowedHosts.includes('alsea.interfactura.com'), true);
  assert.equal(getPortalDefinition('alsea').brandVariants?.["P.F. Chang's"]?.some(field => field.key === 'totalSinPropina'), true);
  assert.match(getPortalDefinition('alsea').brandEntryUrls?.Starbucks ?? '', /opc=Starbucks/);
});

test('known QR host has precedence over merchant text', () => {
  const result = detectPortal({ text: 'OXXO', qrUrl: 'https://alsea.interfactura.com/RegistroDocumento.aspx?opc=Starbucks' });
  assert.equal(result.provider, 'alsea');
  assert.equal(result.confidence, 'high');
});

test('detects OXXO, Alsea brands, and La Comer brands from ticket headings', () => {
  assert.equal(detectPortal({ text: 'OXXO\nFolio de venta: 1234' }).provider, 'oxxo');
  assert.equal(detectPortal({ empresa: 'Starbucks', text: 'Número de ticket 4321' }).provider, 'alsea');
  assert.equal(detectPortal({ empresa: 'City Market' }).provider, 'la_comer');
  assert.equal(detectPortal({ empresa: 'Primera Plus' }).provider, 'primera_plus');
});

test('unknown invoice URLs remain candidates but cannot silently become trusted portal URLs', () => {
  const candidate = detectPortal({ text: 'Tienda desconocida', url: 'https://facturas.ejemplo.com/inicio' });
  assert.equal(candidate.provider, 'generic');
  assert.equal(candidate.portalUrl, null);
  assert.equal(candidate.candidateUrl, 'https://facturas.ejemplo.com/inicio');
  assert.equal(detectPortal({ url: 'http://127.0.0.1/admin' }).candidateUrl, null);
});
