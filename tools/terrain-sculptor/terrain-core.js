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
   Si visita solo il quadrato del pennello.
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
   ====================================================================== */
function smin(a, b, k) {
  if (k <= 0) return Math.min(a, b);
  const h = Math.max(k - Math.abs(a - b), 0) / k;
  return Math.min(a, b) - h * h * k * 0.25;
}
const smax = (a, b, k) => -smin(-a, -b, k);

export function gradeValue(existing, zD, d, slope, round = 0) {
  if (d <= 0) return zD;
  const k = Math.min(round, slope * d * 0.5);
  return smax(smin(existing, zD + slope * d, k), zD - slope * d, k);
}

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

/* piattaforma piana: poligono [[x,y]…], quota, pendenza scarpata (V/H, es. 2/3) */
export function gradePad(hf, { polygon, elevation, slope, round = 0 }) {
  const n = hf.nx, c = hf.cell;
  for (let j = 0; j < hf.ny; j++) for (let i = 0; i < n; i++) {
    const x = hf.x0 + i * c, y = hf.y0 + j * c, k = j * n + i;
    let d = 0;
    if (!pointInPolygon(x, y, polygon)) {
      d = Infinity;
      for (let a = 0, b = polygon.length - 1; a < polygon.length; b = a++)
        d = Math.min(d, segProject(x, y, polygon[b][0], polygon[b][1], polygon[a][0], polygon[a][1]).d);
    }
    hf.z[k] = gradeValue(hf.z[k], elevation, d, slope, round);
  }
}

/* percorso/rampa: polilinea [[x,y]…], larghezza, quote d'inizio e fine
   (profilo lineare sulla lunghezza), pendenza delle scarpate laterali.
   Restituisce lunghezza e pendenza longitudinale. */
export function gradePath(hf, { line, width, zStart, zEnd, slope, round = 0 }) {
  const cum = [0];
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
    hf.z[k] = gradeValue(hf.z[k], zD, Math.max(0, best - half), slope, round);
  }
  return { length: L, grade: L > 0 ? (zEnd - zStart) / L : 0 };
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
     { id, type: "pad",  name?, on?, polygon: [[x,y]…], elevation, slope, round }
     { id, type: "path", name?, on?, line: [[x,y]…], width, zStart, zEnd,
       startPad?, endPad?, slope, round }
   startPad/endPad agganciano la quota d'inizio/fine di una rampa alla
   piattaforma da cui parte o a cui arriva: se la piattaforma cambia quota,
   la rampa la segue. Le opere si applicano IN ORDINE sopra il terreno
   scolpito (l'ultima vince dove si sovrappongono).
   opEvaluator dà la funzione del singolo nodo — identica, operazione per
   operazione, a gradePad/gradePath — con un taglio a monte: dove la distanza
   dal riquadro dell'opera garantisce che il nodo sta dentro la forbice della
   scarpata, restituisce z tale e quale senza calcolare la distanza vera.
   ====================================================================== */
export function pathEnds(op, ops) {
  const pad = (id) => id ? ops.find(o => o.id === id && o.type === "pad") : null;
  const a = pad(op.startPad), b = pad(op.endPad);
  return { zStart: a ? a.elevation : op.zStart, zEnd: b ? b.elevation : op.zEnd };
}

function boxOf(pts, grow = 0) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return [x0 - grow, y0 - grow, x1 + grow, y1 + grow];
}

const okPts = (pts) => Array.isArray(pts) && pts.every(p => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));

export function opEvaluator(op, ops = [op]) {
  const s = +op.slope, rnd = Math.max(0, +op.round || 0);
  if (!(s > 0) || !okPts(op.type === "pad" ? op.polygon : op.line)) return null;
  if (op.type === "pad") {
    const P = op.polygon, zD = +op.elevation, nv = P ? P.length : 0;
    if (nv < 3 || !Number.isFinite(zD)) return null;
    const box = boxOf(P), [bx0, by0, bx1, by1] = box;
    return {
      box, zMin: zD, zMax: zD, slope: s, round: rnd,
      at(z, x, y) {
        const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0, dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
        if ((dx || dy) && Math.abs(z - zD) < s * Math.sqrt(dx * dx + dy * dy) - rnd) return z;
        let d = 0;
        if (!pointInPolygon(x, y, P)) {
          d = Infinity;
          for (let a = 0, b = nv - 1; a < nv; b = a++) d = Math.min(d, segProject(x, y, P[b][0], P[b][1], P[a][0], P[a][1]).d);
        }
        return gradeValue(z, zD, d, s, rnd);
      },
    };
  }
  if (op.type === "path") {
    const line = op.line, half = +op.width / 2, ns = line ? line.length : 0;
    const { zStart, zEnd } = pathEnds(op, ops);
    if (ns < 2 || !(half > 0) || !Number.isFinite(zStart) || !Number.isFinite(zEnd)) return null;
    const cum = [0];
    for (let q = 1; q < ns; q++) cum.push(cum[q - 1] + Math.hypot(line[q][0] - line[q - 1][0], line[q][1] - line[q - 1][1]));
    const L = cum[ns - 1], zMin = Math.min(zStart, zEnd), zMax = Math.max(zStart, zEnd);
    const box = boxOf(line, half), [bx0, by0, bx1, by1] = box;
    return {
      box, zMin, zMax, slope: s, round: rnd, length: L, zStart, zEnd,
      at(z, x, y) {
        const dx = x < bx0 ? bx0 - x : x > bx1 ? x - bx1 : 0, dy = y < by0 ? by0 - y : y > by1 ? y - by1 : 0;
        if ((dx || dy) && Math.max(Math.abs(z - zMin), Math.abs(z - zMax)) < s * Math.sqrt(dx * dx + dy * dy) - rnd) return z;
        let best = Infinity, along = 0;
        for (let q = 1; q < ns; q++) {
          const p = segProject(x, y, line[q - 1][0], line[q - 1][1], line[q][0], line[q][1]);
          if (p.d < best) { best = p.d; along = cum[q - 1] + p.t * (cum[q] - cum[q - 1]); }
        }
        const zD = zStart + (zEnd - zStart) * (L > 0 ? along / L : 0);
        return gradeValue(z, zD, Math.max(0, best - half), s, rnd);
      },
    };
  }
  return null;
}

