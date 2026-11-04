// src/main.js - Ecosistema Inquilia (Producción Consolidada)
import { loginWithDni, registerUserWithDni, logoutUser, subscribeToAuthChanges, resetPasswordByDni } from "./services/auth.js";
import { uploadConsentAnnexPhoto, uploadRestitutionActFile } from "./services/storageService.js";
import { saveVerifiedRentalRecord } from "./services/dataService.js";
import { createDirectRentalWithInvitation, getRentalInvitationByToken, acceptRentalInvitation } from "./services/rentalService.js";
import { doc, getDoc, setDoc, runTransaction, collection, query, where, getDocs, updateDoc, getCountFromServer, serverTimestamp, addDoc, orderBy, Timestamp } from "firebase/firestore";
import { db, auth } from "./config/firebase.js";
import { createUserWithEmailAndPassword, EmailAuthProvider, reauthenticateWithCredential } from "firebase/auth";
import { registerCivilUser } from "./services/userService.js";
import { submitAndVerifyDocuments, submitCredentialOnly } from "./services/ocrService.js";
import { getFunctions, httpsCallable } from "firebase/functions";
import { downloadContractCertificatePdf, downloadBuroReportPdf } from "./services/pdfService.js";
import { ref as storageRef, uploadBytes, getDownloadURL } from "firebase/storage";
import { storage } from "./config/firebase.js";
import { createPropertyRecord, getAgencyProperties, updatePropertyStatus, getNetworkProperties, matchPropertiesForLead, getPublicAgencyCatalog } from "./services/propertyService.js";
import { createLeadRecord, getAgencyLeads, updateLeadStatus } from "./services/leadService.js";
import { initQuiliWidget } from './quili-widget.js';

let currentUser = null;
let activeOnboardingRole = 'PARTICULAR_PROPIETARIO';
let certificateState = {}; 
let activeContext = "LANDLORD";
let cachedAgencyData = null;
let cachedContractsMap = new Map();
let reportNavigationOrigin = null;
let pendingRedirectView = null;
let currentReportData = null;

function normalizeRole(role) {
  if (role === 'PARTICULAR' || role === 'PARTICULAR_PROPIETARIO' || role === 'PARTICULARE') return 'LANDLORD';
  if (role === 'MATRICULADO_CUCIS') return 'AGENCY_OWNER';
  if (role === 'AGENTE_INMOBILIARIO') return 'AGENCY_EMPLOYEE';
  return role || 'LANDLORD';
}

// ============================================================================
// UTILIDADES DE SANITIZACIÓN Y FORMATEO LEGAL (LEY 25.326)
// ============================================================================
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#039;');
}

function formatAuditDate(timestampValue) {
  if (!timestampValue) return 'Fecha no especificada';
  try {
    if (timestampValue && typeof timestampValue.toDate === 'function') {
      return timestampValue.toDate().toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
    const d = new Date(timestampValue);
    if (!isNaN(d.getTime())) {
      return d.toLocaleDateString('es-AR', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit'
      });
    }
  } catch (e) {
    console.warn("Aviso al formatear fecha de auditoría:", e);
  }
  return String(timestampValue);
}

function renderRebuttalsBlock(rebuttals) {
  if (!rebuttals || rebuttals.length === 0) return '';

  return `
    <div class="mt-6 rounded-xl border border-amber-500/30 bg-amber-950/20 p-5 backdrop-blur-md shadow-lg" id="buro-report-rebuttals">
      <div class="flex items-start justify-between gap-4 border-b border-amber-500/20 pb-3">
        <div class="flex items-center gap-3">
          <div class="p-2 rounded-lg bg-amber-500/10 text-amber-400 border border-amber-500/20">
            <i data-lucide="scale" class="w-5 h-5"></i>
          </div>
          <div>
            <h4 class="text-sm font-bold text-amber-200 tracking-wide flex items-center gap-2">
              Descargo Legal y Garantía de Hábeas Data
              <span class="text-[9px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-300 font-mono border border-amber-500/30 font-bold uppercase">
                Ley 25.326 Art. 16
              </span>
            </h4>
            <p class="text-[11px] text-slate-400 mt-0.5">
              Manifestación formal asentada por el locatario en ejercicio de su derecho de rectificación y réplica.
            </p>
          </div>
        </div>
      </div>

      <div class="mt-4 space-y-3">
    ${rebuttals.map(item => `
          <div class="rounded-lg bg-slate-900/70 border border-slate-800 p-4 transition hover:border-amber-500/20">
            <div class="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-400 mb-2">
              <span class="flex items-center gap-1.5 text-slate-300 font-medium">
                <i data-lucide="map-pin" class="w-3.5 h-3.5 text-amber-400"></i>
                ${escapeHtml(item.propertyAddress || 'Inmueble auditado')}
              </span>
              <span class="flex items-center gap-1.5 font-mono text-[11px] text-slate-400">
                <i data-lucide="calendar" class="w-3.5 h-3.5"></i>
                Presentada: ${formatAuditDate(item.submittedAt)}
              </span>
            </div>

            <div class="rounded bg-slate-950/60 p-3.5 border-l-2 border-amber-500 text-xs sm:text-sm text-slate-200 leading-relaxed font-sans whitespace-pre-wrap break-words">
              "${escapeHtml(item.statement)}"
            </div>

            <div class="mt-2.5 flex items-center justify-between text-[11px] text-slate-500">
              <span class="flex items-center gap-1">
                <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i>
                Identidad verificada por DNI · Legajo inmutable
              </span>
              <span class="font-mono text-amber-400/80 text-[10px] font-bold uppercase">
                Estado: ${escapeHtml(item.status || 'PRESENTADA')}
              </span>
            </div>
          </div>
      `).join('')}
      </div>
    </div>
  `;
}

// ============================================================================
// INICIALIZACIÓN DEL DOM Y NAVEGACIÓN (A prueba de ES Modules)
// ============================================================================
function initInquiliaApp() {
  if (window.lucide) window.lucide.createIcons();

  const sidebar = document.getElementById('sidebar');
  const mobileOverlay = document.getElementById('mobile-overlay');
  const menuToggleBtn = document.getElementById('mobile-menu-toggle');
  const sidebarCloseBtn = document.getElementById('sidebar-close-btn');

  function toggleMobileMenu(forceClose = false) {
    if (!sidebar || !mobileOverlay) return;
    const isOpen = forceClose ? false : sidebar.classList.contains('-translate-x-full');
    
    if (isOpen) {
      sidebar.classList.remove('-translate-x-full');
      mobileOverlay.classList.remove('hidden');
    } else {
      sidebar.classList.add('-translate-x-full');
      mobileOverlay.classList.add('hidden');
    }
  }

  if (menuToggleBtn) {
    menuToggleBtn.addEventListener('click', () => toggleMobileMenu());
  }

  if (sidebarCloseBtn) {
    sidebarCloseBtn.addEventListener('click', () => toggleMobileMenu(true));
  }

  if (mobileOverlay) {
    mobileOverlay.addEventListener('click', () => toggleMobileMenu(true));
  }

  if (sidebar) {
    const navButtons = sidebar.querySelectorAll('button[id^="nav-"]');
    navButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        if (window.innerWidth < 768) {
          toggleMobileMenu(true);
        }
      });
    });
  }

  subscribeToAuthChanges((user) => {
    currentUser = user;
    cachedAgencyData = null;
    updateAuthUI(user);
    
    if (!user && window.location.hash === '#protected') {
      switchTab('auth');
    }
  });

  setupGlobalListeners();
  setupFormHandlers();
  setupCertificateWizard();
  setupPasswordToggles();
  setupAgentModal();
  setupSearchHandler();
  attachStrictNumericSanitizers();
  setupDigitalInvitationFlow();
  checkInvitationTokenOnLoad();
  initQuiliWidget();

  const urlParams = new URLSearchParams(window.location.search);
  const verifyContractId = urlParams.get('c');
  const verifyHash = urlParams.get('h');
  const publicAgencyId = urlParams.get('inmobiliaria');
  const isVerifyRoute = window.location.pathname.includes('/verify') || urlParams.get('verify') === 'true' || !!verifyContractId;

  if (publicAgencyId) {
    loadAndRenderAgencyCatalog(publicAgencyId);
  } else if (isVerifyRoute) {
    if (verifyContractId) {
      loadAndRenderPublicVerification(verifyContractId, verifyHash);
    } else {
      switchTab('verify');
      const contentEl = document.getElementById('verify-card-content');
      if (contentEl) {
        contentEl.innerHTML = `
          <div class="bg-amber-950/30 border border-amber-900/50 rounded-xl p-5 text-center space-y-2">
            <i data-lucide="scan-line" class="w-8 h-8 text-amber-400 mx-auto"></i>
            <p class="text-sm font-black text-amber-300">Escaneá un Código QR Válido</p>
            <p class="text-xs text-slate-400">Para verificar la autenticidad de un certificado oficial, escaneá el código QR impreso en el documento PDF descargado.</p>
          </div>
        `;
        if (window.lucide) window.lucide.createIcons();
      }
    }
  } else {
    loadMarketReferencePrices();
    switchTab('home');
  }
}

// Ejecución segura ante carga de módulos
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initInquiliaApp);
} else {
  initInquiliaApp();
}

function setupPasswordToggles() {
  const toggleLogin = document.getElementById('toggle-login-password');
  const loginPass = document.getElementById('login-password');
  if (toggleLogin && loginPass) {
    toggleLogin.addEventListener('click', () => {
      const isPassword = loginPass.type === 'password';
      loginPass.type = isPassword ? 'text' : 'password';
      toggleLogin.innerHTML = isPassword ? '<i data-lucide="eye-off" class="w-4 h-4"></i>' : '<i data-lucide="eye" class="w-4 h-4"></i>';
      if (window.lucide) window.lucide.createIcons();
    });
  }

  const toggleOnb = document.getElementById('toggle-onb-password');
  const onbPass = document.getElementById('onb-password');
  if (toggleOnb && onbPass) {
    toggleOnb.addEventListener('click', () => {
      const isPassword = onbPass.type === 'password';
      onbPass.type = isPassword ? 'text' : 'password';
      toggleOnb.innerHTML = isPassword ? '<i data-lucide="eye-off" class="w-4 h-4"></i>' : '<i data-lucide="eye" class="w-4 h-4"></i>';
      if (window.lucide) window.lucide.createIcons();
    });
  }
}

function switchTab(viewName) {
  const protectedViews = ['portal', 'search', 'history', 'certify', 'expirations', 'properties', 'leads', 'settings', 'contracts', 'reports'];
  
  if (protectedViews.includes(viewName) && !currentUser) {
    pendingRedirectView = viewName;

    const titleMap = { 
      'search': 'Consultar perfil', 'history': 'Historial', 'certify': 'Certificados',
      'reports': 'Reportes', 'expirations': 'Vencimientos', 'properties': 'Inventario de Propiedades', 'leads': 'Interesados / Leads', 'contracts': 'Contratos',
      'account': 'Planes y Créditos', 'settings': 'Configuración', 'agency-catalog': 'Catálogo Inmobiliario Oficial'
    };
    const targetLabel = titleMap[viewName] || 'este módulo';

    showToast("Acceso Restringido", `Debés iniciar sesión con tu DNI para acceder a ${targetLabel}.`, "error");
    switchTab('auth'); // Ahora sí encuentra la función localmente sin error
    return;
  }

  // 1. Ocultar todas las vistas de forma segura
  const views = ['home', 'auth', 'portal', 'search', 'certify', 'history', 'account', 'settings', 'reports', 'expirations', 'properties', 'leads', 'contracts', 'onboarding', 'verify', 'agency-catalog'];
  views.forEach(v => {
    const el = document.getElementById(`view-${v}`);
    if (el) el.classList.add('hidden');
  });

  // 2. Mostrar la vista seleccionada
  const targetView = document.getElementById(`view-${viewName}`);
  if (targetView) {
    targetView.classList.remove('hidden');

    // 3. Ejecutores seguros por módulo
    try {
      if (viewName === 'properties') {
        const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
        if (!isAgency) {
          showToast("Módulo Corporativo", "La gestión de inventario y cartera inmobiliaria es exclusiva para corredores matriculados y agentes.", "error");
          switchTab('home');
          return;
        }
        if (typeof loadPropertiesView === 'function' && currentUser) {
          loadPropertiesView(currentUser);
        }
      }

      if (viewName === 'leads') {
        const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
        if (!isAgency) {
          showToast("Módulo Corporativo", "La gestión de postulantes es exclusiva para corredores matriculados y agentes.", "error");
          switchTab('home');
          return;
        }
        if (typeof loadLeadsView === 'function') {
          loadLeadsView(currentUser);
        }
      }

      if (viewName === 'settings' && currentUser) {
        const userRef = doc(db, "users", currentUser.uid);
        getDoc(userRef).then(snap => {
          let fallbackDni = '';
          if (currentUser.email && currentUser.email.startsWith('dni_')) {
            fallbackDni = currentUser.email.replace('dni_', '').split('@')[0];
          }
          const data = snap.exists() ? snap.data() : { dni: fallbackDni, roles: ['LANDLORD'] };
          loadSettingsView(currentUser, data);
          loadAccountView(currentUser);
        });
      }

      if (viewName === 'certify' && currentUser) {
        loadCertifyPendingContracts(currentUser);
        const ownerDniInput = document.getElementById('cert-owner-dni');
        if (ownerDniInput) {
          getDoc(doc(db, "users", currentUser.uid)).then(snap => {
            if (snap.exists()) {
              const uData = snap.data();
              const cleanDni = uData.dni ? String(uData.dni).replace(/\D/g, '') : '';
              if (activeContext === 'LANDLORD') {
                ownerDniInput.value = cleanDni;
                ownerDniInput.readOnly = true;
                ownerDniInput.classList.add('bg-slate-900/50', 'text-slate-400');
              } else {
                ownerDniInput.readOnly = false;
                ownerDniInput.classList.remove('bg-slate-900/50', 'text-slate-400');
                if (ownerDniInput.value === cleanDni) {
                  ownerDniInput.value = '';
                }
              }
            }
          });
        }
      }

      if (viewName === 'home') {
        loadMarketReferencePrices();
      }

      if (viewName === 'portal') {
        loadPortalView();
      }

      if (viewName === 'history' && currentUser) {
        loadHistoryView(currentUser);
      }

      if (viewName === 'account' && currentUser) {
        loadAccountView(currentUser);
      }

      if (viewName === 'contracts') {
        if (typeof loadContractsView === 'function') {
          loadContractsView(currentUser || auth.currentUser);
        }
      }

      if (viewName === 'reports' && currentUser) {
        loadReportsView(currentUser);
      }

      if (viewName === 'expirations' && currentUser) {
        loadExpirationsView(currentUser);
      }
    } catch (err) {
      console.warn("Aviso en renderizado de vista:", err);
    }
  }

  // 4. Actualizar título superior de la barra
  const topTitle = document.getElementById('topbar-title');
  if (topTitle) {
    const titleMap = { 
      'home': 'Home',
      'portal': 'Portal Inmobiliario', 
      'auth': 'Acceso al Ecosistema', 
      'search': 'Consultar perfil', 
      'history': 'Consultas realizadas', 
      'certify': 'Carga y Emisión de Certificados',       
      'reports': 'Reportes de Cartera', 
      'expirations': 'Vencimientos', 
      'properties': 'Inquilia Broker · Inventario',
      'leads': 'Inquilia Broker · Interesados',
      'contracts': 'Repositorio de Contratos',
      'account': 'Planes y Precios',
      'settings': 'Configuración', 
      'onboarding': 'Registro / Alta',
      'verify': 'Validación de Certificado',
      'agency-catalog': 'Catálogo Inmobiliario Oficial'
    };
    topTitle.innerText = titleMap[viewName] || viewName.toUpperCase();
  }

  if (window.lucide) window.lucide.createIcons();
}

// Exposición correcta al objeto global de la ventana
window.switchTab = switchTab;

function isPackExpired(expiresAtField) {
  if (!expiresAtField) return false;
  const expDate = expiresAtField.toDate ? expiresAtField.toDate() : new Date(expiresAtField);
  return new Date() > expDate;
}

// ============================================================================
// UTILIDADES: DÍAS HÁBILES Y VENCIMIENTO DE DISPUTAS (LEY 25.326)
// ============================================================================
function calcularFechaLimiteHabiles(fechaInicio, diasHabiles = 5) {
  let fecha = new Date(fechaInicio);
  let agregados = 0;

  while (agregados < diasHabiles) {
    fecha.setDate(fecha.getDate() + 1);
    const diaSemana = fecha.getDay();
    if (diaSemana !== 0 && diaSemana !== 6) {
      agregados++;
    }
  }
  return fecha;
}

function calcularDiasHabilesRestantes(fechaLimite) {
  if (!fechaLimite) return { dias: 0, vencido: true };
  const target = fechaLimite.toDate ? fechaLimite.toDate() : new Date(fechaLimite);
  const now = new Date();

  if (now > target) {
    return { dias: 0, vencido: true };
  }

  let cursor = new Date(now);
  let diasHabiles = 0;

  while (cursor < target) {
    cursor.setDate(cursor.getDate() + 1);
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) {
      diasHabiles++;
    }
  }

  return { dias: Math.max(1, diasHabiles), vencido: false };
}

function haVencidoPlazo(fechaEnvio, diasHabiles = 5) {
  if (!fechaEnvio) return false;
  const limite = calcularFechaLimiteHabiles(fechaEnvio, diasHabiles);
  return new Date() > limite;
}

async function resolveCreditsForContext(role, userData) {
  const rawRoles = userData.roles || [userData.role || "LANDLORD"];
  const userRoles = rawRoles.map(normalizeRole);
  const targetAgencyId = userData.agencyId || (role === 'AGENCY_OWNER' && currentUser ? currentUser.uid : null);

  if ((role === 'AGENCY_EMPLOYEE' || role === 'AGENCY_OWNER') && targetAgencyId) {
    if (!cachedAgencyData) {
      try {
        const agencySnap = await getDoc(doc(db, "agencies", targetAgencyId));
        if (agencySnap.exists()) {
          cachedAgencyData = agencySnap.data();
        }
      } catch (err) {
        console.error("Error al obtener créditos de la agencia:", err);
      }
    }
    if (!cachedAgencyData) return 0;
    if (isPackExpired(cachedAgencyData.creditsExpiresAt)) return 0;
    return cachedAgencyData.creditos ?? 0;
  }

  const now = new Date();
  const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const lastFreeMonth = userData.lastFreeQueryMonth || '';
  const freeQueries = userData.freeQueriesCount || 0;
  
  const usedFree = (lastFreeMonth === currentMonthStr) ? freeQueries : 0;
  const remainingFree = Math.max(0, 2 - usedFree);

  const paidExpired = isPackExpired(userData.creditsExpiresAt);
  const personalPaidCredits = paidExpired ? 0 : (userData.creditos || 0);
  
  return remainingFree + personalPaidCredits;
}

async function ensureLegacyAgencyMigration(user, data) {
  const rawRoles = data.roles || [data.role || 'LANDLORD'];
  const isLegacyCucis = rawRoles.includes('MATRICULADO_CUCIS') || data.role === 'MATRICULADO_CUCIS' || rawRoles.includes('AGENCY_OWNER');
  
  if (!isLegacyCucis) return data;

  try {
    const agencyRef = doc(db, "agencies", user.uid);
    const agencySnap = await getDoc(agencyRef);

    if (!agencySnap.exists()) {
      const initialCredits = (typeof data.creditos === 'number' && data.creditos > 0) ? data.creditos : 40;
      await setDoc(agencyRef, {
        name: (data.nombreFantasia || 'Inmobiliaria CUCIS').trim(),
        cuit: data.dni || '',
        nroMatricula: data.nroMatricula || '',
        ownerUid: user.uid,
        creditos: initialCredits,
        status: "ACTIVO",
        metadata: {
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        }
      });

      await addDoc(collection(db, "credit_transactions"), {
        agencyId: user.uid,
        actorUid: user.uid,
        type: 'INITIAL_GRANT',
        amount: initialCredits,
        balanceBefore: 0,
        balanceAfter: initialCredits,
        description: `Migración de cuenta corporativa CUCIS Mat. ${data.nroMatricula || 'S/N'}`,
        timestamp: serverTimestamp()
      });
    }

    if (!data.agencyId) {
      await updateDoc(doc(db, "users", user.uid), {
        agencyId: user.uid
      });
    }
  } catch (err) {
    console.warn("Aviso en migración de agencia:", err);
  }

  return {
    ...data,
    role: 'AGENCY_OWNER',
    roles: ['AGENCY_OWNER', 'LANDLORD'],
    agencyId: data.agencyId || user.uid
  };
}

async function updateAuthUI(user) {
  const btnLogin = document.getElementById('btn-goto-auth');
  const btnLogout = document.getElementById('btn-logout');
  const connIdEl = document.getElementById('sidebar-connection-id');
  const lockIcons = document.querySelectorAll('.auth-lock-icon');
  const userNameEl = document.getElementById('topbar-user-name');
  const userSubtitle = document.getElementById('topbar-user-subtitle');
  const avatarEl = document.getElementById('user-avatar-initials');
  const creditsEl = document.getElementById('header-credits');
  const navPropertiesBtn = document.getElementById('nav-properties');
  const navLeadsBtn = document.getElementById('nav-leads');

  if (creditsEl) {
    let parentEl = creditsEl.parentElement;
    while (parentEl && parentEl.tagName !== 'HEADER' && parentEl !== document.body) {
      if (parentEl.classList.contains('hidden')) {
        parentEl.classList.remove('hidden');
        parentEl.classList.add('flex');
      }
      parentEl = parentEl.parentElement;
    }
  }

  if (user) {
    if (btnLogin) btnLogin.classList.add('hidden');
    if (btnLogout) btnLogout.classList.remove('hidden');
    lockIcons.forEach(icon => icon.classList.add('hidden'));

    if (userSubtitle) {
      userSubtitle.innerText = "CERRAR SESIÓN";
      userSubtitle.className = "text-[8px] sm:text-[9px] text-[#16c2a3] font-bold uppercase tracking-widest mt-0.5";
    }

    try {
      const userDocRef = doc(db, "users", user.uid);
      const userSnap = await getDoc(userDocRef);

      let displayName = user.email || "Usuario Verificado";
      let initials = "UV";
      let dniLabel = user.uid.substring(0, 8);
      let creditosReales = 0;

      if (userSnap.exists()) {
        let data = userSnap.data();
        data = await ensureLegacyAgencyMigration(user, data);
        dniLabel = data.dni || dniLabel;

        let userRoles = data.roles || [data.role || "LANDLORD"];
        userRoles = userRoles.map(normalizeRole);
        userRoles = [...new Set(userRoles)];
        activeContext = (activeContext && userRoles.includes(activeContext)) ? activeContext : userRoles[0]; 

        creditosReales = await resolveCreditsForContext(activeContext, data);
        displayName = getContextualDisplayName(activeContext, data);
        initials = displayName
        .split(' ')
        .filter(Boolean)
        .map(n => n[0])
        .join('')
        .toUpperCase()
        .substring(0, 2) || "UV";

        // Visibilidad inmediata al cargar según contexto inicial
        const isAgencyInitial = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
        if (navPropertiesBtn) navPropertiesBtn.classList.toggle('hidden', !isAgencyInitial);
        if (navLeadsBtn) navLeadsBtn.classList.toggle('hidden', !isAgencyInitial);

        const hasMultipleRoles = userRoles.length > 1 || userRoles.includes("AGENCY_OWNER") || userRoles.includes("OPERADOR_INMOBILIARIO");
        const selectorContainer = document.getElementById('context-selector-container');
        
        if (hasMultipleRoles && selectorContainer) {
          selectorContainer.className = "flex items-center shrink-0";
          selectorContainer.innerHTML = `
            <select id="global-context-select" class="bg-slate-900 text-[10px] text-[#16c2a3] border border-[#16c2a3]/40 rounded-lg px-2 py-1 font-bold cursor-pointer shadow-sm max-w-[135px] sm:max-w-[200px] truncate">
            ${userRoles.map(role => `<option value="${role}" ${role === activeContext ? 'selected' : ''}>${formatRoleLabel(role)}</option>`).join('')}
            </select>
          `;
          
          const contextSelectEl = document.getElementById('global-context-select');
          if (contextSelectEl) {
            contextSelectEl.addEventListener('change', async (e) => {
              activeContext = e.target.value;
              
              const newDisplayName = getContextualDisplayName(activeContext, data);
              if (userNameEl) userNameEl.innerText = newDisplayName;
              if (avatarEl) {
                avatarEl.innerText = newDisplayName
                .split(' ')
                .filter(Boolean)
                .map(n => n[0])
                .join('')
                .toUpperCase()
                .substring(0, 2) || "UV";
              }

              const updatedCredits = await resolveCreditsForContext(activeContext, data);
              if (creditsEl) creditsEl.innerText = updatedCredits;

              showToast("Contexto Actualizado", `Operando en modo: ${formatRoleLabel(activeContext)}`, "success");

              // Reactividad en módulos Broker según cambio de rol
              const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
              if (navPropertiesBtn) navPropertiesBtn.classList.toggle('hidden', !isAgency);
              if (navLeadsBtn) navLeadsBtn.classList.toggle('hidden', !isAgency);

              const settingsView = document.getElementById('view-settings');
              if (settingsView && !settingsView.classList.contains('hidden')) {
                await loadSettingsView(user, data);
                await loadAccountView(user);
              }

              const historyView = document.getElementById('view-history');
              if (historyView && !historyView.classList.contains('hidden')) {
                await loadHistoryView(user);
              }

              const accountView = document.getElementById('view-account');
              if (accountView && !accountView.classList.contains('hidden')) {
                await loadAccountView(user);
              }

              const contractsView = document.getElementById('view-contracts');
              if (contractsView && !contractsView.classList.contains('hidden')) {
                await loadContractsView(user);
              }

              const reportsView = document.getElementById('view-reports');
              if (reportsView && !reportsView.classList.contains('hidden')) {
                await loadReportsView(user);
              }

              const expView = document.getElementById('view-expirations');
              if (expView && !expView.classList.contains('hidden')) {
                await loadExpirationsView(user);
              }

              const certView = document.getElementById('view-certify');
              if (certView && !certView.classList.contains('hidden')) {
                await loadCertifyPendingContracts(user);
              }

              const propView = document.getElementById('view-properties');
              if (propView && !propView.classList.contains('hidden')) {
                if (typeof loadPropertiesView === 'function') {
                  await loadPropertiesView(user);
                }
              }

              const leadsView = document.getElementById('view-leads');
              if (leadsView && !leadsView.classList.contains('hidden')) {
                if (isAgency && typeof loadLeadsView === 'function') {
                  await loadLeadsView(user);
                } else {
                  switchTab('home');
                }
              }
            });
          }
        } else if (selectorContainer) {
          selectorContainer.innerHTML = '';
        }
      }

      if (creditsEl) creditsEl.innerText = creditosReales;
      if (userNameEl) userNameEl.innerText = displayName;

      if (avatarEl) {
        avatarEl.innerText = initials;
        avatarEl.className = "hidden sm:flex w-8 h-8 rounded-full bg-[#16c2a3]/20 border border-[#16c2a3]/40 items-center justify-center font-bold text-xs text-[#16c2a3] shrink-0";
      }

      if (connIdEl) connIdEl.innerText = `DNI: ${dniLabel}`;

    } catch (error) {
      console.error("Error al sincronizar metadatos de usuario:", error);
      if (userNameEl && userNameEl.innerText === "Iniciar sesión") {
        userNameEl.innerText = "Usuario Verificado";
      }
    }

    const userProfileHeader = document.getElementById('user-profile-trigger') || document.querySelector('header .flex.items-center.gap-3');
    if (userProfileHeader && !userProfileHeader.dataset.logoutListener) {
      userProfileHeader.dataset.logoutListener = "true";
      userProfileHeader.style.cursor = "pointer";
      userProfileHeader.title = "Hacer clic para cerrar sesión";
      userProfileHeader.addEventListener('click', () => {
        if (currentUser && confirm("¿Deseas cerrar sesión en el Ecosistema?")) {
          handleLogout();
        }
      });
    }

  } else {
    // Sesión no iniciada: Ocultar controles y botones corporativos
    if (btnLogin) btnLogin.classList.remove('hidden');
    if (btnLogout) btnLogout.classList.add('hidden');

    if (navPropertiesBtn) navPropertiesBtn.classList.add('hidden');
    if (navLeadsBtn) navLeadsBtn.classList.add('hidden');

    const existingSelector = document.getElementById('context-selector-container');
    if (existingSelector) existingSelector.innerHTML = '';

    if (connIdEl) connIdEl.innerText = 'ID: INVITADO';
    lockIcons.forEach(icon => icon.classList.remove('hidden'));
    
    if (userNameEl) userNameEl.innerText = "Iniciar sesión";
    if (userSubtitle) {
      userSubtitle.innerText = "SESIÓN NO INICIADA";
      userSubtitle.className = "text-[8px] sm:text-[9px] text-amber-500 font-bold uppercase tracking-widest mt-0.5";
    }

    if (avatarEl) {
      avatarEl.innerHTML = '<i data-lucide="user" class="w-4 h-4"></i>';
      avatarEl.className = "w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center font-bold text-xs text-slate-400 shrink-0";
      if (window.lucide) window.lucide.createIcons();
    }

    if (creditsEl) creditsEl.innerText = "0";
  }
}

function formatRoleLabel(role) {
  switch(normalizeRole(role)) {
  case 'LANDLORD': return 'Particular';
  case 'AGENCY_EMPLOYEE': return 'Agente de Inmobiliaria';
  case 'AGENCY_OWNER': return 'Titular CUCIS (Inmobiliaria)';
  case 'TENANT': return 'Inquilino';
  default: return role;
  }
}

function getContextualDisplayName(role, data) {
  if (!data) return 'Mi Cuenta';

  const normalized = normalizeRole(role);
  const realName = data.nombre || data.fullName || data.name || data.displayName;

  if (normalized === 'AGENCY_OWNER') {
    return data.nombreFantasia || 'Inmobiliaria CUCIS';
  }
  
  if (normalized === 'AGENCY_EMPLOYEE') {
    const parts = (realName || '').trim().split(/\s+/);
    const apellido = parts.length > 1 ? parts[parts.length - 1] : parts[0] || 'Agente';
    return `Agente ${apellido}`;
  }
  
  if (realName) return realName;
  if (data.dni) return `Propietario (DNI ${data.dni})`;
  return 'Mi Cuenta';
}

