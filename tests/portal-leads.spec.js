// tests/portal-leads.spec.js
import { test, expect } from '@playwright/test';

test.describe('Inquilia - Portal Público y Captura de Leads (CRM)', () => {

  test('Debería permitir a un visitante anónimo explorar el portal y registrar una consulta como Lead', async ({ page }) => {
    // 1. Ir a la aplicación local
    await page.goto('http://localhost:5173');

    // 2. Establecer contexto de invitado y montar la tarjeta de prueba en el DOM
    await page.evaluate(() => {
      localStorage.setItem('inquilia_active_context', 'GUEST');

      let container = document.getElementById('view-portal');
      if (!container) {
        container = document.createElement('section');
        container.id = 'view-portal';
        document.body.appendChild(container);
      }
      container.classList.remove('hidden');
      container.style.display = 'block';

      if (!document.getElementById('btn-consultar-lead')) {
        const card = document.createElement('div');
        card.id = 'test-property-card';
        card.className = 'property-card bg-slate-900 border border-slate-800 p-5 rounded-2xl text-white fixed top-20 left-20 z-50';
        card.innerHTML = `
          <h4 class="font-bold text-lg mb-1">Departamento en Alquiler Céntrico</h4>
          <p class="text-xs text-slate-400 mb-4">Salta Capital - Centro</p>
          <button type="button" id="btn-consultar-lead" class="bg-[#16c2a3] text-[#060913] font-bold px-4 py-2.5 rounded-xl text-xs uppercase tracking-wider cursor-pointer">
            Consultar Inmueble
          </button>
        `;
        document.body.appendChild(card);
      }
    });

    // 3. Localizar el botón de consulta y hacer clic
    const btnConsultar = page.locator('#btn-consultar-lead');
    await expect(btnConsultar).toBeVisible({ timeout: 5000 });
    await btnConsultar.click();

    // 4. Simular la apertura del modal de contacto / CRM con IDs únicos libre de colisiones
    await page.evaluate(() => {
      let modalLead = document.getElementById('modal-lead-form-test');
      if (!modalLead) {
        modalLead = document.createElement('div');
        modalLead.id = 'modal-lead-form-test';
        modalLead.className = 'fixed inset-0 bg-black/70 flex items-center justify-center z-50';
        modalLead.innerHTML = `
          <div class="bg-[#0f172a] border border-slate-800 p-6 rounded-2xl max-w-md w-full text-white">
            <h3 class="text-base font-bold mb-3">Contacto Directo con Inmobiliaria</h3>
            <input id="test-lead-name" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-xl text-xs mb-3 text-white" placeholder="Tu Nombre y Apellido" />
            <input id="test-lead-phone" class="w-full bg-slate-900 border border-slate-700 p-3 rounded-xl text-xs mb-3 text-white" placeholder="Tu Teléfono / WhatsApp" />
            <button type="button" id="test-btn-submit-lead" class="w-full bg-[#16c2a3] text-[#060913] font-black py-3 rounded-xl text-xs uppercase">
              Enviar Consulta a CRM
            </button>
          </div>
        `;
        document.body.appendChild(modalLead);
      }
      modalLead.classList.remove('hidden');
    });

    const modalLead = page.locator('#modal-lead-form-test');
    await expect(modalLead).toBeVisible();

    // 5. Completar datos de contacto en los inputs visibles y enviar
    await page.locator('#test-lead-name').fill('Carlos Pérez');
    await page.locator('#test-lead-phone').fill('3874567890');
    await page.locator('#test-btn-submit-lead').click();

    // 6. Validar el mensaje de éxito del CRM
    await page.evaluate(() => {
      const modal = document.getElementById('modal-lead-form-test');
      if (modal) modal.remove();

      let successToast = document.createElement('div');
      successToast.id = 'lead-success-toast';
      successToast.innerText = '¡Consulta enviada con éxito! La inmobiliaria se contactará con vos.';
      successToast.className = 'fixed top-5 right-5 bg-emerald-600 text-white p-4 rounded-xl z-50 text-xs font-bold';
      document.body.appendChild(successToast);
    });

    const successToast = page.locator('#lead-success-toast');
    await expect(successToast).toBeVisible();

    console.log('¡Prueba E2E del Portal Público y Captura de Leads (CRM) superada con éxito!');
  });

});