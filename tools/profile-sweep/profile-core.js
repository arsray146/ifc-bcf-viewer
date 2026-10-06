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
  for (let i = n - 1; i >= 0; i--) {
    const q = { x: p[i].x, y: p[i].y, b: i > 0 ? -(p[i - 1].b || 0) : 0 };
    if (p[i].R > 0) q.R = p[i].R;                         // il raccordo resta sul suo vertice (0.12)
    out.push(q);
  }
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
   Linea di progetto modificata nel tool (0.11)
   Scelte dell'utente (2026-10-05): la linea modificata diventa dell'opera (il
   disegno resta com'è e «Torna al disegno» la ripristina); si modifica nella
   lastra del profilo trascinando i vertici e in una tabella (progressiva,
   quota, pendenza). Vertici [{ s, z }] in progressiva del PROFILO (q) e quota
   vera: gli ancoraggi restano validi e la taratura del disegno non la tocca
   più. s non decresce; più vertici alla stessa s sono un salto (canale,
   pozzetto) e in progressiva si spostano insieme.
   ------------------------------------------------------------------------- */

const SAME_S = 1e-6;
/* copia di un vertice del profilo: s, z e, se c'è, R del raccordo verticale (0.12) */
const cpV = (p) => (p.R > 0 ? { s: p.s, z: p.z, R: p.R } : { s: p.s, z: p.z });

/** Vertici modificabili di una linea di profilo (profileLine): tutti i punti, anche quelli degli archi spezzati. */
export const editPoints = (prof) => prof.pts.map((p) => ({ s: p.s, z: p.z }));

/** Linea di profilo (la forma di profileLine) dai vertici modificati; i doppi esatti si tolgono. */
export function profileFromPoints(pts) {
  if (!Array.isArray(pts)) throw new Error("profileFromPoints: vertici mancanti");
  const out = [];
  for (const p of pts) {
    if (!Number.isFinite(p.s) || !Number.isFinite(p.z)) throw new Error("profileFromPoints: vertice senza numeri");
    const last = out[out.length - 1];
    if (last && p.s < last.s - SAME_S) throw new Error("profileFromPoints: progressive che tornano indietro");
    const same = last && Math.abs(p.s - last.s) <= SAME_S;
    if (same && Math.abs(p.z - last.z) <= SAME_S) continue;
    out.push({ s: same ? last.s : p.s, z: p.z, v: p.v !== false });     // v: false = punto di un raccordo (0.12)
  }
  if (out.length < 2 || out[out.length - 1].s - out[0].s < SAME_S) throw new Error("profileFromPoints: servono due progressive diverse");
  let zMin = Infinity, zMax = -Infinity;
  for (const p of out) { if (p.z < zMin) zMin = p.z; if (p.z > zMax) zMax = p.z; }
  return { pts: out, pieces: 1, gaps: [], dropped: 0, s0: out[0].s, s1: out[out.length - 1].s, zMin, zMax, edited: true };
}

/** I vertici del salto di i (stessa s): [primo, ultimo] (i da solo se non sta su un salto). */
export function dropGroup(pts, i) {
  let a = i, b = i;
  while (a > 0 && Math.abs(pts[a - 1].s - pts[i].s) <= SAME_S) a--;
  while (b < pts.length - 1 && Math.abs(pts[b + 1].s - pts[i].s) <= SAME_S) b++;
  return [a, b];
}

/**
 * Sposta il vertice i: la quota solo lui, la progressiva tutto il suo salto,
 * fra i vertici vicini (almeno gap da ciascuno; gap 0 = può finire sulla
 * progressiva di un vicino e fare un salto). Ritorna { pts (copia), i, clamped }.
 */
export function editMove(pts, i, { s, z } = {}, { gap = 0.01 } = {}) {
  const out = pts.map(cpV);
  let clamped = false;
  if (Number.isFinite(s)) {
    const [a, b] = dropGroup(pts, i);
    const lo = a > 0 ? pts[a - 1].s + gap : -Infinity, hi = b < pts.length - 1 ? pts[b + 1].s - gap : Infinity;
    let v = s;
    if (lo > hi) v = pts[i].s;
    else if (v < lo) v = lo;
    else if (v > hi) v = hi;
    clamped = Math.abs(v - s) > 1e-9;
    for (let k = a; k <= b; k++) out[k].s = v;
  }
  if (Number.isFinite(z)) out[i].z = z;
  return { pts: out, i, clamped };
}

/**
 * Un vertice in più alla progressiva s. Dentro la linea sta sul lato che la
 * contiene (la geometria non cambia); prima o dopo i capi la allunga con la
 * pendenza del primo o dell'ultimo lato (in piano se quello è un salto). Sopra
 * un vertice che c'è già: null. Ritorna { pts (copia), i } (i = il nuovo).
 */
export function editInsert(pts, s) {
  const n = pts.length;
  if (!Number.isFinite(s) || n < 2 || pts.some((p) => Math.abs(p.s - s) <= SAME_S)) return null;
  const out = pts.map(cpV);
  const grade = (a, b) => (b.s - a.s > SAME_S ? (b.z - a.z) / (b.s - a.s) : 0);
  if (s < pts[0].s) { out.unshift({ s, z: pts[0].z + grade(pts[0], pts[1]) * (s - pts[0].s) }); return { pts: out, i: 0 }; }
  if (s > pts[n - 1].s) { out.push({ s, z: pts[n - 1].z + grade(pts[n - 2], pts[n - 1]) * (s - pts[n - 1].s) }); return { pts: out, i: n }; }
  let k = 1;
  while (pts[k].s < s) k++;
  const a = pts[k - 1], b = pts[k];
  out.splice(k, 0, { s, z: a.z + (b.z - a.z) * (s - a.s) / (b.s - a.s) });
  return { pts: out, i: k };
}

/** Toglie il vertice i (ne restano almeno due con progressive diverse): { pts (copia), i (il vertice scelto dopo) } o null. */
export function editRemove(pts, i) {
  if (pts.length <= 2 || i < 0 || i >= pts.length) return null;
  const out = pts.filter((_, k) => k !== i).map(cpV);
  if (out[out.length - 1].s - out[0].s < SAME_S) return null;
  return { pts: out, i: Math.min(i, out.length - 1) };
}

/**
 * Pendenze dei lati (dz / dp, p = progressiva in pianta con toP: lungo l'asse vero;
 * senza, in progressiva del profilo). Su un salto { drop: dz } invece del numero.
 */
export function editSlopes(pts, toP = (s) => s) {
  const out = [];
  for (let k = 0; k + 1 < pts.length; k++) {
    const dp = toP(pts[k + 1].s) - toP(pts[k].s), dz = pts[k + 1].z - pts[k].z;
    out.push(Math.abs(pts[k + 1].s - pts[k].s) <= SAME_S || !(Math.abs(dp) > SAME_S) ? { drop: dz } : dz / dp);
  }
  return out;
}

/** Pendenza g del lato k (dal vertice k al k + 1): si sposta la quota del k + 1, il k resta. Su un salto: null. */
export function editSetSlope(pts, k, g, toP = (s) => s) {
  if (k < 0 || k + 1 >= pts.length || !Number.isFinite(g)) return null;
  const dp = toP(pts[k + 1].s) - toP(pts[k].s);
  if (Math.abs(pts[k + 1].s - pts[k].s) <= SAME_S || !(Math.abs(dp) > SAME_S)) return null;
  return editMove(pts, k + 1, { z: pts[k].z + g * dp });
}

/** Valore tondo al passo dato (senza i decimali sporchi della virgola mobile). */
export const roundTo = (x, step) => (step > 0 ? Number((Math.round(x / step) * step).toFixed(Math.max(0, Math.ceil(-Math.log10(step)) + 2))) : x);

/* -------------------------------------------------------------------------
   Pianta modificata nel tool (0.11, seconda tappa)
   Scelte dell'utente (2026-10-06): vista 3D dall'alto + tabella; il profilo
   SEGUE i vertici (gli ancoraggi, le divisioni in tratti e le righe da/a
   stanno attaccati alla pianta: lato + frazione della sua lunghezza); gli
   archi restano (spostando i vertici l'arco tiene il suo angolo) e il raggio
   si scrive in tabella; asse da zero, DXF 2D, aggancio.
   Vertici [{ x, y, b }] nel verso dell'ASSE (b = bulge del lato che parte
   dal vertice, come nelle polilinee); la pagina li gira se la pianta è
   percorsa al contrario (reversePoly).
   ------------------------------------------------------------------------- */

/** Vertici dell'asse (planAxis) come polilinea nel suo verso: [{ x, y, b }], b dagli archi. */
/* copia di un vertice della pianta: x, y, b e, se c'è, R del raccordo al vertice (0.12) */
const cpP = (p) => (p.R > 0 ? { x: p.x, y: p.y, b: p.b || 0, R: p.R } : { x: p.x, y: p.y, b: p.b || 0 });
export function axisVertices(axis) {
  return axis.vtx.map((v, i) => {
    const g = axis.segs[i];
    return { x: v.x, y: v.y, b: g && g.t === "A" ? Math.tan(g.sweep / 4) : 0 };
  });
}

/** Sposta il vertice i (il lato che ne parte e quello che arriva tengono il loro bulge: gli archi il loro angolo). */
export function planMove(pts, i, { x, y }) {
  const out = pts.map(cpP);
  if (Number.isFinite(x)) out[i].x = x;
  if (Number.isFinite(y)) out[i].y = y;
  return out;
}

/**
 * Un vertice nuovo sul lato k (dal vertice k al k + 1) alla frazione t della
 * sua lunghezza: sulla retta, o sull'arco (che si divide in due archi dello
 * stesso cerchio). La geometria non cambia. Ritorna { pts, i } (i = il nuovo) o null.
 */
export function planInsert(pts, k, t) {
  if (k < 0 || k + 1 >= pts.length || !(t > 1e-9 && t < 1 - 1e-9)) return null;
  const out = pts.map(cpP);
  const a = out[k], c = out[k + 1], arc = bulgeArc(a.x, a.y, c.x, c.y, a.b);
  let q;
  if (!arc) q = { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, b: 0 };
  else {
    const ang = arc.a0 + arc.sweep * t;
    q = { x: arc.cx + arc.r * Math.cos(ang), y: arc.cy + arc.r * Math.sin(ang), b: Math.tan(arc.sweep * (1 - t) / 4) };
    a.b = Math.tan(arc.sweep * t / 4);
  }
  out.splice(k + 1, 0, q);
  return { pts: out, i: k + 1 };
}

/** Toglie il vertice i (ne restano almeno due): i due lati diventano una retta. Ritorna { pts, i } o null. */
export function planRemove(pts, i) {
  if (pts.length <= 2 || i < 0 || i >= pts.length) return null;
  const out = pts.filter((_, k) => k !== i).map(cpP);
  if (i > 0 && i < pts.length - 1) out[i - 1].b = 0;
  out[out.length - 1].b = 0;
  if (Math.hypot(out[1].x - out[0].x, out[1].y - out[0].y) < 1e-3 && out.length === 2) return null;
  return { pts: out, i: Math.min(i, out.length - 1) };
}

/** Raggio con segno del lato k (+ a sinistra, antiorario; − a destra); 0 = retta. */
export function planSideRadius(pts, k) {
  const a = pts[k], c = pts[k + 1];
  if (!a || !c) return 0;
  const arc = bulgeArc(a.x, a.y, c.x, c.y, a.b || 0);
  return arc ? arc.r * Math.sign(arc.sweep) : 0;
}

/**
 * Raggio del lato k (con segno: + a sinistra, − a destra; 0 = retta): l'arco
 * minore fra i due vertici. Troppo piccolo per la corda (|R| < corda / 2): null.
 */
export function planSetRadius(pts, k, R) {
  const a = pts[k], c = pts[k + 1];
  if (!a || !c || !Number.isFinite(R)) return null;
  const chord = Math.hypot(c.x - a.x, c.y - a.y);
  const out = pts.map(cpP);
  if (Math.abs(R) < 1e-9) { out[k].b = 0; return out; }
  if (Math.abs(R) < chord / 2 - 1e-9) return null;
  const th = 2 * Math.asin(Math.min(1, chord / (2 * Math.abs(R))));
  out[k].b = Math.sign(R) * Math.tan(th / 4);
  return out;
}

/** Deviazione al vertice i (radianti, + a sinistra): fra la tangente del lato che arriva e quella del lato che parte. 0 ai capi. */
export function vertexDeflection(axis, i) {
  if (i <= 0 || i >= axis.vtx.length - 1) return 0;
  const tan = (g, end) => {
    if (g.t === "L") return [g.ux, g.uy];
    const dir = Math.sign(g.sweep), t = g.a0 + (end ? g.sweep : 0);
    return [-Math.sin(t) * dir, Math.cos(t) * dir];
  };
  const [ax, ay] = tan(axis.segs[i - 1], true), [bx, by] = tan(axis.segs[i], false);
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
}

/* Posizione «attaccata alla pianta»: u = k + t (lato k, frazione t della sua lunghezza). Spostando un
   vertice u non cambia; inserendo o togliendo un vertice cambia come la pianta (uAfterInsert/Remove). */
export function axisU(axis, p) {
  const n = axis.segs.length;
  if (!(p > 0)) return 0;
  if (p >= axis.length) return n;
  const k = segIndex(axis, p), g = axis.segs[k];
  return k + (g.len > 0 ? Math.min(1, (p - g.s0) / g.len) : 0);
}
export function axisPAtU(axis, u) {
  const n = axis.segs.length;
  if (!(u > 0)) return 0;
  if (u >= n) return axis.length;
  const k = Math.min(n - 1, Math.floor(u)), g = axis.segs[k];
  return g.s0 + (u - k) * g.len;
}
/** u dopo un vertice nuovo sul lato k alla frazione t0. */
export function uAfterInsert(u, k, t0) {
  if (u < k) return u;
  if (u >= k + 1) return u + 1;
  const t = u - k;
  return t < t0 ? k + t / t0 : k + 1 + (t - t0) / (1 - t0);
}
/** u dopo aver tolto il vertice i (lens = lunghezze dei lati PRIMA): i due lati attorno diventano uno, in proporzione. */
export function uAfterRemove(u, i, lens) {
  const n = lens.length;
  if (i === 0) return u < 1 ? 0 : u - 1;
  if (i === n) return u > n - 1 ? n - 1 : u;
  const a = i - 1;
  if (u < a) return u;
  if (u >= i + 1) return u - 1;
  const along = u < i ? (u - a) * lens[a] : lens[a] + (u - i) * lens[i], tot = lens[a] + lens[i];
  return a + (tot > 0 ? along / tot : 0);
}
/** Progressiva p sulla pianta di prima → sulla pianta nuova, con la trasformazione di u (fu). Prima dell'inizio
    e dopo la fine conta lo scarto dai capi (ancoraggi fuori dalla pianta). */
export function remapP(oldAxis, newAxis, p, fu = (u) => u) {
  if (p < 0) return p;
  if (p > oldAxis.length) return newAxis.length + (p - oldAxis.length);
  return axisPAtU(newAxis, fu(axisU(oldAxis, p)));
}

/** Punto dell'asse più vicino a (x, y) fra le progressive s0 e s1 (tutto l'asse se mancano): { s, d, x, y }. */
export function nearestS(axis, x, y, s0 = -Infinity, s1 = Infinity) {
  let best = null;
  for (const g of axis.segs) {
    if (g.s0 + g.len < s0 || g.s0 > s1) continue;
    let s;
    if (g.t === "L") s = g.s0 + Math.max(0, Math.min(g.len, (x - g.x0) * g.ux + (y - g.y0) * g.uy));
    else {
      const dir = Math.sign(g.sweep);
      let da = (Math.atan2(y - g.cy, x - g.cx) - g.a0) * dir;          // angolo percorso dall'inizio dell'arco
      da = ((da % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const sw = Math.abs(g.sweep);
      if (da > sw) da = da - sw < 2 * Math.PI - da ? sw : 0;              // fuori dall'arco: il capo più vicino
      s = g.s0 + da * g.r;
    }
    s = Math.max(s0, Math.min(s1, s));
    const q = planAt(axis, s), d = Math.hypot(q.x - x, q.y - y);
    if (!best || d < best.d - 1e-9) best = { s, d, x: q.x, y: q.y };
  }
  return best;
}
/* -------------------------------------------------------------------------
   Raccordi (0.12). Scelte dell'utente (2026-10-06): in pianta un arco
   TANGENTE ai due lati su un vertice, legato al vertice (spostandolo il
   raccordo si rifà), e un lato ad arco per tre punti (maniglia a metà del
   lato); in profilo un raccordo PARABOLICO su un vertice. I vertici di
   controllo (PI) portano R; la geometria si ricava ogni volta (planExpand,
   profileExpand). Le posizioni che seguono la pianta stanno fra due
   «stazioni» dei vertici di controllo (il vertice, o il centro del raccordo):
   senza raccordi sono i vertici e il conto è quello di remapP.
   ------------------------------------------------------------------------- */

/**
 * Pianta dai vertici di controllo [{ x, y, b, R? }] (verso dell'asse): ogni vertice
 * interno con R > 0 diventa due punti di tangenza e un arco tangente ai due lati.
 * Fra due lati DRITTI: T = R·tan(|Δ|/2), lati corti: le due tangenti di un lato non
 * lo superano (resta almeno 1 cm dritto) e R si riduce in proporzione. Accanto a un
 * lato ad ARCO (0.13, scelta dell'utente: «R racc. anche accanto a un arco»): il
 * centro sta a R da tutti e due i lati dalla parte della curva (retta parallela o
 * cerchio concentrico) e il lato ad arco si accorcia al punto di tangenza; se non ci
 * sta, R si riduce (bisezione). Allineato (già tangente), a tornante o ai capi:
 * niente raccordo (skipped).
 * Ritorna { pts (polilinea), idx: [[a, b]] per vertice di controllo (b > a = raccordo), R (efficaci), clamped, skipped }.
 */
export function planExpand(ctrl) {
  const n = ctrl.length, skipped = [], clamped = [];
  // i lati: retta { t: "L", ax, ay, ux, uy, len } o arco { t: "A", cx, cy, r, a0, sw, s, len }
  const sides = [];
  for (let k = 0; k + 1 < n; k++) {
    const a = ctrl[k], c = ctrl[k + 1], arc = bulgeArc(a.x, a.y, c.x, c.y, a.b || 0);
    if (arc) sides.push({ t: "A", cx: arc.cx, cy: arc.cy, r: arc.r, a0: arc.a0, sw: arc.sweep, s: Math.sign(arc.sweep), len: arc.len });
    else { const dx = c.x - a.x, dy = c.y - a.y, L = Math.hypot(dx, dy); sides.push({ t: "L", ax: a.x, ay: a.y, ux: L ? dx / L : 1, uy: L ? dy / L : 0, len: L }); }
  }
  const tanEnd = (e) => (e.t === "L" ? [e.ux, e.uy] : [-Math.sin(e.a0 + e.sw) * e.s, Math.cos(e.a0 + e.sw) * e.s]);
  const tanStart = (e) => (e.t === "L" ? [e.ux, e.uy] : [-Math.sin(e.a0) * e.s, Math.cos(e.a0) * e.s]);
  const cutS = new Array(Math.max(0, n - 1)).fill(0), cutE = new Array(Math.max(0, n - 1)).fill(0);   // lunghezze tolte ai capi dei lati
  const fil = new Array(n).fill(null), T = new Array(n).fill(0), Dv = new Array(n).fill(0), general = [];
  for (let i = 1; i < n - 1; i++) {
    if (!(ctrl[i].R > 0)) continue;
    const e1 = sides[i - 1], e2 = sides[i];
    if (!(e1.len > 1e-6) || !(e2.len > 1e-6)) { skipped.push(i); continue; }
    const [ax, ay] = tanEnd(e1), [bx, by] = tanStart(e2), d = Math.atan2(ax * by - ay * bx, ax * bx + ay * by);
    if (Math.abs(d) < 1e-6 || Math.abs(d) > Math.PI - 1e-3) { skipped.push(i); continue; }
    Dv[i] = d;
    if (e1.t === "L" && e2.t === "L") T[i] = ctrl[i].R * Math.tan(Math.abs(d) / 2);
    else general.push(i);
  }
  // 1. fra due rette: la formula chiusa, ridotta in proporzione sui lati corti
  const f = new Array(n).fill(1);
  for (let k = 0; k + 1 < n; k++) {
    const need = T[k] + T[k + 1], avail = sides[k].len - 0.01;
    if (need > avail && need > 0) { const g = Math.max(0, avail) / need; f[k] = Math.min(f[k], g); f[k + 1] = Math.min(f[k + 1], g); }
  }
  for (let i = 1; i < n - 1; i++) {
    if (!(T[i] > 0)) continue;
    const t = T[i] * f[i], e1 = sides[i - 1], e2 = sides[i], p = ctrl[i];
    if (f[i] < 1 - 1e-9) clamped.push(i);
    if (!(t > 1e-6)) continue;
    fil[i] = { T1: { x: p.x - e1.ux * t, y: p.y - e1.uy * t }, T2: { x: p.x + e2.ux * t, y: p.y + e2.uy * t }, b: Math.tan(Dv[i] / 4), R: t / Math.tan(Math.abs(Dv[i]) / 2) };
    cutE[i - 1] = t; cutS[i] = t;
  }
  // 2. accanto a un arco: da sinistra a destra, ognuno nello spazio che resta sui suoi due lati
  for (const i of general) {
    const e1 = sides[i - 1], e2 = sides[i], R0 = ctrl[i].R;
    const a1 = e1.len - cutS[i - 1] - 0.01, a2 = e2.len - cutE[i] - 0.01;
    const fits = (q) => q && q.pos1 <= a1 && q.pos2 <= a2;
    let g = filletGeneral(e1, e2, ctrl[i], R0, Dv[i]), Rf = R0;
    if (!fits(g)) {
      let lo = 0, hi = R0, best = null;
      for (let it = 0; it < 48; it++) { const m = (lo + hi) / 2, q = filletGeneral(e1, e2, ctrl[i], m, Dv[i]); if (fits(q)) { lo = m; best = q; } else hi = m; }
      g = best; Rf = lo;
      if (!g || !(Rf > 1e-6)) { skipped.push(i); continue; }
      clamped.push(i);
    }
    fil[i] = { T1: g.T1, T2: g.T2, b: g.b, R: Rf };
    cutE[i - 1] = g.pos1; cutS[i] = g.pos2;
  }
  clamped.sort((a, b) => a - b); skipped.sort((a, b) => a - b);
  // il bulge del lato k fra i suoi capi accorciati (gli archi restano sullo stesso cerchio)
  const sideB = (k) => {
    const e = sides[k];
    if (e.t === "L") return 0;
    if (!cutS[k] && !cutE[k]) return ctrl[k].b || 0;
    return Math.tan(e.s * (Math.abs(e.sw) - (cutS[k] + cutE[k]) / e.r) / 4);
  };
  const out = [], idx = [], R = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const F = fil[i], b = i < n - 1 ? sideB(i) : 0;
    if (F) {
      R[i] = F.R;
      idx.push([out.length, out.length + 1]);
      out.push({ x: F.T1.x, y: F.T1.y, b: F.b });
      out.push({ x: F.T2.x, y: F.T2.y, b });
    } else {
      idx.push([out.length, out.length]);
      out.push({ x: ctrl[i].x, y: ctrl[i].y, b });
    }
  }
  return { pts: out, idx, R, clamped, skipped };
}
/* il raccordo di raggio R al vertice V fra il lato e1 (che arriva) e il lato e2 (che parte), almeno uno ad arco:
   centro all'incrocio delle due curve spostate di R verso l'interno della curva (d = deviazione al vertice),
   punti di tangenza ai piedi delle perpendicolari. Ritorna { T1, T2, b, pos1 (da T1 al vertice lungo e1), pos2 } o null */
function filletGeneral(e1, e2, V, R, d) {
  const del = Math.sign(d) * R;
  const off = (e) => (e.t === "L" ? { t: "L", px: e.ax - e.uy * del, py: e.ay + e.ux * del, ux: e.ux, uy: e.uy } : { t: "C", cx: e.cx, cy: e.cy, r: e.r - e.s * del });
  const o1 = off(e1), o2 = off(e2);
  if ((o1.t === "C" && !(o1.r > 1e-9)) || (o2.t === "C" && !(o2.r > 1e-9))) return null;
  const cands = curveCross(o1, o2);
  if (!cands.length) return null;
  let X = cands[0];
  for (const q of cands) if (Math.hypot(q.x - V.x, q.y - V.y) < Math.hypot(X.x - V.x, X.y - V.y)) X = q;
  const foot = (e) => {
    if (e.t === "L") { const l = (X.x - e.ax) * e.ux + (X.y - e.ay) * e.uy; return { x: e.ax + e.ux * l, y: e.ay + e.uy * l, l }; }
    const dx = X.x - e.cx, dy = X.y - e.cy, h = Math.hypot(dx, dy);
    if (!(h > 1e-12)) return null;
    const x = e.cx + dx / h * e.r, y = e.cy + dy / h * e.r;
    let phi = ((Math.atan2(y - e.cy, x - e.cx) - e.a0) * e.s) % (2 * Math.PI);
    if (phi < 0) phi += 2 * Math.PI;
    if (phi > 2 * Math.PI - 1e-9) phi = 0;
    return { x, y, l: phi * e.r };
  };
  const T1 = foot(e1), T2 = foot(e2);
  if (!T1 || !T2 || !(T1.l >= 0 && T1.l <= e1.len + 1e-9) || !(T2.l >= 0 && T2.l <= e2.len + 1e-9)) return null;
  const pos1 = e1.len - T1.l, pos2 = T2.l;
  if (!(pos1 > 1e-6) || !(pos2 > 1e-6)) return null;
  const sw = Math.atan2((T1.x - X.x) * (T2.y - X.y) - (T1.y - X.y) * (T2.x - X.x), (T1.x - X.x) * (T2.x - X.x) + (T1.y - X.y) * (T2.y - X.y));
  if (Math.sign(sw) !== Math.sign(d) || Math.abs(sw) < 1e-9) return null;
  return { T1: { x: T1.x, y: T1.y }, T2: { x: T2.x, y: T2.y }, b: Math.tan(sw / 4), pos1, pos2 };
}
/* incroci di due curve: retta { px, py, ux, uy } (versore) o cerchio { cx, cy, r } */
function curveCross(a, b) {
  if (a.t === "L" && b.t === "L") {
    const den = a.ux * b.uy - a.uy * b.ux;
    if (Math.abs(den) < 1e-12) return [];
    const t = ((b.px - a.px) * b.uy - (b.py - a.py) * b.ux) / den;
    return [{ x: a.px + a.ux * t, y: a.py + a.uy * t }];
  }
  if (a.t === "C" && b.t === "L") return curveCross(b, a);
  if (a.t === "L") {
    const fx = a.px - b.cx, fy = a.py - b.cy, B = fx * a.ux + fy * a.uy, Cc = fx * fx + fy * fy - b.r * b.r, disc = B * B - Cc;
    if (disc < 0) return [];
    const r = Math.sqrt(disc);
    return [-B - r, -B + r].map((t) => ({ x: a.px + a.ux * t, y: a.py + a.uy * t }));
  }
  const dx = b.cx - a.cx, dy = b.cy - a.cy, dd = Math.hypot(dx, dy);
  if (!(dd > 1e-12) || dd > a.r + b.r || dd < Math.abs(a.r - b.r)) return [];
  const l = (a.r * a.r - b.r * b.r + dd * dd) / (2 * dd), h = Math.sqrt(Math.max(0, a.r * a.r - l * l));
  const mx = a.cx + dx * l / dd, my = a.cy + dy * l / dd;
  return [{ x: mx - dy * h / dd, y: my + dx * h / dd }, { x: mx + dy * h / dd, y: my - dx * h / dd }];
}
/** Stazioni dei vertici di controllo sull'asse della pianta ricavata: il vertice, o il centro del suo raccordo. */
export const ctrlStations = (axis, idx) => idx.map(([a, b]) => (axis.vtx[a].s + axis.vtx[b].s) / 2);
/** Progressiva → u = k + frazione fra le stazioni k e k + 1 (st crescenti), e ritorno. */
export function stationU(st, p) {
  const n = st.length - 1;
  if (!(p > st[0])) return 0;
  if (p >= st[n]) return n;
  let lo = 0, hi = n;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (st[m] <= p) lo = m; else hi = m; }
  const d = st[lo + 1] - st[lo];
  return lo + (d > 0 ? (p - st[lo]) / d : 0);
}
export function stationP(st, u) {
  const n = st.length - 1;
  if (!(u > 0)) return st[0];
  if (u >= n) return st[n];
  const k = Math.floor(u);
  return st[k] + (u - k) * (st[k + 1] - st[k]);
}
/** Come remapP, fra le stazioni dei vertici di controllo di prima e di dopo (fu: come cambia u). */
export function remapStations(oldSt, newSt, p, fu = (u) => u) {
  const a = oldSt[oldSt.length - 1], b = newSt[newSt.length - 1];
  if (p < oldSt[0]) return newSt[0] + (p - oldSt[0]);
  if (p > a) return b + (p - a);
  return stationP(newSt, fu(stationU(oldSt, p)));
}
/**
 * Bulge del lato da a a b che passa per p (arco per tre punti; il lato «trascinato
 * per il mezzo»), al più un semicerchio (|b| ≤ maxB). p sulla corda: 0 (retta).
 */
export function bulgeThrough(a, b, p, maxB = 1) {
  const ux = b.x - a.x, uy = b.y - a.y, c = Math.hypot(ux, uy);
  if (c < 1e-9) return 0;
  const t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / c, h = ((p.y - a.y) * ux - (p.x - a.x) * uy) / c;   // h > 0: p a sinistra della corda
  if (Math.abs(h) < 1e-6 * Math.max(1, c)) return 0;
  const k = ((t - c / 2) ** 2 + h * h - c * c / 4) / (2 * h), r = Math.hypot(c / 2, k);
  const bl = h > 0 ? -(k + r) * 2 / c : (r - k) * 2 / c;          // un arco antiorario (b > 0) sta a destra della corda
  return Math.max(-maxB, Math.min(maxB, bl));
}

/**
 * Profilo dai vertici di controllo [{ s, z, R? }]: ogni vertice interno con R > 0
 * (non su un salto) diventa una PARABOLA tangente alle due livellette, lunga
 * L = R·|Δi| e centrata sul vertice; lati corti: le due mezze lunghezze non lo
 * superano (resta 1 cm) e R si riduce. Punti della parabola ogni passo che la
 * tiene entro tol (1 mm), al più 10 m; i capi del raccordo sono vertici (v), i
 * punti in mezzo no.
 * Ritorna { pts: [{ s, z, v }], curves: [{ i, s, z, L, g1, g2, R }], clamped, skipped }.
 */
export function profileExpand(pts, { tol = 0.001 } = {}) {
  const n = pts.length, Lh = new Array(n).fill(0), g1 = [], g2 = [], skipped = [], clamped = [];
  const ds = (k) => pts[k + 1].s - pts[k].s;
  for (let i = 1; i < n - 1; i++) {
    if (!(pts[i].R > 0)) continue;
    const a = ds(i - 1), b = ds(i);
    if (!(a > SAME_S) || !(b > SAME_S)) { skipped.push(i); continue; }
    const ga = (pts[i].z - pts[i - 1].z) / a, gb = (pts[i + 1].z - pts[i].z) / b;
    if (Math.abs(gb - ga) < 1e-9) { skipped.push(i); continue; }
    g1[i] = ga; g2[i] = gb; Lh[i] = pts[i].R * Math.abs(gb - ga) / 2;
  }
  const f = new Array(n).fill(1);
  for (let k = 0; k + 1 < n; k++) {
    const need = Lh[k] + Lh[k + 1], avail = ds(k) - 0.01;
    if (need > avail && need > 0) { const g = Math.max(0, avail) / need; f[k] = Math.min(f[k], g); f[k + 1] = Math.min(f[k + 1], g); }
  }
  const out = [], curves = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i], h = Lh[i] * f[i];
    if (Lh[i] > 0 && f[i] < 1 - 1e-9) clamped.push(i);
    if (!(h > 1e-6)) { out.push({ s: p.s, z: p.z, v: true }); continue; }
    const L = 2 * h, s0 = p.s - h, z0 = p.z - g1[i] * h, dg = g2[i] - g1[i];
    const step = Math.min(10, Math.sqrt(8 * tol * L / Math.abs(dg))), m = Math.max(2, Math.ceil(L / step));
    for (let k = 0; k <= m; k++) { const x = L * k / m; out.push({ s: s0 + x, z: z0 + g1[i] * x + dg * x * x / (2 * L), v: k === 0 || k === m }); }
    curves.push({ i, s: p.s, z: p.z, L, g1: g1[i], g2: g2[i], R: L / Math.abs(dg) });
  }
  return { pts: out, curves, clamped, skipped };
}