function setupGlobalListeners() {
  document.body.addEventListener('click', (e) => {
    const target = e.target.closest('button, [id^="nav-"], [id$="-trigger"]');
    if (!target) return;

    const id = target.id;

    if (id === 'btn-goto-auth') {
      if (!currentUser) {
        pendingRedirectView = null;
        switchTab('auth');
      } else {
        switchTab('account');
      }
    } else if (id === 'user-profile-trigger' && !currentUser) {
      pendingRedirectView = null;
      switchTab('auth');
    } else if (id === 'btn-goto-credits') {
      switchTab('settings');
    } else if (id === 'nav-account') {
      switchTab('account');
    } else if (id === 'btn-logout') {
      handleLogout();
    } else if (id.startsWith('nav-')) {
      if (id === 'nav-search') {
        reportNavigationOrigin = null;
        const searchFormContainer = document.getElementById('search-form-container');
        const reportNavBar = document.getElementById('report-nav-bar');
        const resultsContainer = document.getElementById('search-results-container');
        if (searchFormContainer) searchFormContainer.classList.remove('hidden');
        if (reportNavBar) reportNavBar.classList.add('hidden');
        if (resultsContainer) resultsContainer.classList.add('hidden');
        const dniInput = document.getElementById('search-dni-input');
        if (dniInput) dniInput.value = '';
      }

      const viewMap = {
        'nav-home': 'home', 
        'nav-portal': 'portal',
        'nav-search': 'search', 
        'nav-history': 'history',
        'nav-reports': 'reports',
        'nav-expirations': 'expirations', 
        'nav-properties': 'properties', // 👈 Mapeo correcto
        'nav-leads': 'leads',
        'nav-contracts': 'contracts', 
        'nav-settings': 'settings',
        'nav-account': 'account'
      };
      if (viewMap[id]) switchTab(viewMap[id]);
    } else if (id === 'btn-goto-onboarding') {
      pendingRedirectView = null;
      switchTab('onboarding');
    }
  });

  // ==========================================
  // EVENTOS DEL MODAL DE PROPIEDADES (BROKER)
  // ==========================================
  const modalProp = document.getElementById('modal-property');
  const btnNuevaProp = document.getElementById('btn-nueva-propiedad');
  const btnCloseProp = document.getElementById('btn-close-property-modal');
  const btnCancelProp = document.getElementById('btn-cancel-property');
  const formProp = document.getElementById('form-property');
  const propOpSelect = document.getElementById('prop-operation');
  const labelPrice = document.getElementById('label-prop-price');
  const currencySelect = document.getElementById('prop-currency');
  const cntExpenses = document.getElementById('container-prop-expenses');
  const cntApto = document.getElementById('container-prop-credit-apto');
  const cntTempMin = document.getElementById('container-prop-temporal-min');
  const cntTempGuests = document.getElementById('container-prop-temporal-guests');

  if (propOpSelect) {
    propOpSelect.addEventListener('change', () => {
      const op = propOpSelect.value;
      if (op === 'VENTA') {
        if (labelPrice) labelPrice.innerText = "Precio de Venta *";
        if (currencySelect) currencySelect.value = "USD";
        cntExpenses?.classList.remove('hidden');
        cntApto?.classList.remove('hidden');
        cntTempMin?.classList.add('hidden');
        cntTempGuests?.classList.add('hidden');
      } else if (op === 'ALQUILER_TEMPORAL') {
        if (labelPrice) labelPrice.innerText = "Precio por Noche *";
        if (currencySelect) currencySelect.value = "ARS";
        cntExpenses?.classList.add('hidden');
        cntApto?.classList.add('hidden');
        cntTempMin?.classList.remove('hidden');
        cntTempGuests?.classList.remove('hidden');
      } else {
        if (labelPrice) labelPrice.innerText = "Canon Mensual *";
        if (currencySelect) currencySelect.value = "ARS";
        cntExpenses?.classList.remove('hidden');
        cntApto?.classList.add('hidden');
        cntTempMin?.classList.add('hidden');
        cntTempGuests?.classList.add('hidden');
      }
    });
  }

  if (btnNuevaProp) {
    btnNuevaProp.addEventListener('click', () => {
      editingPropertyId = null; // Modo creación limpia
      if (formProp) formProp.reset();
      
      const titleHeader = modalProp?.querySelector('h3');
      const submitBtn = document.getElementById('btn-submit-property');
      if (titleHeader) titleHeader.innerText = "Cargar Inmueble a Cartera";
      if (submitBtn) submitBtn.innerText = "Guardar Propiedad";

      const fileInput = document.getElementById('prop-images');
      if (fileInput) fileInput.required = true;

      modalProp?.classList.remove('hidden');
      modalProp?.classList.add('flex');
    });
  }

  const cerrarModalPropiedad = () => {
    editingPropertyId = null;
    modalProp?.classList.add('hidden');
    modalProp?.classList.remove('flex');
  };

  btnCloseProp?.addEventListener('click', cerrarModalPropiedad);
  btnCancelProp?.addEventListener('click', cerrarModalPropiedad);

  formProp?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const submitBtn = document.getElementById('btn-submit-property');
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = editingPropertyId ? "Guardando cambios..." : "Subiendo fotos y guardando...";
    }

    try {
      const userDoc = await getDoc(doc(db, "users", currentUser.uid));
      const userData = userDoc.exists() ? userDoc.data() : {};
      const opVal = document.getElementById('prop-operation')?.value || 'ALQUILER_TRADICIONAL';

      const street = document.getElementById('prop-street')?.value.trim() || '';
      const number = document.getElementById('prop-number')?.value.trim() || '';
      const floor = document.getElementById('prop-floor')?.value.trim() || '';
      const apartment = document.getElementById('prop-apartment')?.value.trim() || '';
      const neighborhood = document.getElementById('prop-neighborhood')?.value.trim() || '';
      const city = document.getElementById('prop-city')?.value.trim() || '';
      const province = document.getElementById('prop-province')?.value || 'Salta';

      const streetParts = [street, number, floor ? `${floor}°` : '', apartment ? `Dpto ${apartment}` : ''].filter(Boolean).join(' ');
      const fullAddress = [streetParts, neighborhood, city, province].filter(Boolean).join(', ');

      const propertyPayload = {
        title: document.getElementById('prop-title')?.value.trim() || '',
        description: document.getElementById('prop-description')?.value.trim() || '',
        operation: opVal,
        propertyType: document.getElementById('prop-type')?.value || '1 Dormitorio',
        surfaceM2: Number(document.getElementById('prop-surface')?.value) || 0,
        currency: document.getElementById('prop-currency')?.value || 'ARS',
        price: Number(document.getElementById('prop-price')?.value) || 0,
        expenses: Number(document.getElementById('prop-expenses')?.value) || 0,
        minScore: Number(document.getElementById('prop-min-score')?.value) || 0,
        creditApto: opVal === 'VENTA' ? (document.getElementById('prop-credit-apto')?.checked ?? false) : false,
        minNights: opVal === 'ALQUILER_TEMPORAL' ? (Number(document.getElementById('prop-temporal-min')?.value) || 1) : null,
        maxGuests: opVal === 'ALQUILER_TEMPORAL' ? (Number(document.getElementById('prop-temporal-guests')?.value) || 1) : null,
        sharedInNetwork: document.getElementById('prop-share-network')?.checked ?? true,
        propertyAddress: fullAddress,
        province,
        city,
        neighborhood,
        street,
        number,
        floor,
        apartment,
        updatedAt: serverTimestamp()
      };

      if (editingPropertyId) {
        // ✅ MODO EDICIÓN: Actualiza la propiedad existente sin duplicarla
        showToast("Actualizando", "Guardando modificaciones del inmueble...", "info");

        const imageFiles = Array.from(document.getElementById('prop-images')?.files || []);
        if (imageFiles.length > 0) {
          const photoUrls = [];
          for (let i = 0; i < imageFiles.length; i++) {
            const fileRef = storageRef(storage, `properties/${editingPropertyId}/foto_${i}_${Date.now()}`);
            const uploadRes = await uploadBytes(fileRef, imageFiles[i]);
            const url = await getDownloadURL(uploadRes.ref);
            photoUrls.push(url);
          }
          propertyPayload.photos = photoUrls;
          propertyPayload.mainPhoto = photoUrls[0];
        }

        await updateDoc(doc(db, "properties", editingPropertyId), propertyPayload);
        showToast("¡Inmueble Actualizado!", "Los cambios se guardaron sobre la misma propiedad.", "success");
      } else {
        // ✅ MODO ALTA NUEVA
        showToast("Procesando", "Subiendo fotos y registrando captación...", "info");
        const imageFiles = Array.from(document.getElementById('prop-images')?.files || []);
        await createPropertyRecord({
          ...propertyPayload,
          agencyId: userData.agencyId || currentUser.uid,
          createdByUid: currentUser.uid
        }, imageFiles);
        showToast("¡Inmueble Registrado!", "La propiedad fue incorporada a tu inventario.", "success");
      }

      cerrarModalPropiedad();
      await loadPortalView();
      if (currentUser && typeof loadPropertiesView === 'function') {
        await loadPropertiesView(currentUser);
      }

    } catch (err) {
      console.error("Error al guardar propiedad:", err);
      showToast("Error", err.message || "No se pudo guardar la propiedad.", "error");
    } finally {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.innerText = "Guardar Propiedad";
      }
    }
  });

  // ==========================================
// EVENTOS DEL MODAL DE LEADS / INTERESADOS
// ==========================================
const modalLead = document.getElementById('modal-lead');
const btnNuevoLead = document.getElementById('btn-nuevo-lead');
const btnCloseLead = document.getElementById('btn-close-lead-modal');
const btnCancelLead = document.getElementById('btn-cancel-lead');
const formLead = document.getElementById('form-lead');
const selectLeadProp = document.getElementById('lead-property-id');

if (btnNuevoLead) {
 btnNuevoLead.addEventListener('click', () => {
   if (formLead) formLead.reset();

   // Llenar combo de propiedades disponibles con las del caché
   if (selectLeadProp) {
     selectLeadProp.innerHTML = `<option value="">-- Consulta Abierta / Sin inmueble asignado --</option>` +
     cachedProperties.map(p => `<option value="${p.id}">${escapeHtml(p.title)} ($${Number(p.price).toLocaleString('es-AR')})</option>`).join('');
   }

   modalLead?.classList.remove('hidden');
   modalLead?.classList.add('flex');
 });
}

const cerrarModalLead = () => {
 modalLead?.classList.add('hidden');
 modalLead?.classList.remove('flex');
};

btnCloseLead?.addEventListener('click', cerrarModalLead);
btnCancelLead?.addEventListener('click', cerrarModalLead);

formLead?.addEventListener('submit', async (e) => {
 e.preventDefault();
 const submitBtn = document.getElementById('btn-submit-lead');
 if (submitBtn) {
   submitBtn.disabled = true;
   submitBtn.innerText = "Guardando...";
 }

 try {
   const userDoc = await getDoc(doc(db, "users", currentUser.uid));
   const userData = userDoc.exists() ? userDoc.data() : {};

   const propId = selectLeadProp?.value || null;
   let propTitle = 'Búsqueda Abierta';
   if (propId) {
     const found = cachedProperties.find(p => p.id === propId);
     if (found) propTitle = found.title;
   }

   const leadPayload = {
     name: document.getElementById('lead-name')?.value || '',
     dni: document.getElementById('lead-dni')?.value || '',
     phone: document.getElementById('lead-phone')?.value || '',
     email: document.getElementById('lead-email')?.value || '',
     propertyId: propId,
     propertyTitle: propTitle,
     budget: document.getElementById('lead-budget')?.value || 0,
     preferredType: document.getElementById('lead-preferred-type')?.value || '',
     notes: document.getElementById('lead-notes')?.value || '',
     status: document.getElementById('lead-status')?.value || 'NUEVO',
     agencyId: userData.agencyId || currentUser.uid
   };

   await createLeadRecord(leadPayload);

   showToast("¡Interesado Guardado!", "El postulante fue incorporado al pipeline comercial.", "success");
   cerrarModalLead();
   if (currentUser && typeof loadLeadsView === 'function') {
     await loadLeadsView(currentUser);
   }
 } catch (err) {
   console.error("Error al registrar lead:", err);
   showToast("Error", err.message || "No se pudo registrar al interesado.", "error");
 } finally {
   if (submitBtn) {
     submitBtn.disabled = false;
     submitBtn.innerText = "Guardar Interesado";
   }
 }
});

const filterStatusSelect = document.getElementById('filter-lead-status');
filterStatusSelect?.addEventListener('change', () => {
 renderLeadsList(cachedLeads, filterStatusSelect.value);
});
 // Filtros combinados de Inventario de Propiedades (Operación + Estado)
const filterOpSelect = document.getElementById('filter-prop-operation');
const filterStatSelect = document.getElementById('filter-prop-status');

const aplicarFiltrosInventario = () => {
  const op = filterOpSelect?.value || 'ALL';
  const st = filterStatSelect?.value || 'ALL';
  const baseList = activePropertySubTab === 'OWN' ? cachedProperties : cachedNetworkProperties;

  const filtered = baseList.filter(p => {
    const matchOp = op === 'ALL' || (p.operation || 'ALQUILER_TRADICIONAL') === op;
    const matchSt = st === 'ALL' || p.status === st;
    return matchOp && matchSt;
  });

  renderPropertiesGrid(filtered, activePropertySubTab === 'NETWORK');
};

filterOpSelect?.addEventListener('change', aplicarFiltrosInventario);
filterStatSelect?.addEventListener('change', aplicarFiltrosInventario);
}

function setupFormHandlers() {
  const loginForm = document.getElementById('form-login');
  if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dni = document.getElementById('login-dni').value.trim();
      const password = document.getElementById('login-password').value;

      try {
        await loginWithDni(dni, password);
        showToast("Sesión Iniciada", "Acceso concedido al ecosistema.", "success");
        document.getElementById('login-password').value = "";
        const destination = pendingRedirectView || 'home';
        pendingRedirectView = null;
        switchTab(destination);
      } catch (err) {
        showToast("Error de Acceso", err.message, "error");
      }
    });
  }

  const showRecoveryBtn = document.getElementById('btn-show-recovery');
  const cancelRecoveryBtn = document.getElementById('btn-cancel-recovery');
  const recoveryContainer = document.getElementById('view-recovery-container');
  const loginFormElement = document.getElementById('form-login');

  if (showRecoveryBtn && recoveryContainer) {
    showRecoveryBtn.addEventListener('click', () => {
      if (loginFormElement) loginFormElement.classList.add('hidden');
      showRecoveryBtn.parentElement.classList.add('hidden');
      recoveryContainer.classList.remove('hidden');
    });
  }

  if (cancelRecoveryBtn && recoveryContainer) {
    cancelRecoveryBtn.addEventListener('click', () => {
      recoveryContainer.classList.add('hidden');
      if (loginFormElement) loginFormElement.classList.remove('hidden');
      if (showRecoveryBtn) showRecoveryBtn.parentElement.classList.remove('hidden');
    });
  }

  const recoveryForm = document.getElementById('form-recovery');
  if (recoveryForm) {
    recoveryForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const dniInput = document.getElementById('recovery-dni').value.trim();

      try {
        showToast("Procesando", "Verificando identidad en el padrón...", "success");
        await resetPasswordByDni(dniInput);
        
        showToast("Correo Enviado", "Si el DNI se encuentra registrado, recibirá las instrucciones en su correo asociado.", "success");
        recoveryForm.reset();
        recoveryContainer.classList.add('hidden');
        if (loginFormElement) loginFormElement.classList.remove('hidden');
        if (showRecoveryBtn) showRecoveryBtn.parentElement.classList.remove('hidden');
      } catch (err) {
        showToast("Error de Recuperación", err.message, "error");
      }
    });
  }

  const settingsForm = document.getElementById('form-settings');
  if (settingsForm) {
    settingsForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!currentUser) return;

      const passwordInput = document.getElementById('settings-password-confirm')?.value;
      if (!passwordInput) {
        showToast("Seguridad Requerida", "Ingresá tu contraseña actual para confirmar las modificaciones.", "error");
        document.getElementById('settings-password-confirm')?.focus();
        return;
      }

      const btnSave = document.getElementById('btn-save-settings');
      if (btnSave) {
        btnSave.disabled = true;
        btnSave.innerText = "Validando...";
      }

      try {
        showToast("Verificando Clave", "Autenticando credenciales de seguridad...", "info");

        // 1. Reautenticación estricta con Firebase Auth
        const credential = EmailAuthProvider.credential(currentUser.email, passwordInput);
        await reauthenticateWithCredential(currentUser, credential);

        // 2. Extraer datos si la clave fue correcta
        const movil = document.getElementById('settings-movil').value.trim();
        const emailLegal = document.getElementById('settings-email').value.trim();
        const condicionFiscal = document.getElementById('settings-fiscal').value;
        const cuit = document.getElementById('settings-cuit')?.value.trim() || '';
        const province = document.getElementById('settings-province')?.value || 'Salta';
        const city = document.getElementById('settings-city')?.value.trim() || '';
        const address = document.getElementById('settings-address')?.value.trim() || '';

        // 3. Persistir en Firestore
        const userRef = doc(db, "users", currentUser.uid);
        await setDoc(userRef, {
          movil,
          emailLegal,
          condicionFiscal,
          cuit,
          province,
          city,
          address,
          "metadata.updatedAt": serverTimestamp()
        }, { merge: true });

        // 4. Volver a bloquear en modo seguro
        setSettingsEditMode(false);
        updateAuthUI(currentUser);
        showToast("¡Actualizado!", "Los cambios se guardaron con confirmación de seguridad.", "success");

      } catch (err) {
        console.error("Error al guardar configuración:", err);
        if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
          showToast("Contraseña Incorrecta", "La contraseña ingresada no es válida. No se aplicaron cambios.", "error");
        } else {
          showToast("Error de Actualización", err.message || "No se pudo actualizar el perfil.", "error");
        }
      } finally {
        if (btnSave) {
          btnSave.disabled = false;
          btnSave.innerText = "Guardar Cambios";
        }
      }
    });
  }

  const cucisField = document.getElementById('onb-nromatricula');
  if (cucisField) {
    cucisField.addEventListener('input', (e) => {
      e.target.value = e.target.value.replace(/\D/g, '');
    });
  }

  const onboardingForm = document.querySelector('#view-onboarding form');
  if (onboardingForm) {
    onboardingForm.addEventListener('submit', async (e) => {
      e.preventDefault();

      const consentCheckbox = document.getElementById('onb-consent-checkbox');
      if (!consentCheckbox || !consentCheckbox.checked) {
        showToast("Consentimiento Requerido", "Debe aceptar la declaración de consentimiento expreso (Ley 25.326).", "error");
        return;
      }

      const dni = document.getElementById('onb-cuit').value.trim();
      const password = document.getElementById('onb-password').value;
      const nombre = document.getElementById('onb-nombre').value.trim();
      const email = document.getElementById('onb-email').value.trim();
      const movil = document.getElementById('onb-movil').value.trim();
      const condicionFiscal = document.getElementById('onb-fiscal').value;

      try {
        showToast("Procesando", "Registrando identidad en la red segura...", "success");

        if (activeOnboardingRole === 'MATRICULADO_CUCIS' || activeOnboardingRole === 'AGENCY_OWNER') {
          const dniFile = document.getElementById('onb-mat-dni-file')?.files[0];
          const credentialFile = document.getElementById('onb-credential-file')?.files[0];
          const nroMatricula = document.getElementById('onb-nromatricula').value.trim();
          const nombreFantasia = document.getElementById('onb-fantasia').value.trim();

          if (!dniFile || !credentialFile) {
            throw new Error("Debe adjuntar la foto del DNI y la credencial CUCIS para validar el alta profesional.");
          }

          const cleanDni = dni.replace(/\D/g, '');
          const userCredential = await createUserWithEmailAndPassword(auth, `dni_${cleanDni}@inquilia.local`, password);
          const userId = userCredential.user.uid;

          try {
            const userRef = doc(db, "users", userId);
            await setDoc(userRef, {
              dni: cleanDni,
              emailLegal: email,
              nombre,
              movil,
              condicionFiscal,
              nombreFantasia,
              nroMatricula,
              role: 'LANDLORD',
              roles: ['LANDLORD'],
              creditos: 0,
              freeQueriesCount: 0,
              lastFreeQueryMonth: "",
              agencyId: userId,
              status: 'PENDIENTE_OCR',
              metadata: { createdAt: serverTimestamp() }
            });

            showToast("Procesando OCR", "Verificando documentos en los servidores...", "success");
            await submitAndVerifyDocuments(userId, dniFile, credentialFile, cleanDni, nroMatricula);

          } catch (ocrError) {
            try { await userCredential.user.delete(); } catch (e) { console.error("Error limpiando Auth:", e); }
            throw ocrError;
          }

          await setDoc(doc(db, "unique_indexes", `dni_${cleanDni}`), {
            uid: userId,
            createdAt: new Date().toISOString()
          });

          const initialCredits = 0;
          await setDoc(doc(db, "agencies", userId), {
            name: nombreFantasia,
            cuit: cleanDni,
            nroMatricula,
            ownerUid: userId,
            creditos: initialCredits,
            status: "ACTIVO",
            metadata: {
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp()
            }
          });

          await addDoc(collection(db, "credit_transactions"), {
            agencyId: userId,
            actorUid: userId,
            type: 'INITIAL_GRANT',
            amount: initialCredits,
            balanceBefore: 0,
            balanceAfter: initialCredits,
            description: `Apertura de cuenta corporativa CUCIS Mat. ${nroMatricula}`,
            timestamp: serverTimestamp()
          });

          cachedAgencyData = null;
          await updateAuthUI(userCredential.user);
          showToast("¡Matrícula Validada!", "El OCR confirmó los datos con éxito. Cuenta activa.", "success");
        } else {
          const formData = {
            dni,
            password,
            emailLegal: email,
            nombre,
            movil,
            condicionFiscal,
            consentLog: {
              isAdultChecked: document.getElementById('onb-is-adult')?.checked || false
            }
          };

          await registerCivilUser(formData);
          showToast("¡Cuenta Creada!", "Registro homologado con éxito.", "success");
        }

        onboardingForm.reset();
        window.selectOnboardingRole('PARTICULAR_PROPIETARIO');
        switchTab('home');

      } catch (err) {
        showToast("Error de Registro", err.message, "error");
      }
    });
}

const upgradeForm = document.getElementById('form-upgrade-cucis');
if (upgradeForm) {
  upgradeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const nroMatricula = document.getElementById('settings-nro-matricula').value.trim();
    const nombreFantasiaEl = document.getElementById('settings-fantasia-upgrade') || document.getElementById('settings-fantasia');
    const nombreFantasia = nombreFantasiaEl ? nombreFantasiaEl.value.trim() : '';
    const credentialFile = document.getElementById('settings-credential-file').files[0];

    if (!credentialFile || !nroMatricula) {
      showToast("Faltan datos", "Ingresá el número de matrícula y adjuntá la credencial CUCIS.", "error");
      return;
    }

    try {
      showToast("Procesando", "Verificando credencial en los servidores...", "success");

      await upgradeUserToMatriculado(currentUser.uid, credentialFile, nroMatricula, nombreFantasia);

      cachedAgencyData = null;
      await updateAuthUI(currentUser);
      showToast("¡Perfil Actualizado!", "Se incorporó el rol de Inmobiliaria a tu cuenta.", "success");
      upgradeForm.reset();
      switchTab('home');
    } catch (err) {
      showToast("Error de Activación", err.message, "error");
    }
  });
}
}

async function upgradeUserToMatriculado(userId, credentialFile, nroMatricula, nombreFantasia) {
  const userRef = doc(db, "users", userId);
  const userSnap = await getDoc(userRef);

  if (!userSnap.exists()) {
    throw new Error("No se encontraron los datos del usuario en la base de datos.");
  }

  await submitCredentialOnly(userId, credentialFile, nroMatricula, nombreFantasia);

  const userData = userSnap.data();
  const initialCredits = 0;

  const agencyRef = doc(db, "agencies", userId);
  await setDoc(agencyRef, {
    name: nombreFantasia.trim(),
    cuit: userData.dni || '',
    nroMatricula: nroMatricula.trim(),
    ownerUid: userId,
    creditos: initialCredits,
    status: "ACTIVO",
    metadata: {
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp()
    }
  });

  await addDoc(collection(db, "credit_transactions"), {
    agencyId: userId,
    actorUid: userId,
    type: 'INITIAL_GRANT',
    amount: initialCredits,
    balanceBefore: 0,
    balanceAfter: initialCredits,
    description: `Activación de estructura inmobiliaria CUCIS Mat. ${nroMatricula.trim()}`,
    timestamp: serverTimestamp()
  });

  await updateDoc(userRef, {
    nroMatricula: nroMatricula.trim(),
    nombreFantasia: nombreFantasia.trim(),
    agencyId: userId,
    "metadata.upgradedAt": serverTimestamp()
  });

  return true;
}

function setupAgentModal() {
  const openBtn = document.getElementById('btn-open-agent-modal');
  const closeBtn = document.getElementById('btn-close-agent-modal');
  const cancelBtn = document.getElementById('btn-cancel-agent-modal');
  const modal = document.getElementById('agent-modal');
  const form = document.getElementById('form-link-agent');

  if (!modal || !form) return;

  if (openBtn) {
    openBtn.addEventListener('click', () => modal.classList.remove('hidden'));
  }
  if (closeBtn) {
    closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }
  if (cancelBtn) {
    cancelBtn.addEventListener('click', () => modal.classList.add('hidden'));
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!currentUser) return;

    const dniInput = document.getElementById('agent-dni-input').value.trim().replace(/\D/g, '');
    if (!dniInput) {
      showToast("Error", "Ingresá un DNI válido.", "error");
      return;
    }

    try {
      showToast("Procesando", "Buscando usuario en la red...", "success");

      const usersRef = collection(db, "users");
      const q = query(usersRef, where("dni", "==", dniInput));
      const querySnapshot = await getDocs(q);

      if (querySnapshot.empty) {
        throw new Error("No existe un usuario registrado con ese DNI. Debe registrarse en la plataforma primero.");
      }

      const userDocSnap = querySnapshot.docs[0];
      const targetUserId = userDocSnap.id;
      const targetData = userDocSnap.data();

      if (targetUserId === currentUser.uid) {
        throw new Error("No podés vincularte a vos mismo como agente.");
      }

      if (targetData.agencyId && targetData.agencyId !== currentUser.uid) {
        throw new Error("Este usuario ya se encuentra vinculado a otra estructura inmobiliaria.");
      }

      const targetUserRef = doc(db, "users", targetUserId);
      let currentRoles = (targetData.roles || ["LANDLORD"]).map(normalizeRole);
      
      if (!currentRoles.includes("AGENCY_EMPLOYEE")) {
        currentRoles.push("AGENCY_EMPLOYEE");
      }
      if (!currentRoles.includes("LANDLORD")) {
        currentRoles.push("LANDLORD");
      }

      currentRoles = [...new Set(currentRoles.filter(r => r !== 'AGENCY_OWNER'))];
      
      await updateDoc(targetUserRef, {
        agencyId: currentUser.uid,
        roles: currentRoles
      });

      showToast("¡Agente Vinculado!", "El usuario fue incorporado a tu red correctamente.", "success");
      form.reset();
      modal.classList.add('hidden');

      await loadAgencyAgents(currentUser.uid);

    } catch (err) {
      showToast("Error de Vinculación", err.message, "error");
    }
  });
}

// ============================================================================
// CONSULTA Y RENDERIZADO DEL INFORME DE BURÓ LOCATIVO
// ============================================================================
async function fetchAndRenderReport(dniAConsultar, shouldAudit = true) {
  const resultsContainer = document.getElementById('search-results-container');
  const resultContent = document.getElementById('search-result-content');
  const reportNavBar = document.getElementById('report-nav-bar');
  const searchFormContainer = document.getElementById('search-form-container');
  
  if (!resultsContainer || !resultContent) return;

  resultsContainer.classList.remove('hidden');

  if (reportNavigationOrigin === 'history') {
    if (searchFormContainer) searchFormContainer.classList.add('hidden');
    if (reportNavBar) reportNavBar.classList.remove('hidden');
  } else {
    if (searchFormContainer) searchFormContainer.classList.remove('hidden');
    if (reportNavBar) reportNavBar.classList.add('hidden');
  }

  resultContent.innerHTML = '<div class="text-xs text-slate-400 animate-pulse text-center py-4">Buscando perfil en el buró...</div>';

  try {
    if (shouldAudit) {
      showToast("Procesando", "Verificando créditos y ejecutando consulta...", "success");
      
      await ejecutarConsultaConAuditoria(dniAConsultar);

      const userRef = doc(db, "users", currentUser.uid);
      const userSnap = await getDoc(userRef);
      if (userSnap.exists()) {
        const freshUserData = userSnap.data();
        const updatedCredits = await resolveCreditsForContext(activeContext, freshUserData);
        const creditosEl = document.getElementById('header-credits');
        if (creditosEl) {
          creditosEl.textContent = updatedCredits;
        }
      }
    } else {
      showToast("Cargando", "Recuperando informe vigente desde el historial...", "success");
    }

    const rentalsRef = collection(db, "verified_rentals");
    const q = query(rentalsRef, where("dni", "==", dniAConsultar));
    const querySnapshot = await getDocs(q);

    if (querySnapshot.empty) {
      currentReportData = null;
      resultContent.innerHTML = `
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-6 text-center space-y-2">
          <p class="text-xs text-amber-400 font-bold">Sin registros de contratos activos</p>
          <p class="text-[11px] text-slate-400">El DNI ${dniAConsultar} no posee certificados cargados en la red.</p>
        </div>
      `;
      showToast("Consulta Realizada", "No se encontraron certificados activos.", shouldAudit ? "success" : "info");
      return;
    }

    const rentalDocs = querySnapshot.docs.map(d => d.data());
    
    let totalMesesHistoricos = 0;
    let sumaPonderadaScore = 0;
    let totalOnTime = 0;
    let totalLate = 0;
    let deudaTotalVigente = 0;
    let totalRetenciones = 0;
    let peorConservacion = 'Bueno';
    const rebuttalsFound = [];

    rentalDocs.forEach(r => {
      const meses = (r.behavior?.onTime || 0) + (r.behavior?.late || 0) || r.totalMonths || 1;
      totalMesesHistoricos += meses;
      sumaPonderadaScore += (r.scoreRentia || 0) * meses;
      totalOnTime += (r.behavior?.onTime || 0);
      totalLate += (r.behavior?.late || 0);
      
      const retencionContrato = Number(r.behavior?.debtAmount) || 0;
      deudaTotalVigente += retencionContrato;

      if (retencionContrato > 0) {
        totalRetenciones++;
      }

      if (r.behavior?.conservation === 'Daños Documentados') {
        peorConservacion = 'Daños Documentados';
      }

      if (r.rebuttal && r.rebuttal.statement && String(r.rebuttal.statement).trim() !== '') {
        rebuttalsFound.push({
          propertyAddress: r.propertyAddress || 'Inmueble auditado',
          statement: r.rebuttal.statement,
          submittedAt: r.rebuttal.submittedAt,
          status: r.rebuttal.status || 'PRESENTADA'
        });
      }
    });

    const rawScore = totalMesesHistoricos > 0
    ? Math.round(sumaPonderadaScore / totalMesesHistoricos)
    : (rentalDocs[0].scoreRentia || 0);

    const scoreConsolidado = rawScore > 100 
    ? Math.max(1, Math.min(100, Math.round(rawScore / 10))) 
    : Math.max(1, Math.min(100, Math.round(rawScore || 0)));

    const mainRecord = rentalDocs[0];
    const scoreColor = scoreConsolidado >= 70 ? 'text-[#16c2a3]' : (scoreConsolidado >= 45 ? 'text-amber-400' : 'text-rose-400');
    const scoreRating = scoreConsolidado >= 70 ? 'Excelente Solvencia' : (scoreConsolidado >= 45 ? 'Riesgo Moderado' : 'Alto Riesgo Locativo');

    let retencionLabel = '0 contratos';
    let retencionColor = 'text-emerald-400';
    let retencionDetalle = 'Fianzas devueltas 100%';

    if (totalRetenciones === 1) {
      retencionLabel = '1 contrato';
      retencionColor = 'text-amber-400';
      retencionDetalle = `$${deudaTotalVigente.toLocaleString('es-AR')} retenidos (${peorConservacion === 'Daños Documentados' ? 'Con daños' : 'Por mora'})`;
    } else if (totalRetenciones > 1) {
      retencionLabel = `${totalRetenciones} contratos (Reincidente)`;
      retencionColor = 'text-rose-400';
      retencionDetalle = `$${deudaTotalVigente.toLocaleString('es-AR')} retenidos en total`;
    }

    currentReportData = {
      dni: dniAConsultar,
      name: mainRecord.name || 'Sin Nombre Registrado',
      scoreConsolidado,
      totalMesesHistoricos,
      totalOnTime,
      totalLate,
      deudaTotalVigente,
      totalRetenciones,
      peorConservacion,
      contracts: rentalDocs,
      rebuttals: rebuttalsFound
    };

    resultContent.innerHTML = `
      <div class="space-y-4">
        <div class="flex flex-col sm:flex-row justify-between items-start sm:items-center border-b border-slate-800 pb-4 gap-3">
          <div>
            <div class="flex items-center gap-2 mb-1">
              <span class="text-[10px] uppercase tracking-widest text-[#16c2a3] font-bold">Buró Locativo Homologado</span>
              <span class="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
                ${rentalDocs.length} ${rentalDocs.length === 1 ? 'Contrato Certificado' : 'Contratos Certificados'}
              </span>
            </div>
            <h3 class="text-xl font-black text-white">${mainRecord.name || 'Sin Nombre Registrado'}</h3>
            <p class="text-xs text-slate-400">DNI: <span class="text-slate-200 font-semibold">${dniAConsultar}</span></p>
          </div>

          <div class="flex items-center gap-4 w-full sm:w-auto justify-between sm:justify-end">
            <div class="text-left sm:text-right">
              <span class="text-[10px] uppercase text-slate-400 block font-bold">Score Reputacional</span>
              <span class="text-3xl font-black ${scoreColor} tracking-tight">${scoreConsolidado} <span class="text-xs font-normal text-slate-500">/ 100</span></span>
              <span class="text-[10px] font-bold block ${scoreColor}">${scoreRating}</span>
            </div>

            <button type="button" onclick="descargarInformeBuroPdf()" class="px-3.5 py-2.5 bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-md flex items-center gap-1.5 cursor-pointer shrink-0" title="Descargar Informe de Buró en PDF">
              <i data-lucide="download" class="w-4 h-4"></i> PDF
            </button>
          </div>
        </div>

        <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div class="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-bold block">Madurez Histórica</span>
            <span class="text-base font-black text-white mt-0.5 block">${totalMesesHistoricos} meses</span>
            <span class="text-[9px] text-slate-500">Tiempo evaluado</span>
          </div>
          <div class="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-bold block">Pagos a Término</span>
            <span class="text-base font-black text-emerald-400 mt-0.5 block">${totalOnTime} meses</span>
            <span class="text-[9px] text-slate-500">Sin atrasos</span>
          </div>
          <div class="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-bold block">Mora Registrada</span>
            <span class="text-base font-black ${totalLate > 0 ? 'text-amber-400' : 'text-slate-400'} mt-0.5 block">${totalLate} meses</span>
            <span class="text-[9px] text-slate-500">Atrasos técnicos</span>
          </div>
          <div class="bg-slate-900/80 p-3.5 rounded-xl border border-slate-800">
            <span class="text-[10px] text-slate-400 uppercase font-bold block">Depósitos Retenidos</span>
            <span class="text-base font-black ${retencionColor} mt-0.5 block">${retencionLabel}</span>
            <span class="text-[9px] text-slate-500">${retencionDetalle}</span>
          </div>
        </div>

        ${renderRebuttalsBlock(rebuttalsFound)}
      </div>
    `;

    if (window.lucide) window.lucide.createIcons();
    showToast("¡Informe Cargado!", "Datos consolidados correctamente.", "success");

  } catch (err) {
    currentReportData = null;
    resultsContainer.classList.remove('hidden');
    resultContent.innerHTML = `
      <div class="bg-rose-950/40 border border-rose-900/50 rounded-xl p-4 text-center">
        <p class="text-xs text-rose-400 font-bold">${err.message}</p>
      </div>
    `;
    showToast("Error", err.message, "error");
  }
}

