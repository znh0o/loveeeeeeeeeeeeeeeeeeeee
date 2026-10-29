/* 우리두리 Web Push Service Worker */
const APP_URL = "./index.html";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));

// Public app files only. Never intercept Firebase data, Auth, release checks or push APIs.
const PUBLIC_SHELL_CACHE="wooriduri-public-shell-v1";
const PUBLIC_ROOT=self.registration.scope;
const PUBLIC_INDEX=new URL("index.html",PUBLIC_ROOT).href;
const PUBLIC_PATHS=new Set([
  "index.html","app-core.js","ui.css","NanumPenScript-Regular.woff2",
  "manifest.webmanifest","apple-touch-icon.png","icon-192.png","icon-512.png"
].map(file=>new URL(file,PUBLIC_ROOT).href));
const PUBLIC_SDK=new Set(["app","auth","database"].map(name=>
  `https://www.gstatic.com/firebasejs/10.12.0/firebase-${name}.js`));
const PUBLIC_WARM_URLS=[
  PUBLIC_INDEX,new URL("app-core.js?v=2026.10.29.1",PUBLIC_ROOT).href,
  new URL("ui.css?v=2026.10.15.4",PUBLIC_ROOT).href,
  new URL("NanumPenScript-Regular.woff2",PUBLIC_ROOT).href,...PUBLIC_SDK
];

async function fetchPublicFile(request,key){
  const response=await fetch(request);
  if(response.ok&&response.type!=="opaque"){
    try{await (await caches.open(PUBLIC_SHELL_CACHE)).put(key,response.clone())}catch{}
  }
  return response;
}
async function readPublicFile(key){
  try{return await (await caches.open(PUBLIC_SHELL_CACHE)).match(key)}catch{return null}
}
async function cachedVersionSatisfies(response,requested){
  if(!requested||!/^\d{4}\.\d{2}\.\d{2}\.\d+$/.test(requested))return true;
  const html=await response.clone().text();
  const version=html.match(/name="wooriduri-version"\s+content="([^"]+)"/)?.[1];
  return !!version&&version.localeCompare(requested,undefined,{numeric:true})>=0;
}
self.addEventListener("fetch",event=>{
  const request=event.request;
  if(request.method!=="GET")return;
  const url=new URL(request.url),canonical=url.origin+url.pathname;
  const navigation=request.mode==="navigate"&&(canonical===PUBLIC_INDEX||canonical===PUBLIC_ROOT);
  if(!navigation&&!PUBLIC_PATHS.has(canonical)&&!PUBLIC_SDK.has(canonical))return;
  const key=navigation?PUBLIC_INDEX:request.url;
  const freshRequest=navigation?new Request(request,{cache:"no-cache"}):request;
  const network=fetchPublicFile(freshRequest,key);
  event.waitUntil(network.then(()=>{},()=>{}));
  event.respondWith((async()=>{
    const saved=await readPublicFile(key);
    const refresh=request.cache==="reload"||request.cache==="no-store"||url.searchParams.has("_updateCheck");
    if(saved&&!refresh&&(!navigation||await cachedVersionSatisfies(saved,url.searchParams.get("_appVersion"))))return saved;
    try{return await network}catch(error){if(saved)return saved;throw error}
  })());
});
self.addEventListener("message",event=>{
  if(event.data?.type!=="WOORIDURI_WARM_PUBLIC_CACHE")return;
  // The page cannot supply a URL to cache; this list contains no user content.
  event.waitUntil(Promise.allSettled(PUBLIC_WARM_URLS.map(async url=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),8000);
    try{await fetchPublicFile(new Request(url,{mode:"cors",signal:controller.signal}),url)}
    finally{clearTimeout(timer)}
  })));
});

async function clearRoomNotifications(roomId=""){
  try{
    const notifications = await self.registration.getNotifications();

    for(const notification of notifications){
      if(String(notification.tag||"").startsWith("wooriduri-period-")) continue;
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
