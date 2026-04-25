// Grid402 — shared response types.
//
// One JSON envelope per zone per 5-min interval, covering the three MVP signals:
//   1) Price (wholesale LMP)
//   2) Generation mix (MW by fuel)
//   3) Emissions (self-computed gCO2/kWh + share percentages)
//
// Every paid endpoint ultimately returns a `Grid402Response<T>` so agents can
// rely on a consistent shape across ISOs.

export type Iso =
  | "CAISO"
  | "ERCOT"
  | "PJM"
  | "MISO"
  | "NYISO"
  | "ISO-NE"
  | "SPP"
  | "ENTSO-E"
  | "BMRS"
  | "AEMO"
  | "KPX"
  | "JEPX";

export type MarketRun = "RTM" | "DAM" | "IDM";

// Canonical Grid402 fuel taxonomy. Every ISO's raw columns map into these 11
// categories so downstream consumers never have to worry about per-ISO naming.
export type FuelType =
  | "coal"
  | "gas"
  | "oil"
  | "nuclear"
  | "hydro"
  | "wind"
  | "solar"
  | "biomass"
  | "geothermal"
  | "storage"    // Battery / pumped-hydro (net discharge if positive, charge if negative)
  | "imports"    // Net import flow (positive = importing from neighbor)
  | "other";

// ----- Price signal ---------------------------------------------------------

export interface PriceSignal {
  lmp_usd_per_mwh: number;
  market: MarketRun;
  // Optional decomposition (ISOs like ERCOT / PJM / MISO publish these)
  energy_component?: number;
  congestion_component?: number;
  losses_component?: number;
}

// ----- Generation mix signal -----------------------------------------------

export interface GenerationMixSignal {
  // MW by fuel. Missing fuel for a given ISO -> field absent.
  mw: Partial<Record<FuelType, number>>;
  total_mw: number; // sum of all generated MW (excludes imports if imports < 0)
}

// ----- Emissions signal (self-computed) ------------------------------------

export interface EmissionsSignal {
  method: "IPCC_AR6_lifecycle" | "IPCC_AR6_direct" | "IEA_lifecycle";
  gco2_per_kwh: number;
  fossil_only_gco2_per_kwh: number;
  factor_source: string; // URL to methodology
  self_computed: true;
}

// Mix-derived percentage shares
export interface ShareSignal {
  renewable_pct: number;      // wind + solar + hydro + geothermal + biomass
  carbon_free_pct: number;    // renewable + nuclear
  fossil_pct: number;         // coal + gas + oil
}

// ----- Source & payment metadata --------------------------------------------

export interface SourceMetadata {
  publisher: string;
  license: string;
  upstream: string;
  fetched_at: string; // ISO-8601
}

export interface PaymentMetadata {
  protocol: "x402";
  network: string;     // CAIP-2 e.g. "eip155:8453"
  tx_hash?: string;    // set by facilitator post-verification
  amount_usd: number;
}

// ----- Combined response ----------------------------------------------------

export interface Grid402Response<Signals> {
  iso: Iso;
  zone: string;
  interval_start_utc: string;
  interval_end_utc: string;
  signals: Signals;
  source: SourceMetadata;
  payment?: PaymentMetadata; // optional; populated on paid routes
}

// Convenience aliases for the three MVP endpoint shapes
export type PriceOnly    = Grid402Response<{ price: PriceSignal }>;
export type MixOnly      = Grid402Response<{ generation_mix: GenerationMixSignal }>;
export type EmissionsOnly = Grid402Response<{
  generation_mix: GenerationMixSignal;
  emissions: EmissionsSignal;
  shares: ShareSignal;
}>;
export type CombinedResponse = Grid402Response<{
  price: PriceSignal;
  generation_mix: GenerationMixSignal;
  emissions: EmissionsSignal;
  shares: ShareSignal;
}>;
