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
 * Builds a structured, complete financial context string of the portfolio for LLM prompting.
 *
 * @param {object} portfolio
 * @returns {string} Formatted JSON string of portfolio details
 */
function buildPortfolioPromptContext(portfolio) {
  if (!portfolio) return 'Nessun dato di portafoglio fornito.';

  const isAggregated = portfolio.isAggregated || portfolio.id === 'all';
  const holdings = (portfolio.metrics && portfolio.metrics.holdings) || [];
  const allocations = (portfolio.metrics && portfolio.metrics.allocations) || {};

  const totalVal = Number(portfolio.metrics?.totalValue ?? portfolio.totalValue ?? 0);
  const investedVal = Number(portfolio.metrics?.investedCapital ?? portfolio.investedCapital ?? 0);
  const cashVal = Number(portfolio.metrics?.currentCash ?? portfolio.currentCash ?? 0);
  const unrealizedPnlVal = Number(portfolio.metrics?.unrealizedPnl ?? 0);
  const realizedPnlVal = Number(portfolio.metrics?.realizedPnl ?? 0);
  const totalDivs = Number(portfolio.metrics?.totalDividends ?? 0);
  const unrealizedPct = investedVal > 0 ? (unrealizedPnlVal / investedVal) * 100 : 0;
  const cashPct = totalVal > 0 ? (cashVal / totalVal) * 100 : 0;

  const holdingsList = holdings.map(h => ({
    ticker: h.ticker,
    name: h.name || h.ticker,
    assetClass: h.type || h.asset_type || 'Altro',
    quantity: h.quantity,
    currentPrice: h.currentPrice ? `€ ${Number(h.currentPrice).toFixed(2)}` : 'N/D',
    averagePurchasePrice: h.averagePrice ? `€ ${Number(h.averagePrice).toFixed(2)}` : 'N/D',
    currentValue: h.currentValue ? `€ ${Math.round(h.currentValue).toLocaleString('it-IT')}` : 'N/D',
    weight: h.weight !== undefined ? `${Number(h.weight).toFixed(1)}%` : 'N/D',
    unrealizedGainLoss: h.unrealizedPnL !== undefined ? `€ ${Math.round(h.unrealizedPnL).toLocaleString('it-IT')}` : 'N/D',
    unrealizedGainLossPercent: h.unrealizedPnLPercent !== undefined ? `${Number(h.unrealizedPnLPercent).toFixed(1)}%` : 'N/D',
    sector: h.sector || 'Generale / N/D',
    region: h.region || 'Globale / N/D'
  }));

  const byClass = {};
  const rawClass = allocations.byAssetClass || allocations.byClass || {};
  for (const [k, v] of Object.entries(rawClass)) {
    byClass[k] = `${Number(v.percentage || v.weight || 0).toFixed(1)}% (€ ${Math.round(v.value || 0).toLocaleString('it-IT')})`;
  }

  const bySector = {};
  if (allocations.bySector) {
    for (const [k, v] of Object.entries(allocations.bySector)) {
      bySector[k] = `${Number(v.percentage || v.weight || 0).toFixed(1)}% (€ ${Math.round(v.value || 0).toLocaleString('it-IT')})`;
    }
  }

  const byRegion = {};
  if (allocations.byRegion) {
    for (const [k, v] of Object.entries(allocations.byRegion)) {
      byRegion[k] = `${Number(v.percentage || v.weight || 0).toFixed(1)}% (€ ${Math.round(v.value || 0).toLocaleString('it-IT')})`;
    }
  }

  return JSON.stringify({
    portfolioName: isAggregated ? 'Tutti i Portafogli (Patrimonio Globale Aggregato)' : (portfolio.name || 'Portafoglio'),
    currency: portfolio.currency || 'EUR',
    totalValueEur: `€ ${Math.round(totalVal).toLocaleString('it-IT')}`,
    investedCapitalEur: `€ ${Math.round(investedVal).toLocaleString('it-IT')}`,
    cashAvailableEur: `€ ${Math.round(cashVal).toLocaleString('it-IT')} (${cashPct.toFixed(1)}%)`,
    unrealizedGainLossEur: `€ ${Math.round(unrealizedPnlVal).toLocaleString('it-IT')} (${unrealizedPct >= 0 ? '+' : ''}${unrealizedPct.toFixed(1)}%)`,
    realizedGainLossEur: `€ ${Math.round(realizedPnlVal).toLocaleString('it-IT')}`,
    dividendsCollectedEur: `€ ${Math.round(totalDivs).toLocaleString('it-IT')}`,
    allocationByAssetClass: byClass,
    allocationBySector: bySector,
    allocationByRegion: byRegion,
    totalHoldingsCount: holdingsList.length,
    holdings: holdingsList
  }, null, 2);
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
  const totalVal = Number(p.totalValue || p.metrics?.totalValue) || 0.0;
  const cashVal = Number(p.currentCash || p.metrics?.currentCash) || 0.0;
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
  const classCount = allocations.byClass ? Object.keys(allocations.byClass).length : (allocations.byAssetClass ? Object.keys(allocations.byAssetClass).length : 0);

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
 * Heuristic fallback for chat responses when no LLM API key is present.
 */
function generateHeuristicChatResponse(portfolio, userPrompt) {
  const holdings = (portfolio.metrics && portfolio.metrics.holdings) || [];
  const totalVal = Number(portfolio.metrics?.totalValue ?? portfolio.totalValue ?? 0);
  const cashVal = Number(portfolio.metrics?.currentCash ?? portfolio.currentCash ?? 0);
  const unrealizedPnlVal = Number(portfolio.metrics?.unrealizedPnl ?? 0);
  const realizedPnlVal = Number(portfolio.metrics?.realizedPnl ?? 0);
  const cashPct = totalVal > 0 ? (cashVal / totalVal) * 100 : 0;

  const top3 = [...holdings].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 3);
  const top3Summary = top3.map(h => `- **${h.ticker}** (${h.name || h.ticker}): peso ${(h.weight || 0).toFixed(1)}%, valore € ${Math.round(h.currentValue || 0).toLocaleString('it-IT')}`).join('\n');

  return `### 📊 Analisi Quantitativa Locale del Portafoglio

> **Nota:** Non è stata configurata una chiave API attiva per **Google Gemini Pro**. Questa risposta è stata elaborata dal motore analitico locale di FolioTrack. Per attivare le risposte avanzate di Gemini AI Pro, inserisci la tua **Google Gemini API Key** (creabile gratuitamente su [Google AI Studio](https://aistudio.google.com/app/apikey)) cliccando sul pulsante **Gemini API** in alto.

---

#### 🔍 Sintesi Dati del Portafoglio:
- **Valore Totale:** € ${Math.round(totalVal).toLocaleString('it-IT')}
- **Liquidità Disponibile:** € ${Math.round(cashVal).toLocaleString('it-IT')} (${cashPct.toFixed(1)}%)
- **P&L Non Realizzato:** € ${Math.round(unrealizedPnlVal).toLocaleString('it-IT')}
- **P&L Realizzato (Posizioni Chiuse):** € ${Math.round(realizedPnlVal).toLocaleString('it-IT')}
- **Numero Posizioni Aperte:** ${holdings.length}

#### 🏆 Principali Asset per Peso:
${top3Summary || 'Nessun asset presente.'}

#### 💡 Risposta in merito alla tua richiesta (*"${userPrompt.slice(0, 100)}..."*):
1. **Ribilanciamento & Controllo Pesi:** Con ${holdings.length} posizioni, verifica periodicamente se la concentrazione sui primi titoli supera il 35-40% del totale.
2. **Gestione Liquidità:** La liquidità attuale (${cashPct.toFixed(1)}%) ${cashPct > 10 ? 'costituisce un buon cuscinetto per cogliere storni di mercato o coprire spese impreviste.' : 'è piuttosto contenuta; valuta se mantenere un piccolo margine di sicurezza.'}
3. **Efficienza Fiscale:** Monitora le posizioni in guadagno rispetto ad eventuali minusvalenze pregresse prima di effettuare prese di profitto.

*Le analisi fornite hanno scopo illustrativo ed educativo e non costituiscono consulenza finanziaria personalizzata.*`;
}

