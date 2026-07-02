/* ---------------------------------------------------------
   MySunshineCo — backend API (Vercel serverless / Supabase edition)

   Same API surface and permission model as the local prototype:
   real per-employee logins, and the server (not the client) decides
   what each session can see. Two things changed to make this work
   on Vercel's stateless functions instead of one long-running process:

   1. Data lives in Supabase Postgres instead of an in-memory/JSON file.
   2. Sessions are a signed JWT in an httpOnly cookie instead of
      express-session (which needs a server that stays alive in memory).

   Uploaded files live in Supabase Storage instead of a local uploads/ folder.
--------------------------------------------------------- */
const express = require("express");
const cookieParser = require("cookie-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const { supabase, STORAGE_BUCKET } = require("../lib/supabaseClient");

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  throw new Error("Missing JWT_SECRET environment variable. Set it in Vercel project settings (and locally in .env).");
}
const COOKIE_NAME = "mysc_session";
const SESSION_HOURS = 8;

function uid(prefix) { return prefix + "_" + crypto.randomBytes(4).toString("hex"); }
function pad(n) { return n.toString().padStart(2, "0"); }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function minutesBetween(a, b) { return Math.round((b - a) / 60000); }
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr + "T00:00:00");
  const now = new Date(); now.setHours(0, 0, 0, 0);
  return Math.round((d - now) / 86400000);
}

/* ---------- Row <-> API JSON mappers ----------
   The frontend (public/app.js) speaks the same camelCase shape as the original
   JSON-file prototype. These mappers keep that contract stable even though the
   database columns underneath are snake_case Postgres columns. */
function rowToPublicUser(u) {
  return {
    id: u.id, name: u.name, role: u.role, username: u.username,
    phone: u.phone || "", email: u.email || "", hireDate: u.hire_date,
    certifications: u.certifications || [], hourlyWage: Number(u.hourly_wage) || 0
  };
}
function rowToClient(c) {
  return { id: c.id, name: c.name, address: c.address || "", phone: c.phone || "", active: c.active };
}
function rowToShift(s) {
  return {
    id: s.id, caregiverId: s.caregiver_id, clientId: s.client_id, date: s.date,
    startTime: s.start_time, endTime: s.end_time, status: s.status,
    callIn: s.call_in, callOut: s.call_out, activities: s.activities || [],
    notes: s.notes || "", skipReason: s.skip_reason, resolved: !!s.resolved
  };
}
function rowToDocument(d) {
  return {
    id: d.id, name: d.name, category: d.category, relatedTo: d.related_to,
    uploadedBy: d.uploaded_by, uploadedById: d.uploaded_by_id, uploadedOn: d.uploaded_on,
    expiresOn: d.expires_on, hasFile: !!d.storage_path
  };
}
function rowToMessage(m) {
  return { id: m.id, fromId: m.from_id, fromName: m.from_name, toId: m.to_id, subject: m.subject, body: m.body, date: m.date, readBy: m.read_by || [] };
}
function rowToTaskTemplate(t) { return { id: t.id, name: t.name }; }

function callStatusForShift(s, which) {
  const call = which === "callIn" ? s.callIn : s.callOut;
  if (call) return call.status;
  const now = new Date();
  const boundary = which === "callIn" ? new Date(s.startTime) : new Date(s.endTime);
  const graceMins = 15;
  const diffMins = minutesBetween(boundary, now);
  if (s.status === "skipped") return "n/a";
  if (diffMins > graceMins) return "overdue";
  if (diffMins > -graceMins) return "due-soon";
  return "not-yet";
}

function throwIfError(error, context) {
  if (error) {
    const err = new Error(`${context}: ${error.message}`);
    err.status = 500;
    throw err;
  }
}

