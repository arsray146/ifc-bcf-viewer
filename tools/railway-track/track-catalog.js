/* =========================================================================
   Armamento ferroviario (Railway Track) — catalogo di rotaie e traverse (tool 21)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: si prova in Node (test/test_track_catalog.js).
   I dati stanno in millimetri come nei disegni; le funzioni che danno
   geometria rendono METRI (come il motore dei binari della Trazione).

   Rotaie — profilo costruito per tangenze dalle quote del disegno della norma
   (EN 13674-1; per la 60E1 il disegno ArcelorMittal, PIANO §6.6): archi e
   rette si raccordano uno all'altro, nessun punto è preso a occhio. Il
   controllo è sull'area e sull'asse neutro pubblicati (test).
   Riferimento della sezione: x orizzontale (0 = asse della rotaia), y verso
   l'alto (0 = base della suola).

   Traverse — RFI TCAR SF AR 03 002 F fissa lunghezza, base, altezze sotto
   rotaia e in mezzeria, inclinazione della sede 1:20 e massa minima; facce,
   smussi e spalle li sceglie il fornitore. La forma di partenza è quella della
   scheda Margaritelli «RFI 240 VN», letta dalle linee vettoriali (PIANO §6.6);
   230 e 260 la riprendono con le misure della specifica, a sedi delle rotaie
   ferme (le sedi stanno dove stanno le rotaie, cambia lo sbalzo).
   ========================================================================= */

/* ---- geometria piana minima ----------------------------------------------- */
const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const unit = (a) => mul(a, 1 / len(a));
const dot = (a, b) => a[0] * b[0] + a[1] * b[1];
const perp = (a) => [-a[1], a[0]];                       // a girato di +90°
/* retta { p, d } (d unitario); offset di k verso la normale n (unitaria) */
const line = (p, d) => ({ p, d: unit(d) });
const shift = (L, n, k) => ({ p: add(L.p, mul(n, k)), d: L.d });
function meet(L1, L2) {                                   // intersezione di due rette
  const den = L1.d[0] * L2.d[1] - L1.d[1] * L2.d[0];
  const w = sub(L2.p, L1.p), t = (w[0] * L2.d[1] - w[1] * L2.d[0]) / den;
  return add(L1.p, mul(L1.d, t));
}
const foot = (L, c) => add(L.p, mul(L.d, dot(sub(c, L.p), L.d)));   // piede della perpendicolare
/* intersezioni di una retta con un cerchio (centro c, raggio r) */
function lineCircle(L, c, r) {
  const f = foot(L, c), h2 = r * r - len(sub(f, c)) ** 2;
  if (h2 < 0) return [];
  const h = Math.sqrt(h2);
  return [add(f, mul(L.d, -h)), add(f, mul(L.d, h))];
}
/* raccordo di raggio r fra due rette: centro sui due offset (n1, n2 = normali verso il centro) */
function filletLL(L1, n1, L2, n2, r) {
  const c = meet(shift(L1, n1, r), shift(L2, n2, r));
  return { c, r, t1: foot(L1, c), t2: foot(L2, c) };
}
/* raccordo di raggio r fra un cerchio (C, R) e una retta: centro a R ± r da C (interno: R − r) e a r dalla retta
   dalla parte n; fra le due soluzioni quella che sceglie pick(c) (la più piccola) */
function filletCL(C, R, inner, L, n, r, pick) {
  const sols = lineCircle(shift(L, n, r), C, inner ? R - r : R + r);
  sols.sort((a, b) => pick(a) - pick(b));
  const c = sols[0], u = unit(sub(c, C));
  return { c, r, t1: add(C, mul(u, R)), t2: foot(L, c) };
}
/* punti di un arco da a a b attorno a c, nel verso cw (orario) o antiorario, con freccia massima chord */
function arcPts(c, a, b, cw, chord) {
  const r = len(sub(a, c));
  let a0 = Math.atan2(a[1] - c[1], a[0] - c[0]), a1 = Math.atan2(b[1] - c[1], b[0] - c[0]);
  let da = a1 - a0;
  if (cw) { while (da > 0) da -= 2 * Math.PI; } else { while (da < 0) da += 2 * Math.PI; }
  const step = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - chord / r)));
  const n = Math.max(1, Math.ceil(Math.abs(da) / Math.max(step, 1e-6)));
  const out = [];
  for (let i = 1; i <= n; i++) { const t = a0 + (da * i) / n; out.push([c[0] + r * Math.cos(t), c[1] + r * Math.sin(t)]); }
  return out;
}

