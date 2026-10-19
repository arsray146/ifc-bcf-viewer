/* =========================================================================
   Trazione elettrica (Railway OCS) — catalogo fisso dei sostegni (tool 18, F2)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: dati e regole, provati in Node (test/test_ocs_catalog.js).
   Unità: metri. Da dove vengono i numeri (PIANO_Trazione_Elettrica.md §2.3, §2.4, §12):
   - pali LSU: disegno RFI E 66013 c (0.12.0, PIANO §22.2; prima i blocchi Satferr
     della Deviata Treviglio): fusto a/b/c = 8,20 / 9,60 / 12,00 m sopra la piastra,
     LSU nn = 2 UPN nn0 affacciate (profondità lungo il binario 140…240), vista
     trasversale 300 mm (LSU14-16) e 400 mm (LSU18-24), traliccio di tondi Ø20-24
     con modulo 266 mm; piastra 580 × 580 spessa 25…40, LSU24 730 × 680 × 45;
   - quote sul piano del ferro (fogli Satferr): fondo della piastra a −0,525 m,
     mensola a +6,02 m (attacco 115 mm oltre la faccia del palo), tirante da 1,0 a
     2,4 m sopra la mensola, braccio di poligonazione a +5,40 m, filo a 5,20 m;
   - DR = faccia del palo → bordo interno della rotaia più vicina (F0, §10.4);
   - mensole «Mensole acciaio 11»: lunghezze e codici del lookup del blocco;
   - fondazioni: E 64865 rev. f, foglio 3 (blocchi B, pilastrino eccentrico di A2
     verso il binario) e foglio 30 (blocchi P a ingombro ridotto, centrati);
   - trasformatori e sezionatori su palo: NESSUN tipologico (PIANO §7.5) →
     scatole con misure di partenza dichiarate da verificare.
   ========================================================================= */

/* ---- pali LSU ------------------------------------------------------------ */
export const HALF_GAUGE = 0.7175;                       // bordo interno della rotaia dall'asse (scartamento 1435)
export const MAST_SIZES = [14, 16, 18, 20, 22, 24];
export const MAST_HEIGHTS = { a: 8.2, b: 9.6, c: 12.0 };  // fusto sopra la piastra
export const LATTICE_MODULE = 0.266;                      // passo del traliccio fra le due UPN
/* E 66013 c (0.12.0, PIANO §22.2): LSU nn = 2 UPN nn0 (UNI 5680: b ala, tw anima, tf ala), piastra per taglia
   (a trasversale, b lungo il binario, t spessore), tondi del traliccio Ø lat, tirafondi Ø bolt, peso a/b/c in kg */
export const LSU_SPECS = {
  14: { upn: { b: 0.06, tw: 0.007, tf: 0.01 }, plate: { a: 0.58, b: 0.58, t: 0.025 }, lat: 0.02, bolt: 0.042, kg: { a: 397, b: 448, c: 540 } },
  16: { upn: { b: 0.065, tw: 0.0075, tf: 0.0105 }, plate: { a: 0.58, b: 0.58, t: 0.03 }, lat: 0.02, bolt: 0.042, kg: { a: 458, b: 520, c: 625 } },
  18: { upn: { b: 0.07, tw: 0.008, tf: 0.011 }, plate: { a: 0.58, b: 0.58, t: 0.035 }, lat: 0.022, bolt: 0.045, kg: { a: 550, b: 620, c: 748 } },
  20: { upn: { b: 0.075, tw: 0.0085, tf: 0.0115 }, plate: { a: 0.58, b: 0.58, t: 0.04 }, lat: 0.022, bolt: 0.052, kg: { a: 625, b: 705, c: 850 } },
  22: { upn: { b: 0.08, tw: 0.009, tf: 0.0125 }, plate: { a: 0.58, b: 0.58, t: 0.04 }, lat: 0.024, bolt: 0.052, kg: { a: 700, b: 790, c: 960 } },
  24: { upn: { b: 0.085, tw: 0.0095, tf: 0.013 }, plate: { a: 0.73, b: 0.68, t: 0.045 }, lat: 0.024, bolt: 0.052, kg: { a: 840, b: 945, c: 1135 } },
};
export function mastType(id) {
  const m = /^LSU(\d{2})([abc])$/.exec(String(id || ""));
  if (!m || !MAST_SIZES.includes(+m[1])) return null;
  const size = +m[1], h = m[2], sp = LSU_SPECS[size];
  return {
    id: "LSU" + size + h, size, h, H: MAST_HEIGHTS[h],
    w: size <= 16 ? 0.30 : 0.40,                           // trasversale al binario
    d: size / 100,                                         // lungo il binario = altezza delle UPN (140…240)
    upn: { ...sp.upn }, module: LATTICE_MODULE, lat: sp.lat, plate: { ...sp.plate }, bolt: sp.bolt, kg: sp.kg[h],
    bolts: size === 24 ? { D: 0.55, E: 0.50 } : { D: 0.40, E: 0.40 },
  };
}
export const MASTS = MAST_SIZES.flatMap((s) => ["a", "b", "c"].map((h) => mastType("LSU" + s + h)));
/* la piastra del palo sta 90 mm sopra la testa del pilastrino (E 66013 c; 0.17.0, come le famiglie RFI): la testa del
   palo = testa del pilastrino + PLATE_GROUT + piastra + fusto. = ocs-core GROUT */
export const PLATE_GROUT = 0.09;
/* palo doppio (0.11.0: «PALO_DOPPIO_2xLSU», montanti «(2+2) x LSU22» dei portali MEC Satferr): due pali uguali
   affiancati lungo il binario, assi a DOUBLE_GAP; la trave MEC passa in mezzo (E 64906 c, 0.12.0) */
export const DOUBLE_GAP = 1.1;

/* ---- mensole e tiranti --------------------------------------------------- */
export const MENSOLE = [
  { L: 2.45, code: "768/452" }, { L: 3.8, code: "768/427" }, { L: 4.2, code: "768/453" }, { L: 6.0, code: "768/437" },
  { L: 7.0, code: "768/439" }, { L: 9.0, code: "768/811" }, { L: 12.5, code: "768/810" },
];
export const MENS_START = 0.115;                         // inizio della mensola oltre la faccia del palo
export const WIRE_MARGIN = 0.35;                          // la mensola passa il punto del filo di almeno tanto
/* la mensola più corta che porta tutte le sospensioni: dalla faccia del palo al punto di poligonazione più
   lontano. far = le sospensioni in più sulla stessa mensola, [{ off, stag }] (off = interasse dal binario vicino) */
