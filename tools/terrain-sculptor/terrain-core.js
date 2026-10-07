/* terrain-core.js — motore del Terrain Sculptor (tools/terrain-sculptor/)
   Modulo PURO: niente DOM, niente import. Gira identico nel browser (tool) e in
   Node (scripts/terrain-fase0.mjs, test/test_terrain_core.js). Le librerie
   esterne arrivano per iniezione: Delatin (semplificazione TIN) e rhino3dm
   (scrittura .3dm) — stesso schema di deps del tool contesto 3D.

   Il terreno è una GRIGLIA DI QUOTE (heightfield) a passo costante:
     nodo (i, j) → x = x0 + i·cell,  y = y0 + j·cell,  z = z[j·nx + i]
   2.5D per costruzione: niente pareti verticali né sbalzi (i muri di sostegno
   restano muri del software BIM). È anche il modello della toposolid di Revit.
   `mask` (facoltativa, Uint8Array): 1 dove il terreno viene da un dato vero,
   0 nei buchi riempiti all'import — le esportazioni lì non scrivono niente.

   Unità: metri. x0/y0 possono essere coordinate assolute (UTM…): la griglia
   lavora in locale e le coordinate tornano locali attorno a un'origine solo
   all'esportazione (exportFrame).

   Fase 1: il documento (TerrainDoc) tiene TRE strati della stessa griglia —
   base (il terreno di partenza, riferimento del bilancio), ground (base +
   colpi di pennello) e final (ground + opere: quello che si vede e si
   esporta). Le opere (piattaforme e rampe) restano OGGETTI modificabili:
   ogni opera è una funzione di un nodo solo — final[k] dipende soltanto da
   ground[k] e dalla posizione del nodo — quindi dopo un colpo di pennello si
   ricalcola solo il quadrato del pennello, e dopo una modifica d'opera solo
   la sua zona d'influenza. */

/* ======================================================================
   Griglia
   ====================================================================== */
/* tetto dei nodi: ~4 milioni (1×1 km a 0,5 m = 2001² = 4.004.001 ci sta) */
export const MAX_NODES = 4200000;

export function createHeightfield({ nx, ny, cell, x0 = 0, y0 = 0, z = 0 }) {
  if (!(nx >= 2 && ny >= 2 && cell > 0)) throw new Error("griglia non valida");
  const hf = { nx, ny, cell, x0, y0, z: new Float64Array(nx * ny), mask: null };
  if (typeof z === "function") {
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++)
      hf.z[j * nx + i] = z(x0 + i * cell, y0 + j * cell);
  } else hf.z.fill(z);
  return hf;
}

export function cloneHeightfield(hf) {
  return { nx: hf.nx, ny: hf.ny, cell: hf.cell, x0: hf.x0, y0: hf.y0, z: Float64Array.from(hf.z), mask: hf.mask ? Uint8Array.from(hf.mask) : null };
}

/* quota bilineare in un punto qualsiasi (fuori griglia: bordo più vicino) */
export function sampleHeight(hf, x, y) {
  const fx = Math.min(Math.max((x - hf.x0) / hf.cell, 0), hf.nx - 1);
  const fy = Math.min(Math.max((y - hf.y0) / hf.cell, 0), hf.ny - 1);
  const i = Math.min(Math.floor(fx), hf.nx - 2), j = Math.min(Math.floor(fy), hf.ny - 2);
  const tx = fx - i, ty = fy - j, n = hf.nx, z = hf.z;
  const a = z[j * n + i], b = z[j * n + i + 1], c = z[(j + 1) * n + i], d = z[(j + 1) * n + i + 1];
  return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
}

export function heightRange(hf) {
  let lo = Infinity, hi = -Infinity;
  for (const v of hf.z) { if (v < lo) lo = v; if (v > hi) hi = v; }
  return { min: lo, max: hi };
}

/* regione di nodi (indici inclusi) del quadrato di lato 2R attorno a (x, y); null se fuori griglia */
export function squareRegion(hf, x, y, R) {
  const c = hf.cell;
  const i0 = Math.max(0, Math.floor((x - R - hf.x0) / c)), i1 = Math.min(hf.nx - 1, Math.ceil((x + R - hf.x0) / c));
  const j0 = Math.max(0, Math.floor((y - R - hf.y0) / c)), j1 = Math.min(hf.ny - 1, Math.ceil((y + R - hf.y0) / c));
  return i0 <= i1 && j0 <= j1 ? { i0, i1, j0, j1 } : null;
}
export function unionRegion(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return { i0: Math.min(a.i0, b.i0), i1: Math.max(a.i1, b.i1), j0: Math.min(a.j0, b.j0), j1: Math.max(a.j1, b.j1) };
}

/* ======================================================================
   Pennelli (scultura libera)
   Peso radiale: 1 fino a hardness·R, poi coseno fino a 0 sul bordo.
   Si visita solo il quadrato del pennello. (Il pennello «Limita
   pendenza» della fase 4 sta con il limite di pendenza: brushLimit.)
   ====================================================================== */
export function brushWeight(r, R, hardness = 0) {
  if (r >= R) return 0;
  const h = R * hardness;
  if (r <= h) return 1;
  return 0.5 * (1 + Math.cos(Math.PI * (r - h) / (R - h)));
}

function brushVisit(hf, x, y, R, fn) {
  const c = hf.cell;
  const i0 = Math.max(0, Math.floor((x - R - hf.x0) / c)), i1 = Math.min(hf.nx - 1, Math.ceil((x + R - hf.x0) / c));
  const j0 = Math.max(0, Math.floor((y - R - hf.y0) / c)), j1 = Math.min(hf.ny - 1, Math.ceil((y + R - hf.y0) / c));
  for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
    const r = Math.hypot(hf.x0 + i * c - x, hf.y0 + j * c - y);
    if (r < R) fn(j * hf.nx + i, r, i, j);
  }
}

/* push / pull: amount > 0 alza, < 0 abbassa (metri al centro) */
export function brushRaise(hf, { x, y, radius, amount, hardness = 0 }) {
  brushVisit(hf, x, y, radius, (k, r) => { hf.z[k] += amount * brushWeight(r, radius, hardness); });
}

/* appiattisci verso una quota (strength 1 = la raggiunge dove il peso è 1) */
export function brushFlatten(hf, { x, y, radius, target, strength = 1, hardness = 0 }) {
  brushVisit(hf, x, y, radius, (k, r) => { hf.z[k] += (target - hf.z[k]) * brushWeight(r, radius, hardness) * strength; });
}

/* liscia: media dei 4 vicini, pesata dal pennello. Legge da una copia (niente
   deriva di scansione) che è solo la finestra del pennello più un nodo di
   bordo: copiare tutta la griglia a ogni colpo costava 32 MB a 4 M nodi. */
export function brushSmooth(hf, { x, y, radius, strength = 0.5, hardness = 0, iterations = 1 }) {
  const n = hf.nx, m = hf.ny, c = hf.cell, z = hf.z;
  const r = squareRegion(hf, x, y, radius);
  if (!r) return;
  const a0 = Math.max(0, r.i0 - 1), a1 = Math.min(n - 1, r.i1 + 1), b0 = Math.max(0, r.j0 - 1), b1 = Math.min(m - 1, r.j1 + 1);
  const W = a1 - a0 + 1, src = new Float64Array(W * (b1 - b0 + 1));
  for (let it = 0; it < iterations; it++) {
    for (let j = b0; j <= b1; j++) src.set(z.subarray(j * n + a0, j * n + a1 + 1), (j - b0) * W);
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
      const d = Math.hypot(hf.x0 + i * c - x, hf.y0 + j * c - y);
      if (d >= radius) continue;
      const s = (j - b0) * W + (i - a0), v = src[s];
      const l = i > 0 ? src[s - 1] : v, rr = i < n - 1 ? src[s + 1] : v;
      const dn = j > 0 ? src[s - W] : v, up = j < m - 1 ? src[s + W] : v;
      z[j * n + i] = v + ((l + rr + dn + up) / 4 - v) * brushWeight(d, radius, hardness) * strength;
    }
  }
}

/* ======================================================================
   Modellazione "con i numeri": piattaforma e percorso con scarpate
   Per ogni nodo a distanza orizzontale d dall'opera di quota zD, la scarpata
   ammessa sta fra zD − s·d e zD + s·d: il terreno esistente dentro la forbice
   resta com'è, fuori viene tagliato (sterro) o riempito (riporto). La linea dove
   la scarpata incontra il terreno (piede/testa) viene da sé, senza disegnarla.
   `round` arrotonda il raccordo col terreno (metri di quota, smooth-min
   polinomiale); vicino al ciglio si annulla, così la quota d'opera resta esatta.
   Fase 4: la scarpata può avere due pendenze, come nei progetti stradali —
   `slope` in riporto (rilevato: il terreno sta sotto l'opera) e `cutSlope`
   in sterro (scavo: il terreno sta sopra); senza (o a 0/null) vale `slope`.
   ====================================================================== */
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a, b, k) => -smin(-a, -b, k);

export function gradeValue(existing, zD, d, slope, round = 0, cut = slope) {
  if (d <= 0) return zD;
  const kc = Math.min(round, cut * d * 0.5), kf = Math.min(round, slope * d * 0.5);
  return smax(smin(existing, zD + cut * d, kc), zD - slope * d, kf);
}
/* pendenza della scarpata in sterro di un'opera: la sua, o quella in riporto */
export const cutSlopeOf = (o) => (+o.cutSlope > 0 ? +o.cutSlope : +o.slope);

export function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const [xa, ya] = poly[a], [xb, yb] = poly[b];
    if ((ya > y) !== (yb > y) && x < (xb - xa) * (y - ya) / (yb - ya) + xa) inside = !inside;
  }
  return inside;
}

/* proiezione di p sul segmento ab: distanza e parametro t ∈ [0,1] */
function segProject(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 > 0 ? Math.min(Math.max(((px - ax) * dx + (py - ay) * dy) / L2, 0), 1) : 0;
  return { d: Math.hypot(px - ax - t * dx, py - ay - t * dy), t };
}

/* baricentro dell'area di un poligono (coordinate relative al primo vertice:
   con quelle UTM i prodotti perderebbero le cifre); degenere → media dei vertici */
export function polygonCentroid(poly) {
  const x0 = poly[0][0], y0 = poly[0][1];
  let a = 0, cx = 0, cy = 0;
  for (let p = 0, q = poly.length - 1; p < poly.length; q = p++) {
    const xq = poly[q][0] - x0, yq = poly[q][1] - y0, xp = poly[p][0] - x0, yp = poly[p][1] - y0, w = xq * yp - xp * yq;
    a += w; cx += (xq + xp) * w; cy += (yq + yp) * w;
  }
  if (Math.abs(a) < 1e-12) return [poly.reduce((s, p) => s + p[0], 0) / poly.length, poly.reduce((s, p) => s + p[1], 0) / poly.length];
  return [x0 + cx / (3 * a), y0 + cy / (3 * a)];
}

/* piattaforma inclinata (fase 4): piano con pendenza `grade` (V/H, es. 0,02)
   che scende verso `dir` (azimut in gradi: 0 nord, 90 est, 180 sud), con la
   quota `elevation` nel `pivot` — il centro dell'area, se manca (scelta
   dell'utente: cambiando la pendenza la piattaforma ruota attorno al centro
   e sterri e riporti restano bilanciati). grade 0 o assente = orizzontale,
   come prima. Fuori dal poligono la scarpata parte dalla quota del punto più
   vicino del ciglio, che è una linea inclinata. */
const okPt = (p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]);
export function padPlane(op) {
  const e = +op.elevation, g = +op.grade || 0;
  if (!g) return { e, g: 0, ux: 0, uy: 0, px: 0, py: 0, z: () => e };
  const A = (+op.dir || 0) * Math.PI / 180, ux = Math.sin(A), uy = Math.cos(A);
  const [px, py] = okPt(op.pivot) ? op.pivot : polygonCentroid(op.polygon);
  return { e, g, ux, uy, px, py, z: (x, y) => e - g * ((x - px) * ux + (y - py) * uy) };
}
export const padZ = (op, x, y) => padPlane(op).z(x, y);

/* piattaforma: poligono [[x,y]…], quota (e piano, se inclinata), pendenza scarpata (V/H, es. 2/3; cutSlope in sterro) */
export function gradePad(hf, op) {
  const { polygon, slope, round = 0 } = op, sc = cutSlopeOf(op), pl = padPlane(op);
  const n = hf.nx, c = hf.cell;
  for (let j = 0; j < hf.ny; j++) for (let i = 0; i < n; i++) {
    const x = hf.x0 + i * c, y = hf.y0 + j * c, k = j * n + i;
    let d = 0, zD = pl.z(x, y);
    if (!pointInPolygon(x, y, polygon)) {
      d = Infinity;
      let qa = 0, qb = 0, qt = 0;
      for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++) {
        const p = segProject(x, y, polygon[b][0], polygon[b][1], polygon[a][0], polygon[a][1]);
        if (p.d < d) { d = p.d; qa = a; qb = b; qt = p.t; }
      }
      zD = pl.z(polygon[qb][0] + qt * (polygon[qa][0] - polygon[qb][0]), polygon[qb][1] + qt * (polygon[qa][1] - polygon[qb][1]));
    }
    hf.z[k] = gradeValue(hf.z[k], zD, d, slope, round, sc);
  }
}

/* piano dei minimi quadrati del terreno dentro un poligono: quota nel
   baricentro dei nodi e gradiente (gx, gy) — da qui la direzione in cui il
   terreno scende, proposta per una piattaforma che si inclina */
export function fitPlane(hf, polygon, stride = 1) {
  let n = 0, sx = 0, sy = 0, sz = 0;
  const pts = [];
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const i0 = Math.max(0, Math.floor((Math.min(...xs) - hf.x0) / hf.cell)), i1 = Math.min(hf.nx - 1, Math.ceil((Math.max(...xs) - hf.x0) / hf.cell));
  const j0 = Math.max(0, Math.floor((Math.min(...ys) - hf.y0) / hf.cell)), j1 = Math.min(hf.ny - 1, Math.ceil((Math.max(...ys) - hf.y0) / hf.cell));
  for (let j = j0; j <= j1; j += stride) for (let i = i0; i <= i1; i += stride) {
    const x = hf.x0 + i * hf.cell, y = hf.y0 + j * hf.cell;
    if (!pointInPolygon(x, y, polygon)) continue;
    const z = hf.z[j * hf.nx + i];
    pts.push(x, y, z); n++; sx += x; sy += y; sz += z;
  }
  if (n < 3) return null;
  const mx = sx / n, my = sy / n, mz = sz / n;
  let xx = 0, xy = 0, yy = 0, xz = 0, yz = 0;
  for (let k = 0; k < pts.length; k += 3) {
    const dx = pts[k] - mx, dy = pts[k + 1] - my, dz = pts[k + 2] - mz;
    xx += dx * dx; xy += dx * dy; yy += dy * dy; xz += dx * dz; yz += dy * dz;
  }
  const det = xx * yy - xy * xy;
  if (!(Math.abs(det) > 1e-12)) return { x: mx, y: my, z: mz, gx: 0, gy: 0 };
  return { x: mx, y: my, z: mz, gx: (xz * yy - yz * xy) / det, gy: (yz * xx - xz * xy) / det };
}

/* percorso/rampa: polilinea [[x,y]…], larghezza, quote d'inizio e fine
   (profilo lineare sulla lunghezza), pendenza delle scarpate laterali.
   Restituisce lunghezza e pendenza longitudinale. */
export function gradePath(hf, { line, width, zStart, zEnd, slope, round = 0, cutSlope = 0 }) {
  const cum = [0], sc = +cutSlope > 0 ? +cutSlope : slope;
  for (let s = 1; s < line.length; s++) cum.push(cum[s - 1] + Math.hypot(line[s][0] - line[s - 1][0], line[s][1] - line[s - 1][1]));
  const L = cum[cum.length - 1], n = hf.nx, c = hf.cell, half = width / 2;
  for (let j = 0; j < hf.ny; j++) for (let i = 0; i < n; i++) {
    const x = hf.x0 + i * c, y = hf.y0 + j * c, k = j * n + i;
    let best = Infinity, along = 0;
    for (let s = 1; s < line.length; s++) {
      const p = segProject(x, y, line[s - 1][0], line[s - 1][1], line[s][0], line[s][1]);
      if (p.d < best) { best = p.d; along = cum[s - 1] + p.t * (cum[s] - cum[s - 1]); }
    }
    const zD = zStart + (zEnd - zStart) * (L > 0 ? along / L : 0);
    hf.z[k] = gradeValue(hf.z[k], zD, Math.max(0, best - half), slope, round, sc);
  }
  return { length: L, grade: L > 0 ? (zEnd - zStart) / L : 0 };
}

