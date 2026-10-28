/* =========================================================================
   Trazione elettrica (Railway OCS) — famiglie RFI del catalogo Revit (tool 18, 0.17.0)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   La geometria delle famiglie Revit del catalogo RFI dell'utente, rifatta in JS dagli
   STESSI generatori (sessione 18: 18.REVIT MCP\famiglie\…\genera.py e _lib_rfi.py,
   commit a58f2f2 del 2026-10-15) con le stesse tabelle e le stesse forme, così la
   vista 3D e l'IFC del sito coincidono con quello che l'add-in ViewIFC piazza in
   Revit (PIANO_Trazione_Elettrica.md §23). Scelte dell'utente (2026-10-15):
   generatori in JS, tutto pubblico, forma dalle famiglie e quote dal tool.
   - pali: RFI_Sostegno_LSU14-16 / _LSU18-22 = plinto RFI_Plinto_LSU (tipo = la
     fondazione del tool, C1 del tool), palo RFI_Palo_LSUnnx (piastra 90 mm sopra
     il pilastrino, 2 UPN, fazzoletti, traliccio di tondi piegati, tirafondi e
     dima), attacco della mensola RFI_AttaccoMensola_E66013_<serie>, staffa del
     tirante RFI_AttaccoTirante_E66013_<serie>, mensola RFI_Mensola_D76x5 (tubo
     76,1 × 5) e tiranti RFI_Tirante_D24 (barra 24 × 24); quota della mensola,
     dislivello e attacco dei tiranti, lunghezza della mensola: quelli del tool;
   - portali: RFI_Portale_MEC_C19/20/21 (piloni E 65041, attacchi E 65110, trave
     MEC tipo C = CL2 + CCn + CL2, fondazioni P2MEC), RFI_Portale_Tralicciato
     (piloni E 65018 H9586, trave tralicciata 1BIN / 2BIN, fondazioni POT) e
     RFI_Portale_Ormeggio (stessi piloni, trave E 65109 = nL + nC + nL): la famiglia
     e il tipo che sceglie il catalogo (ocs-catalog rfiPortalOf, come l'add-in);
     dalle famiglie del 2026-10-22 (0.23.0) travi con l'intradosso a +6820 e sotto
     la trave le sospensioni SEGNAPOSTO (genera_portali.py): tubo, mensola, tirante,
     staffaggio, una per binario servito alla quota della mensola dal filo del tool;
   - dal catalogo del 2026-10-27 (0.24.0): serie LSU24 (piastra 680 × 730), le varianti dei sostegni con due mensole
     sulla staffa doppia (_2M), senza mensola (_SM) e la sola mensola su un sostegno esistente (RFI_SoloMensola_*), i pali
     doppi senza mensola RFI_PaloDoppio_2xLSU24 (P24D, calastrelli) e _2xLSU22 (P8D), i portali MEC tipo C su 2 × LSU22
     RFI_Portale_MEC_C_2xLSU22 (travi C15 … C27, attacco E 64906 c, trave a +7100).
   Tre livelli di dettaglio come il fusto del tool: «box» (fusti e travi pieni),
   «upn» (profili senza traliccio, controventi, tirafondi) e «lattice» (tutto).
   Niente DOM; importa solo il motore. Misure dei generatori in mm (come nei .py,
   per confrontarli riga per riga), solidi in uscita in METRI:
     { t: "ext", o, u, n, loop: [[u, v]…], holes: [[u, v, r]…], d }  contorno sul piano per o
       (u lungo u, v lungo n × u) estruso per d lungo n (prism, plane_extrusion, angle);
     { t: "bar", a, b, r, ri }  tondo pieno (ri = 0) o tubo da a a b (round_bar);
     { t: "sweep", pts, r, len }  tondo di raggio r lungo la spezzata pts (tondi piegati:
       rette + archi a punti), len = lunghezza vera del percorso (rette + archi);
   ognuno con sub (sottocategoria della famiglia) e l = [da, a] livelli (0 box, 1 upn,
   2 lattice) in cui c'è.
   ========================================================================= */
import * as C from "./ocs-core.js?v=0.24.0";

export const LOD_INDEX = { box: 0, upn: 1, lattice: 2 };
const ALL = [0, 2], BOX = [0, 0], DET = [1, 2], LAT = [2, 2];
export const STEEL_KG_M3 = 7850;

/* ---- vettori ---------------------------------------------------------------------------------------- */
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a) => Math.hypot(a[0], a[1], a[2]);
const unit = (a) => mul(a, 1 / norm(a));
const X = [1, 0, 0], Y = [0, 1, 0], Z = [0, 0, 1];
const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];

/* ---- primitive di _lib_rfi.py (mm) ------------------------------------------------------------------------ */
function builder() {
  const out = [];
  let cur = { sub: "", l: ALL };
  const B = {
    out,
    set(s, l = ALL) { cur = { sub: s, l }; return B; },
    /* plane_extrusion: contorno (u, v) sul piano per o, u lungo xd, v lungo n × xd, estruso per d lungo n */
    ext(o, xd, n, loop, d, holes = []) { out.push({ t: "ext", o, u: xd, n, loop, holes, d, sub: cur.sub, l: cur.l }); return B; },
    /* prism: estrusione verticale da z0 a z1 */
    prism(loop, z0, z1, holes = []) { return B.ext([0, 0, z0], X, Z, loop, z1 - z0, holes); },
    /* round_bar: tondo (o tubo con ri) da a a b */
    bar(a, b, r, ri = 0) { out.push({ t: "bar", a, b, r, ri, sub: cur.sub, l: cur.l }); return B; },
    /* angle: angolare L l1 × l2 × t dritto da a a b, allungato di ext ai due capi; il tallone sulla linea a-b, la
       prima ala lungo u1 (resa ⟂ all'asse), la seconda lungo asse × u1 */
    angle(a, b, l1, l2, t, u1, ext = 0) {
      const d = unit(sub(b, a)), u = unit(sub(u1, mul(d, dot(u1, d))));
      const L = norm(sub(b, a)) + 2 * ext;
      return B.ext(sub(a, mul(d, ext)), u, d, [[0, 0], [l1, 0], [l1, t], [t, t], [t, l2], [0, l2]], L);
    },
    sweep(pts, r, len) { out.push({ t: "sweep", pts, r, len, sub: cur.sub, l: cur.l }); return B; },
  };
  return B;
}
const toM = (s) => {
  const m = (v) => v.map((x) => x / 1000);
  if (s.t === "ext") return { ...s, o: m(s.o), loop: s.loop.map(m), holes: s.holes.map(m), d: s.d / 1000 };
  if (s.t === "bar") return { ...s, a: m(s.a), b: m(s.b), r: s.r / 1000, ri: s.ri / 1000 };
  return { ...s, pts: s.pts.map(m), r: s.r / 1000, len: s.len / 1000 };
};

/* ---- sostegni su pali LSU (sostegni_LSU/genera.py) ------------------------------------------------------- */
/* Riferimento dei pezzi del palo: origine sull'asse del palo alla TESTA DEL PILASTRINO (nella famiglia Z_PIL =
   250 sul supercompattato; qui 0, perché il tool la mette dove vuole: supercompattato + pilOut), X lungo il binario,
   Y via dal binario (il binario sta verso −Y), Z in alto */
const Z_PIASTRA = 90;            // piastra del palo 90 sopra la testa del pilastrino (E 66013 c)
export const GROUT = Z_PIASTRA / 1000;
const SBALZO = 115;              // dalla faccia del palo al perno dell'attacco della mensola (E 66013 c f.70-71)
const SPORGENZA_STAFFA = 40;     // dalla faccia del palo al bullone del tirante sulla staffa (E 66013 c f.78)
const PASSO = 266;               // traliccio: distanza verticale fra due incroci
/* serie di pali (E 66013 c): semilarghezza, UPN (h, b, tw, tf), piastra, raggio dei fori, fazzoletti, tondi,
   tirafondi (raggio), dima (ala, spessore) */
export const SERIE = {
  LSU14: { w2: 150, upn: [140, 60, 7, 10], piastra: 25, foro: 30, gx: [-52, 52], gw: 120, r_tondo: 10, r_piega: 75, r_tf: 21, dima: [120, 12] },
  LSU16: { w2: 150, upn: [160, 65, 7.5, 10.5], piastra: 30, foro: 30, gx: [-62, 62], gw: 120, r_tondo: 10, r_piega: 75, r_tf: 21, dima: [120, 12] },
  LSU18: { w2: 200, upn: [180, 70, 8, 11], piastra: 35, foro: 32, gx: [-84, 0, 84], gw: 80, r_tondo: 11, r_piega: 75, r_tf: 22.5, dima: [150, 15] },
  LSU20: { w2: 200, upn: [200, 75, 8.5, 11.5], piastra: 40, foro: 35, gx: [-94, 0, 94], gw: 80, r_tondo: 11, r_piega: 85, r_tf: 26, dima: [150, 15] },
  LSU22: { w2: 200, upn: [220, 80, 9, 12.5], piastra: 40, foro: 35, gx: [-104, 0, 104], gw: 80, r_tondo: 12, r_piega: 90, r_tf: 26, dima: [150, 15] },
  // 0.24.0 (catalogo del 2026-10-27, E 66013 c f.23, f.25): piastra 680 (X) × 730 (Y), fori e tirafondi Ø52 su 500 × 550,
  // fazzoletti 150 × 300 × 15
  LSU24: { w2: 200, upn: [240, 85, 9.5, 13], piastra: 45, foro: 35, gx: [-100, 100], gw: 150, gh: 300, gt: 15, r_tondo: 12, r_piega: 95, r_tf: 26, dima: [150, 15], lastra: [340, 365], fori: [250, 275] },
};
// le serie senza lastra / fori / gh / gt (genera.py): piastra 580 × 580, fori e tirafondi su 400 × 400, fazzoletti alti 200 × 12
for (const sr of Object.values(SERIE)) Object.assign(sr, { lastra: [290, 290], fori: [200, 200], gh: 200, gt: 12, ...sr });
export const PALI_L = { a: 8200, b: 9600, c: 12000 };
/* attacchi per mensola in acciaio (E 66013 c f.68-78): px, H, X max dei bulloni, a, b, c (pos. 13 di LSU22 ASSUNTA) */
export const ATTACCHI = {
  LSU14: { px: 180, H: 118, xmax: 80, a: 174, b: 115, c: 158 },
  LSU16: { px: 180, H: 118, xmax: 80, a: 194, b: 120, c: 178 },
  LSU18: { px: 220, H: 129, xmax: 100, a: 214, b: 125, c: 198 },
  LSU20: { px: 220, H: 129, xmax: 100, a: 234, b: 130, c: 218 },
  LSU22: { px: 240, H: 129, xmax: 118, a: 254, b: 135, c: 238 },
  LSU24: { px: 260, H: 129, xmax: 128, a: 274, b: 140, c: 258 },   // pos. 13 allargata all'UPN 240, staffa +20 (ASSUNTO)
};
export const MENS_R = [38.05, 33.05];         // tubo 76,1 × 5 (E 13619 o)
export const TIE_SIDE = 24;                    // tirante: barra 24 × 24

