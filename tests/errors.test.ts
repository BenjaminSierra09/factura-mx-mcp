import test from 'node:test';
import assert from 'node:assert/strict';
import { publicInputErrorMessage } from '../src/errors.js';

test('only approved validation errors can be returned by API and MCP', () => {
  assert.equal(publicInputErrorMessage(new Error('Ticket no encontrado')), 'Ticket no encontrado');
  assert.equal(publicInputErrorMessage(new Error('Completa los datos del ticket: folio')), 'Completa los datos del ticket: folio');
  assert.equal(publicInputErrorMessage(new Error('SQLITE_ERROR: token secreto')), null);
  assert.equal(publicInputErrorMessage('token secreto'), null);
});
