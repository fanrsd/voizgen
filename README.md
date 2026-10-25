# VoizGen

Studio text-to-speech self-hosted dengan voice cloning dan voice design. GPU Google Colab menghasilkan suara; halaman web mengendalikannya. UI berbahasa Indonesia.

| Bagian | Fungsi |
|---|---|
| `voizgenWorker.ipynb` | Worker GPU memakai model OmniVoice (`k2-fsa/OmniVoice`). FastAPI + tunnel `cloudflared` + token acak. |
| `voxcpm2Worker.ipynb` | Worker kedua memakai VoxCPM2 (`openbmb/VoxCPM2`), API sama. |
| `web/` | HTML/CSS/JS polos. Terhubung langsung (tiket URL+token) atau lewat gateway (kode akses ditukar jadi cookie HttpOnly). |
| `gateway/` | Cloudflare Worker: menyajikan `web/`, menyimpan URL tunnel + token di KV selama 12 jam; browser tidak pernah melihatnya. |
| `tools/mock-worker.mjs` | Worker palsu (WAV sintetis) untuk menguji UI tanpa Colab. |

## Menjalankan

```sh
# uji UI tanpa GPU
bun tools/mock-worker.mjs

# gateway (butuh akun Cloudflare)
cd gateway && bun install
npx wrangler kv namespace create SESSIONS   # tempel id ke wrangler.toml
npx wrangler secret put REGISTER_KEY
npm run dev        # atau: npm run deploy
```

Buka notebook worker di Colab, isi `GATEWAY_URL`, `REGISTER_KEY`, dan `WEB_APP_URL`, lalu jalankan. Notebook menampilkan kode akses untuk web app.

## Lisensi model dan etika

- Kode di repo ini: [MIT](LICENSE). Model diunduh saat notebook berjalan dan **tidak** termasuk.
- **VoxCPM2**: Apache-2.0, boleh komersial.
- **OmniVoice**: kode Apache-2.0, tetapi **bobot modelnya CC-BY-NC (non-komersial)** karena data latihnya. Jangan pakai untuk keperluan komersial.
- Voice cloning: pakai hanya suara yang kamu punya izinnya. Jangan meniru orang lain tanpa persetujuan.
