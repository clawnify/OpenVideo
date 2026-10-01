/**
 * Share by link: /s/<token> plays a project's latest finished export to anyone
 * who has the address, without signing in. The page is server-rendered with
 * everything inline, so the only public surface is GET /s/* (declared in
 * clawnify.json `api.public_routes`); the editor and its API stay behind the
 * platform's sign-in.
 */

/** 128 random bits, base64url: the link's token, and the only thing guarding it. */
export function makeShareToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Storage key of an export, from the `output_url` the export route writes. */
export function exportKey(outputUrl: string | null): string | null {
  const m = outputUrl?.match(/^\/api\/uploads\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
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
`;

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

/** The player: the project's name, its latest export, and a download button. */
export function sharePage(name: string, videoUrl: string): string {
  const n = esc(name);
  return page(
    name,
    `<main>
  <video src="${esc(videoUrl)}" controls playsinline preload="metadata"></video>
  <div class="bar">
    <h1>${n}</h1>
    <a class="btn" href="${esc(videoUrl)}&amp;download" download>Download</a>
  </div>
</main>`,
    `<meta property="og:title" content="${n}">\n<meta property="og:type" content="video.other">\n`,
  );
}

/** Shown in place of the player: an unknown or turned-off link, or no export yet. */
export function notePage(title: string, text: string): string {
  return page(title, `<div class="note"><h1>${esc(title)}</h1><p>${esc(text)}</p></div>`);
}
