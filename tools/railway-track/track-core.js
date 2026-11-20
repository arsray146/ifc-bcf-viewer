/* =========================================================================
   Armamento ferroviario (Railway Track) — motore dell'armamento (tool 21, F2)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente DOM: si prova in Node (test/test_track_core.js). Unità: metri.
   Il binario è quello del motore della Trazione elettrica (ocs-core.js):
   trackFrame(T, u) dà il punto dell'asse, la livelletta (rotaia interna, zIn),
   il piano del ferro all'asse (z) e il rollio della sopraelevazione (roll).

   Riferimento «del piano del ferro» (a, b) a una progressiva: a lungo il piano
   del ferro inclinato con la sopraelevazione (+ a sinistra guardando avanti),
   b sulla sua normale (in alto), origine sul piano del ferro all'asse.
     L = (nx·cos r, ny·cos r, −sin r)   N = (nx·sin r, ny·sin r, cos r)
   Rotaie, traverse e piano superiore del ballast stanno in questo riferimento
   (la sovrastruttura ruota attorno alla rotaia interna: sezioni tipo RFI in
   curva, PIANO §6.4); il fondo del ballast no: sta sulla livelletta, in
   orizzontale (sub-ballast simmetrico anche in curva).

   - Rotaia: profilo del catalogo inclinato 1:20 verso l'interno; la cima sul
     piano del ferro, il fianco interno del fungo a 14 mm sotto la cima sulla
     metà dello scartamento (1 435 / 2).
   - Traversa: sotto il piede della rotaia la piastra (5 mm) e la sede; il fondo
     a b = piede − piastra − altezza sotto rotaia (−0,397 con 60E1 e RFI 240).
   - Ballast (sezione tipo RFI, Allegato A al MdP Sez. III): fra le traverse a
     filo della faccia superiore in mezzeria; cresta 0,10 sopra la traversa e a
     1,05 dal fianco interno della rotaia (1,15 con la 260); scarpa 4/3 in
     orizzontale; fondo = estradosso del sub-ballast a «depth» sotto la
     livelletta sull'asse (0,747), a schiena d'asino al 3 %. Oppure il
     supercompattato scelto (+ spessore del sub-ballast), dove c'è.
     Due binari vicini (i prismi si toccano): un ballast solo, diviso a metà
     interasse; il colmo del fondo passa lì (asse della piattaforma, RFI). Fra
     i binari il ballast sta a filo delle traverse (RFI) o alla quota della
     cresta (between = "crest", come il modello di Civil 3D della commessa).
     Taglio verticale (cutL / cutR, 0.3.1): il ballast finisce con una parete
     verticale a quella distanza orizzontale dall'asse (muretti paraballast,
     muri: nel modello della commessa i tratti «…_Verticale»).
   Sezione del ballast a 11 punti fissi (per estruderla, indici in BP): cresta
   sinistra, testata sinistra al piano fra le traverse, sotto la testata
   sinistra, sotto la testata destra, testata destra, cresta destra, punto
   intermedio destro, piede destro, colmo, piede sinistro, punto intermedio
   sinistro. Tre punti per lato [cresta, intermedio, piede] perché un lato
   può essere scarpa, parete del taglio, metà interasse a filo traverse o
   alla quota della cresta; quando non serve l'intermedio sta a metà fra gli
   altri due (allineato) — coordinate (q, z): q orizzontale dall'asse
   del binario (+ a sinistra), z quota assoluta. Il letto si ferma sotto le
   traverse (come il modello di Civil 3D della commessa): fra una traversa e
   l'altra c'è l'intaso (cribMesh), così ballast e traverse non si
   sovrappongono e il volume del ballast è quello vero.
   ========================================================================= */
import * as C from "../railway-ocs/ocs-core.js?v=0.24.0";
import * as K from "./track-catalog.js?v=0.5.2";

export const GAUGE_HALF = C.GAUGE_HALF;                 // 0,7175
export const GAUGE_DEPTH = 0.014;                        // lo scartamento si misura 14 mm sotto il piano di rotolamento
export const RAIL_TILT = 1 / 20;
/* crest: dal fianco interno della rotaia (m), per tipo di traversa (Allegato A: 240 → 1,05, 260 → 1,15; 230: stessa
   distanza dalla testata, 0,5675) */
export const CREST = { RFI240: 1.05, RFI260: 1.15, RFI230: 1.0 };
export const ARM_DEFAULT = {
  rail: "60E1", sleeper: "RFI240", pitch: 0.6,
  crest: null,            // null = quella della traversa (CREST)
  crestH: 0.10,           // cresta sopra la faccia superiore della traversa alla testata
  slope: 4 / 3,           // scarpa: orizzontale / verticale
  depth: 0.747,           // livelletta → fondo del ballast sull'asse del binario
  form: 0.03,             // pendenza trasversale del fondo
  bottom: "section",      // "section" = sezione tipo | "sc" = supercompattato (+ sub)
  sub: 0.12,              // sopra il supercompattato: sub-ballast
  share: true,            // un ballast solo coi binari vicini
  between: "sleeper",     // fra due binari: "sleeper" = a filo traverse (RFI) | "crest" = alla quota della cresta
  cutL: null, cutR: null, // taglio verticale a sinistra / a destra: distanza orizzontale dall'asse (m); vuoto o 0 = niente
  fall: "both",           // fondo della sezione tipo: "both" = a schiena d'asino | "left" / "right" = a una falda che scende
                          // verso sinistra / destra (0.3.2: SF02 in curva e sui binari lontani dal vicino)
};
export const ROW_KEYS = ["rail", "sleeper", "pitch", "crest", "crestH", "slope", "depth", "form", "bottom", "sub", "between", "cutL", "cutR", "fall"];

/* ---- regole per binario e tratto ------------------------------------------------------------------------------
   t.arm = { ...valori del binario, rows: [{ u0, u1, ...valori del tratto }] } (u = progressiva dall'inizio dell'asse);
   un valore mancante si prende dal binario, poi dal default; il tratto più in basso nell'elenco vince */
