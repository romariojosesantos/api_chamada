const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Carrega o módulo com variáveis de ambiente próprias (a configuração é lida no require).
function carregarStorage(env) {
  const salvo = { ...process.env };
  Object.assign(process.env, env);
  delete require.cache[require.resolve('./storage')];
  const storage = require('./storage');
  process.env = salvo;
  return storage;
}

test('sem FOTOS_* nem R2_*, o armazenamento fica desligado', () => {
  const storage = carregarStorage({ FOTOS_DIR: '', FOTOS_PUBLIC_URL: '', R2_ACCOUNT_ID: '' });
  assert.equal(storage.configurado, false);
});

test('modo disco grava, devolve a URL pública e apaga', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-'));
  const storage = carregarStorage({
    FOTOS_DIR: pasta,
    FOTOS_PUBLIC_URL: 'http://localhost:8080/fotos',
  });
  assert.equal(storage.configurado, true);

  const url = await storage.enviarFoto('alunos/3/10/123.jpg', Buffer.from('foto'), 'image/jpeg');
  assert.equal(url, 'http://localhost:8080/fotos/alunos/3/10/123.jpg');
  const arquivo = path.join(pasta, 'alunos', '3', '10', '123.jpg');
  assert.equal(fs.readFileSync(arquivo, 'utf8'), 'foto');

  await storage.removerFoto(url);
  assert.equal(fs.existsSync(arquivo), false);
  fs.rmSync(pasta, { recursive: true, force: true });
});

test('modo disco recusa caminho que sai da pasta de fotos', async () => {
  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'fotos-'));
  const storage = carregarStorage({ FOTOS_DIR: pasta, FOTOS_PUBLIC_URL: 'http://x/fotos' });
  await assert.rejects(
    storage.enviarFoto('../fora.jpg', Buffer.from('x'), 'image/jpeg'),
    /inválido/,
  );
  await storage.removerFoto('http://x/fotos/../../fora.jpg'); // não lança nem apaga nada fora
  fs.rmSync(pasta, { recursive: true, force: true });
});
