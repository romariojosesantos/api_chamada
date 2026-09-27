const pool = require('../../db');

// Só ativos: professor desativado (tela "Educadores") continua nas turmas/relatórios
// onde já dava aula, só não entra em seleção nova (autocomplete/filtros).
async function listarNomesAtivos(idInstituicao) {
  const [rows] = await pool.query(`
    SELECT DISTINCT TRIM(nome) AS nome
    FROM professores
    WHERE id_instituicao = ? AND nome IS NOT NULL AND TRIM(nome) != '' AND ativo = 1
    ORDER BY nome ASC
  `, [idInstituicao]);
  return rows.map(r => r.nome).filter(Boolean);
}

module.exports = { listarNomesAtivos };
