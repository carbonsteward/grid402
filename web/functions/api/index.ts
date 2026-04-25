// Pages Function: GET /api
// Service metadata + endpoint catalog.

export const onRequestGet: PagesFunction = async () => {
  const body = {
    service: "Grid402",
    version: "0.1.0-demo",
    description: "Pay-per-call electricity grid data — sub-hourly mix, prices, emissions.",
    note: "This Pages Function exposes free demo data. The x402-gated production API runs separately.",
    endpoints: {
      "GET /api": "this catalog",
      "GET /api/mix/{ISO}/live": "live generation mix + carbon intensity",
      "GET /api/health": "service health",
    },
    supported_isos: ["CAISO", "ERCOT", "KPX", "AEMO"],
    upcoming: ["GB-NESO", "ENTSO-E", "NYISO", "PJM"],
    docs: "https://grid402.climatebrain.xyz/docs",
    repo: "https://github.com/carbonsteward/grid402",
  };
  return new Response(JSON.stringify(body, null, 2), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=300",
    },
  });
};
