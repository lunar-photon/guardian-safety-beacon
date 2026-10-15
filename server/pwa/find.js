/* Guardian "Find my devices" — a two-way map: the phone sees the laptop, the laptop
   sees the phone. Mounted inside the phone app (index.html) and standalone (find.html).

   GuardianFind.mount(rootEl, {server, token, compact})
   Needs Leaflet (global L) for the map; without it the device list still works.
   Last good answer is cached, so if the server goes away you still get each
   device's last known position. */
"use strict";
(function(){
  const POLL_MS = 5000;
  const CACHE_KEY = "gf_cache";
  const DIRS = ["N","NE","E","SE","S","SW","W","NW"];

  const esc = s => String(s==null?"":s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
  const rad = d => d*Math.PI/180;
  function metres(a,b,c,d){
    const x=Math.sin(rad(c-a)/2)**2+Math.cos(rad(a))*Math.cos(rad(c))*Math.sin(rad(d-b)/2)**2;
    return 2*6371000*Math.asin(Math.sqrt(x));
  }
  function bearing(a,b,c,d){
    const y=Math.sin(rad(d-b))*Math.cos(rad(c));
    const x=Math.cos(rad(a))*Math.sin(rad(c))-Math.sin(rad(a))*Math.cos(rad(c))*Math.cos(rad(d-b));
    return (Math.atan2(y,x)*180/Math.PI+360)%360;
  }
  const fmtDist = m => m<1000 ? Math.round(m)+" m" : (m<10000 ? (m/1000).toFixed(1) : Math.round(m/1000))+" km";
  function fmtAgo(s){
    s=Math.max(0,s);
    if(s<60) return "just now";
    if(s<3600) return Math.floor(s/60)+" min ago";
    if(s<86400) return Math.floor(s/3600)+" h ago";
    return Math.floor(s/86400)+" d ago";
  }
  const icon = k => k==="laptop" ? "💻" : "📱";
  const SRC = {"wifi":" via WiFi","learned-wifi":" via your WiFi map"};

  const CSS = `
  .gf{font-family:inherit;color:var(--txt,#15162B)}
  .gf-map{height:340px;border-radius:18px;overflow:hidden;border:1px solid var(--stroke,#E7E8F0);background:#e9ecf3}
  .gf.full .gf-map{height:55vh;border-radius:0;border:0}
  .gf-banner{display:none;margin:10px 0;padding:10px 12px;border-radius:12px;font-size:13px;
    background:#FFF7ED;border:1px solid #FED7AA;color:#9A3412}
  .gf-list{margin-top:12px}
  .gf.full .gf-list{padding:0 14px 20px;max-width:640px;margin:12px auto 0}
  .gf-dev{background:var(--surface,#fff);border:1px solid var(--stroke,#E7E8F0);border-radius:18px;
    padding:14px;margin-bottom:10px}
  .gf-top{display:flex;align-items:center;gap:10px}
  .gf-ico{font-size:26px;line-height:1}
  .gf-name{font-weight:800;font-size:16px}
  .gf-sub{color:var(--muted,#6B7280);font-size:12.5px;margin-top:2px}
  .gf-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:5px;background:#9AA0AC}
  .gf-dot.on{background:#22C55E}
  .gf-dist{margin-left:auto;text-align:right}
  .gf-dist b{font-size:18px;display:block}
  .gf-arrow{display:inline-block;transition:transform .3s;font-size:18px}
  .gf-btns{display:flex;gap:8px;margin-top:12px;flex-wrap:wrap}
  .gf-btns button,.gf-btns a{flex:1 1 22%;font:inherit;font-size:12.5px;font-weight:700;padding:10px 4px;white-space:nowrap;
    border-radius:12px;border:1.5px solid var(--stroke,#E7E8F0);background:#fff;color:var(--txt,#15162B);
    cursor:pointer;text-align:center;text-decoration:none;width:auto}
  .gf-btns .ring{background:var(--brand,#5B5BD6);border-color:var(--brand,#5B5BD6);color:#fff}
  .gf-me{color:var(--muted,#6B7280);font-size:12.5px;margin-top:8px}
  .gf-toast{color:var(--brand,#5B5BD6);font-size:12.5px;font-weight:600;margin-top:8px;min-height:1em}
  .gf-pin{font-size:26px;filter:drop-shadow(0 2px 2px rgba(0,0,0,.35))}
  .gf-pin.off{filter:grayscale(1) opacity(.7)}
  .gf-you{width:16px;height:16px;border-radius:50%;background:#2563EB;border:3px solid #fff;
    box-shadow:0 0 0 2px rgba(37,99,235,.35)}`;

  function mount(root, opts){
    const server = (opts.server || location.origin).replace(/\/$/,"");
    const token = opts.token;
    if(!document.getElementById("gf-css")){
      const st=document.createElement("style"); st.id="gf-css"; st.textContent=CSS; document.head.appendChild(st);
    }
    root.classList.add("gf"); if(!opts.compact) root.classList.add("full");
    root.innerHTML = `<div class="gf-map"></div><div class="gf-banner"></div><div class="gf-list"></div>`;
    const mapEl=root.querySelector(".gf-map"), banner=root.querySelector(".gf-banner"), list=root.querySelector(".gf-list");

    let data=null, myPos=null, heading=null, selected=null, fitted=false, timer=null;
    const toasts={};
    let map=null, layers={}, youMarker=null, trailLine=null;

    if(window.L){
      map=L.map(mapEl,{zoomControl:true,attributionControl:true}).setView([20,78],4);
      L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
        {maxZoom:19,attribution:"© OpenStreetMap"}).addTo(map);
    }else{
      mapEl.innerHTML='<p style="padding:14px;color:#6B7280;font-size:13px">Map unavailable offline — distances below still work.</p>';
      mapEl.style.height="auto";
    }

    // ----- where am I (this screen) -----
    if(navigator.geolocation){
      navigator.geolocation.watchPosition(p=>{
        myPos={lat:p.coords.latitude,lon:p.coords.longitude,acc:p.coords.accuracy};
        render();
      },()=>{},{enableHighAccuracy:true,maximumAge:10000,timeout:30000});
    }
    // compass heading so the arrow points the way to walk (Android Chrome; iOS Safari)
    const onOrient=e=>{
      if(e.webkitCompassHeading!=null) heading=e.webkitCompassHeading;
      else if(e.absolute && e.alpha!=null) heading=(360-e.alpha)%360;
      else return;
      root.querySelectorAll(".gf-arrow[data-b]").forEach(a=>{
        a.style.transform=`rotate(${(+a.dataset.b-heading+360)%360}deg)`;
      });
    };
    window.addEventListener("deviceorientationabsolute",onOrient);
    window.addEventListener("deviceorientation",onOrient);

    // ----- data -----
    async function load(){
      try{
        const r=await fetch(server+"/api/peers?trail=60",{headers:{Authorization:"Bearer "+token},cache:"no-store"});
        if(r.status===401){ banner.style.display="block"; banner.textContent="This device's access was revoked or the token is wrong — pair again."; return; }
        if(!r.ok) throw new Error(r.status);
        data=await r.json(); data._fetched=Date.now()/1000;
        try{ localStorage.setItem(CACHE_KEY,JSON.stringify(data)); }catch(e){}
        banner.style.display="none";
      }catch(e){
        if(!data){ try{ data=JSON.parse(localStorage.getItem(CACHE_KEY)||"null"); }catch(_){ data=null; } }
        banner.style.display="block";
        banner.textContent = data
          ? `Can't reach the server — showing last known positions (saved ${new Date(data._fetched*1000).toLocaleString()}).`
          : "Can't reach the server and nothing is cached yet.";
      }
      render();
    }

    function reference(){
      if(myPos) return {lat:myPos.lat,lon:myPos.lon,label:"you"};
      if(!data) return null;
      const me=data.peers.find(p=>p.self && p.fix);
      if(me) return {lat:me.fix.lat,lon:me.fix.lon,label:"this device's last fix"};
      // dashboard token on a laptop: measure from the laptop if there is exactly one
      const laps=data.peers.filter(p=>p.kind==="laptop" && p.fix);
      if(laps.length===1) return {lat:laps[0].fix.lat,lon:laps[0].fix.lon,label:esc(laps[0].name)};
      return null;
    }

    function render(){
      if(!data) return;
      const now = data._fetched ? data.now + (Date.now()/1000 - data._fetched) : Date.now()/1000;
      const ref=reference();
      const peers=[...data.peers].sort((a,b)=>(a.self-b.self)||((b.last_seen||0)-(a.last_seen||0)));

      list.innerHTML = peers.length ? peers.map(p=>{
        const f=p.fix;
        const approx = f && f.extra && f.extra.source==="ip";
        let dist="", dirTxt="";
        if(f && ref && !p.self){
          const m=metres(ref.lat,ref.lon,f.lat,f.lon), b=bearing(ref.lat,ref.lon,f.lat,f.lon);
          const rot = heading==null ? b : (b-heading+360)%360;
          dirTxt=DIRS[Math.round(b/45)%8];
          dist=`<div class="gf-dist"><b>${approx?"~":""}${fmtDist(m)}</b>
            <span class="gf-arrow" data-b="${b.toFixed(0)}" style="transform:rotate(${rot}deg)">⬆</span>
            <span class="gf-sub">${dirTxt}</span></div>`;
        }
        const pos = f
          ? `${approx?"Approximate (IP-based)":"±"+Math.round(f.accuracy||0)+" m"}${SRC[f.extra&&f.extra.source]||""} · fix ${fmtAgo(now-f.ts)}`
          : "No position yet";
        const bat = p.battery!=null ? ` · 🔋 ${Math.round(p.battery)}%` : "";
        const btns = p.self ? "" : `<div class="gf-btns">
            <button class="ring" data-act="ring" data-id="${esc(p.id)}">🔔 Ring</button>
            <button data-act="ring_stop" data-id="${esc(p.id)}">🔕 Stop</button>
            <button data-act="ping_now" data-id="${esc(p.id)}">📍 Locate</button>
            ${f?`<a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${f.lat},${f.lon}">🧭 Go</a>`:""}
          </div><div class="gf-toast">${esc(toasts[p.id]||"")}</div>`;
        return `<div class="gf-dev" data-sel="${esc(p.id)}">
          <div class="gf-top"><span class="gf-ico">${icon(p.kind)}</span>
            <div><div class="gf-name">${esc(p.name||p.id)}${p.self?' <span class="gf-sub">(this device)</span>':""}</div>
              <div class="gf-sub"><span class="gf-dot ${p.online?"on":""}"></span>${p.online?"Online":"Last seen "+fmtAgo(now-(p.last_seen||0))}${bat}</div>
              <div class="gf-sub">${pos}</div></div>
            ${dist}</div>${btns}</div>`;
      }).join("") + `<div class="gf-me">${ref?"Distances measured from "+ref.label+".":"Allow location on this screen to see distance and direction."}</div>`
      : '<p class="gf-sub">No devices paired yet. Pair your phone and laptop from the dashboard.</p>';

      drawMap(peers);
    }

    function drawMap(peers){
      if(!map) return;
      const pts=[];
      const seen=new Set();
      for(const p of peers){
        if(!p.fix) continue;
        seen.add(p.id);
        const ll=[p.fix.lat,p.fix.lon]; pts.push(ll);
        const ic=L.divIcon({className:"",html:`<div class="gf-pin ${p.online?"":"off"}">${icon(p.kind)}</div>`,iconSize:[30,30],iconAnchor:[15,15]});
        let g=layers[p.id];
        if(!g){
          g=layers[p.id]={m:L.marker(ll,{icon:ic}).addTo(map).on("click",()=>select(p.id)),
                          c:L.circle(ll,{radius:p.fix.accuracy||0,weight:1,color:"#5B5BD6",fillOpacity:.08}).addTo(map)};
        }else{ g.m.setLatLng(ll).setIcon(ic); g.c.setLatLng(ll).setRadius(p.fix.accuracy||0); }
        g.m.bindTooltip(esc(p.name)+(p.self?" (this device)":""));
      }
      for(const id of Object.keys(layers)) if(!seen.has(id)){ map.removeLayer(layers[id].m); map.removeLayer(layers[id].c); delete layers[id]; }
      if(myPos){
        const ll=[myPos.lat,myPos.lon]; pts.push(ll);
        if(!youMarker) youMarker=L.marker(ll,{icon:L.divIcon({className:"",html:'<div class="gf-you"></div>',iconSize:[22,22],iconAnchor:[11,11]})}).addTo(map).bindTooltip("You");
        else youMarker.setLatLng(ll);
      }
      if(trailLine){ map.removeLayer(trailLine); trailLine=null; }
      const sp=selected && peers.find(p=>p.id===selected);
      if(sp && sp.trail && sp.trail.length>1) trailLine=L.polyline(sp.trail,{color:"#5B5BD6",weight:3,opacity:.7}).addTo(map);
      if(!fitted && pts.length){ fitted=true; map.fitBounds(L.latLngBounds(pts).pad(.3),{maxZoom:16}); }
    }

    function select(id){
      selected=id;
      const p=data && data.peers.find(x=>x.id===id);
      if(map && p && p.fix) map.setView([p.fix.lat,p.fix.lon],Math.max(map.getZoom(),15));
      render();
    }

    list.addEventListener("click",async e=>{
      const btn=e.target.closest("button[data-act]");
      if(!btn){ const card=e.target.closest("[data-sel]"); if(card && !e.target.closest("a")) select(card.dataset.sel); return; }
      const id=btn.dataset.id, cmd=btn.dataset.act;
      toasts[id]="Sending…"; render();
      try{
        const r=await fetch(server+"/api/peers/"+encodeURIComponent(id)+"/command",{method:"POST",
          headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},body:JSON.stringify({cmd})});
        toasts[id]= !r.ok ? "Failed ("+r.status+")"
          : {ring:"Ring sent — it plays within ~5 s if the device is online.",
             ring_stop:"Stop sent.", ping_now:"Asked for a fresh location."}[cmd];
      }catch(err){ toasts[id]="Server unreachable."; }
      render();
      setTimeout(()=>{ delete toasts[id]; render(); },8000);
    });

    function start(){ if(!timer){ load(); timer=setInterval(load,POLL_MS); } }
    function stop(){ clearInterval(timer); timer=null; }
    document.addEventListener("visibilitychange",()=>document.hidden?stop():start());
    start();
    return {refresh:load, invalidate:()=>map&&map.invalidateSize()};
  }

  window.GuardianFind={mount};
})();