export function armAt(arm, u) {
  const out = { ...ARM_DEFAULT };
  for (const k of ROW_KEYS) if (arm && arm[k] != null) out[k] = arm[k];
  out.share = arm && arm.share != null ? !!arm.share : ARM_DEFAULT.share;
  for (const r of (arm && arm.rows) || []) if (u >= r.u0 - 1e-9 && u <= r.u1 + 1e-9) for (const k of ROW_KEYS) if (r[k] != null && r[k] !== "") out[k] = r[k];
  if (!K.RAILS[out.rail]) out.rail = ARM_DEFAULT.rail;
  if (!K.SLEEPERS[out.sleeper]) out.sleeper = ARM_DEFAULT.sleeper;
  if (!(out.pitch > 0.2)) out.pitch = ARM_DEFAULT.pitch;
  if (out.crest == null) out.crest = CREST[out.sleeper] ?? 1.05;
  if (out.between !== "crest") out.between = "sleeper";
  if (out.fall !== "left" && out.fall !== "right") out.fall = "both";
  for (const k of ["cutL", "cutR"]) out[k] = Number(out[k]) > 0 ? Number(out[k]) : null;
  return out;
}
/* capi dei tratti (per spezzare l'estrusione dove cambiano le regole) */
export function armBreaks(arm, L) {
  const s = new Set();
  for (const r of (arm && arm.rows) || []) for (const x of [r.u0, r.u1]) if (x > 1e-6 && x < L - 1e-6) s.add(x);
  return [...s].sort((a, b) => a - b);
}

/* ---- rotaia nel riferimento del piano del ferro ----------------------------------------------------------------- */
const RAIL_CACHE = new Map();
/* contorno della rotaia sinistra (a, b) e destra, inclinate 1:20 verso l'interno, cima a b = 0, fianco interno a 14 mm
   sotto la cima sulla metà dello scartamento; foot = piede (centro della base) della sinistra */
export function railShape(type, chord = 0.002) {
  const key = type + "|" + chord;
  if (RAIL_CACHE.has(key)) return RAIL_CACHE.get(key);
  const P = K.railOutline(type, chord), al = Math.atan(RAIL_TILT), ca = Math.cos(al), sa = Math.sin(al);
  // la sinistra pende verso −a (l'interno): rotazione antioraria di al
  const R = P.map(([x, y]) => [x * ca - y * sa, x * sa + y * ca]);
  const top = Math.max(...R.map((p) => p[1])), yg = top - GAUGE_DEPTH;
  let ain = Infinity;                                      // fianco interno (a minima) alla quota dello scartamento
  for (let i = 0; i < R.length; i++) {
    const p = R[i], q = R[(i + 1) % R.length];
    if ((p[1] - yg) * (q[1] - yg) <= 0 && p[1] !== q[1]) { const t = (yg - p[1]) / (q[1] - p[1]); ain = Math.min(ain, p[0] + t * (q[0] - p[0])); }
  }
  const da = GAUGE_HALF - ain, db = -top;
  const left = R.map(([x, y]) => [x + da, y + db]);
  const right = left.map(([a, b]) => [-a, b]).reverse();   // specchiata, sempre antioraria
  // foot = centro della base, head = centro del fungo in cima (prima dell'inclinazione: (0, h)); topA = punto più alto
  // (con la corona R300 inclinata sta più in fuori del centro del fungo)
  const H0 = Math.max(...P.map((p) => p[1]));
  const out = { left, right, foot: [da, db], head: [-H0 * sa + da, H0 * ca + db], h: top, topA: left[left.reduce((m, p, i) => (p[1] > left[m][1] ? i : m), 0)][0] };
  RAIL_CACHE.set(key, out);
  return out;
}

/* ---- riferimento del piano del ferro a una progressiva ------------------------------------------------------------ */
export function railFrame(T, u) {
  const f = C.trackFrame(T, Math.max(0, Math.min(T.H.length, u)));
  const cr = Math.cos(f.roll), sr = Math.sin(f.roll);
  return { f, L: [f.nx * cr, f.ny * cr, -sr], N: [f.nx * sr, f.ny * sr, cr], cr, sr };
}
/* (a, b) del riferimento del piano del ferro → punto del mondo */
export const rf3 = (R, a, b) => [R.f.x + a * R.L[0] + b * R.N[0], R.f.y + a * R.L[1] + b * R.N[1], R.f.z + a * R.L[2] + b * R.N[2]];
/* (a, b) → (q, z) della sezione orizzontale */
export const rfQz = (R, a, b) => [a * R.cr + b * R.sr, R.f.z - a * R.sr + b * R.cr];

/* ---- traverse ---------------------------------------------------------------------------------------------------- */
const SLEEPER_CACHE = new Map();
export function sleeperGeom(type) {
  if (SLEEPER_CACHE.has(type)) return SLEEPER_CACHE.get(type);
  const m = K.sleeperMesh(type), half = K.sleeperHalf(type), T = K.SLEEPERS[type];
  const pts = half.pts, hEnd = pts[1].h / 1000, hMid = pts[pts.length - 1].h / 1000;
  const g = { mesh: m, L: T.L / 1000, b1: T.b1 / 1000, seatX: m.seatX, seatZ: m.seatZ, hEnd, hMid };
  SLEEPER_CACHE.set(type, g);
  return g;
}
/* quota (b) del fondo della traversa nel riferimento del piano del ferro */
export function sleeperBottom(cfg) {
  const rs = railShape(cfg.rail), sg = sleeperGeom(cfg.sleeper);
  return rs.foot[1] - K.PAD / 1000 - sg.seatZ;
}
/* posizioni delle traverse: a passo pitch (del tratto), la prima a metà passo dall'inizio; [{ u, k, type }] */
export function sleeperStations(T, arm) {
  const L = T.H.length, out = [];
  let u = armAt(arm, 0).pitch / 2, k = 1;
  while (u <= L - 1e-9) {
    const c = armAt(arm, u);
    out.push({ u, k: k++, type: c.sleeper });
    u += c.pitch;
  }
  if (out.length && L - out[out.length - 1].u < armAt(arm, L).pitch / 2 - 1e-9 && out.length > 1) out.pop();   // l'ultima non sporge oltre il capo
  return out;
}
/* posa di una traversa: origine (centro della base), assi x (lungo la traversa, + a sinistra), y, z (in alto) */
export function sleeperPose(T, u, cfg) {
  const R = railFrame(T, u), b = sleeperBottom(cfg);
  const o = rf3(R, 0, b), X = R.L, Z = R.N;
  const Y = [Z[1] * X[2] - Z[2] * X[1], Z[2] * X[0] - Z[0] * X[2], Z[0] * X[1] - Z[1] * X[0]];
  return { o, x: X, y: Y, z: Z };
}

/* ---- binari vicini ------------------------------------------------------------------------------------------------
   per ogni progressiva di us il binario più vicino a sinistra e a destra entro reach: { d (> 0), zIn } — la proiezione
   cammina lungo l'indice dell'altro binario partendo da dove era (lineare nel numero di stazioni) */
