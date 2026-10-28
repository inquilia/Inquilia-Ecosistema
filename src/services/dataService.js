// src/services/dataService.js
import { db } from "../config/firebase.js";
import { collection, addDoc, serverTimestamp } from "firebase/firestore";

/**
 * Guarda un registro fáctico de locación en Cloud Firestore asegurando
 * el cumplimiento de la Ley N° 25.326 y validando el consentimiento.
 * 
 * @param {Object} recordData - Datos fácticos del contrato y comportamiento.
 * @param {string} userId - UID del usuario autenticado (Inmobiliaria o Propietario).
 * @returns {Promise<string>} - ID del documento creado en Firestore.
 */
export async function saveVerifiedRentalRecord(recordData, userId) {
  // Validación de seguridad: Principio de defensa en profundidad
  if (!userId) {
    throw new Error("Acceso denegado: Se requiere un UID válido para registrar operaciones en el buró.");
  }

  if (!recordData || !recordData.consentVerified || !recordData.annexPhotoUrl) {
    throw new Error("Violación de cumplimiento normativo (Ley 25.326): No se puede persistir un registro sin consentimiento firmado y evidencia fotográfica.");
  }

  try {
    // Estructura de datos normalizada para Firestore
    const payload = {
      tenantName: recordData.name,
      tenantDni: recordData.dni,
      monthlyAmount: recordData.amount,
      contractPeriod: {
        start: recordData.start,
        end: recordData.end
      },
      behavior: {
        onTimeMonths: recordData.behavior.onTime,
        lateMonths: recordData.behavior.late,
        conservationStatus: recordData.behavior.conservation,
        debtActive: recordData.behavior.debtAmount
      },
      reputationScore: recordData.scoreRentia,
      compliancePercentage: recordData.paymentCompliance,
      legalEvidence: {
        annexPhotoUrl: recordData.annexPhotoUrl,
        consentVerified: true,
        standard: "Ley N° 25.326 (Habeas Data)"
      },
      metadata: {
        createdBy: userId,
        createdAt: serverTimestamp()
      }
    };

    // Escritura atómica en la colección protegida
    const docRef = await addDoc(collection(db, "verified_rentals"), payload);
    return docRef.id;

  } catch (error) {
    console.error("Error crítico en la capa de datos (Firestore):", error);
    throw new Error("Falla al registrar el contrato en la red: " + error.message);
  }
}