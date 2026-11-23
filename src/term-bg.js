/* Sfondi animati per il terminale.
 * Tutte le scene sono disegnate su <canvas> 2D con proiezione prospettica e
 * simulazioni fatte a mano (nessuna dipendenza). Un unico loop requestAnimationFrame
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
  // delta-tempo per le scene a simulazione (limitato: dopo una pausa non "salta")
  function tick(st, t) {
    const dt = st.lastT == null ? 1 / FPS : Math.min(0.1, Math.max(0, t - st.lastT));
    st.lastT = t;
    return dt;
  }

  // ---- utilità colore ----
  const rgbCache = new Map();
  function toRgb(c) {
    let v = rgbCache.get(c);
    if (v) return v;
    let m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(c);
    if (m) {
      const hx = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
      v = [0, 2, 4].map((i) => parseInt(hx.slice(i, i + 2), 16));
    } else {
      m = /rgba?\(([^)]+)\)/i.exec(c);
      v = m ? m[1].split(',').slice(0, 3).map(parseFloat) : [200, 210, 255];
    }
    rgbCache.set(c, v);
    return v;
  }
  const rgba = (c, a) => { const [r, g, b] = toRgb(c); return `rgba(${r},${g},${b},${a})`; };
  function mix(c1, c2, k) {
    const a = toRgb(c1), b = toRgb(c2);
    return `rgb(${Math.round(a[0] + (b[0] - a[0]) * k)},${Math.round(a[1] + (b[1] - a[1]) * k)},${Math.round(a[2] + (b[2] - a[2]) * k)})`;
  }

  // ---- sprite pre-renderizzati (bagliori), in cache per colore ----
  const sprites = new Map();
  // soft=false: nucleo quasi bianco (stelle, particelle calde); soft=true: alone diffuso
  function glow(c, soft) {
    const key = (soft ? 'h|' : 'g|') + c;
    let s = sprites.get(key);
    if (s) return s;
    s = document.createElement('canvas'); s.width = s.height = 64;
    const g = s.getContext('2d');
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    if (soft) {
      gr.addColorStop(0, rgba(c, 0.5)); gr.addColorStop(0.4, rgba(c, 0.18)); gr.addColorStop(1, rgba(c, 0));
    } else {
      gr.addColorStop(0, rgba(mix(c, '#ffffff', 0.6), 1)); gr.addColorStop(0.16, rgba(c, 0.8));
      gr.addColorStop(0.42, rgba(c, 0.2)); gr.addColorStop(1, rgba(c, 0));
    }
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
    sprites.set(key, s);
    return s;
  }
  // raggio verticale dell'aurora: base netta e brillante, sfuma verso l'alto
  function raySprite(bot, mid, top) {
    const key = 'r|' + bot + '|' + mid + '|' + top;
    let s = sprites.get(key);
    if (s) return s;
    s = document.createElement('canvas'); s.width = 16; s.height = 256;
    const g = s.getContext('2d');
    const gr = g.createLinearGradient(0, 0, 0, 256);
    gr.addColorStop(0, rgba(top, 0));
    gr.addColorStop(0.3, rgba(top, 0.2));
    gr.addColorStop(0.62, rgba(mid, 0.45));
    gr.addColorStop(0.9, rgba(bot, 0.95));
    gr.addColorStop(0.955, rgba(mix(bot, '#ffffff', 0.45), 1));
    gr.addColorStop(1, rgba(bot, 0));
    g.fillStyle = gr; g.fillRect(0, 0, 16, 256);
    g.globalCompositeOperation = 'destination-in';
    const hr = g.createLinearGradient(0, 0, 16, 0);
    hr.addColorStop(0, 'rgba(0,0,0,0)'); hr.addColorStop(0.5, 'rgba(0,0,0,1)'); hr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = hr; g.fillRect(0, 0, 16, 256);
    sprites.set(key, s);
    return s;
  }

  // ---- Perlin noise 3D (Ken Perlin, "improved noise") ----
  const PERM = (() => {
    const p = Array.from({ length: 256 }, (_, i) => i);
    let s = 1337;
    for (let i = 255; i > 0; i--) { s = (s * 16807) % 2147483647; const j = s % (i + 1); [p[i], p[j]] = [p[j], p[i]]; }
    return Uint8Array.from(p.concat(p));
  })();
  const nfade = (x) => x * x * x * (x * (x * 6 - 15) + 10);
  const nlerp = (a, b, k) => a + (b - a) * k;
  function ngrad(hh, x, y, z) {
    const h = hh & 15, u = h < 8 ? x : y, v = h < 4 ? y : (h === 12 || h === 14 ? x : z);
    return ((h & 1) ? -u : u) + ((h & 2) ? -v : v);
  }
  function noise3(x, y, z) {
    const fx = Math.floor(x), fy = Math.floor(y), fz = Math.floor(z);
    const X = fx & 255, Y = fy & 255, Z = fz & 255, P = PERM;
    x -= fx; y -= fy; z -= fz;
    const u = nfade(x), v = nfade(y), q = nfade(z);
    const A = P[X] + Y, AA = P[A] + Z, AB = P[A + 1] + Z, B = P[X + 1] + Y, BA = P[B] + Z, BB = P[B + 1] + Z;
    return nlerp(
      nlerp(nlerp(ngrad(P[AA], x, y, z), ngrad(P[BA], x - 1, y, z), u),
        nlerp(ngrad(P[AB], x, y - 1, z), ngrad(P[BB], x - 1, y - 1, z), u), v),
      nlerp(nlerp(ngrad(P[AA + 1], x, y, z - 1), ngrad(P[BA + 1], x - 1, y, z - 1), u),
        nlerp(ngrad(P[AB + 1], x, y - 1, z - 1), ngrad(P[BB + 1], x - 1, y - 1, z - 1), u), v),
      q);
  }

  // ---- medusa (usata dalla scena "jellyfish") ----
  function drawJelly(ctx, j, col, t) {
    const s = j.s, A = 0.35 + 0.65 * j.d;
    const p = (1 - Math.cos(j.ph)) / 2;            // 0 = rilassata, 1 = contratta
    const bw = s * (1 - 0.17 * p), bh = s * (0.8 + 0.12 * p);
    const pale = mix(col, '#ffffff', 0.4);
    ctx.save();
    ctx.translate(j.x, j.y);
    ctx.rotate(Math.sin(t * 0.15 + j.seed) * 0.16);
    // alone di bioluminescenza
    ctx.globalAlpha = 0.55 * A;
    ctx.drawImage(glow(col, true), -s * 2.4, -bh * 0.5 - s * 2.4, s * 4.8, s * 4.8);
    ctx.globalAlpha = 1;
    // tentacoli: un'onda scende lungo ciascuno, in ritardo rispetto alla pulsazione
    const len = s * 3.4;
    let g = ctx.createLinearGradient(0, 0, 0, len);
    g.addColorStop(0, rgba(col, 0.6 * A)); g.addColorStop(1, rgba(col, 0));
    ctx.strokeStyle = g; ctx.lineWidth = Math.max(0.6, s * 0.016);
    ctx.beginPath();
    for (let k = 0; k < j.tent; k++) {
      const bx = ((k / (j.tent - 1)) * 2 - 1) * bw * 0.86;
      const L = len * (0.65 + 0.35 * Math.abs(Math.sin(k * 2.3 + j.seed)));
      ctx.moveTo(bx, -s * 0.03);
      for (let i = 1; i <= 16; i++) {
        const f = i / 16;
        ctx.lineTo(bx * (1 - 0.3 * f) + Math.sin(j.ph - f * 6 + k * 0.8) * s * 0.2 * f, f * L * (1 - 0.12 * p));
      }
    }
    ctx.stroke();
    // braccia orali: nastri più spessi e mossi al centro
    const al = s * 1.9;
    g = ctx.createLinearGradient(0, 0, 0, al);
    g.addColorStop(0, rgba(pale, 0.5 * A)); g.addColorStop(1, rgba(col, 0));
    ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, s * 0.07); ctx.lineCap = 'round';
    ctx.beginPath();
    for (let k = 0; k < 4; k++) {
      const bx = (k / 3 - 0.5) * bw * 0.35;
      ctx.moveTo(bx, -s * 0.1);
      for (let i = 1; i <= 14; i++) {
        const f = i / 14;
        ctx.lineTo(bx + Math.sin(j.ph * 0.7 - f * 7 + k * 1.6) * s * 0.12 * (0.3 + f), f * al);
      }
    }
    ctx.stroke();
    // campana con bordo smerlato
    ctx.beginPath();
    ctx.moveTo(-bw, 0);
    ctx.bezierCurveTo(-bw * 1.04, -bh * 1.32, bw * 1.04, -bh * 1.32, bw, 0);
    for (let i = 0, sc = 10; i < sc; i++) {
      const x0 = bw - (i / sc) * 2 * bw, x1 = bw - ((i + 1) / sc) * 2 * bw;
      ctx.quadraticCurveTo((x0 + x1) / 2, s * 0.1, x1, 0);
    }
    ctx.closePath();
    g = ctx.createRadialGradient(0, -bh * 0.6, 0, 0, -bh * 0.4, bw * 1.15);
    g.addColorStop(0, rgba(pale, 0.55 * A)); g.addColorStop(0.55, rgba(col, 0.2 * A)); g.addColorStop(1, rgba(col, 0.06 * A));
    ctx.fillStyle = g; ctx.fill();
    ctx.strokeStyle = rgba(col, 0.85 * A); ctx.lineWidth = Math.max(1, s * 0.03); ctx.stroke();
    // sottombrella
    ctx.beginPath();
    ctx.moveTo(-bw * 0.8, -bh * 0.02); ctx.bezierCurveTo(-bw * 0.8, -bh * 0.95, bw * 0.8, -bh * 0.95, bw * 0.8, -bh * 0.02);
    ctx.strokeStyle = rgba(col, 0.3 * A); ctx.lineWidth = Math.max(0.6, s * 0.015); ctx.stroke();
    // gonadi: quadrifoglio luminoso e sfumato (curva a rosa), schiacciato in prospettiva
    ctx.beginPath();
    for (let i = 0; i <= 64; i++) {
      const a = (i / 64) * Math.PI * 2, r = Math.abs(Math.cos(2 * (a + j.seed)));
      ctx.lineTo(Math.cos(a) * r * bw * 0.34, -bh * 0.42 + Math.sin(a) * r * bh * 0.16);
    }
    ctx.closePath();
    ctx.fillStyle = rgba(pale, 0.16 * A); ctx.fill();
    // luci lungo il bordo che si accendono in sequenza
    ctx.fillStyle = mix(col, '#ffffff', 0.65);
    for (let k = 0; k <= 10; k++) {
      ctx.globalAlpha = A * (0.3 + 0.7 * Math.max(0, Math.sin(t * 2.2 - k * 0.7 + j.seed)));
      ctx.beginPath(); ctx.arc((k / 5 - 1) * bw, s * 0.05, Math.max(0.7, s * 0.025), 0, 6.283); ctx.fill();
    }
    ctx.restore();
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

    // aurora boreale: tende di luce sopra le montagne, riflesse in un lago
    aurora(ctx, w, h, t, canvas) {
      const st = stateFor(canvas, 'aurora', () => ({
        stars: Array.from({ length: 240 }, () => ({
          x: Math.random(), y: Math.random(), r: 0.5 + Math.random() ** 4 * 1.6,
          tw: 0.6 + Math.random() * 2.4, ph: Math.random() * 6.283,
        })),
        meteor: null, nextMeteor: t + 4 + Math.random() * 6,
      }));
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      const H = h * 0.74; // pelo dell'acqua
      // stelle che scintillano, più tenui verso l'orizzonte
      ctx.fillStyle = colors.text;
      for (const s of st.stars) {
        const tw = 0.5 + 0.5 * Math.sin(t * s.tw + s.ph);
        ctx.globalAlpha = (0.2 + 0.8 * tw * tw) * (0.35 + 0.65 * (1 - s.y));
        ctx.fillRect(s.x * w - s.r / 2, s.y * H * 0.95 - s.r / 2, s.r, s.r);
      }
      // stella cadente ogni tanto
      if (!st.meteor && t > st.nextMeteor) {
        st.meteor = { x: w * (0.25 + Math.random() * 0.7), y: H * (0.05 + Math.random() * 0.3), born: t, ang: Math.PI * (0.78 + Math.random() * 0.12) };
      }
      if (st.meteor) {
        const m = st.meteor, age = (t - m.born) / 0.9;
        if (age >= 1 || age < 0) { st.meteor = null; st.nextMeteor = t + 6 + Math.random() * 10; } else {
          const S = Math.min(w, h), d = S * 0.8 * age, tl = S * 0.14;
          const hx = m.x + Math.cos(m.ang) * d, hy = m.y + Math.sin(m.ang) * d;
          const tx = hx - Math.cos(m.ang) * tl, ty = hy - Math.sin(m.ang) * tl;
          const g = ctx.createLinearGradient(tx, ty, hx, hy);
          g.addColorStop(0, rgba(colors.text, 0)); g.addColorStop(1, rgba(colors.text, 0.95));
          ctx.globalAlpha = Math.sin(age * Math.PI);
          ctx.strokeStyle = g; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.moveTo(tx, ty); ctx.lineTo(hx, hy); ctx.stroke();
        }
      }
      // tende: base, pieghe e copertura vengono da Perlin noise; la striscia è
      // compressa in orizzontale a tratti, e dove si addensa la luce si somma
      // creando le pieghe brillanti tipiche dell'aurora
      const CURTAINS = [
        { y: 0.5, a: 0.07, p: 0.37, hh: 0.4, b: 1.0, c: [colors.green, colors.cyan, colors.magenta] },
        { y: 0.6, a: 0.05, p: 3.71, hh: 0.28, b: 0.75, c: [colors.cyan, colors.accent, colors.magenta] },
        { y: 0.38, a: 0.06, p: 7.93, hh: 0.24, b: 0.5, c: [colors.green, colors.accent, colors.red] },
      ];
      const step = Math.max(3, w / 320), du = step / w, n2 = (x, y, z) => noise3(x, y, z) * 2;
      const strips = []; // [sprite, x, y, altezza, alpha] * n, calcolati una volta per cielo e riflesso
      for (const C of CURTAINS) {
        const spr = raySprite(C.c[0], C.c[1], C.c[2]);
        for (let u = -0.15; u < 1.15; u += du) {
          const env = Math.min(1, 0.3 + n2(u * 1.4, C.p, t * 0.03) * 1.2);
          if (env <= 0.02) continue;
          const fold = Math.min(1, Math.max(0, 0.5 + n2(u * 9, C.p + 11, t * 0.12) * 0.8));
          const a = env * (0.25 + 0.75 * fold) * (0.7 + 0.3 * n2(u * 110, C.p + 5, t * 0.5)) * C.b;
          if (a < 0.01) continue;
          const x = u * w + w * 0.02 * n2(u * 8, C.p + 7, t * 0.06);
          const base = h * (C.y + C.a * n2(u * 2.2, C.p + 3, t * 0.05) + C.a * 0.3 * n2(u * 7, C.p + 9, t * 0.09));
          const rh = h * C.hh * (0.55 + 0.45 * fold);
          strips.push(spr, x - step, base - rh, rh * 1.04, a);
        }
      }
      const curtains = (mul) => {
        for (let i = 0; i < strips.length; i += 5) {
          ctx.globalAlpha = Math.min(1, strips[i + 4] * mul * 0.7);
          ctx.drawImage(strips[i], strips[i + 1], strips[i + 2], step * 2, strips[i + 3]);
        }
      };
      const REF = 0.5; // il riflesso è schiacciato verso l'orizzonte
      ctx.globalCompositeOperation = 'lighter';
      // bagliore atmosferico basso sull'orizzonte (stacca le montagne dal cielo)
      const sky = ctx.createLinearGradient(0, H, 0, H * 0.45);
      sky.addColorStop(0, rgba(colors.green, 0.1)); sky.addColorStop(1, rgba(colors.green, 0));
      ctx.globalAlpha = 1; ctx.fillStyle = sky; ctx.fillRect(0, H * 0.45, w, H * 0.55);
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, w, H); ctx.clip();
      curtains(1);
      ctx.restore();
      // riflesso nel lago, increspato da bande orizzontali che scorrono
      ctx.save(); ctx.beginPath(); ctx.rect(0, H, w, h - H); ctx.clip();
      ctx.translate(0, H); ctx.scale(1, -REF); ctx.translate(0, -H);
      curtains(0.45);
      ctx.restore();
      ctx.globalCompositeOperation = 'destination-out';
      for (let y = H + 1, i = 0; y < h; y += 2.5 + i * 0.3, i++) {
        ctx.globalAlpha = 0.4 + 0.3 * Math.sin(y * 0.7 - t * 1.6);
        ctx.fillRect(0, y, w, 1 + ((y - H) / (h - H)) * 2);
      }
      // montagne su due piani (più lontane = più chiare), con il loro riflesso
      // creste con "ridged noise" (profili calcolati solo quando cambia la dimensione)
      if (!st.mnt || st.mnt.w !== w || st.mnt.h !== h) {
        const prof = (seed, base, amp) => {
          const out = new Float32Array(Math.ceil(w / 4) + 2);
          for (let i = 0; i < out.length; i++) {
            let v = 0, a = 1, f = 2.5, tot = 0;
            for (let o = 0; o < 5; o++, a *= 0.5, f *= 2.1) {
              const r = 1 - Math.min(1, Math.abs(noise3((i * 4 / w) * f, seed, o * 3.3) * 2));
              v += r * r * a; tot += a;
            }
            out[i] = h * (base + amp * (v / tot));
          }
          return out;
        };
        st.mnt = { w, h, layers: [prof(1.37, 0.01, 0.2), prof(5.71, 0.004, 0.11)] };
      }
      ctx.globalCompositeOperation = 'source-over';
      [0.45, 0.7].forEach((al, layer) => {
        const m = st.mnt.layers[layer];
        ctx.globalAlpha = 1;
        ctx.fillStyle = `rgba(0,0,0,${al})`;
        ctx.beginPath(); ctx.moveTo(0, H);
        for (let i = 0; i < m.length; i++) ctx.lineTo(i * 4, H - m[i]);
        for (let i = m.length - 1; i >= 0; i--) ctx.lineTo(i * 4, H + m[i] * REF);
        ctx.closePath(); ctx.fill();
        if (layer === 0) { // creste lontane appena illuminate dall'aurora
          ctx.globalCompositeOperation = 'lighter';
          ctx.strokeStyle = rgba(colors.green, 0.14); ctx.lineWidth = 1;
          ctx.beginPath();
          for (let i = 0; i < m.length; i++) ctx.lineTo(i * 4, H - m[i]);
          ctx.stroke();
          ctx.globalCompositeOperation = 'source-over';
        }
      });
      ctx.restore();
    },

    // buco nero: disco di accrescimento con lente gravitazionale, beaming
    // Doppler e stelle di sfondo deformate attorno all'anello di Einstein
    blackhole(ctx, w, h, t, canvas) {
      const newClump = (ageFrac) => {
        const r0 = 1.6 + Math.random() ** 1.4 * 3.4, a0 = Math.random() * 6.283;
        const da = 0.3 + Math.random() * 1.1, dr = 0.03 + Math.random() * 0.1;
        const ps = Array.from({ length: 12 }, () => {
          const r = r0 + (Math.random() - 0.5) * dr;
          return { r, a: a0 + (Math.random() - 0.5) * da, w: 1.1 / r ** 1.5, b: 0.35 + Math.random() * 0.65 };
        });
        const life = 15 + Math.random() * 25;
        return { ps, life, age: ageFrac * life };
      };
      const st = stateFor(canvas, 'blackhole', () => ({
        clumps: Array.from({ length: 120 }, () => newClump(Math.random())),
        dust: Array.from({ length: 900 }, () => {
          const r = 1.6 + Math.random() ** 1.6 * 3.6;
          return { r, a: Math.random() * 6.283, w: 1.1 / r ** 1.5, b: 0.12 + Math.random() * 0.22 };
        }),
        stars: Array.from({ length: 320 }, () => ({ x: (Math.random() - 0.5) * 1.3, y: (Math.random() - 0.5) * 1.3, m: Math.random() })),
        lastT: null,
      }));
      const dt = tick(st, t);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      const R = Math.min(w, h) * 0.095;   // raggio dell'ombra
      const E = 1.5;                       // raggio di Einstein (in unità di R)
      const tilt = 0.17 + 0.03 * Math.sin(t * 0.06);
      ctx.translate(w / 2, h / 2);
      ctx.rotate(-0.12 + 0.05 * Math.sin(t * 0.04));
      // lente puntiforme: immagine primaria (fuori) e secondaria (dentro, opposta)
      const L = [0, 0, 0, 0, 0, 0];
      const lens = (x, y) => {
        const b = Math.hypot(x, y) || 1e-4, s = Math.sqrt(b * b + 4 * E * E);
        const kp = (b + s) / (2 * b), km = (b - s) / (2 * b);
        L[0] = x * kp; L[1] = y * kp; L[2] = x * km; L[3] = y * km;
        const u = b / E, A = (u * u + 2) / (u * Math.sqrt(u * u + 4));
        L[4] = Math.min(4, (A + 1) / 2); L[5] = Math.min(3, (A - 1) / 2);
      };
      // stelle di sfondo che scorrono e si piegano attorno al buco
      ctx.fillStyle = colors.text;
      for (const s of st.stars) {
        s.x += dt * 0.004; if (s.x > 0.65) s.x -= 1.3;
        lens((s.x * w) / R, (s.y * h) / R);
        const sz = 0.6 + s.m * 1.1, br = 0.12 + 0.5 * s.m;
        if (L[0] * L[0] + L[1] * L[1] > 1.05) {
          ctx.globalAlpha = Math.min(1, br * L[4]);
          ctx.fillRect(L[0] * R - sz / 2, L[1] * R - sz / 2, sz, sz);
        }
        if (L[5] > 0.05 && L[2] * L[2] + L[3] * L[3] > 1.05) {
          ctx.globalAlpha = Math.min(1, br * L[5]);
          ctx.fillRect(L[2] * R - sz / 2, L[3] * R - sz / 2, sz, sz);
        }
      }
      // ombra
      ctx.globalAlpha = 1; ctx.fillStyle = '#000';
      ctx.beginPath(); ctx.arc(0, 0, R, 0, 6.2832); ctx.fill();
      ctx.globalCompositeOperation = 'lighter';
      const hot = mix(colors.yellow, '#ffffff', 0.55);
      // alone: anello fotonico + arco del disco lensato
      let g = ctx.createRadialGradient(0, 0, R, 0, 0, R * 2.6);
      g.addColorStop(0, rgba(hot, 0)); g.addColorStop(0.03, rgba(hot, 0.5));
      g.addColorStop(0.14, rgba(colors.yellow, 0.1)); g.addColorStop(0.4, rgba(colors.yellow, 0.13));
      g.addColorStop(1, rgba(colors.red, 0));
      ctx.fillStyle = g; ctx.fillRect(-R * 2.6, -R * 2.6, R * 5.2, R * 5.2);
      // bagliore del disco (escluso il lato lontano dietro l'ombra)
      ctx.save();
      ctx.beginPath(); ctx.rect(-w, -h, 2 * w, 2 * h);
      ctx.moveTo(R, 0); ctx.arc(0, 0, R, 0, Math.PI, true); ctx.closePath();
      ctx.clip('evenodd');
      ctx.scale(1, tilt);
      g = ctx.createRadialGradient(0, 0, R * 1.5, 0, 0, R * 5.4);
      g.addColorStop(0, rgba(hot, 0)); g.addColorStop(0.04, rgba(hot, 0.3));
      g.addColorStop(0.3, rgba(colors.yellow, 0.12)); g.addColorStop(1, rgba(colors.red, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, R * 5.4, 0, 6.2832); ctx.fill();
      ctx.restore();
      // particelle: più calde all'interno, più brillanti dal lato che si avvicina
      const NB = 6, cols = [];
      for (let i = 0; i < NB; i++) {
        const k = i / (NB - 1);
        cols.push(glow(k < 0.5 ? mix(hot, colors.yellow, k * 2) : mix(colors.yellow, colors.red, (k - 0.5) * 2)));
      }
      const sz = Math.max(4, R * 0.15);
      const drawP = (r, a, bright) => {
        const dz = r * Math.sin(a), X = r * Math.cos(a), Y = -dz * tilt;
        const spr = cols[Math.min(NB - 1, Math.max(0, ((r - 1.5) / 3.8 * NB) | 0))];
        const base = bright * (1 - 0.62 * Math.cos(a));
        // sprite allungati in orizzontale: scie di gas lungo l'orbita
        if (dz <= 0) { // lato vicino: passa davanti all'ombra
          ctx.globalAlpha = Math.min(1, base);
          ctx.drawImage(spr, X * R - sz * 1.3, Y * R - sz * 0.45, sz * 2.6, sz * 0.9);
          return;
        }
        lens(X, Y);
        const k = Math.min(1, dz / (r * 0.4));
        const px = X + (L[0] - X) * k, py = Y + (L[1] - Y) * k;
        if (px * px + py * py > 1) {
          ctx.globalAlpha = Math.min(1, base * (1 + (L[4] - 1) * k * 0.8));
          ctx.drawImage(spr, px * R - sz * 1.3, py * R - sz * 0.45, sz * 2.6, sz * 0.9);
        }
        if (k > 0.05 && L[2] * L[2] + L[3] * L[3] > 1.04) {
          ctx.globalAlpha = Math.min(1, base * L[5] * k * 0.6);
          ctx.drawImage(spr, L[2] * R - sz * 0.35, L[3] * R - sz * 0.35, sz * 0.7, sz * 0.7);
        }
      };
      for (const p of st.dust) { p.a += p.w * dt; drawP(p.r, p.a, p.b); }
      for (let i = 0; i < st.clumps.length; i++) {
        let c = st.clumps[i];
        c.age += dt;
        if (c.age > c.life) c = st.clumps[i] = newClump(0);
        const env = Math.sin((Math.PI * c.age) / c.life) * 0.85;
        for (const p of c.ps) { p.a += p.w * dt; drawP(p.r, p.a, p.b * env); }
      }
      // anello fotonico netto, più brillante dal lato in avvicinamento
      g = ctx.createLinearGradient(-R, 0, R, 0);
      g.addColorStop(0, rgba(hot, 0.95)); g.addColorStop(1, rgba(hot, 0.3));
      ctx.globalAlpha = 1; ctx.strokeStyle = g; ctx.lineWidth = Math.max(1, R * 0.02);
      ctx.beginPath(); ctx.arc(0, 0, R * 1.04, 0, 6.2832); ctx.stroke();
      ctx.restore();
    },

    // attrattore di Lorenz: comete partite quasi dallo stesso punto che il
    // caos separa (effetto farfalla), su una nuvola che rivela l'attrattore
    lorenz(ctx, w, h, t, canvas) {
      const TRAIL = 480, H = 0.004;
      const st = stateFor(canvas, 'lorenz', () => {
        const dust = new Float32Array(4500 * 3);
        let x = 0.1, y = 0, z = 0;
        for (let i = -400; i < 4500; i++) {
          for (let k = 0; k < 4; k++) {
            const dx = 10 * (y - x), dy = x * (28 - z) - y, dz = x * y - (8 / 3) * z;
            x += dx * H; y += dy * H; z += dz * H;
          }
          if (i >= 0) { dust[i * 3] = x; dust[i * 3 + 1] = y; dust[i * 3 + 2] = z; }
        }
        const comets = Array.from({ length: 7 }, (_, i) => ({ x: -8 + i * 0.03, y: 7, z: 27, trail: [] }));
        return { dust, comets, acc: 0, lastT: null };
      });
      const dt = tick(st, t);
      st.acc += dt * 0.36; // unità di tempo di Lorenz al secondo
      while (st.acc >= H) {
        st.acc -= H;
        for (const c of st.comets) {
          const dx = 10 * (c.y - c.x), dy = c.x * (28 - c.z) - c.y, dz = c.x * c.y - (8 / 3) * c.z;
          c.x += dx * H; c.y += dy * H; c.z += dz * H;
          c.trail.push(c.x, c.y, c.z);
          if (c.trail.length > TRAIL * 3) c.trail.splice(0, 3);
        }
      }
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      const yaw = t * 0.11, pitch = 0.32 + 0.12 * Math.sin(t * 0.05);
      const cyw = Math.cos(yaw), syw = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
      const sc = Math.min(w, h) / 62, cx = w / 2, cy = h / 2, D = 75;
      const P = [0, 0, 0];
      const proj = (x, y, z) => {
        const X = x * cyw - y * syw, Yd = x * syw + y * cyw, Z = z - 25;
        const k = D / (D + Yd * cp - Z * sp);
        P[0] = cx + X * sc * k; P[1] = cy - (Z * cp + Yd * sp) * sc * k; P[2] = k;
      };
      // nuvola dell'attrattore, più luminosa davanti
      const d = st.dust, paths = [new Path2D(), new Path2D(), new Path2D()];
      for (let i = 0; i < d.length; i += 3) {
        proj(d[i], d[i + 1], d[i + 2]);
        paths[P[2] > 1.04 ? 0 : P[2] > 0.97 ? 1 : 2].rect(P[0], P[1], 1.2, 1.2);
      }
      ctx.fillStyle = colors.text;
      [0.3, 0.18, 0.09].forEach((a, i) => { ctx.globalAlpha = a; ctx.fill(paths[i]); });
      // scie al neon: spezzate in tratti con opacità e spessore crescenti
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineJoin = 'round';
      const pal = [colors.accent, colors.magenta, colors.cyan, colors.yellow, colors.green, colors.red, colors.text];
      const CH = 12;
      st.comets.forEach((c, ci) => {
        const n = c.trail.length / 3;
        if (n < 2) return;
        const col = pal[ci % pal.length];
        const pts = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
          proj(c.trail[i * 3], c.trail[i * 3 + 1], c.trail[i * 3 + 2]);
          pts[i * 2] = P[0]; pts[i * 2 + 1] = P[1];
        }
        const per = Math.ceil((n - 1) / CH);
        ctx.strokeStyle = col;
        for (let ch = 0; ch < CH; ch++) {
          const i0 = ch * per, i1 = Math.min(n - 1, i0 + per);
          if (i1 <= i0) break;
          const f = i1 / (TRAIL - 1);
          ctx.beginPath(); ctx.moveTo(pts[i0 * 2], pts[i0 * 2 + 1]);
          for (let i = i0 + 1; i <= i1; i++) ctx.lineTo(pts[i * 2], pts[i * 2 + 1]);
          ctx.globalAlpha = 0.12 * f * f; ctx.lineWidth = 2 + 6 * f; ctx.stroke(); // bagliore
          ctx.globalAlpha = 0.9 * f * f; ctx.lineWidth = 0.5 + 1.6 * f; ctx.stroke();
        }
        const hx = pts[(n - 1) * 2], hy = pts[(n - 1) * 2 + 1];
        ctx.globalAlpha = 1;
        ctx.drawImage(glow(col), hx - 12, hy - 12, 24, 24);
      });
      ctx.restore();
    },

    // seta: migliaia di fili che seguono un campo di flusso "curl noise"
    // (senza divergenza: i fili non si ammassano mai) che cambia lentamente
    silk(ctx, w, h, t, canvas) {
      const st = stateFor(canvas, 'silk', () => ({ ps: [], lastT: null }));
      const dt = tick(st, t);
      const S = Math.min(w, h), LEN = 50, K = 9;
      const N = Math.min(1400, Math.round((w * h) / 900));
      const spawn = (p) => {
        const x = Math.random() * w, y = Math.random() * h;
        p.hist = [x, y]; p.age = 0; p.life = 2.5 + Math.random() * 5; p.dying = false;
        p.c = Math.floor((((x / w) * 0.65 + (y / h) * 0.35 + t * 0.015) % 1) * K);
        return p;
      };
      while (st.ps.length < N) st.ps.push(spawn({}));
      if (st.ps.length > N) st.ps.length = N;
      const z = t * 0.05, e = 0.015, spd = S * 0.06;
      const pot = (x, y) => noise3(x, y, z) + 0.5 * noise3(x * 2.1 + 5.2, y * 2.1 + 1.3, z * 1.6 + 7);
      for (const p of st.ps) {
        if (p.dying) { // la scia si ritira prima di rinascere altrove
          p.hist.splice(0, 2);
          if (p.hist.length < 4) spawn(p);
          continue;
        }
        const n = p.hist.length, x = p.hist[n - 2], y = p.hist[n - 1];
        const nx = (x / S) * 1.5, ny = (y / S) * 1.5;
        const vx = (pot(nx, ny + e) - pot(nx, ny - e)) / (2 * e);
        const vy = -(pot(nx + e, ny) - pot(nx - e, ny)) / (2 * e);
        const x2 = x + vx * spd * dt, y2 = y + vy * spd * dt;
        p.hist.push(x2, y2);
        if (p.hist.length > LEN * 2) p.hist.splice(0, 2);
        p.age += dt;
        if (p.age > p.life || x2 < -20 || y2 < -20 || x2 > w + 20 || y2 > h + 20) p.dying = true;
      }
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.lineWidth = 1.1; ctx.lineJoin = 'round';
      const cyc = [colors.accent, colors.magenta, colors.cyan, colors.accent];
      const CH = 5;
      for (let b = 0; b < K; b++) {
        const kk = (b / K) * 3, i = Math.floor(kk);
        ctx.strokeStyle = mix(cyc[i], cyc[i + 1], kk - i);
        for (let ch = 0; ch < CH; ch++) {
          ctx.globalAlpha = 0.65 * ((ch + 1) / CH) ** 1.5;
          ctx.beginPath();
          for (const p of st.ps) {
            if (p.c !== b) continue;
            const n = p.hist.length / 2;
            const i0 = Math.floor((ch * (n - 1)) / CH), i1 = Math.floor(((ch + 1) * (n - 1)) / CH);
            if (i1 <= i0) continue;
            ctx.moveTo(p.hist[i0 * 2], p.hist[i0 * 2 + 1]);
            for (let q = i0 + 1; q <= i1; q++) ctx.lineTo(p.hist[q * 2], p.hist[q * 2 + 1]);
          }
          ctx.stroke();
        }
      }
      // qualche lucciola in testa ai fili
      ctx.globalAlpha = 0.8;
      st.ps.forEach((p, i) => {
        if (i % 14 || p.dying) return;
        const n = p.hist.length;
        const kk = (p.c / K) * 3, ci = Math.floor(kk);
        ctx.drawImage(glow(mix(cyc[ci], cyc[ci + 1], kk - ci)), p.hist[n - 2] - 5, p.hist[n - 1] - 5, 10, 10);
      });
      ctx.restore();
    },

    // abisso: meduse bioluminescenti che pulsano e risalgono, fasci di luce
    // dalla superficie e "neve marina" che scende lenta
    jellyfish(ctx, w, h, t, canvas) {
      const S = Math.min(w, h);
      const newJelly = (initial) => {
        const d = Math.random(), s = S * (0.04 + 0.07 * d);
        return {
          d, s, x: Math.random() * w,
          // le nuove entrano appena sotto il bordo, con un piccolo sfasamento
          y: initial ? h * (0.15 + Math.random() * 0.9) : h + s * (1.2 + Math.random() * 1.5),
          ph: Math.random() * 6.283, f: 0.3 + Math.random() * 0.25, seed: Math.random() * 100,
          ci: Math.floor(Math.random() * 3), tent: 7 + Math.floor(Math.random() * 5),
        };
      };
      const st = stateFor(canvas, 'jellyfish', () => ({
        jellies: Array.from({ length: 9 }, () => newJelly(true)),
        snow: Array.from({ length: 150 }, () => ({ x: Math.random(), y: Math.random(), z: Math.random(), ph: Math.random() * 6.283 })),
        lastT: null,
      }));
      const dt = tick(st, t);
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      // luce dalla superficie
      let g = ctx.createLinearGradient(0, 0, 0, h * 0.3);
      g.addColorStop(0, rgba(colors.cyan, 0.08)); g.addColorStop(1, rgba(colors.cyan, 0));
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h * 0.3);
      // fasci di luce obliqui che respirano (3 strati per bordi morbidi)
      for (let i = 0; i < 5; i++) {
        const x = w * (0.06 + i * 0.22) + Math.sin(t * 0.06 + i * 1.9) * w * 0.05;
        const tw = S * (0.04 + 0.03 * Math.sin(i * 2.7 + 1)), bw = S * (0.2 + 0.08 * Math.sin(i * 1.3)), sl = w * 0.1;
        const a = 0.035 * (0.5 + 0.5 * Math.sin(t * 0.25 + i * 2.1));
        g = ctx.createLinearGradient(0, 0, 0, h * 0.9);
        g.addColorStop(0, rgba(colors.cyan, a)); g.addColorStop(1, rgba(colors.cyan, 0));
        ctx.fillStyle = g;
        for (const m of [1, 0.66, 0.33]) {
          ctx.beginPath();
          ctx.moveTo(x - tw * m, 0); ctx.lineTo(x + tw * m, 0);
          ctx.lineTo(x + sl + bw * m, h * 0.9); ctx.lineTo(x + sl - bw * m, h * 0.9);
          ctx.closePath(); ctx.fill();
        }
      }
      // neve marina
      ctx.fillStyle = mix(colors.text, colors.cyan, 0.4);
      for (const p of st.snow) {
        p.y += (0.004 + 0.01 * p.z) * dt;
        p.x += Math.sin(t * 0.3 + p.ph) * 0.0015 * dt;
        if (p.y > 1.02) { p.y = -0.02; p.x = Math.random(); }
        ctx.globalAlpha = (0.1 + 0.4 * p.z) * (0.6 + 0.4 * Math.sin(t * 1.3 + p.ph));
        const sz = 0.6 + 1.6 * p.z;
        ctx.fillRect(p.x * w, p.y * h, sz, sz);
      }
      // meduse: spinta durante la contrazione della campana, poi planata
      for (let i = 0; i < st.jellies.length; i++) {
        const j = st.jellies[i];
        j.ph += j.f * 6.283 * dt;
        const thrust = Math.max(0, Math.sin(j.ph));
        j.y -= j.s * (0.12 + 1.3 * thrust * thrust) * dt;
        j.x += Math.sin(t * 0.15 + j.seed) * j.s * 0.25 * dt;
        if (j.x < -j.s * 3) j.x = w + j.s * 3; else if (j.x > w + j.s * 3) j.x = -j.s * 3;
        if (j.y < -j.s * 4.5) st.jellies[i] = newJelly(false);
      }
      const pal = [colors.magenta, colors.cyan, colors.accent];
      st.jellies.slice().sort((a, b) => a.d - b.d).forEach((j) => drawJelly(ctx, j, pal[j.ci], t));
      ctx.restore();
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
