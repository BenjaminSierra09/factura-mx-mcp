(() => {
  'use strict';

  const state = {
    me: null,
    csrfToken: '',
    profile: null,
    portals: [],
    fiscalCatalogs: null,
    tickets: [],
    jobs: [],
    jobsLoaded: false,
    tokens: [],
    selectedTicketId: '',
    selectedJobId: '',
    selectedJobStatus: '',
    selectedJob: null,
    panel: ['overview', 'new-ticket', 'jobs', 'profile', 'mcp'].includes(new URLSearchParams(location.search).get('panel'))
      ? new URLSearchParams(location.search).get('panel') : 'overview',
    registerMode: false,
    registrationEnabled: true,
    recaptchaSiteKey: null,
    recaptchaReady: false,
    recaptchaConfigLoaded: false,
    recaptchaConfigError: false,
    recaptchaWidgets: { login: null, register: null },
    toastTimer: null,
    fieldEdits: new Map(),
    paymentSuggestions: new Map(),
    paymentHints: new Map(),
    paymentEdits: new Map(),
    pendingAutoTicketId: '',
    autoReviewReason: '',
    urlEdits: new Map(),
    providerEdits: new Map(),
    exploring: new Set(),
    explorationErrors: new Map(),
    explorationAttempted: new Set(),
    discoveryAttempted: new Set(),
    discovering: new Set(),
    selectedTicketFile: null,
    ticketPreviewUrl: null,
    installPrompt: null,
    serviceWorkerRegistration: null,
    reloadingForUpdate: false,
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
  const safeHttpsUrl = value => {
    try {
      const url = new URL(String(value || ''));
      return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
    } catch { return null; }
  };
  const usableEmail = value => typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
  const friendlyDate = value => value ? new Intl.DateTimeFormat('es-MX', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(value) ? `${value.replace(' ', 'T')}Z` : value)) : '—';
  const statusText = {
    queued: 'En espera', running: 'En proceso', needs_action: 'Acción pendiente',
    submitted: 'Solicitud enviada', completed: 'Factura lista', email_sent: 'Correo enviado', failed: 'No se completó',
  };

  async function api(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const headers = { ...(options.headers || {}) };
    if (method !== 'GET' && method !== 'HEAD' && state.csrfToken && !['/api/auth/login', '/api/auth/register'].includes(path)) headers['X-CSRF-Token'] = state.csrfToken;
    if (options.body && !(options.body instanceof FormData) && typeof options.body !== 'string') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(options.body);
    }
    let response;
    try { response = await fetch(path, { ...options, headers, credentials: 'same-origin' }); }
    catch {
      throw new Error(navigator.onLine === false
        ? 'Sin conexión. Recupera internet antes de continuar.'
        : 'No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.');
    }
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.text();
    if (!response.ok) {
      const error = new Error(typeof data === 'object' && data ? data.error || data.message || `Error ${response.status}` : `Error ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function notify(message, type = 'success') {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.toggle('error', type === 'error');
    toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toast.hidden = true; }, 5300);
  }

  function isStandalone() {
    return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  }

  function updateConnectionStatus() {
    $('#connection-banner').hidden = navigator.onLine !== false;
  }

  function showInstallHelp() {
    const hint = $('#pwa-install-help');
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    hint.textContent = isIos
      ? 'En Safari, toca Compartir y luego «Agregar a pantalla de inicio». Después abre Factura Clara desde su icono.'
      : 'Abre el menú de tu navegador y elige «Instalar aplicación» o «Agregar a pantalla de inicio». También puedes seguir usándola en esta pestaña.';
    hint.hidden = false;
  }

  async function installApp() {
    if (!state.installPrompt) { showInstallHelp(); return; }
    const prompt = state.installPrompt;
    state.installPrompt = null;
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') $('#pwa-install-card').hidden = true;
      else showInstallHelp();
    } catch { showInstallHelp(); }
  }

  function showPwaUpdate(registration) {
    if (!registration.waiting || !navigator.serviceWorker.controller) return;
    state.serviceWorkerRegistration = registration;
    $('#update-banner').hidden = false;
  }

  async function registerPwa() {
    updateConnectionStatus();
    if (isStandalone()) $('#pwa-install-card').hidden = true;
    window.addEventListener('online', () => {
      updateConnectionStatus();
      if (state.me) void refreshJobsOnResume();
    });
    window.addEventListener('offline', updateConnectionStatus);
    window.addEventListener('beforeinstallprompt', event => {
      event.preventDefault();
      state.installPrompt = event;
      $('#pwa-install-help').hidden = true;
    });
    window.addEventListener('appinstalled', () => {
      state.installPrompt = null;
      $('#pwa-install-card').hidden = true;
    });
    if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
    try {
      const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      state.serviceWorkerRegistration = registration;
      showPwaUpdate(registration);
      registration.addEventListener('updatefound', () => {
        const worker = registration.installing;
        worker?.addEventListener('statechange', () => {
          if (worker.state === 'installed') showPwaUpdate(registration);
        });
      });
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (state.reloadingForUpdate) location.reload();
      });
    } catch {
      // The web app remains usable when the browser does not allow installation.
    }
  }

  async function refreshJobsOnResume() {
    if (!state.me || document.hidden || navigator.onLine === false) return;
    await loadJobs();
    if (state.panel === 'jobs' && state.selectedJobId &&
        !document.activeElement?.closest?.('#challenge-section')) {
      await loadJobDetail(state.selectedJobId);
    }
  }

  async function withPending(button, work) {
    if (button?.disabled) return;
    const label = button?.innerHTML;
    if (button) { button.disabled = true; button.textContent = 'Procesando…'; }
    try { return await work(); }
    catch (error) { notify(error.message || 'No se pudo completar la acción.', 'error'); throw error; }
    finally { if (button) { button.disabled = false; button.innerHTML = label; } }
  }

  function showAuth() {
    $('#auth-view').hidden = false;
    $('#app-view').hidden = true;
    setAuthMode(false);
    $('#auth-email').focus();
  }

  function showApp() {
    $('#auth-view').hidden = true;
    $('#app-view').hidden = false;
    $('#account-email').textContent = state.me.email;
    $('.account-avatar').textContent = state.me.email.slice(0, 1).toUpperCase();
    $('#mcp-endpoint').textContent = `${location.origin}/mcp`;
    renderMcpGuide();
    showPanel(state.panel);
  }

  function setAuthMode(register) {
    state.registerMode = register && state.registrationEnabled;
    register = state.registerMode;
    $('#auth-title').textContent = register ? 'Crea tu cuenta' : 'Inicia sesión';
    $('#auth-subtitle').textContent = register ? 'Tus datos fiscales quedarán en tu espacio privado.' : 'Accede a tus tickets, facturas y datos fiscales.';
    $('#auth-submit').textContent = register ? 'Crear cuenta' : 'Entrar';
    $('#auth-switch-label').textContent = register ? '¿Ya tienes cuenta?' : '¿Aún no tienes cuenta?';
    $('#auth-toggle').textContent = register ? 'Iniciar sesión' : 'Crear cuenta';
    $('#confirm-password-wrap').hidden = !register;
    $('#auth-password').autocomplete = register ? 'new-password' : 'current-password';
    $('#auth-confirm').required = register;
    $('#auth-error').hidden = true;
    syncRecaptcha();
  }

  function showAuthError(message) {
    const errorBox = $('#auth-error');
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function syncRecaptcha() {
    const mode = state.registerMode ? 'register' : 'login';
    for (const name of ['login', 'register']) {
      const container = $(`#${name}-recaptcha`);
      if (container) container.hidden = !state.recaptchaSiteKey || name !== mode;
    }
    if (!state.recaptchaSiteKey || !state.recaptchaReady || $('#auth-view').hidden) return;
    if (state.recaptchaWidgets[mode] !== null) return;
    const container = $(`#${mode}-recaptcha`);
    if (!container || !window.grecaptcha?.render) return;
    try {
      state.recaptchaWidgets[mode] = window.grecaptcha.render(container, {
        sitekey: state.recaptchaSiteKey,
        theme: 'light',
        size: window.innerWidth < 360 ? 'compact' : 'normal',
        'expired-callback': () => { if ((state.registerMode ? 'register' : 'login') === mode) showAuthError('La verificación expiró. Marca la casilla otra vez.'); },
        'error-callback': () => { if ((state.registerMode ? 'register' : 'login') === mode) showAuthError('No se pudo cargar la verificación. Revisa tu conexión e inténtalo de nuevo.'); },
      });
    } catch {
      showAuthError('No se pudo cargar la verificación. Recarga la página e inténtalo de nuevo.');
    }
  }

  async function loadAuthConfiguration() {
    try {
      const config = await api('/api/config');
      state.registrationEnabled = config.registrationEnabled !== false;
      $('.auth-switch').hidden = !state.registrationEnabled;
      if (!state.registrationEnabled && state.registerMode) setAuthMode(false);
      state.recaptchaSiteKey = typeof config.recaptchaSiteKey === 'string' && config.recaptchaSiteKey ? config.recaptchaSiteKey : null;
      if (state.recaptchaSiteKey) {
        window.facturaRecaptchaReady = () => {
          state.recaptchaReady = true;
          syncRecaptcha();
        };
        const script = document.createElement('script');
        script.src = 'https://www.google.com/recaptcha/api.js?onload=facturaRecaptchaReady&render=explicit&hl=es-419';
        script.async = true;
        script.defer = true;
        script.onerror = () => showAuthError('No se pudo cargar la verificación. Revisa tu conexión e inténtalo de nuevo.');
        document.head.append(script);
      }
    } catch {
      state.recaptchaConfigError = true;
      showAuthError('No se pudo preparar el inicio de sesión. Recarga la página e inténtalo de nuevo.');
    } finally {
      state.recaptchaConfigLoaded = true;
      syncRecaptcha();
    }
  }

  async function handleAuth(event) {
    event.preventDefault();
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    const errorBox = $('#auth-error');
    errorBox.hidden = true;
    if (!$('#auth-form').reportValidity()) return;
    if (!state.recaptchaConfigLoaded || state.recaptchaConfigError) {
      showAuthError('No se pudo preparar el inicio de sesión. Recarga la página e inténtalo de nuevo.');
      return;
    }
    if (state.registerMode && password !== $('#auth-confirm').value) {
      showAuthError('Las contraseñas no coinciden.');
      $('#auth-confirm').focus();
      return;
    }
    const mode = state.registerMode ? 'register' : 'login';
    const widgetId = state.recaptchaWidgets[mode];
    let recaptchaToken;
    if (state.recaptchaSiteKey) {
      if (!state.recaptchaReady || widgetId === null || !window.grecaptcha?.getResponse) {
        showAuthError('La verificación aún no está lista. Espera un momento o recarga la página.');
        return;
      }
      recaptchaToken = window.grecaptcha.getResponse(widgetId);
      if (!recaptchaToken) {
        showAuthError('Marca la casilla «No soy un robot» para continuar.');
        return;
      }
    }
    try {
      await withPending($('#auth-submit'), async () => {
        await api(`/api/auth/${mode}`, { method: 'POST', body: { email, password, ...(recaptchaToken ? { recaptchaToken } : {}) } });
        $('#auth-form').reset();
        await initializeSession();
      });
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      if (widgetId !== null && window.grecaptcha?.reset) window.grecaptcha.reset(widgetId);
    }
  }

  async function initializeSession() {
    try {
      const me = await api('/api/me');
      state.me = me.user || me;
      state.csrfToken = me.csrfToken;
      showApp();
      const [profile, tickets, jobs, portals, fiscalCatalogs] = await Promise.all([
        api('/api/profile'), api('/api/tickets'), api('/api/jobs'),
        api('/api/portals').catch(() => []),
        api('/api/fiscal-catalogs').catch(() => null),
      ]);
      state.profile = profile.profile || profile;
      state.tickets = tickets.tickets || tickets;
      state.jobs = jobs.jobs || jobs;
      state.jobsLoaded = true;
      state.portals = Array.isArray(portals) ? portals : portals.portals || [];
      state.fiscalCatalogs = fiscalCatalogs;
      renderProviderOptions();
      renderProfile();
      renderTickets();
      renderJobs();
      renderOverview();
      if (!fiscalCatalogs) notify('No pudimos cargar el catálogo fiscal. Recarga la página antes de guardar el perfil.', 'error');
    } catch (error) {
      if (error.status === 401) { state.me = null; state.csrfToken = ''; showAuth(); }
      else { notify(error.message || 'No se pudieron cargar tus datos.', 'error'); }
    }
  }

  function showPanel(name) {
    state.panel = name;
    $$('.panel').forEach(panel => { panel.hidden = panel.id !== `panel-${name}`; });
    $$('[data-panel]').forEach(button => {
      const active = button.dataset.panel === name;
      button.classList.toggle('active', active);
      if (active) button.setAttribute('aria-current', 'page');
      else button.removeAttribute('aria-current');
    });
    const titles = { overview: 'Resumen', 'new-ticket': 'Nuevo ticket', jobs: 'Mis facturas', profile: 'Perfil fiscal', mcp: 'Conectar MCP' };
    $('#topbar-title').textContent = titles[name] || 'Resumen';
    if (name === 'jobs') void loadJobs();
    if (name === 'mcp') void loadTokens();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function renderOverview() {
    $('#stat-tickets').textContent = state.tickets.length;
    $('#stat-completed').textContent = state.jobs.filter(job => job.status === 'completed').length;
    $('#stat-pending').textContent = state.jobs.filter(job => ['needs_action', 'submitted', 'email_sent', 'failed'].includes(job.status)).length;
    const recent = state.jobs.slice(0, 4);
    $('#recent-jobs').innerHTML = recent.length ? recent.map(job => `
      <div class="recent-item"><div class="recent-item-main"><span class="recent-icon" aria-hidden="true">▤</span><span><strong>${escapeHtml(jobTitle(job))}</strong><small>${escapeHtml(friendlyDate(job.createdAt))}</small></span></div><span class="pill pill-${escapeHtml(job.status)}">${escapeHtml(statusText[job.status] || job.status)}</span></div>
    `).join('') : '<p class="empty-inline">Todavía no hay trámites. Carga tu primer ticket para comenzar.</p>';
  }

  function setCatalogOptions(select, entries, current, placeholder) {
    select.innerHTML = `<option value="">${escapeHtml(placeholder)}</option>` + entries.map(item =>
      `<option value="${escapeHtml(item.codigo)}">${escapeHtml(item.codigo)} · ${escapeHtml(item.nombre)}</option>`).join('');
    select.value = entries.some(item => item.codigo === current) ? current : '';
  }

  function renderFiscalSelects(regimen = $('#profile-regimen').value, uso = $('#profile-uso').value) {
    const catalogs = state.fiscalCatalogs;
    if (!catalogs) return;
    const rfc = $('#profile-rfc').value.trim().toUpperCase();
    const persona = rfc.length === 12 ? 'moral' : rfc.length === 13 ? 'fisica' : null;
    const regimenes = catalogs.regimenes.filter(item => !persona || item.personas === 'ambas' || item.personas === persona);
    setCatalogOptions($('#profile-regimen'), regimenes, regimen, 'Selecciona tu régimen');
    const selectedRegimen = $('#profile-regimen').value;
    const usos = catalogs.usosCfdi.filter(item => selectedRegimen && item.regimenes.includes(selectedRegimen) &&
      (!persona || item.personas === 'ambas' || item.personas === persona));
    setCatalogOptions($('#profile-uso'), usos, uso, selectedRegimen ? 'Selecciona el uso CFDI' : 'Elige primero tu régimen');
    $('#profile-uso').disabled = !selectedRegimen;
    $('#profile-regimen-hint').textContent = regimen && !regimenes.some(item => item.codigo === regimen)
      ? 'El régimen guardado ya no es compatible con este RFC o no está vigente. Selecciona otro.'
      : 'Mostramos los regímenes vigentes compatibles con tu RFC.';
    $('#profile-uso-hint').textContent = uso && selectedRegimen && !usos.some(item => item.codigo === uso)
      ? 'El uso guardado no corresponde a este régimen. Selecciona uno compatible.'
      : 'Las opciones se ajustan al régimen elegido.';
  }

  function renderPaymentOptions(ticket) {
    const select = $('#job-forma-pago');
    const options = state.fiscalCatalogs?.formasPago || [];
    const printed = ticket?.analysis?.formaPagoSugerida;
    const supplied = ticket?.analysis?.formaPagoUsuario;
    const conflict = printed?.confianza === 'alta' && supplied?.confianza === 'alta' &&
      printed.codigo !== supplied.codigo && !supplied.confirmada;
    let suggestion = null;
    if (ticket && !conflict) {
      const preferred = supplied?.confirmada || (supplied && printed?.confianza !== 'alta')
        ? supplied : printed || supplied;
      suggestion = state.paymentSuggestions.get(ticket.id) || preferred || null;
    }
    const selected = ticket && state.paymentEdits.has(ticket.id) ? state.paymentEdits.get(ticket.id)
      : suggestion?.confianza === 'alta' ? suggestion.codigo : '';
    setCatalogOptions(select, options, selected, 'Elegir según el ticket');
    const note = $('#ticket-payment-suggestion');
    note.hidden = !suggestion && !conflict;
    if (conflict) note.textContent = `Hay dos señales de pago distintas: ${printed.codigo} en el ticket y ${supplied.codigo} en tu información adicional. Confirma la correcta antes de continuar.`;
    else if (suggestion) {
      const label = options.find(item => item.codigo === suggestion.codigo)?.nombre || suggestion.codigo;
      note.textContent = `Forma de pago sugerida: ${suggestion.codigo} · ${label}. ${suggestion.evidencia || 'Revisa el ticket para confirmarla.'}`;
    }
    $('#job-payment-help').textContent = conflict
      ? 'El ticket y tu nota se contradicen. Selecciona la forma correcta.'
      : suggestion
      ? `Sugerimos ${suggestion.codigo} por: ${suggestion.evidencia}. Puedes corregirlo aquí antes de reintentar.`
      : 'Elige la forma de pago sólo si el ticket o tu información adicional la confirman.';
  }

  function renderProfile() {
    const p = state.profile || {};
    $('#profile-rfc').value = p.rfc || '';
    $('#profile-cp').value = p.codigoPostal || '';
    $('#profile-name').value = p.nombre || '';
    renderFiscalSelects(p.regimenFiscal || '', p.usoCfdi || '');
    $('#profile-email').value = p.facturaEmail || '';
    $('#profile-address').value = p.domicilio || '';
    $('#csf-status').textContent = p.hasCsf ? 'Constancia guardada' : 'Sin archivo';
    $('#delete-csf').hidden = !p.hasCsf;
    $('#api-key-status').textContent = p.hasOpenAiKey ? 'Clave guardada' : 'Sin clave';
    $('#smtp-host').value = p.smtp?.host || '';
    $('#smtp-port').value = p.smtp?.port || 587;
    $('#smtp-user').value = p.smtp?.user || '';
    $('#smtp-from').value = p.smtp?.from || '';
    $('#smtp-secure').checked = Boolean(p.smtp?.secure);
    $('#smtp-password').placeholder = p.smtp?.hasPassword ? 'Contraseña guardada' : 'Contraseña o clave de aplicación';
  }

  async function saveFiscalProfile(event) {
    event.preventDefault();
    if (!$('#profile-form').reportValidity()) return;
    const body = {
      rfc: $('#profile-rfc').value.trim().toUpperCase(),
      nombre: $('#profile-name').value.trim().toUpperCase(),
      codigoPostal: $('#profile-cp').value.trim(),
      regimenFiscal: $('#profile-regimen').value.trim(),
      usoCfdi: $('#profile-uso').value.trim().toUpperCase(),
      facturaEmail: $('#profile-email').value.trim(),
      domicilio: $('#profile-address').value.trim(),
    };
    try {
      await withPending($('#profile-form button[type=submit]'), async () => {
        const response = await api('/api/profile', { method: 'PUT', body });
        state.profile = response.profile || response;
        renderProfile();
        $('#profile-save-status').textContent = 'Guardado';
        notify('Perfil fiscal guardado.');
      });
      if (state.pendingAutoTicketId) void startAutoInvoice(state.pendingAutoTicketId);
    } catch { /* toast from withPending */ }
  }

  async function uploadCsf(event) {
    event.preventDefault();
    const file = $('#csf-file').files[0];
    if (!file) { notify('Elige una constancia.', 'error'); return; }
    const data = new FormData(); data.append('file', file);
    try {
      await withPending($('#csf-form button[type=submit]'), async () => {
        const response = await api('/api/csf', { method: 'POST', body: data });
        state.profile = response.profile || state.profile;
        renderProfile();
        const fields = ['rfc', 'nombre', 'codigoPostal', 'regimenFiscal'].filter(key => response.analysis?.[key]);
        $('#csf-result').textContent = fields.length ? `Leímos ${fields.length} datos de la constancia. Revisa el perfil antes de facturar.` : 'Constancia guardada. No se detectaron suficientes datos; llena el perfil manualmente.';
        $('#csf-file').value = '';
        $('#csf-file-name').textContent = '';
        notify('Constancia guardada.');
      });
    } catch { /* toast from withPending */ }
  }

  async function deleteCsf() {
    if (!window.confirm('¿Eliminar la constancia guardada? Los trabajos ya iniciados conservarán su copia temporal si la necesitan.')) return;
    try {
      state.profile = await api('/api/csf', { method: 'DELETE' });
      renderProfile();
      $('#csf-result').textContent = 'Constancia eliminada.';
      notify('Constancia eliminada.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function saveApiKey(event) {
    event.preventDefault();
    const key = $('#openai-key').value.trim();
    if (!key) { notify('Escribe una clave de OpenAI.', 'error'); return; }
    try {
      await withPending($('#api-form button[type=submit]'), async () => {
        const response = await api('/api/profile', { method: 'PUT', body: { openAiKey: key } });
        state.profile = response.profile || response;
        $('#openai-key').value = '';
        renderProfile();
        notify('Clave de OpenAI guardada.');
      });
    } catch { /* toast from withPending */ }
  }

  async function saveSmtp(event) {
    event.preventDefault();
    const smtp = {
      host: $('#smtp-host').value.trim(), port: Number($('#smtp-port').value),
      secure: $('#smtp-secure').checked, user: $('#smtp-user').value.trim(),
      from: $('#smtp-from').value.trim(),
    };
    const password = $('#smtp-password').value;
    if (password) smtp.password = password;
    try {
      await withPending($('#smtp-form button[type=submit]'), async () => {
        const response = await api('/api/profile', { method: 'PUT', body: { smtp } });
        state.profile = response.profile || response;
        $('#smtp-password').value = '';
        renderProfile();
        $('#smtp-save-status').textContent = 'Guardado';
        notify('Correo saliente guardado.');
      });
    } catch { /* toast from withPending */ }
  }

  function renderTickets() {
    const select = $('#job-ticket');
    const previous = state.selectedTicketId || select.value;
    select.innerHTML = '<option value="">Elige un ticket cargado</option>' + state.tickets.map(ticket => {
      const name = ticket.analysis?.empresa || ticket.filename || `Ticket ${ticket.id.slice(0, 8)}`;
      return `<option value="${escapeHtml(ticket.id)}">${escapeHtml(name)} · ${escapeHtml(friendlyDate(ticket.createdAt))}</option>`;
    }).join('');
    if (state.tickets.some(ticket => ticket.id === previous)) select.value = previous;
    else if (state.tickets.length) select.value = state.tickets[0].id;
    state.selectedTicketId = select.value;
    renderTicketAnalysis();
  }

  function currentTicket() {
    return state.tickets.find(item => item.id === state.selectedTicketId);
  }

  function portalDefinition(id) {
    return state.portals.find(portal => portal.id === id);
  }

  function renderProviderOptions() {
    const select = $('#job-provider');
    const previous = select.value;
    const known = state.portals.filter(portal => portal.id !== 'generic');
    select.innerHTML = '<option value="auto">Elegir desde el ticket</option>'
      + known.map(portal => `<option value="${escapeHtml(portal.id)}">${escapeHtml(portal.label)}</option>`).join('')
      + '<option value="generic">Otro emisor</option>';
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }

  function suggestedPortalUrl(ticket) {
    const d = ticket?.discovery;
    const detection = ticket?.detection || {};
    const a = ticket?.analysis || {};
    return [d?.selected?.url, detection.portalUrl, detection.candidateUrl, a.qrUrl, a.url]
      .map(safeHttpsUrl).find(Boolean) || '';
  }

  function reviewedPortalUrl(ticket) {
    const discoveryUrl = safeHttpsUrl(ticket?.discovery?.selected?.url);
    const known = portalDefinition(ticket?.detection?.provider);
    const knownUrl = known && known.id !== 'generic' ? safeHttpsUrl(ticket?.detection?.portalUrl) : null;
    return discoveryUrl || knownUrl || '';
  }

  function suggestedProvider(ticket) {
    const detected = ticket?.detection?.provider;
    return portalDefinition(detected) && detected !== 'generic' ? detected : 'auto';
  }

  function replaceTicket(ticket) {
    if (!ticket?.id) return;
    const index = state.tickets.findIndex(item => item.id === ticket.id);
    if (index >= 0) state.tickets[index] = ticket;
    else state.tickets.unshift(ticket);
    state.selectedTicketId = ticket.id;
    renderTickets();
  }

  function portalLink(url, label) {
    const safe = safeHttpsUrl(url);
    return safe ? `<a href="${escapeHtml(safe)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label || safe)} <span aria-hidden="true">↗</span></a>` : '';
  }

  function renderPortalReview(ticket) {
    const discovery = ticket.discovery || {};
    const selected = discovery.selected;
    const detection = ticket.detection || {};
    const known = portalDefinition(detection.provider);
    const url = suggestedPortalUrl(ticket);
    const reviewed = reviewedPortalUrl(ticket);
    let heading = 'Busca el sitio del emisor';
    let detail = 'Indica el nombre que aparece en el ticket o escribe una URL HTTPS verificada abajo.';
    let source = '';
    if (selected) {
      heading = selected.title || discovery.issuer || ticket.analysis?.empresa || 'Portal encontrado';
      detail = selected.reason || 'Portal propuesto después de buscar al emisor.';
      source = portalLink(selected.sourceUrl, 'Ver fuente de la sugerencia');
    } else if (known && known.id !== 'generic') {
      heading = known.label;
      detail = detection.reasons?.join(' ') || 'Portal del emisor reconocido en el ticket.';
      source = portalLink(known.sourceUrl, 'Ver página oficial');
    } else if (url) {
      heading = ticket.analysis?.empresa || 'URL encontrada en el ticket';
      detail = discovery.reason || 'Comprueba que esta dirección corresponda al emisor antes de usarla.';
    } else if (discovery.reason) detail = discovery.reason;
    if (state.discovering.has(ticket.id) && !url) {
      heading = 'Buscando el portal del emisor…';
      detail = 'Revisamos la dirección antes de proponerla.';
    }
    const candidates = (Array.isArray(discovery.candidates) ? discovery.candidates : [])
      .filter(candidate => safeHttpsUrl(candidate.url) && candidate.url !== selected?.url)
      .slice(0, 3).map(candidate => `<li><span><strong>${escapeHtml(candidate.title || candidate.url)}</strong>${candidate.reason ? `<small>${escapeHtml(candidate.reason)}</small>` : ''}${candidate.sourceUrl ? `<small>${portalLink(candidate.sourceUrl, 'Referencia para revisar')}</small>` : ''}</span>${portalLink(candidate.url, 'Abrir')}<button type="button" class="text-button" data-use-portal="${escapeHtml(candidate.url)}">Usar URL</button></li>`).join('');
    const reviewButton = url && !reviewed ? `<button type="button" class="text-button" data-use-portal="${escapeHtml(url)}">Usar esta URL tras revisarla</button>` : '';
    $('#portal-suggestion').innerHTML = `<div class="portal-suggestion-main"><strong>${escapeHtml(heading)}</strong><p>${escapeHtml(detail)}</p>${url ? portalLink(url, url) : ''}${reviewButton}${source ? `<small>Referencia: ${source}</small>` : ''}</div>${candidates ? `<details><summary>Otras direcciones encontradas</summary><ul class="portal-candidates">${candidates}</ul></details>` : ''}`;
    $('#portal-issuer').value = discovery.issuer || ticket.analysis?.empresa || '';
    renderPortalExploration(ticket);
  }

  function renderPortalExploration(ticket) {
    const panel = $('#portal-exploration');
    if (state.exploring.has(ticket.id)) {
      panel.innerHTML = '<p class="small-muted">Explorando los campos visibles del portal…</p>';
      return;
    }
    const exploration = ticket.exploration;
    if (exploration) {
      const observed = Array.isArray(exploration.fields) ? exploration.fields : [];
      const fields = observed
        .map(field => `<li><strong>${escapeHtml(field.label)}</strong>${field.required ? ' · obligatorio' : ''}${field.type ? ` · ${escapeHtml(field.type)}` : ''}</li>`).join('');
      const notes = Array.isArray(exploration.notes) ? exploration.notes.join(' ') : exploration.notes;
      const loginNote = observed.some(field => credentialPortalField(field.label))
        ? '<p>Esta página también muestra campos de acceso. No se guardarán como datos del ticket.</p>' : '';
      const contacts = (Array.isArray(exploration.contactEmails) ? exploration.contactEmails : [])
        .filter(contact => usableEmail(contact?.address)).slice(0, 5)
        .map(contact => `<li><span><strong>${escapeHtml(contact.address)}</strong>${contact.label ? `<small>${escapeHtml(contact.label)}</small>` : ''}</span><button type="button" class="text-button" data-use-email="${escapeHtml(contact.address)}">Usar dirección</button></li>`).join('');
      panel.innerHTML = `<div class="exploration-result"><h4>Campos observados en el portal</h4>${fields ? `<ul>${fields}</ul>` : '<p>Aún no se pudieron identificar campos visibles.</p>'}${loginNote}${notes ? `<p>${escapeHtml(notes)}</p>` : ''}${contacts ? `<div class="exploration-contacts"><h4>Posibles contactos por correo</h4><p>Revisa si alguna de estas direcciones recibe solicitudes de facturación antes de usarla.</p><ul>${contacts}</ul></div>` : ''}<button type="button" class="text-button" data-explore-portal>Explorar de nuevo</button></div>`;
    } else if (suggestedPortalUrl(ticket) || $('#job-url').value) {
      const error = state.explorationErrors.get(ticket.id);
      panel.innerHTML = `${error ? `<p class="small-muted">${escapeHtml(error)}</p>` : ''}<button type="button" class="text-button" data-explore-portal>Explorar los campos del portal</button>`;
    } else panel.textContent = '';
  }

  function renderTicketAnalysis() {
    const ticket = currentTicket();
    $('#ticket-analysis-card').hidden = !ticket;
    if (!ticket) { $('#job-ticket-fields').innerHTML = ''; $('#ticket-payment-suggestion').hidden = true; return; }
    const a = ticket.analysis || {};
    const fields = [
      ['Empresa', a.empresa], ['Folio', a.folio], ['Fecha', a.fecha],
      ['Monto', a.monto != null ? new Intl.NumberFormat('es-MX', { style: 'currency', currency: 'MXN' }).format(a.monto) : null],
      ['Referencia', a.referencia], ['Número de ticket', a.numeroTicket], ['Número de tienda', a.numeroTienda],
      ['Marca', a.marca], ['QR o URL', a.qrUrl || a.url],
    ];
    $('#ticket-analysis').innerHTML = fields.filter(([label, value]) => value != null && value !== '' || ['Empresa', 'Folio', 'Fecha'].includes(label))
      .map(([label, value]) => `<div class="analysis-item ${label === 'QR o URL' ? 'full-span' : ''}"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? 'No detectado')}</strong></div>`).join('');
    const detected = [a.empresa, a.folio, a.fecha, a.monto, a.referencia, a.qrUrl, a.url].some(value => value != null && value !== '');
    $('#ticket-analysis-card .inline-note').textContent = detected
      ? 'La lectura del ticket puede ser imprecisa. Si falta algo, te pediremos corregirlo.'
      : 'No pudimos leer suficientes datos. Puedes subir una imagen más clara o completar los campos que te pidamos.';
    const provider = state.providerEdits.get(ticket.id) || suggestedProvider(ticket);
    $('#job-provider').value = [...$('#job-provider').options].some(option => option.value === provider) ? provider : 'auto';
    $('#job-url').value = state.urlEdits.has(ticket.id) ? state.urlEdits.get(ticket.id) : reviewedPortalUrl(ticket);
    renderPortalReview(ticket);
    updateJobOptions();
    renderPaymentOptions(ticket);
    const job = state.jobs.find(item => item.ticketId === ticket.id);
    const paymentConflict = a.formaPagoSugerida?.confianza === 'alta' && a.formaPagoUsuario?.confianza === 'alta' &&
      a.formaPagoSugerida.codigo !== a.formaPagoUsuario.codigo && !a.formaPagoUsuario.confirmada;
    if (!job) {
      state.pendingAutoTicketId = ticket.id;
      showInvoiceReview(paymentConflict ? 'payment' : 'other', paymentConflict
        ? 'El ticket y tu información adicional indican formas de pago distintas. Confirma cuál aparece en el comprobante.'
        : 'Este ticket aún no tiene un trámite iniciado. Reintenta la detección automática cuando estés listo.');
    } else if (job.status === 'failed') {
      state.pendingAutoTicketId = ticket.id;
      showInvoiceReview('other', 'El trámite anterior no se completó. Revisa el resultado antes de volver a intentarlo.');
    } else if (state.pendingAutoTicketId !== ticket.id) {
      $('#invoice-review-card').hidden = true;
    }
  }

  async function discoverTicket(event) {
    event.preventDefault();
    const ticket = currentTicket();
    const issuer = $('#portal-issuer').value.trim();
    if (!ticket || !issuer) { notify('Escribe el emisor que aparece en el ticket.', 'error'); return; }
    await runDiscovery(ticket, issuer, $('#portal-discover-button'), false);
  }

  async function runDiscovery(ticket, issuer, button, automatic) {
    if (state.discovering.has(ticket.id)) return;
    state.discovering.add(ticket.id);
    state.discoveryAttempted.add(ticket.id);
    if (currentTicket()?.id === ticket.id) renderPortalReview(ticket);
    try {
      const work = async () => {
        const response = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/discover`, { method: 'POST', body: { issuer } });
        replaceTicket(response.ticket || response);
        if (state.pendingAutoTicketId === ticket.id && currentTicket()?.discovery?.selected) void startAutoInvoice(ticket.id);
        if (!automatic) {
          if (currentTicket()?.discovery?.selected) notify('Encontramos una dirección candidata. Comprueba la fuente.');
          else notify('No encontramos un portal verificado. Puedes escribir la dirección oficial.', 'error');
        }
      };
      if (button) await withPending(button, work);
      else await work();
    } catch (error) {
      if (!automatic && !button) notify(error.message || 'No se pudo buscar el portal.', 'error');
    } finally {
      state.discovering.delete(ticket.id);
      if (currentTicket()?.id === ticket.id) renderPortalReview(currentTicket());
    }
  }

  async function exploreTicket(button, automatic = false) {
    const ticket = currentTicket();
    if (!ticket || state.exploring.has(ticket.id)) return;
    const typed = $('#job-url').value.trim();
    if (typed && !safeHttpsUrl(typed)) { if (!automatic) notify('La dirección del portal debe comenzar con HTTPS.', 'error'); return; }
    const url = safeHttpsUrl(typed) || suggestedPortalUrl(ticket);
    if (!url) { if (!automatic) notify('Escribe una dirección HTTPS del portal.', 'error'); return; }
    state.exploring.add(ticket.id);
    state.explorationAttempted.add(ticket.id);
    state.explorationErrors.delete(ticket.id);
    renderPortalExploration(ticket);
    try {
      const work = async () => {
        const response = await api(`/api/tickets/${encodeURIComponent(ticket.id)}/explore`, { method: 'POST', body: { portalUrl: url } });
        replaceTicket(response.ticket || response);
      };
      if (button) await withPending(button, work);
      else await work();
    } catch (error) {
      state.explorationErrors.set(ticket.id, error.message || 'No se pudo explorar el portal.');
      if (!automatic && !button) notify(error.message || 'No se pudo explorar el portal.', 'error');
    } finally {
      state.exploring.delete(ticket.id);
      if (currentTicket()?.id === ticket.id) renderPortalExploration(currentTicket());
    }
  }

  function showInvoiceReview(reason, message) {
    state.autoReviewReason = reason || 'other';
    $('#invoice-review-card').hidden = false;
    $('#invoice-review-message').textContent = message || 'Necesitamos confirmar un dato antes de continuar.';
    $('#invoice-review-profile').hidden = !['profile', 'openai_key'].includes(reason);
    $('#invoice-review-retry').hidden = false;
    $('#invoice-manual-details').hidden = ['profile', 'openai_key'].includes(reason);
    $('#invoice-manual-details').open = reason === 'payment' || reason === 'ticket_data';
    $('#portal-help-details').open = reason === 'issuer' || reason === 'portal';
    $('#job-forma-pago').required = reason === 'payment';
    if (reason === 'payment' && state.pendingAutoTicketId) {
      state.paymentEdits.set(state.pendingAutoTicketId, '');
      $('#job-forma-pago').value = '';
    }
  }

  async function startAutoInvoice(ticketId) {
    const ticket = state.tickets.find(item => item.id === ticketId);
    if (!ticket) return;
    state.pendingAutoTicketId = ticketId;
    $('#invoice-review-card').hidden = false;
    $('#invoice-review-message').textContent = 'Identificando el emisor y preparando el trámite…';
    $('#invoice-review-profile').hidden = true;
    $('#invoice-review-retry').hidden = true;
    $('#invoice-manual-details').hidden = true;
    try {
      const formaPago = state.paymentEdits.get(ticketId) || '';
      const response = await api(`/api/tickets/${encodeURIComponent(ticketId)}/auto-invoice`, {
        method: 'POST', body: { textoAdicional: state.paymentHints.get(ticketId) || '', ...(formaPago ? { formaPago } : {}) },
      });
      if (response.ticket) replaceTicket(response.ticket);
      if (Object.prototype.hasOwnProperty.call(response, 'paymentSuggestion')) {
        if (response.paymentSuggestion) state.paymentSuggestions.set(ticketId, response.paymentSuggestion);
        else state.paymentSuggestions.delete(ticketId);
        if (currentTicket()?.id === ticketId) renderPaymentOptions(currentTicket());
      }
      if (response.status === 'started' && response.job?.id) {
        state.pendingAutoTicketId = '';
        state.autoReviewReason = '';
        $('#invoice-review-card').hidden = true;
        state.selectedJobId = response.job.id;
        await loadJobs();
        showPanel('jobs');
        await loadJobDetail(response.job.id);
        notify('Iniciamos el trámite desde los datos del ticket. Puedes seguirlo aquí.');
      } else {
        showInvoiceReview(response.reason, response.message);
        notify('El ticket necesita una revisión para continuar.', 'error');
      }
    } catch (error) {
      showInvoiceReview('other', error.message || 'No se pudo iniciar el trámite automáticamente.');
      notify(error.message || 'No se pudo iniciar el trámite automáticamente.', 'error');
    }
  }

  function selectTicketFile(file) {
    state.selectedTicketFile = file || null;
    if (state.ticketPreviewUrl) URL.revokeObjectURL(state.ticketPreviewUrl);
    state.ticketPreviewUrl = null;
    const preview = $('#ticket-preview');
    preview.hidden = true;
    preview.removeAttribute('src');
    $('#ticket-file-name').textContent = file
      ? `${file.name || 'Foto del ticket'} · ${(file.size / 1024 / 1024).toFixed(1)} MB` : '';
    if (file?.type.startsWith('image/')) {
      state.ticketPreviewUrl = URL.createObjectURL(file);
      preview.src = state.ticketPreviewUrl;
      preview.hidden = false;
    }
  }

  async function prepareTicketFile(file) {
    const accepted = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (accepted.includes(file.type) && file.size <= 15 * 1024 * 1024) return file;
    if (!file.type && /\.pdf$/i.test(file.name) && file.size <= 15 * 1024 * 1024) return file;
    if (!file.type.startsWith('image/') && !/\.(?:heic|heif|jpe?g|png|webp)$/i.test(file.name)) {
      throw new Error('Usa una foto JPEG, PNG o WebP, o un PDF de hasta 15 MB.');
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error('No se pudo leer esta foto. Si tu teléfono usa HEIC, prueba tomarla en formato JPEG.'));
        element.src = url;
      });
      const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d');
      if (!context) throw new Error('No se pudo preparar esta foto en el dispositivo.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const jpeg = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.88));
      if (!jpeg || jpeg.size > 15 * 1024 * 1024) throw new Error('La foto supera 15 MB. Toma otra con menor resolución.');
      const filename = (file.name || 'ticket').replace(/\.[^.]+$/, '') + '.jpg';
      return new File([jpeg], filename, { type: 'image/jpeg' });
    } finally { URL.revokeObjectURL(url); }
  }

  async function uploadTicket(event) {
    event.preventDefault();
    const file = state.selectedTicketFile;
    if (!file) { notify('Elige un ticket.', 'error'); return; }
    if (navigator.onLine === false) { notify('Necesitas conexión para enviar el ticket.', 'error'); return; }
    const paymentHint = $('#ticket-payment-note').value.trim();
    try {
      await withPending($('#ticket-upload-button'), async () => {
        const prepared = await prepareTicketFile(file);
        const data = new FormData(); data.append('file', prepared, prepared.name);
        const response = await api('/api/tickets', { method: 'POST', body: data });
        const ticket = response.ticket || response;
        state.tickets.unshift(ticket);
        state.selectedTicketId = ticket.id;
        if (paymentHint) state.paymentHints.set(ticket.id, paymentHint);
        renderTickets();
        renderOverview();
        $('#ticket-file').value = '';
        $('#ticket-camera').value = '';
        selectTicketFile(null);
        $('#ticket-payment-note').value = '';
        if (response.warning) notify(response.warning, 'error');
        $('#ticket-analysis-card').scrollIntoView({ behavior: 'smooth', block: 'center' });
        await startAutoInvoice(ticket.id);
      });
    } catch { /* toast from withPending */ }
  }

  const canonicalFields = [
    ['numeroTicket', 'Número de ticket'], ['numeroTienda', 'Número de tienda'],
    ['fechaVenta', 'Fecha de venta'], ['horaVenta', 'Hora de venta'],
    ['folioVenta', 'Folio de venta'], ['idVenta', 'ID de venta'],
    ['caja', 'Caja'], ['transaccion', 'Transacción'], ['marca', 'Marca'],
    ['monto', 'Total del ticket'], ['totalSinPropina', 'Total sin propina'],
    ['folio', 'Folio'], ['fecha', 'Fecha'], ['referencia', 'Referencia o token'],
  ];
  const canonicalLabels = Object.fromEntries(canonicalFields);
  const fiscalPortalField = label => /\b(rfc|raz[oó]n social|nombre(?:\s+(?:fiscal|del contribuyente))?|c[oó]digo postal|c\.?\s*p\.?|r[eé]gimen fiscal|uso (?:de )?cfdi|domicilio fiscal|correo(?: electr[oó]nico)?|e-?mail)\b/i.test(String(label || ''));
  const credentialPortalField = label => /clave de acceso|contrase(?:n|ñ)a|password|usuario|login|inicio de sesi[oó]n|clave de usuario/i.test(String(label || ''));
  const normalizedLabel = label => String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
  function extraFieldKey(label) {
    const cleaned = String(label || '').normalize('NFKC').replace(/[^\p{L}\p{N}_ .-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!cleaned || /__proto__|constructor|prototype/i.test(cleaned)) return null;
    return `portal ${cleaned.slice(0, 73)}`;
  }

  function observedFieldKey(label) {
    const normalized = String(label || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    if (/tienda|sucursal/.test(normalized)) return 'numeroTienda';
    if (/ticket|boleto/.test(normalized)) return 'numeroTicket';
    if (/fecha/.test(normalized)) return 'fechaVenta';
    if (/hora/.test(normalized)) return 'horaVenta';
    if (/folio/.test(normalized)) return 'folioVenta';
    if (/id.*venta|venta.*id/.test(normalized)) return 'idVenta';
    if (/caja/.test(normalized)) return 'caja';
    if (/transacci/.test(normalized)) return 'transaccion';
    if (/marca/.test(normalized)) return 'marca';
    if (/propina/.test(normalized)) return 'totalSinPropina';
    if (/monto|total|importe/.test(normalized)) return 'monto';
    if (/token|referencia|codigo\s+(?:de\s+)?(?:ticket|boleto)/.test(normalized)) return 'referencia';
    return null;
  }

  function ticketFieldValue(ticket, key) {
    const edits = state.fieldEdits.get(ticket.id) || {};
    if (Object.prototype.hasOwnProperty.call(edits, key)) return edits[key];
    return ticket.analysis?.[key] == null ? '' : String(ticket.analysis[key]);
  }

  function ticketFieldMarkup(ticket, field, index) {
    const key = field.key;
    if (!/^[\p{L}\p{N}_ .-]{1,80}$/u.test(key) || /__proto__|constructor|prototype/i.test(key)) return '';
    const value = ticketFieldValue(ticket, key);
    const id = `ticket-data-${normalizedLabel(key).replace(/ /g, '-').slice(0, 44)}-${index}`;
    const inputmode = ['monto', 'totalSinPropina'].includes(key) ? ' inputmode="decimal"' : '';
    const choices = key === 'marca' && effectiveProvider(ticket) === 'alsea'
      ? Object.keys(portalDefinition('alsea')?.brandEntryUrls || {})
      : Array.isArray(field.options) ? field.options : [];
    const datalist = choices.length ? `<datalist id="${id}-choices">${choices.map(choice => `<option value="${escapeHtml(typeof choice === 'object' ? choice.value || choice.label || '' : choice)}"></option>`).join('')}</datalist>` : '';
    return `<div class="field"><label for="${id}">${escapeHtml(field.label || canonicalLabels[key] || key)}${field.required ? ' · solicitado por el portal' : ''}</label><input id="${id}" data-ticket-key="${escapeHtml(key)}" type="text" value="${escapeHtml(value)}"${inputmode}${choices.length ? ` list="${id}-choices"` : ''} autocomplete="off">${datalist}${field.help ? `<p class="field-hint">${escapeHtml(field.help)}</p>` : ''}</div>`;
  }

  function effectiveProvider(ticket) {
    const selected = $('#job-provider').value;
    return selected === 'auto' ? ticket?.detection?.provider || 'generic' : selected;
  }

  function renderTicketFields() {
    const ticket = currentTicket();
    const container = $('#job-ticket-fields');
    container.hidden = !ticket || ($('#job-channel').value === 'email' && effectiveProvider(ticket) === 'primera_plus');
    if (container.hidden) { container.innerHTML = ''; return; }
    const chosen = $('#job-provider').value;
    const definition = portalDefinition(chosen === 'auto' ? ticket.detection?.provider : chosen);
    let fields = (definition?.ticketFields || []).map(field => ({ ...field }));
    if (definition?.id === 'alsea') {
      const brand = ticketFieldValue(ticket, 'marca');
      const variant = definition.brandVariants?.[brand];
      if (variant) fields = [{ key: 'marca', label: 'Marca del restaurante', required: true }, ...variant];
    }
    const observed = Array.isArray(ticket.exploration?.fields) ? ticket.exploration.fields : [];
    const seenLabels = new Set(fields.map(field => normalizedLabel(field.label)));
    for (const field of observed) {
      if (!field?.label || fiscalPortalField(field.label) || credentialPortalField(field.label) || seenLabels.has(normalizedLabel(field.label))) continue;
      const key = observedFieldKey(field.label) || extraFieldKey(field.label);
      if (key && !fields.some(item => item.key === key)) {
        fields.push({ key, label: field.label, required: !!field.required, options: field.options });
        seenLabels.add(normalizedLabel(field.label));
      }
    }
    if (!fields.length) {
      const common = ['numeroTicket', 'folio', 'fecha', 'monto', 'referencia'];
      fields = common.map(key => ({ key, label: canonicalLabels[key], required: false }));
    }
    const used = new Set(fields.map(field => field.key));
    const extras = canonicalFields.filter(([key]) => !used.has(key))
      .map(([key, label]) => ({ key, label, required: false }));
    container.innerHTML = `<div class="ticket-fields-heading"><h3>Datos del ticket para este ${$('#job-channel').value === 'email' ? 'correo' : 'portal'}</h3><p>Corrige lo leído en la imagen o completa los campos que falten. Si el portal lo solicita, podrá adjuntar la foto original del ticket.</p></div><div class="ticket-fields-grid">${fields.map((field, index) => ticketFieldMarkup(ticket, field, index)).join('')}</div>${extras.length ? `<details class="ticket-fields-extra"><summary>Agregar otros datos del ticket</summary><div class="ticket-fields-grid">${extras.map((field, index) => ticketFieldMarkup(ticket, field, index + fields.length)).join('')}</div></details>` : ''}`;
  }

  function updateJobOptions() {
    const channel = $('#job-channel').value;
    const selected = $('#job-provider').value;
    const effective = effectiveProvider(currentTicket());
    $('#job-url-field').hidden = channel === 'email' || !['generic', 'auto'].includes(selected);
    $('#job-url').required = channel === 'portal' && effective === 'generic';
    $('#job-recipient-field').hidden = channel !== 'email' || effective === 'primera_plus';
    $('#job-recipient').required = !$('#job-recipient-field').hidden;
    $('#job-token-field').hidden = channel === 'email' || effective !== 'primera_plus';
    const includeCsf = channel === 'email' || effective !== 'primera_plus';
    $('#job-csf-field').hidden = !includeCsf;
    $('#job-csf-field strong').textContent = channel === 'email' ? 'Adjuntar constancia al correo' : 'Permitir subir la constancia si el portal la pide';
    $('#job-csf-field small').textContent = channel === 'email'
      ? 'Sólo si quieres compartirla con el emisor. No es un requisito fiscal del SAT.'
      : 'El agente sólo la cargará en un campo claramente identificado como constancia fiscal.';
    if (!includeCsf) $('#job-include-csf').checked = false;
    renderTicketFields();
    updateSharingNotice();
  }

  function updateSharingNotice() {
    const ticket = currentTicket();
    const provider = effectiveProvider(ticket);
    const channel = $('#job-channel').value;
    let destination;
    if (channel === 'email') {
      destination = provider === 'primera_plus'
        ? 'cfdiboletoprimeraplus@flecha-amarilla.com'
        : ($('#job-recipient').value.trim() || 'el correo del emisor que indiques');
    } else {
      const raw = $('#job-url').value.trim() || portalDefinition(provider)?.portalUrl ||
        ticket?.discovery?.selected?.url || '';
      try { destination = raw ? new URL(raw).hostname : 'el portal HTTPS que elijas'; }
      catch { destination = 'el portal HTTPS que elijas'; }
    }
    const csf = $('#job-include-csf').checked
      ? ' También autorizas compartir tu constancia si el trámite la solicita.' : '';
    $('#job-sharing').textContent = 'Al iniciar, autorizas compartir con ' + destination +
      ' tu ticket, RFC, nombre fiscal, código postal, régimen, uso CFDI y correo para recibir la factura.' +
      csf + (channel === 'email'
        ? ' El correo se enviará al pulsar «Iniciar trámite».'
        : ' Antes de emitir la factura, el navegador se detendrá para que confirmes el envío final.');
  }

  async function createJob(event) {
    event.preventDefault();
    if (!$('#job-form').reportValidity()) return;
    if (!$('#job-url-field').hidden && $('#job-url').value.trim() && !safeHttpsUrl($('#job-url').value.trim())) {
      notify('La dirección del portal debe comenzar con HTTPS.', 'error');
      $('#job-url').focus();
      return;
    }
    const body = {
      ticketId: $('#job-ticket').value,
      provider: $('#job-provider').value,
      channel: $('#job-channel').value,
      includeCsf: $('#job-include-csf').checked,
    };
    if (['generic', 'auto'].includes(body.provider) && body.channel === 'portal' && $('#job-url').value.trim()) body.portalUrl = $('#job-url').value.trim();
    if (body.channel === 'email' && effectiveProvider(currentTicket()) !== 'primera_plus') body.recipientEmail = $('#job-recipient').value.trim();
    const ticketData = {};
    $$('[data-ticket-key]', $('#job-ticket-fields')).forEach(input => {
      const value = input.value.trim();
      if (value) ticketData[input.dataset.ticketKey] = value;
    });
    if ($('#job-forma-pago').value) ticketData.formaPago = $('#job-forma-pago').value;
    if (Object.keys(ticketData).length) body.ticketData = ticketData;
    const token = $('#job-token').value.trim();
    if (token && body.channel === 'portal' && effectiveProvider(currentTicket()) === 'primera_plus') body.token = token;
    try {
      await withPending($('#job-submit'), async () => {
        const response = await api('/api/jobs', { method: 'POST', body });
        const job = response.job || response;
        state.selectedJobId = job.id;
        state.pendingAutoTicketId = '';
        state.autoReviewReason = '';
        $('#invoice-review-card').hidden = true;
        $('#job-token').value = '';
        $('#job-include-csf').checked = false;
        await loadJobs();
        showPanel('jobs');
        await loadJobDetail(job.id);
        notify('Trámite iniciado. Puedes seguirlo aquí.');
      });
    } catch { /* toast from withPending */ }
  }

  function jobTitle(job) {
    if (job.portalUrl === 'email:primera_plus') return 'Primera Plus';
    if (typeof job.portalUrl === 'string' && job.portalUrl.startsWith('mailto:')) return `Correo a ${job.portalUrl.slice(7)}`;
    const provider = portalDefinition(job.provider);
    if (provider && provider.id !== 'generic') return provider.label;
    try {
      const hostname = new URL(job.portalUrl).hostname;
      const portal = state.portals.find(item => item.id !== 'generic' && item.allowedHosts?.includes(hostname));
      return portal?.label || (hostname.includes('facturaelectronicagfa.mx') ? 'Primera Plus' : hostname || 'Solicitud de factura');
    } catch { return 'Solicitud de factura'; }
  }

  async function loadJobs() {
    if (!state.me) return;
    try {
      const previous = new Map(state.jobs.map(job => [job.id, job.status]));
      const response = await api('/api/jobs');
      state.jobs = response.jobs || response;
      renderJobs();
      renderOverview();
      if (state.jobsLoaded && state.jobs.some(job => job.status === 'needs_action' &&
          previous.has(job.id) && previous.get(job.id) !== 'needs_action')) {
        notify('Un trámite necesita tu ayuda. Abre “Mis facturas” para continuar.');
      }
      state.jobsLoaded = true;
    } catch (error) { notify(error.message, 'error'); }
  }

  function renderJobs() {
    $('#jobs-count').textContent = String(state.jobs.length);
    $('#job-list').innerHTML = state.jobs.length ? state.jobs.map(job => `
      <button type="button" class="job-list-item ${job.id === state.selectedJobId ? 'selected' : ''}" data-job-id="${escapeHtml(job.id)}">
        <span class="job-list-item-main"><strong>${escapeHtml(jobTitle(job))}</strong><small>${escapeHtml(friendlyDate(job.createdAt))}</small></span>
        <span class="pill pill-${escapeHtml(job.status)}">${escapeHtml(statusText[job.status] || job.status)}</span>
      </button>
    `).join('') : '<p class="empty-inline">Aún no tienes trámites. Carga un ticket para comenzar.</p>';
  }

  async function loadJobDetail(id) {
    if (!id) return;
    try {
      const response = await api(`/api/jobs/${encodeURIComponent(id)}`);
      state.selectedJobId = id;
      state.selectedJobStatus = response.job.status;
      state.selectedJob = response.job;
      renderJobs();
      renderJobDetail(response.job, response.events || []);
    } catch (error) { notify(error.message, 'error'); }
  }

  function renderJobDetail(job, events) {
    const result = job.result || {};
    const documents = result.documents || [];
    const primeraPlus = /facturaelectronicagfa\.mx/i.test(job.portalUrl);
    const message = job.error || result.message || (job.status === 'running' ? 'Estamos interactuando con el portal.' : job.status === 'queued' ? 'El trámite empezará en unos momentos.' : 'Consulta el avance abajo.');
    const filesHtml = documents.length ? `<div class="detail-section"><h3>Archivos recibidos</h3>${documents.map(doc => `<a class="document-link" href="/api/files/${encodeURIComponent(doc.fileId)}" download><span>${escapeHtml(doc.filename || `Factura ${doc.kind || ''}`)}</span><span class="download-icon" aria-hidden="true">↓</span></a>`).join('')}</div>` : '';
    const eventsHtml = events.length ? `<div class="detail-section"><h3>Actividad</h3><ol class="event-list">${events.map(event => `<li><div><span>${escapeHtml(event.message)}</span><time>${escapeHtml(friendlyDate(event.createdAt || event.created_at))}</time></div></li>`).join('')}</ol></div>` : '';
    const recoveryHtml = primeraPlus && ['submitted', 'failed'].includes(job.status) ? `<div class="detail-section recovery-section"><h3>¿Ya se generó la factura?</h3><p>Busca el CFDI existente con un token del boleto y tu RFC. Esta operación no crea otra factura.</p><div class="challenge-tools"><input class="recovery-token" type="text" aria-label="Token para recuperar CFDI" placeholder="Token del boleto"><button type="button" class="button button-secondary" data-challenge="recover">Buscar CFDI</button></div></div>` : '';
    const challengeHtml = job.status === 'needs_action' ? `<div class="detail-section" id="challenge-section"><h3>Acción en el portal</h3><p class="challenge-copy">Si el portal pide un CAPTCHA o un dato adicional, toca la captura o escribe la respuesta. Puedes ampliar la imagen para seleccionar con más precisión. Pulsa “Continuar” al terminar.</p><div class="challenge-screen"><img id="challenge-image" alt="Captura actual del portal para resolver la acción pendiente" src="/api/jobs/${encodeURIComponent(job.id)}/screenshot?t=${Date.now()}"><div id="challenge-image-fallback" class="loading-screen" hidden>No hay una sesión de navegador activa. Revisa el portal antes de volver a enviar.</div></div><div class="challenge-tools"><input id="challenge-text" type="text" aria-label="Texto para escribir en el portal" placeholder="Texto para escribir"><button type="button" class="button button-secondary" data-challenge="type">Escribir</button></div><div class="challenge-tools"><select id="challenge-key" aria-label="Tecla para enviar"><option>Tab</option><option>Enter</option><option>Escape</option><option>Backspace</option><option>ArrowDown</option><option>ArrowUp</option></select><button type="button" class="button button-secondary" data-challenge="press">Enviar tecla</button><button type="button" class="button button-secondary" data-challenge="refresh">Actualizar captura</button><button type="button" class="button button-secondary" data-challenge="zoom">Ampliar captura</button></div><div class="challenge-tools"><button type="button" class="button button-primary" data-challenge="continue">Continuar trámite</button><button type="button" class="button button-danger" data-challenge="cancel">Cancelar</button></div></div>` : '';
    $('#job-detail').innerHTML = `<div class="detail-top"><div><p class="eyebrow">DETALLE DEL TRÁMITE</p><h2>${escapeHtml(jobTitle(job))}</h2><div class="detail-id">${escapeHtml(job.id)} · ${escapeHtml(friendlyDate(job.createdAt))}</div></div><span class="pill pill-${escapeHtml(job.status)}">${escapeHtml(statusText[job.status] || job.status)}</span></div><div class="detail-summary ${job.status === 'failed' ? 'error' : ''}">${escapeHtml(message)}</div>${filesHtml}${challengeHtml}${recoveryHtml}${eventsHtml}`;
    const humanReason = events.filter(event => event.kind === 'human_action').at(-1)?.message;
    const challengeCopy = $('#challenge-section .challenge-copy');
    if (challengeCopy && humanReason) {
      challengeCopy.textContent = humanReason + ' Pulsa «Continuar trámite» cuando hayas terminado o «Cancelar» para detenerte.';
    }
    if (humanReason && /nuevo dominio público/i.test(humanReason)) {
      $$('.challenge-tools', $('#challenge-section')).slice(0, 2).forEach(group => { group.hidden = true; });
    }
    const image = $('#challenge-image');
    if (image && humanReason && /nuevo dominio público/i.test(humanReason)) image.style.pointerEvents = 'none';
    if (image) image.addEventListener('error', () => {
      image.src = `/api/jobs/${encodeURIComponent(job.id)}/last-screenshot?t=${Date.now()}`;
      image.style.pointerEvents = 'none';
      image.addEventListener('error', () => { image.hidden = true; }, { once: true });
      const fallback = $('#challenge-image-fallback');
      fallback.hidden = false;
      $$('.challenge-tools', $('#challenge-section')).forEach(group => { group.hidden = true; });
      let portalLink = '';
      try {
        const url = new URL(job.portalUrl);
        if (url.protocol === 'https:') portalLink = `<a href="${escapeHtml(url.href)}" target="_blank" rel="noopener noreferrer">Abrir el portal para comprobarlo ↗</a>`;
      } catch { /* no portal link */ }
      const canRetry = job.result?.retrySafe === true;
      const retryMarkup = canRetry ? `<label class="checkbox-field retry-check"><input id="reviewed-portal" type="checkbox"><span><strong>Ya revisé el portal y confirmé que no se emitió la factura</strong></span></label><div class="challenge-tools"><button type="button" class="button button-secondary" data-challenge="review-ticket">Corregir datos del ticket</button><button type="button" class="button button-primary" data-challenge="retry">Reintentar después de revisar el portal</button></div>${primeraPlus ? '<label class="retry-token-label" for="retry-token">Token del boleto (opcional)</label><input id="retry-token" type="text" placeholder="Si el portal lo necesita">' : ''}` : primeraPlus ? '<p>Para evitar una factura duplicada, busca primero el CFDI existente por token.</p><div class="challenge-tools"><input class="recovery-token" type="text" aria-label="Token para recuperar CFDI" placeholder="Token del boleto"><button type="button" class="button button-secondary" data-challenge="recover">Buscar CFDI</button></div>' : '<p>Contacta al emisor antes de iniciar otro trámite con este ticket.</p>';
      fallback.innerHTML = `<p>No hay una sesión de navegador activa. Comprueba si el portal ya emitió un CFDI antes de iniciar otro trámite.</p>${portalLink}${retryMarkup}`;
    }, { once: true });
  }

  function refreshChallengeImage() {
    const image = $('#challenge-image');
    if (image) image.src = `/api/jobs/${encodeURIComponent(state.selectedJobId)}/screenshot?t=${Date.now()}`;
  }

  async function performChallenge(action, button) {
    const body = { type: action };
    if (action === 'type') { body.text = $('#challenge-text')?.value || ''; if (!body.text) return notify('Escribe el texto que quieres enviar.', 'error'); }
    if (action === 'press') body.key = $('#challenge-key').value;
    try {
      await withPending(button, async () => {
        await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/action`, { method: 'POST', body });
        if (action === 'continue' || action === 'cancel') await loadJobDetail(state.selectedJobId);
        else { if (action === 'type') $('#challenge-text').value = ''; setTimeout(refreshChallengeImage, 350); }
      });
    } catch { /* toast from withPending */ }
  }

  async function retryJob(button) {
    const previous = state.selectedJob;
    if (!previous || previous.result?.retrySafe !== true || !$('#reviewed-portal')?.checked) {
      notify('Comprueba primero en el portal que no se haya emitido la factura.', 'error');
      return;
    }
    const provider = previous.provider || (/facturaelectronicagfa\.mx/i.test(previous.portalUrl) ? 'primera_plus' : 'generic');
    const body = { ticketId: previous.ticketId, provider, channel: 'portal', force: true };
    if (safeHttpsUrl(previous.portalUrl)) body.portalUrl = previous.portalUrl;
    const edits = state.fieldEdits.get(previous.ticketId);
    if (edits && Object.keys(edits).length) body.ticketData = edits;
    const token = $('#retry-token')?.value.trim();
    if (token) body.token = token;
    try {
      await withPending(button, async () => {
        const response = await api('/api/jobs', { method: 'POST', body });
        const job = response.job || response;
        await loadJobs();
        await loadJobDetail(job.id);
        notify('Nuevo intento iniciado.');
      });
    } catch { /* toast from withPending */ }
  }

  function reviewTicketForRetry() {
    const previous = state.selectedJob;
    if (!previous) return;
    state.selectedTicketId = previous.ticketId;
    showPanel('new-ticket');
    renderTickets();
    $('#job-ticket-fields').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function recoverJob(button) {
    const previous = state.selectedJob;
    if (!previous || !/facturaelectronicagfa\.mx/i.test(previous.portalUrl)) return;
    const token = button.closest('.challenge-tools')?.querySelector('.recovery-token')?.value.trim();
    if (!token) { notify('Escribe un token del boleto para buscar el CFDI.', 'error'); return; }
    try {
      await withPending(button, async () => {
        const response = await api('/api/jobs', { method: 'POST', body: {
          ticketId: previous.ticketId, provider: 'primera_plus', channel: 'portal', operation: 'recover', token,
        } });
        const job = response.job || response;
        await loadJobs();
        await loadJobDetail(job.id);
        notify('Búsqueda de CFDI iniciada.');
      });
    } catch { /* toast from withPending */ }
  }

  async function clickChallengeImage(event) {
    const image = event.target;
    if (!image.naturalWidth || !image.naturalHeight) return;
    const bounds = image.getBoundingClientRect();
    const x = Math.round((event.clientX - bounds.left) * image.naturalWidth / bounds.width);
    const y = Math.round((event.clientY - bounds.top) * image.naturalHeight / bounds.height);
    try {
      await api(`/api/jobs/${encodeURIComponent(state.selectedJobId)}/action`, { method: 'POST', body: { type: 'click', x, y } });
      setTimeout(refreshChallengeImage, 400);
    } catch (error) { notify(error.message, 'error'); }
  }

  async function loadTokens() {
    try { const response = await api('/api/mcp-tokens'); state.tokens = response.tokens || response; renderTokens(); }
    catch (error) { notify(error.message, 'error'); }
  }

  function renderTokens() {
    $('#mcp-token-list').innerHTML = state.tokens.length ? state.tokens.map(token => `<div class="token-item"><div><strong>${escapeHtml(token.name)}</strong><small>Creada ${escapeHtml(friendlyDate(token.createdAt))}${token.lastUsedAt ? ` · Usada ${escapeHtml(friendlyDate(token.lastUsedAt))}` : ''}</small></div><button type="button" class="text-button" data-revoke-token="${escapeHtml(token.id)}">Revocar</button></div>`).join('') : '<p class="empty-inline">Todavía no has creado claves MCP.</p>';
  }

  function renderMcpGuide() {
    const endpoint = $('#mcp-endpoint').textContent;
    $('#mcp-code-claude').textContent = `claude mcp add --transport http factura-clara --scope user ${endpoint} --header "Authorization: Bearer TU_CLAVE_MCP"\nclaude mcp list`;
    $('#mcp-code-codex').textContent = `[mcp_servers.factura_clara]\nurl = "${endpoint}"\nbearer_token_env_var = "FACTURA_MCP_TOKEN"`;
    $('#mcp-code-http').textContent = `Transporte: Streamable HTTP\nURL: ${endpoint}\nAuthorization: Bearer TU_CLAVE_MCP`;
  }

  function selectMcpGuide(name, focus = false) {
    const tab = $(`[data-mcp-tab="${name}"]`);
    if (!tab) return;
    $$('[data-mcp-tab]').forEach(button => {
      const selected = button === tab;
      button.setAttribute('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      $(`#mcp-guide-${button.dataset.mcpTab}`).hidden = !selected;
    });
    if (focus) tab.focus();
  }

  async function createToken(event) {
    event.preventDefault();
    const name = $('#mcp-name').value.trim();
    if (!name) return;
    try {
      await withPending($('#mcp-form button[type=submit]'), async () => {
        const response = await api('/api/mcp-tokens', { method: 'POST', body: { name } });
        $('#mcp-token-value').textContent = response.token;
        $('#new-mcp-token').hidden = false;
        $('#mcp-name').value = '';
        await loadTokens();
        notify('Clave MCP creada. Cópiala ahora.');
      });
    } catch { /* toast from withPending */ }
  }

  async function revokeToken(id) {
    if (!window.confirm('¿Revocar esta clave MCP? Tu agente perderá acceso con ella.')) return;
    try {
      await api(`/api/mcp-tokens/${encodeURIComponent(id)}`, { method: 'DELETE' });
      await loadTokens();
      notify('Clave MCP revocada.');
    } catch (error) { notify(error.message, 'error'); }
  }

  async function copy(value) {
    try { await navigator.clipboard.writeText(value); notify('Copiado al portapapeles.'); }
    catch { notify('No se pudo copiar automáticamente. Selecciona el texto manualmente.', 'error'); }
  }

  async function logout() {
    try { await api('/api/auth/logout', { method: 'POST' }); }
    catch (error) { notify(error.message, 'error'); }
    state.me = null; state.csrfToken = ''; state.profile = null; state.tickets = []; state.jobs = [];
    state.jobsLoaded = false;
    state.fieldEdits.clear(); state.paymentSuggestions.clear(); state.paymentHints.clear(); state.paymentEdits.clear();
    state.pendingAutoTicketId = ''; state.autoReviewReason = '';
    showAuth();
  }

  function bindEvents() {
    const deleteButton = document.createElement('button');
    deleteButton.id = 'delete-csf';
    deleteButton.type = 'button';
    deleteButton.className = 'text-button';
    deleteButton.textContent = 'Eliminar constancia guardada';
    deleteButton.hidden = true;
    $('#csf-form').after(deleteButton);
    deleteButton.addEventListener('click', () => void deleteCsf());
    $('#auth-form').addEventListener('submit', handleAuth);
    $('#auth-toggle').addEventListener('click', () => setAuthMode(!state.registerMode));
    $('#logout-button').addEventListener('click', logout);
    $('#mobile-logout').addEventListener('click', logout);
    $$('[data-panel]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.panel)));
    $$('[data-go]').forEach(button => button.addEventListener('click', () => showPanel(button.dataset.go)));
    $('#profile-form').addEventListener('submit', saveFiscalProfile);
    $('#profile-rfc').addEventListener('input', () => renderFiscalSelects());
    $('#profile-regimen').addEventListener('change', () => renderFiscalSelects($('#profile-regimen').value, ''));
    $('#csf-form').addEventListener('submit', uploadCsf);
    $('#api-form').addEventListener('submit', saveApiKey);
    $('#smtp-form').addEventListener('submit', saveSmtp);
    $('#csf-file').addEventListener('change', event => { $('#csf-file-name').textContent = event.target.files[0]?.name || ''; });
    $('#ticket-file').addEventListener('change', event => {
      if (event.target.files[0]) $('#ticket-camera').value = '';
      selectTicketFile(event.target.files[0]);
    });
    $('#ticket-camera').addEventListener('change', event => {
      if (event.target.files[0]) $('#ticket-file').value = '';
      selectTicketFile(event.target.files[0]);
    });
    $('#ticket-preview').addEventListener('error', event => { event.target.hidden = true; });
    $('#ticket-upload-form').addEventListener('submit', uploadTicket);
    $('#install-app').addEventListener('click', () => void installApp());
    $('#update-app').addEventListener('click', () => {
      const waiting = state.serviceWorkerRegistration?.waiting;
      if (!waiting) return;
      state.reloadingForUpdate = true;
      waiting.postMessage({ type: 'SKIP_WAITING' });
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshJobsOnResume(); });
    window.addEventListener('focus', () => void refreshJobsOnResume());
    $('#invoice-review-retry').addEventListener('click', () => {
      if (state.autoReviewReason === 'payment' && !$('#job-forma-pago').value) {
        notify('Selecciona la forma de pago antes de reintentar.', 'error');
        $('#job-forma-pago').focus();
        return;
      }
      if (state.pendingAutoTicketId) void startAutoInvoice(state.pendingAutoTicketId);
    });
    $('#job-ticket').addEventListener('change', event => { state.selectedTicketId = event.target.value; renderTicketAnalysis(); });
    $('#portal-discovery-form').addEventListener('submit', discoverTicket);
    $('#portal-suggestion').addEventListener('click', event => {
      const button = event.target.closest('[data-use-portal]');
      if (!button || !currentTicket()) return;
      const url = safeHttpsUrl(button.dataset.usePortal);
      if (!url) return;
      state.urlEdits.set(currentTicket().id, url);
      state.providerEdits.set(currentTicket().id, 'generic');
      $('#job-provider').value = 'generic';
      $('#job-url').value = url;
      updateJobOptions();
      void exploreTicket(null, false);
    });
    $('#portal-exploration').addEventListener('click', event => {
      const emailButton = event.target.closest('[data-use-email]');
      if (emailButton && usableEmail(emailButton.dataset.useEmail)) {
        if (effectiveProvider(currentTicket()) === 'primera_plus') {
          $('#job-provider').value = 'generic';
          if (currentTicket()) state.providerEdits.set(currentTicket().id, 'generic');
        }
        $('#job-channel').value = 'email';
        $('#job-recipient').value = emailButton.dataset.useEmail;
        updateJobOptions();
        $('#job-recipient').focus();
        return;
      }
      const button = event.target.closest('[data-explore-portal]');
      if (button) void exploreTicket(button, false);
    });
    $('#job-url').addEventListener('input', event => {
      if (!currentTicket()) return;
      state.urlEdits.set(currentTicket().id, event.target.value);
      renderPortalExploration(currentTicket());
      updateSharingNotice();
    });
    $('#job-recipient').addEventListener('input', updateSharingNotice);
    $('#job-include-csf').addEventListener('change', updateSharingNotice);
    $('#job-provider').addEventListener('change', () => {
      updateJobOptions();
      if (currentTicket()) state.providerEdits.set(currentTicket().id, $('#job-provider').value);
    });
    $('#job-channel').addEventListener('change', updateJobOptions);
    $('#job-forma-pago').addEventListener('change', event => {
      if (currentTicket()) state.paymentEdits.set(currentTicket().id, event.target.value);
    });
    $('#job-ticket-fields').addEventListener('input', event => {
      const input = event.target.closest('[data-ticket-key]');
      const ticket = currentTicket();
      if (!input || !ticket) return;
      const edits = state.fieldEdits.get(ticket.id) || {};
      edits[input.dataset.ticketKey] = input.value;
      state.fieldEdits.set(ticket.id, edits);
    });
    $('#job-ticket-fields').addEventListener('change', event => {
      if (event.target.dataset.ticketKey === 'marca') renderTicketFields();
    });
    $('#job-form').addEventListener('submit', createJob);
    $('#refresh-jobs').addEventListener('click', () => { void loadJobs(); if (state.selectedJobId) void loadJobDetail(state.selectedJobId); });
    $('#job-list').addEventListener('click', event => { const button = event.target.closest('[data-job-id]'); if (button) void loadJobDetail(button.dataset.jobId); });
    $('#job-detail').addEventListener('click', event => {
      if (event.target.id === 'challenge-image') { void clickChallengeImage(event); return; }
      const button = event.target.closest('[data-challenge]');
      if (!button) return;
      if (button.dataset.challenge === 'refresh') refreshChallengeImage();
      else if (button.dataset.challenge === 'zoom') {
        const screen = $('.challenge-screen', $('#job-detail'));
        screen?.classList.toggle('zoomed');
        button.textContent = screen?.classList.contains('zoomed') ? 'Vista normal' : 'Ampliar captura';
      }
      else if (button.dataset.challenge === 'retry') void retryJob(button);
      else if (button.dataset.challenge === 'review-ticket') reviewTicketForRetry();
      else if (button.dataset.challenge === 'recover') void recoverJob(button);
      else void performChallenge(button.dataset.challenge, button);
    });
    $('#mcp-form').addEventListener('submit', createToken);
    $('#mcp-token-list').addEventListener('click', event => { const button = event.target.closest('[data-revoke-token]'); if (button) void revokeToken(button.dataset.revokeToken); });
    $('#copy-mcp-token').addEventListener('click', () => void copy($('#mcp-token-value').textContent));
    $('#copy-mcp-endpoint').addEventListener('click', () => void copy($('#mcp-endpoint').textContent));
    $('.mcp-tabs').addEventListener('click', event => {
      const tab = event.target.closest('[data-mcp-tab]');
      if (tab) selectMcpGuide(tab.dataset.mcpTab);
    });
    $('.mcp-tabs').addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const tabs = $$('[data-mcp-tab]');
      const index = tabs.indexOf(document.activeElement);
      if (index < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
        : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      selectMcpGuide(tabs[next].dataset.mcpTab, true);
    });
    $$('[data-copy-mcp-guide]').forEach(button => button.addEventListener('click', () => {
      void copy($(`#mcp-code-${button.dataset.copyMcpGuide}`).textContent);
    }));
  }

  bindEvents();
  void registerPwa();
  setAuthMode(false);
  void loadAuthConfiguration();
  void initializeSession();
  setInterval(async () => {
    if (!state.me || document.hidden) return;
    await loadJobs();
    const selected = state.jobs.find(job => job.id === state.selectedJobId);
    if (state.panel === 'jobs' && state.selectedJobId &&
        (state.selectedJobStatus !== 'needs_action' || selected?.status !== 'needs_action')) {
      await loadJobDetail(state.selectedJobId);
    }
  }, 6500);
})();
