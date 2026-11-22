// Servidor local do Radar de Preço: http://localhost:3000
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname, normalize } from 'node:path';
import { db, agora } from './banco.js';
import { acharLoja, lojasSuportadas, lojasComBusca, procurarEmOutrasLojas } from './lojas.js';
import { montarProduto } from '../public/lib/montar.js';
import { verificar, gravarLeitura, historicoDaOferta, ofertasDo, iniciarVerificador, intervaloAtual } from './verificador.js';

const PORTA = Number(process.env.PORT || 3000);
const PUBLICO = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const USUARIO = 'eu'; // por enquanto, uma conta só; o login com Google entra depois

const TIPOS = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function json(res, status, dado) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(dado));
}
async function corpo(req) {
  let txt = '';
  for await (const c of req) { txt += c; if (txt.length > 1e5) throw new Error('Pedido grande demais.'); }
  return txt ? JSON.parse(txt) : {};
}

const montar = p => montarProduto(p, ofertasDo(p.id).map(o => ({ ...o, historico: historicoDaOferta(o.id) })));
const buscar = id => db.prepare('SELECT * FROM produtos WHERE id = ? AND usuario = ?').get(id, USUARIO);
const ofertaDoUsuario = id => db.prepare('SELECT o.* FROM ofertas o JOIN produtos p ON p.id = o.produto_id WHERE o.id = ? AND p.usuario = ?').get(id, USUARIO);

