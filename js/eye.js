/* =========================================================
   O olho da SaturnIA
   Uma esfera de partículas com íris e pupila que seguem o
   cursor, pisca de vez em quando e reage ao estado do chat:
   'idle' (observando), 'thinking' (pensando), 'speaking' (respondendo).
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

  class SaturnEye {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.points = fibonacciSphere(760);
      this.state = 'idle';
      this.reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

      this.time = 0;
      this.spin = 0;
      this.ringSpin = 0;
      this.pulseValue = 0;
      this.pupil = 0.25;        // abertura atual da pupila (radianos)
      this.gaze = { x: 0, y: 0 };      // para onde o olho olha agora
      this.gazeTarget = { x: 0, y: 0 }; // para onde ele quer olhar
      this.lastPointer = performance.now();
      this.blinkStart = -1;

      // Só pisca quando alguém clica no olho
      canvas.addEventListener('click', () => this.blink());

      this.resize = this.resize.bind(this);
      this.frame = this.frame.bind(this);
      window.addEventListener('resize', this.resize);
      // Reajusta também durante a animação em que o olho encolhe
      if ('ResizeObserver' in window) new ResizeObserver(this.resize).observe(canvas);
      window.addEventListener('pointermove', (e) => this.lookAt(e.clientX, e.clientY));
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

    lookAt(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const nx = (clientX - cx) / (window.innerWidth * 0.5);
      const ny = (clientY - cy) / (window.innerHeight * 0.5);
      this.gazeTarget.x = Math.max(-1, Math.min(1, nx));
      this.gazeTarget.y = Math.max(-1, Math.min(1, ny));
      this.lastPointer = performance.now();
    }

    setState(state) {
      this.state = state;
    }

    blink() {
      if (this.blinkStart < 0) this.blinkStart = performance.now();
      if (this.reduceMotion) this.draw(performance.now());
    }

    pulse() { this.pulseValue = 1; }

    frame(now) {
      this.draw(now);
      requestAnimationFrame(this.frame);
    }

    draw(now) {
      const { ctx, w, h } = this;
      if (!w || !h) return;
      const dt = this.lastNow ? Math.min((now - this.lastNow) / 1000, 0.05) : 0.016;
      this.lastNow = now;
      this.time += dt;

      const thinking = this.state === 'thinking';
      const speaking = this.state === 'speaking';
      const dark = document.documentElement.dataset.theme === 'dark';

      // Velocidades por estado
      this.spin += dt * (thinking ? 1.1 : 0.18);
      this.ringSpin += dt * (thinking ? 1.6 : 0.25);
      this.pulseValue *= Math.pow(0.02, dt); // decai rápido

      // Para onde olhar
      let tx = this.gazeTarget.x;
      let ty = this.gazeTarget.y;
      if (thinking) {
        // olha em volta, como quem procura uma resposta
        tx = Math.cos(this.time * 1.7) * 0.7;
        ty = Math.sin(this.time * 2.3) * 0.45;
      } else if (now - this.lastPointer > 4000) {
        // sem mouse por um tempo: vagueia devagar
        tx = Math.sin(this.time * 0.35) * 0.45;
        ty = Math.sin(this.time * 0.5) * 0.2;
      }
      const follow = 1 - Math.pow(0.0005, dt);
      this.gaze.x += (tx - this.gaze.x) * follow;
      this.gaze.y += (ty - this.gaze.y) * follow;

      // Pupila: contrai pensando, dilata falando
      const pupilTarget = thinking ? 0.17 : speaking ? 0.29 + this.pulseValue * 0.05 : 0.24;
      this.pupil += (pupilTarget - this.pupil) * (1 - Math.pow(0.01, dt));

      // Piscada (disparada pelo clique)
      let lid = 1;
      if (this.blinkStart >= 0) {
        const p = (now - this.blinkStart) / 240;
        if (p >= 1) this.blinkStart = -1;
        else lid = 1 - 0.92 * Math.sin(p * Math.PI);
      }

      const size = Math.min(w, h);
      const R = size * 0.3 * (1 + this.pulseValue * 0.03);
      const cx = w / 2;
      const cy = h / 2;
      const f = 3.4;
      const tilt = 0.32;
      const cosT = Math.cos(tilt), sinT = Math.sin(tilt);
      const cosS = Math.cos(this.spin), sinS = Math.sin(this.spin);

      // Direção do olhar (frente = z negativo)
      let gx = this.gaze.x * 0.75, gy = this.gaze.y * 0.6, gz = -1;
      const gl = Math.hypot(gx, gy, gz);
      gx /= gl; gy /= gl; gz /= gl;
      const pupilCos = Math.cos(this.pupil);
      const irisCos = Math.cos(this.pupil + 0.3);

      ctx.clearRect(0, 0, w, h);

      // Projeção de um ponto 3D na tela
      const project = (x, y, z) => {
        const s = f / (f + z);
        return { sx: cx + x * R * s, sy: cy + y * R * s * lid, s };
      };

      // ---- Anel (parte de trás) ----
      const ring = [];
      const RING_N = 180;
      const rTiltX = 1.2, rTiltZ = -0.32;
      for (let i = 0; i < RING_N; i++) {
        const t = (i / RING_N) * TAU + this.ringSpin;
        const x0 = Math.cos(t) * 1.62;
        const z0 = Math.sin(t) * 1.62;
        const y1 = -z0 * Math.sin(rTiltX);
        const z1 = z0 * Math.cos(rTiltX);
        const x2 = x0 * Math.cos(rTiltZ) - y1 * Math.sin(rTiltZ);
        const y2 = x0 * Math.sin(rTiltZ) + y1 * Math.cos(rTiltZ);
        ring.push({ x: x2, y: y2, z: z1, i });
      }
      const drawRing = (front) => {
        for (const p of ring) {
          if ((p.z < 0) !== front) continue;
          const q = project(p.x, p.y, p.z);
          const bright = p.i % 6 === 0;
          if (dark) {
            ctx.fillStyle = front
              ? `rgba(192, 132, 252, ${bright ? 1 : 0.6})`
              : `rgba(139, 92, 246, ${bright ? 0.4 : 0.2})`;
          } else {
            ctx.fillStyle = front
              ? `rgba(124, 58, 237, ${bright ? 0.95 : 0.55})`
              : `rgba(167, 139, 250, ${bright ? 0.45 : 0.22})`;
          }
          ctx.beginPath();
          ctx.arc(q.sx, q.sy, (bright ? 2.1 : 1.3) * q.s * (size / 420), 0, TAU);
          ctx.fill();
        }
      };
      drawRing(false);

      // ---- Esfera ----
      const projected = [];
      for (const p of this.points) {
        // gira em Y e inclina em X
        const x1 = p.x * cosS + p.z * sinS;
        const z1 = -p.x * sinS + p.z * cosS;
        const y2 = p.y * cosT - z1 * sinT;
        const z2 = p.y * sinT + z1 * cosT;

        let jitter = 1;
        if (thinking) jitter = 1 + Math.sin(this.time * 7 + p.seed) * 0.035;
        else if (speaking) jitter = 1 + Math.sin(this.time * 4 + p.seed) * 0.012 * (1 + this.pulseValue * 3);

        const x = x1 * jitter, y = y2 * jitter, z = z2 * jitter;
        const dot = (x * gx + y * gy + z * gz) / jitter;
        projected.push({ x, y, z, dot });
      }
      projected.sort((a, b) => b.z - a.z); // do fundo para a frente

      const scaleDot = size / 420;
      for (const p of projected) {
        const q = project(p.x, p.y, p.z);
        const depth = (1 - p.z) / 2; // 0 fundo, 1 frente
        let r = (0.9 + depth * 1.7) * q.s * scaleDot;
        let color;
        if (p.dot > pupilCos) {
          // pupila: no tema escuro vira um "buraco" preto emoldurado pela íris
          color = dark ? 'rgba(4, 2, 8, 1)' : `rgba(27, 15, 46, ${0.55 + depth * 0.45})`;
          r *= 1.25;
        } else if (p.dot > irisCos) {
          const edge = (p.dot - irisCos) / (pupilCos - irisCos); // 0 borda externa, 1 perto da pupila
          color = dark
            ? `rgba(${Math.round(168 + edge * 48)}, ${Math.round(85 + edge * 95)}, ${Math.round(247 + edge * 7)}, ${0.6 + depth * 0.4})`
            : `rgba(${Math.round(168 - edge * 44)}, ${Math.round(85 - edge * 27)}, ${Math.round(247 - edge * 10)}, ${0.5 + depth * 0.5})`;
          r *= 1.15;
        } else {
          color = dark
            ? `rgba(167, 139, 250, ${0.1 + depth * 0.55})`
            : `rgba(139, 92, 246, ${0.08 + depth * 0.5})`;
        }
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, r, 0, TAU);
        ctx.fill();
      }

      // ---- Brilho na pupila (dá vida ao olho) ----
      if (lid > 0.5) {
        const hx = gx - 0.12, hy = gy - 0.14, hz = gz;
        const q = project(hx, hy, hz);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.92)';
        ctx.beginPath();
        ctx.arc(q.sx, q.sy, R * 0.055, 0, TAU);
        ctx.fill();
      }

      // ---- Anel (parte da frente) ----
      drawRing(true);
    }
  }

  window.SaturnEye = SaturnEye;
})();
