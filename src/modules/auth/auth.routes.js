const express = require('express');
const c = require('./auth.controller');
const { exigirRecurso } = require('../../middlewares/permissao');
const {
  authMiddleware,
  masterMiddleware,
  coordenadorOuMasterMiddleware,
} = require('../../middlewares/auth');

const router = express.Router();
const logado = authMiddleware;
const master = [authMiddleware, masterMiddleware];
const coordenadorOuMaster = [authMiddleware, coordenadorOuMasterMiddleware];

// Públicas
router.get('/instituicoes', c.instituicoes);
router.get('/has-master', c.temMaster);
router.post('/register', c.cadastrar);
router.post('/login', c.login);
router.post('/aluno-login', c.loginAluno);
router.post('/forgot-password', c.esqueciSenha);
router.post('/reset-password', c.redefinirSenha);
router.get('/aprovar-cadastro/:token', c.cadastroParaAprovar);
router.post('/aprovar-cadastro/:token', c.aprovarPeloLink);

// Usuário logado
router.get('/me', logado, c.sessaoAtual);
router.get('/minhas-permissoes', logado, c.permissoes);
router.post('/change-password', logado, c.trocarSenha);

// Administração de usuários
router.get('/admin/professores', master, c.professoresDaInstituicao);
router.get('/admin/usuarios', master, c.listarUsuarios);
router.get('/admin/usuarios/pendentes', master, c.listarPendentes);
router.put('/admin/usuarios/:id/aprovar', master, c.aprovar);
router.delete('/admin/usuarios/:id/rejeitar', master, c.rejeitar);
router.post('/admin/usuarios', master, c.criarUsuario);
router.put('/admin/usuarios/:id', master, c.atualizarUsuario);
router.put('/admin/usuarios/:id/senha', master, c.definirSenha);

// Vínculo conta <-> professor
router.get('/vincular-professor/usuarios', coordenadorOuMaster, c.contasDeProfessor);
router.get('/vincular-professor/professores', coordenadorOuMaster, c.professoresParaVincular);
router.put(
  '/vincular-professor/usuarios/:id',
  coordenadorOuMaster,
  exigirRecurso('/vincular-professor', 'editar'),
  c.vincularProfessor,
);

module.exports = router;