/* ---- rotaie ----------------------------------------------------------------
   Costruzione della 60E1 (metà destra, dall'alto in senso orario), quote in mm:
   fungo  R300 fino a x 10,25 (20,5) → R80 fino a 26,05 (52,1) → R13 → fianco 1:20 largo 72 a 14,3 sotto
          il piano di rotolamento → R3 → piano di steccatura 1:2,75 (prolungato incontra l'asse a 51 sotto
          la cima) → R7 → R35 → R120 per 19,5 in altezza fino all'anima;
   anima  diritta, spessa 16,5, da 92,3 a 60,3 sopra la base (32, centrata a 76,3);
   suola  R120 per 19,5 → R35 → R7 → piano di steccatura 1:2,75 (all'asse a 31,5) → R40 → falda 1:14 fino al
          bordo alto 11,5, largo 150 → R4 → bordo verticale → R2 → base.                                    */
function build60E1() {
  const H = 172, half = 75, web = 16.5 / 2;
  // fungo: R300 → R80 → R13 (tutti convessi, centri dentro il fungo)
  const C300 = [0, H - 300];
  const P1 = [10.25, C300[1] + Math.sqrt(300 * 300 - 10.25 * 10.25)];
  const C80 = add(C300, mul(unit(sub(P1, C300)), 300 - 80));
  const P2 = [26.05, C80[1] + Math.sqrt(80 * 80 - (26.05 - C80[0]) ** 2)];
  const C13 = add(C80, mul(unit(sub(P2, C80)), 80 - 13));
  // fianco 1:20 (scende allargandosi) tangente a R13 dalla parte esterna
  const sideD = unit([1 / 20, -1]), sideN = perp(sideD);                         // normale verso l'esterno (+x)
  const side = line(add(C13, mul(sideN, 13)), sideD);
  const T3 = foot(side, C13);
  // piano di steccatura del fungo: per (0, H − 51), sale verso l'esterno con pendenza 1:2,75
  const headF = line([0, H - 51], [2.75, 1]);
  // R3 fra fianco e steccatura (centro dentro il fungo: a −x dal fianco, sopra la steccatura)
  const r3 = filletLL(side, mul(sideN, -1), headF, unit(perp(headF.d)), 3);
  // anima: diritta a x = 8,25 fra 60,3 e 92,3; R120 tangente in cima e in fondo, alta 19,5
  const wTop = [web, 92.3], wBot = [web, 60.3];
  const C120a = [web + 120, 92.3], C120b = [web + 120, 60.3];
  const Q1 = [C120a[0] - Math.sqrt(120 * 120 - 19.5 * 19.5), 92.3 + 19.5];   // fine dell'R120 alto
  const Q2 = [Q1[0], 60.3 - 19.5];                                              // fine dell'R120 basso
  // R35 tangente all'R120 (concavi, centri fuori dal materiale: interni all'R120)
  const C35a = add(C120a, mul(unit(sub(Q1, C120a)), 120 - 35));
  const C35b = add(C120b, mul(unit(sub(Q2, C120b)), 120 - 35));
  // R7 fra R35 e la steccatura del fungo (concavo: sotto la retta, interno all'R35, il più vicino all'anima)
  const r7a = filletCL(C35a, 35, true, headF, unit(perp(headF.d)).map((v) => -v), 7, (c) => c[0]);
  // suola: steccatura per (0; 31,5) che scende verso l'esterno 1:2,75; falda 1:14 fino a (75; 11,5)
  const footF = line([0, 31.5], [2.75, -1]);
  const footN = unit(perp(footF.d));                                            // normale verso l'alto (fuori)
  const r7b = filletCL(C35b, 35, true, footF, footN, 7, (c) => c[0]);
  const slope14 = line([half, 11.5], [-14, 1]);
  const s14N = unit(perp(slope14.d)).map((v) => -v);                            // normale verso l'alto
  const r40 = filletLL(footF, footN, slope14, s14N, 40);
  // R4 fra falda e bordo verticale, R2 fra bordo e base (convessi, centri dentro la suola)
  const edge = line([half, 0], [0, 1]);
  const r4 = filletLL(slope14, mul(s14N, -1), edge, [-1, 0], 4);
  const base = line([0, 0], [1, 0]);
  const r2 = filletLL(edge, [-1, 0], base, [0, 1], 2);
  return { H, C300, P1, C80, P2, C13, side, T3, headF, r3, wTop, wBot, C120a, C120b, Q1, Q2, C35a, C35b, r7a, footF, r7b, slope14, r40, r4, r2 };
}
/* contorno chiuso (mm), antiorario, freccia massima chord sugli archi */
function outline60E1(chord) {
  const g = build60E1(), R = [[0, g.H]];
  const push = (pts) => { for (const p of pts) R.push(p); };
  push(arcPts(g.C300, R[R.length - 1], g.P1, true, chord));
  push(arcPts(g.C80, g.P1, g.P2, true, chord));
  push(arcPts(g.C13, g.P2, g.T3, true, chord));
  R.push(g.r3.t1); push(arcPts(g.r3.c, g.r3.t1, g.r3.t2, true, chord));
  R.push(g.r7a.t2); push(arcPts(g.r7a.c, g.r7a.t2, g.r7a.t1, false, chord));
  push(arcPts(g.C35a, g.r7a.t1, g.Q1, false, chord));
  push(arcPts(g.C120a, g.Q1, g.wTop, false, chord));
  R.push(g.wBot); push(arcPts(g.C120b, g.wBot, g.Q2, false, chord));
  push(arcPts(g.C35b, g.Q2, g.r7b.t1, false, chord));
  push(arcPts(g.r7b.c, g.r7b.t1, g.r7b.t2, false, chord));
  R.push(g.r40.t1); push(arcPts(g.r40.c, g.r40.t1, g.r40.t2, false, chord));
  R.push(g.r4.t1); push(arcPts(g.r4.c, g.r4.t1, g.r4.t2, true, chord));
  R.push(g.r2.t1); push(arcPts(g.r2.c, g.r2.t1, g.r2.t2, true, chord));
  R.push([0, 0]);
  // metà destra dall'alto in basso (orario) + metà sinistra specchiata dal basso in alto, poi antiorario
  const right = R.filter((p, i) => i === 0 || len(sub(p, R[i - 1])) > 1e-9);
  const left = right.slice(1, -1).reverse().map((p) => [-p[0], p[1]]);
  return right.concat(left).reverse();
}

