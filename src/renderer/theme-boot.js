// Restores the saved theme's CSS variables synchronously in <head>, before the
// first paint. The theme normally comes from the bundled renderer (applyThemeColors
// in themes.js), but that bundle loads at the end of <body> and applies the theme
// after module evaluation — far too late to beat the first frame, so users on a
// non-default theme saw a default-theme flash on every launch.
//
// themes.js caches the resolved palette to localStorage ('orpad-theme-boot') on
// every theme apply; this script only replays that cache. No cache (fresh install,
// first launch after update) → do nothing: base.css :root defaults are the correct
// default-theme fallback. CSP is script-src 'self', so this must stay an external
// classic script (no inline, no modules). Runs in <head>: only document.documentElement
// exists — never touch the body DOM here.
(function () {
  try {
    var raw = localStorage.getItem('orpad-theme-boot');
    if (!raw) return;
    var payload = JSON.parse(raw);
    if (!payload || typeof payload !== 'object') return;
    var vars = payload.vars;
    var root = document.documentElement;
    if (vars && typeof vars === 'object') {
      for (var key in vars) {
        if (Object.prototype.hasOwnProperty.call(vars, key) &&
            key.indexOf('--') === 0 && typeof vars[key] === 'string') {
          root.style.setProperty(key, vars[key]);
        }
      }
    }
    if (typeof payload.bg === 'string' && payload.bg) {
      root.style.background = payload.bg;
    }
    if (payload.type === 'dark' || payload.type === 'light') {
      root.style.colorScheme = payload.type;
    }
    // Marker for tests: proves the pre-paint boot path ran (the late bundle apply
    // sets the same inline vars, so the vars alone can't distinguish the two).
    root.dataset.orpadThemeBoot = typeof payload.bg === 'string' ? payload.bg : '1';
  } catch (err) { /* malformed cache must never block startup */ }
})();
