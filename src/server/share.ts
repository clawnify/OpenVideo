/**
 * Share by link: /s/<token> plays a project's latest finished export to anyone
 * who has the address, without signing in. The page is server-rendered with
 * everything inline, so the only public surface is GET /s/* (declared in
 * clawnify.json `api.public_routes`); the editor and its API stay behind the
 * platform's sign-in. With comments turned on for the link, the page also
 * lists them and takes new ones (see comments.ts).
 */

import type { PublicComment } from "./comments";

/** 128 random bits, base64url: the link's token, and the only thing guarding it. */
export function makeShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The app's own tokens (styles.css), trimmed to what this page uses. */
const CSS = `
  :root {
    --background: #f7f7f5; --surface: #ffffff; --foreground: #1b1a19; --muted: #646360;
    --border: #e5e3de; --ring: #df3656; --primary: #1b1a19; --primary-hover: #333130; --on-primary: #ffffff;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --background: #100f0e; --surface: #161615; --foreground: #efeeed; --muted: #c0bdb9;
      --border: #2e2e2c; --ring: #e4415d; --primary: #efeeed; --primary-hover: #d6d4d1; --on-primary: #100f0e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100dvh; display: flex; flex-direction: column; align-items: center;
    justify-content: center; gap: 1rem; padding: 1rem;
    background: var(--background); color: var(--foreground);
    font: 400 0.875rem/1.5 Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  main { width: 100%; max-width: 64rem; display: flex; flex-direction: column; gap: 0.75rem; }
  video { display: block; width: 100%; max-height: 78dvh; background: #000; border-radius: 0.5rem; }
  .bar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; }
  h1 { margin: 0; font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
  p { margin: 0; color: var(--muted); }
  a.btn {
    flex-shrink: 0; display: inline-flex; align-items: center; height: 2.25rem; padding: 0 0.75rem;
    border-radius: 0.375rem; background: var(--primary); color: var(--on-primary);
    font-weight: 500; text-decoration: none;
  }
  a.btn:hover { background: var(--primary-hover); }
  :focus-visible { outline: 2px solid var(--ring); outline-offset: 2px; }
  .note { max-width: 28rem; text-align: center; display: flex; flex-direction: column; gap: 0.25rem; }
  section { display: flex; flex-direction: column; gap: 0.75rem; padding-top: 0.5rem; }
  h2 { margin: 0; font-size: 0.875rem; font-weight: 600; }
  form { display: flex; flex-direction: column; gap: 0.5rem; }
  textarea, input[type=text] {
    width: 100%; padding: 0.5rem 0.625rem; border: 1px solid var(--border); border-radius: 0.375rem;
    background: var(--surface); color: var(--foreground); font: inherit;
  }
  textarea { min-height: 4.5rem; resize: vertical; }
  .row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; }
  .row input[type=text] { flex: 1 1 12rem; width: auto; }
  label.at { display: inline-flex; align-items: center; gap: 0.375rem; color: var(--muted); font-variant-numeric: tabular-nums; }
  button.send {
    height: 2.25rem; padding: 0 0.75rem; border: 0; border-radius: 0.375rem; cursor: pointer;
    background: var(--primary); color: var(--on-primary); font: inherit; font-weight: 500;
  }
  button.send:hover { background: var(--primary-hover); }
  button.send:disabled { opacity: 0.6; cursor: default; }
  .status { min-height: 1.25rem; }
  ol { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; }
  li { display: flex; gap: 0.75rem; padding: 0.625rem 0; border-top: 1px solid var(--border); }
  li .who { font-weight: 600; }
  li .text { margin: 0.125rem 0 0; color: var(--foreground); white-space: pre-wrap; overflow-wrap: anywhere; }
  li.resolved .text { color: var(--muted); }
  li .tag { color: var(--muted); font-weight: 400; }
  button.time {
    flex-shrink: 0; align-self: flex-start; min-width: 3.25rem; height: 1.5rem; padding: 0 0.375rem;
    border: 1px solid var(--border); border-radius: 0.25rem; background: var(--surface); color: var(--foreground);
    font: inherit; font-size: 0.75rem; font-variant-numeric: tabular-nums; cursor: pointer;
  }
  span.time { flex-shrink: 0; min-width: 3.25rem; font-size: 0.75rem; color: var(--muted); }
`;

/**
 * The comments' behaviour. The time a comment is about is the video's own
 * position when it is sent, shown live by the checkbox; writing pauses the
 * video so it stays put. Rendered with textContent only: comment text never
 * becomes markup.
 */
