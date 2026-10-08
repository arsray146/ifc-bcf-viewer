/* ============================================================================
   Ricerca / filtro elementi — logica pura, senza dipendenze (browser + Node).
   Feature "Cerca" del viewer (v2.10.0).

   Come per qto.js e ids.js, tutto ciò che dipende da web-ifc (nomi, classi,
   contenitori spaziali, lettura dei pset) sta in viewer/index.html: l'adapter
   costruisce un record per elemento e passa le funzioni d'accesso. Qui ci sono
   solo il confronto dei valori, la ricerca testuale, la combinazione delle
   regole e il CSV — così è testabile in Node (test/test_search.js).

   Query:
     { text: string,              // testo libero: ogni parola deve comparire
       inParams: boolean,         // il testo cerca anche nei valori dei pset
       combine: "and" | "or",     // come si combinano le regole
       rules: [Rule] }
   Rule:
     { field: "class" | "model" | "container" | "name" | "pset",
       pset: string,              // solo field "pset"; "" = in qualsiasi pset
       prop: string,              // solo field "pset"
       op: OP,
       value: string | string[] }   // array solo per "in"
   OP: "eq" "neq" "in" "contains" "ncontains" "starts" "gt" "gte" "lt" "lte"
       "exists" "missing"
   "in" = «è uno di»: value è la lista dei valori spuntati (stessa uguaglianza di "eq")

   Accessor (dall'adapter):
     { text(rec)   -> string[]   campi del testo libero (nome, GUID, classe…)
       params(rec) -> string[]   valori di tutti i parametri (solo se inParams)
       attr(rec, field) -> string   class / model / container / name
       prop(rec, pset, prop) -> raw[]   valori trovati ([] = proprietà assente) }

   Semantica delle proprietà assenti: tutti gli operatori di confronto (anche
   ≠ e «non contiene») valgono solo per gli elementi che HANNO la proprietà,
   come i filtri di Revit; per trovare chi non ce l'ha c'è «non esiste».
============================================================================ */

const OPS = ["eq", "neq", "in", "contains", "ncontains", "starts", "gt", "gte", "lt", "lte", "exists", "missing"];
const NO_VALUE_OPS = new Set(["exists", "missing"]);
const NUM_OPS = new Set(["gt", "gte", "lt", "lte"]);

/* minuscolo e senza accenti: «Più» trova «piu», «PORTA» trova «porta» */
function normText(s) {
  if (s === null || s === undefined) return "";
  return String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();
}

/* "0.3" | "0,3" | "1e3" | 12 -> numero finito, altrimenti NaN
   (stesse regole di qto.js: virgola decimale solo se unica e senza punto) */
