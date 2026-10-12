/* =========================================================================
   Trazione elettrica (Railway OCS) — motore puro dei binari (tool 18, F1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: si prova in Node (test/test_ocs_core.js).
   Unità: metri e radianti; x = Est, y = Nord, z = quota.

   Un BINARIO è un asse ricevuto (pianta + profilo + sopraelevazione) più un
   offset (l'asse ricevuto non sempre sta sul binario, scelta dell'utente):
   - pianta: rette, archi, clotoidi; ogni elemento si valuta dal SUO inizio
     dichiarato nel file (gli errori non si accumulano: la F0 ha misurato
     giunzioni a 0,00 mm sui LandXML veri);
   - profilo: livellette e raccordi verticali CIRCOLARI esatti (LandXML
     CircCurve; anche parabolici);
   - sopraelevazione (F0, §10.3 del piano): la livelletta è il piano del ferro
     della ROTAIA INTERNA, l'esterna sale della sopraelevazione, l'asse della
     metà; quota lineare fra le due rotaie;
   - offset: laterale (+ a sinistra guardando avanti) e verticale, costante
     più tratti da/a con raccordo lineare ai capi.
   La progressiva u parte da 0 all'inizio dell'asse; la progressiva del
   file è sta = s0 + u.
   ========================================================================= */

/* ---- pianta -------------------------------------------------------------- */
/* Gauss-Legendre a 8 punti su [0, 1]: la clotoide si integra a pezzi di 10 m al più */
const GL_X = [0.0198550717512319, 0.1016667612931866, 0.2372337950418355, 0.4082826787521751, 0.5917173212478249, 0.7627662049581645, 0.8983332387068134, 0.9801449282487681];
const GL_W = [0.0506142681451881, 0.1111905172266872, 0.1568533229389436, 0.1813418916891810, 0.1813418916891810, 0.1568533229389436, 0.1111905172266872, 0.0506142681451881];

/* un elemento di pianta: { t: "L" | "A" | "C", x0, y0, th0, len, k0, k1 } — curvatura con segno (+ a sinistra);
   A: k0 = k1 = 1/R; C (clotoide): curvatura lineare da k0 a k1 */
export function hEval(e, s) {
  s = Math.max(0, Math.min(e.len, s));
  if (e.t === "L" || (Math.abs(e.k0) < 1e-15 && Math.abs(e.k1) < 1e-15)) {
    return { x: e.x0 + s * Math.cos(e.th0), y: e.y0 + s * Math.sin(e.th0), th: e.th0, k: 0 };
  }
  if (e.t === "A") {
    const k = e.k0, th = e.th0 + k * s;
    return { x: e.x0 + (Math.sin(th) - Math.sin(e.th0)) / k, y: e.y0 - (Math.cos(th) - Math.cos(e.th0)) / k, th, k };
  }
  const c = (e.k1 - e.k0) / e.len;                        // clotoide: θ(t) = θ0 + k0 t + c t²/2
  const thAt = (t) => e.th0 + e.k0 * t + 0.5 * c * t * t;
  const n = Math.max(1, Math.ceil(s / 10));
  let x = e.x0, y = e.y0;
  for (let i = 0; i < n; i++) {
    const a = (s * i) / n, h = s / n;
    for (let j = 0; j < 8; j++) { const th = thAt(a + h * GL_X[j]); x += h * GL_W[j] * Math.cos(th); y += h * GL_W[j] * Math.sin(th); }
  }
  return { x, y, th: thAt(s), k: e.k0 + c * s };
}
/* elenco di elementi → pianta con le progressive di inizio (u0) e la lunghezza */
export function hAlign(elems) {
  let u = 0;
  const segs = elems.filter((e) => e.len > 1e-9).map((e) => { const s = { ...e, u0: u }; u += e.len; return s; });
  return { segs, length: u };
}
/* l'elemento che contiene u (ricerca binaria) */
export function hSegAt(H, u) {
  const a = H.segs;
  if (!a.length) return -1;
  let lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m].u0 <= u) lo = m; else hi = m - 1; }
  return lo;
}
export function hAt(H, u) {
  const i = hSegAt(H, u);
  if (i < 0) return null;
  const e = H.segs[i];
  return { ...hEval(e, u - e.u0), seg: i };
}
/* scarti alle giunzioni: la fine calcolata di un elemento contro l'inizio dichiarato del successivo */
export function hJunctions(H) {
  const out = [];
  for (let i = 0; i + 1 < H.segs.length; i++) {
    const a = H.segs[i], b = H.segs[i + 1], e = hEval(a, a.len);
    const dAng = Math.abs(Math.atan2(Math.sin(e.th - b.th0), Math.cos(e.th - b.th0)));
    out.push({ i, u: b.u0, dPos: Math.hypot(e.x - b.x0, e.y - b.y0), dAng });
  }
  return out;
}

