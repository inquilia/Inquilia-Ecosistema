// vite.config.js (Ubicación: Raíz del proyecto / C:\proyecto\inquilia\vite.config.js)
import { defineConfig } from 'vite';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [
    tailwindcss(),
  ],
  server: {
    port: 5173, // Puerto estándar de desarrollo local
    strictPort: true,
    open: true  // Abre automáticamente el navegador al iniciar
  },
  build: {
    outDir: 'dist',
    sourcemap: false, // Oculta los mapas de código en producción por seguridad
    minify: 'esbuild',
    chunkSizeWarningLimit: 600, // Ajusta el límite de advertencia tras minificación
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules')) {
            // Módulos del SDK de Firebase
            if (id.includes('firebase')) {
              return 'vendor-firebase';
            }
            // Librerías de exportación documental y procesamiento gráfico
            if (id.includes('jspdf') || id.includes('html2canvas') || id.includes('purify')) {
              return 'vendor-pdf';
            }
            // Generación de matrices QR
            if (id.includes('qrcode')) {
              return 'vendor-qr';
            }
            // Resto de dependencias de terceros
            return 'vendor-core';
          }
        }
      }
    }
  }
});