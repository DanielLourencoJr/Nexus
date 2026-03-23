# AGENT

Guia rápido para trabalhar neste projeto.

## Visão geral
- Bot de Discord em Node.js usando `discord.js` e `groq-sdk`.
- Arquivo principal: `index.js`.
- Configuração por variáveis de ambiente via `.env`.

## Como rodar
```
npm install
node index.js
```

## Variáveis de ambiente
- `DISCORD_TOKEN`: token do bot.
- `GROQ_API_KEY`: chave da Groq.
- `GROQ_CHANNEL_ID`: ID do canal onde o bot responde.

## Fluxo principal
- Ao iniciar, carrega até `MAX_HISTORY` mensagens do canal.
- Cada mensagem entra no histórico como `role: user/assistant`.
- Em cada mensagem nova, tenta responder usando a lista `MODELS`.

## Boas práticas para alterações
- Mantenha respostas curtas (orientado a Discord).
- Preserve o comportamento de fallback por modelos.
- Evite aumentar muito o histórico em memória sem necessidade.
- Se adicionar novos env vars, documente em `README.md`.
