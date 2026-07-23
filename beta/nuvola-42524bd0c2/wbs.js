/* ============================================================================
   WBS — dal CODICE DI PROGETTO alla TIPOLOGIA e alla CATEGORIA DI VERIFICA
   (primario / secondario / escluso) con la relativa tolleranza. Modulo PURO,
   senza dipendenze (browser + Node) — studio "verifica nuvola ↔ modello"
   (branch feature/cloud-model-check).

   Perché esiste. Le soglie contrattuali (7 cm primari, 10 cm secondari) si
   applicano per TIPOLOGIA di elemento, e la tipologia NON è la classe IFC:
   un cordolo, una pavimentazione e un impalcato possono essere tutti e tre
   IfcBuildingElementProxy. Nei modelli la tipologia vive in una proprietà di
   pset: "Classe" dove è compilata, "CodiceWBS" dove non lo è — stessa logica
   di codifica, campo diverso. Questo modulo risolve il codice da QUALUNQUE
   dei due campi arrivi, con un catalogo (codebook) importabile/esportabile
   così che la verifica sia ripetibile e discutibile in contraddittorio.

   Due livelli, indipendenti:
     codice → TIPOLOGIA        (il "modello dati" del progetto, righe codice)
     tipologia → CATEGORIA     (scelta contrattuale, poche righe tipologia)
   Una riga può anche saltare il primo livello e dare la categoria diretta.

   Come letto in viewer/index.html (adapter): pset dell'istanza, poi pset del
   Type; il nome proprietà è confrontato normalizzato (vedi PROP_ALIASES), così
   "Codice WBS", "CodiceWBS" e "WBS" sono lo stesso campo.

   Precedenza fra regole, dalla più specifica: exact > prefix (la più lunga) >
   segment (la più lunga) > regex (ordine di dichiarazione). A parità vince la
   prima dichiarata: il catalogo si legge dall'alto come una delibera.

   API principale:
     normCode(raw)                    -> codice normalizzato ("IV-01 pil" -> "IV.01.PIL")
     segments(code)                   -> ["IV","01","PIL"]
     alphaKey(code)                   -> terna senza progressivi ("PV.IC.COR")
     normCat(raw)                     -> "primary"|"secondary"|"excluded"|null (IT/EN)
     matchCodeProp(name)              -> "classe"|"wbs"|"gruppo"|null (nome pset)
     makeCodebook(rows, opts)         -> catalogo indicizzato
     classifyCode(code, book)         -> null | {cat, tipo, tolMm, match, mode}
     classifyElement(el, book)        -> {cat, tipo, tolMm, source, code, ...}
     parseCodebookCsv(text)           -> {rows, errors}
     codebookToCsv(rows)              -> stringa CSV (round-trip di parseCodebookCsv)
     summarize(items, book)           -> ricognizione dei codici presenti nei modelli
     stubCsv(summary)                 -> catalogo precompilato da far riempire

   Unità: le tolleranze qui sono in MM (unità dei documenti contrattuali e del
   file CSV). La conversione a metri sta nell'adapter, come per clash.js.
============================================================================ */

/* Categorie assegnabili in catalogo. "unknown" NON è assegnabile: è l'assenza
   di una regola, e va mostrata come tale invece che silenziosamente assorbita
   in una delle due soglie (un numero prodotto su un elemento non classificato
   non è difendibile). */
const CATS = ["primary", "secondary", "excluded"];

/* Soglie contrattuali ANAS DGACQ 62-22, in mm. Sovrascrivibili per contratto
   via makeCodebook(rows, {tol:{...}}). excluded: nessuna soglia (non si misura). */
const DEFAULT_TOL_MM = { primary: 70, secondary: 100, excluded: null, unknown: null };

/* Nomi proprietà accettati per il codice, per campo. Confronto su nome
   normalizzato (minuscolo, senza spazi/underscore/punteggiatura), così "Codice
   WBS", "CodiceWBS" e "codice_wbs" sono lo stesso campo.
   ATTENZIONE a non allargare la lista: "Codice opera" è il numero identificativo
   dell'opera (es. 9001005984), NON una codifica di tipologia — se finisce fra
   gli alias del WBS oscura il codice buono (visto su modello reale). */