// ============================================================================
// CONTROLADORES DE BÚSQUEDA Y NAVEGACIÓN DE AUDITORÍA
// ============================================================================
function setupSearchHandler() {
  const searchForm = document.getElementById('form-search');
  const dniInput = document.getElementById('search-dni-input');
  
  if (!searchForm || !dniInput) return;

  searchForm.onsubmit = async (e) => {
    e.preventDefault();
    e.stopPropagation();

    const dniAConsultar = dniInput.value.trim().replace(/\D/g, '');
    if (!dniAConsultar) {
      showToast("Atención", "Por favor, ingresá un DNI a consultar.", "error");
      return;
    }

    reportNavigationOrigin = 'search';
    await fetchAndRenderReport(dniAConsultar, true);
  };
}

window.viewActiveReport = (dni) => {
  reportNavigationOrigin = 'history';
  switchTab('search');
  const inputDni = document.getElementById('search-dni-input');
  if (inputDni) {
    inputDni.value = dni;
    fetchAndRenderReport(dni, false);
  }
};

window.volverAlHistorial = () => {
  reportNavigationOrigin = null;
  const navBar = document.getElementById('report-nav-bar');
  const searchFormContainer = document.getElementById('search-form-container');
  const resultsContainer = document.getElementById('search-results-container');

  if (navBar) navBar.classList.add('hidden');
  if (searchFormContainer) searchFormContainer.classList.remove('hidden');
  if (resultsContainer) resultsContainer.classList.add('hidden');
  
  switchTab('history');
};

window.triggerReSearch = (dni) => {
  if (confirm(`El informe de este DNI (${dni}) superó los 30 días de validez. Realizar una nueva consulta consumirá una consulta mensual o un crédito. ¿Deseas continuar?`)) {
    reportNavigationOrigin = 'history';
    switchTab('search');
    const inputDni = document.getElementById('search-dni-input');
    if (inputDni) {
      inputDni.value = dni;
      fetchAndRenderReport(dni, true);
    }
  }
};

// ============================================================================
// CONMUTADOR DE MODO DE CERTIFICACIÓN (VIGENTE vs HISTÓRICO)
// ============================================================================
window.toggleCertMode = function(mode) {
  const btnNext = document.getElementById('btn-next-step');
  const labelOngoing = document.getElementById('label-mode-ongoing');
  const labelRetro = document.getElementById('label-mode-retroactive');
  const totalSteps = document.getElementById('cert-total-steps');
  const pendingContainer = document.getElementById('certify-pending-contracts-container');

  if (mode === 'ONGOING') {
    if (btnNext) {
      btnNext.innerText = "Registrar Contrato Activo";
      btnNext.className = "bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] font-black px-6 py-3 rounded-xl uppercase tracking-wider transition-all shadow-lg cursor-pointer";
    }
    if (totalSteps) totalSteps.innerText = "1";
    if (labelOngoing) {
      labelOngoing.className = "flex items-start gap-3 p-3.5 rounded-xl border border-[#16c2a3]/50 bg-[#16c2a3]/10 cursor-pointer transition-all";
    }
    if (labelRetro) {
      labelRetro.className = "flex items-start gap-3 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40 cursor-pointer transition-all hover:border-slate-700";
    }

    if (pendingContainer && pendingContainer.dataset.hasPending === "true") {
      pendingContainer.classList.remove('hidden');
    }
  } else {
    if (btnNext) {
      btnNext.innerText = "Siguiente: Comportamiento y Pagos →";
      btnNext.className = "bg-indigo-600 hover:bg-indigo-700 text-white font-bold px-6 py-3 rounded-xl uppercase tracking-wider transition-all cursor-pointer";
    }
    if (totalSteps) totalSteps.innerText = "2";
    if (labelOngoing) {
      labelOngoing.className = "flex items-start gap-3 p-3.5 rounded-xl border border-slate-800 bg-slate-950/40 cursor-pointer transition-all hover:border-slate-700";
    }
    if (labelRetro) {
      labelRetro.className = "flex items-start gap-3 p-3.5 rounded-xl border border-indigo-500/50 bg-indigo-500/10 cursor-pointer transition-all";
    }

    if (pendingContainer) {
      pendingContainer.classList.add('hidden');
    }
  }
};

async function loadCertifyPendingContracts(user) {
  const container = document.getElementById('certify-pending-contracts-container');
  const listEl = document.getElementById('certify-pending-contracts-list');
  if (!container || !listEl) return;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const userDniClean = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';
    const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    const rentalsRef = collection(db, "verified_rentals");
    const queries = [];

    if (isAgency && targetAgencyId) {
      queries.push(getDocs(query(rentalsRef, where("metadata.agencyId", "==", targetAgencyId))));
    } else {
      if (userDniClean) {
        queries.push(getDocs(query(rentalsRef, where("propietarioDni", "==", userDniClean))));
      }
      queries.push(getDocs(query(rentalsRef, where("metadata.certifiedByUid", "==", user.uid))));
    }

    const querySnaps = await Promise.all(queries);
    const pendingMap = new Map();
    querySnaps.forEach(snap => {
      snap.forEach(d => {
        const data = d.data();
        if (data.status === 'EN_CURSO') {
          pendingMap.set(d.id, { id: d.id, ...data });
        }
        cachedContractsMap.set(d.id, { id: d.id, ...data });
      });
    });

    let pending = Array.from(pendingMap.values());

    if (isAgency && targetAgencyId) {
      pending = pending.filter(c => c.metadata?.agencyId === targetAgencyId);
    } else {
      pending = pending.filter(c => {
        const agId = c.metadata?.agencyId;
        if (!agId) return true;
        const ownerDniClean = String(c.propietarioDni || '').replace(/\D/g, '');
        return userDniClean && ownerDniClean === userDniClean;
      });
    }

    if (pending.length === 0) {
      container.classList.add('hidden');
      container.dataset.hasPending = "false";
      return;
    }

    container.dataset.hasPending = "true";
    
    const activeMode = document.querySelector('input[name="cert-mode"]:checked')?.value || 'ONGOING';
    if (activeMode === 'ONGOING') {
      container.classList.remove('hidden');
    } else {
      container.classList.add('hidden');
    }

    listEl.innerHTML = pending.map(c => `
      <div class="bg-slate-950/80 border border-[#16c2a3]/30 p-4 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <p class="text-xs font-bold text-white">${escapeHtml(c.propertyAddress || 'Inmueble sin dirección')}</p>
          <p class="text-[11px] text-slate-400 mt-0.5">
            Inquilino: <span class="text-slate-200 font-semibold">${escapeHtml(c.name || 'S/D')}</span> (DNI: ${c.dni || c.tenantDni})
          </p>
          <p class="text-[10px] text-slate-400 mt-0.5">
            Propietario: <span class="text-slate-300 font-medium">${escapeHtml(c.propietarioNombre || 'Propietario')}</span> (DNI: ${c.propietarioDni || 'S/D'})
          </p>
          <p class="text-[10px] text-slate-500">Período: ${c.start} al ${c.end} · Canon: $${Number(c.monthlyAmount || 0).toLocaleString('es-AR')}</p>
        </div>
        <button type="button" onclick="abrirModalFinalizar('${c.id}')" class="px-4 py-2 bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-md cursor-pointer shrink-0">
          Calificar y Emitir Certificado
        </button>
      </div>
    `).join('');

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error("Error al cargar contratos pendientes de certificar:", err);
  }
}

