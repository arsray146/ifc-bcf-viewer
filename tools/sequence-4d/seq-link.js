/* =========================================================================
   Sequenza 4D — il collegamento attività ↔ elementi (tool 19, F3)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Puro, senza import né DOM (si prova in Node: test/test_seq_link.js).

   Il collegamento è una REGOLA, non un clic per elemento (design 19,
   PIANO_Sequenza_4D.md §1): così sopravvive alla revisione successiva del
   programma e dei modelli.
   - Regola sul codice: un campo del programma (la WBS di Project, un
     Testo…) confrontato con una proprietà degli elementi (un Pset del
     modello o un attributo), tutti e due normalizzati come viewer/wbs.js
     («VI03-pil 01» = «VI03.PIL.01»). Confronto «uguale o ramo»: un elemento
     VI03.PIL.P1 va all'attività VI03.PIL se nessuna attività ha proprio
     VI03.PIL.P1, cioè vince il codice d'attività più lungo che lo contiene a
     confine di segmento; oppure «solo uguale». Un campo del programma e una
     proprietà possono portare più codici separati da «;» (più set su
     un'attività, un elemento in due attività). La coppia colonna ↔
     proprietà la sceglie l'utente (2026-10-24: il tool è generico, negli IFC
     c'è sempre un parametro che coincide con una colonna di Project);
     pairCandidates conta quanti codici trova ognuna, per proporla.
   - Regole a mano, attività per attività: un gruppo dell'albero (il modello;
     un posto della struttura spaziale con quello che c'è sotto; una classe in
     un posto) oppure elementi per GlobalId, che vale in qualunque modello;
     più gli elementi tolti, per GlobalId.
   - Elementi di un'attività = (per codice ∪ a mano) − tolti.
   La copertura si legge prima del play: elementi collegati, contesi (due
   attività che costruiscono la stessa cosa), senza attività; attività senza
   elementi, attese (tipo «fuori dal modello») o da collegare; codici del
   programma che nei modelli non ci sono; regole che non trovano niente.
   Le scelte stanno sull'UID dell'attività con WBS e nome accanto: a una
   revisione del programma si riagganciano per UID, poi per WBS, poi per
   nome (reattach). Quello che non torna resta da vedere, non sparisce.
   Il file del collegamento (.4d.json) porta regole, tipi e modi di
   comparire: il modello non si tocca (decisione dell'utente 2026-10-23).
   ========================================================================= */

/* copia di normCode di viewer/wbs.js (i moduli del tool non importano
   niente): maiuscolo, separatori (spazio _ - / \ |) ridotti al punto, punti
   doppi e di bordo via. Il test la confronta con quella del viewer. */
export function normCode(raw) {
  let s = String(raw === null || raw === undefined ? "" : raw).trim().toUpperCase();
  if (!s) return "";
  s = s.replace(/[\s_\-/\\|]+/g, ".").replace(/\.{2,}/g, ".").replace(/^\.+|\.+$/g, "");
  return s;
}

/* i codici di un campo del programma, normalizzati e senza doppioni */
export function taskCodes(raw) {
  const out = [];
  for (const p of String(raw ?? "").split(";")) { const c = normCode(p); if (c && !out.includes(c)) out.push(c); }
  return out;
}

export const MODES = ["branch", "eq"];
/* la testa comune di un gruppo di codici normalizzati: i segmenti iniziali di
   sole lettere che hanno tutti i codici con almeno una cifra, con almeno un
   segmento dopo («SELEZIONE» di «Selezione 1.2.4»), "" se non c'è. Nel
   confronto non conta: il programma vero dell'utente (2026-10-24) scrive
   «Selezione 1.2.4» in Text2 e i modelli «1.2.4» in WBS_4D. Un codice può
   portarne più d'uno separati da «;» */
export function commonHead(codes) {
  let head = null;
  for (const v of codes) {
    for (const c of String(v).split(";")) {
      if (!/\d/.test(c)) continue;
      const seg = c.split(".");
      let n = 0;
      while (n < seg.length - 1 && /^\p{L}+$/u.test(seg[n])) n++;
      if (head === null) head = seg.slice(0, n);
      else { let k = 0; while (k < head.length && k < n && head[k] === seg[k]) k++; head.length = k; }
      if (!head.length) return "";
    }
  }
  return head ? head.join(".") : "";
}
/* sotto quale attività va un elemento: le attività foglia (riepiloghi e
   cardini non prendono elementi) per codice → [indici]. Con una testa comune
   anche idx.head e idx.core (codice senza la testa → codice) */
