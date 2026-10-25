// Salin notebook worker ke direktori aset sebelum deploy, supaya web app bisa
// menyajikannya sebagai unduhan. Sumber tunggalnya tetap notebook di root repo.
import { readFile, writeFile } from 'node:fs/promises';

const NOTEBOOKS = ['voizgenWorker.ipynb', 'voxcpm2Worker.ipynb'];

for (const name of NOTEBOOKS) {
  const raw = await readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
  JSON.parse(raw); // gagal cepat bila notebook rusak, jangan sampai ter-deploy
  await writeFile(new URL(`../../web/${name}`, import.meta.url), raw);
  console.log(`staged ${name} -> web/ (${raw.length} bytes)`);
}