// ============================================================================
// ASISTENTE DE CARGA Y EMISIÓN DE CERTIFICADOS
// ============================================================================
function setupCertificateWizard() {
  const btnNext = document.getElementById('btn-next-step');
  const btnPrev = document.getElementById('btn-prev-step');
  const step1 = document.getElementById('cert-step-1');
  const step2 = document.getElementById('cert-step-2');
  const stepIndicator = document.getElementById('cert-current-step');
  const pendingContainer = document.getElementById('certify-pending-contracts-container');
  const activeContractCard = document.getElementById('cert-step-2-active-contract');
  const form = document.getElementById('form-certify');

  if (!btnNext || !step1 || !step2 || !form) return;

  btnNext.addEventListener('click', async () => {
    const name = document.getElementById('cert-name')?.value.trim() || '';
    const dni = document.getElementById('cert-dni')?.value.trim().replace(/\D/g, '') || '';
    
    // Extracción granular de Ubicación y Tipología (Censo)
    const street = document.getElementById('cert-street')?.value.trim() || '';
    const number = document.getElementById('cert-number')?.value.trim() || '';
    const floor = document.getElementById('cert-floor')?.value.trim() || '';
    const apartment = document.getElementById('cert-apartment')?.value.trim() || '';
    const neighborhood = document.getElementById('cert-neighborhood')?.value.trim() || '';
    const city = document.getElementById('cert-city')?.value.trim() || '';
    const province = document.getElementById('cert-province')?.value || 'Salta';
    const propertyType = document.getElementById('cert-property-type')?.value || '1 Dormitorio';

    // Composición de dirección compatible con vistas, tablas y PDF
    const streetParts = [
      street, 
      number, 
      floor ? `${floor}°` : '', 
      apartment ? `Dpto ${apartment}` : ''
    ].filter(Boolean).join(' ');

    const address = [
      streetParts, 
      neighborhood, 
      city, 
      province
    ].filter(Boolean).join(', ') || document.getElementById('cert-address')?.value.trim() || '';

    let ownerDni = document.getElementById('cert-owner-dni')?.value.trim().replace(/\D/g, '') || '';
    const ownerName = document.getElementById('cert-owner-name')?.value?.trim() || '';
    const amount = document.getElementById('cert-amount')?.value || '';
    const start = document.getElementById('cert-start')?.value || '';
    const end = document.getElementById('cert-end')?.value || '';
    const fileInput = document.getElementById('cert-annex-file');
    const mode = document.querySelector('input[name="cert-mode"]:checked')?.value || 'ONGOING';

    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const myCleanDni = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';

    if (activeContext === 'LANDLORD') {
      if (ownerDni && ownerDni !== myCleanDni) {
        showToast("Operación no permitida", "Como propietario particular, solo podés registrar inmuebles de tu titularidad con tu propio DNI.", "error");
        return;
      }
      ownerDni = myCleanDni;
    }

    if (!name || !dni || !street || !number || !city || !ownerDni || !amount || !start || !end) {
      showToast("Campos Incompletos", "Completá todos los datos obligatorios del inmueble, partes y contrato antes de continuar.", "error");
      return;
    }

    if (!fileInput || !fileInput.files[0]) {
      showToast("Evidencia Requerida", "Debe adjuntar la fotografía del anexo firmado (Ley 25.326).", "error");
      return;
    }

    certificateState = { 
      name, 
      dni, 
      address,
      street,
      number,
      floor,
      apartment,
      neighborhood,
      city,
      province,
      propertyType,
      ownerDni,
      ownerName: ownerName || (activeContext === 'LANDLORD' ? (userData.nombre || '') : ''),
      amount: parseFloat(amount), 
      start, 
      end, 
      annexFile: fileInput.files[0] 
    };

    if (mode === 'ONGOING') {
      try {
        btnNext.disabled = true;
        btnNext.innerText = "Registrando contrato...";
        showToast("Procesando", "Subiendo anexo y registrando contrato vigente...", "success");

        const annexUrl = await uploadConsentAnnexPhoto(currentUser.uid, fileInput.files[0]);
        const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
        const targetAgencyId = isAgency ? (userData.agencyId || (activeContext === 'AGENCY_OWNER' ? currentUser.uid : null)) : null;

        try {
          const functions = getFunctions(auth.app, "us-central1");
          const registrarActivo = httpsCallable(functions, "registrarContratoActivo");
          await registrarActivo({
            tenantName: name,
            tenantDni: dni,
            propertyAddress: address,
            propietarioDni: ownerDni,
            propietarioNombre: certificateState.ownerName,
            monthlyAmount: parseFloat(amount),
            start,
            end,
            annexStoragePath: annexUrl,
            province,
            city,
            neighborhood,
            propertyType,
            street,
            number,
            floor,
            apartment
          });
        } catch (fnErr) {
          await addDoc(collection(db, "verified_rentals"), {
            name,
            dni,
            tenantDni: dni,
            propertyAddress: address,
            propietarioDni: ownerDni,
            propietarioNombre: certificateState.ownerName,
            monthlyAmount: parseFloat(amount),
            start,
            end,
            status: "EN_CURSO",
            scoreRentia: null,
            paymentCompliance: null,
            totalMonths: 0,
            behavior: null,
            province,
            city,
            neighborhood,
            propertyType,
            street,
            number,
            floor,
            apartment,
            propertyDetails: {
              province,
              city,
              neighborhood,
              propertyType,
              street,
              number,
              floor,
              apartment
            },
            legalEvidence: {
              consentVerified: true,
              lawCompliance: "Ley 25.326 Art. 5 y 6 (Consentimiento Expreso)",
              annexStoragePath: annexUrl,
              signedTimestamp: serverTimestamp()
            },
            metadata: {
              certifiedByUid: currentUser.uid,
              agencyId: targetAgencyId,
              agencyName: isAgency ? (userData.nombreFantasia || 'Inmobiliaria') : null,
              createdAt: serverTimestamp()
            }
          });
        }

        showToast("¡Contrato Registrado!", "La locación fue incorporada al sistema.", "success");
        form.reset();
        certificateState = {};
        window.toggleCertMode('ONGOING');
        switchTab('expirations');

      } catch (err) {
        console.error("Error registrando contrato activo:", err);
        showToast("Error de Registro", err.message || "No se pudo registrar la locación.", "error");
      } finally {
        btnNext.disabled = false;
        btnNext.innerText = "Registrar Contrato Activo";
      }
      return;
    }

    if (pendingContainer) {
      pendingContainer.classList.add('hidden');
    }

    if (activeContractCard) {
      activeContractCard.innerHTML = `
        <div class="rounded-xl border border-[#16c2a3]/40 bg-[#16c2a3]/10 p-4 backdrop-blur-md mb-6">
          <div class="flex items-center justify-between border-b border-[#16c2a3]/20 pb-2 mb-3">
            <span class="text-[10px] font-black uppercase tracking-wider text-[#16c2a3] flex items-center gap-1.5">
              <i data-lucide="file-check-2" class="w-4 h-4"></i> Contrato a Calificar Ahora
            </span>
            <span class="text-xs font-mono text-slate-400">Paso 2 de 2</span>
          </div>
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
            <div>
              <span class="text-[10px] uppercase font-bold text-slate-400 block">Inquilino</span>
              <span class="font-bold text-white">${escapeHtml(name)}</span>
              <span class="text-[11px] text-slate-400 block font-mono">DNI: ${escapeHtml(dni)}</span>
            </div>
            <div>
              <span class="text-[10px] uppercase font-bold text-slate-400 block">Inmueble y Tipología</span>
              <span class="font-semibold text-slate-200">${escapeHtml(address)}</span>
              <span class="text-[10px] text-emerald-400 block font-medium">Tipología: ${escapeHtml(propertyType)}</span>
              <span class="text-[10px] text-slate-400 block font-mono">Propietario DNI: ${escapeHtml(ownerDni)}</span>
              <span class="text-[10px] text-slate-400 block font-mono">Canon: $${Number(amount).toLocaleString('es-AR')}</span>
            </div>
            <div>
              <span class="text-[10px] uppercase font-bold text-slate-400 block">Vigencia Evaluada</span>
              <span class="font-mono text-slate-200">${escapeHtml(start)} al ${escapeHtml(end)}</span>
              <span class="text-[10px] text-emerald-400 block font-bold">✓ Evidencia cargada</span>
            </div>
          </div>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }

    step1.classList.add('hidden');
    step2.classList.remove('hidden');
    if (stepIndicator) stepIndicator.innerText = "2";
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

if (btnPrev) {
  btnPrev.addEventListener('click', () => {
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
    if (stepIndicator) stepIndicator.innerText = "1";

    const mode = document.querySelector('input[name="cert-mode"]:checked')?.value || 'ONGOING';
    if (mode === 'ONGOING' && pendingContainer && pendingContainer.dataset.hasPending === "true") {
      pendingContainer.classList.remove('hidden');
    }
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const submitBtn = form.querySelector('button[type="submit"]');
  const originalBtnText = submitBtn ? submitBtn.innerText : "Finalizar y Registrar en Red";

  const startDate = certificateState.start || document.getElementById('cert-start')?.value;
  const endDate = certificateState.end || document.getElementById('cert-end')?.value;
  const tenantName = certificateState.name || document.getElementById('cert-name')?.value.trim();
  const tenantDni = certificateState.dni || document.getElementById('cert-dni')?.value.trim().replace(/\D/g, '');
  const propertyAddress = certificateState.address || document.getElementById('cert-address')?.value.trim();
  const ownerDni = certificateState.ownerDni || document.getElementById('cert-owner-dni')?.value.trim().replace(/\D/g, '');
  const ownerName = certificateState.ownerName || document.getElementById('cert-owner-name')?.value?.trim() || '';
  const monthlyAmount = certificateState.amount || parseFloat(document.getElementById('cert-amount')?.value || '0');
  const annexFile = certificateState.annexFile || document.getElementById('cert-annex-file')?.files[0];

  const province = certificateState.province || document.getElementById('cert-province')?.value || 'Salta';
  const city = certificateState.city || document.getElementById('cert-city')?.value.trim() || '';
  const neighborhood = certificateState.neighborhood || document.getElementById('cert-neighborhood')?.value.trim() || '';
  const propertyType = certificateState.propertyType || document.getElementById('cert-property-type')?.value || '1 Dormitorio';
  const street = certificateState.street || document.getElementById('cert-street')?.value.trim() || '';
  const number = certificateState.number || document.getElementById('cert-number')?.value.trim() || '';
  const floor = certificateState.floor || document.getElementById('cert-floor')?.value.trim() || '';
  const apartment = certificateState.apartment || document.getElementById('cert-apartment')?.value.trim() || '';

  const onTime = Math.max(0, parseInt(document.getElementById('cert-ontime')?.value, 10) || 0);
  const late = Math.max(0, parseInt(document.getElementById('cert-late')?.value, 10) || 0);
  const conservation = document.getElementById('cert-conservation')?.value || 'Bueno';
  const debtAmount = Math.max(0, parseFloat(document.getElementById('cert-debt-amount')?.value) || 0);

  const restitutionFileInput = document.getElementById('cert-restitution-file');
  const restitutionFile = restitutionFileInput?.files?.[0] || null;

  if (!startDate || !endDate || !tenantName || !tenantDni || !propertyAddress || !annexFile) {
    showToast("Datos Incompletos", "Verifique que todos los datos del contrato y el anexo estén cargados.", "error");
    return;
  }

  try {
    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.innerText = "Emitiendo Certificado...";
    }

    showToast("Procesando", "Subiendo evidencia probatoria...", "success");

    const annexPhotoUrl = await uploadConsentAnnexPhoto(currentUser.uid, annexFile);

    let restitutionActUrl = null;
    if (restitutionFile) {
      showToast("Procesando", "Subiendo acta de restitución bilateral...", "success");
      restitutionActUrl = await uploadRestitutionActFile(currentUser.uid, restitutionFile);
    }

    let calculatedScore = null;

    try {
      const functions = getFunctions(auth.app, "us-central1");
      const certificarLocacion = httpsCallable(functions, "certificarLocacionSegura");

      const response = await certificarLocacion({
        tenantName,
        tenantDni,
        propertyAddress,
        propietarioDni: ownerDni,
        propietarioNombre: ownerName,
        monthlyAmount,
        start: startDate,
        end: endDate,
        onTime,
        late,
        conservation,
        debtAmount,
        annexStoragePath: annexPhotoUrl,
        restitutionActStoragePath: restitutionActUrl,
        province,
        city,
        neighborhood,
        propertyType,
        street,
        number,
        floor,
        apartment
      });

      calculatedScore = response.data?.calculatedScore;
    } catch (fnErr) {
      console.warn("Invocación Cloud Function no disponible. Aplicando fallback de cálculo algorítmico:", fnErr);

      const totalMonths = onTime + late || 1;
      const complianceRate = Math.round((onTime / totalMonths) * 100);
      let score = Math.round((complianceRate / 100) * 80);
      if (conservation === 'Excelente') score += 10;
      else if (conservation === 'Bueno') score += 5;
      else if (conservation === 'Daños Documentados') score -= 15;
      if (debtAmount > 0) score -= 20;
      const finalScore = Math.max(1, Math.min(100, score));

      const userDoc = await getDoc(doc(db, "users", currentUser.uid));
      const userData = userDoc.exists() ? userDoc.data() : {};
      const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
      const targetAgencyId = isAgency ? (userData.agencyId || (activeContext === 'AGENCY_OWNER' ? currentUser.uid : null)) : null;

      await addDoc(collection(db, "verified_rentals"), {
        name: tenantName,
        dni: tenantDni,
        tenantDni: tenantDni,
        propertyAddress,
        propietarioDni: ownerDni,
        propietarioNombre: ownerName,
        monthlyAmount,
        start: startDate,
        end: endDate,
        status: "FINALIZADO",
        scoreRentia: calculatedScore,
        paymentCompliance: complianceRate,
        totalMonths,
        province,
        city,
        neighborhood,
        propertyType,
        street,
        number,
        floor,
        apartment,
        propertyDetails: {
          province,
          city,
          neighborhood,
          propertyType,
          street,
          number,
          floor,
          apartment
        },
        behavior: {
          onTime,
          late,
          conservation,
          debtAmount,
          closedAt: serverTimestamp()
        },
        legalEvidence: {
          consentVerified: true,
          lawCompliance: "Ley 25.326 Art. 5 y 6 (Consentimiento Expreso)",
          annexStoragePath: annexPhotoUrl,
          restitutionActStoragePath: restitutionActUrl || null,
          hasBilateralRestitution: !!restitutionActUrl,
          signedTimestamp: serverTimestamp(),
          retentionLimitYears: debtAmount > 0 ? 5 : 2,
          closedLawCompliance: "Ley 25.326 Art. 26"
        },
        metadata: {
          certifiedByUid: currentUser.uid,
          agencyId: targetAgencyId,
          agencyName: isAgency ? (userData.nombreFantasia || 'Inmobiliaria') : null,
          createdAt: serverTimestamp(),
          finalizedAt: serverTimestamp()
        }
      });
    }

    showToast("¡Certificado Emitido!", `Registro homologado. Score otorgado: ${calculatedScore} / 100`, "success");

    form.reset();
    certificateState = {};
    window.toggleCertMode('ONGOING');
    step2.classList.add('hidden');
    step1.classList.remove('hidden');
    if (stepIndicator) stepIndicator.innerText = "1";
    switchTab('contracts');

  } catch (err) {
    console.error("Error al emitir certificado:", err);
    showToast("Error de Emisión", err.message || "No se pudo homologar el certificado.", "error");
  } finally {
    if (submitBtn) {
      submitBtn.disabled = false;
      submitBtn.innerText = originalBtnText;
    }
  }
});
}

async function handleLogout() {
  cachedAgencyData = null;
  await logoutUser();
  showToast("Sesión Finalizada", "Has desconectado tus credenciales.", "success");
  switchTab('home');
}

function showToast(title, desc, type = 'success') {
  const toast = document.getElementById('toast-msg');
  if (!toast) return;
  document.getElementById('toast-title').innerText = title;
  document.getElementById('toast-desc').innerText = desc;
  toast.className = type === 'error'
  ? "bg-rose-500/10 border border-rose-500/20 text-rose-300 px-4 py-3 rounded-lg shadow-sm flex items-start gap-3 transition-all z-50 absolute top-5 left-1/2 -translate-x-1/2"
  : "bg-emerald-500/10 border border-emerald-200 text-emerald-300 px-4 py-3 rounded-lg shadow-sm flex items-start gap-3 transition-all z-50 absolute top-5 left-1/2 -translate-x-1/2";
  toast.classList.remove('hidden');
  setTimeout(() => toast.classList.add('hidden'), 5000);
}

window.selectOnboardingRole = function(role) {
  activeOnboardingRole = role;
  const btnPart = document.getElementById('role-btn-part');
  const btnMat = document.getElementById('role-btn-mat');
  
  const containerPart = document.getElementById('role-container-particular');
  const containerMat = document.getElementById('role-container-inmobiliaria');
  
  const inputAdult = document.getElementById('onb-is-adult');
  const inputDniFile = document.getElementById('onb-dni-file');
  const inputMatDniFile = document.getElementById('onb-mat-dni-file');
  const inputCredentialFile = document.getElementById('onb-credential-file');
  const inputFantasia = document.getElementById('onb-fantasia');
  const inputMatricula = document.getElementById('onb-nromatricula');

  if (role === 'PARTICULAR_PROPIETARIO' || role === 'LANDLORD') {
    if(btnPart) btnPart.className = "p-4 rounded-xl border text-left transition-all bg-indigo-600/15 border-indigo-500/40 text-white cursor-pointer";
    if(btnMat) btnMat.className = "p-4 rounded-xl border text-left transition-all bg-slate-950/40 border-slate-850 text-slate-400 hover:text-white cursor-pointer";
    
    if(containerPart) containerPart.classList.remove('hidden');
    if(inputAdult) inputAdult.required = true;
    if(inputDniFile) inputDniFile.required = true;

    if(containerMat) containerMat.classList.add('hidden');
    if(inputMatDniFile) inputMatDniFile.required = false;
    if(inputCredentialFile) inputCredentialFile.required = false;
    if(inputFantasia) inputFantasia.required = false;
    if(inputMatricula) inputMatricula.required = false;
  } else {
    if(btnMat) btnMat.className = "p-4 rounded-xl border text-left transition-all bg-[#00cda5]/15 border-[#00cda5]/40 text-white cursor-pointer";
    if(btnPart) btnPart.className = "p-4 rounded-xl border text-left transition-all bg-slate-950/40 border-slate-850 text-slate-400 hover:text-white cursor-pointer";
    
    if(containerPart) containerPart.classList.add('hidden');
    if(inputAdult) inputAdult.required = false;
    if(inputDniFile) inputDniFile.required = false;

    if(containerMat) containerMat.classList.remove('hidden');
    if(inputMatDniFile) inputMatDniFile.required = true;
    if(inputCredentialFile) inputCredentialFile.required = true;
    if(inputFantasia) inputFantasia.required = true;
    if(inputMatricula) inputMatricula.required = true;
  }
};

// Función auxiliar para bloquear o desbloquear inputs de Configuración
function setSettingsEditMode(isEditing) {
  const editableIds = [
    'settings-cuit',
    'settings-movil',
    'settings-email',
    'settings-fiscal',
    'settings-province',
    'settings-city',
    'settings-address'
  ];

  editableIds.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = !isEditing;
      if (isEditing) {
        el.classList.remove('cursor-not-allowed', 'opacity-60', 'bg-slate-950');
        el.classList.add('bg-slate-900');
      } else {
        el.classList.add('cursor-not-allowed', 'opacity-60', 'bg-slate-950');
        el.classList.remove('bg-slate-900');
      }
    }
  });

  const btnEdit = document.getElementById('btn-edit-settings');
  const btnSave = document.getElementById('btn-save-settings');
  const btnCancel = document.getElementById('btn-cancel-settings');
  const passContainer = document.getElementById('settings-password-container');
  const passInput = document.getElementById('settings-password-confirm');

  if (btnEdit) btnEdit.classList.toggle('hidden', isEditing);
  if (btnSave) btnSave.classList.toggle('hidden', !isEditing);
  if (btnCancel) btnCancel.classList.toggle('hidden', !isEditing);
  if (passContainer) passContainer.classList.toggle('hidden', !isEditing);
  if (passInput) passInput.value = '';

  if (window.lucide) window.lucide.createIcons();
}

async function loadSettingsView(user, userData) {
  const nombreEl = document.getElementById('settings-nombre');
  if (nombreEl) {
    nombreEl.value = userData.nombre || userData.fullName || userData.name || 'No especificado en registro';
    nombreEl.disabled = true;
  }

  const dniEl = document.getElementById('settings-dni');
  if (dniEl) {
    dniEl.value = userData.dni || userData.cuit || userData.documento || '';
    dniEl.disabled = true;
  }

  const movilEl = document.getElementById('settings-movil');
  if (movilEl) movilEl.value = userData.movil || '';

  const emailEl = document.getElementById('settings-email');
  if (emailEl) emailEl.value = userData.emailLegal || user.email || '';

  const fiscalEl = document.getElementById('settings-fiscal');
  if (fiscalEl) fiscalEl.value = userData.condicionFiscal || 'Monotributo';

  const cuitEl = document.getElementById('settings-cuit');
  if (cuitEl) cuitEl.value = userData.cuit || '';

  const provinceEl = document.getElementById('settings-province');
  if (provinceEl) provinceEl.value = userData.province || userData.provincia || 'Salta';

  const cityEl = document.getElementById('settings-city');
  if (cityEl) cityEl.value = userData.city || userData.localidad || '';

  const addressEl = document.getElementById('settings-address');
  if (addressEl) addressEl.value = userData.address || userData.domicilioLegal || '';

  const fantasiaEl = document.getElementById('settings-fantasia');
  if (fantasiaEl) {
    fantasiaEl.value = userData.nombreFantasia 
    ? `${userData.nombreFantasia} (Mat: ${userData.nroMatricula || 'N/A'})` 
    : 'Particular / Sin Inmobiliaria';
    fantasiaEl.disabled = true;
  }

  // Se inicia siempre en modo de sólo lectura protegido
  setSettingsEditMode(false);

  // Escuchadores de los botones Editar y Cancelar
  const btnEdit = document.getElementById('btn-edit-settings');
  if (btnEdit) {
    btnEdit.onclick = () => setSettingsEditMode(true);
  }

  const btnCancel = document.getElementById('btn-cancel-settings');
  if (btnCancel) {
    btnCancel.onclick = () => {
      // Restablece los valores originales y bloquea
      if (movilEl) movilEl.value = userData.movil || '';
      if (emailEl) emailEl.value = userData.emailLegal || user.email || '';
      if (fiscalEl) fiscalEl.value = userData.condicionFiscal || 'Monotributo';
      if (cuitEl) cuitEl.value = userData.cuit || '';
      if (provinceEl) provinceEl.value = userData.province || userData.provincia || 'Salta';
      if (cityEl) cityEl.value = userData.city || userData.localidad || '';
      if (addressEl) addressEl.value = userData.address || userData.domicilioLegal || '';
      setSettingsEditMode(false);
    };
  }

  const upgradeContainer = document.getElementById('upgrade-cucis-container');
  const rawRoles = userData.roles || [userData.role || 'LANDLORD'];
  const userRoles = rawRoles.map(normalizeRole);

  if (upgradeContainer) {
    const isOwner = userRoles.includes('AGENCY_OWNER');
    const isEmployee = userRoles.includes('AGENCY_EMPLOYEE');

    if (!isOwner && !isEmployee) {
      upgradeContainer.classList.remove('hidden');
    } else {
      upgradeContainer.classList.add('hidden');
    }
  }

  const agentsSection = document.getElementById('cucis-agents-section');
  if (agentsSection) {
    if (activeContext === 'AGENCY_OWNER' && userRoles.includes('AGENCY_OWNER')) {
      agentsSection.classList.remove('hidden');
      await loadAgencyAgents(userData.agencyId || user.uid);
    } else {
      agentsSection.classList.add('hidden');
    }
  }
}

async function loadAgencyAgents(agencyId) {
  const tbody = document.getElementById('agents-table-body');
  if (!tbody) return;
  tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-500">Cargando red de agentes...</td></tr>`;

  try {
    const q = query(collection(db, "users"), where("agencyId", "==", agencyId));
    const snapshot = await getDocs(q);

    const agentDocs = snapshot.docs.filter(d => d.id !== agencyId);

    if (agentDocs.length === 0) {
      tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-500">No hay agentes inmobiliarios registrados en tu estructura.</td></tr>`;
      return;
    }

    const agentRowsPromises = agentDocs.map(async (docSnap) => {
      const agent = docSnap.data();
      const agentUid = docSnap.id;

      const queriesQuery = query(collection(db, "audit_queries"), where("operatorUid", "==", agentUid));
      const queriesSnap = await getCountFromServer(queriesQuery);
      const queryCount = queriesSnap.data().count;

      return `
        <tr class="hover:bg-slate-900/50 transition-colors">
          <td class="p-3 font-bold text-white">${agent.nombre || 'Sin Nombre'}</td>
          <td class="p-3 text-slate-400">DNI: ${agent.dni}</td>
          <td class="p-3 text-center font-black text-[#16c2a3]">${queryCount}</td>
          <td class="p-3 text-right flex items-center justify-end gap-2">
            <span class="px-2 py-1 rounded text-[9px] font-bold uppercase tracking-widest bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Activo</span>
            <button type="button" onclick="desvincularAgente('${agentUid}', '${escapeHtml(agent.nombre || 'Agente')}')" class="px-2.5 py-1 rounded text-[10px] font-bold uppercase bg-rose-500/10 text-rose-400 border border-rose-500/20 hover:bg-rose-500/20 transition cursor-pointer" title="Remover agente de la inmobiliaria">
              Desvincular
            </button>
          </td>
        </tr>
      `;
    });

    const rowsHtml = await Promise.all(agentRowsPromises);
    tbody.innerHTML = rowsHtml.join("");

  } catch (error) {
    console.error("Error al cargar la cartera de agentes:", error);
    tbody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-rose-400">Error al sincronizar la cartera de agentes.</td></tr>`;
  }
}

// Handler global para procesar la desvinculación
window.desvincularAgente = async (agentUid, agentName) => {
  if (!confirm(`¿Confirmás la desvinculación de ${agentName}? Perderá acceso inmediato a la bolsa corporativa de créditos.`)) {
    return;
  }

  try {
    showToast("Procesando", "Revocando vinculación con la inmobiliaria...", "success");

    await updateDoc(doc(db, "users", agentUid), {
      agencyId: null,
      roles: ['LANDLORD']
    });

    showToast("Agente Desvinculado", `${agentName} fue removido de la firma con éxito.`, "success");

    if (currentUser) {
      await loadAgencyAgents(currentUser.uid);
    }
  } catch (err) {
    console.error("Error al desvincular agente:", err);
    showToast("Error", err.message || "No se pudo desvincular al agente.", "error");
  }
};

async function ejecutarConsultaConAuditoria(targetDni) {
  if (!currentUser) throw new Error("Debe iniciar sesión para operar.");

  const userRef = doc(db, "users", currentUser.uid);

  await runTransaction(db, async (transaction) => {
    const userSnap = await transaction.get(userRef);
    if (!userSnap.exists()) throw new Error("No se encontró el perfil de usuario en la base de datos.");
    
    const userData = userSnap.data();
    const isAgente = activeContext === 'AGENCY_EMPLOYEE';
    const isTitular = activeContext === 'AGENCY_OWNER';
    const isParticular = activeContext === 'LANDLORD';
    const agencyId = userData.agencyId || (isTitular ? currentUser.uid : null);

    if ((isAgente || isTitular) && !agencyId) {
      throw new Error("No se encontró la estructura inmobiliaria vinculada.");
    }

    let isUsingFreeQuery = false;
    let balanceBefore = 0;
    let balanceAfter = 0;
    let transactionType = 'DEBIT';
    let txnDescription = `Consulta de buró DNI ${targetDni}`;

    if (isAgente || isTitular) {
      const agencyRef = doc(db, "agencies", agencyId);
      const agencySnap = await transaction.get(agencyRef);
      
      if (!agencySnap.exists()) {
        throw new Error("La inmobiliaria matriz no existe en el sistema.");
      }

      const agencyData = agencySnap.data();
      const expired = isPackExpired(agencyData.creditsExpiresAt);
      balanceBefore = expired ? 0 : (agencyData.creditos || 0);

      if (balanceBefore <= 0) {
        throw new Error(expired 
          ? "Tu ciclo mensual de consultas ha vencido. Renová tu pack para seguir operando." 
          : "La inmobiliaria no posee créditos disponibles.");
      }

      balanceAfter = balanceBefore - 1;

      transaction.update(agencyRef, {
        creditos: balanceAfter
      });

    } else if (isParticular) {
      const now = new Date();
      const currentMonthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
      
      const lastFreeMonth = userData.lastFreeQueryMonth || '';
      let freeQueries = (lastFreeMonth === currentMonthStr) ? (userData.freeQueriesCount || 0) : 0;

      const paidExpired = isPackExpired(userData.creditsExpiresAt);
      const availablePaidCredits = paidExpired ? 0 : (userData.creditos || 0);

      if (freeQueries < 2) {
        isUsingFreeQuery = true;
        balanceBefore = freeQueries;
        balanceAfter = freeQueries + 1;
        txnDescription = `Uso de beneficio mensual gratuito (${balanceAfter}/2)`;

        const updatePayload = {
          freeQueriesCount: balanceAfter,
          lastFreeQueryMonth: currentMonthStr
        };
        if (paidExpired && (userData.creditos || 0) > 0) {
          updatePayload.creditos = 0;
        }
        transaction.update(userRef, updatePayload);

      } else if (availablePaidCredits > 0) {
        balanceBefore = availablePaidCredits;
        balanceAfter = availablePaidCredits - 1;

        transaction.update(userRef, {
          creditos: balanceAfter,
          lastFreeQueryMonth: currentMonthStr
        });
      } else {
        throw new Error(paidExpired && (userData.creditos || 0) > 0
          ? "Tu pack de consultas adicionales ha vencido y ya utilizaste tus 2 consultas gratuitas del mes."
          : "Ya utilizaste tus 2 consultas gratuitas del mes y no poseés créditos adicionales vigentes.");
      }
    }

    const auditRef = doc(collection(db, "audit_queries"));
    transaction.set(auditRef, {
      operatorUid: currentUser.uid,
      agencyId: (isAgente || isTitular) ? agencyId : null,
      targetDni: targetDni.trim(),
      roleUsed: activeContext,
      usedFreeQuery: isUsingFreeQuery,
      timestamp: serverTimestamp()
    });

    const txnRef = doc(collection(db, "credit_transactions"));
    transaction.set(txnRef, {
      agencyId: (isAgente || isTitular) ? agencyId : null,
      actorUid: currentUser.uid,
      type: transactionType,
      amount: isUsingFreeQuery ? 0 : -1,
      balanceBefore: balanceBefore,
      balanceAfter: balanceAfter,
      description: txnDescription,
      timestamp: serverTimestamp()
    });
  });

  cachedAgencyData = null;
  return { success: true, message: "Consulta procesada, auditada y registrada en el ledger." };
}

async function loadHistoryView(user) {
  const historyContainer = document.getElementById('history-results-container');
  if (!historyContainer) return;

  historyContainer.innerHTML = '<div class="text-xs text-slate-400 animate-pulse">Cargando registros de auditoría...</div>';

  try {
    const q = query(
      collection(db, "audit_queries"),
      where("operatorUid", "==", user.uid)
    );
    
    const querySnapshot = await getDocs(q);
    
    if (querySnapshot.empty) {
      historyContainer.innerHTML = '<p class="text-xs text-slate-500 italic">No se registran consultas previas en tu historial.</p>';
      return;
    }

    const auditRecords = [];
    querySnapshot.forEach((docSnap) => {
      auditRecords.push({ id: docSnap.id, ...docSnap.data() });
    });

    const filteredRecords = auditRecords.filter(record => {
      return normalizeRole(record.roleUsed) === normalizeRole(activeContext);
    });

    if (filteredRecords.length === 0) {
      historyContainer.innerHTML = `<p class="text-xs text-slate-500 italic">No se registran consultas previas operando como ${formatRoleLabel(activeContext)}.</p>`;
      return;
    }

    filteredRecords.sort((a, b) => {
      const timeA = a.timestamp?.toMillis ? a.timestamp.toMillis() : 0;
      const timeB = b.timestamp?.toMillis ? b.timestamp.toMillis() : 0;
      return timeB - timeA;
    });

    let html = '<div class="space-y-3">';
    const now = new Date();

    filteredRecords.forEach((data) => {
      const timestamp = data.timestamp && data.timestamp.toDate ? data.timestamp.toDate() : new Date();
      
      const diffTime = Math.abs(now - timestamp);
      const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
      const isExpired = diffDays > 30;

      const formattedDate = timestamp.toLocaleDateString('es-AR', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

      html += `
        <div class="bg-slate-950 border ${isExpired ? 'border-amber-500/30' : 'border-slate-800'} rounded-xl p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 transition-all">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="text-xs font-black text-white">DNI Consultado: ${data.targetDni}</span>
              <span class="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase ${isExpired ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'bg-[#16c2a3]/10 text-[#16c2a3] border border-[#16c2a3]/30'}">
                ${isExpired ? 'Informe Expirado (>30 días)' : 'Vigente (Acceso Activo)'}
              </span>
            </div>
            <p class="text-[11px] text-slate-400">Fecha de consulta: <span class="text-slate-200 font-semibold">${formattedDate}</span></p>
            <p class="text-[10px] text-slate-500">Modo de uso: ${data.usedFreeQuery ? 'Beneficio mensual sin cargo' : 'Descuento por créditos'}</p>
          </div>

          <div class="flex items-center gap-2 w-full sm:w-auto">
        ${isExpired ? `
              <button onclick="triggerReSearch('${data.targetDni}')" class="w-full sm:w-auto bg-amber-500/20 hover:bg-amber-500/30 text-amber-400 border border-amber-500/40 font-bold px-4 py-2 rounded-lg text-[11px] transition-all cursor-pointer flex items-center justify-center gap-1.5">
                <i data-lucide="refresh-cw" class="w-3.5 h-3.5"></i> Actualizar Consulta
              </button>
          ` : `
              <button onclick="viewActiveReport('${data.targetDni}')" class="w-full sm:w-auto bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] font-black px-4 py-2 rounded-lg text-[11px] transition-all cursor-pointer flex items-center justify-center gap-1.5">
                <i data-lucide="eye" class="w-3.5 h-3.5"></i> Ver Informe
              </button>
          `}
          </div>
        </div>
        `;
      });

    html += '</div>';
    historyContainer.innerHTML = html;
    if (window.lucide) window.lucide.createIcons();

  } catch (error) {
    console.error("Error al cargar historial:", error);
    historyContainer.innerHTML = '<p class="text-xs text-rose-500">Error al sincronizar el historial de auditoría.</p>';
  }
}

async function loadAccountView(user) {
  const roleEl = document.getElementById('account-current-role');
  const creditsEl = document.getElementById('account-current-credits');
  const detailEl = document.getElementById('account-credits-detail');
  const expEl = document.getElementById('account-cycle-expiration');
  const subEl = document.getElementById('account-subscription-status');
  const warningBanner = document.getElementById('account-sub-warning');
  const warningMsg = document.getElementById('account-sub-warning-msg');

  // Elementos de la baja
  const btnBaja = document.getElementById('btn-account-baja');

  const agencySection = document.getElementById('account-agency-packs');
  const landlordSection = document.getElementById('account-landlord-packs');
  const employeeNotice = document.getElementById('account-employee-notice');
  const ledgerBody = document.getElementById('account-ledger-body');

  if (roleEl) roleEl.innerText = formatRoleLabel(activeContext);

  try {
    const userSnap = await getDoc(doc(db, "users", user.uid));
    if (!userSnap.exists()) return;
    const userData = userSnap.data();

    cachedAgencyData = null;
    const totalAvailable = await resolveCreditsForContext(activeContext, userData);
    if (creditsEl) creditsEl.innerText = totalAvailable;

    let targetData = userData;
    const targetAgencyId = userData.agencyId || user.uid;

    if (activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE') {
      const agSnap = await getDoc(doc(db, "agencies", targetAgencyId));
      if (agSnap.exists()) targetData = agSnap.data();
    }

    if (expEl) {
      if (targetData.creditsExpiresAt) {
        const expDate = targetData.creditsExpiresAt.toDate ? targetData.creditsExpiresAt.toDate() : new Date(targetData.creditsExpiresAt);
        const expired = new Date() > expDate;
        const formattedExp = expDate.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
        expEl.innerText = expired ? `Vencido el ${formattedExp}` : `Vigente hasta el ${formattedExp}`;
        expEl.className = expired ? "text-sm font-black text-rose-400 mt-1.5 block" : "text-sm font-black text-[#16c2a3] mt-1.5 block";
      } else {
        expEl.innerText = activeContext === 'LANDLORD' ? "Renovación día 1 (2 gratis)" : "Sin pack activo";
        expEl.className = "text-sm font-black text-amber-400 mt-1.5 block";
      }
    }

    if (subEl) {
      const subStatus = targetData.subscriptionStatus;
      const isSubActive = subStatus === 'authorized';
      const isCancelled = subStatus === 'cancelled';
      const isPaused = subStatus === 'paused';

      if (isSubActive) {
        subEl.innerText = "Activo (Cobro mensual)";
        subEl.className = "text-sm font-black text-[#16c2a3] mt-1.5 block";
        if (btnBaja) btnBaja.classList.remove('hidden'); // <-- Muestra el botón de baja
      } else if (isCancelled) {
        subEl.innerText = "Cancelado en Mercado Pago";
        subEl.className = "text-sm font-black text-rose-400 mt-1.5 block";
        if (btnBaja) btnBaja.classList.add('hidden'); // <-- Oculta el botón
      } else if (isPaused) {
        subEl.innerText = "Pausado en Mercado Pago";
        subEl.className = "text-sm font-black text-amber-400 mt-1.5 block";
        if (btnBaja) btnBaja.classList.add('hidden'); // <-- Oculta el botón
      } else {
        subEl.innerText = "Inactivo (Pago manual)";
        subEl.className = "text-sm font-black text-slate-400 mt-1.5 block";
        if (btnBaja) btnBaja.classList.add('hidden'); // <-- Oculta el botón
      }

      if (warningBanner && warningMsg) {
        const stillInCycle = targetData.creditsExpiresAt && !isPackExpired(targetData.creditsExpiresAt);

        if (isCancelled && stillInCycle) {
          warningMsg.innerText = "Has cancelado la suscripción en Mercado Pago. Podés utilizar tus créditos restantes hasta que termine el ciclo actual, pero no se renovarán automáticamente.";
          warningBanner.classList.remove('hidden');
        } else if (isPaused && stillInCycle) {
          warningMsg.innerText = "Tu débito automático se encuentra en pausa. Podés utilizar tus créditos hasta el vencimiento del ciclo, pero no se procesará el cobro del próximo mes a menos que lo reactives en Mercado Pago.";
          warningBanner.classList.remove('hidden');
        } else {
          warningBanner.classList.add('hidden');
        }
      }
    }

    if (detailEl) {
      detailEl.innerText = activeContext === 'LANDLORD'
      ? "Incluye tus 2 consultas gratis del mes + pack adicional"
      : "Cupo corporativo compartido con agentes";
    }

    if (agencySection) agencySection.classList.toggle('hidden', activeContext !== 'AGENCY_OWNER');
    if (landlordSection) landlordSection.classList.toggle('hidden', activeContext !== 'LANDLORD');
    if (employeeNotice) employeeNotice.classList.toggle('hidden', activeContext !== 'AGENCY_EMPLOYEE');

    if (ledgerBody) {
      const txnField = (activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE') ? "agencyId" : "actorUid";
      const txnValue = (activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE') ? targetAgencyId : user.uid;

      const qTxn = query(collection(db, "credit_transactions"), where(txnField, "==", txnValue));
      const txnSnap = await getDocs(qTxn);

      const txns = [];
      txnSnap.forEach(d => txns.push(d.data()));
      const filteredTxns = activeContext === 'LANDLORD' ? txns.filter(t => !t.agencyId) : txns;

      if (filteredTxns.length === 0) {
        ledgerBody.innerHTML = `<tr><td colspan="4" class="p-4 text-center text-slate-500">No se registran movimientos de créditos en este perfil.</td></tr>`;
      } else {
        filteredTxns.sort((a, b) => (b.timestamp?.toMillis?.() || 0) - (a.timestamp?.toMillis?.() || 0));

        ledgerBody.innerHTML = filteredTxns.slice(0, 15).map(t => {
          const d = t.timestamp?.toDate ? t.timestamp.toDate().toLocaleDateString('es-AR') : '-';
          const isPositive = t.amount > 0;
          return `
            <tr class="hover:bg-slate-900/50">
              <td class="p-3 text-slate-400">${d}</td>
              <td class="p-3 text-white font-semibold">${t.description || t.type}</td>
              <td class="p-3 text-center font-black ${isPositive ? 'text-emerald-400' : 'text-amber-400'}">${isPositive ? '+' + t.amount : t.amount}</td>
              <td class="p-3 text-right font-bold text-slate-200">${t.balanceAfter ?? '-'}</td>
            </tr>
          `;
        }).join('');
      }
    }

    if (window.lucide) window.lucide.createIcons();
  } catch (err) {
    console.error("Error cargando estado de cuenta:", err);
  }
}

window.contratarPack = async (packId, mode = 'ONE_TIME') => {
  if (packId === 'PARTICULAR_FREE') {
    if (!currentUser) {
      showToast("Registro Gratuito", "Completá tu alta con DNI para comenzar con tus 2 consultas sin cargo.", "info");
      switchTab('onboarding');
    } else {
      showToast("Beneficio Activo", "Tus 2 consultas gratuitas ya están disponibles en tu cuenta.", "success");
      switchTab('search');
    }
    return;
  }

  if (!currentUser) {
    showToast("Identificación Requerida", "Iniciá sesión o registrate con tu DNI para contratar este pack.", "info");
    switchTab('auth');
    return;
  }

try {
    showToast("Procesando...", "Validando orden y promociones...", "success");
    const functions = getFunctions(auth.app, "us-central1");
    const iniciarContratacion = httpsCallable(functions, "iniciarContratacionPack");

    // 1. Agregamos el discountCode a la petición
    const result = await iniciarContratacion({ 
      packId, 
      mode,
      discountCode: typeof appliedPromoCode !== 'undefined' ? appliedPromoCode : null 
    });
    
    const data = result.data;

    // 2. Manejamos el caso 100% gratis (Código Maestro o promo total)
    if (data && data.mode === "FREE_BYPASS") {
      showToast("¡Promoción Aplicada!", data.message || "Pack acreditado con éxito.", "success");
      setTimeout(() => {
        window.location.reload(); // Recarga para actualizar los créditos en pantalla
      }, 1500);
    } 
    // 3. Manejamos el flujo normal (Pago parcial o sin promo)
    else if (data && data.initPoint) {
      window.location.href = data.initPoint;
    } 
    else {
      throw new Error("No se recibió el enlace de pago desde el servidor.");
    }
    
  } catch (err) {
    console.error("Error al iniciar pago:", err);
    showToast("Error", err.message || "No se pudo procesar la contratación.", "error");
  }
};

// ============================================================================
// GESTIÓN Y AUDITORÍA DE CONTRATOS (PERSPECTIVAS PROPIETARIO / INQUILINO)
// ============================================================================
let activeContractsSubTab = 'OWNER';

window.setContractsSubTab = (subTab) => {
  activeContractsSubTab = subTab;
  const btnOwner = document.getElementById('tab-btn-contracts-owner');
  const btnTenant = document.getElementById('tab-btn-contracts-tenant');

  if (subTab === 'OWNER') {
    if (btnOwner) btnOwner.className = "px-4 py-2 rounded-xl text-xs font-bold transition-all bg-[#16c2a3]/10 text-[#16c2a3] border border-[#16c2a3]/30 cursor-pointer";
    if (btnTenant) btnTenant.className = "px-4 py-2 rounded-xl text-xs font-bold transition-all bg-slate-900 text-slate-400 border border-slate-800 hover:text-white cursor-pointer";
  } else {
    if (btnOwner) btnOwner.className = "px-4 py-2 rounded-xl text-xs font-bold transition-all bg-slate-900 text-slate-400 border border-slate-800 hover:text-white cursor-pointer";
    if (btnTenant) btnTenant.className = "px-4 py-2 rounded-xl text-xs font-bold transition-all bg-[#16c2a3]/10 text-[#16c2a3] border border-[#16c2a3]/30 cursor-pointer";
  }

  if (currentUser) loadContractsView(currentUser);
};

window.loadContractsView = async function(user) {
  const tableBody = document.getElementById('contracts-table-body');
  const countEl = document.getElementById('contracts-total-count');
  const monthsEl = document.getElementById('contracts-total-months');
  const debtEl = document.getElementById('contracts-total-debt');
  const contextBadge = document.getElementById('contracts-context-badge');
  const tabsContainer = document.getElementById('contracts-tabs-container');
  const btnNewContract = document.querySelector('#view-contracts button[onclick*="switchTab(\'certify\')"]');
  const btnInviteTenant = document.getElementById('btn-nueva-invitacion-inquilino');

  if (!tableBody) return;
  tableBody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 animate-pulse">Consultando legajo en Firestore...</td></tr>`;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const userDniClean = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';
    const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    if (tabsContainer) {
      tabsContainer.classList.toggle('hidden', isAgency);
    }

    if (btnNewContract) {
      btnNewContract.classList.toggle('hidden', activeContractsSubTab === 'TENANT');
    }

    if (btnInviteTenant) {
      btnInviteTenant.classList.toggle('hidden', !isAgency && activeContractsSubTab === 'TENANT');
    }

    if (contextBadge) {
      contextBadge.innerText = isAgency 
      ? formatRoleLabel(activeContext) 
      : (activeContractsSubTab === 'OWNER' ? 'Modo: Propietario' : 'Modo: Inquilino');
    }

    const rentalsRef = collection(db, "verified_rentals");
    const queries = [];

    if (activeContractsSubTab === 'TENANT' && !isAgency) {
      if (userDniClean) {
        queries.push(getDocs(query(rentalsRef, where("tenantDni", "==", userDniClean))));
        queries.push(getDocs(query(rentalsRef, where("dni", "==", userDniClean))));
      }
    } else if (isAgency && targetAgencyId) {
      queries.push(getDocs(query(rentalsRef, where("metadata.agencyId", "==", targetAgencyId))));
    } else {
      if (userDniClean) {
        queries.push(getDocs(query(rentalsRef, where("propietarioDni", "==", userDniClean))));
      }
    }
    
    const querySnaps = await Promise.all(queries);
    const contractsMap = new Map();
    querySnaps.forEach(snap => {
      snap.forEach(d => contractsMap.set(d.id, { id: d.id, ...d.data() }));
    });

    cachedContractsMap = contractsMap;
    let contracts = Array.from(contractsMap.values());

    if (isAgency && targetAgencyId) {
      contracts = contracts.filter(c => c.metadata?.agencyId === targetAgencyId);
    } else if (!isAgency && activeContractsSubTab === 'OWNER') {
      contracts = contracts.filter(c => {
        const ownerDniClean = String(c.propietarioDni || '').replace(/\D/g, '');
        return Boolean(userDniClean && ownerDniClean === userDniClean);
      });
    }

    contracts.sort((a, b) => {
      const timeA = a.metadata?.createdAt?.toMillis?.() || a.metadata?.createdAt?.seconds * 1000 || 0;
      const timeB = b.metadata?.createdAt?.toMillis?.() || b.metadata?.createdAt?.seconds * 1000 || 0;
      return timeB - timeA;
    });

    let totalMonths = 0;
    let totalDebt = 0;

    contracts.forEach(c => {
      totalMonths += (c.behavior?.onTime || 0) + (c.behavior?.late || 0) || c.totalMonths || 0;
      totalDebt += (c.behavior?.debtAmount || 0);
    });

    if (countEl) countEl.innerText = contracts.length;
    if (monthsEl) monthsEl.innerText = `${totalMonths} meses`;
    if (debtEl) debtEl.innerText = `$${totalDebt.toLocaleString('es-AR')}`;

    const labelCount = countEl?.parentElement?.querySelector('span:first-child');
    const labelDebt = debtEl?.parentElement?.querySelector('span:first-child');
    if (labelCount) labelCount.innerText = activeContractsSubTab === 'TENANT' ? 'Contratos como Locatario' : 'Contratos Homologados';
    if (labelDebt) labelDebt.innerText = activeContractsSubTab === 'TENANT' ? 'Deuda Activa Pendiente' : 'Deuda Total Registrada';

    if (contracts.length === 0) {
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" class="p-8 text-center text-slate-500">
            ${activeContractsSubTab === 'TENANT' 
            ? 'No registrás contratos calificados a tu nombre en el Buró.' 
            : 'No poseés locaciones certificadas aún.<br><span class="text-[11px] text-slate-600">Usá el botón superior para homologar tu primer contrato.</span>'}
          </td>
        </tr>
          `;
          return;
        }

        tableBody.innerHTML = contracts.map(c => {
          const onTime = c.behavior?.onTime || 0;
          const late = c.behavior?.late || 0;
          const rawScore = c.scoreRentia ?? 0;
          const score = rawScore > 100 ? Math.round(rawScore / 10) : rawScore;
          const compliance = c.paymentCompliance ?? 100;
          const scoreColor = score >= 70 ? 'text-[#16c2a3]' : (score >= 45 ? 'text-amber-400' : 'text-rose-400');
          const annexUrl = c.legalEvidence?.annexStoragePath || c.legalEvidence?.annexPhotoUrl || c.anexoUrl || '';
          const restitutionUrl = c.legalEvidence?.restitutionActStoragePath || '';
          const address = c.propertyAddress || c.address || '';
          const hasRebuttal = !!c.rebuttal?.statement;

      // Respaldo de datos del Propietario e Inquilino
          const propDni = c.propietarioDni || c.landlordDni || 'S/D';
          const propNombre = escapeHtml(c.propietarioNombre || c.landlordName || 'Propietario');
          const inquilinoNombre = escapeHtml(c.tenantName || c.name || 'Sin Nombre');
          const inquilinoDni = c.tenantDni || c.dni || 'S/D';

      // Fechas normalizadas (evita 'undefined a undefined')
          const fechaDesde = c.startDate || c.start || c.fechaInicio || '-';
          const fechaHasta = c.endDate || c.end || c.fechaFin || '-';

      // Comprobación de evidencia digital (Ley 25.326)
          const hasDigitalConsent = !!(c.legalEvidence?.consentTimestamp || c.legalEvidence?.acceptedViaInvitation || (!annexUrl && c.legalEvidence));

          const hasPendingDispute = c.dispute && c.dispute.status === 'PENDING';
          const hasDebt = (c.behavior?.debtAmount || 0) > 0;

          return `
        <tr class="hover:bg-slate-900/40 transition-colors">
          <td class="p-3">
            <div class="space-y-1">
              <div>
                <span class="text-[9px] uppercase tracking-wider text-slate-500 font-bold block">Inquilino</span>
                <p class="font-bold text-white text-xs">${inquilinoNombre}</p>
                <p class="text-[10px] text-slate-400">DNI: <span class="font-mono text-slate-300">${inquilinoDni}</span></p>
              </div>

              <div class="pt-1 border-t border-slate-800/60">
                <span class="text-[9px] uppercase tracking-wider text-[#16c2a3] font-bold block">Propietario</span>
                <p class="text-[11px] font-semibold text-slate-200">${propNombre}</p>
                <p class="text-[10px] text-slate-400">DNI: <span class="font-mono text-slate-300">${propDni}</span></p>
              </div>

            ${address ? `<p class="text-[9px] text-sky-400 font-semibold truncate max-w-[200px]" title="${address}">📍 ${address}</p>` : ''}

              <div>
            ${c.metadata?.agencyId ? `
                  <span class="inline-block text-[8.5px] font-bold uppercase tracking-wider text-sky-400 bg-sky-500/10 px-1.5 py-0.5 rounded border border-sky-500/20">
                    🏛️ ${escapeHtml(c.metadata?.agencyName || 'Inmobiliaria Asignada')}
                  </span>
              ` : `
                  <span class="inline-block text-[8.5px] font-bold uppercase tracking-wider text-emerald-400 bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                    👤 Autogestión Particular
                  </span>
              `}
              </div>
            </div>
          </td>
          <td class="p-3 text-slate-300">
            <span class="block">${fechaDesde} a ${fechaHasta}</span>
            <span class="text-[10px] text-slate-500">${onTime + late} meses evaluados</span>
          </td>
          <td class="p-3 font-semibold text-white">
            $${Number(c.monthlyAmount || c.monthlyRent || 0).toLocaleString('es-AR')}
          </td>
          <td class="p-3 text-center">
              ${hasPendingDispute ? `
              <span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-amber-500/15 text-amber-400 border border-amber-500/40 animate-pulse block" title="En proceso de mediación bajo Ley 25.326. Score congelado cautelarmente.">
                ⚖️ En Mediación
              </span>
              <span class="text-[8px] text-slate-500 block mt-0.5">Plazo 5 días</span>
                ` : c.status === 'EN_CURSO' ? `
              <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/10 text-amber-400 border border-amber-500/30">En Curso</span>
                ` : `
              <span class="font-black text-sm ${scoreColor}">${score}</span>
              <span class="text-[9px] block text-slate-500">/ 100</span>
                `}
          </td>
          <td class="p-3 text-center">
                ${c.status === 'EN_CURSO' ? `
              <span class="text-slate-500 text-[10px] italic">Pendiente egreso</span>
                  ` : `
              <span class="font-bold ${compliance >= 90 ? 'text-emerald-400' : 'text-amber-400'}">${compliance}%</span>
              <span class="text-[9px] block text-slate-500">${onTime} OK / ${late} Mora</span>
                  `}
          </td>

          <td class="p-3 text-center">
            <div class="flex flex-wrap items-center justify-center gap-1.5">
                  ${c.contractPdfUrl ? `
                  <a href="${c.contractPdfUrl}" target="_blank" rel="noopener noreferrer" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-sky-400 border border-sky-500/30 rounded-lg text-[10px] font-bold uppercase transition flex items-center gap-1" title="Ver Contrato de Locación">
                  <i data-lucide="file-text" class="w-3 h-3"></i> Contrato
                  </a>
                    ` : ''} 
                    ${annexUrl ? `
                <button type="button" onclick="verModalAnexo('${annexUrl}', 'Anexo de Consentimiento (Ley 25.326)')" class="px-2 py-1 bg-indigo-500/10 hover:bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer" title="Ver Anexo Firmado">
                  Anexo
                </button>
                      ` : hasDigitalConsent ? `
                <span class="inline-flex items-center gap-1 px-2 py-1 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded-lg text-[9.5px] font-bold tracking-tight" title="Consentimiento digital expreso bajo Ley 25.326 verificado por token">
                  <i data-lucide="shield-check" class="w-3 h-3 text-emerald-400"></i> Anexo Digital
                </span>
                      ` : `<span class="text-slate-600 text-[10px] italic">Sin Anexo</span>`}

                      ${activeContractsSubTab !== 'TENANT' && c.status === 'EN_CURSO' ? `
                <button type="button" onclick="abrirModalTransferir('${c.id}')" class="px-2 py-1 bg-sky-500/10 hover:bg-sky-500/20 text-sky-400 border border-sky-500/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer flex items-center gap-1" title="Ceder administración a otra inmobiliaria o desvincular">
                  <i data-lucide="arrow-right-left" class="w-3 h-3 text-sky-400"></i> Traspasar
                </button>
                        ` : ''}

                        ${restitutionUrl ? `
                <button type="button" onclick="verModalAnexo('${restitutionUrl}', 'Acta Bilateral de Restitución y Desocupación')" class="px-2 py-1 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer flex items-center gap-1" title="Acta con firmas bilaterales">
                  <i data-lucide="file-check-2" class="w-3 h-3"></i> Acta
                </button>
                          ` : ''}

                          ${c.status === 'FINALIZADO' ? `
                <button type="button" onclick="descargarCertificadoPdf('${c.id}')" class="px-2 py-1 bg-slate-800 hover:bg-slate-700 text-[#16c2a3] border border-[#16c2a3]/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer flex items-center gap-1" title="Descargar Certificado Oficial en PDF">
                  <i data-lucide="download" class="w-3 h-3"></i> PDF
                </button>
                            ` : ''}

                            ${activeContractsSubTab === 'TENANT' && c.status === 'FINALIZADO' ? `
                <button type="button" onclick="abrirModalReplica('${c.id}')" class="px-2 py-1 ${hasRebuttal ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : 'bg-slate-800 hover:bg-slate-700 text-slate-300 border-slate-700'} border rounded-lg text-[10px] font-bold uppercase transition cursor-pointer">
                  ${hasRebuttal ? 'Ver Réplica' : 'Descargo'}
                </button>

                              ${hasPendingDispute ? `
                  <span class="px-2 py-1 bg-amber-500/10 text-amber-400 border border-amber-500/30 rounded-lg text-[9px] font-bold uppercase">
                    ⚖️ En Revisión (5d)
                  </span>
                                ` : hasDebt ? `
                  <button type="button" onclick="abrirModalRectificacion('${c.id}')" class="px-2 py-1 bg-amber-500/15 hover:bg-amber-500/25 text-amber-400 border border-amber-500/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer flex items-center gap-1" title="Ejercer Derecho de Rectificación y adjuntar comprobante (Arts. 14 y 16 Ley 25.326)">
                    <i data-lucide="scale" class="w-3 h-3"></i> Rectificar
                  </button>
                                ` : ''}
                                ` : ''}

                                ${activeContractsSubTab !== 'TENANT' && c.status === 'FINALIZADO' && hasPendingDispute ? `
                <button type="button" onclick="abrirModalResolverDisputa('${c.id}')" class="px-2 py-1 bg-amber-500 hover:bg-amber-400 text-slate-950 font-black rounded-lg text-[10px] uppercase transition cursor-pointer flex items-center gap-1 shadow-md shadow-amber-500/20 animate-pulse" title="El inquilino adjuntó comprobante de pago. Plazo 5 días hábiles.">
                  <i data-lucide="scale" class="w-3 h-3"></i> Resolver Disputa
                </button>
                                  ` : ''}

                                  ${activeContractsSubTab !== 'TENANT' && c.status === 'FINALIZADO' && !hasPendingDispute && hasDebt ? `
                <button type="button" onclick="promptSaldarDeuda('${c.id}',${c.behavior.debtAmount})" class="px-2 py-1 bg-amber-500/10 hover:bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded-lg text-[10px] font-bold uppercase transition cursor-pointer flex items-center gap-1" title="Registrar cancelación de deuda (Ley 25.326)">
                  <i data-lucide="badge-check" class="w-3 h-3 text-amber-400"></i> Saldar
                </button>
                                    ` : ''}

                                    ${c.behavior?.settlementStatus === 'SALDADA' ? `
                <span class="px-2 py-0.5 rounded text-[9px] font-bold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/20" title="Deuda saldada. Caduca en 2 años desde la cancelación.">
                  ✓ Saldada
                </span>
                                      ` : ''}
            </div>
          </td>
        </tr>
                                    `;
                                  }).join('');

if (window.lucide) window.lucide.createIcons();

} catch (err) {
  console.error("Error al cargar contratos:", err);
  tableBody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-rose-400 text-xs">Error al cargar listado: ${err.message}</td></tr>`;
}
}

window.descargarCertificadoPdf = async (contractId) => {
  const contract = cachedContractsMap.get(contractId);
  if (!contract) {
    showToast("Error", "No se encontró el legajo del contrato seleccionado.", "error");
    return;
  }
  try {
    showToast("Generando Documento", "Construyendo certificado PDF oficial...", "success");
    await downloadContractCertificatePdf(contract, "Inmobiliaria Matriculada CUCIS");
    showToast("¡Descarga Exitosa!", "El certificado PDF ha sido generado correctamente.", "success");
  } catch (err) {
    console.error("Error al exportar PDF:", err);
    showToast("Error", "No se pudo generar el archivo PDF.", "error");
  }
};

window.descargarInformeBuroPdf = async () => {
  if (!currentReportData) {
    showToast("Error", "No hay datos de informe disponibles para exportar.", "error");
    return;
  }
  try {
    showToast("Generando Documento", "Construyendo informe consolidado de Buró...", "success");
    await downloadBuroReportPdf(currentReportData, formatRoleLabel(activeContext));
    showToast("¡Descarga Exitosa!", "Informe de Buró descargado correctamente.", "success");
  } catch (err) {
    console.error("Error al exportar informe:", err);
    showToast("Error", "No se pudo generar el archivo PDF del informe.", "error");
  }
};

window.verModalAnexo = (url, title = "Auditoría de Respaldo Documental") => {
  const modal = document.getElementById('modal-anexo');
  const img = document.getElementById('modal-anexo-img');
  const pdfFrame = document.getElementById('modal-anexo-pdf');
  const downloadLink = document.getElementById('modal-anexo-download');
  const titleEl = document.getElementById('modal-anexo-title');

  if (!modal) return;

  if (titleEl) {
    titleEl.innerHTML = `<i data-lucide="file-check" class="w-4 h-4 text-[#16c2a3]"></i> ${title}`;
  }

  const isPdf = url.toLowerCase().includes('.pdf') || url.includes('application/pdf');

  if (isPdf) {
    if (img) img.classList.add('hidden');
    if (pdfFrame) {
      pdfFrame.src = url;
      pdfFrame.classList.remove('hidden');
    }
  } else {
    if (pdfFrame) {
      pdfFrame.src = '';
      pdfFrame.classList.add('hidden');
    }
    if (img) {
      img.src = url;
      img.classList.remove('hidden');
    }
  }

  if (downloadLink) downloadLink.href = url;
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
};

window.cerrarModalAnexo = () => {
  const modal = document.getElementById('modal-anexo');
  const img = document.getElementById('modal-anexo-img');
  const pdfFrame = document.getElementById('modal-anexo-pdf');
  if (!modal) return;
  modal.classList.add('hidden');
  if (img) img.src = '';
  if (pdfFrame) pdfFrame.src = '';
};

// ============================================================================
// REPORTES DE CARTERA Y ANÁLISIS DE RIESGO
// ============================================================================
async function loadReportsView(user) {
  const totalCanonEl = document.getElementById('rep-total-canon');
  const avgScoreEl = document.getElementById('rep-avg-score');
  const complianceEl = document.getElementById('rep-compliance-rate');
  const totalDebtEl = document.getElementById('rep-total-debt');
  const totalTenantsEl = document.getElementById('rep-total-tenants');

  const countHighEl = document.getElementById('rep-count-high');
  const countMedEl = document.getElementById('rep-count-med');
  const countLowEl = document.getElementById('rep-count-low');

  const barHigh = document.getElementById('rep-bar-high');
  const barMed = document.getElementById('rep-bar-med');
  const barLow = document.getElementById('rep-bar-low');

  const alertsContainer = document.getElementById('rep-alerts-container');
  
  // ✅ ESCUDO DE PROTECCIÓN: Si no estamos en la vista de reportes, salimos sin romper nada
  if (!totalCanonEl) return;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const userDniClean = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';
    const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    const rentalsRef = collection(db, "verified_rentals");
    const queries = [];

    if (isAgency && targetAgencyId) {
      queries.push(getDocs(query(rentalsRef, where("metadata.agencyId", "==", targetAgencyId))));
    } else {
      if (userDniClean) {
        queries.push(getDocs(query(rentalsRef, where("propietarioDni", "==", userDniClean))));
      }
    }

    const querySnaps = await Promise.all(queries);
    const contractsMap = new Map();
    querySnaps.forEach(snap => {
      snap.forEach(d => contractsMap.set(d.id, { id: d.id, ...d.data() }));
    });

    let contracts = Array.from(contractsMap.values());

    if (isAgency && targetAgencyId) {
      contracts = contracts.filter(c => c.metadata?.agencyId === targetAgencyId);
    } else {
      contracts = contracts.filter(c => {
        const ownerDniClean = String(c.propietarioDni || '').replace(/\D/g, '');
        return Boolean(userDniClean && ownerDniClean === userDniClean);
      });
    }

    if (contracts.length === 0) {
      if (totalCanonEl) totalCanonEl.innerText = "$0";
      if (avgScoreEl) avgScoreEl.innerText = "0 pts";
      if (complianceEl) complianceEl.innerText = "100%";
      if (totalDebtEl) totalDebtEl.innerText = "$0";
      if (totalTenantsEl) totalTenantsEl.innerText = "0 contrato(s) evaluados";
      if (alertsContainer) {
        alertsContainer.innerHTML = `
          <div class="p-6 bg-slate-950/40 border border-slate-900 rounded-xl text-center text-slate-500 text-xs">
            No hay contratos en cartera para calcular métricas de riesgo.
          </div>
        `;
      }
      return;
    }

    let sumCanon = 0;
    let sumScore = 0;
    let sumOnTime = 0;
    let sumMonths = 0;
    let sumDebt = 0;

    let countHigh = 0;
    let countMed = 0;
    let countLow = 0;

    const debtAlerts = [];

    contracts.forEach(c => {
      const canon = Number(c.monthlyAmount) || 0;
      const rawScore = c.scoreRentia ?? 0;
      const score = rawScore > 100 ? Math.round(rawScore / 10) : rawScore;
      const onTime = c.behavior?.onTime || 0;
      const late = c.behavior?.late || 0;
      const months = onTime + late || c.totalMonths || 1;
      const debt = Number(c.behavior?.debtAmount) || 0;

      sumCanon += canon;
      sumScore += score;
      sumOnTime += onTime;
      sumMonths += months;
      sumDebt += debt;

      if (score >= 70) countHigh++;
      else if (score >= 45) countMed++;
      else countLow++;

      if (debt > 0 || late > 0 || c.behavior?.conservation === 'Daños Documentados') {
        debtAlerts.push(c);
      }
    });

    const total = contracts.length;
    const avgScore = Math.round(sumScore / total);
    const complianceRate = sumMonths > 0 ? Math.round((sumOnTime / sumMonths) * 100) : 100;

    const pctHigh = Math.round((countHigh / total) * 100);
    const pctMed = Math.round((countMed / total) * 100);
    const pctLow = Math.round((countLow / total) * 100);

    // ✅ Actualizaciones seguras con verificación condicional opcional
    if (totalCanonEl) totalCanonEl.innerText = `$${sumCanon.toLocaleString('es-AR')}`;
    if (avgScoreEl) avgScoreEl.innerText = `${avgScore} / 100`;
    if (complianceEl) complianceEl.innerText = `${complianceRate}%`;
    if (totalDebtEl) totalDebtEl.innerText = `$${sumDebt.toLocaleString('es-AR')}`;
    if (totalTenantsEl) totalTenantsEl.innerText = `${total} contrato(s) evaluados`;

    if (countHighEl) countHighEl.innerText = `${countHigh} (${pctHigh}%)`;
    if (countMedEl) countMedEl.innerText = `${countMed} (${pctMed}%)`;
    if (countLowEl) countLowEl.innerText = `${countLow} (${pctLow}%)`;

    if (barHigh) barHigh.style.width = `${pctHigh}%`;
    if (barMed) barMed.style.width = `${pctMed}%`;
    if (barLow) barLow.style.width = `${pctLow}%`;

    if (alertsContainer) {
      if (debtAlerts.length === 0) {
        alertsContainer.innerHTML = `
          <div class="p-4 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-center text-emerald-400 text-xs font-bold">
            ✓ Cartera 100% al día: no se registran deudas activas ni moras técnicas en este perfil.
          </div>
        `;
      } else {
        alertsContainer.innerHTML = debtAlerts.map(c => `
          <div class="bg-slate-950/70 border border-slate-800 p-3.5 rounded-xl flex flex-col sm:flex-row justify-between items-start sm:items-center gap-2">
            <div>
              <div class="flex items-center gap-2">
                <span class="font-bold text-white text-xs">${escapeHtml(c.name || 'Sin Nombre')}</span>
                <span class="text-[10px] text-slate-400 font-mono">DNI: ${c.dni || c.tenantDni}</span>
              </div>
              <p class="text-[11px] text-slate-400 mt-0.5">
                ${c.behavior?.late || 0} meses con mora técnica · Estado: <span class="text-slate-300 font-semibold">${escapeHtml(c.behavior?.conservation || 'Normal')}</span>
              </p>
            </div>
            <div class="text-left sm:text-right">
              <span class="text-xs font-black ${c.behavior?.debtAmount > 0 ? 'text-rose-400' : 'text-amber-400'} block">
                $${Number(c.behavior?.debtAmount || 0).toLocaleString('es-AR')} pendiente
              </span>
              <span class="text-[9px] uppercase tracking-wider text-slate-500 font-bold">Acción de Cobranza</span>
            </div>
          </div>
        `).join('');
      }
    }

    if (window.lucide) window.lucide.createIcons();

  } catch (err) {
    console.error("Error al cargar reportes:", err);
  }
}

// ============================================================================
// PANEL DE CONTROL DE VENCIMIENTOS CON CRUCE DE PROPIEDAD
// ============================================================================
async function loadExpirationsView(user) {
  const tableBody = document.getElementById('expirations-table-body');
  const count30El = document.getElementById('exp-count-30');
  const count60El = document.getElementById('exp-count-60');
  const count90El = document.getElementById('exp-count-90');

  if (!tableBody) return;
  tableBody.innerHTML = `<tr><td colspan="6" class="p-6 text-center text-slate-400 animate-pulse">Calculando plazos de vencimiento...</td></tr>`;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const userDniClean = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';
    const isAgency = activeContext === 'AGENCY_OWNER' || activeContext === 'AGENCY_EMPLOYEE';
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    const rentalsRef = collection(db, "verified_rentals");
    const queries = [];

    if (isAgency && targetAgencyId) {
      queries.push(getDocs(query(rentalsRef, where("metadata.agencyId", "==", targetAgencyId))));
    } else {
      if (userDniClean) {
        queries.push(getDocs(query(rentalsRef, where("propietarioDni", "==", userDniClean))));
      }
    }

    const querySnaps = await Promise.all(queries);
    const contractsMap = new Map();
    querySnaps.forEach(snap => {
      snap.forEach(d => contractsMap.set(d.id, { id: d.id, ...d.data() }));
    });

    cachedContractsMap = contractsMap;
    let contracts = Array.from(contractsMap.values());

    if (isAgency && targetAgencyId) {
      contracts = contracts.filter(c => c.metadata?.agencyId === targetAgencyId);
    } else {
      contracts = contracts.filter(c => {
        const ownerDniClean = String(c.propietarioDni || '').replace(/\D/g, '');
        return Boolean(userDniClean && ownerDniClean === userDniClean);
      });
    }

    if (contracts.length === 0) {
      if (count30El) count30El.innerText = "0";
      if (count60El) count60El.innerText = "0";
      if (count90El) count90El.innerText = "0";
      tableBody.innerHTML = `
        <tr>
          <td colspan="6" class="p-8 text-center text-slate-500">
            No posees locaciones activas registradas para auditar vencimientos.
          </td>
        </tr>
      `;
      return;
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let c30 = 0;
    let c60 = 0;
    let c90 = 0;

    const processed = contracts.map(c => {
      let endDate;
      if (c.end) {
        const parts = c.end.split('-');
        if (parts.length === 2) {
          endDate = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10), 0);
        } else {
          endDate = new Date(c.end);
        }
      } else {
        endDate = new Date();
      }

      const diffTime = endDate - today;
      const daysRemaining = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

      if (daysRemaining >= 0 && daysRemaining <= 30) c30++;
      else if (daysRemaining > 30 && daysRemaining <= 60) c60++;
      else if (daysRemaining > 60 && daysRemaining <= 90) c90++;

      return { ...c, endDate, daysRemaining };
    });

    if (count30El) count30El.innerText = c30;
    if (count60El) count60El.innerText = c60;
    if (count90El) count90El.innerText = c90;

    processed.sort((a, b) => a.daysRemaining - b.daysRemaining);

    tableBody.innerHTML = processed.map(c => {
      let badgeHtml;
      if (c.daysRemaining < 0) {
        badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-slate-800 text-slate-400 border border-slate-700">Finalizado (${Math.abs(c.daysRemaining)}d atrás)</span>`;
      } else if (c.daysRemaining <= 30) {
        badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-rose-500/10 text-rose-400 border border-rose-500/30">Vence en ${c.daysRemaining} días</span>`;
      } else if (c.daysRemaining <= 60) {
        badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-500/10 text-amber-400 border border-amber-500/30">Vence en ${c.daysRemaining} días</span>`;
      } else {
        badgeHtml = `<span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">Vigente (${c.daysRemaining} días)</span>`;
      }

      const formattedEnd = c.endDate.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
      const address = c.propertyAddress || '';
      const propDni = c.propietarioDni || 'S/D';
      const propNombre = c.propietarioNombre ? escapeHtml(c.propietarioNombre) : 'Propietario';

      return `
        <tr class="hover:bg-slate-900/40 transition-colors">
          <td class="p-3">
            <div class="space-y-1">
              <div>
                <span class="text-[9px] uppercase tracking-wider text-slate-500 font-bold block">Inquilino</span>
                <p class="font-bold text-white text-xs">${escapeHtml(c.name || 'Sin Nombre')}</p>
                <p class="text-[10px] text-slate-400">DNI: <span class="font-mono text-slate-300">${c.dni || c.tenantDni}</span></p>
              </div>

              <div class="pt-1 border-t border-slate-800/60">
                <span class="text-[9px] uppercase tracking-wider text-[#16c2a3] font-bold block">Propietario</span>
                <p class="text-[11px] font-semibold text-slate-200">${propNombre}</p>
                <p class="text-[10px] text-slate-400">DNI: <span class="font-mono text-slate-300">${propDni}</span></p>
              </div>

        ${address ? `<p class="text-[9px] text-sky-400 font-semibold truncate max-w-[200px]" title="${address}">📍 ${address}</p>` : ''}
            </div>
          </td>
          <td class="p-3 text-slate-300 font-mono">
            ${formattedEnd}
          </td>
          <td class="p-3 text-center font-black ${c.daysRemaining <= 30 ? 'text-rose-400' : (c.daysRemaining <= 60 ? 'text-amber-400' : 'text-slate-300')}">
        ${c.daysRemaining < 0 ? 'Concluido' : `${c.daysRemaining} días`}
          </td>
          <td class="p-3 font-semibold text-white">
            $${Number(c.monthlyAmount || 0).toLocaleString('es-AR')}
          </td>
          <td class="p-3 text-center">
            ${badgeHtml}
          </td>
          <td class="p-3 text-right">
        ${c.status === 'FINALIZADO' ? `
              <span class="px-2.5 py-1 bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 rounded-lg text-[10px] font-bold uppercase inline-block">
                ✓ Certificado Emitido
              </span>
          ` : `
              <button type="button" onclick="abrirModalFinalizar('${c.id}')" class="px-3 py-1.5 bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] rounded-lg text-[10px] font-black uppercase tracking-wider transition-all shadow-md cursor-pointer">
                Emitir Certificado
              </button>
          `}
          </td>
        </tr>
        `;
      }).join('');

    if (window.lucide) window.lucide.createIcons();

  } catch (err) {
    console.error("Error al cargar vencimientos:", err);
    tableBody.innerHTML = `<tr><td colspan="6" class="p-4 text-center text-rose-400 text-xs">Error al cargar vencimientos: ${err.message}</td></tr>`;
  }
}

window.abrirModalFinalizar = (contractId) => {
  const modal = document.getElementById('modal-finalizar-contrato');
  const idInput = document.getElementById('modal-fin-contract-id');
  const infoEl = document.getElementById('modal-fin-tenant-info');
  if (!modal) return;

  const contract = cachedContractsMap.get(contractId);
  const tenantName = contract ? (contract.name || 'Inquilino') : 'Inquilino';
  const tenantDni = contract ? (contract.dni || contract.tenantDni || 'S/D') : 'S/D';
  const addr = contract?.propertyAddress ? ` · 📍 ${contract.propertyAddress}` : '';

  if (idInput) idInput.value = contractId;
  if (infoEl) infoEl.innerText = `${tenantName} (DNI: ${tenantDni})${addr}`;
  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
};

window.cerrarModalFinalizar = () => {
  const modal = document.getElementById('modal-finalizar-contrato');
  if (modal) modal.classList.add('hidden');
};

const modalFinForm = document.getElementById('form-modal-finalizar');
if (modalFinForm) {
  modalFinForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const contractId = document.getElementById('modal-fin-contract-id').value;
    const onTime = parseInt(document.getElementById('modal-fin-ontime').value, 10) || 0;
    const late = parseInt(document.getElementById('modal-fin-late').value, 10) || 0;
    const conservation = document.getElementById('modal-fin-conservation').value;
    const debtAmount = parseFloat(document.getElementById('modal-fin-debt').value) || 0;

    const restitutionFileInput = document.getElementById('modal-fin-restitution-file');
    const restitutionFile = restitutionFileInput?.files?.[0] || null;

    try {
      showToast("Procesando", "Asentando egreso y respaldos documentales...", "success");

      let restitutionActUrl = null;
      if (restitutionFile) {
        showToast("Procesando", "Subiendo acta de restitución...", "success");
        restitutionActUrl = await uploadRestitutionActFile(currentUser.uid, restitutionFile);
      }

      try {
        const functions = getFunctions(auth.app, "us-central1");
        const finalizarFn = httpsCallable(functions, "finalizarYCalificarLocacion");
        const res = await finalizarFn({ 
          contractId, 
          onTime, 
          late, 
          conservation, 
          debtAmount,
          restitutionActStoragePath: restitutionActUrl 
        });
        showToast("¡Certificado Emitido!", `Score asignado: ${res.data.calculatedScore} pts.`, "success");
      } catch (fnErr) {
        const totalMonths = onTime + late || 1;
        const complianceRate = Math.round((onTime / totalMonths) * 100);
        let score = Math.round((complianceRate / 100) * 80);
        if (conservation === 'Excelente') score += 100;
        else if (conservation === 'Bueno') score += 50;
        else if (conservation === 'Daños Documentados') score -= 15;
        if (debtAmount > 0) score -= 20;
        const finalScore = Math.max(0, Math.min(100, score));

        const userDoc = await getDoc(doc(db, "users", currentUser.uid));
        const userData = userDoc.exists() ? userDoc.data() : {};
        const userDni = userData.dni ? String(userData.dni).replace(/\D/g, '') : '';

        const updateData = {
          status: "FINALIZADO",
          scoreRentia: finalScore,
          paymentCompliance: complianceRate,
          totalMonths,
          behavior: {
            onTime,
            late,
            conservation,
            debtAmount,
            closedAt: serverTimestamp()
          },
          "legalEvidence.retentionLimitYears": debtAmount > 0 ? 5 : 2,
          "legalEvidence.closedLawCompliance": "Ley 25.326 Art. 26",
          "metadata.finalizedAt": serverTimestamp(),
          "metadata.finalizedByUid": currentUser.uid,
          "metadata.finalizedByDni": userDni
        };

        if (restitutionActUrl) {
          updateData["legalEvidence.restitutionActStoragePath"] = restitutionActUrl;
          updateData["legalEvidence.hasBilateralRestitution"] = true;
        }

        await updateDoc(doc(db, "verified_rentals", contractId), updateData);

        showToast("¡Certificado Emitido!", `Score asignado: ${finalScore} pts.`, "success");
      }

      cerrarModalFinalizar();
      await loadExpirationsView(currentUser);
      await loadContractsView(currentUser);
      const certView = document.getElementById('view-certify');
      if (certView && !certView.classList.contains('hidden')) {
        await loadCertifyPendingContracts(currentUser);
      }

    } catch (err) {
      console.error("Error al emitir certificado:", err);
      showToast("Error de Cierre", err.message || "No se pudo emitir el certificado.", "error");
    }
  });
}

window.abrirModalReplica = (contractId) => {
  const modal = document.getElementById('modal-replica');
  const idInput = document.getElementById('modal-rep-contract-id');
  const infoEl = document.getElementById('modal-rep-info');
  const textarea = document.getElementById('modal-rep-statement');
  const existingContainer = document.getElementById('modal-rep-existing-container');
  const existingText = document.getElementById('modal-rep-existing-text');
  const submitBtn = document.getElementById('modal-rep-submit-btn');

  if (!modal) return;

  const contract = cachedContractsMap.get(contractId);
  if (idInput) idInput.value = contractId;
  if (infoEl) infoEl.innerText = `${contract?.propertyAddress || 'Locación'} (Canon: $${Number(contract?.monthlyAmount || 0).toLocaleString('es-AR')})`;

  const rebuttal = contract?.rebuttal;
  if (rebuttal && rebuttal.statement) {
    if (textarea) textarea.value = rebuttal.statement;
    if (existingContainer) existingContainer.classList.remove('hidden');
    if (existingText) existingText.innerText = `"${rebuttal.statement}"`;
    if (submitBtn) submitBtn.innerText = "Actualizar Descargo";
  } else {
    if (textarea) textarea.value = "";
    if (existingContainer) existingContainer.classList.add('hidden');
    if (submitBtn) submitBtn.innerText = "Registrar Descargo";
  }

  modal.classList.remove('hidden');
  if (window.lucide) window.lucide.createIcons();
};

window.cerrarModalReplica = () => {
  const modal = document.getElementById('modal-replica');
  if (modal) modal.classList.add('hidden');
};

const modalRepForm = document.getElementById('form-modal-replica');
if (modalRepForm) {
  modalRepForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const contractId = document.getElementById('modal-rep-contract-id').value;
    const statement = document.getElementById('modal-rep-statement').value.trim();

    if (!statement) {
      showToast("Campo requerido", "Ingresá el texto de tu descargo.", "error");
      return;
    }

    try {
      showToast("Procesando", "Asentando descargo legal en el Buró...", "success");

      await updateDoc(doc(db, "verified_rentals", contractId), {
        tenantUid: currentUser.uid,
        rebuttal: {
          statement,
          submittedAt: serverTimestamp(),
          status: "PRESENTADA"
        }
      });

      showToast("Descargo Registrado", "Tu aclaración quedó incorporada formalmente al legajo.", "success");
      cerrarModalReplica();
      if (currentUser) await loadContractsView(currentUser);
    } catch (err) {
      console.error("Error al registrar réplica:", err);
      showToast("Error de Permisos", err.message || "No se pudo registrar la réplica.", "error");
    }
  });
}