/* ---- profilo ------------------------------------------------------------- */
/* vertici del profilo [{ u, z, L, R }] (L = lunghezza del raccordo, R = raggio se circolare; 0 = spigolo vivo)
   → elementi [{ u0, len, z0, g0, g1, R }]: livellette (g0 = g1) e raccordi (R con segno: + concavo)        */
export function vProfile(pvi) {
  const p = pvi.slice().sort((a, b) => a.u - b.u);
  if (!p.length) return { segs: [], u0: 0, u1: 0 };
  if (p.length === 1) return { segs: [{ u0: p[0].u, len: 0, z0: p[0].z, g0: 0, g1: 0, R: 0 }], u0: p[0].u, u1: p[0].u };
  const g = []; for (let i = 0; i + 1 < p.length; i++) g.push((p[i + 1].z - p[i].z) / ((p[i + 1].u - p[i].u) || 1e-9));
  // ogni livelletta sta sulla retta dei suoi due vertici, ogni raccordo parte dalla tangente d'ingresso a L/2 dal
  // vertice: le quote non si accumulano da un elemento all'altro (scarto del cerchio sulla tangente d'uscita < 1 mm)
  const segs = [];
  let u = p[0].u;
  for (let i = 1; i < p.length; i++) {
    const g0 = g[i - 1], last = i === p.length - 1, g1 = last ? g0 : g[i];
    let L = last ? 0 : p[i].L || 0;
    if (!last && !(L > 0) && p[i].R > 0) L = p[i].R * Math.abs(g1 - g0);
    if (!(Math.abs(g1 - g0) > 1e-12)) L = 0;
    const t0 = p[i].u - L / 2, line = (x) => p[i - 1].z + g0 * (x - p[i - 1].u);
    if (t0 - u > 1e-9) { segs.push({ u0: u, len: t0 - u, z0: line(u), g0, g1: g0, R: 0 }); u = t0; }
    if (L > 0) {
      const circ = p[i].R > 0;                            // circolare (CircCurve) o parabolico (ParaCurve)
      const R = circ ? Math.sign(g1 - g0) * p[i].R : L / (g1 - g0);
      segs.push({ u0: u, len: L, z0: line(u), g0, g1, R, circ });
      u += L;
    }
  }
  return { segs, u0: p[0].u, u1: p[p.length - 1].u };
}
/* quota e pendenza dentro un elemento del profilo, a distanza x dal suo inizio */
function vSegAt(v, x) {
  if (!v.R || v.g0 === v.g1) return { z: v.z0 + v.g0 * x, g: v.g0 };
  if (!v.circ) return { z: v.z0 + v.g0 * x + (v.g1 - v.g0) * x * x / (2 * v.len), g: v.g0 + (v.g1 - v.g0) * x / v.len };
  // cerchio tangente alla livelletta d'ingresso nel punto d'inizio: centro sulla normale, a distanza R (segno: + sopra)
  const R = v.R, a0 = Math.atan(v.g0), n = Math.hypot(1, v.g0);
  const cx = -R * Math.sin(a0), cz = v.z0 + R * Math.cos(a0);  // centro (x relativo all'inizio)
  const dx = x - cx, r2 = R * R - dx * dx;
  if (r2 <= 0) return { z: v.z0 + v.g0 * x, g: v.g0 };
  const z = cz - Math.sign(R) * Math.sqrt(r2);
  return { z, g: dx / (Math.sign(R) * Math.sqrt(r2)) };
}
export function vAt(V, u) {
  const a = V.segs;
  if (!a.length) return { z: NaN, g: 0 };
  let i = 0, lo = 0, hi = a.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (a[m].u0 <= u) lo = m; else hi = m - 1; }
  i = lo;
  const v = a[i];
  if (u < v.u0) return { z: v.z0 + v.g0 * (u - v.u0), g: v.g0 };              // prima del profilo: prolunga la prima livelletta
  if (i === a.length - 1 && u > v.u0 + v.len) { const e = vSegAt(v, v.len); return { z: e.z + v.g1 * (u - v.u0 - v.len), g: v.g1 }; }
  return vSegAt(v, u - v.u0);
}

