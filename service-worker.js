// DebtTracker service worker — caches the app shell (this file + its CDN
// dependencies) so the app keeps working offline after the first visit.
// This is what actually makes "Install App" meaningful rather than cosmetic:
// without a registered service worker, Chrome/Edge won't consider the page
// installable at all, and there'd be nothing serving the app when offline.

const CACHE_VERSION = "ledger-v1";
const APP_SHELL = [
  "./debt-dashboard.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-512-maskable.png",
  "https://cdnjs.cloudflare.com/ajax/libs/react/18.3.1/umd/react.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/react-dom/18.3.1/umd/react-dom.production.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/babel-standalone/7.24.7/babel.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js",
  "https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) =>
      // Cache what we can; a CDN hiccup during install shouldn't block the
      // whole service worker from activating.
      Promise.allSettled(APP_SHELL.map((url) => cache.add(url).catch(() => {})))
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

/* --- Background reminders. The service worker never has the app's Data
   Encryption Key, so it can never decrypt real entries — it only reads a
   small unencrypted record ("syncMeta") that the page itself mirrors: a
   due-soon count and a couple of timestamps. Never names, amounts, or dates.
   That's a deliberate, minimal exception to DebtTracker's zero-knowledge design,
   made only because the person explicitly opted in via Settings. --- */
const IDB_NAME = "ledger_debtdash_db";
const IDB_VERSION = 1;
const IDB_STORE = "kv";
const SYNC_META_KEY = "syncMeta";
const BACKUP_REMINDER_INTERVAL_MS = 1000 * 60 * 60 * 24 * 14; // nudge every 14 days at most

function swIdbGet(key) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readonly");
      const getReq = tx.objectStore(IDB_STORE).get(key);
      getReq.onsuccess = () => resolve(getReq.result ?? null);
      getReq.onerror = () => reject(getReq.error);
    };
    req.onerror = () => reject(req.error);
  });
}

function swIdbSet(key, value) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction(IDB_STORE, "readwrite");
      tx.objectStore(IDB_STORE).put(value, key);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  });
}

async function runPeriodicCheck() {
  let meta;
  try {
    meta = await swIdbGet(SYNC_META_KEY);
  } catch (e) {
    return; // IndexedDB unreachable — skip silently, try again next interval
  }
  if (!meta || !meta.enabled) return; // respect the opt-in toggle

  if (meta.dueSoonCount > 0) {
    await self.registration.showNotification("DebtTracker", {
      body: meta.dueSoonCount === 1
        ? "1 entry is due soon — open DebtTracker to review it."
        : `${meta.dueSoonCount} entries are due soon — open DebtTracker to review them.`,
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "ledger-due-soon",
    });
  }

  const now = Date.now();
  const sinceBackup = now - (meta.lastBackupAt || 0);
  const sincePrompt = now - (meta.lastBackupPromptAt || 0);
  if (sinceBackup > BACKUP_REMINDER_INTERVAL_MS && sincePrompt > BACKUP_REMINDER_INTERVAL_MS) {
    await self.registration.showNotification("DebtTracker", {
      body: "It's been a while since your last backup. Open DebtTracker to back up to your own cloud storage.",
      icon: "./icons/icon-192.png",
      badge: "./icons/icon-192.png",
      tag: "ledger-backup-reminder",
    });
    try { await swIdbSet(SYNC_META_KEY, { ...meta, lastBackupPromptAt: now }); } catch (e) { /* ignore */ }
  }
}

/* --- One-off Background Sync: retries a queued AI-assistant request once
   connectivity returns. The queued record briefly holds the user's own API
   key and message text UNENCRYPTED (this worker has no access to DebtTracker's
   encryption key) — every entry is scrubbed of its key and message content
   the instant a send attempt finishes, whether it succeeds or fails. --- */
const PENDING_SYNC_KEY = "pendingAssistantSync";
const BACKGROUND_SYNC_TAG = "ledger-assistant-retry";
const MAX_SYNC_ATTEMPTS = 5;

async function callAnthropicAPIFromSW(apiKey, model, history, systemPrompt) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      system: systemPrompt,
      messages: history.map((m) => ({ role: m.role, content: m.text })),
    }),
  });
  if (!res.ok) {
    let detail = "";
    try { detail = (await res.json()).error?.message || ""; } catch (e) { /* ignore */ }
    throw new Error(detail || `Request failed (${res.status})`);
  }
  const json = await res.json();
  const block = (json.content || []).find((b) => b.type === "text");
  return block ? block.text : "(empty response)";
}

async function handleAssistantRetrySync() {
  let queue;
  try {
    queue = (await swIdbGet(PENDING_SYNC_KEY)) || [];
  } catch (e) {
    return;
  }
  const pending = queue.filter((q) => q.status === "pending");
  if (!pending.length) return;

  let stillOffline = false;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (item.status !== "pending") continue;
    try {
      const reply = await callAnthropicAPIFromSW(item.apiKey, item.model, item.history, item.systemPrompt);
      queue[i] = { id: item.id, status: "done", reply };
    } catch (e) {
      const isNetwork = e instanceof TypeError; // fetch() throws TypeError for network-level failures
      const attempts = (item.attempts || 0) + 1;
      if (isNetwork && attempts < MAX_SYNC_ATTEMPTS) {
        queue[i] = { ...item, attempts };
        stillOffline = true;
      } else {
        queue[i] = { id: item.id, status: "failed", error: e.message || "Request failed" };
      }
    }
  }

  try { await swIdbSet(PENDING_SYNC_KEY, queue); } catch (e) { /* ignore */ }

  if (stillOffline) {
    // Rejecting tells the browser this sync attempt didn't fully finish, so
    // it retries again later with its own backoff — no manual timer needed.
    throw new Error("Still offline — will retry via background sync");
  }
}

self.addEventListener("sync", (event) => {
  if (event.tag === BACKGROUND_SYNC_TAG) event.waitUntil(handleAssistantRetrySync());
});

self.addEventListener("periodicsync", (event) => {
  if (event.tag === "ledger-periodic-check") event.waitUntil(runPeriodicCheck());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes("debt-dashboard.html") && "focus" in client) return client.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow("./debt-dashboard.html");
    })
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // The app's own HTML: network-first, so a person online always gets the
  // latest version, falling back to the cached copy the moment they're offline.
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match("./debt-dashboard.html")))
    );
    return;
  }

  // Everything else (CDN scripts, fonts, icons): cache-first, since these are
  // pinned to specific versions and won't change under the same URL.
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => cached);
    })
  );
});
