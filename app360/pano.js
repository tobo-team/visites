// pano.js : afficheur d'image 360° (équirectangulaire) en WebGL, sans dépendance.
// new Pano(canvas) ; await p.charger(url) ; p.yaw, p.pitch (radians), p.fov (degrés) ; p.projeter(azRel, el) -> {x, y, devant} en pixels CSS.
// Le centre de l'image est yaw = 0. Tourner à droite augmente yaw.
const VS = `attribute vec2 p; varying vec2 v; void main(){ v = p; gl_Position = vec4(p, 0.0, 1.0); }`;
const FS = (gl2) => `${gl2 ? "#version 300 es\n" : "#extension GL_OES_standard_derivatives : enable\n"}precision highp float;
${gl2 ? "in vec2 v; out vec4 o;" : "varying vec2 v;"}
uniform sampler2D t0, t1; uniform float mel, yaw, pitch, th, asp, dec;
vec3 dir(){ vec3 d = normalize(vec3(v.x * th * asp, v.y * th, -1.0));
  float cp = cos(pitch), sp = sin(pitch); d = vec3(d.x, d.y * cp - d.z * sp, d.y * sp + d.z * cp);
  float cy = cos(yaw), sy = sin(yaw); return vec3(d.x * cy - d.z * sy, d.y, d.x * sy + d.z * cy); }
void main(){ vec3 d = dir(); float lon = atan(d.x, -d.z), lat = asin(clamp(d.y, -1.0, 1.0));
  float u = lon / 6.283185307 + 0.5, w = 0.5 - lat / 3.141592654;
  ${gl2 ? `float ub = fract(u + 0.5) - 0.5;   // même cap, mais la couture est de l'autre côté : on dérive les deux et on garde la dérivée qui ne saute pas
  vec2 da = vec2(dFdx(u), dFdy(u)), db = vec2(dFdx(ub), dFdy(ub)); vec2 du = dot(da, da) <= dot(db, db) ? da : db;
  vec2 gx = vec2(du.x, dFdx(w)), gy = vec2(du.y, dFdy(w));
  vec4 a = textureGrad(t0, vec2(u, w), gx, gy), b = textureGrad(t1, vec2(u + dec, w), gx, gy); o = mix(a, b, mel);`
  : `vec4 a = texture2D(t0, vec2(fract(u), w)), b = texture2D(t1, vec2(fract(u + dec), w)); gl_FragColor = mix(a, b, mel);`} }`;

