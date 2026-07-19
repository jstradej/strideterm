// Shared badge/icon-picker choices and leading-emoji helpers.
//
// WorkspaceDialog uses BADGE_ICONS directly for its dedicated workspace
// `icon` field. EditTabDialog and PanelEditor also use BADGE_ICONS, but for
// them the icon lives as a leading emoji embedded in a free-text title —
// getTitleIcon/setTitleIcon read and rewrite that convention. Extracted from
// three near-identical copies (code review 2026-07 §3.5).

export const BADGE_ICONS = [
  "\u{1F4BB}",
  "\u{2328}",
  "\u{1F527}",
  "⚙",
  "\u{1F6E0}",
  "\u{1F4E6}",
  "\u{1F528}",
  "\u{1F5A5}",
  "\u{1F4C4}",
  "\u{1F4DD}",
  "\u{270F}",
  "\u{2702}",
  "\u{1F33F}",
  "\u{1F500}",
  "\u{1F4CB}",
  "\u{1F433}",
  "\u{1F3D7}",
  "\u{2601}",
  "\u{1F310}",
  "\u{1F50C}",
  "\u{1F4E1}",
  "\u{1F680}",
  "\u{1F5C4}",
  "\u{1F4BE}",
  "\u{1F4CA}",
  "\u{1F4C8}",
  "\u{1F9EA}",
  "✅",
  "\u{1F50D}",
  "\u{1F41B}",
  "\u{1F916}",
  "\u{1F9E0}",
  "✨",
  "⚡",
  "\u{1F3AF}",
  "\u{1F512}",
  "\u{1F511}",
  "\u{1F4C1}",
  "\u{1F4A1}",
  "⭐",
  "\u{1F3A8}",
  "\u{1F525}",
  "\u{1F48E}",
  "\u{2764}",
  "\u{1F4AC}",
  "\u{1F514}",
  "\u{1F6A9}",
  "\u{1F5D1}",
];

const LEADING_ICON_RE = /^([\p{Emoji}\p{S}])\s*/u;

/** Extract the leading emoji/symbol from a title, or "" if there isn't one. */
export function getTitleIcon(title: string): string {
  const match = String(title || "").match(LEADING_ICON_RE);
  return match ? match[1] : "";
}

/** Replace (or add) the leading emoji/symbol on a title with `icon`. */
export function setTitleIcon(title: string, icon: string): string {
  const rest = String(title || "").replace(LEADING_ICON_RE, "");
  return `${icon} ${rest}`.trimEnd();
}
