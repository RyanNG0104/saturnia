/* =========================================================
   SaturnIA · servidor (Cloudflare Worker + Workers AI)
   ---------------------------------------------------------
   Recebe a conversa do site, roda o modelo de IA na própria
   Cloudflare (cota diária gratuita, sem chave de API) e
   devolve a resposta em tempo real (Server-Sent Events).
   ========================================================= */

const DEFAULT_MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";

const SYSTEM_PROMPT = `Você é a SaturnIA, uma assistente de IA de uso geral criada por Ryan Moreira, desenvolvedor full-stack brasileiro. Seu símbolo é um olho feito de partículas, com um anel como o de Saturno.

Responda no idioma em que a pessoa escrever (o padrão é português do Brasil). Seja clara, calorosa e direta: vá ao ponto, explique com exemplos quando ajudar e use Markdown (listas, negrito, blocos de código) só quando deixar a resposta mais fácil de ler. Se não souber algo, diga que não sabe em vez de inventar.

Se perguntarem qual tecnologia você usa: você roda com o modelo Llama, da Meta, na plataforma Workers AI da Cloudflare, dentro de uma interface criada pelo Ryan. Se perguntarem sobre o Ryan, conte que ele é desenvolvedor full-stack, trabalha com back-end e APIs REST e está se aprofundando em IA Generativa, e indique o portfólio dele: https://ryanng0104.github.io/portfolio/`;

// Limites para proteger a cota gratuita
const MAX_MESSAGES = 20;
const MAX_USER_CHARS = 6000;
const MAX_ASSISTANT_CHARS = 12000;
const MAX_OUTPUT_TOKENS = 2048;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT = 15; // mensagens por minuto, por IP

const hits = new Map();

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
  recent.push(now);
  hits.set(ip, recent);
  if (hits.size > 5000) hits.clear(); // evita crescer sem limite
  return recent.length > RATE_LIMIT;
}

function corsHeaders(origin, env) {
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...(cors || {}) },
  });
}

// Aceita só conversas no formato user/assistant alternado, terminando em user
function validateMessages(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > MAX_MESSAGES) return null;
  const out = [];
  for (let i = 0; i < input.length; i++) {
    const m = input[i];
    const role = i % 2 === 0 ? "user" : "assistant";
    if (!m || m.role !== role || typeof m.content !== "string") return null;
    const content = m.content.trim();
    const max = role === "user" ? MAX_USER_CHARS : MAX_ASSISTANT_CHARS;
    if (!content || content.length > max) return null;
    out.push({ role, content });
  }
  return out[out.length - 1].role === "user" ? out : null;
}

// Identifica quando a cota gratuita do dia acabou
function errorCode(err) {
  const msg = String((err && err.message) || err).toLowerCase();
  if (msg.includes("neuron") || msg.includes("allocation") || msg.includes("quota") || msg.includes("4006")) {
    return "quota";
  }
  if (msg.includes("capacity") || msg.includes("overloaded") || msg.includes("3040")) return "overloaded";
  return "default";
}

// Extrai o texto de um evento do Workers AI (formato clássico ou estilo OpenAI)
function textFromEvent(data) {
  if (typeof data.response === "string") return data.response;
  const delta = data.choices && data.choices[0] && data.choices[0].delta;
  return (delta && typeof delta.content === "string") ? delta.content : "";
}

async function streamChat(messages, env, writer) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const send = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

  try {
    const aiStream = await env.AI.run(env.MODEL || DEFAULT_MODEL, {
      messages: [{ role: "system", content: SYSTEM_PROMPT }, ...messages],
      max_tokens: MAX_OUTPUT_TOKENS,
      stream: true,
    });

    const reader = aiStream.getReader();
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
        if (text) await send({ type: "text", text });
      }
    }
    await send({ type: "done" });
  } catch (err) {
    console.error("Erro no Workers AI:", err);
    await send({ type: "error", code: errorCode(err) }).catch(() => {});
  } finally {
    await writer.close().catch(() => {});
  }
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: cors ? 204 : 403, headers: cors || {} });
    }
    if (url.pathname !== "/chat" || request.method !== "POST") {
      return json({ error: "not_found" }, 404, cors);
    }
    if (!cors) return json({ error: "origin_not_allowed" }, 403, null);
    if (!env.AI) return json({ error: "default" }, 500, cors);

    const ip = request.headers.get("CF-Connecting-IP") || "anon";
    if (isRateLimited(ip)) return json({ error: "rate_limited" }, 429, cors);

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_request" }, 400, cors);
    }
    const messages = validateMessages(body && body.messages);
    if (!messages) return json({ error: "invalid_request" }, 400, cors);

    const { readable, writable } = new TransformStream();
    ctx.waitUntil(streamChat(messages, env, writable.getWriter()));

    return new Response(readable, {
      headers: {
        ...cors,
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  },
};
