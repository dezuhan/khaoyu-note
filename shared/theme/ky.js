/*
 * Khaoyu Design System — framework behaviour
 * version 1.0.0
 *
 * Provides the custom select used by the framework components. No dependencies; works in a Photon
 * plugin panel and in a normal browser page.
 *
 *   <span class="ky-select">
 *     <select><option>…</option></select>
 *     <span class="ky-chevron" aria-hidden="true"></span>
 *   </span>
 *
 *   KySelect.enhanceAll();          // after rendering
 *   KySelect.enhance(selectElement);
 */
(function (root) {
  "use strict";

  const SELECT_CLASS = "ky-select";
  const NATIVE_CLASS = "ky-select-native";
  const TRIGGER_CLASS = "ky-select-trigger";
  const VALUE_CLASS = "ky-select-value";
  const POPUP_CLASS = "ky-select-popup";
  const ITEM_CLASS = "ky-select-item";
  const SELECTED_CLASS = "is-selected";
  const OPEN_CLASS = "is-open";

  function enhance(select) {
    if (!select || select.dataset.kyEnhanced === "1") return;
    const wrap = select.closest("." + SELECT_CLASS);
    if (!wrap) return;
    select.dataset.kyEnhanced = "1";
    select.classList.add(NATIVE_CLASS);
    select.setAttribute("tabindex", "-1");
    select.setAttribute("aria-hidden", "true");

    const trigger = document.createElement("button");
    trigger.type = "button";
    trigger.className = TRIGGER_CLASS;
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");
    const value = document.createElement("span");
    value.className = VALUE_CLASS;
    trigger.append(value);

    const popup = document.createElement("div");
    popup.className = POPUP_CLASS;
    popup.setAttribute("role", "listbox");
    popup.hidden = true;

    wrap.append(trigger, popup);

    function sync() {
      const option = select.options[select.selectedIndex];
      value.textContent = option ? option.textContent : "";
      trigger.disabled = select.disabled;
      trigger.title = option ? option.textContent : "";
    }

    function build() {
      popup.textContent = "";
      for (const option of Array.from(select.options)) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = ITEM_CLASS;
        item.setAttribute("role", "option");
        item.textContent = option.textContent;
        item.dataset.value = option.value;
        if (option.value === select.value) {
          item.classList.add(SELECTED_CLASS);
          item.setAttribute("aria-selected", "true");
        }
        item.addEventListener("click", (event) => {
          event.stopPropagation();
          choose(option.value);
        });
        popup.append(item);
      }
    }

    function outside(event) {
      if (!wrap.contains(event.target)) close();
    }

    function open() {
      build();
      popup.hidden = false;
      wrap.classList.add(OPEN_CLASS);
      trigger.setAttribute("aria-expanded", "true");
      document.addEventListener("pointerdown", outside, true);
      const selected = popup.querySelector("." + SELECTED_CLASS);
      if (selected && typeof selected.scrollIntoView === "function") selected.scrollIntoView({ block: "nearest" });
    }

    function close() {
      popup.hidden = true;
      wrap.classList.remove(OPEN_CLASS);
      trigger.setAttribute("aria-expanded", "false");
      document.removeEventListener("pointerdown", outside, true);
    }

    function choose(next) {
      select.value = next;
      select.dispatchEvent(new Event("change", { bubbles: true }));
      sync();
      close();
      trigger.focus();
    }

    function move(direction) {
      const options = Array.from(select.options);
      if (!options.length) return;
      let index = select.selectedIndex;
      if (index < 0) index = 0;
      else index = Math.max(0, Math.min(options.length - 1, index + direction));
      choose(options[index].value);
    }

    trigger.addEventListener("click", () => (popup.hidden ? open() : close()));
    trigger.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        move(event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        if (popup.hidden) open();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    });
    select.addEventListener("change", sync);
    sync();
  }

  function enhanceAll(scope) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host) return 0;
    let count = 0;
    host.querySelectorAll("." + SELECT_CLASS + " > select").forEach((select) => {
      if (select.dataset.kyEnhanced !== "1") count += 1;
      enhance(select);
    });
    return count;
  }

  if (typeof document !== "undefined") {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => {
      enhanceAll();
      enhanceAllTabs();
    });
    else {
      enhanceAll();
      enhanceAllTabs();
    }
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      document.querySelectorAll("." + SELECT_CLASS + "." + OPEN_CLASS + " ." + TRIGGER_CLASS).forEach((trigger) => trigger.click());
    });
  }

  /* ------------------------------------------------------------------ tabs */

  function enhanceTabs(tabs) {
    if (!tabs || tabs.dataset.tzTabs === "1") return;
    const items = Array.from(tabs.querySelectorAll(".ky-tab"));
    if (items.length < 2) return;
    tabs.dataset.tzTabs = "1";
    tabs.classList.add("has-thumb");

    const thumb = document.createElement("span");
    thumb.className = "ky-tab-thumb";
    thumb.setAttribute("aria-hidden", "true");
    tabs.prepend(thumb);

    function activeItem() {
      return items.find((item) => item.classList.contains("is-active")) || items[0];
    }

    function place() {
      if (tabs.offsetParent === null) return;
      const active = activeItem();
      // offsetLeft/offsetWidth are already relative to the positioned .ky-tabs container and do not
      // depend on the parent scroll/zoom, unlike a raw getBoundingClientRect diff.
      if (!active.offsetWidth) return;
      thumb.style.left = active.offsetLeft + "px";
      thumb.style.width = active.offsetWidth + "px";
      // Add the transition class one frame later so the first placement jumps into place instead of
      // animating from the hidden (0 width) state.
      if (!tabs.classList.contains("is-ready") && !tabs.dataset.readyQueued) {
        tabs.dataset.readyQueued = "1";
        requestAnimationFrame(() => tabs.classList.add("is-ready"));
      }
    }

    let frame = 0;
    function schedule() {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        place();
      });
    }

    for (const item of items) {
      new MutationObserver(schedule).observe(item, { attributes: true, attributeFilter: ["class"] });
    }
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(schedule).observe(tabs);
    // Overlays start hidden (offsetParent null); place the plate when the tabs become visible.
    if (typeof IntersectionObserver !== "undefined") {
      new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) schedule();
      }).observe(tabs);
    }
    window.addEventListener("resize", schedule);
    window.addEventListener("load", schedule);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(schedule).catch(() => {});
    // Two frames: the first leaves the browser time to finish the flex layout, the second measures it.
    requestAnimationFrame(() => requestAnimationFrame(schedule));
    setTimeout(schedule, 300);
  }

  function enhanceAllTabs(scope) {
    const host = scope || (typeof document !== "undefined" ? document : null);
    if (!host) return 0;
    host.querySelectorAll(".ky-tabs").forEach(enhanceTabs);
    return host.querySelectorAll(".ky-tabs.has-thumb").length;
  }

  root.KySelect = { enhance, enhanceAll, version: "1.0.0" };
  root.KyTabs = { enhance: enhanceTabs, enhanceAll: enhanceAllTabs, version: "1.0.0" };
  if (typeof module === "object" && module.exports) module.exports = root.KySelect;
})(typeof globalThis !== "undefined" ? globalThis : this);