export function neighborsAlong(T, us, others, reach = 8) {
  const out = us.map(() => ({ left: null, right: null }));
  for (const ix of others) {
    const n = ix.us.length;
    let j = -1;
    us.forEach((u, i) => {
      const f = C.trackFrame(T, u);
      if (j < 0) {                                          // primo aggancio: ricerca piena
        let best = Infinity;
        for (let k = 0; k < n; k++) { const d = (ix.xs[k] - f.x) ** 2 + (ix.ys[k] - f.y) ** 2; if (d < best) { best = d; j = k; } }
      } else {                                              // poi solo attorno al precedente
        let best = (ix.xs[j] - f.x) ** 2 + (ix.ys[j] - f.y) ** 2;
        for (let moved = true; moved;) {
          moved = false;
          for (const k of [j - 1, j + 1]) if (k >= 0 && k < n) { const d = (ix.xs[k] - f.x) ** 2 + (ix.ys[k] - f.y) ** 2; if (d < best) { best = d; j = k; moved = true; } }
        }
      }
      // affinamento sul segmento migliore e la normale del binario vero
      let uo = ix.us[j], g = C.trackFrame(ix.T, uo);
      for (let it = 0; it < 6; it++) {
        const along = (f.x - g.x) * g.tx + (f.y - g.y) * g.ty;
        const nu = Math.max(0, Math.min(ix.T.H.length, uo + along));
        if (Math.abs(nu - uo) < 1e-6) break;
        uo = nu; g = C.trackFrame(ix.T, uo);
      }
      const along = (f.x - g.x) * g.tx + (f.y - g.y) * g.ty;
      if (Math.abs(along) > 0.5) return;                    // oltre i capi dell'altro binario
      const lat = (g.x - f.x) * f.nx + (g.y - f.y) * f.ny, d = Math.abs(lat);
      if (!(d > 0.5 && d <= reach)) return;
      const side = lat > 0 ? "left" : "right", cur = out[i][side];
      if (!cur || d < cur.d) out[i][side] = { d, zIn: g.zIn, z: g.z };
    });
  }
  return out;
}

/* ---- sezione del ballast --------------------------------------------------------------------------------------- */
/* nb = { left, right } di neighborsAlong; scAt(E, N) → quota del supercompattato o null; wallAt(f) → { left, right }:
   distanza orizzontale dall'asse dei muri scelti (track-core wallCuts) o null — tagliano il ballast come cutL / cutR,
   vince il più vicino all'asse */
export function ballastSection(T, u, cfg, nb = null, scAt = null, notch = true, wallAt = null) {
  const R = railFrame(T, u), f = R.f, sg = sleeperGeom(cfg.sleeper);
  const bBot = sleeperBottom(cfg), bCrib = bBot + sg.hMid, bCrest = bBot + sg.hEnd + cfg.crestH;
  const aCrest = GAUGE_HALF + cfg.crest, aEnd = sg.L / 2;
  const P = (a, b) => rfQz(R, a, b);
  // lati divisi con un vicino: a metà interasse, se i prismi si toccano
  const run = cfg.slope;
  const shared = { left: null, right: null };
  // fondo: colmo sull'asse (semplice binario) o a metà interasse verso il vicino (asse della piattaforma)
  let qr = 0;
  const near = { left: nb && cfg.share ? nb.left : null, right: nb && cfg.share ? nb.right : null };
  // «depth» è quotata sull'asse del binario anche col colmo a metà interasse (Allegato A, doppio binario)
  // a una falda (0.3.2): una retta che scende verso il lato scelto, sempre a «depth» sotto la livelletta sull'asse
  const fallS = cfg.fall === "left" ? 1 : cfg.fall === "right" ? -1 : 0;
  const formSec = (q) => (fallS ? f.zIn - cfg.depth - fallS * cfg.form * q : f.zIn - cfg.depth + cfg.form * Math.abs(qr) - cfg.form * Math.abs(q - qr));
  const zSc = (q) => {
    if (!scAt) return null;
    const z = scAt(f.x + q * f.nx, f.y + q * f.ny);
    return Number.isFinite(z) ? z + cfg.sub : null;
  };
  const useSc = cfg.bottom === "sc" && !!scAt;
  const form = (q) => { if (useSc) { const z = zSc(q); if (z != null) return z; } return formSec(q); };
  // piede di una scarpa: dalla cresta (q0, z0) verso s, scende di 1 ogni run; incontro col fondo (bisezione)
  const toe = (q0, z0, s) => {
    const g = (t) => z0 - t - form(q0 + s * t * run);
    let lo = 0, hi = 0.5;
    if (g(0) <= 0) return [q0, z0];
    while (g(hi) > 0 && hi < 20) { lo = hi; hi *= 2; }
    for (let it = 0; it < 40; it++) { const m = (lo + hi) / 2; if (g(m) > 0) lo = m; else hi = m; }
    const t = (lo + hi) / 2;
    return [q0 + s * t * run, z0 - t];
  };
  const cl = P(aCrest, bCrest), cr = P(-aCrest, bCrest);
  // taglio verticale del lato s (distanza orizzontale dall'asse): mai dentro la traversa (almeno 1 cm oltre la testata)
  const wc = wallAt ? wallAt(f) : null;
  const cutOf = (s) => {
    const cs = [s > 0 ? cfg.cutL : cfg.cutR, wc && (s > 0 ? wc.left : wc.right)].filter((c) => c > 0);
    return cs.length ? s * Math.max(Math.min(...cs), aEnd + 0.01) : null;
  };
  for (const [side, s] of [["left", 1], ["right", -1]]) {
    const v = near[side];
    if (!v) continue;
    const t0 = toe(s > 0 ? cl[0] : cr[0], s > 0 ? cl[1] : cr[1], s), qc = cutOf(s);
    // la metà interasse cade dentro il mio piede (e un taglio più vicino all'asse non la nasconde)
    if (v.d / 2 < Math.abs(t0[0]) && !(qc != null && Math.abs(qc) < v.d / 2)) shared[side] = s * v.d / 2;
  }
  if (shared.left != null && shared.right == null) qr = shared.left;
  else if (shared.right != null && shared.left == null) qr = shared.right;
  // piani superiori ruotati col binario, prolungati fino a metà interasse: fra le traverse (a filo della mezzeria) e
  // alla quota della cresta
  const plane = (b) => (q) => { const p0 = P(0, b); return p0[1] - (q - p0[0]) * Math.tan(f.roll); };
  const crib = plane(bCrib), crestPlane = plane(bCrest);
  const eL = P(aEnd, bCrib), eR = P(-aEnd, bCrib);
  // quota del piano superiore fuori dalla traversa: la spalla dalla testata alla cresta, poi la scarpa
  const topAt = (q, s) => {
    const e = s > 0 ? eL : eR, c = s > 0 ? cl : cr;
    if (s * q <= s * c[0]) return e[1] + (c[1] - e[1]) * (q - e[0]) / (c[0] - e[0]);
    return c[1] - s * (q - c[0]) / run;
  };
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  // un lato, dall'alto in basso: [cresta, intermedio, piede] (l'intermedio a metà fra gli altri due quando non serve)
  const side3 = (s) => {
    const sh = shared[s > 0 ? "left" : "right"], c = s > 0 ? cl : cr, qc = cutOf(s);
    if (sh != null) {                                        // metà interasse col vicino
      const t = [sh, form(sh)];
      if (cfg.between === "crest" && s * c[0] < s * sh) return [c, [sh, crestPlane(sh)], t];
      const top = [sh, cfg.between === "crest" && s * sh > s * (s > 0 ? eL : eR)[0] ? topAt(sh, s) : crib(sh)];
      return [top, mid(top, t), t];
    }
    const t0 = toe(c[0], c[1], s);
    if (qc != null && s * qc < s * t0[0]) {                  // parete verticale prima del piede della scarpa
      const t = [qc, form(qc)];
      if (s * qc > s * c[0]) return [c, [qc, topAt(qc, s)], t];
      const top = [qc, topAt(qc, s)];
      return [top, mid(top, t), t];
    }
    return [c, mid(c, t0), t0];
  };
  let [cL, mL, tL] = side3(1), [cR, mR, tR] = side3(-1);
  // incavo delle traverse: il letto si ferma sotto la base delle traverse, fra le testate; fra una traversa e l'altra
  // c'è l'intaso (cribMesh). notch = false (oltre la prima e l'ultima traversa): incavo chiuso a 1 mm, piano
  const bN = notch ? bBot : bCrib - 0.001;
  const nL0 = P(aEnd, bN), nR0 = P(-aEnd, bN);
  let nL = nL0, nR = nR0, eL2 = eL, eR2 = eR;
  // assi a meno di una traversa (dove un tronchino o un deviatoio si stacca: lo scambio è la F5): la metà interasse cade
  // dentro la traversa e anche testata e incavo si fermano lì — prima la linea sotto le traverse passava oltre e la
  // sezione si incrociava (0.4.0: AutoCAD rifiuta quei solidi). Sopra l'incavo lì c'è la traversa: il letto finisce
  // sotto, cresta e testata scendono sull'incavo e il punto intermedio sta fra incavo e piede (se restavano al piano
  // fra le traverse, il contorno saliva lungo il taglio e tornava giù: una pinna di spessore nullo, solido non valido)
  const zN = (q) => nR0[1] + (nL0[1] - nR0[1]) * (q - nR0[0]) / (nL0[0] - nR0[0]);
  if (shared.left != null && shared.left < eL[0]) { nL = [shared.left, zN(shared.left)]; eL2 = cL = nL; mL = mid(nL, tL); }
  if (shared.right != null && shared.right > eR[0]) { nR = [shared.right, zN(shared.right)]; eR2 = cR = nR; mR = mid(nR, tR); }
  const qRidge = Math.max(tR[0], Math.min(tL[0], qr));
  const pts = [cL, eL2, nL, nR, eR2, cR, mR, tR, [qRidge, form(qRidge)], tL, mL];
  return { pts, shared, qr, bBot, bCrib, bCrest, R };
}
/* indici dei punti della sezione del ballast */
export const BP = { crestL: 0, endL: 1, notchL: 2, notchR: 3, endR: 4, crestR: 5, midR: 6, toeR: 7, ridge: 8, toeL: 9, midL: 10 };

