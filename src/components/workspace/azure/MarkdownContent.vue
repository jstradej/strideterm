<template>
  <div class="markdown-content" :class="{ 'markdown-content--plain-text': plainText }" @click="onClick">
    <div v-html="rendered"></div>
    <div
      v-if="chooserKey"
      class="jira-link-chooser"
      role="dialog"
      :aria-label="`Choose Jira connection for ${chooserKey}`"
    >
      <strong>{{ chooserKey }} · Choose Jira connection</strong>
      <a
        v-for="route in chooserRoutes"
        :key="route.connectionId"
        :href="jiraIssueUrl(route, chooserKey) || undefined"
        target="_blank"
        rel="noopener noreferrer"
        >{{ route.label }}</a
      >
      <button type="button" @click="chooserKey = ''">Close</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { Marked, Renderer, Tokenizer } from "marked";
import DOMPurify from "dompurify";
import { apiKey } from "../../../types/keys.js";
import { renderMarkdown } from "./markdown-renderer.js";
import {
  autolinkEscapedJiraText,
  jiraCandidates,
  jiraIssueUrl,
  type JiraLinkRoute,
} from "../../../lib/jira-issue-links.js";

const props = withDefaults(
  defineProps<{
    text?: string;
    jiraRoutes?: JiraLinkRoute[];
    autolinkUrls?: boolean;
    plainText?: boolean;
    richText?: boolean;
  }>(),
  {
    text: "",
    jiraRoutes: () => [],
    autolinkUrls: false,
    plainText: false,
    richText: false,
  },
);
const api = inject(apiKey, null);
const chooserKey = ref("");
const chooserRoutes = computed(() => jiraCandidates(chooserKey.value, props.jiraRoutes));

function onClick(event: MouseEvent): void {
  const target = event.target as HTMLElement | null;
  const key = target?.closest<HTMLElement>("[data-jira-key]")?.dataset.jiraKey;
  if (key) {
    chooserKey.value = key;
    return;
  }
  openLink(event);
}

function openLink(event: MouseEvent): void {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  const link = target.closest<HTMLAnchorElement>("a[href]");
  const href = link?.getAttribute("href");
  if (href?.startsWith("#")) {
    event.preventDefault();
    const root = event.currentTarget;
    if (!(root instanceof HTMLElement)) return;
    let fragment = href.slice(1);
    try {
      fragment = decodeURIComponent(fragment);
    } catch {
      return;
    }
    const anchor = [...root.querySelectorAll<HTMLElement>("[data-markdown-anchor]")].find(
      (heading) => heading.dataset.markdownAnchor === fragment,
    );
    anchor?.scrollIntoView({ block: "start", behavior: "smooth" });
    return;
  }
  if (!href || !/^https?:\/\//i.test(href)) return;

  event.preventDefault();
  if (api?.openExternal) void api.openExternal(href);
  else window.open(href, "_blank", "noopener,noreferrer");
}

function escapeHtml(str: string) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function autolinkPlainUrls(escapedText: string, protectedAutoLinks: string[]) {
  return escapedText.replace(
    /(^|[\s(])((?:https?:\/\/)(?:(?!&(?:quot|gt|lt|#39);)[^\s<>"'])+)/gi,
    (_match, before: string, escapedUrl: string) => {
      let displayUrl = escapedUrl;
      let trailing = "";
      while (/[.,;:!?)]$/.test(displayUrl)) {
        trailing = displayUrl.slice(-1) + trailing;
        displayUrl = displayUrl.slice(0, -1);
      }
      const candidate = displayUrl.replace(/&amp;/g, "&");
      try {
        const url = new URL(candidate);
        if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password)
          return `${before}${escapedUrl}`;
        const safeUrl = escapeHtml(url.toString());
        const token = `\u0006${protectedAutoLinks.length}\u0006`;
        protectedAutoLinks.push(
          `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${escapeHtml(url.toString())}</a>`,
        );
        return `${before}${token}${trailing}`;
      } catch {
        return `${before}${escapedUrl}`;
      }
    },
  );
}

function renderPlainText(text = ""): string {
  let out = escapeHtml(text);
  const protectedAutoLinks: string[] = [];
  if (props.autolinkUrls) out = autolinkPlainUrls(out, protectedAutoLinks);
  out = autolinkEscapedJiraText(out, props.jiraRoutes);
  return out.replace(/\u0006(\d+)\u0006/g, (_, index: string) => protectedAutoLinks[Number(index)]);
}

function autolinkTextNodes(root: DocumentFragment): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (!node.parentElement?.closest("a, code, pre, button")) textNodes.push(node);
  }
  for (const node of textNodes) {
    const protectedUrls: string[] = [];
    let html = escapeHtml(node.textContent || "");
    if (props.autolinkUrls) html = autolinkPlainUrls(html, protectedUrls);
    html = autolinkEscapedJiraText(html, props.jiraRoutes);
    html = html.replace(/\u0006(\d+)\u0006/g, (_, index: string) => protectedUrls[Number(index)]);
    const replacement = document.createElement("template");
    replacement.innerHTML = html;
    node.replaceWith(replacement.content);
  }
}

function renderMarkdownWithJiraLinks(text: string): string {
  const html = renderMarkdown(text);
  if (!props.jiraRoutes.length) return html;
  const container = document.createElement("template");
  container.innerHTML = html;
  autolinkTextNodes(container.content);
  return container.innerHTML;
}

// Opt in only for normalized Jira descriptions. Other Markdown consumers retain
// their existing presentation and link handling.
const richRenderer = new Renderer();
richRenderer.html = ({ text }) => escapeHtml(text);
richRenderer.image = ({ text }) => escapeHtml(text ? `[Attachment: ${text}]` : "[Attachment]");
// Autolink after Markdown parsing so escaped punctuation inside literal URLs
// cannot become part of a malformed destination.
const richTokenizer = new Tokenizer();
richTokenizer.url = () => undefined;
const richParser = new Marked({
  renderer: richRenderer,
  tokenizer: richTokenizer,
  gfm: true,
  breaks: true,
  async: false,
});
const richSanitizeOptions = {
  ALLOWED_TAGS: [
    "p",
    "br",
    "strong",
    "em",
    "del",
    "blockquote",
    "pre",
    "code",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "hr",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "a",
    "button",
  ],
  ALLOWED_ATTR: ["href", "title", "target", "rel", "start", "type", "class", "data-jira-key", "data-jira-issue"],
};
function renderRichText(text: string): string {
  const container = document.createElement("template");
  container.innerHTML = DOMPurify.sanitize(richParser.parse(text) as string, richSanitizeOptions);
  autolinkTextNodes(container.content);
  for (const anchor of container.content.querySelectorAll("a")) {
    try {
      const url = new URL(anchor.getAttribute("href") || "");
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Unsafe link");
      anchor.href = url.href;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
    } catch {
      anchor.replaceWith(...Array.from(anchor.childNodes));
    }
  }
  return DOMPurify.sanitize(container.innerHTML, richSanitizeOptions);
}
const rendered = computed(() =>
  props.plainText
    ? renderPlainText(props.text)
    : props.richText
      ? renderRichText(props.text)
      : renderMarkdownWithJiraLinks(props.text),
);
</script>

<style scoped>
.jira-link-chooser {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--surface, var(--bg));
}

.jira-link-chooser a,
.jira-link-chooser button {
  color: var(--accent);
  cursor: pointer;
}

.markdown-content :deep(.jira-issue-chooser) {
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--accent);
  font: inherit;
  text-decoration: underline dotted;
  cursor: pointer;
}

