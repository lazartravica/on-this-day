const STYLE = `
  :root { color-scheme: light dark; --bg:#faf8f4; --fg:#1d1b18; --muted:#6b655c; --accent:#8a4b2a; --card:#fff; --line:#e4ded3; }
  @media (prefers-color-scheme: dark) { :root { --bg:#161412; --fg:#ece7df; --muted:#a39b8f; --accent:#e0a37f; --card:#1f1c19; --line:#34302b; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.55 Georgia, "Iowan Old Style", serif; }
  main { max-width:640px; margin:0 auto; padding:48px 16px; }
  h1 { font-size:2rem; margin:0 0 4px; } p.lede { color:var(--muted); margin:0 0 32px; }
  form { display:flex; gap:8px; flex-wrap:wrap; }
  select, button { font:inherit; padding:10px 14px; border-radius:8px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  button { background:var(--accent); color:var(--bg); border-color:var(--accent); cursor:pointer; }
  ol { list-style:none; padding:0; } li { padding:12px 0; border-bottom:1px solid var(--line); }
  li b { color:var(--accent); margin-right:8px; font-variant-numeric:tabular-nums; }
  .status { color:var(--muted); } code { font-size:.85em; }
`;

const layout = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;

export function indexPage(dates: string[], pricing: { perLookup: string; lookupsPerPurchase: number; purchase: string }): string {
  const options = dates.map((d) => `<option value="${d}">${d}</option>`).join("");
  return layout(
    "On This Day",
    `<h1>On This Day</h1>
<p class="lede">What happened on a given date. ${pricing.perLookup} per lookup, prepaid privately with Curvy
in bundles of ${pricing.lookupsPerPurchase} (${pricing.purchase}).</p>
<form id="f"><select name="date">${options}</select><button>Reveal</button></form>
<p class="status" id="s"></p>
<ol id="events"></ol>
<script>
document.getElementById("f").addEventListener("submit", async (e) => {
  e.preventDefault();
  const date = new FormData(e.target).get("date");
  const s = document.getElementById("s");
  s.textContent = "Creating checkout…";
  const res = await fetch("/api/on-this-day?date=" + date);
  const body = await res.json();
  if (res.status === 402) { s.textContent = "Redirecting to Curvy checkout…"; location.href = body.payment.checkoutUrl; return; }
  if (!res.ok) { s.textContent = body.error ?? "Unexpected response"; return; }
  s.textContent = body.lookupsRemaining + " prepaid lookups left.";
  document.getElementById("events").innerHTML = body.events
    .map((e) => "<li><b>" + e.year + "</b>" + e.text.replace(/</g, "&lt;") + "</li>").join("");
});
</script>`,
  );
}

export function checkoutCompletePage(): string {
  return layout(
    "Payment received",
    `<h1>Confirming your payment</h1>
<p class="status" id="s">Checking the chain…</p>
<ol id="events"></ol>
<p><a href="/">Look up another date</a></p>
<script>
const txHash = new URLSearchParams(location.hash.slice(1)).get("txHash") ?? undefined;
const s = document.getElementById("s");
async function poll(attempt) {
  const res = await fetch("/api/checkout/complete", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ txHash }),
  });
  const body = await res.json();
  if (body.events) {
    document.querySelector("h1").textContent = "On " + body.date;
    s.textContent = body.lookupsRemaining + " prepaid lookups left in this browser session.";
    document.getElementById("events").innerHTML = body.events
      .map((e) => "<li><b>" + e.year + "</b>" + e.text.replace(/</g, "&lt;") + "</li>").join("");
    return;
  }
  if (body.status === "paid") { s.textContent = "Payment confirmed. " + body.lookupsRemaining + " lookups left."; return; }
  if (!res.ok && res.status !== 503) { s.textContent = "Could not confirm payment: " + body.error; return; }
  if (attempt >= 60) { s.textContent = "Still waiting for confirmation. Refresh this page to keep checking."; return; }
  s.textContent = "Waiting for block confirmations… (" + (attempt + 1) + ")";
  setTimeout(() => poll(attempt + 1), 2000);
}
poll(0);
</script>`,
  );
}
