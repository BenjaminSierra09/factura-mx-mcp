import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildInvoiceEmail,
  sendInvoiceEmail,
  type InvoiceEmailInput,
  type EmailMessage,
} from '../../src/email/index.js';

function sample(): InvoiceEmailInput {
  return {
    recipientEmail: 'facturas@comercio.mx',
    issuerName: 'Comercio Ejemplo',
    smtp: {
      host: 'smtp.example.com', port: 587, secure: false,
      user: 'usuario@example.com', password: 'secreto-smtp',
      from: 'usuario@example.com',
    },
    fiscal: {
      rfc: 'XAXX010101000', razonSocial: 'CLIENTE DE PRUEBA',
      codigoPostal: '01000', regimenFiscal: '612', usoCfdi: 'G03',
      email: 'facturas-cliente@example.com', domicilio: 'Calle 10',
    },
    ticket: {
      filename: '../ticket.pdf', content: Buffer.from('%PDF-ticket'),
      contentType: 'application/pdf',
    },
    formaPago: '28',
    csf: {
      filename: 'constancia.pdf', content: Buffer.from('%PDF-csf'),
      contentType: 'application/pdf',
    },
  };
}

test('compone solicitud fiscal con adjuntos y sin secreto SMTP en el mensaje', () => {
  const message = buildInvoiceEmail(sample());
  assert.equal(message.to, 'facturas@comercio.mx');
  assert.equal(message.replyTo, 'facturas-cliente@example.com');
  assert.equal(message.attachments.length, 2);
  assert.equal(message.attachments[0]?.filename, 'ticket.pdf');
  assert.match(message.text, /RFC: XAXX010101000/);
  assert.match(message.text, /Domicilio fiscal: Calle 10/);
  assert.match(message.text, /Forma de pago: 28/);
  assert.doesNotMatch(JSON.stringify(message), /secreto-smtp/);
});

test('rechaza destinatario múltiple y cabeceras inyectadas antes de enviar', () => {
  assert.throws(() => buildInvoiceEmail({ ...sample(), recipientEmail: 'uno@ejemplo.mx, dos@ejemplo.mx' }), /Correo del emisor inválido/);
  assert.throws(() => buildInvoiceEmail({ ...sample(), recipientEmail: 'uno@ejemplo.mx\nBcc: otro@ejemplo.mx' }), /Correo del emisor inválido/);
  const message = buildInvoiceEmail({ ...sample(), issuerName: 'Comercio\nBcc: otro@ejemplo.mx' });
  assert.doesNotMatch(message.subject, /\n/);
});

test('envía por SMTP TLS a un único destinatario revisado y cierra el transporte', async () => {
  const input = sample();
  const observed: { host: string; closed: boolean; message?: EmailMessage; options?: { requireTLS: boolean; tls: { rejectUnauthorized: boolean } } } = {
    host: '', closed: false,
  };
  const result = await sendInvoiceEmail(input, {
    assertPublicHost: async host => { observed.host = host; },
    createTransport: createdOptions => {
      observed.options = createdOptions;
      return {
        sendMail: async message => { observed.message = message; return { accepted: [message.to] }; },
        close: () => { observed.closed = true; },
      };
    },
  });
  assert.equal(result.recipientEmail, input.recipientEmail);
  assert.equal(observed.host, 'smtp.example.com');
  assert.equal(observed.options?.requireTLS, true);
  assert.equal(observed.options?.tls.rejectUnauthorized, true);
  assert.equal(observed.message?.to, input.recipientEmail);
  assert.equal(observed.closed, true);
});

test('no marca envío si SMTP rechaza el destinatario', async () => {
  let closed = false;
  await assert.rejects(sendInvoiceEmail(sample(), {
    assertPublicHost: async () => {},
    createTransport: () => ({
      sendMail: async () => ({ accepted: [] }),
      close: () => { closed = true; },
    }),
  }), /no aceptó el destinatario/);
  assert.equal(closed, true);
});
