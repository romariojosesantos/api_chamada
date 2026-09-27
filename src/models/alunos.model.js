const pool = require('../../db');

// Transportes únicos da instituição (dropdown de filtros).
async function listarTransportes(idInstituicao) {
  const [rows] = await pool.query(`
    SELECT DISTINCT TRIM(transporte) AS transporte
    FROM alunos
    WHERE id_instituicao = ? AND transporte IS NOT NULL AND TRIM(transporte) != ''
    ORDER BY transporte ASC
  `, [idInstituicao]);
  return rows.map(r => r.transporte).filter(Boolean);
}

module.exports = { listarTransportes };