/* ---- intaso fra le traverse -------------------------------------------------------------------------------------------
   un blocco di ballast fra due traverse coi centri a G metri: dalla base delle traverse alla faccia superiore in
   mezzeria (il piano del ballast fra le traverse), lungo quanto la traversa; le facce verso le traverse seguono i
   loro fianchi sformati (base b1, cima b2 alla quota della sezione). Riferimento della traversa: x lungo la traversa,
   y lungo il binario (centro a metà fra le due), z dalla base. */
const CRIB_CACHE = new Map();
export function cribMesh(type, G) {
  const key = type + "|" + G.toFixed(4);
  if (CRIB_CACHE.has(key)) return CRIB_CACHE.get(key);
  const half = K.sleeperHalf(type), T = K.SLEEPERS[type], L2 = T.L / 2000, P = half.pts, hc = P[P.length - 1].h / 1000;
  const all = [];
  for (const p of P) all.push({ x: -(L2 - p.s / 1000), ...p });
  for (let i = P.length - 2; i >= 0; i--) all.push({ x: L2 - P[i].s / 1000, ...P[i] });
  for (const q of all) { q.wb = q.b1 / 2000; q.wt = q.wb - (q.b1 - q.b2) / 2000 * Math.min(1, hc / (q.h / 1000)); }   // fianco della traversa alla quota hc
  // F3: si tengono solo le sezioni che l'interpolazione fra le vicine non rifà entro 1 mm (164 → 76 triangoli con la
  // 240: in vista e nell'IFC le traverse sono migliaia)
  const fits = (a, b) => {
    for (let k = a + 1; k < b; k++) {
      const t = (all[k].x - all[a].x) / (all[b].x - all[a].x);
      for (const w of ["wb", "wt"]) if (Math.abs(all[a][w] + t * (all[b][w] - all[a][w]) - all[k][w]) > 0.001) return false;
    }
    return true;
  };
  const secs = [all[0]];
  for (let i = 0; i < all.length - 1;) { let j = i + 1; while (j + 1 < all.length && fits(i, j + 1)) j++; secs.push(all[j]); i = j; }
  const pos = [], idx = [];
  for (const q of secs) {
    const y0 = -G / 2, y1 = G / 2;
    pos.push(q.x, y0 + q.wb, 0, q.x, y1 - q.wb, 0, q.x, y1 - q.wt, hc, q.x, y0 + q.wt, hc);
  }
  const n = secs.length;
  for (let k = 0; k + 1 < n; k++) {
    const a = 4 * k, b = 4 * (k + 1);
    for (const [i0, i1] of [[0, 1], [1, 2], [2, 3], [3, 0]]) idx.push(a + i0, b + i1, b + i0, a + i0, a + i1, b + i1);
  }
  const e1 = 4 * (n - 1);
  idx.push(0, 2, 1, 0, 3, 2, e1, e1 + 1, e1 + 2, e1, e1 + 2, e1 + 3);
  let out = { pos: Float64Array.from(pos), idx: Uint32Array.from(idx) };
  if (meshVolume(out.pos, out.idx) < 0) for (let k = 0; k < out.idx.length; k += 3) { const t = out.idx[k]; out.idx[k] = out.idx[k + 2]; out.idx[k + 2] = t; }
  out.vol = meshVolume(out.pos, out.idx);
  CRIB_CACHE.set(key, out);
  return out;
}
/* intasi di un binario: uno fra ogni coppia di traverse vicine, a metà strada; [{ k (della traversa prima), u, G, type }]
   (G arrotondato al mm) */
