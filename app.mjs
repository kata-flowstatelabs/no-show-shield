import express from "express";
import crypto from "crypto";
import sgMail from "@sendgrid/mail";

// DIAG
console.log("RUN:", import.meta.url);
console.log("CWD:", process.cwd());
console.log("ENV prefix:", process.env.SENDGRID_API_KEY ? process.env.SENDGRID_API_KEY.slice(0,3) : "NONE");
console.log("FROM:", process.env.SENDGRID_FROM || "NONE");

// ENV kötelezők
const { SENDGRID_API_KEY, SENDGRID_FROM } = process.env;
if (!SENDGRID_API_KEY || !SENDGRID_API_KEY.startsWith("SG.")) { console.error("SENDGRID_API_KEY hiányzik/rossz"); process.exit(1); }
if (!SENDGRID_FROM) { console.error("SENDGRID_FROM hiányzik"); process.exit(1); }

sgMail.setApiKey(SENDGRID_API_KEY);

const app = express();
const PORT = 3001;
const BASE = `http://localhost:${PORT}`;
const appts = new Map(); // id -> { to, startsAt, status, timers: [{id,runAt,offset}] }

const link = (p) => `${BASE}${p}`;
const links = (id) => ({
  confirm: link(`/confirm?id=${id}`),
  cancel:  link(`/cancel?id=${id}`),
  status:  link(`/status?id=${id}`),
});

async function sendMail(to, subject, text, html) {
  const r = await sgMail.send({ from: `No-Show Shield <${SENDGRID_FROM}>`, to, subject, text, html });
  console.log("SENDGRID:", r[0]?.statusCode, r[0]?.headers?.["x-message-id"] || "");
}

function clearTimers(a){ for (const t of a.timers||[]) try{ clearTimeout(t.id);}catch{} a.timers=[]; }

// === REMINDERS: -30s és -10s (TESZT) ===
function scheduleReminders(id){
  const a = appts.get(id); if(!a) return;
  const startMs = Date.parse(a.startsAt);
  const now = Date.now();
  const OFFSETS = [86_400_000, 7_200_000];

  a.timers = a.timers || [];
  for (const off of OFFSETS){
    const runAt = startMs - off;
    const delay = runAt - now;
    if (delay <= 0) { console.log("SKIP offset", off, "delay<=0"); continue; }
    const tid = setTimeout(async () => {
      const cur = appts.get(id); if(!cur) return console.log("Timer fired but missing appt", id);
      if (!["scheduled","confirmed"].includes(cur.status)) return console.log("Timer fired but status", cur.status);
      const L = links(id);
      const human = new Date(startMs).toLocaleString();
      console.log("TIMER FIRE", { id, off, at: new Date().toISOString() });
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

// === ROUTES ===
app.get("/schedule", async (req, res) => {
  const { to, minutes } = req.query;
  if (!to || !minutes) return res.status(400).send("Kell: to, minutes");

  const id = crypto.randomUUID();
  const startsAt = new Date(Date.now() + Number(minutes) * 60_000).toISOString();
  appts.set(id, { to: String(to), startsAt, status: "scheduled", timers: [] });

  const L = links(id);
  const human = new Date(startsAt).toLocaleString();

  try {
    await sendMail(String(to), "Időpont rögzítve",
      [`Kezdés: ${startsAt}`, `Visszaigazolás: ${L.confirm}`, `Lemondás: ${L.cancel}`, `Státusz: ${L.status}`].join("\n"),
      `<p>Kezdés: <b>${human}</b></p>
       <p>Visszaigazolás: <a href="${L.confirm}">${L.confirm}</a></p>
       <p>Lemondás: <a href="${L.cancel}">${L.cancel}</a></p>
       <p>Státusz: <a href="${L.status}">${L.status}</a></p>`
    );
  } catch (e) {
    return res.status(502).send("E-mail küldési hiba: " + JSON.stringify(e.response?.body || e.message));
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

app.listen(PORT, () => console.log(`No-Show Shield on :${PORT}`));
