/* =========================================================================
   Sviluppo profili (Profile Sweep) — lettori e scrittori, tool 17 di viewifc.com
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   Lettori: DXF ASCII (parser nostro) e DWG (LibreDWG in WebAssembly, nel
   vendor, caricato solo quando serve). Tutti e due danno lo stesso
   «disegno»: { insunits, polys: [{ layer, pts: [{ x, y, b }], closed, src }],
   counts, inserts, skipped }. Linee e archi sciolti dello stesso layer si
   concatenano in polilinee (un profilo a volte arriva così).

   Scrittori: polilinea 3D in DXF (R12, la apre qualunque CAD), LandXML 1.2
   (asse con Line/Curve + profilo a PVI, come il tool Alignment → LandXML:
   coordinate «Nord Est», azimut da nord).

   Fatti misurati sui DWG dell'utente (2026-10-04): AC1032, INSUNITS = 4
   (millimetri) ma coordinate in METRI → l'unità dichiarata non si usa mai
   da sola per scalare: la pagina la mostra e lascia decidere.
   ========================================================================= */

/* -------------------------------------------------------------------------
   DXF ASCII
   ------------------------------------------------------------------------- */

/** Testo di un DXF da byte: UTF-8 se valido (DXF 2007+), altrimenti Windows-1252. */
export function decodeDXF(bytes) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch (e) { return new TextDecoder("windows-1252").decode(bytes); }
}

/**
 * DXF ASCII → disegno. Legge LWPOLYLINE, POLYLINE (2D e 3D; le mesh no),
 * LINE e ARC della sezione ENTITIES; i blocchi (INSERT) si contano e basta.
 * OCS: si gestisce il caso comune dell'estrusione (0,0,−1) (specchiato in X).
 */
export function parseDXF(text) {
  if (text.startsWith("AutoCAD Binary DXF")) throw new Error("DXF_BINARY");
  const L = text.split(/\r\n|\r|\n/);
  const out = { insunits: null, acadver: null, polys: [], counts: {}, inserts: 0, skipped: 0 };
  const segs = [];
  let i = 0, section = null;
  const code = () => parseInt(L[i], 10);
  // ciclo a coppie (codice, valore)
  while (i + 1 < L.length) {
    const c = code(), v = L[i + 1].trim();
    if (c === 0 && v === "SECTION") { section = (L[i + 3] || "").trim(); i += 4; continue; }
    if (c === 0 && v === "ENDSEC") { section = null; i += 2; continue; }
    if (c === 0 && v === "EOF") break;
    if (section === "HEADER" && c === 9) {
      if (v === "$INSUNITS") out.insunits = parseInt(L[i + 3], 10);
      if (v === "$ACADVER") out.acadver = (L[i + 3] || "").trim();
      i += 2; continue;
    }
    if (section === "ENTITIES" && c === 0) {
      const type = v;
      out.counts[type] = (out.counts[type] || 0) + 1;
      i += 2;
      // raccogli i gruppi dell'entità fino al prossimo 0
      const g = [];
      while (i + 1 < L.length && code() !== 0) { g.push([code(), L[i + 1]]); i += 2; }
      const get = (k, d) => { for (const [a, b] of g) if (a === k) return b; return d; };
      const layer = String(get(8, "0")).trim();
      const mir = Number(get(230, 1)) < 0;              // estrusione (0,0,−1): X specchiata
      if (type === "LWPOLYLINE") {
        const pts = [];
        for (const [a, b] of g) {
          if (a === 10) pts.push({ x: Number(b) * (mir ? -1 : 1), y: 0, b: 0 });
          else if (a === 20 && pts.length) pts[pts.length - 1].y = Number(b);
          else if (a === 42 && pts.length) pts[pts.length - 1].b = Number(b) * (mir ? -1 : 1);
        }
        const closed = (parseInt(get(70, "0"), 10) & 1) === 1;
        if (pts.length >= 2) out.polys.push({ layer, pts, closed, src: "LWPOLYLINE", z: Number(get(38, 0)) });
      } else if (type === "POLYLINE") {
        const flags = parseInt(get(70, "0"), 10);
        const pts = [];
        // VERTEX … SEQEND
        while (i + 1 < L.length) {
          const vt = L[i + 1].trim();
          if (code() !== 0) { i += 2; continue; }
          if (vt === "SEQEND") { i += 2; while (i + 1 < L.length && code() !== 0) i += 2; break; }
          if (vt !== "VERTEX") break;
          i += 2;
          const vg = [];
          while (i + 1 < L.length && code() !== 0) { vg.push([code(), L[i + 1]]); i += 2; }
          const vget = (k, d) => { for (const [a, b] of vg) if (a === k) return b; return d; };
          const vf = parseInt(vget(70, "0"), 10);
          if (vf & 16) continue;                          // punto di controllo di una spline
          pts.push({ x: Number(vget(10, 0)), y: Number(vget(20, 0)), z: Number(vget(30, 0)), b: Number(vget(42, 0)) });
        }
        if (flags & (16 | 64)) { out.skipped++; continue; }   // mesh e polyface: non sono linee
        if (pts.length >= 2) out.polys.push({ layer, pts, closed: (flags & 1) === 1, src: flags & 8 ? "POLYLINE3D" : "POLYLINE" });
      } else if (type === "LINE") {
        segs.push({ layer, x0: Number(get(10, 0)), y0: Number(get(20, 0)), x1: Number(get(11, 0)), y1: Number(get(21, 0)), b: 0 });
      } else if (type === "ARC") {
        const cx = Number(get(10, 0)) * (mir ? -1 : 1), cy = Number(get(20, 0)), r = Number(get(40, 0));
        let a0 = Number(get(50, 0)) * Math.PI / 180, a1 = Number(get(51, 0)) * Math.PI / 180;
        if (mir) { const t = Math.PI - a1; a1 = Math.PI - a0; a0 = t; }
        segs.push(arcSeg(layer, cx, cy, r, a0, a1, mir));
      } else if (type === "INSERT") out.inserts++;
      continue;
    }
    i += 2;
  }
  out.polys.push(...chainSegments(segs));
  return out;
}

/** Arco (centro, raggio, angoli antiorari a0 → a1) come lato con bulge. */
function arcSeg(layer, cx, cy, r, a0, a1, flip = false) {
  let sw = a1 - a0;
  while (sw <= 0) sw += 2 * Math.PI;
  const s = { layer, x0: cx + r * Math.cos(a0), y0: cy + r * Math.sin(a0), x1: cx + r * Math.cos(a1), y1: cy + r * Math.sin(a1), b: Math.tan(sw / 4) };
  if (flip) return { layer, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0, b: -s.b };
  return s;
}

/**
 * Linee e archi sciolti → polilinee, layer per layer, unendo i capi che
 * coincidono (entro tol). Un lato percorso al contrario cambia segno al bulge.
 */
