/* =========================================================================
   Sviluppo profili (Profile Sweep) — motore puro, tool 17 di viewifc.com
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente DOM, niente three.js: si prova in Node (test/test_profile_core.js).

   Fase 1 — l'asse 3D:
   - polilinea della PIANTA (anche con archi: bulge) → asse con progressiva,
     punto e tangente in ogni s;
   - polilinea del PROFILO disegnata in un CAD → coppie (progressiva, quota)
     con la taratura del disegno: origine delle progressive, scala delle
     lunghezze, piano di confronto ed esagerazione verticale (10:1 nella
     prassi italiana, lunghezze 1:1000 e altezze 1:100). Più pezzi si
     uniscono in ordine di progressiva; un pezzo disegnato al contrario si
     gira; i salti verticali (due vertici alla stessa progressiva) restano;
   - ANCORAGGI fra le due progressive: coppie (p in pianta, q nel profilo),
     lineari fra una coppia e l'altra. La proposta automatica accoppia i
     vertici della pianta con quelli del profilo (sono quasi sempre gli
     stessi punti del rilievo): catena più lunga di coppie in cui le distanze
     fra coppie consecutive tornano, con i salti di progressiva dove i
     vertici non hanno corrispondenza. Sul T2 dell'utente ritrova le coppie
     del CSV di riferimento (test);
   - ASSE 3D: unione dei vertici della pianta (quota letta sul profilo) e di
     quelli del profilo (punto letto sulla pianta).
   ========================================================================= */

const EPS = 1e-9;

/* -------------------------------------------------------------------------
   Polilinee: { layer, pts: [{ x, y, b }], closed }
   b = bulge del lato che PARTE dal vertice: tan(θ/4), θ > 0 antiorario.
   ------------------------------------------------------------------------- */

/** Arco di un lato con bulge: centro, raggio, angolo iniziale, ampiezza (con segno), lunghezza. */
export function bulgeArc(x0, y0, x1, y1, b) {
  const dx = x1 - x0, dy = y1 - y0, c = Math.hypot(dx, dy);
  if (c < EPS || Math.abs(b) < EPS) return null;
  const sweep = 4 * Math.atan(b);
  const r = c * (1 + b * b) / (4 * Math.abs(b));
  const d = c * (1 - b * b) / (4 * b);              // dal punto medio al centro, sulla normale sinistra della corda
  const cx = (x0 + x1) / 2 - dy / c * d, cy = (y0 + y1) / 2 + dx / c * d;
  return { cx, cy, r, a0: Math.atan2(y0 - cy, x0 - cx), sweep, len: r * Math.abs(sweep) };
}

/** Passo angolare perché la freccia di un arco di raggio r resti entro tol. */
export function arcStep(r, tol) {
  const c = 1 - tol / Math.max(r, tol);
  return c <= -1 ? Math.PI : Math.max(2 * Math.acos(Math.max(-1, Math.min(1, c))), 1e-4);
}

/** Polilinea girata (vertici al contrario, bulge di segno opposto sul lato che ora parte dall'altro capo). */
export function reversePoly(poly) {
  const p = poly.pts, n = p.length, out = [];
  for (let i = n - 1; i >= 0; i--) out.push({ x: p[i].x, y: p[i].y, b: i > 0 ? -(p[i - 1].b || 0) : 0 });
  return { ...poly, pts: out };
}

/** Punti di una polilinea con gli archi spezzati (freccia ≤ tol): [{x, y, v}] con v = indice del vertice o -1. */
export function polyPoints(poly, tol = 0.01) {
  const p = poly.pts, out = [];
  for (let i = 0; i < p.length; i++) {
    out.push({ x: p[i].x, y: p[i].y, v: i });
    if (i === p.length - 1) break;
    const a = bulgeArc(p[i].x, p[i].y, p[i + 1].x, p[i + 1].y, p[i].b || 0);
    if (!a) continue;
    const n = Math.ceil(Math.abs(a.sweep) / arcStep(a.r, tol));
    for (let k = 1; k < n; k++) {
      const t = a.a0 + a.sweep * k / n;
      out.push({ x: a.cx + a.r * Math.cos(t), y: a.cy + a.r * Math.sin(t), v: -1 });
    }
  }
  return out;
}

/** Lunghezza vera di una polilinea (archi compresi). */
export function polyLength(poly) {
  const p = poly.pts;
  let L = 0;
  for (let i = 0; i + 1 < p.length; i++) {
    const a = bulgeArc(p[i].x, p[i].y, p[i + 1].x, p[i + 1].y, p[i].b || 0);
    L += a ? a.len : Math.hypot(p[i + 1].x - p[i].x, p[i + 1].y - p[i].y);
  }
  return L;
}

/* -------------------------------------------------------------------------
   Asse in pianta
   ------------------------------------------------------------------------- */

/**
 * Asse da una polilinea di pianta. I vertici doppi (lato < 1 mm) si tolgono.
 * Ritorna { segs, length, vtx: [{ s, x, y }], arcs }; ogni seg:
 *  - linea: { t: "L", s0, len, x0, y0, x1, y1, ux, uy }
 *  - arco:  { t: "A", s0, len, x0, y0, x1, y1, cx, cy, r, a0, sweep }
 */
export function planAxis(poly, { reverse = false } = {}) {
  let src = reverse ? reversePoly(poly) : poly;
  const pts = [];
  for (const q of src.pts) {
    const last = pts[pts.length - 1];
    if (last && Math.hypot(q.x - last.x, q.y - last.y) < 1e-3) { last.b = q.b || 0; continue; }
    pts.push({ x: q.x, y: q.y, b: q.b || 0 });
  }
  if (pts.length < 2) throw new Error("planAxis: servono almeno due vertici distinti");
  const segs = [], vtx = [{ s: 0, x: pts[0].x, y: pts[0].y }];
  let s = 0, arcs = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const p = pts[i], q = pts[i + 1];
    const a = bulgeArc(p.x, p.y, q.x, q.y, p.b);
    if (a) {
      segs.push({ t: "A", s0: s, len: a.len, x0: p.x, y0: p.y, x1: q.x, y1: q.y, cx: a.cx, cy: a.cy, r: a.r, a0: a.a0, sweep: a.sweep });
      s += a.len; arcs++;
    } else {
      const len = Math.hypot(q.x - p.x, q.y - p.y);
      segs.push({ t: "L", s0: s, len, x0: p.x, y0: p.y, x1: q.x, y1: q.y, ux: (q.x - p.x) / len, uy: (q.y - p.y) / len });
      s += len;
    }
    vtx.push({ s, x: q.x, y: q.y });
  }
  return { segs, length: s, vtx, arcs };
}

function segIndex(axis, s) {
  const g = axis.segs;
  let lo = 0, hi = g.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (g[m].s0 <= s) lo = m; else hi = m - 1; }
  return lo;
}

/** Punto e tangente sull'asse alla progressiva s (oltre i capi prosegue in retta sulla tangente). */
export function planAt(axis, s) {
  const g = axis.segs[segIndex(axis, s)];
  const u = s - g.s0;
  if (g.t === "L") return { x: g.x0 + g.ux * u, y: g.y0 + g.uy * u, tx: g.ux, ty: g.uy };
  const dir = Math.sign(g.sweep);
  const uc = Math.max(0, Math.min(g.len, u)), t = g.a0 + dir * uc / g.r;
  let x = g.cx + g.r * Math.cos(t), y = g.cy + g.r * Math.sin(t);
  const tx = -Math.sin(t) * dir, ty = Math.cos(t) * dir;
  if (u !== uc) { x += tx * (u - uc); y += ty * (u - uc); }
  return { x, y, tx, ty };
}

/** Punti dell'asse con gli archi spezzati (freccia ≤ tol): [{ s, x, y, k }] — k "P" vertice, "A" punto d'arco. */
export function planPoints(axis, tol = 0.01) {
  const out = [{ s: 0, x: axis.vtx[0].x, y: axis.vtx[0].y, k: "P" }];
  for (const g of axis.segs) {
    if (g.t === "A") {
      const n = Math.ceil(Math.abs(g.sweep) / arcStep(g.r, tol));
      for (let k = 1; k < n; k++) { const s = g.s0 + g.len * k / n, p = planAt(axis, s); out.push({ s, x: p.x, y: p.y, k: "A" }); }
    }
    out.push({ s: g.s0 + g.len, x: g.x1, y: g.y1, k: "P" });
  }
  return out;
}

/* -------------------------------------------------------------------------
   Profilo
   ------------------------------------------------------------------------- */

/** Taratura del disegno del profilo: s = s0 + (X − x0)·sx ; z = z0 + (Y − y0)/k. */
export const DEFAULT_CAL = Object.freeze({ x0: 0, s0: 0, sx: 1, y0: 0, z0: 0, k: 1 });

/** Taratura da due punti noti del disegno: (X1,Y1)→(s1,z1), (X2,Y2)→(s2,z2). Servono progressive e quote diverse. */
export function calFromPoints(a, b) {
  const dX = b.X - a.X, dY = b.Y - a.Y, ds = b.s - a.s, dz = b.z - a.z;
  if (Math.abs(dX) < EPS || Math.abs(ds) < EPS || Math.abs(dY) < EPS || Math.abs(dz) < EPS) return null;
  return { x0: a.X, s0: a.s, sx: ds / dX, y0: a.Y, z0: a.z, k: dY / dz };
}

export const calS = (cal, X) => cal.s0 + (X - cal.x0) * cal.sx;
export const calZ = (cal, Y) => cal.z0 + (Y - cal.y0) / cal.k;

/**
 * Linea di profilo da uno o più pezzi di polilinea disegnati nel CAD.
 * Gli archi si spezzano nel disegno (prima della taratura: con l'esagerazione
 * un arco disegnato non è un arco vero). Ogni pezzo si orienta per progressiva
 * crescente; i pezzi si uniscono in ordine; i punti che tornano indietro si
 * scartano. Due vertici alla stessa progressiva (salto, pozzetto) restano.
 * Ritorna { pts: [{ s, z, v }], pieces, gaps: [{ s0, s1, dz }], dropped, s0, s1, zMin, zMax }
 *   v = true sui vertici veri (non sui punti d'arco).
 */
export function profileLine(polys, cal = DEFAULT_CAL, { tol = 0.005 } = {}) {
  const pieces = [];
  for (const poly of polys) {
    const raw = polyPoints(poly, tol).map((p) => ({ s: calS(cal, p.x), z: calZ(cal, p.y), v: p.v >= 0 }));
    if (raw.length < 2) continue;
    if (raw[raw.length - 1].s < raw[0].s) raw.reverse();
    pieces.push(raw);
  }
  if (!pieces.length) throw new Error("profileLine: nessuna polilinea utile");
  pieces.sort((a, b) => a[0].s - b[0].s);
  const pts = [], gaps = [];
  let dropped = 0;
  for (const pc of pieces) {
    for (let i = 0; i < pc.length; i++) {
      const p = pc[i], last = pts[pts.length - 1];
      if (last) {
        if (p.s < last.s - 1e-6) { dropped++; continue; }
        if (i === 0 && p.s > last.s + 1e-6) gaps.push({ s0: last.s, s1: p.s, dz: p.z - last.z });
        if (Math.abs(p.s - last.s) <= 1e-6 && Math.abs(p.z - last.z) <= 1e-6) continue;
        if (Math.abs(p.s - last.s) <= 1e-6) p.s = last.s;
      }
      pts.push({ s: p.s, z: p.z, v: p.v });
    }
  }
  let zMin = Infinity, zMax = -Infinity;
  for (const p of pts) { if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z; }
  return { pts, pieces: pieces.length, gaps, dropped, s0: pts[0].s, s1: pts[pts.length - 1].s, zMin, zMax };
}

/** Quota del profilo a progressiva q (lineare). Su un salto: side > 0 la quota a valle, altrimenti a monte. Fuori → NaN. */
export function zAt(prof, q, side = 1) {
  const p = prof.pts, n = p.length;
  if (q < p[0].s - 1e-6 || q > p[n - 1].s + 1e-6) return NaN;
  q = Math.min(Math.max(q, p[0].s), p[n - 1].s);     // il millesimo di mm degli arrotondamenti sui capi
  let lo = 0, hi = n - 1;                            // ultimo indice con s ≤ q
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (p[m].s <= q + 1e-9) lo = m; else hi = m - 1; }
  if (Math.abs(p[lo].s - q) <= 1e-9) {               // su un vertice (o su un salto: più vertici alla stessa s)
    if (side > 0) return p[lo].z;
    while (lo > 0 && Math.abs(p[lo - 1].s - q) <= 1e-9) lo--;
    return p[lo].z;
  }
  const a = p[lo], b = p[lo + 1];
  return a.z + (b.z - a.z) * (q - a.s) / (b.s - a.s);
}

/** Progressive dei vertici veri del profilo, una sola per salto (per gli ancoraggi). */
export function profileVertexS(prof) {
  const out = [];
  for (const p of prof.pts) if (p.v && (!out.length || p.s - out[out.length - 1] > 1e-6)) out.push(p.s);
  return out;
}

/* -------------------------------------------------------------------------
   Ancoraggi: { p (pianta), q (profilo), auto?, i?, j?, e? }
   ------------------------------------------------------------------------- */

/**
 * Proposta automatica: accoppia i vertici della pianta (planS) con quelli del
 * profilo (profS), entrambi crescenti. Programmazione dinamica sulle coppie
 * (i, j) entro una fascia di scarto |q − p| ≤ band; il passaggio da una coppia
 * alla successiva confronta le due distanze: se tornano entro tolAbs + tolRel·L
 * costa poco, altrimenti è un SALTO di progressiva (lo scarto cambia) e costa
 * jump + |e|/jumpPerM. Ogni coppia vale 1: vince la catena più lunga e coerente.
 * maxSkip vertici saltati per lato fra due coppie vicine; oltre, un salto lungo
 * dalla migliore catena finita più indietro (costa il doppio).
 * Ritorna [{ p, q, i, j, e, auto: true }] (e = scarto delle distanze col precedente).
 */
