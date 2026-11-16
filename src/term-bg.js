/* Sfondi animati 3D per il terminale.
 * Tutte le scene sono disegnate su <canvas> 2D con proiezione prospettica
 * fatta a mano (nessuna dipendenza). Un unico loop requestAnimationFrame
 * disegna su un canvas per ogni .term-host visibile; i colori vengono dalle
 * variabili CSS del tema attivo. Espone window.TermBg. */
(function () {
  const FPS = 30;
  let scene = null;      // nome della scena attiva, null = disattivo
  let rafId = null;
  let lastFrame = 0;
  let colors = {};

  function readColors() {
    const cs = getComputedStyle(document.documentElement);
    const v = (n, f) => cs.getPropertyValue(n).trim() || f;
    colors = {
      accent: v('--accent', '#89b4fa'),
      green: v('--green', '#a6e3a1'),
      red: v('--red', '#f38ba8'),
      yellow: v('--yellow', '#f9e2af'),
      text: v('--text', '#cdd6f4'),
      magenta: v('--magenta', v('--accent', '#89b4fa')),
      cyan: v('--cyan', v('--green', '#a6e3a1')),
    };
  }

  // ---- stato per-canvas (stelle, particelle...) ----
  const states = new WeakMap();
  function stateFor(canvas, name, init) {
    let s = states.get(canvas);
    if (!s || s.name !== name) { s = { name, data: init() }; states.set(canvas, s); }
    return s.data;
  }

  // ---- scene ----
  const SCENES = {
    // volo tra le stelle: punti 3D che vengono verso l'osservatore
    starfield(ctx, w, h, t, canvas) {
      const stars = stateFor(canvas, 'starfield', () => Array.from({ length: 350 }, () => ({
        x: (Math.random() - 0.5) * 2, y: (Math.random() - 0.5) * 2, z: Math.random(),
      })));
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, f = Math.min(w, h) * 0.6;
      const pal = [colors.text, colors.accent, colors.cyan];
      stars.forEach((s, i) => {
        const pz = s.z;
        s.z -= 0.006;
        if (s.z <= 0.02) { s.x = (Math.random() - 0.5) * 2; s.y = (Math.random() - 0.5) * 2; s.z = 1; return; }
        const x1 = cx + (s.x / s.z) * f, y1 = cy + (s.y / s.z) * f;
        const x0 = cx + (s.x / pz) * f, y0 = cy + (s.y / pz) * f;
        ctx.strokeStyle = pal[i % 3];
        ctx.globalAlpha = Math.min(1, (1 - s.z) * 1.4);
        ctx.lineWidth = (1 - s.z) * 2.5;
        ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
      });
      ctx.globalAlpha = 1;
    },

    // griglia retrò in prospettiva che scorre verso l'osservatore, con sole
    grid(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      const horizon = h * 0.45, cx = w / 2;
      // sole a strisce
      const r = Math.min(w, h) * 0.18;
      const g = ctx.createLinearGradient(0, horizon - r, 0, horizon);
      g.addColorStop(0, colors.yellow); g.addColorStop(1, colors.magenta);
      ctx.save();
      ctx.beginPath(); ctx.arc(cx, horizon, r, Math.PI, 0); ctx.clip();
      ctx.fillStyle = g; ctx.fillRect(cx - r, horizon - r, r * 2, r);
      ctx.fillStyle = 'rgba(0,0,0,1)';
      ctx.globalCompositeOperation = 'destination-out';
      for (let i = 0; i < 6; i++) {
        const y = horizon - r * 0.08 - i * r * 0.12;
        ctx.fillRect(cx - r, y, r * 2, 2 + (5 - i) * 0.8);
      }
      ctx.restore();
      // griglia
      ctx.strokeStyle = colors.accent; ctx.lineWidth = 1;
      const camH = 1, f = h * 0.6;
      const off = (t * 0.6) % 1;
      for (let i = 0; i < 30; i++) {
        const z = i + 1 - off;
        const y = horizon + (camH / z) * f;
        if (y > h) continue;
        ctx.globalAlpha = Math.min(1, 1.6 / z);
        ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      }
      ctx.globalAlpha = 0.8;
      // linee longitudinali: convergono nel punto di fuga sull'orizzonte
      for (let i = -20; i <= 20; i++) {
        ctx.beginPath(); ctx.moveTo(cx, horizon); ctx.lineTo(cx + i * f * 0.5, horizon + f); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    // toro wireframe che ruota su due assi
    torus(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      const R = 1, rr = 0.42, U = 36, V = 16;
      const ax = t * 0.35, ay = t * 0.5;
      const cxa = Math.cos(ax), sxa = Math.sin(ax), cya = Math.cos(ay), sya = Math.sin(ay);
      const s = Math.min(w, h) * 0.38, cx = w / 2, cy = h / 2, d = 3.2;
      const pts = [];
      for (let i = 0; i < U; i++) {
        const u = (i / U) * Math.PI * 2; pts[i] = [];
        for (let j = 0; j < V; j++) {
          const v = (j / V) * Math.PI * 2;
          let x = (R + rr * Math.cos(v)) * Math.cos(u);
          let y = (R + rr * Math.cos(v)) * Math.sin(u);
          let z = rr * Math.sin(v);
          let y2 = y * cxa - z * sxa, z2 = y * sxa + z * cxa; y = y2; z = z2;
          let x2 = x * cya + z * sya; z2 = -x * sya + z * cya; x = x2; z = z2;
          const k = d / (d + z);
          pts[i][j] = [cx + x * s * k, cy + y * s * k, z];
        }
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < U; i++) for (let j = 0; j < V; j++) {
        const p = pts[i][j], a = pts[(i + 1) % U][j], b = pts[i][(j + 1) % V];
        const depth = (1.5 - p[2]) / 3;
        ctx.globalAlpha = 0.25 + depth * 0.75;
        ctx.strokeStyle = j % 2 ? colors.accent : colors.cyan;
        ctx.beginPath(); ctx.moveTo(p[0], p[1]); ctx.lineTo(a[0], a[1]);
        ctx.moveTo(p[0], p[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
      ctx.globalAlpha = 1;
    },

    // superficie di punti che ondeggia, vista dall'alto in prospettiva
    wave(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      const N = 44, cx = w / 2, cy = h * 0.35, f = Math.min(w, h) * 0.9;
      const rot = t * 0.15, cr = Math.cos(rot), sr = Math.sin(rot);
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
        const gx = (i / (N - 1) - 0.5) * 4, gz = (j / (N - 1) - 0.5) * 4;
        const x = gx * cr - gz * sr, zz = gx * sr + gz * cr;
        const dist = Math.hypot(gx, gz);
        const y = Math.sin(dist * 2.2 - t * 2) * 0.22 + Math.cos(gx * 1.3 + t) * 0.1;
        const z = zz + 4.2;
        if (z <= 0.3) continue;
        const px = cx + (x / z) * f, py = cy + ((y + 1.1) / z) * f;
        const hgt = (y + 0.32) / 0.64;
        ctx.globalAlpha = Math.min(1, 2.2 / z);
        ctx.fillStyle = hgt > 0.55 ? colors.accent : hgt > 0.3 ? colors.cyan : colors.magenta;
        const sz = 2.4 / z * 1.6;
        ctx.fillRect(px - sz / 2, py - sz / 2, sz, sz);
      }
      ctx.globalAlpha = 1;
    },

    // tunnel di anelli poligonali che scorre e si torce
    tunnel(ctx, w, h, t) {
      ctx.clearRect(0, 0, w, h);
      const cx = w / 2, cy = h / 2, f = Math.min(w, h) * 0.5, sides = 8;
      const off = (t * 1.2) % 1;
      const pal = [colors.accent, colors.magenta, colors.cyan];
      let prev = null;
      for (let i = 24; i >= 0; i--) {
        const z = i + 1 - off;
        const ring = (i + Math.floor(t * 1.2));
        const wob = Math.sin(t * 0.8 + z * 0.35) * 0.35;
        const ox = Math.sin(t * 0.5 + z * 0.2) * 0.4, oy = Math.cos(t * 0.4 + z * 0.25) * 0.3;
        const pts = [];
        for (let k = 0; k < sides; k++) {
          const a = (k / sides) * Math.PI * 2 + wob + t * 0.2;
          pts.push([cx + ((Math.cos(a) + ox) / z) * f * 1.6, cy + ((Math.sin(a) + oy) / z) * f * 1.6]);
        }
        ctx.globalAlpha = Math.min(1, 2.5 / z);
        ctx.strokeStyle = pal[ring % 3]; ctx.lineWidth = Math.min(3, 3 / z * 2);
        ctx.beginPath(); pts.forEach((p, k) => (k ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]))); ctx.closePath(); ctx.stroke();
        if (prev) {
          ctx.lineWidth = 0.6; ctx.beginPath();
          pts.forEach((p, k) => { ctx.moveTo(p[0], p[1]); ctx.lineTo(prev[k][0], prev[k][1]); });
          ctx.stroke();
        }
        prev = pts;
      }
      ctx.globalAlpha = 1;
    },
  };

  function frame(now) {
    rafId = requestAnimationFrame(frame);
    if (now - lastFrame < 1000 / FPS) return;
    lastFrame = now;
    const t = now / 1000;
    const draw = SCENES[scene];
    document.querySelectorAll('.term-host').forEach((host) => {
      if (!host.offsetParent) return; // pannello nascosto: niente lavoro
      let c = host.querySelector(':scope > canvas.term-bg');
      if (!c) { c = document.createElement('canvas'); c.className = 'term-bg'; host.prepend(c); }
      const dpr = window.devicePixelRatio || 1;
      const w = host.clientWidth, h = host.clientHeight;
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr); c.height = Math.round(h * dpr);
      }
      const ctx = c.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw(ctx, w, h, t, c);
    });
  }

  function set(name) {
    scene = name && SCENES[name] ? name : null;
    document.documentElement.classList.toggle('term-bg-on', !!scene);
    if (scene) {
      readColors();
      if (!rafId) rafId = requestAnimationFrame(frame);
    } else {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      document.querySelectorAll('canvas.term-bg').forEach((c) => c.remove());
    }
  }

  window.TermBg = { set, refreshColors: readColors, isOn: () => !!scene, scenes: Object.keys(SCENES) };
})();
