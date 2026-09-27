// Schema (Joi) do corpo de criação/edição de aluno — usado com validate()
// de src/middlewares/validate.js.
const Joi = require('joi');

const alunoSchema = Joi.object({
  nome: Joi.string().trim().min(3).required().messages({
    'string.empty': 'O nome do aluno é obrigatório.',
    'string.min': 'O nome deve ter pelo menos 3 caracteres.',
  }),
  data_nascimento: Joi.date().iso().allow(null, ''),
  sexo: Joi.string().max(1).uppercase().allow(null, ''),
  telefone: Joi.string().allow(null, ''),
  turma: Joi.string().allow(null, ''),
  turno: Joi.string().allow(null, ''),
  transporte: Joi.string().allow(null, ''),
  Inf: Joi.string().allow(null, ''),
  status: Joi.string().valid('ativo', 'inativo', 'espera').default('ativo'),
}).unknown(true); // permite campos extras no payload (ex.: acompanhamento/ponto, tratados fora do schema)

module.exports = { alunoSchema };
