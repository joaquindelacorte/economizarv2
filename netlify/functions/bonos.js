// Netlify Function: proxy de Yahoo Finance para bonos soberanos
// GET /.netlify/functions/bonos?ticker=^TNX&range=6mo

const VALID_TICKERS = new Set(['^TNX', 'GD30.BA', 'AL30.BA']);
const VALID_RANGES  = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']);

exports.handler = async function (event) {
    const CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }

    const { ticker = '^TNX', range = '6mo' } = event.queryStringParameters || {};

    if (!VALID_TICKERS.has(ticker)) {
        return {
            statusCode: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Ticker no válido' }),
        };
    }

    if (!VALID_RANGES.has(range)) {
        return {
            statusCode: 400,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Rango no válido' }),
        };
    }

    const encodedTicker = encodeURIComponent(ticker);
    const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodedTicker}?interval=1d&range=${range}&includePrePost=false`;

    try {
        const res = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'application/json, text/plain, */*',
                'Accept-Language': 'en-US,en;q=0.9',
            },
        });

        if (!res.ok) throw new Error(`Yahoo Finance HTTP ${res.status}`);

        const data = await res.json();

        if (data.chart?.error) throw new Error(data.chart.error.description || 'Yahoo Finance error');
        if (!data.chart?.result?.[0]) throw new Error('Sin datos devueltos por Yahoo Finance');

        const result = data.chart.result[0];
        const meta   = result.meta || {};
        const ts     = result.timestamp || [];
        const closes = result.indicators?.quote?.[0]?.close || [];

        const series = ts
            .map((t, i) => ({
                date:  new Date(t * 1000).toISOString().split('T')[0],
                close: closes[i] ?? null,
            }))
            .filter(d => d.close !== null);

        const price          = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
        const previousClose  = meta.previousClose ?? meta.chartPreviousClose ?? null;
        const changePercent  = meta.regularMarketChangePercent
            ?? (price !== null && previousClose !== null && previousClose !== 0
                ? ((price - previousClose) / previousClose) * 100
                : null);

        return {
            statusCode: 200,
            headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
            body: JSON.stringify({
                ticker,
                price,
                previousClose,
                changePercent,
                fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
                fiftyTwoWeekLow:  meta.fiftyTwoWeekLow  ?? null,
                currency:         meta.currency          ?? null,
                exchangeName:     meta.exchangeName      ?? null,
                series,
            }),
        };

    } catch (err) {
        return {
            statusCode: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: err.message }),
        };
    }
};
