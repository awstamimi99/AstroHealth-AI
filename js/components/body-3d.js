// js/components/body-3d.js — SHARED. The rotatable 3D body (WebGL, three.js from
// vendor/three) with alert pins, as a drop-in for createBodyScan():
//
//   const body = createBody3D({ crop: "full", pins, hotspots, onPinClick });
//
// • The 2D body (body-scan.js) is shown immediately and stays when WebGL or
//   three.js is unavailable (old devices, unit tests, a failed load) — the page
//   never depends on 3D.
// • The figure is an original, stylised "hologram" built from simple shapes. It
//   is decorative and conveys NO health information by itself (aria-hidden).
// • Pins are real <button>s (same markup and CSS as the 2D pins) laid over the
//   canvas and moved to their body zone every frame, so keyboard and screen-
//   reader users get the same pins. Pins on the far side are dimmed, not hidden.
// • Controls: drag to rotate, pinch or the +/− buttons to zoom, arrow keys on
//   the focused stage, front/back and reset buttons. A slow auto-turn runs until
//   the user interacts, and never under reduced motion.
// • Rendering stops while the body is off-screen and everything is disposed
//   when the element leaves the page (no WebGL context leaks on navigation).
//
// Test seam: createBody3D({ …, loadThree, webgl }).

import { el } from "../core/utils/dom.js";
import { icon } from "./icon.js";
import { createBodyScan, PIN_SEVERITY } from "./body-scan.js";
import { ZONE_LABELS } from "./alert-zones.js";

/** Zone anchor points on the 3D figure (figure units; the figure's left arm is +x). */
export const ZONES_3D = Object.freeze({
  head: [0, 1.47, 0.22],
  chest: [0, 0.86, 0.27],
  heart: [0.11, 0.8, 0.27],
  lungs: [-0.13, 0.9, 0.26],
  arm: [0.6, 0.42, 0.06],
  abdomen: [0, 0.44, 0.27],
  "lower-back": [0, 0.28, -0.22],
  legs: [0.15, -0.62, 0.13],
});
const SEVERITY_COLOR = { critical: ["--color-scan-critical", "#F0508C"], warning: ["--color-scan-watch", "#FB923C"], info: ["--color-scan-info", "#93C5FD"] };

/** Does this browser offer WebGL? Never throws. */
export function hasWebGL() {
  try {
    const c = globalThis.document && document.createElement("canvas");
    return Boolean(c && typeof c.getContext === "function" && (c.getContext("webgl2") || c.getContext("webgl")));
  } catch {
    return false;
  }
}

const reducedMotion = () => {
  try {
    if (document.documentElement.getAttribute("data-motion") === "reduce") return true;
    return Boolean(globalThis.matchMedia && globalThis.matchMedia("(prefers-reduced-motion: reduce)").matches);
  } catch {
    return false;
  }
};
const cssColor = (root, [token, fallback]) => {
  try {
    const v = getComputedStyle(root).getPropertyValue(token).trim();
    return v || fallback;
  } catch {
    return fallback;
  }
};

/**
 * @param {{ crop?: "full"|"upper", pins?: Array, hotspots?: Array, onPinClick?: Function, className?: string,
 *           loadThree?: () => Promise<object>, webgl?: () => boolean }} options
 */