/* scarpata come opera (fase 4, scelta dell'utente): si disegna il CIGLIO
   (polilinea), si danno la quota del ciglio `zTop`, quella del piede
   `zBottom` e la pendenza della faccia `face` (V/H); il piede sta da solo a
   W = (zTop − zBottom)/face in pianta, dal lato `side` (+1 a sinistra del
   verso di disegno, −1 a destra). Esempio: un prato a 105 che scende a 102
   con una scarpata 1:2 → fascia larga 6 m. Oltre il ciglio e oltre il piede
   la scarpata di raccordo (slope/cutSlope/round, come le altre opere) trova
   il terreno da sola. Per ogni punto: distanza con segno dal ciglio verso
   valle s (ai vertici interni il segno lo dà la bisettrice delle normali,
   oltre le due estremità la fascia si chiude con un taglio dritto):
   s < 0 → monte, quota zTop a distanza −s; 0 ≤ s ≤ W → sulla faccia,
   zTop − face·s; s > W → valle, quota zBottom a distanza s − W.
   → { W, zTop, zBottom, at(x, y) → [quota d'opera, distanza dall'opera] } */
export function bankGeom(op) {
  const L = op.line, ns = L ? L.length : 0, face = +op.face, zT = +op.zTop, zB = +op.zBottom, side = +op.side < 0 ? -1 : 1;
  if (ns < 2 || !(face > 0) || !Number.isFinite(zT) || !Number.isFinite(zB) || !okPts(L)) return null;
  const W = Math.max(0, (zT - zB) / face), zBot = W > 0 ? zB : zT;
  const N = [];                                   // normali verso valle dei tratti
  for (let q = 1; q < ns; q++) {
    const dx = L[q][0] - L[q - 1][0], dy = L[q][1] - L[q - 1][1], l = Math.hypot(dx, dy) || 1;
    N.push([-dy / l * side, dx / l * side]);
  }
  const onFace = (s, a) => (s < 0 ? [zT, Math.hypot(a, -s)] : s <= W ? [zT - face * s, a] : [zBot, Math.hypot(a, s - W)]);
  return {
    W, zTop: zT, zBottom: zBot, normals: N,
    at(x, y) {
      let best = Infinity, q = 0, t = 0;
      for (let k = 1; k < ns; k++) {
        const p = segProject(x, y, L[k - 1][0], L[k - 1][1], L[k][0], L[k][1]);
        if (p.d < best) { best = p.d; q = k - 1; t = p.t; }
      }
      const vx = x - (L[q][0] + t * (L[q + 1][0] - L[q][0])), vy = y - (L[q][1] + t * (L[q + 1][1] - L[q][1]));
      const n = N[q];
      if ((q === 0 && t === 0) || (q === ns - 2 && t === 1)) {        // oltre un'estremità: taglio dritto
        const ux = (L[q + 1][0] - L[q][0]), uy = (L[q + 1][1] - L[q][1]), ul = Math.hypot(ux, uy) || 1, sg = t === 0 ? -1 : 1;
        const a = Math.max(0, sg * (vx * ux + vy * uy) / ul);
        return onFace(vx * n[0] + vy * n[1], a);
      }
      let s;
      if (t === 0 || t === 1) {                                       // vertice interno: bisettrice delle due normali
        const k = t === 0 ? q : q + 1, m0 = N[k - 1], m1 = N[k];
        let mx = m0[0] + m1[0], my = m0[1] + m1[1];
        if (Math.hypot(mx, my) < 1e-9) { mx = m1[0]; my = m1[1]; }
        s = (vx * mx + vy * my >= 0 ? 1 : -1) * best;
      } else s = vx * n[0] + vy * n[1];
      return onFace(s, 0);
    },
  };
}
export function gradeBank(hf, op) {
  const g = bankGeom(op), sc = cutSlopeOf(op), rnd = +op.round || 0;
  if (!g) return;
  for (let j = 0; j < hf.ny; j++) for (let i = 0; i < hf.nx; i++) {
    const k = j * hf.nx + i, [zD, d] = g.at(hf.x0 + i * hf.cell, hf.y0 + j * hf.cell);
    hf.z[k] = gradeValue(hf.z[k], zD, d, +op.slope, rnd, sc);
  }
}

export function pathLength(line) {
  let L = 0;
  for (let s = 1; s < line.length; s++) L += Math.hypot(line[s][0] - line[s - 1][0], line[s][1] - line[s - 1][1]);
  return L;
}
export function polygonArea(poly) {
  let a = 0;
  for (let p = 0, q = poly.length - 1; p < poly.length; q = p++) a += (poly[q][0] - poly[p][0]) * (poly[q][1] + poly[p][1]);
  return Math.abs(a) / 2;
}

/* quota media del terreno dentro un poligono (proposta di quota di una
   piattaforma: sterri ≈ riporti sotto il piano), passo di campionamento `stride` */
export function meanInside(hf, polygon, stride = 1) {
  let s = 0, n = 0;
  const xs = polygon.map(p => p[0]), ys = polygon.map(p => p[1]);
  const r = { i0: Math.max(0, Math.floor((Math.min(...xs) - hf.x0) / hf.cell)), i1: Math.min(hf.nx - 1, Math.ceil((Math.max(...xs) - hf.x0) / hf.cell)),
              j0: Math.max(0, Math.floor((Math.min(...ys) - hf.y0) / hf.cell)), j1: Math.min(hf.ny - 1, Math.ceil((Math.max(...ys) - hf.y0) / hf.cell)) };
  for (let j = r.j0; j <= r.j1; j += stride) for (let i = r.i0; i <= r.i1; i += stride)
    if (pointInPolygon(hf.x0 + i * hf.cell, hf.y0 + j * hf.cell, polygon)) { s += hf.z[j * hf.nx + i]; n++; }
  return n ? s / n : sampleHeight(hf, xs.reduce((a, b) => a + b) / xs.length, ys.reduce((a, b) => a + b) / ys.length);
}

/* primo punto in cui il segmento p0→p1 attraversa il bordo del poligono (null se mai):
   aggancia l'inizio di una rampa al ciglio della piattaforma da cui parte */
export function firstCrossing(p0, p1, poly) {
  let best = Infinity, hit = null;
  const dx = p1[0] - p0[0], dy = p1[1] - p0[1];
  for (let a = 0, b = poly.length - 1; a < poly.length; b = a++) {
    const ex = poly[a][0] - poly[b][0], ey = poly[a][1] - poly[b][1];
    const den = dx * ey - dy * ex;
    if (Math.abs(den) < 1e-15) continue;
    const t = ((poly[b][0] - p0[0]) * ey - (poly[b][1] - p0[1]) * ex) / den;
    const u = ((poly[b][0] - p0[0]) * dy - (poly[b][1] - p0[1]) * dx) / den;
    if (t > 1e-9 && t <= 1 && u >= 0 && u <= 1 && t < best) { best = t; hit = [p0[0] + t * dx, p0[1] + t * dy]; }
  }
  return hit;
}

/* ======================================================================
   Opere modificabili
   Un'opera è un oggetto JSON:
     { id, type: "pad",  name?, on?, polygon: [[x,y]…], elevation, slope, round,
       cutSlope?, grade?, dir?, pivot? }
     { id, type: "path", name?, on?, line: [[x,y]…], width, zStart, zEnd,
       startPad?, endPad?, slope, round, cutSlope?, lockGrade? }   — vedi pathLine
     { id, type: "bank", name?, on?, line: [[x,y]…] (ciglio), zTop, zBottom,
       face, side, slope, round, cutSlope? }        — vedi bankGeom
     { id, type: "water", name?, on?, polygon, level } e
     { id, type: "lock",  name?, on?, polygon } non toccano il terreno
       (opEvaluator → null): l'acqua si vede e basta, l'area bloccata
       ferma pennelli e limite di pendenza (TerrainDoc.locked)
   startPad/endPad agganciano la quota d'inizio/fine di una rampa alla
   piattaforma da cui parte o a cui arriva: se la piattaforma cambia quota,
   la rampa la segue (se è inclinata, la quota del suo piano nel punto dove
   la rampa la tocca). Le opere si applicano IN ORDINE sopra il terreno
   scolpito (l'ultima vince dove si sovrappongono).
   opEvaluator dà la funzione del singolo nodo — identica, operazione per
   operazione, a gradePad/gradePath — con un taglio a monte: dove la distanza
   dal riquadro dell'opera garantisce che il nodo sta dentro la forbice della
   scarpata, restituisce z tale e quale senza calcolare la distanza vera.
   ====================================================================== */
export function pathEnds(op, ops) {
  const pad = (id) => id ? ops.find(o => o.id === id && o.type === "pad") : null;
  const a = pad(op.startPad), b = pad(op.endPad), L = op.line || [];
  const zOf = (p, pt) => (okPt(pt) ? padZ(p, pt[0], pt[1]) : p.elevation);
  return { zStart: a ? zOf(a, L[0]) : op.zStart, zEnd: b ? zOf(b, L[L.length - 1]) : op.zEnd };
}

/* rampa a pendenza bloccata (fase 4, scelta dell'utente: «la fine si sposta
   da sola»): con `lockGrade` > 0 (V/H, es. 0,08) la lunghezza non è più
   quella disegnata ma |zEnd − zStart| / lockGrade. I vertici disegnati
   restano, tranne l'ultimo: la rampa prosegue nella direzione dell'ultimo
   tratto finché arriva alla quota (l'ultimo tratto si allunga o si
   accorcia); se la parte fissa è già troppo lunga, la rampa finisce prima,
   sulla linea disegnata. Quote uguali: non c'è lunghezza da trovare, vale
   la linea disegnata. → la polilinea effettiva (op.line resta quella
   disegnata: trascinando la fine se ne cambia la direzione) */
export function pathLine(op, ops = [op]) {
  const L = op.line, g = +op.lockGrade;
  if (!(g > 0) || !Array.isArray(L) || L.length < 2 || !okPts(L)) return L;
  const { zStart, zEnd } = pathEnds(op, ops), need = Math.abs(zEnd - zStart) / g, n = L.length;
  if (!(need > 1e-9) || !Number.isFinite(need)) return L;
  let fixed = 0;
  for (let q = 1; q < n - 1; q++) {
    const len = Math.hypot(L[q][0] - L[q - 1][0], L[q][1] - L[q - 1][1]);
    if (fixed + len >= need) {                      // finisce prima dell'ultimo vertice disegnato
      const t = (need - fixed) / len;
      return [...L.slice(0, q), [L[q - 1][0] + t * (L[q][0] - L[q - 1][0]), L[q - 1][1] + t * (L[q][1] - L[q - 1][1])]];
    }
    fixed += len;
  }
  let a = L[n - 2], b = L[n - 1], dx = b[0] - a[0], dy = b[1] - a[1], dl = Math.hypot(dx, dy);
  if (dl < 1e-9) {                                 // ultimo tratto nullo: la direzione del precedente, o verso est
    if (n > 2) { dx = a[0] - L[n - 3][0]; dy = a[1] - L[n - 3][1]; dl = Math.hypot(dx, dy); }
    if (dl < 1e-9) { dx = 1; dy = 0; dl = 1; }
  }
  const r = need - fixed;
  return [...L.slice(0, n - 1), [a[0] + dx / dl * r, a[1] + dy / dl * r]];
}

function boxOf(pts, grow = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
}

const okPts = (pts) => Array.isArray(pts) && pts.every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));

export function opEvaluator(op, ops = [op]) {
  const s = +op.slope, sc = cutSlopeOf(op), rnd = Math.max(0, +op.round || 0);
  if (!(s > 0) || !(sc > 0) || !okPts(op.type === "pad" ? op.polygon : op.line)) return null;
  /* taglio a monte: a distanza dist (≥ 0) dal riquadro, un nodo a quota z sta nella forbice di
     QUALSIASI quota d'opera in [zMin, zMax] — sotto la scarpata in sterro, sopra quella in riporto */
  const inBand = (z, dist, zMin, zMax) => z - zMin < sc * dist - rnd && zMax - z < s * dist - rnd;
  if (op.type === "pad") {
    const P = op.polygon, nv = P ? P.length : 0;
    if (nv < 3 || !Number.isFinite(+op.elevation) || !Number.isFinite(+op.grade || 0) || !Number.isFinite(+op.dir || 0)) return null;
    const pl = padPlane(op), flat = !pl.g;
    let zMin = Infinity, zMax = -Infinity;
    for (const [x, y] of P) { const z = pl.z(x, y); if (z < zMin) zMin = z; if (z > zMax) zMax = z; }
    const box = boxOf(P), [bx0, by0, bx1, by1] = box;
    return {
      box, zMin, zMax, slope: s, cut: sc, round: rnd,
      at(z, x, y) {
        const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0, dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
        if ((dx || dy) && inBand(z, Math.sqrt(dx * dx + dy * dy), zMin, zMax)) return z;
        let d = 0, zD = pl.z(x, y);
        if (!pointInPolygon(x, y, P)) {
          d = Infinity;
          let qa = 0, qb = 0, qt = 0;
          for (let a = 0, b = nv - 1; a < nv; b = a++) {
            const p = segProject(x, y, P[b][0], P[b][1], P[a][0], P[a][1]);
            if (p.d < d) { d = p.d; qa = a; qb = b; qt = p.t; }
          }
          if (!flat) zD = pl.z(P[qb][0] + qt * (P[qa][0] - P[qb][0]), P[qb][1] + qt * (P[qa][1] - P[qb][1]));
        }
        return gradeValue(z, zD, d, s, rnd, sc);
      },
    };
  }
  if (op.type === "path") {
    const line = pathLine(op, ops), half = +op.width / 2, ns = line ? line.length : 0;
    const { zStart, zEnd } = pathEnds(op, ops);
    if (ns < 2 || !(half > 0) || !Number.isFinite(zStart) || !Number.isFinite(zEnd)) return null;
    const cum = [0];
    for (let q = 1; q < ns; q++) cum.push(cum[q - 1] + Math.hypot(line[q][0] - line[q - 1][0], line[q][1] - line[q - 1][1]));
    const L = cum[ns - 1], zMin = Math.min(zStart, zEnd), zMax = Math.max(zStart, zEnd);
    const box = boxOf(line, half), [bx0, by0, bx1, by1] = box;
    return {
      box, zMin, zMax, slope: s, cut: sc, round: rnd, length: L, zStart, zEnd,
      at(z, x, y) {
        const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0, dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
        if ((dx || dy) && inBand(z, Math.sqrt(dx * dx + dy * dy), zMin, zMax)) return z;
        let best = Infinity, along = 0;
        for (let q = 1; q < ns; q++) {
          const p = segProject(x, y, line[q - 1][0], line[q - 1][1], line[q][0], line[q][1]);
          if (p.d < best) { best = p.d; along = cum[q - 1] + p.t * (cum[q] - cum[q - 1]); }
        }
        const zD = zStart + (zEnd - zStart) * (L > 0 ? along / L : 0);
        return gradeValue(z, zD, Math.max(0, best - half), s, rnd, sc);
      },
    };
  }
  if (op.type === "bank") {
    const g = bankGeom(op);
    if (!g) return null;
    const box = boxOf(op.line, g.W), [bx0, by0, bx1, by1] = box, zMin = g.zBottom, zMax = g.zTop;
    return {
      box, zMin, zMax, slope: s, cut: sc, round: rnd, width: g.W,
      at(z, x, y) {
        const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0, dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
        if ((dx || dy) && inBand(z, Math.sqrt(dx * dx + dy * dy), zMin, zMax)) return z;
        const [zD, d] = g.at(x, y);
        return gradeValue(z, zD, d, s, rnd, sc);
      },
    };
  }
  return null;
}

/* zona d'influenza (indici di nodo) di un'opera: il suo riquadro allargato di
   quanto può correre la scarpata prima d'incontrare QUALSIASI quota in
   [zLo, zHi] — oltre, il nodo resta nella forbice e l'opera non lo tocca.
   In sterro corre fino al terreno più alto con la sua pendenza, in riporto
   fino al più basso con l'altra. */
