import { html, render } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";

export function renderRemoteAccessMarkup(container, markup) {
  render(html`${unsafeHTML(markup || "")}`, container);
}
