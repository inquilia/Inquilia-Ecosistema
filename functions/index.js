const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions");
const { onDocumentUpdated } = require("firebase-functions/v2/firestore");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const crypto = require("crypto"); // Módulo criptográfico nativo de Node.js

admin.initializeApp();
setGlobalOptions({ maxInstances: 10 });

// ============================================================================
// UTILIDADES DE CICLO DE FACTURACIÓN Y VENCIMIENTO
// ============================================================================

function isPackExpired(expiresAtField) {
  if (!expiresAtField) return false;
  const expDate = expiresAtField.toDate ? expiresAtField.toDate() : new Date(expiresAtField);
  return new Date() > expDate;
}

function calcularVencimientoCiclo(fechaBase, isSubscription = false) {
  const d = new Date(fechaBase);
  const targetMonth = d.getMonth() + 1;
  const targetYear = d.getFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = targetMonth % 12;

  const maxDaysInTargetMonth = new Date(targetYear, normalizedMonth + 1, 0).getDate();
  const billingDay = Math.min(d.getDate(), maxDaysInTargetMonth);

  const graceHours = isSubscription ? 24 : 0;
  return new Date(targetYear, normalizedMonth, billingDay, graceHours, 0, 0, -1);
}

const CREDIT_PACKS = {
  AGENCY_PACK_50: {
    title: "Inquilia Inmobiliarias - Pack 1 (50 Consultas Mensuales)",
    credits: 50,
    price: 80000,
    targetCollection: "agencies"
  },
  AGENCY_PACK_200: {
    title: "Inquilia Inmobiliarias - Pack 2 (200 Consultas Mensuales)",
    credits: 200,
    price: 150000,
    targetCollection: "agencies"
  },
  PARTICULAR_PACK_5: {
    title: "Inquilia Particulares - Pack 5 Consultas Adicionales",
    credits: 5,
    price: 10000,
    targetCollection: "users"
  }
};

/**
 * Valida la firma criptográfica x-signature de Mercado Pago (HMAC-SHA256).
 */
function validateMercadoPagoSignature(req, secret) {
  if (!secret || secret === "tu_clave_secreta_revelada_en_el_panel_de_mp") {
    return false;
  }

  const xSignature = req.headers["x-signature"];
  const xRequestId = req.headers["x-request-id"];
  const dataId = req.query["data.id"] || req.body?.data?.id || req.query.id;

  if (!xSignature || !xRequestId || !dataId) {
    return false;
  }

  let ts = null;
  let receivedHash = null;

  const parts = xSignature.split(",");
  for (const part of parts) {
    const [key, val] = part.split("=");
    if (key && val) {
      const trimmedKey = key.trim();
      const trimmedVal = val.trim();
      if (trimmedKey === "ts") ts = trimmedVal;
      if (trimmedKey === "v1") receivedHash = trimmedVal;
    }
  }

  if (!ts || !receivedHash) {
    return false;
  }

  // Manifiesto canónico según la especificación oficial de Mercado Pago:
  const manifest = `id:${dataId};request-id:${xRequestId};ts:${ts};`;

  const calculatedHash = crypto
    .createHmac("sha256", secret)
    .update(manifest)
    .digest("hex");

  const bufCalculated = Buffer.from(calculatedHash, "utf8");
  const bufReceived = Buffer.from(receivedHash, "utf8");

  if (bufCalculated.length !== bufReceived.length) {
    return false;
  }

  return crypto.timingSafeEqual(bufCalculated, bufReceived);
}

// ============================================================================
// 1. REGISTRO INICIAL (DNI + CREDENCIAL CUCIS)
// ============================================================================
exports.verifyDocumentOcr = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe iniciar sesión para verificar documentos.");
  }

  const { dniFilePath, credentialFilePath, inputDni, inputMatricula } = request.data;

  if (!dniFilePath || !credentialFilePath || !inputDni || !inputMatricula) {
    throw new HttpsError("invalid-argument", "Faltan parámetros requeridos para la verificación.");
  }

  try {
    const vision = require("@google-cloud/vision");
    const visionClient = new vision.ImageAnnotatorClient();
    const bucket = admin.storage().bucket();

    async function getTextFromFile(filePath) {
      const file = bucket.file(filePath);
      const [buffer] = await file.download();
      const [result] = await visionClient.textDetection(buffer);
      return result.fullTextAnnotation ? result.fullTextAnnotation.text : "";
    }

    const dniText = await getTextFromFile(dniFilePath);
    const credentialText = await getTextFromFile(credentialFilePath);

    const cleanDniText = dniText.replace(/\D/g, "");
    const cleanCredentialText = credentialText.replace(/\D/g, "");

    const cleanInputDni = inputDni.trim();
    const cleanMatricula = inputMatricula.trim();

    const dniValid = cleanDniText.includes(cleanInputDni);

    if (!dniValid) {
      throw new HttpsError("permission-denied", "El DNI de la imagen no coincide con el formulario.");
    }

    const credentialMatch = cleanCredentialText.includes(cleanMatricula) || cleanCredentialText.includes(cleanInputDni);

    if (!credentialMatch) {
      throw new HttpsError("permission-denied", "La credencial de CUCIS no es válida o no coincide con los datos.");
    }

    const userId = request.auth.uid;
    await admin.firestore().collection("users").doc(userId).update({
      role: "AGENCY_OWNER",
      roles: ["AGENCY_OWNER", "LANDLORD"],
      agencyId: userId,
      status: "ACTIVO",
      subscriptionActive: false,
      ocrVerified: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: "Documentación validada correctamente por OCR." };

  } catch (error) {
    logger.error("Error en OCR Cloud Function:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Error interno al procesar los documentos.");
  }
});

// ============================================================================
// 2. UPGRADE A MATRICULADO CUCIS DESDE CONFIGURACIÓN
// ============================================================================
exports.verifyCredentialOcr = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe iniciar sesión para verificar la credencial.");
  }

  const { userId, credentialFilePath, inputMatricula, nombreFantasia } = request.data;

  if (!userId || !credentialFilePath || !inputMatricula) {
    throw new HttpsError("invalid-argument", "Faltan parámetros requeridos para la verificación.");
  }

  try {
    const vision = require("@google-cloud/vision");
    const visionClient = new vision.ImageAnnotatorClient();
    const bucket = admin.storage().bucket();

    const userRef = admin.firestore().collection("users").doc(userId);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      throw new HttpsError("not-found", "No se encontró el registro del usuario.");
    }
    
    const userData = userDoc.data();
    const userDni = userData.dni;

    async function getTextFromFile(filePath) {
      const file = bucket.file(filePath);
      const [buffer] = await file.download();
      const [result] = await visionClient.textDetection(buffer);
      return result.fullTextAnnotation ? result.fullTextAnnotation.text : "";
    }

    const credentialText = await getTextFromFile(credentialFilePath);

    const cleanCredentialText = credentialText.replace(/\D/g, "");
    const cleanMatricula = inputMatricula.trim();
    const cleanDni = userDni ? userDni.trim() : "";

    const credentialMatch = cleanCredentialText.includes(cleanMatricula) || (cleanDni && cleanCredentialText.includes(cleanDni));

    if (!credentialMatch) {
      throw new HttpsError("permission-denied", "La credencial de CUCIS no es válida o no coincide con los datos del titular.");
    }

    let otherRoles = (userData.roles || [userData.role || "LANDLORD"])
      .map(r => (r === "PARTICULAR" || r === "PARTICULAR_PROPIETARIO") ? "LANDLORD" : r)
      .filter(r => r !== "AGENCY_OWNER" && r !== "MATRICULADO_CUCIS");

    if (!otherRoles.includes("LANDLORD")) otherRoles.push("LANDLORD");
    const currentRoles = ["AGENCY_OWNER", ...new Set(otherRoles)];

    await userRef.update({
      nroMatricula: cleanMatricula,
      nombreFantasia: nombreFantasia ? nombreFantasia.trim() : (userData.nombreFantasia || ""),
      roles: currentRoles,
      role: "AGENCY_OWNER",
      agencyId: userId,
      ocrVerified: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { success: true, message: "Credencial validada y perfil inmobiliario activado correctamente." };

  } catch (error) {
    logger.error("Error en verifyCredentialOcr Cloud Function:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Error interno al procesar la credencial.");
  }
});