/* ---- sopraelevazione ----------------------------------------------------- */
/* stazioni [{ u, c (m), dir: +1 curva a sinistra | -1 a destra | 0 }]; lineare fra una stazione e l'altra */
export function cantAt(stations, u) {
  const a = stations;
  if (!a || !a.length) return { c: 0, dir: 0 };
  if (u <= a[0].u) return { c: a[0].c, dir: a[0].dir };
  if (u >= a[a.length - 1].u) { const z = a[a.length - 1]; return { c: z.c, dir: z.dir }; }
  let lo = 0, hi = a.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (a[m].u <= u) lo = m; else hi = m; }
  const A = a[lo], B = a[hi], t = B.u > A.u ? (u - A.u) / (B.u - A.u) : 0;
  return { c: A.c + (B.c - A.c) * t, dir: Math.abs(B.c) > Math.abs(A.c) ? B.dir || A.dir : A.dir || B.dir };
}
/* semidistanza fra i punti delle rotaie dove il file dà le quote (TopRail dei LandXML Civil 3D: ±0,71755) */
export const RAIL_HALF = 0.71755;
/* quota del piano del ferro a scostamento laterale q dall'asse (+ a sinistra), con la livelletta sulla rotaia interna */
export function pfAt(zInner, cant, q, hg = RAIL_HALF) {
  if (!cant.c || !cant.dir) return zInner;
  return zInner + cant.c * (hg - cant.dir * q) / (2 * hg);
}

/* ---- offset dell'asse ---------------------------------------------------- */
/* off: { h, v, rows: [{ u0, u1, h, v, len }] } — fuori dai tratti h e v costanti, dentro i valori del tratto,
   con un raccordo lineare di lunghezza len prima di u0 e dopo u1 (il tratto più in basso nell'elenco vince) */
export function offsetAt(off, u) {
  let h = (off && off.h) || 0, v = (off && off.v) || 0;
  for (const r of (off && off.rows) || []) {
    const L = Math.max(0, r.len || 0);
    let w = 0;
    if (u >= r.u0 && u <= r.u1) w = 1;
    else if (L > 0 && u < r.u0 && u > r.u0 - L) w = 1 - (r.u0 - u) / L;
    else if (L > 0 && u > r.u1 && u < r.u1 + L) w = 1 - (u - r.u1) / L;
    if (w > 0) { h += w * ((r.h || 0) - h); v += w * ((r.v || 0) - v); }
  }
  return { h, v };
}

/* ---- binario ------------------------------------------------------------- */
/* T: { H (hAlign), V (vProfile, progressive u), cant: [stazioni], off, s0 }
   frame alla progressiva u: punto dell'asse del binario (offset compreso), direzione, normale a sinistra,
   quota della livelletta (rotaia interna) e dell'asse, sopraelevazione, rotaie sinistra e destra */
