<img src="readme-banner.png" alt="OpenVideo preview" width="100%" />

# OpenVideo

[![Deploy with Clawnify](https://app.clawnify.com/deploy-button.svg)](https://app.clawnify.com/deploy?repo=clawnify/OpenVideo)

An open-source, **agent-friendly video editor**. Compose videos as plain **HTML on a timeline**, drop in your own media (logos, product demos), preview with a scrubbable playhead, and render to **MP4**.

Built on **[HyperFrames](https://github.com/heygen-com/hyperframes)** (HTML → MP4, Apache-2.0) — so there's no proprietary timeline format and no per-seat license. A composition is just HTML: humans can tweak it, and AI agents can author it end to end.

## Why

Most programmatic video tools lock you into a component framework or a paid license. Here a video is **HTML you already know** — elements positioned on tracks with simple `data-*` timing attributes, animated with GSAP/CSS/Lottie/Three.js. That makes it trivial for an agent to generate, and trivial for a person to read and adjust.

## Features

- **Timeline editor** — tracks, clips, a time ruler, and a draggable playhead that scrubs the preview. Clips are parsed straight from your composition's timing attributes.
- **Live preview** — see the composition animate as you edit; one master clock keeps the preview and the timeline in sync.
- **Bring your own media** — upload logos and product-demo clips and reference them by path (`assets/your-logo.png`) right in the HTML.
- **One-click render** — produces a real MP4, stored and played back in the gallery.
- **Footage editing (EDL)** — cut, trim and sequence real uploaded clips, overlay images and text, and mix music under the cut. The edit is a plain-JSON **edit decision list**: the main track is an ordered array of clips (splicing is an array insert), times are seconds, positions are canvas fractions. Exports run on Clawnify's managed edit service and come back as MP4s.
- **Agent-ready** — a clean REST API (`/api/compositions`, `/api/assets`, `/api/renders`, `/api/projects`, `/api/exports`) and an `agent.md` so an AI agent can author, edit and render videos without a human in the loop. Validation errors carry a JSON pointer to the offending node, so an agent's edit loop self-corrects.

## How a composition works

A composition is one HTML fragment. The root carries the canvas size; timed elements get `class="clip"` plus `data-start` / `data-duration` (seconds) / `data-track-index`, and animations are registered on a paused GSAP timeline:

```html
<div id="root" data-composition-id="promo" data-width="1920" data-height="1080">
  <img src="assets/logo.png" class="clip" data-start="0" data-duration="6" data-track-index="0" />
  <h1 id="title" class="clip" data-start="0.5" data-duration="6" data-track-index="0"
      style="position:absolute;top:48%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:90px">
    Introducing Northwind
  </h1>
  <script src="https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js"></script>
  <script>
    const tl = gsap.timeline({ paused: true });
    tl.from("#title", { opacity: 0, y: 40, duration: 1 }, 0.5);
    window.__timelines = { promo: tl };
  </script>
</div>
```

The editor reads those clips into the timeline automatically.

## Quickstart

```bash
pnpm install
pnpm dev        # editor UI + API, with a local database & storage
```

Open the editor, hit **New composition** for a starter, edit the HTML in the **Compose** tab, drop media in **Media**, scrub the timeline, and render from **Renders**.

## Deploy

This is a [Clawnify](https://clawnify.com) app — deploy it to your org with the CLI:

```bash
npx clawnify deploy
```

Rendering runs on Clawnify's managed render service, so deployed instances need no local video toolchain.

## Project layout

```
src/
  client/app.tsx     # editor UI: compositions, timeline, media, renders
  client/edit.tsx    # footage editor: media rail, player, inspector, timeline
  client/ui.tsx      # shared control recipes (buttons, dialog, empty state)
  client/starter.ts  # the starter composition — video content, not app chrome
  client/styles.css  # design tokens: palette, type scale, elevation
  server/            # REST API (compositions, assets, renders, edit projects, exports)
agent.md             # how an AI agent authors, edits and renders videos
```

## License

MIT for this app. HyperFrames is Apache-2.0.