// ============================================================================
// 3. CONSULTA SEGURA DE BURÓ Y DÉBITO EN LEDGER
// ============================================================================
exports.ejecutarConsultaInmobiliaria = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe iniciar sesión para operar.");
  }

  const operatorUid = request.auth.uid;
  const { targetDni, activeContext } = request.data;

  if (!targetDni) {
    throw new HttpsError("invalid-argument", "Falta el DNI a consultar.");
  }

  const db = admin.firestore();
  const operatorRef = db.collection("users").doc(operatorUid);
  const operatorSnap = await operatorRef.get();

  if (!operatorSnap.exists) {
    throw new HttpsError("not-found", "No se encontró el perfil del operador.");
  }

  const operatorData = operatorSnap.data();
  const roleUsed = activeContext || operatorData.role;
  const isAgente = roleUsed === "AGENCY_EMPLOYEE";
  const isTitular = roleUsed === "AGENCY_OWNER";
  const agencyId = operatorData.agencyId || (isTitular ? operatorUid : null);

  if ((isAgente || isTitular) && !agencyId) {
    throw new HttpsError("failed-precondition", "No se encontró una inmobiliaria matriz vinculada.");
  }

  try {
    return await db.runTransaction(async (transaction) => {
      let balanceBefore = 0;
      let balanceAfter = 0;

      if (isAgente || isTitular) {
        const agencyRef = db.collection("agencies").doc(agencyId);
        const agencySnap = await transaction.get(agencyRef);

        if (!agencySnap.exists) {
          throw new HttpsError("not-found", "La inmobiliaria matriz no existe en el sistema.");
        }

        const agencyData = agencySnap.data();
        const expired = isPackExpired(agencyData.creditsExpiresAt);
        balanceBefore = expired ? 0 : (agencyData.creditos || 0);

        if (balanceBefore <= 0) {
          throw new HttpsError(
            "resource-exhausted",
            expired
              ? "El ciclo mensual de la inmobiliaria ha vencido. Debe renovar su pack."
              : "La inmobiliaria matriz no tiene créditos disponibles."
          );
        }

        balanceAfter = balanceBefore - 1;
        transaction.update(agencyRef, { creditos: balanceAfter });
      }

      const auditRef = db.collection("audit_queries").doc();
      transaction.set(auditRef, {
        operatorUid,
        agencyId: (isAgente || isTitular) ? agencyId : null,
        targetDni: targetDni.trim(),
        roleUsed,
        usedFreeQuery: false,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      const txnRef = db.collection("credit_transactions").doc();
      transaction.set(txnRef, {
        agencyId: (isAgente || isTitular) ? agencyId : null,
        actorUid: operatorUid,
        type: "DEBIT",
        amount: -1,
        balanceBefore,
        balanceAfter,
        description: `Consulta de buró DNI ${targetDni.trim()}`,
        timestamp: admin.firestore.FieldValue.serverTimestamp()
      });

      return { success: true, message: "Consulta autorizada y registrada en el ledger." };
    });
  } catch (error) {
    logger.error("Error en ejecutarConsultaInmobiliaria:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", "Error al procesar la consulta segura.");
  }
});

// ============================================================================
// 4. CONTRATACIÓN DE PACKS Y SUSCRIPCIONES (MERCADO PAGO)
// ============================================================================
exports.iniciarContratacionPack = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debés iniciar sesión para contratar un pack.");
  }

  const { packId, mode = "ONE_TIME" } = request.data;
  const pack = CREDIT_PACKS[packId];

  if (!pack) {
    throw new HttpsError("invalid-argument", "El pack seleccionado no existe.");
  }

  const uid = request.auth.uid;
  const db = admin.firestore();
  const userSnap = await db.collection("users").doc(uid).get();

  if (!userSnap.exists) {
    throw new HttpsError("not-found", "Usuario no encontrado.");
  }

  const userData = userSnap.data();
  let targetDocId = uid;

  if (pack.targetCollection === "agencies") {
    const roles = userData.roles || [userData.role];
    if (!roles.includes("AGENCY_OWNER")) {
      throw new HttpsError("permission-denied", "Solo el titular de la inmobiliaria puede contratar packs corporativos.");
    }
    targetDocId = userData.agencyId || uid;
  }

  const mpAccessToken = process.env.MP_ACCESS_TOKEN;
  if (!mpAccessToken) {
    throw new HttpsError("internal", "Falta configurar MP_ACCESS_TOKEN en el servidor (functions/.env).");
  }

  const externalReference = JSON.stringify({
    targetCollection: pack.targetCollection,
    targetDocId: targetDocId,
    credits: pack.credits,
    packId: packId,
    actorUid: uid,
    isSubscription: mode === "SUBSCRIPTION"
  });

  try {
    if (mode === "SUBSCRIPTION") {
      const payerEmail = userData.emailLegal || (request.auth.token?.email && !request.auth.token.email.endsWith("@inquilia.local") ? request.auth.token.email : null);

      if (!payerEmail) {
        throw new HttpsError(
          "failed-precondition",
          "Debés tener un correo electrónico válido registrado en Configuración para adherir al débito automático."
        );
      }

      const preapprovalPayload = {
        payer_email: payerEmail,
        back_url: "https://www.inquilia.com.ar/",
        reason: pack.title,
        external_reference: externalReference,
        auto_recurring: {
          frequency: 1,
          frequency_type: "months",
          transaction_amount: pack.price,
          currency_id: "ARS"
        }
      };

      const response = await fetch("https://api.mercadopago.com/preapproval", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${mpAccessToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(preapprovalPayload)
      });

      const subData = await response.json();
      if (!response.ok) {
        logger.error("Error Mercado Pago PreApproval:", subData);
        throw new HttpsError("internal", subData.message || "Error al crear la suscripción en Mercado Pago.");
      }

      return {
        mode: "SUBSCRIPTION",
        id: subData.id,
        initPoint: subData.init_point
      };

    } else {
      const { MercadoPagoConfig, Preference } = require("mercadopago");
      const client = new MercadoPagoConfig({ accessToken: mpAccessToken });
      const preference = new Preference(client);

      const notificationUrl = process.env.MP_WEBHOOK_URL || "https://webhookmercadopago-4lyqkmj5ra-uc.a.run.app";

      const prefResponse = await preference.create({
        body: {
          items: [
            {
              id: packId,
              title: pack.title,
              quantity: 1,
              unit_price: pack.price,
              currency_id: "ARS"
            }
          ],
          external_reference: externalReference,
          notification_url: notificationUrl,
          back_urls: {
            success: "https://www.inquilia.com.ar/",
            failure: "https://www.inquilia.com.ar/",
            pending: "https://www.inquilia.com.ar/"
          },
          auto_return: "approved"
        }
      });

      return {
        mode: "ONE_TIME",
        id: prefResponse.id,
        initPoint: prefResponse.init_point
      };
    }

  } catch (error) {
    logger.error("Error creando preferencia/suscripción en Mercado Pago:", error);
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("internal", error.message || "No se pudo conectar con Mercado Pago. Verifique las credenciales.");
  }
});