export function proposeAnchors(planS, profS, opts = {}) {
  const n = planS.length, m = profS.length;
  if (!n || !m) return [];
  const L = Math.max(planS[n - 1] - planS[0], profS[m - 1] - profS[0]);
  const band = opts.band ?? Math.max(50, 0.02 * L), off = opts.offset ?? 0;   // fascia attorno a q ≈ p + offset
  const tolAbs = opts.tolAbs ?? 0.3, tolRel = opts.tolRel ?? 0.01;
  const K = opts.maxSkip ?? 24, jump = opts.jump ?? 2, jumpPerM = opts.jumpPerM ?? 5;
  // per ogni i, l'intervallo di j nella fascia
  const jLo = new Int32Array(n), jHi = new Int32Array(n);
  let a = 0, b = 0;
  for (let i = 0; i < n; i++) {
    while (a < m && profS[a] < planS[i] + off - band) a++;
    if (b < a) b = a;
    while (b < m && profS[b] <= planS[i] + off + band) b++;
    jLo[i] = a; jHi[i] = b;                          // [a, b)
  }
  const score = [], from = [];
  for (let i = 0; i < n; i++) { const w = jHi[i] - jLo[i]; score.push(new Float64Array(w)); from.push(new Int32Array(w * 2).fill(-1)); }
  // migliore catena finita entro la riga r (per i salti lunghi): best[r] = { v, i, j }
  const rowBest = new Array(n);
  const prefBest = new Array(n);
  const trans = (i0, j0, i, j) => {
    const dp = planS[i] - planS[i0], dq = profS[j] - profS[j0], e = Math.abs(dq - dp);
    const tol = tolAbs + tolRel * Math.max(dp, 0);
    return e <= tol ? 0.3 * e / tol : jump + e / jumpPerM;
  };
  for (let i = 0; i < n; i++) {
    const lo = jLo[i], sc = score[i], fr = from[i];
    for (let j = lo; j < jHi[i]; j++) {
      let best = 1, bi = -1, bj = -1;
      for (let i0 = Math.max(0, i - K); i0 < i; i0++) {
        const lo0 = jLo[i0], hi0 = Math.min(jHi[i0], j), s0 = score[i0];
        for (let j0 = Math.max(lo0, j - K); j0 < hi0; j0++) {
          const v = s0[j0 - lo0] + 1 - trans(i0, j0, i, j);
          if (v > best) { best = v; bi = i0; bj = j0; }
        }
      }
      const far = i - K - 1 >= 0 ? prefBest[i - K - 1] : null;      // salto lungo
      if (far && far.j < j) {
        const v = far.v + 1 - 2 * trans(far.i, far.j, i, j);
        if (v > best) { best = v; bi = far.i; bj = far.j; }
      }
      sc[j - lo] = best; fr[2 * (j - lo)] = bi; fr[2 * (j - lo) + 1] = bj;
      if (!rowBest[i] || best > rowBest[i].v) rowBest[i] = { v: best, i, j };
    }
    const prev = i > 0 ? prefBest[i - 1] : null, cur = rowBest[i];
    prefBest[i] = !cur ? prev : !prev || cur.v > prev.v ? cur : prev;
  }
  // la catena migliore: dalla coppia col punteggio più alto, all'indietro
  let end = prefBest[n - 1];
  if (!end) return [];
  const chain = [];
  let ci = end.i, cj = end.j;
  while (ci >= 0) {
    chain.push([ci, cj]);
    const k = 2 * (cj - jLo[ci]), ni = from[ci][k], nj = from[ci][k + 1];
    ci = ni; cj = nj;
  }
  chain.reverse();
  const out = chain.map(([i, j], k) => {
    const e = k ? (profS[j] - profS[chain[k - 1][1]]) - (planS[i] - planS[chain[k - 1][0]]) : 0;
    return { p: planS[i], q: profS[j], i, j, e, auto: true };
  });
  out.score = end.v;
  return out;
}

/** Tolleranza sulle distanze fra due coppie consecutive (la stessa della proposta). */
export const ANCHOR_TOL = Object.freeze({ abs: 0.3, rel: 0.01 });
export const anchorTol = (dp, tol = ANCHOR_TOL) => tol.abs + tol.rel * Math.max(dp, 0);

/**
 * Proposta completa: prova la pianta nei due versi e lo scarto iniziale fra
 * le due progressive (0, oppure quello fra i primi o fra gli ultimi vertici,
 * per un profilo che non parte da 0), e tiene la catena col punteggio più
 * alto. opts.reversed (true/false) impone il verso. Ritorna { anchors, reversed, offset, score }.
 */
export function autoAnchors(poly, prof, opts = {}) {
  const profS = profileVertexS(prof);
  let best = null;
  for (const reversed of opts.reversed === undefined ? [false, true] : [!!opts.reversed]) {
    const axis = planAxis(poly, { reverse: reversed });
    const planS = axis.vtx.map((v) => v.s);
    const offs = [...new Set([0, profS[0] - planS[0], profS[profS.length - 1] - planS[planS.length - 1]].map((x) => Math.round(x * 1000) / 1000))];
    for (const offset of offs) {
      const anchors = proposeAnchors(planS, profS, { ...opts, offset });
      const score = anchors.score ?? 0;
      if (!best || score > best.score + 1e-9) best = { anchors, reversed, offset, score };
    }
  }
  if (best && opts.settle !== false) Object.assign(best, settleAnchors(best.anchors, opts.settleOpts));
  return best;
}

/**
 * Coppie confermate: una coppia lo è se torna entro `exact` con almeno una
 * delle due vicine (fra pianta e profilo nati dagli stessi punti di rilievo
 * le distanze tornano al millimetro: T1 mediana 0, T2 2,6 mm).
 * - «Spalmare» (scelta dell'utente, 2026-10-04): attorno a ogni salto si
 *   spengono le coppie NON confermate, dal salto verso fuori fino alla prima
 *   confermata; il salto si distribuisce così su tutto il tratto senza
 *   corrispondenze sicure. Sul T2 spegne le 4 coppie del tratto ripido 4965–5103
 *   e ritrova il CSV di riferimento; il salto di 1800 (coppie al mm) non cambia.
 * - Profilo con vertici SUOI (livellette, non i punti della pianta): se meno di
 *   `share` dei passaggi fra coppie torna entro `exact`, le coppie interne sono
 *   coincidenze → si tengono solo i capi (progressiva uniforme). Fosso VI02:
 *   504,367 ↔ 504,824 per caso, 1 cm di quota.
 * Le coppie spente restano (off, why: "jump" | "loose") e si riaccendono a clic.
 * Ritorna { anchors (copie), mode: "pairs" | "ends", spread: n spente attorno ai salti }.
 */
export const SETTLE = Object.freeze({ exact: 0.05, share: 0.5 });
export function settleAnchors(anchors, { exact = SETTLE.exact, share = SETTLE.share, tol = ANCHOR_TOL } = {}) {
  const A = anchors.map((a) => ({ ...a }));
  const n = A.length;
  if (n < 3) return { anchors: A, mode: "pairs", spread: 0 };
  const e = [NaN];                                   // e[k]: fra k−1 e k
  for (let k = 1; k < n; k++) e.push((A[k].q - A[k - 1].q) - (A[k].p - A[k - 1].p));
  const good = (k) => k >= 1 && k < n && Math.abs(e[k]) <= exact;
  const shared = e.slice(1).filter((x) => Math.abs(x) <= exact).length / (n - 1);
  if (shared < share) {
    for (let k = 1; k < n - 1; k++) { A[k].off = true; A[k].why = "loose"; }
    return { anchors: A, mode: "ends", spread: 0 };
  }
  const confirmed = (k) => good(k) || good(k + 1);
  let spread = 0;
  const off = (k) => { if (!A[k].off) { A[k].off = true; A[k].why = "jump"; spread++; } };
  for (let k = 1; k < n; k++) {
    if (Math.abs(e[k]) <= anchorTol(A[k].p - A[k - 1].p, tol)) continue;
    for (let j = k - 1; j > 0 && !confirmed(j); j--) off(j);
    for (let j = k; j < n - 1 && !confirmed(j); j++) off(j);
  }
  return { anchors: A, mode: "pairs", spread };
}

/**
 * Scala delle distanze del disegno del profilo (s = sx·X) dedotta dalle
 * lunghezze: l'estensione in X della linea di progetto contro la lunghezza
 * della pianta. Si accettano solo scale da disegno (lunghezze ridotte 1:2…1:100,
 * o X in cm/mm) entro il 2 %; altrimenti 1 (un profilo che copre solo un pezzo
 * della pianta non deve passare per una scala). Fosso VI02: 53,7185 contro
 * 537,185 m → 10 (distanze 1:1000, quote 1:100 nel disegno in metri).
 */
export const SCALES_X = Object.freeze([2, 2.5, 4, 5, 10, 20, 25, 50, 100, 0.01, 0.001]);
export function distanceScale(planLength, drawSpan, tol = 0.02) {
  if (!(planLength > 0) || !(drawSpan > 0)) return 1;
  const r = planLength / drawSpan;
  if (Math.abs(r - 1) <= tol) return 1;
  for (const c of SCALES_X) if (Math.abs(r / c - 1) <= tol) return c;
  return 1;
}

/** Ancoraggi in uso: senza quelli spenti dall'utente (off). */
export const activeAnchors = (anchors) => anchors.filter((a) => !a.off);

/**
 * Salti di progressiva: coppie consecutive (fra quelle in uso) le cui distanze
 * non tornano. Ognuno con lo scarto e — se il profile è dato — la pendenza
 * massima della linea di progetto nel tratto (± margin m): dove è ripido, la
 * posizione del salto sposta le quote e va controllata.
 * Ritorna [{ p0, p1, q0, q1, e, steep }].
 */
export function anchorJumps(anchors, prof = null, { tol = ANCHOR_TOL, margin = 30 } = {}) {
  const { list } = cleanAnchors(activeAnchors(anchors));
  const out = [];
  for (let k = 1; k < list.length; k++) {
    const a = list[k - 1], b = list[k], dp = b.p - a.p, e = (b.q - a.q) - dp;
    if (Math.abs(e) <= anchorTol(dp, tol)) continue;
    let steep = 0;
    if (prof) {
      const P = prof.pts;
      for (let i = 1; i < P.length; i++) {
        const s0 = P[i - 1].s, s1 = P[i].s;
        if (s1 < a.q - margin || s0 > b.q + margin || s1 - s0 < 1e-6) continue;
        steep = Math.max(steep, Math.abs(P[i].z - P[i - 1].z) / (s1 - s0));
      }
    }
    out.push({ p0: a.p, p1: b.p, q0: a.q, q1: b.q, e, steep });
  }
  return out;
}

/**
 * Ancoraggi validi e ordinati: per p crescente; quelli che farebbero tornare
 * indietro q (o due coppie alla stessa p) si scartano e si contano.
 * Ritorna { list, rejected }.
 */
export function cleanAnchors(anchors) {
  const a = anchors.filter((x) => !x.off && Number.isFinite(x.p) && Number.isFinite(x.q)).slice().sort((u, v) => u.p - v.p);
  const list = [];
  let rejected = 0;
  for (const x of a) {
    const last = list[list.length - 1];
    if (last && (x.p - last.p < 1e-6 || x.q - last.q < 1e-6)) { rejected++; continue; }
    list.push(x);
  }
  return { list, rejected };
}

/** Funzione p ↔ q lineare a tratti fra gli ancoraggi; oltre gli estremi pendenza 1. Senza ancoraggi q = p. */
export function anchorMap(anchors) {
  const { list } = cleanAnchors(anchors);
  const P = list.map((x) => x.p), Q = list.map((x) => x.q);
  const f = (X, Y, v) => {
    const n = X.length;
    if (!n) return v;
    if (v <= X[0]) return Y[0] + (v - X[0]);
    if (v >= X[n - 1]) return Y[n - 1] + (v - X[n - 1]);
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (X[m] <= v) lo = m; else hi = m; }
    return Y[lo] + (Y[hi] - Y[lo]) * (v - X[lo]) / (X[hi] - X[lo]);
  };
  return { toQ: (p) => f(P, Q, p), toP: (q) => f(Q, P, q), anchors: list };
}

/** Serie degli scarti per il diagramma: [{ p, d: q − p }] sui vertici della pianta e sugli ancoraggi. */
export function offsetSeries(axis, map) {
  const out = [];
  for (const v of axis.vtx) out.push({ p: v.s, d: map.toQ(v.s) - v.s });
  return out;
}

/* -------------------------------------------------------------------------
   Asse 3D
   ------------------------------------------------------------------------- */

/**
 * Asse 3D: vertici della pianta (con la quota letta sul profilo alla
 * progressiva corrispondente) + vertici del profilo (col punto letto sulla
 * pianta) + punti degli archi. Solo dove esistono entrambi: fuori dal
 * profilo (o oltre i capi della pianta) l'asse si taglia, coi capi
 * interpolati.
 * Ritorna { pts: [{ x, y, z, p, q, k }], length2d, length3d, zMin, zMax, cut: { start, end } }
 *   k: "B" vertice di pianta e di profilo insieme, "P" solo pianta, "V" solo profilo, "A" arco, "E" capo tagliato.
 */
