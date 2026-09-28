// Middlewares de autenticação e perfil. Os de perfil vêm sempre depois de
// authMiddleware (dependem de req.user).
const { verifyToken } = require('../modules/auth/token');
const { comUsuario } = require('../utils/contexto-requisicao');

// Exige "Authorization: Bearer <token>" válido e preenche req.user. O resto da
// requisição roda com o usuário no contexto, para o log de auditoria saber quem foi.
function authMiddleware(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  req.user = payload;
  comUsuario(payload, next);
}

function masterMiddleware(req, res, next) {
  if (req.user?.perfil !== 'master') {
    return res.status(403).json({ error: 'Acesso restrito a master.' });
  }
  next();
}

function coordenadorOuMasterMiddleware(req, res, next) {
  if (req.user?.perfil !== 'master' && req.user?.perfil !== 'coordenador') {
    return res.status(403).json({ error: 'Acesso restrito a master ou coordenador.' });
  }
  next();
}

module.exports = { authMiddleware, masterMiddleware, coordenadorOuMasterMiddleware };