const SCRIPT = `(() => {
  const data = JSON.parse(document.getElementById("review").textContent);
  const video = document.querySelector("video");
  const form = document.getElementById("comment-form");
  const list = document.getElementById("comments");
  const count = document.getElementById("comment-count");
  const status = document.getElementById("comment-status");
  const atText = document.getElementById("at-text");
  const { body, author, timed, send } = form.elements;
  const clock = (t) => {
    const s = Math.floor(t), h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = String(s % 60).padStart(2, "0");
    return h ? h + ":" + String(m).padStart(2, "0") + ":" + r : m + ":" + r;
  };
  const showAt = () => (atText.textContent = "At " + clock(video.currentTime || 0));
  video.addEventListener("timeupdate", showAt);
  video.addEventListener("seeked", showAt);
  showAt();
  body.addEventListener("focus", () => video.pause());
  try { author.value = localStorage.getItem("openvideo-name") || ""; } catch (e) {}
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text) n.textContent = text; return n; };
  const render = () => {
    const sorted = data.comments.slice().sort((a, b) => (a.at ?? Infinity) - (b.at ?? Infinity) || a.created_at.localeCompare(b.created_at));
    list.replaceChildren(...sorted.map((c) => {
      const li = el("li", c.resolved ? "resolved" : "");
      if (c.at === null) li.append(el("span", "time", "General"));
      else {
        const b = el("button", "time", clock(c.at));
        b.type = "button";
        b.setAttribute("aria-label", "Play from " + clock(c.at));
        b.onclick = () => { video.currentTime = c.at; video.pause(); };
        li.append(b);
      }
      const main = el("div");
      const who = el("div", "who", c.author);
      if (c.resolved) who.append(el("span", "tag", " · Resolved"));
      main.append(who, el("p", "text", c.body));
      li.append(main);
      return li;
    }));
    count.textContent = data.comments.length ? "Comments (" + data.comments.length + ")" : "Comments";
  };
  render();
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    send.disabled = true;
    status.textContent = "";
    try {
      const res = await fetch(data.post, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ v: data.v, at: timed.checked ? video.currentTime : null, body: body.value, author: author.value }),
      });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(out.detail || "Couldn't send the comment. Try again.");
      data.comments = out.comments;
      render();
      body.value = "";
      status.textContent = "Comment sent.";
      try { localStorage.setItem("openvideo-name", author.value.trim()); } catch (e) {}
    } catch (err) {
      status.textContent = err.message;
    } finally {
      send.disabled = false;
    }
  });
})();`;

function page(title: string, body: string, head = ""): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="referrer" content="no-referrer">
<title>${esc(title)}</title>
${head}<style>${CSS}</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** A link's comments, when they are turned on: what is there, and where new ones go. */
export interface ShareReview {
  comments: PublicComment[];
  /** The address comments are posted to. */
  post: string;
  /** The export the page plays, sent back with each comment. */
  v: number;
}

/** JSON inside a <script> element: `<` escaped so no string can close it. */
const scriptJson = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");

function reviewSection(review: ShareReview): string {
  return `
  <section aria-labelledby="comment-count">
    <h2 id="comment-count">Comments</h2>
    <form id="comment-form">
      <textarea name="body" required maxlength="2000" aria-label="Comment" placeholder="Add a comment"></textarea>
      <div class="row">
        <input type="text" name="author" required maxlength="80" autocomplete="name" aria-label="Your name" placeholder="Your name">
        <label class="at"><input type="checkbox" name="timed" checked> <span id="at-text">At 0:00</span></label>
        <button class="send" name="send" type="submit">Comment</button>
      </div>
      <p class="status" id="comment-status" role="status" aria-live="polite"></p>
    </form>
    <ol id="comments"></ol>
  </section>
  <script type="application/json" id="review">${scriptJson(review)}</script>
  <script>${SCRIPT}</script>`;
}

/** The player: the project's name, its latest export, a download button, and comments if they are on. */
export function sharePage(name: string, videoUrl: string, review?: ShareReview): string {
  const n = esc(name);
  return page(
    name,
    `<main>
  <video src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>
  <div class="bar">
    <h1>${n}</h1>
    <a class="btn" href="${esc(videoUrl)}&amp;download" download>Download</a>
  </div>${review ? reviewSection(review) : ""}
</main>`,
    `<meta property="og:title" content="${n}">\n<meta property="og:type" content="video.other">\n`,
  );
}

/** Shown in place of the player: an unknown or turned-off link, or no export yet. */
export function notePage(title: string, text: string): string {
  return page(title, `<div class="note"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`);
}
