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

// Data+hora completa em Brasília, "YYYY-MM-DD HH:mm:ss" — mesmo motivo de
// hojeBrasil() acima, mas com hora: telas que mostram "última atualização"
// não podem usar o relógio do computador do usuário (ver pontos.js,
// agoraBrasilia() — mesma abordagem, extraída aqui pra reuso fora de pontos).
function agoraBrasil() {
  const partes = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).formatToParts(new Date());
  const valor = (tipo) => partes.find(p => p.type === tipo).value;
  return `${valor('year')}-${valor('month')}-${valor('day')} ${valor('hour')}:${valor('minute')}:${valor('second')}`;
}

module.exports = { hojeBrasil, agoraBrasil };
