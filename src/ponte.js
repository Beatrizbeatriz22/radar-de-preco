// Ponte do Radar: roda no seu computador e lê as lojas que bloqueiam a nuvem
// (Amazon, Panvel, Kabum...). Manda os preços para a sua conta na nuvem.
// Tela: http://localhost:3001  (lá você entra uma vez com o mesmo nome e senha do app)
import { createServer } from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import webpush from 'web-push';
import { acharLoja } from './lojas.js';
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

async function notificar(avisos) {
  if (!temPush || !avisos?.length) return;
  const inscricoes = await nuvem('/rest/v1/inscricoes_push?select=id,endpoint,chaves');
  for (const a of avisos) for (const i of inscricoes) {
    try { await webpush.sendNotification({ endpoint: i.endpoint, keys: i.chaves }, JSON.stringify({ titulo: a.titulo, texto: a.texto, produtoId: a.produtoId })); }
    catch (e) { if (e.statusCode === 404 || e.statusCode === 410) await nuvem(`/rest/v1/inscricoes_push?id=eq.${i.id}`, { method: 'DELETE' }).catch(() => {}); }
  }
}

const espera = ms => new Promise(r => setTimeout(r, ms));
let rodando = false, ultimaRodada = null;
// todas = true: lê tudo agora ("Conferir agora"); senão, só o que venceu ou é novo.
async function rodada(todas = false) {
  if (rodando || !sessao) return;
  rodando = true;
  try {
    const ofertas = await nuvem('/rest/v1/ofertas?so_computador=eq.true&select=id,link,loja,ultima_verificacao&order=ultima_verificacao.asc.nullsfirst');
    const limite = Date.now() - intervaloAtual() + 5 * 60e3;
    const pendentes = todas ? ofertas : ofertas.filter(o => !o.ultima_verificacao || new Date(o.ultima_verificacao).getTime() < limite);
    for (const [i, o] of pendentes.entries()) {
      if (i) await espera(5000 + Math.random() * 10000); // calma entre uma leitura e outra
      const loja = acharLoja(o.link);
      try {
        if (!loja) throw new Error('Loja não suportada.');
        const lido = await loja.ler(o.link);
        const r = await funcao('registrarLeituraComputador', { ofertaId: o.id, lido });
        anotar(`${o.loja}: ${lido.preco != null ? `R$ ${lido.preco.toFixed(2).replace('.', ',')}` : 'sem preço / indisponível'} — ${String(lido.titulo || '').slice(0, 60)}`);
        await notificar(r.avisos);
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

// ---- Tela simples (só neste computador) ----
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
function pagina(msg = '') {
  const lista = registro.map(r => `<li><span>${r.quando.toLocaleString('pt-BR')}</span> ${esc(r.txt)}</li>`).join('') || '<li class="m">Nada ainda.</li>';
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Radar · ponte</title>
<meta http-equiv="refresh" content="${sessao ? 30 : 3600}">
<style>body{font-family:system-ui,sans-serif;background:#fff;color:#3A2A33;max-width:560px;margin:32px auto;padding:0 16px}
h1{font-size:22px}.card{border:1px solid #F7E4EC;border-radius:16px;padding:16px;margin:12px 0}
input{display:block;width:100%;box-sizing:border-box;padding:10px;margin:6px 0 12px;border:1px solid #F0CFDD;border-radius:10px;font:inherit}
button{background:#F7A8C8;border:0;border-radius:999px;padding:10px 18px;font:inherit;font-weight:600;cursor:pointer}
ul{padding-left:18px}li{margin:4px 0}li span{color:#8F7683;font-size:12px}.m{color:#8F7683}.erro{color:#b3261e}.ok{color:#1b7a3d}</style></head><body>
<h1>Radar de Preço · computador</h1>
<p class="m">Este programa lê as lojas que não deixam a nuvem ler (Amazon, Panvel, Kabum...) enquanto o computador está ligado, e manda os preços para o seu app.</p>
${msg}
${sessao ? `<div class="card"><b class="ok">Ligado</b> na conta <b>${esc(sessao.nome)}</b>.<br>
<span class="m">Última conferência: ${ultimaRodada ? ultimaRodada.toLocaleString('pt-BR') : 'ainda não'} · confere de ${intervaloAtual() / 36e5} em ${intervaloAtual() / 36e5} h (produtos novos em até 2 min)</span>
<form method="post" action="/agora" style="margin-top:12px;display:inline"><button>Conferir agora</button></form>
<form method="post" action="/sair" style="display:inline;margin-left:8px"><button style="background:#eee">Sair</button></form></div>`
  : `<div class="card"><b>Entre com o mesmo nome e senha do app</b> (só uma vez):
<form method="post" action="/entrar"><input name="nome" placeholder="Seu nome" required autocomplete="username"><input name="senha" type="password" placeholder="Senha" required autocomplete="current-password"><button>Entrar</button></form></div>`}
<div class="card"><b>O que aconteceu</b><ul>${lista}</ul></div>
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
      const { nome = '', senha = '' } = await corpoForm(req);
      const email = emailDoNome(nome);
      if (!email) return html(pagina('<p class="erro">Escreva o seu nome.</p>'));
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
    if (req.url === '/' || req.url.startsWith('/?')) return html(pagina());
    res.writeHead(404); res.end();
  } catch (e) { console.error(e); html(pagina(`<p class="erro">${esc(e.message)}</p>`), 500); }
}).listen(PORTA, '127.0.0.1', () => {
  console.log(`Ponte do Radar rodando. Tela: http://localhost:${PORTA}`);
  rodada();
  setInterval(rodada, 2 * 60e3); // a cada 2 min vê se tem loja vencida ou produto novo
});
