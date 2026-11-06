<template>
  <div v-if="sanitized" class="jira-rich" @click="onClick" @keydown.enter="onClick">
    <div ref="contentRef" class="jira-rich__content" v-html="sanitized"></div>
    <div
      v-if="zoomUrl"
      class="jira-rich__overlay"
      role="dialog"
      aria-label="Image preview"
      title="Click anywhere or press Escape to close the image."
      @click.stop="zoomUrl = ''"
    >
      <img :src="zoomUrl" :alt="zoomAlt" />
    </div>
  </div>
  <MarkdownContent v-else-if="markdown" :text="markdown" :jira-routes="jiraRoutes" autolink-urls rich-text />
  <MarkdownContent v-else-if="text" :text="text" :jira-routes="jiraRoutes" autolink-urls plain-text />
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import type { CallableTransport } from "../../../transport.js";
import { useAppStore } from "../../../stores/app.js";
import type { JiraLinkRoute } from "../../../lib/jira-issue-links.js";
import MarkdownContent from "../azure/MarkdownContent.vue";
import { sanitizeJiraHtml } from "./jira-rich-html.js";
import { loadJiraImageBlob } from "./jira-rich-images.js";

const props = withDefaults(
  defineProps<{
    html?: string;
    markdown?: string;
    text?: string;
    connectionId?: string;
    issueId?: string;
    baseUrl?: string;
    jiraRoutes?: JiraLinkRoute[];
  }>(),
  { html: "", markdown: "", text: "", connectionId: "", issueId: "", baseUrl: "", jiraRoutes: () => [] },
);

const contentRef = ref<HTMLElement | null>(null);
const zoomUrl = ref("");
const zoomAlt = ref("");
const sanitized = computed(() => (props.html ? sanitizeJiraHtml(props.html, props.baseUrl || undefined) : ""));
const objectUrls = new Set<string>();
let observer: IntersectionObserver | undefined;
let generation = 0;

function releaseImages() {
  generation += 1;
  observer?.disconnect();
  observer = undefined;
  for (const url of objectUrls) URL.revokeObjectURL(url);
  objectUrls.clear();
}

async function loadInto(placeholder: HTMLElement, loadGeneration: number) {
  const attachmentId = placeholder.dataset.jiraAttachment;
  if (!attachmentId || !props.connectionId || !props.issueId || placeholder.dataset.state) return;
  placeholder.dataset.state = "loading";
  const alt = placeholder.dataset.alt || "";
  try {
    const api = useAppStore().getApi() as CallableTransport;
    const blob = await loadJiraImageBlob(api, props.connectionId, props.issueId, attachmentId);
    if (loadGeneration !== generation) return;
    const url = URL.createObjectURL(blob);
    objectUrls.add(url);
    const image = document.createElement("img");
    image.src = url;
    image.alt = alt;
    placeholder.replaceChildren(image);
    placeholder.dataset.state = "loaded";
    placeholder.setAttribute("role", "button");
    placeholder.tabIndex = 0;
    placeholder.title = "Show this image full size.";
  } catch (error) {
    if (loadGeneration !== generation) return;
    placeholder.dataset.state = "failed";
    placeholder.textContent = alt ? `Image unavailable: ${alt}` : "Image unavailable";
    placeholder.title = error instanceof Error ? error.message : "The image could not be loaded from Jira.";
  }
}

async function attachImages() {
  releaseImages();
  await nextTick();
  const root = contentRef.value;
  if (!root) return;
  const loadGeneration = generation;
  const placeholders = Array.from(root.querySelectorAll<HTMLElement>("[data-jira-attachment]"));
  if (!placeholders.length) return;
  if (typeof IntersectionObserver === "undefined") {
    for (const placeholder of placeholders) void loadInto(placeholder, loadGeneration);
    return;
  }
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer?.unobserve(entry.target);
      void loadInto(entry.target as HTMLElement, loadGeneration);
    }
  });
  for (const placeholder of placeholders) observer.observe(placeholder);
}

function onClick(event: Event) {
  const placeholder = (event.target as HTMLElement | null)?.closest<HTMLElement>("[data-jira-attachment]");
  if (placeholder?.dataset.state !== "loaded") return;
  const image = placeholder.querySelector("img");
  if (!image) return;
  zoomUrl.value = image.src;
  zoomAlt.value = image.alt;
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && zoomUrl.value) {
    event.stopPropagation();
    zoomUrl.value = "";
  }
}

