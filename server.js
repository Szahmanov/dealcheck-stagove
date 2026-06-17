import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const GROQ_API_KEY   = process.env.GROQ_API_KEY;
const SERPER_API_KEY = process.env.SERPER_API_KEY;
const MODEL = 'llama-3.3-70b-versatile';

// ── Step 1: Search Google via Serper ──────────────────────────────────────────
async function searchWeb(query) {
  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-KEY': SERPER_API_KEY
    },
    body: JSON.stringify({ q: query, gl: 'bg', hl: 'bg', num: 8 })
  });
  if (!res.ok) throw new Error('Serper search failed: ' + res.status);
  const data = await res.json();

  // Extract useful snippets
  const results = (data.organic || []).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet
  }));
  return results;
}

// ── Step 2: Ask Groq to analyse search results ────────────────────────────────
async function analyseWithGroq(product, searchResults) {
  const searchContext = searchResults
    .map((r, i) => `[${i+1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`)
    .join('\n\n');

  const system = `You are DealCheck — a Bulgarian price intelligence agent.
You receive real search results and must extract prices, analyse the deal, and respond with ONLY valid JSON.

IMPORTANT: Base your answer ONLY on the search results provided. Do not invent prices.

Response format (JSON only, no markdown):
{
  "verdict": "buy" | "wait" | "skip",
  "product_name": "full product name as found in results",
  "lowest_price": "XXXX лв." or "N/A if not found",
  "price_range": "XXXX – XXXX лв." or "N/A",
  "deal_score": 0-100,
  "reason": "2-3 sentences explaining verdict based on the data",
  "market_context": "2-3 sentences about price situation, competitors, timing",
  "recommendation": "1-2 sentences: what should the buyer do right now",
  "sources": [
    { "name": "site name", "url": "exact URL from results" }
  ]
}

Verdict rules:
- "buy": deal_score 70-100 → price at/near market low, good time to buy
- "wait": deal_score 40-69 → average price, or sale/new model likely soon
- "skip": deal_score 0-39 → overpriced, poor quality, or clearly better alternative
- If no prices found: verdict "wait", explain in reason, deal_score 40
- Always write in Bulgarian
- Use лв. (BGN) as primary currency`;

  const userMsg = `Product: ${product}

Search results:
${searchContext}

Analyse these results and give a price verdict for this product in Bulgaria.`;

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: userMsg }
      ]
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('Groq error:', err);
    throw new Error('Groq API грешка');
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content || '';
  content = content.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) parsed = JSON.parse(match[0]);
    else throw new Error('Неуспешен парсинг на отговора');
  }

  if (!['buy','wait','skip'].includes(parsed.verdict)) parsed.verdict = 'wait';
  return parsed;
}

// ── API route ─────────────────────────────────────────────────────────────────
app.post('/api/check', async (req, res) => {
  const { query } = req.body;
  if (!query || typeof query !== 'string' || query.length > 200) {
    return res.status(400).json({ error: 'Невалидна заявка' });
  }
  if (!GROQ_API_KEY)   return res.status(500).json({ error: 'GROQ_API_KEY не е конфигуриран' });
  if (!SERPER_API_KEY) return res.status(500).json({ error: 'SERPER_API_KEY не е конфигуриран' });

  try {
    // Two parallel searches: pazaruvaj + general BG market
    const [pazaruvajResults, generalResults] = await Promise.all([
      searchWeb(`${query} site:pazaruvaj.com цена`),
      searchWeb(`${query} цена купи българия онлайн магазин`)
    ]);

    const allResults = [...pazaruvajResults, ...generalResults]
      .filter((r, i, arr) => arr.findIndex(x => x.url === r.url) === i) // dedupe
      .slice(0, 10);

    const verdict = await analyseWithGroq(query, allResults);
    res.json(verdict);
  } catch (e) {
    console.error('Check error:', e);
    res.status(500).json({ error: e.message || 'Вътрешна грешка — опитай отново' });
  }
});

// Catch-all for SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DealCheck running on port ${PORT}`));
