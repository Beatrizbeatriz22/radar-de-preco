// Verificador da nuvem: roda de hora em hora no GitHub Actions.
// Confere as lojas que passaram da hora, grava os preços no Supabase e manda notificação no celular.
// Precisa das variáveis: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAPID_PUBLICA, VAPID_PRIVADA, VAPID_CONTATO
import webpush from 'web-push';
import { criarBanco, verificarOferta } from '../src/nuvem.js';
import { intervaloAtual } from '../public/lib/analise.js';

const env = n => { const v = process.env[n]; if (!v) { console.error(`Falta a variável ${n}.`); process.exit(1); } return v; };
// Chaves coladas à mão podem vir com espaços, quebras de linha ou texto a mais: pega só a chave em si.
const chave = (v, padrao) => (String(v || '').match(padrao) || [String(v || '').replace(/\s+/g, '')])[0];
const chaveBanco = chave(env('SUPABASE_SERVICE_ROLE_KEY'), /sb_secret_[A-Za-z0-9_-]+|eyJ[A-Za-z0-9._-]+/);
if (/[^!-~]/.test(chaveBanco)) { console.error('A chave SUPABASE_SERVICE_ROLE_KEY tem caracteres estranhos (talvez bolinhas •). Cole de novo a chave revelada.'); process.exit(1); }
const db = criarBanco(env('SUPABASE_URL'), chaveBanco);
const vapidPrivada = chave(process.env.VAPID_PRIVADA, /[A-Za-z0-9_-]{40,}/);
const temPush = process.env.VAPID_PUBLICA && vapidPrivada;
if (temPush) webpush.setVapidDetails(process.env.VAPID_CONTATO || 'https://github.com', process.env.VAPID_PUBLICA, vapidPrivada);

const LIMITE_MS = 20 * 60 * 1000; // não passa de 20 min por rodada
const inicio = Date.now();
const espera = ms => new Promise(r => setTimeout(r, ms));

const limite = new Date(Date.now() - intervaloAtual() + 5 * 60 * 1000).toISOString(); // 5 min de folga
const pendentes = await db.ler('ofertas', `so_computador=is.false&or=(ultima_verificacao.is.null,ultima_verificacao.lt.${limite})&order=ultima_verificacao.asc.nullsfirst&limit=300`);
console.log(`${pendentes.length} leituras para fazer (intervalo: ${intervaloAtual() / 36e5} h)`);

let ok = 0, falhas = 0, avisos = [];
for (const o of pendentes) {
  if (Date.now() - inicio > LIMITE_MS) { console.log('Tempo da rodada acabou; o resto fica para a próxima.'); break; }
  try {
    avisos.push(...await verificarOferta(db, o));
    ok++;
    console.log(`✔ ${o.loja}: ${(o.titulo || '').slice(0, 60)}`);
  } catch (e) {
    falhas++;
    console.log(`✘ ${o.loja}: ${e.message}`);
  }
  await espera(3000 + Math.random() * 5000); // calma entre leituras, para não ser bloqueado
}

let enviados = 0;
if (temPush) for (const a of avisos) {
  for (const s of await db.ler('inscricoes_push', `usuario=eq.${a.usuario}`)) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: s.chaves }, JSON.stringify({ titulo: a.titulo, texto: a.texto, produtoId: a.produtoId }));
      enviados++;
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await db.apagar('inscricoes_push', `id=eq.${s.id}`); // aparelho não existe mais
      else console.log('Falha ao notificar:', e.statusCode || e.message);
    }
  }
}
console.log(`Fim: ${ok} lidas, ${falhas} com erro, ${avisos.length} avisos, ${enviados} notificações enviadas.`);