export function trackFrame(T, u, hg = RAIL_HALF) {
  const a = hAt(T.H, Math.max(0, Math.min(T.H.length, u)));
  if (!a) return null;
  const o = offsetAt(T.off, u);
  let th = a.th;
  if (o.h && T.off && T.off.rows && T.off.rows.length) {   // nei raccordi dell'offset la direzione gira un poco
    const d = 0.5, o1 = offsetAt(T.off, u + d), o0 = offsetAt(T.off, u - d);
    th += Math.atan2(o1.h - o0.h, 2 * d);
  }
  const nx0 = -Math.sin(a.th), ny0 = Math.cos(a.th);
  const x = a.x + o.h * nx0, y = a.y + o.h * ny0;
  const tx = Math.cos(th), ty = Math.sin(th), nx = -ty, ny = tx;
  const zIn = vAt(T.V, u).z + o.v;
  const c = cantAt(T.cant, u);
  const zL = pfAt(zIn, c, hg, hg), zR = pfAt(zIn, c, -hg, hg);
  return {
    u, sta: (T.s0 || 0) + u, x, y, th, tx, ty, nx, ny, k: a.k, seg: a.seg,
    zIn, z: pfAt(zIn, c, 0, hg), cant: c.c, dir: c.dir, roll: Math.atan2(c.dir * c.c, 2 * hg),   // roll > 0: la sinistra scende
    left: { x: x + hg * nx, y: y + hg * ny, z: zL }, right: { x: x - hg * nx, y: y - hg * ny, z: zR },
    off: o,
  };
}
/* progressive di campionamento: passo massimo step + capi degli elementi di pianta, profilo, sopraelevazione e
   offset (la geometria non perde gli spigoli col passo lungo della modalità fast) */
export function trackStations(T, step = 1) {
  const L = T.H.length, set = new Set([0, L]);
  for (const e of T.H.segs) set.add(e.u0);
  for (const v of T.V.segs) { set.add(v.u0); set.add(v.u0 + v.len); }
  for (const c of T.cant || []) set.add(c.u);
  for (const r of (T.off && T.off.rows) || []) for (const x of [r.u0 - (r.len || 0), r.u0, r.u1, r.u1 + (r.len || 0)]) set.add(x);
  const keys = [...set].filter((x) => x >= 0 && x <= L).sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < keys.length; i++) {
    const a = keys[i], b = keys[i + 1];
    if (!out.length || a - out[out.length - 1] > 1e-6) out.push(a);
    if (b == null) break;
    const n = Math.ceil((b - a) / step - 1e-9);
    for (let j = 1; j < n; j++) out.push(a + ((b - a) * j) / n);
  }
  return out;
}
/* linee del binario (asse, rotaie, piano del ferro dell'asse) campionate col passo dato */
export function trackLines(T, step = 1, hg = RAIL_HALF) {
  const us = trackStations(T, step), axis = [], left = [], right = [];
  for (const u of us) {
    const f = trackFrame(T, u, hg);
    axis.push(f.x, f.y, f.z); left.push(f.left.x, f.left.y, f.left.z); right.push(f.right.x, f.right.y, f.right.z);
  }
  return { us, axis, left, right };
}
/* punto più vicino sull'asse ricevuto (senza offset): progressiva u e scostamento laterale q (+ a sinistra) */
export function nearestU(T, x, y, step = 5) {
  const L = T.H.length;
  let best = { u: 0, d: Infinity };
  for (let u = 0; u <= L + 1e-9; u += step) { const p = hAt(T.H, Math.min(u, L)); const d = Math.hypot(p.x - x, p.y - y); if (d < best.d) best = { u: Math.min(u, L), d }; }
  let lo = Math.max(0, best.u - step), hi = Math.min(L, best.u + step);
  for (let it = 0; it < 60; it++) {                       // sezione aurea sul tratto attorno al migliore
    const a = lo + (hi - lo) * 0.382, b = lo + (hi - lo) * 0.618;
    const pa = hAt(T.H, a), pb = hAt(T.H, b);
    if (Math.hypot(pa.x - x, pa.y - y) < Math.hypot(pb.x - x, pb.y - y)) hi = b; else lo = a;
  }
  const u = (lo + hi) / 2, p = hAt(T.H, u);
  return { u, q: -Math.sin(p.th) * (x - p.x) + Math.cos(p.th) * (y - p.y), d: Math.hypot(p.x - x, p.y - y) };
}
/* ingombro in pianta di più binari (per l'origine della scena e l'inquadratura) */
export function tracksBox(list, step = 50) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const T of list) for (const u of trackStations(T, step)) {
    const f = trackFrame(T, u);
    x0 = Math.min(x0, f.x); x1 = Math.max(x1, f.x); y0 = Math.min(y0, f.y); y1 = Math.max(y1, f.y);
    if (Number.isFinite(f.z)) { z0 = Math.min(z0, f.z); z1 = Math.max(z1, f.z); }
  }
  return Number.isFinite(x0) ? { x0, y0, x1, y1, z0: Number.isFinite(z0) ? z0 : 0, z1: Number.isFinite(z1) ? z1 : 0 } : null;
}

