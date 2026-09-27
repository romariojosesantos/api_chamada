const assert = require('assert');
const { resolveAlunoStatus } = require('./status-sync');

assert.strictEqual(resolveAlunoStatus(true), 'ativo');
assert.strictEqual(resolveAlunoStatus(false), 'inativo');

console.log('status-sync ok');