export function buildAxis3D(axis, prof, anchors, { tol = 0.01 } = {}) {
  const map = anchorMap(anchors);
  const pLo = Math.max(0, map.toP(prof.s0)), pHi = Math.min(axis.length, map.toP(prof.s1));
  if (!(pHi > pLo)) return { pts: [], length2d: 0, length3d: 0, zMin: NaN, zMax: NaN, cut: { start: 0, end: 0 } };
  // punti della pianta (xy) e del profilo (quota), ordinati per progressiva in pianta
  const items = [];
  for (const pp of planPoints(axis, tol)) if (pp.s >= pLo - 1e-9 && pp.s <= pHi + 1e-9) items.push({ p: pp.s, plan: true, vtx: pp.k === "P", x: pp.x, y: pp.y, ord: -1 });
  prof.pts.forEach((pt, ord) => {
    const p = map.toP(pt.s);
    if (p >= pLo - 1e-9 && p <= pHi + 1e-9) items.push({ p, plan: false, vtx: pt.v, q: pt.s, z: pt.z, ord });
  });
  items.sort((u, v) => u.p - v.p || u.ord - v.ord);
  // a gruppi della stessa progressiva (entro 0,1 mm): la pianta dà il punto, il profilo le quote (più d'una su un salto)
  const pts = [];
  for (let g = 0; g < items.length;) {
    let h = g + 1;
    while (h < items.length && items[h].p - items[g].p < 1e-4) h++;
    const grp = items.slice(g, h), pl = grp.find((it) => it.plan), pr = grp.filter((it) => !it.plan);
    const xy = pl || planAt(axis, grp[0].p);
    if (pr.length) {
      for (const it of pr) pts.push({ x: xy.x, y: xy.y, z: it.z, p: pl ? pl.p : it.p, q: it.q, k: it.vtx ? (pl && pl.vtx ? "B" : "V") : (pl && pl.vtx ? "P" : "A") });
    } else {
      const q = map.toQ(pl.p), z = zAt(prof, q, 1);
      if (Number.isFinite(z)) pts.push({ x: pl.x, y: pl.y, z, p: pl.p, q, k: pl.vtx ? "P" : "A" });
    }
    g = h;
  }
  // capi: se il taglio cade a metà, un punto sul capo
  const cap = (p, first) => {
    const q = map.toQ(p), a = planAt(axis, p), z = zAt(prof, q, first ? -1 : 1);
    return { x: a.x, y: a.y, z, p, q, k: "E" };
  };
  if (pts.length && pts[0].p > pLo + 1e-4) pts.unshift(cap(pLo, true));
  if (pts.length && pts[pts.length - 1].p < pHi - 1e-4) pts.push(cap(pHi, false));
  let l2 = 0, l3 = 0, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < pts.length; i++) {
    const z = pts[i].z;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
    if (i) { const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); l2 += d; l3 += Math.hypot(d, z - pts[i - 1].z); }
  }
  return { pts, length2d: l2, length3d: l3, zMin, zMax, cut: { start: pLo, end: axis.length - pHi } };
}

/* =========================================================================
   Fosso (fasi 2–3): DTM, stazioni, sezione trapezia rivestita con banchina e
   scarpate fino al terreno, aree e volumi, mesh.
   Scelte dell'utente (2026-10-04, fosso di guardia VI02): fondo 0,50, altezza
   0,50, sponde 1:1 (bocca 1,50), rivestimento in cls 15 cm; banchina 0,50 dal
   bordo esterno del rivestimento, poi scarpate 3/2 in sterro e in riporto.
   La linea del profilo è lo SCORRIMENTO (fondo interno).
   Sezioni VERTICALI e ortogonali all'asse in pianta; sui vertici della
   pianta a bisettrice (offset × 1/cos della mezza deviazione, le pareti
   restano parallele). Volumi per sezioni ragguagliate: (A₁ + A₂)/2 · Δp.
   ========================================================================= */

/**
 * DTM come TIN con indice a griglia. points [x,y,z…], faces [a,b,c…] (anche
 * coordinate UTM: le differenze restano in doppia precisione). top: dove più
 * triangoli coprono il punto (la toposolid di Revit porta anche il fondo) vale
 * il più alto. Ritorna { z(x, y) → quota o NaN, bbox, zMin, zMax, triangles }.
 */
export function tinSampler(points, faces, { top = true, cell = 0 } = {}) {
  const nT = Math.floor(faces.length / 3);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i + 2 < points.length; i += 3) {
    const x = points[i], y = points[i + 1], z = points[i + 2];
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < zMin) zMin = z; if (z > zMax) zMax = z;
  }
  if (!nT || !(x1 >= x0)) return { z: () => NaN, bbox: null, zMin: NaN, zMax: NaN, triangles: 0 };
  if (!cell) cell = Math.max(0.25, 2 * Math.sqrt(Math.max(1e-6, (x1 - x0) * (y1 - y0)) / nT));
  while (((x1 - x0) / cell + 1) * ((y1 - y0) / cell + 1) > 4e6) cell *= 2;
  const W = Math.floor((x1 - x0) / cell) + 1, H = Math.floor((y1 - y0) / cell) + 1;
  const start = new Uint32Array(W * H + 1);
  const cellsOf = (t, fn) => {
    const a = 3 * faces[3 * t], b = 3 * faces[3 * t + 1], c = 3 * faces[3 * t + 2];
    const i0 = Math.floor((Math.min(points[a], points[b], points[c]) - x0) / cell), i1 = Math.floor((Math.max(points[a], points[b], points[c]) - x0) / cell);
    const j0 = Math.floor((Math.min(points[a + 1], points[b + 1], points[c + 1]) - y0) / cell), j1 = Math.floor((Math.max(points[a + 1], points[b + 1], points[c + 1]) - y0) / cell);
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * W + i);
  };
  for (let t = 0; t < nT; t++) cellsOf(t, (c) => start[c + 1]++);
  for (let c = 0; c < W * H; c++) start[c + 1] += start[c];
  const list = new Uint32Array(start[W * H]), fill = start.slice(0, W * H);
  for (let t = 0; t < nT; t++) cellsOf(t, (c) => { list[fill[c]++] = t; });
  const z = (x, y) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((y - y0) / cell);
    if (i < 0 || j < 0 || i >= W || j >= H) return NaN;
    const c = j * W + i;
    let best = NaN;
    for (let k = start[c]; k < start[c + 1]; k++) {
      const t = list[k], a = 3 * faces[3 * t], b = 3 * faces[3 * t + 1], q = 3 * faces[3 * t + 2];
      const ax = points[a], ay = points[a + 1], bx = points[b], by = points[b + 1], cx = points[q], cy = points[q + 1];
      const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
      if (Math.abs(d) < 1e-12) continue;                                      // triangolo verticale o degenere
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d, l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const zz = l1 * points[a + 2] + l2 * points[b + 2] + l3 * points[q + 2];
      if (!top) return zz;
      if (!(zz <= best)) best = zz;
    }
    return best;
  };
  return { z, bbox: { x0, y0, x1, y1 }, zMin, zMax, triangles: nT, cell };
}

/**
 * Più DTM in uno (la topografia esistente del progetto può arrivare in più
 * file): punti in coda, facce rinumerate. Dove due file si sovrappongono
 * tinSampler prende il più alto, come per il fondo della toposolid.
 */
export function tinMerge(list) {
  let nP = 0, nF = 0;
  for (const t of list) { nP += t.points.length; nF += t.faces.length; }
  const points = new Float64Array(nP), faces = new Uint32Array(nF);
  let p = 0, f = 0;
  for (const t of list) {
    points.set(t.points, p);
    const off = p / 3;
    for (let i = 0; i < t.faces.length; i++) faces[f + i] = t.faces[i] + off;
    p += t.points.length; f += t.faces.length;
  }
  return { points, faces };
}

/** Solo i triangoli che toccano il rettangolo (il corridoio dell'asse): punti rinumerati. */
export function tinCrop(points, faces, { x0, y0, x1, y1 }) {
  const map = new Int32Array(points.length / 3).fill(-1), P = [], F = [];
  for (let t = 0; t + 2 < faces.length; t += 3) {
    const v = [faces[t], faces[t + 1], faces[t + 2]];
    const xs = v.map((k) => points[3 * k]), ys = v.map((k) => points[3 * k + 1]);
    if (Math.max(...xs) < x0 || Math.min(...xs) > x1 || Math.max(...ys) < y0 || Math.min(...ys) > y1) continue;
    for (const k of v) {
      if (map[k] < 0) { map[k] = P.length / 3; P.push(points[3 * k], points[3 * k + 1], points[3 * k + 2]); }
      F.push(map[k]);
    }
  }
  return { points: Float64Array.from(P), faces: Uint32Array.from(F) };
}

/**
 * Stazioni lungo l'asse: i punti dell'asse 3D (vertici di pianta e profilo,
 * punti d'arco, salti) + una ogni `step` m + le progressive in `extra` (i capi
 * dei tratti). Ognuna: { p, x, y, z, nx, ny, k } — n = normale a DESTRA
 * (guardando avanti), k = 1/cos della mezza deviazione sui vertici.
 */
export function sweepStations(axis, prof, anchors, { step = 1, extra = [], p0 = -Infinity, p1 = Infinity } = {}) {
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return [];
  const map = anchorMap(anchors);
  const lo = Math.max(p0, ax3.pts[0].p), hi = Math.min(p1, ax3.pts[ax3.pts.length - 1].p);
  if (!(hi > lo)) return [];
  const st = ax3.pts.filter((q) => q.p >= lo - 1e-9 && q.p <= hi + 1e-9).map((q) => ({ p: q.p, x: q.x, y: q.y, z: q.z }));
  const at = (p) => { const w = planAt(axis, p); return { p, x: w.x, y: w.y, z: zAt(prof, map.toQ(p), 1) }; };
  const have = st.map((q) => q.p);
  const near = (p, d) => have.some((h) => Math.abs(h - p) < d);
  for (const p of [lo, hi, ...extra]) if (p >= lo - 1e-9 && p <= hi + 1e-9 && !near(p, 1e-4)) { st.push(at(Math.min(hi, Math.max(lo, p)))); have.push(p); }
  if (step > 0) for (let p = Math.ceil(lo / step) * step; p < hi; p += step) if (!near(p, step * 0.25)) st.push(at(p));
  st.sort((a, b) => a.p - b.p);
  const out = st.filter((q) => Number.isFinite(q.z));
  for (const q of out) {
    const a = planAt(axis, Math.max(0, q.p - 1e-6)), b = planAt(axis, Math.min(axis.length, q.p + 1e-6));
    const ni = [a.ty, -a.tx], no = [b.ty, -b.tx];
    let nx = ni[0] + no[0], ny = ni[1] + no[1];
    const L = Math.hypot(nx, ny);
    if (L < 1e-9) { nx = no[0]; ny = no[1]; } else { nx /= L; ny /= L; }
    q.nx = nx; q.ny = ny;
    q.k = Math.min(4, 1 / Math.max(0.25, nx * no[0] + ny * no[1]));
  }
  return out;
}

/** Fosso trapezio: valori dell'utente (VI02). */
export const DITCH = Object.freeze({ b: 0.5, h: 0.5, m: 1, t: 0.15, berm: 0.5, cut: 1.5, fill: 1.5 });

const shoelace = (P) => { let a = 0; for (let i = 0; i < P.length; i++) { const p = P[i], q = P[(i + 1) % P.length]; a += p[0] * q[1] - q[0] * p[1]; } return a / 2; };

/**
 * Sezione del fosso in coordinate (u orizzontale dall'asse, a destra +; v
 * verticale dallo scorrimento). b fondo, h altezza, m sponde (orizz./vert.),
 * t spessore del rivestimento (perpendicolare alle pareti), berm banchina
 * dal bordo esterno del rivestimento, cut/fill scarpe (orizz./vert.).
 *   ui ciglio interno, uo bordo esterno del rivestimento in sommità,
 *   ub spigolo esterno del fondo, ue fine della banchina.
 */
export function ditchShape(d = DITCH) {
  const L = Math.hypot(1, d.m), hb = d.b / 2;
  const ui = hb + d.m * d.h, uo = ui + d.t * L, ub = Math.max(0, hb - d.m * d.t + d.t * L), ue = uo + d.berm;
  const inner = [[-ui, d.h], [-hb, 0], [hb, 0], [ui, d.h]];
  const outer = [[-uo, d.h], [-ub, -d.t], [ub, -d.t], [uo, d.h]];
  const ring = [...inner, ...outer.slice().reverse()];
  return { d: { ...d }, hb, ui, uo, ub, ue, h: d.h, t: d.t, inner, outer, ring, liningArea: Math.abs(shoelace(ring)), waterArea: (hb + ui) * d.h, top: 2 * ui };
}

/** Linea spezzata v(u) (u crescente), costante fuori dai capi. */
function polyV(P, u) {
  if (u <= P[0][0]) return P[0][1];
  for (let i = 1; i < P.length; i++) if (u <= P[i][0]) { const a = P[i - 1], b = P[i]; return b[0] - a[0] < 1e-12 ? b[1] : a[1] + (b[1] - a[1]) * (u - a[0]) / (b[0] - a[0]); }
  return P[P.length - 1][1];
}

/**
 * Una scarpata dal punto (sgn·u0, v0) verso fuori fino al terreno T(u): sale
 * di 1/up dove il terreno sta sopra (sterro), scende di 1/down dove sta sotto
 * (riporto; down = 0: non scende e si ferma lì). Il punto d'incontro si cerca
 * a passi di du e si affina per bisezione; oltre reach o fuori dal DTM ok = false.
 * Ritorna { u, v, kind: "cut"|"fill"|null, ok }.
 */
function meet(T, sgn, u0, v0, up, down, du, reach) {
  const T0 = T(sgn * u0);
  if (!Number.isFinite(T0)) return { u: sgn * u0, v: v0, kind: null, ok: false };
  if (Math.abs(T0 - v0) < 1e-9) return { u: sgn * u0, v: v0, kind: "cut", ok: true };
  const cut = T0 > v0;
  if (!cut && !down) return { u: sgn * u0, v: v0, kind: null, ok: true };
  const s = cut ? up : down, dir = cut ? 1 : -1;
  const vS = (w) => v0 + dir * (w - u0) / s;
  const f = (w) => { const t = T(sgn * w); return Number.isFinite(t) ? (t - vS(w)) * dir : NaN; };
  let a = u0;
  for (let w = u0 + du; w <= u0 + reach + 1e-9; w += du) {
    const fw = f(w);
    if (!Number.isFinite(fw)) return { u: sgn * a, v: vS(a), kind: cut ? "cut" : "fill", ok: false };
    if (fw <= 0) {
      let lo = a, hi = w;
      for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2, fm = f(m); if (fm > 0) lo = m; else hi = m; }
      const u = (lo + hi) / 2;
      return { u: sgn * u, v: vS(u), kind: cut ? "cut" : "fill", ok: true };
    }
    a = w;
  }
  return { u: sgn * a, v: vS(a), kind: cut ? "cut" : "fill", ok: false, far: true };
}

