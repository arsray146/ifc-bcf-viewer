/* =========================================================================
   Ponte verso l'add-in «ViewIFC per Revit» (prodotto a parte, fuori da questo repo)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Le pagine del sito possono girare anche dentro Revit, nel pannello dell'add-in
   (WebView2). Questo modulo è il solo punto di contatto: fuori da Revit inRevit()
   è falso e non succede nient'altro (sul sito la pagina resta quella di sempre).
   Piano: PIANO_Revit_ViewIFC.md.

   Protocollo 1 (lato add-in: Bridge.cs):
   - l'add-in inietta window.__VIEWIFC_REVIT__ = { protocol, addin, revit } prima
     degli script della pagina;
   - la pagina manda la stringa JSON { id, op, args } con chrome.webview.postMessage;
   - risposta { id, ok: true, data } oppure { id, ok: false, error, code?, data? }
     (code = codice dell'errore da tradurre nella pagina, data = i suoi valori);
   - messaggi spontanei { event, … }: «doc» = { event, doc } quando cambia il
     documento attivo di Revit; «preview» = { event, on: false } quando l'add-in
     toglie l'anteprima da sé (finestra chiusa, pagina ricaricata); «select» (add-in
     0.4.0) = { event, items: [{ key, id }] } quando in Revit cambia la scelta degli
     elementi piazzati dalle pagine (mai per la scelta fatta con l'op select).
   Operazioni del protocollo 1 (hello dice quali ci sono in ops):
   - hello   → { viewifc: true, protocol, addin, ops: [...], revit: { version, build, name, language }, doc }
   - docInfo → doc
   - preview.set (add-in 0.2.0) { groups: [{ color: "#rrggbb", opacity: 0…1 delle facce (di partenza 0,5),
     boxes: [12 numeri per scatola: centro E, N, Z e tre semiassi], lines: [6 numeri per segmento] }] } in metri,
     coordinate condivise del modello → disegnati nelle viste del documento attivo senza creare elementi
     (DirectContext3D: facce trasparenti col colore del gruppo, spigoli più scuri e segmenti pieni)
     → { boxes, lines, triangles, doc, farKm };
     errori: code «noDoc» (nessun progetto aperto), «family» (è una famiglia), «far» (data.km: troppo lontano
     dall'origine interna, coordinate condivise da impostare)
   - preview.mesh (add-in 0.5.0) { layer: "context", groups: [{ color, opacity, origin: [E, N, Z] m condivise,
     chunks: [{ pos: base64 di Float32Array (x, y, z attorno a origin), idx: base64 di Uint16Array (triangoli) }] }] }
     → secondo strato dell'anteprima (maglie qualsiasi: gli IFC di contesto), separato dai sostegni di preview.set,
     blocchi di al massimo 60 000 vertici (meshChunks); groups vuoto = via il contesto
     → { groups, chunks, vertices, triangles, doc, farKm, ms }; errori: noDoc, family, far, mesh.
     Add-in 0.8.0 (lo dice preview.pick in ops): layer = un nome qualsiasi, uno strato per nome («context» di
     partenza, sempre sotto; es. «works» = le opere di Sviluppo profili), ognuno rimandato e tolto da sé; groups[].key
     facoltativa = il gruppo si può scegliere con preview.pick; la risposta ha anche layer. L'add-in fa le normali per
     vertice: per gli spigoli vivi i vertici vanno sdoppiati prima (creaseSplit). groups[].lines facoltativo = gli
     spigoli del gruppo, [{ pos: base64 di Float32Array, due punti per segmento attorno a origin, al massimo 60 000
     punti }] (edgeChunks), pieni nel colore groups[].edge (di partenza quello del gruppo più scuro); la risposta ha
     anche lines (segmenti)
   - preview.pick (add-in 0.8.0) { keys: [chiavi dei gruppi di preview.mesh], color?: "#ff6a2b", opacity?: 0.8, edge? }
     → quei gruppi (in tutti gli strati) disegnati col colore della scelta, i loro spigoli in edge (di partenza
     l'arancio più scuro), senza rimandare geometria; keys vuoto = nessuno; vale anche per gli strati mandati dopo
     → { keys, groups }
   - preview.shapes (add-in 0.7.0) { shapes: [{ key, chunks: [{ pos, idx }] }] } → pezzi condivisi dell'anteprima (palo
     per tipo, plinto, mensola, pilone, trave… delle famiglie), maglie nel riferimento del pezzo (metri, blocchi come
     sopra: shapeChunks), mandati una volta; preview.set li usa con instances = { chiave: [E, N, Z, rotazione attorno
     alla verticale in rad, …] } in ogni gruppo (Revit li disegna spostati, col materiale del gruppo) e risponde
     anche { instances, missing: [chiavi che non conosce: da mandare] } → { shapes, vertices, triangles, known, ms };
     errore mesh. preview.clear toglie anche i pezzi
   - preview.clear → toglie l'anteprima (sostegni e contesto)
   - place (add-in 0.3.0) { key: "tool:progetto", items: [{ id, family, types: [candidati in ordine], origin: [E, N, Z] m
     condivise, xAxis: [dx, dy] in pianta, params: { nome: { len: m } | { type: { family, types } } | { text } | { num } },
     comments }], keep: [id di tutti gli elementi del progetto] } → famiglie caricate se mancano (dal modello o dalla
     cartella del catalogo dell'add-in), elementi piazzati o aggiornati (riconosciuti da key + id), una transazione
     → { placed, updated, failed: [{ id, why }], missing: [famiglie], orphans: n, ms }; errori: noDoc, family, far,
     noCoords (data { km, E, N, Z }: il modello non ha coordinate condivise, origine proposta)
     con store (add-in 0.4.0) = { tool, name, version, items, saved: ISO, data: file del progetto in base64 } salva
     anche il progetto della pagina nel modello, nella stessa transazione → stored = la sua descrizione, oppure
     null se in un modello condiviso lo ha in mano un altro utente; errore store (file non valido)
   - coords.setup { E, N, Z } → coordinate condivise del modello (solo se non sono impostate; errore coordsSet)
   - place.prune { key, keep } → toglie gli elementi di key fuori da keep → { removed }
   - select (add-in 0.4.0) { key, ids: [...], box?: [E, N, Z min, E, N, Z max] } → sceglie in Revit gli elementi
     piazzati di key con quegli id (ids vuoto: toglie la scelta se è fatta solo di elementi di key); box →
     inquadra la vista attiva → { selected, zoomed }
   - store.get (add-in 0.4.0) { key } → { key, tool, name, saved, version, items, bytes, data: base64 };
     errore noStore
   doc = null oppure { title, path, family, workshared, location, origin: { E, N, Z, angle }, levels, stored }
   (origin = coordinate condivise dell'origine interna, in metri e gradi; stored = [{ key, tool, name, saved,
   version, items, bytes }] i progetti delle pagine salvati nel modello, senza i file).

   Niente import, niente DOM: si prova in Node (test/test_revit_bridge.js) con un
   window finto.
   ========================================================================= */