const PROP_ALIASES = {
  classe: ["classe", "class", "codiceclasse", "codiceoggettotecnico"],
  wbs: ["codicewbs", "wbs", "wbscode", "codicewbsoggetto"],
  gruppo: ["gruppoanagrafica", "gruppoanagrafico"]
};

/* Ordine di preferenza dei campi: la Classe, dove c'è, resta il riferimento; il
   Codice WBS subentra dove la Classe non è compilata; il Gruppo anagrafica è
   l'ultima rete (stessa terna, senza il lotto — vedi alphaKey). */
const DEFAULT_CODE_ORDER = ["classe", "wbs", "gruppo"];

/* Ripiego per classe IFC quando l'elemento non ha alcun codice: elenco dello
   handoff (primari: struttura portante · secondari: finiture e accessori),
   più le sottoclassi *StandardCase realmente diffuse negli export Revit e i
   pali di fondazione. È un RIPIEGO dichiarato, non una classificazione: chi
   legge il report deve poter distinguere "primario da catalogo" da "primario
   perché è un IfcColumn". */
const IFC_FALLBACK = {
  IFCBEAM: "primary", IFCBEAMSTANDARDCASE: "primary",
  IFCCOLUMN: "primary", IFCCOLUMNSTANDARDCASE: "primary",
  IFCSLAB: "primary", IFCSLABSTANDARDCASE: "primary", IFCSLABELEMENTEDCASE: "primary",
  IFCWALL: "primary", IFCWALLSTANDARDCASE: "primary", IFCWALLELEMENTEDCASE: "primary",
  IFCFOOTING: "primary", IFCPILE: "primary",
  IFCRAILING: "secondary", IFCCOVERING: "secondary",
  IFCBUILDINGELEMENTPROXY: "secondary"
};

/* ========================================================================== */
/* 1. NORMALIZZAZIONE                                                         */
/* ========================================================================== */

/* Codice normalizzato: maiuscolo, separatori equivalenti (spazio _ - / \ |)
   ridotti al punto, punti multipli collassati, punti di bordo rimossi.
   Regole e codici passano ENTRAMBI di qui: "IV-01" in catalogo intercetta
   "IV_01" nel modello senza che nessuno debba pensarci. */
function normCode(raw) {
  let s = String(raw === null || raw === undefined ? "" : raw).trim().toUpperCase();
  if (!s) return "";
  s = s.replace(/[\s_\-/\\|]+/g, ".").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  return s;
}

/* Segmenti del codice normalizzato ("IV.01.PIL" -> ["IV","01","PIL"]). */
function segments(code) {
  const c = normCode(code);
  return c ? c.split(".") : [];
}

/* Chiave "alfabetica": i soli segmenti NON numerici, nell'ordine. È l'invariante
   che lega fra loro le forme della stessa codifica — nel caso ANAS:
     Codice WBS         02.PV.01.IC.01.COR.01  ->  PV.IC.COR
     Gruppo anagrafica     PV.01.IC.002.COR.002 ->  PV.IC.COR
     Classe / cod. tecnico          PV-IC-COR   ->  PV.IC.COR
   I progressivi sono numerici e cadono; restano opera, parte d'opera, elemento.
   Serve a scrivere la terna UNA volta sola in catalogo e intercettarla da
   qualunque campo arrivi. Ritorna "" se non aggiunge nulla al codice stesso. */
function alphaKey(code) {
  const c = normCode(code);
  if (!c) return "";
  const k = c.split(".").filter(s => !/^\d+$/.test(s)).join(".");
  return k && k !== c ? k : "";
}

/* Nome proprietà normalizzato per il confronto con PROP_ALIASES. */
function _normProp(name) {
  return String(name === null || name === undefined ? "" : name)
    .toLowerCase().replace(/[^a-z0-9]/g, "");
}