export function mensolaFor(dr, stag, far = []) {
  let need = dr + HALF_GAUGE - MENS_START + Math.abs(stag || 0) + WIRE_MARGIN;
  for (const x of far || []) need = Math.max(need, dr + (+x.off || 0) + HALF_GAUGE - MENS_START + Math.abs(+x.stag || 0) + WIRE_MARGIN);
  return MENSOLE.find((m) => m.L >= need - 1e-9) || MENSOLE[MENSOLE.length - 1];
}
/* tirante: dislivello dell'attacco sul palo sopra la mensola (dai fogli Satferr: 3,8 m → 1,0; 4,2 → 1,35;
   5-6 m → 1,8; 7-7,8 → 2,3; la 9,0 di PD6 → 2,4) e attacco sulla mensola a 0,30 m dalla punta */
export function tiranteFor(L) {
  const dh = L <= 3.8 + 1e-9 ? 1.0 : L <= 4.2 + 1e-9 ? 1.35 : L <= 6.0 + 1e-9 ? 1.8 : L <= 7.8 + 1e-9 ? 2.3 : 2.4;
  return { dh, xt: Math.max(0.6 * L, L - 0.3) };
}

/* ---- sospensioni sulla mensola ---------------------------------------------------------------------
   Un palo fra due binari (foglio Satferr PD6, Deviata Treviglio: LSU20b, DR 3640 dal binario vicino e 7640
   dal binario pari, interasse 4,00) porta UNA mensola lunga (9,0) con una sospensione per binario servito e un
   tirante per sospensione (il corto verso il primo binario, il lungo fino alla punta). La prima sospensione è
   quella del binario del palo (poligonazione sup.stag, tipo sup.sosp); le altre stanno in sup.susp:
   [{ track (id del binario servito, o null), off (interasse a mano, m), stag, type }] */
export const INTERAXIS = 4.0;                            // interasse di partenza fra i binari (PD6)
export const MAX_SUSP = 4;                               // sospensioni sulla stessa mensola, la prima compresa
export const SOSP_TYPES = ["BN780", "SN620"];            // tipi visti nei fogli Satferr (PD6): proposte, il campo è libero
/* dalla mensola: x = distanza dall'inizio della mensola al punto del filo (poligonazione + verso il palo) */
const suspX = (dr, off, stag) => dr + off + HALF_GAUGE - MENS_START - stag;
/* un tirante per sospensione, tutti dallo stesso attacco sul palo: quello della sospensione più lontana va
   alla punta, gli altri al punto della loro sospensione */
export function tiesFor(L, dr, list) {
  const dh = tiranteFor(L).dh, far = list.reduce((m, x, i) => (x.off > list[m].off ? i : m), 0);
  return list.map((x, i) => ({ dh, xt: i === far ? tiranteFor(L).xt : Math.max(0.3, Math.min(L - 0.3, suspX(dr, x.off, x.stag))) }));
}
/* i progetti salvati fino alla 0.4.0 avevano la «seconda mensola» (sup.m2, mensola accanto alla prima, SBAGLIATA:
   PIANO §14.1) → diventa una seconda sospensione sulla stessa mensola, all'interasse di partenza */
export function migrateSupport(s) {
  if (!s) return s;
  if ("m2" in s) {
    if (s.m2 && !(Array.isArray(s.susp) && s.susp.length)) s.susp = [{ track: null, off: null, stag: filled(s.m2.stag) ? +s.m2.stag : null, type: null }];
    delete s.m2;
  }
  if (!Array.isArray(s.susp)) s.susp = [];
  return s;
}

/* ---- fondazioni (E 64865 rev. f) ------------------------------------------- */
/* A trasversale al binario, B lungo il binario, C altezza del blocco; pilastrino A1 × B1, alto C1 (0,25-0,50)
   sopra il blocco; A2 = dall'asse del pilastrino al bordo del blocco verso il binario (solo i B; i P sono
   centrati); vol = volumi del foglio (scavo; calcestruzzo min/max); tirafondi D × E (mm → m) */
const F = (id, A, B, C, A1, B1, A2, vs, vmin, vmax, D, E, D24, E24) => ({ id, A, B, C, A1, B1, A2, C1min: 0.25, C1max: 0.5, vs, vmin, vmax, bolts: { D, E }, bolts24: D24 ? { D: D24, E: E24 } : null });
export const FOUNDATIONS = [
  F("B0", 1.9, 1.6, 1.1, 0.8, 0.8, 0.8, 4.10, 3.50, 3.66, 0.4, 0.4),
  F("B0a", 2.2, 1.65, 1.1, 0.8, 0.8, 0.8, 4.90, 4.15, 4.31, 0.4, 0.4),
  F("B1", 2.3, 1.7, 1.1, 0.8, 0.8, 0.8, 5.27, 4.46, 4.62, 0.4, 0.4),
  F("B2", 2.4, 1.8, 1.1, 0.8, 0.8, 0.8, 5.83, 4.91, 5.07, 0.4, 0.4),
  F("B3", 2.5, 1.9, 1.1, 0.8, 0.8, 0.8, 6.41, 5.38, 5.54, 0.4, 0.4),
  F("B3a", 2.6, 2.0, 1.1, 0.8, 0.8, 0.8, 7.02, 5.88, 6.04, 0.4, 0.4),
  F("B4", 2.6, 2.3, 1.1, 0.8, 0.8, 0.8, 8.07, 6.74, 6.90, 0.4, 0.4),
  F("B5", 2.6, 2.8, 1.1, 0.8, 0.8, 0.8, 9.82, 8.17, 8.32, 0.4, 0.4),
  F("B6", 2.6, 3.5, 1.1, 0.8, 0.8, 0.8, 12.28, 10.17, 10.33, 0.4, 0.4),
  F("B7", 2.6, 4.0, 1.1, 0.8, 0.8, 0.8, 14.04, 11.60, 11.76, 0.4, 0.4),
  F("B6M", 2.6, 3.5, 1.1, 0.9, 0.9, 0.8, 12.28, 10.21, 10.41, 0.55, 0.5),
  F("B7M", 2.6, 4.0, 1.1, 0.9, 0.9, 0.8, 14.04, 11.64, 11.84, 0.55, 0.5),
  F("B8", 2.6, 4.4, 1.1, 0.9, 0.9, 0.8, 14.74, 12.17, 12.33, 0.55, 0.5),
  F("P0", 1.1, 1.1, 1.8, 0.8, 0.8, null, 2.48, 2.33, 2.49, 0.4, 0.4),
  F("P1", 1.3, 1.3, 1.8, 0.8, 0.8, null, 3.46, 3.20, 3.36, 0.4, 0.4),
  F("P2", 1.4, 1.4, 1.9, 0.8, 0.8, null, 4.21, 3.88, 4.04, 0.4, 0.4),
  F("P3", 1.6, 1.6, 2.0, 0.8, 0.8, null, 5.76, 5.28, 5.44, 0.4, 0.4),
  F("P4", 1.7, 1.7, 2.1, 0.8, 0.8, null, 6.79, 6.23, 6.39, 0.4, 0.4),
  F("P5", 1.8, 1.9, 2.1, 0.8, 0.8, null, 8.03, 7.34, 7.50, 0.4, 0.4),
  F("P6", 1.8, 2.1, 2.2, 0.8, 0.8, null, 9.26, 8.48, 8.64, 0.4, 0.4),
  F("P7", 1.9, 2.2, 2.2, 0.8, 0.8, null, 10.24, 9.36, 9.52, 0.4, 0.4, 0.55, 0.5),
  F("P7M", 1.9, 2.2, 2.2, 0.9, 0.9, null, 10.24, 9.40, 9.60, 0.4, 0.4, 0.55, 0.5),
  F("P8M", 2.2, 2.2, 2.2, 0.9, 0.9, null, 11.85, 11.05, 13.06, 0.4, 0.4, 0.55, 0.5),
];
/* due righe del foglio hanno i volumi di calcestruzzo che non tornano con le misure (A·B·C + A1·B1·C1):
   si tengono come scritte, il tool calcola i suoi dalle misure */