// Lê o link e devolve [loja, linkFinal, dadosLidos] ou lança erro com mensagem amigável.
async function lerLink(link) {
  let url;
  try { url = new URL(String(link || '').trim()); } catch { throw Object.assign(new Error('Cole o link completo do produto, começando com https://'), { status: 400 }); }
  const loja = acharLoja(url.href);
  if (!loja) throw Object.assign(new Error(`Essa loja ainda não funciona no app. Por enquanto ele lê: ${lojasSuportadas.join(', ')}.`), { status: 400 });
  const linkFinal = loja.normalizar(url.href);
  try { return [loja, linkFinal, await loja.ler(linkFinal)]; } catch (e) { throw Object.assign(e, { status: 502 }); }
}
function linkJaExiste(link) {
  return db.prepare('SELECT p.titulo FROM ofertas o JOIN produtos p ON p.id = o.produto_id WHERE o.link = ? AND p.usuario = ?').get(link, USUARIO);
}
function criarOferta(produtoId, loja, link, lido) {
  const r = db.prepare('INSERT INTO ofertas (produto_id, link, loja, titulo, vendedor, ean, criado_em) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(produtoId, link, lido.loja, lido.titulo, lido.vendedor, lido.ean ?? null, agora());
  const oferta = db.prepare('SELECT * FROM ofertas WHERE id = ?').get(Number(r.lastInsertRowid));
  gravarLeitura(oferta, lido);
  return oferta;
}

const rotas = [
  ['GET', /^\/api\/status$/, () => [200, { lojas: lojasSuportadas, lojasComBusca, intervaloHoras: intervaloAtual() / 36e5 }]],

  ['GET', /^\/api\/produtos$/, () => [200, db.prepare('SELECT * FROM produtos WHERE usuario = ? ORDER BY criado_em DESC').all(USUARIO).map(montar)]],

  // Novo produto a partir do link de uma loja
  ['POST', /^\/api\/produtos$/, async req => {
    const { link, precoAlvo } = await corpo(req);
    const [loja, linkFinal, lido] = await lerLink(link);
    const ja = linkJaExiste(linkFinal);
    if (ja) return [409, { erro: `Você já está acompanhando esse link (em “${ja.titulo.slice(0, 60)}”).` }];
    const r = db.prepare('INSERT INTO produtos (usuario, titulo, foto, ean, preco_alvo, criado_em) VALUES (?, ?, ?, ?, ?, ?)')
      .run(USUARIO, lido.titulo, lido.foto, lido.ean ?? null, precoAlvo ? Number(precoAlvo) : null, agora());
    criarOferta(Number(r.lastInsertRowid), loja, linkFinal, lido);
    return [201, montar(buscar(Number(r.lastInsertRowid)))];
  }],

  // Mesma coisa em outra loja
  ['POST', /^\/api\/produtos\/(\d+)\/ofertas$/, async (req, [, id]) => {
    const p = buscar(Number(id));
    if (!p) return [404, { erro: 'Produto não encontrado.' }];
    const { link } = await corpo(req);
    const [loja, linkFinal, lido] = await lerLink(link);
    const ja = linkJaExiste(linkFinal);
    if (ja) return [409, { erro: `Esse link já está no app (em “${ja.titulo.slice(0, 60)}”).` }];
    criarOferta(p.id, loja, linkFinal, lido);
    return [201, montar(buscar(p.id))];
  }],

  ['DELETE', /^\/api\/ofertas\/(\d+)$/, (req, [, id]) => {
    const o = ofertaDoUsuario(Number(id));
    if (!o) return [404, { erro: 'Loja não encontrada nesse produto.' }];
    if (ofertasDo(o.produto_id).length === 1) return [400, { erro: 'Essa é a única loja do produto. Para tirar, use “Parar de acompanhar”.' }];
    db.prepare('DELETE FROM precos WHERE oferta_id = ?').run(o.id);
    db.prepare('DELETE FROM ofertas WHERE id = ?').run(o.id);
    return [200, montar(buscar(o.produto_id))];
  }],

  // Sugestões do mesmo produto em outras lojas (a pessoa confirma antes de adicionar)
  ['GET', /^\/api\/produtos\/(\d+)\/sugestoes$/, async (req, [, id]) => {
    const p = buscar(Number(id));
    if (!p) return [404, { erro: 'Produto não encontrado.' }];
    const ofertas = ofertasDo(p.id);
    const ean = p.ean || ofertas.find(o => o.ean)?.ean || null;
    const lista = await procurarEmOutrasLojas({ ean, titulo: p.titulo }, ofertas.map(o => o.loja));
    const links = new Set(db.prepare('SELECT o.link FROM ofertas o JOIN produtos p ON p.id = o.produto_id WHERE p.usuario = ?').all(USUARIO).map(x => x.link));
    return [200, lista.filter(s => !links.has(s.link))];
  }],

  ['POST', /^\/api\/produtos\/(\d+)\/atualizar$/, async (req, [, id]) => {
    const p = buscar(Number(id));
    if (!p) return [404, { erro: 'Produto não encontrado.' }];
    const erros = [];
    for (const o of ofertasDo(p.id)) { try { await verificar(o); } catch (e) { erros.push(`${o.loja}: ${e.message}`); } }
    return [200, { produto: montar(buscar(p.id)), erros }];
  }],

  ['PATCH', /^\/api\/produtos\/(\d+)$/, async (req, [, id]) => {
    const p = buscar(Number(id));
    if (!p) return [404, { erro: 'Produto não encontrado.' }];
    const { precoAlvo, precoMin, titulo } = await corpo(req);
    if (precoAlvo !== undefined) db.prepare('UPDATE produtos SET preco_alvo = ? WHERE id = ?').run(precoAlvo ? Number(precoAlvo) : null, p.id);
    if (precoMin !== undefined) db.prepare('UPDATE produtos SET preco_min = ? WHERE id = ?').run(precoMin ? Number(precoMin) : null, p.id);
    if (titulo) db.prepare('UPDATE produtos SET titulo = ? WHERE id = ?').run(String(titulo).slice(0, 200), p.id);
    return [200, montar(buscar(p.id))];
  }],

  ['DELETE', /^\/api\/produtos\/(\d+)$/, (req, [, id]) => {
    const p = buscar(Number(id));
    if (!p) return [404, { erro: 'Produto não encontrado.' }];
    for (const o of ofertasDo(p.id)) db.prepare('DELETE FROM precos WHERE oferta_id = ?').run(o.id);
    db.prepare('DELETE FROM ofertas WHERE produto_id = ?').run(p.id);
    db.prepare('DELETE FROM avisos WHERE produto_id = ?').run(p.id);
    db.prepare('DELETE FROM produtos WHERE id = ?').run(p.id);
    return [200, { ok: true }];
  }],

  ['GET', /^\/api\/avisos$/, req => {
    const depois = Number(new URL(req.url, 'http://x').searchParams.get('depois') || 0);
    const lista = db.prepare(`SELECT a.* FROM avisos a JOIN produtos p ON p.id = a.produto_id
      WHERE p.usuario = ? AND a.id > ? ORDER BY a.id DESC LIMIT 20`).all(USUARIO, depois);
    return [200, lista];
  }],
];

createServer(async (req, res) => {
  try {
    const caminho = new URL(req.url, 'http://x').pathname;
    for (const [metodo, padrao, fazer] of rotas) {
      const m = caminho.match(padrao);
      if (m && req.method === metodo) {
        try { const [s, d] = await fazer(req, m); return json(res, s, d); }
        catch (e) { if (e.status) return json(res, e.status, { erro: e.message }); throw e; }
      }
    }
    if (caminho.startsWith('/api/')) return json(res, 404, { erro: 'Rota não encontrada.' });
    // No computador, a tela sempre roda no modo local (mesmo que config.js tenha os dados da nuvem)
    if (caminho === '/config.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end('window.RADAR_CONFIG = {};'); }
    // Arquivos da tela
    const arq = normalize(join(PUBLICO, caminho === '/' ? 'index.html' : caminho));
    if (!arq.startsWith(PUBLICO)) { res.writeHead(403); return res.end(); }
    const conteudo = await readFile(arq).catch(() => null);
    if (!conteudo) { res.writeHead(404); return res.end('Não encontrado'); }
    res.writeHead(200, { 'Content-Type': TIPOS[extname(arq)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(conteudo);
  } catch (e) {
    console.error(e);
    json(res, 500, { erro: 'Algo deu errado no servidor. Tente de novo.' });
  }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`Radar de Preço rodando em http://localhost:${PORTA}`);
  console.log(`Lojas: ${lojasSuportadas.join(', ')} · conferindo a cada ${intervaloAtual() / 36e5} h`);
  iniciarVerificador();
});
