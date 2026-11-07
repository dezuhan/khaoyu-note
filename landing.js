// Khaoyu Note landing page interactions. No framework, no external requests.

const root = document.documentElement;
root.classList.add("lp-js");

const themeButton = document.getElementById("theme-toggle");
const themeLabel = document.getElementById("theme-label");
const THEME_KEY = "khaoyu.landing.theme";

function applyTheme(theme) {
  root.dataset.kyTheme = theme;
  localStorage.setItem(THEME_KEY, theme);
  if (themeLabel) themeLabel.textContent = theme === "dark" ? "Light" : "Dark";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#111111" : "#f7f7f7");
}

const storedTheme = localStorage.getItem(THEME_KEY);
applyTheme(storedTheme === "light" || storedTheme === "dark" ? storedTheme : "dark");

themeButton?.addEventListener("click", () => {
  applyTheme(root.dataset.kyTheme === "dark" ? "light" : "dark");
});

// Mobile navigation.
const menuButton = document.getElementById("menu-toggle");
const navLinks = document.getElementById("nav-links");

function closeMenu() {
  navLinks?.classList.remove("is-open");
  menuButton?.setAttribute("aria-expanded", "false");
}

menuButton?.addEventListener("click", () => {
  const open = navLinks?.classList.toggle("is-open");
  menuButton.setAttribute("aria-expanded", String(Boolean(open)));
});

for (const link of navLinks?.querySelectorAll("a") ?? []) {
  link.addEventListener("click", closeMenu);
}

document.addEventListener("click", (event) => {
  if (!navLinks?.classList.contains("is-open")) return;
  if (navLinks.contains(event.target) || menuButton?.contains(event.target)) return;
  closeMenu();
});

// Screenshot tabs.
const shots = {
  boards: {
    src: "shots/board-light.png",
    alt: "Khaoyu Note board in light mode with cards and comments",
    title: "Khaoyu Note - Boards",
    caption: "Light and dark themes share the same quiet token system.",
  },
  welcome: {
    src: "shots/welcome-all-tools.png",
    alt: "Welcome board with the enabled Khaoyu Note card types",
    title: "Khaoyu Note - Welcome",
    caption: "A fresh board seeds the enabled tools without the three disabled card types.",
  },
  settings: {
    src: "shots/settings-general.png",
    alt: "Khaoyu Note Settings on the General page",
    title: "Khaoyu Note - Settings",
    caption: "Server, Backup, General, Appearance, Tools, Performance, MCP and About.",
  },
  writing: {
    src: "shots/doc-editor.png",
    alt: "Khaoyu Note document editor",
    title: "Khaoyu Note - Writing",
    caption: "A document card opens into a focused writing page with export.",
  },
  drawing: {
    src: "shots/drawing-editor.png",
    alt: "Khaoyu Note drawing editor",
    title: "Khaoyu Note - Drawing",
    caption: "Sketch cards open into a full-page drawing editor.",
  },
};

const shotImage = document.getElementById("shot-image");
const shotTitle = document.getElementById("shot-title");
const shotCaption = document.getElementById("shot-caption");

function selectShot(key) {
  const shot = shots[key];
  if (!shot || !shotImage) return;
  shotImage.src = shot.src;
  shotImage.alt = shot.alt;
  if (shotTitle) shotTitle.textContent = shot.title;
  if (shotCaption) shotCaption.textContent = shot.caption;
  for (const button of document.querySelectorAll(".lp-tabs button")) {
    const active = button.dataset.shot === key;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  }
}

for (const button of document.querySelectorAll(".lp-tabs button")) {
  button.addEventListener("click", () => selectShot(button.dataset.shot));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowRight" && event.key !== "ArrowLeft") return;
    event.preventDefault();
    const buttons = [...document.querySelectorAll(".lp-tabs button")];
    const index = buttons.indexOf(button);
    const next = buttons[(index + (event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length];
    next.focus();
    selectShot(next.dataset.shot);
  });
}

// Reveal sections as they enter the viewport.
const revealItems = [...document.querySelectorAll("[data-reveal]")];
if ("IntersectionObserver" in window && revealItems.length) {
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        observer.unobserve(entry.target);
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  for (const item of revealItems) observer.observe(item);
} else {
  for (const item of revealItems) item.classList.add("is-visible");
}

// Small nav elevation once the hero starts scrolling.
const nav = document.querySelector(".lp-nav");
function updateNav() {
  nav?.classList.toggle("is-scrolled", window.scrollY > 12);
}
window.addEventListener("scroll", updateNav, { passive: true });
updateNav();