export const FOUNDATION_SHEET_MISMATCH = ["B8", "P8M"];
export const foundation = (id) => FOUNDATIONS.find((f) => f.id === id) || null;
/* i tirafondi del blocco vanno bene per il palo? (LSU24: 550 × 500; gli altri 400 × 400) */
export function foundationFits(f, m) {
  if (!f || !m) return false;
  const need = m.bolts;
  return (f.bolts.D === need.D && f.bolts.E === need.E) || (!!f.bolts24 && f.bolts24.D === need.D && f.bolts24.E === need.E);
}
export const foundationVolume = (f, c1) => f.A * f.B * f.C + f.A1 * f.B1 * c1;

/* ---- apparecchiature su palo (misure di partenza, da verificare: PIANO §7.5) ---- */
export const EQUIPMENT = {
  trafo: { w: 0.60, d: 0.50, h: 0.90, z: 4.0 },        // trasformatore su palo: cassa, quota del fondo sul PF
  sez: { w: 0.45, d: 0.35, h: 0.80, z: 5.0, rod: 1.6 }, // sezionatore su palo: cassa + asta di manovra fino a 1,6 m
};

/* ---- valori di partenza di un binario e risoluzione di un sostegno ---------------------------------- */
export const TRACK_DEFAULTS = {
  mast: "LSU18b", dr: 2.25, hm: 6.02, hw: 5.20, stag: 0.20, found: "B3", c1: 0.25, baseDz: -0.525,
  pilOut: 0.25, span: 60, prefix: "", numMode: "parity", oddLeft: true,
};
/* fondazione sul supercompattato (0.7.0, scelta dell'utente 2026-10-12): la testa del pilastrino (= la piastra
   del palo) esce di pilOut (di partenza 0,25 m, E 64865: «pilastrino 250 mm fuori terra», modificabile per palo,
   tratto e binario) dalla quota del supercompattato sotto l'asse del palo; senza superficie resta baseDz sotto il
   piano del ferro. DROP_MAX = dislivello massimo piano del ferro → filo pilastrino (E 64865) */
export const DROP_MAX = 0.75;
/* lev = quota del supercompattato sotto il piede, RELATIVA al piano del ferro dell'asse del binario del palo:
   { sc, d (distanza in pianta dal bordo, 0 = sopra la superficie) } o null; → { baseDz, fromSc, sc, scOut } */
function baseFrom(lev, pilOut, baseDz) {
  const on = !!(lev && Number.isFinite(lev.sc));
  return on ? { baseDz: lev.sc + pilOut, fromSc: true, sc: lev.sc, scOut: lev.d || 0 } : { baseDz, fromSc: false, sc: null, scOut: null };
}
/* un sostegno: { id, track, u, side (+1 sinistra / −1 destra guardando avanti), num, numUser,
   mast, dr, L, hm, hw, stag, sosp, susp, found, c1, eq: { trafo, sez } } — null = valore del binario.
   geo = per ogni sospensione in più col binario servito, { off, dz } misurati sulla geometria al palo
   (ocs-core crossOffset: interasse e dislivello del piano del ferro); senza, l'interasse scritto o INTERAXIS */
export function resolveSupport(sup, def = TRACK_DEFAULTS, geo = null, lev = null) {
  const d = { ...TRACK_DEFAULTS, ...(def || {}) };
  const pick = (k) => (sup[k] != null && sup[k] !== "" ? sup[k] : d[k]);
  const m = mastType(pick("mast")) || mastType(TRACK_DEFAULTS.mast);
  const dr = +pick("dr"), stag = +pick("stag");
  const susp = (sup.susp || []).slice(0, MAX_SUSP - 1).map((x, i) => {
    const g = geo && geo[i], onTrack = !!(g && Number.isFinite(g.off));
    const off = onTrack ? g.off : filled(x.off) ? +x.off : INTERAXIS;
    return { track: x.track != null ? x.track : null, onTrack, off, dz: onTrack && Number.isFinite(g.dz) ? g.dz : 0, stag: filled(x.stag) ? +x.stag : stag, type: x.type || "", dr: dr + off };
  });
  const auto = mensolaFor(dr, stag, susp);
  const L = sup.L != null && sup.L !== "" ? +sup.L : auto.L;
  const mens = MENSOLE.find((x) => Math.abs(x.L - L) < 1e-6) || { L, code: "—" };
  let f = foundation(pick("found"));
  if (!f) f = foundation(TRACK_DEFAULTS.found);
  const c1 = Math.max(f.C1min, Math.min(f.C1max, +pick("c1")));
  const pilOut = +pick("pilOut"), B = baseFrom(lev, pilOut, +pick("baseDz"));
  return {
    rfi: rfiMastOf(m, !!sup.dbl, mens),
    mast: m, dbl: !!sup.dbl, dr, stag, hm: +pick("hm"), hw: +pick("hw"), baseDz: B.baseDz, pilOut, fromSc: B.fromSc, sc: B.sc, scOut: B.scOut,
    drop: -B.baseDz, dropOver: -B.baseDz > DROP_MAX + 1e-9,
    mens, Lauto: sup.L == null || sup.L === "", Lshort: L < auto.L - 1e-9, tir: tiranteFor(L),
    sosp: sup.sosp || "", susp, ties: tiesFor(L, dr, [{ off: 0, stag }, ...susp]),
    found: f, c1, vol: foundationVolume(f, c1),
    fits: foundationFits(f, m),
    eq: { trafo: !!(sup.eq && sup.eq.trafo), sez: !!(sup.eq && sup.eq.sez), trafoSpec: EQUIPMENT.trafo, sezSpec: EQUIPMENT.sez },
  };
}

