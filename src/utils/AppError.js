// Erro "esperado" com status HTTP: a mensagem vai para o cliente (ver
// src/middlewares/errorHandler.js). `extra` são campos a mais no corpo, ex.: { status: 'pendente' }.
class AppError extends Error {
  constructor(message, status = 400, extra = {}) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

module.exports = AppError;
