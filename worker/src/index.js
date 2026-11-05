// Test-period proxy for Project Manager. The extension sends an access code; this
// checks it and the caps, calls OpenAI with the key held as a Worker secret, and
// records counts.
//
// Never logged, never stored: request or response bodies. This file has no
// console call, and nothing here writes text from a conversation anywhere. The
// only things written are the integer counts in schema.sql.
//
// The bill is bounded by construction: the worst-case cost of a request, at the
// configured prices, is reserved from the monthly dollar budget by a single atomic
// statement BEFORE OpenAI is called, and settled to the real figure after. Anything
// uncertain fails closed: a missing setting, an unreadable kill switch, a database
// error. The email alert is best-effort and decides nothing.
import { EmailMessage } from "cloudflare:email";

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";
const UPSTREAM_TIMEOUT_MS = 60000;
const ROLES = new Set(["system", "user", "assistant"]);
const TEXT = {
  paused: "The Project Manager test is paused. Nothing was sent to OpenAI. Try again later.",
  not_configured: "The Project Manager test server isn't set up correctly. Nothing was sent to OpenAI.",
  server_error: "The Project Manager test server hit a problem. Try again later.",
  unknown_code: "That access code isn't valid. Check it in Options.",
  budget_spent: "The Project Manager test has used this month's budget, so captures are off for everyone until next month. Nothing was sent to OpenAI.",
  too_large: "This reply is too long for the test server to send. Nothing was sent to OpenAI.",
  bad_request: "The test server couldn't read that request. Nothing was sent to OpenAI.",
  upstream_busy: "OpenAI is busy right now. Wait a minute and try again.",
  upstream_failed: "OpenAI didn't answer properly. Try again.",
};
const refuse = (status, code, message = TEXT[code]) => new Response(JSON.stringify({ error: { code, message } }), { status, headers: { "Content-Type": "application/json" } });
const day = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);

// Every limit must be a positive number, or nothing runs. Money is kept as whole
// millionths of a dollar, and a price per million tokens is millionths per token.
function readConfig(env) {
  const n = k => { const v = Number(env[k]); return Number.isInteger(v) && v > 0 ? v : null; };
  const x = k => { const v = Number(env[k]); return Number.isFinite(v) && v > 0 ? v : null; };
  const usd = x("MONTHLY_BUDGET_USD"), perCode = x("PER_CODE_MONTHLY_USD");
  const feedback = /^https:\/\/\S+$/.test(env.FEEDBACK_URL || "") ? env.FEEDBACK_URL : null;
  const c = { model: env.MODEL, roundsPerDay: n("ROUNDS_PER_DAY"), callsPerDay: n("CALLS_PER_DAY"), maxOutput: n("MAX_OUTPUT_TOKENS"), maxBody: n("MAX_BODY_BYTES"),
    priceIn: x("PRICE_INPUT_PER_M"), priceOut: x("PRICE_OUTPUT_PER_M"), budget: usd === null ? null : Math.round(usd * 1e6), perCode: perCode === null ? null : Math.round(perCode * 1e6), feedback };
  const ok = typeof c.model === "string" && c.model && Object.values(c).every(v => v !== null) && env.OPENAI_API_KEY && env.DB;
  return ok ? c : null;
}
const cost = (c, tokensIn, tokensOut) => Math.ceil(tokensIn * c.priceIn + tokensOut * c.priceOut);
const dollars = micro => Math.round(micro) / 1e6;
const alertConfigured = env => Boolean(env.ALERT_EMAIL && env.ALERT_FROM && env.ALERT_TO);

// Best-effort: once a month, retried on a later refusal if sending failed, and never
// able to change a refusal. Nothing here is required for the caps to hold.
async function alertBudget(env, c) {
  if (!alertConfigured(env)) return;
  try {
    const m = month();
    const claimed = await env.DB.prepare("UPDATE budget SET notified_at = ? WHERE month = ? AND notified_at IS NULL").bind(new Date().toISOString(), m).run();
    if (!claimed.meta.changes) return;
    try {
      const raw = [`From: ${env.ALERT_FROM}`, `To: ${env.ALERT_TO}`, `Subject: Project Manager proxy: monthly budget reached (${m})`, `Date: ${new Date().toUTCString()}`,
        `Message-ID: <budget-${m}-${Date.now()}@pm-proxy>`, "MIME-Version: 1.0", 'Content-Type: text/plain; charset="utf-8"', "",
        `The monthly budget of $${dollars(c.budget)} has been reached for ${m}. Every request is now refused until next month or until MONTHLY_BUDGET_USD is raised.`].join("\r\n");
      await env.ALERT_EMAIL.send(new EmailMessage(env.ALERT_FROM, env.ALERT_TO, raw));
    } catch {
      await env.DB.prepare("UPDATE budget SET notified_at = NULL WHERE month = ?").bind(m).run();
    }
  } catch {}
}