/* ---- portali (F3) ----------------------------------------------------------------------------------
   Dai blocchi Satferr (definizioni nel DWG della Deviata Treviglio, nessun foglio li usa):
   - pilone «SATFERR_PO pilone»: fusto 310 mm (pareti 15,5), piastra 710 con fazzoletti alti 150, alto 9636
     nel blocco e STIRABILE → nel tool arriva a 0,10 m sopra la trave; profondità lungo il binario NON nel
     blocco (solo prospetto): si tiene 310 (da verificare);
   - in alternativa un palo LSU (di partenza LSU22b) con «ATTACCO PALO TRAVE LSU22» (staffe da −1,48 a −0,10
     sotto la testa) → la trave sta con l'estradosso 0,10 m sotto la testa del palo;
   - travi a traliccio, lunghezza = interasse dei montanti (da verificare), altezza dal prospetto; larghezza in
     pianta w: MEC tipo C (luci fino a 27 m: C20, TN-xx) 0,77 da E 64906 c (0.12.0); le altre BEAM_WIDTH 0,60
     (da verificare: E 65053, E 65056, E 65109). Pendoli verticali dalla trave al filo, uno per
     binario servito («TIPO PENDULO»), poligonazione e tipo come le sospensioni dei pali.
   Montanti ai capi della trave: la trave automatica è la più corta che copre la distanza chiesta dalle DR
   minime (sinistra e destra) e si centra fra le due posizioni minime; le DR vere possono crescere. */
export const PO_POLE = { id: "PO", w: 0.31, d: 0.31, wall: 0.0155, plate: { a: 0.71, t: 0.04 }, Hblock: 9.636 };
/* pilone dei portali MEC («TIPO B 28÷35 - PILONE», 0.11.0): misure NON note → quelle del pilone PO, da sostituire */
export const MEC_POLE = { ...PO_POLE, id: "MEC" };
export const PORTAL_UPS = ["PO", "MEC", "LSU"];
export const BEAM_WIDTH = 0.6;
export const MEC_C_WIDTH = 0.77;                         // trave MEC tipo C fra i due pali LSU22 (E 64906 c: 770)
export const BEAM_TOP_GAP = 0.1;                         // estradosso della trave sotto la testa del montante
export const BEAMS = [
  { id: "PO T4", fam: "PO", L: 14.016, h: 0.862 }, { id: "PO T20", fam: "PO", L: 20.016, h: 0.862 }, { id: "PO T31", fam: "PO", L: 22.416, h: 0.887 },
  { id: "MEC C20", fam: "MEC", L: 16.07, h: 1.0, w: MEC_C_WIDTH },
  ...[15, 16, 17, 18, 19, 20, 23, 24, 25, 26].map((n) => ({ id: "MEC TN-" + n, fam: "MEC", L: n + 1.592, h: n <= 17 ? 1.056 : n <= 19 ? 1.074 : n === 20 ? 1.068 : 1.084, w: MEC_C_WIDTH })),
  { id: "MEC B-31", fam: "MEC", L: 32.12, h: 1.015 }, { id: "MEC B-32", fam: "MEC", L: 33.12, h: 1.018 },
  { id: "MEC A-39", fam: "MEC", L: 40.12, h: 1.179 }, { id: "MEC A-40", fam: "MEC", L: 41.12, h: 1.015 },
  // travi delle famiglie RFI dei portali coi piloni E 65018 (0.17.0, catalogo Revit: E 65018 a, E 65109), L = luce
  // asse-asse dei piloni: con queste anche i portali automatici prendono la famiglia (ocs-rfi.js)
  ...[["1BIN", 6.4], ["2BIN", 10.3], ["T-6", 14.4], ["T-9", 15.6], ["T-25", 20.4]].map(([n, L]) => ({ id: "PO " + n, fam: "PO", L, h: 0.8, w: 1.28 })),
].map((b) => ({ w: BEAM_WIDTH, ...b })).sort((a, b) => a.L - b.L);
export const beamType = (id) => BEAMS.find((b) => b.id === id) || null;
/* la trave più corta che copre la distanza fra i montanti (o la più lunga, se nessuna basta) */
export const beamFor = (span) => BEAMS.find((b) => b.L >= span - 1e-9) || BEAMS[BEAMS.length - 1];
/* portali a coordinate (0.11.0): la trave della famiglia dei montanti (pilone PO → travi PO; pilone MEC e pali LSU
   → travi MEC, come i blocchi Satferr PO_… e TRAVE_MEC), la più corta che copre; nessuna della famiglia → beamFor */
export const beamFam = (up) => (up === "PO" ? "PO" : "MEC");
export const beamForFam = (span, fam) => BEAMS.find((b) => b.fam === fam && b.L >= span - 1e-9) || beamFor(span);
export const PORTAL_DEFAULTS = { up: "PO", mast: "LSU22b", hb: 8.1 };
export const PORTAL_REACH = 40;                          // binari serviti: entro tanto dal binario di riferimento
/* un portale: { id, kind: "portal", track (binario di riferimento), u, side, num, numUser, up ("PO" | "MEC" |
   "LSU"), mast (palo LSU), dbl (pali doppi), beam (null = automatica), drL, drR (DR minime a sinistra/destra;
   null = del binario), hb (intradosso della trave sul PF, piloni), hw, found, c1, skip (id dei binari davanti
   esclusi a mano), pend: { idBinario: { stag, type } }, fix }.
   fix (0.11.0, portali importati a coordinate) = { qL, aL, qR, aR }: assi dei due montanti nel riferimento del
   binario a u (q scostamento, + a sinistra; a lungo il binario). Con fix i montanti stanno lì, la trave va
   dall'uno all'altro (anche obliqua: phi = rotazione in pianta rispetto alla normale) ed è lunga quanto la loro
   distanza (il tipo del catalogo dà famiglia e altezza); servono i binari fra i due montanti.
   geo = binari serviti [{ id, q, dz }]: scostamento dell'asse dal binario di riferimento (+ a sinistra) e
   dislivello del piano del ferro, misurati sulla geometria (ocs-core crossTracks).
   lev = { L, R }: quota del supercompattato sotto i due montanti (come in resolveSupport, relativa al piano del
   ferro del binario di riferimento) o null */
