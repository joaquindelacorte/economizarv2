// Netlify Function: datos de bonos soberanos
// Intenta Yahoo Finance (crumb auth); fallback a Stooq si falla.
// GET /.netlify/functions/bonos?ticker=^TNX&range=6mo

const VALID_TICKERS = new Set(['^TNX', 'GD30.BA', 'AL30.BA']);
const VALID_RANGES  = new Set(['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y']);

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

// ── Yahoo Finance (crumb-based auth) ────────────────────────────

async function getYahooSession() {
    const jar = new Map();

    function parseCookies(res) {
        const list = typeof res.headers.getSetCookie === 'function'
            ? res.headers.getSetCookie()
            : (res.headers.get('set-cookie') || '').split(/,(?=[^ ])/).filter(Boolean);
        for (const c of list) {
            const [pair] = c.split(';');
            const eq = pair.indexOf('=');
            if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
        }
    }

    const cookieStr = () => [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');

    // Step 1 – acquire session cookies from Yahoo's consent endpoint
    const r1 = await fetch('https://fc.yahoo.com/', {
        headers: {
            'User-Agent': UA,
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
        },
        redirect: 'follow',
    });
    parseCookies(r1);

    // Step 2 – get crumb
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
        headers: {
            'User-Agent': UA,
            'Cookie': cookieStr(),
            'Accept': 'text/plain, */*',
        },
    });
    if (!r2.ok) throw new Error(`Crumb HTTP ${r2.status}`);
    const crumb = (await r2.text()).trim();
    if (!crumb || crumb.length > 30 || crumb.includes('<')) throw new Error('Crumb inválido recibido');

    return { crumb, cookie: cookieStr() };
}

async function fetchYahoo(ticker, range) {
    const { crumb, cookie } = await getYahooSession();
    const enc = encodeURIComponent(ticker);
    const url  = `https://query2.finance.yahoo.com/v8/finance/chart/${enc}?interval=1d&range=${range}&crumb=${encodeURIComponent(crumb)}`;

    const res = await fetch(url, {
        headers: {
            'User-Agent': UA,
            'Cookie': cookie,
            'Accept': 'application/json',
        },
    });
    if (!res.ok) throw new Error(`Yahoo chart HTTP ${res.status}`);

    const data = await res.json();
    if (data.chart?.error) throw new Error(data.chart.error.description || 'Yahoo devolvió error');
    const result = data.chart?.result?.[0];
    if (!result) throw new Error('Yahoo no devolvió resultados');
    return result;
}

function processYahooResult(ticker, result) {
    const meta   = result.meta   || {};
    const ts     = result.timestamp || [];
    const closes = result.indicators?.quote?.[0]?.close || [];

    const series = ts
        .map((t, i) => ({ date: new Date(t * 1000).toISOString().split('T')[0], close: closes[i] ?? null }))
        .filter(d => d.close !== null);

    const price         = meta.regularMarketPrice ?? meta.chartPreviousClose ?? null;
    const previousClose = meta.previousClose      ?? meta.chartPreviousClose ?? null;
    const changePercent = meta.regularMarketChangePercent
        ?? (price != null && previousClose && previousClose !== 0
            ? ((price - previousClose) / previousClose) * 100 : null);

    return {
        ticker,
        price,
        previousClose,
        changePercent,
        fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh ?? null,
        fiftyTwoWeekLow:  meta.fiftyTwoWeekLow  ?? null,
        currency:    meta.currency    ?? null,
        exchangeName: meta.exchangeName ?? null,
        series,
        source: 'yahoo',
    };
}

// ── Stooq fallback ───────────────────────────────────────────────

const STOOQ_SYM = { '^TNX': '^tnx', 'GD30.BA': 'gd30.ba', 'AL30.BA': 'al30.ba' };

function daysAgo(n) {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return d.toISOString().split('T')[0].replace(/-/g, '');
}

const RANGE_DAYS = { '1d': 5, '5d': 10, '1mo': 35, '3mo': 95, '6mo': 185, '1y': 370, '2y': 735 };

async function fetchStooq(ticker, range) {
    const sym = STOOQ_SYM[ticker];
    if (!sym) throw new Error('Ticker no soportado en Stooq');

    const d1 = daysAgo(RANGE_DAYS[range] || 185);
    const d2 = new Date().toISOString().split('T')[0].replace(/-/g, '');
    const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&d1=${d1}&d2=${d2}&i=d`;

    const res = await fetch(url, {
        headers: { 'User-Agent': UA, 'Accept': 'text/csv, text/plain, */*' },
    });
    if (!res.ok) throw new Error(`Stooq HTTP ${res.status}`);

    const csv = await res.text();
    if (!csv || csv.toLowerCase().includes('no data') || csv.trim().split('\n').length < 2) {
        throw new Error('Sin datos en Stooq para este ticker');
    }

    // CSV: Date,Open,High,Low,Close,Volume  (newest first on stooq)
    const rows = csv.trim().split('\n').slice(1)
        .map(line => {
            const cols = line.split(',');
            const val  = parseFloat(cols[4]);
            return { date: (cols[0] || '').trim(), close: isNaN(val) ? null : val };
        })
        .filter(r => r.date && r.close !== null)
        .reverse(); // oldest first

    if (rows.length === 0) throw new Error('CSV vacío de Stooq');

    const last   = rows[rows.length - 1];
    const prev   = rows.length > 1 ? rows[rows.length - 2] : null;
    const closes = rows.map(r => r.close);
    // 52-week high/low from available window (up to 252 trading days)
    const window252 = closes.slice(-252);

    return {
        ticker,
        price:            last.close,
        previousClose:    prev?.close ?? null,
        changePercent:    prev?.close ? ((last.close - prev.close) / prev.close) * 100 : null,
        fiftyTwoWeekHigh: Math.max(...window252),
        fiftyTwoWeekLow:  Math.min(...window252),
        currency:         ticker === '^TNX' ? 'USD' : 'ARS',
        exchangeName:     ticker === '^TNX' ? 'CBOE' : 'BYMA',
        series: rows,
        source: 'stooq',
    };
}

// ── Handler ──────────────────────────────────────────────────────

exports.handler = async function (event) {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }

    const { ticker = '^TNX', range = '6mo' } = event.queryStringParameters || {};

    if (!VALID_TICKERS.has(ticker)) {
        return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Ticker no válido' }) };
    }
    if (!VALID_RANGES.has(range)) {
        return { statusCode: 400, headers: { ...CORS, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Rango no válido' }) };
    }

    let data = null;
    const errors = [];

    // 1. Try Yahoo Finance with crumb auth
    try {
        const result = await fetchYahoo(ticker, range);
        data = processYahooResult(ticker, result);
    } catch (e) {
        errors.push(`Yahoo: ${e.message}`);
    }

    // 2. Fallback: Stooq
    if (!data) {
        try {
            data = await fetchStooq(ticker, range);
        } catch (e) {
            errors.push(`Stooq: ${e.message}`);
        }
    }

    if (!data) {
        return {
            statusCode: 502,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: `No se pudo obtener datos. Intentos: ${errors.join(' | ')}` }),
        };
    }

    return {
        statusCode: 200,
        headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
        body: JSON.stringify(data),
    };
};
