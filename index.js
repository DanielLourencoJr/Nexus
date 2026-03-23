import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  MessageFlags,
} from "discord.js";
import Groq from "groq-sdk";
import { fileURLToPath } from "url";
import { buildPrompt, buildTools } from "./src/prompt-builder.js";
import cronstrue from "cronstrue/i18n.js";
import { Schedules } from "./src/db.js";
import { startSchedule, stopSchedule, loadAllSchedules } from "./src/scheduler.js";

const MAX_HISTORY = 50;
const DISCORD_MESSAGE_LIMIT = 2000;
const TARGET_REPLY_LIMIT = 1200;
const CLEAR_COMMAND = "!clear";

const pendingSchedules = new Map();
let TRACE_SEQ = 0;

const MODELS = [
  "openai/gpt-oss-120b",
  "openai/gpt-oss-20b",
  "llama-3.3-70b-versatile",
  "llama-3.1-8b-instant",
];

const SCHEDULE_TOOLS = buildTools(["list_schedules", "create_schedule", "delete_schedule"]);
const ROUTER_TOOLS = buildTools(["route_intent"]);

function getDatePartsInTimeZone(timeZone = "America/Fortaleza") {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const lookup = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
  };
}

function normalizeOneTimeCron(cronExpr) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length === 6) fields.shift(); // drop seconds
  if (fields.length !== 5) return cronExpr;

  let [min, hour, dom, mon, dow] = fields;
  if (dom === "*" && mon === "*") {
    const { day, month } = getDatePartsInTimeZone();
    dom = String(day);
    mon = String(month);
  }
  if (dow !== "*") dow = "*";
  return [min, hour, dom, mon, dow].join(" ");
}

function getSystemPrompt(name) {
  const now = new Date().toLocaleString("pt-BR", { timeZone: "America/Fortaleza" });
  return buildPrompt(name, { now });
}

function humanCron(cronExpr) {
  try {
    return cronstrue.toString(cronExpr, { locale: "pt_BR", use24HourTimeFormat: true });
  } catch {
    return cronExpr;
  }
}

async function sanitizeReply({ groqClient, model, systemPrompt, history, reply }) {
  if (reply.length > TARGET_REPLY_LIMIT) {
    try {
      const response = await groqClient.chat.completions.create({
        model,
        messages: [
          { role: "system", content: systemPrompt },
          ...history,
          { role: "assistant", content: reply },
          { role: "user", content: "Resuma a resposta acima em até 6 linhas e no máximo 1200 caracteres. Escreva em texto corrido, sem tabelas, sem headers, sem listas. Mantenha o essencial e o tom conversacional." },
        ],
      });
      reply = response.choices[0].message.content ?? reply;
    } catch (err) {
      console.warn(`Falha ao encurtar resposta: ${err.message}`);
    }
  }
  if (reply.length > DISCORD_MESSAGE_LIMIT) {
    console.warn(`Truncando resposta de ${reply.length} chars.`);
    reply = reply.slice(0, DISCORD_MESSAGE_LIMIT - 1).trimEnd() + "…";
  }
  return reply;
}

async function resolveContext(message) {
  if (!message.reference) return message.content;
  try {
    const referenced = await message.fetchReference();
    const author = referenced.author.bot ? "Nexus" : referenced.author.username;
    return `[em resposta a ${author}: "${referenced.content}"]\n${message.content}`;
  } catch {
    return message.content;
  }
}

async function sendConfirmationUI(channel, schedules) {
  const summary = schedules.map((s) => {
    const tipo = s.repeat ? "recorrente" : "único";
    const when = s.cron ? humanCron(s.cron) : "";
    const whenPart = when ? ` — ${when}` : "";
    return `**${s.label}** (${tipo})${whenPart} → "${s.message}"`;
  }).join("\n");

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("schedule_confirm").setLabel("Confirmar").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("schedule_cancel").setLabel("Cancelar").setStyle(ButtonStyle.Danger)
  );

  await channel.send({ content: `Entendi o seguinte agendamento:\n${summary}\n\nConfirma?`, components: [row] });
}

