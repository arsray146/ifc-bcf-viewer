/* terrain-io.js — import del Terrain Sculptor: dai file di terreno alla griglia
   Modulo PURO (niente DOM, niente import), come terrain-core.js: gira nel
   browser e in Node (test/test_terrain_io.js). Delaunator arriva iniettato.

   Ogni sorgente diventa una di due forme:
   - TIN    { kind:"tin", points: Float64Array [x,y,z…], faces: Uint32Array }
            (LandXML, oppure punti x,y,z triangolati con Delaunay)
   - raster { kind:"raster", W, H, x0, y0, dx, dy, z }  — nodi sui CENTRI
            dei pixel, riga 0 = SUD, NaN = senza dato
            (GeoTIFF, ESRI ASCII Grid, griglia del tool Contesto 3D)
   e buildGrid la porta sulla griglia del documento al passo scelto: maschera
   (1 = dato vero) e buchi riempiti in continuità (push-pull), perché lo
   scultore lavora su un rettangolo pieno. Le coordinate restano quelle del
   file (UTM…): l'origine locale si sceglie dopo, all'esportazione.
*/

/* ======================================================================
   LandXML 1.x — superficie TIN (<Pnts><P id>N E Z</P>, <Faces><F>a b c</F>)
   <P> è «nord est quota» come da schema (Civil 3D e il tool Contesto 3D lo
   scrivono così). <F i="1"> = faccia invisibile (fuori dal contorno): salta.
   ====================================================================== */
const FEET = { foot: 0.3048, USSurveyFoot: 1200 / 3937, intlFoot: 0.3048 };

export function parseLandXML(text) {
  const attr = (tag, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag); return m ? m[1] : null; };
  let scale = 1;
  const imp = /<Imperial\b[^>]*>/.exec(text);
  if (imp) scale = FEET[attr(imp[0], "linearUnit")] || 0.3048;
  const cs = /<CoordinateSystem\b[^>]*>/.exec(text);
  const crs = cs ? { epsg: +attr(cs[0], "epsgCode") || null, name: attr(cs[0], "name") || attr(cs[0], "desc") || null, vertical: attr(cs[0], "verticalDatum") } : null;
  /* la superficie col maggior numero di facce */
  const surfaces = [];
  const reS = /<Surface\b([^>]*)>([\s\S]*?)<\/Surface>/g;
  for (let m; (m = reS.exec(text));) surfaces.push({ head: m[1], body: m[2] });
  if (!surfaces.length) throw new Error("nessuna <Surface> nel LandXML");
  let best = null;
  for (const s of surfaces) {
    let nf = 0;
    for (let p = s.body.indexOf("<F"); p >= 0; p = s.body.indexOf("<F", p + 2)) if (s.body[p + 2] === ">" || s.body[p + 2] === " ") nf++;
    if (!best || nf > best.nf) best = { ...s, nf };
  }
  if (!best.nf) throw new Error("la superficie del LandXML non ha facce (<Faces>)");
  const ids = new Map(), P = [];
  const reP = /<P\b([^>]*)>([^<]*)<\/P>/g;
  const pnts = /<Pnts>([\s\S]*?)<\/Pnts>/.exec(best.body);
  if (!pnts) throw new Error("la superficie del LandXML non ha punti (<Pnts>)");
  for (let m; (m = reP.exec(pnts[1]));) {
    const id = attr(m[1], "id"), v = m[2].trim().split(/\s+/).map(Number);
    if (id === null || v.length < 3 || !v.slice(0, 3).every(Number.isFinite)) continue;
    ids.set(id, P.length / 3);
    P.push(v[1] * scale, v[0] * scale, v[2] * scale);       // N E Z → x = E, y = N
  }
  const F = [];
  const faces = /<Faces>([\s\S]*?)<\/Faces>/.exec(best.body);
  const reF = /<F\b([^>]*)>([^<]*)<\/F>/g;
  let hidden = 0;
  for (let m; (m = reF.exec(faces ? faces[1] : ""));) {
    if (/\bi="1"/.test(m[1])) { hidden++; continue; }
    const t = m[2].trim().split(/\s+/).map(s => ids.get(s));
    if (t.length >= 3 && t[0] !== undefined && t[1] !== undefined && t[2] !== undefined) F.push(t[0], t[1], t[2]);
  }
  if (!F.length) throw new Error("nessuna faccia valida nel LandXML");
  const name = attr(best.head, "name");
  return { kind: "tin", name, crs, unitScale: scale, hiddenFaces: hidden, points: Float64Array.from(P), faces: Uint32Array.from(F) };
}

/* ======================================================================
   ESRI ASCII Grid (.asc): intestazione + righe dall'alto (nord) in basso
   ====================================================================== */
export function parseASC(text) {
  const head = {};
  let pos = 0;
  for (let line = 0; line < 8; line++) {
    const end = text.indexOf("\n", pos), s = text.slice(pos, end < 0 ? text.length : end).trim();
    const m = /^([A-Za-z_]+)\s+([-+0-9.eE]+)$/.exec(s);
    if (!m) break;
    head[m[1].toLowerCase()] = +m[2];
    pos = end < 0 ? text.length : end + 1;
  }
  const W = head.ncols, H = head.nrows, d = head.cellsize ?? head.dx, dy = head.dy ?? d;
  if (!(W > 1 && H > 1 && d > 0)) throw new Error("intestazione .asc non valida (servono ncols, nrows, cellsize)");
  const xc = head.xllcenter ?? (head.xllcorner + d / 2), yc = head.yllcenter ?? (head.yllcorner + dy / 2);
  if (!Number.isFinite(xc) || !Number.isFinite(yc)) throw new Error("intestazione .asc senza xllcorner/xllcenter");
  const nodata = head.nodata_value;
  const z = new Float32Array(W * H);
  let k = 0, i = pos;
  const L = text.length;
  while (k < W * H && i < L) {
    let c = text.charCodeAt(i);
    while (i < L && (c === 32 || c === 10 || c === 13 || c === 9)) c = text.charCodeAt(++i);
    if (i >= L) break;
    const a = i;
    while (i < L && !(c === 32 || c === 10 || c === 13 || c === 9)) c = text.charCodeAt(++i);
    const v = +text.slice(a, i), r = Math.floor(k / W), col = k % W;
    z[(H - 1 - r) * W + col] = v === nodata || !Number.isFinite(v) ? NaN : v;
    k++;
  }
  if (k < W * H) throw new Error(`.asc troncato: ${k} valori su ${W * H}`);
  return { kind: "raster", W, H, x0: xc, y0: yc, dx: d, dy, z };
}

/* ======================================================================
   GeoTIFF minimo — COPIATO dal tool Contesto 3D (ctxTiffIfds / ctxLzw /
   ctxTiffDecode, tools/ifc-site-context/index.html), identico bit per bit a
   libtiff/PIL sui file veri di test/site_context_dtm/. Una banda, strisce o
   tile, nessuna compressione / LZW / deflate, predittori 1-2-3, interi e
   float, II e MM. Se si corregge lì, si corregge qui.
   ====================================================================== */
