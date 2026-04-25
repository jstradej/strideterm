// Map a file name (or extension) to a Monaco language id. Mirrors the same
// table used backend-side for diff language hints.

const LANG_BY_EXT = {
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "javascript",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".vue": "html",
  ".json": "json",
  ".md": "markdown",
  ".markdown": "markdown",
  ".html": "html",
  ".htm": "html",
  ".css": "css",
  ".scss": "scss",
  ".less": "less",
  ".py": "python",
  ".rb": "ruby",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".cs": "csharp",
  ".cpp": "cpp",
  ".cc": "cpp",
  ".c": "c",
  ".h": "cpp",
  ".php": "php",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".ps1": "powershell",
  ".yml": "yaml",
  ".yaml": "yaml",
  ".xml": "xml",
  ".toml": "ini",
  ".ini": "ini",
  ".sql": "sql",
  ".dockerfile": "dockerfile",
};

const SPECIAL_FILENAMES = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  cmakelists: "cmake",
};

export function guessLanguageFromPath(nameOrPath) {
  if (!nameOrPath) return "plaintext";
  const name = String(nameOrPath).split(/[\\/]/).pop().toLowerCase();
  const special = SPECIAL_FILENAMES[name];
  if (special) return special;
  const dot = name.lastIndexOf(".");
  if (dot < 0) return "plaintext";
  return LANG_BY_EXT[name.slice(dot)] || "plaintext";
}
