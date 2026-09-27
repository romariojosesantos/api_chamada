// Mede a saúde do pool de conexões MySQL. Usado pela rota GET /db-health
// (db-health.routes.js) e pelo job diário src/jobs/saude-banco.js.
const pool = require('../../config/database');
const { agoraBrasil } = require('../../utils/data-brasil');

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
    atualizado_em: agoraBrasil(),
  };
}

module.exports = { medirSaudeBanco };
