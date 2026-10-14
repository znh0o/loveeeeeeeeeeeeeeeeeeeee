export const PAGE_WIDTH=900;
export const PAGE_HEIGHT=1273;
const MAX_PAGES=40;
const MAX_BLOCKS=80;
const imageCache=new Map();
const bounded=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.max(min,Math.min(max,Number(value))):fallback;

export function emptyBook(){
  return {title:"우리의 첫 번째 1년",pages:[{blocks:[{type:"text",text:"",size:18}]}]};
}

export function normalizeBook(value){
  const source=value&&typeof value==="object"?value:{};
  const pages=Array.isArray(source.pages)?source.pages.slice(0,MAX_PAGES):[];
  return {
    title:String(source.title||"우리의 첫 번째 1년").slice(0,100),
    pages:(pages.length?pages:[{blocks:[]}]).map(page=>({
      blocks:(Array.isArray(page?.blocks)?page.blocks:[]).slice(0,MAX_BLOCKS).flatMap(block=>{
        if(block?.type==="text")return [{type:"text",text:String(block.text||"").slice(0,4000),size:Math.max(12,Math.min(32,Number(block.size)||18))}];
        if(block?.type==="image"&&/^data:image\/(?:jpeg|png|webp);base64,/i.test(block.data||"")&&block.data.length<2500000)
          return [{type:"image",data:block.data,x:bounded(block.x,450,84,666),y:bounded(block.y,360,100,1030),w:bounded(block.w,360,150,650)}];
        return [];
      })
    }))
  };
}

function graphemes(text){
  if(typeof Intl.Segmenter==="function")return [...new Intl.Segmenter("ko",{granularity:"grapheme"}).segment(text)].map(part=>part.segment);
  return Array.from(text);
}

function loadImage(data){
  if(imageCache.has(data))return imageCache.get(data);
  const promise=new Promise((resolve,reject)=>{
    const image=new Image();
    image.onload=()=>resolve(image);
    image.onerror=()=>reject(new Error("사진을 읽지 못했어요."));
    image.src=data;
  });
  imageCache.set(data,promise);
  if(imageCache.size>16)imageCache.delete(imageCache.keys().next().value);
  return promise;
}

export async function drawPage(page,pageNumber,total,canvas=document.createElement("canvas")){
  canvas.width=PAGE_WIDTH;canvas.height=PAGE_HEIGHT;
  const ctx=canvas.getContext("2d");
  ctx.fillStyle="#050505";ctx.fillRect(0,0,PAGE_WIDTH,PAGE_HEIGHT);
  ctx.fillStyle="#fff";ctx.textBaseline="top";
  let y=100,overflow=false;
  const left=84,right=PAGE_WIDTH-84,bottom=1160,photoRects=[];
  for(const [index,block] of (page.blocks||[]).entries()){
    if(block.type!=="image")continue;
    try{
      const image=await loadImage(block.data);
      let width=bounded(block.w,360,150,650);
      let height=width*image.height/image.width;
      if(height>780){width*=780/height;height=780;}
      const x=bounded(block.x,450,left,right-width),top=bounded(block.y,360,100,bottom-height);
      photoRects.push({index,x,y:top,w:width,h:height});
      ctx.drawImage(image,x,top,width,height);
    }catch{overflow=true;}
  }
  const intervalsAt=(top,height,size)=>{
    let intervals=[[left,right]];
    for(const photo of photoRects){
      if(top+height<photo.y-12||top>photo.y+photo.h+12)continue;
      const start=photo.x-16,end=photo.x+photo.w+16;
      intervals=intervals.flatMap(([a,b])=>start>=b||end<=a?[[a,b]]:[[a,Math.min(start,b)],[Math.max(end,a),b]].filter(([u,v])=>v-u>=Math.max(size*5.5,190)));
    }
    return intervals.filter(([a,b])=>b-a>=size);
  };
  for(const block of page.blocks||[]){
    if(block.type!=="text")continue;
    const size=bounded(block.size,18,12,32)*2,lineHeight=size*1.42;
    ctx.font=`400 ${size}px system-ui, "Apple SD Gothic Neo", sans-serif`;
    ctx.textAlign="left";ctx.fillStyle="#fff";
    for(const paragraph of String(block.text||"").split(/\r?\n/)){
      const chars=graphemes(paragraph);
      if(!chars.length){y+=lineHeight;continue;}
      let pos=0;
      while(pos<chars.length){
        if(y+lineHeight>bottom){overflow=true;break;}
        const intervals=intervalsAt(y,lineHeight,size);
        for(const [start,end] of intervals){
          let line="";
          while(pos<chars.length&&ctx.measureText(line+chars[pos]).width<=end-start){line+=chars[pos++];}
          if(line)ctx.fillText(line,start,y);
          if(pos>=chars.length)break;
        }
        y+=lineHeight;
      }
      if(overflow)break;
    }
    y+=lineHeight*.42;
    if(overflow)break;
  }
  ctx.fillStyle="#a8a8a8";ctx.font="24px system-ui, sans-serif";ctx.textAlign="right";
  ctx.fillText(`${String(pageNumber).padStart(2,"0")} / ${String(total).padStart(2,"0")}`,right,PAGE_HEIGHT-72);
  return {canvas,overflow,photoRects};
}

function jpegBytes(canvas){
  const base64=canvas.toDataURL("image/jpeg",.9).split(",")[1];
  const binary=atob(base64),bytes=new Uint8Array(binary.length);
  for(let index=0;index<binary.length;index++)bytes[index]=binary.charCodeAt(index);
  return bytes;
}

export function pdfFromCanvases(canvases){
  if(!canvases.length)throw new Error("페이지가 없어요.");
  const encoder=new TextEncoder(),parts=[],offsets=[0];
  let position=0;
  const add=value=>{const bytes=typeof value==="string"?encoder.encode(value):value;parts.push(bytes);position+=bytes.length;};
  const object=(id,body)=>{offsets[id]=position;add(`${id} 0 obj\n`);for(const part of body)add(part);add("\nendobj\n");};
  add("%PDF-1.4\n");
  object(1,["<< /Type /Catalog /Pages 2 0 R >>"]);
  const pageIds=canvases.map((_,i)=>`${3+i*3} 0 R`).join(" ");
  object(2,[`<< /Type /Pages /Kids [${pageIds}] /Count ${canvases.length} >>`]);
  canvases.forEach((canvas,index)=>{
    const pageId=3+index*3,contentId=pageId+1,imageId=pageId+2;
    const mediaWidth=600,mediaHeight=Math.round(600*PAGE_HEIGHT/PAGE_WIDTH);
    object(pageId,[`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${mediaWidth} ${mediaHeight}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`]);
    const stream=`q ${mediaWidth} 0 0 ${mediaHeight} 0 0 cm /Im0 Do Q\n`;
    object(contentId,[`<< /Length ${encoder.encode(stream).length} >>\nstream\n`,stream,"endstream"]);
    const image=jpegBytes(canvas);
    object(imageId,[`<< /Type /XObject /Subtype /Image /Width ${canvas.width} /Height ${canvas.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${image.length} >>\nstream\n`,image,"\nendstream"]);
  });
  const xrefAt=position,count=canvases.length*3+3;
  add(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for(let id=1;id<count;id++)add(`${String(offsets[id]).padStart(10,"0")} 00000 n \n`);
  add(`trailer\n<< /Size ${count} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF`);
  return new Blob(parts,{type:"application/pdf"});
}
