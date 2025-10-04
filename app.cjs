// app.cjs
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const path    = require("path");
const sgMail  = require("@sendgrid/mail");
const Stripe  = require("stripe");

// ===== ENV =====
const {
  SENDGRID_API_KEY,
  SENDGRID_FROM,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REDIRECT_URI,
  GOOGLE_REFRESH_TOKEN,
  TEST_MODE,
  REMINDER_OFFSETS,
  TEST_REMINDER_OFFSETS,
  STRIPE_SECRET_KEY,           // Stripe szerver kulcs (kötelező, ha Stripe-ot használsz)
} = process.env;

if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith("SG.")) { console.error("SENDGRID_API_KEY hiányzik/rossz"); process.exit(1); }
if (!SENDGRID_FROM) { console.error("SENDGRID_FROM hiányzik"); process.exit(1); }
sgMail.setApiKey(SENDGRID_API_KEY);

const stripe = STRIPE_SECRET_KEY ? Stripe(STRIPE_SECRET_KEY) : null;

// ===== APP =====
const app = express();
app.use((req,_res,next)=>{ console.log("HTTP", req.method, req.url); next(); });
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname)); // index.html itt van

// memória-MVP
const appts = new Map();
let googleTokens = null; // {access_token, refresh_token, expiry_date}

// ===== OFFSETS (éles vs teszt) =====
function parseOffsets(str, fallback) {
  if (!str) return fallback;
  try { const a = String(str).split(",").map(s=>Number(s.trim())).filter(n=>Number.isFinite(n)&&n>0); return a.length?a:fallback; }
  catch { return fallback; }
}
function getActiveOffsets() {
  const isTest = String(TEST_MODE||"0")==="1";
  const prod = parseOffsets(REMINDER_OFFSETS,[86400000,7200000,900000,300000]); // 24h,2h,15m,5m
  const test = parseOffsets(TEST_REMINDER_OFFSETS,[120000,30000]);              // 2m,30s
  const chosen = isTest?test:prod;
  console.log("OFFSETS ACTIVE:", chosen, "MODE:", isTest?"TEST":"PROD");
  return chosen;
}

// ===== HELPERS =====
function baseUrl(req){
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.headers.host;
  return `${proto}://${host}`;
}
const linksOf = (req,id)=>({
  confirm:`${baseUrl(req)}/confirm?id=${id}`,
  cancel: `${baseUrl(req)}/cancel?id=${id}`,
  status: `${baseUrl(req)}/status?id=${id}`,
});
async function sendMail(to, subject, text, html){
  const r = await sgMail.send({ from:`No-Show Shield <${SENDGRID_FROM}>`, to, subject, text, html });
  console.log("SENDGRID:", r[0]?.statusCode, r[0]?.headers?.["x-message-id"]||"");
}
function clearTimers(a){ for(const t of a.timers||[]) try{ clearTimeout(t.id);}catch{} a.timers=[]; }

