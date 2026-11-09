import { describe, expect, it } from "vitest";
import { addFormat, formatSize, formatView, liftView, removeFormat, renderDoc, wholeShotClips } from "../src/shared/formats";
import { splitClip } from "../src/shared/split";
import { validateEdl, type Edl } from "../src/server/edl";

const top = { x: 0.05, y: 0.1, width: 0.4, height: 0.71 };
const bottom = { x: 0.55, y: 0.1, width: 0.4, height: 0.71 };

/** A 16:9 interview cut with one 9:16 format, a cropped clip and a title. */
function talk(): Edl {
  return addFormat(
    {
      version: 1,
      output: { width: 1920, height: 1080, fps: 30 },
      main: {
        elements: [
          { id: "a", type: "video", src: "asset:talk", trimStart: 510, duration: 14, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 0.9 } },
          { id: "b", type: "video", src: "asset:talk", trimStart: 600, duration: 6 },
        ],
      },
      overlays: [{ id: "t", elements: [{ id: "title", type: "text", text: "Hook", startTime: 0, duration: 3, x: 0.9, y: 0.8, fontSize: 64, align: "right" }] }],
      audio: [],
    },
    "9:16",
  );
}

/** Edit the document through one format's view, as the editor does. */
function edit(doc: Edl, id: string | null, fn: (view: Edl) => void): Edl {
  const view = formatView(doc, id);
  fn(view);
  return liftView(doc, view, id);
}

