// src/quili-widget.js

// ============================================================================
// BASE DE CONOCIMIENTO LOCAL (CACHÉ INSTANTÁNEA - 0ms LATENCIA)
// ============================================================================
const KB_TUTORIAL = [
  // 1. SALUDOS Y PROTOCOLO SOCIAL
  {
    keywords: [
      "hola", "buen dia", "buenos dias", "buenas tardes", "buenas noches", 
      "como estas", "que tal", "buenas", "holis", "que onda", "saludos"
    ],
    answer: "¡Hola! 👋 Soy <b>Quili</b>, tu asistente en Inquilia.<br><br>¿En qué te puedo ayudar hoy? Contame qué necesitás hacer o cuál es tu rol (<b>corredor</b>, <b>agente</b>, <b>propietario</b> o <b>inquilino</b>)."
  },

  // 2. GUÍAS RÁPIDAS POR ROL (ACCESO DIRECTO)
  {
    keywords: ["soy corredor", "corredor inmobiliario", "inmobiliaria", "matriculado", "cucis", "agency_owner", "soy titular"],
    answer: "¡Excelente colega! 🏢 Como <b>Corredor Inmobiliario CUCIS</b> disponés de:<br><br>" +
      "• <b>Propiedades Broker:</b> Carga de inmuebles para alquiler tradicional, temporal o venta.<br>" +
      "• <b>Co-Brokerage CUCIS:</b> Opción de compartir captaciones al 50/50 con colegas matriculados.<br>" +
      "• <b>Bolsa Corporativa de Créditos:</b> Saldo compartido para todo tu equipo de agentes.<br>" +
      "• <b>CRM de Interesados:</b> Botón <i>'Auditar en Buró'</i> en 1 clic para revisar el Score del postulante.<br><br>" +
      "¿Querés que te explique cómo cargar una propiedad o cómo auditar un lead?"
  },
  {
    keywords: ["soy agente", "agente inmobiliario", "empleado", "operador", "agency_employee", "soy asesor"],
    answer: "¡Bienvenido! 🤝 Como <b>Agente u Operador Dependiente</b> podés:<br><br>" +
      "• Cargar y gestionar las propiedades asignadas a tu firma inmobiliaria.<br>" +
      "• Administrar el pipeline de interesados en el CRM y contactar por WhatsApp.<br>" +
      "• Consultar el Buró debitando directamente de la bolsa corporativa de tu agencia.<br>" +
      "• Confeccionar invitaciones de contratos digitales para tus operaciones cerradas.<br><br>" +
      "¿Qué operación necesitás realizar ahora?"
  },
  {
    keywords: ["soy propietario", "propietario particular", "dueño", "landlord", "alquilo mi depto", "alquilo mi casa"],
    answer: "¡Hola! 🔑 Como <b>Propietario Directo</b> podés operar de forma segura sin intermediarios:<br><br>" +
      "• <b>Consultar Perfil:</b> Auditá a tus candidatos ingresando su DNI para ver su Score Rentia y antecedentes antes de entregar la llave.<br>" +
      "• <b>Contratos Digitales:</b> Emití invitaciones con token seguro (72 hs) y datos del censo nacional.<br>" +
      "• <b>Actas de Entrega y Restitución:</b> Dejá constancia fehaciente del libre deuda y estado del inmueble.<br><br>" +
      "<i>Nota: Recordá que la carga de avisos en el portal público está reservada a inmobiliarias matriculadas.</i>"
  },
  {
    keywords: ["soy inquilino", "tenant", "alquilo", "busco alquilar", "comprador", "busco comprar"],
    answer: "¡Hola! 🏠 Como <b>Inquilino o Buscador</b> contás con protección y transparencia absoluta:<br><br>" +
      "• <b>Buscar Inmuebles:</b> Explorá propiedades verificadas (100% de corredores matriculados CUCIS, cero estafas).<br>" +
      "• <b>Consultas Directas:</b> Enviá tus datos directo al WhatsApp y CRM del corredor responsable.<br>" +
      "• <b>Score Rentia:</b> Construí un historial positivo pagando en término para acceder a mejores garantías.<br>" +
      "• <b>Ley 25.326 (Hábeas Data):</b> Si ves un antecedente inexacto, podés solicitar la rectificación con plazo de 5 días hábiles."
  },

  // 3. OPERATORIA DE PANTALLAS Y TUTORIALES FRECUENTES
  {
    keywords: ["cargar propiedad", "publicar propiedad", "cargar inmueble", "nueva propiedad", "subir propiedad", "publicar"],
    answer: "Para cargar una propiedad:<br><br>" +
      "1. Entrá a <b>'Propiedades Broker'</b> en el menú lateral.<br>" +
      "2. Tocá el botón verde <b>'Cargar Inmueble'</b>.<br>" +
      "3. Completá datos: título, operación (Venta o Alquiler), precio en ARS/USD, tipología y fotos.<br>" +
      "4. Tildá <b>'Compartir en Red CUCIS'</b> si querés compartir comisión con colegas.<br>" +
      "5. Revisá con el botón <b>'Vista Previa'</b> y pulsá <b>'Guardar'</b>."
  },
  {
    keywords: ["score", "rentia", "scoring", "puntaje"],
    answer: "El <b>Score Rentia</b> es una métrica matemática de 0 a 1000 puntos que evalúa el cumplimiento fáctico de pago, antecedentes de daños, resoluciones de contratos y libre deudas certificados."
  },
  {
    keywords: ["consultar perfil", "auditar buro", "consultar dni", "evaluar inquilino"],
    answer: "Para consultar un perfil locativo:<br><br>" +
      "1. Andá al menú <b>'Consultar Perfil'</b>.<br>" +
      "2. Escribí el DNI del postulante (solo números, sin puntos).<br>" +
      "3. Tocá <b>'Consultar Perfil'</b>.<br>" +
      "4. Tenés <b>30 días corridos</b> para consultar nuevamente a ese mismo DNI sin volver a consumir créditos."
  },
  {
    keywords: ["rectificar", "habeas data", "ley 25326", "impugnar", "reclamo", "disputa", "descargo"],
    answer: "Para ejercer tu derecho de Hábeas Data (Ley 25.326 Art. 16):<br><br>" +
      "1. Ingresá a <b>'Contratos'</b> y buscá el legajo.<br>" +
      "2. Tocá <b>'Rectificar Antecedente'</b>.<br>" +
      "3. Ingresá tu justificación documental.<br>" +
      "4. Se activa un bloqueo cautelar y corre un plazo legal de <b>5 días hábiles</b> para resolver la anotación."
  },
  {
    keywords: ["invitar inquilino", "nuevo contrato", "emitir contrato", "contrato digital"],
    answer: "Para emitir un contrato digital:<br><br>" +
      "1. Andá a <b>'Contratos'</b> y tocá <b>'Invitar Inquilino Digital'</b>.<br>" +
      "2. Ingresá titular y locatario con sus correos y DNI.<br>" +
      "3. Completá ubicación, tipología censal, canon y moneda pactada.<br>" +
      "4. Adjuntá el PDF rubricado y pulsá <b>'Generar Enlace'</b> (el token vence en 72 hs)."
  },
  {
    keywords: ["sellado", "dgr", "impuesto de sellos", "rentas salta"],
    answer: "En la provincia de Salta, el <b>Impuesto de Sellos</b> para alquileres habitacionales es del <b>1% sobre el monto total del contrato</b> y se gestiona ante la Dirección General de Rentas (DGR Salta)."
  },
  {
    keywords: ["co-brokerage", "red cucis", "compartir propiedad"],
    answer: "El <b>Co-Brokerage CUCIS</b> permite que una inmobiliaria comparta sus captaciones con otros colegas matriculados bajo comisión acordada (50/50), garantizando que solo participen profesionales habilitados."
  },
  {
    keywords: ["planes", "precios", "comprar creditos", "recargar"],
    answer: "En el menú <b>'Planes y Precios'</b> podés adquirir paquetes de consultas individuales o abonos mensuales con tarjeta, saldo o transferencia vía <b>Mercado Pago</b> con acreditación inmediata."
  }
];

