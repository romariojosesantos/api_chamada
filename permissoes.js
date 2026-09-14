// CRUD de permissões por perfil — só master (tela "Permissões"). Decide quais
// telas cada perfil não-master (monitor/professor/coordenador) pode acessar;
// ver carregarTelasPermitidas em auth.js pra como isso chega no front.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware, masterMiddleware } = require('./auth');
const { logAuditEvent } = require('./audit');
const { TELAS, TELAS_VALIDAS, PERFIS_EDITAVEIS } = require('./telas');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(authMiddleware, masterMiddleware);

router.get('/telas', (req, res) => {
  res.json(TELAS);
});

router.get('/:perfil', asyncHandler(async (req, res) => {
  const { perfil } = req.params;
  if (!PERFIS_EDITAVEIS.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido. Use: ' + PERFIS_EDITAVEIS.join(', ') });
  }
  const [rows] = await pool.query('SELECT tela FROM permissoes_perfil WHERE perfil = ?', [perfil]);
  res.json(rows.map(r => r.tela));
}));

router.put('/:perfil', asyncHandler(async (req, res) => {
  const { perfil } = req.params;
  if (!PERFIS_EDITAVEIS.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido. Use: ' + PERFIS_EDITAVEIS.join(', ') });
  }
  const telas = Array.isArray(req.body.telas) ? req.body.telas : [];
  const telasInvalidas = telas.filter(t => !TELAS_VALIDAS.includes(t));
  if (telasInvalidas.length > 0) {
    return res.status(400).json({ error: 'Tela(s) inválida(s): ' + telasInvalidas.join(', ') });
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM permissoes_perfil WHERE perfil = ?', [perfil]);
    if (telas.length > 0) {
      await connection.query('INSERT INTO permissoes_perfil (perfil, tela) VALUES ?', [telas.map(t => [perfil, t])]);
    }
    // Ação global (não é de uma instituição específica) — esta rota é montada
    // ANTES do middleware que exige x-institution-id (ver _server.js), então
    // req.id_instituicao nunca existe aqui.
    await logAuditEvent('PERMISSOES_PERFIL_ATUALIZADAS', `Perfil "${perfil}": ${telas.length} tela(s) permitida(s): ${telas.join(', ') || '(nenhuma)'}`, null, connection);
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  res.json({ perfil, telas });
}));

module.exports = router;
