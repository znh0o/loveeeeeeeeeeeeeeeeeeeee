


/* 우리두리 Web Push Service Worker */
const APP_URL = "./index.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};
    try { payload = event.data ? event.data.json() : {}; } catch { payload = {body: event.data?.text?.() || "새 알림이 도착했어요"}; }

    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    const visible = windows.find(client => client.visibilityState === "visible");
    if (visible) {
      visible.postMessage({type:"WOORIDURI_PUSH",...payload});
      return;
    }

    const title = payload.title || "우리두리";
    const options = {
      body: payload.body || "새 소식이 도착했어요.",
      tag: payload.tag || `wooriduri-${payload.roomId || "room"}`,
      renotify: true,
      data: {url: payload.url || APP_URL, roomId: payload.roomId || ""},
      vibrate: [120, 50, 120]
    };
    await self.registration.showNotification(title, options);
    try { if (self.navigator?.setAppBadge) await self.navigator.setAppBadge(1); } catch {}
  })());
});

self.addEventListener("notificationclick", event => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(event.notification.data?.url || APP_URL, self.location.href).href;
    const windows = await self.clients.matchAll({type:"window",includeUncontrolled:true});
    for (const client of windows) {
      if ("focus" in client) {
        try { await client.navigate(target); } catch {}
        return client.focus();
      }
    }
    if (self.clients.openWindow) return self.clients.openWindow(target);
  })());
});
