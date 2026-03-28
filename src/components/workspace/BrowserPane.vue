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
        @focus="(e) => e.target.select()"
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

<script setup>
import { ref, onMounted, computed } from "vue";
import { useAppStore } from "../../stores/app.js";

const props = defineProps({
  tab: { type: Object, required: true },
  showHeader: { type: Boolean, default: false },
});

const store = useAppStore();
const embedContainerRef = ref(null);

const homeUrl = computed(() => props.tab.url || "about:blank");
const isElectron = !!window.strideterm;
const isDark = document.documentElement.dataset.theme !== "light";
const embedBg = isDark ? "#1c1c20" : "#fff";
const isValidUrl = computed(() => homeUrl.value.length > 10);

const urlValue = ref(isValidUrl.value ? homeUrl.value : "");

let embed = null;

function navigateTo(target) {
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
  else if (embed) embed.src = embed.src;
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

function shortDomain(hostname) {
  const parts = hostname.split(".");
  if (parts.length <= 2) return hostname;
  const sld = parts[parts.length - 2];
  if (sld.length <= 3 && parts.length >= 3) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

onMounted(() => {
  if (!embedContainerRef.value) return;

  if (isElectron) {
    embed = document.createElement("webview");
    embed.setAttribute("src", isValidUrl.value ? homeUrl.value : "about:blank");
    embed.setAttribute("allowpopups", "");
    if (isDark) embed.setAttribute("webpreferences", "darkTheme=yes");
    embed.addEventListener("did-navigate", (e) => {
      urlValue.value = e.url;
      // Sync tab title in store's tab strip (best-effort)
    });
    embed.addEventListener("did-navigate-in-page", (e) => {
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