export function codeIndex(tasks, codeOf) {
  const idx = new Map();
  tasks.forEach((t, i) => {
    if (t.summary || t.milestone) return;
    for (const c of taskCodes(codeOf(t))) { let a = idx.get(c); if (!a) idx.set(c, (a = [])); a.push(i); }
  });
  const head = commonHead(idx.keys());
  if (head) {
    idx.head = head;
    idx.core = new Map();
    for (const c of idx.keys()) if (c.startsWith(head + ".")) idx.core.set(c.slice(head.length + 1), c);
  }
  return idx;
}
/* uguale o, col ramo, il più lungo che lo contiene a confine di segmento */
function seek(c, has, branch) {
  if (has(c)) return c;
  if (!branch) return null;
  for (let j = c.lastIndexOf("."); j > 0; j = c.lastIndexOf(".", j - 1)) { const k = c.slice(0, j); if (has(k)) return k; }
  return null;
}
/* il codice d'attività che prende un codice d'elemento (normalizzato): lo
   stesso, o col ramo il più lungo che lo contiene a confine di segmento.
   Le teste comuni non contano: si prova anche il codice dell'elemento senza
   la sua testa (eh) e i codici del programma senza la loro (idx.core);
   prima tutti gli uguali, poi i rami */
export function matchKey(c, idx, mode = "branch", eh = "") {
  if (!c) return null;
  const s = eh && c.startsWith(eh + ".") ? c.slice(eh.length + 1) : "", core = idx.core;
  const inIdx = (x) => idx.has(x), inCore = (x) => core.has(x);
  for (const branch of mode === "branch" ? [false, true] : [false]) {
    let k = seek(c, inIdx, branch) || (s && seek(s, inIdx, branch));
    if (k) return k;
    if (core && (k = seek(c, inCore, branch) || (s && seek(s, inCore, branch)))) return core.get(k);
  }
  return null;
}

/* tutti i codici d'attività che prende il codice di un elemento: anche più
   d'uno, separati da «;» (un elemento costruito da un'attività e demolito da
   un'altra: due set di TimeLiner sullo stesso elemento) */
export function matchKeys(c, idx, mode = "branch", eh = "") {
  if (!c) return null;
  if (!c.includes(";")) { const k = matchKey(c, idx, mode, eh); return k ? [k] : null; }
  const out = [];
  for (const p of c.split(";")) { const k = matchKey(p, idx, mode, eh); if (k && !out.includes(k)) out.push(k); }
  return out.length ? out : null;
}

/* ---- le proprietà degli elementi (seq-ifc.js, ifcPropTable) ------------- */
/* i valori del dizionario normalizzati: i codici di un valore uniti da «;»
   (dopo taskCodes nessun codice lo contiene) */
const normOf = (tab) => tab.norm || (tab.norm = tab.dict.map((v) => taskCodes(v).join(";")));
/* per ogni proprietà i valori diversi e su quanti elementi: le coppie si
   provano sui valori, non elemento per elemento */
function distinctOf(tab) {
  if (tab.dv) return tab.dv;
  return (tab.dv = tab.cols.map((col) => {
    const cnt = new Map();
    for (let j = 0; j < col.v.length; j++) cnt.set(col.v[j], (cnt.get(col.v[j]) || 0) + 1);
    return cnt;
  }));
}
/* la colonna di una proprietà: il codice normalizzato di ogni elemento ("" dove
   manca; più codici uniti da «;»). key = [pset, nome]; pset "*" = in qualunque Pset */
export function codeColumn(tab, n, key) {
  const out = new Array(n).fill("");
  if (!tab || !key) return out;
  const norm = normOf(tab);
  tab.keys.forEach(([p, q], c) => {
    if (q !== key[1] || (key[0] !== "*" && p !== key[0])) return;
    const col = tab.cols[c];
    for (let j = 0; j < col.e.length; j++) { const k = col.e[j]; if (!out[k]) out[k] = norm[col.v[j]]; }
  });
  return out;
}
/* nomi che dicono «qui c'è il codice»: a parità di codici trovati vincono */
const CODE_NAME = /cod|wbs|attivit|activit|task|\b4d\b|fase|phase|selez|select|\bset\b/i;
/* quali proprietà degli elementi portano i codici di una colonna del
   programma: per ogni proprietà dei modelli quanti codici d'attività diversi
   trova (hits), quanti elementi prende (els), su quanti elementi c'è (n) e un
   valore d'esempio (ex: uno che trova un codice, se c'è) e la sua testa
   comune (head, commonHead: nel confronto non conta). In testa la migliore:
   più codici, poi un nome che lo dice, poi più elementi. tabs: le tabelle dei
   modelli (null se non ancora lette) */
