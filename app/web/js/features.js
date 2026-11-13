// Release 0.36.0 is shipping as a local-first build. Backend/server UI stays in the source tree but
// is dormant unless a development build explicitly opts in before boot.
export const BACKEND_ENABLED =
  typeof window !== "undefined" && window.KY_BACKEND_ENABLED === true;