export function chainSegments(segs, tol = 1e-3) {
  const byLayer = new Map();
  for (const s of segs) { if (!byLayer.has(s.layer)) byLayer.set(s.layer, []); byLayer.get(s.layer).push(s); }
  const out = [];
  const key = (x, y) => Math.round(x / tol) + "," + Math.round(y / tol);
  for (const [layer, list] of byLayer) {
    const ends = new Map();                              // capo → [indice del lato]
    const add = (k, idx) => { if (!ends.has(k)) ends.set(k, []); ends.get(k).push(idx); };
    list.forEach((s, idx) => { add(key(s.x0, s.y0), idx); add(key(s.x1, s.y1), idx); });
    const used = new Uint8Array(list.length);
    const other = (k, idx) => (ends.get(k) || []).find((j) => j !== idx && !used[j]);
    // parti da un capo libero (grado 1) se c'è, così la catena non nasce a metà
    const order = list.map((_, idx) => idx).sort((a, b) => {
      const da = Math.min(ends.get(key(list[a].x0, list[a].y0)).length, ends.get(key(list[a].x1, list[a].y1)).length);
      const db = Math.min(ends.get(key(list[b].x0, list[b].y0)).length, ends.get(key(list[b].x1, list[b].y1)).length);
      return da - db;
    });
    for (const start of order) {
      if (used[start]) continue;
      used[start] = 1;
      let s = list[start];
      if ((ends.get(key(s.x0, s.y0)) || []).some((j) => j !== start && !used[j]) && !(ends.get(key(s.x1, s.y1)) || []).some((j) => j !== start && !used[j])) {
        s = { ...s, x0: s.x1, y0: s.y1, x1: s.x0, y1: s.y0, b: -s.b };      // il capo libero davanti
      }
      const pts = [{ x: s.x0, y: s.y0, b: s.b }, { x: s.x1, y: s.y1, b: 0 }];
      // avanti
      for (;;) {
        const tail = pts[pts.length - 1], k = key(tail.x, tail.y), j = other(k, -1);
        if (j === undefined) break;
        used[j] = 1;
        let t = list[j];
        if (key(t.x0, t.y0) !== k) t = { ...t, x0: t.x1, y0: t.y1, x1: t.x0, y1: t.y0, b: -t.b };
        tail.b = t.b;
        pts.push({ x: t.x1, y: t.y1, b: 0 });
      }
      const closed = pts.length > 2 && key(pts[0].x, pts[0].y) === key(pts[pts.length - 1].x, pts[pts.length - 1].y);
      out.push({ layer, pts, closed, src: "LINE/ARC" });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
   DWG (LibreDWG in WebAssembly)
   ------------------------------------------------------------------------- */

let dwgLib = null;                                       // { mod, wasmBinary }

/**
 * DWG → disegno. base = URL della cartella vendor/libredwg-web/ (con la
 * barra finale). Il .wasm si scarica una volta; per ogni file un'istanza
 * nuova (vedi README del vendor). In Node si può passare { wasmBinary }.
 */
export async function readDWG(bytes, { base, wasmBinary } = {}) {
  if (!dwgLib) {
    const mod = await import(new URL("dist/libredwg-web.js", base).href);
    const bin = wasmBinary || new Uint8Array(await (await fetch(new URL("wasm/libredwg-web.wasm", base))).arrayBuffer());
    dwgLib = { mod, wasmBinary: bin };
  }
  const { mod, wasmBinary: bin } = dwgLib;
  const inst = await mod.createModule({ wasmBinary: bin });
  const lib = mod.LibreDwg.createByWasmInstance(inst);
  const dwg = lib.dwg_read_data(bytes, mod.Dwg_File_Type.DWG);
  if (!dwg) throw new Error("DWG_READ");
  const db = lib.convert(dwg);
  return dwgToDrawing(db);
}

/** Database convertito da libredwg-web → disegno (stessa forma di parseDXF). */
export function dwgToDrawing(db) {
  const out = { insunits: db.header ? db.header.INSUNITS ?? null : null, acadver: null, polys: [], counts: {}, inserts: 0, skipped: 0 };
  const segs = [];
  for (const e of db.entities || []) {
    out.counts[e.type] = (out.counts[e.type] || 0) + 1;
    const layer = String(e.layer ?? "0");
    const mir = e.extrusionDirection && e.extrusionDirection.z < 0;
    if (e.type === "LWPOLYLINE") {
      const pts = (e.vertices || []).map((v) => ({ x: v.x * (mir ? -1 : 1), y: v.y, b: (v.bulge || 0) * (mir ? -1 : 1) }));
      if (pts.length >= 2) out.polys.push({ layer, pts, closed: (e.flag & 512) !== 0, src: "LWPOLYLINE", z: e.elevation || 0 });
    } else if (e.type === "POLYLINE2D" || e.type === "POLYLINE3D") {
      if (e.flag & (16 | 64)) { out.skipped++; continue; }
      const pts = (e.vertices || []).filter((v) => !(v.flag & 16)).map((v) => ({ x: v.x, y: v.y, z: v.z || 0, b: v.bulge || 0 }));
      if (pts.length >= 2) out.polys.push({ layer, pts, closed: (e.flag & 1) !== 0, src: e.type === "POLYLINE3D" ? "POLYLINE3D" : "POLYLINE" });
    } else if (e.type === "LINE") {
      segs.push({ layer, x0: e.startPoint.x, y0: e.startPoint.y, x1: e.endPoint.x, y1: e.endPoint.y, b: 0 });
    } else if (e.type === "ARC") {
      const cx = e.center.x * (mir ? -1 : 1);
      let a0 = e.startAngle, a1 = e.endAngle;
      if (mir) { const t = Math.PI - a1; a1 = Math.PI - a0; a0 = t; }
      segs.push(arcSeg(layer, cx, e.center.y, e.radius, a0, a1, mir));
    } else if (e.type === "INSERT") out.inserts++;
  }
  out.polys.push(...chainSegments(segs));
  return out;
}

/** Disegno da byte, riconoscendo il formato dalla firma: DWG «AC10…», altrimenti DXF. */
export async function readDrawing(bytes, opts = {}) {
  const sig = String.fromCharCode(...bytes.subarray(0, 6));
  if (/^AC1\d{3}$/.test(sig)) return { ...(await readDWG(bytes, opts)), format: "DWG", version: sig };
  const d = parseDXF(decodeDXF(bytes));
  return { ...d, format: "DXF", version: d.acadver };
}

/**
 * Riepilogo per layer: [{ layer, n (polilinee), verts, length, arcs, closed, bbox }]
 * ordinato per nome. Serve alla pagina per proporre la polilinea giusta.
 */
export function layerSummary(drawing, polyLength) {
  const m = new Map();
  for (const p of drawing.polys) {
    let r = m.get(p.layer);
    if (!r) m.set(p.layer, r = { layer: p.layer, n: 0, verts: 0, length: 0, arcs: 0, closed: 0, bbox: [Infinity, Infinity, -Infinity, -Infinity] });
    r.n++; r.verts += p.pts.length; r.length += polyLength(p); if (p.closed) r.closed++;
    for (const q of p.pts) {
      if (q.b) r.arcs++;
      if (q.x < r.bbox[0]) r.bbox[0] = q.x; if (q.y < r.bbox[1]) r.bbox[1] = q.y;
      if (q.x > r.bbox[2]) r.bbox[2] = q.x; if (q.y > r.bbox[3]) r.bbox[3] = q.y;
    }
  }
  return [...m.values()].sort((a, b) => a.layer.localeCompare(b.layer));
}

/**
 * Layer proposto per ogni ruolo dai nomi (PLANIMETRICO / ASSE; CONDOTTA /
 * SCORRIMENTO / PROGETTO… / QUOTE; TERRENO). Fuori i layer della tabella sotto
 * il profilo (cartiglio, testi, linee delle sezioni: Roads li mette in
 * P_CART*, P_SEZIONI-*). Fra più candidati: prima la parola più forte, poi la
 * linea fatta di meno pezzi e più vertici (il terreno vero, non 36 trattini).
 * «IDR MDL quote» (inalveazione 400X250) è la linea di progetto: QUOTE è la
 * parola più debole, la vince qualunque nome più chiaro.
 */
const NOT_LINE = /SEZION|CART|TXT|TEST|QUOTA[-_ ]?RIF|GRIGLI|GRID|CHITARR|TABELL/i;
export function guessLayers(summary) {
  const before = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  const pick = (res, not) => {
    let best = null, bk = null;
    for (const r of summary) {
      if (NOT_LINE.test(r.layer) || (not && not.test(r.layer))) continue;
      const w = res.findIndex((re) => re.test(r.layer));
      if (w < 0) continue;
      const k = [w, r.n, -r.verts / r.n];          // parola più forte, meno pezzi, più vertici per pezzo
      if (!bk || before(k, bk)) { best = r; bk = k; }
    }
    return best;
  };
  return {
    plan: pick([/PLANIM|PIANTA|TRACCIAT|ALIGN/i, /ASSE/i]),
    design: pick([/SCORR|CONDOTT|FONDO|LIVELLETT/i, /PROGETT|TUBAZ|FOSSO|CANAL|INALVEAZ/i, /\bQUOT[AE]\b/i], /TERREN|GROUND/i),
    ground: pick([/TERREN|GROUND|ESISTENT/i]),
  };
}

/**
 * Ruolo di un disegno appena aperto. Prima le COORDINATE: la pianta sta in
 * coordinate cartografiche (Gauss-Boaga, UTM: numeri > 10 000), il profilo in
 * coordinate piccole (progressive, quote). Poi il NOME DEL FILE (PLANIMETRICO /
 * ALTIMETRICO / PROFILO) e solo alla fine i nomi dei layer: nel fosso VI02
 * «asse» sta nei layer di tutti e due i disegni («asse profilo» in pianta,
 * «quote scorrimento asse» nel profilo).
 * Ritorna { plan, design, ground, sum } (nomi di layer o null).
 */
export function classifyDrawing(drawing, fileName, polyLength) {
  const sum = layerSummary(drawing, polyLength);
  const big = (a, b) => Math.min(Math.abs(a), Math.abs(b)) > 10000;
  const cart = (r) => big(r.bbox[0], r.bbox[2]) && big(r.bbox[1], r.bbox[3]);
  const planL = sum.filter(cart), profL = sum.filter((r) => !cart(r));
  const longest = (rows) => rows.slice().sort((a, b) => b.length - a.length)[0] || null;
  const out = { plan: null, design: null, ground: null, sum };
  const fn = String(fileName || "").replace(/\.[^.]+$/, "");
  const nameKind = /PLANIMETR|PIANTA|TRACCIAT/i.test(fn) ? "plan" : /ALTIMETR|PROFIL|LONGITUDIN/i.test(fn) ? "prof" : null;
  if (planL.length) out.plan = (guessLayers(planL).plan || longest(planL)).layer;
  if (profL.length) {
    const g = guessLayers(profL);
    out.design = g.design ? g.design.layer : null;
    out.ground = g.ground ? g.ground.layer : null;
    // nessun nome utile in un disegno tutto in coordinate piccole: la linea più lunga
    if (!planL.length && !out.design && !out.ground) {
      if (nameKind === "plan") out.plan = (g.plan || longest(profL)).layer;
      else out.design = longest(profL).layer;
    } else if (!planL.length && nameKind === "plan" && g.plan) {
      out.plan = g.plan.layer; out.design = null; out.ground = null;      // pianta in coordinate locali
    } else if (!out.design && out.ground) {
      // il terreno c'è ma il progetto ha un nome che non diciamo: la linea in meno pezzi che copre
      // almeno metà delle progressive del terreno, fuori dalla tabella
      const gr = profL.find((r) => r.layer === out.ground), span = (r) => r.bbox[2] - r.bbox[0];
      const cand = profL.filter((r) => r !== gr && !NOT_LINE.test(r.layer) && r.n <= 3 && span(r) >= 0.5 * span(gr))
        .sort((a, b) => a.n - b.n || b.length - a.length);
      if (cand.length) out.design = cand[0].layer;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------
   Più opere nello stesso progetto (scelte dell'utente 2026-10-04): il nome
   dell'opera viene dal file della pianta ripulito dalle parole di servizio;
   quando arrivano più piante e più profili, un profilo va alla pianta che gli
   somiglia nel nome (file + layer) e nella lunghezza (scala delle distanze
   compresa) — nella pagina si corregge da un menu.
   ------------------------------------------------------------------------- */
const SERVICE = "profil[oi]|profile|planimetric[oaie]|planimetri[ae]|altimetric[oaie]|altimetri[ae]|pianta|plan|asse|axis|alignment|longitudinale|tracciato";
const SERVICE_RE = new RegExp(`(^|[\\s_\\-–.]+)(${SERVICE})(?=$|[\\s_\\-–.]+)`, "gi");
const EDGE_SEP = /^[\s_\-–.]+|[\s_\-–.]+$/g;

/** «Asse Planimetria Sud fosso VI02 TO02.dwg» → «Sud fosso VI02 TO02»; se non resta nulla, il nome del file. */
export function workName(fileName) {
  const base = String(fileName || "").replace(/\.[^.\\/]+$/, "").trim();
  const s = base.replace(SERVICE_RE, " ").replace(EDGE_SEP, "").replace(/\s{2,}/g, " ").trim();
  return s || base;
}

/**
 * Tipo di sezione dai nomi di file e layer: «inalveazione … 400X250» o
 * «canale 400x250» → canale a U con interno 4,00 × 2,50 (numeri grandi =
 * centimetri); «fosso» → fosso trapezio. Il «50x50x50» di un fosso (tre
 * misure) non è una U. Ritorna { type: "channel", B?, H? } | { type: "ditch" } | null.
 */
export function guessSection(...names) {
  const s = names.filter(Boolean).join(" ");
  if (/INALVEAZ|CANAL|SCATOLAR/i.test(s)) {
    const out = { type: "channel" };
    const m = /(?<![\d.,x×])(\d+(?:[.,]\d+)?)\s*[x×]\s*(\d+(?:[.,]\d+)?)(?!\d|[.,]\d|\s*[x×]\s*\d)/i.exec(s);
    if (m) {
      let a = parseFloat(m[1].replace(",", ".")), b = parseFloat(m[2].replace(",", "."));
      if (a >= 20 && b >= 20) { a /= 100; b /= 100; }
      if (a > 0.2 && a < 30 && b > 0.2 && b < 30) { out.B = a; out.H = b; }
    }
    return out;
  }
  if (/FOSS[OI]|CUNETT/i.test(s)) return { type: "ditch" };
  return null;
}

const STOP = new Set(["idr", "mdl", "quote", "quota", "scorrimento", "layer", "di", "del", "della", "dei", "il", "la", "lo", "e", "the", "of", "and", "dwg", "dxf"]);
const nameTokens = (...ss) => {
  const out = new Set();
  for (const t of ss.join(" ").replace(SERVICE_RE, " ").toLowerCase().split(/[^0-9a-zà-ÿ]+/)) if (t && !STOP.has(t) && !/^0+$/.test(t)) out.add(t);
  return out;
};

/**
 * Abbina i profili alle piante. plans [{ name (file), layer, length }],
 * profs [{ name (file), layer (progetto), span (estensione in X nel disegno) }],
 * scaleOf(lunghezza pianta, span) → scala delle distanze (core.distanceScale).
 * Punteggio = somiglianza dei nomi (Jaccard sulle parole) + 0,6 se le lunghezze
 * tornano entro il 2 % (0,3 entro il 10 %). Si prende la coppia migliore, poi
 * la seguente fra le libere; un solo profilo e una sola pianta rimasti si
 * abbinano comunque. Ritorna, per ogni profilo, l'indice della pianta o −1.
 */
export function matchProfiles(plans, profs, scaleOf = () => 1) {
  const A = plans.map((p) => nameTokens(String(p.name || "").replace(/\.[^.\\/]+$/, ""), p.layer || ""));
  const B = profs.map((p) => nameTokens(String(p.name || "").replace(/\.[^.\\/]+$/, ""), p.layer || ""));
  const lenScore = (L, span) => {
    if (!(L > 0) || !(span > 0)) return 0;
    const e = Math.abs(L / (span * scaleOf(L, span)) - 1);
    return e < 0.02 ? 1 : e < 0.1 ? 0.5 : 0;
  };
  const cand = [];
  plans.forEach((p, i) => profs.forEach((q, j) => {
    let inter = 0;
    for (const t of A[i]) if (B[j].has(t)) inter++;
    const uni = A[i].size + B[j].size - inter;
    cand.push({ i, j, s: (uni ? inter / uni : 0) + 0.6 * lenScore(p.length, q.span) });
  }));
  cand.sort((a, b) => b.s - a.s || a.i - b.i || a.j - b.j);
  const pick = profs.map(() => -1), used = new Set();
  for (const { i, j, s } of cand) if (s > 0 && pick[j] < 0 && !used.has(i)) { pick[j] = i; used.add(i); }
  const freeP = plans.map((_, i) => i).filter((i) => !used.has(i)), freeQ = profs.map((_, j) => j).filter((j) => pick[j] < 0);
  if (freeP.length === 1 && freeQ.length === 1) pick[freeQ[0]] = freeP[0];
  return pick;
}

/**
 * Pezzi di una polilinea di PIANTA da unire in un solo asse: si concatenano
 * per capi vicini (girandoli se serve); i buchi restano come lati dritti e si
 * contano. Ritorna { poly, gaps: [{ at, len }] }.
 */
export function joinPlanPieces(polys) {
  if (polys.length === 1) return { poly: polys[0], gaps: [] };
  const rev = (p) => {
    const q = p.pts, out = [];
    for (let i = q.length - 1; i >= 0; i--) out.push({ x: q[i].x, y: q[i].y, b: i > 0 ? -(q[i - 1].b || 0) : 0 });
    return { ...p, pts: out };
  };
  const left = polys.slice(1);
  let cur = { ...polys[0], pts: polys[0].pts.map((p) => ({ ...p })) };
  const gaps = [];
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  while (left.length) {
    const h = cur.pts[0], t = cur.pts[cur.pts.length - 1];
    let best = null;
    left.forEach((p, idx) => {
      const a = p.pts[0], b = p.pts[p.pts.length - 1];
      for (const [dist, where, flip] of [[d(t, a), "tail", false], [d(t, b), "tail", true], [d(h, b), "head", false], [d(h, a), "head", true]])
        if (!best || dist < best.dist) best = { dist, where, flip, idx };
    });
    const p0 = left.splice(best.idx, 1)[0], p = best.flip ? rev(p0) : p0;
    if (best.where === "tail") {
      if (best.dist > 1e-3) gaps.push({ len: best.dist });
      cur.pts[cur.pts.length - 1].b = 0;
      cur.pts.push(...p.pts.slice(best.dist > 1e-3 ? 0 : 1).map((q) => ({ ...q })));
    } else {
      if (best.dist > 1e-3) gaps.push({ len: best.dist });
      const head = p.pts.map((q) => ({ ...q }));
      if (best.dist <= 1e-3) head.pop();
      head[head.length - 1].b = head[head.length - 1].b || 0;
      cur.pts = head.concat(cur.pts);
    }
  }
  return { poly: cur, gaps };
}

/* -------------------------------------------------------------------------
   Scrittori
   ------------------------------------------------------------------------- */

const f4 = (v) => (Math.round(v * 1e4) / 1e4).toFixed(4);

/**
 * Polilinee 3D in DXF R12 (AC1009): HEADER minimo + una POLYLINE con flag 8
 * per asse, coi suoi VERTEX (flag 32), ognuna sul suo layer. Coordinate al
 * decimo di millimetro. list = [{ pts: [{ x, y, z }], layer }].
 */
export function dxf3DPolylines(list) {
  const ln = [];
  const g = (c, v) => { ln.push(String(c), String(v)); };
  const layers = [...new Set(list.map((a) => a.layer))];
  g(0, "SECTION"); g(2, "HEADER"); g(9, "$ACADVER"); g(1, "AC1009"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "TABLES");
  g(0, "TABLE"); g(2, "LAYER"); g(70, layers.length);
  layers.forEach((l, i) => { g(0, "LAYER"); g(2, l); g(70, 0); g(62, 1 + (i % 6)); g(6, "CONTINUOUS"); });
  g(0, "ENDTAB"); g(0, "ENDSEC");
  g(0, "SECTION"); g(2, "ENTITIES");
  for (const { pts, layer } of list) {
    g(0, "POLYLINE"); g(8, layer); g(66, 1); g(10, "0.0"); g(20, "0.0"); g(30, "0.0"); g(70, 8);
    for (const p of pts) { g(0, "VERTEX"); g(8, layer); g(10, f4(p.x)); g(20, f4(p.y)); g(30, f4(p.z)); g(70, 32); }
    g(0, "SEQEND"); g(8, layer);
  }
  g(0, "ENDSEC"); g(0, "EOF");
  return ln.join("\r\n") + "\r\n";
}
/** Una sola polilinea 3D (l'asse di un'opera). */
export function dxf3DPolyline(pts, { layer = "ASSE_3D" } = {}) { return dxf3DPolylines([{ pts, layer }]); }

/**
 * Nomi di layer validi in R12 per gli assi delle opere: lettere, cifre, $ - _,
 * al massimo 31 caratteri, tutti diversi. «Sud fosso VI02 TO02» → «ASSE_3D_SUD_FOSSO_VI02_TO02».
 */
export function dxfLayerNames(names, prefix = "ASSE_3D") {
  const seen = new Set();
  return names.map((n) => {
    const clean = String(n || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9$_-]+/g, "_").replace(/^_+|_+$/g, "");
    let base = (clean ? prefix + "_" + clean : prefix).slice(0, 31), out = base, k = 2;
    while (seen.has(out)) { const suf = "_" + k++; out = base.slice(0, 31 - suf.length) + suf; }
    seen.add(out);
    return out;
  });
}

const xmlEsc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const f6 = (v) => v.toFixed(6);
const ne = (x, y) => f6(y) + " " + f6(x);                // LandXML: Nord Est
const azimuth = (dx, dy) => { const a = Math.atan2(dx, dy); return a < 0 ? a + 2 * Math.PI : a; };   // da nord, orario

/**
 * PVI del profilo dall'asse 3D, togliendo quelli allineati (stessa
 * livelletta). Un salto verticale (due quote alla stessa progressiva) in
 * LandXML non si scrive: la quota a monte va 1 mm prima, quella a valle
 * resta sulla progressiva. Ritorna [{ s, z }].
 */
export function profilePVI(pts3d, eps = 1e-4) {      // allineati entro 0,1 mm
  const raw = [];
  for (const p of pts3d) {
    const last = raw[raw.length - 1];
    if (last && p.p - last.s < 1e-6) {
      const prev = raw[raw.length - 2];
      if (!prev || last.s - 0.001 > prev.s + 1e-6) last.s -= 0.001; else raw.pop();
      raw.push({ s: p.p, z: p.z });
      continue;
    }
    raw.push({ s: p.p, z: p.z });
  }
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    if (i > 0 && i < raw.length - 1) {
      const a = out[out.length - 1], b = raw[i], c = raw[i + 1];
      const zLin = a.z + (c.z - a.z) * (b.s - a.s) / (c.s - a.s);
      if (Math.abs(zLin - b.z) <= eps) continue;
    }
    out.push({ s: raw[i].s, z: raw[i].z });
  }
  return out;
}

/**
 * LandXML 1.2: un Alignment per asse con CoordGeom (Line / Curve dai lati
 * dell'asse in pianta) e Profile/ProfAlign coi PVI. Un asse solo ({ name,
 * axis, pvi }) o più (alignments: [{ name, axis, pvi }], nomi resi unici come
 * vuole lo schema). stamp = { date: "AAAA-MM-GG", time: "hh:mm:ss" }.
 */
export function landXML({ name, axis, pvi, alignments, stamp, app = "viewifc.com — Sviluppo profili" }) {
  const I = "        ";
  const list = alignments || [{ name, axis, pvi }];
  const seen = new Set();
  const body = [];
  for (const a of list) {
    let nm = String(a.name || "Asse"), k = 2;
    while (seen.has(nm)) nm = `${a.name} (${k++})`;
    seen.add(nm);
    const geo = [];
    for (const g of a.axis.segs) {
      if (g.t === "L") {
        geo.push(I + `<Line staStart="${f6(g.s0)}" dir="${f6(azimuth(g.ux, g.uy))}" length="${f6(g.len)}">`,
          I + `  <Start>${ne(g.x0, g.y0)}</Start>`, I + `  <End>${ne(g.x1, g.y1)}</End>`, I + "</Line>");
      } else {
        const dir = Math.sign(g.sweep), t0 = g.a0, t1 = g.a0 + g.sweep;
        const d0 = azimuth(-Math.sin(t0) * dir, Math.cos(t0) * dir), d1 = azimuth(-Math.sin(t1) * dir, Math.cos(t1) * dir);
        geo.push(I + `<Curve rot="${dir > 0 ? "ccw" : "cw"}" staStart="${f6(g.s0)}" dirStart="${f6(d0)}" dirEnd="${f6(d1)}" radius="${f6(g.r)}" length="${f6(g.len)}">`,
          I + `  <Start>${ne(g.x0, g.y0)}</Start>`, I + `  <Center>${ne(g.cx, g.cy)}</Center>`, I + `  <End>${ne(g.x1, g.y1)}</End>`, I + "</Curve>");
      }
    }
    const prof = a.pvi && a.pvi.length >= 2
      ? ["      <Profile>", `        <ProfAlign name="${xmlEsc(nm)}">`, ...a.pvi.map((p) => `          <PVI>${f6(p.s)} ${f6(p.z)}</PVI>`), "        </ProfAlign>", "      </Profile>"]
      : [];
    body.push(`    <Alignment name="${xmlEsc(nm)}" staStart="0.000000" length="${f6(a.axis.length)}">`, "      <CoordGeom>", ...geo, "      </CoordGeom>", ...prof, "    </Alignment>");
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<LandXML xmlns="http://www.landxml.org/schema/LandXML-1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://www.landxml.org/schema/LandXML-1.2 http://www.landxml.org/schema/LandXML-1.2/LandXML-1.2.xsd" date="${stamp.date}" time="${stamp.time}" version="1.2">`,
    "  <Units>",
    '    <Metric areaUnit="squareMeter" linearUnit="meter" volumeUnit="cubicMeter" temperatureUnit="celsius" pressureUnit="HPA" angularUnit="radians" directionUnit="radians"/>',
    "  </Units>",
    `  <Application name="${xmlEsc(app)}" manufacturer="viewifc.com"/>`,
    "  <Alignments>",
    ...body,
    "  </Alignments>",
    "</LandXML>",
    "",
  ].join("\n");
}

/* -------------------------------------------------------------------------
   IFC 4x3 (IFC4X3_ADD2) del fosso
   Coordinate come il DTM di Revit dell'utente: l'origine (E, N arrotondati)
   sta nel placement dell'IfcSite, la geometria è in metri locali — i due file
   si federano senza conti in viewer, Navisworks e Revit. Niente
   IfcMapConversion (il sistema di riferimento dei disegni non è dichiarato).
   - IfcAlignment: rette e archi veri in pianta (IfcCompositeCurve +
     segmenti di progetto), livellette a pendenza costante fra i PVI
     (IfcGradientCurve). Curve madri canoniche (retta lungo +x) e la
     direzione nel placement del segmento. L'asse NON segue il sito: placement
     nell'origine del mondo e punti in coordinate assolute, perché c'è chi
     (il viewer) legge gli StartPoint come coordinate di mappa e ignora il
     placement — così torna in entrambi i casi.
   - Per ogni tratto: rivestimento = IfcCourse .PROTECTION., scavo =
     IfcEarthworksCut .CUT., riporto = IfcEarthworksFill .EMBANKMENT. (scelte
     dell'utente). Lo scavo è una sottrazione: lo schema vuole un elemento da
     forare (VoidsElements 1:1) → un IfcGeographicElement .TERRAIN. SENZA
     geometria ("terreno esistente": il DTM vero è il file dell'utente).
   - Geometria a mesh esplicita (IfcTriangulatedFaceSet), quantità nei Qto
     standard e progressive/sezione in un pset del tool.
   - Canale a U (inalveazione, 0.4 — scelte dell'utente): per tratto il canale
     = IfcPipeSegment .GUTTER. (U + muro di testa e dente del salto in fondo),
     magrone = IfcSlab .USERDEFINED. «Magrone», cuneo in misto cementato e
     rinterro = IfcEarthworksFill .BACKFILL. (materiali diversi), scavo come
     nel fosso. Il volume del canale sta nel pset (il Qto dei tubi non ha
     volumi): nei Qto la sezione lorda e netta.
   ------------------------------------------------------------------------- */
const B64 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$";
/** GlobalId IFC (22 caratteri) da 16 byte casuali, o da rnd(i) → byte nei test. */
export function ifcGuid(rnd = null) {
  const b = new Uint8Array(16);
  if (rnd) for (let i = 0; i < 16; i++) b[i] = rnd(i) & 255;
  else if (globalThis.crypto && globalThis.crypto.getRandomValues) globalThis.crypto.getRandomValues(b);
  else for (let i = 0; i < 16; i++) b[i] = Math.floor(Math.random() * 256);
  b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
  const chunk = (v, n) => { let s = ""; for (let i = n - 1; i >= 0; i--) s += B64[Math.floor(v / 64 ** i) % 64]; return s; };
  let out = chunk(b[0], 2);
  for (let i = 1; i < 16; i += 3) out += chunk((b[i] << 16) + (b[i + 1] << 8) + b[i + 2], 4);
  return out;
}
/** Stringa STEP: apici raddoppiati, barre raddoppiate, fuori dall'ASCII \X2\hhhh\X0\ (ISO 10303-21). */
export function stepStr(s) {
  let out = "";
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (ch === "'") out += "''";
    else if (ch === "\\") out += "\\\\";
    else if (c >= 32 && c <= 126) out += ch;
    else { let h = ""; for (const u of ch.split("")) h += u.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0"); out += "\\X2\\" + h + "\\X0\\"; }
  }
  return "'" + out + "'";
}
/** Reale STEP: punto sempre presente, niente zeri in coda, niente −0. */
export function stepReal(x, dec = 6) {
  if (!Number.isFinite(x)) x = 0;
  let s = x.toFixed(dec);
  if (s.indexOf(".") < 0) s += ".";
  s = s.replace(/(\.\d*?)0+$/, "$1");
  return s === "-0." ? "0." : s;
}

/**
 * job = {
 *   name (progetto), origin: { x, y } (E, N dell'IfcSite),
 *   works: [{ name, axis (planAxis), pvi [{ s, z }], section: { b, h, m, t, berm, cut, fill } (fosso)
 *               o { type: "channel", B, H, tw, ts, tm, om, se, cut, berm, fill, hw, key, wedge, ref } (canale),
 *             parts: [{ name, p0, p1, length, mesh: { lining, cut, fill (+ lean, mix) } (coordinate locali),
 *                       vol: { lining, cut, fill (+ lean, mix) }, drops? [{ dz }] }] }]
 *     — oppure un'opera sola coi campi axis, pvi, section, parts direttamente nel job (nome = name);
 *   labels: { … nomi dei pset/proprietà nella lingua della pagina },
 *   app: { name, version }, date (Date), guid?: () => stringa (test)
 * } → testo STEP. Un IFC unico per tutte le opere (scelta dell'utente): un
 * IfcAlignment per opera, i tratti col nome dell'opera davanti e la proprietà
 * «Opera» nel pset; tutti gli scavi forano lo stesso terreno.
 */
export function ifcDitch(job) {
  const L = [];
  let id = 0;
  const e = (s) => { L.push("#" + ++id + "=" + s + ";"); return "#" + id; };
  const G = () => "'" + (job.guid ? job.guid() : ifcGuid()) + "'";
  const R = (x, d = 6) => stepReal(x, d), S = stepStr, lb = job.labels || {};
  const O = job.origin || { x: 0, y: 0 };
  const date = job.date || new Date();
  const works = job.works || [{ name: job.name, axis: job.axis, pvi: job.pvi, section: job.section, parts: job.parts }];
  // --- progetto
  const org = e(`IFCORGANIZATION($,'viewifc.com',$,$,$)`);
  const pao = e(`IFCPERSONANDORGANIZATION(${e("IFCPERSON($,$,$,$,$,$,$,$)")},${org},$)`);
  const app = e(`IFCAPPLICATION(${org},${S(job.app.version)},${S(job.app.name)},'viewifc-profile-sweep')`);
  const oh = e(`IFCOWNERHISTORY(${pao},${app},$,.ADDED.,$,$,$,${Math.floor(date.getTime() / 1000)})`);
  const U = [e("IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)"), e("IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)"), e("IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)"), e("IFCSIUNIT(*,.PLANEANGLEUNIT.,$,.RADIAN.)")];
  const ua = e(`IFCUNITASSIGNMENT((${U.join(",")}))`);
  const o3 = e("IFCCARTESIANPOINT((0.,0.,0.))");
  const wcs = e(`IFCAXIS2PLACEMENT3D(${o3},${e("IFCDIRECTION((0.,0.,1.))")},${e("IFCDIRECTION((1.,0.,0.))")})`);
  const ctx = e(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,${wcs},$)`);
  const body = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Body','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const axisCtx = e(`IFCGEOMETRICREPRESENTATIONSUBCONTEXT('Axis','Model',*,*,*,*,${ctx},$,.MODEL_VIEW.,$)`);
  const proj = e(`IFCPROJECT(${G()},${oh},${S(job.name)},$,$,$,$,(${ctx}),${ua})`);
  const sitePl = e(`IFCLOCALPLACEMENT($,${e(`IFCAXIS2PLACEMENT3D(${e(`IFCCARTESIANPOINT((${R(O.x, 4)},${R(O.y, 4)},0.))`)},$,$)`)})`);
  const site = e(`IFCSITE(${G()},${oh},${S(lb.site || "Sito")},$,$,${sitePl},$,$,.ELEMENT.,$,$,0.,$,$)`);
  e(`IFCRELAGGREGATES(${G()},${oh},$,$,${proj},(${site}))`);
  const here = () => e(`IFCLOCALPLACEMENT(${sitePl},${e(`IFCAXIS2PLACEMENT3D(${o3},$,$)`)})`);
  const contained = [];

  // --- asse: IfcAlignment in coordinate ASSOLUTE (E, N), placement nell'origine del mondo:
  //     chi legge gli StartPoint come coordinate di mappa (il viewer) e chi applica il
  //     placement trovano lo stesso asse, sopra le mesh (relative al sito)
  const P2 = (x, y) => e(`IFCCARTESIANPOINT((${R(x)},${R(y)}))`);
  const D2 = (a) => e(`IFCDIRECTION((${R(Math.cos(a), 12)},${R(Math.sin(a), 12)}))`);
  const dirAt = (g, end) => (g.t === "L" ? Math.atan2(g.uy, g.ux) : g.a0 + (end ? g.sweep : 0) + Math.sign(g.sweep) * Math.PI / 2);
  for (const w of works) {
    const ax = w.axis;
    const alnPl = e(`IFCLOCALPLACEMENT($,${e(`IFCAXIS2PLACEMENT3D(${o3},$,$)`)})`);   // uno per asse
    const hCurve = [], hBiz = [];
    ax.segs.forEach((g, i) => {
      const next = ax.segs[i + 1];
      const kink = next ? Math.abs(Math.atan2(Math.sin(dirAt(next, false) - dirAt(g, true)), Math.cos(dirAt(next, false) - dirAt(g, true)))) : 0;
      const trans = !next ? ".DISCONTINUOUS." : kink < 1e-6 ? ".CONTSAMEGRADIENT." : ".CONTINUOUS.";       // polilinea con angoli: solo continuità di posizione
      if (g.t === "L") {
        const th = Math.atan2(g.uy, g.ux);
        const line = e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
        hCurve.push(e(`IFCCURVESEGMENT(${trans},${e(`IFCAXIS2PLACEMENT2D(${P2(g.x0, g.y0)},${D2(th)})`)},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(g.len)}),${line})`));
        hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2(g.x0, g.y0)},${R(th, 12)},0.,0.,${R(g.len)},$,.LINE.)`)})`));
      } else {
        const sgn = Math.sign(g.sweep), th = g.a0 + sgn * Math.PI / 2;           // tangente all'inizio dell'arco
        const circle = e(`IFCCIRCLE(${e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((0.,${R(sgn * g.r)}))`)},${e(`IFCDIRECTION((0.,${sgn > 0 ? "-1." : "1."}))`)})`)},${R(g.r)})`);
        hCurve.push(e(`IFCCURVESEGMENT(${trans},${e(`IFCAXIS2PLACEMENT2D(${P2(g.x0, g.y0)},${D2(th)})`)},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(sgn * g.len)}),${circle})`));
        hBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'H${i + 1}',$,$,$,$,${e(`IFCALIGNMENTHORIZONTALSEGMENT($,$,${P2(g.x0, g.y0)},${R(th, 12)},${R(sgn * g.r)},${R(sgn * g.r)},${R(g.len)},$,.CIRCULARARC.)`)})`));
      }
    });
    const comp = e(`IFCCOMPOSITECURVE((${hCurve.join(",")}),.F.)`);
    const reps = [e(`IFCSHAPEREPRESENTATION(${axisCtx},'FootPrint','Curve2D',(${comp}))`)];
    const pvi = w.pvi || [];
    const vCurve = [], vBiz = [];
    for (let i = 0; i + 1 < pvi.length; i++) {
      const a = pvi[i], b = pvi[i + 1], Lh = b.s - a.s;
      if (!(Lh > 0)) continue;
      const g = (b.z - a.z) / Lh, n = Math.hypot(1, g), last = i + 2 === pvi.length;
      const line = e(`IFCLINE(${e("IFCCARTESIANPOINT((0.,0.))")},${e(`IFCVECTOR(${e("IFCDIRECTION((1.,0.))")},1.)`)})`);
      const pl = e(`IFCAXIS2PLACEMENT2D(${e(`IFCCARTESIANPOINT((${R(a.s)},${R(a.z)}))`)},${e(`IFCDIRECTION((${R(1 / n, 12)},${R(g / n, 12)}))`)})`);
      vCurve.push(e(`IFCCURVESEGMENT(${last ? ".DISCONTINUOUS." : ".CONTINUOUS."},${pl},IFCLENGTHMEASURE(0.),IFCLENGTHMEASURE(${R(Lh * n)}),${line})`));
      vBiz.push(e(`IFCALIGNMENTSEGMENT(${G()},${oh},'V${i + 1}',$,$,$,$,${e(`IFCALIGNMENTVERTICALSEGMENT($,$,${R(a.s)},${R(Lh)},${R(a.z)},${R(g, 9)},${R(g, 9)},$,.CONSTANTGRADIENT.)`)})`));
    }
    if (vCurve.length) reps.push(e(`IFCSHAPEREPRESENTATION(${axisCtx},'Axis','Curve3D',(${e(`IFCGRADIENTCURVE((${vCurve.join(",")}),.F.,${comp},$)`)}))`));
    const align = e(`IFCALIGNMENT(${G()},${oh},${S(w.name)},$,$,${alnPl},${e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${reps.join(",")}))`)},$)`);
    const hor = e(`IFCALIGNMENTHORIZONTAL(${G()},${oh},$,$,$,$,$)`);
    e(`IFCRELNESTS(${G()},${oh},$,$,${hor},(${hBiz.join(",")}))`);
    const nested = [hor];
    if (vBiz.length) { const ver = e(`IFCALIGNMENTVERTICAL(${G()},${oh},$,$,$,$,$)`); e(`IFCRELNESTS(${G()},${oh},$,$,${ver},(${vBiz.join(",")}))`); nested.push(ver); }
    e(`IFCRELNESTS(${G()},${oh},$,$,${align},(${nested.join(",")}))`);
    contained.push(align);
  }

  // --- stili, materiale, terreno da forare
  const style = (rgb, name, tr = 0) => {
    const c = e(`IFCCOLOURRGB($,${R(rgb[0], 3)},${R(rgb[1], 3)},${R(rgb[2], 3)})`);
    return e(`IFCSURFACESTYLE(${S(name)},.BOTH.,(${e(`IFCSURFACESTYLESHADING(${c},${R(tr, 2)})`)}))`);
  };
  const stLin = style([0.72, 0.72, 0.7], lb.lining || "cls"), stCut = style([0.66, 0.5, 0.33], lb.cut || "scavo", 0.5), stFill = style([0.55, 0.62, 0.4], lb.fill || "riporto", 0.4);
  const anyCh = works.some((w) => w.section && w.section.type === "channel");
  const stLean = anyCh ? style([0.84, 0.84, 0.8], lb.lean || "magrone") : null, stMix = anyCh ? style([0.62, 0.58, 0.5], lb.mix || "misto cementato") : null;
  const stBack = anyCh ? style([0.78, 0.68, 0.48], lb.backfill || "rinterro", 0.4) : null;
  const terrain = e(`IFCGEOGRAPHICELEMENT(${G()},${oh},${S(lb.terrain || "Terreno esistente")},$,$,${here()},$,$,.TERRAIN.)`);
  contained.push(terrain);
  const shape = (m, st) => {
    const n = m.positions.length / 3, pts = new Array(n), idx = new Array(m.index.length / 3);
    for (let i = 0; i < n; i++) pts[i] = `(${R(m.positions[3 * i], 4)},${R(m.positions[3 * i + 1], 4)},${R(m.positions[3 * i + 2], 4)})`;
    for (let t = 0; t < m.index.length; t += 3) idx[t / 3] = `(${m.index[t] + 1},${m.index[t + 1] + 1},${m.index[t + 2] + 1})`;
    const item = e(`IFCTRIANGULATEDFACESET(${e(`IFCCARTESIANPOINTLIST3D((${pts.join(",")}),$)`)},$,.T.,(${idx.join(",")}),$)`);
    e(`IFCSTYLEDITEM(${item},(${st}),$)`);
    return e(`IFCPRODUCTDEFINITIONSHAPE($,$,(${e(`IFCSHAPEREPRESENTATION(${body},'Body','Tessellation',(${item}))`)}))`);
  };
  const props = (target, name, list) => {
    const ps = list.map(([n, v]) => e(`IFCPROPERTYSINGLEVALUE(${S(n)},$,${v},$)`));
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${target}),${e(`IFCPROPERTYSET(${G()},${oh},${S(name)},$,(${ps.join(",")}))`)})`);
  };
  const qto = (target, name, list) => {
    const qs = list.map(([t, n, v]) => e(`${t}(${S(n)},$,$,${R(v, 4)},$)`));
    e(`IFCRELDEFINESBYPROPERTIES(${G()},${oh},$,$,(${target}),${e(`IFCELEMENTQUANTITY(${G()},${oh},${S(name)},$,$,(${qs.join(",")}))`)})`);
  };
  const concrete = e(`IFCMATERIAL(${S(lb.concrete || "Calcestruzzo")},$,'Concrete')`);
  const len = (v) => `IFCLENGTHMEASURE(${R(v, 4)})`, rat = (v) => `IFCPOSITIVERATIOMEASURE(${R(v, 4)})`;
  const courses = [], pipes = [], slabs = [], mixes = [], backs = [];
  const psName = lb.pset || "ViewIFC_SviluppoProfili";
  for (const w of works) for (const part0 of w.parts) {
    const sec = w.section, part = { ...part0, name: (w.name ? w.name + " - " : "") + part0.name };
    const common = [[lb.work || "Opera", `IFCLABEL(${S(w.name || "")})`], [lb.p0 || "Progressiva iniziale", len(part.p0)], [lb.p1 || "Progressiva finale", len(part.p1)], [lb.length || "Lunghezza", len(part.length)]];
    if (sec.type === "channel") {
      // canale a U: tubo «gutter» (U + muro di testa), magrone, cuneo, scavo, rinterro
      const refName = sec.ref === "top" ? lb.refTop || "Cielo" : sec.ref === "base" ? lb.refBase || "Piano di posa" : lb.refInvert || "Fondo interno";
      const secProps = [[lb.section || "Sezione", `IFCLABEL(${S(lb.channelName || "Canale a U")})`], [lb.B || "Larghezza interna", len(sec.B)], [lb.H || "Altezza interna", len(sec.H)],
        [lb.tw || "Spessore pareti", len(sec.tw)], [lb.ts || "Spessore soletta", len(sec.ts)], [lb.tm || "Spessore magrone", len(sec.tm)], [lb.berm || "Banchina", len(sec.berm)],
        [lb.cutSlope || "Scarpa in sterro", rat(sec.cut)], [lb.backSlope || "Scarpa del rinterro", rat(sec.fill)], [lb.hw || "Muro di testa", len(sec.hw)], [lb.key || "Dente", len(sec.key)],
        [lb.ref || "Linea del profilo", `IFCLABEL(${S(refName)})`]];
      const drops = (part.drops || []).map((d) => [lb.drop || "Salto", len(d.dz)]).slice(0, 1);
      const gross = (sec.B + 2 * sec.tw) * (sec.H + sec.ts);
      const p = e(`IFCPIPESEGMENT(${G()},${oh},${S(part.name + " - " + (lb.channel || "canale"))},$,$,${here()},${shape(part.mesh.lining, stLin)},$,.GUTTER.)`);
      pipes.push(p); contained.push(p);
      props(p, psName, [...common, ...secProps, ...drops, [lb.volume || "Volume calcestruzzo", `IFCVOLUMEMEASURE(${R(part.vol.lining, 4)})`]]);
      qto(p, "Qto_PipeSegmentBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYAREA", "GrossCrossSectionArea", gross], ["IFCQUANTITYAREA", "NetCrossSectionArea", gross - sec.B * sec.H]]);
      if (part.mesh.lean && part.mesh.lean.index.length) {
        const s = e(`IFCSLAB(${G()},${oh},${S(part.name + " - " + (lb.lean || "magrone"))},$,${S(lb.leanType || "Magrone")},${here()},${shape(part.mesh.lean, stLean)},$,.USERDEFINED.)`);
        slabs.push(s); contained.push(s);
        props(s, psName, common);
        qto(s, "Qto_SlabBaseQuantities", [["IFCQUANTITYLENGTH", "Width", sec.tm], ["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "NetVolume", part.vol.lean]]);
      }
      if (part.vol.mix > 0.01 && part.mesh.mix && part.mesh.mix.index.length) {
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.mix || "misto cementato"))},$,$,${here()},${shape(part.mesh.mix, stMix)},$,.BACKFILL.)`);
        mixes.push(f); contained.push(f);
        props(f, psName, common);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.mix]]);
      }
      if (part.vol.cut > 0.01 && part.mesh.cut.index.length) {
        const k = e(`IFCEARTHWORKSCUT(${G()},${oh},${S(part.name + " - " + (lb.cut || "scavo"))},$,$,${here()},${shape(part.mesh.cut, stCut)},$,.CUT.)`);
        e(`IFCRELVOIDSELEMENT(${G()},${oh},$,$,${terrain},${k})`);
        props(k, psName, common);
        qto(k, "Qto_EarthworksCutBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "UndisturbedVolume", part.vol.cut]]);
      }
      if (part.vol.fill > 0.01 && part.mesh.fill.index.length) {
        const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.backfill || "rinterro"))},$,$,${here()},${shape(part.mesh.fill, stBack)},$,.BACKFILL.)`);
        backs.push(f); contained.push(f);
        props(f, psName, common);
        qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.fill]]);
      }
      continue;
    }
    const secProps = [[lb.section || "Sezione", `IFCLABEL(${S(lb.sectionName || "Fosso trapezio")})`], [lb.b || "Fondo", len(sec.b)], [lb.h || "Altezza", len(sec.h)], [lb.m || "Scarpa sponde", rat(sec.m)], [lb.t || "Spessore rivestimento", len(sec.t)], [lb.berm || "Banchina", len(sec.berm)], [lb.cutSlope || "Scarpa in sterro", rat(sec.cut)], [lb.fillSlope || "Scarpa in riporto", rat(sec.fill)]];
    const c = e(`IFCCOURSE(${G()},${oh},${S(part.name + " - " + (lb.lining || "rivestimento"))},$,$,${here()},${shape(part.mesh.lining, stLin)},$,.PROTECTION.)`);
    courses.push(c); contained.push(c);
    props(c, psName, [...common, ...secProps]);
    qto(c, "Qto_CourseBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYLENGTH", "Thickness", sec.t], ["IFCQUANTITYVOLUME", "Volume", part.vol.lining]]);
    if (part.vol.cut > 0.01 && part.mesh.cut.index.length) {
      const k = e(`IFCEARTHWORKSCUT(${G()},${oh},${S(part.name + " - " + (lb.cut || "scavo"))},$,$,${here()},${shape(part.mesh.cut, stCut)},$,.CUT.)`);
      e(`IFCRELVOIDSELEMENT(${G()},${oh},$,$,${terrain},${k})`);
      props(k, psName, common);
      qto(k, "Qto_EarthworksCutBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "UndisturbedVolume", part.vol.cut]]);
    }
    if (part.vol.fill > 0.01 && part.mesh.fill.index.length) {                // sotto i 10 litri non è un riporto
      const f = e(`IFCEARTHWORKSFILL(${G()},${oh},${S(part.name + " - " + (lb.fill || "riporto"))},$,$,${here()},${shape(part.mesh.fill, stFill)},$,.EMBANKMENT.)`);
      contained.push(f);
      props(f, psName, common);
      qto(f, "Qto_EarthworksFillBaseQuantities", [["IFCQUANTITYLENGTH", "Length", part.length], ["IFCQUANTITYVOLUME", "CompactedVolume", part.vol.fill]]);
    }
  }
  if (courses.length || pipes.length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${[...courses, ...pipes].join(",")}),${concrete})`);
  const mat = (list, name, cat) => { if (list.length) e(`IFCRELASSOCIATESMATERIAL(${G()},${oh},$,$,(${list.join(",")}),${e(`IFCMATERIAL(${S(name)},$,${S(cat)})`)})`); };
  mat(slabs, lb.leanMat || "Calcestruzzo magro", "Concrete");
  mat(mixes, lb.mixMat || "Misto cementato", "Soil");
  mat(backs, lb.backMat || "Materiale per rilevato stradale", "Soil");
  e(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${G()},${oh},$,$,(${contained.join(",")}),${site})`);

  const iso = date.toISOString().slice(0, 19);
  return [
    "ISO-10303-21;", "HEADER;",
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${S((job.fileName || job.name) + ".ifc")},'${iso}',(''),('viewifc.com'),${S(job.app.name + " " + job.app.version)},'viewifc.com','');`,
    "FILE_SCHEMA(('IFC4X3_ADD2'));", "ENDSEC;", "DATA;", ...L, "ENDSEC;", "END-ISO-10303-21;", "",
  ].join("\n");
}

