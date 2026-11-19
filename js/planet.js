/* =========================================================
   Planetas de partículas (mesmo estilo do olho da SaturnIA)
   - 'jupiter': faixas roxas e a grande mancha (uma "pupila")
   - 'earth':   continentes lilás, oceano roxo e a Lua em órbita
   Estados: 'idle' (calmo) e 'busy' (trabalhando: gira mais rápido e vibra)
   ========================================================= */

(function () {
  const TAU = Math.PI * 2;

  function fibonacciSphere(n) {
    const pts = [];
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < n; i++) {
      const y = 1 - (i / (n - 1)) * 2;
      const r = Math.sqrt(1 - y * y);
      const t = golden * i;
      pts.push({ x: Math.cos(t) * r, y, z: Math.sin(t) * r, seed: Math.random() * TAU });
    }
    return pts;
  }

  const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
  const rgba = (c, a) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

  // Faixas de Júpiter (de cima para baixo)
  const JUPITER_BANDS = ['#f5f3ff', '#6d28d9', '#ddd6fe', '#4c1d95', '#e9d5ff', '#7c3aed', '#f5f3ff'].map(hex);
  const SPOT = hex('#f0abfc');
  const PUPIL = hex('#1b0f2e');
  const LAND = hex('#f5f3ff');
  const LAND_2 = hex('#d8b4fe');
  const OCEAN = hex('#7c3aed');
  const OCEAN_2 = hex('#4c1d95');
  const MOON = hex('#ddd6fe');
  // Versões para o tema claro (fundo branco): trocam os tons claros por roxos escuros
  const LIGHT = {
    bands: ['#a78bfa', '#4c1d95', '#c4b5fd', '#3b0f7a', '#8b5cf6', '#6d28d9', '#a78bfa'].map(hex),
    land: hex('#4c1d95'), land2: hex('#6d28d9'),
    ocean: hex('#c4b5fd'), ocean2: hex('#ddd6fe'),
    moon: hex('#7c3aed'),
  };
  const ORBIT = hex('#a855f7');

  // "Continentes" procedurais: uma soma de ondas sobre a esfera
  function isLand(x, y, z) {
    const v = Math.sin(x * 3.1 + 1.3) * Math.cos(y * 2.6 - 0.4)
      + Math.sin(z * 3.4 + 0.5) * 0.85
      + Math.cos(x * 5.2 - z * 4.3) * 0.45
      + Math.sin(y * 6.1 + x * 1.7) * 0.25;
    return v > 0.2;
  }

  class ParticlePlanet {
    constructor(canvas, kind) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.kind = kind;
      this.state = 'idle';
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.time = 0;
      this.spin = 0;
      this.orbit = 0;
      this.tilt = { x: 0, y: 0 };
      this.tiltTarget = { x: 0, y: 0 };

      // Pontos da esfera com atributos fixos (giram junto com o planeta)
      this.points = fibonacciSphere(kind === 'jupiter' ? 1700 : 1500).map((p) => {
        if (kind === 'jupiter') {
          const band = Math.min(JUPITER_BANDS.length - 1, Math.floor(((p.y + 1) / 2) * JUPITER_BANDS.length));
          // Grande mancha: perto de latitude -0,32, longitude fixa
          const spotDist = Math.hypot((p.y + 0.3) * 2, (p.x - 0.5) * 1.2, (p.z + 0.8) * 1.2);
          return { ...p, band, spot: spotDist < 0.42 ? (spotDist < 0.2 ? 2 : 1) : 0 };
        }
        return { ...p, land: isLand(p.x, p.y, p.z) };
      });
      this.moon = kind === 'earth' ? fibonacciSphere(70) : null;

      this.resize = this.resize.bind(this);
      this.frame = this.frame.bind(this);
      window.addEventListener('resize', this.resize);
      if ('ResizeObserver' in window) new ResizeObserver(this.resize).observe(canvas);
      window.addEventListener('pointermove', (e) => {
        const r = canvas.getBoundingClientRect();
        this.tiltTarget.x = Math.max(-1, Math.min(1, (e.clientY - (r.top + r.height / 2)) / (window.innerHeight / 2)));
        this.tiltTarget.y = Math.max(-1, Math.min(1, (e.clientX - (r.left + r.width / 2)) / (window.innerWidth / 2)));
      });
      this.resize();
      if (this.reduceMotion) this.draw(performance.now());
      else requestAnimationFrame(this.frame);
    }

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.w = rect.width;
      this.h = rect.height;
      this.canvas.width = Math.round(this.w * dpr);
      this.canvas.height = Math.round(this.h * dpr);
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (this.reduceMotion) this.draw(performance.now());
    }

    setState(state) { this.state = state; }

    frame(now) {
      // Canvas removido da página (ex.: card que terminou de carregar): para de animar
      if (!this.canvas.isConnected) return;
      // Só desenha quando está visível (economiza bateria)
      if (this.canvas.offsetParent !== null) this.draw(now);
      else this.lastNow = now;
      requestAnimationFrame(this.frame);
    }

    draw(now) {
      const { ctx, w, h } = this;
      if (!w || !h) return;
      const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.05) : 0.016;
      this.lastNow = now;
      this.time += dt;

      const busy = this.state === 'busy';
      const dark = document.documentElement.dataset.theme === 'dark';
      this.spin += dt * (busy ? 1.4 : 0.22);
      this.orbit += dt * (busy ? 1.6 : 0.35);
      const follow = 1 - Math.pow(0.002, dt);
      this.tilt.x += (this.tiltTarget.x * 0.35 - this.tilt.x) * follow;
      this.tilt.y += (this.tiltTarget.y * 0.5 - this.tilt.y) * follow;

      const size = Math.min(w, h);
      const R = size * (this.kind === 'earth' ? 0.3 : 0.34) * (busy ? 1 + Math.sin(this.time * 6) * 0.015 : 1);
      const cx = w / 2;
      const cy = h / 2;
      const f = 3.4;
      const tiltX = 0.28 + this.tilt.x;
      const spin = this.spin + this.tilt.y;
      const cosS = Math.cos(spin), sinS = Math.sin(spin);
      const cosT = Math.cos(tiltX), sinT = Math.sin(tiltX);
      const project = (x, y, z) => {
        const s = f / (f + z);
        return { sx: cx + x * R * s, sy: cy + y * R * s, s };
      };
      const rotate = (p) => {
        const x1 = p.x * cosS + p.z * sinS;
        const z1 = -p.x * sinS + p.z * cosS;
        return { x: x1, y: p.y * cosT - z1 * sinT, z: p.y * sinT + z1 * cosT };
      };
      const dotScale = size / 420;

      ctx.clearRect(0, 0, w, h);
      const items = [];

      // Esfera
      for (const p of this.points) {
        const q = rotate(p);
        let jitter = 1;
        if (busy) jitter = 1 + Math.sin(this.time * 8 + p.seed) * 0.03;
        const depth = (1 - q.z) / 2;
        let color, alpha, r = (0.75 + depth * 1.35) * dotScale;

        if (this.kind === 'jupiter') {
          if (p.spot === 2) { color = PUPIL; alpha = 0.55 + depth * 0.45; r *= 1.3; }
          else if (p.spot === 1) { color = SPOT; alpha = 0.6 + depth * 0.4; r *= 1.15; }
          else { color = (dark ? JUPITER_BANDS : LIGHT.bands)[p.band]; alpha = (dark ? 0.2 : 0.16) + depth * 0.8; r *= 1.08; }
        } else if (p.land) {
          color = dark ? (depth > 0.5 ? LAND : LAND_2) : (depth > 0.5 ? LIGHT.land : LIGHT.land2); alpha = 0.3 + depth * 0.7; r *= 1.2;
        } else {
          color = dark ? (depth > 0.6 ? OCEAN : OCEAN_2) : (depth > 0.6 ? LIGHT.ocean : LIGHT.ocean2); alpha = (dark ? 0.12 : 0.2) + depth * 0.55; r *= 0.9;
        }
        items.push({ ...project(q.x * jitter, q.y * jitter, q.z * jitter), z: q.z, color, alpha, r });
      }

      // Terra: órbita pontilhada e a Lua de partículas
      if (this.kind === 'earth') {
        const orbitR = 1.75;
        const oT = 1.15, oZ = -0.3;
        const orbitPoint = (t) => {
          const x0 = Math.cos(t) * orbitR, z0 = Math.sin(t) * orbitR;
          const y1 = -z0 * Math.sin(oT), z1 = z0 * Math.cos(oT);
          return { x: x0 * Math.cos(oZ) - y1 * Math.sin(oZ), y: x0 * Math.sin(oZ) + y1 * Math.cos(oZ), z: z1 };
        };
        for (let i = 0; i < 120; i++) {
          const o = orbitPoint((i / 120) * TAU);
          const pr = project(o.x, o.y, o.z);
          items.push({ ...pr, z: o.z, color: ORBIT, alpha: o.z < 0 ? 0.55 : 0.2, r: (i % 6 === 0 ? 1.8 : 1.1) * dotScale * pr.s });
        }
        const mc = orbitPoint(this.orbit);
        for (const m of this.moon) {
          const mx = mc.x + m.x * 0.22, my = mc.y + m.y * 0.22, mz = mc.z + m.z * 0.22;
          const depth = (1 - m.z) / 2;
          const pr = project(mx, my, mz);
          items.push({ ...pr, z: mz, color: dark ? MOON : LIGHT.moon, alpha: 0.25 + depth * 0.7, r: (0.8 + depth) * dotScale * pr.s });
        }
      }

      items.sort((a, b) => b.z - a.z); // do fundo para a frente
      for (const it of items) {
        ctx.fillStyle = rgba(it.color, it.alpha);
        ctx.beginPath();
        ctx.arc(it.sx, it.sy, it.r * (it.s || 1), 0, TAU);
        ctx.fill();
      }
    }
  }

  window.ParticlePlanet = ParticlePlanet;
})();
