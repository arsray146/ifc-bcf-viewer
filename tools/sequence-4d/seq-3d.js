/* =========================================================================
   Sequenza 4D — il 3D del tool (F1)
   Autore: Alessandro Perugini — BIM Coordinator. Licenza AGPL-3.0.

   three.js del viewer (importmap della pagina, ../../viewer/vendor/).
   Ogni modello arriva in pochi blocchi di geometria (seq-ifc.js); ogni blocco
   ha tre mesh sulla stessa geometria: opaca, trasparente, scelta col clic.
   Lo stato degli elementi sta in una texture del modello, 2 texel per
   elemento:
     texel 2k   = tinta RGB + quanto pesa (A: 0 = colore del modello, 255 = tutta tinta)
     texel 2k+1 = R opacità (0 = nascosto), G bit (1 = si sceglie col clic,
                  2 = tagliato a una quota, 4 = tagliato lungo l'asse),
                  B·256 + A = il piano del taglio su 16 bit dentro uCut
   Il taglio (0.6.1) è il fronte della sequenza (seq-play.js): dell'elemento
   si vede solo la parte sotto il piano, e dentro, dove il taglio lo apre,
   le facce di dietro più scure come una sezione.
   Il vertex shader legge lo stato del suo elemento: un elemento nascosto, o
   nella passata che non è la sua (opaca / trasparente), esce dallo schermo e
   non costa rasterizzazione. Cambiare colore, trasparenza o visibilità a
   centomila elementi = riscrivere la texture: nessuna mesh da ricostruire,
   sempre un draw call per blocco e per passata (la F4 ci fa la sequenza).
   La scelta col clic è una passata di un pixel (setViewOffset) su un
   bersaglio float: indice dell'elemento, modello e profondità, cioè anche il
   punto 3D, che fa da perno all'orbita e allo zoom (come il viewer 2.8.5).
   Normali piatte dalle derivate (come il Terrain Sculptor): niente attributo,
   metà memoria.
   ========================================================================= */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";

export const ST_W = 4096;          // texel per riga della texture di stato (2 per elemento)
export const F_PICK = 1;           // bit di G: si sceglie col clic
export const F_CUT_Z = 2;          // tagliato a una quota (il fronte dal basso)
export const F_CUT_AXIS = 4;       // tagliato lungo l'asse del lotto

const VS = `
uniform highp sampler2D uState;
uniform int uPass;
uniform vec4 uCut;
attribute vec4 rgba;
attribute float eid;
varying vec3 vW;
varying vec4 vC;
varying float vD;
flat varying float vE;
flat varying float vK;
flat varying float vCut;
void main() {
  int k = int(eid + 0.5) * 2;
  vec4 a = texelFetch(uState, ivec2(k % ${ST_W}, k / ${ST_W}), 0);
  vec4 b = texelFetch(uState, ivec2((k + 1) % ${ST_W}, (k + 1) / ${ST_W}), 0);
  float op = b.r * rgba.a;
  int fl = int(b.g * 255.0 + 0.5);
  if (b.r < 0.002 || (uPass == 0 && op < 0.996) || (uPass == 1 && op >= 0.996) || (uPass == 2 && (fl & ${F_PICK}) == 0)) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vC = vec4(mix(rgba.rgb, a.rgb, a.a), op);
  vE = eid;
  /* il piano del taglio: 16 bit (B, A) dentro l'intervallo della sua direzione */
  float u = (b.b * 65280.0 + b.a * 255.0) / 65535.0;
  vK = (fl & ${F_CUT_Z}) != 0 ? 1.0 : (fl & ${F_CUT_AXIS}) != 0 ? 2.0 : 0.0;
  vCut = vK == 1.0 ? mix(uCut.x, uCut.y, u) : mix(uCut.z, uCut.w, u);
  vec4 w = modelMatrix * vec4(position, 1.0);
  vW = w.xyz;
  vec4 mv = viewMatrix * w;
  vD = -mv.z;
  gl_Position = projectionMatrix * mv;
}`;
const FS = `
uniform int uPass;
uniform float uModel;
uniform vec3 uL1;
uniform vec3 uL2;
uniform vec2 uAxis;
varying vec3 vW;
varying vec4 vC;
varying float vD;
flat varying float vE;
flat varying float vK;
flat varying float vCut;
void main() {
  /* il fronte: sopra il piano l'elemento non c'è ancora (anche per il clic) */
  if (vK > 0.5 && (vK < 1.5 ? vW.z : dot(vW.xy, uAxis)) > vCut) discard;
  if (uPass == 2) {
#ifdef PICK8
    float id = vE + 1.0;
    gl_FragColor = vec4(mod(id, 256.0), mod(floor(id / 256.0), 256.0), floor(id / 65536.0), uModel + 1.0) / 255.0;
#else
    gl_FragColor = vec4(vE + 1.0, uModel + 1.0, vD, 1.0);
#endif
    return;
  }
  vec3 n = normalize(cross(dFdx(vW), dFdy(vW)));
  float l = 0.52 + 0.36 * max(dot(n, uL1), 0.0) + 0.16 * max(dot(n, uL2), 0.0);
  if (vK > 0.5 && !gl_FrontFacing) l *= 0.55;          // dentro l'elemento tagliato: come una sezione
  gl_FragColor = vec4(min(vC.rgb * l, vec3(1.0)), vC.a);
}`;
const L1 = new THREE.Vector3(0.35, -0.55, 0.76).normalize(), L2 = new THREE.Vector3(-0.6, 0.65, 0.3).normalize();
const _v = new THREE.Vector3(), _w = new THREE.Vector3(), _c = new THREE.Color();