/* ---------- Data access helpers ---------- */
async function getUserById(id) {
  const { data, error } = await supabase.from("users").select("*").eq("id", id).maybeSingle();
  throwIfError(error, "getUserById");
  return data;
}
async function getUserByUsername(username) {
  const { data, error } = await supabase.from("users").select("*").eq("username", username).maybeSingle();
  throwIfError(error, "getUserByUsername");
  return data;
}
async function getCaregivers() {
  const { data, error } = await supabase.from("users").select("*").eq("role", "caregiver").order("name");
  throwIfError(error, "getCaregivers");
  return data;
}
async function findCertOwner(certId) {
  // Certifications live as a jsonb array on each user row — small enough scale that
  // scanning in JS (same approach as the original in-memory version) is simplest.
  const caregivers = await getCaregivers();
  for (const u of caregivers) {
    const cert = (u.certifications || []).find(c => c.id === certId);
    if (cert) return { userRow: u, cert };
  }
  return null;
}
async function getShiftById(id) {
  const { data, error } = await supabase.from("shifts").select("*").eq("id", id).maybeSingle();
  throwIfError(error, "getShiftById");
  return data ? rowToShift(data) : null;
}
async function getClientById(id) {
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  throwIfError(error, "getClientById");
  return data;
}

/* ---------- App setup ---------- */
const app = express();
app.use(express.json());
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function signSession(user) {
  return jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, { expiresIn: `${SESSION_HOURS}h` });
}
function setSessionCookie(res, token) {
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_HOURS * 60 * 60 * 1000
  });
}

function requireAuth(req, res, next) {
  const token = req.cookies[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    req.userRole = payload.role;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Session expired or invalid — please sign in again" });
  }
}
function requireAdmin(req, res, next) {
  if (req.userRole !== "admin") return res.status(403).json({ error: "Admin only" });
  next();
}

// Wraps an async route handler so thrown errors become clean 500s instead of hanging the function.
function h(fn) {
  return (req, res) => fn(req, res).catch(err => {
    console.error(err);
    res.status(err.status || 500).json({ error: err.status ? err.message : "Something went wrong on the server" });
  });
}

/* ---------- Auth routes ---------- */
app.post("/api/login", h(async (req, res) => {
  const { username, password } = req.body || {};
  const user = await getUserByUsername((username || "").trim());
  if (!user || !bcrypt.compareSync(password || "", user.password_hash)) {
    return res.status(401).json({ error: "Invalid username or password" });
  }
  setSessionCookie(res, signSession(user));
  res.json(rowToPublicUser(user));
}));

app.post("/api/logout", (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get("/api/session", requireAuth, h(async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });
  res.json(rowToPublicUser(user));
}));

app.post("/api/change-password", requireAuth, h(async (req, res) => {
  const user = await getUserById(req.userId);
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
  if (!bcrypt.compareSync(currentPassword || "", user.password_hash)) return res.status(401).json({ error: "Current password is incorrect" });
  const { error } = await supabase.from("users").update({ password_hash: bcrypt.hashSync(newPassword, 10) }).eq("id", user.id);
  throwIfError(error, "change-password");
  res.json({ ok: true });
}));

/* ---------- Admin: manage caregiver accounts ---------- */
app.post("/api/admin/caregivers", requireAuth, requireAdmin, h(async (req, res) => {
  const { name, username, password, phone, email, hireDate, hourlyWage } = req.body || {};
  if (!name || !username || !password) return res.status(400).json({ error: "name, username, and password are required" });
  if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters" });
  const existing = await getUserByUsername(username);
  if (existing) return res.status(400).json({ error: "That username is already taken" });
  const wage = hourlyWage !== undefined && hourlyWage !== "" ? Number(hourlyWage) : 0;
  if (Number.isNaN(wage) || wage < 0) return res.status(400).json({ error: "Hourly wage must be a non-negative number" });
  const { data, error } = await supabase.from("users").insert({
    id: uid("cg"), name, username, password_hash: bcrypt.hashSync(password, 10),
    role: "caregiver", phone: phone || "", email: email || "", hire_date: hireDate || todayStr(),
    hourly_wage: wage, certifications: []
  }).select().single();
  throwIfError(error, "create-caregiver");
  res.json(rowToPublicUser(data));
}));