export function opRange(ev, hf, zLo, zHi) {
  if (!ev) return null;
  const reach = Math.max((zHi - ev.zMin + ev.round) / ev.cut, (ev.zMax - zLo + ev.round) / ev.slope, 0) + hf.cell;
  const c = hf.cell, [x0, y0, x1, y1] = ev.box;
  const i0 = Math.max(0, Math.floor((x0 - reach - hf.x0) / c)), i1 = Math.min(hf.nx - 1, Math.ceil((x1 + reach - hf.x0) / c));
  const j0 = Math.max(0, Math.floor((y0 - reach - hf.y0) / c)), j1 = Math.min(hf.ny - 1, Math.ceil((y1 + reach - hf.y0) / c));
  return i0 <= i1 && j0 <= j1 ? { i0, i1, j0, j1 } : null;
}

const cloneOp = (o) => JSON.parse(JSON.stringify(o));

/* ======================================================================
   Documento: base → ground (pennelli) → final (opere), con annulla/ripristina
   La storia è fatta di SCAMBI: ogni voce tiene la versione "dall'altra parte"
   (riquadri 64×64 del ground toccati, e/o l'elenco delle opere) — annullare
   e ripristinare sono la stessa operazione.
   ====================================================================== */
const TILE = 64;
const HIST_MAX = 200;
let HIST_BYTES = 256 * 1048576;
/* il tetto della storia (byte dei riquadri salvati per annullare): su telefono e tablet la pagina lo
   abbassa, lì la memoria è meno (minimo 8 MB) → il tetto in vigore */
export function setHistoryBudget(bytes) { HIST_BYTES = Math.max(8 * 1048576, +bytes || 0); return HIST_BYTES; }

export class TerrainDoc {
  constructor(base, { ground = null, ops = [], meta = {} } = {}) {
    if (base.nx * base.ny > MAX_NODES) throw new Error(`griglia di ${base.nx}×${base.ny} nodi oltre il tetto di ${MAX_NODES}`);
    const mask = base.mask || null;
    this.base = base;
    this.ground = ground ? { ...ground, mask } : { ...cloneHeightfield(base), mask };
    this.final = { ...cloneHeightfield(this.ground), mask };
    this.mask = mask;
    this.ops = ops.map(cloneOp);
    this.meta = meta;
    this.undoStack = []; this.redoStack = []; this.histBytes = 0;
    this._stroke = null;
    this._seq = 1 + this.ops.reduce((m, o) => Math.max(m, +(String(o.id).match(/\d+$/) || [0])[0]), 0);
    this._groundRange();
    this._rebuild();
    this.refold(this.full());
  }
  get nx() { return this.base.nx; }
  get ny() { return this.base.ny; }
  full() { return { i0: 0, i1: this.base.nx - 1, j0: 0, j1: this.base.ny - 1 }; }
  newId(type) { return (["pad", "water", "bank", "lock"].includes(type) ? type : "path") + this._seq++; }

  /* ---- range delle quote: decide quanto lontano può arrivare una scarpata */
  _groundRange() {
    const r = heightRange(this.ground);
    this.zr = { lo: r.min, hi: r.max };
  }
  _bounds(lists) {
    let lo = this.zr.lo, hi = this.zr.hi, rmax = 0;
    for (const list of lists) for (const o of list) {
      const ev = opEvaluator(o, list);
      if (!ev) continue;
      lo = Math.min(lo, ev.zMin); hi = Math.max(hi, ev.zMax); rmax = Math.max(rmax, ev.round);
    }
    const m = rmax / 4 + 1e-6;           // lo smooth-min può scendere sotto il minimo di round/4
    return { lo: lo - m, hi: hi + m };
  }
  _rebuild() {
    const { lo, hi } = this._bounds([this.ops]);
    this._evs = [];
    for (const o of this.ops) {
      if (o.on === false) continue;
      const ev = opEvaluator(o, this.ops), r = opRange(ev, this.final, lo, hi);
      if (ev && r) this._evs.push({ id: o.id, ev, r });
    }
    this._lockMask();
  }
  /* aree bloccate (fase 4): locked[k] = 1 per i nodi dentro i contorni
     accesi delle opere "lock" (null se non ce ne sono). Pennelli e limite
     di pendenza li lasciano come sono; le opere no. Si rifà solo quando
     cambiano i contorni attivi */
  _lockMask() {
    const polys = this.ops.filter(o => o.type === "lock" && o.on !== false && Array.isArray(o.polygon) && o.polygon.length >= 3 && okPts(o.polygon)).map(o => o.polygon);
    const key = JSON.stringify(polys);
    if (key === this._lockKey) return;
    this._lockKey = key;
    const n = this.ground.nx, L = new Uint8Array(n * this.ground.ny);
    let any = false;
    for (const p of polys) polygonRows(this.ground, p, (j, a, b) => { L.fill(1, j * n + a, j * n + b + 1); any = true; });
    this.locked = any ? L : null;
  }

  /* ricalcola final = opere(ground) nella regione */
  refold(r) {
    if (!r) return;
    const { nx, cell, x0, y0 } = this.final, g = this.ground.z, f = this.final.z;
    const evs = this._evs.filter(e => e.r.i0 <= r.i1 && e.r.i1 >= r.i0 && e.r.j0 <= r.j1 && e.r.j1 >= r.j0);
    for (let j = r.j0; j <= r.j1; j++) {
      const y = y0 + j * cell, row = evs.filter(e => j >= e.r.j0 && j <= e.r.j1);
      const k0 = j * nx;
      if (!row.length) { for (let i = r.i0; i <= r.i1; i++) f[k0 + i] = g[k0 + i]; continue; }
      for (let i = r.i0; i <= r.i1; i++) {
        let z = g[k0 + i];
        const x = x0 + i * cell;
        for (const e of row) if (i >= e.r.i0 && i <= e.r.i1) z = e.ev.at(z, x, y);
        f[k0 + i] = z;
      }
    }
  }

  /* ---- pennelli: lavorano sul ground, poi final si ricalcola nel quadrato */
  beginStroke() { if (!this._stroke) this._stroke = { tiles: new Map() }; }
  _backup(r, store) {
    const n = this.ground.nx, m = this.ground.ny, z = this.ground.z;
    for (let tj = Math.floor(r.j0 / TILE); tj <= Math.floor(r.j1 / TILE); tj++)
      for (let ti = Math.floor(r.i0 / TILE); ti <= Math.floor(r.i1 / TILE); ti++) {
        const key = tj * 1e5 + ti;
        if (store.has(key)) continue;
        const i0 = ti * TILE, j0 = tj * TILE, i1 = Math.min(n - 1, i0 + TILE - 1), j1 = Math.min(m - 1, j0 + TILE - 1);
        const w = i1 - i0 + 1, v = new Float64Array(w * (j1 - j0 + 1));
        for (let j = j0; j <= j1; j++) v.set(z.subarray(j * n + i0, j * n + i1 + 1), (j - j0) * w);
        store.set(key, { i0, i1, j0, j1, v });
      }
  }
  brush(kind, p) {
    const hf = this.ground, r = squareRegion(hf, p.x, p.y, p.radius);
    if (!r) return null;
    const own = !this._stroke;
    if (own) this.beginStroke();
    this._backup(r, this._stroke.tiles);
    /* aree bloccate: i loro nodi nel quadrato si rimettono dopo il colpo (lo smooth legge i vicini da una
       copia presa prima: fanno da bordo fermo); per il limite di pendenza sono sorgenti che non cambiano */
    let fixed = null, keep = null;
    if (this.locked) {
      const L = this.locked, n = hf.nx, W = r.i1 - r.i0 + 1;
      for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
        const k = j * n + i;
        if (!L[k]) continue;
        if (!fixed) { fixed = new Uint8Array(W * (r.j1 - r.j0 + 1)); keep = []; }
        fixed[(j - r.j0) * W + i - r.i0] = 1; keep.push(k, hf.z[k]);
      }
    }
    if (kind === "raise") brushRaise(hf, p);
    else if (kind === "smooth") brushSmooth(hf, p);
    else if (kind === "flatten") brushFlatten(hf, p);
    else if (kind === "limit") brushLimit(hf, { ...p, fixed });
    else throw new Error("pennello sconosciuto: " + kind);
    if (keep) for (let q = 0; q < keep.length; q += 2) hf.z[keep[q]] = keep[q + 1];
    let lo = this.zr.lo, hi = this.zr.hi;
    for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
      const v = hf.z[j * hf.nx + i];
      if (v < lo) lo = v; if (v > hi) hi = v;
    }
    if (lo < this.zr.lo || hi > this.zr.hi) { this.zr = { lo, hi }; this._rebuild(); }
    this.refold(r);
    if (own) this.endStroke();
    return r;
  }
  endStroke() {
    const s = this._stroke;
    this._stroke = null;
    if (!s) return false;
    /* via i riquadri rimasti identici (un pennello che passa senza cambiare niente) */
    const n = this.ground.nx, z = this.ground.z, tiles = [];
    for (const t of s.tiles.values()) {
      const w = t.i1 - t.i0 + 1;
      let same = true;
      for (let j = t.j0; j <= t.j1 && same; j++) for (let i = t.i0; i <= t.i1; i++) if (t.v[(j - t.j0) * w + i - t.i0] !== z[j * n + i]) { same = false; break; }
      if (!same) tiles.push(t);
    }
    if (!tiles.length) return false;
    this._push({ tiles });
    return true;
  }
  /* annulla il tratto in corso senza lasciare voci di storia (touch: il
     primo dito ha già dato qualche colpo quando arriva il secondo, che vuol
     dire «navigo») → la regione rimessa com'era, o null */
  abortStroke() {
    const s = this._stroke;
    this._stroke = null;
    if (!s || !s.tiles.size) return null;
    const n = this.ground.nx, z = this.ground.z;
    let region = null;
    for (const t of s.tiles.values()) {
      const w = t.i1 - t.i0 + 1;
      for (let j = t.j0; j <= t.j1; j++) z.set(t.v.subarray((j - t.j0) * w, (j - t.j0 + 1) * w), j * n + t.i0);
      region = unionRegion(region, { i0: t.i0, i1: t.i1, j0: t.j0, j1: t.j1 });
    }
    this._groundRange();
    this._rebuild();
    this.refold(region);
    return region;
  }
  /* limite di pendenza su tutto il terreno scolpito (fase 4): una voce di
     storia coi soli riquadri cambiati (backup dell'intera griglia: 32 MB a
     4 M nodi, sotto HIST_BYTES). Le opere restano sopra, con le loro
     pendenze; le aree bloccate non si toccano (attorno a un'area bloccata
     più alta, scavando, la pendenza può restare oltre).
     → { cut, fill, region } come limitSlope */
  limitAll(slope, mode = "both") {
    if (this._stroke) this.endStroke();
    this.beginStroke();
    this._backup(this.full(), this._stroke.tiles);
    const res = limitSlope(this.ground, slope, mode, { fixed: this.locked });
    if (res.region) { this._groundRange(); this._rebuild(); this.refold(res.region); }
    this.endStroke();
    return res;
  }

  /* ---- opere */
  addOp(op) {
    const o = cloneOp(op);
    if (!o.id) o.id = this.newId(o.type);
    if (o.on === undefined) o.on = true;
    this.setOps([...this.ops, o]);
    return o.id;
  }
  getOp(id) { return this.ops.find(o => o.id === id) || null; }
  updateOp(id, patch, opt) {
    return this.setOps(this.ops.map(o => o.id === id ? Object.assign(cloneOp(o), cloneOp(patch)) : o), opt);
  }
  /* togliendo una piattaforma, le rampe agganciate tengono la quota che avevano */
  removeOp(id) {
    const ops = this.ops.filter(o => o.id !== id).map(o => this._freeze(o, [id]));
    return this.setOps(ops);
  }
  moveOp(id, delta) {
    const k = this.ops.findIndex(o => o.id === id), to = k + delta;
    if (k < 0 || to < 0 || to >= this.ops.length) return null;
    const ops = this.ops.slice();
    ops.splice(to, 0, ops.splice(k, 1)[0]);
    return this.setOps(ops);
  }
  _freeze(o, goneIds) {
    if (o.type !== "path" || !(goneIds.includes(o.startPad) || goneIds.includes(o.endPad))) return o;
    const e = pathEnds(o, this.ops), c = cloneOp(o);
    if (goneIds.includes(o.startPad)) { c.zStart = e.zStart; delete c.startPad; }
    if (goneIds.includes(o.endPad)) { c.zEnd = e.zEnd; delete c.endPad; }
    return c;
  }
  /* sostituisce l'elenco delle opere; `coalesce` fonde nella stessa voce di
     storia le modifiche ravvicinate dello stesso campo (frecce di un numero) */
  setOps(newOps, { coalesce = null } = {}) {
    const before = this.ops;
    this.ops = newOps.map(cloneOp);
    const last = this.undoStack[this.undoStack.length - 1], now = Date.now();
    if (coalesce && last && last.coalesce === coalesce && !last.tiles && now - last.t < 2000 && !this.redoStack.length) last.t = now;
    else this._push({ ops: before, coalesce, t: now });
    const region = this._diffRegion(before, this.ops);
    this._rebuild();
    this.refold(region);
    this.lastRegion = region;                // per chi ha chiamato addOp (che restituisce l'id)
    return region;
  }
  /* chiude la voce di storia in corso: il prossimo trascinamento ne apre una nuova */
  sealHistory() { const last = this.undoStack[this.undoStack.length - 1]; if (last) last.coalesce = null; }
  /* le opere cambiate fra due elenchi (contenuto, quote agganciate o posto
     nell'ordine): unione delle loro zone d'influenza prima e dopo */
  _diffRegion(a, b) {
    const keys = (list) => {
      const act = list.filter(o => o.on !== false), m = new Map();
      for (const o of list) m.set(o.id, JSON.stringify([act.indexOf(o), o, o.type === "path" ? [pathEnds(o, list), pathLine(o, list)] : 0]));
      return m;
    };
    const ka = keys(a), kb = keys(b), { lo, hi } = this._bounds([a, b]);
    let R = null;
    for (const [list, own, other] of [[a, ka, kb], [b, kb, ka]])
      for (const o of list) if (own.get(o.id) !== other.get(o.id)) R = unionRegion(R, opRange(opEvaluator(o, list), this.final, lo, hi));
    return R;
  }
  /* consolida: le opere attive fino a `id` compresa diventano terreno
     scolpito (ci si può ripassare col pennello). Quello che si vede non cambia. */
  bakeThrough(id) {
    const k = this.ops.findIndex(o => o.id === id);
    if (k < 0) return null;
    /* l'acqua e le aree bloccate non sono terreno: restano oggetti anche quando si consolida quello che sta loro sopra */
    const head = this.ops.slice(0, k + 1).filter(o => o.on !== false && o.type !== "water" && o.type !== "lock"), gone = head.map(o => o.id);
    const { lo, hi } = this._bounds([this.ops]);
    const evs = [];
    let region = null;
    for (const o of head) {
      const ev = opEvaluator(o, this.ops), r = opRange(ev, this.ground, lo, hi);
      if (ev && r) { evs.push({ ev, r }); region = unionRegion(region, r); }
    }
    const tiles = new Map();
    if (region) {
      this._backup(region, tiles);
      const { nx, cell, x0, y0 } = this.ground, g = this.ground.z;
      for (let j = region.j0; j <= region.j1; j++) for (let i = region.i0; i <= region.i1; i++) {
        let z = g[j * nx + i];
        for (const e of evs) if (i >= e.r.i0 && i <= e.r.i1 && j >= e.r.j0 && j <= e.r.j1) z = e.ev.at(z, x0 + i * cell, y0 + j * cell);
        g[j * nx + i] = z;
      }
    }
    const before = this.ops;
    this.ops = this.ops.filter(o => !gone.includes(o.id)).map(o => this._freeze(o, gone));
    this._push({ ops: before, tiles: [...tiles.values()] });
    this._groundRange();
    this._rebuild();
    this.refold(region);
    return { region, count: gone.length };
  }

  /* ---- storia */
  _bytes(e) { return (e.tiles || []).reduce((s, t) => s + t.v.byteLength, 0) + (e.ops ? 64 * e.ops.length + 256 : 0); }
  _push(e) {
    for (const r of this.redoStack) this.histBytes -= this._bytes(r);
    this.redoStack = [];
    e.t = e.t || Date.now();
    this.undoStack.push(e);
    this.histBytes += this._bytes(e);
    while (this.undoStack.length > HIST_MAX || (this.histBytes > HIST_BYTES && this.undoStack.length > 1)) this.histBytes -= this._bytes(this.undoStack.shift());
  }
  _swap(e) {
    let region = null;
    if (e.tiles && e.tiles.length) {
      const n = this.ground.nx, z = this.ground.z;
      for (const t of e.tiles) {
        const w = t.i1 - t.i0 + 1;
        for (let j = t.j0; j <= t.j1; j++) for (let i = t.i0; i <= t.i1; i++) {
          const a = (j - t.j0) * w + i - t.i0, k = j * n + i, v = t.v[a];
          t.v[a] = z[k]; z[k] = v;
        }
        region = unionRegion(region, t);
      }
      this._groundRange();
    }
    if (e.ops) {
      const cur = this.ops;
      this.ops = e.ops; e.ops = cur;
      region = unionRegion(region, this._diffRegion(cur, this.ops));
    }
    e.coalesce = null;                       // dopo un annulla la voce non si fonde più
    this._rebuild();
    this.refold(region);
    return region || this.full();
  }
  undo() { const e = this.undoStack.pop(); if (!e) return null; const r = this._swap(e); this.redoStack.push(e); return r; }
  redo() { const e = this.redoStack.pop(); if (!e) return null; const r = this._swap(e); this.undoStack.push(e); return r; }
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  cutFill() { return cutFill(this.base, this.final); }

  /* bilancio per voce (fase 4): il terreno scolpito (pennelli, limite di
     pendenza, opere consolidate) = cutFill(base, ground); l'opera k = sterri
     e riporti fra la quota prima di lei (il ground piegato dalle opere
     accese che la precedono) e dopo, nella sua zona d'influenza. Una passata
     sola per tutte, la stessa piega di refold: da chiamare a riposo, mai a
     ogni passo. I saldi si sommano al saldo totale (base → final); sterri e
     riporti no: dove due opere si sovrappongono una toglie quello che
     l'altra ha messo. → { ground: {cut, fill, net}, ops: { id: {cut, fill,
     net} } } — solo le opere accese che muovono terra (non acqua e aree
     bloccate) */
  balanceByOp() {
    const g = this.ground, n = g.nx, m = g.ny, c = g.cell, A = c * c, Z = g.z, evs = this._evs;
    const ops = {}, acc = evs.map(e => (ops[e.id] = { cut: 0, fill: 0, net: 0 }));
    for (const o of this.ops) if (o.on !== false && o.type !== "water" && o.type !== "lock" && !ops[o.id]) ops[o.id] = { cut: 0, fill: 0, net: 0 };
    let R = null;
    for (const e of evs) R = unionRegion(R, e.r);
    if (R) for (let j = R.j0; j <= R.j1; j++) {
      const row = [];
      let a = Infinity, b = -1;
      evs.forEach((e, q) => { if (j >= e.r.j0 && j <= e.r.j1) { row.push(q); if (e.r.i0 < a) a = e.r.i0; if (e.r.i1 > b) b = e.r.i1; } });
      if (!row.length) continue;
      const y = g.y0 + j * c, wj = (j === 0 || j === m - 1 ? 0.5 : 1) * A;
      for (let i = a; i <= b; i++) {
        let z = Z[j * n + i];
        const x = g.x0 + i * c, w = (i === 0 || i === n - 1 ? 0.5 : 1) * wj;
        for (const q of row) {
          const e = evs[q];
          if (i < e.r.i0 || i > e.r.i1) continue;
          const z2 = e.ev.at(z, x, y), d = z2 - z;
          if (d > 0) acc[q].fill += d * w; else if (d < 0) acc[q].cut -= d * w;
          z = z2;
        }
      }
    }
    for (const id in ops) ops[id].net = ops[id].fill - ops[id].cut;
    return { ground: cutFill(this.base, g), ops };
  }

  /* ---- salvataggio: gli array vanno così come sono (IndexedDB li clona) */
  snapshot() {
    const b = this.base;
    return { v: 1, nx: b.nx, ny: b.ny, cell: b.cell, x0: b.x0, y0: b.y0, meta: this.meta, ops: this.ops,
             base: b.z, ground: this.ground.z, mask: this.mask };
  }
  static fromSnapshot(s) {
    if (!s || s.v !== 1) throw new Error("salvataggio non riconosciuto");
    const grid = { nx: s.nx, ny: s.ny, cell: s.cell, x0: s.x0, y0: s.y0, mask: s.mask || null };
    const f64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a));
    return new TerrainDoc({ ...grid, z: f64(s.base) }, { ground: { ...grid, z: f64(s.ground) }, ops: s.ops || [], meta: s.meta || {} });
  }
}