export function tiffIfds(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const le = u8[0] === 0x49;
  if (!((u8[0] === 0x49 && u8[1] === 0x49) || (u8[0] === 0x4d && u8[1] === 0x4d)) || dv.getUint16(2, le) !== 42) throw new Error("non è un TIFF (BigTIFF escluso)");
  const TS = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };
  const out = [];
  let ifd = dv.getUint32(4, le), guard = 0;
  while (ifd && ifd + 2 <= u8.length && guard++ < 64) {
    const n = dv.getUint16(ifd, le), tags = {};
    for (let i = 0; i < n; i++) {
      const o = ifd + 2 + i * 12, tag = dv.getUint16(o, le), type = dv.getUint16(o + 2, le), cnt = dv.getUint32(o + 4, le);
      const at = (TS[type] || 1) * cnt <= 4 ? o + 8 : dv.getUint32(o + 8, le);
      if (at + (TS[type] || 1) * cnt > u8.length) continue;
      if (type === 2) { tags[tag] = new TextDecoder().decode(u8.subarray(at, at + cnt)).replace(/\0+$/, ""); continue; }
      const a = new Array(cnt);
      for (let k = 0; k < cnt; k++) {
        a[k] = type === 3 ? dv.getUint16(at + 2 * k, le) : type === 4 ? dv.getUint32(at + 4 * k, le) : type === 8 ? dv.getInt16(at + 2 * k, le)
          : type === 9 ? dv.getInt32(at + 4 * k, le) : type === 11 ? dv.getFloat32(at + 4 * k, le) : type === 12 ? dv.getFloat64(at + 8 * k, le)
          : type === 16 ? Number(dv.getBigUint64(at + 8 * k, le)) : type === 5 ? dv.getUint32(at + 8 * k, le) / (dv.getUint32(at + 8 * k + 4, le) || 1) : u8[at + k];
      }
      tags[tag] = a;
    }
    out.push({ le, tags });
    ifd = dv.getUint32(ifd + 2 + n * 12, le);
  }
  for (const d of out) {
    const T = d.tags, g = (t, def) => (T[t] ? T[t][0] : def);
    d.W = g(256); d.H = g(257); d.bits = g(258, 1); d.comp = g(259, 1); d.pred = g(317, 1); d.fmt = g(339, 1); d.spp = g(277, 1);
    d.tiled = !!T[322]; d.tw = d.tiled ? g(322) : d.W; d.th = d.tiled ? g(323) : Math.min(d.H, g(278, d.H));
    d.offs = T[d.tiled ? 324 : 273] || []; d.cnts = T[d.tiled ? 325 : 279] || [];
    d.nodata = typeof T[42113] === "string" && T[42113].trim() !== "" ? parseFloat(T[42113]) : null;
  }
  const T0 = out.length ? out[0].tags : {};
  const mt = T0[34264];
  if ((T0[33550] && T0[33922]) || (mt && mt.length >= 8 && !mt[1] && !mt[4])) {
    const sx = mt ? mt[0] : T0[33550][0], sy = mt ? -mt[5] : T0[33550][1];
    const tp = mt ? [0, 0, 0, mt[3], mt[7]] : T0[33922];
    let x0 = tp[3] - tp[0] * sx, y0 = tp[4] + tp[1] * sy, epsg = null, point = false;
    const gk = T0[34735];
    if (gk) for (let k = 4; k + 3 < gk.length; k += 4) {
      if (gk[k] === 3072 && gk[k + 1] === 0) epsg = gk[k + 3];
      if (gk[k] === 2048 && gk[k + 1] === 0 && !epsg) epsg = gk[k + 3];
      if (gk[k] === 1025 && gk[k + 1] === 0 && gk[k + 3] === 2) point = true;
    }
    if (point) { x0 -= sx / 2; y0 += sy / 2; }
    for (const d of out) { const f = out[0].W / d.W; d.geo = { x0, y0, dx: sx * f, dy: sy * (out[0].H / d.H), epsg }; }
  }
  return out;
}
export function lzw(src, size) {
  const out = new Uint8Array(size), prefix = new Int32Array(4096), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { suffix[i] = i; first[i] = i; len[i] = 1; prefix[i] = -1; }
  let op = 0, bit = 0, width = 9, next = 258, old = -1;
  const nbits = src.length * 8;
  const emit = (c) => {
    const l = len[c];
    if (op + l > size) { let k = c, p = op + l - 1; while (k >= 0) { if (p < size) out[p] = suffix[k]; p--; k = prefix[k]; } op = size; return; }
    let k = c, p = op + l - 1;
    while (k >= 0) { out[p--] = suffix[k]; k = prefix[k]; }
    op += l;
  };
  while (bit + width <= nbits && op < size) {
    let code = 0;
    for (let b = 0; b < width; b++) { const i = bit + b; code = (code << 1) | ((src[i >> 3] >> (7 - (i & 7))) & 1); }
    bit += width;
    if (code === 257) break;
    if (code === 256) { width = 9; next = 258; old = -1; continue; }
    if (old < 0) { emit(code); old = code; continue; }
    const fc = code < next ? first[code] : first[old];
    if (next < 4096) { prefix[next] = old; suffix[next] = fc; first[next] = first[old]; len[next] = len[old] + 1; next++; }
    emit(code);
    old = code;
    if (next >= (1 << width) - 1 && width < 12) width++;
  }
  return out;
}
export async function tiffDecode(d, data, base = 0) {
  if (d.spp !== 1) throw new Error("TIFF a più bande non supportato");
  if (![1, 5, 8, 32946].includes(d.comp)) throw new Error("compressione TIFF " + d.comp + " non supportata");
  const W = d.W, H = d.H, bps = d.bits / 8, le = d.le, out = new Float32Array(W * H).fill(NaN);
  const across = Math.ceil(W / d.tw);
  for (let k = 0; k < d.offs.length; k++) {
    const rows = d.tiled ? d.th : Math.min(d.th, H - k * d.th);
    if (rows <= 0) continue;
    const need = d.tw * rows * bps;
    let raw = data.subarray(d.offs[k] - base, d.offs[k] - base + d.cnts[k]);
    if (d.comp === 5) raw = lzw(raw, need);
    else if (d.comp === 8 || d.comp === 32946) raw = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate"))).arrayBuffer());
    else raw = Uint8Array.from(raw);
    let rle = le;
    const rb = d.tw * bps;
    if (d.pred === 3) {
      const tmp = new Uint8Array(rb);
      for (let r = 0; r < rows; r++) {
        const row = raw.subarray(r * rb, (r + 1) * rb);
        for (let i = 1; i < rb; i++) row[i] = (row[i] + row[i - 1]) & 255;
        tmp.set(row);
        for (let c = 0; c < d.tw; c++) for (let j = 0; j < bps; j++) row[c * bps + j] = tmp[j * d.tw + c];
      }
      rle = false;
    } else if (d.pred === 2) {
      const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
      for (let r = 0; r < rows; r++) for (let c = 1; c < d.tw; c++) {
        const o = r * rb + c * bps;
        if (bps === 1) raw[o] = (raw[o] + raw[o - 1]) & 255;
        else if (bps === 2) v.setUint16(o, (v.getUint16(o, le) + v.getUint16(o - 2, le)) & 0xffff, le);
        else if (bps === 4) v.setUint32(o, (v.getUint32(o, le) + v.getUint32(o - 4, le)) >>> 0, le);
      }
    }
    const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const rd = d.fmt === 3 ? (bps === 8 ? (o) => v.getFloat64(o, rle) : (o) => v.getFloat32(o, rle))
      : d.fmt === 2 ? (bps === 1 ? (o) => v.getInt8(o) : bps === 2 ? (o) => v.getInt16(o, rle) : (o) => v.getInt32(o, rle))
      : bps === 1 ? (o) => v.getUint8(o) : bps === 2 ? (o) => v.getUint16(o, rle) : (o) => v.getUint32(o, rle);
    const tx = d.tiled ? (k % across) * d.tw : 0, ty = d.tiled ? Math.floor(k / across) * d.th : k * d.th;
    for (let r = 0; r < rows; r++) {
      const y = ty + r; if (y >= H) break;
      for (let c = 0; c < d.tw; c++) {
        const x = tx + c; if (x >= W) break;
        const o = (r * d.tw + c) * bps;
        if (o + bps > raw.length) break;
        const z = rd(o);
        out[y * W + x] = (d.nodata !== null && z === d.nodata) || !(z > -1000 && z < 9000) ? NaN : z;
      }
    }
  }
  return out;
}

