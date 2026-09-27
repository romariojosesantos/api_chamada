// Em produção, só estes domínios podem chamar a API. Para mudar sem deploy de
// código, defina ALLOWED_ORIGINS na Vercel (lista separada por vírgula).
const ORIGENS_PADRAO = [
  'https://controle-de-presenca-ten.vercel.app',
  'https://api-chamada.vercel.app',
  'https://atoson.com.br',
  'https://www.atoson.com.br',
];

const origensPermitidas = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',')
      .map((o) => o.trim())
      .filter(Boolean)
  : ORIGENS_PADRAO;

module.exports = {
  origin: process.env.NODE_ENV === 'production' ? origensPermitidas : '*',
  allowedHeaders: [
    'Content-Type',
    'x-institution-id',
    'Authorization',
    'Pragma',
    'Cache-Control',
    'Expires',
  ],
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
};
