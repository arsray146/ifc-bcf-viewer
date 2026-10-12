/* =========================================================================
   Trazione elettrica (Railway OCS) — catalogo fisso dei sostegni (tool 18, F2)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Niente import, niente DOM: dati e regole, provati in Node (test/test_ocs_catalog.js).
   Unità: metri. Da dove vengono i numeri (PIANO_Trazione_Elettrica.md §2.3, §2.4, §12):
   - pali LSU: blocchi dinamici Satferr (Deviata Treviglio, NB4409VZZTTLC0300001A):
     fusto a/b/c = 8,20 / 9,60 / 12,00 m sopra la piastra (45 mm, 580 mm di lato),
     vista trasversale 300 mm (LSU14-16: correnti 60 + traliccio 180) e 400 mm
     (LSU18-24: 70 + 260); profondità 160 mm (E 64865 foglio 4). Il fusto è fatto
     di 2 UPN affacciate unite da un traliccio a X, modulo 266 mm (confermato
     dall'utente con una foto, PIANO §7.2): anima 7,5, ali 10,5 (UPN 160);
   - quote sul piano del ferro (fogli Satferr): piastra da −0,525 a −0,480 m,
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
export const MAST_DEPTH = 0.16;                           // lungo il binario = altezza delle UPN
export const PLATE = { a: 0.58, t: 0.045 };
export const LATTICE_MODULE = 0.266;                      // passo del traliccio a X fra le due UPN
export function mastType(id) {
  const m = /^LSU(\d{2})([abc])$/.exec(String(id || ""));
  if (!m || !MAST_SIZES.includes(+m[1])) return null;
  const size = +m[1], h = m[2];
  return {
    id: "LSU" + size + h, size, h, H: MAST_HEIGHTS[h],
    w: size <= 16 ? 0.30 : 0.40,                           // trasversale al binario
    d: MAST_DEPTH,
    // le due UPN: b = larghezza del corrente nella vista trasversale (ala), tw anima, tf ala
    upn: { b: size <= 16 ? 0.06 : 0.07, tw: 0.0075, tf: 0.0105 }, module: LATTICE_MODULE,
    bolts: size === 24 ? { D: 0.55, E: 0.50 } : { D: 0.40, E: 0.40 },
  };
}
export const MASTS = MAST_SIZES.flatMap((s) => ["a", "b", "c"].map((h) => mastType("LSU" + s + h)));

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
    mast: m, dr, stag, hm: +pick("hm"), hw: +pick("hw"), baseDz: B.baseDz, pilOut, fromSc: B.fromSc, sc: B.sc, scOut: B.scOut,
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
     pianta NON nel blocco → BEAM_WIDTH 0,60 (da verificare). Pendoli verticali dalla trave al filo, uno per
     binario servito («TIPO PENDULO»), poligonazione e tipo come le sospensioni dei pali.
   Montanti ai capi della trave: la trave automatica è la più corta che copre la distanza chiesta dalle DR
   minime (sinistra e destra) e si centra fra le due posizioni minime; le DR vere possono crescere. */
export const PO_POLE = { id: "PO", w: 0.31, d: 0.31, wall: 0.0155, plate: { a: 0.71, t: 0.04 }, Hblock: 9.636 };
export const BEAM_WIDTH = 0.6;
export const BEAM_TOP_GAP = 0.1;                         // estradosso della trave sotto la testa del montante
export const BEAMS = [
  { id: "PO T4", fam: "PO", L: 14.016, h: 0.862 }, { id: "PO T20", fam: "PO", L: 20.016, h: 0.862 }, { id: "PO T31", fam: "PO", L: 22.416, h: 0.887 },
  { id: "MEC C20", fam: "MEC", L: 16.07, h: 1.0 },
  ...[15, 16, 17, 18, 19, 20, 23, 24, 25, 26].map((n) => ({ id: "MEC TN-" + n, fam: "MEC", L: n + 1.592, h: n <= 17 ? 1.056 : n <= 19 ? 1.074 : n === 20 ? 1.068 : 1.084 })),
  { id: "MEC B-31", fam: "MEC", L: 32.12, h: 1.015 }, { id: "MEC B-32", fam: "MEC", L: 33.12, h: 1.018 },
  { id: "MEC A-39", fam: "MEC", L: 40.12, h: 1.179 }, { id: "MEC A-40", fam: "MEC", L: 41.12, h: 1.015 },
].sort((a, b) => a.L - b.L);
export const beamType = (id) => BEAMS.find((b) => b.id === id) || null;
/* la trave più corta che copre la distanza fra i montanti (o la più lunga, se nessuna basta) */
export const beamFor = (span) => BEAMS.find((b) => b.L >= span - 1e-9) || BEAMS[BEAMS.length - 1];
export const PORTAL_DEFAULTS = { up: "PO", mast: "LSU22b", hb: 8.1 };
export const PORTAL_REACH = 40;                          // binari serviti: entro tanto dal binario di riferimento
/* un portale: { id, kind: "portal", track (binario di riferimento), u, side, num, numUser, up ("PO" | "LSU"),
   mast (palo LSU), beam (null = automatica), drL, drR (DR minime a sinistra/destra; null = del binario), hb
   (intradosso della trave sul PF, solo PO), hw, found, c1, skip (id dei binari davanti esclusi a mano),
   pend: { idBinario: { stag, type } } }.
   geo = binari serviti [{ id, q, dz }]: scostamento dell'asse dal binario di riferimento (+ a sinistra) e
   dislivello del piano del ferro, misurati sulla geometria (ocs-core crossTracks).
   lev = { L, R }: quota del supercompattato sotto i due montanti (come in resolveSupport, relativa al piano del
   ferro del binario di riferimento) o null */
