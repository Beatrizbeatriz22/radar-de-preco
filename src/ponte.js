// Ponte do Radar: roda no computador e lê as lojas que bloqueiam a nuvem
// (Amazon, Panvel, Kabum...) para todas as contas, e pesquisa na Kabum. Manda tudo para a nuvem.
// Tela: http://localhost:3001  (lá você entra uma vez com o mesmo nome e senha do app)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import { acharLoja, pesquisarLojas } from './lojas.js';
import { intervaloAtual } from '../public/lib/analise.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const SESSAO = process.env.PONTE_SESSAO || join(RAIZ, 'dados', 'ponte-sessao.json');
const PORTA = Number(process.env.PORTA_PONTE || 3001);

// Mesmos endereços públicos do app (public/config.js)
const cfgTxt = await readFile(join(RAIZ, 'public', 'config.js'), 'utf-8');
const pega = n => (cfgTxt.match(new RegExp(`${n}:\\s*'([^']*)'`)) || [])[1] || '';
const URL_NUVEM = pega('supabaseUrl'), CHAVE_PUBLICA = pega('supabaseAnonKey'), VAPID_PUBLICA = pega('vapidPublica');

// Chave de notificação (fica só neste computador)
let temPush = false;
try {
  const linhas = (await readFile(join(RAIZ, 'dados', 'chaves-avisos.txt'), 'utf-8')).split(/\r?\n/);
  const priv = (linhas[linhas.findIndex(l => l.includes('VAPID_PRIVADA')) + 1] || '').trim();
  if (priv && VAPID_PUBLICA) { webpush.setVapidDetails('https://github.com/Beatrizbeatriz22/radar-de-preco', VAPID_PUBLICA, priv); temPush = true; }
} catch {}

// Mesmo jeito do app de transformar o nome em "e-mail" interno
const emailDoNome = nome => {
  const base = nome.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return base ? `${base}@radardepreco.local` : null;
};

let sessao = null; // { nome, refresh, acesso, expira }
try { sessao = JSON.parse(await readFile(SESSAO, 'utf-8')); if (!sessao?.refresh) sessao = null; } catch {}
const salvarSessao = async () => { await mkdir(dirname(SESSAO), { recursive: true }); await writeFile(SESSAO, JSON.stringify({ nome: sessao.nome, refresh: sessao.refresh })); };

const registro = []; // últimas atividades, para a tela
const anotar = txt => { registro.unshift({ quando: new Date(), txt }); registro.length = Math.min(registro.length, 40); console.log(new Date().toLocaleString('pt-BR'), txt); };

