/** Snapshot of SAT CFDI 4.0 catalogues. Review when the SAT publishes a newer workbook. */
export const fiscalCatalogSource = {
  url: 'http://omawww.sat.gob.mx/tramitesyservicios/Paginas/documentos/catCFDI_V_4_20261106.xls',
  published: '2026-11-06',
} as const;

export const regimenes = [
  { codigo: '601', nombre: 'General de Ley Personas Morales', personas: 'moral' },
  { codigo: '603', nombre: 'Personas Morales con Fines no Lucrativos', personas: 'moral' },
  { codigo: '605', nombre: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', personas: 'fisica' },
  { codigo: '606', nombre: 'Arrendamiento', personas: 'fisica' },
  { codigo: '607', nombre: 'Régimen de Enajenación o Adquisición de Bienes', personas: 'fisica' },
  { codigo: '608', nombre: 'Demás ingresos', personas: 'fisica' },
  { codigo: '610', nombre: 'Residentes en el Extranjero sin Establecimiento Permanente en México', personas: 'ambas' },
  { codigo: '611', nombre: 'Ingresos por Dividendos (socios y accionistas)', personas: 'fisica' },
  { codigo: '612', nombre: 'Personas Físicas con Actividades Empresariales y Profesionales', personas: 'fisica' },
  { codigo: '614', nombre: 'Ingresos por intereses', personas: 'fisica' },
  { codigo: '615', nombre: 'Régimen de los ingresos por obtención de premios', personas: 'fisica' },
  { codigo: '616', nombre: 'Sin obligaciones fiscales', personas: 'fisica' },
  { codigo: '620', nombre: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos', personas: 'moral' },
  { codigo: '621', nombre: 'Incorporación Fiscal', personas: 'fisica' },
  { codigo: '622', nombre: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras', personas: 'moral' },
  { codigo: '623', nombre: 'Opcional para Grupos de Sociedades', personas: 'moral' },
  { codigo: '624', nombre: 'Coordinados', personas: 'moral' },
  { codigo: '625', nombre: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', personas: 'fisica' },
  { codigo: '626', nombre: 'Régimen Simplificado de Confianza', personas: 'ambas' },
] as const;

/** `c_FormaPago` is distinct from `c_MetodoPago` (PUE/PPD). */
export const formasPago = [
  { codigo: '01', nombre: 'Efectivo' },
  { codigo: '02', nombre: 'Cheque nominativo' },
  { codigo: '03', nombre: 'Transferencia electrónica de fondos' },
  { codigo: '04', nombre: 'Tarjeta de crédito' },
  { codigo: '05', nombre: 'Monedero electrónico' },
  { codigo: '06', nombre: 'Dinero electrónico' },
  { codigo: '08', nombre: 'Vales de despensa' },
  { codigo: '12', nombre: 'Dación en pago' },
  { codigo: '13', nombre: 'Pago por subrogación' },
  { codigo: '14', nombre: 'Pago por consignación' },
  { codigo: '15', nombre: 'Condonación' },
  { codigo: '17', nombre: 'Compensación' },
  { codigo: '23', nombre: 'Novación' },
  { codigo: '24', nombre: 'Confusión' },
  { codigo: '25', nombre: 'Remisión de deuda' },
  { codigo: '26', nombre: 'Prescripción o caducidad' },
  { codigo: '27', nombre: 'A satisfacción del acreedor' },
  { codigo: '28', nombre: 'Tarjeta de débito' },
  { codigo: '29', nombre: 'Tarjeta de servicios' },
  { codigo: '30', nombre: 'Aplicación de anticipos' },
  { codigo: '31', nombre: 'Intermediario pagos' },
  { codigo: '99', nombre: 'Por definir' },
] as const;

const generalRegimenes = ['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626'];
const deductionRegimenes = ['605', '606', '607', '608', '611', '612', '614', '615', '625'];
const allRegimenes = regimenes.map(item => item.codigo);

export const usosCfdi = [
  { codigo: 'G01', nombre: 'Adquisición de mercancías', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'G02', nombre: 'Devoluciones, descuentos o bonificaciones', personas: 'ambas', regimenes: [...generalRegimenes, '616'] },
  { codigo: 'G03', nombre: 'Gastos en general', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I01', nombre: 'Construcciones', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I02', nombre: 'Mobiliario y equipo de oficina por inversiones', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I03', nombre: 'Equipo de transporte', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I04', nombre: 'Equipo de computo y accesorios', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I05', nombre: 'Dados, troqueles, moldes, matrices y herramental', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I06', nombre: 'Comunicaciones telefónicas', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I07', nombre: 'Comunicaciones satelitales', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'I08', nombre: 'Otra maquinaria y equipo', personas: 'ambas', regimenes: generalRegimenes },
  { codigo: 'D01', nombre: 'Honorarios médicos, dentales y gastos hospitalarios', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D02', nombre: 'Gastos médicos por incapacidad o discapacidad', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D03', nombre: 'Gastos funerales', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D04', nombre: 'Donativos', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D05', nombre: 'Intereses reales efectivamente pagados por créditos hipotecarios (casa habitación)', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D06', nombre: 'Aportaciones voluntarias al SAR', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D07', nombre: 'Primas por seguros de gastos médicos', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D08', nombre: 'Gastos de transportación escolar obligatoria', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D09', nombre: 'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'D10', nombre: 'Pagos por servicios educativos (colegiaturas)', personas: 'fisica', regimenes: deductionRegimenes },
  { codigo: 'S01', nombre: 'Sin efectos fiscales', personas: 'ambas', regimenes: allRegimenes },
  { codigo: 'CP01', nombre: 'Pagos', personas: 'ambas', regimenes: allRegimenes },
  { codigo: 'CN01', nombre: 'Nómina', personas: 'fisica', regimenes: ['605'] },
] as const;

const regimenCodes = new Set<string>(regimenes.map(item => item.codigo));
const formaPagoCodes = new Set<string>(formasPago.map(item => item.codigo));

export function isRegimenFiscal(value: string): boolean { return regimenCodes.has(value); }
export function isFormaPago(value: string): boolean { return formaPagoCodes.has(value); }
export function isRegimenCompatible(value: string, rfc: string): boolean {
  const item = regimenes.find(candidate => candidate.codigo === value);
  if (!item) return false;
  const persona = rfc.length === 12 ? 'moral' : rfc.length === 13 ? 'fisica' : null;
  return persona !== null && (item.personas === 'ambas' || item.personas === persona);
}
export function isUsoCfdiCompatible(uso: string, regimen: string, rfc?: string): boolean {
  const item = usosCfdi.find(candidate => candidate.codigo === uso);
  if (!item || !item.regimenes.some(code => code === regimen)) return false;
  if (!rfc) return true;
  const persona = rfc.length === 12 ? 'moral' : rfc.length === 13 ? 'fisica' : null;
  return persona !== null && (item.personas === 'ambas' || item.personas === persona);
}