export function resolvePortal(p, def = TRACK_DEFAULTS, geo = [], lev = null) {
  const d = { ...TRACK_DEFAULTS, ...(def || {}) };
  const pick = (k) => (filled(p[k]) ? p[k] : d[k]);
  const fx = p.fix && Number.isFinite(+p.fix.qL) && Number.isFinite(+p.fix.qR) && +p.fix.qL > +p.fix.qR ? p.fix : null;
  let trk = (geo && geo.length ? geo : [{ id: p.track, q: 0, dz: 0 }]).slice().sort((a, b) => b.q - a.q);
  if (fx) trk = trk.filter((t) => t.id === p.track || (t.q < +fx.qL && t.q > +fx.qR));
  const up = PORTAL_UPS.includes(p.up) ? p.up : "PO";
  const M = up === "LSU" ? mastType(p.mast || PORTAL_DEFAULTS.mast) || mastType(PORTAL_DEFAULTS.mast) : null;
  const pole = M ? null : up === "MEC" ? MEC_POLE : PO_POLE;
  const w = M ? M.w : pole.w;
  const top = trk[0], bot = trk[trk.length - 1];
  let drL = filled(p.drL) ? +p.drL : +d.dr, drR = filled(p.drR) ? +p.drR : +d.dr, qL, qR, aL = 0, aR = 0, span, beam;
  if (fx) {                                               // montanti fermi: la trave li unisce
    qL = +fx.qL; qR = +fx.qR; aL = +fx.aL || 0; aR = +fx.aR || 0;
    span = Math.hypot(qL - qR, aL - aR);
    beam = { ...((filled(p.beam) && beamType(p.beam)) || beamForFam(span, beamFam(up))), L: span };
    drL = qL - w / 2 - HALF_GAUGE - top.q; drR = bot.q - HALF_GAUGE - (qR + w / 2);
  } else {
    const needL = top.q + HALF_GAUGE + drL + w / 2, needR = bot.q - HALF_GAUGE - drR - w / 2;
    span = needL - needR;
    beam = (filled(p.beam) && beamType(p.beam)) || beamFor(span);
    const mid = (needL + needR) / 2;
    qL = mid + beam.L / 2; qR = mid - beam.L / 2;
  }
  const hw = +pick("hw"), baseDz = +pick("baseDz");
  let pilOut = +pick("pilOut");
  const bL = baseFrom(lev && lev.L, pilOut, top.dz + baseDz), bR = baseFrom(lev && lev.R, pilOut, bot.dz + baseDz);
  // famiglia RFI (0.17.0, PIANO §23): rigida e piana come in Revit, sul supercompattato del pilone 1 (montante destro,
  // = revitFrame): testa delle due fondazioni, intradosso della trave e fondazione vengono dalla famiglia
  const rfi = M ? null : rfiPortalOf(up, Math.hypot(qL - qR, aL - aR)), RP = rfi && RFI_PORTALS[rfi.kind === "MEC" ? "MEC" : "PO"], sc1 = bR.baseDz - pilOut;
  const zBaseR = RP ? sc1 + RP.out : bR.baseDz, zBaseL = RP ? zBaseR : bL.baseDz, dropL = top.dz - zBaseL, dropR = bot.dz - zBaseR;
  if (RP) { pilOut = RP.out; beam = { ...beam, h: RP.h, w: RP.w }; }
  let hb, H;                                              // intradosso della trave e altezza dei montanti (dalla piastra)
  if (M) { const topZ = Math.min(zBaseL, zBaseR) + PLATE_GROUT + M.plate.t + M.H; hb = topZ - BEAM_TOP_GAP - beam.h; H = M.H; }
  else { hb = RP ? sc1 + RP.hb : filled(p.hb) ? +p.hb : PORTAL_DEFAULTS.hb; H = null; }
  const stag0 = +pick("stag"), pend = p.pend || {};
  const susp = trk.map((t) => { const x = pend[t.id] || {}; return { track: t.id, q: t.q, dz: t.dz, stag: filled(x.stag) ? +x.stag : stag0, type: x.type || "" }; });
  let f = RP ? RP.found : foundation(pick("found"));
  if (!f) f = foundation(TRACK_DEFAULTS.found);
  const c1 = Math.max(f.C1min, Math.min(f.C1max, +pick("c1")));
  return {
    kind: "portal", rfi, up, mast: M, dbl: !!(M && p.dbl), pole, w, beam, Bauto: !filled(p.beam), short: beam.L < span - 1e-9, span,
    fixed: !!fx, qL, qR, aL, aR, phi: Math.atan2(aR - aL, qL - qR),
    drL: qL - w / 2 - HALF_GAUGE - top.q, drR: bot.q - HALF_GAUGE - (qR + w / 2), drLmin: drL, drRmin: drR,
    zBaseL, zBaseR, hb, H, hw, baseDz, susp, found: f, c1, vol: 2 * foundationVolume(f, c1),
    pilOut, fromSc: bL.fromSc || bR.fromSc, scL: bL, scR: bR, dropL, dropR, dropOver: Math.max(dropL, dropR) > DROP_MAX + 1e-9,
    fits: M ? foundationFits(f, M) : true,
  };
}