/* ---- sostegni (F2) --------------------------------------------------------- */
/* Un sostegno sta sul binario T alla progressiva u, dalla parte side (+1 sinistra, −1 destra guardando avanti).
   R è il sostegno risolto col catalogo (ocs-catalog.js → resolveSupport): palo, DR, mensola, tirante, quote,
   fondazione. Tutte le quote sono sul piano del ferro dell'ASSE del binario (f.z), come i fogli Satferr dove il
   blocco binario sta sull'asse; il palo è verticale, la mensola orizzontale e perpendicolare al binario.
   Coordinata laterale q: + a sinistra dall'asse del binario (offset compreso). La faccia del palo verso il
   binario sta a q = side·(DR + metà scartamento interno): DR misurata in orizzontale (F0 §10.4, rettifilo). */
export const GAUGE_HALF = 0.7175;
export function supportFrame(T, u, side) {
  const f = trackFrame(T, Math.max(0, Math.min(T.H.length, u)));
  if (!f) return null;
  const s = side >= 0 ? 1 : -1;
  return { f, s, at: (along, q, z) => ({ x: f.x + along * f.tx + q * f.nx, y: f.y + along * f.ty + q * f.ny, z }) };
}
/* le parti del sostegno: scatole { k, c: {x,y,z} centro, sz: [lungo il binario, trasversale, verticale], th }
   e aste { k, a, b } (estremi), più il punto del filo { k: "wire", c } */
export function supportParts(T, sup, R) {
  const F = supportFrame(T, sup.u, sup.side);
  if (!F) return [];
  const { f, s, at } = F, z0 = f.z, th = f.th, out = [];
  const box = (k, along, q, zc, sl, st, sv) => out.push({ k, c: at(along, q, zc), sz: [sl, st, sv], th });
  const M = R.mast, face = s * (R.dr + GAUGE_HALF), qc = face + s * M.w / 2;
  const zPlate = z0 + R.baseDz, zBase = zPlate + 0.045, zTop = zBase + M.H;
  // fondazione: pilastrino sotto la piastra, blocco sotto il pilastrino (i B eccentrici: A2 verso il binario)
  const Fd = R.found, zPil = zPlate - R.c1, zBlk = zPil - Fd.C;
  box("pil", 0, qc, (zPlate + zPil) / 2, Fd.B1, Fd.A1, R.c1);
  const qb = Fd.A2 != null ? qc + s * (Fd.A / 2 - Fd.A2) : qc;
  box("block", 0, qb, (zPil + zBlk) / 2, Fd.B, Fd.A, Fd.C);
  box("plate", 0, qc, zPlate + 0.0225, 0.58, 0.58, 0.045);
  box("mast", 0, qc, (zBase + zTop) / 2, M.d, M.w, M.H);
  // UNA mensola dalla faccia verso il binario; su di essa una sospensione per binario servito (il binario del
  // palo e quelli in R.susp, all'interasse off oltre il primo, filo a hw sul LORO piano del ferro) e un tirante
  // per sospensione (R.ties: il più lontano alla punta). Parti con suffisso 2, 3… per le sospensioni in più;
  // «trk» = asse del binario servito (solo per la sezione)
  const q0 = face - s * 0.115, zm = z0 + R.hm, L = R.mens.L, q1 = q0 - s * L;
  box("mens", 0, (q0 + q1) / 2, zm, 0.06, L, 0.06);
  const sus = [{ off: 0, dz: 0, stag: R.stag }, ...(R.susp || [])];
  sus.forEach((x, i) => {
    const sfx = i ? String(i + 1) : "", qa = -s * x.off, qw = qa + s * x.stag, zw = z0 + x.dz + R.hw;
    out.push({ k: "arm" + sfx, a: at(0, qw, zm), b: at(0, qw, zw) });
    out.push({ k: "wire" + sfx, c: at(0, qw, zw) });
    out.push({ k: "trk" + sfx, c: at(0, qa, z0 + x.dz) });
  });
  (R.ties || [R.tir]).forEach((t, i) => out.push({ k: "tir" + (i ? String(i + 1) : ""), a: at(0, face, zm + t.dh), b: at(0, q0 - s * t.xt, zm) }));
  // apparecchiature sul retro del palo (lontano dal binario); con tutte e due, una per parte lungo il binario
  const back = face + s * (M.w + 0.05);
  const both = R.eq.trafo && R.eq.sez;
  if (R.eq.trafo) { const e = R.eq.trafoSpec; box("trafo", both ? -0.4 : 0, back + s * e.d / 2, z0 + e.z + e.h / 2, e.w, e.d, e.h); }
  if (R.eq.sez) {
    const e = R.eq.sezSpec;
    box("sez", both ? 0.4 : 0, back + s * e.d / 2, z0 + e.z + e.h / 2, e.w, e.d, e.h);
    out.push({ k: "rod", a: at(both ? 0.4 : 0, back + s * 0.03, z0 + e.z), b: at(both ? 0.4 : 0, back + s * 0.03, z0 + e.rod) });
  }
  return out;
}
/* un altro binario T2 servito dalla mensola del palo (T, u, side): dove la normale al binario del palo nel punto
   del palo taglia T2. off = interasse verso la punta della mensola (+ = oltre il binario del palo, lontano dal
   palo), dz = piano del ferro di T2 meno quello del binario del palo, u2 = progressiva su T2; null se T2 non
   passa davanti al palo */