/* GeoTIFF → raster coi nodi sui centri dei pixel, riga 0 = sud */
export async function readGeoTIFF(u8) {
  const d = tiffIfds(u8)[0];
  if (!d) throw new Error("TIFF senza immagini");
  if (!d.geo) throw new Error("TIFF senza georeferenziazione (servono i tag GeoTIFF)");
  const data = await tiffDecode(d, u8, 0);
  const { x0, y0, dx, dy, epsg } = d.geo;
  return { ...rasterNorthUp(data, d.W, d.H, x0 + dx / 2, y0 - dy / 2, dx, dy), crs: epsg ? { epsg, name: null } : null };
}

/* raster con la riga 0 a NORD (GeoTIFF, .asc, tool Contesto 3D) → riga 0 a sud.
   xLeft/yTop = coordinate del CENTRO del primo pixel in alto a sinistra. */
export function rasterNorthUp(data, W, H, xLeft, yTop, dx, dy = dx) {
  const z = new Float32Array(W * H);
  for (let r = 0; r < H; r++) z.set(data.subarray(r * W, (r + 1) * W), (H - 1 - r) * W);
  return { kind: "raster", W, H, x0: xLeft, y0: yTop - (H - 1) * dy, dx, dy, z };
}

/* ======================================================================
   Punti x,y,z da testo (CSV, TXT, XYZ: virgola, punto e virgola, tab o
   spazi; con «;» la virgola può essere il decimale). Una colonna iniziale
   intera progressiva (numero di punto) si salta. Righe senza 3 numeri: via.
   ====================================================================== */
export function parsePoints(text) {
  const lines = text.split(/\r?\n/);
  const sample = lines.slice(0, 50).filter(l => l.trim());
  const semi = sample.filter(l => l.includes(";")).length > sample.length / 2;
  const rows = [];
  let skipped = 0;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    const toks = (semi ? l.split(";") : l.split(/[,\t ]+/)).map(s => s.trim()).filter(Boolean);
    const nums = toks.map(s => +(semi ? s.replace(",", ".") : s)).filter(Number.isFinite);
    if (nums.length < 3) { skipped++; continue; }
    rows.push(nums);
  }
  if (rows.length < 3) throw new Error("servono almeno 3 punti x,y,z");
  /* colonna iniziale = numero di punto? (intera, progressiva, con almeno 4 numeri per riga) */
  const four = rows.filter(r => r.length >= 4).length > rows.length * 0.9;
  let idCol = false;
  if (four) {
    let prog = 0;
    for (let r = 1; r < rows.length; r++) if (Number.isInteger(rows[r][0]) && rows[r][0] > rows[r - 1][0]) prog++;
    idCol = prog > (rows.length - 1) * 0.9;
  }
  const P = new Float64Array(rows.length * 3);
  rows.forEach((r, k) => { const o = idCol ? 1 : 0; P[3 * k] = r[o]; P[3 * k + 1] = r[o + 1]; P[3 * k + 2] = r[o + 2]; });
  return { points: P, count: rows.length, skipped, idColumn: idCol };
}

/* Delaunay dei punti (Delaunator iniettato), coordinate centrate per la precisione;
   via i punti doppi in pianta (stessa x,y): Delaunator li ignorerebbe comunque */
export function triangulate(points, Delaunator) {
  const n = points.length / 3;
  let cx = 0, cy = 0;
  for (let k = 0; k < n; k++) { cx += points[3 * k]; cy += points[3 * k + 1]; }
  cx /= n; cy /= n;
  const xy = new Float64Array(2 * n);
  for (let k = 0; k < n; k++) { xy[2 * k] = points[3 * k] - cx; xy[2 * k + 1] = points[3 * k + 1] - cy; }
  const d = new Delaunator(xy);
  if (!d.triangles.length) throw new Error("i punti sono allineati: niente superficie");
  return { kind: "tin", points, faces: Uint32Array.from(d.triangles) };
}

/* ======================================================================
   IFC — la toposolid di Revit (fase 2, «da Revit e ritorno»)
   Visto su due export veri di Revit 2025 (IFC4X3_ADD2, 2 ottobre 2026): la
   toposolid è un IfcGeographicElement .TERRAIN. con un IfcFacetedBrep chiuso
   (fondo piano, fianchi verticali solo sul contorno, sopra i triangoli). La
   geometria è identica nei due modi d'esportazione; cambia dove Revit scrive
   la georeferenziazione:
   - CoordinateBase «Shared Coordinates»: nel placement dell'IfcSite (E, N, H
     e rotazione) — web-ifc lo applica, la mesh esce già in coordinate di mappa;
   - CoordinateBase «Internal Origin»: nel WorldCoordinateSystem del contesto
     (E, N, H) col TrueNorth per la rotazione — web-ifc lo ignora, la mesh
     esce in coordinate interne.
   Lo scultore lavora nelle coordinate del SITO, che in tutti e due i modi
   sono quelle dell'origine interna di Revit: il CSV torna a Revit e cade
   sopra la toposolid di partenza senza origini da impostare. Il sistema di
   mappa resta nel documento come frame { E, N, H, c, s, k }:
   mappa = (E + k(c·x − s·y), N + k(s·x + c·y), H + k·z).
   L'api ha la forma di web-ifc (GetLine/GetLineIDsWithType/StreamMeshes): nel
   tool è web-ifc vero in un Worker, nei test un'api finta.
   ====================================================================== */
/* intestazione STEP: Revit scrive la base delle coordinate nel FILE_DESCRIPTION
   ('CoordinateReference [CoordinateBase: Internal Origin, ProjectSite: MN95]') */
export function ifcHeader(text) {
  const head = String(text).slice(0, 65536);
  const desc = (/FILE_DESCRIPTION\s*\(([\s\S]*?)\)\s*;/.exec(head) || [, ""])[1];
  const cb = /CoordinateBase:\s*([^,\]']+)/i.exec(desc), ps = /ProjectSite:\s*([^,\]']+)/i.exec(desc);
  const b = cb ? cb[1].trim() : "";
  const base = !b ? null : /internal/i.test(b) ? "internal" : /shared|survey/i.test(b) ? "shared" : /project/i.test(b) ? "pbp" : "other";
  const fn = /FILE_NAME\s*\(([\s\S]*?)\)\s*;/.exec(head);
  const app = fn ? ((fn[1].match(/'([^']*)'/g) || []).map(s => s.slice(1, -1)).find(s => /revit|archicad|civil|tekla|allplan|bentley|vectorworks|rhino/i.test(s)) || "") : "";
  const sch = /FILE_SCHEMA\s*\(\s*\(\s*'([^']+)'/i.exec(head);
  return { base, baseText: b, site: ps ? ps[1].trim() : null, app, schema: sch ? sch[1] : "" };
}

