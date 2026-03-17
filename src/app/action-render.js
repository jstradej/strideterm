import { html } from "lit";

export function renderTabPickerDropdown(templates = []) {
  return html`
    ${templates.map((template) => html`
      <button
        type="button"
        class="tab-picker-dropdown__item"
        data-action="quick-add-template-tab"
        data-title=${`${template.icon || ""} ${template.title || "Shell"}`.trim()}
        data-command=${template.command || ""}
      >${template.icon || ""} ${template.title || "Shell"}</button>
    `)}
    <button type="button" class="tab-picker-dropdown__item" data-action="quick-add-tab">+ Custom</button>
  `;
}
