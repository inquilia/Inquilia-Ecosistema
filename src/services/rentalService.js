// src/services/rentalService.js
import { 
  doc, 
  getDoc, 
  setDoc, 
  collection, 
  query, 
  where, 
  getDocs, 
  updateDoc, 
  serverTimestamp 
} from "firebase/firestore";
import { 
  ref, 
  uploadBytes, 
  getDownloadURL 
} from "firebase/storage";
import { db, auth, storage } from "../config/firebase.js";

/**
 * Registra un contrato con invitación digital (Particular o Inmobiliaria CUCIS),
 * calculando fechas, guardando propietario real, estructurando ubicación y tipología
 * para el censo nacional de alquileres, y subiendo el PDF del contrato si se adjunta.
 */
export async function createDirectRentalWithInvitation(rentalData, contractFile = null) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("Sesión no iniciada.");
  }

  // 1. Obtener datos del perfil actual en Firestore
  const userDocSnap = await getDoc(doc(db, "users", currentUser.uid));
  const userData = userDocSnap.exists() ? userDocSnap.data() : {};
  const isAgency = userData.role === 'MATRICULADO_CUCIS' || userData.role === 'AGENCY_OWNER' || !!userData.agencyId;

  // 2. Resolver Propietario: Si es inmobiliaria toma lo cargado en el modal; si es particular toma el usuario activo
  const ownerFullName = isAgency 
  ? (rentalData.landlordName || rentalData.propietarioNombre || 'Propietario')
  : (userData.nombreCompleto || userData.name || userData.displayName || 'Propietario');

  const ownerDni = isAgency
  ? String(rentalData.landlordDni || rentalData.propietarioDni || '').trim()
  : String(userData.dni || rentalData.propietarioDni || '').trim();

  // 3. Validar DNI y Monto
  const cleanTenantDni = String(rentalData.tenantDni || rentalData.dni || "").trim().replace(/\D/g, '');
  if (!/^\d{6,10}$/.test(cleanTenantDni)) {
    throw new Error("El DNI del inquilino es inválido.");
  }

  const amountNum = Number(rentalData.monthlyAmount || rentalData.monthlyRent);
  if (isNaN(amountNum) || amountNum <= 0) {
    throw new Error("El monto mensual debe ser un número válido mayor a cero.");
  }

  const rentalId = `RENT_DIR_${Date.now()}_${Math.floor(Math.random() * 1000)}`;

  // 4. Subida del archivo del contrato a Firebase Storage (si existe)
  let contractPdfUrl = '';
  if (contractFile) {
    const fileRef = ref(storage, `contracts/${rentalId}/contrato_locacion_${Date.now()}`);
    const uploadRes = await uploadBytes(fileRef, contractFile);
    contractPdfUrl = await getDownloadURL(uploadRes.ref);
  }

  // 5. Fechas: computar fecha de inicio y de fin calculada (evita 'undefined a undefined')
  const now = new Date();
  const fechaInicioStr = rentalData.startDate || now.toISOString().split('T')[0];
  const duracionMeses = Number(rentalData.durationMonths || rentalData.duration) || 24;
  
  const calcEndDate = new Date(fechaInicioStr);
  calcEndDate.setMonth(calcEndDate.getMonth() + duracionMeses);
  const fechaFinStr = rentalData.endDate || calcEndDate.toISOString().split('T')[0];

  // 6. Token y expiración (TTL 72 hs)
  const expiresAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
  const invitationToken = typeof crypto !== 'undefined' && crypto.randomUUID 
  ? crypto.randomUUID() 
  : Math.random().toString(36).substring(2) + Date.now().toString(36);

  // 7. Normalización y construcción granular del Inmueble (Censo Nacional)
  const street = (rentalData.street || "").trim();
  const number = (rentalData.number || "").trim();
  const floor = (rentalData.floor || "").trim();
  const apartment = (rentalData.apartment || "").trim();
  const neighborhood = (rentalData.neighborhood || "").trim();
  const city = (rentalData.city || "").trim();
  const province = (rentalData.province || "Salta").trim();
  const propertyType = (rentalData.propertyType || "1 Dormitorio").trim();

  // Ensamblar dirección legible para retrocompatibilidad
  const streetParts = [
    street, 
    number, 
    floor ? `${floor}°` : '', 
    apartment ? `Dpto ${apartment}` : ''
  ].filter(Boolean).join(' ');

  const fullAddress = rentalData.propertyAddress || [
    streetParts, 
    neighborhood, 
    city, 
    province
  ].filter(Boolean).join(', ');

  // 8. Payload unificado con doble compatibilidad de claves
  const payload = {
    rentalId,
    tipoOperacion: isAgency ? "ADMINISTRACION_INMOBILIARIA" : "DIRECTO_PARTICULAR",
    
    // Propietario / Locador
    propietarioUid: isAgency ? null : currentUser.uid,
    propietarioNombre: ownerFullName,
    landlordName: ownerFullName,
    propietarioDni: ownerDni,
    landlordDni: ownerDni,

    // Inquilino
    tenantUid: null,
    tenantDni: cleanTenantDni,
    dni: cleanTenantDni,
    tenantName: rentalData.tenantName || 'Inquilino',
    name: rentalData.tenantName || 'Inquilino',
    tenantEmail: rentalData.tenantEmail ? rentalData.tenantEmail.trim().toLowerCase() : "",

    // Inmueble y condiciones económicas
    propertyAddress: fullAddress,
    address: fullAddress,

    // Datos granulares directos (fáciles de indexar y filtrar)
    province,
    city,
    neighborhood,
    propertyType,
    street,
    number,
    floor,
    apartment,

    // Objeto consolidado para analítica y censo
    propertyDetails: {
      province,
      city,
      neighborhood,
      propertyType,
      street,
      number,
      floor,
      apartment
    },

    monthlyAmount: amountNum,
    monthlyRent: amountNum,
    currency: rentalData.currency || "ARS",

    // Fechas normalizadas
    startDate: fechaInicioStr,
    endDate: fechaFinStr,
    start: fechaInicioStr,
    end: fechaFinStr,
    durationMonths: duracionMeses,

    // Contrato PDF cargado
    contractPdfUrl: contractPdfUrl,

    // Estado e invitación
    status: "PENDIENTE_REGISTRO",
    invitationToken,
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    reputationScore: 500,

    legalEvidence: {
      consentVerified: false,
      acceptedViaInvitation: true,
      annexPhotoUrl: ""
    },

    metadata: {
      createdBy: currentUser.uid,
      certifiedByUid: currentUser.uid,
      agencyId: userData.agencyId || (isAgency ? currentUser.uid : null),
      agencyName: userData.fantasyName || userData.nombreInmobiliaria || (isAgency ? (userData.nombreCompleto || 'Inmobiliaria') : null),
      creatorRole: userData.role || (isAgency ? 'MATRICULADO_CUCIS' : 'LANDLORD'),
      createdAt: now.toISOString()
    }
  };

  await setDoc(doc(db, "verified_rentals", rentalId), payload);
  return payload;
}

