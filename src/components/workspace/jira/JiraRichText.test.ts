import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { enableAutoUnmount, flushPromises, mount } from "@vue/test-utils";
import { sanitizeJiraHtml } from "./jira-rich-html.js";
import { clearJiraImageCache } from "./jira-rich-images.js";

const getJiraAttachmentContent = vi.hoisted(() => vi.fn());
vi.mock("../../../stores/app.js", () => ({
  useAppStore: () => ({ getApi: () => ({ getJiraAttachmentContent: getJiraAttachmentContent }) }),
}));
import JiraRichText from "./JiraRichText.vue";

enableAutoUnmount(afterEach);

const BASE = "https://jira.example.com/browse/OPS-1";

describe("sanitizeJiraHtml", () => {
  test("keeps Jira formatting and drops script, handlers, style, iframe and forms", () => {
    const html = sanitizeJiraHtml(
      `<h2>Title</h2><p onclick="x()" style="color:red"><strong>bold</strong> <em>it</em></p>` +
        `<script>alert(1)</script><iframe src="https://evil"></iframe><form><input></form>` +
        `<div class="panel evil"><div class="panelHeader">Note</div><div class="panelContent">body</div></div>` +
        `<table><tr><th colspan="2">h</th></tr><tr><td rowspan="2">c</td></tr></table>`,
      BASE,
    );
    expect(html).toContain("<h2>Title</h2>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('class="panel"');
    expect(html).toContain("panelHeader");
    expect(html).toContain('colspan="2"');
    expect(html).toContain('rowspan="2"');
    expect(html).not.toMatch(/script|iframe|onclick|style=|<form|<input|evil/i);
  });

  test("links open externally and relative or unsafe hrefs are resolved or unwrapped", () => {
    const html = sanitizeJiraHtml(
      `<a href="/browse/OPS-2">rel</a> <a href="${"java" + "script:alert(1)"}">js</a> <a href="https://x.test/a">abs</a>`,
      BASE,
    );
    expect(html).toContain('href="https://jira.example.com/browse/OPS-2"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).not.toContain("java" + "script:");
    expect(html).toContain("js");
  });

  test("renders mailto links as plain text because only web links can be opened", () => {
    const html = sanitizeJiraHtml(`<a href="mailto:a@example.com">mail</a> <a href="https://x.test/a">abs</a>`, BASE);
    expect(html).not.toContain("mailto:");
    expect(html).toContain("mail");
    expect(html).toContain('href="https://x.test/a"');
  });

  test("rewrites Jira attachment images to placeholders and never keeps their src", () => {
    const html = sanitizeJiraHtml(
      `<img src="/secure/attachment/10042/shot.png" alt="shot.png">` +
        `<img src="/secure/thumbnail/10043/_thumb_10043.png" alt="t">` +
        `<img src="https://jira.example.com/rest/api/3/attachment/content/10044">`,
      BASE,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("src=");
    expect(html).toContain('data-jira-attachment="10042"');
    expect(html).toContain('data-jira-attachment="10043"');
    expect(html).toContain('data-jira-attachment="10044"');
    expect(html).toContain('data-alt="shot.png"');
  });

  test("maps emoticons to Unicode and turns other external images into never-loaded links", () => {
    const html = sanitizeJiraHtml(
      `<img src="/images/icons/emoticons/warning.png" alt="(!)"> <img src="/images/icons/emoticons/thumbs_up.gif" alt="(y)">` +
        `<img src="https://cdn.example.org/pic.png" alt="remote pic">`,
      BASE,
    );
    expect(html).toContain("⚠️");
    expect(html).toContain("👍");
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://cdn.example.org/pic.png"');
    expect(html).toContain(">remote pic</a>");
  });
});

describe("JiraRichText", () => {
  beforeEach(() => {
    getJiraAttachmentContent.mockReset();
    clearJiraImageCache();
    vi.stubGlobal("IntersectionObserver", undefined);
    URL.createObjectURL = vi.fn(() => "blob:test-1");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => vi.unstubAllGlobals());

  test("falls back from html to markdown to plain text", () => {
    const md = mount(JiraRichText, { props: { markdown: "**bold**", text: "plain" } });
    expect(md.find(".markdown-content").exists()).toBe(true);
    expect(md.html()).toContain("<strong>bold</strong>");
    const plain = mount(JiraRichText, { props: { text: "just text" } });
    expect(plain.find(".markdown-content--plain-text").exists()).toBe(true);
    expect(plain.text()).toBe("just text");
    const rich = mount(JiraRichText, { props: { html: "<p>from jira</p>", markdown: "ignored", text: "ignored" } });
    expect(rich.find(".jira-rich").exists()).toBe(true);
    expect(rich.text()).toBe("from jira");
  });

  test("loads an attachment once, shows it, zooms on click and closes on Escape", async () => {
    getJiraAttachmentContent.mockResolvedValue({ mediaType: "image/png", bytes: new Uint8Array([1, 2]) });
    const props = {
      html: `<p><img src="/secure/attachment/7/a.png" alt="a"></p>`,
      connectionId: "c1",
      issueId: "100",
      baseUrl: BASE,
    };
    const first = mount(JiraRichText, { props, attachTo: document.body });
    await flushPromises();
    expect(getJiraAttachmentContent).toHaveBeenCalledWith({ connectionId: "c1", issueId: "100", attachmentId: "7" });
    const image = first.find(".jira-rich__image img");
    expect(image.attributes("src")).toBe("blob:test-1");
    const second = mount(JiraRichText, { props });
    await flushPromises();
    expect(getJiraAttachmentContent).toHaveBeenCalledTimes(1);
    second.unmount();

    await first.find(".jira-rich__image").trigger("click");
    expect(first.find(".jira-rich__overlay").exists()).toBe(true);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    await flushPromises();
    expect(first.find(".jira-rich__overlay").exists()).toBe(false);
    first.unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-1");
  });

  test("shows the reason when an image cannot be loaded", async () => {
    getJiraAttachmentContent.mockRejectedValue(new Error("Jira attachment is not an image."));
    const wrapper = mount(JiraRichText, {
      props: {
        html: `<img src="/secure/attachment/8/b.png" alt="b">`,
        connectionId: "c1",
        issueId: "100",
        baseUrl: BASE,
      },
    });
    await flushPromises();
    const placeholder = wrapper.find(".jira-rich__image");
    expect(placeholder.text()).toContain("Image unavailable: b");
    expect(placeholder.attributes("title")).toContain("not an image");
  });
});
