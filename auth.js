// Autenticação e administração de usuários.
//
// O "token" usado aqui NÃO é um JWT de biblioteca — é um formato caseiro parecido:
// base64url(JSON do payload) + "." + HMAC-SHA256 desse base64, assinado com TOKEN_SECRET.
// verifyToken confere a assinatura (comparação em tempo constante) e a expiração (`exp`
// embutido no próprio payload) antes de confiar no conteúdo.
const express = require('express');
const crypto = require('crypto');
const pool = require('./db');

const router = express.Router();
const TOKEN_SECRET = process.env.AUTH_SECRET;
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7; // sessão válida por 7 dias
const PERFIS = ['master', 'coordenador', 'professor', 'monitor'];

// AUTH_SECRET é o que impede qualquer pessoa de forjar um token válido. Sem essa
// variável configurada, o servidor não deve subir em produção usando um segredo
// padrão previsível.
if (!TOKEN_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('AUTH_SECRET não configurado. Defina essa variável de ambiente antes de iniciar o servidor em produção.');
  }
  console.warn('[AVISO] AUTH_SECRET não definido — usando segredo fixo de desenvolvimento. NÃO use isso em produção.');
}
const EFFECTIVE_SECRET = TOKEN_SECRET || 'controle-presenca-secret-local';

// Helper para envolver rotas assíncronas e capturar erros
const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Hash de senha: scrypt com salt aleatório por usuário, formato armazenado "salt:hash".
const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

// Confere a senha contra o hash salvo. Usa timingSafeEqual para não vazar, pelo
// tempo de resposta, quantos bytes do hash bateram.
const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
};

// Assina um token de sessão para `payload`, embutindo a expiração (`exp`).
const signToken = (payload) => {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
};

// Valida assinatura e expiração de um token. Retorna o payload decodificado, ou
// null se o token for ausente, malformado, adulterado ou expirado.
const verifyToken = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', EFFECTIVE_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
};

// Usuários "master" enxergam todas as instituições (não têm vínculo em usuario_instituicoes).
// Os demais perfis só acessam as instituições explicitamente vinculadas a eles.
const loadUserInstitutions = async (userId, perfil) => {
  if (perfil === 'master') return [];
  const [rows] = await pool.query('SELECT id_instituicao FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  return rows.map(row => row.id_instituicao);
};

// Monta o objeto de sessão do usuário (o que vai dentro do token e é devolvido ao front).
const buildUserSession = async (userRow) => {
  const instituicoes = await loadUserInstitutions(userRow.id, userRow.perfil);
  return {
    id: userRow.id,
    nome: userRow.nome,
    email: userRow.email,
    perfil: userRow.perfil,
    instituicoes
  };
};

// Middleware: exige um Bearer token válido em Authorization e popula req.user.
// Usado tanto nas rotas de /api/auth quanto (via _server.js) em todas as rotas de /api.
const authMiddleware = (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.' });
  }
  req.user = payload;
  next();
};

router.get('/instituicoes', asyncHandler(async (req, res) => {
  const [results] = await pool.query('SELECT id, nome FROM instituicoes ORDER BY nome ASC');
  res.json(results);
}));

// Usado pelo front para saber se ainda não existe nenhum usuário master (fluxo de setup inicial).
router.get('/has-master', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
  res.json({ hasMaster: rows.length > 0 });
}));

// --- Validação de campos de usuário (compartilhada entre register/admin create/admin update) ---
// Retorna uma mensagem de erro (string) se algo for inválido, ou null se estiver tudo certo.
const validarCamposUsuario = ({ nome, email, senha, perfil, exigirSenha = true }) => {
  if (nome.length < 3) return 'Informe um nome com pelo menos 3 caracteres.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return 'Informe um e-mail válido.';
  if (exigirSenha && senha.length < 6) return 'A senha deve ter pelo menos 6 caracteres.';
  if (!PERFIS.includes(perfil)) return 'Perfil inválido.';
  return null;
};

