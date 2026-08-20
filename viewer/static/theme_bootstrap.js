(() => {
  try {
    const stored = localStorage.getItem("tau2-inspector-theme");
    const saved = stored === "dark" || stored === "light" ? stored : null;
    const preferred = matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
    document.documentElement.dataset.theme = saved || preferred;
  } catch {
    document.documentElement.dataset.theme = "light";
  }
})();
