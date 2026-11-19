/* =========================================================
   SaturnIA · abas Imagens (Júpiter) e Explorar (Terra)
   Usa o login e a comunicação com o servidor de js/app.js
   (window.SaturnApp).
   ========================================================= */

(function () {
  const S = () => window.SaturnApp;
  const $ = (id) => document.getElementById(id);
  const err = (e) => S().errors[e && e.code] || S().errors.default;
  const esc = (t) => String(t).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* =========================================================
     IMAGENS
     ========================================================= */
  const gallery = $('gallery');
  const imgPrompt = $('img-prompt');
  const imgMsg = $('img-msg');
  const imgSubmit = $('img-submit');
  const blobUrls = new Map();
  let loadedFor = null;

  // As imagens exigem login: baixa com o token e mostra como "blob"
  async function imageUrl(id) {
    if (blobUrls.has(id)) return blobUrls.get(id);
    const res = await S().api(`/images/${id}`, { raw: true });
    const url = URL.createObjectURL(await res.blob());
    blobUrls.set(id, url);
    return url;
  }

  function emptyCheck() {
    if (!gallery.querySelector('.shot')) {
      gallery.innerHTML = '<p class="gallery__empty">Suas imagens vão aparecer aqui. Que tal começar com um dos estilos acima?</p>';
    }
  }

  function makeCard(img, pending) {
    const el = document.createElement('figure');
    el.className = `shot${pending ? ' is-pending' : ''}`;
    el.innerHTML = `
      <div class="shot__img">${pending ? '<span class="shot__spinner"><img src="assets/jupiter.svg" alt=""></span><span class="shot__wait">Criando…</span>' : ''}</div>
      <figcaption><p></p><div class="shot__actions"></div></figcaption>`;
    el.querySelector('p').textContent = img.prompt;
    if (!pending) fillCard(el, img);
    return el;
  }

  async function fillCard(el, img) {
    try {
      const url = await imageUrl(img.id);
      const im = new Image();
      im.src = url;
      im.alt = img.prompt;
      im.addEventListener('click', () => openLightbox(url, img.prompt));
      el.querySelector('.shot__img').replaceChildren(im);

      const actions = el.querySelector('.shot__actions');
      const dl = document.createElement('a');
      dl.href = url;
      dl.download = `saturnia-${img.id.slice(0, 8)}.jpg`;
      dl.textContent = 'Baixar';

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = 'Apagar';
      del.addEventListener('click', async () => {
        if (!del.classList.contains('is-confirm')) {
          del.classList.add('is-confirm');
          del.textContent = 'Confirmar?';
          setTimeout(() => { del.classList.remove('is-confirm'); del.textContent = 'Apagar'; }, 3000);
          return;
        }
        try {
          await S().api(`/images/${img.id}`, { method: 'DELETE' });
          el.remove();
          URL.revokeObjectURL(url);
          blobUrls.delete(img.id);
          emptyCheck();
        } catch (e) { /* mantém o card */ }
      });
      actions.append(dl, del);
    } catch (e) {
      el.querySelector('.shot__img').innerHTML = '<span class="shot__wait">Não consegui carregar</span>';
    }
  }

  async function loadGallery() {
    const user = S().getUser();
    if (!user || loadedFor === user.id) return;
    loadedFor = user.id;
    gallery.innerHTML = '<p class="gallery__empty">Carregando suas imagens…</p>';
    try {
      const data = await S().api('/images');
      gallery.innerHTML = '';
      data.images.forEach((img) => gallery.appendChild(makeCard(img, false)));
      emptyCheck();
    } catch (e) {
      loadedFor = null;
      gallery.innerHTML = '<p class="gallery__empty">Não consegui carregar suas imagens.</p>';
    }
  }

  // Botões de estilo: completam a descrição
  $('img-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const current = imgPrompt.value.trim().replace(/[,.\s]+$/, '');
    imgPrompt.value = current ? `${current}, ${b.dataset.style}` : `${b.dataset.style} de `;
    imgPrompt.focus();
  });

  imgPrompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('img-form').requestSubmit();
    }
  });

  $('img-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const prompt = imgPrompt.value.trim();
    if (prompt.length < 3) { imgMsg.textContent = 'Descreva a imagem com um pouco mais de detalhe.'; return; }
    imgMsg.textContent = '';
    imgSubmit.disabled = true;
    imgSubmit.textContent = 'Criando…';
    gallery.querySelector('.gallery__empty')?.remove();
    const pending = makeCard({ prompt }, true);
    gallery.prepend(pending);
    try {
      const data = await S().api('/images', { method: 'POST', body: { prompt } });
      pending.replaceWith(makeCard(data.image, false));
      imgPrompt.value = '';
    } catch (ex) {
      pending.remove();
      emptyCheck();
      if (ex.code !== 'unauthorized') imgMsg.textContent = err(ex);
    } finally {
      imgSubmit.disabled = false;
      imgSubmit.textContent = 'Gerar imagem';
    }
  });

  // Ver a imagem grande
  function openLightbox(url, caption) {
    const box = document.createElement('div');
    box.className = 'lightbox';
    box.innerHTML = '<img alt=""><p></p><button type="button" class="icon-btn" aria-label="Fechar">✕</button>';
    box.querySelector('img').src = url;
    box.querySelector('img').alt = caption;
    box.querySelector('p').textContent = caption;
    const close = () => { box.remove(); document.removeEventListener('keydown', onKey); };
    const onKey = (ev) => { if (ev.key === 'Escape') close(); };
    box.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.appendChild(box);
  }

  /* =========================================================
     EXPLORAR
     ========================================================= */
  const expQuery = $('exp-query');
  const expMsg = $('exp-msg');
  const expSummary = $('exp-summary');
  const cards = $('place-cards');
  let map = null;
  let tileLayer = null;
  let markers = [];
  let meMarker = null;
  let coords = null;

  // Mapas do OpenStreetMap (grátis, sem chave). No tema escuro, o CSS escurece o mapa.
  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

  function ensureMap() {
    if (map || !window.L) return;
    map = L.map('map', { zoomControl: true }).setView([-14.2, -51.9], 4);
    tileLayer = L.tileLayer(TILE_URL, {
      attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);
  }

  function formatDistance(m) {
    return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
  }

  $('exp-locate').addEventListener('click', () => {
    if (!navigator.geolocation) { expMsg.textContent = 'Seu navegador não permite compartilhar a localização.'; return; }
    expMsg.textContent = 'Pegando sua localização…';
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        coords = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        expMsg.textContent = '';
        $('exp-locate').classList.add('is-on');
        $('exp-locate-label').textContent = 'Usando sua localização';
        ensureMap();
        if (meMarker) meMarker.remove();
        meMarker = L.circleMarker([coords.lat, coords.lon], { radius: 8, color: '#fff', weight: 3, fillColor: '#7c3aed', fillOpacity: 1 })
          .addTo(map).bindTooltip('Você está aqui');
        map.setView([coords.lat, coords.lon], 15);
        expQuery.focus();
      },
      () => { expMsg.textContent = 'Não consegui acessar sua localização. Você pode escrever o bairro na busca, ex.: "cafés em Pinheiros".'; },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 },
    );
  });

  expQuery.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      $('exp-form').requestSubmit();
    }
  });

  function selectPlace(i) {
    cards.querySelectorAll('.place-card').forEach((c, j) => c.classList.toggle('is-active', i === j));
    const card = cards.children[i];
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
    const m = markers[i];
    if (m) {
      map.flyTo(m.getLatLng(), Math.max(map.getZoom(), 17), { duration: 0.6 });
      m.openPopup();
    }
  }

  function render(data) {
    ensureMap();
    markers.forEach((m) => m.remove());
    markers = [];
    cards.innerHTML = '';

    expSummary.hidden = !data.summary;
    expSummary.textContent = data.summary || '';

    if (!data.places.length) {
      expMsg.textContent = `Não encontrei ${data.category.label.toLowerCase()} por aqui. Tente outro bairro ou outro tipo de lugar.`;
      map.setView([data.center.lat, data.center.lon], 14);
      return;
    }
    expMsg.textContent = `${data.places.length} ${data.places.length === 1 ? 'lugar' : 'lugares'} · ${data.category.label} · ${data.center.label}`;

    const bounds = [];
    data.places.forEach((p, i) => {
      const icon = L.divIcon({
        className: 'pin',
        html: `<span class="pin__n">${i + 1}</span><span class="pin__name">${esc(p.name)}</span>`,
        iconSize: null,
        iconAnchor: [14, 14],
      });
      const marker = L.marker([p.lat, p.lon], { icon })
        .addTo(map)
        .bindPopup(`<strong>${esc(p.name)}</strong>${p.address ? `<br>${esc(p.address)}` : ''}`);
      marker.on('click', () => selectPlace(i));
      markers.push(marker);
      bounds.push([p.lat, p.lon]);

      const card = document.createElement('article');
      card.className = 'place-card';
      card.tabIndex = 0;
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.name} ${p.lat},${p.lon}`)}`;
      card.innerHTML = `
        <span class="place-card__n">${i + 1}</span>
        <div class="place-card__body">
          <h3>${esc(p.name)}</h3>
          <p class="place-card__meta">${esc(data.category.label)} · ${formatDistance(p.distance)}${p.wifi ? ' · Wi-Fi' : ''}</p>
          ${p.address ? `<p class="place-card__addr">${esc(p.address)}</p>` : ''}
          ${p.hours ? `<p class="place-card__hours">🕒 ${esc(p.hours)}</p>` : ''}
          <a href="${maps}" target="_blank" rel="noopener">Abrir no Google Maps ↗</a>
        </div>`;
      card.addEventListener('click', (e) => { if (!e.target.closest('a')) selectPlace(i); });
      card.addEventListener('keydown', (e) => { if (e.key === 'Enter') selectPlace(i); });
      cards.appendChild(card);
    });

    if (coords) bounds.push([coords.lat, coords.lon]);
    map.fitBounds(bounds, { paddingTopLeft: [40, 40], paddingBottomRight: [40, 190], maxZoom: 16 });
  }

  $('exp-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const query = expQuery.value.trim();
    if (query.length < 2) { expMsg.textContent = 'O que você procura? Ex.: "farmácia" ou "parques em Moema".'; return; }
    const btn = $('exp-submit');
    btn.disabled = true;
    btn.textContent = 'Buscando…';
    expMsg.textContent = 'Procurando lugares…';
    try {
      const body = { query };
      if (coords) { body.lat = coords.lat; body.lon = coords.lon; }
      render(await S().api('/explore', { method: 'POST', body }));
    } catch (ex) {
      if (ex.code !== 'unauthorized') expMsg.textContent = err(ex);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Buscar';
    }
  });

  /* ---------- Ao abrir cada aba ---------- */
  window.addEventListener('saturnia:view', (e) => {
    if (e.detail === 'images') {
      loadGallery();
      setTimeout(() => imgPrompt.focus(), 50);
    }
    if (e.detail === 'explore') {
      ensureMap();
      setTimeout(() => { if (map) map.invalidateSize(); expQuery.focus(); }, 60);
    }
  });
})();
