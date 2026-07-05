/* ---------------------------------------------------------
   MySunshineCo — frontend
   Talks to the Express API. Each login only ever receives the
   data the server decides it's allowed to see (see /api/overview
   on the server — caregivers get their own shifts/docs/messages,
   never the whole agency's).
--------------------------------------------------------- */

let SESSION = null;   // {id, name, role, username, ...}
let VIEW = null;      // response from /api/overview
let currentView = null;

function pad(n){return n.toString().padStart(2,"0");}
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; }
function fmtTime(d){ let h=d.getHours(), m=d.getMinutes(); const ap=h>=12?"PM":"AM"; h=h%12; if(h===0)h=12; return `${h}:${pad(m)} ${ap}`; }
function fmtTimeFromISO(iso){ if(!iso) return "—"; return fmtTime(new Date(iso)); }
function minutesBetween(a,b){ return Math.round((b-a)/60000); }
function daysUntil(dateStr){
  if(!dateStr) return null;
  const d = new Date(dateStr+"T00:00:00");
  const now = new Date(); now.setHours(0,0,0,0);
  return Math.round((d-now)/86400000);
}

/* ---------- API helper ---------- */
async function api(path, opts){
  opts = opts || {};
  const headers = opts.body instanceof FormData ? {} : {"Content-Type":"application/json"};
  const res = await fetch(path, { credentials:"same-origin", headers, ...opts });
  let data = {};
  try { data = await res.json(); } catch(e){ /* no body */ }
  if(res.status === 401 && path !== "/api/login"){ showLogin(); throw new Error("Session expired — please sign in again."); }
  if(!res.ok) throw new Error(data.error || "Request failed");
  return data;
}

function showToast(msg, isError){
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast show" + (isError ? " error" : "");
  setTimeout(()=> t.className = "toast", 2500);
}

/* ---------- Login / session ---------- */
function showLogin(){
  document.getElementById("loginScreen").style.display = "flex";
  document.getElementById("app").classList.remove("visible");
  SESSION = null; VIEW = null;
}
function showApp(){
  document.getElementById("loginScreen").style.display = "none";
  document.getElementById("app").classList.add("visible");
}

document.getElementById("loginBtn").addEventListener("click", doLogin);
document.getElementById("loginPassword").addEventListener("keydown", (e)=>{ if(e.key==="Enter") doLogin(); });

async function doLogin(){
  const username = document.getElementById("loginUsername").value.trim();
  const password = document.getElementById("loginPassword").value;
  const errEl = document.getElementById("loginError");
  errEl.style.display = "none";
  try{
    SESSION = await api("/api/login", { method:"POST", body: JSON.stringify({username, password}) });
    document.getElementById("loginPassword").value = "";
    await loadOverview();
    showApp();
    render();
  }catch(e){
    errEl.textContent = e.message;
    errEl.style.display = "block";
  }
}

document.getElementById("logoutBtn").addEventListener("click", async ()=>{
  await api("/api/logout", { method:"POST" });
  showLogin();
});

async function loadOverview(){
  VIEW = await api("/api/overview");
  SESSION = VIEW.me;
}

/* ---------- Bootstrap: check for existing session on load ---------- */
(async function init(){
  try{
    SESSION = await api("/api/session");
    await loadOverview();
    showApp();
    render();
  }catch(e){
    showLogin();
  }
})();

/* ---------- Data lookup helpers (scoped to whatever VIEW currently holds) ---------- */
function getCaregiver(id){
  if(VIEW.role==="admin") return VIEW.caregivers.find(c=>c.id===id);
  return VIEW.me.id===id ? VIEW.me : null;
}
function getClient(id){ return VIEW.clients.find(c=>c.id===id); }
function todaysShifts(){ return VIEW.shifts.filter(s=>s.date===todayStr()); }
function shiftsForCaregiver(id){ return VIEW.shifts.filter(s=>s.caregiverId===id && s.date===todayStr()); }

function callStatusForShift(s, which){
  const call = s[which];
  if(call) return call.status;
  const now = new Date();
  const boundary = which==="callIn" ? new Date(s.startTime) : new Date(s.endTime);
  const graceMins = 15;
  const diffMins = minutesBetween(boundary, now);
  if(s.status === "skipped") return "n/a";
  if(diffMins > graceMins) return "overdue";
  if(diffMins > -graceMins) return "due-soon";
  return "not-yet";
}
function badgeForCallStatus(st){
  switch(st){
    case "on-time": return `<span class="badge badge-green">On time</span>`;
    case "late": return `<span class="badge badge-amber">Late</span>`;
    case "overdue": return `<span class="badge badge-red">Overdue — not called</span>`;
    case "due-soon": return `<span class="badge badge-blue">Due soon</span>`;
    case "not-yet": return `<span class="badge badge-gray">Not yet due</span>`;
    case "n/a": return `<span class="badge badge-gray">N/A</span>`;
    default: return "";
  }
}

/* ---------- Compliance deduction estimate ----------
   Looks at a caregiver's shifts over a rolling window and flags any
   where a Sandata call-in/out was never made (shift already ended) or
   the visit was skipped. Estimates the pay impact using their hourly
   wage so both the caregiver and the office can see it, not just a
   vague "you missed a call" message. This is an estimate/reminder —
   it doesn't move money on its own. */
const COMPLIANCE_WINDOW_DAYS = 14;
function computeComplianceDeduction(caregiverId, windowDays){
  windowDays = windowDays || COMPLIANCE_WINDOW_DAYS;
  const wage = (getCaregiver(caregiverId)||{}).hourlyWage || 0;
  const now = new Date();
  const cutoff = new Date(now.getTime() - windowDays*86400000);
  const shifts = VIEW.shifts.filter(s=>s.caregiverId===caregiverId);
  const issues = [];
  shifts.forEach(s=>{
    const shiftDate = new Date(s.date+"T00:00:00");
    if(shiftDate < cutoff || shiftDate > now) return;
    const end = new Date(s.endTime);
    const hours = Math.max(0, (new Date(s.endTime) - new Date(s.startTime)) / 3600000);
    if(s.status==="skipped"){
      // Already a known outcome — flag right away, no need to wait for the visit window to close.
      issues.push({shiftId:s.id, date:s.date, reason:"Visit skipped", hours});
    } else if(end <= now){
      // Only judge missing calls once the visit window has actually passed —
      // the caregiver may still be able to call in/out before then.
      if(!s.callIn){
        issues.push({shiftId:s.id, date:s.date, reason:"No Sandata call-in recorded", hours});
      } else if(!s.callOut){
        issues.push({shiftId:s.id, date:s.date, reason:"No Sandata call-out recorded", hours});
      }
    }
  });
  const missedDays = new Set(issues.map(i=>i.date)).size;
  const deduction = issues.reduce((sum,i)=> sum + i.hours*wage, 0);
  return { issues, missedDays, deduction, wage, windowDays };
}

/* ---------- Alerts ---------- */
function computeAlerts(){
  const alerts = [];
  const shifts = VIEW.role==="admin" ? todaysShifts() : todaysShifts();
  shifts.forEach(s=>{
    const cg = getCaregiver(s.caregiverId), cl = getClient(s.clientId);
    if(!cg || !cl || s.status==="skipped") return;
    const inStatus = callStatusForShift(s,"callIn");
    const outStatus = callStatusForShift(s,"callOut");
    if(inStatus==="overdue") alerts.push({level:"red", text:`Sandata call-IN overdue — ${cg.name} for ${cl.name}`});
    else if(inStatus==="due-soon") alerts.push({level:"blue", text:`Sandata call-in due soon — ${cg.name} for ${cl.name}`});
    if(s.callIn && s.status!=="completed" && outStatus==="overdue") alerts.push({level:"red", text:`Sandata call-OUT overdue — ${cg.name} for ${cl.name}`});
    else if(s.callIn && outStatus==="due-soon" && s.status!=="completed") alerts.push({level:"blue", text:`Sandata call-out due soon — ${cg.name} for ${cl.name}`});
  });
  todaysShifts().filter(s=>s.status==="skipped").forEach(s=>{
    const cg=getCaregiver(s.caregiverId), cl=getClient(s.clientId);
    if(cg && cl) alerts.push({level:"amber", text:`Skipped visit needs follow-up — ${cl.name} (was ${cg.name})`});
  });
  const cgList = VIEW.role==="admin" ? VIEW.caregivers : [VIEW.me];
  cgList.forEach(cg=>{
    (cg.certifications||[]).forEach(cert=>{
      const d = daysUntil(cert.expiresOn);
      if(d!==null && d<=30) alerts.push({level: d<0 ? "red":"amber", text:`${d<0?"EXPIRED":"Expiring in "+d+"d"}: ${cert.name} — ${cg.name}`});
    });
  });
  VIEW.messages.forEach(m=>{
    if(!m.readBy.includes(SESSION.id) && m.fromId!==SESSION.id){
      alerts.push({level:"blue", text:`New message: "${m.subject}" from ${m.fromName}`});
    }
  });
  if(VIEW.role==="caregiver"){
    const comp = computeComplianceDeduction(SESSION.id);
    if(comp.missedDays>0){
      alerts.push({level:"red", text:`You have ${comp.missedDays} day(s) with missed Sandata calls or skipped visits in the last ${comp.windowDays} days — estimated $${comp.deduction.toFixed(2)} may be deducted from your pay.`});
    }
  } else {
    VIEW.caregivers.forEach(cg=>{
      const comp = computeComplianceDeduction(cg.id);
      if(comp.missedDays>0){
        alerts.push({level:"amber", text:`${cg.name}: ${comp.missedDays} non-compliant day(s) in the last ${comp.windowDays} days (~$${comp.deduction.toFixed(2)} pay impact)`});
      }
    });
  }
  return alerts;
}

/* ---------- Nav ---------- */
let scheduleFilterDate = null; // admin schedule page date filter, defaults to today on first render

const NAV = {
  admin: [
    {id:"dashboard", label:"Dashboard"},
    {id:"schedule", label:"Schedule"},
    {id:"skipped", label:"Skipped / Missed Visits"},
    {id:"recert", label:"Recertification"},
    {id:"roster", label:"Caregiver Roster & Accounts"},
    {id:"clients", label:"Clients"},
    {id:"tasktemplates", label:"Task Templates"},
    {id:"documents", label:"Documents"},
    {id:"messages", label:"Messages"},
    {id:"integrations", label:"Integrations"},
    {id:"myaccount", label:"My Account"}
  ],
  caregiver: [
    {id:"myshifts", label:"My Shifts Today"},
    {id:"myclients", label:"My Clients"},
    {id:"mydocuments", label:"My Documents"},
    {id:"mymessages", label:"Messages"},
    {id:"myaccount", label:"My Account"}
  ]
};

