import { mount } from "@vue/test-utils";
import { describe, expect, test, vi } from "vitest";
import { apiKey } from "../../../types/keys.js";
import MarkdownContent from "./MarkdownContent.vue";

describe("MarkdownContent", () => {
  test("opens web links through the transport", async () => {
    const openExternal = vi.fn();
    const wrapper = mount(MarkdownContent, {
      props: { text: "[Docs](https://example.com/docs)" },
      global: { provide: { [apiKey as unknown as string]: { openExternal } } },
    });

    await wrapper.get("a").trigger("click");

    expect(openExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  test("scrolls to a matching heading without changing the window hash", async () => {
    const wrapper = mount(MarkdownContent, {
      props: { text: "[Jump](#details)\n\n## Details" },
    });
    const heading = wrapper.get('[data-markdown-anchor="details"]').element as HTMLElement;
    heading.scrollIntoView = vi.fn();
    const hashBeforeClick = window.location.hash;

    await wrapper.get("a").trigger("click");

    expect(heading.scrollIntoView).toHaveBeenCalledWith({ block: "start", behavior: "smooth" });
    expect(window.location.hash).toBe(hashBeforeClick);
  });
});

const routes = [
  { connectionId: "jira-a", label: "Primary", webUrl: "https://jira.example/jira", issueKeyPrefixes: ["ENG"] },
  { connectionId: "jira-b", label: "Secondary", webUrl: "https://jira.example/jira", issueKeyPrefixes: ["ENG"] },
];

describe("MarkdownContent Jira links", () => {
  test("renders opt-in rich descriptions with semantic blocks, literal escapes and safe code delimiters", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        richText: true,
        text:
          "## Plan\n\n10. parent\n\n    - child\n\n> quoted\n\n| Name | Value |\n| --- | --- |\n| a\\|b | 1 |\n\n" +
          "````\n```\n<tag> *literal*\n````\n\n`` value`x ``\n\n\\*literal\\* \\# heading",
      },
    });
    expect(wrapper.find("h2").text()).toBe("Plan");
    expect(wrapper.find("ol").attributes("start")).toBe("10");
    expect(wrapper.find("ol ul li").text()).toBe("child");
    expect(wrapper.find("blockquote").text()).toBe("quoted");
    expect(wrapper.findAll("tbody td").map((cell) => cell.text())).toEqual(["a|b", "1"]);
    expect(wrapper.find("pre code").element.textContent).toBe("```\n<tag> *literal*\n");
    expect(wrapper.findAll("code")[1].text()).toBe("value`x");
    expect(wrapper.text()).toContain("*literal* # heading");
  });

  test("sanitizes rich descriptions, replaces images, and links Jira keys outside code and links", async () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        richText: true,
        jiraRoutes: routes,
        text:
          '<img src="https://tracker.invalid/x" onerror="alert(1)"><script>alert(1)</script>\n\n' +
          "![pixel](https://tracker.invalid/x) [unsafe](javascript:alert%281%29) [secret](https://user:pass@example.com)\n\n" +
          "[ENG-1](https://example.com) `ENG-2`\n\n```\nENG-3\n```\n\nENG-4",
      },
    });
    expect(wrapper.find("img, script").exists()).toBe(false);
    expect(wrapper.text()).toContain('<img src="https://tracker.invalid/x"');
    expect(wrapper.text()).toContain("[Attachment: pixel]");
    expect(wrapper.findAll("a")).toHaveLength(1);
    expect(wrapper.find("a").attributes()).toMatchObject({
      href: "https://example.com/",
      target: "_blank",
      rel: "noopener noreferrer",
    });
    expect(wrapper.findAll(".jira-issue-chooser")).toHaveLength(1);
    await wrapper.find(".jira-issue-chooser").trigger("click");
    expect(wrapper.findAll("[role=dialog] a")).toHaveLength(2);
    expect(wrapper.find("[role=dialog] a").attributes("href")).toBe("https://jira.example/jira/browse/ENG-4");
  });

  test("keeps context paths and code untouched, and offers a chooser for collisions", async () => {
    const wrapper = mount(MarkdownContent, {
      props: { text: "ENG-12 `ENG-13`\n```\nENG-14\n``` https://jira.example/jira/browse/ENG-15", jiraRoutes: routes },
    });
    expect(wrapper.findAll(".jira-issue-chooser")).toHaveLength(1);
    expect(wrapper.findAll("a")).toHaveLength(0);
    expect(wrapper.text()).toContain("ENG-13");
    expect(wrapper.text()).toContain("ENG-14");
    await wrapper.find(".jira-issue-chooser").trigger("click");
    expect(wrapper.find("[role=dialog]").exists()).toBe(true);
    expect(wrapper.findAll("[role=dialog] a")).toHaveLength(2);
    expect(wrapper.find("[role=dialog] a").attributes("href")).toBe("https://jira.example/jira/browse/ENG-12");
  });

  test("escapes raw HTML and links a unique matching route only", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        text: "<img src=x onerror=alert(1)> OPS-3",
        jiraRoutes: [routes[0], { ...routes[1], issueKeyPrefixes: ["OPS"] }],
      },
    });
    expect(wrapper.find("img").exists()).toBe(false);
    const link = wrapper.find("a");
    expect(link.attributes("href")).toBe("https://jira.example/jira/browse/OPS-3");
    expect(link.attributes("rel")).toBe("noopener noreferrer");
  });

  test("preserves existing Markdown links, raw URLs, and keys inside linked code", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        text: "[ENG-1](https://example.com/path/ENG-1) ` [ENG-2](https://example.com) ` https://jira.example/jira/browse/ENG-3 ENG-4",
        jiraRoutes: [
          { connectionId: "only", label: "Jira", webUrl: "https://jira.example/jira", issueKeyPrefixes: ["ENG"] },
        ],
      },
    });
    const links = wrapper.findAll("a");
    expect(links.map((link) => link.attributes("href"))).toEqual([
      "https://example.com/path/ENG-1",
      "https://jira.example/jira/browse/ENG-3",
      "https://jira.example/jira/browse/ENG-4",
    ]);
    expect(links[1].text()).toBe("https://jira.example/jira/browse/ENG-3");
    expect(wrapper.find("code").text()).toContain("ENG-2");
  });

  test("does not autolink Jira-looking text when an enabled connection has no configured prefix", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        text: "ENG-9",
        jiraRoutes: [
          { connectionId: "direct", label: "Jira", webUrl: "https://jira.example/jira", issueKeyPrefixes: [] },
        ],
      },
    });
    expect(wrapper.find("a").exists()).toBe(false);
    expect(wrapper.text()).toBe("ENG-9");
  });

  test("autolinks safe raw URLs without markdown or Jira-link transforms changing the generated anchor", () => {
    const wrapper = mount(MarkdownContent, {
      props: {
        autolinkUrls: true,
        text: "See https://example.com/a*bold?issue=ENG-1&x=2. <script>alert(1)</script>",
        jiraRoutes: [routes[0]],
      },
    });
    const links = wrapper.findAll("a");
    expect(links).toHaveLength(1);
    expect(links[0].attributes("href")).toBe("https://example.com/a*bold?issue=ENG-1&x=2");
    expect(wrapper.find("script").exists()).toBe(false);
    expect(wrapper.text()).toContain("<script>alert(1)</script>");
  });

  test("stops an autolinked URL at an escaped quote or angle bracket", () => {
    const wrapper = mount(MarkdownContent, {
      props: { autolinkUrls: true, text: 'Open "https://example.com/x" or <https://example.com/y> now' },
    });
    const hrefs = wrapper.findAll("a").map((link) => link.attributes("href"));
    expect(hrefs).toEqual(["https://example.com/x", "https://example.com/y"]);
    expect(wrapper.text()).toContain('"https://example.com/x"');
  });

  test("renders normalized Jira descriptions as escaped plain text while preserving code and autolinks", () => {
    const text =
      "if (has_value) {\n  const x = left * right * scale;\n}\n<T> OPS-1 https://docs.example.invalid/runbook";
    const wrapper = mount(MarkdownContent, {
      props: {
        text,
        jiraRoutes: [{ ...routes[0], issueKeyPrefixes: ["OPS"] }],
        autolinkUrls: true,
        plainText: true,
      },
    });

    expect(wrapper.find(".markdown-content").classes()).toContain("markdown-content--plain-text");
    expect(wrapper.text()).toBe(text);
    expect(wrapper.find("em").exists()).toBe(false);
    expect(wrapper.find("T").exists()).toBe(false);
    expect(wrapper.findAll("a").map((link) => link.text())).toEqual(["OPS-1", "https://docs.example.invalid/runbook"]);
    expect(wrapper.findAll("a")[1].attributes("href")).toBe("https://docs.example.invalid/runbook");
    expect(wrapper.text()).not.toContain("\u0006");
  });
});