.markdown-content {
  overflow-wrap: anywhere;
  line-height: 1.55;
  font-size: 13px;
}

.markdown-content--plain-text {
  white-space: pre-wrap;
}

.markdown-content :deep(:first-child) {
  margin-top: 0;
}

.markdown-content :deep(:last-child) {
  margin-bottom: 0;
}

.markdown-content :deep(h1),
.markdown-content :deep(h2),
.markdown-content :deep(h3),
.markdown-content :deep(h4),
.markdown-content :deep(h5),
.markdown-content :deep(h6) {
  color: var(--text);
  line-height: 1.3;
  margin: 1em 0 0.45em;
}

.markdown-content :deep(h1) {
  font-size: 1.7em;
}

.markdown-content :deep(h2) {
  font-size: 1.4em;
}

.markdown-content :deep(h3) {
  font-size: 1.2em;
}

.markdown-content :deep(p),
.markdown-content :deep(ul),
.markdown-content :deep(ol),
.markdown-content :deep(blockquote),
.markdown-content :deep(table),
.markdown-content :deep(pre) {
  margin: 0.65em 0;
}

.markdown-content :deep(ul),
.markdown-content :deep(ol) {
  padding-left: 1.6em;
}

.markdown-content :deep(li + li) {
  margin-top: 0.2em;
}

.markdown-content :deep(blockquote) {
  margin-left: 0;
  padding: 0.15em 0 0.15em 0.9em;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

.markdown-content :deep(a) {
  color: var(--accent, #8ab4f8);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.markdown-content :deep(code) {
  padding: 0.12em 0.35em;
  border-radius: 3px;
  background: rgba(var(--tint), 0.1);
  font-size: 0.92em;
}

.markdown-content :deep(pre) {
  max-width: 100%;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--panel, rgba(0, 0, 0, 0.18));
}

.markdown-content :deep(pre code) {
  padding: 0;
  background: transparent;
  font-size: 12px;
}

.markdown-content :deep(table) {
  display: block;
  width: max-content;
  max-width: 100%;
  overflow: auto;
  border-collapse: collapse;
}

.markdown-content :deep(th),
.markdown-content :deep(td) {
  padding: 5px 9px;
  border: 1px solid var(--border);
  text-align: left;
}

.markdown-content :deep(th) {
  background: var(--panel);
  color: var(--text);
}

.markdown-content :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
}

.markdown-content :deep(img) {
  max-width: 100%;
  max-height: 60vh;
  object-fit: contain;
}

.markdown-content :deep(.markdown-image-unavailable) {
  color: var(--muted);
  font-style: italic;
}
</style>