/* ======================================================================
   File di progetto .terrain (fase 2b): lo stesso snapshot del salvataggio
   nel browser, su disco — base, ground, maschera, opere modificabili e meta
   (georeferenziazione IFC compresa). Serve a portare il lavoro su un altro
   PC e a non perdere le opere: reimportare la toposolid da Revit dà solo
   terreno. Binario e SENZA perdite:
     "TSCULPT1" · uint32 LE lunghezza dell'intestazione · intestazione JSON
     (UTF-8) · zeri fino a multiplo di 8 · blocchi, ognuno allineato a 8
   Blocchi: base (Float64), ground XOR base (i bit: dove non si è scolpito
   è 0 — una differenza in virgola mobile non sarebbe sempre reversibile),
   mask (Uint8, se c'è). I Float64 vanno a «piani di byte» (tutti i primi
   byte, poi tutti i secondi…): segno, esponente e cifre alte di una
   superficie liscia si ripetono e il gzip li schiaccia. Ordine dei byte
   little-endian (quello di tutti i browser). Il gzip lo fa chi chiama
   (CompressionStream nel browser).
   ====================================================================== */
const PROJ_MAGIC = "TSCULPT1";
function planes64(a) {
  const b = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), n = a.length, out = new Uint8Array(n * 8);
  for (let k = 0; k < 8; k++) { const o = k * n; for (let i = 0; i < n; i++) out[o + i] = b[8 * i + k]; }
  return out;
}
function unplanes64(u, n) {
  const out = new Float64Array(n), b = new Uint8Array(out.buffer);
  for (let k = 0; k < 8; k++) { const o = k * n; for (let i = 0; i < n; i++) b[8 * i + k] = u[o + i]; }
  return out;
}
function xor64(a, b) {
  const out = new Float64Array(a.length), A = new Uint32Array(a.buffer, a.byteOffset, 2 * a.length), B = new Uint32Array(b.buffer, b.byteOffset, 2 * b.length), C = new Uint32Array(out.buffer);
  for (let i = 0; i < C.length; i++) C[i] = A[i] ^ B[i];
  return out;
}
const pad8 = (n) => (8 - (n % 8)) % 8;

/** snapshot (TerrainDoc.snapshot) → byte del file; extra va nell'intestazione (versione del tool, data) */
export function encodeProject(s, extra = {}) {
  const n = s.nx * s.ny;
  const f64 = (a) => (a instanceof Float64Array ? a : Float64Array.from(a));
  const base = f64(s.base), ground = f64(s.ground);
  if (base.length !== n || ground.length !== n || (s.mask && s.mask.length !== n)) throw new Error("snapshot incoerente: gli strati non hanno nx × ny nodi");
  const blocks = [["base", "f64-planes", planes64(base)], ["ground", "f64-xor-base-planes", planes64(xor64(ground, base))]];
  if (s.mask) blocks.push(["mask", "u8", s.mask instanceof Uint8Array ? s.mask : Uint8Array.from(s.mask)]);
  const header = { format: "terrain-sculptor-project", v: 1, ...extra, nx: s.nx, ny: s.ny, cell: s.cell, x0: s.x0, y0: s.y0,
    meta: s.meta || {}, ops: s.ops || [], blocks: blocks.map(([name, enc, d]) => ({ name, enc, length: d.length })) };
  const hb = new TextEncoder().encode(JSON.stringify(header));
  let size = 12 + hb.length + pad8(12 + hb.length);
  for (const [, , d] of blocks) size += d.length + pad8(d.length);
  const out = new Uint8Array(size), dv = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) out[i] = PROJ_MAGIC.charCodeAt(i);
  dv.setUint32(8, hb.length, true);
  out.set(hb, 12);
  let o = 12 + hb.length + pad8(12 + hb.length);
  for (const [, , d] of blocks) { out.set(d, o); o += d.length + pad8(d.length); }
  return out;
}

/** byte del file (già decompressi) → { snapshot, header } */
export function decodeProject(u8) {
  const bad = (m) => { throw new Error(m); };
  if (!(u8 instanceof Uint8Array)) u8 = new Uint8Array(u8);
  if (u8.length < 12 || String.fromCharCode(...u8.subarray(0, 8)) !== PROJ_MAGIC) bad("non è un progetto di Terrain Sculptor");
  const hl = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
  if (12 + hl > u8.length) bad("file di progetto troncato");
  let h;
  try { h = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + hl))); } catch (e) { bad("intestazione del progetto illeggibile"); }
  if (h.format !== "terrain-sculptor-project") bad("non è un progetto di Terrain Sculptor");
  if (h.v !== 1) bad(`progetto di una versione più recente (formato ${h.v}): aggiorna la pagina`);
  const n = h.nx * h.ny;
  if (!(Number.isInteger(n) && n > 3)) bad("griglia del progetto non valida");
  let o = 12 + hl + pad8(12 + hl);
  const got = {};
  for (const b of h.blocks || []) {
    if (o + b.length > u8.length) bad("file di progetto troncato");
    got[b.name] = { enc: b.enc, data: u8.subarray(o, o + b.length) };
    o += b.length + pad8(b.length);
  }
  if (!got.base || got.base.enc !== "f64-planes" || got.base.data.length !== 8 * n) bad("strato di base mancante o danneggiato");
  if (!got.ground || got.ground.enc !== "f64-xor-base-planes" || got.ground.data.length !== 8 * n) bad("strato modellato mancante o danneggiato");
  if (got.mask && got.mask.data.length !== n) bad("maschera danneggiata");
  const base = unplanes64(got.base.data, n), ground = xor64(unplanes64(got.ground.data, n), base);
  const snapshot = { v: 1, nx: h.nx, ny: h.ny, cell: h.cell, x0: h.x0, y0: h.y0, meta: h.meta || {}, ops: h.ops || [],
    base, ground, mask: got.mask ? Uint8Array.from(got.mask.data) : null };
  const { blocks, ...header } = h;
  return { snapshot, header };
}

/* ======================================================================
   Sterri e riporti fra due stati della stessa griglia (m³)
   Pesi del trapezio sui nodi: interno 1, bordo ½, angolo ¼.
   ====================================================================== */
export function cutFill(before, after) {
  const n = before.nx, m = before.ny, A = before.cell * before.cell;
  let cut = 0, fill = 0;
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const w = (i === 0 || i === n - 1 ? 0.5 : 1) * (j === 0 || j === m - 1 ? 0.5 : 1) * A;
    const dz = after.z[j * n + i] - before.z[j * n + i];
    if (dz > 0) fill += dz * w; else cut -= dz * w;
  }
  return { cut, fill, net: fill - cut };
}

/* ======================================================================
   Analisi (fase 4): le mappe a colori della scena hanno i loro numeri qui
   ====================================================================== */
/** pendenza nei nodi a differenze centrali (di lato sul bordo) — la stessa
    delle normali della scena e della barra di stato. Per triangolo la mappa
    era granulosa: sul terreno di Revit due triangoli vicini differiscono
    molto. «Oltre» vuol dire oltre `slope` di più del 2 ‰: una faccia fatta
    esattamente alla pendenza massima non deve sfarfallare sulla soglia */
export const SLOPE_TOL = 1.002;
/** area in pianta dove la pendenza supera `slope` (V/H): pesi del trapezio
    sui nodi come cutFill, i nodi fuori dalla maschera non contano.
    → { over, total, share, max } (m², pendenza massima) */
export function slopeOver(hf, slope) {
  const n = hf.nx, m = hf.ny, c = hf.cell, Z = hf.z, M = hf.mask, lim = slope * SLOPE_TOL, A = c * c;
  let over = 0, total = 0, mx = 0;
  for (let j = 0; j < m; j++) {
    const jm = j > 0 ? j - 1 : j, jp = j < m - 1 ? j + 1 : j, wj = (j === 0 || j === m - 1 ? 0.5 : 1) * A;
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      if (M && !M[k]) continue;
      const im = i > 0 ? i - 1 : i, ip = i < n - 1 ? i + 1 : i;
      const zx = (Z[j * n + ip] - Z[j * n + im]) / ((ip - im) * c), zy = (Z[jp * n + i] - Z[jm * n + i]) / ((jp - jm) * c);
      const g = Math.sqrt(zx * zx + zy * zy), w = (i === 0 || i === n - 1 ? 0.5 : 1) * wj;
      total += w;
      if (g > lim) over += w;
      if (g > mx) mx = g;
    }
  }
  return { over, total, share: total > 0 ? over / total : 0, max: mx };
}

/** scala comoda della mappa di sterri e riporti: il 95° percentile di
    |final − base| dove il terreno è cambiato (più di 1 mm), arrotondato per
    eccesso a 0,1 / 0,2 / 0,5 / 1 / 2 / 5… m (istogramma: niente
    ordinamento di milioni di valori); 0 se non è cambiato niente */
export function cutFillScale(before, after) {
  const A = before.z, B = after.z;
  let mx = 0, n = 0;
  for (let k = 0; k < A.length; k++) { const d = Math.abs(B[k] - A[k]); if (d > 1e-3) { n++; if (d > mx) mx = d; } }
  if (!n) return 0;
  const bins = new Uint32Array(1000);
  for (let k = 0; k < A.length; k++) { const d = Math.abs(B[k] - A[k]); if (d > 1e-3) bins[Math.min(999, Math.floor(d / mx * 1000))]++; }
  let acc = 0, b = 0;
  for (; b < 1000; b++) { acc += bins[b]; if (acc >= 0.95 * n) break; }
  const p95 = (b + 1) / 1000 * mx;
  for (let e = 1e-1; ; e *= 10) for (const f of [1, 2, 5]) if (f * e >= p95 - 1e-12) return +(f * e).toPrecision(3);
}

/* ======================================================================
   Limite di pendenza (fase 4): il terreno più vicino a quello scolpito
   che non supera la pendenza massima s. Inviluppi di Lipschitz:
     scava       z↓(p) = min_q z(q) + s·D(p,q)   (il più alto sotto z)
     riempi      z↑(p) = max_q z(q) − s·D(p,q)   (il più basso sopra z)
     bilanciato  (z↓ + z↑)/2 — la media di due funzioni che rispettano s
                 la rispetta; dove la pendenza va già bene z↓ = z↑ = z
                 e niente cambia.
   D è la distanza a smusso 5×5 (passi di lato, di diagonale e di
   cavallo, pesi 1, √2, √5): due passate raster la danno esatta, perché
   due passi vicini della maschera hanno gli stessi segni e un cammino
   minimo si riordina in passi «avanti» poi «indietro» senza uscire dal
   rettangolo. Sulle facce che ne escono la pendenza vera sta fra s e
   s/cos 13,3° (+2,75 %: il 16-gono della maschera contro il cerchio).
   Margine: la pendenza che si vede (mappa, slopeOver) è nei nodi a
   differenze centrali, e su una PIEGA quattro vicini che rispettano s su
   lati e diagonali danno fino a s·√(4 − 2√2) = s/cos(π/8) (+8,2 %:
   misurato sulle creste dell'inviluppo, zx = 1, zy = 0,414). Si lavora
   quindi a s·cos(π/8): nessun nodo supera la soglia, le facce stanno al
   92–95 % di s. Sul bordo della griglia la mappa usa differenze di lato
   (un angolo arriverebbe a √2·s): i lati che toccano il bordo valgono
   s/√2, e con pesi non uniformi le passate si ripetono finché non cambia
   più niente (di solito due giri, il secondo solo per controllo).
   ====================================================================== */
export const LIMIT_K = Math.cos(Math.PI / 8);

/** inviluppo a smusso 5×5, sul posto, di una finestra W×H che parte dal
    nodo (gi, gj) di una griglia nx×ny. sign +1: inferiore (scava), −1:
    superiore (riempi). Pesi w1 lato, w2 diagonale, w3 salto di cavallo,
    wt sui lati che toccano il bordo della griglia; i nodi `fixed` (finestra)
    non cambiano ma fanno da sorgente. maxIter 1 = le due passate soltanto. */
