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

   opts: { origin:{x,y,z}, swizzle:true, maxPoints:Infinity }
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

function parseLASPoints(buffer, header, opts) {
  opts = opts || {};
  const swizzle = opts.swizzle !== false;
  const maxPoints = opts.maxPoints || Infinity;
  const O = opts.origin || { x: 0, y: 0, z: 0 };

  const buf = buffer.buffer ? buffer.buffer : buffer;
  const bufOff = buffer.byteOffset || 0;
  const dv = new DataView(buf, bufOff);

  if (header.compressed) throw new Error("Buffer LAZ compresso: decomprimere prima di parseLASPoints.");

  const total = header.pointCount;
  const rl = header.pointRecordLength;
  const base = header.pointDataOffset;
  const sx = header.scale[0], sy = header.scale[1], sz = header.scale[2];
  const ox = header.offset[0], oy = header.offset[1], oz = header.offset[2];
  const ro = header.rgbOffset;

  // passo di sottocampionamento per rispettare il tetto
  let step = 1;
  if (total > maxPoints) step = Math.ceil(total / maxPoints);
  const outCount = Math.ceil(total / step);

  const position = new Float32Array(outCount * 3);
  const color = ro >= 0 ? new Uint8Array(outCount * 3) : null;
  const shift = color ? _detectRgbShift(dv, header, step, total) : 0;

  let w = 0;
  let wminx = Infinity, wminy = Infinity, wminz = Infinity;
  let wmaxx = -Infinity, wmaxy = -Infinity, wmaxz = -Infinity;

  for (let i = 0; i < total; i += step) {
    const p = base + i * rl;
    if (p + 12 > dv.byteLength) break;                         // file troncato: fermati pulito
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

  return {
    position: w === outCount ? position : position.subarray(0, w * 3),
    color: color ? (w === outCount ? color : color.subarray(0, w * 3)) : null,
    count: w,
    subsampled: step > 1,
    step,
    worldBounds: w ? { min: [wminx, wminy, wminz], max: [wmaxx, wmaxy, wmaxz] } : null,
  };
}

/* export ESM — nel browser via <script type="module">, in Node via import() dinamico */
export { parseLASHeader, parseLASPoints, RGB_OFFSET };
