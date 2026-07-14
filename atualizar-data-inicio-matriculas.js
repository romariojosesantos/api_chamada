const pool = require('./db');

async function atualizarDataInicioMatriculas() {
  try {
    const [result] = await pool.query(
      `UPDATE matricula SET data_inicio = ?`,
      ['2026-02-01']
    );
    console.log(`Data de início atualizada para 01/02/2026 em ${result.affectedRows} matrículas.`);
  } catch (err) {
    console.error('Erro ao atualizar datas de início:', err);
  } finally {
    await pool.end();
  }
}

atualizarDataInicioMatriculas();