export class Stage {
  /* canvas: il <canvas> a tutto schermo; freeArea(): lo spazio libero fra i pannelli in px del client */
  constructor(canvas, { freeArea = null } = {}) {
    this.canvas = canvas;
    this.freeArea = freeArea;
    const R = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    R.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
    this.scene = new THREE.Scene();
    this.pickScene = new THREE.Scene();
    const cam = this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e5);
    cam.up.set(0, 0, 1);
    cam.position.set(-60, -120, 80);
    /* il perno sotto il cursore va messo PRIMA che OrbitControls legga il tasto: ascoltatori in cattura */
    this.lastWheel = 0;
    canvas.addEventListener("pointerdown", (e) => {
      this.fly = null;
      if (e.button > 2 || !this.models.size) return;
      const hit = this.pick(e.clientX, e.clientY);
      if (hit && hit.point) this.pivotTo(hit.point);
    }, { capture: true });
    canvas.addEventListener("wheel", (e) => {
      this.fly = null;
      const now = performance.now();
      if (now - this.lastWheel > 300 && this.models.size) { const hit = this.pick(e.clientX, e.clientY); if (hit && hit.point) this.pivotTo(hit.point); }
      this.lastWheel = now;
    }, { capture: true, passive: true });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    canvas.addEventListener("mousedown", (e) => { if (e.button === 1) e.preventDefault(); });   // tasto della rotella: niente scorrimento automatico
    const C = this.controls = new OrbitControls(cam, canvas);
    C.enableDamping = true; C.dampingFactor = 0.12;
    C.screenSpacePanning = true;
    C.zoomToCursor = true;
    C.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    C.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    C.addEventListener("change", () => this.request());
    this.models = new Map();         // key → { key, mi, n, data, tex, mats, group, pgroup }
    this.byMi = new Map();
    this.seq = 0;
    this.box = new THREE.Box3();
    this.fly = null;
    this.raf = 0;
    /* bersaglio float per la scelta col clic (WebGL2 + EXT_color_buffer_float: quasi ovunque); se no a byte, senza profondità */
    this.float = !!(R.capabilities.isWebGL2 && R.extensions.has("EXT_color_buffer_float"));
    this.pickRT = new THREE.WebGLRenderTarget(1, 1, { type: this.float ? THREE.FloatType : THREE.UnsignedByteType, format: THREE.RGBAFormat,
      minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, generateMipmaps: false });
    this.pickBuf = this.float ? new Float32Array(4) : new Uint8Array(4);
    /* il fronte della sequenza: intervalli dei piani (quota, lungo l'asse) e l'asse, uguali per tutti i modelli */
    this.uCut = { value: new THREE.Vector4(0, 1, 0, 1) };
    this.uAxis = { value: new THREE.Vector2(1, 0) };
    this.setTheme(true);
  }
  /* range: { 1: [zmin, zmax], 2: [min, max] lungo l'asse }, axis: [ux, uy] (seq-play prepare) */
  setCut(range, axis) {
    const r = (k) => (range && range[k] && Number.isFinite(range[k][0]) && range[k][1] > range[k][0] ? range[k] : [0, 1]);
    const z = r(1), a = r(2);
    this.uCut.value.set(z[0], z[1], a[0], a[1]);
    if (axis) this.uAxis.value.set(axis[0], axis[1]);
    this.request();
  }

  setTheme(light) {
    this.light = light;
    this.renderer.setClearColor(new THREE.Color(light ? 0xdde2d5 : 0x262b24));   // come Sviluppo profili e Trazione elettrica
    this.request();
  }

  /* ---- modelli ---- */
  addModel(key, { blocks, n }) {
    const mi = this.seq++;
    const h = Math.max(1, Math.ceil(2 * n / ST_W));
    const data = new Uint8Array(ST_W * h * 4);
    for (let k = 0; k < n; k++) { data[8 * k + 4] = 255; data[8 * k + 5] = F_PICK; }
    const tex = new THREE.DataTexture(data, ST_W, h, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.generateMipmaps = false; tex.needsUpdate = true;
    const mk = (pass, extra) => new THREE.ShaderMaterial({
      uniforms: { uState: { value: tex }, uPass: { value: pass }, uModel: { value: mi }, uL1: { value: L1 }, uL2: { value: L2 }, uCut: this.uCut, uAxis: this.uAxis },
      vertexShader: VS, fragmentShader: FS, side: THREE.DoubleSide, ...extra,
    });
    const mats = { solid: mk(0, {}), glass: mk(1, { transparent: true, depthWrite: false }), pick: mk(2, { blending: THREE.NoBlending, defines: this.float ? {} : { PICK8: 1 } }) };
    const group = new THREE.Group(), pgroup = new THREE.Group();
    for (const b of blocks) {
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(b.P, 3));
      g.setAttribute("rgba", new THREE.BufferAttribute(b.C, 4, true));
      g.setAttribute("eid", new THREE.BufferAttribute(b.E, 1));
      g.setIndex(new THREE.BufferAttribute(b.I, 1));
      g.computeBoundingBox(); g.computeBoundingSphere();
      const ms = new THREE.Mesh(g, mats.solid), mg = new THREE.Mesh(g, mats.glass), mp = new THREE.Mesh(g, mats.pick);
      mg.renderOrder = 2;
      for (const o of [ms, mg, mp]) o.matrixAutoUpdate = false;
      group.add(ms, mg); pgroup.add(mp);
    }
    this.scene.add(group); this.pickScene.add(pgroup);
    const M = { key, mi, n, data, tex, mats, group, pgroup };
    this.models.set(key, M); this.byMi.set(mi, key);
    this.updateBox();
    this.request();
    return M;
  }
  removeModel(key) {
    const M = this.models.get(key);
    if (!M) return;
    this.scene.remove(M.group); this.pickScene.remove(M.pgroup);
    for (const o of M.group.children) o.geometry.dispose();
    for (const m of Object.values(M.mats)) m.dispose();
    M.tex.dispose();
    this.models.delete(key); this.byMi.delete(M.mi);
    this.updateBox();
    this.request();
  }
  /* lo stato (M.data) è stato riscritto: la texture si ricarica al prossimo fotogramma */
  touch(key) { const M = this.models.get(key); if (M) { M.tex.needsUpdate = true; this.request(); } }
  setVisible(key, on) { const M = this.models.get(key); if (M) { M.group.visible = M.pgroup.visible = on; this.updateBox(); this.request(); } }
  updateBox() {
    this.box.makeEmpty();
    for (const M of this.models.values()) if (M.group.visible) for (const o of M.group.children) if (o.geometry.boundingBox) this.box.union(o.geometry.boundingBox);
  }

  /* ---- disegno su richiesta: un fotogramma quando qualcosa cambia, finché lo smorzamento o un volo si muovono ---- */
  request() { if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }
  frame(now) {
    this.raf = 0;
    if (this.fly) this.fly(now);
    const moved = this.controls.update();
    this.render();
    if (moved || this.fly) this.request();
  }
  /* senza fotogrammi (pagina nascosta, prove): disegna subito */
  renderNow() { if (this.fly) this.fly(performance.now() + 1e6); this.controls.update(); this.render(); }
  nearFar() {
    const cam = this.camera, d = Math.max(1e-3, cam.position.distanceTo(this.controls.target));
    let far = d * 4 + 100;
    if (!this.box.isEmpty()) { const c = this.box.getCenter(_v), r = this.box.getSize(_w).length() / 2; far = Math.max(far, cam.position.distanceTo(c) + r * 1.3 + 10); }
    const near = Math.max(0.01, Math.min(d / 600, 2, far / 2e4));
    if (Math.abs(cam.near - near) > near * 1e-3 || Math.abs(cam.far - far) > far * 1e-3) { cam.near = near; cam.far = far; cam.updateProjectionMatrix(); }
  }
  render() { this.nearFar(); this.renderer.render(this.scene, this.camera); }
  resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h || (w === this.w && h === this.h)) return;   // stessa misura: niente setSize (svuota la tela)
    this.w = w; this.h = h;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.request();
  }

  /* ---- scelta col clic: un pixel su un bersaglio a parte → { key, k, point } o null ---- */
  pick(cx, cy) {
    const r = this.canvas.getBoundingClientRect(), x = cx - r.left, y = cy - r.top;
    if (!this.models.size || x < 0 || y < 0 || x >= r.width || y >= r.height) return null;
    const R = this.renderer, cam = this.camera;
    this.nearFar();
    const cc = R.getClearColor(_c).getHex(), ca = R.getClearAlpha(), prev = R.getRenderTarget();
    cam.setViewOffset(r.width, r.height, Math.floor(x), Math.floor(y), 1, 1);
    R.setRenderTarget(this.pickRT); R.setClearColor(0x000000, 0); R.clear();
    R.render(this.pickScene, cam);
    R.setRenderTarget(prev); R.setClearColor(cc, ca);
    cam.clearViewOffset();
    const b = this.pickBuf;
    R.readRenderTargetPixels(this.pickRT, 0, 0, 1, 1, b);
    let k, mi, depth = null;
    if (this.float) { if (!(b[0] >= 0.5)) return null; k = Math.round(b[0]) - 1; mi = Math.round(b[1]) - 1; depth = b[2]; }
    else { const id = b[0] + b[1] * 256 + b[2] * 65536; if (!id) return null; k = id - 1; mi = b[3] - 1; }
    const key = this.byMi.get(mi);
    if (key == null) return null;
    let point = null;
    if (depth != null && depth > 0) {
      const dir = new THREE.Vector3((x / r.width) * 2 - 1, -(y / r.height) * 2 + 1, 0.5).unproject(cam).sub(cam.position).normalize();
      const fwd = cam.getWorldDirection(_w), c = dir.dot(fwd);
      if (c > 1e-6) point = cam.position.clone().addScaledVector(dir, depth / c);
    }
    return { key, k, point };
  }
  /* il target scivola lungo l'asse di vista alla profondità di P: la vista non salta, orbita e zoom diventano locali a quel punto */
  pivotTo(P) {
    const cam = this.camera, dir = cam.getWorldDirection(_w), t = _v.subVectors(P, cam.position).dot(dir);
    if (t > 1e-3) this.controls.target.copy(cam.position).addScaledVector(dir, t);
  }

  /* ---- inquadrature (come frameAll di Sviluppo profili: gli 8 spigoli nello spazio libero fra i pannelli) ---- */
  frameBox(box, { dir = null, fly = false } = {}) {
    if (!box || box.isEmpty()) return;
    const cam = this.camera, cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
    if (!cw || !ch) return;
    const rc = this.canvas.getBoundingClientRect();
    const fa = (this.freeArea && this.freeArea()) || { L: rc.left, R: rc.right, T: rc.top, B: rc.bottom };
    const L = fa.L - rc.left, Rr = fa.R - rc.left, T = fa.T - rc.top, B = fa.B - rc.top;
    const pts = [];
    for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) pts.push(new THREE.Vector3(x, y, z));
    const d0 = dir ? dir.clone().normalize() : new THREE.Vector3(-0.35, -0.75, 0.56).normalize();
    const vfov = THREE.MathUtils.degToRad(cam.fov);
    const was = { p: cam.position.clone(), q: cam.quaternion.clone() };
    const tgt = box.getCenter(new THREE.Vector3()), right = new THREE.Vector3(), up = new THREE.Vector3();
    let d = Math.max(2, box.getSize(new THREE.Vector3()).length());
    for (let it = 0; it < 7; it++) {
      cam.position.copy(tgt).addScaledVector(d0, d);
      cam.lookAt(tgt);
      cam.updateMatrixWorld();
      let a = Infinity, b = -Infinity, c = Infinity, e = -Infinity;
      for (const p of pts) {
        const v = p.clone().project(cam), sx = (v.x + 1) / 2 * cw, sy = (1 - v.y) / 2 * ch;
        a = Math.min(a, sx); b = Math.max(b, sx); c = Math.min(c, sy); e = Math.max(e, sy);
      }
      const wpp = 2 * d * Math.tan(vfov / 2) / ch;
      right.setFromMatrixColumn(cam.matrixWorld, 0); up.setFromMatrixColumn(cam.matrixWorld, 1);
      tgt.addScaledVector(right, ((a + b) / 2 - (L + Rr) / 2) * wpp).addScaledVector(up, ((T + B) / 2 - (c + e) / 2) * wpp);
      d = Math.max(0.5, d * Math.max((b - a) / Math.max(40, Rr - L), (e - c) / Math.max(40, B - T)) * 1.05);
    }
    const pos = tgt.clone().addScaledVector(d0, d);
    cam.position.copy(was.p); cam.quaternion.copy(was.q); cam.updateMatrixWorld();
    if (fly) this.flyTo(pos, tgt);
    else { this.fly = null; this.controls.target.copy(tgt); cam.position.copy(pos); this.controls.update(); this.request(); }
  }
  frameAll(opt) { this.updateBox(); this.frameBox(this.box, opt); }
  frameRange(lo, hi, opt) { this.frameBox(new THREE.Box3(new THREE.Vector3(lo[0], lo[1], lo[2]), new THREE.Vector3(hi[0], hi[1], hi[2])), opt); }
  /* dall'alto: inclinata di 2 millesimi, così OrbitControls (up = +z) non resta sulla verticale */
  frameTop(box = this.box) { this.frameBox(box, { dir: new THREE.Vector3(0, -0.002, 1), fly: true }); }
  viewDir() { return this.camera.position.clone().sub(this.controls.target).normalize(); }
  /* volo della camera (come flyTo del viewer): 0,6 s ease-in-out; un clic o la rotella lo interrompono */
  flyTo(pos, tgt, ms = 600) {
    if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) ms = 0;
    const cam = this.camera, p0 = cam.position.clone(), t0 = this.controls.target.clone(), start = performance.now();
    this.fly = (now) => {
      let k = ms > 0 ? Math.min(1, (now - start) / ms) : 1;
      k = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      cam.position.lerpVectors(p0, pos, k);
      this.controls.target.lerpVectors(t0, tgt, k);
      cam.lookAt(this.controls.target);
      if (k >= 1) { this.fly = null; this.controls.update(); this.controls.dispatchEvent({ type: "end" }); }
    };
    this.request();
  }

  /* ---- la vista si salva col lavoro ---- */
  getView() { const p = this.camera.position, t = this.controls.target; return { p: [p.x, p.y, p.z], t: [t.x, t.y, t.z] }; }
  setView(v) {
    if (!v || !Array.isArray(v.p) || !Array.isArray(v.t) || ![...v.p, ...v.t].every(Number.isFinite)) return false;
    this.fly = null;
    this.camera.position.set(v.p[0], v.p[1], v.p[2]); this.controls.target.set(v.t[0], v.t[1], v.t[2]);
    this.controls.update(); this.request();
    return true;
  }
}
