import { getStorage, ref, uploadBytes } from "firebase/storage";
import { getFunctions, httpsCallable } from "firebase/functions";
import { app } from "../config/firebase.js";

const storage = getStorage(app);
const functions = getFunctions(app);

// 1. Flujo original: Registro nuevo (DNI + Credencial)
export async function submitAndVerifyDocuments(userId, dniFile, credentialFile, inputDni, inputMatricula) {
  const maxSize = 5 * 1024 * 1024;
  if (dniFile.size > maxSize || credentialFile.size > maxSize) {
    throw new Error("Las imágenes pesan demasiado. Comprimilas antes de subir.");
  }

  const dniFilePath = `temp_docs/${userId}/dni_${Date.now()}.jpg`;
  const credentialFilePath = `temp_docs/${userId}/credential_${Date.now()}.jpg`;

  const dniRef = ref(storage, dniFilePath);
  const credentialRef = ref(storage, credentialFilePath);

  await uploadBytes(dniRef, dniFile);
  await uploadBytes(credentialRef, credentialFile);

  const verifyDocumentOcr = httpsCallable(functions, 'verifyDocumentOcr');
  
  try {
    const result = await verifyDocumentOcr({
      dniFilePath,
      credentialFilePath,
      inputDni,
      inputMatricula
    });
    return result.data;
  } catch (error) {
    throw new Error(error.message || "Falló la validación automática de los documentos.");
  }
}

// 2. Nuevo flujo: Upgrade desde Configuración (Solo Credencial)
export async function submitCredentialOnly(userId, credentialFile, inputMatricula, nombreFantasia) {
  const maxSize = 5 * 1024 * 1024;
  if (credentialFile.size > maxSize) {
    throw new Error("La credencial pesa demasiado. Comprimila antes de subir.");
  }

  const credentialFilePath = `temp_docs/${userId}/credential_upgrade_${Date.now()}.jpg`;
  const credentialRef = ref(storage, credentialFilePath);

  await uploadBytes(credentialRef, credentialFile);

  const verifyCredentialOcr = httpsCallable(functions, 'verifyCredentialOcr');
  
  try {
    const result = await verifyCredentialOcr({
      userId,
      credentialFilePath,
      inputMatricula,
      nombreFantasia // <--- Coma agregada correctamente aquí
    });
    return result.data;
  } catch (error) {
    throw new Error(error.message || "Falló la validación automática de la credencial CUCIS.");
  }
}