// Visite Three.js en temps réel (app3). Fichiers statiques, aucun appel extérieur.
// Toute la lumière est cuite : le moteur livre scene.glb + cartes de lumière + scene.json (contrat v3, moteur/schema.md).
// Ici : affichage, déplacement pièce par pièce (chemin calculé sur une grille tirée d'obstacles.json), mini-plan dessiné depuis plan.json.
// Sans scene.json, la visite retombe sur le GLB de visite.json avec un éclairage de secours.
// Repère partout : x vers l'est, z vers le sud, y vers le haut, en mètres. Cap (lacet) en degrés de boussole : 0 = nord = -z, 90 = est = +x.
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { Reflector } from "three/addons/objects/Reflector.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";      // scene.glb compressé (EXT_meshopt_compression), voir outils/alleger3.py

const $ = (id) => document.getElementById(id);
const Q = new URL(location.href).searchParams;
const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
const borne = (v, a, b) => Math.min(b, Math.max(a, v));
const tour = (a) => { a = (a + Math.PI) % (2 * Math.PI); return (a < 0 ? a + 2 * Math.PI : a) - Math.PI; };      // angle ramené dans [-π, π)
const parAmb = (v, amb, defaut) => (v == null ? defaut : typeof v === "object" ? (v[amb] ?? defaut) : v);

const PAS = 0.05;            // maille de la grille de déplacement, en mètres
const RAYON = 0.22;          // demi-largeur du visiteur : les points de vue du moteur sont à 20 cm au moins de tout obstacle
const CONFORT = 0.55;        // en deçà de cette distance à un obstacle le chemin coûte plus cher : on passe au milieu des portes
const TANGAGE = rad(-4);     // regard à l'arrivée dans une pièce : à peine vers le bas, on voit le sol et le mobilier plutôt que le plafond
const VITESSE = 2.0;         // marche automatique, m/s
const VITESSE_CLAVIER = 1.9;

const etat = { mode: "chargement", pret: false, piece: -1, pieceId: null, x: 0, z: 0, lacet: 0, tangage: 0, ambiance: "jour", ambiances: ["jour"],
  marche: false, expo: 1, dessus: null, poids: 0, triangles: 0, appels: 0, maillages: 0, sansCarte: 0, erreurs: [], notes: [] };      // erreurs : tout défaut, lu par outils/capturer3.py (échec du verdict) ; notes : cas jamais jugés à l'œil
addEventListener("error", (e) => etat.erreurs.push(String(e.message || e)));
addEventListener("unhandledrejection", (e) => etat.erreurs.push(String(e.reason?.message || e.reason)));
let finPret, echecPret;
const pret = new Promise((ok, ko) => { finPret = ok; echecPret = ko; }); pret.catch(() => {});
const api = window.__visite3 = { pret, etat };

const en = document.documentElement.lang === "en";
const T = en ? {
  charge: "Loading", prepare: "Preparing the scene", sansWebgl: "This browser cannot display the 3D tour. Try a recent browser.", echec: "The tour could not be loaded.",
  aideSouris: "Drag to look around, click the floor or the plan to move", aideDoigt: "Drag to look around, tap the floor or a room to move",
  agrandir: "Enlarge the plan", reduire: "Shrink the plan", plan: "Floor plan", mo: "MB", amb: { jour: "Day", nuit: "Night" },
} : {
  charge: "Chargement", prepare: "Préparation de la scène", sansWebgl: "Ce navigateur ne peut pas afficher la visite en 3D. Essayez avec un navigateur récent.", echec: "La visite n'a pas pu être chargée.",
  aideSouris: "Glissez pour regarder, cliquez sur le sol ou sur le plan pour vous déplacer", aideDoigt: "Glissez pour regarder, touchez le sol ou une pièce pour avancer",
  agrandir: "Agrandir le plan", reduire: "Réduire le plan", plan: "Plan du logement", mo: "Mo", amb: { jour: "Jour", nuit: "Nuit" },
};
const nombre = (n, d = 1) => { const s = n.toFixed(d); return en ? s : s.replace(".", ","); };

// ------------------------------------------------------------------ chargement suivi
const chargeEl = $("charge"), barreEl = $("charge-barre"), etatEl = $("charge-etat");
let fichiers = {};
const suivi = { prevus: new Map(), recus: new Map(), actif: true };
function majBarre(texte) {
  if (!suivi.actif) return;
  let prevu = 0, recu = 0;
  for (const [n, o] of suivi.prevus) { const r = suivi.recus.get(n) || 0; prevu += Math.max(o, r); recu += r; }
  const p = prevu ? recu / prevu : 0;
  if (barreEl) barreEl.style.width = (p * 100).toFixed(1) + "%";
  if (etatEl) etatEl.textContent = texte || `${T.charge} ${Math.round(p * 100)} % · ${nombre(recu / 1e6)} ${T.mo}`;
}
const adresse = (nom) => (fichiers[nom]?.v ? `${nom}?v=${fichiers[nom].v}` : nom);
function prevoir(noms) { for (const n of noms) if (n && !suivi.prevus.has(n)) suivi.prevus.set(n, fichiers[n]?.o || 0); }
async function telecharger(nom, genre = "blob") {
  const r = await fetch(adresse(nom));
  if (!r.ok) throw new Error(`${nom} : ${r.status}`);
  if (suivi.actif && !(suivi.prevus.get(nom) > 0)) suivi.prevus.set(nom, +r.headers.get("content-length") || 0);
  let morceaux = [], n = 0;
  if (r.body && suivi.actif) {
    const lecteur = r.body.getReader();
    for (;;) { const { done, value } = await lecteur.read(); if (done) break; morceaux.push(value); n += value.length; suivi.recus.set(nom, n); majBarre(); }
  } else { const b = await r.arrayBuffer(); morceaux = [b]; n = b.byteLength; suivi.recus.set(nom, n); majBarre(); }
  etat.poids += n;
  const b = new Blob(morceaux, { type: r.headers.get("content-type") || "" });
  return genre === "tampon" ? b.arrayBuffer() : b;
}
async function json(nom, facultatif = false) {
  try { const r = await fetch(adresse(nom), { cache: "no-cache" }); if (!r.ok) throw new Error(`${nom} : ${r.status}`); return await r.json(); }
  catch (e) { if (facultatif) return null; throw e; }
}
// Image décodée hors du fil principal quand le navigateur le permet (comme GLTFLoader : pas sur Safari), retournée et réduite à la demande.
// Image suivante, ou 60 ms si le navigateur n'en donne pas : dans un onglet en arrière-plan ou une fenêtre masquée, requestAnimationFrame
// ne répond plus du tout, et un chargement qui l'attend reste figé sur « Préparation de la scène » (vu sur le lien publié le 15/11).
const suivante = () => new Promise((ok) => { let fait = false; const f = () => { if (!fait) { fait = true; ok(); } }; requestAnimationFrame(f); setTimeout(f, 60); });
const OPT = { premultiplyAlpha: "none", colorSpaceConversion: "none" };      // ni prémultiplication ni conversion de couleur au décodage
const PAR_BITMAP = typeof createImageBitmap === "function" && !/^((?!chrome|android).)*safari/i.test(navigator.userAgent);
async function image(blob, { retourner = false, plafond = 0, exact = null } = {}) {
  const cible = (w, h) => exact ? exact : (plafond && Math.max(w, h) > plafond) ? [Math.round(w * plafond / Math.max(w, h)), Math.round(h * plafond / Math.max(w, h))] : null;
  if (PAR_BITMAP) {
    try {
      // Sans prémultiplication ni conversion de couleur : sinon le navigateur convertit l'image au moment de l'envoi à la carte graphique,
      // sur le fil principal (jusqu'à 1 s de blocage mesuré pour une carte de 4096).
      let b = await createImageBitmap(blob, { ...OPT, imageOrientation: retourner ? "flipY" : "none" });
      const c = cible(b.width, b.height);
      if (c && (c[0] !== b.width || c[1] !== b.height)) { const b2 = await createImageBitmap(b, { ...OPT, resizeWidth: c[0], resizeHeight: c[1], resizeQuality: "high" }); b.close(); b = b2; }
      return { image: b, flipY: false };
    } catch (e) { /* repli ci-dessous */ }
  }
  const url = URL.createObjectURL(blob), im = new Image(); im.src = url;
  try { await im.decode(); } finally { URL.revokeObjectURL(url); }
  const c = cible(im.naturalWidth, im.naturalHeight);
  if (!c) return { image: im, flipY: retourner };
  const cv = document.createElement("canvas"); cv.width = c[0]; cv.height = c[1]; cv.getContext("2d").drawImage(im, 0, 0, c[0], c[1]);
  return { image: cv, flipY: retourner };
}
function texture(src, reglages = {}) { const t = new THREE.Texture(src.image); t.flipY = src.flipY; t.colorSpace = THREE.SRGBColorSpace; Object.assign(t, reglages); t.needsUpdate = true; return t; }

function repli(message) {
  etat.mode = "sans-webgl"; suivi.actif = false;
  chargeEl?.classList.add("repli"); if (etatEl) etatEl.textContent = message;
  document.body.classList.add("sans-ui");
}

// ------------------------------------------------------------------ grille de déplacement
function grille(obstacles, limites) {
  const x0 = limites[0], z0 = limites[1], nx = Math.ceil((limites[2] - limites[0]) / PAS), nz = Math.ceil((limites[3] - limites[1]) / PAS);
  const d = new Float32Array(nx * nz).fill(1);      // distance au plus proche obstacle, plafonnée à 1 m
  for (const b of obstacles) {
    const i0 = Math.max(0, Math.floor((b[0] - 1 - x0) / PAS)), i1 = Math.min(nx - 1, Math.ceil((b[2] + 1 - x0) / PAS));
    const j0 = Math.max(0, Math.floor((b[1] - 1 - z0) / PAS)), j1 = Math.min(nz - 1, Math.ceil((b[3] + 1 - z0) / PAS));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const x = x0 + (i + 0.5) * PAS, z = z0 + (j + 0.5) * PAS;
      const dx = Math.max(b[0] - x, 0, x - b[2]), dz = Math.max(b[1] - z, 0, z - b[3]), k = Math.hypot(dx, dz);
      if (k < d[j * nx + i]) d[j * nx + i] = k;
    }
  }
  const G = { x0, z0, nx, nz, d, acces: new Uint8Array(nx * nz) };
  G.case = (x, z) => { const i = Math.floor((x - x0) / PAS), j = Math.floor((z - z0) / PAS); return (i < 0 || j < 0 || i >= nx || j >= nz) ? -1 : j * nx + i; };
  G.dist = (x, z) => { const c = G.case(x, z); return c < 0 ? 0 : d[c]; };
  G.libre = (x, z) => G.dist(x, z) >= RAYON;
  G.centre = (c) => [x0 + ((c % nx) + 0.5) * PAS, z0 + (Math.floor(c / nx) + 0.5) * PAS];
  // case libre et accessible la plus proche d'un point, dans un rayon donné
  G.proche = (x, z, rmax = 1, accessible = true) => {
    const c0 = G.case(x, z); if (c0 >= 0 && d[c0] >= RAYON && (!accessible || G.acces[c0])) return c0;
    const n = Math.ceil(rmax / PAS), ci = Math.floor((x - x0) / PAS), cj = Math.floor((z - z0) / PAS); let mieux = -1, dm = rmax * rmax;
    for (let j = Math.max(0, cj - n); j <= Math.min(nz - 1, cj + n); j++) for (let i = Math.max(0, ci - n); i <= Math.min(nx - 1, ci + n); i++) {
      const c = j * nx + i; if (d[c] < RAYON || (accessible && !G.acces[c])) continue;
      const px = x0 + (i + 0.5) * PAS - x, pz = z0 + (j + 0.5) * PAS - z, k = px * px + pz * pz;
      if (k < dm) { dm = k; mieux = c; }
    }
    return mieux;
  };
  // ce qu'on peut atteindre depuis un point : tout le reste (derrière les murs extérieurs) n'est jamais une destination
  G.inonder = (x, z) => {
    G.acces.fill(0); const dep = G.proche(x, z, 1.5, false); if (dep < 0) return;
    const pile = [dep]; G.acces[dep] = 1;
    while (pile.length) { const c = pile.pop(), i = c % nx, j = (c - i) / nx;
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue; const v = b * nx + a; if (!G.acces[v] && d[v] >= RAYON) { G.acces[v] = 1; pile.push(v); } } }
  };
  // segment dégagé : chaque point du segment garde au moins `marge` de distance aux obstacles
  G.degage = (ax, az, bx, bz, marge) => {
    const L = Math.hypot(bx - ax, bz - az), n = Math.max(1, Math.ceil(L / (PAS * 0.5)));
    for (let k = 0; k <= n; k++) { const t = k / n; if (G.dist(ax + (bx - ax) * t, az + (bz - az) * t) < marge) return false; }
    return true;
  };
  // A* à huit voisins. Le coût monte près des obstacles, donc le chemin prend le milieu des passages.
  G.chemin = (ax, az, bx, bz) => {
    const dep = G.proche(ax, az, 1.5), arr = G.proche(bx, bz, 1.5); if (dep < 0 || arr < 0) return null;
    const N = nx * nz, g = new Float32Array(N).fill(Infinity), parent = new Int32Array(N).fill(-1), clos = new Uint8Array(N);
    const ai = arr % nx, aj = (arr - ai) / nx;
    const h = (c) => { const di = Math.abs((c % nx) - ai), dj = Math.abs(Math.floor(c / nx) - aj); return (Math.max(di, dj) + 0.41421 * Math.min(di, dj)) * PAS; };
    const tas = [], f = new Float32Array(N);
    const pousser = (c) => { tas.push(c); let k = tas.length - 1; while (k > 0) { const p = (k - 1) >> 1; if (f[tas[p]] <= f[tas[k]]) break; [tas[p], tas[k]] = [tas[k], tas[p]]; k = p; } };
    const tirer = () => { const haut = tas[0], der = tas.pop(); if (tas.length) { tas[0] = der; let k = 0; for (;;) { const a = 2 * k + 1, b = a + 1; let m = k;
      if (a < tas.length && f[tas[a]] < f[tas[m]]) m = a; if (b < tas.length && f[tas[b]] < f[tas[m]]) m = b; if (m === k) break; [tas[m], tas[k]] = [tas[k], tas[m]]; k = m; } } return haut; };
    g[dep] = 0; f[dep] = h(dep); pousser(dep);
    while (tas.length) {
      const c = tirer(); if (c === arr) break; if (clos[c]) continue; clos[c] = 1;
      const i = c % nx, j = (c - i) / nx;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue; const a = i + di, b = j + dj; if (a < 0 || b < 0 || a >= nx || b >= nz) continue;
        const v = b * nx + a; if (clos[v] || d[v] < RAYON) continue;
        if (di && dj && (d[j * nx + a] < RAYON || d[b * nx + i] < RAYON)) continue;      // pas de diagonale qui rase un coin
        const p = Math.max(0, (CONFORT - d[v]) / CONFORT), cout = g[c] + (di && dj ? 1.41421 : 1) * PAS * (1 + 5 * p * p);
        if (cout < g[v]) { g[v] = cout; parent[v] = c; f[v] = cout + h(v); pousser(v); }
      }
    }
    if (parent[arr] < 0 && arr !== dep) return null;
    let brut = []; for (let c = arr; c >= 0; c = parent[c]) brut.push(G.centre(c)); brut.reverse();
    // extrémités exactes quand le petit saut jusqu'à elles ne frôle rien
    if (G.degage(ax, az, brut[0][0], brut[0][1], 0.1)) brut.unshift([ax, az]);
    const der = brut[brut.length - 1]; if (G.degage(der[0], der[1], bx, bz, 0.1)) brut.push([bx, bz]);
    // on tend le fil : un tronçon droit remplace les marches de la grille tant qu'il ne se rapproche pas plus des obstacles que le chemin lui-même
    const pts = [brut[0]]; let i = 0;
    while (i < brut.length - 1) {
      const mins = new Float32Array(brut.length); let m = 9;
      for (let k = i; k < brut.length; k++) { m = Math.min(m, G.dist(brut[k][0], brut[k][1])); mins[k] = m; }
      let j = brut.length - 1;
      for (; j > i + 1; j--) if (G.degage(brut[i][0], brut[i][1], brut[j][0], brut[j][1], Math.min(0.42, mins[j]) - 0.012)) break;
      pts.push(brut[j]); i = j;
    }
    // on rééchantillonne tous les 6 cm puis on arrondit les angles (moyenne glissante), sans jamais entrer dans un obstacle
    let fin = [pts[0]];
    for (let k = 1; k < pts.length; k++) { const [x1, z1] = pts[k - 1], [x2, z2] = pts[k], L = Math.hypot(x2 - x1, z2 - z1), n = Math.max(1, Math.round(L / 0.06));
      for (let q = 1; q <= n; q++) fin.push([x1 + (x2 - x1) * q / n, z1 + (z2 - z1) * q / n]); }
    for (let passe = 0; passe < 2; passe++) {
      const s = fin.map((p, k) => { const w = Math.min(k, fin.length - 1 - k, 6); if (!w) return p; let x = 0, z = 0;
        for (let q = k - w; q <= k + w; q++) { x += fin[q][0]; z += fin[q][1]; } x /= 2 * w + 1; z /= 2 * w + 1;
        return G.dist(x, z) >= Math.min(G.dist(p[0], p[1]), RAYON + 0.06) ? [x, z] : p; });
      fin = s;
    }
    return fin;
  };
  return G;
}

