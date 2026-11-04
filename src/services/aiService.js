/**
 * Multi-Provider Financial AI Advisor for FolioTrack
 * Supports Google Gemini, OpenAI, OpenRouter, Qwen, Requesty, AIMLAPI,
 * with optional Tavily Search API enrichment and a quantitative heuristic fallback.
 */

const { getSetting } = require('../db');

/**
 * Searches the web for relevant market/macro news on top portfolio holdings via Tavily Search API.
 *
 * @param {string[]} tickers
 * @param {string} [apiKey=null]
 * @returns {Promise<string>}
 */
async function fetchTavilyNews(tickers = [], apiKey = null) {
  const key = apiKey || process.env.TAVILY_API_KEY;
  if (!key || tickers.length === 0) return '';

  try {
    const query = `Latest stock market financial news for ${tickers.slice(0, 5).join(', ')}`;
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: key,
        query,
        search_depth: 'basic',
        max_results: 3
      })
    });

    if (!res.ok) return '';
    const data = await res.json();
    if (!data.results || data.results.length === 0) return '';

    return data.results.map(r => `- ${r.title}: ${r.content ? r.content.slice(0, 180) : ''}...`).join('\n');
  } catch (err) {
    console.warn('[Tavily] Error fetching news:', err.message);
    return '';
  }
}

/**
 * Quantitative Heuristic Fallback Analyzer.
 * Produces structured analysis based on actual portfolio metrics when no LLM API key is present.
 *
 * @param {object} p Portfolio data with metrics and holdings
 * @returns {object}
 */
function generateHeuristicAnalysis(p) {
  const holdings = (p.metrics && p.metrics.holdings) || [];
  const allocations = (p.metrics && p.metrics.allocations) || {};
  const totalVal = Number(p.totalValue) || 0.0;
  const cashVal = Number(p.currentCash) || 0.0;
  const cashWeight = totalVal > 0 ? (cashVal / totalVal) * 100.0 : 0.0;

  // Concentration: HHI (Herfindahl-Hirschman Index)
  let hhi = 0;
  for (const h of holdings) {
    const w = h.weight || 0;
    hhi += (w * w);
  }

  // Top 3 weight
  const sortedHoldings = [...holdings].sort((a, b) => (b.weight || 0) - (a.weight || 0));
  const top3Weight = sortedHoldings.slice(0, 3).reduce((sum, h) => sum + (h.weight || 0), 0);

  // Sector count
  const sectorCount = allocations.bySector ? Object.keys(allocations.bySector).length : 0;
  const classCount = allocations.byClass ? Object.keys(allocations.byClass).length : 0;

  // Calculate scores (1-100)
  let diversificationScore = Math.min(95, Math.max(20, Math.round(100 - (hhi / 100) + (sectorCount * 3) + (classCount * 4))));
  if (holdings.length <= 2) diversificationScore = Math.min(diversificationScore, 40);

  let riskScore = 50;
  const equityWeight = (allocations.byClass && allocations.byClass['EQUITY']) ? allocations.byClass['EQUITY'].percentage : 0;
  const cryptoWeight = (allocations.byClass && allocations.byClass['CRYPTO']) ? allocations.byClass['CRYPTO'].percentage : 0;
  const bondWeight = (allocations.byClass && allocations.byClass['BOND']) ? allocations.byClass['BOND'].percentage : 0;

  riskScore = Math.round(20 + (equityWeight * 0.5) + (cryptoWeight * 0.9) - (bondWeight * 0.3) - (cashWeight * 0.2));
  riskScore = Math.min(95, Math.max(15, riskScore));

  let assetAllocationQuality = 'Buona';
  if (diversificationScore >= 80 && top3Weight < 45) assetAllocationQuality = 'Eccellente';
  else if (diversificationScore < 45 || top3Weight > 70) assetAllocationQuality = 'Sbilanciata';
  else if (diversificationScore < 60) assetAllocationQuality = 'Migliorabile';

  const strengths = [];
  const weaknesses = [];
  const tacticalRecommendations = [];
  const strategicRecommendations = [];

  if (cashWeight > 10) {
    strengths.push(`Liquidità disponibile al ${cashWeight.toFixed(1)}% (cuscinetto di sicurezza per cogliere opportunità di mercato).`);
  } else {
    strengths.push('Capitale quasi interamente investito con minimo cash drag.');
    weaknesses.push(`Liquidità disponibile molto bassa (${cashWeight.toFixed(1)}%), ridotto margine per ribilanciamenti.`);
  }

  if (sectorCount >= 5) {
    strengths.push(`Buona diversificazione settoriale distribuita su ${sectorCount} comparti GICS differenti.`);
  } else {
    weaknesses.push(`Esposizione concentrata su soli ${sectorCount} settori GICS.`);
  }

  if (top3Weight > 50) {
    weaknesses.push(`Forte concentrazione sui primi 3 titoli (${top3Weight.toFixed(1)}% del controvalore complessivo).`);
    tacticalRecommendations.push(`Valuta prese di profitto parziali sui titoli più sovrappesati per ridurre il rischio specifico.`);
  } else {
    strengths.push(`Esposizione ben ripartita tra i singoli asset (i top 3 pesano il ${top3Weight.toFixed(1)}%).`);
  }

  if (bondWeight === 0 && equityWeight > 70) {
    strategicRecommendations.push('Valuta l\'inserimento di una quota obbligazionaria (BTP o ETF governativi) per smussare la volatilità nei drawdown.');
  }

  tacticalRecommendations.push('Pianifica un ribilanciamento semestrale verso i pesi target previsti per evitare derive di portafoglio.');
  strategicRecommendations.push('Mantieni la disciplina di accumulo periodico (PAC) per beneficiare del Dollar-Cost Averaging.');

  return {
    provider: 'Quantitative Heuristic Engine',
    model: 'Wealthfolio Quant v1.0',
    riskScore,
    diversificationScore,
    assetAllocationQuality,
    strengths,
    weaknesses,
    tacticalRecommendations,
    strategicRecommendations,
    marketContextSummary: 'Analisi calcolata in base alle posizioni correnti, concentrazione HHI e pesi dimensionali di bilancio.'
  };
}

