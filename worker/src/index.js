/* =========================================================
   SaturnIA · servidor (Cloudflare Worker + Workers AI + D1)
   ---------------------------------------------------------
   Rotas:
     POST   /auth/register      cria conta  { name, email, password }
     POST   /auth/login         entra       { email, password }
     POST   /auth/logout        sai
     GET    /me                 usuário atual
     GET    /conversations      lista de conversas
     GET    /conversations/:id  mensagens de uma conversa
     DELETE /conversations/:id  apaga uma conversa
     GET    /memories           fatos lembrados
     DELETE /memories/:id       esquece um fato
     DELETE /memories           esquece tudo
     POST   /chat               conversa { conversationId?, message } (stream SSE)
   ========================================================= */

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const DEFAULT_MEMORY_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

const BASE_PROMPT = `Você é a SaturnIA, uma assistente de IA de uso geral criada por Ryan Moreira, desenvolvedor full-stack brasileiro. Seu símbolo é um olho feito de partículas, com um anel como o de Saturno.

Responda no idioma em que a pessoa escrever (o padrão é português do Brasil). Seja clara, calorosa e direta: vá ao ponto, explique com exemplos quando ajudar e use Markdown (listas, negrito, blocos de código) só quando deixar a resposta mais fácil de ler. Se não souber algo, diga que não sabe em vez de inventar.

Você tem memória: fatos importantes que a pessoa conta são guardados automaticamente e aparecem abaixo nas próximas conversas. Use-os com naturalidade quando forem úteis, sem ficar repetindo. A pessoa pode ver e apagar essas memórias no menu "Memórias".

Se perguntarem qual tecnologia você usa: você roda com o modelo Llama, da Meta, na plataforma Workers AI da Cloudflare, dentro de uma interface criada pelo Ryan. Se perguntarem sobre o Ryan, conte que ele é desenvolvedor full-stack, trabalha com back-end e APIs REST e está se aprofundando em IA Generativa, e indique o portfólio dele: https://ryanng0104.github.io/portfolio/`;

// Limites
const MAX_MESSAGE_CHARS = 6000;
const HISTORY_LIMIT = 16;         // mensagens anteriores enviadas ao modelo
const MAX_OUTPUT_TOKENS = 2048;
const MAX_MEMORIES = 40;          // fatos guardados por usuário
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000; // máximo aceito pelo Workers

/* ---------------------------------------------------------
   Utilidades
   --------------------------------------------------------- */
const encoder = new TextEncoder();

function toB64url(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(str) {
  const s = atob(str.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}
function randomToken(bytes = 32) {
  return toB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}
async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return toB64url(new Uint8Array(digest));
}
async function hashPassword(password, saltB64) {
  const salt = saltB64 ? fromB64url(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return { hash: toB64url(new Uint8Array(bits)), salt: toB64url(salt) };
}
function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------------------------------------------------
   Limite de requisições (por IP ou usuário, por minuto)
   --------------------------------------------------------- */
const hits = new Map();
function isRateLimited(key, limit) {
  const now = Date.now();
  const recent = (hits.get(key) || []).filter((t) => now - t < 60_000);
  recent.push(now);
  hits.set(key, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > limit;
}

/* ---------------------------------------------------------
   HTTP
   --------------------------------------------------------- */
function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}
function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) },
  });
}
async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

/* ---------------------------------------------------------
   Contas e sessões
   --------------------------------------------------------- */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function publicUser(u) {
  return { id: u.id, name: u.name, email: u.email };
}

async function createSession(env, userId) {
  const token = randomToken();
  const now = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256(token), userId, now, now + SESSION_DAYS * 86_400_000)
    .run();
  return token;
}

async function currentUser(request, env) {
  const auth = request.headers.get("Authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.name, u.email FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
  ).bind(await sha256(token), Date.now()).first();
  return row ? { ...row, tokenHash: await sha256(token) } : null;
}

