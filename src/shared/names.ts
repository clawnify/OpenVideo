// File names as the editor shows them in a narrow list.

/**
 * What the names in one folder share at the start, cut back to a separator:
 * "20261006_Cam_B_" for 20261006_Cam_B_0001.MP4 and 20261006_Cam_B_0002.MP4.
 * The rail shows the rest, which is what tells the clips apart.
 */
export function sharedPrefix(names: string[]): string {
  if (names.length < 2) return "";
  let n = 0;
  const first = names[0];
  while (n < first.length && names.every((x) => x[n] === first[n])) n++;
  // Only at "_", "-" or a space: a cut at a "." could leave just an extension.
  const cut = first.slice(0, n).search(/[_\- ][^_\- ]*$/);
  const prefix = cut < 0 ? "" : first.slice(0, cut + 1);
  return prefix.length >= 4 && names.every((x) => x.length > prefix.length) ? prefix : "";
}