export function chamferEnvelope(f, W, H, { w1, w2, w3, wt = w1, gi = 0, gj = 0, nx = gi + W, ny = gj + H, sign = 1, fixed = null, maxIter = 64 }) {
  if (sign < 0) for (let k = 0; k < f.length; k++) f[k] = -f[k];
  const I1 = nx - 1, J1 = ny - 1;
  let ch = true;
  for (let it = 0; ch && it < maxIter; it++) {
    ch = false;
    for (let j = 0; j < H; j++) {                                   // avanti: da sinistra e dalle righe sotto
      const J = gj + j, rowB = J === 0 || J === J1;
      for (let i = 0; i < W; i++) {
        const p = j * W + i;
        if (fixed && fixed[p]) continue;
        const I = gi + i;
        let v = f[p], u;
        if (i > 0) { u = f[p - 1] + (rowB || I === 1 || I === I1 ? wt : w1); if (u < v) v = u; }
        if (j > 0) {
          const q = p - W;
          u = f[q] + (I === 0 || I === I1 || J === 1 || J === J1 ? wt : w1); if (u < v) v = u;
          if (i > 0) { u = f[q - 1] + w2; if (u < v) v = u; }
          if (i < W - 1) { u = f[q + 1] + w2; if (u < v) v = u; }
          if (i > 1) { u = f[q - 2] + w3; if (u < v) v = u; }
          if (i < W - 2) { u = f[q + 2] + w3; if (u < v) v = u; }
          if (j > 1) {
            const q2 = q - W;
            if (i > 0) { u = f[q2 - 1] + w3; if (u < v) v = u; }
            if (i < W - 1) { u = f[q2 + 1] + w3; if (u < v) v = u; }
          }
        }
        if (v < f[p]) { f[p] = v; ch = true; }
      }
    }
    for (let j = H - 1; j >= 0; j--) {                               // indietro: da destra e dalle righe sopra
      const J = gj + j, rowB = J === 0 || J === J1;
      for (let i = W - 1; i >= 0; i--) {
        const p = j * W + i;
        if (fixed && fixed[p]) continue;
        const I = gi + i;
        let v = f[p], u;
        if (i < W - 1) { u = f[p + 1] + (rowB || I === 0 || I === I1 - 1 ? wt : w1); if (u < v) v = u; }
        if (j < H - 1) {
          const q = p + W;
          u = f[q] + (I === 0 || I === I1 || J === 0 || J === J1 - 1 ? wt : w1); if (u < v) v = u;
          if (i < W - 1) { u = f[q + 1] + w2; if (u < v) v = u; }
          if (i > 0) { u = f[q - 1] + w2; if (u < v) v = u; }
          if (i < W - 2) { u = f[q + 2] + w3; if (u < v) v = u; }
          if (i > 1) { u = f[q - 2] + w3; if (u < v) v = u; }
          if (j < H - 2) {
            const q2 = q + W;
            if (i < W - 1) { u = f[q2 + 1] + w3; if (u < v) v = u; }
            if (i > 0) { u = f[q2 - 1] + w3; if (u < v) v = u; }
          }
        }
        if (v < f[p]) { f[p] = v; ch = true; }
      }
    }
  }
  if (sign < 0) for (let k = 0; k < f.length; k++) f[k] = -f[k];
  return f;
}

/** quote d'arrivo del limite di pendenza `slope` (V/H) nella regione r
    (tutta la griglia se manca): mode "cut" scava, "fill" riempie, "both"
    a metà. Solo i nodi della regione fanno da sorgente. → Float64Array
    della finestra, riga per riga */
export function slopeTarget(hf, slope, mode = "both", r = null, { fixed = null, maxIter = 64 } = {}) {
  r = r || { i0: 0, i1: hf.nx - 1, j0: 0, j1: hf.ny - 1 };
  const W = r.i1 - r.i0 + 1, H = r.j1 - r.j0 + 1, n = hf.nx, s = slope * LIMIT_K * hf.cell;
  const opt = { w1: s, w2: s * Math.SQRT2, w3: s * Math.sqrt(5), wt: slope * hf.cell * Math.SQRT1_2, gi: r.i0, gj: r.j0, nx: hf.nx, ny: hf.ny, fixed, maxIter };
  const lo = new Float64Array(W * H);
  for (let j = 0; j < H; j++) lo.set(hf.z.subarray((r.j0 + j) * n + r.i0, (r.j0 + j) * n + r.i1 + 1), j * W);
  const up = mode === "cut" ? null : Float64Array.from(lo);
  if (mode !== "fill") chamferEnvelope(lo, W, H, { ...opt, sign: 1 });
  if (!up) return lo;
  chamferEnvelope(up, W, H, { ...opt, sign: -1 });
  if (mode === "fill") return up;
  for (let k = 0; k < lo.length; k++) lo[k] = (lo[k] + up[k]) / 2;
  return lo;
}

/** limite di pendenza su tutta la griglia, sul posto. → { cut, fill } (m³,
    pesi del trapezio come cutFill) e la regione dei nodi cambiati (null se
    nessuno). Sotto il nanometro non è un cambiamento: la media del modo
    bilanciato arrotonda, e rifare il limite su un terreno già limitato
    spostava qualche nodo di un ulp (con una voce di storia inutile) */
export function limitSlope(hf, slope, mode = "both", { fixed = null } = {}) {
  const t = slopeTarget(hf, slope, mode, null, { fixed }), n = hf.nx, m = hf.ny, A = hf.cell * hf.cell, Z = hf.z;
  let cut = 0, fill = 0, i0 = n, i1 = -1, j0 = m, j1 = -1;
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, d = t[k] - Z[k];
    if (!(Math.abs(d) > 1e-9)) continue;
    Z[k] = t[k];
    const w = (i === 0 || i === n - 1 ? 0.5 : 1) * (j === 0 || j === m - 1 ? 0.5 : 1) * A;
    if (d > 0) fill += d * w; else cut -= d * w;
    if (i < i0) i0 = i; if (i > i1) i1 = i; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }
  return { cut, fill, region: i1 >= 0 ? { i0, i1, j0, j1 } : null };
}

/** pennello «Limita pendenza»: l'inviluppo della sola finestra del
    pennello, poi z += (arrivo − z)·peso·intensità (le due passate bastano:
    il pennello ci ripassa) */
export function brushLimit(hf, { x, y, radius, slope, mode = "both", strength = 1, hardness = 0, fixed = null }) {
  const r = squareRegion(hf, x, y, radius);
  if (!r || !(slope > 0)) return;
  const t = slopeTarget(hf, slope, mode, r, { fixed, maxIter: 1 }), W = r.i1 - r.i0 + 1, c = hf.cell;
  for (let j = r.j0; j <= r.j1; j++) for (let i = r.i0; i <= r.i1; i++) {
    const d = Math.hypot(hf.x0 + i * c - x, hf.y0 + j * c - y);
    if (d >= radius) continue;
    const k = j * hf.nx + i;
    hf.z[k] += (t[(j - r.j0) * W + i - r.i0] - hf.z[k]) * brushWeight(d, radius, hardness) * strength;
  }
}

/* ======================================================================
   Plastico (fase 3): solo aspetto, il terreno non cambia
   ====================================================================== */
/** quota tonda del fondo del blocco a plastico: sotto il punto più basso di
    uno spessore proporzionato al blocco (un ottavo del dislivello o un
    cinquantesimo del lato maggiore, almeno 1 m), arrotondata a 1 / 5 / 10 m */
export function autoBlockBase(hf, range = heightRange(hf)) {
  const ext = Math.max((hf.nx - 1) * hf.cell, (hf.ny - 1) * hf.cell);
  const t = Math.max(1, (range.max - range.min) / 8, ext / 50);
  const step = t >= 50 ? 10 : t >= 10 ? 5 : 1;
  return Math.floor((range.min - t) / step + 1e-9) * step;
}

/* L'acqua è un'opera (type "water": contorno + quota) che NON tocca il
   terreno — opEvaluator la salta, bakeThrough la lascia stare: l'utente
   decide dove metterla disegnandone il contorno, e lì l'acqua sta solo dove
   il terreno è più basso della sua quota. */

/* righe di nodi dentro un poligono (pari/dispari, come pointInPolygon):
   fn(j, i0, i1) per ogni tratto, già tagliato sulla griglia. La riga che
   cade esattamente sul lato più alto del poligono conta (la si legge un
   soffio sotto): un contorno appoggiato al bordo nord della griglia
   perdeva l'ultima fila di nodi, e lì l'acqua non arrivava al fianco */
function polygonRows(hf, poly, fn) {
  const c = hf.cell, nv = poly.length;
  if (nv < 3) return;
  let ylo = Infinity, yhi = -Infinity;
  for (const p of poly) { if (p[1] < ylo) ylo = p[1]; if (p[1] > yhi) yhi = p[1]; }
  const j0 = Math.max(0, Math.ceil((ylo - hf.y0) / c)), j1 = Math.min(hf.ny - 1, Math.floor((yhi - hf.y0) / c));
  const xs = [];
  for (let j = j0; j <= j1; j++) {
    const y = Math.min(hf.y0 + j * c, yhi - c * 1e-7);
    xs.length = 0;
    for (let a = 0, b = nv - 1; a < nv; b = a++) {
      const ya = poly[a][1], yb = poly[b][1];
      if ((ya > y) !== (yb > y)) xs.push(poly[a][0] + (y - ya) * (poly[b][0] - poly[a][0]) / (yb - ya));
    }
    xs.sort((p, q) => p - q);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const i0 = Math.max(0, Math.ceil((xs[s] - hf.x0) / c)), i1 = Math.min(hf.nx - 1, Math.floor((xs[s + 1] - hf.x0) / c));
      if (i0 <= i1) fn(j, i0, i1);
    }
  }
}

/** campo dell'acqua sulla griglia, per la scena: idx[k] = 1 + indice del
    contorno che contiene il nodo (l'ultimo vince), o del più vicino entro
    `reach` metri; prox[k] = 255 dentro, poi da 250 a 0 andando verso reach
    (la riva di sabbia sfuma lì). Distanza a smusso 1 / √2 (errore < 8 %). */
export function waterField(hf, polygons, reach = 0) {
  const n = hf.nx * hf.ny, idx = new Uint8Array(n), prox = new Uint8Array(n);
  let i0 = Infinity, i1 = -1, j0 = Infinity, j1 = -1;
  polygons.forEach((poly, b) => polygonRows(hf, poly, (j, a, z) => {
    idx.fill(b + 1, j * hf.nx + a, j * hf.nx + z + 1); prox.fill(255, j * hf.nx + a, j * hf.nx + z + 1);
    if (a < i0) i0 = a; if (z > i1) i1 = z; if (j < j0) j0 = j; if (j > j1) j1 = j;
  }));
  const R = reach / hf.cell;
  if (i1 < 0 || !(R > 0)) return { idx, prox };
  const g = Math.ceil(R);
  i0 = Math.max(0, i0 - g); i1 = Math.min(hf.nx - 1, i1 + g); j0 = Math.max(0, j0 - g); j1 = Math.min(hf.ny - 1, j1 + g);
  const W = i1 - i0 + 1, H = j1 - j0 + 1, D = new Float32Array(W * H).fill(Infinity), L = new Uint8Array(W * H), S2 = Math.SQRT2;
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = (j0 + j) * hf.nx + i0 + i;
    if (prox[k] === 255) { D[j * W + i] = 0; L[j * W + i] = idx[k]; }
  }
  const relax = (q, i, j, w) => { const p = j * W + i, d = D[p] + w; if (d < D[q]) { D[q] = d; L[q] = L[p]; } };
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const q = j * W + i;
    if (i > 0) relax(q, i - 1, j, 1);
    if (j > 0) { relax(q, i, j - 1, 1); if (i > 0) relax(q, i - 1, j - 1, S2); if (i < W - 1) relax(q, i + 1, j - 1, S2); }
  }
  for (let j = H - 1; j >= 0; j--) for (let i = W - 1; i >= 0; i--) {
    const q = j * W + i;
    if (i < W - 1) relax(q, i + 1, j, 1);
    if (j < H - 1) { relax(q, i, j + 1, 1); if (i < W - 1) relax(q, i + 1, j + 1, S2); if (i > 0) relax(q, i - 1, j + 1, S2); }
  }
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const q = j * W + i, k = (j0 + j) * hf.nx + i0 + i;
    if (prox[k] === 255 || !(D[q] < R)) continue;
    idx[k] = L[q]; prox[k] = Math.round(250 * (1 - D[q] / R));
  }
  return { idx, prox };
}

/** poligono tagliato sul rettangolo [x0, x1] × [y0, y1] (Sutherland–Hodgman):
    l'acqua disegnata oltre il bordo si ferma sul fianco del blocco */
export function clipPolygonToRect(poly, x0, y0, x1, y1) {
  let out = poly.map((p) => [p[0], p[1]]);
  const edges = [[0, x0, 1], [0, x1, -1], [1, y0, 1], [1, y1, -1]];       // [asse, valore, verso dell'interno]
  for (const [ax, v, s] of edges) {
    const inn = (p) => s * (p[ax] - v) >= 0, src = out;
    out = [];
    for (let a = 0; a < src.length; a++) {
      const P = src[a], Q = src[(a + 1) % src.length], pi = inn(P), qi = inn(Q);
      if (pi) out.push(P);
      if (pi !== qi) { const t = (v - P[ax]) / (Q[ax] - P[ax]); out.push([P[0] + t * (Q[0] - P[0]), P[1] + t * (Q[1] - P[1])]); }
    }
    if (out.length < 3) return [];
  }
  return out;
}

/** dove trabocca l'acqua di un contorno: la quota più bassa del terreno lungo
    i suoi lati (tagliati sulla griglia), esclusi i tratti sul bordo — lì
    l'acqua si appoggia al fianco del blocco e compare in sezione. L'acqua non
    sale oltre: senza questo limite un contorno che taglia un pendio colorava
    d'acqua il fondale a valle, «in discesa» (utente, 2026-10-03). Prudente:
    ogni punto del lato vale il nodo più basso della sua cella (nessuna
    interpolazione scende sotto), così sotto quella quota l'acqua non esce
    dal contorno. { z, x, y }; z = Infinity se il contorno sta tutto sul bordo */
export function waterSpill(hf, polygon) {
  const c = hf.cell, n = hf.nx, Z = hf.z, x1 = hf.x0 + (n - 1) * c, y1 = hf.y0 + (hf.ny - 1) * c, eps = c * 1e-6;
  const P = clipPolygonToRect(polygon, hf.x0, hf.y0, x1, y1);
  const on = (a, b, ax, v) => Math.abs(a[ax] - v) < eps && Math.abs(b[ax] - v) < eps;
  const cellMin = (x, y) => {
    const i = Math.min(Math.max(Math.floor((x - hf.x0) / c), 0), n - 2), j = Math.min(Math.max(Math.floor((y - hf.y0) / c), 0), hf.ny - 2), k = j * n + i;
    return Math.min(Z[k], Z[k + 1], Z[k + n], Z[k + n + 1]);
  };
  let best = { z: Infinity, x: NaN, y: NaN };
  for (let a = 0; a < P.length; a++) {
    const A = P[a], B = P[(a + 1) % P.length];
    if (on(A, B, 0, hf.x0) || on(A, B, 0, x1) || on(A, B, 1, hf.y0) || on(A, B, 1, y1)) continue;
    const m = Math.max(1, Math.ceil(Math.hypot(B[0] - A[0], B[1] - A[1]) / (c / 2)));
    for (let s = 0; s <= m; s++) {
      const x = A[0] + (B[0] - A[0]) * s / m, y = A[1] + (B[1] - A[1]) * s / m, z = cellMin(x, y);
      if (z < best.z) best = { z, x, y };
    }
  }
  return best;
}

/** superficie dell'acqua per l'export (.3dm): alla quota `level`, dove il
    terreno sta sotto ed è dentro il contorno. Le celle tutte bagnate si
    fondono in strisce per riga (è un piano: i giunti a T non si vedono), le
    celle della riva si tagliano sul pelo triangolo per triangolo (stessa
    diagonale della scena), con i vertici condivisi. Dove l'acqua arriva al
    bordo della griglia, la sezione verticale dal terreno al pelo, rivolta
    in fuori (come i fianchi del plastico nella scena).
    → { positions, triangles, area } (area della superficie in pianta, m²) */
