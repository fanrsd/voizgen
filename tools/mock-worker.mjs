// Mock VoizGen worker + static server — HANYA untuk mengembangkan/menguji web/ tanpa Colab.
// Jalankan: bun tools/mock-worker.mjs      (UI: http://localhost:5500, API: http://localhost:8765)
// Mengimplementasikan kontrak yang sama dengan voizgenWorker.ipynb dan mengembalikan WAV sintetis.

// MOCK_ENGINE=voxcpm2 meniru worker teks-bebas (VoxCPM2); default meniru OmniVoice.
const TOKEN = process.env.VOIZGEN_TOKEN ?? 'dev';
const ENGINE = process.env.MOCK_ENGINE ?? 'omnivoice';
const FREEFORM = ENGINE === 'voxcpm2';
const SR = FREEFORM ? 48000 : 24000;

// Nama tampilan berbeda per mesin: OmniVoice memakai lang_map (`Standard Arabic`,
// plus bahasa daerah), VoxCPM2 memakai daftar 30 bahasanya sendiri.
const OMNI_LANGUAGES = ['Banjar', 'Betawi', 'Buginese', 'Chinese', 'English', 'French',
  'Indonesian', 'Japanese', 'Javanese', 'Malay', 'Papuan Malay', 'Standard Arabic',
  'Swahili', 'Vietnamese'];
const VOX_LANGUAGES = ['Arabic', 'Chinese', 'English', 'French', 'German', 'Indonesian',
  'Japanese', 'Korean', 'Malay', 'Spanish', 'Thai', 'Vietnamese'];
const LANGUAGES = FREEFORM ? VOX_LANGUAGES : OMNI_LANGUAGES;

const OMNI_ATTRIBUTES = ['american accent', 'british accent', 'child', 'elderly', 'female',
  'high pitch', 'low pitch', 'male', 'middle-aged', 'moderate pitch', 'teenager',
  'very high pitch', 'very low pitch', 'whisper', 'young adult', '四川话', '女', '男'];
const OMNI_TAGS = ['laughter', 'sigh', 'confirmation-en', 'question-en', 'question-ah',
  'question-oh', 'question-ei', 'question-yi', 'surprise-ah', 'surprise-oh', 'surprise-wa',
  'surprise-yo', 'dissatisfaction-hnn'];
const INSTRUCT_EXAMPLES = ['energetic, enthusiastic', 'shouting, urgent', 'calm and soothing',
  'whispering, mysterious', 'cheerful, fast paced', 'an elderly man, low pitch'];

const INSTRUCT_ATTRIBUTES = FREEFORM ? [] : OMNI_ATTRIBUTES;
const NONVERBAL_TAGS = FREEFORM ? [] : OMNI_TAGS;
const DIRECTIVES = ['pause', 'pause:1.5', 'slow', 'fast', 'whisper', 'normal'];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': 'X-Elapsed, X-Segments, X-Notes',
  'Access-Control-Max-Age': '86400',
};

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

function wav(seconds, hz) {
  const n = Math.round(seconds * SR);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const env = Math.min(1, t * 8) * Math.min(1, (seconds - t) * 8);
    const s = Math.sin(2 * Math.PI * (hz + 12 * Math.sin(6 * Math.PI * t)) * t) * 0.35
      + Math.sin(4 * Math.PI * hz * t) * 0.12;
    buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, s * env)) * 32767), 44 + i * 2);
  }
  return buf;
}

