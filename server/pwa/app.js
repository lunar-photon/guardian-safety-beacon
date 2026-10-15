/* Guardian PWA — SILENT BEACON.
   After setup the phone shows only a decoy "Notes" screen and broadcasts GPS,
   battery and (on command) webcam to your server. No safety controls live on the
   phone — the dashboard sees everything and holds the "reach help" options.
   Reopen setup: triple-tap the word "Notes". */
"use strict";
const $ = id => document.getElementById(id);
const LS = {
  get s(){ return localStorage.getItem("g_server") || location.origin; },
  set s(v){ localStorage.setItem("g_server", v); },
  get t(){ return localStorage.getItem("g_token") || ""; },
  set t(v){ localStorage.setItem("g_token", v); },
  get n(){ return localStorage.getItem("g_name") || "my phone"; },
  set n(v){ localStorage.setItem("g_name", v); },
  get iv(){ return parseInt(localStorage.getItem("g_iv")||"10"); },
  set iv(v){ localStorage.setItem("g_iv", String(v)); },
  get id(){
    let d = localStorage.getItem("g_id");
    if(!d){ d = "dev-" + Math.random().toString(36).slice(2,10); localStorage.setItem("g_id", d); }
    return d;
  },
  set id(v){ localStorage.setItem("g_id", v); }
};
const urlCode = new URLSearchParams(location.search).get("code");

let watchId=null, pingTimer=null, cmdTimer=null, frameTimer=null, wakeLock=null;
let last=null, batteryPct=null, stream=null, running=false;

// ---------- battery ----------
if(navigator.getBattery){
  navigator.getBattery().then(b=>{
    const upd=()=>batteryPct=Math.round(b.level*100); upd(); b.addEventListener("levelchange",upd);
  }).catch(()=>{});
}

// ---------- networking ----------
async function post(path, body){
  return fetch(LS.s+path,{method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+LS.t},
    body:JSON.stringify(body), keepalive:true});
}
async function get(path){
  return fetch(LS.s+path,{headers:{Authorization:"Bearer "+LS.t}});
}
function basePayload(){
  const p={device_id:LS.id,name:LS.n,ts:Date.now()/1000,battery:batteryPct};
  if(last){ p.lat=last.coords.latitude; p.lon=last.coords.longitude;
    p.accuracy=last.coords.accuracy; p.speed=last.coords.speed; p.heading=last.coords.heading; }
  return p;
}

// ---------- screens ----------
function showSetup(){
  $("setup").style.display="block"; $("decoy").style.display="none";
  $("server").value=LS.s; $("token").value=LS.t; $("name").value=LS.n; $("interval").value=LS.iv;
  if(urlCode) $("code").value=urlCode;   // opened from the QR link
}

// exchange a pairing code for the token (served from this same origin)
async function claim(code, name){
  const r=await fetch(location.origin+"/api/pair/claim",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({code:code.trim().toUpperCase(), name})});
  if(!r.ok) throw new Error("Pairing code invalid or expired.");
  const d=await r.json();
  LS.s=location.origin; LS.t=d.token; LS.id=d.device_id; LS.n=d.name||name;
}
function showDecoy(){
  $("setup").style.display="none"; $("decoy").style.display="flex";
  try{ $("pad").value=localStorage.getItem("g_pad")||""; }catch(e){}
}

$("save").onclick=async ()=>{
  const code=$("code").value.trim();
  const name=$("name").value.trim()||"my phone";
  $("setupMsg").textContent=code?"Pairing…":"Checking…";
  try{
    if(code){
      await claim(code, name);                       // pairing path
    }else{
      LS.s=$("server").value.trim().replace(/\/$/,"");
      LS.t=$("token").value.trim(); LS.n=name;
      LS.iv=Math.max(3,parseInt($("interval").value)||10);
      if(!LS.s||!LS.t){ $("setupMsg").textContent="Enter a pairing code (or use Advanced)."; return; }
      const r=await get("/api/state");
      if(!r.ok){ $("setupMsg").textContent="Server rejected the token."; return; }
    }
  }catch(e){ $("setupMsg").textContent=e.message||"Pairing failed."; return; }
  startBeacon(); showDecoy();
};
$("stopBtn").onclick=()=>{ stopBeacon(); $("setupMsg").textContent="Stopped."; };

