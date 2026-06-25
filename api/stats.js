const fs = require('fs');
const path = require('path');

const WC_JSON_URL =
  'https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json';

// Nombres que openfootball usa diferente al DATA del predictor
const TEAM_ALIASES = {
  'USA': 'United States',
  'Bosnia & Herzegovina': 'Bosnia-Herzegovina',
};

function normalizeTeam(name) {
  return TEAM_ALIASES[name] || name;
}

// Extrae el objeto DATA del index.html (fuente única de verdad)
let _cache = null;
function getAppData() {
  if (_cache) return _cache;
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const marker = 'const DATA = ';
  const markerIdx = html.indexOf(marker);
  if (markerIdx === -1) throw new Error('DATA no encontrado en index.html');
  let i = html.indexOf('{', markerIdx);
  const start = i;
  let depth = 0;
  while (i < html.length) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') { depth--; if (depth === 0) break; }
    i++;
  }
  _cache = JSON.parse(html.slice(start, i + 1));
  return _cache;
}

// Algoritmo Poisson + Elo (mismo que el frontend)
function factorial(n) { let r = 1; for (let k = 2; k <= n; k++) r *= k; return r; }
function poisson(l, k) { return Math.exp(-l) * Math.pow(l, k) / factorial(k); }

function calcPrediction(DATA, homeTeam, awayTeam) {
  const hs = DATA.wcStats?.[homeTeam] || DATA.stats?.[homeTeam];
  const as_ = DATA.wcStats?.[awayTeam] || DATA.stats?.[awayTeam];
  if (!hs || !as_) return null;

  const g = (DATA.avg_home + DATA.avg_away) / 2;
  let lh = g * (hs.avg_s / g) * (as_.avg_c / g);
  let la = g * (as_.avg_s / g) * (hs.avg_c / g);

  const eloH = DATA.elo?.[homeTeam] || 1500;
  const eloA = DATA.elo?.[awayTeam] || 1500;
  // neutral=true porque todos los partidos del Mundial son en campo neutral
  const eloDiff = eloH - eloA;
  const sqrtF = Math.sqrt(Math.pow(10, eloDiff / 1000));
  lh = Math.max(0.1, Math.min(lh * sqrtF, 6));
  la = Math.max(0.1, Math.min(la / sqrtF, 6));

  const scores = [];
  let winH = 0, draw = 0, winA = 0;
  for (let h = 0; h < 9; h++) {
    for (let a = 0; a < 9; a++) {
      const p = poisson(lh, h) * poisson(la, a);
      scores.push({ h, a, p });
      if (h > a) winH += p;
      else if (h === a) draw += p;
      else winA += p;
    }
  }
  scores.sort((a, b) => b.p - a.p);

  return {
    home_win_pct: Math.round(winH * 100),
    draw_pct: Math.round(draw * 100),
    away_win_pct: Math.round(winA * 100),
    predicted_score: `${scores[0].h}-${scores[0].a}`,
    top_scores: scores.slice(0, 5).map(s => ({
      score: `${s.h}-${s.a}`,
      pct: parseFloat((s.p * 100).toFixed(1))
    })),
    elo_home: eloH,
    elo_away: eloA,
    elo_diff: Math.round(eloDiff)
  };
}

function todayISO() {
  const d = new Date();
  const offset = -5; // Colombia UTC-5
  const utc = d.getTime() + d.getTimezoneOffset() * 60000;
  const col = new Date(utc + offset * 3600000);
  return `${col.getFullYear()}-${String(col.getMonth() + 1).padStart(2, '0')}-${String(col.getDate()).padStart(2, '0')}`;
}

function toColombiaTime(raw) {
  if (!raw) return '';
  const m = raw.match(/(\d{1,2}):(\d{2})\s*UTC([+-]\d+)/);
  if (!m) return raw.replace(/\s*UTC.*/, '');
  let h = parseInt(m[1]), min = parseInt(m[2]), off = parseInt(m[3]);
  h = ((h - off - 5) % 24 + 24) % 24;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

module.exports = async (req, res) => {
  // Auth requerida: ?key=TU_SECRETO o header Authorization: Bearer TU_SECRETO
  // Define STATS_SECRET en las env vars de Vercel
  const SECRET = process.env.STATS_SECRET;
  if (!SECRET) {
    return res.status(500).json({ error: 'STATS_SECRET no configurado en variables de entorno' });
  }
  const keyParam = req.query.key;
  const bearer = (req.headers.authorization || '').replace('Bearer ', '');
  if (keyParam !== SECRET && bearer !== SECRET) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  try {
    const DATA = getAppData();
    const wcResponse = await fetch(WC_JSON_URL);
    if (!wcResponse.ok) throw new Error(`Error al obtener partidos: ${wcResponse.status}`);
    const wcData = await wcResponse.json();

    // Permite pasar ?date=YYYY-MM-DD para consultar otro día
    const date = req.query.date || todayISO();
    const todayMatches = (wcData.matches || []).filter(m => m.date === date);

    const partidos = todayMatches.map(m => {
      const pred = calcPrediction(DATA, normalizeTeam(m.team1), normalizeTeam(m.team2));
      const result = {
        local: m.team1,
        visitante: m.team2,
        hora_colombia: toColombiaTime(m.time),
        grupo: (m.group || m.round || '').replace('Group ', 'Grupo '),
        estadio: m.stadium || '',
        ciudad: m.city || '',
        tiene_prediccion: !!pred
      };
      if (pred) Object.assign(result, { prediccion: pred });
      return result;
    });

    return res.status(200).json({
      ok: true,
      fecha: date,
      total: partidos.length,
      partidos
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
