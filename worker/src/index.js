/* =========================================================
   SaturnIA · servidor (Cloudflare Worker)
   ---------------------------------------------------------
   Recebe a conversa do site, chama o Claude com a chave que
   fica guardada em segredo na Cloudflare e devolve a resposta
   em tempo real (Server-Sent Events).
   ========================================================= */

import Anthropic from "@anthropic-ai/sdk";

const MODEL = "claude-opus-5-5";

const SYSTEM_PROMPT = `Você é a SaturnIA, uma assistente de IA de uso geral criada por Ryan Moreira, desenvolvedor full-stack brasileiro. Seu símbolo é um olho feito de partículas, com um anel como o de Saturno.

Responda no idioma em que a pessoa escrever (o padrão é português do Brasil). Seja clara, calorosa e direta: vá ao ponto, explique com exemplos quando ajudar e use Markdown (listas, negrito, blocos de código) só quando deixar a resposta mais fácil de ler.

Se perguntarem qual tecnologia você usa: você funciona com o Claude, um modelo de IA da Anthropic, dentro de uma interface criada pelo Ryan. Se perguntarem sobre o Ryan, conte que ele é desenvolvedor full-stack, trabalha com back-end, APIs REST e está se aprofundando em IA Generativa com AWS, e indique o portfólio dele: https://ryanng0104.github.io/portfolio/`;

// Limites para proteger os créditos da API
const MAX_MESSAGES = 30;
const MAX_USER_CHARS = 8000;
const MAX_ASSISTANT_CHARS = 32000;
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

function errorCode(err) {
  if (err instanceof Anthropic.RateLimitError) return "overloaded";
  if (err instanceof Anthropic.AuthenticationError) return "auth";
  if (err instanceof Anthropic.BadRequestError) return "invalid_request";
  if (err instanceof Anthropic.APIError && err.status === 529) return "overloaded";
  return "default";
}

async function streamChat(messages, env, writer) {
  const encoder = new TextEncoder();
  const send = (obj) => writer.write(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  try {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 16000,
      // Se o modelo recusar por segurança, a API tenta de novo num modelo alternativo
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      // Chat: esforço baixo deixa as respostas rápidas e mais baratas
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages,
    });

    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        // Outro modelo assumiu: descarta o texto parcial do anterior
        await send({ type: "reset" });
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        await send({ type: "text", text: event.delta.text });
      }
    }

    const final = await stream.finalMessage();
    if (final.stop_reason === "refusal") await send({ type: "refusal" });
    else if (final.stop_reason === "max_tokens") await send({ type: "truncated" });
    await send({ type: "done" });
  } catch (err) {
    console.error("Erro ao chamar o Claude:", err);
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
    if (!env.ANTHROPIC_API_KEY) return json({ error: "auth" }, 500, cors);

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
