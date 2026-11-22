// Monta o produto no formato que a tela usa, a partir das linhas do banco.
// Usado pelo servidor local e pela versão na nuvem (no navegador).
import { analisar, melhorSerie } from './analise.js';

// Quem vende: a própria loja é o mais seguro; vendedor parceiro (marketplace) pede atenção.
export function confianca(o) {
  const v = (o.vendedor || '').toLowerCase(), l = o.loja.toLowerCase();
  if (!o.vendedor || v === 'não identificado') return { nivel: 'atencao', texto: 'Não deu para ver quem vende. Confira na página antes de comprar.' };
  if (v === l || v.includes(l) || l.includes(v)) return { nivel: 'bom', texto: 'A própria loja vende e entrega.' };
  return { nivel: 'atencao', texto: `Vendedor parceiro: ${o.vendedor}. Confira a reputação antes de comprar.` };
}

// p: linha de produtos; ofertas: linhas de ofertas, cada uma com .historico = [{quando, preco, preco_pix, disponivel}] em ordem
export function montarProduto(p, ofertas) {
  const lista = ofertas.map(o => {
    const historico = o.historico.map(h => ({ quando: h.quando, preco: h.preco == null ? null : Number(h.preco), pix: h.preco_pix == null ? null : Number(h.preco_pix), disponivel: !!h.disponivel }));
    const ult = historico[historico.length - 1];
    return {
      id: o.id, link: o.link, loja: o.loja, vendedor: o.vendedor, titulo: o.titulo,
      ultimaVerificacao: o.ultima_verificacao, ultimoErro: o.ultimo_erro, soComputador: !!o.so_computador,
      atual: ult && ult.disponivel ? ult.preco : null, pix: ult?.pix ?? null, disponivel: !!ult?.disponivel,
      menor: historico.filter(h => h.disponivel && h.preco != null).reduce((m, h) => (m == null || h.preco < m ? h.preco : m), null),
      confianca: confianca(o),
      historico,
    };
  });
  const historico = melhorSerie(lista.map(o => ({ loja: o.loja, historico: o.historico })));
  const disponiveis = lista.filter(o => o.atual != null).sort((a, b) => a.atual - b.atual);
  return {
    id: p.id, titulo: p.titulo, foto: p.foto, ean: p.ean, precoAlvo: p.preco_alvo == null ? null : Number(p.preco_alvo), precoMin: p.preco_min == null ? null : Number(p.preco_min), criadoEm: p.criado_em,
    ofertas: lista, melhorOferta: disponiveis[0]?.id ?? null,
    ultimaVerificacao: lista.map(o => o.ultimaVerificacao).filter(Boolean).sort().at(-1) || null,
    historico,
    analise: analisar(historico, p.preco_alvo == null ? null : Number(p.preco_alvo), p.preco_min == null ? null : Number(p.preco_min)),
  };
}
