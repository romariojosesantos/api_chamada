const pool = require('../../db');

// Roda `fn(conexao)` numa transação: commit se der certo, rollback se lançar.
// A conexão sempre volta para o pool (em produção o pool tem só 1 conexão).
async function emTransacao(fn) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const resultado = await fn(connection);
    await connection.commit();
    return resultado;
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

module.exports = { emTransacao };
