// Lógica da versão na nuvem (Supabase). Só usa fetch, então roda tanto no Node
// (verificador no GitHub) quanto no Deno (função da nuvem do Supabase).
import { acharLoja, lojasSuportadas, procurarEmOutrasLojas } from './lojas.js';
import { avisosNovos, melhorSerie } from '../public/lib/analise.js';

const erro = (status, msg) => Object.assign(new Error(msg), { status });

// Cliente mínimo do banco (API REST do Supabase), com a chave de serviço.
export function criarBanco(url, chave) {
  // Chaves antigas do Supabase são JWT (eyJ...) e vão também no Authorization; as novas (sb_secret_...) só no apikey.
  const base = { apikey: chave, 'Content-Type': 'application/json', ...(chave.startsWith('eyJ') ? { Authorization: `Bearer ${chave}` } : {}) };
  async function req(metodo, caminho, corpo, prefer) {
    const r = await fetch(`${url}/rest/v1/${caminho}`, {
      method: metodo, headers: prefer ? { ...base, Prefer: prefer } : base, body: corpo ? JSON.stringify(corpo) : undefined,
    });
    if (!r.ok) throw new Error(`Banco respondeu ${r.status}: ${(await r.text()).slice(0, 300)}`);
    const t = await r.text();
    return t ? JSON.parse(t) : null;
  }
  return {
    ler: (tabela, q = '') => req('GET', `${tabela}?${q}`),
    inserir: (tabela, linhas) => req('POST', tabela, linhas, 'return=representation'),
    atualizar: (tabela, q, dados) => req('PATCH', `${tabela}?${q}`, dados, 'return=representation'),
    apagar: (tabela, q) => req('DELETE', `${tabela}?${q}`),
  };
}

export async function historicoDoProduto(db, produtoId) {
  const ofertas = await db.ler('ofertas', `produto_id=eq.${produtoId}&select=id,loja`);
  if (!ofertas.length) return [];
  const precos = await db.ler('precos', `oferta_id=in.(${ofertas.map(o => o.id).join(',')})&order=quando.asc&select=oferta_id,quando,preco,disponivel`);
  return melhorSerie(ofertas.map(o => ({ loja: o.loja, historico: precos.filter(p => p.oferta_id === o.id) })));
}

// Grava uma leitura de preço e devolve os avisos que ela gerou.
export async function registrarLeitura(db, oferta, lido) {
  const [produto] = await db.ler('produtos', `id=eq.${oferta.produto_id}`);
  const antes = await historicoDoProduto(db, produto.id);
  const agora = new Date().toISOString();
  await db.inserir('precos', [{ oferta_id: oferta.id, usuario: oferta.usuario, quando: agora, preco: lido.preco, preco_pix: lido.precoPix ?? null, disponivel: !!(lido.disponivel && lido.preco != null) }]);
  await db.atualizar('ofertas', `id=eq.${oferta.id}`, { ultima_verificacao: agora, ultimo_erro: null, vendedor: lido.vendedor, titulo: lido.titulo || oferta.titulo, ean: lido.ean || oferta.ean });
  const extra = {};
  if (!produto.ean && lido.ean) extra.ean = lido.ean;
  if (!produto.foto && lido.foto) extra.foto = lido.foto;
  if (Object.keys(extra).length) await db.atualizar('produtos', `id=eq.${produto.id}`, extra);
  const depois = await historicoDoProduto(db, produto.id);
  const novo = depois[depois.length - 1];
  const avisos = novo ? avisosNovos(produto, antes, novo) : [];
  if (avisos.length) await db.inserir('avisos', avisos.map(a => ({ produto_id: produto.id, usuario: produto.usuario, titulo: a.titulo, texto: a.texto })));
  return avisos.map(a => ({ ...a, usuario: produto.usuario, produtoId: produto.id }));
}

// A loja recusou a nuvem (403/503): daí em diante quem lê é o computador da pessoa.
export const lojaBloqueou = e => /bloqueou|verificação de robô/i.test(e?.message || '');
const MSG_COMPUTADOR = 'Essa loja não deixa a nuvem ler. O preço vem do Radar no seu computador.';

export async function verificarOferta(db, oferta) {
  const loja = acharLoja(oferta.link);
  if (!loja) throw new Error('Loja não suportada.');
  try {
    return await registrarLeitura(db, oferta, await loja.ler(oferta.link));
  } catch (e) {
    const bloqueou = lojaBloqueou(e);
    await db.atualizar('ofertas', `id=eq.${oferta.id}`, { ultima_verificacao: new Date().toISOString(), ultimo_erro: bloqueou ? MSG_COMPUTADOR : e.message, ...(bloqueou ? { so_computador: true } : {}) });
    throw e;
  }
}

async function lerLink(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch { throw erro(400, 'Cole o link completo do produto, começando com https://'); }
  const loja = acharLoja(url.href);
  if (!loja) throw erro(400, `Essa loja ainda não funciona no app. Por enquanto ele lê: ${lojasSuportadas.join(', ')}.`);
  const linkFinal = loja.normalizar(url.href);
  try { return [linkFinal, await loja.ler(linkFinal)]; } catch (e) {
    // Loja que bloqueia a nuvem: o produto entra assim mesmo e o computador da pessoa lê depois.
    if (lojaBloqueou(e)) return [linkFinal, null, loja.nome];
    throw erro(502, e.message);
  }
}