// Autocadastro. Usuários não-master entram com status "pendente" e precisam ser
// aprovados por um master antes de conseguir logar (ver /admin/usuarios/:id/aprovar).
// O primeiro master do sistema é a exceção: já entra "ativo" e logado.
router.post('/register', asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, id_instituicao } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const institutionId = parseInt(id_instituicao);

  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: cleanPassword, perfil: cleanPerfil });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && isNaN(institutionId)) return res.status(400).json({ error: 'Selecione a instituição vinculada ao usuário.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  // Só pode existir um master no sistema — é ele quem aprova todos os outros cadastros.
  if (cleanPerfil === 'master') {
    const [masterCheck] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
    if (masterCheck.length > 0) {
      return res.status(403).json({ error: 'Já existe um usuário master no sistema. Contate o administrador.' });
    }
  }

  const senha_hash = hashPassword(cleanPassword);
  const status = cleanPerfil === 'master' ? 'ativo' : 'pendente';
  const [result] = await pool.query('INSERT INTO usuarios (nome, email, senha_hash, perfil, status) VALUES (?, ?, ?, ?, ?)', [cleanName, cleanEmail, senha_hash, cleanPerfil, status]);
  if (cleanPerfil !== 'master') {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [result.insertId, institutionId]);
  }

  if (status === 'pendente') {
    return res.status(201).json({ message: 'Cadastro realizado. Aguarde aprovação do master para acessar o sistema.' });
  }

  const user = { id: result.insertId, nome: cleanName, email: cleanEmail, perfil: cleanPerfil, instituicoes: cleanPerfil === 'master' ? [] : [institutionId] };
  const token = signToken(user);

  res.status(201).json({ message: 'Usuário registrado com sucesso.', token, user });
}));

router.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const senha = String(req.body.senha || '');

  const [rows] = await pool.query('SELECT id, nome, email, senha_hash, perfil, status FROM usuarios WHERE email = ? LIMIT 1', [email]);
  // Mensagem de erro deliberadamente genérica (não diz se foi o e-mail ou a senha
  // que errou) para não ajudar a enumerar quais e-mails estão cadastrados.
  if (rows.length === 0 || !verifyPassword(senha, rows[0].senha_hash)) {
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  if (rows[0].status === 'pendente') {
    return res.status(403).json({ error: 'Cadastro pendente de aprovação. Aguarde liberação do master.', status: 'pendente' });
  }

  if (rows[0].status !== 'ativo') {
    return res.status(403).json({ error: 'Conta inativa. Entre em contato com o administrador.', status: rows[0].status });
  }

  const user = await buildUserSession(rows[0]);
  const token = signToken(user);

  res.json({ message: 'Login realizado com sucesso.', token, user });
}));

// Usado pelo front para revalidar a sessão ao carregar a página (token salvo no localStorage).
router.get('/me', authMiddleware, asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id, nome, email, perfil, status FROM usuarios WHERE id = ? LIMIT 1', [req.user.id]);
  if (rows.length === 0) return res.status(401).json({ error: 'Usuário não encontrado.' });
  const user = await buildUserSession(rows[0]);
  res.json({ user: { ...user, status: rows[0].status } });
}));

router.post('/change-password', authMiddleware, asyncHandler(async (req, res) => {
  const senhaAtual = String(req.body.senhaAtual || '');
  const novaSenha = String(req.body.novaSenha || '');

  if (novaSenha.length < 6) return res.status(400).json({ error: 'A nova senha deve ter pelo menos 6 caracteres.' });

  const [rows] = await pool.query('SELECT senha_hash FROM usuarios WHERE id = ? AND status = ? LIMIT 1', [req.user.id, 'ativo']);
  if (rows.length === 0 || !verifyPassword(senhaAtual, rows[0].senha_hash)) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }

  await pool.query('UPDATE usuarios SET senha_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashPassword(novaSenha), req.user.id]);
  res.json({ message: 'Senha alterada com sucesso.' });
}));

// Middleware: exige que o usuário autenticado tenha perfil "master".
// Deve vir sempre depois de authMiddleware (depende de req.user já estar populado).
const masterMiddleware = (req, res, next) => {
  if (req.user?.perfil !== 'master') {
    return res.status(403).json({ error: 'Acesso restrito a master.' });
  }
  next();
};

// --- Administração de usuários (todas as rotas abaixo exigem perfil master) ---

router.get('/admin/usuarios', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const [users] = await pool.query('SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE status != ? ORDER BY nome ASC', ['pendente']);
  const result = [];
  for (const user of users) {
    const instituicoes = user.perfil === 'master' ? [] : await loadUserInstitutions(user.id, user.perfil);
    result.push({ ...user, instituicoes });
  }
  res.json(result);
}));

