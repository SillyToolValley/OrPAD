// Applies the Run GUI (orchestration) window's body class BEFORE the toolbar,
// editor, and sidebar chrome are parsed — so the first painted frame is already
// the Run GUI layout, not the full OrPAD editor.
//
// Without this, `body.orchestration-window` is only added when the 18 MB bundled
// renderer.js runs at the end of <body>. The browser paints the default OrPAD
// chrome while that bundle is still compiling, so users saw the editor window
// flash up and then collapse into the Run GUI on every launch.
//
// The bundle still re-adds the same class (idempotent) — this only wins the race
// for the first frame. Placed as the FIRST child of <body>, so document.body
// already exists but none of the chrome below it has been parsed yet. CSP is
// script-src 'self', so this must stay an external classic script (no inline).
(function () {
  try {
    var params = new URLSearchParams(window.location.search || '');
    if (params.get('mode') === 'orchestration') {
      (document.body || document.documentElement).classList.add('orchestration-window');
    }
  } catch (err) { /* a malformed URL must never block startup */ }
})();
