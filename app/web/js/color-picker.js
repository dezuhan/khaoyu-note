// Compact HSV colour picker used by the Color card. No title text: saturation/value square,
// vertical hue slider, hex field, eyedropper, OK and Cancel.

import { icon } from "./icons.js";
import { captureWindow, hasTauri } from "./bridge.js";
import { openAppScreenPicker } from "./screen-color-picker.js";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function normalizeHex(value) {
  let text = String(value || "").trim();
  if (!text.startsWith("#")) text = "#" + text;
  if (/^#[0-9a-f]{3}$/i.test(text)) {
    text = "#" + text.slice(1).split("").map((char) => char + char).join("");
  }
  return /^#[0-9a-f]{6}$/i.test(text) ? text.toUpperCase() : null;
}

function hexToRgb(hex) {
  const value = normalizeHex(hex) || "#000000";
  return {
    r: parseInt(value.slice(1, 3), 16),
    g: parseInt(value.slice(3, 5), 16),
    b: parseInt(value.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  return (
    "#" +
    [r, g, b]
      .map((channel) => Math.round(clamp(channel, 0, 255)).toString(16).padStart(2, "0"))
      .join("")
  ).toUpperCase();
}

function rgbToHsv({ r, g, b }) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  let hue = 0;
  if (delta) {
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  return { h: hue, s: max ? delta / max : 0, v: max };
}

function hsvToRgb(h, s, v) {
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g, b] = [c, x, 0];
  else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x];
  else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 };
}

export function openColorPicker({ color, anchor, onChange }) {
  const original = normalizeHex(color) || "#B262C0";
  const hsv = rgbToHsv(hexToRgb(original));
  let current = original;

  const backdrop = document.createElement("div");
  backdrop.className = "mn-color-backdrop";
  const pop = document.createElement("div");
  pop.className = "mn-color-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Colour picker");
  pop.innerHTML = `
    <div class="mn-color-main">
      <div class="mn-color-sv" data-role="sv">
        <span class="mn-color-sv-white"></span>
        <span class="mn-color-sv-black"></span>
        <span class="mn-color-sv-marker" data-role="sv-marker"></span>
      </div>
      <div class="mn-color-hue" data-role="hue"><span class="mn-color-hue-marker" data-role="hue-marker"></span></div>
    </div>
    <div class="mn-color-bottom">
      <input class="mn-color-hex" data-role="hex" maxlength="7" spellcheck="false" />
      <button type="button" class="mn-color-eyedrop" data-role="eyedrop" title="Pick a color from the screen" aria-label="Pick a color from the screen">${icon("eyedropper", 15)}</button>
    </div>`;
  document.body.append(backdrop, pop);

  const sv = pop.querySelector('[data-role="sv"]');
  const hue = pop.querySelector('[data-role="hue"]');
  const svMarker = pop.querySelector('[data-role="sv-marker"]');
  const hueMarker = pop.querySelector('[data-role="hue-marker"]');
  const hexInput = pop.querySelector('[data-role="hex"]');
  const eyedrop = pop.querySelector('[data-role="eyedrop"]');
  if (!hasTauri && !("EyeDropper" in window)) eyedrop.hidden = true;

  function hexValue() {
    return rgbToHex(...Object.values(hsvToRgb(hsv.h, hsv.s, hsv.v)));
  }

  function paint() {
    current = hexValue();
    const base = rgbToHex(...Object.values(hsvToRgb(hsv.h, 1, 1)));
    sv.style.setProperty("--picker-hue", base);
    svMarker.style.left = `${hsv.s * 100}%`;
    svMarker.style.top = `${(1 - hsv.v) * 100}%`;
    hueMarker.style.top = `${(hsv.h / 360) * 100}%`;
    hexInput.value = current;
    onChange?.(current);
  }

  function setFromHex(value) {
    const normalized = normalizeHex(value);
    if (!normalized) return false;
    Object.assign(hsv, rgbToHsv(hexToRgb(normalized)));
    paint();
    return true;
  }

  function position() {
    const rect = anchor.getBoundingClientRect();
    const size = pop.getBoundingClientRect();
    const gap = 8;
    let left = rect.left - size.width - gap;
    if (left < 10) left = rect.right + gap;
    left = clamp(left, 10, window.innerWidth - size.width - 10);
    const top = clamp(
      rect.top + (rect.height - size.height) / 2,
      10,
      window.innerHeight - size.height - 10
    );
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }

  function close() {
    backdrop.remove();
    pop.remove();
    window.removeEventListener("keydown", onKeyDown);
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Enter" && document.activeElement === hexInput) {
      event.preventDefault();
      setFromHex(hexInput.value);
      close();
    }
  }

  function dragSquare(event) {
    const rect = sv.getBoundingClientRect();
    hsv.s = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    hsv.v = 1 - clamp((event.clientY - rect.top) / rect.height, 0, 1);
    paint();
  }

  function dragHue(event) {
    const rect = hue.getBoundingClientRect();
    hsv.h = clamp((event.clientY - rect.top) / rect.height, 0, 1) * 360;
    paint();
  }

  function track(handler) {
    return (event) => {
      event.preventDefault();
      handler(event);
      const move = (moveEvent) => handler(moveEvent);
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    };
  }

  sv.addEventListener("pointerdown", track(dragSquare));
  hue.addEventListener("pointerdown", track(dragHue));
  hexInput.addEventListener("input", () => {
    if (/^#?[0-9a-f]{6}$/i.test(hexInput.value.trim())) setFromHex(hexInput.value);
  });
  hexInput.addEventListener("change", () => {
    if (!setFromHex(hexInput.value)) hexInput.value = current;
  });
  hexInput.addEventListener("blur", () => {
    if (!setFromHex(hexInput.value)) hexInput.value = current;
  });
  eyedrop.addEventListener("click", async () => {
    try {
      if ("EyeDropper" in window) {
        const result = await new window.EyeDropper().open();
        if (setFromHex(result?.sRGBHex)) close();
        return;
      }
      if (!hasTauri) return;
      const capture = await captureWindow();
      if (!capture?.data) return;
      openAppScreenPicker({
        capture,
        onPick: (hex) => {
          if (setFromHex(hex)) close();
        },
      });
    } catch {
      if (!hasTauri) return;
      try {
        const capture = await captureWindow();
        if (!capture?.data) return;
        openAppScreenPicker({
          capture,
          onPick: (hex) => {
            if (setFromHex(hex)) close();
          },
        });
      } catch {
        // The screen picker is not available on this platform.
      }
    }
  });
  backdrop.addEventListener("pointerdown", close);
  window.addEventListener("keydown", onKeyDown);

  paint();
  position();
}
