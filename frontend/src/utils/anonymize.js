// Client for the PII anonymization tool (functions/rag/anonymize.js +
// index.js's handleAnonymize). Mirrors the post() pattern already used by
// utils/reportStudio.js.
async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const anonymizeText = (text) => post('/server/rag/anonymize/text', { text });
export const revealText = (mapId, text) =>
  post('/server/rag/anonymize/reveal', { mapId, text }).then((d) => d.text);