// Spend and what remains, for whoever holds STATUS_TOKEN. Nothing per code. With no
// token set, or the wrong one, it looks like any other missing page.
async function statusPage(request, env) {
  const given = request.headers.get("X-Status-Token") || "";
  if (!env.STATUS_TOKEN || !given) return new Response("Not found", { status: 404 });
  const digest = async t => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t)));
  if (!crypto.subtle.timingSafeEqual(await digest(given), await digest(env.STATUS_TOKEN))) return new Response("Not found", { status: 404 });
  const c = readConfig(env);
  if (!c) return refuse(503, "not_configured");
  const m = month();
  const kill = await env.DB.prepare("SELECT value FROM settings WHERE key = 'kill_switch'").first();
  const row = await env.DB.prepare("SELECT tokens_used, spent_microusd, notified_at FROM budget WHERE month = ?").bind(m).first();
  const spent = row?.spent_microusd ?? 0;
  return new Response(JSON.stringify({ month: m, budget_usd: dollars(c.budget), spent_usd: dollars(spent), remaining_usd: dollars(Math.max(0, c.budget - spent)),
    per_code_monthly_usd: dollars(c.perCode), tokens_used: row?.tokens_used ?? 0, model: c.model, price_input_per_m: c.priceIn, price_output_per_m: c.priceOut, paused: kill?.value !== "0",
    alert: { configured: alertConfigured(env), sent_at: row?.notified_at ?? null } }), { headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

async function budgetRefusal(env, c) {
  await alertBudget(env, c);
  return refuse(503, "budget_spent", `${TEXT.budget_spent} ${contact(c)}`);
}
// The tester may be the first to know the money has run out, so they are asked to say.
const contact = c => `Please tell the author through the feedback link: ${c.feedback}`;
const monthText = c => `This access code has used its $${dollars(c.perCode)} for this month. It starts again on the 1st (UTC). Nothing was sent to OpenAI. ${contact(c)}`;
const limitText = c => `This access code has reached today's limit of ${c.roundsPerDay} rounds. It resets at midnight UTC. Nothing was sent to OpenAI.`;

async function handle(request, env) {
  const { pathname } = new URL(request.url);
  if (pathname === "/v1/status" && request.method === "GET") return statusPage(request, env);
  const isCheck = pathname === "/v1/check" && request.method === "GET";
  if (!isCheck && !(pathname === "/v1/chat/completions" && request.method === "POST")) return new Response("Not found", { status: 404 });

  const c = readConfig(env);
  if (!c) return refuse(503, "not_configured");

  // The kill switch comes first, and only an explicit '0' means running.
  const kill = await env.DB.prepare("SELECT value FROM settings WHERE key = 'kill_switch'").first();
  if (kill?.value !== "0") return refuse(503, "paused");

  const code = request.headers.get("X-Access-Code") || "";
  const row = /^[A-Za-z0-9_-]{6,128}$/.test(code) ? await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first() : null;
  if (!row || row.enabled !== 1) return refuse(401, "unknown_code");

  const m = month(), today = day();
  await env.DB.prepare("INSERT OR IGNORE INTO budget (month) VALUES (?)").bind(m).run();
  const spent = await env.DB.prepare("SELECT spent_microusd FROM budget WHERE month = ?").bind(m).first();
  if (spent.spent_microusd >= c.budget) return budgetRefusal(env, c);

  const sameDay = row.last_reset === today;
  const monthSpent = row.month_key === m ? row.month_microusd : 0;
  if (monthSpent >= c.perCode) return refuse(429, "monthly_limit", monthText(c));
  if (isCheck) {
    const used = sameDay ? row.daily_count : 0;
    return new Response(JSON.stringify({ ok: true, rounds_per_day: c.roundsPerDay, rounds_left: Math.max(0, c.roundsPerDay - used) }), { headers: { "Content-Type": "application/json" } });
  }

  // Only what the extension uses goes on. The model is the server's choice, and
  // output is capped, so a code can't be used as a general OpenAI key.
  if (Number(request.headers.get("Content-Length")) > c.maxBody) return refuse(413, "too_large");
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.length > c.maxBody) return refuse(413, "too_large");
  let asked;
  try { asked = JSON.parse(new TextDecoder().decode(bytes)); } catch { return refuse(400, "bad_request"); }
  const msgs = asked?.messages;
  if (!Array.isArray(msgs) || !msgs.length || !msgs.every(x => ROLES.has(x?.role) && typeof x?.content === "string")) return refuse(400, "bad_request");
  const wanted = Number(asked.max_tokens);
  const maxTokens = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, c.maxOutput) : c.maxOutput;
  const outgoing = JSON.stringify({ model: c.model, store: false, max_tokens: maxTokens, messages: msgs.map(x => ({ role: x.role, content: x.content })),
    ...(typeof asked.temperature === "number" ? { temperature: asked.temperature } : {}),
    ...(asked.response_format?.type === "json_object" ? { response_format: { type: "json_object" } } : {}) });

  // The most this request can cost: a token is never fewer than about one byte of
  // input, plus the capped output. Refused here, nothing has been spent.
  const reserve = cost(c, new TextEncoder().encode(outgoing).length, maxTokens);

  // The per-code caps, reserved in one atomic statement. A round is the extension's
  // main call; the hard ceiling counts every call, so a client that lies about rounds
  // still stops. The monthly dollars can't be lied about: they are the server's sums.
  const isRound = request.headers.get("X-PM-Round") === "1" ? 1 : 0;
  const cnt = "CASE WHEN last_reset = ?1 THEN daily_count ELSE 0 END", calls = "CASE WHEN last_reset = ?1 THEN daily_calls ELSE 0 END", mon = "CASE WHEN month_key = ?6 THEN month_microusd ELSE 0 END";
  const claim = await env.DB.prepare(
    `UPDATE codes SET daily_count = ${cnt} + ?2, daily_calls = ${calls} + 1, rounds_used = rounds_used + ?2, last_reset = ?1, month_microusd = ${mon} + ?7, month_key = ?6
     WHERE code = ?3 AND enabled = 1 AND (?2 = 0 OR ${cnt} + 1 <= ?4) AND ${calls} + 1 <= ?5 AND ${mon} + ?7 <= ?8`)
    .bind(today, isRound, code, c.roundsPerDay, c.callsPerDay, m, reserve, c.perCode).run();
  if (!claim.meta.changes) {
    const now = await env.DB.prepare("SELECT * FROM codes WHERE code = ?").bind(code).first();
    const fresh = now.last_reset === today;
    const dailyFull = (isRound && (fresh ? now.daily_count : 0) + 1 > c.roundsPerDay) || (fresh ? now.daily_calls : 0) + 1 > c.callsPerDay;
    return dailyFull ? refuse(429, "daily_limit", limitText(c)) : refuse(429, "monthly_limit", monthText(c));
  }

  // The global budget, reserved the same way.
  const held = await env.DB.prepare("UPDATE budget SET spent_microusd = spent_microusd + ?1 WHERE month = ?2 AND spent_microusd + ?1 <= ?3").bind(reserve, m, c.budget).run();
  if (!held.meta.changes) {
    await env.DB.prepare("UPDATE codes SET daily_count = daily_count - ?1, daily_calls = daily_calls - 1, rounds_used = rounds_used - ?1, month_microusd = month_microusd - ?2 WHERE code = ?3").bind(isRound, reserve, code).run();
    return budgetRefusal(env, c);
  }

  // OpenAI answered with no usable result: give back the reservation and the round.
  // The call still counts towards the ceiling.
  const giveBack = () => env.DB.batch([
    env.DB.prepare("UPDATE budget SET spent_microusd = spent_microusd - ? WHERE month = ?").bind(reserve, m),
    env.DB.prepare("UPDATE codes SET daily_count = daily_count - ?1, rounds_used = rounds_used - ?1, month_microusd = month_microusd - ?2 WHERE code = ?3").bind(isRound, reserve, code)]);
  let up;
  try {
    up = await fetch(OPENAI_URL, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.OPENAI_API_KEY}` }, body: outgoing, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  } catch {
    await giveBack();
    return refuse(502, "upstream_failed");
  }
  // OpenAI's error text isn't passed on: it isn't for the tester, and could name the account.
  if (!up.ok) {
    await giveBack();
    return refuse(up.status === 429 ? 503 : 502, up.status === 429 ? "upstream_busy" : "upstream_failed");
  }
  const text = await up.text();
  let usage = null;
  try { usage = JSON.parse(text)?.usage; } catch {}
  const ok = k => Number.isInteger(usage?.[k]) && usage[k] >= 0;
  const known = ok("prompt_tokens") && ok("completion_tokens");
  // No figure from OpenAI: the whole reservation stays spent, which errs against us.
  const settled = known ? cost(c, usage.prompt_tokens, usage.completion_tokens) : reserve;
  const tokens = known ? usage.prompt_tokens + usage.completion_tokens : 0;
  await env.DB.batch([
    env.DB.prepare("UPDATE budget SET spent_microusd = spent_microusd + ?, tokens_used = tokens_used + ? WHERE month = ?").bind(settled - reserve, tokens, m),
    env.DB.prepare("UPDATE codes SET tokens_used = tokens_used + ?, month_microusd = month_microusd + ? WHERE code = ?").bind(tokens, settled - reserve, code)]);
  const after = await env.DB.prepare("SELECT spent_microusd FROM budget WHERE month = ?").bind(m).first();
  if (after.spent_microusd >= c.budget) await alertBudget(env, c);
  return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
}

export default {
  async fetch(request, env) {
    // Nothing about the failure is logged: an error's text could quote a request.
    try { return await handle(request, env); } catch { return refuse(503, "server_error"); }
  },
};
