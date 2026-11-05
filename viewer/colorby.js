/* ============================================================================
   Colora per — logica pura, senza dipendenze (browser + Node).
   Feature "Colora" del viewer (v2.11.0).

   L'adapter in viewer/index.html legge da web-ifc il valore di ogni elemento
   (modello, classe IFC, contenitore o parametro di un pset) e lo passa qui come
   chiave testuale. Questo modulo decide l'ORDINE della legenda e i COLORI:
   palette per categorie, scala continua per i parametri numerici, colori scelti
   a mano dall'utente; in più i due passi meccanici della pittura (vertici di
   ogni elemento nei bucket, riempimento dei colori per vertice), così sono
   provati in Node senza three.js (test/test_colorby.js).

   Convenzioni:
   - chiave "" (NO_VALUE) = elemento senza valore: sempre in fondo, grigio;
   - colori in esadecimale sRGB "#rrggbb" (quelli che vede l'utente nella
     legenda); la conversione nello spazio lineare di three.js la fa l'adapter.
============================================================================ */

export const NO_VALUE = "";
export const NONE_COLOR = "#b9bcb5";

/* 16 tinte distinte (famiglia Tableau 20): prima le 8 piene, poi le 8 chiare,
   così valori vicini nella legenda non hanno colori vicini. Fuori i grigi (il
   grigio è «senza valore») e gli arancioni: la selezione del viewer è arancione
   (#ff6a2b) e deve restare riconoscibile sopra un modello colorato. */
export const PALETTE = [
  "#4e79a7", "#e15759", "#59a14f", "#b07aa1", "#b6992d", "#499894", "#d37295", "#9d7660",
  "#a0cbe8", "#ff9d9a", "#8cd17d", "#d4a6c8", "#f1ce63", "#86bcb6", "#fabfd2", "#d7b5a6"
];

/* scala continua: campioni di viridis da 0,15 a 1 (il viola più scuro, quasi
   nero sotto la luce radente, è tagliato). Niente rossi né arancioni, leggibile
   anche da chi non distingue rosso e verde. Minimo = viola, massimo = giallo. */
export const RAMP = ["#46327e", "#365c8d", "#277f8e", "#1fa187", "#4ac16d", "#a0da39", "#fde725"];

/* oltre questo numero di valori numerici distinti la scala continua parte da
   sola (sotto, una palette per categorie si legge meglio: fasi 1-2-3, piani…) */
export const AUTO_GRADIENT_MIN = 12;

/* "0.3" | "0,3" | "1e3" | 12 -> numero finito, altrimenti NaN
   (stesse regole di qto.js e search.js: virgola decimale solo se unica e senza punto) */
export function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (v === null || v === undefined || typeof v === "boolean") return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  if (s.indexOf(",") !== -1) {
    if (s.indexOf(".") !== -1 || s.indexOf(",") !== s.lastIndexOf(",")) return NaN;
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* valori grezzi di una proprietà (più di uno per enumerazioni, liste, limiti)
   -> chiave della legenda: distinti, vuoti tolti, nell'ordine d'arrivo, « | » */
export function valueKey(vals) {
  const out = [];
  for (const v of vals || []) {
    const s = v === null || v === undefined ? "" : String(v).trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.join(" | ");
}

/* "#rgb" | "#rrggbb" -> [r, g, b] 0..255 (null se non è un colore) */
export function hexToRgb(hex) {
  let s = String(hex || "").trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(s)) s = s.replace(/./g, (c) => c + c);
  if (!/^[0-9a-f]{6}$/i.test(s)) return null;
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}
export function rgbToHex(r, g, b) {
  const h = (x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0");
  return "#" + h(r) + h(g) + h(b);
}
function hslToHex(h, s, l) {
  const a = s * Math.min(l, 1 - l);
  const f = (n) => { const k = (n + h / 30) % 12; return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); };
  return rgbToHex(f(0) * 255, f(8) * 255, f(4) * 255);
}

/* i-esimo colore per categorie: la palette, poi tinte all'angolo aureo
   (sempre diverse dalle precedenti, alternando una più scura e una più chiara);
   il giro delle tinte salta gli arancioni (8–45°), come la palette: la
   sequenza si comprime sull'arco che resta, così due voci non coincidono */
export function paletteColor(i) {
  if (i < PALETTE.length) return PALETTE[i];
  const k = i - PALETTE.length;
  const t = ((205 + k * 137.508) % 360) / 360;
  const h = (45 + t * 323) % 360;   /* [45°, 368°) → oltre i 360 torna in [0°, 8°) */
  return hslToHex(h, 0.5, k % 2 ? 0.68 : 0.5);
}

/* colore della scala continua a t ∈ [0, 1] (fuori intervallo: agli estremi) */
export function rampColor(t) {
  if (!Number.isFinite(t)) t = 0.5;
  t = Math.max(0, Math.min(1, t));
  const x = t * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(x)), f = x - i;
  const a = hexToRgb(RAMP[i]), b = hexToRgb(RAMP[i + 1]);
  return rgbToHex(a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f);
}