/**
 * Generates AI portfolio assessment using Google Gemini, OpenAI, or compatible endpoints.
 *
 * @param {object} params
 * @param {object} params.portfolio Complete portfolio object with metrics
 * @param {string} [params.provider='auto'] 'gemini' | 'openai' | 'openrouter' | 'auto' | 'heuristic'
 * @param {string} [params.model] e.g. 'gemini-2.0-flash', 'gpt-4o'
 * @param {string} [params.apiKey]
 * @param {string} [params.tavilyKey]
 * @param {string} [params.customBaseUrl]
 * @returns {Promise<object>}
 */
async function generatePortfolioAiAssessment({
  portfolio,
  provider = 'auto',
  model = null,
  apiKey = null,
  tavilyKey = null,
  customBaseUrl = null
}) {
  if (!portfolio) throw new Error('Dati portafoglio mancanti.');

  const holdings = (portfolio.metrics && portfolio.metrics.holdings) || [];
  const topTickers = holdings.slice(0, 5).map(h => h.ticker);

  // Determine active provider and credentials
  let selectedProvider = provider;
  let activeKey = apiKey;

  if (selectedProvider === 'auto') {
    if (process.env.GEMINI_API_KEY) {
      selectedProvider = 'gemini';
      activeKey = process.env.GEMINI_API_KEY;
    } else if (process.env.OPENAI_API_KEY) {
      selectedProvider = 'openai';
      activeKey = process.env.OPENAI_API_KEY;
    } else if (process.env.OPENROUTER_API_KEY) {
      selectedProvider = 'openrouter';
      activeKey = process.env.OPENROUTER_API_KEY;
    } else {
      selectedProvider = 'heuristic';
    }
  }

  if (selectedProvider === 'heuristic' || !activeKey) {
    return generateHeuristicAnalysis(portfolio);
  }

  // Fetch optional market context via Tavily
  const marketNews = await fetchTavilyNews(topTickers, tavilyKey);

  // Build Structured Prompt
  const promptData = {
    portfolioName: portfolio.name,
    totalValue: portfolio.totalValue,
    currentCash: portfolio.currentCash,
    cashPercent: portfolio.totalValue > 0 ? (portfolio.currentCash / portfolio.totalValue) * 100 : 0,
    holdings: holdings.map(h => ({
      ticker: h.ticker,
      name: h.name,
      type: h.type,
      sector: h.sector,
      region: h.region,
      weight: (h.weight || 0).toFixed(2) + '%',
      unrealizedPnLPercent: (h.unrealizedPnLPercent || 0).toFixed(2) + '%'
    })),
    allocations: portfolio.metrics && portfolio.metrics.allocations,
    recentNewsContext: marketNews || 'Nessuna notizia rilevante disponibile.'
  };

  const systemInstruction = `Sei un Senior Quantitative Financial Advisor e Portfolio Manager.
Analizza in modo rigoroso, obiettivo ed elegante l'asset allocation del portafoglio fornito.
Devi restituire ESCLUSIVAMENTE un oggetto JSON valido (senza blocchi di codice markdown, backticks o testo prima/dopo) con la seguente struttura esatta:
{
  "riskScore": (numero intero da 1 a 100, dove 100 è rischio massimo),
  "diversificationScore": (numero intero da 1 a 100, dove 100 è diversificazione perfetta),
  "assetAllocationQuality": "Eccellente" | "Buona" | "Migliorabile" | "Sbilanciata",
  "strengths": [ "3-5 punti di forza concreti" ],
  "weaknesses": [ "3-5 criticità, concentrazioni o rischi specifici" ],
  "tacticalRecommendations": [ "3-5 suggerimenti tattici a breve termine" ],
  "strategicRecommendations": [ "3-5 raccomandazioni strategiche a lungo termine" ],
  "marketContextSummary": "sintesi del contesto macroeconomico e settoriale"
}`;

  try {
    let rawText = '';
    let usedModel = model;

    if (selectedProvider === 'gemini') {
      usedModel = model || 'gemini-2.0-flash';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${usedModel}:generateContent?key=${activeKey}`;

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            parts: [{ text: `${systemInstruction}\n\nDati Portafoglio:\n${JSON.stringify(promptData, null, 2)}` }]
          }],
          generationConfig: {
            responseMimeType: 'application/json',
            temperature: 0.2
          }
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Gemini API Error (${res.status}): ${errText}`);
      }

      const data = await res.json();
      rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    } else {
      // OpenAI / OpenRouter / Custom compatible API
      usedModel = model || (selectedProvider === 'openrouter' ? 'meta-llama/llama-3.3-70b-instruct' : 'gpt-4o-mini');
      const baseUrl = customBaseUrl || (selectedProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${activeKey}`
        },
        body: JSON.stringify({
          model: usedModel,
          messages: [
            { role: 'system', content: systemInstruction },
            { role: 'user', content: `Dati Portafoglio:\n${JSON.stringify(promptData, null, 2)}` }
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2
        })
      });

      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`${selectedProvider} Error (${res.status}): ${errText}`);
      }

      const data = await res.json();
      rawText = data.choices?.[0]?.message?.content || '';
    }

    // Clean JSON text
    const cleanJson = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleanJson);

    return {
      provider: selectedProvider,
      model: usedModel,
      ...parsed
    };
  } catch (err) {
    console.warn('[AI Advisor] LLM call failed, falling back to heuristic engine:', err.message);
    const fallback = generateHeuristicAnalysis(portfolio);
    fallback.fallbackNotice = `Analisi euristica quantitativa (Chiamata ${selectedProvider} fallita: ${err.message})`;
    return fallback;
  }
}

module.exports = {
  fetchTavilyNews,
  generateHeuristicAnalysis,
  generatePortfolioAiAssessment
};