export function propCandidates(tabs, idx, mode = "branch") {
  const acc = new Map(), vals = new Map();
  const kkOf = (key) => key[0] + "\u0001" + key[1];
  /* la testa di ogni proprietà, sui valori di tutti i modelli */
  for (const tab of tabs) {
    if (!tab) continue;
    const norm = normOf(tab), dv = distinctOf(tab);
    tab.keys.forEach((key, c) => { const kk = kkOf(key); let a = vals.get(kk); if (!a) vals.set(kk, (a = [])); for (const d of dv[c].keys()) a.push(norm[d]); });
  }
  const heads = new Map([...vals].map(([kk, a]) => [kk, commonHead(a)]));
  for (const tab of tabs) {
    if (!tab) continue;
    const norm = normOf(tab), dv = distinctOf(tab), memo = new Map();
    tab.keys.forEach((key, c) => {
      const kk = kkOf(key), eh = heads.get(kk) || "";
      let e = acc.get(kk);
      if (!e) acc.set(kk, (e = { key, codes: new Set(), els: 0, n: 0, ex: "", exHit: false, head: eh }));
      let mm = memo.get(eh);
      if (!mm) memo.set(eh, (mm = new Map()));
      for (const [d, cnt] of dv[c]) {
        let hit = mm.get(d);
        if (hit === undefined) { hit = idx.size ? matchKeys(norm[d], idx, mode, eh) : null; mm.set(d, hit); }
        e.n += cnt;
        if (hit) { for (const k of hit) e.codes.add(k); e.els += cnt; if (!e.exHit) { e.ex = tab.dict[d]; e.exHit = true; } }
        else if (!e.ex) e.ex = tab.dict[d];
      }
    });
  }
  const named = (k) => (CODE_NAME.test(k[1]) || CODE_NAME.test(k[0]) ? 1 : 0);
  return [...acc.values()].map((e) => ({ key: e.key, hits: e.codes.size, els: e.els, n: e.n, ex: String(e.ex), head: e.head }))
    .sort((a, b) => b.hits - a.hits || named(b.key) - named(a.key) || b.els - a.els || (a.key[0] + a.key[1]).localeCompare(b.key[0] + b.key[1]));
}
/**
 * Le coppie colonna del programma ↔ proprietà degli elementi, da mostrare
 * all'utente che sceglie (decisione del 2026-10-24: il tool è generico, la
 * coppia la dice l'utente; qui si conta quanti codici trova ognuna).
 * cols: [{ id, codeOf(t) }] — le colonne del programma da provare.
 * → { cols: [{ id, n (codici della colonna), head (la sua testa comune), props: propCandidates }],
 *     best: { col, key, hits, els } | null — la coppia che trova più codici
 *     (a parità: la parte maggiore dei codici della colonna, poi più elementi) }
 */
export function pairCandidates(tasks, cols, tabs, mode = "branch") {
  const out = cols.map(({ id, codeOf }) => {
    const idx = codeIndex(tasks, codeOf);
    return { id, n: idx.size, head: idx.head || "", props: idx.size ? propCandidates(tabs, idx, mode) : [] };
  });
  let best = null;
  for (const c of out) {
    const p = c.props[0];
    if (!p || !p.hits) continue;
    const better = !best || p.hits > best.hits || (p.hits === best.hits && (p.hits / c.n > best.hits / best.n || (p.hits / c.n === best.hits / best.n && p.els > best.els)));
    if (better) best = { col: c.id, key: p.key, hits: p.hits, els: p.els, n: c.n };
  }
  return { cols: out, best };
}

/* ---- regole a mano ------------------------------------------------------ */
/* il posto di un elemento: i nomi della struttura spaziale dall'alto (senza il
   progetto), separati come nell'albero e nel pannello */
