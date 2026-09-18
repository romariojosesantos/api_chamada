// Checagem diária automática da saúde do pool de conexões MySQL — mesmo
// padrão de cron-lembrete-chamada.js: disparada pelo cron da Vercel (ver
// "crons" em vercel.json), não por usuário logado, por isso fica FORA do
// bloco de authMiddleware/x-institution-id de _server.js. Protegida pelo
// cabeçalho que a própria Vercel envia (`Authorization: Bearer
// $CRON_SECRET`) quando a variável de ambiente CRON_SECRET está configurada.
//
// Só LOGA (console.log/console.warn, capturado no painel de Logs da Vercel)
// — de propósito não usa o sistema de notificações in-app: uma notificação
// com id_instituicao NULL fica visível pra qualquer perfil em qualquer
// instituição (ver notificacoes.js), e essa é uma métrica de infraestrutura
// que não faz sentido pra professor/monitor ver.
//
// Alerta em cima de `threads_connected` (conexões abertas NO MOMENTO da
// checagem), não de `max_used_connections` (pico acumulado desde que o MySQL
// ligou) — esse último só zera com um restart do servidor, então alertar nele
// repetiria o mesmo alerta todo dia pra sempre depois do primeiro pico, mesmo
// que o problema não se repita.
const express = require('express');
const router = express.Router();
const { medirSaudeBanco } = require('./db-health');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CRON_SECRET = process.env.CRON_SECRET;
if (!CRON_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('CRON_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor em produção.');
  }
  console.warn('[AVISO] CRON_SECRET não definido — rota de saúde do banco aberta sem autenticação em desenvolvimento. NÃO faça isso em produção.');
}

const LIMITE_ALERTA_PCT = 70;

router.get('/', asyncHandler(async (req, res) => {
  if (CRON_SECRET) {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${CRON_SECRET}`) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
  }

  const saude = await medirSaudeBanco();
  console.log(`[SAÚDE DB] ${saude.threads_connected}/${saude.max_connections} conexões (${saude.pct_atual}%) — pico histórico: ${saude.max_used_connections}`);

  if (saude.pct_atual >= LIMITE_ALERTA_PCT) {
    console.warn(`[ALERTA SAÚDE DB] Conexões em ${saude.pct_atual}% do limite (${saude.threads_connected}/${saude.max_connections}) — considere revisar o uso do banco.`);
  }

  res.json(saude);
}));

module.exports = router;