export function cribStations(T, arm, ss = sleeperStations(T, arm)) {
  const out = [];
  for (let i = 0; i + 1 < ss.length; i++) out.push({ k: ss[i].k, u: (ss[i].u + ss[i + 1].u) / 2, G: Math.round((ss[i + 1].u - ss[i].u) * 1000) / 1000, type: ss[i].type });
  return out;
}

/* ---- estrusione ----------------------------------------------------------------------------------------------------
   anelli (stesso numero di punti, coordinate del mondo) → solido chiuso: lati fra anelli vicini e tappi ai capi
   (triangolati col taglio delle orecchie), normali verso l'esterno (si gira tutto se il volume esce negativo) */
export function earClip(poly) {
  const n = poly.length, idx = [...Array(n).keys()], out = [];
  let area = 0; for (let i = 0; i < n; i++) { const p = poly[i], q = poly[(i + 1) % n]; area += p[0] * q[1] - q[0] * p[1]; }
  const ccw = area > 0, cross = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const inside = (p, a, b, c) => { const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p); return ccw ? d1 > 1e-15 && d2 > 1e-15 && d3 > 1e-15 : d1 < -1e-15 && d2 < -1e-15 && d3 < -1e-15; };
  let guard = 0;
  while (idx.length > 3 && guard++ < 10000) {
    let cut = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic], cz = cross(a, b, c);
      if (ccw ? cz <= 1e-15 : cz >= -1e-15) continue;     // concavo o piatto
      if (idx.some((k) => k !== ia && k !== ib && k !== ic && inside(poly[k], a, b, c))) continue;
      out.push(ia, ib, ic); idx.splice(i, 1); cut = true; break;
    }
    // niente orecchie vere: un vertice allineato coi vicini (i punti intermedi della sezione del ballast) si toglie con
    // un triangolo nullo, così il tappo usa tutti i vertici e il solido resta chiuso
    if (!cut) for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = poly[ia], b = poly[ib], c = poly[ic], ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
      const straight = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]) >= 0;
      if (straight && Math.abs(cross(a, b, c)) <= 1e-9 * Math.max(ab * bc, 1e-18)) { out.push(ia, ib, ic); idx.splice(i, 1); cut = true; break; }
    }
    if (!cut) { // poligono degenere: chiude a ventaglio
      for (let i = 1; i + 1 < idx.length; i++) out.push(idx[0], idx[i], idx[i + 1]);
      return out;
    }
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}
/* rings: [[x, y, z] × m] × n; cap2d: lo stesso anello in 2D per triangolare i tappi (es. (q, z) o (a, b)) */
export function sweepRings(rings, cap2d, capEnd2d = cap2d) {
  const n = rings.length, m = rings[0].length, pos = new Float64Array(n * m * 3), idx = [];
  rings.forEach((r, i) => r.forEach((p, j) => { pos.set(p, 3 * (i * m + j)); }));
  for (let i = 0; i + 1 < n; i++) for (let j = 0; j < m; j++) {
    const a = i * m + j, b = i * m + ((j + 1) % m), c = (i + 1) * m + ((j + 1) % m), d = (i + 1) * m + j;
    idx.push(a, b, c, a, c, d);
  }
  // ogni tappo triangolato sulla sua sezione (0.3.1: un pezzo di ballast può cominciare su un binario semplice e finire
  // diviso col vicino, con una forma diversa)
  const tri = earClip(cap2d), triE = capEnd2d === cap2d ? tri : earClip(capEnd2d);
  for (let k = 0; k < tri.length; k += 3) idx.push(tri[k + 2], tri[k + 1], tri[k]);                       // tappo d'inizio
  for (let k = 0; k < triE.length; k += 3) idx.push((n - 1) * m + triE[k], (n - 1) * m + triE[k + 1], (n - 1) * m + triE[k + 2]);   // tappo di fine
  const out = { pos, idx: Uint32Array.from(idx) };
  if (meshVolume(out.pos, out.idx) < 0) for (let k = 0; k < out.idx.length; k += 3) { const t = out.idx[k]; out.idx[k] = out.idx[k + 2]; out.idx[k + 2] = t; }
  return out;
}
export function meshVolume(pos, idx) {
  let V = 0, ox = pos[0], oy = pos[1], oz = pos[2];             // attorno al primo vertice: niente cancellazioni a coordinate di mappa
  for (let i = 0; i < idx.length; i += 3) {
    const a = 3 * idx[i], b = 3 * idx[i + 1], c = 3 * idx[i + 2];
    const ax = pos[a] - ox, ay = pos[a + 1] - oy, az = pos[a + 2] - oz, bx = pos[b] - ox, by = pos[b + 1] - oy, bz = pos[b + 2] - oz, cx = pos[c] - ox, cy = pos[c + 1] - oy, cz = pos[c + 2] - oz;
    V += ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  }
  return V / 6;
}

/* ---- pezzi di un binario -------------------------------------------------------------------------------------------
   progressive dell'estrusione: quelle del binario al passo step + i capi dei tratti; spezzate ai capi dei tratti dove
   cambia la rotaia (il contorno cambia) o il fondo */
export function armStations(T, arm, step = 1) {
  const us = C.trackStations(T, step), br = armBreaks(arm, T.H.length);
  return [...new Set([...us, ...br])].sort((a, b) => a - b).filter((u, i, a) => i === 0 || u - a[i - 1] > 1e-6);
}
/* gruppi di progressive consecutive con la stessa chiave (un pezzo = un solido); key(regole, u) */
export function runsBy(us, arm, key) {
  const runs = [];
  for (const u of us) {
    const v = armAt(arm, Math.min(u + 1e-6, us[us.length - 1])), k = key(v, u), last = runs[runs.length - 1];
    if (last && last.k === k) last.us.push(u);
    else { if (last) last.us.push(u); runs.push({ k, cfg: v, us: [u] }); }
  }
  return runs.filter((r) => r.us.length > 1);
}
/* solidi delle rotaie del binario: [{ side, rail, pos, idx, u0, u1 }] */
export function railSolids(T, arm, step = 1, chord = 0.002) {
  const us = armStations(T, arm, step), out = [];
  for (const run of runsBy(us, arm, (c) => c.rail)) {
    const sh = railShape(run.cfg.rail, chord);
    for (const [side, P] of [["left", sh.left], ["right", sh.right]]) {
      const rings = run.us.map((u) => { const R = railFrame(T, u); return P.map(([a, b]) => rf3(R, a, b)); });
      out.push({ side, rail: run.cfg.rail, u0: run.us[0], u1: run.us[run.us.length - 1], ...sweepRings(rings, P) });
    }
  }
  return out;
}
/* solido del ballast del binario: [{ pos, idx, u0, u1 }] (spezzato dove cambiano traversa, cresta o fondo).
   opt.split = progressive a cui spezzarlo comunque (i capi dei tratti, per l'IFC); opt.tol > 0 = toglie le sezioni
   che l'interpolazione fra le vicine rifà entro tol (m) — per l'IFC: in rettifilo una sezione ogni tanto basta;
   opt.wallAt = i muri scelti (wallCuts), come in ballastSection */