export const SEP = " › ";
/* regola valida e ripulita, o null:
   { g: [GlobalId…] }                 elementi scelti, in qualunque modello
   { m, s?, c? }                      gruppo del modello m: con s e c la classe
                                      c nel posto s esatto (riga di classe
                                      dell'albero, s "" = senza posto); con
                                      solo s quello che sta in s e sotto (riga
                                      del posto); con solo c la classe in
                                      tutto il modello; solo m: il modello */
export function cleanRule(r) {
  if (!r || typeof r !== "object") return null;
  if (Array.isArray(r.g)) { const g = [...new Set(r.g.filter((x) => typeof x === "string" && x))]; return g.length ? { g } : null; }
  if (typeof r.m !== "string" || !r.m) return null;
  const out = { m: r.m };
  if (typeof r.s === "string") out.s = r.s;
  if (typeof r.c === "string" && r.c) out.c = r.c;
  return out;
}
export const sameRule = (a, b) => !a.g && !b.g && a.m === b.m && (a.s ?? null) === (b.s ?? null) && (a.c ?? null) === (b.c ?? null);
/* gli elementi di un modello presi da una regola di gruppo.
   M: { name, n, els: [{ cls }], where: [posto] } */
export function groupHits(r, M) {
  const out = [];
  if (r.g || r.m !== M.name) return out;
  const s = r.s, c = r.c, under = s != null && c == null && s !== "";
  for (let k = 0; k < M.n; k++) {
    if (c != null && M.els[k].cls !== c) continue;
    if (s != null) {
      const w = M.where[k] || "";
      if (under ? !(w === s || w.startsWith(s + SEP)) : w !== s) continue;
    }
    out.push(k);
  }
  return out;
}

/* ---- risoluzione -------------------------------------------------------- */
/* un elemento come numero: modello × 2²² + indice (fino a 4 milioni di
   elementi per modello e 511 modelli, esatto in un double) */
export const REF = 4194304;
export const refOf = (mi, k) => mi * REF + k;
export const refMi = (r) => Math.floor(r / REF);
export const refK = (r) => r - Math.floor(r / REF) * REF;

/**
 * Gli elementi di ogni attività e le attività di ogni elemento.
 * tasks: il programma (seq-io); codeOf(t): il campo col codice;
 * models: [{ key, name, n, els: [{ gid, cls }], where: [posto], codes: [codice] | null }]
 *   (codes: la colonna della proprietà scelta, codeColumn; null = niente regola sul codice);
 * meta: UID → { add: [regole], sub: [GlobalId] }; mode: "branch" | "eq".
 * → { ofTask: [Set di ref], ofEl: Map(key → Array(n) di [indici d'attività]),
 *     byCode: Map(key → Uint8Array(n): 1 = collegato per codice, 0 = solo a mano),
 *     how: [{ code, hand, sub }], codes: { n, found, missing: [codici] },
 *     heads: { prog, els } (le teste comuni che nel confronto non contano),
 *     rules: [{ uid, i, r, hits, open }] }
 */