/* UPN (h, b, tw, tf) con l'anima sulla faccia Y = s·w2 e le ali verso l'interno */
function upnPts(s, upn, w2) {
  const h = upn[0] / 2, b = upn[1], tw = upn[2], tf = upn[3];
  const pts = [[-h, -w2], [h, -w2], [h, -w2 + b], [h - tf, -w2 + b], [h - tf, -w2 + tw], [-h + tf, -w2 + tw], [-h + tf, -w2 + b], [-h, -w2 + b]];
  return s > 0 ? pts.slice().reverse().map(([x, y]) => [x, -y]) : pts;
}
/* scostamento dei vertici e angolo tali che il raccordo di raggio rp abbia l'asse del tondo a y_piega */
function waveGeometry(yp, rp) {
  let a = yp + 20;
  for (let i = 0; i < 50; i++) { const al = Math.atan(PASSO / (2 * a)); a = yp + rp * (1 / Math.sin(al) - 1); }
  return [a, Math.atan(PASSO / (2 * a))];
}
const ARC_STEP = Math.PI / 8;                 // archi dei tondi piegati a punti ogni 22,5°
/* tondo piegato a onda nel piano X = xs: rette + archi di raggio rp (wave_bar) */
function waveBar(B, xs, phase, z0, n, yp, r, rp) {
  const [a, al] = waveGeometry(yp, rp);
  const vert = (k) => [xs, phase * (k % 2 === 0 ? 1 : -1) * a, z0 + k * PASSO];
  const t = rp / Math.tan(al), dc = rp / Math.sin(al), turn = Math.PI - 2 * al, na = Math.max(2, Math.ceil(turn / ARC_STEP - 1e-9));
  const pts = [vert(0)];
  let cur = vert(0), len = 0;
  for (let k = 1; k < n; k++) {
    const V = vert(k), dA = unit(sub(vert(k - 1), V)), dC = unit(sub(vert(k + 1), V));
    const T1 = add(V, mul(dA, t)), T2 = add(V, mul(dC, t)), c = add(V, mul(unit(add(dA, dC)), dc));
    const e1 = unit(sub(T1, c)), w = sub(T2, c), e2 = unit(sub(w, mul(e1, dot(w, e1))));
    len += norm(sub(T1, cur)) + rp * turn;
    pts.push(T1);
    for (let j = 1; j < na; j++) { const th = (turn * j) / na; pts.push(add(c, add(mul(e1, rp * Math.cos(th)), mul(e2, rp * Math.sin(th))))); }
    pts.push(T2);
    cur = T2;
  }
  len += norm(sub(vert(n), cur));
  pts.push(vert(n));
  B.sweep(pts, r, len);
}
/* palo LSU alto Lp con piastra, fazzoletti, traliccio e ancoraggio (build_palo); z = 0 sulla testa del pilastrino */
function paloSolids(se, Lp) {
  const sr = SERIE[se], B = builder(), upn = sr.upn, w2 = sr.w2, r = sr.r_tondo;
  const z_f0 = Z_PIASTRA + sr.piastra, z_f1 = z_f0 + Lp;
  const luce = w2 - upn[1], y_piega = luce - r, x_tondi = upn[0] / 2 - r, [lx, ly] = sr.lastra, [fx, fy] = sr.fori;
  B.set("Piastra base").prism(rect(-lx, lx, -ly, ly), Z_PIASTRA, z_f0, [-fx, fx].flatMap((x) => [-fy, fy].map((y) => [x, y, sr.foro])));
  B.set("Fusto UPN", BOX).prism(rect(-upn[0] / 2, upn[0] / 2, -w2, w2), z_f0, z_f1);
  B.set("Fusto UPN", DET);
  for (const s of [-1, 1]) B.prism(upnPts(s, upn, w2), z_f0, z_f1);
  const gw = sr.gw, gh = sr.gh, gt = sr.gt, gusset = [[0, 30], [30, 0], [gw, 0], [gw, 50], [30, gh], [0, gh]];
  B.set("Piastra base", LAT);
  for (const s of [-1, 1]) for (const xc of sr.gx) B.ext([xc - (gt / 2) * s, s * w2, z_f0], [0, s, 0], [s, 0, 0], gusset, gt);
  const z0 = z_f0 + 40, nseg = Math.floor((z_f1 - 21 - 40 - z0) / PASSO);
  B.set("Traliccio", LAT);
  for (const xs of [-x_tondi, x_tondi]) {
    for (const phase of [-1, 1]) waveBar(B, xs, phase, z0, nseg, y_piega, r, sr.r_piega);
    B.bar([xs, -luce, z_f1 - 21], [xs, luce, z_f1 - 21], r);
  }
  // ancoraggio: 4 tirafondi L 1200 su 400 × 400 (LSU24: 500 × 550; 290 sopra il pilastrino, 910 sotto) e dima di 4 profili L
  const z_tf0 = -910, z_tf1 = 290;
  B.set("Tirafondi", LAT);
  for (const x of [-fx, fx]) for (const y of [-fy, fy]) B.bar([x, y, z_tf0], [x, y, z_tf1], sr.r_tf);
  const [la, ta] = sr.dima, zc = z_tf0 + 150;
  for (const s of [-1, 1]) {
    const yi = s * (fy - la / 2), ye = s * (fy + la / 2), xi = s * (fx - la / 2), xe = s * (fx + la / 2);
    B.prism(rect(-lx, lx, Math.min(yi, ye), Math.max(yi, ye)), zc, zc + ta);
    B.prism(rect(-lx, lx, Math.min(ye, ye - s * ta), Math.max(ye, ye - s * ta)), zc + ta, zc + la);
    B.prism(rect(Math.min(xi, xe), Math.max(xi, xe), -ly, ly), zc - ta, zc);
    B.prism(rect(Math.min(xe, xe - s * ta), Math.max(xe, xe - s * ta), -ly, ly), zc - la, zc - ta);
  }
  return B.out;
}
/* attacco della mensola (pos. 1 / 12): piastra a X sulla faccia del palo, 4 bulloni a gancio M16, corpo, forcella e
   perno a SBALZO dalla faccia (build_attacco); z = 0 sull'asse della mensola */
function attaccoSolids(se) {
  const sr = SERIE[se], a = ATTACCHI[se], B = builder().set("Attacco mensola");
  const yf = -sr.w2, upn = sr.upn, hz = a.H / 2, xb = Math.min(upn[0] / 2 + 8, a.xmax), org = [0, yf, 0];
  const w = 30, e = a.px / 2 - xb;
  const arm = (x0, z0, x1, z1) => {
    const dx = x1 - x0, dz = z1 - z0, Lb = Math.hypot(dx, dz), ux = dx / Lb, uz = dz / Lb, nx = (-uz * w) / 2, nz = (ux * w) / 2;
    return [[x0 - ux * e + nx, z0 - uz * e + nz], [x1 + ux * e + nx, z1 + uz * e + nz], [x1 + ux * e - nx, z1 + uz * e - nz], [x0 - ux * e - nx, z0 - uz * e - nz]];
  };
  for (const loop of [arm(-xb, -hz, xb, hz), arm(-xb, hz, xb, -hz)]) B.ext(org, X, [0, -1, 0], loop, 15);
  const y_ali = yf + upn[1];
  for (const x of [-xb, xb]) for (const dz of [-hz, hz]) {
    B.bar([x, yf - 15 - 25, dz], [x, y_ali + 10, dz], 8);
    B.bar([x, y_ali + 10, dz], [x - Math.sign(x) * 25, y_ali + 10, dz], 8);
  }
  const y_p = yf - SBALZO;
  B.ext([0, yf - 15, 0], X, [0, -1, 0], rect(-25, 25, -40, 40), SBALZO - 46 - 15);
  for (const s of [-1, 1]) { const z0 = s * 62.5; B.prism(rect(-20, 20, y_p - 15, yf - SBALZO + 46), Math.min(z0, z0 - s * 15), Math.max(z0, z0 - s * 15)); }
  B.bar([0, y_p, -72], [0, y_p, 72], 7);
  return B.out;
}
/* staffa del tirante (f.77-78): angolare L 80 × 10, 2 orecchie con il bullone M16 a SPORGENZA_STAFFA dalla faccia,
   collare a U Ø16 (build_staffa); z = 0 alla quota dell'attacco del tirante sul palo */
function staffaSolids(se) {
  const sr = SERIE[se], a = ATTACCHI[se], B = builder().set("Attacco tirante"), yf = -sr.w2, ha = a.a / 2;
  B.prism(rect(-ha, ha, yf - 10, yf), -40, 40);
  B.prism(rect(-ha, ha, yf - 45, yf - 10), 30, 40);
  for (const xs of [-17.5, 17.5]) B.prism(rect(xs - 5, xs + 5, yf - 10 - 50, yf - 10), -35, 35);
  B.bar([-30, yf - SPORGENZA_STAFFA, 0], [30, yf - SPORGENZA_STAFFA, 0], 8);
  const hc = a.c / 2, yb = yf - 10 + a.b;
  for (const xs of [-hc, hc]) B.bar([xs, yf - 30, 0], [xs, yb, 0], 8);
  B.bar([-hc, yb, 0], [hc, yb, 0], 8);
  return B.out;
}
/* mensola 76,1 × 5 lunga L mm, dall'inizio (origine, perno dell'attacco) verso il binario (−Y) */
const mensolaSolids = (L) => builder().set("Mensola").bar([0, 0, 0], [0, -L, 0], MENS_R[0], MENS_R[1]).out;
/* plinto (E 64865 f, RFI_Plinto_LSU): pilastrino B1 × A1 alto c1 sotto l'origine (due a ±I/2 lungo X col Plinto_I dei
   pali doppi, P8D: 0.24.0), blocco B × A × C sotto; i B eccentrici: A2 dall'asse al bordo verso il binario (−Y) */
