export const onRequestGet: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true, ts: new Date().toISOString() }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
};
