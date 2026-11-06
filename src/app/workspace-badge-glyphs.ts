// Filled shapes: the index sits on the badge's top-left corner and the status dot on its bottom-right, so a glyph has
// to read from its middle. A text glyph would depend on the platform's fonts. Drawn on a 24×24 viewBox by the tree card
// and by the activity rows of Recently worked and Running.
export const BADGE_GLYPHS = {
  review: [
    "M12 5C7.2 5 3.4 8 1.5 12c1.9 4 5.7 7 10.5 7s8.6-3 10.5-7C20.6 8 16.8 5 12 5zm0 2.8a4.2 4.2 0 1 0 0 8.4 4.2 4.2 0 1 0 0-8.4z",
    "M12 9.9a2.1 2.1 0 1 0 0 4.2 2.1 2.1 0 1 0 0-4.2z",
  ],
  // Tabler Icons "code-circle-2" (filled), MIT License, Copyright (c) 2020-2024 Paweł Kuna.
  "new-branch": [
    "M17 3.34a10 10 0 1 1 -15 8.66l.005 -.324a10 10 0 0 1 14.995 -8.336m-3.658 5.22a1 1 0 0 0 -1.282 .598l-2 5.5a1 1 0 0 0 1.88 .684l2 -5.5a1 1 0 0 0 -.598 -1.282m-4.135 1.233a1 1 0 0 0 -1.414 0l-1.5 1.5a1 1 0 0 0 0 1.414l1.5 1.5a1 1 0 0 0 1.414 0l.083 -.094a1 1 0 0 0 -.083 -1.32l-.792 -.793l.792 -.793a1 1 0 0 0 0 -1.414m7 0a1 1 0 0 0 -1.414 0l-.083 .094a1 1 0 0 0 .083 1.32l.792 .793l-.792 .793a1 1 0 0 0 1.414 1.414l1.5 -1.5a1 1 0 0 0 0 -1.414z",
  ],
  // A ticket: a new branch started from a Jira issue.
  "jira-branch": [
    "M4 5h16a2 2 0 0 1 2 2v2.5a2.5 2.5 0 0 0 0 5V17a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-2.5a2.5 2.5 0 0 0 0-5V7a2 2 0 0 1 2-2zm4.5 4a1 1 0 0 0 0 2h7a1 1 0 0 0 0-2h-7zm0 4a1 1 0 0 0 0 2h4a1 1 0 0 0 0-2h-4z",
  ],
} as const;

export type WorkspaceBadgeGlyph = keyof typeof BADGE_GLYPHS;
