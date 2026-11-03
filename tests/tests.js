// tests/inquilia.spec.js
const { test, expect } = require('@playwright/test');

test.describe('Ecosistema Inquilia - Flujos Principales', () => {

  test('Debería cargar la página principal y permitir explorar el Portal Inmobiliario', async ({ page }) => {
    // 1. Ir a la aplicación local o de producción
    await page.goto('http://localhost:5173'); // (o tu URL de desarrollo / Firebase hosting)

    // 2. Verificar que el título principal de la marca esté presente
    await expect(page.locator('text=INQUILIA')).toBeVisible();

    // 3. Navegar a la sección de búsqueda / portal inmobiliario
    await page.click('#nav-portal'); // O el botón correspondiente en tu sidebar

    // 4. Verificar que se muestre el contenedor de grilla de propiedades
    const grid = page.locator('#portal-props-grid');
    await expect(grid).toBeVisible();
  });

  test('Debería abrir el modal de autenticación si se intenta acceder a una sección protegida sin sesión', async ({ page }) => {
    await page.goto('http://localhost:5173');

    // Intentar ir a Contratos o Historial sin iniciar sesión
    await page.click('#nav-contracts');

    // Verificar que muestre el toast de acceso restringido o redirija al login
    await expect(page.locator('text=Acceso Restringido')).toBeVisible();
  });

});