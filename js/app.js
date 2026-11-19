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
  const APP_VERSION = '8';
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
    renderGoogleButton();
    setTimeout(() => authForm.elements.namedItem('email').focus(), 50);
  }

  /* ---------- Login com o Google ---------- */
  const GOOGLE_CLIENT_ID = (window.SATURNIA_CONFIG && window.SATURNIA_CONFIG.googleClientId) || '';
  let googleReady = false;

  // A biblioteca do Google carrega em paralelo: espera até ela existir
  function whenGoogleLoaded(callback, tries = 0) {
    if (window.google && window.google.accounts && window.google.accounts.id) callback();
    else if (tries < 100) setTimeout(() => whenGoogleLoaded(callback, tries + 1), 100);
  }

  async function onGoogleCredential(response) {
    authError.textContent = '';
    try {
      const data = await api('/auth/google', { method: 'POST', body: { credential: response.credential } });
      saveToken(data.token);
      await enterApp(data.user);
    } catch (err) {
      authError.textContent = ERRORS[err.code] || ERRORS.default;
    }
  }

  function renderGoogleButton() {
    if (!GOOGLE_CLIENT_ID) return;
    whenGoogleLoaded(() => {
      if (!googleReady) {
        window.google.accounts.id.initialize({
          client_id: GOOGLE_CLIENT_ID,
          callback: onGoogleCredential,
          ux_mode: 'popup',
          context: 'signin',
        });
        googleReady = true;
      }
      const area = $('google-area');
      const holder = $('google-btn');
      area.hidden = false;
      holder.innerHTML = '';
      window.google.accounts.id.renderButton(holder, {
        type: 'standard',
        theme: document.documentElement.dataset.theme === 'dark' ? 'filled_black' : 'outline',
        size: 'large',
        shape: 'pill',
        text: 'continue_with',
        logo_alignment: 'left',
        locale: 'pt-BR',
        width: Math.min(holder.clientWidth || 336, 400),
      });
    });
  }

  function sessionExpired() {
    if (controller) controller.abort();
    saveToken(null);
    user = null;
    showAuth('Sua sessão expirou. Entre de novo.');
  }

  $('logout').addEventListener('click', async () => {
    try { await api('/auth/logout', { method: 'POST' }); } catch (e) {}
    // Não entra de novo automaticamente com o Google depois de sair
    if (googleReady) window.google.accounts.id.disableAutoSelect();
    if (controller) controller.abort();
    saveToken(null);
    user = null;
    conversations = [];
    currentId = null;
    thread.innerHTML = '';
    showAuth();
  });

  async function enterApp(u) {
    user = u;
    authEl.hidden = true;
    shell.hidden = false;
    ensureEye();
    $('user-name').textContent = u.name;
    $('user-email').textContent = u.email;
    $('user-avatar').textContent = (u.name || '?').trim().charAt(0).toUpperCase();
    $('intro-name').textContent = `, ${u.name.split(' ')[0]}`;
    newChat();
    await Promise.all([loadConversations(), refreshMemoryCount()]);
  }

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
     Configurações (tema claro / escuro)
     ========================================================= */
  const settingsModal = $('settings');
  const themeButtons = document.querySelectorAll('[data-theme-choice]');

  function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
  }

  function applyTheme(theme) {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('saturnia-theme', theme); } catch (e) {}
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#09070d' : '#ffffff';
    themeButtons.forEach((b) => b.setAttribute('aria-checked', String(b.dataset.themeChoice === theme)));
  }

  function openSettings() {
    setSidebar(false);
    applyTheme(currentTheme()); // marca a opção atual
    settingsModal.hidden = false;
    $('settings-close').focus();
  }
  function closeSettings() { settingsModal.hidden = true; }

  themeButtons.forEach((b) => b.addEventListener('click', () => applyTheme(b.dataset.themeChoice)));
  $('open-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  settingsModal.addEventListener('click', (e) => { if (e.target === settingsModal) closeSettings(); });
  applyTheme(currentTheme());
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
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
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

  updateSendButton();
  boot();
})();
