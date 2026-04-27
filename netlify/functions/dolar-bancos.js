// Netlify Function: proxy de CriptoYa para cotizaciones bancarias
// GET /api/dolar-bancos                         → JSON completo
// GET /api/dolar-bancos?banco=bancogalicia&campo=totalask → número plano (para IMPORTDATA / WEBSERVICE)

exports.handler = async function (event) {
    const CORS = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 204, headers: CORS, body: '' };
    }

    try {
        const res = await fetch('https://criptoya.com/api/bancostodos');
        if (!res.ok) throw new Error('CriptoYa HTTP ' + res.status);
        const data = await res.json();

        const { banco, campo } = event.queryStringParameters || {};

        // Si se piden banco + campo → devolver solo el número como texto plano
        // Esto es lo que consume IMPORTDATA (Sheets) y WEBSERVICE (Excel)
        if (banco && campo) {
            const bank = data[banco];
            if (!bank) {
                return { statusCode: 404, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: 'N/D' };
            }
            const value = bank[campo] ?? bank[campo.replace('total', '')] ?? null;
            if (value == null) {
                return { statusCode: 404, headers: { ...CORS, 'Content-Type': 'text/plain' }, body: 'N/D' };
            }
            return {
                statusCode: 200,
                headers: { ...CORS, 'Content-Type': 'text/plain' },
                body: String(value),
            };
        }

        // Sin parámetros → JSON completo (para uso general)
        return {
            statusCode: 200,
            headers: { ...CORS, 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
        };

    } catch (err) {
        return {
            statusCode: 502,
            headers: { ...CORS, 'Content-Type': 'text/plain' },
            body: 'Error: ' + err.message,
        };
    }
};
