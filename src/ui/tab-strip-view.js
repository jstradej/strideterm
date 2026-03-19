import { html, render } from "lit";
import { repeat } from "lit/directives/repeat.js";

function tabTemplate(tab) {
  return html`
    <button
      class=${`tab ${tab.active ? "tab--active" : ""} ${tab.grouped ? "tab--grouped" : ""} ${tab.attention ? "tab--attention" : ""} ${tab.attentionFresh ? "tab--attention-fresh" : ""} tab--${tab.tone}`}
      data-action="select-tab"
      data-view-id=${tab.id}
      data-persistent=${tab.persistent ? "true" : "false"}
      draggable=${tab.persistent ? "true" : "false"}
      title=${tab.titleTooltip}
    >
      <span>${tab.title}</span>
      <small>${tab.status}</small>
      ${tab.attention ? html`<span class="tab__attention" title=${tab.attentionTooltip}>\u{1F514}</span>` : null}
      ${tab.persistent ? html`<span class="tab__rename" data-action="rename-tab" data-view-id=${tab.id} title="Rename tab">\u270E</span>` : null}
      ${tab.closable !== false
        ? html`<span class="tab__close" data-action="close-tab" data-view-id=${tab.id} title="Close tab">\u00D7</span>`
        : null}
    </button>
  `;
}

export function renderTabStrip(container, tabs) {
  render(html`${repeat(tabs, (tab) => tab.id, tabTemplate)}`, container);
}