// ============================================================================
// VERIFICACIÓN PÚBLICA DE CERTIFICADO NOTARIAL POR QR (LEY 25.326)
// ============================================================================
async function loadAndRenderPublicVerification(contractId, hashReceived = "") {
  switchTab('verify');
  const contentEl = document.getElementById('verify-card-content');
  if (!contentEl) return;

  try {
    const docRef = doc(db, "verified_rentals", contractId);
    const docSnap = await getDoc(docRef);

    if (!docSnap.exists()) {
      contentEl.innerHTML = `
        <div class="bg-rose-950/30 border border-rose-900/50 rounded-xl p-5 text-center space-y-2">
          <i data-lucide="shield-alert" class="w-8 h-8 text-rose-400 mx-auto"></i>
          <p class="text-sm font-black text-rose-300">Certificado No Encontrado</p>
          <p class="text-xs text-slate-400">El identificador escaneado no coincide con ningún legajo activo en la red.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const c = docSnap.data();

    if (c.status !== 'FINALIZADO') {
      contentEl.innerHTML = `
        <div class="bg-amber-950/30 border border-amber-900/50 rounded-xl p-5 text-center space-y-2">
          <i data-lucide="clock" class="w-8 h-8 text-amber-400 mx-auto"></i>
          <p class="text-sm font-black text-amber-300">Contrato Aún No Finalizado</p>
          <p class="text-xs text-slate-400">Este contrato se encuentra en curso y no cuenta con un certificado de egreso emitido.</p>
        </div>
      `;
      if (window.lucide) window.lucide.createIcons();
      return;
    }

    const rawName = c.name || "Inquilino";
    const nameParts = rawName.trim().split(" ");
    const maskedName = nameParts.map(p => p[0] + "***").join(" ");

    const rawDni = String(c.dni || c.tenantDni || "00000000");
    const maskedDni = rawDni.length > 4 
    ? rawDni.substring(0, 2) + ".***." + rawDni.substring(rawDni.length - 3)
    : rawDni;

    const rawQrScore = c.scoreRentia ?? 0;
    const score = rawQrScore > 100 ? Math.round(rawQrScore / 10) : rawQrScore;
    const scoreColor = score >= 70 ? 'text-[#16c2a3]' : (score >= 45 ? 'text-amber-400' : 'text-rose-400');
    const scoreRating = score >= 70 ? 'Excelente Solvencia' : (score >= 45 ? 'Riesgo Moderado' : 'Alto Riesgo');
    const compliance = c.paymentCompliance ?? 100;
    const onTime = c.behavior?.onTime || 0;
    const late = c.behavior?.late || 0;

    contentEl.innerHTML = `
      <div class="space-y-4">
        <div class="p-3.5 bg-emerald-500/10 border border-emerald-500/30 rounded-xl flex items-center justify-between">
          <div class="flex items-center gap-2.5">
            <span class="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse"></span>
            <div>
              <p class="text-xs font-black text-emerald-300">CERTIFICADO AUTÉNTICO</p>
              <p class="text-[10px] text-slate-400">Asentado en base descentralizada de Buró</p>
            </div>
          </div>
          <span class="text-[9px] font-mono px-2 py-1 rounded bg-slate-900 border border-slate-800 text-slate-400">
            ID: ${contractId.substring(0, 8)}...
          </span>
        </div>

        <div class="bg-slate-950/70 border border-slate-800 rounded-xl p-4 flex items-center justify-between">
          <div>
            <span class="text-[10px] uppercase font-bold text-slate-400 block">Score Reputacional</span>
            <span class="text-2xl font-black ${scoreColor}">${score} <span class="text-xs font-normal text-slate-500">/ 100</span></span>
            <span class="text-[10px] font-bold block ${scoreColor} mt-0.5">${scoreRating}</span>
          </div>
          <div class="text-right">
            <span class="text-[10px] uppercase font-bold text-slate-400 block">Cumplimiento</span>
            <span class="text-base font-black text-white mt-0.5 block">${compliance}%</span>
            <span class="text-[9px] text-slate-500">${onTime} OK / ${late} Mora</span>
          </div>
        </div>

        <div class="bg-slate-950/40 border border-slate-800/80 rounded-xl p-4 space-y-2.5 text-xs">
          <div class="flex justify-between border-b border-slate-900 pb-2">
            <span class="text-slate-400 text-[11px]">Titular Evaluado:</span>
            <span class="font-bold text-slate-200">${escapeHtml(maskedName)} (DNI: ${maskedDni})</span>
          </div>
          <div class="flex justify-between border-b border-slate-900 pb-2">
            <span class="text-slate-400 text-[11px]">Inmueble:</span>
            <span class="font-semibold text-slate-200 truncate max-w-[220px]" title="${escapeHtml(c.propertyAddress || '')}">
              ${escapeHtml(c.propertyAddress || 'Inmueble Auditado')}
            </span>
          </div>
          <div class="flex justify-between border-b border-slate-900 pb-2">
            <span class="text-slate-400 text-[11px]">Vigencia:</span>
            <span class="font-mono text-slate-300 text-[11px]">${c.start} al ${c.end}</span>
          </div>
          <div class="flex justify-between">
            <span class="text-slate-400 text-[11px]">Respaldo Legal:</span>
            <span class="font-bold text-emerald-400 text-[11px]">✓ Ley 25.326 Art. 5 y 6</span>
          </div>
        </div>

      ${hashReceived ? `
          <div class="p-2.5 bg-slate-950 border border-slate-900 rounded-lg text-center">
            <span class="text-[9px] font-mono text-slate-500 block truncate">
              Firma Hash: ${hashReceived}
            </span>
          </div>
        ` : ''}
      </div>
      `;

      if (window.lucide) window.lucide.createIcons();

    } catch (err) {
      console.error("Error en validación pública:", err);
      contentEl.innerHTML = `
      <div class="bg-rose-950/30 border border-rose-900/50 rounded-xl p-4 text-center">
        <p class="text-xs text-rose-400 font-bold">${err.message}</p>
      </div>
      `;
      if (window.lucide) window.lucide.createIcons();
    }
  }

  window.salirDeVerificacion = () => {
    window.history.replaceState({}, document.title, window.location.pathname);
    switchTab('home');
  };

  window.mostrarPestañaPrecios = (tipo) => {
    const secLandlord = document.getElementById('pricing-section-landlord');
    const secAgency = document.getElementById('pricing-section-agency');
    const btnLandlord = document.getElementById('btn-pricing-tab-landlord');
    const btnAgency = document.getElementById('btn-pricing-tab-agency');

    if (tipo === 'LANDLORD') {
      if (secLandlord) secLandlord.classList.remove('hidden');
      if (secAgency) secAgency.classList.add('hidden');
      if (btnLandlord) btnLandlord.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all bg-[#16c2a3] text-[#060913] shadow cursor-pointer";
      if (btnAgency) btnAgency.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all text-slate-400 hover:text-white cursor-pointer";
    } else {
      if (secLandlord) secLandlord.classList.add('hidden');
      if (secAgency) secAgency.classList.remove('hidden');
      if (btnAgency) btnAgency.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all bg-[#16c2a3] text-[#060913] shadow cursor-pointer";
      if (btnLandlord) btnLandlord.className = "px-4 py-2 rounded-lg text-xs font-bold transition-all text-slate-400 hover:text-white cursor-pointer";
    }
    if (window.lucide) window.lucide.createIcons();
  };

// ============================================================================
// GESTIÓN DE EXTINCIÓN DE DEUDA Y HABEAS DATA (ART. 26 LEY 25.326)
// ============================================================================
  window.promptSaldarDeuda = async (contractId, currentDebt) => {
    const contract = cachedContractsMap.get(contractId);
    const tenantName = contract ? (contract.name || 'el inquilino') : 'el inquilino';

    const confirmar = confirm(`¿Confirmás que ${tenantName} regularizó la totalidad de la deuda pendiente ($${Number(currentDebt).toLocaleString('es-AR')})?\n\nDe conformidad con el Art. 26 Inc. 4 de la Ley 25.326, el registro se actualizará a $0 y el plazo de permanencia en el Buró se reducirá a 2 años contados desde hoy.`);

    if (!confirmar) return;

    try {
      showToast("Procesando", "Registrando cancelación de deuda conforme Ley 25.326...", "success");

      const functions = getFunctions(auth.app, "us-central1");
      const saldarFn = httpsCallable(functions, "marcarDeudaSaldada");

      const res = await saldarFn({
        contractId,
        fechaPago: new Date().toISOString().split('T')[0],
        notaCancelacion: "Obligación extinguida y cancelada ante el locador."
      });

      showToast("¡Deuda Regularizada!", `Registro actualizado. Nuevo Score: ${res.data.nuevoScore} pts. Caducidad: ${res.data.purgeLimitDate}.`, "success");

      if (currentUser) {
        await loadContractsView(currentUser);
        await loadReportsView(currentUser);
      }
    } catch (err) {
      console.error("Error al asentar cancelación de deuda:", err);
      showToast("Error", err.message || "No se pudo actualizar el estado de la deuda.", "error");
    }
  };

// ============================================================================
// MODAL Y CONTROLADOR DE TRASPASO DE ADMINISTRACIÓN (EN_CURSO)
// ============================================================================
  window.abrirModalTransferir = (contractId) => {
    const modal = document.getElementById('modal-transferir-contrato');
    const idInput = document.getElementById('modal-transf-contract-id');
    const infoEl = document.getElementById('modal-transf-info');
    if (!modal) return;

    const contract = cachedContractsMap.get(contractId);
    const tenantName = contract ? (contract.name || 'Inquilino') : 'Inquilino';
    const addr = contract?.propertyAddress ? ` · 📍 ${contract.propertyAddress}` : '';

    if (idInput) idInput.value = contractId;
    if (infoEl) infoEl.innerText = `${tenantName}${addr}`;

    const radioUnlink = document.querySelector('input[name="transf-action"][value="UNLINK"]');
    if (radioUnlink) radioUnlink.checked = true;

    window.toggleTransfInputs('UNLINK');
    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  };

  window.cerrarModalTransferir = () => {
    const modal = document.getElementById('modal-transferir-contrato');
    if (modal) modal.classList.add('hidden');
  };

  window.toggleTransfInputs = (action) => {
    const container = document.getElementById('transf-matricula-container');
    const input = document.getElementById('transf-matricula-input');
    const submitBtn = document.getElementById('btn-submit-transferir');
    const labelUnlink = document.getElementById('transf-label-unlink');
    const labelTransfer = document.getElementById('transf-label-transfer');

    if (action === 'TRANSFER') {
      if (container) container.classList.remove('hidden');
      if (input) input.required = true;
      if (submitBtn) submitBtn.innerText = "Confirmar Traspaso";

      if (labelTransfer) {
        labelTransfer.className = "flex items-start gap-3 p-3 rounded-xl border border-sky-500/40 bg-sky-500/10 cursor-pointer transition-all";
        const title = labelTransfer.querySelector('span.block');
        if (title) title.className = "text-xs font-bold text-white block";
      }
      if (labelUnlink) {
        labelUnlink.className = "flex items-start gap-3 p-3 rounded-xl border border-slate-800 bg-slate-950/40 cursor-pointer hover:border-slate-700 transition-all";
        const title = labelUnlink.querySelector('span.block');
        if (title) title.className = "text-xs font-bold text-slate-300 block";
      }
    } else {
      if (container) container.classList.add('hidden');
      if (input) {
        input.required = false;
        input.value = "";
      }
      if (submitBtn) submitBtn.innerText = "Desvincular Inmobiliaria";

      if (labelUnlink) {
        labelUnlink.className = "flex items-start gap-3 p-3 rounded-xl border border-sky-500/40 bg-sky-500/10 cursor-pointer transition-all";
        const title = labelUnlink.querySelector('span.block');
        if (title) title.className = "text-xs font-bold text-white block";
      }
      if (labelTransfer) {
        labelTransfer.className = "flex items-start gap-3 p-3 rounded-xl border border-slate-800 bg-slate-950/40 cursor-pointer hover:border-slate-700 transition-all";
        const title = labelTransfer.querySelector('span.block');
        if (title) title.className = "text-xs font-bold text-slate-300 block";
      }
    }
  };

  const modalTransfForm = document.getElementById('form-modal-transferir');
  if (modalTransfForm) {
    modalTransfForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const contractId = document.getElementById('modal-transf-contract-id').value;
      const action = document.querySelector('input[name="transf-action"]:checked')?.value || 'TRANSFER';
      const matricula = document.getElementById('transf-matricula-input')?.value.trim();

      try {
        showToast("Procesando", "Actualizando administración en la red...", "success");

        try {
          const functions = getFunctions(auth.app, "us-central1");
          const transferirFn = httpsCallable(functions, "transferirAdministracionContrato");
          const res = await transferirFn({
            contractId,
            action,
            nuevaMatriculaCucis: matricula
          });
          showToast("¡Operación Exitosa!", res.data.message, "success");
        } catch (fnErr) {
          console.warn("Fallback directo en Firestore para desvinculación:", fnErr);
          if (action === 'UNLINK') {
            await updateDoc(doc(db, "verified_rentals", contractId), {
              "metadata.agencyId": null,
              "metadata.agencyName": null,
              "metadata.unlinkedAt": serverTimestamp(),
              "metadata.unlinkedByUid": currentUser.uid
            });
            showToast("¡Operación Exitosa!", "Inmobiliaria desvinculada. El inmueble pasó a autogestión.", "success");
          } else {
            throw fnErr;
          }
        }

        cerrarModalTransferir();

        if (currentUser) {
          await loadContractsView(currentUser);
          await loadExpirationsView(currentUser);
        }
      } catch (err) {
        console.error("Error al transferir contrato:", err);
        showToast("Error de Traspaso", err.message || "No se pudo modificar la administración.", "error");
      }
    });
  }

// ============================================================================
// MODAL DE RECTIFICACIÓN (INQUILINO)
// ============================================================================
  window.abrirModalRectificacion = (contractId) => {
    const modal = document.getElementById('modal-rectificacion');
    const inputId = document.getElementById('rect-contract-id');
    const form = document.getElementById('form-rectificacion');
    if (form) form.reset();
    if (inputId) inputId.value = contractId;
    if (modal) modal.classList.remove('hidden');
  };

  const cerrarModalRectificacion = () => {
    const modal = document.getElementById('modal-rectificacion');
    if (modal) modal.classList.add('hidden');
  };

  document.getElementById('btn-cerrar-modal-rectificacion')?.addEventListener('click', cerrarModalRectificacion);
  document.getElementById('btn-cancelar-modal-rectificacion')?.addEventListener('click', cerrarModalRectificacion);

  const formRectificacion = document.getElementById('form-rectificacion');
  if (formRectificacion) {
    formRectificacion.addEventListener('submit', async (e) => {
      e.preventDefault();
      const contractId = document.getElementById('rect-contract-id').value;
      const descargo = document.getElementById('rect-descargo').value.trim();
      const fileInput = document.getElementById('rect-archivo');
      const btnSubmit = document.getElementById('btn-enviar-rectificacion');

      if (!contractId || !fileInput || !fileInput.files.length) {
        showToast("Campos Requeridos", "Por favor ingresá tu descargo y adjuntá el comprobante de respaldo.", "error");
        return;
      }

      const file = fileInput.files[0];

      try {
        if (btnSubmit) {
          btnSubmit.disabled = true;
          btnSubmit.innerText = "Subiendo y Registrando...";
        }
        showToast("Procesando", "Subiendo comprobante bancario a almacenamiento seguro...", "success");

        const fileExt = file.name.split('.').pop();
        const filePath = `rectificaciones/${contractId}_${Date.now()}.${fileExt}`;
        const fileSnapshot = await uploadBytes(storageRef(storage, filePath), file);
        const downloadURL = await getDownloadURL(fileSnapshot.ref);

        const fechaLimite = calcularFechaLimiteHabiles(new Date(), 5);

        await updateDoc(doc(db, "verified_rentals", contractId), {
          "dispute": {
            status: "PENDING",
            claimantUid: currentUser.uid,
            descargo: descargo,
            fileUrl: downloadURL,
            createdAt: serverTimestamp(),
            deadlineAt: Timestamp.fromDate(fechaLimite)
          }
        });

        cerrarModalRectificacion();
        showToast("Reclamo Ingresado", "El contrato pasó a estado cautelar de mediación (Ley 25.326 Art. 16).", "success");

        if (currentUser) {
          await loadContractsView(currentUser);
          await loadReportsView(currentUser);
        }
      } catch (error) {
        console.error("Error al registrar rectificación:", error);
        showToast("Error de Envío", error.message || "No se pudo registrar la rectificación.", "error");
      } finally {
        if (btnSubmit) {
          btnSubmit.disabled = false;
          btnSubmit.innerText = "Enviar Rectificación";
        }
      }
    });
  }

// ============================================================================
// PANEL DE RESOLUCIÓN DE DISPUTAS Y RECTIFICACIONES (LEY 25.326 ART. 16)
// ============================================================================
  window.abrirModalResolverDisputa = (contractId) => {
    const modal = document.getElementById('modal-resolver-disputa');
    const contract = cachedContractsMap.get(contractId);
    if (!modal || !contract || !contract.dispute) {
      showToast("Aviso", "No se encontró el legajo de la disputa seleccionada.", "info");
      return;
    }

    document.getElementById('res-disputa-contract-id').value = contractId;
    document.getElementById('res-disputa-inquilino').innerText = `${contract.name || 'Sin Nombre'} (DNI: ${contract.dni || contract.tenantDni || 'S/D'})`;
    document.getElementById('res-disputa-direccion').innerText = contract.propertyAddress || 'No especificada';
    document.getElementById('res-disputa-monto').innerText = `$${Number(contract.behavior?.debtAmount || 0).toLocaleString('es-AR')}`;
    document.getElementById('res-disputa-descargo').innerText = `"${contract.dispute.descargo || 'Sin manifestación escrita adjunta.'}"`;

    const plazoEl = document.getElementById('res-disputa-plazo-badge');
    if (plazoEl) {
      const deadline = contract.dispute.deadlineAt;
      const { dias, vencido } = calcularDiasHabilesRestantes(deadline);

      if (vencido) {
        plazoEl.innerHTML = `<span class="px-2.5 py-1 rounded bg-rose-500/20 text-rose-400 border border-rose-500/40 font-mono text-[10px] font-bold animate-pulse">⚠️ Plazo Vencido (Resolución Cautelar Inminente)</span>`;
      } else if (dias <= 2) {
        plazoEl.innerHTML = `<span class="px-2.5 py-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 font-mono text-[10px] font-bold">⏳ Plazo crítico: ${dias} día(s) hábil(es) restante(s)</span>`;
      } else {
        plazoEl.innerHTML = `<span class="px-2.5 py-1 rounded bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-mono text-[10px] font-bold">⚖️ Plazo legal: ${dias} días hábiles restantes</span>`;
      }
    }

    const btnComprobante = document.getElementById('btn-ver-comprobante-disputa');
    if (btnComprobante) {
      btnComprobante.onclick = () => {
        if (contract.dispute.fileUrl) {
          const modalAnexo = document.getElementById('modal-anexo');
          if (modalAnexo) modalAnexo.style.zIndex = "9999";
          window.verModalAnexo(contract.dispute.fileUrl, "Comprobante Presentado por el Inquilino (Ley 25.326)");
        } else {
          showToast("Sin Comprobante", "No se detectó un archivo de comprobante adjunto en el reclamo.", "error");
        }
      };
    }

    document.getElementById('res-disputa-motivo-container')?.classList.add('hidden');
    document.getElementById('btn-confirmar-rechazo')?.classList.add('hidden');
    const motivoInput = document.getElementById('res-disputa-motivo');
    if (motivoInput) motivoInput.value = '';

    modal.classList.remove('hidden');
    if (window.lucide) window.lucide.createIcons();
  };

  const cerrarModalResolverDisputa = () => {
    const modal = document.getElementById('modal-resolver-disputa');
    if (modal) modal.classList.add('hidden');
  };

  document.getElementById('btn-cerrar-modal-resolver')?.addEventListener('click', cerrarModalResolverDisputa);

  document.getElementById('btn-iniciar-rechazo')?.addEventListener('click', () => {
    const container = document.getElementById('res-disputa-motivo-container');
    const btnConfirmar = document.getElementById('btn-confirmar-rechazo');
    container?.classList.remove('hidden');
    btnConfirmar?.classList.remove('hidden');
    document.getElementById('res-disputa-motivo')?.focus();
  });

  document.getElementById('btn-aceptar-disputa')?.addEventListener('click', async () => {
    const contractId = document.getElementById('res-disputa-contract-id')?.value;
    if (!contractId) return;

    try {
      showToast("Procesando", "Aceptando rectificación y regularizando legajo...", "success");

      const contract = cachedContractsMap.get(contractId);
      const onTime = contract?.behavior?.onTime || 0;
      const late = contract?.behavior?.late || 0;
      const totalMonths = onTime + late || contract?.totalMonths || 1;
      const complianceRate = Math.round((onTime / totalMonths) * 100);

      let score = Math.round((complianceRate / 100) * 80);
      const conservation = contract?.behavior?.conservation || 'Bueno';
      if (conservation === 'Excelente') score += 10;
      else if (conservation === 'Bueno') score += 5;
      else if (conservation === 'Daños Documentados') score -= 15;
      const restoredScore = Math.max(0, Math.min(100, score));

      await updateDoc(doc(db, "verified_rentals", contractId), {
        "scoreRentia": restoredScore,
        "behavior.debtAmount": 0,
        "behavior.settlementStatus": "SALDADA",
        "behavior.settledAt": serverTimestamp(),
        "legalEvidence.retentionLimitYears": 2,
        "dispute.status": "RESOLVED_ACCEPTED",
        "dispute.resolvedAt": serverTimestamp(),
        "dispute.resolverUid": currentUser.uid
      });

      cerrarModalResolverDisputa();
      showToast("Disputa Resuelta", `Rectificación aceptada. Deuda saldada y score restituido a ${restoredScore} pts.`, "success");

      if (currentUser) {
        await loadContractsView(currentUser);
        await loadReportsView(currentUser);
      }
    } catch (err) {
      console.error("Error al aceptar rectificación:", err);
      showToast("Error", err.message || "No se pudo procesar la resolución de la disputa.", "error");
    }
  });

  document.getElementById('btn-confirmar-rechazo')?.addEventListener('click', async () => {
    const contractId = document.getElementById('res-disputa-contract-id')?.value;
    const motivo = document.getElementById('res-disputa-motivo')?.value.trim();

    if (!motivo) {
      showToast("Fundamentación Requerida", "Por el Art. 16 de la Ley 25.326, debés fundamentar legalmente el rechazo.", "error");
      document.getElementById('res-disputa-motivo')?.focus();
      return;
    }

    try {
      showToast("Procesando", "Asentando rechazo fundado en el legajo...", "success");

      await updateDoc(doc(db, "verified_rentals", contractId), {
        "dispute.status": "RESOLVED_REJECTED",
        "dispute.rejectionReason": motivo,
        "dispute.resolvedAt": serverTimestamp(),
        "dispute.resolverUid": currentUser.uid
      });

      cerrarModalResolverDisputa();
      showToast("Reclamo Rechazado", "La mediación concluyó con rechazo motivado.", "info");

      if (currentUser) {
        await loadContractsView(currentUser);
        await loadReportsView(currentUser);
      }
    } catch (err) {
      console.error("Error al rechazar reclamo:", err);
      showToast("Error", err.message || "No se pudo asentar el rechazo.", "error");
    }
  });

// ============================================================================
// SANITIZACIÓN ESTRICTA EN TIEMPO REAL (DNI Y MATRÍCULAS)
// ============================================================================
  function attachStrictNumericSanitizers() {
    const numericInputIds = [
      'login-dni',
      'recovery-dni',
      'onb-cuit',
      'onb-nromatricula',
      'search-dni-input',
      'cert-dni',
      'cert-owner-dni',
      'agent-dni-input',
      'settings-nro-matricula',
      'transf-matricula-input'
    ];

    numericInputIds.forEach((id) => {
      const input = document.getElementById(id);
      if (input && !input.dataset.sanitizerAttached) {
        input.dataset.sanitizerAttached = "true";
        input.addEventListener('input', (e) => {
          const cursor = e.target.selectionStart;
          const prevLen = e.target.value.length;
          e.target.value = e.target.value.replace(/\D/g, '');
          const newLen = e.target.value.length;
          if (cursor !== null) {
            e.target.setSelectionRange(cursor - (prevLen - newLen), cursor - (prevLen - newLen));
          }
        });
      }
    });
  }



// ============================================================================
// CIRCUITO DE INVITACIÓN DIRECTA AL INQUILINO (createDirectRentalWithInvitation)
// ============================================================================
  window.invitarInquilinoDigital = async (rentalPayload, contractFile = null) => {
    if (!currentUser) {
      showToast("Sesión Requerida", "Debés iniciar sesión para generar una invitación locativa.", "error");
      return;
    }

    try {
      showToast("Generando Invitación", "Subiendo contrato y creando token de consentimiento...", "success");

    // Se delega el payload y el archivo (PDF/imagen) a la función de servicio
      const result = await createDirectRentalWithInvitation({
        ...rentalPayload,
        landlordUid: currentUser.uid,
        creatorRole: activeContext
      }, contractFile);

      const inviteLink = `${window.location.origin}/?invitacion=${result.invitationToken}`;

      if (navigator.clipboard) {
        await navigator.clipboard.writeText(inviteLink);
        showToast("Enlace Copiado", "El enlace de consentimiento digital se copió al portapapeles para enviarlo al inquilino.", "success");
      } else {
        showToast("Invitación Creada", `Token generado: ${result.invitationToken}`, "success");
      }

      return result;
    } catch (err) {
      console.error("Error al generar invitación digital:", err);
      showToast("Error de Invitación", err.message || "No se pudo generar la invitación.", "error");
    throw err; // Permite que setupDigitalInvitationFlow capture el error en su try/catch
  }
};

// ==========================================
// FLUJO DE INVITACIÓN DIGITAL DIRECTA
// ==========================================

function setupDigitalInvitationFlow() {
  const modalPropietario = document.getElementById('modal-invitacion-inquilino');
  const btnAbrirModal = document.getElementById('btn-nueva-invitacion-inquilino');
  const btnCerrarModal = document.getElementById('btn-cerrar-modal-invitacion');
  const btnCancelar = document.getElementById('btn-cancelar-invitacion');
  const formInvitacion = document.getElementById('form-invitacion-inquilino');
  const linkContainer = document.getElementById('inv-link-container');
  const inputLink = document.getElementById('inv-generated-link');
  const btnCopiarManual = document.getElementById('btn-copiar-enlace-manual');
  const btnCrear = document.getElementById('btn-crear-invitacion');

  // Abrir / Cerrar Modal Propietario
  if (btnAbrirModal) {
    btnAbrirModal.addEventListener('click', () => {
      formInvitacion.reset();
      linkContainer.classList.add('hidden');
      modalPropietario.classList.remove('hidden');
      modalPropietario.classList.add('flex');
    });
  }

  const cerrarModalProp = () => {
    modalPropietario.classList.add('hidden');
    modalPropietario.classList.remove('flex');
  };

  btnCerrarModal?.addEventListener('click', cerrarModalProp);
  btnCancelar?.addEventListener('click', cerrarModalProp);

  // Sanitizar DNIs (Inquilino y Propietario)
  const dniTenantInput = document.getElementById('inv-tenant-dni');
  dniTenantInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
  });

  const dniLandlordInput = document.getElementById('inv-landlord-dni');
  dniLandlordInput?.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/\D/g, '');
  });

  // Copiar link manual
  btnCopiarManual?.addEventListener('click', async () => {
    if (inputLink.value) {
      await navigator.clipboard.writeText(inputLink.value);
      showToast('Enlace copiado', 'El enlace se copió al portapapeles', 'success');
    }
  });

  // Envío del Formulario (Propietario / Inmobiliaria)
  formInvitacion?.addEventListener('submit', async (e) => {
    e.preventDefault();

    // 1. Extraer archivo de contrato adjunto
    const fileInput = document.getElementById('inv-contract-file');
    const contractFile = fileInput?.files?.[0] || null;

    if (!contractFile) {
      showToast('Archivo requerido', 'Por favor adjuntá el contrato de locación en PDF o imagen.', 'error');
      return;
    }

    // 2. Extraer datos granulares de ubicación y tipología (Censo Nacional)
    const street = document.getElementById('inv-street')?.value.trim() || '';
    const number = document.getElementById('inv-number')?.value.trim() || '';
    const floor = document.getElementById('inv-floor')?.value.trim() || '';
    const apartment = document.getElementById('inv-apartment')?.value.trim() || '';
    const neighborhood = document.getElementById('inv-neighborhood')?.value.trim() || '';
    const city = document.getElementById('inv-city')?.value.trim() || '';
    const province = document.getElementById('inv-province')?.value || 'Salta';
    const propertyType = document.getElementById('inv-property-type')?.value || '1 Dormitorio';

    // 3. Ensamblar dirección legible para retrocompatibilidad
    const streetParts = [
      street, 
      number, 
      floor ? `${floor}°` : '', 
      apartment ? `Dpto ${apartment}` : ''
    ].filter(Boolean).join(' ');

    const propertyAddress = [
      streetParts, 
      neighborhood, 
      city, 
      province
    ].filter(Boolean).join(', ');

    // 4. Armar el payload completo
    const payload = {
      landlordName: document.getElementById('inv-landlord-name')?.value.trim() || '',
      landlordDni: document.getElementById('inv-landlord-dni')?.value.trim() || '',
      tenantName: document.getElementById('inv-tenant-name')?.value.trim() || '',
      tenantDni: document.getElementById('inv-tenant-dni')?.value.trim() || '',
      tenantEmail: document.getElementById('inv-tenant-email')?.value.trim() || '',
      
      // Dirección compuesta para tablas y certificados
      propertyAddress,

      // Datos estructurados para el censo nacional
      province,
      city,
      neighborhood,
      propertyType,
      street,
      number,
      floor,
      apartment,

      monthlyRent: parseFloat(document.getElementById('inv-monthly-rent')?.value) || 0,
      currency: document.getElementById('inv-currency')?.value || 'ARS',
      startDate: document.getElementById('inv-start-date')?.value || '',
      durationMonths: parseInt(document.getElementById('inv-duration')?.value, 10) || 24
    };

    // 5. Bloqueo de botón mientras sube el archivo a Storage
    const originalBtnText = btnCrear ? btnCrear.innerHTML : '';
    if (btnCrear) {
      btnCrear.disabled = true;
      btnCrear.innerHTML = 'Subiendo contrato...';
    }

    try {
      // Invocación pasando el payload y el archivo del contrato
      const res = await window.invitarInquilinoDigital(payload, contractFile);

      if (res?.invitationToken) {
        const url = `${window.location.origin}/?invitacion=${res.invitationToken}`;
        inputLink.value = url;
        linkContainer.classList.remove('hidden');

        // Copiar automáticamente al portapapeles
        await navigator.clipboard.writeText(url);
        showToast('Enlace generado', 'Enlace creado y copiado al portapapeles', 'success');
      }
    } catch (err) {
      console.error("Error al generar invitación:", err);
      showToast('Error', err.message || 'No se pudo generar el enlace', 'error');
    } finally {
      if (btnCrear) {
        btnCrear.disabled = false;
        btnCrear.innerHTML = originalBtnText;
        if (window.lucide) window.lucide.createIcons();
      }
    }
  });
}

async function checkInvitationTokenOnLoad() {
  const urlParams = new URLSearchParams(window.location.search);
  const token = urlParams.get('invitacion');
  if (!token) return;

  const modalInquilino = document.getElementById('modal-recepcion-inquilino');
  const loading = document.getElementById('inquilino-resumen-loading');
  const content = document.getElementById('inquilino-resumen-content');
  const chkConsent = document.getElementById('check-consentimiento-inquilino');
  const btnAceptar = document.getElementById('btn-aceptar-invitacion');
  const btnRechazar = document.getElementById('btn-rechazar-invitacion');

  modalInquilino.classList.remove('hidden');
  modalInquilino.classList.add('flex');

  chkConsent.addEventListener('change', () => {
    btnAceptar.disabled = !chkConsent.checked;
  });

  btnRechazar.addEventListener('click', () => {
    modalInquilino.classList.add('hidden');
    modalInquilino.classList.remove('flex');
    window.history.replaceState({}, document.title, window.location.pathname);
  });

  try {
    // 1. Consulta los datos al servicio
    const data = await getRentalInvitationByToken(token);

    // 2. Dibuja los datos en el modal
    document.getElementById('rec-propiedad').textContent = data.propertyAddress || '-';
    document.getElementById('rec-canon').textContent = `${data.currency || 'ARS'} $${Number(data.monthlyRent || 0).toLocaleString('es-AR')}`;
    document.getElementById('rec-vigencia').textContent = `${data.startDate || '-'} (${data.durationMonths || 24} meses)`;
    document.getElementById('rec-dni').textContent = data.tenantDni || '-';

    const linkEl = document.getElementById('rec-contract-link');
    if (linkEl) {
      if (data.contractPdfUrl) {
        linkEl.href = data.contractPdfUrl;
        linkEl.parentElement.classList.remove('hidden');
      } else {
        linkEl.parentElement.classList.add('hidden');
      }
    }

    loading.classList.add('hidden');
    content.classList.remove('hidden');

    // 3. Manejo de firma y confirmación
    btnAceptar.addEventListener('click', async () => {
      btnAceptar.disabled = true;
      btnAceptar.innerHTML = 'Procesando firma...';
      try {
        await acceptRentalInvitation(token);
        showToast('¡Contrato Firmado!', 'Has aceptado la vinculación exitosamente.', 'success');
        setTimeout(() => {
          window.location.href = window.location.pathname;
        }, 1800);
      } catch (err) {
        showToast('Error', err.message || 'No se pudo firmar el contrato.', 'error');
        btnAceptar.disabled = false;
        btnAceptar.innerHTML = 'Aceptar y Firmar Digitalmente';
      }
    });

  } catch (err) {
    console.error("Error detallado al cargar invitación:", err);
    loading.innerHTML = `<span class="text-rose-400 font-bold">Detalle del error: ${err.message || err}</span>`;
  }
}


// ============================================================================
// CENSO REAL DE MERCADO LOCATIVO (PROMEDIOS DINÁMICOS)
// ============================================================================
async function loadMarketReferencePrices() {
  const elMono = document.getElementById('ref-price-mono');
  const el1Dorm = document.getElementById('ref-price-1dorm');
  const el2Dorm = document.getElementById('ref-price-2dorm');
  const subMono = document.getElementById('ref-sub-mono');
  const sub1Dorm = document.getElementById('ref-sub-1dorm');
  const sub2Dorm = document.getElementById('ref-sub-2dorm');

  if (!elMono && !el1Dorm && !el2Dorm) return;

  try {
    const rentalsRef = collection(db, "verified_rentals");
    
    // Consulta los contratos activos y finalizados
    // Si no está logueado, consulta los permitidos por reglas públicas
    const allowedStatuses = currentUser ? ["EN_CURSO", "FINALIZADO"] : ["FINALIZADO", "EN_CURSO"];
    
    let snap;
    try {
      const q = query(rentalsRef, where("status", "in", ["EN_CURSO", "FINALIZADO"]));
      snap = await getDocs(q);
    } catch (ruleErr) {
      // Fallback si la regla de Firestore bloquea EN_CURSO a no logueados
      const qFallback = query(rentalsRef, where("status", "==", "FINALIZADO"));
      snap = await getDocs(qFallback);
    }

    const dataByType = {
      'Monoambiente': { total: 0, count: 0, fallback: 0 },
      '1 Dormitorio': { total: 0, count: 0, fallback: 0 },
      '2 Dormitorios': { total: 0, count: 0, fallback: 0 }
    };

    snap.forEach(docSnap => {
      const data = docSnap.data();
      const rawTipo = String(data.propertyType || data.propertyDetails?.propertyType || '').toLowerCase();
      const amount = Number(data.monthlyAmount || data.monthlyRent || 0);

      if (amount > 0) {
        if (rawTipo.includes('mono')) {
          dataByType['Monoambiente'].total += amount;
          dataByType['Monoambiente'].count++;
        } else if (rawTipo.includes('1 dorm') || rawTipo.includes('1 hab') || rawTipo.includes('2 amb') || rawTipo === '') {
          // Si no tiene tipo asignado por ser un contrato viejo, lo cuenta en 1 dormitorio por defecto
          dataByType['1 Dormitorio'].total += amount;
          dataByType['1 Dormitorio'].count++;
        } else if (rawTipo.includes('2 dorm') || rawTipo.includes('2 hab') || rawTipo.includes('3 amb')) {
          dataByType['2 Dormitorios'].total += amount;
          dataByType['2 Dormitorios'].count++;
        }
      }
    });

    const updateUI = (key, elPrice, elSub) => {
      const item = dataByType[key];
      if (item.count > 0) {
        const avg = Math.round(item.total / item.count);
        if (elPrice) elPrice.textContent = `$${avg.toLocaleString('es-AR')}`;
        if (elSub) elSub.textContent = `Promedio real (${item.count} contrato${item.count > 1 ? 's' : ''})`;
      } else {
        if (elPrice) elPrice.textContent = `$${item.fallback.toLocaleString('es-AR')}`;
        if (elSub) elSub.textContent = "Promedio plaza";
      }
    };

    updateUI('Monoambiente', elMono, subMono);
    updateUI('1 Dormitorio', el1Dorm, sub1Dorm);
    updateUI('2 Dormitorios', el2Dorm, sub2Dorm);

  } catch (err) {
    console.error("Error al calcular censo de mercado:", err);
  }
}

// ============================================================================
// MÓDULO INQUILIA BROKER: CARTERA DE PROPIEDADES
// ============================================================================
let cachedProperties = [];
let activePropertySubTab = 'OWN'; // 'OWN' | 'NETWORK'
let cachedNetworkProperties = [];

window.cambiarSubTabPropiedades = async (subTab) => {
  activePropertySubTab = subTab;
  const btnOwn = document.getElementById('tab-prop-own');
  const btnNet = document.getElementById('tab-prop-network');
  const btnNueva = document.getElementById('btn-nueva-propiedad');

  if (subTab === 'OWN') {
    if (btnOwn) btnOwn.className = "px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-[#16c2a3]/10 text-[#16c2a3] border border-[#16c2a3]/30 cursor-pointer flex items-center gap-1.5";
    if (btnNet) btnNet.className = "px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-slate-900 text-slate-400 border border-slate-800 hover:text-white cursor-pointer flex items-center gap-1.5";
    if (btnNueva) btnNueva.classList.remove('hidden');
    renderPropertiesGrid(cachedProperties, false);
  } else {
    if (btnOwn) btnOwn.className = "px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-slate-900 text-slate-400 border border-slate-800 hover:text-white cursor-pointer flex items-center gap-1.5";
    if (btnNet) btnNet.className = "px-3.5 py-1.5 rounded-xl text-xs font-bold transition-all bg-indigo-500/15 text-indigo-300 border border-indigo-500/40 cursor-pointer flex items-center gap-1.5";
    if (btnNueva) btnNueva.classList.add('hidden'); // Oculta el botón de cargar captación propia mientras se mira la red
    
    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const myAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? currentUser.uid : null);
    
    const grid = document.getElementById('properties-grid-container');
    if (grid) grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs animate-pulse">Sincronizando Bolsa Compartida CUCIS...</div>`;
    
    cachedNetworkProperties = await getNetworkProperties(myAgencyId);
    renderPropertiesGrid(cachedNetworkProperties, true);
  }
};

async function loadPropertiesView(user) {
  const grid = document.getElementById('properties-grid-container');
  const totalCountEl = document.getElementById('prop-count-total');
  const availCountEl = document.getElementById('prop-count-available');
  const resCountEl = document.getElementById('prop-count-reserved');
  const rentCountEl = document.getElementById('prop-count-rented');

  if (!grid) return;
  grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs animate-pulse">Cargando inventario de captaciones...</div>`;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    cachedProperties = await getAgencyProperties(targetAgencyId);

    // Métricas de stock
    let available = 0, reserved = 0, rented = 0;
    cachedProperties.forEach(p => {
      if (p.status === 'DISPONIBLE') available++;
      else if (p.status === 'RESERVADO') reserved++;
      else if (p.status === 'ALQUILADO') rented++;
    });

    if (totalCountEl) totalCountEl.innerText = cachedProperties.length;
    if (availCountEl) availCountEl.innerText = available;
    if (resCountEl) resCountEl.innerText = reserved;
    if (rentCountEl) rentCountEl.innerText = rented;

    activePropertySubTab = 'OWN';
    renderPropertiesGrid(cachedProperties, false)

  } catch (err) {
    console.error("Error al cargar propiedades:", err);
    grid.innerHTML = `<div class="col-span-full py-8 text-center text-rose-400 text-xs">Error al cargar la cartera de inmuebles.</div>`;
  }
}