/** Progressiva p sulla pianta di prima → la stessa posizione proiettata sulla pianta nuova (cerca entro win dalla p di prima, in proporzione). */
export function projectP(oldAxis, newAxis, p, win = 50) {
  if (p < 0) return p;
  if (p > oldAxis.length) return newAxis.length + (p - oldAxis.length);
  const q = planAt(oldAxis, p), c = p * newAxis.length / Math.max(oldAxis.length, 1e-9);
  const w = win + Math.abs(newAxis.length - oldAxis.length);
  const hit = nearestS(newAxis, q.x, q.y, c - w, c + w) || nearestS(newAxis, q.x, q.y);
  return hit ? hit.s : c;
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
 * dal bordo esterno del rivestimento, cut/fill scarpe (orizz./vert.); tf
 * spessore del fondo (assente = t: serve al raccordo col canale a U, 0.9).
 *   ui ciglio interno, uo bordo esterno del rivestimento in sommità,
 *   ub spigolo esterno del fondo, ue fine della banchina.
 */
export function ditchShape(d = DITCH) {
  const L = Math.hypot(1, d.m), hb = d.b / 2, tf = d.tf != null ? d.tf : d.t;
  const ui = hb + d.m * d.h, uo = ui + d.t * L, ub = Math.max(0, hb - d.m * tf + d.t * L), ue = uo + d.berm;
  const inner = [[-ui, d.h], [-hb, 0], [hb, 0], [ui, d.h]];
  const outer = [[-uo, d.h], [-ub, -tf], [ub, -tf], [uo, d.h]];
  const ring = [...inner, ...outer.slice().reverse()];
  return { d: { ...d }, hb, ui, uo, ub, ue, h: d.h, t: d.t, tf, inner, outer, ring, liningArea: Math.abs(shoelace(ring)), waterArea: (hb + ui) * d.h, top: 2 * ui };
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
  const D = [[L.u, L.v], [-ue, h], [-uo, h], [-ub, -sh.tf], [ub, -sh.tf], [uo, h], [ue, h], [R.u, R.v]];
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

/**
 * Via i triangoli di area nulla (scavo o riporto che non c'è) e i vertici rimasti senza triangoli.
 * Restano quelli a tre vertici distinti e ALLINEATI (area nulla, nessuno spigolo nullo): ricuciono le
 * giunzioni a T dove due campioni stanno sulla stessa u (±hw dentro/fuori, le due sezioni sulla soglia
 * delle pareti) — senza, la mesh chiude per posizione ma non per topologia (Rhino: isClosed falso).
 */
export function compactMesh({ positions: P, index: I }, eps = 1e-6) {
  const keep = [], used = new Int32Array(P.length / 3).fill(-1), Q = [];
  const same = (a, b) => Math.abs(P[a] - P[b]) <= 1e-9 && Math.abs(P[a + 1] - P[b + 1]) <= 1e-9 && Math.abs(P[a + 2] - P[b + 2]) <= 1e-9;
  for (let k = 0; k < I.length; k += 3) {
    const a = 3 * I[k], b = 3 * I[k + 1], c = 3 * I[k + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], wx = P[c] - P[a], wy = P[c + 1] - P[a + 1], wz = P[c + 2] - P[a + 2];
    if (Math.hypot(uy * wz - uz * wy, uz * wx - ux * wz, ux * wy - uy * wx) <= eps && (same(a, b) || same(b, c) || same(a, c))) continue;
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
 * shapeAt(p) (facoltativo, 0.9): la sezione a ogni progressiva — nei raccordi
 * le misure variano lungo il tratto (stessa topologia degli anelli).
 * Ritorna { sections, length, vol: { lining, cut, fill }, mesh: { lining, cut, fill, surface }, miss }.
 */
export function ditchSweep(stations, sh, zAt3, { O = { x: 0, y: 0 }, du = 0.1, reach = 50, ring = {}, shapeAt = null } = {}) {
  const sections = stations.map((st) => {
    const S = shapeAt ? shapeAt(st.p) : sh;
    const T = (u) => zAt3(st.x + st.nx * u * st.k, st.y + st.ny * u * st.k) - st.z;
    const c = ditchCross(S, T, { du, reach });
    const { us, fixed } = ringU(c, S, ring);
    // dove terreno e fondo scavo si incrociano fra due campioni, il campione libero più vicino va
    // sull'incrocio: la mesh ritrova il volume delle sezioni anche al passaggio sterro/riporto
    snapCross(us, fixed, (u) => T(u) - polyV(c.D, u));
    const Tu = us.map((u) => T(u)), Du = us.map((u) => polyV(c.D, u));
    return { p: st.p, x: st.x, y: st.y, z: st.z, nx: st.nx, ny: st.ny, k: st.k, sh: S, L: c.L, R: c.R, cut: c.cut, fill: c.fill, ok: c.ok, us, Tu, Du };
  });
  const vol = { lining: 0, cut: 0, fill: 0 };
  let length = 0;
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1], b = sections[i], dp = b.p - a.p;
    length += dp;
    vol.cut += (a.cut + b.cut) / 2 * dp; vol.fill += (a.fill + b.fill) / 2 * dp;
    vol.lining += (a.sh.liningArea + b.sh.liningArea) / 2 * dp;
  }
  const P3 = (s, u, v) => [s.x + s.nx * u * s.k - O.x, s.y + s.ny * u * s.k - O.y, s.z + v];
  let mesh = null;
  if (sections.length >= 2) {
    // il rivestimento è un solido vero: il suo verso si decide dal volume; il suo anello gira al
    // contrario di quelli di scavo e riporto (interno sopra, esterno sotto) → verso opposto
    const lining = loftBand(sections.map((s) => [...s.sh.inner.map(([u, v]) => P3(s, u, v)), ...s.sh.outer.slice().reverse().map(([u, v]) => P3(s, u, v))]));
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
        const S = s.sh, F = [[s.L.u, s.L.v], [-S.ue, S.h], [-S.uo, S.h], ...S.inner, [S.uo, S.h], [S.ue, S.h], [s.R.u, s.R.v]];
        return F.map(([u, v]) => P3(s, u, v));
      })),
    };
  }
  return { sections, length, vol, mesh, miss: sections.filter((s) => !s.ok).length };
}