app.patch("/api/admin/caregivers/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user || user.role !== "caregiver") return res.status(404).json({ error: "Caregiver not found" });
  const { name, phone, email, hireDate, hourlyWage } = req.body || {};
  const patch = {};
  if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: "Name cannot be empty" }); patch.name = name.trim(); }
  if (phone !== undefined) patch.phone = phone;
  if (email !== undefined) patch.email = email;
  if (hireDate !== undefined) patch.hire_date = hireDate;
  if (hourlyWage !== undefined && hourlyWage !== "") {
    const wage = Number(hourlyWage);
    if (Number.isNaN(wage) || wage < 0) return res.status(400).json({ error: "Hourly wage must be a non-negative number" });
    patch.hourly_wage = wage;
  }
  const { data, error } = await supabase.from("users").update(patch).eq("id", user.id).select().single();
  throwIfError(error, "patch-caregiver");
  res.json(rowToPublicUser(data));
}));

app.post("/api/admin/caregivers/:id/reset-password", requireAuth, requireAdmin, h(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user || user.role !== "caregiver") return res.status(404).json({ error: "Caregiver not found" });
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "New password must be at least 6 characters" });
  const { error } = await supabase.from("users").update({ password_hash: bcrypt.hashSync(newPassword, 10) }).eq("id", user.id);
  throwIfError(error, "reset-password");
  res.json({ ok: true });
}));

app.post("/api/admin/caregivers/:id/certifications", requireAuth, requireAdmin, h(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user || user.role !== "caregiver") return res.status(404).json({ error: "Caregiver not found" });
  const { name, expiresOn } = req.body || {};
  if (!name) return res.status(400).json({ error: "Certification name required" });
  const certifications = [...(user.certifications || []), { id: uid("cert"), name, expiresOn: expiresOn || null, pendingRenewal: null }];
  const { data, error } = await supabase.from("users").update({ certifications }).eq("id", user.id).select().single();
  throwIfError(error, "add-certification");
  res.json(rowToPublicUser(data));
}));

app.patch("/api/admin/caregivers/:id/certifications/:certId", requireAuth, requireAdmin, h(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user || user.role !== "caregiver") return res.status(404).json({ error: "Caregiver not found" });
  const cert = (user.certifications || []).find(c => c.id === req.params.certId);
  if (!cert) return res.status(404).json({ error: "Certification not found" });
  const { name, expiresOn } = req.body || {};
  if (name !== undefined) cert.name = name;
  if (expiresOn !== undefined) cert.expiresOn = expiresOn;
  const { data, error } = await supabase.from("users").update({ certifications: user.certifications }).eq("id", user.id).select().single();
  throwIfError(error, "edit-certification");
  res.json(rowToPublicUser(data));
}));

app.delete("/api/admin/caregivers/:id/certifications/:certId", requireAuth, requireAdmin, h(async (req, res) => {
  const user = await getUserById(req.params.id);
  if (!user || user.role !== "caregiver") return res.status(404).json({ error: "Caregiver not found" });
  const before = (user.certifications || []).length;
  const certifications = (user.certifications || []).filter(c => c.id !== req.params.certId);
  if (certifications.length === before) return res.status(404).json({ error: "Certification not found" });
  const { data, error } = await supabase.from("users").update({ certifications }).eq("id", user.id).select().single();
  throwIfError(error, "delete-certification");
  res.json(rowToPublicUser(data));
}));

/* ---------- Admin: manage clients ---------- */
app.post("/api/admin/clients", requireAuth, requireAdmin, h(async (req, res) => {
  const { name, address, phone } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Client name is required" });
  const { data, error } = await supabase.from("clients").insert({ id: uid("cl"), name: name.trim(), address: address || "", phone: phone || "", active: true }).select().single();
  throwIfError(error, "create-client");
  res.json(rowToClient(data));
}));