export function crossOffset(T, u, side, T2) {
  const F = supportFrame(T, u, side);
  if (!F || !T2) return null;
  const { f, s } = F, cr = (ax, ay, bx, by) => ax * by - ay * bx;
  let q = -s * 4, g = null;
  for (let it = 0; it < 4; it++) {
    const n = nearestU(T2, f.x + q * f.nx, f.y + q * f.ny);
    g = trackFrame(T2, n.u);
    const den = cr(f.nx, f.ny, g.tx, g.ty);
    if (Math.abs(den) < 0.2) return null;                 // T2 quasi parallelo alla normale: non passa davanti
    q = cr(g.x - f.x, g.y - f.y, g.tx, g.ty) / den;
  }
  const px = f.x + q * f.nx, py = f.y + q * f.ny;
  if (Math.abs((px - g.x) * g.tx + (py - g.y) * g.ty) > 0.05) return null;   // oltre i capi di T2
  return { off: -s * q, dz: g.z - f.z, u2: g.u };
}
/* il fusto del palo in solidi (scatole orientate) attorno al suo centro, x lungo il binario, y trasversale,
   z verticale: lod «box» = pieno; «upn» = 2 UPN a C affacciate (anime ai lati esterni della vista trasversale,
   ali verso l'interno); «lattice» = più il traliccio a X fra le ali, modulo M.module, sulle due facce aperte.
   Ogni scatola: { c: [x,y,z], ax: [[u],[v],[w]] assi unitari, h: [hu,hv,hw] semilati } */
