import { describe, expect, test } from "vitest";
import { parseCommandTemplate, substituteCommandArg } from "./command-template.js";

describe("parseCommandTemplate", () => {
  test("returns null for empty input", () => {
    expect(parseCommandTemplate("")).toBeNull();
    expect(parseCommandTemplate("   ")).toBeNull();
    expect(parseCommandTemplate("\t  \t")).toBeNull();
  });

  test("returns null for non-string input", () => {
    expect(parseCommandTemplate(null as unknown as string)).toBeNull();
    expect(parseCommandTemplate(undefined as unknown as string)).toBeNull();
    expect(parseCommandTemplate(42 as unknown as string)).toBeNull();
  });

  test("splits a simple command", () => {
    expect(parseCommandTemplate("code -g foo")).toEqual({
      binary: "code",
      args: ["-g", "foo"],
    });
  });

  test("collapses runs of whitespace", () => {
    expect(parseCommandTemplate("code   -g    foo")).toEqual({
      binary: "code",
      args: ["-g", "foo"],
    });
  });

  test("handles tabs as separators", () => {
    expect(parseCommandTemplate("code\t-g\tfoo")).toEqual({
      binary: "code",
      args: ["-g", "foo"],
    });
  });

  test("preserves placeholders verbatim", () => {
    expect(parseCommandTemplate("code -g ${path}:${line}:${column}")).toEqual({
      binary: "code",
      args: ["-g", "${path}:${line}:${column}"],
    });
  });

  test("supports double-quoted args with spaces", () => {
    expect(parseCommandTemplate('"C:\\Program Files\\App\\bin.exe" -g ${path}')).toEqual({
      binary: "C:\\Program Files\\App\\bin.exe",
      args: ["-g", "${path}"],
    });
  });

  test("supports single-quoted args with spaces", () => {
    expect(parseCommandTemplate("'/usr/local/My App/bin' -g ${path}")).toEqual({
      binary: "/usr/local/My App/bin",
      args: ["-g", "${path}"],
    });
  });

  test("nested unmatched quote types pass through inside the active quote", () => {
    expect(parseCommandTemplate("app \"arg with 'apostrophe' inside\"")).toEqual({
      binary: "app",
      args: ["arg with 'apostrophe' inside"],
    });
  });

  test("returns null for unterminated double quote", () => {
    expect(parseCommandTemplate('app "broken')).toBeNull();
  });

  test("returns null for unterminated single quote", () => {
    expect(parseCommandTemplate("app 'broken")).toBeNull();
  });

  test("preserves empty quoted args", () => {
    expect(parseCommandTemplate('app "" -x')).toEqual({
      binary: "app",
      args: ["", "-x"],
    });
  });

  test("concatenates adjacent quoted and unquoted segments", () => {
    expect(parseCommandTemplate('app --flag="value with spaces"')).toEqual({
      binary: "app",
      args: ["--flag=value with spaces"],
    });
  });

  test("concatenates two adjacent quotes", () => {
    expect(parseCommandTemplate(`app "one""two"`)).toEqual({
      binary: "app",
      args: ["onetwo"],
    });
  });

  test("does NOT interpret shell metacharacters", () => {
    expect(parseCommandTemplate("rm -rf /; echo pwned")).toEqual({
      binary: "rm",
      // The shell would split on `;` and run a second command — we deliberately
      // pass it through as a literal so spawn (with shell:false) treats it as
      // an arg, never executes it.
      args: ["-rf", "/;", "echo", "pwned"],
    });
  });

  test("does NOT interpret backticks", () => {
    expect(parseCommandTemplate("app `whoami`")).toEqual({
      binary: "app",
      args: ["`whoami`"],
    });
  });

  test("does NOT interpret $variable expansion outside placeholders", () => {
    // ${path}/${line}/${column} are special; everything else stays literal
    // so a hostile template can't drag in environment variables.
    expect(parseCommandTemplate("app $HOME")).toEqual({
      binary: "app",
      args: ["$HOME"],
    });
  });

  test("binary alone", () => {
    expect(parseCommandTemplate("nvim")).toEqual({ binary: "nvim", args: [] });
  });

  test("single arg with mixed quoting", () => {
    expect(parseCommandTemplate(`app foo"bar"baz`)).toEqual({
      binary: "app",
      args: ["foobarbaz"],
    });
  });
});

describe("substituteCommandArg", () => {
  test("substitutes path, line, column", () => {
    expect(substituteCommandArg("${path}:${line}:${column}", "/foo.ts", 42, 5)).toBe("/foo.ts:42:5");
  });

  test("substitutes only path when line/column are missing", () => {
    expect(substituteCommandArg("${path}:${line}:${column}", "/foo.ts", 0, 0)).toBe("/foo.ts::");
  });

  test("substitutes only path/line when column is missing", () => {
    expect(substituteCommandArg("${path}:${line}", "/foo.ts", 42, 0)).toBe("/foo.ts:42");
  });

  test("preserves args without placeholders", () => {
    expect(substituteCommandArg("-g", "/foo.ts", 42, 5)).toBe("-g");
  });

  test("substitutes multiple occurrences of the same placeholder", () => {
    expect(substituteCommandArg("${path}-${path}", "/foo.ts", 0, 0)).toBe("/foo.ts-/foo.ts");
  });

  test("does not interpret regex metacharacters in path", () => {
    // Path with $1 / regex stuff would normally be a footgun for naive
    // string.replace with capture groups; we use the function form to be safe.
    expect(substituteCommandArg("${path}", "/foo$1.ts", 0, 0)).toBe("/foo$1.ts");
  });

  test("path with diacritics passes through verbatim", () => {
    expect(substituteCommandArg("${path}", "/Users/jaroš/Příklad.txt", 0, 0)).toBe("/Users/jaroš/Příklad.txt");
  });

  test("Windows path with backslashes survives substitution", () => {
    expect(substituteCommandArg("${path}", "C:\\Users\\foo\\bar.txt", 0, 0)).toBe("C:\\Users\\foo\\bar.txt");
  });
});
