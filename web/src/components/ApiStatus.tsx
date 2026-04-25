import { useEffect, useState } from "react";

type Iso = "CAISO" | "ERCOT" | "GB" | "AEMO" | "KPX";

const ISOS: Array<{ id: Iso; label: string }> = [
  { id: "CAISO", label: "CAISO" },
  { id: "ERCOT", label: "ERCOT" },
  { id: "GB",    label: "NESO" },
  { id: "AEMO",  label: "AEMO" },
  { id: "KPX",   label: "KPX" },
];

type Status = {
  state: "loading" | "live" | "estimate" | "down";
  source?: "live" | "estimate";
  lastOkAt?: number;     // ms timestamp of last 200
  latencyMs?: number;
  error?: string;
};

const POLL_MS = 60_000;
const TIMEOUT_MS = 6_000;

async function probe(iso: Iso): Promise<Status> {
  const t0 = performance.now();
  const ctrl = new AbortController();
  const tm = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`/api/mix/${iso}/live`, { signal: ctrl.signal });
    if (!res.ok) return { state: "down", error: `${res.status}`, latencyMs: Math.round(performance.now() - t0) };
    const json: any = await res.json();
    const source = json?.source === "live" ? "live" : "estimate";
    return {
      state: source === "live" ? "live" : "estimate",
      source,
      lastOkAt: Date.now(),
      latencyMs: Math.round(performance.now() - t0),
    };
  } catch (e) {
    return { state: "down", error: (e as Error).name === "AbortError" ? "timeout" : (e as Error).message, latencyMs: Math.round(performance.now() - t0) };
  } finally {
    clearTimeout(tm);
  }
}

function relativeTime(ms: number | undefined): string {
  if (!ms) return "—";
  const dt = Math.max(0, Date.now() - ms);
  if (dt < 5_000) return "just now";
  if (dt < 60_000) return `${Math.round(dt / 1000)}s ago`;
  if (dt < 3_600_000) return `${Math.round(dt / 60_000)}m ago`;
  return `${Math.round(dt / 3_600_000)}h ago`;
}

export default function ApiStatus() {
  const [statuses, setStatuses] = useState<Record<Iso, Status>>({
    CAISO: { state: "loading" },
    ERCOT: { state: "loading" },
    GB: { state: "loading" },
    AEMO: { state: "loading" },
    KPX: { state: "loading" },
  });
  const [, setTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function refresh() {
      const results = await Promise.allSettled(ISOS.map(({ id }) => probe(id).then(s => [id, s] as const)));
      if (cancelled) return;
      setStatuses(prev => {
        const next = { ...prev };
        results.forEach((r) => { if (r.status === "fulfilled") next[r.value[0]] = r.value[1]; });
        return next;
      });
    }
    refresh();
    const id = setInterval(refresh, POLL_MS);
    // ticker to refresh "Xs ago" labels every 5s without re-fetching
    const t = setInterval(() => setTick(n => n + 1), 5_000);
    return () => { cancelled = true; clearInterval(id); clearInterval(t); };
  }, []);

  const stateBg: Record<Status["state"], string> = {
    live:     "bg-[#4ECDC4]",            // mint
    estimate: "bg-[var(--color-accent-warm)]", // amber
    down:     "bg-[var(--color-accent-hot)]",  // red
    loading:  "bg-[rgba(255,255,255,0.25)]",
  };

  const aggregate = (() => {
    const vals = Object.values(statuses);
    if (vals.some(v => v.state === "down")) return { color: "text-[var(--color-accent-hot)]", label: "degraded" };
    if (vals.every(v => v.state === "live")) return { color: "text-[#4ECDC4]", label: "all live" };
    if (vals.some(v => v.state === "loading")) return { color: "text-[var(--color-text-muted)]", label: "checking…" };
    return { color: "text-[var(--color-accent-warm)]", label: "partial" };
  })();

  return (
    <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
      <span className={`uppercase tracking-wider font-semibold ${aggregate.color} whitespace-nowrap`}>
        ● {aggregate.label}
      </span>
      <span className="text-[var(--color-text-muted)]">·</span>
      {ISOS.map(({ id, label }) => {
        const s = statuses[id];
        return (
          <span
            key={id}
            className="inline-flex items-center gap-1 text-[var(--color-text-muted)]"
            title={
              s.state === "loading" ? "checking…"
              : s.state === "down"   ? `down: ${s.error ?? "error"}`
              : `${s.state} · ${s.latencyMs ?? "?"}ms · last ok ${relativeTime(s.lastOkAt)}`
            }
          >
            <span className={`relative inline-flex h-1.5 w-1.5 rounded-full ${stateBg[s.state]}`}>
              {s.state === "live" && (
                <span className="absolute inset-0 rounded-full bg-[#4ECDC4] opacity-60 animate-ping" />
              )}
            </span>
            <span className="uppercase tracking-wider">{label}</span>
            <span className="text-[9px] opacity-70">{s.latencyMs ? `${s.latencyMs}ms` : ""}</span>
          </span>
        );
      })}
    </div>
  );
}
