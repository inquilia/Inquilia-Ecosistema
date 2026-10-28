// src/services/leadService.js
import { collection, doc, addDoc, getDocs, query, where, updateDoc, serverTimestamp, deleteDoc } from "firebase/firestore";
import { db, auth } from "../config/firebase.js";

/**
 * Registra un nuevo interesado / lead en la inmobiliaria activa.
 */
export async function createLeadRecord(leadData) {
  const currentUser = auth.currentUser;
  if (!currentUser) throw new Error("Sesión no iniciada.");

  const payload = {
    name: leadData.name.trim(),
    dni: leadData.dni ? String(leadData.dni).replace(/\D/g, '') : '',
    phone: leadData.phone.trim(),
    email: leadData.email ? leadData.email.trim() : '',
    propertyId: leadData.propertyId || null,
    propertyTitle: leadData.propertyTitle || 'Búsqueda Abierta',
    budget: Number(leadData.budget) || 0,
    preferredType: leadData.preferredType || '',
    notes: leadData.notes ? leadData.notes.trim() : '',
    status: leadData.status || 'NUEVO', // NUEVO | CONTACTADO | EN_EVALUACION | GANADO | DESCARTADO
    
    // Trazabilidad CUCIS
    agencyId: leadData.agencyId || currentUser.uid,
    createdByUid: currentUser.uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  const docRef = await addDoc(collection(db, "leads"), payload);
  return { id: docRef.id, ...payload };
}

/**
 * Recupera todos los leads pertenecientes a la inmobiliaria activa.
 */
export async function getAgencyLeads(agencyId) {
  if (!agencyId) return [];
  const q = query(collection(db, "leads"), where("agencyId", "==", agencyId));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

/**
 * Actualiza el estado del interesado en el pipeline.
 */
export async function updateLeadStatus(leadId, newStatus) {
  const leadRef = doc(db, "leads", leadId);
  await updateDoc(leadRef, {
    status: newStatus,
    updatedAt: serverTimestamp()
  });
}