export function waterMesh(hf, polygon, level) {
  const n = hf.nx, m = hf.ny, c = hf.cell, Z = hf.z;
  const inP = new Uint8Array(n * m);
  polygonRows(hf, polygon, (j, a, b) => inP.fill(1, j * n + a, j * n + b + 1));
  const P = [], T = [], ids = new Map();
  let area = 0;
  const vert = (key, x, y, z) => { let v = ids.get(key); if (v === undefined) { v = P.length / 3; ids.set(key, v); P.push(x, y, z); } return v; };
  const node = (k) => vert(k, hf.x0 + (k % n) * c, hf.y0 + Math.floor(k / n) * c, level);
  const cross = (a, b) => {                              // dove il terreno incontra il pelo sul lato a–b
    const t = (level - Z[a]) / (Z[b] - Z[a]), xa = hf.x0 + (a % n) * c, ya = hf.y0 + Math.floor(a / n) * c;
    return vert(Math.min(a, b) + "_" + Math.max(a, b), xa + t * ((b % n) - (a % n)) * c, ya + t * (Math.floor(b / n) - Math.floor(a / n)) * c, level);
  };
  /* a ventaglio; via i triangoli piatti (un nodo esattamente alla quota del pelo fa coincidere due tagli) */
  const fan = (vs, top) => {
    for (let s = 1; s + 1 < vs.length; s++) {
      const A = 3 * vs[0], B = 3 * vs[s], C = 3 * vs[s + 1];
      const ux = P[B] - P[A], uy = P[B + 1] - P[A + 1], uz = P[B + 2] - P[A + 2], vx = P[C] - P[A], vy = P[C + 1] - P[A + 1], vz = P[C + 2] - P[A + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      if (nx * nx + ny * ny + nz * nz < 1e-18 * c * c * c * c) continue;
      T.push(vs[0], vs[s], vs[s + 1]);
      if (top) area += Math.abs(nz) / 2;
    }
  };
  const wet = (k) => inP[k] && Z[k] < level;
  const clipTri = (a, b, cc) => {
    if (!inP[a] || !inP[b] || !inP[cc]) return;
    const ring = [a, b, cc], vs = [];
    for (let e = 0; e < 3; e++) {
      const p = ring[e], q = ring[(e + 1) % 3];
      if (Z[p] < level) vs.push(node(p));
      if ((Z[p] < level) !== (Z[q] < level)) vs.push(cross(p, q));
    }
    if (vs.length >= 3) fan(vs, true);
  };
  for (let j = 0; j < m - 1; j++) {
    let run = -1;
    const flush = (i1) => { const a = j * n + run, b = j * n + i1 + 1; fan([node(a), node(b), node(b + n), node(a + n)], true); run = -1; };
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i;
      if (wet(k) && wet(k + 1) && wet(k + n) && wet(k + n + 1)) { if (run < 0) run = i; continue; }
      if (run >= 0) flush(i - 1);
      if (wet(k) || wet(k + 1) || wet(k + n) || wet(k + n + 1)) { clipTri(k, k + 1, k + n + 1); clipTri(k, k + n + 1, k + n); }
    }
    if (run >= 0) flush(n - 2);
  }
  /* sezione sul bordo: i lati in giro antiorario visti dall'alto (guardando da fuori, da sinistra a destra) */
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(i);
  for (let j = 1; j < m; j++) ring.push(j * n + n - 1);
  for (let i = n - 2; i >= 0; i--) ring.push((m - 1) * n + i);
  for (let j = m - 2; j >= 1; j--) ring.push(j * n);                    // il giro si chiude sul nodo 0
  const ground =(k) => vert("g" + k, hf.x0 + (k % n) * c, hf.y0 + Math.floor(k / n) * c, Z[k]);
  for (let s = 0; s < ring.length; s++) {
    const a = ring[s], b = ring[(s + 1) % ring.length];
    if (!inP[a] || !inP[b] || (Z[a] >= level && Z[b] >= level)) continue;
    if (Z[a] < level && Z[b] < level) fan([ground(a), ground(b), node(b), node(a)], false);
    else if (Z[a] < level) fan([ground(a), cross(a, b), node(a)], false);
    else fan([cross(a, b), ground(b), node(b)], false);
  }
  return { positions: Float64Array.from(P), triangles: Uint32Array.from(T), area };
}

/** acqua alla quota z (dentro `polygon`, se c'è): area e quota del terreno
    coperto (pesi del trapezio come cutFill, i buchi della maschera non
    contano), profondità massima e volume d'acqua */
export function waterCover(hf, z, polygon = null) {
  const n = hf.nx, m = hf.ny, A = hf.cell * hf.cell, M = hf.mask, Z = hf.z;
  let area = 0, wet = 0, volume = 0, maxDepth = 0;
  const row = (j, a, b) => {
    const wj = (j === 0 || j === m - 1 ? 0.5 : 1) * A;
    for (let i = a; i <= b; i++) {
      const k = j * n + i;
      if (M && !M[k]) continue;
      const w = (i === 0 || i === n - 1 ? 0.5 : 1) * wj, d = z - Z[k];
      area += w;
      if (d > 0) { wet += w; volume += d * w; if (d > maxDepth) maxDepth = d; }
    }
  };
  if (polygon) polygonRows(hf, polygon, row);
  else for (let j = 0; j < m; j++) row(j, 0, n - 1);
  return { area: wet, share: area > 0 ? wet / area : 0, maxDepth, volume };
}

/* ======================================================================
   Semplificazione per Revit: TIN con un BUDGET di punti
   Revit 2024/2025 sottocampiona oltre 10.000 punti, Revit 2026 oltre 20.000
   (regolabile 10k–50k in Revit.ini). Meglio scegliere noi: Delatin aggiunge
   un punto alla volta dove l'errore è massimo, quindi i punti finiscono su
   cigli e piedi di scarpata, non sui piani. Delatin è Delaunay: Revit, che
   ritriangola i punti per conto suo, dovrebbe ritrovare gli stessi triangoli.
   maxError di default 1 mm, non 0: su un piano esatto l'errore in virgola
   mobile vale 1e-15 e con 0 Delatin riempirebbe la piattaforma fino al budget.
   Con la maschera: i buchi diventano NaN (Delatin li salta nel calcolo
   dell'errore, come nel tool contesto 3D), gli angoli tengono la quota
   riempita perché sono i primi vertici, e i punti nei buchi si tolgono.
   ====================================================================== */
export function simplifyToBudget(hf, Delatin, { maxPoints, maxError = 1e-3 }) {
  const M = hf.mask, n = hf.nx, m = hf.ny;
  let data = hf.z;
  if (M) {
    data = Float64Array.from(hf.z);
    for (let k = 0; k < data.length; k++) if (!M[k]) data[k] = NaN;
    for (const k of [0, n - 1, (m - 1) * n, m * n - 1]) data[k] = hf.z[k];
  }
  const tin = new Delatin(data, n, m);
  while (tin.coords.length / 2 < maxPoints && tin.getMaxError() > maxError) tin.refine();
  let coords = Int32Array.from(tin.coords), triangles = Int32Array.from(tin.triangles);
  if (M) {
    const keep = new Int32Array(coords.length / 2).fill(-1), C = [];
    for (let p = 0; p < keep.length; p++) if (M[coords[2 * p + 1] * n + coords[2 * p]]) { keep[p] = C.length / 2; C.push(coords[2 * p], coords[2 * p + 1]); }
    const Tr = [];
    for (let t = 0; t < triangles.length; t += 3) {
      const a = keep[triangles[t]], b = keep[triangles[t + 1]], c = keep[triangles[t + 2]];
      if (a >= 0 && b >= 0 && c >= 0) Tr.push(a, b, c);
    }
    coords = Int32Array.from(C); triangles = Int32Array.from(Tr);
  }
  return {
    coords,                                       // indici di griglia (i, j) a coppie
    triangles,
    maxError: tin.getMaxError(),
    rmsd: tin.getRMSD(),
    points: coords.length / 2,
  };
}

/* errore verticale massimo di un TIN (vertici sui nodi) rispetto alla griglia:
   misura indipendente da Delatin, per i test e per il resoconto. I nodi fuori
   dalla maschera (riempiti all'import) non contano: lì non c'è un dato vero. */
export function tinMaxError(hf, coords, triangles) {
  const n = hf.nx, z = hf.z, M = hf.mask;
  let worst = 0;
  for (let t = 0; t < triangles.length; t += 3) {
    const a = triangles[t], b = triangles[t + 1], cc = triangles[t + 2];
    const ax = coords[2 * a], ay = coords[2 * a + 1], bx = coords[2 * b], by = coords[2 * b + 1], cx = coords[2 * cc], cy = coords[2 * cc + 1];
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (den === 0) continue;
    const za = z[ay * n + ax], zb = z[by * n + bx], zc = z[cy * n + cx];
    for (let y = Math.min(ay, by, cy); y <= Math.max(ay, by, cy); y++)
      for (let x = Math.min(ax, bx, cx); x <= Math.max(ax, bx, cx); x++) {
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den;
        const l3 = 1 - l1 - l2;
        if (l1 < -1e-12 || l2 < -1e-12 || l3 < -1e-12 || (M && !M[y * n + x])) continue;
        const e = Math.abs(l1 * za + l2 * zb + l3 * zc - z[y * n + x]);
        if (e > worst) worst = e;
      }
  }
  return worst;
}

/* errore se un ALTRO Delaunay ritriangola gli stessi punti (come fa Revit):
   dove quattro punti stanno su un cerchio le due diagonali sono entrambe di
   Delaunay e la scelta è libera. Su un piano non cambia niente (piattaforme
   esatte comunque); su un terreno curvo e fitto di punti sì — misurato 0,07
   → 2,1 cm su una griglia quasi piena. Delaunator iniettato; i punti sono gli
   indici interi di griglia, così i casi ambigui restano ambigui come nel CSV. */
export function retriangulatedError(hf, coords, Delaunator) {
  const d = new Delaunator(Float64Array.from(coords));
  return tinMaxError(hf, coords, d.triangles);
}

/* ======================================================================
   TIN robusto per Revit: entro l'errore con QUALSIASI Delaunay
   Revit non legge i nostri triangoli: rifà un Delaunay dei punti. Sui punti
   di una griglia quattro punti stanno spesso ESATTAMENTE su un cerchio
   (basta un rettangolo) e lì entrambe le diagonali sono di Delaunay: chi
   triangola sceglie a modo suo. Misurato sull'esempio della fase 0, 10k
   punti: TIN di Delatin 1,4 cm, lo stesso insieme ritriangolato da
   Delaunator 14,5 cm — sul CIGLIO della piattaforma, 16 triangoli oltre i
   5 cm. Qui: si parte da Delatin (una parte del budget), si triangola con
   Delaunator e si cercano (a) i triangoli fuori tolleranza e (b) le
   quaterne sul cerchio la cui ALTRA diagonale sarebbe fuori tolleranza; in
   entrambi i casi si aggiunge il nodo peggiore, e si ripete. Il test del
   cerchio sugli indici interi di griglia è esatto in virgola mobile (i
   prodotti stanno sotto 2^53 fino a 4000 nodi per lato).
   Restituisce anche l'errore garantito per ogni scelta delle diagonali
   ambigue (a quattro punti: le quaterne con 5+ punti sul cerchio sono rare
   e si controllano un lato alla volta).
   NB: l'errore di Delatin NON scende in modo monotono col budget (misurato
   sull'esempio: 8.500 punti 0,80 cm, 10.000 punti 1,40 cm, 12.000 0,52 cm —
   un inserimento con i suoi scambi di diagonale può alzare il massimo). Per
   questo, tolte le ambiguità, il budget che resta si spende abbassando la
   tolleranza: ogni giro aggiunge i nodi peggiori dei triangoli fuori.
   ====================================================================== */
function incircle(C, a, b, c, d) {
  const ax = C[2 * a] - C[2 * d], ay = C[2 * a + 1] - C[2 * d + 1];
  const bx = C[2 * b] - C[2 * d], by = C[2 * b + 1] - C[2 * d + 1];
  const cx = C[2 * c] - C[2 * d], cy = C[2 * c + 1] - C[2 * d + 1];
  return (ax * ax + ay * ay) * (bx * cy - cx * by) - (bx * bx + by * by) * (ax * cy - cx * ay) + (cx * cx + cy * cy) * (ax * by - bx * ay);
}
/* errore massimo e nodo peggiore di un triangolo (vertici = indici in C) */
function triWorst(hf, C, a, b, c) {
  const n = hf.nx, z = hf.z, M = hf.mask;
  const ax = C[2 * a], ay = C[2 * a + 1], bx = C[2 * b], by = C[2 * b + 1], cx = C[2 * c], cy = C[2 * c + 1];
  const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (den === 0) return { e: 0, k: -1 };
  const za = z[ay * n + ax], zb = z[by * n + bx], zc = z[cy * n + cx];
  let e = 0, k = -1;
  for (let y = Math.min(ay, by, cy); y <= Math.max(ay, by, cy); y++)
    for (let x = Math.min(ax, bx, cx); x <= Math.max(ax, bx, cx); x++) {
      const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / den, l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / den, l3 = 1 - l1 - l2;
      if (l1 < -1e-12 || l2 < -1e-12 || l3 < -1e-12 || (M && !M[y * n + x])) continue;
      const v = Math.abs(l1 * za + l2 * zb + l3 * zc - z[y * n + x]);
      if (v > e) { e = v; k = y * n + x; }
    }
  return { e, k };
}
export function robustTIN(hf, Delatin, Delaunator, { maxPoints, maxError = 1e-3, share = 0.85, rounds = 14 } = {}) {
  const first = simplifyToBudget(hf, Delatin, { maxPoints: Math.max(4, Math.floor(maxPoints * share)), maxError });
  let tol = Math.max(first.maxError, maxError);
  const n = hf.nx;
  const C = Array.from(first.coords), have = new Set();
  for (let p = 0; p < C.length; p += 2) have.add(C[p + 1] * n + C[p]);
  let d = null, worst = 0, ambiguous = 0, round = 0;
  const scan = () => {
    d = new Delaunator(Float64Array.from(C));
    const Tr = d.triangles, H = d.halfedges, nt = Tr.length / 3, wantK = new Map();
    worst = 0; ambiguous = 0;
    const want = (k, e) => { if (k >= 0 && !have.has(k) && e > (wantK.get(k) || 0)) wantK.set(k, e); };
    for (let t = 0; t < nt; t++) {
      const w = triWorst(hf, C, Tr[3 * t], Tr[3 * t + 1], Tr[3 * t + 2]);
      if (w.e > worst) worst = w.e;
      if (w.e > tol) want(w.k, w.e);
    }
    for (let e = 0; e < H.length; e++) {
      const f = H[e];
      if (f < e) continue;                                   // lato interno, una volta sola (f = -1 = bordo)
      const a = Tr[e], b = Tr[e % 3 === 2 ? e - 2 : e + 1];
      const c = Tr[e % 3 === 0 ? e + 2 : e - 1], dd = Tr[f % 3 === 0 ? f + 2 : f - 1];
      if (incircle(C, a, b, c, dd) !== 0) continue;           // diagonale unica: Revit trova la stessa
      ambiguous++;
      const w1 = triWorst(hf, C, c, a, dd), w2 = triWorst(hf, C, c, dd, b);   // l'altra diagonale c–d
      const w = w1.e >= w2.e ? w1 : w2;
      if (w.e > worst) worst = w.e;
      if (w.e > tol) want(w.k, w.e);
    }
    return wantK;
  };
  /* i punti si aggiungono solo in coda: lo stato migliore visto è un prefisso */
  let best = null;
  const keep = () => { if (!best || worst < best.worst) best = { worst, len: C.length, tri: Uint32Array.from(d.triangles), ambiguous }; };
  let dirty = true;
  for (; round < rounds; round++) {
    let wantK = scan();
    keep();
    const room = maxPoints - C.length / 2;
    dirty = false;
    if (room <= 0) break;
    if (!wantK.size) {
      if (worst <= maxError) break;                          // già alla tolleranza minima
      tol = Math.max(maxError, worst * 0.7);                  // budget avanzato: si stringe
      wantK = scan();
      if (!wantK.size) break;
    }
    /* a piccoli passi: inserire tanti punti insieme rimescola le diagonali */
    const add = [...wantK].sort((p, q) => q[1] - p[1]).slice(0, Math.min(room, Math.max(16, Math.ceil(C.length / 2 * 0.04))));
    for (const [k] of add) { have.add(k); C.push(k % n, (k - k % n) / n); }
    dirty = true;
  }
  if (dirty) { scan(); keep(); }
  return {
    coords: Int32Array.from(C.slice(0, best.len)), triangles: best.tri, points: best.len / 2,
    maxError: best.worst,            // con QUALSIASI scelta delle diagonali ambigue (a quattro punti)
    delatinError: first.maxError, ambiguous: best.ambiguous, rounds: round,
  };
}

/* ======================================================================
   Curve di livello (marching squares + concatenamento in polilinee)
   Un nodo è "sopra" se z ≥ quota; le selle si risolvono con la media della cella.
   Le celle con un nodo fuori dalla maschera non danno curve.
   ====================================================================== */