router.get('/admin/usuarios/pendentes', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const [users] = await pool.query('SELECT id, nome, email, perfil, status, created_at FROM usuarios WHERE status = ? ORDER BY created_at ASC', ['pendente']);
  const result = [];
  for (const user of users) {
    const instituicoes = user.perfil === 'master' ? [] : await loadUserInstitutions(user.id, user.perfil);
    result.push({ ...user, instituicoes });
  }
  res.json(result);
}));

router.put('/admin/usuarios/:id/aprovar', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });

  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (rows[0].status !== 'pendente') return res.status(400).json({ error: 'Este usuário não está pendente de aprovação.' });

  await pool.query('UPDATE usuarios SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', ['ativo', userId]);
  res.json({ message: 'Usuário aprovado com sucesso.' });
}));

router.delete('/admin/usuarios/:id/rejeitar', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });

  const [rows] = await pool.query('SELECT status FROM usuarios WHERE id = ? LIMIT 1', [userId]);
  if (rows.length === 0) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (rows[0].status !== 'pendente') return res.status(400).json({ error: 'Este usuário não está pendente de aprovação.' });

  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  await pool.query('DELETE FROM usuarios WHERE id = ?', [userId]);
  res.json({ message: 'Cadastro rejeitado e removido com sucesso.' });
}));

// Criação direta de usuário pelo master (pula o fluxo de aprovação — já entra ativo,
// pois não recebe status 'pendente' aqui).
router.post('/admin/usuarios', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, instituicoes } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const selectedInstitutions = Array.isArray(instituicoes) ? instituicoes.map(Number).filter(Boolean) : [];

  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: cleanPassword, perfil: cleanPerfil });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && selectedInstitutions.length === 0) return res.status(400).json({ error: 'Vincule ao menos uma instituição ao usuário.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const [result] = await pool.query('INSERT INTO usuarios (nome, email, senha_hash, perfil) VALUES (?, ?, ?, ?)', [cleanName, cleanEmail, hashPassword(cleanPassword), cleanPerfil]);
  const userId = result.insertId;

  for (const idInst of selectedInstitutions) {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [userId, idInst]);
  }

  res.status(201).json({ message: 'Usuário criado com sucesso.', id: userId });
}));

router.put('/admin/usuarios/:id', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const { nome, email, perfil, instituicoes, status } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const selectedInstitutions = Array.isArray(instituicoes) ? instituicoes.map(Number).filter(Boolean) : [];
  const cleanStatus = String(status || '').trim().toLowerCase();

  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });
  const erro = validarCamposUsuario({ nome: cleanName, email: cleanEmail, senha: '', perfil: cleanPerfil, exigirSenha: false });
  if (erro) return res.status(400).json({ error: erro });
  if (cleanPerfil !== 'master' && selectedInstitutions.length === 0) return res.status(400).json({ error: 'Vincule ao menos uma instituição ao usuário.' });
  if (cleanStatus && !['ativo', 'inativo', 'pendente'].includes(cleanStatus)) return res.status(400).json({ error: 'Status inválido.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? AND id != ? LIMIT 1', [cleanEmail, userId]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  const updates = [cleanName, cleanEmail, cleanPerfil];
  let statusSql = '';
  if (cleanStatus) {
    updates.push(cleanStatus);
    statusSql = ', status = ?';
  }

  await pool.query(`UPDATE usuarios SET nome = ?, email = ?, perfil = ?${statusSql}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...updates, userId]);
  // Vínculos de instituição são substituídos por completo (apaga tudo e recria) em
  // vez de calcular um diff — mais simples e o volume de linhas por usuário é pequeno.
  await pool.query('DELETE FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  for (const idInst of selectedInstitutions) {
    await pool.query('INSERT IGNORE INTO usuario_instituicoes (id_usuario, id_instituicao) VALUES (?, ?)', [userId, idInst]);
  }

  res.json({ message: 'Usuário atualizado com sucesso.' });
}));

router.put('/admin/usuarios/:id/senha', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const userId = parseInt(req.params.id);
  const novaSenha = String(req.body.senha || '');
  if (isNaN(userId)) return res.status(400).json({ error: 'ID inválido.' });
  if (novaSenha.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  await pool.query('UPDATE usuarios SET senha_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [hashPassword(novaSenha), userId]);
  res.json({ message: 'Senha redefinida com sucesso.' });
}));

module.exports = { router, authMiddleware, masterMiddleware };