export const BRIDGE_VERSION = "1.6.0";
export const PROTOCOL = 1;

function host() {
  const w = typeof window !== "undefined" ? window : null;
  return w && w.__VIEWIFC_REVIT__ && w.chrome && w.chrome.webview ? w.chrome.webview : null;
}
/* dentro il pannello dell'add-in? */
export const inRevit = () => !!host();
/* quello che l'add-in ha iniettato ({ protocol, addin, revit }), null fuori da Revit */
export const stamp = () => (host() ? window.__VIEWIFC_REVIT__ : null);

let seq = 0, wired = null;
const waiting = new Map(), listeners = new Set();

function wire(h) {
  if (wired === h) return;
  wired = h;
  h.addEventListener("message", (e) => {
    const m = e && e.data;
    if (!m || typeof m !== "object") return;
    if (m.id != null && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      clearTimeout(w.t);
      if (m.ok) w.resolve(m.data);
      else w.reject(Object.assign(new Error(m.error || "Revit"), { code: m.code || null, data: m.data || null }));
    } else if (m.event) {
      for (const f of listeners) { try { f(m); } catch (err) { console.error(err); } }
    }
  });
}

/* un'operazione dell'add-in → Promise col risultato; fuori da Revit o dopo timeout ms la Promise è rifiutata */
export function call(op, args = {}, timeout = 30000) {
  const h = host();
  if (!h) return Promise.reject(new Error("not in Revit"));
  wire(h);
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { waiting.delete(id); reject(new Error("timeout: " + op)); }, timeout);
    waiting.set(id, { resolve, reject, t });
    h.postMessage(JSON.stringify({ id, op, args }));
  });
}

