/**
 * 日课 · 云端代理（Cloudflare Worker）
 *
 * 两个能力，用哪个配哪个，互不依赖：
 *   1) /v1/chat/completions  —— 转发给大模型，API Key 只留在 Worker 里，前端拿不到
 *   2) /api/sync             —— 把日记存在 KV 上，实现手机与电脑互通
 *
 * 需要的环境变量（在 Cloudflare 控制台 → Settings → Variables 里配）：
 *   APP_TOKEN   你自定的访问口令，前端的 API Key 填它
 *   UPSTREAM    上游接口基址，如 https://api.deepseek.com 或 https://open.bigmodel.cn/api/paas/v4
 *   UPSTREAM_KEY 上游的真实 API Key
 *
 * 可选：绑定一个 KV namespace，变量名必须为 RIKKE，用于 /api/sync。
 * 不绑也能跑，只是同步接口会提示未开启。
 */

const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8' };

function json(body, status) {
  return new Response(JSON.stringify(body), { status: status || 200, headers: JSON_HEAD });
}
function withCors(res) {
  const h = new Headers(res.headers);
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS');
  h.set('Access-Control-Allow-Headers', 'Content-Type,Authorization,X-App-Token');
  return new Response(res.body, { status: res.status, headers: h });
}
function cors(res) { return withCors(res); }

export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const url = new URL(req.url);

    /* 鉴权：前端在 API Key 里填的就是 APP_TOKEN */
    if (!env.APP_TOKEN) return cors(json({ error: '服务端未配置 APP_TOKEN' }, 500));
    const token = req.headers.get('x-app-token') || (req.headers.get('authorization') || '').replace(/^Bearer\s+/, '');
    if (token !== env.APP_TOKEN) return cors(json({ error: '口令不对' }, 401));

    if (url.pathname === '/api/sync') {
      if (req.method === 'GET') {
        if (!env.RIKKE) return cors(json({ error: '未绑定 KV，同步功能未开启' }, 501));
        const raw = await env.RIKKE.get('data');
        if (!raw) return cors(json({ entries: [], tombs: [], ts: 0 }));
        let d;
        try { d = JSON.parse(raw); } catch (e) { return cors(json({ entries: [], tombs: [], ts: 0 })); }
        /* 老版本存的数据没有 tombs 字段，补上，前端就不用做兼容判断了 */
        return cors(json({ entries: Array.isArray(d.entries) ? d.entries : [],
                           tombs: Array.isArray(d.tombs) ? d.tombs : [],
                           ts: d.ts || 0 }));
      }
      if (req.method === 'PUT') {
        if (!env.RIKKE) return cors(json({ error: '未绑定 KV，同步功能未开启' }, 501));
        let body;
        try { body = await req.json(); } catch (e) { return cors(json({ error: '请求体不是合法 JSON' }, 400)); }
        if (!body || !Array.isArray(body.entries)) return cors(json({ error: '缺少 entries 数组' }, 400));
        if (body.entries.length > 5000) return cors(json({ error: '条目过多，拒绝写入' }, 413));
        const tombs = Array.isArray(body.tombs) ? body.tombs.slice(-2000) : [];
        /* 云端墓碑只增不减，取并集：防止 A 设备删了、B 设备又把旧的推回来 */
        let merged = tombs;
        const prev = await env.RIKKE.get('data');
        if (prev) {
          try {
            const pd = JSON.parse(prev);
            if (Array.isArray(pd.tombs)) {
              const set = new Set(tombs);
              pd.tombs.forEach(id => { if (typeof id === 'string') set.add(id) });
              merged = Array.from(set).slice(-2000);
            }
          } catch (e) { /* 旧数据坏了就当没有，用本次的 */ }
        }
        const payload = { entries: body.entries, tombs: merged, ts: Date.now() };
        await env.RIKKE.put('data', JSON.stringify(payload));
        return cors(json({ ok: true, ts: payload.ts, count: body.entries.length }));
      }
      return cors(json({ error: '不支持的方法' }, 405));
    }

    /* 转发大模型请求 */
    if (/\/chat\/completions$/.test(url.pathname)) {
      if (!env.UPSTREAM || !env.UPSTREAM_KEY) return cors(json({ error: '服务端未配置 UPSTREAM' }, 500));
      let body;
      try { body = await req.json(); } catch (e) { return cors(json({ error: '请求体不是合法 JSON' }, 400)); }
      if (!body || !body.model) return cors(json({ error: '缺少 model 字段' }, 400));
      const base = String(env.UPSTREAM).replace(/\/+$/, '');
      const upstreamUrl = /\/chat\/completions$/.test(base) ? base : base + '/chat/completions';
      try {
        const r = await fetch(upstreamUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + env.UPSTREAM_KEY
          },
          body: JSON.stringify(body)
        });
        return cors(new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json' } }));
      } catch (e) {
        return cors(json({ error: '上游请求失败：' + e.message }, 502));
      }
    }

    return cors(json({ error: '没有这个接口：' + url.pathname }, 404));
  }
};