Bun.serve({
  port: 8765,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

    const supplied = (req.headers.get('authorization') ?? '').replace(/^Bearer\s*/, '').trim();
    if (supplied !== TOKEN) return json({ detail: 'Token tidak valid.' }, 401);

    if (pathname === '/api/health') {
      return json({
        ok: true, engine: FREEFORM ? 'voxcpm2' : 'omnivoice',
        device: 'cuda:0 (mock)', gpu: true, dtype: FREEFORM ? 'bfloat16' : 'float16',
        model: FREEFORM ? 'mock/VoxCPM2' : 'mock/OmniVoice', sampling_rate: SR, languages: LANGUAGES,
        instruct_attributes: INSTRUCT_ATTRIBUTES, instruct_freeform: FREEFORM,
        instruct_examples: FREEFORM ? INSTRUCT_EXAMPLES : [],
        nonverbal_tags: NONVERBAL_TAGS, directives: DIRECTIVES, busy: false,
        defaults: { num_step: FREEFORM ? 10 : 32, guidance_scale: 2.0 },
      });
    }

    if (pathname === '/api/generate' && req.method === 'POST') {
      let fd;
      try { fd = await req.formData(); }
      catch (err) { return json({ detail: 'Body multipart tidak dapat dibaca: ' + err.message }, 400); }
      const raw = String(fd.get('text') ?? '').trim();
      const mode = String(fd.get('mode') ?? 'design');
      if (!raw) return json({ detail: 'Naskah teks kosong.' }, 400);
      if (mode === 'clone' && !fd.get('ref_audio')) {
        return json({ detail: 'Audio referensi wajib untuk voice clone.' }, 400);
      }

      const instruct = String(fd.get('instruct') ?? '');
      const bad = FREEFORM ? [] : instruct.split(/\s*[,，]\s*/).map(s => s.trim())
        .filter(s => s && !INSTRUCT_ATTRIBUTES.includes(s.toLowerCase()));
      if (bad.length) {
        return json({ detail: `Unsupported instruct items found in ${instruct}: ${bad.map(b => `'${b}' (unsupported)`).join(', ')}` }, 400);
      }

      // tiru segmentasi worker: pisah pada arahan, buang tag tak dikenal
      const dropped = [];
      for (const m of raw.matchAll(/\[([^\]]*)\]/g)) {
        const tag = m[1].trim().toLowerCase();
        const known = NONVERBAL_TAGS.includes(tag) || /^(pause|jeda)(\s*[:=]\s*[0-9.]+)?$/.test(tag)
          || ['slow', 'fast', 'lambat', 'cepat', 'whisper', 'berbisik', 'normal', 'reset'].includes(tag)
          || /^[A-Z0-9 ]+$/.test(m[1].trim());
        if (!known) dropped.push(m[1].trim());
      }
      const body_text = raw.replace(/\[[^\]]*\]/g, ' ');
      const segments = Math.max(1, (raw.match(/\[(pause|jeda)(\s*[:=]\s*[0-9.]+)?\]/gi) || []).length + 1);
      console.log(`[mock] ${mode} | ${body_text.length} chars | instruct="${instruct}" | ` +
        `segmen=${segments} dibuang=${dropped.length} steps=${fd.get('num_step')} speed=${fd.get('speed')}`);

      const started = performance.now();
      const seconds = Math.max(1, Math.min(12, body_text.length / 14));
      const body = wav(seconds, instruct.includes('female') || instruct.includes('child') ? 320 : 165);
      await Bun.sleep(600); // meniru latensi inferensi
      const headers = {
        ...CORS, 'Content-Type': 'audio/wav',
        'X-Elapsed': ((performance.now() - started) / 1000).toFixed(2),
        'X-Segments': String(segments),
      };
      if (dropped.length) {
        headers['X-Notes'] = encodeURIComponent(
          'tag tidak didukung diabaikan: ' + [...new Set(dropped)].map(d => `[${d}]`).join(', '));
      }
      return new Response(body, { headers });
    }

    return json({ detail: 'Not found' }, 404);
  },
});

Bun.serve({
  port: 5500,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const file = Bun.file('web' + (pathname === '/' ? '/index.html' : pathname));
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
  },
});

console.log('mock worker  -> http://localhost:8765  (token: ' + TOKEN + ')');
console.log('voizgen ui   -> http://localhost:5500');
