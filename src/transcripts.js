function esc(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/** Readable UTC fallback when JS is disabled. (Node disallows timeZoneName + dateStyle together.) */
function transcriptUtcFallbackLabel(unixSec) {
  const d = new Date(Number(unixSec) * 1000);
  if (Number.isNaN(d.getTime())) return "—";
  const text = d.toLocaleString("en-US", {
    timeZone: "UTC",
    dateStyle: "medium",
    timeStyle: "short"
  });
  return `${text} UTC`;
}

function transcriptTimeHtml(unixSec) {
  const ms = Number(unixSec) * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) {
    return `<time class="transcript-when">—</time>`;
  }
  const iso = d.toISOString();
  const fallback = transcriptUtcFallbackLabel(unixSec);
  return `<time class="transcript-when" datetime="${esc(iso)}" data-ts="${ms}" title="${esc(iso)}">${esc(fallback)}</time>`;
}

export function renderTranscriptHtml(ticket, messages) {
  const rows = messages
    .map((m) => {
      const atts = JSON.parse(m.attachments_json || "[]");
      const attachmentHtml = atts.length
        ? `<ul>${atts.map((u) => `<li><a href="${esc(u)}" target="_blank" rel="noreferrer">${esc(u)}</a></li>`).join("")}</ul>`
        : "";
      return `
      <div class="msg ${esc(m.direction)}">
        <div class="meta">
          <strong>${esc(m.author_tag)}</strong>
          <span>${
            m.direction === "staff_internal" ? "Staff only · " : ""
          }${transcriptTimeHtml(m.created_at)}</span>
        </div>
        <div class="content">${esc(m.content || "")}</div>
        ${attachmentHtml}
      </div>`;
    })
    .join("\n");

  const createdHtml = transcriptTimeHtml(ticket.created_at);
  const closedHtml = ticket.closed_at ? transcriptTimeHtml(ticket.closed_at) : "Open";

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>Ticket #${ticket.id} Transcript</title>
    <style>
      body { background:#0f1115; color:#e7e7e7; margin:0; font-family:system-ui,sans-serif; }
      .wrap { max-width:980px; margin:0 auto; padding:24px; }
      .head { padding:16px; background:#1a1f29; border-radius:12px; margin-bottom:16px; }
      .head .hint { margin:12px 0 0; font-size:.85rem; opacity:.75; }
      .msg { margin:10px 0; padding:12px; border-radius:10px; background:#151922; border:1px solid #283042; }
      .msg.dm_to_staff { border-left:4px solid #5bc0eb; }
      .msg.staff_to_dm { border-left:4px solid #9bc53d; }
      .msg.staff_internal { border-left:4px solid #f0b232; opacity:.95; }
      .meta { display:flex; justify-content:space-between; gap:12px; opacity:.9; font-size:.9rem; margin-bottom:8px; }
      .meta time { white-space:nowrap; }
      .content { white-space:pre-wrap; word-break:break-word; }
      a { color:#8ab4f8; }
      code { background:#0006; padding:2px 4px; border-radius:4px; }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="head">
        <h2>Ticket #${ticket.id}</h2>
        <p>Created: ${createdHtml}</p>
        <p>Closed: ${closedHtml}</p>
        <p>Claimed by: ${ticket.claimed_by ? esc(`User ID ${ticket.claimed_by}`) : "—"}</p>
        <p>Reason: ${esc(ticket.close_reason || "No reason provided")}</p>
        <p class="hint">Timestamps use your browser locale and <strong>local timezone</strong>. Hover a time for the exact instant (UTC).</p>
      </div>
      ${rows}
    </div>
    <script>
(function () {
  var opts = { dateStyle: "medium", timeStyle: "short" };
  document.querySelectorAll("time.transcript-when[data-ts]").forEach(function (el) {
    var ms = Number(el.getAttribute("data-ts"));
    if (!Number.isFinite(ms)) return;
    try {
      el.textContent = new Date(ms).toLocaleString(undefined, opts);
    } catch (e) {
      el.textContent = el.getAttribute("datetime") || el.textContent;
    }
  });
})();
    </script>
  </body>
</html>`;
}
