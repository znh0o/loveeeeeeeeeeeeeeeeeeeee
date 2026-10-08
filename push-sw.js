/* 우리두리 Web Push Service Worker */
const APP_URL = "./index.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

async function clearRoomNotifications(roomId=""){
  try{
    const notifications = await self.registration.getNotifications();

    for(const notification of notifications){
      const notificationRoom = notification.data?.roomId || "";

      const sameRoom =
        !roomId ||
        !notificationRoom ||
        notificationRoom === roomId ||
        notification.tag === `wooriduri-${roomId}`;

      if(sameRoom){
        notification.close();
      }
    }
  }catch{}

  try{
    if(self.navigator?.clearAppBadge){
      await self.navigator.clearAppBadge();
    }
  }catch{}
}

self.addEventListener("push", event => {
  event.waitUntil((async () => {
    let payload = {};

    try{
      payload = event.data
        ? event.data.json()
        : {};
    }catch{
      payload = {
        body:
          event.data?.text?.()
          || "새 알림이 도착했어요"
      };
    }

    /*
     * 다른 기기에서 메시지를 읽었을 때
     * clear push를 받으면 알림과 배지를 제거한다.
     */
    if(payload.action === "clear"){
      await clearRoomNotifications(
        payload.roomId || ""
      );

      const windows =
        await self.clients.matchAll({
          type:"window",
          includeUncontrolled:true
        });

      for(const client of windows){
        client.postMessage({
          type:"WOORIDURI_CLEAR",
          roomId:payload.roomId || ""
        });
      }

      return;
    }

    /*
     * 현재 우리두리를 보고 있으면
     * 시스템 알림 대신 페이지에 전달
     */
    const windows =
      await self.clients.matchAll({
        type:"window",
        includeUncontrolled:true
      });

    const visible =
      windows.find(
        client =>
          client.visibilityState === "visible"
      );

    // WebKit/iOS requires each push to display a notification. Never silently discard
    // an iOS push just because an app window is still reported as visible after locking.
    const isAppleWebKit = /iPhone|iPad|iPod/i.test(self.navigator?.userAgent || "");
    if(visible && visible.focused === true && !isAppleWebKit && !payload.forceShow){
      visible.postMessage({
        type:"WOORIDURI_PUSH",
        ...payload
      });

      return;
    }

    const title =
      payload.title || "우리두리";

    const options = {
      body:
        payload.body
        || "새 소식이 도착했어요.",

      tag:
        payload.tag
        || `wooriduri-${payload.roomId || "room"}`,

      renotify:true,

      data:{
        url:
          payload.url || `${APP_URL}?open=chat&room=${encodeURIComponent(payload.roomId || "main")}`,

        roomId:
          payload.roomId || ""
      },

      vibrate:[
        120,
        50,
        120
      ]
    };

    await self.registration.showNotification(
      title,
      options
    );

    /*
     * 앱 아이콘 배지
     */
    try{
      if(self.navigator?.setAppBadge){
        await self.navigator.setAppBadge(1);
      }
    }catch{}
  })());
});

self.addEventListener(
  "notificationclick",
  event => {

    event.notification.close();

    event.waitUntil((async () => {

      const target =
        new URL(
          event.notification.data?.url
            || APP_URL,
          self.location.href
        ).href;

      const windows =
        await self.clients.matchAll({
          type:"window",
          includeUncontrolled:true
        });

      for(const client of windows){

        if("focus" in client){

          try{
            await client.navigate(target);
          }catch{}

          return client.focus();
        }
      }

      if(self.clients.openWindow){
        return self.clients.openWindow(target);
      }

    })());
  }
);
