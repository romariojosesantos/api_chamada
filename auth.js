const express = require('express');
const crypto = require('crypto');
const pool = require('./db');

const router = express.Router();
const TOKEN_SECRET = process.env.AUTH_SECRET || 'controle-presenca-secret-local';
const TOKEN_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const PERFIS = ['master', 'coordenador', 'professor', 'monitor'];

const asyncHandler = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const hashPassword = (password) => {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
};

const verifyPassword = (password, storedHash) => {
  if (!storedHash || !storedHash.includes(':')) return false;
  const [salt, hash] = storedHash.split(':');
  const candidate = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(candidate, 'hex'));
};

const signToken = (payload) => {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + TOKEN_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  return `${body}.${signature}`;
};

const verifyToken = (token) => {
  if (!token || !token.includes('.')) return null;
  const [body, signature] = token.split('.');
  const expected = crypto.createHmac('sha256', TOKEN_SECRET).update(body).digest('base64url');
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!payload.exp || payload.exp < Date.now()) return null;
  return payload;
};

const loadUserInstitutions = async (userId, perfil) => {
  if (perfil === 'master') return [];
  const [rows] = await pool.query('SELECT id_instituicao FROM usuario_instituicoes WHERE id_usuario = ?', [userId]);
  return rows.map(row => row.id_instituicao);
};

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

router.get('/has-master', asyncHandler(async (req, res) => {
  const [rows] = await pool.query('SELECT id FROM usuarios WHERE perfil = ? LIMIT 1', ['master']);
  res.json({ hasMaster: rows.length > 0 });
}));

router.post('/register', asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, id_instituicao } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const institutionId = parseInt(id_instituicao);

  if (cleanName.length < 3) return res.status(400).json({ error: 'Informe um nome com pelo menos 3 caracteres.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (cleanPassword.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  if (!PERFIS.includes(cleanPerfil)) return res.status(400).json({ error: 'Perfil inválido.' });
  if (cleanPerfil !== 'master' && isNaN(institutionId)) return res.status(400).json({ error: 'Selecione a instituição vinculada ao usuário.' });

  const [existing] = await pool.query('SELECT id FROM usuarios WHERE email = ? LIMIT 1', [cleanEmail]);
  if (existing.length > 0) return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });

  // Bloquear criação de master se já existir um
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

const masterMiddleware = (req, res, next) => {
  if (req.user?.perfil !== 'master') {
    return res.status(403).json({ error: 'Acesso restrito a master.' });
  }
  next();
};

// Administração de usuários - apenas master
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

router.post('/admin/usuarios', authMiddleware, masterMiddleware, asyncHandler(async (req, res) => {
  const { nome, email, senha, perfil, instituicoes } = req.body;
  const cleanName = String(nome || '').trim();
  const cleanEmail = String(email || '').trim().toLowerCase();
  const cleanPassword = String(senha || '');
  const cleanPerfil = String(perfil || 'monitor').trim().toLowerCase();
  const selectedInstitutions = Array.isArray(instituicoes) ? instituicoes.map(Number).filter(Boolean) : [];

  if (cleanName.length < 3) return res.status(400).json({ error: 'Informe um nome com pelo menos 3 caracteres.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (cleanPassword.length < 6) return res.status(400).json({ error: 'A senha deve ter pelo menos 6 caracteres.' });
  if (!PERFIS.includes(cleanPerfil)) return res.status(400).json({ error: 'Perfil inválido.' });
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
  if (cleanName.length < 3) return res.status(400).json({ error: 'Informe um nome com pelo menos 3 caracteres.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: 'Informe um e-mail válido.' });
  if (!PERFIS.includes(cleanPerfil)) return res.status(400).json({ error: 'Perfil inválido.' });
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