// set home/office from current position (done during setup, before going silent)
async function savePlace(kind,label){
  if(!last){ alert("No GPS fix yet — wait a few seconds after Save, then try."); return; }
  const name=prompt("Name this place:",label)||label;
  await post("/api/places",{device_id:LS.id,name,lat:last.coords.latitude,lon:last.coords.longitude,radius:120,kind});
  alert(name+" saved. Arrivals log automatically on the dashboard.");
}
$("setHome").onclick=()=>savePlace("home","Home");
$("setOffice").onclick=()=>savePlace("office","Office");

// ---------- decoy: real notes + hidden reveal ----------
$("pad").addEventListener("input",e=>{ try{ localStorage.setItem("g_pad",e.target.value);}catch(_){} });
let taps=0, tapT=null;
$("brand").addEventListener("click",()=>{
  taps++; clearTimeout(tapT); tapT=setTimeout(()=>taps=0,700);
  if(taps>=3){ taps=0; showSetup(); }
});

// ---------- beacon ----------
function startBeacon(){
  if(running) return; running=true;
  $("livedot").className="tinydot live";
  requestWake();
  if(navigator.geolocation){
    watchId=navigator.geolocation.watchPosition(p=>{ last=p; },()=>{},
      {enableHighAccuracy:true,maximumAge:4000,timeout:20000});
  }
  sendPing();
  pingTimer=setInterval(sendPing, LS.iv*1000);
  cmdTimer=setInterval(pollCommands, 5000);
}
function stopBeacon(){
  running=false; $("livedot").className="tinydot";
  if(watchId!=null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  [pingTimer,cmdTimer,frameTimer].forEach(t=>t&&clearInterval(t));
  pingTimer=cmdTimer=frameTimer=null;
  stopCam(); releaseWake();
}
async function sendPing(){ try{ await post("/api/ping", basePayload()); }catch(e){} }

// reacquire wake lock when returning to the tab
async function requestWake(){ try{ wakeLock=await navigator.wakeLock.request("screen"); }catch(e){} }
function releaseWake(){ if(wakeLock){ wakeLock.release().catch(()=>{}); wakeLock=null; } }
document.addEventListener("visibilitychange",()=>{
  if(document.visibilityState==="visible" && running) requestWake();
});

// ---------- camera (triggered only by server commands) ----------
async function startCam(){
  if(stream) return true;
  try{ stream=await navigator.mediaDevices.getUserMedia({video:{facingMode:"user"},audio:false});
    const v=$("cam"); v.srcObject=stream; await v.play(); return true;
  }catch(e){ return false; }
}
function stopCam(){ if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; } }
async function capture(kind){
  if(!(await startCam())) return;
  const v=$("cam"),c=$("canvas"); const w=v.videoWidth||640,h=v.videoHeight||480;
  c.width=w;c.height=h; c.getContext("2d").drawImage(v,0,0,w,h);
  try{ await post("/api/frame",{device_id:LS.id,name:LS.n,kind,image_b64:c.toDataURL("image/jpeg",0.6)});}catch(e){}
}

// ---------- remote commands from the dashboard ----------
async function pollCommands(){
  try{
    const r=await get("/api/commands?device_id="+encodeURIComponent(LS.id));
    if(!r.ok) return; const {commands}=await r.json();
    for(const c of (commands||[])) runCommand(c);
  }catch(e){}
}
function runCommand(c){
  switch(c.cmd){
    case "snap":      capture("manual"); break;
    case "live_on":   if(!frameTimer){ capture("live"); frameTimer=setInterval(()=>capture("live"), (c.args&&c.args.every||5)*1000); } break;
    case "live_off":  if(frameTimer){ clearInterval(frameTimer); frameTimer=null; } stopCam(); break;
    case "sos":       post("/api/trigger", Object.assign(basePayload(),{kind:"sos",message:"🚨 SOS ("+LS.n+")"})); capture("sos"); break;
    case "ping_now":  sendPing(); break;
    case "hide":      showDecoy(); break;        // drop to the Notes decoy
    case "unhide":    showSetup(); break;        // reveal the Guardian settings screen
  }
}

// ---------- service worker ----------
if("serviceWorker" in navigator){ navigator.serviceWorker.register("/pwa/sw.js").catch(()=>{}); }

// ---------- init ----------
if(LS.t && LS.s){ startBeacon(); showDecoy(); } else { showSetup(); }