function scheduleReminders(id, startIso, to, req){
  const startMs = Date.parse(startIso);
  const now = Date.now();
  const OFFSETS = getActiveOffsets();
  const L = linksOf(req,id);
  const a = { to, startsAt:startIso, status:"scheduled", timers:[], links:L };
  appts.set(id,a);

  for(const off of OFFSETS){
    const runAt = startMs - off, delay = runAt - now;
    if (delay<=0){ console.log("SKIP offset", off); continue; }
    const tid = setTimeout(async ()=>{
      const cur = appts.get(id); if(!cur) return;
      if(!["scheduled","confirmed"].includes(cur.status)) return;
      const human = new Date(startMs).toLocaleString();
      try{
        await sendMail(cur.to,
          `Emlékeztető (${Math.round(off/60000)} perc / ${Math.round(off/1000)} mp előtte)`,
          [`Kezdés: ${cur.startsAt}`,`Visszaigazolás: ${L.confirm}`,`Lemondás: ${L.cancel}`,`Státusz: ${L.status}`].join("\n"),
          `<p>Kezdés: <b>${human}</b></p>
           <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
           <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
           <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
        );
        console.log("REMINDER SENT",{id,off});
      }catch(e){ console.error("REMINDER ERROR", off, e.response?.statusCode, e.response?.body || e.message); }
    }, delay);
    a.timers.push({ id:tid, runAt, offset:off });
    console.log("TIMER SCHEDULED", { id, off, runInSec: Math.round(delay/1000), runAt: new Date(runAt).toISOString() });
  }
}

// ===== LIFE/HEALTH =====
app.get("/ping", (_req,res)=>res.send("pong"));
app.get("/health", (_req,res)=>res.json({ok:true}));

// ===== Google OAuth =====
async function exchangeAuthCodeForTokens(code){
  const body = new URLSearchParams({
    code,
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    redirect_uri: GOOGLE_REDIRECT_URI,
    grant_type: "authorization_code"
  });
  const r = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data = await r.json();
  if(!r.ok) throw new Error("Token csere hiba: "+JSON.stringify(data));
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || null,
    expiry_date: Date.now() + (data.expires_in||0)*1000
  };
}
async function refreshAccessToken(refreshToken){
  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  });
  const r = await fetch("https://oauth2.googleapis.com/token",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});
  const data = await r.json();
  if(!r.ok) throw new Error("Refresh hiba: "+JSON.stringify(data));
  return {
    access_token: data.access_token,
    refresh_token: refreshToken,
    expiry_date: Date.now() + (data.expires_in||0)*1000
  };
}
async function ensureAccessToken(){
  if (googleTokens?.access_token && googleTokens.expiry_date && googleTokens.expiry_date > Date.now()+60_000) return;
  if (googleTokens?.refresh_token) { googleTokens = await refreshAccessToken(googleTokens.refresh_token); console.log("Google token frissítve (memóriából)."); return; }
  if (GOOGLE_REFRESH_TOKEN)        { googleTokens = await refreshAccessToken(GOOGLE_REFRESH_TOKEN);        console.log("Google token frissítve (env refresh tokenből)."); return; }
  throw new Error("Nincs refresh token. Menj /auth-ra.");
}

app.get("/auth",(req,res)=>{
  if(!GOOGLE_CLIENT_ID||!GOOGLE_REDIRECT_URI) return res.status(500).send("Google OAuth nincs konfigurálva.");
  const p = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: GOOGLE_REDIRECT_URI,
    response_type: "code",
    scope: "https://www.googleapis.com/auth/calendar.readonly",
    access_type: "offline",
    prompt: "consent"
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`);
});

app.get("/oauth2callback", async (req,res)=>{
  const code = req.query.code;
  if(!code) return res.status(400).send("Hiányzó 'code'.");
  try{
    const t = await exchangeAuthCodeForTokens(code);
    googleTokens = t;
    if (t.refresh_token) {
      console.log("REFRESH_TOKEN:", t.refresh_token);
      console.log("Google engedélyezve. Van refresh token:", true);
      return res.send("<b>Google engedélyezve.</b><br>Másold ki a Render logból a <code>REFRESH_TOKEN</code> értéket és tedd be: <code>GOOGLE_REFRESH_TOKEN=...</code>. Utána redeploy.");
    } else {
      console.log("Google engedélyezve. NINCS új refresh token (valószínűleg már volt).");
      return res.send("<b>Google engedélyezve.</b>");
    }
  }catch(e){
    res.status(502).send(String(e.message||e));
  }
});

// ===== GCal listázás/ütemezés =====
app.get("/gcal/upcoming", async (req,res)=>{
  try{ await ensureAccessToken(); }
  catch(e){ return res.status(401).json({error:"Nincs Google engedély. /auth", detail:String(e.message||e)}); }

  const max = Math.min(Number(req.query.max||10),50);
  const nowIso = new Date().toISOString();
  const url = new URL("https://www.googleapis.com/calendar/v3/calendars/primary/events");
  url.searchParams.set("maxResults", String(max));
  url.searchParams.set("singleEvents","true");
  url.searchParams.set("orderBy","startTime");
  url.searchParams.set("timeMin", nowIso);

  const r = await fetch(url, { headers:{ Authorization:`Bearer ${googleTokens.access_token}` }});
  const data = await r.json();
  if(!r.ok) return res.status(r.status).json(data);
  const events = (data.items||[]).map(e=>({
    id:e.id,
    summary:e.summary||"(névtelen)",
    start:e.start?.dateTime||e.start?.date,
    end:e.end?.dateTime||e.end?.date,
    attendees:(e.attendees||[]).map(a=>a.email),
  }));
  res.json({events});
});

app.post("/gcal/schedule", async (req,res)=>{
  const { eventId, to } = req.body||{};
  if(!eventId || !to) return res.status(400).json({error:"Kell: eventId és to"});

  try{ await ensureAccessToken(); }
  catch(e){ return res.status(401).json({error:"Nincs Google engedély. /auth", detail:String(e.message||e)}); }

  const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
  const r = await fetch(url, { headers:{ Authorization:`Bearer ${googleTokens.access_token}` }});
  const e = await r.json();
  if(!r.ok) return res.status(r.status).json(e);

  const startIso = e.start?.dateTime || (e.start?.date ? new Date(e.start.date+"T09:00:00Z").toISOString() : null);
  if(!startIso) return res.status(400).json({error:"Az eseményhez nincs kezdési idő."});

  const id = crypto.randomUUID();

  const L = linksOf(req,id);
  const human = new Date(startIso).toLocaleString();
  try{
    await sendMail(String(to), "Időpont rögzítve",
      [`Kezdés: ${startIso}`,`Visszaigazolás: ${L.confirm}`,`Lemondás: ${L.cancel}`,`Státusz: ${L.status}`].join("\n"),
      `<p>Kezdés: <b>${human}</b></p>
       <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
       <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
       <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
    );
  }catch(err){
    return res.status(502).json({ error:"E-mail küldési hiba", details: err.response?.body || err.message });
  }

  scheduleReminders(id, startIso, String(to), req);
  res.json({ ok:true, id, to:String(to), startsAt:startIso, links:L });
});

// ===== Kézi percek alapú teszt (megtartjuk rejtett használatra) =====
app.all("/schedule", async (req,res)=>{
  const to = (req.body?.email || req.body?.to || req.query?.to || "").toString().trim();
  const minutesRaw = req.body?.minutes ?? req.query?.minutes;
  const minutes = Number(minutesRaw);
  if(!to || !Number.isFinite(minutes) || minutes<=0) return res.status(400).json({error:"Kell: to/email és minutes>0"});

  const startsAt = new Date(Date.now()+minutes*60_000).toISOString();
  const id = crypto.randomUUID();

  const L = linksOf(req,id);
  const human = new Date(startsAt).toLocaleString();
  try{
    await sendMail(to, "Időpont rögzítve",
      [`Kezdés: ${startsAt}`,`Visszaigazolás: ${L.confirm}`,`Lemondás: ${L.cancel}`,`Státusz: ${L.status}`].join("\n"),
      `<p>Kezdés: <b>${human}</b></p>
       <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
       <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
       <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
    );
  }catch(e){ return res.status(502).json({ error:"E-mail küldési hiba", details: e.response?.body || e.message }); }

  scheduleReminders(id, startsAt, to, req);
  res.json({
    id, to, startsAt, ...linksOf(req,id),
    timers: appts.get(id).timers.map(t=>({offsetSec:t.offset/1000, runAt:new Date(t.runAt).toISOString()}))
  });
});

// ===== Visszaigazolás / Lemondás / Státusz =====
app.get("/confirm",(req,res)=>{ const a=appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont"); a.status="confirmed"; res.send("<b>Időpont visszaigazolva.</b>"); });
app.get("/cancel",(req,res)=>{  const a=appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont"); a.status="cancelled"; clearTimers(a); res.send("<b>Időpont lemondva.</b>"); });
app.get("/status",(req,res)=>{  const a=appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont"); res.json({id:req.query.id,to:a.to,startsAt:a.startsAt,status:a.status,timers:(a.timers||[]).map(t=>({offsetSec:t.offset/1000,runAt:new Date(t.runAt).toISOString()}))}); });

// ===== STRIPE (Checkout, manuális capture) =====
app.post("/stripe/create", async (req,res)=>{
  try{
    if(!stripe) return res.status(500).json({error:"STRIPE_SECRET_KEY hiányzik"});
    const { amountHUF, email, successUrl, cancelUrl } = req.body||{};
    if(!amountHUF || !email) return res.status(400).json({ error:"Kell: amountHUF és email" });

    const session = await stripe.checkout.sessions.create({
      mode: "payment",
      payment_method_types: ["card"],
      customer_email: email,
      line_items: [{
        price_data: {
          currency: "huf",
          product_data: { name: "No-Show Fee" },
          unit_amount: Math.round(Number(amountHUF)),
        },
        quantity: 1
      }],
      success_url: successUrl || `${req.headers["x-forwarded-proto"]||"https"}://${req.headers["x-forwarded-host"]||req.headers.host}/success`,
      cancel_url:  cancelUrl  || `${req.headers["x-forwarded-proto"]||"https"}://${req.headers["x-forwarded-host"]||req.headers.host}/cancel`,
      payment_intent_data: {
        capture_method: "manual",             // előengedély (későbbi levonás)
        description: "No-Show Fee hold",
        metadata: { source:"nss", kind:"no-show-hold" }
      },
      expand: ["payment_intent"]
    });

    const piId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
    res.json({ checkout_url: session.url, payment_intent_id: piId || null });
  }catch(e){
    console.error("STRIPE CREATE ERROR:", e);
    res.status(502).json({ error:"Stripe hiba", details: e.message||e });
  }
});

app.post("/stripe/capture", async (req,res)=>{
  try{
    if(!stripe) return res.status(500).json({error:"STRIPE_SECRET_KEY hiányzik"});
    const { paymentIntentId, amountHUF } = req.body||{};
    if(!paymentIntentId) return res.status(400).json({error:"Kell: paymentIntentId"});
    const opts = amountHUF ? { amount_to_capture: Math.round(Number(amountHUF)) } : {};
    const pi = await stripe.paymentIntents.capture(paymentIntentId, opts);
    res.json({ ok:true, pi });
  }catch(e){
    console.error("STRIPE CAPTURE ERROR:", e);
    res.status(502).json({ error:"Stripe capture hiba", details:e.message||e });
  }
});

app.post("/stripe/cancel", async (req,res)=>{
  try{
    if(!stripe) return res.status(500).json({error:"STRIPE_SECRET_KEY hiányzik"});
    const { paymentIntentId } = req.body||{};
    if(!paymentIntentId) return res.status(400).json({error:"Kell: paymentIntentId"});
    const pi = await stripe.paymentIntents.cancel(paymentIntentId);
    res.json({ ok:true, pi });
  }catch(e){
    console.error("STRIPE CANCEL ERROR:", e);
    res.status(502).json({ error:"Stripe cancel hiba", details:e.message||e });
  }
});

app.get("/success", (_req,res)=>res.send("<b>Fizetés elindítva / sikeres.</b>"));
app.get("/cancel",  (_req,res)=>res.send("<b>Fizetés megszakítva.</b>"));

// ===== START =====
const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", ()=>console.log("No-Show Shield on port", PORT));