/* ---- famiglie Revit del catalogo RFI dell'utente (0.15.0, add-in ViewIFC R1: PIANO_Revit_ViewIFC.md §13) -------
   Nomi, tipi e parametri delle famiglie generate nella sessione 18 (18.REVIT MCP\famiglie, stato del 2026-10-15,
   catalogo in lavorazione): la traduzione dei campi del tool vive qui, l'add-in piazza e basta.
   - pali: RFI_Sostegno_LSU14-16 (LSU14, LSU16) e RFI_Sostegno_LSU18-22 (LSU18…22), tipo = palo; d'istanza Plinto e
     Mensola (tipi delle annidate RFI_Plinto_LSU e RFI_Mensola_D76x5), Quota_mensola (asse della mensola dal
     supercompattato), Attacco_tirante (dall'inizio della mensola); tirante sul palo fisso a 1,00 sopra la mensola;
     dalle famiglie del 2026-10-18 (0.22.0) anche Distanza_binario (asse del palo → asse del binario, in pianta),
     Poligonazione (positiva verso il palo, come nel tool) e Sospensione (tipo dell'annidata
     RFI_Sospensione_PL_Acciaio_440);
   - portali MEC: una famiglia per trave tipo C (C19 / C20 / C21) con Luce d'istanza nel campo della trave;
   - portali coi piloni PO: tralicciati a 1 e 2 binari (6,40 / 10,30) e di ormeggio (14,40 / 15,60 / 20,40), luce di
     tipo → il tipo con la luce più vicina.
   Senza famiglia (saltati con il motivo): LSU24, pali doppi, portali su pali LSU. */
export const REVIT = {
  mastFamily: { 14: "RFI_Sostegno_LSU14-16", 16: "RFI_Sostegno_LSU14-16", 18: "RFI_Sostegno_LSU18-22", 20: "RFI_Sostegno_LSU18-22", 22: "RFI_Sostegno_LSU18-22" },
  plinto: "RFI_Plinto_LSU", mensola: "RFI_Mensola_D76x5",
  mensole: ["768-427_L3800", "768-437_L6000", "768-439_L7000", "768-811_L9000", "768-810_L12500"],
  tieDh: 1.0,
  mec: [{ family: "RFI_Portale_MEC_C19", type: "C19", min: 18, max: 19 }, { family: "RFI_Portale_MEC_C20", type: "C20", min: 19, max: 20 },
    { family: "RFI_Portale_MEC_C21", type: "C21", min: 20, max: 21 }],
  po: [{ family: "RFI_Portale_Tralicciato", type: "1BIN_L6400", L: 6.4 }, { family: "RFI_Portale_Tralicciato", type: "2BIN_L10300", L: 10.3 },
    { family: "RFI_Portale_Ormeggio", type: "T-6", L: 14.4 }, { family: "RFI_Portale_Ormeggio", type: "T-9", L: 15.6 },
    { family: "RFI_Portale_Ormeggio", type: "T-25", L: 20.4 }],
  spanTol: 0.05,
  // sospensione annidata nel palo (0.22.0, famiglie del 2026-10-18): tipo = braccio BN + tirantini, il primo è quello di partenza
  sospensione: "RFI_Sospensione_PL_Acciaio_440", sospArms: ["780", "540", "440"], sospTies: ["900", "1100"],
};
/* il campo «Tipo di sospensione» (testo libero, proposte SOSP_TYPES) → i tipi della famiglia RFI_Sospensione_PL_Acciaio_440
   in ordine (l'add-in prende il primo che c'è nel modello): braccio BN780/540/440 e tirantini 2x900/2x1100 dal testo
   quando ci sono, sennò tutti quelli possibili (prima il braccio e i tirantini di partenza). Testo vuoto o senza
   nessuno di SN620, BNnnn, 2xnnn che la famiglia conosca → [] (resta il tipo della famiglia) */
export function revitSospTypes(text) {
  const t = String(text || "").toUpperCase(), bn = /BN\s*(\d{3})/.exec(t), tz = /2\s*[X×]\s*(\d{3,4})/.exec(t);
  const arms = bn ? (REVIT.sospArms.includes(bn[1]) ? [bn[1]] : []) : REVIT.sospArms;
  const ties = tz ? (REVIT.sospTies.includes(tz[1]) ? [tz[1]] : []) : REVIT.sospTies;
  if (!bn && !tz && !/SN\s*620/.test(t)) return [];
  return arms.flatMap((a) => ties.map((x) => "SN620_BN" + a + "_2x" + x));
}
/* ---- famiglie RFI anche nel sito (0.17.0: vista 3D ed export IFC, ocs-rfi.js; PIANO §23) ------------------------
   Il sostegno ha la geometria delle famiglie del catalogo quando la famiglia c'è (R.rfi), sennò resta la geometria
   semplificata del tool. Scelta dell'utente (2026-10-15): forma dalle famiglie, quote dal tool.
   - pali: LSU14…22 non doppi (REVIT.mastFamily), con ogni mensola del tool (anche 2,45 e 4,20: tubo 76,1 × 5 della
     famiglia lungo quanto la mensola del tool) e i tiranti del tool;
   - portali: la famiglia e il tipo che piazza l'add-in (REVIT.mec, REVIT.po), solo se la distanza fra i montanti sta
     nel campo della trave MEC tipo C o entro REVIT.spanTol dalla luce del tipo PO; la famiglia è rigida e piana come
     in Revit: fondazioni (P2MEC, POT), piloni e trave alle quote della famiglia sul supercompattato del pilone 1. */
export const RFI_PORTALS = {
  // E 65042 a: blocco 4000 (lungo il binario) × 2100 × 2500, pilastrino 2360 × 1000 × 250, filo superiore +100; trave
  // MEC tipo C 750 × 1000 col filo inferiore a +8516 (ASSUNTO nella sessione 18: 200 sopra l'ultimo traverso del pilone)
  MEC: { found: { id: "P2MEC", A: 2.1, B: 4.0, C: 2.5, A1: 1.0, B1: 2.36, A2: null, C1min: 0.25, C1max: 0.25, vs: null, vmin: 21.59, vmax: 21.59, bolts: null, bolts24: null }, out: 0.1, hb: 8.516, h: 1.0, w: 0.75 },
  // E 65020 a: blocco 6000 × 2500 × 2200 senza pilastrino, filo superiore +350; trave 1280 × 800 col filo superiore
  // 150 sotto la testa del pilone E 65018 H9586 → filo inferiore a +8986
  PO: { found: { id: "POT", A: 2.5, B: 6.0, C: 2.2, A1: 0, B1: 0, A2: null, C1min: 0, C1max: 0, vs: null, vmin: 33, vmax: 33, bolts: null, bolts24: null }, out: 0.35, hb: 8.986, h: 0.8, w: 1.28 },
};
/* la famiglia di un portale coi piloni (up «MEC» o «PO») lungo span fra gli assi dei montanti, o null:
   { kind: "MEC" | "TRAL" | "ORM", family, type, luce (m: quella del portale per le MEC, quella del tipo per le PO) } */
