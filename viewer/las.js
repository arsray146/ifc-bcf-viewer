/* ============================================================================
   LAS point-cloud parser — puro, senza dipendenze (browser + Node).
   Studio import PointCloud (branch study/pointcloud-import).

   Copre LAS 1.0–1.4, Point Data Record Format 0–10.
   NON gestisce LAZ (compresso): va decompresso a monte (es. laz-perf) e poi
   passato qui come buffer LAS "puro".

   Le coordinate LAS sono già in coordinate mappa: X=Est, Y=Nord, Z=Quota
   (nell'unità/CRS del file). Il ribasamento sull'origine condivisa e lo
   swizzle Z-up→Y-up del viewer sono applicati QUI in un solo passaggio, in
   Float64 PRIMA del cast a Float32, così un Easting da 1.5M non perde
   precisione (Float32 regge ~7 cifre → jitter senza ribasamento).

   API:
     parseLASHeader(arrayBuffer) -> header
     parseLASPoints(arrayBuffer, header, opts) -> { position, color, count, mapBounds }
     await readLASHeader(src)     -> header, leggendo i soli primi 375 byte
     await parseLAS(src, opts)    -> come parseLASPoints, ma letto A FETTE (v2.9.2)
   src: Uint8Array/ArrayBuffer · Blob/File · oppure { size, read(off,len)->Promise<Uint8Array> }

   FILE GRANDI (v2.9.2). parseLASPoints vuole tutto il file in un ArrayBuffer,
   che il browser sopra ~2 GB non alloca. parseLAS legge i record a blocchi
   (~8 MB, sempre un numero intero di record: la lunghezza è fissa, nessun
   disallineamento da gestire come nell'E57), cede il thread fra un blocco e
   l'altro e tiene in memoria solo il risultato. Stessa decodifica di
   parseLASPoints (_emitRange): a parità di file l'uscita è identica.

   opts: { origin:{x,y,z}, swizzle:true, maxPoints:Infinity }
     (parseLAS in più: header — se già letto —, chunkSize, onProgress(done,total))
     origin  = worldOriginMap in coord. mappa (E,N,H); default {0,0,0}
     swizzle = true  → world = (E-Ox, H-Oz, -(N-Oy))   [Z-up mappa → Y-up three]
               false → world = (E-Ox, N-Oy, H-Oz)      [nessuno swizzle, per test]
     maxPoints = tetto di sicurezza: se il file supera la soglia, sottocampiona
                 con passo intero (1 punto ogni N) mantenendo la distribuzione.
============================================================================ */

/* Offset (in byte) del blocco RGB dentro un record punto, per point-format.
   XYZ sono sempre int32 a offset 0/4/8. -1 = il formato non porta colore. */
const RGB_OFFSET = { 0: -1, 1: -1, 2: 20, 3: 28, 4: -1, 5: 28, 6: -1, 7: 30, 8: 30, 9: -1, 10: 30 };

function _isLASF(dv) {
  return dv.getUint8(0) === 0x4C && dv.getUint8(1) === 0x41 &&
         dv.getUint8(2) === 0x53 && dv.getUint8(3) === 0x46; // "LASF"
}

function parseLASHeader(buffer) {
  const buf = buffer.buffer ? buffer.buffer : buffer;           // accetta ArrayBuffer o TypedArray
  const off = buffer.byteOffset || 0;
  const dv = new DataView(buf, off);
  if (dv.byteLength < 227 || !_isLASF(dv)) {
    throw new Error("Non è un file LAS (firma 'LASF' assente).");
  }
  const versionMajor = dv.getUint8(24);
  const versionMinor = dv.getUint8(25);
  const headerSize = dv.getUint16(94, true);
  const pointDataOffset = dv.getUint32(96, true);

  const fmtByte = dv.getUint8(104);
  const compressed = (fmtByte & 0x80) !== 0 || (fmtByte & 0x40) !== 0; // bit alti = LAZ
  const pointFormat = fmtByte & 0x3f;
  const pointRecordLength = dv.getUint16(105, true);

  // conteggio punti: legacy uint32 (offset 107); in 1.4 preferisci il uint64 (247) se valorizzato
  let pointCount = dv.getUint32(107, true);
  if (versionMinor >= 4 && headerSize >= 375) {
    const c64 = Number(dv.getBigUint64(247, true));
    if (c64 > 0) pointCount = c64;
  }

  const scale = [dv.getFloat64(131, true), dv.getFloat64(139, true), dv.getFloat64(147, true)];
  const offset = [dv.getFloat64(155, true), dv.getFloat64(163, true), dv.getFloat64(171, true)];
  // min/max: nell'header sono in ordine maxX,minX,maxY,minY,maxZ,minZ
  const maxX = dv.getFloat64(179, true), minX = dv.getFloat64(187, true);
  const maxY = dv.getFloat64(195, true), minY = dv.getFloat64(203, true);
  const maxZ = dv.getFloat64(211, true), minZ = dv.getFloat64(219, true);

  const rgbOffset = RGB_OFFSET[pointFormat] != null ? RGB_OFFSET[pointFormat] : -1;

  return {
    versionMajor, versionMinor, headerSize, pointDataOffset,
    pointFormat, pointRecordLength, pointCount, compressed,
    scale, offset,
    mapMin: [minX, minY, minZ], mapMax: [maxX, maxY, maxZ],
    rgbOffset, hasColor: rgbOffset >= 0,
  };
}

