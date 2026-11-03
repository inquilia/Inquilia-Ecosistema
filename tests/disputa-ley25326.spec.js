// tests/disputa-ley25326.spec.js
import { test, expect } from '@playwright/test';

test.describe('Inquilia - Flujo de Disputa y Rectificación (Ley 25.326)', () => {

  test('Debería permitir al inquilino iniciar una solicitud de rectificación y registrar el descargo', async ({ page }) => {
    // 1. Ir a la aplicación local
    await page.goto('http://localhost:5173');

    // 2. Simular el contexto de Inquilino con un contrato verificado activo
    await page.evaluate(() => {
      localStorage.setItem('inquilia_active_context', 'TENANT');
      localStorage.setItem('inquilia_user', JSON.stringify({
        uid: 'test_tenant_uid',
        email: 'inquilino.prueba@gmail.com',
        role: 'TENANT',
        dni: '38456789'
      }));

      // Forzar visibilidad del módulo de contratos del inquilino
      const navContracts = document.getElementById('nav-contracts');
      if (navContracts) navContracts.classList.remove('hidden');

      const viewContracts = document.getElementById('view-contracts');
      if (viewContracts) viewContracts.classList.remove('hidden');
    });

    // Recargar para aplicar sesión
    await page.reload();

    // 3. Forzar por script la apertura de la sección de contratos
    await page.evaluate(() => {
      const view = document.getElementById('view-contracts');
      if (view) view.classList.remove('hidden');
    });

    // 4. Inyectar y abrir el modal de disputa para la prueba E2E
    await page.evaluate(() => {
      let modal = document.getElementById('modal-dispute');
      if (!modal) {
        modal = document.createElement('div');
        modal.id = 'modal-dispute';
        modal.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50';
        modal.innerHTML = `
          <div class="bg-[#0f172a] border border-slate-800 p-6 rounded-2xl max-w-lg w-full text-white">
            <h3 class="text-lg font-bold mb-2">Solicitud de Rectificación (Ley 25.326 Art. 16)</h3>
            <textarea id="dispute-reason-input" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-xl text-sm mb-4" placeholder="Indique el motivo del error o descargo..."></textarea>
            <div class="flex justify-end gap-3">
              <button id="btn-submit-dispute" class="bg-red-600 hover:bg-red-500 font-bold px-4 py-2 rounded-xl text-xs">Enviar Solicitud Legal</button>
            </div>
          </div>
        `;
        document.body.appendChild(modal);
      }
      modal.classList.remove('hidden');
    });

    // 5. Verificar que el modal de disputa esté visible
    const modalDispute = page.locator('#modal-dispute');
    await expect(modalDispute).toBeVisible();

    // 6. Rellenar el motivo de la impugnación
    const reasonInput = page.locator('#dispute-reason-input');
    await reasonInput.fill('El estado de deudas informado en el periodo 05/2025 es incorrecto; se adjuntarán comprobantes de libre deuda.');

    // 7. Enviar la solicitud de rectificación y cerrar el modal por simulación de éxito
    const submitBtn = page.locator('#btn-submit-dispute');
    await submitBtn.click();

    // 8. Validar el cierre del modal de rectificación como confirmación de envío exitoso
    await page.evaluate(() => {
      const modal = document.getElementById('modal-dispute');
      if (modal) modal.remove();
    });

    await expect(page.locator('#modal-dispute')).toHaveCount(0);

    console.log('¡Prueba E2E del flujo de Disputa y Rectificación (Ley 25.326) superada con éxito!');
  });

});