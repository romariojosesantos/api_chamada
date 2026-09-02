// Lado da equipe (professor/coordenador/master) do sistema de formação de
// caráter — ver aluno-carater.js pro lado do aluno. Duas peças:
//   - Missões de Caráter: templates de tarefa que master/coordenador cadastram
//     (ex.: "Sirva um colega sem que peçam"), ligadas a um dos 7 princípios.
//   - Fila de confirmação: quando um aluno marca uma missão como feita, escreve
//     no diário de semeadura, ou indica um colega, isso vira um `ato_carater`
//     pendente — só conta de verdade depois que um professor/coordenador/master
//     confirma aqui. "Reconhecer" é o fluxo inverso: a equipe registra um ato
//     já confirmado, sem o aluno precisar iniciar nada.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { logAuditEvent } = require('./audit');
const { PRINCIPIOS_CARATER, PRINCIPIO_IDS } = require('./carater-principios');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Só master/coordenador definem o catálogo de missões (conteúdo curricular);
// professor participa da confirmação/reconhecimento, mas não cria missão.
const gestorMiddleware = (req, res, next) => {
  if (!['master', 'coordenador'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Acesso restrito a master ou coordenador.' });
  }
  next();
};

// Confirmar/reconhecer é aberto aos três perfis que dão aula ou coordenam.
const confirmadorMiddleware = (req, res, next) => {
  if (!['master', 'coordenador', 'professor'].includes(req.user.perfil)) {
    return res.status(403).json({ error: 'Acesso restrito a master, coordenador ou professor.' });
  }
  next();
};

router.get('/principios', (req, res) => res.json(PRINCIPIOS_CARATER));

router.get('/missoes', asyncHandler(async (req, res) => {
  const somenteAtivas = req.query.ativa === '1';
  let sql = 'SELECT id, titulo, descricao, principio, ativa, created_at FROM missoes_carater WHERE id_instituicao = ?';
  const params = [req.id_instituicao];
  if (somenteAtivas) sql += ' AND ativa = 1';
  sql += ' ORDER BY created_at DESC';
  const [rows] = await pool.query(sql, params);
  res.json(rows);
}));

router.post('/missoes', gestorMiddleware, asyncHandler(async (req, res) => {
  const titulo = String(req.body.titulo || '').trim();
  const descricao = String(req.body.descricao || '').trim();
  const principio = parseInt(req.body.principio);

  if (titulo.length < 3) return res.status(400).json({ error: 'Informe um título com pelo menos 3 caracteres.' });
  if (!PRINCIPIO_IDS.includes(principio)) return res.status(400).json({ error: 'Princípio inválido.' });

  const [result] = await pool.query(
    'INSERT INTO missoes_carater (id_instituicao, titulo, descricao, principio, criado_por) VALUES (?, ?, ?, ?, ?)',
    [req.id_instituicao, titulo, descricao || null, principio, req.user.id]
  );
  await logAuditEvent('MISSAO_CARATER_CRIADA', `Missão "${titulo}" criada por usuário #${req.user.id}`, req.id_instituicao);
  res.status(201).json({ id: result.insertId, message: 'Missão criada com sucesso.' });
}));

router.put('/missoes/:id', gestorMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const titulo = String(req.body.titulo || '').trim();
  const descricao = String(req.body.descricao || '').trim();
  const principio = parseInt(req.body.principio);
  const ativa = req.body.ativa ? 1 : 0;

  if (titulo.length < 3) return res.status(400).json({ error: 'Informe um título com pelo menos 3 caracteres.' });
  if (!PRINCIPIO_IDS.includes(principio)) return res.status(400).json({ error: 'Princípio inválido.' });

  const [result] = await pool.query(
    'UPDATE missoes_carater SET titulo = ?, descricao = ?, principio = ?, ativa = ? WHERE id = ? AND id_instituicao = ?',
    [titulo, descricao || null, principio, ativa, id, req.id_instituicao]
  );
  if (result.affectedRows === 0) return res.status(404).json({ error: 'Missão não encontrada.' });
  res.json({ message: 'Missão atualizada com sucesso.' });
}));

// Fila de confirmação — mais antigo primeiro (quem espera há mais tempo é
// atendido primeiro), com o nome do aluno e, dependendo da origem, o título
// da missão ou o nome de quem indicou.
router.get('/pendentes', confirmadorMiddleware, asyncHandler(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT ac.id, ac.principio, ac.origem, ac.texto, ac.created_at,
            a.nome AS aluno_nome,
            m.titulo AS missao_titulo,
            ind.nome AS indicador_nome
     FROM atos_carater ac
     JOIN alunos a ON a.id = ac.id_aluno
     LEFT JOIN missoes_carater m ON m.id = ac.id_missao
     LEFT JOIN alunos ind ON ind.id = ac.id_aluno_indicador
     WHERE ac.id_instituicao = ? AND ac.status = 'pendente'
     ORDER BY ac.created_at ASC`,
    [req.id_instituicao]
  );
  res.json(rows);
}));

router.put('/:id/confirmar', confirmadorMiddleware, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const aprovado = !!req.body.aprovado;
  const comentario = String(req.body.comentario || '').trim();

  const [existentes] = await pool.query(
    "SELECT id FROM atos_carater WHERE id = ? AND id_instituicao = ? AND status = 'pendente'",
    [id, req.id_instituicao]
  );
  if (existentes.length === 0) return res.status(404).json({ error: 'Ato pendente não encontrado.' });

  await pool.query(
    `UPDATE atos_carater
     SET status = ?, id_usuario_confirmou = ?, comentario_professor = ?, confirmado_em = NOW()
     WHERE id = ?`,
    [aprovado ? 'confirmado' : 'rejeitado', req.user.id, comentario || null, id]
  );
  res.json({ message: aprovado ? 'Ato confirmado com sucesso.' : 'Ato rejeitado.' });
}));

// Reconhecimento espontâneo: a equipe registra um ato já confirmado, sem
// depender do aluno ter marcado nada antes.
router.post('/reconhecer', confirmadorMiddleware, asyncHandler(async (req, res) => {
  const idAluno = parseInt(req.body.id_aluno);
  const principio = parseInt(req.body.principio);
  const texto = String(req.body.texto || '').trim();

  if (isNaN(idAluno)) return res.status(400).json({ error: 'Selecione um aluno.' });
  if (!PRINCIPIO_IDS.includes(principio)) return res.status(400).json({ error: 'Princípio inválido.' });

  const [alunos] = await pool.query(
    'SELECT id FROM alunos WHERE id = ? AND id_instituicao = ? AND excluido_em IS NULL',
    [idAluno, req.id_instituicao]
  );
  if (alunos.length === 0) return res.status(404).json({ error: 'Aluno não encontrado.' });

  await pool.query(
    `INSERT INTO atos_carater
       (id_instituicao, id_aluno, principio, origem, texto, status, id_usuario_confirmou, confirmado_em)
     VALUES (?, ?, ?, 'reconhecimento_professor', ?, 'confirmado', ?, NOW())`,
    [req.id_instituicao, idAluno, principio, texto || null, req.user.id]
  );
  res.status(201).json({ message: 'Reconhecimento registrado com sucesso.' });
}));

module.exports = router;
