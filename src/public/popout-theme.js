// Diff popout theme. A classic, blocking script so <html data-theme> is set before the first
// paint (the CSP allows no inline scripts). The popout has no app store; Electron points
// prefers-color-scheme at the app theme (nativeTheme.themeSource), "system" included.
{
  const light = window.matchMedia("(prefers-color-scheme: light)");
  const apply = () => {
    if (light.matches) document.documentElement.setAttribute("data-theme", "light");
    else document.documentElement.removeAttribute("data-theme");
  };
  apply();
  light.addEventListener("change", () => {
    apply();
    window.dispatchEvent(new CustomEvent("strideterm:theme-changed"));
  });
}