/* trasformazioni rigide 3×4 per righe: p' = R·p + t, [r00 r01 r02 tx, r10 … ty, r20 … tz] */
const M_ID = () => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];
export function mMul(A, B) {
  const R = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) R[4 * r + c] = A[4 * r] * B[c] + A[4 * r + 1] * B[4 + c] + A[4 * r + 2] * B[8 + c];
    R[4 * r + 3] = A[4 * r] * B[3] + A[4 * r + 1] * B[7] + A[4 * r + 2] * B[11] + A[4 * r + 3];
  }
  return R;
}
export function mInvRigid(A) {
  const R = [A[0], A[4], A[8], 0, A[1], A[5], A[9], 0, A[2], A[6], A[10], 0];
  for (let r = 0; r < 3; r++) R[4 * r + 3] = -(R[4 * r] * A[3] + R[4 * r + 1] * A[7] + R[4 * r + 2] * A[11]);
  return R;
}
export const mApply = (A, x, y, z) => [A[0] * x + A[1] * y + A[2] * z + A[3], A[4] * x + A[5] * y + A[6] * z + A[7], A[8] * x + A[9] * y + A[10] * z + A[11]];

function ifcTools(api, mid) {
  const ev = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const num = (x, d) => { const v = parseFloat(ev(x)); return isFinite(v) ? v : d; };
  const str = (x) => { const v = ev(x); return v == null ? "" : String(v); };
  const line = (id) => { if (id == null) return null; try { return api.GetLine(mid, id); } catch (e) { return null; } };
  const ids = (t) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const vec = (ref) => { const l = line(ev(ref)); const a = l && (l.Coordinates || l.DirectionRatios); return Array.isArray(a) ? a.map(v => num(v, 0)) : null; };
  return { ev, num, str, line, ids, vec };
}
/* IfcAxis2Placement3D/2D → matrice; la traslazione nelle unità del file × u (metri) */
function axisMatrix(L, l, u) {
  if (!l) return M_ID();
  const o = L.vec(l.Location) || [0, 0, 0];
  const v3 = (v) => (v ? [v[0] || 0, v[1] || 0, v[2] || 0] : null);
  let z = o.length === 2 ? [0, 0, 1] : v3(l.Axis != null ? L.vec(l.Axis) : null) || [0, 0, 1];
  let x = v3(l.RefDirection != null ? L.vec(l.RefDirection) : null) || [1, 0, 0];
  const n = (v) => { const d = Math.hypot(v[0], v[1], v[2]); return d > 1e-12 ? v.map(c => c / d) : null; };
  z = n(z) || [0, 0, 1];
  const xz = x[0] * z[0] + x[1] * z[1] + x[2] * z[2];
  x = n([x[0] - xz * z[0], x[1] - xz * z[1], x[2] - xz * z[2]]) || n(Math.abs(z[0]) < 0.9 ? [1 - z[0] * z[0], -z[0] * z[1], -z[0] * z[2]] : [-z[1] * z[0], 1 - z[1] * z[1], -z[1] * z[2]]);
  const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  return [x[0], y[0], z[0], o[0] * u, x[1], y[1], z[1], o[1] * u, x[2], y[2], z[2], (o[2] || 0) * u];
}
/* catena di IfcLocalPlacement → matrice assoluta (un IfcGridPlacement vale l'identità) */
function placementMatrix(L, id, u) {
  let M = M_ID(), cur = id;
  for (let k = 0; k < 64 && cur != null; k++) {
    const p = L.line(cur);
    if (!p || p.RelativePlacement == null) break;
    M = mMul(axisMatrix(L, L.line(L.ev(p.RelativePlacement)), u), M);
    cur = p.PlacementRelTo != null ? L.ev(p.PlacementRelTo) : null;
  }
  return M;
}

/**
 * Letture grezze della georeferenziazione (oggetto clonabile, esce dal Worker).
 * Unità e MapConversion come ctxReadModel del tool Contesto 3D (unità del
 * PROGETTO solo dall'IfcUnitAssignment); in più il placement assoluto del
 * sito e il WorldCoordinateSystem del contesto, che servono alla toposolid.
 */
export function ifcReadGeoref(api, mid, T) {
  const L = ifcTools(api, mid), { ev, num, str, line, ids } = L;
  const en = (x) => str(x).replace(/\./g, "").toUpperCase();
  const PFX = { KILO: 1e3, HECTO: 1e2, DECA: 10, DECI: 0.1, CENTI: 0.01, MILLI: 1e-3, MICRO: 1e-6 };
  const lenFactor = (u) => {
    if (!u || en(u.UnitType) !== "LENGTHUNIT") return null;
    if (u.ConversionFactor == null) return en(u.Name) === "METRE" ? (PFX[en(u.Prefix)] || 1) : null;
    const mw = line(ev(u.ConversionFactor));
    let f = mw ? num(mw.ValueComponent, NaN) : NaN;
    if (!isFinite(f) || f <= 0) return null;
    const su = line(ev(mw.UnitComponent));
    if (su && su.Prefix != null && PFX[en(su.Prefix)]) f *= PFX[en(su.Prefix)];
    return f;
  };
  let unit = 1;
  outer: for (const ua of ids(T.IFCUNITASSIGNMENT)) {
    const l = line(ua);
    for (const h of (l && l.Units) || []) { const f = lenFactor(line(ev(h))); if (f) { unit = f; break outer; } }
  }
  const r = { unit, siteM: null, ctxM: null, ctxRef: false, trueNorth: null, mapConv: null, crs: null, site: null };
  const site = ids(T.IFCSITE).map(line).find(Boolean);
  if (site) {
    r.siteM = site.ObjectPlacement != null ? placementMatrix(L, ev(site.ObjectPlacement), unit) : M_ID();
    r.site = { name: str(site.Name), elev: site.RefElevation != null ? num(site.RefElevation, 0) * unit : null };
  }
  for (const cid of ids(T.IFCGEOMETRICREPRESENTATIONCONTEXT)) {
    const c = line(cid);
    if (!c || num(c.CoordinateSpaceDimension, 3) !== 3) continue;
    const w = line(ev(c.WorldCoordinateSystem));
    r.ctxM = axisMatrix(L, w, unit);
    r.ctxRef = !!(w && (w.RefDirection != null || w.Axis != null));
    const tn = c.TrueNorth != null ? L.vec(c.TrueNorth) : null;
    if (tn && tn.length >= 2 && Math.hypot(tn[0], tn[1]) > 1e-12) r.trueNorth = { x: tn[0], y: tn[1] };
    break;
  }
  const mc = ids(T.IFCMAPCONVERSION).map(line).find(Boolean);
  if (mc) {
    const crs = line(ev(mc.TargetCRS));
    const mapUnit = crs && crs.MapUnit != null ? lenFactor(line(ev(crs.MapUnit))) : null;
    r.mapConv = { E: num(mc.Eastings, 0), N: num(mc.Northings, 0), H: num(mc.OrthogonalHeight, 0),
      xa: num(mc.XAxisAbscissa, 1), xo: num(mc.XAxisOrdinate, 0), scale: num(mc.Scale, 1) || 1, mapUnit: mapUnit || 1 };
    if (crs) r.crs = { name: str(crs.Name), desc: str(crs.Description), vertical: str(crs.VerticalDatum) };
  }
  return r;
}

