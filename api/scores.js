// Vercel serverless function — Endless Swell high-score leaderboard.
// Lightweight: a single Redis sorted set (no schema, no DB tables).
//   GET  /api/scores            -> { scores: [{ initials, score, member }] }  (top 5)
//   POST /api/scores {initials, score} -> { scores: [...], member }
//
// Requires two env vars on Vercel (Upstash Redis, free tier):
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const KEY = 'esw:leaderboard';
const TOP = 5; // how many to return
const MAX_KEEP = 50; // cap stored entries so the set can't grow forever
const MAX_SCORE = 100000; // sanity clamp against tampered submissions

async function redis(commands) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) throw new Error('Redis not configured');
  const isPipeline = Array.isArray(commands[0]);
  const res = await fetch(url + (isPipeline ? '/pipeline' : ''), {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + token,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error('Redis error ' + res.status);
  return res.json();
}

function parseZrev(arr) {
  // arr: [member, score, member, score, ...] (highest first)
  const out = [];
  for (let i = 0; i < arr.length; i += 2) {
    const member = String(arr[i]);
    const score = Number(arr[i + 1]);
    out.push({ initials: member.split('|')[0], score, member });
  }
  return out;
}

module.exports = async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const r = await redis(['ZREVRANGE', KEY, 0, TOP - 1, 'WITHSCORES']);
      return res.status(200).json({ scores: parseZrev(r.result || []) });
    }

    if (req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) { body = {}; }
      }
      body = body || {};

      let initials = String(body.initials || '')
        .toUpperCase()
        .replace(/[^A-Z0-9 .!?&-]/g, '')
        .slice(0, 3);
      let score = Math.floor(Number(body.score));

      if (!initials.trim().length || !Number.isFinite(score) || score < 0) {
        return res.status(400).json({ error: 'Invalid entry' });
      }
      while (initials.length < 3) initials += ' ';
      score = Math.min(score, MAX_SCORE);

      const member = initials + '|' + Date.now() + '|' + Math.random().toString(36).slice(2, 7);
      const r = await redis([
        ['ZADD', KEY, score, member],
        ['ZREMRANGEBYRANK', KEY, 0, -(MAX_KEEP + 1)],
        ['ZREVRANGE', KEY, 0, TOP - 1, 'WITHSCORES'],
      ]);
      const last = r[r.length - 1];
      return res.status(200).json({ scores: parseZrev((last && last.result) || []), member });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: 'Server error' });
  }
};