// ============================================================================
// 5. WEBHOOK DE MERCADO PAGO CON VALIDACIÓN CRIPTOGRÁFICA (x-signature)
// ============================================================================
exports.webhookMercadoPago = onRequest(async (req, res) => {
  try {
    const type = req.query.type || req.query.topic || req.body?.type;
    const dataId = req.query.id || req.query["data.id"] || req.body?.data?.id;

    if (!dataId) return res.status(200).send("No ID");

    // ------------------------------------------------------------------------
    // VERIFICACIÓN DE FIRMA x-signature
    // ------------------------------------------------------------------------
    const webhookSecret = process.env.MP_WEBHOOK_SECRET;
    const isEmulator = process.env.FUNCTIONS_EMULATOR === "true";
    const hasConfiguredSecret = Boolean(webhookSecret && webhookSecret !== "tu_clave_secreta_revelada_en_el_panel_de_mp");

    if (!isEmulator && hasConfiguredSecret) {
      const isSignatureValid = validateMercadoPagoSignature(req, webhookSecret);
      if (!isSignatureValid) {
        logger.warn("Alerta de seguridad: Petición webhook rechazada por firma x-signature inválida o ausente.", {
          dataId,
          headers: req.headers
        });
        return res.status(401).send("Unauthorized: Invalid signature");
      }
    } else if (!isEmulator && !hasConfiguredSecret) {
      logger.warn("Aviso: MP_WEBHOOK_SECRET no está configurado en functions/.env. El webhook opera sin validar x-signature.");
    }

    const mpAccessToken = process.env.MP_ACCESS_TOKEN;
    const { MercadoPagoConfig, PreApproval, Payment } = require("mercadopago");
    const client = new MercadoPagoConfig({ accessToken: mpAccessToken });
    const db = admin.firestore();

    // Evento de suscripción (PreApproval)
    if (type === "subscription_preapproval" || type === "preapproval") {
      const preApprovalClient = new PreApproval(client);
      const subData = await preApprovalClient.get({ id: dataId });
      if (subData.external_reference) {
        const ref = JSON.parse(subData.external_reference);
        await db.collection(ref.targetCollection).doc(ref.targetDocId).update({
          subscriptionId: String(dataId),
          subscriptionStatus: subData.status,
          subscriptionPackId: ref.packId,
          "metadata.updatedAt": admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return res.status(200).send("Subscription status updated");
    }

    if (type !== "payment") {
      return res.status(200).send("Ignored event type");
    }

    let paymentData;

    // Bypass exclusivo para pruebas en emulador local
    if (isEmulator && (String(dataId) === "123456" || String(dataId) === "renew_789")) {
      paymentData = {
        id: dataId,
        status: "approved",
        transaction_amount: 80000,
        date_approved: new Date().toISOString(),
        external_reference: JSON.stringify({
          targetCollection: "agencies",
          targetDocId: "test_agency_123",
          credits: 50,
          packId: "AGENCY_PACK_50",
          actorUid: "test_user_123",
          isSubscription: String(dataId) === "renew_789"
        })
      };
    } else {
      const paymentClient = new Payment(client);
      paymentData = await paymentClient.get({ id: dataId });
    }

    if (!paymentData || !paymentData.external_reference) {
      return res.status(200).send("No external reference or payment not found");
    }

    const ref = JSON.parse(paymentData.external_reference);
    const targetRef = db.collection(ref.targetCollection).doc(ref.targetDocId);

    if (paymentData.status === "approved") {
      const txnRef = db.collection("credit_transactions").doc(`mp_${dataId}`);

      await db.runTransaction(async (transaction) => {
        const existingTxn = await transaction.get(txnRef);
        if (existingTxn.exists) return;

        const targetSnap = await transaction.get(targetRef);
        if (!targetSnap.exists) {
          throw new Error(`No existe ${ref.targetCollection}/${ref.targetDocId}`);
        }

        const currentData = targetSnap.data();
        const balanceBefore = currentData.creditos || 0;
        const newCredits = Number(ref.credits) || 0;

        // Inmobiliarias reinician cupo mensual; particulares acumulan compras adicionales
        const balanceAfter = ref.targetCollection === "agencies" 
          ? newCredits 
          : (balanceBefore + newCredits);

        const paymentDate = paymentData.date_approved ? new Date(paymentData.date_approved) : new Date();
        const expiresAtDate = calcularVencimientoCiclo(paymentDate, Boolean(ref.isSubscription));

        transaction.update(targetRef, {
          creditos: balanceAfter,
          activePlan: ref.packId,
          billingCycleStart: admin.firestore.Timestamp.fromDate(paymentDate),
          creditsExpiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
          "metadata.updatedAt": admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.set(txnRef, {
          agencyId: ref.targetCollection === "agencies" ? ref.targetDocId : null,
          actorUid: ref.actorUid,
          type: ref.isSubscription ? "SUBSCRIPTION_RENEWAL" : "PACK_PURCHASE",
          amount: newCredits,
          balanceBefore,
          balanceAfter,
          paymentId: String(dataId),
          amountPaidArs: paymentData.transaction_amount,
          packId: ref.packId,
          expiresAt: admin.firestore.Timestamp.fromDate(expiresAtDate),
          description: `${ref.isSubscription ? "Renovación Automática" : "Compra"} ${ref.packId} - Vigente hasta ${expiresAtDate.toLocaleDateString("es-AR")}`,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.status(200).send("Payment approved and processed");
    }

    if (paymentData.status === "refunded" || paymentData.status === "charged_back") {
      const refundTxnRef = db.collection("credit_transactions").doc(`mp_${dataId}_refund`);

      await db.runTransaction(async (transaction) => {
        const existingRefund = await transaction.get(refundTxnRef);
        if (existingRefund.exists) return;

        const targetSnap = await transaction.get(targetRef);
        if (!targetSnap.exists) return;

        const currentData = targetSnap.data();
        const balanceBefore = currentData.creditos || 0;
        const creditsToRevoke = Number(ref.credits) || 0;

        const balanceAfter = Math.max(0, balanceBefore - creditsToRevoke);

        transaction.update(targetRef, {
          creditos: balanceAfter,
          creditsExpiresAt: admin.firestore.FieldValue.serverTimestamp(),
          "metadata.updatedAt": admin.firestore.FieldValue.serverTimestamp()
        });

        transaction.set(refundTxnRef, {
          agencyId: ref.targetCollection === "agencies" ? ref.targetDocId : null,
          actorUid: ref.actorUid,
          type: paymentData.status === "charged_back" ? "CHARGEBACK" : "REFUND",
          amount: -creditsToRevoke,
          balanceBefore,
          balanceAfter,
          paymentId: String(dataId),
          amountPaidArs: -(paymentData.transaction_amount_refunded || paymentData.transaction_amount),
          packId: ref.packId,
          description: `Reversión por ${paymentData.status === "charged_back" ? "Contracargo" : "Devolución"} (${ref.packId})`,
          timestamp: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.status(200).send("Refund processed: credits revoked");
    }

    return res.status(200).send("Payment status ignored: " + paymentData.status);

  } catch (error) {
    logger.error("Error en webhookMercadoPago:", error);
    return res.status(500).send("Webhook Error");
  }
});

// ============================================================================
// 6. MOTOR DE SCORING MATEMÁTICO (LEY 25.326)
// ============================================================================
function calcularScoreLocativo(onTime, late, monthlyAmount, debtAmount, conservation) {
  const totalMonths = onTime + late;
  if (totalMonths <= 0) return 0;

  // 1. Puntualidad (Base 600)
  const punctualityScore = Math.round((onTime / totalMonths) * 600);

  // 2. Longevidad (Base 400)
  let longevityScore = 80;
  if (totalMonths >= 24) longevityScore = 400;
  else if (totalMonths >= 12) longevityScore = 300;
  else if (totalMonths >= 6) longevityScore = 180;

  // 3. Penalizaciones por deuda y deterioro
  let debtPenalty = 0;
  if (debtAmount > 0) {
    const monthsOwed = monthlyAmount > 0 ? (debtAmount / monthlyAmount) : 1;
    debtPenalty = 200 + Math.min(200, Math.round(monthsOwed * 50));
  }

  const damagePenalty = conservation === "Daños Documentados" ? 200 : 0;

  const rawScore = (punctualityScore + longevityScore) - debtPenalty - damagePenalty;
  return Math.max(0, Math.min(1000, rawScore));
}

// ============================================================================
// 7. ALTA DE CONTRATO ACTIVO CON IDENTIFICACIÓN DE INMUEBLE
// ============================================================================
exports.registrarContratoActivo = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe identificarse para registrar contratos vigentes.");
  }

  const uid = request.auth.uid;
  const { 
    tenantName, 
    tenantDni, 
    propertyAddress, 
    propietarioDni, 
    monthlyAmount, 
    start, 
    end, 
    annexStoragePath 
  } = request.data;

  if (!tenantName || !tenantDni || !propertyAddress || !propietarioDni || !monthlyAmount || !start || !end || !annexStoragePath) {
    throw new HttpsError("invalid-argument", "Faltan parámetros obligatorios del inmueble, partes o anexo.");
  }

  const db = admin.firestore();
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) throw new HttpsError("not-found", "Perfil de emisor no encontrado.");

  const userData = userDoc.data();
  const cleanTenantDni = String(tenantDni).replace(/\D/g, "");
  const cleanOwnerDni = String(propietarioDni).replace(/\D/g, "");
  const numMonthly = Number(monthlyAmount) || 0;

  const rentalRef = db.collection("verified_rentals").doc();

  await rentalRef.set({
    name: tenantName.trim(),
    dni: cleanTenantDni,
    tenantDni: cleanTenantDni,
    propertyAddress: propertyAddress.trim(),
    propietarioDni: cleanOwnerDni,
    monthlyAmount: numMonthly,
    start,
    end,
    status: "EN_CURSO",
    scoreRentia: null,
    paymentCompliance: null,
    totalMonths: 0,
    behavior: null,
    legalEvidence: {
      consentVerified: true,
      lawCompliance: "Ley 25.326 Art. 5 y 6 (Consentimiento Expreso)",
      annexStoragePath,
      signedTimestamp: admin.firestore.FieldValue.serverTimestamp()
    },
    metadata: {
      certifiedByUid: uid,
      certifierRole: userData.role || "LANDLORD",
      agencyId: userData.agencyId || null,
      certifierDni: userData.dni || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  return {
    success: true,
    contractId: rentalRef.id,
    message: "Contrato activo registrado correctamente."
  };
});

// ============================================================================
// 8. CIERRE Y CALIFICACIÓN DE EGRESO (CONTRATO EN CURSO -> BURÓ)
// ============================================================================
exports.finalizarYCalificarLocacion = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe iniciar sesión para calificar el egreso.");
  }

  const uid = request.auth.uid;
  const { 
    contractId, 
    onTime, 
    late, 
    conservation, 
    debtAmount, 
    restitutionActStoragePath = null 
  } = request.data;

  if (!contractId) {
    throw new HttpsError("invalid-argument", "Falta el identificador del contrato.");
  }

  const numOnTime = parseInt(onTime, 10) || 0;
  const numLate = parseInt(late, 10) || 0;
  const totalMonths = numOnTime + numLate;
  const numDebt = parseFloat(debtAmount) || 0;

  if (totalMonths <= 0) {
    throw new HttpsError("invalid-argument", "Debe asentar al menos 1 mes evaluado.");
  }

  const db = admin.firestore();
  const contractRef = db.collection("verified_rentals").doc(contractId);
  const contractSnap = await contractRef.get();

  if (!contractSnap.exists) {
    throw new HttpsError("not-found", "El contrato especificado no existe.");
  }

  const contractData = contractSnap.data();
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const userDni = userData.dni ? String(userData.dni).replace(/\D/g, "") : "";

  // Legitimación triple: Emisor original, Agencia matriz o Propietario directo por DNI
  const isCreator = contractData.metadata?.certifiedByUid === uid;
  const isSameAgency = userData.agencyId && contractData.metadata?.agencyId === userData.agencyId;
  const isPropertyOwner = userDni && contractData.propietarioDni === userDni;

  if (!isCreator && !isSameAgency && !isPropertyOwner) {
    throw new HttpsError("permission-denied", "No posee legitimación activa para cerrar este contrato.");
  }

  const monthlyAmount = Number(contractData.monthlyAmount) || 0;
  const scoreCalculado = calcularScoreLocativo(numOnTime, numLate, monthlyAmount, numDebt, conservation);
  const complianceRate = Math.round((numOnTime / totalMonths) * 100);

  const actorRole = isPropertyOwner && !isCreator && !isSameAgency 
    ? "PROPIETARIO_DIRECTO" 
    : (isSameAgency ? "INMOBILIARIA_ADMINISTRADORA" : "EMISOR_ORIGINAL");

  const updatePayload = {
    status: "FINALIZADO",
    scoreRentia: scoreCalculado,
    paymentCompliance: complianceRate,
    totalMonths,
    behavior: {
      onTime: numOnTime,
      late: numLate,
      conservation: conservation || "Bueno",
      debtAmount: numDebt,
      closedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    "legalEvidence.retentionLimitYears": numDebt > 0 ? 5 : 2,
    "legalEvidence.closedLawCompliance": "Ley 25.326 Art. 26",
    "metadata.finalizedAt": admin.firestore.FieldValue.serverTimestamp(),
    "metadata.finalizedByUid": uid,
    "metadata.finalizedByDni": userDni,
    "metadata.finalizedByRole": actorRole
  };

  if (restitutionActStoragePath) {
    updatePayload["legalEvidence.restitutionActStoragePath"] = restitutionActStoragePath;
    updatePayload["legalEvidence.hasBilateralRestitution"] = true;
  }

  await contractRef.update(updatePayload);

  return {
    success: true,
    contractId,
    calculatedScore: scoreCalculado,
    actorRole,
    message: "Locación cerrada y calificada con éxito en la red."
  };
});

// ============================================================================
// 9. CERTIFICACIÓN HISTÓRICA / RETROACTIVA (CONTRATOS YA CONCLUIDOS)
// ============================================================================
exports.certificarLocacionSegura = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe identificarse con DNI para emitir certificados.");
  }

  const uid = request.auth.uid;
  const {
    tenantName,
    tenantDni,
    propertyAddress,
    propietarioDni,
    monthlyAmount,
    start,
    end,
    onTime,
    late,
    conservation,
    debtAmount,
    annexStoragePath,
    restitutionActStoragePath = null
  } = request.data;

  if (!tenantName || !tenantDni || !monthlyAmount || !start || !end || !annexStoragePath) {
    throw new HttpsError("invalid-argument", "Faltan parámetros fácticos obligatorios o la evidencia del anexo.");
  }

  const db = admin.firestore();
  const userDoc = await db.collection("users").doc(uid).get();
  if (!userDoc.exists) throw new HttpsError("not-found", "Perfil emisor inexistente.");

  const userData = userDoc.data();
  const cleanTenantDni = String(tenantDni).replace(/\D/g, "");
  const cleanOwnerDni = propietarioDni ? String(propietarioDni).replace(/\D/g, "") : (userData.dni || "");
  const numMonthly = Number(monthlyAmount) || 0;
  const numOnTime = parseInt(onTime, 10) || 0;
  const numLate = parseInt(late, 10) || 0;
  const numDebt = parseFloat(debtAmount) || 0;

  const scoreCalculado = calcularScoreLocativo(numOnTime, numLate, numMonthly, numDebt, conservation);
  const complianceRate = (numOnTime + numLate) > 0 ? Math.round((numOnTime / (numOnTime + numLate)) * 100) : 100;

  const rentalRef = db.collection("verified_rentals").doc();

  await rentalRef.set({
    name: tenantName.trim(),
    dni: cleanTenantDni,
    tenantDni: cleanTenantDni,
    propertyAddress: (propertyAddress || "").trim(),
    propietarioDni: cleanOwnerDni,
    monthlyAmount: numMonthly,
    start,
    end,
    totalMonths: numOnTime + numLate,
    behavior: {
      onTime: numOnTime,
      late: numLate,
      conservation: conservation || "Bueno",
      debtAmount: numDebt,
      closedAt: admin.firestore.FieldValue.serverTimestamp()
    },
    scoreRentia: scoreCalculado,
    paymentCompliance: complianceRate,
    status: "FINALIZADO",
    legalEvidence: {
      consentVerified: true,
      lawCompliance: "Ley 25.326 Art. 5, 6 y 26",
      annexStoragePath,
      restitutionActStoragePath: restitutionActStoragePath || null,
      hasBilateralRestitution: Boolean(restitutionActStoragePath),
      signedTimestamp: admin.firestore.FieldValue.serverTimestamp(),
      retentionLimitYears: numDebt > 0 ? 5 : 2
    },
    metadata: {
      certifiedByUid: uid,
      certifierRole: userData.role || "LANDLORD",
      agencyId: userData.agencyId || null,
      certifierDni: userData.dni || "",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      finalizedAt: admin.firestore.FieldValue.serverTimestamp()
    }
  });

  return {
    success: true,
    certificateId: rentalRef.id,
    calculatedScore: scoreCalculado
  };
});

// ============================================================================
// 10. MARCAR DEUDA SALDADA Y REDUCIR PLAZO A 2 AÑOS (LEY 25.326 ART. 26)
// ============================================================================
exports.marcarDeudaSaldada = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe identificarse para registrar cancelaciones.");
  }

  const uid = request.auth.uid;
  const { contractId, fechaPago = null, notaCancelacion = "" } = request.data;

  if (!contractId) {
    throw new HttpsError("invalid-argument", "Falta el identificador del contrato.");
  }

  const db = admin.firestore();
  const contractRef = db.collection("verified_rentals").doc(contractId);
  const contractSnap = await contractRef.get();

  if (!contractSnap.exists) {
    throw new HttpsError("not-found", "El contrato no existe.");
  }

  const contractData = contractSnap.data();
  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const userDni = userData.dni ? String(userData.dni).replace(/\D/g, "") : "";

  // Legitimación: Creador, Agencia Matriz o Propietario por DNI
  const isCreator = contractData.metadata?.certifiedByUid === uid;
  const isSameAgency = userData.agencyId && contractData.metadata?.agencyId === userData.agencyId;
  const isPropertyOwner = userDni && contractData.propietarioDni === userDni;

  if (!isCreator && !isSameAgency && !isPropertyOwner) {
    throw new HttpsError("permission-denied", "No posee legitimación para certificar la extinción de la deuda.");
  }

  const effectiveSettledDate = fechaPago ? new Date(fechaPago) : new Date();
  
  // Plazo legal: 2 años desde la fecha de extinción de la obligación
  const purgeDate = new Date(effectiveSettledDate);
  purgeDate.setFullYear(purgeDate.getFullYear() + 2);

  // Recálculo fáctico del Score al extinguirse la deuda (se retira la penalización de deuda)
  const behavior = contractData.behavior || {};
  const onTime = behavior.onTime || 0;
  const late = behavior.late || 0;
  const monthlyAmount = Number(contractData.monthlyAmount) || 0;
  const conservation = behavior.conservation || "Bueno";
  
  // Recalcular Score sin penalización por deuda activa ($0)
  const nuevoScore = calcularScoreLocativo(onTime, late, monthlyAmount, 0, conservation);

  await contractRef.update({
    "behavior.debtAmount": 0,
    "behavior.settlementStatus": "SALDADA",
    "behavior.debtSettledAt": admin.firestore.Timestamp.fromDate(effectiveSettledDate),
    "behavior.settlementNote": notaCancelacion.trim(),
    "legalEvidence.retentionLimitYears": 2,
    "legalEvidence.purgeLimitDate": admin.firestore.Timestamp.fromDate(purgeDate),
    "legalEvidence.settlementLawCompliance": "Ley 25.326 Art. 26 Inc. 4 (Plazo reducido a 2 años por cancelación)",
    scoreRentia: nuevoScore,
    "metadata.settledByUid": uid,
    "metadata.settledAt": admin.firestore.FieldValue.serverTimestamp()
  });

  return {
    success: true,
    contractId,
    nuevoScore,
    purgeLimitDate: purgeDate.toLocaleDateString("es-AR"),
    message: "Deuda asentada como saldada. Plazo de conservación reducido legalmente a 2 años."
  };
});

// ============================================================================
// 11. PURGA AUTOMÁTICA DE ANTECEDENTES CADUCOS (CLOUD SCHEDULER)
// Se ejecuta todos los domingos a las 03:00 AM (Hora de Salta, Argentina)
// ============================================================================
exports.purgarAntecedentesCaducos = onSchedule({
  schedule: "0 3 * * 0",
  timeZone: "America/Argentina/Salta",
  memory: "256MiB"
}, async (event) => {
  const db = admin.firestore();
  const now = new Date();
  logger.info(`[Habeas Data Art. 26] Iniciando proceso de auditoría y purga legal: ${now.toISOString()}`);

  try {
    const rentalsSnap = await db.collection("verified_rentals")
      .where("status", "==", "FINALIZADO")
      .get();

    if (rentalsSnap.empty) {
      logger.info("[Habeas Data Art. 26] No hay contratos finalizados para auditar.");
      return;
    }

    const batch = db.batch();
    let totalPurgados = 0;

    rentalsSnap.forEach((docSnap) => {
      const data = docSnap.data();
      const closedAt = data.behavior?.closedAt?.toDate ? data.behavior.closedAt.toDate() : (data.metadata?.finalizedAt?.toDate ? data.metadata.finalizedAt.toDate() : null);
      const settledAt = data.behavior?.debtSettledAt?.toDate ? data.behavior.debtSettledAt.toDate() : null;
      const debtAmount = Number(data.behavior?.debtAmount) || 0;
      const isSettled = data.behavior?.settlementStatus === "SALDADA";

      let debePurgarse = false;
      let causal = "";

      // CASO 1: Deuda saldada -> Caduca a los 2 años desde la fecha de cancelación
      if (isSettled && settledAt) {
        const diffYears = (now - settledAt) / (1000 * 60 * 60 * 24 * 365.25);
        if (diffYears >= 2) {
          debePurgarse = true;
          causal = `Obligación saldada superó 2 años (Cancelada el ${settledAt.toLocaleDateString("es-AR")})`;
        }
      }
      // CASO 2: Contrato sin deuda (Al día) -> Caduca a los 2 años desde el egreso
      else if (debtAmount === 0 && closedAt) {
        const diffYears = (now - closedAt) / (1000 * 60 * 60 * 24 * 365.25);
        if (diffYears >= 2) {
          debePurgarse = true;
          causal = `Antecedente ordinario cumplió 2 años de guarda (Cerrado el ${closedAt.toLocaleDateString("es-AR")})`;
        }
      }
      // CASO 3: Deuda impaga persistente -> Caduca a los 5 años desde el egreso
      else if (debtAmount > 0 && closedAt) {
        const diffYears = (now - closedAt) / (1000 * 60 * 60 * 24 * 365.25);
        if (diffYears >= 5) {
          debePurgarse = true;
          causal = `Deuda impaga alcanzó el límite legal de 5 años (Cerrado el ${closedAt.toLocaleDateString("es-AR")})`;
        }
      }

      if (debePurgarse) {
        // Anonimización irreversible: se eliminan los identificadores personales
        // permitiendo conservar métricas estadísticas agregadas pero sin rastro de la persona
        batch.update(docSnap.ref, {
          status: "EXPURGADO_LEY_25326",
          dni: admin.firestore.FieldValue.delete(),
          tenantDni: admin.firestore.FieldValue.delete(),
          name: "REGISTRO EXPURGADO ART. 26",
          propertyAddress: "Inmueble Anonimizado",
          rebuttal: admin.firestore.FieldValue.delete(),
          "legalEvidence.annexStoragePath": admin.firestore.FieldValue.delete(),
          "legalEvidence.restitutionActStoragePath": admin.firestore.FieldValue.delete(),
          purgedAt: admin.firestore.FieldValue.serverTimestamp(),
          purgeCausal: causal
        });
        totalPurgados++;
      }
    });

    if (totalPurgados > 0) {
      await batch.commit();
      logger.info(`[Habeas Data Art. 26] Se anonimizaron con éxito ${totalPurgados} legajo(s) caduco(s).`);
    } else {
      logger.info("[Habeas Data Art. 26] Todos los legajos vigentes se encuentran dentro de los plazos legales.");
    }
  } catch (err) {
    logger.error("[Habeas Data Art. 26] Error durante la purga programada:", err);
  }
});

// ============================================================================
// 12. TRASPASO O DESVINCULACIÓN DE ADMINISTRACIÓN (EN_CURSO)
// ============================================================================
exports.transferirAdministracionContrato = onCall(async (request) => {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Debe identificarse para transferir contratos.");
  }

  const uid = request.auth.uid;
  const { contractId, action = "TRANSFER", nuevaMatriculaCucis = null } = request.data;

  if (!contractId) {
    throw new HttpsError("invalid-argument", "Falta el identificador del contrato.");
  }

  const db = admin.firestore();
  const contractRef = db.collection("verified_rentals").doc(contractId);
  const contractSnap = await contractRef.get();

  if (!contractSnap.exists) {
    throw new HttpsError("not-found", "El contrato no existe.");
  }

  const contractData = contractSnap.data();

  // Solo contratos en curso pueden traspasarse (los finalizados son legajos archivados)
  if (contractData.status !== "EN_CURSO") {
    throw new HttpsError("failed-precondition", "Solo se puede transferir la administración de contratos en curso.");
  }

  const userDoc = await db.collection("users").doc(uid).get();
  const userData = userDoc.exists ? userDoc.data() : {};
  const userDni = userData.dni ? String(userData.dni).replace(/\D/g, "") : "";

  // Legitimación: Inmobiliaria actualmente asignada o el Propietario titular por DNI
  const isCurrentAgency = userData.agencyId && contractData.metadata?.agencyId === userData.agencyId;
  const isAgencyOwnerDirect = contractData.metadata?.agencyId === uid || contractData.metadata?.certifiedByUid === uid;
  const isPropertyOwner = userDni && contractData.propietarioDni === userDni;

  if (!isCurrentAgency && !isAgencyOwnerDirect && !isPropertyOwner) {
    throw new HttpsError("permission-denied", "No posee legitimación activa para modificar la administración de este contrato.");
  }

  const previousAgencyId = contractData.metadata?.agencyId || null;

  // CASO A: Desvinculación pura (Retorno a administración directa del propietario)
  if (action === "UNLINK") {
    await contractRef.update({
      "metadata.agencyId": null,
      "metadata.transferredAt": admin.firestore.FieldValue.serverTimestamp(),
      "metadata.previousAgencyId": previousAgencyId,
      "metadata.transferredByUid": uid,
      "metadata.transferredByRole": isPropertyOwner ? "PROPIETARIO" : "INMOBILIARIA_SALIENTE"
    });

    return {
      success: true,
      action: "UNLINK",
      message: "Se desvinculó la inmobiliaria. La locación permanece en curso bajo administración directa del propietario."
    };
  }

  // CASO B: Transferencia a nueva inmobiliaria por matrícula CUCIS
  const cleanMatricula = String(nuevaMatriculaCucis || "").trim();
  if (!cleanMatricula) {
    throw new HttpsError("invalid-argument", "Debe indicar la matrícula CUCIS de la nueva inmobiliaria.");
  }

  const agenciesQuery = await db.collection("agencies")
    .where("nroMatricula", "==", cleanMatricula)
    .where("status", "==", "ACTIVO")
    .limit(1)
    .get();

  if (agenciesQuery.empty) {
    throw new HttpsError("not-found", `No se encontró ninguna inmobiliaria activa con matrícula CUCIS Nº ${cleanMatricula}.`);
  }

  const targetAgencyDoc = agenciesQuery.docs[0];
  const targetAgencyId = targetAgencyDoc.id;
  const targetAgencyData = targetAgencyDoc.data();

  if (targetAgencyId === previousAgencyId) {
    throw new HttpsError("invalid-argument", "El contrato ya se encuentra asignado a esa inmobiliaria.");
  }

  await contractRef.update({
    "metadata.agencyId": targetAgencyId,
    "metadata.transferredAt": admin.firestore.FieldValue.serverTimestamp(),
    "metadata.previousAgencyId": previousAgencyId,
    "metadata.transferredByUid": uid,
    "metadata.transferredByRole": isPropertyOwner ? "PROPIETARIO" : "INMOBILIARIA_SALIENTE",
    "metadata.newAgencyName": targetAgencyData.name || "Inmobiliaria CUCIS",
    "metadata.newAgencyMatricula": cleanMatricula
  });

  return {
    success: true,
    action: "TRANSFER",
    agencyName: targetAgencyData.name || "Inmobiliaria CUCIS",
    message: `Contrato transferido con éxito a ${targetAgencyData.name || "la nueva inmobiliaria"} (Mat. ${cleanMatricula}).`
  };
});

// ============================================================================
// 13. VENCIMIENTO AUTOMÁTICO DE DISPUTAS - PLAZO LEGAL (LEY 25.326 ART. 16)
// Se ejecuta de lunes a viernes a las 03:00 AM (Hora de Salta, Argentina)
// Si la parte informante no se expide en 5 días hábiles, se resuelve cautelarmente
// ============================================================================

function calcularFechaLimiteHabiles(fechaInicio, diasHabiles = 5) {
  let fecha = new Date(fechaInicio);
  let agregados = 0;

  while (agregados < diasHabiles) {
    fecha.setDate(fecha.getDate() + 1);
    const diaSemana = fecha.getDay(); // 0 = Domingo, 6 = Sábado
    if (diaSemana !== 0 && diaSemana !== 6) {
      agregados++;
    }
  }
  return fecha;
}

function haVencidoPlazoDisputa(fechaEnvio, diasHabiles = 5) {
  if (!fechaEnvio) return false;
  const limite = calcularFechaLimiteHabiles(fechaEnvio, diasHabiles);
  return new Date() > limite;
}

exports.verificarPlazosDisputasLey25326 = onSchedule({
  schedule: "0 3 * * 1-5", // Lunes a viernes a las 03:00 AM
  timeZone: "America/Argentina/Salta",
  memory: "256MiB"
}, async (event) => {
  const db = admin.firestore();
  logger.info("[Ley 25.326 Art. 16] Iniciando control de vencimiento de disputas en revisión...");

  try {
    const snap = await db.collection("verified_rentals")
      .where("dispute.status", "==", "PENDING")
      .get();

    if (snap.empty) {
      logger.info("[Ley 25.326 Art. 16] No hay disputas pendientes para verificar.");
      return;
    }

    const batch = db.batch();
    let expirados = 0;

    snap.forEach((doc) => {
      const data = doc.data();
      const submittedAt = data.dispute?.submittedAt?.toDate 
        ? data.dispute.submittedAt.toDate() 
        : (data.dispute?.submittedAt ? new Date(data.dispute.submittedAt) : null);

      if (submittedAt && haVencidoPlazoDisputa(submittedAt, 5)) {
        const docRef = db.collection("verified_rentals").doc(doc.id);

        // Recalcular Score sin penalización de deuda (restitución cautelar obligatoria)
        const behavior = data.behavior || {};
        const onTime = behavior.onTime || 0;
        const late = behavior.late || 0;
        const monthlyAmount = Number(data.monthlyAmount) || 0;
        const conservation = behavior.conservation || "Bueno";
        const scoreRestituido = calcularScoreLocativo(onTime, late, monthlyAmount, 0, conservation);

        batch.update(docRef, {
          "dispute.status": "RESOLVED_AUTO_EXPIRED",
          "dispute.resolvedAt": admin.firestore.FieldValue.serverTimestamp(),
          "dispute.resolutionNotes": "Resuelto automáticamente a favor del titular por vencimiento del plazo legal perentorio de 5 días hábiles (Ley 25.326, Art. 16).",
          "behavior.debtAmount": 0,
          "behavior.settlementStatus": "DISPUTA_CADUCA_FAVORABLE",
          "behavior.debtSettledAt": admin.firestore.FieldValue.serverTimestamp(),
          scoreRentia: scoreRestituido,
          scoreRestituido: true,
          "legalEvidence.retentionLimitYears": 2,
          "legalEvidence.autoResolutionLaw": "Ley 25.326 Art. 16 Inc. 2 y 3",
          "historial": admin.firestore.FieldValue.arrayUnion({
            evento: "DISPUTA_EXPIRADA_AUTOMATICA",
            fecha: new Date().toISOString(),
            descripcion: "Vencimiento del plazo de 5 días hábiles sin resolución del emisor. Supresión cautelar de deuda y restitución del score."
          })
        });

        expirados++;
      }
    });

    if (expirados > 0) {
      await batch.commit();
      logger.info(`[Ley 25.326 Art. 16] Se resolvieron automáticamente ${expirados} disputa(s) vencida(s).`);
    } else {
      logger.info("[Ley 25.326 Art. 16] Todas las disputas pendientes están dentro del plazo de 5 días hábiles.");
    }
  } catch (err) {
    logger.error("[Ley 25.326 Art. 16] Error al verificar vencimiento de disputas:", err);
  }
});

// ============================================================================
// 14. NOTIFICACIONES LEGALES POR EMAIL (LEY 25.326 ART. 16)
// Dispara aviso formal con plazo perentorio de 5 días hábiles ante impugnaciones
// ============================================================================

function getMailTransporter() {
  const nodemailer = require("nodemailer");
  return nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.SMTP_USER || "inquiliaeco@gmail.com",
      pass: process.env.SMTP_PASS || ""
    }
  });
}

