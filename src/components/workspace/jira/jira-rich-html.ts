import createDOMPurify from "dompurify";

const ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "b",
  "em",
  "i",
  "del",
  "s",
  "strike",
  "ins",
  "u",
  "sup",
  "sub",
  "code",
  "pre",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tfoot",
  "tr",
  "th",
  "td",
  "caption",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "hr",
  "a",
  "span",
  "div",
  "img",
];
const ALLOWED_ATTR = ["href", "title", "colspan", "rowspan", "start", "class", "src", "alt"];
const ALLOWED_CLASSES = new Set([
  "panel",
  "panelHeader",
  "panelContent",
  "code",
  "codeHeader",
  "codeContent",
  "preformatted",
  "preformattedContent",
  "user-hover",
  "external-link",
  "error",
  "confluenceTable",
  "confluenceTh",
  "confluenceTd",
]);
const LINK_PROTOCOLS = new Set(["http:", "https:"]);
const IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const ATTACHMENT_PATHS = [
  /\/secure\/attachment\/(\d{1,32})(?:\/|$)/,
  /\/secure\/thumbnail\/(\d{1,32})(?:\/|$)/,
  /\/attachment\/content\/(\d{1,32})(?:\/|$)/,
];
const EMOTICON_PATH = /\/images\/icons\/emoticons\/([a-z0-9_-]+)\.(?:png|gif|svg)$/i;

export const JIRA_EMOTICONS: Readonly<Record<string, string>> = {
  warning: "⚠️",
  information: "ℹ️",
  check: "✅",
  error: "❌",
  help_16: "❓",
  help: "❓",
  thumbs_up: "👍",
  thumbs_down: "👎",
  star_yellow: "⭐",
  star_red: "⭐",
  star_green: "⭐",
  star_blue: "⭐",
  lightbulb_on: "💡",
  lightbulb: "💡",
  smile: "🙂",
  sad: "🙁",
  wink: "😉",
  tongue: "😛",
  biggrin: "😀",
  add: "➕",
  forbidden: "⛔",
};

type Purifier = ReturnType<typeof createDOMPurify>;
let purifier: Purifier | undefined;

function getPurifier(): Purifier {
  if (purifier) return purifier;
  const instance = createDOMPurify(window);
  instance.addHook("uponSanitizeAttribute", (_node, data) => {
    if (data.attrName !== "class") return;
    const kept = data.attrValue.split(/\s+/).filter((token) => ALLOWED_CLASSES.has(token));
    data.attrValue = kept.join(" ");
    if (!kept.length) data.keepAttr = false;
  });
  purifier = instance;
  return instance;
}

function resolveUrl(value: string, baseUrl: string | undefined): URL | null {
  try {
    const url = baseUrl ? new URL(value, baseUrl) : new URL(value);
    return url.username || url.password ? null : url;
  } catch {
    return null;
  }
}

function attachmentIdOf(url: URL): string | null {
  for (const pattern of ATTACHMENT_PATHS) {
    const match = pattern.exec(url.pathname);
    if (match?.[1]) return match[1];
  }
  return null;
}

function replaceImage(image: HTMLImageElement, baseUrl: string | undefined, doc: Document) {
  const alt = (image.getAttribute("alt") || "").slice(0, 200);
  const url = resolveUrl(image.getAttribute("src") || "", baseUrl);
  if (!url || !IMAGE_PROTOCOLS.has(url.protocol)) {
    image.replaceWith(doc.createTextNode(alt));
    return;
  }
  const emoticon = EMOTICON_PATH.exec(url.pathname);
  if (emoticon?.[1]) {
    image.replaceWith(doc.createTextNode(JIRA_EMOTICONS[emoticon[1].toLowerCase()] || alt));
    return;
  }
  const attachmentId = attachmentIdOf(url);
  if (attachmentId) {
    const placeholder = doc.createElement("span");
    placeholder.className = "jira-rich__image";
    placeholder.setAttribute("data-jira-attachment", attachmentId);
    placeholder.setAttribute("data-alt", alt);
    placeholder.textContent = alt || "Image";
    image.replaceWith(placeholder);
    return;
  }
  const link = doc.createElement("a");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = "External image, not loaded. Opens the address in your browser.";
  link.textContent = alt || url.href;
  image.replaceWith(link);
}

/**
 * Sanitizes Jira-rendered HTML to a strict allowlist. Embedded images never keep their `src`: Jira attachments become
 * placeholders carrying only the attachment id (bytes are fetched through the transport), emoticons become text, and
 * any other image becomes a link that is never loaded.
 */
export function sanitizeJiraHtml(html: string, baseUrl?: string): string {
  const clean = getPurifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ALLOW_ARIA_ATTR: false,
  });
  const template = document.createElement("template");
  template.innerHTML = clean;
  const doc = template.content.ownerDocument;
  for (const image of Array.from(template.content.querySelectorAll("img"))) replaceImage(image, baseUrl, doc);
  for (const anchor of Array.from(template.content.querySelectorAll("a"))) {
    if (anchor.hasAttribute("data-jira-attachment")) continue;
    const url = resolveUrl(anchor.getAttribute("href") || "", baseUrl);
    if (!url || !LINK_PROTOCOLS.has(url.protocol)) {
      anchor.replaceWith(...Array.from(anchor.childNodes));
      continue;
    }
    anchor.href = url.href;
    anchor.target = "_blank";
    anchor.rel = "noopener noreferrer";
  }
  return template.innerHTML;
}
