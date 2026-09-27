// SQL de usuários, vínculos com instituição e permissões.
const pool = require('../../../db');

// --- Usuário ---

async function buscarPorEmailParaLogin(email) {
  const [rows] = await pool.query(
    'SELECT id, nome, email, senha_hash, perfil, status, id_professor, area_coordenacao FROM usuarios WHERE email = ? LIMIT 1',
    [email],
  );
  return rows[0] || null;
}

async function buscarPorId(id) {
  const [rows] = await pool.query(
    'SELECT id, nome, email, perfil, status, id_professor, area_coordenacao FROM usuarios WHERE id = ? LIMIT 1',
    [id],
  );
  return rows[0] || null;
}

async function buscarPerfil(id) {
  const [rows] = await pool.query('SELECT id, perfil FROM usuarios WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function buscarStatus(id) {
  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [id]);
  return rows[0] || null;
}

async function emailEmUso(email, excetoId = null) {
  const [rows] =
    excetoId === null
      ? await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [email])
      : await pool.query('SELECT id FROM usuarios WHERE email = ? AND id != ? LIMIT 1', [
          email,
          excetoId,
        ]);
  return rows.length > 0;
}

async function existeMaster() {
  const [rows] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
  return rows.length > 0;
}

async function emailsDosMastersAtivos() {
  const [rows] = await pool.query('SELECT email FROM usuarios WHERE perfil = ? AND status = ?', [
    'master',
    'ativo',
  ]);
  return rows.map((m) => m.email);
}

async function inserirCadastro({ nome, email, senhaHash, perfil, status }) {
  const [result] = await pool.query(
    'INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?, ?, ?, ?, ?)',
    [nome, email, senhaHash, perfil, status],
  );
  return result.insertId;
}

async function inserirPeloAdmin({ nome, email, senhaHash, perfil, idProfessor, areaCoordenacao }) {
  const [result] = await pool.query(
    'INSERT INTO usuarios (nome, email, senha_hash, perfil, id_professor, area_coordenacao) VALUES (?, ?, ?, ?, ?, ?)',
    [nome, email, senhaHash, perfil, idProfessor, areaCoordenacao],
  );
  return result.insertId;
}