app.patch("/api/admin/clients/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const { name, address, phone, active } = req.body || {};
  const patch = {};
  if (name !== undefined) { if (!name.trim()) return res.status(400).json({ error: "Name cannot be empty" }); patch.name = name.trim(); }
  if (address !== undefined) patch.address = address;
  if (phone !== undefined) patch.phone = phone;
  if (active !== undefined) patch.active = !!active;
  const { data, error } = await supabase.from("clients").update(patch).eq("id", req.params.id).select().maybeSingle();
  throwIfError(error, "patch-client");
  if (!data) return res.status(404).json({ error: "Client not found" });
  res.json(rowToClient(data));
}));

/* ---------- Admin: task templates ---------- */
app.post("/api/admin/task-templates", requireAuth, requireAdmin, h(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Task name is required" });
  const { data, error } = await supabase.from("task_templates").insert({ id: uid("tpl"), name: name.trim() }).select().single();
  if (error) {
    if (error.code === "23505") return res.status(400).json({ error: "That task already exists" });
    throwIfError(error, "create-task-template");
  }
  res.json(rowToTaskTemplate(data));
}));

app.patch("/api/admin/task-templates/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Task name is required" });
  const { data, error } = await supabase.from("task_templates").update({ name: name.trim() }).eq("id", req.params.id).select().maybeSingle();
  throwIfError(error, "edit-task-template");
  if (!data) return res.status(404).json({ error: "Task template not found" });
  res.json(rowToTaskTemplate(data));
}));

app.delete("/api/admin/task-templates/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const { data, error } = await supabase.from("task_templates").delete().eq("id", req.params.id).select().maybeSingle();
  throwIfError(error, "delete-task-template");
  if (!data) return res.status(404).json({ error: "Task template not found" });
  res.json({ ok: true });
}));

/* ---------- Role-scoped overview ----------
   The server decides what each session receives — caregivers only ever get
   their own shifts/documents/messages, admin gets everything. */
app.get("/api/overview", requireAuth, h(async (req, res) => {
  const user = await getUserById(req.userId);
  if (!user) return res.status(401).json({ error: "Not authenticated" });

  if (user.role === "admin") {
    const [{ data: caregivers, error: e1 }, { data: clients, error: e2 }, { data: shifts, error: e3 },
      { data: documents, error: e4 }, { data: messages, error: e5 }, { data: taskTemplates, error: e6 }] = await Promise.all([
      supabase.from("users").select("*").eq("role", "caregiver").order("name"),
      supabase.from("clients").select("*").order("name"),
      supabase.from("shifts").select("*"),
      supabase.from("documents").select("*"),
      supabase.from("messages").select("*"),
      supabase.from("task_templates").select("*")
    ]);
    [e1, e2, e3, e4, e5, e6].forEach(e => throwIfError(e, "admin-overview"));
    return res.json({
      role: "admin",
      me: rowToPublicUser(user),
      caregivers: caregivers.map(rowToPublicUser),
      clients: clients.map(rowToClient),
      shifts: shifts.map(rowToShift),
      documents: documents.map(rowToDocument),
      messages: messages.map(rowToMessage),
      taskTemplates: taskTemplates.map(rowToTaskTemplate)
    });
  }

  const { data: myShiftRows, error: se } = await supabase.from("shifts").select("*").eq("caregiver_id", user.id);
  throwIfError(se, "caregiver-shifts");
  const myShifts = myShiftRows.map(rowToShift);
  const clientIds = [...new Set(myShifts.map(s => s.clientId))];
  const [{ data: clientRows, error: ce }, { data: docRows, error: de }, { data: msgRows, error: me }] = await Promise.all([
    clientIds.length ? supabase.from("clients").select("*").in("id", clientIds) : Promise.resolve({ data: [], error: null }),
    supabase.from("documents").select("*").or(`related_to.eq.${user.id},related_to.eq.agency`),
    supabase.from("messages").select("*").or(`to_id.eq.all,to_id.eq.${user.id},from_id.eq.${user.id}`)
  ]);
  [ce, de, me].forEach(e => throwIfError(e, "caregiver-overview"));
  res.json({
    role: "caregiver",
    me: rowToPublicUser(user),
    clients: clientRows.map(rowToClient),
    shifts: myShifts,
    documents: docRows.map(rowToDocument),
    messages: msgRows.map(rowToMessage)
  });
}));

