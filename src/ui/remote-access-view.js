import { nothing, render } from "lit";

export function renderRemoteAccessMarkup(container, markup) {
  render(markup || nothing, container);
}
