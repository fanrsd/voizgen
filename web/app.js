'use strict';

/* =========================================================
   VoizGen Studio — frontend untuk VoizGen Colab worker
   Kontrak API worker:
     GET  {base}/api/health    -> { ok, device, gpu, dtype, sampling_rate, languages[], busy }
     POST {base}/api/generate  -> audio/wav  (multipart/form-data, header X-Elapsed)
   Auth: Authorization: Bearer <token>
   ========================================================= */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/* Label Indonesia -> prompt instruct yang dimengerti model. */
const INSTRUCT_MAP = {
  'Pria': 'male', 'Wanita': 'female',
  'Anak-anak': 'child', 'Remaja': 'teenager', 'Dewasa': 'young adult', 'Lansia': 'elderly',
  'Sangat Rendah': 'very low pitch', 'Rendah': 'low pitch', 'Sedang': 'moderate pitch',
  'Tinggi': 'high pitch', 'Sangat Tinggi': 'very high pitch',
  'Berbisik': 'whisper',
  'Amerika': 'american accent', 'Australia': 'australian accent', 'Inggris (UK)': 'british accent',
  'Cina': 'chinese accent', 'Kanada': 'canadian accent', 'India': 'indian accent',
  'Korea': 'korean accent', 'Portugal': 'portuguese accent', 'Rusia': 'russian accent',
  'Jepang': 'japanese accent',
  'Henan': '河南话', 'Shaanxi': '陕西话', 'Sichuan': '四川话', 'Guizhou': '贵州话',
  'Yunnan': '云南话', 'Guilin': '桂林话', 'Jinan': '济南话', 'Shijiazhuang': '石家庄话',
  'Gansu': '甘肃话', 'Ningxia': '宁夏话', 'Qingdao': '青岛话', 'Timur Laut': '东北话',
};

const CATEGORIES = {
  'Gender': ['Otomatis', 'Pria', 'Wanita'],
  'Usia': ['Otomatis', 'Anak-anak', 'Remaja', 'Dewasa', 'Lansia'],
  'Pitch': ['Otomatis', 'Sangat Rendah', 'Rendah', 'Sedang', 'Tinggi', 'Sangat Tinggi'],
  'Gaya': ['Otomatis', 'Berbisik'],
  'Aksen Inggris': ['Otomatis', 'Amerika', 'Australia', 'Inggris (UK)', 'Cina', 'Kanada',
    'India', 'Korea', 'Portugal', 'Rusia', 'Jepang'],
  'Dialek Mandarin': ['Otomatis', 'Henan', 'Shaanxi', 'Sichuan', 'Guizhou', 'Yunnan', 'Guilin',
    'Jinan', 'Shijiazhuang', 'Gansu', 'Ningxia', 'Qingdao', 'Timur Laut'],
};

const LS = { url: 'voizgen.url', token: 'voizgen.token', seenWhatsNew: 'voizgen.seen.arahan' };
const HISTORY_MAX = 8;

const state = {
  /* 'direct'  = browser bicara langsung ke tunnel worker (URL + token di browser)
     'gateway' = web app dilayani VoizGen Gateway; browser hanya tahu kode akses */
  mode: 'direct',
  base: localStorage.getItem(LS.url) || '',
  token: localStorage.getItem(LS.token) || '',
  health: null,
  busy: false,
  history: [],
  notebookUrls: {},
  engine: '',
  instructAttributes: [],
  instructExamples: [],
  instructFreeform: false,
  nonverbalTags: [],
  directives: [],
};

/* Satu-satunya tempat yang tahu perbedaan kedua mode. */
const isGateway = () => state.mode === 'gateway';
const endpoint = path => (isGateway() ? path : state.base + path);
const authHeaders = () => (isGateway() ? {} : { Authorization: 'Bearer ' + state.token });

/* =============== pengaturan lanjutan (dirender 2x) =============== */

function advMarkup(p) {
  return `
  <div class="adv-grid">
    <div class="adv-col">
      <label class="field"><span class="field-label">Durasi (detik)</span>
        <input id="${p}-du" type="number" min="0" step="0.5" placeholder="Otomatis"></label>
      <label class="field"><span class="field-label">Kecepatan · <b class="range-out" data-out="${p}-sp">1.00</b></span>
        <input id="${p}-sp" type="range" min="0.5" max="1.5" step="0.05" value="1"></label>
      <label class="field"><span class="field-label">Inference Steps · <b class="range-out" data-out="${p}-ns">32</b></span>
        <input id="${p}-ns" type="range" min="4" max="64" step="1" value="32"></label>
      <label class="field"><span class="field-label">Guidance Scale (CFG) · <b class="range-out" data-out="${p}-gs">2.00</b></span>
        <input id="${p}-gs" type="range" min="0" max="4" step="0.1" value="2"></label>
    </div>
    <div class="adv-col">
      <label class="check"><input id="${p}-dn" type="checkbox" checked> Denoise audio</label>
      <label class="check"><input id="${p}-pp" type="checkbox" checked> Preprocess teks</label>
      <label class="check"><input id="${p}-po" type="checkbox" checked> Postprocess hening</label>
    </div>
  </div>`;
}

function readAdv(p) {
  const num = (id, fb) => {
    const v = parseFloat($(`#${p}-${id}`).value);
    return Number.isFinite(v) ? v : fb;
  };
  return {
    duration: num('du', 0),
    speed: num('sp', 1),
    num_step: num('ns', 32),
    guidance_scale: num('gs', 2),
    denoise: $(`#${p}-dn`).checked,
    preprocess_prompt: $(`#${p}-pp`).checked,
    postprocess_output: $(`#${p}-po`).checked,
  };
}

/* Tiap mesin punya titik kerja sendiri: OmniVoice 32 langkah difusi, VoxCPM2 10.
   Memakai 32 di VoxCPM2 berarti 3x lebih lambat tanpa alasan, jadi slider ikut
   worker — kecuali slidernya sudah pernah digeser sendiri oleh pengguna. */
function applyWorkerDefaults(defaults) {
  const map = { num_step: 'ns', guidance_scale: 'gs' };
  for (const [key, suffix] of Object.entries(map)) {
    const value = defaults?.[key];
    if (!Number.isFinite(value)) continue;
    for (const p of ['vc', 'vd']) {
      const el = $(`#${p}-${suffix}`);
      if (!el || el.dataset.touched === '1') continue;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dataset.touched = '';  // masih mengikuti worker
    }
  }
}

/* =============== koneksi =============== */

function setStatus(kind, text, detail) {
  const cls = { ok: 'pill-ok', bad: 'pill-bad', wait: 'pill-wait' }[kind] || 'pill-idle';
  for (const pill of $$('[data-status]')) pill.className = 'pill ' + cls;
  for (const label of $$('[data-status-text]')) label.textContent = text;
  if (detail !== undefined) {
    $('[data-device]').textContent = detail;
    $('[data-device-short]').textContent = kind === 'ok' ? detail : '';
  }
}

