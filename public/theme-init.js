// Runs before first paint so the page never flashes the wrong theme.
(function () {
  var dark = false;
  try {
    var pref = localStorage.getItem('scratchasm.theme') || 'auto';
    dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  } catch (e) { /* storage blocked: fall back to light */ }
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
})();