/**
 * Il fosso in tratti fra p0 e p1 (le divisioni dell'utente in cuts), come gli
 * altri tipi: { parts: [{ k (da k0 + 1), p0, p1, length, vol, mesh, miss, n }] }.
 */
export function ditchPartsSweep(axis, prof, anchors, sh, zAt3, { O = { x: 0, y: 0 }, step = 1, cuts = [], p0 = -Infinity, p1 = Infinity, k0 = 0, shapeAt = null, extra = [], du = 0.1, reach = 50 } = {}) {
  const ax3 = buildAxis3D(axis, prof, anchors), res = { parts: [] };
  if (ax3.pts.length < 2) return res;
  const lo = Math.max(p0, ax3.pts[0].p), hi = Math.min(p1, ax3.pts[ax3.pts.length - 1].p);
  const B = [lo, ...cuts.filter((c) => c > lo + 0.5 && c < hi - 0.5).sort((a, b) => a - b), hi];
  for (let i = 0; i + 1 < B.length; i++) {
    const st = sweepStations(axis, prof, anchors, { step, p0: B[i], p1: B[i + 1], extra });
    if (st.length < 2) continue;
    const sw = ditchSweep(st, sh, zAt3, { O, du, reach, shapeAt });
    res.parts.push({ k: k0 + res.parts.length + 1, p0: B[i], p1: B[i + 1], length: sw.length, vol: sw.vol, mesh: sw.mesh, miss: sw.miss, n: st.length });
  }
  return res;
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

   0.9 — SCATOLARE e famiglia del canale (scelte dell'utente 2026-10-05: lo
   scatolare è «un canale», i tombini veri non si fanno qui):
   - m scarpa delle pareti (0 = verticali; serve anche al raccordo col fosso
     trapezio), ch smussi interni agli angoli (cateti ch, 0 = spigolo vivo);
   - scatolare = U + soletta superiore tt (smussi anche in alto), platea = ts;
     scavo come il canale; rinterro fino al terreno se sta sopra, se no fino
     all'estradosso della soletta + ricoprimento minimo cover, poi banchina e
     scarpa fill solo in discesa (rilevato). Salti come il canale.
   ========================================================================= */

export const CHANNEL = Object.freeze({ B: 4, H: 2.5, tw: 0.3, ts: 0.3, tm: 0.1, om: 0.1, se: 0.5, cut: 1.5, berm: 0.5, fill: 1.5, hw: 0.4, key: 0.5, wedge: 1.5, ref: "invert", m: 0, ch: 0 });
/** Scatolare (box culvert): i default proposti all'utente (4,00 × 2,50, pareti, platea e soletta 0,30, smussi 0,20). */
export const BOX = Object.freeze({ ...CHANNEL, tt: 0.3, ch: 0.2, cover: 0 });
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
 * verticale dal fondo interno). uo faccia esterna dei muri al fondo della
 * soletta (uoT in cima: le pareti a scarpa m si allargano salendo), um bordo
 * del magrone, ue spigolo del fondo scavo, ub fine della banchina; vs fondo
 * della soletta, vm fondo del magrone, vC cima dell'opera (dei muri, o
 * estradosso della soletta superiore), vTop cima della superficie finita.
 * lift = fondo interno − linea del profilo. std = la zona corrente (fuori dai
 * salti). roof: scatolare (soletta tt e smussi anche in alto; ricoprimento cover).
 * ring = la U (6 + 6 punti: smussi sempre presenti, anche nulli → la stessa
 * topologia in un raccordo); roofRing = la soletta con gli smussi alti (8 + 8).
 */