export function ballastSolids(T, arm, step = 1, nbFn = null, scAt = null, ss = sleeperStations(T, arm), opt = {}) {
  // incavo delle traverse dalla faccia della prima traversa a quella dell'ultima: fuori il ballast è pieno fino al
  // piano fra le traverse (gradino verticale: due progressive a 0,1 mm)
  const L = T.H.length, eps = 1e-4;
  let uf = -1, ul = -1;
  if (ss.length) { uf = Math.max(0, ss[0].u - K.SLEEPERS[ss[0].type].b1 / 2000); ul = Math.min(L, ss[ss.length - 1].u + K.SLEEPERS[ss[ss.length - 1].type].b1 / 2000); }
  const extra = ss.length ? [uf - eps, uf, ul, ul + eps].filter((x) => x > 0 && x < L) : [];
  const us = [...new Set([...armStations(T, arm, step), ...extra])].sort((a, b) => a - b).filter((u, i, a) => i === 0 || u - a[i - 1] > 1e-6);
  const nb = nbFn ? nbFn(us) : null, iOf = new Map(us.map((u, i) => [u, i])), out = [];
  const notchAt = (u) => ss.length > 0 && u >= uf - 1e-9 && u <= ul + 1e-9;
  const split = (opt.split || []).slice().sort((a, b) => a - b), partAt = (u) => split.filter((x) => x <= u + 1e-6).length;
  const key = (c, u) => [partAt(u), c.sleeper, c.crest, c.crestH, c.slope, c.depth, c.form, c.bottom, c.sub, c.between, c.cutL, c.cutR, c.fall].join("|");
  for (const run of runsBy(us, arm, key)) {
    let secs = run.us.map((u) => ballastSection(T, u, armAt(arm, Math.min(u + 1e-6, T.H.length)), nb ? nb[iOf.get(u)] : null, scAt, notchAt(u), opt.wallAt || null));
    let rings = secs.map((s) => { const f = s.R.f; return s.pts.map(([q, z]) => [f.x + q * f.nx, f.y + q * f.ny, z]); });
    let uu = run.us;
    if (opt.tol > 0) {
      const keep = simplifyRings(uu, rings, opt.tol);
      secs = keep.map((i) => secs[i]); rings = keep.map((i) => rings[i]); uu = keep.map((i) => uu[i]);
    }
    out.push({ u0: uu[0], u1: uu[uu.length - 1], us: uu, ...sweepRings(rings, secs[0].pts, secs[secs.length - 1].pts), secs });
  }
  return out;
}
/* sezioni da tenere: da una tenuta si va avanti finché le sezioni saltate stanno entro tol dall'interpolazione
   lineare (per progressiva) fra le due tenute; al più span metri per volta. Indici crescenti, primo e ultimo sempre */
export function simplifyRings(us, rings, tol, span = 200) {
  const n = rings.length;
  if (n <= 2) return [...Array(n).keys()];
  const fits = (a, b) => {
    const du = us[b] - us[a], ra = rings[a], rb = rings[b];
    if (!(du > 0) || du > span) return false;
    for (let k = a + 1; k < b; k++) {
      const t = (us[k] - us[a]) / du, rk = rings[k];
      for (let p = 0; p < rk.length; p++) {
        const dx = ra[p][0] + t * (rb[p][0] - ra[p][0]) - rk[p][0], dy = ra[p][1] + t * (rb[p][1] - ra[p][1]) - rk[p][1], dz = ra[p][2] + t * (rb[p][2] - ra[p][2]) - rk[p][2];
        if (dx * dx + dy * dy + dz * dz > tol * tol) return false;
      }
    }
    return true;
  };
  const keep = [0];
  for (let i = 0; i < n - 1;) {
    let j = i + 1;
    while (j + 1 < n && fits(i, j + 1)) j++;
    keep.push(j); i = j;
  }
  return keep;
}

/* ---- muri (0.3.2) ------------------------------------------------------------------------------------------------------
   Muri, cordoli e muretti paraballast scelti in un IFC di contesto: i loro triangoli (coordinate del mondo) in una
   griglia di celle; a ogni sezione del ballast si tagliano col piano ⟂ al binario e, per lato, la faccia più vicina
   all'asse dentro la fascia del ballast fa da taglio verticale (come cutL / cutR, vince il più vicino).
   list = [{ P (x − ox, y − oy, z), I, ox, oy }] → indice o null */
export function wallIndex(list, cell = 4) {
  const tri = [], grid = new Map();
  for (const w of list || []) {
    const P = w.P, I = w.I, ox = w.ox || 0, oy = w.oy || 0;
    for (let k = 0; k + 2 < I.length; k += 3) {
      const t = tri.length / 9;
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let j = 0; j < 3; j++) {
        const v = 3 * I[k + j], x = P[v] + ox, y = P[v + 1] + oy;
        tri.push(x, y, P[v + 2]);
        x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
      }
      for (let cx = Math.floor(x0 / cell); cx <= Math.floor(x1 / cell); cx++) for (let cy = Math.floor(y0 / cell); cy <= Math.floor(y1 / cell); cy++) {
        const key = cx + "," + cy;
        if (!grid.has(key)) grid.set(key, []);
        grid.get(key).push(t);
      }
    }
  }
  return tri.length ? { tri: Float64Array.from(tri), grid, cell } : null;
}
/* i muri a una sezione (f = trackFrame): { left, right } = distanza orizzontale dall'asse della faccia più vicina, o
   null. Contano solo i pezzi di muro nella fascia del ballast — da zLo a zHi rispetto alla livelletta: niente soletta
   sotto, niente parapetti alti — e oltre qMin dall'asse (niente sotto le traverse); reach = fin dove si guarda (m) */
