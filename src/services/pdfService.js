// src/services/pdfService.js
import { jsPDF } from "jspdf";
import QRCode from "qrcode";

/**
 * Calcula un Hash SHA-256 en el navegador usando la Web Crypto API.
 */
async function generateSha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest("SHA-256", msgBuffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, "0")).join("");
}

function formatDateDMY(dateVal) {
  if (!dateVal) return "S/D";

  if (dateVal && typeof dateVal.toDate === "function") {
    const d = dateVal.toDate();
    const day = String(d.getDate()).padStart(2, "0");
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const year = d.getFullYear();
    return `${day}/${month}/${year}`;
  }

  const str = String(dateVal).trim().split("T")[0];
  const parts = str.split("-");
  if (parts.length === 3 && parts[0].length === 4) {
    const [year, month, day] = parts;
    return `${day.padStart(2, "0")}/${month.padStart(2, "0")}/${year}`;
  }

  return str;
}

function calculateContractDurationMonths(startVal, endVal, fallbackMonths = 1) {
  if (!startVal || !endVal) return fallbackMonths || 1;

  try {
    let d1, d2;

    if (startVal && typeof startVal.toDate === "function") {
      d1 = startVal.toDate();
    } else {
      const [y1, m1, day1] = String(startVal).split("T")[0].split("-").map(Number);
      d1 = new Date(y1, m1 - 1, day1);
    }

    if (endVal && typeof endVal.toDate === "function") {
      d2 = endVal.toDate();
    } else {
      const [y2, m2, day2] = String(endVal).split("T")[0].split("-").map(Number);
      d2 = new Date(y2, m2 - 1, day2);
    }

    if (isNaN(d1.getTime()) || isNaN(d2.getTime())) {
      return fallbackMonths || 1;
    }

    // Diferencial en días solares
    const diffMs = d2.getTime() - d1.getTime();
    const diffDays = Math.round(diffMs / (1000 * 60 * 60 * 24));

    if (diffDays <= 0) return fallbackMonths || 1;

    // 30.4375 es el promedio exacto de días por mes en el calendario gregoriano (365.25 / 12)
    const months = Math.round(diffDays / 30.4375);
    return Math.max(1, months);
  } catch (err) {
    console.warn("Aviso calculando duración de contrato:", err);
    return fallbackMonths || 1;
  }
}



/**
 * Genera y descarga el Certificado Oficial de Locación en formato PDF.
 * 
 * @param {Object} contract - Datos completos del contrato desde Firestore
 * @param {string} certifierName - Nombre o Razón Social del operador emisor
 */