export function rfiPortalOf(up, span) {
  if (!(span > 0)) return null;
  if (up === "MEC") {
    const m = REVIT.mec.find((t) => span >= t.min - 1e-6 && span <= t.max + 1e-6);
    return m ? { kind: "MEC", family: m.family, type: m.type, luce: span } : null;
  }
  if (up !== "PO") return null;
  const p = REVIT.po.reduce((a, t) => (Math.abs(span - t.L) < Math.abs(span - a.L) ? t : a));
  if (Math.abs(span - p.L) > REVIT.spanTol + 1e-9) return null;
  return { kind: p.family === "RFI_Portale_Tralicciato" ? "TRAL" : "ORM", family: p.family, type: p.type, luce: p.L };
}
/* la famiglia di un palo (tipo M, doppio?, mensola) o null: { family, type, mens (tipo della mensola nel catalogo, o «») } */
export function rfiMastOf(M, dbl, mens) {
  const family = M && !dbl ? REVIT.mastFamily[M.size] : null;
  if (!family) return null;
  const t = mens ? revitMensType(mens.code, mens.L) : "";
  return { family, type: M.id, mens: REVIT.mensole.includes(t) ? t : "" };
}
export const revitMensType = (code, L) => String(code).replace("/", "-") + "_L" + Math.round(L * 1000);
const revitMensLen = (t) => +((String(t).match(/_L(\d+)$/) || [])[1] || 0) / 1000;
/* un sostegno risolto (R) e la sua cornice (ocs-core revitFrame) → l'elemento da piazzare:
   { family, types: [candidati in ordine, l'add-in prende il primo che c'è], origin: [E, N, Z], xAxis: [dx, dy],
     params: { nome: { len: m } | { type: { family, types } } }, warn: [codici] }
   oppure { skip: codice } quando il catalogo non ha la famiglia (portalLsu, double, mastSize, geom).
   warn: mensType (mensola non nel catalogo: la più corta fra le più lunghe), sospType (tipo di sospensione vuoto o
   non riconosciuto: resta quello della famiglia), susp (sospensioni in più: la famiglia
   ha una mensola sola), equip (trasformatore / sezionatore senza famiglia), tieHeight (la famiglia tiene il tirante
   a 1,00 sopra la mensola), spanRange (luce fuori dal campo delle travi MEC), spanType (nessun tipo di portale con
   quella luce entro 5 cm) */
export function revitItem(R, F) {
  if (!R || !F) return { skip: "geom" };
  const origin = [F.origin.x, F.origin.y, F.origin.z], xAxis = F.xAxis, warn = [];
  if (R.kind === "portal") {
    if (R.up === "LSU") return { skip: "portalLsu" };
    const L = F.span;
    if (R.up === "MEC") {
      const gap = (t) => (L < t.min ? t.min - L : L > t.max ? L - t.max : 0);
      const m = REVIT.mec.reduce((a, t) => (gap(t) < gap(a) ? t : a));
      if (gap(m) > 1e-9) warn.push("spanRange");
      return { family: m.family, types: [m.type], origin, xAxis, params: { Luce: { len: L } }, warn };
    }
    const p = REVIT.po.reduce((a, t) => (Math.abs(L - t.L) < Math.abs(L - a.L) ? t : a));
    if (Math.abs(L - p.L) > REVIT.spanTol) warn.push("spanType");
    return { family: p.family, types: [p.type], origin, xAxis, params: {}, warn, typeSpan: p.L };
  }
  const M = R.mast;
  if (!M) return { skip: "geom" };
  if (R.dbl) return { skip: "double" };
  const family = REVIT.mastFamily[M.size];
  if (!family) return { skip: "mastSize" };
  const want = revitMensType(R.mens.code, R.mens.L);
  const longer = REVIT.mensole.filter((t) => t !== want && revitMensLen(t) >= R.mens.L - 1e-9).sort((a, b) => revitMensLen(a) - revitMensLen(b));
  if (!REVIT.mensole.includes(want)) warn.push("mensType");
  const sosp = revitSospTypes(R.sosp);
  if (!sosp.length) warn.push("sospType");
  if (R.susp && R.susp.length) warn.push("susp");
  if (R.eq && (R.eq.trafo || R.eq.sez)) warn.push("equip");
  const ties = R.ties && R.ties.length ? R.ties : [R.tir], tie = ties.reduce((a, t) => (t.xt > a.xt ? t : a));   // la famiglia ha un tirante: quello alla punta
  if (Math.abs(tie.dh - REVIT.tieDh) > 0.01) warn.push("tieHeight");
  return {
    family, types: [M.id], origin, xAxis, warn,
    params: {
      Plinto: { type: { family: REVIT.plinto, types: [R.found.id] } },
      Mensola: { type: { family: REVIT.mensola, types: [want, ...longer] } },
      Quota_mensola: { len: R.hm - R.baseDz + R.pilOut },
      Attacco_tirante: { len: tie.xt },
      // la stessa distanza di revitFrame (asse del palo dall'asse del binario): sospensione e filo sull'asse del binario
      Distanza_binario: { len: R.dr + HALF_GAUGE + M.w / 2 },
      Poligonazione: { len: R.stag },
      ...(sosp.length ? { Sospensione: { type: { family: REVIT.sospensione, types: sosp } } } : {}),
    },
  };
}

/* ---- campi per il modulo Pset (tools/common/pset-core.js) ------------------------------------------
   Tipi di oggetto: «mast» (palo con mensola), «portal», «foundation» (la fondazione di un palo o di un portale).
   PSET_FIELDS = i campi che un modello può usare, coi tipi di oggetto che li hanno e il tipo IFC proposto */