/**
 * Dal modello alle coordinate dello scultore e al sistema di mappa.
 * toLocal: mondo di web-ifc (metri, Z in alto) → coordinate del sito.
 * frame: sito → mappa, o null. how: "map" | "site" | "context" | null.
 */
export function ifcFrames(g, header = {}) {
  const S = g.siteM || M_ID();
  const out = { toLocal: mInvRigid(S), frame: null, how: null, base: header.base || null, crs: null, rot: 0, notes: [] };
  const big = (M) => Math.hypot(M[3], M[7]) > 1e4;
  const setFrame = (F, k, how) => {
    out.frame = { E: F[3], N: F[7], H: F[11], c: F[0] / k, s: F[4] / k, k };
    out.how = how;
    out.rot = Math.atan2(out.frame.s, out.frame.c) * 180 / Math.PI;
  };
  if (Math.abs(S[10] - 1) > 1e-9) out.notes.push("tilted");
  if (g.mapConv) {
    /* mappa = MapConversion · mondo (la geometria di web-ifc è in metri: k = Scale · unità della mappa / unità del file) */
    const m = g.mapConv, d = Math.hypot(m.xa, m.xo), ca = d > 1e-12 ? m.xa / d : 1, sa = d > 1e-12 ? m.xo / d : 0;
    const k = (m.scale * m.mapUnit) / (g.unit || 1);
    setFrame(mMul([k * ca, -k * sa, 0, m.E * m.mapUnit, k * sa, k * ca, 0, m.N * m.mapUnit, 0, 0, k, m.H * m.mapUnit], S), k, "map");
    if (big(S)) out.notes.push("doubleOffset");
  } else if (big(S)) setFrame(S, 1, "site");
  else if (g.ctxM && big(g.ctxM)) {
    /* Revit «Internal Origin»: il contesto porta E, N, H; senza RefDirection la rotazione è quella del TrueNorth (nord vero → +Y) */
    let C = g.ctxM;
    if (!g.ctxRef && g.trueNorth) {
      const d = Math.hypot(g.trueNorth.x, g.trueNorth.y), c = g.trueNorth.y / d, s = g.trueNorth.x / d;
      C = [c, -s, 0, C[3], s, c, 0, C[7], 0, 0, 1, C[11]];
    }
    setFrame(mMul(C, S), 1, "context");
  } else if (g.trueNorth && Math.abs(Math.atan2(g.trueNorth.x, g.trueNorth.y)) > 1e-6) out.notes.push("northOnly");
  if (out.base === "pbp") out.notes.push("pbp");
  out.crs = (g.crs && (g.crs.name || g.crs.desc)) || header.site || null;
  return out;
}

/* elementi che possono essere terreno; pick = proposto già spuntato */
const TERRAIN_NAME = /toposolid|topograph|topografi|terrain|terreno|gel(ä|ae)nde|terrein/i;
export function ifcTerrainCandidates(api, mid, T) {
  const L = ifcTools(api, mid), out = [];
  const add = (id, cls, pick) => {
    const l = L.line(id);
    if (!l || l.Representation == null) return;
    const name = L.str(l.Name), objectType = L.str(l.ObjectType), predef = L.str(l.PredefinedType).replace(/\./g, "").toUpperCase();
    out.push({ id, cls, name, objectType, predef, pick: pick(predef, `${name} ${objectType}`) });
  };
  for (const id of L.ids(T.IFCGEOGRAPHICELEMENT)) add(id, "IfcGeographicElement", (pd, s) => pd === "TERRAIN" || TERRAIN_NAME.test(s));
  for (const [t, cls] of [[T.IFCSLAB, "IfcSlab"], [T.IFCBUILDINGELEMENTPROXY, "IfcBuildingElementProxy"], [T.IFCCIVILELEMENT, "IfcCivilElement"], [T.IFCEARTHWORKSFILL, "IfcEarthworksFill"]])
    for (const id of L.ids(t)) { const l = L.line(id); if (l && TERRAIN_NAME.test(`${L.str(l.Name)} ${L.str(l.ObjectType)}`)) add(id, cls, () => true); }
  /* Revit prima della toposolid (2023 e precedenti) scriveva la superficie topografica come geometria dell'IfcSite */
  const anyPick = out.some(c => c.pick);
  for (const id of L.ids(T.IFCSITE)) add(id, "IfcSite", () => !anyPick);
  return out;
}