export function resolve({ tasks, codeOf, models, meta = {}, mode = "branch", idx = null }) {
  idx = idx || codeIndex(tasks, codeOf);
  const at = new Map(tasks.map((t, i) => [String(t.uid), i]));
  const gidAt = new Map(), ofEl = new Map(), byCode = new Map();
  models.forEach((M, mi) => {
    ofEl.set(M.key, new Array(M.n));
    byCode.set(M.key, new Uint8Array(M.n));
    M.els.forEach((e, k) => { if (e.gid && !gidAt.has(e.gid)) gidAt.set(e.gid, refOf(mi, k)); });
  });
  const own = tasks.map(() => new Set()), how = tasks.map(() => ({ code: 0, hand: 0, sub: 0 }));
  /* per codice; la testa comune dei codici degli elementi, su tutti i modelli */
  const found = new Set(), distinct = new Set();
  for (const M of models) if (M.codes) for (const c of M.codes) if (c) distinct.add(c);
  const eh = commonHead(distinct);
  models.forEach((M, mi) => {
    if (!M.codes) return;
    const memo = new Map();
    for (let k = 0; k < M.n; k++) {
      const c = M.codes[k];
      if (!c) continue;
      let keys = memo.get(c);
      if (keys === undefined) { keys = matchKeys(c, idx, mode, eh); memo.set(c, keys); }
      if (!keys) continue;
      for (const key of keys) { found.add(key); for (const i of idx.get(key)) own[i].add(refOf(mi, k)); }
    }
  });
  own.forEach((s, i) => { how[i].code = s.size; });
  const fromCode = own.map((s) => new Set(s));     // quello che il codice ha dato a ogni attività, prima delle regole a mano
  /* a mano */
  const rules = [];
  for (const [uid, m] of Object.entries(meta || {})) {
    const i = at.get(uid);
    if (i == null || !m) continue;
    const s = own[i], n0 = s.size;
    for (const r of m.add || []) {
      let hits = 0, open = true;
      if (r.g) { for (const g of r.g) { const ref = gidAt.get(g); if (ref != null) { s.add(ref); hits++; } } }
      else {
        open = models.some((M) => M.name === r.m);
        models.forEach((M, mi) => { for (const k of groupHits(r, M)) { s.add(refOf(mi, k)); hits++; } });
      }
      rules.push({ uid, i, r, hits, open });
    }
    how[i].hand = s.size - n0;
    for (const g of m.sub || []) { const ref = gidAt.get(g); if (ref != null && s.delete(ref)) how[i].sub++; }
  }
  own.forEach((s, i) => {
    for (const ref of s) {
      const key = models[refMi(ref)].key, a = ofEl.get(key), k = refK(ref);
      (a[k] || (a[k] = [])).push(i);
      if (fromCode[i].has(ref)) byCode.get(key)[k] = 1;
    }
  });
  return { ofTask: own, ofEl, byCode, how, codes: { n: idx.size, found: found.size, missing: [...idx.keys()].filter((c) => !found.has(c)) }, heads: { prog: idx.head || "", els: eh }, rules };
}

/* conteso: due attività che costruiscono (o demoliscono) la stessa cosa.
   Non lo sono una provvisoria che si apre e si toglie (due provvisorie, o una
   provvisoria e la sua rimozione, che dal nome è una demolizione: la
   deviazione del programma d'esempio) e un elemento costruito e poi
   demolito; le attività «fuori dal modello» non contano. */
export function isContested(types) {
  let b = 0, d = 0, t = 0;
  for (const ty of types) if (ty === "build") b++; else if (ty === "demo") d++; else if (ty === "temp") t++;
  const n = b + d + t;
  return !(n <= 1 || (n === 2 && (t === 2 || (d === 1 && (b === 1 || t === 1)))));
}
export const FREE = 0, LINKED = 1, CONTESTED = 2, HAND = 3;
/**
 * La copertura. typeOf(t) → "build" | "temp" | "demo" | "none".
 * → { total, linked, contested, hand, free,
 *     state: Map(key → Uint8Array(n): FREE | LINKED (per codice) | CONTESTED | HAND (solo a mano)),
 *     acts: { leaf, withEls, expected, todo, noneWithEls }, codes, lostRules: [regole senza elementi] }
 */
export function coverage(res, tasks, models, typeOf) {
  let total = 0, linked = 0, contested = 0, hand = 0;
  const state = new Map(), ty = tasks.map((t) => (t.summary || t.milestone ? "none" : typeOf(t)));
  for (const M of models) {
    const a = res.ofEl.get(M.key), bc = res.byCode ? res.byCode.get(M.key) : null, st = new Uint8Array(M.n);
    for (let k = 0; k < M.n; k++) {
      total++;
      if (!a[k]) continue;
      linked++;
      if (a[k].length > 1 && isContested(a[k].map((i) => ty[i]))) { st[k] = CONTESTED; contested++; }
      else if (bc && !bc[k]) { st[k] = HAND; hand++; }
      else st[k] = LINKED;
    }
    state.set(M.key, st);
  }
  const acts = { leaf: 0, withEls: 0, expected: 0, todo: 0, noneWithEls: 0 };
  tasks.forEach((t, i) => {
    if (t.summary || t.milestone) return;
    acts.leaf++;
    const n = res.ofTask[i].size;
    if (n) { acts.withEls++; if (ty[i] === "none") acts.noneWithEls++; } else if (ty[i] === "none") acts.expected++; else acts.todo++;
  });
  return { total, linked, contested, hand, free: total - linked, state, acts, codes: res.codes, lostRules: res.rules.filter((r) => !r.hits) };
}

/* ---- la selezione simile (0.6.2) ----------------------------------------
   Gli elementi che in una colonna (classe, tipo, nome, posto, codice) hanno
   uno dei valori degli elementi scelti. Il valore vuoto non conta; con multi
   un valore con più codici uniti da «;» vale per ognuno (codeColumn).
   cols: per modello l'array dei valori (null: il modello non ce l'ha);
   picks: [[mi, k]]. */
