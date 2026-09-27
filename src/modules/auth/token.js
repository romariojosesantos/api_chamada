// Token de sessão próprio (não é JWT de biblioteca, mas é parecido):
// base64url(JSON do payload) + "." + HMAC-SHA256 desse base64, com `exp` no payload.
const crypto = require('crypto');

const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // 7 dias

// Sem AUTH_SECRET qualquer um forjaria tokens: em produção o servidor não sobe.
const TOKEN_SECRET = process.env.AUTH_SECRET;
if (!TOKEN_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'AUTH_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor em produção.',
    );
  }
  console.warn(
    '[AVISO] AUTH_SECRET não definido — usando segredo fixo de desenvolvimento. NÃO use isso em produção.',
  );
}
const SEGREDO = TOKEN_SECRET || 'controle-presenca-secret-local';

const assinar = (corpo) => crypto.createHmac('sha256', SEGREDO).update(corpo).digest('base64url');

function signToken(payload) {
  const corpo = Buffer.from(
    JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS }),
  ).toString('base64url');
  return `${corpo}.${assinar(corpo)}`;
}

// Payload do token, ou null se ausente, malformado, adulterado ou expirado.
// A assinatura é comparada em tempo constante.
function verifyToken(token) {
  if (!token || !token.includes('.')) return null;
  const [corpo, assinatura] = token.split('.');
  const recebida = Buffer.from(assinatura);
  const esperada = Buffer.from(assinar(corpo));
  // timingSafeEqual lança erro com tamanhos diferentes: token malformado é só inválido.
  if (recebida.length !== esperada.length || !crypto.timingSafeEqual(recebida, esperada)) {
    return null;
  }
  const payload = JSON.parse(Buffer.from(corpo, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
}

module.exports = { signToken, verifyToken };