function toNumber(v) {
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

/* IfcBoolean/IfcLogical arrivano come true/false, "T"/"F" o ".T."/".F.":
   l'utente scrive vero/falso, sì/no, true/false */
const BOOL_T = new Set(["true", "t", ".t.", "vero", "si", "yes", "y"]);
const BOOL_F = new Set(["false", "f", ".f.", "falso", "no", "n"]);
function toBool(v) {
  if (typeof v === "boolean") return v;
  const s = normText(v);
  if (BOOL_T.has(s)) return true;
  if (BOOL_F.has(s)) return false;
  return null;
}

function _eq(raw, val) {
  const a = toNumber(raw), b = toNumber(val);
  if (Number.isFinite(a) && Number.isFinite(b)) return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
  const x = toBool(raw), y = toBool(val);
  if (x !== null && y !== null) return x === y;
  return normText(raw) === normText(val);
}

/* un singolo valore contro l'operatore (op di esistenza esclusi) */
function compareValue(raw, op, val) {
  switch (op) {
    case "eq": return _eq(raw, val);
    case "neq": return !_eq(raw, val);
    case "in": return Array.isArray(val) && val.some(x => _eq(raw, x));
    case "contains": return normText(raw).includes(normText(val));
    case "ncontains": return !normText(raw).includes(normText(val));
    case "starts": return normText(raw).startsWith(normText(val));
    case "gt": case "gte": case "lt": case "lte": {
      const a = toNumber(raw), b = toNumber(val);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
      return op === "gt" ? a > b : op === "gte" ? a >= b : op === "lt" ? a < b : a <= b;
    }
    default: return false;
  }
}

/* una lista di valori (lo stesso parametro può stare in più pset, o nel type e
   nell'istanza) contro l'operatore. Positivi: basta un valore. Negativi (≠,
   non contiene): nessun valore deve violarli. Lista vuota = proprietà assente. */
function matchValues(values, op, val) {
  const vs = values || [];
  if (op === "exists") return vs.length > 0;
  if (op === "missing") return vs.length === 0;
  if (!vs.length) return false;
  if (op === "neq" || op === "ncontains") return vs.every(v => compareValue(v, op, val));
  return vs.some(v => compareValue(v, op, val));
}

/* la regola è abbastanza compilata da filtrare? (le incomplete si ignorano) */
function ruleComplete(r) {
  if (!r || !OPS.includes(r.op)) return false;
  if (r.field === "pset") { if (!r.prop) return false; }
  else if (!["class", "model", "container", "name"].includes(r.field)) return false;
  if (NO_VALUE_OPS.has(r.op)) return r.field === "pset";
  if (r.op === "in") return Array.isArray(r.value) && r.value.some(v => String(v).trim() !== "");
  const v = r.value === undefined || r.value === null ? "" : String(r.value).trim();
  if (!v) return false;
  if (NUM_OPS.has(r.op) && !Number.isFinite(toNumber(v))) return false;
  return true;
}

function testRule(rec, r, acc) {
  if (r.field === "pset") return matchValues(acc.prop(rec, r.pset || "", r.prop), r.op, r.value);
  return matchValues([acc.attr(rec, r.field)], r.op, r.value);
}

/* parole del testo libero; "frase tra virgolette" resta una parola sola */
function tokens(text) {
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(text || ""))) {
    const t = normText(m[1] !== undefined ? m[1] : m[2]);
    if (t) out.push(t);
  }
  return out;
}

/* predicato compilato una volta per ricerca. hasFilter=false: la query è vuota
   e il chiamante può non scorrere nulla */
function compileQuery(q) {
  const toks = tokens(q && q.text);
  const rules = ((q && q.rules) || []).filter(ruleComplete);
  const any = q && q.combine === "or";
  const inParams = !!(q && q.inParams);
  return {
    tokens: toks,
    rules,
    hasFilter: toks.length > 0 || rules.length > 0,
    test(rec, acc) {
      if (toks.length) {
        let hay = (acc.text(rec) || []).map(normText);
        let pend = toks.filter(t => !hay.some(h => h.includes(t)));
        if (pend.length && inParams) {
          hay = (acc.params(rec) || []).map(normText);
          pend = pend.filter(t => !hay.some(h => h.includes(t)));
        }
        if (pend.length) return false;
      }
      if (!rules.length) return true;
      return any ? rules.some(r => testRule(rec, r, acc)) : rules.every(r => testRule(rec, r, acc));
    }
  };
}

/* valori distinti con conteggio, per la lista di «è uno di»: [{v, n}] in ordine
   naturale ("A2" < "A10"); i valori vuoti restano fuori (non si spuntano) */
function distinctValues(values) {
  const m = new Map();
  for (const v of values) {
    const s = v === null || v === undefined ? "" : String(v);
    if (s.trim() === "") continue;
    m.set(s, (m.get(s) || 0) + 1);
  }
  return [...m].map(([v, n]) => ({ v, n }))
    .sort((a, b) => a.v.localeCompare(b.v, undefined, { numeric: true, sensitivity: "base" }));
}

/* CSV generico: separatore a scelta, quoting RFC 4180, CRLF, niente BOM
   (lo aggiunge il chiamante al Blob, come per il QTO) */
function toCsv(header, rows, sep) {
  const s = sep || ";";
  const cell = (v) => {
    const t = v === null || v === undefined ? "" : String(v);
    return /["\r\n]/.test(t) || t.includes(s) ? '"' + t.replace(/"/g, '""') + '"' : t;
  };
  return [header, ...rows].map(r => r.map(cell).join(s)).join("\r\n") + "\r\n";
}

export { OPS, NO_VALUE_OPS, NUM_OPS, normText, toNumber, toBool, compareValue, matchValues,
  ruleComplete, tokens, compileQuery, distinctValues, toCsv };
