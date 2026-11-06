import { describe, expect, test } from "vitest";
import { isMarkdownFile, renderMarkdown } from "./markdown-renderer.js";

function parseHtml(markdown: string): HTMLDivElement {
  const host = document.createElement("div");
  host.innerHTML = renderMarkdown(markdown);
  return host;
}

describe("markdown renderer", () => {
  test("renders common Markdown and GFM tables", () => {
    const rendered = parseHtml("# Heading\n\n**bold** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |");

    expect(rendered.querySelector("h1")?.textContent).toBe("Heading");
    expect(rendered.querySelector("strong")?.textContent).toBe("bold");
    expect(rendered.querySelector("code")?.textContent).toBe("code");
    expect(rendered.querySelector("table")?.textContent).toContain("1");
  });

  test("escapes raw HTML and refuses unsafe links", () => {
    const rendered = parseHtml('<script>alert("x")</script>\n\n[run](javascript:alert%281%29)');

    expect(rendered.querySelector("script")).toBeNull();
    expect(rendered.textContent).toContain('<script>alert("x")</script>');
    expect(rendered.querySelector("a")).toBeNull();
    expect(rendered.textContent).toContain("run");
  });

  test("opens safe web links with safe window attributes", () => {
    const rendered = parseHtml("[docs](https://example.com/docs)");
    const link = rendered.querySelector("a");

    expect(link?.getAttribute("href")).toBe("https://example.com/docs");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  test("loads only web images and describes relative images without requesting them", () => {
    const rendered = parseHtml("![remote](https://example.com/image.png)\n\n![local](./diagram.png)");
    const image = rendered.querySelector("img");
    const placeholder = rendered.querySelector(".markdown-image-unavailable");

    expect(image?.getAttribute("src")).toBe("https://example.com/image.png");
    expect(image?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(image?.getAttribute("loading")).toBe("lazy");
    expect(placeholder?.textContent).toContain("local");
    expect(placeholder?.getAttribute("title")).toContain("./diagram.png");
    expect(rendered.querySelector('img[src="./diagram.png"]')).toBeNull();
  });

  test("makes heading fragments local and unique without assigning global ids", () => {
    const rendered = parseHtml("# Quick Start\n\n## Quick Start\n\n[Next](#quick-start-1)");

    expect(rendered.querySelectorAll("[data-markdown-anchor='quick-start']")).toHaveLength(1);
    expect(rendered.querySelectorAll("[data-markdown-anchor='quick-start-1']")).toHaveLength(1);
    expect(rendered.querySelectorAll("[id]")).toHaveLength(0);
    expect(rendered.querySelector("a")?.getAttribute("href")).toBe("#quick-start-1");
  });

  test("recognizes Markdown file extensions only", () => {
    expect(isMarkdownFile("README.md")).toBe(true);
    expect(isMarkdownFile("guide.MARKDOWN")).toBe(true);
    expect(isMarkdownFile("markdown.md.txt")).toBe(false);
    expect(isMarkdownFile("readme.txt")).toBe(false);
  });
});
