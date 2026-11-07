// Free-form crop editor for link header images and image cards.

export function normalizeCrop(crop) {
  if (!crop || !Number.isFinite(crop.x) || !Number.isFinite(crop.y)) return null;
  const width = Math.min(1, Math.max(0.02, Number(crop.w)));
  const height = Math.min(1, Math.max(0.02, Number(crop.h)));
  return {
    x: Math.min(1 - width, Math.max(0, Number(crop.x))),
    y: Math.min(1 - height, Math.max(0, Number(crop.y))),
    w: width,
    h: height,
    ratio: Number(crop.ratio) || 1,
  };
}

export function openImageCrop({ src, crop, onApply }) {
  const initial = normalizeCrop(crop) || { x: 0, y: 0, w: 1, h: 1, ratio: 1 };
  const overlay = document.createElement("div");
  overlay.className = "mn-crop-overlay";
  overlay.innerHTML = `
    <section class="mn-modal mn-crop-panel" role="dialog" aria-modal="true" aria-label="Crop image">
      <header class="mn-modal-head">
        <h2 class="mn-modal-title">Crop image</h2>
        <button type="button" class="mn-icon-btn mn-modal-close" title="Close">×</button>
      </header>
      <div class="mn-modal-body mn-crop-body">
        <p class="mn-prefs-note">Drag the frame to move it. Drag any edge or corner for a free crop ratio.</p>
        <div class="mn-crop-stage" data-role="stage">
          <img data-role="image" alt="" draggable="false" />
          <div class="mn-crop-box" data-role="box">
            <span class="mn-crop-handle" data-handle="nw"></span>
            <span class="mn-crop-handle" data-handle="ne"></span>
            <span class="mn-crop-handle" data-handle="sw"></span>
            <span class="mn-crop-handle" data-handle="se"></span>
            <span class="mn-crop-handle" data-handle="n"></span>
            <span class="mn-crop-handle" data-handle="s"></span>
            <span class="mn-crop-handle" data-handle="w"></span>
            <span class="mn-crop-handle" data-handle="e"></span>
          </div>
        </div>
        <p class="mn-prefs-note mn-crop-size" data-role="size"></p>
      </div>
      <footer class="mn-modal-foot">
        <button type="button" class="mn-btn mn-btn-quiet" data-role="fit">Fit to image</button>
        <button type="button" class="mn-btn" data-role="cancel">Cancel</button>
        <button type="button" class="mn-btn mn-btn-primary" data-role="apply">Apply crop</button>
      </footer>
    </section>`;
  document.body.append(overlay);

  const image = overlay.querySelector('[data-role="image"]');
  const stage = overlay.querySelector('[data-role="stage"]');
  const box = overlay.querySelector('[data-role="box"]');
  const size = overlay.querySelector('[data-role="size"]');
  let current = { ...initial };
  let displayWidth = 0;
  let displayHeight = 0;

  const close = () => overlay.remove();
  overlay.addEventListener("pointerdown", (event) => {
    if (event.target === overlay) close();
  });
  overlay.querySelector(".mn-modal-close").addEventListener("click", close);
  overlay.querySelector('[data-role="cancel"]').addEventListener("click", close);
  document.addEventListener("keydown", onKeyDown);
  function onKeyDown(event) {
    if (event.key === "Escape" && overlay.isConnected) {
      close();
      document.removeEventListener("keydown", onKeyDown);
    }
  }

  function paint() {
    if (!displayWidth || !displayHeight) return;
    box.style.left = `${current.x * displayWidth}px`;
    box.style.top = `${current.y * displayHeight}px`;
    box.style.width = `${current.w * displayWidth}px`;
    box.style.height = `${current.h * displayHeight}px`;
    size.textContent = `${Math.round(current.w * 100)} × ${Math.round(current.h * 100)} % of the image`;
  }

  image.addEventListener("load", () => {
    const rect = image.getBoundingClientRect();
    displayWidth = rect.width;
    displayHeight = rect.height;
    stage.style.width = `${displayWidth}px`;
    stage.style.height = `${displayHeight}px`;
    paint();
  });
  image.src = src;

  overlay.querySelector('[data-role="fit"]').addEventListener("click", () => {
    current = { x: 0, y: 0, w: 1, h: 1, ratio: current.ratio };
    paint();
  });

  let drag = null;
  box.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    const handle = event.target.dataset.handle;
    drag = {
      handle: handle || "move",
      startX: event.clientX,
      startY: event.clientY,
      x: current.x,
      y: current.y,
      w: current.w,
      h: current.h,
    };
    box.setPointerCapture(event.pointerId);
  });
  box.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / displayWidth;
    const dy = (event.clientY - drag.startY) / displayHeight;
    let { x, y, w, h } = drag;
    const handle = drag.handle;
    if (handle === "move") {
      x = Math.min(1 - w, Math.max(0, x + dx));
      y = Math.min(1 - h, Math.max(0, y + dy));
    } else {
      if (handle.includes("w")) {
        const right = x + w;
        x = Math.min(right - 0.03, Math.max(0, x + dx));
        w = right - x;
      }
      if (handle.includes("e")) w = Math.min(1 - x, Math.max(0.03, w + dx));
      if (handle.includes("n")) {
        const bottom = y + h;
        y = Math.min(bottom - 0.03, Math.max(0, y + dy));
        h = bottom - y;
      }
      if (handle.includes("s")) h = Math.min(1 - y, Math.max(0.03, h + dy));
    }
    current = { ...current, x, y, w, h };
    paint();
  });
  const endDrag = () => {
    drag = null;
  };
  box.addEventListener("pointerup", endDrag);
  box.addEventListener("pointercancel", endDrag);

  overlay.querySelector('[data-role="apply"]').addEventListener("click", () => {
    const ratio = image.naturalWidth && image.naturalHeight ? image.naturalWidth / image.naturalHeight : 1;
    close();
    onApply?.({ ...current, ratio });
  });
}