/**
 * Computo per tratto in CSV (separatore ;, decimali con la virgola o col punto).
 * work: true → prima colonna = opera (p.work), come nell'IFC unico di più opere.
 * cols = volumi in colonna, nell'ordine (fosso: cls, scavo, riporto; canale:
 * cls, magrone, misto cementato, scavo, rinterro); quelli che un tratto non ha valgono 0.
 */
export function ditchCSV(parts, { head, total = "TOTALE", comma = true, work = false, cols = ["lining", "cut", "fill"] } = {}) {
  const n = (v, d) => { const s = (v || 0).toFixed(d); return comma ? s.replace(".", ",") : s; };
  const q = (s) => (/[;"\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : String(s));
  const rows = [head.map(q).join(";")];
  const tot = { length: 0 };
  for (const k of cols) tot[k] = 0;
  const pre = (v) => (work ? [v] : []);
  for (const p of parts) {
    rows.push([...pre(q(p.work || "")), q(p.name), n(p.p0, 3), n(p.p1, 3), n(p.length, 3), ...cols.map((k) => n(p.vol[k], 3))].join(";"));
    tot.length += p.length;
    for (const k of cols) tot[k] += p.vol[k] || 0;
  }
  if (parts.length > 1) rows.push([...pre(q(total)), work ? "" : q(total), "", "", n(tot.length, 3), ...cols.map((k) => n(tot[k], 3))].join(";"));
  return "﻿" + rows.join("\r\n") + "\r\n";
}