export function mastSolids(M, lod = "upn") {
  const d = M.d, w = M.w, H = M.H, out = [];
  const B = (c, h, ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) => out.push({ c, ax, h });
  if (lod === "box" || !M.upn) { B([0, 0, 0], [d / 2, w / 2, H / 2]); return out; }
  const { b, tw, tf } = M.upn;
  for (const sy of [1, -1]) {
    B([0, sy * (w / 2 - tw / 2), 0], [d / 2, tw / 2, H / 2]);                              // anima
    for (const sx of [1, -1]) B([sx * (d / 2 - tf / 2), sy * (w / 2 - tw - (b - tw) / 2), 0], [tf / 2, (b - tw) / 2, H / 2]);   // ali
  }
  if (lod !== "lattice") return out;
  // aste piatte 30 × 6 dentro le ali; 20 mm di margine ai capi perché gli spigoli delle aste non escano dal fusto
  const m = M.module || 0.266, e = 0.02, n = Math.floor((H - 2 * e) / m + 1e-9), y = w / 2 - b / 2, tb = 0.006, wb = 0.03;
  const dy = 2 * y, len = Math.hypot(dy, m);
  for (const sx of [1, -1]) {
    const x = sx * (d / 2 - tf - tb / 2);
    for (let k = 0; k < n; k++) {
      const zc = -H / 2 + e + (k + 0.5) * m;
      for (const dir of [1, -1]) {
        const wv = [0, (dir * dy) / len, m / len], vv = [0, m / len, (-dir * dy) / len];   // terna destrorsa (x, v, w)
        B([x, 0, zc], [tb / 2, wb / 2, len / 2], [[1, 0, 0], vv, wv]);
      }
    }
  }
  return out;
}
/* ---- portali (F3) -------------------------------------------------------------------------------------- */
/* i binari che passano davanti al punto u del binario T (la sua normale li taglia entro reach): [{ i, q, dz, u2 }]
   con q = scostamento dell'asse (+ a sinistra di T) e dz = dislivello del piano del ferro; T stesso non c'è */
export function crossTracks(T, u, others, reach = 40) {
  const out = [];
  (others || []).forEach((T2, i) => {
    if (!T2 || T2 === T) return;
    const x = crossOffset(T, u, 1, T2);
    if (x && Math.abs(x.off) <= reach) out.push({ i, q: -x.off, dz: x.dz, u2: x.u2 });
  });
  return out;
}
/* le parti del portale P (risolto R = ocs-catalog resolvePortal): montanti (pilone PO «pole» o palo LSU «mast»)
   con piastra e fondazione, trave «beam» orizzontale e perpendicolare al binario di riferimento, per ogni binario
   servito un pendolo verticale dall'intradosso al filo («arm», «wire», «trk» con suffisso 2, 3… dal secondo).
   Quote sul piano del ferro del binario di riferimento; i montanti sulla piastra al piano del ferro del binario
   estremo dalla loro parte */
export function portalParts(T, P, R) {
  const F = supportFrame(T, P.u, 1);
  if (!F) return [];
  const { f, at } = F, z0 = f.z, th = f.th, out = [];
  const box = (k, along, q, zc, sl, st, sv, extra) => out.push({ k, c: at(along, q, zc), sz: [sl, st, sv], th, ...(extra || {}) });
  const B = R.beam, zb = z0 + R.hb, zt = zb + B.h;
  for (const [q, zB, sgn] of [[R.qL, R.zBaseL, 1], [R.qR, R.zBaseR, -1]]) {
    const zPlate = z0 + zB, Fd = R.found, zPil = zPlate - R.c1, zBlk = zPil - Fd.C;
    box("pil", 0, q, (zPlate + zPil) / 2, Fd.B1, Fd.A1, R.c1);
    const qb = Fd.A2 != null ? q - sgn * (Fd.A / 2 - Fd.A2) : q;     // i B eccentrici verso i binari (dentro)
    box("block", 0, qb, (zPil + zBlk) / 2, Fd.B, Fd.A, Fd.C);
    if (R.mast) {
      const M = R.mast, zBase = zPlate + 0.045;
      box("plate", 0, q, zPlate + 0.0225, 0.58, 0.58, 0.045);
      box("mast", 0, q, zBase + M.H / 2, M.d, M.w, M.H);
    } else {
      const Pp = R.pole, zBase = zPlate + Pp.plate.t, H = zt + BEAM_TOP_GAP_CORE - zBase;
      box("plate", 0, q, zPlate + Pp.plate.t / 2, Pp.plate.a, Pp.plate.a, Pp.plate.t);
      box("pole", 0, q, zBase + H / 2, Pp.d, Pp.w, H);
    }
  }
  box("beam", 0, (R.qL + R.qR) / 2, zb + B.h / 2, BEAM_WIDTH_CORE, B.L, B.h, { beam: B.id });
  R.susp.forEach((x, i) => {
    const sfx = i ? String(i + 1) : "", qw = x.q + x.stag, zw = z0 + x.dz + R.hw;
    out.push({ k: "arm" + sfx, a: at(0, qw, zb), b: at(0, qw, zw) });
    out.push({ k: "wire" + sfx, c: at(0, qw, zw) });
    out.push({ k: "trk" + sfx, c: at(0, x.q, z0 + x.dz) });
  });
  return out;
}
const BEAM_WIDTH_CORE = 0.6, BEAM_TOP_GAP_CORE = 0.1;    // = ocs-catalog BEAM_WIDTH, BEAM_TOP_GAP (il motore non importa il catalogo)
/* la trave a traliccio in solidi attorno al suo centro (x lungo il binario = larghezza, y = lunghezza, z = altezza):
   «box» = piena; altrimenti 4 correnti a L 70 agli spigoli; «lattice» = più montanti e diagonali alternate
   (Warren con montanti, come i blocchi TRAVE PO) sulle due facce verticali, modulo ≈ 1,3 × altezza */
