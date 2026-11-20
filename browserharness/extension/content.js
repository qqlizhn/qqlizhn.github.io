let armed = false;

function isBrowserHarnessPage() {
  return Boolean(document.querySelector('meta[name="browserharness"]'));
}

function onPageMessage(event) {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== "browserharness-page" || data.type !== "fetch") return;
  if (!isBrowserHarnessPage()) return;

  const port = chrome.runtime.connect({ name: "browserharness-fetch" });
  let finished = false;
  const ping = setInterval(() => {
    try {
      port.postMessage({ type: "ping" });
    } catch {
      clearInterval(ping);
    }
  }, 15_000);

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type === "ping") return;
    if (msg.type === "done" || msg.type === "error") {
      finished = true;
      clearInterval(ping);
    }
    window.postMessage(
      { source: "browserharness-extension", id: data.id, ...msg },
      window.location.origin,
    );
  });
  port.onDisconnect.addListener(() => {
    clearInterval(ping);
    if (finished) return;
    finished = true;
    const reason = chrome.runtime.lastError?.message || "Extension disconnected";
    window.postMessage(
      { source: "browserharness-extension", id: data.id, type: "error", message: reason },
      window.location.origin,
    );
  });
  port.postMessage({
    url: data.url,
    method: data.method,
    headers: data.headers,
    body: data.body,
  });
}

function enablePage() {
  document.documentElement.dataset.browserharnessExtension = chrome.runtime.getManifest().version;
  window.dispatchEvent(new Event("browserharness-extension-ready"));
}

function arm() {
  if (armed || !isBrowserHarnessPage()) return false;
  armed = true;
  window.addEventListener("message", onPageMessage);
  chrome.runtime.sendMessage({ type: "allow-cors" }).then(enablePage, enablePage);
  return true;
}

if (!arm()) {
  const observer = new MutationObserver(() => {
    if (arm()) observer.disconnect();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
}
