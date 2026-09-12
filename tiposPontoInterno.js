// CRUD dos tipos de atividade interna pra bater ponto (Planejamento,
// Reuniões, Monitorias, Ensaios, Outros, ou qualquer nome que um coordenador
// cadastrar) — ver contexto completo em backend/pontos.js. Cada tipo pertence
// a uma área (mesma lista de AREAS_VALIDAS usada por turma) e só existe pra
// UMA instituição: não é uma lista fixa do sistema, cada instituição/área tem
// a sua própria.
//
// Quem cria/edita/apaga um tipo é sempre o coordenador DAQUELA área (ou
// coordenador geral / master, que podem em qualquer área) — mesma regra de
// escopoDeAcesso usada em pontos.js pra editar/apagar um ponto já registrado.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { AREAS_VALIDAS } = require('./areas');
const { escopoDeAcesso } = require('./escopoPonto');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// true se esse usuário pode agir (criar/editar/apagar) num tipo daquela área.
function podeGerenciarArea(escopo, area) {
  if (escopo === null) return false;
  if (escopo === '') return true; // master ou coordenador geral
  return escopo === area;
}

// Lista os tipos da instituição — sem filtro de escopo aqui: qualquer usuário
// autenticado da instituição pode listar (o educador precisa ver as opções
// pra bater ponto). O filtro por "áreas onde esse educador dá aula" é feito
// em GET /api/pontos/turmas, não aqui.
router.get('/', asyncHandler(async (req, res) => {
  const [tipos] = await pool.query(
    'SELECT id, area, nome, ativo FROM tipos_ponto_interno WHERE id_instituicao = ? ORDER BY area ASC, nome ASC',
    [req.id_instituicao]
  );
  res.json(tipos);
}));

router.post('/', asyncHandler(async (req, res) => {
  const escopo = escopoDeAcesso(req);
  if (escopo === null) return res.status(403).json({ error: 'Sem acesso a atividades internas.' });

  const area = req.body.area;
  const nome = String(req.body.nome || '').trim();
  if (!AREAS_VALIDAS.includes(area)) {
    return res.status(400).json({ error: 'Área inválida. Use: ' + AREAS_VALIDAS.join(', ') });
  }
  if (!nome) return res.status(400).json({ error: 'Nome é obrigatório.' });
  if (!podeGerenciarArea(escopo, area)) {
    return res.status(403).json({ error: 'Você só pode criar tipos da sua própria área.' });
  }

  const [duplicado] = await pool.query(
    'SELECT id FROM tipos_ponto_interno WHERE id_instituicao = ? AND area = ? AND nome = ?',
    [req.id_instituicao, area, nome]
  );
  if (duplicado.length > 0) {
    return res.status(409).json({ error: 'Já existe um tipo com esse nome nessa área.' });
  }

  const [result] = await pool.query(
    'INSERT INTO tipos_ponto_interno (id_instituicao, area, nome) VALUES (?, ?, ?)',
    [req.id_instituicao, area, nome]
  );
  res.status(201).json({ id: result.insertId, area, nome, ativo: 1 });
}));

// Edita nome e/ou ativo — a área do tipo nunca muda depois de criado (evita
// um coordenador "roubar" um tipo já existente pra outra área).
router.put('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[tipo]] = await pool.query(
    'SELECT id, area FROM tipos_ponto_interno WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!tipo) return res.status(404).json({ error: 'Tipo não encontrado.' });

  const escopo = escopoDeAcesso(req);
  if (!podeGerenciarArea(escopo, tipo.area)) {
    return res.status(403).json({ error: 'Só o coordenador dessa área (ou geral/master) pode editar esse tipo.' });
  }

  const nome = req.body.nome !== undefined ? String(req.body.nome).trim() : null;
  const ativo = req.body.ativo !== undefined ? (req.body.ativo ? 1 : 0) : null;
  if (nome !== null && !nome) return res.status(400).json({ error: 'Nome não pode ficar vazio.' });

  await pool.query(
    'UPDATE tipos_ponto_interno SET nome = COALESCE(?, nome), ativo = COALESCE(?, ativo) WHERE id = ?',
    [nome, ativo, id]
  );
  res.json({ message: 'Tipo atualizado.' });
}));

// Apaga um tipo — bloqueado se já existir qualquer ponto registrado com ele
// (mesmo padrão de atividades.js bloqueando apagar turma com matrícula):
// nesse caso o histórico ficaria com um tipo "fantasma". Sugere desativar em
// vez de apagar.
router.delete('/:id', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const [[tipo]] = await pool.query(
    'SELECT id, area FROM tipos_ponto_interno WHERE id = ? AND id_instituicao = ?',
    [id, req.id_instituicao]
  );
  if (!tipo) return res.status(404).json({ error: 'Tipo não encontrado.' });

  const escopo = escopoDeAcesso(req);
  if (!podeGerenciarArea(escopo, tipo.area)) {
    return res.status(403).json({ error: 'Só o coordenador dessa área (ou geral/master) pode apagar esse tipo.' });
  }

  const [[{ total }]] = await pool.query('SELECT COUNT(*) AS total FROM pontos WHERE id_tipo_interno = ?', [id]);
  if (total > 0) {
    return res.status(409).json({ error: `Esse tipo já tem ${total} ponto(s) registrado(s). Desative em vez de apagar, pra manter o histórico.` });
  }

  await pool.query('DELETE FROM tipos_ponto_interno WHERE id = ?', [id]);
  res.json({ message: 'Tipo apagado.' });
}));

module.exports = router;