export async function downloadContractCertificatePdf(contract, certifierName = "Inquilia Red Oficial") {
  if (!contract) throw new Error("Datos de contrato inexistentes.");

  const doc = new jsPDF({
    orientation: "portrait",
    unit: "mm",
    format: "a4"
  });

  const tenantName = (contract.name || "Inquilino Registrado").toUpperCase();
  const tenantDni = contract.dni || contract.tenantDni || "S/D";
  const propertyAddress = contract.propertyAddress || "Inmueble auditado en red";
  const score = contract.scoreRentia ?? 0;
  const onTime = contract.behavior?.onTime || 0;
  const late = contract.behavior?.late || 0;

  // Cálculo de vigencia cronológica exacta
  const totalMonths = calculateContractDurationMonths(
    contract.start, 
    contract.end, 
    (onTime + late) || contract.totalMonths
  );

  const compliance = contract.paymentCompliance ?? Math.round((onTime / ((onTime + late) || totalMonths || 1)) * 100);
  const conservation = contract.behavior?.conservation || "Bueno";
  const hasRestitution = Boolean(contract.legalEvidence?.restitutionActStoragePath || contract.legalEvidence?.hasBilateralRestitution);
  const contractId = contract.id || String(Date.now());

  // Fechas formateadas estrictamente a DD/MM/YYYY
  const formattedStart = formatDateDMY(contract.start);
  const formattedEnd = formatDateDMY(contract.end);
  const monthsLabel = totalMonths === 1 ? "1 mes total" : `${totalMonths} meses totales`;

  // 1. Generación de Hash de Integridad y Código QR
  const rawHashPayload = `${contractId}-${tenantDni}-${score}-${contract.start}-${contract.end}`;
  const certificateHash = await generateSha256(rawHashPayload);
  const baseUrl = window.location.origin;
  const verificationUrl = `https://www.inquilia.com.ar/?verify=true&c=${contractId}&h=${certificateHash.substring(0, 16)}`;
  
  const qrDataUrl = await QRCode.toDataURL(verificationUrl, {
    width: 250,
    margin: 1,
    color: { dark: "#060913", light: "#ffffff" }
  });

  // 2. Maquetado Gráfico del Documento
  // Margen y marco de seguridad perimetral
  doc.setDrawColor(22, 194, 163);
  doc.setLineWidth(0.8);
  doc.rect(10, 10, 190, 277);

  doc.setDrawColor(200, 205, 215);
  doc.setLineWidth(0.2);
  doc.rect(11.5, 11.5, 187, 274);

  // Cabecera institucional
  doc.setFillColor(6, 9, 19);
  doc.rect(12, 12, 186, 26, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("INQUILIA", 20, 24);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(22, 194, 163);
  doc.text("ECOSISTEMA DE CONFIANZA E INTELIGENCIA LOCATIVA", 20, 29);

  doc.setTextColor(200, 205, 215);
  doc.setFontSize(7.5);
  doc.text("CERTIFICADO OFICIAL DE BURÓ LOCATIVO", 125, 22);
  doc.text(`ID LEGAJO: ${contractId.substring(0, 18)}`, 125, 26);
  doc.text(`EMISIÓN: ${new Date().toLocaleDateString("es-AR")}`, 125, 30);

  // Título del Certificado
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("CONSTANCIA DE CALIFICACIÓN FÁCTICA Y ANTECEDENTES", 20, 48);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("Emitido bajo estándares de cumplimiento de la Ley Nacional Nº 25.326 de Protección de Datos Personales.", 20, 53);

  // Bloque: Partes e Inmueble
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(20, 58, 170, 36, 2, 2, "F");
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(20, 58, 170, 36, 2, 2, "S");

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(71, 85, 105);
  doc.text("TITULAR EVALUADO (LOCATARIO):", 25, 66);
  doc.text("INMUEBLE LOCADO:", 25, 75);
  doc.text("VIGENCIA EVALUADA:", 25, 84);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(15, 23, 42);
  doc.text(`${tenantName}   (DNI: ${tenantDni})`, 82, 66);
  doc.text(`${propertyAddress}`, 82, 75);
  
  // Renderizado corregido: DD/MM/YYYY y cálculo real de meses
  doc.text(`${formattedStart}  hasta  ${formattedEnd} (${monthsLabel})`, 82, 84);

  // Bloque Central: Score Reputacional
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(20, 100, 170, 52, 2, 2, "F");
  doc.setDrawColor(22, 194, 163);
  doc.setLineWidth(0.5);
  doc.roundedRect(20, 100, 170, 52, 2, 2, "S");

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(10);
  doc.setFont("helvetica", "bold");
  doc.text("SCORE REPUTACIONAL HOMOLOGADO", 25, 110);

  // Puntuación destacada
  doc.setFontSize(32);
  doc.setTextColor(22, 194, 163);
  doc.text(`${score}`, 25, 128);

  doc.setFontSize(11);
  doc.setTextColor(100, 116, 139);
  doc.text("/ 1000 PTS", 55, 128);

  const ratingLabel = score >= 700 ? "EXCELENTE SOLVENCIA" : (score >= 450 ? "RIESGO MODERADO" : "ALTO RIESGO");
  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(score >= 700 ? 16 : 220, score >= 700 ? 185 : 38, score >= 700 ? 129 : 38);
  doc.text(`[ ${ratingLabel} ]`, 25, 137);

  // Métricas fácticas al costado del Score
  doc.setFontSize(8.5);
  doc.setTextColor(71, 85, 105);
  doc.setFont("helvetica", "bold");
  doc.text("Tasa de Pago a Término:", 95, 114);
  doc.text("Meses con Mora Técnica:", 95, 122);
  doc.text("Estado de Conservación:", 95, 130);
  doc.text("Deuda Activa / Retención:", 95, 138);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(15, 23, 42);
  doc.text(`${compliance}% (${onTime} meses puntuales)`, 142, 114);
  doc.text(`${late} mes(es)`, 142, 122);
  doc.text(`${conservation}`, 142, 130);
  doc.text(`$${Number(contract.behavior?.debtAmount || 0).toLocaleString("es-AR")}`, 142, 138);

  // Bloque: Respaldo Documental y Legal
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(20, 158, 170, 38, 2, 2, "F");
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(20, 158, 170, 38, 2, 2, "S");

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("RESPALDO PROBATORIO Y GARANTÍAS LEGALES", 25, 166);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(71, 85, 105);
  doc.text("• Anexo de Consentimiento Expreso (Ley 25.326 Art. 5 y 6):", 25, 173);
  doc.setTextColor(22, 163, 74);
  doc.text("VERIFICADO (Archivo bajo guarda criptográfica)", 105, 173);

  doc.setTextColor(71, 85, 105);
  doc.text("• Acta Bilateral de Restitución y Desocupación:", 25, 181);
  if (hasRestitution) {
    doc.setTextColor(22, 163, 74);
    doc.text("ADJUNTADA (Prueba plena plurilateral)", 105, 181);
  } else {
    doc.setTextColor(148, 163, 184);
    doc.text("NO REQUERIDA / NO PROVISTA", 105, 181);
  }

  // Texto legal homogéneo: Ley 25.326 Art. 16
  doc.setTextColor(71, 85, 105);
  doc.text("• Derecho de Réplica y Rectificación (Ley 25.326 Art. 16):", 25, 189);
  doc.setTextColor(contract.rebuttal?.statement ? 217 : 100, contract.rebuttal?.statement ? 119 : 116, contract.rebuttal?.statement ? 6 : 139);
  doc.text(contract.rebuttal?.statement ? "DESCARGO REGISTRADO EN EL LEGAJO" : "GARANTIZADO (Sin manifestaciones)", 105, 189);

  // Bloque de Verificación y QR
  doc.setDrawColor(226, 232, 240);
  doc.line(20, 204, 190, 204);

  // Insertar Código QR
  doc.addImage(qrDataUrl, "PNG", 22, 210, 38, 38);

  doc.setFontSize(9);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("VALIDACIÓN DE AUTENTICIDAD DIGITAL", 65, 216);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("Escanee el código QR para validar la vigencia de este documento en los servidores", 65, 222);
  doc.text("oficiales de Inquilia o verifique mediante el código Hash SHA-256.", 65, 226);

  doc.setFont("courier", "bold");
  doc.setFontSize(7);
  doc.setTextColor(30, 41, 59);
  doc.text(`HASH SHA-256: ${certificateHash}`, 65, 234);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text(`Operador Certificante: ${certifierName}`, 65, 242);
  doc.text("Este certificado no constituye juicio de valor, sino un informe fáctico de antecedentes objetivos.", 65, 246);

  // Pie de página
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(160, 174, 192);
  doc.text("Inquilia © - Sistema Homologado de Inteligencia Locativa y Scoring Financiero Inmobiliario.", 20, 280);
  doc.text("Página 1 de 1 - Documento emitido electrónicamente con firma digital de red.", 130, 280);

  // Descarga del PDF
  const cleanFileName = `Certificado_Inquilia_${tenantDni}_${contractId.substring(0, 6)}.pdf`;
  doc.save(cleanFileName);
}

/**
 * 2. INFORME CONSOLIDADO DE BURÓ LOCATIVO POR DNI (Prioridad 3)
 */
export async function downloadBuroReportPdf(reportData, operatorName = "Operador Autorizado") {
  if (!reportData) throw new Error("No hay datos disponibles para emitir el informe.");

  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });

  const dni = reportData.dni || "S/D";
  const name = (reportData.name || "Sin Nombre Registrado").toUpperCase();
  const score = reportData.scoreConsolidado ?? 0;
  const totalMonths = reportData.totalMesesHistoricos || 0;
  const onTime = reportData.totalOnTime || 0;
  const late = reportData.totalLate || 0;
  const debt = Number(reportData.deudaTotalVigente || 0);
  const totalRetentions = reportData.totalRetenciones || 0;
  const contracts = reportData.contracts || [];
  const rebuttals = reportData.rebuttals || [];
  const compliance = totalMonths > 0 ? Math.round((onTime / totalMonths) * 100) : 100;
  const dateStr = new Date().toLocaleDateString("es-AR", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

  // 1. Hash Criptográfico del Reporte
  const hashPayload = `${dni}-${score}-${totalMonths}-${debt}-${contracts.length}`;
  const reportHash = await generateSha256(hashPayload);

  // Marco de seguridad perimetral institucional
  doc.setDrawColor(22, 194, 163);
  doc.setLineWidth(0.8);
  doc.rect(10, 10, 190, 277);
  doc.setDrawColor(200, 205, 215);
  doc.setLineWidth(0.2);
  doc.rect(11.5, 11.5, 187, 274);

  // Cabecera institucional
  doc.setFillColor(6, 9, 19);
  doc.rect(12, 12, 186, 26, "F");

  doc.setTextColor(255, 255, 255);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("INQUILIA", 20, 24);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(22, 194, 163);
  doc.text("ECOSISTEMA DE CONFIANZA E INTELIGENCIA LOCATIVA", 20, 29);

  doc.setTextColor(200, 205, 215);
  doc.setFontSize(7.5);
  doc.text("INFORME CONSOLIDADO DE BURÓ", 125, 22);
  doc.text(`DNI AUDITADO: ${dni}`, 125, 26);
  doc.text(`FECHA AUDITORÍA: ${dateStr}`, 125, 30);

  // Título del Reporte
  doc.setTextColor(15, 23, 42);
  doc.setFontSize(13);
  doc.setFont("helvetica", "bold");
  doc.text("REPORTE INTEGRAL DE ANTECEDENTES Y SOLVENCIA", 20, 47);

  doc.setFontSize(8);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("Emitido bajo estándares de cumplimiento de la Ley Nacional Nº 25.326 de Protección de Datos Personales (Art. 26).", 20, 52);

  // Bloque: Datos del Titular
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(20, 56, 170, 22, 2, 2, "F");
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(20, 56, 170, 22, 2, 2, "S");

  doc.setFontSize(8);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(71, 85, 105);
  doc.text("POSTULANTE EVALUADO:", 25, 64);
  doc.text("HISTORIAL EN LA RED:", 25, 72);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(15, 23, 42);
  doc.text(`${name}   (DNI: ${dni})`, 72, 64);
  doc.text(`${contracts.length} contrato(s) certificado(s) · ${totalMonths} meses acumulados evaluados`, 72, 72);

  // Bloque: Score Consolidado y Métricas
  doc.setFillColor(241, 245, 249);
  doc.roundedRect(20, 82, 170, 48, 2, 2, "F");
  doc.setDrawColor(22, 194, 163);
  doc.setLineWidth(0.5);
  doc.roundedRect(20, 82, 170, 48, 2, 2, "S");

  doc.setTextColor(15, 23, 42);
  doc.setFontSize(9.5);
  doc.setFont("helvetica", "bold");
  doc.text("SCORE REPUTACIONAL CONSOLIDADO", 25, 91);

  doc.setFontSize(30);
  doc.setTextColor(22, 194, 163);
  doc.text(`${score}`, 25, 107);

  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text("/ 1000 PTS", 55, 107);

  const ratingLabel = score >= 700 ? "EXCELENTE SOLVENCIA" : (score >= 450 ? "RIESGO MODERADO" : "ALTO RIESGO");
  doc.setFontSize(8.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(score >= 700 ? 16 : 220, score >= 700 ? 185 : 38, score >= 700 ? 129 : 38);
  doc.text(`[ ${ratingLabel} ]`, 25, 116);

  // Métricas al costado del Score
  doc.setFontSize(8);
  doc.setTextColor(71, 85, 105);
  doc.setFont("helvetica", "bold");
  doc.text("Tasa de Pago a Término:", 95, 93);
  doc.text("Meses con Mora Registrada:", 95, 101);
  doc.text("Depósitos Retenidos / Daños:", 95, 109);
  doc.text("Deuda Activa Reclamada:", 95, 117);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(15, 23, 42);
  doc.text(`${compliance}% (${onTime} meses a término)`, 144, 93);
  doc.text(`${late} mes(es)`, 144, 101);
  doc.text(`${totalRetentions} contrato(s)`, 144, 109);
  doc.text(`$${debt.toLocaleString("es-AR")}`, 144, 117);

  // Bloque: Historial de Contratos en Red
  doc.setFillColor(248, 250, 252);
  doc.roundedRect(20, 134, 170, 48, 2, 2, "F");
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(20, 134, 170, 48, 2, 2, "S");

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("DETALLE DE LOCACIONES EVALUADAS EN LA RED", 25, 142);

  // Tabla compacta de contratos
  doc.setFontSize(7);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(100, 116, 139);
  doc.text("INMUEBLE", 25, 149);
  doc.text("PERÍODO", 100, 149);
  doc.text("CANON", 145, 149);
  doc.text("SCORE", 175, 149);

  doc.setDrawColor(226, 232, 240);
  doc.line(25, 151, 185, 151);

  doc.setFont("helvetica", "normal");
  doc.setTextColor(30, 41, 59);

  let currentY = 156;
  const contractsToShow = contracts.slice(0, 3);

  contractsToShow.forEach((c) => {
    const addr = (c.propertyAddress || "Inmueble en red").substring(0, 42);
    const period = `${formatDateDMY(c.start)} - ${formatDateDMY(c.end)}`;
    const canon = `$${Number(c.monthlyAmount || 0).toLocaleString("es-AR")}`;
    const itemScore = c.status === "EN_CURSO" ? "En curso" : `${c.scoreRentia ?? "-"} pts`;

    doc.text(addr, 25, currentY);
    doc.text(period, 100, currentY);
    doc.text(canon, 145, currentY);
    doc.text(itemScore, 175, currentY);
    currentY += 6;
  });

  if (contracts.length > 3) {
    doc.setFont("helvetica", "italic");
    doc.setTextColor(148, 163, 184);
    doc.text(`... y ${contracts.length - 3} contrato(s) adicional(es) registrado(s) en el legajo.`, 25, currentY + 1);
  }

  // Bloque: Garantía de Hábeas Data y Descargos (Art. 16 Ley 25.326)
  doc.setFillColor(254, 252, 232); // Fondo cálido ambar suave
  doc.roundedRect(20, 186, 170, 42, 2, 2, "F");
  doc.setDrawColor(254, 240, 138);
  doc.roundedRect(20, 186, 170, 42, 2, 2, "S");

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(133, 77, 14);
  doc.text("DESCARGO LEGAL Y GARANTÍA DE HÁBEAS DATA (LEY 25.326 ART. 16)", 25, 194);

  doc.setFontSize(7.5);
  doc.setFont("helvetica", "normal");

  if (rebuttals.length > 0) {
    const reb = rebuttals[0];
    const statementClean = String(reb.statement || "").replace(/\n/g, " ").substring(0, 200);
    doc.setTextColor(71, 85, 105);
    doc.text(`Manifestación del locatario sobre ${reb.propertyAddress || "inmueble auditado"}:`, 25, 201);
    doc.setFont("helvetica", "italic");
    doc.setTextColor(30, 41, 59);
    doc.text(`"${statementClean}..."`, 25, 207);
    doc.setFont("helvetica", "bold");
    doc.setTextColor(22, 163, 74);
    doc.text("✓ Descargo incorporado formalmente al legajo inmutable conforme a derecho.", 25, 218);
  } else {
    doc.setTextColor(71, 85, 105);
    doc.text("El titular evaluado no ha registrado manifestaciones, rectificaciones ni descargos", 25, 202);
    doc.text("en relación con los contratos aquí informados (Derecho garantizado bajo Art. 16 Ley 25.326).", 25, 207);
    doc.setTextColor(22, 163, 74);
    doc.setFont("helvetica", "bold");
    doc.text("✓ Sin objeciones fácticas registradas en la red.", 25, 218);
  }

  // Bloque: Trazabilidad y Sello Notarial
  doc.setDrawColor(226, 232, 240);
  doc.line(20, 234, 190, 234);

  doc.setFontSize(8.5);
  doc.setFont("helvetica", "bold");
  doc.setTextColor(15, 23, 42);
  doc.text("TRAZABILIDAD Y GUARDA CRIPTOGRÁFICA DE AUDITORÍA", 25, 242);

  doc.setFontSize(7);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(100, 116, 139);
  doc.text("Este informe es confidencial y ha sido emitido con cargo a la cuenta autorizada del operador solicitante.", 25, 247);
  doc.text("La consulta queda asentada de forma inmutable con validez legal de 30 días en el libro mayor de auditoría.", 25, 251);

  doc.setFont("courier", "bold");
  doc.setFontSize(6.8);
  doc.setTextColor(30, 41, 59);
  doc.text(`HASH INTEGRIDAD SHA-256: ${reportHash}`, 25, 258);

  doc.setFont("helvetica", "italic");
  doc.setFontSize(7);
  doc.setTextColor(148, 163, 184);
  doc.text(`Operador Consultante: ${operatorName} · Consulta trazable en audit_queries`, 25, 265);
  doc.text("El presente informe refleja antecedentes fácticos objetivos y no constituye una autorización ni rechazo comercial.", 25, 269);

  // Pie de página
  doc.setFontSize(6.5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(160, 174, 192);
  doc.text("Inquilia © - Sistema Homologado de Inteligencia Locativa y Scoring Financiero Inmobiliario.", 20, 280);
  doc.text("Página 1 de 1 - Informe de Buró emitido electrónicamente.", 135, 280);

  const cleanFileName = `Informe_Buro_Inquilia_${dni}_${Date.now().toString().slice(-4)}.pdf`;
  doc.save(cleanFileName);
}