# Nexus

Bot de Discord com IA integrada via Groq, suporte a agendamentos e histórico persistente.

## O que faz

- Escuta um canal específico no Discord e responde em linguagem natural.
- Mantém histórico de conversa carregado diretamente do canal — persiste entre reinicializações.
- Entende contexto de replies, incluindo mensagens fora das 50 mais recentes.
- Detecta intenção de agendamento via tool calling e cria cron jobs dinamicamente.
- Agendamentos são salvos em SQLite e recarregados automaticamente ao iniciar.
- Fallback automático entre modelos caso um falhe.
- Prompts do sistema definidos em YAML, compostos por snippets reutilizáveis.

## Requisitos

- Node.js 18+
- Conta e chave da [Groq](https://console.groq.com)
- Token de bot do Discord e ID do canal

## Configuração

Crie um arquivo `.env` na raiz:

```
DISCORD_TOKEN=seu_token_do_discord
GROQ_API_KEY=sua_chave_groq
GROQ_CHANNEL_ID=id_do_canal
```

## Instalação

```bash
npm install
```

## Uso

```bash
npm start
```

Desenvolvimento com auto-reload:

```bash
npm run dev
```

## Estrutura

```
nexus/
├── config/
│   └── prompts/
│       ├── _base.yml              # contexto base (identidade, data atual)
│       ├── nexus.yml              # prompt principal (lista includes)
│       ├── snippets/
│       │   ├── discord_rules.yml      # formato, limite de caracteres
│       │   ├── format_rules.yml       # nunca inventar, admitir incerteza
│       │   └── schedule_awareness.yml # instruções sobre agendamentos
│       └── tools/
│           ├── create_schedule.yml # schema de criação
│           ├── delete_schedule.yml # schema de remoção
│           └── list_schedules.yml  # schema de listagem
├── data/
│   └── nexus.db                   # banco SQLite (criado automaticamente)
├── src/
│   ├── db.js                      # setup e queries do SQLite
│   ├── prompt-builder.js          # loader de YAML com interpolação
│   └── scheduler.js               # gerenciamento de cron jobs
├── index.js
└── .env
```

## Comandos disponíveis no chat

| Comando | Descrição |
|---|---|
| `!clear` | Limpa o histórico de contexto em memória |
| `!agendamentos` | Lista seus agendamentos ativos |
| `!deletar <id>` | Remove o agendamento com o ID informado |

## Agendamentos

O bot detecta automaticamente intenções de agendamento na conversa usando tool calling. Quando identificar uma intenção, exibe um resumo e aguarda confirmação manual via botões antes de salvar. Para reduzir respostas erradas, a intenção de criar/listar/remover é inferida antes do tool calling.

Exemplo:
> "Me lembra de tomar água todo dia às 8h"
> → Bot exibe o agendamento detectado e aguarda confirmação via botões

Agendamentos são salvos em `data/nexus.db` e reativados automaticamente ao reiniciar o bot. Os lembretes são enviados com menção ao usuário no canal configurado.

## Modelos

Definidos em `index.js` no array `MODELS`. A ordem determina a prioridade do fallback:

1. `openai/gpt-oss-120b`
2. `openai/gpt-oss-20b`
3. `llama-3.3-70b-versatile`
4. `llama-3.1-8b-instant`

## Prompts

Os prompts vivem em `config/prompts/`. Cada arquivo YAML pode ter:

- `system` — instruções fixas
- `includes` — lista de snippets reutilizáveis de `config/prompts/snippets/`

O `_base.yml` é incluído automaticamente em todos os prompts e suporta interpolação de variáveis com `{{nome}}`.

## Ferramentas (tools)

Os schemas das tools ficam em `config/prompts/tools/` e são carregados em `index.js`.

## Limitações

- Só responde no canal configurado.
- Histórico em memória é limitado a 50 mensagens — o contexto mais antigo é descartado.
- Sem acesso à internet — admite quando não sabe algo ou a informação pode estar desatualizada.

## Licença

Sem licença definida.
