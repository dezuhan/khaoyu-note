// Optional on-screen frame-cost HUD for diagnosing stutter on a specific machine.
//
// It is off by default: press Ctrl+Alt+Shift+P (or load the app with ?perf=1) to show it. The HUD
// measures delivered animation frames, not script work, so a frame that took too long anywhere in the
// pipeline shows up as a gap. Click it to copy a report that can be pasted into an issue.

const WINDOW_FRAMES = 240;
const SHORTCUT = { key: "p", ctrl: true, alt: true, shift: true };
const SAMPLE_MS = 250;

let hud = null;
let enabled = false;
let frameLoop = 0;
let sampleTimer = 0;
let longTaskObserver = null;
let frames = [];
let lastFrame = 0;
let gpuInfo = "";
let since = 0;
let longTasks = 0;
let longestTask = 0;
let longTaskTotal = 0;

function createHud() {
  const style = document.createElement("style");
  style.textContent = `
    .mn-perf-hud {
      position: fixed;
      left: 12px;
      bottom: 12px;
      z-index: 2147483000;
      min-width: 210px;
      padding: 8px 10px;
      border-radius: 8px;
      background: rgba(12, 12, 14, 0.86);
      color: #f2f2f4;
      font: 11px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      letter-spacing: 0.01em;
      white-space: pre;
      cursor: pointer;
      user-select: none;
    }
    .mn-perf-hud b { color: #9fe870; font-weight: 600; }
    .mn-perf-hud i { color: #ffd166; font-style: normal; }
  `;
  document.head.append(style);

  hud = document.createElement("div");
  hud.className = "mn-perf-hud";
  hud.title = "Klik untuk menyalin laporan performa";
  hud.addEventListener("click", () => void copyReport());
  document.body.append(hud);
}

function readGpu() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
    const ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
    gpuInfo = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : "unknown";
  } catch {
    gpuInfo = "unavailable";
  }
}

function tick(now) {
  if (!enabled) return;
  if (lastFrame) {
    frames.push(now - lastFrame);
    if (frames.length > WINDOW_FRAMES) frames.shift();
  }
  lastFrame = now;
  frameLoop = requestAnimationFrame(tick);
}

function stats() {
  const sorted = [...frames].sort((a, b) => a - b);
  const at = (p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] : 0);
  const summed = frames.reduce((total, ms) => total + ms, 0);
  return {
    fps: summed > 0 ? Math.round((frames.length / summed) * 1000) : 0,
    median: Math.round(at(0.5) * 10) / 10,
    p90: Math.round(at(0.9) * 10) / 10,
    p99: Math.round(at(0.99) * 10) / 10,
    worst: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : 0,
    over25: frames.filter((ms) => ms > 25).length,
    over50: frames.filter((ms) => ms > 50).length,
    longTasks,
    longestTask: Math.round(longestTask * 10) / 10,
    longTaskTotal: Math.round(longTaskTotal * 10) / 10,
    elapsed: Math.round(Math.max(1, performance.now() - since) / 1000),
  };
}

function renderHud() {
  if (!hud) return;
  const s = stats();
  const nodes = document.querySelectorAll("*").length;
  const cards = document.querySelectorAll(".mn-card").length;
  hud.textContent = [
    `fps ${s.fps}  frame ${s.median}ms (p90 ${s.p90}, max ${s.worst})`,
    `slow >25ms ${s.over25}  >50ms ${s.over50}`,
    `long tasks ${s.longTasks} (max ${s.longestTask}ms)`,
    `board ${cards} cards · ${nodes} nodes · ${window.devicePixelRatio}x`,
    `gpu ${gpuInfo.slice(0, 46)}`,
  ].join("\n");
}

function sample() {
  renderHud();
  sampleTimer = window.setTimeout(sample, SAMPLE_MS);
}

function start() {
  if (enabled) return;
  enabled = true;
  frames = [];
  lastFrame = 0;
  longTasks = 0;
  longestTask = 0;
  longTaskTotal = 0;
  since = performance.now();
  if (!hud) createHud();
  hud.hidden = false;
  if (!gpuInfo) readGpu();
  try {
    longTaskObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        longTasks += 1;
        longTaskTotal += entry.duration;
        longestTask = Math.max(longestTask, entry.duration);
      }
    });
    longTaskObserver.observe({ entryTypes: ["longtask"] });
  } catch {
    longTaskObserver = null;
  }
  frameLoop = requestAnimationFrame(tick);
  sample();
}

function stop() {
  enabled = false;
  cancelAnimationFrame(frameLoop);
  clearTimeout(sampleTimer);
  if (longTaskObserver) {
    longTaskObserver.disconnect();
    longTaskObserver = null;
  }
  if (hud) hud.hidden = true;
  return stats();
}

function report() {
  const s = stats();
  return [
    `Khaoyu Note performance report`,
    `when: ${new Date().toISOString()}`,
    `fps: ${s.fps}`,
    `frame ms: median ${s.median}, p90 ${s.p90}, p99 ${s.p99}, worst ${s.worst}`,
    `frames over 25ms: ${s.over25}, over 50ms: ${s.over50}`,
    `long tasks: ${s.longTasks}, longest ${s.longestTask}ms, total ${s.longTaskTotal}ms`,
    `window: ${window.innerWidth}x${window.innerHeight} @ ${window.devicePixelRatio}x`,
    `cards: ${document.querySelectorAll(".mn-card").length}, DOM nodes: ${document.querySelectorAll("*").length}`,
    `gpu: ${gpuInfo}`,
    `ua: ${navigator.userAgent}`,
    `performance mode: ${document.documentElement.dataset.performance}`,
  ].join("\n");
}

async function copyReport() {
  const text = report();
  try {
    await navigator.clipboard.writeText(text);
    if (hud) hud.dataset.copied = "1";
    console.info("[perf]", text);
  } catch {
    console.info("[perf] clipboard unavailable\n" + text);
  }
}

function toggle() {
  if (enabled) {
    const s = stop();
    console.info("[perf] stopped", JSON.stringify(s));
  } else {
    start();
  }
}

export function initPerfOverlay() {
  const wanted = new URLSearchParams(window.location.search).get("perf");
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.repeat) return;
      const key = String(event.key || "").toLowerCase();
      if (key !== SHORTCUT.key) return;
      const match =
        Boolean(event.ctrlKey) === SHORTCUT.ctrl &&
        Boolean(event.altKey) === SHORTCUT.alt &&
        Boolean(event.shiftKey) === SHORTCUT.shift;
      if (!match) return;
      event.preventDefault();
      toggle();
    },
    true
  );
  if (wanted === "1") start();
}