function plintoSolids(Fd, c1) {
  const mm = (v) => v * 1000, A = mm(Fd.A), Bb = mm(Fd.B), C1 = mm(c1), A2 = Fd.A2 != null ? mm(Fd.A2) : A / 2, I = mm(Fd.I || 0);
  const B = builder().set("Plinto");
  for (const x of I ? [-I / 2, I / 2] : [0]) B.prism(rect(x - mm(Fd.B1) / 2, x + mm(Fd.B1) / 2, -mm(Fd.A1) / 2, mm(Fd.A1) / 2), -C1, 0);
  B.prism(rect(-Bb / 2, Bb / 2, -A2, A - A2), -C1 - mm(Fd.C), -C1);
  return B.out;
}
/* tirante 24 × 24 (RFI_Tirante_D24, d'istanza): dalla staffa (a SPORGENZA_STAFFA dalla faccia, zt) al punto della
   mensola a xt dal suo inizio (zm); estremità verticali; mm nel riferimento del palo */
function tiranteSolids(w2, zm, zt, xt) {
  const y_fa = -(w2 + SPORGENZA_STAFFA), y_att = -(w2 + SBALZO + xt), h = TIE_SIDE / 2;
  return builder().set("Tirante").ext([-h, 0, 0], Y, X, [[y_fa, zt + h], [y_fa, zt - h], [y_att, zm - h], [y_att, zm + h]], TIE_SIDE).out;
}
/* ---- varianti dei sostegni e pali doppi (0.24.0: catalogo del 2026-10-27) ------------------------------------------
   Due mensole (RFI_Sostegno_<gruppo>_2M, SEGNAPOSTO, deriva_due_mensole): al posto degli attacchi singoli la staffa
   doppia RFI_StaffaDoppia_<gruppo> (piastra anteriore 600 × 260 × 15, contropiastra, 4 tirafondini Ø20) alla quota
   della mensola e a quella del tirante, e per ogni mensola RFI_SnodiStaffaDoppia_<gruppo> (corpo, forcella e perno a
   SBALZO dalla faccia; 2 orecchie col bullone M16 alla quota del tirante); mensole a ±INTERASSE_2M / 2 lungo X */
const DOPPIA = { larg: 600, alt: 260, sp: 15, r_tf: 10, x_tf: 270, z_tf: 100 };
export const INTERASSE_2M = 280;
/* staffa doppia (build_doppia): z = 0 sull'asse della mensola, la seconda dh più su (attacco del tirante) */
function staffaDoppiaSolids(w2, dh) {
  const d = DOPPIA, hx = d.larg / 2, hz = d.alt / 2, t = d.sp, B = builder().set("Staffa doppia");
  for (const zc of [0, dh]) {
    B.prism(rect(-hx, hx, -w2 - t, -w2), zc - hz, zc + hz);
    B.prism(rect(-hx, hx, w2, w2 + t), zc - hz, zc + hz);
    B.set("Staffa doppia", DET);
    for (const x of [-d.x_tf, d.x_tf]) for (const dz of [-d.z_tf, d.z_tf]) B.bar([x, -w2 - t - 25, zc + dz], [x, w2 + t + 25, zc + dz], d.r_tf);
    B.set("Staffa doppia");
  }
  return B.out;
}
/* snodi di una mensola sulla staffa doppia (build_snodi): z = 0 sull'asse della mensola, orecchie dh più su */
function snodiSolids(w2, dh) {
  const B = builder().set("Staffa doppia"), yp = -w2 - DOPPIA.sp, y_p = -w2 - SBALZO;
  B.ext([0, yp, 0], X, [0, -1, 0], rect(-25, 25, -40, 40), yp - (y_p + 46));
  for (const s of [-1, 1]) { const z0 = s * 62.5; B.prism(rect(-20, 20, y_p - 15, y_p + 46), Math.min(z0, z0 - s * 15), Math.max(z0, z0 - s * 15)); }
  B.bar([0, y_p, -72], [0, y_p, 72], 7);
  for (const xs of [-17.5, 17.5]) B.prism(rect(xs - 5, xs + 5, -w2 - SPORGENZA_STAFFA - 25, yp), dh - 35, dh + 35);
  B.bar([-30, -w2 - SPORGENZA_STAFFA, dh], [30, -w2 - SPORGENZA_STAFFA, dh], 8);
  return B.out;
}
/* pali doppi senza mensola: RFI_PaloDoppio_2xLSU24 (genera_doppio.py, SEGNAPOSTO: 2 LSU24 a 800 lungo X, calastrelli
   RFI_Calastrelli_2xLSU24 1040 × 300 × 10 sulle facce delle anime a +1500 / 3500 / 5500 / 7500 sopra la piastra, plinto
   P24D) e RFI_PaloDoppio_2xLSU22 (il sostegno dei portali MEC 2xLSU22 senza l'attacco della trave: 2 LSU22 a ±550 sui
   due pilastrini del P8D, niente calastrelli) */
export const DOPPI = { 24: { x: 400, cal: [1500, 3500, 5500, 7500] }, 22: { x: 550, cal: [] } };
function calastrelliSolids() {
  const sr = SERIE.LSU24, w2 = sr.w2, hx = DOPPI[24].x + sr.upn[0] / 2, z0 = Z_PIASTRA + sr.piastra, B = builder().set("Calastrelli");
  for (const dz of DOPPI[24].cal) for (const s of [-1, 1]) {
    const [y0, y1] = [s * w2, s * (w2 + 10)].sort((a, b) => a - b);
    B.prism(rect(-hx, hx, y0, y1), z0 + dz - 150, z0 + dz + 150);
  }
  return B.out;
}

/* ---- portali MEC tipo C (portali_MEC_C/genera.py e genera_parametrico.py) ---------------------------------- */
/* Riferimento dei portali: origine sull'asse del pilone 1 sul SUPERCOMPATTATO, X lungo il binario, Y lungo la trave
   verso il pilone 2, Z in alto (come le famiglie) */
const MEC = { Z_FOND: 100, Z_PIASTRA0: 106, Z_COL0: 156, H_COL: 9500, X_COL: 680, H_TRAVE: 1000, B_TRAVE: 750 };
MEC.Z_COL1 = MEC.Z_COL0 + MEC.H_COL;
MEC.Z_TRAVE = 6020 + 800;              // Z_TRAVE_PORTALE (genera_parametrico.py, 2026-10-22): 0,80 sopra la mensola della sospensione
const FOND_MEC = { A: 2100, B: 4000, C: 2500, A1: 1000, B1: 2360, C1: 250 };
const IPE = [400, 180, 8.6, 13.5];
/* elementi della trave MEC tipo C (E 64923): lunghezza, campi della fiancata, zona d'appoggio */
export const MEC_ELEMENTI = { CL2: { L: 7290, campi: 8, appoggio: 1000 }, CC3: { L: 6990, campi: 7, appoggio: 0 }, CC4: { L: 5990, campi: 6, appoggio: 0 }, CC5: { L: 4990, campi: 5, appoggio: 0 },
  // 0.24.0 (genera.py, travi dei portali su 2 × LSU22): dai pesi di tabella, stessa sezione del CL2
  CL1: { L: 9290, campi: 10, appoggio: 1000 }, CL3: { L: 5290, campi: 6, appoggio: 1000 }, CC2: { L: 7990, campi: 8, appoggio: 0 }, CC1: { L: 8990, campi: 9, appoggio: 0 } };
export const MEC_CENTRALE = { C21: "CC3", C20: "CC4", C19: "CC5" };
/* travi tipo C dei portali su 2 × LSU22 (genera_2xLSU22.py TRAVI_C, E 64923 f.3): elemento laterale e centrale */
export const MEC2_TRAVI = { C15: ["CL3", "CC5"], C16: ["CL3", "CC4"], C17: ["CL3", "CC3"], C18: ["CL3", "CC2"], C19: ["CL2", "CC5"], C20: ["CL2", "CC4"],
  C21: ["CL2", "CC3"], C22: ["CL2", "CC2"], C23: ["CL1", "CC5"], C24: ["CL1", "CC4"], C25: ["CL1", "CC3"], C26: ["CL1", "CC2"], C27: ["CL1", "CC1"] };
/* portali su 2 × LSU22: filo inferiore della trave a +7100 (ASSUNTO, filo di contatto 5200 + 1900), elementi annidati
   con l'offset Z_T2 − Z_TRAVE; pali a ±550 lungo X (E 64906 c f.3) sul P8D con la testa dei pilastrini a +250 */
export const MEC2 = { Z_T2: 7100, X_PALI: 550, Z_PIL: 250, PALO: "LSU22b" };
/* attacco della trave ai 2 pali LSU22 (E 64906 c f.2-4, build_attacco2): 4 angolari L 150 × 150 × 15 L 1460 sulle facce
   Y = ±200 della coppia di pali sotto e sopra la trave con 6 fazzoletti, 24 tiranti Ø16, 16 bulloni a gancio e il
   dispositivo anticaduta (semplificati); Z sul supercompattato */
