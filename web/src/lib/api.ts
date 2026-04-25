// Grid402 API client — paywalled endpoints surface 402 challenges; the live
// landing-page map only hits demo/sample fallbacks (no real x402 payment in v1).
//
// In production, swap API_BASE for the deployed Worker / Railway URL.

export const API_BASE =
  (typeof import.meta !== "undefined" && import.meta.env?.PUBLIC_GRID402_API) ||
  (typeof window !== "undefined" && window.location.origin.includes("localhost")
    ? "http://localhost:3402"
    : "/api");

export type ISO = "CAISO" | "ERCOT" | "AEMO" | "KPX" | "GB";

export type MixSnapshot = {
  iso: ISO;
  ts: string;
  zone?: string;
  generation_mw: Record<string, number>;
  pct: Record<string, number>;
  ci_g_per_kwh: number; // carbon intensity, gCO2eq/kWh
  source_url?: string;
  source: "live" | "estimate";
};

export type SpotSnapshot = {
  iso: ISO;
  ts: string;
  zone: string;
  price_usd_per_mwh: number;
  currency: "USD" | "AUD" | "KRW";
  source_url?: string;
};

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchJSON<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, { signal });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} (${path})`);
  return (await res.json()) as T;
}

export type HistoricalSeries = {
  iso: ISO;
  zone?: string;
  source: "live" | "estimate";
  step_minutes: number;
  source_url?: string;
  series: Array<{
    ts: string;
    ci_g_per_kwh: number;
    generation_mw: Record<string, number>;
    pct: Record<string, number>;
  }>;
};

export async function getHistory(iso: ISO, opts?: { hours?: number; step?: number; signal?: AbortSignal; timeoutMs?: number }): Promise<HistoricalSeries> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? 12000);
  const params = new URLSearchParams();
  if (opts?.hours) params.set("hours", String(opts.hours));
  if (opts?.step) params.set("step", String(opts.step));
  try {
    return await fetchJSON<HistoricalSeries>(`/mix/${iso}/history${params.toString() ? `?${params}` : ""}`, opts?.signal ?? ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function getMixRegion(iso: ISO, region: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<MixSnapshot> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchJSON<MixSnapshot>(`/mix/${iso}/live?region=${encodeURIComponent(region)}`, opts?.signal ?? ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export async function getMix(iso: ISO, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<MixSnapshot> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchJSON<MixSnapshot>(`/mix/${iso}/live`, opts?.signal ?? ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

export type SpotPrice = SpotSnapshot & {
  price_native?: number;
  fx_rate?: number;
  source: "live" | "estimate";
};

export async function getSpot(iso: ISO, zone: string, opts?: { timeoutMs?: number; signal?: AbortSignal }): Promise<SpotSnapshot> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    return await fetchJSON<SpotSnapshot>(`/spot/${iso}/${zone}/live`, opts?.signal ?? ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

// CI bucket → CSS class (matches global.css)
export function ciClass(g: number | null | undefined): string {
  if (g == null || Number.isNaN(g)) return "ci-unknown";
  if (g < 100) return "ci-clean";
  if (g < 200) return "ci-low";
  if (g < 400) return "ci-mid";
  if (g < 600) return "ci-high";
  return "ci-dirty";
}
