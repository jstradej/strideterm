import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";

const SAFE_LINK = /^(?:https?:|#)/i;
const SAFE_IMAGE = /^https?:\/\//i;
let headingSlugs = new Map<string, number>();

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const markdown = new Marked({
  async: false,
  gfm: true,
  renderer: {
    heading(token: Tokens.Heading): string {
      const base = token.text
        .normalize("NFKD")
        .replace(/[\u0300-\u036f]/g, "")
        .toLowerCase()
        .trim()
        .replace(/[^\p{L}\p{N}\s-]/gu, "")
        .replace(/\s+/g, "-");
      const count = headingSlugs.get(base) || 0;
      headingSlugs.set(base, count + 1);
      const slug = count ? `${base}-${count}` : base;
      const content = this.parser.parseInline(token.tokens);
      return `<h${token.depth} data-markdown-anchor="${escapeHtml(slug)}">${content}</h${token.depth}>`;
    },
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link): string {
      const label = this.parser.parseInline(token.tokens);
      if (!SAFE_LINK.test(token.href)) return label;
      const target = token.href.startsWith("#") ? "" : ' target="_blank" rel="noopener noreferrer"';
      return `<a href="${escapeHtml(token.href)}"${target}>${label}</a>`;
    },
    image(token: Tokens.Image): string {
      if (SAFE_IMAGE.test(token.href)) {
        return `<img src="${escapeHtml(token.href)}" alt="${escapeHtml(token.text)}" loading="lazy" referrerpolicy="no-referrer">`;
      }
      const label = token.text ? `: ${escapeHtml(token.text)}` : "";
      return `<span class="markdown-image-unavailable" title="Relative Markdown image not loaded: ${escapeHtml(token.href)}">[Image unavailable${label}]</span>`;
    },
  },
});

export function renderMarkdown(source: string): string {
  headingSlugs = new Map<string, number>();
  const parsed = markdown.parse(source);
  const html = typeof parsed === "string" ? parsed : "";
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["loading", "referrerpolicy", "target", "rel"],
    ADD_URI_SAFE_ATTR: ["loading", "referrerpolicy", "target", "rel"],
    ALLOWED_URI_REGEXP: SAFE_LINK,
  });
}

export function isMarkdownFile(name: string): boolean {
  return /\.(?:md|markdown)$/i.test(name);
}