function att2Solids() {
  const B = builder().set("Attacco trave"), W2 = SERIE.LSU22.w2, ZT = MEC2.Z_T2, HT = MEC.H_TRAVE;
  const x_fz = [-640, -460, -90, 90, 460, 640], x_tr = [-680, -420, -130, 130, 420, 680];
  for (const [z_h, sv] of [[ZT, -1], [ZT + HT, 1]]) {
    for (const s of [-1, 1]) {
      let a = [-730, s * W2, z_h], b = [730, s * W2, z_h];
      if (dot(cross(X, [0, s, 0]), [0, 0, sv]) < 0) [a, b] = [b, a];
      B.set("Attacco trave").angle(a, b, 150, 150, 15, [0, s, 0]);
      B.set("Attacco trave", LAT);
      for (const xc of x_fz) {
        const y0 = s * (W2 + 15), z0 = z_h + sv * 15;
        B.ext([xc - 5, 0, 0], Y, X, [[y0, z0], [y0 + s * 105, z0], [y0, z0 + sv * 105]], 10);
      }
    }
    B.set("Attacco trave", LAT);
    for (const xc of x_tr) for (const dz of [54, 109]) { const z = z_h + sv * dz; B.bar([xc, -265, z], [xc, 265, z], 8); }
    for (const sx of [-1, 1]) for (const s of [-1, 1]) for (const dy of [260, 320]) {
      const x = sx * (MEC.B_TRAVE / 2 + 20), [za, zb] = sv < 0 ? [z_h - 15 - 30, z_h + 100] : [z_h - 100, z_h + 15 + 30];
      B.bar([x, s * dy, za], [x, s * dy, zb], 8);
    }
  }
  const z_ac = ZT - 150 - 120;
  B.set("Attacco trave", LAT);
  for (const sx of [-1, 1]) {
    const xp = sx * (MEC2.X_PALI + 110);
    B.prism(rect(Math.min(xp, xp + sx * 15), Math.max(xp, xp + sx * 15), -152, 152), z_ac - 40, z_ac + 40);
    for (const dy of [-127, 127]) B.bar([xp + sx * 15, dy, z_ac], [sx * (MEC2.X_PALI - 110 - 8), dy, z_ac], 8);
  }
  return B.out;
}
const plateHoles = (cx) => [-250, 0, 250].flatMap((dx) => [-330, 0, 330].filter((dy) => dx || dy).map((dy) => [cx + dx, dy]));
function fondMecSolids() {
  const d = FOND_MEC, B = builder().set("Fondazione"), z_bl = MEC.Z_FOND - d.C1;
  B.prism(rect(-d.B1 / 2, d.B1 / 2, -d.A1 / 2, d.A1 / 2), z_bl, MEC.Z_FOND);
  B.prism(rect(-d.B / 2, d.B / 2, -d.A / 2, d.A / 2), z_bl - d.C, z_bl);
  B.set("Tirafondi", LAT);
  for (const cx of [-MEC.X_COL, MEC.X_COL]) for (const [x, y] of plateHoles(cx)) B.bar([x, y, MEC.Z_FOND - 980], [x, y, MEC.Z_FOND + 220], 21);
  return B.out;
}
function ipePts(cx) {
  const h = IPE[0] / 2, b = IPE[1] / 2, tw = IPE[2] / 2, tf = IPE[3];
  return [[cx - b, -h], [cx + b, -h], [cx + b, -h + tf], [cx + tw, -h + tf], [cx + tw, h - tf], [cx + b, h - tf], [cx + b, h], [cx - b, h], [cx - b, h - tf], [cx - tw, h - tf], [cx - tw, -h + tf], [cx - b, -h + tf]];
}
function piloneMecSolids() {
  const B = builder(), { Z_COL0, Z_COL1, Z_PIASTRA0, X_COL, H_COL } = MEC;
  for (const cx of [-X_COL, X_COL]) {
    B.set("Colonne IPE").prism(ipePts(cx), Z_COL0, Z_COL1);
    B.set("Piastre base").prism(rect(cx - 350, cx + 350, -430, 430), Z_PIASTRA0, Z_COL0, plateHoles(cx).map(([x, y]) => [x, y, 26.5]));
    B.set("Piastre base", LAT);
    const g6 = [[0, 30], [30, 0], [240, 0], [240, 75], [75, 400], [0, 400]];
    for (const sy of [-1, 1]) for (const sx of [-1, 1]) B.ext([cx + (sx * IPE[1]) / 2, sy * 194 + 6 * sx, Z_COL0], [sx, 0, 0], [0, -sx, 0], g6, 12);
    const g7 = [[0, 30], [30, 0], [210, 0], [210, 75], [75, 320], [0, 320]];
    for (const sy of [-1, 1]) for (const dx of [-176, -74, 74, 176]) B.ext([cx + dx - 6 * sy, (sy * IPE[0]) / 2, Z_COL0], [0, sy, 0], [sy, 0, 0], g7, 12);
  }
  // controventi L 70 × 70 × 8 sulle due facce: sotto 6 diagonali a zig-zag, sopra 7 traversi e 6 diagonali
  const z_h0 = Z_COL0 + H_COL - 1340 - 6 * 500;
  B.set("Controventi", LAT);
  for (const sy of [-1, 1]) {
    const yf = (sy * IPE[0]) / 2, out = [0, sy, 0], first = sy > 0 ? -1 : 1;
    for (let k = 0; k < 6; k++) {
      const s = k % 2 === 0 ? first : -first, za = z_h0 - (6 - k) * 761, zb = z_h0 - (5 - k) * 761;
      B.angle([s * 608, yf, za], [-s * 608, yf, zb], 70, 70, 8, out, 40);
    }
    for (let j = 0; j < 7; j++) {
      const z = z_h0 + j * 500;
      B.angle([-620, yf, z], [620, yf, z], 70, 70, 8, out, 30);
      if (j < 6) { const s = j % 2 === 0 ? first : -first; B.angle([s * 620, yf, z + 78], [-s * 620, yf, z + 422], 70, 70, 8, out, 35); }
    }
  }
  return B.out;
}
/* attacco della trave sul pilone (E 65110, ASSUNTO): due angolari L 100 × 100 × 10 per lato, sotto e sopra la trave */
function attMecSolids() {
  const B = builder().set("Attacco trave", DET);
  for (const sy of [-1, 1]) {
    const y0 = (sy * IPE[0]) / 2, out = [0, sy, 0];
    for (const [z, su] of [[MEC.Z_TRAVE, -1], [MEC.Z_TRAVE + 1056, 1]]) {
      let a = [-MEC.X_COL - 90, y0, z], b = [MEC.X_COL + 90, y0, z];
      if (sy * su < 0) [a, b] = [b, a];
      B.angle(a, b, 100, 100, 10, out);
    }
  }
  return B.out;
}
/* 4 correnti a L agli spigoli della sezione hx × (z0…z1), da y0 a y1, ali verso l'interno */
function correnti(B, hx, z0, z1, y0, y1, leg, t) {
  for (const sx of [-1, 1]) for (const [zc, sz] of [[z0, 1], [z1, -1]]) {
    let a = [sx * hx, y0, zc], b = [sx * hx, y1, zc];
    const u1 = [-sx, 0, 0];
    if (dot(cross(Y, u1), mul(Z, sz)) < 0) [a, b] = [b, a];
    B.angle(a, b, leg, leg, t, u1);
  }
}
/* tratto di trave MEC 750 × 1000 lungo L, da y = 0 a y = L (build_trave) */
function traveMecSolids(key) {
  const { L, campi, appoggio } = MEC_ELEMENTI[key], B = builder(), hx = MEC.B_TRAVE / 2, z0 = MEC.Z_TRAVE, z1 = MEC.Z_TRAVE + MEC.H_TRAVE;
  B.set("Correnti", BOX).prism(rect(-hx, hx, 0, L), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, 0, L, 100, 12);
  const zl = z0 + 50, zh = z1 - 50, passo = L / campi;
  B.set("Fiancate", LAT);
  for (let k = 0; k < campi; k++) {
    const [za, zb] = k % 2 === 0 ? [zl, zh] : [zh, zl];
    for (const sx of [-1, 1]) B.angle([sx * (hx - 12), k * passo, za], [sx * (hx - 12), (k + 1) * passo, zb], 50, 50, 5, [-sx, 0, 0]);
  }
  let nodi = Array.from({ length: campi + 1 }, (_, j) => j * passo);
  if (appoggio) nodi = [...new Set([...nodi.filter((y) => y > appoggio), ...Array.from({ length: Math.floor(appoggio / 250) + 1 }, (_, j) => j * 250)])].sort((a, b) => a - b);
  const xs = hx - 35;
  B.set("Controventi trave", LAT);
  for (const [zp, sz] of [[z0 + 12, 1], [z1 - 12, -1]]) nodi.forEach((y, j) => {
    B.angle([-xs, y, zp], [xs, y, zp], 45, 45, 4.5, mul(Z, sz));
    if (j + 1 < nodi.length) { const s = j % 2 === 0 ? 1 : -1; B.angle([-s * xs, y, zp], [s * xs, nodi[j + 1], zp], 45, 45, 4.5, mul(Z, sz)); }
  });
  return B.out;
}