// ------------------------------------------------------------------ démarrage
async function demarrer() {
  const V = await json("visite.json");
  fichiers = V.fichiers || {};
  const sansUi = Q.get("ui") === "0"; if (sansUi) { document.body.classList.add("sans-ui"); if (chargeEl) chargeEl.style.transition = "none"; }
  const [obstacles, plan, sc] = await Promise.all([
    json(V.obstacles || "obstacles.json", true).then((o) => o || []),
    json("plan.json", true),
    (V.fichiers && !V.fichiers["scene.json"]) ? null : json("scene.json", true),
  ]);
  const v3 = !!(sc && sc.cartes);
  const H = V.hauteurPlafond || plan?.hauteur || 2.5, OEIL = V.hauteurOeil || 1.6;
  const limites = V.limites || plan?.limites || [-1, -1, 12, 12];
  const obst3 = (plan?.obstacles?.length ? plan.obstacles : obstacles.map((b) => [...b, H]));
  const ambiances = v3 ? (sc.ambiances?.length ? sc.ambiances : ["jour"]) : ["jour"];
  let amb = ambiances.includes(Q.get("ambiance")) ? Q.get("ambiance") : ambiances[0];
  etat.ambiances = ambiances; etat.ambiance = amb;
  if (v3) {
    if (!plan?.pieces?.length) etat.erreurs.push("plan.json absent ou vide : pas de mini-plan, pas de finition des extérieurs, pose par pièce impossible");
    for (const a of ambiances) {
      if (!(sc.reflets || []).some((r) => r[a])) etat.erreurs.push(`scene.json sans reflets pour l'ambiance ${a} : reflets neutres partout`);
      const e = sc.expo?.[a], sans = (plan?.pieces || []).filter((p) => !(e && (typeof e[p.id] === "number" || typeof e.defaut === "number"))).map((p) => p.id);
      if (sans.length) etat.erreurs.push(`scene.json sans pose (expo) pour l'ambiance ${a} : ${sans.join(", ")}`);
    }
  }

  // ---------------------------------------------------------------- rendu
  const canvas = $("c");
  let renderer;
  try {
    const AA = Q.has("aa") ? Q.get("aa") !== "0" : true;
    if (!canvas.getContext("webgl2", { antialias: AA, powerPreference: "high-performance", stencil: false })) throw new Error("webgl2");
    renderer = new THREE.WebGLRenderer({ canvas, antialias: AA, powerPreference: "high-performance", stencil: false });
  } catch (e) { repli(T.sansWebgl); throw new Error("WebGL indisponible"); }
  const mobile = matchMedia("(pointer: coarse)").matches || Math.min(screen.width, screen.height) < 700;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.AgXToneMapping;          // les rendus validés sortent de Blender en AgX
  // Look de Blender (config.ocio, GradingPrimaryTransform en espace AgX Log) : un contraste autour du gris moyen (log2(0,18) = -2,47393),
  // appliqué par canal entre l'encodage log et la sigmoïde, plus une saturation. Three.js ne fait que l'AgX de base : on l'ajoute dans sa fonction.
  const LOOKS = { "Very High Contrast": [1.57, 0.9], "High Contrast": [1.4, 0.95], "Medium High Contrast": [1.2, 1], "Base Contrast": [1, 1], "Medium Low Contrast": [0.9, 1.05], "Low Contrast": [0.8, 1.1], "Very Low Contrast": [0.7, 1.15] };
  const look = LOOKS[String(sc?.codage?.ton?.look || "").replace(/^AgX - /, "")] || [1, 1];
  // Le contraste et la saturation du look passent par deux uniformes, réglés par ambiance : le jour est plus doux (contraste de base) que la nuit validée.
  // Une matière qui ne déclare pas ces uniformes les lit à 0 et retombe sur le look de scene.json.
  {
    const avant = "color = log2( color );", src = THREE.ShaderChunk.tonemapping_pars_fragment;
    if (src.includes(avant)) THREE.ShaderChunk.tonemapping_pars_fragment = "uniform float v3Contraste;\nuniform float v3Saturation;\n" + src.replace(avant, avant
      + `\n\tcolor = ( color + 2.47393 ) * ( v3Contraste > 0.0 ? v3Contraste : ${look[0].toFixed(3)} ) - 2.47393;`
      + `\n\tcolor = mix( vec3( dot( color, vec3( 0.2126, 0.7152, 0.0722 ) ) ), color, v3Saturation > 0.0 ? v3Saturation : ${look[1].toFixed(3)} );`);
    else etat.erreurs.push("AgX : source inattendue, look non appliqué");
  }
  // Réglages par ambiance. Jour : la lumière des murs sortait bleutée (rouge/bleu 0,83 au 90e centile de l'atlas a) et brûlait près des baies.
  // On la réchauffe, on adoucit les hautes lumières par un genou (asymptote à deux fois le seuil), on pose un peu plus court et on baisse le contraste.
  const REGLAGES = {
    // chaudA, plafond_ext_k, fond_nuit_k : réglés à l'œil sur le T2 Capeyron le 15/11, rapportés à chaque lot par moteur/outils/mesures3.py (scene.json
    // codage) ; une scène sans ces champs (le T2 servi, les lots cuits avant) garde les constantes du T2.
    jour: { chaudA: (Array.isArray(sc?.codage?.chaudA) && sc.codage.chaudA.length === 3) ? sc.codage.chaudA : [1.0, 0.93, 0.82], satA: 0.4, chaudB: [1.0, 0.965, 0.9], genou: 0.5 * Math.PI, contraste: 1.0, saturation: 1.04, pose: 0.88, lumiere: 0.45 },
    nuit: { chaudA: [1, 1, 1], satA: 1, chaudB: [1, 1, 1], genou: 0, contraste: look[0], saturation: look[1], pose: 1, lumiere: 1 },
  };
  // Une ambiance qui ne s'appelle ni jour ni nuit prend les réglages de nuit si scene.json la dit sans soleil (sans_soleil), ceux du jour sinon.
  const nuitee = (a) => a === "nuit" || (a !== "jour" && (sc?.sans_soleil || []).includes(a));
  const reglage = (a) => REGLAGES[a] || (nuitee(a) ? REGLAGES.nuit : REGLAGES.jour);
  const uContraste = { value: reglage(amb).contraste }, uSaturation = { value: reglage(amb).saturation };
  // Vert gris des murs à l'ombre : leur lumière vient du ciel, elle est bleutée, et la réchauffer en baissant le bleu donnait du vert (bleu gris x jaune).
  // De jour la lumière des murs et plafonds est d'abord ramenée vers le gris (satA), puis teintée chaud : beige neutre partout, jamais de vert.
  const uSatA = { value: reglage(amb).satA }, UN = { value: 1 };
  const uChaudA = { value: new THREE.Vector3(...reglage(amb).chaudA) }, uChaudB = { value: new THREE.Vector3(...reglage(amb).chaudB) }, uGenou = { value: reglage(amb).genou };
  const ton = (sh) => { sh.uniforms.v3Contraste = uContraste; sh.uniforms.v3Saturation = uSaturation; };
  // Les petites pièces sombres étaient posées jusqu'à 1,32 fois le séjour : sur écran leurs blancs brûlent (salle d'eau). On plafonne l'écart au séjour.
  const PLAFOND_EXPO = sc?.codage?.expo_plafond ?? 1.1;
  const POSE = Math.pow(2, sc?.codage?.pose_il || 0);      // pose des panoramas validés, en diaphragmes ; le facteur de chaque pièce s'y multiplie
  // courbe de ton pour un gris, et son inverse : sert à relire une image d'écran (les panoramas des reflets) comme de la lumière de scène
  const courbe = (x) => { let e = Math.log2(Math.max(x, 1e-10)); e = (e + 2.47393) * look[0] - 2.47393; const t = borne((e + 12.47393) / 16.499999, 0, 1), t2 = t * t, t4 = t2 * t2;
    return Math.pow(Math.max(0, 15.5 * t4 * t2 - 40.14 * t4 * t + 31.96 * t4 - 6.868 * t2 * t + 0.4298 * t2 + 0.1191 * t - 0.00232), 2.2); };
  const inverseTon = (() => { const T = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const c = i / 255, d = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); let a = 1e-6, b = 64;
      for (let k = 0; k < 44; k++) { const m = Math.sqrt(a * b); if (courbe(m) < d) a = m; else b = m; } T[i] = Math.sqrt(a * b); }
    return T; })();
  renderer.toneMappingExposure = 1;
  // Densité de pixels : 2 au plus sur ordinateur, 1,5 sur téléphone (un écran à 3 dessinait 4 fois plus de pixels pour une différence à peine visible).
  // Si les images restent lentes pendant qu'on bouge, on descend par quarts jusqu'à 1 (voir lenteur()).
  let dpr = Q.has("dpr") ? +Q.get("dpr") || 1 : Math.min(devicePixelRatio || 1, mobile ? 1.5 : 2), lentes = 0, baisse = false;
  renderer.setPixelRatio(dpr); etat.dpr = dpr; etat.densite = dpr;
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.setClearColor(0x0c0a08, 1);
  const TMAX = renderer.capabilities.maxTextureSize;
  const PLAFOND_CARTE = Math.min(TMAX, mobile ? 2048 : 4096), PLAFOND_CIEL = Math.min(TMAX, mobile ? 4096 : 8192);
  const TAILLE_ENV = [1024, 512];      // les panoramas livrés font 1024 x 512 : les agrandir quadruplait le calcul pour rien      // même taille pour toutes les pièces : sinon chaque changement de pièce recompile les matières
  const ANISO = Math.min(8, renderer.capabilities.getMaxAnisotropy());

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.05, 300);
  camera.rotation.order = "YXZ";
  const dessusCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  let zoom = 1;
  // Deux densités de pixels. Le temps de carte graphique suit le nombre de pixels calculés (mesuré sur un Mac M3, 1728 x 1000 points : 23 à 35 ms
  // par image à densité 2, 10 ms à densité 1,1), et à pleine densité Retina un grand écran ne tient pas 60 images par seconde.
  //   en mouvement : la toile est calculée avec BUDGET pixels au plus et étirée par le navigateur ; à cette vitesse l'œil ne voit pas la différence ;
  //   à l'arrêt    : 140 ms après la dernière image, elle est recalculée une fois à pleine densité, nette.
  // Changer de taille coûte 4 ms au départ d'un mouvement et une image de 30 ms à l'arrêt (mesuré), où elle ne se voit pas.
  let budget = +Q.get("budget") || 2.0e6, densite = dpr, affinage = 0;
  const densiteMvt = (k = 1) => Math.min(dpr, Math.max(mobile ? 0.9 : 1, Math.sqrt(budget * k / (innerWidth * innerHeight))));
  function regler(mvt, force = false) {
    const d = mvt ? densiteMvt(balade && !marche ? 1.7 : 1) : dpr;      // la rotation lente d'accueil garde plus de pixels : c'est la première image que l'on voit
    if (!force && Math.abs(d - densite) < 0.02) return false;
    densite = d; etat.densite = +d.toFixed(2); renderer.setPixelRatio(d); renderer.setSize(innerWidth, innerHeight, false); return true;
  }
  function affiner() { clearTimeout(affinage); affinage = setTimeout(() => { if (marche || fondu || balade || touches.size || (prise && prise.tire) || etat.dessus) return; if (regler(false)) dessiner(); }, 140); }
  function cadrer() {
    const w = innerWidth, h = innerHeight, a = w / h;
    renderer.setSize(w, h, false);
    camera.aspect = a; camera.fov = borne(deg(2 * Math.atan(Math.tan(rad(46)) / a)), 55, 82) * zoom;      // 92° de large en paysage, plus haut en portrait
    camera.updateProjectionMatrix();
    if (etat.dessus) cadrerDessus();
  }
  function cadrerDessus() {
    const W = limites[2] - limites[0], D = limites[3] - limites[1], a = innerWidth / innerHeight, cx = (limites[0] + limites[2]) / 2, cz = (limites[1] + limites[3]) / 2;
    const dw = W / D > a ? W / 2 : D * a / 2, dh = dw / a;
    dessusCam.left = -dw; dessusCam.right = dw; dessusCam.top = dh; dessusCam.bottom = -dh; dessusCam.updateProjectionMatrix();
    dessusCam.position.set(cx, 60, cz); dessusCam.up.set(0, 0, -1); dessusCam.lookAt(cx, 0, cz); dessusCam.updateMatrixWorld();
    etat.dessus = { x0: cx - dw, x1: cx + dw, z0: cz - dh, z1: cz + dh, largeur: innerWidth, hauteur: innerHeight };
  }

  // ---------------------------------------------------------------- matières à lumière cuite
  const echelle = (a) => parAmb(sc?.codage?.echelle, a, 1) * Math.PI;      // Three.js divise l'irradiance de la carte par π (BRDF_Lambert) : on la lui rend
  const uMelange = { value: 0 }, uForceB = { value: 1 }, uPose = { value: 1 }, uVerre = { value: 0.5 }, uOcc = { value: v3 ? (sc.codage?.occlusion_reflets ?? 12) / Math.PI : 0 };
  const SRC = THREE.ShaderChunk.lights_fragment_maps;
  const A1 = "vec4 lightMapTexel = texture2D( lightMap, vLightMapUv );", A2 = "vec3 lightMapIrradiance = lightMapTexel.rgb * lightMapIntensity;",
    A3 = "iblIrradiance += getIBLIrradiance( geometryNormal );", A4 = "radiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness );";
  if (v3 && ![A1, A2, A3, A4].every((a) => SRC.includes(a))) etat.erreurs.push("lights_fragment_maps : source inattendue, lumière cuite non garantie");
  // carte de lumière : mélange de deux ambiances, pas d'éclairage diffus venu de l'environnement (il est déjà dans la carte),
  // et des reflets qui s'éteignent là où la carte est sombre (sous un meuble, au fond d'un placard) au lieu d'y faire briller le sol.
  // Un métal ne reçoit pas de lumière diffuse, sa carte est noire : lui garde tous ses reflets (sinon le miroir sort noir).
  // Sur une matière mate (carrelage, parquet) le reflet est réduit : l'image d'environnement change d'une pièce à l'autre, et à pleine force
  // elle teintait le sol de la salle d'eau en olive vu du dégagement, puis en gris une fois entré : le sol semblait se couper au passage.
  // Toutes les matières du GLB sont en double face. Le dessous d'un meuble, d'un tapis, le dos d'un caisson contre un mur ou le dessus d'un mur sous le plafond
  // sont des faces vues de dos, coplanaires avec le sol, le mur ou le plafond, et leur carte est noire (rien n'y arrive) : elles se battaient avec la face visible
  // en carrés noirs qui clignotent. Une face vue de dos dont la carte est noire est jetée : la face visible gagne toujours.
  // Plafond hors de l'emprise des pièces : traité comme celui de l'extérieur jusqu'à l'épaisseur du mur de façade (débord du plafond du séjour au-dessus
  // de la baie). Épaisseur lue dans plan.json : la plus grande des ouvertures entre une pièce et un extérieur (T2 Capeyron : baie de la chambre, 0,35).
  const MARGE_EXT = (() => { const ext = new Set((plan?.pieces || []).filter((q) => q.exterieur).map((q) => q.id));
    const ep = [...(plan?.fenetres || []), ...(plan?.portes || [])].filter((o) => (o.entre || []).some((id) => ext.has(id)) && (o.entre || []).some((id) => id && !ext.has(id))).map((o) => +o.ep || 0).filter((x) => x > 0);
    return ep.length ? Math.max(...ep) : 0.35; })();
  const BLOC_CARTE = "float v3occ = 1.0;\n" + SRC
    .replace(A1, "vec3 v3a = v3Lire( lightMap, vLightMapUv ) * lightMapIntensity;\n\t\tvec3 v3b = v3Lire( v3CarteB, vLightMapUv ) * v3ForceB;")
    .replace(A2, "vec3 lightMapIrradiance = mix( v3a, v3b, v3Melange );\n"
      + "#ifdef V3_DESSOUS\n\t\tif ( ! gl_FrontFacing && dot( lightMapIrradiance, vec3( 0.3333 ) ) < 0.0125 ) discard;\n#endif\n"
      // Balcon de nuit : la carte des enduits, du plafond de la loggia et de la paroi vitrée porte de grandes taches basses fréquences laissées par le
      // débruiteur (le bruit texel à texel est de 0,4 %, mesuré : aucun flou ne les enlève, il ne fait que des stries aux coutures). Sur ces seules
      // surfaces, dans le volume du balcon, la lumière est calculée : un fond d'ambiance plus le spot du plafond (position lue dans le GLB), en loi de
      // Lambert et carré de la distance adouci. Lisse par construction, halo conservé. v3Ext vaut 1 la nuit, 0 le jour.
      + "#ifdef V3_PLAFOND\n\t\tfloat v3Marge = ( v3Monde.x < v3Interieur.x || v3Monde.z < v3Interieur.y || v3Monde.x > v3Interieur.z || v3Monde.z > v3Interieur.w ) ? " + MARGE_EXT.toFixed(3) + " : 0.1;\n#else\n\t\tfloat v3Marge = 0.0;\n#endif\n\t\tint v3r = v3Rect( v3Marge );\n\t\tif ( v3r >= 0 ) {\n\t\t\tvec4 v3I = v3BalconInfo[ v3r ];\n\t\t\tvec3 v3n = normalize( v3NMonde ); if ( dot( v3n, cameraPosition - v3Monde ) < 0.0 ) v3n = - v3n;\n"
      + "#ifdef V3_COQUE\n"
      // Jour : le plafond de la loggia (et la marche de 6 cm entre le plafond du séjour et celui du balcon, et le dessous du plafond du séjour qui dépasse)
      // reçoit un dégradé lisse mesuré sur sa carte (0,03 à 0,06, plus clair côté dehors) : plus de taches, plus de filet clair ni de bande noire.
      // Le dégradé part du bord extérieur de l'extérieur (0,2366) et baisse de 0,04 par mètre en allant vers le logement, plancher 0,18 :
      // sur le T2 Capeyron (dehors vers +x, bord à 9,564) c'est exactement l'ancien 0,19 + 0,04 x (x - 8,4).
      + "#ifdef V3_PLAFOND\n\t\t\tif ( v3Ext < 1.0 && v3Monde.y > v3I.w - 0.12 && v3n.y < 0.5 ) {\n"
      + "\t\t\t\tfloat v3j = clamp( 0.23656 - 0.04 * ( v3I.z - dot( v3I.xy, v3Monde.xz ) ), 0.18, 0.24 )" + (Number.isFinite(sc?.codage?.plafond_ext_k) ? " * " + sc.codage.plafond_ext_k.toFixed(4) : "") + ";\n"
      + "\t\t\t\tlightMapIrradiance = mix( lightMapIrradiance, vec3( v3j * 3.14159 ), 1.0 - v3Ext );\n\t\t\t}\n#endif\n"
      // Nuit : fond chaud, angles feutrés (assombris près du sol, du plafond et des murs perpendiculaires), halo ambré du spot, enduit minéral à grain fin.
      + "\t\t\tif ( v3Ext > 0.0 ) {\n"
      + "\t\t\t\tfloat v3ao = v3Angles( v3n, v3r );\n"
      + "\t\t\t\tvec3 v3e = v3SpotCouleur * v3SpotK.x * v3ao + v3Ambre * v3SpotTerme( v3n ) * mix( 0.75, 1.0, v3ao );\n"
      + "\t\t\t\tlightMapIrradiance = mix( lightMapIrradiance, v3e * 3.14159, v3Ext );\n"
      + "\t\t\t\tmaterial.diffuseColor = mix( material.diffuseColor, v3Pierre, v3Ext );\n\t\t\t}\n"
      + "#else\n"
      // Nuit, tout le reste du balcon (sol, table, chaises, claustra) : lumière chaude d'appoint du spot, ajoutée à la carte.
      + "\t\t\tif ( v3Ext > 0.0 ) lightMapIrradiance += v3Ext * v3Ambre * v3SpotTerme( v3n ) * 3.14159 * ( v3n.y > 0.7 ? 3.0 : 0.5 );      // sol et plateau : flaque chaude sous le spot\n"
      + "#endif\n\t\t}\n"
      + "\t\tlightMapIrradiance = mix( vec3( dot( lightMapIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) ) ), lightMapIrradiance, v3Sat ) * v3Chaud;\n"
      + "\t\t{ float v3l = dot( lightMapIrradiance, vec3( 0.2126, 0.7152, 0.0722 ) ); if ( v3Genou > 0.0 && v3l > v3Genou ) { float v3e = v3l - v3Genou; lightMapIrradiance *= ( v3Genou + v3e / ( 1.0 + v3e / v3Genou ) ) / v3l; } }\n"
      + "#ifdef STANDARD\n\t\tv3occ = mix( clamp( dot( lightMapIrradiance, vec3( 0.3333 ) ) * v3Occ, 0.0, 1.0 ), 1.0, smoothstep( 0.9, 1.0, metalnessFactor ) );\n\t\tv3occ *= mix( 1.0, mix( 0.3, 1.0, smoothstep( 0.9, 1.0, metalnessFactor ) ), smoothstep( 0.3, 0.6, roughnessFactor ) );\n#endif\n")
    .replace("irradiance += lightMapIrradiance;", "#ifdef V3_COQUE\n\t\tif ( v3r >= 0 ) {\n#ifdef V3_PLAFOND\n\t\t\tv3occ = 0.0;\n#else\n\t\t\tv3occ *= 1.0 - v3Ext;\n#endif\n\t\t}      // enduit mat : pas de reflet de l'image d'environnement (elle est tachée)\n#endif\n\t\tirradiance += lightMapIrradiance;")
    .replace(A3, "").replace(A4, "#ifndef V3_MAT\n\t\tradiance += getIBLRadiance( geometryViewDir, geometryNormal, material.roughness ) * v3occ;\n#endif");
  const BLOC_SANS = SRC.replace(A3, "");
  // v3Lire : lecture de la carte. Pour une matière « lissée » (sol du balcon), moyenne de 17 lectures sur un disque : la nuit sa carte est
  // tachée (peu de lumière, beaucoup de bruit), et un sol extérieur n'a pas de détail fin à perdre. Le rayon suit l'ambiance (nul de jour).
  //
  // Extérieurs. Chaque pièce extérieure de plan.json (balcon, loggia, terrasse, jardin : autant qu'il y en a) est découpée en rectangles, tranche
  // par tranche en z, élargis de 3 cm pour prendre les parois posées sur leur bord (retour de mur à côté de la baie, paroi du fond). Une face de
  // l'intérieur ne tombe jamais dedans : la plus proche est derrière l'épaisseur d'un mur. Un contour en biais est recoupé en tranches de 25 cm.
  // Le nuanceur reçoit par rectangle ce qui dépend de l'extérieur auquel il appartient : l'axe du dehors (du logement vers l'extérieur), le bord
  // extérieur le long de cet axe, la hauteur de son plafond, son étendue en z. Rien n'est écrit pour un logement en particulier.
  // Un extérieur SANS plafond (terrasse à ciel ouvert, jardin) est reconnu après le chargement du GLB : ses rectangles sont vidés et il garde sa
  // lumière cuite telle quelle. Les retouches (lumière calculée la nuit, dégradé du plafond le jour) ont été réglées sur une loggia couverte.
  // Hauteur du plafond d'un extérieur couvert : MESURÉE dans le GLB après le chargement (dessous de sa dalle, au millimètre). Le moteur l'a posée
  // 6 cm au-dessus des pièces jusqu'au 15/11 (T2 Capeyron : 2,56), à H depuis (construire.py, dalle_haute_balcon). H + 0,06 ne sert plus qu'en repli.
  const NB_MAX = 32, NS_MAX = 8, HAUT_EXT = H + 0.06;
  // Côté ouvert d'un extérieur : ses bords de plan.json qui ne ferment pas (claustra, garde-corps). Sans bord décrit, les arêtes du contour à plus
  // de 45 cm de toute pièce intérieure (une arête contre le logement est un mur). Chaque rectangle prend l'axe et le bord du côté ouvert le plus proche :
  // un balcon en L dont les deux branches donnent sur deux façades (lot 30158) a deux axes, un seul ne valait que pour le T2 (claustra à l'est).
  const FERMES = new Set(["mur", "verre_opaque", "pare_vue", "haie"]);
  const dSeg = (x, z, a, b) => { const ux = b[0] - a[0], uz = b[1] - a[1], L2 = ux * ux + uz * uz || 1e-12, t = borne(((x - a[0]) * ux + (z - a[1]) * uz) / L2, 0, 1); return Math.hypot(x - a[0] - t * ux, z - a[1] - t * uz); };
  const dContour = (x, z, pg) => { let m = 1e9; for (let i = 0; i < pg.length; i++) m = Math.min(m, dSeg(x, z, pg[i], pg[(i + 1) % pg.length])); return m; };
  const aLaSource = (cle) => (sc?.a_la_source || []).includes(cle);      // défaut corrigé par le moteur dans la géométrie : la retouche d'ici ne s'applique plus
  const emprise = [1e9, 1e9, -1e9, -1e9];      // emprise des pièces intérieures : un plafond hors d'elle n'est vu que du dehors
  for (const q of (plan?.pieces || []).filter((q) => !q.exterieur)) for (const [x, z] of q.poly) { emprise[0] = Math.min(emprise[0], x); emprise[1] = Math.min(emprise[1], z); emprise[2] = Math.max(emprise[2], x); emprise[3] = Math.max(emprise[3], z); }
  const exterieurs = [];
  for (const p of (plan?.pieces || []).filter((q) => q.exterieur && q.poly?.length >= 3)) {
    const n = p.poly.length, biais = p.poly.some((a, i) => { const b = p.poly[(i + 1) % n]; return Math.abs(a[0] - b[0]) > 2e-3 && Math.abs(a[1] - b[1]) > 2e-3; });
    let zs = [...new Set(p.poly.map((q) => q[1]))].sort((a, b) => a - b);
    if (biais) { const fin = []; for (let k = 0; k < zs.length - 1; k++) { const m = Math.max(1, Math.ceil((zs[k + 1] - zs[k]) / 0.25)); for (let q = 0; q < m; q++) fin.push(zs[k] + (zs[k + 1] - zs[k]) * q / m); } fin.push(zs[zs.length - 1]); zs = fin; }
    const rects = [];
    for (let k = 0; k < zs.length - 1; k++) {
      if (zs[k + 1] - zs[k] < 1e-4) continue;
      const zm = (zs[k] + zs[k + 1]) / 2, xs = [];      // entrées et sorties du contour le long de la ligne médiane de la tranche
      for (let i = 0, j = n - 1; i < n; j = i++) { const [x0, z0] = p.poly[i], [x1, z1] = p.poly[j]; if ((z0 > zm) !== (z1 > zm)) xs.push((x1 - x0) * (zm - z0) / (z1 - z0) + x0); }
      xs.sort((a, b) => a - b);
      for (let i = 0; i + 1 < xs.length; i += 2) { if (xs[i + 1] - xs[i] < 1e-3) continue; const der = rects[rects.length - 1];
        if (biais && der && Math.abs(der[0] - xs[i]) < 0.02 && Math.abs(der[2] - xs[i + 1]) < 0.02 && Math.abs(der[3] - zs[k]) < 1e-6) der[3] = zs[k + 1]; else rects.push([xs[i], zs[k], xs[i + 1], zs[k + 1]]); }
    }
    if (!rects.length) { etat.erreurs.push(`extérieur ${p.id} : contour illisible dans plan.json, aucune finition`); continue; }
    const b = [Math.min(...p.poly.map((q) => q[0])), Math.min(...p.poly.map((q) => q[1])), Math.max(...p.poly.map((q) => q[0])), Math.max(...p.poly.map((q) => q[1]))];
    const d = emprise[0] < emprise[2] ? [(b[0] + b[2]) / 2 - (emprise[0] + emprise[2]) / 2, (b[1] + b[3]) / 2 - (emprise[1] + emprise[3]) / 2] : [1, 0];
    const axe = Math.abs(d[0]) >= Math.abs(d[1]) ? [Math.sign(d[0]) || 1, 0] : [0, Math.sign(d[1]) || 1];
    const bord = axe[0] ? (axe[0] > 0 ? b[2] : -b[0]) : (axe[1] > 0 ? b[3] : -b[1]);
    const surContour = (s) => dContour((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, p.poly) < 0.05;
    const siens = (plan.bords || []).filter(surContour);
    let ouverts = siens.filter((s) => !FERMES.has(s.type)).map((s) => [s.a, s.b]);
    if (!ouverts.length) { const dedansP = (plan.pieces || []).filter((q) => !q.exterieur && q.poly?.length >= 3);
      for (let i = 0; i < n; i++) { const a = p.poly[i], c = p.poly[(i + 1) % n], mx = (a[0] + c[0]) / 2, mz = (a[1] + c[1]) / 2;
        if (siens.some((s) => dSeg(mx, mz, s.a, s.b) < 0.05)) continue;
        if (dedansP.every((q) => dContour(mx, mz, q.poly) > 0.45)) ouverts.push([a, c]); } }
    const rinfo = rects.map((r) => {
      if (!ouverts.length) return { axe, bord };
      const cx = (r[0] + r[2]) / 2, cz = (r[1] + r[3]) / 2, [a, c] = ouverts.reduce((m, s) => (dSeg(cx, cz, s[0], s[1]) < dSeg(cx, cz, m[0], m[1]) ? s : m));
      let nx = -(c[1] - a[1]), nz = c[0] - a[0]; if (nx * ((a[0] + c[0]) / 2 - cx) + nz * ((a[1] + c[1]) / 2 - cz) < 0) { nx = -nx; nz = -nz; }
      const ax = Math.abs(nx) >= Math.abs(nz) ? [Math.sign(nx), 0] : [0, Math.sign(nz)];
      return { axe: ax, bord: Math.max(ax[0] * a[0] + ax[1] * a[1], ax[0] * c[0] + ax[1] * c[1]) };
    });
    exterieurs.push({ id: p.id, type: p.type, rects, rinfo, boite: b, axe, bord, couvert: null, biais, haut: HAUT_EXT });
  }
  let tousRects = exterieurs.flatMap((e) => e.rects.map((r, i) => ({ e, r, axe: e.rinfo[i].axe, bord: e.rinfo[i].bord })));
  if (tousRects.length > NB_MAX) { etat.erreurs.push(`extérieurs : contour trop découpé (${tousRects.length} rectangles pour ${NB_MAX} au plus), finition incomplète`); tousRects = tousRects.slice(0, NB_MAX); }
  const NB = Math.max(1, tousRects.length);
  for (const t of tousRects) { t.b = new THREE.Vector4(t.r[0] - 0.03, t.r[1] - 0.03, t.r[2] + 0.03, t.r[3] + 0.03); t.v = t.b.clone(); }      // b : le rectangle élargi ; v : ce que voit le nuanceur (vidé si l'extérieur est à ciel ouvert)
  const VIDE = () => new THREE.Vector4(1, 1, 0, 0);
  const uBalcon = { value: [...Array(NB)].map((_, i) => tousRects[i]?.v || VIDE()) };
  const uBalconInfo = { value: [...Array(NB)].map((_, i) => { const t = tousRects[i]; return t ? new THREE.Vector4(t.axe[0], t.axe[1], t.bord, HAUT_EXT) : new THREE.Vector4(1, 0, 0, HAUT_EXT); }) };      // w : remplacé par la hauteur mesurée après le chargement
  const uBalconZ = { value: [...Array(NB)].map((_, i) => { const e = tousRects[i]?.e; return e ? new THREE.Vector2(Math.min(...e.rects.map((r) => r[1])) - 0.03, Math.max(...e.rects.map((r) => r[3])) + 0.03) : new THREE.Vector2(0, 0); }) };
  // Spots : un par luminaire de plafond d'un extérieur couvert, placés après le chargement du GLB. Aucun : seul le fond d'ambiance éclaire la nuit.
  const uSpot = { v3Ext: { value: nuitee(amb) ? 1 : 0 }, v3Spots: { value: [new THREE.Vector3()] }, v3BalconInfo: uBalconInfo, v3BalconZ: uBalconZ,
    v3SpotK: { value: new THREE.Vector4(0.06 * (Number.isFinite(sc?.codage?.fond_nuit_k) ? sc.codage.fond_nuit_k : 1), 0.09, 0.18, 1) }, v3SpotCouleur: { value: new THREE.Vector3(1.06, 0.97, 0.86) }, v3Ambre: { value: new THREE.Vector3(1.12, 0.86, 0.56) },      // v3SpotK : x fond, y spot, z adoucissement (m), w exposant du cosinus
    v3Interieur: { value: emprise[0] < emprise[2] ? new THREE.Vector4(emprise[0] - 0.01, emprise[1] - 0.01, emprise[2] + 0.01, emprise[3] + 0.01) : new THREE.Vector4(-1e9, -1e9, 1e9, 1e9) },
    v3Pierre: { value: new THREE.Color("#dccbb3").convertSRGBToLinear() } };      // enduit pierre chaude, un seul albédo pour tous les extérieurs couverts
  // L'en-tête est écrit à la compilation des matières (après le chargement) : le nombre de rectangles et de spots y est une constante.
  const entete = () => `#define V3_NB ${NB}\n#define V3_NS ${Math.max(1, uSpot.v3Spots.value.length)}\n`
    + "uniform sampler2D v3CarteB;\nuniform float v3ForceB;\nuniform float v3Melange;\nuniform float v3Occ;\nuniform float v3Lisse;\nuniform vec3 v3Chaud;\nuniform float v3Sat;\nuniform float v3Genou;\nvarying vec3 v3Monde;\n"
    + "uniform vec4 v3Balcon[ V3_NB ];\nuniform vec4 v3BalconInfo[ V3_NB ];\nuniform vec2 v3BalconZ[ V3_NB ];\nuniform vec3 v3Spots[ V3_NS ];\n"
    + "uniform float v3Ext;\nuniform vec3 v3Pierre;\nuniform vec4 v3SpotK;\nuniform vec3 v3SpotCouleur;\nuniform vec3 v3Ambre;\nuniform vec4 v3Interieur;\nvarying vec3 v3NMonde;\n"
    + "float v3SpotTerme( vec3 n ) { float s = 0.0;\n\tfor ( int i = 0; i < V3_NS; i ++ ) { vec3 d = v3Spots[ i ] - v3Monde; float rr = dot( d, d ); s += pow( max( dot( n, d ) * inversesqrt( rr ), 0.0 ), v3SpotK.w ) / ( rr + v3SpotK.z * v3SpotK.z ); }\n\treturn v3SpotK.y * s; }\n"
    // angles feutrés : en x, les bords du rectangle où se trouve le fragment ; en z, toute l'étendue de son extérieur ; en hauteur, du sol à son plafond
    + "float v3Angles( vec3 n, int r ) { float x0 = 0.0, x1 = 0.0, z0 = v3BalconZ[ r ].x, z1 = v3BalconZ[ r ].y, haut = v3BalconInfo[ r ].w;\n"
    + "\tfor ( int i = 0; i < V3_NB; i ++ ) { vec4 b = v3Balcon[ i ]; if ( b.x > b.z ) continue;\n"
    + "\t\tif ( v3Monde.x >= b.x && v3Monde.z >= b.y && v3Monde.x <= b.z && v3Monde.z <= b.w ) { x0 = b.x; x1 = b.z; } }\n"
    + "\tvec3 a = abs( n ); float ao = 1.0, k = 0.32, r2 = 0.28;\n"
    + "\tif ( a.x < 0.7 ) ao *= ( 1.0 - k * exp( - ( v3Monde.x - x0 ) / r2 ) ) * ( 1.0 - k * exp( - ( x1 - v3Monde.x ) / r2 ) );\n"
    + "\tif ( a.z < 0.7 ) ao *= ( 1.0 - k * exp( - ( v3Monde.z - z0 ) / r2 ) ) * ( 1.0 - k * exp( - ( z1 - v3Monde.z ) / r2 ) );\n"
    + "\tif ( a.y < 0.7 ) ao *= ( 1.0 - k * exp( - v3Monde.y / r2 ) ) * ( 1.0 - k * exp( - ( haut - v3Monde.y ) / r2 ) );\n"
    + "\treturn ao; }\n"
    // rectangle d'extérieur couvert où tombe le fragment (à la marge m près), ou -1
    + "int v3Rect( float m ) { for ( int i = 0; i < V3_NB; i ++ ) { vec4 b = v3Balcon[ i ]; if ( b.x > b.z ) continue; b += vec4( - m, - m, m, m ); if ( v3Monde.x >= b.x && v3Monde.z >= b.y && v3Monde.x <= b.z && v3Monde.z <= b.w ) return i; } return - 1; }\n"
    + "float v3Rayon() {\n#ifdef V3_LISSE\n\treturn v3Lisse * float( V3_LISSE_K );\n#else\n\treturn 0.0;\n#endif\n}\n"
    + "vec3 v3Lire( sampler2D c, vec2 uv ) {\n\tfloat R = v3Rayon();\n\tif ( R <= 0.0 ) return texture2D( c, uv ).rgb;\n\tvec3 s = texture2D( c, uv ).rgb;\n"
    + "\tfor ( int i = 0; i < 16; i ++ ) { float a = float( i ) * 2.39996, r = R * sqrt( ( float( i ) + 0.5 ) / 16.0 ); s += texture2D( c, uv + r * vec2( cos( a ), sin( a ) ) ).rgb; }\n\treturn s / 17.0;\n}\n";
  const uLisse = { value: 0 }, LISSES = /^Sol de terrasse/, COQUES = /^(Enduit|Plafond|Verre depoli|Coupe de mur)/;      // sol du balcon : flou de nuit ; coques : lumière calculée dans le balcon
  const cartesB = new Map();      // matière -> uniforme de la carte de l'autre ambiance
  // Décalque : une couche posée à plat sur une autre (seuil sur le sol, aplat sur le papier, plinthe contre un meuble) est poussée de quelques millimètres
  // le long de sa normale, dans le nuanceur. Contrairement au décalage de polygone (qui grandit avec la pente et faisait traverser les murs en vue rasante :
  // plinthes, seuils et portes apparaissaient à travers les cloisons en avançant), l'écart est fixe, invisible, et tranche toujours dans le même sens.
  const DECALS = [[/^Aplat (\d+)/, (k) => 0.003 + 0.0006 * k], [/^Ecran/, 0.0032], [/^Appareillage puits/, 0.002], [/^Appareillage/, 0.0026], [/^Eponge/, 0.0024],
    [/^Papier/, 0.002], [/^(Alu anthracite|Porte|Laque blanche mate)$/, 0.0016], [/^(Tapis|side_table)/, 0.0012], [/^Alu anthracite k0\.9$/, 0.0012],
    [/^Noir$/, 0.001], [/^Enduit de facade k0\.3$/, 0.001], [/^(Seuil|Plinthe)/, 0.0008], [/^(Chene|Tete de lit)/, 0.0004]];
  const decal = (nom) => { for (const [re, v] of DECALS) { const r = re.exec(nom || ""); if (r) return typeof v === "function" ? v(+r[1]) : v; } return 0; };
  const DECALER = (sh, d) => { sh.uniforms.v3Decal = d; sh.vertexShader = "uniform float v3Decal;\n" + sh.vertexShader.replace("#include <begin_vertex>", "#include <begin_vertex>\n\ttransformed += normalize( objectNormal ) * v3Decal;"); };
  const DOUBLES = /^(Porte|Alu anthracite|Noir$|Papier|Plinthe|Laque blanche mate|Enduit de facade|Coupe de mur|Rideau)/;
  function brancherCarte(m, atlas, d = 0) {
    const u = { value: null }, ud = { value: d }; cartesB.set(m, { u, atlas });
    // Un seul côté dessiné partout où c'est possible. Rejeter les faces vues de dos DANS le nuanceur (discard) empêche la carte graphique d'écarter
    // d'avance les surfaces cachées : elle calculait toutes les couches superposées, 9 ms par image sur un grand écran Retina (mesuré). Relevé sur
    // 48 vues, matière par matière : seules celles de DOUBLES (et les petits objets de l'atlas c) ont des faces réellement vues de dos ; elles gardent
    // les deux côtés et le rejet. Toutes les autres (murs, sols, plafonds, gros meubles) passent en face avant, sans rejet. ?faces=2 : ancien mode.
    const unCote = Q.get("faces") !== "2" && atlas !== "c" && !DOUBLES.test(m.name) && !(m.alphaTest > 0) && !m.transparent;
    if (unCote) { m.side = THREE.FrontSide; etat.unCote = (etat.unCote || 0) + 1; }
    const dessous = !unCote && !(m.alphaTest > 0) && !m.transparent;      // une feuille vue de dos reste une feuille
    m.onBeforeCompile = (sh) => { sh.uniforms.v3CarteB = u; sh.uniforms.v3ForceB = uForceB; sh.uniforms.v3Melange = uMelange; sh.uniforms.v3Occ = uOcc; sh.uniforms.v3Lisse = uLisse;
      sh.uniforms.v3Chaud = atlas === "a" ? uChaudA : uChaudB; sh.uniforms.v3Sat = atlas === "a" ? uSatA : UN; sh.uniforms.v3Genou = uGenou; sh.uniforms.v3Balcon = uBalcon; Object.assign(sh.uniforms, uSpot); ton(sh); DECALER(sh, ud);
      sh.vertexShader = "varying vec3 v3Monde;\nvarying vec3 v3NMonde;\n" + sh.vertexShader.replace("#include <project_vertex>", "#include <project_vertex>\n\tv3Monde = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;\n\tv3NMonde = mat3( modelMatrix ) * objectNormal;");
      sh.fragmentShader = entete() + sh.fragmentShader.replace("#include <lights_fragment_maps>", BLOC_CARTE); };
    const lisse = LISSES.test(m.name), k = 1, coque = COQUES.test(m.name);
    m.defines = { ...(m.defines || {}), ...(lisse ? { V3_LISSE: "", V3_LISSE_K: k.toFixed(2) } : {}), ...(dessous ? { V3_DESSOUS: "" } : {}), ...(coque ? { V3_COQUE: "" } : {}), ...(/^Plafond/.test(m.name) ? { V3_PLAFOND: "" } : {}) };
    if (coque) m.dithering = true;      // dégradé lisse sans marches de 8 bits
    const mat = Q.get("mat") !== "0" && m.roughness >= 0.8 && !m.roughnessMap && !m.metalnessMap && !(m.metalness > 0) && !(m.clearcoat > 0);
    if (mat) { m.defines.V3_MAT = ""; etat.mats = (etat.mats || 0) + 1; }
    const cle = "v3-carte" + (lisse ? "-lisse" + k : "") + (dessous ? "-dessous" : "") + (coque ? "-coque" : "") + (/^Plafond/.test(m.name) ? "-plafond" : "") + (mat ? "-mat" : "");
    m.customProgramCacheKey = () => cle;
  }
  function brancherVerre(m) {
    // la vitre devient plus opaque là où elle reflète : le reflet s'ajoute à ce qu'on voit au travers au lieu d'être éteint par la transparence
    m.onBeforeCompile = (sh) => { sh.uniforms.v3Pose = uPose; ton(sh); sh.fragmentShader = "uniform float v3Pose;\n" + sh.fragmentShader.replace("#include <lights_fragment_maps>", BLOC_SANS)
      .replace("#include <opaque_fragment>", "diffuseColor.a = clamp( diffuseColor.a + min( dot( totalSpecular, vec3( 0.2126, 0.7152, 0.0722 ) ) * v3Pose * 0.3, 0.3 ), 0.0, 1.0 );\n#include <opaque_fragment>"); };
    m.customProgramCacheKey = () => "v3-verre";
  }
  function brancherSans(m, d = 0) { const ud = { value: d }; m.onBeforeCompile = (sh) => { ton(sh); DECALER(sh, ud); sh.fragmentShader = sh.fragmentShader.replace("#include <lights_fragment_maps>", BLOC_SANS); }; m.customProgramCacheKey = () => "v3-sans"; }
  // décor ajouté par la visite (sans carte) : éclairé par l'image d'environnement de la pièce, qui est la lumière des panoramas validés
  function brancherDecor(m) { m.onBeforeCompile = (sh) => { ton(sh); }; m.customProgramCacheKey = () => "v3-decor"; return m; }

  const envoyees = new WeakSet();      // textures déjà envoyées à la carte graphique
  const cartes = new Map();      // "atlas|ambiance" -> promesse de texture
  function carte(atlas, a) {
    const cle = atlas + "|" + a;
    if (!cartes.has(cle)) cartes.set(cle, (async () => {
      const nom = sc.cartes[atlas]?.[a]; if (!nom) throw new Error(`carte ${atlas} ${a} absente de scene.json`);
      const src = await image(await telecharger(nom), { plafond: PLAFOND_CARTE });
      // pas de niveaux réduits : les îlots de l'atlas sont serrés, un niveau réduit mélangerait chaque îlot avec ses voisins (liserés sombres aux arêtes)
      const reg = { channel: 1, generateMipmaps: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }, im = src.image;
      // Envoi par bandes : une carte de 4096 envoyée d'un bloc fige l'écran 120 ms (mesuré, c'est le volume, 64 Mo). On réserve la texture vide,
      // puis on y copie huit bandes, une par image : aucune étape ne dépasse une vingtaine de millisecondes, au chargement comme au passage jour / nuit.
      if (typeof ImageBitmap !== "undefined" && im instanceof ImageBitmap && im.height >= 2048 && !src.flipY) {
        try {
          const t = new THREE.DataTexture(null, im.width, im.height, THREE.RGBAFormat, THREE.UnsignedByteType); Object.assign(t, reg); t.colorSpace = THREE.SRGBColorSpace; t.flipY = false;
          t.source.dataReady = false; t.needsUpdate = true; t.name = nom; renderer.initTexture(t);
          const N = 8, hb = Math.ceil(im.height / N);
          for (let k = 0; k < N; k++) { const y = k * hb, hh = Math.min(hb, im.height - y); if (hh <= 0) break;
            const bande = await createImageBitmap(im, 0, y, im.width, hh, OPT), s2 = new THREE.Texture(bande); s2.flipY = false; s2.colorSpace = THREE.SRGBColorSpace;
            renderer.copyTextureToTexture(s2, t, null, new THREE.Vector2(0, y)); bande.close(); await suivante(); }
          im.close(); envoyees.add(t); return t;
        } catch (e) { etat.erreurs.push("bandes : " + (e.message || e)); }
      }
      const t = texture(src, reg); t.name = nom; return t;
    })());
    return cartes.get(cle);
  }
  const emissifs = [], dehorsMat = [];
  const blanc = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); blanc.colorSpace = THREE.SRGBColorSpace; blanc.needsUpdate = true;
  function extra(o, cle) { for (let n = o; n; n = n.parent) if (n.userData && n.userData[cle] != null) return n.userData[cle]; return o.material?.userData?.[cle] ?? o.geometry?.userData?.[cle]; }
  // Matière légère pour les surfaces mates (murs, plafonds, tissus : la majorité de l'écran). Tout y est cuit : couleur x carte de lumière.
  // Le calcul physique complet (reflets d'environnement, relief, rugosité) n'y apporte rien de visible et coûte l'essentiel du temps de la carte
  // graphique. ?lite=0 : tout en matière physique, comme avant.
  const estMat = (m) => Q.get("lite") !== "0" && m.isMeshStandardMaterial && m.roughness >= 0.8 && !m.roughnessMap && !m.metalnessMap && !(m.metalness > 0) && !(m.clearcoat > 0) && !(m.transmission > 0) && !m.transparent;
  function enLeger(b) {
    const m = new THREE.MeshLambertMaterial({ color: b.color.clone(), map: b.map, side: b.side, alphaTest: b.alphaTest, emissive: b.emissive.clone(), emissiveIntensity: b.emissiveIntensity, emissiveMap: b.emissiveMap });
    m.name = b.name; m.userData = b.userData; etat.legers = (etat.legers || 0) + 1; return m;
  }
  function alleger(m) {      // le vernis reste (céramique, écran), le velours part : sans lumière directe il ne se voit pas et coûte cher sur téléphone
    if (!m.isMeshPhysicalMaterial || m.clearcoat > 0 || m.transmission > 0 || m.iridescence > 0) return m.clone();
    const s = new THREE.MeshStandardMaterial(); s.copy(m); return s;
  }
  async function preparerV3(racine) {
    const variantes = new Map(), attente = [], horsContrat = [];
    racine.traverse((o) => {
      if (!o.isMesh) return; etat.maillages++;
      const lm = extra(o, "lm"), role = extra(o, "role"), base = o.material, cle = base.uuid + "|" + (lm || role || "");
      etat.triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
      if (variantes.has(cle)) { o.material = variantes.get(cle); return; }
      let m;
      if (lm && sc.cartes[lm]) {
        m = estMat(base) ? enLeger(base) : alleger(base); m.lightMapIntensity = echelle(amb); brancherCarte(m, lm, decal(base.name));
        attente.push(carte(lm, amb).then((t) => { m.lightMap = t; cartesB.get(m).u.value = t; m.needsUpdate = true; }));
        if (m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0) emissifs.push({ m, nom: base.name, base: m.emissiveIntensity });
      } else if (role === "verre") {
        // Verre quasi incolore : presque rien de face, un voile clair qui monte en vue rasante (Fresnel). Pas de reflet d'environnement :
        // l'image de la pièce y dessinait un halo jaune et teintait tout en sépia vu de l'intérieur.
        m = new THREE.ShaderMaterial({ uniforms: { v3Pose: uPose, v3Verre: uVerre, v3Contraste: uContraste, v3Saturation: uSaturation }, transparent: true, depthWrite: false, side: THREE.DoubleSide,
          vertexShader: "varying vec3 vN;\nvarying vec3 vV;\nvoid main() { vec4 p = modelViewMatrix * vec4( position, 1.0 ); vN = normalMatrix * normal; vV = - p.xyz; gl_Position = projectionMatrix * p; }",
          fragmentShader: "uniform float v3Pose;\nuniform float v3Verre;\nvarying vec3 vN;\nvarying vec3 vV;\nvoid main() {\n\tfloat f = pow( 1.0 - abs( dot( normalize( vN ), normalize( vV ) ) ), 5.0 );\n\tgl_FragColor = vec4( vec3( 1.0, 0.96, 0.9 ) * v3Verre / v3Pose, 0.02 + 0.18 * f );\n\t#include <tonemapping_fragment>\n\t#include <colorspace_fragment>\n}" });
        m.name = base.name;
      } else if (role === "dehors") {
        m = new THREE.MeshBasicMaterial({ map: base.map, color: base.color.clone(), side: base.side, transparent: base.transparent, alphaTest: base.alphaTest, opacity: base.opacity });
        m.name = base.name; m.onBeforeCompile = ton; m.customProgramCacheKey = () => "v3-dehors"; dehorsMat.push({ m, nom: base.name, base: base.color.clone() });
      } else if (role === "emissif") {
        m = alleger(base); brancherSans(m, decal(base.name)); emissifs.push({ m, nom: base.name, base: m.emissiveIntensity });
      } else {
        // maillage sans carte ni rôle : hors contrat. On lui donne une lumière neutre plutôt que de le laisser noir, et on le compte.
        m = alleger(base); m.lightMap = blanc; m.lightMapIntensity = 0.45 * Math.PI; brancherSans(m, decal(base.name)); etat.sansCarte++; horsContrat.push(o.name || base.name || "?");
      }
      if (m.map) m.map.anisotropy = ANISO;
      // Faces superposées : plus de décalage de polygone (voir DECALS), il faisait traverser les cloisons en vue rasante.
      variantes.set(cle, m); o.material = m;
    });
    if (horsContrat.length) etat.erreurs.push(`${etat.sansCarte} maillage(s) sans carte de lumière ni rôle (hors contrat v3), éclairés à plat : ${[...new Set(horsContrat)].slice(0, 6).join(", ")}`);
    await Promise.all(attente);
    forceEmissifs(amb, amb, 0);
  }
  function forceEmissifs(a, b, t) {
    const ra = reglage(a), rb = reglage(b), entre = (x, y) => x + (y - x) * t;
    uContraste.value = entre(ra.contraste, rb.contraste); uSaturation.value = entre(ra.saturation, rb.saturation); uGenou.value = entre(ra.genou, rb.genou);
    uSatA.value = entre(ra.satA, rb.satA); uChaudA.value.set(...ra.chaudA).lerp(new THREE.Vector3(...rb.chaudA), t); uChaudB.value.set(...ra.chaudB).lerp(new THREE.Vector3(...rb.chaudB), t);
    // de jour les plafonniers ne sont pas allumés : leur disque ne doit pas briller comme une lampe
    const lum = (nom, rg) => (nom === "Lumiere" ? rg.lumiere : 1);
    for (const e of emissifs) { const r = e.r || sc?.emissifs?.[e.nom], de = (x) => r?.[x] ?? (e.r ? (nuitee(x) ? e.r.nuit : e.r.jour) : e.base), fa = de(a) * lum(e.nom, ra), fb = de(b) * lum(e.nom, rb); e.m.emissiveIntensity = (fa + (fb - fa) * t) * (e.k ?? 1); if (e.eteinte) e.m.visible = e.m.emissiveIntensity > 0.02;
      if (r?.couleur && !e.teinte) { e.teinte = true; e.m.emissive.setRGB(r.couleur[0], r.couleur[1], r.couleur[2]); e.m.emissiveMap = null; } }
    teintesCiel(a, b, t);
    { const la = nuitee(a) ? 0.012 : 0, lb = nuitee(b) ? 0.012 : 0; uLisse.value = la + (lb - la) * t; }
    uSpot.v3Ext.value = entre(nuitee(a) ? 1 : 0, nuitee(b) ? 1 : 0);
    { const va = nuitee(a) ? 0.05 : 0.32, vb = nuitee(b) ? 0.05 : 0.32; uVerre.value = va + (vb - va) * t; }
    for (const e of dehorsMat) { const fa = sc?.emissifs?.[e.nom]?.[a] ?? 1, fb = sc?.emissifs?.[e.nom]?.[b] ?? 1; e.m.color.copy(e.base).multiplyScalar(fa + (fb - fa) * t); }
  }

  // ---------------------------------------------------------------- dehors : image à l'infini, vue par les baies
  // Dehors : un dôme de ciel dessiné, aucune photo. Le jour un bleu pâle qui descend vers un horizon chaud et voilé, la nuit un bleu profond ;
  // à l'horizon, deux rangs d'arbres de parc en silhouette, fondus dans la brume, tenus bas (3° au plus). Sous l'horizon, la brume du parc.
  // Les teintes sont celles qu'on veut voir à l'écran : le ciel ne passe pas par la courbe de ton (elle virait le bleu au mauve) ni par la pose de la pièce.
  // Seule exception, le rendu du miroir, qui n'a pas de courbe : le ciel y est rendu en lumière de scène approchée.
  const scene3 = (hex) => { const c = new THREE.Color(hex); return new THREE.Vector3(c.r, c.g, c.b); };      // teinte d'écran, en linéaire
  const TEINTES = { jour: { zenith: scene3("#a3c2d9"), horizon: scene3("#f4e4cc"), arbres: scene3("#66745c"), sol: scene3("#d5cfbd") },
    nuit: { zenith: scene3("#060b1c"), horizon: scene3("#17213d"), arbres: scene3("#05080f"), sol: scene3("#0a0f1a") } };
  const teinte = (a) => TEINTES[a] || (nuitee(a) ? TEINTES.nuit : TEINTES.jour);
  const uCiel = { zenith: { value: new THREE.Vector3() }, horizon: { value: new THREE.Vector3() }, arbres: { value: new THREE.Vector3() }, sol: { value: new THREE.Vector3() }, v3Pose: uPose };
  function teintesCiel(a, b, t) { for (const k of ["zenith", "horizon", "arbres", "sol"]) uCiel[k].value.copy(teinte(a)[k]).lerp(teinte(b)[k], t); }
  const ciel = new THREE.Mesh(new THREE.SphereGeometry(1, 48, 24), new THREE.ShaderMaterial({
    uniforms: uCiel, side: THREE.BackSide, depthWrite: false,
    vertexShader: "varying vec3 vD;\nvoid main() { vD = position; gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: `uniform vec3 zenith; uniform vec3 horizon; uniform vec3 arbres; uniform vec3 sol; uniform float v3Pose; varying vec3 vD;
float cime( float a, float f, float p ) { return abs( sin( a * f + p ) ) * 0.55 + abs( sin( a * f * 2.3 + p * 1.7 ) ) * 0.3 + abs( sin( a * f * 5.1 + p * 0.6 ) ) * 0.15; }
void main() {
	vec3 d = normalize( vD ); float el = asin( clamp( d.y, - 1.0, 1.0 ) ), az = atan( d.z, d.x );
	vec3 c = mix( horizon, zenith, pow( clamp( el / 0.9, 0.0, 1.0 ), 0.6 ) );
	c = mix( c, sol, smoothstep( 0.0, - 0.3, el ) );                                              // sous l'horizon : la brume du parc
	float loin = 0.012 + 0.022 * cime( az, 23.0, 1.3 ) + 0.010 * cime( az, 61.0, 4.1 );             // rang lointain, presque dans le ciel
	float pres = 0.004 + 0.030 * cime( az, 13.0, 0.4 ) + 0.014 * cime( az, 37.0, 2.2 ) + 0.005 * cime( az, 113.0, 5.0 );
	c = mix( c, mix( arbres, horizon, 0.7 ), smoothstep( loin + 0.004, loin - 0.004, el ) * smoothstep( - 0.10, - 0.01, el ) );
	c = mix( c, mix( arbres, horizon, 0.42 ), smoothstep( pres + 0.003, pres - 0.003, el ) * smoothstep( - 0.16, - 0.03, el ) );
	c = mix( c, horizon, 0.35 * exp( - abs( el ) * 22.0 ) );                                       // voile de brume sur la lisière
	#ifdef TONE_MAPPING
	gl_FragColor = vec4( c, 1.0 );
	#else
	gl_FragColor = vec4( c * c * 1.6 / v3Pose, 1.0 );
	#endif
	#include <colorspace_fragment>
}`,
  }));
  ciel.scale.setScalar(120); ciel.renderOrder = 999; ciel.frustumCulled = false; ciel.visible = true; scene.add(ciel);
  teintesCiel(amb, amb, 0);

  // ---------------------------------------------------------------- reflets : une image d'environnement par pièce
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envs = new Map(); let envPose = null, envVoulu = null;
  function envNeutre(a) {
    const cle = "neutre|" + a;
    if (!envs.has(cle)) {
      const cv = document.createElement("canvas"); [cv.width, cv.height] = TAILLE_ENV; const c = cv.getContext("2d"), g = c.createLinearGradient(0, 0, 0, cv.height);
      const tons = nuitee(a) ? ["#3a2f24", "#241c15", "#120e0a"] : ["#f3ece2", "#d9cfc2", "#8f8170"];
      g.addColorStop(0, tons[0]); g.addColorStop(0.5, tons[1]); g.addColorStop(1, tons[2]); c.fillStyle = g; c.fillRect(0, 0, cv.width, cv.height);
      const t = new THREE.CanvasTexture(cv); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
      const rt = pmrem.fromEquirectangular(t); t.dispose();
      envs.set(cle, Promise.resolve({ rt, lacet: 0, force: v3 ? 1 / POSE : 0.7, cle }));
    }
    return envs.get(cle);
  }
  function refletDe(id, a) {
    const tous = (sc?.reflets || []).filter((r) => r[a]); if (!tous.length) return null;
    const ici = tous.filter((r) => r.piece === id), L = ici.length ? ici : tous, d = (r) => (r.pos ? Math.hypot(r.pos[0] - pos.x, r.pos[2] - pos.z) : 1e9);
    return L.reduce((m, r) => (d(r) < d(m) ? r : m), L[0]);      // une pièce peut avoir plusieurs images (salon, cuisine) : la plus proche
  }
  function envDe(id, a) { const r = refletDe(id, a); return r ? envR(r, a) : envNeutre(a); }
  function envR(r, a) {
    const cle = r[a];
    if (!envs.has(cle)) envs.set(cle, (async () => {
      const enScene = (r.codage || sc.reflets_codage || "affichage") === "scene";
      const src = await image(await telecharger(r[a]), { exact: TAILLE_ENV, retourner: enScene }), [w, h] = TAILLE_ENV;
      let t;
      if (enScene) t = texture(src, { mapping: THREE.EquirectangularReflectionMapping });
      else {
        // Image d'écran (panorama validé, déjà posé et passé par la courbe de ton) : on remonte à la lumière de scène, pour qu'un miroir
        // affiché avec la pose de la pièce redonne le panorama. Par canal, matrices de l'AgX ignorées : c'est un reflet, pas une mesure.
        const cv = document.createElement("canvas"); cv.width = w; cv.height = h; const c2 = cv.getContext("2d", { willReadFrequently: true }); c2.drawImage(src.image, 0, 0, w, h);
        const px = c2.getImageData(0, 0, w, h).data, pose = POSE * (r.expo?.[a] ?? (typeof r.expo === "number" ? r.expo : sc.expo?.[a]?.[r.piece]) ?? 1), table = new Uint16Array(256), un = THREE.DataUtils.toHalfFloat(1);
        for (let i = 0; i < 256; i++) table[i] = THREE.DataUtils.toHalfFloat(Math.min(inverseTon[i] / pose, 60000));
        const out = new Uint16Array(w * h * 4);
        for (let y = 0; y < h; y++) { let s = (h - 1 - y) * w * 4, o = y * w * 4; for (let x = 0; x < w; x++, s += 4, o += 4) { out[o] = table[px[s]]; out[o + 1] = table[px[s + 1]]; out[o + 2] = table[px[s + 2]]; out[o + 3] = un; } }
        t = new THREE.DataTexture(out, w, h, THREE.RGBAFormat, THREE.HalfFloatType); t.colorSpace = THREE.LinearSRGBColorSpace; t.mapping = THREE.EquirectangularReflectionMapping;
        t.minFilter = t.magFilter = THREE.LinearFilter; t.needsUpdate = true;
      }
      const rt = pmrem.fromEquirectangular(t); t.dispose(); src.image.close?.();
      return { rt, lacet: r.lacet_deg || 0, force: parAmb(r.echelle, a, 1), cle };
    })().catch((e) => { etat.erreurs.push(String(e.message || e)); return envNeutre(a); }));
    return envs.get(cle);
  }
  // Une seule image de reflets pour toute la visite. Donner à la scène une AUTRE texture à chaque changement de pièce oblige le moteur à revérifier
  // le programme de chacune des matières (une soixantaine) : des images de 117 ms en entrant dans la salle d'eau ou l'entrée (mesuré). On recopie
  // donc l'image de la pièce dans une texture commune, qui reste celle de la scène : pour le moteur rien ne change, seul le contenu change.
  let envCommun = null;
  const copie = { scene: new THREE.Scene(), cam: new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1), mat: new THREE.ShaderMaterial({ uniforms: { t: { value: null } }, depthTest: false, depthWrite: false, toneMapped: false,
    vertexShader: "varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4( position.xy, 0.0, 1.0 ); }", fragmentShader: "uniform sampler2D t;\nvarying vec2 vUv;\nvoid main() { gl_FragColor = texture2D( t, vUv ); }" }) };
  { const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), copie.mat); q.frustumCulled = false; copie.scene.add(q); }
  function poserEnv(e) {
    if (!e || envPose === e) return; envPose = e;
    const src = e.rt.texture, w = e.rt.width, h = e.rt.height;
    try {
      if (!envCommun) { envCommun = new THREE.WebGLRenderTarget(w, h, { type: src.type, format: src.format, colorSpace: src.colorSpace, magFilter: src.magFilter, minFilter: src.minFilter, generateMipmaps: false, depthBuffer: false });
        envCommun.texture.mapping = src.mapping; envCommun.texture.name = "reflets communs"; }
      if (envCommun.width !== w || envCommun.height !== h) throw new Error("taille");
      copie.mat.uniforms.t.value = src; const cible = renderer.getRenderTarget(); renderer.setRenderTarget(envCommun); renderer.render(copie.scene, copie.cam); renderer.setRenderTarget(cible);
      scene.environment = envCommun.texture;
    } catch (err) { scene.environment = src; }
    scene.environmentRotation.set(0, -rad(e.lacet), 0); scene.environmentIntensity = e.force; demander();
  }

  // ---------------------------------------------------------------- chargement de la scène
  const glbNom = v3 ? (sc.glb || "scene.glb") : (V.glb || "lot.glb");
  prevoir([glbNom]);
  if (v3) prevoir(Object.values(sc.cartes).map((c) => c[amb]));
  majBarre();
  const G = grille(obstacles, limites);
  const pos = { x: V.depart?.x ?? V.pieces[0].x, z: V.depart?.z ?? V.pieces[0].z };
  G.inonder(pos.x, pos.z);
  // Points d'arrivée. Base : les points des panoramas validés (reflets de scene.json) quand ils existent, sinon ceux de visite.json.
  // Puis chaque point est écarté des parois : 60 cm au moins, ou presque le maximum que la pièce permet (un dégagement de 87 cm n'offre pas 60).
  // Nomenclature : celle du plan. Une pièce à un seul point porte le nom de la pièce, une pièce à plusieurs points garde le nom de chaque point.
  {
    const dans = (x, z, poly) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [x0, z0] = poly[i], [x1, z1] = poly[j]; if ((z0 > z) !== (z1 > z) && x < (x1 - x0) * (z - z0) / (z1 - z0) + x0) r = !r; } return r; };
    const pieceDe = (x, z) => plan?.pieces?.find((p) => dans(x, z, p.poly));
    let pts = V.pieces.map((p, i) => ({ ...p, piece: plan?.points?.[i]?.piece ?? pieceDe(p.x, p.z)?.id ?? null }));
    const refl = (sc?.reflets || []).filter((r) => r.pos && r.piece);
    if (v3 && plan && refl.length) {
      const libres = pts.slice(), ordre = (id) => { const k = pts.findIndex((p) => p.piece === id); return k < 0 ? 99 : k; };
      const prendre = (c) => { if (c) libres.splice(libres.indexOf(c), 1); return c; };
      const nv = refl.map((r) => ({ r, c: prendre(libres.find((p) => p.piece === r.piece && p.nom === r.nom)) }));
      for (const e of nv) if (!e.c) e.c = prendre(libres.filter((p) => p.piece === e.r.piece).sort((a, b) => Math.hypot(a.x - e.r.pos[0], a.z - e.r.pos[2]) - Math.hypot(b.x - e.r.pos[0], b.z - e.r.pos[2]))[0]);
      pts = nv.map(({ r, c }) => ({ nom: r.nom || c?.nom || r.piece, piece: r.piece, x: r.pos[0], z: r.pos[2], cx: c?.cx, cz: c?.cz, cy: c?.cy, cap: (r.lacet_deg || 0) + 90 })).sort((a, b) => ordre(a.piece) - ordre(b.piece) || (a.nom === "Cuisine") - (b.nom === "Cuisine"));
    }
    for (const p of pts) {
      const poly = plan?.pieces?.find((q) => q.id === p.piece)?.poly; if (!poly) continue;
      let maxi = 0; const n = Math.ceil(1.5 / PAS), ci = Math.floor((p.x - G.x0) / PAS), cj = Math.floor((p.z - G.z0) / PAS), cases = [];
      for (let j = Math.max(0, cj - n); j <= Math.min(G.nz - 1, cj + n); j++) for (let i = Math.max(0, ci - n); i <= Math.min(G.nx - 1, ci + n); i++) {
        const c = j * G.nx + i; if (!G.acces[c]) continue; const [x, z] = G.centre(c); if (!dans(x, z, poly)) continue; cases.push([c, x, z]); if (G.d[c] > maxi) maxi = G.d[c]; }
      const seuil = Math.min(0.6, 0.92 * maxi);
      if (G.dist(p.x, p.z) >= seuil || !cases.length) continue;
      let mieux = null, dm = 1e9; for (const [c, x, z] of cases) { if (G.d[c] < seuil) continue; const k = Math.hypot(x - p.x, z - p.z); if (k < dm) { dm = k; mieux = [x, z]; } }
      if (mieux) { p.x = +mieux[0].toFixed(3); p.z = +mieux[1].toFixed(3); }
    }
    if (plan?.pieces) for (const q of plan.pieces) { q.points = pts.map((p, i) => (p.piece === q.id ? i : -1)).filter((i) => i >= 0); if (q.points.length === 1) pts[q.points[0]].nom = q.nom; }
    V.pieces = pts;
  }

  const tampon = await telecharger(glbNom, "tampon");
  const gltf = await new Promise((ok, ko) => new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).parse(tampon, "./", ok, ko));
  const racine = gltf.scene;
  racine.traverse((o) => { if (o.isLight || o.isCamera) o.visible = false; });
  if (v3) {
    etat.mode = "v3";
    await preparerV3(racine);
  } else {
    // secours : pas de lumière cuite. Un ciel, un soleil sans ombre et un environnement neutre, pour une image lisible.
    etat.mode = "secours";
    racine.traverse((o) => { if (o.isMesh) { etat.maillages++; etat.triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3; if (o.material.map) o.material.map.anisotropy = ANISO;
      if (o.material.transparent) o.material.depthWrite = false; } });
    const so = V.lumiere?.soleil, vers = so?.vers || [0.6, 0.6, 0.4];
    scene.add(new THREE.HemisphereLight(0xfff6ea, 0xcdbfa8, 2.1));
    const soleil = new THREE.DirectionalLight(new THREE.Color(...(so?.couleur || [1, 0.92, 0.8])), 1.1); soleil.position.set(vers[0], vers[1], vers[2]); scene.add(soleil);
  }
  scene.add(racine);
  scene.updateMatrixWorld(true);
  // Morceaux d'un maillage : triangles regroupés quand leurs boîtes se touchent (un maillage par matière : les trois abat-jour, ou deux parois
  // en verre dépoli de deux balcons, sont un seul maillage).
  function morceaux(o, marge = 0.02) {
    const g = o.geometry, p = g.attributes.position, idx = g.index ? g.index.array : null, n = (idx ? idx.length : p.count) / 3, v = new THREE.Vector3();
    const bx = []; for (let t = 0; t < n; t++) { const b = new THREE.Box3(); for (let k = 0; k < 3; k++) { v.fromBufferAttribute(p, idx ? idx[3 * t + k] : 3 * t + k).applyMatrix4(o.matrixWorld); b.expandByPoint(v); } bx.push(b); }
    const pere = bx.map((_, i) => i), chef = (i) => { while (pere[i] !== i) i = pere[i] = pere[pere[i]]; return i; };
    for (let i = 0; i < n; i++) { const a = bx[i].clone().expandByScalar(marge); for (let j = i + 1; j < n; j++) if (a.intersectsBox(bx[j])) pere[chef(j)] = chef(i); }
    const out = new Map(); for (let i = 0; i < n; i++) { const c = chef(i); if (!out.has(c)) out.set(c, new THREE.Box3()); out.get(c).union(bx[i]); }
    return [...out.values()];
  }
  const dansExt = (e, x, z) => tousRects.some((t) => t.e === e && x >= t.b.x && z >= t.b.y && x <= t.b.z && z <= t.b.w);
  // Plafond de chaque extérieur : neuf points par rectangle, couvert si la moitié au moins a une dalle (matière Plafond, horizontale) au-dessus.
  if (v3 && exterieurs.length) {
    const dalles = [], P = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
    racine.traverse((o) => { if (!o.isMesh || !/^Plafond/.test(o.material?.name || "")) return; const pa = o.geometry.attributes.position, ix = o.geometry.index, n = (ix ? ix.count : pa.count) / 3;
      for (let t = 0; t < n; t++) { for (let k = 0; k < 3; k++) P[k].fromBufferAttribute(pa, ix ? ix.getX(3 * t + k) : 3 * t + k).applyMatrix4(o.matrixWorld);
        if (P[0].y < H - 0.05 || P[0].y > H + 0.5 || Math.abs(P[0].y - P[1].y) > 0.02 || Math.abs(P[0].y - P[2].y) > 0.02) continue;
        dalles.push([P[0].x, P[0].z, P[1].x, P[1].z, P[2].x, P[2].z, P[0].y]); } });
    const sous = (x, z) => dalles.some(([ax, az, bx, bz, cx, cz]) => { const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz), d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz), d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
      return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0)); });
    for (const e of exterieurs) { let n = 0, oui = 0;
      for (const r of e.rects) for (const fx of [1 / 6, 0.5, 5 / 6]) for (const fz of [1 / 6, 0.5, 5 / 6]) { n++; if (sous(r[0] + (r[2] - r[0]) * fx, r[1] + (r[3] - r[1]) * fz)) oui++; }
      e.couvert = oui * 2 >= n;
      // hauteur du plafond : la face la plus basse des dalles dont le centre tombe dans l'extérieur (le dessus de la dalle est plus haut), au millimètre
      if (e.couvert) { const ys = dalles.filter((q) => dansExt(e, (q[0] + q[2] + q[4]) / 3, (q[1] + q[3] + q[5]) / 3)).map((q) => q[6]);
        if (ys.length) e.haut = Math.round(Math.min(...ys) * 1000) / 1000; else etat.notes.push(`extérieur ${e.id} : plafond couvert mais sans dalle propre, hauteur prise à ${HAUT_EXT}`);
        tousRects.forEach((t, i) => { if (t.e === e) uBalconInfo.value[i].w = e.haut; }); }
      if (!e.couvert) { for (const t of tousRects) if (t.e === e) t.v.set(1, 1, 0, 0);
        etat.notes.push(`extérieur ${e.id} (${e.type || "?"}) à ciel ouvert : lumière cuite gardée telle quelle de jour comme de nuit, cas jamais jugé à l'œil`); } }
  }
  // Luminaires de plafond d'un extérieur couvert : sommets des maillages émissifs posés en hauteur dans son volume, regroupés à 60 cm près.
  function luminaires(e, dessines) {
    const l = [], v = new THREE.Vector3();
    racine.traverse((o) => { if (!o.isMesh || extra(o, "role") !== "emissif") return; const pa = o.geometry.attributes.position, ix = dessines ? o.geometry.index : null;
      for (let k = 0, N = ix ? ix.count : pa.count; k < N; k++) { v.fromBufferAttribute(pa, ix ? ix.getX(k) : k).applyMatrix4(o.matrixWorld); if (!(v.y > 1.6 && v.y < H + 0.4 && dansExt(e, v.x, v.z))) continue;
        let g = l.find((q) => Math.hypot(q.s.x / q.n - v.x, q.s.z / q.n - v.z) < 0.6); if (!g) l.push(g = { s: new THREE.Vector3(), n: 0 }); g.s.add(v); g.n++; } });
    return l.map((g) => g.s.multiplyScalar(1 / g.n));
  }
  const pres = (x, z) => { let d = 9; for (const b of obst3) if (b[4] >= 2) d = Math.min(d, Math.hypot(Math.max(b[0] - x, 0, x - b[2]), Math.max(b[1] - z, 0, z - b[3]))); return d; };      // distance au mur le plus proche
  // Plafonnier d'un extérieur couvert posé contre un mur (à moins de 30 cm : le moteur le collait à l'angle saillant du mur). S'il est seul dans son
  // extérieur, on le déplace au centre de la travée : milieu de la bande la plus étroite dans le petit sens de l'extérieur, milieu de sa longueur
  // dans le grand sens, avec tout ce qui le compose (les triangles à moins de 16 cm de son diffuseur, en hauteur, hors enduits et plafonds, sont
  // extraits de leur maillage et translatés). Un plafonnier que le moteur a déjà dégagé des murs n'est pas touché, pas plus que s'il y en a plusieurs
  // (leur place est alors voulue) ni si scene.json annonce a_la_source: ["plafonnier_balcon"].
  if (v3 && !aLaSource("plafonnier_balcon")) for (const e of exterieurs.filter((q) => q.couvert)) {
    const l = luminaires(e, false); if (l.length !== 1 || pres(l[0].x, l[0].z) >= 0.3) continue;
    const c = l[0], rs = tousRects.filter((t) => t.e === e).map((t) => t.b), x0 = Math.min(...rs.map((b) => b.x)), x1 = Math.max(...rs.map((b) => b.z)), z0 = Math.min(...rs.map((b) => b.y)), z1 = Math.max(...rs.map((b) => b.w));
    let dx, dz;
    if (z1 - z0 >= x1 - x0) { const etroit = rs.reduce((m, b) => (b.z - b.x < m.z - m.x ? b : m)); dx = (etroit.x + etroit.z) / 2 - c.x; dz = (z0 + z1) / 2 - c.z; }
    else { const etroit = rs.reduce((m, b) => (b.w - b.y < m.w - m.y ? b : m)); dx = (x0 + x1) / 2 - c.x; dz = (etroit.y + etroit.w) / 2 - c.z; }
    const boite = new THREE.Box3(new THREE.Vector3(c.x - 0.16, H - 0.15, c.z - 0.16), new THREE.Vector3(c.x + 0.16, H + 0.3, c.z + 0.16)), a = new THREE.Vector3(), m = new THREE.Vector3();
    const pris2 = [];
    racine.traverse((o) => { if (!o.isMesh || /^(Enduit|Plafond|Coupe de mur|Verre depoli)/.test(o.material?.name || "")) return;
      const g = o.geometry, pa = g.attributes.position, idx = g.index ? Array.from(g.index.array) : [...Array(pa.count).keys()], garde = [], pris = [];
      for (let t = 0; t < idx.length; t += 3) { m.set(0, 0, 0); for (let k = 0; k < 3; k++) m.add(a.fromBufferAttribute(pa, idx[t + k]).applyMatrix4(o.matrixWorld)); m.multiplyScalar(1 / 3);
        (boite.containsPoint(m) ? pris : garde).push(idx[t], idx[t + 1], idx[t + 2]); }
      if (!pris.length) return;
      const g2 = g.clone(); g2.setIndex(pris); g.setIndex(garde);
      const o2 = new THREE.Mesh(g2, o.material); o2.matrix.copy(o.matrixWorld).premultiply(new THREE.Matrix4().makeTranslation(dx, 0, dz)); o2.matrixAutoUpdate = false;
      o2.matrixWorld.copy(o2.matrix); o2.userData = { ...o.userData, lm: extra(o, "lm"), role: extra(o, "role") }; pris2.push(o2);
    });
    for (const o2 of pris2) racine.add(o2);
    racine.updateMatrixWorld(true);
    e.plafonnier = { de: [+c.x.toFixed(3), +c.z.toFixed(3)], vers: [+(c.x + dx).toFixed(3), +(c.z + dz).toFixed(3)], morceaux: pris2.length };
    etat.plafonnier = etat.plafonnier || e.plafonnier;
  }
  // Spots : un par luminaire d'extérieur couvert, 13 cm sous son centre (triangles dessinés seulement, donc après le déplacement ci-dessus).
  {
    let spots = [];
    for (const e of exterieurs.filter((q) => q.couvert)) { e.spots = luminaires(e, true).map((c) => new THREE.Vector3(c.x, c.y - 0.13, c.z)); spots.push(...e.spots); }
    if (spots.length > NS_MAX) { etat.erreurs.push(`extérieurs : ${spots.length} luminaires de plafond pour ${NS_MAX} spots au plus, éclairage de nuit incomplet`); spots = spots.slice(0, NS_MAX); }
    if (spots.length) uSpot.v3Spots.value = spots; else uSpot.v3SpotK.value.y = 0;
    etat.spotBalcon = spots.length ? spots[0].toArray().map((x) => +x.toFixed(3)) : null;
    etat.exterieurs = exterieurs.map((e) => ({ id: e.id, type: e.type, rectangles: e.rects.length, biais: e.biais, couvert: e.couvert, haut: e.haut, dehors: [...new Set(e.rinfo.map((r) => r.axe.join(",") + "@" + r.bord))], spots: (e.spots || []).length, plafonnier: e.plafonnier || null }));
  }
  racine.traverse((o) => { o.matrixAutoUpdate = false; });
  // Jardin en contrebas retiré : tout ce qui est sous le niveau du balcon est coupé (pelouse, haie, buis, dalles, pied de façade),
  // et les maillages qui descendent au jardin et sont entièrement hors de l'emprise du logement (les arbres) sont masqués en entier.
  const COUPE_BAS = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0.1);
  renderer.clippingPlanes = [COUPE_BAS];
  racine.traverse((o) => { if (!o.isMesh) return; o.geometry.computeBoundingBox(); const b = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);
    if (b.max.y < -0.1 || (b.min.y < -1 && (b.min.x > limites[2] || b.max.x < limites[0] || b.min.z > limites[3] || b.max.z < limites[1]))) o.visible = false; });
  ciel.matrixAutoUpdate = false;
  // Joints du balcon : la géométrie du moteur laisse des jours par lesquels on voit le ciel.
  //  1. Entre le haut d'un mur (2,50 m) et le plafond du balcon (2,56 m) : chaque face verticale d'enduit du balcon dont le haut s'arrête
  //     sous le plafond est prolongée jusqu'au-dessus de lui, avec la lumière de son bord haut (mêmes coordonnées de carte).
  //  2. Autour d'une paroi en verre dépoli : un fond anthracite dans l'épaisseur de son cadre, sur toute la section du balcon, et une joue
  //     anthracite au ras du mur là où le mur est en retrait derrière le montant.
  //  Les deux se désactivent seuls quand la géométrie est juste : un mur qui monte jusqu'au plafond n'est pas prolongé, un mur sans retrait n'a pas
  //  de joue, et le fond anthracite reste caché derrière le cadre. scene.json peut aussi annoncer a_la_source: ["joints_balcon"] : rien n'est ajouté.
  if (v3 && !aLaSource("joints_balcon")) try {
    const joints = new THREE.Group(); joints.name = "joints-v3";
    // extérieur couvert où tombe un point (à la marge m près) : sa hauteur de plafond mesurée décide du joint, rien n'est écrit pour 2,50 / 2,56
    const ouEst = (x, z, m) => tousRects.find(({ e, b }) => e.couvert && x >= b.x - m && z >= b.y - m && x <= b.z + m && z <= b.w + m)?.e;
    const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), HAUT = (e) => e.haut + 0.015;
    racine.traverse((o) => {
      if (!o.isMesh || !/^Enduit/.test(o.material?.name || "") || !o.geometry.attributes.uv1) return;
      const g = o.geometry, pa = g.attributes.position, u1 = g.attributes.uv1, ix = g.index, n = (ix ? ix.count : pa.count) / 3, pos = [], nor = [], uv = [], uvb = [], ind = [];
      for (let t = 0; t < n; t++) {
        const i = [0, 1, 2].map((k) => (ix ? ix.getX(3 * t + k) : 3 * t + k)), P = i.map((k) => new THREE.Vector3().fromBufferAttribute(pa, k).applyMatrix4(o.matrixWorld));
        N.subVectors(P[1], P[0]).cross(C.subVectors(P[2], P[0])); if (N.length() < 1e-6) continue; N.normalize(); if (Math.abs(N.y) > 0.05) continue;
        const ym = Math.max(P[0].y, P[1].y, P[2].y); if (ym < H - 0.1) continue;
        const hauts = [0, 1, 2].filter((k) => Math.abs(P[k].y - ym) < 1e-3); if (hauts.length !== 2) continue;
        const a = P[hauts[0]], b = P[hauts[1]], ex = ouEst((a.x + b.x) / 2, (a.z + b.z) / 2, 0.06); if (a.distanceTo(b) < 0.04 || !ex || ym > ex.haut - 0.005) continue;      // un mur qui touche son plafond n'est pas prolongé
        const k0 = pos.length / 3, bas = [0, 1, 2].find((k) => !hauts.includes(k)), L = a.distanceTo(b), sc2 = P[bas].clone().sub(a).dot(b.clone().sub(a)) / (L * L), dy = P[bas].y - ym;
        const U = (k) => [u1.getX(i[k]), u1.getY(i[k])], ua = U(hauts[0]), ub = U(hauts[1]), uc = U(bas), d = Math.min(0.03, -dy * 0.5);
        const gy = [0, 1].map((q) => (uc[q] - ua[q] - sc2 * (ub[q] - ua[q])) / dy);      // variation des coordonnées de carte par mètre de hauteur
        for (const [q, u, y] of [[a, ua, ym - 0.002], [b, ub, ym - 0.002], [b, ub, HAUT(ex)], [a, ua, HAUT(ex)]]) { pos.push(q.x, y, q.z); nor.push(N.x, 0, N.z); uv.push(0, 0); uvb.push(u[0] - d * gy[0], u[1] - d * gy[1]); }
        const sens = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3(0, 1, 0)).dot(N) > 0;      // (b - a) x haut : normale du quadrilatère tel qu'enroulé
        if (sens) ind.push(k0, k0 + 1, k0 + 2, k0, k0 + 2, k0 + 3); else ind.push(k0, k0 + 2, k0 + 1, k0, k0 + 3, k0 + 2);
      }
      if (!ind.length) return;
      const g2 = new THREE.BufferGeometry(); g2.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); g2.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
      g2.setAttribute("uv", new THREE.Float32BufferAttribute(uv, 2)); g2.setAttribute("uv1", new THREE.Float32BufferAttribute(uvb, 2)); g2.setIndex(ind);
      const m2 = new THREE.Mesh(g2, o.material); m2.userData = { lm: extra(o, "lm") }; joints.add(m2);
    });
    etat.joints = { murs: joints.children.length, parois: 0 };
    // parois en verre dépoli
    const anthracite = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.0055, 0.006, 0.0068), side: THREE.DoubleSide }); anthracite.name = "Joint anthracite"; anthracite.onBeforeCompile = ton; anthracite.customProgramCacheKey = () => "v3-joint";
    const haut = (x, z) => obst3.some((b) => b[4] >= 2 && x >= b[0] && x <= b[2] && z >= b[1] && z <= b[3]);
    const plaque = (p0, p1, p2, p3) => { const g2 = new THREE.BufferGeometry(); g2.setAttribute("position", new THREE.Float32BufferAttribute([...p0, ...p1, ...p2, ...p3], 3)); g2.setIndex([0, 1, 2, 0, 2, 3]); joints.add(new THREE.Mesh(g2, anthracite)); };
    racine.traverse((o) => {
      if (!o.isMesh || !/^Verre depoli/.test(o.material?.name || "")) return;
      for (const bb of morceaux(o, 0.03)) {
        const c = bb.getCenter(new THREE.Vector3()), t = bb.getSize(new THREE.Vector3());
        const tr = tousRects.find(({ b }) => c.x >= b.x - 0.1 && c.x <= b.z + 0.1 && c.z >= b.y - 0.1 && c.z <= b.w + 0.1); if (!tr) continue;
        if (Math.min(t.x, t.z) > 0.08) { etat.erreurs.push(`joints : paroi en verre dépoli en biais (extérieur ${tr.e.id}), jours autour de la paroi non bouchés`); continue; }
        const r = tr.b, re = tousRects.filter((q) => q.e === tr.e).map((q) => q.b), cx = re.reduce((s2, b) => s2 + (b.x + b.z) / 2, 0) / re.length, cz = re.reduce((s2, b) => s2 + (b.y + b.w) / 2, 0) / re.length;
        const enZ = t.z < t.x, vers = enZ ? Math.sign(cz - c.z) || 1 : Math.sign(cx - c.x) || 1;      // vers l'intérieur de l'extérieur
        const e = (enZ ? c.z : c.x) - vers * 0.014, lo = (enZ ? r.x : r.y) + 0.03, hi = (enZ ? r.z : r.w) - 0.03;      // bords réels (les rectangles sont élargis de 3 cm)
        const pt = (u, y, w) => (enZ ? [u, y, w] : [w, y, u]);
        const hj = HAUT(tr.e);
        plaque(pt(lo - 0.22, -0.05, e), pt(hi + 0.06, -0.05, e), pt(hi + 0.06, hj, e), pt(lo - 0.22, hj, e));
        for (const [bord, dehors] of [[lo, -1], [hi, 1]]) {
          const q = (w) => (enZ ? [bord + dehors * 0.05, c.z + vers * w] : [c.x + vers * w, bord + dehors * 0.05]);
          if (haut(...q(0.1)) || !haut(...q(0.34))) continue;      // pas de retrait de mur de ce côté
          let w1 = 0.1; while (w1 < 0.4 && !haut(...q(w1))) w1 += 0.01;
          const u = bord - dehors * 0.0015, wa = (enZ ? c.z : c.x) - vers * 0.02, wb = (enZ ? c.z : c.x) + vers * (w1 + 0.03);
          plaque(pt(u, -0.05, wa), pt(u, -0.05, wb), pt(u, hj, wb), pt(u, hj, wa));
        }
        etat.joints.parois++;
      }
    });
    joints.traverse((q) => { q.matrixAutoUpdate = false; }); scene.add(joints); joints.updateMatrixWorld(true);
  } catch (e) { etat.erreurs.push("joints : " + (e.message || e)); }
  if (v3 && Q.get("decor") !== "0") { try { await decorer(); } catch (e) { etat.erreurs.push("décor : " + (e.message || e)); } }

  // ---------------------------------------------------------------- décor refait dans la visite, sans recuisson
  // Le décor d'origine trop simple (aplats géométriques des cadres, suspension noire, globe, abat-jour lisses, corbeille de fruits) est remplacé
  // au même endroit et à la même taille : les ombres cuites sous chaque objet restent justes. Les tableaux reprennent la carte de lumière de leur papier
  // (mêmes coordonnées de carte aux quatre coins), le reste est éclairé par l'image d'environnement de la pièce.
  async function decorer() {
    const deco = new THREE.Group(); deco.name = "decor-v3";
    const parNom = (re) => { const l = []; racine.traverse((o) => { if (o.isMesh && re.test(o.material?.name || "")) l.push(o); }); return l; };
    const boiteDe = (o) => { o.geometry.computeBoundingBox(); return o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld); };
    const cacher = (l) => { for (const o of l) o.visible = false; };
    // objets remplacés : le GLB allégé ne les contient plus, leurs boîtes sont dans scene.json (decor_v3, une boîte par morceau)
    const boites = (re, nom) => { const l = parNom(re); if (l.length) return { objets: l, boites: l.map(boiteDe) };
      return { objets: [], boites: (sc?.decor_v3?.[nom] || []).map((q) => new THREE.Box3(new THREE.Vector3(q[0], q[1], q[2]), new THREE.Vector3(q[3], q[4], q[5]))) }; };
    // retire d'un maillage les triangles dont le centre tombe dans une boîte (l'ampoule de l'ancienne suspension)
    function retirer(o, boite) {
      const g = o.geometry, p = g.attributes.position, idx = g.index ? Array.from(g.index.array) : [...Array(p.count).keys()], garde = [], a = new THREE.Vector3(), c = new THREE.Vector3();
      for (let t = 0; t < idx.length; t += 3) { c.set(0, 0, 0); for (let k = 0; k < 3; k++) c.add(a.fromBufferAttribute(p, idx[t + k]).applyMatrix4(o.matrixWorld)); c.multiplyScalar(1 / 3); if (!boite.containsPoint(c)) garde.push(idx[t], idx[t + 1], idx[t + 2]); }
      g.setIndex(garde);
    }
    const hasard = (s) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const emiCouleur = (nom, d) => sc?.emissifs?.[nom]?.couleur || d;

    // ---- tableaux : œuvres abstraites chaudes (arches, soleil, formes découpées, paysage en bandes) sur passe-partout crème
    const PAL = ["#c4683f", "#d9a54a", "#8e9b7c", "#d8c2a2", "#a5513a", "#6f5a46", "#e7cfa8", "#b9876a"];
    function oeuvre(seed, W, H) {
      const cv = document.createElement("canvas"); cv.width = W; cv.height = H; const c = cv.getContext("2d"), r = hasard(seed * 7919 + 13), pick = () => PAL[Math.floor(r() * PAL.length)];
      c.fillStyle = "#efe6d7"; c.fillRect(0, 0, W, H);
      // l'image couvre tout le papier : le passe-partout crème est dessiné, l'œuvre tient dans le cadre intérieur
      const mg = Math.round(0.12 * Math.min(W, H)); c.save(); c.beginPath(); c.rect(mg, mg, W - 2 * mg, H - 2 * mg); c.clip(); c.translate(mg, mg); c.scale((W - 2 * mg) / W, (H - 2 * mg) / H);
      const genre = seed % 4, m = Math.min(W, H);
      if (genre === 0) {            // arche et soleil
        c.fillStyle = "#e3cfae"; c.fillRect(0, H * 0.62, W, H * 0.38);
        c.fillStyle = "#c4683f"; c.beginPath(); c.moveTo(W * 0.22, H * 0.86); c.lineTo(W * 0.22, H * 0.5); c.arc(W * 0.5, H * 0.5, W * 0.28, Math.PI, 0); c.lineTo(W * 0.78, H * 0.86); c.closePath(); c.fill();
        c.fillStyle = "#d9a54a"; c.beginPath(); c.arc(W * 0.66, H * 0.3, m * 0.12, 0, 2 * Math.PI); c.fill();
        c.fillStyle = "#8e9b7c"; c.fillRect(W * 0.1, H * 0.86, W * 0.8, H * 0.05);
      } else if (genre === 1) {     // formes découpées
        for (let k = 0; k < 5; k++) { c.fillStyle = pick(); c.beginPath(); const cx = W * (0.2 + 0.6 * r()), cy = H * (0.2 + 0.6 * r()), R = m * (0.14 + 0.16 * r());
          for (let a = 0; a <= 24; a++) { const t = a / 24 * 2 * Math.PI, q = R * (1 + 0.22 * Math.sin(3 * t + k) + 0.1 * Math.cos(5 * t + 2 * k)); const x = cx + q * Math.cos(t), y = cy + q * Math.sin(t) * 1.1; a ? c.lineTo(x, y) : c.moveTo(x, y); }
          c.closePath(); c.globalAlpha = 0.92; c.fill(); c.globalAlpha = 1; }
        c.strokeStyle = "#5b4636"; c.lineWidth = m * 0.008; c.beginPath(); c.moveTo(W * 0.15, H * 0.7); c.bezierCurveTo(W * 0.4, H * 0.3, W * 0.6, H * 0.95, W * 0.86, H * 0.4); c.stroke();
      } else if (genre === 2) {     // paysage en bandes douces
        const bandes = ["#f0dcc0", "#e3b98c", "#c98d64", "#a86a4c", "#7f8a6f"];
        bandes.forEach((b, k) => { c.fillStyle = b; c.beginPath(); const y0 = H * (0.3 + k * 0.15); c.moveTo(0, H); c.lineTo(0, y0);
          for (let x = 0; x <= W; x += W / 24) c.lineTo(x, y0 + Math.sin(x / W * Math.PI * (1.2 + k * 0.4) + k) * H * 0.04); c.lineTo(W, H); c.closePath(); c.fill(); });
        c.fillStyle = "#f6efe2"; c.beginPath(); c.arc(W * 0.3, H * 0.2, m * 0.09, 0, 2 * Math.PI); c.fill();
      } else {                      // lignes et pierre
        c.fillStyle = "#d8c2a2"; c.beginPath(); c.ellipse(W * 0.5, H * 0.55, W * 0.3, H * 0.3, -0.3, 0, 2 * Math.PI); c.fill();
        c.fillStyle = "#a5513a"; c.beginPath(); c.arc(W * 0.38, H * 0.42, m * 0.1, 0, 2 * Math.PI); c.fill();
        c.strokeStyle = "#3f342b"; c.lineWidth = m * 0.006; for (let k = 0; k < 3; k++) { c.beginPath(); c.arc(W * 0.6, H * 0.6, m * (0.18 + 0.05 * k), Math.PI * 1.1, Math.PI * 1.9); c.stroke(); }
      }
      c.restore(); c.strokeStyle = "rgba(120,100,80,0.35)"; c.lineWidth = 1.5; c.strokeRect(mg, mg, W - 2 * mg, H - 2 * mg);      // biseau du passe-partout
      // grain du papier
      const im = c.getImageData(0, 0, W, H), d = im.data; for (let i = 0; i < d.length; i += 4) { const g = (r() - 0.5) * 14; d[i] += g; d[i + 1] += g; d[i + 2] += g; } c.putImageData(im, 0, 0);
      const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = ANISO; return t;
    }
    const papiers = parNom(/^Papier/).filter((o) => extra(o, "lm") === "b" && o.geometry.attributes.uv1);
    const aplats = parNom(/^Aplat/).filter((o) => extra(o, "lm") === "b");
    let nTab = 0;
    for (const o of papiers) {
      const g = o.geometry, p = g.attributes.position, uv1 = g.attributes.uv1, idx = g.index ? g.index.array : null, n = (idx ? idx.length : p.count) / 3;
      const A = new THREE.Vector3(), B = new THREE.Vector3(), C = new THREE.Vector3(), N = new THREE.Vector3(), groupes = new Map();
      for (let t = 0; t < n; t++) {
        const i0 = idx ? idx[3 * t] : 3 * t, i1 = idx ? idx[3 * t + 1] : 3 * t + 1, i2 = idx ? idx[3 * t + 2] : 3 * t + 2;
        A.fromBufferAttribute(p, i0).applyMatrix4(o.matrixWorld); B.fromBufferAttribute(p, i1).applyMatrix4(o.matrixWorld); C.fromBufferAttribute(p, i2).applyMatrix4(o.matrixWorld);
        N.subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)); const aire = N.length() / 2; if (aire < 1e-4) continue; N.normalize();
        const k = Math.abs(N.x) > 0.99 ? 0 : Math.abs(N.z) > 0.99 ? 2 : -1; if (k < 0) continue;
        const s = Math.sign(k === 0 ? N.x : N.z), plan = k === 0 ? A.x : A.z, cle = `${k}|${s}|${Math.round(plan * 400)}`;
        if (!groupes.has(cle)) groupes.set(cle, { k, s, plan, tris: [] }); groupes.get(cle).tris.push([i0, i1, i2]);
      }
      for (const gr of groupes.values()) {
        // rectangles du plan : triangles qui se touchent
        const bxs = gr.tris.map((tr) => { const b = new THREE.Box3(); for (const i of tr) b.expandByPoint(A.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld)); return b; });
        const pere = bxs.map((_, i) => i), chef = (i) => { while (pere[i] !== i) i = pere[i] = pere[pere[i]]; return i; };
        for (let i = 0; i < bxs.length; i++) { const e = bxs[i].clone().expandByScalar(0.002); for (let j = i + 1; j < bxs.length; j++) if (e.intersectsBox(bxs[j])) pere[chef(j)] = chef(i); }
        const rects = new Map(); bxs.forEach((b, i) => { const c = chef(i); if (!rects.has(c)) rects.set(c, { b: new THREE.Box3(), tris: [] }); rects.get(c).b.union(b); rects.get(c).tris.push(gr.tris[i]); });
        for (const { b, tris } of rects.values()) {
          const nrm = new THREE.Vector3(gr.k === 0 ? gr.s : 0, 0, gr.k === 2 ? gr.s : 0), droite = new THREE.Vector3(0, 1, 0).cross(nrm);
          const ax = gr.k === 0 ? "z" : "x", u0 = b.min[ax], u1 = b.max[ax], v0 = b.min.y, v1 = b.max.y, w = u1 - u0, h = v1 - v0;
          if (w < 0.15 || h < 0.15) continue;
          const c = b.getCenter(new THREE.Vector3()); { const l = Math.atan2(nrm.x, -nrm.z); if (portee(c.x, c.z, l) <= portee(c.x, c.z, l + Math.PI)) continue; }      // face tournée vers le mur : on garde celle qui regarde la pièce (un canapé devant le cadre ne compte pas, seuls les obstacles hauts)
          // coordonnées de carte aux quatre coins : sommet le plus proche de chaque coin
          const coin = (u, v) => { let m = null, dm = 1e9; for (const tr of tris) for (const i of tr) { A.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld); const k = (A[ax] - u) ** 2 + (A.y - v) ** 2; if (k < dm) { dm = k; m = i; } } return [uv1.getX(m), uv1.getY(m)]; };
          const ag = droite[ax] > 0 ? u0 : u1, ad = droite[ax] > 0 ? u1 : u0;      // gauche et droite vues de face
          const cBG = coin(ag, v0), cBD = coin(ad, v0), cHD = coin(ad, v1), cHG = coin(ag, v1);
          const fx = 0, fy = 0;      // le tableau couvre tout le papier : la carte du papier porte l'ombre cuite des anciens aplats, on ne doit plus la voir
          const lerp2 = (a, b2, t) => [a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t];
          const uvAt = (s, t) => lerp2(lerp2(cBG, cBD, s), lerp2(cHG, cHD, s), t);
          const pts = [[fx, fy], [1 - fx, fy], [1 - fx, 1 - fy], [fx, 1 - fy]], pos = [], uvs = [], uvs1 = [], nor = [];
          for (const [s, t] of pts) { const q = c.clone().addScaledVector(droite, (s - 0.5) * w).setY(v0 + t * h).addScaledVector(nrm, 0.0035); pos.push(q.x, q.y, q.z); uvs.push((s - fx) / (1 - 2 * fx), (t - fy) / (1 - 2 * fy)); uvs1.push(...uvAt(0.04 + 0.02 * s, 0.03 + 0.02 * t)); /* lumière : un petit carré de la marge du papier, sans ombre d'aplat */ nor.push(nrm.x, 0, nrm.z); }
          const geo = new THREE.BufferGeometry(); geo.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3)); geo.setAttribute("normal", new THREE.Float32BufferAttribute(nor, 3));
          geo.setAttribute("uv", new THREE.Float32BufferAttribute(uvs, 2)); geo.setAttribute("uv1", new THREE.Float32BufferAttribute(uvs1, 2)); geo.setIndex([0, 1, 2, 0, 2, 3]);
          const W = 512, Hp = Math.max(64, Math.round(W * h / w));
          const m = new THREE.MeshStandardMaterial({ map: oeuvre(nTab++, W, Math.min(1024, Hp)), roughness: 0.92, metalness: 0, side: THREE.FrontSide }); m.name = "Tableau v3";
          m.lightMapIntensity = echelle(amb); brancherCarte(m, "b", 0); const tx = await carte("b", amb); m.lightMap = tx; cartesB.get(m).u.value = tx;
          const me = new THREE.Mesh(geo, m); me.matrixAutoUpdate = false; deco.add(me);
        }
      }
    }
    if (nTab) cacher(aplats);
    // Chaque papier doit porter une œuvre : le GLB allégé n'a plus les aplats d'origine, un papier resté nu montrerait leur ombre cuite.
    { const feuilles = papiers.flatMap((o) => morceaux(o, 0.002)).filter((b) => { const t = b.getSize(new THREE.Vector3()); return Math.max(t.x, t.z) >= 0.15 && t.y >= 0.15; }).length;
      etat.tableaux = { papiers: feuilles, oeuvres: nTab };
      if (feuilles !== nTab) etat.erreurs.push(`tableaux : ${feuilles} papier(s) encadré(s) pour ${nTab} œuvre(s) posée(s)`); }

    // ---- luminaires en papier plissé (lanterne, globe, abat-jour), même lumière que les abat-jour d'origine
    const papier = (k, nom = "Abat-jour") => { const m = brancherDecor(new THREE.MeshStandardMaterial({ color: 0xf3e8d6, roughness: 0.95, metalness: 0, side: THREE.DoubleSide, emissive: new THREE.Color(...emiCouleur(nom, [1, 0.72, 0.42])) }));
      emissifs.push({ m, nom, base: 0.3, k, teinte: false }); return m; };
    const laiton = brancherDecor(new THREE.MeshStandardMaterial({ color: 0xb48c55, metalness: 1, roughness: 0.32 }));
    function lanterne(R, Hh, cotes = 14) {      // ovoïde à côtes horizontales
      const prof = []; for (let i = 0; i <= 64; i++) { const t = i / 64, base = Math.pow(Math.sin(Math.PI * (0.06 + 0.88 * t)), 0.75), cote = 1 - 0.035 * Math.pow(Math.abs(Math.cos(t * Math.PI * cotes)), 6);
        prof.push(new THREE.Vector2(Math.max(0.004, R * base * cote), -Hh / 2 + Hh * t)); }
      const g = new THREE.LatheGeometry(prof, 72); g.computeVertexNormals(); return g;
    }
    function abatJour(rb, rh, Hh, plis = 36) {      // tambour plissé
      const g = new THREE.CylinderGeometry(rh, rb, Hh, plis * 4, 1, true), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i), a = Math.atan2(z, x), r = Math.hypot(x, z), k = 1 + 0.035 * Math.abs(Math.cos(a * plis / 2)); p.setX(i, Math.cos(a) * r * k); p.setZ(i, Math.sin(a) * r * k); }
      g.computeVertexNormals(); return g;
    }
    const anneau = (r, y, x, z) => { const a = new THREE.Mesh(new THREE.TorusGeometry(r, 0.004, 8, 64).rotateX(Math.PI / 2), laiton); a.position.set(x, y, z); return a; };
    // suspension du séjour : lanterne au-dessus de la table, l'ampoule visible de l'ancienne disparaît
    const susp = boites(/^Suspension noir mat$/, "Suspension noir mat"); cacher(susp.objets);
    for (const b of susp.boites) {
      const c = b.getCenter(new THREE.Vector3()), R = 0.27, Hh = 0.42, y = b.min.y + 0.02 + Hh / 2 - 0.08;
      for (const l of parNom(/^Lumiere$/)) retirer(l, new THREE.Box3(new THREE.Vector3(c.x - 0.3, b.min.y - 0.2, c.z - 0.3), new THREE.Vector3(c.x + 0.3, b.max.y + 0.05, c.z + 0.3)));
      const l = new THREE.Mesh(lanterne(R, Hh), papier(1.5)); l.position.set(c.x, y, c.z); deco.add(l, anneau(0.06, y + Hh / 2 - 0.01, c.x, c.z), anneau(0.09, y - Hh / 2 + 0.012, c.x, c.z));
    }
    // plafonnier de la chambre : petite lanterne à côtes à la place du globe
    const globe = boites(/^Globe opale$/, "Globe opale"); cacher(globe.objets);
    for (const b of globe.boites) {
      const c = b.getCenter(new THREE.Vector3());
      const l = new THREE.Mesh(lanterne(0.2, 0.3, 10), papier(1.4, "Globe opale")); l.position.set(c.x, Math.min(c.y, H - 0.32), c.z); deco.add(l, anneau(0.05, l.position.y + 0.14, c.x, c.z));
    }
    // abat-jour du lampadaire et des chevets : tambours plissés aux mêmes cotes
    {
      const aj = parNom(/^Abat-jour$/), liste = (aj.length ? aj.flatMap((o) => morceaux(o)) : boites(/^$/, "Abat-jour").boites).filter((b) => b.getSize(new THREE.Vector3()).x > 0.08);
      if (liste.length) cacher(aj);
      for (const b of liste) { const s = b.getSize(new THREE.Vector3()), c = b.getCenter(new THREE.Vector3()), r = Math.max(s.x, s.z) / 2;
        const a = new THREE.Mesh(abatJour(r, r * 0.86, s.y), papier(1.2)); a.position.copy(c); deco.add(a, anneau(r * 0.86, c.y + s.y / 2, c.x, c.z), anneau(r, c.y - s.y / 2, c.x, c.z)); }
    }

    // ---- centre de table : vase sculptural et branches d'eucalyptus, plateau de travertin et deux bougies
    const vaseB = boites(/^ceramic_vase_01$/, "ceramic_vase_01"), fruitsB = ["wooden_bowl_01", "food_apple_01", "lemon"].map((n) => boites(new RegExp("^" + n + "$"), n));
    if (vaseB.boites.length) {
      const b = vaseB.boites[0], c = b.getCenter(new THREE.Vector3()), y0 = b.min.y; cacher(vaseB.objets);
      const prof = []; for (let i = 0; i <= 40; i++) { const t = i / 40; prof.push(new THREE.Vector2(0.012 + 0.085 * Math.pow(Math.sin(Math.PI * Math.min(1, t * 1.12)), 0.9) * (1 - 0.55 * t * t) + (t > 0.9 ? (t - 0.9) * 0.25 : 0), t * 0.3)); }
      const vase = new THREE.Mesh(new THREE.LatheGeometry(prof, 64), brancherDecor(new THREE.MeshStandardMaterial({ color: 0xb87554, roughness: 0.82, side: THREE.DoubleSide })));
      vase.position.set(c.x, y0, c.z); deco.add(vase);
      const tige = brancherDecor(new THREE.MeshStandardMaterial({ color: 0x6d6a4c, roughness: 0.8 })), feuilleM = brancherDecor(new THREE.MeshStandardMaterial({ color: 0x8c9a7f, roughness: 0.75, side: THREE.DoubleSide }));
      const r = hasard(7), feuilles = [], haut = Math.min(0.2, (H - 0.1) - (y0 + 0.3));
      for (let k = 0; k < 7; k++) {
        const a = k / 7 * 2 * Math.PI + r() * 0.5, L = 0.22 + 0.12 * r(), dx = Math.cos(a), dz = Math.sin(a);
        const courbe = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.26, 0), new THREE.Vector3(dx * 0.03, 0.3 + haut * 0.6, dz * 0.03), new THREE.Vector3(dx * L * 0.6, 0.3 + haut, dz * L * 0.6), new THREE.Vector3(dx * L, 0.3 + haut * 0.55, dz * L)]);
        const t = new THREE.Mesh(new THREE.TubeGeometry(courbe, 24, 0.0022, 5), tige); t.position.copy(vase.position); deco.add(t);
        for (let q = 0.3; q <= 1.0; q += 0.07) { const pt = courbe.getPoint(q), tg = courbe.getTangent(q); for (const cote of [-1, 1]) feuilles.push({ pt, tg, cote, s: 0.012 + 0.012 * (1 - q) + 0.004 * r(), rot: r() }); }
      }
      const fg = new THREE.CircleGeometry(1, 12), inst = new THREE.InstancedMesh(fg, feuilleM, feuilles.length), M = new THREE.Matrix4(), qq = new THREE.Quaternion(), up = new THREE.Vector3();
      feuilles.forEach((f, i) => { const lat = new THREE.Vector3().crossVectors(f.tg, new THREE.Vector3(0, 1, 0)).normalize().multiplyScalar(f.cote);
        const pos = f.pt.clone().addScaledVector(lat, f.s * 0.9).add(vase.position); up.copy(lat).add(new THREE.Vector3(0, 0.6 + f.rot * 0.6, 0)).normalize();
        qq.setFromUnitVectors(new THREE.Vector3(0, 0, 1), up); M.compose(pos, qq, new THREE.Vector3(f.s, f.s * 1.15, f.s)); inst.setMatrixAt(i, M); });
      inst.instanceMatrix.needsUpdate = true; deco.add(inst);
    }
    if (fruitsB.some((f) => f.boites.length)) {
      // une corbeille par coupe : chaque fruit rejoint la coupe la plus proche (un lot peut en avoir sur le plan de travail ET sur la table ;
      // les fondre en une boîte posait le plateau en l'air entre les deux, vu le 16/11 sur Eiffage C401)
      for (const f of fruitsB) cacher(f.objets);
      const coupes = fruitsB[0].boites.map((q) => q.clone()), autres = fruitsB.slice(1).flatMap((f) => f.boites);
      if (!coupes.length) coupes.push(autres.shift().clone());
      for (const q of autres) { const p = q.getCenter(new THREE.Vector3()); let k = 0, dm = Infinity;
        coupes.forEach((cq, i) => { const d = cq.getCenter(new THREE.Vector3()).distanceTo(p); if (d < dm) { dm = d; k = i; } }); coupes[k].union(q); }
      const pierre = brancherDecor(new THREE.MeshStandardMaterial({ color: 0xdccdb4, roughness: 0.68 })), cire = brancherDecor(new THREE.MeshStandardMaterial({ color: 0xf1e8d8, roughness: 0.6 }));
      const flamme = brancherDecor(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: new THREE.Color(1, 0.62, 0.28) })); emissifs.push({ m: flamme, nom: "Bougie", base: 0, k: 0.6, teinte: true, eteinte: true, r: { jour: 0, nuit: 5 } });      // bougies allumées la nuit seulement (toute ambiance sans soleil), que le lot ait un jardin ou non
      for (const b of coupes) { const c = b.getCenter(new THREE.Vector3()), y0 = b.min.y;
      const plateau = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.145, 0.018, 64), pierre); plateau.scale.set(1, 1, 0.62); plateau.position.set(c.x, y0 + 0.009, c.z); deco.add(plateau);
      for (const [dx, hb] of [[-0.05, 0.24], [0.05, 0.18]]) {
        const pied = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.03, 32), laiton); pied.position.set(c.x + dx, y0 + 0.018 + 0.015, c.z); deco.add(pied);
        const bougie = new THREE.Mesh(new THREE.CylinderGeometry(0.01, 0.011, hb, 24), cire); bougie.position.set(c.x + dx, y0 + 0.033 + hb / 2, c.z); deco.add(bougie);
        const f = new THREE.Mesh(new THREE.SphereGeometry(0.006, 12, 8).scale(1, 2.2, 1), flamme); f.position.set(c.x + dx, y0 + 0.033 + hb + 0.012, c.z); deco.add(f);
      }
      }
    }
    deco.traverse((o) => { o.updateMatrix(); o.matrixAutoUpdate = false; });
    scene.add(deco); deco.updateMatrixWorld(true);
    forceEmissifs(amb, amb, 0);
  }

  // Miroirs : un vrai reflet plan (la scène rendue une seconde fois depuis le point symétrique), seulement quand on peut voir le miroir.
  // Reconnu à sa matière (métal poli) et à sa forme (plaque verticale mince). Hors de vue, il garde le reflet d'environnement de la matière.
  const miroirs = [];
  const OMBRE_MIROIR = { name: "MiroirV3", uniforms: { color: { value: null }, tDiffuse: { value: null }, textureMatrix: { value: null } },
    vertexShader: "uniform mat4 textureMatrix;\nvarying vec4 vUv;\nvoid main() { vUv = textureMatrix * vec4( position, 1.0 ); gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 ); }",
    fragmentShader: "uniform vec3 color;\nuniform sampler2D tDiffuse;\nvarying vec4 vUv;\nvoid main() {\n\tgl_FragColor = vec4( texture2DProj( tDiffuse, vUv ).rgb * color, 1.0 );\n\t#include <tonemapping_fragment>\n\t#include <colorspace_fragment>\n}" };
  const tailleMiroir = () => { const k = (mobile ? 0.5 : 0.6) * renderer.getPixelRatio(); return [Math.min(1536, Math.round(innerWidth * k)), Math.min(1536, Math.round(innerHeight * k))]; };
  if (v3) racine.traverse((o) => {
    const m = o.material; if (!o.isMesh || !(extra(o, "reflet") === "miroir" || (m.metalness >= 0.9 && m.roughness <= 0.06))) return;
    o.geometry.computeBoundingBox(); const bb = o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld), t = bb.getSize(new THREE.Vector3()), c = bb.getCenter(new THREE.Vector3());
    const axe = t.x < t.z ? 0 : 2, ep = axe === 0 ? t.x : t.z, larg = axe === 0 ? t.z : t.x;
    if (ep > 0.04 || larg < 0.25 || t.y < 0.25) return;
    const n = new THREE.Vector3(axe === 0 ? 1 : 0, 0, axe === 2 ? 1 : 0);
    if (G.dist(c.x - n.x * 0.35, c.z - n.z * 0.35) > G.dist(c.x + n.x * 0.35, c.z + n.z * 0.35)) n.negate();      // la face utile regarde la pièce, pas le mur
    const [w, h] = tailleMiroir();
    const r = new Reflector(new THREE.PlaneGeometry(larg, t.y), { textureWidth: w, textureHeight: h, multisample: mobile ? 0 : 2, shader: OMBRE_MIROIR, color: m.color.clone().multiplyScalar(0.96) });
    r.material.uniforms.v3Contraste = uContraste; r.material.uniforms.v3Saturation = uSaturation;
    r.position.copy(c).addScaledVector(n, ep / 2 + 0.0015); r.lookAt(r.position.clone().add(n)); r.visible = false; r.updateMatrixWorld(true); r.matrixAutoUpdate = false; scene.add(r);
    // Le reflet est calculé AVANT l'image, pas pendant : un rendu imbriqué laisse au rendu principal les plans de coupe et l'état de la caméra du miroir,
    // et ce qui se dessine après le miroir (le sol de la salle d'eau vu du dégagement) se retrouve coupé.
    const calcul = r.onBeforeRender; r.onBeforeRender = () => {};
    miroirs.push({ r, n, c, piece: null, calcul });
  });
  // vue dégagée entre deux points : aucun obstacle haut (mur, placard) sur le segment
  function vueDegagee(ax, az, bx, bz) {
    for (const b of obst3) { if (b[4] < 1.9) continue; let t0 = 0, t1 = 1, ok = true;
      for (const [o, d, lo, hi] of [[ax, bx - ax, b[0], b[2]], [az, bz - az, b[1], b[3]]]) { if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let a = (lo - o) / d, c = (hi - o) / d; if (a > c) [a, c] = [c, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) { ok = false; break; } }
      if (ok) return false; }
    return true;
  }
  const champ = new THREE.Frustum(), champM = new THREE.Matrix4();
  function majMiroirs() {
    champ.setFromProjectionMatrix(champM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    for (const m of miroirs) {
      if (m.piece === null) m.piece = pieceA(m.c.x + m.n.x * 0.4, m.c.z + m.n.z * 0.4) || "";
      const devant = (pos.x - m.c.x) * m.n.x + (pos.z - m.c.z) * m.n.z;
      // le miroir ne se calcule (la scène rendue une seconde fois) que s'il est dans le champ : dos au miroir, ou en traversant l'entrée, il ne coûte rien
      m.r.visible = !etat.dessus && devant > 0.05 && champ.intersectsObject(m.r) && ((m.piece && m.piece === pieceId) || vueDegagee(pos.x, pos.z, m.c.x + m.n.x * 0.06, m.c.z + m.n.z * 0.06));
    }
  }

  // repère au sol : là où l'on irait en cliquant
  const repere = new THREE.Mesh(new THREE.RingGeometry(0.13, 0.17, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  const pastille = new THREE.Mesh(new THREE.CircleGeometry(0.13, 48).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, depthWrite: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  repere.add(pastille); repere.visible = false; repere.renderOrder = 5; scene.add(repere);

  // ---------------------------------------------------------------- état du visiteur
  let yaw = 0, pitch = TANGAGE, vy = 0, vp = 0;          // regard (radians, cap de boussole et tangage) et sa vitesse d'inertie
  let marche = null, viseLacet = null, visePitch = null; // marche en cours, regard visé à l'arrivée
  let pieceId = null, pointIci = -1, expo = 1, fondu = null, balade = null, vitClavier = [0, 0];
  const touches = new Set(), sansAnimation = matchMedia("(prefers-reduced-motion: reduce)").matches;      // mouvement réduit demandé : on se pose sans marcher
  // Regard d'un point de vue : vers (cx, cz) du moteur. Mais si ce regard bute à moins de 1,6 m sur un mur ou un meuble haut
  // (le point du dégagement regarde le flanc du placard), on prend la direction la plus dégagée : on arrive face à la pièce, pas face à une paroi.
  function portee(x, z, lacet) {
    const dx = Math.sin(lacet), dz = -Math.cos(lacet); let t = 12;
    for (const b of obst3) { if (b[4] < 1.5) continue; let t0 = 0, t1 = t, ok = true;
      for (const [o, d, lo, hi] of [[x, dx, b[0], b[2]], [z, dz, b[1], b[3]]]) { if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let a = (lo - o) / d, c = (hi - o) / d; if (a > c) [a, c] = [c, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) { ok = false; break; } }
      if (ok) t = t0; }
    return t;
  }
  const ouverture = (x, z, l) => (portee(x, z, l - 0.3) + 2 * portee(x, z, l) + portee(x, z, l + 0.3)) / 4;
  function regardVers(p) {
    const voulu = p.cx != null ? Math.atan2(p.cx - p.x, -(p.cz - p.z)) : rad(p.cap || 0); if (Math.min(portee(p.x, p.z, voulu), ouverture(p.x, p.z, voulu)) >= 1.0) return voulu;
    let mieux = voulu, note = -1;
    for (let k = 0; k < 48; k++) { const l = k * Math.PI / 24, n = ouverture(p.x, p.z, l) * (1 + 0.15 * Math.cos(tour(l - voulu))); if (n > note) { note = n; mieux = l; } }
    return mieux;
  }
  yaw = V.depart ? regardVers(V.depart) : regardVers(V.pieces[0]);

  const polys = (plan?.pieces || []);
  const dansPoly = (x, z, poly) => { let r = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [x0, z0] = poly[i], [x1, z1] = poly[j]; if ((z0 > z) !== (z1 > z) && x < (x1 - x0) * (z - z0) / (z1 - z0) + x0) r = !r; } return r; };
  const pointsDe = (id) => { const p = polys.find((q) => q.id === id); return p?.points?.length ? p.points : null; };
  function pieceA(x, z) { for (const p of polys) if (dansPoly(x, z, p.poly)) return p.id; return null; }
  function plusProchePoint(x, z, parmi) { let m = -1, dm = 1e9; (parmi || V.pieces.map((_, i) => i)).forEach((i) => { const k = Math.hypot(V.pieces[i].x - x, V.pieces[i].z - z); if (k < dm) { dm = k; m = i; } }); return m; }
  function expoCible() {
    const a = fondu ? fondu.vers : amb, e = sc?.expo?.[a], P = POSE * reglage(a).pose; if (!e) return P;
    if (etat.dessus) { const v = Object.values(e).filter((n) => typeof n === "number").map((n) => Math.min(n, PLAFOND_EXPO)); return P * (v.length ? v.reduce((x, y) => x + y, 0) / v.length : 1); }
    return P * Math.min(e[pieceId] ?? e.defaut ?? 1, PLAFOND_EXPO);
  }
  function majPiece(net = false) {
    const id = polys.length ? (pieceA(pos.x, pos.z) ?? pieceId) : null;
    const pt = plusProchePoint(pos.x, pos.z, id ? pointsDe(id) : null);
    if (id !== pieceId || net) { pieceId = id; surPiece(); }
    if (v3) { const a = fondu ? fondu.vers : amb, r = refletDe(pieceId, a), cle = r ? r[a] : "neutre|" + a; if (cle !== envVoulu) { envVoulu = cle; envDe(pieceId, a).then((e) => { if (envVoulu === cle) poserEnv(e); }); } }
    if (pt !== pointIci) { pointIci = pt; surPoint(); }
    if (net) { expo = expoCible(); }
  }
  let surPiece = () => {}, surPoint = () => {};

  // ---------------------------------------------------------------- boucle : une image seulement quand quelque chose bouge
  let enAttente = false, dernier = 0, bouge = 0;      // bouge : instant de la dernière image demandée, donc de la dernière activité
  function demander() { bouge = performance.now(); if (enAttente) return; enAttente = true; requestAnimationFrame(tic); }
  function tic(t) { enAttente = false; const suite = !!dernier, dt = dernier ? Math.min(0.1, (t - dernier) / 1000) : 1 / 60; dernier = t; if (suite) lenteur(dt); const actif = avancer(dt), mvt = !etat.dessus && (actif || !!(prise && prise.tire)); if (mvt) regler(true); dessiner(); if (actif) demander(); else { dernier = 0; affiner(); } }
  // 20 images de plus de 24 ms (moins de 42 images par seconde) pendant un mouvement continu : un quart de densité en moins, une fois pour toutes
  function lenteur(dt) {
    lentes = dt > 0.024 ? lentes + 1 : Math.max(0, lentes - 2);
    if (lentes < 20 || budget <= 0.8e6 || baisse) return;
    // encore lent malgré l'image allégée : on abaisse le budget du mouvement d'un quart, une fois le visiteur arrêté
    baisse = true; lentes = 0;
    calme(150).then(() => { baisse = false; budget = Math.max(0.8e6, budget * 0.75); etat.budget = Math.round(budget); });
  }
  function deplacer(dx, dz) {
    const n = Math.max(1, Math.ceil(Math.hypot(dx, dz) / 0.03)); dx /= n; dz /= n;
    for (let k = 0; k < n; k++) {
      const d0 = G.dist(pos.x, pos.z), ok = (x, z) => { const d = G.dist(x, z); return d >= RAYON || d > d0; };      // d'une position trop près d'un mur, on peut toujours s'en éloigner
      if (ok(pos.x + dx, pos.z + dz)) { pos.x += dx; pos.z += dz; } else if (ok(pos.x + dx, pos.z)) pos.x += dx; else if (ok(pos.x, pos.z + dz)) pos.z += dz; else break;
    }
  }
  function avancer(dt) {
    let actif = false;
    if (balade) { balade.t += dt; yaw += dt * 0.09; if (balade.t > 8) balade = null; else actif = true; }
    // clavier
    const av = (touches.has("KeyW") || touches.has("ArrowUp") ? 1 : 0) - (touches.has("KeyS") || touches.has("ArrowDown") ? 1 : 0);
    const lat = (touches.has("KeyD") ? 1 : 0) - (touches.has("KeyA") ? 1 : 0), rot = (touches.has("ArrowRight") ? 1 : 0) - (touches.has("ArrowLeft") ? 1 : 0);
    const vit = VITESSE_CLAVIER * (touches.has("ShiftLeft") || touches.has("ShiftRight") ? 1.7 : 1), n = Math.hypot(av, lat) || 1;
    const cx = (Math.sin(yaw) * av + Math.cos(yaw) * lat) / n * vit, cz = (-Math.cos(yaw) * av + Math.sin(yaw) * lat) / n * vit, k = 1 - Math.exp(-dt * 10);
    vitClavier[0] += (cx - vitClavier[0]) * k; vitClavier[1] += (cz - vitClavier[1]) * k;
    if (Math.hypot(vitClavier[0], vitClavier[1]) > 0.02) { deplacer(vitClavier[0] * dt, vitClavier[1] * dt); actif = true; } else vitClavier[0] = vitClavier[1] = 0;
    if (rot) { yaw += rot * dt * 1.7; actif = true; }
    // marche le long du chemin
    if (marche) {
      const m = marche, reste = m.L - m.s;
      let devant = yaw;
      if (!m.libre) {
        if (m.regard && reste < 1.25) devant = m.regard.lacet;
        else { const a = pointSur(m, Math.min(m.L, m.s + 0.9)), b = pointSur(m, m.s); if (Math.hypot(a[0] - b[0], a[1] - b[1]) > 0.05) devant = Math.atan2(a[0] - b[0], -(a[1] - b[1])); }
        yaw += tour(devant - yaw) * (1 - Math.exp(-dt * 4.2));
        if (m.regard) pitch += (m.regard.tangage - pitch) * (1 - Math.exp(-dt * 3));
      }
      // on ralentit quand on ne regarde pas où l'on va (demi-tour au départ) et avant l'arrivée
      const face = m.libre || (m.regard && reste < 1.25) ? 1 : borne(Math.cos(tour(devant - yaw)) * 1.3 - 0.1, 0.12, 1);
      const cible = Math.min(m.vmax * face, Math.sqrt(2 * 3.2 * Math.max(reste, 0)) + 0.15);
      m.v += borne(cible - m.v, -6 * dt, 4 * dt); m.s = Math.min(m.L, m.s + m.v * dt);
      const p = pointSur(m, m.s); pos.x = p[0]; pos.z = p[1];
      if (m.s >= m.L - 1e-4) { const fin = m; marche = null; if (fin.regard && !fin.libre) { viseLacet = fin.regard.lacet; visePitch = fin.regard.tangage; } repere.visible = false; fin.fin(true); }
      actif = true;
    }
    // fin de rotation vers le regard de la pièce
    if (viseLacet != null) {
      const e = tour(viseLacet - yaw), k2 = 1 - Math.exp(-dt * 5); yaw += e * k2; if (visePitch != null) pitch += (visePitch - pitch) * k2;
      if (Math.abs(e) < 0.004 && (visePitch == null || Math.abs(visePitch - pitch) < 0.004)) { viseLacet = visePitch = null; } else actif = true;
    }
    // inertie du regard
    if (!prise && (Math.abs(vy) > 0.02 || Math.abs(vp) > 0.02)) { yaw += vy * dt; pitch = borne(pitch + vp * dt, -1.2, 1.2); const f = Math.exp(-dt * 5); vy *= f; vp *= f; actif = true; }
    // fondu entre deux ambiances
    if (fondu) {
      fondu.t = Math.min(1, fondu.t + dt / fondu.duree); const u = fondu.t * fondu.t * (3 - 2 * fondu.t);
      uMelange.value = u; forceEmissifs(fondu.de, fondu.vers, u);
      if (fondu.t >= 1) finFondu(); else actif = true;
    }
    majPiece();
    // l'œil s'adapte à la pièce
    const ec = expoCible(); if (Math.abs(ec - expo) > 0.003) { expo += (ec - expo) * (1 - Math.exp(-dt * 3.2)); actif = true; } else expo = ec;
    return actif;
  }
  function pointSur(m, s) {
    let i = m.i; while (i < m.cum.length - 2 && m.cum[i + 1] < s) i++; while (i > 0 && m.cum[i] > s) i--; if (s >= m.s) m.i = i;
    const a = m.pts[i], b = m.pts[i + 1], L = m.cum[i + 1] - m.cum[i], t = L > 1e-9 ? borne((s - m.cum[i]) / L, 0, 1) : 0;
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function dessiner() {
    pitch = borne(pitch, -1.2, 1.2);
    camera.position.set(pos.x, OEIL, pos.z); camera.rotation.set(pitch, -yaw, 0); camera.updateMatrixWorld();
    renderer.toneMappingExposure = expo; uPose.value = expo;
    const cam = etat.dessus ? dessusCam : camera;
    if (miroirs.length) { majMiroirs(); for (const m of miroirs) if (m.r.visible) m.calcul.call(m.r, renderer, scene, camera); }
    if (ciel.visible) { ciel.position.copy(camera.position); ciel.updateMatrix(); ciel.updateMatrixWorld(); }
    renderer.render(scene, cam);
    etat.x = +pos.x.toFixed(3); etat.z = +pos.z.toFixed(3); etat.lacet = +((deg(yaw) % 360 + 360) % 360).toFixed(1); etat.tangage = +deg(pitch).toFixed(1);
    etat.piece = pointIci; etat.pieceId = pieceId; etat.marche = !!marche; etat.expo = +expo.toFixed(3); etat.ambiance = amb;
    etat.appels = renderer.info.render.calls;
    majMoi();
  }
  let majMoi = () => {};

  // ---------------------------------------------------------------- déplacements
  function arreter(resultat = false) { if (marche) { const m = marche; marche = null; m.fin(resultat); } viseLacet = visePitch = null; repere.visible = false; }
  function marcher(x, z, regard = null) {
    arreter(); balade = null; vy = vp = 0;
    const pts = sansAnimation ? null : G.chemin(pos.x, pos.z, x, z);
    return new Promise((fin) => {
      if (!pts || pts.length < 2) {      // déjà sur place, ou aucun chemin : on se pose et on se tourne
        if (!pts) { pos.x = x; pos.z = z; }
        if (regard && sansAnimation) { yaw = regard.lacet; pitch = regard.tangage; } else if (regard) { viseLacet = regard.lacet; visePitch = regard.tangage; }
        majPiece(); demander(); fin(!!pts); return;
      }
      const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
      const L = cum[cum.length - 1];
      marche = { pts, cum, L, s: 0, v: 0, i: 0, vmax: Math.max(VITESSE, L / 4.2), regard, libre: false, fin };
      const d = pts[pts.length - 1]; repere.position.set(d[0], 0.012, d[1]); repere.updateMatrix(); repere.updateMatrixWorld(true); repere.visible = !etat.dessus;
      demander();
    });
  }
  function aller(i, { immediat = false } = {}) {
    const p = V.pieces[+i]; if (!p) return Promise.resolve(false);
    // équipement visé proche et bas (vasque, cuvette dans une petite pièce d'eau) : le regard plonge vers lui, jusqu'à -25° ; sinon -4°.
    // cy vient du moteur depuis le 16/11 (essai C401 : vasque à 0,9 m sous le bas de l'image) ; une visite sans cy (le T2) ne change pas.
    const dCible = p.cx != null ? Math.hypot(p.cx - p.x, p.cz - p.z) : Infinity;
    const tangage = (Number.isFinite(p.cy) && dCible < 1.4) ? Math.max(rad(-25), Math.min(TANGAGE, Math.atan2(p.cy - OEIL, dCible))) : TANGAGE;
    const regard = { lacet: regardVers(p), tangage }; balade = null;
    if (immediat) { arreter(); vy = vp = 0; pos.x = p.x; pos.z = p.z; yaw = regard.lacet; pitch = regard.tangage; majPiece(true); return envDe(pieceId, amb).then((e) => { poserEnv(e); dessiner(); return true; }); }
    return marcher(p.x, p.z, regard);
  }
  // où mène un clic : le sol visé, ou le pied du meuble ou du mur visé. Calcul sur les boîtes d'obstacles, sans lancer de rayon dans la scène.
  const rayon = new THREE.Vector3();
  function viser(cx, cy) {
    if (etat.dessus) return null;
    rayon.set(cx / innerWidth * 2 - 1, -(cy / innerHeight) * 2 + 1, 0.5).unproject(camera).sub(camera.position).normalize();
    const ox = pos.x, oy = OEIL, oz = pos.z, dx = rayon.x, dy = rayon.y, dz = rayon.z;
    let tSol = dy < -0.02 ? -oy / dy : Infinity, tBoite = Infinity;
    for (const b of obst3) {
      let t0 = 0, t1 = Math.min(tSol, 40), ok = true;
      for (const [o, d, lo, hi] of [[ox, dx, b[0], b[2]], [oy, dy, 0, b[4]], [oz, dz, b[1], b[3]]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { ok = false; break; } continue; }
        let a = (lo - o) / d, c = (hi - o) / d; if (a > c) [a, c] = [c, a]; t0 = Math.max(t0, a); t1 = Math.min(t1, c); if (t0 > t1) { ok = false; break; }
      }
      if (ok && t0 < tBoite) tBoite = t0;
    }
    let t = Math.min(tSol, tBoite); if (!isFinite(t) || t > 25) return null;
    const surSol = tSol <= tBoite, h = Math.hypot(dx, dz) || 1;
    if (!surSol) t = Math.max(0, t - 0.35 / h);      // devant un mur ou un meuble : on s'arrête un pas avant, du côté d'où l'on regarde
    const x = ox + dx * t, z = oz + dz * t, c = G.proche(x, z, surSol ? 0.7 : 0.9);
    if (c < 0) return null;
    const p = (G.case(x, z) === c) ? [x, z] : G.centre(c);
    return { x: p[0], z: p[1] };
  }

  // ---------------------------------------------------------------- souris, doigt, clavier
  let prise = null; const doigts = new Map(); let ecart = 0, survolPrevu = null;
  const parPixel = () => rad(camera.fov) / canvas.clientHeight;
  function finAide() { if (aide.fini) return; aide.fini = true; aideEl.classList.add("parti"); }
  canvas.addEventListener("pointerdown", (e) => {
    canvas.setPointerCapture(e.pointerId); doigts.set(e.pointerId, e); balade = null; finAide();
    prise = { x: e.clientX, y: e.clientY, x0: e.clientX, y0: e.clientY, t0: performance.now(), t: performance.now(), tire: false, type: e.pointerType }; vy = vp = 0;
    if (doigts.size === 2) { const [a, b] = [...doigts.values()]; ecart = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); prise.tire = true; }
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!doigts.has(e.pointerId)) {      // survol à la souris : on montre où l'on irait
      if (e.pointerType === "mouse" && !marche) { survolPrevu = [e.clientX, e.clientY]; demanderSurvol(); }
      return;
    }
    doigts.set(e.pointerId, e);
    if (doigts.size === 2) { const [a, b] = [...doigts.values()], d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY); if (ecart) { zoom = borne(zoom * ecart / d, 0.55, 1); cadrer(); demander(); } ecart = d; return; }
    if (!prise) return;
    const dx = e.clientX - prise.x, dy = e.clientY - prise.y, t = performance.now(), dt = Math.max(1, t - prise.t) / 1000;
    if (!prise.tire && Math.hypot(e.clientX - prise.x0, e.clientY - prise.y0) < 6) return;
    if (!prise.tire) { prise.tire = true; canvas.classList.add("tire"); repere.visible = !!marche; if (marche) marche.libre = true; viseLacet = visePitch = null; }
    prise.x = e.clientX; prise.y = e.clientY; prise.t = t;
    const k = parPixel(), dyaw = -dx * k, dpitch = dy * k;
    yaw += dyaw; pitch = borne(pitch + dpitch, -1.2, 1.2);
    vy = vy * 0.5 + (dyaw / dt) * 0.5; vp = vp * 0.5 + (dpitch / dt) * 0.5;
    demander();
  });
  const lacher = (e) => {
    if (!doigts.has(e.pointerId)) return; doigts.delete(e.pointerId); if (doigts.size) return;
    const p = prise; prise = null; ecart = 0; canvas.classList.remove("tire"); if (!p) return;
    if (!p.tire && e.type === "pointerup" && performance.now() - p.t0 < 600) { const c = viser(e.clientX, e.clientY); if (c) marcher(c.x, c.z); return; }
    if (performance.now() - p.t > 90) vy = vp = 0;      // doigt posé avant d'être levé : pas d'élan
    vy = borne(vy, -6, 6); vp = borne(vp, -6, 6); demander();
  };
  canvas.addEventListener("pointerup", lacher); canvas.addEventListener("pointercancel", lacher);
  canvas.addEventListener("pointerleave", () => { if (!marche && repere.visible) { repere.visible = false; canvas.classList.remove("sol"); demander(); } });
  let survolDemande = false;
  function demanderSurvol() { if (survolDemande) return; survolDemande = true; requestAnimationFrame(() => { survolDemande = false; if (!survolPrevu || prise || marche) return;
    const c = viser(survolPrevu[0], survolPrevu[1]); canvas.classList.toggle("sol", !!c);
    if (c) { repere.position.set(c.x, 0.012, c.z); repere.updateMatrix(); repere.updateMatrixWorld(true); } repere.visible = !!c; demander(); }); }
  canvas.addEventListener("wheel", (e) => { e.preventDefault(); balade = null; finAide(); zoom = borne(zoom + e.deltaY * 0.0006, 0.55, 1); cadrer(); demander(); }, { passive: false });
  const CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "ShiftLeft", "ShiftRight"]);
  addEventListener("keydown", (e) => { if (!CODES.has(e.code) || e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName)) return;
    if (!e.code.startsWith("Shift")) { e.preventDefault(); if (marche) arreter(); balade = null; finAide(); repere.visible = false; } touches.add(e.code); demander(); });
  addEventListener("keyup", (e) => { touches.delete(e.code); });
  addEventListener("blur", () => touches.clear());
  addEventListener("resize", () => { cadrer(); for (const m of miroirs) m.r.getRenderTarget().setSize(...tailleMiroir()); demander(); });
  canvas.addEventListener("webglcontextlost", (e) => { e.preventDefault(); });
  canvas.addEventListener("webglcontextrestored", () => demander());
  document.addEventListener("visibilitychange", () => { if (!document.hidden) demander(); });

  // ---------------------------------------------------------------- ambiances
  async function changerAmbiance(nom, { immediat = false } = {}) {
    if (!ambiances.includes(nom) || nom === amb && !fondu) return etat.ambiance;
    if (fondu) finFondu();
    if (nom === amb) return amb;
    const mats = [...cartesB.entries()];
    const [env] = await Promise.all([envDe(pieceId, nom), ...[...new Set(mats.map(([, c]) => c.atlas))].map((a) => carte(a, nom))]);
    // chaque carte part vers la carte graphique dans sa propre image, avant le fondu : trois cartes de 4096 en une fois figeaient 0,4 s
    for (const a of new Set(mats.map(([, c]) => c.atlas))) { const t = await carte(a, nom); if (!envoyees.has(t)) { envoyees.add(t); renderer.initTexture(t); await suivante(); } }
    for (const [, c] of mats) c.u.value = await carte(c.atlas, nom);
    uForceB.value = echelle(nom);
    fondu = { de: amb, vers: nom, t: 0, duree: immediat ? 1e-6 : 0.9, env };
    envVoulu = env.cle; poserEnv(env); surAmbiance(nom);
    return new Promise((ok) => { fondu.ok = ok; if (immediat) { avancer(0.001); dessiner(); } else demander(); });
  }
  function finFondu() {
    const f = fondu; fondu = null; amb = f.vers; uMelange.value = 0;
    for (const [m, c] of cartesB) { m.lightMap = c.u.value; m.lightMapIntensity = uForceB.value; }
    forceEmissifs(amb, amb, 0); etat.ambiance = amb; surAmbiance(amb); calme(500).then(() => $("plan")?.v3vue?.());      // le mini-plan se refait quand plus rien ne bouge
    if (mobile) for (const [cle, p] of cartes) if (!cle.endsWith("|" + amb)) { cartes.delete(cle); p.then((t) => t.dispose()); }      // téléphone : une seule série de cartes en mémoire
    f.ok?.(amb);
  }
  let surAmbiance = () => {};

  // Image du mini-plan : un rendu orthographique vertical cadré exactement sur `limites`, pris dans la toile le temps d'une image (rien ne s'affiche entre-temps).
  function imageDessus() {
    const W = limites[2] - limites[0], D = limites[3] - limites[1], w = 1024, h = Math.round(w * D / W), pr = renderer.getPixelRatio(), avant = etat.dessus;
    clearTimeout(affinage); renderer.setPixelRatio(1); renderer.setSize(w, h, false);
    dessusCam.left = -W / 2; dessusCam.right = W / 2; dessusCam.top = D / 2; dessusCam.bottom = -D / 2; dessusCam.updateProjectionMatrix();
    dessusCam.position.set((limites[0] + limites[2]) / 2, 60, (limites[1] + limites[3]) / 2); dessusCam.up.set(0, 0, -1); dessusCam.lookAt(dessusCam.position.x, 0, dessusCam.position.z); dessusCam.updateMatrixWorld();
    etat.dessus = { plan: true }; const e = expoCible(); renderer.toneMappingExposure = e; uPose.value = e;
    renderer.clippingPlanes = [COUPE_BAS, new THREE.Plane(new THREE.Vector3(0, -1, 0), H - 0.03)]; renderer.setClearColor(nuitee(amb) ? 0x1b1d24 : 0xefece6, 1);
    const cv0 = ciel.visible, rv = repere.visible; ciel.visible = false; repere.visible = false; for (const m of miroirs) m.r.visible = false;
    renderer.render(scene, dessusCam);
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h; cv.getContext("2d").drawImage(renderer.domElement, 0, 0);
    etat.dessus = avant; ciel.visible = cv0; repere.visible = rv; renderer.setPixelRatio(dpr); densite = dpr;
    if (avant) vueDessus(true); else { renderer.clippingPlanes = [COUPE_BAS]; renderer.setClearColor(0x0c0a08, 1); cadrer(); dessiner(); }
    return cv;
  }
  // attend que plus rien ne bouge (ni marche, ni regard tenu, ni fondu, ni touche) : les travaux de fond ne tombent jamais pendant un déplacement
  const calme = (ms = 300) => new Promise((ok) => { const f = () => (performance.now() - bouge >= ms && !marche && !prise && !fondu && !touches.size ? ok() : setTimeout(f, 100)); f(); });

  // ---------------------------------------------------------------- vue de dessus (outil : comparer au plan)
  function vueDessus(oui) {
    if (oui) { cadrerDessus(); renderer.clippingPlanes = [COUPE_BAS, new THREE.Plane(new THREE.Vector3(0, -1, 0), H - 0.03)]; ciel.visible = false; repere.visible = false; renderer.setClearColor(0xefece6, 1); }
    else { etat.dessus = null; renderer.clippingPlanes = [COUPE_BAS]; ciel.visible = true; renderer.setClearColor(0x0c0a08, 1); }
    regler(false, true); expo = expoCible(); dessiner(); return etat.dessus;
  }

  // ---------------------------------------------------------------- interface
  const titreS = $("titre-s"), barre = $("pieces"), aideEl = $("aide"), aide = { fini: false };
  V.pieces.forEach((p, i) => { const b = document.createElement("button"); b.className = "verre"; b.textContent = p.nom; b.dataset.i = i; b.onclick = () => { finAide(); aller(i); b.blur(); }; barre.append(b); });
  surPoint = () => {
    for (const b of barre.children) b.classList.toggle("ici", +b.dataset.i === pointIci);
    const p = V.pieces[pointIci]; if (titreS) titreS.textContent = [V.sousTitre, p?.nom].filter(Boolean).join(" · ");
    if (!sansUi) barre.children[pointIci]?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    if (etat.pret && pointIci >= 0) history.replaceState(null, "", "#" + pointIci);
    planEl?.v3legende?.();
  };
  const ICONES = { jour: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.4M12 19.1v2.4M2.5 12h2.4M19.1 12h2.4M5.3 5.3l1.7 1.7M17 17l1.7 1.7M18.7 5.3 17 7M7 17l-1.7 1.7"/></svg>',
    nuit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.2A8.3 8.3 0 0 1 9.8 4a8.3 8.3 0 1 0 10.2 10.2z"/></svg>' };
  const boiteAmb = $("ambiances");
  if (ambiances.length > 1) for (const a of ambiances) {
    const b = document.createElement("button"); b.className = "verre"; b.dataset.a = a; b.innerHTML = (ICONES[a] || "") + "<span></span>"; b.lastChild.textContent = T.amb[a] || a.charAt(0).toUpperCase() + a.slice(1);
    b.onclick = async () => { b.blur(); finAide(); if (a === amb || b.classList.contains("charge")) return; b.classList.add("charge"); try { await changerAmbiance(a); } catch (e) { etat.erreurs.push(String(e.message || e)); } b.classList.remove("charge"); };
    boiteAmb.append(b);
  }
  surAmbiance = (a = amb) => { for (const b of boiteAmb.children) b.classList.toggle("ici", b.dataset.a === a); };
  surAmbiance();

  // mini-plan : tracé depuis plan.json, donc aux cotes exactes du modèle
  const planEl = $("plan");
  if (plan && planEl && plan.pieces?.length) {
    const L = plan.limites || limites, W = L[2] - L[0], D = L[3] - L[1], f = (n) => +n.toFixed(3), pts = (poly) => poly.map((p) => f(p[0]) + "," + f(p[1])).join(" ");
    const ech = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const surf = (p) => (p.surface ? `${nombre(p.surface)} m²` : "");
    let s = `<svg viewBox="${f(L[0])} ${f(L[1])} ${f(W)} ${f(D)}" role="img" aria-label="${T.plan}">`;
    // fond : la scène elle-même vue du dessus (plafonds masqués), posée sur la même projection que les pièces, les points et le cône
    s += `<image class="vue" x="${f(L[0])}" y="${f(L[1])}" width="${f(W)}" height="${f(D)}" preserveAspectRatio="none"/>`;
    for (const p of plan.pieces) s += `<polygon class="piece${p.exterieur ? " ext" : ""}" data-id="${ech(p.id)}" points="${pts(p.poly)}"><title>${ech(p.nom)}${p.surface ? " · " + surf(p) : ""}</title></polygon>`;
    for (const p of plan.pieces) { const t = borne(Math.sqrt(p.surface || 6) * 0.085, 0.2, 0.34);
      s += `<text class="etiq" x="${f(p.centre[0])}" y="${f(p.centre[1])}" font-size="${f(t)}"><tspan class="n" x="${f(p.centre[0])}" dy="${f(-t * 0.12)}">${ech(p.nom)}</tspan>${p.surface ? `<tspan class="s" x="${f(p.centre[0])}" dy="${f(t * 1.08)}" font-size="${f(t * 0.8)}">${surf(p)}</tspan>` : ""}</text>`; }
    V.pieces.forEach((p, i) => { s += `<circle class="pt" data-i="${i}" cx="${f(p.x)}" cy="${f(p.z)}" r="0.09"/>`; });
    s += `</svg><div class="moi-html"><div class="rogne"><div class="cone"></div></div><div class="rond"></div></div>`;
    planEl.innerHTML = `<div class="fond">${s}</div><div class="legende"><b></b><span></span></div><button class="taille" type="button"><svg class="ouvrir" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg><svg class="fermer" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 10h-6V4M4 14h6v6M14 10l7-7M10 14l-7 7"/></svg></button>`;
    planEl.hidden = false;
    const svg = planEl.querySelector("svg"), cone = planEl.querySelector(".moi-html .cone"), rond = planEl.querySelector(".moi-html .rond"), rogne = planEl.querySelector(".moi-html .rogne"), leg = planEl.querySelector(".legende"), bt = planEl.querySelector(".taille");
    const zones = [...svg.querySelectorAll(".piece")], ptsEl = [...svg.querySelectorAll(".pt")];
    let survol = null, typePointeur = "mouse";
    const legende = () => { const p = plan.pieces.find((q) => q.id === (survol || pieceId)); // une pièce à plusieurs points (séjour cuisine) affiche le nom du point où l'on se tient : Salon et Cuisine n'ont pas le même cartouche
      const ici = !survol && p?.points?.length > 1 && V.pieces[pointIci]?.piece === p.id ? V.pieces[pointIci].nom : null;
      leg.firstChild.textContent = ici || p?.nom || ""; leg.lastChild.textContent = p ? surf(p) : ""; };
    let kpx = 1;      // pixels d'écran par mètre de plan
    const tailles = () => { const lw = svg.clientWidth || 236, k = W / lw; kpx = lw / W; for (const c of ptsEl) c.setAttribute("r", f(Math.max(0.05, 2.6 * k)));
      const Rp = 1.9 * kpx; cone.style.width = cone.style.height = (2 * Rp).toFixed(1) + "px"; cone.style.margin = (-Rp).toFixed(1) + "px"; dernierMoi = ""; majMoi(); };
    let dernierMoi = "", dernierDh = "";
    const grand = (oui) => { planEl.classList.toggle("grand", oui); bt.setAttribute("aria-label", oui ? T.reduire : T.agrandir); bt.title = oui ? T.reduire : T.agrandir; };
    grand(false); new ResizeObserver(tailles).observe(svg); tailles();
    planEl.addEventListener("pointerdown", (e) => { typePointeur = e.pointerType || "mouse"; }, true);
    bt.onclick = (e) => { e.stopPropagation(); grand(!planEl.classList.contains("grand")); };
    for (const z of zones) {
      z.addEventListener("pointerenter", (e) => { if (e.pointerType !== "mouse") return; survol = z.dataset.id; z.classList.add("survol"); legende(); });
      z.addEventListener("pointerleave", () => { survol = null; z.classList.remove("survol"); legende(); });
    }
    planEl.addEventListener("click", (e) => {
      finAide();
      if (typePointeur !== "mouse" && !planEl.classList.contains("grand")) { grand(true); return; }      // au doigt, le petit plan s'agrandit d'abord
      const z = e.target.closest?.(".piece");
      if (!z) { if (typePointeur !== "mouse") grand(false); return; }
      // point de vue de cette pièce le plus proche de l'endroit touché
      const m = svg.getScreenCTM().inverse(), q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m), dispo = pointsDe(z.dataset.id);
      if (dispo) aller(plusProchePoint(q.x, q.y, dispo)); else { const c = G.proche(q.x, q.y, 1.2); if (c >= 0) { const p = G.centre(c); marcher(p[0], p[1]); } }
      if (typePointeur !== "mouse") grand(false);
    });
    surPiece = () => { for (const z of zones) z.classList.toggle("ici", z.dataset.id === pieceId); legende();
      const p = plan.pieces.find((q) => q.id === pieceId); if (p) rogne.style.clipPath = "polygon(" + p.poly.map((q) => ((q[0] - L[0]) / W * 100).toFixed(2) + "% " + ((q[1] - L[1]) / D * 100).toFixed(2) + "%").join(",") + ")"; };      // le cône s'arrête aux murs de la pièce, il ne passe ni dans la voisine ni hors du cadre
    planEl.v3legende = legende;
    const vue = svg.querySelector(".vue");
    let urlVue = null; planEl.v3vue = () => { try { imageDessus().toBlob((b) => { if (!b) return; const u = URL.createObjectURL(b); vue.setAttribute("href", u); if (urlVue) URL.revokeObjectURL(urlVue); urlVue = u; }, "image/jpeg", 0.86); } catch (e) { etat.erreurs.push("plan : " + (e.message || e)); } };      // encodage hors du fil principal
    majMoi = () => {
      const dh = Math.atan(Math.tan(rad(camera.fov) / 2) * camera.aspect), cle = `${pos.x.toFixed(3)} ${pos.z.toFixed(3)} ${yaw.toFixed(3)}`, cd = dh.toFixed(3);
      if (cd !== dernierDh) { dernierDh = cd; const m = `conic-gradient(from ${(-dh).toFixed(3)}rad, #000 0 ${(2 * dh).toFixed(3)}rad, transparent 0)`; cone.style.webkitMaskImage = m; cone.style.maskImage = m; }
      if (cle === dernierMoi) return; dernierMoi = cle;
      const t = `translate(${((pos.x - L[0]) * kpx).toFixed(1)}px, ${((pos.z - L[1]) * kpx).toFixed(1)}px)`;      // 0° = nord = haut du plan, sens des aiguilles d'une montre
      rond.style.transform = t; cone.style.transform = t + ` rotate(${deg(yaw).toFixed(1)}deg)`;
    };
  }
  if (aideEl) aideEl.textContent = mobile ? T.aideDoigt : T.aideSouris;

  // ---------------------------------------------------------------- premier rendu
  majBarre(T.prepare);
  // les reflets de toutes les pièces de l'ambiance ouverte se préparent ici, derrière le chargement (environ 0,1 s chacun) : aucun à faire en marchant
  if (v3) for (const r of sc.reflets || []) if (r[amb]) { try { await envR(r, amb); } catch (e) { /* reflet neutre */ } majBarre(T.prepare); }
  cadrer();
  const iDepart = Q.has("piece") ? +Q.get("piece") : (/^#\d+$/.test(location.hash) ? +location.hash.slice(1) : -1);
  if (V.pieces[iDepart]) { const p = V.pieces[iDepart]; pos.x = p.x; pos.z = p.z; yaw = regardVers(p); }
  if (Q.has("lacet")) yaw = rad(+Q.get("lacet") || 0);
  if (Q.has("tangage")) pitch = rad(+Q.get("tangage") || 0);
  majPiece(true);
  poserEnv(await (v3 ? envDe(pieceId, amb) : envNeutre("jour")));
  if (Q.get("dessus") === "1") vueDessus(true);
  try { await renderer.compileAsync(scene, camera); } catch (e) { /* la compilation se fera au premier rendu */ }
  // Rien ne doit se préparer pendant la visite : tout ce qui se faisait au premier regard se fait ici, derrière le chargement.
  //  1. le miroir rend la scène dans une image intermédiaire, ce qui demande une seconde version de chaque nuanceur (sans courbe de ton) :
  //     elles se compilaient une à une en entrant dans la salle de bain (blocages de 120 à 150 ms mesurés). On les compile maintenant.
  if (miroirs.length) { const cible = miroirs[0].r.getRenderTarget(); renderer.setRenderTarget(cible); try { await renderer.compileAsync(scene, camera); } catch (e) { /* idem */ } renderer.setRenderTarget(null); }
  //  2. chaque texture partait vers la carte graphique la première fois que son objet entrait dans le champ : on les envoie toutes ici, quatre par image.
  { const vues = new Set(); let n = 0; scene.traverse((o) => { for (const m of (Array.isArray(o.material) ? o.material : [o.material])) if (m) for (const k of ["map", "normalMap", "roughnessMap", "metalnessMap", "emissiveMap", "aoMap", "alphaMap", "lightMap"]) { const t = m[k]; if (t && t.isTexture && t.image) vues.add(t); } });
    for (const t of vues) { if (envoyees.has(t)) continue; envoyees.add(t); try { renderer.initTexture(t); } catch (e) { /* elle partira au premier rendu */ } if (++n % 4 === 0) { majBarre(T.prepare); await suivante(); } } etat.textures = vues.size; }
  dessiner();
  planEl?.v3vue?.();
  suivi.actif = false; etat.pret = true; chargeEl?.classList.add("fini");
  setTimeout(() => chargeEl?.remove(), 1000);      // sinon il reste posé sur la 3D, invisible mais flouté, et le navigateur le recompose à chaque image
  surPoint(); surPiece();
  if (!sansUi && !Q.has("piece") && !Q.has("lacet") && !sansAnimation) { balade = { t: 0 }; demander(); }
  setTimeout(finAide, 9000);
  // les reflets des autres pièces arrivent ensuite, sans bloquer l'ouverture
  // Travaux de fond (hors téléphone, question de mémoire) : toute la seconde ambiance, cartes puis reflets, un élément à la fois et seulement
  // après 1,2 s sans aucun mouvement : le passage jour / nuit ne charge alors plus rien, et rien ne tombe pendant un déplacement.
  if (v3 && Q.get("fond") !== "0") (async () => {      // ?fond=0 : pas de travaux de fond (mesures)
    const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));
    try {
      if (mobile) return;
      for (const autre of ambiances) { if (autre === amb) continue;
        for (const atlas of Object.keys(sc.cartes)) { await calme(1200); const t = await carte(atlas, autre); if (!envoyees.has(t)) { envoyees.add(t); renderer.initTexture(t); } await pause(150); }
        for (const r of sc.reflets || []) if (r[autre]) { await calme(1200); await envR(r, autre); } }
    } catch (e) { etat.erreurs.push("fond : " + (e.message || e)); }
  })();

  Object.assign(api, {
    aller, ambiance: changerAmbiance, vueDessus,
    // mouvement = true : l'image est calculée à la densité allégée du mouvement, comme pendant une rotation réelle (mesure de fluidité de capturer3.py)
    regarder(lacetDeg, tangageDeg, mouvement = false) { balade = null; vy = vp = 0; viseLacet = visePitch = null; if (marche) marche.libre = true; if (lacetDeg != null) yaw = rad(lacetDeg); if (tangageDeg != null) pitch = rad(tangageDeg); regler(!!mouvement); dessiner(); return etat; },
    rendre(mvt = false) { regler(mvt); dessiner(); return etat; },
    // outil : le cap le plus dégagé autour d'un cap voulu (pour ne pas capturer un mur à 20 cm)
    regardOuvert(lacetDeg) { const l = rad(lacetDeg); if (Math.min(portee(pos.x, pos.z, l), ouverture(pos.x, pos.z, l)) >= 1.6) return lacetDeg; let m = l, note = -1;
      for (let k = -6; k <= 6; k++) { const c = l + k * Math.PI / 12, n = ouverture(pos.x, pos.z, c) * (1 + 0.15 * Math.cos(c - l)); if (n > note) { note = n; m = c; } } return +((deg(m) % 360 + 360) % 360).toFixed(1); },
    marcher: (x, z) => marcher(x, z),
    placer(x, z) { arreter(); balade = null; vy = vp = 0; pos.x = x; pos.z = z; majPiece(true); return envDe(pieceId, amb).then((e) => { poserEnv(e); dessiner(); return etat; }); },      // outil : se poser n'importe où, sans collision
    viser: (x, y) => viser(x, y),
    chemin(a, b) { const A = typeof a === "number" ? V.pieces[a] : a, B = typeof b === "number" ? V.pieces[b] : b; return G.chemin(A.x, A.z, B.x, B.z); },
    libre: (x, z) => G.libre(x, z),
    interne: { THREE, renderer, scene, camera, ciel, grille: G, visite: V, scene3: sc, plan, spot: uSpot, exterieurs },
  });
  finPret(etat);
}

demarrer().catch((e) => {
  etat.erreurs.push(String(e?.message || e));
  if (etat.mode !== "sans-webgl") { etat.mode = "echec"; suivi.actif = false; chargeEl?.classList.add("repli"); if (etatEl) etatEl.textContent = T.echec; }
  echecPret(e);
});
