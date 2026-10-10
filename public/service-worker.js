/* Only notification routing lives here. Planner pages and account data are never cached. */
const STORE_NAME = "routing";
const DATABASE_NAME = "wakey-web-reminders-v1";
const GRACE_MS = 90_000;
const appRoot = new URL(self.registration.scope);

function database() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE_NAME);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}
async function routing(write) {
  const db = await database();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(
        STORE_NAME,
        write === undefined ? "readonly" : "readwrite",
      );
      const store = transaction.objectStore(STORE_NAME);
      const request =
        write === undefined ? store.get("active") : store.put(write, "active");
      let result = null;
      request.onsuccess = () => {
        result = request.result ?? null;
      };
      transaction.oncomplete = () =>
        resolve(write === undefined ? result : write);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
function insideApp(url) {
  try {
    const candidate = new URL(url);
    return (
      candidate.origin === appRoot.origin &&
      candidate.pathname.startsWith(appRoot.pathname)
    );
  } catch {
    return false;
  }
}
function validRecord(record) {
  return (
    record &&
    typeof record.id === "string" &&
    record.id.startsWith("wakey:") &&
    record.id.length <= 512 &&
    Number.isFinite(record.at) &&
    typeof record.title === "string" &&
    record.title.length > 0 &&
    record.title.length <= 200 &&
    typeof record.body === "string" &&
    record.body.length <= 4000 &&
    typeof record.kind === "string" &&
    record.kind.length <= 50
  );
}

self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("message", (event) => {
  if (!event.source || !insideApp(event.source.url)) return;
  const command = event.data;
  if (!command || command.type !== "wakey-reminder-owner") return;
  event.waitUntil(
    (async () => {
      try {
        const next =
          typeof command.ownerId === "string" &&
          typeof command.deviceId === "string"
            ? {
                ownerId: command.ownerId,
                deviceId: command.deviceId,
                revision: command.revision ?? null,
              }
            : null;
        await routing(next);
        const notifications = await self.registration.getNotifications();
        for (const notification of notifications) {
          if (!next || notification.data?.ownerId !== next.ownerId)
            notification.close();
        }
        event.ports[0]?.postMessage({ ok: true });
      } catch {
        event.ports[0]?.postMessage({ ok: false });
      }
    })(),
  );
});
self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let payload;
      try {
        payload = event.data?.json();
      } catch {
        return;
      }
      if (!payload || !validRecord(payload.reminder)) return;
      const active = await routing();
      if (
        !active ||
        payload.ownerId !== active.ownerId ||
        payload.deviceId !== active.deviceId
      )
        return;
      if (
        active.revision &&
        payload.revision &&
        payload.revision !== active.revision
      )
        return;
      const record = payload.reminder;
      const elapsed = Date.now() - record.at;
      // A notification delayed beyond this short grace window must not describe an obsolete task as due.
      if (elapsed < -5_000 || elapsed > GRACE_MS) return;
      const fingerprint = JSON.stringify([
        record.at,
        record.title,
        record.body,
        record.kind,
        record.entryId ?? null,
      ]);
      // Safari requires a visible notification for each valid push. A stable tag replaces retries.
      await self.registration.showNotification(record.title, {
        body: record.body,
        icon: new URL("icon-192.png", appRoot).href,
        badge: new URL("icon-192.png", appRoot).href,
        tag: `${record.id}:${fingerprint}`,
        renotify: false,
        data: {
          ownerId: active.ownerId,
          deviceId: active.deviceId,
          reminder: record,
          fingerprint,
          url: appRoot.href,
        },
      });
      for (const client of await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      })) {
        if (insideApp(client.url))
          client.postMessage({
            type: "wakey-reminder-due",
            ownerId: active.ownerId,
            deviceId: active.deviceId,
            reminder: record,
          });
      }
    })(),
  );
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const active = await routing();
      const data = event.notification.data;
      if (
        !active ||
        data?.ownerId !== active.ownerId ||
        data?.deviceId !== active.deviceId
      )
        return;
      const clients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      const existing = clients.find((client) => insideApp(client.url));
      const opened = existing
        ? await existing.focus()
        : await self.clients.openWindow(appRoot.href);
      opened?.postMessage({
        type: "wakey-reminder-open",
        ownerId: active.ownerId,
        deviceId: active.deviceId,
        reminder: data.reminder,
      });
    })(),
  );
});
