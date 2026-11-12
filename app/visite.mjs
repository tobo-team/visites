// Visualiseur générique PLAN3D. Aucune valeur propre à un lot : tout vient de visite.json,
// lot.glb et obstacles.json, posés à côté de la page qui charge ce script.
const APP = new URL(".", import.meta.url);           // dossier du visualiseur (moteur 3D, ciel)
const ICI = new URL(".", location.href);             // dossier de la visite
const ID = location.pathname.replace(/\/(index\.html)?$/, "").split("/").pop() || "?";
const params = new URLSearchParams(location.search);
const $ = (id) => document.getElementById(id);

const TEXTES = {
  fr: { charge: "Chargement de la visite", pret: "Prêt", aideBureau: "Glissez pour regarder · ZQSD ou flèches pour avancer",
        aideTactile: "Pouce gauche pour avancer · glissez à droite pour regarder", mention: "Visite indicative, non contractuelle",
        sansWebgl: "Votre appareil ne peut pas afficher la visite en 3D. Voici un aperçu du logement.",
        panne: "La visite n'a pas pu se charger. Rechargez la page pour réessayer." },
  en: { charge: "Loading the tour", pret: "Ready", aideBureau: "Drag to look around · WASD or arrow keys to move",
        aideTactile: "Left thumb to walk · drag on the right to look around", mention: "Indicative tour, not contractual",
        sansWebgl: "Your device cannot display the 3D tour. Here is a preview of the home.",
        panne: "The tour could not load. Please reload the page." },
};

// ---------------------------------------------------------------- compteur d'ouvertures
// Une ligne anonyme (« ouverture <id> », puis « 30s <id> »). Aucun cookie, aucune donnée personnelle.
// Coupé en local pour que les essais ne comptent pas ; une panne du service ne casse rien.
const COMPTEUR = "https://ntfy.sh/plan3d-3b293a83d4538972eb";
const enLocal = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/.test(location.hostname) || location.protocol === "file:";
window.__compteur = [];
const compter = (quoi) => {
  const corps = `${quoi} ${ID}`;
  window.__compteur.push(corps);
  if (enLocal && params.get("compteur") !== "1") return;
  try { fetch(COMPTEUR, { method: "POST", body: corps, keepalive: true, mode: "no-cors" }).catch(() => {}); } catch (e) {}
};
compter("ouverture");
{ let vu = 0; const t = setInterval(() => { if (!document.hidden && ++vu >= 30) { clearInterval(t); compter("30s"); } }, 1000); }

// ---------------------------------------------------------------- contrat
let V = {};
try { const r = await fetch(new URL("visite.json", ICI), { cache: "no-cache" }); if (r.ok) V = await r.json(); } catch (e) {}
const L = TEXTES[V.langue === "en" ? "en" : "fr"];
document.documentElement.lang = V.langue === "en" ? "en" : "fr";
const mention = V.mention || L.mention;
if (V.titre) { $("titre-b").textContent = V.titre; $("charge-h").textContent = V.titre; document.title = V.titre; }
if (V.sousTitre !== undefined) { $("titre-s").textContent = V.sousTitre; $("charge-p").textContent = V.sousTitre; }
$("mention").textContent = mention; $("charge-legal").textContent = mention;
$("charge-etat").textContent = L.charge;
const apercu = new URL(V.apercu || "apercu.jpg", ICI).href;

const repli = (message) => {
  const c = $("charge"); c.classList.add("repli"); c.classList.remove("fini");
  $("charge-etat").textContent = message;
  const img = c.querySelector(".apercu"); img.src = apercu; img.onerror = () => img.remove();
};

// ---------------------------------------------------------------- WebGL disponible ?
const webgl = (() => { try { const t = document.createElement("canvas"); return !!(t.getContext("webgl2") || t.getContext("webgl")); } catch (e) { return false; } })();
if (!webgl || params.get("repli") === "1") { repli(L.sansWebgl); throw new Error("sans WebGL"); }

