// Tratamento único de erros: toda rota só precisa lançar (ou deixar lançar).
const AppError = require('../utils/AppError');

// Os 4 parâmetros são obrigatórios: é assim que o Express reconhece um handler de erro.
function errorHandler(err, req, res, next) {
  // Erros esperados (404, 409...): a mensagem é para o usuário.
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: err.message, ...err.extra });
  }

  console.error(`[ERRO GLOBAL]: ${err.stack}`);

  if (err.isJoi || err.name === 'ValidationError') {
    return res.status(400).json({
      error: 'Erro de validação nos dados enviados.',
      details: err.details ? err.details.map((i) => i.message) : err.message,
    });
  }

  // Nunca expõe detalhes internos (ex.: mensagens do banco).
  res.status(err.status || 500).json({
    error: 'Ocorreu um erro interno no servidor.',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined,
  });
}

module.exports = errorHandler;
