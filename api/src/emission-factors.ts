// IPCC AR6 Working Group III median emission factors for electricity generation.
//
// Values are in gCO2eq per kWh delivered. Two sets are provided:
//
//   - LIFECYCLE: full life-cycle assessment. Includes upstream fuel extraction,
//     plant construction, and decommissioning. This is what regulators (EU
//     CBAM, SBTi Scope 3) and advocacy groups (Electricity Maps, Ember, IEA)
//     typically publish.
//
//   - DIRECT: combustion-only. Excludes upstream; closer to what shows up in
//     cap-and-trade schemes (EU ETS, CA AB-32). Useful when the consumer is
//     already accounting for upstream separately.
//
// All Grid402 responses should disclose which set was used via the
// EmissionsSignal.method field so auditors can trace the assumption.
//
// Primary sources:
//   - IPCC AR6 WG3 Annex III Table A.III.2 (2022)
//     https://www.ipcc.ch/report/ar6/wg3/downloads/report/IPCC_AR6_WGIII_Annex-III.pdf
//   - IEA "CO2 Emissions from Fuel Combustion" (2023 edition)
//     https://www.iea.org/data-and-statistics/data-product/emissions-factors-2023
//   - Ember "Electricity emissions factors by country" (open CC-BY 4.0)
//
// These numbers are global medians. Per-country refinements (for example,
// Chinese coal has a different factor from Australian coal) are a V2 concern.

import type { FuelType } from "./types.js";

export type FactorSet = "IPCC_AR6_lifecycle" | "IPCC_AR6_direct" | "IEA_lifecycle";

export const IPCC_AR6_LIFECYCLE: Record<FuelType, number> = {
  coal:       1050,
  gas:         670,
  oil:         840,
  nuclear:      12,
  hydro:        24,
  wind:         11,
  solar:        48,
  biomass:     230,  // debated — carbon-neutral assumption is contested
  geothermal:   38,
  storage:       0,  // assumed grid-follow; real accounting requires charge-side
  imports:       0,  // assumed unknown; caller should compute per neighbor
  other:       450,  // conservative fallback for unlabeled fossil
};

export const IPCC_AR6_DIRECT: Record<FuelType, number> = {
  coal:        820,
  gas:         490,
  oil:         650,
  nuclear:       0,
  hydro:         0,
  wind:          0,
  solar:         0,
  biomass:       0,  // direct-combustion only; carbon-neutral assumption
  geothermal:    0,
  storage:       0,
  imports:       0,
  other:       400,
};

export const IEA_LIFECYCLE: Record<FuelType, number> = {
  coal:       1000,
  gas:         450,
  oil:         800,
  nuclear:      15,
  hydro:        25,
  wind:         12,
  solar:        45,
  biomass:     200,
  geothermal:   40,
  storage:       0,
  imports:       0,
  other:       400,
};

const FACTOR_SETS: Record<FactorSet, Record<FuelType, number>> = {
  IPCC_AR6_lifecycle: IPCC_AR6_LIFECYCLE,
  IPCC_AR6_direct:    IPCC_AR6_DIRECT,
  IEA_lifecycle:      IEA_LIFECYCLE,
};

const SOURCE_URL: Record<FactorSet, string> = {
  IPCC_AR6_lifecycle:
    "https://www.ipcc.ch/report/ar6/wg3/downloads/report/IPCC_AR6_WGIII_Annex-III.pdf",
  IPCC_AR6_direct:
    "https://www.ipcc.ch/report/ar6/wg3/downloads/report/IPCC_AR6_WGIII_Annex-III.pdf",
  IEA_lifecycle:
    "https://www.iea.org/data-and-statistics/data-product/emissions-factors-2023",
};

const FOSSIL_FUELS: FuelType[] = ["coal", "gas", "oil"];
const RENEWABLE_FUELS: FuelType[] = [
  "hydro", "wind", "solar", "biomass", "geothermal",
];
const CARBON_FREE_FUELS: FuelType[] = [...RENEWABLE_FUELS, "nuclear"];

export interface EmissionsComputation {
  gco2_per_kwh: number;
  fossil_only_gco2_per_kwh: number;
  factor_source: string;
  method: FactorSet;
  shares: {
    renewable_pct: number;
    carbon_free_pct: number;
    fossil_pct: number;
  };
}

/**
 * Compute grid-average emission intensity from a generation-mix snapshot.
 *
 * Ignores `imports` (they're assumed to carry their own upstream intensity —
 * compute per-neighbor in V2) and `storage` (net-zero assumption; real
 * accounting requires charge-time allocation).
 *
 * @param mwByFuel Map from canonical fuel type to MW produced in the interval.
 * @param method   Which factor set to apply. Defaults to IPCC AR6 lifecycle.
 */
export function computeEmissions(
  mwByFuel: Partial<Record<FuelType, number>>,
  method: FactorSet = "IPCC_AR6_lifecycle",
): EmissionsComputation {
  const factors = FACTOR_SETS[method];

  let weightedSum = 0;
  let fossilWeightedSum = 0;
  let generationTotal = 0;
  let fossilTotal = 0;
  let renewableTotal = 0;
  let carbonFreeTotal = 0;

  for (const fuel of Object.keys(mwByFuel) as FuelType[]) {
    const mw = Math.max(mwByFuel[fuel] ?? 0, 0);
    if (fuel === "imports" || fuel === "storage") continue;

    generationTotal += mw;
    weightedSum += mw * factors[fuel];

    if (FOSSIL_FUELS.includes(fuel)) {
      fossilTotal += mw;
      fossilWeightedSum += mw * factors[fuel];
    }
    if (RENEWABLE_FUELS.includes(fuel)) renewableTotal += mw;
    if (CARBON_FREE_FUELS.includes(fuel)) carbonFreeTotal += mw;
  }

  const gco2 = generationTotal > 0 ? weightedSum / generationTotal : 0;
  const fossilGco2 = fossilTotal > 0 ? fossilWeightedSum / fossilTotal : 0;

  return {
    gco2_per_kwh: round2(gco2),
    fossil_only_gco2_per_kwh: round2(fossilGco2),
    factor_source: SOURCE_URL[method],
    method,
    shares: {
      renewable_pct:  pct(renewableTotal, generationTotal),
      carbon_free_pct: pct(carbonFreeTotal, generationTotal),
      fossil_pct:     pct(fossilTotal, generationTotal),
    },
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function pct(part: number, total: number): number {
  return total > 0 ? round2((part / total) * 100) : 0;
}
