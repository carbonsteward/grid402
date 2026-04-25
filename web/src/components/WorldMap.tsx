import { useEffect, useMemo, useRef, useState } from "react";
import maplibregl, { type Map as MLMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { feature } from "topojson-client";
import type { FeatureCollection, Geometry, Feature } from "geojson";
import { getHistory, getMixRegion, getSpot, type ISO, type HistoricalSeries, type MixSnapshot, type SpotSnapshot } from "../lib/api";

// Country numeric ISO 3166-1 IDs → ISO operator(s) covering them.
const COUNTRY_TO_ISO: Record<string, Array<{ iso: ISO; weight: number; label?: string }>> = {
  "840": [{ iso: "CAISO", weight: 0.4, label: "California (CAISO)" }, { iso: "ERCOT", weight: 0.6, label: "Texas (ERCOT)" }],
  "410": [{ iso: "KPX", weight: 1, label: "South Korea (KPX)" }],
  "826": [{ iso: "GB" as ISO, weight: 1, label: "Great Britain (NESO)" }],
};

// AEMO sub-state regions (NEM). ID matches the geojson `id` we set in build.
type AemoRegion = "NSW1" | "QLD1" | "SA1" | "TAS1" | "VIC1";
const AEMO_REGIONS: Array<{ id: AemoRegion; label: string }> = [
  { id: "NSW1", label: "New South Wales (NSW1)" },
  { id: "QLD1", label: "Queensland (QLD1)" },
  { id: "SA1",  label: "South Australia (SA1)" },
  { id: "TAS1", label: "Tasmania (TAS1)" },
  { id: "VIC1", label: "Victoria (VIC1)" },
];

// Default spot zone per ISO (used when sidebar opens)
const DEFAULT_SPOT_ZONE: Record<string, string> = {
  CAISO: "TH_NP15",
  ERCOT: "HB_NORTH",
  GB:    "GB",
  KPX:   "KR",
  AEMO:  "NEM",
};

const ISOS_TO_FETCH: ISO[] = ["CAISO", "ERCOT", "AEMO", "KPX", "GB" as ISO];
const HISTORY_HOURS = 24;
const HISTORY_STEP = 30;

const CI_STOPS: Array<[number, [number, number, number]]> = [
  [0,    [78, 205, 196]],
  [100,  [127, 217, 160]],
  [200,  [223, 194, 94]],
  [400,  [200, 130, 60]],
  [600,  [148, 84, 50]],
  [900,  [101, 56, 35]],
  [1500, [60, 35, 25]],
];

function ciColor(g: number | undefined | null): string {
  if (g == null || Number.isNaN(g)) return "rgba(143, 163, 190, 0.18)";
  let lo = CI_STOPS[0], hi = CI_STOPS[CI_STOPS.length - 1];
  for (let i = 0; i < CI_STOPS.length - 1; i++) {
    if (g >= CI_STOPS[i][0] && g <= CI_STOPS[i + 1][0]) { lo = CI_STOPS[i]; hi = CI_STOPS[i + 1]; break; }
  }
  if (g <= CI_STOPS[0][0]) return `rgb(${CI_STOPS[0][1].join(",")})`;
  if (g >= CI_STOPS[CI_STOPS.length - 1][0]) return `rgb(${CI_STOPS[CI_STOPS.length - 1][1].join(",")})`;
  const t = (g - lo[0]) / (hi[0] - lo[0]);
  const r = Math.round(lo[1][0] + (hi[1][0] - lo[1][0]) * t);
  const gg = Math.round(lo[1][1] + (hi[1][1] - lo[1][1]) * t);
  const b = Math.round(lo[1][2] + (hi[1][2] - lo[1][2]) * t);
  return `rgb(${r},${gg},${b})`;
}

type FC = FeatureCollection<Geometry, { name?: string }>;
type Snapshot = HistoricalSeries["series"][number];

export default function WorldMap() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MLMap | null>(null);
  const [topo, setTopo] = useState<FC | null>(null);
  const [auStates, setAuStates] = useState<FC | null>(null);
  const [history, setHistory] = useState<Partial<Record<ISO, HistoricalSeries>>>({});
  const [aemoRegions, setAemoRegions] = useState<Partial<Record<AemoRegion, MixSnapshot>>>({});
  const [spot, setSpot] = useState<Partial<Record<ISO, SpotSnapshot>>>({});
  const [errs, setErrs] = useState<Partial<Record<ISO, string>>>({});
  const [selected, setSelected] = useState<string | null>("840");
  const [styleReady, setStyleReady] = useState(false);

  // Slider position. 0 = oldest in window, 1 = most recent. Live by default.
  const [sliderPct, setSliderPct] = useState(1);
  const [isLive, setIsLive] = useState(true);

  // Build a unified timeline (UTC ms) using the longest available series.
  const timeline = useMemo(() => {
    let best: number[] = [];
    for (const series of Object.values(history)) {
      if (!series) continue;
      if (series.series.length > best.length) {
        best = series.series.map(s => new Date(s.ts).getTime());
      }
    }
    return best.sort((a, b) => a - b);
  }, [history]);

  // Load TopoJSON for countries + GeoJSON for AU states
  useEffect(() => {
    let cancelled = false;
    fetch("/data/countries-110m.json")
      .then(r => r.json())
      .then((t: any) => {
        if (cancelled) return;
        const fc = feature(t, t.objects.countries) as unknown as FC;
        const features: Feature[] = fc.features.map(f => ({
          ...f,
          properties: { ...(f.properties ?? {}), iso_n3: String(f.id ?? "") },
        }));
        setTopo({ type: "FeatureCollection", features } as FC);
      });
    fetch("/data/au-states.geojson")
      .then(r => r.json())
      .then((j: FC) => { if (!cancelled) setAuStates(j); });
    return () => { cancelled = true; };
  }, []);

  // Poll history + per-AEMO-region + spot prices every 5 minutes
  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      // History (for slider scrubbing)
      const histR = await Promise.allSettled(
        ISOS_TO_FETCH.map(iso => getHistory(iso, { hours: HISTORY_HOURS, step: HISTORY_STEP }))
      );
      // AEMO sub-state regions (live snapshot per region)
      const auR = await Promise.allSettled(
        AEMO_REGIONS.map(r => getMixRegion("AEMO" as ISO, r.id))
      );
      // Spot prices (default zone per ISO)
      const spotR = await Promise.allSettled(
        ISOS_TO_FETCH.map(iso => getSpot(iso, DEFAULT_SPOT_ZONE[iso] ?? "default"))
      );
      if (cancelled) return;

      const h: typeof history = {};
      const e: typeof errs = {};
      histR.forEach((res, i) => {
        const iso = ISOS_TO_FETCH[i];
        if (res.status === "fulfilled") h[iso] = res.value;
        else e[iso] = (res.reason as Error).message;
      });
      setHistory(h);

      const au: typeof aemoRegions = {};
      auR.forEach((res, i) => {
        if (res.status === "fulfilled") au[AEMO_REGIONS[i].id] = res.value;
      });
      setAemoRegions(au);

      const s: typeof spot = {};
      spotR.forEach((res, i) => {
        const iso = ISOS_TO_FETCH[i];
        if (res.status === "fulfilled") s[iso] = res.value;
      });
      setSpot(s);
      setErrs(e);
    }
    refresh();
    const id = setInterval(refresh, 5 * 60_000);
    return () => { cancelled = true; clearInterval(id); };
  }, []);

  // Initialize MapLibre once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json",
      center: [10, 30],
      zoom: 1.6,
      minZoom: 1.2,
      maxZoom: 7,
      attributionControl: { compact: true },
      renderWorldCopies: false,
      dragRotate: false,
      pitchWithRotate: false,
    });
    map.scrollZoom.disable();
    map.on("click", () => map.scrollZoom.enable());
    map.touchZoomRotate.disableRotation();
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    map.on("load", () => setStyleReady(true));
    mapRef.current = map;

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Add the choropleth source/layer once both topo + style are ready
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !topo || !styleReady) return;
    if (map.getSource("countries")) return;

    map.addSource("countries", {
      type: "geojson",
      data: topo as any,
      promoteId: "iso_n3",
    });

    map.addLayer({
      id: "countries-fill",
      type: "fill",
      source: "countries",
      paint: {
        "fill-color": [
          "case",
          ["==", ["coalesce", ["feature-state", "covered"], false], true],
          ["coalesce", ["feature-state", "color"], "rgba(143, 163, 190, 0.18)"],
          "rgba(143, 163, 190, 0.04)",
        ],
        "fill-opacity": [
          "case",
          ["==", ["coalesce", ["feature-state", "covered"], false], true], 0.85,
          0.4,
        ],
      },
    });

    map.addLayer({
      id: "countries-stroke",
      type: "line",
      source: "countries",
      paint: {
        "line-color": [
          "case",
          ["==", ["coalesce", ["feature-state", "selected"], false], true], "#F5F5F7",
          ["==", ["coalesce", ["feature-state", "covered"], false], true], "rgba(245,245,247,0.45)",
          "rgba(143,163,190,0.18)",
        ],
        "line-width": [
          "case",
          ["==", ["coalesce", ["feature-state", "selected"], false], true], 2,
          0.5,
        ],
      },
    });

    map.on("click", "countries-fill", (e) => {
      const id = e.features?.[0]?.id as string | undefined;
      if (id && id in COUNTRY_TO_ISO) setSelected(id);
    });

    map.on("mousemove", "countries-fill", (e) => {
      const id = e.features?.[0]?.id as string | undefined;
      map.getCanvas().style.cursor = id && id in COUNTRY_TO_ISO ? "pointer" : "";
    });
    map.on("mouseleave", "countries-fill", () => { map.getCanvas().style.cursor = ""; });
  }, [topo, styleReady]);

  // Add AU states layer (sub-national) ON TOP of the country layer
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !auStates || !styleReady) return;
    if (map.getSource("au-states")) return;

    map.addSource("au-states", {
      type: "geojson",
      data: auStates as any,
      promoteId: "aemo_region",
    });

    map.addLayer({
      id: "au-states-fill",
      type: "fill",
      source: "au-states",
      paint: {
        "fill-color": ["coalesce", ["feature-state", "color"], "rgba(143, 143, 168, 0.18)"],
        "fill-opacity": 0.85,
      },
    });

    map.addLayer({
      id: "au-states-stroke",
      type: "line",
      source: "au-states",
      paint: {
        "line-color": [
          "case",
          ["==", ["coalesce", ["feature-state", "selected"], false], true], "#F0F0EC",
          "rgba(240,240,236,0.45)",
        ],
        "line-width": [
          "case",
          ["==", ["coalesce", ["feature-state", "selected"], false], true], 2,
          0.6,
        ],
      },
    });

    map.on("click", "au-states-fill", (e) => {
      const id = e.features?.[0]?.id as string | undefined;
      if (id && (id === "NSW1" || id === "QLD1" || id === "SA1" || id === "TAS1" || id === "VIC1")) {
        setSelected(`AU_${id}`);
      }
    });
    map.on("mousemove", "au-states-fill", (e) => {
      const id = e.features?.[0]?.id as string | undefined;
      const isAemo = id === "NSW1" || id === "QLD1" || id === "SA1" || id === "TAS1" || id === "VIC1";
      map.getCanvas().style.cursor = isAemo ? "pointer" : "";
    });
    map.on("mouseleave", "au-states-fill", () => { map.getCanvas().style.cursor = ""; });
  }, [auStates, styleReady]);

  // Find each ISO's snapshot at the slider's UTC time
  const targetTs = timeline.length > 0 ? timeline[Math.round(sliderPct * (timeline.length - 1))] : null;

  function snapshotAt(iso: ISO, ts: number | null): Snapshot | undefined {
    const series = history[iso]?.series;
    if (!series || series.length === 0) return undefined;
    if (ts == null) return series[series.length - 1];
    // Binary search not needed for 48 points; linear is fine.
    let best = series[0];
    let bestDelta = Math.abs(new Date(best.ts).getTime() - ts);
    for (let i = 1; i < series.length; i++) {
      const d = Math.abs(new Date(series[i].ts).getTime() - ts);
      if (d < bestDelta) { best = series[i]; bestDelta = d; }
    }
    return best;
  }

  // Aggregate snapshots per country at current slider time
  const currentByIso: Partial<Record<ISO, Snapshot>> = useMemo(() => {
    const out: Partial<Record<ISO, Snapshot>> = {};
    const ts = isLive ? null : targetTs;
    for (const iso of ISOS_TO_FETCH) out[iso] = snapshotAt(iso, ts);
    return out;
  }, [history, targetTs, isLive]);

  // Update feature-states whenever currentByIso changes
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !topo || !styleReady) return;
    if (!map.getSource("countries")) return;

    function ciFor(countryId: string): number | undefined {
      const mapping = COUNTRY_TO_ISO[countryId];
      if (!mapping) return undefined;
      let sum = 0, w = 0;
      for (const { iso, weight } of mapping) {
        const snap = currentByIso[iso];
        if (snap) { sum += snap.ci_g_per_kwh * weight; w += weight; }
      }
      return w > 0 ? sum / w : undefined;
    }

    for (const f of topo.features) {
      const id = String(f.id ?? "");
      if (!id) continue;
      // Australia (036) is now drawn as sub-states; dim the country fill so AU states show through.
      const covered = id in COUNTRY_TO_ISO;
      const ci = ciFor(id);
      map.setFeatureState(
        { source: "countries", id },
        {
          covered,
          color: covered ? ciColor(ci) : "rgba(143, 163, 190, 0.04)",
          selected: id === selected,
        },
      );
    }

    // Update AU states feature-state from per-region snapshots
    if (auStates && map.getSource("au-states")) {
      for (const f of auStates.features) {
        const id = String(f.id ?? "");
        if (!id) continue;
        const region = id as AemoRegion;
        const snap = aemoRegions[region];
        const stateColor = snap ? ciColor(snap.ci_g_per_kwh) : "rgba(143, 143, 168, 0.18)";
        map.setFeatureState(
          { source: "au-states", id },
          {
            color: stateColor,
            selected: selected === `AU_${id}`,
          },
        );
      }
    }
  }, [currentByIso, topo, styleReady, selected, auStates, aemoRegions]);

  const isAemoState = selected?.startsWith("AU_") ?? false;
  const aemoSelectedRegion = isAemoState ? (selected!.slice(3) as AemoRegion) : null;
  const selectedMapping = isAemoState
    ? AEMO_REGIONS.filter(r => r.id === aemoSelectedRegion).map(r => ({ iso: "AEMO" as ISO, weight: 1, label: r.label }))
    : (selected ? COUNTRY_TO_ISO[selected] : undefined);
  const selectedCountryName = isAemoState
    ? (auStates?.features.find(f => String(f.id) === aemoSelectedRegion)?.properties?.name as string | undefined)
    : (selected && topo ? topo.features.find(f => String(f.id) === selected)?.properties?.name : undefined);

  const displayedTs = isLive ? (timeline[timeline.length - 1] ?? Date.now()) : (targetTs ?? Date.now());

  return (
    <div className="flex flex-col gap-3">
      <div className="relative rounded-xl overflow-hidden bg-[#0B1220] border border-[var(--color-grid-stroke)]">
        <div ref={containerRef} className="h-[640px] w-full" />

        {/* Live indicator (top-left of map) */}
        <button
          onClick={() => { setIsLive(true); setSliderPct(1); }}
          className={`absolute top-4 left-4 flex items-center gap-2 rounded-full backdrop-blur px-3 py-1.5 border transition-all z-20 ${
            isLive
              ? "bg-[rgba(255,107,53,0.15)] border-[var(--color-accent-hot)]"
              : "bg-[rgba(11,18,32,0.85)] border-[var(--color-grid-stroke)] hover:border-[var(--color-accent-hot)]"
          }`}
          title={isLive ? "Showing latest data" : "Click to jump back to live"}
        >
          <span className="relative inline-flex h-2 w-2">
            {isLive && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-accent-hot)] opacity-75" />}
            <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--color-accent-hot)]" />
          </span>
          <span className="text-xs font-mono text-[var(--color-text-light)]">
            {isLive ? "LIVE" : "← BACK TO LIVE"}
          </span>
        </button>

        {/* CI legend */}
        <div className="absolute bottom-3 left-3 max-w-[55%] flex items-center gap-2 rounded-lg bg-[rgba(11,18,32,0.85)] backdrop-blur px-3 py-1.5 border border-[var(--color-grid-stroke)] z-10">
          <span className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] font-semibold whitespace-nowrap">CI</span>
          <div
            className="flex-1 h-2 rounded min-w-[100px]"
            style={{
              background: `linear-gradient(to right, ${CI_STOPS.map(([g]) => ciColor(g)).join(", ")})`,
            }}
          />
          <span className="text-[10px] font-mono text-[var(--color-text-muted)] whitespace-nowrap">0–1500</span>
        </div>

        {/* Hint when nothing selected */}
        {!selected && (
          <div className="absolute top-4 right-16 z-10 rounded-full bg-[rgba(11,18,32,0.85)] backdrop-blur px-3 py-1.5 border border-[var(--color-grid-stroke)]">
            <span className="text-xs text-[var(--color-text-muted)]">Click a colored country</span>
          </div>
        )}

        {/* Slide-in detail panel (overlay) */}
        <DetailPanel
          countryId={selected}
          countryName={selectedCountryName}
          mapping={selectedMapping}
          currentByIso={
            // For AU sub-state selection, override AEMO snapshot with the region's data
            isAemoState && aemoSelectedRegion && aemoRegions[aemoSelectedRegion]
              ? { ...currentByIso, AEMO: aemoRegions[aemoSelectedRegion]! }
              : currentByIso
          }
          spot={spot}
          errors={errs}
          displayedTs={displayedTs}
          isLive={isLive}
          onClose={() => setSelected(null)}
        />
      </div>

      {/* Time slider below the map */}
      <TimeSlider
        timeline={timeline}
        sliderPct={sliderPct}
        isLive={isLive}
        displayedTs={displayedTs}
        onChange={(pct, live) => { setSliderPct(pct); setIsLive(live); }}
        stepMinutes={HISTORY_STEP}
      />
    </div>
  );
}

