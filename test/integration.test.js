import "dotenv/config";
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { askGroq, createGroqClient, createHistory } from "../index.js";
import { Schedules } from "../src/db.js";

function requireEnv(name) {
  if (!process.env[name]) {
    throw new Error(`Missing required env var: ${name}`);
  }
}

function cleanupUserSchedules(userId) {
  const rows = Schedules.findByUser(userId);
  for (const row of rows) {
    Schedules.delete(row.id, userId);
  }
}

function createHarness() {
  requireEnv("GROQ_API_KEY");
  requireEnv("GROQ_CHANNEL_ID");
  const groqClient = createGroqClient();
  const history = createHistory();
  const username = "IntegrationUser";
  return { groqClient, history, username };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withRetry(fn, { retries = 3, baseDelayMs = 750 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message ?? "");
      const retryable = msg.includes("429") || msg.includes("rate") || msg.includes("timeout") || msg.includes("5");
      if (!retryable || attempt === retries) throw err;
      const delay = baseDelayMs * (attempt + 1);
      await sleep(delay);
    }
  }
  throw lastErr;
}

function withRateLimit(name, fn) {
  return test(name, { timeout: 90000, concurrency: false }, async () => {
    await sleep(600);
    return fn();
  });
}

withRateLimit("conversa normal não deve disparar tools", async () => {
  const { groqClient, history, username } = createHarness();
  const reply = await withRetry(() => askGroq({
    groqClient,
    history,
    username,
    userMessage: "Hoje foi um dia longo. Acho que vou dormir cedo e acordar melhor amanhã.",
    onScheduleDetected: () => { throw new Error("Não deveria criar agendamento"); },
    onDeleteDetected: () => { throw new Error("Não deveria remover agendamento"); },
    onListDetected: () => { throw new Error("Não deveria listar agendamentos"); },
  }));

  assert.ok(reply && typeof reply === "string");
});

withRateLimit("listar lembretes usa tool list_schedules", async () => {
  const { groqClient, history, username } = createHarness();
  const userId = `integration-${randomUUID()}`;
  cleanupUserSchedules(userId);
  Schedules.insert(userId, username, "0 7 * * 1,2,4,5", "Estudar inglês", true);
  Schedules.insert(userId, username, "0 20 * * 2,4", "Estudar Física", true);

  let listed = false;
  const reply = await withRetry(() => askGroq({
    groqClient,
    history,
    username,
    userMessage: "Liste meus lembretes.",
    onListDetected: async () => { listed = true; },
  }));

  assert.equal(reply, null);
  assert.equal(listed, true);
  cleanupUserSchedules(userId);
});

withRateLimit("criar lembrete dispara tool create_schedule", async () => {
  const { groqClient, history, username } = createHarness();
  let captured = null;
  const reply = await withRetry(() => askGroq({
    groqClient,
    history,
    username,
    userMessage: "Me lembre de estudar inglês toda segunda, terça, quinta e sexta às 7:00.",
    onScheduleDetected: async (schedules) => { captured = schedules; },
  }));

  assert.equal(reply, null);
  assert.ok(Array.isArray(captured) && captured.length > 0);
  for (const s of captured) {
    assert.ok(s.cron && s.message && s.label);
  }
});

withRateLimit("remover lembrete dispara tool delete_schedule com id", async () => {
  const { groqClient, history, username } = createHarness();
  const userId = `integration-${randomUUID()}`;
  cleanupUserSchedules(userId);
  const result = Schedules.insert(userId, username, "0 9 * * 1", "Teste remoção", true);
  const id = result.lastInsertRowid;

  let receivedIds = null;
  const reply = await withRetry(() => askGroq({
    groqClient,
    history,
    username,
    userMessage: `Remova o lembrete #${id}.`,
    onDeleteDetected: async (ids) => { receivedIds = ids; },
  }));

  assert.equal(reply, null);
  assert.ok(Array.isArray(receivedIds) && receivedIds.includes(Number(id)));
  cleanupUserSchedules(userId);
});