async function auth(tipo, corpo) {
  const r = await fetch(`${URL_NUVEM}/auth/v1/token?grant_type=${tipo}`, { method: 'POST', headers: { apikey: CHAVE_PUBLICA, 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error_description || j.msg || `Erro ${r.status}`), { status: r.status });
  return j;
}
async function token() {
  if (!sessao) throw new Error('Ainda não entrou.');
  if (sessao.acesso && sessao.expira > Date.now() + 60e3) return sessao.acesso;
  try {
    const j = await auth('refresh_token', { refresh_token: sessao.refresh });
    Object.assign(sessao, { refresh: j.refresh_token, acesso: j.access_token, expira: Date.now() + j.expires_in * 1000 });
    await salvarSessao();
    return sessao.acesso;
  } catch (e) {
    if (e.status === 400 || e.status === 401) { sessao = null; await writeFile(SESSAO, '{}').catch(() => {}); anotar('A sessão expirou. Entre de novo na tela da ponte.'); }
    throw e;
  }
}
async function nuvem(caminho, opcoes = {}) {
  const r = await fetch(`${URL_NUVEM}${caminho}`, { ...opcoes, headers: { apikey: CHAVE_PUBLICA, Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json', ...(opcoes.headers || {}) } });
  const t = await r.text();
  if (!r.ok) throw new Error(`Nuvem respondeu ${r.status}: ${t.slice(0, 200)}`);
  return t ? JSON.parse(t) : null;
}
const funcao = (acao, dados) => nuvem('/functions/v1/radar', { method: 'POST', body: JSON.stringify({ acao, ...dados }) });

// inscricoes: de outra pessoa (a nuvem manda junto quando o produto é dela); sem isso, as da própria conta.
async function notificar(avisos, inscricoes = null) {
  if (!temPush || !avisos?.length) return;
  const proprias = !inscricoes?.length;
  if (proprias) inscricoes = await nuvem('/rest/v1/inscricoes_push?select=id,endpoint,chaves');
  for (const a of avisos) for (const i of inscricoes) {
    try { await webpush.sendNotification({ endpoint: i.endpoint, keys: i.chaves }, JSON.stringify({ titulo: a.titulo, texto: a.texto, produtoId: a.produtoId })); }
    catch (e) { if (proprias && (e.statusCode === 404 || e.statusCode === 410)) await nuvem(`/rest/v1/inscricoes_push?id=eq.${i.id}`, { method: 'DELETE' }).catch(() => {}); }
  }
}

const espera = ms => new Promise(r => setTimeout(r, ms));
let rodando = false, ultimaRodada = null;
// todas = true: lê tudo agora ("Conferir agora"); senão, só o que venceu ou é novo.
const real = v => `R$ ${Number(v).toFixed(2).replace('.', ',')}`;
async function rodada(todas = false) {
  if (rodando || !sessao) return;
  rodando = true;
  try {
    // A nuvem diz o que falta: lojas para ler, pesquisas da Kabum e produtos "parecido" (de todas as contas)
    const t = await funcao('ponteTarefas', {});
    await atenderBuscas(t.buscas, t.lojas);
    const limite = Date.now() - intervaloAtual() + 5 * 60e3;
    const vencido = d => todas || !d || new Date(d).getTime() < limite;
    for (const p of t.parecidos.filter(x => vencido(x.buscado_computador_em))) {
      try {
        const achados = await pesquisarLojas(p.busca || p.titulo, { so: t.lojas, n: 10 });
        const r = await funcao('resultadoParecidoComputador', { produtoId: p.id, resultados: achados });
        anotar(`Parecido "${p.busca}": ${achados.length} resultados na ${t.lojas.join('/')}`);
        await notificar(r.avisos, r.inscricoes);
      } catch (e) { anotar(`Parecido "${p.busca}": não deu (${e.message})`); }
      await espera(4000 + Math.random() * 6000);
    }
    const pendentes = t.ofertas.filter(o => vencido(o.ultima_verificacao));
    for (const [i, o] of pendentes.entries()) {
      if (i) await espera(5000 + Math.random() * 10000); // calma entre uma leitura e outra
      const loja = acharLoja(o.link);
      try {
        if (!loja) throw new Error('Loja não suportada.');
        const lido = await loja.ler(o.link);
        const r = await funcao('registrarLeituraComputador', { ofertaId: o.id, lido });
        anotar(`${o.loja}: ${lido.preco != null ? real(lido.preco) : 'sem preço / indisponível'} — ${String(lido.titulo || '').slice(0, 60)}`);
        await notificar(r.avisos, r.inscricoes);
      } catch (e) {
        anotar(`${o.loja}: não deu para ler (${e.message})`);
        await funcao('erroLeituraComputador', { ofertaId: o.id, mensagem: e.message }).catch(() => {});
      }
    }
    ultimaRodada = new Date();
  } catch (e) {
    anotar(`Erro ao falar com a nuvem: ${e.message}`);
  } finally { rodando = false; }
}

// Pesquisas que alguém está fazendo agora no app: o computador completa com a Kabum (rápido, a pessoa está esperando)
async function atenderBuscas(buscas, lojas) {
  for (const b of buscas || []) {
    try {
      const achados = await pesquisarLojas(b.termo, { so: lojas, n: 6 });
      await funcao('resultadoBuscaComputador', { buscaId: b.id, resultados: achados });
      anotar(`Pesquisa "${b.termo}": ${achados.length} na ${lojas.join('/')}`);
    } catch (e) { anotar(`Pesquisa "${b.termo}": não deu (${e.message})`); await funcao('resultadoBuscaComputador', { buscaId: b.id, resultados: [] }).catch(() => {}); }
  }
}
let olhandoBuscas = false;
async function olharBuscas() {
  if (olhandoBuscas || !sessao) return;
  olhandoBuscas = true;
  try { const t = await funcao('ponteTarefas', {}); await atenderBuscas(t.buscas, t.lojas); if (!rodando && t.ofertas.some(o => !o.ultima_verificacao)) rodada(); }
  catch {} finally { olhandoBuscas = false; }
}

// ---- Tela simples (só neste computador) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pagina(msg = '') {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Radar · ponte</title>
<meta http-equiv="refresh" content="${sessao ? 30 : 3600}">
<style>body{font-family:system-ui,sans-serif;background:#fff;color:#3A2A33;max-width:560px;margin:32px auto;padding:0 16px}
h1{font-size:22px}.card{border:1px solid #F7E4EC;border-radius:16px;padding:16px;margin:12px 0}
input{display:block;width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid #F0CFDD;border-radius:10px;font:inherit}
button{background:#F7A8C8;border:0;border-radius:999px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
ul{padding-left:18px}li{margin:4px 0}li span{color:#8F7683;font-size:12px}.m{color:#8F7683}.erro{color:#b3261e}.ok{color:#1b7a3d}</style></head><body>
<h1>Radar de Preço · computador</h1>
<div class="card" style="background:#FFF4F8"><b>O app fica aqui:</b><br>
<a href="https://beatrizbeatriz22.github.io/radar-de-preco/" target="_blank" style="font-size:17px;color:#B0306A;word-break:break-all">https://beatrizbeatriz22.github.io/radar-de-preco/</a><br>
<span class="m">É lá que você adiciona os produtos e vê os preços. Esse é o link para abrir no celular e mandar para as pessoas.</span></div>
<p class="m">Esta tela é só um ajudante: ele lê as lojas que não deixam a nuvem ler (Amazon, Panvel, Kabum...) enquanto o computador está ligado. Você não precisa mexer aqui.</p>
${msg}
${sessao ? `<div class="card"><p style="margin:0 0 6px;font-size:18px"><b class="ok">✓ Tudo certo!</b> Funcionando na conta <b>${esc(sessao.nome)}</b>.</p>
<p class="m" style="margin:0 0 4px">Pode fechar esta janela: ele continua trabalhando sozinho e liga junto com o computador.</p>
<p class="m" style="margin:0 0 14px">Última conferência: ${ultimaRodada ? ultimaRodada.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : 'ainda não'}. Confere a cada ${intervaloAtual() / 36e5} horas; produto novo, em até 2 minutos.</p>
<div style="display:flex;gap:8px;flex-wrap:wrap"><form method="post" action="/agora"><button>Conferir agora</button></form>
<form method="post" action="/testar"><button style="background:#fff;border:1px solid #F0CFDD">Testar notificação no celular</button></form>
<form method="post" action="/sair"><button style="background:#eee">Sair da conta</button></form></div></div>`
  : `<div class="card"><b>Seu perfil</b>
<p class="m" style="margin:4px 0 12px">Já tem conta no app? Escreva o mesmo nome e senha e toque em <b>Entrar</b>.<br>Primeira vez? Escreva seu nome, crie uma senha e toque em <b>Criar minha conta</b>.</p>
<form method="post" action="/entrar"><input name="nome" placeholder="Seu nome" required maxlength="40" autocomplete="username"><input name="senha" type="password" placeholder="Senha (mínimo 6 letras ou números)" required minlength="6" autocomplete="current-password">
<button name="acao" value="entrar">Entrar</button> <button name="acao" value="criar" style="background:#fff;border:1px solid #F0CFDD">Criar minha conta</button></form></div>`}
${temPush ? '' : '<p class="m">Notificações pelo computador: desligadas (não achei dados/chaves-avisos.txt).</p>'}
</body></html>`;
}
async function corpoForm(req) {
  let t = ''; for await (const c of req) { t += c; if (t.length > 1e4) break; }
  return Object.fromEntries(new URLSearchParams(t));
}

createServer(async (req, res) => {
  const html = (h, s = 200) => { res.writeHead(s, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(h); };
  const voltar = () => { res.writeHead(303, { Location: '/' }); res.end(); };
  try {
    if (req.method === 'POST' && req.url === '/entrar') {
      const { nome = '', senha = '', acao = 'entrar' } = await corpoForm(req);
      const email = emailDoNome(nome);
      if (!email) return html(pagina('<p class="erro">Escreva o seu nome.</p>'));
      if (senha.length < 6) return html(pagina('<p class="erro">A senha precisa ter pelo menos 6 letras ou números.</p>'));
      if (acao === 'criar') {
        const r = await fetch(`${URL_NUVEM}/auth/v1/signup`, { method: 'POST', headers: { apikey: CHAVE_PUBLICA, 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: senha, data: { name: nome.trim() } }) });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) {
          const m = j.msg || j.error_description || '';
          return html(pagina(`<p class="erro">${/already|exists/i.test(m) ? 'Esse nome já tem conta. Toque em “Entrar”, ou escolha outro nome.' : /weak|password/i.test(m) ? 'Essa senha é fraca demais. Tente outra.' : 'Não deu para criar a conta. Tente de novo.'}</p>`));
        }
        sessao = { nome: nome.trim(), refresh: j.refresh_token, acesso: j.access_token, expira: Date.now() + j.expires_in * 1000 };
        await salvarSessao();
        anotar(`Conta criada: ${sessao.nome}.`);
        return voltar();
      }
      try {
        const j = await auth('password', { email, password: senha });
        sessao = { nome: nome.trim(), refresh: j.refresh_token, acesso: j.access_token, expira: Date.now() + j.expires_in * 1000 };
        await salvarSessao();
        anotar(`Entrou como ${sessao.nome}.`);
        rodada();
        return voltar();
      } catch { return html(pagina('<p class="erro">Nome ou senha não conferem. Use o mesmo nome e senha do app.</p>')); }
    }
    if (req.method === 'POST' && req.url === '/sair') { sessao = null; await writeFile(SESSAO, '{}').catch(() => {}); return voltar(); }
    if (req.method === 'POST' && req.url === '/agora') { rodada(true); return voltar(); }
    if (req.method === 'POST' && req.url === '/testar') {
      if (!sessao) return voltar();
      if (!temPush) return html(pagina('<p class="erro">As notificações deste computador estão desligadas (falta o arquivo de chaves).</p>'));
      const n = (await nuvem('/rest/v1/inscricoes_push?select=id')).length;
      if (!n) return html(pagina('<p class="erro">Nenhum celular com avisos ligados nessa conta. No app, toque em “Ativar avisos”.</p>'));
      await notificar([{ titulo: 'Teste do Radar 🎀', texto: 'Se você está lendo isto, as notificações estão funcionando!' }]);
      return html(pagina(`<p class="ok">Notificação de teste enviada para ${n} ${n === 1 ? 'aparelho' : 'aparelhos'}. Confira o celular.</p>`));
    }
    if (req.url === '/' || req.url.startsWith('/?')) return html(pagina());
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); html(pagina(`<p class="erro">${esc(e.message)}</p>`), 500); }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`Ponte do Radar rodando. Tela: http://localhost:${PORTA}`);
  rodada();
  setInterval(rodada, 5 * 60e3); // a cada 5 min vê se tem loja vencida
  setInterval(olharBuscas, 15e3); // a cada 15 s: pesquisas no app esperando e produtos novos
});
