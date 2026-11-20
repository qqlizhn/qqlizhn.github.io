function corsRule(tabId) {
  return {
    id: tabId,
    priority: 1,
    action: {
      type: "modifyHeaders",
      responseHeaders: [
        { header: "access-control-allow-origin", operation: "set", value: "*" },
        {
          header: "access-control-allow-methods",
          operation: "set",
          value: "GET, POST, PUT, PATCH, DELETE, OPTIONS",
        },
        { header: "access-control-allow-headers", operation: "set", value: "*" },
        { header: "access-control-expose-headers", operation: "set", value: "*" },
      ],
    },
    condition: {
      urlFilter: "*",
      resourceTypes: ["xmlhttprequest"],
      tabIds: [tabId],
    },
  };
}

function allowTab(tabId) {
  if (!tabId) return Promise.resolve();
  return chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [tabId],
    addRules: [corsRule(tabId)],
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "allow-cors") return;
  const tabId = sender.tab?.id;
  allowTab(tabId).then(
    () => sendResponse({ ok: true }),
    (error) => sendResponse({ ok: false, error: String(error) }),
  );
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.declarativeNetRequest
    .updateSessionRules({ removeRuleIds: [tabId] })
    .catch(() => undefined);
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