function TimeSlider({
  timeline, sliderPct, isLive, displayedTs, onChange, stepMinutes,
}: {
  timeline: number[];
  sliderPct: number;
  isLive: boolean;
  displayedTs: number;
  onChange: (pct: number, live: boolean) => void;
  stepMinutes: number;
}) {
  if (timeline.length === 0) {
    return (
      <div className="rounded-xl border border-[var(--color-grid-stroke)] bg-[rgba(255,255,255,0.02)] px-4 py-3 text-xs text-[var(--color-text-muted)]">
        Loading time series…
      </div>
    );
  }
  const startTs = timeline[0];
  const endTs = timeline[timeline.length - 1];
  const display = new Date(displayedTs);
  const dateStr = display.toUTCString().slice(0, 16);
  const timeStr = display.toUTCString().slice(17, 22);

  return (
    <div className="rounded-xl border border-[var(--color-grid-stroke)] bg-[rgba(255,255,255,0.02)] px-5 py-4">
      <div className="flex items-baseline justify-between mb-3">
        <div>
          <div className="text-base font-semibold tabular-nums">
            {dateStr}, <span className="text-[var(--color-accent-hot)]">{timeStr} UTC</span>
          </div>
          <div className="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)] mt-0.5">
            {stepMinutes} min · {timeline.length} slots
          </div>
        </div>
        <div className="text-xs text-[var(--color-text-muted)] font-mono tabular-nums">
          {Math.round((displayedTs - startTs) / 60_000)} min from oldest · {Math.round((endTs - displayedTs) / 60_000)} min from now
        </div>
      </div>

      <div className="relative">
        <input
          type="range"
          min="0"
          max="1000"
          value={Math.round(sliderPct * 1000)}
          onChange={(e) => {
            const pct = Number(e.target.value) / 1000;
            onChange(pct, pct >= 0.995);
          }}
          className="w-full h-2 rounded-full appearance-none bg-[rgba(255,255,255,0.08)] cursor-pointer
                     [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:h-5 [&::-webkit-slider-thumb]:w-5
                     [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[var(--color-accent-hot)]
                     [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-[var(--color-slide-bg)]
                     [&::-webkit-slider-thumb]:shadow-[0_0_0_3px_rgba(255,107,53,0.25)]
                     [&::-moz-range-thumb]:h-5 [&::-moz-range-thumb]:w-5 [&::-moz-range-thumb]:rounded-full
                     [&::-moz-range-thumb]:bg-[var(--color-accent-hot)] [&::-moz-range-thumb]:border-2
                     [&::-moz-range-thumb]:border-[var(--color-slide-bg)]"
        />
        {/* Live indicator at right */}
        <div className="absolute right-0 -top-1 h-4 w-1 bg-[var(--color-accent-hot)] rounded-full pointer-events-none" />
      </div>

      <div className="flex justify-between text-[10px] font-mono text-[var(--color-text-muted)] tabular-nums mt-2">
        <span>{new Date(startTs).toUTCString().slice(5, 22)} UTC</span>
        <span className={isLive ? "text-[var(--color-accent-hot)] font-semibold" : ""}>
          {isLive ? "● LIVE" : new Date(endTs).toUTCString().slice(17, 22) + " UTC"}
        </span>
      </div>
    </div>
  );
}

function DetailPanel({
  countryId, countryName, mapping, currentByIso, spot, errors, displayedTs, isLive, onClose,
}: {
  countryId: string | null;
  countryName: string | undefined;
  mapping: Array<{ iso: ISO; weight: number; label?: string }> | undefined;
  currentByIso: Partial<Record<ISO, Snapshot>>;
  spot: Partial<Record<ISO, SpotSnapshot>>;
  errors: Partial<Record<ISO, string>>;
  displayedTs: number;
  isLive: boolean;
  onClose: () => void;
}) {
  const open = !!(countryId && mapping && mapping.length > 0);
  if (!open) return null;

  const aggregateMix: Record<string, number> = {};
  let aggregateCI = 0;
  let weightSum = 0;
  for (const { iso, weight } of mapping) {
    const snap = currentByIso[iso];
    if (!snap) continue;
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
    <div className="absolute top-3 left-3 bottom-16 w-[400px] max-w-[calc(100%-1.5rem)] rounded-xl border border-[var(--color-grid-stroke)] bg-[rgba(11,18,32,0.92)] backdrop-blur-md shadow-2xl shadow-black/50 z-30 flex flex-col overflow-hidden animate-in slide-in-from-left">
      <div className="px-5 pt-4 pb-3 border-b border-[var(--color-grid-stroke)]">
        <button
          onClick={onClose}
          className="absolute top-3 right-3 w-7 h-7 rounded-full hover:bg-[rgba(255,255,255,0.08)] text-[var(--color-text-muted)] hover:text-[var(--color-text-light)] flex items-center justify-center transition-colors"
          aria-label="Close panel"
          title="Close (or click another country)"
        >
          ✕
        </button>
        <div className="flex items-baseline gap-2 mb-1 pr-8">
          <h3 className="text-xl font-bold leading-tight">{countryName ?? "—"}</h3>
          <span className={`text-[10px] font-mono uppercase tracking-wider px-2 py-0.5 rounded shrink-0 ${
            isLive ? "bg-[rgba(255,107,53,0.15)] text-[var(--color-accent-hot)]" : "bg-[rgba(255,182,39,0.15)] text-[var(--color-accent-warm)]"
          }`}>
            {isLive ? "live" : "history"}
          </span>
        </div>
        <p className="text-xs text-[var(--color-text-muted)]">
          {mapping.map(m => m.label ?? m.iso).join(" · ")}
        </p>
        <p className="text-[10px] text-[var(--color-text-muted)] font-mono mt-1">
          {new Date(displayedTs).toUTCString().slice(5, 22)} UTC
        </p>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4">

        <div className="grid grid-cols-3 gap-2 mb-4">
          <div className="rounded-lg p-2.5" style={{ backgroundColor: ci != null ? rgbA(ciColor(ci), 0.15) : "rgba(255,255,255,0.05)" }}>
            <div className="text-xl font-bold tabular-nums">{ci != null ? Math.round(ci) : "—"}</div>
            <div className="text-[9px] text-[var(--color-text-muted)] uppercase tracking-wider mt-0.5">gCO₂/kWh</div>
          </div>
          <div className="rounded-lg p-2.5 bg-[rgba(0,188,188,0.08)]">
            <div className="text-xl font-bold tabular-nums">{Math.round(carbonFreePct)}%</div>
            <div className="text-[9px] text-[var(--color-accent-primary)] uppercase tracking-wider mt-0.5">carbon-free</div>
          </div>
          <div className="rounded-lg p-2.5 bg-[rgba(77,222,222,0.08)]">
            <div className="text-xl font-bold tabular-nums">{Math.round(renewablePct)}%</div>
            <div className="text-[9px] text-[var(--color-accent-light)] uppercase tracking-wider mt-0.5">renewable</div>
          </div>
        </div>

        {/* Spot price */}
        {(() => {
          const primaryIso = mapping[0]?.iso;
          const sp = primaryIso ? spot[primaryIso] : undefined;
          if (!sp) return null;
          const fmt = (n: number) => n >= 100 ? n.toFixed(0) : n.toFixed(2);
          return (
            <div className="rounded-lg p-3 mb-4 bg-[rgba(255,208,102,0.05)] border border-[rgba(255,208,102,0.15)]">
              <div className="flex items-baseline justify-between">
                <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent-warm)] font-semibold">
                  Spot price · {sp.zone}
                </span>
                <span className="text-[10px] text-[var(--color-text-muted)] font-mono">
                  {sp.source === "live" ? "live" : "estimate"}
                </span>
              </div>
              <div className="mt-1 flex items-baseline gap-2">
                <span className="text-2xl font-bold tabular-nums">${fmt(sp.price_usd_per_mwh)}</span>
                <span className="text-xs text-[var(--color-text-muted)]">USD/MWh</span>
              </div>
              {(sp as any).price_native && sp.currency !== "USD" && (
                <div className="text-[11px] text-[var(--color-text-muted)] font-mono">
                  {(sp as any).price_native >= 1000
                    ? `${((sp as any).price_native / 1000).toFixed(1)}k`
                    : (sp as any).price_native.toFixed(0)} {sp.currency}/MWh
                </div>
              )}
            </div>
          );
        })()}

        <h4 className="text-xs font-semibold mb-2 flex items-center justify-between text-[var(--color-text-muted)] uppercase tracking-wider">
          <span>Generation mix</span>
          <span className="font-mono">MW</span>
        </h4>
        <div className="space-y-1.5">
          {sortedFuels.map(({ fuel, mw, pct }) => (
            <div key={fuel} className="grid grid-cols-[70px_1fr_50px] items-center gap-2">
              <span className="flex items-center gap-1.5 text-xs capitalize">
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: fuelColor[fuel] ?? "#6B7280" }} />
                {fuel}
              </span>
              <div className="h-1.5 rounded-full bg-[rgba(255,255,255,0.04)] overflow-hidden">
                <div className="h-full transition-[width] duration-300" style={{ width: `${Math.min(pct, 100)}%`, background: fuelColor[fuel] ?? "#6B7280" }} />
              </div>
              <span className="text-right text-[11px] font-mono tabular-nums text-[var(--color-text-muted)]">
                {mw >= 1000 ? `${(mw / 1000).toFixed(1)}k` : Math.round(mw)}
              </span>
            </div>
          ))}
        </div>

        <div className="mt-5 pt-3 border-t border-[var(--color-grid-stroke)] text-[10px] text-[var(--color-text-muted)] space-y-0.5">
          <div>Sources: {mapping.map(m => m.iso).join(", ")}</div>
          {Object.entries(errors).filter(([iso]) => mapping.some(m => m.iso === iso)).map(([iso, err]) => (
            <div key={iso} className="text-[var(--color-accent-warm)]">⚠ {iso}: {err}</div>
          ))}
        </div>
      </div>
    </div>
  );
}

function rgbA(rgb: string, a: number): string {
  const m = rgb.match(/rgb\(([^)]+)\)/);
  if (!m) return rgb;
  return `rgba(${m[1]}, ${a})`;
}