const valParts = (v, multi) => (!v ? [] : multi ? String(v).split(";").filter(Boolean) : [v]);
/* i valori degli scelti (per il menu: «stessa classe · IfcPile») → Set */
export function similarVals(cols, picks, multi = false) {
  const want = new Set();
  for (const [mi, k] of picks) { const c = cols[mi]; if (c) for (const v of valParts(c[k], multi)) want.add(v); }
  return want;
}
/* skip(mi, k): true = lasciarlo fuori (nascosto) → { vals: [valori degli scelti], out: [[mi, k]] } */
export function similar(cols, picks, { skip = null, multi = false } = {}) {
  const want = similarVals(cols, picks, multi), out = [];
  if (want.size) cols.forEach((c, mi) => {
    if (!c) return;
    for (let k = 0; k < c.length; k++) if (c[k] && valParts(c[k], multi).some((v) => want.has(v)) && !(skip && skip(mi, k))) out.push([mi, k]);
  });
  return { vals: [...want], out };
}

/* ---- il file del collegamento (.4d.json) --------------------------------- */
export const FILE_FORMAT = "viewifc-sequence-4d";
const TYPES = ["build", "temp", "demo", "none"], SHOW = ["all", "axis", "span", "up"];
/* una scelta 4D ripulita: tipo, modo di comparire, regole, tolti; WBS e nome
   dell'attività per riagganciarla. null se non resta niente */