async function produtoDo(db, usuario, produtoId) {
  const [p] = await db.ler('produtos', `id=eq.${Number(produtoId)}&usuario=eq.${usuario}`);
  if (!p) throw erro(404, 'Produto não encontrado.');
  return p;
}
async function linkJaExiste(db, usuario, link) {
  return (await db.ler('ofertas', `usuario=eq.${usuario}&link=eq.${encodeURIComponent(link)}&select=id`)).length > 0;
}
async function criarOferta(db, usuario, produtoId, link, lido, nomeLoja) {
  if (!lido) { // loja bloqueou a nuvem: fica esperando o computador
    await db.inserir('ofertas', [{ produto_id: produtoId, usuario, link, loja: nomeLoja, so_computador: true, ultimo_erro: MSG_COMPUTADOR }]);
    return;
  }
  const [o] = await db.inserir('ofertas', [{ produto_id: produtoId, usuario, link, loja: lido.loja, titulo: lido.titulo, vendedor: lido.vendedor, ean: lido.ean ?? null }]);
  await registrarLeitura(db, o, lido);
}
const tituloEsperando = loja => `Produto da ${loja} (esperando o Radar do computador)`;

// ---- Ações pedidas pela tela (a função da nuvem já conferiu quem é a pessoa) ----

export async function adicionarProduto(db, usuario, { link, precoAlvo }) {
  const [linkFinal, lido, nomeLoja] = await lerLink(link);
  if (await linkJaExiste(db, usuario, linkFinal)) throw erro(409, 'Você já está acompanhando esse link.');
  const [p] = await db.inserir('produtos', [{ usuario, titulo: lido ? lido.titulo : tituloEsperando(nomeLoja), foto: lido?.foto ?? null, ean: lido?.ean ?? null, preco_alvo: precoAlvo ? Number(precoAlvo) : null }]);
  await criarOferta(db, usuario, p.id, linkFinal, lido, nomeLoja);
  return { produtoId: p.id, soComputador: !lido };
}

export async function adicionarLoja(db, usuario, { produtoId, link }) {
  const p = await produtoDo(db, usuario, produtoId);
  const [linkFinal, lido, nomeLoja] = await lerLink(link);
  if (await linkJaExiste(db, usuario, linkFinal)) throw erro(409, 'Esse link já está no app.');
  await criarOferta(db, usuario, p.id, linkFinal, lido, nomeLoja);
  return { produtoId: p.id, soComputador: !lido };
}

export async function sugestoes(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const ofertas = await db.ler('ofertas', `produto_id=eq.${p.id}&select=loja,ean`);
  const ean = p.ean || ofertas.find(o => o.ean)?.ean || null;
  const lista = await procurarEmOutrasLojas({ ean, titulo: p.titulo }, ofertas.map(o => o.loja));
  const meus = new Set((await db.ler('ofertas', `usuario=eq.${usuario}&select=link`)).map(o => o.link));
  return lista.filter(s => !meus.has(s.link));
}

export async function atualizarProduto(db, usuario, { produtoId }) {
  const p = await produtoDo(db, usuario, produtoId);
  const erros = [];
  for (const o of await db.ler('ofertas', `produto_id=eq.${p.id}`)) {
    if (o.so_computador) continue; // essa o computador lê
    try { await verificarOferta(db, o); } catch (e) { erros.push(`${o.loja}: ${lojaBloqueou(e) ? 'essa loja só deixa o seu computador ler.' : e.message}`); }
  }
  return { erros };
}

// Leitura feita pelo computador da pessoa (ponte), para as lojas que bloqueiam a nuvem.
// Só aceita ofertas da própria pessoa; o pior que alguém consegue é bagunçar os próprios preços.
export async function registrarLeituraComputador(db, usuario, { ofertaId, lido }) {
  const [o] = await db.ler('ofertas', `id=eq.${Number(ofertaId)}&usuario=eq.${usuario}`);
  if (!o) throw erro(404, 'Loja não encontrada.');
  const num = v => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
  const txt = (v, n) => (v == null ? null : String(v).slice(0, n));
  const limpo = {
    preco: num(lido?.preco), precoPix: num(lido?.precoPix), disponivel: !!lido?.disponivel,
    titulo: txt(lido?.titulo, 300), foto: /^https:\/\//.test(lido?.foto || '') ? txt(lido.foto, 1000) : null,
    vendedor: txt(lido?.vendedor, 120), ean: /^\d{8,14}$/.test(lido?.ean || '') ? lido.ean : null,
  };
  const [p] = await db.ler('produtos', `id=eq.${o.produto_id}`);
  if (p && limpo.titulo && p.titulo === tituloEsperando(o.loja)) await db.atualizar('produtos', `id=eq.${p.id}`, { titulo: limpo.titulo });
  const avisos = await registrarLeitura(db, o, limpo);
  return { avisos };
}

// O computador avisa que não conseguiu ler (fica registrado para aparecer na tela).
export async function erroLeituraComputador(db, usuario, { ofertaId, mensagem }) {
  await db.atualizar('ofertas', `id=eq.${Number(ofertaId)}&usuario=eq.${usuario}`, { ultima_verificacao: new Date().toISOString(), ultimo_erro: `Seu computador não conseguiu ler: ${String(mensagem || '').slice(0, 200)}` });
  return { ok: true };
}
