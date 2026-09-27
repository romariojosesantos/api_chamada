const pool = require('../../config/database');

async function listarTodas() {
  const [rows] = await pool.query('SELECT id, nome FROM instituicoes ORDER BY nome ASC');
  return rows;
}

async function listarPorIds(ids) {
  if (ids.length === 0) return [];
  const [rows] = await pool.query(
    'SELECT id, nome FROM instituicoes WHERE id IN (?) ORDER BY nome ASC',
    [ids],
  );
  return rows;
}

async function buscarPorId(id) {
  const [rows] = await pool.query('SELECT id, nome FROM instituicoes WHERE id = ?', [id]);
  return rows[0] || null;
}

async function idsVinculadosAoUsuario(idUsuario) {
  const [rows] = await pool.query(
    'SELECT id_instituicao FROM usuario_instituicoes WHERE id_usuario = ?',
    [idUsuario],
  );
  return rows.map((r) => r.id_instituicao);
}

async function usuarioTemVinculo(idUsuario, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT 1 FROM usuario_instituicoes WHERE id_usuario = ? AND id_instituicao = ? LIMIT 1',
    [idUsuario, idInstituicao],
  );
  return rows.length > 0;
}

module.exports = {
  listarTodas,
  listarPorIds,
  buscarPorId,
  idsVinculadosAoUsuario,
  usuarioTemVinculo,
};