async function register(request, env, cors) {
  const body = await readJson(request);
  const name = String((body && body.name) || "").trim();
  const email = String((body && body.email) || "").trim().toLowerCase();
  const password = String((body && body.password) || "");

  if (name.length < 1 || name.length > 60) return json({ error: "invalid_name" }, 400, cors);
  if (!EMAIL_RE.test(email) || email.length > 200) return json({ error: "invalid_email" }, 400, cors);
  if (password.length < 8 || password.length > 200) return json({ error: "weak_password" }, 400, cors);

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) return json({ error: "email_taken" }, 409, cors);

  const { hash, salt } = await hashPassword(password);
  const user = { id: crypto.randomUUID(), name, email };
  await env.DB.prepare(
    "INSERT INTO users (id, email, name, password_hash, password_salt, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(user.id, email, name, hash, salt, Date.now()).run();

  const token = await createSession(env, user.id);
  return json({ token, user: publicUser(user) }, 201, cors);
}

async function login(request, env, cors) {
  const body = await readJson(request);
  const email = String((body && body.email) || "").trim().toLowerCase();
  const password = String((body && body.password) || "");

  const user = await env.DB.prepare(
    "SELECT id, name, email, password_hash, password_salt FROM users WHERE email = ?",
  ).bind(email).first();

  // Calcula o hash mesmo se o e-mail não existir, para não revelar quais e-mails têm conta
  const check = await hashPassword(password, user ? user.password_salt : toB64url(new Uint8Array(16)));
  if (!user || !safeEqual(check.hash, user.password_hash)) {
    return json({ error: "invalid_credentials" }, 401, cors);
  }

  // Limpa sessões vencidas de vez em quando
  await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();

  const token = await createSession(env, user.id);
  return json({ token, user: publicUser(user) }, 200, cors);
}

/* ---------------------------------------------------------
   Conversas e memórias
   --------------------------------------------------------- */
async function listConversations(env, user, cors) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200",
  ).bind(user.id).all();
  return json({ conversations: results }, 200, cors);
}

async function getConversation(env, user, id, cors) {
  const conv = await env.DB.prepare(
    "SELECT id, title, updated_at FROM conversations WHERE id = ? AND user_id = ?",
  ).bind(id, user.id).first();
  if (!conv) return json({ error: "not_found" }, 404, cors);
  const { results } = await env.DB.prepare(
    "SELECT role, content, created_at FROM messages WHERE conversation_id = ? ORDER BY id",
  ).bind(id).all();
  return json({ conversation: conv, messages: results }, 200, cors);
}

async function deleteConversation(env, user, id, cors) {
  const conv = await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!conv) return json({ error: "not_found" }, 404, cors);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(id),
    env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(id),
  ]);
  return json({ ok: true }, 200, cors);
}

async function listMemories(env, user, cors) {
  const { results } = await env.DB.prepare(
    "SELECT id, content, created_at FROM memories WHERE user_id = ? ORDER BY id DESC",
  ).bind(user.id).all();
  return json({ memories: results }, 200, cors);
}

async function deleteMemory(env, user, id, cors) {
  if (id === null) {
    await env.DB.prepare("DELETE FROM memories WHERE user_id = ?").bind(user.id).run();
  } else {
    await env.DB.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?").bind(Number(id), user.id).run();
  }
  return json({ ok: true }, 200, cors);
}