function showCfgError(msg) {
  const el = $('#cfg-error');
  el.hidden = !msg;
  el.textContent = msg || '';
}

let lastFocus = null;

function openModal() {
  lastFocus = document.activeElement;
  $('#modal').hidden = false;
  const first = $$('#modal input').find(el => el.offsetParent);
  if (first) first.focus();
}

function closeModal() {
  $('#modal').hidden = true;
  if (lastFocus && lastFocus.isConnected) lastFocus.focus();
}

/* Fokus tidak boleh keluar dari modal selama terbuka. */
function trapFocus(e) {
  if (e.key !== 'Tab' || $('#modal').hidden) return;
  const stops = $$('input, button, summary, a[href]', $('#modal')).filter(el => !el.disabled && el.offsetParent);
  if (!stops.length) return;
  const first = stops[0];
  const last = stops[stops.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

/* Tiket = "voizgen_" + base64url("<url>|<token>") — dicetak sel Colab, satu kali tempel. */
const TICKET_PREFIX = 'voizgen_';

function decodeTicket(raw) {
  const s = raw.trim();
  if (!s.startsWith(TICKET_PREFIX)) return null;
  const b64 = s.slice(TICKET_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
  let plain;
  try {
    plain = atob(b64 + '='.repeat((4 - b64.length % 4) % 4));
  } catch {
    return null;
  }
  const sep = plain.indexOf('|');
  if (sep < 1) return null;
  const url = plain.slice(0, sep).trim().replace(/\/+$/, '');
  const token = plain.slice(sep + 1).trim();
  if (!/^https?:\/\/\S+$/.test(url) || !token) return null;
  return { url, token };
}

/* Kredensial aktif: tiket menang bila ada, kalau tidak pakai isian manual. */
function readCredentials() {
  const raw = $('#cfg-ticket').value.trim();
  if (raw) {
    const parsed = decodeTicket(raw);
    if (!parsed) return { error: 'Tiket tidak valid. Salin ulang baris TIKET KONEKSI dari output Colab, atau isi manual.' };
    return parsed;
  }
  const url = $('#cfg-url').value.trim().replace(/\/+$/, '');
  if (!url) return { error: 'Tempel Tiket Koneksi, atau isi Worker URL secara manual.' };
  return { url, token: $('#cfg-token').value.trim() };
}

async function connect({ silent = false } = {}) {
  const btn = $('#btn-connect');
  let base = state.base;
  let token = state.token;

  if (!isGateway()) {
    const cred = readCredentials();
    if (cred.error) { showCfgError(cred.error); return false; }
    base = cred.url;
    token = cred.token;
  }

  btn.disabled = true;
  $('.spin', btn).hidden = false;
  showCfgError('');
  setStatus('wait', 'Menghubungkan…', 'Memeriksa worker…');

  try {
    // Mode gateway: tukar kode akses jadi cookie sesi lebih dulu.
    if (isGateway() && !silent) {
      const code = $('#cfg-code').value.trim();
      if (!code) throw new Error('Kode akses belum diisi.');
      const ses = await fetch('/api/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
      });
      if (!ses.ok) {
        const body = await ses.json().catch(() => ({}));
        throw new Error(body.error || 'Gateway menolak kode (HTTP ' + ses.status + ').');
      }
    }

    const res = await fetch(isGateway() ? '/api/health' : base + '/api/health', {
      headers: isGateway() ? {} : { Authorization: 'Bearer ' + token },
    });
    if (res.status === 401) {
      throw new Error(isGateway()
        ? 'Sesi tidak aktif. Masukkan kode akses.'
        : 'Token salah — cek output sel Colab.');
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.detail || body.error || 'Worker menjawab HTTP ' + res.status);
    }

    const health = await res.json();
    state.health = health;
    if (!isGateway()) {
      state.base = base;
      state.token = token;
      localStorage.setItem(LS.url, base);
      localStorage.setItem(LS.token, token);
    }

    fillLanguages(health.languages || []);
    applyVocabulary(health);
    const device = health.gpu ? 'GPU · ' + health.device : 'CPU · lambat';
    setStatus('ok', health.gpu ? 'GPU aktif' : 'CPU', `${device} · ${health.dtype} · ${health.sampling_rate} Hz`);
    closeModal();
    return true;
  } catch (err) {
    // probe senyap saat boot bukan kegagalan: user belum pernah memasukkan kode
    if (silent) setStatus('idle', 'Belum terhubung', 'Masukkan kode akses untuk mulai.');
    else setStatus('bad', 'Terputus', 'Worker tidak merespons.');
    if (!silent) {
      showCfgError(err instanceof TypeError
        ? 'Tidak dapat menjangkau worker. Pastikan sel Colab masih berjalan dan URL benar.'
        : err.message);
    }
    return false;
  } finally {
    btn.disabled = false;
    $('.spin', btn).hidden = true;
  }
}

function fillLanguages(langs) {
  for (const sel of $$('select[data-lang]')) {
    const prev = sel.value;
    sel.innerHTML = '<option value="">Otomatis</option>' +
      langs.map(l => `<option>${l}</option>`).join('');
    if (prev) sel.value = prev;
  }
}

/* =============== kosakata dari worker =============== */

/* Worker mengirim daftar atribut instruct, tag non-verbal, dan arahan naskah
   yang benar-benar didukung. UI tidak boleh menebak: OmniVoice menolak item di
   luar kosakata dengan ValueError, sedangkan VoxCPM2 menerima teks bebas
   (`instruct_freeform`). Validasi dan panduan mengikuti apa kata worker. */
function applyVocabulary(health) {
  state.engine = health.engine || '';
  state.instructAttributes = health.instruct_attributes || [];
  state.instructExamples = health.instruct_examples || [];
  state.instructFreeform = health.instruct_freeform === true;
  state.nonverbalTags = health.nonverbal_tags || [];
  state.directives = health.directives || [];

  const suggestions = state.instructFreeform ? state.instructExamples : state.instructAttributes;
  $('#instruct-options').innerHTML = suggestions.map(s => `<option value="${s}"></option>`).join('');
  const placeholder = suggestions.length ? 'contoh: ' + suggestions.slice(0, 2).join(' / ') : '';
  for (const id of ['#vc-instruct', '#vd-instruct']) $(id).placeholder = placeholder;

  applyWorkerDefaults(health.defaults);
  renderTagbars();
  renderTemplates();
  renderGuide();
  validateInstruct('vc');
  validateInstruct('vd');
  setupNotebookShortcut();  // mesin berubah -> tombol notebook ikut berubah
}

/* Naskah contoh per mesin. Bukan sekadar beda tag: di OmniVoice seluruh gaya
   harus datang dari kosakata baku, sedangkan di VoxCPM2 justru dari deskripsi
   bebas — jadi templatenya ikut mengisi Gaya Suara agar bedanya kelihatan.

   `group` mengelompokkan chip; `lang` hanya diisi bila mesinnya memang memakai
   pilihan bahasa (VoxCPM2 mengabaikannya dan akan mengeluh di catatan hasil). */
const TEMPLATE_SETS = {
  // Belum terhubung: hanya arahan yang berlaku di kedua mesin, tanpa instruct.
  default: [
    {
      group: 'Indonesia',
      name: 'Narasi reflektif',
      text: 'Kita terlalu sibuk mengejar waktu, bekerja, berjuang, dan terus bergerak untuk kehidupan yang lebih baik. [pause]\n'
        + 'Dahulu, perjuangan dilakukan untuk merebut [slow] kemerdekaan. [normal] [pause:1.2] '
        + 'Hari ini, perjuangan kita mungkin berbeda: melalui pekerjaan, karya, dan langkah kecil setiap hari. [pause]\n'
        + 'Mungkin kita sudah merdeka, [pause] tapi perjuangan untuk hidup yang lebih layak bagi semua belum selesai.',
    },
    {
      group: 'Indonesia',
      name: 'Iklan singkat',
      text: 'Promo akhir pekan dimulai hari ini. [pause] '
        + '[fast] Diskon sampai tujuh puluh persen untuk semua kategori. [normal] [pause:0.8] '
        + 'Berlaku hanya sampai Minggu malam. Jangan sampai terlewat.',
    },
  ],

  omnivoice: [
    {
      group: 'Indonesia',
      name: 'Narasi reflektif',
      instruct: 'female, young adult, moderate pitch',
      lang: 'Indonesian',
      text: 'Kita terlalu sibuk mengejar waktu, bekerja, berjuang, dan terus bergerak untuk kehidupan yang lebih baik. [pause]\n'
        + 'Dahulu, perjuangan dilakukan untuk merebut [slow] kemerdekaan. [normal] [pause:1.2] '
        + 'Hari ini, perjuangan kita mungkin berbeda: melalui pekerjaan, karya, dan langkah kecil setiap hari. [pause]\n'
        + 'Mungkin kita sudah merdeka, [pause] tapi perjuangan untuk hidup yang lebih layak bagi semua belum selesai.',
    },
    {
      group: 'Indonesia',
      name: 'Iklan singkat',
      instruct: 'male, young adult, high pitch',
      lang: 'Indonesian',
      text: 'Promo akhir pekan dimulai hari ini. [pause] '
        + '[fast] Diskon sampai tujuh puluh persen untuk semua kategori. [normal] [pause:0.8] '
        + 'Berlaku hanya sampai Minggu malam. Jangan sampai terlewat.',
    },
    {
      group: 'Indonesia',
      name: 'Warta berita',
      instruct: 'male, middle-aged, low pitch',
      lang: 'Indonesian',
      text: 'Selamat malam, pemirsa. [pause] '
        + 'Cuaca ekstrem masih berpotensi terjadi di sebagian wilayah hingga akhir pekan. [pause:0.8] '
        + 'Warga diimbau menjauhi bantaran sungai dan memantau informasi resmi dari badan meteorologi.',
    },
    {
      group: 'Indonesia',
      name: 'Cerita + tag',
      instruct: 'female, teenager',
      lang: 'Indonesian',
      text: '[whisper] Jangan bilang siapa-siapa, ini rahasia kita. [pause:1.5] [normal] '
        + 'Ternyata dia sudah tahu sejak awal. [laughter] Semua orang di ruangan itu ikut tertawa. [sigh] '
        + 'Kadang, yang kita sembunyikan justru paling kelihatan.',
    },

    {
      group: 'Nusantara',
      name: 'Jawa',
      instruct: 'female, young adult',
      lang: 'Javanese',
      text: 'Sugeng enjing, sedaya. [pause] '
        + 'Swanten menika damelan mesin, nanging tetep kepenak dipun mirengaken. [pause:0.8] '
        + 'Mugi dinten menika lancar kagem panjenengan sedaya.',
    },
    {
      group: 'Nusantara',
      name: 'Betawi',
      instruct: 'male, young adult',
      lang: 'Betawi',
      text: 'Nih suara dibikin ame mesin, bukan orang beneran. [pause] '
        + 'Kaga percaya? [pause:0.8] Denger aje sendiri sampe abis.',
    },
    {
      group: 'Nusantara',
      name: 'Melayu Papua',
      instruct: 'male, young adult',
      lang: 'Papuan Malay',
      text: 'Halo semua, ko apa kabar? [pause] '
        + 'Suara ini dibikin pake mesin saja, bukan orang. [pause:0.8] '
        + 'Terima kasih su dengar sampe habis.',
    },
    {
      group: 'Nusantara',
      name: 'Melayu',
      instruct: 'female, young adult',
      lang: 'Malay',
      text: 'Selamat datang ke VoizGen. [pause] '
        + 'Suara ini dijana sepenuhnya oleh mesin, tanpa rakaman manusia. [pause:0.8] '
        + 'Terima kasih kerana mendengar.',
    },

    {
      group: 'Bahasa lain',
      name: 'Inggris + aksen',
      instruct: 'male, middle-aged, british accent',
      lang: 'English',
      text: 'Welcome to VoizGen. [pause] '
        + 'Accents only apply to English speech, so this is where you can actually hear them. [pause:0.8] '
        + 'The quick brown fox jumps over the lazy dog.',
    },
    {
      group: 'Bahasa lain',
      name: 'Mandarin + dialek',
      instruct: 'female, young adult, 四川话',
      lang: 'Chinese',
      text: '你好，欢迎使用 VoizGen。[pause] '
        + '方言只对中文有效，所以这段话用来试听。[pause:0.8] '
        + '今天天气不错，出门走走吧。',
    },
    {
      group: 'Bahasa lain',
      name: 'Jepang',
      instruct: 'female, young adult, high pitch',
      lang: 'Japanese',
      text: 'こんにちは、VoizGen へようこそ。[pause] '
        + '今日はいい天気ですね。[laughter] [pause:0.8] '
        + '最後まで聞いてくれてありがとう。',
    },
    {
      group: 'Bahasa lain',
      name: 'Arab',
      instruct: 'male, middle-aged',
      lang: 'Standard Arabic',
      text: 'مرحبا بكم في فويزجن. [pause] '
        + 'هذا الصوت تم إنشاؤه بالكامل بواسطة الحاسوب. [pause:0.8] '
        + 'شكرا لاستماعكم.',
    },
    {
      group: 'Bahasa lain',
      name: 'Swahili',
      instruct: 'female, young adult',
      lang: 'Swahili',
      text: 'Karibu VoizGen. [pause] '
        + 'Sauti hii imetengenezwa na kompyuta, si mtu halisi. [pause:0.8] '
        + 'Asante kwa kusikiliza.',
    },
  ],

  voxcpm2: [
    {
      group: 'Indonesia',
      name: 'Narasi hangat',
      instruct: 'a warm, calm female narrator in her thirties, gentle pace',
      text: 'Kita terlalu sibuk mengejar waktu, bekerja, berjuang, dan terus bergerak untuk kehidupan yang lebih baik. [pause]\n'
        + 'Dahulu, perjuangan dilakukan untuk merebut [slow] kemerdekaan. [normal] [pause:1.2] '
        + 'Hari ini, perjuangan kita mungkin berbeda: melalui pekerjaan, karya, dan langkah kecil setiap hari.',
    },
    {
      group: 'Indonesia',
      name: 'Iklan bersemangat',
      instruct: 'energetic, enthusiastic, excited',
      text: 'Promo akhir pekan dimulai hari ini! [pause] '
        + '[fast] Diskon sampai tujuh puluh persen untuk semua kategori. [normal] [pause:0.8] '
        + 'Berlaku hanya sampai Minggu malam. Jangan sampai terlewat!',
    },
    {
      group: 'Indonesia',
      name: 'Warta berita',
      instruct: 'a formal male news anchor, steady and authoritative',
      text: 'Selamat malam, pemirsa. [pause] '
        + 'Cuaca ekstrem masih berpotensi terjadi di sebagian wilayah hingga akhir pekan. [pause:0.8] '
        + 'Warga diimbau menjauhi bantaran sungai dan memantau informasi resmi dari badan meteorologi.',
    },

    {
      group: 'Emosi',
      name: 'Teriak mendesak',
      instruct: 'shouting, urgent, high energy',
      text: 'Awas, minggir dari situ sekarang! [pause:0.6] '
        + 'Jangan mendekat sebelum petugas datang! [pause] '
        + '[slow] Tolong, tetap tenang dan ikuti arahan.',
    },
    {
      group: 'Emosi',
      name: 'Bisikan misterius',
      instruct: 'whispering, mysterious, slow',
      text: '[whisper] Jangan bilang siapa-siapa, ini rahasia kita. [pause:1.5] [normal] '
        + 'Ternyata dia sudah tahu sejak awal, [pause] dan semua orang di ruangan itu ikut tertawa. [pause:0.8] '
        + '[slow] Kadang, yang kita sembunyikan justru paling kelihatan.',
    },
    {
      group: 'Emosi',
      name: 'Marah menahan',
      instruct: 'angry but restrained, clipped delivery, low pitch',
      text: 'Aku sudah bilang berkali-kali. [pause:0.6] '
        + 'Sekali lagi kamu terlambat, urusannya bukan denganku. [pause] '
        + '[slow] Sekarang duduk, dan jelaskan pelan-pelan.',
    },
    {
      group: 'Emosi',
      name: 'Sedih pelan',
      instruct: 'sad, soft, trembling voice, speaking slowly',
      text: 'Rumah ini terasa lebih besar sejak kamu pergi. [pause:1.2] '
        + 'Aku masih menyiapkan dua cangkir setiap pagi. [pause] '
        + 'Kebiasaan memang lebih lama sembuh daripada hati.',
    },

    {
      group: 'Bahasa kuat',
      name: 'Inggris',
      instruct: 'a calm male audiobook narrator, deep and measured',
      text: 'Chapter one. [pause] '
        + 'The harbour was quiet that morning, and the fog had not yet lifted from the water. [pause:0.8] '
        + 'No one noticed the small boat leaving the pier.',
    },
    {
      group: 'Bahasa kuat',
      name: 'Mandarin',
      instruct: 'a cheerful young female host, bright and lively',
      text: '大家好，欢迎收听今天的节目。[pause] '
        + '今天我们要聊一个很有意思的话题。[pause:0.8] '
        + '准备好了吗？我们现在就开始。',
    },
  ],
};

function templatesFor() {
  if (TEMPLATE_SETS[state.engine]) return TEMPLATE_SETS[state.engine];
  if (!state.health) return TEMPLATE_SETS.default;
  return state.instructFreeform ? TEMPLATE_SETS.voxcpm2 : TEMPLATE_SETS.omnivoice;
}

/* Buang atribut yang tidak ada di kosakata worker ini, supaya template tidak
   pernah mengisi field dengan item yang langsung ditolak validasi. */
function usableInstruct(instruct) {
  if (!instruct) return '';
  if (state.instructFreeform || !state.instructAttributes.length) return instruct;
  const valid = new Set(state.instructAttributes.map(a => a.toLowerCase()));
  return instruct.split(/\s*[,，]\s*/).filter(item => valid.has(item.trim().toLowerCase())).join(', ');
}

/* Bahasa hanya dipasang bila worker benar-benar menawarkannya. Nama tampilan
   datang dari worker (OmniVoice memetakan 600+ kode), jadi cocokkan persis
   daripada menebak — kalau tidak ada, biarkan "Otomatis" yang bekerja. */
function usableLang(which, lang) {
  if (!lang) return '';
  const sel = $(`#${which}-lang`);
  return [...sel.options].some(o => o.value === lang) ? lang : '';
}

function renderTemplates() {
  for (const bar of $$('[data-tplbar]')) {
    const which = bar.dataset.tplbar.startsWith('vd') ? 'vd' : 'vc';
    const target = $('#' + bar.dataset.tplbar);
    const instructField = $(`#${which}-instruct`);
    bar.innerHTML = '<span class="tagbar-label">Naskah contoh</span>';
    let group = '';

    for (const template of templatesFor()) {
      if (template.group && template.group !== group) {
        group = template.group;
        const label = document.createElement('span');
        label.className = 'tagbar-label tagbar-group';
        label.textContent = group;
        bar.append(label);
      }
      // Tab Design pada OmniVoice: instruct dimiliki dropdown kategori,
      // jadi template tidak ikut mengisinya agar tidak saling bertentangan.
      const instruct = which === 'vd' && !state.instructFreeform
        ? '' : usableInstruct(template.instruct);
      const lang = usableLang(which, template.lang);
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tpl-chip';
      chip.textContent = template.name;
      chip.title = [
        'Muat naskah contoh',
        instruct && `Gaya Suara "${instruct}"`,
        lang && `bahasa ${lang}`,
      ].filter(Boolean).join(' + ') + ' (menimpa isi yang ada)';
      chip.addEventListener('click', () => {
        target.value = template.text;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        if (lang) $(`#${which}-lang`).value = lang;
        if (instruct) {
          instructField.value = instruct;
          instructField.dispatchEvent(new Event('input', { bubbles: true }));
        }
        // isian tak terlihat = isian yang membingungkan; buka accordion-nya
        if (instruct || lang) {
          const acc = instructField.closest('details');
          if (acc) acc.open = true;
        }
        target.focus();
        target.setSelectionRange(target.value.length, target.value.length);
      });
      bar.append(chip);
    }
  }
}

/* Panduan menyesuaikan mesin yang terhubung. Teks per-mesin dikumpulkan di sini
   supaya tidak ada klaim yang tercecer di markup dan jadi basi. */
const GUIDE = {
  default: {
    notebook: 'voizgenWorker.ipynb',
    design: 'Voice Design membuat suara tanpa audio referensi. Aturan isian Gaya Suara berbeda per mesin — hubungkan worker dulu.',
    speed: 'bicara lebih lambat / lebih cepat sampai arahan berikutnya',
    whisper: 'berbisik sampai arahan berikutnya',
    batch: 'Naskah dipecah pada setiap jeda, maksimum 40 segmen per permintaan.',
    tagsTitle: '4 · Tag non-verbal',
    tagsIntro: 'Ditulis di tengah naskah, dipahami langsung oleh model:',
    tagsEmpty: 'Hubungkan worker untuk melihat daftarnya',
    tagnote: '',
    instructTitle: '5 · Gaya Suara (Instruct)',
    instructIntro: 'Hubungkan worker untuk melihat aturan yang berlaku.',
    instructEmpty: 'Hubungkan worker untuk melihat daftarnya',
    unsupported: [
      '<b>Penekanan kata</b> — tidak ada tag khusus. Dekati dengan <code>[pause]</code> pendek sebelum kata kunci, atau <code>[slow]</code> pada frasanya.',
    ],
  },
  omnivoice: {
    notebook: 'voizgenWorker.ipynb',
    design: 'Voice Design membuat suara dari atribut baku tanpa referensi. Perlu diketahui: mode ini hanya dilatih pada data Mandarin dan Inggris, jadi untuk naskah Indonesia hasilnya bisa kurang stabil.',
    speed: 'kecepatan ×0,85 / ×1,15 — parameter <code>speed</code> model',
    whisper: 'berbisik — atribut resmi model',
    batch: 'Naskah dipecah pada setiap jeda lalu disintesis satu batch, sehingga timbre tetap sama antar segmen. Maksimum 40 segmen per permintaan.',
    tagsTitle: '4 · Tag non-verbal',
    tagsIntro: 'Ditulis di tengah naskah, dipahami langsung oleh model:',
    tagsEmpty: 'Worker ini tidak melaporkan tag non-verbal',
    tagnote: 'Koreksi pelafalan juga didukung: pinyin bernada untuk Mandarin (<code>打ZHE2</code>) dan CMU untuk Inggris (<code>[B EY1 S]</code>).',
    instructTitle: '5 · Instruct yang diterima',
    instructIntro: 'Kosakata tertutup. Item di luar daftar ini <b>ditolak</b> model, bukan diabaikan:',
    instructEmpty: 'Worker ini tidak melaporkan atribut instruct',
    unsupported: [
      '<b>Emosi sebagai instruct</b> — <code>semangat</code>, <code>angry</code>, <code>cheerful</code>, <code>excited</code>. Tidak ada padanannya; satu-satunya atribut gaya adalah <code>whisper</code>.',
      '<b>Tag emosi</b> — <code>[soft]</code>, <code>[emphasis]</code>, <code>[calm]</code>, <code>[reflective]</code>. Dibuang worker dan dilaporkan di catatan hasil.',
      '<b>Penekanan kata</b> — tidak ada tag khusus. Dekati dengan <code>[pause]</code> pendek sebelum kata kunci, atau <code>[slow]</code> pada frasanya.',
    ],
  },
  voxcpm2: {
    notebook: 'voxcpm2Worker.ipynb',
    design: 'Voice Design membuat suara dari deskripsi bahasa alami tanpa referensi. Bahasa Indonesia termasuk 30 bahasa yang didukung, jadi mode ini tidak terbatas Mandarin/Inggris. Catatan dari dokumentasi resminya: hasil bisa berbeda antar percobaan, jadi generate 1–3 kali bila belum pas.',
    speed: 'diterjemahkan jadi deskripsi <code>speaking slowly</code> / <code>speaking quickly</code> — VoxCPM2 tidak punya parameter kecepatan',
    whisper: 'diterjemahkan jadi deskripsi <code>whispering</code>',
    batch: 'Naskah dipecah pada setiap jeda lalu disintesis satu per satu — VoxCPM2 tidak punya API batch, jadi naskah panjang lebih lama. Maksimum 40 segmen per permintaan.',
    tagsTitle: '4 · Tag non-verbal',
    tagsIntro: 'VoxCPM2 tidak mendokumentasikan tag non-verbal:',
    tagsEmpty: 'Tidak ada. <code>[laughter]</code>/<code>[sigh]</code> akan dibuang worker dan dilaporkan di catatan hasil.',
    tagnote: '',
    instructTitle: '5 · Gaya Suara (Instruct)',
    instructIntro: 'Teks bebas — worker menuliskannya sebagai deskripsi dalam tanda kurung di depan naskah, misal <code>(energetic, shouting) Ayo!</code>. Emosi, umur, pace, dan tekstur suara semuanya boleh. Contoh:',
    instructEmpty: 'Worker tidak mengirim contoh',
    unsupported: [
      '<b>Durasi tetap dan kecepatan numerik</b> — tidak ada di API VoxCPM2. Slider Kecepatan/Durasi diabaikan; pakai <code>[slow]</code>/<code>[fast]</code> atau tulis pace-nya di Gaya Suara.',
      '<b>Tag non-verbal</b> — <code>[laughter]</code>, <code>[sigh]</code> dan sejenisnya tidak didokumentasikan; dibuang worker dan dilaporkan di catatan hasil.',
      '<b>Penekanan kata</b> — tidak ada tag khusus. Dekati dengan <code>[pause]</code> pendek sebelum kata kunci, atau minta <code>emphatic delivery</code> di Gaya Suara.',
    ],
  },
};

/* Kedua notebook disajikan dari origin ini (lihat gateway/scripts/stage.mjs). */
const ENGINES = [
  {
    id: 'omnivoice',
    file: 'voizgenWorker.ipynb',
    label: 'OmniVoice 0.6B',
    note: '600+ bahasa, 24 kHz, cepat di T4. Gaya suara terbatas kosakata baku — tanpa emosi. Bobot CC-BY-NC (non-komersial).',
  },
  {
    id: 'voxcpm2',
    file: 'voxcpm2Worker.ipynb',
    label: 'VoxCPM2 2B',
    note: '30 bahasa termasuk Indonesia, 48 kHz, gaya suara teks bebas (emosi boleh). Model 2B — lebih berat di T4. Apache-2.0 (boleh komersial).',
  },
];

/* Colab hanya bisa membuka notebook dari Drive/GitHub/Gist. Kalau gateway
   menyediakan tautan untuk sebuah mesin, itu dipakai; kalau tidak, berkasnya
   diunduh dari origin ini lalu diunggah manual ke Colab. */
const engineById = id => ENGINES.find(e => e.id === id) || null;
const colabUrl = id => state.notebookUrls[id] || null;

function guideProfile() {
  if (GUIDE[state.engine]) return GUIDE[state.engine];
  if (!state.health) return GUIDE.default;
  return state.instructFreeform ? GUIDE.voxcpm2 : GUIDE.omnivoice;
}

function renderGuide() {
  const g = guideProfile();
  const fill = (host, items, emptyLabel) => {
    host.innerHTML = items.length
      ? items.map(i => `<span>${i}</span>`).join('')
      : `<span class="is-empty">${emptyLabel}</span>`;
  };
  $('[data-guide-notebook]').textContent = g.notebook;
  $('[data-guide-design]').innerHTML = g.design;
  $('[data-guide-speed]').innerHTML = g.speed;
  $('[data-guide-whisper]').innerHTML = g.whisper;
  $('[data-guide-batch]').innerHTML = g.batch;
  $('[data-guide-tags-title]').textContent = g.tagsTitle;
  $('[data-guide-tags-intro]').textContent = g.tagsIntro;
  $('[data-guide-instruct-title]').textContent = g.instructTitle;
  $('[data-guide-instruct-intro]').innerHTML = g.instructIntro;

  const note = $('[data-guide-tagnote]');
  note.innerHTML = g.tagnote;
  note.hidden = !g.tagnote;

  fill($('[data-guide-tags]'), state.nonverbalTags.map(t => `[${t}]`), g.tagsEmpty);
  fill($('[data-guide-instruct]'),
    state.instructFreeform ? state.instructExamples : state.instructAttributes, g.instructEmpty);
  $('[data-guide-unsupported]').innerHTML = g.unsupported.map(i => `<li>${i}</li>`).join('');
  $('[data-guide-notebooks]').innerHTML = ENGINES.map(e => {
    const url = colabUrl(e.id);
    const link = url
      ? `<a href="${url}" target="_blank" rel="noopener noreferrer"><b>Buka ${e.label} di Colab</b></a>`
      : `<a href="${e.file}" download="${e.file}"><b>Unduh ${e.label}</b></a>`;
    const active = state.engine === e.id ? ' <b>· sedang terhubung</b>' : '';
    return `<li>${link} — <code>${e.file}</code>${active}<br>${e.note}</li>`;
  }).join('');
}

function renderTagbars() {
  const tags = state.nonverbalTags.map(t => ({ label: `[${t}]`, insert: `[${t}]`, kind: 'tag' }));
  const directives = state.directives.map(d => ({ label: `[${d}]`, insert: `[${d}]`, kind: 'directive' }));
  if (!tags.length && !directives.length) return;

  for (const bar of $$('[data-tagbar]')) {
    const target = $('#' + bar.dataset.tagbar);
    bar.innerHTML = '<span class="tagbar-label">Sisip</span>';
    for (const item of [...directives, ...tags]) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'tag-chip' + (item.kind === 'directive' ? ' tag-directive' : '');
      chip.textContent = item.label;
      chip.title = item.kind === 'directive'
        ? 'Arahan naskah: diproses worker (jeda / kecepatan / bisikan)'
        : 'Tag non-verbal yang dipahami model';
      chip.addEventListener('click', () => insertAtCursor(target, item.insert));
      bar.append(chip);
    }
  }
}

