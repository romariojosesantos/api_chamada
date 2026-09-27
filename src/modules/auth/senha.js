// Senhas (e códigos de redefinição) guardados como "salt:hash" com scrypt.
const crypto = require('crypto');

function hashPassword(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(senha, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

// Comparação em tempo constante: o tempo de resposta não revela quanto bateu.
function verifyPassword(senha, hashSalvo) {
  if (!hashSalvo || !hashSalvo.includes(':')) return false;
  const [salt, hash] = hashSalvo.split(':');
  const candidato = crypto.scryptSync(senha, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidato, 'hex'));
}

module.exports = { hashPassword, verifyPassword };
