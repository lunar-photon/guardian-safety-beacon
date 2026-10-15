/* Guardian PWA — a normal, visible safety beacon.
   Pairs with a code (scanned from the dashboard QR or typed), then broadcasts
   GPS + battery to your server and obeys dashboard commands (snapshot / live / SOS).
   Keep this page open while tracking; for always-on background, use the Android app. */
"use strict";
const $ = id => document.getElementById(id);
const LS = {
  get s(){ return localStorage.getItem("g_server") || location.origin; },
  set s(v){ localStorage.setItem("g_server", v); },
  get t(){ return localStorage.getItem("g_token") || ""; },
  set t(v){ localStorage.setItem("g_token", v); },
  get n(){ return localStorage.getItem("g_name") || "my phone"; },
  set n(v){ localStorage.setItem("g_name", v); },
  get iv(){ return parseInt(localStorage.getItem("g_iv") || "10"); },
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

if(navigator.getBattery){
  navigator.getBattery().then(b=>{
    const upd=()=>{ batteryPct=Math.round(b.level*100); if($("stBat")) $("stBat").textContent=batteryPct+"%"; };
    upd(); b.addEventListener("levelchange",upd);
  }).catch(()=>{});
}

// ---------- net ----------
async function post(path, body){
  return fetch(LS.s+path,{method:"POST",
    headers:{"Content-Type":"application/json",Authorization:"Bearer "+LS.t},
    body:JSON.stringify(body), keepalive:true});
}
async function get(path){ return fetch(LS.s+path,{headers:{Authorization:"Bearer "+LS.t}}); }
function basePayload(){
  const p={device_id:LS.id,name:LS.n,ts:Date.now()/1000,battery:batteryPct};
  if(last){ p.lat=last.coords.latitude; p.lon=last.coords.longitude;
    p.accuracy=last.coords.accuracy; p.speed=last.coords.speed; p.heading=last.coords.heading; }
  return p;
}

// ---------- screens ----------
function showPair(){
  $("pair").style.display="block"; $("main").style.display="none";
  $("headerSub").textContent="Pair to get started";
  $("code").value=urlCode||""; $("name").value=LS.n==="my phone"?"":LS.n;
  $("server").value=LS.s; $("token").value=LS.t; $("interval").value=LS.iv;
}
function showMain(){
  $("pair").style.display="none"; $("main").style.display="block";
  $("headerSub").textContent=LS.n;
  loadConfig();
}

async function claim(code, name){
  const r=await fetch(location.origin+"/api/pair/claim",{method:"POST",
    headers:{"Content-Type":"application/json"},
    body:JSON.stringify({code:code.trim().toUpperCase(), name})});
  if(!r.ok) throw new Error("Pairing code invalid or expired.");
  const d=await r.json();
  LS.s=location.origin; LS.t=d.token; LS.id=d.device_id; LS.n=d.name||name;
}

$("save").onclick=async ()=>{
  const code=$("code").value.trim();
  const name=$("name").value.trim()||"my phone";
  $("setupMsg").textContent=code?"Pairing…":"Checking…";
  try{
    if(code){ await claim(code,name); }
    else{
      LS.s=$("server").value.trim().replace(/\/$/,""); LS.t=$("token").value.trim(); LS.n=name;
      LS.iv=Math.max(3,parseInt($("interval").value)||10);
      if(!LS.s||!LS.t){ $("setupMsg").textContent="Enter a pairing code (or use Advanced)."; return; }
      const r=await get("/api/state"); if(!r.ok){ $("setupMsg").textContent="Server rejected the token."; return; }
    }
  }catch(e){ $("setupMsg").textContent=e.message||"Pairing failed."; return; }
  showMain(); startBeacon();
};
$("changeSettings").onclick=()=>{ stopBeacon(); showPair(); };

// ---------- beacon ----------
function startBeacon(){
  if(running) return; running=true;
  setStatus(true); requestWake();
  if(navigator.geolocation){
    watchId=navigator.geolocation.watchPosition(p=>{
      last=p;
      $("stPos").textContent=p.coords.latitude.toFixed(5)+", "+p.coords.longitude.toFixed(5);
      checkProximity(p.coords.latitude,p.coords.longitude);
    },()=>{},{enableHighAccuracy:true,maximumAge:4000,timeout:20000});
  }
  sendPing(); pingTimer=setInterval(sendPing, LS.iv*1000);
  cmdTimer=setInterval(pollCommands, 5000);
}
function stopBeacon(){
  running=false; setStatus(false);
  if(watchId!=null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  [pingTimer,cmdTimer,frameTimer].forEach(t=>t&&clearInterval(t));
  pingTimer=cmdTimer=frameTimer=null; stopCam(); releaseWake();
}
function setStatus(on){
  $("dot").className="dot "+(on?"on":"off");
  $("statusTitle").textContent=on?"Tracking active":"Not tracking";
}
async function sendPing(){
  try{ await post("/api/ping", basePayload()); $("stSent").textContent=new Date().toLocaleTimeString(); }catch(e){}
}
$("startBtn").onclick=startBeacon;
$("stopBtn").onclick=stopBeacon;

// ---------- wake lock ----------
async function requestWake(){ try{ wakeLock=await navigator.wakeLock.request("screen"); }catch(e){} }
function releaseWake(){ if(wakeLock){ wakeLock.release().catch(()=>{}); wakeLock=null; } }
document.addEventListener("visibilitychange",()=>{ if(document.visibilityState==="visible"&&running) requestWake(); });

// ---------- camera ----------
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

// ---------- commands from dashboard ----------
async function pollCommands(){
  try{ const r=await get("/api/commands?device_id="+encodeURIComponent(LS.id));
    if(!r.ok) return; const {commands}=await r.json();
    for(const c of (commands||[])) runCommand(c);
  }catch(e){}
}
function runCommand(c){
  switch(c.cmd){
    case "snap": capture("manual"); break;
    case "live_on": if(!frameTimer){ capture("live"); frameTimer=setInterval(()=>capture("live"),(c.args&&c.args.every||5)*1000); } break;
    case "live_off": if(frameTimer){ clearInterval(frameTimer); frameTimer=null; } stopCam(); break;
    case "sos": doSOS(); break;
    case "ping_now": sendPing(); break;
  }
}

// ---------- SOS ----------
async function doSOS(){
  navigator.vibrate && navigator.vibrate([200,100,200]);
  if(!running) startBeacon();
  await post("/api/trigger", Object.assign(basePayload(),{kind:"sos",message:"🚨 SOS from "+LS.n}));
  await startCam(); capture("sos");
  setTimeout(()=>capture("sos"),2500); setTimeout(()=>capture("sos"),6000);
}
$("sos").onclick=async ()=>{
  await doSOS();
  $("sos").textContent="✅ Alert sent";
  setTimeout(()=>$("sos").textContent="🚨 SOS",4000);
};

// ---------- config: helplines + danger zones ----------
let CONFIG={helplines:[],danger_zones:[],proximity_warn_m:300};
async function loadConfig(){
  try{ const r=await get("/api/config?device_id="+encodeURIComponent(LS.id));
    if(r.ok){ CONFIG=await r.json(); renderHelplines(); }
  }catch(e){}
}
function renderHelplines(){
  $("helplines").innerHTML=(CONFIG.helplines||[]).map(h=>
    `<a href="tel:${h.number}"><button>📞 ${h.label}</button></a>`).join("")
    || '<span class="muted">No helplines configured.</span>';
}
function metres(a,b,c,d){
  const R=6371000,dLat=(c-a)*Math.PI/180,dLon=(d-b)*Math.PI/180;
  const x=Math.sin(dLat/2)**2+Math.cos(a*Math.PI/180)*Math.cos(c*Math.PI/180)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(x));
}
let lastDanger=null;
function checkProximity(lat,lon){
  let near=null,nd=1e12;
  for(const z of (CONFIG.danger_zones||[])){
    const dm=metres(lat,lon,z.lat,z.lon);
    if(dm<=(z.radius||CONFIG.proximity_warn_m)+(CONFIG.proximity_warn_m||300) && dm<nd){ nd=dm; near=z; }
  }
  const box=$("dangerWarn");
  if(near){ box.style.display="block";
    $("dangerWarnText").textContent=`Near "${near.name}" — a reported unsafe area (~${Math.round(nd)} m). Stay alert.`;
    if(near.name!==lastDanger){ navigator.vibrate&&navigator.vibrate([120,60,120]); lastDanger=near.name; }
  }else{ box.style.display="none"; lastDanger=null; }
}

// ---------- places ----------
async function savePlace(kind,label){
  if(!last){ alert("Waiting for GPS — tap Start and try again in a few seconds."); return; }
  const name=prompt("Name this place:",label)||label;
  await post("/api/places",{device_id:LS.id,name,lat:last.coords.latitude,lon:last.coords.longitude,radius:120,kind});
  alert(name+" saved. Arrivals will be logged automatically.");
}
$("setHome").onclick=()=>savePlace("home","Home");
$("setOffice").onclick=()=>savePlace("office","Office");

// ---------- service worker + init ----------
if("serviceWorker" in navigator){ navigator.serviceWorker.register("/pwa/sw.js").catch(()=>{}); }
if(localStorage.getItem("g_token") && localStorage.getItem("g_server")){ showMain(); startBeacon(); }
else { showPair(); }