export const RAILS = {
  "60E1": {
    label: "60E1 (UIC 60)", std: "EN 13674-1",
    h: 172, foot: 150, head: 72, web: 16.5,
    area: 7670, mass: 60.21, yNeutral: 80.9,              // pubblicati: cm² 76,70, kg/m 60,21, asse neutro dal disegno
    gaugeDepth: 14,                                        // lo scartamento si misura 14 mm sotto il piano di rotolamento
    outlineMm: outline60E1,
  },
};
export const RAIL_TYPES = Object.keys(RAILS);
/* contorno della rotaia in metri, antiorario: x (0 = asse), y (0 = base della suola); chord in metri */
export function railOutline(type, chord = 0.0003) {
  const R = RAILS[type];
  if (!R) throw new Error("rail type " + type);
  return R.outlineMm(chord * 1000).map(([x, y]) => [x / 1000, y / 1000]);
}
/* area, baricentro e momenti d'inerzia (rispetto agli assi baricentrici) di un poligono semplice */
export function sectionProps(P) {
  let A = 0, cx = 0, cy = 0, ixx = 0, iyy = 0;
  for (let i = 0; i < P.length; i++) {
    const [x0, y0] = P[i], [x1, y1] = P[(i + 1) % P.length], k = x0 * y1 - x1 * y0;
    A += k; cx += (x0 + x1) * k; cy += (y0 + y1) * k;
    ixx += (y0 * y0 + y0 * y1 + y1 * y1) * k; iyy += (x0 * x0 + x0 * x1 + x1 * x1) * k;
  }
  A /= 2; cx /= 6 * A; cy /= 6 * A;
  return { A: Math.abs(A), cx, cy, Ix: Math.abs(ixx / 12) - Math.abs(A) * cy * cy, Iy: Math.abs(iyy / 12) - Math.abs(A) * cx * cx };
}
/* larghezza del fungo a una quota y (mm dalla base), sul fianco 1:20: serve allo scartamento */
export function headHalfWidthAt(type, y) {
  if (type !== "60E1") throw new Error("rail type " + type);
  const g = build60E1(), t = (y - g.side.p[1]) / g.side.d[1];
  return g.side.p[0] + g.side.d[0] * t;
}