/* ---------- Shift actions ---------- */
async function ownsShiftOrAdmin(req, res, shift) {
  if (req.userRole === "admin") return true;
  if (shift.caregiverId !== req.userId) { res.status(403).json({ error: "This is not your shift" }); return false; }
  return true;
}

app.post("/api/shifts/:id/call-in", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  if (shift.callIn) return res.status(400).json({ error: "Already called in for this shift" });
  const now = new Date();
  const late = minutesBetween(new Date(shift.startTime), now) > 15;
  const callIn = { time: now.toISOString(), status: late ? "late" : "on-time" };
  const { data, error } = await supabase.from("shifts").update({ call_in: callIn, status: "in-progress" }).eq("id", shift.id).select().single();
  throwIfError(error, "call-in");
  res.json(rowToShift(data));
}));

app.post("/api/shifts/:id/call-out", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  if (!shift.callIn) return res.status(400).json({ error: "Must call in before calling out" });
  if (shift.callOut) return res.status(400).json({ error: "Already called out for this shift" });
  const now = new Date();
  const late = minutesBetween(new Date(shift.endTime), now) > 15;
  const callOut = { time: now.toISOString(), status: late ? "late" : "on-time" };
  const { data, error } = await supabase.from("shifts").update({ call_out: callOut }).eq("id", shift.id).select().single();
  throwIfError(error, "call-out");
  res.json(rowToShift(data));
}));

app.patch("/api/shifts/:id/activity", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  const { index, done } = req.body || {};
  if (!shift.activities[index]) return res.status(400).json({ error: "Invalid activity index" });
  shift.activities[index].done = !!done;
  const { data, error } = await supabase.from("shifts").update({ activities: shift.activities }).eq("id", shift.id).select().single();
  throwIfError(error, "toggle-activity");
  res.json(rowToShift(data));
}));

app.patch("/api/shifts/:id/notes", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  const { data, error } = await supabase.from("shifts").update({ notes: (req.body && req.body.notes) || "" }).eq("id", shift.id).select().single();
  throwIfError(error, "update-notes");
  res.json(rowToShift(data));
}));

app.post("/api/shifts/:id/complete", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  const { data, error } = await supabase.from("shifts").update({ status: "completed" }).eq("id", shift.id).select().single();
  throwIfError(error, "complete-shift");
  res.json(rowToShift(data));
}));

app.post("/api/shifts/:id/skip", requireAuth, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (!(await ownsShiftOrAdmin(req, res, shift))) return;
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required to mark a visit skipped" });
  const { data, error } = await supabase.from("shifts").update({ status: "skipped", skip_reason: reason.trim(), resolved: false }).eq("id", shift.id).select().single();
  throwIfError(error, "skip-shift");
  res.json(rowToShift(data));
}));

app.post("/api/admin/shifts/:id/resolve", requireAuth, requireAdmin, h(async (req, res) => {
  const { data, error } = await supabase.from("shifts").update({ resolved: true }).eq("id", req.params.id).select().maybeSingle();
  throwIfError(error, "resolve-shift");
  if (!data) return res.status(404).json({ error: "Shift not found" });
  res.json(rowToShift(data));
}));

function combineDateTime(dateStr, timeStr) {
  const [hh, mm] = (timeStr || "00:00").split(":").map(Number);
  const d = new Date(dateStr + "T00:00:00");
  d.setHours(hh || 0, mm || 0, 0, 0);
  return d.toISOString();
}