const MS = [
  [], [[3, 0]], [[0, 1]], [[3, 1]], [[1, 2]], null, [[0, 2]], [[3, 2]],
  [[2, 3]], [[0, 2]], null, [[1, 2]], [[3, 1]], [[0, 1]], [[3, 0]], [],
];

export function contourLines(hf, { interval, levels } = {}) {
  const n = hf.nx, m = hf.ny, z = hf.z, c = hf.cell, M = hf.mask;
  if (!levels) {
    const { min, max } = heightRange(hf);
    levels = [];
    for (let L = Math.ceil(min / interval) * interval; L <= max; L += interval) levels.push(Math.round(L * 1e6) / 1e6);
  }
  const out = [];
  for (const L of levels) {
    const pos = new Map();            // id spigolo → [x, y]
    const adj = new Map();            // id spigolo → segmenti che lo toccano
    const segs = [];
    const edgePoint = (id) => {
      if (pos.has(id)) return;
      const k = id >> 1, i = k % n, j = (k - i) / n;
      const k2 = (id & 1) ? k + n : k + 1;
      const t = (L - z[k]) / (z[k2] - z[k]);
      pos.set(id, (id & 1)
        ? [hf.x0 + i * c, hf.y0 + (j + t) * c]
        : [hf.x0 + (i + t) * c, hf.y0 + j * c]);
    };
    for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
      const ka = j * n + i, kb = ka + 1, kc = ka + n + 1, kd = ka + n;
      if (M && !(M[ka] && M[kb] && M[kc] && M[kd])) continue;
      const idx = (z[ka] >= L) | (z[kb] >= L) << 1 | (z[kc] >= L) << 2 | (z[kd] >= L) << 3;
      if (idx === 0 || idx === 15) continue;
      const E = [2 * ka, 2 * kb + 1, 2 * kd, 2 * ka + 1];   // basso, destra, alto, sinistra
      let pairs = MS[idx];
      if (!pairs) {
        const up = (z[ka] + z[kb] + z[kc] + z[kd]) / 4 >= L;
        pairs = (idx === 5) === up ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]];
      }
      for (const [p, q] of pairs) {
        const s = segs.length, ea = E[p], eb = E[q];
        segs.push([ea, eb]);
        edgePoint(ea); edgePoint(eb);
        (adj.get(ea) || adj.set(ea, []).get(ea)).push(s);
        (adj.get(eb) || adj.set(eb, []).get(eb)).push(s);
      }
    }
    const used = new Uint8Array(segs.length);
    const walk = (s0, from) => {
      const ids = [from];
      let s = s0, cur = from;
      while (s !== undefined && !used[s]) {
        used[s] = 1;
        const nxt = segs[s][0] === cur ? segs[s][1] : segs[s][0];
        ids.push(nxt);
        cur = nxt;
        s = adj.get(cur).find(q => !used[q]);
      }
      return ids;
    };
    const emit = (ids) => {
      const pts = [];
      for (const id of ids) {
        const p = pos.get(id), q = pts[pts.length - 1];
        if (!q || q[0] !== p[0] || q[1] !== p[1]) pts.push(p);
      }
      const closed = ids.length > 2 && ids[0] === ids[ids.length - 1];
      if (pts.length >= 2) out.push({ z: L, closed, pts });
    };
    for (const [id, list] of adj) if (list.length === 1 && !used[list[0]]) emit(walk(list[0], id));
    for (let s = 0; s < segs.length; s++) if (!used[s]) emit(walk(s, segs[s][0]));
  }
  return out;
}

/* ======================================================================
   Superficie NURBS dalla griglia (per Rhino)
   Cubica, nodi uniformi con estremi bloccati (convenzione openNURBS: n+2
   nodi, senza i nodi superflui). I punti di controllo stanno sulle ascisse di
   Greville: così x(u) e y(v) sono ESATTAMENTE lineari (niente distorsione
   in pianta). Con le quote prese tali e quali la superficie non oscilla ma
   smussa gli spigoli vivi (ciglio ≈ salto di pendenza · passo / 6); `refine`
   giri di PIA (progressive iterative approximation: ogni giro aggiunge lo
   scarto griglia − superficie sulle ascisse di Greville) lo recuperano.
   Misurato sul terreno della fase 0 (spigolo di piattaforma con scarpate 2:3):
   passo 1 m → 20 cm e non scende sotto i 12 cm a nessun giro (manca
   risoluzione); passo = griglia + 4 giri → 1,2 cm, piano piatto al decimo di
   mm. Da qui i default. Lo scarto vero lo misura nurbsDeviation.
   ====================================================================== */
function onKnots(cvCount) {
  const k = new Float64Array(cvCount + 2);
  for (let i = 0; i < k.length; i++) k[i] = Math.min(Math.max(i - 2, 0), cvCount - 3);
  return k;
}
/* openNURBS → vettore nodi standard (aggiunge i due nodi superflui) */
const stdKnots = (k) => Float64Array.from([k[0], ...k, k[k.length - 1]]);
const greville = (k, i) => (k[i] + k[i + 1] + k[i + 2]) / 3;

/* passo della superficie: quello della griglia finché i punti di controllo
   restano entro maxCV (un milione = 32 MB di superficie nel .3dm), poi un
   multiplo intero del passo */
export function nurbsStep(hf, maxCV = 1000000) {
  const Lx = (hf.nx - 1) * hf.cell, Ly = (hf.ny - 1) * hf.cell;
  for (let f = 1; ; f++) {
    const step = hf.cell * f;
    if ((Math.max(1, Math.round(Lx / step)) + 3) * (Math.max(1, Math.round(Ly / step)) + 3) <= maxCV) return step;
  }
}

export function nurbsFromHeightfield(hf, { step = hf.cell, refine = 4 } = {}) {
  const Lx = (hf.nx - 1) * hf.cell, Ly = (hf.ny - 1) * hf.cell;
  const su = Math.max(1, Math.round(Lx / step)), sv = Math.max(1, Math.round(Ly / step));
  const nu = su + 3, nv = sv + 3, ku = onKnots(nu), kv = onKnots(nv);
  const cv = new Float64Array(nu * nv * 3);
  for (let b = 0; b < nv; b++) for (let a = 0; a < nu; a++) {
    const x = hf.x0 + Lx * greville(ku, a) / su, y = hf.y0 + Ly * greville(kv, b) / sv;
    const o = (b * nu + a) * 3;
    cv[o] = x; cv[o + 1] = y; cv[o + 2] = sampleHeight(hf, x, y);
  }
  if (refine > 0) {
    /* superficie sulle ascisse di Greville = Bu · C · Bvᵀ, con Bu e Bv a bande
       (4 funzioni di base per riga): si calcola per direzioni separate */
    const su0 = stdKnots(ku), sv0 = stdKnots(kv);
    const Bu = Array.from({ length: nu }, (_, a) => basis(su0, greville(ku, a)));
    const Bv = Array.from({ length: nv }, (_, b) => basis(sv0, greville(kv, b)));
    const target = new Float64Array(nu * nv), tmp = new Float64Array(nu * nv);
    for (let k = 0; k < nu * nv; k++) target[k] = cv[3 * k + 2];
    for (let it = 0; it < refine; it++) {
      for (let b = 0; b < nv; b++) for (let a = 0; a < nu; a++) {
        const r = Bu[a], o = b * nu + r.first;
        tmp[b * nu + a] = r.N[0] * cv[3 * o + 2] + r.N[1] * cv[3 * o + 5] + r.N[2] * cv[3 * o + 8] + r.N[3] * cv[3 * o + 11];
      }
      for (let b = 0; b < nv; b++) for (let a = 0; a < nu; a++) {
        const r = Bv[b], o = r.first * nu + a;
        const s = r.N[0] * tmp[o] + r.N[1] * tmp[o + nu] + r.N[2] * tmp[o + 2 * nu] + r.N[3] * tmp[o + 3 * nu];
        cv[3 * (b * nu + a) + 2] += target[b * nu + a] - s;
      }
    }
  }
  return { degree: 3, nu, nv, knotsU: ku, knotsV: kv, cv, spansU: su, spansV: sv, Lx, Ly, x0: hf.x0, y0: hf.y0 };
}

/* funzioni di base cubiche (Piegl-Tiller A2.2) sul vettore nodi "standard" */
function basis(K, u) {
  const p = 3, nC = K.length - p - 1;          // K standard: nC + p + 1 nodi
  let s;
  if (u >= K[nC]) s = nC - 1;
  else { s = p; while (u >= K[s + 1]) s++; }
  const N = [1, 0, 0, 0], left = [0, 0, 0, 0], right = [0, 0, 0, 0];
  for (let j = 1; j <= p; j++) {
    left[j] = u - K[s + 1 - j]; right[j] = K[s + j] - u;
    let saved = 0;
    for (let r = 0; r < j; r++) {
      const tmp = N[r] / (right[r + 1] + left[j - r]);
      N[r] = saved + right[r + 1] * tmp;
      saved = left[j - r] * tmp;
    }
    N[j] = saved;
  }
  return { first: s - p, N };
}

export function nurbsEval(nb, u, v) {
  const stdU = nb._stdU || (nb._stdU = stdKnots(nb.knotsU));
  const stdV = nb._stdV || (nb._stdV = stdKnots(nb.knotsV));
  const bu = basis(stdU, u), bv = basis(stdV, v);
  const P = [0, 0, 0];
  for (let b = 0; b < 4; b++) for (let a = 0; a < 4; a++) {
    const w = bu.N[a] * bv.N[b], o = ((bv.first + b) * nb.nu + bu.first + a) * 3;
    P[0] += w * nb.cv[o]; P[1] += w * nb.cv[o + 1]; P[2] += w * nb.cv[o + 2];
  }
  return P;
}

/* scarto superficie − griglia su tutti i nodi (e verifica la pianta lineare) */
export function nurbsDeviation(nb, hf) {
  let maxDz = 0, sum2 = 0, maxDxy = 0, cnt = 0;
  for (let j = 0; j < hf.ny; j++) for (let i = 0; i < hf.nx; i++) {
    const x = i * hf.cell, y = j * hf.cell;
    const P = nurbsEval(nb, x / nb.Lx * nb.spansU, y / nb.Ly * nb.spansV);
    const dz = P[2] - hf.z[j * hf.nx + i];
    maxDz = Math.max(maxDz, Math.abs(dz)); sum2 += dz * dz; cnt++;
    maxDxy = Math.max(maxDxy, Math.hypot(P[0] - hf.x0 - x, P[1] - hf.y0 - y));
  }
  return { maxDz, rmsDz: Math.sqrt(sum2 / cnt), maxDxy };
}

/* ======================================================================
   Volume chiuso: superficie + pareti sul perimetro + fondo piano a baseZ.
   Mesh a tenuta (ogni spigolo in due facce, orientate in fuori).
   ====================================================================== */
export function closedVolume(hf, baseZ) {
  const n = hf.nx, m = hf.ny, N = n * m, c = hf.cell;
  const ring = [];
  for (let i = 0; i < n; i++) ring.push(i);                       // sud, verso est
  for (let j = 1; j < m; j++) ring.push(j * n + n - 1);           // est, verso nord
  for (let i = n - 2; i >= 0; i--) ring.push((m - 1) * n + i);    // nord, verso ovest
  for (let j = m - 2; j >= 1; j--) ring.push(j * n);              // ovest, verso sud
  const M = ring.length;
  const P = new Float64Array((N + M + 1) * 3);
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i;
    P[3 * k] = hf.x0 + i * c; P[3 * k + 1] = hf.y0 + j * c; P[3 * k + 2] = hf.z[k];
  }
  for (let r = 0; r < M; r++) {
    const o = 3 * (N + r), s = 3 * ring[r];
    P[o] = P[s]; P[o + 1] = P[s + 1]; P[o + 2] = baseZ;
  }
  const C = N + M;
  P[3 * C] = hf.x0 + (n - 1) * c / 2; P[3 * C + 1] = hf.y0 + (m - 1) * c / 2; P[3 * C + 2] = baseZ;
  const T = new Int32Array((n - 1) * (m - 1) * 6 + M * 9);
  let o = 0;
  for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i, b = a + 1, cc = a + n + 1, d = a + n;
    T[o++] = a; T[o++] = b; T[o++] = cc; T[o++] = a; T[o++] = cc; T[o++] = d;
  }
  for (let r = 0; r < M; r++) {
    const a = ring[r], b = ring[(r + 1) % M], a2 = N + r, b2 = N + (r + 1) % M;
    T[o++] = a; T[o++] = a2; T[o++] = b2; T[o++] = a; T[o++] = b2; T[o++] = b;
    T[o++] = C; T[o++] = b2; T[o++] = a2;
  }
  return { positions: P, triangles: T };
}

/* ======================================================================
   Mesh e volume dal TIN di Delatin (per il .3dm)
   Scrivere una mesh nel .3dm costa ~11 µs a vertice dentro openNURBS
   (misurato: la griglia della fase 0, 120k vertici, 1,4 s; a quad 3,9 s —
   era QUESTO il collo di bottiglia della fase 0, non le chiamate wasm). A
   4 M nodi la griglia piena vorrebbe ~45 s: il TIN adattivo dà la stessa
   superficie entro l'errore dichiarato con una frazione dei punti.
   tinMesh: triangoli antiorari visti dall'alto (normali in su), UV 0..1
   sull'estensione della griglia come la mesh a griglia (texture uguali).
   closedVolumeTIN: TIN su TUTTO il rettangolo (senza maschera) + pareti sul
   perimetro + fondo: il perimetro del TIN di Delatin sono i suoi vertici
   di bordo in fila. Rifatto dopo le prove in Rhino dell'utente
   (2026-10-04): la prima versione condivideva i vertici fra superficie,
   pareti e fondo (Rhino media le normali sullo spigolo a 90°: la parete
   si sfumava a fasce), spezzava ogni tratto di parete in due triangoli e
   faceva il fondo a ventaglio dal centro. Ora: vertici propri per
   superficie, ogni lato e fondo (spigoli vivi); pareti a QUADRILATERI
   verticali, uno per tratto di bordo (niente diagonali); fondo a griglia
   regolare di quadrilateri, raccordata ai vertici di bordo da una fascia
   di triangoli lungo il perimetro. A tenuta per posizione (Rhino unisce i
   vertici coincidenti nella topologia: isClosed resta vero).
   ====================================================================== */
export function tinMesh(hf, tin) {
  const N = tin.points, n = hf.nx, m = hf.ny, P = new Float64Array(N * 3), uv = new Float32Array(N * 2);
  for (let p = 0; p < N; p++) {
    const i = tin.coords[2 * p], j = tin.coords[2 * p + 1];
    P[3 * p] = hf.x0 + i * hf.cell; P[3 * p + 1] = hf.y0 + j * hf.cell; P[3 * p + 2] = hf.z[j * n + i];
    uv[2 * p] = i / (n - 1); uv[2 * p + 1] = j / (m - 1);
  }
  const T = Uint32Array.from(tin.triangles), C = tin.coords;
  for (let t = 0; t < T.length; t += 3) {
    const a = T[t], b = T[t + 1], c = T[t + 2];
    const cross = (C[2 * b] - C[2 * a]) * (C[2 * c + 1] - C[2 * a + 1]) - (C[2 * b + 1] - C[2 * a + 1]) * (C[2 * c] - C[2 * a]);
    if (cross < 0) { T[t + 1] = c; T[t + 2] = b; }
  }
  return { positions: P, triangles: T, uv };
}

/* → { positions, triangles, quads } (quads a quattro indici, come i triangoli
   antiorari visti da fuori) */