function insertAtCursor(field, snippet) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? start;
  const before = field.value.slice(0, start);
  const after = field.value.slice(end);
  const lead = before && !/\s$/.test(before) ? ' ' : '';
  const trail = /^\s/.test(after) || after === '' ? '' : ' ';
  field.value = before + lead + snippet + trail + after;
  const caret = (before + lead + snippet + trail).length;
  field.focus();
  field.setSelectionRange(caret, caret);
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

/* Cek item instruct yang diketik manual terhadap kosakata worker.
   Worker teks-bebas (VoxCPM2) tidak punya kosakata -> tidak ada yang bisa salah. */
function invalidInstructItems(raw) {
  if (!raw.trim() || state.instructFreeform || !state.instructAttributes.length) return [];
  const valid = new Set(state.instructAttributes.map(a => a.toLowerCase()));
  return raw.split(/\s*[,，]\s*/)
    .map(item => item.trim())
    .filter(item => item && !valid.has(item.toLowerCase()));
}

const INSTRUCT_HINT = 'Hanya atribut baku: gender, usia, pitch, whisper, aksen, dialek. Emosi seperti "semangat" ditolak model.';
const FREEFORM_HINT = 'Teks bebas: emosi, umur, tempo, tekstur suara. Ditulis dalam tanda kurung di depan naskah.';