exports.notificarInicioDisputaLey25326 = onDocumentUpdated({
  document: "verified_rentals/{rentalId}",
  region: "us-central1",
  memory: "256MiB"
}, async (event) => {
  const beforeData = event.data?.before?.data();
  const afterData = event.data?.after?.data();

  if (!beforeData || !afterData) return null;

  const disputeBefore = beforeData.dispute?.status;
  const disputeAfter = afterData.dispute?.status;

  // Se activa solo en la transición a PENDING
  if (disputeBefore !== "PENDING" && disputeAfter === "PENDING") {
    const mailTransporter = getMailTransporter();
    
    const rentalId = event.params.rentalId;
    const dispute = afterData.dispute || {};
    const tenantEmail = afterData.tenantEmail || afterData.tenant?.email;
    const ownerEmail = afterData.ownerEmail || afterData.owner?.email || afterData.landlordEmail;
    
    // Calculamos el vencimiento
    const submittedAt = dispute.submittedAt?.toDate 
      ? dispute.submittedAt.toDate() 
      : (dispute.submittedAt ? new Date(dispute.submittedAt) : new Date());

    const deadline = calcularFechaLimiteHabiles(submittedAt, 5);
    const deadlineStr = deadline.toLocaleDateString("es-AR", {
      timeZone: "America/Argentina/Salta",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric"
    });

    logger.info(`[Disputa Ley 25.326] Nueva impugnación detectada para legajo: ${rentalId}`);

    // Resolver email del propietario si no viene en el contrato
    let finalOwnerEmail = ownerEmail;
    if (!finalOwnerEmail) {
      const ownerUid = afterData.propietarioUid || afterData.metadata?.certifiedByUid;
      if (ownerUid) {
        const ownerSnap = await admin.firestore().collection("users").doc(ownerUid).get();
        if (ownerSnap.exists) {
          const oData = ownerSnap.data();
          finalOwnerEmail = oData.emailLegal || oData.email;
        }
      }
    }

    // 1. Notificación al Propietario / Administrador
    if (finalOwnerEmail) {
      const mailPropietario = {
        from: '"Inquilia Legal" <legal@inquilia.com.ar>',
        to: finalOwnerEmail,
        subject: `⚠️ Intimación Legal: Solicitud de Rectificación - Inmueble ${afterData.propertyAddress || "Alquilado"}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #0f172a; padding: 20px; color: #ffffff; text-align: center;">
              <h2 style="margin: 0; font-size: 18px;">NOTIFICACIÓN DE RECTIFICACIÓN DE DATOS</h2>
              <p style="margin: 5px 0 0; font-size: 12px; color: #94a3b8;">Ley Nacional 25.326 (Hábeas Data - Art. 16)</p>
            </div>
            
            <div style="padding: 24px;">
              <p>Estimado/a titular o administrador,</p>
              <p>El inquilino <strong>${afterData.name || afterData.tenantName || "Inquilino"}</strong> (DNI: ${afterData.dni || afterData.tenantDni || "N/D"}) ha radicado una <strong>solicitud de rectificación y descargo</strong> respecto al contrato del inmueble en <strong>${afterData.propertyAddress || "el contrato registrado"}</strong>.</p>
              
              <div style="background-color: #fef2f2; border-left: 4px solid #ef4444; padding: 14px; margin: 20px 0;">
                <p style="margin: 0; font-weight: bold; color: #991b1b;">PLAZO PERENTORIO DE 5 DÍAS HÁBILES:</p>
                <p style="margin: 5px 0 0; font-size: 14px; color: #b91c1c;">
                  Conforme a la normativa vigente, dispone hasta el <strong>${deadlineStr} a las 03:00 AM</strong> para validar el antecedente con documentación probatoria o allanarse al pedido.
                </p>
              </div>

              <div style="background-color: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 12px; margin-bottom: 20px;">
                <p style="margin: 0 0 6px; font-weight: bold; font-size: 12px; color: #475569;">MOTIVO EXPUESTO POR EL TITULAR:</p>
                <p style="margin: 0; font-size: 14px; font-style: italic; color: #334155;">"${dispute.reason || dispute.notes || "Sin motivo especificado"}"</p>
              </div>

              <p style="font-size: 12px; color: #64748b;">
                * En caso de silencio o falta de respuesta probatoria en dicho plazo, el sistema procederá a la baja cautelar de la deuda y al restablecimiento del puntaje.
              </p>
            </div>
            <div style="background-color: #f1f5f9; padding: 10px; text-align: center; font-size: 11px; color: #64748b;">
              Inquilia Legal & Compliance
            </div>
          </div>
        `
      };

      try {
        await mailTransporter.sendMail(mailPropietario);
        logger.info(`[Disputa Ley 25.326] Email enviado al propietario: ${finalOwnerEmail}`);
      } catch (err) {
        logger.error(`[Disputa Ley 25.326] Error enviando correo al propietario:`, err);
      }
    }

    // 2. Acuse de recibo para el Inquilino
    if (tenantEmail) {
      const mailInquilino = {
        from: '"Inquilia" <no-reply@inquilia.com.ar>',
        to: tenantEmail,
        subject: `Constancia de Solicitud de Rectificación - Trámite #${rentalId.substring(0, 8)}`,
        html: `
          <div style="font-family: Arial, sans-serif; color: #1e293b; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 8px; padding: 24px;">
            <h2 style="color: #0f172a; margin-top: 0;">Solicitud de Rectificación Radicada</h2>
            <p>Hola <strong>${afterData.name || afterData.tenantName || ""}</strong>,</p>
            <p>Tu descargo/rectificación para el inmueble en <strong>${afterData.propertyAddress || "tu locación"}</strong> ha ingresado bajo el marco de la <strong>Ley 25.326</strong>.</p>
            <p>La contraparte ha sido formalmente notificada con un plazo perentorio de <strong>5 días hábiles</strong> (vencimiento: <strong>${deadlineStr}</strong>).</p>
            <p style="margin-top: 25px; font-size: 12px; color: #94a3b8;">Equipo de Inquilia</p>
          </div>
        `
      };

      try {
        await mailTransporter.sendMail(mailInquilino);
        logger.info(`[Disputa Ley 25.326] Acuse de recibo enviado al inquilino: ${tenantEmail}`);
      } catch (err) {
        logger.error(`[Disputa Ley 25.326] Error enviando acuse al inquilino:`, err);
      }
    }
  }

  return null;
});