// Guarda o usuário logado durante toda a requisição, para quem está longe do
// `req` (como logAuditEvent, chamado em dezenas de lugares) saber quem fez a
// ação sem precisar receber o usuário por parâmetro em cada chamada.
const { AsyncLocalStorage } = require('async_hooks');

const armazenamento = new AsyncLocalStorage();

// Roda `next` (e tudo que vier depois dele na requisição) com o usuário no contexto.
function comUsuario(usuario, next) {
  armazenamento.run({ idUsuario: usuario?.id ?? null }, next);
}

// Id do usuário da requisição atual, ou null fora de uma requisição logada (crons).
function usuarioAtual() {
  return armazenamento.getStore()?.idUsuario ?? null;
}

module.exports = { comUsuario, usuarioAtual };