/* ---- portali coi piloni E 65018 (portali_ormeggio/genera.py, portali_tralicciati/genera.py) ------------------ */
const POT = { Z_FOND: 350, H_PIL: 9586, H_TRAVE: 800, B_TRAVE: 1280 };
POT.Z_COL0 = POT.Z_FOND + 50; POT.Z_COL1 = POT.Z_FOND + POT.H_PIL; POT.Z_RASTR = POT.Z_COL0 + 6556;
POT.Z_TRAVE_PIL = POT.Z_COL1 - 150 - POT.H_TRAVE;            // controventi del pilone fino a 100 sotto (la trave di prima)
POT.Z_TRAVE = 6020 + 800;                                     // trave come le MEC (genera.py, 2026-10-22)
const HEA = [310, 300, 9, 15.5], X_BASE = 1927.5 / 2 - 150, X_TOP = 1327.5 / 2 - 150;
/* travi E 65109 (luce asse-asse dei piloni): elemento laterale nL e centrale nC; nel catalogo dell'add-in T-6, T-9, T-25 */
export const ORM_TRAVI = { "T-6": [14400, 1, 5], "T-7": [14400, 2, 3], "T-8": [14400, 3, 1], "T-9": [15600, 1, 6], "T-10": [15600, 2, 4], "T-11": [15600, 3, 2], "T-25": [20400, 1, 10], "T-26": [20400, 2, 8], "T-27": [20400, 3, 6], "T-28": [20400, 4, 4], "T-29": [20400, 5, 2] };
export const lenL = (n) => 4595 + 1200 * (n - 1);
export const lenC = (n) => 1200 * n - 790;
/* travi tralicciate (E 65018 a): luce, campi (laterale, centrale, n. centrali) */
export const TRAL_TRAVI = { "1BIN_L6400": ["1BIN", 6400, [581.7, 661.7, 6]], "2BIN_L10300": ["2BIN", 10300, [581.7, 773.7, 10]] };
const SPORTO = 440;
function fondPotSolids() {
  const B = builder().set("Fondazione");
  B.prism(rect(-3000, 3000, -1250, 1250), POT.Z_FOND - 2200, POT.Z_FOND);
  B.set("Tirafondi", LAT);
  for (const xc of [-X_BASE, X_BASE]) for (const dx of [-200, 200]) for (const dy of [-300, 300]) B.bar([xc + dx, dy, POT.Z_FOND - 1000], [xc + dx, dy, POT.Z_FOND + 200], 18);
  return B.out;
}
function heaPts() {
  const h = HEA[0] / 2, b = HEA[1] / 2, tw = HEA[2] / 2, tf = HEA[3];
  return [[-b, -h], [b, -h], [b, -h + tf], [tw, -h + tf], [tw, h - tf], [b, h - tf], [b, h], [-b, h], [-b, h - tf], [-tw, h - tf], [-tw, -h + tf], [-b, -h + tf]];
}
/* HEA320 lungo il segmento a-b nel piano Y = 0 (ali parallele al piano XZ) */
function column(B, a, b) {
  const d = unit(sub(b, a));
  B.ext(a, [d[2], 0, -d[0]], d, heaPts(), norm(sub(b, a)));
}
function pilonePotSolids() {
  const B = builder(), { Z_FOND, Z_COL0, Z_COL1, Z_RASTR, Z_TRAVE_PIL } = POT;
  for (const s of [-1, 1]) {
    B.set("Piastre base").prism(rect(s * X_BASE - 300, s * X_BASE + 300, -400, 400), Z_FOND, Z_COL0);
    B.set("Colonne HEA");
    column(B, [s * X_BASE, 0, Z_COL0], [s * X_TOP, 0, Z_RASTR]);
    column(B, [s * X_TOP, 0, Z_RASTR], [s * X_TOP, 0, Z_COL1]);
  }
  const xc = (z) => X_BASE + ((X_TOP - X_BASE) * (z - Z_COL0)) / (Z_RASTR - Z_COL0);
  const nodi = [Z_COL0 + 300, Z_COL0 + 2300, Z_COL0 + 4400, Z_RASTR];
  B.set("Controventi", LAT);
  for (const sy of [-1, 1]) {
    const y = (sy * HEA[0]) / 2, out = [0, sy, 0];
    for (let i = 0; i + 1 < nodi.length; i++) {
      const z0 = nodi[i], z1 = nodi[i + 1];
      B.angle([-xc(z0), y, z0], [xc(z1), y, z1], 90, 90, 10, out);
      B.angle([xc(z0), y, z0], [-xc(z1), y, z1], 90, 90, 10, out);
    }
    for (const z of [...nodi, Z_TRAVE_PIL - 100]) { const x = z <= Z_RASTR ? xc(z) : X_TOP; B.angle([-x, y, z], [x, y, z], 90, 90, 10, out); }
    B.angle([-X_TOP, y, Z_RASTR], [X_TOP, y, Z_TRAVE_PIL - 100], 90, 90, 10, out);
  }
  return B.out;
}
/* tratto di trave E 65109 1280 × 800 lungo Lg da y = 0 (build_trave); laterale: + attacco al pilone (lat_builder) */
function traveOrmSolids(Lg, lat) {
  const B = builder(), hx = POT.B_TRAVE / 2, z0 = POT.Z_TRAVE, z1 = POT.Z_TRAVE + POT.H_TRAVE;
  B.set("Correnti", BOX).prism(rect(-hx, hx, 0, Lg), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, 0, Lg, 150, 15);
  const campi = Math.max(1, Math.round(Lg / 1200)), passo = Lg / campi, zl = z0 + 75, zh = z1 - 75;
  B.set("Fiancate", LAT);
  for (let k = 0; k < campi; k++) {
    const [za, zb] = k % 2 === 0 ? [zl, zh] : [zh, zl];
    for (const sx of [-1, 1]) B.angle([sx * (hx - 15), k * passo, za], [sx * (hx - 15), (k + 1) * passo, zb], 80, 80, 10, [-sx, 0, 0]);
  }
  for (let k = 0; k <= campi; k++) for (const sx of [-1, 1]) B.angle([sx * (hx - 15), k * passo, z0 + 15], [sx * (hx - 15), k * passo, z1 - 15], 80, 80, 10, [-sx, 0, 0]);
  const xs = hx - 75;
  B.set("Controventi trave", LAT);
  for (const [zp, sz] of [[z0 + 15, 1], [z1 - 15, -1]]) for (let j = 0; j <= campi; j++) {
    B.angle([-xs, j * passo, zp], [xs, j * passo, zp], 80, 80, 10, mul(Z, sz));
    if (j < campi) { const s = j % 2 === 0 ? 1 : -1; B.angle([-s * xs, j * passo, zp], [s * xs, (j + 1) * passo, zp], 80, 80, 10, mul(Z, sz)); }
  }
  if (lat) {
    B.set("Attacco al pilone");
    for (const sx of [-1, 1]) {
      const x0 = sx * (hx + 18);
      B.prism(rect(Math.min(x0, x0 - sx * 18), Math.max(x0, x0 - sx * 18), -375, 375), z0, z1);
      for (const zc of [z0 - 30, z1]) B.prism(rect(sx * hx - 300, sx * hx + 300, -300, 300), zc, zc + 30);
    }
  }
  return B.out;
}
/* ascisse dei traversi della trave tralicciata: primo e ultimo a 390 dalle estremità, campi scalati sulla lunghezza */
function nodiTral(luce, [lat, cen, n]) {
  const passi = [lat, lat, ...Array(n).fill(cen), lat, lat], s = (luce + 2 * SPORTO - 780) / passi.reduce((a, b) => a + b, 0), ys = [390 - SPORTO];
  for (const p of passi) ys.push(ys[ys.length - 1] + p * s);
  return ys;
}
/* trave tralicciata 1280 × 800 da −SPORTO a luce + SPORTO (build_trave_t); origine sull'asse del pilone 1 */
function traveTralSolids(luce, campi) {
  const B = builder(), hx = POT.B_TRAVE / 2, z0 = POT.Z_TRAVE, z1 = POT.Z_TRAVE + POT.H_TRAVE, y0 = -SPORTO, y1 = luce + SPORTO;
  B.set("Correnti", BOX).prism(rect(-hx, hx, y0, y1), z0, z1);
  correnti(B.set("Correnti", DET), hx, z0, z1, y0, y1, 150, 15);
  const ys = nodiTral(luce, campi), xs = hx - 75;
  B.set("Controventi trave", LAT);
  for (const [zp, sz, verso] of [[z0 + 15, 1, -1], [z1 - 15, -1, 1]]) ys.forEach((y, j) => {
    B.angle([-xs, y, zp], [xs, y, zp], 80, 80, 10, mul(Z, sz));
    if (j < ys.length - 1) B.angle([-verso * xs, y, zp], [verso * xs, ys[j + 1], zp], 80, 80, 10, mul(Z, sz));
  });
  const zl = z0 + 75, zh = z1 - 75, xf = hx - 15;
  B.set("Fiancate", LAT);
  for (const sx of [-1, 1]) {
    for (let j = 0; j < ys.length - 1; j++) { const [za, zb] = j % 2 === 0 ? [zh, zl] : [zl, zh]; B.angle([sx * xf, ys[j], za], [sx * xf, ys[j + 1], zb], 50, 50, 6, [-sx, 0, 0]); }
    for (let j = 0; j < ys.length; j += 2) B.angle([sx * xf, ys[j], z0 + 15], [sx * xf, ys[j], z1 - 15], 50, 50, 6, [-sx, 0, 0]);
  }
  B.set("Controventi trave", LAT);
  for (const j of [0, Math.floor(ys.length / 2), ys.length - 1]) B.angle([-xs, ys[j] + 40, z0 + 75], [xs, ys[j] + 40, z1 - 75], 50, 50, 6, Y);
  B.set("Attacco al pilone");
  for (const yp of [0, luce]) for (const sx of [-1, 1]) { const xa = sx * (hx + 18); B.prism(rect(Math.min(xa, sx * hx), Math.max(xa, sx * hx), yp - 290, yp + 290), z0, z1); }
  return B.out;
}

/* ---- sospensioni sotto la trave dei portali (sospensione_contatto/genera_portali.py, 2026-10-22, SEGNAPOSTO) --------
   Tipologico Satferr PT20-21: tubo Ø133 a 1500 dall'asse del binario fissato alla trave con 2 piatti verticali e 2
   piastre forate, mensola Ø76,1 L 2000 con tirante Ø24 L 1400, sospensione SN620_BN780_2x1100 (sospensioneSolids,
   un pezzo a parte come nei pali). Riferimento dell'assieme: X lungo il binario, Y = 0 sull'asse del binario
   col tubo verso +Y, Z sul supercompattato; nel portale ruotato di 180° (tubo verso il pilone 1) sulla faccia X
   negativa della trave. zm = asse della mensola (Quota_mensola), qt / ht = intradosso e altezza della trave */
const SP = { Y_TUBO: 1500, R_TUBO: 66.5, TUBO_SOTTO: 150, TUBO_SOPRA: 300, L_MENS: 2000, L_TIR: 1400, H_TIR: 800, R_TIR: 12, PIATTO: [100, 20, 10], OLTRE: 150, PIASTRA: [20, 20], CORRENTE: 150 };
export const PORTAL_BEAMS = { MEC: { qt: MEC.Z_TRAVE, ht: MEC.H_TRAVE, bt: MEC.B_TRAVE }, MEC2: { qt: MEC2.Z_T2, ht: MEC.H_TRAVE, bt: MEC.B_TRAVE }, PO: { qt: POT.Z_TRAVE, ht: POT.H_TRAVE, bt: POT.B_TRAVE } };
const beamKind = (kind) => (kind === "MEC" || kind === "MEC2" ? kind : "PO");
const cerchio = (xc, yc, r, n = 24) => Array.from({ length: n }, (_, i) => [xc + r * Math.cos((2 * PI * i) / n), yc + r * Math.sin((2 * PI * i) / n)]);
/* RFI_SospensionePortale_SEGNAPOSTO: tubo da 150 sotto la mensola a 300 sopra la trave, piatti da 150 sotto
   l'intradosso a 150 sopra l'estradosso contro la faccia della trave */
