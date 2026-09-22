// Ocorrências de comportamento (negativas) — parte da reforma da Meritocracia
// (ver backend/alunos.js, rota de meritocracia, que soma os
// `percentual_aplicado` pra descontar dos pontos de presença). Efeito
// imediato ao registrar, sem fila de confirmação (diferente do sistema de
// Formação de Caráter, que é só positivo e sempre passa por confirmação) —
// soft-delete permite desfazer um registro errado sem perder o histórico de
// quem fez o quê.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { exigirRecurso } = require('./permissoes-middleware');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const exigir = (recurso) => exigirRecurso('/ocorrencias', recurso);

// Percentual de desconto por gravidade — fixo no código de propósito (não
// editável pelo master): já é capturado em `percentual_aplicado` no momento
// da criação, então mudar este mapa no futuro não altera ocorrências
// antigas, só as novas a partir da mudança.
const PERCENTUAL_POR_GRAVIDADE = { leve: 25, grave: 50, gravissima: 100 };
const GRAVIDADES_VALIDAS = Object.keys(PERCENTUAL_POR_GRAVIDADE);

router.get('/', asyncHandler(async (req, res) => {
  const { aluno_id, inicio, fim } = req.query;
  let sql = `
    SELECT o.id, o.id_aluno, a.nome AS nome_aluno, o.gravidade, o.percentual_aplicado,
           o.descricao, o.data_ocorrencia, o.registrado_por, u.nome AS nome_registrado_por, o.created_at
    FROM aluno_ocorrencias o
    JOIN alunos a ON a.id = o.id_aluno
    LEFT JOIN usuarios u ON u.id = o.registrado_por
    WHERE o.id_instituicao = ? AND o.excluido_em IS NULL
  `;
  const params = [req.id_instituicao];
  if (aluno_id) { sql += ' AND o.id_aluno = ?'; params.push(Number(aluno_id)); }
  if (inicio) { sql += ' AND o.data_ocorrencia >= ?'; params.push(inicio); }
  if (fim) { sql += ' AND o.data_ocorrencia <= ?'; params.push(fim); }
  sql += ' ORDER BY o.data_ocorrencia DESC, o.created_at DESC';

  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

router.post('/', exigir('criar'), asyncHandler(async (req, res) => {
  const alunoId = Number(req.body.id_aluno);
  const gravidade = String(req.body.gravidade || '').trim().toLowerCase();
  const descricao = String(req.body.descricao || '').trim();
  const dataOcorrencia = String(req.body.data_ocorrencia || '').trim();

  if (!alunoId) return res.status(400).json({ error: 'Selecione um inscrito.' });
  if (!GRAVIDADES_VALIDAS.includes(gravidade)) return res.status(400).json({ error: 'Gravidade inválida. Use: ' + GRAVIDADES_VALIDAS.join(', ') });
  if (descricao.length < 10) return res.status(400).json({ error: 'Descreva o que aconteceu (pelo menos 10 caracteres).' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataOcorrencia)) return res.status(400).json({ error: 'Data da ocorrência inválida.' });

  const [[aluno]] = await pool.query(
    'SELECT id, nome FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [alunoId, req.id_instituicao]
  );
  if (!aluno) return res.status(404).json({ error: 'Inscrito não encontrado.' });

  const percentual = PERCENTUAL_POR_GRAVIDADE[gravidade];
  const [result] = await pool.query(
    `INSERT INTO aluno_ocorrencias (id_instituicao, id_aluno, gravidade, percentual_aplicado, descricao, data_ocorrencia, registrado_por)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [req.id_instituicao, alunoId, gravidade, percentual, descricao, dataOcorrencia, req.user.id]
  );

  await logAuditEvent(
    'OCORRENCIA_REGISTRADA',
    `Aluno "${aluno.nome}" — gravidade ${gravidade} (-${percentual}%): ${descricao}`,
    req.id_instituicao
  );

  res.status(201).json({ id: result.insertId, id_aluno: alunoId, nome_aluno: aluno.nome, gravidade, percentual_aplicado: percentual, descricao, data_ocorrencia: dataOcorrencia });
}));

// Apagar (soft-delete) é restrito a coordenador/master mesmo que o master
// tenha liberado o recurso "excluir" pra outro perfil na tela de Permissões —
// ocorrência é um registro sensível, quem registra (educador/monitor) não
// deveria também poder apagar sozinho o que registrou.
router.delete('/:id', exigir('excluir'), asyncHandler(async (req, res) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Só coordenador ou master pode apagar uma ocorrência.' });
  }
  const { id } = req.params;

  const [[ocorrencia]] = await pool.query(
    `SELECT o.id, a.nome AS nome_aluno FROM aluno_ocorrencias o JOIN alunos a ON a.id = o.id_aluno
     WHERE o.id = ? AND o.id_instituicao = ? AND o.excluido_em IS NULL`,
    [id, req.id_instituicao]
  );
  if (!ocorrencia) return res.status(404).json({ error: 'Ocorrência não encontrada.' });

  await pool.query(
    'UPDATE aluno_ocorrencias SET excluido_em = NOW(), excluido_por = ? WHERE id = ?',
    [req.user.id, id]
  );

  await logAuditEvent('OCORRENCIA_APAGADA', `Ocorrência #${id} do aluno "${ocorrencia.nome_aluno}"`, req.id_instituicao);

  res.json({ success: true });
}));

module.exports = router;