/* ascolta i messaggi spontanei dell'add-in ({ event, … }); ritorna la funzione che smette */
export function onEvent(f) {
  const h = host();
  if (h) wire(h);
  listeners.add(f);
  return () => listeners.delete(f);
}

/* saluto: la risposta di hello, oppure null fuori da Revit o se l'add-in non risponde come ViewIFC */
export async function hello(timeout = 8000) {
  if (!inRevit()) return null;
  try {
    const h = await call("hello", {}, timeout);
    return h && h.viewifc ? h : null;
  } catch (e) {
    return null;
  }
}

/* l'add-in sa fare op? (h = risposta di hello) */
export const can = (h, op) => !!(h && Array.isArray(h.ops) && h.ops.includes(op));

/* nome breve del documento per la testata: il titolo senza estensione */
export const docLabel = (doc) => (doc ? String(doc.title || "").replace(/\.(rvt|rfa|rte|rft)$/i, "") : "");

/* byte ↔ base64 per i file che passano dal ponte (il progetto salvato nel modello): a blocchi, niente DOM */
export function toB64(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function fromB64(b64) {
  const s = atob(String(b64 || "")), u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}

/* una maglia → i blocchi di preview.mesh: triangoli raggruppati per colore (quello del primo vertice, 16 livelli per
   canale: «#rrggbb»), in blocchi di al massimo maxV vertici con indici a 16 bit (i buffer di Revit); nel blocco solo
   i vertici usati, nell'ordine dei triangoli. P = posizioni (x, y, z), C = colori per vertice (r, g, b 0–255; null =
   grigio), I = indici dei triangoli. into = Map colore → [{ pos: Float32Array, idx: Uint16Array }], per accumulare
   più maglie nello stesso gruppo */
export function meshChunks(P, C, I, maxV = 60000, into = new Map()) {
  const nV = Math.floor(P.length / 3), byCol = new Map();
  const q = (v) => Math.min(255, Math.round(v / 17) * 17), hx = (v) => q(v).toString(16).padStart(2, "0");
  for (let t = 0; t + 2 < I.length; t += 3) {
    const v = I[t];
    if (I[t] >= nV || I[t + 1] >= nV || I[t + 2] >= nV) continue;
    const key = C ? "#" + hx(C[3 * v]) + hx(C[3 * v + 1]) + hx(C[3 * v + 2]) : "#bbbbbb";
    let l = byCol.get(key);
    if (!l) byCol.set(key, (l = []));
    l.push(t);
  }
  const mark = new Int32Array(nV), remap = new Int32Array(nV);
  let gen = 0;
  for (const [key, tris] of byCol) {
    const out = into.get(key) || [];
    into.set(key, out);
    let verts = [], idx = [];
    const flush = () => {
      if (idx.length) {
        const pos = new Float32Array(verts.length * 3);
        for (let k = 0; k < verts.length; k++) { const v = verts[k]; pos[3 * k] = P[3 * v]; pos[3 * k + 1] = P[3 * v + 1]; pos[3 * k + 2] = P[3 * v + 2]; }
        out.push({ pos, idx: Uint16Array.from(idx) });
      }
      verts = []; idx = []; gen++;
    };
    gen++;
    for (const t of tris) {
      let need = 0;
      for (let k = 0; k < 3; k++) if (mark[I[t + k]] !== gen) need++;
      if (verts.length + need > maxV) flush();
      for (let k = 0; k < 3; k++) {
        const v = I[t + k];
        if (mark[v] !== gen) { mark[v] = gen; remap[v] = verts.length; verts.push(v); }
        idx.push(remap[v]);
      }
    }
    flush();
  }
  return into;
}

/* un pezzo condiviso → i blocchi di preview.shapes: triangoli NON indicizzati (posizioni e normali per vertice, come le
   geometrie di three.js della vista 3D) in blocchi di al massimo maxV vertici, indici a 16 bit. L'add-in rifà le normali
   dal verso dei triangoli: un triangolo girato al contrario delle normali della pagina (i tondi piegati sono fatti a
   mano) verrebbe scuro → qui si gira. nor = null: il verso com'è. Triangoli degeneri (area nulla): via */
export function shapeChunks(pos, nor, maxV = 60000) {
  const nT = Math.floor(pos.length / 9), per = Math.max(1, Math.floor(maxV / 3)), keep = [];
  for (let t = 0; t < nT; t++) {
    const s = 9 * t;
    const ux = pos[s + 3] - pos[s], uy = pos[s + 4] - pos[s + 1], uz = pos[s + 5] - pos[s + 2];
    const vx = pos[s + 6] - pos[s], vy = pos[s + 7] - pos[s + 1], vz = pos[s + 8] - pos[s + 2];
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    if (!(fx * fx + fy * fy + fz * fz > 1e-24)) continue;
    const flip = !!nor && fx * (nor[s] + nor[s + 3] + nor[s + 6]) + fy * (nor[s + 1] + nor[s + 4] + nor[s + 7]) + fz * (nor[s + 2] + nor[s + 5] + nor[s + 8]) < 0;
    keep.push(flip ? -t - 1 : t);
  }
  const out = [];
  for (let k0 = 0; k0 < keep.length; k0 += per) {
    const n = Math.min(per, keep.length - k0), p = new Float32Array(9 * n), idx = new Uint16Array(3 * n);
    for (let k = 0; k < n; k++) {
      const e = keep[k0 + k], t = e < 0 ? -e - 1 : e;
      for (let j = 0; j < 9; j++) p[9 * k + j] = pos[9 * t + j];
      idx[3 * k] = 3 * k; idx[3 * k + 1] = e < 0 ? 3 * k + 2 : 3 * k + 1; idx[3 * k + 2] = e < 0 ? 3 * k + 1 : 3 * k + 2;
    }
    out.push({ pos: p, idx });
  }
  return out;
}

/* spigoli vivi per preview.mesh (1.6.0): l'add-in fa le normali per vertice (media delle facce attorno), quindi un
   vertice condiviso da facce piegate più di deg gradi (lo spigolo di un canale, il bordo di uno strato: le maglie di
   Sviluppo profili hanno gli anelli delle sezioni in comune) verrebbe sfumato → qui si sdoppia, un vertice per ogni
   gruppo di facce che si discostano meno di deg dalla prima del gruppo (i triangoli degeneri vanno col primo); le
   superfici curve (il tubo a 48 lati, 7,5° fra i lati) restano lisce. P = posizioni (x, y, z), I = triangoli; quelli
   con un indice fuori si saltano → { P (stesso tipo di P), I: Uint32Array }, poi meshChunks */
export function creaseSplit(P, I, deg = 30) {
  const nV = Math.floor(P.length / 3), cos = Math.cos((deg * Math.PI) / 180), tris = [];
  for (let t = 0; t + 2 < I.length; t += 3) if (I[t] < nV && I[t + 1] < nV && I[t + 2] < nV) tris.push(t);
  const nT = tris.length, fn = new Float64Array(3 * nT);
  for (let k = 0; k < nT; k++) {
    const a = 3 * I[tris[k]], b = 3 * I[tris[k] + 1], c = 3 * I[tris[k] + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z);
    if (l > 1e-12) { fn[3 * k] = x / l; fn[3 * k + 1] = y / l; fn[3 * k + 2] = z / l; }
  }
  // gli angoli dei triangoli attorno a ogni vertice (a righe compresse)
  const start = new Int32Array(nV + 1);
  for (const t of tris) for (let j = 0; j < 3; j++) start[I[t + j] + 1]++;
  for (let v = 0; v < nV; v++) start[v + 1] += start[v];
  const fill = start.slice(0, nV), corner = new Int32Array(3 * nT);
  for (let k = 0; k < nT; k++) for (let j = 0; j < 3; j++) corner[fill[I[tris[k] + j]]++] = 3 * k + j;
  const out = new Uint32Array(3 * nT), pos = [], seeds = [];
  for (let v = 0; v < nV; v++) {
    seeds.length = 0;
    for (let c = start[v]; c < start[v + 1]; c++) {
      const k = (corner[c] / 3) | 0, flat = !(fn[3 * k] || fn[3 * k + 1] || fn[3 * k + 2]);
      let id = -1;
      for (const sd of seeds) {
        const q = sd[0], none = !(fn[3 * q] || fn[3 * q + 1] || fn[3 * q + 2]);       // gruppo nato da un triangolo degenere: prende il primo vero
        if (flat || none || fn[3 * k] * fn[3 * q] + fn[3 * k + 1] * fn[3 * q + 1] + fn[3 * k + 2] * fn[3 * q + 2] >= cos) { if (none && !flat) sd[0] = k; id = sd[1]; break; }
      }
      if (id < 0) { id = pos.length / 3; pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]); seeds.push([k, id]); }
      out[corner[c]] = id;
    }
  }
  return { P: P instanceof Float32Array ? Float32Array.from(pos) : Float64Array.from(pos), I: out };
}