/* mesh dei prodotti nel mondo di web-ifc, Z in alto: web-ifc esce Y-up, (x, y, z) → (x, −z, y) */
export function ifcMeshes(api, mid, ids) {
  const acc = new Map(ids.map(id => [id, { P: [], I: [] }]));
  api.StreamMeshes(mid, ids, (mesh) => {
    const a = acc.get(mesh.expressID);
    if (!a) return;
    const n = mesh.geometries.size();
    for (let g = 0; g < n; g++) {
      const pg = mesh.geometries.get(g), geo = api.GetGeometry(mid, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      if (geo.delete) geo.delete();
      const m = pg.flatTransformation, base = a.P.length / 3;
      for (let k = 0; k < v.length; k += 6) {
        const x = v[k], y = v[k + 1], z = v[k + 2];
        a.P.push(m[0] * x + m[4] * y + m[8] * z + m[12], -(m[2] * x + m[6] * y + m[10] * z + m[14]), m[1] * x + m[5] * y + m[9] * z + m[13]);
      }
      for (let k = 0; k < ix.length; k++) a.I.push(base + ix[k]);
    }
  });
  return ids.map(id => { const a = acc.get(id); return { id, positions: Float64Array.from(a.P), index: Uint32Array.from(a.I) }; });
}

/**
 * La superficie superiore delle toposolid: triangoli portati nel sito, vertici
 * saldati (web-ifc li duplica per faccia), via i degeneri (area nulla: col
 * rumore delle coordinate grandi la loro normale è a caso) e le facce
 * verticali (i fianchi). Il fondo RESTA: il verso delle facce non è una
 * garanzia (una superficie aperta può averle girate a caso), è rasterizeTIN
 * con top a tenere il più alto per nodo. down si conta solo per il resoconto.
 */
export function ifcTerrainTIN(meshes, toLocal, { weld = 1e-4 } = {}) {
  const key = new Map(), P = [], F = [];
  const st = { tris: 0, degenerate: 0, vertical: 0, down: 0, kept: 0 };
  const vid = (x, y, z) => {
    const k = `${Math.round(x / weld)},${Math.round(y / weld)},${Math.round(z / weld)}`;
    let v = key.get(k);
    if (v === undefined) { v = P.length / 3; key.set(k, v); P.push(x, y, z); }
    return v;
  };
  for (const m of meshes) {
    const X = m.positions, I = m.index;
    for (let t = 0; t < I.length; t += 3) {
      st.tris++;
      const p = [0, 1, 2].map(q => mApply(toLocal, X[3 * I[t + q]], X[3 * I[t + q] + 1], X[3 * I[t + q] + 2]));
      const ux = p[1][0] - p[0][0], uy = p[1][1] - p[0][1], uz = p[1][2] - p[0][2], wx = p[2][0] - p[0][0], wy = p[2][1] - p[0][1], wz = p[2][2] - p[0][2];
      const nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx, len = Math.hypot(nx, ny, nz);
      if (!(len > 1e-6)) { st.degenerate++; continue; }
      if (Math.abs(nz) < 1e-3 * len) { st.vertical++; continue; }
      if (nz < 0) st.down++;
      st.kept++;
      F.push(vid(...p[0]), vid(...p[1]), vid(...p[2]));
    }
  }
  if (!F.length) throw new Error("solo facce verticali: non è una superficie di terreno");
  return { kind: "tin", top: true, points: Float64Array.from(P), faces: Uint32Array.from(F), stats: st };
}

/* ======================================================================
   IFC di riferimento (fase 2c): il progetto (edificio, strutture…) si vede
   nella scena per modellarci attorno il terreno. Solo vista: non entra nel
   documento né negli export. Le mesh escono nelle coordinate del SITO del
   modello (Float32: piccole), poi refPlacement le porta in quelle del
   terreno — per la mappa se tutti e due sono georeferenziati, altrimenti per
   le coordinate interne (terreno ed edificio dallo stesso progetto Revit).
   ====================================================================== */
/**
 * Copia di ctxModelNeutralize del tool Contesto 3D: le catene booleane di
 * sola sottrazione/intersezione si ripuntano sul solido di base e i fori si
 * staccano. Sono le «bombe» che bloccano web-ifc per minuti (vedi
 * truncateBoolBombs / neutralizeVoidBombs del viewer). Si usa solo come
 * ripiego, quando il modello intero non risponde: il riferimento esce senza
 * fori e senza tagli, che per modellare il terreno attorno non contano.
 * Modifica il modello aperto in memoria (WriteLine), mai il file.
 */
export function ifcNeutralizeBooleans(api, mid, T) {
  const ev = (x) => (x && typeof x === "object" && "value" in x ? x.value : x);
  const ids = (t) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const line = (id) => { try { return api.GetLine(mid, id); } catch (e) { return null; } };
  const isBool = (l) => l && (l.type === T.IFCBOOLEANRESULT || l.type === T.IFCBOOLEANCLIPPINGRESULT);
  let voids = 0, bools = 0;
  for (const rid of ids(T.IFCRELVOIDSELEMENT)) {
    const l = line(rid);
    if (!l) continue;
    const op = ev(l.RelatedOpeningElement);
    l.RelatingBuildingElement = { type: 5, value: op != null ? op : rid };
    try { api.WriteLine(mid, l); voids++; } catch (e) {}
  }
  const base = new Map();
  const baseOf = (id) => {
    if (base.has(id)) return base.get(id);
    let cur = id, out = null;
    for (let k = 0; k < 500; k++) {
      const l = line(cur);
      if (!isBool(l)) { out = cur; break; }
      const op = String(ev(l.Operator) || "").replace(/\./g, "").toUpperCase();
      if (op === "UNION") break;                       // un'unione AGGIUNGE materiale: si lascia com'è
      cur = ev(l.FirstOperand);
      if (cur == null) break;
    }
    base.set(id, out);
    return out;
  };
  for (const sid of ids(T.IFCSHAPEREPRESENTATION)) {
    const sr = line(sid);
    if (!sr || !Array.isArray(sr.Items)) continue;
    let changed = false;
    for (const it of sr.Items) {
      const id = ev(it);
      if (id == null || !isBool(line(id))) continue;
      const b = baseOf(id);
      if (b != null && b !== id) { it.value = b; changed = true; bools++; }
    }
    if (changed) try { api.WriteLine(mid, sr); } catch (e) {}
  }
  return { voids, bools };
}

/**
 * Mesh del modello di riferimento, nelle coordinate del sito (toLocal di
 * ifcFrames), a blocchi di prodotti con avanzamento (come ctxModelExtent):
 * un Worker fermo su un blocco si riconosce dal silenzio. Fuori: fori,
 * spazi e gli id in exclude (il terreno: lo sostituisce quello scolpito).
 * Due gruppi: opachi e vetri (alfa < 0,99), colori RGBA a byte per vertice.
 */
export function ifcReferenceMeshes(api, mid, T, { exclude = [], toLocal, progress = null, chunk = 200 } = {}) {
  const ids = (t) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t, true); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const skip = new Set([...ids(T.IFCOPENINGELEMENT), ...ids(T.IFCSPACE), ...exclude]);
  const prods = ids(T.IFCPRODUCT).filter((id) => !skip.has(id));
  const L = toLocal || M_ID();
  const parts = { solid: [], glass: [] }, seen = new Set();
  const cb = (mesh) => {
    const n = mesh.geometries.size();
    if (n) seen.add(mesh.expressID);
    for (let g = 0; g < n; g++) {
      const pg = mesh.geometries.get(g), geo = api.GetGeometry(mid, pg.geometryExpressID);
      const v = api.GetVertexArray(geo.GetVertexData(), geo.GetVertexDataSize());
      const ix = api.GetIndexArray(geo.GetIndexData(), geo.GetIndexDataSize());
      if (geo.delete) geo.delete();
      if (v.length < 9 || ix.length < 3) continue;
      /* sito ← Z-up ← mondo di web-ifc (Y-up) ← locale della mesh, in doppia precisione, una volta per mesh */
      const m = pg.flatTransformation;
      const W = [m[0], m[4], m[8], m[12], -m[2], -m[6], -m[10], -m[14], m[1], m[5], m[9], m[13]];
      const A = mMul(L, W);
      const nv = v.length / 6, P = new Float32Array(nv * 3);
      for (let k = 0; k < nv; k++) {
        const x = v[6 * k], y = v[6 * k + 1], z = v[6 * k + 2];
        P[3 * k] = A[0] * x + A[1] * y + A[2] * z + A[3];
        P[3 * k + 1] = A[4] * x + A[5] * y + A[6] * z + A[7];
        P[3 * k + 2] = A[8] * x + A[9] * y + A[10] * z + A[11];
      }
      const c = pg.color || { x: 0.8, y: 0.8, z: 0.8, w: 1 }, a = c.w == null ? 1 : c.w;
      const rgba = [c.x, c.y, c.z, a].map((t) => Math.max(0, Math.min(255, Math.round(t * 255))));
      (a < 0.99 ? parts.glass : parts.solid).push({ P, I: Uint32Array.from(ix), rgba });
    }
  };
  for (let p = 0; p < prods.length; p += chunk) {
    api.StreamMeshes(mid, prods.slice(p, p + chunk), cb);
    progress && progress({ done: Math.min(prods.length, p + chunk), total: prods.length });
  }
  const join = (list) => {
    let nv = 0, ni = 0;
    for (const q of list) { nv += q.P.length / 3; ni += q.I.length; }
    const P = new Float32Array(nv * 3), C = new Uint8Array(nv * 4), I = new Uint32Array(ni);
    let ov = 0, oi = 0;
    for (const q of list) {
      P.set(q.P, ov * 3);
      for (let k = 0; k < q.P.length / 3; k++) C.set(q.rgba, (ov + k) * 4);
      for (let k = 0; k < q.I.length; k++) I[oi + k] = q.I[k] + ov;
      ov += q.P.length / 3; oi += q.I.length;
    }
    return { P, C, I };
  };
  const solid = join(parts.solid), glass = join(parts.glass);
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const P of [solid.P, glass.P]) for (let k = 0; k < P.length; k += 3) for (let c = 0; c < 3; c++) { if (P[k + c] < lo[c]) lo[c] = P[k + c]; if (P[k + c] > hi[c]) hi[c] = P[k + c]; }
  return { solid, glass, elements: seen.size, triangles: (solid.I.length + glass.I.length) / 3, bbox: isFinite(lo[0]) ? { lo, hi } : null };
}