/**
 * Generates AI portfolio assessment using Google Gemini, OpenAI, or compatible endpoints.
 *
 * @param {object} params
 * @param {object} params.portfolio Complete portfolio object with metrics
 * @param {string} [params.provider='auto'] 'gemini' | 'openai' | 'openrouter' | 'auto' | 'heuristic'
 * @param {string} [params.model] e.g. 'gemini-1.5-pro', 'gemini-2.0-flash', 'gpt-4o'
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
    if (activeKey) {
      selectedProvider = 'gemini';
    } else if (process.env.GEMINI_API_KEY) {
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
      usedModel = model || 'gemini-1.5-pro';
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

/**
 * Interactive Free-Form Conversational Chat with Google Gemini Pro / LLM.
 * Feeds full real-time portfolio metrics, weights, and holdings to answer custom user prompts.
 *
 * @param {object} params
 * @param {object} params.portfolio Portfolio data (single or aggregated)
 * @param {string} params.userPrompt Custom prompt or question from user
 * @param {Array<{role: string, content: string}>} [params.chatHistory=[]] Conversation turns
 * @param {string} [params.model='gemini-1.5-pro']
 * @param {string} [params.apiKey]
 * @param {string} [params.provider='gemini']
 * @param {string} [params.customBaseUrl]
 * @returns {Promise<{provider: string, model: string, message: string}>}
 */
