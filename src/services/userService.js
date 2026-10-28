// src/services/userService.js
import { createUserWithEmailAndPassword, deleteUser } from "firebase/auth";
import { doc, runTransaction, collection, query, where, getDocs, updateDoc } from "firebase/firestore";
import { auth, db } from "../config/firebase.js";

/**
 * Reclama automáticamente contratos en estado PENDIENTE_REGISTRO cuyo DNI 
 * coincide con el del nuevo usuario registrado.
 */
export async function claimPendingRentalsForNewUser(userUid, userDni) {
  try {
    const rentalsRef = collection(db, "verified_rentals");
    const q = query(
      rentalsRef, 
      where("tenantDni", "==", userDni),
      where("status", "==", "PENDIENTE_REGISTRO")
    );

    const querySnapshot = await getDocs(q);
    const now = new Date();

    for (const rentalDoc of querySnapshot.docs) {
      const rentalData = rentalDoc.data();
      const expiresAtDate = new Date(rentalData.expiresAt);

      if (expiresAtDate > now) {
        await updateDoc(rentalDoc.ref, {
          tenantUid: userUid,
          status: "PENDIENTE_INQUILINO",
          "metadata.claimedAt": now.toISOString()
        });
      }
    }
  } catch (err) {
    console.error("Error al reclamar contratos pendientes de registro:", err);
  }
}

/**
 * Registra un usuario exclusivamente como LANDLORD (Perfil Base Civil).
 * Previene la escalada de privilegios bloqueando la inyección de roles de agencia en el onboarding público.
 */
export async function registerCivilUser(formData) {
  if (!formData || typeof formData !== 'object') {
    throw new Error("Datos de formulario inválidos.");
  }

  const { dni, password, emailLegal, nombre, movil, condicionFiscal, consentLog } = formData;

  if (!dni || !password || !emailLegal || !nombre) {
    throw new Error("Faltan campos obligatorios de identificación y perfil.");
  }

  const cleanDni = dni.trim().replace(/\D/g, '');
  if (!/^\d{6,10}$/.test(cleanDni)) {
    throw new Error("El formato del DNI es inválido.");
  }

  if (typeof password !== 'string' || password.length < 8) {
    throw new Error("La contraseña debe tener al menos 8 caracteres.");
  }

  const authEmail = `dni_${cleanDni}@inquilia.local`;
  let user = null;

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, authEmail, password);
    user = userCredential.user;

    let clientIp = "0.0.0.0";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3000);
      const ipRes = await fetch('https://api.ipify.org?format=json', { signal: controller.signal });
      clearTimeout(timeoutId);
      if (ipRes.ok) {
        const ipData = await ipRes.json();
        if (ipData && typeof ipData.ip === 'string') clientIp = ipData.ip;
      }
    } catch (err) {
      console.warn("Aviso legal: IP externa no disponible, usando valor predeterminado.");
    }

    const nowIso = new Date().toISOString();

    const userProfilePayload = {
      dni: cleanDni,
      nombre: nombre.trim(),
      emailLegal: emailLegal.trim(),
      movil: movil ? movil.trim() : '',
      condicionFiscal: condicionFiscal || 'Consumidor Final',
      roles: ["LANDLORD"],
      role: "LANDLORD",
      creditos: 0,
      freeQueriesCount: 0,
      lastFreeQueryMonth: "",
      agencyId: null,
      status: "ACTIVO",
      identidadVerificada: true,
      credencialesAuth: { authEmail },
      contextoLaboral: null,
      legalConsentLog: {
        timestamp: nowIso,
        ipAddress: clientIp,
        consentVersion: "Ley 25.326 - INQUILIA 2026",
        ...(consentLog || {})
      },
      metadata: { createdAt: nowIso, updatedAt: nowIso }
    };

    const dniIndexRef = doc(db, "unique_indexes", `dni_${cleanDni}`);
    const userDocRef = doc(db, "users", user.uid);

    await runTransaction(db, async (transaction) => {
      const dniSnap = await transaction.get(dniIndexRef);
      if (dniSnap.exists()) {
        throw new Error("El DNI ingresado ya se encuentra registrado.");
      }

      transaction.set(dniIndexRef, { uid: user.uid, createdAt: nowIso });
      transaction.set(userDocRef, userProfilePayload);
    });

    await claimPendingRentalsForNewUser(user.uid, cleanDni);

    return userProfilePayload;

  } catch (error) {
    if (user && error.code !== 'auth/email-already-in-use') {
      try { await deleteUser(user); } catch (e) { console.error("Error en rollback:", e); }
    }
    if (error.code === 'auth/email-already-in-use') {
      throw new Error("Las credenciales o el DNI ya se encuentran registrados.");
    }
    throw new Error(error.message || "Error crítico en el alta de identidad.");
  }
}

export async function registerCivilDataWithClaim(userUid, userDni) {
  return await claimPendingRentalsForNewUser(userUid, userDni);
}