/**
 * Sezione trasversale a una stazione. T(u) = quota del terreno MENO quella
 * dello scorrimento (NaN fuori dal DTM). Dalla fine della banchina una
 * scarpata sale (sterro, terreno sopra il ciglio) o scende (riporto) fino al
 * terreno; il punto d'incontro si cerca a passi di du e si affina per
 * bisezione. D = fondo scavo / piano di posa: scarpata, banchina, esterno del
 * rivestimento. Aree fra terreno e D: sterro dove il terreno sta sopra,
 * riporto dove sta sotto.
 * Ritorna { L, R: { u, v, kind: "cut"|"fill"|null, ok }, D, cut, fill, ok }.
 */
export function ditchCross(sh, T, { du = 0.1, reach = 50 } = {}) {
  const { d, ue, uo, ub, h } = sh;
  const L = meet(T, -1, ue, h, d.cut, d.fill, du, reach), R = meet(T, 1, ue, h, d.cut, d.fill, du, reach);
  const D = [[L.u, L.v], [-ue, h], [-uo, h], [-ub, -d.t], [ub, -d.t], [uo, h], [ue, h], [R.u, R.v]];
  // aree: campioni ogni du più i vertici di D, (T − D) lineare fra due campioni
  const us = D.map((q) => q[0]);
  for (let u = Math.ceil(L.u / du) * du; u < R.u; u += du) us.push(u);
  us.sort((a, b) => a - b);
  let cut = 0, fill = 0, g0 = NaN, u0 = NaN;
  for (const u of us) {
    const t = T(u), g = Number.isFinite(t) ? t - polyV(D, u) : NaN;
    if (Number.isFinite(g) && Number.isFinite(g0) && u > u0) {
      const w = u - u0;
      if (g0 >= 0 && g >= 0) cut += (g0 + g) / 2 * w;
      else if (g0 <= 0 && g <= 0) fill -= (g0 + g) / 2 * w;
      else { const r = g0 / (g0 - g) * w; if (g0 > 0) { cut += g0 * r / 2; fill -= g * (w - r) / 2; } else { fill -= g0 * r / 2; cut += g * (w - r) / 2; } }
    }
    g0 = g; u0 = u;
  }
  return { L, R, D, cut, fill, ok: L.ok && R.ok };
}

/* ---------- mesh: anelli a topologia fissa fra le stazioni ---------- */

/** Dove g cambia segno fra due campioni, il campione libero più vicino va sull'incrocio (bisezione). */
function snapCross(us, fixed, g) {
  for (let j = 0; j + 1 < us.length; j++) {
    const ga = g(us[j]), gb = g(us[j + 1]);
    if (!(ga * gb < 0)) continue;
    let lo = us[j], hi = us[j + 1];
    for (let it = 0; it < 40; it++) { const mid = (lo + hi) / 2; if (g(mid) * ga > 0) lo = mid; else hi = mid; }
    const x = (lo + hi) / 2;
    const k = !fixed[j + 1] && (fixed[j] || us[j + 1] - x < x - us[j]) ? j + 1 : !fixed[j] ? j : -1;
    if (k >= 0) us[k] = x;
  }
}
/** Il campione libero accanto a x (campioni crescenti) va su x: lo spigolo di una scarpata. */
function snapAt(us, fixed, x) {
  let j = 0;
  while (j + 1 < us.length && us[j + 1] < x) j++;
  if (j + 1 >= us.length || Math.abs(us[j] - x) < 1e-9 || Math.abs(us[j + 1] - x) < 1e-9) return;
  const k = !fixed[j + 1] && (fixed[j] || us[j + 1] - x < x - us[j]) ? j + 1 : !fixed[j] ? j : -1;
  if (k >= 0) us[k] = x;
}

/** u lungo D a passi fissi per tratto (stessa topologia a ogni stazione): scarpata nS, banchina nB, parete nL, fondo nM. */
function ringU(c, sh, { nS = 10, nB = 2, nL = 3, nM = 2 } = {}) {
  const out = [], fixed = [];
  const seg = (a, b, n) => { for (let i = 0; i < n; i++) { out.push(a + (b - a) * i / n); fixed.push(i === 0); } };
  seg(c.L.u, -sh.ue, nS); seg(-sh.ue, -sh.uo, nB); seg(-sh.uo, -sh.ub, nL); seg(-sh.ub, sh.ub, nM);
  seg(sh.ub, sh.uo, nL); seg(sh.uo, sh.ue, nB); seg(sh.ue, c.R.u, nS); out.push(c.R.u); fixed.push(true);
  return { us: out, fixed };
}

/**
 * Loft di anelli (stessa lunghezza) con i tappi: ogni anello è un poligono
 * [basso₀…basso_N, alto_N…alto₀]; i tappi a strisce fra basso e alto.
 * flip = null: facce girate se il volume viene negativo (normali verso
 * fuori); per un solido quasi tutto a spessore zero (il riporto dove non c'è)
 * il segno del volume è rumore → il verso si passa (flip true/false).
 */
function loftBand(rings, flip = null, zero = null) {
  const n = rings.length, m = rings[0].length, half = m / 2;
  const P = new Float64Array(n * m * 3), I = [];
  rings.forEach((r, i) => r.forEach((p, j) => { P.set(p, 3 * (i * m + j)); }));
  // zero[i][j]: spessore nullo nel campione j della stazione i → sopra e sotto coincidono: le due facce si tolgono insieme
  const empty = (i, j) => zero && zero[i][j] && zero[i][j + 1] && zero[i + 1][j] && zero[i + 1][j + 1];
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j < m; j++) {
    if (j < half - 1 && empty(i, j)) continue;                                      // basso j → j+1
    if (j >= half && j < m - 1 && empty(i, m - 2 - j)) continue;                    // alto (stesso tratto, al contrario)
    const a = i * m + j, b = i * m + (j + 1) % m, c = (i + 1) * m + (j + 1) % m, e = (i + 1) * m + j;
    I.push(a, b, c, a, c, e);
  }
  for (const [i, flip] of [[0, true], [n - 1, false]]) for (let j = 0; j + 1 < half; j++) {
    const b0 = i * m + j, b1 = i * m + j + 1, t1 = i * m + (m - 2 - j), t0 = i * m + (m - 1 - j);
    if (flip) I.push(b0, t1, b1, b0, t0, t1); else I.push(b0, b1, t1, b0, t1, t0);
  }
  const mesh = { positions: P, index: Uint32Array.from(I) };
  mesh.flipped = flip === null ? meshVolume(mesh) < 0 : flip;
  if (mesh.flipped) for (let k = 0; k < mesh.index.length; k += 3) { const t = mesh.index[k + 1]; mesh.index[k + 1] = mesh.index[k + 2]; mesh.index[k + 2] = t; }
  return mesh;
}

/** Via i triangoli di area nulla (scavo o riporto che non c'è) e i vertici rimasti senza triangoli. */
export function compactMesh({ positions: P, index: I }, eps = 1e-6) {
  const keep = [], used = new Int32Array(P.length / 3).fill(-1), Q = [];
  for (let k = 0; k < I.length; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) <= eps) continue;
    for (const v of [I[k], I[k + 1], I[k + 2]]) { if (used[v] < 0) { used[v] = Q.length / 3; Q.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); } keep.push(used[v]); }
  }
  return { positions: Float64Array.from(Q), index: Uint32Array.from(keep) };
}

/** Volume con segno di una mesh chiusa (teorema della divergenza). */
export function meshVolume({ positions: P, index: I }) {
  let v = 0;
  for (let k = 0; k < I.length; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
  return v / 6;
}

/** Superficie aperta fra anelli (strisce). */
function loftOpen(rings) {
  const n = rings.length, m = rings[0].length, P = new Float64Array(n * m * 3), I = [];
  rings.forEach((r, i) => r.forEach((p, j) => { P.set(p, 3 * (i * m + j)); }));
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j + 1 < m; j++) { const a = i * m + j, b = a + 1, c = a + m + 1, e = a + m; I.push(a, b, c, a, c, e); }
  return { positions: P, index: Uint32Array.from(I) };
}

/**
 * Il fosso lungo le stazioni: sezioni, volumi per sezioni ragguagliate e
 * mesh nelle coordinate locali (x − O.x, y − O.y, z). zAt3(x, y) = quota del
 * DTM (NaN fuori). Stazioni senza terreno o con la scarpata che non lo trova
 * entro `reach` si contano in `miss` (lì la scarpata si ferma).
 * Ritorna { sections, length, vol: { lining, cut, fill }, mesh: { lining, cut, fill, surface }, miss }.
 */
export function ditchSweep(stations, sh, zAt3, { O = { x: 0, y: 0 }, du = 0.1, reach = 50, ring = {} } = {}) {
  const sections = stations.map((st) => {
    const T = (u) => zAt3(st.x + st.nx * u * st.k, st.y + st.ny * u * st.k) - st.z;
    const c = ditchCross(sh, T, { du, reach });
    const { us, fixed } = ringU(c, sh, ring);
    // dove terreno e fondo scavo si incrociano fra due campioni, il campione libero più vicino va
    // sull'incrocio: la mesh ritrova il volume delle sezioni anche al passaggio sterro/riporto
    snapCross(us, fixed, (u) => T(u) - polyV(c.D, u));
    const Tu = us.map((u) => T(u)), Du = us.map((u) => polyV(c.D, u));
    return { p: st.p, x: st.x, y: st.y, z: st.z, nx: st.nx, ny: st.ny, k: st.k, L: c.L, R: c.R, cut: c.cut, fill: c.fill, ok: c.ok, us, Tu, Du };
  });
  const vol = { lining: 0, cut: 0, fill: 0 };
  let length = 0;
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i], dp = b.p - a.p;
    length += dp;
    vol.cut += (a.cut + b.cut) / 2 * dp; vol.fill += (a.fill + b.fill) / 2 * dp;
  }
  vol.lining = sh.liningArea * length;
  const P3 = (s, u, v) => [s.x + s.nx * u * s.k - O.x, s.y + s.ny * u * s.k - O.y, s.z + v];
  let mesh = null;
  if (sections.length >= 2) {
    // il rivestimento è un solido vero: il suo verso si decide dal volume; il suo anello gira al
    // contrario di quelli di scavo e riporto (interno sopra, esterno sotto) → verso opposto
    const lining = loftBand(sections.map((s) => [...sh.inner.map(([u, v]) => P3(s, u, v)), ...sh.outer.slice().reverse().map(([u, v]) => P3(s, u, v))]));
    const band = (pick) => {
      const zero = [];
      const rings = sections.map((s) => {
        const lo = [], hi = [], z = [];
        s.us.forEach((u, j) => { const [a, b] = pick(s.Du[j], Number.isFinite(s.Tu[j]) ? s.Tu[j] : s.Du[j]); lo.push(P3(s, u, a)); hi.push(P3(s, u, b)); z.push(b - a < 1e-9); });
        zero.push(z);
        return lo.concat(hi.reverse());
      });
      return compactMesh(loftBand(rings, !lining.flipped, zero));
    };
    mesh = {
      lining,
      cut: band((D, T) => [D, Math.max(D, T)]),
      fill: band((D, T) => [Math.min(D, T), D]),
      surface: loftOpen(sections.map((s) => {
        const F = [[s.L.u, s.L.v], [-sh.ue, sh.h], [-sh.uo, sh.h], ...sh.inner, [sh.uo, sh.h], [sh.ue, sh.h], [s.R.u, s.R.v]];
        return F.map(([u, v]) => P3(s, u, v));
      })),
    };
  }
  return { sections, length, vol, mesh, miss: sections.filter((s) => !s.ok).length };
}

/* =========================================================================
   Canale a U — inalveazione in calcestruzzo (0.4).
   Scelte dell'utente (2026-10-04, disegni «inalveazione PR 3 PE idraulica
   400X250»):
   - sezione tipo: interno B × H, pareti tw, soletta di fondo ts; magrone tm
     largo come l'esterno più om per lato. La linea del profilo è lo
     SCORRIMENTO (fondo interno); a scelta il cielo (cima dei muri) o il piano
     di posa (fondo del magrone);
   - scavo: fondo largo come il magrone più se per lato, scarpe cut fino al DTM;
   - rinterro in materiale da rilevato fino in cima ai muri, poi banchina berm
     e scarpa fill fino al DTM, in salita o in discesa («reinterri a pendenza
     3/2, la stessa dello scavo»);
   - SALTI (due quote alla stessa progressiva; un lato più ripido del 100 % si
     rende verticale): sotto la fine della soletta alta un muro di testa hw
     che scende key sotto la soletta bassa (dente), col magrone sotto; dalla
     faccia del muro verso il lato alto un cuneo in misto cementato fra il
     magrone e la scarpa wedge che sale dal piede del dente. Muro e dente
     fanno parte del tratto alto, il cuneo è un oggetto a sé. Magrone nel
     longitudinale: uno strato tm sotto il fondo dell'opera, senza i raccordi
     del dettaglio (l'utente: complicazione inutile).
   Sezioni verticali come il fosso: area × lunghezza in pianta = volume vero
   di un solido sweepato in verticale.
   ========================================================================= */

export const CHANNEL = Object.freeze({ B: 4, H: 2.5, tw: 0.3, ts: 0.3, tm: 0.1, om: 0.1, se: 0.5, cut: 1.5, berm: 0.5, fill: 1.5, hw: 0.4, key: 0.5, wedge: 1.5, ref: "invert" });
/** Salti: un lato più ripido di steep (100 %) e lungo al massimo len diventa verticale. */
export const DROP = Object.freeze({ steep: 1, len: 1, eps: 0.001 });

/**
 * Profilo coi salti ripidi resi verticali: il lato (a, b) più ripido di steep
 * e più corto di len diventa un salto a metà, le livellette accanto si
 * allungano fin lì (inalveazione: 0,84 m in 12 cm a 0+267,8, dentro lo
 * spessore del muro di testa). Ritorna { ...prof, pts, squared: quanti }.
 */