/* Rileva se l'RGB è a 16 bit (0–65535, standard LAS) o già a 8 bit (0–255):
   campiona fino a ~2000 punti e guarda il massimo di canale. */
function _detectRgbShift(dv, header, step, total) {
  const { pointDataOffset: base, pointRecordLength: rl, rgbOffset: ro } = header;
  let max = 0;
  const sampleStep = Math.max(step, Math.ceil(total / 2000));
  for (let i = 0; i < total; i += sampleStep) {
    const p = base + i * rl + ro;
    if (p + 6 > dv.byteLength) break;
    const r = dv.getUint16(p, true), g = dv.getUint16(p + 2, true), b = dv.getUint16(p + 4, true);
    if (r > max) max = r; if (g > max) max = g; if (b > max) max = b;
    if (max > 255) return 8;      // basta un canale >255 per stabilire i 16 bit
  }
  return max > 255 ? 8 : 0;
}

/* Stato di una decodifica: tetto, passo, array di uscita, bbox. Comune alla
   lettura in memoria (parseLASPoints) e a quella a fette (parseLAS). */
function _newState(header, opts, step, shift) {
  const total = header.pointCount;
  const outCount = Math.ceil(total / step);
  const ro = header.rgbOffset;
  return {
    step, outCount, shift,
    swizzle: opts.swizzle !== false,
    O: opts.origin || { x: 0, y: 0, z: 0 },
    rl: header.pointRecordLength, ro,
    sx: header.scale[0], sy: header.scale[1], sz: header.scale[2],
    ox: header.offset[0], oy: header.offset[1], oz: header.offset[2],
    position: new Float32Array(outCount * 3),
    color: ro >= 0 ? new Uint8Array(outCount * 3) : null,
    w: 0,
    wminx: Infinity, wminy: Infinity, wminz: Infinity,
    wmaxx: -Infinity, wmaxy: -Infinity, wmaxz: -Infinity,
  };
}

/* Decodifica i record tenuti dal sottocampionamento (indice globale multiplo
   di step) fra i0 e i1 esclusi. Il record i sta al byte off0 + (i - i0)·rl di
   dv. Ritorna false se il buffer finisce prima (file troncato): ci si ferma
   pulito, coi punti letti fin lì. */