/* ---------- Render shell ---------- */
function render(){
  document.getElementById("dateLabel").textContent = new Date().toLocaleString([], {weekday:'short', month:'short', day:'numeric', hour:'2-digit', minute:'2-digit'});
  document.getElementById("roleLabel").textContent = VIEW.role==="admin" ? "Office Admin" : "Caregiver App";
  document.getElementById("whoLabel").textContent = SESSION.name;
  document.getElementById("whoRole").textContent = VIEW.role==="admin" ? "Office Administrator" : "Caregiver";
  renderNav();
  renderBell();
  renderMain();
}

function renderNav(){
  const items = NAV[VIEW.role];
  if(!items.find(i=>i.id===currentView)) currentView = items[0].id;
  const wrap = document.getElementById("navItems");
  wrap.innerHTML = items.map(i=>`<div class="nav-item ${i.id===currentView?'active':''}" data-nav="${i.id}">${i.label}</div>`).join("");
  wrap.querySelectorAll(".nav-item").forEach(el=>{
    el.addEventListener("click", ()=>{ currentView = el.dataset.nav; renderMain(); highlightNav(); closeMobileSidebar(); });
  });
}
function highlightNav(){
  document.querySelectorAll(".nav-item").forEach(el=> el.classList.toggle("active", el.dataset.nav===currentView));
}

/* ---------- Mobile sidebar toggle ---------- */
function openMobileSidebar(){
  document.getElementById("sidebar").classList.add("open");
  document.getElementById("sidebarBackdrop").classList.add("open");
}
function closeMobileSidebar(){
  document.getElementById("sidebar").classList.remove("open");
  document.getElementById("sidebarBackdrop").classList.remove("open");
}
document.getElementById("mobileNavToggle").addEventListener("click", openMobileSidebar);
document.getElementById("sidebarBackdrop").addEventListener("click", closeMobileSidebar);

function renderBell(){
  const alerts = computeAlerts();
  const badge = document.getElementById("bellBadge");
  if(alerts.length>0){ badge.style.display="inline-block"; badge.textContent = alerts.length; }
  else badge.style.display = "none";
  const list = document.getElementById("bellList");
  list.innerHTML = alerts.length===0
    ? `<div class="bell-empty">No alerts right now. All caught up!</div>`
    : alerts.map(a=>`<div class="bell-item"><span class="dot dot-${a.level}"></span><span>${a.text}</span></div>`).join("");
}
document.getElementById("bellBtn").addEventListener("click",(e)=>{ e.stopPropagation(); document.getElementById("bellPanel").classList.toggle("open"); });
document.addEventListener("click", ()=> document.getElementById("bellPanel").classList.remove("open"));

/* ---------- Main router ---------- */
function renderMain(){
  const main = document.getElementById("main");
  if(VIEW.role==="admin"){
    if(currentView==="dashboard") main.innerHTML = viewAdminDashboard();
    else if(currentView==="schedule") main.innerHTML = viewAdminSchedule();
    else if(currentView==="skipped") main.innerHTML = viewAdminSkipped();
    else if(currentView==="recert") main.innerHTML = viewAdminRecert();
    else if(currentView==="roster") main.innerHTML = viewAdminRoster();
    else if(currentView==="clients") main.innerHTML = viewAdminClients();
    else if(currentView==="tasktemplates") main.innerHTML = viewAdminTaskTemplates();
    else if(currentView==="documents") main.innerHTML = viewAdminDocuments();
    else if(currentView==="messages") main.innerHTML = viewAdminMessages();
    else if(currentView==="integrations") main.innerHTML = viewAdminIntegrations();
    else if(currentView==="myaccount") main.innerHTML = viewAdminAccount();
  } else {
    if(currentView==="myshifts") main.innerHTML = viewCaregiverShifts();
    else if(currentView==="myclients") main.innerHTML = viewCaregiverClients();
    else if(currentView==="mydocuments") main.innerHTML = viewCaregiverDocuments();
    else if(currentView==="mymessages") main.innerHTML = viewCaregiverMessages();
    else if(currentView==="myaccount") main.innerHTML = viewCaregiverAccount();
  }
  attachViewHandlers();
}

/* ---------- ADMIN views ---------- */
function viewAdminDashboard(){
  const shifts = todaysShifts();
  const completed = shifts.filter(s=>s.status==="completed").length;
  const skipped = shifts.filter(s=>s.status==="skipped").length;
  const total = shifts.length;
  let onTimeCalls=0, totalCalls=0;
  shifts.forEach(s=>{ ["callIn","callOut"].forEach(k=>{ if(s[k]){ totalCalls++; if(s[k].status==="on-time") onTimeCalls++; } }); });
  const compliance = totalCalls>0 ? Math.round((onTimeCalls/totalCalls)*100) : 100;
  const expiringCerts = [];
  VIEW.caregivers.forEach(cg=>(cg.certifications||[]).forEach(c=>{
    const d = daysUntil(c.expiresOn);
    if(d!==null && d<=30) expiringCerts.push({cg,c,d});
  }));
  const complianceByCg = VIEW.caregivers.map(cg=>({cg, comp: computeComplianceDeduction(cg.id)}));
  const totalDeduction = complianceByCg.reduce((sum,r)=> sum + r.comp.deduction, 0);
  const flaggedCaregivers = complianceByCg.filter(r=>r.comp.missedDays>0).length;

  return `
  <h1 class="page-title">Agency Dashboard</h1>
  <div class="page-sub">Overview for ${new Date().toLocaleDateString([], {weekday:'long', month:'long', day:'numeric'})}</div>
  <div class="kpi-row">
    <div class="kpi-card blue"><div class="kpi-val">${total}</div><div class="kpi-label">Visits scheduled today</div></div>
    <div class="kpi-card green"><div class="kpi-val">${completed}</div><div class="kpi-label">Completed</div></div>
    <div class="kpi-card red"><div class="kpi-val">${skipped}</div><div class="kpi-label">Skipped / missed</div></div>
    <div class="kpi-card ${compliance>=90?'green':compliance>=75?'amber':'red'}"><div class="kpi-val">${compliance}%</div><div class="kpi-label">Sandata on-time call rate</div></div>
    <div class="kpi-card ${flaggedCaregivers>0?'amber':'green'}"><div class="kpi-val">$${totalDeduction.toFixed(2)}</div><div class="kpi-label">Est. pay impact, ${flaggedCaregivers} caregiver(s), last ${COMPLIANCE_WINDOW_DAYS}d</div></div>
  </div>
  <div class="card"><h3>Live visit &amp; Sandata call status <span class="count">${total} today</span></h3>${renderShiftTable(shifts, true)}</div>
  <div class="card"><h3>Certifications expiring within 30 days <span class="count">${expiringCerts.length}</span></h3>
    ${expiringCerts.length===0 ? `<div class="empty-state">Nothing expiring soon.</div>` : `
    <div class="table-scroll"><table><thead><tr><th>Caregiver</th><th>Credential</th><th>Expires</th><th>Status</th></tr></thead><tbody>
    ${expiringCerts.map(e=>`<tr><td>${e.cg.name}</td><td>${e.c.name}</td><td>${e.c.expiresOn}</td><td>${e.d<0?'<span class="badge badge-red">Expired</span>':`<span class="badge badge-amber">${e.d}d left</span>`}</td></tr>`).join("")}
    </tbody></table></div>`}
  </div>`;
}

function renderShiftTable(shifts, showCaregiver){
  if(shifts.length===0) return `<div class="empty-state">No visits scheduled.</div>`;
  return `<div class="table-scroll"><table><thead><tr>
    ${showCaregiver ? "<th>Caregiver</th>" : ""}<th>Client</th><th>Window</th><th>Visit status</th><th>Call-in</th><th>Call-out</th>
  </tr></thead><tbody>
  ${shifts.map(s=>{
    const cg=getCaregiver(s.caregiverId), cl=getClient(s.clientId);
    const visitBadge = s.status==="completed" ? '<span class="badge badge-green">Completed</span>'
      : s.status==="skipped" ? '<span class="badge badge-red">Skipped</span>'
      : s.status==="in-progress" ? '<span class="badge badge-blue">In progress</span>'
      : '<span class="badge badge-gray">Scheduled</span>';
    return `<tr>
      ${showCaregiver ? `<td>${cg?cg.name:"—"}</td>` : ""}
      <td>${cl?cl.name:"—"}</td>
      <td>${fmtTimeFromISO(s.startTime)} – ${fmtTimeFromISO(s.endTime)}</td>
      <td>${visitBadge}</td>
      <td>${badgeForCallStatus(callStatusForShift(s,"callIn"))}</td>
      <td>${badgeForCallStatus(callStatusForShift(s,"callOut"))}</td>
    </tr>`;
  }).join("")}
  </tbody></table></div>`;
}

function viewAdminSchedule(){
  if(!scheduleFilterDate) scheduleFilterDate = todayStr();
  const shifts = VIEW.shifts.filter(s=>s.date===scheduleFilterDate).sort((a,b)=> new Date(a.startTime)-new Date(b.startTime));
  return `<h1 class="page-title">Schedule</h1><div class="page-sub">Create, reassign, or reschedule visits.</div>
  <div class="card">
    <div class="filter-bar" style="justify-content:space-between;">
      <div class="row-flex">
        <label style="font-size:12.5px;">Date: <input type="date" id="scheduleDateFilter" value="${scheduleFilterDate}"></label>
      </div>
      <button class="btn btn-primary btn-sm" id="btnOpenScheduleModal">+ Schedule new visit</button>
    </div>
    ${renderEditableShiftTable(shifts)}
  </div>`;
}