app.post("/api/admin/shifts", requireAuth, requireAdmin, h(async (req, res) => {
  const { caregiverId, clientId, date, startTime, endTime } = req.body || {};
  const cg = await getUserById(caregiverId);
  const cl = await getClientById(clientId);
  if (!cg || cg.role !== "caregiver") return res.status(400).json({ error: "Unknown caregiver" });
  if (!cl) return res.status(400).json({ error: "Unknown client" });
  if (!date || !startTime || !endTime) return res.status(400).json({ error: "Date, start time, and end time are required" });
  const { data: templates, error: te } = await supabase.from("task_templates").select("*");
  throwIfError(te, "load-templates");
  const activities = templates.map(t => ({ name: t.name, done: false }));
  const { data, error } = await supabase.from("shifts").insert({
    id: uid("sh"), caregiver_id: caregiverId, client_id: clientId, date,
    start_time: combineDateTime(date, startTime), end_time: combineDateTime(date, endTime),
    status: "scheduled", call_in: null, call_out: null, activities, notes: "", skip_reason: null, resolved: false
  }).select().single();
  throwIfError(error, "create-shift");
  res.json(rowToShift(data));
}));

app.patch("/api/admin/shifts/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  const { caregiverId, clientId, date, startTime, endTime } = req.body || {};
  const patch = {};
  if (caregiverId !== undefined) {
    const cg = await getUserById(caregiverId);
    if (!cg || cg.role !== "caregiver") return res.status(400).json({ error: "Unknown caregiver" });
    patch.caregiver_id = caregiverId;
  }
  if (clientId !== undefined) {
    const cl = await getClientById(clientId);
    if (!cl) return res.status(400).json({ error: "Unknown client" });
    patch.client_id = clientId;
  }
  const newDate = date !== undefined ? date : shift.date;
  if (startTime !== undefined) patch.start_time = combineDateTime(newDate, startTime);
  if (endTime !== undefined) patch.end_time = combineDateTime(newDate, endTime);
  if (date !== undefined) patch.date = date;
  const { data, error } = await supabase.from("shifts").update(patch).eq("id", shift.id).select().single();
  throwIfError(error, "edit-shift");
  res.json(rowToShift(data));
}));

app.delete("/api/admin/shifts/:id", requireAuth, requireAdmin, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  if (shift.status !== "scheduled") return res.status(400).json({ error: "Only shifts that haven't started yet can be cancelled — edit it instead if it needs correcting." });
  const { error } = await supabase.from("shifts").delete().eq("id", shift.id);
  throwIfError(error, "cancel-shift");
  res.json({ ok: true });
}));

app.post("/api/admin/shifts/:id/activities", requireAuth, requireAdmin, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  const { name } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: "Task name is required" });
  shift.activities.push({ name: name.trim(), done: false });
  const { data, error } = await supabase.from("shifts").update({ activities: shift.activities }).eq("id", shift.id).select().single();
  throwIfError(error, "add-shift-activity");
  res.json(rowToShift(data));
}));

app.delete("/api/admin/shifts/:id/activities/:index", requireAuth, requireAdmin, h(async (req, res) => {
  const shift = await getShiftById(req.params.id);
  if (!shift) return res.status(404).json({ error: "Shift not found" });
  const idx = Number(req.params.index);
  if (!shift.activities[idx]) return res.status(400).json({ error: "Invalid activity index" });
  shift.activities.splice(idx, 1);
  const { data, error } = await supabase.from("shifts").update({ activities: shift.activities }).eq("id", shift.id).select().single();
  throwIfError(error, "remove-shift-activity");
  res.json(rowToShift(data));
}));

/* ---------- Documents (stored in Supabase Storage) ---------- */
const PREVIEWABLE_MIME = /^image\/|^application\/pdf$|^text\//;

async function canAccessDocument(userId, userRole, doc) {
  return userRole === "admin" || doc.related_to === "agency" || doc.related_to === userId;
}

