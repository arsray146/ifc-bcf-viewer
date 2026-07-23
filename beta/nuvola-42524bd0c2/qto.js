/* ============================================================================
   QTO (Quantity Take-Off) — aggregazione, formattazione, CSV.
   Modulo PURO, senza dipendenze (browser + Node) — feature "QTO" (v2.5.0).

   Come per ids.js, tutta la logica dipendente da web-ifc (lettura di
   IfcElementQuantity, pset, unità di misura) sta in viewer/index.html:
   l'adapter costruisce una "riga" normalizzata per elemento e la passa
   ad aggregateQto. Questo modulo si occupa solo di raggruppare, sommare,
   formattare e serializzare in CSV — così è testabile in Node
   (test/test_qto.js) senza modelli IFC.

   Riga input (una per elemento, costruita dall'adapter):
     {
       modelUid: number, modelName: string,
       eid: number, globalId: string, name: string,
       ifcClass: string,          // es. "IfcWall"
       groupKey: string,          // valore del raggruppamento; "" se mancante
       qty: { [colId]: number }   // solo le colonne con valore numerico
     }
   colId: "count"|"length"|"area"|"volume"|"weight" (quantità standard,
   già convertite in m/m²/m³/kg dall'adapter) oppure "c:<Pset.Prop>"
   (colonna personalizzata: parametro numerico sommato tal quale).

   API:
     aggregateQto(rows, {columns}) -> { groups, totals, usedCols }
     toNumber(v)                   -> number | NaN (accetta virgola decimale)
     formatNum(v, {decimals, locale}) -> stringa it/en (deterministico, no Intl)
     toCsv(agg, opts)              -> stringa CSV (CRLF, quoting, NIENTE BOM:
                                      lo aggiunge il chiamante al Blob)
============================================================================ */

/* Colonne standard, nell'ordine di visualizzazione/CSV. "count" è la somma
   delle IfcQuantityCount; il numero di elementi del gruppo è group.n,
   calcolato qui, NON è una colonna. */
const STD_COLS = ["count", "length", "area", "volume", "weight"];

/* "0.3" | "0,3" | "1e3" | 12 -> numero finito, altrimenti NaN.
   La virgola è accettata come separatore decimale solo se è unica e non
   convive con il punto (valori tipo "1,234.5" restano ambigui -> NaN). */
function toNumber(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  if (v === null || v === undefined) return NaN;
  let s = String(v).trim();
  if (!s) return NaN;
  if (s.indexOf(",") !== -1) {
    if (s.indexOf(".") !== -1 || s.indexOf(",") !== s.lastIndexOf(",")) return NaN;
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* Raggruppa le righe per groupKey e somma le colonne richieste.
   opts.columns: [colId,...] — l'ordine definisce visualizzazione e CSV.
   Ritorna:
     groups:  [{ key, n, sums:{colId:num}, have:{colId:num}, rows:[...] }]
              ordinati per chiave (localeCompare numeric, "A2" < "A10");
              la chiave vuota "" va per ultima (il chiamante la etichetta).
     totals:  { n, sums:{colId:num} }
     usedCols: colonne con almeno un valore, nell'ordine di opts.columns. */
function aggregateQto(rows, opts) {
  const columns = (opts && opts.columns) || STD_COLS;
  const byKey = new Map();
  for (const r of rows || []) {
    const key = r.groupKey || "";
    let g = byKey.get(key);
    if (!g) { g = { key, n: 0, sums: {}, have: {}, rows: [] }; byKey.set(key, g); }
    g.n++; g.rows.push(r);
    for (const c of columns) {
      const v = r.qty ? r.qty[c] : undefined;
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      g.sums[c] = (g.sums[c] || 0) + v;
      g.have[c] = (g.have[c] || 0) + 1;
    }
  }
  const groups = [...byKey.values()].sort((a, b) => {
    if (a.key === "") return b.key === "" ? 0 : 1;   /* chiave vuota in coda */
    if (b.key === "") return -1;
    return a.key.localeCompare(b.key, undefined, { numeric: true, sensitivity: "base" });
  });
  const totals = { n: 0, sums: {} };
  for (const g of groups) {
    totals.n += g.n;
    for (const c of columns) if (c in g.sums) totals.sums[c] = (totals.sums[c] || 0) + g.sums[c];
  }
  const usedCols = columns.filter((c) => c in totals.sums);
  return { groups, totals, usedCols };
}

/* Formattazione numerica deterministica (niente Intl: identica in browser e
   Node). it: "1.234,56" — en: "1,234.56". Zeri decimali finali rimossi
   ("12" e non "12,00"); decimals = max cifre decimali. */
function formatNum(v, opts) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  const decimals = (opts && opts.decimals !== undefined) ? opts.decimals : 2;
  const locale = (opts && opts.locale) || "it";
  const neg = v < 0;
  let s = Math.abs(v).toFixed(decimals);
  let [int, dec] = s.split(".");
  if (dec) dec = dec.replace(/0+$/, "");
  const thou = locale === "it" ? "." : ",";
  const dsep = locale === "it" ? "," : ".";
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, thou);
  return (neg ? "-" : "") + int + (dec ? dsep + dec : "");
}

/* Un campo CSV: quoting solo se serve (sep, ", \r, \n), con raddoppio ". */
function csvField(s, sep) {
  s = String(s === null || s === undefined ? "" : s);
  if (s.indexOf(sep) !== -1 || s.indexOf('"') !== -1 || s.indexOf("\n") !== -1 || s.indexOf("\r") !== -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/* Numero per il CSV: niente separatore migliaia, max 3 decimali,
   separatore decimale secondo opts (Excel it vuole la virgola). */
function csvNum(v, decimal) {
  if (typeof v !== "number" || !Number.isFinite(v)) return "";
  let s = v.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  if (decimal === ",") s = s.replace(".", ",");
  return s;
}

/* Serializza il risultato di aggregateQto in CSV.
   opts: {
     sep: ";",                    // Excel italiano
     decimal: "," | ".",          // separatore decimale dei numeri
     groupHeader: string,         // intestazione della colonna chiave (tradotta)
     countHeader: string,         // intestazione "N. elementi"
     colHeaders: {colId: string}, // intestazioni tradotte (con unità)
     totalLabel: string,          // etichetta riga finale
     emptyKeyLabel: string        // etichetta del gruppo senza valore
   }
   Layout: header -> una riga per gruppo -> riga totale. CRLF, NIENTE BOM. */
function toCsv(agg, opts) {
  opts = opts || {};
  const sep = opts.sep || ";";
  const decimal = opts.decimal || ",";
  const cols = agg.usedCols || [];
  const head = [
    csvField(opts.groupHeader || "Gruppo", sep),
    csvField(opts.countHeader || "N", sep),
    ...cols.map((c) => csvField((opts.colHeaders && opts.colHeaders[c]) || c, sep))
  ];
  const lines = [head.join(sep)];
  for (const g of agg.groups) {
    const label = g.key === "" ? (opts.emptyKeyLabel || "(no value)") : g.key;
    lines.push([
      csvField(label, sep),
      String(g.n),
      ...cols.map((c) => csvNum(g.sums[c], decimal))
    ].join(sep));
  }
  lines.push([
    csvField(opts.totalLabel || "TOTAL", sep),
    String(agg.totals.n),
    ...cols.map((c) => csvNum(agg.totals.sums[c], decimal))
  ].join(sep));
  return lines.join("\r\n") + "\r\n";
}

export { STD_COLS, toNumber, aggregateQto, formatNum, toCsv };