function _emitRange(st, dv, off0, i0, i1) {
  const { step, rl, ro, sx, sy, sz, ox, oy, oz, O, swizzle, position, color, shift } = st;
  let w = st.w;
  let { wminx, wminy, wminz, wmaxx, wmaxy, wmaxz } = st;
  let ok = true;
  /* byte del record che si leggono davvero: XYZ, più l'RGB se c'è. Prima si
     controllavano solo i 12 di XYZ, e un file troncato fra le coordinate e il
     colore esplodeva con un errore di DataView invece di fermarsi pulito. */
  const need = ro >= 0 ? Math.max(12, ro + 6) : 12;
  for (let i = Math.ceil(i0 / step) * step; i < i1; i += step) {
    const p = off0 + (i - i0) * rl;
    if (p + need > dv.byteLength) { ok = false; break; }        // file troncato: fermati pulito
    const X = dv.getInt32(p, true), Y = dv.getInt32(p + 4, true), Z = dv.getInt32(p + 8, true);
    // coord mappa (metri) in Float64
    const E = X * sx + ox, N = Y * sy + oy, H = Z * sz + oz;
    // ribasa sull'origine in Float64, POI swizzle e cast a Float32
    const rx = E - O.x, ry = N - O.y, rz = H - O.z;
    const wx = rx, wy = swizzle ? rz : ry, wz = swizzle ? -ry : rz;
    const o3 = w * 3;
    position[o3] = wx; position[o3 + 1] = wy; position[o3 + 2] = wz;
    if (wx < wminx) wminx = wx; if (wx > wmaxx) wmaxx = wx;
    if (wy < wminy) wminy = wy; if (wy > wmaxy) wmaxy = wy;
    if (wz < wminz) wminz = wz; if (wz > wmaxz) wmaxz = wz;
    if (color) {
      const cp = p + ro;
      let r = dv.getUint16(cp, true), g = dv.getUint16(cp + 2, true), b = dv.getUint16(cp + 4, true);
      color[o3] = (r >> shift) & 0xff;
      color[o3 + 1] = (g >> shift) & 0xff;
      color[o3 + 2] = (b >> shift) & 0xff;
    }
    w++;
  }
  st.w = w;
  Object.assign(st, { wminx, wminy, wminz, wmaxx, wmaxy, wmaxz });
  return ok;
}

function _result(st) {
  const { w, outCount, position, color, step } = st;
  return {
    position: w === outCount ? position : position.subarray(0, w * 3),
    color: color ? (w === outCount ? color : color.subarray(0, w * 3)) : null,
    count: w,
    subsampled: step > 1,
    step,
    worldBounds: w ? { min: [st.wminx, st.wminy, st.wminz], max: [st.wmaxx, st.wmaxy, st.wmaxz] } : null,
  };
}

function _stepFor(total, maxPoints) {
  // passo di sottocampionamento per rispettare il tetto
  return total > maxPoints ? Math.ceil(total / maxPoints) : 1;
}

function parseLASPoints(buffer, header, opts) {
  opts = opts || {};
  const buf = buffer.buffer ? buffer.buffer : buffer;
  const bufOff = buffer.byteOffset || 0;
  /* la lunghezza della VISTA, non il resto del buffer sottostante: una
     subarray troncata veniva letta fino in fondo al buffer che la contiene */
  const dv = new DataView(buf, bufOff, buffer.byteLength);

  if (header.compressed) throw new Error("Buffer LAZ compresso: decomprimere prima di parseLASPoints.");

  const total = header.pointCount;
  const step = _stepFor(total, opts.maxPoints || Infinity);
  const shift = header.rgbOffset >= 0 ? _detectRgbShift(dv, header, step, total) : 0;
  const st = _newState(header, opts, step, shift);
  _emitRange(st, dv, header.pointDataOffset, 0, total);
  return _result(st);
}

/* ---- lettura A FETTE (v2.9.2) ---- */

/* Blob/File PRIMA del duck-typing, come in e57.js: Chrome ha aggiunto
   Blob.prototype.bytes(), che ignora gli argomenti e restituisce l'INTERO
   blob — riconoscere il tipo prima delle proprietà evita sorprese simili. */
function _source(x) {
  if (typeof Blob !== "undefined" && x instanceof Blob)
    return { size: x.size, read: async (off, len) => new Uint8Array(await x.slice(off, off + len).arrayBuffer()) };
  if (x && typeof x.read === "function" && typeof x.size === "number") return x;
  const u8 = x.buffer ? new Uint8Array(x.buffer, x.byteOffset, x.byteLength) : new Uint8Array(x);
  return { size: u8.length, read: async (off, len) => u8.subarray(off, off + len) };
}

/* Pausa fra un blocco e l'altro, come _tick di e57.js: a finestra visibile
   setTimeout (lascia ridipingere l'avanzamento), a finestra coperta un
   MessageChannel, che Chrome ed Edge non rallentano a un giro al secondo come
   i timer. Senza document (Node, test) setImmediate: un MessageChannel con la
   porta sganciata NON tiene vivo il processo, che usciva in silenzio — codice
   0 — a metà lettura; agganciata, invece, non lo lascerebbe più uscire. */
