// Central de notificações: avisos de sistema (escritos manualmente por um
// master, visíveis pra todo mundo ou só pra uma instituição) + eventos
// institucionais automáticos (matrícula nova, mudança de turma, aluno
// marcado como desistente — ver os pontos que chamam criarNotificacao em
// matriculas.js e alunos.js).
//
// Visibilidade segue o mesmo critério de escopo do resto do app: a
// instituição ATUAL (req.id_instituicao, vinda do header x-institution-id),
// não "todas as instituições que o usuário tem acesso" — inclusive pra
// master, que também opera uma instituição por vez em todas as outras telas.
// id_instituicao = NULL na notificação = visível em qualquer instituição.
//
// Leitura é por usuário (tabela notificacoes_lidas), não por instituição —
// cada usuário tem seu próprio estado de "já vi isso".
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { criarNotificacao } = require('./notificacoes-service');
const { logAuditEvent } = require('./audit');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const CLAUSULA_VISIVEIS = '(n.id_instituicao IS NULL OR n.id_instituicao = ?)';

router.get('/', asyncHandler(async (req, res) => {
  const [results] = await pool.query(
    `SELECT n.id, n.tipo, n.titulo, n.mensagem, n.id_instituicao, n.id_aluno, n.created_at,
            (nl.id_usuario IS NOT NULL) AS lida
     FROM notificacoes n
     LEFT JOIN notificacoes_lidas nl ON nl.id_notificacao = n.id AND nl.id_usuario = ?
     WHERE ${CLAUSULA_VISIVEIS}
     ORDER BY n.created_at DESC
     LIMIT 50`,
    [req.user.id, req.id_instituicao]
  );
  res.json(results.map(r => ({ ...r, lida: !!r.lida })));
}));

router.get('/contagem-nao-lidas', asyncHandler(async (req, res) => {
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total
     FROM notificacoes n
     LEFT JOIN notificacoes_lidas nl ON nl.id_notificacao = n.id AND nl.id_usuario = ?
     WHERE ${CLAUSULA_VISIVEIS} AND nl.id_usuario IS NULL`,
    [req.user.id, req.id_instituicao]
  );
  res.json({ total });
}));

router.post('/:id/marcar-lida', asyncHandler(async (req, res) => {
  await pool.query(
    'INSERT IGNORE INTO notificacoes_lidas (id_notificacao, id_usuario) VALUES (?, ?)',
    [req.params.id, req.user.id]
  );
  res.json({ success: true });
}));

router.post('/marcar-todas-lidas', asyncHandler(async (req, res) => {
  await pool.query(
    `INSERT IGNORE INTO notificacoes_lidas (id_notificacao, id_usuario)
     SELECT n.id, ? FROM notificacoes n WHERE ${CLAUSULA_VISIVEIS}`,
    [req.user.id, req.id_instituicao]
  );
  res.json({ success: true });
}));

// Aviso de sistema, escrito manualmente — só master. `id_instituicao` nulo/
// omitido manda pra todo mundo; preenchido, manda só pra uma instituição
// específica (não precisa ser a que o master está com o header setado agora).
router.post('/', asyncHandler(async (req, res) => {
  if (req.user.perfil !== 'master') {
    return res.status(403).json({ error: 'Apenas master pode criar avisos de sistema.' });
  }

  const titulo = String(req.body.titulo || '').trim();
  const mensagem = String(req.body.mensagem || '').trim();
  const idInstituicaoAlvo = req.body.id_instituicao ? Number(req.body.id_instituicao) : null;

  if (titulo.length < 3) return res.status(400).json({ error: 'Informe um título com pelo menos 3 caracteres.' });

  await criarNotificacao({
    tipo: 'sistema',
    titulo,
    mensagem: mensagem || null,
    id_instituicao: idInstituicaoAlvo,
    criado_por: req.user.id
  });

  await logAuditEvent('NOTIFICACAO_SISTEMA_CRIADA', `"${titulo}" (instituição: ${idInstituicaoAlvo || 'todas'})`, req.id_instituicao);

  res.status(201).json({ success: true });
}));

module.exports = router;
