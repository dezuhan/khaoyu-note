// In-app screen color picker. The native layer captures the app client area; this overlay turns the
// captured pixels into a magnified preview and lets the user pick a color without hiding the window.

const SAMPLE_SIZE = 15;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toHex(red, green, blue) {
  return (
    "#" +
    [red, green, blue]
      .map((channel) => Number(channel).toString(16).padStart(2, "0"))
      .join("")
  ).toUpperCase();
}

export function openAppScreenPicker({ capture, onPick }) {
  if (!capture?.data || !capture.width || !capture.height) return;

  const bytes = Uint8Array.from(atob(capture.data), (char) => char.charCodeAt(0));
  const source = document.createElement("canvas");
  source.width = capture.width;
  source.height = capture.height;
  const sourceContext = source.getContext("2d", { willReadFrequently: true });
  sourceContext.putImageData(
    new ImageData(new Uint8ClampedArray(bytes.buffer), capture.width, capture.height),
    0,
    0
  );

  const overlay = document.createElement("div");
  overlay.className = "mn-screen-pick";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-label", "Pick a color from the app");
  overlay.tabIndex = -1;
  overlay.innerHTML = `
    <canvas class="mn-screen-pick-canvas"></canvas>
    <div class="mn-screen-pick-mag">
      <canvas width="${SAMPLE_SIZE * 11}" height="${SAMPLE_SIZE * 11}"></canvas>
      <span class="mn-screen-pick-hex">#000000</span>
    </div>
    <div class="mn-screen-pick-hint">Click to pick a color · Esc to cancel</div>`;
  document.body.append(overlay);

  const display = overlay.querySelector(".mn-screen-pick-canvas");
  const displayContext = display.getContext("2d");
  const magnifier = overlay.querySelector(".mn-screen-pick-mag");
  const magnifierCanvas = magnifier.querySelector("canvas");
  const magnifierContext = magnifierCanvas.getContext("2d");
  const hexLabel = magnifier.querySelector(".mn-screen-pick-hex");

  let pointerX = Math.round(window.innerWidth / 2);
  let pointerY = Math.round(window.innerHeight / 2);
  let currentHex = "#000000";

  function sourcePoint(clientX, clientY) {
    return {
      x: clamp(Math.round((clientX / window.innerWidth) * capture.width), 0, capture.width - 1),
      y: clamp(Math.round((clientY / window.innerHeight) * capture.height), 0, capture.height - 1),
    };
  }

  function readColor(clientX, clientY) {
    const point = sourcePoint(clientX, clientY);
    const pixel = sourceContext.getImageData(point.x, point.y, 1, 1).data;
    return { point, hex: toHex(pixel[0], pixel[1], pixel[2]) };
  }

  function paintDisplay() {
    const scale = window.devicePixelRatio || 1;
    display.width = Math.max(1, Math.round(window.innerWidth * scale));
    display.height = Math.max(1, Math.round(window.innerHeight * scale));
    displayContext.imageSmoothingEnabled = false;
    displayContext.drawImage(source, 0, 0, display.width, display.height);
  }

  function paintMagnifier() {
    const point = sourcePoint(pointerX, pointerY);
    const half = Math.floor(SAMPLE_SIZE / 2);
    const left = clamp(point.x - half, 0, Math.max(0, capture.width - SAMPLE_SIZE));
    const top = clamp(point.y - half, 0, Math.max(0, capture.height - SAMPLE_SIZE));
    const width = Math.min(SAMPLE_SIZE, capture.width);
    const height = Math.min(SAMPLE_SIZE, capture.height);
    const sample = sourceContext.getImageData(left, top, width, height);
    const cell = Math.floor(magnifierCanvas.width / SAMPLE_SIZE);

    magnifierContext.imageSmoothingEnabled = false;
    magnifierContext.clearRect(0, 0, magnifierCanvas.width, magnifierCanvas.height);
    for (let row = 0; row < height; row += 1) {
      for (let column = 0; column < width; column += 1) {
        const offset = (row * width + column) * 4;
        magnifierContext.fillStyle = `rgb(${sample.data[offset]}, ${sample.data[offset + 1]}, ${
          sample.data[offset + 2]
        })`;
        magnifierContext.fillRect(column * cell, row * cell, cell, cell);
      }
    }

    const center = point.x - left;
    const centerY = point.y - top;
    if (center >= 0 && center < width && centerY >= 0 && centerY < height) {
      magnifierContext.strokeStyle = "#ffffff";
      magnifierContext.lineWidth = 2;
      magnifierContext.strokeRect(center * cell, centerY * cell, cell, cell);
      magnifierContext.strokeStyle = "#000000";
      magnifierContext.lineWidth = 1;
      magnifierContext.strokeRect(center * cell + 1, centerY * cell + 1, cell - 2, cell - 2);
    }

    const color = readColor(pointerX, pointerY);
    currentHex = color.hex;
    hexLabel.textContent = currentHex;
    const size = magnifier.getBoundingClientRect();
    const gap = 18;
    let leftPos = pointerX + gap;
    let topPos = pointerY + gap;
    if (leftPos + size.width > window.innerWidth - 10) leftPos = pointerX - size.width - gap;
    if (topPos + size.height > window.innerHeight - 10) topPos = pointerY - size.height - gap;
    magnifier.style.left = `${Math.max(10, leftPos)}px`;
    magnifier.style.top = `${Math.max(10, topPos)}px`;
  }

  function cleanup() {
    window.removeEventListener("resize", paintDisplay);
    window.removeEventListener("resize", paintMagnifier);
    window.removeEventListener("keydown", onKeyDown);
    overlay.remove();
  }

  function onKeyDown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      cleanup();
    }
  }

  overlay.addEventListener("pointermove", (event) => {
    pointerX = event.clientX;
    pointerY = event.clientY;
    paintMagnifier();
  });
  overlay.addEventListener("click", (event) => {
    const color = readColor(event.clientX, event.clientY);
    cleanup();
    onPick?.(color.hex);
  });
  window.addEventListener("keydown", onKeyDown);
  window.addEventListener("resize", paintDisplay);
  window.addEventListener("resize", paintMagnifier);

  paintDisplay();
  paintMagnifier();
  overlay.focus();
}
