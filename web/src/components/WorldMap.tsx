import { useEffect, useMemo, useState } from "react";
import { geoNaturalEarth1, geoPath } from "d3-geo";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry } from "geojson";
import { getMix, type ISO, type MixSnapshot } from "../lib/api";

// Country numeric ISO 3166-1 IDs → ISO operator(s) covering them.
// Multiple ISOs in one country = blended weighted by `weight`.
const COUNTRY_TO_ISO: Record<string, Array<{ iso: ISO; weight: number; label?: string }>> = {
  "840": [{ iso: "CAISO", weight: 0.4, label: "California (CAISO)" }, { iso: "ERCOT", weight: 0.6, label: "Texas (ERCOT)" }],
  "410": [{ iso: "KPX", weight: 1, label: "South Korea (KPX)" }],
  "036": [{ iso: "AEMO", weight: 1, label: "Australia NEM (AEMO)" }],
  "826": [{ iso: "GB" as ISO, weight: 1, label: "Great Britain (NESO)" }],
};

// Carbon-intensity color scale (matches Electricity Maps warm-earth gradient,
// adapted for dark background). Lower = clean (green), higher = dirty (brown).
function ciColor(g: number | undefined | null): string {
  if (g == null || Number.isNaN(g)) return "rgba(143, 163, 190, 0.18)";
  // Stops: 0 / 100 / 200 / 400 / 600 / 900 / 1500
  const stops: Array<[number, [number, number, number]]> = [
    [0,    [78, 205, 196]],   // mint
    [100,  [127, 217, 160]],  // light green
    [200,  [223, 194, 94]],   // yellow
    [400,  [200, 130, 60]],   // amber-brown
    [600,  [148, 84, 50]],    // brown
    [900,  [101, 56, 35]],    // dark brown
    [1500, [60, 35, 25]],     // very dark
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (g >= stops[i][0] && g <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  if (g <= stops[0][0]) return `rgb(${stops[0][1].join(",")})`;
  if (g >= stops[stops.length - 1][0]) return `rgb(${stops[stops.length - 1][1].join(",")})`;
  const t = (g - lo[0]) / (hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const gg = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  return `rgb(${r},${gg},${b})`;
}

const ISOS_TO_FETCH: ISO[] = ["CAISO", "ERCOT", "AEMO", "KPX", "GB" as ISO];

type FC = FeatureCollection<Geometry, { name?: string }>;

export default function WorldMap() {
  const [topo, setTopo] = useState<FC | null>(null);
  const [data, setData] = useState<Partial<Record<ISO, MixSnapshot>>>({});
  const [errs, setErrs] = useState<Partial<Record<ISO, string>>>({});
  const [selected, setSelected] = useState<string | null>("840"); // default: USA
  const [lastUpdate, setLastUpdate] = useState<number | null>(null);

  // Load TopoJSON once
  useEffect(() => {
    let cancelled = false;
    fetch("/data/countries-110m.json")
      .then(r => r.json())
      .then((t: any) => {
        if (cancelled) return;
        const fc = feature(t, t.objects.countries) as unknown as FC;
        setTopo(fc);
      });
    return () => { cancelled = true; };
  }, []);

  // Poll all ISOs every 60s
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const r = await Promise.allSettled(ISOS_TO_FETCH.map(iso => getMix(iso)));
      if (cancelled) return;
      const d: typeof data = {};
      const e: typeof errs = {};
      r.forEach((res, i) => {
        const iso = ISOS_TO_FETCH[i];
        if (res.status === "fulfilled") d[iso] = res.value;
        else e[iso] = (res.reason as Error).message;
      });
      setData(d);
      setErrs(e);
      setLastUpdate(Date.now());
    }
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Country ID → blended CI
  function ciFor(countryId: string): number | undefined {
    const mapping = COUNTRY_TO_ISO[countryId];
    if (!mapping) return undefined;
    let sum = 0, w = 0;
    for (const { iso, weight } of mapping) {
      const snap = data[iso];
      if (snap) { sum += snap.ci_g_per_kwh * weight; w += weight; }
    }
    return w > 0 ? sum / w : undefined;
  }

  // Default selection: USA. If user picks another, show that.
  const selectedMapping = selected ? COUNTRY_TO_ISO[selected] : undefined;
  const selectedCountryName = selected && topo
    ? (topo.features.find(f => String(f.id) === selected)?.properties?.name)
    : undefined;

  const path = useMemo(() => {
    const proj = geoNaturalEarth1().scale(195).translate([500, 320]);
    return geoPath(proj);
  }, []);

  return (
    <div className="grid lg:grid-cols-[1fr_360px] gap-6 items-start">
      {/* Map */}
      <div className="relative rounded-xl overflow-hidden bg-[rgba(11,18,32,0.7)] border border-[var(--color-grid-stroke)]">
        <svg viewBox="0 0 1000 560" className="w-full h-auto block" role="img" aria-label="Global grid carbon intensity">
          <defs>
            <radialGradient id="ocean" cx="50%" cy="50%" r="80%">
              <stop offset="0%" stopColor="#0F1A2E" />
              <stop offset="100%" stopColor="#070C18" />
            </radialGradient>
          </defs>
          <rect x="0" y="0" width="1000" height="560" fill="url(#ocean)" />
          {topo?.features.map(f => {
            const id = String(f.id);
            const ci = ciFor(id);
            const isCovered = id in COUNTRY_TO_ISO;
            const isSelected = id === selected;
            const d = path(f as any);
            if (!d) return null;
            return (
              <path
                key={id}
                d={d}
                fill={isCovered ? ciColor(ci) : "rgba(143, 163, 190, 0.08)"}
                stroke={isSelected ? "#F5F5F7" : isCovered ? "rgba(245,245,247,0.4)" : "rgba(143,163,190,0.2)"}
                strokeWidth={isSelected ? 1.5 : 0.5}
                style={{ cursor: isCovered ? "pointer" : "default", transition: "fill 240ms" }}
                onClick={() => isCovered && setSelected(id)}
              >
                <title>
                  {f.properties?.name}{isCovered ? ` — ${Math.round(ci ?? 0)} gCO₂/kWh` : ""}
                </title>
              </path>
            );
          })}
        </svg>

        {/* Live indicator */}
        <div className="absolute top-4 right-4 flex items-center gap-2 rounded-full bg-[rgba(11,18,32,0.85)] backdrop-blur px-3 py-1.5 border border-[var(--color-grid-stroke)]">
          <span className="relative inline-flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent-hot)] opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent-hot)]"></span>
          </span>
          <span className="text-xs font-mono">{lastUpdate ? new Date(lastUpdate).toUTCString().slice(17, 22) : "--:--"} UTC</span>
        </div>

        {/* CI legend */}
        <div className="absolute bottom-4 left-4 right-4 flex items-center gap-3 rounded-lg bg-[rgba(11,18,32,0.85)] backdrop-blur px-4 py-2 border border-[var(--color-grid-stroke)]">
          <span className="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold">Carbon intensity</span>
          <div
            className="flex-1 h-2 rounded"
            style={{
              background: `linear-gradient(to right, ${[0, 100, 200, 400, 600, 900, 1500].map(g => ciColor(g)).join(", ")})`,
            }}
          />
          <span className="text-[11px] font-mono text-[var(--color-text-muted)]">0</span>
          <span className="text-[11px] font-mono text-[var(--color-text-muted)]">1500 gCO₂/kWh</span>
        </div>
      </div>

      {/* Side panel */}
      <DetailPanel
        countryId={selected}
        countryName={selectedCountryName}
        mapping={selectedMapping}
        data={data}
        errors={errs}
      />
    </div>
  );
}

function DetailPanel({
  countryId, countryName, mapping, data, errors,
}: {
  countryId: string | null;
  countryName: string | undefined;
  mapping: Array<{ iso: ISO; weight: number; label?: string }> | undefined;
  data: Partial<Record<ISO, MixSnapshot>>;
  errors: Partial<Record<ISO, string>>;
}) {
  if (!countryId || !mapping) {
    return (
      <div className="rounded-xl border border-[var(--color-grid-stroke)] bg-[rgba(255,255,255,0.02)] p-6 sticky top-6">
        <p className="text-sm text-[var(--color-text-muted)]">Click a colored country to see its mix.</p>
      </div>
    );
  }

  // Aggregate mix when multiple ISOs cover this country
  const aggregateMix: Record<string, number> = {};
  let aggregateCI = 0;
  let weightSum = 0;
  let latestTs: string | undefined;
  let allLive = true;
  for (const { iso, weight } of mapping) {
    const snap = data[iso];
    if (!snap) continue;
    if (snap.source !== "live") allLive = false;
    if (!latestTs || snap.ts > latestTs) latestTs = snap.ts;
    aggregateCI += snap.ci_g_per_kwh * weight;
    weightSum += weight;
    for (const [fuel, mw] of Object.entries(snap.generation_mw)) {
      aggregateMix[fuel] = (aggregateMix[fuel] ?? 0) + mw * weight;
    }
  }
  const ci = weightSum > 0 ? aggregateCI / weightSum : undefined;
  const totalMW = Object.values(aggregateMix).reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const sortedFuels = Object.entries(aggregateMix)
    .map(([fuel, mw]) => ({ fuel, mw, pct: (Math.max(mw, 0) / totalMW) * 100 }))
    .sort((a, b) => b.mw - a.mw);

  const carbonFreePct = sortedFuels
    .filter(({ fuel }) => ["solar", "wind", "hydro", "nuclear", "geothermal", "biomass"].includes(fuel))
    .reduce((s, { pct }) => s + pct, 0);
  const renewablePct = sortedFuels
    .filter(({ fuel }) => ["solar", "wind", "hydro", "geothermal", "biomass"].includes(fuel))
    .reduce((s, { pct }) => s + pct, 0);

  const fuelColor: Record<string, string> = {
    solar: "#FFD93D", wind: "#4ECDC4", hydro: "#5B9BD5", nuclear: "#A78BFA",
    geothermal: "#E76F51", biomass: "#7FD9A0", coal: "#3D3D3D", gas: "#FF8C42",
    oil: "#5C2D2D", battery: "#9CA3AF", imports: "#8FA3BE", other: "#6B7280",
  };

  return (
    <div className="rounded-xl border border-[var(--color-grid-stroke)] bg-[rgba(255,255,255,0.02)] p-6 sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">
      <div className="flex items-baseline justify-between mb-1">
        <h3 className="text-xl font-bold">{countryName ?? "—"}</h3>
        <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded ${allLive ? "bg-[rgba(78,205,196,0.15)] text-[var(--color-accent-mint)]" : "bg-[rgba(255,182,39,0.15)] text-[var(--color-accent-warm)]"}`}>
          {allLive ? "live" : "preliminary"}
        </span>
      </div>
      <p className="text-xs text-[var(--color-text-muted)] mb-4">
        {mapping.map(m => m.label ?? m.iso).join(" · ")}
      </p>

      {/* Big stats */}
      <div className="grid grid-cols-3 gap-2 mb-6">
        <div className="rounded-lg p-3" style={{ backgroundColor: ci != null ? hexA(ciColor(ci), 0.15) : "rgba(255,255,255,0.05)" }}>
          <div className="text-2xl font-bold tabular-nums">{ci != null ? Math.round(ci) : "—"}</div>
          <div className="text-[10px] text-[var(--color-text-muted)] uppercase tracking-wider mt-0.5">gCO₂eq/kWh</div>
          <div className="text-[10px] text-[var(--color-text-muted)] mt-1">Carbon intensity</div>
        </div>
        <div className="rounded-lg p-3 bg-[rgba(78,205,196,0.08)]">
          <div className="text-2xl font-bold tabular-nums">{Math.round(carbonFreePct)}%</div>
          <div className="text-[10px] text-[var(--color-accent-mint)] uppercase tracking-wider mt-0.5">carbon-free</div>
        </div>
        <div className="rounded-lg p-3 bg-[rgba(127,217,160,0.08)]">
          <div className="text-2xl font-bold tabular-nums">{Math.round(renewablePct)}%</div>
          <div className="text-[10px] text-[#7FD9A0] uppercase tracking-wider mt-0.5">renewable</div>
        </div>
      </div>

      <h4 className="text-sm font-semibold mb-2 flex items-center justify-between">
        Generation mix
        <span className="text-[10px] text-[var(--color-text-muted)] font-mono uppercase tracking-wider">MW</span>
      </h4>
      <div className="space-y-1.5">
        {sortedFuels.map(({ fuel, mw, pct }) => (
          <div key={fuel} className="grid grid-cols-[80px_1fr_60px] items-center gap-2">
            <span className="flex items-center gap-2 text-xs capitalize">
              <span className="w-2 h-2 rounded-sm" style={{ background: fuelColor[fuel] ?? "#6B7280" }} />
              {fuel}
            </span>
            <div className="h-2 rounded-full bg-[rgba(255,255,255,0.04)] overflow-hidden">
              <div className="h-full" style={{ width: `${Math.min(pct, 100)}%`, background: fuelColor[fuel] ?? "#6B7280" }} />
            </div>
            <span className="text-right text-xs font-mono tabular-nums text-[var(--color-text-muted)]">
              {mw >= 1000 ? `${(mw / 1000).toFixed(1)}k` : Math.round(mw)}
            </span>
          </div>
        ))}
      </div>

      <div className="mt-6 pt-4 border-t border-[var(--color-grid-stroke)] text-[10px] text-[var(--color-text-muted)] space-y-0.5">
        {latestTs && <div>Last data: {new Date(latestTs).toUTCString().slice(5, 22)} UTC</div>}
        <div>Sources: {mapping.map(m => m.iso).join(", ")}</div>
        {Object.entries(errors).filter(([iso]) => mapping.some(m => m.iso === iso)).map(([iso, err]) => (
          <div key={iso} className="text-[var(--color-accent-warm)]">⚠ {iso}: {err}</div>
        ))}
      </div>
    </div>
  );
}

// rgb(...) → rgba(... , a)
function hexA(rgb: string, a: number): string {
  const m = rgb.match(/rgb\(([^)]+)\)/);
  if (!m) return rgb;
  return `rgba(${m[1]}, ${a})`;
}