/* quanti prodotti con geometria restano oltre al terreno (fori, spazi, siti ed exclude fuori):
   l'import della toposolid propone il resto come riferimento solo se c'è */
export function ifcOtherProducts(api, mid, T, exclude = []) {
  const L = ifcTools(api, mid);
  const ids = (t) => { const out = []; if (t == null) return out; try { const v = api.GetLineIDsWithType(mid, t, true); for (let i = 0; i < v.size(); i++) out.push(v.get(i)); } catch (e) {} return out; };
  const skip = new Set([...ids(T.IFCOPENINGELEMENT), ...ids(T.IFCSPACE), ...ids(T.IFCSITE), ...exclude]);
  let n = 0;
  for (const id of ids(T.IFCPRODUCT)) if (!skip.has(id)) { const l = L.line(id); if (l && l.Representation != null) n++; }
  return n;
}

/* frame { E, N, H, c, s, k } → matrice 3×4 (sito → mappa) e inversa di una similitudine */
export const frameMatrix = (F) => [F.k * F.c, -F.k * F.s, 0, F.E, F.k * F.s, F.k * F.c, 0, F.N, 0, 0, F.k, F.H];
export function mInvSim(A) {
  const k2 = A[0] * A[0] + A[4] * A[4] + A[8] * A[8];
  const R = [A[0] / k2, A[4] / k2, A[8] / k2, 0, A[1] / k2, A[5] / k2, A[9] / k2, 0, A[2] / k2, A[6] / k2, A[10] / k2, 0];
  for (let r = 0; r < 3; r++) R[4 * r + 3] = -(R[4 * r] * A[3] + R[4 * r + 1] * A[7] + R[4 * r + 2] * A[11]);
  return R;
}
/**
 * Dove va il modello di riferimento rispetto al terreno.
 * docKind: "ifc" (terreno da un IFC: coordinate interne, docFrame = la sua
 * georeferenziazione o null) · "map" (DTM in coordinate di mappa) · "local"
 * (terreno nuovo o senza sistema). refFrame: la georeferenziazione del
 * modello (ifcFrames().frame) o null. → { M: sito del modello → coordinate
 * del terreno, how: "map" | "internal", notes }
 */
export function refPlacement(docKind, docFrame, refFrame) {
  if (docKind === "ifc") {
    if (docFrame && refFrame) return { M: mMul(mInvSim(frameMatrix(docFrame)), frameMatrix(refFrame)), how: "map", notes: [] };
    return { M: M_ID(), how: "internal", notes: docFrame || refFrame ? ["mixed"] : [] };
  }
  if (docKind === "map") {
    if (refFrame) return { M: frameMatrix(refFrame), how: "map", notes: [] };
    return { M: M_ID(), how: "internal", notes: ["notGeo"] };
  }
  return { M: M_ID(), how: "internal", notes: refFrame ? ["localDoc"] : [] };
}

/* ======================================================================
   Estensione e passo
   ====================================================================== */
export function sourceExtent(src) {
  if (src.kind === "raster") return { x0: src.x0, y0: src.y0, x1: src.x0 + (src.W - 1) * src.dx, y1: src.y0 + (src.H - 1) * src.dy };
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  const P = src.points;
  for (let k = 0; k < P.length; k += 3) { const x = P[k], y = P[k + 1]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  return { x0, y0, x1, y1 };
}

/* passo "nativo": il pixel del raster, o la mediana dei lati del TIN / 2 */
export function nativeCell(src) {
  if (src.kind === "raster") return Math.max(src.dx, src.dy);
  const P = src.points, F = src.faces, L = [];
  const step = Math.max(1, Math.floor(F.length / 3 / 20000));
  for (let t = 0; t < F.length; t += 3 * step) {
    const a = 3 * F[t], b = 3 * F[t + 1];
    L.push(Math.hypot(P[a] - P[b], P[a + 1] - P[b + 1]));
  }
  L.sort((p, q) => p - q);
  return L.length ? L[L.length >> 1] / 2 : 1;
}

/* griglia allineata ai multipli del passo che copre l'estensione */
export function gridSpec(ext, cell) {
  const x0 = Math.floor(ext.x0 / cell + 1e-9) * cell, y0 = Math.floor(ext.y0 / cell + 1e-9) * cell;
  const nx = Math.round((Math.ceil(ext.x1 / cell - 1e-9) * cell - x0) / cell) + 1;
  const ny = Math.round((Math.ceil(ext.y1 / cell - 1e-9) * cell - y0) / cell) + 1;
  return { nx: Math.max(2, nx), ny: Math.max(2, ny), cell, x0, y0 };
}

/* passi tondi proponibili, coi nodi che ne vengono */
export const CELL_CHOICES = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50];
export function cellOptions(src, maxNodes) {
  const ext = sourceExtent(src), nat = nativeCell(src);
  const raster = src.kind === "raster" && Math.abs(src.dx - src.dy) < 1e-9;
  const cells = CELL_CHOICES.slice();
  if (raster && !cells.some(c => Math.abs(c - src.dx) < 1e-9)) cells.push(src.dx);      // il pixel del raster, anche se non è tondo
  cells.sort((a, b) => a - b);
  const out = cells.map(cell => {
    const nodes = raster && Math.abs(cell - src.dx) < 1e-9 ? src.W * src.H : (({ nx, ny }) => nx * ny)(gridSpec(ext, cell));
    return { cell, nodes, ok: nodes <= maxNodes, native: raster && Math.abs(cell - src.dx) < 1e-9 };
  });
  /* proposta: raster → il suo pixel se ci sta; TIN → il più fine che non scende sotto metà del passo nativo */
  const ok = out.filter(o => o.ok);
  const fine = ok.filter(o => o.cell >= (raster ? nat : nat / 2) - 1e-9);
  const pick = (fine.length ? fine[0] : ok[ok.length - 1]) || null;
  return { ext, native: nat, options: out, proposed: pick ? pick.cell : null };
}

/* ======================================================================
   Dalla sorgente alla griglia del documento
   ====================================================================== */
/* TIN → nodi: interpolazione lineare nel triangolo (baricentriche).
   src.top (superficie da un solido IFC): dove più triangoli coprono un nodo
   vince il più alto — il fondo della toposolid e le sotto-regioni impilate
   restano sotto. */