export function wallCuts(W, f, { reach = 8, zLo = -0.6, zHi = 0.3, qMin = 0.9 } = {}) {
  if (!W || !f) return null;
  const out = { left: null, right: null }, cell = W.cell, Tt = W.tri, seen = new Set();
  const n = Math.ceil(2 * reach / cell) * 2;
  for (let i = 0; i <= n; i++) {                            // celle lungo la traccia della sezione (e le vicine)
    const q = -reach + 2 * reach * i / n, cx = Math.floor((f.x + q * f.nx) / cell), cy = Math.floor((f.y + q * f.ny) / cell);
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) { const L = W.grid.get((cx + dx) + "," + (cy + dy)); if (L) for (const t of L) seen.add(t); }
  }
  for (const t of seen) {
    const b = 9 * t, d = [0, 1, 2].map((j) => (Tt[b + 3 * j] - f.x) * f.tx + (Tt[b + 3 * j + 1] - f.y) * f.ty), pts = [];
    for (const [a, c] of [[0, 1], [1, 2], [2, 0]]) {
      if ((d[a] > 0) === (d[c] > 0)) continue;
      const k = d[a] / (d[a] - d[c]), pa = b + 3 * a, pc = b + 3 * c;
      const X = Tt[pa] + k * (Tt[pc] - Tt[pa]), Y = Tt[pa + 1] + k * (Tt[pc + 1] - Tt[pa + 1]), Z = Tt[pa + 2] + k * (Tt[pc + 2] - Tt[pa + 2]);
      pts.push([(X - f.x) * f.nx + (Y - f.y) * f.ny, Z - f.zIn]);
    }
    if (pts.length !== 2) continue;
    // il segmento del taglio ristretto alla fascia del ballast
    let [[q0, z0], [q1, z1]] = pts, ta = 0, tb = 1;
    if (Math.abs(z1 - z0) > 1e-12) {
      const tLo = (zLo - z0) / (z1 - z0), tHi = (zHi - z0) / (z1 - z0);
      ta = Math.max(0, Math.min(tLo, tHi)); tb = Math.min(1, Math.max(tLo, tHi));
    } else if (z0 < zLo || z0 > zHi) continue;
    if (ta > tb) continue;
    for (const tt of [ta, tb]) {
      const q = q0 + tt * (q1 - q0);
      if (Math.abs(q) > reach) continue;
      if (q > qMin) out.left = out.left == null ? q : Math.min(out.left, q);
      else if (q < -qMin) out.right = out.right == null ? -q : Math.min(out.right, -q);
    }
  }
  return out.left == null && out.right == null ? null : out;
}

/* ---- tratti e pezzi per l'IFC (F3) -----------------------------------------------------------------------------------
   Un tratto = un intervallo fra i capi delle righe dei tratti (armBreaks): dentro le regole non cambiano. Nell'IFC
   ogni tratto ha le sue due rotaie (IfcRail) e il suo ballast (IfcCourse); le traverse stanno nel tratto del loro
   centro, gli intasi pure. Senza righe (PIANO §1) un pezzo al km: capi alle progressive tonde del file (s0 + u =
   k · 1000), tranne a meno di 50 m dai capi del binario (niente pezzi da pochi metri: vanno col vicino). */
export function trackParts(arm, L, s0 = 0) {
  const rows = (arm && arm.rows) || [], km = [];
  if (!rows.length) for (let k = Math.floor(s0 / 1000) + 1; k * 1000 - s0 < L - 50; k++) if (k * 1000 - s0 > 50) km.push(k * 1000 - s0);
  const xs = [0, ...(rows.length ? armBreaks(arm, L) : km), L];
  return xs.slice(0, -1).map((u0, i) => ({ i: i + 1, u0, u1: xs[i + 1], cfg: armAt(arm, (u0 + xs[i + 1]) / 2) }));
}
/* profilo di una rotaia per l'estrusione: contorno (a, b) del riferimento del piano del ferro spostato sul punto di
   riferimento ref = a metà fra il centro della base e il centro del fungo (dove gli errori di un estruso si dividono) */
export function railProfile(type, side, chord = 0.0005) {
  const sh = railShape(type, chord), s = side === "left" ? 1 : -1, P = side === "left" ? sh.left : sh.right;
  const ref = [s * (sh.foot[0] + sh.head[0]) / 2, (sh.foot[1] + sh.head[1]) / 2];
  return { ref, pts: P.map(([a, b]) => [a - ref[0], b - ref[1]]) };
}
/* una rotaia come spezzata di estrusi del profilo: [{ o (inizio, mondo), z (direzione), x (laterale del profilo),
   len }]. Dalle progressive us si va avanti finché la linea della rotaia sta entro tol dalla corda e il laterale
   (rollio della sopraelevazione, direzione) sta entro tol a una leva di 9 cm (mezza rotaia); al più maxLen metri.
   Gli estrusi si toccano nei punti della linea (le facce di testa si aprono di frazioni di mm in curva) */
export function railSegments(T, us, ref, tol = 0.001, maxLen = 200, lever = 0.09) {
  const P = [], Lv = [];
  for (const u of us) { const R = railFrame(T, u); P.push(rf3(R, ref[0], ref[1])); Lv.push(R.L); }
  const frame = (a, b) => {
    const d = [P[b][0] - P[a][0], P[b][1] - P[a][1], P[b][2] - P[a][2]], len = Math.hypot(d[0], d[1], d[2]);
    const z = d.map((v) => v / len), l = [0, 1, 2].map((j) => (Lv[a][j] + Lv[b][j]) / 2), dl = l[0] * z[0] + l[1] * z[1] + l[2] * z[2];
    const x0 = l.map((v, j) => v - dl * z[j]), nx = Math.hypot(x0[0], x0[1], x0[2]);
    return { o: P[a], z, x: x0.map((v) => v / nx), len };
  };
  const fits = (a, b) => {
    if (us[b] - us[a] > maxLen) return false;
    const F = frame(a, b);
    if (!(F.len > 1e-9)) return false;
    for (let k = a + 1; k < b; k++) {
      const v = [P[k][0] - F.o[0], P[k][1] - F.o[1], P[k][2] - F.o[2]], al = v[0] * F.z[0] + v[1] * F.z[1] + v[2] * F.z[2];
      if (Math.hypot(v[0] - al * F.z[0], v[1] - al * F.z[1], v[2] - al * F.z[2]) > tol) return false;
    }
    for (let k = a; k <= b; k++) {
      const l = Lv[k], dl = l[0] * F.z[0] + l[1] * F.z[1] + l[2] * F.z[2], x0 = [l[0] - dl * F.z[0], l[1] - dl * F.z[1], l[2] - dl * F.z[2]], nx = Math.hypot(...x0);
      if (Math.hypot(x0[0] / nx - F.x[0], x0[1] / nx - F.x[1], x0[2] / nx - F.x[2]) * lever > tol) return false;
    }
    return true;
  };
  const segs = [];
  for (let i = 0; i < us.length - 1;) {
    let j = i + 1;
    while (j + 1 < us.length && fits(i, j + 1)) j++;
    const F = frame(i, j);
    if (F.len > 1e-9) segs.push({ ...F, u0: us[i], u1: us[j] });
    i = j;
  }
  return segs;
}
/* l'armamento di un binario a tratti, per l'IFC e i Pset:
   [{ i, u0, u1, cfg, rails: [{ side, rail, prof, segs, len }], beds: [solidi del ballast], volBed,
      sleepers: [{ k, u, type, pose, pitch, cant }], cribs: [{ k, u, G, type, pose }], volCrib, vol }]
   opt: step (sezioni), nbFn / scAt (vicini e supercompattato, come ballastSolids), tolRail / tolBal (m), chord
   (profilo della rotaia) */