app.post("/api/documents", requireAuth, upload.single("file"), h(async (req, res) => {
  const user = await getUserById(req.userId);
  const { name, category, expiresOn } = req.body || {};
  let relatedTo = req.body && req.body.relatedTo;
  if (user.role !== "admin") relatedTo = user.id;
  if (!relatedTo) relatedTo = "agency";

  const docId = uid("doc");
  let storagePath = null, originalName = null, mimeType = null;
  if (req.file) {
    storagePath = `${docId}-${req.file.originalname}`.replace(/\s+/g, "_");
    const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, req.file.buffer, {
      contentType: req.file.mimetype, upsert: false
    });
    throwIfError(upErr, "upload-file");
    originalName = req.file.originalname;
    mimeType = req.file.mimetype;
  }

  const { data, error } = await supabase.from("documents").insert({
    id: docId, name: name || originalName || "Untitled document", category: category || "Other",
    related_to: relatedTo, uploaded_by: user.name, uploaded_by_id: user.id, uploaded_on: todayStr(),
    expires_on: expiresOn || null, storage_path: storagePath, original_name: originalName, mime_type: mimeType
  }).select().single();
  throwIfError(error, "create-document");
  res.json(rowToDocument(data));
}));

async function getDocumentOr404(req, res) {
  const { data, error } = await supabase.from("documents").select("*").eq("id", req.params.id).maybeSingle();
  throwIfError(error, "get-document");
  if (!data) { res.status(404).send("Not found"); return null; }
  return data;
}

app.get("/api/documents/:id/download", requireAuth, h(async (req, res) => {
  const doc = await getDocumentOr404(req, res); if (!doc) return;
  if (!(await canAccessDocument(req.userId, req.userRole, doc))) return res.status(403).send("You do not have permission to download this file");
  if (doc.storage_path) {
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET)
      .createSignedUrl(doc.storage_path, 60, { download: doc.original_name || doc.name });
    throwIfError(error, "sign-download-url");
    return res.redirect(data.signedUrl);
  }
  res.setHeader("Content-Disposition", `attachment; filename="${doc.name.replace(/\.[a-zA-Z0-9]+$/, "")}.txt"`);
  res.send(`This is a placeholder for: ${doc.name}\nCategory: ${doc.category}\nUploaded: ${doc.uploaded_on} by ${doc.uploaded_by}`);
}));

app.get("/api/documents/:id/view", requireAuth, h(async (req, res) => {
  const doc = await getDocumentOr404(req, res); if (!doc) return;
  if (!(await canAccessDocument(req.userId, req.userRole, doc))) return res.status(403).send("You do not have permission to view this file");
  if (doc.storage_path) {
    const mime = doc.mime_type || "application/octet-stream";
    const wantsDownload = !PREVIEWABLE_MIME.test(mime);
    const { data, error } = await supabase.storage.from(STORAGE_BUCKET)
      .createSignedUrl(doc.storage_path, 60, wantsDownload ? { download: doc.original_name || doc.name } : undefined);
    throwIfError(error, "sign-view-url");
    return res.redirect(data.signedUrl);
  }
  res.setHeader("Content-Type", "text/plain");
  res.send(`This is a placeholder for: ${doc.name}\nCategory: ${doc.category}\nUploaded: ${doc.uploaded_on} by ${doc.uploaded_by}\n\n(No file was actually attached to this record.)`);
}));

/* ---------- Recertification workflow ---------- */
app.post("/api/certifications/:certId/renew", requireAuth, upload.single("file"), h(async (req, res) => {
  const found = await findCertOwner(req.params.certId);
  if (!found) return res.status(404).json({ error: "Certification not found" });
  const { userRow: owner, cert } = found;
  const actor = await getUserById(req.userId);
  if (actor.role !== "admin" && actor.id !== owner.id) return res.status(403).json({ error: "You can only submit renewals for your own certifications" });
  const { newExpiresOn } = req.body || {};
  if (!newExpiresOn) return res.status(400).json({ error: "New expiration date is required" });

  const docId = uid("doc");
  let storagePath = null, originalName = null, mimeType = null;
  if (req.file) {
    storagePath = `${docId}-${req.file.originalname}`.replace(/\s+/g, "_");
    const { error: upErr } = await supabase.storage.from(STORAGE_BUCKET).upload(storagePath, req.file.buffer, { contentType: req.file.mimetype });
    throwIfError(upErr, "upload-renewal-file");
    originalName = req.file.originalname; mimeType = req.file.mimetype;
  }
  const { error: docErr } = await supabase.from("documents").insert({
    id: docId, name: `${cert.name} renewal — ${owner.name}`, category: "Certification",
    related_to: owner.id, uploaded_by: actor.name, uploaded_by_id: actor.id, uploaded_on: todayStr(),
    expires_on: newExpiresOn, storage_path: storagePath, original_name: originalName, mime_type: mimeType
  });
  throwIfError(docErr, "create-renewal-document");

  const certifications = owner.certifications.map(c => c.id === cert.id
    ? { ...c, pendingRenewal: { documentId: docId, newExpiresOn, submittedOn: todayStr(), submittedById: actor.id, submittedByName: actor.name } }
    : c);
  const { data, error } = await supabase.from("users").update({ certifications }).eq("id", owner.id).select().single();
  throwIfError(error, "save-pending-renewal");
  res.json(rowToPublicUser(data));
}));