export function channelShape(c = CHANNEL, { roof = false } = {}) {
  const m = Math.max(0, c.m || 0), hb = c.B / 2, H = c.H, off = c.tw * Math.hypot(1, m);
  const ch = Math.max(0, Math.min(c.ch || 0, 0.45 * c.B, 0.45 * H));
  const tt = roof ? Math.max(0, c.tt || 0) : 0, cover = roof ? Math.max(0, c.cover || 0) : 0;
  const wo = (v) => hb + m * v + off;                    // faccia esterna del muro alla quota v
  const hbT = hb + m * H, vs = -c.ts, vm = -c.ts - c.tm;
  const uo = wo(vs), uoT = wo(H), um = uo + c.om, ue = um + c.se, ub = uoT + c.berm;
  const vC = H + tt, vTop = vC + cover;
  const inner = [[-hbT, H], [-(hb + m * ch), ch], [-hb + ch, 0], [hb - ch, 0], [hb + m * ch, ch], [hbT, H]];
  const outer = [[-uoT, H], [-wo(ch), ch], [-uo, vs], [uo, vs], [wo(ch), ch], [uoT, H]];
  const ring = [...inner, ...outer.slice().reverse()];
  let roofRing = null, areaRoof = 0;
  if (roof && tt > 0) {
    const hc = hb + m * (H - ch);
    const lo = [[-uoT, H], [-hbT, H], [-hc, H - ch], [-hbT + ch, H], [hbT - ch, H], [hc, H - ch], [hbT, H], [uoT, H]];
    const hi = [[-uoT, vC], [-hbT, vC], [-hbT, vC], [-hbT + ch, vC], [hbT - ch, vC], [hbT, vC], [hbT, vC], [uoT, vC]];
    roofRing = [...lo, ...hi.reverse()];
    areaRoof = Math.abs(shoelace(roofRing));
  }
  const lift = c.ref === "top" ? -vC : c.ref === "base" ? c.ts + c.tm : 0;
  const areaU = Math.abs(shoelace(ring)), areaLean = 2 * um * c.tm;
  return { c: { ...c }, roof: !!roofRing, m, ch, tt, cover, hb, hbT, uo, uoT, um, ue, ub, H, vs, vm, vC, vTop, inner, outer, ring, roofRing, lift,
    areaU, areaRoof, areaC: areaU + areaRoof, areaLean, gross: (uo + uoT) * (H - vs) + 2 * uoT * tt,
    waterArea: Math.abs(shoelace(inner)) - (roofRing ? ch * ch : 0), top: 2 * uoT,
    std: { kind: "std", vE: vm, ledge: vs, aBelow: areaLean, wall: 0, mix: 0 } };
}
/** Lo scatolare: il canale chiuso dalla soletta superiore. */
export const boxShape = (c = BOX) => channelShape(c, { roof: true });

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
 * Scatolare (sh.roof): F = max(T, Fe), Fe piana a vTop (estradosso della
 * soletta + ricoprimento) fino a ub, poi in scarpa 1/fill solo in discesa:
 * dove il terreno sta sopra si rinterra fino al terreno.
 */
