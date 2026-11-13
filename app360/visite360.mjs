// Visite 360° de point en point : une image calculée par point (visite360.json écrit par moteur/construire.py --pano).
// On regarde autour de soi en glissant, on avance en touchant un rond au sol ou un bouton de pièce. Le regard est conservé d'un point à l'autre.
const { Pano } = await import("./pano.js" + new URL(import.meta.url).search);      // même numéro de version que la page : un afficheur corrigé n'est pas servi depuis le cache
const $ = (id) => document.getElementById(id);
const rad = (d) => d * Math.PI / 180;
const v = await (await fetch("visite360.json", { cache: "no-cache" })).json();
const en = v.langue === "en";
const pts = new Map(v.points.map((p) => [p.id, p]));
const pano = new Pano($("c")); window.__pano = pano;      // exposé pour mesurer la fluidité (dessin forcé + readPixels)
const barre = $("pieces"), reperes = $("reperes"), aide = $("aide");
let ici = null, occupe = false, aideFinie = false;
// Ambiances de lumière (jour, matin, nuit, pluie) : une série d'images par ambiance, dans son dossier. On change d'ambiance sans changer de place ni de regard.
const ambs = v.ambiances || [];
let amb = ambs.find((a) => a.id === new URL(location.href).searchParams.get("ambiance")) || ambs[0] || { id: "jour", dossier: "" };
const img = (p) => (amb.dossier || "") + p.image;
if (ambs.length > 1) {
  const bx = document.createElement("div"); bx.id = "ambiances";
  for (const a of ambs) {
    const b = document.createElement("button"); b.className = "verre"; b.textContent = a.nom; b.dataset.id = a.id; b.classList.toggle("ici", a.id === amb.id);
    b.onclick = async () => {
      b.blur(); if (occupe || !ici || a.id === amb.id) return;
      occupe = true; b.classList.add("charge"); const avant = amb; amb = a;
      try { await Pano.image(img(ici)); await pano.charger(img(ici), 650, 0);
        for (const o of bx.children) o.classList.toggle("ici", o.dataset.id === a.id);
        for (const l of ici.liens) { const n = pts.get(l); if (n) Pano.image(img(n)).catch(() => {}); }
      } catch (e) { amb = avant; }
      b.classList.remove("charge"); occupe = false;
    };
    bx.append(b);
  }
  document.body.append(bx);
}
if (v.credit) { const c = document.createElement("div"); c.id = "credit"; c.textContent = v.credit; document.body.append(c); }

