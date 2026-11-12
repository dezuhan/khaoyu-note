// Applies the saved (or system) theme on service pages that have no own theme toggle.
import { SERVICE_LEGACY_KEYS, THEME_KEY, initTheme } from "./theme.js";

initTheme({
  key: THEME_KEY,
  legacyKeys: SERVICE_LEGACY_KEYS,
  fallback: "system",
});
