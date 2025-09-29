// app.cjs
require("dotenv").config();

const express = require("express");
const cors    = require("cors");
const crypto  = require("crypto");
const sgMail  = require("@sendgrid/mail");
const path    = require("path");

// --- ENV ---
const { SENDGRID_API_KEY, SENDGRID_FROM } = process.env;
if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith("SG.")) { console.error("SENDGRID_API_KEY hiányzik/rossz"); process.exit(1); }
if (!SENDGRID_FROM) { console.error("SENDGRID_FROM hiányzik"); process.exit(1); }
sgMail.setApiKey(SENDGRID_API_KEY);

// --- APP ---
const app = express();
app.use(cors());                           // CORS engedélyezés
app.use(express.json());                   // JSON body
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));        // index.html ugyaninnen

const appts = new Map();

// Segéd: bázis URL a tényleges domainekhez (Render, lokál, stb.)
function getBase(req) {
  const proto = req.headers["x-forwarded-proto"] || req.protocol || "http";
  const host  = req.headers["x-forwarded-host"]  || req.headers.host;
  return `${proto}://${host}`;
}
const linksOf = (req, id) => {
  const base = getBase(req);
  return {
    confirm: `${base}/confirm?id=${id}`,
    cancel:  `${base}/cancel?id=${id}`,
    status:  `${base}/status?id=${id}`,
  };
};

// Mail küldés
async function sendMail(to, subject, text, html) {
  const r = await sgMail.send({ from: `No-Show Shield <${SENDGRID_FROM}>`, to, subject, text, html });
  console.log("SENDGRID:", r[0]?.statusCode, r[0]?.headers?.["x-message-id"] || "");
}

// Timerek
function clearTimers(a){ for (const t of a.timers||[]) try{ clearTimeout(t.id);}catch{} a.timers=[]; }

function scheduleReminders(id){
  const a = appts.get(id); if(!a) return;
  const startMs = Date.parse(a.startsAt);
  const now = Date.now();

  // Teszt OFFSETS: -2 perc, -30 mp
  const OFFSETS = [120_000, 30_000];

  a.timers = a.timers || [];
  for (const off of OFFSETS){
    const runAt = startMs - off;
    const delay = runAt - now;
    if (delay <= 0) { console.log("SKIP offset", off, "delay<=0"); continue; }
    const tid = setTimeout(async () => {
      const cur = appts.get(id); if(!cur) return;
      if (!["scheduled","confirmed"].includes(cur.status)) return;
      const L = { confirm: cur.links.confirm, cancel: cur.links.cancel, status: cur.links.status };
      const human = new Date(startMs).toLocaleString();
      try {
        await sendMail(cur.to,
          `Emlékeztető (${Math.round(off/1000)}s előtte)`,
          [`Kezdés: ${cur.startsAt}`, `Visszaigazolás: ${L.confirm}`, `Lemondás: ${L.cancel}`, `Státusz: ${L.status}`].join("\n"),
          `<p>Kezdés: <b>${human}</b></p>
           <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
           <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
           <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
        );
        console.log("REMINDER SENT", { id, off });
      } catch(e) {
        console.error("REMINDER ERROR", off, e.response?.statusCode, e.response?.body || e.message);
      }
    }, delay);
    a.timers.push({ id: tid, runAt, offset: off });
    console.log("TIMER SCHEDULED", { id, off, runInSec: Math.round(delay/1000), runAt: new Date(runAt).toISOString() });
  }
}

// Egyszerű életjel
app.get("/ping", (_req, res) => res.send("pong"));

// Ütemezés – támogatja a GET query-t és a POST JSON-t is
app.all("/schedule", async (req, res) => {
  const to = (req.body?.email || req.body?.to || req.query?.to || "").toString().trim();
  const minutesRaw = req.body?.minutes ?? req.query?.minutes;
  const minutes = Number(minutesRaw);

  if (!to || !Number.isFinite(minutes) || minutes <= 0) {
    return res.status(400).json({ error: "Kell: to/email és minutes>0" });
  }

  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() + minutes * 60_000).toISOString();
  const L = linksOf(req, id);

  appts.set(id, { to, startsAt, status: "scheduled", timers: [], links: L });

  const human = new Date(startsAt).toLocaleString();
  try {
    await sendMail(to, "Időpont rögzítve",
      [`Kezdés: ${startsAt}`, `Visszaigazolás: ${L.confirm}`, `Lemondás: ${L.cancel}`, `Státusz: ${L.status}`].join("\n"),
      `<p>Kezdés: <b>${human}</b></p>
       <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
       <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
       <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
    );
  } catch (e) {
    return res.status(502).json({ error: "E-mail küldési hiba", details: e.response?.body || e.message });
  }

  scheduleReminders(id);

  res.json({
    id, to, startsAt, ...L,
    timers: appts.get(id).timers.map(t => ({ offsetSec: t.offset/1000, runAt: new Date(t.runAt).toISOString() }))
  });
});

app.get("/confirm", (req, res) => {
  const a = appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont");
  a.status="confirmed"; res.send("<b>Időpont visszaigazolva.</b>");
});
app.get("/cancel", (req, res) => {
  const a = appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont");
  a.status="cancelled"; clearTimers(a); res.send("<b>Időpont lemondva.</b>");
});
app.get("/status", (req, res) => {
  const a = appts.get(req.query.id); if(!a) return res.status(404).send("Nincs ilyen időpont");
  res.json({ id: req.query.id, to: a.to, startsAt: a.startsAt, status: a.status, timers: (a.timers||[]).map(t=>({offsetSec:t.offset/1000, runAt:new Date(t.runAt).toISOString()})) });
});

// Indítás Render-kompatibilisen
const PORT = process.env.PORT || 3001;
const HOST = "0.0.0.0";
app.listen(PORT, HOST, () => console.log(`No-Show Shield on http://${HOST}:${PORT}`));