export function channelCross(sh, T, zone = null, { du = 0.1, reach = 50 } = {}) {
  const z = zone || sh.std, c = sh.c, { ub, ue, H } = sh, vE = z.vE;
  const dry = [-ue, 0, ue].some((u) => !Number.isFinite(T(u)));
  let L, R, F, Fe = null;
  if (sh.roof) {
    const vT = sh.vTop;
    const toe = (sgn) => { const t = T(sgn * ub); return t < vT ? meet(T, sgn, ub, vT, c.fill, c.fill, du, reach) : { u: sgn * ub, v: t, kind: null, ok: Number.isFinite(t) }; };
    L = toe(-1); R = toe(1);
    Fe = (u) => { const a = Math.abs(u); return a <= ub ? vT : vT - (a - ub) / c.fill; };
    F = (u) => { const t = T(u); return Number.isFinite(t) ? Math.max(t, Fe(u)) : NaN; };
  } else {
    L = meet(T, -1, ub, H, c.fill, c.fill, du, reach); R = meet(T, 1, ub, H, c.fill, c.fill, du, reach);
    F = (u) => { const a = Math.abs(u), f = u < 0 ? L : R, w = Math.abs(f.u); return a <= ub ? H : a >= w ? T(u) : H + (f.v - H) * (a - ub) / Math.max(1e-12, w - ub); };
  }
  const EL = meet(T, -1, ue, vE, c.cut, 0, du, reach), ER = meet(T, 1, ue, vE, c.cut, 0, du, reach);
  const E = (u) => { const a = Math.abs(u), e = u < 0 ? EL : ER; return a <= ue ? vE : a >= Math.abs(e.u) ? T(u) : vE + (a - ue) / c.cut; };
  const Lo = (u) => Math.min(T(u), E(u));
  const out = { L, R, EL, ER, cut: 0, fill: 0, band: 0, ok: !dry && L.ok && R.ok && EL.ok && ER.ok, dry, F, Fe, E, Lo, zone: z };
  if (dry) return out;
  const u0 = Math.min(L.u, EL.u), u1 = Math.max(R.u, ER.u);
  const us = [u0, u1, L.u, R.u, EL.u, ER.u];
  for (const k of [sh.uo, sh.uoT, sh.um, ub, ue]) us.push(-k, k);
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
 * - bottom: rinterro sotto l'opera, dove il terreno sta sotto lo scavo;
 * - top (scatolare): rinterro sopra la soletta, da una faccia all'altra.
 * Dove il terreno incrocia lo scavo, e sugli spigoli delle scarpate, va il
 * campione libero più vicino: la mesh ritrova l'area della sezione.
 * Pareti a scarpa: fra uo e uoT il rinterro sta sotto la faccia esterna del
 * muro (tre campioni fissi: piede del muro, cima del muro, cima dell'opera;
 * a pareti verticali tutti sulla stessa u).
 */
export function channelRings(sh, cr, T, { nS = 10 } = {}) {
  const { uo, uoT, um, ue, ub, H, vs } = sh, zn = cr.zone;
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
    const fx = [[uo, "w"], [uoT, "t0"], [uoT, "t"], [um, "l"], [um, "s"], [ub, ""], [ue, ""]].sort((a, b) => a[0] - b[0]);
    const out = Math.max(Math.abs(F.u), Math.abs(E.u), fx[fx.length - 1][0]);
    const xs = [], kind = [], fix = [];
    fx.forEach(([u, k], j) => {
      xs.push(u); kind.push(k); fix.push(true);
      const next = j + 1 < fx.length ? fx[j + 1][0] : out, n = k === "w" || k === "t0" || k === "l" ? 0 : j + 1 < fx.length ? 3 : nS;
      for (let q = 1; q < n; q++) { xs.push(u + (next - u) * q / n); kind.push(""); fix.push(false); }
    });
    xs.push(out); kind.push(""); fix.push(true);
    snapCross(xs, fix, (u) => T(sgn * u) - cr.E(sgn * u));
    if (cr.Fe && !cr.dry) snapCross(xs, fix, (u) => T(sgn * u) - cr.Fe(sgn * u));    // scatolare: dove il terreno passa la cima del rilevato
    for (const x of [Math.abs(F.u), Math.abs(E.u)]) snapAt(xs, fix, x);
    const wall = (u) => (uoT - uo < 1e-9 ? H : vs + (u - uo) * (H - vs) / (uoT - uo));   // faccia esterna del muro (a scarpa)
    const r = xs.map((u, j) => {
      const U = sgn * u, k = kind[j], ledge = k === "l" || u < um - 1e-9;
      let l = ledge ? zn.ledge : cr.Lo(U), h = cr.F(U);
      if (!Number.isFinite(l)) l = zn.vE;
      if (cr.dry || !Number.isFinite(h)) h = l;
      else if (k === "w") h = Math.min(h, vs);
      else if (k === "t0") h = Math.min(h, H);
      else if (k !== "t" && u < uoT - 1e-9) h = Math.min(h, wall(u));
      return [U, l, Math.max(l, h)];
    });
    return sgn > 0 ? r : r.reverse();
  };
  const bu = [], bf = [];
  for (let j = 0; j <= 6; j++) { bu.push(-um + 2 * um * j / 6); bf.push(j === 0 || j === 6); }
  snapCross(bu, bf, (u) => T(u) - zn.vE);
  const bottom = bu.map((u) => { const t = T(u), v = zn.vE; return [u, cr.dry || !Number.isFinite(t) ? v : Math.min(t, v), v]; });
  let top = null;
  if (sh.roof) {
    const tu = [], tf = [];
    for (let j = 0; j <= 8; j++) { tu.push(-uoT + 2 * uoT * j / 8); tf.push(j === 0 || j === 8); }
    if (!cr.dry) snapCross(tu, tf, (u) => T(u) - cr.Fe(u));
    top = tu.map((u) => { const f = cr.F(u); return [u, sh.vC, cr.dry || !Number.isFinite(f) ? sh.vC : Math.max(sh.vC, f)]; });
  }
  return { cut, right: side(1), left: side(-1), bottom, top };
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
 * 0.9: p0/p1 = solo quel pezzo dell'asse (un tratto della «sezione» di
 * un'opera; i salti sui capi danno ancora il muro di testa al tratto alto),
 * k0 = numerazione dei tratti, shapeAt(p) = la sezione a ogni progressiva
 * (raccordi); sh.roof = scatolare (la soletta va nel cls).
 * Ritorna { parts: [{ k, p0, p1, length, vol, mesh, miss, n, drops }], drops, miss, length, vol };
 *   vol e mesh: lining (U + soletta + muri di testa), lean (magrone), mix (cunei in misto cementato), cut (scavo), fill (rinterro).
 */
export function channelSweep(axis, prof, anchors, sh, zAt3, { O = { x: 0, y: 0 }, step = 1, cuts = [], du = 0.1, reach = 50, nS = 10, p0: r0 = -Infinity, p1: r1 = Infinity, k0 = 0, shapeAt = null, extra: more = [] } = {}) {
  const KEYS = ["lining", "lean", "mix", "cut", "fill"];
  const res = { parts: [], drops: [], miss: 0, length: 0, vol: { lining: 0, lean: 0, mix: 0, cut: 0, fill: 0 } };
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return res;
  const shOf = shapeAt || (() => sh), map = anchorMap(anchors);
  const lo = Math.max(r0, ax3.pts[0].p), hi = Math.min(r1, ax3.pts[ax3.pts.length - 1].p);
  if (!(hi > lo)) return res;
  const ends = [];                                       // salti sui capi del pezzo: solo per il muro di testa
  for (const d of profileDrops(prof)) {
    const p = map.toP(d.q);
    if (p < lo - 1e-6 || p > hi + 1e-6 || p <= ax3.pts[0].p + 1e-6 || p >= ax3.pts[ax3.pts.length - 1].p - 1e-6) continue;
    const S = shOf(p), c = S.c;
    const zHi = Math.max(d.zB, d.zA) + S.lift, zLo = Math.min(d.zB, d.zA) + S.lift;
    const dr = { p, q: d.q, dir: d.zA < d.zB ? 1 : -1, dz: zHi - zLo, zHi, zLo, zD: zLo - c.ts - c.key };
    if (p > lo + 1e-6 && p < hi - 1e-6) res.drops.push(dr); else ends.push(dr);
  }
  const B = [lo, hi, ...res.drops.map((d) => d.p)];
  for (const x of cuts) if (x > lo + 0.5 && x < hi - 0.5 && !res.drops.some((d) => Math.abs(d.p - x) < 0.5)) B.push(x);
  B.sort((a, b) => a - b);
  const bounds = B.filter((x, i) => !i || x - B[i - 1] > 1e-6);
  const P3 = (s, u, v) => [s.x + s.nx * u * s.k - O.x, s.y + s.ny * u * s.k - O.y, s.z + v];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const p0 = bounds[i], p1 = bounds[i + 1];
    const zIn = (p) => zAt(prof, map.toQ(p), p >= p1 - 1e-9 ? -1 : 1) + shOf(p).lift;   // sui capi che cadono su un salto, la quota di questo tratto
    // muri di testa: salto alla fine col lato alto prima (sgn +1) o all'inizio col lato alto dopo (sgn −1)
    const walls = [];
    for (const d of [...res.drops, ...ends]) {
      const sgn = Math.abs(d.p - p1) < 1e-6 && d.dir > 0 ? 1 : Math.abs(d.p - p0) < 1e-6 && d.dir < 0 ? -1 : 0;
      const c = shOf(d.p).c;
      if (!sgn || !(c.hw > 0)) continue;
      const face = sgn > 0 ? Math.max(p0, p1 - c.hw) : Math.min(p1, p0 + c.hw);
      const w = { d, sgn, a: sgn > 0 ? face : p0, b: sgn > 0 ? p1 : face, face, zPit: d.zD - c.tm, wedge: c.wedge, wa: null, wb: null };
      // cuneo: dalla faccia del muro verso il lato alto, finché la scarpa dal piede del dente incontra il fondo dello scavo
      if (c.wedge > 0) {
        const far = sgn > 0 ? p0 : p1, f = (p) => zIn(p) + shOf(p).vm - (w.zPit + Math.abs(p - face) / c.wedge);
        let s = far;
        if (f(far) < 0) { let a = face, b = far; for (let it = 0; it < 50; it++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m; } s = (a + b) / 2; }
        if (Math.abs(s - face) > 1e-4) { w.wa = Math.min(s, face); w.wb = Math.max(s, face); }
      }
      walls.push(w);
    }
    const extra = [...more];
    for (const w of walls) { extra.push(w.face); if (w.wa != null) extra.push(w.wa, w.wb); }
    const raw = sweepStations(axis, prof, anchors, { step, extra, p0, p1 });
    const st = raw.filter((s, k) => !(Math.abs(s.p - p0) < 1e-9 && k + 1 < raw.length && Math.abs(raw[k + 1].p - p0) < 1e-9)
      && !(Math.abs(s.p - p1) < 1e-9 && k > 0 && Math.abs(raw[k - 1].p - p1) < 1e-9));
    if (st.length < 2) continue;
    // zona di ogni stazione: sulla faccia del muro due sezioni (cuneo e muro) alla stessa progressiva
    const zonesAt = (s, zf, S) => {
      const c = S.c;
      for (const w of walls) {
        const inWall = s.p >= w.a - 1e-9 && s.p <= w.b + 1e-9, inWedge = w.wa != null && s.p >= w.wa - 1e-9 && s.p <= w.wb + 1e-9;
        if (!inWall && !inWedge) continue;
        const vD = w.d.zD - zf, wallZ = { kind: "wall", vD, vE: vD - c.tm, ledge: vD, wall: 2 * S.uo * (S.vs - vD), mix: 0 };
        wallZ.aBelow = wallZ.wall + S.areaLean;
        const vE = Math.min(S.vm, w.zPit + Math.abs(s.p - w.face) / w.wedge - zf);
        const wedgeZ = { kind: "wedge", vE, ledge: S.vs, wall: 0, mix: 2 * S.um * (S.vm - vE), aBelow: 2 * S.um * (S.vs - vE) };
        if (inWall && inWedge) return w.sgn > 0 ? [wedgeZ, wallZ] : [wallZ, wedgeZ];
        return [inWall ? wallZ : wedgeZ];
      }
      return [S.std];
    };
    const secs = [];
    for (const s of st) {
      const S = shOf(s.p), zf = s.z + S.lift;
      const T = (u) => zAt3(s.x + s.nx * u * s.k, s.y + s.ny * u * s.k) - zf;
      for (const zone of zonesAt(s, zf, S)) {
        const cr = channelCross(S, T, zone, { du, reach });
        secs.push({ p: s.p, x: s.x, y: s.y, z: zf, nx: s.nx, ny: s.ny, k: s.k, sh: S, zone, cr, T,
          a: { lining: S.areaC + zone.wall, lean: S.areaLean, mix: zone.mix, cut: cr.cut, fill: cr.fill } });
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
    //     [basso…, alto al contrario] girano al contrario della U → verso opposto.
    //     Gli smussi nulli lasciano punti doppi negli anelli: compactMesh toglie i triangoli che ne vengono
    const uniq = secs.filter((s, j) => !j || s.p - secs[j - 1].p > 1e-9);
    const U0 = loftBand(uniq.map((s) => s.sh.ring.map(([u, v]) => P3(s, u, v)))), fl = !U0.flipped;
    const roofed = uniq.every((s) => s.sh.roofRing);
    const roof = roofed ? compactMesh(loftBand(uniq.map((s) => s.sh.roofRing.map(([u, v]) => P3(s, u, v))))) : null;
    const band = (list, ringOf) => {
      if (list.length < 2) return null;
      const zero = [], rings = list.map((s) => {
        const r = ringOf(s);
        zero.push(r.map(([, l, h]) => h - l < 1e-9));
        return [...r.map(([u, l]) => P3(s, u, l)), ...r.slice().reverse().map(([u, , h]) => P3(s, u, h))];
      });
      return compactMesh(loftBand(rings, fl, zero));
    };
    const box = (list, w, lo, hi) => band(list, (s) => [[-w(s), lo(s), hi(s)], [w(s), lo(s), hi(s)]]);
    const wallRuns = runsOf(secs, (s) => s.zone.kind === "wall");
    const rg = new Map(secs.map((s) => [s, channelRings(s.sh, s.cr, s.T, { nS })]));
    const mesh = {
      lining: mergeMeshes([compactMesh(U0), roof, ...wallRuns.map((r) => box(r, (s) => s.sh.uo, (s) => s.zone.vD, (s) => s.sh.vs))]),
      lean: mergeMeshes([...runsOf(secs, (s) => s.zone.kind !== "wall").map((r) => box(r, (s) => s.sh.um, (s) => s.sh.vm, (s) => s.sh.vs)),
        ...wallRuns.map((r) => box(r, (s) => s.sh.um, (s) => s.zone.vD - s.sh.c.tm, (s) => s.zone.vD))]),
      mix: mergeMeshes(runsOf(secs, (s) => s.zone.kind === "wedge").map((r) => box(r, (s) => s.sh.um, (s) => s.zone.vE, (s) => s.sh.vm))),
      cut: mergeMeshes([band(uniq, (s) => rg.get(s).cut)]),
      fill: mergeMeshes([band(secs, (s) => rg.get(s).right), band(secs, (s) => rg.get(s).left), band(secs, (s) => rg.get(s).bottom),
        roofed ? band(uniq, (s) => rg.get(s).top) : null]),
    };
    const miss = uniq.filter((s) => !s.cr.ok).length;
    res.parts.push({ k: k0 + res.parts.length + 1, p0, p1, length, vol, mesh, miss, n: uniq.length,
      drops: walls.map((w) => ({ p: w.d.p, dz: w.d.dz, face: w.face, wedge: w.wa != null ? w.wb - w.wa : 0 })),
      sections: secs.map((s) => ({ p: s.p, z: s.z, kind: s.zone.kind, zone: s.zone, a: s.a, ok: s.cr.ok, dry: s.cr.dry })) });
    res.miss += miss; res.length += length;
    for (const key of KEYS) res.vol[key] += vol[key];
  }
  res.drops.push(...ends);
  res.drops.sort((a, b) => a.p - b.p);
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
  // acciaio saldato UNI EN 10224, DE della serie UNI EN 10220: fino al DN 500 gli spessori dei listini italiani
  // (Metalcondotte, Centrotubi: concordi), DN 600–1200 spessori tipici di magazzino (SSAB e listini); oltre, il tubo a mano
  acciaio: { norm: "UNI EN 10224", dn: "ID", rows: [[80, 88.9, 2.9], [100, 114.3, 3.2], [125, 139.7, 3.6], [150, 168.3, 4], [200, 219.1, 5], [250, 273, 5.6], [300, 323.9, 5.9], [350, 355.6, 6.3], [400, 406.4, 6.3], [450, 457.2, 6.3], [500, 508, 6.3], [600, 610, 6.3], [700, 711, 7.1], [800, 813, 8], [900, 914, 8.8], [1000, 1016, 10], [1200, 1219, 10]] },
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
 * 0.9: p0/p1 = solo quel pezzo dell'asse, k0 = numerazione dei tratti, shapeAt(p) = il tubo a ogni
 * progressiva (raccordo fra due tubi: tronco di cono); blendW = [{ a, b, c, W }]: nel raccordo [a, b]
 * (c = la progressiva del cambio) la larghezza va da quella del tratto alla media con W (l'altro lato) in c;
 * la larghezza UNI EN 1610 del tratto si cerca fuori dai raccordi. widthsOnly: solo le larghezze dei tratti.
 */
export function pipeSweep(axis, prof, anchors, sh, zAt3, { O = { x: 0, y: 0 }, step = 1, cuts = [], partWalls = {}, du = 0.1, reach = 50,
  p0: r0 = -Infinity, p1: r1 = Infinity, k0 = 0, shapeAt = null, extra: more = [], blendW = [], widthsOnly = false } = {}) {
  const KEYS = ["pipe", "bed", "surround", "cover", "fill", "restore", "cut", "emb"];
  const zero = () => Object.fromEntries(KEYS.map((k) => [k, 0]));
  const res = { parts: [], drops: [], miss: 0, length: 0, vol: zero(), shore: 0 };
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return res;
  const p = sh.p, map = anchorMap(anchors), shOf = shapeAt || (() => sh);
  const lo = Math.max(r0, ax3.pts[0].p), hi = Math.min(r1, ax3.pts[ax3.pts.length - 1].p);
  if (!(hi > lo)) return res;
  const inBlend = (x) => blendW.find((b) => x >= b.a - 1e-9 && x <= b.b + 1e-9);
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
    const p0 = bounds[i], p1 = bounds[i + 1], k = k0 + res.parts.length + 1;
    const mode = partWalls[k] || p.walls, mS = Math.max(0.01, p.slope);
    const stationsOf = (extra) => {
      const raw = sweepStations(axis, prof, anchors, { step, p0, p1, extra: [...more, ...extra] });
      const st = raw.filter((s, j) => !(Math.abs(s.p - p0) < 1e-9 && j + 1 < raw.length && Math.abs(raw[j + 1].p - p0) < 1e-9)
        && !(Math.abs(s.p - p1) < 1e-9 && j > 0 && Math.abs(raw[j - 1].p - p1) < 1e-9));
      // sui capi che cadono su un salto, la quota di questo tratto
      for (const s of st) { const z = zAt(prof, map.toQ(s.p), s.p >= p1 - 1e-9 ? -1 : 1); if (Number.isFinite(z)) s.z = z; }
      return st.map((s) => {
        const S = shOf(s.p), zf = s.z + S.lift;
        const T = (u) => zAt3(s.x + s.nx * u * s.k, s.y + s.ny * u * s.k) - zf;
        const depth = T(0) - S.vF;
        const vert = mode === "v" || (mode !== "s" && !(depth > p.deep));
        return { p: s.p, x: s.x, y: s.y, z: zf, nx: s.nx, ny: s.ny, k: s.k, sh: S, T, depth, m: vert ? 0 : mS };
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
      const pure = secs.filter((s) => !inBlend(s.p));                             // fuori dai raccordi (se ce n'è)
      for (const s of pure.length ? pure : secs) W = Math.max(W, en1610Width(s.sh.p.dn, s.sh.De, Number.isFinite(s.depth) ? s.depth : 0, s.m < 0.577));
      W = Math.ceil(W * 20 - 1e-9) / 20;                  // ai 5 cm
    }
    W = Math.max(W, sh.De + 0.1);
    if (widthsOnly) { res.parts.push({ k, p0, p1, width: W }); continue; }
    // nei raccordi la larghezza va verso la media dei due lati sulla progressiva del cambio
    const Wat = (s) => { const b = inBlend(s.p); const t = b ? 0.5 * (1 - Math.abs(s.p - b.c) / Math.max(1e-9, b.b - b.a)) : 0; return Math.max(s.sh.De + 0.1, W + (b ? b.W - W : 0) * t); };
    for (const s of secs) { s.W = Wat(s); s.cr = pipeCross(s.sh, s.T, s.W, s.m, { du, reach }); }
    const vol = zero();
    let length = 0, shore = 0;
    for (let j = 1; j < secs.length; j++) {
      const a = secs[j - 1], b = secs[j], dp = b.p - a.p;
      length += dp;
      for (const key of KEYS) if (key !== "pipe") vol[key] += (a.cr.a[key] + b.cr.a[key]) / 2 * dp;
      vol.pipe += (a.sh.areaPipe + b.sh.areaPipe) / 2 * dp;
      const sa = a.depth > p.deep ? a.cr.shore : 0, sb = b.depth > p.deep ? b.cr.shore : 0;
      shore += (sa + sb) / 2 * dp;
    }
    // --- mesh: il tubo, poi gli strati (anelli basso →, alto ←: tutti lo stesso verso, deciso sullo scavo)
    const uniq = secs.filter((s, j) => !j || s.p - secs[j - 1].p > 1e-9);           // il tubo non ha scalini
    const pipe = loftTube(uniq.map((s) => s.sh.outer.map(([u, v]) => P3(s, u, v))), uniq.map((s) => s.sh.inner.map(([u, v]) => P3(s, u, v))));
    const rg = secs.map((s) => pipeRings(s.sh, s.cr, s.T));
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
      sections: secs.map((s) => ({ p: s.p, z: s.z, depth: s.depth, m: s.m, a: { ...s.cr.a, pipe: s.sh.areaPipe }, W: s.W, shore: s.cr.shore, cov: s.cr.cov, covF: s.cr.covF, ok: s.cr.ok, dry: s.cr.dry })) });
    res.miss += miss; res.length += length; res.shore += shore;
    for (const key of KEYS) res.vol[key] += vol[key];
  }
  return res;
}

/* =========================================================================
   Sezioni diverse lungo la stessa opera (0.9). Scelte dell'utente
   (2026-10-05):
   - tratti «da/a» con un tipo e misure propri; dove non c'è una riga vale
     la sezione dell'opera;
   - al cambio di sezione, fra sezioni COMPATIBILI un raccordo lungo a scelta
     col baricentro sulla progressiva del cambio (metà per lato), oppure il
     cambio netto; fra le altre sempre netto. Compatibili: lo stesso tipo con
     misure diverse, U ↔ scatolare (la soletta comincia e finisce di netto sul
     cambio), fosso ↔ U (le sponde si raddrizzano: il canale ha le pareti a
     scarpa), tubo ↔ tubo (tronco di cono, e la trincea si allarga);
   - il raccordo si divide fra i due tratti sulla progressiva del cambio: in
     ognuno variano le misure del suo tipo, fino alla media dei due lati sul
     cambio; scavo, magrone e rinterro seguono il tipo di ciascun lato.
   ========================================================================= */
export const SECTION_TYPES = Object.freeze(["ditch", "channel", "box", "pipe"]);
/** Raccordo: lunghezza proposta; sotto min un tratto non si fa (e un buco più corto si chiude). */
export const BLEND = Object.freeze({ len: 5, min: 0.5 });
const isNum = (x) => typeof x === "number" && Number.isFinite(x);

/** Due sezioni si possono raccordare? */
export function sectionsCompatible(a, b) {
  if (a === b) return true;
  const k = [a, b].sort().join("|");
  return k === "channel|ditch" || k === "box|channel";
}
/** I parametri di un tipo completati coi default (il fosso col fondo tf, il tubo col letto esplicito). */
export function sectionParams(type, P = {}) {
  if (type === "channel") return { ...CHANNEL, ...P };
  if (type === "box") return { ...BOX, ...P };
  if (type === "pipe") { const q = { ...PIPE, ...P }; return { ...q, bed: q.bed != null ? q.bed : 0.1 + q.dn / 10000 }; }
  const q = { ...DITCH, ...P };
  return { ...q, tf: q.tf != null ? q.tf : q.t };
}
/** La sezione di un tipo coi suoi parametri. */
export function sectionShape(type, P) {
  return type === "channel" ? channelShape(P) : type === "box" ? boxShape(P) : type === "pipe" ? pipeShape(P) : ditchShape(P);
}
/**
 * P (sezione di tipo «from») espressa nel tipo «to»: le misure che si
 * corrispondono; il resto resta quello di own (la sezione di questo lato).
 * Fosso ↔ canale: fondo b ↔ B, altezza, scarpa delle sponde ↔ delle pareti,
 * rivestimento t ↔ pareti tw, fondo tf ↔ soletta ts, banchina e scarpe.
 */
export function sectionAs(from, P, to, own) {
  if (from === "ditch" && to !== "ditch") return { ...own, B: P.b, H: P.h, m: P.m, tw: P.t, ts: P.tf != null ? P.tf : P.t, berm: P.berm, cut: P.cut, fill: P.fill };
  if (to === "ditch" && from !== "ditch") return { ...own, b: P.B, h: P.H, m: P.m || 0, t: P.tw, tf: P.ts, berm: P.berm, cut: P.cut, fill: P.fill };
  const out = { ...own };
  for (const k in own) if (isNum(own[k]) && isNum(P[k])) out[k] = P[k];
  return out;
}
/** Le misure a metà strada (t ∈ [0, 1]): solo i numeri, il resto (riferimento, materiale…) resta quello di A. */
export function sectionLerp(A, B, t) {
  const out = { ...A };
  for (const k in A) if (isNum(A[k]) && isNum(B[k])) out[k] = A[k] + (B[k] - A[k]) * t;
  return out;
}

/**
 * I tratti di sezione fra lo e hi: base = { stype, P } (la sezione
 * dell'opera), rows = [{ id, p0, p1, stype, P, j0?, j1? }] (le righe da/a;
 * j0/j1 = { mode: "blend"|"cut", len } sul capo iniziale/finale). Righe
 * sovrapposte: vale la prima, la seguente parte dopo; buchi e resti più
 * corti di BLEND.min si chiudono. Il cambio fra una riga e la sezione
 * dell'opera lo decide la riga, fra due righe quella prima.
 * Ritorna { runs: [{ p0, p1, stype, P, row }], joins: [{ p, comp, blend, len, h, owner: { row, side } | null }] }
 *   (joins[i] fra runs[i] e runs[i + 1]; h = metà raccordo per lato, ridotta a metà dei due tratti).
 */
export function sectionRuns(base, rows, lo, hi) {
  const R = (rows || []).filter((r) => r && isNum(r.p0) && isNum(r.p1) && SECTION_TYPES.includes(r.stype))
    .map((r) => ({ r, a: Math.max(lo, Math.min(r.p0, r.p1)), b: Math.min(hi, Math.max(r.p0, r.p1)) }))
    .sort((x, y) => x.a - y.a);
  const runs = [];
  let cur = lo;
  for (const { r, a: a0, b } of R) {
    let a = Math.max(a0, cur);
    if (b - a < BLEND.min) continue;
    if (a - cur < BLEND.min) { if (runs.length || a - lo < BLEND.min) a = cur; }   // un buco corto si chiude
    if (a > cur + 1e-9) runs.push({ p0: cur, p1: a, stype: base.stype, P: base.P, row: null });
    runs.push({ p0: a, p1: b, stype: r.stype, P: r.P, row: r });
    cur = b;
  }
  if (hi - cur > 1e-9) {
    if (runs.length && hi - cur < BLEND.min) runs[runs.length - 1].p1 = hi;
    else runs.push({ p0: cur, p1: hi, stype: base.stype, P: base.P, row: null });
  }
  const joins = [];
  for (let i = 0; i + 1 < runs.length; i++) {
    const X = runs[i], Y = runs[i + 1];
    const owner = X.row ? { row: X.row.id, side: 1, j: X.row.j1 } : Y.row ? { row: Y.row.id, side: 0, j: Y.row.j0 } : null;
    const j = (owner && owner.j) || {}, comp = sectionsCompatible(X.stype, Y.stype);
    const len = isNum(j.len) && j.len > 0 ? j.len : BLEND.len;
    const h = comp && j.mode !== "cut" ? Math.min(len / 2, (X.p1 - X.p0) / 2, (Y.p1 - Y.p0) / 2) : 0;
    joins.push({ p: X.p1, comp, blend: h > 1e-3, len, h, owner: owner && { row: owner.row, side: owner.side } });
  }
  return { runs, joins };
}

/**
 * Un'opera con più sezioni: i tratti di sezione (sectionRuns), ognuno col suo
 * sweep (fosso, canale, scatolare, tubo) sul suo pezzo d'asse, con le
 * divisioni dell'utente e i salti; i raccordi con shapeAt; tratti numerati di
 * seguito. spec = { stype, P, rows }. Il tubo nei raccordi tubo ↔ tubo: prima
 * le larghezze della trincea di tutti e due i lati, poi lo sweep vero.
 * Ritorna { parts (ognuno con stype, P, run, blends: [{ p0, p1, to }]), drops, runs, joins, miss, specAt(p) }.
 */
export function workSweep(axis, prof, anchors, spec, zAt3, { O = { x: 0, y: 0 }, cuts = [], partWalls = {}, du = 0.1, reach = 50 } = {}) {
  const res = { parts: [], drops: [], runs: [], joins: [], miss: 0, specAt: () => null };
  const ax3 = buildAxis3D(axis, prof, anchors);
  if (ax3.pts.length < 2) return res;
  const lo = ax3.pts[0].p, hi = ax3.pts[ax3.pts.length - 1].p;
  const base = { stype: SECTION_TYPES.includes(spec.stype) ? spec.stype : "ditch", P: sectionParams(spec.stype, spec.P) };
  const rows = (spec.rows || []).map((r) => ({ ...r, P: sectionParams(r.stype, r.P) }));
  const { runs, joins } = sectionRuns(base, rows, lo, hi);
  runs.forEach((r, i) => {
    const jA = i ? joins[i - 1] : null, jB = joins[i] || null;
    const eqA = jA && jA.blend ? sectionAs(runs[i - 1].stype, runs[i - 1].P, r.stype, r.P) : null;
    const eqB = jB && jB.blend ? sectionAs(runs[i + 1].stype, runs[i + 1].P, r.stype, r.P) : null;
    const pure = sectionShape(r.stype, r.P), memo = new Map();
    r.sh = pure;
    r.blends = [];
    if (eqA) r.blends.push({ a: r.p0, b: r.p0 + jA.h, c: r.p0, to: runs[i - 1].stype });
    if (eqB) r.blends.push({ a: r.p1 - jB.h, b: r.p1, c: r.p1, to: runs[i + 1].stype });
    r.shapeAt = (p) => {
      let P = null;
      if (eqB && p > r.p1 - jB.h) P = sectionLerp(r.P, eqB, Math.min(0.5, 0.5 * (p - (r.p1 - jB.h)) / jB.h));
      else if (eqA && p < r.p0 + jA.h) P = sectionLerp(r.P, eqA, Math.min(0.5, 0.5 * (r.p0 + jA.h - p) / jA.h));
      if (!P) return pure;
      if (!memo.has(p)) memo.set(p, sectionShape(r.stype, P));
      return memo.get(p);
    };
  });
  const sweep = (r, k0, extra = {}) => {
    const o = { O, step: r.P.step || 1, cuts, du, reach, p0: r.p0, p1: r.p1, k0, shapeAt: r.blends.length ? r.shapeAt : null, extra: r.blends.flatMap((b) => [b.a, b.b]), ...extra };
    if (r.stype === "pipe") return pipeSweep(axis, prof, anchors, r.sh, zAt3, { ...o, partWalls });
    if (r.stype === "channel" || r.stype === "box") return channelSweep(axis, prof, anchors, r.sh, zAt3, o);
    return ditchPartsSweep(axis, prof, anchors, r.sh, zAt3, o);
  };
  const pipeBlend = (i) => runs[i].stype === "pipe" && runs[i].blends.some((b) => b.to === "pipe");
  // primo giro: i tratti (e le sole larghezze dei tubi coi raccordi tubo ↔ tubo)
  const out = runs.map(() => null), k0s = [];
  let k = 0;
  runs.forEach((r, i) => {
    k0s[i] = k;
    out[i] = pipeBlend(i) ? sweep(r, k, { widthsOnly: true, blendW: r.blends.map((b) => ({ ...b, W: NaN })) }) : sweep(r, k);
    k += out[i].parts.length;
  });
  runs.forEach((r, i) => {
    if (!pipeBlend(i)) return;
    const Wof = (j, last) => { const ps = out[j] && out[j].parts; return ps && ps.length ? ps[last ? ps.length - 1 : 0].width : NaN; };
    const blendW = r.blends.filter((b) => b.to === "pipe").map((b) => ({ ...b, W: b.c === r.p0 ? Wof(i - 1, true) : Wof(i + 1, false) })).filter((b) => isNum(b.W));
    r.wPure = out[i].parts.map((t) => t.width);
    out[i] = sweep(r, k0s[i], { blendW });
  });
  const seen = new Set();
  runs.forEach((r, i) => {
    for (const t of out[i].parts) {
      t.stype = r.stype; t.P = r.P; t.run = i;
      t.blends = r.blends.filter((b) => b.b > t.p0 + 1e-6 && b.a < t.p1 - 1e-6).map((b) => ({ p0: Math.max(b.a, t.p0), p1: Math.min(b.b, t.p1), to: b.to, c: b.c }));
      res.parts.push(t);
    }
    for (const d of out[i].drops || []) { const key = Math.round(d.p * 1e6); if (!seen.has(key)) { seen.add(key); res.drops.push(d); } }
    res.miss += out[i].miss || 0;
  });
  res.drops.sort((a, b) => a.p - b.p);
  res.runs = runs.map((r) => ({ p0: r.p0, p1: r.p1, stype: r.stype, P: r.P, row: r.row ? r.row.id : null, blends: r.blends }));
  res.joins = joins;
  res.specAt = (p) => {
    let i = runs.findIndex((r) => p < r.p1);
    if (i < 0) i = runs.length - 1;
    const r = runs[i];
    return r ? { stype: r.stype, P: r.P, sh: r.shapeAt(Math.max(r.p0, Math.min(r.p1, p))), run: i } : null;
  };
  return res;
}

/* -------------------------------------------------------------------------
   Taglio della vista 3D (0.10): sezione ⟂ all'asse a una progressiva e taglio
   lungo l'asse (metà modello). Solo vista: i file non cambiano. La pagina
   scarta i frammenti dal lato nascosto e chiude il taglio coi «tappi»: le
   fette delle mesh chiuse delle opere, che sul piano di una stazione
   coincidono con gli anelli delle sezioni (aree esatte).
   ------------------------------------------------------------------------- */

/**
 * Campo laterale dell'asse in pianta, per il taglio lungo l'asse. pts = [{ s, x, y }] (planPoints:
 * archi spezzati; coordinate qualsiasi, anche spostate). at(x, y) → u, distanza con segno dall'asse,
 * positiva a DESTRA guardando avanti come la u delle sezioni; in f.s la progressiva del piede (sulle
 * corde degli archi in proporzione). L'asse prosegue oltre i capi sulle tangenti. Ai vertici lo
 * spigolo è vivo come i giunti delle sezioni (bisettrice, fattore k): nel ventaglio del lato esterno
 * vale la distanza più grande dalle due rette, così il punto di un anello a u dalla stazione di
 * vertice ha campo u. Lineare a tratti: dentro i triangoli delle mesh l'interpolazione è esatta
 * lontano dai vertici. Segmento più vicino a blocchi (riquadro come limite inferiore), cominciando dal
 * blocco della risposta precedente: i vertici di una mesh vengono in ordine. fill(P, ox, oy, U, Sv)
 * riempie U (e Sv) per le posizioni P (x, y, z di seguito) spostate di (ox, oy).
 */
export function axisField(pts, { chunk = 8 } = {}) {
  const Q = [];
  for (const q of pts) { const l = Q[Q.length - 1]; if (!l || Math.hypot(q.x - l.x, q.y - l.y) > 1e-9) Q.push(q); }
  const n = Q.length - 1;
  if (n < 1) throw new Error("axisField: servono due punti distinti");
  const ax = new Float64Array(n), ay = new Float64Array(n), dx = new Float64Array(n), dy = new Float64Array(n), len = new Float64Array(n), s0 = new Float64Array(n), ds = new Float64Array(n);
  let cum = 0;
  for (let i = 0; i < n; i++) {
    const a = Q[i], b = Q[i + 1], L = Math.hypot(b.x - a.x, b.y - a.y);
    const sa = isNum(a.s) ? a.s : cum, sb = isNum(b.s) ? b.s : cum + L;
    ax[i] = a.x; ay[i] = a.y; dx[i] = (b.x - a.x) / L; dy[i] = (b.y - a.y) / L; len[i] = L; s0[i] = sa; ds[i] = (sb - sa) / L;
    cum = sb;
  }
  // blocchi: i due segmenti dei capi (semirette) da soli e sempre guardati, gli altri a gruppi col
  // riquadro, e i blocchi a gruppi di 16 col riquadro (due livelli: assi di migliaia di lati)
  const blocks = [], groups = [];
  const bbox = (o, i0, i1) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = i0; i < i1; i++) for (const [x, y] of [[ax[i], ay[i]], [ax[i] + dx[i] * len[i], ay[i] + dy[i] * len[i]]]) { x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y); }
    return Object.assign(o, { x0, y0, x1, y1 });
  };
  blocks.push({ i0: 0, i1: 1, inf: true });
  for (let i = 1; i < n - 1; i += chunk) blocks.push(bbox({ i0: i, i1: Math.min(n - 1, i + chunk), inf: false }, i, Math.min(n - 1, i + chunk)));
  if (n > 1) blocks.push({ i0: n - 1, i1: n, inf: true });
  const fin = blocks.length - (n > 1 ? 1 : 0);
  for (let k = 1; k < fin; k += 16) { const k1 = Math.min(fin, k + 16); groups.push(bbox({ k0: k, k1 }, blocks[k].i0, blocks[k1 - 1].i1)); }
  const blockOf = new Int32Array(n);
  blocks.forEach((b, k) => { for (let i = b.i0; i < b.i1; i++) blockOf[i] = k; });
  const far = (b, x, y) => { const ex = Math.max(b.x0 - x, 0, x - b.x1), ey = Math.max(b.y0 - y, 0, y - b.y1); return ex * ex + ey * ey; };
  let bd = Infinity, bi = 0, bt = 0, bc = 0, last = 0;
  const seg = (i, x, y) => {
    let t = (x - ax[i]) * dx[i] + (y - ay[i]) * dy[i], cl = 0;
    if (t < 0 && i > 0) { t = 0; cl = -1; } else if (t > len[i] && i < n - 1) { t = len[i]; cl = 1; }
    const fx = ax[i] + dx[i] * t - x, fy = ay[i] + dy[i] * t - y, d = fx * fx + fy * fy;
    if (d < bd) { bd = d; bi = i; bt = t; bc = cl; }
  };
  const scan = (b, x, y) => { for (let i = b.i0; i < b.i1; i++) seg(i, x, y); };
  const f = {
    s: 0, n,
    at(x, y) {
      bd = Infinity;
      scan(blocks[last], x, y);
      if (last !== 0) scan(blocks[0], x, y);
      if (n > 1 && last !== blocks.length - 1) scan(blocks[blocks.length - 1], x, y);
      // punti in disordine: prima il blocco più vicino del gruppo più vicino (un buon limite per potare)
      let gb = null, gd = bd;
      for (const g of groups) { const d = far(g, x, y); if (d < gd) { gd = d; gb = g; } }
      if (gb) { let kb = -1, kd = bd; for (let k = gb.k0; k < gb.k1; k++) { const d = far(blocks[k], x, y); if (d < kd) { kd = d; kb = k; } } if (kb >= 0 && kb !== last) scan(blocks[kb], x, y); }
      for (const g of groups) {
        if (far(g, x, y) >= bd) continue;
        for (let k = g.k0; k < g.k1; k++) if (k !== last && far(blocks[k], x, y) < bd) scan(blocks[k], x, y);
      }
      const i = bi;
      last = blockOf[i];
      if (!bc) { f.s = s0[i] + bt * ds[i]; return (x - ax[i]) * dy[i] - (y - ay[i]) * dx[i]; }
      // sul vertice fra i e j: la distanza più grande dalle due rette (spigolo vivo, come gli anelli)
      const j = i + bc, vx = bc < 0 ? ax[i] : ax[i] + dx[i] * len[i], vy = bc < 0 ? ay[i] : ay[i] + dy[i] * len[i];
      const ui = (x - vx) * dy[i] - (y - vy) * dx[i], uj = (x - vx) * dy[j] - (y - vy) * dx[j];
      f.s = bc < 0 ? s0[i] : s0[i] + len[i] * ds[i];
      return Math.abs(ui) >= Math.abs(uj) ? ui : uj;
    },
    fill(P, ox, oy, U, Sv = null) {
      for (let k = 0, m = P.length / 3; k < m; k++) { U[k] = f.at(P[3 * k] + ox, P[3 * k + 1] + oy); if (Sv) Sv[k] = f.s; }
      return U;
    },
  };
  return f;
}