export function squareDrops(prof, { steep = DROP.steep, len = DROP.len } = {}) {
  const P = prof.pts.map((p) => ({ ...p }));
  const slope = (i) => {
    if (i < 0 || i + 1 >= P.length) return NaN;
    const ds = P[i + 1].s - P[i].s;
    return ds > 1e-6 ? (P[i + 1].z - P[i].z) / ds : NaN;
  };
  let n = 0;
  for (let i = 0; i + 1 < P.length; i++) {
    const a = P[i], b = P[i + 1], ds = b.s - a.s;
    if (!(ds > 1e-6) || ds > len || Math.abs(b.z - a.z) / ds <= steep) continue;
    const m = (a.s + b.s) / 2, gb = slope(i - 1), ga = slope(i + 1);
    a.z += (Number.isFinite(gb) ? gb : 0) * (m - a.s); a.s = m;
    b.z -= (Number.isFinite(ga) ? ga : 0) * (b.s - m); b.s = m;
    n++;
  }
  return { ...prof, pts: P, squared: n };
}

/** Salti della linea: punti consecutivi alla stessa progressiva con quote diverse → [{ q, zB (prima), zA (dopo) }]. */
export function profileDrops(prof, eps = DROP.eps) {
  const P = prof.pts, out = [];
  for (let i = 0; i < P.length;) {
    let j = i;
    while (j + 1 < P.length && Math.abs(P[j + 1].s - P[i].s) <= 1e-6) j++;
    if (j > i && Math.abs(P[j].z - P[i].z) > eps) out.push({ q: P[i].s, zB: P[i].z, zA: P[j].z });
    i = j + 1;
  }
  return out;
}

/**
 * Sezione del canale in coordinate (u orizzontale dall'asse, a destra +; v
 * verticale dal fondo interno). uo faccia esterna dei muri, um bordo del
 * magrone, ue spigolo del fondo scavo, ub fine della banchina; vs fondo della
 * soletta, vm fondo del magrone. lift = fondo interno − linea del profilo.
 * std = la zona corrente (fuori dai salti).
 */
export function channelShape(c = CHANNEL) {
  const hb = c.B / 2, uo = hb + c.tw, um = uo + c.om, ue = um + c.se, ub = uo + c.berm;
  const vs = -c.ts, vm = -c.ts - c.tm, H = c.H;
  const inner = [[-hb, H], [-hb, 0], [hb, 0], [hb, H]], outer = [[-uo, H], [-uo, vs], [uo, vs], [uo, H]];
  const ring = [...inner, ...outer.slice().reverse()];
  const lift = c.ref === "top" ? -H : c.ref === "base" ? c.ts + c.tm : 0;
  const areaLean = 2 * um * c.tm;
  return { c: { ...c }, hb, uo, um, ue, ub, H, vs, vm, inner, outer, ring, lift,
    areaU: Math.abs(shoelace(ring)), areaLean, gross: 2 * uo * (H - vs), waterArea: c.B * H, top: 2 * uo,
    std: { kind: "std", vE: vm, ledge: vs, aBelow: areaLean, wall: 0, mix: 0 } };
}

/** ∫ max(0, g) sui campioni us (crescenti), g lineare fra due campioni; NaN salta l'intervallo. */
function posArea(us, g) {
  let A = 0, g0 = NaN, u0 = NaN;
  for (const u of us) {
    const gu = g(u);
    if (Number.isFinite(gu) && Number.isFinite(g0) && u > u0) {
      const w = u - u0;
      if (g0 >= 0 && gu >= 0) A += (g0 + gu) / 2 * w;
      else if (g0 > 0 || gu > 0) { const r = g0 / (g0 - gu) * w; A += g0 > 0 ? g0 * r / 2 : gu * (w - r) / 2; }
    }
    g0 = gu; u0 = u;
  }
  return A;
}

/**
 * Sezione del canale a una stazione. T(u) = terreno − fondo interno (NaN
 * fuori dal DTM). zone = sh.std o una zona di salto: { vE fondo dello scavo,
 * ledge piano del magrone fra il muro e il bordo, aBelow area dell'opera
 * sotto la soletta (magrone, dente, cuneo) }.
 * - scavo E: fondo vE largo 2·ue, scarpe 1/cut fino al terreno (solo in salita);
 * - superficie finita F: cima dei muri e banchina a H fino a ub, poi scarpa
 *   1/fill su o giù fino al terreno; oltre, il terreno;
 * - scavo = ∫ (T − E)⁺; rinterro = ∫ (F − min(T, E))⁺ − area lorda
 *   dell'opera (U piena, magrone, dente o cuneo): l'opera sta tutta fra il
 *   fondo dello scavo e la cima dei muri.
 * Senza terreno sotto l'opera (fuori dal DTM) la sezione è «asciutta»: niente
 * scavo né rinterro. Ritorna { L, R (piede della scarpa finita), EL, ER
 * (ciglio dello scavo), cut, fill, band, ok, dry, F, E, Lo (funzioni di u) }.
 */
export function channelCross(sh, T, zone = null, { du = 0.1, reach = 50 } = {}) {
  const z = zone || sh.std, c = sh.c, { ub, ue, H } = sh, vE = z.vE;
  const dry = [-ue, 0, ue].some((u) => !Number.isFinite(T(u)));
  const L = meet(T, -1, ub, H, c.fill, c.fill, du, reach), R = meet(T, 1, ub, H, c.fill, c.fill, du, reach);
  const EL = meet(T, -1, ue, vE, c.cut, 0, du, reach), ER = meet(T, 1, ue, vE, c.cut, 0, du, reach);
  const E = (u) => { const a = Math.abs(u), e = u < 0 ? EL : ER; return a <= ue ? vE : a >= Math.abs(e.u) ? T(u) : vE + (a - ue) / c.cut; };
  const F = (u) => { const a = Math.abs(u), f = u < 0 ? L : R, w = Math.abs(f.u); return a <= ub ? H : a >= w ? T(u) : H + (f.v - H) * (a - ub) / Math.max(1e-12, w - ub); };
  const Lo = (u) => Math.min(T(u), E(u));
  const out = { L, R, EL, ER, cut: 0, fill: 0, band: 0, ok: !dry && L.ok && R.ok && EL.ok && ER.ok, dry, F, E, Lo, zone: z };
  if (dry) return out;
  const u0 = Math.min(L.u, EL.u), u1 = Math.max(R.u, ER.u);
  const us = [u0, u1, L.u, R.u, EL.u, ER.u];
  for (const k of [sh.uo, sh.um, ub, ue]) us.push(-k, k);
  for (let u = Math.ceil(u0 / du) * du; u < u1; u += du) us.push(u);
  const xs = [...new Set(us.filter((u) => u >= u0 && u <= u1))].sort((a, b) => a - b);
  out.cut = posArea(xs, (u) => T(u) - E(u));
  out.band = posArea(xs, (u) => F(u) - Lo(u));
  out.fill = Math.max(0, out.band - sh.gross - z.aBelow);
  return out;
}

/**
 * Anelli a topologia fissa di una sezione del canale, per le mesh: ognuno è
 * [[u, basso, alto]…] con u crescente (il poligono è basso → , alto ←).
 * - cut: scarpata, fondo, scarpata dello scavo; basso = scavo, alto = terreno;
 * - right/left: rinterro di un lato, dal muro (sopra il magrone, o sopra il
 *   dente) fino al più lontano fra il piede della scarpa finita e il ciglio
 *   dello scavo; lo scalino del bordo del magrone ha due campioni alla stessa u;
 * - bottom: rinterro sotto l'opera, dove il terreno sta sotto lo scavo.
 * Dove il terreno incrocia lo scavo, e sugli spigoli delle scarpate, va il
 * campione libero più vicino: la mesh ritrova l'area della sezione.
 */
export function channelRings(sh, cr, T, { nS = 10 } = {}) {
  const { uo, um, ue, ub } = sh, zn = cr.zone;
  const us = [], fixed = [];
  const seg = (a, b, n) => { for (let j = 0; j < n; j++) { us.push(a + (b - a) * j / n); fixed.push(j === 0); } };
  seg(cr.EL.u, -ue, nS); seg(-ue, ue, 6); seg(ue, cr.ER.u, nS); us.push(cr.ER.u); fixed.push(true);
  snapCross(us, fixed, (u) => T(u) - cr.E(u));
  const cut = us.map((u) => {
    const e = cr.E(u), t = T(u), l = Number.isFinite(e) ? e : zn.vE;
    return [u, l, cr.dry || !Number.isFinite(t) ? l : Math.max(l, t)];
  });
  const side = (sgn) => {
    const F = sgn > 0 ? cr.R : cr.L, E = sgn > 0 ? cr.ER : cr.EL;
    const fx = [[uo, "w"], [um, "l"], [um, "s"], [ub, ""], [ue, ""]].sort((a, b) => a[0] - b[0]);
    const out = Math.max(Math.abs(F.u), Math.abs(E.u), fx[fx.length - 1][0]);
    const vs = [], kind = [], fix = [];
    fx.forEach(([u, k], j) => {
      vs.push(u); kind.push(k); fix.push(true);
      const next = j + 1 < fx.length ? fx[j + 1][0] : out, n = k === "w" || k === "l" ? 0 : j + 1 < fx.length ? 3 : nS;
      for (let q = 1; q < n; q++) { vs.push(u + (next - u) * q / n); kind.push(""); fix.push(false); }
    });
    vs.push(out); kind.push(""); fix.push(true);
    snapCross(vs, fix, (u) => T(sgn * u) - cr.E(sgn * u));
    for (const x of [Math.abs(F.u), Math.abs(E.u)]) snapAt(vs, fix, x);
    const r = vs.map((u, j) => {
      const U = sgn * u, ledge = kind[j] === "l" || u < um - 1e-9;
      let l = ledge ? zn.ledge : cr.Lo(U), h = cr.F(U);
      if (!Number.isFinite(l)) l = zn.vE;
      if (cr.dry || !Number.isFinite(h)) h = l;
      return [U, l, Math.max(l, h)];
    });
    return sgn > 0 ? r : r.reverse();
  };
  const bu = [], bf = [];
  for (let j = 0; j <= 6; j++) { bu.push(-um + 2 * um * j / 6); bf.push(j === 0 || j === 6); }
  snapCross(bu, bf, (u) => T(u) - zn.vE);
  const bottom = bu.map((u) => { const t = T(u), v = zn.vE; return [u, cr.dry || !Number.isFinite(t) ? v : Math.min(t, v), v]; });
  return { cut, right: side(1), left: side(-1), bottom };
}

/** Area del poligono di un anello [[u, basso, alto]…]. */
export const ringArea = (r) => Math.abs(shoelace([...r.map(([u, l]) => [u, l]), ...r.slice().reverse().map(([u, , h]) => [u, h])]));

/** Più mesh in una (punti in coda, indici spostati); le vuote si saltano. */
export function mergeMeshes(list) {
  const ms = list.filter((m) => m && m.index.length);
  let nP = 0, nI = 0;
  for (const m of ms) { nP += m.positions.length; nI += m.index.length; }
  const positions = new Float64Array(nP), index = new Uint32Array(nI);
  let p = 0, k = 0;
  for (const m of ms) {
    positions.set(m.positions, p);
    for (let i = 0; i < m.index.length; i++) index[k + i] = m.index[i] + p / 3;
    p += m.positions.length; k += m.index.length;
  }
  return { positions, index };
}

/** Tratti consecutivi di elementi che soddisfano pred. */
function runsOf(arr, pred) {
  const out = [];
  let cur = null;
  for (const x of arr) { if (pred(x)) { if (!cur) out.push(cur = []); cur.push(x); } else cur = null; }
  return out;
}

/**
 * Il canale lungo l'asse. Tratti fra i salti (e le divisioni dell'utente);
 * per ogni tratto le stazioni (vertici, passo, facce dei muri, inizio dei
 * cunei) con la loro zona — sulla faccia del muro due sezioni alla stessa
 * progressiva, una per lato —, le sezioni, i volumi per sezioni ragguagliate
 * e le mesh nelle coordinate locali (x − O.x, y − O.y, z). zAt3(x, y) = DTM.
 * Ritorna { parts: [{ k, p0, p1, length, vol, mesh, miss, n, drops }], drops, miss, length, vol };
 *   vol e mesh: lining (U + muri di testa), lean (magrone), mix (cunei in misto cementato), cut (scavo), fill (rinterro).
 */
