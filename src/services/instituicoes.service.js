const model = require('../models/instituicoes.model');
const cache = require('../utils/cache');
const AppError = require('../utils/AppError');

// Master vê todas; os demais perfis só as vinculadas. O vínculo é consultado no
// banco NA HORA (nunca req.user.instituicoes, que vem do token de 7 dias), para
// que desvincular um usuário tenha efeito na próxima requisição.
async function listarParaUsuario(usuario) {
  if (usuario.perfil === 'master') {
    const cached = cache.get('instituicoes_todas');
    if (cached) return cached;

    const todas = await model.listarTodas();
    cache.set('instituicoes_todas', todas);
    return todas;
  }

  const ids = await model.idsVinculadosAoUsuario(usuario.id);
  return model.listarPorIds(ids);
}

async function buscarPorId(id) {
  const instituicao = await model.buscarPorId(id);
  if (!instituicao) throw new AppError('Instituição não encontrada.', 404);
  return instituicao;
}

module.exports = { listarParaUsuario, buscarPorId };
