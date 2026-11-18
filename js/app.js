/* =========================================================
   SaturnIA · lógica do chat
   ========================================================= */

/* ---------- Atualização automática ----------
   O GitHub Pages deixa a página em cache por 10 minutos. Ao abrir, a
   SaturnIA confere version.json (sempre buscado sem cache); se houver
   uma versão mais nova publicada, ela baixa a página atual e recarrega
   uma única vez. A cada publicação, aumente APP_VERSION e version.json juntos. */
(function checkForUpdate() {
  const APP_VERSION = '5';
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
  const API_URL = (window.SATURNIA_CONFIG && window.SATURNIA_CONFIG.apiUrl) || '';
  const MAX_HISTORY = 15;          // mensagens enviadas ao servidor (sempre começa com 'user')
  const MAX_ASSISTANT_CHARS = 12000;

  const ERRORS = {
    rate_limited: 'Muitas mensagens em pouco tempo. Espere um minutinho e tente de novo.',
    origin_not_allowed: 'Este site não tem permissão para falar com o servidor da SaturnIA.',
    invalid_request: 'Não consegui entender essa mensagem. Tente reformular.',
    quota: 'Por hoje eu já pensei demais: a cota gratuita do dia acabou. Volte amanhã!',
    overloaded: 'A IA está sobrecarregada agora. Tente de novo em instantes.',
    network: 'Não consegui me conectar ao servidor. Verifique sua internet.',
    default: 'Algo deu errado do meu lado. Tente de novo.',
  };

  const app = document.getElementById('app');
  const thread = document.getElementById('thread');
  const form = document.getElementById('composer');
  const input = document.getElementById('input');
  const sendBtn = document.getElementById('send');
  const statusEl = document.getElementById('status');
  const eye = new window.SaturnEye(document.getElementById('eye'));

  const MAX_USER_CHARS = 6000;
  const history = []; // { role: 'user' | 'assistant', content: string }
  let controller = null;

  /* ---------- Estado visual ---------- */
  const STATUS = { idle: 'Observando', thinking: 'Pensando', speaking: 'Respondendo' };
  function setMode(mode) {
    eye.setState(mode);
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
    requestAnimationFrame(() => eye.resize());
    setTimeout(() => eye.resize(), 750); // depois da transição de altura
  }

  /* ---------- Rolagem ---------- */
  function nearBottom() {
    return app.scrollHeight - app.scrollTop - app.clientHeight < 140;
  }
  function scrollToBottom(force) {
    if (force || nearBottom()) app.scrollTop = app.scrollHeight;
  }

  /* ---------- Mensagens na tela ---------- */
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
      <div class="msg__content" style="flex:1;min-width:0">
        <div class="msg__body"><span class="thinking" aria-label="Pensando"><span></span><span></span><span></span></span></div>
      </div>`;
    thread.appendChild(el);
    scrollToBottom(true);
    return el;
  }

  function renderInto(el, text) {
    const body = el.querySelector('.msg__body');
    body.innerHTML = window.renderMarkdown(text);
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

  /* ---------- Conversa com o servidor ---------- */
  class ChatError extends Error {
    constructor(code) { super(code); this.code = code; }
  }

  function messagesForServer() {
    let msgs = history.slice(-MAX_HISTORY);
    if (msgs[0] && msgs[0].role !== 'user') msgs = msgs.slice(1);
    return msgs;
  }

  async function send(text) {
    if (controller) return;
    text = text.trim().slice(0, MAX_USER_CHARS);
    if (!text) return;

    setEmpty(false);
    addUserMessage(text);
    history.push({ role: 'user', content: text });
    input.value = '';
    autosize();

    const el = addAssistantMessage();
    setMode('thinking');

    if (!API_URL) {
      await new Promise((r) => setTimeout(r, 900));
      renderInto(el, 'Meu servidor ainda não foi configurado, então ainda não consigo pensar de verdade.\n\nPara me ligar, publique a pasta `worker/` na Cloudflare e coloque o endereço em `js/config.js`. Os passos estão no README do projeto.');
      el.classList.remove('is-streaming');
      history.pop();
      setMode('idle');
      return;
    }

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
      let res;
      try {
        res = await fetch(API_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ messages: messagesForServer() }),
          signal: controller.signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw new ChatError('network');
      }

      if (!res.ok || !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new ChatError(data.error || 'default');
      }

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

          if (event.type === 'text') {
            if (!answer) setMode('speaking');
            answer += event.text;
            eye.pulse();
            queueRender();
          } else if (event.type === 'reset') {
            answer = '';
            queueRender();
          } else if (event.type === 'refusal') {
            addNote(el, 'Prefiro não responder a isso. Que tal reformular a pergunta?');
          } else if (event.type === 'truncated') {
            addNote(el, 'A resposta ficou longa demais e foi cortada. Peça para eu continuar.');
          } else if (event.type === 'error') {
            throw new ChatError(event.code || 'default');
          } else if (event.type === 'done') {
            finishedOk = true;
          }
        }
      }
      if (!finishedOk && !answer) throw new ChatError('default');
    } catch (err) {
      if (err.name === 'AbortError') {
        if (!answer) renderInto(el, '*Resposta interrompida.*');
        else addNote(el, 'Resposta interrompida.');
      } else {
        if (!answer) el.querySelector('.msg__body').innerHTML = '';
        addNote(el, ERRORS[err.code] || ERRORS.default, true);
      }
    } finally {
      controller = null;
      el.classList.remove('is-streaming');
      if (answer) {
        renderInto(el, answer);
        addTools(el, answer);
        history.push({ role: 'assistant', content: answer.slice(0, MAX_ASSISTANT_CHARS) });
      } else {
        // sem resposta: tira a pergunta do histórico para manter user/assistant alternados
        history.pop();
      }
      setMode('idle');
      scrollToBottom(false);
      input.focus();
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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (controller) controller.abort();
    else send(input.value);
  });

  document.getElementById('suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) send(btn.textContent);
  });

  document.getElementById('new-chat').addEventListener('click', () => {
    if (controller) controller.abort();
    history.length = 0;
    thread.innerHTML = '';
    setEmpty(true);
    setMode('idle');
    input.value = '';
    autosize();
    input.focus();
  });

  updateSendButton();
  input.focus();
})();
