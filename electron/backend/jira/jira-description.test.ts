import { describe, expect, it } from "vitest";
import { marked } from "marked";
import { jiraDescriptionMarkdown } from "./jira-description.js";

const text = (value: string, marks?: unknown[]) => ({ type: "text", text: value, marks });
const paragraph = (...content: unknown[]) => ({ type: "paragraph", content });
const doc = (...content: unknown[]) => ({ type: "doc", content });
const html = (value: unknown) => marked.parse(jiraDescriptionMarkdown(value)) as string;

describe("Jira rich descriptions", () => {
  it("renders semantic ADF headings, whitespace marks and nested numbered lists", () => {
    const value = doc(
      { type: "heading", attrs: { level: 2 }, content: [text("Plan")] },
      paragraph(text(" bold", [{ type: "strong" }]), text(" phrase ", [{ type: "strong" }]), text("after")),
      {
        type: "orderedList",
        attrs: { order: 10 },
        content: [
          {
            type: "listItem",
            content: [
              paragraph(text("parent")),
              { type: "bulletList", content: [{ type: "listItem", content: [paragraph(text("child"))] }] },
              paragraph(text("continuation")),
            ],
          },
        ],
      },
    );
    const rendered = html(value);
    expect(rendered).toContain("<h2>Plan</h2>");
    expect(rendered).toContain("<strong>bold phrase</strong> after");
    expect(rendered).toMatch(
      /<ol start="10">[\s\S]*<li>[\s\S]*parent[\s\S]*<ul>[\s\S]*child[\s\S]*<\/ul>[\s\S]*continuation[\s\S]*<\/li>/,
    );
  });

  it("keeps ADF literal Markdown/HTML inert and validates link destinations", () => {
    const value = doc(
      paragraph(
        text("# literal\n![pixel](https://tracker.invalid/x) <img src=x> &lt;b&gt; *literal* "),
        // eslint-disable-next-line no-script-url -- malicious Jira link regression fixture.
        text("unsafe", [{ type: "link", attrs: { href: "javascript:alert(1)" } }]),
        text("secret", [{ type: "link", attrs: { href: "https://user:pass@example.com" } }]),
        text("safe", [{ type: "link", attrs: { href: "https://example.com/a(b)?x=1&y=2" } }]),
      ),
    );
    const rendered = html(value);
    expect(rendered).not.toMatch(/<img|<h1|<em|javascript:|user:pass/);
    expect(rendered).toContain("*literal*");
    expect(rendered).toContain("&lt;img src=x&gt;");
    expect(rendered).toContain("&amp;lt;b&amp;gt;");
    expect(rendered).toContain('href="https://example.com/a%28b%29?x=1&amp;y=2"');
  });

  it("preserves backticks in inline and block code, pipes in table cells and media placeholders", () => {
    const value = doc(
      paragraph(text("value`x", [{ type: "code" }])),
      { type: "codeBlock", content: [text("```\n  <tag> *literal*\n```")] },
      {
        type: "table",
        content: [
          {
            type: "tableRow",
            content: [
              { type: "tableHeader", content: [paragraph(text("a|b"))] },
              { type: "tableCell", content: [paragraph(text("value|code", [{ type: "code" }]))] },
            ],
          },
        ],
      },
      { type: "mediaSingle", content: [{ type: "media", attrs: { url: "https://tracker.invalid/x" } }] },
    );
    const rendered = html(value);
    expect(rendered).toContain("<code>value`x</code>");
    expect(rendered).toContain("```\n  &lt;tag&gt; *literal*\n```");
    expect(rendered).toContain("<th>a|b</th>");
    expect(rendered).toContain("<th><code>value|code</code></th>");
    expect(rendered).toContain("[Attachment]");
    expect(rendered).not.toContain("tracker.invalid");
  });

  it("converts explicit DC wiki without activating embedded Markdown images or HTML", () => {
    const value =
      "h2. Plan\n* *first*\n** child\n# numbered\n{quote}quoted{quote}\n" +
      "{code:js}\n```\n<tag> *literal*\n{code}\n" +
      "|| Name || Value ||\n| a | b |\nSee [runbook|https://example.com/a(b)].\n![pixel](https://tracker.invalid/x)";
    const rendered = html(value);
    expect(rendered).toContain("<h2>Plan</h2>");
    expect(rendered).toContain("<strong>first</strong>");
    expect(rendered).toMatch(/<ul>[\s\S]*<ul>[\s\S]*child/);
    expect(rendered).toContain("<blockquote>");
    expect(rendered).toContain("&lt;tag&gt; *literal*");
    expect(rendered).toContain("<table>");
    expect(rendered).toContain('href="https://example.com/a%28b%29"');
    expect(rendered).not.toContain("<img");
    expect(jiraDescriptionMarkdown("ordinary text # not a heading")).toBe("");
    expect(jiraDescriptionMarkdown("h2. Heading\n<p>HTML</p>")).toBe("");
    expect(html("_italic_")).toContain("<em>italic</em>");
    expect(html("[https://example.com]")).toContain('<a href="https://example.com/">');
  });

  it("keeps wiki emphasis characters inside bare links and words", () => {
    const url = "https://app.example.test/search?ftq=primary_user_set&ft=SYSTEM_CALL_REQUEST&q=a+b*c*d";
    const rendered = html(`*Link:* ${url}. Keep snake_case_name and _real italic_.`);
    expect(rendered).toContain(`href="${url.replaceAll("&", "&amp;")}"`);
    expect(rendered).toContain("<strong>Link:</strong>");
    expect(rendered).toContain("snake_case_name");
    expect(rendered).toContain("<em>real italic</em>");
    expect(rendered.match(/<em>/g)).toHaveLength(1);
  });

  it("bounds giant text nodes, broad trees and deep trees without unbalanced truncation", () => {
    expect(jiraDescriptionMarkdown(doc(paragraph(text("x".repeat(100_000))))).length).toBeLessThanOrEqual(32_000);
    expect(
      jiraDescriptionMarkdown(doc(...Array.from({ length: 10_000 }, () => paragraph(text("x"))))).length,
    ).toBeLessThanOrEqual(32_000);
    let deep: unknown = text("too deep");
    for (let i = 0; i < 100; i++) deep = { type: "paragraph", content: [deep] };
    expect(jiraDescriptionMarkdown(deep)).toBe("");
  });
});
