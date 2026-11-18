// Confere os preços sozinho, de tempos em tempos. Cada loja (oferta) é conferida separadamente.
import { db, agora } from './banco.js';
import { acharLoja } from './lojas.js';
import { avisosNovos, melhorSerie, intervaloAtual } from './analise.js';

export { intervaloAtual };

const espera = ms => new Promise(r => setTimeout(r, ms));

export function historicoDaOferta(id) {
  return db.prepare('SELECT quando, preco, preco_pix, disponivel FROM precos WHERE oferta_id = ? ORDER BY quando').all(id)
    .map(h => ({ ...h, disponivel: !!h.disponivel }));
}
export const ofertasDo = produtoId => db.prepare('SELECT * FROM ofertas WHERE produto_id = ? ORDER BY id').all(produtoId);

// Histórico do produto = a cada momento, o menor preço entre as lojas.
export function historicoDoProduto(produtoId) {
  return melhorSerie(ofertasDo(produtoId).map(o => ({ loja: o.loja, historico: historicoDaOferta(o.id) })));
}

export function gravarLeitura(oferta, r) {
  const quando = agora();
  db.prepare('INSERT INTO precos (oferta_id, quando, preco, preco_pix, disponivel) VALUES (?, ?, ?, ?, ?)')
    .run(oferta.id, quando, r.preco, r.precoPix ?? null, r.disponivel && r.preco != null ? 1 : 0);
  db.prepare('UPDATE ofertas SET ultima_verificacao = ?, ultimo_erro = NULL, vendedor = ?, titulo = COALESCE(?, titulo), ean = COALESCE(?, ean) WHERE id = ?')
    .run(quando, r.vendedor, r.titulo, r.ean ?? null, oferta.id);
  if (r.ean) db.prepare('UPDATE produtos SET ean = COALESCE(ean, ?) WHERE id = ?').run(r.ean, oferta.produto_id);
  if (r.foto) db.prepare('UPDATE produtos SET foto = COALESCE(foto, ?) WHERE id = ?').run(r.foto, oferta.produto_id);
}

export async function verificar(oferta) {
  const loja = acharLoja(oferta.link);
  if (!loja) throw new Error('Loja não suportada.');
  const produto = db.prepare('SELECT * FROM produtos WHERE id = ?').get(oferta.produto_id);
  try {
    const r = await loja.ler(oferta.link);
    const antes = historicoDoProduto(produto.id);
    gravarLeitura(oferta, r);
    const depois = historicoDoProduto(produto.id);
    const novo = depois[depois.length - 1];
    if (novo) for (const a of avisosNovos(produto, antes, novo)) {
      db.prepare('INSERT INTO avisos (produto_id, quando, titulo, texto) VALUES (?, ?, ?, ?)').run(produto.id, agora(), a.titulo, a.texto);
    }
    console.log(`[${new Date().toLocaleString('pt-BR')}] ${oferta.loja}: ${produto.titulo.slice(0, 50)} → ${r.preco ?? 'sem preço'}`);
    return r;
  } catch (e) {
    db.prepare('UPDATE ofertas SET ultima_verificacao = ?, ultimo_erro = ? WHERE id = ?').run(agora(), e.message, oferta.id);
    console.log(`[${new Date().toLocaleString('pt-BR')}] Erro em ${oferta.loja} / ${produto.titulo.slice(0, 40)}: ${e.message}`);
    throw e;
  }
}

let rodando = false;
async function rodada() {
  if (rodando) return;
  rodando = true;
  try {
    const limite = new Date(Date.now() - intervaloAtual()).toISOString();
    const pendentes = db.prepare('SELECT * FROM ofertas WHERE ultima_verificacao IS NULL OR ultima_verificacao < ? ORDER BY ultima_verificacao').all(limite);
    for (const o of pendentes) {
      try { await verificar(o); } catch { /* erro já registrado na oferta */ }
      await espera(5000 + Math.random() * 10000); // calma entre uma leitura e outra, para não ser bloqueado
    }
  } finally { rodando = false; }
}

export function iniciarVerificador() {
  rodada();
  setInterval(rodada, 10 * 60 * 1000); // olha a cada 10 min quem já passou da hora
}
