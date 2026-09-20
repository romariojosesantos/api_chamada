// CRUD dos perfis "genéricos" que o master cria pela tela de Permissões,
// além dos 4 fixos no código (master/coordenador/professor/monitor) — ver
// comentário em backend/telas.js sobre o que um perfil customizado NÃO herda.
//
// Perfis customizados são POR INSTITUIÇÃO (ver
// migrate-permissoes-por-instituicao.js): cada instituição tem seu próprio
// catálogo, criado e apagado independente das demais. Esta rota é montada
// ANTES do middleware global de x-institution-id (ver _server.js), então lê
// o header diretamente em vez de usar req.id_instituicao.
const express = require('express');
const router = express.Router();
const pool = require('./db');
const { authMiddleware, masterMiddleware } = require('./auth');
const { logAuditEvent } = require('./audit');
const { PERFIS_EDITAVEIS_BASE } = require('./telas');

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Nunca pode colidir com um perfil que já tem significado especial fixo no
// código (master sempre tem acesso total; os 3 da PERFIS_EDITAVEIS_BASE já
// existem; "aluno" é o login do próprio inscrito, outro fluxo de token).
const RESERVADOS = ['master', 'aluno', ...PERFIS_EDITAVEIS_BASE];

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

// "Secretaria Financeira" -> "secretariafinanceira" — só minúsculas e
// números, sem espaço/acento/hífen, pra caber e comparar igual ao resto do
// sistema (tela/recurso usam esse mesmo estilo de chave simples). Cortado em
// 30 (limite de usuarios.perfil).
function gerarChave(nome) {
  return String(nome || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 30);
}

router.use(authMiddleware, masterMiddleware);

router.get('/', asyncHandler(async (req, res) => {
  const idInstituicao = await obterIdInstituicao(req, res);
  if (idInstituicao === null) return;
  const [rows] = await pool.query('SELECT chave, nome, criado_em FROM perfis_customizados WHERE id_instituicao = ? ORDER BY nome ASC', [idInstituicao]);
  res.json(rows);
}));

router.post('/', asyncHandler(async (req, res) => {
  const idInstituicao = await obterIdInstituicao(req, res);
  if (idInstituicao === null) return;
  const nome = String(req.body.nome || '').trim();
  if (!nome) return res.status(400).json({ error: 'Nome do perfil é obrigatório.' });

  const chave = gerarChave(nome);
  if (!chave) return res.status(400).json({ error: 'Esse nome não gera uma chave válida — use ao menos uma letra ou número.' });
  if (RESERVADOS.includes(chave)) return res.status(409).json({ error: `"${nome}" colide com um perfil já existente. Escolha outro nome.` });

  const [[jaExiste]] = await pool.query('SELECT chave FROM perfis_customizados WHERE id_instituicao = ? AND chave = ?', [idInstituicao, chave]);
  if (jaExiste) return res.status(409).json({ error: `Já existe um perfil "${nome}" (ou um nome muito parecido) nesta instituição.` });

  await pool.query(
    'INSERT INTO perfis_customizados (id_instituicao, chave, nome, criado_por) VALUES (?, ?, ?, ?)',
    [idInstituicao, chave, nome, req.user.id]
  );

  await logAuditEvent('PERFIL_CUSTOMIZADO_CRIADO', `Perfil "${nome}" (chave: ${chave})`, idInstituicao);

  res.status(201).json({ chave, nome });
}));

router.delete('/:chave', asyncHandler(async (req, res) => {
  const idInstituicao = await obterIdInstituicao(req, res);
  if (idInstituicao === null) return;
  const { chave } = req.params;

  const [[perfil]] = await pool.query('SELECT chave, nome FROM perfis_customizados WHERE id_instituicao = ? AND chave = ?', [idInstituicao, chave]);
  if (!perfil) return res.status(404).json({ error: 'Perfil não encontrado.' });

  // Só bloqueia se algum usuário com esse perfil estiver vinculado A ESTA
  // instituição — o mesmo nome de perfil pode existir de forma independente
  // em outra instituição, sem relação nenhuma com este.
  const [[{ total }]] = await pool.query(
    `SELECT COUNT(*) AS total FROM usuarios u
     JOIN usuario_instituicoes ui ON ui.id_usuario = u.id
     WHERE u.perfil = ? AND ui.id_instituicao = ?`,
    [chave, idInstituicao]
  );
  if (total > 0) {
    return res.status(409).json({ error: `${total} usuário(s) ainda tem esse perfil nesta instituição. Mude o perfil deles antes (em Admin Usuários) de apagar "${perfil.nome}".` });
  }

  await pool.query('DELETE FROM perfis_customizados WHERE id_instituicao = ? AND chave = ?', [idInstituicao, chave]);
  // Limpa as permissões configuradas pra esse perfil junto — sem isso ficariam
  // linhas "fantasma" (perfil que não existe mais) nas duas tabelas.
  await pool.query('DELETE FROM permissoes_perfil WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, chave]);
  await pool.query('DELETE FROM permissoes_perfil_recurso WHERE id_instituicao = ? AND perfil = ?', [idInstituicao, chave]);

  await logAuditEvent('PERFIL_CUSTOMIZADO_APAGADO', `Perfil "${perfil.nome}" (chave: ${chave})`, idInstituicao);

  res.json({ success: true });
}));

module.exports = router;
