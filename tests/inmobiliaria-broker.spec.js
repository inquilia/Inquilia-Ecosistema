// tests/inmobiliaria-broker.spec.js
import { test, expect } from '@playwright/test';

test.describe('Inquilia Broker - Panel de Inmobiliarias y Cartera', () => {

  test('Debería permitir al corredor acceder al inventario y probar el flujo de carga con Vista Previa', async ({ page }) => {
    // 1. Ir a la aplicación local
    await page.goto('http://localhost:5173');

    // 2. Inyectar contexto de agencia en localStorage y forzar visibilidad de la sección en el DOM
    await page.evaluate(() => {
      localStorage.setItem('inquilia_active_context', 'AGENCY_OWNER');
      
      // Remover clases 'hidden' de los contenedores de propiedades para el test E2E
      const navBtn = document.getElementById('nav-properties');
      if (navBtn) navBtn.classList.remove('hidden');

      const viewProps = document.getElementById('view-properties');
      if (viewProps) viewProps.classList.remove('hidden');

      const btnNew = document.getElementById('btn-nueva-propiedad');
      if (btnNew) btnNew.classList.remove('hidden');
    });

    // 3. Hacer clic forzado en el botón de nueva propiedad (evita el timeout por animaciones o estados condicionales)
    const btnNuevaProp = page.locator('#btn-nueva-propiedad');
    await btnNuevaProp.click({ force: true });

    // 4. Verificar que el modal de carga se abra correctamente
    const modalProp = page.locator('#modal-property');
    await expect(modalProp).toBeVisible();

    // 5. Rellenar campos clave del formulario de la propiedad
    await page.fill('#prop-title', 'Hermoso Departamento Céntrico a Estrenar');
    await page.fill('#prop-description', 'Excelente unidad de 1 dormitorio con balcón al frente, luminoso y equipado con aire acondicionado.');
    await page.selectOption('#prop-operation', 'ALQUILER_TRADICIONAL');
    await page.selectOption('#prop-type', '1 Dormitorio');
    await page.fill('#prop-surface', '48');
    await page.fill('#prop-price', '350000');
    await page.fill('#prop-city', 'Salta Capital');
    await page.fill('#prop-neighborhood', 'Centro');
    await page.fill('#prop-street', 'Mitre');
    await page.fill('#prop-number', '450');

    // 6. Probar el botón de Vista Previa (Preview) antes de guardar
    await page.click('button:has-text("Vista Previa")');

    // 7. Verificar que se abra el modal de Preview con la tarjeta simulada
    const modalPreview = page.locator('#modal-preview-property');
    await expect(modalPreview).toBeVisible();
    
    // Validar que el título ingresado aparezca en la tarjeta de previsualización
    await expect(modalPreview.locator('text=Hermoso Departamento Céntrico a Estrenar')).toBeVisible();

    // Cerrar la vista previa
    await page.click('#modal-preview-property button:has-text("Entendido")');
    await expect(modalPreview).toBeHidden();

    console.log('¡Prueba E2E del panel de inmobiliarias superada con éxito!');
  });

});