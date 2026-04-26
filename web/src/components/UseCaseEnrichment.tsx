import { useEffect, useMemo, useState } from "react";

type Iso = "CAISO" | "ERCOT" | "GB" | "AEMO" | "KPX";

type Mix = {
  iso: Iso;
  ts: string;
  ci_g_per_kwh: number;
  generation_mw: Record<string, number>;
  source: "live" | "estimate";
};
type Spot = { price_usd_per_mwh: number; currency?: string };
type HistoryPoint = { ts: string; ci_g_per_kwh: number; generation_mw: Record<string, number> };

const API = "/api";

async function getJson<T>(path: string): Promise<T | null> {
  try { const r = await fetch(`${API}${path}`); return r.ok ? (await r.json() as T) : null; } catch { return null; }
}

function ciColor(g: number) {
  if (g <= 100) return "#7FD9A0";
  if (g <= 200) return "#DFC25E";
  if (g <= 400) return "#C8823C";
  if (g <= 600) return "#945432";
  return "#653823";
}

const CARBON_FREE = ["solar", "wind", "hydro", "nuclear", "geothermal", "biomass"];

export default function UseCaseEnrichment(props: {
  variant: "ci" | "spot-pair" | "ev" | "cfe";
  primaryIso: Iso;
  primaryLabel?: string;
  // for spot-pair variant only:
  zoneA?: { iso: Iso; zone: string; label: string };
  zoneB?: { iso: Iso; zone: string; label: string };
  // for ev variant:
  evSpot?: { iso: Iso; zone: string };
}) {
  const { variant, primaryIso, primaryLabel, zoneA, zoneB, evSpot } = props;
  const [live, setLive] = useState<Mix | null>(null);
  const [history, setHistory] = useState<HistoryPoint[] | null>(null);
  const [spotA, setSpotA] = useState<Spot | null>(null);
  const [spotB, setSpotB] = useState<Spot | null>(null);
  const [evSpotData, setEvSpotData] = useState<Spot | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const tasks: Array<Promise<unknown>> = [];
      tasks.push(getJson<Mix>(`/mix/${primaryIso}/live`).then(d => !cancelled && setLive(d)));
      tasks.push(getJson<{ series: HistoryPoint[] }>(`/mix/${primaryIso}/history?hours=24&step=30`).then(d => !cancelled && setHistory(d?.series ?? null)));
      if (zoneA) tasks.push(getJson<Spot>(`/spot/${zoneA.iso}/${zoneA.zone}/live`).then(d => !cancelled && setSpotA(d)));
      if (zoneB) tasks.push(getJson<Spot>(`/spot/${zoneB.iso}/${zoneB.zone}/live`).then(d => !cancelled && setSpotB(d)));
      if (evSpot) tasks.push(getJson<Spot>(`/spot/${evSpot.iso}/${evSpot.zone}/live`).then(d => !cancelled && setEvSpotData(d)));
      await Promise.allSettled(tasks);
    }
    load();
    const id = setInterval(load, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [primaryIso, zoneA?.zone, zoneB?.zone, evSpot?.zone]);

  // sparkline svg path (or null when loading)
  const sparkline = useMemo(() => {
    if (!history || history.length < 2) return null;
    const W = 320, H = 56, P = { t: 4, b: 14 };
    const innerH = H - P.t - P.b;
    const vals = history.map(s => s.ci_g_per_kwh);
    const vmax = Math.max(50, ...vals) * 1.05;
    const xFor = (i: number) => (i / (history.length - 1)) * W;
    const yFor = (v: number) => P.t + innerH - (v / vmax) * innerH;
    const linePath = history.map((_, i) => `${i === 0 ? "M" : "L"} ${xFor(i).toFixed(1)} ${yFor(vals[i]).toFixed(1)}`).join(" ");
    const areaPath = `${linePath} L ${xFor(history.length - 1).toFixed(1)} ${P.t + innerH} L ${xFor(0).toFixed(1)} ${P.t + innerH} Z`;
    const last = vals[vals.length - 1];
    const color = ciColor(last);
    return {
      W, H, linePath, areaPath, color,
      lastX: xFor(history.length - 1), lastY: yFor(last),
      min: Math.round(Math.min(...vals)),
      max: Math.round(Math.max(...vals)),
      first: Math.round(vals[0]),
      lastVal: Math.round(last),
    };
  }, [history]);

  const carbonFreePct = (() => {
    if (!live) return null;
    const total = Object.values(live.generation_mw).reduce((a, b) => a + Math.max(b, 0), 0) || 1;
    const cf = CARBON_FREE.reduce((a, f) => a + Math.max(live.generation_mw[f] ?? 0, 0), 0);
    return Math.round((cf / total) * 100);
  })();

  // ---- LIVE STRIP ----
  let stripLeft: { label: string; value: string; unit?: string } | null = null;
  let stripRight: { label: string; value: string; unit?: string } | null = null;

  if (variant === "ci") {
    stripLeft = live ? { label: `${primaryLabel ?? primaryIso} · live now`, value: String(Math.round(live.ci_g_per_kwh)), unit: "gCO₂/kWh" } : null;
    if (sparkline) stripRight = { label: "24h range", value: `${sparkline.min} – ${sparkline.max}` };
  } else if (variant === "spot-pair") {
    stripLeft = spotA ? { label: `${zoneA?.label ?? "A"} · live`, value: `$${spotA.price_usd_per_mwh.toFixed(2)}`, unit: "/MWh" } : null;
    stripRight = spotB ? { label: `${zoneB?.label ?? "B"} · live`, value: `$${spotB.price_usd_per_mwh.toFixed(2)}`, unit: "/MWh" } : null;
  } else if (variant === "ev") {
    stripLeft = live ? { label: `${primaryLabel ?? primaryIso} right now`, value: String(Math.round(live.ci_g_per_kwh)), unit: "gCO₂/kWh" } : null;
    stripRight = evSpotData ? { label: `spot · ${evSpot?.zone}`, value: `$${evSpotData.price_usd_per_mwh.toFixed(0)}`, unit: "/MWh" } : null;
  } else if (variant === "cfe") {
    stripLeft = live ? { label: `${primaryLabel ?? primaryIso} right now`, value: String(Math.round(live.ci_g_per_kwh)), unit: "gCO₂/kWh" } : null;
    stripRight = carbonFreePct != null ? { label: "now · carbon-free", value: `${carbonFreePct}%` } : null;
  }

  return (
    <div>
      {/* LIVE DATA STRIP */}
      <div className="flex items-baseline justify-between rounded-lg border border-[var(--color-grid-stroke)] bg-[rgba(11,18,32,0.55)] px-3 py-2.5 mb-3">
        <div>
          <div className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-muted)] font-mono">{stripLeft?.label ?? "loading…"}</div>
          <div className="text-lg font-bold tabular-nums">
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-[var(--color-accent-mint)] mr-1.5 align-middle anim-pulse-dot" />
            {stripLeft?.value ?? "…"}
            {stripLeft?.unit && <span className="text-[10px] text-[var(--color-text-muted)] font-normal ml-1">{stripLeft.unit}</span>}
          </div>
        </div>
        <div className="text-right">
          <div className="text-[9px] uppercase tracking-[0.1em] text-[var(--color-text-muted)] font-mono">{stripRight?.label ?? ""}</div>
          <div className="text-sm font-semibold tabular-nums">
            {stripRight?.value ?? "…"}
            {stripRight?.unit && <span className="text-[9px] text-[var(--color-text-muted)] font-normal ml-1">{stripRight.unit}</span>}
          </div>
        </div>
      </div>

      {/* SPARKLINE */}
      <div className="mb-3">
        <div className="flex justify-between text-[9px] font-mono uppercase tracking-[0.1em] text-[var(--color-text-muted)] mb-1">
          <span>{primaryLabel ?? primaryIso} · last 24h CI</span>
          <span>{sparkline ? `${sparkline.first} → ${sparkline.lastVal} gCO₂` : ""}</span>
        </div>
        <svg viewBox="0 0 320 56" preserveAspectRatio="none" className="w-full h-12 block">
          {sparkline ? (
            <>
              <path d={sparkline.areaPath} fill={sparkline.color} fillOpacity={0.15} />
              <path d={sparkline.linePath} stroke={sparkline.color} strokeWidth={1.5} fill="none" />
              <circle cx={sparkline.lastX} cy={sparkline.lastY} r={3} fill={sparkline.color} stroke="rgba(11,18,32,0.9)" strokeWidth={1.5} />
              <text x="2" y="54" fill="rgba(143,163,190,0.5)" fontSize="8" fontFamily="ui-monospace, monospace">{sparkline.min}</text>
              <text x="318" y="54" fill="rgba(143,163,190,0.5)" fontSize="8" fontFamily="ui-monospace, monospace" textAnchor="end">{sparkline.max} gCO₂</text>
            </>
          ) : (
            <text x="160" y="30" fill="rgba(143,163,190,0.4)" fontSize="9" fontFamily="ui-monospace, monospace" textAnchor="middle">loading 24h history…</text>
          )}
        </svg>
      </div>
    </div>
  );
}