async function sendDeleteUI(channel, schedules) {
  if (schedules.length === 0) {
    await channel.send("Você não tem agendamentos para remover.");
    return;
  }
  const options = schedules.map((s) => ({
    label: `#${s.id} — ${humanCron(s.cron)}`,
    description: s.message.slice(0, 100),
    value: String(s.id),
  }));
  const row = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("schedule_delete_select")
      .setPlaceholder("Selecione o agendamento para remover")
      .addOptions(options)
  );
  await channel.send({ content: "Qual agendamento deseja remover?", components: [row] });
}

function formatScheduleList(schedules) {
  return schedules.map((s) => {
    const tipo = s.repeat ? "" : " (único)";
    return `#${s.id} — ${humanCron(s.cron)}${tipo} → "${s.message}"`;
  }).join("\n");
}

function logTrace(traceId, msg) {
  console.log(`[trace:${traceId}] ${msg}`);
}

export const DEFAULT_MAX_HISTORY = MAX_HISTORY;
export const DEFAULT_MODELS = MODELS;
export function createHistory() { return []; }

export function createGroqClient({ apiKey = process.env.GROQ_API_KEY, baseURL = process.env.GROQ_BASE_URL } = {}) {
  return new Groq({ apiKey, baseURL });
}

export function createDiscordClient() {
  return new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
}

function sliceHistory(history, max = 8) {
  if (history.length <= max) return history;
  return history.slice(history.length - max);
}

