import { describe, expect, test } from "vitest";
import { detectPaths } from "./path-detector.js";

/**
 * Path detection has to walk a tightrope: be liberal enough to catch the
 * paths users actually want to click (compiler output, log lines, custom
 * scripts, error traces) while filtering enough false positives that the
 * terminal doesn't underline every fraction (`1/2`) or stack frame.
 *
 * The rule of thumb encoded here: a candidate must either start with an
 * explicit path anchor (`/`, `\\`, `~/`, `./`, `../`, drive letter) OR end
 * with a `:line[:col]` / `(line[,col])` suffix that follows a filename
 * with an extension. Pure-digit bodies are rejected to keep ratios out.
 *
 * Validation that the file actually exists on disk happens at click time
 * via an IPC call — that's where ambiguous detections get a final filter.
 */

describe("detectPaths", () => {
  describe("Unix absolute paths", () => {
    test("detects a plain absolute path", () => {
      const r = detectPaths("see /usr/local/bin/node for the binary");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "/usr/local/bin/node", start: 4, length: 19 });
    });

    test("detects a single-segment absolute path with extension", () => {
      const r = detectPaths("config: /etc/hosts");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/etc/hosts");
    });

    test("detects /etc/passwd (no extension)", () => {
      const r = detectPaths("read /etc/passwd");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/etc/passwd");
    });

    test("does not match a single-segment numeric path /2 (ratio false positive)", () => {
      const r = detectPaths("progress: 1/2 done");
      expect(r).toHaveLength(0);
    });

    test("does not match 1/2/3 (date-like ratio)", () => {
      const r = detectPaths("ratio 1/2/3 is meaningless");
      expect(r).toHaveLength(0);
    });

    test("does not match plain time stamps like 12:34:56", () => {
      const r = detectPaths("at 12:34:56 we logged out");
      expect(r).toHaveLength(0);
    });
  });

  describe("Unix relative paths", () => {
    test("detects ./foo/bar.ts", () => {
      const r = detectPaths("edit ./src/components/App.vue now");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("./src/components/App.vue");
    });

    test("detects ../foo/bar.js", () => {
      const r = detectPaths("from ../shared/utils.js export");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("../shared/utils.js");
    });

    test("does not match foo/bar without leading ./ or ../", () => {
      // Implicit relative paths are too ambiguous (matches "a/b" arguments,
      // ratio 7/14, etc.). They're only matched if accompanied by :line:col.
      const r = detectPaths("look at foo/bar/baz");
      expect(r).toHaveLength(0);
    });
  });

  describe("Home-relative paths", () => {
    test("detects ~/Documents/file.txt", () => {
      const r = detectPaths("config in ~/Documents/notes.md");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("~/Documents/notes.md");
    });

    test("does not match a bare ~", () => {
      const r = detectPaths("see ~ for home");
      expect(r).toHaveLength(0);
    });
  });

  describe("Windows absolute paths", () => {
    test("detects C:\\Users\\foo\\bar.txt with backslashes", () => {
      const r = detectPaths("open C:\\Users\\jaromir\\file.txt please");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("C:\\Users\\jaromir\\file.txt");
    });

    test("detects D:/Users/foo/bar.txt with forward slashes (mixed Windows)", () => {
      const r = detectPaths("alt path D:/projects/strideterm/README.md");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("D:/projects/strideterm/README.md");
    });

    test("detects lowercase drive letter c:\\foo", () => {
      const r = detectPaths("legacy c:\\windows\\system32\\drivers");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("c:\\windows\\system32\\drivers");
    });

    test("detects UNC \\\\server\\share\\file", () => {
      const r = detectPaths("net mount \\\\fileserver\\public\\report.docx");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("\\\\fileserver\\public\\report.docx");
    });

    test("does not treat a single backslash followed by digits as a path", () => {
      const r = detectPaths("escape \\1 in regex");
      expect(r).toHaveLength(0);
    });
  });

  describe("Diacritics and unicode", () => {
    test("detects path with Czech diacritics (Unix)", () => {
      const r = detectPaths("read /Users/jaroš/Příklad/Doklad.pdf");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/Users/jaroš/Příklad/Doklad.pdf");
    });

    test("detects path with German umlauts (Windows)", () => {
      const r = detectPaths("open C:\\Benutzer\\Müller\\Bürozeit.xlsx");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("C:\\Benutzer\\Müller\\Bürozeit.xlsx");
    });

    test("detects path with CJK characters", () => {
      const r = detectPaths("open /home/用户/文档/笔记.txt");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/home/用户/文档/笔记.txt");
    });

    test("detects path with emoji-style unicode (rare but valid filename)", () => {
      const r = detectPaths("save ./files/résumé-final.pdf");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("./files/résumé-final.pdf");
    });
  });

  describe("Line and column suffixes", () => {
    test("captures :line on Unix path", () => {
      const r = detectPaths("error at /src/foo.ts:42 something");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "/src/foo.ts", line: 42, column: undefined });
    });

    test("captures :line:col on Unix path", () => {
      const r = detectPaths("/src/foo.ts:42:5");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "/src/foo.ts", line: 42, column: 5 });
    });

    test("captures :line:col on Windows path with forward slashes", () => {
      const r = detectPaths("at C:/proj/src/main.cs:120:8 (warning)");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "C:/proj/src/main.cs", line: 120, column: 8 });
    });

    test("captures (line,col) suffix", () => {
      const r = detectPaths("error in ./src/foo.ts(42,5) — fix it");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "./src/foo.ts", line: 42, column: 5 });
    });

    test("captures (line) suffix without column", () => {
      const r = detectPaths("see ./foo.ts(99)");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "./foo.ts", line: 99, column: undefined });
    });

    test("detects implicit relative filename with :line:col (compiler output)", () => {
      // Without the line:col suffix this would be too ambiguous, but
      // `name.ext:42:5` is a strong signal of a compiler/linter reference.
      const r = detectPaths("src/foo.ts:42:5: error TS2304");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "src/foo.ts", line: 42, column: 5 });
    });

    test("detects implicit relative filename with deep dirs and :line:col", () => {
      const r = detectPaths("at packages/web/src/index.tsx:10:3");
      expect(r).toHaveLength(1);
      expect(r[0]).toMatchObject({ path: "packages/web/src/index.tsx", line: 10, column: 3 });
    });

    test("does not match bare filename.ext without line:col suffix", () => {
      // A bare "foo.ts" is too ambiguous on its own; we only match when
      // the user has given us a strong signal (compiler-format suffix).
      const r = detectPaths("look at foo.ts please");
      expect(r).toHaveLength(0);
    });

    test("does not match digits-only path with :digit suffix as a path", () => {
      const r = detectPaths("ratio 1/2:3 is not a path");
      expect(r).toHaveLength(0);
    });
  });

  describe("Multiple matches in one line", () => {
    test("finds two paths", () => {
      const r = detectPaths("compare /etc/hosts and /etc/services");
      expect(r).toHaveLength(2);
      expect(r[0].path).toBe("/etc/hosts");
      expect(r[1].path).toBe("/etc/services");
    });

    test("finds path and compiler-format reference", () => {
      const r = detectPaths("see /src/index.ts and helper.ts:42");
      expect(r.map((m) => m.path)).toEqual(["/src/index.ts", "helper.ts"]);
      expect(r[1].line).toBe(42);
    });
  });

  describe("Trailing punctuation", () => {
    test("strips trailing period from /foo/bar.", () => {
      const r = detectPaths("see /usr/local/bin.");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/usr/local/bin");
    });

    test("strips trailing comma from /foo/bar,", () => {
      const r = detectPaths("paths /foo/a, /foo/b");
      expect(r).toHaveLength(2);
      expect(r[0].path).toBe("/foo/a");
      expect(r[1].path).toBe("/foo/b");
    });

    test("strips trailing semicolon from /foo/bar;", () => {
      const r = detectPaths("export PATH=/usr/local/bin;");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/usr/local/bin");
    });

    test("strips trailing closing paren but keeps inner extension dot", () => {
      const r = detectPaths("see (/usr/local/bin/foo.sh)");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/usr/local/bin/foo.sh");
    });

    test("does not strip trailing slash (it's a directory marker)", () => {
      const r = detectPaths("cd /usr/local/");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/usr/local/");
    });

    test("strips trailing question mark", () => {
      const r = detectPaths("does /foo/bar.txt exist?");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/foo/bar.txt");
    });
  });

  describe("URLs are NOT detected as paths", () => {
    test("does not match http://example.com/path", () => {
      const r = detectPaths("see http://example.com/foo/bar");
      expect(r).toHaveLength(0);
    });

    test("does not match https://example.com/path", () => {
      const r = detectPaths("see https://example.com/foo/bar.html");
      expect(r).toHaveLength(0);
    });

    test("does not match file://server/path (different scheme)", () => {
      const r = detectPaths("file://server/share/foo.txt");
      expect(r).toHaveLength(0);
    });
  });

  describe("Edge cases", () => {
    test("empty string returns no matches", () => {
      expect(detectPaths("")).toEqual([]);
    });

    test("whitespace-only string returns no matches", () => {
      expect(detectPaths("   \t  ")).toEqual([]);
    });

    test("single slash / alone is not a path", () => {
      const r = detectPaths("just / nothing");
      expect(r).toHaveLength(0);
    });

    test("single dot . alone is not a path", () => {
      const r = detectPaths("just . here");
      expect(r).toHaveLength(0);
    });

    test("./ alone (cwd marker) is not a path", () => {
      const r = detectPaths("see ./ for context");
      expect(r).toHaveLength(0);
    });

    test("paths separated only by whitespace are detected separately", () => {
      const r = detectPaths("/a/b /c/d");
      expect(r).toHaveLength(2);
      expect(r[0].path).toBe("/a/b");
      expect(r[1].path).toBe("/c/d");
    });

    test("path correctly captures start offset", () => {
      const r = detectPaths("xx /foo/bar yy");
      expect(r[0].start).toBe(3);
      expect(r[0].length).toBe(8);
    });

    test("Windows path with embedded spaces is NOT supported (terminal output rarely quotes)", () => {
      // We deliberately stop at whitespace because terminal output almost
      // never escapes spaces. Users with spaced filenames are out of luck
      // on this v1; the regex would otherwise grab too much following text.
      const r = detectPaths("C:\\Program Files\\App\\bin.exe");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("C:\\Program");
    });

    test("path with hyphens and underscores", () => {
      const r = detectPaths("see /opt/my-app_v2/bin/run.sh");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/opt/my-app_v2/bin/run.sh");
    });

    test("path with version number in directory", () => {
      const r = detectPaths("nvm ~/.nvm/versions/node/v22.12.0/bin/node");
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("~/.nvm/versions/node/v22.12.0/bin/node");
    });

    test("captures correct length when line:col follows", () => {
      const input = "err /src/a.ts:42:5 done";
      const r = detectPaths(input);
      expect(r).toHaveLength(1);
      expect(r[0].path).toBe("/src/a.ts");
      expect(r[0].start).toBe(4);
      // Length should cover "/src/a.ts:42:5"
      expect(input.substr(r[0].start, r[0].length)).toBe("/src/a.ts:42:5");
    });
  });
});
