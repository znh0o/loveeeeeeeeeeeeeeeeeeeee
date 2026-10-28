/* 우리두리 2.1 Cloudflare Worker — Firebase Auth + RTDB 검증 + Web Push
 * 기존 Worker URL, VAPID_PUBLIC_KEY, Firebase 데이터 구조 보존.
 * Cloudflare Secret: VAPID_PRIVATE_KEY (기존 값 유지; 웹에 노출 금지)
 * Cloudflare KV binding: PERIOD_KV; Cron: 00:00, 03:00, 06:00 UTC.
 * Web Push is best effort: APNs/device policies may delay/suppress notifications.
 */
const PROJECT_ID = "first-app-ffb0b";
const DATABASE_URL = "https://first-app-ffb0b-default-rtdb.asia-southeast1.firebasedatabase.app";
const ROOM_ID = "main";
const FIXED_EMAILS = Object.freeze({
  "user1@wooriduri.app": "user1",
  "user2@wooriduri.app": "user2"
});
const JWKS_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const VAPID_PUBLIC_KEY = "BBfHpRyDJ2a7ETgh2SE10GxSOG83dlqXWaqt5v6Go1ZU-Z0FFsIPCZZt1Ht8EjkwCahLpEGdTTqCGPKfgBgwm0o";
const VAPID_SUBJECT = "https://wooriduri-push.yeojunho1210.workers.dev";
const textEncoder = new TextEncoder();
let keyCache = { expiresAt:0, keys:[] };