export async function loadHistory(channel, history, maxHistory = MAX_HISTORY) {
  const fetched = await channel.messages.fetch({ limit: maxHistory });
  const sorted = [...fetched.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
  for (const msg of sorted) {
    if (msg.content === CLEAR_COMMAND) continue;
    if (msg.author.bot) {
      history.push({ role: "assistant", content: msg.content });
    } else {
      history.push({ role: "user", content: `${msg.author.username}: ${msg.content}` });
    }
  }
  console.log(`Histórico carregado: ${history.length} mensagens.`);
}

export async function routeIntent({
  groqClient, history, models = DEFAULT_MODELS, traceId = null,
}) {
  const systemPrompt = getSystemPrompt("router");
  const messages = [{ role: "system", content: systemPrompt }, ...sliceHistory(history, 8)];
  if (traceId) logTrace(traceId, "Router: start");

  for (const model of models) {
    try {
      const response = await groqClient.chat.completions.create({
        model,
        messages,
        tools: ROUTER_TOOLS,
        tool_choice: { type: "function", function: { name: "route_intent" } },
      });
      const choice = response.choices[0];
      if (choice.finish_reason === "tool_calls") {
        const toolCall = (choice.message.tool_calls ?? []).find((c) => c.function?.name === "route_intent");
        if (!toolCall) break;
        const args = JSON.parse(toolCall.function.arguments);
        const intent = args.intent ?? "chat";
        const action = args.action ?? "chat";
        const confidence = Number(args.confidence ?? 0);
        const result = {
          intent,
          action,
          confidence: Number.isFinite(confidence) ? confidence : 0,
          needsClarification: args.needs_clarification === true,
          clarificationQuestion: typeof args.clarification_question === "string" ? args.clarification_question : null,
          model,
        };
        if (traceId) {
          logTrace(traceId, `Router: intent=${result.intent} confidence=${result.confidence.toFixed(2)} needsClarification=${result.needsClarification}`);
        }
        return result;
      }
    } catch (err) {
      console.warn(`Falha no router com ${model}: ${err.message}`);
    }
  }

  return { intent: "chat", confidence: 0, needsClarification: true, clarificationQuestion: null, model: null };
}

export async function askChat({
  groqClient, history, traceId = null,
  models = DEFAULT_MODELS,
}) {
  const systemPrompt = getSystemPrompt("chat");
  if (traceId) logTrace(traceId, "ChatAgent: start");

  for (const model of models) {
    try {
      const messages = [{ role: "system", content: systemPrompt }, ...history];
      const response = await groqClient.chat.completions.create({ model, messages });
      const choice = response.choices[0];
      let reply = choice.message.content ?? "";
      reply = await sanitizeReply({ groqClient, model, systemPrompt, history, reply });
      history.push({ role: "assistant", content: reply });
      console.log(`Respondido (chat) com: ${model}`);
      if (traceId) logTrace(traceId, "ChatAgent: replied");
      return reply;
    } catch (err) {
      console.warn(`Falha no chat com ${model}: ${err.message}`);
    }
  }
  return "Não consegui processar sua mensagem no momento. Tente novamente.";
}

export async function askScraper({
  groqClient, history, traceId = null,
  models = DEFAULT_MODELS,
}) {
  const systemPrompt = getSystemPrompt("scraper");
  if (traceId) logTrace(traceId, "ScraperAgent: start");

  for (const model of models) {
    try {
      const messages = [{ role: "system", content: systemPrompt }, ...history];
      const response = await groqClient.chat.completions.create({ model, messages });
      const choice = response.choices[0];
      let reply = choice.message.content ?? "";
      reply = await sanitizeReply({ groqClient, model, systemPrompt, history, reply });
      history.push({ role: "assistant", content: reply });
      console.log(`Respondido (scraper) com: ${model}`);
      if (traceId) logTrace(traceId, "ScraperAgent: replied");
      return reply;
    } catch (err) {
      console.warn(`Falha no scraper com ${model}: ${err.message}`);
    }
  }
  return "Não consegui processar sua mensagem no momento. Tente novamente.";
}

export async function askSchedule({
  groqClient, history, username, userMessage, traceId = null,
  models = DEFAULT_MODELS, maxHistory = MAX_HISTORY,
  onScheduleDetected, onDeleteDetected, onListDetected,
  toolChoice = "auto",
}) {
  const systemPrompt = getSystemPrompt("schedule");
  if (traceId) logTrace(traceId, "ScheduleAgent: start");

  for (const model of models) {
    try {
      const messages = [{ role: "system", content: systemPrompt }, ...history];
      const response = await groqClient.chat.completions.create({
        model,
        messages,
        tools: SCHEDULE_TOOLS,
        tool_choice: toolChoice,
      });
      const choice = response.choices[0];

      if (choice.finish_reason === "tool_calls") {
        for (const toolCall of choice.message.tool_calls ?? []) {
          const args = JSON.parse(toolCall.function.arguments);

          if (toolCall.function.name === "list_schedules" && onListDetected) {
            if (traceId) logTrace(traceId, "ScheduleAgent: tool=list_schedules");
            await onListDetected();
            return null;
          }

          if (toolCall.function.name === "create_schedule" && onScheduleDetected) {
            if (traceId) logTrace(traceId, "ScheduleAgent: tool=create_schedule");
            const valid = (args.schedules ?? [])
              .filter((s) => typeof s.cron === "string" && typeof s.message === "string" && typeof s.label === "string" && s.cron.trim() !== "" && s.message.trim() !== "")
              .map((s) => {
                const repeat = s.repeat !== false;
                const cron = repeat ? s.cron : normalizeOneTimeCron(s.cron);
                return { ...s, repeat, cron };
              });
            if (valid.length > 0) { await onScheduleDetected(valid); return null; }
          }

          if (toolCall.function.name === "delete_schedule" && onDeleteDetected) {
            if (traceId) logTrace(traceId, "ScheduleAgent: tool=delete_schedule");
            await onDeleteDetected(args.ids ?? []);
            return null;
          }
        }
      }

      let reply = choice.message.content ?? "";
      reply = await sanitizeReply({ groqClient, model, systemPrompt, history, reply });
      history.push({ role: "assistant", content: reply });
      console.log(`Respondido (schedule) com: ${model}`);
      if (traceId) logTrace(traceId, "ScheduleAgent: replied (no tool)");
      return reply;
    } catch (err) {
      console.warn(`Falha no schedule com ${model}: ${err.message}`);
    }
  }
  return "Não consegui processar sua mensagem no momento. Tente novamente.";
}

export async function ask({
  groqClient, history, username, userMessage, traceId = null,
  models = DEFAULT_MODELS, maxHistory = MAX_HISTORY,
  onScheduleDetected, onDeleteDetected, onListDetected,
}) {
  history.push({ role: "user", content: `${username}: ${userMessage}` });
  if (history.length > maxHistory) history.splice(0, history.length - maxHistory);

  const route = await routeIntent({ groqClient, history, models, traceId });
  if (route.needsClarification || (route.intent !== "chat" && route.confidence < 0.55)) {
    if (traceId) logTrace(traceId, "Router: needs clarification -> chat reply");
    return route.clarificationQuestion
      ?? "Você quer conversar normalmente ou lidar com lembretes? Se for lembretes, diga se quer criar, listar ou remover.";
  }

  if (route.intent === "schedule") {
    let scheduleToolChoice = "auto";
    if (route.action === "create") scheduleToolChoice = { type: "function", function: { name: "create_schedule" } };
    if (route.action === "list") scheduleToolChoice = { type: "function", function: { name: "list_schedules" } };
    if (route.action === "delete") scheduleToolChoice = { type: "function", function: { name: "delete_schedule" } };
    if (traceId) logTrace(traceId, "Router: route to ScheduleAgent");
    return askSchedule({
      groqClient,
      history,
      username,
      userMessage,
      models,
      maxHistory,
      onScheduleDetected,
      onDeleteDetected,
      onListDetected,
      toolChoice: scheduleToolChoice,
      traceId,
    });
  }

  if (route.intent === "scraper") {
    if (traceId) logTrace(traceId, "Router: route to ScraperAgent");
    return askScraper({ groqClient, history, models, traceId });
  }

  if (traceId) logTrace(traceId, "Router: route to ChatAgent");
  return askChat({ groqClient, history, models, traceId });
}

export async function handleMessage({ message, channelId, history, groqClient, ask }) {
  if (message.author.bot) return false;
  if (message.channel.id !== channelId) return false;

  const content = message.content.trim();
  const channel = message.channel;
  const traceId = `${Date.now().toString(36)}-${++TRACE_SEQ}`;
  logTrace(traceId, `Message: ${message.author.username} -> "${content}"`);

  if (content === CLEAR_COMMAND) {
    history.splice(0, history.length);
    await channel.send("Contexto limpo.");
    console.log("Histórico resetado via !clear.");
    return true;
  }

  if (content === "!agendamentos") {
    const schedules = Schedules.findByUser(message.author.id);
    if (schedules.length === 0) {
      await channel.send("Você não tem agendamentos.");
    } else {
      await channel.send(`Seus agendamentos:\n${formatScheduleList(schedules)}`);
    }
    return true;
  }

  await channel.sendTyping();
  const typingInterval = setInterval(() => channel.sendTyping(), 8000);

  try {
    const context = await resolveContext(message);
    logTrace(traceId, "Context resolved, invoking router");
    const reply = await ask({
      groqClient,
      history,
      username: message.author.username,
      userMessage: context,
      onListDetected: async () => {
        const schedules = Schedules.findByUser(message.author.id);
        if (schedules.length === 0) {
          await channel.send("Você não tem agendamentos ativos.");
        } else {
          await channel.send(`Seus agendamentos:\n${formatScheduleList(schedules)}`);
        }
      },
      onScheduleDetected: async (schedules) => {
        pendingSchedules.set(message.author.id, schedules);
        await sendConfirmationUI(channel, schedules);
      },
      onDeleteDetected: async (ids) => {
        const userId = message.author.id;
        if (ids.length > 0) {
          const userSchedules = Schedules.findByUser(userId);
          const rows = ids.map((id) => {
            const s = userSchedules.find((s) => s.id === id);
            return s ? `#${s.id} — ${humanCron(s.cron)} → "${s.message}"` : null;
          }).filter(Boolean);

          if (rows.length === 0) { await channel.send("Não encontrei esses agendamentos."); return; }

          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`schedule_delete_confirm:${ids.join(",")}`).setLabel("Remover").setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId("schedule_cancel").setLabel("Cancelar").setStyle(ButtonStyle.Secondary)
          );
          await channel.send({ content: `Remover os seguintes agendamentos?\n${rows.join("\n")}`, components: [row] });
        } else {
          const schedules = Schedules.findByUser(userId);
          await sendDeleteUI(channel, schedules);
        }
      },
      traceId,
    });
    if (reply) await channel.send(reply);
    logTrace(traceId, "Message handling complete");
  } catch (err) {
    console.error(`Erro ao enviar mensagem: ${err.message}`);
    try { await channel.send("Ocorreu um erro ao processar sua mensagem."); } catch { }
  } finally {
    clearInterval(typingInterval);
  }
  return true;
}

