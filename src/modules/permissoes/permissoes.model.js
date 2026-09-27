const pool = require('../../config/database');
const { PERFIS_EDITAVEIS_BASE } = require('../../constants/telas');

// Lista completa de perfis editáveis AGORA (fixos + customizados) — sempre
// consulta o banco na hora (mesmo espírito de exigirRecurso em
// src/middlewares/permissao.js: perfil customizado pode ser criado/apagado a
// qualquer momento, uma lista estática ficaria desatualizada).
// Customizados são POR INSTITUIÇÃO (cada instituição cria os seus, ver
// perfis-customizados.routes.js) — os fixos continuam valendo em qualquer uma.
async function carregarPerfisEditaveis(idInstituicao) {
  const [rows] = await pool.query(
    'SELECT chave FROM perfis_customizados WHERE id_instituicao = ? ORDER BY chave',
    [idInstituicao],
  );
  return [...PERFIS_EDITAVEIS_BASE, ...rows.map((r) => r.chave)];
}

module.exports = { carregarPerfisEditaveis };
