import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inspectCfdiXml } from '../src/documents.js';

const sample = `<?xml version="1.0" encoding="utf-8"?>
<cfdi:Comprobante Version="4.0" xmlns:cfdi="http://www.sat.gob.mx/cfd/4">
  <cfdi:Receptor Rfc="XAXX010101000" Nombre="PUBLICO EN GENERAL" />
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital"
      UUID="12345678-1234-1234-1234-123456789ABC" SelloSAT="abcdefghijklmnopqrstuvwxyz0123456789" />
  </cfdi:Complemento>
</cfdi:Comprobante>`;

test('only recognizes CFDI XML with matching receptor RFC, 4.0 version, UUID and SAT seal field', () => {
  assert.equal(inspectCfdiXml(Buffer.from(sample), 'XAXX010101000').valid, true);
  assert.equal(inspectCfdiXml(Buffer.from(sample), 'COSC8001137NA').valid, false);
  assert.equal(inspectCfdiXml(Buffer.from(sample.replace('Version="4.0"', 'Version="3.3"')), 'XAXX010101000').valid, false);
  assert.equal(inspectCfdiXml(Buffer.from(sample.replace('abcdefghijklmnopqrstuvwxyz0123456789', '')), 'XAXX010101000').valid, false);
});
