// Testa os leitores com links reais: node scripts/testar-lojas.js <link> [<link> ...]
// Sem links, procura um produto de exemplo em cada loja.
import { acharLoja } from '../src/lojas.js';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const H = { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(25000) };
const texto = async u => (await fetch(u, H)).text();

const exemplos = {
  async Amazon() {
    const a = await texto('https://www.amazon.com.br/s?k=protetor+solar+facial');
    const x = a.match(/data-asin="([A-Z0-9]{10})"/); return x && `https://www.amazon.com.br/dp/${x[1]}`;
  },
  async Kabum() {
    const k = await texto('https://www.kabum.com.br/busca/monitor-gamer');
    const x = k.match(/(\/produto\/\d+\/[^"'\s]+)/); return x && 'https://www.kabum.com.br' + x[1];
  },
  async Drogasil() { return categoria('https://www.drogasil.com.br/saude.html'); },
  async 'Droga Raia'() { return categoria('https://www.drogaraia.com.br/saude.html'); },
  async Panvel() {
    const p = await texto('https://www.panvel.com/panvel/ofertas/protetores-solares/948');
    const x = p.match(/(\/panvel\/[a-z0-9-]+\/p-\d+)/); return x && 'https://www.panvel.com' + x[1];
  },
  'Pague Menos': () => vtex('https://www.paguemenos.com.br'),
  'Drogaria São Paulo': () => vtex('https://www.drogariasaopaulo.com.br'),
  'Época Cosméticos': () => vtex('https://www.epocacosmeticos.com.br'),
};
async function categoria(u) {
  const h = await texto(u);
  const x = h.match(/"url":"(https:\/\/www\.droga[a-z]+\.com\.br\/[a-z0-9-]+\.html)"/g)?.map(s => s.slice(7, -1)).find(s => /\d/.test(s));
  return x;
}
async function vtex(base) {
  const j = JSON.parse(await texto(base + '/api/catalog_system/pub/products/search?ft=protetor%20solar%20facial&_from=0&_to=0'));
  return j[0] && `${base}/${j[0].linkText}/p`;
}

let links = process.argv.slice(2);
if (!links.length) for (const [nome, achar] of Object.entries(exemplos)) {
  try { const l = await achar(); if (l) links.push(l); else console.log(`? ${nome}: não achei produto de exemplo`); }
  catch (e) { console.log(`? ${nome}: erro ao achar exemplo (${e.message})`); }
}
for (const link of links) {
  const loja = acharLoja(link);
  if (!loja) { console.log('Loja não suportada:', link); continue; }
  try {
    const r = await loja.ler(loja.normalizar(link));
    console.log(`✔ ${r.loja}: ${r.titulo.slice(0, 60)}\n   preço=${r.preco} pix=${r.precoPix ?? '-'} vendedor=${r.vendedor} disponível=${r.disponivel} foto=${r.foto ? 'sim' : 'não'}`);
  } catch (e) {
    console.log(`✘ ${loja.nome}: ${e.message}\n   ${link}`);
  }
}