export default {
  async fetch(request, env){
    const cors = corsHeaders();
    if(request.method === "OPTIONS") return new Response(null,{status:204,headers:cors});
    const pathname = new URL(request.url).pathname;
    if(request.method === "GET" && (pathname === "/" || pathname === "/health")){
      return jsonResponse({ok:true,service:"wooriduri-push",version:"2.1",ready:Boolean(env.VAPID_PRIVATE_KEY),remindersReady:Boolean(env.PERIOD_KV),mode:"firebase-auth-verified"},200,cors);
    }
    if(request.method!=="POST" || !["/notify","/clear","/diagnose","/period-sync"].includes(pathname)){
      return jsonResponse({ok:false,error:"NOT_FOUND"},404,cors);
    }
    if(!env.VAPID_PRIVATE_KEY){return jsonResponse({ok:false,error:"VAPID_PRIVATE_KEY_NOT_SET"},503,cors);}
    const authHeader=request.headers.get("Authorization")||"";
    const match=/^Bearer ([A-Za-z0-9_\-.]+)$/.exec(authHeader);
    if(!match) return jsonResponse({ok:false,error:"AUTH_REQUIRED"},401,cors);
    try{
      const user=await verifyFirebaseToken(match[1]);
      if(!user) return jsonResponse({ok:false,error:"INVALID_AUTH"},401,cors);
      const raw=await request.text();
      if(raw.length>2048) return jsonResponse({ok:false,error:"BODY_TOO_LARGE"},413,cors);
      let data;
      try{data=JSON.parse(raw||"{}");}catch{return jsonResponse({ok:false,error:"INVALID_JSON"},400,cors);}
      if(data.roomId!==ROOM_ID) return jsonResponse({ok:false,error:"INVALID_ROOM"},400,cors);

      if(pathname==="/period-sync"){
        if(!env.PERIOD_KV) return jsonResponse({ok:false,error:"REMINDERS_NOT_CONFIGURED"},503,cors);
        // The client supplies no dates or endpoints. Read only Firebase data that its token may access.
        const [rawRecords,user1Subscriptions,user2Subscriptions]=await Promise.all([
          dbRead(`rooms/main/decoInfo/periodTracking/records`,match[1]),
          dbRead(`rooms/main/user1/pushSubscriptions`,match[1]),
          dbRead(`rooms/main/user2/pushSubscriptions`,match[1])
        ]);
        const records=normalizePeriodRecords(rawRecords);
        const compactSubscriptions=raw=>Object.values(raw||{}).filter(isValidSubscription).slice(0,16)
          .map(subscription=>({endpoint:subscription.endpoint,
            keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth},
            userAgent:String(subscription.userAgent||"").slice(0,240)}));
        const compactUser1=compactSubscriptions(user1Subscriptions);
        const compactUser2=compactSubscriptions(user2Subscriptions);
        const entries=[
          ["period:records",JSON.stringify(records)],
          ["period:subscriptions:user1",JSON.stringify(compactUser1)],
          ["period:subscriptions:user2",JSON.stringify(compactUser2)]
        ];
        await Promise.all(entries.map(async ([key,value])=>{
          if(await env.PERIOD_KV.get(key)!==value) await env.PERIOD_KV.put(key,value);
        }));
        return jsonResponse({ok:true,recordCount:Object.keys(records).length,
          subscriberCount:user.slot==="user1"?compactUser1.length:compactUser2.length},200,cors);
      }

      if(pathname==="/diagnose"){
        const [mine,partner]=await Promise.all([
          dbRead(`rooms/main/${user.slot}/pushSubscriptions`,match[1]),
          dbRead(`rooms/main/${otherSlot(user.slot)}/pushSubscriptions`,match[1])
        ]);
        return jsonResponse({ok:true,subscriberCount:countValid(mine),partnerSubscriberCount:countValid(partner),
          myDevices:deviceSummaries(mine),partnerDevices:deviceSummaries(partner)},200,cors);
      }
      let receiverSlot;
      let payload;
      let excludeKey="";
      if(pathname==="/clear"){
        receiverSlot=user.slot;
        excludeKey=String(data.clientId||"");
        if(excludeKey.length>120) return jsonResponse({ok:false,error:"INVALID_CLIENT"},400,cors);
        payload=JSON.stringify({action:"clear",roomId:ROOM_ID,tag:`wooriduri-${ROOM_ID}`});
      } else {
        const id=cleanId(data.messageId,8,180);
        if(!id || data.senderSlot!==user.slot) return jsonResponse({ok:false,error:"INVALID_SENDER"},400,cors);
        const message=await dbRead(`chat/main/${id}`,match[1]);
        if(!message || message.senderSlot!==user.slot || message.type==="story"){
          return jsonResponse({ok:false,error:"MESSAGE_NOT_FOUND"},404,cors);
        }
        // 알림은 최근 메시지만 보낸다. 과거 메시지 ID 재전송 악용 방지.
        const created=Number(message.clientCreatedAt||message.timestamp||message.createdAt||0);
        if(!Number.isFinite(created) || Math.abs(Date.now()-created)>24*60*60*1000){
          return jsonResponse({ok:false,error:"STALE_MESSAGE"},409,cors);
        }
        receiverSlot=otherSlot(user.slot);
        payload=JSON.stringify(buildNotificationPayload(message,ROOM_ID,id));
      }
      const allSubscriptions=await dbRead(`rooms/main/${receiverSlot}/pushSubscriptions`,match[1]);
      const entries=Object.entries(allSubscriptions||{})
        .filter(([key,sub])=>key!==excludeKey&&isValidSubscription(sub));
      // iOS/WebKit revokes subscriptions for silent pushes. Never send /clear to Apple devices.
      const isApple=(sub)=>/iPhone|iPad|iPod/i.test(String(sub.userAgent||"")) ||
        /(^|\.)push\.apple\.com$/i.test(new URL(sub.endpoint).hostname);
      const skippedIOS=pathname==="/clear"?entries.filter(([,sub])=>isApple(sub)).length:0;
      const valid=entries.filter(([,sub])=>pathname!=="/clear"||!isApple(sub)).slice(0,16);
      if(!valid.length) return jsonResponse({ok:true,sent:0,failed:0,staleKeys:[],skippedIOS,
        reason:skippedIOS?"IOS_SILENT_PUSH_SKIPPED":"NO_SUBSCRIPTIONS"},200,cors);
      const results=await Promise.all(valid.map(async ([key,subscription])=>{
        try{
          // WebKit must display every received push, even when background state is reported incorrectly.
          const deliverPayload=pathname==="/notify"&&isApple(subscription)
            ? JSON.stringify({...JSON.parse(payload),forceShow:true}) : payload;
          const response=await sendWebPushWithRetry(subscription,deliverPayload,env.VAPID_PRIVATE_KEY);
          const status=response.status;
          const stale=status===404||status===410;
          const ok=response.ok;
          // Apple responses include actionable HTTP status; never expose subscription endpoint or keys.
          const detail=ok?"":(await response.text().catch(()=>"")).slice(0,100);
          return {key,ok,status,stale,detail};
        }catch(error){
          return {key,ok:false,status:0,stale:false,detail:String(error?.message||error).slice(0,100)};
        }
      }));
      const sent=results.filter(r=>r.ok).length;
      const staleKeys=results.filter(r=>r.stale).map(r=>r.key);
      // Only sanitized diagnostic info leaves Worker. Keys are Firebase subscription record IDs, not endpoint URLs.
      return jsonResponse({ok:sent>0,sent,failed:results.length-sent,staleKeys,skippedIOS,
        results:results.map(r=>({key:r.key,status:r.status,ok:r.ok,detail:r.detail}))},sent>0?200:502,cors);
    }catch(error){
      if(error?.message==="AUTH_INVALID") return jsonResponse({ok:false,error:"INVALID_AUTH"},401,cors);
      if(error?.message==="DB_READ_FAILED") return jsonResponse({ok:false,error:"DATABASE_READ_FAILED"},502,cors);
      console.error("wooriduri worker failure",error?.message||error);
      return jsonResponse({ok:false,error:"SERVER_ERROR"},500,cors);
    }
  },
  async scheduled(controller,env){
    await sendScheduledPeriodReminders(env,new Date(controller.scheduledTime));
  }
};