export class Pano {
  constructor(canvas) {
    this.c = canvas; this.yaw = 0; this.pitch = 0; this.fov = 80; this.mel = 0; this.dec = 0; this.surChange = null;
    const gl = canvas.getContext("webgl2", { antialias: false }) || canvas.getContext("webgl", { antialias: false });
    if (!gl) throw new Error("WebGL absent");
    this.gl = gl; this.gl2 = typeof WebGL2RenderingContext !== "undefined" && gl instanceof WebGL2RenderingContext;
    if (!this.gl2) gl.getExtension("OES_standard_derivatives");
    const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    const vs = this.gl2 ? VS.replace("attribute", "in").replace("varying", "out").replace(/^/, "#version 300 es\n") : VS;
    const pr = gl.createProgram(); gl.attachShader(pr, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS(this.gl2)));
    gl.linkProgram(pr); if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(pr));
    gl.useProgram(pr); this.pr = pr;
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const l = gl.getAttribLocation(pr, "p"); gl.enableVertexAttribArray(l); gl.vertexAttribPointer(l, 2, gl.FLOAT, false, 0, 0);
    this.u = {}; for (const n of ["t0", "t1", "mel", "yaw", "pitch", "th", "asp", "dec"]) this.u[n] = gl.getUniformLocation(pr, n);
    this.tex = [this._tex(), this._tex()]; this.sale = true;
    this._souris(); new ResizeObserver(() => { this.dessiner(); }).observe(canvas);
    const boucle = () => { if (this.sale) this.dessiner(); requestAnimationFrame(boucle); }; requestAnimationFrame(boucle);
  }
  _tex() { const gl = this.gl, t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 22, 255])); return t; }
  _remplir(t, img) { const gl = this.gl; let src = img; const max = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 8192);
    if (img.width > max) { const k = max / img.width, cv = document.createElement("canvas"); cv.width = max; cv.height = Math.round(img.height * k);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height); src = cv; }
    gl.bindTexture(gl.TEXTURE_2D, t); gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.gl2) { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT); gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      const an = gl.getExtension("EXT_texture_filter_anisotropic"); if (an) gl.texParameterf(gl.TEXTURE_2D, an.TEXTURE_MAX_ANISOTROPY_EXT, 4);
    } else { gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR); }
  static image(url) { return new Promise((ok, ko) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => ko(new Error("image absente : " + url)); i.src = url; }); }
  // charge une image ; fondu = durée du fondu enchaîné en ms (0 : remplacement sec) ; decalage = cap de l'ancienne image moins cap de la
  // nouvelle (radians) : pendant le fondu les deux images restent calées sur la même direction réelle, et le regard est conservé à l'arrivée
  async charger(url, fondu = 0, decalage = 0) {
    const img = await Pano.image(url);
    if (!fondu) { this._remplir(this.tex[0], img); this.mel = 0; this.yaw += decalage; this.sale = true; return; }
    this._remplir(this.tex[1], img); this.dec = decalage; const t0 = performance.now();
    await new Promise((fin) => { const pas = () => { const t = Math.min(1, (performance.now() - t0) / fondu); this.mel = t * t * (3 - 2 * t); this.sale = true;
      if (t < 1) requestAnimationFrame(pas); else { this.tex.reverse(); this.mel = 0; this.yaw += decalage; this.dec = 0; this.sale = true; fin(); } }; pas(); });
  }
  dessiner() { const gl = this.gl, c = this.c, r = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(c.clientWidth * r)), h = Math.max(1, Math.round(c.clientHeight * r));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
    gl.viewport(0, 0, w, h); gl.useProgram(this.pr);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.tex[0]); gl.uniform1i(this.u.t0, 0);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.tex[1]); gl.uniform1i(this.u.t1, 1);
    gl.uniform1f(this.u.mel, this.mel); gl.uniform1f(this.u.dec, this.dec / 6.283185307); gl.uniform1f(this.u.yaw, this.yaw); gl.uniform1f(this.u.pitch, this.pitch);
    gl.uniform1f(this.u.th, Math.tan(this.fov * Math.PI / 360)); gl.uniform1f(this.u.asp, w / h);
    gl.drawArrays(gl.TRIANGLES, 0, 3); this.sale = false; if (this.surChange) this.surChange(); }
  // direction (azimut relatif au centre de l'image, élévation, en radians) -> position à l'écran
  projeter(az, el) { const c = this.c, th = Math.tan(this.fov * Math.PI / 360), asp = c.clientWidth / c.clientHeight;
    let x = Math.sin(az) * Math.cos(el), y = Math.sin(el), z = -Math.cos(az) * Math.cos(el);
    const cy = Math.cos(-this.yaw), sy = Math.sin(-this.yaw); [x, z] = [x * cy - z * sy, x * sy + z * cy];
    const cp = Math.cos(-this.pitch), sp = Math.sin(-this.pitch); [y, z] = [y * cp - z * sp, y * sp + z * cp];
    return { devant: z < -0.05, x: (x / -z / (th * asp) * 0.5 + 0.5) * c.clientWidth, y: (0.5 - y / -z / th * 0.5) * c.clientHeight }; }
  tourner(dyaw, dpitch) { this.yaw += dyaw; this.pitch = Math.max(-1.45, Math.min(1.45, this.pitch + dpitch)); this.sale = true; }
  _souris() { const c = this.c; let prise = null, vy = 0, vp = 0, doigts = new Map(), ecart = 0;
    c.style.touchAction = "none"; c.style.cursor = "grab";
    const k = () => (this.fov * Math.PI / 180) / c.clientHeight;
    c.addEventListener("pointerdown", (e) => { c.setPointerCapture(e.pointerId); doigts.set(e.pointerId, e); prise = { x: e.clientX, y: e.clientY }; vy = vp = 0; c.style.cursor = "grabbing";
      if (doigts.size === 2) { const [a, b] = [...doigts.values()]; ecart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); } });
    c.addEventListener("pointermove", (e) => { if (!doigts.has(e.pointerId)) return; doigts.set(e.pointerId, e);
      if (doigts.size === 2) { const [a, b] = [...doigts.values()]; const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
        if (ecart) { this.fov = Math.max(35, Math.min(100, this.fov * ecart / d)); this.sale = true; } ecart = d; return; }
      if (!prise) return; const dx = e.clientX - prise.x, dy = e.clientY - prise.y; prise = { x: e.clientX, y: e.clientY };
      vy = -dx * k(); vp = dy * k(); this.tourner(vy, vp); });
    const lacher = (e) => { doigts.delete(e.pointerId); if (doigts.size) return; prise = null; c.style.cursor = "grab";
      const glisse = () => { if (prise || (Math.abs(vy) < 1e-4 && Math.abs(vp) < 1e-4)) return; vy *= 0.92; vp *= 0.92; this.tourner(vy, vp); requestAnimationFrame(glisse); }; glisse(); };
    c.addEventListener("pointerup", lacher); c.addEventListener("pointercancel", lacher);
    c.addEventListener("wheel", (e) => { e.preventDefault(); this.fov = Math.max(35, Math.min(100, this.fov + e.deltaY * 0.04)); this.sale = true; }, { passive: false }); }
}