function renderPropertiesGrid(properties) {
  const grid = document.getElementById('properties-grid-container');
  if (!grid) return;

  if (!properties || properties.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-500 space-y-2">
        <i data-lucide="building-2" class="w-8 h-8 mx-auto text-slate-600"></i>
        <p class="text-xs">No hay inmuebles registrados en tu cartera aún.</p>
        <p class="text-[10px] text-slate-600">Presioná "Cargar Inmueble" para subir tu primera captación.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  grid.innerHTML = properties.map(p => {
    const priceNum = Number(p.price || 0);
    const currencySymbol = p.currency === 'USD' ? 'u$s' : '$';
    const formattedPrice = `${currencySymbol} ${priceNum.toLocaleString('es-AR')}`;

    const operation = p.operation || 'ALQUILER_TRADICIONAL';
    let opBadge = '';
    let priceSuffix = '';

    if (operation === 'VENTA') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-indigo-300 border border-indigo-500 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-indigo-400"></span> Venta
      </span>`;
      priceSuffix = '';
    } else if (operation === 'ALQUILER_TEMPORAL') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-amber-300 border border-amber-500 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-amber-400"></span> Temporal
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / noche</span>';
    } else {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-[#16c2a3] text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-[#16c2a3]"></span> Alquiler
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / mes</span>';
    }

    const badgeColor = p.status === 'DISPONIBLE' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30' : (p.status === 'RESERVADO' ? 'bg-amber-500/10 text-amber-400 border-amber-500/30' : 'bg-sky-500/10 text-sky-400 border-sky-500/30');
    const photo = (p.photos && p.photos.length > 0) ? p.photos[0] : (p.mainPhoto || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=500&auto=format&fit=crop&q=60');

    return `
      <div class="bg-slate-950/80 border border-slate-800 rounded-2xl overflow-hidden hover:border-[#16c2a3]/40 transition-all flex flex-col justify-between shadow-lg">
        <div onclick="window.abrirModalDetallePropiedad('${p.id}')" class="cursor-pointer group">
          <div class="relative h-44 w-full bg-slate-900 overflow-hidden">
            <img src="${photo}" alt="${escapeHtml(p.title)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
            <span class="absolute top-3 right-3 text-[9px] px-2.5 py-0.5 rounded-full font-bold uppercase border ${badgeColor} z-10">
              ${p.status}
            </span>
            <div class="absolute top-3 left-3 z-10">${opBadge}</div>
            <span class="absolute bottom-3 left-3 bg-slate-950/90 backdrop-blur-sm text-white font-black text-sm px-2.5 py-1 rounded-lg border border-slate-800 shadow-md">
              ${formattedPrice}${priceSuffix}
            </span>
          </div>

          <div class="p-4 space-y-2 text-left">
            <h4 class="font-bold text-white text-xs truncate group-hover:text-[#16c2a3] transition-colors" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</h4>
            <p class="text-[11px] text-slate-400 truncate flex items-center gap-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-[#16c2a3] shrink-0"></i> ${escapeHtml(p.propertyAddress || 'Ubicación no especificada')}
            </p>
      ${p.description ? `<p class="text-[10px] text-slate-400 line-clamp-2 leading-relaxed italic opacity-85">"${escapeHtml(p.description)}"</p>` : ''}
            <div class="flex items-center gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-900">
              <span>${escapeHtml(p.propertyType || 'Inmueble')}</span>
      ${p.surfaceM2 ? `<span>· ${p.surfaceM2} m²</span>` : ''}
              <span class="text-emerald-400 font-bold">· Verificado CUCIS</span>
            </div>
          </div>
        </div>

        <!-- CONTROLES EXCLUSIVOS EN MI CARTERA (EDITAR, CAMBIAR ESTADO, ELIMINAR, CONTRATO) -->
        <div class="p-3 bg-slate-900/60 border-t border-slate-800 flex items-center justify-between gap-2 flex-wrap">
          <select onchange="window.cambiarEstadoPropiedadDirecta('${p.id}', this.value, '${operation}')" class="bg-slate-950 border border-slate-700 text-white text-[10px] font-bold rounded-lg px-2 py-2 focus:outline-none cursor-pointer">
            <option value="DISPONIBLE" ${p.status === 'DISPONIBLE' ? 'selected' : ''}>🟢 Disponible</option>
            <option value="RESERVADO" ${p.status === 'RESERVADO' ? 'selected' : ''}>🟡 ${operation === 'VENTA' ? 'Seña / Reserva' : 'Reservado'}</option>
            <option value="${operation === 'VENTA' ? 'VENDIDO' : 'ALQUILADO'}" ${(p.status === 'ALQUILADO' || p.status === 'VENDIDO') ? 'selected' : ''}>🔴 ${operation === 'VENTA' ? 'Vendido' : 'Alquilado'}</option>
          </select>
      
          <div class="flex items-center gap-1.5 ml-auto">
            <button type="button" onclick="window.abrirModalEditarPropiedad('${p.id}')" class="px-2.5 py-2 bg-slate-800 hover:bg-slate-700 text-[#16c2a3] border border-[#16c2a3]/30 rounded-lg text-[10px] font-bold uppercase transition flex items-center gap-1 cursor-pointer" title="Editar datos">
              <i data-lucide="edit-3" class="w-3.5 h-3.5"></i> Editar
            </button>

      ${operation === 'ALQUILER_TRADICIONAL' && p.status === 'DISPONIBLE' ? `
              <button type="button" onclick="window.alquilarPropiedadDirecta('${p.id}')" class="px-2.5 py-2 bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] rounded-lg text-[10px] font-black uppercase transition cursor-pointer flex items-center gap-1" title="Emitir Contrato">
                <i data-lucide="file-plus" class="w-3.5 h-3.5"></i> Contrato
              </button>
        ` : ''}

            <button type="button" onclick="window.eliminarPropiedad('${p.id}')" class="p-2 bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 rounded-lg text-[10px] transition cursor-pointer" title="Eliminar inmueble">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      </div>
      `;
    }).join('');

if (window.lucide) window.lucide.createIcons();
}

window.contactarColegaRed = async (propId) => {
  const prop = cachedNetworkProperties.find(p => p.id === propId);
  if (!prop) return;

  try {
    showToast("Conectando", "Obteniendo datos de contacto del colega matriculado...", "info");
    const agencySnap = await getDoc(doc(db, "agencies", prop.agencyId));
    const agencyData = agencySnap.exists() ? agencySnap.data() : null;

    const nombreColega = agencyData?.name || "Colega CUCIS";
    const cuitOrTel = agencyData?.cuit || "";
    
    alert(`💼 Co-Brokerage CUCIS:\n\nInmobiliaria: ${nombreColega}\nMatrícula CUCIS: ${agencyData?.nroMatricula || 'Verificada'}\nInmueble: ${prop.title}\nDirección: ${prop.propertyAddress}\nCanon: ${prop.currency} $${Number(prop.price).toLocaleString('es-AR')}\n\nPodes comunicarte con la firma para pactar visitas y coordinar comisión compartida.`);
  } catch (err) {
    showToast("Error", "No se pudo obtener el contacto del colega.", "error");
  }
};

// ============================================================================
// MÓDULO INQUILIA BROKER: PIPELINE DE LEADS & POSTULANTES (CRM)
// ============================================================================
let cachedLeads = [];

async function loadLeadsView(user) {
  const container = document.getElementById('leads-list-container');
  const totalCountEl = document.getElementById('lead-count-total');
  const newCountEl = document.getElementById('lead-count-new');
  const evalCountEl = document.getElementById('lead-count-eval');
  const wonCountEl = document.getElementById('lead-count-won');

  if (!container) return;
  container.innerHTML = `<div class="py-8 text-center text-slate-400 text-xs animate-pulse">Cargando postulantes e interesados...</div>`;

  try {
    const userDoc = await getDoc(doc(db, "users", user.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const targetAgencyId = userData.agencyId || (activeContext === 'AGENCY_OWNER' ? user.uid : null);

    cachedLeads = await getAgencyLeads(targetAgencyId);

    // Conteo de métricas para el encabezado del embudo
    let countNew = 0, countEval = 0, countWon = 0;
    cachedLeads.forEach(l => {
      if (l.status === 'NUEVO' || l.status === 'CONTACTADO') countNew++;
      else if (l.status === 'EN_EVALUACION') countEval++;
      else if (l.status === 'GANADO') countWon++;
    });

    if (totalCountEl) totalCountEl.innerText = cachedLeads.length;
    if (newCountEl) newCountEl.innerText = countNew;
    if (evalCountEl) evalCountEl.innerText = countEval;
    if (wonCountEl) wonCountEl.innerText = countWon;

    const filterVal = document.getElementById('filter-lead-status')?.value || 'ALL';
    renderLeadsList(cachedLeads, filterVal);

  } catch (err) {
    console.error("Error al cargar leads:", err);
    container.innerHTML = `<div class="py-8 text-center text-rose-400 text-xs">Error al cargar el listado de interesados.</div>`;
  }
}

function renderLeadsList(leads, filterStatus = 'ALL') {
  const container = document.getElementById('leads-list-container');
  if (!container) return;

  const filtered = filterStatus === 'ALL' ? leads : leads.filter(l => l.status === filterStatus);

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="py-12 text-center text-slate-500 space-y-2">
        <i data-lucide="users" class="w-8 h-8 mx-auto text-slate-600"></i>
        <p class="text-xs">No hay interesados registrados con este criterio.</p>
        <p class="text-[10px] text-slate-600">Presioná "Nuevo Interesado" para cargar una consulta entrante.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  container.innerHTML = filtered.map(lead => {
    const cleanPhone = String(lead.phone || '').replace(/\D/g, '');
    const waUrl = `https://wa.me/${cleanPhone.startsWith('54') ? cleanPhone : '549' + cleanPhone}?text=${encodeURIComponent(`Hola ${lead.name}, te contacto de la inmobiliaria por tu consulta sobre alquileres en Inquilia.`)}`;
    
    const statusBadges = {
      'NUEVO': 'bg-sky-500/10 text-sky-400 border-sky-500/30',
      'CONTACTADO': 'bg-indigo-500/10 text-indigo-400 border-indigo-500/30',
      'EN_EVALUACION': 'bg-amber-500/10 text-amber-400 border-amber-500/30',
      'GANADO': 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
      'DESCARTADO': 'bg-rose-500/10 text-rose-400 border-rose-500/30'
    };
    const badgeClass = statusBadges[lead.status] || 'bg-slate-800 text-slate-400 border-slate-700';

    // Condición de matcheo: si es búsqueda abierta y definió presupuesto o tipo
    const hasSearchCriteria = !lead.propertyId && (Number(lead.budget) > 0 || lead.preferredType);

    return `
      <div class="bg-slate-950/80 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row justify-between items-start md:items-center gap-4 hover:border-[#16c2a3]/30 transition-all">
        <div class="space-y-1.5 flex-1">
          <div class="flex items-center gap-2.5 flex-wrap">
            <span class="font-bold text-white text-sm">${escapeHtml(lead.name)}</span>
            <span class="text-[9px] px-2 py-0.5 rounded-full font-bold uppercase border ${badgeClass}">
              ${lead.status}
            </span>
      ${lead.dni ? `<span class="text-[10px] font-mono text-slate-400">DNI: ${escapeHtml(lead.dni)}</span>` : '<span class="text-[9px] text-amber-400/80 italic">Sin DNI cargado</span>'}
          </div>

          <div class="flex items-center gap-4 text-[11px] text-slate-400 flex-wrap">
            <span class="text-[#16c2a3] font-medium flex items-center gap-1">
              <i data-lucide="building" class="w-3.5 h-3.5"></i> ${escapeHtml(lead.propertyTitle || 'Búsqueda Abierta')}
            </span>
      ${lead.budget ? `<span>Presupuesto: $${Number(lead.budget).toLocaleString('es-AR')}</span>` : ''}
      ${lead.preferredType ? `<span>Tipo: ${escapeHtml(lead.preferredType)}</span>` : ''}
          </div>

      ${lead.notes ? `<p class="text-[10px] text-slate-500 italic">"${escapeHtml(lead.notes)}"</p>` : ''}

      ${hasSearchCriteria ? `
            <div class="pt-1">
              <button type="button" onclick="abrirModalMatchLead('${lead.id}')" class="px-2.5 py-1 bg-indigo-500/15 hover:bg-indigo-500/25 text-indigo-300 border border-indigo-500/30 rounded-lg text-[10px] font-bold uppercase transition flex items-center gap-1.5 cursor-pointer">
                <i data-lucide="sparkles" class="w-3 h-3 text-indigo-400"></i> Buscar Opciones Compatibles (Cartera + Red CUCIS)
              </button>
            </div>
        ` : ''}
        </div>

        <!-- Acciones del Pipeline -->
        <div class="flex items-center gap-2 w-full md:w-auto justify-end flex-wrap">

          <!-- Botón WhatsApp Directo -->
          <a href="${waUrl}" target="_blank" rel="noopener noreferrer" class="px-3 py-2 bg-emerald-600/15 hover:bg-emerald-600/25 text-emerald-400 border border-emerald-500/30 rounded-xl text-xs font-bold transition flex items-center gap-1.5 cursor-pointer" title="Contactar por WhatsApp">
            <i data-lucide="message-circle" class="w-4 h-4"></i> WhatsApp
          </a>

          <!-- Botón Estrella: Auditar en Buró en 1 Clic -->
        ${lead.dni ? `
            <button type="button" onclick="auditarLeadDirecto('${lead.dni}')" class="px-3.5 py-2 bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] rounded-xl text-xs font-black uppercase tracking-wider transition-all shadow-md flex items-center gap-1.5 cursor-pointer" title="Consultar antecedentes y Score en el Buró">
              <i data-lucide="shield-check" class="w-4 h-4"></i> Auditar Buró
            </button>
          ` : `
            <button type="button" onclick="pedirDniParaAuditar('${lead.id}')" class="px-3 py-2 bg-slate-900 hover:bg-slate-800 text-slate-400 border border-slate-800 rounded-xl text-xs font-semibold transition cursor-pointer flex items-center gap-1" title="Cargar DNI para auditar">
              <i data-lucide="id-card" class="w-3.5 h-3.5"></i> Cargar DNI
            </button>
          `}

          <!-- Selector de Estado de Pipeline -->
          <select onchange="cambiarEstadoLead('${lead.id}', this.value)" class="bg-slate-900 border border-slate-800 text-[11px] rounded-xl px-2 py-2 text-slate-300 focus:outline-none cursor-pointer">
            <option value="NUEVO" ${lead.status === 'NUEVO' ? 'selected' : ''}>Nuevo</option>
            <option value="CONTACTADO" ${lead.status === 'CONTACTADO' ? 'selected' : ''}>Contactado</option>
            <option value="EN_EVALUACION" ${lead.status === 'EN_EVALUACION' ? 'selected' : ''}>En Evaluación</option>
            <option value="GANADO" ${lead.status === 'GANADO' ? 'selected' : ''}>Ganado</option>
            <option value="DESCARTADO" ${lead.status === 'DESCARTADO' ? 'selected' : ''}>Descartado</option>
          </select>
        </div>
      </div>
        `;
      }).join('');

if (window.lucide) window.lucide.createIcons();
}

// Conexión directa con la consulta del Buró
window.auditarLeadDirecto = (dni) => {
  if (!dni) return;
  reportNavigationOrigin = 'leads';
  switchTab('search');
  const inputDni = document.getElementById('search-dni-input');
  if (inputDni) {
    inputDni.value = dni;
    fetchAndRenderReport(dni, true);
  }
};

window.pedirDniParaAuditar = async (leadId) => {
  const nuevoDni = prompt("Ingresá el número de DNI del interesado para consultar su Score en el Buró:");
  if (!nuevoDni) return;
  const cleanDni = nuevoDni.replace(/\D/g, '');
  if (!cleanDni) {
    showToast("Error", "DNI no válido.", "error");
    return;
  }

  try {
    await updateDoc(doc(db, "leads", leadId), {
      dni: cleanDni,
      updatedAt: serverTimestamp()
    });
    showToast("DNI Actualizado", "Consultando Buró...", "success");
    if (currentUser) await loadLeadsView(currentUser);
    window.auditarLeadDirecto(cleanDni);
  } catch (err) {
    showToast("Error", err.message || "No se pudo actualizar el DNI.", "error");
  }
};

window.cambiarEstadoLead = async (leadId, newStatus) => {
  try {
    await updateLeadStatus(leadId, newStatus);
    showToast("Estado Actualizado", `Postulante marcado como: ${newStatus}`, "info");
    if (currentUser) await loadLeadsView(currentUser);
  } catch (err) {
    showToast("Error", "No se pudo actualizar el estado del postulante.", "error");
  }
};

// Cruce inteligente (Smart Matching)
window.abrirModalMatchLead = async (leadId) => {
  const lead = cachedLeads.find(l => l.id === leadId);
  if (!lead) return;

  showToast("Buscando Coincidencias", "Cruzando requerimientos con tu inventario y la Red CUCIS...", "info");

  try {
    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const myAgencyId = userData.agencyId || currentUser.uid;

    const matches = await matchPropertiesForLead(lead, myAgencyId);
    const total = matches.ownMatches.length + matches.networkMatches.length;

    if (total === 0) {
      alert(`No encontramos inmuebles disponibles en tu cartera ni en la Red CUCIS que se ajusten a ${lead.preferredType || 'la tipología solicitada'} con presupuesto de hasta $${Number(lead.budget).toLocaleString('es-AR')}.`);
      return;
    }

    let mensaje = `🎯 Coincidencias encontradas para ${lead.name}:\n\n`;
    
    if (matches.ownMatches.length > 0) {
      mensaje += `🏢 EN TU CARTERA (${matches.ownMatches.length}):\n`;
      matches.ownMatches.forEach(p => {
        mensaje += ` • ${p.title} - $${Number(p.price).toLocaleString('es-AR')} (${p.propertyAddress || ''})\n`;
      });
      mensaje += `\n`;
    }

    if (matches.networkMatches.length > 0) {
      mensaje += `🤝 EN RED COLEGAS CUCIS (${matches.networkMatches.length} para Co-Brokerage):\n`;
      matches.networkMatches.forEach(p => {
        mensaje += ` • ${p.title} - $${Number(p.price).toLocaleString('es-AR')} (${p.city || ''})\n`;
      });
    }

    alert(mensaje);
  } catch (err) {
    console.error("Error al buscar matches:", err);
    showToast("Error", "No se pudo realizar el cruce de cartera.", "error");
  }
};

// ============================================================================
// CATÁLOGO WEB PÚBLICO DE LA INMOBILIARIA (INQUILIA BROKER)
// ============================================================================
let currentCatalogProperties = [];
let currentCatalogAgency = null;
let catalogWhatsAppUrl = "";

window.abrirWhatsAppInmobiliaria = () => {
  if (catalogWhatsAppUrl) {
    window.open(catalogWhatsAppUrl, '_blank', 'noopener,noreferrer');
  } else {
    alert("Esta inmobiliaria aún no ha configurado un número de WhatsApp de contacto en su perfil.");
  }
};

// Alias de respaldo para compatibilidad
window.abrirWhatsAppCatalogo = window.abrirWhatsAppInmobiliaria;

async function loadAndRenderAgencyCatalog(agencyId) {
  switchTab('agency-catalog');
  const grid = document.getElementById('cat-props-grid');
  const nameEl = document.getElementById('cat-agency-name');
  const badgeEl = document.getElementById('cat-agency-cucis-badge');
  const waBtn = document.getElementById('cat-agency-wa-btn');
  const countEl = document.getElementById('cat-props-count');

  if (grid) grid.innerHTML = `<div class="col-span-full py-8 text-center text-slate-400 text-xs animate-pulse">Cargando catálogo inmobiliario oficial...</div>`;

  try {
    let agencyData = null;
    let targetPhone = "";

    // 1. Consultar documento en 'agencies'
    const agencySnap = await getDoc(doc(db, "agencies", agencyId));
    if (agencySnap.exists()) {
      agencyData = { id: agencySnap.id, ...agencySnap.data() };
      targetPhone = agencyData.movil || agencyData.telefono || "";
    }

    // 2. Si no tiene teléfono en 'agencies', intentar leer de users de forma segura
    if (!targetPhone) {
      try {
        const ownerUid = agencyData?.ownerUid || agencyId;
        const userSnap = await getDoc(doc(db, "users", ownerUid));
        if (userSnap.exists()) {
          const u = userSnap.data();
          targetPhone = u.movil || "";
          if (!agencyData) {
            agencyData = {
              id: userSnap.id,
              name: u.nombreFantasia || u.nombre || "Inmobiliaria Matriculada",
              nroMatricula: u.nroMatricula || "Verificada",
              movil: u.movil || ""
            };
          } else if (currentUser && currentUser.uid === ownerUid && targetPhone) {
            // Sincronizar en agencies para que las futuras lecturas públicas no dependan de users
            updateDoc(doc(db, "agencies", agencyId), { movil: targetPhone }).catch(() => {});
          }
        }
      } catch (userErr) {
        // En consultas anónimas users estará bloqueado por reglas, continuamos sin interrumpir
        console.warn("Perfil privado no accesible públicamente:", userErr);
      }
    }

    if (!agencyData) {
      throw new Error("No se encontró el registro de la inmobiliaria.");
    }

    // 3. Consultar las propiedades DISPONIBLES de esta agencia
    const qProps = query(
      collection(db, "properties"),
      where("agencyId", "==", agencyId),
      where("status", "==", "DISPONIBLE")
    );
    const propsSnap = await getDocs(qProps);
    currentCatalogProperties = propsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    currentCatalogAgency = { ...agencyData, movil: targetPhone };

    // 4. Renderizar datos institucionales
    if (nameEl) nameEl.innerText = agencyData.name || 'Estudio Inmobiliario';
    if (badgeEl) badgeEl.innerText = `Mat. CUCIS: ${agencyData.nroMatricula || 'Verificada'}`;
    if (countEl) countEl.innerText = `${currentCatalogProperties.length} propiedades disponibles`;

    // 5. Configurar enlace directo de WhatsApp
    const cleanPhone = String(targetPhone).replace(/\D/g, '');
    if (cleanPhone) {
      const phoneFormatted = cleanPhone.startsWith('54') ? cleanPhone : ('549' + cleanPhone);
      catalogWhatsAppUrl = `https://wa.me/${phoneFormatted}?text=${encodeURIComponent(`Hola ${agencyData.name}, me comunico a través de su catálogo en Inquilia para consultar por alquileres.`)}`;
    } else {
      catalogWhatsAppUrl = "";
    }

    if (waBtn) {
      if (!cleanPhone) {
        waBtn.classList.add('opacity-60');
      } else {
        waBtn.classList.remove('opacity-60');
      }
    }

    renderCatalogGrid(currentCatalogProperties);

    // 6. Filtros de búsqueda
    const btnApply = document.getElementById('cat-btn-apply-filters');
    if (btnApply) {
      btnApply.onclick = () => {
        const opVal = document.getElementById('cat-filter-operation')?.value || 'ALL';
        const typeVal = document.getElementById('cat-filter-type')?.value || 'ALL';
        const maxPrice = Number(document.getElementById('cat-filter-max-price')?.value) || Infinity;

        const filtered = currentCatalogProperties.filter(p => {
          const propOp = p.operation || 'ALQUILER_TRADICIONAL';
          if (opVal !== 'ALL' && propOp !== opVal) return false;
          if (typeVal !== 'ALL' && p.propertyType !== typeVal) return false;
          if (maxPrice !== Infinity && Number(p.price) > maxPrice) return false;
          return true;
        });

        renderCatalogGrid(filtered);
      };
    }

  } catch (err) {
    console.error("Error al cargar catálogo de inmobiliaria:", err);
    if (grid) grid.innerHTML = `<div class="col-span-full py-8 text-center text-rose-400 text-xs">No se pudo cargar el catálogo de esta inmobiliaria. Verificá que el enlace sea correcto.</div>`;
    catalogWhatsAppUrl = "";
    if (waBtn) {
      waBtn.onclick = () => alert("Catálogo no disponible.");
    }
  }
}

function renderCatalogGrid(properties) {
  const grid = document.getElementById('cat-props-grid');
  if (!grid) return;

  if (properties.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full py-12 text-center text-slate-500 space-y-2">
        <i data-lucide="home" class="w-8 h-8 mx-auto text-slate-600"></i>
        <p class="text-xs">No hay inmuebles disponibles con los filtros seleccionados.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  const rawPhone = currentCatalogAgency?.movil || "";
  const cleanPhone = String(rawPhone).replace(/\D/g, '');
  const phoneFormatted = cleanPhone.startsWith('54') ? cleanPhone : ('549' + cleanPhone);

  grid.innerHTML = properties.map(p => {
    const photo = p.mainPhoto || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=500&auto=format&fit=crop&q=60';
    
    // Configuración según Operación
    const operation = p.operation || 'ALQUILER_TRADICIONAL';
    let opBadge = '';
    let priceSuffix = '';

    if (operation === 'VENTA') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-indigo-300 border border-indigo-500/60 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-indigo-400"></span> Venta
      </span>`;
      priceSuffix = '';
    } else if (operation === 'ALQUILER_TEMPORAL') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-amber-300 border border-amber-500/60 text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-amber-400"></span> Temporal
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / noche</span>';
    } else {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-[#16c2a3] text-[10px] font-black uppercase tracking-wider px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-[#16c2a3]"></span> Alquiler
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / mes</span>';
    }

    const minScore = Number(p.minScore) || 0;
    const scoreBadge = minScore > 0 
    ? `<span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-emerald-500/60 text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-2xl">
           <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i> Score ${minScore}+
  </span>`
  : '';

  return `
      <div class="bg-slate-950/80 border border-slate-800 rounded-2xl overflow-hidden hover:border-[#16c2a3]/40 transition-all flex flex-col justify-between">
        <div>
          <div class="relative h-44 w-full bg-slate-900">
            <img src="${photo}" alt="${escapeHtml(p.title)}" class="w-full h-full object-cover">

            <div class="absolute top-3 left-3 flex items-center gap-1.5 flex-wrap">
              ${opBadge}
              ${scoreBadge}
            </div>

            <span class="absolute bottom-3 left-3 bg-slate-950/85 backdrop-blur-sm text-white font-black text-sm px-2.5 py-1 rounded-lg border border-slate-800">
              ${formattedPrice}${priceSuffix}
            </span>
          </div>

          <div class="p-4 space-y-2 text-left">
            <h4 class="font-bold text-white text-xs truncate" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</h4>
            <p class="text-[11px] text-slate-400 truncate flex items-center gap-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-[#16c2a3]"></i> ${escapeHtml(p.propertyAddress || 'Ubicación no especificada')}
            </p>
            <div class="flex items-center gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-900">
              <span>${escapeHtml(p.propertyType || 'Inmueble')}</span>
    ${p.surfaceM2 ? `<span>· ${p.surfaceM2} m²</span>` : ''}
              <span class="text-emerald-400 font-bold">· Verificado CUCIS</span>
            </div>
          </div>
        </div>

       <div class="p-3 bg-slate-900/40 border-t border-slate-800/80 flex items-center justify-between gap-2">
          <button type="button" onclick="iniciarConsultaPropiedad('${p.id}')" class="w-full bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] font-bold py-2 rounded-lg text-xs uppercase transition flex items-center justify-center gap-1.5 shadow-md cursor-pointer">
            <i data-lucide="message-circle" class="w-4 h-4"></i> ${operation === 'VENTA' ? 'Consultar Compra por WhatsApp' : 'Consultar por WhatsApp'}
          </button>
        </div>
      </div>
  `;
}).join('');

  if (window.lucide) window.lucide.createIcons();
}

// ============================================================================
// FLUJO INTELIGENTE DE CAPTURA DE LEADS EN CATÁLOGO PÚBLICO
// ============================================================================
let selectedPropForLead = null;

window.iniciarConsultaPropiedad = (propId) => {
  const prop = currentCatalogProperties.find(p => p.id === propId);
  if (!prop) return;

  selectedPropForLead = prop;
  const modal = document.getElementById('modal-public-lead');
  const titleEl = document.getElementById('modal-lead-prop-title');
  const priceEl = document.getElementById('modal-lead-prop-price');
  const opEl = document.getElementById('modal-lead-prop-op');
  const idEl = document.getElementById('modal-lead-prop-id');

  if (titleEl) titleEl.innerText = prop.title;
  if (priceEl) priceEl.innerText = `${prop.currency === 'USD' ? 'u$s' : '$'} ${Number(prop.price || 0).toLocaleString('es-AR')}`;
  if (opEl) opEl.innerText = `PROPIEDAD EN ${prop.operation || 'ALQUILER'}`;
  if (idEl) idEl.value = prop.id;

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
  if (window.lucide) window.lucide.createIcons();
};

window.cerrarModalPublicLead = () => {
  const modal = document.getElementById('modal-public-lead');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

// Escuchador de envío del formulario de consulta
document.getElementById('form-public-lead')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = document.getElementById('modal-lead-name')?.value.trim();
  const phone = document.getElementById('modal-lead-phone')?.value.trim();
  const dni = document.getElementById('modal-lead-dni')?.value.trim().replace(/\D/g, '');
  const btnSubmit = document.getElementById('btn-submit-public-lead');

  if (!name || !phone) {
    alert("Por favor completá tu nombre y teléfono de contacto.");
    return;
  }

  const prop = selectedPropForLead;
  if (!prop || !currentCatalogAgency) return;

  if (btnSubmit) {
    btnSubmit.disabled = true;
    btnSubmit.innerText = "Conectando...";
  }

  try {
    // 1. Guardar automáticamente el Lead en el CRM de la inmobiliaria
    const targetAgencyId = currentCatalogAgency.id || currentCatalogAgency.ownerUid;
    await createLeadRecord({
      name,
      phone,
      dni: dni || null,
      email: '',
      propertyId: prop.id,
      propertyTitle: prop.title,
      budget: Number(prop.price) || 0,
      preferredType: prop.propertyType || '',
      notes: `Consulta recibida desde la web por ${prop.operation || 'ALQUILER'}: "${prop.title}"`,
      status: 'NUEVO',
      agencyId: targetAgencyId
    });

    // 2. Armar el mensaje de WhatsApp con los datos completos
    const rawAgencyPhone = currentCatalogAgency.movil || "";
    let cleanAgencyPhone = String(rawAgencyPhone).replace(/\D/g, '');
    if (cleanAgencyPhone.startsWith('0')) cleanAgencyPhone = cleanAgencyPhone.substring(1);
    if (!cleanAgencyPhone.startsWith('54')) cleanAgencyPhone = '549' + cleanAgencyPhone;

    const formattedPrice = `${prop.currency === 'USD' ? 'u$s' : '$'} ${Number(prop.price || 0).toLocaleString('es-AR')}`;
    const dniText = dni ? ` (DNI: ${dni})` : '';
    const message = `Hola ${currentCatalogAgency.name || 'Inmobiliaria'}, te contacto por la propiedad en ${prop.operation || 'ALQUILER'}: "${prop.title}" (${formattedPrice}) que vi en su catálogo de Inquilia. Mi nombre es ${name}${dniText}.`;

    const waUrl = `https://wa.me/${cleanAgencyPhone}?text=${encodeURIComponent(message)}`;

    cerrarModalPublicLead();
    document.getElementById('form-public-lead')?.reset();

    // 3. Abrir WhatsApp
    window.open(waUrl, '_blank', 'noopener,noreferrer');

  } catch (err) {
    console.error("Error al registrar consulta de interesado:", err);
    // Si falla el guardado en Firestore, abre WhatsApp de todas formas para no perder el cliente
    const rawAgencyPhone = currentCatalogAgency.movil || "";
    let cleanAgencyPhone = String(rawAgencyPhone).replace(/\D/g, '');
    if (!cleanAgencyPhone.startsWith('54')) cleanAgencyPhone = '549' + cleanAgencyPhone;
    window.open(`https://wa.me/${cleanAgencyPhone}`, '_blank');
  } finally {
    if (btnSubmit) {
      btnSubmit.disabled = false;
      btnSubmit.innerHTML = `<i data-lucide="message-circle" class="w-3.5 h-3.5"></i> Iniciar Conversación`;
      if (window.lucide) window.lucide.createIcons();
    }
  }
});

window.copiarLinkMiCatalogo = async () => {
  if (!currentUser) return;
  try {
    const userDoc = await getDoc(doc(db, "users", currentUser.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};
    const targetAgencyId = userData.agencyId || currentUser.uid;

    // Asegurar que agencies tenga el teléfono sincronizado para visitas públicas
    if (userData.movil) {
      updateDoc(doc(db, "agencies", targetAgencyId), { movil: userData.movil }).catch(() => {});
    }

    const url = `${window.location.origin}/?inmobiliaria=${targetAgencyId}`;
    await navigator.clipboard.writeText(url);
    showToast("Enlace Copiado", "El enlace a tu catálogo web público fue copiado al portapapeles.", "success");
  } catch (err) {
    showToast("Error", "No se pudo copiar el enlace.", "error");
  }
};

// ============================================================================
// PORTAL INMOBILIARIO GENERAL (ACCESO CON SESIÓN PARA PARTICULARES)
// ============================================================================
let cachedPortalProperties = [];

async function loadPortalView() {
  const grid = document.getElementById('portal-props-grid');
  const countEl = document.getElementById('portal-props-count');
  if (!grid) return;

  grid.innerHTML = `<div class="col-span-full py-12 text-center text-slate-400 text-xs animate-pulse">Sincronizando inventario de la red...</div>`;

  try {
    // 1. Consulta directa a la colección properties (sin where que bloquee la consulta)
    const snap = await getDocs(collection(db, "properties"));
    
    // 2. Extraer documentos y filtrar en memoria los DISPONIBLES
    const allProps = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    cachedPortalProperties = allProps.filter(p => !p.status || p.status === 'DISPONIBLE');

    if (countEl) countEl.innerText = `${cachedPortalProperties.length} inmuebles disponibles`;
    renderPortalGrid(cachedPortalProperties);

    // 3. Escuchador de filtros del portal
    const btnApply = document.getElementById('portal-btn-apply');
    if (btnApply) {
      btnApply.onclick = () => {
        const opVal = document.getElementById('portal-filter-op')?.value || 'ALL';
        const typeVal = document.getElementById('portal-filter-type')?.value || 'ALL';
        const maxPrice = Number(document.getElementById('portal-filter-price')?.value) || Infinity;

        const filtered = cachedPortalProperties.filter(p => {
          const propOp = p.operation || 'ALQUILER_TRADICIONAL';
          if (opVal !== 'ALL' && propOp !== opVal) return false;
          if (typeVal !== 'ALL' && p.propertyType !== typeVal) return false;
          if (maxPrice !== Infinity && Number(p.price) > maxPrice) return false;
          return true;
        });

        renderPortalGrid(filtered);
      };
    }

  } catch (err) {
    console.error("Error al cargar portal inmobiliario:", err);
    grid.innerHTML = `<div class="col-span-full py-12 text-center text-rose-400 text-xs">Error al cargar inventario: ${err.message || 'Verifique conexión y reglas de Firestore.'}</div>`;
  }
}

function renderPortalGrid(properties) {
  const grid = document.getElementById('portal-props-grid');
  if (!grid) return;

  if (!properties || properties.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full py-16 text-center text-slate-500 space-y-2">
        <i data-lucide="home" class="w-10 h-10 mx-auto text-slate-600"></i>
        <p class="text-xs">No encontramos inmuebles con los criterios seleccionados.</p>
        <p class="text-[10px] text-slate-600">Probá ampliando el presupuesto o seleccionando todas las tipologías.</p>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
    return;
  }

  grid.innerHTML = properties.map(p => {
    const priceNum = Number(p.price || 0);
    const currencySymbol = p.currency === 'USD' ? 'u$s' : '$';
    const formattedPrice = `${currencySymbol} ${priceNum.toLocaleString('es-AR')}`;

    const operation = p.operation || 'ALQUILER_TRADICIONAL';
    let opBadge = '';
    let priceSuffix = '';

    if (operation === 'VENTA') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-indigo-300 border border-indigo-500 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-indigo-400"></span> Venta
      </span>`;
      priceSuffix = '';
    } else if (operation === 'ALQUILER_TEMPORAL') {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-amber-300 border border-amber-500 text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-amber-400"></span> Temporal
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / noche</span>';
    } else {
      opBadge = `
        <span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-[#16c2a3] text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
          <span class="w-2 h-2 rounded-full bg-[#16c2a3]"></span> Alquiler
      </span>`;
      priceSuffix = '<span class="text-[10px] text-slate-400 font-normal"> / mes</span>';
    }

    const minScore = Number(p.minScore) || 0;
    const scoreBadge = minScore > 0 
    ? `<span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-emerald-500 text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-2xl">
           <i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i> Score ${minScore}+
  </span>`
  : '';

  const photo = (p.photos && p.photos.length > 0) ? p.photos[0] : (p.mainPhoto || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=500&auto=format&fit=crop&q=60');

    // 🔒 En el Portal Público NUNCA se edita. Solo muestra la tarjeta interactiva y el botón de WhatsApp.
  return `
      <div class="bg-slate-950/80 border border-slate-800 rounded-2xl overflow-hidden hover:border-[#16c2a3]/40 transition-all flex flex-col justify-between shadow-lg">
        <div onclick="window.abrirModalDetallePropiedad('${p.id}')" class="cursor-pointer group">
          <div class="relative h-44 w-full bg-slate-900 overflow-hidden">
            <img src="${photo}" alt="${escapeHtml(p.title)}" class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500">
    
            <div class="absolute top-3 left-3 flex items-center gap-1.5 flex-wrap z-10">
              ${opBadge}
              ${scoreBadge}
            </div>

            <span class="absolute bottom-3 left-3 bg-slate-950/90 backdrop-blur-sm text-white font-black text-sm px-2.5 py-1 rounded-lg border border-slate-800 shadow-md">
              ${formattedPrice}${priceSuffix}
            </span>
          </div>

          <div class="p-4 space-y-2 text-left">
            <h4 class="font-bold text-white text-xs truncate group-hover:text-[#16c2a3] transition-colors" title="${escapeHtml(p.title)}">${escapeHtml(p.title)}</h4>
            <p class="text-[11px] text-slate-400 truncate flex items-center gap-1">
              <i data-lucide="map-pin" class="w-3.5 h-3.5 text-[#16c2a3] shrink-0"></i> ${escapeHtml(p.propertyAddress || 'Ubicación no especificada')}
            </p>
    ${p.description ? `<p class="text-[10px] text-slate-400 line-clamp-2 leading-relaxed italic opacity-85">"${escapeHtml(p.description)}"</p>` : ''}
            <div class="flex items-center gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-900">
              <span>${escapeHtml(p.propertyType || 'Inmueble')}</span>
    ${p.surfaceM2 ? `<span>· ${p.surfaceM2} m²</span>` : ''}
              <span class="text-emerald-400 font-bold">· Verificado CUCIS</span>
            </div>
          </div>
        </div>

        <!-- PIE DE TARJETA ESTRICTAMENTE PARA WHATSAPP EN EL PORTAL -->
        <div class="p-3 bg-slate-900/40 border-t border-slate-800/80 flex items-center justify-between gap-2">
          <button type="button" onclick="window.contactarPropiedadDesdePortal('${p.id}')" class="w-full bg-[#16c2a3] hover:bg-emerald-600 text-[#060913] font-bold py-2 rounded-lg text-xs uppercase transition flex items-center justify-center gap-1.5 shadow-md cursor-pointer">
            <i data-lucide="message-circle" class="w-4 h-4"></i> ${operation === 'VENTA' ? 'Consultar Compra por WhatsApp' : 'Consultar por WhatsApp'}
          </button>
        </div>
      </div>
  `;
}).join('');

if (window.lucide) window.lucide.createIcons();
}

window.iniciarConsultaPropiedad = async (propId) => {
  const prop = (currentCatalogProperties || []).find(p => p.id === propId);
  if (!prop) return;

  selectedPropForLead = prop;
  const modal = document.getElementById('modal-public-lead');
  const titleEl = document.getElementById('modal-lead-prop-title');
  const priceEl = document.getElementById('modal-lead-prop-price');
  const opEl = document.getElementById('modal-lead-prop-op');
  const idEl = document.getElementById('modal-lead-prop-id');

  if (titleEl) titleEl.innerText = prop.title || '';
  if (priceEl) priceEl.innerText = `${prop.currency === 'USD' ? 'u$s' : '$'} ${Number(prop.price || 0).toLocaleString('es-AR')}`;
  if (opEl) opEl.innerText = `PROPIEDAD EN ${prop.operation || 'ALQUILER'}`;
  if (idEl) idEl.value = prop.id;

  // Precarga automática si el usuario está logueado
  if (currentUser) {
    try {
      const uSnap = await getDoc(doc(db, "users", currentUser.uid));
      if (uSnap.exists()) {
        const u = uSnap.data();
        const inputName = document.getElementById('modal-lead-name');
        const inputPhone = document.getElementById('modal-lead-phone');
        const inputDni = document.getElementById('modal-lead-dni');
        
        if (inputName) inputName.value = u.nombre || u.fullName || '';
        if (inputPhone) inputPhone.value = u.movil || '';
        if (inputDni) inputDni.value = u.dni || '';
      }
    } catch (e) {
      console.warn("No se pudo precargar perfil de usuario:", e);
    }
  }

  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
  if (window.lucide) window.lucide.createIcons();
};

// ============================================================================
// MODAL DE DETALLE Y GALERÍA COMPLETA DE LA PROPIEDAD
// ============================================================================
window.abrirModalDetallePropiedad = (propId) => {
  // Busca la propiedad en el listado del portal o del catálogo
  const prop = (cachedPortalProperties || []).find(p => p.id === propId) || 
  (currentCatalogProperties || []).find(p => p.id === propId) ||
  (cachedProperties || []).find(p => p.id === propId);

  if (!prop) return;

  const modal = document.getElementById('modal-property-detail');
  if (!modal) return;

  const op = prop.operation || 'ALQUILER_TRADICIONAL';
  const priceFormatted = `${prop.currency === 'USD' ? 'u$s' : '$'} ${Number(prop.price || 0).toLocaleString('es-AR')}${op === 'ALQUILER_TEMPORAL' ? ' / noche' : (op === 'VENTA' ? '' : ' / mes')}`;

  // 1. Textos y Badges
  document.getElementById('detail-prop-title').innerText = prop.title || 'Propiedad';
  document.getElementById('detail-prop-op').innerText = op === 'VENTA' ? 'Venta' : (op === 'ALQUILER_TEMPORAL' ? 'Temporal' : 'Alquiler');
  document.getElementById('detail-prop-price-badge').innerText = priceFormatted;
  document.getElementById('detail-prop-type').innerText = prop.propertyType || 'Inmueble';
  document.getElementById('detail-prop-surface').innerText = prop.surfaceM2 ? `${prop.surfaceM2} m²` : 'S/D';
  document.getElementById('detail-prop-city').innerText = prop.city || prop.province || 'Salta';
  document.getElementById('detail-prop-address').innerText = prop.propertyAddress || 'Ubicación no especificada';
  
  const minScore = Number(prop.minScore) || 0;
  document.getElementById('detail-prop-score').innerText = minScore > 0 ? `Score ${minScore}+` : 'Abierto a todos';
  document.getElementById('detail-prop-description').innerText = prop.description || 'La inmobiliaria no ha cargado una descripción adicional para este inmueble.';

  // 2. Galería de Fotos (Fotos múltiples)
  const photos = (prop.photos && prop.photos.length > 0) ? prop.photos : [prop.mainPhoto || 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=500&auto=format&fit=crop&q=60'];
  const mainImg = document.getElementById('detail-prop-main-img');
  const thumbsContainer = document.getElementById('detail-prop-thumbnails');

  if (mainImg) mainImg.src = photos[0];

  if (thumbsContainer) {
    if (photos.length > 1) {
      thumbsContainer.classList.remove('hidden');
      thumbsContainer.innerHTML = photos.map((url, idx) => `
        <img src="${url}" alt="Foto ${idx + 1}" onclick="document.getElementById('detail-prop-main-img').src='${url}'" class="w-16 h-12 object-cover rounded-lg border border-slate-700 hover:border-[#16c2a3] cursor-pointer transition shrink-0">
      `).join('');
    } else {
      thumbsContainer.classList.add('hidden');
      thumbsContainer.innerHTML = '';
    }
  }

  // 3. Conectar el botón de WhatsApp del pie del modal
  const btnContact = document.getElementById('detail-btn-contact');
  if (btnContact) {
    btnContact.onclick = () => {
      cerrarModalDetallePropiedad();
      window.contactarPropiedadDesdePortal(propId);
    };
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  if (window.lucide) window.lucide.createIcons();
};

window.cerrarModalDetallePropiedad = () => {
  const modal = document.getElementById('modal-property-detail');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
};

// ============================================================================
// GESTIÓN DEL CICLO DE DISPONIBILIDAD (DISPONIBLE, RESERVADO, VENDIDO, BAJA)
// ============================================================================
window.cambiarEstadoPropiedadDirecta = async (propId, newStatus, operation) => {
  try {
    showToast("Actualizando", `Modificando estado de la propiedad a ${newStatus}...`, "info");
    
    await updatePropertyStatus(propId, newStatus);
    
    if (newStatus === 'ALQUILADO' || newStatus === 'VENDIDO') {
      showToast("Operación Cerrada", `El inmueble se marcó como ${newStatus} y ya no se muestra en el Portal general.`, "success");
    } else if (newStatus === 'RESERVADO') {
      showToast("Reserva Registrada", `El inmueble quedó en trámite de ${operation === 'VENTA' ? 'compra' : 'alquiler'}.`, "warning");
    } else {
      showToast("Disponible", "El inmueble volvió a publicarse en el Portal de la red.", "success");
    }

    if (currentUser && typeof loadPropertiesView === 'function') {
      await loadPropertiesView(currentUser);
    }
  } catch (err) {
    console.error("Error al modificar estado de la propiedad:", err);
    showToast("Error", err.message || "No se pudo actualizar el estado del inmueble.", "error");
  }
};

window.eliminarPropiedad = async (propId) => {
  if (!confirm("¿Deseas dar de baja este inmueble de tu cartera? Dejará de estar disponible en el inventario y en el portal.")) {
    return;
  }

  try {
    showToast("Eliminando", "Dando de baja la propiedad...", "info");
    const { doc, deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(db, "properties", propId));
    showToast("Propiedad Eliminada", "El inmueble fue removido con éxito.", "success");
    if (currentUser && typeof loadPropertiesView === 'function') {
      await loadPropertiesView(currentUser);
    }
  } catch (err) {
    console.error("Error al eliminar propiedad:", err);
    showToast("Error", err.message || "No se pudo eliminar el inmueble.", "error");
  }
};

window.alquilarPropiedadDirecta = (propId) => {
  const prop = cachedProperties.find(p => p.id === propId);
  if (!prop) return;

  switchTab('contracts');
  const btnInvite = document.getElementById('btn-nueva-invitacion-inquilino');
  if (btnInvite) btnInvite.click();

  // Precompleta la dirección y canon en el formulario de invitación digital
  setTimeout(() => {
    const rentInput = document.getElementById('inv-monthly-rent');
    const streetInput = document.getElementById('inv-street');
    const numInput = document.getElementById('inv-number');
    const cityInput = document.getElementById('inv-city');

    if (rentInput && prop.price) rentInput.value = prop.price;
    if (streetInput && prop.street) streetInput.value = prop.street;
    if (numInput && prop.number) numInput.value = prop.number;
    if (cityInput && prop.city) cityInput.value = prop.city;
  }, 250);
};

let editingPropertyId = null;

// Apertura para cargar NUEVA propiedad
document.getElementById('btn-nueva-propiedad')?.addEventListener('click', () => {
  editingPropertyId = null; // 👈 RESETEA: Es una nueva propiedad
  const form = document.getElementById('form-property');
  if (form) form.reset();

  const titleHeader = document.getElementById('modal-property')?.querySelector('h3');
  const submitBtn = document.getElementById('btn-submit-property');
  if (titleHeader) titleHeader.innerText = "Cargar Inmueble a Cartera";
  if (submitBtn) submitBtn.innerText = "Guardar Propiedad";

  const fileInput = document.getElementById('prop-images');
  if (fileInput) fileInput.required = true;

  document.getElementById('modal-property')?.classList.remove('hidden');
  document.getElementById('modal-property')?.classList.add('flex');
});

// Apertura para EDITAR propiedad existente
window.abrirModalEditarPropiedad = (propId) => {
  const prop = (cachedPortalProperties || []).find(p => p.id === propId) || 
  (cachedProperties || []).find(p => p.id === propId);
  if (!prop) return;

  editingPropertyId = propId; // 👈 ASIGNA: Estamos editando este ID específico

  const modal = document.getElementById('modal-property');
  const titleHeader = modal?.querySelector('h3');
  const submitBtn = document.getElementById('btn-submit-property');

  if (titleHeader) titleHeader.innerText = "Editar Inmueble";
  if (submitBtn) submitBtn.innerText = "Guardar Modificaciones";

  // Precompletar todos los datos
  if (document.getElementById('prop-title')) document.getElementById('prop-title').value = prop.title || '';
  if (document.getElementById('prop-description')) document.getElementById('prop-description').value = prop.description || '';
  if (document.getElementById('prop-operation')) document.getElementById('prop-operation').value = prop.operation || 'ALQUILER_TRADICIONAL';
  if (document.getElementById('prop-type')) document.getElementById('prop-type').value = prop.propertyType || '1 Dormitorio';
  if (document.getElementById('prop-surface')) document.getElementById('prop-surface').value = prop.surfaceM2 || '';
  if (document.getElementById('prop-currency')) document.getElementById('prop-currency').value = prop.currency || 'ARS';
  if (document.getElementById('prop-price')) document.getElementById('prop-price').value = prop.price || '';
  if (document.getElementById('prop-expenses')) document.getElementById('prop-expenses').value = prop.expenses || 0;
  if (document.getElementById('prop-min-score')) document.getElementById('prop-min-score').value = prop.minScore || 0;
  if (document.getElementById('prop-province')) document.getElementById('prop-province').value = prop.province || 'Salta';
  if (document.getElementById('prop-city')) document.getElementById('prop-city').value = prop.city || '';
  if (document.getElementById('prop-neighborhood')) document.getElementById('prop-neighborhood').value = prop.neighborhood || '';
  if (document.getElementById('prop-street')) document.getElementById('prop-street').value = prop.street || '';
  if (document.getElementById('prop-number')) document.getElementById('prop-number').value = prop.number || '';
  if (document.getElementById('prop-floor')) document.getElementById('prop-floor').value = prop.floor || '';
  if (document.getElementById('prop-apartment')) document.getElementById('prop-apartment').value = prop.apartment || '';

  // Al editar, no es obligatorio volver a subir fotos si ya tiene
  const fileInput = document.getElementById('prop-images');
  if (fileInput) fileInput.required = false;

  modal?.classList.remove('hidden');
  modal?.classList.add('flex');
};

window.cambiarEstadoPropiedadDirecta = async (propId, newStatus, operation) => {
  try {
    showToast("Actualizando", `Modificando estado de la propiedad a ${newStatus}...`, "info");
    await updatePropertyStatus(propId, newStatus);
    
    if (newStatus === 'ALQUILADO' || newStatus === 'VENDIDO') {
      showToast("Operación Cerrada", `El inmueble se marcó como ${newStatus} y no se mostrará en el Portal.`, "success");
    } else {
      showToast("Estado Actualizado", `La propiedad ahora figura como ${newStatus}.`, "success");
    }

    await loadPortalView();
    if (typeof loadPropertiesView === 'function') await loadPropertiesView(currentUser);
  } catch (err) {
    console.error("Error al modificar estado:", err);
    showToast("Error", err.message || "No se pudo actualizar el estado.", "error");
  }
};

window.eliminarPropiedad = async (propId) => {
  if (!confirm("¿Deseas dar de baja este inmueble? Dejará de figurar en el portal.")) return;

  try {
    showToast("Eliminando", "Dando de baja la propiedad...", "info");
    const { doc, deleteDoc } = await import("firebase/firestore");
    await deleteDoc(doc(db, "properties", propId));
    showToast("Propiedad Eliminada", "El inmueble fue removido con éxito.", "success");
    
    await loadPortalView();
    if (typeof loadPropertiesView === 'function') await loadPropertiesView(currentUser);
  } catch (err) {
    console.error("Error al eliminar:", err);
    showToast("Error", err.message || "No se pudo eliminar el inmueble.", "error");
  }
};

window.generarPreviewPropiedad = () => {
  const title = document.getElementById('prop-title')?.value.trim() || 'Título de ejemplo';
  const op = document.getElementById('prop-operation')?.value || 'ALQUILER_TRADICIONAL';
  const curr = document.getElementById('prop-currency')?.value === 'USD' ? 'u$s' : '$';
  const price = Number(document.getElementById('prop-price')?.value || 0).toLocaleString('es-AR');
  const type = document.getElementById('prop-type')?.value || 'Inmueble';
  const surface = document.getElementById('prop-surface')?.value || '0';
  const desc = document.getElementById('prop-description')?.value.trim() || 'Sin descripción ingresada aún.';
  const city = document.getElementById('prop-city')?.value.trim() || 'Salta Capital';
  const neighborhood = document.getElementById('prop-neighborhood')?.value.trim() || 'Centro';
  const street = document.getElementById('prop-street')?.value.trim() || 'Calle Principal 100';
  const minScore = Number(document.getElementById('prop-min-score')?.value || 0);

  const fileInput = document.getElementById('prop-images');
  let photoUrl = 'https://images.unsplash.com/photo-1560448204-e02f11c3d0e2?w=500&auto=format&fit=crop&q=60';
  if (fileInput && fileInput.files && fileInput.files[0]) {
    photoUrl = URL.createObjectURL(fileInput.files[0]);
  }

  const container = document.getElementById('preview-card-container');
  if (container) {
    container.innerHTML = `
      <div class="bg-slate-950 border border-slate-800 rounded-2xl overflow-hidden shadow-xl">
        <div class="relative h-44 w-full bg-slate-900">
          <img src="${photoUrl}" alt="Preview" class="w-full h-full object-cover">
          <div class="absolute top-3 left-3 flex items-center gap-1.5 flex-wrap z-10">
            <span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-[#16c2a3] text-[10px] font-black uppercase px-2.5 py-1 rounded-lg shadow-2xl">
              <span class="w-2 h-2 rounded-full bg-[#16c2a3]"></span> ${op === 'VENTA' ? 'Venta' : (op === 'ALQUILER_TEMPORAL' ? 'Temporal' : 'Alquiler')}
            </span>
      ${minScore > 0 ? `<span class="inline-flex items-center gap-1.5 bg-[#060913] text-white border border-emerald-500 text-[10px] font-bold px-2.5 py-1 rounded-lg shadow-2xl"><i data-lucide="shield-check" class="w-3.5 h-3.5 text-emerald-400"></i> Score ${minScore}+</span>` : ''}
          </div>
          <span class="absolute bottom-3 left-3 bg-slate-950/90 text-white font-black text-sm px-2.5 py-1 rounded-lg border border-slate-800">
            ${curr} ${price}${op === 'ALQUILER_TEMPORAL' ? ' / noche' : (op === 'VENTA' ? '' : ' / mes')}
          </span>
        </div>
        <div class="p-4 space-y-2 text-left">
          <h4 class="font-bold text-white text-xs truncate">${escapeHtml(title)}</h4>
      <p class="text-[11px] text-slate-400 truncate">📍 ${escapeHtml(`${street}, ${neighborhood}, ${city}`)}</p>
          <p class="text-[10px] text-slate-400 line-clamp-2 leading-relaxed italic">"${escapeHtml(desc)}"</p>
          <div class="flex items-center gap-3 text-[10px] text-slate-500 pt-1 border-t border-slate-900">
            <span>${escapeHtml(type)}</span>
            <span>· ${surface} m²</span>
            <span class="text-emerald-400 font-bold">· Verificado</span>
          </div>
        </div>
      </div>
    `;
    if (window.lucide) window.lucide.createIcons();
  }

  const modalPreview = document.getElementById('modal-preview-property');
  modalPreview?.classList.remove('hidden');
  modalPreview?.classList.add('flex');
};

// Control de modales legales en la SPA (Texto Oficial Homologado)
window.abrirModalLegal = function(tipo) {
  const modal = document.getElementById('modal-legal');
  const title = document.getElementById('modal-legal-title');
  const body = document.getElementById('modal-legal-body');
  if (!modal || !title || !body) return;

  if (tipo === 'terminos') {
    title.innerText = 'Términos y Condiciones · Propiedad Intelectual';
    body.innerHTML = `
      <div class="space-y-4 text-xs text-slate-300 leading-relaxed">
        <div>
          <h4 class="font-bold text-white text-sm">Cláusula: Propiedad Intelectual y Marca Registrada</h4>
        </div>
      
        <div>
          <h5 class="font-semibold text-white">1. Signo Distintivo y Registro de Marca</h5>
          <p class="mt-1">La denominación <b>INQUILIA</b>, sus isotipos, imagotipos, diseño de interfaces, grafismos y nombres de dominio asociados son propiedad exclusiva de Matías Usandivaras Marcó. El signo denominativo "INQUILIA" se encuentra en trámite regular de registro de marca ante el Instituto Nacional de la Propiedad Industrial (INPI) bajo las prescripciones de la Ley Nº 22.362, con solicitudes radicadas para:</p>
          <ul class="list-disc pl-5 mt-1 space-y-1 text-slate-400">
            <li><b>Clase 36 (Niza):</b> Servicios financieros, servicios de información financiera facilitada mediante acceso a base de datos informática, evaluación de solvencia crediticia y elaboración de informes crediticios locativos.</li>
            <li><b>Clase 42 (Niza):</b> Software como servicio (SaaS), diseño, actualización y desarrollo de software para el sector inmobiliario, y alojamiento y almacenamiento electrónico de datos.</li>
          </ul>
          <p class="mt-1">Queda estrictamente prohibida la utilización total o parcial, reproducción, imitación, uso marcario o registro de nombres idénticos o confusamente similares por parte de usuarios o terceros sin autorización expresa, previa y por escrito de su titular.</p>
        </div>

        <div>
          <h5 class="font-semibold text-white">2. Derechos sobre el Software, Código y Algoritmos</h5>
          <p class="mt-1">La totalidad del software que compone la plataforma INQUILIA —incluyendo su código fuente, código objeto, estructuras de bases de datos, algoritmos de cálculo de scoring locativo, API endpoints, documentación técnica, textos explicativos y estilos visuales— está protegida por la <b>Ley Nº 11.723 de Propiedad Intelectual</b>.</p>
        </div>

        <div>
          <h5 class="font-semibold text-white">3. Restricciones de Uso y Licencia</h5>
          <p class="mt-1">El acceso a la plataforma otorga al usuario una licencia de uso limitada, revocable, no exclusiva e intransferible para la gestión y consulta de informes según su plan de contratación. Se prohíbe expresamente:</p>
          <ul class="list-disc pl-5 mt-1 space-y-1 text-slate-400">
            <li>Realizar ingeniería inversa, descompilar, desensamblar o intentar derivar el código fuente de cualquier componente de la plataforma.</li>
            <li>Emplear técnicas de extracción automatizada de datos (screen scraping, crawling, bots) sobre los perfiles de inquilinos, reportes de solvencia o contratos generados.</li>
            <li>Revender, sublicenciar, comercializar o redistribuir masivamente los reportes o datos obtenidos sin contar con acuerdo comercial específico.</li>
          </ul>
        </div>
      </div>
    `;
  } else if (tipo === 'privacidad') {
    title.innerText = 'Políticas de Privacidad y Tratamiento de Datos';
    body.innerHTML = `
      <div class="space-y-4 text-xs text-slate-300 leading-relaxed">
        <div>
          <h4 class="font-bold text-white text-sm">Cláusula: Protección de Datos Personales y Hábeas Data</h4>
        </div>

        <div>
          <h5 class="font-semibold text-white">1. Marco Normativo y Registro Oficial</h5>
          <p class="mt-1">El tratamiento de datos personales efectuado a través de la plataforma INQUILIA se rige estrictamente por la <b>Ley Nacional Nº 25.326 de Protección de Datos Personales</b>, su Decreto Reglamentario Nº 1558/2001 y las disposiciones emitidas por la Agencia de Acceso a la Información Pública (AAIP).</p>
          <p class="mt-1">El titular y responsable del tratamiento de los datos es <b>Matías Usandivaras Marcó (CUIT: 20-28633912-4)</b>, debidamente inscripto como Responsable en el Registro Nacional de Bases de Datos Personales bajo el identificador oficial <b>RL-2026-105698331-APN-DNPDP#AAIP</b>, encontrándose la base de datos de la plataforma formalmente registrada bajo el expediente electrónico <b>EX-2026-105724221- -APN-DNPDP#AAIP</b>.</p>
        </div>

        <div>
          <h5 class="font-semibold text-white">2. Finalidad del Tratamiento y Legitimación</h5>
          <p class="mt-1">Los datos recabados son tratados con la exclusiva finalidad de evaluar la solvencia económica, capacidad de pago y riesgo locativo de los postulantes a contratos de locación, así como emitir scoring locativo y reportes de cumplimiento patrimonial para inmobiliarias, corredores inmobiliarios matriculados y propietarios locadores adheridos. El tratamiento de información crediticia y patrimonial se encuadra en los términos del <b>Artículo 26 de la Ley Nº 25.326</b>.</p>
        </div>

        <div>
          <h5 class="font-semibold text-white">3. Consentimiento y Cesión de Información</h5>
          <p class="mt-1">El usuario, al postularse o registrar sus datos en la plataforma, presta su consentimiento expreso, previo e informado (Artículos 5 y 11 de la Ley Nº 25.326) para que INQUILIA:</p>
          <ul class="list-disc pl-5 mt-1 space-y-1 text-slate-400">
            <li>Valide y cruce su información de identidad y solvencia financiera ante fuentes de acceso público irrestricto, burós autorizados y bases de datos financieras o crediticias.</li>
            <li>Comparta los informes de riesgo, validación de antecedentes y scoring crediticio únicamente con los locadores, administradores de consorcios o intermediarios inmobiliarios autorizados para el contrato específico en evaluación.</li>
          </ul>
        </div>

        <div>
          <h5 class="font-semibold text-white">4. Plazos de Conservación y Supresión</h5>
          <p class="mt-1">La información relativa al cumplimiento o incumplimiento de obligaciones locativas se conservará por un plazo máximo de <b>cinco (5) años</b> a partir del hecho generador (Art. 26 inc. 4º Ley Nº 25.326). En caso de deudas u obligaciones canceladas, el registro se mantendrá por un período no mayor a <b>dos (2) años</b> desde la acreditación fehaciente de la cancelación.</p>
        </div>

        <div>
          <h5 class="font-semibold text-white">5. Ejercicio de Derechos ARCO</h5>
          <p class="mt-1">El titular podrá ejercer sus derechos de acceso, rectificación, actualización y supresión enviando comunicación formal a través del correo legal establecido en la plataforma, acreditando identidad con copia digital de su DNI. INQUILIA responderá dentro de los diez (10) días corridos para acceso, y dentro de los cinco (5) días hábiles para rectificación o supresión (Arts. 14 y 16 Ley Nº 25.326).</p>
        </div>

        <div class="p-3 bg-slate-950/80 border border-slate-800 rounded-xl">
          <h5 class="font-semibold text-[#16c2a3] text-[11px] uppercase">6. Leyenda Legal Obligatoria (Res. AAIP Nº 14/2018)</h5>
          <p class="mt-1 text-slate-300 text-[11px] italic leading-normal">
            «El titular de los datos personales tiene la facultad de ejercer el derecho de acceso a los mismos en forma gratuita a intervalos no inferiores a seis meses, salvo que se acredite un interés legítimo al efecto conforme lo establecido en el artículo 14, inciso 3 de la Ley Nº 25.326. La AGENCIA DE ACCESO A LA INFORMACIÓN PÚBLICA, en su carácter de Órgano de Control de la Ley Nº 25.326, tiene la atribución de atender las denuncias y reclamos que interpongan quienes resulten afectados en sus derechos por incumplimiento de las normas vigentes en materia de protección de datos personales.»
          </p>
        </div>
      </div>
    `;
  } else if (tipo === 'rectificacion') {
    title.innerText = 'Derecho de Hábeas Data · Procedimiento en Plataforma';
    body.innerHTML = `
      <div class="space-y-4 text-xs text-slate-300 leading-relaxed">
        <div>
          <h4 class="font-bold text-white text-sm">Ejercicio de Derechos ARCO (Ley 25.326 Art. 16)</h4>
          <p class="mt-1">Conforme a la normativa nacional, todo ciudadano tiene derecho a que sean rectificados, actualizados o suprimidos sus datos cuando fueren erróneos, inexactos o desactualizados.</p>
        </div>

        <div class="bg-slate-950/80 border border-slate-800 p-4 rounded-xl space-y-2">
          <h5 class="font-bold text-white">Procedimiento Inmediato en INQUILIA:</h5>
          <ol class="list-decimal pl-5 space-y-1.5 text-slate-300">
            <li>Ingresá con tu cuenta al menú <b>Contratos</b>.</li>
            <li>Ubicá el legajo correspondiente y presioná <b>'Rectificar Antecedente'</b>.</li>
            <li>Ingresá tu declaración o adjuntá la constancia de cancelación.</li>
            <li>La plataforma asentará un <b>bloqueo cautelar</b> sobre la anotación cuestionada mientras transcurre el plazo legal perentorio de <b>5 días hábiles</b> para su resolución definitiva.</li>
          </ol>
        </div>

        <div class="p-3 bg-[#16c2a3]/10 border border-[#16c2a3]/20 rounded-xl text-[11px] text-slate-300">
          <b>Plazos legales de resolución:</b> Diez (10) días corridos para pedidos de acceso informativo integral y cinco (5) días hábiles para subsanaciones, rectificaciones o supresiones documentales (Arts. 14 y 16 Ley 25.326).
        </div>
      </div>
    `;
  }

  modal.classList.remove('hidden');
};

window.cerrarModalLegal = function() {
  const modal = document.getElementById('modal-legal');
  if (modal) modal.classList.add('hidden');
};

// ============================================================================
// BOTÓN DE ARREPENTIMIENTO / BAJA DE SERVICIO (LEY 24.240)
// ============================================================================
window.abrirModalBaja = function() {
  const modal = document.getElementById('modal-baja');
  if (modal) modal.classList.remove('hidden');
};

window.cerrarModalBaja = function() {
  const modal = document.getElementById('modal-baja');
  if (modal) modal.classList.add('hidden');
};

document.addEventListener("DOMContentLoaded", () => {
  const formBaja = document.getElementById('form-baja');
  if (formBaja) {
    formBaja.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('btn-submit-baja');
      const originalText = btn.innerText;
      btn.innerText = "Procesando Baja...";
      btn.disabled = true;

      try {
        const dni = document.getElementById('baja-dni').value.replace(/\D/g, "");
        const email = document.getElementById('baja-email').value.trim();
        
        const { getFunctions, httpsCallable } = await import("firebase/functions");
        const functions = getFunctions();
        const solicitarBajaServicio = httpsCallable(functions, 'solicitarBajaServicio');
        
        const res = await solicitarBajaServicio({ dni, email });
        
        alert(res.data.message || "Solicitud procesada correctamente.");
        cerrarModalBaja();
        formBaja.reset();
      } catch (error) {
        alert("Atención: " + (error.message || "No se pudo procesar la baja automáticamente. Intentá más tarde."));
      } finally {
        btn.innerText = originalText;
        btn.disabled = false;
      }
    });
  }
});

// ============================================================================
// LÓGICA DE CÓDIGOS PROMOCIONALES (FRONTEND)
// ============================================================================
let appliedPromoCode = null;

window.validarCodigoPromo = async function() {
  const inputEl = document.getElementById('promo-code-input');
  const btnEl = document.getElementById('btn-apply-promo');
  const msgEl = document.getElementById('promo-status-msg');
  
  if (!inputEl) return;
  const code = inputEl.value.trim().toUpperCase();

  if (!code) {
    if (msgEl) {
      msgEl.innerText = "Ingresá un código primero.";
      msgEl.className = "absolute -bottom-6 left-0 w-full text-center text-[9px] font-bold text-rose-400 mt-1 block";
      msgEl.classList.remove('hidden');
    }
    return;
  }

  if (btnEl) {
    btnEl.innerText = "...";
    btnEl.disabled = true;
  }
  if (msgEl) msgEl.classList.add('hidden');

  try {
    // Guardamos el código ingresado para enviarlo al momento de procesar el pago o bypass
    appliedPromoCode = code;

    if (msgEl) {
      msgEl.innerText = `✓ Código "${code}" aplicado. Seleccioná tu plan.`;
      msgEl.className = "absolute -bottom-6 left-0 w-full text-center text-[10px] font-black text-emerald-400 mt-1 block";
      msgEl.classList.remove('hidden');
    }
    if (inputEl) {
      inputEl.classList.add('border-emerald-500/50', 'bg-emerald-950/20');
    }
    if (btnEl) btnEl.innerText = "OK";

  } catch (error) {
    console.error("Error al validar código:", error);
  } finally {
    if (btnEl && btnEl.innerText === "...") {
      btnEl.innerText = "Aplicar";
    }
    if (btnEl) btnEl.disabled = false;
  }
};