function renderEditableShiftTable(shifts){
  if(shifts.length===0) return `<div class="empty-state">No visits scheduled for this date.</div>`;
  return `<div class="table-scroll"><table><thead><tr><th>Caregiver</th><th>Client</th><th>Window</th><th>Visit status</th><th>Call-in</th><th>Call-out</th><th>Actions</th></tr></thead><tbody>
  ${shifts.map(s=>{
    const cg=getCaregiver(s.caregiverId), cl=getClient(s.clientId);
    const visitBadge = s.status==="completed" ? '<span class="badge badge-green">Completed</span>'
      : s.status==="skipped" ? '<span class="badge badge-red">Skipped</span>'
      : s.status==="in-progress" ? '<span class="badge badge-blue">In progress</span>'
      : '<span class="badge badge-gray">Scheduled</span>';
    return `<tr>
      <td>${cg?cg.name:"—"}</td>
      <td>${cl?cl.name:"—"}</td>
      <td>${fmtTimeFromISO(s.startTime)} – ${fmtTimeFromISO(s.endTime)}</td>
      <td>${visitBadge}</td>
      <td>${badgeForCallStatus(callStatusForShift(s,"callIn"))}</td>
      <td>${badgeForCallStatus(callStatusForShift(s,"callOut"))}</td>
      <td class="row-flex">
        <button class="btn btn-outline btn-sm" data-edit-shift="${s.id}">Edit</button>
        ${s.status==="scheduled" ? `<button class="btn btn-red btn-sm" data-cancel-shift="${s.id}">Cancel</button>` : ""}
      </td>
    </tr>`;
  }).join("")}
  </tbody></table></div>`;
}

function viewAdminSkipped(){
  const skipped = VIEW.shifts.filter(s=>s.status==="skipped");
  return `<h1 class="page-title">Skipped / Missed Visits</h1>
  <div class="page-sub">Visits that were not completed as scheduled, with reasons and follow-up tracking.</div>
  <div class="card">
    ${skipped.length===0 ? `<div class="empty-state">No skipped visits. 🎉</div>` : `
    <div class="table-scroll"><table><thead><tr><th>Date</th><th>Client</th><th>Assigned caregiver</th><th>Window</th><th>Reason</th><th>Follow-up</th></tr></thead><tbody>
    ${skipped.map(s=>{
      const cg=getCaregiver(s.caregiverId), cl=getClient(s.clientId);
      return `<tr>
        <td>${s.date}</td><td>${cl?cl.name:"—"}</td><td>${cg?cg.name:"—"}</td>
        <td>${fmtTimeFromISO(s.startTime)} – ${fmtTimeFromISO(s.endTime)}</td>
        <td>${s.skipReason||"—"}</td>
        <td>${s.resolved ? '<span class="badge badge-green">Resolved</span>' : `<button class="btn btn-outline btn-sm" data-resolve-shift="${s.id}">Mark resolved</button>`}</td>
      </tr>`;
    }).join("")}
    </tbody></table></div>`}
  </div>`;
}

function viewAdminRoster(){
  return `<h1 class="page-title">Caregiver Roster &amp; Accounts</h1>
  <div class="page-sub">Each caregiver has their own login. Create new accounts and manage credentials here.</div>

  <div class="card">
    <h3>Create a new caregiver account</h3>
    <div class="row-flex">
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Full name</label><input type="text" id="newCgName" placeholder="Jane Doe"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Username</label><input type="text" id="newCgUsername" placeholder="jdoe"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Temporary password</label><input type="text" id="newCgPassword" placeholder="min. 6 characters"></div>
    </div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Phone</label><input type="text" id="newCgPhone" placeholder="(555) 555-5555"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Email</label><input type="text" id="newCgEmail" placeholder="jane@example.com"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Hire date</label><input type="date" id="newCgHireDate"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Hourly wage ($)</label><input type="text" id="newCgWage" placeholder="18.50"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Sandata ID</label><input type="text" id="newCgSandataId" placeholder="Sandata caregiver ID"></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnCreateCaregiver">Create account</button></div>
  </div>

  <div class="card">
    <div class="table-scroll"><table><thead><tr><th>Name</th><th>Username</th><th>Phone</th><th>Sandata ID</th><th>Hire date</th><th>Hourly wage</th><th>Compliance (14d)</th><th>Credentials</th><th>Actions</th></tr></thead><tbody>
    ${VIEW.caregivers.map(cg=>{
      const comp = computeComplianceDeduction(cg.id);
      return `
      <tr>
        <td>${cg.name}</td>
        <td>${cg.username}</td>
        <td>${cg.phone}</td>
        <td>${cg.sandataId || '<span class="muted">—</span>'}</td>
        <td>${cg.hireDate}</td>
        <td>$${(cg.hourlyWage||0).toFixed(2)}/hr</td>
        <td>${comp.missedDays>0 ? `<span class="badge badge-red">${comp.missedDays}d · ~$${comp.deduction.toFixed(2)}</span>` : '<span class="badge badge-green">Clean</span>'}</td>
        <td><div class="tag-list">${(cg.certifications||[]).map(c=>{
          const d = daysUntil(c.expiresOn);
          const cls = c.pendingRenewal ? "badge-blue" : d<0 ? "badge-red" : d<=30 ? "badge-amber" : "badge-green";
          return `<span class="badge ${cls}">${c.name}: ${c.expiresOn||"—"}</span>`;
        }).join("") || '<span class="muted">—</span>'}</div></td>
        <td class="row-flex">
          <button class="btn btn-outline btn-sm" data-edit-caregiver="${cg.id}">Edit</button>
          <button class="btn btn-outline btn-sm" data-reset-pw="${cg.id}">Reset password</button>
        </td>
      </tr>`;
    }).join("")}
    </tbody></table></div>
  </div>`;
}

/* ---------- Admin: Clients ---------- */
function viewAdminClients(){
  return `<h1 class="page-title">Clients</h1>
  <div class="page-sub">Manage client records used when scheduling visits.</div>
  <div class="card">
    <h3>Add a new client</h3>
    <div class="row-flex">
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Name</label><input type="text" id="newClName" placeholder="Client full name"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Address</label><input type="text" id="newClAddress" placeholder="Street address"></div>
      <div style="flex:1;min-width:140px;"><label style="font-size:11.5px;color:var(--gray-600);">Phone</label><input type="text" id="newClPhone" placeholder="(555) 555-5555"></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnAddClient">Add client</button></div>
  </div>
  <div class="card">
    <div class="table-scroll"><table><thead><tr><th>Name</th><th>Address</th><th>Phone</th><th>Health conditions</th><th>Assigned caregivers</th><th>Status</th><th>Actions</th></tr></thead><tbody>
    ${VIEW.clients.map(c=>`
      <tr>
        <td>${c.name}</td><td>${c.address||"—"}</td><td>${c.phone||"—"}</td>
        <td><div class="tag-list">${(c.healthConditions||[]).map(cond=>`<span class="badge badge-amber">${cond}</span>`).join("") || '<span class="muted">None on file</span>'}</div></td>
        <td><div class="tag-list">${(c.assignedCaregiverIds||[]).map(id=>{
          const cg = getCaregiver(id);
          return cg ? `<span class="badge badge-blue">${cg.name}</span>` : "";
        }).join("") || '<span class="muted">Unassigned</span>'}</div></td>
        <td>${c.active ? '<span class="badge badge-green">Active</span>' : '<span class="badge badge-gray">Inactive</span>'}</td>
        <td class="row-flex">
          <button class="btn btn-outline btn-sm" data-edit-client="${c.id}">Edit</button>
          <button class="btn btn-outline btn-sm" data-manage-conditions="${c.id}">Health conditions</button>
          <button class="btn btn-outline btn-sm" data-assign-client="${c.id}">Assign caregivers</button>
          <button class="btn btn-outline btn-sm" data-toggle-client="${c.id}">${c.active ? "Deactivate" : "Reactivate"}</button>
        </td>
      </tr>`).join("")}
    </tbody></table></div>
  </div>`;
}

/* ---------- Admin: Task Templates ---------- */
function viewAdminTaskTemplates(){
  return `<h1 class="page-title">Task Templates</h1>
  <div class="page-sub">These are the default daily activity checklist items applied to every new visit. Editing this list doesn't change checklists already on existing visits.</div>
  <div class="card">
    <div class="row-flex">
      <input type="text" id="newTplName" placeholder="e.g. Range-of-motion exercises" style="flex:1;">
      <button class="btn btn-primary btn-sm" id="btnAddTaskTemplate">Add task</button>
    </div>
  </div>
  <div class="card">
    ${VIEW.taskTemplates.length===0 ? `<div class="empty-state">No task templates yet.</div>` :
    VIEW.taskTemplates.map(t=>`
      <div class="doc-row">
        <div class="doc-name">${t.name}</div>
        <div class="row-flex">
          <button class="btn btn-outline btn-sm" data-edit-tpl="${t.id}">Rename</button>
          <button class="btn btn-red btn-sm" data-delete-tpl="${t.id}">Delete</button>
        </div>
      </div>`).join("")}
  </div>`;
}

/* ---------- Admin: Recertification ---------- */
function viewAdminRecert(){
  const rows = [];
  VIEW.caregivers.forEach(cg=>(cg.certifications||[]).forEach(c=>{
    const status = c.pendingRenewal ? "pending" : (daysUntil(c.expiresOn) !== null && daysUntil(c.expiresOn) < 0 ? "expired" : (daysUntil(c.expiresOn) !== null && daysUntil(c.expiresOn) <= 30 ? "expiring" : null));
    if(status) rows.push({cg, cert:c, status});
  }));
  const pending = rows.filter(r=>r.status==="pending");
  const needsAction = rows.filter(r=>r.status!=="pending");

  return `<h1 class="page-title">Recertification</h1>
  <div class="page-sub">Reminders for expiring credentials, plus a review queue for submitted renewals.</div>

  <div class="card">
    <h3>Pending renewal review <span class="count">${pending.length}</span></h3>
    ${pending.length===0 ? `<div class="empty-state">No renewals waiting for review.</div>` : `
    <div class="table-scroll"><table><thead><tr><th>Caregiver</th><th>Credential</th><th>Current expiry</th><th>New expiry</th><th>Submitted</th><th>Document</th><th>Decision</th></tr></thead><tbody>
    ${pending.map(r=>`<tr>
      <td>${r.cg.name}</td><td>${r.cert.name}</td><td>${r.cert.expiresOn||"—"}</td><td>${r.cert.pendingRenewal.newExpiresOn}</td>
      <td>${r.cert.pendingRenewal.submittedOn} by ${r.cert.pendingRenewal.submittedByName}</td>
      <td><button class="btn btn-outline btn-sm" data-view-doc="${r.cert.pendingRenewal.documentId}">View</button></td>
      <td class="row-flex">
        <button class="btn btn-green btn-sm" data-approve-cert="${r.cert.id}">Approve</button>
        <button class="btn btn-red btn-sm" data-reject-cert="${r.cert.id}">Reject</button>
      </td>
    </tr>`).join("")}
    </tbody></table></div>`}
  </div>

  <div class="card">
    <h3>Needs renewal (expiring within 30 days or expired) <span class="count">${needsAction.length}</span></h3>
    ${needsAction.length===0 ? `<div class="empty-state">Nothing needs attention right now.</div>` : `
    <div class="table-scroll"><table><thead><tr><th>Caregiver</th><th>Credential</th><th>Expires</th><th>Status</th></tr></thead><tbody>
    ${needsAction.map(r=>{
      const d = daysUntil(r.cert.expiresOn);
      return `<tr><td>${r.cg.name}</td><td>${r.cert.name}</td><td>${r.cert.expiresOn}</td>
        <td>${d<0 ? '<span class="badge badge-red">Expired</span>' : `<span class="badge badge-amber">${d}d left</span>`}</td></tr>`;
    }).join("")}
    </tbody></table></div>`}
  </div>`;
}