function sospPortaleSolids(qt, ht, zm) {
  const { Y_TUBO, R_TUBO, PIATTO: [w, t, gap], OLTRE } = SP, B = builder().set("Mensola portale");
  B.prism(cerchio(0, Y_TUBO, R_TUBO), zm - SP.TUBO_SOTTO, qt + ht + SP.TUBO_SOPRA);
  B.set("Staffaggio tubo", DET);
  for (const s of [-1, 1]) { const y0 = Y_TUBO + s * (R_TUBO + gap); B.prism(rect(-R_TUBO, -R_TUBO + t, Math.min(y0, y0 + s * w), Math.max(y0, y0 + s * w)), qt - OLTRE, qt + ht + OLTRE); }
  return B.out;
}
/* RFI_MensolaPortale_SEGNAPOSTO: mensola 2000 dalla faccia del tubo, tirante 1400 dal tubo 800 sopra la mensola, 2 collari */
function mensPortaleSolids(zm) {
  const { Y_TUBO, R_TUBO, L_MENS, L_TIR, H_TIR } = SP, yf = Y_TUBO - R_TUBO, B = builder().set("Mensola portale");
  B.bar([0, yf, zm], [0, yf - L_MENS, zm], MENS_R[0], MENS_R[1]);
  B.bar([0, yf, zm + H_TIR], [0, yf - Math.sqrt(L_TIR ** 2 - H_TIR ** 2), zm + MENS_R[0]], SP.R_TIR);
  B.set("Mensola portale", LAT);
  for (const z of [zm, zm + H_TIR]) B.prism(cerchio(0, Y_TUBO, R_TUBO + 12), z - 40, z + 40, [[0, Y_TUBO, R_TUBO]]);
  return B.out;
}
/* RFI_PiastraTuboPortale_SEGNAPOSTO: piastra forata sp. 20 da Z = 0, larga quanto i 2 piatti */
function piastraPortaleSolids() {
  const { Y_TUBO, R_TUBO, PIATTO: [w, , gap], PIASTRA: [t, x] } = SP, yp = R_TUBO + gap + w;
  return builder().set("Staffaggio tubo").prism(rect(-R_TUBO - x, R_TUBO + x, Y_TUBO - yp, Y_TUBO + yp), 0, t, [[0, Y_TUBO, R_TUBO]]).out;
}

/* ---- sospensione di piena linea con gli isolatori (sospensione_contatto/genera.py, 2026-10-18; 0.23.0) -------------
   RFI_Sospensione_PL_Acciaio_440 (E 56000/1s d, catenaria 440 mm² F.R.), annidata nei pali LSU e nelle sospensioni dei
   portali: staffa sulla mensola, isolatore portante verticale E 64447 e morsetto delle 2 corde portanti, braccio di
   poligonazione ribassato (profilo U 65 × 42) con l'isolatore inclinato e il raccordo, 2 tirantini E 61133 coi morsetti
   del filo. Riferimento della famiglia: X lungo il binario, Y = 0 sull'asse del binario (corde portanti) e il palo (il
   tubo del portale) verso +Y, quote dal supercompattato con l'asse della mensola a Z_MENS (nei sostegni l'assieme si
   sposta di Quota_mensola − Z_MENS). Tipi SN620_BN<h>_2x<L>: braccio h = 780 / 540 / 440, tirantini L = 900 / 1100;
   Poligonazione = filo dall'asse del binario verso +Y. Isolatori: i profili di rivoluzione della famiglia come tondi
   a gradini (terminali, corpo, 3 alette) */
const SO = { Z_MENS: 6885, ISO_L: 329, ISO_F: 341, SN: 620, PERNO: 17, COLL: 80, RACC: 40, PIN_FILO: 30, X_TIR: 50, W_TIR: 10 };
SO.ZB = SO.Z_MENS - MENS_R[0];                       // bordo inferiore della mensola: riferimento di h (E 56000/1s nota 1)
SO.Z_PORT = SO.ZB + SO.SN;                           // asse delle corde portanti (SN620 dal bordo inferiore, ASSUNTO)
SO.Z_ISO = SO.Z_PORT - (SO.ISO_F + 25);              // base dell'isolatore verticale
export const SOSP_Z_MENS = SO.Z_MENS / 1000;
/* bracci ribassati (E 52188 / E 49997 / E 52201 f.3): tratto L1, curva R1 di a1°, tratto L2, curva R2 di a2° */
const BRACCI = {
  780: { L1: 355, R1: 520, a1: 20, L2: 676, R2: 200, a2: 58 }, 540: { L1: 400, R1: 440, a1: 27, L2: 252, R2: 78, a2: 52 },
  440: { L1: 590, R1: 82, a1: 16, L2: 70, R2: 80, a2: 60 },
};
const U65 = [[-32.5, 0], [32.5, 0], [32.5, 42], [25, 42], [25, 5.5], [-25, 5.5], [-25, 42], [-32.5, 42]];
/* linea superiore del braccio (y avanti, z in alto, origine all'inizio), asse dell'isolatore inclinato e attacco R dei
   tirantini (geo_braccio) */
function geoBraccio(b, step = 5) {
  const pts = [[0, 0]];
  let phi = 0;
  for (const [kind, a, b2] of [["L", b.L1, 0], ["R", b.R1, b.a1], ["L", b.L2, 0], ["R", b.R2, b.a2]]) {
    const [y, z] = pts[pts.length - 1];
    if (kind === "L") { pts.push([y + a * Math.cos(phi), z - a * Math.sin(phi)]); continue; }
    const cy = y - a * Math.sin(phi), cz = z - a * Math.cos(phi), n = Math.max(2, Math.ceil(b2 / step));
    for (let i = 1; i <= n; i++) { const p2 = phi + (b2 * PI / 180 * i) / n; pts.push([cy + a * Math.sin(p2), cz + a * Math.cos(p2)]); }
    phi += b2 * PI / 180;
  }
  const E = pts[pts.length - 1], t = [Math.cos(phi), -Math.sin(phi)], d = [-Math.sin(phi), -Math.cos(phi)];
  const mv = (p, v, k) => [p[0] + v[0] * k, p[1] + v[1] * k];
  const A0 = mv(E, t, SO.COLL), P0 = mv(A0, d, -45), F = mv(P0, d, SO.ISO_F), R = mv(F, d, SO.RACC);
  return { pts, E, t, d, A0, P0, F, R };
}
/* il tipo della sospensione → braccio, tirantini, quota dell'attacco dei tirantini e dislivello fino al perno sul filo */
export function sospGeom(type) {
  const m = /BN(\d{3})_2x(\d{3,4})/.exec(String(type || "")), h = m && BRACCI[m[1]] ? +m[1] : 780, lt = m ? +m[2] : 900;
  const g = geoBraccio(BRACCI[h]), zr = SO.ZB + g.R[1];
  return { h, lt, g, zr, dis: zr - (SO.ZB - h + SO.PIN_FILO) };
}
/* isolatore E 64447 b dalla base del terminale femmina (o) lungo d: tondi a gradini */
function isolatore(B, o, d) {
  const seg = (r, z0, z1, sub) => B.set(sub).bar(add(o, mul(d, z0)), add(o, mul(d, z1)), r);
  seg(26, 0, 90, "Terminali isolatore"); seg(30, 90, 100, "Terminali isolatore");
  seg(23.5, 100, 230, "Isolatore");
  for (const zc of [115, 165, 215]) { seg(60, zc - 14, zc - 8, "Isolatore"); seg(42, zc - 8, zc + 4, "Isolatore"); }
  for (const [r, z0, z1] of [[30, 230, 240], [26, 240, 301], [18, 301, 310], [11.5, 310, 320], [18, 320, SO.ISO_L]]) seg(r, z0, z1, "Terminali isolatore");
}
/* l'assieme (iso = solo i 2 isolatori, sennò tutto il resto) del tipo type con la poligonazione pol (mm) */
function sospensioneSolids(type, pol, iso) {
  const { g, h, lt, zr, dis } = sospGeom(type), B = builder(), pa = pol + Math.sqrt(lt * lt - dis * dis);
  const W = (p) => [0, p[0] - g.R[0] + pa, SO.ZB + p[1]], D = [0, g.d[0], g.d[1]];
  if (iso) { isolatore(B, [0, 0, SO.Z_ISO], Z); isolatore(B, W(g.P0), D); return B.out; }
  const { Z_MENS, ZB, Z_PORT, Z_ISO } = SO, zt = Z_MENS + MENS_R[0], zp = Z_ISO + SO.PERNO;
  // staffa normale (E 49983, ASSUNTA): sella, 2 guance col perno nel terminale femmina, cavallotti
  B.set("Staffa portante").prism(rect(-40, 40, -60, 60), zt, zt + 8);
  for (const s of [-1, 1]) { const x0 = Math.min(s * 29, s * 37); B.ext([x0, 0, 0], Y, X, [[-60, zt + 8], [60, zt + 8], [30, zp + 23], [-30, zp + 23]], 8); }
  B.bar([-45, 0, zp], [45, 0, zp], 7);
  B.set("Staffa portante", LAT);
  for (const y of [-45, 45]) {
    for (const x of [-44, 44]) B.bar([x, y, ZB - 6], [x, y, zt + 14], 6);
    B.bar([-50, y, ZB - 6], [50, y, ZB - 6], 6);
  }
  // morsetto portante per 2 corde (E 70302 d)
  B.set("Morsetti").bar([0, 0, Z_ISO + 300], [0, 0, Z_PORT - 20], 22.5).prism(rect(-80, 80, -35, 35), Z_PORT - 20, Z_PORT - 7);
  B.set("Morsetti", DET);
  for (const y of [-22, 22]) B.prism(rect(-35, 35, y - 12, y + 12), Z_PORT + 7, Z_PORT + 15).prism(rect(-35, 35, y - 12, y + 12), Z_PORT - 7, Z_PORT - 5);
  B.set("Morsetti", LAT);
  for (const x of [-50, 50]) B.bar([x, 0, Z_PORT - 20], [x, 0, Z_PORT + 25], 6);
  // braccio di poligonazione: profilo U lungo la linea superiore, collare sul terminale, piastra, raccordo, attacchi
  B.set("Braccio poligonazione");
  const P = g.pts.map(W);
  for (let i = 0; i + 1 < P.length; i++) {
    const [, y0, z0] = P[i], [, y1, z1] = P[i + 1], Ls = Math.hypot(y1 - y0, z1 - z0), sy = (y1 - y0) / Ls, sz = (z1 - z0) / Ls;
    const e0 = i > 0 ? 1.5 : 0, e1 = i < P.length - 2 ? 1.5 : 0;
    B.ext([0, y0 - sy * e0, z0 - sz * e0], X, [0, sy, sz], U65, Ls + e0 + e1);
  }
  const a0 = W(g.A0), e = W(g.E);
  B.bar(sub(a0, mul(D, 22)), add(a0, mul(D, 22)), 32.5, 26.5);
  B.ext(e, X, [0, g.t[0], g.t[1]], rect(-30, 30, -6, 6), SO.COLL - 30);
  const F = add(W(g.P0), mul(D, SO.ISO_F));
  B.set("Raccordo tirantini").ext(sub(F, mul(D, 20)), X, D, rect(-20, 20, -20, 20), SO.RACC + 32);
  B.bar(add(F, add(mul(D, SO.RACC), [-SO.X_TIR - 15, 0, 0])), add(F, add(mul(D, SO.RACC), [SO.X_TIR + 15, 0, 0])), 10);
  B.set("Attacco braccio", DET);
  for (const s of [80, BRACCI[h].L1 - 80]) {
    const y = W([s, 0])[1], zb = ZB - 42;
    B.prism(rect(-50, 50, y - 20, y + 20), zb - 8, zb);
    for (const x of [-44, 44]) B.bar([x, y, zb - 14], [x, y, zt + 6], 6);
    B.bar([-44, y, zt + 6], [44, y, zt + 6], 6);
  }
  // 2 tirantini (barra 20 × 20) dall'attacco R al morsetto del filo, a Proiezione verso il binario e Dislivello sotto
  const pr = Math.sqrt(lt * lt - dis * dis), w = SO.W_TIR;
  for (const x of [-SO.X_TIR, SO.X_TIR]) {
    B.set("Tirantino").ext([x - w, pa, zr], Y, X, [[0, w], [0, -w], [-15, -w], [-pr + 15, -dis - w], [-pr, -dis - w], [-pr, -dis + w]], 2 * w);
    const zf = zr - dis - SO.PIN_FILO, y = pa - pr;             // morsetto del filo E 64467: ganasce, occhio, bottone
    B.set("Morsetti").prism(rect(x - 29.5, x + 29.5, y - 16, y + 16), zf - 8, zf + 14);
    B.set("Morsetti", DET).prism(rect(x - 12, x + 12, y - 8, y + 8), zf + 14, zr - dis + 12).bar([x - 12, y, zr - dis], [x + 12, y, zr - dis], 9);
  }
  return B.out;
}

