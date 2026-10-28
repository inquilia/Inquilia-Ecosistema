import fs from 'fs/promises';
import * as cheerio from 'cheerio';

class InquiliaDOMAgent {
  constructor(maxDepth = 6) {
    this.maxDepth = maxDepth;
  }

  async audit(filePath) {
    try {
      const html = await fs.readFile(filePath, 'utf-8');
      const $ = cheerio.load(html);
      
      let maxFoundDepth = 0;
      let warnings = [];

      // 1. Analizar profundidad del DOM
      $('*').each((i, el) => {
        const depth = $(el).parents().length;
        if (depth > maxFoundDepth) maxFoundDepth = depth;
        
        if (depth > this.maxDepth) {
          warnings.push(`[Rendimiento] Elemento <${el.tagName}> en profundidad ${depth} supera el límite recomendado (${this.maxDepth}).`);
        }
      });

      // 2. Verificar accesibilidad básica (WCAG)
      $('img').each((i, img) => {
        if (!$(img).attr('alt')) {
          warnings.push(`[Accesibilidad WCAG] Imagen sin atributo 'alt' detectada.`);
        }
      });

      console.log('--- REPORTE DE CONSTRUCCIÓN (MICRO-AGENTE) ---');
      console.log(`Estado: ${warnings.length === 0 ? '✔ APROBADO' : '⚠ REQUIERE AJUSTES'}`);
      console.log(`Profundidad máxima del DOM: ${maxFoundDepth} niveles`);
      if (warnings.length > 0) {
        console.log('Alertas encontradas:');
        warnings.forEach(w => console.log(` - ${w}`));
      }
    } catch (err) {
      console.error('Error al auditar el archivo:', err);
    }
  }
}

const agent = new InquiliaDOMAgent(6);
agent.audit('./Public/index.html'); // Ajusta la ruta si tu HTML principal está en otra carpeta