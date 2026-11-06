const FOLDER_ICONS: Record<string, string> = {
  node_modules: "📦",
  ".git": "🔒",
  src: "📁",
  dist: "📤",
  build: "📤",
};

const EXT_ICONS: Record<string, string> = {
  ".js": "⬢",
  ".mjs": "⬢",
  ".ts": "◇",
  ".vue": "◈",
  ".json": "{ }",
  ".md": "❖",
  ".css": "◎",
  ".html": "◆",
  ".py": "◉",
  ".go": "◈",
  ".rs": "⬣",
  ".java": "◆",
  ".sh": "$_",
  ".yml": "⚙",
  ".yaml": "⚙",
  ".png": "▣",
  ".jpg": "▣",
  ".jpeg": "▣",
  ".gif": "▣",
  ".svg": "▣",
  ".lock": "🔒",
};

export function iconFor(entry: { kind: string; name: string; extension?: string }): string {
  if (entry.kind === "directory") return FOLDER_ICONS[entry.name] || "📁";
  return EXT_ICONS[entry.extension as string] || "📄";
}