/**
 * Obtiene los datos del contrato preliminar mediante el token de invitación.
 */
export async function getRentalInvitationByToken(invitationToken) {
  if (!invitationToken || typeof invitationToken !== 'string') {
    throw new Error("Token de invitación inválido.");
  }

  const rentalsRef = collection(db, "verified_rentals");
  // Se agrega el filtro de status para que coincida exactamente con la regla de seguridad
  const q = query(
    rentalsRef, 
    where("status", "==", "PENDIENTE_REGISTRO"),
    where("invitationToken", "==", invitationToken.trim())
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    throw new Error("La invitación no existe, ya fue aceptada o ha expirado.");
  }

  const rentalDoc = snap.docs[0];
  const data = rentalDoc.data();

  if (data.expiresAt && new Date() > new Date(data.expiresAt)) {
    throw new Error("Este enlace de invitación ha caducado (venció el plazo de 72 hs).");
  }

  return {
    id: rentalDoc.id,
    ...data,
    monthlyRent: data.monthlyAmount
  };
}
/**
 * Registra el consentimiento legal expreso (Ley 25.326) y activa el contrato.
 */
export async function acceptRentalInvitation(invitationToken) {
  if (!invitationToken || typeof invitationToken !== 'string') {
    throw new Error("Token de invitación inválido.");
  }

  const rentalsRef = collection(db, "verified_rentals");
  const q = query(
    rentalsRef, 
    where("status", "==", "PENDIENTE_REGISTRO"),
    where("invitationToken", "==", invitationToken.trim())
  );
  const snap = await getDocs(q);

  if (snap.empty) {
    throw new Error("No se encontró el contrato asociado a la invitación.");
  }

  const rentalDoc = snap.docs[0];
  const data = rentalDoc.data();

  if (data.expiresAt && new Date() > new Date(data.expiresAt)) {
    throw new Error("El plazo de 72 hs para aceptar esta invitación ha expirado.");
  }

  if (data.status !== "PENDIENTE_REGISTRO") {
    throw new Error("Este contrato ya ha sido firmado o se encuentra activo.");
  }

  const currentUser = auth.currentUser;
  const updateData = {
    status: "EN_CURSO",
    tenantUid: currentUser ? currentUser.uid : null,
    "legalEvidence.consentVerified": true,
    "legalEvidence.digitalSignatureTimestamp": serverTimestamp(),
    "legalEvidence.lawCompliance": "Ley 25.326 Art. 5 y 6 (Consentimiento Expreso Digital)",
    "metadata.activatedAt": serverTimestamp()
  };

  await updateDoc(doc(db, "verified_rentals", rentalDoc.id), updateData);

  return {
    success: true,
    rentalId: rentalDoc.id,
    message: "Contrato firmado y activado con éxito."
  };
}