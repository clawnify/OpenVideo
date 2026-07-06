<img src="readme-banner.png" alt="Open Video preview" width="100%" />

# Open Video

Programmatic video creation powered by **Remotion**. Full Studio editor for humans, API for agents. Compositions are React code — agents write them, the Studio previews them, and `npx remotion render` produces pixel-perfect videos. Built with **React + Hono + D1 + R2**. Deploys to Cloudflare Workers via [Clawnify](https://clawnify.com).

## Features

- **Remotion Studio** — full editor with timeline, frame scrubbing, and visual props editing
- **Compositions as code** — each video is a React component using Remotion's animation APIs
- **Zod schemas** — all props are editable in the Studio with type-safe controls and color pickers
- **Sequence tracks** — timeline shows animation phases for each composition
- **Multiple aspect ratios** — 1920×1080 (landscape), 1080×1080 (square), 1080×1920 (vertical/reel)
- **7 built-in compositions** — Title Card, Kinetic Typography, Social Post, Countdown, Logo Reveal, Gradient Wave, and Babette Welcome
- **API for agents** — discover compositions, manage render jobs, upload videos to R2
- **Render from URL** — deployed app serves as a `serveUrl` for `npx remotion render`
- **R2 storage** — rendered videos stored and served from Cloudflare R2
- **Browser Rendering + Dynamic Workers** — bindings ready for future server-side rendering on Workers

## Quickstart

```bash
git clone https://github.com/clawnify/open-video.git
cd open-video
pnpm install
```

Start the dev server:

```bash
pnpm dev
```

This starts the Remotion Studio on `http://localhost:5173` and the API on `http://localhost:8787`.

### Render a video

```bash
# From local source
npx remotion render src/index.ts TitleCard --props '{"title":"Hello","subtitle":"World","backgroundColor":"#1e1b4b","textColor":"#ffffff","accentColor":"#818cf8"}' --output video.mp4

# From deployed URL
npx remotion render https://your-app.workers.dev TitleCard --props '{"title":"Hello","subtitle":"World","backgroundColor":"#1e1b4b","textColor":"#ffffff","accentColor":"#818cf8"}' --output video.mp4
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| **Editor** | Remotion Studio (timeline, preview, visual props editing) |
| **Compositions** | React, TypeScript, Remotion (spring, interpolate, Sequence) |
| **Backend** | Hono (Cloudflare Worker) |
| **Database** | D1 (SQLite at the edge) |
| **Storage** | R2 (rendered videos) |
| **Rendering** | Remotion CLI (`npx remotion render`) via Chrome + ffmpeg |
| **Schemas** | Zod v4 + @remotion/zod-types (color pickers, textareas) |

### Prerequisites

- Node.js 20+
- pnpm
- Chrome + ffmpeg (for rendering videos)

## Architecture

```
src/
  index.ts              — Remotion entry point (registerRoot)
  Root.tsx              — Composition registry with Zod schemas
  compositions/
    title-card.tsx      — Animated title + subtitle + accent line
    kinetic-text.tsx    — Sequential word animations with spring physics
    social-post.tsx     — Headline + body + CTA for social media (1080×1080)
    countdown.tsx       — Ring progress countdown with end text
    logo-reveal.tsx     — Dramatic text reveal with glow effect
    gradient-wave.tsx   — Animated gradient with floating circles
    babette-welcome.tsx — AI-generated luxury salon welcome video
  server/
    index.ts            — Hono API with D1/R2 middleware
    db.ts               — D1-native database adapter
    uploads.ts          — R2 file storage adapter
    compositions.ts     — Composition metadata registry for API
    renderer.ts         — Browser Rendering video renderer
    schema.sql          — Database schema (render_jobs, custom_compositions)
```

### API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/compositions` | List all compositions with input schemas |
| GET | `/api/compositions/:id` | Get a single composition with its schema |
| POST | `/api/renders` | Create a render job for a composition |
| GET | `/api/renders` | List all render jobs |
| GET | `/api/renders/:id` | Get render job status |
| PATCH | `/api/renders/:id` | Update render job status |
| POST | `/api/renders/:id/upload` | Upload a rendered video to R2 |
| GET | `/api/uploads/:filename` | Serve a video from R2 |
| GET | `/api/custom-compositions` | List saved custom compositions |
| POST | `/api/custom-compositions` | Save a custom composition (code in D1) |
| PUT | `/api/custom-compositions/:id` | Update a custom composition |
| DELETE | `/api/custom-compositions/:id` | Delete a custom composition |
| GET | `/api/serve-url` | Get the deployed URL for remote rendering |

### Agent Workflow

```bash
# 1. Discover compositions
curl https://your-app.workers.dev/api/compositions

# 2. Render a video (on any machine with Chrome + ffmpeg)
npx remotion render https://your-app.workers.dev TitleCard \
  --props '{"title":"Hello","subtitle":"World","backgroundColor":"#1e1b4b","textColor":"#fff","accentColor":"#818cf8"}' \
  --output video.mp4

# 3. Upload to R2
curl -X POST https://your-app.workers.dev/api/renders/1/upload -F file=@video.mp4

# 4. Video served from R2
curl https://your-app.workers.dev/api/uploads/render_1_1234.mp4
```

### Creating New Compositions

Agents create compositions by writing React code:

```tsx
import { AbsoluteFill, Sequence, interpolate, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { z } from "zod";
import { zColor } from "@remotion/zod-types";

export const myVideoSchema = z.object({
  title: z.string(),
  backgroundColor: zColor(),
  textColor: zColor(),
  accentColor: zColor(),
});

export const MyVideo: React.FC<z.infer<typeof myVideoSchema>> = ({ title, backgroundColor, textColor, accentColor }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = interpolate(frame, [0, 30], [0, 1], { extrapolateRight: "clamp" });
  const y = spring({ frame, fps, from: 40, to: 0, durationInFrames: 30 });

  return (
    <AbsoluteFill style={{ backgroundColor, display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ color: textColor, fontSize: 72, fontWeight: 800, opacity, transform: `translateY(${y}px)` }}>
        {title}
      </div>
    </AbsoluteFill>
  );
};
```

Register in `Root.tsx`, rebuild, and it's available in the Studio and via the API.

## Deploy

```bash
npx clawnify deploy
```

Or directly with Wrangler:

```bash
npx remotion bundle --out-dir dist
npx wrangler deploy
```

## License

MIT