export function cleanMeta(m) {
  if (!m || typeof m !== "object") return null;
  const out = {};
  if (TYPES.includes(m.type)) out.type = m.type;
  if (SHOW.includes(m.mode)) out.mode = m.mode;
  const add = (Array.isArray(m.add) ? m.add : []).map(cleanRule).filter(Boolean);
  if (add.length) out.add = add;
  const sub = [...new Set((Array.isArray(m.sub) ? m.sub : []).filter((x) => typeof x === "string" && x))];
  if (sub.length) out.sub = sub;
  if (!Object.keys(out).length) return null;
  if (typeof m.wbs === "string") out.wbs = m.wbs;
  if (typeof m.name === "string") out.name = m.name;
  return out;
}
/* lo stato del tool → il file. Le attività senza scelte non si scrivono. */
export function projectFile({ file = "", name = "", tasks = [], codeField = "wbs", codeFieldName = "", prop = null, auto = false, mode = "branch", typeField = null, typeFieldName = "",
  meta = {}, models = [], sd = null, sdUser = false, sal = "", costs = null, sals = [], saved = new Date().toISOString() }) {
  const byUid = new Map(tasks.map((t) => [String(t.uid), t]));
  const activities = [];
  for (const [uid, m0] of Object.entries(meta)) {
    const t = byUid.get(uid), m = cleanMeta(t ? { ...m0, wbs: t.wbs, name: t.name } : m0);
    if (m) activities.push({ uid: +uid, ...m });
  }
  activities.sort((a, b) => a.uid - b.uid);
  return {
    format: FILE_FORMAT, v: 1, saved,
    programme: { file, name, tasks: tasks.length },
    code: { field: codeField, fieldName: codeFieldName, prop: prop ? [prop[0], prop[1]] : null, auto: !!auto, mode },
    type: { field: typeField, fieldName: typeFieldName },
    status: sdUser ? { sd, sal } : { sal },
    /* C2: le fonti dei costi scelte e i SAL registrati (col nome della colonna, per leggerlo) */
    ...(costs ? { costs: { amt: costKey(costs.amt), amtName: String(costs.amtName || ""), done: costKey(costs.done), doneName: String(costs.doneName || "") } } : {}),
    ...(sals && sals.length ? { sals: sals.map(cleanSal).filter(Boolean) } : {}),
    models: models.slice(),
    activities,
  };
}
/* una fonte dei costi: "pj", "base", "pct" o il FieldID di un campo; altro → null */
export const costKey = (v) => (v === "pj" || v === "base" || v === "pct" ? v : v != null && v !== "" && Number.isFinite(+v) ? +v : null);
/* un SAL registrato ripulito: data di stato, nome, fonti, quando, maturato per UID; null se non regge */
export function cleanSal(s) {
  if (!s || typeof s !== "object" || !Number.isFinite(s.sd) || !s.v || typeof s.v !== "object") return null;
  const v = {};
  for (const [uid, x] of Object.entries(s.v)) if (Number.isFinite(+uid) && Number.isFinite(x)) v[String(+uid)] = x;
  return { sd: s.sd, label: typeof s.label === "string" ? s.label : "", amt: costKey(s.amt), done: costKey(s.done), saved: typeof s.saved === "string" ? s.saved : "", v };
}
/* il file → contenuto ripulito; un file che non è un collegamento del tool: errore col codice */
export function readProjectFile(text) {
  let o = null;
  try { o = JSON.parse(String(text).replace(/^﻿/, "")); } catch (e) { o = null; }
  if (!o || o.format !== FILE_FORMAT || !Array.isArray(o.activities)) throw Object.assign(new Error("not a 4D link file"), { code: "not4d" });
  if (o.v !== 1) throw Object.assign(new Error("version " + o.v), { code: "v4d" });
  const meta = {};
  for (const a of o.activities) {
    if (!a || !Number.isFinite(+a.uid)) continue;
    const m = cleanMeta(a);
    if (m) meta[String(+a.uid)] = m;
  }
  const c = o.code || {}, ty = o.type || {}, st = o.status || {};
  const field = c.field === "wbs" || c.field === "name" ? c.field : Number.isFinite(+c.field) ? +c.field : "wbs";
  const prop = Array.isArray(c.prop) && c.prop.length === 2 && c.prop.every((x) => typeof x === "string") ? [c.prop[0], c.prop[1]] : null;
  return {
    meta, programme: o.programme || {}, models: Array.isArray(o.models) ? o.models.filter((x) => typeof x === "string") : [],
    code: { field, fieldName: String(c.fieldName || ""), prop, auto: c.auto === true, mode: MODES.includes(c.mode) ? c.mode : "branch" },
    type: { field: ty.field == null ? null : Number.isFinite(+ty.field) ? +ty.field : null, fieldName: String(ty.fieldName || "") },
    status: { sd: Number.isFinite(st.sd) ? st.sd : null, sal: typeof st.sal === "string" ? st.sal : "" },
    costs: o.costs && typeof o.costs === "object" ? { amt: costKey(o.costs.amt), done: costKey(o.costs.done) } : null,
    sals: Array.isArray(o.sals) ? o.sals.map(cleanSal).filter(Boolean) : [],
  };
}
/**
 * Le scelte 4D sulle attività di un programma (una revisione, o il programma
 * su cui si apre un file del collegamento): per UID se WBS o nome tornano (le
 * scelte di prima della F3 non li hanno: basta l'UID), poi per WBS, poi per
 * nome, uniche fra le attività non riepilogo. Quello che non trova attività
 * va in lost, con WBS e nome per dirlo.
 * → { meta, kept, byWbs, byName, lost: [{ uid, …scelta }] }
 */
export function reattach(meta, tasks) {
  const T = tasks.filter((t) => !t.summary), byUid = new Map(T.map((t) => [String(t.uid), t]));
  const uniq = (f) => { const u = new Map(); for (const t of T) { const v = f(t); if (v) u.set(v, u.has(v) ? null : t); } return u; };
  const byW = uniq((t) => t.wbs), byN = uniq((t) => t.name);
  const out = { meta: {}, kept: 0, byWbs: 0, byName: 0, lost: [] }, taken = new Set(), rest = [];
  for (const [uid, m] of Object.entries(meta || {})) {
    if (!m) continue;
    const t = byUid.get(uid);
    if (t && ((m.wbs == null && m.name == null) || m.wbs === t.wbs || m.name === t.name)) { out.meta[uid] = { ...m, wbs: t.wbs, name: t.name }; taken.add(uid); out.kept++; }
    else rest.push([uid, m]);
  }
  for (const [uid, m] of rest) {
    let t = m.wbs ? byW.get(m.wbs) : null, how = "byWbs";
    if (!t || taken.has(String(t.uid))) { t = m.name ? byN.get(m.name) : null; how = "byName"; }
    if (t && !taken.has(String(t.uid))) { out.meta[String(t.uid)] = { ...m, wbs: t.wbs, name: t.name }; taken.add(String(t.uid)); out[how]++; }
    else out.lost.push({ uid: +uid, ...m });
  }
  return out;
}
