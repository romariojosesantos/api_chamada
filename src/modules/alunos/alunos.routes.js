const express = require('express');
const controller = require('./alunos.controller');
const { validate } = require('../../middlewares/validate');
const { alunoSchema } = require('./alunos.schema');
const { exigirRecurso } = require('../../middlewares/permissao');

const exigir = (acao) => exigirRecurso('/gerenciar-matriculas', acao);

const router = express.Router();

// Rotas literais antes de '/:id', que as engoliria.
router.get('/', controller.listar);
router.get('/telefones', controller.telefones);
router.get('/por-dia', controller.porDia);
router.get('/meritocracia', controller.ranking);
router.post('/upsert-bulk', exigir('criar'), controller.importar);
router.post('/', exigir('criar'), validate(alunoSchema), controller.criar);
router.put('/:id', exigir('editar'), validate(alunoSchema), controller.atualizar);
router.patch('/:id', exigir('editar'), controller.atualizarCampo);
router.delete('/:id', exigir('excluir'), controller.excluir);
router.delete('/:id/permanente', exigir('excluir'), controller.excluirDefinitivamente);
router.get('/excluidos', controller.listarExcluidos);
router.post('/:id/restaurar', exigir('editar'), controller.restaurar);
router.post('/:id/gerar-codigo', exigir('editar'), controller.gerarCodigo);
router.post('/:id/foto', exigir('editar'), controller.enviarFoto);
router.delete('/:id/foto', exigir('editar'), controller.removerFoto);
router.get('/:id', controller.detalhe);
router.get('/:id/niveis', controller.niveis);
router.get('/:id/situacao-anual', controller.situacaoAnual);
router.get('/:id/saude', controller.saude);
router.delete('/:alunoId/saude/:saudeId', exigir('editar'), controller.removerSaude);
router.get('/:id/responsavel', controller.responsavel);
router.put('/:id/responsavel', exigir('editar'), controller.salvarResponsavel);

module.exports = router;
