/* =========================================================
   SaturnIA · lógica do aplicativo
   Login, conversas salvas, memórias e chat em tempo real.
   ========================================================= */

/* ---------- Atualização automática ----------
   O GitHub Pages deixa a página em cache por 10 minutos. Ao abrir, a
   SaturnIA confere version.json (sempre buscado sem cache); se houver
   uma versão mais nova publicada, ela baixa a página atual e recarrega
   uma única vez. A cada publicação, aumente APP_VERSION e version.json juntos. */
(function checkForUpdate() {
  const APP_VERSION = '15';
  fetch(`version.json?t=${Date.now()}`, { cache: 'no-store' })
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (!data || data.version === APP_VERSION) return;
      let tried = null;
      try { tried = sessionStorage.getItem('saturnia-reloaded-for'); } catch (e) {}
      if (tried === data.version) return; // já tentou, não entra em loop
      try { sessionStorage.setItem('saturnia-reloaded-for', data.version); } catch (e) {}
      fetch(location.href, { cache: 'reload' })
        .catch(() => {})
        .finally(() => location.reload());
    })
    .catch(() => {});
})();

(function () {
  const API = ((window.SATURNIA_CONFIG && window.SATURNIA_CONFIG.apiBase) || '').replace(/\/+$/, '');
  const TOKEN_KEY = 'saturnia-token';
  const MAX_USER_CHARS = 6000;

  const ERRORS = {
    rate_limited: 'Muitas tentativas em pouco tempo. Espere um minutinho e tente de novo.',
    origin_not_allowed: 'Este site não tem permissão para falar com o servidor da SaturnIA.',
    invalid_request: 'Não consegui entender essa mensagem. Tente reformular.',
    quota: 'Por hoje eu já pensei demais: a cota gratuita do dia acabou. Volte amanhã!',
    overloaded: 'A IA está sobrecarregada agora. Tente de novo em instantes.',
    not_found: 'Essa conversa não existe mais.',
    network: 'Não consegui me conectar ao servidor. Verifique sua internet.',
    invalid_credentials: 'E-mail ou senha incorretos.',
    email_taken: 'Já existe uma conta com esse e-mail. Tente entrar.',
    weak_password: 'A senha precisa ter pelo menos 8 caracteres.',
    invalid_email: 'Digite um e-mail válido.',
    invalid_name: 'Digite como você quer ser chamado.',
    google_invalid: 'Não consegui confirmar seu login com o Google. Tente de novo.',
    google_disabled: 'O login com o Google ainda não está ativado.',
    image_limit: 'Você chegou ao limite de imagens de hoje. Volte amanhã!',
    explore_unknown: 'Não entendi que tipo de lugar você procura. Tente algo como "cafés", "farmácia" ou "parque".',
    explore_place: 'Não encontrei esse endereço ou bairro. Tente escrever de outro jeito, com a cidade.',
    explore_busy: 'O serviço de mapas está ocupado agora. Tente de novo em instantes.',
    wrong_password: 'A senha atual está incorreta.',
    about_too_long: 'Esse texto passou de 1000 caracteres. Tente resumir.',
    confirm_required: 'Digite EXCLUIR para confirmar.',
    need_location:'Me diga onde: use sua localização ou escreva o bairro (ex.: "cafés em Pinheiros").',
    default: 'Algo deu errado do meu lado. Tente de novo.',
  };

  /* ---------- Elementos ---------- */
  const $ = (id) => document.getElementById(id);
  const authEl = $('auth');
  const shell = $('shell');
  const app = $('app');
  const thread = $('thread');
  const input = $('input');
  const sendBtn = $('send');
  const statusEl = $('status');
  const convList = $('conv-list');
  const topTitle = $('top-title');
  // O olho só é criado quando o app aparece (escondido, o canvas tem tamanho zero)
  let eye = null;
  function ensureEye() {
    if (!eye) eye = new window.SaturnEye($('eye'));
    else eye.resize();
  }

  /* ---------- Estado ---------- */
  let token = null;
  let user = null;
  let conversations = [];
  let currentId = null;
  let controller = null;

  try { token = localStorage.getItem(TOKEN_KEY); } catch (e) {}

  function saveToken(value) {
    token = value;
    try {
      if (value) localStorage.setItem(TOKEN_KEY, value);
      else localStorage.removeItem(TOKEN_KEY);
    } catch (e) {}
  }

  /* ---------- Comunicação com o servidor ---------- */
  class ApiError extends Error {
    constructor(code, status) { super(code); this.code = code; this.status = status; }
  }

  async function api(path, options = {}) {
    const headers = { ...(options.headers || {}) };
    if (options.body) headers['Content-Type'] = 'application/json';
    if (token) headers.Authorization = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`${API}${path}`, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      throw new ApiError('network', 0);
    }
    if (res.status === 401 && token && !path.startsWith('/auth/')) {
      sessionExpired();
      throw new ApiError('unauthorized', 401);
    }
    if (options.raw) {
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new ApiError(data.error || 'default', res.status);
      }
      return res;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new ApiError(data.error || 'default', res.status);
    return data;
  }

  /* =========================================================
     Login e cadastro
     ========================================================= */
  const authForm = $('auth-form');
  const authError = $('auth-error');
  const authSubmit = $('auth-submit');
  const fieldName = $('field-name');
  let authMode = 'login';

  function setAuthMode(mode) {
    authMode = mode;
    document.querySelectorAll('.tabs button').forEach((b) => {
      const active = b.dataset.mode === mode;
      b.classList.toggle('is-active', active);
      b.setAttribute('aria-selected', String(active));
    });
    fieldName.hidden = mode !== 'register';
    authForm.elements.namedItem('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    authSubmit.textContent = mode === 'register' ? 'Criar conta' : 'Entrar';
    $('auth-sub').textContent = mode === 'register'
      ? 'Crie sua conta. Vou lembrar de você nas próximas conversas.'
      : 'Entre para conversar. Eu lembro de você.';
    authError.textContent = '';
  }

  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.mode)));

  authForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    authError.textContent = '';
    const fields = authForm.elements;
    const name = fields.namedItem('name').value.trim();
    const email = fields.namedItem('email').value.trim();
    const password = fields.namedItem('password').value;

    if (authMode === 'register' && !name) { authError.textContent = ERRORS.invalid_name; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { authError.textContent = ERRORS.invalid_email; return; }
    if (password.length < 8) { authError.textContent = ERRORS.weak_password; return; }

    authSubmit.disabled = true;
    authSubmit.textContent = authMode === 'register' ? 'Criando conta…' : 'Entrando…';
    try {
      const path = authMode === 'register' ? '/auth/register' : '/auth/login';
      const body = authMode === 'register' ? { name, email, password } : { email, password };
      const data = await api(path, { method: 'POST', body });
      saveToken(data.token);
      authForm.reset();
      await enterApp(data.user);
    } catch (err) {
      authError.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      authSubmit.disabled = false;
      authSubmit.textContent = authMode === 'register' ? 'Criar conta' : 'Entrar';
    }
  });

  function showAuth(message) {
    shell.hidden = true;
    authEl.hidden = false;
    setAuthMode('login');
    if (message) authError.textContent = message;
    setupGoogle();
    setTimeout(() => authForm.elements.namedItem('email').focus(), 50);
  }

  /* ---------- Login com o Google (botão no estilo da SaturnIA) ----------
     O botão é nosso; ao clicar, o Google abre uma janela para a pessoa
     escolher a conta e devolve um "access token", que o servidor confere
     com o próprio Google antes de entrar. */
  const GOOGLE_CLIENT_ID = (window.SATURNIA_CONFIG && window.SATURNIA_CONFIG.googleClientId) || '';
  const googleBtn = $('google-btn');
  let tokenClient = null;

  // A biblioteca do Google carrega em paralelo: espera até ela existir
  function whenGoogleLoaded(callback, tries = 0) {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) callback();
    else if (tries < 100) setTimeout(() => whenGoogleLoaded(callback, tries + 1), 100);
  }

  function setGoogleBusy(busy) {
    googleBtn.disabled = busy;
    $('google-btn-label').textContent = busy ? 'Conectando ao Google…' : 'Continuar com o Google';
  }

  async function onGoogleToken(resp) {
    if (!resp || !resp.access_token) {
      setGoogleBusy(false);
      if (resp && resp.error && resp.error !== 'access_denied') authError.textContent = ERRORS.google_invalid;
      return;
    }
    try {
      const data = await api('/auth/google', { method: 'POST', body: { accessToken: resp.access_token } });
      saveToken(data.token);
      await enterApp(data.user);
    } catch (err) {
      authError.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      setGoogleBusy(false);
    }
  }

  function setupGoogle() {
    if (!GOOGLE_CLIENT_ID) return;
    whenGoogleLoaded(() => {
      if (!tokenClient) {
        tokenClient = window.google.accounts.oauth2.initTokenClient({
          client_id: GOOGLE_CLIENT_ID,
          scope: 'openid email profile',
          prompt: 'select_account',
          callback: onGoogleToken,
          error_callback: (err) => {
            setGoogleBusy(false);
            if (err && err.type !== 'popup_closed') authError.textContent = ERRORS.google_invalid;
          },
        });
      }
      $('google-area').hidden = false;
    });
  }

  googleBtn.addEventListener('click', () => {
    if (!tokenClient) return;
    authError.textContent = '';
    setGoogleBusy(true);
    tokenClient.requestAccessToken();
  });

  function sessionExpired() {
    if (controller) controller.abort();
    saveToken(null);
    user = null;
    showAuth('Sua sessão expirou. Entre de novo.');
  }

  function signOut(message) {
    if (controller) controller.abort();
    saveToken(null);
    user = null;
    conversations = [];
    currentId = null;
    thread.innerHTML = '';
    showAuth(message);
  }

  $('logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    signOut();
  });

  function updateUserUI() {
    if (!user) return;
    $('user-name').textContent = user.name;
    $('user-email').textContent = user.email;
    $('user-avatar').textContent = (user.name || '?').trim().charAt(0).toUpperCase();
    $('intro-name').textContent = `, ${user.name.split(' ')[0]}`;
  }

  // Salva nome, cor e/ou "primeiro acesso concluído" na conta
  async function saveMe(fields) {
    const data = await api('/me', { method: 'POST', body: fields });
    user = data.user;
    updateUserUI();
    return user;
  }

  async function enterApp(u) {
    user = u;
    applyAccent(u.accent);
    applyLayout(u.layout);
    authEl.hidden = true;
    shell.hidden = false;
    ensureEye();
    updateUserUI();
    newChat();
    if (!u.onboarded) openOnboarding();
    await Promise.all([loadConversations(), refreshMemoryCount()]);
  }

  /* =========================================================
     Cor dos botões (escolhida por cada pessoa)
     ========================================================= */
  const ACCENTS = [
    { id: 'roxo', name: 'Roxo', color: '#7c3aed' },
    { id: 'azul', name: 'Azul', color: '#2563eb' },
    { id: 'verde', name: 'Verde', color: '#059669' },
    { id: 'rosa', name: 'Rosa', color: '#db2777' },
    { id: 'laranja', name: 'Laranja', color: '#ea580c' },
    { id: 'ciano', name: 'Ciano', color: '#0891b2' },
  ];

  function currentAccent() {
    return document.documentElement.dataset.accent || 'roxo';
  }

  function applyAccent(id) {
    const valid = ACCENTS.some((a) => a.id === id) ? id : 'roxo';
    if (valid === 'roxo') document.documentElement.removeAttribute('data-accent');
    else document.documentElement.dataset.accent = valid;
    try { localStorage.setItem('saturnia-accent', valid); } catch (e) {}
    markSwatches();
  }

  function markSwatches() {
    const active = currentAccent();
    document.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.accent === active)));
  }

  function renderSwatches(container, onPick) {
    container.innerHTML = '';
    for (const a of ACCENTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.dataset.accent = a.id;
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', a.name);
      b.title = a.name;
      b.style.setProperty('--swatch', a.color);
      b.innerHTML = `<span class="swatch__dot"></span><span class="swatch__name">${a.name}</span>`;
      b.addEventListener('click', () => onPick(a.id));
      container.appendChild(b);
    }
    markSwatches();
  }

  /* =========================================================
     Boas-vindas: nome e cor no primeiro acesso
     ========================================================= */
  const onboard = $('onboard');
  let onboardName = '';

  function showOnboardStep(n) {
    $('onboard-step-1').hidden = n !== 1;
    $('onboard-step-2').hidden = n !== 2;
    onboard.querySelectorAll('.onboard__steps i').forEach((dot, i) => dot.classList.toggle('is-on', i < n));
    if (n === 1) setTimeout(() => { const i = $('onboard-name'); i.focus(); i.select(); }, 50);
  }

  function openOnboarding() {
    $('onboard-name').value = user.name || '';
    $('onboard-error').textContent = '';
    renderSwatches($('onboard-swatches'), (id) => applyAccent(id));
    onboard.hidden = false;
    showOnboardStep(1);
  }

  $('onboard-name-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const name = $('onboard-name').value.trim().replace(/\s+/g, ' ');
    if (!name) { $('onboard-error').textContent = 'Me diga como você quer ser chamado.'; return; }
    $('onboard-error').textContent = '';
    onboardName = name;
    showOnboardStep(2);
  });
  $('onboard-back').addEventListener('click', () => showOnboardStep(1));
  $('onboard-finish').addEventListener('click', async () => {
    const btn = $('onboard-finish');
    btn.disabled = true;
    btn.textContent = 'Salvando…';
    try {
      await saveMe({ name: onboardName, accent: currentAccent(), onboarded: true });
      onboard.hidden = true;
      input.focus();
    } catch (err) {
      if (err.code !== 'unauthorized') {
        showOnboardStep(1);
        $('onboard-error').textContent = ERRORS[err.code] || ERRORS.default;
      }
    } finally {
      btn.disabled = false;
      btn.textContent = 'Começar a conversar';
    }
  });

  /* =========================================================
     Barra lateral e conversas
     ========================================================= */
  function setSidebar(open) {
    document.body.classList.toggle('sidebar-open', open);
    $('backdrop').hidden = !open;
  }
  $('menu-btn').addEventListener('click', () => setSidebar(true));
  $('sidebar-close').addEventListener('click', () => setSidebar(false));
  $('backdrop').addEventListener('click', () => setSidebar(false));

  async function loadConversations() {
    try {
      const data = await api('/conversations');
      conversations = data.conversations || [];
      renderConversations();
    } catch (e) {
      if (e.code !== 'unauthorized') convList.innerHTML = '<p class="conv-empty">Não consegui carregar suas conversas.</p>';
    }
  }

  function renderConversations() {
    convList.innerHTML = '';
    if (!conversations.length) {
      convList.innerHTML = '<p class="conv-empty">Suas conversas vão aparecer aqui.</p>';
      return;
    }
    for (const c of conversations) {
      const item = document.createElement('div');
      item.className = `conv${c.id === currentId ? ' is-active' : ''}`;

      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'conv__open';
      open.textContent = c.title;
      open.title = c.title;
      open.addEventListener('click', () => openConversation(c.id));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'conv__del';
      del.textContent = 'Apagar';
      del.setAttribute('aria-label', `Apagar a conversa ${c.title}`);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!del.classList.contains('is-confirm')) {
          del.classList.add('is-confirm');
          del.textContent = 'Confirmar?';
          setTimeout(() => { del.classList.remove('is-confirm'); del.textContent = 'Apagar'; }, 3000);
          return;
        }
        deleteConversation(c.id);
      });

      item.append(open, del);
      convList.appendChild(item);
    }
  }

  async function deleteConversation(id) {
    try {
      await api(`/conversations/${id}`, { method: 'DELETE' });
      conversations = conversations.filter((c) => c.id !== id);
      if (id === currentId) newChat();
      renderConversations();
    } catch (e) {}
  }

  async function openConversation(id) {
    if (controller) controller.abort();
    if (currentView !== 'chat') showView('chat');
    setSidebar(false);
    currentId = id;
    renderConversations();
    const conv = conversations.find((c) => c.id === id);
    topTitle.textContent = conv ? conv.title : '';
    setEmpty(false);
    thread.innerHTML = '<p class="thread-loading">Carregando conversa…</p>';
    try {
      const data = await api(`/conversations/${id}`);
      if (currentId !== id) return;
      thread.innerHTML = '';
      for (const m of data.messages) {
        if (m.role === 'user') addUserMessage(m.content);
        else {
          const el = addAssistantMessage();
          el.classList.remove('is-streaming');
          renderInto(el, m.content);
          addTools(el, m.content);
        }
      }
      app.style.scrollBehavior = 'auto';
      app.scrollTop = app.scrollHeight;
      app.style.scrollBehavior = '';
    } catch (e) {
      if (e.code === 'unauthorized') return;
      thread.innerHTML = `<p class="thread-loading">${ERRORS[e.code] || ERRORS.default}</p>`;
      if (e.code === 'not_found') loadConversations();
    }
  }

  function newChat() {
    if (controller) controller.abort();
    if (currentView !== 'chat') showView('chat');
    currentId = null;
    thread.innerHTML = '';
    topTitle.textContent = '';
    setEmpty(true);
    setMode('idle');
    renderConversations();
    input.value = '';
    autosize();
    setSidebar(false);
    input.focus();
  }
  $('new-chat').addEventListener('click', newChat);

  /* ---------- Abas: conversa, Imagens (Júpiter) e Explorar (Terra) ---------- */
  const VIEW_TITLES = { images: 'Imagens', explore: 'Explorar' };
  let currentView = 'chat';

  function showView(name) {
    currentView = name;
    ['chat', 'images', 'explore'].forEach((v) => { $(`view-${v}`).hidden = v !== name; });
    document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
    if (name !== 'chat') {
      topTitle.textContent = VIEW_TITLES[name];
      currentId = null;
      renderConversations();
    }
    setSidebar(false);
    window.dispatchEvent(new CustomEvent('saturnia:view', { detail: name }));
  }

  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => showView(b.dataset.view)));

  /* =========================================================
     Memórias
     ========================================================= */
  const memModal = $('memories');
  const memList = $('mem-list');
  const memClear = $('mem-clear');

  async function refreshMemoryCount() {
    try {
      const data = await api('/memories');
      $('mem-count').textContent = data.memories.length ? String(data.memories.length) : '';
      return data.memories;
    } catch (e) {
      return null;
    }
  }

  function renderMemories(memories) {
    memList.innerHTML = '';
    if (!memories || !memories.length) {
      memList.innerHTML = '<li class="mem-empty">Ainda não lembro de nada sobre você. Conte um pouco sobre você numa conversa!</li>';
      memClear.hidden = true;
      return;
    }
    memClear.hidden = false;
    for (const m of memories) {
      const li = document.createElement('li');
      const text = document.createElement('span');
      text.textContent = m.content;
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'mem-del';
      del.textContent = 'Esquecer';
      del.addEventListener('click', async () => {
        try {
          await api(`/memories/${m.id}`, { method: 'DELETE' });
          li.remove();
          const rest = await refreshMemoryCount();
          if (rest && !rest.length) renderMemories([]);
        } catch (e) {}
      });
      li.append(text, del);
      memList.appendChild(li);
    }
  }

  async function openMemories() {
    setSidebar(false);
    memModal.hidden = false;
    memList.innerHTML = '<li class="mem-empty">Carregando…</li>';
    memClear.classList.remove('is-confirm');
    memClear.textContent = 'Esquecer tudo';
    renderMemories(await refreshMemoryCount());
    $('mem-close').focus();
  }
  function closeMemories() { memModal.hidden = true; }

  $('open-memories').addEventListener('click', openMemories);
  $('mem-close').addEventListener('click', closeMemories);
  memModal.addEventListener('click', (e) => { if (e.target === memModal) closeMemories(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeMemories(); closeSettings(); setSidebar(false); }
  });

  /* =========================================================
     Configurações: Perfil, Aparência, Chat, Conta e dados
     ========================================================= */
  const settingsModal = $('settings');
  const root = document.documentElement;
  const themeButtons = document.querySelectorAll('[data-theme-choice]');
  const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
  };

  /* ---------- Abas ---------- */
  const tabs = settingsModal.querySelectorAll('.settings__tab');
  function showTab(name) {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('is-active', on);
      t.setAttribute('aria-selected', String(on));
    });
    settingsModal.querySelectorAll('.settings__panel').forEach((p) => { p.hidden = p.dataset.panel !== name; });
    settingsModal.querySelector('.settings__panels').scrollTop = 0;
    if (name === 'perfil' || name === 'dados') loadStats();
  }
  tabs.forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));

  /* ---------- Tema: claro, escuro ou automático ---------- */
  function themeChoice() { return store.get('saturnia-theme', 'light'); }
  function applyTheme(choice) {
    if (!['light', 'dark', 'system'].includes(choice)) choice = 'light';
    const theme = choice === 'system' ? (darkQuery.matches ? 'dark' : 'light') : choice;
    root.dataset.theme = theme;
    store.set('saturnia-theme', choice);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(root).getPropertyValue('--bg').trim() || (theme === 'dark' ? '#09070d' : '#ffffff');
    themeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === choice)));
  }
  themeButtons.forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
  darkQuery.addEventListener('change', () => { if (themeChoice() === 'system') applyTheme('system'); });

  /* ---------- Cor do layout (fundo, barra lateral e cartões) ---------- */
  const LAYOUTS = [
    { id: 'lavanda', name: 'Lavanda', desc: 'Padrão', light: ['#ffffff', '#faf7ff', '#ece3fc'], dark: ['#09070d', '#0f0c15', '#231934'] },
    { id: 'ameixa', name: 'Ameixa', desc: 'Roxo intenso', light: ['#fdfaff', '#f5ecff', '#e6d5fb'], dark: ['#110a1b', '#180e26', '#2d1a45'] },
    { id: 'neutro', name: 'Neutro', desc: 'Cinza limpo', light: ['#ffffff', '#f7f7f8', '#e9e9ec'], dark: ['#0b0b0c', '#121214', '#232327'] },
    { id: 'noite', name: 'Noite', desc: 'Azul-marinho', light: ['#ffffff', '#f5f8fd', '#e2e9f5'], dark: ['#070b14', '#0c1322', '#18233a'] },
    { id: 'contraste', name: 'Contraste', desc: 'Preto e branco puros', light: ['#ffffff', '#ffffff', '#e5e5e5'], dark: ['#000000', '#000000', '#1f1f1f'] },
  ];
  function currentLayout() { return root.dataset.layout || 'lavanda'; }
  function applyLayout(id) {
    const valid = LAYOUTS.some((l) => l.id === id) ? id : 'lavanda';
    if (valid === 'lavanda') root.removeAttribute('data-layout');
    else root.dataset.layout = valid;
    store.set('saturnia-layout', valid);
    document.querySelectorAll('.layout').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.layout === valid)));
    applyTheme(themeChoice()); // atualiza a cor da barra do navegador
  }
  (function renderLayouts() {
    const box = $('settings-layouts');
    for (const l of LAYOUTS) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'layout';
      b.dataset.layout = l.id;
      b.setAttribute('role', 'radio');
      b.style.setProperty('--l1', l.light[0]); b.style.setProperty('--l2', l.light[1]); b.style.setProperty('--l3', l.light[2]);
      b.style.setProperty('--d1', l.dark[0]); b.style.setProperty('--d2', l.dark[1]); b.style.setProperty('--d3', l.dark[2]);
      b.innerHTML = `<span class="layout__preview" aria-hidden="true"><i></i><i></i><i></i></span>
        <span class="layout__name">${l.name}</span><span class="layout__desc">${l.desc}</span>`;
      b.addEventListener('click', async () => {
        const previous = currentLayout();
        applyLayout(l.id);
        try { await saveMe({ layout: l.id }); } catch (e) { applyLayout(previous); }
      });
      box.appendChild(b);
    }
  })();

  /* ---------- Cor dos botões ---------- */
  renderSwatches($('settings-swatches'), async (id) => {
    const previous = currentAccent();
    applyAccent(id);
    try { await saveMe({ accent: id }); } catch (e) { applyAccent(previous); }
  });

  /* ---------- Tamanho do texto ---------- */
  function applyTextSize(size) {
    if (!['p', 'm', 'g'].includes(size)) size = 'm';
    if (size === 'm') root.removeAttribute('data-text');
    else root.dataset.text = size;
    store.set('saturnia-text', size);
    $('text-size').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.size === size)));
  }
  $('text-size').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => applyTextSize(b.dataset.size)));

  /* ---------- Perfil ---------- */
  const fmtDate = (t) => new Date(t).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  function fillProfile() {
    if (!user) return;
    $('profile-avatar').textContent = (user.name || '?').trim().charAt(0).toUpperCase();
    $('profile-name').textContent = user.name;
    $('profile-email').textContent = user.email;
    const badges = [];
    if (user.google) badges.push('<span class="badge">Google</span>');
    if (user.hasPassword) badges.push('<span class="badge">E-mail e senha</span>');
    if (user.createdAt) badges.push(`<span class="badge badge--soft">Desde ${fmtDate(user.createdAt)}</span>`);
    $('profile-badges').innerHTML = badges.join('');
    // Senha: trocar (quem tem) ou criar (quem entrou só com o Google)
    $('pw-current-field').hidden = !user.hasPassword;
    $('pw-title').textContent = user.hasPassword ? 'Trocar senha' : 'Criar uma senha';
    $('pw-hint').textContent = user.hasPassword
      ? 'Ao trocar, você continua conectado aqui e sai dos outros aparelhos.'
      : 'Você entrou com o Google. Crie uma senha para também poder entrar com e-mail e senha.';
    $('pw-save').textContent = user.hasPassword ? 'Trocar senha' : 'Criar senha';
    $('pw-username').value = user.email;
    $('delete-pw-field').hidden = !user.hasPassword;
  }

  async function loadStats() {
    try {
      const s = await api('/me/stats');
      const item = (n, label) => `<div><dt>${label}</dt><dd>${n.toLocaleString('pt-BR')}</dd></div>`;
      $('profile-stats').innerHTML = item(s.conversations, 'Conversas') + item(s.messages, 'Mensagens')
        + item(s.memories, 'Memórias') + item(s.images, 'Imagens');
      $('sessions-info').textContent = s.sessions > 1
        ? `Você está conectado em ${s.sessions} lugares. Encerra todos, menos este.`
        : 'Você só está conectado aqui.';
    } catch (e) {}
  }

  $('name-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('settings-name-msg');
    const name = $('settings-name').value.trim().replace(/\s+/g, ' ');
    if (!name) { msg.textContent = 'Digite um nome.'; return; }
    const btn = $('settings-name-save');
    btn.disabled = true;
    try {
      await saveMe({ name });
      fillProfile();
      msg.textContent = `Pronto! Vou te chamar de ${name}.`;
    } catch (err) {
      msg.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      btn.disabled = false;
    }
  });

  // Força da senha (só uma dica visual)
  function passwordScore(p) {
    let s = 0;
    if (p.length >= 8) s++;
    if (p.length >= 12) s++;
    if (/[a-z]/.test(p) && /[A-Z]/.test(p)) s++;
    if (/\d/.test(p)) s++;
    if (/[^\w\s]/.test(p)) s++;
    return Math.min(4, s);
  }
  $('pw-new').addEventListener('input', () => {
    const p = $('pw-new').value;
    const meter = $('pw-meter');
    const score = p ? Math.max(1, passwordScore(p)) : 0;
    meter.style.width = `${score * 25}%`;
    meter.dataset.score = String(score);
  });
  $('pw-show').addEventListener('change', (e) => {
    ['pw-current', 'pw-new', 'pw-confirm'].forEach((id) => { $(id).type = e.target.checked ? 'text' : 'password'; });
  });
  $('pw-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('pw-msg');
    msg.className = 'settings__msg';
    const current = $('pw-current').value;
    const password = $('pw-new').value;
    if (user.hasPassword && !current) { msg.textContent = 'Digite a sua senha atual.'; return; }
    if (password.length < 8) { msg.textContent = ERRORS.weak_password; return; }
    if (password !== $('pw-confirm').value) { msg.textContent = 'As duas senhas novas não são iguais.'; return; }
    if (user.hasPassword && password === current) { msg.textContent = 'A nova senha precisa ser diferente da atual.'; return; }
    const btn = $('pw-save');
    btn.disabled = true;
    try {
      const created = !user.hasPassword;
      const data = await api('/me/password', { method: 'POST', body: { current, password } });
      user = data.user;
      $('pw-form').reset();
      $('pw-meter').style.width = '0';
      ['pw-current', 'pw-new', 'pw-confirm'].forEach((id) => { $(id).type = 'password'; });
      fillProfile();
      msg.textContent = created ? 'Senha criada! Agora você também pode entrar com e-mail e senha.' : 'Senha trocada! Os outros aparelhos foram desconectados.';
      msg.classList.add('is-ok');
      loadStats();
    } catch (err) {
      if (err.code !== 'unauthorized') msg.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      btn.disabled = false;
    }
  });

  /* ---------- Chat ---------- */
  function markStyles() {
    const active = (user && user.replyStyle) || 'equilibrado';
    $('reply-styles').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.style === active)));
  }
  $('reply-styles').querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
    const previous = user.replyStyle;
    user.replyStyle = b.dataset.style;
    markStyles();
    try { await saveMe({ replyStyle: b.dataset.style }); } catch (e) { user.replyStyle = previous; markStyles(); }
  }));

  const about = $('about');
  about.addEventListener('input', () => { $('about-msg').innerHTML = `<span id="about-count">${about.value.length}</span>/1000`; });
  $('about-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = $('about-save');
    btn.disabled = true;
    try {
      await saveMe({ about: about.value });
      $('about-msg').textContent = about.value.trim() ? 'Salvo! Vou levar isso em conta nas respostas.' : 'Apagado.';
    } catch (err) {
      if (err.code !== 'unauthorized') $('about-msg').textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      btn.disabled = false;
    }
  });

  const prefMemory = $('pref-memory');
  prefMemory.addEventListener('change', async () => {
    try { await saveMe({ memoryOn: prefMemory.checked }); } catch (e) { prefMemory.checked = !prefMemory.checked; }
  });

  // Preferências deste aparelho
  let enterToSend = store.get('saturnia-enter', '1') === '1';
  $('pref-enter').addEventListener('change', (e) => {
    enterToSend = e.target.checked;
    store.set('saturnia-enter', enterToSend ? '1' : '0');
  });
  function applySuggestions(show) {
    $('suggestions').hidden = !show;
    store.set('saturnia-suggestions', show ? '1' : '0');
  }
  $('pref-suggestions').addEventListener('change', (e) => applySuggestions(e.target.checked));

  /* ---------- Conta e dados ---------- */
  function confirmClick(btn, label, action) {
    btn.addEventListener('click', async () => {
      if (!btn.classList.contains('is-confirm')) {
        btn.classList.add('is-confirm');
        btn.textContent = 'Tem certeza?';
        setTimeout(() => { btn.classList.remove('is-confirm'); btn.textContent = label; }, 4000);
        return;
      }
      btn.classList.remove('is-confirm');
      btn.textContent = label;
      btn.disabled = true;
      try { await action(); } finally { btn.disabled = false; }
    });
  }
  const dataMsg = $('data-msg');

  confirmClick($('logout-others'), 'Sair dos outros', async () => {
    try {
      const r = await api('/auth/logout-others', { method: 'POST' });
      dataMsg.textContent = r.ended ? `Pronto! ${r.ended === 1 ? '1 aparelho foi desconectado' : `${r.ended} aparelhos foram desconectados`}.` : 'Não havia outros aparelhos conectados.';
      loadStats();
    } catch (err) { if (err.code !== 'unauthorized') dataMsg.textContent = ERRORS[err.code] || ERRORS.default; }
  });

  $('export-data').addEventListener('click', async () => {
    const btn = $('export-data');
    btn.disabled = true;
    btn.textContent = 'Preparando…';
    try {
      const data = await api('/me/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `saturnia-dados-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      dataMsg.textContent = 'Arquivo baixado.';
    } catch (err) {
      if (err.code !== 'unauthorized') dataMsg.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Baixar';
    }
  });

  confirmClick($('clear-convs'), 'Apagar', async () => {
    try {
      await api('/conversations', { method: 'DELETE' });
      conversations = [];
      renderConversations();
      newChat();
      dataMsg.textContent = 'Todas as conversas foram apagadas.';
      loadStats();
    } catch (err) { if (err.code !== 'unauthorized') dataMsg.textContent = ERRORS[err.code] || ERRORS.default; }
  });

  $('delete-open').addEventListener('click', () => {
    $('delete-open').hidden = true;
    $('delete-form').hidden = false;
    $(user.hasPassword ? 'delete-pw' : 'delete-confirm').focus();
  });
  $('delete-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const msg = $('delete-msg');
    const confirm = $('delete-confirm').value.trim().toUpperCase();
    if (confirm !== 'EXCLUIR') { msg.textContent = 'Digite EXCLUIR para confirmar.'; return; }
    if (user.hasPassword && !$('delete-pw').value) { msg.textContent = 'Digite a sua senha.'; return; }
    const btn = $('delete-submit');
    btn.disabled = true;
    btn.textContent = 'Excluindo…';
    try {
      await api('/me', { method: 'DELETE', body: { confirm, password: $('delete-pw').value } });
      closeSettings();
      signOut('Sua conta foi excluída. Até mais!');
    } catch (err) {
      if (err.code !== 'unauthorized') msg.textContent = ERRORS[err.code] || ERRORS.default;
    } finally {
      btn.disabled = false;
      btn.textContent = 'Excluir para sempre';
    }
  });

  /* ---------- Abrir e fechar ---------- */
  function openSettings(tab) {
    setSidebar(false);
    applyTheme(themeChoice());
    applyLayout(currentLayout());
    applyTextSize(store.get('saturnia-text', 'm'));
    markSwatches();
    markStyles();
    fillProfile();
    $('settings-name').value = user ? user.name : '';
    $('settings-email').value = user ? user.email : '';
    about.value = (user && user.about) || '';
    $('about-msg').innerHTML = `<span id="about-count">${about.value.length}</span>/1000`;
    prefMemory.checked = !user || user.memoryOn !== false;
    $('pref-enter').checked = enterToSend;
    $('pref-suggestions').checked = !$('suggestions').hidden;
    ['settings-name-msg', 'pw-msg', 'data-msg', 'delete-msg'].forEach((id) => { $(id).textContent = ''; });
    $('pw-form').reset();
    $('pw-meter').style.width = '0';
    $('delete-form').reset();
    $('delete-form').hidden = true;
    $('delete-open').hidden = false;
    settingsModal.hidden = false;
    showTab(typeof tab === 'string' ? tab : 'perfil');
    $('settings-close').focus();
  }
  function closeSettings() { settingsModal.hidden = true; }

  $('open-settings').addEventListener('click', () => openSettings());
  $('settings-close').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
  // Clicar no seu nome (na barra lateral) abre o perfil
  document.querySelector('.user__info').addEventListener('click', () => openSettings('perfil'));

  applyTheme(themeChoice());
  applySuggestions(store.get('saturnia-suggestions', '1') === '1');
  memClear.addEventListener('click', async () => {
    if (!memClear.classList.contains('is-confirm')) {
      memClear.classList.add('is-confirm');
      memClear.textContent = 'Tem certeza? Clique de novo';
      return;
    }
    try {
      await api('/memories', { method: 'DELETE' });
      $('mem-count').textContent = '';
      renderMemories([]);
    } catch (e) {}
    memClear.classList.remove('is-confirm');
    memClear.textContent = 'Esquecer tudo';
  });

  /* =========================================================
     Chat
     ========================================================= */
  const STATUS = { idle: 'Observando', thinking: 'Pensando', speaking: 'Respondendo' };
  function setMode(mode) {
    if (eye) eye.setState(mode);
    statusEl.textContent = STATUS[mode];
    document.body.classList.toggle('is-busy', mode !== 'idle');
    updateSendButton();
  }

  function updateSendButton() {
    const busy = document.body.classList.contains('is-busy');
    sendBtn.disabled = !busy && !input.value.trim();
    sendBtn.setAttribute('aria-label', busy ? 'Parar resposta' : 'Enviar mensagem');
  }

  function setEmpty(empty) {
    app.dataset.empty = String(empty);
    document.body.classList.toggle('is-chatting', !empty);
  }

  function nearBottom() { return app.scrollHeight - app.scrollTop - app.clientHeight < 140; }
  function scrollToBottom(force) { if (force || nearBottom()) app.scrollTop = app.scrollHeight; }

  function addUserMessage(text) {
    const el = document.createElement('div');
    el.className = 'msg msg--user';
    const body = document.createElement('div');
    body.className = 'msg__body';
    body.textContent = text;
    el.appendChild(body);
    thread.appendChild(el);
    scrollToBottom(true);
  }

  function addAssistantMessage() {
    const el = document.createElement('div');
    el.className = 'msg msg--assistant is-streaming';
    el.innerHTML = `
      <span class="msg__avatar" aria-hidden="true"></span>
      <div class="msg__content">
        <div class="msg__body"><span class="thinking" aria-label="Pensando"><span></span><span></span><span></span></span></div>
      </div>`;
    thread.appendChild(el);
    scrollToBottom(true);
    return el;
  }

  function renderInto(el, text) {
    el.querySelector('.msg__body').innerHTML = window.renderMarkdown(text);
  }

  function addNote(el, text, isError) {
    const note = document.createElement('p');
    note.className = `msg__note${isError ? ' msg__note--error' : ''}`;
    note.textContent = text;
    el.querySelector('.msg__content').appendChild(note);
  }

  function addTools(el, text) {
    const tools = document.createElement('div');
    tools.className = 'msg__tools';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copiar';
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        copy.textContent = 'Copiado';
      } catch (e) {
        copy.textContent = 'Não deu para copiar';
      }
      setTimeout(() => { copy.textContent = 'Copiar'; }, 1800);
    });
    tools.appendChild(copy);
    el.querySelector('.msg__content').appendChild(tools);
  }

  // Coloca a conversa no topo da lista (ou cria, se for nova)
  function touchConversation(id, title) {
    const existing = conversations.find((c) => c.id === id);
    conversations = conversations.filter((c) => c.id !== id);
    conversations.unshift(existing || { id, title, updated_at: Date.now() });
    renderConversations();
  }

  async function send(text) {
    if (controller || !user) return;
    text = text.trim().slice(0, MAX_USER_CHARS);
    if (!text) return;

    setEmpty(false);
    addUserMessage(text);
    input.value = '';
    autosize();

    const el = addAssistantMessage();
    setMode('thinking');

    controller = new AbortController();
    let answer = '';
    let renderQueued = false;
    let finishedOk = false;

    const queueRender = () => {
      if (renderQueued) return;
      renderQueued = true;
      requestAnimationFrame(() => {
        renderQueued = false;
        renderInto(el, answer);
        scrollToBottom(false);
      });
    };

    try {
      const res = await api('/chat', {
        method: 'POST',
        body: { conversationId: currentId, message: text },
        signal: controller.signal,
        raw: true,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let idx;
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const raw = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          if (!raw.startsWith('data: ')) continue;
          const event = JSON.parse(raw.slice(6));

          if (event.type === 'conversation') {
            currentId = event.id;
            topTitle.textContent = event.title;
            touchConversation(event.id, event.title);
          } else if (event.type === 'text') {
            if (!answer) setMode('speaking');
            answer += event.text;
            if (eye) eye.pulse();
            queueRender();
          } else if (event.type === 'error') {
            throw new ApiError(event.code || 'default', 500);
          } else if (event.type === 'done') {
            finishedOk = true;
          }
        }
      }
      if (!finishedOk && !answer) throw new ApiError('default', 500);
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!answer) renderInto(el, '*Resposta interrompida.*');
        else addNote(el, 'Resposta interrompida.');
      } else if (err.code !== 'unauthorized') {
        if (!answer) el.querySelector('.msg__body').innerHTML = '';
        addNote(el, ERRORS[err.code] || ERRORS.default, true);
      }
    } finally {
      controller = null;
      el.classList.remove('is-streaming');
      if (answer) {
        renderInto(el, answer);
        addTools(el, answer);
      }
      setMode('idle');
      scrollToBottom(false);
      input.focus();
      // A memória é atualizada no servidor logo depois da resposta
      setTimeout(refreshMemoryCount, 4000);
    }
  }

  /* ---------- Caixa de texto ---------- */
  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
    updateSendButton();
  }

  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return;
    if (enterToSend || e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (!controller) send(input.value);
    }
  });

  $('composer').addEventListener('submit', (e) => {
    e.preventDefault();
    if (controller) controller.abort();
    else send(input.value);
  });

  $('suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) send(btn.textContent);
  });

  /* =========================================================
     Início
     ========================================================= */
  async function boot() {
    if (!API) {
      showAuth('O servidor da SaturnIA não está configurado (js/config.js).');
      return;
    }
    if (!token) { showAuth(); return; }
    try {
      const data = await api('/me');
      await enterApp(data.user);
    } catch (e) {
      if (e.code === 'unauthorized') return; // sessionExpired já mostrou o login
      saveToken(null);
      showAuth(e.code === 'network' ? ERRORS.network : '');
    }
  }

  window.SaturnApp = {
    api,
    errors: ERRORS,
    getUser: () => user,
    getView: () => currentView,
  };

  updateSendButton();
  boot();
})();
