// src/services/agencyService.js
import { doc, getDoc, updateDoc, arrayUnion } from "firebase/firestore";
import { db, auth } from "../config/firebase.js";

/**
 * Vincula un usuario existente como operador de una agencia inmobiliaria.
 * Debe ser ejecutado exclusivamente por un usuario autenticado con rol MATRICULADO_CUCIS.
 */
export async function assignAgencyOperator(targetUserUid, agencyMatricula, permisosOperativos) {
  const currentUser = auth.currentUser;
  if (!currentUser) {
    throw new Error("No hay una sesión activa de administrador.");
  }

  // 1. Validar que el emisor de la acción sea el titular CUCIS de la agencia
  const adminDocRef = doc(db, "users", currentUser.uid);
  const adminSnap = await getDoc(adminDocRef);

  if (!adminSnap.exists()) {
    throw new Error("Perfil de administrador no encontrado.");
  }

  const adminData = adminSnap.data();
  const isAdminMatriculado = adminData.roles && adminData.roles.includes('MATRICULADO_CUCIS');
  const userMatricula = adminData.nroMatricula || adminData.contextoLaboral?.cucisMatriculaAgencia;

  if (!isAdminMatriculado || userMatricula !== String(agencyMatricula).trim()) {
    throw new Error("Acceso denegado: Solo el titular CUCIS de esta agencia puede vincular operadores.");
  }

  // 2. Obtener el perfil del usuario objetivo a vincular
  const targetUserRef = doc(db, "users", targetUserUid);
  const targetSnap = await getDoc(targetUserRef);

  if (!targetSnap.exists()) {
    throw new Error("El usuario a vincular no existe en el sistema.");
  }

  const targetData = targetSnap.data();

  // 3. Actualizar el documento del usuario aplicando el rol de operador y su contexto laboral
  const updatedContexto = {
    cucisMatriculaAgencia: String(agencyMatricula).trim(),
    nombreFantasiaAgencia: adminData.nombreFantasia || "Agencia Inmobiliaria",
    vinculoEstado: "ACTIVO",
    permisosOperativos: {
      consultarBuro: Boolean(permisosOperativos?.consultarBuro),
      emitirCertificados: Boolean(permisosOperativos?.emitirCertificados)
    }
  };

  const updatedRoles = targetData.roles.includes('OPERADOR_INMOBILIARIO') 
    ? targetData.roles 
    : [...targetData.roles, 'OPERADOR_INMOBILIARIO'];

  await updateDoc(targetUserRef, {
    roles: updatedRoles,
    contextoLaboral: updatedContexto,
    "metadata.updatedAt": new Date().toISOString()
  });

  return { success: true, targetUid: targetUserUid, agencia: agencyMatricula };
}