export function trackPieces(T, arm, opt = {}) {
  const { step = 1, nbFn = null, scAt = null, wallAt = null, tolRail = 0.001, tolBal = 0.005, chord = 0.0005 } = opt;
  const L = T.H.length, parts = trackParts(arm, L, T.s0 || 0), ss = sleeperStations(T, arm), us = armStations(T, arm, step);
  const partOf = (u) => { let k = 0; while (k + 1 < parts.length && u >= parts[k + 1].u0 - 1e-9) k++; return parts[k]; };
  for (const p of parts) {
    const pu = us.filter((u) => u >= p.u0 - 1e-9 && u <= p.u1 + 1e-9);
    p.rails = ["left", "right"].map((side) => {
      const prof = railProfile(p.cfg.rail, side, chord), segs = railSegments(T, pu, prof.ref, tolRail);
      return { side, rail: p.cfg.rail, prof, segs, len: segs.reduce((a, s) => a + s.len, 0) };
    });
    p.sleepers = []; p.cribs = []; p.beds = []; p.volCrib = 0; p.volBed = 0;
  }
  for (const s of ss) {
    const c = armAt(arm, s.u), f = C.trackFrame(T, s.u);
    partOf(s.u).sleepers.push({ k: s.k, u: s.u, type: s.type, pose: sleeperPose(T, s.u, c), pitch: c.pitch, cant: f.cant });
  }
  for (const c of cribStations(T, arm, ss)) {
    const p = partOf(c.u);
    p.cribs.push({ k: c.k, u: c.u, G: c.G, type: c.type, pose: sleeperPose(T, c.u, armAt(arm, c.u)) });
    p.volCrib += cribMesh(c.type, c.G).vol;
  }
  for (const b of ballastSolids(T, arm, step, nbFn, scAt, ss, { split: parts.slice(1).map((p) => p.u0), tol: tolBal, wallAt })) {
    const p = partOf((b.u0 + b.u1) / 2);
    p.beds.push(b); p.volBed += meshVolume(b.pos, b.idx);
  }
  for (const p of parts) p.vol = p.volBed + p.volCrib;
  return parts;
}
/* volume e massa di una traversa del tipo (scheda del fornitore se c'è, altrimenti calcestruzzo × volume) */
export function sleeperQty(type) {
  const g = sleeperGeom(type), vol = g.vol != null ? g.vol : (g.vol = K.meshVolume(g.mesh.pos, g.mesh.idx));
  return { vol, kg: K.SLEEPERS[type].mass != null ? K.SLEEPERS[type].mass : vol * K.CONCRETE_KG_M3 };
}
/* i valori dei campi Pset (track-catalog PSET_FIELDS) di un oggetto. kind: «project» e «site» (0.4.1, sotto), «track» (x = tratti di trackPieces),
   «rail» (x = rotaia del tratto), «sleeper» (x = traversa), «ballast» (x = tratto). ctx = { name (binario), s0
   (progressiva iniziale del file), L (lunghezza), part (il tratto, per rail / sleeper), lb: { left, right, bSec, bSc } } */
export function psetValues(kind, x, ctx = {}) {
  const s0 = ctx.s0 || 0, lb = ctx.lb || {}, p = ctx.part;
  // 0.4.1: progetto (x = [{ name, parts, L, s0 }] dei binari esportati; ctx.name = progetto) e sito (x = { E, N }:
  // l'origine dell'IfcSite, coordinate dei binari)
  if (kind === "project") {
    const per = x.map((t) => psetValues("track", t.parts, { name: t.name, s0: t.s0 || 0, L: t.L }));
    const uniq = (k) => [...new Set(per.flatMap((v) => (v[k] ? v[k].split(", ") : [])))].join(", ");
    return {
      prj: ctx.name, nTr: x.length, length: per.reduce((a, v) => a + v.length, 0), rail: uniq("rail"), sleeper: uniq("sleeper"),
      nSl: per.reduce((a, v) => a + v.nSl, 0), vol: per.reduce((a, v) => a + v.vol, 0), railKg: per.reduce((a, v) => a + v.railKg, 0),
    };
  }
  if (kind === "site") return { prj: ctx.name, E: x.E, N: x.N };
  if (kind === "track") {
    const parts = x, rails = [...new Set(parts.map((q) => q.cfg.rail))], sls = [...new Set(parts.flatMap((q) => q.sleepers.map((s) => s.type)))];
    return {
      track: ctx.name, from: s0, to: s0 + ctx.L, length: ctx.L, rail: rails.map((r) => K.RAILS[r].label).join(", "), sleeper: sls.map((t) => K.SLEEPERS[t].label).join(", "),
      nSl: parts.reduce((a, q) => a + q.sleepers.length, 0), vol: parts.reduce((a, q) => a + q.vol, 0),
      railKg: parts.reduce((a, q) => a + q.rails.reduce((b, r) => b + r.len * K.RAILS[r.rail].mass, 0), 0),
    };
  }
  if (kind === "rail") {
    const R = K.RAILS[x.rail];
    return { track: ctx.name, part: p.i, from: s0 + p.u0, to: s0 + p.u1, length: x.len, side: x.side === "left" ? lb.left : lb.right, rail: R.label, kgm: R.mass, kg: x.len * R.mass, tilt: "1:" + Math.round(1 / RAIL_TILT) };
  }
  if (kind === "sleeper") {
    const q = sleeperQty(x.type), o = x.pose.o;
    return { track: ctx.name, part: p.i, num: x.k, sta: s0 + x.u, sleeper: K.SLEEPERS[x.type].label, pitch: x.pitch, E: o[0], N: o[1], zBase: o[2], cant: x.cant, volC: q.vol, kg: q.kg };
  }
  if (kind === "ballast") {
    const c = x.cfg;
    return {
      track: ctx.name, part: x.i, from: s0 + x.u0, to: s0 + x.u1, length: x.u1 - x.u0, nSl: x.sleepers.length, vol: x.vol, volBed: x.volBed, volCrib: x.volCrib,
      bottom: c.bottom === "sc" ? lb.bSc : lb.bSec, fall: c.fall === "left" ? lb.fallL : c.fall === "right" ? lb.fallR : lb.fallBoth, crest: c.crest, crestH: c.crestH, slope: c.slope, depth: c.depth, form: c.form, sub: c.bottom === "sc" ? c.sub : null,
      sleeper: K.SLEEPERS[c.sleeper].label, pitch: c.pitch, between: c.between === "crest" ? lb.bwCrest : lb.bwSleeper, cutL: c.cutL, cutR: c.cutR,
    };
  }
  return {};
}