/* ---- pezzi condivisi (una geometria per chiave) -------------------------------------------------------------- */
const MAKERS = {
  palo: (id) => { const m = /^LSU(\d\d)([abc])$/.exec(id); return paloSolids("LSU" + m[1], PALI_L[m[2]]); },
  att: (se) => attaccoSolids(se),
  staffa: (se) => staffaSolids(se),
  doppia: (a) => { const [se, dh] = a.split(","); return staffaDoppiaSolids(SERIE[se].w2, +dh); },
  snodi: (a) => { const [se, dh] = a.split(","); return snodiSolids(SERIE[se].w2, +dh); },
  cal: () => calastrelliSolids(), att2: () => att2Solids(),
  mens: (L) => mensolaSolids(+L),
  fondMEC: () => fondMecSolids(), pilMEC: () => piloneMecSolids(), attMEC: () => attMecSolids(), trMEC: (k) => traveMecSolids(k),
  fondPOT: () => fondPotSolids(), pilPOT: () => pilonePotSolids(),
  trORM: (k) => { const lat = k[0] === "L", n = +k.slice(1); return traveOrmSolids(lat ? lenL(n) : lenC(n), lat); },
  trTRAL: (k) => { const [, luce, campi] = TRAL_TRAVI[k]; return traveTralSolids(luce, campi); },
  sospP: (a) => sospPortaleSolids(...a.split(",").map(Number)), mensP: (zm) => mensPortaleSolids(+zm), piastraP: () => piastraPortaleSolids(),
  sospR: (a) => { const [t, p] = a.split(","); return sospensioneSolids(t, +p, false); }, isoR: (a) => { const [t, p] = a.split(","); return sospensioneSolids(t, +p, true); },
};
const CACHE = new Map();
/* i solidi (metri) del pezzo condiviso key = «tipo|argomento» (plinto: «plinto|id|c1» con la fondazione passata),
   filtrati sul livello di dettaglio lod */
export function pieceSolids(key, lod = "lattice", Fd = null) {
  let all = CACHE.get(key);
  if (!all) {
    const [k, arg, c1] = key.split("|");
    all = (k === "plinto" ? plintoSolids(Fd, +c1) : MAKERS[k](arg)).map(toM);
    CACHE.set(key, all);
  }
  return atLod(all, lod);
}
export const atLod = (solids, lod = "lattice") => { const i = LOD_INDEX[lod] != null ? LOD_INDEX[lod] : 2; return solids.filter((s) => s.l[0] <= i && i <= s.l[1]); };

/* ---- sostegni → pezzi nel riferimento della famiglia ------------------------------------------------------------
   Un pezzo: { k (parte del tool: plinto, palo, att, staffa, mens, tir, fond, pilone, attTrave, trave; sospensioni dei
   portali sospP, mensP, piastraP), key (geometria
   condivisa) o own (solidi suoi, metri), fam (famiglia Revit), type (tipo), o: [x, y, z] (m), rot (0 | π attorno a Z),
   ifc: [classe, tipo predefinito] }.
   R = sostegno risolto dal catalogo con R.rfi (ocs-catalog: resolveSupport / resolvePortal); null se la famiglia non
   c'è (LSU24 singolo, pali doppi con la mensola, portali su pali LSU singoli, luci fuori dai tipi) → il chiamante
   disegna la geometria semplificata */
const PI = Math.PI;
const SE_OF = (M) => "LSU" + M.size;
export function rfiPieces(R) {
  if (!R || !R.rfi) return null;
  if (R.kind === "portal") return [...portalPieces(R), ...portalSospPieces(R)];
  const M = R.mast, se = SE_OF(M);
  if (!SERIE[se]) return null;
  const w2 = SERIE[se].w2, zm = R.hm - R.baseDz, mens = R.mens.L, cfg = R.rfi.cfg || "";
  const ties = R.ties && R.ties.length ? R.ties : [R.tir];
  const fid = R.found.id, c1 = Math.round(R.c1 * 1000) / 1000, COL = ["IFCCOLUMN", "STANDCOLUMN"], BR = ["IFCDISCRETEACCESSORY", "BRACKET"];
  const out = [];
  // palo e plinto (0.24.0: niente con la sola mensola; due pali, e i calastrelli della coppia di LSU24, nei pali doppi)
  if (cfg !== "SOLO") {
    out.push({ k: "plinto", key: "plinto|" + fid + "|" + c1, Fd: R.found, fam: "RFI_Plinto_LSU", type: fid, o: [0, 0, 0], rot: 0, ifc: ["IFCFOOTING", "PAD_FOOTING"] });
    const D = R.rfi.dbl ? DOPPI[M.size] : null;
    for (const x of D ? [-D.x, D.x] : [0]) out.push({ k: "palo", key: "palo|" + M.id, fam: "RFI_Palo_" + M.id, type: "", o: [x / 1000, 0, 0], rot: 0, ifc: COL });
    if (D && D.cal.length) out.push({ k: "cal", key: "cal", fam: "RFI_Calastrelli_2xLSU24", type: "", o: [0, 0, 0], rot: 0, ifc: ["IFCPLATE", "NOTDEFINED"] });
  }
  if (cfg === "SM") return out;
  // una mensola sugli attacchi singoli, o due («2M») sulla staffa doppia con gli snodi, a ±INTERASSE_2M / 2 lungo X
  const two = cfg === "2M", xs = two ? [-INTERASSE_2M / 2, INTERASSE_2M / 2] : [0], grp = M.size <= 16 ? "LSU14-16" : "LSU18-22", dh = Math.round(ties[0].dh * 1000);
  if (two) out.push({ k: "staffa2", key: "doppia|" + se + "," + dh, fam: "RFI_StaffaDoppia_" + grp, type: "", o: [0, 0, zm], rot: 0, ifc: BR });
  for (const xm of xs) {
    const x = xm / 1000;
    if (two) out.push({ k: "att", key: "snodi|" + se + "," + dh, fam: "RFI_SnodiStaffaDoppia_" + grp, type: "", o: [x, 0, zm], rot: 0, ifc: BR });
    else out.push(
      { k: "att", key: "att|" + se, fam: "RFI_AttaccoMensola_E66013_" + se, type: "", o: [0, 0, zm], rot: 0, ifc: BR },
      { k: "staffa", key: "staffa|" + se, fam: "RFI_AttaccoTirante_E66013_" + se, type: "", o: [0, 0, zm + ties[0].dh], rot: 0, ifc: BR });
    out.push({ k: "mens", key: "mens|" + Math.round(mens * 1000), fam: "RFI_Mensola_D76x5", type: R.rfi.mens || "", o: [x, -(w2 + SBALZO) / 1000, zm], rot: 0, ifc: ["IFCMEMBER", "MEMBER"] });
    ties.forEach((t, i) => out.push({ k: "tir" + (i ? String(i + 1) : ""), own: tiranteSolids(w2, zm * 1000, (zm + t.dh) * 1000, t.xt * 1000).map(toM), fam: "RFI_Tirante_D24", type: "", o: [x, 0, 0], rot: 0, ifc: ["IFCMEMBER", "TIEBAR"] }));
    // sospensione annidata (0.23.0): sull'asse del binario (Distanza_binario), alla quota della mensola, la prima del tool
    out.push(...sospPieces(R.rfi.sosp, R.stag, [x, -(R.dr + C.GAUGE_HALF + M.w / 2), zm - SOSP_Z_MENS], 0));
  }
  return out;
}
/* la sospensione RFI_Sospensione_PL_Acciaio_440 del tipo type con poligonazione pol (m) in o, ruotata di rot: due pezzi,
   gli isolatori a parte (IfcDiscreteAccessory .INSULATOR.) */