export function rasterizeTIN(src, spec) {
  const { nx, ny, cell, x0, y0 } = spec, P = src.points, F = src.faces, top = !!src.top;
  const z = new Float64Array(nx * ny).fill(NaN);
  for (let t = 0; t < F.length; t += 3) {
    const a = 3 * F[t], b = 3 * F[t + 1], c = 3 * F[t + 2];
    const ax = (P[a] - x0) / cell, ay = (P[a + 1] - y0) / cell, bx = (P[b] - x0) / cell, by = (P[b + 1] - y0) / cell, cx = (P[c] - x0) / cell, cy = (P[c + 1] - y0) / cell;
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (!den) continue;
    const i0 = Math.max(0, Math.ceil(Math.min(ax, bx, cx) - 1e-9)), i1 = Math.min(nx - 1, Math.floor(Math.max(ax, bx, cx) + 1e-9));
    const j0 = Math.max(0, Math.ceil(Math.min(ay, by, cy) - 1e-9)), j1 = Math.min(ny - 1, Math.floor(Math.max(ay, by, cy) + 1e-9));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const l1 = ((by - cy) * (i - cx) + (cx - bx) * (j - cy)) / den;
      const l2 = ((cy - ay) * (i - cx) + (ax - cx) * (j - cy)) / den;
      const l3 = 1 - l1 - l2;
      if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) continue;
      const v = l1 * P[a + 2] + l2 * P[b + 2] + l3 * P[c + 2], k = j * nx + i;
      if (!top || !(z[k] >= v)) z[k] = v;
    }
  }
  return z;
}

/* raster → nodi: bilineare; con un vicino senza dato vale il vicino valido più
   pesante (a passo nativo e allineato è una copia esatta) */
export function sampleRaster(src, spec) {
  const { nx, ny, cell, x0, y0 } = spec, R = src.z, W = src.W, H = src.H;
  const z = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    const fy = (y0 + j * cell - src.y0) / src.dy;
    for (let i = 0; i < nx; i++) {
      const fx = (x0 + i * cell - src.x0) / src.dx;
      if (fx < -1e-6 || fy < -1e-6 || fx > W - 1 + 1e-6 || fy > H - 1 + 1e-6) { z[j * nx + i] = NaN; continue; }
      const c0 = Math.min(Math.max(Math.floor(fx + 1e-9), 0), W - 2), r0 = Math.min(Math.max(Math.floor(fy + 1e-9), 0), H - 2);
      const tx = Math.min(Math.max(fx - c0, 0), 1), ty = Math.min(Math.max(fy - r0, 0), 1);
      const v = [R[r0 * W + c0], R[r0 * W + c0 + 1], R[(r0 + 1) * W + c0], R[(r0 + 1) * W + c0 + 1]];
      const w = [(1 - tx) * (1 - ty), tx * (1 - ty), (1 - tx) * ty, tx * ty];
      let s = 0, sw = 0, bestW = -1, best = NaN;
      for (let q = 0; q < 4; q++) if (v[q] === v[q]) { s += v[q] * w[q]; sw += w[q]; if (w[q] > bestW) { bestW = w[q]; best = v[q]; } }
      z[j * nx + i] = sw >= 1 - 1e-9 ? s : (sw > 0 && bestW >= 0.25 ? best : NaN);
    }
  }
  return z;
}

/* buchi (NaN) riempiti in continuità: piramide di medie pesate (push), poi
   ogni livello prende i suoi buchi dal livello sopra, bilineare (pull), e li
   distende con qualche passata di media dei 4 vicini (un ciclo di multigrid:
   un buco di un nodo prende esattamente la media dei vicini, uno grande
   resta liscio fra le sponde) */
const FILL_SMOOTH = 6;
export function fillHoles(z, nx, ny) {
  const levels = [{ w: nx, h: ny, z: Float64Array.from(z, v => (v === v ? v : 0)), m: Uint8Array.from(z, v => (v === v ? 1 : 0)) }];
  let any = levels[0].m.some(v => !v);
  if (!any) return 0;
  if (!levels[0].m.some(v => v)) throw new Error("nessun dato valido da cui riempire");
  while (any && (levels[levels.length - 1].w > 1 || levels[levels.length - 1].h > 1)) {
    const L = levels[levels.length - 1], w = Math.ceil(L.w / 2), h = Math.ceil(L.h / 2);
    const Z = new Float64Array(w * h), M = new Uint8Array(w * h);
    for (let J = 0; J < h; J++) for (let I = 0; I < w; I++) {
      let s = 0, c = 0;
      for (let dj = 0; dj < 2; dj++) for (let di = 0; di < 2; di++) {
        const i = 2 * I + di, j = 2 * J + dj;
        if (i < L.w && j < L.h && L.m[j * L.w + i]) { s += L.z[j * L.w + i]; c++; }
      }
      if (c) { Z[J * w + I] = s / c; M[J * w + I] = 1; }
    }
    levels.push({ w, h, z: Z, m: M });
    any = M.some(v => !v);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l], U = levels[l + 1], holes = [];
    for (let j = 0; j < L.h; j++) for (let i = 0; i < L.w; i++) {
      const k = j * L.w + i;
      if (L.m[k]) continue;
      const fx = Math.min(Math.max((i - 0.5) / 2, 0), U.w - 1), fy = Math.min(Math.max((j - 0.5) / 2, 0), U.h - 1);
      const I = Math.min(Math.floor(fx), Math.max(U.w - 2, 0)), J = Math.min(Math.floor(fy), Math.max(U.h - 2, 0));
      const I1 = Math.min(I + 1, U.w - 1), J1 = Math.min(J + 1, U.h - 1), tx = fx - I, ty = fy - J;
      L.z[k] = (U.z[J * U.w + I] * (1 - tx) + U.z[J * U.w + I1] * tx) * (1 - ty) + (U.z[J1 * U.w + I] * (1 - tx) + U.z[J1 * U.w + I1] * tx) * ty;
      L.m[k] = 1;
      holes.push(k);
    }
    for (let it = 0; it < FILL_SMOOTH; it++) for (const k of holes) {
      const i = k % L.w, j = (k - i) / L.w;
      let s = 0, c = 0;
      if (i > 0) { s += L.z[k - 1]; c++; }
      if (i < L.w - 1) { s += L.z[k + 1]; c++; }
      if (j > 0) { s += L.z[k - L.w]; c++; }
      if (j < L.h - 1) { s += L.z[k + L.w]; c++; }
      if (c) L.z[k] = s / c;
    }
  }
  let filled = 0;
  for (let k = 0; k < z.length; k++) if (!(z[k] === z[k])) { z[k] = levels[0].z[k]; filled++; }
  return filled;
}

/* la griglia finale: { nx, ny, cell, x0, y0, z, mask (null se pieno) } + statistiche */
export function buildGrid(src, cell) {
  const native = src.kind === "raster" && Math.abs(cell - src.dx) < 1e-9 && Math.abs(cell - src.dy) < 1e-9;
  const spec = native ? { nx: src.W, ny: src.H, cell, x0: src.x0, y0: src.y0 } : gridSpec(sourceExtent(src), cell);
  /* a passo nativo i nodi SONO i pixel: copia esatta */
  const z = native ? Float64Array.from(src.z) : src.kind === "tin" ? rasterizeTIN(src, spec) : sampleRaster(src, spec);
  const mask = new Uint8Array(z.length);
  let valid = 0;
  for (let k = 0; k < z.length; k++) if (z[k] === z[k]) { mask[k] = 1; valid++; }
  if (!valid) throw new Error("nessun nodo della griglia cade dentro il terreno");
  const filled = fillHoles(z, spec.nx, spec.ny);
  return { ...spec, z, mask: filled ? mask : null, stats: { nodes: z.length, valid, filled } };
}