/* Nome di proprietà pset -> campo codice ("classe" | "wbs") o null. */
function matchCodeProp(name) {
  const n = _normProp(name);
  if (!n) return null;
  for (const field of Object.keys(PROP_ALIASES)) {
    if (PROP_ALIASES[field].indexOf(n) !== -1) return field;
  }
  return null;
}

/* Categoria da testo libero, IT/EN, come la scrive chi compila il CSV. */
function normCat(raw) {
  const s = String(raw === null || raw === undefined ? "" : raw).trim().toLowerCase();
  if (!s) return null;
  if (/^(p|1|primar(io|ia|i|ie|y))$/.test(s)) return "primary";
  if (/^(s|2|secondar(io|ia|i|ie|y))$/.test(s)) return "secondary";
  if (/^(x|0|no|esclus[oaie]|excluded?|skip|ignor[eao])$/.test(s)) return "excluded";
  return null;
}

/* "0.3"|"0,3"|12 -> numero finito, altrimenti NaN (virgola decimale accettata
   se unica e senza punto — stessa logica di qto.toNumber/clash._num,
   duplicata per tenere i moduli indipendenti). */
function _num(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  let s = String(v === null || v === undefined ? "" : v).trim();
  if (!s) return NaN;
  if (s.indexOf(",") !== -1) {
    if (s.indexOf(".") !== -1 || s.indexOf(",") !== s.lastIndexOf(",")) return NaN;
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/* ========================================================================== */
/* 2. CATALOGO (codebook)                                                     */
/* ========================================================================== */

/* Modo di confronto dedotto dalla scrittura del campo "codice":
     PIL          -> exact    (codice intero)
     PIL*         -> prefix   (ramo dell'albero WBS, confine di segmento)
     *PIL*        -> segment  (il token compare fra i segmenti, ovunque)
     re:^IV\.0[12] -> regex   (via di fuga per le codifiche irregolari)
   Il confine di segmento nel prefisso evita che "PIL*" prenda "PILASTRINO":
   prende "PIL" e "PIL.01", non "PILASTRINO". */
function _ruleOf(matchRaw) {
  let s = String(matchRaw === null || matchRaw === undefined ? "" : matchRaw).trim();
  if (!s) return null;
  if (/^re:/i.test(s)) {
    const src = s.slice(3).trim();
    let re;
    try { re = new RegExp(src, "i"); } catch (e) { return { bad: `espressione regolare non valida: ${src}` }; }
    return { mode: "regex", re, match: s };
  }
  const seg = /^\*(.+)\*$/.exec(s);
  if (seg) return { mode: "segment", key: normCode(seg[1]), match: s };
  if (s.charAt(s.length - 1) === "*") return { mode: "prefix", key: normCode(s.slice(0, -1)), match: s };
  return { mode: "exact", key: normCode(s), match: s };
}

/* Costruisce il catalogo indicizzato dalle righe (di parseCodebookCsv o a mano).
     riga codice:    {match, tipo?, cat?, tolMm?, note?}
     riga tipologia: {match:"", tipo:"Pila", cat:"primario"}  (2° livello)
   opts: { tol:{primary,secondary}, codeOrder:["classe","wbs"], ifcFallback:bool }
   Ritorna { exact:Map, prefix:[], segment:[], regex:[], tipoCats:Map, tol,
             codeOrder, ifcFallback, rows, errors }. */
function makeCodebook(rows, opts) {
  const o = opts || {};
  const book = {
    exact: new Map(), prefix: [], segment: [], regex: [],
    tipoCats: new Map(),
    tol: Object.assign({}, DEFAULT_TOL_MM, o.tol || null),
    codeOrder: o.codeOrder || DEFAULT_CODE_ORDER.slice(),
    ifcFallback: o.ifcFallback !== false,
    rows: [], errors: []
  };
  for (const raw of rows || []) {
    if (!raw) continue;
    const tipo = String(raw.tipo || "").trim();
    const cat = raw.cat ? normCat(raw.cat) : null;
    if (raw.cat && !cat) { book.errors.push({ row: raw, msg: `categoria non riconosciuta: "${raw.cat}"` }); continue; }
    const tolMm = raw.tolMm === undefined || raw.tolMm === null || raw.tolMm === "" ? null : _num(raw.tolMm);
    if (tolMm !== null && !(Number.isFinite(tolMm) && tolMm >= 0)) {
      book.errors.push({ row: raw, msg: `tolleranza non valida: "${raw.tolMm}"` }); continue;
    }
    const matchRaw = String(raw.match || "").trim();

    /* riga di 2° livello: nessun codice, definisce la categoria di una tipologia */
    if (!matchRaw) {
      if (!tipo) { book.errors.push({ row: raw, msg: "riga senza codice e senza tipologia" }); continue; }
      if (!cat) { book.errors.push({ row: raw, msg: `tipologia "${tipo}" senza categoria` }); continue; }
      book.tipoCats.set(tipo.toLowerCase(), { cat, tolMm });
      book.rows.push({ match: "", tipo, cat, tolMm, note: raw.note || "" });
      continue;
    }

    const rule = _ruleOf(matchRaw);
    if (!rule || rule.bad) { book.errors.push({ row: raw, msg: rule ? rule.bad : "codice vuoto" }); continue; }
    if (rule.mode !== "regex" && !rule.key) { book.errors.push({ row: raw, msg: `codice vuoto dopo la normalizzazione: "${matchRaw}"` }); continue; }
    if (!cat && !tipo) { book.errors.push({ row: raw, msg: `"${matchRaw}": serve almeno tipologia o categoria` }); continue; }
    const entry = { match: matchRaw, mode: rule.mode, key: rule.key || "", re: rule.re || null,
                    tipo, cat, tolMm, note: raw.note || "", ord: book.rows.length };
    if (rule.mode === "exact") { if (!book.exact.has(entry.key)) book.exact.set(entry.key, entry); }
    else if (rule.mode === "prefix") book.prefix.push(entry);
    else if (rule.mode === "segment") book.segment.push(entry);
    else book.regex.push(entry);
    book.rows.push({ match: matchRaw, tipo, cat, tolMm, note: raw.note || "" });
  }
  /* più specifico prima: chiave più lunga, a parità ordine di dichiarazione */
  const bySpec = (a, b) => (b.key.length - a.key.length) || (a.ord - b.ord);
  book.prefix.sort(bySpec);
  book.segment.sort(bySpec);
  return book;
}

/* Il prefisso deve finire su un confine di segmento. */
function _prefixHit(code, key) {
  if (code === key) return true;
  return code.length > key.length && code.startsWith(key) && code.charAt(key.length) === ".";
}

/* Il token (anche multi-segmento) deve comparire come sequenza di segmenti. */
function _segmentHit(segs, key) {
  const k = key.split(".");
  for (let i = 0; i + k.length <= segs.length; i++) {
    let ok = true;
    for (let j = 0; j < k.length; j++) if (segs[i + j] !== k[j]) { ok = false; break; }
    if (ok) return true;
  }
  return false;
}

/* Categoria e tolleranza effettive di una riga: la categoria esplicita vince
   sulla mappa delle tipologie; la tolleranza di riga vince su quella di
   categoria (contratti con deroghe puntuali su una singola opera). */
function _resolveEntry(entry, book) {
  let cat = entry.cat, tolMm = entry.tolMm;
  if (!cat && entry.tipo) {
    const t = book.tipoCats.get(entry.tipo.toLowerCase());
    if (t) { cat = t.cat; if (tolMm === null || tolMm === undefined) tolMm = t.tolMm; }
  }
  if (!cat) return null;                                   // tipologia nota, categoria non decisa
  if (tolMm === null || tolMm === undefined) tolMm = book.tol[cat];
  return { cat, tipo: entry.tipo || "", tolMm: tolMm === undefined ? null : tolMm,
           match: entry.match, mode: entry.mode, key: "" };
}

/* Risolve UN codice sul catalogo, provandolo sia com'è sia ridotto alla chiave
   alfabetica (alphaKey): una regola scritta come terna "PV-IC-COR" intercetta
   così anche il Codice WBS completo "02.PV.01.IC.01.COR.01".
   La precedenza fra MODI resta globale (exact > prefix più lungo > segment >
   regex): è la regola più specifica a vincere, non la forma del codice.
   null = nessuna regola, o regola senza categoria decidibile.
   Il campo `key` dice su quale forma del codice la regola ha fatto presa. */
function classifyCode(code, book) {
  const c = normCode(code);
  if (!c || !book) return null;
  const keys = [c];
  const ak = alphaKey(c);
  if (ak) keys.push(ak);
  const hit = (entry, k) => { const r = _resolveEntry(entry, book); if (r) { r.key = k; return r; } return null; };

  for (const k of keys) { const e = book.exact.get(k); if (e) { const r = hit(e, k); if (r) return r; } }
  for (const p of book.prefix) for (const k of keys) if (_prefixHit(k, p.key)) { const r = hit(p, k); if (r) return r; }
  if (book.segment.length) {
    const segsOf = keys.map(k => k.split("."));
    for (const s of book.segment) for (let i = 0; i < keys.length; i++) {
      if (_segmentHit(segsOf[i], s.key)) { const r = hit(s, keys[i]); if (r) return r; }
    }
  }
  for (const rx of book.regex) for (const k of keys) if (rx.re.test(k)) { const r = hit(rx, k); if (r) return r; }
  return null;
}

/* ========================================================================== */
/* 3. CLASSIFICAZIONE DELL'ELEMENTO                                           */
/* ========================================================================== */

/* el: { classe, wbs, gruppo, ifcClass } — i codici come letti dai pset (stringhe
   grezze, una chiave per campo di PROP_ALIASES), ifcClass come nome IFC
   maiuscolo ("IFCBEAM").
   Ritorna sempre un oggetto, mai null:
     cat      "primary"|"secondary"|"excluded"|"unknown"
     tipo     tipologia dal catalogo ("" se sconosciuta)
     tolMm    soglia applicabile (null se excluded/unknown)
     source   "code"   categoria dal catalogo sul codice
              "ifc"    ripiego sulla classe IFC
              "none"   nessuna informazione: elemento NON verificabile
     code     codice usato (normalizzato), "" se assente
     field    "classe"|"wbs"|"" — da quale campo è arrivato il codice
     unmapped true se un codice c'era ma il catalogo non lo copre (da segnalare:
              è la differenza fra "verificato come secondario" e "non so cosa sia") */
function classifyElement(el, book) {
  const b = book || makeCodebook([]);
  const src = el || {};
  const out = { cat: "unknown", tipo: "", tolMm: null, source: "none", code: "", field: "",
                match: "", mode: "", key: "", unmapped: false };

  /* primo campo che RISOLVE, non primo campo compilato: se la Classe c'è ma è
     fuori catalogo, il CodiceWBS può ancora salvare l'elemento. */
  let firstCode = "", firstField = "";
  for (const field of b.codeOrder) {
    const c = normCode(src[field]);
    if (!c) continue;
    if (!firstCode) { firstCode = c; firstField = field; }
    const hit = classifyCode(c, b);
    if (hit) {
      out.code = c; out.field = field;
      out.cat = hit.cat; out.tipo = hit.tipo; out.tolMm = hit.tolMm;
      out.source = "code"; out.match = hit.match; out.mode = hit.mode; out.key = hit.key;
      return out;
    }
  }
  if (firstCode) { out.code = firstCode; out.field = firstField; out.unmapped = true; }

  if (b.ifcFallback) {
    const cat = IFC_FALLBACK[String(src.ifcClass || "").toUpperCase()];
    if (cat) {
      out.cat = cat; out.source = "ifc";
      out.tolMm = b.tol[cat] === undefined ? null : b.tol[cat];
    }
  }
  return out;
}

/* ========================================================================== */
/* 4. CSV DEL CATALOGO                                                        */
/* ========================================================================== */

/* Una riga CSV -> campi (doppi apici gestiti; sep singolo carattere). */
function _splitCsvLine(line, sep) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === sep) { out.push(cur); cur = ""; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

const _HEAD = {
  match: ["codice", "code", "classe", "wbs", "codicewbs"],
  cat: ["categoria", "category", "cat"],
  tipo: ["tipologia", "tipo", "type", "elemento"],
  tolMm: ["tolmm", "tollmm", "tolleranzamm", "tolleranza", "sogliamm", "soglia", "tol"],
  note: ["note", "notes", "nota", "commento"]
};

/* Parsing del catalogo. Colonne: codice; categoria; tipologia; tol_mm; note
   (intestazione riconosciuta IT/EN e in qualunque ordine; senza intestazione
   si assume l'ordine posizionale qui sopra). Righe con codice vuoto e
   tipologia+categoria piene = regole di 2° livello (tipologia → categoria).
   Righe che iniziano con # = commento. Separatore auto (";" preferito).
   Ritorna { rows, errors } — rows nel formato di makeCodebook. */
function parseCodebookCsv(text) {
  const errors = [];
  const lines = String(text || "").replace(/^﻿/, "").split(/\r\n|\n|\r/);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  if (!lines.length) return { rows: [], errors: [{ line: 0, msg: "file vuoto" }] };

  const first = lines.find(l => l.trim() && l.trim().charAt(0) !== "#") || "";
  const sep = first.indexOf(";") !== -1 ? ";" : ",";
  let cols = { match: 0, cat: 1, tipo: 2, tolMm: 3, note: 4 };
  let start = 0;

  const head = _splitCsvLine(first, sep).map(s => _normProp(s));
  const isHead = head.some(h => _HEAD.match.indexOf(h) !== -1) &&
                 head.some(h => _HEAD.cat.indexOf(h) !== -1 || _HEAD.tipo.indexOf(h) !== -1);
  if (isHead) {
    cols = { match: -1, cat: -1, tipo: -1, tolMm: -1, note: -1 };
    head.forEach((h, i) => {
      for (const k of Object.keys(_HEAD)) if (cols[k] === -1 && _HEAD[k].indexOf(h) !== -1) cols[k] = i;
    });
    start = lines.indexOf(first) + 1;
  }

  const rows = [];
  for (let li = start; li < lines.length; li++) {
    const line = lines[li];
    if (!line.trim() || line.trim().charAt(0) === "#") continue;
    const f = _splitCsvLine(line, sep).map(s => s.trim());
    const get = k => (cols[k] >= 0 && cols[k] < f.length ? f[cols[k]] : "");
    const row = { match: get("match"), cat: get("cat"), tipo: get("tipo"), tolMm: get("tolMm"), note: get("note"), line: li + 1 };
    if (!row.match && !row.tipo && !row.cat) continue;                    // riga vuota di fatto
    if (row.cat && !normCat(row.cat)) { errors.push({ line: li + 1, msg: `categoria non riconosciuta: "${row.cat}" — usare primario/secondario/escluso` }); continue; }
    if (row.tolMm && !Number.isFinite(_num(row.tolMm))) { errors.push({ line: li + 1, msg: `tolleranza non numerica: "${row.tolMm}"` }); continue; }
    if (!row.match && !(row.tipo && row.cat)) { errors.push({ line: li + 1, msg: "riga senza codice: per definire una tipologia servono tipologia E categoria" }); continue; }
    rows.push(row);
  }
  return { rows, errors };
}

function _q(v) {
  const s = String(v === null || v === undefined ? "" : v);
  return /[";\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

const CAT_IT = { primary: "primario", secondary: "secondario", excluded: "escluso" };

/* Catalogo -> CSV (round-trip con parseCodebookCsv). */
function codebookToCsv(rows, opts) {
  const sep = (opts && opts.sep) || ";";
  const out = ["codice" + sep + "categoria" + sep + "tipologia" + sep + "tol_mm" + sep + "note"];
  for (const r of rows || []) {
    const cat = r.cat ? (CAT_IT[normCat(r.cat)] || r.cat) : "";
    out.push([r.match || "", cat, r.tipo || "",
              r.tolMm === null || r.tolMm === undefined ? "" : r.tolMm, r.note || ""].map(_q).join(sep));
  }
  return out.join("\r\n") + "\r\n";
}

/* ========================================================================== */
/* 5. RICOGNIZIONE — quali codici ci sono davvero nei modelli                 */
/* ========================================================================== */

/* items: [{classe, wbs, ifcClass}] (uno per elemento). Aggrega per codice
   effettivo così da poter (a) dire subito se il modello è classificabile,
   (b) generare il catalogo da far compilare, (c) misurare la copertura prima
   di produrre qualsiasi numero.
   Ritorna { n, nCoded, noCode, byField, byCat, codes:[...] } con codes
   ordinati per frequenza decrescente. */
function summarize(items, book) {
  const b = book || makeCodebook([]);
  const map = new Map();
  const byCat = { primary: 0, secondary: 0, excluded: 0, unknown: 0 };
  const byField = { classe: 0, wbs: 0, gruppo: 0, none: 0 };
  let n = 0, nCoded = 0;
  for (const it of items || []) {
    n++;
    const r = classifyElement(it, b);
    byCat[r.cat] = (byCat[r.cat] || 0) + 1;
    if (r.code) { nCoded++; byField[r.field] = (byField[r.field] || 0) + 1; }
    else byField.none++;
    const key = r.code || " (nessun codice)";
    let e = map.get(key);
    if (!e) {
      e = { code: r.code, field: r.field, n: 0, ifcClasses: new Set(),
            cat: r.cat, tipo: r.tipo, tolMm: r.tolMm, source: r.source, unmapped: r.unmapped, match: r.match };
      map.set(key, e);
    }
    e.n++;
    const ic = String(it.ifcClass || "").toUpperCase();
    if (ic && e.ifcClasses.size < 12) e.ifcClasses.add(ic);
  }
  const codes = [...map.values()].map(e => ({
    code: e.code, field: e.field, n: e.n, ifcClasses: [...e.ifcClasses].sort(),
    cat: e.cat, tipo: e.tipo, tolMm: e.tolMm, source: e.source, unmapped: e.unmapped, match: e.match
  })).sort((a, b2) => b2.n - a.n || (a.code < b2.code ? -1 : a.code > b2.code ? 1 : 0));
  return { n, nCoded, noCode: n - nCoded, byField, byCat, codes };
}

/* Catalogo precompilato dai codici trovati: categoria e tipologia da riempire
   (quelle già risolte dal catalogo corrente sono riportate, così il file è
   insieme una fotografia e una bozza). I codici senza regola vengono per
   primi: sono esattamente le righe da decidere. */
function stubCsv(summary, opts) {
  const rows = [];
  const list = (summary && summary.codes ? summary.codes : []).filter(c => c.code);
  const unmapped = list.filter(c => c.source !== "code");
  const mapped = list.filter(c => c.source === "code");
  for (const c of unmapped.concat(mapped)) {
    rows.push({
      match: c.code,
      cat: c.source === "code" ? c.cat : "",
      tipo: c.tipo || "",
      tolMm: null,
      note: `${c.n} elementi` + (c.ifcClasses.length ? " · " + c.ifcClasses.join(" ") : "")
    });
  }
  const csv = codebookToCsv(rows, opts);
  const head = "# catalogo codici (Classe / CodiceWBS) — compilare categoria: primario | secondario | escluso\r\n" +
               "# codice: PIL = esatto · PIL* = ramo · *PIL* = segmento · re:… = espressione regolare\r\n" +
               "# riga con codice vuoto + tipologia + categoria = regola di tipologia\r\n";
  return head + csv;
}

export {
  CATS, DEFAULT_TOL_MM, PROP_ALIASES, DEFAULT_CODE_ORDER, IFC_FALLBACK, CAT_IT,
  normCode, segments, alphaKey, normCat, matchCodeProp,
  makeCodebook, classifyCode, classifyElement,
  parseCodebookCsv, codebookToCsv,
  summarize, stubCsv
};