export const PSET_KINDS = ["mast", "portal", "foundation"];
const ALL = PSET_KINDS, MP = ["mast", "portal"];
export const PSET_FIELDS = [
  { key: "num", kinds: ALL, type: "label" }, { key: "track", kinds: ALL, type: "label" }, { key: "sta", kinds: ALL, type: "length" },
  { key: "side", kinds: ["mast", "foundation"], type: "label" }, { key: "dr", kinds: ["mast"], type: "length" },
  { key: "drL", kinds: ["portal"], type: "length" }, { key: "drR", kinds: ["portal"], type: "length" },
  { key: "mast", kinds: MP, type: "label" }, { key: "mens", kinds: ["mast"], type: "length" }, { key: "mensCode", kinds: ["mast"], type: "label" },
  { key: "beam", kinds: ["portal"], type: "label" }, { key: "beamL", kinds: ["portal"], type: "length" },
  { key: "hm", kinds: ["mast"], type: "length" }, { key: "hb", kinds: ["portal"], type: "length" }, { key: "hw", kinds: MP, type: "length" },
  { key: "stag", kinds: ["mast"], type: "length" }, { key: "sosp", kinds: MP, type: "label" }, { key: "served", kinds: MP, type: "label" },
  { key: "nSusp", kinds: MP, type: "int" }, { key: "kg", kinds: MP, type: "real" }, { key: "found", kinds: ALL, type: "label" }, { key: "c1", kinds: ALL, type: "length" },
  { key: "vol", kinds: ALL, type: "volume" }, { key: "E", kinds: ALL, type: "length" }, { key: "N", kinds: ALL, type: "length" },
  { key: "top", kinds: MP, type: "length" }, { key: "zPil", kinds: ALL, type: "length" }, { key: "zSc", kinds: ALL, type: "length" },
];
/* i valori dei campi di un sostegno risolto (palo: resolveSupport; portale: resolvePortal). ctx = { track (nome),
   s0 (progressiva iniziale del binario), E, N, top, served: [nomi dei binari serviti], zPil (quota della testa
   del pilastrino), zSc (del supercompattato, se c'è) } — calcolati dalla pagina.
   vol = calcestruzzo del sostegno (portale: le due fondazioni); per kind «foundation» di un portale, di una sola */
/* il sostegno a parole: «LSU22b», «2×LSU22b» (doppio), «PO» / «MEC» (piloni) */
export const mastLabel = (R) => (R.mast ? (R.dbl ? "2×" : "") + R.mast.id : R.pole ? R.pole.id : "PO");
/* peso dei pali LSU del sostegno (kg, E 66013 c): uno, due se doppio; portale: i due montanti; piloni: non noto */
export const mastKg = (R) => (R && R.mast ? R.mast.kg * (R.dbl ? 2 : 1) * (R.kind === "portal" ? 2 : 1) : null);
export function psetValues(s, R, ctx = {}, kind = "") {
  const portal = R && R.kind === "portal", v = {
    num: s.num, track: ctx.track, sta: (ctx.s0 || 0) + s.u, found: R.found.id, c1: R.c1, vol: portal && kind === "foundation" ? R.vol / 2 : R.vol,
    E: ctx.E, N: ctx.N, top: ctx.top, hw: R.hw, kg: mastKg(R), served: (ctx.served || []).join(", "), zPil: ctx.zPil, zSc: ctx.zSc,
  };
  if (portal) Object.assign(v, { mast: mastLabel(R), drL: R.drL, drR: R.drR, beam: R.beam.id, beamL: R.beam.L, hb: R.hb, nSusp: R.susp.length, sosp: [...new Set(R.susp.map((x) => x.type).filter(Boolean))].join(", ") });
  else Object.assign(v, { side: s.side > 0 ? "S" : "D", dr: R.dr, mast: mastLabel(R), mens: R.mens.L, mensCode: R.mens.code, hm: R.hm, stag: R.stag, nSusp: 1 + R.susp.length, sosp: [R.sosp, ...R.susp.map((x) => x.type)].filter(Boolean).join(", ") });
  return v;
}

/* ---- tratti (valori del binario da una progressiva a un'altra) ---------------------------------------
   ocs.rows = [{ id, u0, u1, mast, found, dr, hm, hw, span, c1, pilOut }]: dentro il tratto i campi scritti
   sostituiscono quelli del binario; i vuoti lasciano quelli del binario; fra tratti sovrapposti vince
   l'ultimo dell'elenco. Precedenza: palo → tratto → binario → catalogo (resolveSupport col risultato). */
export const ROW_KEYS = ["mast", "found", "dr", "hm", "hw", "span", "c1", "pilOut"];
const filled = (v) => v != null && v !== "";
export function defaultsAt(ocs, u) {
  const { rows, ...base } = ocs || {};
  const d = { ...TRACK_DEFAULTS, ...base };
  for (const r of rows || []) if (u >= r.u0 - 1e-9 && u <= r.u1 + 1e-9) for (const k of ROW_KEYS) if (filled(r[k])) d[k] = r[k];
  return d;
}
/* da dove viene un valore del palo: { from: "pole" | "row" | "track", row (indice del tratto, da 0) } */
export function valueSource(sup, ocs, k) {
  if (filled(sup[k])) return { from: "pole", row: -1 };
  const rows = (ocs && ocs.rows) || [];
  for (let i = rows.length - 1; i >= 0; i--) { const r = rows[i]; if (sup.u >= r.u0 - 1e-9 && sup.u <= r.u1 + 1e-9 && filled(r[k])) return { from: "row", row: i }; }
  return { from: "track", row: -1 };
}
/* i valori scritti a mano sui pali del tratto che il tratto stesso imposta: si tolgono (il palo torna alla regola) */
export function clearInRow(sups, row) {
  let n = 0;
  for (const s of sups) {
    if (!(s.u >= row.u0 - 1e-9 && s.u <= row.u1 + 1e-9)) continue;
    for (const k of ROW_KEYS) if (filled(row[k]) && filled(s[k])) { s[k] = null; n++; }
  }
  return n;
}

/* ---- numerazione ----------------------------------------------------------- */
/* sostegni di un binario in ordine di progressiva → numeri: «parity» = dispari da una parte e pari dall'altra
   (come i picchetti dei fogli Satferr), «seq» = 1, 2, 3 … in ordine; i numeri scritti a mano restano */
export function renumber(sups, opt = {}) {
  const o = { ...TRACK_DEFAULTS, ...opt };
  const list = [...sups].sort((a, b) => a.u - b.u || b.side - a.side);
  const out = new Map();
  let odd = 1, even = 2, n = 1;
  for (const s of list) {
    let k;
    if (o.numMode === "parity") { const isOdd = (s.side > 0) === !!o.oddLeft; if (isOdd) { k = odd; odd += 2; } else { k = even; even += 2; } }
    else k = n++;
    out.set(s.id, s.numUser ? s.num : (o.prefix || "") + k);
  }
  return out;
}
/* il numero per un sostegno nuovo: il primo libero della sua serie */
export function nextNumber(sups, side, opt = {}) {
  const o = { ...TRACK_DEFAULTS, ...opt }, used = new Set(sups.map((s) => String(s.num)));
  const parity = o.numMode === "parity", isOdd = (side > 0) === !!o.oddLeft;
  for (let k = parity ? (isOdd ? 1 : 2) : 1; ; k += parity ? 2 : 1) { const s = (o.prefix || "") + k; if (!used.has(s)) return s; }
}
