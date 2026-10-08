/** Pure business logic for 우리두리 — no Firebase or DOM dependencies. */
export function calendarDayCount(startDate,today=new Date()){
  if(typeof startDate!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) return null;
  const [year,month,day]=startDate.split("-").map(Number);
  const origin=Date.UTC(year,month-1,day);
  const verified=new Date(origin);
  if(verified.getUTCFullYear()!==year||verified.getUTCMonth()!==month-1||verified.getUTCDate()!==day) return null;
  const nowUtc=Date.UTC(today.getFullYear(),today.getMonth(),today.getDate());
  return Math.round((nowUtc-origin)/86400000)+1;
}
export function nextDayMilestone(days){
  if(!Number.isInteger(days)) return null;
  return [100,200,300,365,500,1000,1500,2000,3000,5000].find(n=>n>days)||null;
}
export function parseOutbox(source){
  try{
    const data=JSON.parse(source||"[]");
    if(!Array.isArray(data)) return [];
    return data.filter(item=>item&&typeof item.id==="string"&&item.id.length<200&&item.payload&&
      item.payload.type==="text"&&typeof item.payload.text==="string"&&item.payload.text.length<=6000 &&
      (item.payload.senderSlot==="user1"||item.payload.senderSlot==="user2"))
      .slice(-40);
  }catch{return [];}
}
export function upsertOutbox(entries,item){
  return [...entries.filter(row=>row.id!==item.id),item].slice(-40);
}
export function removeOutbox(entries,id){return entries.filter(row=>row.id!==id);}
export function isTransientSendFailure(error){
  const code=String(error?.code||"").toLowerCase();
  return !["permission_denied","permission-denied","auth/invalid-user-token","auth/user-disabled"].some(fragment=>code.includes(fragment));
}