// Usa um modelo menor para extrair fatos duradouros da mensagem do usuário
async function extractMemories(env, userId, message) {
  if (message.length < 12) return;
  const { results } = await env.DB.prepare(
    "SELECT content FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?",
  ).bind(userId, MAX_MEMORIES).all();
  const known = results.map((r) => r.content);

  const system = `Você extrai fatos pessoais que um usuário conta sobre si mesmo, para um assistente lembrar depois.
Guarde: nome, idade, cidade, profissão, estudos, família, animais, projetos, objetivos, hobbies, gostos e preferências de como quer as respostas.
Não guarde: perguntas, pedidos de tarefa, instruções pontuais (como "diga ok" ou "responda curto" só desta vez) nem fatos que não sejam sobre o usuário.
Responda SOMENTE com um array JSON de frases curtas em português, na terceira pessoa. Se não houver nenhum fato pessoal, responda [].

Exemplos:
Mensagem: "Oi, sou a Ana, tenho 23 anos e estudo medicina em Recife. Me explica o que é DNA?"
Resposta: ["Se chama Ana", "Tem 23 anos", "Estuda medicina", "Mora em Recife"]

Mensagem: "Quanto é 15% de 200?"
Resposta: []

Mensagem: "Trabalho com marketing e adoro café. Prefiro respostas bem diretas. Me dá uma ideia de post?"
Resposta: ["Trabalha com marketing", "Adora café", "Prefere respostas diretas"]`;

  const user = `${known.length ? `Fatos que já sei (não repita):\n${known.map((k) => `- ${k}`).join("\n")}\n\n` : ""}Mensagem: "${message.slice(0, 2000).replace(/"/g, "'")}"
Resposta:`;

  const input = {
    messages: [{ role: "system", content: system }, { role: "user", content: user }],
    max_tokens: 256,
  };

  try {
    // Tenta o modelo pequeno (economiza a cota); se ele falhar ou tiver sido desativado, usa o principal
    let out;
    try {
      out = await env.AI.run(env.MEMORY_MODEL || DEFAULT_MEMORY_MODEL, input);
    } catch (err) {
      console.warn("Modelo de memória indisponível, usando o principal:", err && err.message);
      out = await env.AI.run(env.MODEL || DEFAULT_MODEL, input);
    }

    // O Workers AI pode devolver texto ou o JSON já interpretado
    const response = out && typeof out === "object" && "response" in out ? out.response : out;
    let facts = Array.isArray(response) ? response : null;
    if (!facts) {
      const text = typeof response === "string" ? response : JSON.stringify(response || "");
      const start = text.indexOf("[");
      const end = text.lastIndexOf("]");
      if (start < 0 || end <= start) return;
      facts = JSON.parse(text.slice(start, end + 1));
    }
    if (!Array.isArray(facts)) return;

    const knownLower = new Set(known.map((k) => k.toLowerCase()));
    const fresh = facts
      .filter((f) => typeof f === "string")
      .map((f) => f.trim().replace(/\s+/g, " "))
      .filter((f) => f.length >= 3 && f.length <= 200 && !knownLower.has(f.toLowerCase()))
      .slice(0, 3);
    if (!fresh.length) return;

    const now = Date.now();
    await env.DB.batch([
      ...fresh.map((f) => env.DB.prepare("INSERT INTO memories (user_id, content, created_at) VALUES (?, ?, ?)").bind(userId, f, now)),
      // mantém só as memórias mais recentes
      env.DB.prepare(
        `DELETE FROM memories WHERE user_id = ? AND id NOT IN
         (SELECT id FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?)`,
      ).bind(userId, userId, MAX_MEMORIES),
    ]);
  } catch (err) {
    console.error("Falha ao extrair memórias:", err);
  }
}

/* ---------------------------------------------------------
   Chat
   --------------------------------------------------------- */
function errorCode(err) {
  const msg = String((err && err.message) || err).toLowerCase();
  if (msg.includes("neuron") || msg.includes("allocation") || msg.includes("quota") || msg.includes("4006")) return "quota";
  if (msg.includes("capacity") || msg.includes("overloaded") || msg.includes("3040")) return "overloaded";
  return "default";
}

function textFromEvent(data) {
  if (typeof data.response === "string") return data.response;
  const delta = data.choices && data.choices[0] && data.choices[0].delta;
  return delta && typeof delta.content === "string" ? delta.content : "";
}

