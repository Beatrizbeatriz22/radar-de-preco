// Função da nuvem do Radar (Supabase Edge Function).
// A tela chama esta função para o que precisa ler páginas de lojas:
// adicionar produto, adicionar loja, procurar em outras lojas e atualizar agora.
// Os arquivos em ../_shared são copiados de src/ por scripts/preparar-funcoes.js antes de publicar.
// @ts-nocheck
import { criarBanco, adicionarProduto, adicionarLoja, sugestoes, atualizarProduto, registrarLeituraComputador, erroLeituraComputador } from '../_shared/nuvem.js';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const resposta = (status, dado) => new Response(JSON.stringify(dado), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });

const acoes = { adicionarProduto, adicionarLoja, sugestoes, atualizarProduto, registrarLeituraComputador, erroLeituraComputador };

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  try {
    const url = Deno.env.get('SUPABASE_URL');
    // Quem está pedindo: confere o token do login
    const token = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const u = await fetch(`${url}/auth/v1/user`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY'), Authorization: `Bearer ${token}` } });
    if (!u.ok) return resposta(401, { erro: 'Sua sessão expirou. Entre de novo.' });
    const usuario = (await u.json()).id;

    const { acao, ...dados } = await req.json();
    if (!acoes[acao]) return resposta(400, { erro: 'Ação desconhecida.' });
    const db = criarBanco(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'));
    return resposta(200, await acoes[acao](db, usuario, dados));
  } catch (e) {
    console.error(e);
    return resposta(e.status || 500, { erro: e.status ? e.message : 'Algo deu errado na nuvem. Tente de novo.' });
  }
});