/* ---- traverse --------------------------------------------------------------
   Forma di partenza (scheda RFI 240 VN): profilo della faccia superiore lungo la traversa (s dalla testata,
   altezza dalla base), base b1 e faccia superiore b2 (pianta), in mm, per mezza traversa. Le spalle attorno
   agli inserti sono piene per tutta la larghezza (semplificazione: massa +2,5 % rispetto alla scheda).        */
const RFI240_HALF = {
  // s: da testata; h: faccia superiore; b1: base; b2: faccia superiore
  pts: [
    { s: 0, h: 166, b1: 222, b2: 190 },     // testata (sformo: la cima è 15 mm più in dentro, vedi top0)
    { s: 43, h: 209, b1: 300, b2: 260 },    // fine degli smussi (in pianta e in alto)
    { s: 178, h: 233, b1: 300, b2: 269 },   // spalla esterna
    { s: 300, h: 233, b1: 300, b2: 269 },
    { s: 322, h: 226, b1: 300, b2: 269 },   // sede della rotaia, lato esterno (1:20)
    { s: 556, h: 214, b1: 300, b2: 269 },   // sede della rotaia, lato interno
    { s: 580, h: 225, b1: 300, b2: 269 },   // spalla interna
    { s: 647, h: 225, b1: 300, b2: 269 },
    { s: 700, h: 207, b1: 300, b2: 269 },   // inizio della rastremazione
    { s: 1000, h: 196, b1: 250, b2: 195 },  // zona centrale
    { s: 1200, h: 195, b1: 250, b2: 195 },  // mezzeria
  ],
  seat: 439,                                 // centro della sede della rotaia dalla testata
  top0: 15,                                  // sformo delle testate (la faccia superiore comincia 15 mm più in dentro)
};
export const PAD = 5;                        // piastra sotto la rotaia (mm): quote degli attacchi «a 5 mm dal piano di ferratura»
export const SEAT_SLOPE = 1 / 20;
export const SLEEPERS = {
  RFI240: { label: "RFI 240", std: "RFI TCAR SF AR 03 002 F", L: 2400, b1: 300, bMid: [250, 300], hSeat: [215, 220], hMid: 190, massMin: 300, mass: 316, massSrc: "Margaritelli RFI 240 VN", pitch: 600 },
  RFI230: { label: "RFI 230", std: "RFI TCAR SF AR 03 002 F", L: 2300, b1: 300, bMid: [240, 260], hSeat: [170, 190], hMid: 150, massMin: 225, pitch: 600 },
  RFI260: { label: "RFI 260", std: "RFI TCAR SF AR 03 002 F", L: 2600, b1: 300, bMid: [240, 300], hSeat: [220, 230], hMid: 190, massMin: 350, pitch: 600 },
};
export const SLEEPER_TYPES = Object.keys(SLEEPERS);
/* profilo di mezza traversa di un tipo: la forma della 240 adattata alla lunghezza (sedi ferme a ±(L/2 − seat))
   e alle altezze della specifica (massime: sottorotaia, minima: mezzeria) */
