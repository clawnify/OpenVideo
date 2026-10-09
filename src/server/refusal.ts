// What a person reads when a managed service says no. The service's own
// `detail` wins; a limit it reports only as numbers (an older service, or a
// proxy in between) is spelled out from them; anything else falls back to
// what the caller knows. Never a bare status code.

export function refusalDetail(body: unknown, fallback: string): string {
  const b = (body && typeof body === "object" ? body : {}) as {
    error?: unknown;
    detail?: unknown;
    used?: unknown;
    limit?: unknown;
    resets_at?: unknown;
  };
  if (typeof b.detail === "string" && b.detail.trim()) return b.detail.trim();
  if (b.error === "quota_exceeded") {
    const count = typeof b.used === "number" && typeof b.limit === "number" ? ` (${b.used} of ${b.limit})` : "";
    const reset = typeof b.resets_at === "string" ? `; it resets on ${b.resets_at.slice(0, 10)}` : "";
    return `This workspace's monthly allowance for this is used up${count}${reset}`;
  }
  if (b.error === "insufficient_credits") return "This workspace is out of credits: top up in Billing to carry on";
  return fallback;
}