function otherSlot(slot){return slot==="user1"?"user2":"user1";}
function isValidSubscription(s){
  if(!s||typeof s.endpoint!=="string"||typeof s.keys?.p256dh!=="string"||typeof s.keys?.auth!=="string") return false;
  try{ const u=new URL(s.endpoint);return u.protocol==="https:"&&!u.username&&!u.password; }catch{return false;}
}
function countValid(data){return Object.values(data||{}).filter(isValidSubscription).length;}
function deviceSummaries(data){
  return Object.values(data||{}).filter(isValidSubscription).slice(0,20).map(s=>({
    platform: String(s.userAgent||"").includes("iPhone")||String(s.userAgent||"").includes("iPad")?"iOS":
      String(s.userAgent||"").includes("Android")?"Android":"Other",
    updatedAt:Number(s.updatedAt||0),
    pushProvider:(()=>{try{const host=new URL(s.endpoint).hostname;return host.includes("apple")?"Apple":host.includes("google")||host.includes("fcm")?"Google":"Other";}catch{return "Unknown"}})()
  }));
}
function corsHeaders(){return {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Methods":"GET,POST,OPTIONS",
  "Access-Control-Allow-Headers":"Content-Type,Authorization","Cache-Control":"no-store","Vary":"Origin"};}
function jsonResponse(value,status,headers={}){return new Response(JSON.stringify(value),{status,headers:{...headers,"Content-Type":"application/json; charset=utf-8"}});}
function cleanId(value,min,max){
  const result=String(value||"").trim();return result.length>=min&&result.length<=max&&!/[.#$\[\]\/]/.test(result)?result:"";
}
function decodeBase64urlJson(text){try{return JSON.parse(new TextDecoder().decode(base64UrlDecode(text)));}catch{return null;}}
async function getJwks(kid,force=false){
  if(!force && keyCache.expiresAt>Date.now() && keyCache.keys.some(k=>k.kid===kid)) return keyCache.keys;
  const res=await fetch(JWKS_URL,{headers:{Accept:"application/json"}});
  if(!res.ok) throw new Error("PUBLIC_KEYS_UNAVAILABLE");
  const data=await res.json();
  if(!Array.isArray(data.keys)) throw new Error("PUBLIC_KEYS_INVALID");
  const maxAge=Math.min(3600,Math.max(60,Number((res.headers.get("Cache-Control")||"").match(/max-age=(\d+)/)?.[1]||300)));
  keyCache={keys:data.keys,expiresAt:Date.now()+maxAge*1000};
  return data.keys;
}
async function verifyFirebaseToken(token){
  const parts=token.split(".");
  if(parts.length!==3 || token.length>8192) throw new Error("AUTH_INVALID");
  const header=decodeBase64urlJson(parts[0]);
  const claims=decodeBase64urlJson(parts[1]);
  const now=Math.floor(Date.now()/1000);
  if(!header||header.alg!=="RS256"||typeof header.kid!=="string"||!claims ||
     claims.aud!==PROJECT_ID||claims.iss!==`https://securetoken.google.com/${PROJECT_ID}`||
     typeof claims.sub!=="string"||!claims.sub||claims.sub.length>128||
     typeof claims.exp!=="number"||claims.exp<=now||
     typeof claims.iat!=="number"||claims.iat>now||
     typeof claims.auth_time!=="number"||claims.auth_time>now){throw new Error("AUTH_INVALID");}
  const slot=FIXED_EMAILS[String(claims.email||"").toLowerCase()];
  if(!slot) throw new Error("AUTH_INVALID");
  const keys=await getJwks(header.kid);
  const jwk=keys.find(key=>key.kid===header.kid&&key.kty==="RSA"&&key.alg==="RS256");
  if(!jwk) throw new Error("AUTH_INVALID");
  const key=await crypto.subtle.importKey("jwk",jwk,{name:"RSASSA-PKCS1-v1_5",hash:"SHA-256"},false,["verify"]);
  const valid=await crypto.subtle.verify("RSASSA-PKCS1-v1_5",key,base64UrlDecode(parts[2]),textEncoder.encode(`${parts[0]}.${parts[1]}`));
  if(!valid) throw new Error("AUTH_INVALID");
  return {slot,email:claims.email,uid:claims.sub};
}
async function dbRead(path,idToken){
  const url=`${DATABASE_URL}/${path}.json?auth=${encodeURIComponent(idToken)}`;
  const res=await fetch(url,{headers:{Accept:"application/json"},redirect:"manual"});
  if(!res.ok) throw new Error("DB_READ_FAILED");
  return res.json();
}

// Calendar-only reminders. Dates are entered by Se-eun; no cycle prediction is made.
const seoulDateFormatter=new Intl.DateTimeFormat("en-US",{
  timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"
});
function seoulDateKey(now){
  const parts=Object.fromEntries(seoulDateFormatter.formatToParts(now)
    .filter(part=>["year","month","day"].includes(part.type))
    .map(part=>[part.type,part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function addCalendarDays(dateKey,days){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)||!Number.isInteger(days)) return null;
  const date=new Date(`${dateKey}T00:00:00Z`);
  if(Number.isNaN(date.getTime())||date.toISOString().slice(0,10)!==dateKey) return null;
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
function normalizePeriodRecords(raw){
  return Object.fromEntries(Object.entries(raw||{})
    .filter(([id,record])=>/^[A-Za-z0-9_-]{8,180}$/.test(id)&&
      (record?.by==="user2"||record?.by==null)&&
      addCalendarDays(record.startDate,0)&&
      (!record.endDate||(addCalendarDays(record.endDate,0)&&record.endDate>=record.startDate)))
    .map(([id,record])=>[id,{startDate:record.startDate,endDate:record.endDate||""}]));
}
function duePeriodAlerts(records,now){
  const today=seoulDateKey(now);
  const rows=Object.entries(records||{});
  const alerts=[];
  for(const [id,record] of rows){
    if(addCalendarDays(record.startDate,-14)===today){
      alerts.push({id,kind:"junho",slot:"user1",eventDate:record.startDate});
    }
    if(record.endDate&&addCalendarDays(record.endDate,2)===today&&
      !rows.some(([nextId,next])=>nextId!==id&&next.startDate>record.startDate)){
      alerts.push({id,kind:"seeun",slot:"user2",eventDate:record.endDate});
    }
  }
  return alerts;
}
function isApplePush(subscription){
  return /iPhone|iPad|iPod/i.test(String(subscription.userAgent||""))||
    /(^|\.)push\.apple\.com$/i.test(new URL(subscription.endpoint).hostname);
}
async function sendScheduledPeriodReminders(env,now){
  if(!env.PERIOD_KV||!env.VAPID_PRIVATE_KEY) return;
  const records=JSON.parse(await env.PERIOD_KV.get("period:records")||"{}");
  const alerts=duePeriodAlerts(records,now);
  for(const alert of alerts){
    const marker=`period:sent:${alert.kind}:${alert.id}:${alert.eventDate}`;
    if(await env.PERIOD_KV.get(marker)) continue;
    const rows=JSON.parse(await env.PERIOD_KV.get(`period:subscriptions:${alert.slot}`)||"[]");
    if(!Array.isArray(rows)) continue;
    const payload={title:"우리두리",roomId:ROOM_ID,kind:"period-reminder",
      body:alert.kind==="junho"?"세은의 예정일이 2주 남았어요":"다음 예정일을 달력에 적어 주세요",
      tag:`wooriduri-period-${alert.kind}-${alert.id}`,url:"./index.html?open=calendar"};
    const results=await Promise.all(rows.filter(isValidSubscription).slice(0,16)
      .map(async subscription=>{
        try{
          const message=JSON.stringify(isApplePush(subscription)?{...payload,forceShow:true}:payload);
          const response=await sendWebPushWithRetry(subscription,message,env.VAPID_PRIVATE_KEY);
          return response.ok;
        }catch{return false;}
      }));
    if(results.some(Boolean)){
      await env.PERIOD_KV.put(marker,"1",{expirationTtl:60*60*24*45});
      console.info("period reminder sent",alert.kind,results.filter(Boolean).length);
    }else{
      console.warn("period reminder pending",alert.kind,"subscriptions",rows.length);
    }
  }
}

/* Web Push payload encryption + VAPID signing */
function buildNotificationPayload(
  message,
  roomId,
  messageId
){

  const sender =

    message.senderName
    ||
    message.ownerName
    ||
    message.sender
    ||
    "상대방";


  const type =
    message.type || "text";


  let title =
    sender;


  let body =
    "새 메시지가 도착했어요";


  if(type === "image"){

    body =
      "사진을 보냈어요 📷";

  }else if(type === "audio"){

    body =
      "음성 메시지를 보냈어요 🎙️";

  }else{

    body =
      compactText(
        message.text || body
      );
  }


  return {

    title,

    body,

    roomId,

    messageId,

    type,

    tag:
      `wooriduri-${roomId}`,

    url:
      `./index.html?open=chat&room=${encodeURIComponent(roomId)}`
  };
}


/*
 * 알림 글자 제한
 */
function compactText(value){

  const normalized =
    String(value)
      .replace(
        /\s+/g,
        " "
      )
      .trim();


  return (
    normalized.length > 110
  )
    ?
    `${normalized.slice(0,107)}…`
    :
    normalized;
}


/*
 * 실제 Web Push
 */
// Retry short-lived push-provider failures (including APNs 429/5xx).
// Re-encrypt each attempt: a fresh salt and ephemeral ECDH key are required.
async function sendWebPushWithRetry(subscription, payloadText, privateKey){
  let response;
  for(let attempt=0; attempt<3; attempt++){
    response=await sendWebPush(subscription,payloadText,privateKey);
    if(response.ok || ![408,425,429,500,502,503,504].includes(response.status)) return response;
    // Dispose response body before retrying.
    await response.body?.cancel().catch(()=>{});
    await new Promise(resolve=>setTimeout(resolve,500*(attempt+1)));
  }
  return response;
}

async function sendWebPush(
  subscription,
  payloadText,
  privateKeyBase64Url
){

  const endpoint =
    subscription.endpoint;


  const encryptedBody =
    await encryptPayload(
      subscription,
      payloadText
    );


  const jwt =
    await createVapidJwt(
      endpoint,
      privateKeyBase64Url
    );


  return fetch(
    endpoint,

    {
      method:"POST",

      headers:{

        Authorization:
          `vapid t=${jwt}, k=${VAPID_PUBLIC_KEY}`,

        "Content-Encoding":
          "aes128gcm",

        "Content-Type":
          "application/octet-stream",

        TTL:
          "86400",

        Urgency:
          "high"
      },

      body:
        encryptedBody
    }
  );
}


/*
 * VAPID JWT
 */
async function createVapidJwt(
  endpoint,
  privateKeyBase64Url
){

  const publicKey =
    base64UrlDecode(
      VAPID_PUBLIC_KEY
    );


  const privateKey =
    base64UrlDecode(
      privateKeyBase64Url
    );


  if(
    publicKey.length !== 65
    ||
    publicKey[0] !== 4
    ||
    privateKey.length !== 32
  ){

    throw new Error(
      "INVALID_VAPID_KEY"
    );
  }


  const key =
    await crypto.subtle.importKey(

      "jwk",

      {
        kty:"EC",

        crv:"P-256",

        x:
          base64UrlEncode(
            publicKey.slice(
              1,
              33
            )
          ),

        y:
          base64UrlEncode(
            publicKey.slice(
              33,
              65
            )
          ),

        d:
          base64UrlEncode(
            privateKey
          ),

        ext:false,

        key_ops:[
          "sign"
        ]
      },

      {
        name:"ECDSA",
        namedCurve:"P-256"
      },

      false,

      [
        "sign"
      ]
    );


  const header =
    base64UrlEncode(

      textEncoder.encode(

        JSON.stringify({
          typ:"JWT",
          alg:"ES256"
        })
      )
    );


  const claims =
    base64UrlEncode(

      textEncoder.encode(

        JSON.stringify({

          aud:
            new URL(
              endpoint
            ).origin,

          exp:
            Math.floor(
              Date.now() / 1000
            )
            +
            12 * 60 * 60,

          sub:
            VAPID_SUBJECT
        })
      )
    );


  const unsignedToken =
    `${header}.${claims}`;


  let signature =
    new Uint8Array(

      await crypto.subtle.sign(

        {
          name:"ECDSA",
          hash:"SHA-256"
        },

        key,

        textEncoder.encode(
          unsignedToken
        )
      )
    );


  if(signature.length !== 64){

    signature =
      derToJose(
        signature,
        32
      );
  }


  return (
    `${unsignedToken}.`
    +
    base64UrlEncode(
      signature
    )
  );
}


/*
 * Web Push 암호화
 */
async function encryptPayload(
  subscription,
  payloadText
){

  const userPublicKey =
    base64UrlDecode(
      subscription.keys.p256dh
    );


  const authSecret =
    base64UrlDecode(
      subscription.keys.auth
    );


  const serverKeys =
    await crypto.subtle.generateKey(

      {
        name:"ECDH",
        namedCurve:"P-256"
      },

      true,

      [
        "deriveBits"
      ]
    );


  const serverPublicKey =
    new Uint8Array(

      await crypto.subtle.exportKey(
        "raw",
        serverKeys.publicKey
      )
    );


  const importedUserKey =
    await crypto.subtle.importKey(

      "raw",

      userPublicKey,

      {
        name:"ECDH",
        namedCurve:"P-256"
      },

      false,

      []
    );


  const sharedSecret =
    new Uint8Array(

      await crypto.subtle.deriveBits(

        {
          name:"ECDH",

          public:
            importedUserKey
        },

        serverKeys.privateKey,

        256
      )
    );


  const keyInfo =
    concatBytes(

      textEncoder.encode(
        "WebPush: info\0"
      ),

      userPublicKey,

      serverPublicKey
    );


  const prkKey =
    await hmacSha256(
      authSecret,
      sharedSecret
    );


  const ikm =
    await hkdfExpand(
      prkKey,
      keyInfo,
      32
    );


  const salt =
    crypto.getRandomValues(
      new Uint8Array(16)
    );


  const prk =
    await hmacSha256(
      salt,
      ikm
    );


  const contentEncryptionKey =
    await hkdfExpand(

      prk,

      textEncoder.encode(
        "Content-Encoding: aes128gcm\0"
      ),

      16
    );


  const nonce =
    await hkdfExpand(

      prk,

      textEncoder.encode(
        "Content-Encoding: nonce\0"
      ),

      12
    );


  const plaintext =
    concatBytes(

      textEncoder.encode(
        payloadText
      ),

      new Uint8Array([2])
    );


  const aesKey =
    await crypto.subtle.importKey(

      "raw",

      contentEncryptionKey,

      {
        name:"AES-GCM"
      },

      false,

      [
        "encrypt"
      ]
    );


  const ciphertext =
    new Uint8Array(

      await crypto.subtle.encrypt(

        {
          name:"AES-GCM",
          iv:nonce
        },

        aesKey,

        plaintext
      )
    );


  const recordSize =
    4096;


  const recordSizeBytes =
    new Uint8Array(4);


  new DataView(
    recordSizeBytes.buffer
  ).setUint32(
    0,
    recordSize,
    false
  );


  return concatBytes(

    salt,

    recordSizeBytes,

    new Uint8Array([
      serverPublicKey.length
    ]),

    serverPublicKey,

    ciphertext
  );
}


/*
 * HMAC SHA256
 */
async function hmacSha256(
  keyBytes,
  dataBytes
){

  const key =
    await crypto.subtle.importKey(

      "raw",

      keyBytes,

      {
        name:"HMAC",
        hash:"SHA-256"
      },

      false,

      [
        "sign"
      ]
    );


  return new Uint8Array(

    await crypto.subtle.sign(
      "HMAC",
      key,
      dataBytes
    )
  );
}


/*
 * HKDF
 */
async function hkdfExpand(
  prk,
  info,
  length
){

  const blocks =
    [];


  let previous =
    new Uint8Array(0);


  let generated =
    0;


  let counter =
    1;


  while(
    generated < length
  ){

    previous =
      await hmacSha256(

        prk,

        concatBytes(

          previous,

          info,

          new Uint8Array([
            counter
          ])
        )
      );


    blocks.push(
      previous
    );


    generated +=
      previous.length;


    counter +=
      1;
  }


  return concatBytes(
    ...blocks
  ).slice(
    0,
    length
  );
}


/*
 * Uint8Array 연결
 */
function concatBytes(
  ...arrays
){

  const totalLength =
    arrays.reduce(

      (
        sum,
        array
      ) =>
        sum + array.length,

      0
    );


  const output =
    new Uint8Array(
      totalLength
    );


  let offset =
    0;


  for(const array of arrays){

    output.set(
      array,
      offset
    );


    offset +=
      array.length;
  }


  return output;
}


/*
 * Base64URL → bytes
 */
function base64UrlDecode(value){

  const normalized =
    String(value)

      .replace(
        /-/g,
        "+"
      )

      .replace(
        /_/g,
        "/"
      );


  const padded =
    normalized
    +
    "=".repeat(
      (
        4
        -
        normalized.length % 4
      )
      %
      4
    );


  const binary =
    atob(padded);


  return Uint8Array.from(

    binary,

    character =>
      character.charCodeAt(0)
  );
}


/*
 * bytes → Base64URL
 */
function base64UrlEncode(value){

  const bytes =
    value instanceof Uint8Array
      ?
      value
      :
      new Uint8Array(value);


  let binary =
    "";


  for(
    let index = 0;
    index < bytes.length;
    index += 0x8000
  ){

    binary +=
      String.fromCharCode(
        ...bytes.subarray(
          index,
          index + 0x8000
        )
      );
  }


  return btoa(binary)

    .replace(
      /\+/g,
      "-"
    )

    .replace(
      /\//g,
      "_"
    )

    .replace(
      /=+$/g,
      ""
    );
}


/*
 * DER → JOSE signature
 */
function derToJose(
  signature,
  size
){

  const bytes =
    signature instanceof Uint8Array
      ?
      signature
      :
      new Uint8Array(signature);


  if(bytes[0] !== 0x30){

    throw new Error(
      "INVALID_ECDSA_SIGNATURE"
    );
  }


  let offset =
    2;


  if(bytes[1] & 0x80){

    offset =
      2
      +
      (
        bytes[1]
        &
        0x7f
      );
  }


  if(
    bytes[offset]
    !==
    0x02
  ){

    throw new Error(
      "INVALID_ECDSA_R"
    );
  }


  const rLength =
    bytes[
      offset + 1
    ];


  let r =
    bytes.slice(

      offset + 2,

      offset + 2 + rLength
    );


  offset +=
    2
    +
    rLength;


  if(
    bytes[offset]
    !==
    0x02
  ){

    throw new Error(
      "INVALID_ECDSA_S"
    );
  }


  const sLength =
    bytes[
      offset + 1
    ];


  let s =
    bytes.slice(

      offset + 2,

      offset + 2 + sLength
    );


  while(
    r.length > size
    &&
    r[0] === 0
  ){

    r =
      r.slice(1);
  }


  while(
    s.length > size
    &&
    s[0] === 0
  ){

    s =
      s.slice(1);
  }


  const result =
    new Uint8Array(
      size * 2
    );


  result.set(
    r,
    size - r.length
  );


  result.set(
    s,
    size * 2 - s.length
  );


  return result;
}