/* punti sugli spigoli che passano il livello 0 di F (F = 0 conta come positivo): un punto per spigolo,
   lo stesso per i due triangoli che lo condividono; per ogni triangolo tagliato il segmento fra i due.
   Le mesh del motore sono chiuse per POSIZIONE (anelli con vertici propri che si toccano): con `weld`
   gli spigoli si riconoscono dai vertici uniti per posizione (al micron) */
function sliceEdges(P, I, F, G, weld = false) {
  const nv = P.length / 3, ids = new Map(), X = [], Gs = [], A = [], B = [];
  let W = null;
  if (weld) {
    const seen = new Map();
    W = new Int32Array(nv);
    for (let v = 0; v < nv; v++) {
      const k = Math.round(P[3 * v] * 1e6) + "," + Math.round(P[3 * v + 1] * 1e6) + "," + Math.round(P[3 * v + 2] * 1e6);
      const w = seen.get(k);
      if (w === undefined) { seen.set(k, v); W[v] = v; } else W[v] = w;
    }
  }
  const at = (a, b) => {
    if (W) { a = W[a]; b = W[b]; }
    const i = Math.min(a, b), j = Math.max(a, b), key = i * nv + j;
    let id = ids.get(key);
    if (id === undefined) {
      const t = F[i] / (F[i] - F[j]);
      X.push(P[3 * i] + t * (P[3 * j] - P[3 * i]), P[3 * i + 1] + t * (P[3 * j + 1] - P[3 * i + 1]), P[3 * i + 2] + t * (P[3 * j + 2] - P[3 * i + 2]));
      Gs.push(G ? G[i] + t * (G[j] - G[i]) : 0);
      id = Gs.length - 1; ids.set(key, id);
    }
    return id;
  };
  for (let k = 0; k < I.length; k += 3) {
    const a = I[k], b = I[k + 1], c = I[k + 2], sa = F[a] >= 0, sb = F[b] >= 0, sc = F[c] >= 0;
    if (sa === sb && sb === sc) continue;
    const e = [];
    if (sa !== sb) e.push(at(a, b));
    if (sb !== sc) e.push(at(b, c));
    if (sc !== sa) e.push(at(c, a));
    if (e[0] === e[1]) continue;                               // triangolo degenere (due vertici nello stesso punto)
    A.push(e[0]); B.push(e[1]);
  }
  return { X, G: Gs, A, B };
}