export function createBody3D({ crop = "full", pins = [], hotspots = [], onPinClick = null, className = "", loadThree = () => import("../../vendor/three/three.module.min.js"), webgl = hasWebGL } = {}) {
  const safePins = Array.isArray(pins) ? pins.filter(Boolean) : [];
  const flat = createBodyScan({ crop, pins: safePins, hotspots, onPinClick, className });
  const root = el("div", { class: ["body3d", `body3d--${crop}`, className], "data-body3d": "2d" }, flat);
  if (!webgl()) return root;

  loadThree()
    .then((THREE) => {
      if (!root.isConnected && !root.parentNode) {
        // Not on the page yet: wait one frame for the caller to insert it.
        return new Promise((r) => requestAnimationFrame(r)).then(() => mount(THREE));
      }
      return mount(THREE);
    })
    .catch(() => { /* keep the 2D body */ });

  function mount(THREE) {
    if (!root.isConnected) return;
    const stage = el("div", { class: "body3d__stage", tabindex: "0", role: "group", "aria-roledescription": "3D body", "aria-label": "3D body. Drag or use the arrow keys to rotate, plus and minus to zoom." });
    const layer = el("div", { class: "body3d__pins" });
    const status = el("p", { class: "sr-only", "aria-live": "polite" });

    // ---- scene -------------------------------------------------------------------------------
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "low-power" });
    renderer.setPixelRatio(Math.min(2, globalThis.devicePixelRatio || 1));
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.classList.add("body3d__canvas");
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(28, 0.5, 0.1, 50);
    const target = new THREE.Vector3(0, crop === "upper" ? 0.9 : 0.02, 0);
    const homeDistance = crop === "upper" ? 4.7 : 6.5;
    let distance = homeDistance;

    scene.add(new THREE.HemisphereLight(0x9be7ff, 0x0b1220, 1.1));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(2, 3, 4);
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x22d3ee, 1.2);
    rim.position.set(-3, 2, -3);
    scene.add(rim);

    const cyan = new THREE.Color(cssColor(root, ["--color-scan-outline", "#22D3EE"]));
    const skin = new THREE.MeshPhongMaterial({ color: cyan, emissive: cyan.clone().multiplyScalar(0.25), transparent: true, opacity: 0.32, shininess: 80, depthWrite: false, side: THREE.DoubleSide });
    const wire = new THREE.MeshBasicMaterial({ color: cyan, wireframe: true, transparent: true, opacity: 0.12, depthWrite: false });
    const figure = new THREE.Group();
    const disposables = [skin, wire];
    function part(geometry, [x, y, z], { rot = [0, 0, 0], scale = [1, 1, 1] } = {}) {
      disposables.push(geometry);
      for (const mat of [skin, wire]) {
        const m = new THREE.Mesh(geometry, mat);
        m.position.set(x, y, z);
        m.rotation.set(...rot);
        m.scale.set(...scale);
        figure.add(m);
      }
    }
    const cap = (r, len) => new THREE.CapsuleGeometry(r, len, 4, 12);
    part(new THREE.SphereGeometry(0.21, 24, 18), [0, 1.47, 0], { scale: [0.92, 1.12, 1] });           // head
    part(new THREE.CylinderGeometry(0.075, 0.09, 0.16, 16), [0, 1.2, 0]);                             // neck
    part(cap(0.3, 0.5), [0, 0.78, 0], { scale: [1.22, 1, 0.62] });                                   // chest
    part(cap(0.26, 0.16), [0, 0.3, 0], { scale: [1.08, 1, 0.66] });                                  // pelvis
    for (const s of [-1, 1]) {
      part(new THREE.SphereGeometry(0.1, 16, 12), [s * 0.43, 1.03, 0]);                               // shoulder
      part(cap(0.075, 0.46), [s * 0.5, 0.74, 0], { rot: [0, 0, s * 0.12] });                         // upper arm
      part(cap(0.064, 0.42), [s * 0.57, 0.24, 0.02], { rot: [0, 0, s * 0.05] });                     // forearm
      part(new THREE.SphereGeometry(0.075, 14, 10), [s * 0.6, -0.08, 0.03], { scale: [0.8, 1.25, 0.6] }); // hand
      part(cap(0.115, 0.56), [s * 0.155, -0.28, 0]);                                                 // thigh
      part(cap(0.085, 0.56), [s * 0.165, -0.95, 0]);                                                 // shin
      part(cap(0.06, 0.13), [s * 0.17, -1.38, 0.07], { rot: [Math.PI / 2, 0, 0] });                  // foot
    }
    if (crop === "upper") figure.children.forEach((m) => { if (m.position.y < 0.05) m.visible = false; });
    scene.add(figure);

    // Floor rings (decorative).
    if (crop !== "upper") {
      const ringMat = new THREE.MeshBasicMaterial({ color: cyan, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthWrite: false });
      for (const [r1, r2] of [[0.55, 0.57], [0.75, 0.76]]) {
        const g = new THREE.RingGeometry(r1, r2, 64);
        disposables.push(g);
        const ring = new THREE.Mesh(g, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -1.46;
        scene.add(ring);
      }
      disposables.push(ringMat);
    }

    // Zone glows for open alerts (colour per severity; the pins carry icon + word).
    const glows = [];
    for (const h of Array.isArray(hotspots) ? hotspots : []) {
      const pos = ZONES_3D[h.zone] || ZONES_3D.chest;
      const sev = SEVERITY_COLOR[h.severity] ? h.severity : "info";
      const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(cssColor(root, SEVERITY_COLOR[sev])), transparent: true, opacity: 0.45, depthWrite: false, blending: THREE.AdditiveBlending });
      const g = new THREE.SphereGeometry(0.15, 20, 14);
      disposables.push(mat, g);
      const glow = new THREE.Mesh(g, mat);
      glow.position.set(...pos);
      figure.add(glow);
      glows.push(glow);
    }

    // ---- pins (HTML buttons following their zones) --------------------------------------------
    const perZone = new Map();
    const pinEls = safePins.map((pin) => {
      const k = perZone.get(pin.zone) || 0;
      perZone.set(pin.zone, k + 1);
      const sev = PIN_SEVERITY[pin.severity] ? pin.severity : "info";
      const button = el("button", { type: "button", class: ["scan-pin", `scan-pin--${sev}`, "body3d__pin"], "aria-label": pin.label, "data-pin": String(pin.number) }, [
        el("span", { class: "scan-pin__pulse", "aria-hidden": "true" }),
        el("span", { class: "scan-pin__num", "aria-hidden": "true" }, String(pin.number)),
        pin.tag
          ? el("span", { class: "scan-pin__tag", "aria-hidden": "true" }, [
              el("span", { class: "scan-pin__sev" }, [icon(PIN_SEVERITY[sev].icon, { size: 12 }), PIN_SEVERITY[sev].label]),
              el("span", { class: "scan-pin__title" }, pin.tag),
            ])
          : null,
      ]);
      if (typeof onPinClick === "function") button.addEventListener("click", () => onPinClick(pin, button));
      layer.append(button);
      const base = ZONES_3D[pin.zone] || ZONES_3D.chest;
      return { button, point: new THREE.Vector3(base[0] + k * 0.2, base[1] - k * 0.12, base[2]), normal: new THREE.Vector3(base[0], 0, base[2]).normalize() };
    });

    // ---- controls ------------------------------------------------------------------------------
    let yaw = 0;
    let pitch = 0.05;
    let auto = !reducedMotion();
    const say = (t) => { status.textContent = t; };
    const stopAuto = () => { auto = false; };
    const turn = (d) => { stopAuto(); yaw += d; };
    const zoom = (f) => { stopAuto(); distance = Math.min(homeDistance * 1.6, Math.max(homeDistance * 0.55, distance * f)); };
    const facing = () => {
      const a = ((yaw % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      return a < Math.PI / 2 || a > (3 * Math.PI) / 2 ? "front" : "back";
    };
    const toolbar = el("div", { class: "body3d__tools", role: "toolbar", "aria-label": "3D body controls" }, [
      el("button", { type: "button", class: "body3d__tool", "aria-label": "Rotate left", title: "Rotate left", onClick: () => turn(-Math.PI / 6) }, icon("rotate-ccw", { size: 16 })),
      el("button", { type: "button", class: "body3d__tool body3d__tool--flip", "aria-label": "Rotate right", title: "Rotate right", onClick: () => turn(Math.PI / 6) }, icon("rotate-ccw", { size: 16 })),
      el("button", { type: "button", class: "body3d__tool", "aria-label": "Show front or back", title: "Front / back", onClick: () => { stopAuto(); yaw = facing() === "front" ? Math.PI : 0; say(`Showing the ${facing() === "front" ? "back" : "front"}.`); } }, el("span", { class: "body3d__tool-text" }, "F/B")),
      el("button", { type: "button", class: "body3d__tool", "aria-label": "Zoom in", title: "Zoom in", onClick: () => zoom(0.85) }, icon("plus", { size: 16 })),
      el("button", { type: "button", class: "body3d__tool", "aria-label": "Zoom out", title: "Zoom out", onClick: () => zoom(1 / 0.85) }, el("span", { class: "body3d__tool-text" }, "−")),
      el("button", { type: "button", class: "body3d__tool", "aria-label": "Reset view", title: "Reset view", onClick: () => { yaw = 0; pitch = 0.05; distance = homeDistance; auto = false; say("View reset to the front."); } }, el("span", { class: "body3d__tool-text" }, "Reset")),
    ]);

    const pointers = new Map();
    let lastPinch = 0;
    stage.addEventListener("pointerdown", (e) => {
      if (e.target && e.target.closest && e.target.closest("button")) return;
      stopAuto();
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      try { stage.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      stage.classList.add("is-dragging");
    });
    stage.addEventListener("pointermove", (e) => {
      const p = pointers.get(e.pointerId);
      if (!p) return;
      if (pointers.size === 2) {
        const [a, b] = [...pointers.values()];
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        const [c, d] = [...pointers.values()];
        const dist = Math.hypot(c.x - d.x, c.y - d.y);
        if (lastPinch) zoom(lastPinch / dist);
        lastPinch = dist;
        void a; void b;
        return;
      }
      yaw += (e.clientX - p.x) * 0.012;
      pitch = Math.max(-0.5, Math.min(0.6, pitch + (e.clientY - p.y) * 0.006));
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    });
    const end = (e) => { pointers.delete(e.pointerId); lastPinch = 0; if (!pointers.size) stage.classList.remove("is-dragging"); };
    stage.addEventListener("pointerup", end);
    stage.addEventListener("pointercancel", end);
    stage.addEventListener("keydown", (e) => {
      if (e.target !== stage) return;
      const k = e.key;
      if (k === "ArrowLeft") turn(-Math.PI / 12);
      else if (k === "ArrowRight") turn(Math.PI / 12);
      else if (k === "ArrowUp") { stopAuto(); pitch = Math.min(0.6, pitch + 0.1); }
      else if (k === "ArrowDown") { stopAuto(); pitch = Math.max(-0.5, pitch - 0.1); }
      else if (k === "+" || k === "=") zoom(0.85);
      else if (k === "-" || k === "_") zoom(1 / 0.85);
      else if (k === "Home") { yaw = 0; pitch = 0.05; distance = homeDistance; auto = false; }
      else return;
      e.preventDefault();
    });

    // ---- mount, size, render loop, dispose ----------------------------------------------------
    stage.append(renderer.domElement, layer);
    root.replaceChildren(stage, toolbar, status);
    root.setAttribute("data-body3d", "3d");

    let width = 0;
    let height = 0;
    const resize = () => {
      const r = stage.getBoundingClientRect();
      width = Math.max(1, Math.round(r.width));
      height = Math.max(1, Math.round(r.height));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const ro = typeof ResizeObserver === "function" ? new ResizeObserver(resize) : null;
    if (ro) ro.observe(stage);
    resize();

    let visible = true;
    const io = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => { visible = entries.some((x) => x.isIntersecting); }) : null;
    if (io) io.observe(stage);

    const v = new THREE.Vector3();
    const toCamera = new THREE.Vector3();
    let last = performance.now();
    let raf = 0;
    let gone = 0;
    function frame(now) {
      raf = requestAnimationFrame(frame);
      if (!root.isConnected) {
        if ((gone += 1) > 2) dispose();
        return;
      }
      gone = 0;
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (!visible) return;
      if (auto) yaw += dt * 0.35;
      figure.rotation.y = yaw;
      camera.position.set(target.x, target.y + Math.sin(pitch) * distance, target.z + Math.cos(pitch) * distance);
      camera.lookAt(target);
      const pulse = reducedMotion() ? 0.45 : 0.35 + 0.2 * Math.sin(now / 350);
      for (const g of glows) g.material.opacity = pulse;
      renderer.render(scene, camera);
      // Pins follow their zones; the far side is dimmed (still clickable).
      camera.getWorldDirection(toCamera).negate();
      for (const p of pinEls) {
        v.copy(p.point).applyMatrix4(figure.matrixWorld).project(camera);
        p.button.style.left = `${((v.x + 1) / 2) * width}px`;
        p.button.style.top = `${((1 - v.y) / 2) * height}px`;
        const n = p.normal.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
        p.button.classList.toggle("is-behind", n.dot(toCamera) < -0.15);
      }
    }
    raf = requestAnimationFrame(frame);

    let disposed = false;
    function dispose() {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(raf);
      if (ro) ro.disconnect();
      if (io) io.disconnect();
      for (const d of disposables) d.dispose();
      renderer.dispose();
      try { renderer.forceContextLoss(); } catch { /* ignore */ }
    }
    say(`3D body ready${safePins.length ? `, ${safePins.length} pin${safePins.length === 1 ? "" : "s"}: ${safePins.map((p) => ZONE_LABELS[p.zone] || "body").join(", ")}` : ""}.`);
  }

  return root;
}