function buscarEnTutorialLocal(textoUsuario) {
  const normalizado = textoUsuario
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:_]/g, "")
    .trim();

  // 1. Verificación exacta (prioridad a saludos y frases cortas)
  for (const item of KB_TUTORIAL) {
    if (item.keywords.some(kw => kw === normalizado)) {
      return item.answer;
    }
  }

  // 2. Verificación por inclusión parcial
  for (const item of KB_TUTORIAL) {
    if (item.keywords.some(kw => normalizado.includes(kw))) {
      return item.answer;
    }
  }

  return null;
}

// ============================================================================
// INICIALIZADOR DEL WIDGET
// ============================================================================
export function initQuiliWidget() {
  if (document.getElementById('quili-widget-root')) return;

  const quiliRobotSvg = `
    <svg class="w-full h-full" viewBox="0 0 100 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="50" cy="50" r="48" fill="#060913" stroke="#16c2a3" stroke-width="3" stroke-opacity="0.5"/>
      <path d="M50 18L76 36H64L50 26L36 36H24L50 18Z" fill="#16c2a3" />
      <circle cx="43" cy="28" r="1.8" fill="#060913" />
      <circle cx="57" cy="28" r="1.8" fill="#060913" />
      <circle cx="43" cy="28" r="0.9" fill="#16c2a3" />
      <circle cx="57" cy="28" r="0.9" fill="#16c2a3" />
      <rect x="41" y="40" width="18" height="42" rx="3" fill="#FFFFFF" />
      <line x1="45" y1="50" x2="55" y2="50" stroke="#16c2a3" stroke-width="2" stroke-linecap="round"/>
      <circle cx="50" cy="60" r="2.5" fill="#16c2a3" />
    </svg>
  `;

  const widgetContainer = document.createElement('div');
  widgetContainer.id = 'quili-widget-root';
  widgetContainer.className = 'fixed bottom-5 right-5 z-50 flex flex-col items-end select-none font-sans transition-all duration-300';

  widgetContainer.innerHTML = `
    <!-- Ventana de Chat de Quili -->
    <div id="quili-chat-window" class="hidden flex-col w-[350px] sm:w-[380px] h-[520px] bg-slate-950 border border-slate-800 rounded-2xl shadow-2xl overflow-hidden mb-3.5 transition-all duration-300">
      
      <!-- Encabezado con Quili Robot -->
      <div class="bg-gradient-to-r from-slate-900 via-slate-900 to-[#0f172a] p-3.5 border-b border-slate-800 flex items-center justify-between">
        <div class="flex items-center gap-2.5">
          <div class="w-9 h-9 rounded-full overflow-hidden p-0.5 bg-slate-900 border border-[#16c2a3]/40 shadow-sm flex items-center justify-center">
            ${quiliRobotSvg}
          </div>
          <div>
            <h4 class="text-sm font-bold text-white leading-tight flex items-center gap-1.5">
              Quili
              <span class="text-[9px] bg-[#16c2a3]/20 text-[#16c2a3] px-1.5 py-0.5 rounded-full font-semibold tracking-wider">IA OFICIAL</span>
            </h4>
            <p class="text-[10px] text-slate-400">Asistente Inteligente de Inquilia</p>
          </div>
        </div>
        <button id="btn-close-quili" class="text-slate-400 hover:text-white p-1.5 rounded-lg transition-colors cursor-pointer" title="Cerrar chat">
          ✕
        </button>
      </div>

      <!-- Historial de Conversación -->
      <div id="quili-messages-container" class="flex-1 overflow-y-auto p-4 space-y-3 text-xs leading-relaxed">
        <div class="flex gap-2">
          <div class="w-7 h-7 rounded-full flex-shrink-0 mt-0.5">
            ${quiliRobotSvg}
          </div>
          <div class="bg-slate-900 border border-slate-800 text-slate-200 p-3 rounded-2xl rounded-tl-none max-w-[85%] shadow-sm">
            ¡Hola! 👋 Soy <b>Quili</b>, el asistente inteligente de <b>Inquilia</b>.<br><br>
            Estoy acá para resolver cualquier duda sobre:<br>
            • Publicación de inmuebles y Co-Brokerage CUCIS.<br>
            • Consultas al Buró y Score Rentia.<br>
            • Contratos digitales, censo y Ley 25.326.<br><br>
            ¿En qué te puedo asesorar hoy?
          </div>
        </div>
      </div>

      <!-- Barra de Mensaje -->
      <form id="quili-input-form" class="p-3 bg-slate-900/60 border-t border-slate-800 flex items-center gap-2">
        <input 
          id="quili-user-input" 
          type="text" 
          placeholder="Preguntale a Quili..." 
          class="flex-1 bg-slate-950 border border-slate-700/60 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:border-[#16c2a3] transition-colors"
          autocomplete="off"
        />
        <button 
          type="submit" 
          class="bg-[#16c2a3] hover:bg-[#13ab90] text-[#060913] font-bold p-2.5 rounded-xl transition-all flex items-center justify-center cursor-pointer"
        >
          <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M14 5l7 7m0 0l-7 7m7-7H3"/>
          </svg>
        </button>
      </form>
    </div>

    <!-- Contenedor del Botón Burbuja con Botón de Minimizar lateral -->
    <div id="quili-bubble-wrapper" class="flex items-center transition-all duration-300">
      
      <!-- Cápsula Principal -->
      <div 
        id="quili-bubble-card" 
        class="flex items-center gap-2.5 bg-gradient-to-r from-slate-950 via-slate-900 to-slate-950 text-white border border-[#16c2a3]/40 pl-2 pr-2 py-1.5 rounded-full shadow-2xl transition-all duration-300"
      >
        <!-- Logo y Trigger de Chat -->
        <button id="btn-toggle-quili" class="flex items-center gap-2.5 cursor-pointer text-left focus:outline-none">
          <div class="relative w-8 h-8 rounded-full overflow-hidden flex items-center justify-center flex-shrink-0">
            ${quiliRobotSvg}
            <span class="absolute top-0 right-0 w-2 h-2 bg-[#16c2a3] rounded-full animate-ping"></span>
          </div>
          <div id="quili-text-label" class="flex flex-col justify-center transition-opacity duration-200">
            <span class="text-[9px] text-slate-400 uppercase tracking-wider font-semibold leading-none">¿Dudas?</span>
            <span class="text-xs font-bold text-[#16c2a3] leading-tight whitespace-nowrap">Preguntale a Quili</span>
          </div>
        </button>

        <!-- Flecha de Colapsar / Minimizar hacia el costado derecho -->
        <button 
          id="btn-collapse-quili" 
          type="button" 
          title="Minimizar al borde"
          class="text-slate-400 hover:text-white p-1 rounded-full hover:bg-slate-800 transition-colors cursor-pointer flex items-center justify-center"
        >
          <svg id="collapse-icon" class="w-4 h-4 transition-transform duration-300 text-slate-400 hover:text-[#16c2a3]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M9 5l7 7-7 7"/>
          </svg>
        </button>
      </div>

    </div>
  `;

  document.body.appendChild(widgetContainer);

  const toggleBtn = document.getElementById('btn-toggle-quili');
  const closeBtn = document.getElementById('btn-close-quili');
  const chatWindow = document.getElementById('quili-chat-window');
  const form = document.getElementById('quili-input-form');
  const input = document.getElementById('quili-user-input');
  const messagesContainer = document.getElementById('quili-messages-container');

  const collapseBtn = document.getElementById('btn-collapse-quili');
  const textLabel = document.getElementById('quili-text-label');
  const collapseIcon = document.getElementById('collapse-icon');

  let isCollapsed = false;

  const toggleCollapse = (e) => {
    if (e) e.stopPropagation();
    isCollapsed = !isCollapsed;

    if (isCollapsed) {
      textLabel.classList.add('hidden');
      collapseIcon.style.transform = 'rotate(180deg)';
      collapseBtn.title = 'Mostrar Quili';
      widgetContainer.style.transform = 'translateX(10px)';
    } else {
      textLabel.classList.remove('hidden');
      collapseIcon.style.transform = 'rotate(0deg)';
      collapseBtn.title = 'Minimizar al borde';
      widgetContainer.style.transform = 'translateX(0)';
    }
  };

  collapseBtn.addEventListener('click', toggleCollapse);

  const toggleChat = () => {
    if (isCollapsed) {
      toggleCollapse();
      return;
    }
    chatWindow.classList.toggle('hidden');
    chatWindow.classList.toggle('flex');
    if (!chatWindow.classList.contains('hidden')) {
      input.focus();
    }
  };

  toggleBtn.addEventListener('click', toggleChat);
  closeBtn.addEventListener('click', () => {
    chatWindow.classList.add('hidden');
    chatWindow.classList.remove('flex');
  });

  // SUBMIT DEL CHAT CON INTERCEPTOR LOCAL + FALLBACK A LA IA
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    appendMessage('USER', query);
    input.value = '';

    // 1. REVISIÓN LOCAL INSTANTÁNEA (0ms latencia)
    const respuestaLocal = buscarEnTutorialLocal(query);
    if (respuestaLocal) {
      setTimeout(() => {
        appendMessage('QUILI', respuestaLocal);
      }, 120);
      return; // Detiene la ejecución aquí: no dibuja loader ni llama a la Cloud Function
    }

    // 2. FALLBACK A CLOUD FUNCTION (Para preguntas libres y complejas)
    const loaderId = appendLoader();

    try {
      const res = await fetch('https://us-central1-inquilia-web.cloudfunctions.net/consultarQuiliIA', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: query })
      });
      const data = await res.json();
      removeLoader(loaderId);
      appendMessage('QUILI', data.reply || 'Disculpá, no pude procesar la respuesta en este momento.');
    } catch (err) {
      removeLoader(loaderId);
      appendMessage('QUILI', 'Tuve un inconveniente de conexión. Por favor intentá nuevamente.');
    }
  });

  function appendMessage(sender, text) {
    const isUser = sender === 'USER';
    const msgDiv = document.createElement('div');
    msgDiv.className = `flex gap-2 ${isUser ? 'justify-end' : 'justify-start'}`;

    if (isUser) {
      msgDiv.innerHTML = `
        <div class="bg-[#16c2a3] text-[#060913] font-medium p-3 rounded-2xl rounded-tr-none max-w-[85%] shadow-sm">
          ${escapeHtml(text)}
        </div>
      `;
    } else {
      msgDiv.innerHTML = `
        <div class="w-6 h-6 flex-shrink-0 mt-0.5">
          ${quiliRobotSvg}
        </div>
        <div class="bg-slate-900 border border-slate-800 text-slate-200 p-3 rounded-2xl rounded-tl-none max-w-[85%] shadow-sm">
          ${text.replace(/\n/g, '<br>')}
        </div>
      `;
    }

    messagesContainer.appendChild(msgDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function appendLoader() {
    const id = 'loader-' + Date.now();
    const loaderDiv = document.createElement('div');
    loaderDiv.id = id;
    loaderDiv.className = 'flex gap-2 justify-start items-center text-slate-400 text-xs italic';
    loaderDiv.innerHTML = `
      <div class="w-6 h-6 flex-shrink-0">${quiliRobotSvg}</div>
      <div class="bg-slate-900 border border-slate-800 p-2.5 rounded-2xl rounded-tl-none text-slate-400 flex items-center gap-1.5">
        <span>Quili está analizando tu consulta</span>
        <span class="animate-bounce">.</span><span class="animate-bounce delay-100">.</span><span class="animate-bounce delay-200">.</span>
      </div>
    `;
    messagesContainer.appendChild(loaderDiv);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    return id;
  }

  function removeLoader(id) {
    const el = document.getElementById(id);
    if (el) el.remove();
  }

  function escapeHtml(string) {
    return String(string).replace(/[&<>"']/g, (s) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[s]));
  }
}