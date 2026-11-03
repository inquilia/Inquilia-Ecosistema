// tests/mercadopago-webhook.spec.js
import { test, expect } from '@playwright/test';
import crypto from 'crypto';

test.describe('Inquilia - Pasarela de Pagos y Webhook de Mercado Pago', () => {

  test('Debería aceptar y responder correctamente al webhook firmado de Mercado Pago', async ({ request }) => {
    const paymentId = '999999999';
    const requestId = 'uuid-test-request-id-999';
    const timestamp = Date.now().toString();

    const secret = '154c2d560587bff996b02368b466f39069b5913cfdc01b8960e441f76962a76a';

    const manifest = `id:${paymentId};request-id:${requestId};ts:${timestamp};`;
    const hmac = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
    const xSignatureHeader = `ts=${timestamp},v1=${hmac}`;

    const webhookUrl = `https://webhookmercadopago-4lyqkmj5ra-uc.a.run.app?type=payment&data.id=${paymentId}`;

    const response = await request.post(webhookUrl, {
      headers: {
        'x-signature': xSignatureHeader,
        'x-request-id': requestId,
        'content-type': 'application/json'
      },
      data: {
        action: 'payment.created',
        api_version: 'v1',
        data: { id: paymentId },
        type: 'payment'
      }
    });

    // Como la firma es matemáticamente perfecta, el servidor pasa el filtro de seguridad de x-signature.
    // (Si devuelve 200 o un error controlado de SDK 404/500 por ID inexistente en MP, validamos que no sea 401 Unauthorized).
    const status = response.status();
    expect(status).not.toBe(401);
    console.log(`Estado HTTP recibido del Webhook con firma válida: ${status}`);
  });

  test('Debería rechazar con 401 un webhook con firma x-signature apócrifa o inválida', async ({ request }) => {
    const paymentId = '123456';
    const invalidSignature = 'ts=1742505638683,v1=hash_falso_invalido_por_atacante';

    const webhookUrl = `https://webhookmercadopago-4lyqkmj5ra-uc.a.run.app?type=payment&data.id=${paymentId}`;

    const response = await request.post(webhookUrl, {
      headers: {
        'x-signature': invalidSignature,
        'x-request-id': 'uuid-fake',
        'content-type': 'application/json'
      },
      data: {
        type: 'payment',
        data: { id: paymentId }
      }
    });

    // El sistema criptográfico debe bloquear obligatoriamente la petición devolviendo 401 Unauthorized
    expect(response.status()).toBe(401);
  });

});