export function sleeperHalf(type) {
  const T = SLEEPERS[type];
  if (!T) throw new Error("sleeper type " + type);
  const base = RFI240_HALF, seatC = 1200 - base.seat;                          // 761: centro della sede dall'asse
  const out = T.L / 2 - seatC;                                                   // sbalzo: testata → centro della sede
  // la sede (lunga 234, da 322 a 556 nella 240) e ciò che sta dentro restano uguali; si scala solo il tratto testata → sede
  const seat0 = 322, kOut = (out - (base.seat - seat0)) / seat0;
  // altezze: sotto rotaia il massimo della specifica, in mezzeria il minimo (mai sotto la forma della 240 scalata)
  const kSeat = T.hSeat[1] / 220, hMid = Math.max(T.hMid, 195 * kSeat);
  return {
    seat: out, top0: base.top0,
    pts: base.pts.map((p) => ({
      s: p.s <= seat0 ? p.s * kOut : p.s + (out - base.seat),                    // fuori dalla sede si scala, dentro no
      h: p.h * (p.s >= 700 ? hMid / 195 : kSeat),
      b1: p.b1, b2: p.b2,                                                        // base 300 e 250 in mezzo: dentro i limiti di tutti e tre
    })),
  };
}
/* solido della traversa: vertici (m) e triangoli; x lungo la traversa (0 = mezzeria, + verso la testata destra),
   y di traverso (lungo il binario), z in alto (0 = base). Sezioni trapezie (base b1, cima b2) ai punti del profilo,
   specchiate; testate con lo sformo. Contorno chiuso, normali verso l'esterno.                                   */
export function sleeperMesh(type) {
  const half = sleeperHalf(type), T = SLEEPERS[type], L2 = T.L / 2;
  const P = half.pts;
  // sezioni da sinistra (x = −L/2) a destra (x = +L/2)
  const secs = [];
  for (const p of P) secs.push({ x: -(L2 - p.s), ...p });
  for (let i = P.length - 2; i >= 0; i--) secs.push({ x: L2 - P[i].s, ...P[i] });
  const pos = [], idx = [];
  for (const [k, q] of secs.entries()) {
    const end = k === 0 ? 1 : k === secs.length - 1 ? -1 : 0;   // testate: la cima rientra di top0
    const xt = q.x + end * half.top0;
    pos.push(q.x / 1000, -q.b1 / 2000, 0, q.x / 1000, q.b1 / 2000, 0, xt / 1000, q.b2 / 2000, q.h / 1000, xt / 1000, -q.b2 / 2000, q.h / 1000);
  }
  const n = secs.length;
  for (let k = 0; k + 1 < n; k++) {
    const a = 4 * k, b = 4 * (k + 1);
    const quad = (i0, i1, j1, j0) => idx.push(a + i0, b + j1, b + j0, a + i0, a + i1, b + j1);   // normali verso l'esterno
    quad(0, 1, 1, 0); quad(1, 2, 2, 1); quad(2, 3, 3, 2); quad(3, 0, 0, 3);
  }
  const e0 = 0, e1 = 4 * (n - 1);
  idx.push(e0 + 0, e0 + 2, e0 + 1, e0 + 0, e0 + 3, e0 + 2);      // testata sinistra (verso −x)
  idx.push(e1 + 0, e1 + 1, e1 + 2, e1 + 0, e1 + 2, e1 + 3);      // testata destra (verso +x)
  // centro della sede della rotaia: x dall'asse della traversa, z della faccia superiore lì
  return { pos, idx, seatX: (L2 - half.seat) / 1000, seatZ: interpH(P, half.seat) / 1000 };
}
function interpH(P, s) {
  for (let i = 0; i + 1 < P.length; i++) if (s >= P[i].s && s <= P[i + 1].s) { const t = (s - P[i].s) / (P[i + 1].s - P[i].s || 1); return P[i].h + t * (P[i + 1].h - P[i].h); }
  return P[P.length - 1].h;
}
/* ---- campi per il modulo Pset (tools/common/pset-core.js) — F3 --------------------------------------------------
   Tipi di oggetto dell'IFC: «project» (IfcProject) e «site» (IfcSite) dalla 0.4.1, «track» (il binario, IfcRailwayPart .TRACK.), «rail» (una rotaia di un tratto, IfcRail),
   «sleeper» (una traversa, IfcTrackElement .SLEEPER.), «ballast» (il ballast di un tratto con gli intasi, IfcCourse
   .BALLASTBED.). PSET_FIELDS = i campi che un modello può usare, coi tipi di oggetto che li hanno e il tipo IFC
   proposto; i valori li dà track-core.js psetValues */