function viewAdminDocuments(){
  return `<h1 class="page-title">Document Center</h1>
  <div class="page-sub">Agency policies, forms, and caregiver credential files.</div>
  <div class="card">
    <h3>Upload a new document</h3>
    <div class="field-row"><label>Document name / description</label><input type="text" id="newDocName" placeholder="e.g. Updated Care Plan - Eleanor Whitfield"></div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Category</label>
        <select class="field" id="newDocCategory"><option>Agency Policy</option><option>Certification</option><option>Care Plan</option><option>Health Record</option><option>Other</option></select>
      </div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Relates to</label>
        <select class="field" id="newDocRelated"><option value="agency">Agency-wide</option>${VIEW.caregivers.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select>
      </div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">File</label><input type="file" id="newDocFile"></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnUploadAdminDoc">Upload document</button></div>
  </div>
  <div class="card">
    <h3>All documents <span class="count">${VIEW.documents.length}</span></h3>
    ${VIEW.documents.length===0 ? `<div class="empty-state">No documents yet.</div>` :
    VIEW.documents.map(d=>`
      <div class="doc-row">
        <div><div class="doc-name">${d.name}</div><div class="doc-meta">${d.category} · ${d.relatedTo==="agency" ? "Agency-wide" : (getCaregiver(d.relatedTo)?.name||"—")} · uploaded ${d.uploadedOn} by ${d.uploadedBy}</div></div>
        <div class="row-flex">
          <button class="btn btn-outline btn-sm" data-view-doc="${d.id}">View</button>
          <button class="btn btn-outline btn-sm" data-download-doc="${d.id}">Download</button>
        </div>
      </div>`).join("")}
  </div>`;
}

function viewAdminMessages(){
  const msgs = [...VIEW.messages].sort((a,b)=> new Date(b.date)-new Date(a.date));
  return `<h1 class="page-title">Messages</h1>
  <div class="page-sub">Communicate with caregivers individually or broadcast to everyone.</div>
  <div class="card">
    <h3>Send a message</h3>
    <div class="field-row"><label>To</label><select class="field" id="newMsgTo"><option value="all">All caregivers</option>${VIEW.caregivers.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select></div>
    <div class="field-row"><label>Subject</label><input type="text" id="newMsgSubject" placeholder="Subject"></div>
    <div class="field-row"><label>Message</label><textarea id="newMsgBody" placeholder="Write your message..."></textarea></div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnSendAdminMsg">Send</button></div>
  </div>
  <div class="card">
    <h3>Message history <span class="count">${msgs.length}</span></h3>
    ${msgs.length===0 ? `<div class="empty-state">No messages yet.</div>` :
    msgs.map(m=>`<div class="msg-item">
      <div class="msg-head"><span>${m.fromName} → ${m.toId==="all" ? "All caregivers" : (getCaregiver(m.toId)?.name || (m.toId==="admin1"?"Office":m.toId))}</span><span class="msg-date">${new Date(m.date).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div>
      <div style="font-weight:600;font-size:13px;margin-top:2px;">${m.subject}</div>
      <div class="msg-body">${m.body}</div>
    </div>`).join("")}
  </div>`;
}

function viewAdminAccount(){
  return `<h1 class="page-title">My Account</h1>
  <div class="page-sub">Username: <b>${SESSION.username}</b></div>
  <div class="card">
    <h3>Change my password</h3>
    <div class="field-row"><label>Current password</label><input type="password" id="curPw"></div>
    <div class="field-row"><label>New password (min. 6 characters)</label><input type="password" id="newPw"></div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnChangePw">Update password</button></div>
  </div>`;
}

function viewAdminIntegrations(){
  const s = VIEW.sandataIntegration || {apiUrl:"", hasApiKey:false, connected:false, updatedAt:null, updatedBy:null};
  return `<h1 class="page-title">Integrations</h1>
  <div class="page-sub">Admin-only. This stores connection details for a future Sandata integration — it doesn't sync any data yet.</div>

  <div class="card">
    <h3>Sandata ${s.connected ? '<span class="badge badge-green">Connected</span>' : '<span class="badge badge-gray">Not connected</span>'}</h3>
    <div class="note-banner">Not live yet — this needs real API access from Sandata first (endpoint URL, auth method, available fields). Saving credentials here just stores them for when that's ready.</div>
    <div class="field-row"><label>API URL</label><input type="text" id="sandataApiUrl" placeholder="https://api.sandata.example/..." value="${s.apiUrl||''}"></div>
    <div class="field-row"><label>API key ${s.hasApiKey ? '<span class="muted">(a key is already saved — leave blank to keep it)</span>' : ''}</label><input type="password" id="sandataApiKey" placeholder="${s.hasApiKey ? '••••••••' : 'Paste API key'}"></div>
    ${s.updatedAt ? `<div class="muted" style="font-size:11.5px;margin-top:6px;">Last updated ${new Date(s.updatedAt).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})} by ${s.updatedBy||"—"}</div>` : ""}
    <div class="row-flex" style="margin-top:10px;">
      <button class="btn btn-primary btn-sm" id="btnSaveSandata">Save</button>
      <button class="btn btn-outline btn-sm" id="btnSyncSandata">Sync now</button>
    </div>
  </div>`;
}

/* ---------- CAREGIVER views ---------- */
function viewCaregiverShifts(){
  const shifts = shiftsForCaregiver(SESSION.id).sort((a,b)=> new Date(a.startTime)-new Date(b.startTime));
  const comp = computeComplianceDeduction(SESSION.id);
  return `<h1 class="page-title">Welcome, ${SESSION.name.split(" ")[0]}</h1>
  <div class="page-sub">Your visits for today. Remember: call in AND call out on the Sandata line for every visit.</div>
  ${comp.missedDays>0 ? `<div class="card" style="background:var(--red-light);border:1px solid var(--red);">
    <div style="font-weight:700;color:var(--red);font-size:14px;margin-bottom:4px;">⚠ Missed Sandata calls / skipped visits</div>
    <div style="font-size:13px;color:var(--gray-800);">You have <b>${comp.missedDays} day(s)</b> in the last ${comp.windowDays} days with a missed call-in, missed call-out, or skipped visit. Based on your hourly wage ($${comp.wage.toFixed(2)}/hr), this may result in approximately <b>$${comp.deduction.toFixed(2)}</b> being deducted from your pay. Contact the office if any of these need to be corrected.</div>
    <ul style="margin:8px 0 0;padding-left:18px;font-size:12.5px;color:var(--gray-600);">
      ${comp.issues.map(i=>`<li>${i.date} — ${i.reason} (${i.hours.toFixed(1)}h)</li>`).join("")}
    </ul>
  </div>` : ""}
  ${shifts.length===0 ? `<div class="card"><div class="empty-state">No visits scheduled for you today.</div></div>` : shifts.map(s=>renderCaregiverShiftCard(s)).join("")}`;
}

function renderCaregiverShiftCard(s){
  const cl = getClient(s.clientId);
  const inStatus = callStatusForShift(s,"callIn");
  const outStatus = callStatusForShift(s,"callOut");
  const visitBadge = s.status==="completed" ? '<span class="badge badge-green">Completed</span>'
    : s.status==="skipped" ? '<span class="badge badge-red">Skipped</span>'
    : s.status==="in-progress" ? '<span class="badge badge-blue">In progress</span>'
    : '<span class="badge badge-gray">Scheduled</span>';
  const doneCount = s.activities.filter(a=>a.done).length;

  const conditionTags = (cl.healthConditions||[]).length
    ? `<div class="tag-list" style="margin-top:6px;">${cl.healthConditions.map(cond=>`<span class="badge badge-amber">⚠ ${cond}</span>`).join("")}</div>`
    : "";

  if(s.status==="skipped"){
    return `<div class="shift-card">
      <div class="shift-head"><div><div class="client-name">${cl.name}</div><div class="meta">${cl.address} · ${fmtTimeFromISO(s.startTime)} – ${fmtTimeFromISO(s.endTime)}</div>${conditionTags}</div>${visitBadge}</div>
      <div class="field-row"><label>Reason for skipped visit</label><div class="muted">${s.skipReason||"—"}</div></div>
    </div>`;
  }

  return `<div class="shift-card">
    <div class="shift-head"><div><div class="client-name">${cl.name}</div><div class="meta">${cl.address} · ${cl.phone} · ${fmtTimeFromISO(s.startTime)} – ${fmtTimeFromISO(s.endTime)}</div>${conditionTags}</div>${visitBadge}</div>
    <div class="call-row">
      <div class="call-box">
        <div class="label">Sandata call-in</div>
        <div class="status-line">${badgeForCallStatus(inStatus)} ${s.callIn? " at "+fmtTimeFromISO(s.callIn.time):""}</div>
        <button class="btn btn-primary btn-sm" data-callin="${s.id}" ${s.callIn?"disabled":""}>${s.callIn?"Called in":"Call in now"}</button>
      </div>
      <div class="call-box">
        <div class="label">Sandata call-out</div>
        <div class="status-line">${badgeForCallStatus(outStatus)} ${s.callOut? " at "+fmtTimeFromISO(s.callOut.time):""}</div>
        <button class="btn btn-primary btn-sm" data-callout="${s.id}" ${!s.callIn || s.callOut ? "disabled":""}>${s.callOut?"Called out":"Call out now"}</button>
      </div>
    </div>
    <div class="checklist">
      <div class="label" style="font-size:11px;text-transform:uppercase;color:var(--gray-600);letter-spacing:0.03em;">Daily activities (${doneCount}/${s.activities.length})</div>
      <div class="checklist-grid">${s.activities.map((a,idx)=>`<label class="checklist-item"><input type="checkbox" data-activity="${s.id}:${idx}" ${a.done?"checked":""}> ${a.name}</label>`).join("")}</div>
    </div>
    <div class="field-row"><label>Visit notes</label><textarea data-notes="${s.id}" placeholder="Add notes about this visit...">${s.notes||""}</textarea></div>
    <div class="row-flex" style="margin-top:10px;">
      <button class="btn btn-green btn-sm" data-complete="${s.id}" ${s.status==="completed"?"disabled":""}>Mark visit complete</button>
      <button class="btn btn-red btn-sm" data-skip="${s.id}">Mark as skipped / unable to complete</button>
    </div>
  </div>`;
}