app.post("/api/admin/certifications/:certId/approve", requireAuth, requireAdmin, h(async (req, res) => {
  const found = await findCertOwner(req.params.certId);
  if (!found) return res.status(404).json({ error: "Certification not found" });
  const { userRow: owner, cert } = found;
  if (!cert.pendingRenewal) return res.status(400).json({ error: "No renewal is pending for this certification" });
  const certifications = owner.certifications.map(c => c.id === cert.id
    ? { ...c, expiresOn: c.pendingRenewal.newExpiresOn, lastRenewedOn: todayStr(), pendingRenewal: null }
    : c);
  const { data, error } = await supabase.from("users").update({ certifications }).eq("id", owner.id).select().single();
  throwIfError(error, "approve-renewal");
  res.json(rowToPublicUser(data));
}));

app.post("/api/admin/certifications/:certId/reject", requireAuth, requireAdmin, h(async (req, res) => {
  const found = await findCertOwner(req.params.certId);
  if (!found) return res.status(404).json({ error: "Certification not found" });
  const { userRow: owner, cert } = found;
  if (!cert.pendingRenewal) return res.status(400).json({ error: "No renewal is pending for this certification" });
  const { reason } = req.body || {};
  if (!reason || !reason.trim()) return res.status(400).json({ error: "A reason is required to reject a renewal" });
  const certifications = owner.certifications.map(c => c.id === cert.id
    ? { ...c, lastRejection: { reason: reason.trim(), date: todayStr() }, pendingRenewal: null }
    : c);
  const { data, error } = await supabase.from("users").update({ certifications }).eq("id", owner.id).select().single();
  throwIfError(error, "reject-renewal");
  res.json(rowToPublicUser(data));
}));

/* ---------- Messages ---------- */
app.post("/api/messages", requireAuth, h(async (req, res) => {
  const user = await getUserById(req.userId);
  const { to, subject, body } = req.body || {};
  if (!subject || !subject.trim() || !body || !body.trim()) return res.status(400).json({ error: "Subject and message body are required" });
  let toId = user.role === "admin" ? (to || "all") : "admin1";
  if (user.role === "admin" && toId !== "all" && !(await getUserById(toId))) return res.status(400).json({ error: "Unknown recipient" });
  const { data, error } = await supabase.from("messages").insert({
    id: uid("msg"), from_id: user.id, from_name: user.name, to_id: toId,
    subject: subject.trim(), body: body.trim(), read_by: [user.id]
  }).select().single();
  throwIfError(error, "send-message");
  res.json(rowToMessage(data));
}));

app.post("/api/messages/:id/read", requireAuth, h(async (req, res) => {
  const { data: msg, error: ge } = await supabase.from("messages").select("*").eq("id", req.params.id).maybeSingle();
  throwIfError(ge, "get-message");
  if (!msg) return res.status(404).json({ error: "Not found" });
  const readBy = msg.read_by || [];
  if (!readBy.includes(req.userId)) readBy.push(req.userId);
  const { data, error } = await supabase.from("messages").update({ read_by: readBy }).eq("id", msg.id).select().single();
  throwIfError(error, "mark-message-read");
  res.json(rowToMessage(data));
}));

module.exports = app;