const _coll = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });

/**
 * Legenda: ordine dei valori e colore di ciascuno.
 * counts  Map<key, n> (o iterabile di [key, n]); "" = senza valore
 * opts.order     "natural" (default: numeri per valore, testi in ordine naturale
 *                «Piano 2» prima di «Piano 10») | "given" (ordine d'arrivo:
 *                i modelli nell'ordine di caricamento)
 * opts.gradient  true | false | null = automatico (numerico con più di
 *                AUTO_GRADIENT_MIN valori distinti)
 * opts.custom    Map<key, "#rrggbb"> colori scelti dall'utente: vincono sempre
 * opts.numeric   false = chiavi solo categorie anche se sembrano numeri (gli
 *                identificativi dei modelli: «1», «2» non sono una misura)
 * -> { entries: [{key, n, color, num, none}], numeric, gradient, min, max }
 *    numeric = tutti i valori (tolto il «senza valore») sono numeri
 */
export function buildLegend(counts, opts = {}) {
  const custom = opts.custom instanceof Map ? opts.custom : new Map();
  const all = [...counts];
  const none = all.find(([k]) => k === NO_VALUE);
  const vals = all.filter(([k]) => k !== NO_VALUE).map(([k, n]) => ({ key: k, n, num: toNumber(k) }));
  const numeric = opts.numeric !== false && vals.length > 0 && vals.every((v) => Number.isFinite(v.num));
  if (opts.order !== "given") {
    if (numeric) vals.sort((a, b) => (a.num - b.num) || _coll(a.key, b.key));
    else vals.sort((a, b) => _coll(a.key, b.key));
  }
  const auto = opts.gradient === null || opts.gradient === undefined;
  const gradient = numeric && vals.length >= 2 && (auto ? vals.length > AUTO_GRADIENT_MIN : !!opts.gradient);
  let min = null, max = null;
  if (numeric) { min = Math.min(...vals.map((v) => v.num)); max = Math.max(...vals.map((v) => v.num)); }
  const entries = vals.map((v, i) => ({
    key: v.key, n: v.n, num: numeric ? v.num : null, none: false,
    color: custom.get(v.key) || (gradient ? rampColor(max > min ? (v.num - min) / (max - min) : 0.5) : paletteColor(i))
  }));
  if (none) entries.push({ key: NO_VALUE, n: none[1], num: null, none: true, color: custom.get(NO_VALUE) || NONE_COLOR });
  return { entries, numeric, gradient, min, max };
}

/**
 * Valori ereditati dalle scomposizioni: un elemento senza valore proprio prende
 * quello dell'assieme più vicino che lo contiene e ce l'ha (IfcElementAssembly
 * di Tekla con la marca sull'assieme, parti di una scala…).
 * own     Map<eid, key> solo gli elementi con un valore proprio
 * groups  [{key, geo: [eid…]}] gli assiemi (geo = geometria di tutte le parti;
 *         anche una parte sola: un assieme di un pezzo resta un assieme)
 * -> Map<eid, key> (own più gli ereditati); vince l'assieme più piccolo
 */
export function inheritValues(own, groups) {
  const out = new Map(own);
  const inner = (groups || []).filter((g) => g && g.key && g.geo && g.geo.length)
    .sort((a, b) => a.geo.length - b.geo.length);
  for (const g of inner) for (const e of g.geo) if (!out.has(e)) out.set(e, g.key);
  return out;
}

/**
 * Vertici di ogni elemento in un bucket del viewer: per ogni range di triangoli
 * {start, count} il primo e l'ultimo vertice che usa. Nei bucket ogni pezzo di
 * geometria ha i suoi vertici contigui e solo suoi (appendToBucket), quindi
 * [min, max] sono tutti e soli i vertici dell'elemento.
 * -> Int32Array [min0, max0, min1, max1, …] (range vuoto: 0, -1)
 */
export function rangeSpans(index, ranges) {
  const out = new Int32Array(ranges.length * 2);
  for (let r = 0; r < ranges.length; r++) {
    const s = ranges[r].start * 3, e = s + ranges[r].count * 3;
    let lo = Infinity, hi = -1;
    for (let i = s; i < e; i++) { const v = index[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[2 * r] = hi < 0 ? 0 : lo; out[2 * r + 1] = hi;
  }
  return out;
}

/**
 * Colori per vertice (RGB a 3 byte) di un bucket.
 * colors   Uint8Array (3 × vertici), scritto qui
 * colorOf  (expressID) -> [r, g, b] 0..255 | null/undefined (= fallback)
 * Ritorna il numero di vertici scritti.
 */
export function fillColors(colors, spans, ranges, colorOf, fallback) {
  let n = 0;
  for (let r = 0; r < ranges.length; r++) {
    const c = colorOf(ranges[r].expressID) || fallback;
    for (let v = spans[2 * r], hi = spans[2 * r + 1]; v <= hi; v++, n++) {
      colors[3 * v] = c[0]; colors[3 * v + 1] = c[1]; colors[3 * v + 2] = c[2];
    }
  }
  return n;
}