/* Validasi satu field instruct; `which` = 'vc' (clone) atau 'vd' (design). */
function validateInstruct(which = 'vc') {
  const field = $(`#${which}-instruct`);
  const hint = which === 'vd' ? $('[data-instruct-hint="vd"]') : $('[data-instruct-hint]:not([data-instruct-hint="vd"])');
  const bad = invalidInstructItems(field.value);
  hint.classList.toggle('is-bad', bad.length > 0);
  if (bad.length) {
    hint.textContent = 'Tidak didukung: ' + bad.join(', ') + ' — pakai atribut dari daftar saran.';
  } else if (state.instructFreeform) {
    hint.textContent = which === 'vd' ? 'Opsional. ' + FREEFORM_HINT : FREEFORM_HINT;
  } else if (state.instructAttributes.length) {
    hint.textContent = which === 'vd' ? 'Opsional, atribut baku saja.' : INSTRUCT_HINT;
  } else {
    hint.textContent = '';
  }
  return bad;
}

/* =============== generate =============== */

function buildInstruct(picked, extra) {
  const parts = picked.filter(v => v && v !== 'Otomatis').map(v => INSTRUCT_MAP[v] || v);
  if (extra && extra.trim()) parts.push(extra.trim());
  return parts.join(', ');
}

function designPicks() {
  return $$('#vd-cats select').map(s => s.value);
}