function viewCaregiverClients(){
  const assigned = VIEW.myAssignedClients || [];
  return `<h1 class="page-title">My Clients</h1>
  <div class="page-sub">Clients assigned to you on an ongoing basis, whether or not a visit is scheduled today.</div>
  <div class="card">
    ${assigned.length===0 ? `<div class="empty-state">No clients assigned to you yet — ask the office if this doesn't look right.</div>` : `
    <div class="table-scroll"><table><thead><tr><th>Name</th><th>Address</th><th>Phone</th><th>Health conditions</th></tr></thead><tbody>
    ${assigned.map(c=>`<tr><td>${c.name}</td><td>${c.address||"—"}</td><td>${c.phone||"—"}</td>
      <td><div class="tag-list">${(c.healthConditions||[]).map(cond=>`<span class="badge badge-amber">${cond}</span>`).join("") || '<span class="muted">None on file</span>'}</div></td>
    </tr>`).join("")}
    </tbody></table></div>`}
  </div>`;
}

function viewCaregiverDocuments(){
  const myDocs = VIEW.documents.filter(d=>d.relatedTo===SESSION.id);
  const agencyDocs = VIEW.documents.filter(d=>d.relatedTo==="agency");
  return `<h1 class="page-title">My Documents</h1>
  <div class="page-sub">Upload your credentials and view agency-wide forms and policies.</div>

  <div class="card">
    <h3>My certifications</h3>
    ${(SESSION.certifications||[]).length===0 ? `<div class="empty-state">No certifications on file yet — ask the office to add one.</div>` :
    SESSION.certifications.map(c=>{
      const d = daysUntil(c.expiresOn);
      const cls = c.pendingRenewal ? "badge-blue" : d<0 ? "badge-red" : d<=30 ? "badge-amber" : "badge-green";
      const label = c.pendingRenewal ? "Renewal submitted — awaiting office review" : d<0 ? "Expired" : d<=30 ? `Expires in ${d} day(s)` : "Valid";
      return `<div class="doc-row">
        <div><div class="doc-name">${c.name}</div><div class="doc-meta">Expires ${c.expiresOn||"—"} · <span class="badge ${cls}">${label}</span></div></div>
        ${c.pendingRenewal ? "" : `<button class="btn btn-outline btn-sm" data-renew-cert="${c.id}">Submit renewal</button>`}
      </div>`;
    }).join("")}
  </div>

  <div class="card">
    <h3>Upload a document</h3>
    <div class="field-row"><label>Document name</label><input type="text" id="newDocName" placeholder="e.g. Updated CPR Certificate"></div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Category</label><select class="field" id="newDocCategory"><option>Certification</option><option>Health Record</option><option>Other</option></select></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Expiration date (if applicable)</label><input type="date" class="field" id="newDocExpiry"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">File</label><input type="file" id="newDocFile"></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnUploadCaregiverDoc">Upload</button></div>
  </div>
  <div class="card"><h3>My credentials on file <span class="count">${myDocs.length}</span></h3>
    ${myDocs.length===0 ? `<div class="empty-state">No documents uploaded yet.</div>` :
    myDocs.map(d=>`<div class="doc-row"><div><div class="doc-name">${d.name}</div><div class="doc-meta">${d.category} · uploaded ${d.uploadedOn}${d.expiresOn?` · expires ${d.expiresOn}`:""}</div></div><div class="row-flex"><button class="btn btn-outline btn-sm" data-view-doc="${d.id}">View</button><button class="btn btn-outline btn-sm" data-download-doc="${d.id}">Download</button></div></div>`).join("")}
  </div>
  <div class="card"><h3>Agency policies &amp; forms <span class="count">${agencyDocs.length}</span></h3>
    ${agencyDocs.map(d=>`<div class="doc-row"><div><div class="doc-name">${d.name}</div><div class="doc-meta">${d.category} · uploaded ${d.uploadedOn}</div></div><div class="row-flex"><button class="btn btn-outline btn-sm" data-view-doc="${d.id}">View</button><button class="btn btn-outline btn-sm" data-download-doc="${d.id}">Download</button></div></div>`).join("")}
  </div>`;
}

