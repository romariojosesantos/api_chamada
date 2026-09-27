// Erro "esperado" com status HTTP: a mensagem pode ir para o cliente (ver errorHandler em _server.js).
class AppError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

module.exports = AppError;
