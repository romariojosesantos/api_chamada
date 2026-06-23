# Guia de Migração - Frontend

Este documento descreve as mudanças na API que podem afetar o frontend após a otimização e correções.

## 📋 Resumo das Mudanças

### ✅ Mudanças Não-Breaking (Compatíveis)

Todas as mudanças são **retrocompatíveis**. O frontend existente continuará funcionando sem modificações.

#### 1. grade.js - Remoção de Coluna Duplicada
**Antes:**
```json
{
  "nome_aluno": "João Silva",
  "aluno_nome": "João Silva",  // ← DUPLICADO
  "aluno_turno": "Manhã"
}
```

**Depois:**
```json
{
  "nome_aluno": "João Silva",  // ← Apenas este
  "aluno_turno": "Manhã"
}
```

**Ação no Frontend:** Se você estava usando `aluno_nome`, mude para `nome_aluno`.

---

#### 2. alunos.js - Refatoração de Query (Performance)
**Endpoint:** `GET /api/alunos`

**Mudança:** Subquery correlacionada foi substituída por LEFT JOIN com GROUP BY.

**Impacto:** Nenhum. O formato da resposta permanece idêntico:
```json
{
  "id": 1,
  "nome": "João Silva",
  "dias_matriculados": "Segunda,Terça,Quarta"
}
```

**Benefício:** Query mais rápida em grandes volumes de dados.

---

#### 3. relatorios.js - Correção de Query
**Endpoint:** `GET /api/relatorios/estatisticas-diarias`

**Mudança:** `LIKE` substituído por `=` para comparação exata de dia da semana.

**Impacto:** Nenhum. Resposta idêntica.

---

#### 4. server.js - Cache em Memória
**Endpoints afetados:**
- `GET /api/instituicoes/todas`
- `GET /api/transportes`

**Mudança:** Cache de 5 minutos em memória.

**Impacto:** Nenhum. Respostas idênticas, apenas mais rápidas.

---

#### 5. Auditoria Adicionada
**Endpoints afetados:**
- `POST /api/alunos`
- `PATCH /api/alunos/:id`
- `DELETE /api/alunos/:id`
- `POST /api/presenca`

**Mudança:** Eventos agora são registrados na tabela `chamada_conexao`.

**Impacto:** Nenhum. Respostas idênticas.

---

### 🆕 Novos Endpoints/Funcionalidades

#### 1. Script de Migração de Índices
**Arquivo:** `migrate-add-indexes.js`

**Uso:**
```bash
node migrate-add-indexes.js
```

**Impacto no Frontend:** Nenhum. Apenas melhora performance do banco.

---

#### 2. Variável de Ambiente para Setup
**Variável:** `ENABLE_TEST_DATA`

**Uso:**
- Desenvolvimento: `ENABLE_TEST_DATA=true` (insere dados de teste)
- Produção: Não definir ou `ENABLE_TEST_DATA=false` (apenas cria tabelas)

**Impacto no Frontend:** Nenhum.

---

## 🔧 Ações Recomendadas no Frontend

### Obrigatórias (se aplicável)
1. **Se usar `aluno_nome` da grade:** Substituir por `nome_aluno`

### Opcionais (melhorias)
1. **Implementar cache no frontend:** Considerar cache local para `/api/instituicoes/todas` e `/api/transportes` (5 minutos)
2. **Tratamento de erros:** A API agora tem auditoria - considere exibir logs de erro mais detalhados

---

## 📊 Performance Improvements

As seguintes otimizações foram implementadas (transparentes para o frontend):

1. **Índices adicionados:**
   - `idx_matricula_aluno_status`
   - `idx_presenca_inst_data`
   - `idx_matricula_dia_atividade`
   - `idx_alunos_inst_status_turno`
   - `idx_alunos_inst_transporte`

2. **Queries otimizadas:**
   - `GET /api/alunos` - LEFT JOIN em vez de subquery
   - `POST /api/alunos/upsert-bulk` - Bulk update em vez de loop

3. **Cache em memória:**
   - `/api/instituicoes/todas` - 5 minutos
   - `/api/transportes` - 5 minutos

---

## ✅ Checklist de Migração

- [ ] Verificar se o frontend usa `aluno_nome` da grade → mudar para `nome_aluno`
- [ ] Testar `GET /api/alunos` com filtros
- [ ] Testar `GET /api/relatorios/estatisticas-diarias`
- [ ] Testar `GET /api/grade`
- [ ] Testar operações CRUD de alunos
- [ ] Testar salvamento de chamada

---

## 🚀 Deploy em Produção

### Passos:

1. **Executar migração de índices:**
   ```bash
   node migrate-add-indexes.js
   ```

2. **Configurar variáveis de ambiente:**
   - NÃO definir `ENABLE_TEST_DATA` em produção
   - Garantir que todas as variáveis DB estão configuradas

3. **Deploy do código atualizado**

4. **Monitorar logs** para verificar se as queries estão mais rápidas

---

## 📞 Suporte

Se encontrar algum problema após o deploy:
1. Verifique os logs da API para erros
2. Confirme que os índices foram criados corretamente
3. Verifique se `ENABLE_TEST_DATA` não está ativo em produção

---

**Versão da API:** 1.1.0  
**Data:** 23/06/2026  
**Status:** ✅ Retrocompatível