async function atualizarPeloAdmin(
  id,
  { nome, email, perfil, idProfessor, areaCoordenacao, status },
) {
  const valores = [nome, email, perfil, idProfessor, areaCoordenacao];
  let statusSql = '';
  if (status) {
    valores.push(status);
    statusSql = ', status = ?';
  }
  await pool.query(
    `UPDATE usuarios SET nome = ?, email = ?, perfil = ?, id_professor = ?, area_coordenacao = ?${statusSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [...valores, id],
  );
}

async function ativar(id) {
  await pool.query('UPDATE usuarios SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [
    'ativo',
    id,
  ]);
}

async function excluir(id) {
  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [id]);
  await pool.query('DELETE FROM usuarios WHERE id = ?', [id]);
}

async function vincularProfessor(id, idProfessor) {
  await pool.query(
    'UPDATE usuarios SET id_professor = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [idProfessor, id],
  );
}

// --- Senha e código de redefinição ---

async function senhaHashDoAtivo(id) {
  const [rows] = await pool.query(
    'SELECT senha_hash FROM usuarios WHERE id = ? AND status = ? LIMIT 1',
    [id, 'ativo'],
  );
  return rows[0]?.senha_hash ?? null;
}

async function salvarSenha(id, senhaHash) {
  await pool.query(
    'UPDATE usuarios SET senha_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [senhaHash, id],
  );
}

async function buscarParaRedefinicao(email) {
  const [rows] = await pool.query(
    'SELECT id, nome, status, reset_codigo_expira FROM usuarios WHERE email = ? LIMIT 1',
    [email],
  );
  return rows[0] || null;
}

async function salvarCodigoRedefinicao(id, codigoHash, expira) {
  await pool.query(
    'UPDATE usuarios SET reset_codigo_hash = ?, reset_codigo_expira = ? WHERE id = ?',
    [codigoHash, expira, id],
  );
}

async function codigoRedefinicaoDoAtivo(email) {
  const [rows] = await pool.query(
    'SELECT id, reset_codigo_hash, reset_codigo_expira FROM usuarios WHERE email = ? AND status = ? LIMIT 1',
    [email, 'ativo'],
  );
  return rows[0] || null;
}

// Troca a senha e invalida o código usado.
async function redefinirSenha(id, senhaHash) {
  await pool.query(
    'UPDATE usuarios SET senha_hash = ?, reset_codigo_hash = NULL, reset_codigo_expira = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    [senhaHash, id],
  );
}

// --- Instituições do usuário ---

async function idsDasInstituicoes(idUsuario) {
  const [rows] = await pool.query(
    'SELECT id_instituicao FROM usuario_instituicoes WHERE id_usuario = ?',
    [idUsuario],
  );
  return rows.map((row) => row.id_instituicao);
}

async function vincularInstituicao(idUsuario, idInstituicao) {
  await pool.query(
    'INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)',
    [idUsuario, idInstituicao],
  );
}

// Substitui todos os vínculos (apaga e recria: são poucas linhas por usuário).
async function substituirInstituicoes(idUsuario, idsInstituicoes) {
  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [idUsuario]);
  for (const idInstituicao of idsInstituicoes) await vincularInstituicao(idUsuario, idInstituicao);
}

async function listarInstituicoes() {
  const [rows] = await pool.query('SELECT id, nome FROM instituicoes ORDER BY nome ASC');
  return rows;
}

// --- Permissões ---

async function telasDoPerfil(perfil, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT tela FROM permissoes_perfil WHERE id_instituicao = ? AND perfil = ?',
    [idInstituicao, perfil],
  );
  return rows.map((r) => r.tela);
}

async function recursosBloqueados(perfil, idInstituicao) {
  const [rows] = await pool.query(
    'SELECT tela, recurso FROM permissoes_perfil_recurso WHERE id_instituicao = ? AND perfil = ?',
    [idInstituicao, perfil],
  );
  return rows;
}

// --- Listagens do admin ---

async function listarNaoPendentes() {
  const [rows] = await pool.query(
    `SELECT u.id, u.nome, u.email, u.perfil, u.status, u.created_at, u.id_professor, u.area_coordenacao, p.nome AS nome_professor
     FROM usuarios u
     LEFT JOIN professores p ON p.id = u.id_professor
     WHERE u.status != ? ORDER BY u.nome ASC`,
    ['pendente'],
  );
  return rows;
}

async function listarPendentes() {
  const [rows] = await pool.query(
    'SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE status = ? ORDER BY created_at ASC',
    ['pendente'],
  );
  return rows;
}

async function listarContasDeProfessor() {
  const [rows] = await pool.query(
    `SELECT u.id, u.nome, u.email, u.id_professor, p.nome AS nome_professor
     FROM usuarios u
     LEFT JOIN professores p ON p.id = u.id_professor
     WHERE u.perfil = 'professor' AND u.status != 'pendente'
     ORDER BY u.nome ASC`,
  );
  return rows;
}

// Dados do cadastro para a tela de aprovação por link.
async function resumoDoCadastro(id) {
  const [rows] = await pool.query(
    `SELECT u.nome, u.email, u.perfil, u.status,
            GROUP_CONCAT(i.nome ORDER BY i.nome SEPARATOR ', ') AS instituicoes
     FROM usuarios u
     LEFT JOIN usuario_instituicoes ui ON ui.id_usuario = u.id
     LEFT JOIN instituicoes i ON i.id = ui.id_instituicao
     WHERE u.id = ?
     GROUP BY u.id`,
    [id],
  );
  return rows[0] || null;
}

// --- Professores e alunos ---

async function professoresDaInstituicao(idInstituicao) {
  const [rows] = await pool.query(
    'SELECT id, nome, id_instituicao FROM professores WHERE id_instituicao = ? ORDER BY nome ASC',
    [idInstituicao],
  );
  return rows;
}

async function buscarProfessor(id) {
  const [rows] = await pool.query('SELECT id, id_instituicao FROM professores WHERE id = ?', [id]);
  return rows[0] || null;
}

async function alunoAtivoPorCodigo(codigo) {
  const [rows] = await pool.query(
    "SELECT id, nome, id_instituicao FROM alunos WHERE codigo_acesso = ? AND excluido_em IS NULL AND status = 'ativo'",
    [codigo],
  );
  return rows[0] || null;
}

async function alunoAtivoPorId(id) {
  const [rows] = await pool.query(
    "SELECT id, nome, id_instituicao FROM alunos WHERE id = ? AND excluido_em IS NULL AND status = 'ativo'",
    [id],
  );
  return rows[0] || null;
}

module.exports = {
  buscarPorEmailParaLogin,
  buscarPorId,
  buscarPerfil,
  buscarStatus,
  emailEmUso,
  existeMaster,
  emailsDosMastersAtivos,
  inserirCadastro,
  inserirPeloAdmin,
  atualizarPeloAdmin,
  ativar,
  excluir,
  vincularProfessor,
  senhaHashDoAtivo,
  salvarSenha,
  buscarParaRedefinicao,
  salvarCodigoRedefinicao,
  codigoRedefinicaoDoAtivo,
  redefinirSenha,
  idsDasInstituicoes,
  vincularInstituicao,
  substituirInstituicoes,
  listarInstituicoes,
  telasDoPerfil,
  recursosBloqueados,
  listarNaoPendentes,
  listarPendentes,
  listarContasDeProfessor,
  resumoDoCadastro,
  professoresDaInstituicao,
  buscarProfessor,
  alunoAtivoPorCodigo,
  alunoAtivoPorId,
};