/* zona d'influenza (indici di nodo) di un'opera: il suo riquadro allargato di
   quanto può correre la scarpata prima d'incontrare QUALSIASI quota in
   [zLo, zHi] — oltre, il nodo resta nella forbice e l'opera non lo tocca. */
export function opRange(ev, hf, zLo, zHi) {
  if (!ev) return null;
  const reach = (Math.max(zHi - ev.zMin, ev.zMax - zLo, 0) + ev.round) / ev.slope + hf.cell;
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
const HIST_MAX = 200, HIST_BYTES = 256 * 1048576;

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
  newId(type) { return (type === "pad" ? "pad" : "path") + this._seq++; }

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
    if (kind === "raise") brushRaise(hf, p);
    else if (kind === "smooth") brushSmooth(hf, p);
    else if (kind === "flatten") brushFlatten(hf, p);
    else throw new Error("pennello sconosciuto: " + kind);
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
      for (const o of list) m.set(o.id, JSON.stringify([act.indexOf(o), o, o.type === "path" ? pathEnds(o, list) : 0]));
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
    const head = this.ops.slice(0, k + 1).filter(o => o.on !== false), gone = head.map(o => o.id);
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
   perimetro + fondo a ventaglio, costruito come closedVolume: il perimetro
   del TIN di Delatin sono i suoi vertici di bordo in fila.
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

export function closedVolumeTIN(hf, tin, baseZ) {
  const n = hf.nx, m = hf.ny, top = tinMesh(hf, tin), N = tin.points, C = tin.coords;
  const border = [];
  for (let p = 0; p < N; p++) {
    const i = C[2 * p], j = C[2 * p + 1];
    let s = -1;
    if (j === 0) s = i;                                        // sud, verso est
    else if (i === n - 1) s = (n - 1) + j;                     // est, verso nord
    else if (j === m - 1) s = 2 * (n - 1) + (m - 1) - i;       // nord, verso ovest
    else if (i === 0) s = 3 * (n - 1) + 2 * (m - 1) - j;       // ovest, verso sud
    if (s >= 0) border.push([s, p]);
  }
  border.sort((a, b) => a[0] - b[0]);
  const ring = border.map(b => b[1]), M = ring.length;
  const P = new Float64Array((N + M + 1) * 3);
  P.set(top.positions);
  for (let r = 0; r < M; r++) { const o = 3 * (N + r), s = 3 * ring[r]; P[o] = P[s]; P[o + 1] = P[s + 1]; P[o + 2] = baseZ; }
  const Cn = N + M;
  P[3 * Cn] = hf.x0 + (n - 1) * hf.cell / 2; P[3 * Cn + 1] = hf.y0 + (m - 1) * hf.cell / 2; P[3 * Cn + 2] = baseZ;
  const T = new Uint32Array(top.triangles.length + M * 9);
  T.set(top.triangles);
  let o = top.triangles.length;
  for (let r = 0; r < M; r++) {
    const a = ring[r], b = ring[(r + 1) % M], a2 = N + r, b2 = N + (r + 1) % M;
    T[o++] = a; T[o++] = a2; T[o++] = b2; T[o++] = a; T[o++] = b2; T[o++] = b;
    T[o++] = Cn; T[o++] = b2; T[o++] = a2;
  }
  return { positions: P, triangles: T };
}

export function meshVolume(P, T) {
  let v = 0;
  for (let t = 0; t < T.length; t += 3) {
    const a = 3 * T[t], b = 3 * T[t + 1], c = 3 * T[t + 2];
    v += P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1])
       - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c])
       + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c]);
  }
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
   parts: { mesh: hf, nurbs, contours: {minor, major}, volume, points }
   Ogni parte va sul suo layer; version 7 = si apre in Rhino 7 e 8.
   Mesh e volume passano IN BLOCCO da Mesh.createFromThreejsJSON: aggiunti un
   vertice e una faccia alla volta costavano 4,2 s ciascuno sul terreno della
   fase 0 (centinaia di migliaia di chiamate wasm), in blocco 0,1 s. Quella
   funzione parla three.js (Y in alto) e ruota gli assi: Rhino (X, Y, Z)
   va passato come (X, Z, −Y).
   ====================================================================== */
const LAYER_NAMES = {
  nurbs: "Terreno - superficie NURBS", mesh: "Terreno - mesh", volume: "Volume chiuso",
  minor: "Curve di livello", major: "Curve di livello maestre", points: "Punti Revit",
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
    const { positions: P, triangles: T } = parts.volume, li = layer(N.volume, [170, 140, 100], false);
    const me = bulkMesh(rhino, P, T, null);
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
  const opt = new rhino.File3dmWriteOptions();
  opt.version = version;
  const bytes = doc.toByteArrayOptions(opt);
  doc.delete && doc.delete();
  return { bytes, report };
}
