chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "allow-cors") return;
  // Do not touch declarativeNetRequest. Asking Chrome to evaluate header
  // rules makes it wait for this worker before every request, so a stalled
  // worker leaves the tab spinner on forever. Header rewriting also breaks
  // CheerpX (COEP treats the modified wasm/script as a failed worker init).
  sendResponse({ ok: true });
});

function keepPortAlive(port) {
  const timer = setInterval(() => {
    chrome.runtime.getPlatformInfo(() => void chrome.runtime.lastError);
    try {
      port.postMessage({ type: "ping" });
    } catch {
      clearInterval(timer);
    }
  }, 10_000);
  const stop = () => clearInterval(timer);
  port.onDisconnect.addListener(stop);
  return stop;
}

function postChunk(port, bytes) {
  const size = 32 * 1024;
  for (let offset = 0; offset < bytes.length; offset += size) {
    port.postMessage({
      type: "chunk",
      bytes: Array.from(bytes.subarray(offset, offset + size)),
    });
  }
}

async function forward(port, msg) {
  const stop = keepPortAlive(port);
  try {
    const response = await fetch(msg.url, {
      method: msg.method || "GET",
      headers: msg.headers || {},
      body: msg.body == null || msg.method === "GET" || msg.method === "HEAD" ? undefined : msg.body,
    });
    const headers = [];
    response.headers.forEach((value, key) => headers.push([key, value]));
    port.postMessage({
      type: "head",
      status: response.status,
      statusText: response.statusText,
      headers,
    });
    if (!response.body) {
      port.postMessage({ type: "done" });
      return;
    }
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      postChunk(port, value);
    }
    port.postMessage({ type: "done" });
  } catch (error) {
    try {
      port.postMessage({
        type: "error",
        message: error instanceof Error ? error.message : String(error),
      });
    } catch {
      // The page sees the port close when this post fails.
    }
  } finally {
    stop();
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "browserharness-fetch") return;

  port.onMessage.addListener((msg) => {
    if (!msg || msg.type === "ping") return;
    void forward(port, msg);
  });
});