export const PSET_KINDS = ["project", "site", "track", "rail", "sleeper", "ballast"];
const PK_ALL = ["track", "rail", "sleeper", "ballast"], PK_RUN = ["track", "rail", "ballast"];
export const PSET_FIELDS = [
  { key: "prj", kinds: ["project", "site"], type: "label" }, { key: "nTr", kinds: ["project"], type: "int" },
  { key: "track", kinds: PK_ALL, type: "label" }, { key: "part", kinds: ["rail", "sleeper", "ballast"], type: "int" },
  { key: "from", kinds: PK_RUN, type: "length" }, { key: "to", kinds: PK_RUN, type: "length" }, { key: "length", kinds: ["project", ...PK_RUN], type: "length" },
  { key: "side", kinds: ["rail"], type: "label" }, { key: "rail", kinds: ["project", "track", "rail"], type: "label" }, { key: "kgm", kinds: ["rail"], type: "real" },
  { key: "kg", kinds: ["rail", "sleeper"], type: "real" }, { key: "railKg", kinds: ["project", "track"], type: "real" }, { key: "tilt", kinds: ["rail"], type: "label" },
  { key: "sleeper", kinds: ["project", "track", "sleeper", "ballast"], type: "label" }, { key: "pitch", kinds: ["sleeper", "ballast"], type: "length" },
  { key: "num", kinds: ["sleeper"], type: "int" }, { key: "sta", kinds: ["sleeper"], type: "length" },
  { key: "E", kinds: ["site", "sleeper"], type: "length" }, { key: "N", kinds: ["site", "sleeper"], type: "length" }, { key: "zBase", kinds: ["sleeper"], type: "length" },
  { key: "cant", kinds: ["sleeper"], type: "length" }, { key: "volC", kinds: ["sleeper"], type: "volume" },
  { key: "nSl", kinds: ["project", "track", "ballast"], type: "int" }, { key: "vol", kinds: ["project", "track", "ballast"], type: "volume" },
  { key: "volBed", kinds: ["ballast"], type: "volume" }, { key: "volCrib", kinds: ["ballast"], type: "volume" }, { key: "bottom", kinds: ["ballast"], type: "label" },
  { key: "crest", kinds: ["ballast"], type: "length" }, { key: "crestH", kinds: ["ballast"], type: "length" }, { key: "slope", kinds: ["ballast"], type: "ratio" },
  { key: "depth", kinds: ["ballast"], type: "length" }, { key: "form", kinds: ["ballast"], type: "real" }, { key: "sub", kinds: ["ballast"], type: "length" },
  { key: "between", kinds: ["ballast"], type: "label" }, { key: "fall", kinds: ["ballast"], type: "label" }, { key: "cutL", kinds: ["ballast"], type: "length" }, { key: "cutR", kinds: ["ballast"], type: "length" },
];
/* calcestruzzo armato precompresso delle traverse (kg/m³): per la massa quando la scheda del tipo non la dà */
export const CONCRETE_KG_M3 = 2400;

/* volume di una mesh chiusa (m³) */
export function meshVolume(pos, idx) {
  let V = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = 3 * idx[i], b = 3 * idx[i + 1], c = 3 * idx[i + 2];
    V += pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) - pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) + pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c]);
  }
  return V / 6;
}
