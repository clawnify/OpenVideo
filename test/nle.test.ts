import { describe, expect, it } from "vitest";
import { clock, highlightsCsv, type NleHighlight } from "../src/server/nle";

const row = (over: Partial<NleHighlight> = {}): NleHighlight => ({
  kind: "soundbite",
  src_in: 313.3,
  src_out: 317.9,
  text: "Shipping fast is the whole point.",
  speaker: "woman in a green blazer",
  score: 5,
  reason: "the thesis, in one line",
  pick: "keep",
  name: "20240512_Cam_A_0012.MP4",
  folder: "Day 1/Interview",
  drive_file_id: "1AbCdEfGhIjKlMnOpQrStUvWxYz01234",
  ...over,
});

describe("clock", () => {
  it("writes a position in a clip", () => {
    expect(clock(313.3)).toBe("5:13.3");
    expect(clock(3723.44)).toBe("1:02:03.4");
  });
});

describe("highlightsCsv", () => {
  it("writes one row per pick, with the Drive link to its file", () => {
    const csv = highlightsCsv([row(), row({ kind: "broll", pick: null, text: "Crowd at the booth, wide", speaker: "", reason: "energy" })]);
    const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
    expect(lines[0]).toBe("Type,Score,Status,File,Folder,In,Out,Seconds,Words or shot,Speaker,Why,Drive link");
    expect(lines[1]).toBe(
      "Soundbite,5,Kept,20240512_Cam_A_0012.MP4,Day 1/Interview,5:13.3,5:17.9,4.6,Shipping fast is the whole point.,woman in a green blazer,\"the thesis, in one line\",https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01234/view",
    );
    expect(lines[2]).toContain('B-roll,5,To review,');
    expect(lines[2]).toContain('"Crowd at the booth, wide"');
  });

  it("quotes what needs quoting and never lets a cell run as a formula", () => {
    const csv = highlightsCsv([row({ text: '=HYPERLINK("x")', reason: 'He said "privacy"\nthen left' })]);
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
    expect(csv).toContain(`"He said ""privacy""\nthen left"`);
  });
});

import { highlightsXml, pathUrl, sequenceRate, type XmlPick } from "../src/server/nle";

const camC = { id: "a0012", name: "20240512_Cam_A_0012.MP4", folder: "Day 1/Interview", duration: 2695.2, fps: 25, width: 3840, height: 2160 };
const camB = { id: "b0006", name: "20261006_Cam_B_0006.MP4", folder: "Day 1/Cam B", duration: 6.24, fps: 50, width: 3840, height: 2160 };
const pick = (over: Partial<XmlPick>): XmlPick => ({
  kind: "soundbite",
  src_in: 313.3,
  src_out: 317.9,
  text: "Shipping fast is the whole point.",
  speaker: "woman in a green blazer",
  score: 5,
  reason: "the thesis, in one line",
  file: camC,
  ...over,
});

describe("sequenceRate", () => {
  it("cuts 50p on a 25 fps timeline, follows most picks, and falls back to 25", () => {
    expect(sequenceRate([pick({ file: camB }), pick({ file: camB }), pick({})])).toEqual({ timebase: 25, ntsc: false });
    expect(sequenceRate([pick({ file: { ...camC, fps: 29.97 } }), pick({ file: { ...camB, fps: 59.94 } })])).toEqual({ timebase: 30, ntsc: true });
    expect(sequenceRate([pick({ file: { ...camC, fps: null } })])).toEqual({ timebase: 25, ntsc: false });
  });
});

describe("pathUrl", () => {
  it("escapes every part, and writes a drive letter the way Premiere does", () => {
    expect(pathUrl("/Users/ed/Downloads", "Day 1/Cam B", "B 0006.MP4")).toBe("file://localhost/Users/ed/Downloads/Day%201/Cam%20B/B%200006.MP4");
    expect(pathUrl("C:\\Footage", "Day 1", "x.mp4")).toBe("file://localhost/C%3a/Footage/Day%201/x.mp4");
    expect(pathUrl("", "Day 1/Interview", "A&B.mp4")).toBe("file://localhost/Day%201/Interview/A%26B.mp4");
  });
});

describe("highlightsXml", () => {
  const xml = highlightsXml("Day 1 highlights", [
    pick({}),
    pick({ src_in: 515.0, src_out: 531.1, text: 'It\'s "fast" with checks <really>', score: 4 }),
    pick({ kind: "broll", src_in: 0, src_out: 5.5, text: "Two men chatting", speaker: "", score: 3, reason: "warm", file: camB }),
  ]);

  it("lays each kind out as its own sequence at the timeline rate", () => {
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE xmeml>\n<xmeml version="4">')).toBe(true);
    expect(xml.match(/<sequence id=/g)).toHaveLength(2);
    expect(xml).toContain("<name>Day 1 highlights - Soundbites</name>");
    expect(xml).toContain("<name>Day 1 highlights - B-roll</name>");
  });

  it("counts in and out from the file's first frame at the timeline's rate, the picks a second apart", () => {
    // 313.3 s × 25 = 7833 (rounded); 4.6 s = 115 frames.
    expect(xml).toContain("<start>0</start><end>115</end><in>7833</in><out>7948</out>");
    // Next pick after a 25-frame gap: 515.0 × 25 = 12875, 16.1 s = 403 frames.
    expect(xml).toContain("<start>140</start><end>543</end><in>12875</in><out>13278</out>");
    // A 50p file on the 25 fps timeline still counts at 25: 5.5 s = 138 frames.
    expect(xml).toMatch(/<rate><timebase>25<\/timebase><ntsc>FALSE<\/ntsc><\/rate><start>0<\/start><end>138<\/end><in>0<\/in><out>138<\/out>/);
  });

  it("describes each file once, at its own rate, with no timecode it can't vouch for", () => {
    expect(xml.match(/<file id="file-a0012">/g)).toHaveLength(1);
    expect(xml.match(/<file id="file-a0012"\/>/g)!.length).toBeGreaterThan(1);
    expect(xml).toContain("<pathurl>file://localhost/Day%201/Interview/20240512_Cam_A_0012.MP4</pathurl>");
    expect(xml).toMatch(/<file id="file-b0006"><name>20261006_Cam_B_0006.MP4<\/name><pathurl>[^<]+<\/pathurl><rate><timebase>50<\/timebase>/);
    expect(xml).not.toMatch(/<file id="[^"]+">(?:(?!<\/file>).)*<timecode>/s);
  });

  it("links each picture to its stereo pair, and carries the words, score and reason on markers", () => {
    expect(xml.match(/premiereChannelType="stereo"/g)).toHaveLength(6);
    expect(xml).toContain('<track currentExplodedTrackIndex="1" totalExplodedTrackCount="2" premiereTrackType="Stereo">');
    expect(xml).toContain("<name>★★★★★ “Shipping fast is the whole point.”</name>");
    expect(xml).toContain("<comment>Soundbite · woman in a green blazer · the thesis, in one line · Shipping fast is the whole point.</comment>");
    // Escaped, not broken.
    expect(xml).toContain("It's &quot;fast&quot; with checks &lt;really&gt;");
  });
});
