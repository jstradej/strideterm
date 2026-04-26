<template>
  <div class="workspace-pane__body workspace-pane__body--browser">
    <form class="browser-url-bar" @submit.prevent="navigateTo(urlValue.trim())">
      <button
        v-if="isElectron"
        type="button"
        data-browser-action="back"
        class="button button--ghost browser-url-bar__btn"
        @click="goBack"
      >
        &#8592;
      </button>
      <button
        v-if="isElectron"
        type="button"
        data-browser-action="forward"
        class="button button--ghost browser-url-bar__btn"
        @click="goForward"
      >
        &#8594;
      </button>
      <button
        type="button"
        data-browser-action="reload"
        class="button button--ghost browser-url-bar__btn"
        @click="reload"
      >
        &#x21BB;
      </button>
      <input
        v-model="urlValue"
        type="text"
        class="browser-url-bar__input"
        :placeholder="homeUrl"
        @focus="(e) => (e.target as HTMLInputElement)?.select()"
      />
      <button
        type="button"
        data-browser-action="home"
        class="button button--ghost browser-url-bar__btn"
        title="Home"
        @click="goHome"
      >
        &#x2302;
      </button>
      <button
        type="button"
        data-browser-action="external"
        class="button button--ghost browser-url-bar__btn"
        title="Open in browser"
        @click="openExternal"
      >
        &#x2197;
      </button>
    </form>
    <div
      ref="embedContainerRef"
      class="browser-embed-container"
      style="flex: 1; min-height: 0; display: flex; flex-direction: column"
    ></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, computed } from "vue";
const props = withDefaults(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  defineProps<{ tab: Record<string, any>; showHeader?: boolean }>(),
  { showHeader: false },
);

const embedContainerRef = ref<HTMLDivElement | null>(null);

const homeUrl = computed(() => props.tab.url || "about:blank");
const isElectron = !!window.strideterm;
const isDark = document.documentElement.dataset.theme !== "light";
const embedBg = isDark ? "#1c1c20" : "#fff";
const isValidUrl = computed(() => homeUrl.value.length > 10);

const urlValue = ref(isValidUrl.value ? homeUrl.value : "");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let embed: any = null;

function navigateTo(target: string) {
  if (!target) return;
  if (!/^https?:\/\//i.test(target)) target = "https://" + target;
  urlValue.value = target;
  if (isElectron && embed) {
    try {
      embed.loadURL(target);
    } catch {
      embed.setAttribute("src", target);
    }
  } else if (embed) {
    embed.src = target;
  }
}

function goBack() {
  if (isElectron && embed?.goBack) embed.goBack();
}

function goForward() {
  if (isElectron && embed?.goForward) embed.goForward();
}

function reload() {
  if (isElectron && embed?.reload) embed.reload();
  else if (embed) embed.src = embed.src; // eslint-disable-line no-self-assign -- iframe reload trick
}

function goHome() {
  navigateTo(homeUrl.value);
}

function openExternal() {
  const url = isElectron && embed?.getURL ? embed.getURL() : embed?.src;
  if (url && url !== "about:blank") {
    if (window.strideterm?.openExternal) window.strideterm.openExternal(url);
    else window.open(url, "_blank");
  }
}

onMounted(() => {
  if (!embedContainerRef.value) return;

  if (isElectron) {
    embed = document.createElement("webview");
    embed.setAttribute("src", isValidUrl.value ? homeUrl.value : "about:blank");
    embed.setAttribute("allowpopups", "");
    if (isDark) embed.setAttribute("webpreferences", "darkTheme=yes");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embed.addEventListener("did-navigate", (e: any) => {
      urlValue.value = e.url;
      // Sync tab title in store's tab strip (best-effort)
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    embed.addEventListener("did-navigate-in-page", (e: any) => {
      if (e.isMainFrame) urlValue.value = e.url;
    });
  } else {
    embed = document.createElement("iframe");
    embed.src = isValidUrl.value ? homeUrl.value : "about:blank";
    embed.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox",
    );
  }

  embed.style.cssText = `flex:1;min-height:0;border:none;background:${embedBg};border-radius:0 0 3px 3px;width:100%;`;
  embedContainerRef.value.appendChild(embed);
});
</script>
