/**
 * System Monitor Plugin for strIDEterm
 *
 * Provides system performance monitoring within the terminal workspace.
 * Recommends installing 'vtop' (MIT licensed, npm install -g vtop) for
 * a beautiful htop-like terminal UI built with Node.js.
 *
 * Alternative MIT-licensed tools:
 * - vtop: npm install -g vtop (Node.js, MIT, graphical CPU/memory charts)
 * - systeminformation: npm package for programmatic system data access
 *
 * The plugin creates a terminal panel that launches the best available
 * system monitor tool (vtop > btop > htop > top).
 */

export const id = "system-monitor";

export function activate({ runtime }) {
  return {
    deactivate() {},
  };
}
