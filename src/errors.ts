/** Only these user-actionable validation messages may cross an API boundary. */
const expectedInputErrors = new Set([
  'Correo inválido', 'La contraseña debe tener entre 12 y 256 caracteres',
  'Formato de archivo no admitido', 'El archivo debe medir entre 1 byte y 15 MB',
  'Archivo no encontrado', 'Ticket no encontrado', 'Trabajo no encontrado',
  'Base64 inválido', 'El ticket supera 5 MB',
  'Guarda tu API key de OpenAI para buscar portales automáticamente',
  'Escribe el nombre del emisor del ticket',
  'La constancia corresponde a otro RFC. Actualiza el perfil fiscal antes de usarla.',
  'Completa y revisa tu perfil fiscal antes de facturar',
  'Nombre de dato del ticket inválido', 'Dato del ticket inválido', 'Demasiados campos del ticket',
  'La recuperación sólo se realiza en el portal',
  'La recuperación automática por token sólo está configurada para Primera Plus',
  'Configura SMTP en tu perfil para enviar solicitudes por correo',
  'Para la solicitud por correo, agrega tu domicilio completo o adjunta tu constancia',
  'No tienes una constancia guardada para adjuntar',
  'El correo de Primera Plus usa un destinatario fijo publicado por el emisor',
  'Indica un único correo del emisor que hayas revisado',
  'Guarda tu API key de OpenAI para explorar y automatizar este portal',
  'Token del boleto inválido',
  'El token de Primera Plus debe tener entre 9 y 25 caracteres alfanuméricos',
  'El correo automático de Primera Plus es para boletos sin token',
  'Ingresa el token para recuperar el CFDI',
  'No hay una sesión de navegador activa',
  'URL del portal inválida', 'El portal debe usar HTTPS público',
  'El destino debe ser un dominio público', 'El destino resuelve a una dirección no pública',
  'El nombre del emisor es inválido', 'Falta la API key de OpenAI',
  'El boleto supera el límite de 4 MB del portal; ingresa el token manualmente',
  'El adjunto tiene un formato no admitido', 'Falta el destinatario revisado',
  'La sesión ya terminó.', 'Durante la revisión del dominio sólo se puede continuar o cancelar.',
  'Coordenadas fuera del navegador.', 'Texto demasiado largo.', 'Tecla no permitida.',
]);

const expectedInputPrefixes = [
  'Completa los datos del ticket: ', 'Ya hay una recuperación en curso (',
  'Este ticket ya tiene un trabajo activo o enviado (',
];

export function publicInputErrorMessage(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const message = error.message;
  return expectedInputErrors.has(message) || expectedInputPrefixes.some(prefix => message.startsWith(prefix))
    ? message.slice(0, 500) : null;
}
