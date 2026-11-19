/* =========================================================
   SaturnIA · ferramentas: Imagens (Júpiter) e Explorar (Terra)
   ========================================================= */

const IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";
const MAX_IMAGES_PER_DAY = 25;   // por usuário, para proteger a cota grátis
const MAX_IMAGES_KEPT = 60;      // galeria guarda as mais recentes
const UA = "SaturnIA/1.0 (+https://github.com/RyanNG0104/saturnia)";

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(cors || {}) },
  });
}

async function readJson(request) {
  try { return await request.json(); } catch { return null; }
}

// Roda um modelo de texto pequeno; se falhar, usa o principal
async function runText(env, messages, maxTokens, useMainModel = false) {
  const input = { messages, max_tokens: maxTokens };
  let out;
  try {
    out = await env.AI.run(useMainModel ? env.MODEL : env.MEMORY_MODEL, input);
  } catch {
    out = await env.AI.run(env.MODEL, input);
  }
  const r = out && typeof out === "object" && "response" in out ? out.response : out;
  return typeof r === "string" ? r : JSON.stringify(r || "");
}

function quotaError(err) {
  const msg = String((err && err.message) || err).toLowerCase();
  return msg.includes("neuron") || msg.includes("allocation") || msg.includes("4006") ? "quota" : "default";
}

/* ---------------------------------------------------------
   Imagens
   --------------------------------------------------------- */
export async function listImages(env, user, cors) {
  const { results } = await env.DB.prepare(
    "SELECT id, prompt, created_at FROM images WHERE user_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(user.id, MAX_IMAGES_KEPT).all();
  return json({ images: results }, 200, cors);
}

export async function getImage(env, user, id, cors) {
  const row = await env.DB.prepare("SELECT data FROM images WHERE id = ? AND user_id = ?").bind(id, user.id).first();
  if (!row) return json({ error: "not_found" }, 404, cors);
  const bin = Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0));
  return new Response(bin, {
    headers: { "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=86400", ...(cors || {}) },
  });
}

export async function deleteImage(env, user, id, cors) {
  await env.DB.prepare("DELETE FROM images WHERE id = ? AND user_id = ?").bind(id, user.id).run();
  return json({ ok: true }, 200, cors);
}

