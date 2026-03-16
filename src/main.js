import "@xterm/xterm/css/xterm.css";
import { createApp } from "./app.js";
import { createTransport } from "./transport.js";

createApp(document.querySelector("#app"), {
  api: createTransport(),
});
