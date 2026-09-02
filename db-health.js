// Saúde do pool de conexões MySQL — só master (é infraestrutura, não dado de
// uma instituição). Fica fora do bloco de x-institution-id em _server.js,
// mesma posição de estatisticas-comparativas.js/permissoes.js.
//
// Existe porque em produção (Vercel) cada invocação serverless abre só 1
// conexão (ver db.js, `connectionLimit: isVercel ? 1 : 20`) — o risco real de
// sobrecarga não é o pool do Node, é o MySQL atingir seu próprio
// `max_connections` quando muitas invocações concorrentes somam mais conexões
// do que o servidor aceita. Esse endpoint deixa checar isso a qualquer hora
// sem precisar abrir o MySQL na mão; ver também cron-saude-banco.js, que roda
// essa mesma checagem automaticamente 1x por dia.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { agoraBrasil } = require('./data-brasil');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

async function medirSaudeBanco() {
  const [[maxConn]] = await pool.query("SHOW VARIABLES LIKE 'max_connections'");
  const [[atual]] = await pool.query("SHOW STATUS LIKE 'Threads_connected'");
  const [[pico]] = await pool.query("SHOW STATUS LIKE 'Max_used_connections'");

  const maxConnections = Number(maxConn.Value);
  const threadsConnected = Number(atual.Value);
  const maxUsedConnections = Number(pico.Value);
  const pctAtual = Math.round((threadsConnected / maxConnections) * 100);

  const status = pctAtual >= 90 ? 'critico' : pctAtual >= 70 ? 'atencao' : 'ok';

  return {
    threads_connected: threadsConnected,
    max_connections: maxConnections,
    max_used_connections: maxUsedConnections,
    pct_atual: pctAtual,
    status,
    // Hora do SERVIDOR (Brasília), não do computador de quem está vendo a
    // tela — mesmo motivo/abordagem de agoraBrasilia() em pontos.js.
    atualizado_em: agoraBrasil()
  };
}

router.get('/', asyncHandler(async (req, res) => {
  if (req.user.perfil !== 'master') {
    return res.status(403).json({ error: 'Rota restrita a master.' });
  }
  res.json(await medirSaudeBanco());
}));

module.exports = { router, medirSaudeBanco };
