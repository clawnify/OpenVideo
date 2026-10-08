// Highlights for an editor's own software. Two files, from the same rows:
//   - a sheet (CSV), for whoever reviews in a spreadsheet;
//   - a timeline Premiere Pro and DaVinci Resolve import (FCP7 XML), laid on
//     the camera originals the editor downloads, so nothing is re-encoded and
//     any pick can be opened out into its whole clip.
// Pure; unit-tested.

export interface NleHighlight {
  kind: "soundbite" | "broll";
  /** Seconds into the clip. */
  src_in: number;
  src_out: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  pick: "keep" | "drop" | null;
  name: string;
  folder: string;
  drive_file_id: string;
}

const KIND = { soundbite: "Soundbite", broll: "B-roll" } as const;
const STATUS = { keep: "Kept", drop: "Dropped" } as const;

/** Seconds → "M:SS.s" (or "H:MM:SS.s"): a position in a clip. */
export function clock(seconds: number): string {
  const t = Math.max(0, Math.round(seconds * 10) / 10);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(1).padStart(4, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/**
 * One CSV field. Quoted when it holds a comma, a quote or a line break; and a
 * value a spreadsheet would run as a formula (=, +, -, @) is led by an
 * apostrophe, since the words come from a transcript.
 */
function field(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function highlightsCsv(rows: NleHighlight[]): string {
  const head = ["Type", "Score", "Status", "File", "Folder", "In", "Out", "Seconds", "Words or shot", "Speaker", "Why", "Drive link"];
  const lines = rows.map((r) =>
    [
      KIND[r.kind],
      r.score,
      r.pick ? STATUS[r.pick] : "To review",
      r.name,
      r.folder,
      clock(r.src_in),
      clock(r.src_out),
      (Math.round((r.src_out - r.src_in) * 10) / 10).toFixed(1),
      r.text,
      r.speaker,
      r.reason,
      `https://drive.google.com/file/d/${r.drive_file_id}/view`,
    ]
      .map(field)
      .join(","),
  );
  // The byte order mark makes Excel read the file as UTF-8.
  return `﻿${[head.join(","), ...lines].join("\r\n")}\r\n`;
}

// ── the timeline (FCP7 XML) ─────────────────────────────────────────────────
// The interchange Premiere Pro and DaVinci Resolve both import (File > Import;
// in Resolve, File > Import > Timeline), written the way Premiere itself
// writes it, since that is what both read best:
//   - one sequence per kind (Soundbites, B-roll), the picks end to end with a
//     second of gap, each a video clip and its sound as a linked stereo pair;
//   - a clip's <in>/<out> count frames from the file's first frame, at the
//     clip's <rate>, which is the sequence's rate (Premiere's convention, and
//     what Resolve expects from Premiere), so a 50p file on a 25 fps timeline
//     takes seconds × 25; <start>/<end> are frames on the timeline;
//   - the words or what is shown, the score and the reason ride on a marker on
//     each clip, so they stay with it when the editor copies it into a cut,
//     and on a sequence marker, so they read along the timeline.
// Sources: Apple's "Final Cut Pro XML Interchange Format" (timing values),
// Premiere exports, OpenTimelineIO's FCP 7 adapter, the Resolve manual.
//
// shortcut: no source timecode yet. The media service's copy keeps none and
// the camera originals sit behind Drive's per-file download quota, so <file>
// carries no <timecode> rather than a wrong one. Premiere places picks right
// without it (in/out count from the first frame); Resolve conforms by
// timecode unless Conform Options > Use Timecode is "From the source clip
// frame count". Upgrade: read each original's start timecode at import.

export interface XmlFile {
  /** The footage row id: one <file> per clip, shared by all its picks. */
  id: string;
  name: string;
  /** Where it sits below the shared folder, its own name first: "Day 1/Cam B". */
  folder: string;
  /** Seconds. */
  duration: number;
  fps: number | null;
  width: number | null;
  height: number | null;
}

export interface XmlPick {
  kind: "soundbite" | "broll";
  src_in: number;
  src_out: number;
  text: string;
  speaker: string;
  score: number;
  reason: string;
  file: XmlFile;
}

interface Rate {
  timebase: number;
  ntsc: boolean;
}

/** 29.97 → 30 NTSC; 25 → 25. */
export function rateOf(fps: number): Rate {
  const timebase = Math.round(fps);
  return { timebase, ntsc: Math.abs(fps - timebase) > 0.01 };
}

const realFps = (r: Rate) => (r.ntsc ? (r.timebase * 1000) / 1001 : r.timebase);

/**
 * The timeline's rate: the rate the picks' cameras share, halved when they
 * shoot at double speed (50p cuts on a 25 fps timeline). The rate most picks
 * come from wins; 25 when none is known.
 */
export function sequenceRate(picks: XmlPick[]): Rate {
  const votes = new Map<string, { rate: Rate; n: number }>();
  for (const p of picks) {
    if (!p.file.fps) continue;
    const base = p.file.fps >= 47 ? p.file.fps / 2 : p.file.fps;
    const rate = rateOf(base);
    const k = `${rate.timebase}${rate.ntsc ? "n" : ""}`;
    votes.set(k, { rate, n: (votes.get(k)?.n ?? 0) + 1 });
  }
  return [...votes.values()].sort((a, b) => b.n - a.n)[0]?.rate ?? { timebase: 25, ntsc: false };
}

const esc = (s: string) =>
  s
    // XML 1.0 has no place for most control characters.
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const rateXml = (r: Rate) => `<rate><timebase>${r.timebase}</timebase><ntsc>${r.ntsc ? "TRUE" : "FALSE"}</ntsc></rate>`;

/**
 * Where the file would be on the editor's machine: `root` (the folder the
 * footage was downloaded into) plus its Drive folders. A file URL with every
 * part percent-escaped, the way Premiere writes one (a drive letter's colon
 * as %3a). Without a root, or once moved, the editor relinks by file name.
 */
export function pathUrl(root: string, folder: string, name: string): string {
  const parts = [...root.replace(/\\/g, "/").split("/"), ...folder.split("/"), name].filter(Boolean);
  const encoded = parts.map((p, i) => (i === 0 && /^[A-Za-z]:$/.test(p) ? `${p[0]}%3a` : encodeURIComponent(p)));
  return `file://localhost/${encoded.join("/")}`;
}

const stars = (n: number) => "★".repeat(Math.max(1, Math.min(5, n)));

/** A marker's name: the words or the shot, short enough to read on a clip. */
function markerName(p: XmlPick): string {
  const text = p.kind === "soundbite" ? `“${p.text}”` : p.text;
  return `${stars(p.score)} ${text.length > 90 ? `${text.slice(0, 89)}…` : text}`;
}

function markerComment(p: XmlPick): string {
  return [p.kind === "soundbite" ? "Soundbite" : "B-roll", p.speaker, p.reason, p.kind === "soundbite" ? p.text : ""]
    .filter(Boolean)
    .join(" · ");
}

const GAP_SECONDS = 1;

/**
 * The picks as a bin of sequences: Soundbites and B-roll, each only if it has
 * any. `root`: where the footage folder was downloaded (optional).
 */
export function highlightsXml(title: string, picks: XmlPick[], opts: { root?: string; rate?: Rate } = {}): string {
  const seqRate = opts.rate ?? sequenceRate(picks);
  const fps = realFps(seqRate);
  // The nudge keeps a half frame that float arithmetic lands just under
  // (317.9 × 25 = 7947.4999…) rounding up like the others.
  const frames = (seconds: number) => Math.round(seconds * fps + 1e-6);
  // The frame size most picks share; 1080p when none is known.
  const sizes = new Map<string, number>();
  for (const p of picks) if (p.file.width && p.file.height) sizes.set(`${p.file.width}x${p.file.height}`, (sizes.get(`${p.file.width}x${p.file.height}`) ?? 0) + 1);
  const [width, height] = ([...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "1920x1080").split("x").map(Number);

  let ids = 0;
  const written = new Set<string>();
  const fileXml = (f: XmlFile) => {
    const ref = `file-${f.id}`;
    if (written.has(ref)) return `<file id="${ref}"/>`;
    written.add(ref);
    const own = f.fps ? rateOf(f.fps) : seqRate;
    return [
      `<file id="${ref}">`,
      `<name>${esc(f.name)}</name>`,
      `<pathurl>${esc(pathUrl(opts.root ?? "", f.folder, f.name))}</pathurl>`,
      rateXml(own),
      `<duration>${Math.round(f.duration * realFps(own))}</duration>`,
      `<media>`,
      `<video><samplecharacteristics>${rateXml(own)}<width>${f.width ?? width}</width><height>${f.height ?? height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></video>`,
      `<audio><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics><channelcount>2</channelcount></audio>`,
      `</media>`,
      `</file>`,
    ].join("");
  };

  const sequence = (name: string, list: XmlPick[]) => {
    let at = 0;
    const placed = list.map((p, i) => {
      const len = Math.max(1, frames(p.src_out) - frames(p.src_in));
      const start = at;
      at += len + (i < list.length - 1 ? frames(GAP_SECONDS) : 0);
      const n = ++ids;
      return { p, start, end: start + len, in: frames(p.src_in), out: frames(p.src_in) + len, ids: { v: `clipitem-${n}-v`, a1: `clipitem-${n}-a1`, a2: `clipitem-${n}-a2` }, index: i + 1 };
    });
    const links = (x: (typeof placed)[number]) =>
      [
        `<link><linkclipref>${x.ids.v}</linkclipref><mediatype>video</mediatype><trackindex>1</trackindex><clipindex>${x.index}</clipindex></link>`,
        `<link><linkclipref>${x.ids.a1}</linkclipref><mediatype>audio</mediatype><trackindex>1</trackindex><clipindex>${x.index}</clipindex><groupindex>1</groupindex></link>`,
        `<link><linkclipref>${x.ids.a2}</linkclipref><mediatype>audio</mediatype><trackindex>2</trackindex><clipindex>${x.index}</clipindex><groupindex>1</groupindex></link>`,
      ].join("");
    const timing = (x: (typeof placed)[number]) =>
      `<name>${esc(x.p.file.name)}</name><enabled>TRUE</enabled><duration>${Math.round(x.p.file.duration * fps)}</duration>${rateXml(seqRate)}<start>${x.start}</start><end>${x.end}</end><in>${x.in}</in><out>${x.out}</out>`;
    const video = placed.map(
      (x) =>
        `<clipitem id="${x.ids.v}">${timing(x)}${fileXml(x.p.file)}${links(x)}<marker><comment>${esc(markerComment(x.p))}</comment><name>${esc(markerName(x.p))}</name><in>${x.in}</in><out>-1</out></marker></clipitem>`,
    );
    const audio = (track: 1 | 2) =>
      placed.map(
        (x) =>
          `<clipitem id="${track === 1 ? x.ids.a1 : x.ids.a2}" premiereChannelType="stereo">${timing(x)}<file id="file-${x.p.file.id}"/><sourcetrack><mediatype>audio</mediatype><trackindex>${track}</trackindex></sourcetrack>${links(x)}</clipitem>`,
      );
    const audioTrack = (track: 1 | 2) =>
      `<track currentExplodedTrackIndex="${track - 1}" totalExplodedTrackCount="2" premiereTrackType="Stereo">${audio(track).join("")}<enabled>TRUE</enabled><locked>FALSE</locked><outputchannelindex>${track}</outputchannelindex></track>`;
    const seqMarkers = placed
      .map((x) => `<marker><comment>${esc(markerComment(x.p))}</comment><name>${esc(markerName(x.p))}</name><in>${x.start}</in><out>-1</out></marker>`)
      .join("");
    return [
      `<sequence id="sequence-${esc(name.toLowerCase().replace(/[^a-z]+/g, "-"))}">`,
      `<name>${esc(name)}</name>`,
      `<duration>${at}</duration>`,
      rateXml(seqRate),
      `<media>`,
      `<video><format><samplecharacteristics>${rateXml(seqRate)}<width>${width}</width><height>${height}</height><anamorphic>FALSE</anamorphic><pixelaspectratio>square</pixelaspectratio><fielddominance>none</fielddominance></samplecharacteristics></format>`,
      `<track>${video.join("")}<enabled>TRUE</enabled><locked>FALSE</locked></track>`,
      `</video>`,
      `<audio><numOutputChannels>2</numOutputChannels><format><samplecharacteristics><depth>16</depth><samplerate>48000</samplerate></samplecharacteristics></format>`,
      audioTrack(1),
      audioTrack(2),
      `</audio>`,
      `</media>`,
      `<timecode>${rateXml(seqRate)}<string>00:00:00:00</string><frame>0</frame><displayformat>NDF</displayformat></timecode>`,
      seqMarkers,
      `</sequence>`,
    ].join("");
  };

  const groups: [string, XmlPick[]][] = [
    ["Soundbites", picks.filter((p) => p.kind === "soundbite")],
    ["B-roll", picks.filter((p) => p.kind === "broll")],
  ];
  const sequences = groups.filter(([, list]) => list.length > 0).map(([name, list]) => sequence(`${title} - ${name}`, list));
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4"><bin><name>${esc(title)}</name><children>${sequences.join("")}</children></bin></xmeml>\n`;
}
