const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signToken, verifyToken } = require('./token');
const { hashPassword, verifyPassword } = require('./senha');

test('token assinado é aceito e devolve o payload', () => {
  const payload = verifyToken(signToken({ id: 7, perfil: 'monitor' }));
  assert.equal(payload.id, 7);
  assert.equal(payload.perfil, 'monitor');
  assert.ok(payload.exp > Date.now());
});

test('token adulterado é recusado', () => {
  const [corpo, assinatura] = signToken({ id: 7, perfil: 'monitor' }).split('.');
  const corpoFalso = Buffer.from(
    JSON.stringify({ id: 1, perfil: 'master', exp: Date.now() + 1e6 }),
  ).toString('base64url');
  assert.equal(verifyToken(`${corpoFalso}.${assinatura}`), null);
  assert.equal(verifyToken(`${corpo}.${assinatura.slice(0, -1)}A`), null);
  assert.equal(verifyToken(''), null);
  assert.equal(verifyToken('sem-ponto'), null);
});

test('senha: hash confere só com a senha certa e usa salt diferente a cada vez', () => {
  const hash = hashPassword('segredo123');
  assert.ok(verifyPassword('segredo123', hash));
  assert.ok(!verifyPassword('outra', hash));
  assert.notEqual(hashPassword('segredo123'), hash);
  assert.ok(!verifyPassword('segredo123', null));
  assert.ok(!verifyPassword('segredo123', 'sem-dois-pontos'));
});
