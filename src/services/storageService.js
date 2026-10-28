// src/services/storageService.js
import { getStorage, ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { app } from "../config/firebase.js";

// Inicialización centralizada de Firebase Storage
const storage = getStorage(app);

/**
 * Sube la fotografía del anexo de consentimiento firmado (Obligatorio).
 * 
 * @param {string} userId - UID del usuario autenticado en Firestore/Auth.
 * @param {File} file - Objeto de archivo seleccionado en el formulario.
 * @returns {Promise<string>} URL pública segura de descarga.
 */
export async function uploadConsentAnnexPhoto(userId, file) {
  if (!file) {
    throw new Error("No se ha seleccionado ningún archivo de anexo.");
  }

  // 1. Límite de tamaño: 5 MB para prevenir abusos de cuota
  const MAX_SIZE_BYTES = 5 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error("La fotografía del anexo supera los 5 MB permitidos. Reduzca la resolución o comprima la imagen.");
  }

  // 2. Validación estricta de Tipo MIME
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/jpg'];
  if (!allowedMimeTypes.includes(file.type)) {
    throw new Error("Formato no válido para el anexo. Únicamente se admiten imágenes JPG o PNG.");
  }

  // 3. Sanitización y estructuración de ruta aislada (Tenant Isolation)
  const fileExtension = file.type === 'image/png' ? 'png' : 'jpg';
  const secureFileName = `${Date.now()}_anexo_firmado.${fileExtension}`;
  const storagePath = `consent_annexes/${userId}/${secureFileName}`;

  const storageRef = ref(storage, storagePath);

  const metadata = {
    contentType: file.type,
    customMetadata: {
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
      complianceStandard: "Ley 25.326",
      documentType: "ANEXO_CONSENTIMIENTO"
    }
  };

  try {
    const snapshot = await uploadBytes(storageRef, file, metadata);
    return await getDownloadURL(snapshot.ref);
  } catch (error) {
    console.error("Error al subir el anexo a Storage:", error);
    throw new Error("Falla de red al almacenar el anexo de consentimiento.");
  }
}

/**
 * Sube el Acta de Restitución y Desocupación de Inmueble (Optativo).
 * Admite formatos PDF e imágenes de actas firmadas.
 * 
 * @param {string} userId - UID del operador certificante.
 * @param {File} file - Archivo PDF o imagen del acta rubricada.
 * @returns {Promise<string|null>} URL de descarga o null si no se proveyó archivo.
 */
export async function uploadRestitutionActFile(userId, file) {
  if (!file) return null;

  // 1. Límite de tamaño: 10 MB (apto para PDFs escaneados de múltiples fojas)
  const MAX_SIZE_BYTES = 10 * 1024 * 1024;
  if (file.size > MAX_SIZE_BYTES) {
    throw new Error("El archivo del acta de restitución supera el límite de 10 MB.");
  }

  // 2. Validación de Tipo MIME admitiendo documentos PDF e imágenes
  const allowedMimeTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
  if (!allowedMimeTypes.includes(file.type)) {
    throw new Error("Formato no válido. El acta de restitución debe ser un documento PDF o imagen JPG/PNG.");
  }

  // 3. Sanitización estricta del nombre original contra Directory Traversal
  const cleanFileName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const timestamp = Date.now();
  const storagePath = `restitution_acts/${userId}/${timestamp}_${cleanFileName}`;

  const fileRef = ref(storage, storagePath);

  const metadata = {
    contentType: file.type,
    customMetadata: {
      uploadedBy: userId,
      uploadedAt: new Date().toISOString(),
      complianceStandard: "Ley 25.326",
      documentType: "ACTA_RESTITUCION_BILATERAL"
    }
  };

  try {
    const snapshot = await uploadBytes(fileRef, file, metadata);
    return await getDownloadURL(snapshot.ref);
  } catch (error) {
    console.error("Error al subir el acta de restitución a Storage:", error);
    throw new Error("Falla de red al almacenar el acta de restitución.");
  }
}