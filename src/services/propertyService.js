// src/services/propertyService.js
import { collection, doc, addDoc, getDocs, query, where, updateDoc, serverTimestamp } from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, auth, storage } from "../config/firebase.js";


/** * Registra un inmueble en la cartera corporativa de la inmobiliaria.*/
export async function createPropertyRecord(propertyData, imageFiles = []) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("Sesión no iniciada.");

  const propId = `PROP_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
  
// 1. Subida de fotos múltiples a Firebase Storage (Límite máximo: 15 fotos)
  const photoUrls = [];
  const filesToUpload = imageFiles.slice(0, 15); // 👈 Filtra y toma como máximo 15 archivos

  for (let i = 0; i < filesToUpload.length; i++) {
    const file = filesToUpload[i];
    const fileRef = ref(storage, `properties/${propId}/foto_${i}_${Date.now()}`);
    const uploadRes = await uploadBytes(fileRef, file);
    const url = await getDownloadURL(uploadRes.ref);
    photoUrls.push(url);
  }

  // 2. Construcción de dirección formateada
  const streetParts = [
    propertyData.street,
    propertyData.number,
    propertyData.floor ? `${propertyData.floor}°` : '',
    propertyData.apartment ? `Dpto ${propertyData.apartment}` : ''
  ].filter(Boolean).join(' ');

  const fullAddress = [
    streetParts,
    propertyData.neighborhood,
    propertyData.city,
    propertyData.province
  ].filter(Boolean).join(', ');

  // 3. Payload de la propiedad en src/services/propertyService.js
  const payload = {
    title: (propertyData.title || "").trim(),
    description: (propertyData.description || "").trim(), // 👈 CLAVE: Sin esto no se guarda la descripción
    operation: propertyData.operation || "ALQUILER_TRADICIONAL",
    propertyType: propertyData.propertyType || "1 Dormitorio",
    surfaceM2: Number(propertyData.surfaceM2) || 0,
    currency: propertyData.currency || "ARS",
    price: Number(propertyData.price) || 0,
    expenses: Number(propertyData.expenses) || 0,
    minScore: Number(propertyData.minScore) || 0,
    creditApto: Boolean(propertyData.creditApto),
    minNights: propertyData.minNights || null,
    maxGuests: propertyData.maxGuests || null,
    status: "DISPONIBLE",
    sharedInNetwork: Boolean(propertyData.sharedInNetwork),
    
    // Fotos
    photos: photoUrls,
    mainPhoto: photoUrls[0] || "",

    // Ubicación estructurada
    propertyAddress: fullAddress,
    province: propertyData.province || "Salta",
    city: propertyData.city || "",
    neighborhood: propertyData.neighborhood || "",
    street: propertyData.street || "",
    number: propertyData.number || "",
    floor: propertyData.floor || "",
    apartment: propertyData.apartment || "",

    // Trazabilidad y Autoría estricta
    agencyId: propertyData.agencyId || currentUser.uid,
    createdByUid: currentUser.uid, // 👈 Identifica únicamente a quien la subió
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  const docRef = await addDoc(collection(db, "properties"), payload);
  return { id: docRef.id, ...payload };
}

/** * Obtiene todas las propiedades pertenecientes a la inmobiliaria activa.*/
export async function getAgencyProperties(agencyId) {
  if (!agencyId) return [];
  const q = query(collection(db, "properties"), where("agencyId", "==", agencyId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/** * Actualiza el estado de una propiedad (ej: ALQUILADO, RESERVADO, DISPONIBLE)*/
export async function updatePropertyStatus(propertyId, newStatus) {
  const propRef = doc(db, "properties", propertyId);
  await updateDoc(propRef, {
    status: newStatus,
    updatedAt: serverTimestamp()
  });
}

/** * Obtiene las propiedades compartidas en la Red CUCIS por otras inmobiliarias.*/
export async function getNetworkProperties(excludeAgencyId) {
  const q = query(
    collection(db, "properties"),
    where("sharedInNetwork", "==", true),
    where("status", "==", "DISPONIBLE")
  );
  const snap = await getDocs(q);
  // Excluimos las propias para no duplicarlas con "Mi Cartera"
  return snap.docs
  .map(d => ({ id: d.id, ...d.data() }))
  .filter(p => !excludeAgencyId || p.agencyId !== excludeAgencyId);
}

/**
 * Cruza la búsqueda de un interesado contra la cartera propia y la Red CUCIS.
 */
export async function matchPropertiesForLead(leadCriteria, myAgencyId) {
  const maxBudget = Number(leadCriteria.budget) || Infinity;
  const targetType = (leadCriteria.preferredType || '').toLowerCase();

  // 1. Obtener inmuebles propios y de la red
  const ownProps = await getAgencyProperties(myAgencyId);
  const netProps = await getNetworkProperties(myAgencyId);

  const filterFn = (p) => {
    if (p.status !== 'DISPONIBLE') return false;
    if (maxBudget !== Infinity && p.price > maxBudget) return false;
    if (targetType && targetType !== 'cualquiera') {
      const pType = (p.propertyType || '').toLowerCase();
      if (!pType.includes(targetType) && !targetType.includes(pType)) return false;
    }
    return true;
  };

  return {
    ownMatches: ownProps.filter(filterFn),
    networkMatches: netProps.filter(filterFn)
  };
}

/**
 * Obtiene las propiedades disponibles de una inmobiliaria para el catálogo público.
 */
export async function getPublicAgencyCatalog(agencyId) {
  if (!agencyId) return { agency: null, properties: [] };

  const agencySnap = await getDoc(doc(db, "agencies", agencyId));
  const agencyData = agencySnap.exists() ? { id: agencySnap.id, ...agencySnap.data() } : null;

  const q = query(
    collection(db, "properties"),
    where("agencyId", "==", agencyId),
    where("status", "==", "DISPONIBLE")
  );
  const propsSnap = await getDocs(q);
  const properties = propsSnap.docs.map(d => ({ id: d.id, ...d.data() }));

  return { agency: agencyData, properties };
}