async function chatWithPortfolioAi({
  portfolio,
  userPrompt,
  chatHistory = [],
  model = 'gemini-1.5-pro',
  apiKey = null,
  provider = 'gemini',
  customBaseUrl = null
}) {
  if (!portfolio) throw new Error('Dati portafoglio mancanti.');
  if (!userPrompt || !userPrompt.trim()) throw new Error('Prompt utente mancante.');

  let selectedProvider = provider || 'gemini';
  let activeKey = apiKey;

  if (selectedProvider === 'auto') {
    if (activeKey) {
      selectedProvider = 'gemini';
    } else if (process.env.GEMINI_API_KEY) {
      selectedProvider = 'gemini';
      activeKey = process.env.GEMINI_API_KEY;
    } else if (process.env.OPENAI_API_KEY) {
      selectedProvider = 'openai';
      activeKey = process.env.OPENAI_API_KEY;
    } else {
      selectedProvider = 'heuristic';
    }
  }

  // If heuristic or no key provided
  if (selectedProvider === 'heuristic' || !activeKey) {
    return {
      provider: 'heuristic',
      model: 'motore-quantitativo-locale',
      message: generateHeuristicChatResponse(portfolio, userPrompt)
    };
  }

  const portfolioContext = buildPortfolioPromptContext(portfolio);

  const systemInstructionText = `Sei "FolioTrack AI Advisor", un Senior Portfolio Manager e Wealth Strategist quantitativo e indipendente di livello istituzionale.
Hai accesso completo in tempo reale ai dati contabili e all'asset allocation del portafoglio dell'utente forniti di seguito in formato JSON.

DATI COMPLETI DEL PORTAFOGLIO:
${portfolioContext}

LINEE GUIDA PER LE RISPOSTE:
1. Rispondi con grande rigore analitico, chiarezza finanziaria, professionalità ed eleganza espositiva in lingua ITALIANA.
2. Fai riferimento concreto e specifico ai dati reali del portafoglio dell'utente (ticker effettivi, pesi percentuali, controvalore, liquidità disponibile, guadagni/perdite realizzati e non realizzati, allocazione geografica e settoriale).
3. Se l'utente chiede suggerimenti di ribilanciamento, acquisti o disinvestimenti, motiva le scelte analizzando rischio, rendimento atteso, diversificazione, decorrelazione ed efficienza fiscale (tassazione, minusvalenze compensabili).
4. Utilizza una formattazione Markdown strutturata ed elegante:
   - Titoli gerarchici con ## e ###
   - Elenchi puntati chiari e compatti
   - Grassetto per concetti chiave, ticker e valori numerici rilevanti
   - Tabelle Markdown comparative se utili per confrontare pesi target vs attuali o simulazioni
5. Termina con un brevissimo disclaimer etico standard ("Le analisi fornite hanno scopo illustrativo ed educativo e non costituiscono consulenza finanziaria personalizzata").`;

  if (selectedProvider === 'gemini') {
    const usedModel = model || 'gemini-1.5-pro';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${usedModel}:generateContent?key=${activeKey}`;

    // Format chat history for Gemini API: must alternate user / model
    const contents = [];

    if (Array.isArray(chatHistory) && chatHistory.length > 0) {
      for (const msg of chatHistory) {
        if (!msg.content || !msg.content.trim()) continue;
        const role = (msg.role === 'assistant' || msg.role === 'model') ? 'model' : 'user';
        if (contents.length > 0 && contents[contents.length - 1].role === role) {
          contents[contents.length - 1].parts[0].text += `\n\n${msg.content.trim()}`;
        } else {
          contents.push({
            role,
            parts: [{ text: msg.content.trim() }]
          });
        }
      }
    }

    // Ensure the conversation starts with user if it started with model
    if (contents.length > 0 && contents[0].role === 'model') {
      contents.shift();
    }

    // Append latest user message
    if (contents.length > 0 && contents[contents.length - 1].role === 'user') {
      contents[contents.length - 1].parts[0].text += `\n\n${userPrompt.trim()}`;
    } else {
      contents.push({
        role: 'user',
        parts: [{ text: userPrompt.trim() }]
      });
    }

    const payload = {
      systemInstruction: {
        parts: [{ text: systemInstructionText }]
      },
      contents,
      generationConfig: {
        temperature: 0.35,
        maxOutputTokens: 8192
      }
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      const errText = await res.text();
      let parsedErr = errText;
      try {
        const jsonErr = JSON.parse(errText);
        if (jsonErr.error && jsonErr.error.message) {
          parsedErr = jsonErr.error.message;
        }
      } catch (_) {}

      if (res.status === 400 && (parsedErr.includes('API_KEY_INVALID') || parsedErr.includes('API key not valid'))) {
        throw new Error('La chiave API Google Gemini inserita non è valida. Verifica la chiave su Google AI Studio (aistudio.google.com/app/apikey).');
      }
      if (res.status === 429 || parsedErr.includes('RESOURCE_EXHAUSTED')) {
        throw new Error('Limite di frequenza o quota Google Gemini superata (Resource Exhausted). Attendi un minuto prima di inviare un\'altra richiesta.');
      }
      throw new Error(`Google Gemini Error (${res.status}): ${parsedErr}`);
    }

    const data = await res.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Nessuna risposta ricevuta da Google Gemini.';

    return {
      provider: 'gemini',
      model: usedModel,
      message: replyText
    };
  }

  // OpenAI / OpenRouter / Custom compatible API
  const usedModel = model || (selectedProvider === 'openrouter' ? 'meta-llama/llama-3.3-70b-instruct' : 'gpt-4o');
  const baseUrl = customBaseUrl || (selectedProvider === 'openrouter' ? 'https://openrouter.ai/api/v1' : 'https://api.openai.com/v1');

  const messages = [
    { role: 'system', content: systemInstructionText }
  ];

  if (Array.isArray(chatHistory)) {
    for (const msg of chatHistory) {
      if (!msg.content || !msg.content.trim()) continue;
      messages.push({
        role: (msg.role === 'model' || msg.role === 'assistant') ? 'assistant' : 'user',
        content: msg.content.trim()
      });
    }
  }

  messages.push({ role: 'user', content: userPrompt.trim() });

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${activeKey}`
    },
    body: JSON.stringify({
      model: usedModel,
      messages,
      temperature: 0.35
    })
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`${selectedProvider} Error (${res.status}): ${errText}`);
  }

  const data = await res.json();
  const replyText = data.choices?.[0]?.message?.content || 'Nessuna risposta ricevuta.';

  return {
    provider: selectedProvider,
    model: usedModel,
    message: replyText
  };
}

module.exports = {
  fetchTavilyNews,
  buildPortfolioPromptContext,
  generateHeuristicAnalysis,
  generateHeuristicChatResponse,
  generatePortfolioAiAssessment,
  chatWithPortfolioAi
};