function refreshInstructPreview() {
  const text = buildInstruct(designPicks(), $('#vd-instruct').value);
  $('#vd-instruct-preview').textContent = text || '(otomatis — model memilih sendiri)';

  const sels = $$('#vd-cats select');
  const clash = sels.length === 6 && sels[4].value !== 'Otomatis' && sels[5].value !== 'Otomatis';
  const warn = $('#vd-conflict');
  warn.hidden = !clash;
  if (clash) warn.textContent = 'Aksen Inggris dan Dialek Mandarin dipilih bersamaan — instruksi saling bertentangan, pilih salah satu saja.';
}

function setBusy(mode, busy) {
  state.busy = busy;
  for (const btn of $$('button[data-gen]')) {
    btn.disabled = busy;
    $('.spin', btn).hidden = !(busy && btn.dataset.gen === mode);
  }
}

function showNotes(mode, msg) {
  const el = $(`[data-notes="${mode}"]`);
  el.hidden = !msg;
  el.textContent = msg ? 'Catatan worker — ' + msg : '';
}

function showError(mode, msg) {
  const el = $(`[data-error="${mode}"]`);
  el.hidden = !msg;
  el.textContent = msg || '';
}

async function generate(mode) {
  if (state.busy) return;
  if (!isGateway() && !state.base) { showCfgError('Hubungkan ke worker terlebih dahulu.'); openModal(); return; }
  if (isGateway() && !state.health) { showCfgError('Masukkan kode akses terlebih dahulu.'); openModal(); return; }

  const p = mode === 'clone' ? 'vc' : 'vd';
  const text = $(`#${p}-text`).value.trim();
  if (!text) { showError(mode, 'Naskah teks masih kosong.'); return; }

  const fd = new FormData();
  fd.set('mode', mode);
  fd.set('text', text);
  fd.set('language', $(`#${p}-lang`).value);
  for (const [k, v] of Object.entries(readAdv(p))) fd.set(k, String(v));

  const badInstruct = validateInstruct(p);
  if (badInstruct.length) {
    showError(mode, `Instruct berisi item yang tidak didukung model: ${badInstruct.join(', ')}. `
      + 'OmniVoice hanya menerima atribut baku (gender, usia, pitch, whisper, aksen, dialek), bukan emosi.');
    return;
  }

  if (mode === 'clone') {
    const file = $('#vc-ref').files[0];
    if (!file) { showError(mode, 'Audio referensi wajib diunggah untuk voice clone.'); return; }
    fd.set('ref_audio', file, file.name);
    fd.set('ref_text', $('#vc-reftext').value);
    fd.set('instruct', $('#vc-instruct').value.trim());
  } else {
    fd.set('instruct', buildInstruct(designPicks(), $('#vd-instruct').value));
  }

  showError(mode, '');
  showNotes(mode, '');
  setBusy(mode, true);
  $(`[data-meta="${mode}"]`).textContent = 'Memproses…';
  const t0 = performance.now();

  try {
    const res = await fetch(endpoint('/api/generate'), {
      method: 'POST',
      headers: authHeaders(),
      body: fd,
    });

    if (!res.ok) {
      let detail = 'HTTP ' + res.status;
      try {
        const j = await res.json();
        if (j && j.detail) detail = j.detail;
      } catch { /* respons bukan JSON */ }
      throw new Error(detail);
    }

    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const elapsed = res.headers.get('X-Elapsed') || ((performance.now() - t0) / 1000).toFixed(2);

    const player = $(`[data-audio="${mode}"]`);
    player.src = url;
    player.hidden = false;
    $(`[data-placeholder="${mode}"]`).hidden = true;
    player.play().catch(() => { /* autoplay diblokir browser */ });
    const segments = Number(res.headers.get('X-Segments') || 1);
    const size = `${(blob.size / 1024).toFixed(0)} KB`;
    $(`[data-meta="${mode}"]`).textContent = segments > 1
      ? `${elapsed}s · ${size} · ${segments} segmen`
      : `${elapsed}s · ${size}`;

    const notes = res.headers.get('X-Notes');
    if (notes) showNotes(mode, decodeURIComponent(notes));

    pushHistory({ url, mode, text, elapsed, at: new Date() });
  } catch (err) {
    $(`[data-meta="${mode}"]`).textContent = '';
    showError(mode, err instanceof TypeError
      ? 'Koneksi ke worker terputus. Cek sel Colab (runtime bisa mati karena idle).'
      : err.message);
    setStatus('bad', 'Terputus', 'Worker tidak merespons.');
  } finally {
    setBusy(mode, false);
  }
}