/**
 * Fetta di una mesh CHIUSA col livello 0 del campo per vertice F (distanza con segno da un piano, o
 * u − scostamento): anelli chiusi di punti sugli spigoli, ognuno coi punti [x, y, z] di seguito e il
 * parametro G interpolato (l'ascissa lungo il taglio; facoltativo). Le catene che non si chiudono
 * (mesh non a tenuta) si scartano e si contano in `open`. I vertici si uniscono per posizione.
 * Ritorna { loops: [{ xyz: number[], g: number[] }], open }.
 */
export function sliceLoops({ positions: P, index: I }, F, G = null) {
  const { X, G: Gs, A, B } = sliceEdges(P, I, F, G, true);
  const adj = new Map(), add = (p, s) => { const l = adj.get(p); if (l) l.push(s); else adj.set(p, [s]); };
  A.forEach((p, s) => { add(p, s); add(B[s], s); });
  const used = new Uint8Array(A.length), loops = [];
  let open = 0;
  for (let s0 = 0; s0 < A.length; s0++) {
    if (used[s0]) continue;
    used[s0] = 1;
    const start = A[s0], chain = [start];
    let cur = B[s0], closed = false;
    for (;;) {
      if (cur === start) { closed = true; break; }
      chain.push(cur);
      let nx = -1;
      for (const s of adj.get(cur)) if (!used[s]) { nx = s; break; }
      if (nx < 0) break;
      used[nx] = 1;
      cur = A[nx] === cur ? B[nx] : A[nx];
    }
    if (!closed || chain.length < 3) { open++; continue; }
    const xyz = [], g = [];
    for (const id of chain) { xyz.push(X[3 * id], X[3 * id + 1], X[3 * id + 2]); g.push(Gs[id]); }
    loops.push({ xyz, g });
  }
  return { loops, open };
}