function sospPieces(type, pol, o, rot) {
  const a = type + "," + Math.round(pol * 1000);
  return [
    { k: "sospR", key: "sospR|" + a, fam: "RFI_Sospensione_PL_Acciaio_440", type, pol, o, rot, ifc: ["IFCDISCRETEACCESSORY", "NOTDEFINED"] },
    { k: "isoR", key: "isoR|" + a, fam: "RFI_IsolatorePortante_E64447", type: "", pol, o, rot, ifc: ["IFCDISCRETEACCESSORY", "INSULATOR"] },
  ];
}
function portalPieces(R) {
  const rf = R.rfi, out = [];
  const P = (k, key, fam, type, y, rot, ifc) => out.push({ k, key, fam, type, o: [0, y / 1000, 0], rot, ifc });
  const F = ["IFCFOOTING", "PAD_FOOTING"], COL = ["IFCCOLUMN", "STANDCOLUMN"], BR = ["IFCDISCRETEACCESSORY", "BRACKET"], BM = ["IFCBEAM", "BEAM"];
  const luce = Math.round(rf.luce * 1000);
  /* MEC tipo C su 2 × LSU22 (0.24.0): per parte il sostegno RFI_Sostegno_2xLSU22_MEC (plinto P8D, 2 pali, attacco
     E 64906), il secondo ruotato di 180°; trave CLn + CCn + CLn centrata, annidata Z_T2 − Z_TRAVE più su */
  if (rf.kind === "MEC2") {
    const M = R.mast, Fd = R.found, c1 = Math.round(R.c1 * 1000) / 1000, zp = MEC2.Z_PIL / 1000;
    for (const [y, rot] of [[0, 0], [luce, PI]]) {
      out.push({ k: "plinto", key: "plinto|" + Fd.id + "|" + c1, Fd, fam: "RFI_Plinto_LSU", type: Fd.id, o: [0, y / 1000, zp], rot, ifc: F });
      for (const x of [-MEC2.X_PALI, MEC2.X_PALI]) out.push({ k: "palo", key: "palo|" + M.id, fam: "RFI_Palo_" + M.id, type: "", o: [x / 1000, y / 1000, zp], rot, ifc: COL });
      P("attTrave", "att2", "RFI_AttaccoTraveMEC_E64906_2xLSU22", "", y, rot, BR);
    }
    const [lat, cc] = MEC2_TRAVI[rf.type], Lcl = MEC_ELEMENTI[lat].L, Ltot = 2 * Lcl + MEC_ELEMENTI[cc].L, y0 = luce / 2 - Ltot / 2, dz = (MEC2.Z_T2 - MEC.Z_TRAVE) / 1000;
    const T = (key, fam, y, rot) => out.push({ k: "trave", key, fam, type: "", o: [0, y / 1000, dz], rot, ifc: BM });
    T("trMEC|" + lat, "RFI_TraveMEC_C_" + lat, y0, 0);
    T("trMEC|" + cc, "RFI_TraveMEC_C_" + cc, y0 + Lcl, 0);
    T("trMEC|" + lat, "RFI_TraveMEC_C_" + lat, luce / 2 + Ltot / 2, PI);
    return out;
  }
  if (rf.kind === "MEC") {
    for (const y of [0, luce]) {
      P("fond", "fondMEC", "RFI_Fondazione_P2MEC", "", y, 0, F);
      P("pilone", "pilMEC", "RFI_Pilone_E65041", "", y, 0, COL);
      P("attTrave", "attMEC", "RFI_Attacco_TraveMEC_E65110", "", y, 0, BR);
    }
    const cc = MEC_CENTRALE[rf.type], Lcl = MEC_ELEMENTI.CL2.L, Ltot = 2 * Lcl + MEC_ELEMENTI[cc].L, y0 = luce / 2 - Ltot / 2;
    P("trave", "trMEC|CL2", "RFI_TraveMEC_C_CL2", "", y0, 0, BM);
    P("trave", "trMEC|" + cc, "RFI_TraveMEC_C_" + cc, "", y0 + Lcl, 0, BM);
    P("trave", "trMEC|CL2", "RFI_TraveMEC_C_CL2", "", luce / 2 + Ltot / 2, PI, BM);
    return out;
  }
  for (const [y, rot] of [[0, 0], [luce, PI]]) {
    P("fond", "fondPOT", "RFI_Fondazione_POT", "", y, rot, F);
    P("pilone", "pilPOT", "RFI_Pilone_E65018_H9586", "", y, rot, COL);
  }
  if (rf.kind === "TRAL") { const k = TRAL_TRAVI[rf.type][0]; P("trave", "trTRAL|" + rf.type, "RFI_TraveTralicciata_" + k, "", 0, 0, BM); return out; }
  const [, nl, nc] = ORM_TRAVI[rf.type];
  P("trave", "trORM|L" + nl, "RFI_TraveOrmeggio_" + nl + "L", "", 0, 0, BM);
  P("trave", "trORM|C" + nc, "RFI_TraveOrmeggio_" + nc + "C", "", lenL(nl), 0, BM);
  P("trave", "trORM|L" + nl, "RFI_TraveOrmeggio_" + nl + "L", "", luce, PI, BM);
  return out;
}
/* le sospensioni del portale (0.23.0): per ogni posizione visibile (binario servito, ocs-catalog portalSuspSlots) tubo
   con i piatti, mensola col tirante e 2 piastre, l'assieme ruotato di 180° col tubo verso il pilone 1 sulla faccia −X
   della trave */
function portalSospPieces(R) {
  const S = R.sospRfi, out = [];
  if (!S) return out;
  const TB = PORTAL_BEAMS[beamKind(R.rfi.kind)], zm = Math.round(S.zm * 1000), x0 = -(TB.bt / 2 + SP.R_TUBO) / 1000;
  for (const sl of S.slots.filter((x) => x.vis)) {
    const P = (k, key, fam, z, ifc) => out.push({ k, key, fam, type: "", o: [x0, sl.y, z / 1000], rot: PI, ifc });
    P("sospP", "sospP|" + [TB.qt, TB.ht, zm].join(","), "RFI_SospensionePortale_SEGNAPOSTO", 0, ["IFCMEMBER", "MEMBER"]);
    P("mensP", "mensP|" + zm, "RFI_MensolaPortale_SEGNAPOSTO", 0, ["IFCMEMBER", "MEMBER"]);
    for (const z of [TB.qt + SP.CORRENTE, TB.qt + TB.ht]) P("piastraP", "piastraP", "RFI_PiastraTuboPortale_SEGNAPOSTO", z, ["IFCPLATE", "NOTDEFINED"]);
    out.push(...sospPieces(S.type, sl.pol, [x0, sl.y, zm / 1000 - SOSP_Z_MENS], PI));   // annidata nell'assieme, sull'asse del binario
  }
  return out;
}
/* le parti del tool (supportParts / portalParts) che la famiglia sostituisce: le altre (filo, assi dei binari,
   trasformatore, sezionatore) restano. Pendoli: col sostegno risolto R (0.23.0) anche quello della sospensione della
   famiglia — nel palo il primo («arm»: le sospensioni in più restano del tool), nel portale quelli dei binari con una
   posizione visibile */
export function replaces(k, R) {
  if (/^(pil|block|plate|mast|pole|mens|att|beam|tir\d*)$/.test(k)) return true;
  if (!R || !/^arm\d*$/.test(k)) return false;
  if (R.kind !== "portal") return k === "arm";
  const x = R.susp[k === "arm" ? 0 : +k.slice(3) - 1];
  return !!(x && R.sospRfi && R.sospRfi.slots.some((sl) => sl.vis && sl.track === x.track));
}

/* riferimento della famiglia nel mondo (coordinate dei binari) → { o: {x, y, z}, X: [x, y], Y: [x, y], th (angolo di X) }
   palo: asse del palo alla testa del pilastrino, X = s·tangente, Y via dal binario (come revitFrame, ma alla testa del
   pilastrino invece che al supercompattato: pilOut più su); portale: asse del pilone 1 (montante destro) sul
   supercompattato (= revitFrame), X = tangente della trave, Y verso il pilone 2 */
export function rfiFrame(T, s, R) {
  if (!R || !R.rfi) return null;
  if (R.kind === "portal") {
    const W = C.portalFrame(T, s, R);
    if (!W) return null;
    const o = W.at(0, -W.half, W.f.z + R.zBaseR - R.pilOut), X0 = [W.tx, W.ty];
    return { o, X: X0, Y: [-X0[1], X0[0]], th: Math.atan2(X0[1], X0[0]) };
  }
  const F = C.supportFrame(T, s.u, s.side);
  if (!F) return null;
  const { f, s: sg, at } = F, qc = sg * (R.dr + C.GAUGE_HALF + R.mast.w / 2);
  const X0 = [sg * f.tx, sg * f.ty];
  return { o: at(0, qc, f.z + R.baseDz), X: X0, Y: [-X0[1], X0[0]], th: Math.atan2(X0[1], X0[0]) };
}
/* i pezzi della famiglia nel mondo: { frame, pieces: [{ …pezzo, w: {x, y, z} origine nel mondo, th: angolo della sua X }] }
   o null (niente famiglia) */
export function rfiPlaced(T, s, R) {
  const pieces = rfiPieces(R), fr = pieces && rfiFrame(T, s, R);
  if (!fr) return null;
  return {
    frame: fr,
    pieces: pieces.map((p) => ({
      ...p,
      w: { x: fr.o.x + p.o[0] * fr.X[0] + p.o[1] * fr.Y[0], y: fr.o.y + p.o[0] * fr.X[1] + p.o[1] * fr.Y[1], z: fr.o.z + p.o[2] },
      th: fr.th + p.rot,
    })),
  };
}
/* i solidi di un pezzo (condiviso o suo) al livello lod */
export const solidsOf = (p, lod = "lattice") => (p.own ? atLod(p.own, lod) : pieceSolids(p.key, lod, p.Fd));

/* ---- misure (per i test contro le verifiche della sessione 18) -------------------------------------------------- */
const loopArea = (lp) => { let a = 0; for (let i = 0; i < lp.length; i++) { const p = lp[i], q = lp[(i + 1) % lp.length]; a += p[0] * q[1] - q[0] * p[1]; } return Math.abs(a) / 2; };
/* volume di un solido (m³): estrusione = area (meno i fori) × profondità; tondo = π (r² − ri²) × lunghezza; tondo piegato
   = π r² × lunghezza vera del percorso. I solidi sovrapposti contano due volte, come la somma dei volumi in Revit */
export function solidVolume(s) {
  if (s.t === "ext") return (loopArea(s.loop) - s.holes.reduce((a, h) => a + Math.PI * h[2] * h[2], 0)) * s.d;
  if (s.t === "bar") return Math.PI * (s.r * s.r - s.ri * s.ri) * norm(sub(s.b, s.a));
  return Math.PI * s.r * s.r * s.len;
}
export const volumeOf = (solids, keep = () => true) => solids.filter(keep).reduce((a, s) => a + solidVolume(s), 0);