/* =============== riwayat =============== */

function pushHistory(item) {
  state.history.unshift(item);
  for (const old of state.history.splice(HISTORY_MAX)) URL.revokeObjectURL(old.url);
  renderHistory();
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'voizgen';
}

function renderHistory() {
  const list = $('#history');
  const badge = $('[data-hist-count]');
  badge.hidden = !state.history.length;
  badge.textContent = String(state.history.length);

  if (!state.history.length) {
    list.innerHTML = '<li class="empty">Belum ada hasil.</li>';
    return;
  }
  list.innerHTML = '';
  for (const it of state.history) {
    const li = document.createElement('li');
    li.className = 'item';
    li.innerHTML = `
      <div class="txt"></div>
      <div class="sub"></div>
      <div class="acts">
        <audio controls src="${it.url}"></audio>
        <a class="mini-btn" download="">Unduh</a>
      </div>`;
    $('.txt', li).textContent = it.text;
    $('.sub', li).textContent =
      `${it.mode === 'clone' ? 'Voice Clone' : 'Voice Design'} · ${it.elapsed}s · ` +
      it.at.toLocaleTimeString('id-ID');
    const a = $('a', li);
    a.href = it.url;
    a.download = `${slug(it.text)}.wav`;
    list.append(li);
  }
}

