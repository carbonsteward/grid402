import { useEffect, useState } from "react";
import { getMix, ciClass, type ISO, type MixSnapshot } from "../lib/api";

const ISOS: { iso: ISO; label: string; cx: number; cy: number; sub: string }[] = [
  { iso: "CAISO", label: "CAISO",   cx: 215, cy: 360, sub: "California, USA" },
  { iso: "ERCOT", label: "ERCOT",   cx: 380, cy: 415, sub: "Texas, USA" },
  { iso: "KPX",   label: "KPX",     cx: 1240, cy: 350, sub: "Korea" },
  { iso: "AEMO",  label: "AEMO",    cx: 1310, cy: 660, sub: "Australia (NEM)" },
];

type State = {
  loading: boolean;
  data: Partial<Record<ISO, MixSnapshot>>;
  errors: Partial<Record<ISO, string>>;
  lastUpdate?: number;
};

export default function LiveMap() {
  const [state, setState] = useState<State>({ loading: true, data: {}, errors: {} });

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const results = await Promise.allSettled(ISOS.map(({ iso }) => getMix(iso)));
      if (cancelled) return;
      const data: State["data"] = {};
      const errors: State["errors"] = {};
      results.forEach((r, i) => {
        const iso = ISOS[i].iso;
        if (r.status === "fulfilled") data[iso] = r.value;
        else errors[iso] = (r.reason as Error).message;
      });
      setState({ loading: false, data, errors, lastUpdate: Date.now() });
    }
    refresh();
    const id = setInterval(refresh, 60_000); // 1-min poll
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  return (
    <div className="relative w-full">
      <svg viewBox="0 0 1500 800" className="w-full h-auto" role="img" aria-label="Global grid carbon-intensity map">
        {/* Equirectangular world hint (rough continent blocks; the deck SVG can replace this) */}
        <rect x="0" y="0" width="1500" height="800" fill="#0B1220" />
        {/* North America */}
        <rect x="120" y="220" width="380" height="320" rx="8" className="ci-unknown" />
        {/* South America */}
        <rect x="380" y="540" width="180" height="220" rx="8" className="ci-unknown" />
        {/* Europe */}
        <rect x="700" y="220" width="220" height="180" rx="8" className="ci-unknown" />
        {/* Africa */}
        <rect x="720" y="420" width="220" height="280" rx="8" className="ci-unknown" />
        {/* Asia */}
        <rect x="940" y="220" width="380" height="280" rx="8" className="ci-unknown" />
        {/* Australia */}
        <rect x="1240" y="600" width="180" height="120" rx="8" className="ci-unknown" />

        {/* ISO pins */}
        {ISOS.map(({ iso, label, cx, cy, sub }) => {
          const snap = state.data[iso];
          const err = state.errors[iso];
          const ci = snap?.ci_g_per_kwh;
          const pinClass = err ? "ci-unknown" : ciClass(ci);
          return (
            <g key={iso}>
              <circle cx={cx} cy={cy} r="34" className={`${pinClass} pin-live`} stroke="#0B1220" strokeWidth="3" />
              <text x={cx} y={cy + 4} textAnchor="middle" className="fill-[var(--color-slide-bg)] font-bold" fontSize="14">{label}</text>
              <text x={cx} y={cy + 60} textAnchor="middle" className="fill-[var(--color-text-muted)]" fontSize="11" letterSpacing="0.05em">{sub.toUpperCase()}</text>
              {ci != null && (
                <text x={cx} y={cy + 78} textAnchor="middle" className="fill-[var(--color-text-light)] font-semibold" fontSize="13">
                  {Math.round(ci)} gCO₂/kWh
                </text>
              )}
              {err && (
                <text x={cx} y={cy + 78} textAnchor="middle" className="fill-[var(--color-accent-red)]" fontSize="11">offline</text>
              )}
            </g>
          );
        })}
      </svg>

      <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        {ISOS.map(({ iso, label, sub }) => {
          const snap = state.data[iso];
          const err = state.errors[iso];
          return (
            <div key={iso} className="rounded-lg border border-[var(--color-grid-stroke)] p-4 bg-[rgba(255,255,255,0.02)]">
              <div className="flex items-baseline justify-between">
                <span className="font-semibold tracking-wide">{label}</span>
                <span className="text-[var(--color-text-muted)] text-xs">{sub}</span>
              </div>
              {snap ? (
                <>
                  <div className="mt-2 text-2xl font-bold">{Math.round(snap.ci_g_per_kwh)}</div>
                  <div className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider">gCO₂eq / kWh</div>
                  <MiniMix pct={snap.pct} />
                </>
              ) : err ? (
                <div className="mt-3 text-[var(--color-accent-red)] text-xs">{err}</div>
              ) : (
                <div className="mt-3 text-[var(--color-text-muted)] text-xs">loading…</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="mt-4 text-xs text-[var(--color-text-muted)]">
        {state.lastUpdate ? `Last updated ${Math.round((Date.now() - state.lastUpdate) / 1000)}s ago` : "Waiting for first poll…"}
        {" · "}Polling every 60s · API: <code className="font-mono">{import.meta.env?.PUBLIC_GRID402_API ?? "localhost:3402"}</code>
      </div>
    </div>
  );
}

function MiniMix({ pct }: { pct: Record<string, number> }) {
  const entries = Object.entries(pct).sort((a, b) => b[1] - a[1]).slice(0, 4);
  return (
    <div className="mt-3 space-y-1.5">
      {entries.map(([fuel, p]) => (
        <div key={fuel} className="flex items-center gap-2">
          <span className="w-16 text-xs text-[var(--color-text-muted)] capitalize">{fuel}</span>
          <div className="flex-1 h-1.5 bg-[rgba(255,255,255,0.05)] rounded-full overflow-hidden">
            <div className="h-full bg-[var(--color-accent-mint)]" style={{ width: `${Math.min(p, 100)}%` }} />
          </div>
          <span className="w-10 text-right text-xs font-mono">{p.toFixed(1)}%</span>
        </div>
      ))}
    </div>
  );
}