export function beamSolids(B, lod = "upn", width = BEAM_WIDTH_CORE) {
  const L = B.L, h = B.h, w = width, out = [];
  const X = (c, hh, ax = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) => out.push({ c, ax, h: hh });
  if (lod === "box") { X([0, 0, 0], [w / 2, L / 2, h / 2]); return out; }
  const a = 0.07;
  for (const sx of [1, -1]) for (const sz of [1, -1]) X([sx * (w / 2 - a / 2), 0, sz * (h / 2 - a / 2)], [a / 2, L / 2, a / 2]);
  if (lod !== "lattice") return out;
  const n = Math.max(2, Math.round(L / (1.3 * h))), m = L / n, hi = h - 2 * a, t = 0.008, wb = 0.05;
  for (const sx of [1, -1]) {
    const x = sx * (w / 2 - a / 2);
    for (let k = 0; k <= n; k++) X([x, -L / 2 + k * m + (k === 0 ? wb / 2 : k === n ? -wb / 2 : 0), 0], [t / 2, wb / 2, hi / 2]);   // montanti
    for (let k = 0; k < n; k++) {
      const dir = k % 2 ? 1 : -1, len = Math.hypot(m - wb, hi), wv = [0, (m - wb) / len, (dir * hi) / len], vv = [0, (dir * hi) / len, -(m - wb) / len];   // terna destrorsa
      X([x, -L / 2 + (k + 0.5) * m, 0], [t / 2, wb / 2, len / 2 - 0.02], [[1, 0, 0], vv, wv]);
    }
  }
  return out;
}
/* quote notevoli del sostegno, per la tabella e la sezione */
export function supportLevels(T, sup, R) {
  const F = supportFrame(T, sup.u, sup.side);
  if (!F) return null;
  const z0 = F.f.z, zPlate = z0 + R.baseDz;
  return { pf: z0, plate: zPlate, top: zPlate + 0.045 + R.mast.H, mens: z0 + R.hm, wire: z0 + R.hw, pil: zPlate - R.c1, bottom: zPlate - R.c1 - R.found.C, E: F.f.x + F.s * (R.dr + GAUGE_HALF + R.mast.w / 2) * F.f.nx, N: F.f.y + F.s * (R.dr + GAUGE_HALF + R.mast.w / 2) * F.f.ny };
}

/* ---- profilo già in segmenti (IFC 4x3: IfcAlignmentVerticalSegment) -------------------------------- */
export function vFromSegs(segs) {
  const a = (segs || []).slice().sort((p, q) => p.u0 - q.u0);
  return { segs: a, u0: a.length ? a[0].u0 : 0, u1: a.length ? a[a.length - 1].u0 + a[a.length - 1].len : 0 };
}
/* il profilo di un asse letto: a vertici (LandXML, disegni) o a segmenti (IFC) */
export const profileV = (p) => (p && p.segs ? vFromSegs(p.segs) : vProfile(p ? p.pvi : []));
