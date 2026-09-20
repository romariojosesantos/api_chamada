// Nomes de exibição (label) das áreas de coordenação/turma — os VALORES
// internos (ver AREAS_VALIDAS em backend/areas.js) nunca mudam, só o texto
// mostrado. Editável só pelo master, pela tela "Áreas"; qualquer perfil
// logado pode LER (Turmas, Ponto, Grade por Turma etc. mostram esses nomes
// pra todo mundo). Não é por instituição de propósito — é uma nomenclatura
// única do sistema inteiro (ver pedido que motivou esta rota).
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware, masterMiddleware } = require('./auth');
const { logAuditEvent } = require('./audit');
const { AREAS_VALIDAS } = require('./areas');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Labels padrão — usados pra qualquer área que por algum motivo não tenha
// linha em areas_config ainda (ex.: logo após a migração, antes do seed, ou
// uma área nova adicionada no código no futuro).
const LABELS_PADRAO = {
  educacional: 'Educação por Princípios',
  esportivo: 'Esporte',
  cultural: 'Arte e Cultura',
  tecnologico: 'Educação Profissional',
  capelania: 'Capelania',
};

router.get('/', authMiddleware, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT area, label FROM areas_config');
  const labels = { ...LABELS_PADRAO };
  for (const r of rows) labels[r.area] = r.label;
  res.json(labels);
}));

router.put('/', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const entradas = Object.entries(req.body || {}).filter(([area]) => AREAS_VALIDAS.includes(area));
  if (entradas.length === 0) return res.status(400).json({ error: 'Nenhuma área válida enviada.' });

  for (const [, label] of entradas) {
    const limpo = String(label || '').trim();
    if (!limpo) return res.status(400).json({ error: 'Nenhum nome pode ficar em branco.' });
    if (limpo.length > 50) return res.status(400).json({ error: `"${limpo}" passa de 50 caracteres.` });
  }

  for (const [area, label] of entradas) {
    await pool.query(
      'INSERT INTO areas_config (area, label) VALUES (?, ?) ON DUPLICATE KEY UPDATE label = VALUES(label)',
      [area, String(label).trim()]
    );
  }

  await logAuditEvent(
    'AREAS_LABELS_ATUALIZADOS',
    entradas.map(([area, label]) => `${area}: "${label.trim()}"`).join('; '),
    null
  );

  const [rows] = await pool.query('SELECT area, label FROM areas_config');
  const labels = { ...LABELS_PADRAO };
  for (const r of rows) labels[r.area] = r.label;
  res.json(labels);
}));

module.exports = router;