export function resolvePortal(p, def = TRACK_DEFAULTS, geo = [], lev = null) {
  const d = { ...TRACK_DEFAULTS, ...(def || {}) };
  const pick = (k) => (filled(p[k]) ? p[k] : d[k]);
  const trk = (geo && geo.length ? geo : [{ id: p.track, q: 0, dz: 0 }]).slice().sort((a, b) => b.q - a.q);
  const up = p.up === "LSU" ? "LSU" : "PO";
  const M = up === "LSU" ? mastType(p.mast || PORTAL_DEFAULTS.mast) || mastType(PORTAL_DEFAULTS.mast) : null;
  const w = M ? M.w : PO_POLE.w;
  const drL = filled(p.drL) ? +p.drL : +d.dr, drR = filled(p.drR) ? +p.drR : +d.dr;
  const top = trk[0], bot = trk[trk.length - 1];
  const needL = top.q + HALF_GAUGE + drL + w / 2, needR = bot.q - HALF_GAUGE - drR - w / 2, span = needL - needR;
  const auto = beamFor(span), beam = (filled(p.beam) && beamType(p.beam)) || auto;
  const mid = (needL + needR) / 2, qL = mid + beam.L / 2, qR = mid - beam.L / 2;
  const hw = +pick("hw"), baseDz = +pick("baseDz"), pilOut = +pick("pilOut");
  const bL = baseFrom(lev && lev.L, pilOut, top.dz + baseDz), bR = baseFrom(lev && lev.R, pilOut, bot.dz + baseDz);
  const zBaseL = bL.baseDz, zBaseR = bR.baseDz, dropL = top.dz - zBaseL, dropR = bot.dz - zBaseR;
  let hb, H;                                              // intradosso della trave e altezza dei montanti (dalla piastra)
  if (M) { const topZ = Math.min(zBaseL, zBaseR) + 0.045 + M.H; hb = topZ - BEAM_TOP_GAP - beam.h; H = M.H; }
  else { hb = filled(p.hb) ? +p.hb : PORTAL_DEFAULTS.hb; H = null; }
  const stag0 = +pick("stag"), pend = p.pend || {};
  const susp = trk.map((t) => { const x = pend[t.id] || {}; return { track: t.id, q: t.q, dz: t.dz, stag: filled(x.stag) ? +x.stag : stag0, type: x.type || "" }; });
  let f = foundation(pick("found"));
  if (!f) f = foundation(TRACK_DEFAULTS.found);
  const c1 = Math.max(f.C1min, Math.min(f.C1max, +pick("c1")));
  return {
    kind: "portal", up, mast: M, pole: M ? null : PO_POLE, w, beam, Bauto: !filled(p.beam), short: beam.L < span - 1e-9, span,
    qL, qR, drL: qL - w / 2 - HALF_GAUGE - top.q, drR: bot.q - HALF_GAUGE - (qR + w / 2), drLmin: drL, drRmin: drR,
    zBaseL, zBaseR, hb, H, hw, baseDz, susp, found: f, c1, vol: 2 * foundationVolume(f, c1),
    pilOut, fromSc: bL.fromSc || bR.fromSc, scL: bL, scR: bR, dropL, dropR, dropOver: Math.max(dropL, dropR) > DROP_MAX + 1e-9,
    fits: M ? foundationFits(f, M) : true,
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
  { key: "nSusp", kinds: MP, type: "int" }, { key: "found", kinds: ALL, type: "label" }, { key: "c1", kinds: ALL, type: "length" },
  { key: "vol", kinds: ALL, type: "volume" }, { key: "E", kinds: ALL, type: "length" }, { key: "N", kinds: ALL, type: "length" },
  { key: "top", kinds: MP, type: "length" }, { key: "zPil", kinds: ALL, type: "length" }, { key: "zSc", kinds: ALL, type: "length" },
];
/* i valori dei campi di un sostegno risolto (palo: resolveSupport; portale: resolvePortal). ctx = { track (nome),
   s0 (progressiva iniziale del binario), E, N, top, served: [nomi dei binari serviti], zPil (quota della testa
   del pilastrino), zSc (del supercompattato, se c'è) } — calcolati dalla pagina.
   vol = calcestruzzo del sostegno (portale: le due fondazioni); per kind «foundation» di un portale, di una sola */
export function psetValues(s, R, ctx = {}, kind = "") {
  const portal = R && R.kind === "portal", v = {
    num: s.num, track: ctx.track, sta: (ctx.s0 || 0) + s.u, found: R.found.id, c1: R.c1, vol: portal && kind === "foundation" ? R.vol / 2 : R.vol,
    E: ctx.E, N: ctx.N, top: ctx.top, hw: R.hw, served: (ctx.served || []).join(", "), zPil: ctx.zPil, zSc: ctx.zSc,
  };
  if (portal) Object.assign(v, { mast: R.mast ? R.mast.id : "PO", drL: R.drL, drR: R.drR, beam: R.beam.id, beamL: R.beam.L, hb: R.hb, nSusp: R.susp.length, sosp: [...new Set(R.susp.map((x) => x.type).filter(Boolean))].join(", ") });
  else Object.assign(v, { side: s.side > 0 ? "S" : "D", dr: R.dr, mast: R.mast.id, mens: R.mens.L, mensCode: R.mens.code, hm: R.hm, stag: R.stag, nSusp: 1 + R.susp.length, sosp: [R.sosp, ...R.susp.map((x) => x.type)].filter(Boolean).join(", ") });
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
