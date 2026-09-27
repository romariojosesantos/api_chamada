// Exige o header x-institution-id e preenche req.id_instituicao, que isola os
// dados de cada instituição. Vem sempre depois de authMiddleware.
//
// O vínculo é conferido no banco a cada requisição (nunca pela lista do token,
// que vale 7 dias): tirar alguém de uma instituição vale na hora.
const { usuarioTemVinculo } = require('../modules/instituicoes/instituicoes.model');

async function tenantMiddleware(req, res, next) {
  const cabecalho = req.headers['x-institution-id'];
  if (!cabecalho) {
    console.warn(`Tentativa de acesso sem header x-institution-id em: ${req.originalUrl}`);
    return res
      .status(401)
      .json({ error: 'Acesso negado. O cabeçalho "x-institution-id" é obrigatório.' });
  }

  const idInstituicao = parseInt(cabecalho);
  if (isNaN(idInstituicao)) {
    return res
      .status(401)
      .json({ error: 'Acesso negado. ID da instituição deve ser um número válido.' });
  }

  if (req.user.perfil !== 'master' && !(await usuarioTemVinculo(req.user.id, idInstituicao))) {
    return res
      .status(403)
      .json({ error: 'Acesso negado. Usuário não vinculado a esta instituição.' });
  }

  req.id_instituicao = idInstituicao;
  next();
}

module.exports = tenantMiddleware;