export async function createImage(request, env, user, cors) {
  const body = (await readJson(request)) || {};
  const prompt = String(body.prompt || "").trim().replace(/\s+/g, " ");
  if (prompt.length < 3 || prompt.length > 600) return json({ error: "invalid_request" }, 400, cors);

  const since = Date.now() - 86_400_000;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM images WHERE user_id = ? AND created_at > ?")
    .bind(user.id, since).first();
  if (count && count.n >= MAX_IMAGES_PER_DAY) return json({ error: "image_limit" }, 429, cors);

  // O modelo entende melhor descrições em inglês: traduz e detalha um pouco
  let englishPrompt = prompt;
  try {
    const t = await runText(env, [
      { role: "system", content: "You turn image requests into a single detailed English prompt for an image generator. Keep the user's subject and style. Output ONLY the prompt, no quotes, max 60 words." },
      { role: "user", content: prompt },
    ], 160);
    const clean = t.trim().replace(/^["']|["']$/g, "");
    if (clean.length >= 3 && clean.length < 800) englishPrompt = clean;
  } catch {}

  let image;
  try {
    const out = await env.AI.run(IMAGE_MODEL, { prompt: englishPrompt, steps: 6 });
    image = out && out.image;
  } catch (err) {
    console.error("Falha ao gerar imagem:", err);
    return json({ error: quotaError(err) }, 502, cors);
  }
  if (!image) return json({ error: "default" }, 502, cors);

  const row = { id: crypto.randomUUID(), prompt, created_at: Date.now() };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO images (id, user_id, prompt, data, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(row.id, user.id, prompt, image, row.created_at),
    // mantém só as mais recentes
    env.DB.prepare(
      `DELETE FROM images WHERE user_id = ? AND id NOT IN
       (SELECT id FROM images WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
    ).bind(user.id, user.id, MAX_IMAGES_KEPT),
  ]);
  return json({ image: row }, 201, cors);
}

/* ---------------------------------------------------------
   Explorar: lugares por perto (OpenStreetMap)
   --------------------------------------------------------- */
const CATEGORIES = [
  { id: "cafe", label: "Café", words: ["cafe", "cafes", "cafeteria", "coffee", "cappuccino"] },
  { id: "pizzaria", label: "Pizzaria", words: ["pizza", "pizzaria"] },
  { id: "lanchonete", label: "Lanchonete", words: ["lanche", "lanchonete", "hamburguer", "burger", "fast food", "hot dog"] },
  { id: "sorvete", label: "Sorveteria", words: ["sorvete", "sorveteria", "acai", "gelato"] },
  { id: "padaria", label: "Padaria", words: ["padaria", "pao", "paes", "confeitaria", "doceria"] },
  { id: "restaurante", label: "Restaurante", words: ["restaurante", "comer", "almoco", "almocar", "jantar", "comida", "japones", "sushi", "churrascaria"] },
  { id: "bar", label: "Bar", words: ["bar", "bares", "boteco", "cerveja", "chopp", "pub", "drink"] },
  { id: "mercado", label: "Mercado", words: ["mercado", "supermercado", "conveniencia", "hortifruti", "feira"] },
  { id: "farmacia", label: "Farmácia", words: ["farmacia", "drogaria", "remedio"] },
  { id: "academia", label: "Academia", words: ["academia", "musculacao", "crossfit", "treinar", "gym"] },
  { id: "parque", label: "Parque", words: ["parque", "praca", "jardim", "caminhar", "correr", "ar livre"] },
  { id: "hospital", label: "Saúde", words: ["hospital", "clinica", "pronto socorro", "upa", "medico"] },
  { id: "hotel", label: "Hospedagem", words: ["hotel", "hospedagem", "pousada", "hostel", "dormir"] },
  { id: "museu", label: "Cultura", words: ["museu", "exposicao", "galeria", "arte", "cultura", "centro cultural"] },
  { id: "cinema", label: "Cinema e teatro", words: ["cinema", "filme", "teatro", "peca"] },
  { id: "livraria", label: "Livraria", words: ["livraria", "livro", "biblioteca", "ler"] },
  { id: "coworking", label: "Coworking", words: ["coworking", "escritorio compartilhado"] },
  { id: "pet", label: "Pet", words: ["pet", "petshop", "veterinario", "racao", "cachorro", "gato"] },
  { id: "posto", label: "Posto", words: ["posto", "gasolina", "combustivel", "abastecer"] },
  { id: "banco", label: "Banco", words: ["banco", "caixa eletronico", "sacar", "agencia"] },
];

function normalize(s) {
  return String(s).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function matchCategory(query) {
  const q = ` ${normalize(query).replace(/[^a-z0-9 ]/g, " ")} `;
  return CATEGORIES.find((c) => c.words.some((w) => q.includes(` ${w} `) || q.includes(` ${w}s `)));
}

async function pickCategoryWithAI(env, query) {
  const ids = CATEGORIES.map((c) => c.id).join(", ");
  const t = await runText(env, [
    { role: "system", content: `Classify what kind of place the user is looking for. Answer with ONE id from this list and nothing else: ${ids}. If none fits, answer: none` },
    { role: "user", content: query },
  ], 8);
  const id = normalize(t).replace(/[^a-z]/g, "");
  return CATEGORIES.find((c) => c.id === id);
}

// "cafés em Pinheiros" → "Pinheiros"
function placeFromQuery(query) {
  const m = /\b(?:em|no|na|nos|nas|perto d[aoe]|perto da|perto do|próximo [aàd][oa]?|proximo [aad][oa]?)\s+(.{3,80})$/i.exec(query.trim());
  return m ? m[1].replace(/[?.!]+$/, "").trim() : "";
}

async function geocode(text) {
  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=pt-BR&q=${encodeURIComponent(text)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) { console.error("Nominatim", res.status, (await res.text()).slice(0, 200)); return null; }
  const data = await res.json();
  if (!data.length) return null;
  return { lat: Number(data[0].lat), lon: Number(data[0].lon), label: String(data[0].display_name).split(",").slice(0, 2).join(",") };
}

function distanceMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}

// Como buscar cada categoria no Nominatim (OpenStreetMap): termos em inglês
// ("special phrases") e os tipos de lugar aceitos no resultado.
const NOMINATIM = {
  cafe: { q: ["cafe"], types: ["amenity=cafe"] },
  pizzaria: { q: ["restaurant", "fast food"], types: ["amenity=restaurant", "amenity=fast_food"], cuisine: "pizza" },
  lanchonete: { q: ["fast food"], types: ["amenity=fast_food"] },
  sorvete: { q: ["ice cream"], types: ["amenity=ice_cream"] },
  padaria: { q: ["bakery"], types: ["shop=bakery", "shop=pastry", "shop=confectionery"] },
  restaurante: { q: ["restaurant"], types: ["amenity=restaurant"] },
  bar: { q: ["bar", "pub"], types: ["amenity=bar", "amenity=pub", "amenity=biergarten"] },
  mercado: { q: ["supermarket", "convenience store"], types: ["shop=supermarket", "shop=convenience", "shop=greengrocer"] },
  farmacia: { q: ["pharmacy"], types: ["amenity=pharmacy", "shop=chemist"] },
  academia: { q: ["fitness", "sports centre"], types: ["leisure=fitness_centre", "leisure=sports_centre"] },
  parque: { q: ["park"], types: ["leisure=park", "leisure=garden"] },
  hospital: { q: ["hospital", "clinic"], types: ["amenity=hospital", "amenity=clinic", "healthcare=hospital", "healthcare=clinic"] },
  hotel: { q: ["hotel", "hostel"], types: ["tourism=hotel", "tourism=hostel", "tourism=guest_house"] },
  museu: { q: ["museum", "gallery"], types: ["tourism=museum", "tourism=gallery", "amenity=arts_centre"] },
  cinema: { q: ["cinema", "theatre"], types: ["amenity=cinema", "amenity=theatre"] },
  livraria: { q: ["book shop", "library"], types: ["shop=books", "amenity=library"] },
  coworking: { q: ["coworking"], types: ["amenity=coworking_space", "office=coworking"] },
  pet: { q: ["pet shop", "vet"], types: ["shop=pet", "amenity=veterinary"] },
  posto: { q: ["fuel"], types: ["amenity=fuel"] },
  banco: { q: ["bank", "atm"], types: ["amenity=bank", "amenity=atm"] },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastNominatimAt = 0;

async function nominatimArea(q, center, radius) {
  const wait = lastNominatimAt + 1100 - Date.now();
  if (wait > 0) await sleep(wait);
  lastNominatimAt = Date.now();
  const dLat = radius / 111_320;
  const dLon = radius / (111_320 * Math.cos((center.lat * Math.PI) / 180));
  const viewbox = [center.lon - dLon, center.lat + dLat, center.lon + dLon, center.lat - dLat].join(",");
  const url = "https://nominatim.openstreetmap.org/search?format=jsonv2&limit=40&bounded=1&extratags=1"
    + `&addressdetails=1&accept-language=pt-BR&viewbox=${viewbox}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function findPlaces(category, center, radius) {
  const spec = NOMINATIM[category.id];
  const seen = new Set();
  const places = [];
  for (const q of spec.q) {
    const results = await nominatimArea(q, center, radius);
    for (const r of results) {
      const extra = r.extratags || {};
      const addr = r.address || {};
      if (!r.name) continue;
      if (spec.types.length && !spec.types.includes(`${r.category}=${r.type}`)) continue;
      if (spec.cuisine && !String(extra.cuisine || "").includes(spec.cuisine)) continue;
      const lat = Number(r.lat);
      const lon = Number(r.lon);
      const key = `${r.name}|${Math.round(lat * 1e3)}|${Math.round(lon * 1e3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const street = [addr.road, addr.house_number].filter(Boolean).join(", ");
      places.push({
        name: r.name,
        lat,
        lon,
        distance: distanceMeters(center, { lat, lon }),
        address: [street, addr.suburb || addr.neighbourhood].filter(Boolean).join(" · "),
        hours: extra.opening_hours || "",
        cuisine: extra.cuisine ? String(extra.cuisine).replace(/_/g, " ").replace(/;/g, ", ") : "",
        website: extra.website || extra["contact:website"] || "",
        wifi: extra.internet_access === "wlan" || extra.internet_access === "yes",
      });
    }
  }
  return places.sort((a, b) => a.distance - b.distance).slice(0, 20);
}

export async function explore(request, env, user, cors) {
  const body = (await readJson(request)) || {};
  const query = String(body.query || "").trim().slice(0, 200);
  if (query.length < 2) return json({ error: "invalid_request" }, 400, cors);

  // 1. Que tipo de lugar?
  let category = matchCategory(query);
  if (!category) {
    try { category = await pickCategoryWithAI(env, query); } catch {}
  }
  if (!category) return json({ error: "explore_unknown" }, 400, cors);

  // 2. Onde? Lugar escrito na pergunta, ou a localização compartilhada
  let center = null;
  const placeText = placeFromQuery(query) || String(body.place || "").trim().slice(0, 120);
  if (placeText) {
    center = await geocode(placeText);
    if (!center) return json({ error: "explore_place" }, 404, cors);
  } else if (Number.isFinite(body.lat) && Number.isFinite(body.lon)) {
    center = { lat: body.lat, lon: body.lon, label: "Perto de você" };
  } else {
    return json({ error: "need_location" }, 400, cors);
  }

  // 3. Busca os lugares, ampliando o raio se vier pouca coisa
  let places = [];
  try {
    for (const radius of [1500, 3500]) {
      places = await findPlaces(category, center, radius);
      if (places.length >= 5) break;
    }
  } catch (err) {
    console.error("Falha ao buscar lugares:", err);
    return json({ error: "explore_busy" }, 503, cors);
  }

  // 4. Um resumo curto, só com os dados encontrados (sem inventar notas)
  let summary = "";
  if (places.length) {
    const list = places.slice(0, 8).map((p, i) =>
      `${i + 1}. ${p.name} (${p.distance} m)${p.hours ? `, horário: ${p.hours}` : ""}${p.wifi ? ", tem Wi-Fi" : ""}${p.cuisine ? `, ${p.cuisine}` : ""}`).join("\n");
    try {
      summary = (await runText(env, [
        { role: "system", content: "Você é a SaturnIA, uma assistente simpática. Escreva em português do Brasil, em no máximo 2 frases curtas e naturais, uma recomendação a partir da lista de lugares, falando direto com a pessoa (ex.: \"O mais perto é…\"). Não se apresente nem diga seu nome. Use SOMENTE as informações da lista; não invente notas, preços, comidas ou avaliações. Sem markdown." },
        { role: "user", content: `Pedido: "${query}"\nLugares encontrados, do mais perto para o mais longe:\n${list}` },
      ], 140, true)).trim();
    } catch {}
  }

  return json({ category: { id: category.id, label: category.label }, center, places, summary }, 200, cors);
}