/* =============== navigasi =============== */

function showView(view) {
  for (const el of $$('[data-view-panel]')) el.hidden = el.dataset.viewPanel !== view;
  for (const btn of $$('[data-view]')) btn.classList.toggle('is-active', btn.dataset.view === view);
}

/* =============== bootstrap =============== */

function init() {
  // pengaturan lanjutan
  for (const box of $$('details[data-adv]')) {
    box.insertAdjacentHTML('beforeend', advMarkup(box.dataset.adv));
  }
  for (const range of $$('input[type=range]')) {
    const out = $(`[data-out="${range.id}"]`);
    const sync = () => {
      out.textContent = range.step === '1' ? range.value : parseFloat(range.value).toFixed(2);
    };
    range.addEventListener('input', e => {
      sync();
      // geseran manusia mengunci nilai; nilai dari worker tidak menimpanya lagi
      if (e.isTrusted) range.dataset.touched = '1';
    });
    sync();
  }

  // kategori voice design
  $('#vd-cats').innerHTML = Object.entries(CATEGORIES).map(([name, choices]) => `
    <label class="field"><span class="field-label">${name}</span>
      <select>${choices.map(c => `<option>${c}</option>`).join('')}</select></label>`).join('');
  $('#vd-cats').addEventListener('change', refreshInstructPreview);
  $('#vd-instruct').addEventListener('input', refreshInstructPreview);
  refreshInstructPreview();
  $('#vc-instruct').addEventListener('input', () => validateInstruct('vc'));
  $('#vd-instruct').addEventListener('input', () => validateInstruct('vd'));

  // tab studio
  for (const tab of $$('.tab')) {
    tab.addEventListener('click', () => {
      $$('.tab').forEach(t => t.classList.toggle('is-active', t === tab));
      $$('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== tab.dataset.tab; });
    });
  }

  // navigasi sidebar / mobile
  for (const btn of $$('[data-view]')) {
    btn.addEventListener('click', () => showView(btn.dataset.view));
  }

  // naskah contoh + panduan (isi dinamis menyusul saat worker terhubung)
  applyVocabulary({});

  // banner fitur baru: sekali per browser
  const banner = $('#whatsnew');
  if (!localStorage.getItem(LS.seenWhatsNew)) banner.hidden = false;
  $('#whatsnew-close').addEventListener('click', () => {
    banner.hidden = true;
    localStorage.setItem(LS.seenWhatsNew, '1');
  });
  for (const btn of $$('#whatsnew [data-view]')) {
    btn.addEventListener('click', () => {
      banner.hidden = true;
      localStorage.setItem(LS.seenWhatsNew, '1');
    });
  }

  // hitung karakter
  for (const p of ['vc', 'vd']) {
    const ta = $(`#${p}-text`);
    ta.addEventListener('input', () => { $(`#${p}-count`).textContent = ta.value.length; });
  }

  // nama berkas referensi
  const ref = $('#vc-ref');
  ref.addEventListener('change', () => {
    const file = ref.files[0];
    $('[data-file-name]').textContent = file ? file.name : 'Pilih berkas audio';
    $('[data-file]').classList.toggle('has-file', !!file);
  });

  // modal koneksi
  $('#cfg-url').value = state.base;
  $('#cfg-token').value = state.token;
  for (const btn of $$('[data-open-cfg]')) btn.addEventListener('click', openModal);
  for (const btn of $$('[data-close-cfg]')) btn.addEventListener('click', closeModal);
  $('#modal').addEventListener('click', e => { if (e.target === $('#modal')) closeModal(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
  document.addEventListener('keydown', trapFocus);
  $('#btn-connect').addEventListener('click', () => connect());
  for (const id of ['#cfg-code', '#cfg-ticket', '#cfg-url', '#cfg-token']) {
    $(id).addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });
  }

  // kode akses: huruf besar + tanda hubung otomatis (XXXX-XXXX)
  $('#cfg-code').addEventListener('input', e => {
    const clean = e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8);
    e.target.value = clean.length > 4 ? clean.slice(0, 4) + '-' + clean.slice(4) : clean;
  });

  // tiket ditempel -> uraikan ke isian manual sebagai umpan balik
  $('#cfg-ticket').addEventListener('input', () => {
    const raw = $('#cfg-ticket').value.trim();
    if (!raw) return;
    const parsed = decodeTicket(raw);
    if (!parsed) return;
    $('#cfg-url').value = parsed.url;
    $('#cfg-token').value = parsed.token;
    showCfgError('');
  });

  $('#btn-forget').addEventListener('click', async () => {
    if (isGateway()) {
      await fetch('/api/logout', { method: 'POST' }).catch(() => {});
      $('#cfg-code').value = '';
    } else {
      localStorage.removeItem(LS.url);
      localStorage.removeItem(LS.token);
      state.base = state.token = '';
      $('#cfg-ticket').value = '';
      $('#cfg-url').value = '';
      $('#cfg-token').value = '';
    }
    state.health = null;
    applyVocabulary({});  // panduan & validasi kembali netral
    setStatus('idle', 'Belum terhubung', isGateway()
      ? 'Sesi gateway diakhiri.'
      : 'Kredensial dihapus dari browser ini.');
    openModal();
  });

  // generate
  for (const btn of $$('button[data-gen]')) {
    btn.addEventListener('click', () => generate(btn.dataset.gen));
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      const active = $('.tab.is-active');
      generate(active ? active.dataset.tab : 'clone');
    }
  });

  $('#hist-clear').addEventListener('click', () => {
    for (const it of state.history) URL.revokeObjectURL(it.url);
    state.history = [];
    renderHistory();
  });

  // tautan cepat: .../#w=<tiket> atau .../#c=<kode akses> -> hubungkan lalu
  // bersihkan address bar. hashchange perlu ditangani juga: menempel tautan saat
  // app sudah terbuka tidak memuat ulang halaman, jadi init() tak akan jalan lagi.
  window.addEventListener('hashchange', consumeHashLink);

  detectMode().then(() => {
    // tautan notebook per mesin baru diketahui setelah /api/gateway menjawab
    renderGuide();
    setupNotebookShortcut();
    // isGateway() harus sudah pasti sebelum tautan dibaca: kunci hash beda per mode
    if (consumeHashLink()) return;
    if (isGateway()) {
      // cookie sesi mungkin masih hidup dari kunjungan sebelumnya
      connect({ silent: true }).then(ok => { if (!ok) openModal(); });
    } else if (state.base) {
      connect();
    } else {
      openModal();
    }
  });
}