describe("formats", () => {
  it("adds a format at the main format's short side", () => {
    expect(talk().formats).toEqual([{ id: "9:16", width: 1080, height: 1920 }]);
    expect(formatSize("1:1", { width: 1920, height: 1080 })).toEqual({ width: 1080, height: 1080 });
    expect(formatSize("4:5", { width: 1280, height: 720 })).toEqual({ width: 720, height: 900 });
    // The main shape, or one already there, is not added again.
    expect(addFormat(talk(), "16:9").formats).toHaveLength(1);
    expect(addFormat(talk(), "9:16").formats).toHaveLength(1);
  });

  it("starts a new format on each clip's whole shot, whatever the main format does", () => {
    const view = formatView(talk(), "9:16");
    expect(view.output).toMatchObject({ width: 1080, height: 1920 });
    const a = view.main.elements[0];
    expect(a.fit).toBe("contain");
    expect(a.crop).toBeUndefined();
    expect(wholeShotClips(talk(), "9:16")).toBe(2);
  });

  it("shares a trim made in 9:16 with 16:9", () => {
    const doc = edit(talk(), "9:16", (v) => {
      v.main.elements[0].duration = 9;
    });
    expect(doc.main.elements[0].duration).toBe(9);
    expect(doc.main.elements[0]).toMatchObject({ fit: "cover", crop: { x: 0, y: 0, width: 1, height: 0.9 } });
    expect(doc.main.elements[0].framing).toBeUndefined();
  });

  it("keeps stacked views to 9:16, leaving the 16:9 shot as it was", () => {
    const doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
    });
    const a = doc.main.elements[0];
    expect(a.type === "video" && a.split).toBeFalsy();
    expect(a).toMatchObject({ fit: "cover", crop: { height: 0.9 } });
    expect(a.framing?.["9:16"]).toEqual({ fit: "contain", split: { top, bottom } });
    const tall = formatView(doc, "9:16").main.elements[0];
    expect(tall.type === "video" && tall.split).toEqual({ top, bottom });
    expect(wholeShotClips(doc, "9:16")).toBe(1);
  });

  it("forgets a format's framing once it is the whole shot again", () => {
    let doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
    });
    doc = edit(doc, "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") delete a.split;
    });
    expect(doc.main.elements[0].framing).toBeUndefined();
  });

  it("keeps each format's framing on both halves of a split clip", () => {
    let doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
    });
    doc = edit(doc, "9:16", (v) => {
      const halves = splitClip(v.main.elements[0], 4, 14, "a2")!;
      v.main.elements.splice(0, 1, ...halves);
    });
    expect(doc.main.elements.map((e) => e.id)).toEqual(["a", "a2", "b"]);
    for (const half of doc.main.elements.slice(0, 2)) {
      expect(half).toMatchObject({ fit: "cover", crop: { height: 0.9 }, framing: { "9:16": { split: { top, bottom } } } });
    }
    expect(doc.main.elements[1]).toMatchObject({ trimStart: 514, duration: 10 });
  });

  it("gives a clip added in 9:16 the same framing in 16:9", () => {
    const doc = edit(talk(), "9:16", (v) => {
      v.main.elements.push({ id: "c", type: "video", src: "asset:talk", trimStart: 700, duration: 3, fit: "cover", anchor: { x: 0.3, y: 0.5 } });
    });
    expect(doc.main.elements[2]).toMatchObject({ fit: "cover", anchor: { x: 0.3, y: 0.5 } });
    expect(doc.main.elements[2].framing?.["9:16"]).toEqual({ fit: "cover", anchor: { x: 0.3, y: 0.5 } });
  });

  it("moves a title in one format only, and lets it follow the main one until then", () => {
    const moved = (doc: Edl, id: string | null) => formatView(doc, id).overlays![0].elements[0];
    // Unplaced, the title follows the main format's position.
    let doc = edit(talk(), null, (v) => {
      v.overlays![0].elements[0].y = 0.7;
    });
    expect(moved(doc, "9:16").y).toBe(0.7);
    // Placed in 9:16, it stays there when the main one moves.
    doc = edit(doc, "9:16", (v) => {
      v.overlays![0].elements[0].y = 0.45;
    });
    expect(doc.overlays![0].elements[0].y).toBe(0.7);
    doc = edit(doc, null, (v) => {
      v.overlays![0].elements[0].y = 0.2;
    });
    expect(moved(doc, "9:16").y).toBe(0.45);
    expect(moved(doc, null).y).toBe(0.2);
    // Its words are the same in every format.
    doc = edit(doc, "9:16", (v) => {
      const t = v.overlays![0].elements[0];
      if (t.type === "text") t.text = "Better hook";
    });
    expect(moved(doc, null)).toMatchObject({ text: "Better hook", y: 0.2 });
  });

  it("renders a format as a plain document the render service accepts", () => {
    const doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
      v.overlays![0].elements[0].y = 0.45;
    });
    const tall = renderDoc(doc, "9:16");
    expect(tall.output).toMatchObject({ width: 1080, height: 1920 });
    expect(tall.formats).toBeUndefined();
    expect(JSON.stringify(tall)).not.toMatch(/framing|placement|"main":\{"fit"/);
    expect(tall.main.elements[0]).toMatchObject({ split: { top, bottom } });
    const wide = renderDoc(doc, null);
    expect(wide.output).toMatchObject({ width: 1920, height: 1080 });
    expect(wide.main.elements[0]).toMatchObject({ fit: "cover" });
    expect(JSON.stringify(wide)).not.toMatch(/framing|placement|split/);
  });

  it("removes a format with everything framed for it", () => {
    const doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
      v.overlays![0].elements[0].y = 0.45;
    });
    const gone = removeFormat(doc, "9:16");
    expect(gone.formats).toBeUndefined();
    expect(JSON.stringify(gone)).not.toMatch(/framing|placement/);
    expect("invalid" in validateEdl(gone)).toBe(false);
  });

  it("validates formats and what is framed for them", () => {
    const doc = edit(talk(), "9:16", (v) => {
      const a = v.main.elements[0];
      if (a.type === "video") a.split = { top, bottom };
    });
    expect("invalid" in validateEdl(doc)).toBe(false);

    const stray = structuredClone(doc);
    stray.main.elements[1].framing = { "1:1": { fit: "cover" } };
    expect(validateEdl(stray)).toMatchObject({ invalid: { path: "/main/elements/1/framing/1:1" } });

    const twice = structuredClone(doc);
    twice.formats!.push({ id: "16:9", width: 1920, height: 1080 });
    expect(validateEdl(twice)).toMatchObject({ invalid: { path: "/formats/1" } });

    const misnamed = structuredClone(doc);
    misnamed.formats![0].id = "1:1";
    expect(validateEdl(misnamed)).toMatchObject({ invalid: { path: "/formats/0/id" } });

    const zero = structuredClone(doc);
    zero.formats![0].id = "0:16";
    expect(validateEdl(zero)).toMatchObject({ invalid: { path: "/formats/0/id" } });

    // A view's own bookkeeping must never be saved.
    expect("invalid" in validateEdl(formatView(doc, "9:16"))).toBe(true);
  });
});