function viewCaregiverMessages(){
  const msgs = [...VIEW.messages].sort((a,b)=>new Date(b.date)-new Date(a.date));
  msgs.forEach(m=>{ if(!m.readBy.includes(SESSION.id)) api(`/api/messages/${m.id}/read`, {method:"POST"}).catch(()=>{}); });
  return `<h1 class="page-title">Messages</h1>
  <div class="page-sub">Announcements from the office and your conversation history.</div>
  <div class="card">
    <h3>Message the office</h3>
    <div class="field-row"><label>Subject</label><input type="text" id="newMsgSubject" placeholder="Subject"></div>
    <div class="field-row"><label>Message</label><textarea id="newMsgBody" placeholder="Write your message..."></textarea></div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnSendCaregiverMsg">Send to office</button></div>
  </div>
  <div class="card"><h3>Inbox <span class="count">${msgs.length}</span></h3>
    ${msgs.length===0 ? `<div class="empty-state">No messages yet.</div>` :
    msgs.map(m=>`<div class="msg-item">
      <div class="msg-head"><span>${m.fromName} → ${m.toId==="all"?"All caregivers":m.toId==="admin1"?"Office":(getCaregiver(m.toId)?.name||m.toId)}</span><span class="msg-date">${new Date(m.date).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></div>
      <div style="font-weight:600;font-size:13px;margin-top:2px;">${m.subject}</div>
      <div class="msg-body">${m.body}</div>
    </div>`).join("")}
  </div>`;
}

function viewCaregiverAccount(){
  return `<h1 class="page-title">My Account</h1>
  <div class="page-sub">Username: <b>${SESSION.username}</b> · Hourly wage: <b>$${(SESSION.hourlyWage||0).toFixed(2)}/hr</b> (contact the office to update this)</div>
  <div class="card">
    <h3>Change my password</h3>
    <div class="field-row"><label>Current password</label><input type="password" id="curPw"></div>
    <div class="field-row"><label>New password (min. 6 characters)</label><input type="password" id="newPw"></div>
    <div style="margin-top:10px;"><button class="btn btn-primary" id="btnChangePw">Update password</button></div>
  </div>`;
}

/* ---------- Event handlers ---------- */
function attachViewHandlers(){
  const main = document.getElementById("main");

  main.querySelectorAll("[data-callin]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{ await api(`/api/shifts/${btn.dataset.callin}/call-in`, {method:"POST"}); await refresh(); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-callout]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{ await api(`/api/shifts/${btn.dataset.callout}/call-out`, {method:"POST"}); await refresh(); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-activity]").forEach(cb=>cb.addEventListener("change", async ()=>{
    const [shiftId, idx] = cb.dataset.activity.split(":");
    try{ await api(`/api/shifts/${shiftId}/activity`, {method:"PATCH", body:JSON.stringify({index:+idx, done:cb.checked})}); await refresh(false); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-notes]").forEach(ta=>ta.addEventListener("change", async ()=>{
    try{ await api(`/api/shifts/${ta.dataset.notes}/notes`, {method:"PATCH", body:JSON.stringify({notes:ta.value})}); await refresh(false); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-complete]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{ await api(`/api/shifts/${btn.dataset.complete}/complete`, {method:"POST"}); await refresh(); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-skip]").forEach(btn=>btn.addEventListener("click", ()=> openSkipModal(btn.dataset.skip)));
  main.querySelectorAll("[data-resolve-shift]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{ await api(`/api/admin/shifts/${btn.dataset.resolveShift}/resolve`, {method:"POST"}); await refresh(); }catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-download-doc]").forEach(btn=>btn.addEventListener("click", ()=>{
    window.open(`/api/documents/${btn.dataset.downloadDoc}/download`, "_blank");
  }));
  main.querySelectorAll("[data-view-doc]").forEach(btn=>btn.addEventListener("click", ()=>{
    window.open(`/api/documents/${btn.dataset.viewDoc}/view`, "_blank");
  }));
  main.querySelectorAll("[data-reset-pw]").forEach(btn=>btn.addEventListener("click", ()=> openResetPasswordModal(btn.dataset.resetPw)));
  main.querySelectorAll("[data-edit-caregiver]").forEach(btn=>btn.addEventListener("click", ()=> openEditCaregiverModal(btn.dataset.editCaregiver)));

  // Clients
  const btnAddClient = document.getElementById("btnAddClient");
  if(btnAddClient) btnAddClient.addEventListener("click", async ()=>{
    const name = document.getElementById("newClName").value.trim();
    const address = document.getElementById("newClAddress").value.trim();
    const phone = document.getElementById("newClPhone").value.trim();
    if(!name){ showToast("Client name is required.", true); return; }
    try{ await api("/api/admin/clients", {method:"POST", body: JSON.stringify({name, address, phone})}); showToast("Client added."); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  });
  main.querySelectorAll("[data-edit-client]").forEach(btn=>btn.addEventListener("click", ()=> openEditClientModal(btn.dataset.editClient)));
  main.querySelectorAll("[data-toggle-client]").forEach(btn=>btn.addEventListener("click", async ()=>{
    const c = VIEW.clients.find(x=>x.id===btn.dataset.toggleClient);
    try{ await api(`/api/admin/clients/${c.id}`, {method:"PATCH", body: JSON.stringify({active: !c.active})}); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-assign-client]").forEach(btn=>btn.addEventListener("click", ()=> openAssignClientModal(btn.dataset.assignClient)));
  main.querySelectorAll("[data-manage-conditions]").forEach(btn=>btn.addEventListener("click", ()=> openHealthConditionsModal(btn.dataset.manageConditions)));

  // Task templates
  const btnAddTpl = document.getElementById("btnAddTaskTemplate");
  if(btnAddTpl) btnAddTpl.addEventListener("click", async ()=>{
    const name = document.getElementById("newTplName").value.trim();
    if(!name){ showToast("Task name is required.", true); return; }
    try{ await api("/api/admin/task-templates", {method:"POST", body: JSON.stringify({name})}); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  });
  main.querySelectorAll("[data-edit-tpl]").forEach(btn=>btn.addEventListener("click", async ()=>{
    const t = VIEW.taskTemplates.find(x=>x.id===btn.dataset.editTpl);
    const name = prompt("Rename task:", t.name);
    if(!name || !name.trim()) return;
    try{ await api(`/api/admin/task-templates/${t.id}`, {method:"PATCH", body: JSON.stringify({name})}); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-delete-tpl]").forEach(btn=>btn.addEventListener("click", async ()=>{
    if(!confirm("Remove this task from the default checklist template?")) return;
    try{ await api(`/api/admin/task-templates/${btn.dataset.deleteTpl}`, {method:"DELETE"}); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  }));

  // Schedule page: date filter + create/edit/cancel shifts
  const dateFilter = document.getElementById("scheduleDateFilter");
  if(dateFilter) dateFilter.addEventListener("change", ()=>{ scheduleFilterDate = dateFilter.value; renderMain(); });
  const btnOpenSchedule = document.getElementById("btnOpenScheduleModal");
  if(btnOpenSchedule) btnOpenSchedule.addEventListener("click", ()=> openScheduleShiftModal());
  main.querySelectorAll("[data-edit-shift]").forEach(btn=>btn.addEventListener("click", ()=> openEditShiftModal(btn.dataset.editShift)));
  main.querySelectorAll("[data-cancel-shift]").forEach(btn=>btn.addEventListener("click", async ()=>{
    if(!confirm("Cancel this scheduled visit?")) return;
    try{ await api(`/api/admin/shifts/${btn.dataset.cancelShift}`, {method:"DELETE"}); showToast("Visit cancelled."); await refresh(false); }
    catch(e){ showToast(e.message, true); }
  }));

  // Recertification queue
  main.querySelectorAll("[data-approve-cert]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{ await api(`/api/admin/certifications/${btn.dataset.approveCert}/approve`, {method:"POST"}); showToast("Renewal approved."); await refresh(); }
    catch(e){ showToast(e.message, true); }
  }));
  main.querySelectorAll("[data-reject-cert]").forEach(btn=>btn.addEventListener("click", ()=> openRejectCertModal(btn.dataset.rejectCert)));

  // Caregiver: submit a certification renewal
  main.querySelectorAll("[data-renew-cert]").forEach(btn=>btn.addEventListener("click", ()=> openRenewCertModal(btn.dataset.renewCert)));

  const btnUploadAdmin = document.getElementById("btnUploadAdminDoc");
  if(btnUploadAdmin) btnUploadAdmin.addEventListener("click", ()=> handleDocUpload({ relatedTo: document.getElementById("newDocRelated").value }));

  const btnUploadCg = document.getElementById("btnUploadCaregiverDoc");
  if(btnUploadCg) btnUploadCg.addEventListener("click", ()=> handleDocUpload({ expiryEl:"newDocExpiry" }));

  const btnCreateCaregiver = document.getElementById("btnCreateCaregiver");
  if(btnCreateCaregiver) btnCreateCaregiver.addEventListener("click", async ()=>{
    const name = document.getElementById("newCgName").value.trim();
    const username = document.getElementById("newCgUsername").value.trim();
    const password = document.getElementById("newCgPassword").value;
    const phone = document.getElementById("newCgPhone").value.trim();
    const email = document.getElementById("newCgEmail").value.trim();
    const hireDate = document.getElementById("newCgHireDate").value;
    const hourlyWage = document.getElementById("newCgWage").value.trim();
    const sandataId = document.getElementById("newCgSandataId").value.trim();
    if(!name || !username || !password){ showToast("Name, username, and password are required.", true); return; }
    try{
      await api("/api/admin/caregivers", {method:"POST", body: JSON.stringify({name, username, password, phone, email, hireDate, hourlyWage, sandataId})});
      showToast(`Account created for ${name}. Share the username/password with them securely.`);
      await refresh();
    }catch(e){ showToast(e.message, true); }
  });

  const btnSendAdminMsg = document.getElementById("btnSendAdminMsg");
  if(btnSendAdminMsg) btnSendAdminMsg.addEventListener("click", async ()=>{
    const to = document.getElementById("newMsgTo").value;
    const subject = document.getElementById("newMsgSubject").value.trim();
    const body = document.getElementById("newMsgBody").value.trim();
    try{ await api("/api/messages", {method:"POST", body: JSON.stringify({to, subject, body})}); await refresh(); }catch(e){ showToast(e.message, true); }
  });

  const btnSendCgMsg = document.getElementById("btnSendCaregiverMsg");
  if(btnSendCgMsg) btnSendCgMsg.addEventListener("click", async ()=>{
    const subject = document.getElementById("newMsgSubject").value.trim();
    const body = document.getElementById("newMsgBody").value.trim();
    try{ await api("/api/messages", {method:"POST", body: JSON.stringify({subject, body})}); await refresh(); }catch(e){ showToast(e.message, true); }
  });

  const btnChangePw = document.getElementById("btnChangePw");
  if(btnChangePw) btnChangePw.addEventListener("click", async ()=>{
    const currentPassword = document.getElementById("curPw").value;
    const newPassword = document.getElementById("newPw").value;
    try{ await api("/api/change-password", {method:"POST", body: JSON.stringify({currentPassword, newPassword})}); showToast("Password updated."); document.getElementById("curPw").value=""; document.getElementById("newPw").value=""; }
    catch(e){ showToast(e.message, true); }
  });

  const btnSaveSandata = document.getElementById("btnSaveSandata");
  if(btnSaveSandata) btnSaveSandata.addEventListener("click", async ()=>{
    const apiUrl = document.getElementById("sandataApiUrl").value.trim();
    const apiKey = document.getElementById("sandataApiKey").value.trim();
    try{
      await api("/api/admin/integrations/sandata", {method:"POST", body: JSON.stringify({apiUrl, apiKey})});
      showToast("Saved.");
      await refresh(false);
    }catch(e){ showToast(e.message, true); }
  });

  const btnSyncSandata = document.getElementById("btnSyncSandata");
  if(btnSyncSandata) btnSyncSandata.addEventListener("click", async ()=>{
    try{
      await api("/api/admin/integrations/sandata/sync", {method:"POST"});
      showToast("Sync complete.");
    }catch(e){ showToast(e.message, true); }
  });
}

async function refresh(rerenderNav){
  await loadOverview();
  if(rerenderNav===false) { renderBell(); renderMain(); }
  else render();
}

function handleDocUpload({relatedTo, expiryEl}){
  const name = document.getElementById("newDocName").value.trim();
  const category = document.getElementById("newDocCategory").value;
  const fileInput = document.getElementById("newDocFile");
  const expiresOn = expiryEl ? (document.getElementById(expiryEl).value || "") : "";
  if(!name){ showToast("Please enter a document name.", true); return; }

  const fd = new FormData();
  fd.append("name", name);
  fd.append("category", category);
  if(relatedTo) fd.append("relatedTo", relatedTo);
  if(expiresOn) fd.append("expiresOn", expiresOn);
  if(fileInput.files && fileInput.files[0]) fd.append("file", fileInput.files[0]);

  api("/api/documents", {method:"POST", body: fd})
    .then(()=>{ showToast("Document uploaded."); return refresh(); })
    .catch(e=> showToast(e.message, true));
}

function openSkipModal(shiftId){
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <h3>Mark visit as skipped</h3>
    <div class="field-row"><label>Reason (required)</label><textarea id="skipReasonInput" placeholder="e.g. Client cancelled, caregiver called out sick, transportation issue..."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="skipCancelBtn">Cancel</button>
      <button class="btn btn-red" id="skipConfirmBtn">Confirm skip</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("skipCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("skipConfirmBtn").addEventListener("click", async ()=>{
    const reason = document.getElementById("skipReasonInput").value.trim();
    if(!reason){ showToast("Please provide a reason.", true); return; }
    try{
      await api(`/api/shifts/${shiftId}/skip`, {method:"POST", body: JSON.stringify({reason})});
      overlay.classList.remove("open");
      await refresh();
    }catch(e){ showToast(e.message, true); }
  });
}

function openResetPasswordModal(caregiverId){
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  const cg = VIEW.caregivers.find(c=>c.id===caregiverId);
  body.innerHTML = `
    <h3>Reset password for ${cg.name}</h3>
    <div class="field-row"><label>New temporary password (min. 6 characters)</label><input type="text" id="resetPwInput"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="resetCancelBtn">Cancel</button>
      <button class="btn btn-primary" id="resetConfirmBtn">Set password</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("resetCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("resetConfirmBtn").addEventListener("click", async ()=>{
    const newPassword = document.getElementById("resetPwInput").value;
    try{
      await api(`/api/admin/caregivers/${caregiverId}/reset-password`, {method:"POST", body: JSON.stringify({newPassword})});
      overlay.classList.remove("open");
      showToast(`Password reset for ${cg.name}. Share it with them securely.`);
    }catch(e){ showToast(e.message, true); }
  });
}

/* ---------- Edit caregiver modal (profile + certifications) ---------- */
function openEditCaregiverModal(cgId){
  document.getElementById("modalOverlay").classList.add("open");
  renderCaregiverEditModal(cgId, null);
}

function renderCaregiverEditModal(cgId, editingCertId){
  const cg = VIEW.caregivers.find(c=>c.id===cgId);
  const body = document.getElementById("modalBody");
  if(!cg){ document.getElementById("modalOverlay").classList.remove("open"); return; }
  body.innerHTML = `
    <h3>Edit ${cg.name}</h3>
    <div class="field-row"><label>Full name</label><input type="text" id="editCgName" value="${cg.name}"></div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Phone</label><input type="text" id="editCgPhone" value="${cg.phone||''}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Email</label><input type="text" id="editCgEmail" value="${cg.email||''}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Hire date</label><input type="date" id="editCgHireDate" value="${cg.hireDate||''}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Hourly wage ($)</label><input type="text" id="editCgWage" value="${cg.hourlyWage||0}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Sandata ID</label><input type="text" id="editCgSandataId" value="${cg.sandataId||''}"></div>
    </div>
    <div style="margin-top:10px;"><button class="btn btn-primary btn-sm" id="saveCgProfileBtn">Save profile</button></div>
    <hr class="divider">
    <h4 style="margin:0 0 8px;font-size:13.5px;">Assigned clients</h4>
    <div class="page-sub" style="margin:-4px 0 8px;">Same assignment as the Clients page — check a client here and they'll show as assigned there too.</div>
    <div id="assignedClientsWrap">
      ${VIEW.clients.length===0 ? '<div class="muted" style="font-size:12.5px;">No clients yet — add one from the Clients page first.</div>' :
        VIEW.clients.map(c=>`
        <label class="checklist-item" style="margin-bottom:6px;">
          <input type="checkbox" data-cg-assign-toggle="${c.id}" ${(c.assignedCaregiverIds||[]).includes(cgId)?"checked":""}> ${c.name}${c.active?"":' <span class="badge badge-gray">Inactive</span>'}
        </label>`).join("")}
    </div>
    <hr class="divider">
    <h4 style="margin:0 0 8px;font-size:13.5px;">Certifications</h4>
    <div id="certListWrap">
      ${(cg.certifications||[]).map(c=>renderCertRow(c, editingCertId)).join("") || '<div class="muted" style="font-size:12.5px;">None on file.</div>'}
    </div>
    <div class="row-flex" style="margin-top:10px;">
      <input type="text" id="newCertName" placeholder="Certification name" style="flex:1;">
      <input type="date" id="newCertExpiry" style="flex:1;">
      <button class="btn btn-outline btn-sm" id="addCertBtn">Add</button>
    </div>
    <div class="modal-actions"><button class="btn btn-outline" id="closeCgModalBtn">Close</button></div>
  `;

  document.getElementById("saveCgProfileBtn").addEventListener("click", async ()=>{
    const name = document.getElementById("editCgName").value.trim();
    const phone = document.getElementById("editCgPhone").value.trim();
    const email = document.getElementById("editCgEmail").value.trim();
    const hireDate = document.getElementById("editCgHireDate").value;
    const hourlyWage = document.getElementById("editCgWage").value.trim();
    const sandataId = document.getElementById("editCgSandataId").value.trim();
    if(!name){ showToast("Name cannot be empty.", true); return; }
    try{
      await api(`/api/admin/caregivers/${cgId}`, {method:"PATCH", body: JSON.stringify({name, phone, email, hireDate, hourlyWage, sandataId})});
      showToast("Profile updated.");
      await loadOverview(); renderMain(); renderCaregiverEditModal(cgId, null);
    }catch(e){ showToast(e.message, true); }
  });

  body.querySelectorAll("[data-cg-assign-toggle]").forEach(cb=>cb.addEventListener("change", async ()=>{
    const clientId = cb.dataset.cgAssignToggle;
    try{
      if(cb.checked){
        await api(`/api/admin/clients/${clientId}/assign`, {method:"POST", body: JSON.stringify({caregiverId: cgId})});
      } else {
        await api(`/api/admin/clients/${clientId}/assign/${cgId}`, {method:"DELETE"});
      }
      await loadOverview(); renderMain(); renderCaregiverEditModal(cgId, editingCertId);
    }catch(e){ showToast(e.message, true); }
  }));

  document.getElementById("addCertBtn").addEventListener("click", async ()=>{
    const name = document.getElementById("newCertName").value.trim();
    const expiresOn = document.getElementById("newCertExpiry").value || null;
    if(!name){ showToast("Certification name is required.", true); return; }
    try{
      await api(`/api/admin/caregivers/${cgId}/certifications`, {method:"POST", body: JSON.stringify({name, expiresOn})});
      await loadOverview(); renderMain(); renderCaregiverEditModal(cgId, null);
    }catch(e){ showToast(e.message, true); }
  });

  body.querySelectorAll("[data-edit-cert]").forEach(btn=>btn.addEventListener("click", ()=> renderCaregiverEditModal(cgId, btn.dataset.editCert)));
  body.querySelectorAll("[data-cancel-cert-edit]").forEach(btn=>btn.addEventListener("click", ()=> renderCaregiverEditModal(cgId, null)));
  body.querySelectorAll("[data-save-cert]").forEach(btn=>btn.addEventListener("click", async ()=>{
    const certId = btn.dataset.saveCert;
    const name = document.getElementById(`editCertName_${certId}`).value.trim();
    const expiresOn = document.getElementById(`editCertExpiry_${certId}`).value || null;
    try{
      await api(`/api/admin/caregivers/${cgId}/certifications/${certId}`, {method:"PATCH", body: JSON.stringify({name, expiresOn})});
      await loadOverview(); renderMain(); renderCaregiverEditModal(cgId, null);
    }catch(e){ showToast(e.message, true); }
  }));
  body.querySelectorAll("[data-delete-cert]").forEach(btn=>btn.addEventListener("click", async ()=>{
    if(!confirm("Remove this certification from the caregiver's profile?")) return;
    try{
      await api(`/api/admin/caregivers/${cgId}/certifications/${btn.dataset.deleteCert}`, {method:"DELETE"});
      await loadOverview(); renderMain(); renderCaregiverEditModal(cgId, null);
    }catch(e){ showToast(e.message, true); }
  }));
  document.getElementById("closeCgModalBtn").addEventListener("click", ()=> document.getElementById("modalOverlay").classList.remove("open"));
}

function renderCertRow(c, editingCertId){
  const d = daysUntil(c.expiresOn);
  const cls = c.pendingRenewal ? "badge-blue" : d<0 ? "badge-red" : d<=30 ? "badge-amber" : "badge-green";
  const label = c.pendingRenewal ? "Renewal pending review" : d===null ? "" : d<0 ? "Expired" : d<=30 ? `${d}d left` : "Valid";
  if(editingCertId === c.id){
    return `<div class="row-flex" style="margin-bottom:6px;">
      <input type="text" id="editCertName_${c.id}" value="${c.name}" style="flex:1;">
      <input type="date" id="editCertExpiry_${c.id}" value="${c.expiresOn||''}" style="flex:1;">
      <button class="btn btn-primary btn-sm" data-save-cert="${c.id}">Save</button>
      <button class="btn btn-outline btn-sm" data-cancel-cert-edit="1">Cancel</button>
    </div>`;
  }
  return `<div class="row-flex" style="margin-bottom:6px;justify-content:space-between;">
    <div style="font-size:12.5px;">${c.name} — ${c.expiresOn||"no expiry"} <span class="badge ${cls}">${label}</span></div>
    <div class="row-flex">
      <button class="btn btn-outline btn-sm" data-edit-cert="${c.id}">Edit</button>
      <button class="btn btn-red btn-sm" data-delete-cert="${c.id}">Delete</button>
    </div>
  </div>`;
}

/* ---------- Client add/edit modal ---------- */
function openEditClientModal(clientId){
  const c = VIEW.clients.find(x=>x.id===clientId);
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <h3>Edit client</h3>
    <div class="field-row"><label>Name</label><input type="text" id="editClName" value="${c.name}"></div>
    <div class="field-row"><label>Address</label><input type="text" id="editClAddress" value="${c.address||''}"></div>
    <div class="field-row"><label>Phone</label><input type="text" id="editClPhone" value="${c.phone||''}"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="editClCancelBtn">Cancel</button>
      <button class="btn btn-primary" id="editClSaveBtn">Save</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("editClCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("editClSaveBtn").addEventListener("click", async ()=>{
    const name = document.getElementById("editClName").value.trim();
    const address = document.getElementById("editClAddress").value.trim();
    const phone = document.getElementById("editClPhone").value.trim();
    if(!name){ showToast("Name cannot be empty.", true); return; }
    try{
      await api(`/api/admin/clients/${clientId}`, {method:"PATCH", body: JSON.stringify({name, address, phone})});
      overlay.classList.remove("open");
      await refresh(false);
    }catch(e){ showToast(e.message, true); }
  });
}

/* ---------- Assign caregivers to a client's ongoing caseload ---------- */
function openAssignClientModal(clientId){
  document.getElementById("modalOverlay").classList.add("open");
  renderAssignClientModal(clientId);
}

function renderAssignClientModal(clientId){
  const c = VIEW.clients.find(x=>x.id===clientId);
  const body = document.getElementById("modalBody");
  if(!c){ document.getElementById("modalOverlay").classList.remove("open"); return; }
  const assigned = new Set(c.assignedCaregiverIds||[]);
  body.innerHTML = `
    <h3>Assign caregivers — ${c.name}</h3>
    <div class="page-sub" style="margin-bottom:10px;">Caregivers checked here can see ${c.name} under "My Clients" even before a visit is scheduled. This doesn't restrict who can be scheduled for a visit — it's just the ongoing caseload assignment.</div>
    ${VIEW.caregivers.map(cg=>`
      <label class="checklist-item" style="margin-bottom:8px;">
        <input type="checkbox" data-assign-toggle="${cg.id}" ${assigned.has(cg.id)?"checked":""}> ${cg.name}
      </label>`).join("")}
    <div class="modal-actions"><button class="btn btn-outline" id="assignCloseBtn">Close</button></div>
  `;
  body.querySelectorAll("[data-assign-toggle]").forEach(cb=>cb.addEventListener("change", async ()=>{
    const caregiverId = cb.dataset.assignToggle;
    try{
      if(cb.checked){
        await api(`/api/admin/clients/${clientId}/assign`, {method:"POST", body: JSON.stringify({caregiverId})});
      } else {
        await api(`/api/admin/clients/${clientId}/assign/${caregiverId}`, {method:"DELETE"});
      }
      await loadOverview(); renderMain(); renderAssignClientModal(clientId);
    }catch(e){ showToast(e.message, true); }
  }));
  document.getElementById("assignCloseBtn").addEventListener("click", ()=> document.getElementById("modalOverlay").classList.remove("open"));
}

/* ---------- Health conditions per client ---------- */
function openHealthConditionsModal(clientId){
  document.getElementById("modalOverlay").classList.add("open");
  renderHealthConditionsModal(clientId);
}

function renderHealthConditionsModal(clientId){
  const c = VIEW.clients.find(x=>x.id===clientId);
  const body = document.getElementById("modalBody");
  if(!c){ document.getElementById("modalOverlay").classList.remove("open"); return; }
  body.innerHTML = `
    <h3>Health conditions — ${c.name}</h3>
    <div class="page-sub" style="margin-bottom:10px;">Shown to caregivers on this client's visits so relevant health info is visible up front (e.g. "Diabetic", "Fall risk", "Dementia", "Penicillin allergy").</div>
    <div class="tag-list" style="margin-bottom:12px;">
      ${(c.healthConditions||[]).map((cond,idx)=>`<span class="badge badge-amber">${cond} <span data-remove-condition="${idx}" style="cursor:pointer;font-weight:700;margin-left:4px;">&times;</span></span>`).join("") || '<span class="muted" style="font-size:12.5px;">None on file.</span>'}
    </div>
    <div class="row-flex">
      <input type="text" id="newConditionInput" placeholder="e.g. Fall risk" style="flex:1;">
      <button class="btn btn-outline btn-sm" id="addConditionBtn">Add</button>
    </div>
    <div class="modal-actions"><button class="btn btn-outline" id="conditionsCloseBtn">Close</button></div>
  `;
  document.getElementById("addConditionBtn").addEventListener("click", async ()=>{
    const condition = document.getElementById("newConditionInput").value.trim();
    if(!condition){ showToast("Enter a condition first.", true); return; }
    try{
      await api(`/api/admin/clients/${clientId}/health-conditions`, {method:"POST", body: JSON.stringify({condition})});
      await loadOverview(); renderMain(); renderHealthConditionsModal(clientId);
    }catch(e){ showToast(e.message, true); }
  });
  body.querySelectorAll("[data-remove-condition]").forEach(el=>el.addEventListener("click", async ()=>{
    try{
      await api(`/api/admin/clients/${clientId}/health-conditions/${el.dataset.removeCondition}`, {method:"DELETE"});
      await loadOverview(); renderMain(); renderHealthConditionsModal(clientId);
    }catch(e){ showToast(e.message, true); }
  }));
  document.getElementById("conditionsCloseBtn").addEventListener("click", ()=> document.getElementById("modalOverlay").classList.remove("open"));
}

/* ---------- Schedule / edit a visit ---------- */
function openScheduleShiftModal(){
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  const activeClients = VIEW.clients.filter(c=>c.active);
  body.innerHTML = `
    <h3>Schedule a new visit</h3>
    <div class="field-row"><label>Caregiver</label><select class="field" id="shCaregiver">${VIEW.caregivers.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select></div>
    <div class="field-row"><label>Client</label><select class="field" id="shClient">${activeClients.map(c=>`<option value="${c.id}">${c.name}</option>`).join("")}</select></div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Date</label><input type="date" id="shDate" value="${scheduleFilterDate||todayStr()}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Start time</label><input type="time" id="shStart" value="09:00"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">End time</label><input type="time" id="shEnd" value="11:00"></div>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="shCancelBtn">Cancel</button>
      <button class="btn btn-primary" id="shSaveBtn">Schedule visit</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("shCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("shSaveBtn").addEventListener("click", async ()=>{
    const caregiverId = document.getElementById("shCaregiver").value;
    const clientId = document.getElementById("shClient").value;
    const date = document.getElementById("shDate").value;
    const startTime = document.getElementById("shStart").value;
    const endTime = document.getElementById("shEnd").value;
    if(!date || !startTime || !endTime){ showToast("Date, start time, and end time are required.", true); return; }
    try{
      await api("/api/admin/shifts", {method:"POST", body: JSON.stringify({caregiverId, clientId, date, startTime, endTime})});
      overlay.classList.remove("open");
      scheduleFilterDate = date;
      showToast("Visit scheduled.");
      await refresh(false);
    }catch(e){ showToast(e.message, true); }
  });
}

function isoToTimeInput(iso){
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openEditShiftModal(shiftId){
  const s = VIEW.shifts.find(x=>x.id===shiftId);
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  const activeClients = VIEW.clients.filter(c=>c.active || c.id===s.clientId);
  body.innerHTML = `
    <h3>Edit visit</h3>
    <div class="field-row"><label>Caregiver</label><select class="field" id="editShCaregiver">${VIEW.caregivers.map(c=>`<option value="${c.id}" ${c.id===s.caregiverId?"selected":""}>${c.name}</option>`).join("")}</select></div>
    <div class="field-row"><label>Client</label><select class="field" id="editShClient">${activeClients.map(c=>`<option value="${c.id}" ${c.id===s.clientId?"selected":""}>${c.name}</option>`).join("")}</select></div>
    <div class="row-flex" style="margin-top:8px;">
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Date</label><input type="date" id="editShDate" value="${s.date}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">Start time</label><input type="time" id="editShStart" value="${isoToTimeInput(s.startTime)}"></div>
      <div style="flex:1;"><label style="font-size:11.5px;color:var(--gray-600);">End time</label><input type="time" id="editShEnd" value="${isoToTimeInput(s.endTime)}"></div>
    </div>
    <hr class="divider">
    <h4 style="margin:0 0 8px;font-size:13.5px;">Visit checklist</h4>
    <div id="shiftActivityList">
      ${s.activities.map((a,idx)=>`<div class="row-flex" style="margin-bottom:6px;justify-content:space-between;">
        <div style="font-size:12.5px;">${a.name}</div>
        <button class="btn btn-red btn-sm" data-remove-activity="${idx}">Remove</button>
      </div>`).join("") || '<div class="muted" style="font-size:12.5px;">No checklist items.</div>'}
    </div>
    <div class="row-flex" style="margin-top:8px;">
      <input type="text" id="newShiftActivity" placeholder="Add a task just for this visit" style="flex:1;">
      <button class="btn btn-outline btn-sm" id="addShiftActivityBtn">Add</button>
    </div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="editShCancelBtn">Close</button>
      <button class="btn btn-primary" id="editShSaveBtn">Save changes</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("editShCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("editShSaveBtn").addEventListener("click", async ()=>{
    const caregiverId = document.getElementById("editShCaregiver").value;
    const clientId = document.getElementById("editShClient").value;
    const date = document.getElementById("editShDate").value;
    const startTime = document.getElementById("editShStart").value;
    const endTime = document.getElementById("editShEnd").value;
    try{
      await api(`/api/admin/shifts/${shiftId}`, {method:"PATCH", body: JSON.stringify({caregiverId, clientId, date, startTime, endTime})});
      overlay.classList.remove("open");
      showToast("Visit updated.");
      await refresh(false);
    }catch(e){ showToast(e.message, true); }
  });
  document.getElementById("addShiftActivityBtn").addEventListener("click", async ()=>{
    const name = document.getElementById("newShiftActivity").value.trim();
    if(!name) return;
    try{
      await api(`/api/admin/shifts/${shiftId}/activities`, {method:"POST", body: JSON.stringify({name})});
      await loadOverview(); renderMain();
      openEditShiftModal(shiftId);
    }catch(e){ showToast(e.message, true); }
  });
  body.querySelectorAll("[data-remove-activity]").forEach(btn=>btn.addEventListener("click", async ()=>{
    try{
      await api(`/api/admin/shifts/${shiftId}/activities/${btn.dataset.removeActivity}`, {method:"DELETE"});
      await loadOverview(); renderMain();
      openEditShiftModal(shiftId);
    }catch(e){ showToast(e.message, true); }
  }));
}

/* ---------- Recertification: renew (caregiver) / reject (admin) ---------- */
function openRenewCertModal(certId){
  const cert = (SESSION.certifications||[]).find(c=>c.id===certId);
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <h3>Submit renewal — ${cert.name}</h3>
    <div class="page-sub" style="margin-bottom:10px;">Upload the new certificate. The office will review it before your expiration date updates.</div>
    <div class="field-row"><label>New expiration date</label><input type="date" id="renewExpiry"></div>
    <div class="field-row"><label>Upload file</label><input type="file" id="renewFile"></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="renewCancelBtn">Cancel</button>
      <button class="btn btn-primary" id="renewSubmitBtn">Submit for review</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("renewCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("renewSubmitBtn").addEventListener("click", async ()=>{
    const newExpiresOn = document.getElementById("renewExpiry").value;
    const fileInput = document.getElementById("renewFile");
    if(!newExpiresOn){ showToast("New expiration date is required.", true); return; }
    const fd = new FormData();
    fd.append("newExpiresOn", newExpiresOn);
    if(fileInput.files && fileInput.files[0]) fd.append("file", fileInput.files[0]);
    try{
      await api(`/api/certifications/${certId}/renew`, {method:"POST", body: fd});
      overlay.classList.remove("open");
      showToast("Renewal submitted for review.");
      await refresh();
    }catch(e){ showToast(e.message, true); }
  });
}

function openRejectCertModal(certId){
  const overlay = document.getElementById("modalOverlay");
  const body = document.getElementById("modalBody");
  body.innerHTML = `
    <h3>Reject this renewal</h3>
    <div class="field-row"><label>Reason (required, shared with the caregiver)</label><textarea id="rejectReason" placeholder="e.g. Document is illegible, wrong certificate type..."></textarea></div>
    <div class="modal-actions">
      <button class="btn btn-outline" id="rejectCancelBtn">Cancel</button>
      <button class="btn btn-red" id="rejectConfirmBtn">Reject renewal</button>
    </div>`;
  overlay.classList.add("open");
  document.getElementById("rejectCancelBtn").addEventListener("click", ()=> overlay.classList.remove("open"));
  document.getElementById("rejectConfirmBtn").addEventListener("click", async ()=>{
    const reason = document.getElementById("rejectReason").value.trim();
    if(!reason){ showToast("Please provide a reason.", true); return; }
    try{
      await api(`/api/admin/certifications/${certId}/reject`, {method:"POST", body: JSON.stringify({reason})});
      overlay.classList.remove("open");
      showToast("Renewal rejected.");
      await refresh();
    }catch(e){ showToast(e.message, true); }
  });
}

setInterval(()=>{ if(SESSION) refresh(false); }, 30000);