watch(sanitized, () => void attachImages(), { flush: "post", immediate: true });
watch(zoomUrl, (value) => {
  if (value) window.addEventListener("keydown", onKeydown, true);
  else window.removeEventListener("keydown", onKeydown, true);
});
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown, true);
  releaseImages();
});
</script>

<style scoped>
.jira-rich {
  font-size: var(--font-size-body);
  line-height: 1.5;
  color: var(--text);
  overflow-wrap: anywhere;
}

.jira-rich__content :deep(> :first-child) {
  margin-top: 0;
}

.jira-rich__content :deep(> :last-child) {
  margin-bottom: 0;
}

.jira-rich__content :deep(p),
.jira-rich__content :deep(ul),
.jira-rich__content :deep(ol),
.jira-rich__content :deep(blockquote),
.jira-rich__content :deep(table),
.jira-rich__content :deep(pre) {
  margin: 0 0 0.6em;
}

.jira-rich__content :deep(ul),
.jira-rich__content :deep(ol) {
  padding-left: 1.5em;
}

.jira-rich__content :deep(h1),
.jira-rich__content :deep(h2),
.jira-rich__content :deep(h3),
.jira-rich__content :deep(h4),
.jira-rich__content :deep(h5),
.jira-rich__content :deep(h6) {
  margin: 0.9em 0 0.4em;
  line-height: 1.25;
  color: var(--text);
}

.jira-rich__content :deep(h1) {
  font-size: 1.5em;
}

.jira-rich__content :deep(h2) {
  font-size: 1.3em;
}

.jira-rich__content :deep(h3) {
  font-size: 1.15em;
}

.jira-rich__content :deep(h4),
.jira-rich__content :deep(h5),
.jira-rich__content :deep(h6) {
  font-size: 1em;
}

.jira-rich__content :deep(a) {
  color: var(--accent);
}

.jira-rich__content :deep(a.user-hover) {
  text-decoration: none;
  font-weight: 600;
}

.jira-rich__content :deep(code) {
  padding: 1px 4px;
  border-radius: 3px;
  background: rgba(var(--tint), 0.08);
  font-size: 0.9em;
}

.jira-rich__content :deep(pre) {
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-control);
  overflow-x: auto;
  font-size: var(--font-size-caption);
}

.jira-rich__content :deep(pre code) {
  padding: 0;
  background: none;
  font-size: inherit;
}

.jira-rich__content :deep(blockquote) {
  padding: 2px 0 2px 10px;
  border-left: 3px solid var(--border);
  color: var(--muted);
}

.jira-rich__content :deep(hr) {
  border: 0;
  border-top: 1px solid var(--border);
  margin: 0.8em 0;
}

.jira-rich__content :deep(table) {
  border-collapse: collapse;
  display: block;
  max-width: 100%;
  overflow-x: auto;
}

.jira-rich__content :deep(th),
.jira-rich__content :deep(td) {
  padding: 4px 8px;
  border: 1px solid var(--border);
  vertical-align: top;
  text-align: left;
}

.jira-rich__content :deep(th) {
  background: var(--surface-control);
  font-weight: 600;
}

.jira-rich__content :deep(.panel) {
  margin: 0 0 0.6em;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-card);
  overflow: hidden;
}

.jira-rich__content :deep(.panelHeader),
.jira-rich__content :deep(.codeHeader) {
  padding: 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--surface-control);
  font-weight: 600;
}

.jira-rich__content :deep(.panelContent),
.jira-rich__content :deep(.codeContent),
.jira-rich__content :deep(.preformattedContent) {
  padding: 6px 10px;
}

.jira-rich__content :deep(.panel pre) {
  margin: 0;
  border: 0;
  padding: 0;
  background: none;
}

.jira-rich__content :deep(.jira-rich__image) {
  display: inline-block;
  max-width: 100%;
  color: var(--muted);
  font-size: var(--font-size-caption);
}

.jira-rich__content :deep(.jira-rich__image img) {
  display: block;
  max-width: 100%;
  max-height: 480px;
  border: 1px solid var(--border);
  border-radius: 4px;
  cursor: zoom-in;
}

.jira-rich__overlay {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.7);
  cursor: zoom-out;
}

.jira-rich__overlay img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
}
</style>