export function closedVolumeTIN(hf, tin, baseZ) {
  const n = hf.nx, m = hf.ny, top = tinMesh(hf, tin), N = tin.points, C = tin.coords, TP = top.positions;
  const S0 = n - 1, S1 = S0 + m - 1, S2 = S1 + n - 1;            // spigoli sul perimetro, in passi di griglia
  const border = [];
  for (let p = 0; p < N; p++) {
    const i = C[2 * p], j = C[2 * p + 1];
    let s = -1;
    if (j === 0) s = i;                                        // sud, verso est
    else if (i === n - 1) s = (n - 1) + j;                     // est, verso nord
    else if (j === m - 1) s = 2 * (n - 1) + (m - 1) - i;       // nord, verso ovest
    else if (i === 0) s = 2 * (n - 1) + 2 * (m - 1) - j;       // ovest, verso sud
    if (s >= 0) border.push([s, p]);
  }
  border.sort((a, b) => a[0] - b[0]);
  if (!border.length || border[0][0] !== 0) throw new Error("TIN senza lo spigolo sud-ovest");
  /* i quattro lati, da spigolo a spigolo compresi (il TIN di Delatin parte dai quattro spigoli) */
  const sides = [[], [], [], []], cut = [0, S0, S1, S2, S2 + m - 1];
  for (const [s, p] of border) for (let q = 0; q < 4; q++) if (s >= cut[q] && s <= cut[q + 1]) sides[q].push(p);
  sides[3].push(border[0][1]);                                 // il lato ovest finisce sullo spigolo sud-ovest
  const P = Array.from(TP), tris = Array.from(top.triangles), quads = [];
  const add = (x, y, z) => { P.push(x, y, z); return P.length / 3 - 1; };
  /* pareti: vertici propri per lato, un quadrilatero verticale per tratto (in alto la quota del bordo, in basso baseZ) */
  for (const ch of sides) {
    const t = ch.map((p) => add(TP[3 * p], TP[3 * p + 1], TP[3 * p + 2])), b = ch.map((p) => add(TP[3 * p], TP[3 * p + 1], baseZ));
    for (let k = 0; k + 1 < ch.length; k++) quads.push(t[k], b[k], b[k + 1], t[k + 1]);
  }
  /* fondo: griglia regolare (passo tondo, ~32 campate sul lato lungo) senza la cornice esterna, che è una fascia di
     triangoli fra i vertici di bordo e il bordo della griglia — a cerniera, lato per lato, per frazione lungo il lato */
  const W = (n - 1) * hf.cell, H = (m - 1) * hf.cell, x0 = hf.x0, y0 = hf.y0;
  const e = 10 ** Math.floor(Math.log10(Math.max(W, H) / 32)), sb = [1, 2, 5, 10].map((f) => f * e).find((v) => v >= Math.max(W, H) / 32 - 1e-9);
  const gx = Math.max(3, Math.round(W / sb)), gy = Math.max(3, Math.round(H / sb)), G = new Int32Array((gx + 1) * (gy + 1));
  for (let j = 1; j < gy; j++) for (let i = 1; i < gx; i++) G[j * (gx + 1) + i] = add(x0 + W * i / gx, y0 + H * j / gy, baseZ);
  const g = (i, j) => G[j * (gx + 1) + i];
  for (let j = 1; j < gy - 1; j++) for (let i = 1; i < gx - 1; i++) quads.push(g(i, j), g(i, j + 1), g(i + 1, j + 1), g(i + 1, j));   // in giù
  const ob = new Map();                                        // vertici di bordo del fondo (propri, a baseZ), condivisi fra due lati agli spigoli
  const obOf = (p) => { if (!ob.has(p)) ob.set(p, add(TP[3 * p], TP[3 * p + 1], baseZ)); return ob.get(p); };
  const inner = [
    Array.from({ length: gx - 1 }, (_, k) => g(1 + k, 1)), Array.from({ length: gy - 1 }, (_, k) => g(gx - 1, 1 + k)),
    Array.from({ length: gx - 1 }, (_, k) => g(gx - 1 - k, gy - 1)), Array.from({ length: gy - 1 }, (_, k) => g(1, gy - 1 - k)),
  ];
  const along = [(x, y) => (x - x0) / W, (x, y) => (y - y0) / H, (x, y) => (x0 + W - x) / W, (x, y) => (y0 + H - y) / H];
  sides.forEach((ch, q) => {
    const O = ch.map(obOf), I = inner[q], tO = ch.map((p) => along[q](TP[3 * p], TP[3 * p + 1])), nO = O.length - 1, nI = I.length - 1;
    let i = 0, j = 0;
    while (i < nO || j < nI) {
      if (j === nI || (i < nO && tO[i + 1] <= (j + 1) / nI)) { tris.push(O[i], I[j], O[i + 1]); i++; }
      else { tris.push(O[i], I[j], I[j + 1]); j++; }
    }
  });
  return { positions: Float64Array.from(P), triangles: Uint32Array.from(tris), quads: Uint32Array.from(quads) };
}

/* volume racchiuso da una mesh a tenuta orientata in fuori (i quadrilateri, se ci sono, in due triangoli) */
export function meshVolume(P, T, Q = null) {
  let v = 0;
  const tri = (a, b, c) => {
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  };
  for (let t = 0; t < T.length; t += 3) tri(3 * T[t], 3 * T[t + 1], 3 * T[t + 2]);
  if (Q) for (let q = 0; q < Q.length; q += 4) { tri(3 * Q[q], 3 * Q[q + 1], 3 * Q[q + 2]); tri(3 * Q[q], 3 * Q[q + 2], 3 * Q[q + 3]); }
  return v / 6;
}

/* ======================================================================
   Esportazioni
   exportFrame: la stessa griglia vista da un'origine locale (stessi array,
   x0/y0 spostati). Revit legge i punti del CSV rispetto alla sua ORIGINE
   INTERNA e non regge geometria a decine di km da lì: le coordinate UTM
   (milioni di metri) non vanno scritte così come sono. La fase 1 esporta
   attorno a un'origine dichiarata; la trasformazione nel sistema del
   progetto (IFC di supporto, tool contesto 3D) passerà da qui.
   ====================================================================== */
export function exportFrame(hf, origin = { x: 0, y: 0 }) {
  return { ...hf, x0: hf.x0 - origin.x, y0: hf.y0 - origin.y };
}

const fx = (v, d) => v.toFixed(d);

/* Revit — Toposolid › Crea da importazione › Specifica file di punti:
   CSV con x,y,z per riga, nessuna intestazione. */
export function toPointsCSV(hf, coords, { decimals = 3 } = {}) {
  const lines = [];
  for (let p = 0; p < coords.length; p += 2) {
    const i = coords[p], j = coords[p + 1];
    lines.push(`${fx(hf.x0 + i * hf.cell, decimals)},${fx(hf.y0 + j * hf.cell, decimals)},${fx(hf.z[j * hf.nx + i], decimals)}`);
  }
  return lines.join("\r\n") + "\r\n";
}

/* nodi usati dalle celle valide (tutti e 4 gli angoli nella maschera):
   numerazione compatta 1-based, 0 = nodo che non entra nella mesh */
function meshNumbering(hf) {
  const n = hf.nx, m = hf.ny, M = hf.mask;
  if (!M) return null;
  const id = new Int32Array(n * m);
  for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
    const a = j * n + i;
    if (M[a] && M[a + 1] && M[a + n] && M[a + n + 1]) id[a] = id[a + 1] = id[a + n] = id[a + n + 1] = 1;
  }
  let c = 0;
  for (let k = 0; k < id.length; k++) if (id[k]) id[k] = ++c;
  return id;
}

/* OBJ a quadrilateri con coordinate UV 0..1 (servono alle texture), Z in alto.
   A pezzi (per il Blob): a 4 M nodi una stringa unica supererebbe i 512 MiB. */
export function toOBJParts(hf, { name = "terreno", decimals = 4, chunk = 20000 } = {}) {
  const n = hf.nx, m = hf.ny, c = hf.cell, id = meshNumbering(hf);
  const parts = [];
  let buf = [`# ${name} — ${n}×${m} nodi, passo ${c} m, Z in alto, metri`, `o ${name}`];
  const push = (s) => { buf.push(s); if (buf.length >= chunk) { parts.push(buf.join("\n") + "\n"); buf = []; } };
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++)
    if (!id || id[j * n + i]) push(`v ${fx(hf.x0 + i * c, decimals)} ${fx(hf.y0 + j * c, decimals)} ${fx(hf.z[j * n + i], decimals)}`);
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++)
    if (!id || id[j * n + i]) push(`vt ${fx(i / (n - 1), 6)} ${fx(j / (m - 1), 6)}`);
  for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
    const k = j * n + i;
    const a = id ? id[k] : k + 1, b = id ? id[k + 1] : a + 1, cc = id ? id[k + n + 1] : a + n + 1, d = id ? id[k + n] : a + n;
    if (id && !(hf.mask[k] && hf.mask[k + 1] && hf.mask[k + n] && hf.mask[k + n + 1])) continue;
    push(`f ${a}/${a} ${b}/${b} ${cc}/${cc} ${d}/${d}`);
  }
  if (buf.length) parts.push(buf.join("\n") + "\n");
  return parts;
}
export function toOBJ(hf, opts) { return toOBJParts(hf, opts).join(""); }

/* ======================================================================
   .3dm nativo (Rhino) via rhino3dm iniettato
   parts: { mesh: hf, nurbs, contours: {minor, major}, volume, points,
            water: [{ positions, triangles, name }] (waterMesh, uno per specchio d'acqua) }
   Ogni parte va sul suo layer; version 7 = si apre in Rhino 7 e 8.
   Mesh e volume passano IN BLOCCO da Mesh.createFromThreejsJSON: aggiunti un
   vertice e una faccia alla volta costavano 4,2 s ciascuno sul terreno della
   fase 0 (centinaia di migliaia di chiamate wasm), in blocco 0,1 s. Quella
   funzione parla three.js (Y in alto) e ruota gli assi: Rhino (X, Y, Z)
   va passato come (X, Z, −Y).
   ====================================================================== */
const LAYER_NAMES = {
  nurbs: "Terreno - superficie NURBS", mesh: "Terreno - mesh", volume: "Volume chiuso",
  minor: "Curve di livello", major: "Curve di livello maestre", points: "Punti Revit", water: "Acqua",
  nurbsObj: "Terreno NURBS", meshObj: "Terreno mesh", volumeObj: "Volume terreno", level: "quota",
};

function bulkMesh(rhino, P, T, uv) {
  const N = P.length / 3, pos = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) { pos[3 * k] = P[3 * k]; pos[3 * k + 1] = P[3 * k + 2]; pos[3 * k + 2] = -P[3 * k + 1]; }
  const attributes = { position: { itemSize: 3, type: "Float32Array", array: pos } };
  if (uv) attributes.uv = { itemSize: 2, type: "Float32Array", array: uv };
  if (typeof rhino.Mesh.createFromThreejsJSON === "function")
    return rhino.Mesh.createFromThreejsJSON({ data: { attributes, index: { array: T instanceof Uint32Array ? T : Uint32Array.from(T) } } });
  const me = new rhino.Mesh(), V = me.vertices(), F = me.faces();     // ripiego (lento) per le versioni senza
  for (let k = 0; k < N; k++) V.add(P[3 * k], P[3 * k + 1], P[3 * k + 2]);
  if (uv && typeof me.textureCoordinates === "function") { const tc = me.textureCoordinates(); for (let k = 0; k < N; k++) tc.add(uv[2 * k], uv[2 * k + 1]); }
  for (let t = 0; t < T.length; t += 3) F.addTriFace(T[t], T[t + 1], T[t + 2]);
  return me;
}

/* la griglia come triangoli (due per cella valida), con UV 0..1 sull'estensione */
export function gridTriangles(hf) {
  const n = hf.nx, m = hf.ny, c = hf.cell, id = meshNumbering(hf);
  const N = id ? id.reduce((a, b) => (b > a ? b : a), 0) : n * m;
  const P = new Float64Array(N * 3), uv = new Float32Array(N * 2);
  for (let j = 0; j < m; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i, v = id ? id[k] - 1 : k;
    if (v < 0) continue;
    P[3 * v] = hf.x0 + i * c; P[3 * v + 1] = hf.y0 + j * c; P[3 * v + 2] = hf.z[k];
    uv[2 * v] = i / (n - 1); uv[2 * v + 1] = j / (m - 1);
  }
  const T = [];
  for (let j = 0; j < m - 1; j++) for (let i = 0; i < n - 1; i++) {
    const k = j * n + i;
    if (id && !(hf.mask[k] && hf.mask[k + 1] && hf.mask[k + n] && hf.mask[k + n + 1])) continue;
    const a = id ? id[k] - 1 : k, b = id ? id[k + 1] - 1 : k + 1, cc = id ? id[k + n + 1] - 1 : k + n + 1, d = id ? id[k + n] - 1 : k + n;
    T.push(a, b, cc, a, cc, d);
  }
  return { positions: P, triangles: Uint32Array.from(T), uv };
}

export function build3dm(rhino, parts, { version = 7, names = {} } = {}) {
  const N = { ...LAYER_NAMES, ...names };
  const doc = new rhino.File3dm();
  doc.settings().modelUnitSystem = rhino.UnitSystem.Meters;
  const layer = (name, rgb, visible = true) => {
    const l = new rhino.Layer();
    l.name = name; l.color = { r: rgb[0], g: rgb[1], b: rgb[2], a: 255 }; l.visible = visible;
    return doc.layers().add(l);
  };
  const attr = (li, name) => { const a = new rhino.ObjectAttributes(); a.layerIndex = li; if (name) a.name = name; return a; };
  const report = {};

  if (parts.nurbs) {
    const nb = parts.nurbs, li = layer(parts.nurbs.layer || N.nurbs, [96, 140, 60]);
    const s = rhino.NurbsSurface.create(3, false, 4, 4, nb.nu, nb.nv);
    const ku = s.knotsU(), kv = s.knotsV();
    for (let i = 0; i < nb.knotsU.length; i++) ku.set(i, nb.knotsU[i]);
    for (let i = 0; i < nb.knotsV.length; i++) kv.set(i, nb.knotsV[i]);
    const pts = s.points();
    for (let b = 0; b < nb.nv; b++) for (let a = 0; a < nb.nu; a++) {
      const o = (b * nb.nu + a) * 3;
      pts.set(a, b, [nb.cv[o], nb.cv[o + 1], nb.cv[o + 2], 1]);
    }
    report.nurbsValid = s.isValid;
    doc.objects().addSurface(s, attr(li, N.nurbsObj));
  }
  if (parts.mesh) {
    const li = layer(N.mesh, [150, 160, 120], false);
    const g = parts.mesh.positions ? parts.mesh : gridTriangles(parts.mesh);      // mesh pronta (TIN) o griglia
    const me = bulkMesh(rhino, g.positions, g.triangles, g.uv);
    me.normals().computeNormals(); me.compact();
    report.meshValid = me.isValid; report.meshUV = me.textureCoordinates().count === me.vertices().count;
    doc.objects().addMesh(me, attr(li, N.meshObj));
  }
  if (parts.volume) {
    /* i triangoli in blocco, poi i quadrilateri (pareti e fondo di closedVolumeTIN: poche migliaia, uno alla volta);
       compact solo dopo, perché i vertici dei quadrilateri sono già nel blocco */
    const { positions: P, triangles: T, quads: Q } = parts.volume, li = layer(N.volume, [54, 54, 55], false);      // l'antracite dei fianchi del plastico
    const me = bulkMesh(rhino, P, T, null);
    if (Q) { const F = me.faces(); for (let q = 0; q < Q.length; q += 4) F.addQuadFace(Q[q], Q[q + 1], Q[q + 2], Q[q + 3]); }
    me.normals().computeNormals(); me.compact();
    report.volumeClosed = me.isClosed;
    doc.objects().addMesh(me, attr(li, N.volumeObj));
  }
  if (parts.contours) {
    for (const [key, rgb] of [["minor", [120, 110, 90]], ["major", [70, 55, 40]]]) {
      const list = parts.contours[key];
      if (!list || !list.length) continue;
      const li = layer(N[key] + (parts.contours[key + "Label"] ? ` ${parts.contours[key + "Label"]}` : ""), rgb);
      for (const cl of list) doc.objects().addPolyline(cl.pts.map(p => [p[0], p[1], cl.z]), attr(li, `${N.level} ${cl.z.toFixed(2)}`));
    }
  }
  if (parts.points) {
    const { hf, coords, label } = parts.points, li = layer(label || N.points, [200, 60, 40], false);
    const pc = new rhino.PointCloud();
    for (let p = 0; p < coords.length; p += 2) {
      const i = coords[p], j = coords[p + 1];
      pc.add([hf.x0 + i * hf.cell, hf.y0 + j * hf.cell, hf.z[j * hf.nx + i]]);
    }
    doc.objects().addPointCloud(pc, attr(li, label || N.points));
  }
  if (parts.water && parts.water.length) {
    const li = layer(N.water, [70, 140, 200]);
    report.waterMeshes = 0; report.waterValid = true;
    for (const w of parts.water) {
      if (!w.triangles.length) continue;
      const me = bulkMesh(rhino, w.positions, w.triangles, null);
      me.normals().computeNormals(); me.compact();
      report.waterValid = report.waterValid && me.isValid; report.waterMeshes++;
      doc.objects().addMesh(me, attr(li, w.name || N.water));
    }
  }
  const opt = new rhino.File3dmWriteOptions();
  opt.version = version;
  const bytes = doc.toByteArrayOptions(opt);
  doc.delete && doc.delete();
  return { bytes, report };
}
