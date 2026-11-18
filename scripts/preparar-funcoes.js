// Copia o código comum para a pasta da função da nuvem (Supabase só publica o que está em supabase/functions).
// Rode antes de publicar: node scripts/preparar-funcoes.js
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const destino = 'supabase/functions/_shared';
mkdirSync(destino, { recursive: true });
const copias = [
  ['src/nuvem.js', 'nuvem.js'],
  ['src/lojas.js', 'lojas.js'],
  ['public/lib/analise.js', 'analise.js'],
];
for (const [de, para] of copias) {
  const txt = readFileSync(de, 'utf8').replace("'../public/lib/analise.js'", "'./analise.js'");
  writeFileSync(`${destino}/${para}`, '// GERADO por scripts/preparar-funcoes.js. Não edite aqui; edite o original em ' + de + '\n' + txt);
}
console.log('Arquivos comuns copiados para', destino);