export function channelSweep(axis, prof, anchors, sh, zAt3, { O = { x: 0, y: 0 }, step = 1, cuts = [], du = 0.1, reach = 50, nS = 10 } = {}) {
  const KEYS = ["lining", "lean", "mix", "cut", "fill"];
  const res = { parts: [], drops: [], miss: 0, length: 0, vol: { lining: 0, lean: 0, mix: 0, cut: 0, fill: 0 } };
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return res;
  const c = sh.c, map = anchorMap(anchors), lift = sh.lift, { uo, um, vs, vm } = sh;
  const lo = ax3.pts[0].p, hi = ax3.pts[ax3.pts.length - 1].p;
  for (const d of profileDrops(prof)) {
    const p = map.toP(d.q);
    if (p <= lo + 1e-6 || p >= hi - 1e-6) continue;
    const zHi = Math.max(d.zB, d.zA) + lift, zLo = Math.min(d.zB, d.zA) + lift;
    res.drops.push({ p, q: d.q, dir: d.zA < d.zB ? 1 : -1, dz: zHi - zLo, zHi, zLo, zD: zLo - c.ts - c.key });
  }
  const B = [lo, hi, ...res.drops.map((d) => d.p)];
  for (const x of cuts) if (x > lo + 0.5 && x < hi - 0.5 && !res.drops.some((d) => Math.abs(d.p - x) < 0.5)) B.push(x);
  B.sort((a, b) => a - b);
  const bounds = B.filter((x, i) => !i || x - B[i - 1] > 1e-6);
  const P3 = (s, u, v) => [s.x + s.nx * u * s.k - O.x, s.y + s.ny * u * s.k - O.y, s.z + v];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const p0 = bounds[i], p1 = bounds[i + 1];
    const zIn = (p) => zAt(prof, map.toQ(p), p >= p1 - 1e-9 ? -1 : 1) + lift;   // sui capi che cadono su un salto, la quota di questo tratto
    // muri di testa: salto alla fine col lato alto prima (sgn +1) o all'inizio col lato alto dopo (sgn −1)
    const walls = [];
    if (c.hw > 0) for (const d of res.drops) {
      const sgn = Math.abs(d.p - p1) < 1e-6 && d.dir > 0 ? 1 : Math.abs(d.p - p0) < 1e-6 && d.dir < 0 ? -1 : 0;
      if (!sgn) continue;
      const face = sgn > 0 ? Math.max(p0, p1 - c.hw) : Math.min(p1, p0 + c.hw);
      const w = { d, sgn, a: sgn > 0 ? face : p0, b: sgn > 0 ? p1 : face, face, zPit: d.zD - c.tm, wa: null, wb: null };
      // cuneo: dalla faccia del muro verso il lato alto, finché la scarpa dal piede del dente incontra il fondo dello scavo
      if (c.wedge > 0) {
        const far = sgn > 0 ? p0 : p1, f = (p) => zIn(p) + vm - (w.zPit + Math.abs(p - face) / c.wedge);
        let s = far;
        if (f(far) < 0) { let a = face, b = far; for (let it = 0; it < 50; it++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; } s = (a + b) / 2; }
        if (Math.abs(s - face) > 1e-4) { w.wa = Math.min(s, face); w.wb = Math.max(s, face); }
      }
      walls.push(w);
    }
    const extra = [];
    for (const w of walls) { extra.push(w.face); if (w.wa != null) extra.push(w.wa, w.wb); }
    const raw = sweepStations(axis, prof, anchors, { step, extra, p0, p1 });
    const st = raw.filter((s, k) => !(Math.abs(s.p - p0) < 1e-9 && k + 1 < raw.length && Math.abs(raw[k + 1].p - p0) < 1e-9)
      && !(Math.abs(s.p - p1) < 1e-9 && k > 0 && Math.abs(raw[k - 1].p - p1) < 1e-9));
    if (st.length < 2) continue;
    // zona di ogni stazione: sulla faccia del muro due sezioni (cuneo e muro) alla stessa progressiva
    const zonesAt = (s, zf) => {
      for (const w of walls) {
        const inWall = s.p >= w.a - 1e-9 && s.p <= w.b + 1e-9, inWedge = w.wa != null && s.p >= w.wa - 1e-9 && s.p <= w.wb + 1e-9;
        if (!inWall && !inWedge) continue;
        const vD = w.d.zD - zf, wallZ = { kind: "wall", vD, vE: vD - c.tm, ledge: vD, wall: 2 * uo * (vs - vD), mix: 0 };
        wallZ.aBelow = wallZ.wall + sh.areaLean;
        const vE = Math.min(vm, w.zPit + Math.abs(s.p - w.face) / c.wedge - zf);
        const wedgeZ = { kind: "wedge", vE, ledge: vs, wall: 0, mix: 2 * um * (vm - vE), aBelow: 2 * um * (vs - vE) };
        if (inWall && inWedge) return w.sgn > 0 ? [wedgeZ, wallZ] : [wallZ, wedgeZ];
        return [inWall ? wallZ : wedgeZ];
      }
      return [sh.std];
    };
    const secs = [];
    for (const s of st) {
      const zf = s.z + lift;
      const T = (u) => zAt3(s.x + s.nx * u * s.k, s.y + s.ny * u * s.k) - zf;
      for (const zone of zonesAt(s, zf)) {
        const cr = channelCross(sh, T, zone, { du, reach });
        secs.push({ p: s.p, x: s.x, y: s.y, z: zf, nx: s.nx, ny: s.ny, k: s.k, zone, cr, T,
          a: { lining: sh.areaU + zone.wall, lean: sh.areaLean, mix: zone.mix, cut: cr.cut, fill: cr.fill } });
      }
    }
    const vol = { lining: 0, lean: 0, mix: 0, cut: 0, fill: 0 };
    let length = 0;
    for (let j = 1; j < secs.length; j++) {
      const a = secs[j - 1], b = secs[j], dp = b.p - a.p;
      length += dp;
      for (const key of KEYS) vol[key] += (a.a[key] + b.a[key]) / 2 * dp;
    }
    // --- mesh. La U è un solido vero: il verso si decide dal volume; gli anelli
    //     [basso…, alto al contrario] girano al contrario della U → verso opposto
    const uniq = secs.filter((s, j) => !j || s.p - secs[j - 1].p > 1e-9);
    const U = loftBand(uniq.map((s) => sh.ring.map(([u, v]) => P3(s, u, v))));
    const fl = !U.flipped;
    const band = (list, ringOf) => {
      if (list.length < 2) return null;
      const zero = [], rings = list.map((s) => {
        const r = ringOf(s);
        zero.push(r.map(([, l, h]) => h - l < 1e-9));
        return [...r.map(([u, l]) => P3(s, u, l)), ...r.slice().reverse().map(([u, , h]) => P3(s, u, h))];
      });
      return compactMesh(loftBand(rings, fl, zero));
    };
    const box = (list, w, lo, hi) => band(list, (s) => [[-w, lo(s), hi(s)], [w, lo(s), hi(s)]]);
    const wallRuns = runsOf(secs, (s) => s.zone.kind === "wall");
    const rg = new Map(secs.map((s) => [s, channelRings(sh, s.cr, s.T, { nS })]));
    const mesh = {
      lining: mergeMeshes([U, ...wallRuns.map((r) => box(r, uo, (s) => s.zone.vD, () => vs))]),
      lean: mergeMeshes([...runsOf(secs, (s) => s.zone.kind !== "wall").map((r) => box(r, um, () => vm, () => vs)),
        ...wallRuns.map((r) => box(r, um, (s) => s.zone.vD - c.tm, (s) => s.zone.vD))]),
      mix: mergeMeshes(runsOf(secs, (s) => s.zone.kind === "wedge").map((r) => box(r, um, (s) => s.zone.vE, () => vm))),
      cut: mergeMeshes([band(uniq, (s) => rg.get(s).cut)]),
      fill: mergeMeshes([band(secs, (s) => rg.get(s).right), band(secs, (s) => rg.get(s).left), band(secs, (s) => rg.get(s).bottom)]),
    };
    const miss = uniq.filter((s) => !s.cr.ok).length;
    res.parts.push({ k: res.parts.length + 1, p0, p1, length, vol, mesh, miss, n: uniq.length,
      drops: walls.map((w) => ({ p: w.d.p, dz: w.d.dz, face: w.face, wedge: w.wa != null ? w.wb - w.wa : 0 })),
      sections: secs.map((s) => ({ p: s.p, z: s.z, kind: s.zone.kind, zone: s.zone, a: s.a, ok: s.cr.ok, dry: s.cr.dry })) });
    res.miss += miss; res.length += length;
    for (const key of KEYS) res.vol[key] += vol[key];
  }
  return res;
}

/* =========================================================================
   DTM da punti (0.6): Delaunay (Delaunator iniettato, quello del Terrain
   Sculptor) a coordinate centrate, poi si «sbuccia» il bordo: Delaunay copre
   l'inviluppo convesso, e dove il rilievo rientra (strisce, corridoi, buchi
   aperti verso l'esterno) lo riempirebbe di triangoli lunghi su un terreno
   inventato. Dal contorno verso l'interno si tolgono i triangoli il cui lato
   esposto supera maxEdge; quelli interni, anche grandi, restano (lì i punti
   ci sono tutto attorno). maxEdge di default = 8 × la mediana dei lati
   (griglia di 1 m → ~10 m). Triangoli in senso antiorario visti dall'alto.
   ========================================================================= */
export function tinFromPoints(points, Delaunator, { maxEdge = null, k = 8 } = {}) {
  const n = points.length / 3;
  if (n < 3) throw new Error("servono almeno 3 punti");
  let cx = 0, cy = 0;
  for (let i = 0; i < n; i++) { cx += points[3 * i]; cy += points[3 * i + 1]; }
  cx /= n; cy /= n;
  const xy = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) { xy[2 * i] = points[3 * i] - cx; xy[2 * i + 1] = points[3 * i + 1] - cy; }
  const d = new Delaunator(xy), T = d.triangles, H = d.halfedges, nt = T.length / 3;
  if (!nt) throw new Error("i punti sono allineati: niente superficie");
  const len = (e) => { const a = T[e], b = T[e % 3 === 2 ? e - 2 : e + 1]; return Math.hypot(xy[2 * a] - xy[2 * b], xy[2 * a + 1] - xy[2 * b + 1]); };
  let median = 0;
  if (maxEdge == null) {
    const step = Math.max(1, Math.floor(T.length / 200000)), s = [];
    for (let e = 0; e < T.length; e += step) s.push(len(e));
    s.sort((a, b) => a - b);
    median = s[s.length >> 1];
    maxEdge = k * median;
  }
  const gone = new Uint8Array(nt), queue = [];
  for (let e = 0; e < T.length; e++) if (H[e] < 0) queue.push(e);
  let dropped = 0;
  while (queue.length) {
    const e = queue.pop(), t = (e / 3) | 0;
    if (gone[t] || len(e) <= maxEdge) continue;
    gone[t] = 1; dropped++;
    for (let j = 0; j < 3; j++) { const o = H[3 * t + j]; if (o >= 0 && !gone[(o / 3) | 0]) queue.push(o); }
  }
  // antiorario visto dall'alto (asse y verso nord)
  const F = new Uint32Array(3 * (nt - dropped));
  let m = 0;
  for (let t = 0; t < nt; t++) {
    if (gone[t]) continue;
    const a = T[3 * t], b = T[3 * t + 1], c = T[3 * t + 2];
    const area = (xy[2 * b] - xy[2 * a]) * (xy[2 * c + 1] - xy[2 * a + 1]) - (xy[2 * b + 1] - xy[2 * a + 1]) * (xy[2 * c] - xy[2 * a]);
    if (area >= 0) { F[m++] = a; F[m++] = b; F[m++] = c; } else { F[m++] = a; F[m++] = c; F[m++] = b; }
  }
  if (!m) throw new Error("nessun triangolo dopo la pulizia del bordo");
  return { points, faces: F, dropped, maxEdge, median };
}

/* =========================================================================
   Tubo in trincea (0.7) — scelte dell'utente (2026-10-04 e 2026-10-05):
   - tubo da catalogo (materiale + DN → De e spessore) o a mano; la linea del
     profilo è lo SCORRIMENTO, a scelta l'asse, la generatrice inferiore
     esterna o il fondo dello scavo;
   - trincea a strati, valori di default della UNI EN 1610: letto di posa
     10 cm + DN/10, rinfianco fino all'estradosso, ricoprimento 30 cm sopra
     l'estradosso, reinterro fino al terreno, ripristino (strato superficiale)
     facoltativo; larghezza minima dalla norma (De + 0,40…1,00 m secondo il
     DN e le pareti, e un minimo per la profondità), costante per tratto;
   - pareti: fino a 1,50 m di profondità verticali, oltre a scarpa (D.Lgs.
     81/08: oltre 1,50 m armatura o scarpa); soglia, scarpa e modo per tratto
     modificabili. Le pareti verticali oltre la soglia (forzate) si contano
     come superficie da blindare.
   Sezioni verticali come il fosso e il canale (su pendenze di pochi punti
   per cento la sezione del tubo perpendicolare all'asse cambia di nulla).
   Il tubo nelle mesh è un poligono di 48 lati con il raggio ritoccato per
   avere la stessa area del cerchio: i volumi delle mesh tornano coi conti.
   ========================================================================= */

/** Catalogo: [DN, De, spessore] in mm. Valori nominali o tipici: da controllare col tubo scelto. */
export const PIPE_CATALOG = Object.freeze({
  pvc: { norm: "UNI EN 1401 SN8 (SDR 34)", dn: "OD", rows: [[110, 110, 3.2], [125, 125, 3.7], [160, 160, 4.7], [200, 200, 5.9], [250, 250, 7.3], [315, 315, 9.2], [400, 400, 11.7], [500, 500, 14.6], [630, 630, 18.4]] },
  pe: { norm: "UNI EN 13476-3 SN8", dn: "OD", rows: [[160, 160, 10.5], [200, 200, 14], [250, 250, 17], [315, 315, 22], [400, 400, 28.5], [500, 500, 36.5], [630, 630, 47.5], [800, 800, 61], [1000, 1000, 74], [1200, 1200, 85]] },
  cls: { norm: "UNI EN 1916", dn: "ID", rows: [[300, 400, 50], [400, 520, 60], [500, 640, 70], [600, 760, 80], [800, 1000, 100], [1000, 1240, 120], [1200, 1480, 140], [1500, 1840, 170], [1800, 2200, 200], [2000, 2440, 220]] },
  ghisa: { norm: "UNI EN 598", dn: "ID", rows: [[100, 118, 6], [150, 170, 6], [200, 222, 6.3], [250, 274, 6.8], [300, 326, 7.2], [350, 378, 7.7], [400, 429, 8.1], [450, 480, 8.6], [500, 532, 9], [600, 635, 9.9], [700, 738, 10.8], [800, 842, 11.7], [900, 945, 12.6], [1000, 1048, 13.5], [1200, 1255, 15.3], [1400, 1462, 17.1], [1600, 1668, 18.9], [1800, 1875, 20.7], [2000, 2082, 22.5]] },
});
/** Il tubo di un materiale e DN dal catalogo → { dn, De, s } in metri (null se non c'è). */
export function pipeFromCatalog(mat, dn) {
  const c = PIPE_CATALOG[mat], r = c && c.rows.find((x) => x[0] === dn);
  return r ? { dn: r[0], De: r[1] / 1000, s: r[2] / 1000 } : null;
}

/**
 * Tubo e trincea: PVC DN 315 di default; bed null = 10 cm + DN/10, width null = UNI EN 1610.
 * emb: rilevato di protezione dove il terreno sta sotto estradosso + ricoprimento (0.7.1),
 * banchina berm e scarpa bank (orizz./vert.); covMin: avviso sul ricoprimento dal terreno.
 */
