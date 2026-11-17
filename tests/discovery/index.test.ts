import assert from 'node:assert/strict';
import { test } from 'node:test';
import { discoverInvoicePortal, interpretDiscoveryResponse } from '../../src/discovery/index.js';

const validate = async (url: string): Promise<string> => new URL(url).toString();

function response(
  candidates: Array<{ url: string; title: string; officialSourceUrl?: string }>,
  cited: Array<{ url: string; title: string }> = [],
  sources: string[] = [],
): unknown {
  return {
    output: [
      { type: 'web_search_call', action: { type: 'search', sources: sources.map(url => ({ type: 'url', url })) } },
      { type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ candidates }),
        annotations: cited.map(item => ({ type: 'url_citation', ...item })) }] },
    ],
  };
}

test('selects one public HTTPS portal backed by an official issuer domain citation', async () => {
  const result = await interpretDiscoveryResponse(response(
    [{ url: 'https://facturas.tiendax.com.mx/cfdi', title: 'Facturación Tienda X',
      officialSourceUrl: 'https://www.tiendax.com.mx/ayuda/facturacion' }],
    [{ url: 'https://www.tiendax.com.mx/ayuda/facturacion', title: 'Facturación | Tienda X' }],
  ), 'Tienda X', validate);

  assert.equal(result.status, 'found');
  assert.equal(result.selected?.url, 'https://facturas.tiendax.com.mx/cfdi');
  assert.equal(result.selected?.sourceUrl, 'https://www.tiendax.com.mx/ayuda/facturacion');
  assert.equal(result.selected?.confidence, 'high');
});

test('search sources are extracted, but a third-party portal stays in review', async () => {
  const result = await interpretDiscoveryResponse(response(
    [{ url: 'https://servicio-facturas.example/facturar', title: 'Portal externo',
      officialSourceUrl: 'https://www.tiendax.com.mx/ayuda/facturacion' }],
    [], ['https://www.tiendax.com.mx/ayuda/facturacion']),
  'Tienda X', validate);

  assert.equal(result.status, 'needs_review');
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0]?.confidence, 'medium');
  assert.equal(result.candidates[0]?.sourceUrl, 'https://www.tiendax.com.mx/ayuda/facturacion');
});

test('uncited and private or insecure proposals cannot be selected', async () => {
  const result = await interpretDiscoveryResponse(response([
    { url: 'http://tiendax.com.mx/facturacion', title: 'HTTP' },
    { url: 'https://127.0.0.1/internal', title: 'IP local' },
    { url: 'https://facturas.tiendax.com.mx/cfdi', title: 'Sin fuente' },
  ]), 'Tienda X', validate);

  assert.equal(result.status, 'needs_review');
  assert.equal(result.selected, null);
  assert.deepEqual(result.candidates.map(item => item.url), ['https://facturas.tiendax.com.mx/cfdi']);
  assert.equal(result.candidates[0]?.confidence, 'low');
});

test('malformed model text may offer a cited invoice page, but ambiguity blocks selection', async () => {
  const answer = {
    output: [
      { type: 'message', content: [{ type: 'output_text', text: 'No pude generar JSON', annotations: [
        { type: 'url_citation', url: 'https://www.tiendax.com.mx/facturacion', title: 'Facturación' },
        { type: 'url_citation', url: 'https://www.tiendax.com.mx/cfdi', title: 'CFDI' },
      ] }] },
    ],
  };
  const result = await interpretDiscoveryResponse(answer, 'Tienda X', validate);
  assert.equal(result.status, 'needs_review');
  assert.equal(result.selected, null);
  assert.equal(result.candidates.length, 2);
  assert.ok(result.candidates.every(item => item.confidence === 'high'));
});

test('a source hostname containing the issuer only in its subdomain cannot prove ownership', async () => {
  const result = await interpretDiscoveryResponse(response(
    [{ url: 'https://facturas.tiendax.evil.example/cfdi', title: 'Imitación',
      officialSourceUrl: 'https://www.tiendax.evil.example/facturacion' }],
    [{ url: 'https://www.tiendax.evil.example/facturacion', title: 'Imitación' }],
  ), 'Tienda X', validate);
  assert.equal(result.selected, null);
  assert.equal(result.candidates[0]?.confidence, 'medium');
});

test('a registrable domain that merely contains the issuer name is not official evidence', async () => {
  const spoof = await interpretDiscoveryResponse(response(
    [{ url: 'https://portal.oxxo-facturas.com/cfdi', title: 'Facturación OXXO',
      officialSourceUrl: 'https://www.oxxo-facturas.com/facturacion' }],
    [{ url: 'https://www.oxxo-facturas.com/facturacion', title: 'Facturación OXXO' }],
  ), 'OXXO', validate);
  assert.equal(spoof.selected, null);
  assert.equal(spoof.status, 'needs_review');
  assert.equal(spoof.candidates[0]?.confidence, 'medium');

  const official = await interpretDiscoveryResponse(response(
    [{ url: 'https://facturas.oxxo.com/cfdi', title: 'Facturación OXXO',
      officialSourceUrl: 'https://www.oxxo.com/facturacion' }],
    [{ url: 'https://www.oxxo.com/facturacion', title: 'Facturación OXXO' }],
  ), 'OXXO', validate);
  assert.equal(official.selected?.confidence, 'high');
});

test('rejects ticket and fiscal data before creating a search request', async () => {
  await assert.rejects(discoverInvoicePortal('OXXO RFC ABCD010101AAA', 'unused-key'), /emisor es inválido/);
  await assert.rejects(discoverInvoicePortal('Tienda X folio 123456', 'unused-key'), /emisor es inválido/);
});
