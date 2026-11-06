import { chromium } from "playwright";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://127.0.0.1:1430/", { waitUntil: "load" });
await page.waitForTimeout(1200);
const metrics = await page.evaluate(async () => {
  const store = await import("/js/store.js");
  const model = await import("/js/model.js");
  const cards = [];
  for (let index = 0; index < 500; index += 1) {
    const card = model.createCard("note", (index % 12) * 300, Math.floor(index / 12) * 140);
    card.text = `Performance card ${index}`;
    cards.push(card);
  }
  store.state.board.cards = cards;
  store.state.board.connections = [];
  store.state.selection = new Set();
  const started = performance.now();
  store.markDirty("board");
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const elapsed = performance.now() - started;
  return {
    elapsed,
    cards: document.querySelectorAll(".mn-card").length,
    nodes: document.querySelectorAll("*").length,
  };
});
console.log(JSON.stringify(metrics, null, 2));
await browser.close();