export const PIPE = Object.freeze({ mat: "pvc", dn: 315, De: 0.315, s: 0.0092, ref: "invert", bed: null, cover: 0.3, restore: 0, width: null, walls: "auto", deep: 1.5, slope: 1,
  emb: true, berm: 0.5, bank: 1.5, covMin: 1 });
export const PIPE_N = 48;

/**
 * Larghezza minima della trincea (UNI EN 1610, prospetti 1 e 2): De + 0,40…1,00
 * secondo il DN se le pareti sono ripide (verticali o β > 60°), De + 0,40 se a
 * scarpa più dolce; e almeno 0,80 / 0,90 / 1,00 m oltre 1,00 / 1,75 / 4,00 m di
 * profondità.
 */
export function en1610Width(dn, De, depth, steep = true) {
  const a = !steep || dn <= 225 ? 0.4 : dn <= 350 ? 0.5 : dn <= 700 ? 0.7 : dn <= 1200 ? 0.85 : 1;
  const b = !(depth >= 1) ? 0 : depth <= 1.75 ? 0.8 : depth <= 4 ? 0.9 : 1;
  return Math.max(De + a, b);
}

/**
 * Sezione del tubo (u orizzontale dall'asse, v verticale dallo SCORRIMENTO):
 * vc asse, vb generatrice inferiore esterna, vt estradosso, vF fondo dello
 * scavo (sotto il letto). lift = scorrimento − linea del profilo.
 * Poligoni a 48 lati con raggio di ugual area: outer, inner ([u, v]).
 */
export function pipeShape(p = PIPE) {
  const De = p.De, s = Math.min(p.s, De / 2 - 1e-4), Di = De - 2 * s, R = De / 2, r = Di / 2;
  const bed = p.bed != null ? p.bed : 0.1 + p.dn / 10000;
  const vc = r, vb = -s, vt = r + R, vF = vb - bed;
  const lift = p.ref === "axis" ? -r : p.ref === "bottom" ? s : p.ref === "trench" ? s + bed : 0;
  const N = PIPE_N, kA = Math.sqrt(2 * Math.PI / (N * Math.sin(2 * Math.PI / N)));
  const circ = (rad) => Array.from({ length: N }, (_, j) => { const t = Math.PI + 2 * Math.PI * j / N; return [rad * kA * Math.cos(t), vc + rad * kA * Math.sin(t)]; });
  return { p: { ...p }, De, s, Di, R, r, Re: R * kA, bed, vc, vb, vt, vF, lift, cover: p.cover, restore: Math.max(0, p.restore || 0),
    emb: p.emb !== false, berm: Math.max(0, p.berm != null ? p.berm : PIPE.berm), bank: Math.max(0.01, p.bank || PIPE.bank),
    outer: circ(R), inner: circ(r), areaPipe: Math.PI * (R * R - r * r), areaDisk: Math.PI * R * R };
}

/**
 * Sezione della trincea a una stazione. T(u) = terreno − scorrimento (NaN
 * fuori dal DTM); W larghezza al fondo, m scarpa delle pareti (0 = verticali).
 * Pareti dal fondo fino al terreno (a scarpa: dove la scarpa lo incontra).
 * Strati, ognuno fra due quote e dentro la trincea sotto il terreno:
 *   bed [vF, vb] · surround [vb, vt] meno il tubo · cover [vt, vt + cover] ·
 *   fill [vt + cover, T − restore] · restore [T − restore, T];
 * cut = tutta la trincea sotto il terreno (= strati + tubo).
 * shore = altezza delle pareti verticali (le due), cov = terreno − estradosso
 * sull'asse. Senza terreno sotto la trincea la sezione è «asciutta».
 *
 * Rilevato di protezione (sh.emb, 0.7.1): dove il terreno sta sotto
 * estradosso + ricoprimento (vTop) la superficie finita S = max(T, Fe), con Fe
 * piana a vTop fino a ub (le pareti prolungate a vTop, uW, più la banchina) e
 * poi in scarpa 1/bank giù fino al terreno. Gli strati stanno fra il fondo e
 * le pareti della trincea (prolungate sopra il terreno) e S; emb = il resto
 * fra T e S, fuori dalla trincea (banchina, scarpe, e sotto il fondo se il
 * terreno sta più giù). covF = S − estradosso sull'asse. Senza rilevato S = T.
 * Ritorna anche S, Fe, SL/SR (le pareti incontrano S), toeL/toeR (piedi del
 * rilevato), uW, ub, vTop.
 */
export function pipeCross(sh, T, W, m, { du = 0.1, reach = 50 } = {}) {
  const hw = W / 2, vF = sh.vF, vTop = sh.vt + sh.cover;
  const dry = [-hw, 0, hw].some((u) => !Number.isFinite(T(u)));
  const uW = hw + m * (vTop - vF), ub = uW + sh.berm;
  const Fe = sh.emb ? (u) => { const a = Math.abs(u); return a <= ub ? vTop : vTop - (a - ub) / sh.bank; } : () => -Infinity;
  const S = (u) => { const t = T(u); return Number.isFinite(t) ? Math.max(t, Fe(u)) : NaN; };
  const edge = (G, sgn) => (m > 0 ? meet(G, sgn, hw, vF, m, 0, du, reach) : { u: sgn * hw, v: G(sgn * hw), kind: "cut", ok: Number.isFinite(G(sgn * hw)) });
  const EL = edge(T, -1), ER = edge(T, 1), SL = edge(S, -1), SR = edge(S, 1);
  const toe = (sgn) => {
    const t = T(sgn * ub);
    if (!sh.emb) return { u: sgn * hw, v: T(sgn * hw), ok: true };
    if (!(t < vTop)) return { u: sgn * ub, v: vTop, ok: Number.isFinite(t) };
    return meet(T, sgn, ub, vTop, sh.bank, sh.bank, du, reach);
  };
  const toeL = toe(-1), toeR = toe(1);
  const E = (u) => { const a = Math.abs(u); return a <= hw ? vF : vF + (a - hw) / m; };
  const out = { EL, ER, SL, SR, toeL, toeR, E, S, Fe, W, m, uW, ub, vTop, dry, ok: !dry && EL.ok && ER.ok && SL.ok && SR.ok && toeL.ok && toeR.ok,
    a: { bed: 0, surround: 0, cover: 0, fill: 0, restore: 0, cut: 0, emb: 0 }, shore: 0, cov: NaN, covF: NaN };
  if (dry) return out;
  out.cov = T(0) - sh.vt; out.covF = S(0) - sh.vt;
  if (!m) out.shore = Math.max(0, T(-hw) - vF) + Math.max(0, T(hw) - vF);
  const u0 = Math.min(EL.u, SL.u, toeL.u), u1 = Math.max(ER.u, SR.u, toeR.u), n = Math.max(80, Math.ceil((u1 - u0) / Math.min(du, 0.01)));
  const xs = [u0, u1, -hw, hw, -sh.R, sh.R, 0, EL.u, ER.u, SL.u, SR.u, toeL.u, toeR.u];
  if (sh.emb) xs.push(-uW, uW, -ub, ub);
  if (m > 0) {                                                 // dove le pareti tagliano i livelli (e il fondo del ripristino)
    for (const L of [sh.vb, sh.vt, vTop]) { const x = hw + m * (L - vF); xs.push(-x, x); }
    if (sh.restore > 0) xs.push(Math.min(-hw, SL.u + m * sh.restore), Math.max(hw, SR.u - m * sh.restore));
  }
  for (let i = 1; i < n; i++) xs.push(u0 + (u1 - u0) * i / n);
  for (let i = 1; i < 96; i++) xs.push(sh.R * Math.cos(Math.PI * i / 96));      // fitti sul bordo del tubo (in coseno)
  const us = [...new Set(xs.filter((u) => u >= u0 && u <= u1))].sort((a, b) => a - b);
  const { vb, vt, vc, R, cover, restore } = sh;
  const len = (e, u, s, a, b, hole) => {
    const lo = Math.max(a, e), hi = Math.min(b, s);
    if (!(hi > lo)) return 0;
    let L = hi - lo;
    if (hole && Math.abs(u) < R) { const h = Math.sqrt(R * R - u * u); L -= Math.max(0, Math.min(hi, vc + h) - Math.max(lo, vc - h)); }
    return Math.max(0, L);
  };
  // out: a pareti verticali il fondo E salta su ±hw (vF dentro, ∞ fuori) → due campioni lì, dentro e fuori
  const f = (u, outside = false) => {
    const t = T(u);
    if (!Number.isFinite(t)) return null;
    const s = Math.max(t, Fe(u)), e = outside ? Infinity : E(u), top = s - restore;
    return { bed: len(e, u, s, vF, vb), surround: len(e, u, s, vb, vt, true), cover: len(e, u, s, vt, vt + cover), fill: len(e, u, s, vt + cover, top),
      restore: restore > 0 ? len(e, u, s, Math.max(top, vt + cover), s) : 0, cut: Math.max(0, t - e), emb: Math.max(0, Math.min(s, e) - t) };
  };
  const smp = [];
  for (const u of us) {
    if (!m && Math.abs(Math.abs(u) - hw) < 1e-12) { if (u < 0) smp.push([u, true], [u, false]); else smp.push([u, false], [u, true]); }
    else smp.push([u, false]);
  }
  let prev = null, up = NaN;
  for (const [u, o] of smp) {
    const g = f(u, o);
    if (g && prev && u > up) for (const k in out.a) out.a[k] += (prev[k] + g[k]) / 2 * (u - up);
    prev = g; up = u;
  }
  return out;
}

/**
 * Anelli a topologia fissa di una sezione della trincea ([[u, basso, alto]…],
 * u crescente): campioni sulle due pareti (nS), sul fondo fuori dal tubo e
 * sotto il tubo nelle u dei vertici del suo poligono — il rinfianco abbraccia
 * il tubo vertice per vertice. Il rinfianco è in due: sotto e sopra l'asse.
 * Gli strati arrivano fin dove le pareti incontrano la superficie finita S
 * (SL, SR); lo scavo ha campioni suoi fino al ciglio (EL, ER); il rilevato
 * (emb) va da piede a piede, con due campioni su ±hw (dentro e fuori dalla
 * trincea: a pareti verticali il fondo E salta lì).
 */
export function pipeRings(sh, cr, T, { nS = 8, nB = 3, nE = 6 } = {}) {
  const hw = cr.W / 2, Re = sh.Re, us = [], fx = [];
  const { vF, vb, vt, vc, cover, restore } = sh, vTop = vt + cover;
  const seg = (a, b, n) => { for (let j = 0; j < n; j++) { us.push(a + (b - a) * j / n); fx.push(j === 0); } };
  const tAt = (u) => { const v = T(u); return cr.dry || !Number.isFinite(v) ? vF : v; };
  const sAt = (u) => { const v = cr.S(u); return cr.dry || !Number.isFinite(v) ? vF : v; };
  // sulle pareti a scarpa un campione dove tagliano i livelli degli strati (fondo del rinfianco,
  // estradosso, cima del ricoprimento), poi nS fino a S; verticali: tutti su ±hw
  const side = (sgn, e) => {
    const E = Math.abs(e), x = [hw, ...[vb, vt, vTop].map((L) => Math.min(E, hw + cr.m * (L - vF)))];
    x.push(Math.min(E, Math.max(x[3], E - cr.m * restore)), E);                // fondo del ripristino sulla parete
    return x.map((v) => sgn * v);
  };
  const L = side(-1, cr.SL.u).reverse(), R = side(1, cr.SR.u);
  seg(L[0], L[1], 2); seg(L[1], L[2], nS); seg(L[2], L[3], 1); seg(L[3], L[4], 1); seg(L[4], L[5], 1); seg(-hw, -Re, nB);
  const circ = new Set();                                 // i campioni dentro il tubo servono solo al rinfianco
  for (let j = 0; j < PIPE_N / 2; j++) { if (j) circ.add(us.length); us.push(Re * Math.cos(Math.PI + 2 * Math.PI * j / PIPE_N)); fx.push(true); }
  seg(Re, hw, nB); seg(R[0], R[1], 1); seg(R[1], R[2], 1); seg(R[2], R[3], 1); seg(R[3], R[4], nS); seg(R[4], R[5], 2); us.push(R[5]); fx.push(true);
  // la cima del reinterro piega dove il terreno passa la cima del rilevato: lì un campione libero
  if (sh.emb && !cr.dry) snapCross(us, fx, (u) => T(u) - vTop);
  const t = us.map(sAt);
  const e = us.map((u) => cr.E(u));
  const h = us.map((u) => (Math.abs(u) < Re ? Math.sqrt(Math.max(0, Re * Re - u * u)) : 0));
  const all = us.map((_, j) => j), base = all.filter((j) => !circ.has(j));
  const band = (lo, hi, idx = base) => idx.map((j) => { const l = Math.min(Math.max(lo(j), e[j]), t[j]), x = Math.max(l, Math.min(hi(j), t[j])); return [us[j], l, x]; });
  // scavo: dal ciglio sinistro al destro, fra il fondo (o le pareti) e il terreno dove sta sopra
  const cu = [], cf = [];
  const cseg = (a, b, n) => { for (let j = 0; j < n; j++) { cu.push(a + (b - a) * j / n); cf.push(j === 0); } };
  cseg(cr.EL.u, -hw, nS); cseg(-hw, hw, 6); cseg(hw, cr.ER.u, nS); cu.push(cr.ER.u); cf.push(true);
  if (!cr.dry) snapCross(cu, cf, (u) => T(u) - cr.E(u));
  const cut = cu.map((u) => { const x = tAt(u), y = cr.E(u); return [u, Math.min(x, y), x]; });
  // rilevato: da piede a piede, fra il terreno e il più basso fra S e il fondo/le pareti della trincea
  const eu = [], ef = [], eo = [];
  const eseg = (a, b, n, o = false) => { for (let j = 0; j < n; j++) { eu.push(a + (b - a) * j / n); ef.push(j === 0); eo.push(o); } };
  // fuori dalla trincea, per lato: ciglio, pareti su S, cima delle pareti, fine della banchina, piede (in ordine)
  const outPts = (sgn) => (sgn < 0 ? [cr.EL.u, cr.SL.u, cr.uW, cr.ub, cr.toeL.u] : [cr.ER.u, cr.SR.u, cr.uW, cr.ub, cr.toeR.u])
    .map((x) => Math.max(hw, Math.abs(x))).sort((a, b) => a - b);
  const oL = outPts(-1), oR = outPts(1), lastL = oL[4], lastR = oR[4];
  eseg(-lastL, -oL[3], nE, true);
  for (let k = 3; k > 0; k--) eseg(-oL[k], -oL[k - 1], 2, true);
  eseg(-oL[0], -hw, 1, true);                                                     // fuori dalla trincea fino alla parete
  eseg(-hw, hw, 6); eu.push(hw); ef.push(true); eo.push(false);                   // sotto la trincea (dentro)
  eseg(hw, oR[0], 1, true); for (let k = 0; k < 3; k++) eseg(oR[k], oR[k + 1], 2, true);
  eseg(oR[3], lastR, nE, true); eu.push(lastR); ef.push(true); eo.push(true);
  const C = (u, o) => Math.min(sAt(u), o && !cr.m ? Infinity : cr.E(u));
  if (sh.emb && !cr.dry) snapCross(eu, ef, (u) => C(u, Math.abs(u) > hw) - T(u));   // dove il rilevato si assottiglia a zero, un campione libero
  const emb = eu.map((u, j) => { const x = tAt(u); return [u, x, Math.max(x, C(u, eo[j]))]; });
  return {
    cut,
    bed: band(() => vF, () => vb),
    surroundLow: band(() => vb, (j) => vc - h[j], all),
    surroundUp: band((j) => vc + h[j], () => vt, all),
    cover: band(() => vt, () => vTop),
    fill: band(() => vTop, (j) => t[j] - restore),
    restore: restore > 0 ? band((j) => Math.max(t[j] - restore, vTop), (j) => t[j]) : null,
    emb,
  };
}

