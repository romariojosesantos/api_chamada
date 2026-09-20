// CRUD de permissões por perfil — só master (tela "Permissões"). Decide quais
// telas cada perfil não-master (monitor/professor/coordenador) pode acessar,
// e dentro de cada tela marcada, quais ações (recursos: visualizar/criar/
// editar/excluir/exportar) esse perfil pode fazer; ver carregarTelasPermitidas
// em auth.js pra como as telas chegam no front.
//
// IMPORTANTE: `permissoes_perfil_recurso` guarda o inverso do que a tela mostra —
// cada linha é uma ação BLOQUEADA, não uma ação liberada. Isso é de propósito:
// enquanto ninguém mexe nisso (tabela vazia, como era até essa funcionalidade
// existir), todo perfil continua podendo fazer tudo nas telas que já acessa —
// zero risco de travar o uso normal do sistema no dia em que essa feature foi
// ligada. O master só passa a bloquear uma ação específica quando desmarca ela
// de propósito na tela de Permissões. GET/PUT abaixo fazem essa conversão
// bloqueado<->liberado pra fora (API e front só enxergam "liberado").
//
// Permissões são POR INSTITUIÇÃO (ver migrate-permissoes-por-instituicao.js) —
// esta rota é montada ANTES do middleware global de x-institution-id (ver
// _server.js), então lê o header diretamente em vez de usar req.id_instituicao.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware, masterMiddleware } = require('./auth');
const { logAuditEvent } = require('./audit');
const { TELAS, TELAS_VALIDAS, carregarPerfisEditaveis, RECURSOS, RECURSOS_VALIDOS } = require('./telas');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

router.use(authMiddleware, masterMiddleware);

// Lê e valida o header x-institution-id (mesma obrigatoriedade do middleware
// global que essa rota fica de fora, ver comentário no topo do arquivo).
const obterIdInstituicao = async (req, res) => {
  const idInstituicao = parseInt(req.headers['x-institution-id']);
  if (isNaN(idInstituicao)) {
    res.status(400).json({ error: 'Cabeçalho "x-institution-id" é obrigatório.' });
    return null;
  }
  const [[existe]] = await pool.query('SELECT id FROM instituicoes WHERE id = ?', [idInstituicao]);
  if (!existe) {
    res.status(404).json({ error: 'Instituição não encontrada.' });
    return null;
  }
  return idInstituicao;
};

router.get('/telas', (req, res) => {
  res.json(TELAS);
});

router.get('/recursos', (req, res) => {
  res.json(RECURSOS);
});

router.get('/:perfil', asyncHandler(async (req, res) => {
  const { perfil } = req.params;
  const idInstituicao = await obterIdInstituicao(req, res);
  if (idInstituicao === null) return;
  const perfisEditaveis = await carregarPerfisEditaveis(idInstituicao);
  if (!perfisEditaveis.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido. Use: ' + perfisEditaveis.join(', ') });
  }
  const [telasRows] = await pool.query('SELECT tela FROM permissoes_perfil WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, perfil]);
  const [bloqueiosRows] = await pool.query('SELECT tela, recurso FROM permissoes_perfil_recurso WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, perfil]);

  const bloqueadosPorTela = {};
  for (const b of bloqueiosRows) {
    if (!bloqueadosPorTela[b.tela]) bloqueadosPorTela[b.tela] = [];
    bloqueadosPorTela[b.tela].push(b.recurso);
  }

  // Default = tudo liberado; só tira o que estiver explicitamente bloqueado.
  const recursos = {};
  for (const tela of telasRows.map(r => r.tela)) {
    const bloqueados = bloqueadosPorTela[tela] || [];
    recursos[tela] = RECURSOS_VALIDOS.filter(r => !bloqueados.includes(r));
  }

  res.json({ telas: telasRows.map(r => r.tela), recursos });
}));

router.put('/:perfil', asyncHandler(async (req, res) => {
  const { perfil } = req.params;
  const idInstituicao = await obterIdInstituicao(req, res);
  if (idInstituicao === null) return;
  const perfisEditaveis = await carregarPerfisEditaveis(idInstituicao);
  if (!perfisEditaveis.includes(perfil)) {
    return res.status(400).json({ error: 'Perfil inválido. Use: ' + perfisEditaveis.join(', ') });
  }
  const telas = Array.isArray(req.body.telas) ? req.body.telas : [];
  const telasInvalidas = telas.filter(t => !TELAS_VALIDAS.includes(t));
  if (telasInvalidas.length > 0) {
    return res.status(400).json({ error: 'Tela(s) inválida(s): ' + telasInvalidas.join(', ') });
  }

  // `recursos` que chega do front é a lista de ações LIBERADAS marcadas na tela
  // (default: todas as 5, se o master não mexeu). Guarda-se o inverso — só o
  // que ficou de fora (bloqueado) — pra tela nunca antes tocada continuar 100%
  // liberada (ver comentário no topo do arquivo).
  const recursosPorTela = req.body.recursos && typeof req.body.recursos === 'object' ? req.body.recursos : {};
  const paresBloqueio = [];
  for (const tela of telas) {
    const liberados = Array.isArray(recursosPorTela[tela]) ? recursosPorTela[tela] : RECURSOS_VALIDOS;
    const recursosInvalidos = liberados.filter(r => !RECURSOS_VALIDOS.includes(r));
    if (recursosInvalidos.length > 0) {
      return res.status(400).json({ error: `Recurso(s) inválido(s) em "${tela}": ${recursosInvalidos.join(', ')}` });
    }
    const bloqueados = RECURSOS_VALIDOS.filter(r => !liberados.includes(r));
    for (const recurso of bloqueados) paresBloqueio.push([idInstituicao, perfil, tela, recurso]);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.query('DELETE FROM permissoes_perfil WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, perfil]);
    if (telas.length > 0) {
      await connection.query('INSERT INTO permissoes_perfil (id_instituicao, perfil, tela) VALUES ?', [telas.map(t => [idInstituicao, perfil, t])]);
    }
    await connection.query('DELETE FROM permissoes_perfil_recurso WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, perfil]);
    if (paresBloqueio.length > 0) {
      await connection.query('INSERT INTO permissoes_perfil_recurso (id_instituicao, perfil, tela, recurso) VALUES ?', [paresBloqueio]);
    }
    // Esta rota é montada ANTES do middleware que popula req.id_instituicao
    // (ver _server.js), por isso usa idInstituicao lido diretamente do header
    // (ver obterIdInstituicao acima).
    await logAuditEvent(
      'PERMISSOES_PERFIL_ATUALIZADAS',
      `Perfil "${perfil}": ${telas.length} tela(s) permitida(s): ${telas.join(', ') || '(nenhuma)'}; ${paresBloqueio.length} ação(ões) bloqueada(s)`,
      idInstituicao,
      connection
    );
    await connection.commit();
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }

  res.json({ perfil, telas, recursos: recursosPorTela });
}));

module.exports = router;