// ---------------------------------------------------------------- téléchargements avec progression
const avance = {};
const montrer = () => {
  let fait = 0, total = 0;
  for (const k in avance) { fait += Math.min(avance[k].fait, avance[k].total); total += avance[k].total; }
  $("charge-barre").style.width = `${Math.round((total ? fait / total : 0) * 100)}%`;
};
const telecharger = async (url, estimation) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url} : ${r.status}`);
  // en-tête faux si le serveur compresse : on prend le plus grand des deux et on borne
  const annonce = +r.headers.get("content-length") || 0;
  const a = (avance[url] = { fait: 0, total: Math.max(annonce, estimation) });
  if (!r.body) { const b = await r.arrayBuffer(); a.fait = a.total; montrer(); return b; }
  const lecteur = r.body.getReader(), morceaux = [];
  for (;;) {
    const { done, value } = await lecteur.read();
    if (done) break;
    morceaux.push(value); a.fait += value.length; if (a.fait > a.total) a.total = a.fait * 1.02;
    montrer();
  }
  a.fait = a.total; montrer();
  return new Blob(morceaux);
};

const urlMoteur = new URL("playcanvas.mjs", APP).href;
const urlCiel = new URL("ciel.jpg", APP).href;
const urlGlb = new URL(V.glb || "lot.glb", ICI).href;
const urlObs = new URL(V.obstacles || "obstacles.json", ICI).href;

let pc, blobGlb, blobCiel, obstacles;
try {
  [, blobGlb, blobCiel, obstacles] = await Promise.all([
    telecharger(urlMoteur, 3.9e6).then(() => import(urlMoteur)).then((m) => (pc = m)),
    telecharger(urlGlb, 11e6),
    telecharger(urlCiel, 0.5e6),
    fetch(urlObs).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
} catch (e) { console.error(e); repli(L.panne); throw e; }

// ---------------------------------------------------------------- moteur
const canvas = $("c");
const tactile = matchMedia("(pointer: coarse)").matches;
let app;
try { app = new pc.Application(canvas, {}); } catch (e) { repli(L.sansWebgl); throw e; }
const gd = app.graphicsDevice;
// Pleine définition Retina = coût quadruplé pour un gain invisible en mouvement. Le régulateur
// redescend d'un cran si l'appareil peine, et ne remonte jamais.
const RATIOS = (tactile ? [1.5, 1.25, 1, 0.85] : [1.25, 1, 0.85]).filter((r) => r <= Math.max(1, window.devicePixelRatio || 1));
if (!RATIOS.length) RATIOS.push(1);
let palier = 0;
gd.maxPixelRatio = RATIOS[0];
app.setCanvasFillMode(pc.FILLMODE_FILL_WINDOW);
app.setCanvasResolution(pc.RESOLUTION_AUTO);
app.autoRender = false;                               // scène immobile : on ne dessine que si la vue change
let reveil = 0;
const dessiner = (n = 20) => { reveil = Math.max(reveil, n); };
addEventListener("resize", () => { app.resizeCanvas(); dessiner(); });

// ---------------------------------------------------------------- géométrie du lot
const boite = obstacles.length
  ? obstacles.reduce((b, o) => [Math.min(b[0], o[0]), Math.min(b[1], o[1]), Math.max(b[2], o[2]), Math.max(b[3], o[3])], [1e9, 1e9, -1e9, -1e9])
  : [-10, -10, 10, 10];
const LIM = Array.isArray(V.limites) && V.limites.length === 4 ? V.limites : boite;
const OEIL = +V.hauteurOeil || 1.6;
const R = 0.22;                                       // rayon du visiteur
const libre = (x, z) => {
  if (x < LIM[0] + 0.05 || x > LIM[2] - 0.05 || z < LIM[1] + 0.05 || z > LIM[3] - 0.05) return false;
  for (const b of obstacles) {
    const cx = Math.max(b[0], Math.min(x, b[2])), cz = Math.max(b[1], Math.min(z, b[3]));
    if ((x - cx) ** 2 + (z - cz) ** 2 < R * R) return false;
  }
  return true;
};
const degagement = (x, z) => {
  let d = 3;
  for (const b of obstacles) { const cx = Math.max(b[0], Math.min(x, b[2])), cz = Math.max(b[1], Math.min(z, b[3])); d = Math.min(d, Math.hypot(x - cx, z - cz)); }
  return d;
};
// Un point est dedans si, dans les quatre directions, on bute sur un obstacle avant les limites.
const enferme = (x, z) => {
  let n = 0;
  for (const b of obstacles) {
    if (z >= b[1] && z <= b[3]) { if (b[2] <= x) n |= 1; if (b[0] >= x) n |= 2; }
    if (x >= b[0] && x <= b[2]) { if (b[3] <= z) n |= 4; if (b[1] >= z) n |= 8; }
    if (n === 15) return true;
  }
  return false;
};
// Départ par défaut : le centre de la plus grande zone libre intérieure.
const departAuto = () => {
  let mieux = null;
  for (let x = LIM[0]; x <= LIM[2]; x += 0.2) for (let z = LIM[1]; z <= LIM[3]; z += 0.2) {
    if (!libre(x, z) || !enferme(x, z)) continue;
    const d = degagement(x, z);
    if (!mieux || d > mieux.d) mieux = { x, z, d };
  }
  if (!mieux) return { x: (LIM[0] + LIM[2]) / 2, z: (LIM[1] + LIM[3]) / 2, cx: LIM[2], cz: LIM[3] };
  // regarder vers le point libre le plus lointain visible en ligne droite
  let cx = mieux.x + 1, cz = mieux.z, loin = 0;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 18) {
    let t = 0.2; while (t < 20 && libre(mieux.x + Math.cos(a) * t, mieux.z + Math.sin(a) * t)) t += 0.1;
    if (t > loin) { loin = t; cx = mieux.x + Math.cos(a) * t; cz = mieux.z + Math.sin(a) * t; }
  }
  return { x: mieux.x, z: mieux.z, cx, cz };
};
// Un poste tombé dans un meuble est décalé vers le point libre le plus proche.
const recaler = (p) => {
  if (libre(p.x, p.z)) return p;
  for (let r = 0.1; r < 2; r += 0.1) for (let a = 0; a < Math.PI * 2; a += Math.PI / 12) {
    const x = p.x + Math.cos(a) * r, z = p.z + Math.sin(a) * r;
    if (libre(x, z)) return { ...p, x, z };
  }
  return p;
};
const valide = (p) => p && isFinite(p.x) && isFinite(p.z);
// Un regard qui bute sur un mur à moins de 1,5 m est remplacé par la direction la plus dégagée.
const rayon = (x, z, a, max = 20) => { let t = 0.25; while (t < max && libre(x + Math.cos(a) * t, z + Math.sin(a) * t)) t += 0.1; return t; };
// ouverture d'un regard : longueur libre moyenne sur un cône de 70°
const cone = (x, z, a) => { let t = 0; for (let i = -3; i <= 3; i++) t += rayon(x, z, a + i * 0.2, 8); return t / 7; };
const regarder = (p) => {
  const a0 = Math.atan2(p.cz - p.z, p.cx - p.x);
  if (isFinite(a0) && rayon(p.x, p.z, a0, 1.6) >= 1.5 && cone(p.x, p.z, a0) >= 2.2) return p;
  let mieux = a0, score = -1;
  for (let a = 0; a < Math.PI * 2; a += Math.PI / 36) { const c = cone(p.x, p.z, a); if (c > score) { score = c; mieux = a; } }
  const loin = rayon(p.x, p.z, mieux);
  return { ...p, cx: p.x + Math.cos(mieux) * loin, cz: p.z + Math.sin(mieux) * loin };
};
const PIECES = (Array.isArray(V.pieces) ? V.pieces : []).filter(valide).map((p) => regarder(recaler({ cx: p.x + 1, cz: p.z, ...p })));
const DEPART = regarder(recaler(valide(V.depart) ? { cx: V.depart.x + 1, cz: V.depart.z, ...V.depart } : PIECES[0] || departAuto()));

// ---------------------------------------------------------------- caméra et rendu des tons
const DEG = 180 / Math.PI;
const camera = new pc.Entity("camera");
camera.addComponent("camera", { fov: tactile && innerHeight > innerWidth ? 78 : 70, nearClip: 0.05, farClip: 300 });
app.root.addChild(camera);
addEventListener("resize", () => { camera.camera.fov = tactile && innerHeight > innerWidth ? 78 : 70; });
const cadre = new pc.CameraFrame(app, camera.camera);
cadre.rendering.toneMapping = pc.TONEMAP_NEUTRAL;
cadre.rendering.samples = tactile ? 2 : 4;
// Occlusion ambiante légère, 8 échantillons (16 en Retina coûtaient 28 ms dans le pilote).
cadre.ssao.type = pc.SSAOTYPE_LIGHTING;
cadre.ssao.intensity = 0.45;
cadre.ssao.radius = 0.2;
cadre.ssao.samples = 8;
cadre.ssao.blurEnabled = true;
cadre.bloom.intensity = 0.015;
cadre.bloom.blurLevel = 10;
cadre.grading.enabled = true;                          // étalonnage chaud, lumière dorée
cadre.grading.tint = new pc.Color(1.0, 0.97, 0.92);
cadre.grading.contrast = 1.16;
cadre.grading.saturation = 1.05;
cadre.grading.brightness = 1.0;
cadre.vignette.intensity = 0.25;
cadre.vignette.inner = 0.6;
cadre.vignette.outer = 1.4;
cadre.update();

// ---------------------------------------------------------------- lumière
const LUM = V.lumiere || {};
const S = { azimut: 210, elevation: 35, couleur: [1, 0.9, 0.76], intensite: 3, ...(LUM.soleil || {}) };
const AMB = { couleur: [1, 0.96, 0.9], intensite: 0.6, ...(LUM.ambiance || {}) };
const LAMPES = Array.isArray(LUM.lampes) ? LUM.lampes : [];
const couleur = (c, k = 1) => new pc.Color(c[0] * k, c[1] * k, c[2] * k);

const soleil = new pc.Entity("soleil");
soleil.addComponent("light", {
  type: "directional", color: couleur(S.couleur), intensity: S.intensite * 2.0,   // 3 ≈ soleil du pilote
  castShadows: true, shadowResolution: tactile ? 2048 : 4096, shadowType: pc.SHADOW_PCF5_32F,
  shadowBias: 0.05, normalOffsetBias: 0.04, numCascades: 1,
});
app.root.addChild(soleil);
{ // azimut boussole (0 = nord = -z, 90 = est = +x), élévation au-dessus de l'horizon
  const az = S.azimut / DEG, el = S.elevation / DEG;
  const versSoleil = [Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)];
  soleil.lookAt(-versSoleil[0], -versSoleil[1], -versSoleil[2]);
  soleil.rotateLocal(90, 0, 0);
}
for (const l of LAMPES.slice(0, tactile ? 4 : 8)) {
  const e = new pc.Entity("lampe");
  e.addComponent("light", { type: "omni", color: couleur(l.couleur || [1, 0.85, 0.65]), intensity: (+l.intensite || 6) * 0.08,
    range: +l.portee || 5, falloffMode: pc.LIGHTFALLOFF_INVERSESQUARED, castShadows: false });
  e.setPosition(+l.x || 0, +l.y || 2.2, +l.z || 0);
  app.root.addChild(e);
}

// Ombres figées : calculées une seule fois depuis une caméra lointaine et serrée qui englobe tout
// le logement. Recalculées à chaque image elles coûtaient 9 ms dans le pilote.
const figerLesOmbres = () => {
  const c = camera.camera, l = soleil.light;
  const avant = { fov: c.fov, near: c.nearClip, mode: c.aspectRatioMode, aspect: c.aspectRatio, pos: camera.getPosition().clone(), rot: camera.getRotation().clone() };
  const mx = (LIM[0] + LIM[2]) / 2, mz = (LIM[1] + LIM[3]) / 2;
  const r = Math.hypot((LIM[2] - LIM[0]) / 2, (LIM[3] - LIM[1]) / 2, 1.6) + 0.5, D = 100;
  camera.setPosition(mx - D, 1.35, mz); camera.setEulerAngles(0, -90, 0);
  c.aspectRatioMode = pc.ASPECT_MANUAL; c.aspectRatio = 1; c.fov = 2 * Math.atan(r / (D - r)) * DEG; c.nearClip = D - r;
  l.shadowDistance = D + r; l.shadowUpdateMode = pc.SHADOWUPDATE_THISFRAME;
  app.render();
  c.fov = avant.fov; c.nearClip = avant.near; c.aspectRatioMode = avant.mode; c.aspectRatio = avant.aspect;
  camera.setPosition(avant.pos); camera.setRotation(avant.rot);
  dessiner();
};
gd.on("devicerestored", () => requestAnimationFrame(figerLesOmbres));

// ---------------------------------------------------------------- visiteur
const vers = (x, z, tx, tz) => Math.atan2(-(tx - x), -(tz - z));
const etat = { x: DEPART.x, z: DEPART.z, yaw: vers(DEPART.x, DEPART.z, DEPART.cx, DEPART.cz), pitch: -0.05 };
const cible = { ...etat };
const vitesse = { x: 0, z: 0 };
let trajet = null;                                     // déplacement automatique vers une pièce

const voile = $("voile");
const aller = (p, bouton) => {
  const yaw0 = etat.yaw, yaw1 = yaw0 + Math.atan2(Math.sin(vers(p.x, p.z, p.cx, p.cz) - yaw0), Math.cos(vers(p.x, p.z, p.cx, p.cz) - yaw0));
  const dist = Math.hypot(p.x - etat.x, p.z - etat.z);
  let direct = true;
  for (let t = 0; t <= 1; t += 0.2 / Math.max(dist, 0.2)) if (!libre(etat.x + (p.x - etat.x) * t, etat.z + (p.z - etat.z) * t)) { direct = false; break; }
  vitesse.x = vitesse.z = 0;
  document.querySelectorAll("#pieces button").forEach((b) => b.classList.toggle("ici", b === bouton));
  if (direct) { trajet = { t: 0, duree: Math.min(2.2, 0.5 + dist * 0.35), x0: etat.x, z0: etat.z, x1: p.x, z1: p.z, y0: yaw0, y1: yaw1, p0: etat.pitch }; dessiner(); return; }
  // à travers un mur : fondu au noir, saut, fondu retour
  trajet = null; voile.classList.add("noir");
  setTimeout(() => {
    etat.x = cible.x = p.x; etat.z = cible.z = p.z; etat.yaw = cible.yaw = yaw1; etat.pitch = cible.pitch = -0.05;
    dessiner(); app.renderNextFrame = true;
    setTimeout(() => voile.classList.remove("noir"), 60);
  }, 300);
};
const barre = $("pieces");
for (const p of PIECES) {
  const b = document.createElement("button"); b.className = "verre"; b.textContent = p.nom || "·";
  b.onclick = () => { aller(p, b); b.blur(); canvas.focus(); fini_aide(); };
  barre.appendChild(b);
}

// ---------------------------------------------------------------- entrées
const touches = new Set();
const CODES = { KeyW: "av", KeyZ: "av", ArrowUp: "av", KeyS: "ar", ArrowDown: "ar", KeyA: "g", KeyQ: "g", KeyD: "d", ArrowLeft: "tg", ArrowRight: "td", ShiftLeft: "vite", ShiftRight: "vite" };
addEventListener("keydown", (e) => {
  const k = CODES[e.code] || { z: "av", w: "av", s: "ar", q: "g", a: "g", d: "d" }[e.key?.toLowerCase()];
  if (!k) return; touches.add(k); trajet = null; fini_aide(); dessiner(); if (e.code.startsWith("Arrow")) e.preventDefault();
});
addEventListener("keyup", (e) => { const k = CODES[e.code] || { z: "av", w: "av", s: "ar", q: "g", a: "g", d: "d" }[e.key?.toLowerCase()]; if (k) touches.delete(k); });
addEventListener("blur", () => touches.clear());

const manette = $("manette"), bouton = manette.querySelector("i");
const joy = { actif: false, id: -1, x0: 0, y0: 0, dx: 0, dy: 0 };
const regard = { actif: false, id: -1, x: 0, y: 0 };
canvas.addEventListener("pointerdown", (e) => {
  canvas.setPointerCapture(e.pointerId); trajet = null; fini_aide();
  if (e.pointerType === "touch" && e.clientX < innerWidth * 0.45 && !joy.actif) {
    Object.assign(joy, { actif: true, id: e.pointerId, x0: e.clientX, y0: e.clientY, dx: 0, dy: 0 });
    manette.style.left = `${e.clientX}px`; manette.style.top = `${e.clientY}px`; manette.style.display = "block"; bouton.style.transform = "";
  } else if (!regard.actif) Object.assign(regard, { actif: true, id: e.pointerId, x: e.clientX, y: e.clientY });
  dessiner();
});
canvas.addEventListener("pointermove", (e) => {
  if (joy.actif && e.pointerId === joy.id) {
    let dx = (e.clientX - joy.x0) / 50, dy = (e.clientY - joy.y0) / 50; const n = Math.hypot(dx, dy);
    if (n > 1) { dx /= n; dy /= n; }
    joy.dx = dx; joy.dy = dy; bouton.style.transform = `translate(${dx * 33}px, ${dy * 33}px)`; dessiner();
  } else if (regard.actif && e.pointerId === regard.id) {
    const k = e.pointerType === "touch" ? 0.0065 : 0.0042;
    cible.yaw -= (e.clientX - regard.x) * k;
    cible.pitch = Math.max(-1.1, Math.min(1.1, cible.pitch - (e.clientY - regard.y) * k));
    regard.x = e.clientX; regard.y = e.clientY; dessiner();
  }
});
const fin = (e) => {
  if (e.pointerId === joy.id) { Object.assign(joy, { actif: false, id: -1, dx: 0, dy: 0 }); manette.style.display = "none"; }
  if (e.pointerId === regard.id) { regard.actif = false; regard.id = -1; }
};
canvas.addEventListener("pointerup", fin); canvas.addEventListener("pointercancel", fin);
canvas.addEventListener("wheel", (e) => { e.preventDefault(); cible.pitch = Math.max(-1.1, Math.min(1.1, cible.pitch - e.deltaY * 0.0015)); dessiner(); }, { passive: false });
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

const aide = $("aide");
aide.textContent = tactile ? L.aideTactile : L.aideBureau;
let aideFinie = false;
function fini_aide() { if (aideFinie) return; aideFinie = true; setTimeout(() => aide.classList.add("parti"), 1200); }
setTimeout(fini_aide, 9000);

// ---------------------------------------------------------------- régulateur de fluidité
// Moins de 45 images par seconde en mouvement : on baisse la définition d'un cran, puis on coupe
// l'occlusion ambiante. On ne remonte jamais (pas de pompage).
const regul = { somme: 0, n: 0, fige: params.get("qualite") === "haute" };
const reguler = (delta) => {
  if (regul.fige || delta > 0.25) return;
  regul.somme += delta; regul.n++;
  if (regul.n < 45) return;
  const moyenne = regul.somme / regul.n; regul.somme = regul.n = 0;
  if (moyenne < 1 / 45) return;
  if (palier < RATIOS.length - 1) { gd.maxPixelRatio = RATIOS[++palier]; app.resizeCanvas(); }
  else if (cadre.ssao.type !== pc.SSAOTYPE_NONE) { cadre.ssao.type = pc.SSAOTYPE_NONE; cadre.update(); }
  else regul.fige = true;
};

const lisse = (t) => t * t * (3 - 2 * t);
app.on("update", (delta) => {
  const dt = Math.min(0.05, delta);
  if (trajet) {
    trajet.t = Math.min(1, trajet.t + dt / trajet.duree);
    const k = lisse(trajet.t);
    etat.x = trajet.x0 + (trajet.x1 - trajet.x0) * k; etat.z = trajet.z0 + (trajet.z1 - trajet.z0) * k;
    etat.yaw = cible.yaw = trajet.y0 + (trajet.y1 - trajet.y0) * k;
    etat.pitch = cible.pitch = trajet.p0 + (-0.05 - trajet.p0) * k;
    if (trajet.t >= 1) trajet = null;
    dessiner(3);
  }
  let av = 0, la = 0, tourne = 0;
  if (touches.has("av")) av += 1;
  if (touches.has("ar")) av -= 1;
  if (touches.has("d")) la += 1;
  if (touches.has("g")) la -= 1;
  if (touches.has("tg")) tourne += 1;
  if (touches.has("td")) tourne -= 1;
  if (joy.actif) { av -= joy.dy; la += joy.dx * 0.8; }
  cible.yaw += tourne * 1.8 * dt;
  // la vitesse rejoint sa consigne en douceur : départs et arrêts sans à-coup
  const allure = touches.has("vite") ? 2.8 : 1.5, n = Math.max(1, Math.hypot(av, la));
  const vx = ((-Math.sin(cible.yaw) * av + Math.cos(cible.yaw) * la) / n) * allure;
  const vz = ((-Math.cos(cible.yaw) * av - Math.sin(cible.yaw) * la) / n) * allure;
  const kv = Math.min(1, dt * 9);
  vitesse.x += (vx - vitesse.x) * kv; vitesse.z += (vz - vitesse.z) * kv;
  const mx = vitesse.x * dt, mz = vitesse.z * dt;
  // glissement le long des murs : chaque axe est essayé séparément
  if (Math.abs(mx) > 1e-5) { if (libre(etat.x + mx, etat.z)) etat.x += mx; else vitesse.x *= 0.3; }
  if (Math.abs(mz) > 1e-5) { if (libre(etat.x, etat.z + mz)) etat.z += mz; else vitesse.z *= 0.3; }
  if (!trajet) {
    etat.yaw += (cible.yaw - etat.yaw) * Math.min(1, dt * 14);
    etat.pitch += (cible.pitch - etat.pitch) * Math.min(1, dt * 14);
  }
  // léger balancement de marche, à peine perceptible
  const allureReelle = Math.hypot(vitesse.x, vitesse.z);
  pas += allureReelle * dt * 7;
  camera.setPosition(etat.x, OEIL + Math.sin(pas) * 0.012 * Math.min(1, allureReelle), etat.z);
  camera.setEulerAngles(etat.pitch * DEG, etat.yaw * DEG, 0);
  const bouge = allureReelle > 0.002 || Math.abs(cible.yaw - etat.yaw) + Math.abs(cible.pitch - etat.pitch) > 0.0005 || trajet;
  if (bouge) { dessiner(3); reguler(delta); } else { regul.somme = regul.n = 0; }
  if (reveil > 0) { reveil--; app.renderNextFrame = true; }
});
let pas = 0;

// ---------------------------------------------------------------- ciel et ambiance
const charger = (url, nom, type) => new Promise((ok, ko) => app.assets.loadFromUrlAndFilename(url, nom, type, (e, a) => (e ? ko(e) : ok(a))));
let ciel, scene;
try {
  [ciel, scene] = await Promise.all([
    charger(URL.createObjectURL(blobCiel), "ciel.jpg", "texture"),
    charger(URL.createObjectURL(blobGlb), "lot.glb", "container"),
  ]);
} catch (e) { console.error(e); repli(L.panne); throw e; }

const tex = ciel.resource;
tex.projection = pc.TEXTUREPROJECTION_EQUIRECT;
tex.addressU = pc.ADDRESS_REPEAT; tex.addressV = pc.ADDRESS_CLAMP_TO_EDGE;
app.scene.skybox = pc.EnvLighting.generateSkyboxCubemap(tex);
// Ambiance propre à l'intérieur : le ciel ne sert qu'à la vue par les fenêtres, sinon le plafond
// prend la couleur de la pelouse. Dégradé zénith-horizon-sol teinté par le bloc « ambiance ».
const envInterieur = () => {
  const w = 128, h = 64, d = new Float32Array(w * h * 4), k = (AMB.intensite / 0.6) * 0.62, c0 = AMB.couleur;
  const haut = [0.6, 0.6, 0.6], horizon = [0.74, 0.71, 0.66], bas = [0.5, 0.42, 0.33];
  const az = S.azimut / DEG;
  for (let j = 0; j < h; j++) {
    const v = j / (h - 1);                            // 0 = zénith, 1 = nadir
    const c = v < 0.5 ? haut.map((x, i) => x + (horizon[i] - x) * (v / 0.5)) : horizon.map((x, i) => x + (bas[i] - x) * ((v - 0.5) / 0.5));
    const pres = 1 - Math.abs(v - 0.5) * 1.4;          // l'effet d'orientation joue surtout à l'horizon
    for (let i = 0; i < w; i++) {
      // côté soleil : lumière renvoyée plus forte et plus chaude ; côté opposé : plus faible et plus fraîche
      const phi = (i / w) * 2 * Math.PI, face = Math.cos(phi - az - Math.PI / 2) * Math.max(0, pres);
      const g = 1 + 0.45 * face, chaud = [1 + 0.08 * face, 1, 1 - 0.1 * face];
      const o = (j * w + i) * 4;
      for (let q = 0; q < 3; q++) d[o + q] = c[q] * c0[q] * k * g * chaud[q];
      d[o + 3] = 1;
    }
  }
  return new pc.Texture(gd, { width: w, height: h, format: pc.PIXELFORMAT_RGBA32F, mipmaps: false, projection: pc.TEXTUREPROJECTION_EQUIRECT, levels: [d] });
};
app.scene.envAtlas = pc.EnvLighting.generateAtlas(pc.EnvLighting.generateLightingSource(envInterieur()));
app.scene.skyboxMip = 0;
app.scene.exposure = 1.0;
app.scene.skyboxIntensity = 2.4;                      // ciel en JPEG : on le remonte pour des fenêtres lumineuses
app.scene.sky.type = pc.SKYTYPE_INFINITE;

const racine = scene.resource.instantiateRenderEntity();
app.root.addChild(racine);
for (const r of racine.findComponents("render")) {
  r.receiveShadows = true;
  for (const mi of r.meshInstances) {
    const verre = /verre|glass/i.test(mi.material.name);
    mi.castShadow = !verre;
    if (verre) { mi.material.depthWrite = false; mi.material.opacity = 0.05; mi.material.update(); }
  }
}
window.__visite = { etat, cible, app, cadre, pc, camera, regul, soleil, libre, aller, PIECES, DEPART, LIM, ratio: () => gd.maxPixelRatio, obstacles: () => obstacles.length };

app.start();
figerLesOmbres();
dessiner(30);
$("charge-etat").textContent = L.pret;
requestAnimationFrame(() => setTimeout(() => $("charge")?.classList.add("fini"), 150));
setTimeout(() => $("charge")?.remove(), 1200);