/* spigoli di una maglia per preview.mesh (1.6.0, groups[].lines): come EdgesGeometry di three.js nella vista 3D — i
   lati dove le due facce si piegano più di deg gradi, e quelli con una faccia sola (bordi) — in segmenti (due punti,
   x, y, z) a blocchi di al massimo maxV punti (Float32Array). I vertici si saldano prima per posizione (al decimo di
   mm: una maglia coi vertici sdoppiati non dà bordi finti); i triangoli degeneri (le giunzioni a T delle maglie del
   motore) non contano: un lato che hanno in comune con un triangolo vero è un suo bordo. P = posizioni, I = triangoli
   (quelli con un indice fuori si saltano) */
export function edgeChunks(P, I, deg = 45, maxV = 60000) {
  const nV = Math.floor(P.length / 3), cos = Math.cos((deg * Math.PI) / 180), weld = new Int32Array(nV), seen = new Map();
  for (let v = 0; v < nV; v++) {
    const k = Math.round(P[3 * v] * 1e4) + "," + Math.round(P[3 * v + 1] * 1e4) + "," + Math.round(P[3 * v + 2] * 1e4);
    const w = seen.get(k);
    if (w === undefined) { seen.set(k, v); weld[v] = v; } else weld[v] = w;
  }
  const fn = [], edges = new Map();                       // lato (a < b saldati) → [faccia, faccia | -1, più di due?]
  for (let t = 0; t + 2 < I.length; t += 3) {
    if (I[t] >= nV || I[t + 1] >= nV || I[t + 2] >= nV) continue;
    const a = 3 * I[t], b = 3 * I[t + 1], c = 3 * I[t + 2];
    const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx, l = Math.hypot(x, y, z), f = fn.length / 3;
    if (!(l > 1e-12)) continue;                           // degenere (giunzione a T): non conta, i lati vanno coi triangoli veri
    fn.push(x / l, y / l, z / l);
    for (let j = 0; j < 3; j++) {
      let p = weld[I[t + j]], q = weld[I[t + (j + 1) % 3]];
      if (p === q) continue;
      if (p > q) { const s = p; p = q; q = s; }
      const key = p * nV + q, e = edges.get(key);
      if (!e) edges.set(key, [f, -1, p, q]);
      else if (e[1] === -1) e[1] = f;
      else e[1] = -2;                                     // più di due facce: lato non a tenuta, si disegna
    }
  }
  const out = [];
  let seg = [];
  const flush = () => { if (seg.length) out.push(Float32Array.from(seg)); seg = []; };
  for (const [f0, f1, p, q] of edges.values()) {
    if (f1 >= 0 && fn[3 * f0] * fn[3 * f1] + fn[3 * f0 + 1] * fn[3 * f1 + 1] + fn[3 * f0 + 2] * fn[3 * f1 + 2] > cos) continue;
    if (seg.length + 6 > 3 * maxV) flush();
    seg.push(P[3 * p], P[3 * p + 1], P[3 * p + 2], P[3 * q], P[3 * q + 1], P[3 * q + 2]);
  }
  flush();
  return out;
}