export async function handleInteraction({ interaction, channel }) {
  if (!interaction.isButton() && !interaction.isStringSelectMenu()) return;

  const userId = interaction.user.id;
  const username = interaction.user.username;
  const customId = interaction.customId;

  if (customId === "schedule_confirm") {
    const pending = pendingSchedules.get(userId);
    if (!pending) { await interaction.reply({ content: "Nenhum agendamento pendente.", flags: MessageFlags.Ephemeral }); return; }
    pendingSchedules.delete(userId);
    for (const s of pending) {
      const result = Schedules.insert(userId, username, s.cron, s.message, s.repeat);
      startSchedule({ id: result.lastInsertRowid, user_id: userId, cron: s.cron, message: s.message, repeat: s.repeat }, channel);
    }
    await interaction.update({ content: "Agendamento salvo.", components: [] });
    return;
  }

  if (customId === "schedule_cancel") {
    pendingSchedules.delete(userId);
    await interaction.update({ content: "Cancelado.", components: [] });
    return;
  }

  if (customId.startsWith("schedule_delete_confirm:")) {
    const ids = customId.split(":")[1].split(",").map(Number);
    for (const id of ids) {
      const result = Schedules.delete(id, userId);
      if (result.changes > 0) stopSchedule(id);
    }
    await interaction.update({ content: "Agendamento(s) removido(s).", components: [] });
    return;
  }

  if (customId === "schedule_delete_select") {
    const id = Number(interaction.values[0]);
    const result = Schedules.delete(id, userId);
    if (result.changes > 0) {
      stopSchedule(id);
      await interaction.update({ content: `Agendamento #${id} removido.`, components: [] });
    } else {
      await interaction.update({ content: "Agendamento não encontrado.", components: [] });
    }
    return;
  }
}

export async function run() {
  const groq = createGroqClient();
  const client = createDiscordClient();
  const history = createHistory();
  const channelId = process.env.GROQ_CHANNEL_ID;
  let mainChannel = null;

  client.once("clientReady", async () => {
    console.log(`Nexus online como ${client.user.tag}`);
    try {
      mainChannel = await client.channels.fetch(channelId);
      console.log(`Canal encontrado: ${mainChannel.name}`);
      await loadHistory(mainChannel, history);
      loadAllSchedules(mainChannel);
    } catch (err) {
      console.error(`Erro ao carregar histórico: ${err.message}`);
    }
  });

  client.on("messageCreate", async (message) => {
    await handleMessage({
      message, channelId, history, groqClient: groq,
      ask,
    });
  });

  client.on("interactionCreate", async (interaction) => {
    await handleInteraction({ interaction, channel: mainChannel });
  });

  client.on("error", (err) => { console.error(`Erro no client Discord: ${err.message}`); });

  await client.login(process.env.DISCORD_TOKEN);
  return client;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  run();
}