async function chat(request, env, ctx, user, cors) {
  const body = await readJson(request);
  const message = String((body && body.message) || "").trim();
  if (!message || message.length > MAX_MESSAGE_CHARS) return json({ error: "invalid_request" }, 400, cors);

  const now = Date.now();
  let conv = null;
  let created = false;
  if (body.conversationId) {
    conv = await env.DB.prepare("SELECT id, title FROM conversations WHERE id = ? AND user_id = ?")
      .bind(String(body.conversationId), user.id).first();
    if (!conv) return json({ error: "not_found" }, 404, cors);
  } else {
    const title = message.replace(/\s+/g, " ").slice(0, 60) + (message.length > 60 ? "…" : "");
    conv = { id: crypto.randomUUID(), title };
    created = true;
    await env.DB.prepare("INSERT INTO conversations (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .bind(conv.id, user.id, conv.title, now, now).run();
  }

  // Histórico recente + memórias
  const [historyRes, memoriesRes] = await Promise.all([
    env.DB.prepare("SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?")
      .bind(conv.id, HISTORY_LIMIT).all(),
    env.DB.prepare("SELECT content FROM memories WHERE user_id = ? ORDER BY id DESC LIMIT ?")
      .bind(user.id, MAX_MEMORIES).all(),
  ]);
  const history = historyRes.results.reverse();
  while (history.length && history[0].role !== "user") history.shift();

  let system = `${BASE_PROMPT}\n\nVocê está conversando com ${user.name}.`;
  if (memoriesRes.results.length) {
    system += `\n\nO que você lembra sobre essa pessoa:\n${memoriesRes.results.map((m) => `- ${m.content}`).join("\n")}`;
  }

  // Salva a mensagem do usuário antes de responder
  await env.DB.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'user', ?, ?)")
    .bind(conv.id, message, now).run();

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const send = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  ctx.waitUntil((async () => {
    let answer = "";
    try {
      await send({ type: "conversation", id: conv.id, title: conv.title, created });

      const aiStream = await env.AI.run(env.MODEL || DEFAULT_MODEL, {
        messages: [{ role: "system", content: system }, ...history, { role: "user", content: message }],
        max_tokens: MAX_OUTPUT_TOKENS,
        stream: true,
      });

      const reader = aiStream.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let idx;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload === "[DONE]") { finished = true; break; }
          let data;
          try { data = JSON.parse(payload); } catch { continue; }
          const text = textFromEvent(data);
          if (text) {
            answer += text;
            await send({ type: "text", text });
          }
        }
      }
      await send({ type: "done" });
    } catch (err) {
      console.error("Erro no Workers AI:", err);
      await send({ type: "error", code: errorCode(err) }).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }

    // Depois de responder: salva a resposta e atualiza a memória
    if (answer) {
      await env.DB.batch([
        env.DB.prepare("INSERT INTO messages (conversation_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)")
          .bind(conv.id, answer, Date.now()),
        env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(Date.now(), conv.id),
      ]);
    }
    await extractMemories(env, user.id, message);
  })());

  return new Response(readable, {
    headers: {
      ...cors,
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
    },
  });
}

/* ---------------------------------------------------------
   Roteador
   --------------------------------------------------------- */
export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    const { pathname } = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    if (!cors) return json({ error: "origin_not_allowed" }, 403, null);
    if (!env.DB || !env.AI) return json({ error: "default" }, 500, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "anon";

    try {
      // Rotas públicas (com limite mais rígido contra tentativas de senha)
      if (pathname === "/auth/register" && method === "POST") {
        if (isRateLimited(`auth:${ip}`, 10)) return json({ error: "rate_limited" }, 429, cors);
        return await register(request, env, cors);
      }
      if (pathname === "/auth/login" && method === "POST") {
        if (isRateLimited(`auth:${ip}`, 10)) return json({ error: "rate_limited" }, 429, cors);
        return await login(request, env, cors);
      }

      // Daqui para baixo precisa estar logado
      const user = await currentUser(request, env);
      if (!user) return json({ error: "unauthorized" }, 401, cors);

      if (pathname === "/auth/logout" && method === "POST") {
        await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.tokenHash).run();
        return json({ ok: true }, 200, cors);
      }
      if (pathname === "/me" && method === "GET") return json({ user: publicUser(user) }, 200, cors);

      if (pathname === "/conversations" && method === "GET") return await listConversations(env, user, cors);
      const convMatch = pathname.match(/^\/conversations\/([\w-]{1,64})$/);
      if (convMatch && method === "GET") return await getConversation(env, user, convMatch[1], cors);
      if (convMatch && method === "DELETE") return await deleteConversation(env, user, convMatch[1], cors);

      if (pathname === "/memories" && method === "GET") return await listMemories(env, user, cors);
      if (pathname === "/memories" && method === "DELETE") return await deleteMemory(env, user, null, cors);
      const memMatch = pathname.match(/^\/memories\/(\d{1,12})$/);
      if (memMatch && method === "DELETE") return await deleteMemory(env, user, memMatch[1], cors);

      if (pathname === "/chat" && method === "POST") {
        if (isRateLimited(`chat:${user.id}`, 15)) return json({ error: "rate_limited" }, 429, cors);
        return await chat(request, env, ctx, user, cors);
      }

      return json({ error: "not_found" }, 404, cors);
    } catch (err) {
      console.error("Erro inesperado:", err);
      return json({ error: "default" }, 500, cors);
    }
  },
};