/** Tubo cavo fra anelli (esterno, interno: N punti ciascuno): pareti e corone ai capi; verso dal volume. */
function loftTube(outer, inner) {
  const n = outer.length, N = outer[0].length, P = new Float64Array(n * 2 * N * 3), I = [];
  const o = (i, j) => i * 2 * N + (j % N), q = (i, j) => i * 2 * N + N + (j % N);
  for (let i = 0; i < n; i++) for (let j = 0; j < N; j++) { P.set(outer[i][j], 3 * o(i, j)); P.set(inner[i][j], 3 * q(i, j)); }
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j < N; j++) {
    I.push(o(i, j), o(i + 1, j), o(i + 1, j + 1), o(i, j), o(i + 1, j + 1), o(i, j + 1));
    I.push(q(i, j), q(i, j + 1), q(i + 1, j + 1), q(i, j), q(i + 1, j + 1), q(i + 1, j));
  }
  for (let j = 0; j < N; j++) {
    I.push(o(0, j), o(0, j + 1), q(0, j + 1), o(0, j), q(0, j + 1), q(0, j));
    I.push(o(n - 1, j), q(n - 1, j + 1), o(n - 1, j + 1), o(n - 1, j), q(n - 1, j), q(n - 1, j + 1));
  }
  const mesh = { positions: P, index: Uint32Array.from(I) };
  if (meshVolume(mesh) < 0) for (let k = 0; k < mesh.index.length; k += 3) { const x = mesh.index[k + 1]; mesh.index[k + 1] = mesh.index[k + 2]; mesh.index[k + 2] = x; }
  return mesh;
}

/**
 * Il tubo lungo l'asse. Tratti fra i salti della linea (pozzetti di salto) e
 * le divisioni dell'utente; per ogni tratto pareti (auto: verticali fino a
 * deep, a scarpa oltre; «v» o «s» per tratto in partWalls) e larghezza (UNI
 * EN 1610 sul tratto, o quella data), sezioni, volumi per sezioni ragguagliate,
 * superficie da blindare e mesh nelle coordinate locali (x − O.x, y − O.y, z).
 * Ritorna { parts: [{ k, p0, p1, length, vol, shore, width, walls, minCov, minCovF, low, bank, mesh, miss, n, sections }], drops, miss, length, vol, shore }.
 *   vol e mesh: pipe (tubo), bed (letto), surround (rinfianco), cover (ricoprimento), fill (reinterro), restore (ripristino), cut (scavo), emb (rilevato).
 *   minCov / minCovF: ricoprimento minimo dal terreno / dalla superficie finita { v, p }; low: tratti col
 *   ricoprimento dal terreno sotto p.covMin, bank: tratti in rilevato — [{ p0, p1, v }] (v: il minimo, l'altezza massima).
 */
export function pipeSweep(axis, prof, anchors, sh, zAt3, { O = { x: 0, y: 0 }, step = 1, cuts = [], partWalls = {}, du = 0.1, reach = 50 } = {}) {
  const KEYS = ["pipe", "bed", "surround", "cover", "fill", "restore", "cut", "emb"];
  const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
  const res = { parts: [], drops: [], miss: 0, length: 0, vol: zero(), shore: 0 };
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return res;
  const p = sh.p, map = anchorMap(anchors), lift = sh.lift;
  const lo = ax3.pts[0].p, hi = ax3.pts[ax3.pts.length - 1].p;
  for (const d of profileDrops(prof)) {
    const x = map.toP(d.q);
    if (x > lo + 1e-6 && x < hi - 1e-6) res.drops.push({ p: x, q: d.q, dz: Math.abs(d.zA - d.zB) });
  }
  const B = [lo, hi, ...res.drops.map((d) => d.p)];
  for (const x of cuts) if (x > lo + 0.5 && x < hi - 0.5 && !res.drops.some((d) => Math.abs(d.p - x) < 0.5)) B.push(x);
  B.sort((a, b) => a - b);
  const bounds = B.filter((x, i) => !i || x - B[i - 1] > 1e-6);
  const P3 = (s, u, v) => [s.x + s.nx * u * s.k - O.x, s.y + s.ny * u * s.k - O.y, s.z + v];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const p0 = bounds[i], p1 = bounds[i + 1], k = res.parts.length + 1;
    const mode = partWalls[k] || p.walls, mS = Math.max(0.01, p.slope);
    const stationsOf = (extra) => {
      const raw = sweepStations(axis, prof, anchors, { step, p0, p1, extra });
      const st = raw.filter((s, j) => !(Math.abs(s.p - p0) < 1e-9 && j + 1 < raw.length && Math.abs(raw[j + 1].p - p0) < 1e-9)
        && !(Math.abs(s.p - p1) < 1e-9 && j > 0 && Math.abs(raw[j - 1].p - p1) < 1e-9));
      // sui capi che cadono su un salto, la quota di questo tratto
      for (const s of st) { const z = zAt(prof, map.toQ(s.p), s.p >= p1 - 1e-9 ? -1 : 1); if (Number.isFinite(z)) s.z = z; }
      return st.map((s) => {
        const zf = s.z + lift;
        const T = (u) => zAt3(s.x + s.nx * u * s.k, s.y + s.ny * u * s.k) - zf;
        const depth = T(0) - sh.vF;
        const vert = mode === "v" || (mode !== "s" && !(depth > p.deep));
        return { p: s.p, x: s.x, y: s.y, z: zf, nx: s.nx, ny: s.ny, k: s.k, T, depth, m: vert ? 0 : mS };
      });
    };
    let secs = stationsOf([]);
    if (secs.length < 2) continue;
    // dove la profondità passa la soglia (pareti «auto») due sezioni alla stessa progressiva, una per
    // tipo di parete: la trincea fa lo scalino lì, e mesh e computo restano d'accordo
    const sw = [];
    for (let j = 1; j < secs.length; j++) {
      const a = secs[j - 1], b = secs[j];
      if (a.m !== b.m && Number.isFinite(a.depth) && Number.isFinite(b.depth) && Math.abs(b.depth - a.depth) > 1e-12) {
        const x = a.p + (p.deep - a.depth) / (b.depth - a.depth) * (b.p - a.p);
        if (x > a.p + 1e-6 && x < b.p - 1e-6) sw.push(x);
      }
    }
    if (sw.length) {
      secs = stationsOf(sw);
      const out = [];
      for (const s of secs) {
        if (sw.some((x) => Math.abs(x - s.p) < 1e-9)) {
          const prev = out[out.length - 1], mB = prev ? prev.m : s.m, mA = mB ? 0 : mS;
          out.push({ ...s, m: mB }, { ...s, m: mA });
        } else out.push(s);
      }
      secs = out;
    }
    let W = p.width;
    if (!(W > 0)) {
      W = 0;
      for (const s of secs) W = Math.max(W, en1610Width(p.dn, sh.De, Number.isFinite(s.depth) ? s.depth : 0, s.m < 0.577));
      W = Math.ceil(W * 20 - 1e-9) / 20;                  // ai 5 cm
    }
    W = Math.max(W, sh.De + 0.1);
    for (const s of secs) s.cr = pipeCross(sh, s.T, W, s.m, { du, reach });
    const vol = zero();
    let length = 0, shore = 0;
    for (let j = 1; j < secs.length; j++) {
      const a = secs[j - 1], b = secs[j], dp = b.p - a.p;
      length += dp;
      for (const key of KEYS) if (key !== "pipe") vol[key] += (a.cr.a[key] + b.cr.a[key]) / 2 * dp;
      const sa = a.depth > p.deep ? a.cr.shore : 0, sb = b.depth > p.deep ? b.cr.shore : 0;
      shore += (sa + sb) / 2 * dp;
    }
    vol.pipe = sh.areaPipe * length;
    // --- mesh: il tubo, poi gli strati (anelli basso →, alto ←: tutti lo stesso verso, deciso sullo scavo)
    const uniq = secs.filter((s, j) => !j || s.p - secs[j - 1].p > 1e-9);           // il tubo non ha scalini
    const pipe = loftTube(uniq.map((s) => sh.outer.map(([u, v]) => P3(s, u, v))), uniq.map((s) => sh.inner.map(([u, v]) => P3(s, u, v))));
    const rg = secs.map((s) => pipeRings(sh, s.cr, s.T));
    const ringsOf = (key) => {
      const zeros = [];
      const rings = secs.map((s, j) => {
        const r = rg[j][key];
        zeros.push(r.map(([, l, x]) => x - l < 1e-9));
        return [...r.map(([u, l]) => P3(s, u, l)), ...r.slice().reverse().map(([u, , x]) => P3(s, u, x))];
      });
      return { rings, zeros };
    };
    // il verso da una scatola sulle stesse stazioni: lo scavo può mancare del tutto (tubo in rilevato) e un volume ~0 non orienta
    const fl = uniq.length > 1 ? loftBand(uniq.map((s) => [P3(s, -1, 0), P3(s, 1, 0), P3(s, 1, 1), P3(s, -1, 1)])).flipped : false;
    const band = (key) => { if (!rg[0][key]) return null; const r = ringsOf(key); return compactMesh(loftBand(r.rings, fl, r.zeros)); };
    const mesh = { pipe, cut: band("cut"), bed: band("bed"), surround: mergeMeshes([band("surroundLow"), band("surroundUp")]), cover: band("cover"), fill: band("fill"), restore: band("restore"), emb: band("emb") };
    for (const key of KEYS) if (!mesh[key]) mesh[key] = { positions: new Float64Array(0), index: new Uint32Array(0) };
    const vertLen = secs.reduce((a, s, j) => a + (j && !s.m && !secs[j - 1].m ? s.p - secs[j - 1].p : 0), 0);
    let minCov = null, minCovF = null;
    for (const s of secs) {
      if (Number.isFinite(s.cr.cov) && (!minCov || s.cr.cov < minCov.v)) minCov = { v: s.cr.cov, p: s.p };
      if (Number.isFinite(s.cr.covF) && (!minCovF || s.cr.covF < minCovF.v)) minCovF = { v: s.cr.covF, p: s.p };
    }
    // tratti dove g > 0, coi capi interpolati fra due sezioni; v = la peggiore (min o max di val)
    const spans = (g, val, worst) => {
      const out = [];
      let cur = null;
      for (let j = 0; j < secs.length; j++) {
        const s = secs[j], x = g(s);
        if (!Number.isFinite(x)) { cur = null; continue; }
        const prev = j ? secs[j - 1] : null, xp = prev ? g(prev) : NaN;
        if (x > 0) {
          if (!cur) out.push(cur = { p0: Number.isFinite(xp) && xp <= 0 && x - xp > 0 ? prev.p + (0 - xp) / (x - xp) * (s.p - prev.p) : s.p, p1: s.p, v: val(s) });
          cur.p1 = s.p; cur.v = worst(cur.v, val(s));
        } else if (cur) { if (Number.isFinite(xp) && xp > 0 && xp - x > 0) cur.p1 = prev.p + xp / (xp - x) * (s.p - prev.p); cur = null; }
      }
      return out;
    };
    const low = Number.isFinite(p.covMin) && p.covMin > 0 ? spans((s) => p.covMin - s.cr.cov, (s) => s.cr.cov, Math.min) : [];
    const bank = spans((s) => s.cr.a.emb - 1e-3, (s) => Math.max(0, s.cr.covF - s.cr.cov), Math.max);
    const miss = secs.filter((s) => !s.cr.ok).length;
    res.parts.push({ k, p0, p1, length, vol, shore, width: W, mode, walls: { vertical: vertLen, slope: Math.max(0, length - vertLen) }, minCov, minCovF, low, bank, mesh, miss, n: secs.length,
      sections: secs.map((s) => ({ p: s.p, z: s.z, depth: s.depth, m: s.m, a: { ...s.cr.a, pipe: sh.areaPipe }, shore: s.cr.shore, cov: s.cr.cov, covF: s.cr.covF, ok: s.cr.ok, dry: s.cr.dry })) });
    res.miss += miss; res.length += length; res.shore += shore;
    for (const key of KEYS) res.vol[key] += vol[key];
  }
  return res;
}