/** Fetta di una superficie (il DTM): i segmenti, [x, y, z, x, y, z] di seguito, per disegnarli come linee. */
export function sliceSegments({ positions: P, index: I }, F) {
  const { X, A, B } = sliceEdges(P, I, F, null), out = new Float64Array(A.length * 6);
  A.forEach((a, s) => { const b = B[s]; out.set([X[3 * a], X[3 * a + 1], X[3 * a + 2], X[3 * b], X[3 * b + 1], X[3 * b + 2]], 6 * s); });
  return out;
}

/**
 * Anelli piani (in 2D: [[x, y], …]) → regioni da riempire: ogni anello esterno coi suoi fori, per
 * profondità di annidamento (pari = esterno, dispari = foro dell'anello più piccolo che lo contiene);
 * il verso degli anelli non conta. Ritorna [{ outer, holes: […], area }] (indici negli anelli, area
 * netta = esterno − fori).
 */
export function nestLoops(L) {
  const area = L.map((r) => Math.abs(shoelace(r)));
  const inside = ([x, y], r) => {
    let c = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const [xi, yi] = r[i], [xj, yj] = r[j];
      if ((yi > y) !== (yj > y) && x < xi + (y - yi) * (xj - xi) / (yj - yi)) c = !c;
    }
    return c;
  };
  // un punto dell'anello un poco dentro: il medio di un lato spostato verso l'interno (gli anelli che si toccano non sbagliano)
  const probe = (r) => {
    const s = Math.sign(shoelace(r)) || 1;
    let best = 0, bl = -1;
    for (let i = 0; i < r.length; i++) { const q = r[(i + 1) % r.length], l = Math.hypot(q[0] - r[i][0], q[1] - r[i][1]); if (l > bl) { bl = l; best = i; } }
    const p = r[best], q = r[(best + 1) % r.length], e = 1e-6 * Math.max(1, bl);
    return [(p[0] + q[0]) / 2 - s * (q[1] - p[1]) / bl * e, (p[1] + q[1]) / 2 + s * (q[0] - p[0]) / bl * e];
  };
  const parent = L.map(() => -1), depth = L.map(() => 0);
  L.forEach((r, k) => {
    if (!(area[k] > 0)) return;
    const pt = probe(r);
    L.forEach((o, j) => {
      if (j === k || !(area[j] > area[k]) || !inside(pt, o)) return;
      depth[k]++;
      if (parent[k] < 0 || area[j] < area[parent[k]]) parent[k] = j;
    });
  });
  const out = [];
  L.forEach((r, k) => { if (area[k] > 0 && depth[k] % 2 === 0) out.push({ outer: k, holes: [], area: area[k] }); });
  L.forEach((r, k) => {
    if (!(area[k] > 0) || depth[k] % 2 === 0) return;
    const o = out.find((x) => x.outer === parent[k]);
    if (o) { o.holes.push(k); o.area -= area[k]; }
  });
  return out;
}
