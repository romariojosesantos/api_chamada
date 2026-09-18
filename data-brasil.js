// Data de "hoje" segundo o FUSO DE BRASÍLIA, nunca o do processo do servidor
// — a Vercel roda a função em UTC, então `new Date().toISOString().split('T')[0]`
// (baseado em UTC) devolve a data de AMANHÃ entre 21h e meia-noite de Brasília,
// já que nesse intervalo UTC já virou o dia seguinte. Usa Intl com timeZone
// fixo em vez de depender do fuso do processo. Extraído aqui porque essa
// mesma expressão já estava copiada em vários arquivos (ver _server.js,
// cron-lembrete-chamada.js, estatisticas-comparativas.js, presenca.js).
function hojeBrasil() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
}

module.exports = { hojeBrasil };