let _mc = null;
function _mcTick() {
  if (!_mc) {
    const ch = new MessageChannel(), waiting = [];
    ch.port1.onmessage = () => { const r = waiting.shift(); if (r) r(); };
    _mc = r => { waiting.push(r); ch.port2.postMessage(0); };
  }
  return new Promise(r => _mc(r));
}
const _tick = () => {
  if (typeof document === "undefined")
    return new Promise(r => (typeof setImmediate === "function" ? setImmediate : setTimeout)(r));
  return (document.hidden && typeof MessageChannel === "function") ? _mcTick() : new Promise(r => setTimeout(r, 0));
};

/* header dai soli primi 375 byte (l'header più lungo, LAS 1.4) */
async function readLASHeader(input) {
  const src = _source(input);
  return parseLASHeader(await src.read(0, Math.min(src.size, 375)));
}

/* RGB a 8 o 16 bit: gli STESSI campioni di _detectRgbShift, letti uno per uno
   dalla sorgente (a gruppi, in parallelo). Un file a 16 bit — lo standard —
   si riconosce di solito al primo campione. */
async function _detectRgbShiftSrc(src, header, step, total) {
  const { pointDataOffset: base, pointRecordLength: rl, rgbOffset: ro } = header;
  const sampleStep = Math.max(step, Math.ceil(total / 2000));
  const offs = [];
  for (let i = 0; i < total; i += sampleStep) {
    const p = base + i * rl + ro;
    if (p + 6 > src.size) break;
    offs.push(p);
  }
  let max = 0;
  for (let k = 0; k < offs.length; k += 64) {
    const got = await Promise.all(offs.slice(k, k + 64).map(p => src.read(p, 6)));
    for (const b of got) {
      const r = b[0] | (b[1] << 8), g = b[2] | (b[3] << 8), bl = b[4] | (b[5] << 8);
      if (r > max) max = r; if (g > max) max = g; if (bl > max) max = bl;
      if (max > 255) return 8;
    }
  }
  return max > 255 ? 8 : 0;
}

async function parseLAS(input, opts) {
  opts = opts || {};
  const src = _source(input);
  const header = opts.header || await readLASHeader(src);
  if (header.compressed) throw new Error("File LAZ compresso: esportarlo come LAS non compresso.");

  const total = header.pointCount, rl = header.pointRecordLength, base = header.pointDataOffset;
  const step = _stepFor(total, opts.maxPoints || Infinity);
  const shift = header.rgbOffset >= 0 ? await _detectRgbShiftSrc(src, header, step, total) : 0;
  const st = _newState(header, opts, step, shift);

  /* blocchi di un numero intero di record: ogni record sta tutto in un blocco.
     La pausa NON è a ogni blocco: setTimeout costa ~4 ms anche a vuoto, e a
     8 MB per blocco era un +50% sul tempo di lettura. Si cede il thread ogni
     ~25 ms di lavoro, quanto basta a ridipingere la percentuale. */
  const perChunk = Math.max(1, Math.floor((opts.chunkSize || (8 << 20)) / rl));
  /* lettura ANTICIPATA: mentre si decodifica un blocco, il browser sta già
     leggendo il successivo (un Blob si legge fuori dal thread della pagina).
     Senza, ogni slice().arrayBuffer() era tempo morto: +50% su un LAS da 500 MB. */
  const readChunk = i0 => {
    const off = base + i0 * rl;
    const len = Math.min((Math.min(total, i0 + perChunk) - i0) * rl, src.size - off);
    return len > 0 ? src.read(off, len) : null;               // null: file troncato prima di questo blocco
  };
  let lastYield = performance.now();
  let pending = readChunk(0);
  for (let i0 = 0; i0 < total; i0 += perChunk) {
    const i1 = Math.min(total, i0 + perChunk);
    if (!pending) break;
    const bytes = await pending;
    pending = i1 < total ? readChunk(i1) : null;
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const ok = _emitRange(st, dv, 0, i0, i1);
    if (opts.onProgress) opts.onProgress(i1, total);
    if (!ok) break;
    if (performance.now() - lastYield > 25) { await _tick(); lastYield = performance.now(); }
  }
  if (pending) pending.catch(() => {});                       // lettura anticipata rimasta a metà (file troncato): nessun rifiuto orfano
  return _result(st);
}

/* export ESM — nel browser via <script type="module">, in Node via import() dinamico */
export { parseLASHeader, parseLASPoints, readLASHeader, parseLAS, RGB_OFFSET };