/* Gateway terdeteksi bila origin ini menyajikan /api/gateway. */
async function detectMode() {
  if (!location.protocol.startsWith('http')) return;
  try {
    const res = await fetch('/api/gateway', { cache: 'no-store' });
    if (!res.ok) return;
    const info = await res.json();
    if (!info.gateway) return;
    state.mode = 'gateway';
    state.notebookUrls = info.notebook_urls || {};
    $('#modal-title').textContent = 'Kode Akses';
    for (const el of $$('[data-only]')) el.hidden = el.dataset.only !== 'gateway';
    $('[data-device]').textContent = 'Terhubung lewat gateway.';
  } catch { /* tanpa gateway: tetap mode direct */ }
}

/* Tombol pintasan notebook worker. Ada dua mesin, jadi tombolnya tidak boleh
   menebak: terhubung -> notebook mesin itu; belum -> antar ke Panduan yang
   memuat keduanya lengkap dengan trade-off-nya. */
async function setupNotebookShortcut() {
  const links = $$('[data-notebook]');
  const setAll = fn => links.forEach(fn);
  const engine = engineById(state.engine);

  const reset = a => {
    a.removeAttribute('download');
    a.removeAttribute('target');
    a.removeAttribute('rel');
    a.onclick = null;
  };

  if (!engine) {
    setAll(a => {
      reset(a);
      a.href = '#';
      a.onclick = e => { e.preventDefault(); showView('guide'); closeModal(); };
      $('[data-notebook-label]', a).textContent = 'Pilih Notebook';
      a.hidden = false;
    });
    showNotebookHint('Dua mesin tersedia — OmniVoice dan VoxCPM2. Bandingkan lalu unduh di Panduan.');
    return;
  }

  const url = colabUrl(engine.id);
  if (url) {
    setAll(a => {
      reset(a);
      a.href = url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      $('[data-notebook-label]', a).textContent = `Buka ${engine.label} di Colab`;
      a.hidden = false;
    });
    showNotebookHint('Notebook terbuka di tab baru. Pilih Runtime → T4 GPU, lalu Play.');
    return;
  }

  const local = new URL(engine.file, location.href).href;
  try {
    if (!(await fetch(local, { method: 'HEAD' })).ok) return;
  } catch {
    return; // tidak tersedia (mis. dibuka dari file://)
  }

  setAll(a => {
    reset(a);
    a.href = local;
    a.download = engine.file;
    $('[data-notebook-label]', a).textContent = `Unduh ${engine.label}`;
    a.hidden = false;
  });
  showNotebookHint(`Unduh ${engine.file}, lalu di Colab: File → Upload notebook. Runtime → T4 GPU, lalu Play.`);
}

function showNotebookHint(text) {
  const hint = $('[data-notebook-hint]');
  hint.textContent = text;
  hint.hidden = false;
}

/* Tautan sekali klik dari output Colab:
     mode langsung -> .../#w=<tiket>
     mode gateway  -> .../#c=<kode akses>
   Kredensial ditaruh di fragment, bukan query: fragment tidak pernah dikirim ke
   server, jadi tidak bocor ke log gateway/Cloudflare. */
function consumeHashLink() {
  const raw = new URLSearchParams(location.hash.slice(1)).get(isGateway() ? 'c' : 'w');
  if (!raw) return false;
  if (isGateway()) $('#cfg-code').value = raw.trim().toUpperCase();
  else $('#cfg-ticket').value = raw.startsWith(TICKET_PREFIX) ? raw : TICKET_PREFIX + raw;
  history.replaceState(null, '', location.pathname + location.search);
  connect();
  return true;
}

init();