for (const p of v.points) {
  const b = document.createElement("button"); b.className = "verre"; b.textContent = p.nom; b.dataset.id = p.id;
  b.onclick = () => { aller(p.id); b.blur(); }; barre.append(b);
}
function placer() {
  if (!ici) return;
  for (const el of reperes.children) {
    const q = el.q, dx = q.x - ici.x, dz = q.z - ici.z, d = Math.hypot(dx, dz);
    const s = pano.projeter(Math.atan2(dx, -dz) - rad(ici.cap), -Math.atan2(v.hauteurOeil || 1.6, Math.max(d, 0.7)));
    el.style.display = s.devant ? "" : "none"; el.style.transform = `translate(${s.x.toFixed(1)}px, ${s.y.toFixed(1)}px)`;
  }
}
// Plan en haut à droite, comme dans les visites de promoteur : où l'on est, vers où l'on regarde, et un point à toucher par pièce.
let plan = null;
if (v.plan) {
  const P = v.plan, bx = document.createElement("div"); bx.id = "plan"; bx.className = "verre";
  bx.innerHTML = '<div class="fond"><img alt=""><i class="cone"></i></div>'; bx.querySelector("img").src = P.image;
  const fond = bx.firstChild, cone = fond.querySelector(".cone");
  fond.style.aspectRatio = `${P.x1 - P.x0} / ${P.z1 - P.z0}`;
  const pos = (q) => [((q.x - P.x0) / (P.x1 - P.x0) * 100).toFixed(2) + "%", ((q.z - P.z0) / (P.z1 - P.z0) * 100).toFixed(2) + "%"];
  for (const q of v.points) {
    const d = document.createElement("button"); d.className = "pt"; d.dataset.id = q.id; d.title = q.nom; d.setAttribute("aria-label", q.nom);
    [d.style.left, d.style.top] = pos(q); d.onclick = (e) => { e.stopPropagation(); aller(q.id); }; fond.append(d);
  }
  bx.onclick = () => bx.classList.toggle("grand");
  document.body.append(bx); plan = { bx, fond, cone, pos };
}
function placerPlan() {
  if (!plan || !ici) return;
  [plan.cone.style.left, plan.cone.style.top] = plan.pos(ici);
  plan.cone.style.transform = `translate(-50%, -50%) rotate(${(ici.cap + pano.yaw * 180 / Math.PI).toFixed(1)}deg)`;
  for (const d of plan.fond.querySelectorAll(".pt")) d.classList.toggle("ici", d.dataset.id === ici.id);
}
pano.surChange = () => { placer(); placerPlan(); };
function poserReperes() {
  reperes.textContent = "";
  for (const id of ici.liens) {
    const q = pts.get(id); if (!q) continue;
    const el = document.createElement("button"); el.className = "repere"; el.q = q; el.setAttribute("aria-label", q.nom);
    el.innerHTML = "<i></i><span></span>"; el.lastChild.textContent = q.nom; el.onclick = () => aller(id); reperes.append(el);
  }
  placer(); reperes.classList.remove("cache");
}
async function aller(id, premier = false) {
  const q = pts.get(id); if (!q || occupe || (ici && ici.id === id)) return;
  occupe = true; finiAide();
  const bouton = [...barre.children].find((b) => b.dataset.id === id); bouton?.classList.add("charge");
  reperes.classList.add("cache");
  try {
    if (premier) { await pano.charger(img(q)); pano.yaw = (v.regardDepart != null && id === v.depart) ? rad(v.regardDepart - q.cap) : 0; pano.pitch = 0; }
    else {
      await Pano.image(img(q)).catch(() => {});            // l'image est déjà là quand le fondu part : le léger resserrement du champ (on avance) reste calé sur lui
      const f0 = pano.fov, td = performance.now();
      (function avance() { const t = Math.min(1, (performance.now() - td) / 470); pano.fov = f0 * (1 - 0.09 * Math.sin(Math.PI * t)); pano.sale = true;
        if (t < 1) requestAnimationFrame(avance); else { pano.fov = f0; pano.sale = true; } })();
      await pano.charger(img(q), 450, rad(ici.cap) - rad(q.cap));
    }
    ici = q;
    for (const b of barre.children) b.classList.toggle("ici", b.dataset.id === id);
    bouton?.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" });
    $("titre-s").textContent = [v.sousTitre, q.nom].filter(Boolean).join(" · ");
    history.replaceState(null, "", "#" + id);
    poserReperes(); placerPlan();
    for (const l of q.liens) { const n = pts.get(l); if (n) Pano.image(img(n)).catch(() => {}); }      // les voisins sont chargés d'avance
  } catch (e) { $("charge-etat") && ($("charge-etat").textContent = String(e.message || e)); }
  bouton?.classList.remove("charge"); occupe = false;
}
function finiAide() { if (aideFinie) return; aideFinie = true; setTimeout(() => aide.classList.add("parti"), 1200); }
aide.textContent = en ? "Drag to look around, tap a circle on the floor to move" : "Glissez pour regarder autour de vous, touchez un rond au sol pour avancer";
$("c").addEventListener("pointerdown", finiAide); setTimeout(finiAide, 9000);
addEventListener("keydown", (e) => { const k = { ArrowLeft: -1, ArrowRight: 1 }[e.key]; if (k) { pano.tourner(k * 0.12, 0); e.preventDefault(); } });
const depart = pts.has(location.hash.slice(1)) ? location.hash.slice(1) : (v.depart || v.points[0].id);
await aller(depart, true);
$("charge")?.classList.add("fini");
// tant qu'on n'a touché à rien, la vue tourne doucement : on comprend tout de suite qu'on peut regarder partout
let balade = true, t0 = performance.now();
const stop = () => { balade = false; };
for (const ev of ["pointerdown", "wheel", "keydown", "touchstart"]) addEventListener(ev, stop, { once: true, passive: true });
(function tourne(t) { if (!balade) return; pano.tourner(Math.min(40, t - t0) * 0.00011, 0); t0 = t; requestAnimationFrame(tourne); })(t0);
