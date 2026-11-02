// Applies the saved theme before the first paint, so dark mode doesn't flash light while the app loads.
// Mirrors useTheme() in src/lib/hooks.ts; the app takes over once it starts.
try {
  var theme = JSON.parse(localStorage.getItem('salt-shaker.theme') || '"system"')
  if (theme === 'dark' || (theme !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark')
  }
} catch {
  // storage blocked: the app applies the system theme on start
}
