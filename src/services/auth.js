// src/services/auth.js
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut, 
  onAuthStateChanged,
  setPersistence,
  browserSessionPersistence
} from "firebase/auth";
import { doc, setDoc } from "firebase/firestore";
import { auth, db } from "../config/firebase.js";

// Configuración de Seguridad: Forzar la destrucción de la sesión al cerrar el navegador
setPersistence(auth, browserSessionPersistence).catch((error) => {
  console.error("Error crítico configurando la persistencia de sesión:", error);
});

/**
 * Transforma un DNI en un formato de email interno seguro para Firebase Auth.
 */
export function dniToEmail(dni) {
  const cleanDni = String(dni || '').trim().replace(/\D/g, '');
  if (!cleanDni) throw new Error("DNI inválido.");
  return `dni_${cleanDni}@inquilia.local`;
}

/**
 * Registra un nuevo usuario usando DNI y contraseña bajo el estándar LANDLORD.
 */
export async function registerUserWithDni(dni, password, additionalData = {}) {
  const cleanDni = dni.trim().replace(/\D/g, '');
  const email = dniToEmail(cleanDni);
  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const user = userCredential.user;
    const nowIso = new Date().toISOString();

    await setDoc(doc(db, "users", user.uid), {
      dni: cleanDni,
      email: email,
      role: 'LANDLORD',
      roles: ['LANDLORD'],
      creditos: 0,
      freeQueriesCount: 0,
      lastFreeQueryMonth: "",
      agencyId: null,
      status: 'ACTIVO',
      ...additionalData,
      createdAt: nowIso
    });

    return user;
  } catch (error) {
    console.error("Error en registro seguro:", error.code);
    if (error.code === 'auth/email-already-in-use') {
      throw new Error("El DNI ingresado ya se encuentra registrado.");
    }
    throw new Error("No se pudo completar el registro: " + error.message);
  }
}

/**
 * Autentica al usuario utilizando DNI y contraseña.
 */
export async function loginWithDni(dni, password) {
  const email = dniToEmail(dni);
  try {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    return userCredential.user;
  } catch (error) {
    console.error("Error en autenticación:", error.code);
    throw new Error("Credenciales inválidas o DNI no registrado.");
  }
}

/**
 * Cierra la sesión activa.
 */
export async function logoutUser() {
  try {
    await signOut(auth);
  } catch (error) {
    console.error("Error al cerrar sesión:", error);
  }
}

/**
 * Observador de estado de sesión en tiempo real.
 */
export function subscribeToAuthChanges(callback) {
  return onAuthStateChanged(auth, callback);
}

/**
 * Servicio de Recuperación de contraseña.
 * Nota técnica: Al usar correos internos (@inquilia.local), el blanqueo no puede usar
 * sendPasswordResetEmail desde el cliente sin autenticar. Requiere Cloud Function.
 */
export async function resetPasswordByDni(dni) {
  const cleanDni = dni.trim().replace(/\D/g, '');
  if (!cleanDni) {
    throw new Error("Debe ingresar un DNI válido.");
  }
  throw new Error("Para blanquear credenciales vinculadas a un DNI, contacte a soporte legal o utilice la validación asistida.");
}